/**
 * Audit exporter unit (WP-07; WP-04 hand-off; FO-03-30, FO-15-38, FO-19-82, OPS-01, AUTH-02).
 *
 * Production entry point (modules.yaml `entryPoints`, transitive). A deployable unit separate from the
 * gateway and the worker, in one of two modes, each under its OWN identity (VSP_AUDIT_UNIT_MODE):
 *
 *   export  ships every pending audit batch to the S3 Object Lock sink in the audit account with a KMS-signed
 *           manifest (AuditExporter, WP-04), under the exporter's database login
 *           (infrastructure.auditExport.exporterDatabaseRef) and the exporter task role (s3:PutObject* on the
 *           audit bucket, kms:Sign on the manifest key);
 *   verify  verifies the hash chains, the sink copy, the manifest signatures (trusted manifest keys from KMS)
 *           and the completeness reconciliation over a sliding window (AuditExportVerifier), under the
 *           verifier's read-only login (verifierDatabaseRef; refused when it can write) and the verifier task
 *           role (list/get on the bucket, kms:GetPublicKey). A FAIL or INCONCLUSIVE verdict is reported as a
 *           failing loop (readiness) and in metrics; it never repairs evidence.
 *
 * The guard runs first with the SAME inputs the gateway hands it (auditUnitStartupInputs: the pinned policy
 * bundle, the committed tool catalogue digest, the template catalogue and release image digests, the connector
 * credential sets, the other environments' signing keys for the key separation rule; KMS-only approval trust,
 * FO-14-56), so the full rule set of staging and production admits the
 * unit exactly when it admits the gateway, and never on a weaker check. The unit refuses to start while
 * audit.independent is NOT_CONFIGURED (it has nothing else to do). No database identity is shared with the
 * runtime: the guard refuses AUDIT_EXPORT_IDENTITY_SHARED. The unit builds its own AWS clients and database pool
 * (it does not reuse buildLiveContainer: it needs none of the runtime's substrate, ports or roles).
 */
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import { GetPublicKeyCommand } from "@aws-sdk/client-kms";
import { createAwsClients } from "../adapters/live/aws-clients.js";
import { AuditExporter } from "../audit/exporter/exporter.js";
import { KmsManifestSigner, ManifestSignatureVerifier } from "../audit/exporter/signer.js";
import type { KmsSignSender } from "../audit/exporter/signer.js";
import { AuditExportVerifier } from "../audit/exporter/verifier.js";
import { S3ObjectLockAuditSink } from "../audit/sinks/s3-object-lock.js";
import { KmsRuntimeSigningKeyResolver, KmsTrustedKeyResolver } from "../config/approvals.js";
import type { KmsPublicKeyClient } from "../config/approvals.js";
import { loadInfrastructureEnv, loadPlatformConfig } from "../config/loader.js";
import type { PlatformConfig } from "../config/ports.js";
import { loadDeployableConfig } from "../config/startup.js";
import type { StartupInputs } from "../config/startup.js";
import type { Environment } from "../protocol/index.js";
import { SecretsManagerSecretResolver } from "../connectors/secrets/resolver.js";
import type { SecretsManagerSender } from "../connectors/secrets/resolver.js";
import { PgPoolDb } from "../db/pg.js";
import { alarmLogTap } from "../observability/alarms.js";
import { createPlatformMetricCatalogue } from "../observability/catalog/index.js";
import { createLogger } from "../observability/logger.js";
import { InMemoryMetrics } from "../observability/metrics.js";
import type { Logger } from "../observability/ports.js";
import type { Clock } from "../shared/clock.js";
import { iso, systemClock } from "../shared/clock.js";
import { ConfigurationRejectedError } from "../shared/errors.js";
import { MeteredLoop, guardedRun, okReport } from "../worker/loop-kit.js";
import type { LoopReport, WorkerLoop } from "../worker/loop-kit.js";
import { TimerLoopScheduler } from "../worker/scheduler.js";
import type { LoopScheduler } from "../worker/scheduler.js";
import { Worker, buildWorkerHealthApp } from "../worker/runtime.js";
import { committedSigningKeySets, connectorCredentialSets, pgConnectionString, secretString, servedArtifacts } from "./live-modules.js";

export type AuditUnitMode = "export" | "verify";

export interface AuditExporterOptions {
  env?: Readonly<Record<string, string | undefined>>;
  mode?: AuditUnitMode;
  clock?: Clock;
  logger?: Logger;
  configDir?: string;
  repoRoot?: string;
  scheduler?: LoopScheduler;
  /** Export run interval (default 60 s) / verification interval (default 15 min). */
  intervalMs?: number;
  /** Verification window (default the last 24 h, ending `exportGraceSeconds` ago inside the verifier). */
  verifyWindowMs?: number;
}

export interface AuditExporterRuntime {
  mode: AuditUnitMode;
  worker: Worker;
  metrics: InMemoryMetrics;
  healthUrl: string;
  close(): Promise<void>;
}

