/**
 * CallBinding store (WP-11; ADR-0018 decisions 1.4 and 4): one conditional record per call in the DynamoDB table of
 * call sessions and bindings, plus two first-writer-wins indexes that pin a call to exactly one room:
 *   - the room claim (room server id -> platform interaction, carrier interaction and carrier party), written the
 *     first time anything touches the room (a bind or a session-less route), never changed afterwards;
 *   - the carrier index (carrier interaction -> platform interaction and the room server id that claimed it), so a
 *     carrier reference seen in a second room (a SIP-kind participant minted with the media-plane API secret and a
 *     copied `sip.callID`) is refused instead of naming the first room's call (FO-05-16).
 * Every update of the call record is a compare-and-swap of the whole record, so the binding, its fencing token,
 * the session generation it carries and the consent version change together or not at all. The call's first record
 * is created under a short first-bind lease: only the lease holder starts the call's session, so two concurrent first
 * binds (two workers, or one worker's retry of a bind whose answer was lost) never start two sessions for one call
 * (the session service keeps one live session per call and revokes the earlier one).
 *
 * Next to the room claim, the room's person request (cbp#): whether a person (or the safety route) was requested for
 * the room and whether the handoff was accepted. It is written before the handoff is attempted and survives the
 * runtime that asked, so neither a re-dispatched runtime nor the supervisor ever puts the AI back on a call whose
 * caller is waiting for, or already with, a person (SAFE-02, FO-10-46).
 *
 * Keys are namespaced sha256 digests (never a carrier id, room name or caller number in a key). The bearer session
 * reference is stored only sealed (AES-256-GCM, additional data binds it to the call record); the binding itself
 * carries the non-bearer `ses_bnd_` reference. Readers enforce expiry themselves; the TTL attribute is cleanup only
 * (AUTH-04). A record that does not parse is refused (fail closed), never repaired.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { AgentJobRef, CallBinding, CarrierInteractionRef, CarrierKind, MediaHumanRouteReason, MediaParticipantIdentity, MediaSafetyRouteRequest, ProcessingMismatch, RecorderRef } from "../../protocol/call-binding.js";
import { IsoDateTime, OpaqueId } from "../../protocol/common.js";
import { AccessDeniedError, DependencyError } from "../../shared/errors.js";
import type { ConditionalKv, KvRecord } from "./ports.js";

export const CALL_RECORD_SCHEMA = "vsp.call-binding-record.v3";
export const CARRIER_INDEX_SCHEMA = "vsp.call-carrier-index.v2";
export const ROOM_CLAIM_SCHEMA = "vsp.call-room-claim.v1";
export const FIRST_BIND_LEASE_SCHEMA = "vsp.call-first-bind-lease.v1";
export const PERSON_REQUEST_SCHEMA = "vsp.call-person-request.v1";

const sha = (...parts: string[]): string => createHash("sha256").update(parts.join("\u0000"), "utf8").digest("hex");

export const callRecordKey = (tenantId: string, interactionId: string): string => `cbr#${sha("call-binding", tenantId, interactionId)}`;
export const carrierIndexKey = (tenantId: string, kind: string, interactionRef: string): string => `cbx#${sha("carrier-index", tenantId, kind, interactionRef)}`;
export const roomClaimKey = (tenantId: string, roomSid: string): string => `cbm#${sha("room-claim", tenantId, roomSid)}`;
export const firstBindLeaseKey = (tenantId: string, interactionId: string): string => `cbl#${sha("first-bind", tenantId, interactionId)}`;
export const personRequestKey = (tenantId: string, roomSid: string): string => `cbp#${sha("person-request", tenantId, roomSid)}`;

const Base64 = z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/).max(4096);
const SealedSession = z.strictObject({ ciphertext: Base64, iv: Base64, tag: Base64, keyId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/) });
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const RoomSid = CarrierInteractionRef;
const CarrierShape = z.strictObject({ kind: CarrierKind, interactionRef: CarrierInteractionRef, routeRef: z.string().regex(/^[A-Za-z0-9_:./-]{3,128}$/).nullable() });
const RuntimeDecline = z.strictObject({ decision: z.enum(["DECLINED", "REVOKED"]), capturedVia: z.enum(["dtmf_menu", "speech_intent"]), at: IsoDateTime }).nullable();

const HistoryEntry = z.strictObject({
  bindingId: z.string().regex(/^cbd_[A-Za-z0-9_-]{16,64}$/),
  sessionGeneration: z.number().int().min(1),
  fencingToken: z.number().int().min(1),
  state: z.enum(["ACTIVE", "SUPERSEDED", "ENDED", "REVOKED"]),
  instanceRef: z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/),
  at: IsoDateTime,
});

export const CallRecordData = z.strictObject({
  schema: z.literal(CALL_RECORD_SCHEMA),
  tenantId: OpaqueId,
  interactionId: OpaqueId,
  carrier: CarrierShape,
  /**
   * The one room this call lives in, pinned at the first bind: the room's server id and the sha256 of its name (a SIP
   * dispatch room name can carry the caller number, so the name is never stored). A bind from any other room is
   * refused (BINDING_ROOM_MISMATCH).
   */
  room: z.strictObject({ sid: RoomSid, nameDigest: Digest }),
  /** sha256 of the SIP participant whose call id names the call (null for a WebRTC call); it must still be there on a re-bind. */
  carrierParty: Digest.nullable(),
  jobRef: AgentJobRef,
  agentIdentity: MediaParticipantIdentity,
  binding: CallBinding,
  sealedSession: SealedSession,
  /** Monotonic consent version of the processing directive (DATA-03). */
  consentVersion: z.number().int().min(1).max(1_000_000),
  /** Digest of the effective consent the current version was computed from. */
  consentDigest: Digest,
  /** Highest consent version answered to the current owner (a readout below it, built after the owner was told, is stale). */
  deliveredConsentVersion: z.number().int().min(1).max(1_000_000),
  /** Decreases the caller made on the media path; they outrank the session's stored consent. */
  runtimeDeclines: z.strictObject({ recording: RuntimeDecline, transcriptionAiProcessing: RuntimeDecline }),
  lastMismatch: z.strictObject({ mismatch: ProcessingMismatch, at: IsoDateTime }).nullable(),
  ended: z.boolean(),
  history: z.array(HistoryEntry).max(16),
  /**
   * Evidence of the CURRENT binding's issuance (or recovery) event (OPS-01): PENDING while the request that issued it
   * writes the event (until `untilMs`), WRITTEN once it is durable, MISSING when the write failed (that request was
   * refused AUDIT_UNAVAILABLE). The owner's retry writes a MISSING event (or a PENDING one whose writer died) before it
   * is answered, and is refused retryably while the writer may still be writing; so the event is written exactly once
   * in every interleaving of a request and its retry, and a retry never turns an unaudited issuance into a held binding.
   */
  issuanceAudit: z.strictObject({ state: z.enum(["PENDING", "WRITTEN", "MISSING"]), untilMs: z.number().int().min(0) }),
  /** The recorders (egress ids) each binding of the call reported as its own (newest last); the adoptable set after an owner loss. */
  recorders: z.array(z.strictObject({ bindingId: z.string().regex(/^cbd_[A-Za-z0-9_-]{16,64}$/), egressId: RecorderRef })).max(32),
});
export type CallRecordData = z.infer<typeof CallRecordData>;
export type BindingHistoryEntry = z.infer<typeof HistoryEntry>;

