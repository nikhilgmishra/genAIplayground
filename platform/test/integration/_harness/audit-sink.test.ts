/**
 * Layer 2, FO-16-21: the production S3ObjectLockAuditSink against MinIO with Object Lock and the
 * built-in KMS key: retention mode and retain-until headers, SHA-256 checksums verified by the
 * server, SSE-KMS, 412 Precondition Failed on overwrite (both existing-object policies), a foreign
 * object at the batch key detected, locked versions not deletable, and the verifier read path.
 */
import { CreateBucketCommand, DeleteObjectCommand, GetObjectCommand, GetObjectRetentionCommand, HeadObjectCommand, ListObjectVersionsCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import type { S3Client } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { beforeAll, describe, expect } from "vitest";
import { buildAuditInput } from "../../../src/audit/build-input.js";
import { buildChainedEvent, buildManifest } from "../../../src/audit/chain.js";
import { normalizeAuditInput } from "../../../src/audit/schema.js";
import { AuditSinkError, MANIFEST_SUFFIX } from "../../../src/audit/sinks/common.js";
import { S3ObjectLockAuditSink } from "../../../src/audit/sinks/s3-object-lock.js";
import type { S3ObjectLockAuditSinkConfig } from "../../../src/audit/sinks/s3-object-lock.js";
import type { AuditEvent } from "../../../src/protocol/index.js";
import { canonicalJson } from "../../../src/shared/canonical.js";
import { systemClock } from "../../../src/shared/clock.js";
import { newId } from "../../../src/shared/ids.js";
import { s3Client, SYNTHETIC_ACCOUNT, uniqueName } from "./clients.js";
import { localEnv } from "./env.js";
import { layer2, layer2Context } from "./layer2.js";

const it = layer2(["minio"]);
const DAY_MS = 86_400_000;
let s3: S3Client;
let bucket: string;

const sha256b64 = (s: string) => createHash("sha256").update(s, "utf8").digest("base64");

function config(overrides: Partial<S3ObjectLockAuditSinkConfig> = {}): S3ObjectLockAuditSinkConfig {
  return {
    bucket,
    expectedBucketOwner: SYNTHETIC_ACCOUNT,
    keyPrefix: "audit/",
    // GOVERNANCE keeps the throwaway test objects removable by the emulator root; COMPLIANCE is covered below.
    objectLockMode: "GOVERNANCE",
    retentionClass: "SECURITY_AUDIT",
    retentionDays: 1, // SYNTHETIC TEST VALUE: the real duration is approved by counsel (AIN register)
    kmsKeyId: localEnv().minioKmsKeyId,
    ...overrides,
  };
}

function batch(n: number, stream = `actions.${uniqueName("it")}`) {
  const tenantId = newId("tnt");
  const events: AuditEvent[] = [];
  let prev: string | null = null;
  for (let i = 1; i <= n; i++) {
    const input = buildAuditInput({ tenantId, correlationId: newId("cor"), sourceComponent: "actions", action: "action.commit.succeeded", outcome: "SUCCEEDED" }, systemClock);
    const e = buildChainedEvent(normalizeAuditInput(input), newId("aud"), { sourceStream: stream, sequence: i, prevHash: prev });
    events.push(e);
    prev = e.hash;
  }
  return { stream, ...buildManifest(events, { manifestId: newId("amf"), createdAt: new Date().toISOString() }) };
}

describe("S3ObjectLockAuditSink against MinIO with Object Lock", () => {
  beforeAll(async () => {
    s3 = s3Client(layer2Context(["minio"]));
    bucket = uniqueName("vsp-it-audit");
    await s3.send(new CreateBucketCommand({ Bucket: bucket, ObjectLockEnabledForBucket: true }));
  });

  it("[FO-16-21][OPS-01] putBatch stores body and manifest under Object Lock with retain-until from the approved class, server-verified SHA-256 and SSE-KMS", async () => {
    const sink = new S3ObjectLockAuditSink(s3, config({ objectLockMode: "COMPLIANCE" }), systemClock);
    expect(sink.kind).toBe("live");
    const { manifest, ndjson } = batch(3);
    const before = Date.now();
    await sink.putBatch(manifest, ndjson);
    for (const [key, body] of [[`audit/${manifest.objectKey}`, ndjson], [`audit/${manifest.objectKey}${MANIFEST_SUFFIX}`, canonicalJson(manifest)]] as const) {
      const ret = await s3.send(new GetObjectRetentionCommand({ Bucket: bucket, Key: key }));
      expect(ret.Retention?.Mode).toBe("COMPLIANCE");
      const until = ret.Retention?.RetainUntilDate?.getTime() ?? 0;
      expect(until).toBeGreaterThanOrEqual(before + DAY_MS - 5_000);
      expect(until).toBeLessThanOrEqual(Date.now() + DAY_MS + 5_000);
      const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key, ChecksumMode: "ENABLED" }));
      expect(head.ChecksumSHA256).toBe(sha256b64(body));
      expect(head.ServerSideEncryption).toBe("aws:kms");
      expect(head.SSEKMSKeyId ?? "").toContain(localEnv().minioKmsKeyId);
      expect(head.Metadata?.["vsp-batch-digest"]).toBe(manifest.batchDigest);
    }
  });

  it("[FO-16-21][ACT-02] a second write of the same batch gets 412 and is deferred to the verifier without overwriting (write-only identity)", async () => {
    const sink = new S3ObjectLockAuditSink(s3, config(), systemClock);
    const { manifest, ndjson } = batch(2);
    await sink.putBatch(manifest, ndjson);
    await expect(s3.send(new PutObjectCommand({ Bucket: bucket, Key: `audit/${manifest.objectKey}`, Body: "tampered", IfNoneMatch: "*" }))).rejects.toMatchObject({ $metadata: { httpStatusCode: 412 } });
    await sink.putBatch(manifest, ndjson);
    expect(sink.existingObjectsUnverified).toBe(2);
    const stored = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: `audit/${manifest.objectKey}` }));
    expect(await stored.Body?.transformToString("utf-8")).toBe(ndjson);
  });

  it("[FO-16-21] head_checksum mode accepts an identical stored object and refuses a foreign object at the batch key", async () => {
    const sink = new S3ObjectLockAuditSink(s3, config({ existingObjectCheck: "head_checksum" }), systemClock);
    const same = batch(1);
    await sink.putBatch(same.manifest, same.ndjson);
    await expect(sink.putBatch(same.manifest, same.ndjson)).resolves.toBeUndefined();
    const foreign = batch(1);
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: `audit/${foreign.manifest.objectKey}`, Body: "a foreign object at our deterministic key", IfNoneMatch: "*" }));
    await expect(sink.putBatch(foreign.manifest, foreign.ndjson)).rejects.toSatisfy((e: unknown) => e instanceof AuditSinkError && e.reasonCode === "AUDIT_SINK_OBJECT_EXISTS");
  });

  it("[FO-16-21] the verifier identity lists manifests and reads back the exact batch", async () => {
    const sink = new S3ObjectLockAuditSink(s3, config(), systemClock);
    const b = batch(4);
    await sink.putBatch(b.manifest, b.ndjson);
    const manifests = await sink.listManifests(b.stream);
    expect(manifests.map((m) => m.manifestId)).toEqual([b.manifest.manifestId]);
    expect(manifests[0]?.batchDigest).toBe(b.manifest.batchDigest);
    expect(await sink.getBatch(b.manifest.objectKey)).toBe(b.ndjson);
  });

  it("[FO-16-21][OPS-01] a locked object version cannot be deleted (Object Lock enforced by the emulator)", async () => {
    const sink = new S3ObjectLockAuditSink(s3, config({ objectLockMode: "COMPLIANCE" }), systemClock);
    const b = batch(1);
    await sink.putBatch(b.manifest, b.ndjson);
    const versions = await s3.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: `audit/${b.manifest.objectKey}` }));
    const version = versions.Versions?.find((v) => v.Key === `audit/${b.manifest.objectKey}`)?.VersionId;
    expect(version).toBeTruthy();
    // S3 answers 403 AccessDenied; MinIO answers 400 InvalidRequest (recorded in io.vsp.not-emulated).
    await expect(s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: `audit/${b.manifest.objectKey}`, VersionId: version, BypassGovernanceRetention: true }))).rejects.toMatchObject({
      $metadata: { httpStatusCode: expect.any(Number) },
    });
    const still = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: `audit/${b.manifest.objectKey}`, VersionId: version }));
    expect(still.ObjectLockMode).toBe("COMPLIANCE");
  });
});
