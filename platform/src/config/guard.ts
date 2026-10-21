/**
 * Deployment configuration guard (OPS-04, OPS-05, OPS-06, DATA-01; spec section 16).
 *
 * `evaluateDeployability` returns every violation for the configuration's
 * environment; `assertDeployable` throws ConfigurationRejectedError when there
 * is any. Rule sets:
 *
 *  - offline (local, ci): synthetic fixtures only. Live adapters, PHI endpoints and
 *    PHI_PROCESSING scopes are rejected so no PHI or paid vendor traffic can be
 *    reached from developer machines or CI.
 *  - sandbox: fixtures remain allowed for systems not yet approved, but PHI must be
 *    impossible (no PHI_PROCESSING scope in use, PHI endpoints off) and every live
 *    adapter must reference a valid, signed VENDOR_SANDBOX_INTEGRATION approval and
 *    carry a real endpoint and credential reference.
 *  - full (staging, production): no fixtures anywhere, credentials present and not
 *    placeholders, model/voice approved, policy and tool catalogue pinned and equal
 *    to what is loaded, strict CORS, audit on with the Object Lock sink, retention
 *    set by counsel, security-approved verification values, KMS-backed signing and
 *    approval trust, and every required approval present, signed, unexpired and
 *    issued for this environment.
 *
 * Every approval is additionally bound (OPS-APPR-01): its approver role must be
 * allowed for its scope, and a subject-bound scope (MODEL_VOICE_SELECTION,
 * POLICY_RELEASE, KNOWLEDGE_RELEASE, CLINICAL_SCRIPTS, PRODUCTION_DEPLOYMENT,
 * PILOT_EXPOSURE) only counts when its signed `subject` equals the active
 * model/voice/agentConfig, the loaded policy bundle, and the knowledge snapshot,
 * template catalogue and image digests the composition supplies. A record that
 * names another artifact, or one the composition cannot state, never counts.
 *
 * Rules live in per-module rule files (platform/src/config/rules/*.ts, registry in rules/index.ts; WP-07).
 * A violation is either BLOCKING (the environment is not deployable: fixtures in a live environment, missing
 * mandatory data, approvals, pins) or a CAPABILITY violation (a tenant input of one capability is missing or
 * invalid): the latter makes only that capability NOT_CONFIGURED in the activation map (`components`,
 * `notConfiguredCapabilities`) and the environment still starts (FO-00-26, FO-00-30, FO-19-06). `violations`
 * lists both; `deployable` is computed from `blocking` only. A rejection reports every violation.
 *
 * Violation strings are `<CODE>@<config path>`: reason codes and configuration keys
 * only, never configuration values, credential references or approver names.
 */
import type { KeyObject } from "node:crypto";
import type { RuntimeCapabilityId } from "../observability/composition-catalog.js";
import type { ApprovalScope, Environment } from "../protocol/index.js";
import { ConfigurationRejectedError } from "../shared/errors.js";
import { evaluateApproval, parseTrustedPublicKey } from "./approvals.js";
import type { ApprovalEvaluation, ApprovalSubjectExpectations } from "./approvals.js";
import type { PlatformConfig } from "./ports.js";
import { GUARD_RULES, RULE_SET_BY_ENVIRONMENT, componentGuardStates, requiredScopes, trustAnchorShared, Collector } from "./rules/index.js";
import type { CapabilityViolation, ComponentGuardState, GuardContext, GuardViolation, Lookups, RuleSet } from "./rules/index.js";
import { PlatformConfigSchema } from "./schema.js";

export { CONSOLE_LOCAL_SIGN_IN_COMPONENT, REQUIRED_APPROVALS_BY_ENVIRONMENT, RULE_SET_BY_ENVIRONMENT, WORKFORCE_IDP_ADAPTER_KEY } from "./rules/index.js";
export type { CapabilityViolation, ComponentGuardState, GuardContext, GuardViolation, RuleSet } from "./rules/index.js";

export interface GuardReport {
  environment: Environment;
  ruleSet: RuleSet;
  /** True when no BLOCKING violation exists (capability violations only disable their capability). */
  deployable: boolean;
  /** Every violation (blocking and capability-level), in rule order. */
  violations: GuardViolation[];
  /** Violations that refuse the environment. */
  blocking: GuardViolation[];
  /** Violations that make one capability NOT_CONFIGURED. */
  capabilityViolations: CapabilityViolation[];
  /** Config-governed state of every capability component (empty for the offline regression rule set). */
  components: ComponentGuardState[];
  /** Capabilities with at least one NOT_CONFIGURED component. */
  notConfiguredCapabilities: RuntimeCapabilityId[];
  /** Rule ids evaluated, in order. */
  rulesEvaluated: string[];
  approvals: ApprovalEvaluation[];
  requiredApprovals: { scope: ApprovalScope; satisfiedBy: string | null }[];
  /** True only when the full rule set passed and a valid PHI_PROCESSING approval covers enabled PHI endpoints. */
  phiEndpointsPermitted: boolean;
}

