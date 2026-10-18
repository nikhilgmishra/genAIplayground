/**
 * Strict zod schemas for every console API request and response (contract.ts).
 *
 * Every object is `z.strictObject` (unknown keys rejected), strings and arrays are
 * bounded and closed sets are enums. Responses are parsed with these schemas
 * BEFORE they are sent, so a field that is not in the contract (for example
 * transcript text or a task token) can never leave the server. The inferred
 * types are asserted equal to the contract interfaces in schemas.test.ts.
 */
import { z } from "zod";
import {
  AUDIT_ACTION_PATTERN,
  CONSOLE_API_VERSION,
  DESTINATION_ID_PATTERN,
  IDEMPOTENCY_KEY_PATTERN,
  KILL_SWITCH_SCOPES,
  MAX_AUDIT_SEARCH_LIMIT,
  OPAQUE_ID_PATTERN,
  OPERATOR_REASON_PATTERN,
  PATH_PARAM_PATTERNS,
  REASON_CODE_PATTERN,
  STAFF_ID_PATTERN,
  STAFF_ROLES,
  SUPPORT_REFERENCE_PATTERN,
  TRANSFER_REASONS,
} from "./contract.js";
import type { EndpointKey, PathParamName } from "./contract.js";

const FOUR_DIGIT_RUN = /\d{4,}/;

/* ------------------------------------------------------------------------ */
/* Primitives                                                                */
/* ------------------------------------------------------------------------ */

export const OpaqueIdS = z.string().max(80).regex(new RegExp(OPAQUE_ID_PATTERN));
export const IsoDateTimeS = z.iso.datetime({ offset: false });
export const ReasonCodeS = z.string().max(64).regex(new RegExp(REASON_CODE_PATTERN));
/** Reason code, optionally `:<opaque incident id>`; the code part never carries a 4+ digit run (no PHI). */
export const OperatorReasonS = z
  .string()
  .max(160)
  .regex(new RegExp(OPERATOR_REASON_PATTERN))
  .refine((v) => !FOUR_DIGIT_RUN.test(v.split(":")[0] ?? ""), { message: "reason code digit run" });
export const StaffIdS = z.string().max(68).regex(new RegExp(STAFF_ID_PATTERN));
export const SupportReferenceS = z.string().regex(new RegExp(SUPPORT_REFERENCE_PATTERN));
export const DestinationIdS = z.string().max(44).regex(new RegExp(DESTINATION_ID_PATTERN));
export const IdempotencyKeyS = z.string().regex(new RegExp(IDEMPOTENCY_KEY_PATTERN));
export const QueueIdS = z.string().regex(/^q_[a-z0-9_]{2,40}$/);
export const VersionLabelS = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/);
export const Sha256S = z.string().regex(/^[a-f0-9]{64}$/);
export const LanguageS = z.string().regex(/^([a-z]{2,3}(-[A-Z]{2})?|und)$/);
const Count = z.number().int().min(0).max(1_000_000_000);
const Usd = z.number().finite().min(0).max(1e12);
const SignedUsd = z.number().finite().min(-1e12).max(1e12);

