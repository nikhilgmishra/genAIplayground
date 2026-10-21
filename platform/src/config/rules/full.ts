/**
 * Full rule set (staging, production; OPS-04, OPS-06): no fixtures anywhere (declared or instantiated), no
 * synthetic or placeholder tenant, model/voice approved, policy and tool catalogue pinned and equal to what is
 * loaded, security-approved verification values, retention set by counsel, KMS-backed approval trust, real
 * destination queue references and the operations block present. Live adapters are checked by
 * live-adapters.ts (capability-level).
 */
import { liveAdapterRules } from "./live-adapters.js";
import { KMS_KEY_ARN, isPlaceholder, safeKey } from "./types.js";
import type { GuardRule } from "./types.js";

export const fullRule: GuardRule = {
  id: "full",
  file: "full.ts",
  ruleSets: ["full"],
  evaluate({ config, ctx, v, l }) {
    const t = config.tenantId.toLowerCase();
    if (t.includes("synth")) v.add("TENANT_SYNTHETIC_FIXTURE", "tenantId");
    if (isPlaceholder(config.tenantId)) v.add("TENANT_PLACEHOLDER", "tenantId");

    // Fixtures anywhere (OPS-04, FO-19-06).
    for (const [name, a] of Object.entries(config.adapters)) {
      if (a.kind === "local_fixture") v.add("ADAPTER_LOCAL_FIXTURE", `adapters.${name}`);
      else liveAdapterRules(name, a, v, l);
    }
    for (const [name, kind] of Object.entries(ctx.adapterKinds)) {
      if (kind === "local_fixture") v.add("ADAPTER_RUNTIME_LOCAL_FIXTURE", `runtime.${safeKey(name)}`);
    }

    // Pinned, reviewable versions (OPS-06).
    const active = config.models.active;
    const approved = config.models.approved.find((m) => m.model === active.model && m.voice === active.voice);
    if (!approved) v.add("MODEL_VOICE_NOT_APPROVED", "models.active");
    else if (!approved.approvalId) v.add("MODEL_VOICE_APPROVAL_MISSING", "models.approved");
    else if (!l.referencedValid(approved.approvalId, "MODEL_VOICE_SELECTION")) v.add("MODEL_VOICE_APPROVAL_INVALID", "models.approved");
    if (!config.policy.expectedVersion) v.add("POLICY_VERSION_UNPINNED", "policy.expectedVersion");
    if (!config.policy.expectedDigest) v.add("POLICY_DIGEST_UNPINNED", "policy.expectedDigest");
    if (!ctx.loadedPolicy) v.add("POLICY_BUNDLE_NOT_LOADED", "policy.bundlePath");
    else {
      if (config.policy.expectedVersion && ctx.loadedPolicy.version !== config.policy.expectedVersion) v.add("POLICY_VERSION_MISMATCH", "policy.expectedVersion");
      if (config.policy.expectedDigest && ctx.loadedPolicy.digest !== config.policy.expectedDigest) v.add("POLICY_DIGEST_MISMATCH", "policy.expectedDigest");
    }
    if (!config.toolCatalog.expectedDigest) v.add("TOOL_CATALOG_DIGEST_UNPINNED", "toolCatalog.expectedDigest");
    if (!ctx.toolCatalogDigest) v.add("TOOL_CATALOG_NOT_LOADED", "toolCatalog.expectedDigest");
    else if (config.toolCatalog.expectedDigest && ctx.toolCatalogDigest !== config.toolCatalog.expectedDigest) v.add("TOOL_CATALOG_DIGEST_MISMATCH", "toolCatalog.expectedDigest");

    // Verification values must be security-approved.
    if (!config.verification.approvedBySecurity) v.add("VERIFICATION_VALUES_UNAPPROVED", "verification.approvedBySecurity");
    else if (!l.referencedValid(config.verification.approvedBySecurity, "SECURITY_REVIEW")) v.add("VERIFICATION_APPROVAL_INVALID", "verification.approvedBySecurity");

    // Retention durations are set by counsel; never invented here.
    for (const [cls, days] of Object.entries(config.retention)) {
      if (days === null) v.add("RETENTION_UNSET", `retention.${cls}`);
    }

    const trustRef = config.approvals.trustedSigningKeyRef;
    if (trustRef && !KMS_KEY_ARN.test(trustRef)) v.add("APPROVAL_TRUST_KEY_REF_NOT_KMS", "approvals.trustedSigningKeyRef");

    for (const [i, d] of config.destinations.entries()) {
      if (isPlaceholder(d.vendorQueueRef)) v.add("DESTINATION_VENDOR_REF_PLACEHOLDER", `destinations.${i}.vendorQueueRef`);
    }
    if (!config.ops) v.add("OPS_CONFIG_MISSING", "ops");
  },
};
