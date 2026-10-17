/**
 * support_request_sync — asynchronous reconciliation of an internal support
 * request into Salesforce after an outage (spec section 8). Customer intent is
 * preserved: there is no CANCEL route; a permanent failure goes to an operator
 * repair task and only an operator can close it as FAILED.
 */
import type { VersionedWorkflowDefinition } from "../types.js";
import { deepFreeze, humanTaskFor, terminalState, waitState } from "./builders.js";

export const supportRequestSyncV1: VersionedWorkflowDefinition = deepFreeze({
  type: "support_request_sync",
  version: "1.0.0",
  description: "Reconcile an internal support reference into the support system of record with an operator repair path.",
  initial: "ACCEPTED",
  states: {
    ACCEPTED: waitState({
      owner: "q_crm_sync",
      deadline: "PT5M",
      retryBudget: 3,
      escalationOwner: "q_crm_repair_supervisors",
      transitions: { SYNC_STARTED: "WAITING_FOR_SYSTEM", ESCALATED: "WAITING_FOR_HUMAN" },
    }),
    WAITING_FOR_SYSTEM: waitState({
      owner: "q_crm_sync",
      deadline: "PT1H",
      retryBudget: 8,
      escalationOwner: "q_crm_repair_supervisors",
      transitions: { SYNCED: "COMPLETED", PERMANENT_FAILURE: "WAITING_FOR_HUMAN", ESCALATED: "WAITING_FOR_HUMAN" },
    }),
    WAITING_FOR_HUMAN: waitState({
      owner: "q_crm_repair",
      deadline: "P1D",
      retryBudget: 0,
      escalationOwner: "q_crm_repair_supervisors",
      humanTask: humanTaskFor("crm_repair_operator", "crm_sync_repair"),
      // APPROVE = repaired, retry synchronisation; REJECT = operator closes the sync as failed.
      transitions: { HUMAN_APPROVED: "WAITING_FOR_SYSTEM", HUMAN_REJECTED: "FAILED", ESCALATED: "WAITING_FOR_HUMAN" },
    }),
    COMPLETED: terminalState("q_crm_sync"),
    FAILED: terminalState("q_crm_repair_supervisors"),
  },
  transitionGuards: {},
  humanTaskRoles: { WAITING_FOR_HUMAN: "crm_repair_operator" },
});
