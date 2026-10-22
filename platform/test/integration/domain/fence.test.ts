/**
 * Layer 2 (WP-23; ACT-03, FO-06-74, FO-06-75, FO-03-09, FO-00-13): commit latency after the final deadline check.
 *
 * The reference API's STALL_BEFORE_COMMIT seam holds a write's transaction open AFTER it passed its final deadline
 * check, so the write's COMMIT lands after the request's deadline: a stalled process, a slow fsync, a synchronous
 * replication wait or a network delay before the COMMIT reaches the database. No clock rule can prove absence
 * then (the change is invisible at the deadline, yet it commits). The platform decides absence only from the
 * system's fence, which waits on the request id's (or reference's) unique key for the transaction still in flight.
 * Each test asserts that, at the moment the platform decides, the write is NOT durable yet (no stored change, no
 * effect) and that the decision is never NOT_FOUND; then that the effect is reconciled exactly once. Effects come
 * from the system's append-only effect log; reach from the seam's hit counter. SYNTHETIC data only.
 */
import { afterAll, beforeAll, describe, expect } from "vitest";
import type { PrepareInput } from "../../../src/actions/ports.js";
import { actingPartyFor } from "../../../src/domain/authority.js";
import { requestIdFor } from "../../../src/domain/changes.js";
import type { CommitSubject } from "../../../src/domain/commit.js";
import { externalRefFor } from "../../../src/domain/legacy.js";
import { systemClock } from "../../../src/shared/clock.js";
import { createIntegrationDb } from "../_harness/clients.js";
import type { IntegrationDb } from "../_harness/clients.js";
import type { Layer2Context } from "../_harness/layer2.js";
import { layer2, layer2Context } from "../_harness/layer2.js";
import { ledgerReplica } from "../substrate/reference-sor.js";
import type { LedgerReplica } from "../substrate/reference-sor.js";
import { DOMAIN_SERVICES, allowDecision, createDomainPki, dtmfConfirmation, eventually, provisionTenant, seedWorld, sessionOf, sleep } from "./support.js";
import type { DomainPki, Tenant } from "./support.js";

const it = layer2(DOMAIN_SERVICES);

const WRITE_TIMEOUT_MS = 1_500;
/**
 * Tenants whose fence must ANSWER while the stalled write is still in flight: the fence waits on the id's unique key
 * until the stalled COMMIT lands, and it is a write bounded by the write timeout. A longer write timeout (3 s) and a
 * stall that ends about 0.6-1.4 s after the fence is sent keep that wait well inside the bound, whatever the latency
 * of the first requests (token, TLS) before the stall started.
 */
const ANSWERING_WRITE_TIMEOUT_MS = 3_000;
const ANSWERING_STALL_MS = 4_500;
const WINDOW_MS = 500;
const SKEW_MS = 250;

let l2: Layer2Context;
let pki: DomainPki;
let idb: IntegrationDb;
let ledger: LedgerReplica;
const tenants: Tenant[] = [];

beforeAll(async () => {
  l2 = layer2Context(DOMAIN_SERVICES);
  pki = createDomainPki();
  idb = await createIntegrationDb(l2);
  // Short preparations, so that "after the deadline" is reachable inside a test.
  ledger = ledgerReplica(idb.db, systemClock, "domain-fence", { minPrepareTtlSeconds: 5 });
}, 120_000);

afterAll(async () => {
  for (const t of tenants) await t.dispose();
  await idb?.drop();
  pki?.dispose();
});

async function tenant(systems: ("scheduling" | "legacy")[], writeTimeoutMs = WRITE_TIMEOUT_MS): Promise<Tenant> {
  const t = await provisionTenant(l2, pki, { systems, writeTimeoutMs, visibilityWindowMs: WINDOW_MS, clockSkewAllowanceMs: SKEW_MS });
  tenants.push(t);
  return t;
}

const settled = <T>(p: Promise<T>) =>
  p.then(
    (value) => ({ value, error: null as null | { outcome?: string; reasonCode?: string } }),
    (e: unknown) => ({ value: null, error: e as { outcome?: string; reasonCode?: string } }),
  );

