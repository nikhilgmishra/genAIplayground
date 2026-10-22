/**
 * CallBinding issuance, recovery and verification (WP-11; FO-05-16, FO-10-09, FO-10-46, FO-01-27; ADR-0018 decision
 * 1.4; TB-01 under the reference runtime).
 *
 * Trust model: the media worker is in the untrusted-output group. It may ask for a binding, but every fact the
 * binding states comes from a trusted source, never from the request:
 *   - the carrier interaction from the media plane's own API (CarrierInteractionLookup, `trusted_server_lookup`),
 *     after it confirms that the job was dispatched to and assigned to this worker's agent participant;
 *   - the ONE room of the call: the first touch of a room (a bind or a session-less route) claims it for its call
 *     (room server id -> interaction, carrier interaction and the SIP party whose call id names it; store.ts), and a
 *     carrier interaction is claimed for one room only. The media worker holds the media-plane API secret, so it can
 *     mint a SIP-kind participant with any `sip.callID` or rewrite one: a carrier reference already claimed by another
 *     room is refused (BINDING_ROOM_MISMATCH), a bind whose room name or server id differs from the call's pinned
 *     room is refused, and a re-bind requires the pinned SIP party to be present with the pinned call id
 *     (BINDING_CALLER_GONE ends the call; BINDING_CARRIER_CHANGED revokes it);
 *   - the session generation from the control-plane SessionService (CallSessionPort), whose bearer session
 *     reference never leaves the gateway (stored sealed only);
 *   - the consent the processing directive carries from the session, lowered (never raised) by the caller's
 *     declines on the media path (DATA-03; UNKNOWN is not consent).
 *
 * One owner per call: every binding carries a fencing token; a takeover advances it and the session generation,
 * and the previous owner's claims are refused from then on (BINDING_GENERATION_STALE / BINDING_FENCING_TOKEN_STALE,
 * AUTH-03). A takeover is allowed only after the previous owner is gone (its agent participant has left the room)
 * or its binding expired without a heartbeat; otherwise the second worker is refused (BINDING_OWNER_ACTIVE).
 * Recovery after a worker crash therefore yields a correctly bound session with a new generation, or a refusal that
 * the worker turns into a human route (FO-10-46); the old generation is never resumed.
 *
 * A call is never handed back to the AI once a person was requested for its room (SAFE-02): every bind reads the
 * room's person request (store.ts PersonRequest, written by the session-less human and safety routes BEFORE the
 * handoff is attempted) before it writes and again after (revoking the binding it wrote when one appeared in between),
 * and refuses when one exists. A person still owed is refused BINDING_PERSON_REQUESTED (the runtime asks for the
 * person again, the gateway retries the recorded request), a person already on the call BINDING_WITH_PERSON (the
 * runtime stays silent and suspended). A live binding is held to the same
 * rule: every heartbeat reads the request and is refused the same way, and the lifecycle and processing answers carry
 * it (routeToHuman with the same reason code), so a person requested by anyone reaches the live owner within one
 * heartbeat interval and the owner suspends. A recovery whose effective consent sends the caller to a person (AI
 * processing declined, or recording declined where the tenant's alternative is a person) is refused
 * BINDING_CONSENT_REQUIRES_PERSON before the session generation moves.
 *
 * Evidence (OPS-01): an issuance or recovery whose audit event cannot be written is refused AUDIT_UNAVAILABLE; the
 * record remembers the state of the current binding's event (`issuanceAudit`: PENDING while the issuing request writes
 * it, WRITTEN, MISSING), and the owner's retry writes a missing one before it is answered, with the issue kind the
 * binding was issued with (NEW_CALL or REBOUND_AFTER_OWNER_LOSS); a retry racing the writer is refused retryably.
 */
import { createHash } from "node:crypto";
import {
  CallBinding,
  MediaBindRequest,
  MediaBindingClaim,
  MediaConsentDecisionRequest,
  MediaLifecycleRequest,
  MediaProcessingReportRequest,
  MediaRecorderCheckRequest,
  PROCESSING_DIRECTIVE_SCHEMA_VERSION,
  ProcessingDirective,
  checkBinding,
  unconsentedTaps,
} from "../../protocol/call-binding.js";
import type {
  BindingIssueKind,
  MediaBindResponse,
  MediaConsentDecisionResponse,
  MediaHeartbeatResponse,
  MediaHumanRouteReason,
  MediaLifecycleResponse,
  MediaProcessingReportResponse,
  MediaRecorderCheckResponse,
  MediaSafetyRouteRequest,
  ProcessingConsent,
  ProcessingMismatch,
  RecordingDeclinedRoute,
} from "../../protocol/call-binding.js";
import type { Environment } from "../../protocol/common.js";
import { canonicalJson } from "../../shared/canonical.js";
import type { Clock } from "../../shared/clock.js";
import { addMs, iso } from "../../shared/clock.js";
import { AccessDeniedError, AuditUnavailableError, ConflictError, DependencyError, PlatformError, SessionInvalidError, ValidationError } from "../../shared/errors.js";
import { newId as defaultNewId } from "../../shared/ids.js";
import type { Logger } from "../../observability/ports.js";
import { silentLogger } from "../../observability/logger.js";
import type {
  BindingAuditEvent,
  BindingAuditSink,
  CallSessionPort,
  CallSessionView,
  CarrierInteraction,
  CarrierInteractionLookup,
  MediaRoomFacts,
  PendingActionInvalidator,
  RuntimeIdentity,
  SealedValue,
  SessionRefSealer,
} from "./ports.js";
import { CALL_RECORD_SCHEMA, CallBindingStore, PERSON_REQUEST_SCHEMA, personStateOf } from "./store.js";
import type { BindingHistoryEntry, CallRecordData, PersonAttempt, PersonRequest, PersonState, RoomClaim, StoredCallRecord } from "./store.js";

export interface CallBindingServiceConfig {
  tenantId: string;
  environment: Environment;
  /** Binding lifetime without a heartbeat (seconds, 30..900); never beyond the session's own expiry. */
  bindingTtlSeconds: number;
  /** Heartbeat interval the worker is told to use (seconds); at most a third of the TTL. */
  heartbeatIntervalSeconds: number;
  /** Configured alternative when the caller declines recording (tenant configuration, DATA-03). */
  recordingDeclinedRoute: RecordingDeclinedRoute;
  /**
   * How long one request may hold a call's first-bind lease (seconds, 1..60, default 15): the time it may take to
   * start the call's session and create its first record. A concurrent first bind is refused retryably meanwhile.
   */
  firstBindLeaseSeconds?: number;
}

export interface CallBindingServiceDeps {
  store: CallBindingStore;
  sessions: CallSessionPort;
  lookup: CarrierInteractionLookup;
  sealer: SessionRefSealer;
  actions: PendingActionInvalidator;
  audit: BindingAuditSink;
  clock: Clock;
  logger?: Logger;
  /** Identifier source (tests may pin it); defaults to shared/ids newId. */
  newId?: (prefix: string) => string;
}

/** Refusal of a media-path request because the presented binding is not the current one (409, reason code only). */
export class BindingRefusedError extends ConflictError {}

const CAS_ATTEMPTS = 4;
const RUNTIME_ADAPTERS = new Set(["controlled_cascade_runtime", "native_duplex_runtime"]);

const sealAad = (tenantId: string, interactionId: string): string => `vsp.call-binding.session.v1|${tenantId}|${interactionId}`;
const sha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
const roomDigestOf = (roomName: string): string => sha(`room|${roomName}`);
const b64 = (b: Buffer): string => b.toString("base64");
const unb64 = (s: string): Buffer => Buffer.from(s, "base64");

export interface ResolvedCallBinding {
  binding: CallBinding;
  /** Bearer session reference: in-process only, for the gateway's session resolution (WP-14); never returned to a client. */
  sessionRef: string;
}

export class CallBindingService {
  private readonly logger: Logger;
  private readonly newId: (prefix: string) => string;
  private readonly firstBindLeaseMs: number;

  constructor(
    private readonly config: CallBindingServiceConfig,
    private readonly d: CallBindingServiceDeps,
  ) {
    if (!Number.isInteger(config.bindingTtlSeconds) || config.bindingTtlSeconds < 30 || config.bindingTtlSeconds > 900) throw new ValidationError("BINDING_TTL_INVALID");
    if (!Number.isInteger(config.heartbeatIntervalSeconds) || config.heartbeatIntervalSeconds < 1 || config.heartbeatIntervalSeconds * 3 > config.bindingTtlSeconds) {
      throw new ValidationError("BINDING_HEARTBEAT_INTERVAL_INVALID");
    }
    const lease = config.firstBindLeaseSeconds ?? 15;
    if (!Number.isInteger(lease) || lease < 1 || lease > 60) throw new ValidationError("BINDING_FIRST_BIND_LEASE_INVALID");
    this.firstBindLeaseMs = lease * 1000;
    this.logger = (d.logger ?? silentLogger).child({ component: "calls.binding" });
    this.newId = d.newId ?? defaultNewId;
  }

