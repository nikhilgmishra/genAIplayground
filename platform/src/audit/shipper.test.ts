import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PgliteDb } from "../db/pglite.js";
import type { AuditEvent } from "../protocol/index.js";
import { FakeClock } from "../shared/clock.js";
import { computeEventHash } from "./chain.js";
import { FaultInjectingAuditSinkFixture } from "./fixtures.js";
import { AuditShipper } from "./shipper.js";
import { LocalFsAuditSinkFixture } from "./sinks/local-fs.js";
import { appendMany, countRows, createAuditTestDb } from "./testing.js";
import { IntegrityVerifier } from "./verifier.js";
import { PgAuditWriter } from "./writer.js";

const STREAM = "actions.synth-1";
let db: PgliteDb;
let clock: FakeClock;
let root: string;
let writer: PgAuditWriter;

beforeEach(async () => {
  db = await createAuditTestDb();
  clock = new FakeClock();
  root = mkdtempSync(join(tmpdir(), "vsp-audit-ship-"));
  writer = new PgAuditWriter({ db, clock, stream: STREAM });
});
afterEach(async () => {
  await db.close();
  rmSync(root, { recursive: true, force: true });
});

const append = (n: number, stream = STREAM) => appendMany(n, (i) => writer.appendStandalone(i, stream), clock);

