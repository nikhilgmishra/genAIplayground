/**
 * Layer 2 (WP-23; ACT-03, FO-06-75, FO-06-74): an absence is declared only when no effect can appear any more.
 *
 * The reference API gives up a received write whose dispatch deadline (`notAfter`: the preparation's expiry plus
 * the write timeout) passes: lock waits are bounded by the time left and the last statement of the write's
 * transaction checks the deadline with the database clock (liveness). The tests hold the row lock a write needs from
 * a SECOND PostgreSQL connection (an ordinary lock wait: another writer of the system of record, no fault seam), so
 * the request is received and in flight at the system while the platform's write times out. Before the deadline
 * plus the skew allowance the platform answers UNKNOWN; after it the absence is decided by the SYSTEM's answer only:
 * the request REJECTED (DEADLINE_EXCEEDED), or, for a legacy reference with nothing created, the reference FENCED.
 * Never by the time that passed (fence.test.ts: a COMMIT that lands after the deadline). Exactly-once is read from
 * the system's append-only effect log, never from test memory. SYNTHETIC data only.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect } from "vitest";
import type { PrepareInput } from "../../../src/actions/ports.js";
import { actingPartyFor } from "../../../src/domain/authority.js";
import { externalRefFor } from "../../../src/domain/legacy.js";
import { requestIdFor } from "../../../src/domain/changes.js";
import type { CommitSubject } from "../../../src/domain/commit.js";
import { systemClock } from "../../../src/shared/clock.js";
import { createIntegrationDb, postgresUrl } from "../_harness/clients.js";
import type { IntegrationDb } from "../_harness/clients.js";
import type { Layer2Context } from "../_harness/layer2.js";
import { layer2, layer2Context } from "../_harness/layer2.js";
import { ledgerReplica } from "../substrate/reference-sor.js";
import type { LedgerReplica } from "../substrate/reference-sor.js";
import { DOMAIN_SERVICES, allowDecision, createDomainPki, dtmfConfirmation, provisionTenant, refbizDatabase, seedWorld, sessionOf, sleep } from "./support.js";
import type { DomainPki, Tenant } from "./support.js";

const it = layer2(DOMAIN_SERVICES);

const WRITE_TIMEOUT_MS = 1_000;
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
  ledger = ledgerReplica(idb.db, systemClock, "domain-absence", { minPrepareTtlSeconds: 5 });
}, 120_000);

afterAll(async () => {
  for (const t of tenants) await t.dispose();
  await idb?.drop();
  pki?.dispose();
});

async function tenant(systems: ("scheduling" | "legacy")[]): Promise<Tenant> {
  const t = await provisionTenant(l2, pki, { systems, writeTimeoutMs: WRITE_TIMEOUT_MS, visibilityWindowMs: WINDOW_MS, clockSkewAllowanceMs: SKEW_MS });
  tenants.push(t);
  return t;
}

/** Another writer of the system of record holds a row lock (FOR UPDATE) until `release`. */
async function holdRowLock(sql: string, params: unknown[]): Promise<{ release: () => Promise<void> }> {
  const c = new pg.Client({ connectionString: postgresUrl(l2, refbizDatabase(l2)) });
  await c.connect();
  await c.query("begin");
  const r = await c.query(sql, params);
  if (r.rowCount !== 1) throw new Error("LOCK_TARGET_MISSING");
  return {
    release: async () => {
      await c.query("commit");
      await c.end();
    },
  };
}

const settled = <T>(p: Promise<T>) =>
  p.then(
    (value) => ({ value, error: null as null | { outcome?: string; reasonCode?: string } }),
    (e: unknown) => ({ value: null, error: e as { outcome?: string; reasonCode?: string } }),
  );