  /* ------------------------------------------------------------------ issuance and recovery */

  /**
   * Issues the binding for a dispatched room job, or re-issues it with a new session generation and fencing token
   * when the previous owner is gone (recovery). Idempotent for the same worker and job.
   */
  async bind(identity: RuntimeIdentity, raw: MediaBindRequest, correlationId: string): Promise<MediaBindResponse> {
    this.assertIdentity(identity);
    const req = MediaBindRequest.parse(raw);
    if (!identity.adapters.includes(req.adapter)) throw new AccessDeniedError("RUNTIME_ADAPTER_NOT_ALLOWED");
    const refuse = async (reasonCode: string, interactionId: string | null): Promise<never> => {
      await this.auditBestEffort({ action: "call.binding.refused", outcome: "DENIED", interactionId, bindingId: null, sessionBindingRef: null, sessionGeneration: null, reasonCode, correlationId });
      throw new BindingRefusedError(reasonCode);
    };
    let facts: MediaRoomFacts & { presentAgents: readonly string[] };
    let claim: RoomClaim;
    try {
      facts = await this.d.lookup.verify({ tenantId: this.config.tenantId, roomName: req.roomName, jobRef: req.jobRef, agentIdentity: req.agentIdentity });
      claim = await this.claimRoom(facts);
    } catch (err) {
      if (err instanceof AccessDeniedError) {
        await this.auditBestEffort({ action: "call.binding.refused", outcome: "DENIED", interactionId: null, bindingId: null, sessionBindingRef: null, sessionGeneration: null, reasonCode: err.reasonCode, correlationId });
        if (err.reasonCode === "BINDING_ROOM_MISMATCH") throw new BindingRefusedError(err.reasonCode);
      }
      throw err;
    }
    // The pinned carrier party must still be the room's, with the pinned call id (a re-bind after the caller left
    // would otherwise name a transfer leg; a rewritten call id is a holder of the media-plane secret at work).
    if (claim.carrierParty !== null) {
      const party = facts.sipParties.find((p) => p.partyDigest === claim.carrierParty);
      if (!party) {
        await this.endIfOpen(claim.interactionId, "CALLER_LEFT_ROOM", correlationId);
        return refuse("BINDING_CALLER_GONE", claim.interactionId);
      }
      if (party.interactionRef !== claim.carrier.interactionRef) {
        await this.revokeIfOpen(claim.interactionId, "BINDING_CARRIER_CHANGED", correlationId);
        return refuse("BINDING_CARRIER_CHANGED", claim.interactionId);
      }
    }
    // A room whose caller was sent to (or is owed) a person never goes back to the AI (SAFE-02, FO-10-46).
    const person = personStateOf(await this.d.store.personRequest(this.config.tenantId, facts.roomSid));
    if (person !== "NONE") return refuse(personRefusalCode(person), claim.interactionId);
    const room = { sid: facts.roomSid, nameDigest: roomDigestOf(req.roomName) };
    const issued = await this.issue(req, claim, room, facts.presentAgents, correlationId);
    // A person requested for the room while this bind was between its read above and its write (the supervisor's
    // deadline route, another runtime's route) wins: the binding just written is revoked and never answered to the AI.
    // A request recorded after this second read reaches the owner on its next heartbeat (refused) or report (flagged).
    const after = personStateOf(await this.d.store.personRequest(this.config.tenantId, facts.roomSid));
    if (after !== "NONE") {
      this.logger.warn("calls.binding.person_requested_during_bind", { reasonCode: personRefusalCode(after), bindingId: issued.binding.bindingId });
      await this.revokeIssued(claim.interactionId, issued.binding.bindingId, personRefusalCode(after), correlationId);
      return refuse(personRefusalCode(after), claim.interactionId);
    }
    return issued;
  }