export const StaffRoleS = z.enum(STAFF_ROLES);
export const EnvironmentS = z.enum(["local", "ci", "sandbox", "staging", "production"]);
export const AssuranceS = z.enum(["A0", "A1", "A2", "A3"]);
export const AdapterKindS = z.enum(["local_fixture", "live"]);
export const DataClassS = z.enum(["TRANSIENT_CONVERSATION", "BUSINESS_RECORD", "RESTRICTED_QA_MEDIA", "SECURITY_AUDIT"]);
export const OutcomeS = z.enum(["RESOLVED", "REQUEST_ACCEPTED", "TRANSFERRED", "INFORMATION_PROVIDED", "DECLINED_BY_POLICY", "CALLER_DISCONNECTED", "FAILED", "OUTCOME_UNKNOWN"]);
export const IssueCategoryS = z.enum([
  "general_question",
  "portal_login_help",
  "appointment",
  "billing_question",
  "billing_dispute",
  "claim_status",
  "provider_onboarding",
  "credentialing_documents",
  "remittance",
  "partner_intake",
  "complaint",
  "case_follow_up",
  "privacy_concern",
  "safety_concern",
  "clinical_question_redirected",
  "accessibility_request",
  "language_support",
  "other",
]);
export const SyncStateS = z.enum(["PENDING", "SYNCING", "SYNCED", "RETRY_SCHEDULED", "DEAD_LETTER"]);
export const TransferStateS = z.enum([
  "REQUESTED",
  "QUEUED",
  "RECEIVER_ACCEPTED",
  "BRIDGED",
  "CALLER_CONFIRMED_CONNECTED",
  "COMPLETED",
  "TIMED_OUT",
  "RECEIVER_UNAVAILABLE",
  "BRIDGE_DROPPED",
  "CALLER_DISCONNECTED",
  "FAILED",
]);
export const TransferReasonS = z.enum(TRANSFER_REASONS);
export const DestinationPurposeS = z.enum([
  "SAFETY_PRIORITY",
  "STANDARD_SUPPORT",
  "INTERPRETER",
  "CLINICAL_ROUTE",
  "PROVIDER_SUPPORT",
  "PARTNER_SUPPORT",
  "BILLING_SPECIALIST",
  "OUTAGE_CONTINUITY",
]);
export const ActionKindS = z.enum(["appointment.reschedule", "appointment.create", "appointment.cancel", "billing.review.submit", "support_request.create", "callback.schedule"]);
export const ActionStateS = z.enum(["PREPARED", "CONFIRMED", "COMMITTING", "COMMITTED", "FAILED", "UNKNOWN", "INVALIDATED", "EXPIRED", "CANCELLED"]);
export const CommitOutcomeS = z.enum(["NOT_STARTED", "COMMITTED", "FAILED", "UNKNOWN"]);
export const ActionTargetSystemS = z.enum(["scheduling", "billing", "claims", "provider", "support_records", "internal"]);
export const ToolStatusS = z.enum(["SUCCESS", "RETRYABLE_FAILURE", "PERMANENT_FAILURE", "POLICY_DENIED", "PENDING", "UNKNOWN_OUTCOME"]);
export const WorkflowTypeS = z.enum([
  "billing_dispute_review",
  "provider_document_review",
  "claim_investigation",
  "partner_onboarding",
  "support_request_sync",
  "callback_request",
  "complaint_review",
]);
export const WorkflowStateNameS = z.enum(["ACCEPTED", "VALIDATING", "WAITING_FOR_SYSTEM", "WAITING_FOR_HUMAN", "WAITING_FOR_CALLER", "READY_TO_COMMIT", "COMPLETED", "FAILED", "CANCELLED"]);
export const KillSwitchScopeS = z.enum(KILL_SWITCH_SCOPES);
export const AuditOutcomeS = z.enum(["ALLOWED", "DENIED", "SUCCEEDED", "FAILED", "PENDING", "UNKNOWN", "INVALIDATED", "RECONCILED"]);
export const AuditSourceComponentS = z.enum([
  "gateway",
  "mcp_adapter",
  "telephony_control",
  "identity",
  "policy",
  "actions",
  "workflow",
  "knowledge",
  "safety",
  "voice_gate",
  "console",
  "worker",
  "retention",
  "config",
]);
export const SafetySignalSourceS = z.enum(["EXPLICIT_PHRASE", "SEMANTIC_SIGNAL", "ASR_UNCERTAIN", "CALLER_REQUEST", "HUMAN_INTERVENTION"]);
export const SafetyRouteOutcomeS = z.enum(["IN_PROGRESS", "TRANSFERRED", "CALLER_DISCONNECTED", "FAILED", "OUTCOME_UNKNOWN"]);
export const OutboxTopicS = z.enum(["support_request.sync", "workflow.start", "workflow.signal", "notification.send", "audit.ship", "action.committed"]);
export const ApprovalScopeS = z.enum(["POLICY_RELEASE", "KNOWLEDGE_RELEASE"]);
export const HealthStatusS = z.enum(["HEALTHY", "DEGRADED", "DOWN", "UNKNOWN"]);
export const ReleaseKindS = z.enum(["POLICY_BUNDLE", "KNOWLEDGE_SNAPSHOT"]);
export const ReleaseReviewDecisionS = z.enum(["NO_OBJECTION", "CHANGES_REQUESTED"]);
export const SafetyRouteS = z.enum(["SAFETY_PRIORITY_HUMAN", "CLINICAL_BOUNDARY_ROUTE"]);

/* ------------------------------------------------------------------------ */
/* Errors                                                                    */
/* ------------------------------------------------------------------------ */

export const ConsoleErrorBodyS = z.strictObject({
  error: z.strictObject({
    reasonCode: ReasonCodeS,
    correlationId: OpaqueIdS.nullable(),
    retryable: z.boolean(),
  }),
});

/* ------------------------------------------------------------------------ */
/* Authentication                                                            */
/* ------------------------------------------------------------------------ */

const HttpsUrlS = z.string().max(512).regex(/^https:\/\/[A-Za-z0-9.-]{1,253}(:\d{2,5})?(\/[A-Za-z0-9._~/%-]*)?$/);

export const OidcClientConfigS = z.strictObject({
  status: z.enum(["CONFIGURED", "BLOCKED"]),
  issuer: HttpsUrlS.nullable(),
  clientId: z.string().max(256).regex(/^[A-Za-z0-9._:-]{3,256}$/).nullable(),
  authorizationEndpoint: HttpsUrlS.nullable(),
  redirectPath: z.literal("/auth/callback"),
  scopes: z.array(z.string().regex(/^[a-z][a-z0-9_:.-]{1,63}$/)).min(1).max(8),
  codeChallengeMethod: z.literal("S256"),
  blockedReasonCode: ReasonCodeS.nullable(),
});