const CarrierIndexData = z.strictObject({ schema: z.literal(CARRIER_INDEX_SCHEMA), tenantId: OpaqueId, interactionId: OpaqueId, roomSid: RoomSid });

export const RoomClaim = z.strictObject({
  schema: z.literal(ROOM_CLAIM_SCHEMA),
  tenantId: OpaqueId,
  roomSid: RoomSid,
  interactionId: OpaqueId,
  carrier: CarrierShape,
  carrierParty: Digest.nullable(),
});
export type RoomClaim = z.infer<typeof RoomClaim>;

const FirstBindLease = z.strictObject({
  schema: z.literal(FIRST_BIND_LEASE_SCHEMA),
  tenantId: OpaqueId,
  interactionId: OpaqueId,
  holder: z.string().regex(/^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{8,64}$/),
  untilMs: z.number().int().min(0),
});

const SafetySignal = MediaSafetyRouteRequest.shape.signals.element;
const Language = z.string().regex(/^[a-z]{2,3}(-[A-Z]{2})?$/);
const RequestState = z.enum(["OUTSTANDING", "ACCEPTED"]);
const Handoff = z.strictObject({ handoffId: OpaqueId.nullable(), destinationId: z.string().regex(/^dst_[a-z0-9_]{2,40}$/), speechTemplateId: z.string().regex(/^[a-z][a-z0-9_.]{2,80}$/) });
/**
 * The handoff attempt in flight for a request: which request holds it and until when. Another request for the room
 * meanwhile is answered "in progress" instead of a second handoff; an attempt whose holder died lapses at `untilMs`.
 */
