/**
 * Integration contract between the business layer (resolution contracts,
 * business services, tool modules) and the gateway / console-api / worker
 * composition. The business layer depends only on the ports in ToolDeps; the
 * composition root (platform/src/main/container.ts) supplies implementations.
 */
import type { Db, Queryable } from "../db/types.js";
import type { AuditHealth, AuditWriter, AuditQuery, DeferredAuditSink } from "../audit/ports.js";
import type { ActionService, ProviderCommitPort } from "../actions/ports.js";
import type { Outbox } from "../outbox/ports.js";
import type { PolicyEngine } from "../policy/ports.js";
import type { SessionService, VerificationService, AssertionService } from "../identity/ports.js";
import type { WorkflowEngine } from "../workflows/ports.js";
import type { DurableGrantStore } from "../workflows/grants.js";
import type { TransferCoordinator, TransferJourney } from "../workflows/transfer.js";
import type { KnowledgeService } from "../knowledge/ports.js";
import type { SupportMemory } from "../memory/ports.js";
import type { KillSwitchService, AdmissionController } from "../ops/ports.js";
import type { SafetyRouter, SafetySignal, SafetySignalDetector } from "../safety/ports.js";
import type { ResponseGate, TemplateRegistry } from "../voice/ports.js";
import type { DestinationConfig } from "../config/ports.js";
import type { Logger, Metrics } from "../observability/ports.js";
import type { Clock } from "../shared/clock.js";
import type {
  BillingSystem,
  ClaimsSystem,
  IdentityDirectory,
  NotificationSender,
  ProviderSystem,
  RelationshipDirectory,
  SchedulingSystem,
  SupportRecordSystem,
  TelephonyControl,
} from "../adapters/ports.js";
import type {
  ActionKind,
  AuthContext,
  Environment,
  IssueCategory,
  Outcome,
  PreparedAction,
  ResolutionContract,
  SupportRequest,
  TransferReason,
  VersionSet,
} from "../protocol/index.js";
import type { ToolModule } from "../gateway/ports.js";

export interface ToolDeps {
  tenantId: string;
  environment: Environment;
  clock: Clock;
  logger: Logger;
  metrics: Metrics;
  db: Db;
  audit: AuditWriter;
  auditHealth: AuditHealth;
  auditQuery: AuditQuery;
  policy: PolicyEngine;
  sessions: SessionService;
  verification: VerificationService;
  assertions: AssertionService;
  actions: ActionService;
  outbox: Outbox;
  workflows: WorkflowEngine;
  transfers: TransferCoordinator;
  knowledge: KnowledgeService;
  memory: SupportMemory;
  killSwitches: KillSwitchService;
  admission: AdmissionController;
  adapters: {
    identityDirectory: IdentityDirectory;
    relationships: RelationshipDirectory;
    scheduling: SchedulingSystem;
    billing: BillingSystem;
    claims: ClaimsSystem;
    provider: ProviderSystem;
    supportRecords: SupportRecordSystem;
    telephony: TelephonyControl;
    notifications: NotificationSender;
  };
  /** Trusted destination allowlist (SAFE-05). */
  destinations: DestinationConfig[];
  safety: { detector: SafetySignalDetector; router: SafetyRouter };
  templates: TemplateRegistry;
  responseGate: ResponseGate;
  /** Pinned versions recorded on support requests, audit events and evaluation results (OPS-06). */
  versions: VersionSet;
  /** True when any adapter/store is a local fixture; surfaced as the LOCAL FIXTURE badge. */
  localFixture: boolean;
  /**
   * Added (additive, optional): durable action grants (spec section 7). When present, the
   * business layer issues a narrowly scoped grant inside the transaction that accepts durable
   * work (billing review, partner onboarding, complaint review) and passes its grantRef to
   * WorkflowEngine.start. Absent => grantRef null, so every guarded workflow transition is
   * refused DURABLE_GRANT_MISSING (fail closed).
   */
  grants?: DurableGrantStore;
  /**
   * Added (additive, optional): notified with every handoff the HandoffService returns
   * (telephony-control, MCP/HTTP tools with or without a session, console), so the gateway's
   * per-call handoff index (TC-12, TC-11 outcome evidence) sees every route. Must not throw;
   * failures are ignored and never affect the route.
   */
  handoffObserver?: (callId: string, result: Pick<HandoffResult, "handoffId" | "transferId" | "destinationId" | "supportReference">, priority: "SAFETY" | "STANDARD") => void;
  /**
   * Added (additive, optional): bounded deferral for ROUTE evidence only (audit/deferred.ts). The
   * HandoffService writes its handoff audit events through it, so a human or safety route that
   * proceeds during an audit outage still gets its audit event appended, in order, once the store
   * recovers. Never for consequential mutations (they stay blocked by AuditHealth, OPS-01).
   * Absent => the handoff audit failure is only logged (previous behaviour).
   */
  deferredAudit?: DeferredAuditSink;
}

