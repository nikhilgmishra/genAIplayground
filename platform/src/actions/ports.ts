import type { Queryable } from "../db/types.js";
import type {
  ActionConfirmation,
  ActionKind,
  ActionState,
  ActionTarget,
  AuthContext,
  CommitReceipt,
  IntegrationIdentity,
  MoneyAmount,
  PolicyDecision,
  PreparedAction,
} from "../protocol/index.js";

export type ProviderCommitResult =
  | { outcome: "COMMITTED"; providerReference: string; afterVersion: string | null; evidence: Record<string, unknown> }
  | { outcome: "FAILED"; reasonCode: string; permanent: boolean };

export type ProviderLookupResult =
  | { outcome: "COMMITTED"; providerReference: string; afterVersion: string | null; evidence: Record<string, unknown> }
  | { outcome: "NOT_FOUND" }
  | { outcome: "UNKNOWN" };

/**
 * System-of-record port used by the commit protocol. `commit` throws
 * DependencyError with outcome UNKNOWN on ambiguous timeouts; `lookup` resolves
 * by the provider idempotency key before any retry (ACT-03).
 */
export interface ProviderCommitPort {
  commit(action: PreparedAction, providerIdempotencyKey: string): Promise<ProviderCommitResult>;
  lookup(action: PreparedAction, providerIdempotencyKey: string): Promise<ProviderLookupResult>;
  /** Current authoritative version of the target, for the optimistic concurrency check. */
  currentVersion(action: PreparedAction): Promise<string>;
}

export interface PrepareInput {
  kind: ActionKind;
  target: ActionTarget;
  change: PreparedAction["change"];
  impact: { summaryTemplateId: string; fees: MoneyAmount | null; reversible: boolean };
  confirmationTemplateId: string;
  ttlSeconds: number;
  requiresStepUp: boolean;
}

export interface CommitDeps {
  /** Re-evaluates authorization at commit time with current session state. */
  reauthorize(action: PreparedAction): Promise<PolicyDecision>;
  provider: ProviderCommitPort;
  /** Extra work inside the same transaction as the COMMITTED transition (outbox events, support links). */
  onCommitted?(tx: Queryable, action: PreparedAction, receipt: CommitReceipt): Promise<void>;
}

/**
 * Console / worker / gateway view of a ledger entry: opaque references, codes, counts and times.
 * Never contains the session bearer, the confirmation evidence itself or provider evidence bodies.
 */
export interface LedgerEntryView {
  action: PreparedAction;
  /** Effective state (a pending action past its expiry reads EXPIRED before any sweep). */
  state: ActionState;
  stateReason: string | null;
  receipt: CommitReceipt | null;
  /** Receipt id of the authoritative COMMITTED receipt, or null. */
  receiptId: string | null;
  confirmedAt: string | null;
  confirmationMethod: ActionConfirmation["method"] | null;
  commitAttempts: number;
  committingSince: string | null;
  reconcileAttempts: number;
  lastReconciledAt: string | null;
  providerIdempotencyKey: string;
  rowVersion: number;
}

/** Result of a recorded reconciliation (spec section 8; ACT-03). */
export interface ReconcileWithResult {
  /** The authoritative COMMITTED receipt; null when the provider has no record (NOT_FOUND) or the lookup was inconclusive (UNKNOWN). */
  receipt: CommitReceipt | null;
  /** Durable reconciliation record (action_reconciliations) written in the same transaction as the ledger transition. */
  reconciliationId: string;
  result: "COMMITTED" | "NOT_FOUND" | "UNKNOWN";
}

/** Content-free view of a durable reconciliation record. */
export interface ReconciliationView {
  reconciliationId: string;
  actionId: string;
  seq: number;
  trigger: "RECONCILE" | "COMMIT_RETRY" | "RECONCILE_WITH_RESULT";
  lookupPerformed: boolean;
  result: ReconcileWithResult["result"];
  ledgerStateAfter: ActionState;
  ledgerRowVersion: number;
  receiptId: string | null;
  auditEventId: string | null;
  reconciledAt: string;
  retryConsumed: boolean;
  retryConsumedAt: string | null;
}

/** Staff-initiated retry after a NOT_FOUND reconciliation (see LedgerActionService.retryAfterReconcile). */
export interface RetryAfterReconcileInput {
  reconciliationId: string;
  reasonCode: string;
  /** Opaque workforce staff reference (stf_...), authenticated and authorized by the console. */
  staffRef: string;
}

export interface ActionService {
  prepare(ctx: AuthContext, input: PrepareInput, decision: PolicyDecision): Promise<PreparedAction>;
  /** Trusted deterministic confirmation (telephony_control or portal identity only). */
  confirm(confirmation: ActionConfirmation, integration: IntegrationIdentity): Promise<PreparedAction>;
  /**
   * Barge-in, changed request, identity change, safety escalation or expiry invalidate pending actions.
   * Optional `tenantId` scopes the operation to that tenant (no cross-tenant locator read).
   */
  invalidatePending(sessionRef: string, reasonCode: string, tenantId?: string): Promise<number>;
  commit(ctx: AuthContext, input: { actionId: string; digest: string }, deps: CommitDeps): Promise<CommitReceipt>;
  /**
   * Resolves UNKNOWN/COMMITTING actions via provider lookup; never blind-retries. Records a durable
   * reconciliation. Optional `tenantId` scopes the operation to that tenant (no cross-tenant locator read).
   */
  reconcile(actionId: string, provider: ProviderCommitPort, tenantId?: string): Promise<CommitReceipt>;
  get(tenantId: string, actionId: string): Promise<PreparedAction | null>;
  /** Actions needing reconciliation (UNKNOWN or stale COMMITTING), for workers and the console queue. */
  listNeedingReconciliation(tenantId: string, limit: number): Promise<PreparedAction[]>;
  /** Every action bound to a session (bearer or binding ref), any state, content-free (TC-07 / TC-11 / handoff). */
  listForSession?(tenantId: string, sessionRef: string): Promise<LedgerEntryView[]>;
  /** Tenant-scoped reconciliation that returns the durable reconciliation record id and its result. */
  reconcileWithResult?(tenantId: string, actionId: string, provider: ProviderCommitPort): Promise<ReconcileWithResult>;
  /**
   * Staff-initiated retry with the SAME provider idempotency key, only against the latest NOT_FOUND
   * reconciliation of an unexpired, still-confirmed action; never on COMMITTED or UNKNOWN.
   */
  retryAfterReconcile?(tenantId: string, actionId: string, input: RetryAfterReconcileInput, provider: ProviderCommitPort): Promise<CommitReceipt>;
  /** Latest durable reconciliation record of an action, or null. */
  latestReconciliation?(tenantId: string, actionId: string): Promise<ReconciliationView | null>;
  /** Content-free view of one action. */
  describe?(tenantId: string, actionId: string): Promise<LedgerEntryView | null>;
  /** Operator cancellation of uncommitted work (audited, fails closed without audit). */
  cancelPending?(tenantId: string, actionId: string, input: { reasonCode: string; actorRef: string }): Promise<PreparedAction>;
}
