/**
 * CONTRACT TEST with an injected STUB S3 client. No AWS call is made. It asserts
 * the exact command inputs the live sink sends; it does not prove that a real
 * bucket enforces Object Lock (that remains BLOCKED on the audit account).
 */
import { GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AuditEvent } from "../../protocol/index.js";
import { canonicalJson } from "../../shared/canonical.js";
import { ConfigurationRejectedError } from "../../shared/errors.js";
import { FakeClock } from "../../shared/clock.js";
import { buildChainedEvent, buildManifest } from "../chain.js";
import { normalizeAuditInput } from "../schema.js";
import { sampleAuditInput } from "../testing.js";
import { S3ObjectLockAuditSink, validateS3SinkConfig } from "./s3-object-lock.js";
import type { S3ObjectLockAuditSinkConfig, S3SendClient } from "./s3-object-lock.js";

const STREAM = "actions.synth-1";
const clock = new FakeClock("2026-10-17T15:00:00.000Z");
const config: S3ObjectLockAuditSinkConfig = {
  bucket: "vsp-audit-evidence-synthetic",
  expectedBucketOwner: "111122223333",
  keyPrefix: "audit/",
  objectLockMode: "COMPLIANCE",
  retentionClass: "SECURITY_AUDIT",
  retentionDays: 30, // SYNTHETIC TEST VALUE ONLY — the real duration must be approved by counsel
  kmsKeyId: "arn:aws:kms:us-east-1:111122223333:key/synthetic-audit-key",
};

function batch(n: number) {
  const c = new FakeClock();
  const events: AuditEvent[] = [];
  let prev: string | null = null;
  for (let i = 1; i <= n; i++) {
    const e = buildChainedEvent(normalizeAuditInput(sampleAuditInput(c)), `aud_synthS3Contract${String(i).padStart(6, "0")}`, {
      sourceStream: STREAM,
      sequence: i,
      prevHash: prev,
    });
    events.push(e);
    prev = e.hash;
  }
  return buildManifest(events, { manifestId: "amf_synthS3Manifest00001", createdAt: "2026-10-17T15:00:00.000Z" });
}

type Handler = (cmd: unknown) => Promise<unknown>;
function stub(handler: Handler = async () => ({})): { client: S3SendClient; sent: unknown[] } {
  const sent: unknown[] = [];
  const client = {
    send: async (cmd: unknown) => {
      sent.push(cmd);
      return handler(cmd);
    },
  } as unknown as S3SendClient;
  return { client, sent };
}

const b64 = (s: string) => createHash("sha256").update(s, "utf8").digest("base64");

