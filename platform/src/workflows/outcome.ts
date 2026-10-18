/**
 * Outcome mapping for durable workflows (ACT-04). Workflow acceptance and every
 * waiting state mean REQUEST_ACCEPTED: pending work, never issue resolution.
 * RESOLVED requires a COMPLETED workflow AND authoritative commit receipts.
 */
import type { Outcome, WorkflowStateName } from "../protocol/index.js";

export interface ResolutionEvidence {
  /** Authoritative commit receipt ids (action ledger). An empty list is not evidence. */
  commitReceiptIds: readonly string[];
}

export function workflowOutcome(state: WorkflowStateName, evidence: ResolutionEvidence = { commitReceiptIds: [] }): Outcome {
  switch (state) {
    case "ACCEPTED":
    case "VALIDATING":
    case "WAITING_FOR_SYSTEM":
    case "WAITING_FOR_HUMAN":
    case "WAITING_FOR_CALLER":
    case "READY_TO_COMMIT":
      return "REQUEST_ACCEPTED";
    case "COMPLETED":
      return evidence.commitReceiptIds.some((r) => typeof r === "string" && r.length > 0) ? "RESOLVED" : "OUTCOME_UNKNOWN";
    case "FAILED":
      return "FAILED";
    case "CANCELLED":
      // The request did not complete; a cancellation is never reported as resolution.
      return "FAILED";
  }
}
