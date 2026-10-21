/**
 * Registry of the deployment guard's rule files (WP-07; OPS-04, FO-19-06).
 *
 * The guard (../guard.ts) runs every rule of GUARD_RULES whose rule set applies, in this order. Each module
 * that owns configuration contributes its rules as a file here (module-local sub-schemas and rule sets, for
 * example console-api/sso-config.ts and connectors/profile/credentials.ts, are called from their rule file).
 * The registry test (index.test.ts) fails when a rule file exists that the registry does not list, so a rule
 * can never be added without running.
 */
import { approvalsRule } from "./approvals.js";
import { connectorCredentialRule } from "./connectors.js";
import { consoleWorkforceRule } from "./console-workforce.js";
import { corsAndBindingRule } from "./cors.js";
import { egressRule } from "./egress.js";
import { fullRule } from "./full.js";
import { gatewayLimitsRule } from "./gateway.js";
import { infrastructureRule } from "./infrastructure.js";
import { keySeparationRule } from "./key-separation.js";
import { mandatoryDataRule } from "./mandatory.js";
import { observabilityRule } from "./observability.js";
import { offlineRule } from "./offline.js";
import { sandboxRule } from "./sandbox.js";
import type { GuardRule } from "./types.js";
import { universalRule } from "./universal.js";

export const GUARD_RULES: readonly GuardRule[] = Object.freeze([
  universalRule,
  consoleWorkforceRule,
  offlineRule,
  sandboxRule,
  fullRule,
  mandatoryDataRule,
  corsAndBindingRule,
  gatewayLimitsRule,
  infrastructureRule,
  keySeparationRule,
  egressRule,
  observabilityRule,
  connectorCredentialRule,
  approvalsRule,
]);

/** Files of this directory that hold shared helpers, not rules. */
export const RULE_HELPER_FILES: readonly string[] = Object.freeze(["capabilities.ts", "index.ts", "live-adapters.ts", "types.ts"]);

export { ADAPTER_CAPABILITY, CONSOLE_LOCAL_SIGN_IN_COMPONENT, WORKFORCE_IDP_ADAPTER_KEY, capabilityForAdapter, componentGuardStates } from "./capabilities.js";
export type { ComponentGuardState } from "./capabilities.js";
export { egressDestinationFor } from "./egress.js";
export { keySeparationViolations, secretUses, trustAnchorShared } from "./key-separation.js";
export type { SecretBearing } from "./key-separation.js";
export { requiredScopes } from "./approvals.js";
export * from "./types.js";
