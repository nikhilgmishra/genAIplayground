/**
 * Layer 2 (WP-06): durable connector checkpoints on postgres:16 across process death (FO-06-09; ACT-02).
 * A real child process (checkpoint-child.ts) runs the production IncrementalReader, which commits each
 * page's projection and its checkpoint in one transaction; it is SIGKILLed inside a page transaction or
 * between pages. A restarted reader (new process state, new pool) resumes from the stored checkpoint:
 * no gap and no duplicate projection. Two readers on two connections racing on one checkpoint, both for the
 * first checkpoint (unique key) and from a stored position (compare-and-set on the position digest, the
 * update path): exactly one advances, the other's page rolls back. An empty batch with an advanced position
 * (a filtered feed) is committed on its own, so a killed reader resumes past it. A drifted page
 * (SCHEMA_DRIFT seam) and a refused projection write both stop consumption and keep the checkpoint.
 *
 * The vendor side is the protocol emulator over TLS (EMULATED); credentials come from LocalStack Secrets
 * Manager. Multi-connection behaviour here is real PostgreSQL, not PGlite.
 */
import { afterAll, beforeAll, describe, expect, onTestFinished } from "vitest";
import { ConnectorSchemaDriftError } from "../../../src/connectors/dsl/errors.js";
import type { MappedRecord } from "../../../src/connectors/dsl/mapping.js";
import { IncrementalReader, PgConnectorCheckpointStore } from "../../../src/connectors/runtime/checkpoints.js";
import type { Checkpoint } from "../../../src/connectors/runtime/checkpoints.js";
import { PgPoolDb } from "../../../src/db/pg.js";
import type { Db, Queryable } from "../../../src/db/types.js";
import { systemClock } from "../../../src/shared/clock.js";
import { ConflictError } from "../../../src/shared/errors.js";
import { newId } from "../../../src/shared/ids.js";
import { createIntegrationDb, postgresUrl, uniqueName } from "../_harness/clients.js";
import type { IntegrationDb } from "../_harness/clients.js";
import { localEnv, PLATFORM_ROOT } from "../_harness/env.js";
import { layer2, layer2Context } from "../_harness/layer2.js";
import type { Layer2Context } from "../_harness/layer2.js";
import { TENANT_ID } from "./profiles.js";
import { schemaDriftSeam } from "./seams.js";
import { createTestPki, liveRig, runChild, waitForLine } from "./support.js";
import type { LiveRig, TestPki } from "./support.js";

const SERVICES = ["postgres", "localstack"];
const it = layer2(SERVICES);
const CHILD = `${PLATFORM_ROOT}/test/integration/connectors/checkpoint-child.ts`;
const KEY = { tenantId: TENANT_ID, profileId: "cnp_synthEmulatedVendor01", streamId: "appointments" };
let pki: TestPki;
let idb: IntegrationDb;

beforeAll(async () => {
  pki = createTestPki();
  idb = await createIntegrationDb(layer2Context(SERVICES), 6);
});
afterAll(async () => {
  await idb?.drop();
  pki?.dispose();
});

/** A fresh projection table for one test (no unique constraint: a duplicate would show as a second row). */
async function projectionTable(): Promise<string> {
  const table = uniqueName("test_projection").replace(/-/g, "_");
  await idb.db.tx((tx) => tx.exec(`create table ${table} (tenant_id text not null, appointment_id text not null, seq integer not null); grant select, insert on ${table} to app_worker;`), { role: "owner" });
  return table;
}

async function seqs(table: string): Promise<number[]> {
  const r = await idb.db.tx((tx) => tx.query<{ seq: number }>(`select seq from ${table} order by seq`), { role: "owner" });
  return r.rows.map((x) => x.seq);
}

async function checkpoint(db: Db, tenantId: string): Promise<Checkpoint | null> {
  return db.tx((tx) => new PgConnectorCheckpointStore(systemClock).load(tx, { ...KEY, tenantId }), { role: "app_worker", rls: { tenantId } });
}

async function rigFor(l2: Layer2Context): Promise<LiveRig> {
  const r = await liveRig(l2, pki, { emulator: { records: 23 } });
  onTestFinished(() => r.dispose());
  return r;
}

