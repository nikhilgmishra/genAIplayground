import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PgliteDb } from "../db/pglite.js";
import type { AuditEvent } from "../protocol/index.js";
import { FakeClock, iso } from "../shared/clock.js";
import { computeEventHash } from "./chain.js";
import { AuditShipper } from "./shipper.js";
import { LocalFsAuditSinkFixture } from "./sinks/local-fs.js";
import { TENANT_ID, appendMany, createAuditTestDb, sampleAuditInput } from "./testing.js";
import { IntegrityVerifier, assessCompleteness, reconcileCounts } from "./verifier.js";
import { PgAuditWriter } from "./writer.js";

const STREAM = "actions.synth-1";
let db: PgliteDb;
let clock: FakeClock;
let root: string;
let sink: LocalFsAuditSinkFixture;
let writer: PgAuditWriter;
let verifier: IntegrityVerifier;

beforeEach(async () => {
  db = await createAuditTestDb();
  clock = new FakeClock();
  root = mkdtempSync(join(tmpdir(), "vsp-audit-verify-"));
  sink = new LocalFsAuditSinkFixture(root);
  writer = new PgAuditWriter({ db, clock, stream: STREAM });
  verifier = new IntegrityVerifier({ db, sink, clock, pageSize: 2 });
});
afterEach(async () => {
  await db.close();
  rmSync(root, { recursive: true, force: true });
});

const append = (n: number) => appendMany(n, (i) => writer.appendStandalone(i), clock);

/** Privileged insider: owner role with triggers disabled (what the hash chain must detect). */
const asInsider = (sql: string, params: unknown[] = []) =>
  db.tx(async (tx) => {
    await tx.query("set local session_replication_role = replica");
    await tx.query(sql, params);
  }, { role: "owner" });

async function rowEvent(seq: number): Promise<AuditEvent> {
  const r = await db.tx((tx) => tx.query<{ event: AuditEvent }>("select event from audit_outbox where source_stream = $1 and sequence = $2", [STREAM, seq]), {
    role: "owner",
  });
  return r.rows[0]!.event;
}

const codes = (v: { findings: { code: string }[] }) => v.findings.map((f) => f.code);

describe("IntegrityVerifier — local stream", () => {
  it("[SPEC-13.4] a clean stream verifies across pages", async () => {
    await append(5);
    const v = await verifier.verifyStream(STREAM);
    expect(v).toMatchObject({ ok: true, checkedEvents: 5, firstSequence: 1, lastSequence: 5, findings: [] });
  });

  it("[SPEC-13.4] tampering a stored row via the owner role is reported as a hash mismatch", async () => {
    await append(4);
    await asInsider(`update audit_outbox set event = jsonb_set(event, '{reasonCode}', '"INSIDER_EDIT"') where source_stream = $1 and sequence = 2`, [STREAM]);
    const v = await verifier.verifyStream(STREAM);
    expect(v.ok).toBe(false);
    expect(v.findings).toContainEqual(expect.objectContaining({ code: "HASH_MISMATCH", sequence: 2 }));
  });

  it("[SPEC-13.4] a re-hashed rewrite is reported at the next link", async () => {
    await append(4);
    const forged = { ...(await rowEvent(2)), outcome: "FAILED" as const };
    forged.hash = computeEventHash(forged);
    await asInsider("update audit_outbox set event = $2::jsonb, hash = $3, outcome = 'FAILED' where source_stream = $1 and sequence = 2", [STREAM, JSON.stringify(forged), forged.hash]);
    const v = await verifier.verifyStream(STREAM);
    expect(v.findings).toContainEqual(expect.objectContaining({ code: "PREV_HASH_MISMATCH", sequence: 3 }));
  });

  it("[SPEC-13.4] deleting a row is reported as a sequence gap", async () => {
    await append(5);
    await asInsider("delete from audit_outbox where source_stream = $1 and sequence = 3", [STREAM]);
    const v = await verifier.verifyStream(STREAM);
    expect(v.findings).toContainEqual(expect.objectContaining({ code: "SEQUENCE_GAP", sequence: 4, expectedSequence: 3 }));
    expect(codes(v)).toContain("PREV_HASH_MISMATCH");
  });

  it("[SPEC-13.4] truncating the tail (deleting the newest rows) is reported against the chain head", async () => {
    await append(5);
    await asInsider("delete from audit_outbox where source_stream = $1 and sequence >= 4", [STREAM]);
    const v = await verifier.verifyStream(STREAM);
    expect(v.findings).toContainEqual(expect.objectContaining({ code: "HEAD_MISMATCH", sequence: 5, expectedSequence: 4 }));
  });

  it("[SPEC-13.4] a re-hashed rewrite of the newest event is reported against the chain head", async () => {
    await append(3);
    const forged = { ...(await rowEvent(3)), reasonCode: "INSIDER_EDIT" };
    forged.hash = computeEventHash(forged);
    await asInsider("update audit_outbox set event = $2::jsonb, hash = $3 where source_stream = $1 and sequence = 3", [STREAM, JSON.stringify(forged), forged.hash]);
    expect(codes(await verifier.verifyStream(STREAM))).toEqual(["HEAD_MISMATCH"]);
  });

  it("[SPEC-13.4] moving an event to another tenant via the indexed column is reported", async () => {
    await append(2);
    // CHECK constraints keep columns and document in sync, so the insider must edit both; the hash catches it.
    await asInsider(
      `update audit_outbox set tenant_id = 'tnt_synthTenantOther0001', event = jsonb_set(event, '{tenantId}', '"tnt_synthTenantOther0001"') where source_stream = $1 and sequence = 1`,
      [STREAM],
    );
    expect(codes(await verifier.verifyStream(STREAM))).toContain("HASH_MISMATCH");
  });
});

