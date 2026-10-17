import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuditEvent } from "../../protocol/index.js";
import { FakeClock } from "../../shared/clock.js";
import { buildChainedEvent, buildManifest } from "../chain.js";
import { normalizeAuditInput } from "../schema.js";
import { sampleAuditInput } from "../testing.js";
import { LocalFsAuditSinkFixture } from "./local-fs.js";

const STREAM = "actions.synth-1";
let root: string;

function batch(n: number, from = 1, prevHash: string | null = null, outcome: "SUCCEEDED" | "FAILED" = "SUCCEEDED") {
  const clock = new FakeClock();
  const events: AuditEvent[] = [];
  let prev = prevHash;
  for (let i = from; i < from + n; i++) {
    const e = buildChainedEvent(normalizeAuditInput(sampleAuditInput(clock, { outcome })), `aud_synthLocalSink${String(i).padStart(8, "0")}`, {
      sourceStream: STREAM,
      sequence: i,
      prevHash: prev,
    });
    events.push(e);
    prev = e.hash;
  }
  return buildManifest(events, { manifestId: `amf_synthLocalManifest${String(from).padStart(4, "0")}`, createdAt: "2026-10-17T15:05:00.000Z" });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vsp-audit-sink-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("LocalFsAuditSinkFixture (LOCAL FIXTURE, simulates Object Lock WORM)", () => {
  it("[SPEC-13.4] declares itself a local fixture", () => {
    const sink = new LocalFsAuditSinkFixture(root);
    expect(sink.kind).toBe("local_fixture");
    expect(sink.badge).toContain("LOCAL FIXTURE");
  });

  it("[SPEC-13.4] stores the batch and its manifest and lists manifests in sequence order", async () => {
    const sink = new LocalFsAuditSinkFixture(root);
    const a = batch(3, 1);
    const b = batch(2, 4, a.manifest.lastHash);
    await sink.putBatch(b.manifest, b.ndjson);
    await sink.putBatch(a.manifest, a.ndjson);
    const listed = await sink.listManifests(STREAM);
    expect(listed.map((m) => m.firstSequence)).toEqual([1, 4]);
    expect(listed[0]).toEqual(a.manifest);
    expect(await sink.getBatch(a.manifest.objectKey)).toBe(a.ndjson);
    expect(await sink.listManifests("actions.unknown")).toEqual([]);
  });

  it("[OPS-01] refuses to overwrite an existing object with different content (WORM)", async () => {
    const sink = new LocalFsAuditSinkFixture(root);
    const a = batch(3, 1);
    await sink.putBatch(a.manifest, a.ndjson);
    const tampered = batch(3, 1, null, "FAILED"); // same range and key, rewritten outcome
    expect(tampered.manifest.objectKey).toBe(a.manifest.objectKey);
    expect(tampered.ndjson).not.toBe(a.ndjson);
    await expect(sink.putBatch(tampered.manifest, tampered.ndjson)).rejects.toMatchObject({ reasonCode: "AUDIT_SINK_OBJECT_EXISTS" });
    expect(await sink.getBatch(a.manifest.objectKey)).toBe(a.ndjson);
  });

  it("[ACT-02] an identical re-put is a no-op (idempotent shipping)", async () => {
    const sink = new LocalFsAuditSinkFixture(root);
    const a = batch(2, 1);
    await sink.putBatch(a.manifest, a.ndjson);
    await expect(sink.putBatch(a.manifest, a.ndjson)).resolves.toBeUndefined();
    expect(readdirSync(join(root, STREAM)).sort()).toEqual([
      "000000000001-000000000002.ndjson",
      "000000000001-000000000002.ndjson.manifest.json",
    ]);
  });

  it("[SPEC-13.4] completes a batch whose body was written before a crash but whose manifest was not", async () => {
    const sink = new LocalFsAuditSinkFixture(root);
    const a = batch(2, 1);
    // simulate: body present, manifest missing
    mkdirSync(join(root, STREAM), { recursive: true });
    writeFileSync(join(root, a.manifest.objectKey), a.ndjson);
    expect(await sink.listManifests(STREAM)).toEqual([]);
    await sink.putBatch(a.manifest, a.ndjson);
    expect(await sink.listManifests(STREAM)).toEqual([a.manifest]);
  });

  it("[SPEC-13.4] refuses inconsistent batches (digest, count, key) and path traversal", async () => {
    const sink = new LocalFsAuditSinkFixture(root);
    const a = batch(2, 1);
    await expect(sink.putBatch(a.manifest, a.ndjson.replace("SUCCEEDED", "FAILED"))).rejects.toMatchObject({ reasonCode: "AUDIT_SINK_DIGEST_MISMATCH" });
    await expect(sink.putBatch({ ...a.manifest, objectKey: "../escape/000000000001-000000000002.ndjson" }, a.ndjson)).rejects.toMatchObject({
      reasonCode: "AUDIT_SINK_OBJECT_KEY_INVALID",
    });
    await expect(sink.putBatch({ ...a.manifest, eventCount: 3 }, a.ndjson)).rejects.toMatchObject({ reasonCode: "AUDIT_SINK_MANIFEST_INVALID" });
    await expect(sink.getBatch("../../etc/passwd")).rejects.toMatchObject({ reasonCode: "AUDIT_SINK_OBJECT_KEY_INVALID" });
    await expect(sink.getBatch(`${STREAM}/000000000009-000000000010.ndjson`)).rejects.toMatchObject({ reasonCode: "AUDIT_SINK_OBJECT_MISSING" });
    await expect(sink.listManifests("../x")).rejects.toMatchObject({ reasonCode: "AUDIT_STREAM_INVALID" });
  });

  it("[SPEC-13.4] a manifest file edited on disk is rejected when listed", async () => {
    const sink = new LocalFsAuditSinkFixture(root);
    const a = batch(2, 1);
    await sink.putBatch(a.manifest, a.ndjson);
    const path = join(root, `${a.manifest.objectKey}.manifest.json`);
    writeFileSync(path, readFileSync(path, "utf8").replace('"eventCount":2', '"eventCount":2,"note":"x"'));
    await expect(sink.listManifests(STREAM)).rejects.toMatchObject({ reasonCode: "AUDIT_SINK_MANIFEST_INVALID" });
  });
});
