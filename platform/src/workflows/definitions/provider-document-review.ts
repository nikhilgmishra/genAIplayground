/**
 * provider_document_review — completeness review of credentialing documents a
 * provider submitted. This is an administrative document review; it never
 * makes a credentialing decision (spec section 4: credentialing decisions stay
 * with the credentialing function).
 */
import type { VersionedWorkflowDefinition } from "../types.js";
import { deepFreeze, humanTaskFor, terminalState, waitState } from "./builders.js";

export const providerDocumentReviewV1: VersionedWorkflowDefinition = deepFreeze({
  type: "provider_document_review",
  version: "1.0.0",
  description: "Administrative completeness review of submitted provider documents; no credentialing decision is made here.",
  initial: "ACCEPTED",
  states: {
    ACCEPTED: waitState({
      owner: "q_provider_intake",
      deadline: "PT30M",
      retryBudget: 3,
      escalationOwner: "q_provider_supervisors",
      transitions: { VALIDATE: "VALIDATING", CANCEL: "CANCELLED", ESCALATED: "WAITING_FOR_HUMAN" },
    }),
    VALIDATING: waitState({
      owner: "q_provider_intake",
      deadline: "PT2H",
      retryBudget: 3,
      escalationOwner: "q_provider_supervisors",
      transitions: {
        DOCUMENTS_RECEIVED: "WAITING_FOR_HUMAN",
        DOCUMENTS_MISSING: "WAITING_FOR_CALLER",
        CANCEL: "CANCELLED",
        ESCALATED: "WAITING_FOR_HUMAN",
      },
    }),
    WAITING_FOR_CALLER: waitState({
      owner: "q_provider_relations",
      deadline: "P14D",
      retryBudget: 2,
      escalationOwner: "q_provider_supervisors",
      transitions: { DOCUMENTS_SUBMITTED: "VALIDATING", CANCEL: "CANCELLED", ESCALATED: "WAITING_FOR_HUMAN" },
    }),
    WAITING_FOR_HUMAN: waitState({
      owner: "q_provider_relations",
      deadline: "P3D",
      retryBudget: 0,
      escalationOwner: "q_provider_supervisors",
      humanTask: humanTaskFor("provider_relations_specialist", "provider_document_review"),
      transitions: {
        HUMAN_APPROVED: "WAITING_FOR_SYSTEM",
        HUMAN_REJECTED: "WAITING_FOR_CALLER",
        POLICY_CHANGED_PENDING_ACTION: "WAITING_FOR_HUMAN",
        CANCEL: "CANCELLED",
        ESCALATED: "WAITING_FOR_HUMAN",
      },
    }),
    WAITING_FOR_SYSTEM: waitState({
      owner: "q_provider_system_sync",
      deadline: "PT4H",
      retryBudget: 5,
      escalationOwner: "q_provider_supervisors",
      transitions: {
        SYSTEM_CONFIRMED: "COMPLETED",
        PERMANENT_FAILURE: "FAILED",
        ESCALATED: "WAITING_FOR_HUMAN",
      },
    }),
    COMPLETED: terminalState("q_provider_relations"),
    FAILED: terminalState("q_provider_supervisors"),
    CANCELLED: terminalState("q_provider_relations"),
  },
  transitionGuards: {
    // Recording the document review result in the provider system is a material change;
    // asking the provider for corrected documents discloses review findings.
    WAITING_FOR_HUMAN: { HUMAN_APPROVED: "material_change", HUMAN_REJECTED: "disclosure" },
  },
  humanTaskRoles: { WAITING_FOR_HUMAN: "provider_relations_specialist" },
});