export const AuthConfigResponseS = z.strictObject({
  apiVersion: z.literal(CONSOLE_API_VERSION),
  environment: EnvironmentS,
  localFixture: z.boolean(),
  mode: z.enum(["oidc_workforce", "local_fixture"]),
  oidc: OidcClientConfigS.nullable(),
});

export const LocalStaffOptionS = z.strictObject({
  staffId: StaffIdS,
  displayLabel: z.string().min(3).max(80).regex(/^[A-Za-z][A-Za-z ]{2,79}$/),
  roles: z.array(StaffRoleS).min(1).max(8),
});

export const LocalStaffResponseS = z.strictObject({
  label: z.literal("LOCAL DEV SIGN-IN (synthetic staff)"),
  staff: z.array(LocalStaffOptionS).max(64),
});

export const LocalTokenRequestS = z.strictObject({ staffId: StaffIdS });

export const OidcExchangeRequestS = z.strictObject({
  code: z.string().min(8).max(2048).regex(/^[A-Za-z0-9._~-]+$/),
  codeVerifier: z.string().min(43).max(128).regex(/^[A-Za-z0-9._~-]+$/),
  redirectUri: z.string().max(512),
  nonce: z.string().min(16).max(256).regex(/^[A-Za-z0-9._~-]+$/),
});

export const TokenResponseS = z.strictObject({
  accessToken: z.string().min(16).max(16_384),
  tokenType: z.literal("Bearer"),
  expiresAt: IsoDateTimeS,
  localFixture: z.boolean(),
});

export const BreakGlassViewS = z.strictObject({
  expiresAt: IsoDateTimeS,
  approvedBy: StaffIdS,
  justificationCode: ReasonCodeS,
});

export const StaffViewS = z.strictObject({
  staffId: StaffIdS,
  displayLabel: z.string().min(3).max(80),
  roles: z.array(StaffRoleS).min(1).max(8),
  mfa: z.boolean(),
  authenticatedAt: IsoDateTimeS,
  breakGlass: BreakGlassViewS.nullable(),
});

export const MeResponseS = z.strictObject({
  apiVersion: z.literal(CONSOLE_API_VERSION),
  staff: StaffViewS,
  tenantId: OpaqueIdS,
  environment: EnvironmentS,
  localFixture: z.boolean(),
  sessionExpiresAt: IsoDateTimeS,
});

export const LogoutResponseS = z.strictObject({ loggedOut: z.literal(true) });

/* ------------------------------------------------------------------------ */
/* Overview                                                                  */
/* ------------------------------------------------------------------------ */

export const QueueHealthS = z.strictObject({
  queueId: QueueIdS,
  label: z.string().min(1).max(80),
  waiting: Count.nullable(),
  oldestWaitSeconds: Count.nullable(),
  availableAgents: Count.nullable(),
  status: HealthStatusS,
  source: AdapterKindS,
  reasonCode: ReasonCodeS.nullable(),
});

export const DependencyHealthS = z.strictObject({
  dependencyId: z.string().regex(/^[a-z][a-z0-9-]{2,63}$/),
  kind: AdapterKindS,
  status: HealthStatusS,
  circuit: z.enum(["CLOSED", "OPEN", "HALF_OPEN", "UNKNOWN"]),
  reasonCode: ReasonCodeS.nullable(),
  checkedAt: IsoDateTimeS.nullable(),
});

export const OverviewResponseS = z.strictObject({
  generatedAt: IsoDateTimeS,
  liveSessions: z.strictObject({ active: Count, inTransfer: Count, safetyActive: Count }),
  queues: z.array(QueueHealthS).max(64),
  aiAdmission: z.strictObject({
    state: z.enum(["OPEN", "CLOSED_BY_KILL_SWITCH", "LIMITED_BY_BUDGET", "LIMITED_BY_CAPACITY", "UNKNOWN"]),
    reasonCode: ReasonCodeS.nullable(),
  }),
  dependencies: z.array(DependencyHealthS).max(64),
  audit: z.strictObject({
    backlogCount: Count,
    oldestUnshippedAgeSeconds: z.number().finite().min(0).nullable(),
    sinkHealthy: z.boolean(),
    canAcceptConsequential: z.boolean(),
    reasonCode: ReasonCodeS.nullable(),
  }),
  killSwitchesEngaged: Count,
  reconciliationBacklog: Count,
  openSafetyEvents: Count,
});

/* ------------------------------------------------------------------------ */
/* Calls                                                                     */
/* ------------------------------------------------------------------------ */

export const CallsListQueryS = z.strictObject({ state: z.literal("active") });

export const CallSummaryS = z.strictObject({
  callId: OpaqueIdS,
  state: z.enum(["ACTIVE", "IN_TRANSFER", "ENDED"]),
  assurance: AssuranceS,
  intentCategory: IssueCategoryS.nullable(),
  safetyFlag: z.boolean(),
  startedAt: IsoDateTimeS,
  transferState: TransferStateS.nullable(),
  sessionGeneration: z.number().int().min(0).max(1_000_000),
  language: LanguageS,
  localFixture: z.boolean(),
});

export const CallsListResponseS = z.strictObject({
  calls: z.array(CallSummaryS).max(2000),
  generatedAt: IsoDateTimeS,
});

