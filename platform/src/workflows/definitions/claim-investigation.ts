/**
 * claim_investigation — follow-up on a claim status question that needs payer or
 * clearinghouse research. Findings distinguish insurer status from any
 * eligibility or payment guarantee (spec section 4); communicating findings is
 * a later disclosure and is rechecked.
 */
import type { VersionedWorkflowDefinition } from "../types.js";
import { deepFreeze, humanTaskFor, terminalState, waitState } from "./builders.js";

export const claimInvestigationV1: VersionedWorkflowDefinition = deepFreeze({
  type: "claim_investigation",
  version: "1.0.0",
  description: "Durable claim research with a specialist review of findings before any later disclosure.",
  initial: "ACCEPTED",
  states: {
    ACCEPTED: waitState({
      owner: "q_claims_intake",
      deadline: "PT30M",
      retryBudget: 3,
      escalationOwner: "q_claims_supervisors",
      transitions: { VALIDATE: "VALIDATING", CANCEL: "CANCELLED", ESCALATED: "WAITING_FOR_HUMAN" },
    }),
    VALIDATING: waitState({
      owner: "q_claims_intake",
      deadline: "PT2H",
      retryBudget: 3,
      escalationOwner: "q_claims_supervisors",
      transitions: {
        VALIDATION_PASSED: "WAITING_FOR_SYSTEM",
        VALIDATION_FAILED: "WAITING_FOR_HUMAN",
        CANCEL: "CANCELLED",
        ESCALATED: "WAITING_FOR_HUMAN",
      },
    }),
    WAITING_FOR_SYSTEM: waitState({
      owner: "q_claims_system_sync",
      deadline: "P1D",
      retryBudget: 5,
      escalationOwner: "q_claims_supervisors",
      transitions: {
        SYSTEM_CONFIRMED: "WAITING_FOR_HUMAN",
        PERMANENT_FAILURE: "FAILED",
        CANCEL: "CANCELLED",
        ESCALATED: "WAITING_FOR_HUMAN",
      },
    }),
    WAITING_FOR_HUMAN: waitState({
      owner: "q_claims_specialists",
      deadline: "P3D",
      retryBudget: 0,
      escalationOwner: "q_claims_supervisors",
      humanTask: humanTaskFor("claims_specialist", "claim_findings_review"),
      transitions: {
        HUMAN_APPROVED: "COMPLETED",
        HUMAN_REJECTED: "WAITING_FOR_SYSTEM",
        NEEDS_CALLER_INFO: "WAITING_FOR_CALLER",
        POLICY_CHANGED_PENDING_ACTION: "WAITING_FOR_HUMAN",
        CANCEL: "CANCELLED",
        ESCALATED: "WAITING_FOR_HUMAN",
      },
    }),
    WAITING_FOR_CALLER: waitState({
      owner: "q_claims_specialists",
      deadline: "P14D",
      retryBudget: 2,
      escalationOwner: "q_claims_supervisors",
      transitions: { CALLER_RESPONDED: "VALIDATING", CANCEL: "CANCELLED", ESCALATED: "WAITING_FOR_HUMAN" },
    }),
    COMPLETED: terminalState("q_claims_specialists"),
    FAILED: terminalState("q_claims_supervisors"),
    CANCELLED: terminalState("q_claims_specialists"),
  },
  transitionGuards: {
    WAITING_FOR_HUMAN: { HUMAN_APPROVED: "disclosure" },
  },
  humanTaskRoles: { WAITING_FOR_HUMAN: "claims_specialist" },
});
