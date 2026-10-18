/**
 * LIVE audit sink: S3 bucket with Object Lock in the separately administered
 * audit account (spec sections 3, 6 and 13).
 *
 * STATUS: BLOCKED for execution. The code path is written against the documented
 * S3 PutObject / HeadObject / GetObject / ListObjectsV2 APIs and is covered by a
 * contract test with an injected stub client only. Running it requires: the audit
 * account bucket created with Object Lock enabled (versioning on), the audit KMS
 * key, the cross-account roles of infra/terraform/modules/audit and a retention
 * duration for the SECURITY_AUDIT class approved by counsel. None exist yet.
 *
 * Identities (OPS-AUD-02; must match infra/terraform/modules/audit):
 *   - the WRITER role (shipper) may only s3:PutObject (+ kms:GenerateDataKey via S3); it is
 *     explicitly denied s3:GetObject* / s3:ListBucket* / kms:Decrypt, so it can never read
 *     evidence back (HeadObject is authorized as s3:GetObject, and returning the stored
 *     checksum of an SSE-KMS object needs kms:Decrypt);
 *   - the read-only VERIFIER role (audit.verify, IntegrityVerifier.verifyShipped) lists and
 *     reads; listManifests / getBatch are only used with that identity.
 *
 * Controls on every object:
 *   - ObjectLockMode (COMPLIANCE or GOVERNANCE from config) + ObjectLockRetainUntilDate
 *     derived from the APPROVED retention-class duration; a null duration refuses to run.
 *   - IfNoneMatch "*": S3 rejects overwriting an existing key (412 Precondition Failed).
 *     existingObjectCheck "defer_to_verifier" (default, matches the writer IAM): a 412 on
 *     the deterministic key of this batch (stream/first-last sequence) means the object is
 *     already stored (a lost response, or a crash before the manifest or the local mark);
 *     it is accepted WITHOUT reading it and counted in `existingObjectsUnverified`. The
 *     content is then proven by the verifier identity: verifyShipped compares the stored
 *     batch digest, manifest content and every still-present local row hash
 *     (MANIFEST_DIGEST_MISMATCH / LOCAL_SINK_DIVERGENCE), and local rows are purged only
 *     after a clean verification, so a foreign object at our key is detected, never lost.
 *     "head_checksum" (only for an identity that may HeadObject with kms:Decrypt): a 412 is
 *     accepted only if HeadObject (ChecksumMode ENABLED) proves the stored SHA-256 equals
 *     ours; otherwise AUDIT_SINK_OBJECT_EXISTS.
 *   - ChecksumAlgorithm SHA256 + ChecksumSHA256 so S3 verifies the body end to end.
 *   - SSE-KMS with the audit-account key; ExpectedBucketOwner pins the audit account.
 */
import { GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand } from "@aws-sdk/client-s3";
import type { S3Client } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { AuditManifest } from "../../protocol/index.js";
import type { AuditManifest as AuditManifestType } from "../../protocol/index.js";
import { canonicalJson } from "../../shared/canonical.js";
import type { Clock } from "../../shared/clock.js";
import { ConfigurationRejectedError } from "../../shared/errors.js";
import { OBJECT_KEY_RE } from "../chain.js";
import type { AuditSink } from "../ports.js";
import { AuditSinkError, MANIFEST_SUFFIX, assertBatchConsistent, assertStreamForListing } from "./common.js";

export interface S3ObjectLockAuditSinkConfig {
  /** Bucket in the audit account (created with Object Lock enabled). */
  bucket: string;
  /** 12-digit audit account id; sent as ExpectedBucketOwner on every request. */
  expectedBucketOwner: string;
  /** Optional key prefix, e.g. "audit/". */
  keyPrefix?: string;
  objectLockMode: "COMPLIANCE" | "GOVERNANCE";
  /** Retention class this sink stores. Only security/audit evidence is shipped here. */
  retentionClass: "SECURITY_AUDIT";
  /**
   * APPROVED retention duration in days for the class (PlatformConfig.retention.SECURITY_AUDIT).
   * null means counsel has not set it: the sink refuses to start (no invented retention).
   */
  retentionDays: number | null;
  /** Audit-account KMS key id or ARN for SSE-KMS. */
  kmsKeyId: string;
  /**
   * How a 412 (key already exists) is resolved; see the header. Default "defer_to_verifier",
   * the only mode compatible with the write-only writer role.
   */
  existingObjectCheck?: "defer_to_verifier" | "head_checksum";
}