const TimelineBaseShape = {
  eventId: OpaqueIdS,
  at: IsoDateTimeS,
  auditEventId: OpaqueIdS.nullable(),
  turnId: z.string().regex(/^turn_[A-Za-z0-9_-]{4,64}$/).nullable(),
  sessionGeneration: z.number().int().min(0).max(1_000_000).nullable(),
};

export const CallTimelineEventS = z.discriminatedUnion("kind", [
  z.strictObject({
    ...TimelineBaseShape,
    kind: z.literal("session"),
    change: z.enum(["STARTED", "ROLE_SELECTED", "CONSENT_RECORDED", "VERIFIED", "GENERATION_CHANGED", "REVOKED", "ENDED"]),
    assurance: AssuranceS,
  }),
  z.strictObject({
    ...TimelineBaseShape,
    kind: z.literal("tool_invocation"),
    tool: z.strictObject({ name: z.string().regex(/^[a-z][a-z0-9_.]{2,63}$/), version: z.string().regex(/^(\d+\.\d+\.\d+|unrecorded)$/) }),
    status: ToolStatusS,
    reasonCode: ReasonCodeS.nullable(),
    policyDecisionId: OpaqueIdS.nullable(),
    latencyMs: z.number().int().min(0).max(86_400_000).nullable(),
  }),
  z.strictObject({
    ...TimelineBaseShape,
    kind: z.literal("policy_decision"),
    decisionId: OpaqueIdS,
    policyAction: z.string().max(81).regex(new RegExp(AUDIT_ACTION_PATTERN)),
    allow: z.boolean(),
    reasonCodes: z.array(ReasonCodeS).max(16),
    policyVersion: z.string().max(64),
    obligations: z.array(ReasonCodeS).max(8),
  }),
  z.strictObject({
    ...TimelineBaseShape,
    kind: z.literal("action"),
    actionId: OpaqueIdS,
    actionKind: ActionKindS,
    state: ActionStateS,
    receiptId: OpaqueIdS.nullable(),
    commitOutcome: CommitOutcomeS.nullable(),
  }),
  z.strictObject({
    ...TimelineBaseShape,
    kind: z.literal("transfer"),
    transferId: OpaqueIdS,
    destinationId: DestinationIdS,
    transferState: TransferStateS,
    reason: TransferReasonS,
    receiverAcknowledgedPackage: z.boolean(),
  }),
  z.strictObject({
    ...TimelineBaseShape,
    kind: z.literal("safety_event"),
    incidentId: OpaqueIdS,
    phase: z.enum(["SIGNAL_VALIDATED", "ROUTE_INITIATED", "OUTCOME"]),
    route: SafetyRouteS,
    latencyMs: z.number().int().min(0).max(86_400_000).nullable(),
    withinTarget: z.boolean().nullable(),
  }),
  z.strictObject({
    ...TimelineBaseShape,
    kind: z.literal("support_request"),
    referenceNumber: SupportReferenceS,
    syncState: SyncStateS,
  }),
]);

export const ControlAvailabilityS = z.strictObject({ available: z.boolean(), reasonCode: ReasonCodeS.nullable() });

export const VersionSetViewS = z.strictObject({
  agentConfig: VersionLabelS,
  model: VersionLabelS,
  voice: VersionLabelS,
  promptTemplates: VersionLabelS,
  policyBundle: VersionLabelS,
  toolCatalog: z.string().max(64),
  knowledgeSnapshot: VersionLabelS,
  schema: VersionLabelS,
});

export const CallDetailResponseS = z.strictObject({
  call: CallSummaryS,
  versions: VersionSetViewS.nullable(),
  controls: z.strictObject({ transfer: ControlAvailabilityS, join: ControlAvailabilityS }),
  timeline: z.array(CallTimelineEventS).max(2000),
  supportRequestRefs: z.array(SupportReferenceS).max(32),
  contentAvailable: z.literal(false),
});

export const TransferRequestS = z.strictObject({ destinationId: DestinationIdS, reason: TransferReasonS });

export const TransferResponseS = z.strictObject({
  transferId: OpaqueIdS,
  callId: OpaqueIdS,
  destinationId: DestinationIdS,
  state: TransferStateS,
  auditEventId: OpaqueIdS,
});

/* ------------------------------------------------------------------------ */
/* Support request trace                                                     */
/* ------------------------------------------------------------------------ */

