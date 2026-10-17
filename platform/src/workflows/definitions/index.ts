import type { VersionedWorkflowDefinition } from "../types.js";
import { billingDisputeReviewV1 } from "./billing-dispute-review.js";
import { callbackRequestV1 } from "./callback-request.js";
import { claimInvestigationV1 } from "./claim-investigation.js";
import { complaintReviewV1 } from "./complaint-review.js";
import { partnerOnboardingV1 } from "./partner-onboarding.js";
import { providerDocumentReviewV1 } from "./provider-document-review.js";
import { supportRequestSyncV1 } from "./support-request-sync.js";

export {
  billingDisputeReviewV1,
  callbackRequestV1,
  claimInvestigationV1,
  complaintReviewV1,
  partnerOnboardingV1,
  providerDocumentReviewV1,
  supportRequestSyncV1,
};
export { ESCALATED, deepFreeze, humanTaskFor, terminalState, waitState } from "./builders.js";

/**
 * Every shipped definition version. Old versions stay in this list after a new
 * version is added so in-flight instances keep loading the version they pinned
 * at start (spec section 15, Phase 5).
 */
export const SHIPPED_DEFINITIONS: readonly VersionedWorkflowDefinition[] = Object.freeze([
  billingDisputeReviewV1,
  providerDocumentReviewV1,
  claimInvestigationV1,
  partnerOnboardingV1,
  supportRequestSyncV1,
  callbackRequestV1,
  complaintReviewV1,
]);