class AuditExportLoop implements WorkerLoop {
  readonly name = "audit.export";
  constructor(
    private readonly exporter: Pick<AuditExporter, "runOnce">,
    readonly intervalMs: number,
  ) {}
  runOnce(): Promise<LoopReport> {
    return guardedRun(async () => {
      const r = await this.exporter.runOnce();
      return r.failedStreams > 0
        ? { ok: false, processed: r.eventsShipped, reasonCode: r.streams.find((s) => s.reasonCode !== null)?.reasonCode ?? "AUDIT_EXPORT_FAILED", details: { batches: r.batchesShipped, failedStreams: r.failedStreams } }
        : okReport(r.eventsShipped, { batches: r.batchesShipped });
    });
  }
}

class AuditExportVerifyLoop implements WorkerLoop {
  readonly name = "audit.export_verify";
  constructor(
    private readonly verifier: Pick<AuditExportVerifier, "run">,
    private readonly clock: Clock,
    private readonly windowMs: number,
    readonly intervalMs: number,
  ) {}
  runOnce(): Promise<LoopReport> {
    return guardedRun(async () => {
      const to = this.clock.now();
      const r = await this.verifier.run({ from: iso(new Date(to.getTime() - this.windowMs)), to: iso(to) });
      return { ok: r.verdict === "PASS", processed: r.exportedEventsChecked, reasonCode: r.verdict === "PASS" ? null : (r.reasonCodes[0] ?? `AUDIT_VERIFY_${r.verdict}`), details: { verdict: r.verdict, streams: r.streams, integrityFindings: r.integrityFindings, ingestionGaps: r.ingestionGaps } };
    });
  }
}

/**
 * The deployment guard inputs of the audit unit: the gateway's own inputs (servedArtifacts, the connector
 * credential sets), no live adapter instantiated, and KMS-only approval trust.
 */
export async function auditUnitStartupInputs(
  preliminary: PlatformConfig,
  o: { environment: Environment; clock: Clock; logger: Logger; env: Readonly<Record<string, string | undefined>>; configDir?: string; repoRoot?: string; kms: KmsPublicKeyClient; releaseImageDigest: string | null },
): Promise<StartupInputs> {
  const served = await servedArtifacts(preliminary, { environment: o.environment, clock: o.clock, logger: o.logger, releaseImageDigest: o.releaseImageDigest });
  const credentials = connectorCredentialSets(preliminary, { environment: o.environment, ...(o.configDir ? { configDir: o.configDir } : {}), ...(o.repoRoot ? { repoRoot: o.repoRoot } : {}) });
  return {
    environment: o.environment,
    clock: o.clock,
    adapterKinds: {},
    loadedPolicy: served.loadedPolicy,
    toolCatalogDigest: served.toolCatalogDigest,
    templateCatalogDigest: served.templateCatalogDigest,
    releaseImageDigest: served.releaseImageDigest,
    connectorCredentialSets: credentials.sets,
    committedSigningKeys: committedSigningKeySets({ environment: o.environment, ...(o.configDir ? { configDir: o.configDir } : {}) }),
    env: o.env,
    ...(o.configDir ? { configDir: o.configDir } : {}),
    ...(o.repoRoot ? { repoRoot: o.repoRoot } : {}),
    logger: o.logger,
    keyResolvers: [new KmsTrustedKeyResolver(o.kms, (input) => new GetPublicKeyCommand(input))],
    signingKeyResolvers: [new KmsRuntimeSigningKeyResolver(o.kms, (input) => new GetPublicKeyCommand(input))],
  };
}