const Attempt = z.strictObject({ holder: z.string().regex(/^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{8,64}$/), untilMs: z.number().int().min(0) });
export type PersonAttempt = z.infer<typeof Attempt>;

/**
 * A room's person request. `standard` is the request for a person (the caller asked, a consent alternative, a
 * mismatch, a runtime that cannot hold the call, the supervisor's recovery deadline), `safety` the safety route with its
 * deterministic signals (rule ids, never the caller's words). OUTSTANDING: requested, no handoff accepted yet (it is
 * retried, by the runtime or by the supervisor, until one is); ACCEPTED: the handoff service accepted it.
 */
export const PersonRequest = z.strictObject({
  schema: z.literal(PERSON_REQUEST_SCHEMA),
  tenantId: OpaqueId,
  roomSid: RoomSid,
  /** The platform interaction the requests were made under (the room's claim, or a fresh one when the room's carrier could not be named). */
  interactionId: OpaqueId,
  standard: z
    .strictObject({ state: RequestState, reason: MediaHumanRouteReason, language: Language, requestedAt: IsoDateTime, attempts: z.number().int().min(1).max(100_000), handoff: Handoff.nullable(), acceptedAt: IsoDateTime.nullable(), attempt: Attempt.nullable().optional() })
    .nullable(),
  safety: z
    .strictObject({ state: RequestState, signals: z.array(SafetySignal).min(1).max(8), locale: z.string().regex(/^[a-z]{2}-[A-Z]{2}$/), requestedAt: IsoDateTime, attempts: z.number().int().min(1).max(100_000), handoff: Handoff.nullable(), acceptedAt: IsoDateTime.nullable(), attempt: Attempt.nullable().optional() })
    .nullable(),
});
export type PersonRequest = z.infer<typeof PersonRequest>;

/** What a room's person request means for the AI runtime: NONE (it may hold the call), OUTSTANDING (a person is owed), WITH_PERSON. */
export type PersonState = "NONE" | "OUTSTANDING" | "WITH_PERSON";

/** The room's state for the runtime and the supervisor: a safety route still owed outranks an accepted standard handoff. */
export function personStateOf(r: PersonRequest | null): PersonState {
  if (!r || (r.standard === null && r.safety === null)) return "NONE";
  if (r.safety?.state === "OUTSTANDING") return "OUTSTANDING";
  if (r.safety?.state === "ACCEPTED") return "WITH_PERSON";
  return r.standard?.state === "OUTSTANDING" ? "OUTSTANDING" : "WITH_PERSON";
}

/** A first-bind lease request: the holder (one bind request) and how long it may take to create the first record. */
export interface FirstBindLeaseInput {
  tenantId: string;
  interactionId: string;
  holder: string;
  nowMs: number;
  leaseMs: number;
}

/** The carrier a room is claimed for, as the binding service derived it from the room facts. */
export interface RoomClaimInput {
  tenantId: string;
  roomSid: string;
  carrier: { kind: CarrierKind; interactionRef: string; routeRef: string | null };
  carrierParty: string | null;
  /** Interaction id used when this is the first claim of the carrier. */
  candidateInteractionId: string;
  ttlEpochSeconds: number;
}

export interface StoredCallRecord {
  version: number;
  data: CallRecordData;
}

/** Grace kept after a binding's expiry before the TTL attribute lets DynamoDB clean the record up (evidence for recovery and audit). */
export const RECORD_RETENTION_GRACE_SECONDS = 86_400;

const epoch = (iso: string): number => Math.floor(Date.parse(iso) / 1000);

export class CallBindingStore {
  constructor(private readonly kv: ConditionalKv) {}

  get kind(): "local_fixture" | "live" {
    return this.kv.kind;
  }

