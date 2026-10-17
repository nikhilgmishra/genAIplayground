import type { Queryable } from "../db/types.js";
import type {
  ActionConfirmation,
  ActionKind,
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

export interface ActionService {
  prepare(ctx: AuthContext, input: PrepareInput, decision: PolicyDecision): Promise<PreparedAction>;
  /** Trusted deterministic confirmation (telephony_control or portal identity only). */
  confirm(confirmation: ActionConfirmation, integration: IntegrationIdentity): Promise<PreparedAction>;
  /** Barge-in, changed request, identity change, safety escalation or expiry invalidate pending actions. */
  invalidatePending(sessionRef: string, reasonCode: string): Promise<number>;
  commit(ctx: AuthContext, input: { actionId: string; digest: string }, deps: CommitDeps): Promise<CommitReceipt>;
  /** Resolves UNKNOWN/COMMITTING actions via provider lookup; never blind-retries. */
  reconcile(actionId: string, provider: ProviderCommitPort): Promise<CommitReceipt>;
  get(tenantId: string, actionId: string): Promise<PreparedAction | null>;
  /** Actions needing reconciliation (UNKNOWN or stale COMMITTING), for workers and the console queue. */
  listNeedingReconciliation(tenantId: string, limit: number): Promise<PreparedAction[]>;
}