export async function startAuditExporter(opts: AuditExporterOptions = {}): Promise<AuditExporterRuntime> {
  const env = opts.env ?? process.env;
  const clock = opts.clock ?? systemClock;
  const mode: AuditUnitMode = opts.mode ?? (env.VSP_AUDIT_UNIT_MODE === "verify" ? "verify" : "export");
  if (env.VSP_AUDIT_UNIT_MODE !== undefined && env.VSP_AUDIT_UNIT_MODE !== "export" && env.VSP_AUDIT_UNIT_MODE !== "verify") throw new ConfigurationRejectedError(["AUDIT_UNIT_MODE_INVALID@VSP_AUDIT_UNIT_MODE"]);
  const infraEnv = loadInfrastructureEnv(env, { defaultPort: 8082 });
  const environment = infraEnv.environment;
  if (environment === "local" || environment === "ci") throw new ConfigurationRejectedError(["LIVE_COMPOSITION_OFFLINE_ENVIRONMENT@environment"]);
  const bootLogger = opts.logger ?? createLogger({ service: "vsp-audit-exporter" });
  const preliminary = loadPlatformConfig({ environment, configDir: opts.configDir, env }).config;
  if (!preliminary.infrastructure) throw new ConfigurationRejectedError(["INFRASTRUCTURE_NOT_CONFIGURED@infrastructure"]);
  const aws = createAwsClients(preliminary.infrastructure.aws, { environment, env });
  const closers: (() => Promise<void> | void)[] = [() => aws.destroy()];
  const unwind = async () => {
    for (const f of closers.reverse()) await Promise.resolve(f()).catch(() => undefined);
  };
  try {
    const deployable = await loadDeployableConfig(
      await auditUnitStartupInputs(preliminary, {
        environment,
        clock,
        logger: bootLogger,
        env,
        ...(opts.configDir ? { configDir: opts.configDir } : {}),
        ...(opts.repoRoot ? { repoRoot: opts.repoRoot } : {}),
        kms: aws.kms as unknown as KmsPublicKeyClient,
        releaseImageDigest: infraEnv.releaseImageDigest,
      }),
    );
    const config = deployable.config;
    const infra = config.infrastructure;
    if (!infra?.auditExport || !infra.auditSink || deployable.report.notConfiguredCapabilities.includes("audit.independent")) {
      throw new ConfigurationRejectedError(["AUDIT_EXPORT_NOT_CONFIGURED@infrastructure.auditExport"]);
    }
    const metrics = new InMemoryMetrics({ catalogue: createPlatformMetricCatalogue({ toolNames: [] }), unknownMetric: "drop" });
    const logger = alarmLogTap(bootLogger, metrics).child({ component: "audit_exporter" });
    const secrets = new SecretsManagerSecretResolver(aws.secretsManager as unknown as SecretsManagerSender, { clock, metrics });
    const ref = mode === "export" ? infra.auditExport.exporterDatabaseRef : infra.auditExport.verifierDatabaseRef;
    const path = mode === "export" ? "infrastructure.auditExport.exporterDatabaseRef" : "infrastructure.auditExport.verifierDatabaseRef";
    const db = PgPoolDb.fromConnectionString(pgConnectionString(await secretString(secrets, ref, path), { environment, path }), 2, { applicationName: mode === "export" ? "vsp-audit-exporter" : "vsp-audit-verifier" });
    closers.push(() => db.close());
    const sink = new S3ObjectLockAuditSink(
      aws.s3,
      {
        bucket: infra.auditSink.bucket,
        expectedBucketOwner: infra.auditSink.expectedBucketOwner,
        keyPrefix: infra.auditSink.keyPrefix,
        objectLockMode: infra.auditSink.objectLockMode,
        retentionClass: "SECURITY_AUDIT",
        retentionDays: config.retention.SECURITY_AUDIT,
        kmsKeyId: infra.auditSink.kmsKeyId,
      },
      clock,
    );
    let loop: WorkerLoop;
    if (mode === "export") {
      const exporter = new AuditExporter({ db, sink, signer: new KmsManifestSigner(aws.kms as unknown as KmsSignSender, infra.auditExport.manifestSigningKeyId, clock), clock, logger, metrics });
      loop = new AuditExportLoop(exporter, opts.intervalMs ?? 60_000);
    } else {
      const signatures = new ManifestSignatureVerifier();
      for (const k of infra.auditExport.trustedManifestKeyIds) await signatures.trustKms(aws.kms as unknown as KmsSignSender, k);
      const verifier = new AuditExportVerifier({ db, sink, signatures, clock, exportGraceSeconds: config.audit.maxBacklogAgeSeconds, metrics, logger });
      loop = new AuditExportVerifyLoop(verifier, clock, opts.verifyWindowMs ?? 86_400_000, opts.intervalMs ?? 900_000);
    }
    const worker = new Worker({ loops: [new MeteredLoop(loop, metrics, clock)], scheduler: opts.scheduler ?? new TimerLoopScheduler(), clock, logger });
    const health = await buildWorkerHealthApp(worker, logger);
    closers.push(() => health.close());
    await health.listen({ host: infraEnv.listenHost, port: infraEnv.port });
    worker.start();
    metrics.increment("vsp_live_composition_starts_total", { unit: "audit_exporter", result: "started" });
    let closing: Promise<void> | null = null;
    return {
      mode,
      worker,
      metrics,
      healthUrl: `http://${infraEnv.listenHost}:${(health.server.address() as AddressInfo).port}`,
      close() {
        closing ??= worker.stop().then(unwind);
        return closing;
      },
    };
  } catch (err) {
    await unwind();
    throw err;
  }
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  startAuditExporter()
    .then((rt) => {
      const shutdown = () => {
        void rt.close().finally(() => process.exit(0));
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    })
    .catch((err: unknown) => {
      if (err instanceof ConfigurationRejectedError) process.stderr.write(`audit-exporter.refused ${err.violations.join(" ")}\n`);
      else process.stderr.write(`audit-exporter.failed ${err instanceof Error && /^[A-Z][A-Z0-9_]{2,63}$/.test(err.message) ? err.message : "STARTUP_FAILED"}\n`);
      process.exitCode = 1;
    });
}
