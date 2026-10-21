/**
 * Sandbox rule set (OPS-05, FO-19-06). PHI is impossible (no PHI_PROCESSING scope in use, PHI endpoints off)
 * and audit stays on. A live adapter must reference a valid, signed VENDOR_SANDBOX_INTEGRATION approval and
 * carry real tenant inputs; when it does not, its capability is NOT_CONFIGURED (capability violation) and the
 * environment still starts. A component DECLARED local_fixture is NOT_CONFIGURED as well (the live composition
 * composes no fixture for it). A fixture actually INSTANTIATED by the composition is refused: the sandbox runs
 * real adapters or none (FO-19-06), never a synthetic stand-in.
 */
import { capabilityForAdapter } from "./capabilities.js";
import { liveAdapterRules } from "./live-adapters.js";
import { KMS_KEY_ARN, noPhiScope, safeKey } from "./types.js";
import type { GuardRule } from "./types.js";

export const sandboxRule: GuardRule = {
  id: "sandbox",
  file: "sandbox.ts",
  ruleSets: ["sandbox"],
  evaluate({ config, ctx, v, l }) {
    if (config.phi?.endpointsEnabled) v.add("PHI_ENDPOINTS_FORBIDDEN_IN_ENVIRONMENT", "phi.endpointsEnabled");
    noPhiScope(config, ctx, v);
    let anyLive = false;
    for (const [name, a] of Object.entries(config.adapters)) {
      if (a.kind !== "live") continue;
      anyLive = true;
      if (!l.referencedValid(a.integrationApprovalId, "VENDOR_SANDBOX_INTEGRATION")) {
        const cap = capabilityForAdapter(name);
        if (cap) v.capability(cap, name, "SANDBOX_LIVE_ADAPTER_UNAPPROVED", `adapters.${name}`);
        else v.add("SANDBOX_LIVE_ADAPTER_UNAPPROVED", `adapters.${safeKey(name)}`);
      }
      liveAdapterRules(name, a, v, l);
    }
    for (const [name, kind] of Object.entries(ctx.adapterKinds)) {
      if (kind === "live" && !Object.hasOwn(config.adapters, name)) v.add("SANDBOX_LIVE_COMPONENT_UNDECLARED", `runtime.${safeKey(name)}`);
      if (kind === "local_fixture") v.add("SANDBOX_RUNTIME_LOCAL_FIXTURE", `runtime.${safeKey(name)}`);
    }
    if (anyLive && !config.approvals.trustedSigningKeyRef) v.add("APPROVAL_TRUST_KEY_MISSING", "approvals.trustedSigningKeyRef");
    // FO-14-56: approvals are verified against a KMS public key only; a repository PEM (file:) or a local fixture
    // key would let a demo's self-made approval pass for a real one.
    const trustRef = config.approvals.trustedSigningKeyRef;
    if (trustRef && !KMS_KEY_ARN.test(trustRef)) v.add("APPROVAL_TRUST_KEY_REF_NOT_KMS", "approvals.trustedSigningKeyRef");
  },
};
