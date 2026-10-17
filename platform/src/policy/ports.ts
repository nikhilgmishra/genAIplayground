import type { PolicyDecision, PolicyInput } from "../protocol/index.js";

/**
 * Local OPA evaluation beside the tool service. Implementations MUST NOT throw:
 * any load or evaluation error yields allow=false with reason POLICY_ENGINE_ERROR.
 */
export interface PolicyEngine {
  readonly policyVersion: string;
  /** sha256 of the policy bundle artifact, pinned in the ReleaseManifest. */
  readonly bundleDigest: string;
  decide(input: PolicyInput): Promise<PolicyDecision>;
}