export const SupportTraceResponseS = z.strictObject({
  supportRequest: z.strictObject({
    supportRequestId: OpaqueIdS,
    referenceNumber: SupportReferenceS,
    issueCategory: IssueCategoryS,
    disposition: OutcomeS,
    ownerQueue: QueueIdS,
    priority: z.enum(["P1_SAFETY", "P2_URGENT", "P3_STANDARD", "P4_LOW"]),
    restricted: z.boolean(),
    sourceCallIds: z.array(OpaqueIdS).max(32),
    createdAt: IsoDateTimeS,
    updatedAt: IsoDateTimeS,
  }),
  sync: z.strictObject({
    state: SyncStateS,
    attempts: Count,
    lastAttemptAt: IsoDateTimeS.nullable(),
    lastReasonCode: ReasonCodeS.nullable(),
    salesforceCaseId: z.string().regex(/^[a-zA-Z0-9]{15,18}$/).nullable(),
    syncedAt: IsoDateTimeS.nullable(),
    outboxMessageIds: z.array(OpaqueIdS).max(64),
  }),
  actions: z
    .array(
      z.strictObject({
        actionId: OpaqueIdS,
        kind: ActionKindS,
        state: ActionStateS,
        receiptId: OpaqueIdS.nullable(),
        commitOutcome: CommitOutcomeS.nullable(),
        committedAt: IsoDateTimeS.nullable(),
      }),
    )
    .max(64),
  workflows: z
    .array(
      z.strictObject({
        workflowId: OpaqueIdS,
        type: WorkflowTypeS,
        state: WorkflowStateNameS,
        definitionVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
        ownerQueue: QueueIdS,
        deadline: IsoDateTimeS.nullable(),
        openTaskIds: z.array(OpaqueIdS).max(16),
      }),
    )
    .max(32),
  auditEventIds: z.array(OpaqueIdS).max(500),
});

/* ------------------------------------------------------------------------ */
/* Pending actions                                                           */
/* ------------------------------------------------------------------------ */

export const PendingActionViewS = z.strictObject({
  actionId: OpaqueIdS,
  kind: ActionKindS,
  state: z.enum(["PREPARED", "CONFIRMED", "COMMITTING"]),
  callId: OpaqueIdS.nullable(),
  preparedAt: IsoDateTimeS,
  expiresAt: IsoDateTimeS,
  requiresStepUp: z.boolean(),
  target: z.strictObject({ system: ActionTargetSystemS, recordType: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/) }),
  digestPrefix: z.string().regex(/^[a-f0-9]{12}$/),
  cancellable: z.boolean(),
  notCancellableReason: ReasonCodeS.nullable(),
});

export const PendingActionsResponseS = z.strictObject({ actions: z.array(PendingActionViewS).max(500) });

export const CancelActionRequestS = z.strictObject({ reason: OperatorReasonS, expectedState: z.enum(["PREPARED", "CONFIRMED"]) });

export const CancelActionResponseS = z.strictObject({ actionId: OpaqueIdS, state: z.literal("CANCELLED"), auditEventId: OpaqueIdS });

/* ------------------------------------------------------------------------ */
/* Reconciliation and dead letters                                           */
/* ------------------------------------------------------------------------ */

export const ReconcileResultViewS = z.strictObject({
  reconciliationId: OpaqueIdS,
  result: z.enum(["COMMITTED", "NOT_FOUND", "UNKNOWN"]),
  at: IsoDateTimeS,
  receiptId: OpaqueIdS.nullable(),
});

export const ReconciliationItemS = z.strictObject({
  actionId: OpaqueIdS,
  kind: ActionKindS,
  state: z.enum(["UNKNOWN", "COMMITTING"]),
  providerSystem: ActionTargetSystemS,
  since: IsoDateTimeS,
  attempts: Count,
  lastReconcile: ReconcileResultViewS.nullable(),
  retryEligible: z.boolean(),
});

export const DeadLetterItemS = z.strictObject({
  messageId: OpaqueIdS,
  topic: OutboxTopicS,
  aggregateRef: z.string().max(128).regex(/^[A-Za-z0-9_.:@/-]{1,128}$/),
  attempts: Count,
  lastReasonCode: ReasonCodeS.nullable(),
  createdAt: IsoDateTimeS,
  deadAt: IsoDateTimeS,
});

export const ReconciliationResponseS = z.strictObject({
  actions: z.array(ReconciliationItemS).max(500),
  deadLetters: z.array(DeadLetterItemS).max(500),
});

export const ReconcileRequestS = z.strictObject({});

export const ReconcileResponseS = z.strictObject({
  actionId: OpaqueIdS,
  result: ReconcileResultViewS,
  state: ActionStateS,
  retryEligible: z.boolean(),
  auditEventId: OpaqueIdS,
});

export const RetryRequestS = z.strictObject({ reconciliationId: OpaqueIdS, reason: OperatorReasonS });

export const RetryResponseS = z.strictObject({
  actionId: OpaqueIdS,
  state: ActionStateS,
  outcome: CommitOutcomeS,
  receiptId: OpaqueIdS.nullable(),
  auditEventId: OpaqueIdS,
});

export const RequeueRequestS = z.strictObject({ reason: OperatorReasonS });

export const RequeueResponseS = z.strictObject({ messageId: OpaqueIdS, requeued: z.boolean(), auditEventId: OpaqueIdS });

/* ------------------------------------------------------------------------ */
/* Workflow human tasks                                                      */
/* ------------------------------------------------------------------------ */

