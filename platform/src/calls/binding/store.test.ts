/**
 * CallBindingStore over a LOCAL FIXTURE conditional KV (MemoryKvStoreFixture; the Layer-2 media suite runs the same
 * store on DynamoDB Local) (WP-11; FO-05-16, AUTH-03, AUTH-04).
 *
 * The store refuses (fail closed) anything under a key that is not what the key promises: a call record or a room
 * claim of another tenant, room or interaction, a carrier index entry of another tenant, and a carrier reference
 * already claimed by another room. The first-bind lease is held by one request at a time until it runs out.
 */
import { describe, expect, it } from "vitest";
import { MemoryKvStoreFixture } from "../../identity/kv/memory-kv-store.js";
import { CALL_RECORD_SCHEMA, CallBindingStore, FIRST_BIND_LEASE_SCHEMA, PERSON_REQUEST_SCHEMA, ROOM_CLAIM_SCHEMA, callRecordKey, carrierIndexKey, firstBindLeaseKey, personRequestKey, personStateOf, roomClaimKey } from "./store.js";
import type { CallRecordData, PersonRequest } from "./store.js";

const TENANT = "tnt_synthTenantMedia0001";
const OTHER = "tnt_synthTenantOther0001";
const T0 = "2026-10-21T12:00:00.000Z";
const TTL = Math.floor(Date.parse(T0) / 1000) + 86_400;
const carrier = { kind: "sip_reference" as const, interactionRef: "SCL_synthStore0001", routeRef: null };
const digest = (c: string) => c.repeat(64);

function record(o: Partial<CallRecordData> = {}): CallRecordData {
  return {
    schema: CALL_RECORD_SCHEMA,
    tenantId: TENANT,
    interactionId: "int_synthStoreCall0001",
    carrier,
    room: { sid: "RM_synthStoreRoom01", nameDigest: digest("a") },
    carrierParty: digest("b"),
    jobRef: "AJ_synthStoreJob01",
    agentIdentity: "agent-AJ_synthStoreJob01",
    binding: {
      schemaVersion: "call-binding.v1",
      tenantId: TENANT,
      interactionId: "int_synthStoreCall0001",
      sessionGeneration: 1,
      occurredAt: T0,
      expiresAt: "2026-10-21T12:01:30.000Z",
      causationId: null,
      bindingId: "cbd_synthStoreBinding0001",
      carrier,
      owner: { adapter: "controlled_cascade_runtime", instanceRef: "media-worker-a1", fencingToken: 1 },
      sessionBindingRef: `ses_bnd_${"A".repeat(43)}`,
      boundBy: "trusted_server_lookup",
      state: "ACTIVE",
      supersedesBindingId: null,
    },
    sealedSession: { ciphertext: "AAAA", iv: "AAAA", tag: "AAAA", keyId: "k1" },
    consentVersion: 1,
    consentDigest: digest("c"),
    deliveredConsentVersion: 1,
    runtimeDeclines: { recording: null, transcriptionAiProcessing: null },
    lastMismatch: null,
    ended: false,
    history: [],
    issuanceAudit: { state: "WRITTEN", untilMs: 0 },
    recorders: [],
    ...o,
  };
}

const claimInput = (roomSid: string, candidate = "int_synthStoreCall0001") => ({ tenantId: TENANT, roomSid, carrier, carrierParty: digest("b"), candidateInteractionId: candidate, ttlEpochSeconds: TTL });