describe("AuditShipper", () => {
  it("[SPEC-13.4] ships each stream in sequence-ordered batches with deterministic keys and marks rows shipped", async () => {
    const sink = new LocalFsAuditSinkFixture(root);
    await append(7);
    await append(2, "gateway.synth-2");
    const shipper = new AuditShipper({ db, sink, clock, batchSize: 3 });
    const r = await shipper.runOnce();
    expect(r).toMatchObject({ batchesShipped: 4, eventsShipped: 9, failedStreams: 0 });
    expect(readdirSync(join(root, STREAM)).filter((f) => f.endsWith(".ndjson")).sort()).toEqual([
      "000000000001-000000000003.ndjson",
      "000000000004-000000000006.ndjson",
      "000000000007-000000000007.ndjson",
    ]);
    expect(await countRows(db, "select count(*) as n from audit_outbox where shipped_at is null")).toBe(0);
    const manifests = await sink.listManifests(STREAM);
    expect(manifests[1]!.firstPrevHash).toBe(manifests[0]!.lastHash);
    const verifier = new IntegrityVerifier({ db, sink, clock });
    expect((await verifier.verifyShipped(STREAM)).findings).toEqual([]);
    expect((await shipper.runOnce()).batchesShipped).toBe(0);
  });

  it("[OPS-01][SPEC-13.4] streams with 10+ events and 10+ manifests ship and verify in numeric sequence order (regression: text-alias ORDER BY)", async () => {
    // Sequence values cross the 1 -> 10 -> 100 boundaries where text ordering ("1","10","100","11",...,"2") diverges from numeric ordering.
    const sink = new LocalFsAuditSinkFixture(root);
    const verifier = new IntegrityVerifier({ db, sink, clock });
    await append(105);
    expect((await verifier.verifyStream(STREAM)).findings).toEqual([]);
    const shipper = new AuditShipper({ db, sink, clock, batchSize: 7 });
    let shipped = 0;
    for (let i = 0; i < 25; i++) {
      const r = await shipper.runOnce();
      expect(r.failedStreams).toBe(0);
      shipped += r.eventsShipped;
      if (r.batchesShipped === 0) break;
    }
    expect(shipped).toBe(105);
    expect(await countRows(db, "select count(*) as n from audit_outbox where shipped_at is null")).toBe(0);
    expect((await sink.listManifests(STREAM)).length).toBe(15);
    const shippedCheck = await verifier.verifyShipped(STREAM, { markVerified: true });
    expect(shippedCheck.findings).toEqual([]);
    expect(shippedCheck.lastSequence).toBe(105);
    // More events after 15 verified manifests: the watermark must advance numerically, not stall at manifest "10".
    await append(12);
    for (let i = 0; i < 5; i++) if ((await shipper.runOnce()).batchesShipped === 0) break;
    expect(await countRows(db, "select count(*) as n from audit_outbox where shipped_at is null")).toBe(0);
    expect((await verifier.verifyShipped(STREAM)).findings).toEqual([]);
    expect((await verifier.verifyStream(STREAM)).findings).toEqual([]);
  });

  it("[ACT-02] is idempotent across a crash between put and mark: no duplicate or overlapping objects", async () => {
    const inner = new LocalFsAuditSinkFixture(root);
    const faulty = new FaultInjectingAuditSinkFixture(inner);
    await append(4);
    faulty.crashAfterPut(1);
    const first = await new AuditShipper({ db, sink: faulty, clock, batchSize: 10 }).runOnce();
    expect(first.streams[0]).toMatchObject({ batchesShipped: 0, reasonCode: "AUDIT_SINK_RESPONSE_LOST" });
    // the object reached the sink, but rows stay unshipped and the batch stays PLANNED
    expect(readdirSync(join(root, STREAM)).filter((f) => f.endsWith(".ndjson"))).toEqual(["000000000001-000000000004.ndjson"]);
    expect(await countRows(db, "select count(*) as n from audit_outbox where shipped_at is null")).toBe(4);
    expect(await countRows(db, "select count(*) as n from audit_manifests where status = 'PLANNED'")).toBe(1);

    // more events arrive before the restart; the restarted shipper must re-put exactly the planned batch first
    await append(3);
    clock.advanceSeconds(30);
    const second = await new AuditShipper({ db, sink: faulty, clock, batchSize: 10 }).runOnce();
    expect(second).toMatchObject({ batchesShipped: 2, eventsShipped: 7, failedStreams: 0 });
    expect(readdirSync(join(root, STREAM)).filter((f) => f.endsWith(".ndjson")).sort()).toEqual([
      "000000000001-000000000004.ndjson",
      "000000000005-000000000007.ndjson",
    ]);
    const verifier = new IntegrityVerifier({ db, sink: inner, clock });
    const shipped = await verifier.verifyShipped(STREAM);
    expect(shipped.findings).toEqual([]);
    expect(shipped.checkedEvents).toBe(7);
    expect(await countRows(db, "select count(*) as n from audit_outbox where shipped_at is null")).toBe(0);
  });

  it("[OPS-01] a sink outage leaves events buffered in the durable outbox and records sink failure", async () => {
    const faulty = new FaultInjectingAuditSinkFixture(new LocalFsAuditSinkFixture(root));
    await append(3);
    faulty.failPuts(2);
    const shipper = new AuditShipper({ db, sink: faulty, clock });
    expect((await shipper.runOnce()).streams[0]).toMatchObject({ reasonCode: "AUDIT_SINK_UNAVAILABLE", batchesShipped: 0 });
    expect((await shipper.runOnce()).streams[0]).toMatchObject({ reasonCode: "AUDIT_SINK_UNAVAILABLE" });
    const status = await db.tx((tx) => tx.query<{ c: number; r: string }>("select consecutive_failures as c, last_failure_reason as r from audit_sink_status"), {
      role: "owner",
    });
    expect(status.rows[0]).toEqual({ c: 2, r: "AUDIT_SINK_UNAVAILABLE" });
    expect(await countRows(db, "select count(*) as n from audit_outbox where shipped_at is null")).toBe(3);
    expect((await shipper.runOnce()).eventsShipped).toBe(3);
    const after = await db.tx((tx) => tx.query<{ c: number }>("select consecutive_failures as c from audit_sink_status"), { role: "owner" });
    expect(after.rows[0]!.c).toBe(0);
  });

  it("[SPEC-13.4] refuses to ship across a deleted event (gap) and ships only the verified prefix", async () => {
    const sink = new LocalFsAuditSinkFixture(root);
    await append(5);
    // privileged insider bypasses triggers and deletes sequence 4 before shipping
    await db.tx(async (tx) => {
      await tx.query("set local session_replication_role = replica");
      await tx.query("delete from audit_outbox where source_stream = $1 and sequence = 4", [STREAM]);
    }, { role: "owner" });
    const r = await new AuditShipper({ db, sink, clock }).runOnce();
    expect(r.streams[0]).toMatchObject({ batchesShipped: 1, eventsShipped: 3, reasonCode: "AUDIT_CHAIN_GAP" });
    const manifests = await sink.listManifests(STREAM);
    expect(manifests.map((m) => [m.firstSequence, m.lastSequence])).toEqual([[1, 3]]);
    expect(await countRows(db, "select count(*) as n from audit_outbox where shipped_at is null")).toBe(1);
  });

  it("[SPEC-13.4] refuses to ship a rewritten event", async () => {
    const sink = new LocalFsAuditSinkFixture(root);
    await append(4);
    await db.tx(async (tx) => {
      await tx.query("set local session_replication_role = replica");
      await tx.query(`update audit_outbox set event = jsonb_set(event, '{reasonCode}', '"REWRITTEN_BY_INSIDER"') where source_stream = $1 and sequence = 3`, [STREAM]);
    }, { role: "owner" });
    const r = await new AuditShipper({ db, sink, clock }).runOnce();
    expect(r.streams[0]).toMatchObject({ eventsShipped: 2, reasonCode: "AUDIT_CHAIN_BROKEN" });
  });

  it("[SPEC-13.4] a re-hashed rewrite breaks the next link and the rewritten predecessor is withheld too", async () => {
    const sink = new LocalFsAuditSinkFixture(root);
    await append(4);
    await db.tx(async (tx) => {
      const row = await tx.query<{ event: AuditEvent }>("select event from audit_outbox where source_stream = $1 and sequence = 3", [STREAM]);
      const forged = { ...row.rows[0]!.event, reasonCode: "REWRITTEN_BY_INSIDER" };
      forged.hash = computeEventHash(forged);
      await tx.query("set local session_replication_role = replica");
      await tx.query("update audit_outbox set event = $2::jsonb, hash = $3 where source_stream = $1 and sequence = 3", [STREAM, JSON.stringify(forged), forged.hash]);
    }, { role: "owner" });
    const r = await new AuditShipper({ db, sink, clock }).runOnce();
    expect(r.streams[0]).toMatchObject({ eventsShipped: 2, reasonCode: "AUDIT_CHAIN_BROKEN" });
    expect((await sink.listManifests(STREAM)).map((m) => m.lastSequence)).toEqual([2]);
  });

  it("[OPS-01] manifest records are immutable once shipped and cannot be deleted", async () => {
    const sink = new LocalFsAuditSinkFixture(root);
    await append(2);
    await new AuditShipper({ db, sink, clock }).runOnce();
    await expect(db.tx((tx) => tx.query("delete from audit_manifests"), { role: "owner" })).rejects.toThrow("AUDIT_APPEND_ONLY");
    await expect(db.tx((tx) => tx.query("update audit_manifests set status = 'PLANNED', shipped_at = null"), { role: "app_worker" })).rejects.toThrow();
    await expect(db.tx((tx) => tx.query("update audit_manifests set batch_digest = repeat('0', 64)"), { role: "owner" })).rejects.toThrow("AUDIT_MANIFEST_IMMUTABLE");
    await expect(db.tx((tx) => tx.query("select * from audit_manifests"), { role: "app_runtime" })).rejects.toMatchObject({ code: "42501" });
  });

  it("[OPS-01] purges the local copy only for rows shipped in manifests verified against the sink", async () => {
    const sink = new LocalFsAuditSinkFixture(root);
    await append(6);
    const shipper = new AuditShipper({ db, sink, clock, batchSize: 4 });
    await shipper.runOnce();
    expect(await shipper.purgeVerified(STREAM)).toEqual({ purgedThroughSequence: 0, deleted: 0 });
    const verifier = new IntegrityVerifier({ db, sink, clock });
    expect((await verifier.verifyShipped(STREAM, { markVerified: true })).ok).toBe(true);
    expect(await shipper.purgeVerified(STREAM)).toEqual({ purgedThroughSequence: 6, deleted: 6 });
    expect(await countRows(db, "select count(*) as n from audit_outbox")).toBe(0);
    await append(2);
    const local = await verifier.verifyStream(STREAM);
    expect(local).toMatchObject({ ok: true, firstSequence: 7, lastSequence: 8 });
    expect((await verifier.verifyShipped(STREAM)).ok).toBe(true);
  });
});