export const HumanTaskViewS = z.strictObject({
  taskId: OpaqueIdS,
  workflowId: OpaqueIdS,
  workflowType: WorkflowTypeS,
  workflowState: WorkflowStateNameS,
  taskType: z.string().regex(/^[a-z][a-z0-9_]{2,63}$/),
  requiredStaffRoles: z.array(StaffRoleS).min(1).max(8),
  status: z.enum(["OPEN", "COMPLETED", "EXPIRED", "CANCELLED"]),
  ownerQueue: QueueIdS,
  createdAt: IsoDateTimeS,
  expiresAt: IsoDateTimeS,
  sourceRecordRefs: z.array(OpaqueIdS).max(16),
});

export const WorkflowTasksResponseS = z.strictObject({ tasks: z.array(HumanTaskViewS).max(500) });

export const WorkflowDecisionRequestS = z.strictObject({ decision: z.enum(["APPROVE", "REJECT"]), reason: OperatorReasonS });

export const WorkflowDecisionResponseS = z.strictObject({
  taskId: OpaqueIdS,
  workflowId: OpaqueIdS,
  decision: z.enum(["APPROVE", "REJECT"]),
  workflowState: WorkflowStateNameS,
  auditEventId: OpaqueIdS,
});

/* ------------------------------------------------------------------------ */
/* Safety events                                                             */
/* ------------------------------------------------------------------------ */

export const SafetyEventViewS = z.strictObject({
  incidentId: OpaqueIdS,
  callId: OpaqueIdS,
  detectedAt: IsoDateTimeS,
  route: SafetyRouteS,
  signalSources: z.array(SafetySignalSourceS).max(5),
  ruleIds: z.array(z.string().regex(/^[a-z][a-z0-9_.-]{2,80}$/)).max(32),
  strongestStrength: z.enum(["CREDIBLE", "UNRESOLVED"]).nullable(),
  destinationId: DestinationIdS,
  routeInitiatedAt: IsoDateTimeS.nullable(),
  latencyMs: z.number().int().min(0).max(86_400_000).nullable(),
  targetMs: z.number().int().min(1).max(60_000),
  withinTarget: z.boolean().nullable(),
  outcome: SafetyRouteOutcomeS,
  auditStatus: z.enum(["RECORDED", "AUDIT_UNAVAILABLE"]),
  afterHours: z.boolean(),
  locale: z.string().regex(/^([a-z]{2,3}(-[A-Z]{2}|-[0-9]{3})?|und)$/),
  localeSupported: z.boolean(),
});

export const SafetyEventsResponseS = z.strictObject({ events: z.array(SafetyEventViewS).max(500) });

/* ------------------------------------------------------------------------ */
/* Releases                                                                  */
/* ------------------------------------------------------------------------ */

export const DiffEntryS = z.strictObject({
  ref: z.string().regex(/^[a-z][a-z0-9_.:-]{2,120}$/),
  change: z.enum(["ADDED", "REMOVED", "CHANGED"]),
  summaryCode: ReasonCodeS,
});

export const HeldItemS = z.strictObject({
  ref: z.string().regex(/^[a-z][a-z0-9_.:-]{2,120}$/),
  version: z.number().int().min(1).max(1_000_000),
  status: z.enum(["HELD_FOR_REVIEW", "QUARANTINED", "EXPIRED_IN_SERVICE"]),
  reasonCodes: z.array(ReasonCodeS).max(16),
});

export const ReleaseReviewItemS = z.strictObject({
  releaseId: OpaqueIdS,
  kind: ReleaseKindS,
  version: VersionLabelS,
  previousVersion: VersionLabelS.nullable(),
  digest: Sha256S,
  submittedAt: IsoDateTimeS,
  submittedBy: StaffIdS,
  diffSummary: z.strictObject({
    added: Count,
    removed: Count,
    changed: Count,
    entries: z.array(DiffEntryS).max(200),
  }),
  reviews: z
    .array(
      z.strictObject({
        reviewId: OpaqueIdS,
        reviewerStaffId: StaffIdS,
        reviewerRole: StaffRoleS,
        decision: ReleaseReviewDecisionS,
        reason: OperatorReasonS,
        at: IsoDateTimeS,
      }),
    )
    .max(200),
  requiredApprovalScope: ApprovalScopeS,
  approvalStatus: z.enum(["MISSING", "PRESENT", "EXPIRED", "SIGNATURE_INVALID"]),
  approvalId: z.string().regex(/^apr_[A-Za-z0-9_-]{8,64}$/).nullable(),
  heldItems: z.array(HeldItemS).max(500).optional(),
});

export const ReleasesResponseS = z.strictObject({ releases: z.array(ReleaseReviewItemS).max(200) });

export const ReleaseReviewRequestS = z.strictObject({ decision: ReleaseReviewDecisionS, reason: OperatorReasonS });

export const ReleaseReviewResponseS = z.strictObject({
  reviewId: OpaqueIdS,
  releaseId: OpaqueIdS,
  recordedAt: IsoDateTimeS,
  auditEventId: OpaqueIdS,
  approvalRecordCreated: z.literal(false),
});