describe("IntegrityVerifier — shipped copy in the independent sink", () => {
  async function shipAll(batchSize = 2) {
    await new AuditShipper({ db, sink, clock, batchSize }).runOnce();
  }

  it("[SPEC-13.4] verifies batch digests and chain continuity across manifests", async () => {
    await append(5);
    await shipAll();
    const v = await verifier.verifyShipped(STREAM);
    expect(v).toMatchObject({ ok: true, scope: "shipped", checkedEvents: 5, firstSequence: 1, lastSequence: 5 });
  });

  it("[SPEC-13.4] an edited object in the sink is reported as a digest/content mismatch", async () => {
    await append(4);
    await shipAll();
    const key = (await sink.listManifests(STREAM))[1]!.objectKey;
    const path = join(root, key);
    writeFileSync(path, readFileSync(path, "utf8").replace("SUCCEEDED", "FAILED"));
    const v = await verifier.verifyShipped(STREAM);
    expect(codes(v)).toEqual(expect.arrayContaining(["MANIFEST_DIGEST_MISMATCH", "HASH_MISMATCH"]));
  });

  it("[SPEC-13.4] a manifest missing from the sink is reported as a chain gap and a missing shipped manifest", async () => {
    await append(6);
    await shipAll();
    const m = (await sink.listManifests(STREAM))[1]!;
    unlinkSync(join(root, `${m.objectKey}.manifest.json`));
    const v = await verifier.verifyShipped(STREAM);
    expect(codes(v)).toEqual(expect.arrayContaining(["MANIFEST_CHAIN_GAP", "SHIPPED_MANIFEST_MISSING_FROM_SINK"]));
  });

  it("[SPEC-13.4] a local rewrite after shipping (fully re-chained) is caught by comparison with the sink", async () => {
    await append(3);
    await shipAll(10);
    // insider rewrites event 3 locally and updates the head consistently: the local chain alone looks clean
    const forged = { ...(await rowEvent(3)), reasonCode: "INSIDER_EDIT" };
    forged.hash = computeEventHash(forged);
    await asInsider("update audit_outbox set event = $2::jsonb, hash = $3 where source_stream = $1 and sequence = 3", [STREAM, JSON.stringify(forged), forged.hash]);
    await asInsider("update audit_chain_heads set last_hash = $2 where source_stream = $1", [STREAM, forged.hash]);
    expect((await verifier.verifyStream(STREAM)).ok).toBe(true);
    expect(codes(await verifier.verifyShipped(STREAM))).toContain("LOCAL_SINK_DIVERGENCE");
  });

  it("[SPEC-13.4] markVerified only marks manifests when the whole shipped stream is clean", async () => {
    await append(4);
    await shipAll();
    const key = (await sink.listManifests(STREAM))[0]!.objectKey;
    writeFileSync(join(root, key), "tampered\n");
    await verifier.verifyShipped(STREAM, { markVerified: true });
    const n = await db.tx((tx) => tx.query<{ n: number }>("select count(*)::int as n from audit_manifests where verified_at is not null"), { role: "owner" });
    expect(n.rows[0]!.n).toBe(0);
  });
});

