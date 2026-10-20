/**
 * OPS-AUD-02 CONTRACT TEST with an in-memory STUB S3 that models (a) S3 conditional writes
 * (IfNoneMatch "*" -> 412 when the key exists) and (b) the IAM of
 * infra/terraform/modules/audit: the WRITER role may only PutObject (HeadObject / GetObject /
 * ListObjectsV2 -> 403, explicit deny + bucket policy DenyReadsExceptAuditorRole), the read-only
 * VERIFIER role may list and read but never put. No AWS call is made; SYNTHETIC events only.
 */
import { GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PgliteDb } from "../../db/pglite.js";
import { FakeClock } from "../../shared/clock.js";
import { PgAuditHealth } from "../health.js";
import { KmsManifestSigner, ManifestSignatureVerifier } from "../exporter/signer.js";
import { KmsSignStubFixture } from "../exporter/testing.js";
import { AuditShipper } from "../shipper.js";
import { appendMany, createAuditTestDb } from "../testing.js";
import { IntegrityVerifier } from "../verifier.js";
import { PgAuditWriter } from "../writer.js";
import { S3ObjectLockAuditSink } from "./s3-object-lock.js";
import type { S3ObjectLockAuditSinkConfig, S3SendClient } from "./s3-object-lock.js";

const STREAM = "actions.synth-1";
const config: S3ObjectLockAuditSinkConfig = {
  bucket: "vsp-audit-evidence-synthetic",
  expectedBucketOwner: "111122223333",
  keyPrefix: "audit/",
  objectLockMode: "COMPLIANCE",
  retentionClass: "SECURITY_AUDIT",
  retentionDays: 30, // SYNTHETIC TEST VALUE ONLY — the real duration must be approved by counsel
  kmsKeyId: "arn:aws:kms:us-east-1:111122223333:key/synthetic-audit-key",
};

const denied = () => Object.assign(new Error("AccessDenied"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } });

/** One bucket, two identities with the Terraform permissions, optional lost responses on puts. */
class ModelledBucketFixture {
  readonly objects = new Map<string, { body: string; checksum: string }>();
  readonly calls: { identity: "writer" | "verifier"; command: string }[] = [];
  /** Put attempt numbers (1-based, writer identity) whose object is stored but whose response is lost. */
  loseResponseOfPut = new Set<number>();
  private puts = 0;

  client(identity: "writer" | "verifier"): S3SendClient {
    return {
      send: async (cmd: unknown) => {
        this.calls.push({ identity, command: (cmd as object).constructor.name });
        if (cmd instanceof PutObjectCommand) {
          if (identity !== "writer") throw denied();
          const key = cmd.input.Key ?? "";
          if (this.objects.has(key)) throw Object.assign(new Error("PreconditionFailed"), { name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } });
          const body = String(cmd.input.Body);
          const checksum = createHash("sha256").update(body, "utf8").digest("base64");
          if (checksum !== cmd.input.ChecksumSHA256) throw Object.assign(new Error("BadDigest"), { name: "BadDigest", $metadata: { httpStatusCode: 400 } });
          this.objects.set(key, { body, checksum });
          this.puts += 1;
          if (this.loseResponseOfPut.has(this.puts)) throw Object.assign(new Error("socket hang up"), { name: "TimeoutError" });
          return {};
        }
        if (identity === "writer") throw denied(); // HeadObject / GetObject / ListObjectsV2
        if (cmd instanceof HeadObjectCommand) {
          const o = this.objects.get(cmd.input.Key ?? "");
          if (!o) throw Object.assign(new Error("NotFound"), { name: "NotFound", $metadata: { httpStatusCode: 404 } });
          return { ChecksumSHA256: o.checksum };
        }
        if (cmd instanceof GetObjectCommand) {
          const o = this.objects.get(cmd.input.Key ?? "");
          if (!o) throw Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } });
          return { Body: { transformToString: async () => o.body } };
        }
        if (cmd instanceof ListObjectsV2Command) {
          const prefix = cmd.input.Prefix ?? "";
          return { Contents: [...this.objects.keys()].filter((k) => k.startsWith(prefix)).map((Key) => ({ Key })), IsTruncated: false };
        }
        throw new Error("unexpected command");
      },
    } as unknown as S3SendClient;
  }
}

