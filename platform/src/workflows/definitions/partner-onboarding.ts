/**
 * partner_onboarding — organization-scoped partner intake with verified
 * affiliation, contract and purpose (spec section 4). Activation is a material
 * change; a rejection notice is a later disclosure. Approval is restricted to
 * supervisors (partner_manager mapping).
 */
import type { VersionedWorkflowDefinition } from "../types.js";
import { ACTORS, COMMON_EVENT_ACTORS, deepFreeze, humanTaskFor, terminalState, waitState } from "./builders.js";

export const partnerOnboardingV1: VersionedWorkflowDefinition = deepFreeze({
  type: "partner_onboarding",
  version: "1.0.0",
  description: "Partner organization onboarding with contract verification and supervisor approval before activation.",
  initial: "ACCEPTED",
  states: {
    ACCEPTED: waitState({
      owner: "q_partner_intake",
      deadline: "PT1H",
      retryBudget: 3,
      escalationOwner: "q_partner_supervisors",
      transitions: { VALIDATE: "VALIDATING", CANCEL: "CANCELLED", ESCALATED: "WAITING_FOR_HUMAN" },
    }),
    VALIDATING: waitState({
      owner: "q_partner_intake",
      deadline: "P1D",
      retryBudget: 3,
      escalationOwner: "q_partner_supervisors",
      transitions: {
        CONTRACT_VERIFIED: "WAITING_FOR_HUMAN",
        CONTRACT_NOT_FOUND: "WAITING_FOR_CALLER",
        CANCEL: "CANCELLED",
        ESCALATED: "WAITING_FOR_HUMAN",
      },
    }),
    WAITING_FOR_CALLER: waitState({
      owner: "q_partner_relations",
      deadline: "P14D",
      retryBudget: 2,
      escalationOwner: "q_partner_supervisors",
      transitions: { CALLER_RESPONDED: "VALIDATING", CANCEL: "CANCELLED", ESCALATED: "WAITING_FOR_HUMAN" },
    }),
    WAITING_FOR_HUMAN: waitState({
      owner: "q_partner_relations",
      deadline: "P5D",
      retryBudget: 0,
      escalationOwner: "q_partner_supervisors",
      humanTask: humanTaskFor("partner_manager", "partner_onboarding_approval"),
      transitions: {
        HUMAN_APPROVED: "READY_TO_COMMIT",
        HUMAN_REJECTED: "COMPLETED",
        POLICY_CHANGED_PENDING_ACTION: "WAITING_FOR_HUMAN",
        CANCEL: "CANCELLED",
        ESCALATED: "WAITING_FOR_HUMAN",
      },
    }),
    READY_TO_COMMIT: waitState({
      owner: "q_partner_system_sync",
      deadline: "PT4H",
      retryBudget: 3,
      escalationOwner: "q_partner_supervisors",
      transitions: {
        COMMIT: "WAITING_FOR_SYSTEM",
        POLICY_CHANGED_PENDING_ACTION: "WAITING_FOR_HUMAN",
        CANCEL: "CANCELLED",
        ESCALATED: "WAITING_FOR_HUMAN",
      },
    }),
    WAITING_FOR_SYSTEM: waitState({
      owner: "q_partner_system_sync",
      deadline: "P1D",
      retryBudget: 5,
      escalationOwner: "q_partner_supervisors",
      transitions: {
        SYSTEM_CONFIRMED: "COMPLETED",
        PERMANENT_FAILURE: "FAILED",
        ESCALATED: "WAITING_FOR_HUMAN",
      },
    }),
    COMPLETED: terminalState("q_partner_relations"),
    FAILED: terminalState("q_partner_supervisors"),
    CANCELLED: terminalState("q_partner_relations"),
  },
  transitionGuards: {
    WAITING_FOR_HUMAN: { HUMAN_REJECTED: "disclosure" },
    READY_TO_COMMIT: { COMMIT: "material_change" },
  },
  humanTaskRoles: { WAITING_FOR_HUMAN: "partner_manager" },
  eventActors: {
    ...COMMON_EVENT_ACTORS,
    VALIDATE: ACTORS.SYSTEM,
    CONTRACT_VERIFIED: ACTORS.SYSTEM_OR_STAFF,
    CONTRACT_NOT_FOUND: ACTORS.SYSTEM_OR_STAFF,
    CALLER_RESPONDED: ACTORS.CALLER_RESPONSE,
    COMMIT: ACTORS.SYSTEM,
    SYSTEM_CONFIRMED: ACTORS.SYSTEM_OR_EXTERNAL,
    PERMANENT_FAILURE: ACTORS.SYSTEM_OR_EXTERNAL,
  },
  grantActions: {
    WAITING_FOR_HUMAN: { HUMAN_REJECTED: "partner.onboarding.decision_notice" },
    READY_TO_COMMIT: { COMMIT: "partner.onboarding.activate" },
  },
});
