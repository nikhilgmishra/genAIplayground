/**
 * Layer 2 (WP-04): keyed reconciliation of committed actions and provider receipts against the INDEPENDENT
 * export (FO-15-41; OPS-01). "A perfect hash chain can still omit events": actions are committed through the
 * production LedgerActionService against a reference system of record (its own postgres:16 database), the
 * audit outbox is exported by AuditExporter to a MinIO Object-Lock bucket with KMS-signed manifests (LocalStack
 * KMS), and the separate AuditExportVerifier runs on its own login with read-only sink credentials. An insider
 * with superuser rights then rewrites the ledger (triggers bypassed) so that a COMMITTED action's receipt names
 * an audit event that was never exported, or another action's commit event, or a commit event of ANOTHER TENANT
 * (or of a non-commit action) carrying this action's idempotency key, or a receipt id its commit event does not
 * reference. Every chain stays intact; the run must FAIL with committed_action / provider_receipt discrepancies
 * keyed to that action. Route evidence likewise: a RECORDED deferral re-pointed (guard bypassed as a superuser)
 * at an exported event of another correlation, action or tenant FAILs. Without a sink reader the same intact
 * database is INCONCLUSIVE (shipped evidence unverified), and a local contradiction still FAILs.
 */
import { CreateBucketCommand } from "@aws-sdk/client-s3";
import type { S3Client } from "@aws-sdk/client-s3";
import { CreateKeyCommand } from "@aws-sdk/client-kms";
import type { KMSClient } from "@aws-sdk/client-kms";
import { afterAll, beforeAll, describe, expect } from "vitest";
import { buildAuditInput } from "../../../src/audit/build-input.js";
import { AuditExporter } from "../../../src/audit/exporter/exporter.js";
import { DurableDeferredAuditQueue } from "../../../src/audit/journal.js";
import { PgAuditWriter } from "../../../src/audit/writer.js";
import { KmsManifestSigner, ManifestSignatureVerifier } from "../../../src/audit/exporter/signer.js";
import { sinkReaderPolicy, sinkWriterPolicy } from "../../../src/audit/exporter/sts.js";
import { AuditExportVerifier } from "../../../src/audit/exporter/verifier.js";
import type { AuditVerificationReport } from "../../../src/audit/exporter/verifier.js";
import { S3ObjectLockAuditSink } from "../../../src/audit/sinks/s3-object-lock.js";
import type { S3ObjectLockAuditSinkConfig } from "../../../src/audit/sinks/s3-object-lock.js";
import { PgPoolDb } from "../../../src/db/pg.js";
import type { Db } from "../../../src/db/types.js";
import type { CommitReceipt } from "../../../src/protocol/index.js";
import { iso, systemClock } from "../../../src/shared/clock.js";
import { newId } from "../../../src/shared/ids.js";
import { kmsClient, postgresUrl, s3Client, SYNTHETIC_ACCOUNT, uniqueName } from "../_harness/clients.js";
import { localEnv } from "../_harness/env.js";
import { layer2, layer2Context } from "../_harness/layer2.js";
import { allow, confirmedAction, createSorDatabase, ledgerReplica } from "./reference-sor.js";
import type { SorDatabase } from "./reference-sor.js";
import { createAuroraLikeDb, sinkClient } from "./support.js";
import type { AuroraLikeDb } from "./support.js";

const it = layer2(["postgres", "minio", "localstack"]);
let adb: AuroraLikeDb;
let sorDb: SorDatabase;
let kms: KMSClient;
let signKey: string;
let bucket: string;
let writerS3: S3Client;
let readerS3: S3Client;
let verifierDb: Db;
let superuser: PgPoolDb;

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

async function verify(): Promise<AuditVerificationReport> {
  const keys = new ManifestSignatureVerifier();
  await keys.trustKms(kms, signKey);
  return new AuditExportVerifier({ db: verifierDb, sink: new S3ObjectLockAuditSink(readerS3, sinkConfig(), systemClock), signatures: keys, clock: systemClock }).run(window());
}

/** The same verifier login without a sink reader or signature keys. */
const verifyWithoutSink = () => new AuditExportVerifier({ db: verifierDb, sink: null, signatures: null, clock: systemClock }).run(window());

async function exportAll(): Promise<void> {
  const shipped = await new AuditExporter({ db: adb.db, sink: new S3ObjectLockAuditSink(writerS3, sinkConfig(), systemClock), signer: new KmsManifestSigner(kms, signKey, systemClock), clock: systemClock }).runOnce();
  expect(shipped.failedStreams).toBe(0);
}

