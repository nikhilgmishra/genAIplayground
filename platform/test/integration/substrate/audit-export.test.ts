/**
 * Layer 2 (WP-04): the independent audit export end to end over real protocols — postgres:16 (provisioned as on
 * Aurora), MinIO with Object Lock (the audit-account bucket), LocalStack KMS (asymmetric manifest key).
 *
 * FO-01-13 / FO-15-37 / FO-22-08: the exporter ships Object-Lock objects (retention, checksum, SSE-KMS) and the
 * verifier proves completeness. FO-15-38: every manifest is signed by KMS and verified with the public key only.
 * FO-15-40 / FO-15-42: the verifier runs on its OWN login (granted app_audit_verifier only) with sink READER
 * credentials (STS session policy: list + get, enforced by MinIO), the exporter with WRITER credentials (put
 * only); a verifier on the application login, the migration owner or the administrator gives no verdict;
 * INCONCLUSIVE without a sink reader (also with exported committed actions: shipped evidence is unverified, never
 * missing), while a finding the verifier can see locally still FAILs.
 * FO-15-41: committed-action, provider-receipt, CRM-write and route evidence reconciliation (a perfect chain that
 * omits an event fails). FO-19-82: scripts/vsp/verify-audit.mts exits 0 on an intact chain with a committed action,
 * exactly 2 (INCONCLUSIVE) on the same database without a sink reader, and 1 after a deleted event (with and
 * without the sink reader). Also KmsAssertionSigner and KmsEnvelopeCipher against LocalStack KMS.
 */
import { CreateBucketCommand, GetObjectCommand, GetObjectRetentionCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand } from "@aws-sdk/client-s3";
import type { S3Client } from "@aws-sdk/client-s3";
import { CreateKeyCommand } from "@aws-sdk/client-kms";
import type { KMSClient } from "@aws-sdk/client-kms";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { compactVerify, importJWK } from "jose";
import { afterAll, beforeAll, describe, expect } from "vitest";
import { buildAuditInput } from "../../../src/audit/build-input.js";
import { AuditExporter } from "../../../src/audit/exporter/exporter.js";
import { KmsManifestSigner, ManifestSignatureVerifier } from "../../../src/audit/exporter/signer.js";
import { assumeRoleWithSessionPolicy, sinkReaderPolicy, sinkWriterPolicy } from "../../../src/audit/exporter/sts.js";
import { AuditExportVerifier } from "../../../src/audit/exporter/verifier.js";
import { LOCAL_STS_HOST } from "../../../src/audit/exporter/verify-cli.js";
import { MANIFEST_SUFFIX } from "../../../src/audit/sinks/common.js";
import { S3ObjectLockAuditSink } from "../../../src/audit/sinks/s3-object-lock.js";
import type { S3ObjectLockAuditSinkConfig } from "../../../src/audit/sinks/s3-object-lock.js";
import { PgAuditWriter } from "../../../src/audit/writer.js";
import { PgPoolDb } from "../../../src/db/pg.js";
import type { Db } from "../../../src/db/types.js";
import { KmsAssertionSigner } from "../../../src/identity/assertions/signers.js";
import { KmsEnvelopeCipher } from "../../../src/ingress/cipher.js";
import { iso, systemClock } from "../../../src/shared/clock.js";
import { newId } from "../../../src/shared/ids.js";
import { kmsClient, postgresUrl, s3Client, SYNTHETIC_ACCOUNT, uniqueName } from "../_harness/clients.js";
import { localEnv, REPO_ROOT } from "../_harness/env.js";
import { layer2, layer2Context } from "../_harness/layer2.js";
import { allow, confirmedAction, createSorDatabase, ledgerReplica } from "./reference-sor.js";
import { createAuroraLikeDb, localStsHttp, sinkClient } from "./support.js";
import type { AuroraLikeDb } from "./support.js";

const it = layer2(["postgres", "minio", "localstack"]);
let adb: AuroraLikeDb;
let s3: S3Client;
let kms: KMSClient;
let bucket: string;
let signKeyArn: string;
/** The verifier's own login (granted app_audit_verifier only). */
let verifierDb: Db;
/** Exporter: put-only session credentials; verifier: list/get-only session credentials (MinIO-enforced). */
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