let db: PgliteDb;
let clock: FakeClock;
let bucket: ModelledBucketFixture;
let writerSink: S3ObjectLockAuditSink;
let verifierSink: S3ObjectLockAuditSink;
let kms: KmsSignStubFixture;
/** Live sinks receive signed manifests only (FO-15-38); the KMS here is a labelled in-process stub. */
const signer = () => new KmsManifestSigner(kms, kms.keyArn, clock);

beforeEach(async () => {
  db = await createAuditTestDb();
  clock = new FakeClock("2026-10-17T15:00:00.000Z");
  bucket = new ModelledBucketFixture();
  writerSink = new S3ObjectLockAuditSink(bucket.client("writer"), config, clock);
  verifierSink = new S3ObjectLockAuditSink(bucket.client("verifier"), config, clock);
  kms = new KmsSignStubFixture();
});
afterEach(async () => {
  await db.close();
});

const writer = () => new PgAuditWriter({ db, clock, stream: STREAM });
const append = (n: number) => {
  const w = writer();
  return appendMany(n, (i) => w.appendStandalone(i), clock);
};

describe("S3 sink recovery under the repository's audit IAM (OPS-AUD-02)", () => {
  it("[OPS-01][ACT-02][OPS-AUD-02] a lost PutObject response (batch body or manifest) recovers on the next run without the writer ever reading evidence", async () => {
    await append(3);
    const shipper = new AuditShipper({ db, sink: writerSink, clock, batchSize: 10, signer: signer() });
    bucket.loseResponseOfPut = new Set([1]); // body stored, response lost
    expect((await shipper.runOnce()).failedStreams).toBe(1);
    const second = await shipper.runOnce();
    expect(second).toMatchObject({ batchesShipped: 1, eventsShipped: 3, failedStreams: 0 });
    expect(writerSink.existingObjectsUnverified).toBe(1);

    await append(2);
    bucket.loseResponseOfPut = new Set([4]); // put 3 = second batch body, put 4 = its manifest: stored, response lost
    expect((await shipper.runOnce()).failedStreams).toBe(1);
    expect(await shipper.runOnce()).toMatchObject({ batchesShipped: 1, eventsShipped: 2, failedStreams: 0 });
    expect(writerSink.existingObjectsUnverified).toBe(3);
    // The writer identity only ever sent PutObject (no HeadObject / GetObject / List, which IAM denies).
    expect(new Set(bucket.calls.filter((c) => c.identity === "writer").map((c) => c.command))).toEqual(new Set(["PutObjectCommand"]));
    // The read-only verifier identity proves what was stored, and marks it verified (purge precondition).
    const v = await new IntegrityVerifier({ db, sink: verifierSink, clock }).verifyShipped(STREAM, { markVerified: true });
    expect(v.findings).toEqual([]);
    expect(v.checkedEvents).toBe(5);
  });

  it("[OPS-01][OPS-AUD-02] after a lost response the stream drains, so AuditHealth never wedges consequential actions on AUDIT_SINK_STALE", async () => {
    const health = new PgAuditHealth({ db, clock, policy: { maxBacklog: 1_000, maxBacklogAgeSeconds: 300 }, probeId: "s3-iam-model" });
    await append(4);
    const shipper = new AuditShipper({ db, sink: writerSink, clock, batchSize: 10, signer: signer() });
    bucket.loseResponseOfPut = new Set([2]); // manifest stored, response lost
    await shipper.runOnce();
    clock.advanceSeconds(301); // past the bounded buffering age while the batch is in doubt
    await shipper.runOnce();
    const status = await health.status();
    expect(status).toMatchObject({ canAcceptConsequential: true, backlogCount: 0, reasonCode: null });
    await expect(health.assertCanAcceptConsequential()).resolves.toBeUndefined();
  });

  it("[OPS-01][OPS-AUD-02] a foreign object at the batch key is accepted by the write-only writer but detected by the verifier identity and never marked verified", async () => {
    await append(2);
    // Someone holding writer credentials pre-planted a forged body at the deterministic key of batch 1.
    const key = `audit/${STREAM}/000000000001-000000000002.ndjson`;
    const forged = "{\"forged\":true}\n";
    bucket.objects.set(key, { body: forged, checksum: createHash("sha256").update(forged, "utf8").digest("base64") });
    const shipper = new AuditShipper({ db, sink: writerSink, clock, batchSize: 10, signer: signer() });
    expect((await shipper.runOnce()).failedStreams).toBe(0);
    const verifier = new IntegrityVerifier({ db, sink: verifierSink, clock });
    const v = await verifier.verifyShipped(STREAM, { markVerified: true });
    expect(v.ok).toBe(false);
    expect(v.findings.map((f) => f.code)).toEqual(expect.arrayContaining(["MANIFEST_DIGEST_MISMATCH"]));
    const verified = await db.tx((tx) => tx.query<{ n: string }>("select count(*)::text as n from audit_manifests where verified_at is not null"), { role: "owner" });
    expect(verified.rows[0]?.n).toBe("0");
  });

  it("[OPS-AUD-02] head_checksum mode needs a reader identity: under the writer IAM it reports a retryable sink error instead of guessing", async () => {
    await append(1);
    const headSink = new S3ObjectLockAuditSink(bucket.client("writer"), { ...config, existingObjectCheck: "head_checksum" }, clock);
    bucket.loseResponseOfPut = new Set([1]);
    const shipper = new AuditShipper({ db, sink: headSink, clock, batchSize: 10, signer: signer() });
    await shipper.runOnce();
    const r = await shipper.runOnce();
    expect(r.streams[0]?.reasonCode).toBe("AUDIT_SINK_UNAVAILABLE");
  });

  it("[FO-15-38][OPS-01] a live sink refuses unsigned export, and every manifest the writer stores is signed and verifies with the public key only", async () => {
    expect(() => new AuditShipper({ db, sink: writerSink, clock })).toThrow("AUDIT_MANIFEST_SIGNER_REQUIRED");
    await append(3);
    const shipper = new AuditShipper({ db, sink: writerSink, clock, batchSize: 2, signer: signer() });
    expect((await shipper.runOnce()).batchesShipped).toBe(2);
    const manifests = await verifierSink.listManifests(STREAM);
    expect(manifests).toHaveLength(2);
    const check = new ManifestSignatureVerifier().trust(kms.keyArn, kms.publicKey);
    expect(manifests.map((m) => check.check(m))).toEqual(["VALID", "VALID"]);
    // The PLANNED record and the sink copy are the same signed manifest (re-puts are byte-identical).
    const local = await db.tx((tx) => tx.query<{ manifest: { signature?: unknown } }>("select manifest from audit_manifests order by first_sequence"), { role: "owner" });
    expect(local.rows.every((r) => r.manifest.signature !== undefined)).toBe(true);
    // A tampered manifest field or an untrusted key is a finding, never VALID.
    const m0 = manifests[0];
    if (!m0) throw new Error("no manifest");
    expect(check.check({ ...m0, lastSequence: m0.lastSequence + 1 })).toBe("INVALID");
    expect(new ManifestSignatureVerifier().check(m0)).toBe("UNTRUSTED_KEY");
    const { signature: _s, signedAt: _a, signerRole: _r, ...unsigned } = m0;
    expect(check.check(unsigned)).toBe("UNSIGNED");
    expect(check.check({ ...unsigned, signedAt: m0.signedAt })).toBe("PARTIAL");
  });
});
