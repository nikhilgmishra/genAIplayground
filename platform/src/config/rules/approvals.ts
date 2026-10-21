/**
 * Approvals (every environment; OPS-04, OPS-06, OPS-APPR-01). The environment's approval floor cannot be
 * lowered by configuration; every required scope needs a VALID record (signed by the trusted key, unexpired,
 * for this environment, by a permitted approver role, naming the configured subject), and the failures of the
 * records that do not count are reported. Approval files that failed strict parsing and duplicate ids are
 * violations. PHI endpoints in staging/production need a valid PHI_PROCESSING record. All blocking: approvals
 * are human governance of the environment, not a tenant input of one capability.
 */
import type { ApprovalScope } from "../../protocol/index.js";
import { ALL_RULE_SETS, REQUIRED_APPROVALS_BY_ENVIRONMENT } from "./types.js";
import type { GuardRule } from "./types.js";

/** The required scopes of a configuration (floor plus configured), in report order. */
export function requiredScopes(environment: keyof typeof REQUIRED_APPROVALS_BY_ENVIRONMENT, configured: readonly ApprovalScope[]): ApprovalScope[] {
  return [...new Set<ApprovalScope>([...REQUIRED_APPROVALS_BY_ENVIRONMENT[environment], ...configured])];
}

export const approvalsRule: GuardRule = {
  id: "approvals",
  file: "approvals.ts",
  ruleSets: ALL_RULE_SETS,
  evaluate({ config, ctx, ruleSet, v, l }) {
    if (l.trustKeyInvalid) v.add("APPROVAL_TRUST_KEY_INVALID", "approvals.trustedSigningKeyRef");
    const floor = REQUIRED_APPROVALS_BY_ENVIRONMENT[config.environment];
    for (const scope of floor) {
      if (!config.approvals.required.includes(scope)) v.add("APPROVAL_REQUIREMENT_BELOW_FLOOR", `approvals.required.${scope}`);
    }
    const required = requiredScopes(config.environment, config.approvals.required);
    for (const scope of required) {
      if (l.validFor(scope).length > 0) continue;
      v.add("APPROVAL_MISSING", `approvals.required.${scope}`);
      for (const e of l.evaluations.filter((x) => x.scope === scope)) {
        for (const f of e.failures) v.add(`APPROVAL_${f}`, `approvals.records.${e.approvalId}`);
      }
    }
    if (required.length > 0 && !config.approvals.trustedSigningKeyRef) v.add("APPROVAL_TRUST_KEY_MISSING", "approvals.trustedSigningKeyRef");
    if (required.length > 0 && config.approvals.trustedSigningKeyRef && !l.hasTrustKey && !l.trustKeyInvalid && !l.trustKeyRefused) {
      v.add("APPROVAL_TRUST_KEY_UNRESOLVED", "approvals.trustedSigningKeyRef");
    }
    for (const f of ctx.rejectedApprovalFiles ?? []) v.add(f.reasonCode, `approvals.files.${f.file}`);
    for (const id of ctx.duplicateApprovalIds ?? []) v.add("APPROVAL_DUPLICATE_ID", `approvals.records.${id}`);
    if (config.phi?.endpointsEnabled === true && ruleSet === "full" && l.validFor("PHI_PROCESSING").length === 0) v.add("PHI_ENDPOINTS_UNAPPROVED", "phi.endpointsEnabled");
  },
};