  /**
   * Revokes binding `bindingId` while it is still the call's live binding (a bind that lost the race to a person
   * route): the record then names no live AI owner, and the claim, never answered, can never be renewed or resolved.
   * A binding that moved on (another owner, ended) is left as it is.
   */
  private async revokeIssued(interactionId: string, bindingId: string, reasonCode: string, correlationId: string): Promise<void> {
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
      const record = await this.d.store.load(this.config.tenantId, interactionId);
      if (!record || record.data.binding.bindingId !== bindingId || record.data.binding.state !== "ACTIVE") return;
      const binding = CallBinding.parse({ ...record.data.binding, state: "REVOKED" });
      const next: CallRecordData = { ...record.data, binding, history: record.data.history.map((h) => (h.bindingId === bindingId ? { ...h, state: "REVOKED" as const } : h)) };
      if (!(await this.d.store.replace(record.version, next))) continue;
      await this.auditBestEffort({ action: "call.binding.revoked", outcome: "DENIED", interactionId, bindingId, sessionBindingRef: binding.sessionBindingRef, sessionGeneration: binding.sessionGeneration, reasonCode, correlationId });
      return;
    }
    // Still refused: the claim was never answered and every renewal reads the person request (heartbeat refusal).
    this.logger.warn("calls.binding.revoke_after_person_failed", { reasonCode, bindingId });
  }

  private async issue(req: MediaBindRequest, claim: RoomClaim, room: CallRecordData["room"], presentAgents: readonly string[], correlationId: string): Promise<MediaBindResponse> {
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
      const existing = await this.d.store.load(this.config.tenantId, claim.interactionId);
      if (!existing) {
        const created = await this.createFirst(req, claim, room, correlationId);
        if (created) return created;
        continue;
      }
      const outcome = await this.rebind(existing, req, room, presentAgents, correlationId);
      if (outcome) return outcome;
    }
    throw new BindingRefusedError("BINDING_CONCURRENT_UPDATE", "BINDING_CONCURRENT_UPDATE", true);
  }

  /** The room's claim (first touch claims it from the room facts); a carrier already claimed by another room is refused. */
  private async claimRoom(facts: MediaRoomFacts): Promise<RoomClaim> {
    const held = await this.d.store.roomClaim(this.config.tenantId, facts.roomSid);
    if (held) return held;
    const { carrier, carrierParty } = carrierOfRoom(facts);
    const ttl = Math.floor(this.d.clock.now().getTime() / 1000) + 2 * 86_400;
    return this.d.store.claimRoom({ tenantId: this.config.tenantId, roomSid: facts.roomSid, carrier, carrierParty, candidateInteractionId: this.newId("int"), ttlEpochSeconds: ttl });
  }

  /**
   * Creates the call's first record under the first-bind lease. Starting a session supersedes the call's previous one
   * (the session service keeps one live session per call), so only the lease holder starts one: a concurrent first
   * bind (another worker, or this worker's own retry of a bind whose answer it lost) is refused retryably and, asked
   * again, finds the record (the same binding for its owner, BINDING_OWNER_ACTIVE for anyone else).
   */
  private async createFirst(req: MediaBindRequest, claim: RoomClaim, room: CallRecordData["room"], correlationId: string): Promise<MediaBindResponse | null> {
    const interactionId = claim.interactionId;
    const holder = this.newId("cbl");
    if (!(await this.d.store.takeFirstBindLease({ tenantId: this.config.tenantId, interactionId, holder, nowMs: this.d.clock.now().getTime(), leaseMs: this.firstBindLeaseMs }))) return null;
    let created = false;
    try {
      return await this.createUnderLease(req, claim, room, interactionId, correlationId, () => (created = true));
    } finally {
      if (!created) await this.d.store.releaseFirstBindLease(this.config.tenantId, interactionId, holder).catch(() => undefined);
    }
  }

  private async createUnderLease(req: MediaBindRequest, claim: RoomClaim, room: CallRecordData["room"], interactionId: string, correlationId: string, onCreated: () => void): Promise<MediaBindResponse | null> {
    const session = await this.d.sessions.start(interactionId);
    const view = await this.d.sessions.view(session.sessionRef, interactionId);
    const now = this.d.clock.now();
    const binding = this.makeBinding({ interactionId, carrier: claim.carrier, req, sessionGeneration: view.sessionGeneration, sessionRef: session.sessionRef, fencingToken: 1, supersedes: null, sessionExpiresAt: view.expiresAt, now });
    const consent = this.effectiveConsent(null, view);
    const data: CallRecordData = {
      schema: CALL_RECORD_SCHEMA,
      tenantId: this.config.tenantId,
      interactionId,
      carrier: { kind: claim.carrier.kind, interactionRef: claim.carrier.interactionRef, routeRef: claim.carrier.routeRef },
      room,
      carrierParty: claim.carrierParty,
      jobRef: req.jobRef,
      agentIdentity: req.agentIdentity,
      binding,
      sealedSession: this.seal(session.sessionRef, interactionId),
      consentVersion: 1,
      consentDigest: consent.digest,
      deliveredConsentVersion: 1,
      runtimeDeclines: { recording: null, transcriptionAiProcessing: null },
      lastMismatch: null,
      ended: false,
      history: [historyOf(binding, now)],
      issuanceAudit: { state: "PENDING", untilMs: now.getTime() + this.firstBindLeaseMs },
      recorders: [],
    };
    if (!(await this.d.store.create(data))) {
      // Another request created the call first (it took the lease over after ours ran out): its record owns the call.
      return null;
    }
    onCreated();
    // Defence in depth for a lease that ran out while we started the session: if a later start superseded ours,
    // start again under the record we now own.
    const live = await this.ensureLiveSession({ version: 1, data }, correlationId);
    // Without the event the binding is refused (OPS-01); the record says the event is missing, so the retry writes it.
    const audited = await this.writeIssuanceEvidence(live, correlationId);
    this.logger.info("calls.binding.issued", { bindingId: audited.binding.bindingId, sessionGeneration: audited.binding.sessionGeneration, fencingToken: audited.binding.owner.fencingToken });
    return this.response(audited, view, "NEW_CALL", null);
  }

  /**
   * Writes the issuance or recovery event of a record whose binding this request just issued (issuanceAudit PENDING),
   * then marks it WRITTEN. A failed write marks it MISSING (best effort: a mark that does not land leaves PENDING, which
   * a retry treats as MISSING once its time passed) and refuses the issuance (AUDIT_UNAVAILABLE). A concurrent change
   * of the record leaves the marker unset; the next retry then writes the event again (at least once, never zero).
   */
  private async writeIssuanceEvidence(rec: StoredCallRecord, correlationId: string): Promise<CallRecordData> {
    try {
      await this.auditIssuance(rec.data, correlationId);
    } catch (err) {
      await this.d.store.replace(rec.version, { ...rec.data, issuanceAudit: { state: "MISSING", untilMs: 0 } }).catch(() => false);
      throw err;
    }
    const next: CallRecordData = { ...rec.data, issuanceAudit: { state: "WRITTEN", untilMs: 0 } };
    if (await this.d.store.replace(rec.version, next).catch(() => false)) return next;
    this.logger.warn("calls.binding.audit_marker_unset", { reasonCode: "BINDING_CONCURRENT_UPDATE", bindingId: rec.data.binding.bindingId });
    return next;
  }

  /** The issuance or recovery event of the record's current binding (which one follows from how the binding was issued). */
  private async auditIssuance(rec: CallRecordData, correlationId: string): Promise<void> {
    const b = rec.binding;
    const recovered = b.supersedesBindingId !== null;
    await this.auditOrRefuse({
      action: recovered ? "call.binding.recovered" : "call.binding.issued",
      outcome: "SUCCEEDED",
      interactionId: rec.interactionId,
      bindingId: b.bindingId,
      sessionBindingRef: b.sessionBindingRef,
      sessionGeneration: b.sessionGeneration,
      reasonCode: recovered ? "BINDING_RECOVERED" : "BINDING_ISSUED",
      correlationId,
    });
  }



  private async ensureLiveSession(rec: StoredCallRecord, correlationId: string): Promise<StoredCallRecord> {
    let current = rec;
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
      try {
        const view = await this.d.sessions.view(this.open(current.data), current.data.interactionId);
        if (view.sessionGeneration === current.data.binding.sessionGeneration) return current;
      } catch (err) {
        if (!(err instanceof SessionInvalidError)) throw err;
      }
      const session = await this.d.sessions.start(current.data.interactionId);
      const view = await this.d.sessions.view(session.sessionRef, current.data.interactionId);
      const binding: CallBinding = CallBinding.parse({ ...current.data.binding, sessionGeneration: view.sessionGeneration, sessionBindingRef: sessionBindingRefOf(session.sessionRef), expiresAt: this.expiry(this.d.clock.now(), view.expiresAt) });
      const next: CallRecordData = { ...current.data, binding, sealedSession: this.seal(session.sessionRef, current.data.interactionId) };
      if (await this.d.store.replace(current.version, next)) return { version: current.version + 1, data: next };
      const reloaded = await this.d.store.load(this.config.tenantId, current.data.interactionId);
      if (!reloaded) throw new BindingRefusedError("BINDING_NOT_FOUND");
      current = reloaded;
    }
    void correlationId;
    throw new BindingRefusedError("BINDING_CONCURRENT_UPDATE", "BINDING_CONCURRENT_UPDATE", true);
  }

  private async rebind(existing: StoredCallRecord, req: MediaBindRequest, room: CallRecordData["room"], presentAgents: readonly string[], correlationId: string): Promise<MediaBindResponse | null> {
    const rec = existing.data;
    const now = this.d.clock.now();
    const deny = async (reasonCode: string): Promise<never> => {
      await this.auditBestEffort({ action: "call.binding.refused", outcome: "DENIED", interactionId: rec.interactionId, bindingId: rec.binding.bindingId, sessionBindingRef: rec.binding.sessionBindingRef, sessionGeneration: rec.binding.sessionGeneration, reasonCode, correlationId });
      throw new BindingRefusedError(reasonCode);
    };
    // The call lives in exactly one room: a bind from any other room (another name, or another room instance under
    // the same name) never touches it, and the owner-presence check below is therefore about the call's own room.
    if (rec.room.sid !== room.sid || rec.room.nameDigest !== room.nameDigest) return deny("BINDING_ROOM_MISMATCH");
    if (rec.ended || rec.binding.state === "ENDED") return deny("BINDING_CALL_ENDED");
    if (rec.binding.state === "REVOKED") return deny("BINDING_REVOKED");
    const current = rec.binding;
    const live = current.state === "ACTIVE" && Date.parse(current.expiresAt) > now.getTime();
    const sameOwner = rec.jobRef === req.jobRef && rec.agentIdentity === req.agentIdentity && current.owner.instanceRef === req.workerInstanceRef;
    const sessionRef = this.open(rec);
    if (sameOwner && live) {
      // Retry of an issuance this worker already holds: same binding, current consent, the issue kind it was issued
      // with. An issuance or recovery whose event is still missing is audited first (refused again if it cannot be).
      const view = await this.viewOrRevoke(existing, sessionRef, correlationId);
      const synced = this.withConsent({ ...rec, binding: CallBinding.parse({ ...current, sessionGeneration: view.sessionGeneration }) }, view);
      if (this.consentRequiresPerson(synced, view)) return deny("BINDING_CONSENT_REQUIRES_PERSON");
      const evidence = rec.issuanceAudit;
      // The issuing request may still be writing the event: ask again shortly, never write it twice.
      if (evidence.state === "PENDING" && evidence.untilMs > now.getTime()) throw new BindingRefusedError("BINDING_CONCURRENT_UPDATE", "BINDING_CONCURRENT_UPDATE", true);
      if (evidence.state !== "WRITTEN") await this.auditIssuance(synced, correlationId);
      const next = this.delivered({ ...synced, issuanceAudit: { state: "WRITTEN", untilMs: 0 } });
      if (!(await this.d.store.replace(existing.version, next))) return null;
      return this.response(next, view, current.supersedesBindingId === null ? "NEW_CALL" : "REBOUND_AFTER_OWNER_LOSS", current.supersedesBindingId);
    }
    if (live && presentAgents.includes(rec.agentIdentity)) return deny("BINDING_OWNER_ACTIVE");
    // A caller whose consent sends them to a person is never re-bound to the AI (the generation does not move).
    const before = await this.viewOrRevoke(existing, sessionRef, correlationId);
    if (this.consentRequiresPerson(rec, before)) return deny("BINDING_CONSENT_REQUIRES_PERSON");
    // Recovery: the previous owner left the room or stopped renewing. New generation, new fencing token.
    let view: CallSessionView;
    try {
      view = await this.d.sessions.change(sessionRef, "OWNER_RECOVERED");
    } catch (err) {
      if (err instanceof SessionInvalidError) return this.revokeAndDeny(existing, "BINDING_SESSION_INVALID", correlationId);
      throw err;
    }
    // Confirmations and prepared actions the old owner collected are void (ACT-01): reconcile, never resume.
    const invalidated = await this.d.actions.invalidatePending(sessionRef, "CALL_OWNER_RECOVERED");
    const binding = this.makeBinding({
      interactionId: rec.interactionId,
      carrier: { kind: rec.carrier.kind, interactionRef: rec.carrier.interactionRef, routeRef: rec.carrier.routeRef },
      req,
      sessionGeneration: view.sessionGeneration,
      sessionRef,
      fencingToken: current.owner.fencingToken + 1,
      supersedes: current.bindingId,
      sessionExpiresAt: view.expiresAt,
      now,
    });
    const next = this.delivered(
      this.withConsent(
        {
          ...rec,
          jobRef: req.jobRef,
          agentIdentity: req.agentIdentity,
          binding,
          history: [...rec.history.map((h) => (h.bindingId === current.bindingId ? { ...h, state: "SUPERSEDED" as const } : h)), historyOf(binding, now)].slice(-16),
          issuanceAudit: { state: "PENDING", untilMs: now.getTime() + this.firstBindLeaseMs },
        },
        view,
      ),
    );
    if (!(await this.d.store.replace(existing.version, next))) return null;
    const audited = await this.writeIssuanceEvidence({ version: existing.version + 1, data: next }, correlationId);
    this.logger.info("calls.binding.recovered", { bindingId: binding.bindingId, sessionGeneration: binding.sessionGeneration, fencingToken: binding.owner.fencingToken, invalidatedActions: invalidated });
    return this.response(audited, view, "REBOUND_AFTER_OWNER_LOSS", current.bindingId);
  }

  /**
   * The caller's consent sends them to a person: AI processing declined (the runtime cannot converse without it), or
   * recording declined where the tenant's configured alternative is a person (DATA-03).
   */
  private consentRequiresPerson(rec: CallRecordData, view: CallSessionView): boolean {
    const c = this.effectiveConsent(rec, view);
    return c.ai.value === "DECLINED" || (c.recording.value === "DECLINED" && this.config.recordingDeclinedRoute === "HUMAN");
  }

  /* ------------------------------------------------------------------ claims */

  /** Current binding and bearer session for a claim, or a reason-coded refusal. For the gateway's runtime session resolution (WP-14). */
  async resolveClaim(identity: RuntimeIdentity, rawClaim: MediaBindingClaim): Promise<ResolvedCallBinding> {
    this.assertIdentity(identity);
    const { record } = await this.current(rawClaim, "claim", null);
    return { binding: record.data.binding, sessionRef: this.open(record.data) };
  }

  /**
   * As `resolveClaim`, for an AI turn or tool action on the call (the runtime tool path, WP-14): refused while a person
   * is requested for the call's room or is on the call (BINDING_PERSON_REQUESTED, BINDING_WITH_PERSON; SAFE-02,
   * FO-10-46), so the AI never acts on a call that went to a person, whatever its worker does with the heartbeat answer.
   */
  async resolveClaimForAiAction(identity: RuntimeIdentity, rawClaim: MediaBindingClaim, correlationId: string): Promise<ResolvedCallBinding> {
    this.assertIdentity(identity);
    const { record } = await this.current(rawClaim, "ai_action", correlationId);
    await this.refuseWhilePersonRequested(record, "ai_action", correlationId);
    return { binding: record.data.binding, sessionRef: this.open(record.data) };
  }

  /** Refuses a live claim while the room's person request says the call is not the AI's (owed or with a person). */
  private async refuseWhilePersonRequested(record: StoredCallRecord, action: string, correlationId: string): Promise<void> {
    const person = personStateOf(await this.d.store.personRequest(this.config.tenantId, record.data.room.sid));
    if (person === "NONE") return;
    const b = record.data.binding;
    await this.auditBestEffort({ action: "call.binding.claim_refused", outcome: "DENIED", interactionId: record.data.interactionId, bindingId: b.bindingId, sessionBindingRef: b.sessionBindingRef, sessionGeneration: b.sessionGeneration, reasonCode: personRefusalCode(person), correlationId });
    this.logger.warn("calls.binding.claim_refused", { reasonCode: personRefusalCode(person), action, bindingId: b.bindingId, sessionGeneration: b.sessionGeneration });
    throw new BindingRefusedError(personRefusalCode(person));
  }

  /**
   * Renews the binding, follows the session's generation and returns the current processing directive. A binding
   * whose room has a person requested (owed or accepted, by anyone: the owner itself, another runtime, the supervisor)
   * is no longer the AI's to hold: the renewal is refused (BINDING_PERSON_REQUESTED, BINDING_WITH_PERSON) and the
   * runtime suspends (SAFE-02, FO-10-46). The person request is read on every renewal, so it reaches a live owner
   * within one heartbeat interval however it was recorded.
   */
  async heartbeat(identity: RuntimeIdentity, rawClaim: MediaBindingClaim, correlationId: string): Promise<MediaHeartbeatResponse> {
    this.assertIdentity(identity);
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
      const { record } = await this.current(rawClaim, "heartbeat", correlationId);
      await this.refuseWhilePersonRequested(record, "heartbeat", correlationId);
      const sessionRef = this.open(record.data);
      const view = await this.viewOrRevoke(record, sessionRef, correlationId);
      const now = this.d.clock.now();
      const binding = CallBinding.parse({ ...record.data.binding, sessionGeneration: view.sessionGeneration, expiresAt: this.expiry(now, view.expiresAt) });
      const next = this.delivered(this.withConsent({ ...record.data, binding }, view));
      if (!(await this.d.store.replace(record.version, next))) continue;
      return { state: binding.state, expiresAt: binding.expiresAt, sessionGeneration: binding.sessionGeneration, directive: this.directive(next, view) };
    }
    throw new BindingRefusedError("BINDING_CONCURRENT_UPDATE", "BINDING_CONCURRENT_UPDATE", true);
  }

  /* ------------------------------------------------------------------ call lifecycle (FO-10-09) */

  /**
   * Maps a media-plane lifecycle event to the control plane: a participant change advances the session generation
   * (TC-03 equivalent, privileges and consent of the previous party do not carry over), hold, transfer leg and media
   * loss void pending confirmations, and a hang-up ends the session (TC-11 equivalent). Pending actions are
   * invalidated for every change, never committed (ACT-01).
   */
  async lifecycle(identity: RuntimeIdentity, raw: MediaLifecycleRequest, correlationId: string): Promise<MediaLifecycleResponse> {
    this.assertIdentity(identity);
    const req = MediaLifecycleRequest.parse(raw);
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
      const { record } = await this.current(req.claim, "lifecycle", correlationId);
      const rec = record.data;
      const sessionRef = this.open(rec);
      const { kind, participantRole } = req.event;
      let view: CallSessionView | null = null;
      let invalidationReason: string | null = null;
      let ended = false;
      let reasonCode = `LIFECYCLE_${kind}`;
      const partyChange = (kind === "PARTICIPANT_JOINED" || kind === "PARTICIPANT_LEFT") && participantRole !== "human_agent";
      if (partyChange) {
        try {
          view = await this.d.sessions.change(sessionRef, "PARTICIPANT_CHANGED");
        } catch (err) {
          if (err instanceof SessionInvalidError) return this.revokeAndDeny(record, "BINDING_SESSION_INVALID", correlationId);
          throw err;
        }
        invalidationReason = "PARTICIPANT_CHANGED";
        reasonCode = "SESSION_GENERATION_ADVANCED";
      } else if (kind === "PARTICIPANT_JOINED") invalidationReason = "HUMAN_JOINED";
      else if (kind === "HOLD_STARTED") invalidationReason = "CALL_ON_HOLD";
      else if (kind === "TRANSFER_LEG_STARTED") invalidationReason = "TRANSFER_STARTED";
      else if (kind === "MEDIA_DISCONNECTED") invalidationReason = "MEDIA_DISCONNECTED";
      else if (kind === "CALLER_HUNG_UP") {
        invalidationReason = "CALL_ENDED";
        ended = true;
      }
      const invalidated = invalidationReason ? await this.d.actions.invalidatePending(sessionRef, invalidationReason) : 0;
      const now = this.d.clock.now();
      let binding = rec.binding;
      if (view) binding = CallBinding.parse({ ...binding, sessionGeneration: view.sessionGeneration });
      if (ended) binding = CallBinding.parse({ ...binding, state: "ENDED" });
      const consentView = view ?? (ended ? null : await this.viewOrRevoke(record, sessionRef, correlationId));
      const base: CallRecordData = {
        ...rec,
        binding,
        ended: rec.ended || ended,
        history: rec.history.map((h) => (h.bindingId === binding.bindingId ? { ...h, state: binding.state, sessionGeneration: binding.sessionGeneration, at: iso(now) } : h)),
      };
      const next = consentView ? this.withConsent(base, consentView) : base;
      if (!(await this.d.store.replace(record.version, next))) continue;
      if (ended) {
        // The session ends after the record: a lost update above never leaves a live binding over an ended session.
        try {
          await this.d.sessions.end(sessionRef);
        } catch (err) {
          if (!(err instanceof SessionInvalidError)) throw err;
        }
      }
      await this.auditBestEffort({ action: `call.lifecycle.${kind.toLowerCase()}`, outcome: "SUCCEEDED", interactionId: rec.interactionId, bindingId: binding.bindingId, sessionBindingRef: binding.sessionBindingRef, sessionGeneration: binding.sessionGeneration, reasonCode, correlationId });
      // The event is recorded either way; a call whose room has a person requested is answered so (the runtime suspends).
      const person = ended ? "NONE" : await this.personFlag(rec.room.sid);
      return {
        claim: claimOf(binding),
        state: binding.state,
        generationChanged: view !== null,
        invalidatedActions: invalidated,
        routeToHuman: person !== "NONE",
        reasonCode: person !== "NONE" ? personRefusalCode(person) : reasonCode,
      };
    }
    throw new BindingRefusedError("BINDING_CONCURRENT_UPDATE", "BINDING_CONCURRENT_UPDATE", true);
  }

  /* ------------------------------------------------------------------ consent on the media path (DATA-03) */

  /**
   * The caller declined or revoked recording or AI processing on the media path (the RECORDING_REFUSED injection
   * point). Only a decrease is accepted from the runtime: the decline outranks the stored consent for the rest of
   * the call, the consent version advances, and the configured alternative is returned. A decline is applied even
   * when the audit write fails (privacy-protective direction); the failure is logged.
   */
  async consentDecision(identity: RuntimeIdentity, raw: MediaConsentDecisionRequest, correlationId: string): Promise<MediaConsentDecisionResponse> {
    this.assertIdentity(identity);
    const req = MediaConsentDecisionRequest.parse(raw);
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
      const { record } = await this.current(req.claim, "consent", correlationId);
      const rec = record.data;
      const view = await this.viewOrRevoke(record, this.open(rec), correlationId);
      const declines = { ...rec.runtimeDeclines, [req.dimension]: { decision: req.decision, capturedVia: req.capturedVia, at: iso(this.d.clock.now()) } };
      const withDecline: CallRecordData = { ...rec, runtimeDeclines: declines };
      const consent = this.effectiveConsent(withDecline, view);
      const next: CallRecordData = { ...withDecline, consentVersion: rec.consentVersion + 1, consentDigest: consent.digest, deliveredConsentVersion: rec.consentVersion + 1 };
      if (!(await this.d.store.replace(record.version, next))) continue;
      const routeToHuman = req.dimension === "transcriptionAiProcessing" || this.config.recordingDeclinedRoute === "HUMAN";
      const reasonCode = req.dimension === "recording" ? (routeToHuman ? "RECORDING_DECLINED_HUMAN_ROUTE" : "RECORDING_DECLINED_CONTINUE_UNRECORDED") : "AI_PROCESSING_DECLINED_HUMAN_ROUTE";
      await this.auditBestEffort({ action: "media.consent.declined", outcome: "SUCCEEDED", interactionId: rec.interactionId, bindingId: rec.binding.bindingId, sessionBindingRef: rec.binding.sessionBindingRef, sessionGeneration: rec.binding.sessionGeneration, reasonCode, correlationId });
      return { directive: this.directive(next, view), routeToHuman, reasonCode };
    }
    throw new BindingRefusedError("BINDING_CONCURRENT_UPDATE", "BINDING_CONCURRENT_UPDATE", true);
  }

  /**
   * The worker's MediaProcessingState readout, checked against the consent it must follow, answered with the current
   * processing directive (the worker reports on every reconciliation tick, so a consent change recorded in the
   * control plane reaches the recorder and the taps within one reconciliation interval, DATA-03).
   *
   * Which consent judges the readout: the current directive, unless the owner has not been told of it yet (its readout
   * carries a version not lower than the last one answered to it, but lower than the current one: a change recorded in
   * the control plane since); then its own consent, and this answer tells it. A readout below the version already
   * answered is a stale worker and is judged by the current directive. Any recorder or tap running without consent, an
   * unknown recorder state, a refused recorder or a recorder the worker did not start is a mismatch with the disclosed
   * state: it is recorded, audited and answered with a human route.
   */
  async reportProcessing(identity: RuntimeIdentity, raw: MediaProcessingReportRequest, correlationId: string): Promise<MediaProcessingReportResponse> {
    this.assertIdentity(identity);
    const req = MediaProcessingReportRequest.parse(raw);
    const s = req.state;
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
      const { record } = await this.current(req.claim, "processing", correlationId);
      const rec = record.data;
      if (s.tenantId !== rec.tenantId || s.interactionId !== rec.interactionId || s.bindingId !== rec.binding.bindingId || s.sessionGeneration !== rec.binding.sessionGeneration) {
        throw new ValidationError("PROCESSING_STATE_BINDING_MISMATCH");
      }
      const view = await this.viewOrRevoke(record, this.open(rec), correlationId);
      const synced = this.withConsent(rec, view);
      if (s.consent.consentVersion > synced.consentVersion) throw new ValidationError("PROCESSING_STATE_VERSION_INVALID");
      const directive = this.directive(synced, view);
      const now = this.d.clock.now();
      const untold = s.consent.consentVersion >= rec.deliveredConsentVersion && s.consent.consentVersion < synced.consentVersion;
      const judge = untold ? s.consent : directive;
      const unconsented = unconsentedTaps(s, judge, now);
      const mismatch: ProcessingMismatch | null = s.mismatch ?? (unconsented.includes("recording") ? "RECORDING_WITHOUT_CONSENT" : unconsented.length > 0 ? "TAP_WITHOUT_CONSENT" : null);
      // The recorders this owner started are kept per binding: the adoptable set after an owner loss (DATA-03).
      const recorders = mergeRecorders(rec.recorders, rec.binding.bindingId, s.recorderRefs);
      const next = this.delivered({ ...synced, recorders, lastMismatch: mismatch ? { mismatch, at: iso(now) } : rec.lastMismatch });
      const changed = next.consentVersion !== rec.consentVersion || next.deliveredConsentVersion !== rec.deliveredConsentVersion || mismatch !== null || recorders !== rec.recorders;
      if (changed && !(await this.d.store.replace(record.version, next))) continue;
      if (mismatch === null) {
        // The readout is recorded either way; a call whose room has a person requested is answered so (the runtime suspends).
        const person = await this.personFlag(rec.room.sid);
        if (person !== "NONE") return { accepted: true, mismatch: null, routeToHuman: true, reasonCode: personRefusalCode(person), directive };
        return { accepted: true, mismatch: null, routeToHuman: false, reasonCode: "PROCESSING_STATE_CONSISTENT", directive };
      }
      await this.auditBestEffort({ action: "media.processing.mismatch", outcome: "FAILED", interactionId: rec.interactionId, bindingId: rec.binding.bindingId, sessionBindingRef: rec.binding.sessionBindingRef, sessionGeneration: rec.binding.sessionGeneration, reasonCode: mismatch, correlationId });
      this.logger.warn("calls.processing.mismatch", { bindingId: rec.binding.bindingId, reasonCode: mismatch });
      return { accepted: false, mismatch, routeToHuman: true, reasonCode: mismatch, directive };
    }
    throw new BindingRefusedError("BINDING_CONCURRENT_UPDATE", "BINDING_CONCURRENT_UPDATE", true);
  }

  /* ------------------------------------------------------------------ recorders of a call without an owner (DATA-03) */

  /**
   * The call's recorders and the consent they answer to, for a runtime that holds no binding for its job (refused into
   * a person route after the owner was lost: BINDING_CONSENT_REQUIRES_PERSON, BINDING_PERSON_REQUESTED,
   * BINDING_WITH_PERSON). The job is confirmed as for a bind (dispatched in the room, assigned to the named agent, which
   * is present); nothing is issued or claimed: the room's claim is read, never created. The runtime stops the named
   * recorders that still run (the AI runtime no longer holds the call) and reports a recorder the consent does not
   * permit, which is recorded and audited here like a readout mismatch (DATA-03, FO-10-46, T-FO-11-03).
   */
  async recordersOfJob(identity: RuntimeIdentity, raw: MediaRecorderCheckRequest, correlationId: string): Promise<MediaRecorderCheckResponse> {
    this.assertIdentity(identity);
    const req = MediaRecorderCheckRequest.parse(raw);
    const facts = await this.d.lookup.verify({ tenantId: this.config.tenantId, roomName: req.roomName, jobRef: req.jobRef, agentIdentity: req.agentIdentity });
    const claim = await this.d.store.roomClaim(this.config.tenantId, facts.roomSid);
    if (!claim) return { interactionId: null, directive: null, recorders: [] };
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
      const record = await this.d.store.load(this.config.tenantId, claim.interactionId);
      if (!record) return { interactionId: claim.interactionId, directive: null, recorders: [] };
      const rec = record.data;
      let directive: ProcessingDirective | null = null;
      try {
        const view = await this.d.sessions.view(this.open(rec), rec.interactionId);
        directive = this.directive(this.withConsent(rec, view), view);
      } catch (err) {
        // An ended or revoked session: no consent can be shown, so none is given (UNKNOWN is not consent).
        if (!(err instanceof SessionInvalidError)) throw err;
      }
      const recorders = [...new Set(rec.recorders.map((r) => r.egressId))].slice(-32);
      if (req.mismatch === null) return { interactionId: rec.interactionId, directive, recorders };
      const now = this.d.clock.now();
      if (!(await this.d.store.replace(record.version, { ...rec, lastMismatch: { mismatch: req.mismatch, at: iso(now) } }))) continue;
      await this.auditBestEffort({ action: "media.processing.mismatch", outcome: "FAILED", interactionId: rec.interactionId, bindingId: null, sessionBindingRef: rec.binding.sessionBindingRef, sessionGeneration: rec.binding.sessionGeneration, reasonCode: req.mismatch, correlationId });
      this.logger.warn("calls.processing.mismatch", { reasonCode: req.mismatch, action: "recorder_check" });
      return { interactionId: rec.interactionId, directive, recorders };
    }
    throw new BindingRefusedError("BINDING_CONCURRENT_UPDATE", "BINDING_CONCURRENT_UPDATE", true);
  }

  /* ------------------------------------------------------------------ routes without a binding (SAFE-02) */

  /**
   * Platform interaction of a room for the session-less human and safety routes: the media plane names the room (no
   * binding, session or job is needed); the first touch claims the room for its call, so the handoff is attributed
   * to the same interaction the binding uses. A room whose carrier reference is already claimed by another room is
   * refused (the route then goes ahead unattributed, never under the other room's call).
   */
  async interactionForRoom(identity: RuntimeIdentity, roomName: string): Promise<{ interactionId: string; carrier: CarrierInteraction }> {
    this.assertIdentity(identity);
    return this.interactionOfRoom(roomName);
  }

  /**
   * The same for platform-internal callers that hold no runtime credential (the media-plane supervisor's human
   * route after an unrecovered owner loss). Never exposed on a route.
   */
  async interactionOfRoom(roomName: string): Promise<{ interactionId: string; carrier: CarrierInteraction }> {
    const facts = await this.d.lookup.describeRoom({ tenantId: this.config.tenantId, roomName });
    const claim = await this.claimRoom(facts);
    return { interactionId: claim.interactionId, carrier: claim.carrier };
  }

  /**
   * The media-plane supervisor saw the room's caller gone (and no lifecycle report ended the call, e.g. the worker
   * was down or the gateway unreachable when the caller hung up): the call is ended as a hang-up would end it
   * (binding ENDED, pending actions void, session ended; FO-10-09). Platform-internal, never exposed on a route.
   */
  async endRoom(roomName: string, correlationId: string): Promise<"ENDED" | "NOT_BOUND" | "ALREADY_ENDED"> {
    const facts = await this.d.lookup.describeRoom({ tenantId: this.config.tenantId, roomName });
    const claim = await this.d.store.roomClaim(this.config.tenantId, facts.roomSid);
    if (!claim) return "NOT_BOUND";
    return this.endIfOpen(claim.interactionId, "CALLER_LEFT_ROOM", correlationId);
  }

  /* ------------------------------------------------------------------ person requests (SAFE-02, FO-10-46) */

  /**
   * The room of a session-less human or safety route (platform-internal; the gateway route authenticates the runtime).
   * A room the media plane positively reports as not existing is refused (MEDIA_ROOM_NOT_FOUND: nobody to route).
   * When the media plane cannot be asked, the route still happens under a fresh interaction id (attributed false, no
   * room: the request cannot be recorded); when the room exists but its carrier cannot be named (claimed by another
   * room, ambiguous, no call id), the route happens under a fresh interaction id and the request is recorded for the
   * room. Otherwise the room's claim names the interaction (the first touch claims it).
   */
  async roomForRoute(roomName: string): Promise<{ roomSid: string | null; interactionId: string; attributed: boolean; reasonCode: string | null }> {
    let facts: MediaRoomFacts;
    try {
      facts = await this.d.lookup.describeRoom({ tenantId: this.config.tenantId, roomName });
    } catch (err) {
      if (err instanceof AccessDeniedError && err.reasonCode === "MEDIA_ROOM_NOT_FOUND") throw err;
      return { roomSid: null, interactionId: this.newId("int"), attributed: false, reasonCode: err instanceof PlatformError ? err.reasonCode : "MEDIA_PLANE_UNAVAILABLE" };
    }
    try {
      const claim = await this.claimRoom(facts);
      return { roomSid: facts.roomSid, interactionId: claim.interactionId, attributed: true, reasonCode: null };
    } catch (err) {
      if (!(err instanceof AccessDeniedError || err instanceof DependencyError)) throw err;
      return { roomSid: facts.roomSid, interactionId: this.newId("int"), attributed: false, reasonCode: err.reasonCode };
    }
  }

  /** The room's person request, or null (a route that could not name the room has none). */
  async personRequestOf(roomSid: string): Promise<PersonRequest | null> {
    return this.d.store.personRequest(this.config.tenantId, roomSid);
  }

  /** What the room's person request means for the AI runtime (the supervisor's check before it re-dispatches). */
  async personStateOfRoom(room: { sid: string }): Promise<PersonState> {
    return personStateOf(await this.d.store.personRequest(this.config.tenantId, room.sid));
  }

  /**
   * Records that a person (or the safety route) is requested for the room, BEFORE the handoff is attempted: the first
   * request keeps its reason and time, each later one counts an attempt; an accepted request is left as it is. A
   * safety request is recorded next to a standard one and outranks it.
   *
   * With `attempt`, the same write claims the handoff attempt of what the room is owed (the safety route when it is
   * owed, else the standard person this request asks for) for `attempt.holder`, unless another request holds an attempt
   * that has not lapsed: the caller then sees the other holder in the answer and does not start a second handoff for
   * the room (concurrent requests: a runtime told that a person is owed while the request that recorded it is still
   * attempting the handoff, the supervisor's route, a replacement).
   */
  async notePersonRequested(room: { roomSid: string; interactionId: string }, want: PersonWanted, attempt?: { holder: string; leaseMs: number }): Promise<PersonRequest> {
    const now = this.d.clock.now();
    const at = iso(now);
    return this.d.store.updatePersonRequest(
      this.config.tenantId,
      room.roomSid,
      (cur) => {
        const base: PersonRequest = cur ?? { schema: PERSON_REQUEST_SCHEMA, tenantId: this.config.tenantId, roomSid: room.roomSid, interactionId: room.interactionId, standard: null, safety: null };
        let next: PersonRequest = base;
        if (want.kind === "standard") {
          const s = base.standard;
          if (s?.state !== "ACCEPTED") next = { ...base, standard: s ? { ...s, attempts: Math.min(s.attempts + 1, 100_000) } : { state: "OUTSTANDING", reason: want.reason, language: want.language, requestedAt: at, attempts: 1, handoff: null, acceptedAt: null } };
        } else {
          const s = base.safety;
          if (s?.state !== "ACCEPTED") next = { ...base, safety: s ? { ...s, attempts: Math.min(s.attempts + 1, 100_000) } : { state: "OUTSTANDING", signals: want.signals, locale: want.locale, requestedAt: at, attempts: 1, handoff: null, acceptedAt: null } };
        }
        if (!attempt) return next;
        const claim = (a: PersonAttempt | null | undefined): PersonAttempt | null => (a && a.holder !== attempt.holder && a.untilMs > now.getTime() ? null : { holder: attempt.holder, untilMs: now.getTime() + attempt.leaseMs });
        if (next.safety?.state === "OUTSTANDING") {
          const held = claim(next.safety.attempt);
          return held ? { ...next, safety: { ...next.safety, attempt: held } } : next;
        }
        if (want.kind === "standard" && next.standard?.state === "OUTSTANDING") {
          const held = claim(next.standard.attempt);
          return held ? { ...next, standard: { ...next.standard, attempt: held } } : next;
        }
        return next;
      },
      this.personRequestTtl(),
    );
  }

  /** The handoff attempt `holder` made for the room ended without an accepted handoff: the next request attempts at once. */
  async notePersonAttemptEnded(room: { roomSid: string; interactionId: string }, kind: "standard" | "safety", holder: string): Promise<void> {
    await this.d.store.updatePersonRequest(
      this.config.tenantId,
      room.roomSid,
      (cur) => {
        if (!cur) return { schema: PERSON_REQUEST_SCHEMA, tenantId: this.config.tenantId, roomSid: room.roomSid, interactionId: room.interactionId, standard: null, safety: null };
        const s = kind === "standard" ? cur.standard : cur.safety;
        if (!s || s.attempt?.holder !== holder) return cur;
        return kind === "standard" ? { ...cur, standard: { ...(s as NonNullable<PersonRequest["standard"]>), attempt: null } } : { ...cur, safety: { ...(s as NonNullable<PersonRequest["safety"]>), attempt: null } };
      },
      this.personRequestTtl(),
    );
  }

  /** Records that the handoff service accepted the room's standard or safety request. */
  async notePersonAccepted(room: { roomSid: string; interactionId: string }, kind: "standard" | "safety", handoff: { handoffId: string | null; destinationId: string; speechTemplateId: string }, want: PersonWanted): Promise<PersonRequest> {
    const at = iso(this.d.clock.now());
    return this.d.store.updatePersonRequest(
      this.config.tenantId,
      room.roomSid,
      (cur) => {
        const base: PersonRequest = cur ?? { schema: PERSON_REQUEST_SCHEMA, tenantId: this.config.tenantId, roomSid: room.roomSid, interactionId: room.interactionId, standard: null, safety: null };
        if (kind === "standard") {
          const s = base.standard ?? (want.kind === "standard" ? { state: "OUTSTANDING" as const, reason: want.reason, language: want.language, requestedAt: at, attempts: 1, handoff: null, acceptedAt: null } : null);
          if (!s || s.state === "ACCEPTED") return base;
          return { ...base, standard: { ...s, state: "ACCEPTED", handoff, acceptedAt: at, attempt: null } };
        }
        const s = base.safety ?? (want.kind === "safety" ? { state: "OUTSTANDING" as const, signals: want.signals, locale: want.locale, requestedAt: at, attempts: 1, handoff: null, acceptedAt: null } : null);
        if (!s || s.state === "ACCEPTED") return base;
        return { ...base, safety: { ...s, state: "ACCEPTED", handoff, acceptedAt: at, attempt: null } };
      },
      this.personRequestTtl(),
    );
  }

  /**
   * The room's person state for an answer flag (lifecycle and processing answers): best effort, since the facts these
   * requests carry are recorded either way and the heartbeat refuses a binding whose person request it cannot read.
   */
  private async personFlag(roomSid: string): Promise<PersonState> {
    try {
      return personStateOf(await this.d.store.personRequest(this.config.tenantId, roomSid));
    } catch (err) {
      this.logger.warn("calls.binding.person_state_unavailable", { reasonCode: err instanceof PlatformError ? err.reasonCode : "UNCLASSIFIED_ERROR" });
      return "NONE";
    }
  }

  private personRequestTtl(): number {
    return Math.floor(this.d.clock.now().getTime() / 1000) + 2 * 86_400;
  }

  /* ------------------------------------------------------------------ internals */

  private assertIdentity(identity: RuntimeIdentity): void {
    if (identity.channel !== "conversation_runtime") throw new AccessDeniedError("RUNTIME_CHANNEL_REQUIRED");
    if (identity.tenantId !== this.config.tenantId) throw new AccessDeniedError("RUNTIME_TENANT_MISMATCH");
    if (identity.environment !== this.config.environment) throw new AccessDeniedError("RUNTIME_ENVIRONMENT_MISMATCH");
    if (!identity.adapters.some((a) => RUNTIME_ADAPTERS.has(a))) throw new AccessDeniedError("RUNTIME_ADAPTER_NOT_ALLOWED");
  }

  /** Loads the call record and checks the claim against its current binding (fail closed, AUTH-03/AUTH-04). */
  private async current(rawClaim: MediaBindingClaim, purpose: string, correlationId: string | null): Promise<{ record: StoredCallRecord }> {
    const parsed = MediaBindingClaim.safeParse(rawClaim);
    if (!parsed.success) throw new ValidationError("BINDING_CLAIM_INVALID");
    const claim = parsed.data;
    const refuse = async (reasonCode: string, rec: CallRecordData | null): Promise<never> => {
      if (correlationId !== null) {
        await this.auditBestEffort({ action: `call.binding.claim_refused`, outcome: "DENIED", interactionId: rec?.interactionId ?? null, bindingId: claim.bindingId, sessionBindingRef: rec?.binding.sessionBindingRef ?? null, sessionGeneration: claim.sessionGeneration, reasonCode, correlationId });
      }
      this.logger.warn("calls.binding.claim_refused", { reasonCode, action: purpose, bindingId: claim.bindingId, sessionGeneration: claim.sessionGeneration });
      throw new BindingRefusedError(reasonCode);
    };
    if (claim.tenantId !== this.config.tenantId) return refuse("BINDING_TENANT_MISMATCH", null);
    const record = await this.d.store.load(claim.tenantId, claim.interactionId);
    if (!record) return refuse("BINDING_NOT_FOUND", null);
    const b = record.data.binding;
    // A claim naming an older binding of this call is stale, whatever else it says.
    if (b.bindingId !== claim.bindingId) return refuse(record.data.history.some((h) => h.bindingId === claim.bindingId) ? "BINDING_SUPERSEDED" : "BINDING_NOT_FOUND", record.data);
    // A revoked binding says so (the worker then routes the caller to a person; an ENDED call it leaves quietly).
    if (b.state === "REVOKED" && b.tenantId === claim.tenantId && b.interactionId === claim.interactionId) return refuse("BINDING_REVOKED", record.data);
    const check = checkBinding(b, claim, this.d.clock.now());
    if (!check.current) return refuse(check.reasonCode, record.data);
    return { record };
  }

  private async viewOrRevoke(record: StoredCallRecord, sessionRef: string, correlationId: string): Promise<CallSessionView> {
    try {
      return await this.d.sessions.view(sessionRef, record.data.interactionId);
    } catch (err) {
      if (err instanceof SessionInvalidError) return this.revokeAndDeny(record, "BINDING_SESSION_INVALID", correlationId);
      throw err;
    }
  }

  /** The session behind the binding is gone (expired, revoked, ended): the binding is revoked, never silently replaced. */
  private async revokeAndDeny(record: StoredCallRecord, reasonCode: string, correlationId: string): Promise<never> {
    const binding = CallBinding.parse({ ...record.data.binding, state: "REVOKED" });
    await this.d.store.replace(record.version, { ...record.data, binding, history: record.data.history.map((h) => (h.bindingId === binding.bindingId ? { ...h, state: "REVOKED" as const } : h)) }).catch(() => false);
    await this.auditBestEffort({ action: "call.binding.revoked", outcome: "DENIED", interactionId: record.data.interactionId, bindingId: binding.bindingId, sessionBindingRef: binding.sessionBindingRef, sessionGeneration: binding.sessionGeneration, reasonCode, correlationId });
    throw new BindingRefusedError(reasonCode);
  }

  /** Ends an open call (the caller is gone): binding ENDED, pending actions void, session ended; idempotent. */
  private async endIfOpen(interactionId: string, reasonCode: string, correlationId: string): Promise<"ENDED" | "NOT_BOUND" | "ALREADY_ENDED"> {
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
      const record = await this.d.store.load(this.config.tenantId, interactionId);
      if (!record) return "NOT_BOUND";
      const rec = record.data;
      if (rec.ended || rec.binding.state === "ENDED") return "ALREADY_ENDED";
      const sessionRef = this.open(rec);
      const binding = CallBinding.parse({ ...rec.binding, state: rec.binding.state === "REVOKED" ? "REVOKED" : "ENDED" });
      const next: CallRecordData = { ...rec, binding, ended: true, history: rec.history.map((h) => (h.bindingId === binding.bindingId ? { ...h, state: binding.state } : h)) };
      if (!(await this.d.store.replace(record.version, next))) continue;
      // After the record: a lost update above never leaves a live binding over an ended session.
      await this.d.actions.invalidatePending(sessionRef, "CALL_ENDED").catch(() => 0);
      try {
        await this.d.sessions.end(sessionRef);
      } catch (err) {
        if (!(err instanceof SessionInvalidError)) throw err;
      }
      await this.auditBestEffort({ action: "call.lifecycle.caller_gone", outcome: "SUCCEEDED", interactionId, bindingId: binding.bindingId, sessionBindingRef: binding.sessionBindingRef, sessionGeneration: binding.sessionGeneration, reasonCode, correlationId });
      this.logger.info("calls.binding.ended", { bindingId: binding.bindingId, reasonCode });
      return "ENDED";
    }
    throw new BindingRefusedError("BINDING_CONCURRENT_UPDATE", "BINDING_CONCURRENT_UPDATE", true);
  }

  /** Revokes an open call's binding (its carrier facts changed under it); the worker then routes the caller to a person. */
  private async revokeIfOpen(interactionId: string, reasonCode: string, correlationId: string): Promise<void> {
    const record = await this.d.store.load(this.config.tenantId, interactionId);
    if (!record || record.data.ended || record.data.binding.state !== "ACTIVE") return;
    await this.revokeAndDeny(record, reasonCode, correlationId).catch(() => undefined);
  }

  /** A new consent version when the effective consent changed (monotonic, DATA-03). */
  private withConsent(rec: CallRecordData, view: CallSessionView): CallRecordData {
    const consent = this.effectiveConsent(rec, view);
    return consent.digest === rec.consentDigest ? rec : { ...rec, consentVersion: rec.consentVersion + 1, consentDigest: consent.digest };
  }

  /** The record as it stands once its current directive is answered to the owner. */
  private delivered(rec: CallRecordData): CallRecordData {
    return { ...rec, deliveredConsentVersion: Math.max(rec.deliveredConsentVersion, rec.consentVersion) };
  }

  private makeBinding(o: {
    interactionId: string;
    carrier: CarrierInteraction;
    req: MediaBindRequest;
    sessionGeneration: number;
    sessionRef: string;
    fencingToken: number;
    supersedes: string | null;
    sessionExpiresAt: string;
    now: Date;
  }): CallBinding {
    return CallBinding.parse({
      schemaVersion: "call-binding.v1",
      tenantId: this.config.tenantId,
      interactionId: o.interactionId,
      sessionGeneration: o.sessionGeneration,
      occurredAt: iso(o.now),
      expiresAt: this.expiry(o.now, o.sessionExpiresAt),
      causationId: null,
      bindingId: this.newId("cbd"),
      carrier: { kind: o.carrier.kind, interactionRef: o.carrier.interactionRef, routeRef: o.carrier.routeRef },
      owner: { adapter: o.req.adapter, instanceRef: o.req.workerInstanceRef, fencingToken: o.fencingToken },
      sessionBindingRef: sessionBindingRefOf(o.sessionRef),
      boundBy: "trusted_server_lookup",
      state: "ACTIVE",
      supersedesBindingId: o.supersedes,
    });
  }

  /** Binding expiry: the configured TTL from now, never beyond the session's own expiry (AUTH-04). */
  private expiry(now: Date, sessionExpiresAt: string): string {
    const ttl = addMs(now, this.config.bindingTtlSeconds * 1000).getTime();
    const session = Date.parse(sessionExpiresAt);
    const at = Math.min(ttl, session);
    if (!(at > now.getTime())) throw new SessionInvalidError("SESSION_EXPIRED");
    return new Date(at).toISOString();
  }

  private effectiveConsent(rec: Pick<CallRecordData, "runtimeDeclines"> | null, view: CallSessionView): { recording: ProcessingConsent; ai: ProcessingConsent; disclosure: string | null; digest: string } {
    const lower = (stored: ProcessingConsent, decline: CallRecordData["runtimeDeclines"]["recording"]): ProcessingConsent =>
      decline ? { value: "DECLINED", expiresAt: null, capturedAt: decline.at, templateVersion: stored.templateVersion } : stored;
    const recording = lower(view.consent.recording, rec?.runtimeDeclines.recording ?? null);
    const ai = lower(view.consent.transcriptionAiProcessing, rec?.runtimeDeclines.transcriptionAiProcessing ?? null);
    const disclosure = view.consent.disclosureTemplateVersion;
    return { recording, ai, disclosure, digest: sha(canonicalJson({ recording, ai, disclosure })) };
  }

  private directive(rec: CallRecordData, view: CallSessionView): ProcessingDirective {
    const c = this.effectiveConsent(rec, view);
    return ProcessingDirective.parse({
      schemaVersion: PROCESSING_DIRECTIVE_SCHEMA_VERSION,
      consentVersion: rec.consentVersion,
      recording: c.recording,
      transcriptionAiProcessing: c.ai,
      disclosureTemplateId: c.disclosure,
      recordingDeclinedRoute: this.config.recordingDeclinedRoute,
      decidedAt: iso(this.d.clock.now()),
    });
  }

  private response(rec: CallRecordData, view: CallSessionView, issue: BindingIssueKind, superseded: string | null): MediaBindResponse {
    return {
      binding: rec.binding,
      claim: claimOf(rec.binding),
      directive: this.directive(rec, view),
      issue,
      supersededBindingId: superseded,
      heartbeatIntervalSeconds: this.config.heartbeatIntervalSeconds,
      // Every recorder an owner of this call reported (a new owner adopts the ones still running).
      adoptableRecorders: [...new Set(rec.recorders.map((r) => r.egressId))].slice(-32),
    };
  }

  private seal(sessionRef: string, interactionId: string): CallRecordData["sealedSession"] {
    const s = this.d.sealer.seal(sessionRef, sealAad(this.config.tenantId, interactionId));
    return { ciphertext: b64(s.ciphertext), iv: b64(s.iv), tag: b64(s.tag), keyId: s.keyId };
  }

  private open(rec: CallRecordData): string {
    const sealed: SealedValue = { ciphertext: unb64(rec.sealedSession.ciphertext), iv: unb64(rec.sealedSession.iv), tag: unb64(rec.sealedSession.tag), keyId: rec.sealedSession.keyId };
    try {
      return this.d.sealer.open(sealed, sealAad(rec.tenantId, rec.interactionId));
    } catch {
      // A record whose session does not open under this call's additional data is never used (copied or tampered).
      throw new AccessDeniedError("BINDING_SESSION_SEAL_INVALID");
    }
  }

  private async auditOrRefuse(e: Omit<BindingAuditEvent, "tenantId">): Promise<void> {
    try {
      await this.d.audit.record({ ...e, tenantId: this.config.tenantId });
    } catch {
      // Issuance without durable evidence is refused (OPS-01); the worker routes the caller to a person.
      this.logger.error("calls.binding.audit_unavailable", { reasonCode: "AUDIT_UNAVAILABLE", action: e.action });
      throw new AuditUnavailableError();
    }
  }

  private async auditBestEffort(e: Omit<BindingAuditEvent, "tenantId">): Promise<void> {
    try {
      await this.d.audit.record({ ...e, tenantId: this.config.tenantId });
    } catch (err) {
      this.logger.error("calls.binding.audit_unwritten", { reasonCode: err instanceof PlatformError ? err.reasonCode : "AUDIT_UNAVAILABLE", action: e.action });
    }
  }
}

