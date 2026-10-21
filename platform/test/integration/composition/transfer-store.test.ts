/**
 * Layer 2 (WP-07; FO-19-06, FO-21-10, SAFE-02, SAFE-04, AUTH-02): the live transfer store (PgTransferStore,
 * migration 2070 transfer_journeys) on PostgreSQL 16, through the production PgPoolDb with role switching and
 * row-level security, over two pooled connections where concurrency matters.
 *
 * Asserted: an insert of an existing handoff is TRANSFER_VERSION_CONFLICT; compare-and-set lets exactly one of
 * two concurrent writers of the same version through (the loser gets TRANSFER_VERSION_CONFLICT, never an
 * overwrite); the trigger refuses any version step other than +1, a key change, a delete and a truncate even to
 * a writer that bypasses the store; RLS hides another tenant's journeys for every role; the console role reads
 * but can neither write through the store (TRANSFER_STORE_READ_ONLY) nor through SQL (privilege refused).
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect } from "vitest";
import { PgTransferStore } from "../../../src/adapters/live/pg-transfer-store.js";
import type { TransferJourney } from "../../../src/workflows/transfer.js";
import { createIntegrationDb } from "../_harness/clients.js";
import type { IntegrationDb } from "../_harness/clients.js";
import { layer2, layer2Context } from "../_harness/layer2.js";

const it = layer2(["postgres"]);
const TENANT_A = "tnt_synthTransferTenantA01";
const TENANT_B = "tnt_synthTransferTenantB01";

let idb: IntegrationDb;
beforeAll(async () => {
  idb = await createIntegrationDb(layer2Context(["postgres"]), 4);
});
afterAll(async () => {
  await idb?.drop();
});

const id = (p: string) => `${p}_synth${randomBytes(9).toString("hex")}`;

function journey(tenantId: string, over: Partial<TransferJourney> = {}): TransferJourney {
  const now = "2026-10-21T10:00:00.000Z";
  return {
    handoffId: id("hnd"),
    tenantId,
    callId: `cal-${randomBytes(4).toString("hex")}`,
    sessionGeneration: 1,
    reason: "CALLER_REQUESTED_HUMAN",
    priority: "STANDARD",
    routePlan: ["dst_synthHumanQueue000001"],
    routeIndex: 0,
    status: "ROUTING",
    currentTransferId: null,
    attempts: [],
    attemptCount: 0,
    continuityAttempts: 0,
    vendorRefs: {},
    awaitingRetry: false,
    updatesPlayed: 0,
    connectedAt: null,
    destinationCorrected: false,
    safety: null,
    appliedEventIds: [],
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...over,
  } as unknown as TransferJourney;
}

const reasonOf = (e: unknown) => (e as { reasonCode?: string } | null)?.reasonCode ?? String(e);

describe("PgTransferStore on PostgreSQL 16 [FO-19-06][SAFE-04]", () => {
  it("[FO-19-06] insert, read back, list; a second insert of the same handoff is TRANSFER_VERSION_CONFLICT", async () => {
    const store = new PgTransferStore({ db: idb.db, tenantId: TENANT_A, role: "app_runtime" });
    const j = journey(TENANT_A);
    await store.put(j, null);
    expect(await store.get(j.handoffId)).toMatchObject({ handoffId: j.handoffId, version: 1, status: "ROUTING" });
    expect((await store.listActive()).map((x) => x.handoffId)).toContain(j.handoffId);
    expect((await store.listForCall(TENANT_A, j.callId)).map((x) => x.handoffId)).toEqual([j.handoffId]);
    expect(reasonOf(await store.put(j, null).then(() => null, (e: unknown) => e))).toBe("TRANSFER_VERSION_CONFLICT");
  });

  it("[SAFE-04][FO-19-06] compare-and-set: of two concurrent writers of version 1 exactly one advances the journey; the stale writer is refused, never overwrites", async () => {
    const gateway = new PgTransferStore({ db: idb.db, tenantId: TENANT_A, role: "app_runtime" });
    const sweep = new PgTransferStore({ db: idb.db, tenantId: TENANT_A, role: "app_worker" });
    const j = journey(TENANT_A);
    await gateway.put(j, null);
    const a = { ...j, version: 2, status: "CONNECTED", updatedAt: "2026-10-21T10:00:05.000Z" } as TransferJourney;
    const b = { ...j, version: 2, status: "FAILED", awaitingRetry: true, updatedAt: "2026-10-21T10:00:06.000Z" } as unknown as TransferJourney;
    const results = await Promise.allSettled([gateway.put(a, 1), sweep.put(b, 1)]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(refused.map((r) => reasonOf(r.reason))).toEqual(["TRANSFER_VERSION_CONFLICT"]);
    const stored = await gateway.get(j.handoffId);
    expect(stored?.version).toBe(2);
    expect(stored?.status).toBe(results[0]?.status === "fulfilled" ? "CONNECTED" : "FAILED");
    // A later stale write (expected version 1 again) is refused as well; the next step from 2 is accepted.
    expect(reasonOf(await gateway.put({ ...a, version: 2 }, 1).then(() => null, (e: unknown) => e))).toBe("TRANSFER_VERSION_CONFLICT");
    await gateway.put({ ...(stored as TransferJourney), version: 3, status: "CLOSED" } as unknown as TransferJourney, 2);
    expect((await gateway.get(j.handoffId))?.version).toBe(3);
  });

  it("[SAFE-04] the trigger refuses a version step other than +1, a key change, a delete and a truncate, even for a writer that bypasses the store", async () => {
    const store = new PgTransferStore({ db: idb.db, tenantId: TENANT_A, role: "app_runtime" });
    const j = journey(TENANT_A);
    await store.put(j, null);
    const raw = (sql: string, params: unknown[]) => idb.db.tx((tx) => tx.query(sql, params), { role: "app_runtime", rls: { tenantId: TENANT_A } }).then(() => "ok", (e: unknown) => String((e as { message?: string }).message ?? e));
    expect(await raw("update transfer_journeys set version = version + 2 where tenant_id = $1 and handoff_id = $2", [TENANT_A, j.handoffId])).toMatch(/TRANSFER_JOURNEY_VERSION_NOT_NEXT/);
    expect(await raw("update transfer_journeys set version = version where tenant_id = $1 and handoff_id = $2", [TENANT_A, j.handoffId])).toMatch(/TRANSFER_JOURNEY_VERSION_NOT_NEXT/);
    expect(await idb.db.tx((tx) => tx.query("update transfer_journeys set call_id = 'cal-other', version = version + 1 where tenant_id = $1 and handoff_id = $2", [TENANT_A, j.handoffId]), { role: "owner" }).then(() => "ok", (e: unknown) => String((e as Error).message))).toMatch(/TRANSFER_JOURNEY_KEY_IMMUTABLE|permission denied/);
    expect(await idb.db.tx((tx) => tx.query("delete from transfer_journeys where handoff_id = $1", [j.handoffId]), { role: "owner" }).then(() => "ok", (e: unknown) => String((e as Error).message))).toMatch(/TRANSFER_JOURNEY_APPEND_ONLY/);
    expect(await idb.db.tx((tx) => tx.query("truncate transfer_journeys"), { role: "owner" }).then(() => "ok", (e: unknown) => String((e as Error).message))).toMatch(/TRANSFER_JOURNEY_APPEND_ONLY/);
    expect((await store.get(j.handoffId))?.version).toBe(1);
  });

  it("[AUTH-02][FO-03-49] RLS per role: another tenant's journeys are invisible to runtime, worker and console; the console reads its own but cannot write (store or SQL)", async () => {
    const a = new PgTransferStore({ db: idb.db, tenantId: TENANT_A, role: "app_runtime" });
    const j = journey(TENANT_A);
    await a.put(j, null);
    for (const role of ["app_runtime", "app_worker", "app_console"] as const) {
      const other = new PgTransferStore({ db: idb.db, tenantId: TENANT_B, role });
      expect(await other.get(j.handoffId), role).toBeNull();
      expect((await other.listActive()).map((x) => x.handoffId), role).not.toContain(j.handoffId);
      expect(await other.listForCall(TENANT_A, j.callId), role).toEqual([]);
    }
    const console = new PgTransferStore({ db: idb.db, tenantId: TENANT_A, role: "app_console" });
    expect((await console.get(j.handoffId))?.handoffId).toBe(j.handoffId);
    expect((await console.listActive()).map((x) => x.handoffId)).toContain(j.handoffId);
    expect(reasonOf(await console.put({ ...j, version: 2 } as TransferJourney, 1).then(() => null, (e: unknown) => e))).toBe("TRANSFER_STORE_READ_ONLY");
    const sqlWrite = await idb.db
      .tx((tx) => tx.query("update transfer_journeys set status = 'CLOSED', version = version + 1 where tenant_id = $1 and handoff_id = $2", [TENANT_A, j.handoffId]), { role: "app_console", rls: { tenantId: TENANT_A } })
      .then(() => "ok", (e: unknown) => String((e as Error).message));
    expect(sqlWrite).toMatch(/permission denied|42501|TRANSFER_STORE_UNAVAILABLE|DB_/);
    // A row of another tenant cannot be written through RLS either (with check), even by the runtime role.
    const forged = journey(TENANT_B);
    expect(reasonOf(await a.put(forged, null).then(() => null, (e: unknown) => e))).toBe("TRANSFER_TENANT_MISMATCH");
    expect((await a.get(j.handoffId))?.status).toBe("ROUTING");
  });
});
