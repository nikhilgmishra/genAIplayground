/**
 * Layer 2 (WP-04, FO-15-38): manifest signature findings reach the separate verifier's VERDICT over real
 * protocols — postgres:16 (provisioned as on Aurora), MinIO with Object Lock (versioned bucket, GOVERNANCE
 * retention) and LocalStack KMS (ECC_NIST_P256 SIGN_VERIFY manifest key; the verifier trusts its public key only).
 *
 * The insider holds the exporter's WRITER session credentials (STS session policy: put only, enforced by MinIO).
 * It cannot delete or rewrite a locked manifest version, but it can put a NEW version at the same key without the
 * sink's write-once precondition (If-None-Match), and the reader then reads that latest version. A manifest whose
 * signature, signedAt and signerRole were stripped must FAIL the run as MANIFEST_UNSIGNED; one that carries another
 * manifest's signature under the trusted KMS key must FAIL it as MANIFEST_SIGNATURE_INVALID. The locked original
 * version stays in the bucket. Own database and bucket: the forged manifests must not reach other files' verdicts.
 */
import { CreateBucketCommand, GetObjectRetentionCommand, ListObjectVersionsCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import type { S3Client } from "@aws-sdk/client-s3";
import { CreateKeyCommand } from "@aws-sdk/client-kms";
import type { KMSClient } from "@aws-sdk/client-kms";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect } from "vitest";
import { buildAuditInput } from "../../../src/audit/build-input.js";
import { AuditExporter } from "../../../src/audit/exporter/exporter.js";
import { KmsManifestSigner, ManifestSignatureVerifier } from "../../../src/audit/exporter/signer.js";
import { sinkReaderPolicy, sinkWriterPolicy } from "../../../src/audit/exporter/sts.js";
import { AuditExportVerifier } from "../../../src/audit/exporter/verifier.js";
import { MANIFEST_SUFFIX } from "../../../src/audit/sinks/common.js";
import { S3ObjectLockAuditSink } from "../../../src/audit/sinks/s3-object-lock.js";
import type { S3ObjectLockAuditSinkConfig } from "../../../src/audit/sinks/s3-object-lock.js";
import { PgAuditWriter } from "../../../src/audit/writer.js";
import type { Db } from "../../../src/db/types.js";
import type { AuditManifest } from "../../../src/protocol/index.js";
import { canonicalJson } from "../../../src/shared/canonical.js";
import { iso, systemClock } from "../../../src/shared/clock.js";
import { newId } from "../../../src/shared/ids.js";
import { kmsClient, s3Client, SYNTHETIC_ACCOUNT, uniqueName } from "../_harness/clients.js";
import { localEnv } from "../_harness/env.js";
import { layer2, layer2Context } from "../_harness/layer2.js";
import { createAuroraLikeDb, sinkClient } from "./support.js";
import type { AuroraLikeDb } from "./support.js";

const it = layer2(["postgres", "minio", "localstack"]);
const STREAM = "gateway.signatures-it";
let adb: AuroraLikeDb;
let s3: S3Client;
let kms: KMSClient;
let bucket: string;
let signKeyArn: string;
let verifierDb: Db;
let writerS3: S3Client;
let readerS3: S3Client;

const sinkConfig = (): S3ObjectLockAuditSinkConfig => ({
  bucket,
  expectedBucketOwner: SYNTHETIC_ACCOUNT,
  keyPrefix: "audit/",
  objectLockMode: "GOVERNANCE",
  retentionClass: "SECURITY_AUDIT",
  retentionDays: 1, // SYNTHETIC TEST VALUE: the real duration is approved by counsel (activation register)
  kmsKeyId: localEnv().minioKmsKeyId,
});

const window = () => ({ from: iso(new Date(Date.now() - 3_600_000)), to: iso(new Date(Date.now() + 3_600_000)) });
const manifestKey = (m: AuditManifest) => `audit/${m.objectKey}${MANIFEST_SUFFIX}`;

/** The insider's put: a new version at the manifest's key with the WRITER credentials, without If-None-Match. */
async function putManifestVersion(m: AuditManifest): Promise<void> {
  const body = canonicalJson(m);
  await writerS3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: manifestKey(m),
      Body: body,
      ContentType: "application/json",
      ChecksumAlgorithm: "SHA256",
      ChecksumSHA256: createHash("sha256").update(body, "utf8").digest("base64"),
      ServerSideEncryption: "aws:kms",
      SSEKMSKeyId: localEnv().minioKmsKeyId,
    }),
  );
}

async function run() {
  const keys = new ManifestSignatureVerifier();
  expect(await keys.trustKms(kms, signKeyArn)).toBe(signKeyArn);
  return new AuditExportVerifier({ db: verifierDb, sink: new S3ObjectLockAuditSink(readerS3, sinkConfig(), systemClock), signatures: keys, clock: systemClock }).run(window());
}