describe("CallBindingStore [AUTH-03][FO-05-16]", () => {
  it("round trip: a call record is created once and replaced only at its version", async () => {
    const store = new CallBindingStore(new MemoryKvStoreFixture());
    expect(await store.create(record())).toBe(true);
    expect(await store.create(record())).toBe(false);
    const loaded = await store.load(TENANT, "int_synthStoreCall0001");
    expect(loaded?.version).toBe(1);
    expect(await store.replace(1, { ...record(), consentVersion: 2 })).toBe(true);
    expect(await store.replace(1, { ...record(), consentVersion: 3 })).toBe(false);
    expect((await store.load(TENANT, "int_synthStoreCall0001"))?.data.consentVersion).toBe(2);
  });

  it("[AUTH-03] adversarial: a record of another tenant or interaction copied under this call's key is refused, never used", async () => {
    const kv = new MemoryKvStoreFixture();
    const store = new CallBindingStore(kv);
    await kv.putIfAbsent({ pk: callRecordKey(TENANT, "int_synthStoreCall0001"), version: 1, ttlEpochSeconds: TTL, data: record({ tenantId: OTHER }) });
    await expect(store.load(TENANT, "int_synthStoreCall0001")).rejects.toMatchObject({ reasonCode: "CALL_RECORD_INVALID" });
    await kv.putIfAbsent({ pk: callRecordKey(TENANT, "int_synthStoreCall0002"), version: 1, ttlEpochSeconds: TTL, data: record() });
    await expect(store.load(TENANT, "int_synthStoreCall0002")).rejects.toMatchObject({ reasonCode: "CALL_RECORD_INVALID" });
    await kv.putIfAbsent({ pk: callRecordKey(TENANT, "int_synthStoreCall0003"), version: 1, ttlEpochSeconds: TTL, data: { junk: true } });
    await expect(store.load(TENANT, "int_synthStoreCall0003")).rejects.toMatchObject({ reasonCode: "CALL_RECORD_INVALID" });
  });

  it("[FO-05-16] a room is claimed once; the carrier reference names that room only, and another room carrying it is refused", async () => {
    const store = new CallBindingStore(new MemoryKvStoreFixture());
    const first = await store.claimRoom(claimInput("RM_synthStoreRoom01"));
    expect(first).toMatchObject({ schema: ROOM_CLAIM_SCHEMA, roomSid: "RM_synthStoreRoom01", interactionId: "int_synthStoreCall0001", carrier, carrierParty: digest("b") });
    // A second claim of the same room keeps the first claim (whatever the second one derived).
    const again = await store.claimRoom({ ...claimInput("RM_synthStoreRoom01", "int_synthStoreCall0099"), carrierParty: digest("d") });
    expect(again).toEqual(first);
    // Another room with the same carrier reference (a minted SIP-kind participant with a copied sip.callID).
    await expect(store.claimRoom(claimInput("RM_synthStoreRoom02", "int_synthStoreCall0098"))).rejects.toMatchObject({ reasonCode: "BINDING_ROOM_MISMATCH" });
    expect(await store.roomClaim(TENANT, "RM_synthStoreRoom02")).toBeNull();
  });

  it("concurrent first claims of one room agree on one interaction", async () => {
    const store = new CallBindingStore(new MemoryKvStoreFixture());
    const [a, b] = await Promise.all([store.claimRoom(claimInput("RM_synthStoreRoom03", "int_synthStoreRaceA001")), store.claimRoom(claimInput("RM_synthStoreRoom03", "int_synthStoreRaceB001"))]);
    expect(a.interactionId).toBe(b.interactionId);
  });

  it("[AUTH-03] adversarial: a room claim or carrier index of another tenant or room under this key is refused (fail closed)", async () => {
    const kv = new MemoryKvStoreFixture();
    const store = new CallBindingStore(kv);
    const foreign = { schema: ROOM_CLAIM_SCHEMA, tenantId: OTHER, roomSid: "RM_synthStoreRoom04", interactionId: "int_synthStoreCall0004", carrier, carrierParty: null };
    await kv.putIfAbsent({ pk: roomClaimKey(TENANT, "RM_synthStoreRoom04"), version: 1, ttlEpochSeconds: TTL, data: foreign });
    await expect(store.roomClaim(TENANT, "RM_synthStoreRoom04")).rejects.toMatchObject({ reasonCode: "CALL_ROOM_CLAIM_INVALID" });
    await kv.putIfAbsent({ pk: roomClaimKey(TENANT, "RM_synthStoreRoom05"), version: 1, ttlEpochSeconds: TTL, data: { ...foreign, tenantId: TENANT } });
    await expect(store.roomClaim(TENANT, "RM_synthStoreRoom05")).rejects.toMatchObject({ reasonCode: "CALL_ROOM_CLAIM_INVALID" });
    await kv.putIfAbsent({ pk: carrierIndexKey(TENANT, "sip_reference", "SCL_synthStore0006"), version: 1, ttlEpochSeconds: TTL, data: { schema: "vsp.call-carrier-index.v2", tenantId: OTHER, interactionId: "int_synthStoreCall0006", roomSid: "RM_synthStoreRoom06" } });
    await expect(store.claimRoom({ ...claimInput("RM_synthStoreRoom06"), carrier: { ...carrier, interactionRef: "SCL_synthStore0006" } })).rejects.toMatchObject({ reasonCode: "CALL_CARRIER_INDEX_INVALID" });
  });

  it("[AUTH-03] the first-bind lease: one holder at a time (concurrent takers agree on one), taken over only once it ran out, released early only by its holder", async () => {
    const store = new CallBindingStore(new MemoryKvStoreFixture());
    const lease = (holder: string, nowMs: number) => ({ tenantId: TENANT, interactionId: "int_synthStoreCall0007", holder, nowMs, leaseMs: 15_000 });
    const raced = await Promise.all([store.takeFirstBindLease(lease("cbl_synthHolderA0001", 0)), store.takeFirstBindLease(lease("cbl_synthHolderB0001", 0))]);
    expect(raced.filter(Boolean)).toHaveLength(1);
    const holder = raced[0] ? "cbl_synthHolderA0001" : "cbl_synthHolderB0001";
    expect(await store.takeFirstBindLease(lease("cbl_synthHolderC0001", 14_999))).toBe(false);
    // Somebody else's release leaves the lease alone; the holder's own release frees it at once.
    await store.releaseFirstBindLease(TENANT, "int_synthStoreCall0007", "cbl_synthHolderC0001");
    expect(await store.takeFirstBindLease(lease("cbl_synthHolderC0001", 1_000))).toBe(false);
    await store.releaseFirstBindLease(TENANT, "int_synthStoreCall0007", holder);
    expect(await store.takeFirstBindLease(lease("cbl_synthHolderC0001", 1_000))).toBe(true);
    // A lease that ran out (its holder died before creating the record) is taken over, by one taker only.
    const later = await Promise.all([store.takeFirstBindLease(lease("cbl_synthHolderD0001", 16_000)), store.takeFirstBindLease(lease("cbl_synthHolderE0001", 16_000))]);
    expect(later.filter(Boolean)).toHaveLength(1);
  });

  it("[SAFE-02] the room's person request: concurrent requests of one room all land (compare-and-swap); its state for the runtime; another tenant's or room's request under this key is refused", async () => {
    const kv = new MemoryKvStoreFixture();
    const store = new CallBindingStore(kv);
    const empty: PersonRequest = { schema: PERSON_REQUEST_SCHEMA, tenantId: TENANT, roomSid: "RM_synthStoreRoom10", interactionId: "int_synthStoreCall0010", standard: null, safety: null };
    const bump = (cur: PersonRequest | null): PersonRequest => {
      const base = cur ?? empty;
      const s = base.standard;
      return { ...base, standard: s ? { ...s, attempts: s.attempts + 1 } : { state: "OUTSTANDING", reason: "CALLER_REQUESTED_HUMAN", language: "en", requestedAt: T0, attempts: 1, handoff: null, acceptedAt: null } };
    };
    await Promise.all([1, 2, 3].map(() => store.updatePersonRequest(TENANT, "RM_synthStoreRoom10", bump, TTL)));
    const got = await store.personRequest(TENANT, "RM_synthStoreRoom10");
    expect(got?.standard?.attempts).toBe(3);
    expect(personStateOf(null)).toBe("NONE");
    expect(personStateOf(got)).toBe("OUTSTANDING");
    const handoff = { handoffId: "hnd_synthHandoff000001", destinationId: "dst_support_general", speechTemplateId: "human.offer" };
    const accepted: PersonRequest = { ...(got as PersonRequest), standard: { ...(got?.standard as NonNullable<PersonRequest["standard"]>), state: "ACCEPTED", handoff, acceptedAt: T0 } };
    expect(personStateOf(accepted)).toBe("WITH_PERSON");
    const owedSafety: PersonRequest = { ...accepted, safety: { state: "OUTSTANDING", signals: [{ source: "EXPLICIT_PHRASE", ruleId: "safety.self_harm.explicit", strength: "CREDIBLE", subject: "SELF", temporal: "CURRENT", negated: false }], locale: "en-US", requestedAt: T0, attempts: 1, handoff: null, acceptedAt: null } };
    expect(personStateOf(owedSafety)).toBe("OUTSTANDING");
    expect(personStateOf({ ...owedSafety, safety: { ...(owedSafety.safety as NonNullable<PersonRequest["safety"]>), state: "ACCEPTED", handoff, acceptedAt: T0 } })).toBe("WITH_PERSON");
    // Fail closed: a request copied under another room's key, or of another tenant, is never used.
    await kv.putIfAbsent({ pk: personRequestKey(TENANT, "RM_synthStoreRoom11"), version: 1, ttlEpochSeconds: TTL, data: got });
    await expect(store.personRequest(TENANT, "RM_synthStoreRoom11")).rejects.toMatchObject({ reasonCode: "CALL_PERSON_REQUEST_INVALID" });
    await kv.putIfAbsent({ pk: personRequestKey(TENANT, "RM_synthStoreRoom12"), version: 1, ttlEpochSeconds: TTL, data: { ...empty, roomSid: "RM_synthStoreRoom12", tenantId: OTHER } });
    await expect(store.personRequest(TENANT, "RM_synthStoreRoom12")).rejects.toMatchObject({ reasonCode: "CALL_PERSON_REQUEST_INVALID" });
    await expect(store.updatePersonRequest(TENANT, "RM_synthStoreRoom13", () => ({ ...empty, roomSid: "RM_synthStoreRoom99" }), TTL)).rejects.toMatchObject({ reasonCode: "CALL_PERSON_REQUEST_INVALID" });
  });

  it("[AUTH-03] adversarial: a first-bind lease of another tenant or interaction under this key is refused (fail closed), never taken over", async () => {
    const kv = new MemoryKvStoreFixture();
    const store = new CallBindingStore(kv);
    const foreign = { schema: FIRST_BIND_LEASE_SCHEMA, tenantId: OTHER, interactionId: "int_synthStoreCall0008", holder: "cbl_synthHolderA0001", untilMs: 0 };
    await kv.putIfAbsent({ pk: firstBindLeaseKey(TENANT, "int_synthStoreCall0008"), version: 1, ttlEpochSeconds: TTL, data: foreign });
    const take = (interactionId: string) => store.takeFirstBindLease({ tenantId: TENANT, interactionId, holder: "cbl_synthHolderB0001", nowMs: 1_000, leaseMs: 15_000 });
    await expect(take("int_synthStoreCall0008")).rejects.toMatchObject({ reasonCode: "CALL_FIRST_BIND_LEASE_INVALID" });
    await kv.putIfAbsent({ pk: firstBindLeaseKey(TENANT, "int_synthStoreCall0009"), version: 1, ttlEpochSeconds: TTL, data: { ...foreign, tenantId: TENANT } });
    await expect(take("int_synthStoreCall0009")).rejects.toMatchObject({ reasonCode: "CALL_FIRST_BIND_LEASE_INVALID" });
  });
});