  /** The claim of a room (by its server id), or null when nothing has touched the room yet. A claim of another tenant or room is refused. */
  async roomClaim(tenantId: string, roomSid: string): Promise<RoomClaim | null> {
    const item = await this.kv.get<unknown>(roomClaimKey(tenantId, roomSid));
    if (!item) return null;
    const parsed = RoomClaim.safeParse(item.data);
    if (!parsed.success || parsed.data.tenantId !== tenantId || parsed.data.roomSid !== roomSid) throw new DependencyError("CALL_ROOM_CLAIM_INVALID", "FAILED", false);
    return parsed.data;
  }

  /**
   * Claims a room for its call, once (race-safe: the first writer wins): the room keeps the interaction, carrier and
   * carrier party of its first claim for good. The carrier is claimed for this room too; a carrier interaction
   * already claimed by ANOTHER room is refused (BINDING_ROOM_MISMATCH): one carrier interaction never names two rooms.
   */
  async claimRoom(i: RoomClaimInput): Promise<RoomClaim> {
    const existing = await this.roomClaim(i.tenantId, i.roomSid);
    if (existing) return existing;
    const interactionId = await this.claimCarrier(i);
    const data = RoomClaim.parse({ schema: ROOM_CLAIM_SCHEMA, tenantId: i.tenantId, roomSid: i.roomSid, interactionId, carrier: i.carrier, carrierParty: i.carrierParty });
    if (await this.kv.putIfAbsent({ pk: roomClaimKey(i.tenantId, i.roomSid), version: 1, ttlEpochSeconds: i.ttlEpochSeconds, data })) return data;
    const raced = await this.roomClaim(i.tenantId, i.roomSid);
    if (!raced) throw new DependencyError("CALL_ROOM_CLAIM_CONFLICT", "FAILED", true);
    return raced;
  }

  /** Platform interaction id of a carrier interaction for this room, creating it once; another room's carrier is refused. */
  private async claimCarrier(i: RoomClaimInput): Promise<string> {
    const pk = carrierIndexKey(i.tenantId, i.carrier.kind, i.carrier.interactionRef);
    for (let attempt = 0; attempt < 3; attempt++) {
      const existing = await this.kv.get<unknown>(pk);
      if (existing) {
        const parsed = CarrierIndexData.safeParse(existing.data);
        if (!parsed.success || parsed.data.tenantId !== i.tenantId) throw new DependencyError("CALL_CARRIER_INDEX_INVALID", "FAILED", false);
        if (parsed.data.roomSid !== i.roomSid) throw new AccessDeniedError("BINDING_ROOM_MISMATCH");
        return parsed.data.interactionId;
      }
      const data = CarrierIndexData.parse({ schema: CARRIER_INDEX_SCHEMA, tenantId: i.tenantId, interactionId: i.candidateInteractionId, roomSid: i.roomSid });
      if (await this.kv.putIfAbsent({ pk, version: 1, ttlEpochSeconds: i.ttlEpochSeconds, data })) return i.candidateInteractionId;
    }
    throw new DependencyError("CALL_CARRIER_INDEX_CONFLICT", "FAILED", true);
  }

  /**
   * Takes the call's first-bind lease; true when this request now holds it. A lease held by another request is
   * refused until its time passed (its holder died before creating the record), then taken over by compare-and-swap.
   * A lease of another tenant or interaction under this key is refused (fail closed).
   */
  async takeFirstBindLease(i: FirstBindLeaseInput): Promise<boolean> {
    const pk = firstBindLeaseKey(i.tenantId, i.interactionId);
    const data = FirstBindLease.parse({ schema: FIRST_BIND_LEASE_SCHEMA, tenantId: i.tenantId, interactionId: i.interactionId, holder: i.holder, untilMs: i.nowMs + i.leaseMs });
    const ttl = Math.floor(data.untilMs / 1000) + RECORD_RETENTION_GRACE_SECONDS;
    const existing = await this.kv.get<unknown>(pk);
    if (!existing) return this.kv.putIfAbsent({ pk, version: 1, ttlEpochSeconds: ttl, data });
    const parsed = FirstBindLease.safeParse(existing.data);
    if (!parsed.success || parsed.data.tenantId !== i.tenantId || parsed.data.interactionId !== i.interactionId) throw new DependencyError("CALL_FIRST_BIND_LEASE_INVALID", "FAILED", false);
    if (parsed.data.untilMs > i.nowMs) return false;
    return this.kv.compareAndSwap(pk, existing.version, data, ttl);
  }

