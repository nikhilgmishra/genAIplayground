import { z } from "zod";
import {
  AuthGateResponse,
  ConsentState,
  IntegrationIdentity,
  OpaqueId,
  RiskFlag,
  Role,
  Sha256Hex,
  meetsAssurance,
} from "../protocol/index.js";
import type { AuthContext, AuthGateResponse as AuthGateResponseT } from "../protocol/index.js";
import type { Clock } from "../shared/clock.js";
import { addMs, iso } from "../shared/clock.js";
import { AccessDeniedError, ConflictError, PlatformError, SessionInvalidError, ValidationError } from "../shared/errors.js";
import { newSessionRef } from "../shared/ids.js";
import type { Logger } from "../observability/ports.js";
import type { Metrics } from "../observability/ports.js";
import { silentLogger } from "../observability/logger.js";
import { noopMetrics } from "../observability/metrics.js";
import type { KvStore, SessionChange, SessionService, StartCallInput, StartCallResult } from "./ports.js";
import type { SessionConfig } from "./config.js";
import { bindingRefFromHash, epochSeconds, kvKeys, sessionRefHash } from "./keys.js";
import { SessionStore, addRiskFlag, bindingProblem, dropPrivileges, lifecycleProblem, privilegesIdleExpired, processingBasisFor, toAuthContext } from "./session-store.js";
import type { SessionInvalidReason, SessionRecord } from "./session-store.js";

/**
 * Talkdesk Auth Gate interpretation (AUTH-07). The gate is open ONLY for the
 * boolean `true`. `null`, `undefined`, `"true"`, `1`, `"yes"`, `{}`, `[]` and every
 * other value are closed. Studio must never initialise the variable to a value
 * that could open the gate; the backend authorises every protected operation
 * regardless of the gate (TB-06: the gate is a UX gate, not authorization).
 */
export function interpretAuthGateVariable(value: unknown): boolean {
  return value === true;
}

/** Strictly parses an AuthGateResponse and returns the gate value; malformed responses are closed. */
export function authGateVariableFor(response: unknown): boolean {
  const r = AuthGateResponse.safeParse(response);
  return r.success && interpretAuthGateVariable(r.data.isAuthenticated);
}

const ConsentStateChecked = ConsentState.superRefine((c, ctx) => {
  const decided = [c.recording, c.automatedProcessing].some((v) => v === "GRANTED" || v === "DECLINED");
  if (decided && (c.capturedBy === "none" || c.capturedAt === null)) ctx.addIssue({ code: "custom", message: "CONSENT_INCONSISTENT" });
});

const StartCallInputSchema = z.strictObject({
  integration: IntegrationIdentity,
  callId: OpaqueId,
  callerIdHash: Sha256Hex.nullable(),
  consent: ConsentStateChecked,
});

export const SessionChangeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("PARTICIPANT_CHANGED") }),
  z.strictObject({ kind: z.literal("ACCOUNT_SWITCH") }),
  z.strictObject({ kind: z.literal("RECOVERY_STARTED") }),
  z.strictObject({ kind: z.literal("RISK_ESCALATION"), flag: RiskFlag }),
  z.strictObject({ kind: z.literal("SAFETY_ESCALATION") }),
]);

const REVOKE_REASON = /^[A-Z][A-Z0-9_]{1,63}$/;

const UNDECIDED_CONSENT = { recording: "UNKNOWN", automatedProcessing: "UNKNOWN", disclosureTemplateVersion: null, capturedAt: null, capturedBy: "none" } as const;

const DENIAL_METRIC_REASON: Record<SessionInvalidReason, string> = {
  SESSION_NOT_FOUND: "SESSION_MISSING",
  SESSION_RECORD_INVALID: "SESSION_MISSING",
  SESSION_EXPIRED: "SESSION_EXPIRED",
  SESSION_REVOKED: "SESSION_REVOKED",
  SESSION_ENDED: "SESSION_REVOKED",
  SESSION_TENANT_MISMATCH: "INTEGRATION_MISMATCH",
  SESSION_ENVIRONMENT_MISMATCH: "INTEGRATION_MISMATCH",
  SESSION_INTEGRATION_MISMATCH: "INTEGRATION_MISMATCH",
  SESSION_CHANNEL_NOT_ALLOWED: "INTEGRATION_MISMATCH",
  SESSION_CALL_MISMATCH: "INTEGRATION_MISMATCH",
  SESSION_IDLE_EXPIRED: "SESSION_EXPIRED",
};

