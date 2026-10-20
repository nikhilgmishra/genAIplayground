/**
 * Durable checkpoints and the incremental reader (WP-06; FO-06-09; ACT-02). Layer 1: migration 2060 on
 * PGlite (single connection: the compare-and-set logic, triggers and RLS, never multi-connection
 * concurrency) with the change feed served by the EMULATED vendor over HTTP. The process-crash run on
 * postgres:16 is in platform/test/integration/connectors/checkpoints.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../db/testing.js";
import type { PgliteDb } from "../../db/pglite.js";
import type { Queryable } from "../../db/types.js";
import { EgressGuard } from "../../privacy/egress.js";
import { FakeClock, systemClock } from "../../shared/clock.js";
import { VendorEmulator } from "../../../test/integration/connectors/emulator.js";
import { API_HOST, AUTH_HOST, TENANT_ID, emulatorEgressPolicy, emulatorProfile } from "../../../test/integration/connectors/profiles.js";
import { ConnectorHttpTransport } from "../http/transport.js";
import { admitConnectorProfile } from "../profile/validate.js";
import { LocalFixtureSecretResolver } from "../secrets/resolver.js";
import type { MappedRecord } from "../dsl/mapping.js";
import { IncrementalReader, PgConnectorCheckpointStore } from "./checkpoints.js";
import { ConnectorRuntime } from "./connector.js";

let db: PgliteDb;
let em: VendorEmulator;
const KEY = { tenantId: TENANT_ID, profileId: "cnp_synthEmulatedVendor01", streamId: "appointments" };

beforeEach(async () => {
  db = await createTestDb({ include: /^2060_/ });
  await db.tx(
    async (tx) => {
      await tx.exec(`create table test_appointment_projection (tenant_id text not null, appointment_id text not null, seq integer not null);
                     grant select, insert on test_appointment_projection to app_worker;`);
    },
    { role: "owner" },
  );
  em = await new VendorEmulator({ records: 23 }).start();
});

afterEach(async () => {
  await em.stop();
  await db.close();
});

function runtime(): ConnectorRuntime {
  const secrets = new LocalFixtureSecretResolver(systemClock)
    .set("local-fixture:conn/read", { clientId: "client-read", clientSecret: "secret-read-v1" })
    .set("local-fixture:conn/write", { clientId: "client-write", clientSecret: "secret-write-v1" });
  const transport = new ConnectorHttpTransport({
    environment: "ci",
    egress: new EgressGuard(emulatorEgressPolicy(), { environment: "ci" }),
    loopbackRoutes: new Map([
      [API_HOST, { port: em.port, tls: false }],
      [AUTH_HOST, { port: em.port, tls: false }],
    ]),
  });
  const admitted = admitConnectorProfile(emulatorProfile({ readRef: "local-fixture:conn/read", writeRef: "local-fixture:conn/write" }), "ci");
  return new ConnectorRuntime({ admitted, transport, secrets, clock: systemClock });
}

const project = async (tx: Queryable, recs: readonly MappedRecord[]) => {
  for (const r of recs) await tx.query("insert into test_appointment_projection (tenant_id, appointment_id, seq) values ($1, $2, $3)", [TENANT_ID, r.values.appointmentId, r.values.sequence]);
};

async function projection(): Promise<number[]> {
  const r = await db.tx((tx) => tx.query<{ seq: number }>("select seq from test_appointment_projection order by seq"), { role: "owner" });
  return r.rows.map((x) => x.seq);
}

describe("connector checkpoints [FO-06-09][ACT-02]", () => {
  it("[FO-06-09] positive: pages and their checkpoint commit together; a second run resumes after the last committed position", async () => {
    const store = new PgConnectorCheckpointStore(systemClock);
    const reader = new IncrementalReader({ runtime: runtime(), db, store, tenantId: TENANT_ID, streamId: "appointments", operationId: "appointments.changes", apply: project, watermarkField: "updatedAt" });
    const first = await reader.runOnce(2);
    expect([first.pages, first.records, first.completeness, first.checkpoint?.cursor]).toEqual([2, 10, "PAGE_LIMIT", "10"]);
    const second = await reader.runOnce(100);
    expect([second.records, second.completeness, second.checkpoint?.recordsCommitted, second.checkpoint?.pagesCommitted]).toEqual([13, "CAUGHT_UP", 23, 5]);
    expect(await projection()).toEqual(Array.from({ length: 23 }, (_, i) => i + 1));
    expect(second.checkpoint?.watermark).toBe("2026-10-18T08:00:00.000Z");
    // New source records after the catch-up are read from the stored position, nothing earlier.
    em.records.push({ ...em.records[0]!, id: "apt-new01", seq: 24, updatedAt: "2026-10-19T08:00:00Z" });
    const third = await reader.runOnce(100);
    expect([third.records, third.checkpoint?.cursor]).toEqual([1, "24"]);
    expect((await projection()).length).toBe(24);
  });

  it("[FO-06-09][ACT-02] failure injection: a crash inside the page transaction leaves neither the records nor the position; the rerun has no gap and no duplicate", async () => {
    const store = new PgConnectorCheckpointStore(systemClock);
    let pagesApplied = 0;
    const crashing = new IncrementalReader({
      runtime: runtime(),
      db,
      store,
      tenantId: TENANT_ID,
      streamId: "appointments",
      operationId: "appointments.changes",
      apply: async (tx, recs) => {
        await project(tx, recs);
        pagesApplied += 1;
        if (pagesApplied === 3) throw new Error("SIMULATED_CRASH_AFTER_PROJECTION_BEFORE_COMMIT");
      },
    });
    await expect(crashing.runOnce(100)).rejects.toThrow("SIMULATED_CRASH_AFTER_PROJECTION_BEFORE_COMMIT");
    expect(await projection()).toEqual(Array.from({ length: 10 }, (_, i) => i + 1));
    expect((await crashing.checkpoint())?.cursor).toBe("10");
    const resumed = new IncrementalReader({ runtime: runtime(), db, store, tenantId: TENANT_ID, streamId: "appointments", operationId: "appointments.changes", apply: project });
    await resumed.runOnce(100);
    const seqs = await projection();
    expect(seqs).toEqual(Array.from({ length: 23 }, (_, i) => i + 1));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it("[FO-06-09][ACT-02] adversarial: two readers advancing from one position: the second is refused (CHECKPOINT_CONFLICT) and rolls back its records", async () => {
    const store = new PgConnectorCheckpointStore(new FakeClock(new Date("2026-10-19T12:00:00Z")));
    const first = await db.tx((tx) => store.advance(tx, KEY, null, null, { cursor: "5", replayId: null, watermark: null, recordsDelta: 5, mappingDigest: null, runId: "run_synthReaderRunA0001" }), { role: "app_worker", rls: { tenantId: TENANT_ID } });
    await db.tx((tx) => store.advance(tx, KEY, first.positionDigest, first, { cursor: "10", replayId: null, watermark: null, recordsDelta: 5, mappingDigest: null, runId: "run_synthReaderRunA0001" }), { role: "app_worker", rls: { tenantId: TENANT_ID } });
    // A stale reader still holding the first position tries to advance, projecting inside the same transaction.
    await expect(
      db.tx(
        async (tx) => {
          await tx.query("insert into test_appointment_projection (tenant_id, appointment_id, seq) values ($1, 'apt-stale', 99)", [TENANT_ID]);
          await store.advance(tx, KEY, first.positionDigest, first, { cursor: "10", replayId: null, watermark: null, recordsDelta: 5, mappingDigest: null, runId: "run_synthReaderRunB0001" });
        },
        { role: "app_worker", rls: { tenantId: TENANT_ID } },
      ),
    ).rejects.toThrow("CHECKPOINT_CONFLICT");
    expect(await projection()).toEqual([]);
    await expect(db.tx((tx) => store.advance(tx, KEY, null, null, { cursor: "1", replayId: null, watermark: null, recordsDelta: 1, mappingDigest: null, runId: "run_synthReaderRunC0001" }), { role: "app_worker", rls: { tenantId: TENANT_ID } })).rejects.toThrow("CHECKPOINT_CONFLICT");
  });

  it("[FO-06-09] checkpoints never regress, cannot be deleted, and are tenant-scoped (RLS)", async () => {
    const store = new PgConnectorCheckpointStore(systemClock);
    const cp = await db.tx((tx) => store.advance(tx, KEY, null, null, { cursor: "5", replayId: "rpl-5", watermark: "2026-10-10T00:00:00.000Z", recordsDelta: 5, mappingDigest: null, runId: "run_synthReaderRunA0001" }), { role: "app_worker", rls: { tenantId: TENANT_ID } });
    await expect(
      db.tx((tx) => store.advance(tx, KEY, cp.positionDigest, cp, { cursor: "6", replayId: null, watermark: "2026-10-01T00:00:00.000Z", recordsDelta: 1, mappingDigest: null, runId: "run_synthReaderRunA0001" }), { role: "app_worker", rls: { tenantId: TENANT_ID } }),
    ).rejects.toThrow(/CONNECTOR_CHECKPOINT_WATERMARK_REGRESSION/);
    await expect(db.tx((tx) => tx.query("delete from connector_checkpoints"), { role: "owner" })).rejects.toThrow(/CONNECTOR_CHECKPOINT_APPEND_ONLY/);
    const other = await db.tx((tx) => store.load(tx, KEY), { role: "app_worker", rls: { tenantId: "tnt_synthOtherTenant00001" } });
    expect(other).toBeNull();
    const console = await db.tx((tx) => store.load(tx, KEY), { role: "app_console", rls: { tenantId: TENANT_ID } });
    expect(console?.replayId).toBe("rpl-5");
    await expect(db.tx((tx) => tx.query("update connector_checkpoints set cursor = 'x'"), { role: "app_console", rls: { tenantId: TENANT_ID } })).rejects.toThrow();
  });

  it("[FO-06-09][ACT-02] an empty batch with an advanced position is committed and read past: the reader neither stalls before it nor skips what follows", async () => {
    const store = new PgConnectorCheckpointStore(systemClock);
    // The feed's first window (seq 1..5) and a later one (seq 16..20) are filtered: empty pages, advanced positions.
    for (const s of [1, 2, 3, 4, 5, 16, 17, 18, 19, 20]) em.feedFiltered.add(s);
    const reader = new IncrementalReader({ runtime: runtime(), db, store, tenantId: TENANT_ID, streamId: "appointments", operationId: "appointments.changes", apply: project, watermarkField: "updatedAt" });
    const first = await reader.runOnce(1);
    expect([first.pages, first.records, first.completeness]).toEqual([1, 0, "PAGE_LIMIT"]);
    expect([first.checkpoint?.cursor, first.checkpoint?.recordsCommitted, first.checkpoint?.pagesCommitted, first.checkpoint?.watermark]).toEqual(["5", 0, 1, null]);
    expect(await projection()).toEqual([]);
    // The next run resumes from the committed empty-batch position and moves past the second empty window.
    const rest = await reader.runOnce(100);
    expect([rest.records, rest.completeness, rest.checkpoint?.cursor, rest.checkpoint?.recordsCommitted]).toEqual([13, "CAUGHT_UP", "23", 13]);
    expect(await projection()).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 21, 22, 23]);
    const asked = em.requestsTo("GET", "/api/v1/changes").map((q) => q.query.cursor ?? null);
    expect(asked).toEqual([null, "5", "10", "15", "20", "23"]);
  });

  it("[FO-06-09][ACT-02] adversarial: a non-empty page at the stored position is refused (PAGINATION_CURSOR_NOT_ADVANCING): nothing projected, checkpoint unchanged", async () => {
    const store = new PgConnectorCheckpointStore(systemClock);
    const stuck = () => ({ kind: "status" as const, status: 200, times: 1, body: { items: [1, 2].map((seq) => ({ id: `apt-0000${seq}`, status: "booked", startsAt: "2026-11-01T10:00:00Z", seq })), nextCursor: "2" } });
    em.inject("GET /api/v1/changes", stuck()).inject("GET /api/v1/changes", stuck()).inject("GET /api/v1/changes", stuck());
    const reader = new IncrementalReader({ runtime: runtime(), db, store, tenantId: TENANT_ID, streamId: "appointments", operationId: "appointments.changes", apply: project });
    await expect(reader.runOnce(5)).rejects.toThrow("PAGINATION_CURSOR_NOT_ADVANCING");
    const cp = await reader.checkpoint();
    expect([cp?.cursor, cp?.recordsCommitted, cp?.pagesCommitted]).toEqual(["2", 2, 1]);
    expect(await projection()).toEqual([1, 2]);
    // A later run at the same stored position is refused the same way; nothing is projected twice.
    await expect(reader.runOnce(5)).rejects.toThrow("PAGINATION_CURSOR_NOT_ADVANCING");
    expect((await reader.checkpoint())?.positionDigest).toBe(cp?.positionDigest);
    expect(await projection()).toEqual([1, 2]);
  });

  it("[FO-06-21][ACT-02] adversarial: a vendor cursor carrying SQL is stored and read back as a $n parameter, never executed", async () => {
    const store = new PgConnectorCheckpointStore(systemClock);
    const evil = "10'); drop table test_appointment_projection; select ('";
    em.inject("GET /api/v1/changes", { kind: "status", status: 200, times: 1, body: { items: [{ id: "apt-1", status: "booked", startsAt: "2026-11-01T10:00:00Z", seq: 1 }], nextCursor: evil } });
    const reader = new IncrementalReader({ runtime: runtime(), db, store, tenantId: TENANT_ID, streamId: "appointments", operationId: "appointments.changes", apply: project });
    await reader.runOnce(1);
    expect((await reader.checkpoint())?.cursor).toBe(evil);
    expect(await projection()).toEqual([1]); // the projection table still exists and holds the page
    // The next page sends the stored cursor to the vendor as an encoded query parameter, nothing else.
    await reader.runOnce(1);
    expect(em.requestsTo("GET", "/api/v1/changes").map((q) => q.query.cursor ?? null)).toEqual([null, evil]);
    expect(await projection()).toEqual([1]);
  });

  it("[FO-06-09] a stream that returns no continuation cursor is not resumable and is refused instead of re-read or skipped", async () => {
    const store = new PgConnectorCheckpointStore(systemClock);
    em.inject("GET /api/v1/changes", { kind: "status", status: 200, times: 1, body: { items: [{ id: "apt-1", status: "booked", startsAt: "2026-11-01T10:00:00Z", seq: 1 }], nextCursor: null } });
    const reader = new IncrementalReader({ runtime: runtime(), db, store, tenantId: TENANT_ID, streamId: "appointments", operationId: "appointments.changes", apply: project });
    await expect(reader.runOnce(5)).rejects.toThrow("PAGINATION_RESUME_CURSOR_MISSING");
    expect(await projection()).toEqual([]);
  });
});
