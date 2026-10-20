/**
 * Layer 2 (WP-04): [FAULT:AUDIT_OUTAGE] (FO-17-24.AUDIT_OUTAGE; OPS-01, FO-15-33, FO-15-44, FO-15-46).
 * Injection point (scenarios/fixtures/failures/AUDIT_OUTAGE.json): the central sink AND the local audit
 * outbox cannot be written: the Object-Lock bucket on MinIO refuses the exporter's put, and postgres:16
 * refuses inserts into audit_outbox for every runtime role. The run proves the fault was reached from
 * independent evidence (the exporter's failed put recorded in audit_sink_status, the store's own privilege
 * answer, the writer's refusal) and asserts the postconditions:
 *  - consequential actions fail closed (prepare and commit) before any provider call, including a replica
 *    whose last health result was cached as healthy (the writer still fails closed inside tx1);
 *  - safety and human routes stay usable: their audit goes to the durable route-audit journal;
 *  - the audit health alarm is raised (audit.health.blocked);
 *  - no unaudited commit: after recovery the journal flushes, the commit completes with evidence, and the
 *    separate verifier reconciles every provider effect against exported, signed evidence (PASS).
 */
import { CreateBucketCommand } from "@aws-sdk/client-s3";
import { CreateKeyCommand } from "@aws-sdk/client-kms";
import { afterAll, beforeAll, describe, expect } from "vitest";
import { buildAuditInput } from "../../../src/audit/build-input.js";
import { AuditExporter } from "../../../src/audit/exporter/exporter.js";
import { KmsManifestSigner, ManifestSignatureVerifier } from "../../../src/audit/exporter/signer.js";
import { sinkReaderPolicy, sinkWriterPolicy } from "../../../src/audit/exporter/sts.js";
import { AuditExportVerifier } from "../../../src/audit/exporter/verifier.js";
import { DurableDeferredAuditQueue } from "../../../src/audit/journal.js";
import { PgRouteAuditIntents } from "../../../src/audit/route-reconciler.js";
import { S3ObjectLockAuditSink } from "../../../src/audit/sinks/s3-object-lock.js";
import type { S3ObjectLockAuditSinkConfig } from "../../../src/audit/sinks/s3-object-lock.js";
import { PgAuditWriter } from "../../../src/audit/writer.js";
import { createMemoryLogger } from "../../../src/observability/logger.js";
import { iso, systemClock } from "../../../src/shared/clock.js";
import { newId } from "../../../src/shared/ids.js";
import { kmsClient, postgresUrl, s3Client, SYNTHETIC_ACCOUNT, uniqueName } from "../_harness/clients.js";
import { localEnv } from "../_harness/env.js";
import { layer2, layer2Context } from "../_harness/layer2.js";
import { allow, authContext, confirmedAction, createSorDatabase, ledgerReplica, reschedule } from "./reference-sor.js";
import type { SorDatabase } from "./reference-sor.js";
import { createAuroraLikeDb, sinkClient } from "./support.js";
import type { AuroraLikeDb } from "./support.js";

const it = layer2(["postgres", "minio", "localstack"]);
let adb: AuroraLikeDb;
let sorDb: SorDatabase;

const sinkConfig = (bucket: string): S3ObjectLockAuditSinkConfig => ({
  bucket,
  expectedBucketOwner: SYNTHETIC_ACCOUNT,
  keyPrefix: "audit/",
  objectLockMode: "GOVERNANCE",
  retentionClass: "SECURITY_AUDIT",
  retentionDays: 1, // SYNTHETIC TEST VALUE: the real duration is approved by counsel (activation register)
  kmsKeyId: localEnv().minioKmsKeyId,
});

const RUNTIME_WRITERS = "app_runtime, app_worker, app_console";