export interface SessionServiceDeps {
  kv: KvStore;
  clock: Clock;
  config: SessionConfig;
  logger?: Logger;
  metrics?: Metrics;
}

export interface ResolveOptions {
  /** When the caller knows the current call (e.g. Studio), a session from another call is rejected. */
  expectedCallId?: string;
}

/**
 * Trusted call sessions (spec section 7). Session state lives in the KV store
 * (DynamoDB in live, LOCAL FIXTURE memory store offline) under the sha256 of the
 * bearer session reference. Every reader enforces expiry, revocation and end of
 * call in application logic using the injected Clock, independent of storage TTL
 * (AUTH-04). Every update is a bounded compare-and-swap.
 */
export class TrustedSessionService implements SessionService {
  readonly store: SessionStore;
  readonly config: SessionConfig;
  private readonly kv: KvStore;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly metrics: Metrics;

  constructor(deps: SessionServiceDeps) {
    this.kv = deps.kv;
    this.clock = deps.clock;
    this.config = deps.config;
    this.logger = (deps.logger ?? silentLogger).child({ component: "identity.sessions" });
    this.metrics = deps.metrics ?? noopMetrics;
    this.store = new SessionStore(deps.kv, deps.clock, deps.config);
  }

  get kind(): "local_fixture" | "live" {
    return this.kv.kind;
  }

  async startCall(input: StartCallInput): Promise<StartCallResult> {
    const parsed = StartCallInputSchema.safeParse(input);
    if (!parsed.success) throw new ValidationError("START_CALL_INPUT_INVALID");
    const { integration, callId, callerIdHash, consent } = parsed.data;
    if (!this.config.startCallChannels.includes(integration.channel)) throw new AccessDeniedError("START_CALL_CHANNEL_NOT_ALLOWED");
    if (integration.tenantId !== this.config.tenantId) throw new AccessDeniedError("INTEGRATION_TENANT_MISMATCH");
    if (integration.environment !== this.config.environment) throw new AccessDeniedError("INTEGRATION_ENVIRONMENT_MISMATCH");

    const now = this.clock.now();
    const expiresAt = iso(addMs(now, this.config.sessionTtlSeconds * 1000));
    let created: { sessionRef: string; rec: SessionRecord } | null = null;
    for (let i = 0; i < 3 && !created; i++) {
      const sessionRef = newSessionRef();
      const rec: SessionRecord = {
        schema: "vsp.session.v1",
        sessionRefHash: sessionRefHash(sessionRef),
        tenantId: integration.tenantId,
        environment: integration.environment,
        integrationId: integration.integrationId,
        callId,
        callerIdHash,
        generation: 1,
        actorId: null,
        accountId: null,
        selectedRole: null,
        subjectId: null,
        organizationId: null,
        delegatedAuthority: [],
        permittedScopes: [],
        assurance: "A0",
        authenticatedAt: null,
        verificationMethod: "none",
        consent,
        riskFlags: [],
        policyVersion: this.config.policyVersion,
        revoked: false,
        revokedReason: null,
        ended: false,
        endedAt: null,
        createdAt: iso(now),
        expiresAt,
        stepUp: null,
        lastChange: null,
      };
      if (await this.store.create(rec)) created = { sessionRef, rec };
    }
    if (!created) throw new ConflictError("SESSION_CREATE_CONFLICT", "SESSION_CREATE_CONFLICT", true);

    try {
      await this.bindCallIndex(created.rec);
    } catch (err) {
      await this.revokeByHash(created.rec.sessionRefHash, "CALL_INDEX_BIND_FAILED").catch(() => undefined);
      throw err instanceof PlatformError ? err : new ConflictError("CALL_INDEX_BIND_FAILED");
    }

    this.logger.info("identity.session.started", {
      sessionBindingRef: bindingRefFromHash(created.rec.sessionRefHash),
      callId,
      sessionGeneration: 1,
      assurance: "A0",
    });
    return { sessionRef: created.sessionRef, sessionGeneration: 1, authGate: false, expiresAt };
  }

