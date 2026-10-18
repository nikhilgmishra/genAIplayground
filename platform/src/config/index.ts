export * from "./ports.js";
export {
  PlatformConfigSchema,
  AdapterConfigSchema,
  DestinationConfigSchema,
  OpsConfigSchema,
  SecretRef,
  SECRET_REF_PATTERN,
  ConfigInvalidError,
  parsePlatformConfig,
  GatewayConfigSchema,
  GatewayInboundAuthSchema,
  gatewayConfigOf,
} from "./schema.js";
export type { ParsedPlatformConfig, ParsedGatewayConfig } from "./schema.js";
export {
  loadPlatformConfig,
  applyEnvOverrides,
  allowedOverrideNames,
  ConfigOverrideRejectedError,
  CONFIG_DIR,
  REPO_ROOT,
  ENV_OVERRIDE_PREFIX,
  loadInfrastructureEnv,
  InfrastructureEnvRejectedError,
} from "./loader.js";
export type { LoadConfigOptions, LoadedConfig, InfrastructureEnv } from "./loader.js";
export {
  approvalSigningPayload,
  verifyApprovalSignature,
  evaluateApproval,
  loadApprovalRecords,
  parseTrustedPublicKey,
  algorithmForKey,
  FileTrustedKeyResolver,
  KmsTrustedKeyResolver,
} from "./approvals.js";
export type { ApprovalEvaluation, ApprovalStatus, SignatureStatus, SignatureAlgorithm, LoadedApprovals, TrustedKeyResolver, KmsPublicKeyClient } from "./approvals.js";
export {
  evaluateDeployability,
  assertDeployable,
  formatViolation,
  phiEndpointsPermitted,
  REQUIRED_APPROVALS_BY_ENVIRONMENT,
  RULE_SET_BY_ENVIRONMENT,
} from "./guard.js";
export type { GuardContext, GuardReport, GuardViolation, RuleSet } from "./guard.js";
export { loadDeployableConfig, resolveTrustedKey } from "./startup.js";
export type { StartupInputs, DeployableConfig } from "./startup.js";