function reader(r: LiveRig, db: Db, table: string, tenantId = TENANT_ID, apply?: (tx: Queryable, recs: readonly MappedRecord[]) => Promise<void>): IncrementalReader {
  return new IncrementalReader({
    runtime: r.rt,
    db,
    store: new PgConnectorCheckpointStore(systemClock),
    tenantId,
    streamId: "appointments",
    operationId: "appointments.changes",
    watermarkField: "updatedAt",
    apply:
      apply ??
      (async (tx, recs) => {
        for (const x of recs) await tx.query(`insert into ${table} (tenant_id, appointment_id, seq) values ($1, $2, $3)`, [tenantId, x.values.appointmentId, x.values.sequence]);
      }),
  });
}

function childEnv(l2: Layer2Context, r: LiveRig, table: string, tenantId: string, mode: string, crashPage: number): NodeJS.ProcessEnv {
  return {
    VSP_CHILD_MODE: mode,
    VSP_CHILD_CRASH_PAGE: String(crashPage),
    VSP_CHILD_DB_URL: postgresUrl(l2, idb.name),
    VSP_CHILD_TENANT: tenantId,
    VSP_CHILD_TABLE: table,
    VSP_CHILD_SM_ENDPOINT: l2.url("localstack", 4566),
    VSP_CHILD_AWS_KEY: localEnv().awsAccessKeyId,
    VSP_CHILD_AWS_SECRET: localEnv().awsSecretAccessKey,
    VSP_CHILD_READ_REF: r.readRef,
    VSP_CHILD_WRITE_REF: r.writeRef,
    VSP_CHILD_EMULATOR_PORT: String(r.em.port),
    VSP_CHILD_CA_FILE: pki.caPath,
  };
}

async function killAt(l2: Layer2Context, r: LiveRig, table: string, tenantId: string, mode: string, crashPage: number, marker: string): Promise<{ line: string; signal: NodeJS.Signals | null }> {
  const run = runChild(CHILD, childEnv(l2, r, table, tenantId, mode, crashPage));
  try {
    const line = await waitForLine(run, marker);
    run.child.kill("SIGKILL");
    const exit = await run.exited;
    return { line, signal: exit.signal };
  } catch (err) {
    run.child.kill("SIGKILL");
    await run.exited;
    throw err;
  }
}

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const changesAt = (r: LiveRig, cursor: string) => r.em.requestsTo("GET", "/api/v1/changes").filter((q) => (q.query.cursor ?? "") === cursor);