  async resolve(sessionRef: string, integration: IntegrationIdentity, options: ResolveOptions = {}): Promise<AuthContext> {
    const integ = this.parseIntegration(integration);
    const hash = this.hashOrDeny(sessionRef);
    const loaded = await this.loadOrDeny(hash);
    const problem =
      bindingProblem(loaded.rec, integ, this.config) ??
      lifecycleProblem(loaded.rec, this.clock.now()) ??
      (options.expectedCallId !== undefined && options.expectedCallId !== loaded.rec.callId ? "SESSION_CALL_MISMATCH" : null);
    if (problem) this.deny(problem, hash);
    const now = this.clock.now();
    let current = loaded.rec;
    if (privilegesIdleExpired(current, now, this.config)) {
      // A concurrent use may have refreshed activity in the meantime: then the CAS keeps the privileges.
      if ((await this.expireIdlePrivileges(hash)).outcome === "EXPIRED") this.deny("SESSION_IDLE_EXPIRED", hash);
      current = (await this.loadOrDeny(hash)).rec;
    }
    const rec = await this.touch(hash, current, now);
    return this.contextOf(rec, sessionRef, integ, now);
  }

  private contextOf(rec: SessionRecord, sessionRef: string, integ: IntegrationIdentity, now: Date): AuthContext {
    return toAuthContext(rec, sessionRef, integ, now, processingBasisFor(rec, this.config));
  }

  /**
   * Idle expiry of verified privileges (FO-05-18, AUTH-04): the privileges are dropped and the generation is
   * bumped in one compare-and-swap (pending verification transactions and prepared actions bound to the old
   * generation are fenced), the lapsed actor is remembered for same-actor re-verification (FO-05-19), and
   * THIS request is refused SESSION_IDLE_EXPIRED. The call continues at A0; safety and human routes never
   * need a session. Re-checked inside the CAS, so a concurrent use that just refreshed activity wins
   * ("ACTIVE": nothing changes).
   */
  private async expireIdlePrivileges(hash: string): Promise<{ outcome: "EXPIRED"; generation: number } | { outcome: "ACTIVE" }> {
    const r = await this.store.mutate(hash, (rec, now) => {
      const p = lifecycleProblem(rec, now);
      if (p) return { abort: p };
      if (!privilegesIdleExpired(rec, now, this.config)) return { abort: "NO_CHANGE" };
      return {
        ...dropPrivileges(rec),
        lapsedActorId: rec.actorId ?? rec.lapsedActorId ?? null,
        generation: rec.generation + 1,
        lastActivityAt: iso(now),
        lastChange: "SESSION_IDLE_EXPIRED",
      };
    });
    if ("aborted" in r && r.aborted === "NO_CHANGE") return { outcome: "ACTIVE" };
    if ("aborted" in r) this.deny(r.aborted as SessionInvalidReason, hash);
    this.logger.info("identity.session.idle_expired", { sessionBindingRef: bindingRefFromHash(hash), sessionGeneration: r.rec.generation, reasonCode: "SESSION_IDLE_EXPIRED" });
    return { outcome: "EXPIRED", generation: r.rec.generation };
  }

  /** Records activity at a bounded write rate; a failed write only shortens the idle window (fails safe). */
  private async touch(hash: string, rec: SessionRecord, now: Date): Promise<SessionRecord> {
    const last = rec.lastActivityAt ? Date.parse(rec.lastActivityAt) : Number.NEGATIVE_INFINITY;
    if (now.getTime() - last < this.config.activityWriteIntervalSeconds * 1000) return rec;
    try {
      const r = await this.store.mutate(hash, (cur, at) => {
        const p = lifecycleProblem(cur, at);
        if (p) return { abort: p };
        const curLast = cur.lastActivityAt ? Date.parse(cur.lastActivityAt) : Number.NEGATIVE_INFINITY;
        if (at.getTime() <= curLast) return { abort: "NO_CHANGE" };
        return { ...cur, lastActivityAt: iso(at) };
      });
      return "rec" in r ? r.rec : rec;
    } catch (err) {
      this.logger.warn("identity.session.activity_write_failed", { sessionBindingRef: bindingRefFromHash(hash), reasonCode: err instanceof PlatformError ? err.reasonCode : "SESSION_STORE_ERROR" });
      return rec;
    }
  }