export interface HandoffResult {
  handoffId: string;
  transferId: string | null;
  destinationId: string;
  journey: TransferJourney | null;
  /** Approved template id for what the caller hears next. */
  speechTemplateId: string;
  /**
   * Added by the business layer (additive, optional): internal support reference created
   * for the handoff, when one could be created without delaying the route.
   */
  supportReference?: string | null;
}

export interface HandoffService {
  /** Human request: never requires authentication; ctx is null when the session is unknown/invalid (SAFE-02). */
  requestHuman(input: {
    tenantId: string;
    callId: string;
    ctx: AuthContext | null;
    reason: TransferReason;
    language: string;
    issueCategory: IssueCategory | null;
    accommodations?: ("interpreter" | "relay_service" | "slower_speech" | "repeat_on_request" | "tty")[];
    /**
     * Added (additive, optional): a staff-selected destination for a console-initiated
     * transfer. It must be an entry of the trusted DestinationConfig allowlist (SAFE-05),
     * otherwise the request is refused with AccessDeniedError DESTINATION_NOT_ALLOWLISTED
     * and nothing is dialled. Never set from caller, model or tool input.
     */
    destinationId?: string | null;
    /** Added (additive, optional): the staff member who initiated the transfer from the console (audited as the actor). */
    initiatedBy?: { staffId: string } | null;
  }): Promise<HandoffResult>;
  /**
   * Safety route: stops administrative work, invalidates pending mutations,
   * flags the session, and starts a priority transfer that timeouts and budgets
   * never abandon (SAFE-02/03/04). Records time from validated signal to route initiation.
   */
  requestSafetyRoute(input: {
    tenantId: string;
    callId: string;
    ctx: AuthContext | null;
    signals: SafetySignal[];
    locale: string;
    validatedAt: Date;
  }): Promise<HandoffResult>;
}

export interface SupportRequestTrace {
  supportRequest: SupportRequest;
  salesforce: {
    caseId: string | null;
    syncState: SupportRequest["syncState"];
    lastAttemptAt: string | null;
    attempts: number;
    /** Added (additive): reason code of the last synchronization attempt (null when none failed). */
    lastReasonCode: string | null;
    /** Added (additive): when Salesforce confirmed the upsert (null until then; never invented). */
    syncedAt: string | null;
  };
  actionIds: string[];
  workflowIds: string[];
  auditEventIds: string[];
  /** Added (additive): ids of this request's "support_request.sync" outbox messages, oldest first. */
  outboxMessageIds: string[];
}

/**
 * Added (additive): which database view a trace reads. Default (absent) is the worker
 * view (app_worker; includes restricted rows) used by operator tooling. The console view
 * reads the request as app_console under row-level security: restricted (privacy /
 * safety) rows are visible only when `restrictedReader` is true, which the console API
 * sets ONLY for staff whose restricted_record:view decision allowed (break-glass).
 */
export interface SupportRequestTraceOptions {
  reader?: { kind: "console"; restrictedReader: boolean };
}

