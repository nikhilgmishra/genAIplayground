/**
 * Maps the action ledger's commit protocol onto business outcomes (spec section 8).
 * Success is reported only from a COMMITTED receipt; an UNKNOWN outcome is never
 * retried or announced before reconciliation (ACT-03).
 */
import type { ActionService, CommitDeps } from "../actions/ports.js";
import type { AuthContext, CommitReceipt } from "../protocol/index.js";
import { AccessDeniedError, AuditUnavailableError, ConflictError, DependencyError, SessionInvalidError, ValidationError } from "../shared/errors.js";
import { reasonOf } from "./shared.js";

export type CommitResult =
  | { kind: "COMMITTED"; receipt: CommitReceipt }
  | { kind: "FAILED"; receipt: CommitReceipt; reasonCode: string }
  | { kind: "UNKNOWN"; reasonCode: string; reconciliationRef: string }
  | { kind: "STATE_CHANGED" }
  | { kind: "RETRYABLE"; reasonCode: string; retryAfterMs: number }
  | { kind: "REJECTED"; reasonCode: string }
  | { kind: "DENIED"; reasonCode: string };

interface Describable {
  describe(tenantId: string, actionId: string): Promise<{ stateReason: string | null } | null>;
}

const isDescribable = (s: ActionService): s is ActionService & Describable => typeof (s as Partial<Describable>).describe === "function";

/** Stated reason of a terminal FAILED action (LedgerActionService.describe), or a generic code. */
async function failureReason(actions: ActionService, tenantId: string, actionId: string): Promise<string> {
  if (!isDescribable(actions)) return "PROVIDER_REJECTED";
  try {
    const v = await actions.describe(tenantId, actionId);
    return v?.stateReason && /^[A-Z][A-Z0-9_]{2,63}$/.test(v.stateReason) ? v.stateReason : "PROVIDER_REJECTED";
  } catch {
    return "PROVIDER_REJECTED";
  }
}

export async function commitAction(actions: ActionService, auth: AuthContext, input: { actionId: string; digest: string }, deps: CommitDeps): Promise<CommitResult> {
  try {
    const receipt = await actions.commit(auth, input, deps);
    if (receipt.outcome === "COMMITTED") return { kind: "COMMITTED", receipt };
    if (receipt.outcome === "UNKNOWN") return { kind: "UNKNOWN", reasonCode: "COMMIT_OUTCOME_UNKNOWN", reconciliationRef: input.actionId };
    if (receipt.outcome === "FAILED") return { kind: "FAILED", receipt, reasonCode: await failureReason(actions, auth.tenantId, input.actionId) };
    return { kind: "RETRYABLE", reasonCode: "PROVIDER_NOT_STARTED", retryAfterMs: 1000 };
  } catch (err) {
    if (err instanceof ConflictError) {
      if (err.reasonCode === "STATE_CHANGED") return { kind: "STATE_CHANGED" };
      if (err.retryable) return { kind: "RETRYABLE", reasonCode: reasonOf(err), retryAfterMs: 1000 };
      return { kind: "REJECTED", reasonCode: reasonOf(err) };
    }
    if (err instanceof DependencyError) {
      if (err.outcome === "NOT_STARTED") return { kind: "RETRYABLE", reasonCode: reasonOf(err, "PROVIDER_NOT_STARTED"), retryAfterMs: 1000 };
      if (err.outcome === "UNKNOWN") return { kind: "UNKNOWN", reasonCode: reasonOf(err, "COMMIT_OUTCOME_UNKNOWN"), reconciliationRef: input.actionId };
      return { kind: "REJECTED", reasonCode: reasonOf(err, "PROVIDER_REJECTED") };
    }
    if (err instanceof AuditUnavailableError) return { kind: "RETRYABLE", reasonCode: reasonOf(err, "AUDIT_UNAVAILABLE"), retryAfterMs: 5000 };
    if (err instanceof AccessDeniedError || err instanceof SessionInvalidError) return { kind: "DENIED", reasonCode: reasonOf(err, "POLICY_DENIED") };
    if (err instanceof ValidationError) return { kind: "REJECTED", reasonCode: reasonOf(err, "COMMIT_INPUT_INVALID") };
    throw err;
  }
}