  async selectRole(sessionRef: string, integration: IntegrationIdentity, role: Role): Promise<AuthContext> {
    const r = Role.safeParse(role);
    if (!r.success) throw new ValidationError("ROLE_INVALID");
    return this.change(sessionRef, integration, (rec) => {
      if (rec.selectedRole === r.data) return null;
      // Privileges are never combined across roles: a new role starts unverified.
      return { ...dropPrivileges(rec), selectedRole: r.data, generation: rec.generation + 1, lastChange: "ROLE_SELECTED" };
    });
  }

  async recordConsent(sessionRef: string, integration: IntegrationIdentity, consent: ConsentState): Promise<AuthContext> {
    const integ = this.parseIntegration(integration);
    if (!this.config.consentChannels.includes(integ.channel)) throw new AccessDeniedError("CONSENT_CHANNEL_NOT_ALLOWED");
    const c = ConsentStateChecked.safeParse(consent);
    if (!c.success) throw new ValidationError("CONSENT_INVALID");
    const capturer = c.data.capturedBy;
    if ((capturer === "portal" && integ.channel !== "portal") || ((capturer === "studio_flow" || capturer === "human_agent") && integ.channel !== "telephony_control")) {
      throw new AccessDeniedError("CONSENT_CAPTURE_SOURCE_MISMATCH");
    }
    if (c.data.capturedAt !== null && Date.parse(c.data.capturedAt) > this.clock.now().getTime() + 60_000) throw new ValidationError("CONSENT_CAPTURED_IN_FUTURE");
    return this.change(sessionRef, integ, (rec) => ({ ...rec, consent: c.data, lastChange: "CONSENT_RECORDED" }));
  }

  async applyChange(sessionRef: string, integration: IntegrationIdentity, change: SessionChange): Promise<AuthContext> {
    const ch = SessionChangeSchema.safeParse(change);
    if (!ch.success) throw new ValidationError("SESSION_CHANGE_INVALID");
    return this.change(sessionRef, integration, (rec) => {
      const base = { ...dropPrivileges(rec), generation: rec.generation + 1, lastChange: ch.data.kind };
      switch (ch.data.kind) {
        case "PARTICIPANT_CHANGED":
          // A different person is on the line: their privileges AND the previous participant's consent do not carry over.
          return { ...base, lapsedActorId: null, consent: { ...UNDECIDED_CONSENT }, riskFlags: addRiskFlag(rec.riskFlags, "PARTICIPANT_CHANGED") };
        case "ACCOUNT_SWITCH":
          // Explicit switch: a different actor may now verify (never silently, FO-05-19).
          return { ...base, lapsedActorId: null };
        case "RECOVERY_STARTED":
          return { ...base, riskFlags: addRiskFlag(rec.riskFlags, "ACCOUNT_RECOVERY_IN_PROGRESS") };
        case "RISK_ESCALATION":
          return { ...base, riskFlags: addRiskFlag(rec.riskFlags, ch.data.flag) };
        case "SAFETY_ESCALATION":
          return { ...base, riskFlags: addRiskFlag(rec.riskFlags, "SAFETY_ESCALATION_ACTIVE") };
      }
    });
  }

  async revoke(sessionRef: string, reasonCode: string): Promise<void> {
    if (typeof reasonCode !== "string" || !REVOKE_REASON.test(reasonCode)) throw new ValidationError("REVOKE_REASON_INVALID");
    await this.revokeByHash(this.hashOrDeny(sessionRef), reasonCode);
  }

  async endCall(sessionRef: string, integration: IntegrationIdentity): Promise<void> {
    const integ = this.parseIntegration(integration);
    const hash = this.hashOrDeny(sessionRef);
    const r = await this.store.mutate(hash, (rec, now) => {
      const p = bindingProblem(rec, integ, this.config);
      if (p) return { abort: p };
      if (rec.ended) return { abort: "ALREADY_ENDED" };
      return { ...dropPrivileges(rec), ended: true, endedAt: iso(now), generation: rec.generation + 1, lastChange: "CALL_ENDED" };
    });
    if ("aborted" in r && r.aborted !== "ALREADY_ENDED") this.deny(r.aborted as SessionInvalidReason, hash);
    this.logger.info("identity.session.ended", { sessionBindingRef: bindingRefFromHash(hash) });
  }