describe("Completeness: ingestion gaps and critical-action reconciliation", () => {
  it("[SPEC-13.4] flags a stream that went silent while its source reports activity", async () => {
    await append(2);
    clock.advanceSeconds(600);
    const windowStart = iso(new Date(clock.now().getTime() - 300_000));
    const r = await verifier.detectIngestionGaps({
      silenceThresholdSeconds: 120,
      reports: [{ sourceStream: STREAM, windowStart, windowEnd: iso(clock.now()), reportedEventCount: 4 }],
    });
    expect(r.ok).toBe(false);
    expect(r.gaps.map((g) => g.code)).toEqual(expect.arrayContaining(["STREAM_SILENT", "COUNT_SHORTFALL", "SINK_INGESTION_LAG"]));
    expect(r.gaps.find((g) => g.code === "COUNT_SHORTFALL")).toMatchObject({ reportedEventCount: 4, observedEventCount: 0 });
  });

  it("[SPEC-13.4] flags unknown streams and count excess; a matching active stream has no gaps", async () => {
    const windowStart = iso(clock.now());
    await append(3);
    clock.advanceSeconds(5);
    const windowEnd = iso(clock.now());
    await new AuditShipper({ db, sink, clock }).runOnce();
    const ok = await verifier.detectIngestionGaps({ silenceThresholdSeconds: 60, reports: [{ sourceStream: STREAM, windowStart, windowEnd, reportedEventCount: 3 }] });
    expect(ok).toEqual({ ok: true, checkedStreams: 1, gaps: [] });
    const r = await verifier.detectIngestionGaps({
      silenceThresholdSeconds: 60,
      reports: [
        { sourceStream: STREAM, windowStart, windowEnd, reportedEventCount: 2 },
        { sourceStream: "gateway.never-seen", windowStart, windowEnd, reportedEventCount: 1 },
      ],
    });
    expect(r.gaps.map((g) => [g.sourceStream, g.code])).toEqual([
      [STREAM, "COUNT_EXCESS"],
      ["gateway.never-seen", "UNKNOWN_STREAM"],
    ]);
    await expect(verifier.detectIngestionGaps({ silenceThresholdSeconds: 60, reports: [{ sourceStream: "Bad Stream", windowStart, windowEnd, reportedEventCount: 1 }] })).rejects.toMatchObject({
      reasonCode: "AUDIT_ACTIVITY_REPORT_INVALID",
    });
  });

  it("[OPS-01] reconcileCounts flags a committed action that has no audit event", async () => {
    const from = iso(clock.now());
    await writer.appendStandalone(sampleAuditInput(clock, { idempotencyKey: "idem_synthCommitted00001" }));
    await writer.appendStandalone(sampleAuditInput(clock, { idempotencyKey: "idem_synthCommitted00002" }));
    clock.advanceSeconds(1);
    const observed = await verifier.observedActionKeys({ tenantId: TENANT_ID, actions: ["action.commit.succeeded"], from, to: iso(clock.now()) });
    // the action ledger (source of truth) says three actions committed
    const ledger = { "action.commit.succeeded": ["idem_synthCommitted00001", "idem_synthCommitted00002", "idem_synthCommitted00003"] };
    const r = reconcileCounts(ledger, observed);
    expect(r).toEqual({
      ok: false,
      expectedTotal: 3,
      observedTotal: 2,
      discrepancies: [{ code: "MISSING_AUDIT_EVIDENCE", action: "action.commit.succeeded", key: "idem_synthCommitted00003", expectedCount: 1, observedCount: 0 }],
    });
    // the hash chain is intact, yet completeness FAILS on reconciliation
    const integrity = [await verifier.verifyStream(STREAM)];
    expect(integrity[0]!.ok).toBe(true);
    expect(assessCompleteness({ integrity, ingestion: { ok: true, checkedStreams: 1, gaps: [] }, reconciliation: r })).toEqual({
      verdict: "FAIL",
      reasonCodes: ["RECONCILIATION_DISCREPANCIES"],
    });
  });

  it("[OPS-03] hashing alone is not completeness: a clean chain without reconciliation is INCONCLUSIVE, never PASS", async () => {
    await append(2);
    const integrity = [await verifier.verifyStream(STREAM)];
    expect(assessCompleteness({ integrity, ingestion: null, reconciliation: null })).toEqual({
      verdict: "INCONCLUSIVE",
      reasonCodes: ["INGESTION_NOT_MONITORED", "COMPLETENESS_NOT_RECONCILED"],
    });
    expect(assessCompleteness({ integrity: [], ingestion: { ok: true, checkedStreams: 0, gaps: [] }, reconciliation: reconcileCounts({}, {}) }).verdict).toBe("INCONCLUSIVE");
    expect(assessCompleteness({ integrity, ingestion: { ok: true, checkedStreams: 1, gaps: [] }, reconciliation: reconcileCounts({ a: 1 }, { a: 1 }) }).verdict).toBe("PASS");
  });

  it("[OPS-01] reconcileCounts detects duplicates, unexpected evidence and count mismatches", () => {
    const r = reconcileCounts(
      { "action.commit.succeeded": ["k1", "k2"], "session.revoke": 3, "killswitch.engage": 1 },
      { "action.commit.succeeded": ["k1", "k1", "k9"], "session.revoke": 2, "killswitch.engage": 2 },
    );
    // actions in sorted order; within an action, expected keys in input order, then unexpected keys
    expect(r.discrepancies).toEqual([
      { code: "DUPLICATE_AUDIT_EVIDENCE", action: "action.commit.succeeded", key: "k1", expectedCount: 1, observedCount: 2 },
      { code: "MISSING_AUDIT_EVIDENCE", action: "action.commit.succeeded", key: "k2", expectedCount: 1, observedCount: 0 },
      { code: "UNEXPECTED_AUDIT_EVIDENCE", action: "action.commit.succeeded", key: "k9", expectedCount: 0, observedCount: 1 },
      { code: "COUNT_MISMATCH", action: "killswitch.engage", expectedCount: 1, observedCount: 2 },
      { code: "MISSING_AUDIT_EVIDENCE", action: "session.revoke", expectedCount: 3, observedCount: 2 },
    ]);
    expect(r.ok).toBe(false);
  });

  it("[OPS-01] property: reconcileCounts is ok exactly when keyed multisets are equal", () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom("k1", "k2", "k3", "k4"), { maxLength: 8 }), fc.array(fc.constantFrom("k1", "k2", "k3", "k4"), { maxLength: 8 }), (exp, obs) => {
        const r = reconcileCounts({ "action.commit.succeeded": exp }, { "action.commit.succeeded": obs });
        const eq = [...exp].sort().join() === [...obs].sort().join();
        expect(r.ok).toBe(eq);
        // any expected key absent from observed is always reported as missing
        for (const k of exp) if (!obs.includes(k)) expect(r.discrepancies).toContainEqual(expect.objectContaining({ code: "MISSING_AUDIT_EVIDENCE", key: k }));
      }),
    );
  });
});
