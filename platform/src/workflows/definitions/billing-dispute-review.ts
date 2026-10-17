/**
 * billing_dispute_review — a disputed charge routed into durable review without
 * promising a refund (spec section 16 demonstration journey). The human
 * decision is taken by a billing specialist (mapped onto staff roles
 * supervisor / support_agent). Applying an adjustment is a material change and
 * communicating the decision is a later disclosure; both are rechecked.
 */
import type { VersionedWorkflowDefinition } from "../types.js";
import { deepFreeze, humanTaskFor, terminalState, waitState } from "./builders.js";

export const billingDisputeReviewV1: VersionedWorkflowDefinition = deepFreeze({
  type: "billing_dispute_review",
  version: "1.0.0",
  description: "Durable review of a disputed invoice line; no refund is promised before a specialist decision and an authoritative commit.",
  initial: "ACCEPTED",
  states: {
    ACCEPTED: waitState({
      owner: "q_billing_intake",
      deadline: "PT15M",
      retryBudget: 3,
      escalationOwner: "q_billing_supervisors",
      transitions: { VALIDATE: "VALIDATING", CANCEL: "CANCELLED", ESCALATED: "WAITING_FOR_HUMAN" },
    }),
    VALIDATING: waitState({
      owner: "q_billing_intake",
      deadline: "PT1H",
      retryBudget: 3,
      escalationOwner: "q_billing_supervisors",
      transitions: {
        VALIDATION_PASSED: "WAITING_FOR_HUMAN",
        NEEDS_CALLER_INFO: "WAITING_FOR_CALLER",
        CANCEL: "CANCELLED",
        ESCALATED: "WAITING_FOR_HUMAN",
      },
    }),
    WAITING_FOR_CALLER: waitState({
      owner: "q_billing_specialists",
      deadline: "P7D",
      retryBudget: 2,
      escalationOwner: "q_billing_supervisors",
      transitions: { CALLER_RESPONDED: "VALIDATING", CANCEL: "CANCELLED", ESCALATED: "WAITING_FOR_HUMAN" },
    }),
    WAITING_FOR_HUMAN: waitState({
      owner: "q_billing_specialists",
      deadline: "P2D",
      retryBudget: 0,
      escalationOwner: "q_billing_supervisors",
      humanTask: humanTaskFor("billing_specialist", "billing_dispute_decision"),
      transitions: {
        HUMAN_APPROVED: "READY_TO_COMMIT",
        HUMAN_REJECTED: "COMPLETED",
        NEEDS_CALLER_INFO: "WAITING_FOR_CALLER",
        POLICY_CHANGED_PENDING_ACTION: "WAITING_FOR_HUMAN",
        CANCEL: "CANCELLED",
        ESCALATED: "WAITING_FOR_HUMAN",
      },
    }),
    READY_TO_COMMIT: waitState({
      owner: "q_billing_system_sync",
      deadline: "PT1H",
      retryBudget: 3,
      escalationOwner: "q_billing_supervisors",
      transitions: {
        COMMIT: "WAITING_FOR_SYSTEM",
        POLICY_CHANGED_PENDING_ACTION: "WAITING_FOR_HUMAN",
        CANCEL: "CANCELLED",
        ESCALATED: "WAITING_FOR_HUMAN",
      },
    }),
    // No CANCEL after commit submission: an external effect may already be in flight.
    WAITING_FOR_SYSTEM: waitState({
      owner: "q_billing_system_sync",
      deadline: "PT4H",
      retryBudget: 5,
      escalationOwner: "q_billing_supervisors",
      transitions: {
        SYSTEM_CONFIRMED: "COMPLETED",
        SYSTEM_REJECTED: "WAITING_FOR_HUMAN",
        PERMANENT_FAILURE: "FAILED",
        POLICY_CHANGED_PENDING_ACTION: "WAITING_FOR_HUMAN",
        ESCALATED: "WAITING_FOR_HUMAN",
      },
    }),
    COMPLETED: terminalState("q_billing_specialists"),
    FAILED: terminalState("q_billing_supervisors"),
    CANCELLED: terminalState("q_billing_specialists"),
  },
  transitionGuards: {
    WAITING_FOR_HUMAN: { HUMAN_REJECTED: "disclosure" },
    READY_TO_COMMIT: { COMMIT: "material_change" },
    WAITING_FOR_SYSTEM: { SYSTEM_CONFIRMED: "disclosure" },
  },
  humanTaskRoles: { WAITING_FOR_HUMAN: "billing_specialist" },
});