  async authGate(sessionRef: string, integration: IntegrationIdentity, options: ResolveOptions = {}): Promise<AuthGateResponseT> {
    const evaluatedAt = iso(this.clock.now());
    const closed = (generation: number, reasonCode: string): AuthGateResponseT => {
      this.logger.info("identity.auth_gate.closed", { reasonCode });
      return AuthGateResponse.parse({ isAuthenticated: false, sessionGeneration: generation, evaluatedAt });
    };
    const integ = IntegrationIdentity.safeParse(integration);
    if (!integ.success) return closed(1, "SESSION_INTEGRATION_MISMATCH");
    let hash: string;
    try {
      hash = sessionRefHash(sessionRef);
    } catch {
      return closed(1, "SESSION_REF_INVALID");
    }
    let loaded: Awaited<ReturnType<SessionStore["load"]>>;
    try {
      loaded = await this.store.load(hash);
    } catch (err) {
      // KV outage or corrupt record: the gate fails closed.
      return closed(1, err instanceof PlatformError ? err.reasonCode : "SESSION_STORE_ERROR");
    }
    if (!loaded) return closed(1, "SESSION_NOT_FOUND");
    const rec = loaded.rec;
    const binding = bindingProblem(rec, integ.data, this.config);
    if (binding) return closed(1, binding);
    const lifecycle =
      lifecycleProblem(rec, this.clock.now()) ??
      (options.expectedCallId !== undefined && options.expectedCallId !== rec.callId ? "SESSION_CALL_MISMATCH" : null);
    if (lifecycle) return closed(rec.generation, lifecycle);
    // Idle expiry applies to the gate exactly as to every other reader (FO-05-18, AUTH-04, AUTH-07): verified
    // privileges idle beyond the limit close the gate, and they are dropped (generation fenced) as `resolve`
    // drops them, so the gate can never report a caller authenticated whom the next protected request
    // would refuse. Reading the gate is not caller activity: it never extends the idle window.
    if (privilegesIdleExpired(rec, this.clock.now(), this.config)) {
      try {
        const expired = await this.expireIdlePrivileges(hash);
        if (expired.outcome === "EXPIRED") return closed(expired.generation, "SESSION_IDLE_EXPIRED");
        // A concurrent use refreshed the activity inside the CAS: evaluate the current record.
        const fresh = await this.store.load(hash);
        if (!fresh) return closed(rec.generation, "SESSION_NOT_FOUND");
        return this.gateFor(fresh.rec, evaluatedAt, closed);
      } catch (err) {
        return closed(rec.generation, err instanceof PlatformError ? err.reasonCode : "SESSION_STORE_ERROR");
      }
    }
    return this.gateFor(rec, evaluatedAt, closed);
  }

  /** Open only for a live, non-idle, verified (A2+) actor; everything else is closed. */
  private gateFor(rec: SessionRecord, evaluatedAt: string, closed: (generation: number, reasonCode: string) => AuthGateResponseT): AuthGateResponseT {
    const now = this.clock.now();
    const lifecycle = lifecycleProblem(rec, now);
    if (lifecycle) return closed(rec.generation, lifecycle);
    if (privilegesIdleExpired(rec, now, this.config)) return closed(rec.generation, "SESSION_IDLE_EXPIRED");
    const open = rec.actorId !== null && meetsAssurance(rec.assurance, "A2");
    if (!open) return closed(rec.generation, "ASSURANCE_INSUFFICIENT");
    return AuthGateResponse.parse({ isAuthenticated: open === true, sessionGeneration: rec.generation, evaluatedAt });
  }

  // ---------------------------------------------------------------------------

