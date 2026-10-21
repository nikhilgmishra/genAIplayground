/**
 * Dependencies of the console API, constructed by the composition root
 * (platform/src/main, gateway engineer). Explicit and minimal: each entry is a
 * port or the narrow slice of a concrete class the console actually calls.
 */
import type { AuditHealth, AuditWriter } from "../audit/ports.js";
import type { ProviderCommitPort } from "../actions/ports.js";
import type { LedgerActionService } from "../actions/action-service.js";
import type { HandoffService, SupportRequestService } from "../business/contract.js";
import type { DestinationConfig } from "../config/ports.js";
import type { Db } from "../db/types.js";
import type { KnowledgeServicePg } from "../knowledge/service.js";
import type { Logger } from "../observability/ports.js";
import type { BudgetService, KillSwitchService } from "../ops/ports.js";
import type { SessionCapacity } from "../ops/capacity.js";
import type { PgOutboxDispatcher } from "../outbox/dispatcher.js";
import type { ActionKind, CommitReceipt, Environment, StaffActor } from "../protocol/index.js";
import type { Clock } from "../shared/clock.js";
import type { PgWorkflowEngine } from "../workflows/engine.js";
import type { TransferStore } from "../workflows/transfer.js";
import type { LocalWorkforceSignIn, StaffDirectory, WorkforceTokenVerifier } from "./auth.js";
import type { ConsolePolicyEngine } from "./authorize.js";
import type { BreakGlassGrantSource } from "./break-glass.js";
import type { PgBreakGlassIssuance } from "./break-glass-issuance.js";
import type { DependencyHealth, OidcClientConfig } from "./contract.js";
import type { PgRecoveryService } from "./recovery.js";
import type { ConsoleSsoDeps } from "./routes/auth/workforce-auth.js";

/**
 * Staff-initiated retry of an action whose latest console reconciliation returned
 * NOT_FOUND (ACT-03). Implemented over the action ledger by LedgerReconciledRetry
 * (reconciled-retry.ts: LedgerActionService.retryAfterReconcile with the ledger's
 * latest reconciliation record id). Absent => the retry endpoint enforces every
 * gate and then refuses with RETRY_PATH_UNAVAILABLE.
 */
export interface ReconciledRetryPort {
  retryAfterReconcile(input: { tenantId: string; actionId: string; reconciliationId: string; reasonCode: string; staff: StaffActor; correlationId: string }): Promise<CommitReceipt>;
}

/**
 * Who currently owns (handles) a call, for the support_agent "own calls only"
 * cancel rule. No live source exists (Talkdesk agent assignment events, TB-07);
 * absent => only supervisors can cancel (fail closed).
 */
export interface CallOwnershipSource {
  readonly kind: "local_fixture" | "live";
  ownerOf(tenantId: string, callId: string): Promise<string | null>;
}

export interface ConsoleApiDeps {
  environment: Environment;
  clock: Clock;
  logger: Logger;
  /** Console-owned tables (migration 0900) and read models; queried as app_console. */
  db: Db;
  /** Writer for console audit events (sourceComponent "console"), appended in app_console transactions. */
  audit: AuditWriter;
  auditHealth: AuditHealth;
  /** OpaWasmPolicyEngine (or FailClosedPolicyEngine): `decideConsole`, deny by default. */
  policy: ConsolePolicyEngine & { readonly bundleDigest: string };
  auth: {
    verifier: WorkforceTokenVerifier;
    staffDirectory: StaffDirectory;
    breakGlass: BreakGlassGrantSource;
    /** LOCAL FIXTURE sign-in; registered only when environment is local/ci (refused otherwise). */
    localSignIn: LocalWorkforceSignIn | null;
    /** Workforce OIDC client view when no live SSO is wired (local fixture mode: BLOCKED). */
    oidc: OidcClientConfig | null;
    /**
     * Live workforce SSO (WP-05): backend authorization-code + PKCE exchange, opaque server-side console
     * sessions with idle and absolute expiry, same-actor refresh, live group-to-role directory and
     * offboarding checks. Required outside local/ci (assertConsoleDeps); absent in local fixture mode.
     */
    sso?: ConsoleSsoDeps | null;
    /** Dual-controlled SSO-outage recovery identities (requires `sso`: recovery sessions are console sessions). */
    recovery?: PgRecoveryService | null;
    /** Break-glass issuance and post-use access reviews; default: PgBreakGlassIssuance over `db` (4 h maximum). */
    breakGlassIssuance?: PgBreakGlassIssuance | null;
  };
  killSwitches: KillSwitchService;
  /** Known kill-switch targets from trusted configuration (no free-typed targets). */
  killSwitchTargets: { INTENT: string[]; INTEGRATION: string[]; MODEL_VERSION: string[]; VOICE_VERSION: string[] };
  budgets: BudgetService;
  /** True for local fixture budget figures (illustrative, not approved budgets). */
  budgetFiguresIllustrative: boolean;
  capacity: SessionCapacity | null;
  actions: Pick<LedgerActionService, "describe" | "cancelPending" | "reconcile" | "listNeedingReconciliation">;
  /** System-of-record commit/lookup ports per action kind (BusinessModule.providers). */
  providers: Partial<Record<ActionKind, ProviderCommitPort>>;
  reconciledRetry: ReconciledRetryPort | null;
  outbox: Pick<PgOutboxDispatcher, "listDead" | "requeueDead">;
  workflows: Pick<PgWorkflowEngine, "openTasks" | "issueTaskToken" | "completeHumanTask" | "get">;
  transfers: Pick<TransferStore, "get" | "listActive" | "kind">;
  knowledge: Pick<KnowledgeServicePg, "snapshot" | "reviewQueue">;
  handoff: HandoffService;
  supportRequests: SupportRequestService;
  destinations: readonly DestinationConfig[];
  /** Whether supported Talkdesk transfer controls are available (TB-07 UNKNOWN for live). */
  telephonyTransferAvailable: boolean;
  callOwnership: CallOwnershipSource | null;
  /** Dependency health for the overview (content-free). */
  dependencyHealth: () => Promise<DependencyHealth[]>;
  /** True when any adapter/store is a local fixture (LOCAL FIXTURE badge). */
  localFixture: boolean;
}