/** Minimal client surface so tests inject a stub; production passes an S3Client. */
export type S3SendClient = Pick<S3Client, "send">;

const sha256Base64 = (body: string): string => createHash("sha256").update(body, "utf8").digest("base64");

function httpStatusOf(err: unknown): number | null {
  const meta = (err as { $metadata?: { httpStatusCode?: unknown } } | null)?.$metadata;
  return typeof meta?.httpStatusCode === "number" ? meta.httpStatusCode : null;
}

function errorNameOf(err: unknown): string | null {
  const name = (err as { name?: unknown } | null)?.name;
  return typeof name === "string" ? name : null;
}

export function validateS3SinkConfig(config: S3ObjectLockAuditSinkConfig): string[] {
  const violations: string[] = [];
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucket)) violations.push("AUDIT_BUCKET_INVALID");
  if (!/^\d{12}$/.test(config.expectedBucketOwner)) violations.push("AUDIT_BUCKET_OWNER_INVALID");
  if (config.keyPrefix !== undefined && !/^([a-z0-9_-]{1,32}\/){0,4}$/.test(config.keyPrefix)) violations.push("AUDIT_KEY_PREFIX_INVALID");
  if (config.objectLockMode !== "COMPLIANCE" && config.objectLockMode !== "GOVERNANCE") violations.push("AUDIT_OBJECT_LOCK_MODE_INVALID");
  if (config.retentionClass !== "SECURITY_AUDIT") violations.push("AUDIT_RETENTION_CLASS_INVALID");
  if (config.retentionDays === null || config.retentionDays === undefined) violations.push("AUDIT_RETENTION_UNAPPROVED");
  else if (!Number.isSafeInteger(config.retentionDays) || config.retentionDays < 1 || config.retentionDays > 36_500) {
    violations.push("AUDIT_RETENTION_INVALID");
  }
  if (!/^(arn:aws[a-z-]*:kms:[a-z0-9-]+:\d{12}:(key|alias)\/[A-Za-z0-9/_-]+|[A-Za-z0-9-]{8,128})$/.test(config.kmsKeyId)) {
    violations.push("AUDIT_KMS_KEY_INVALID");
  }
  if (config.existingObjectCheck !== undefined && config.existingObjectCheck !== "defer_to_verifier" && config.existingObjectCheck !== "head_checksum") {
    violations.push("AUDIT_EXISTING_OBJECT_CHECK_INVALID");
  }
  return violations;
}

export class S3ObjectLockAuditSink implements AuditSink {
  readonly kind = "live" as const;
  private readonly prefix: string;
  private readonly retentionDays: number;
  private readonly existingObjectCheck: "defer_to_verifier" | "head_checksum";
  /** Objects accepted on a 412 without reading them (content proven later by verifyShipped). */
  existingObjectsUnverified = 0;

  constructor(
    private readonly client: S3SendClient,
    private readonly config: S3ObjectLockAuditSinkConfig,
    private readonly clock: Clock,
  ) {
    const violations = validateS3SinkConfig(config);
    if (violations.length > 0 || config.retentionDays === null) throw new ConfigurationRejectedError(violations);
    this.retentionDays = config.retentionDays;
    this.prefix = config.keyPrefix ?? "";
    this.existingObjectCheck = config.existingObjectCheck ?? "defer_to_verifier";
  }

  async putBatch(manifest: AuditManifestType, eventsNdjson: string): Promise<void> {
    const m = assertBatchConsistent(manifest, eventsNdjson);
    const retainUntil = new Date(this.clock.now().getTime() + this.retentionDays * 86_400_000);
    // Body first, manifest last: a listed manifest implies its batch object exists.
    await this.putOnce(m.objectKey, eventsNdjson, "application/x-ndjson", retainUntil, m.batchDigest);
    await this.putOnce(`${m.objectKey}${MANIFEST_SUFFIX}`, canonicalJson(m), "application/json", retainUntil, m.batchDigest);
  }