  private async change(
    sessionRef: string,
    integration: IntegrationIdentity,
    fn: (rec: SessionRecord) => SessionRecord | null,
  ): Promise<AuthContext> {
    const integ = this.parseIntegration(integration);
    const hash = this.hashOrDeny(sessionRef);
    const unchanged: { rec: SessionRecord | null } = { rec: null };
    const r = await this.store.mutate(hash, (rec, now) => {
      const p = bindingProblem(rec, integ, this.config) ?? lifecycleProblem(rec, now);
      if (p) return { abort: p };
      const next = fn(rec);
      if (next === null) {
        unchanged.rec = rec;
        return { abort: "NO_CHANGE" };
      }
      return next;
    });
    const now = this.clock.now();
    if ("aborted" in r) {
      if (r.aborted === "NO_CHANGE" && unchanged.rec) return this.contextOf(unchanged.rec, sessionRef, integ, now);
      this.deny(r.aborted as SessionInvalidReason, hash);
    }
    this.logger.info("identity.session.changed", {
      sessionBindingRef: bindingRefFromHash(hash),
      reasonCode: r.rec.lastChange,
      sessionGeneration: r.rec.generation,
      assurance: r.rec.assurance,
    });
    return this.contextOf(r.rec, sessionRef, integ, now);
  }

  private async revokeByHash(hash: string, reasonCode: string): Promise<void> {
    const r = await this.store.mutate(hash, (rec) => {
      if (rec.revoked) return { abort: "ALREADY_REVOKED" };
      return { ...dropPrivileges(rec), revoked: true, revokedReason: reasonCode, generation: rec.generation + 1, lastChange: "REVOKED" };
    });
    this.logger.info("identity.session.revoked", {
      sessionBindingRef: bindingRefFromHash(hash),
      reasonCode,
      outcome: "aborted" in r ? r.aborted : "REVOKED",
    });
  }

  /**
   * One live session per call: a second startCall for the same call (Studio retry,
   * reconnect with the same interaction id) supersedes and revokes the previous one.
   */
  private async bindCallIndex(rec: SessionRecord): Promise<void> {
    const pk = kvKeys.callIndex(rec.tenantId, rec.callId);
    const data = { schema: "vsp.call-index.v1", sessionRefHash: rec.sessionRefHash };
    const ttl = epochSeconds(new Date(rec.expiresAt)) + this.config.storageTtlGraceSeconds;
    for (let attempt = 0; attempt < this.config.casMaxAttempts; attempt++) {
      if (await this.kv.putIfAbsent({ pk, version: 1, ttlEpochSeconds: ttl, data })) return;
      const existing = await this.kv.get<{ sessionRefHash?: unknown }>(pk);
      if (!existing) continue;
      const prev = existing.data.sessionRefHash;
      if (typeof prev === "string" && /^[a-f0-9]{64}$/.test(prev) && prev !== rec.sessionRefHash) {
        await this.revokeByHash(prev, "SUPERSEDED_BY_NEW_SESSION");
      }
      if (await this.kv.compareAndSwap(pk, existing.version, data, ttl)) return;
    }
    throw new ConflictError("CALL_INDEX_CONFLICT", "CALL_INDEX_CONFLICT", true);
  }

  private parseIntegration(integration: IntegrationIdentity): IntegrationIdentity {
    const r = IntegrationIdentity.safeParse(integration);
    if (!r.success) {
      this.metrics.increment("vsp_identity_denials_total", { reason: "INTEGRATION_MISMATCH" });
      throw new SessionInvalidError("SESSION_INTEGRATION_MISMATCH");
    }
    return r.data;
  }

  private hashOrDeny(sessionRef: string): string {
    try {
      return sessionRefHash(sessionRef);
    } catch (err) {
      this.metrics.increment("vsp_identity_denials_total", { reason: "SESSION_MISSING" });
      throw err;
    }
  }

  private async loadOrDeny(hash: string): Promise<{ rec: SessionRecord; version: number }> {
    let loaded: Awaited<ReturnType<SessionStore["load"]>>;
    try {
      loaded = await this.store.load(hash);
    } catch (err) {
      if (err instanceof SessionInvalidError) this.deny("SESSION_RECORD_INVALID", hash);
      throw err;
    }
    if (!loaded) this.deny("SESSION_NOT_FOUND", hash);
    return loaded;
  }

  private deny(reason: SessionInvalidReason, hash: string): never {
    this.metrics.increment("vsp_identity_denials_total", { reason: DENIAL_METRIC_REASON[reason] ?? "SESSION_MISSING" });
    this.logger.warn("identity.session.denied", { reasonCode: reason, sessionBindingRef: bindingRefFromHash(hash) });
    throw new SessionInvalidError(reason);
  }
}
