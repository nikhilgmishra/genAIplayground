/**
 * Startup composition: load configuration, load approval records, resolve the
 * trusted approval key by reference and run the deployment guard. Startup must
 * call this before serving traffic; a rejected configuration throws
 * ConfigurationRejectedError and the process must not start (OPS-04).
 */
import type { KeyObject } from "node:crypto";
import { resolve } from "node:path";
import type { Environment } from "../protocol/index.js";
import type { Clock } from "../shared/clock.js";
import { ConfigurationRejectedError, PlatformError } from "../shared/errors.js";
import type { Logger } from "../observability/ports.js";
import { silentLogger } from "../observability/logger.js";
import { FileTrustedKeyResolver, loadApprovalRecords } from "./approvals.js";
import type { TrustedKeyResolver } from "./approvals.js";
import { assertDeployable } from "./guard.js";
import type { GuardReport } from "./guard.js";
import { REPO_ROOT, loadPlatformConfig } from "./loader.js";
import type { LoadedConfig } from "./loader.js";
import type { PlatformConfig } from "./ports.js";

export interface StartupInputs {
  environment: Environment;
  clock: Clock;
  adapterKinds: Record<string, "local_fixture" | "live">;
  loadedPolicy: { version: string; digest: string } | null;
  toolCatalogDigest: string | null;
  env?: Readonly<Record<string, string | undefined>>;
  configDir?: string;
  repoRoot?: string;
  /** Tried in order. Defaults to the file resolver only; a KMS resolver must be injected explicitly. */
  keyResolvers?: TrustedKeyResolver[];
  logger?: Logger;
}

export interface DeployableConfig {
  config: PlatformConfig;
  report: GuardReport;
  source: LoadedConfig["source"];
}

export async function resolveTrustedKey(ref: string | null, resolvers: readonly TrustedKeyResolver[], logger: Logger): Promise<KeyObject | null> {
  if (!ref) return null;
  for (const r of resolvers) {
    try {
      const key = await r.resolve(ref);
      if (key) return key;
    } catch (err) {
      logger.warn("config.approval_key.unresolved", { reasonCode: err instanceof PlatformError ? err.reasonCode : "UNCLASSIFIED_ERROR", kind: r.kind });
      return null;
    }
  }
  return null;
}

export async function loadDeployableConfig(inputs: StartupInputs): Promise<DeployableConfig> {
  const logger = inputs.logger ?? silentLogger;
  const repoRoot = inputs.repoRoot ?? REPO_ROOT;
  const loaded = loadPlatformConfig({ environment: inputs.environment, configDir: inputs.configDir, env: inputs.env });
  const approvals = loadApprovalRecords(resolve(repoRoot, loaded.config.approvals.directory));
  const trustedApprovalKey = await resolveTrustedKey(
    loaded.config.approvals.trustedSigningKeyRef,
    inputs.keyResolvers ?? [new FileTrustedKeyResolver(repoRoot)],
    logger,
  );
  try {
    const report = assertDeployable(loaded.config, {
      approvals: approvals.records,
      rejectedApprovalFiles: approvals.rejected,
      duplicateApprovalIds: approvals.duplicateIds,
      trustedApprovalKey,
      adapterKinds: inputs.adapterKinds,
      loadedPolicy: inputs.loadedPolicy,
      toolCatalogDigest: inputs.toolCatalogDigest,
      now: inputs.clock.now(),
    });
    logger.info("config.guard.accepted", { environment: report.environment, ruleSet: report.ruleSet, fileDigest: loaded.source.fileDigest });
    return { config: loaded.config, report, source: loaded.source };
  } catch (err) {
    if (err instanceof ConfigurationRejectedError) {
      logger.error("config.guard.rejected", { environment: loaded.config.environment, violationCount: err.violations.length, fileDigest: loaded.source.fileDigest });
    }
    throw err;
  }
}
