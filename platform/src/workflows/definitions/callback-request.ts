/**
 * callback_request — a consented callback performed by a staffed agent through
 * supported Talkdesk controls. Contacting the caller is a later disclosure, so
 * consent and representation are rechecked before each outreach; a revoked
 * consent cancels the callback (POLICY_CHANGED_PENDING_ACTION -> CANCELLED).
 * Automated outbound calling is a separately enabled feature and is not part
 * of this definition.
 */
import type { VersionedWorkflowDefinition } from "../types.js";
import { deepFreeze, humanTaskFor, terminalState, waitState } from "./builders.js";

export const callbackRequestV1: VersionedWorkflowDefinition = deepFreeze({
  type: "callback_request",
  version: "1.0.0",
  description: "Consented human callback with a consent/representation recheck before every outreach.",
  initial: "ACCEPTED",
  states: {
    ACCEPTED: waitState({
      owner: "q_callbacks",
      deadline: "PT15M",
      retryBudget: 3,
      escalationOwner: "q_callback_supervisors",
      transitions: { VALIDATE: "VALIDATING", CANCEL: "CANCELLED", ESCALATED: "WAITING_FOR_HUMAN" },
    }),
    VALIDATING: waitState({
      owner: "q_callbacks",
      deadline: "PT30M",
      retryBudget: 3,
      escalationOwner: "q_callback_supervisors",
      transitions: {
        CONSENT_CONFIRMED: "WAITING_FOR_HUMAN",
        CONSENT_MISSING: "CANCELLED",
        POLICY_CHANGED_PENDING_ACTION: "CANCELLED",
        CANCEL: "CANCELLED",
        ESCALATED: "WAITING_FOR_HUMAN",
      },
    }),
    WAITING_FOR_HUMAN: waitState({
      owner: "q_callbacks",
      deadline: "P1D",
      retryBudget: 0,
      escalationOwner: "q_callback_supervisors",
      humanTask: humanTaskFor("callback_agent", "callback_outreach"),
      // APPROVE = callback completed with the caller; REJECT = caller not reached.
      transitions: { HUMAN_APPROVED: "COMPLETED", HUMAN_REJECTED: "WAITING_FOR_CALLER", CANCEL: "CANCELLED", ESCALATED: "WAITING_FOR_HUMAN" },
    }),
    WAITING_FOR_CALLER: waitState({
      owner: "q_callbacks",
      deadline: "P3D",
      retryBudget: 2,
      escalationOwner: "q_callback_supervisors",
      transitions: {
        CALLER_RESPONDED: "WAITING_FOR_HUMAN",
        POLICY_CHANGED_PENDING_ACTION: "CANCELLED",
        CANCEL: "CANCELLED",
        ESCALATED: "WAITING_FOR_HUMAN",
      },
    }),
    COMPLETED: terminalState("q_callbacks"),
    CANCELLED: terminalState("q_callbacks"),
  },
  transitionGuards: {
    VALIDATING: { CONSENT_CONFIRMED: "disclosure" },
    WAITING_FOR_CALLER: { CALLER_RESPONDED: "disclosure" },
  },
  humanTaskRoles: { WAITING_FOR_HUMAN: "callback_agent" },
});