describe("S3ObjectLockAuditSink (LIVE adapter, BLOCKED for execution; stub-client contract test)", () => {
  it("[OPS-04] refuses to start without an approved retention duration (no invented retention)", () => {
    expect(() => new S3ObjectLockAuditSink(stub().client, { ...config, retentionDays: null }, clock)).toThrow(ConfigurationRejectedError);
    try {
      new S3ObjectLockAuditSink(stub().client, { ...config, retentionDays: null }, clock);
    } catch (err) {
      expect((err as ConfigurationRejectedError).violations).toEqual(["AUDIT_RETENTION_UNAPPROVED"]);
    }
    expect(validateS3SinkConfig({ ...config, retentionDays: 0 })).toEqual(["AUDIT_RETENTION_INVALID"]);
    expect(validateS3SinkConfig({ ...config, retentionDays: 1.5 })).toEqual(["AUDIT_RETENTION_INVALID"]);
    expect(validateS3SinkConfig({ ...config, expectedBucketOwner: "audit", kmsKeyId: "", objectLockMode: "NONE" as "COMPLIANCE" })).toEqual([
      "AUDIT_BUCKET_OWNER_INVALID",
      "AUDIT_OBJECT_LOCK_MODE_INVALID",
      "AUDIT_KMS_KEY_INVALID",
    ]);
  });

  it("[SPEC-13.4] declares kind live", () => {
    expect(new S3ObjectLockAuditSink(stub().client, config, clock).kind).toBe("live");
  });

  it("[SPEC-6.3] putBatch sends PutObject with Object Lock, retain-until from the approved class, SHA-256 checksum, IfNoneMatch and SSE-KMS", async () => {
    const { client, sent } = stub();
    const sink = new S3ObjectLockAuditSink(client, config, clock);
    const { manifest, ndjson } = batch(2);
    await sink.putBatch(manifest, ndjson);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toBeInstanceOf(PutObjectCommand);
    expect(sent[1]).toBeInstanceOf(PutObjectCommand);
    const retainUntil = new Date("2026-11-16T15:00:00.000Z");
    const common = {
      Bucket: "vsp-audit-evidence-synthetic",
      ChecksumAlgorithm: "SHA256",
      IfNoneMatch: "*",
      ObjectLockMode: "COMPLIANCE",
      ObjectLockRetainUntilDate: retainUntil,
      ServerSideEncryption: "aws:kms",
      SSEKMSKeyId: "arn:aws:kms:us-east-1:111122223333:key/synthetic-audit-key",
      ExpectedBucketOwner: "111122223333",
      Metadata: { "vsp-batch-digest": manifest.batchDigest, "vsp-retention-class": "security_audit" },
    };
    expect((sent[0] as PutObjectCommand).input).toEqual({
      ...common,
      Key: `audit/${STREAM}/000000000001-000000000002.ndjson`,
      Body: ndjson,
      ContentType: "application/x-ndjson",
      ChecksumSHA256: b64(ndjson),
    });
    expect((sent[1] as PutObjectCommand).input).toEqual({
      ...common,
      Key: `audit/${STREAM}/000000000001-000000000002.ndjson.manifest.json`,
      Body: canonicalJson(manifest),
      ContentType: "application/json",
      ChecksumSHA256: b64(canonicalJson(manifest)),
    });
  });

  it("[SPEC-6.3] GOVERNANCE mode is passed through from configuration", async () => {
    const { client, sent } = stub();
    const { manifest, ndjson } = batch(1);
    await new S3ObjectLockAuditSink(client, { ...config, objectLockMode: "GOVERNANCE" }, clock).putBatch(manifest, ndjson);
    expect((sent[0] as PutObjectCommand).input.ObjectLockMode).toBe("GOVERNANCE");
  });

  it("[ACT-02] head_checksum mode: a 412 on an identical object is an idempotent no-op proven by HeadObject checksum", async () => {
    const { manifest, ndjson } = batch(1);
    const { client, sent } = stub(async (cmd) => {
      if (cmd instanceof PutObjectCommand) throw Object.assign(new Error("PreconditionFailed"), { name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } });
      if (cmd instanceof HeadObjectCommand) {
        const key = cmd.input.Key ?? "";
        return { ChecksumSHA256: key.endsWith(".manifest.json") ? b64(canonicalJson(manifest)) : b64(ndjson) };
      }
      throw new Error("unexpected");
    });
    await new S3ObjectLockAuditSink(client, { ...config, existingObjectCheck: "head_checksum" }, clock).putBatch(manifest, ndjson);
    expect(sent.map((c) => (c as object).constructor.name)).toEqual(["PutObjectCommand", "HeadObjectCommand", "PutObjectCommand", "HeadObjectCommand"]);
    expect((sent[1] as HeadObjectCommand).input).toEqual({
      Bucket: "vsp-audit-evidence-synthetic",
      Key: `audit/${STREAM}/000000000001-000000000001.ndjson`,
      ChecksumMode: "ENABLED",
      ExpectedBucketOwner: "111122223333",
    });
  });

  it("[OPS-01] head_checksum mode: a 412 on a different object is refused as AUDIT_SINK_OBJECT_EXISTS (no overwrite)", async () => {
    const { manifest, ndjson } = batch(1);
    const { client } = stub(async (cmd) => {
      if (cmd instanceof PutObjectCommand) throw Object.assign(new Error("x"), { name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } });
      if (cmd instanceof HeadObjectCommand) return { ChecksumSHA256: b64("different content") };
      return {};
    });
    const headMode = { ...config, existingObjectCheck: "head_checksum" as const };
    await expect(new S3ObjectLockAuditSink(client, headMode, clock).putBatch(manifest, ndjson)).rejects.toMatchObject({ reasonCode: "AUDIT_SINK_OBJECT_EXISTS" });
    const { client: noChecksum } = stub(async (cmd) => {
      if (cmd instanceof PutObjectCommand) throw Object.assign(new Error("x"), { $metadata: { httpStatusCode: 412 } });
      return {};
    });
    await expect(new S3ObjectLockAuditSink(noChecksum, headMode, clock).putBatch(manifest, ndjson)).rejects.toMatchObject({ reasonCode: "AUDIT_SINK_OBJECT_EXISTS" });
  });

  it("[OPS-01] transport failures and 409 conflicts are retryable sink errors with reason codes only", async () => {
    const { manifest, ndjson } = batch(1);
    const { client } = stub(async () => {
      throw Object.assign(new Error("socket hang up with secret detail"), { $metadata: { httpStatusCode: 503 } });
    });
    const err = await new S3ObjectLockAuditSink(client, config, clock).putBatch(manifest, ndjson).catch((e: unknown) => e);
    expect(err).toMatchObject({ reasonCode: "AUDIT_SINK_PUT_FAILED", retryable: true, message: "AUDIT_SINK_PUT_FAILED" });
    const { client: c409 } = stub(async () => {
      throw Object.assign(new Error("x"), { name: "ConditionalRequestConflict", $metadata: { httpStatusCode: 409 } });
    });
    await expect(new S3ObjectLockAuditSink(c409, config, clock).putBatch(manifest, ndjson)).rejects.toMatchObject({ reasonCode: "AUDIT_SINK_CONDITIONAL_CONFLICT", retryable: true });
  });

  it("[SPEC-13.4] refuses an inconsistent batch before any request is sent", async () => {
    const { client, sent } = stub();
    const { manifest, ndjson } = batch(2);
    await expect(new S3ObjectLockAuditSink(client, config, clock).putBatch(manifest, `${ndjson}{}\n`)).rejects.toMatchObject({ reasonCode: "AUDIT_SINK_DIGEST_MISMATCH" });
    expect(sent).toHaveLength(0);
  });

  it("[SPEC-13.4] listManifests paginates ListObjectsV2 and reads each manifest with checksum validation", async () => {
    const { manifest } = batch(1);
    const manifestKey = `audit/${STREAM}/000000000001-000000000001.ndjson.manifest.json`;
    const { client, sent } = stub(async (cmd) => {
      if (cmd instanceof ListObjectsV2Command) {
        return cmd.input.ContinuationToken
          ? { Contents: [{ Key: manifestKey }], IsTruncated: false }
          : { Contents: [{ Key: `audit/${STREAM}/000000000001-000000000001.ndjson` }], IsTruncated: true, NextContinuationToken: "tok-2" };
      }
      if (cmd instanceof GetObjectCommand) return { Body: { transformToString: async () => canonicalJson(manifest) } };
      throw new Error("unexpected");
    });
    const listed = await new S3ObjectLockAuditSink(client, config, clock).listManifests(STREAM);
    expect(listed).toEqual([manifest]);
    expect((sent[0] as ListObjectsV2Command).input).toEqual({ Bucket: config.bucket, Prefix: `audit/${STREAM}/`, ContinuationToken: undefined, ExpectedBucketOwner: "111122223333" });
    expect((sent[1] as ListObjectsV2Command).input.ContinuationToken).toBe("tok-2");
    expect((sent[2] as GetObjectCommand).input).toEqual({ Bucket: config.bucket, Key: manifestKey, ChecksumMode: "ENABLED", ExpectedBucketOwner: "111122223333" });
  });

  it("[SPEC-13.4] getBatch validates the key grammar and maps NoSuchKey to AUDIT_SINK_OBJECT_MISSING", async () => {
    const { client } = stub(async () => {
      throw Object.assign(new Error("x"), { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } });
    });
    const sink = new S3ObjectLockAuditSink(client, config, clock);
    await expect(sink.getBatch("../../other-bucket/key")).rejects.toMatchObject({ reasonCode: "AUDIT_SINK_OBJECT_KEY_INVALID" });
    await expect(sink.getBatch(`${STREAM}/000000000001-000000000001.ndjson`)).rejects.toMatchObject({ reasonCode: "AUDIT_SINK_OBJECT_MISSING" });
  });
});