describe("[FAULT:AUDIT_OUTAGE] central sink and local audit outbox unwritable", () => {
  beforeAll(async () => {
    const l2 = layer2Context(["postgres", "minio", "localstack"]);
    adb = await createAuroraLikeDb(l2);
    sorDb = await createSorDatabase((database?: string) => postgresUrl(l2, database));
  });
  afterAll(async () => {
    await adb?.migrator.exec(`grant insert on audit_outbox to ${RUNTIME_WRITERS}`).catch(() => undefined);
    await sorDb?.drop();
    await adb?.drop();
  });

  it("[FAULT:AUDIT_OUTAGE][OPS-01][FO-15-46][FO-15-44][FO-15-33] reached at both stores; consequential blocked before any provider call; routes journaled; alarm raised; no unaudited commit after recovery", async ({ l2 }) => {
    const tenantId = newId("tnt");
    const recordRef = newId("apt");
    await sorDb.sor.seed(recordRef);
    const s3 = s3Client(l2);
    const kms = kmsClient(l2);
    const signKey = (await kms.send(new CreateKeyCommand({ KeySpec: "ECC_NIST_P256", KeyUsage: "SIGN_VERIFY", Description: "SYNTHETIC audit manifest key (Layer 2)" }))).KeyMetadata?.Arn ?? "";
    const signer = new KmsManifestSigner(kms, signKey, systemClock);
    const { logger, records } = createMemoryLogger();

    // Before the outage: an action is confirmed (with its evidence); a second replica caches a healthy result.
    const gateway = ledgerReplica(adb.pool(2), systemClock, "outage-gateway", {}, { logger });
    const confirmed = await confirmedAction(gateway, tenantId, recordRef);
    const cachedReplica = ledgerReplica(adb.pool(2), systemClock, "outage-cached", {}, { healthCacheTtlMs: 10_000 });
    expect((await cachedReplica.auditHealth.status()).canAcceptConsequential).toBe(true);

    // INJECT 1: the central sink refuses the put (the audit-account bucket is unavailable).
    const missingBucket = uniqueName("vsp-it-audit-unavailable");
    const brokenExport = await new AuditExporter({ db: adb.db, sink: new S3ObjectLockAuditSink(s3, sinkConfig(missingBucket), systemClock), signer, clock: systemClock }).runOnce();
    expect(brokenExport.failedStreams).toBeGreaterThan(0);
    const sinkStatus = await adb.db.tx((tx) => tx.query<{ consecutive_failures: number }>("select consecutive_failures from audit_backlog_stats()"), { role: "app_worker" });
    expect(Number(sinkStatus.rows[0]?.consecutive_failures), "reached: the sink failure is recorded").toBeGreaterThan(0);

    // INJECT 2: the local audit outbox refuses inserts for every runtime role.
    await adb.migrator.exec(`revoke insert on audit_outbox from ${RUNTIME_WRITERS}`);
    try {
      // Reached, from the store's own answer and from the production writer.
      const health = await gateway.auditHealth.status();
      expect(health).toMatchObject({ canAcceptConsequential: false, reasonCode: "AUDIT_STORE_UNWRITABLE", sinkHealthy: false });
      const writer = new PgAuditWriter({ db: adb.db, clock: systemClock, stream: "gateway.outage-probe" });
      await expect(writer.appendStandalone(buildAuditInput({ tenantId, correlationId: newId("cor"), sourceComponent: "gateway", action: "tool.invoke", outcome: "SUCCEEDED" }, systemClock))).rejects.toMatchObject({
        reasonCode: "AUDIT_STORE_UNWRITABLE",
      });

      // Postcondition: consequential actions fail closed, before any provider call.
      const deps = { reauthorize: async () => allow(systemClock), provider: sorDb.sor };
      await expect(gateway.service.commit(confirmed.ctx, { actionId: confirmed.action.actionId, digest: confirmed.action.digest }, deps)).rejects.toMatchObject({ reasonCode: "AUDIT_STORE_UNWRITABLE" });
      await expect(gateway.service.prepare(authContext(tenantId, systemClock), reschedule(newId("apt")), allow(systemClock))).rejects.toMatchObject({ reasonCode: "AUDIT_STORE_UNWRITABLE" });
      // A replica that still trusts a cached healthy answer is stopped by tx1's own audit write.
      await expect(cachedReplica.service.commit(confirmed.ctx, { actionId: confirmed.action.actionId, digest: confirmed.action.digest }, deps)).rejects.toMatchObject({ reasonCode: expect.stringMatching(/^AUDIT_/) });
      expect(await sorDb.sor.calls("commit"), "no provider call during the outage").toBe(0);
      expect(await sorDb.sor.calls("version"), "not even the version check").toBe(0);
      const during = await adb.db.tx((tx) => tx.query<{ state: string }>("select state from action_ledger where action_id = $1", [confirmed.action.actionId]), { role: "app_runtime", rls: { tenantId } });
      expect(during.rows[0]?.state).toBe("CONFIRMED");

      // Postcondition: the audit health alarm is raised.
      expect(records.some((r) => r.event === "audit.health.blocked" && r.fields.reasonCode === "AUDIT_STORE_UNWRITABLE")).toBe(true);

      // Postcondition: safety and human routes stay usable; their evidence goes to the durable journal.
      const routeWriter = new PgAuditWriter({ db: adb.db, clock: systemClock, stream: "gateway.outage-routes" });
      const queue = new DurableDeferredAuditQueue({ db: adb.db, writer: routeWriter, clock: systemClock, tenants: [tenantId] });
      const callId = newId("call");
      const handoff = newId("hnd");
      await new PgRouteAuditIntents({ db: adb.db, clock: systemClock }).open({ tenantId, routeKind: "SAFETY_ROUTE", correlationId: handoff, callId, deadlineSeconds: 300 });
      const routed = await queue.appendOrDefer(buildAuditInput({ tenantId, correlationId: handoff, sourceComponent: "gateway", action: "handoff.safety_requested", outcome: "PENDING", callId, reasonCode: "SAFETY_SIGNAL_VALIDATED" }, systemClock));
      expect(routed).toMatchObject({ written: false, deferred: true, journal: "postgres", reasonCode: "AUDIT_STORE_UNWRITABLE" });
      const human = await queue.appendOrDefer(buildAuditInput({ tenantId, correlationId: newId("hnd"), sourceComponent: "gateway", action: "handoff.human_requested", outcome: "PENDING", callId }, systemClock));
      expect(human).toMatchObject({ deferred: true, journal: "postgres" });
      expect((await queue.flush()).written, "nothing flushes while the store is unwritable").toBe(0);
    } finally {
      await adb.migrator.exec(`grant insert on audit_outbox to ${RUNTIME_WRITERS}`);
    }

    // Recovery: the journal flushes, the commit completes with evidence.
    const routeWriter = new PgAuditWriter({ db: adb.db, clock: systemClock, stream: "gateway.outage-routes" });
    expect((await new DurableDeferredAuditQueue({ db: adb.db, writer: routeWriter, clock: systemClock, tenants: [tenantId] }).flush()).written).toBe(2);
    const receipt = await gateway.service.commit(confirmed.ctx, { actionId: confirmed.action.actionId, digest: confirmed.action.digest }, { reauthorize: async () => allow(systemClock), provider: sorDb.sor });
    expect(receipt.outcome).toBe("COMMITTED");
    expect(await sorDb.sor.effects(recordRef)).toBe(1);

    // No unaudited commit: export to the (restored) audit-account bucket and run the separate verifier.
    const bucket = uniqueName("vsp-it-audit-restored");
    await s3.send(new CreateBucketCommand({ Bucket: bucket, ObjectLockEnabledForBucket: true }));
    // The exporter writes with put-only session credentials; the verifier reads on its own login with list/get-only ones.
    const writerS3 = await sinkClient(l2, sinkWriterPolicy(bucket), "vsp-audit-exporter-outage-it");
    const readerS3 = await sinkClient(l2, sinkReaderPolicy(bucket), "vsp-audit-verifier-outage-it");
    const shipped = await new AuditExporter({ db: adb.db, sink: new S3ObjectLockAuditSink(writerS3, sinkConfig(bucket), systemClock), signer, clock: systemClock }).runOnce();
    expect(shipped.failedStreams).toBe(0);
    const keys = new ManifestSignatureVerifier();
    await keys.trustKms(kms, signKey);
    const verifierLogin = await adb.login(["app_audit_verifier"]);
    const report = await new AuditExportVerifier({ db: verifierLogin.db, sink: new S3ObjectLockAuditSink(readerS3, sinkConfig(bucket), systemClock), signatures: keys, clock: systemClock }).run({
      from: iso(new Date(Date.now() - 3_600_000)),
      to: iso(new Date(Date.now() + 3_600_000)),
    });
    expect(report.reconciliation.find((s) => s.source === "committed_action")).toMatchObject({ expected: 1, observed: 1, discrepancies: 0 });
    expect(report.reconciliation.find((s) => s.source === "provider_receipt")).toMatchObject({ expected: 1, observed: 1, discrepancies: 0 });
    expect(report.verdict, JSON.stringify(report.reasonCodes)).toBe("PASS");
  });
});