export const formatViolation = (v: GuardViolation): string => `${v.code}@${v.path}`;

function resolveKey(key: GuardContext["trustedApprovalKey"]): KeyObject | null | "INVALID" {
  if (key === undefined || key === null) return null;
  if (typeof key === "string") {
    try {
      return parseTrustedPublicKey(key);
    } catch {
      return "INVALID";
    }
  }
  return key.type === "public" ? key : "INVALID";
}

export function evaluateDeployability(config: PlatformConfig, ctx: GuardContext): GuardReport {
  const v = new Collector();
  const parsed = PlatformConfigSchema.safeParse(config);
  const environment = config.environment;
  const ruleSet: RuleSet = RULE_SET_BY_ENVIRONMENT[environment] ?? "full";
  if (!parsed.success) {
    v.add("CONFIG_SCHEMA_INVALID", "$");
    return {
      environment,
      ruleSet,
      deployable: false,
      violations: v.list,
      blocking: v.blocking(),
      capabilityViolations: [],
      components: [],
      notConfiguredCapabilities: [],
      rulesEvaluated: [],
      approvals: [],
      requiredApprovals: [],
      phiEndpointsPermitted: false,
    };
  }

  // ---------- approvals: evaluate every record once ----------
  const key = resolveKey(ctx.trustedApprovalKey);
  // Key separation (rules/key-separation.ts, FO-14-56): in a live rule set a trust anchor the runtime itself can
  // sign with, or one whose separation from a runtime signing key could not be checked by key material
  // (RUNTIME_SIGNING_KEY_UNRESOLVED), is never used, so no record verifies (a record the runtime minted is never
  // VALID); the rule reports the blocking reason.
  const trustRefused = ruleSet !== "offline" && trustAnchorShared(config, ctx);
  const trustedKey = key === "INVALID" || trustRefused ? null : key;
  // OPS-APPR-01: a record only counts when its signed subject names what is configured/loaded.
  const expected: ApprovalSubjectExpectations = {
    modelVoice: config.models.active,
    policyBundle: ctx.loadedPolicy ? { version: ctx.loadedPolicy.version, digest: ctx.loadedPolicy.digest } : null,
    knowledgeSnapshotDigest: ctx.knowledgeSnapshotDigest ?? null,
    templateCatalogDigest: ctx.templateCatalogDigest ?? null,
    releaseImageDigest: ctx.releaseImageDigest ?? null,
  };
  const evaluations = ctx.approvals.map((r) => evaluateApproval(r, { environment, now: ctx.now, trustedKey, expected }));
  const byId = new Map(evaluations.map((e) => [e.approvalId, e]));
  const validFor = (scope: ApprovalScope) => evaluations.filter((e) => e.scope === scope && e.status === "VALID");
  const lookups: Lookups = {
    referencedValid: (id, scope) => {
      if (!id) return false;
      const e = byId.get(id);
      return !!e && e.scope === scope && e.status === "VALID";
    },
    hasTrustKey: trustedKey !== null,
    trustKeyInvalid: key === "INVALID",
    trustKeyRefused: trustRefused,
    evaluations,
    validFor,
  };

  const rulesEvaluated: string[] = [];
  for (const rule of GUARD_RULES) {
    if (!rule.ruleSets.includes(ruleSet)) continue;
    rule.evaluate({ config, ctx, ruleSet, v, l: lookups });
    rulesEvaluated.push(rule.id);
  }

  const requiredApprovals = requiredScopes(environment, config.approvals.required).map((scope) => ({ scope, satisfiedBy: validFor(scope)[0]?.approvalId ?? null }));
  const phiEnabled = config.phi?.endpointsEnabled === true;
  const phiApproved = validFor("PHI_PROCESSING").length > 0;
  const violations = v.list;
  const blocking = v.blocking();
  const components = componentGuardStates(config, ruleSet, v.capabilityList);
  const notConfiguredCapabilities = [...new Set(components.filter((c) => c.state === "NOT_CONFIGURED").map((c) => c.capabilityId))].sort();
  return {
    environment,
    ruleSet,
    deployable: blocking.length === 0,
    violations,
    blocking,
    capabilityViolations: v.capabilityList,
    components,
    notConfiguredCapabilities,
    rulesEvaluated,
    approvals: evaluations,
    requiredApprovals,
    phiEndpointsPermitted: ruleSet === "full" && violations.length === 0 && phiEnabled && phiApproved,
  };
}

/**
 * Throws ConfigurationRejectedError when the configuration has a blocking violation for its environment (the
 * error lists every violation, capability-level ones included, so one rejection shows the whole picture).
 */
export function assertDeployable(config: PlatformConfig, ctx: GuardContext): GuardReport {
  const report = evaluateDeployability(config, ctx);
  if (!report.deployable) throw new ConfigurationRejectedError(report.violations.map(formatViolation));
  return report;
}

/** Convenience for runtime code paths: PHI endpoints are usable only when the guard explicitly permitted them. */
export function phiEndpointsPermitted(report: GuardReport | null | undefined): boolean {
  return report?.phiEndpointsPermitted === true;
}