async function appendEvents(stream: string, tenantId: string, n: number, action = "tool.invoke"): Promise<void> {
  const w = new PgAuditWriter({ db: adb.db, clock: systemClock, stream });
  for (let i = 0; i < n; i++) await w.appendStandalone(buildAuditInput({ tenantId, correlationId: newId("cor"), sourceComponent: "gateway", action, outcome: "SUCCEEDED" }, systemClock));
}

/** A support request synchronised to the CRM, exactly as SupportRequestService records it (SYNCING -> SYNCED in one tx with its audit event when `audited`). */
async function syncedSupportRequest(tenantId: string, audited: boolean): Promise<string> {
  const srId = newId("sr");
  const callId = newId("call");
  const intId = newId("int");
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const pick = () => Array.from(randomBytes(4), (b) => alphabet.charAt(b % alphabet.length)).join("");
  const ref = `SR-${pick()}-${pick()}`;
  await adb.db.tx(
    async (tx) => {
      await tx.query("insert into support_interactions (interaction_external_id, tenant_id, call_id, language, consent_status, started_at, created_at) values ($1, $2, $3, 'en', 'GRANTED', now(), now())", [intId, tenantId, callId]);
      await tx.query(
        `insert into support_requests (support_request_id, tenant_id, reference_number, interaction_external_id, issue_external_id, call_id, issue_category, disposition,
           owner_queue, priority, summary, summary_template_id, summary_provenance, attempted, commit_receipt_ids, source_call_ids, language, consent, versions,
           restricted, sync_state, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, 'general_question', 'REQUEST_ACCEPTED', 'q_general', 'P3_STANDARD', 'Synthetic support request', 'summary.general_question',
           'template_assembled', '[]', '[]', $7::jsonb, 'en', '{}', '{}', false, 'PENDING', now(), now())`,
        [srId, tenantId, ref, intId, newId("iss"), callId, JSON.stringify([callId])],
      );
    },
    { role: "app_runtime", rls: { tenantId } },
  );
  const writer = new PgAuditWriter({ db: adb.db, clock: systemClock, stream: "worker.crm-sync-it", standaloneRole: "app_worker" });
  await adb.db.tx(
    async (tx) => {
      await tx.query("update support_requests set sync_state = 'SYNCING', sync_claim_token = $2, last_sync_attempt_at = now(), sync_attempts = 1, row_version = row_version + 1, updated_at = now() where support_request_id = $1", [srId, newId("scl")]);
      await tx.query("update support_requests set sync_state = 'SYNCED', salesforce_case_id = $2, synced_at = now(), sync_claim_token = null, row_version = row_version + 1, updated_at = now() where support_request_id = $1", [srId, `500${newId("x1").slice(3, 15).replace(/[^A-Za-z0-9]/g, "a")}`]);
      if (audited) {
        await writer.append(tx, buildAuditInput({ tenantId, correlationId: srId, sourceComponent: "worker", action: "support_request.synced", outcome: "SUCCEEDED", evidencePointers: [`db://support_requests/${srId}`], dataClass: "BUSINESS_RECORD" }, systemClock), "worker.crm-sync-it");
      }
    },
    { role: "app_worker", rls: { tenantId } },
  );
  return srId;
}

function verifier(sink: S3ObjectLockAuditSink | null, signatures: ManifestSignatureVerifier | null, db: Db = verifierDb) {
  return new AuditExportVerifier({ db, sink, signatures, clock: systemClock });
}

const writerSink = () => new S3ObjectLockAuditSink(writerS3, sinkConfig(), systemClock);
const readerSink = () => new S3ObjectLockAuditSink(readerS3, sinkConfig(), systemClock);