/* ------------------------------------------------------------------------ */
/* Budgets                                                                   */
/* ------------------------------------------------------------------------ */

export const BudgetViewS = z.strictObject({
  budgetId: OpaqueIdS,
  scope: z.strictObject({ environment: z.string().max(16), cohort: z.string().max(64), workflow: z.string().max(64), vendor: z.string().max(64) }),
  periodStart: IsoDateTimeS,
  periodEnd: IsoDateTimeS,
  limitUsd: Usd,
  safetyReserveUsd: Usd,
  spentUsd: Usd,
  safetySpentUsd: Usd,
  nonSafetySpentUsd: Usd,
  burnRateUsdPerMinute: Usd,
  projectedUsd: Usd,
  nonessentialHeadroomUsd: Usd,
  safetyReserveRemainingUsd: SignedUsd,
  meteringDelayMinutes: z.number().int().min(0).max(10_080),
  exhausted: z.boolean(),
  safetyReserveExceeded: z.boolean(),
  approvedBy: z.string().max(120).nullable(),
  version: VersionLabelS,
});

export const BudgetsResponseS = z.strictObject({
  budgets: z.array(BudgetViewS).max(500),
  generatedAt: IsoDateTimeS,
  figuresIllustrative: z.boolean(),
});

/* ------------------------------------------------------------------------ */
/* Kill switches                                                             */
/* ------------------------------------------------------------------------ */

const KillSwitchTargetS = z.string().min(1).max(80).regex(/^(\*|[A-Za-z0-9][A-Za-z0-9_.@:+-]{0,79})$/);

export const KillSwitchViewS = z.strictObject({
  switchId: OpaqueIdS,
  scope: KillSwitchScopeS,
  target: KillSwitchTargetS,
  engaged: z.boolean(),
  reason: OperatorReasonS,
  changedBy: StaffIdS,
  changedAt: IsoDateTimeS,
});

const TargetList = z.array(KillSwitchTargetS).max(200);

export const KillSwitchesResponseS = z.strictObject({
  switches: z.array(KillSwitchViewS).max(500),
  snapshot: z.strictObject({
    aiAdmission: z.boolean(),
    writes: z.boolean(),
    outboundNotifications: z.boolean(),
    intents: TargetList,
    integrations: TargetList,
    modelVersions: TargetList,
    voiceVersions: TargetList,
  }),
  targets: z.strictObject({ INTENT: TargetList, INTEGRATION: TargetList, MODEL_VERSION: TargetList, VOICE_VERSION: TargetList }),
  safetyRoutesPreserved: z.literal(true),
});

export const KillSwitchConfirmationPhraseS = z.templateLiteral([z.enum(["ENGAGE", "RELEASE"]), " ", KillSwitchScopeS, " ", z.string().max(80)]);

export const SetKillSwitchRequestS = z.strictObject({
  scope: KillSwitchScopeS,
  target: KillSwitchTargetS,
  engaged: z.boolean(),
  reason: OperatorReasonS,
  confirmationPhrase: KillSwitchConfirmationPhraseS,
});

export const SetKillSwitchResponseS = z.strictObject({
  switch: KillSwitchViewS,
  auditEventId: OpaqueIdS,
  safetyRoutesPreserved: z.literal(true),
});

/* ------------------------------------------------------------------------ */
/* Audit search                                                              */
/* ------------------------------------------------------------------------ */

const LimitS = z
  .string()
  .regex(/^[1-9][0-9]{0,2}$/)
  .transform((v) => Number(v))
  .pipe(z.number().int().min(1).max(MAX_AUDIT_SEARCH_LIMIT));

export const AuditSearchQueryS = z
  .strictObject({
    correlationId: OpaqueIdS.optional(),
    callId: OpaqueIdS.optional(),
    action: z.string().max(81).regex(new RegExp(AUDIT_ACTION_PATTERN)).optional(),
    from: IsoDateTimeS.optional(),
    to: IsoDateTimeS.optional(),
    limit: LimitS,
  })
  .refine((q) => !q.from || !q.to || Date.parse(q.from) <= Date.parse(q.to), { message: "from after to" });

export const AuditEventMetadataS = z.strictObject({
  eventId: OpaqueIdS,
  occurredAt: IsoDateTimeS,
  correlationId: OpaqueIdS,
  parentId: OpaqueIdS.nullable(),
  actorRef: OpaqueIdS.nullable(),
  subjectRef: OpaqueIdS.nullable(),
  role: z.string().max(32).nullable(),
  sourceComponent: AuditSourceComponentS,
  callId: OpaqueIdS.nullable(),
  sessionGeneration: z.number().int().min(0).nullable(),
  action: z.string().max(81).regex(new RegExp(AUDIT_ACTION_PATTERN)),
  outcome: AuditOutcomeS,
  reasonCode: ReasonCodeS.nullable(),
  policyDecision: z
    .strictObject({ decisionId: OpaqueIdS, allow: z.boolean(), reasonCodes: z.array(ReasonCodeS).max(16), policyVersion: z.string().max(64) })
    .nullable(),
  assurance: AssuranceS.nullable(),
  dataClass: DataClassS,
  evidencePointerCount: z.number().int().min(0).max(16),
  sourceStream: z.string().regex(/^[a-z0-9_.-]{3,64}$/),
  sequence: z.number().int().min(1),
  hash: Sha256S,
});