async function commitActions(n: number): Promise<CommitReceipt[]> {
  const gateway = ledgerReplica(adb.pool(2), systemClock, "reconcile-it");
  const tenantId = newId("tnt");
  const out: CommitReceipt[] = [];
  for (let i = 0; i < n; i++) {
    const recordRef = newId("apt");
    await sorDb.sor.seed(recordRef);
    const { ctx, action } = await confirmedAction(gateway, tenantId, recordRef);
    const receipt = await gateway.service.commit(ctx, { actionId: action.actionId, digest: action.digest }, { reauthorize: async () => allow(systemClock), provider: sorDb.sor });
    expect(receipt.outcome).toBe("COMMITTED");
    out.push(receipt);
  }
  await exportAll();
  return out;
}

/** The insider's rewrite: one receipt field of a COMMITTED ledger row, with the ledger's triggers bypassed. */
async function rewriteReceipt(actionId: string, field: "auditEventId" | "receiptId", value: string): Promise<() => Promise<void>> {
  const before = await superuser.query<{ receipt: unknown }>("select receipt from action_ledger where action_id = $1", [actionId]);
  const original = JSON.stringify(before.rows[0]?.receipt ?? null);
  const set = async (receiptJson: string | null, key: string | null, v: string | null) =>
    superuser.tx(
      async (tx) => {
        await tx.query("set local session_replication_role = replica");
        const r = receiptJson !== null
          ? await tx.query("update action_ledger set receipt = $2::jsonb where action_id = $1", [actionId, receiptJson])
          : await tx.query("update action_ledger set receipt = jsonb_set(receipt, $2::text[], to_jsonb($3::text)) where action_id = $1", [actionId, `{${key}}`, v]);
        expect(r.rowCount).toBe(1);
      },
      { role: "owner" },
    );
  await set(null, field, value);
  return () => set(original, null, null);
}

/** A superuser re-points a RECORDED deferral (triggers and the evidence guard of migration 2045 bypassed). */
async function repointDeferral(deferralId: string, eventId: string): Promise<void> {
  await superuser.tx(
    async (tx) => {
      await tx.query("set local session_replication_role = replica");
      const r = await tx.query("update audit_deferred set recorded_event_id = $2 where deferral_id = $1", [deferralId, eventId]);
      expect(r.rowCount).toBe(1);
    },
    { role: "owner" },
  );
}

const source = (r: AuditVerificationReport, s: string) => r.reconciliation.find((x) => x.source === s);