describe("independent audit export: exporter, signed manifests, separate verifier, verify-audit", () => {
  beforeAll(async () => {
    const l2 = layer2Context(["postgres", "minio", "localstack"]);
    adb = await createAuroraLikeDb(l2);
    s3 = s3Client(l2);
    kms = kmsClient(l2);
    bucket = uniqueName("vsp-it-audit-export");
    await s3.send(new CreateBucketCommand({ Bucket: bucket, ObjectLockEnabledForBucket: true }));
    const key = await kms.send(new CreateKeyCommand({ KeySpec: "ECC_NIST_P256", KeyUsage: "SIGN_VERIFY", Description: "SYNTHETIC audit manifest key (Layer 2)" }));
    signKeyArn = key.KeyMetadata?.Arn ?? "";
    verifierDb = (await adb.login(["app_audit_verifier"])).db;
    writerS3 = await sinkClient(l2, sinkWriterPolicy(bucket), "vsp-audit-exporter-it");
    readerS3 = await sinkClient(l2, sinkReaderPolicy(bucket), "vsp-audit-verifier-it");
  });
  afterAll(async () => {
    await adb?.drop();
  });

  it("[FO-01-13][FO-15-37][FO-15-38][FO-22-08][OPS-01] the exporter ships Object-Lock objects with signed manifests; the separate verifier (read-only DB role, sink reader, public key only) returns PASS", async () => {
    const tenantId = newId("tnt");
    await appendEvents("gateway.export-it", tenantId, 5);
    const exporter = new AuditExporter({ db: adb.db, sink: writerSink(), signer: new KmsManifestSigner(kms, signKeyArn, systemClock), clock: systemClock, batchSize: 2 });
    const r = await exporter.runOnce();
    expect(r).toMatchObject({ failedStreams: 0, eventsShipped: 5 });
    const reader = readerSink();
    const manifests = await reader.listManifests("gateway.export-it");
    expect(manifests).toHaveLength(3);
    expect(manifests.every((m) => m.signature?.keyRef === signKeyArn && m.signerRole === "audit_exporter")).toBe(true);
    const key = `audit/${manifests[0]?.objectKey}${MANIFEST_SUFFIX}`;
    const ret = await s3.send(new GetObjectRetentionCommand({ Bucket: bucket, Key: key }));
    expect(ret.Retention?.Mode).toBe("GOVERNANCE");
    expect((await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))).ServerSideEncryption).toBe("aws:kms");
    const keys = new ManifestSignatureVerifier();
    expect(await keys.trustKms(kms, signKeyArn)).toBe(signKeyArn);
    const report = await verifier(reader, keys).run(window());
    expect(report.identity).toEqual({ role: "app_audit_verifier", readOnly: true, findings: [] });
    expect(report.signatures).toMatchObject({ manifests: 3, valid: 3, invalid: 0, unsigned: 0, untrustedKey: 0 });
    expect(report).toMatchObject({ verdict: "PASS", integrityFindings: 0, ingestionGaps: 0 });
  });

  it("[FO-15-40][OPS-03] without the sink reader the same verifier is INCONCLUSIVE, never PASS", async () => {
    const report = await verifier(null, null).run(window());
    expect(report.verdict).toBe("INCONCLUSIVE");
    expect(report.reasonCodes).toContain("SINK_READER_NOT_CONFIGURED");
  });

  it("[FO-15-40][FO-15-42][OPS-01] adversarial: a verifier identity that has been granted a write privilege refuses to give a verdict (FAIL, VERIFIER_IDENTITY_NOT_READ_ONLY)", async () => {
    await adb.migrator.exec("grant insert on audit_outbox to app_audit_verifier");
    try {
      const keys = new ManifestSignatureVerifier();
      await keys.trustKms(kms, signKeyArn);
      const report = await verifier(readerSink(), keys).run(window());
      expect(report).toMatchObject({ verdict: "FAIL", identity: { role: "app_audit_verifier", readOnly: false, findings: ["VERIFIER_IDENTITY_CAN_WRITE"] } });
      expect(report.reasonCodes).toEqual(["VERIFIER_IDENTITY_NOT_READ_ONLY"]);
    } finally {
      await adb.migrator.exec("revoke insert on audit_outbox from app_audit_verifier");
    }
  });

  it("[FO-15-40][FO-15-42][OPS-01] adversarial: the verifier is judged by the LOGIN it connected with — on the application login (member of app_runtime, app_worker, app_console), the migration owner, the server administrator, or an administrator impersonating the verifier login (SET SESSION AUTHORIZATION) it evaluates nothing and FAILs with VERIFIER_IDENTITY_NOT_READ_ONLY", async ({ l2 }) => {
    const keys = new ManifestSignatureVerifier();
    await keys.trustKms(kms, signKeyArn);
    // The application login can SET ROLE app_audit_verifier (it holds every runtime role), so current_user alone would look read-only.
    const app = await verifier(readerSink(), keys, adb.db).run(window());
    expect(app).toMatchObject({ verdict: "FAIL", reasonCodes: ["VERIFIER_IDENTITY_NOT_READ_ONLY"], streams: 0 });
    expect(app.identity.findings).toEqual(expect.arrayContaining(["VERIFIER_LOGIN_WRITER_MEMBER", "VERIFIER_IDENTITY_CAN_WRITE"]));
    const pg = await adb.db.tx((tx) => tx.query<{ s: string; c: string; a: string }>("select session_user::text as s, current_user::text as c, (select usename::text from pg_stat_activity where pid = pg_backend_pid()) as a"), { role: "app_audit_verifier" });
    expect(pg.rows[0]).toEqual({ s: adb.appRole, c: "app_audit_verifier", a: adb.appRole });
    const admin = PgPoolDb.fromConnectionString(postgresUrl(l2, adb.name), 1);
    try {
      // The migration owner (owns every table, CREATEROLE), granted the verifier role for this probe so SET ROLE succeeds.
      await admin.exec(`grant app_audit_verifier to ${adb.migratorRole}`);
      try {
        const owner = await verifier(readerSink(), keys, adb.migrator).run(window());
        expect(owner.verdict).toBe("FAIL");
        expect(owner.identity.findings).toEqual(expect.arrayContaining(["VERIFIER_LOGIN_PRIVILEGED", "VERIFIER_LOGIN_OWNS_OBJECTS"]));
      } finally {
        await admin.exec(`revoke app_audit_verifier from ${adb.migratorRole}`);
      }
      // The server administrator (superuser).
      const r = await verifier(readerSink(), keys, admin).run(window());
      expect(r.verdict).toBe("FAIL");
      expect(r.identity.findings).toContain("VERIFIER_LOGIN_PRIVILEGED");
    } finally {
      await admin.close();
    }
    // An administrator that impersonates the verifier login (SET SESSION AUTHORIZATION): session_user is the
    // verifier login, but the backend authenticated as a superuser (pg_stat_activity), so it is refused.
    const dedicated = await adb.login(["app_audit_verifier"]);
    const impersonating = PgPoolDb.fromConnectionString(postgresUrl(l2, adb.name), 1);
    try {
      await impersonating.exec(`set session authorization ${dedicated.name}`);
      const who = await impersonating.query<{ s: string }>("select session_user::text as s");
      expect(who.rows[0]?.s).toBe(dedicated.name);
      const r = await verifier(readerSink(), keys, impersonating).run(window());
      expect(r.verdict).toBe("FAIL");
      expect(r.identity.findings).toContain("VERIFIER_LOGIN_PRIVILEGED");
    } finally {
      await impersonating.close();
    }
    // The dedicated login passes the same check.
    expect(await verifier(readerSink(), keys, dedicated.db).checkIdentity()).toEqual({ readOnly: true, reasonCodes: [], principals: 1 });
    expect((await verifier(readerSink(), keys).checkIdentity())).toEqual({ readOnly: true, reasonCodes: [], principals: 1 });
  });

  it("[FO-15-42][FO-15-40][OPS-01] the sink identities are separated and MinIO enforces it: the exporter's credentials cannot list or read evidence, the verifier's cannot write", async ({ l2 }) => {
    const tenantId = newId("tnt");
    await appendEvents("gateway.sink-split-it", tenantId, 1);
    expect((await new AuditExporter({ db: adb.db, sink: writerSink(), signer: new KmsManifestSigner(kms, signKeyArn, systemClock), clock: systemClock }).runOnce()).failedStreams).toBe(0);
    const manifests = await readerSink().listManifests("gateway.sink-split-it");
    expect(manifests).toHaveLength(1);
    const objectKey = `audit/${manifests[0]?.objectKey}`;
    const denied = async (p: Promise<unknown>) => p.then(() => "ALLOWED", (e: { name?: string; $metadata?: { httpStatusCode?: number } }) => `${e.name}:${e.$metadata?.httpStatusCode}`);
    expect(await denied(writerS3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: "audit/" })))).toBe("AccessDenied:403");
    expect(await denied(writerS3.send(new GetObjectCommand({ Bucket: bucket, Key: objectKey })))).toBe("AccessDenied:403");
    expect(await denied(readerS3.send(new PutObjectCommand({ Bucket: bucket, Key: `audit/probe-${newId("prb")}.ndjson`, Body: "{}" })))).toBe("AccessDenied:403");
    expect(await denied(readerS3.send(new GetObjectCommand({ Bucket: bucket, Key: objectKey })))).toBe("ALLOWED");
    const [w, r] = await Promise.all([writerS3.config.credentials(), readerS3.config.credentials()]);
    expect(w.accessKeyId).not.toBe(r.accessKeyId);
    expect([w.accessKeyId, r.accessKeyId]).not.toContain(localEnv().minioUser);
    // The STS endpoint verifies the SigV4 signature: a request signed with the wrong secret gets no session.
    await expect(
      assumeRoleWithSessionPolicy(
        {
          endpoint: `https://${LOCAL_STS_HOST}/`,
          region: "us-east-1",
          credentials: { accessKeyId: localEnv().minioUser, secretAccessKey: `${localEnv().minioPassword}x` },
          roleArn: `arn:aws:iam::${SYNTHETIC_ACCOUNT}:role/vsp-audit-verifier-it`,
          sessionName: "vsp-audit-verifier-it",
          policy: sinkReaderPolicy(bucket),
        },
        localStsHttp(l2),
      ),
    ).rejects.toMatchObject({ reasonCode: "AUDIT_STS_DENIED" });
  });

  it("[FO-15-41][OPS-01] keyed CRM-write reconciliation: a synchronised Case without its support_request.synced evidence fails the run even though every chain is intact", async () => {
    const tenantId = newId("tnt");
    await syncedSupportRequest(tenantId, true);
    const missing = await syncedSupportRequest(tenantId, false);
    const exporter = new AuditExporter({ db: adb.db, sink: writerSink(), signer: new KmsManifestSigner(kms, signKeyArn, systemClock), clock: systemClock });
    await exporter.runOnce();
    const keys = new ManifestSignatureVerifier();
    await keys.trustKms(kms, signKeyArn);
    const report = await verifier(readerSink(), keys).run(window());
    expect(report.integrityFindings).toBe(0);
    expect(report.verdict).toBe("FAIL");
    const crm = report.reconciliation.find((s) => s.source === "crm_write");
    expect(crm).toMatchObject({ expected: 2, observed: 1, discrepancies: 1 });
    expect(report.discrepancies).toContainEqual(expect.objectContaining({ source: "crm_write", key: missing, code: "MISSING_AUDIT_EVIDENCE" }));
    // [FO-15-40] Without a sink reader the exported support_request.synced event is unverified, but the Case whose
    // event was never written (nothing was ever purged) is still a visible discrepancy: FAIL, not INCONCLUSIVE.
    const noSink = await verifier(null, null).run(window());
    expect(noSink.verdict).toBe("FAIL");
    expect(noSink.reconciliation.find((s) => s.source === "crm_write")).toEqual({ source: "crm_write", expected: 2, observed: 0, unverified: 1, discrepancies: 1 });
    expect(noSink.discrepancies.filter((d) => d.source === "crm_write").map((d) => d.key)).toEqual([missing]);
  });

  it("[FO-19-82][FO-15-40][OPS-01][OPS-03] verify-audit exits 0 on an intact chain with a committed action, exactly 2 (INCONCLUSIVE) on the same database without a sink reader, and 1 after a deleted event (database identity app_audit_verifier)", async ({ l2 }) => {
    // A fresh database so earlier tests' deliberate discrepancies do not affect this run.
    const fresh = await createAuroraLikeDb(l2);
    const sorDb = await createSorDatabase((database?: string) => postgresUrl(l2, database));
    try {
      const tenantId = newId("tnt");
      const w = new PgAuditWriter({ db: fresh.db, clock: systemClock, stream: "gateway.cli-it" });
      for (let i = 0; i < 4; i++) await w.appendStandalone(buildAuditInput({ tenantId, correlationId: newId("cor"), sourceComponent: "gateway", action: "tool.invoke", outcome: "SUCCEEDED" }, systemClock));
      // One action committed through the production LedgerActionService against the reference system of record.
      const gateway = ledgerReplica(fresh.pool(2), systemClock, "cli-it");
      const recordRef = newId("apt");
      await sorDb.sor.seed(recordRef);
      const { ctx, action } = await confirmedAction(gateway, tenantId, recordRef);
      const committed = await gateway.service.commit(ctx, { actionId: action.actionId, digest: action.digest }, { reauthorize: async () => allow(systemClock), provider: sorDb.sor });
      expect(committed.outcome).toBe("COMMITTED");
      const b = uniqueName("vsp-it-cli-audit");
      await s3.send(new CreateBucketCommand({ Bucket: b, ObjectLockEnabledForBucket: true }));
      const cliWriter = await sinkClient(l2, sinkWriterPolicy(b), "vsp-audit-exporter-cli-it");
      await new AuditExporter({ db: fresh.db, sink: new S3ObjectLockAuditSink(cliWriter, { ...sinkConfig(), bucket: b }, systemClock), signer: new KmsManifestSigner(kms, signKeyArn, systemClock), clock: systemClock }).runOnce();
      const cli = () =>
        spawnSync(process.execPath, ["--import", "tsx", join(REPO_ROOT, "scripts", "vsp", "verify-audit.mts"), "--env", "local", "--database", fresh.name, "--bucket", b, "--kms-key", signKeyArn], {
          cwd: join(REPO_ROOT, "platform"),
          encoding: "utf8",
          timeout: 120_000,
          env: { ...process.env, VSP_PORT_POSTGRES: String(l2.port("postgres", 5432)), VSP_PORT_MINIO: String(l2.port("minio", 9000)), VSP_PORT_LOCALSTACK: String(l2.port("localstack", 4566)) },
        });
      const ok = cli();
      expect(ok.status, ok.stderr).toBe(0);
      expect(JSON.parse(ok.stdout)).toMatchObject({ verdict: "PASS", identity: { role: "app_audit_verifier", readOnly: true, findings: [] } });
      expect(JSON.parse(ok.stdout).reconciliation).toContainEqual({ source: "committed_action", expected: 1, observed: 1, unverified: 0, discrepancies: 0 });
      // Without a sink reader, on the same intact database: INCONCLUSIVE, exit code exactly 2 — never a pass, never a false FAIL.
      const noSinkCli = () =>
        spawnSync(process.execPath, ["--import", "tsx", join(REPO_ROOT, "scripts", "vsp", "verify-audit.mts"), "--env", "local", "--database", fresh.name], {
          cwd: join(REPO_ROOT, "platform"),
          encoding: "utf8",
          timeout: 120_000,
          env: { ...process.env, VSP_PORT_POSTGRES: String(l2.port("postgres", 5432)) },
        });
      const inconclusive = noSinkCli();
      expect(inconclusive.status, inconclusive.stderr).toBe(2);
      const inconclusiveReport = JSON.parse(inconclusive.stdout) as { verdict: string; reasonCodes: string[]; reconciliation: unknown[]; discrepancies: unknown[] };
      expect(inconclusiveReport).toMatchObject({ verdict: "INCONCLUSIVE", reasonCodes: ["SINK_READER_NOT_CONFIGURED", "RECONCILIATION_NOT_VERIFIED_WITHOUT_SINK"], discrepancies: [] });
      expect(inconclusiveReport.reconciliation).toContainEqual({ source: "committed_action", expected: 1, observed: 0, unverified: 1, discrepancies: 0 });
      expect(inconclusiveReport.reconciliation).toContainEqual({ source: "provider_receipt", expected: 1, observed: 0, unverified: 1, discrepancies: 0 });
      // A superuser-level actor removes one shipped event locally, bypassing the append-only triggers and RLS.
      const superuser = PgPoolDb.fromConnectionString(postgresUrl(l2, fresh.name), 1);
      try {
        await superuser.tx(async (tx) => {
          await tx.query("set local session_replication_role = replica");
          const d = await tx.query("delete from audit_outbox where source_stream = 'gateway.cli-it' and sequence = 2");
          expect(d.rowCount).toBe(1);
        }, { role: "owner" });
      } finally {
        await superuser.close();
      }
      const bad = cli();
      expect(bad.status).toBe(1);
      expect(JSON.parse(bad.stdout).verdict).toBe("FAIL");
      expect(JSON.stringify(JSON.parse(bad.stdout).findings)).toMatch(/SEQUENCE_GAP|PREV_HASH_MISMATCH|COUNT_SHORTFALL/);
      // The deleted event is a local chain gap: visible without the sink reader too, so FAIL (exit 1), not INCONCLUSIVE.
      const noSink = noSinkCli();
      expect(noSink.status, noSink.stderr).toBe(1);
      expect(JSON.parse(noSink.stdout).verdict).toBe("FAIL");
      // Every per-run verifier login the command provisioned was removed again.
      const leftover = PgPoolDb.fromConnectionString(postgresUrl(l2), 1);
      try {
        const roles = await leftover.query(
          "select r.rolname from pg_roles r join pg_shdescription d on d.objoid = r.oid and d.classoid = 'pg_authid'::regclass where d.description = $1",
          [`vsp verify-audit local run on database ${fresh.name}`],
        );
        expect(roles.rows).toEqual([]);
      } finally {
        await leftover.close();
      }
    } finally {
      await sorDb.drop();
      await fresh.drop();
    }
  });

  it("[FO-19-07a][AUTH-06] KmsAssertionSigner signs ES256 JWS with a LocalStack KMS key; the public JWK verifies it and a tampered payload fails", async () => {
    const key = await kms.send(new CreateKeyCommand({ KeySpec: "ECC_NIST_P256", KeyUsage: "SIGN_VERIFY", Description: "SYNTHETIC assertion key (Layer 2)" }));
    const signer = new KmsAssertionSigner(kms, key.KeyMetadata?.Arn ?? "");
    const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: signer.kid, typ: "vsp-assertion+jwt" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ purpose: "transfer_receiver", jti: newId("jti") })).toString("base64url");
    const sig = Buffer.from(await signer.sign(new TextEncoder().encode(`${header}.${payload}`))).toString("base64url");
    const pub = await importJWK(await signer.publicJwk(), "ES256");
    await expect(compactVerify(`${header}.${payload}.${sig}`, pub)).resolves.toBeDefined();
    const tampered = Buffer.from(JSON.stringify({ purpose: "durable_action_grant", jti: newId("jti") })).toString("base64url");
    await expect(compactVerify(`${header}.${tampered}.${sig}`, pub)).rejects.toThrow();
  });

  it("[FO-07-17][DATA-02] KmsEnvelopeCipher: a per-event data key from LocalStack KMS seals the payload; decryption needs the same encryption context and row identity", async () => {
    const key = await kms.send(new CreateKeyCommand({ KeySpec: "SYMMETRIC_DEFAULT", KeyUsage: "ENCRYPT_DECRYPT", Description: "SYNTHETIC inbox key (Layer 2)" }));
    const cipher = new KmsEnvelopeCipher(kms, key.KeyMetadata?.Arn ?? "");
    const ctx = { tenantId: newId("tnt"), sourceId: "receipts.synthetic", eventId: "evt-1", payloadDigest: "a".repeat(64) };
    const plain = Buffer.from(JSON.stringify({ id: "evt-1", status: "DELIVERED" }));
    const sealed = await cipher.encrypt(plain, ctx);
    expect(sealed.ciphertext.equals(plain)).toBe(false);
    expect((await cipher.decrypt(sealed, ctx)).equals(plain)).toBe(true);
    await expect(cipher.decrypt(sealed, { ...ctx, tenantId: newId("tnt") })).rejects.toMatchObject({ reasonCode: "INBOX_KMS_UNAVAILABLE" });
    await expect(cipher.decrypt(sealed, { ...ctx, eventId: "evt-2" })).rejects.toMatchObject({ reasonCode: "INBOX_PAYLOAD_DECRYPT_FAILED" });
  });
});