describe("absence is definitive only when no effect can appear any more (Layer 2)", () => {
  it("[ACT-03][FO-06-75] a booking held behind another writer's row lock past its deadline: UNKNOWN until the deadline + window + skew, then a definite REJECTED that never gains an effect", async () => {
    const t = await tenant(["scheduling"]);
    const w = await seedWorld(t);
    const port = t.adapters.commitPort;
    if (!port) throw new Error("commit port composed");
    const client = actingPartyFor(sessionOf(t.tenantId, w.client, "client"));
    const prep = await port.prepare(client, { kind: "appointment.create", slotId: w.slots[0] as string });
    // Confirmed close to its expiry: the deadline is expiry + write timeout, so the platform's write (sent now)
    // times out about 600 ms before the system's deadline: the request is still in flight there.
    const subject: CommitSubject = { kind: "appointment.create", subjectId: w.client, target: prep.input.target, change: prep.input.change, expiresAt: new Date(Date.now() + 600).toISOString() };
    const deadlineMs = Date.parse(subject.expiresAt) + WRITE_TIMEOUT_MS;
    const key = `vsp-${"7a".repeat(24)}`;
    const lock = await holdRowLock("select 1 from refbiz.slots where account_id = $1 and slot_id = $2 for update", [t.accountId, w.slots[0]]);
    const commit = await settled(port.commit(subject, key));
    // The write was sent and is in flight at the system: the platform does not know its outcome.
    expect(commit.error).toMatchObject({ outcome: "UNKNOWN" });
    expect(await port.reconcileDecision(subject, key)).toEqual({ outcome: "UNKNOWN", reasonCode: "NOT_VISIBLE_WITHIN_WINDOW" });
    // Past the deadline the system has rejected the request inside its own transaction (lock wait bounded).
    await sleep(Math.max(0, deadlineMs + 300 - Date.now()));
    const stored = await t.admin.changeRequest(t.accountId, requestIdFor(key));
    expect(stored).toMatchObject({ state: "FAILED", failure_code: "DEADLINE_EXCEEDED" });
    await sleep(Math.max(0, deadlineMs + WINDOW_MS + SKEW_MS + 100 - Date.now()));
    const decision = await port.reconcileDecision(subject, key);
    expect(decision).toEqual({ outcome: "NOT_FOUND", reasonCode: "REQUEST_REJECTED" });
    // The other writer finishes: the request that was declared without effect never gains one.
    await lock.release();
    await sleep(500);
    expect((await t.admin.effects(t.accountId)).filter((e) => e.requestId === requestIdFor(key))).toHaveLength(0);
    expect((await t.adapters.scheduling?.slot(w.slots[0] as string))?.state).toBe("OPEN");
    expect(await port.reconcileDecision(subject, key)).toEqual({ outcome: "NOT_FOUND", reasonCode: "REQUEST_REJECTED" });
    // A redelivery of the same request after the deadline is refused the same way (nothing applied).
    expect(await port.commit(subject, key)).toEqual({ outcome: "FAILED", reasonCode: "STATE_CHANGED", permanent: true });
    expect((await t.admin.effects(t.accountId)).filter((e) => e.requestId === requestIdFor(key))).toHaveLength(0);
  });

  it("[ACT-03][FO-06-75] lock waits that are each within the bound but together pass the deadline: the final check (the last statement before COMMIT) refuses the write, and no effect appears after the deadline", async () => {
    const t = await tenant(["scheduling"]);
    const w = await seedWorld(t);
    const port = t.adapters.commitPort;
    if (!port) throw new Error("commit port composed");
    const client = actingPartyFor(sessionOf(t.tenantId, w.client, "client"));
    const prep = await port.prepare(client, { kind: "appointment.reschedule", appointmentId: w.appointment, slotId: w.slots[1] as string });
    const subject: CommitSubject = { kind: "appointment.reschedule", subjectId: w.client, target: prep.input.target, change: prep.input.change, expiresAt: new Date(Date.now() + 600).toISOString() };
    const deadlineMs = Date.parse(subject.expiresAt) + WRITE_TIMEOUT_MS;
    const key = `vsp-${"7e".repeat(24)}`;
    // The reschedule locks the appointment, then the slots. Two other writers hold them; each wait the request makes
    // is shorter than the time left when it started (so no lock or statement bound fires), but together they end
    // after the deadline: only the final deadline check can refuse the write.
    const apptLock = await holdRowLock("select 1 from refbiz.appointments where account_id = $1 and appointment_id = $2 for update", [t.accountId, w.appointment]);
    const slotLock = await holdRowLock("select 1 from refbiz.slots where account_id = $1 and slot_id = $2 for update", [t.accountId, w.slots[1]]);
    const left = deadlineMs - Date.now();
    const releases = Promise.all([sleep(0.6 * left).then(() => apptLock.release()), sleep(1.3 * left).then(() => slotLock.release())]);
    const commit = await settled(port.commit(subject, key));
    expect(commit.error).toMatchObject({ outcome: "UNKNOWN" });
    await releases;
    await sleep(300);
    // The system received the request, waited for both locks within its bounds, and refused it at the final check.
    expect(Date.now()).toBeGreaterThan(deadlineMs);
    expect(await t.admin.changeRequest(t.accountId, requestIdFor(key))).toMatchObject({ state: "FAILED", failure_code: "DEADLINE_EXCEEDED" });
    expect((await t.admin.effects(t.accountId)).filter((e) => e.requestId === requestIdFor(key))).toHaveLength(0);
    expect((await t.adapters.scheduling?.slot(w.slots[1] as string))?.state).toBe("OPEN");
    await sleep(Math.max(0, deadlineMs + WINDOW_MS + SKEW_MS + 100 - Date.now()));
    expect(await port.reconcileDecision(subject, key)).toEqual({ outcome: "NOT_FOUND", reasonCode: "REQUEST_REJECTED" });
  });

  it("[ACT-03] the same lock released BEFORE the deadline: the in-flight write applies and reconciles COMMITTED, exactly one effect (the bound never hides a late effect)", async () => {
    const t = await tenant(["scheduling"]);
    const w = await seedWorld(t);
    const port = t.adapters.commitPort;
    if (!port) throw new Error("commit port composed");
    const client = actingPartyFor(sessionOf(t.tenantId, w.client, "client"));
    const prep = await port.prepare(client, { kind: "appointment.create", slotId: w.slots[1] as string });
    const subject: CommitSubject = { kind: "appointment.create", subjectId: w.client, target: prep.input.target, change: prep.input.change, expiresAt: new Date(Date.now() + 3_000).toISOString() };
    const key = `vsp-${"7b".repeat(24)}`;
    const lock = await holdRowLock("select 1 from refbiz.slots where account_id = $1 and slot_id = $2 for update", [t.accountId, w.slots[1]]);
    const commit = await settled(port.commit(subject, key));
    expect(commit.error).toMatchObject({ outcome: "UNKNOWN" });
    await lock.release();
    await sleep(WINDOW_MS + 300);
    expect((await port.reconcileDecision(subject, key)).outcome).toBe("COMMITTED");
    expect((await t.admin.effects(t.accountId)).filter((e) => e.requestId === requestIdFor(key))).toHaveLength(1);
  });

  it("[ACT-03][ACT-01] through the production action executor: the commit near expiry is UNKNOWN, the reconciliation after the deadline records NOT_FOUND (EXPIRED) and the booking never appears", async () => {
    const t = await tenant(["scheduling"]);
    const w = await seedWorld(t);
    const port = t.adapters.commitPort;
    if (!port) throw new Error("commit port composed");
    const ctx = sessionOf(t.tenantId, w.client, "client");
    const prep = await port.prepare(actingPartyFor(ctx), { kind: "appointment.create", slotId: w.slots[2] as string });
    const prepared = await ledger.service.prepare(ctx, { ...prep.input, kind: "appointment.create", ttlSeconds: 5 } as PrepareInput, allowDecision());
    const { confirmation, integration } = dtmfConfirmation(ctx, prepared);
    const action = await ledger.service.confirm(confirmation, integration);
    await sleep(Math.max(0, Date.parse(action.expiresAt) - Date.now() - 400));
    const lock = await holdRowLock("select 1 from refbiz.slots where account_id = $1 and slot_id = $2 for update", [t.accountId, w.slots[2]]);
    const first = await ledger.service.commit(ctx, { actionId: action.actionId, digest: action.digest }, { reauthorize: async () => allowDecision(), provider: port });
    expect(first.outcome).toBe("UNKNOWN");
    const key = (await ledger.service.describe?.(t.tenantId, action.actionId))?.providerIdempotencyKey ?? "";
    await sleep(Math.max(0, Date.parse(action.expiresAt) + WRITE_TIMEOUT_MS + WINDOW_MS + SKEW_MS + 300 - Date.now()));
    const rec = await ledger.service.reconcileWithResult?.(t.tenantId, action.actionId, port);
    expect(rec?.result).toBe("NOT_FOUND");
    expect((await ledger.service.describe?.(t.tenantId, action.actionId))?.state).toBe("EXPIRED");
    await lock.release();
    await sleep(500);
    expect((await t.admin.effects(t.accountId)).filter((e) => e.requestId === requestIdFor(key))).toHaveLength(0);
    expect((await t.adapters.scheduling?.slot(w.slots[2] as string))?.state).toBe("OPEN");
  });

  it("[ACT-03][FO-06-75] the non-idempotent legacy create held behind another writer past its deadline creates nothing; after the deadline the reference fence proves it (FENCED), nothing can be created later", async () => {
    const t = await tenant(["legacy"]);
    const w = await seedWorld(t);
    const legacy = t.adapters.legacyScheduling;
    if (!legacy) throw new Error("legacy composed");
    const party = actingPartyFor(sessionOf(t.tenantId, w.client, "client"));
    const prep = legacy.prepareCreate(party, { providerRef: w.provider, startsAt: new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 16) + ":00.000Z", modality: "video" });
    const subject = { kind: "appointment.create" as const, subjectId: w.client, target: prep.target, change: prep.change, expiresAt: new Date(Date.now() + 600).toISOString() };
    const deadlineMs = Date.parse(subject.expiresAt) + WRITE_TIMEOUT_MS;
    const key = `vsp-${"7c".repeat(24)}`;
    // The create's foreign-key check needs a share lock on the provider row: another writer holds it exclusively.
    const lock = await holdRowLock("select 1 from refbiz.providers where account_id = $1 and provider_id = $2 for update", [t.accountId, w.provider]);
    const commit = await settled(legacy.commit(subject, key));
    expect(commit.error).toMatchObject({ outcome: "UNKNOWN" });
    expect(await legacy.lookup(subject, key)).toEqual({ outcome: "UNKNOWN" });
    await sleep(Math.max(0, deadlineMs + WINDOW_MS + SKEW_MS + 200 - Date.now()));
    expect(await legacy.lookup(subject, key)).toEqual({ outcome: "NOT_FOUND" });
    // The proof is the system's: the reference this dispatch reserved, never created under, is FENCED.
    expect(await t.admin.legacyReference(t.accountId, externalRefFor(key))).toMatchObject({ state: "FENCED" });
    await lock.release();
    await sleep(500);
    const created = (await t.admin.effects(t.accountId)).filter((e) => e.operation === "legacy.appointment.post");
    expect(created).toHaveLength(0);
    expect(await legacy.byReference(externalRefFor(key))).toEqual([]);
    expect(await legacy.lookup(subject, key)).toEqual({ outcome: "NOT_FOUND" });
  });
});