/** The refusal (or answer flag) for a room whose person request is not NONE. */
export function personRefusalCode(person: Exclude<PersonState, "NONE">): "BINDING_PERSON_REQUESTED" | "BINDING_WITH_PERSON" {
  return person === "OUTSTANDING" ? "BINDING_PERSON_REQUESTED" : "BINDING_WITH_PERSON";
}

/** The claim a worker presents for a binding (every field server-issued). */
export function claimOf(b: CallBinding): MediaBindingClaim {
  return { bindingId: b.bindingId, tenantId: b.tenantId, interactionId: b.interactionId, sessionGeneration: b.sessionGeneration, fencingToken: b.owner.fencingToken };
}

/** Non-bearer session binding reference (`ses_bnd_` + base64url sha256), the same derivation as identity/keys.ts. */
export function sessionBindingRefOf(sessionRef: string): string {
  return `ses_bnd_${createHash("sha256").update(sessionRef, "utf8").digest("base64url")}`;
}

/** What a session-less route asks for: a person (with the reason and language) or the safety route (with its signals). */
export type PersonWanted =
  | { kind: "standard"; reason: MediaHumanRouteReason; language: string }
  | { kind: "safety"; signals: MediaSafetyRouteRequest["signals"]; locale: string };

/** The call's recorders with this binding's reported ones added (newest last, bounded); the same array when nothing is new. */
function mergeRecorders(current: CallRecordData["recorders"], bindingId: string, refs: readonly string[]): CallRecordData["recorders"] {
  const fresh = refs.filter((egressId) => !current.some((r) => r.bindingId === bindingId && r.egressId === egressId));
  if (fresh.length === 0) return current;
  return [...current, ...fresh.map((egressId) => ({ bindingId, egressId }))].slice(-32);
}