describe("keyed reconciliation of committed actions and provider receipts against the independent export", () => {
  beforeAll(async () => {
    const l2 = layer2Context(["postgres", "minio", "localstack"]);
    adb = await createAuroraLikeDb(l2);
    sorDb = await createSorDatabase((database?: string) => postgresUrl(l2, database));
    kms = kmsClient(l2);
    signKey = (await kms.send(new CreateKeyCommand({ KeySpec: "ECC_NIST_P256", KeyUsage: "SIGN_VERIFY", Description: "SYNTHETIC audit manifest key (Layer 2)" }))).KeyMetadata?.Arn ?? "";
    bucket = uniqueName("vsp-it-audit-reconcile");
    await s3Client(l2).send(new CreateBucketCommand({ Bucket: bucket, ObjectLockEnabledForBucket: true }));
    writerS3 = await sinkClient(l2, sinkWriterPolicy(bucket), "vsp-audit-exporter-reconcile-it");
    readerS3 = await sinkClient(l2, sinkReaderPolicy(bucket), "vsp-audit-verifier-reconcile-it");
    verifierDb = (await adb.login(["app_audit_verifier"])).db;
    superuser = PgPoolDb.fromConnectionString(postgresUrl(l2, adb.name), 1);
  });
  afterAll(async () => {
    await superuser?.close();
    await sorDb?.drop();
    await adb?.drop();
  });

  it("[FO-15-41][OPS-01] every COMMITTED action has its exported commit event bound to its idempotency key, and every provider receipt is referenced by that event", async () => {
    const receipts = await commitActions(2);
    const r = await verify();
    expect(source(r, "committed_action")).toEqual({ source: "committed_action", expected: 2, observed: 2, unverified: 0, discrepancies: 0 });
    expect(source(r, "provider_receipt")).toEqual({ source: "provider_receipt", expected: 2, observed: 2, unverified: 0, discrepancies: 0 });
    expect(r.verdict, JSON.stringify(r.reasonCodes)).toBe("PASS");
    expect(new Set(receipts.map((x) => x.auditEventId)).size).toBe(2);
    // [FO-15-40][OPS-03] The same intact database without a sink reader: INCONCLUSIVE, never PASS and never a false
    // FAIL — the exported commit evidence is unverified, not missing.
    const noSink = await verifyWithoutSink();
    expect(noSink.verdict).toBe("INCONCLUSIVE");
    expect(noSink.reasonCodes).toEqual(["SINK_READER_NOT_CONFIGURED", "RECONCILIATION_NOT_VERIFIED_WITHOUT_SINK"]);
    expect(noSink.discrepancies).toEqual([]);
    expect(source(noSink, "committed_action")).toEqual({ source: "committed_action", expected: 2, observed: 0, unverified: 2, discrepancies: 0 });
    expect(source(noSink, "provider_receipt")).toEqual({ source: "provider_receipt", expected: 2, observed: 0, unverified: 2, discrepancies: 0 });
  });

  it("[FO-15-41][OPS-01] adversarial: a committed action whose commit event is absent from the export, one that names another action's commit event, and a receipt its commit event does not reference all FAIL the run while every chain is intact", async () => {
    const [a, b] = await commitActions(2);
    if (!a || !b) throw new Error("two receipts expected");
    expect((await verify()).verdict).toBe("PASS");

    // 1. The receipt names an audit event that was never written or exported.
    let restore = await rewriteReceipt(a.actionId, "auditEventId", newId("aud"));
    let r = await verify();
    expect(r.integrityFindings).toBe(0);
    expect(r.verdict).toBe("FAIL");
    expect(source(r, "committed_action")).toMatchObject({ discrepancies: 1 });
    expect(source(r, "provider_receipt")).toMatchObject({ discrepancies: 1 });
    expect(r.discrepancies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "committed_action", key: a.actionId, code: "MISSING_AUDIT_EVIDENCE" }),
        expect.objectContaining({ source: "provider_receipt", key: a.receiptId, code: "MISSING_AUDIT_EVIDENCE" }),
      ]),
    );
    await restore();

    // 2. The receipt names ANOTHER action's (exported, valid) commit event: different idempotency key, other receipt.
    restore = await rewriteReceipt(a.actionId, "auditEventId", b.auditEventId);
    r = await verify();
    expect(r.integrityFindings).toBe(0);
    expect(r.verdict).toBe("FAIL");
    expect(r.discrepancies.filter((d) => d.source === "committed_action").map((d) => d.key)).toEqual([a.actionId]);
    expect(r.discrepancies.filter((d) => d.source === "provider_receipt").map((d) => d.key)).toEqual([a.receiptId]);
    // Without a sink reader the local copy of b's commit event contradicts a's ledger row: still a FAIL.
    const noSink = await verifyWithoutSink();
    expect(noSink.verdict).toBe("FAIL");
    expect(noSink.discrepancies.filter((d) => d.source === "committed_action").map((d) => d.key)).toEqual([a.actionId]);
    await restore();

    // 3. The receipt id was rewritten: the exported commit event references the original receipt only.
    const forged = newId("rcp");
    restore = await rewriteReceipt(a.actionId, "receiptId", forged);
    r = await verify();
    expect(r.verdict).toBe("FAIL");
    expect(r.discrepancies.filter((d) => d.source === "committed_action")).toEqual([]);
    expect(r.discrepancies.filter((d) => d.source === "provider_receipt").map((d) => d.key)).toEqual([forged]);
    await restore();

    // Restored: the same verifier is clean again.
    expect((await verify()).verdict).toBe("PASS");
  });
  it("[FO-15-41][OPS-01] adversarial: a commit event of ANOTHER TENANT, or of a non-commit action, that carries the action's idempotency key and references its receipt is not evidence for it (exported, chains intact)", async () => {
    const [a] = await commitActions(1);
    if (!a) throw new Error("one receipt expected");
    const key = (await superuser.query<{ k: string }>("select provider_idempotency_key as k from action_ledger where action_id = $1", [a.actionId])).rows[0]?.k ?? "";
    expect(key).not.toBe("");
    // An insider appends forged commit evidence through the production writer; the exporter ships it with valid signatures.
    const forger = new PgAuditWriter({ db: adb.db, clock: systemClock, stream: "actions.forged-it" });
    const forged = {
      otherTenant: await forger.appendStandalone(buildAuditInput({ tenantId: newId("tnt"), correlationId: a.actionId, sourceComponent: "actions", action: "action.commit.succeeded", outcome: "SUCCEEDED", idempotencyKey: key, evidencePointers: [`receipt:${a.receiptId}`], receiptRefs: [a.receiptId] }, systemClock)),
      notACommit: await forger.appendStandalone(buildAuditInput({ tenantId: (await superuser.query<{ t: string }>("select tenant_id as t from action_ledger where action_id = $1", [a.actionId])).rows[0]?.t ?? "", correlationId: a.actionId, sourceComponent: "actions", action: "tool.invoke", outcome: "SUCCEEDED", idempotencyKey: key, evidencePointers: [`receipt:${a.receiptId}`], receiptRefs: [a.receiptId] }, systemClock)),
    };
    await exportAll();
    expect((await verify()).verdict).toBe("PASS");
    for (const [name, ev] of Object.entries(forged)) {
      const restore = await rewriteReceipt(a.actionId, "auditEventId", ev.eventId);
      const r = await verify();
      expect(r.integrityFindings, name).toBe(0);
      expect(r.verdict, name).toBe("FAIL");
      expect(source(r, "committed_action"), name).toEqual({ source: "committed_action", expected: expect.any(Number), observed: expect.any(Number), unverified: 0, discrepancies: 1 });
      expect(r.discrepancies.filter((d) => d.source === "committed_action").map((d) => d.key), name).toEqual([a.actionId]);
      expect(r.discrepancies.filter((d) => d.source === "provider_receipt").map((d) => d.key), name).toEqual([a.receiptId]);
      expect((await verifyWithoutSink()).verdict, `${name} (no sink reader)`).toBe("FAIL");
      await restore();
    }
    expect((await verify()).verdict).toBe("PASS");
  });

  it("[FO-15-41][FO-15-45][OPS-01] adversarial: a RECORDED route deferral re-pointed (evidence guard bypassed as a superuser) at an EXPORTED event of another correlation, another action or another tenant fails the run", async () => {
    const tenantId = newId("tnt");
    const correlationId = newId("hnd");
    const callId = newId("call");
    const routeWriter = new PgAuditWriter({ db: adb.db, clock: systemClock, stream: "gateway.routes-reconcile-it" });
    const queue = new DurableDeferredAuditQueue({ db: adb.db, writer: routeWriter, clock: systemClock, tenants: [tenantId] });
    const route = buildAuditInput({ tenantId, correlationId, sourceComponent: "gateway", action: "handoff.safety_requested", outcome: "PENDING", callId, reasonCode: "SAFETY_SIGNAL_VALIDATED" }, systemClock);
    // The route event is deferred while the audit store refuses runtime writes, then flushed (RECORDED + marker).
    await adb.migrator.exec("revoke insert on audit_outbox from app_runtime, app_worker, app_console");
    try {
      expect(await queue.appendOrDefer(route)).toMatchObject({ written: false, deferred: true, journal: "postgres" });
    } finally {
      await adb.migrator.exec("grant insert on audit_outbox to app_runtime, app_worker, app_console");
    }
    expect((await queue.flush()).written).toBe(1);
    const deferral = (await superuser.query<{ deferral_id: string; recorded_event_id: string }>("select deferral_id, recorded_event_id from audit_deferred where correlation_id = $1 and status = 'RECORDED'", [correlationId])).rows[0];
    if (!deferral) throw new Error("the deferral was not recorded");
    // Real, chained events that differ from the deferral in exactly one key each, exported with valid signatures.
    const decoys = {
      otherCorrelation: await routeWriter.appendStandalone({ ...route, correlationId: newId("hnd") }),
      otherAction: await routeWriter.appendStandalone({ ...route, action: "handoff.human_requested" }),
      otherTenant: await routeWriter.appendStandalone({ ...route, tenantId: newId("tnt") }),
    };
    await exportAll();
    expect(source(await verify(), "route_evidence")).toMatchObject({ discrepancies: 0, unverified: 0 });
    for (const [name, decoy] of Object.entries(decoys)) {
      await repointDeferral(deferral.deferral_id, decoy.eventId);
      const r = await verify();
      expect(r.integrityFindings, name).toBe(0);
      expect(r.verdict, name).toBe("FAIL");
      expect(r.discrepancies.filter((d) => d.source === "route_evidence").map((d) => d.key), name).toEqual([deferral.deferral_id]);
      expect((await verifyWithoutSink()).verdict, `${name} (no sink reader)`).toBe("FAIL");
    }
    await repointDeferral(deferral.deferral_id, deferral.recorded_event_id);
    const restored = await verify();
    expect(restored.discrepancies.filter((d) => d.source === "route_evidence")).toEqual([]);
    expect(restored.verdict, JSON.stringify(restored.reasonCodes)).toBe("PASS");
  });
});