describe("connector checkpoints across process death on postgres:16 [FO-06-09][ACT-02]", () => {
  // Checkpoints are append-only (no delete); each test uses its own tenant id so they never collide.
  it("[FO-06-09][ACT-02] SIGKILL inside a page transaction: the page's projection and checkpoint roll back together; the restarted reader re-reads that page, no gap and no duplicate", async ({ l2 }) => {
    const r = await rigFor(l2);
    const table = await projectionTable();
    const tenantId = newId("tnt");
    const killed = await killAt(l2, r, table, tenantId, "crash-in-tx", 3, "IN_TX 3");
    expect(killed.signal).toBe("SIGKILL");
    const cp = await checkpoint(idb.db, tenantId);
    expect([cp?.cursor, cp?.recordsCommitted, cp?.pagesCommitted]).toEqual(["10", 10, 2]);
    expect(await seqs(table)).toEqual(range(1, 10));

    const restarted = await reader(r, idb.db, table, tenantId).runOnce(100);
    expect([restarted.completeness, restarted.records, restarted.checkpoint?.recordsCommitted]).toEqual(["CAUGHT_UP", 13, 23]);
    expect(await seqs(table)).toEqual(range(1, 23));
    expect(changesAt(r, "10")).toHaveLength(2); // read by the killed child, then again after the restart
  });

  it("[FO-06-09] SIGKILL after a page committed: the restarted reader resumes after that page (its records are not projected twice)", async ({ l2 }) => {
    const r = await rigFor(l2);
    const table = await projectionTable();
    const tenantId = newId("tnt");
    const killed = await killAt(l2, r, table, tenantId, "crash-after-commit", 2, "COMMITTED 2");
    expect([killed.signal, killed.line]).toEqual(["SIGKILL", "COMMITTED 2 10"]);
    expect(await seqs(table)).toEqual(range(1, 10));
    const restarted = await reader(r, idb.db, table, tenantId).runOnce(100);
    expect([restarted.completeness, restarted.checkpoint?.recordsCommitted, restarted.checkpoint?.pagesCommitted]).toEqual(["CAUGHT_UP", 23, 5]);
    expect(await seqs(table)).toEqual(range(1, 23));
    expect(changesAt(r, "10")).toHaveLength(1);
  });

  it("[FO-06-09][ACT-02] an empty batch with an advanced position is committed on its own: a reader SIGKILLed after it resumes past it, no gap and no stall", async ({ l2 }) => {
    const r = await rigFor(l2);
    // The feed's first window (seq 1..5) and a later one (seq 11..15) are filtered by the vendor: empty pages, advanced positions.
    for (const s of [1, 2, 3, 4, 5, 11, 12, 13, 14, 15]) r.em.feedFiltered.add(s);
    const table = await projectionTable();
    const tenantId = newId("tnt");
    const killed = await killAt(l2, r, table, tenantId, "crash-after-commit", 1, "COMMITTED 1");
    expect([killed.signal, killed.line]).toEqual(["SIGKILL", "COMMITTED 1 5"]);
    const cp = await checkpoint(idb.db, tenantId);
    expect([cp?.cursor, cp?.recordsCommitted, cp?.pagesCommitted]).toEqual(["5", 0, 1]);
    expect(await seqs(table)).toEqual([]);
    const restarted = await reader(r, idb.db, table, tenantId).runOnce(100);
    expect([restarted.completeness, restarted.records, restarted.checkpoint?.cursor, restarted.checkpoint?.recordsCommitted]).toEqual(["CAUGHT_UP", 13, "23", 13]);
    expect(await seqs(table)).toEqual([...range(6, 10), ...range(16, 23)]);
    expect(changesAt(r, "5")).toHaveLength(1); // the empty batch was not read again after the restart
    expect(changesAt(r, "15")).toHaveLength(1);
  });

  /**
   * Two readers on two pools (two PostgreSQL backends) advance one stream from the same position. Both
   * project the same page inside their open transactions before either writes the checkpoint (barrier);
   * then both advance: the first takes the row (or unique-key) lock and commits, the second blocks on it
   * and, re-evaluated against the committed row, no longer matches its expected position.
   */
  async function race(l2: Layer2Context, seededPages: number): Promise<{ table: string; tenantId: string; outcomes: PromiseSettledResult<unknown>[] }> {
    const r = await rigFor(l2);
    const table = await projectionTable();
    const tenantId = newId("tnt");
    if (seededPages > 0) await reader(r, idb.db, table, tenantId).runOnce(seededPages);
    const poolA = PgPoolDb.fromConnectionString(postgresUrl(l2, idb.name), 2);
    const poolB = PgPoolDb.fromConnectionString(postgresUrl(l2, idb.name), 2);
    onTestFinished(async () => {
      await poolA.close();
      await poolB.close();
    });
    let arrived = 0;
    let release: () => void = () => undefined;
    const barrier = new Promise<void>((resolve) => (release = resolve));
    const gated = (db: Db) =>
      reader(r, db, table, tenantId, async (tx, recs) => {
        for (const x of recs) await tx.query(`insert into ${table} (tenant_id, appointment_id, seq) values ($1, $2, $3)`, [tenantId, x.values.appointmentId, x.values.sequence]);
        arrived += 1;
        if (arrived >= 2) release();
        await Promise.race([barrier, new Promise((res) => setTimeout(res, 10_000))]);
      });
    const outcomes = await Promise.allSettled([gated(poolA).runOnce(1), gated(poolB).runOnce(1)]);
    expect(arrived).toBe(2); // both transactions held the same page before either advanced
    return { table, tenantId, outcomes };
  }

  function expectOneWinner(outcomes: PromiseSettledResult<unknown>[]): void {
    const won = outcomes.filter((o) => o.status === "fulfilled");
    const lost = outcomes.filter((o): o is PromiseRejectedResult => o.status === "rejected");
    expect([won.length, lost.length]).toEqual([1, 1]);
    expect(lost[0]?.reason).toBeInstanceOf(ConflictError);
    expect((lost[0]?.reason as Error).message).toContain("CHECKPOINT_CONFLICT");
  }

  it("[FO-06-09][ACT-02] two readers on two connections race on the first checkpoint: exactly one inserts it, the other gets CHECKPOINT_CONFLICT and its page rolls back", async ({ l2 }) => {
    const { table, tenantId, outcomes } = await race(l2, 0);
    expectOneWinner(outcomes);
    const cp = await checkpoint(idb.db, tenantId);
    expect([cp?.recordsCommitted, cp?.pagesCommitted, cp?.cursor]).toEqual([5, 1, "5"]);
    const rows = await idb.db.tx((tx) => tx.query<{ seq: number }>(`select seq from ${table} where tenant_id = $1 order by seq`, [tenantId]), { role: "owner" });
    expect(rows.rows.map((x) => x.seq)).toEqual(range(1, 5));
  });

  it("[FO-06-09][ACT-02] two readers on two connections race from a stored position: the compare-and-set on the position digest lets exactly one advance; the other blocks on the row, is refused (CHECKPOINT_CONFLICT) and its page rolls back", async ({ l2 }) => {
    const { table, tenantId, outcomes } = await race(l2, 1);
    expectOneWinner(outcomes);
    const cp = await checkpoint(idb.db, tenantId);
    expect([cp?.recordsCommitted, cp?.pagesCommitted, cp?.cursor]).toEqual([10, 2, "10"]);
    const rows = await idb.db.tx((tx) => tx.query<{ seq: number }>(`select seq from ${table} where tenant_id = $1 order by seq`, [tenantId]), { role: "owner" });
    expect(rows.rows.map((x) => x.seq)).toEqual(range(1, 10)); // page two projected once, not twice
  });

  it("[FAULT:SCHEMA_DRIFT seam][FO-06-05] a drifted page mid-stream is refused whole: nothing of it is projected and the checkpoint stays; after the vendor is fixed the reader resumes", async ({ l2 }) => {
    const r = await rigFor(l2);
    const table = await projectionTable();
    const tenantId = newId("tnt");
    const rd = reader(r, idb.db, table, tenantId);
    await rd.runOnce(2);
    const before = await checkpoint(idb.db, tenantId);
    const seam = schemaDriftSeam(r.em, "RENAMED_REQUIRED_FIELD");
    await expect(rd.runOnce(5)).rejects.toBeInstanceOf(ConnectorSchemaDriftError);
    expect((await checkpoint(idb.db, tenantId))?.positionDigest).toBe(before?.positionDigest);
    const rows = await idb.db.tx((tx) => tx.query<{ n: string }>(`select count(*) as n from ${table} where tenant_id = $1`, [tenantId]), { role: "owner" });
    expect(Number(rows.rows[0]?.n)).toBe(10);
    seam.undo();
    expect((await rd.runOnce(100)).checkpoint?.recordsCommitted).toBe(23);
  });

  it("[FO-06-09] stop consuming, keep the checkpoint: when the projection write is refused (a dead-letter destination that refuses), the page rolls back and the reader stops", async ({ l2 }) => {
    const r = await rigFor(l2);
    const table = await projectionTable();
    const tenantId = newId("tnt");
    let pages = 0;
    const refusing = reader(r, idb.db, table, tenantId, async (tx, recs) => {
      pages += 1;
      for (const x of recs) await tx.query(`insert into ${table} (tenant_id, appointment_id, seq) values ($1, $2, $3)`, [tenantId, x.values.appointmentId, x.values.sequence]);
      if (pages === 2) throw new Error("DEAD_LETTER_REFUSED");
    });
    await expect(refusing.runOnce(10)).rejects.toThrow("DEAD_LETTER_REFUSED");
    const cp = await checkpoint(idb.db, tenantId);
    expect([cp?.recordsCommitted, cp?.pagesCommitted]).toEqual([5, 1]);
    const rows = await idb.db.tx((tx) => tx.query<{ seq: number }>(`select seq from ${table} where tenant_id = $1 order by seq`, [tenantId]), { role: "owner" });
    expect(rows.rows.map((x) => x.seq)).toEqual(range(1, 5));
    expect(pages).toBe(2);
  });
});