export const AuditSearchResponseS = z.strictObject({
  events: z.array(AuditEventMetadataS).max(MAX_AUDIT_SEARCH_LIMIT),
  searchAuditEventId: OpaqueIdS,
  limit: z.number().int().min(1).max(MAX_AUDIT_SEARCH_LIMIT),
});

/* ------------------------------------------------------------------------ */
/* Destinations                                                              */
/* ------------------------------------------------------------------------ */

export const DestinationViewS = z.strictObject({
  destinationId: DestinationIdS,
  purpose: DestinationPurposeS,
  fallbackDestinationIds: z.array(DestinationIdS).max(8),
  languages: z.array(z.string().regex(/^(\*|[a-z]{2,3}(-[A-Z]{2})?)$/)).max(32),
  vendorQueueConfigured: z.boolean(),
});

export const DestinationsResponseS = z.strictObject({
  destinations: z.array(DestinationViewS).max(64),
  source: z.literal("trusted_configuration"),
});

/* ------------------------------------------------------------------------ */
/* Endpoint schema table                                                     */
/* ------------------------------------------------------------------------ */

export interface EndpointSchemas {
  /** Strict query schema, or null when the endpoint takes no query parameters. */
  query: z.ZodType | null;
  /** Strict body schema, or null when the endpoint takes no body (a POST then accepts only `{}`). */
  body: z.ZodType | null;
  response: z.ZodType;
}

export const ENDPOINT_SCHEMAS: Readonly<Record<EndpointKey, EndpointSchemas>> = {
  "auth.config": { query: null, body: null, response: AuthConfigResponseS },
  "auth.localStaff": { query: null, body: null, response: LocalStaffResponseS },
  "auth.localToken": { query: null, body: LocalTokenRequestS, response: TokenResponseS },
  "auth.oidcExchange": { query: null, body: OidcExchangeRequestS, response: TokenResponseS },
  "auth.logout": { query: null, body: null, response: LogoutResponseS },
  me: { query: null, body: null, response: MeResponseS },
  overview: { query: null, body: null, response: OverviewResponseS },
  "calls.list": { query: CallsListQueryS, body: null, response: CallsListResponseS },
  "calls.get": { query: null, body: null, response: CallDetailResponseS },
  "calls.transfer": { query: null, body: TransferRequestS, response: TransferResponseS },
  "supportRequests.trace": { query: null, body: null, response: SupportTraceResponseS },
  "actions.pending": { query: null, body: null, response: PendingActionsResponseS },
  "actions.cancel": { query: null, body: CancelActionRequestS, response: CancelActionResponseS },
  "reconciliation.list": { query: null, body: null, response: ReconciliationResponseS },
  "reconciliation.reconcile": { query: null, body: ReconcileRequestS, response: ReconcileResponseS },
  "reconciliation.retry": { query: null, body: RetryRequestS, response: RetryResponseS },
  "outbox.requeue": { query: null, body: RequeueRequestS, response: RequeueResponseS },
  "workflows.tasks": { query: null, body: null, response: WorkflowTasksResponseS },
  "workflows.decision": { query: null, body: WorkflowDecisionRequestS, response: WorkflowDecisionResponseS },
  "safetyEvents.list": { query: null, body: null, response: SafetyEventsResponseS },
  "releases.list": { query: null, body: null, response: ReleasesResponseS },
  "releases.review": { query: null, body: ReleaseReviewRequestS, response: ReleaseReviewResponseS },
  "budgets.list": { query: null, body: null, response: BudgetsResponseS },
  "killSwitches.list": { query: null, body: null, response: KillSwitchesResponseS },
  "killSwitches.set": { query: null, body: SetKillSwitchRequestS, response: SetKillSwitchResponseS },
  "audit.search": { query: AuditSearchQueryS, body: null, response: AuditSearchResponseS },
  "destinations.list": { query: null, body: null, response: DestinationsResponseS },
};

/** Path parameter validators (PATH_PARAM_PATTERNS). Values are never echoed when invalid. */
export const PATH_PARAM_SCHEMAS: Readonly<Record<PathParamName, z.ZodType<string>>> = {
  callId: z.string().max(80).regex(new RegExp(PATH_PARAM_PATTERNS.callId)),
  ref: z.string().max(16).regex(new RegExp(PATH_PARAM_PATTERNS.ref)),
  actionId: z.string().max(80).regex(new RegExp(PATH_PARAM_PATTERNS.actionId)),
  messageId: z.string().max(80).regex(new RegExp(PATH_PARAM_PATTERNS.messageId)),
  taskId: z.string().max(80).regex(new RegExp(PATH_PARAM_PATTERNS.taskId)),
  releaseId: z.string().max(80).regex(new RegExp(PATH_PARAM_PATTERNS.releaseId)),
};
