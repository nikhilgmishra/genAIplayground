/**
 * ReconciledRetryPort over the action ledger (ACT-03): the console's
 * reconciliation.retry endpoint has already authenticated the staff member
 * (workforce SSO + MFA), authorized the action (console policy), checked its
 * own latest NOT_FOUND console reconciliation and consumed it with an audit
 * event. This port then hands the retry to LedgerActionService.retryAfterReconcile
 * with the LEDGER's latest reconciliation record id (a console_reconciliations
 * id would be refused as RECONCILIATION_NOT_LATEST). The ledger re-checks
 * everything that matters for the effect: the latest ledger reconciliation is
 * NOT_FOUND and unconsumed, the row is still CONFIRMED at the recorded row
 * version, the preparation is unexpired and the confirmation is recorded; the
 * provider is called with the SAME idempotency key as every earlier attempt.
 * Any refusal is the ledger's typed error (fails closed, nothing sent).
 */
import type { ActionService, ProviderCommitPort } from "../actions/ports.js";
import type { ActionKind, CommitReceipt } from "../protocol/index.js";
import { ConflictError, DependencyError } from "../shared/errors.js";
import type { ReconciledRetryPort } from "./deps.js";

type LedgerRetry = Required<Pick<ActionService, "retryAfterReconcile" | "latestReconciliation">> & Pick<ActionService, "get">;

export class LedgerReconciledRetry implements ReconciledRetryPort {
  constructor(
    private readonly actions: LedgerRetry,
    private readonly providers: Partial<Record<ActionKind, ProviderCommitPort>>,
  ) {}

  async retryAfterReconcile(input: Parameters<ReconciledRetryPort["retryAfterReconcile"]>[0]): Promise<CommitReceipt> {
    const action = await this.actions.get(input.tenantId, input.actionId);
    if (!action) throw new ConflictError("RETRY_NOT_ELIGIBLE");
    const provider = this.providers[action.kind];
    if (!provider) throw new DependencyError("PROVIDER_PORT_UNAVAILABLE", "NOT_STARTED");
    const latest = await this.actions.latestReconciliation(input.tenantId, input.actionId);
    // The ledger's own record must be a NOT_FOUND reconciliation; anything else is refused before the provider.
    if (!latest || latest.result !== "NOT_FOUND" || latest.retryConsumed) throw new ConflictError("RECONCILE_REQUIRED");
    return this.actions.retryAfterReconcile(input.tenantId, input.actionId, { reconciliationId: latest.reconciliationId, reasonCode: input.reasonCode, staffRef: input.staff.staffId }, provider);
  }
}