  async listManifests(stream: string): Promise<AuditManifestType[]> {
    assertStreamForListing(stream);
    const keys: string[] = [];
    let token: string | undefined;
    do {
      let out: { Contents?: { Key?: string }[]; IsTruncated?: boolean; NextContinuationToken?: string };
      try {
        out = await this.client.send(
          new ListObjectsV2Command({
            Bucket: this.config.bucket,
            Prefix: `${this.prefix}${stream}/`,
            ContinuationToken: token,
            ExpectedBucketOwner: this.config.expectedBucketOwner,
          }),
        );
      } catch {
        throw new AuditSinkError("AUDIT_SINK_UNAVAILABLE", true);
      }
      for (const o of out.Contents ?? []) if (o.Key?.endsWith(MANIFEST_SUFFIX)) keys.push(o.Key);
      token = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (token);

    const manifests: AuditManifestType[] = [];
    for (const key of keys.sort()) {
      const raw = await this.getObjectText(key);
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        throw new AuditSinkError("AUDIT_SINK_MANIFEST_INVALID");
      }
      const parsed = AuditManifest.safeParse(json);
      if (!parsed.success || `${this.prefix}${parsed.data.objectKey}${MANIFEST_SUFFIX}` !== key) {
        throw new AuditSinkError("AUDIT_SINK_MANIFEST_INVALID");
      }
      manifests.push(parsed.data);
    }
    return manifests.sort((a, b) => a.firstSequence - b.firstSequence || a.lastSequence - b.lastSequence);
  }

  async getBatch(objectKey: string): Promise<string> {
    if (!OBJECT_KEY_RE.test(objectKey)) throw new AuditSinkError("AUDIT_SINK_OBJECT_KEY_INVALID");
    return this.getObjectText(`${this.prefix}${objectKey}`);
  }

  private async getObjectText(key: string): Promise<string> {
    try {
      const out = await this.client.send(
        new GetObjectCommand({
          Bucket: this.config.bucket,
          Key: key,
          ChecksumMode: "ENABLED",
          ExpectedBucketOwner: this.config.expectedBucketOwner,
        }),
      );
      if (!out.Body) throw new AuditSinkError("AUDIT_SINK_OBJECT_MISSING");
      return await out.Body.transformToString("utf-8");
    } catch (err) {
      if (err instanceof AuditSinkError) throw err;
      if (errorNameOf(err) === "NoSuchKey" || httpStatusOf(err) === 404) throw new AuditSinkError("AUDIT_SINK_OBJECT_MISSING");
      throw new AuditSinkError("AUDIT_SINK_UNAVAILABLE", true);
    }
  }

  private async putOnce(logicalKey: string, body: string, contentType: string, retainUntil: Date, batchDigest: string): Promise<void> {
    const key = `${this.prefix}${logicalKey}`;
    const checksum = sha256Base64(body);
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          ChecksumAlgorithm: "SHA256",
          ChecksumSHA256: checksum,
          IfNoneMatch: "*",
          ObjectLockMode: this.config.objectLockMode,
          ObjectLockRetainUntilDate: retainUntil,
          ServerSideEncryption: "aws:kms",
          SSEKMSKeyId: this.config.kmsKeyId,
          ExpectedBucketOwner: this.config.expectedBucketOwner,
          Metadata: { "vsp-batch-digest": batchDigest, "vsp-retention-class": this.config.retentionClass.toLowerCase() },
        }),
      );
      return;
    } catch (err) {
      const status = httpStatusOf(err);
      const name = errorNameOf(err);
      if (status === 409 || name === "ConditionalRequestConflict") throw new AuditSinkError("AUDIT_SINK_CONDITIONAL_CONFLICT", true);
      if (status !== 412 && name !== "PreconditionFailed") throw new AuditSinkError("AUDIT_SINK_PUT_FAILED", true);
    }
    // The key exists.
    if (this.existingObjectCheck === "defer_to_verifier") {
      // Write-only identity: never read evidence back. The key is deterministic for this batch;
      // the verifier identity proves the stored content (verifyShipped) before any local purge.
      this.existingObjectsUnverified += 1;
      return;
    }
    // head_checksum: idempotent only if S3's stored SHA-256 equals ours.
    let existing: string | undefined;
    try {
      const head = await this.client.send(
        new HeadObjectCommand({
          Bucket: this.config.bucket,
          Key: key,
          ChecksumMode: "ENABLED",
          ExpectedBucketOwner: this.config.expectedBucketOwner,
        }),
      );
      existing = head.ChecksumSHA256;
    } catch {
      throw new AuditSinkError("AUDIT_SINK_UNAVAILABLE", true);
    }
    if (existing !== checksum) throw new AuditSinkError("AUDIT_SINK_OBJECT_EXISTS");
  }
}
