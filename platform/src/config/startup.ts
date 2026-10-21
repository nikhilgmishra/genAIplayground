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
import { RULE_SET_BY_ENVIRONMENT } from "./rules/index.js";
import type { GuardContext, GuardReport } from "./guard.js";
import { REPO_ROOT, loadPlatformConfig } from "./loader.js";
import type { LoadedConfig } from "./loader.js";
import type { PlatformConfig } from "./ports.js";

export interface StartupInputs {
  environment: Environment;
  clock: Clock;
  adapterKinds: Record<string, "local_fixture" | "live">;
  loadedPolicy: { version: string; digest: string } | null;
  toolCatalogDigest: string | null;
  /** OPS-APPR-01: digests of the served knowledge snapshot, template catalogue and running image (see GuardContext). */
  knowledgeSnapshotDigest?: string | null;
  templateCatalogDigest?: string | null;
  releaseImageDigest?: string | null;
  env?: Readonly<Record<string, string | undefined>>;
  configDir?: string;
  repoRoot?: string;
  /**
   * Connector profiles of this environment plus the committed adapter references of every environment
   * (credential separation rule, rules/connectors.ts). Absent: that rule has nothing to compare.
   */
  connectorCredentialSets?: GuardContext["connectorCredentialSets"];
  /** Runtime signing keys of the other committed environment configurations (key separation rule). */
  committedSigningKeys?: GuardContext["committedSigningKeys"];
  /** Tried in order. Defaults to the file resolver only; a KMS resolver must be injected explicitly. */
  keyResolvers?: TrustedKeyResolver[];
  /**
   * Resolvers of the runtime signing keys' PUBLIC keys for the key separation check only (never a trust anchor):
   * the live composition passes `KmsRuntimeSigningKeyResolver`, which accepts every form the runtime signs with
   * (key ARN, bare key id, mrk- id). Default: `keyResolvers`.
   */
  signingKeyResolvers?: TrustedKeyResolver[];
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

/**
 * The public keys of this environment's runtime signing keys (assertion key, audit manifest signing and trusted
 * manifest keys), for the key separation rule's key-material comparison (rules/key-separation.ts; FO-14-56). Live
 * rule sets only. A reference no resolver supports, or one whose resolution fails or is denied, is left out and
 * logged with its path and reason code (config.runtime_signing_key.unresolved); the guard then refuses the
 * environment (RUNTIME_SIGNING_KEY_UNRESOLVED@<path>): an unresolved key is never silently compared by reference only.
 */
export async function resolveRuntimeSigningPublicKeys(config: PlatformConfig, resolvers: readonly TrustedKeyResolver[], logger: Logger): Promise<{ path: string; key: KeyObject }[]> {
  if (RULE_SET_BY_ENVIRONMENT[config.environment] === "offline") return [];
  const ex = config.infrastructure?.auditExport ?? null;
  const refs: { path: string; ref: string | null }[] = [
    { path: "signing.assertionKeyRef", ref: config.signing.assertionKeyRef },
    ...(ex ? [{ path: "infrastructure.auditExport.manifestSigningKeyId", ref: ex.manifestSigningKeyId }, ...ex.trustedManifestKeyIds.map((ref, i) => ({ path: `infrastructure.auditExport.trustedManifestKeyIds.${i}`, ref }))] : []),
  ];
  const out: { path: string; key: KeyObject }[] = [];
  for (const { path, ref } of refs) {
    if (!ref) continue;
    let unresolved: { reasonCode: string; kind: string } | null = { reasonCode: "RUNTIME_SIGNING_KEY_REF_UNSUPPORTED", kind: "none" };
    for (const r of resolvers) {
      try {
        const key = await r.resolve(ref);
        if (key) {
          out.push({ path, key });
          unresolved = null;
          break;
        }
      } catch (err) {
        unresolved = { reasonCode: err instanceof PlatformError ? err.reasonCode : "UNCLASSIFIED_ERROR", kind: r.kind };
        break;
      }
    }
    if (unresolved) logger.warn("config.runtime_signing_key.unresolved", { ...unresolved, component: path });
  }
  return out;
}

export async function loadDeployableConfig(inputs: StartupInputs): Promise<DeployableConfig> {
  const logger = inputs.logger ?? silentLogger;
  const repoRoot = inputs.repoRoot ?? REPO_ROOT;
  const loaded = loadPlatformConfig({ environment: inputs.environment, configDir: inputs.configDir, env: inputs.env });
  const approvals = loadApprovalRecords(resolve(repoRoot, loaded.config.approvals.directory));
  const resolvers = inputs.keyResolvers ?? [new FileTrustedKeyResolver(repoRoot)];
  const trustedApprovalKey = await resolveTrustedKey(loaded.config.approvals.trustedSigningKeyRef, resolvers, logger);
  // Key separation by key material (FO-14-56): the runtime signing keys' public keys, through the same resolvers.
  const runtimeSigningPublicKeys = await resolveRuntimeSigningPublicKeys(loaded.config, inputs.signingKeyResolvers ?? resolvers, logger);
  try {
    const report = assertDeployable(loaded.config, {
      approvals: approvals.records,
      rejectedApprovalFiles: approvals.rejected,
      duplicateApprovalIds: approvals.duplicateIds,
      trustedApprovalKey,
      adapterKinds: inputs.adapterKinds,
      loadedPolicy: inputs.loadedPolicy,
      toolCatalogDigest: inputs.toolCatalogDigest,
      knowledgeSnapshotDigest: inputs.knowledgeSnapshotDigest ?? null,
      templateCatalogDigest: inputs.templateCatalogDigest ?? null,
      releaseImageDigest: inputs.releaseImageDigest ?? null,
      ...(inputs.connectorCredentialSets ? { connectorCredentialSets: inputs.connectorCredentialSets } : {}),
      ...(inputs.committedSigningKeys ? { committedSigningKeys: inputs.committedSigningKeys } : {}),
      runtimeSigningPublicKeys,
      now: inputs.clock.now(),
    });
    logger.info("config.guard.accepted", {
      environment: report.environment,
      ruleSet: report.ruleSet,
      fileDigest: loaded.source.fileDigest,
      count: report.notConfiguredCapabilities.length,
    });
    return { config: loaded.config, report, source: loaded.source };
  } catch (err) {
    if (err instanceof ConfigurationRejectedError) {
      logger.error("config.guard.rejected", { environment: loaded.config.environment, violationCount: err.violations.length, fileDigest: loaded.source.fileDigest });
    }
    throw err;
  }
}