const stallHits = async (t: Tenant, operation: string): Promise<number> => (await t.admin.faults(t.accountId)).find((f) => f.kind === "STALL_BEFORE_COMMIT" && f.operation === operation)?.hits ?? 0;

describe("commit latency after the final deadline check: absence only from the system's fence (Layer 2)", () => {
  it("[ACT-03][FO-06-74] domain port: a booking whose COMMIT lands after its deadline is invisible at deadline + skew, and the fence waits for it: COMMITTED, never NOT_FOUND, one effect", async () => {
    const t = await tenant(["scheduling"], ANSWERING_WRITE_TIMEOUT_MS);
    const w = await seedWorld(t);
    const port = t.adapters.commitPort;
    if (!port) throw new Error("commit port composed");
    const client = actingPartyFor(sessionOf(t.tenantId, w.client, "client"));
    const prep = await port.prepare(client, { kind: "appointment.create", slotId: w.slots[0] as string });
    const subject: CommitSubject = { kind: "appointment.create", subjectId: w.client, target: prep.input.target, change: prep.input.change, expiresAt: new Date(Date.now() + 300).toISOString() };
    const deadlineMs = Date.parse(subject.expiresAt) + ANSWERING_WRITE_TIMEOUT_MS;
    const key = `vsp-${"f1".repeat(24)}`;
    const rid = requestIdFor(key);
    // The write passes its final deadline check at once, then its transaction stays open 4.5 s before COMMIT.
    await t.admin.arm(t.accountId, { operation: "scheduling.booking.put", kind: "STALL_BEFORE_COMMIT", delayMs: ANSWERING_STALL_MS, times: 1 });
    const commit = await settled(port.commit(subject, key));
    expect(commit.error).toMatchObject({ outcome: "UNKNOWN" });
    expect(await stallHits(t, "scheduling.booking.put")).toBe(1);
    // Past the deadline + skew the change is not durable: nothing stored under the id, no effect.
    await sleep(Math.max(0, deadlineMs + SKEW_MS + 50 - Date.now()));
    expect(Date.now()).toBeGreaterThan(deadlineMs + SKEW_MS);
    expect(await t.admin.changeRequest(t.accountId, rid)).toBeNull();
    expect((await t.admin.effects(t.accountId)).filter((e) => e.requestId === rid)).toHaveLength(0);
    // The decision: the fence waits on the id for the transaction still in flight and answers its change.
    const decision = await port.reconcileDecision(subject, key);
    expect(decision.outcome).not.toBe("NOT_FOUND");
    expect(decision.outcome).toBe("COMMITTED");
    expect((await t.admin.requests(t.accountId)).filter((r) => r.operation === "change_requests.fence" && r.keyRef === rid).map((r) => r.status)).toEqual([200]);
    // The late COMMIT is the one effect; every later answer agrees.
    expect((await t.admin.effects(t.accountId)).filter((e) => e.requestId === rid)).toHaveLength(1);
    expect(await t.admin.changeRequest(t.accountId, rid)).toMatchObject({ state: "COMPLETED" });
    expect((await t.adapters.scheduling?.slot(w.slots[0] as string))?.state).toBe("BOOKED");
    expect((await port.lookup(subject, key)).outcome).toBe("COMMITTED");
    await t.admin.clearFaults(t.accountId);
  });

  it("[ACT-03][FO-03-09][FO-00-13] through the production action executor: a reconciliation while the stalled COMMIT is still pending is inconclusive, never NOT_FOUND / EXPIRED; once it lands the ledger records COMMITTED with the system's receipt", async () => {
    const t = await tenant(["scheduling"]);
    const w = await seedWorld(t);
    const port = t.adapters.commitPort;
    if (!port) throw new Error("commit port composed");
    const ctx = sessionOf(t.tenantId, w.client, "client");
    const prep = await port.prepare(actingPartyFor(ctx), { kind: "appointment.create", slotId: w.slots[1] as string });
    const prepared = await ledger.service.prepare(ctx, { ...prep.input, kind: "appointment.create", ttlSeconds: 5 } as PrepareInput, allowDecision());
    const { confirmation, integration } = dtmfConfirmation(ctx, prepared);
    const action = await ledger.service.confirm(confirmation, integration);
    const deadlineMs = Date.parse(action.expiresAt) + WRITE_TIMEOUT_MS;
    await sleep(Math.max(0, Date.parse(action.expiresAt) - Date.now() - 400));
    // Longer than the fence's own timeout: the fence asked at deadline + skew cannot answer before the COMMIT lands.
    await t.admin.arm(t.accountId, { operation: "scheduling.booking.put", kind: "STALL_BEFORE_COMMIT", delayMs: 4_500, times: 1 });
    const first = await ledger.service.commit(ctx, { actionId: action.actionId, digest: action.digest }, { reauthorize: async () => allowDecision(), provider: port });
    expect(first.outcome).toBe("UNKNOWN");
    expect(await stallHits(t, "scheduling.booking.put")).toBe(1);
    const key = (await ledger.service.describe?.(t.tenantId, action.actionId))?.providerIdempotencyKey ?? "";
    const rid = requestIdFor(key);
    await sleep(Math.max(0, deadlineMs + SKEW_MS + 50 - Date.now()));
    expect(await t.admin.changeRequest(t.accountId, rid)).toBeNull();
    const early = await ledger.service.reconcileWithResult?.(t.tenantId, action.actionId, port);
    expect(early?.result).not.toBe("NOT_FOUND");
    expect((await ledger.service.describe?.(t.tenantId, action.actionId))?.state).not.toBe("EXPIRED");
    // The stalled transaction commits after the deadline: the change exists, and the ledger reconciles it.
    await eventually(async () => (await t.admin.changeRequest(t.accountId, rid))?.state === "COMPLETED", 8_000);
    const late = await ledger.service.reconcileWithResult?.(t.tenantId, action.actionId, port);
    expect(late?.result).toBe("COMMITTED");
    const entry = await ledger.service.describe?.(t.tenantId, action.actionId);
    expect(entry?.state).toBe("COMMITTED");
    expect(entry?.receipt?.providerReference).toBe((await t.admin.changeRequest(t.accountId, rid))?.receipt_id);
    expect((await t.admin.effects(t.accountId)).filter((e) => e.requestId === rid)).toHaveLength(1);
    await t.admin.clearFaults(t.accountId);
  });

  it("[ACT-03][FO-06-75] legacy: a create whose COMMIT lands after its deadline is never declared absent: the reference fence waits for it (POSTED, UNKNOWN), then exactly one appointment reconciles COMMITTED", async () => {
    const t = await tenant(["legacy"], ANSWERING_WRITE_TIMEOUT_MS);
    const w = await seedWorld(t);
    const legacy = t.adapters.legacyScheduling;
    if (!legacy) throw new Error("legacy composed");
    const party = actingPartyFor(sessionOf(t.tenantId, w.client, "client"));
    const prep = legacy.prepareCreate(party, { providerRef: w.provider, startsAt: new Date(Date.now() + 6 * 86_400_000).toISOString().slice(0, 16) + ":00.000Z", modality: "video" });
    const subject = { kind: "appointment.create" as const, subjectId: w.client, target: prep.target, change: prep.change, expiresAt: new Date(Date.now() + 300).toISOString() };
    const deadlineMs = Date.parse(subject.expiresAt) + ANSWERING_WRITE_TIMEOUT_MS;
    const key = `vsp-${"f3".repeat(24)}`;
    const ref = externalRefFor(key);
    const created = async () => (await t.admin.effects(t.accountId)).filter((e) => e.operation === "legacy.appointment.post").length;
    await t.admin.arm(t.accountId, { operation: "legacy.appointment.post", kind: "STALL_BEFORE_COMMIT", delayMs: ANSWERING_STALL_MS, times: 1 });
    const commit = await settled(legacy.commit(subject, key));
    expect(commit.error).toMatchObject({ outcome: "UNKNOWN" });
    expect(await stallHits(t, "legacy.appointment.post")).toBe(1);
    await sleep(Math.max(0, deadlineMs + SKEW_MS + 50 - Date.now()));
    // At the decision the create is not durable: the reference is still only reserved, nothing created.
    expect(await created()).toBe(0);
    expect(await t.admin.legacyReference(t.accountId, ref)).toMatchObject({ state: "RESERVED" });
    expect(await legacy.lookup(subject, key)).toEqual({ outcome: "UNKNOWN" });
    expect((await t.admin.requests(t.accountId)).filter((r) => r.operation === "legacy.reference.fence").map((r) => r.status)).toEqual([200]);
    // The fence waited for the create's transaction: the reference is POSTED, never fenced over a committed create.
    expect(await t.admin.legacyReference(t.accountId, ref)).toMatchObject({ state: "POSTED" });
    expect(await created()).toBe(1);
    await sleep(WINDOW_MS + 300);
    expect((await legacy.lookup(subject, key)).outcome).toBe("COMMITTED");
    expect(await legacy.byReference(ref)).toHaveLength(1);
    // Exactly one create was ever processed for the reference (the request log misses a response the client
    // abandoned, so the system's effect log and the seam's hit counter are the evidence).
    expect(await created()).toBe(1);
    expect(await stallHits(t, "legacy.appointment.post")).toBe(1);
    await t.admin.clearFaults(t.accountId);
  });

  it("[ACT-03][FO-06-74] the fence before the deadline changes nothing (409, UNKNOWN); after it, a reference never used is FENCED and a later create under it is refused, nothing created", async () => {
    const t = await tenant(["legacy"]);
    const w = await seedWorld(t);
    const legacy = t.adapters.legacyScheduling;
    if (!legacy) throw new Error("legacy composed");
    const party = actingPartyFor(sessionOf(t.tenantId, w.client, "client"));
    const prep = legacy.prepareCreate(party, { providerRef: w.provider, startsAt: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 16) + ":00.000Z", modality: "phone" });
    const key = `vsp-${"f4".repeat(24)}`;
    const ref = externalRefFor(key);
    const fresh = { kind: "appointment.create" as const, subjectId: w.client, target: prep.target, change: prep.change, expiresAt: new Date(Date.now() + 120_000).toISOString() };
    // Before the deadline the platform does not even ask; a direct early fence is refused by the product's clock.
    expect(await legacy.lookup(fresh, key)).toEqual({ outcome: "UNKNOWN" });
    expect(await legacy.fence(ref, new Date(Date.now() + 60_000).toISOString())).toBeNull();
    expect(await t.admin.legacyReference(t.accountId, ref)).toBeNull();
    // Long past its deadline: FENCED, and the action's delivery (a create still on its way) can never create.
    const late = { ...fresh, expiresAt: new Date(Date.now() - 10_000).toISOString() };
    expect(await legacy.lookup(late, key)).toEqual({ outcome: "NOT_FOUND" });
    expect(await t.admin.legacyReference(t.accountId, ref)).toMatchObject({ state: "FENCED" });
    expect(await legacy.commit(fresh, key)).toEqual({ outcome: "FAILED", reasonCode: "REQUEST_FENCED", permanent: true });
    expect((await t.admin.requests(t.accountId)).filter((r) => r.operation === "legacy.appointment.post")).toHaveLength(0);
    // The fence holds at the product itself, not only in this adapter: a create already on its way under the
    // reference (here with a dispatch id and no deadline of its own, so no deadline check can refuse it) is refused
    // 409 FENCED and stores nothing.
    const lateCreate = await legacy.conn
      .run("createAppointment", { params: { externalRef: ref }, body: { clientRef: w.client, providerRef: w.provider, startLocal: "2026-11-02T10:00", modeCode: "TEL", dispatchId: "dsp_synthLateCreate000001" } })
      .then(
        () => null,
        (e: unknown) => e as { reasonCode?: string; httpStatus?: number },
      );
    expect(lateCreate).toMatchObject({ reasonCode: "CONNECTOR_CONFLICT", httpStatus: 409 });
    expect((await t.admin.requests(t.accountId)).filter((r) => r.operation === "legacy.appointment.post").map((r) => r.status)).toEqual([409]);
    expect((await t.admin.effects(t.accountId)).filter((e) => e.operation === "legacy.appointment.post")).toHaveLength(0);
  });
});