export interface SupportRequestService {
  /**
   * Persists the internal (encrypted-at-rest in deployment) support request and
   * its outbox sync message in one transaction, then returns the internal
   * support reference. Never invents a Salesforce Case number.
   */
  create(
    ctx: AuthContext | null,
    input: {
      tenantId: string;
      callId: string;
      issueCategory: IssueCategory;
      disposition: Outcome;
      summaryTemplateId: string;
      summarySlots: Record<string, string>;
      attempted: string[];
      commitReceiptIds: string[];
      nextStep: string | null;
      restricted: boolean;
      priority: SupportRequest["priority"];
      ownerQueue: string;
      language: string;
    },
    tx?: Queryable,
  ): Promise<SupportRequest>;
  /** Consumer for "support_request.sync" outbox messages: idempotent Salesforce upsert by external id. */
  handleSyncMessage(messageId: string, payload: Record<string, unknown>): Promise<{ duplicate: boolean; syncState: SupportRequest["syncState"] }>;
  get(tenantId: string, supportRequestId: string): Promise<SupportRequest | null>;
  getByReference(tenantId: string, referenceNumber: string): Promise<SupportRequest | null>;
  trace(tenantId: string, referenceNumber: string, options?: SupportRequestTraceOptions): Promise<SupportRequestTrace | null>;
  /** Reconciliation dashboard / operator repair data. */
  listUnsynced(tenantId: string, limit: number): Promise<SupportRequest[]>;
  /**
   * Added (additive): support requests created for (or later linked to) one call, oldest
   * first, worker view (includes restricted rows; callers gate disclosure). Bounded.
   */
  listForCall(tenantId: string, callId: string): Promise<SupportRequest[]>;
  /**
   * Added (additive, optional): worker sweep that re-enqueues due RETRY_SCHEDULED requests and
   * stale SYNCING claims (PgSupportRequestService.retryDue). Returns the number re-enqueued.
   */
  retryDue?(tenantId: string, limit?: number): Promise<number>;
  /** Added (additive, optional): audited operator repair of a DEAD_LETTER request (back to PENDING with a fresh sync message). */
  repairDeadLetter?(tenantId: string, supportRequestId: string, operator: { actorRef: string; reasonCode: string }): Promise<SupportRequest>;
}

/** Interaction outcomes with evidence rules (RESOLVED needs the contract's success evidence; ACT-04). */
export interface InteractionOutcomeService {
  record(input: {
    tenantId: string;
    callId: string;
    contractId: string | null;
    evidence: {
      commitReceiptIds: string[];
      informationProvided: boolean;
      requestAccepted: boolean;
      transferConnected: boolean;
      callerDisconnected: boolean;
      policyDeclined: boolean;
      failed: boolean;
    };
  }): Promise<{ outcome: Outcome; reasonCode: string }>;
  /**
   * Added (additive, optional): append-only revision of a call's recorded outcome after the
   * reconciler records one of its actions COMMITTED (never an overwrite; see business/outcomes.ts).
   */
  reviseAfterCommit?(tenantId: string, actionId: string): Promise<{ revised: boolean; outcome: Outcome | null; reasonCode: string }>;
}

export interface BusinessModule {
  tools: ToolModule[];
  /** System-of-record commit ports per action kind, used by commit tools and the worker's reconciler. */
  providers: Partial<Record<ActionKind, ProviderCommitPort>>;
  contracts: ResolutionContract[];
  handoff: HandoffService;
  supportRequests: SupportRequestService;
  outcomes: InteractionOutcomeService;
  /** Outbox topic consumers the worker runs (each must be idempotent). */
  consumers: Partial<Record<"support_request.sync" | "action.committed" | "workflow.start" | "workflow.signal" | "notification.send", (messageId: string, payload: Record<string, unknown>) => Promise<void>>>;
  /**
   * Added (additive, optional): typed slot values for the confirmation template of a PREPARED
   * action (TC-07), from the authoritative action and system of record only. null => the
   * gateway routes to a human instead of speaking an incomplete commitment.
   */
  confirmationSlots?: (action: PreparedAction) => Promise<Record<string, string | number | boolean> | null>;
}

export type BuildBusiness = (deps: ToolDeps) => BusinessModule;

/**
 * Audit action names shared by the gateway (writer) and console-api (reader,
 * e.g. the active-call index and journey timeline). Audit events never carry
 * the bearer session reference: `sessionRef` holds the non-bearer binding ref
 * from identity/keys.ts sessionBindingRefFor(). Modules may emit additional
 * names; these are the ones other modules rely on.
 */
export const SESSION_AUDIT_ACTIONS = {
  started: "session.started",
  ended: "session.ended",
  roleSelected: "session.role_selected",
  consentRecorded: "session.consent_recorded",
  changed: "session.changed",
  revoked: "session.revoked",
  authGateRead: "session.auth_gate_read",
  verificationBegun: "verification.begun",
  verificationBound: "verification.bound",
  verificationFailed: "verification.failed",
  toolInvoke: "tool.invoke",
  safetySignal: "safety.signal",
  safetyRouteInitiated: "safety.route_initiated",
  confirmationCaptured: "action.confirmation_captured",
  bargeIn: "turn.barge_in",
} as const;
