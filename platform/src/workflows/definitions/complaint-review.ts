/**
 * complaint_review — complaint intake followed by supervisor review. The
 * response to the complainant is a later disclosure and is rechecked.
 */
import type { VersionedWorkflowDefinition } from "../types.js";
import { ACTORS, COMMON_EVENT_ACTORS, deepFreeze, humanTaskFor, terminalState, waitState } from "./builders.js";

export const complaintReviewV1: VersionedWorkflowDefinition = deepFreeze({
  type: "complaint_review",
  version: "1.0.0",
  description: "Complaint triage and supervisor review with a recheck before the response is disclosed.",
  initial: "ACCEPTED",
  states: {
    ACCEPTED: waitState({
      owner: "q_complaints",
      deadline: "PT1H",
      retryBudget: 3,
      escalationOwner: "q_complaints_supervisors",
      transitions: { VALIDATE: "VALIDATING", CANCEL: "CANCELLED", ESCALATED: "WAITING_FOR_HUMAN" },
    }),
    VALIDATING: waitState({
      owner: "q_complaints",
      deadline: "PT4H",
      retryBudget: 3,
      escalationOwner: "q_complaints_supervisors",
      transitions: { TRIAGED: "WAITING_FOR_HUMAN", CANCEL: "CANCELLED", ESCALATED: "WAITING_FOR_HUMAN" },
    }),
    WAITING_FOR_HUMAN: waitState({
      owner: "q_complaints",
      deadline: "P5D",
      retryBudget: 0,
      escalationOwner: "q_complaints_supervisors",
      humanTask: humanTaskFor("complaints_reviewer", "complaint_resolution_review"),
      transitions: {
        HUMAN_APPROVED: "COMPLETED",
        HUMAN_REJECTED: "VALIDATING",
        NEEDS_CALLER_INFO: "WAITING_FOR_CALLER",
        POLICY_CHANGED_PENDING_ACTION: "WAITING_FOR_HUMAN",
        CANCEL: "CANCELLED",
        ESCALATED: "WAITING_FOR_HUMAN",
      },
    }),
    WAITING_FOR_CALLER: waitState({
      owner: "q_complaints",
      deadline: "P10D",
      retryBudget: 2,
      escalationOwner: "q_complaints_supervisors",
      transitions: { CALLER_RESPONDED: "WAITING_FOR_HUMAN", CANCEL: "CANCELLED", ESCALATED: "WAITING_FOR_HUMAN" },
    }),
    COMPLETED: terminalState("q_complaints"),
    CANCELLED: terminalState("q_complaints"),
  },
  transitionGuards: {
    WAITING_FOR_HUMAN: { HUMAN_APPROVED: "disclosure" },
  },
  humanTaskRoles: { WAITING_FOR_HUMAN: "complaints_reviewer" },
  eventActors: {
    ...COMMON_EVENT_ACTORS,
    VALIDATE: ACTORS.SYSTEM,
    TRIAGED: ACTORS.SYSTEM_OR_STAFF,
    NEEDS_CALLER_INFO: ACTORS.SYSTEM_OR_STAFF,
    CALLER_RESPONDED: ACTORS.CALLER_RESPONSE,
  },
  grantActions: {
    WAITING_FOR_HUMAN: { HUMAN_APPROVED: "complaint.response.disclose" },
  },
});