function historyOf(b: CallBinding, now: Date): BindingHistoryEntry {
  return { bindingId: b.bindingId, sessionGeneration: b.sessionGeneration, fencingToken: b.owner.fencingToken, state: b.state, instanceRef: b.owner.instanceRef, at: iso(now) };
}

/**
 * The carrier interaction a room is claimed for at its first touch: the SIP call id of its earliest-joined SIP party
 * (livekit-sip creates the room with the caller's participant), else the room's server id (a WebRTC call). Two SIP
 * parties that joined at the same instant are ambiguous and refused; a SIP party without the media plane's call id
 * is never identified by anything else.
 */
export function carrierOfRoom(facts: MediaRoomFacts): { carrier: CarrierInteraction; carrierParty: string | null } {
  const [first, second] = facts.sipParties;
  if (!first) return { carrier: { kind: "livekit_webrtc", interactionRef: facts.roomSid, routeRef: null }, carrierParty: null };
  if (second && second.joinedAtMs === first.joinedAtMs) throw new AccessDeniedError("MEDIA_CARRIER_AMBIGUOUS");
  if (first.interactionRef === null) throw new AccessDeniedError("MEDIA_SIP_CALL_ID_MISSING");
  return { carrier: { kind: "sip_reference", interactionRef: first.interactionRef, routeRef: first.routeRef }, carrierParty: first.partyDigest };
}