  /** Gives the lease up early (its holder failed before creating the record); a lease another request took over is left alone. */
  async releaseFirstBindLease(tenantId: string, interactionId: string, holder: string): Promise<void> {
    const pk = firstBindLeaseKey(tenantId, interactionId);
    const existing = await this.kv.get<unknown>(pk);
    const parsed = existing ? FirstBindLease.safeParse(existing.data) : null;
    if (!existing || !parsed?.success || parsed.data.holder !== holder || parsed.data.tenantId !== tenantId || parsed.data.interactionId !== interactionId) return;
    await this.kv.compareAndSwap(pk, existing.version, { ...parsed.data, untilMs: 0 }, Math.floor(parsed.data.untilMs / 1000) + RECORD_RETENTION_GRACE_SECONDS);
  }

  /** The room's person request (by its server id), or null when nobody asked for a person in this room. */
  async personRequest(tenantId: string, roomSid: string): Promise<PersonRequest | null> {
    return (await this.personRequestItem(tenantId, roomSid))?.data ?? null;
  }

  /**
   * Applies `change` to the room's person request (creating it on the first request) by compare-and-swap: concurrent
   * requests of one room (the runtime, its replacement, the supervisor) never lose each other's update. `change`
   * returns the next request, or the current one unchanged (nothing is written then).
   */
  async updatePersonRequest(tenantId: string, roomSid: string, change: (current: PersonRequest | null) => PersonRequest, ttlEpochSeconds: number): Promise<PersonRequest> {
    const pk = personRequestKey(tenantId, roomSid);
    for (let attempt = 0; attempt < 4; attempt++) {
      const item = await this.personRequestItem(tenantId, roomSid);
      const next = PersonRequest.parse(change(item?.data ?? null));
      if (next.tenantId !== tenantId || next.roomSid !== roomSid) throw new DependencyError("CALL_PERSON_REQUEST_INVALID", "FAILED", false);
      if (item && JSON.stringify(next) === JSON.stringify(item.data)) return item.data;
      const ok = item ? await this.kv.compareAndSwap(pk, item.version, next, ttlEpochSeconds) : await this.kv.putIfAbsent({ pk, version: 1, ttlEpochSeconds, data: next });
      if (ok) return next;
    }
    throw new DependencyError("CALL_PERSON_REQUEST_CONFLICT", "FAILED", true);
  }

  private async personRequestItem(tenantId: string, roomSid: string): Promise<{ version: number; data: PersonRequest } | null> {
    const item = await this.kv.get<unknown>(personRequestKey(tenantId, roomSid));
    if (!item) return null;
    const parsed = PersonRequest.safeParse(item.data);
    // A request of another tenant or room under this key, or one that does not parse, is never used (fail closed).
    if (!parsed.success || parsed.data.tenantId !== tenantId || parsed.data.roomSid !== roomSid) throw new DependencyError("CALL_PERSON_REQUEST_INVALID", "FAILED", false);
    return { version: item.version, data: parsed.data };
  }

  async load(tenantId: string, interactionId: string): Promise<StoredCallRecord | null> {
    const item = await this.kv.get<unknown>(callRecordKey(tenantId, interactionId));
    if (!item) return null;
    const parsed = CallRecordData.safeParse(item.data);
    // A record of another tenant or interaction under this key, or one that does not parse, is never used.
    if (!parsed.success || parsed.data.tenantId !== tenantId || parsed.data.interactionId !== interactionId) {
      throw new DependencyError("CALL_RECORD_INVALID", "FAILED", false);
    }
    return { version: item.version, data: parsed.data };
  }

  /** Creates the first record of a call; false when another writer created it first. */
  async create(data: CallRecordData): Promise<boolean> {
    const checked = CallRecordData.parse(data);
    const item: KvRecord<CallRecordData> = { pk: callRecordKey(checked.tenantId, checked.interactionId), version: 1, ttlEpochSeconds: this.ttlOf(checked), data: checked };
    return this.kv.putIfAbsent(item);
  }

  /** Replaces the record only when it is still at `expectedVersion`; false on a concurrent change. */
  async replace(expectedVersion: number, data: CallRecordData): Promise<boolean> {
    const checked = CallRecordData.parse(data);
    return this.kv.compareAndSwap(callRecordKey(checked.tenantId, checked.interactionId), expectedVersion, checked, this.ttlOf(checked));
  }

  private ttlOf(d: CallRecordData): number {
    return epoch(d.binding.expiresAt) + RECORD_RETENTION_GRACE_SECONDS;
  }
}