describe("manifest signatures in the verdict (insider with the exporter's writer credentials)", () => {
  beforeAll(async () => {
    const l2 = layer2Context(["postgres", "minio", "localstack"]);
    adb = await createAuroraLikeDb(l2);
    s3 = s3Client(l2);
    kms = kmsClient(l2);
    bucket = uniqueName("vsp-it-audit-sig");
    await s3.send(new CreateBucketCommand({ Bucket: bucket, ObjectLockEnabledForBucket: true }));
    const key = await kms.send(new CreateKeyCommand({ KeySpec: "ECC_NIST_P256", KeyUsage: "SIGN_VERIFY", Description: "SYNTHETIC audit manifest key (Layer 2)" }));
    signKeyArn = key.KeyMetadata?.Arn ?? "";
    verifierDb = (await adb.login(["app_audit_verifier"])).db;
    writerS3 = await sinkClient(l2, sinkWriterPolicy(bucket), "vsp-audit-exporter-sig-it");
    readerS3 = await sinkClient(l2, sinkReaderPolicy(bucket), "vsp-audit-verifier-sig-it");
  });
  afterAll(async () => {
    await adb?.drop();
  });

  it("[FO-15-38][FO-15-37][OPS-01] adversarial: a manifest version stripped of its signature FAILs the run as MANIFEST_UNSIGNED, one carrying another manifest's KMS signature as MANIFEST_SIGNATURE_INVALID; the locked original versions remain", async () => {
    const tenantId = newId("tnt");
    const w = new PgAuditWriter({ db: adb.db, clock: systemClock, stream: STREAM });
    for (let i = 0; i < 4; i++) await w.appendStandalone(buildAuditInput({ tenantId, correlationId: newId("cor"), sourceComponent: "gateway", action: "tool.invoke", outcome: "SUCCEEDED" }, systemClock));
    const writerSink = new S3ObjectLockAuditSink(writerS3, sinkConfig(), systemClock);
    expect(await new AuditExporter({ db: adb.db, sink: writerSink, signer: new KmsManifestSigner(kms, signKeyArn, systemClock), clock: systemClock, batchSize: 2 }).runOnce()).toMatchObject({ failedStreams: 0, eventsShipped: 4 });
    const [first, second] = await new S3ObjectLockAuditSink(readerS3, sinkConfig(), systemClock).listManifests(STREAM);
    if (!first?.signature || !second?.signature) throw new Error("expected two KMS-signed manifests");
    expect([first.signature.keyRef, second.signature.keyRef]).toEqual([signKeyArn, signKeyArn]);
    const intact = await run();
    expect(intact).toMatchObject({ verdict: "PASS", signatures: { manifests: 2, valid: 2, unsigned: 0, invalid: 0, untrustedKey: 0, partial: 0 } });

    // (a) The first manifest without signature, signedAt and signerRole.
    const { signature: _sig, signedAt: _at, signerRole: _role, ...stripped } = first;
    await putManifestVersion(stripped);
    const unsigned = await run();
    expect(unsigned.signatures).toEqual({ manifests: 2, valid: 1, unsigned: 1, invalid: 0, untrustedKey: 0, partial: 0 });
    expect(unsigned.verdict).toBe("FAIL");
    expect(unsigned.reasonCodes).toContain("MANIFEST_SIGNATURE_FINDINGS");
    expect(unsigned.findings).toEqual([{ code: "MANIFEST_UNSIGNED", sourceStream: STREAM, sequence: first.firstSequence, manifestId: first.manifestId }]);

    // (b) The second manifest carrying the first one's signature: trusted keyRef, signature over other content.
    await putManifestVersion({ ...second, signature: first.signature, signedAt: first.signedAt });
    const forged = await run();
    expect(forged.signatures).toEqual({ manifests: 2, valid: 0, unsigned: 1, invalid: 1, untrustedKey: 0, partial: 0 });
    expect(forged.verdict).toBe("FAIL");
    expect(forged.findings).toEqual([
      { code: "MANIFEST_UNSIGNED", sourceStream: STREAM, sequence: first.firstSequence, manifestId: first.manifestId },
      { code: "MANIFEST_SIGNATURE_INVALID", sourceStream: STREAM, sequence: second.firstSequence, manifestId: second.manifestId },
    ]);

    // Object Lock kept each original (GOVERNANCE) version next to the insider's new one.
    for (const m of [first, second]) {
      const versions = (await s3.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: manifestKey(m) }))).Versions ?? [];
      expect(versions.filter((v) => v.Key === manifestKey(m))).toHaveLength(2);
      const original = versions.find((v) => v.Key === manifestKey(m) && !v.IsLatest);
      const retention = await s3.send(new GetObjectRetentionCommand({ Bucket: bucket, Key: manifestKey(m), VersionId: original?.VersionId }));
      expect(retention.Retention?.Mode).toBe("GOVERNANCE");
    }
  });
});
