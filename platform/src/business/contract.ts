/**
 * Integration contract between the business layer (resolution contracts,
 * business services, tool modules) and the gateway / console-api / worker
 * composition. The business layer depends only on the ports in ToolDeps; the
 * composition root (platform/src/main/container.ts) supplies implementations.
 */
import type { Db, Queryable } from "../db/types.js";
import type { AuditHealth, AuditWriter, AuditQuery } from "../audit/ports.js";
import type { ActionService, ProviderCommitPort } from "../actions/ports.js";
import type { Outbox } from "../outbox/ports.js";
import type { PolicyEngine } from "../policy/ports.js";
import type { SessionService, VerificationService, AssertionService } from "../identity/ports.js";
import type { WorkflowEngine } from "../workflows/ports.js";
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
  salesforce: { caseId: string | null; syncState: SupportRequest["syncState"]; lastAttemptAt: string | null; attempts: number };
  actionIds: string[];
  workflowIds: string[];
  auditEventIds: string[];
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
  trace(tenantId: string, referenceNumber: string): Promise<SupportRequestTrace | null>;
  /** Reconciliation dashboard / operator repair data. */
  listUnsynced(tenantId: string, limit: number): Promise<SupportRequest[]>;
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
