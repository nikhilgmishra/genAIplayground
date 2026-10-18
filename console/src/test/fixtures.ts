/**
 * LOCAL TEST FIXTURES — SYNTHETIC DATA ONLY, NOT PHI.
 *
 * Console API responses built from the canonical synthetic world
 * (platform/src/fixtures/synthetic-world.ts): synthetic staff, call ids,
 * destinations and tenant. Every other id is an obviously synthetic opaque id.
 * Budget figures are illustrative test values, not approved budgets.
 */
import { CALLS, DESTINATIONS, STAFF, TENANT_ID } from "../../../platform/src/fixtures/synthetic-world";
import type {
  AuditSearchResponse,
  AuthConfigResponse,
  BudgetsResponse,
  CallDetailResponse,
  CallsListResponse,
  DestinationsResponse,
  KillSwitchesResponse,
  MeResponse,
  OverviewResponse,
  PendingActionsResponse,
  ReconciliationResponse,
  ReleasesResponse,
  SafetyEventsResponse,
  StaffRole,
  StaffView,
  SupportTraceResponse,
  WorkflowTasksResponse,
} from "../api/contract";

export const NOW = "2026-10-17T15:00:00.000Z";
export const SUPPORT_REF = "SR-7KQM-W4XP";
export const INCIDENT_REF = "inc_synthIncident000001";
export const PRIMARY_CALL = CALLS.primary.callId;
export const SAFETY_CALL = CALLS.concurrent.callId;
/** Canary strings: if any of these reach the DOM, content leaked. */
export const TRANSCRIPT_CANARY = "SYNTHETIC-TRANSCRIPT-CANARY caller said something";
export const TASK_TOKEN_CANARY = "SYNTHETIC-TASK-TOKEN-CANARY";

export type StaffKey = keyof typeof STAFF;

const LABELS: Readonly<Record<StaffKey, string>> = {
  supervisor: "Synthetic Supervisor",
  agent: "Synthetic Support Agent",
  safety: "Synthetic Safety Responder",
  auditor: "Synthetic Auditor",
  policyApprover: "Synthetic Policy Approver",
  knowledgeEditor: "Synthetic Knowledge Editor",
  deployOperator: "Synthetic Deployment Operator",
  securityAdmin: "Synthetic Security Admin",
};

export function staffView(key: StaffKey, overrides: Partial<StaffView> = {}): StaffView {
  const s = STAFF[key];
  return {
    staffId: s.staffId,
    displayLabel: LABELS[key],
    roles: [...s.roles] as StaffRole[],
    mfa: true,
    authenticatedAt: "2026-10-17T14:00:00.000Z",
    breakGlass: null,
    ...overrides,
  };
}

export const ALL_STAFF_KEYS = Object.keys(STAFF) as StaffKey[];

export function meFor(staff: StaffView, overrides: Partial<MeResponse> = {}): MeResponse {
  return {
    apiVersion: "console-api.v1",
    staff,
    tenantId: TENANT_ID,
    environment: "local",
    localFixture: true,
    sessionExpiresAt: "2099-01-01T00:00:00.000Z",
    ...overrides,
  };
}

export function authConfigLocal(overrides: Partial<AuthConfigResponse> = {}): AuthConfigResponse {
  return {
    apiVersion: "console-api.v1",
    environment: "local",
    localFixture: true,
    mode: "local_fixture",
    oidc: {
      status: "BLOCKED",
      issuer: null,
      clientId: null,
      authorizationEndpoint: null,
      redirectPath: "/auth/callback",
      scopes: ["openid"],
      codeChallengeMethod: "S256",
      blockedReasonCode: "WORKFORCE_OIDC_CLIENT_NOT_ISSUED",
    },
    ...overrides,
  };
}

export const authConfigOidc = (): AuthConfigResponse => ({
  apiVersion: "console-api.v1",
  environment: "sandbox",
  localFixture: false,
  mode: "oidc_workforce",
  oidc: {
    status: "CONFIGURED",
    issuer: "https://sso-workforce.local.invalid",
    clientId: "vsp-console-local",
    authorizationEndpoint: "https://sso-workforce.local.invalid/authorize",
    redirectPath: "/auth/callback",
    scopes: ["openid", "profile"],
    codeChallengeMethod: "S256",
    blockedReasonCode: null,
  },
});

export const overview = (): OverviewResponse => ({
  generatedAt: NOW,
  liveSessions: { active: 2, inTransfer: 1, safetyActive: 1 },
  queues: [
    { queueId: "q_safety_priority", label: "Safety priority", waiting: 0, oldestWaitSeconds: 0, availableAgents: 3, status: "HEALTHY", source: "local_fixture", reasonCode: null },
    { queueId: "q_support_general", label: "General support", waiting: 4, oldestWaitSeconds: 95, availableAgents: 1, status: "DEGRADED", source: "local_fixture", reasonCode: "QUEUE_AGE_ELEVATED" },
  ],
  aiAdmission: { state: "OPEN", reasonCode: null },
  dependencies: [
    { dependencyId: "salesforce", kind: "local_fixture", status: "DOWN", circuit: "OPEN", reasonCode: "FAULT_INJECTED_OUTAGE", checkedAt: NOW },
    { dependencyId: "scheduling", kind: "local_fixture", status: "HEALTHY", circuit: "CLOSED", reasonCode: null, checkedAt: NOW },
  ],
  audit: { backlogCount: 3, oldestUnshippedAgeSeconds: 12, sinkHealthy: true, canAcceptConsequential: true, reasonCode: null },
  killSwitchesEngaged: 1,
  reconciliationBacklog: 2,
  openSafetyEvents: 1,
});

export const callsList = (): CallsListResponse => ({
  generatedAt: NOW,
  calls: [
    {
      callId: PRIMARY_CALL,
      state: "ACTIVE",
      assurance: "A2",
      intentCategory: "appointment",
      safetyFlag: false,
      startedAt: "2026-10-17T14:55:00.000Z",
      transferState: null,
      sessionGeneration: 2,
      language: "en",
      localFixture: true,
    },
    {
      callId: SAFETY_CALL,
      state: "IN_TRANSFER",
      assurance: "A0",
      intentCategory: "safety_concern",
      safetyFlag: true,
      startedAt: "2026-10-17T14:58:00.000Z",
      transferState: "QUEUED",
      sessionGeneration: 1,
      language: "en",
      localFixture: true,
    },
  ],
});

export const callDetail = (callId: string = PRIMARY_CALL): CallDetailResponse => ({
  call: { ...callsList().calls[0]!, callId },
  versions: {
    agentConfig: "agent-fixture-v1",
    model: "model-fixture-v1",
    voice: "voice-fixture-v1",
    promptTemplates: "templates-fixture-v1",
    policyBundle: "policy-fixture-v1",
    toolCatalog: "a".repeat(64),
    knowledgeSnapshot: "knowledge-fixture-v1",
    schema: "2026-10-17.1",
  },
  controls: { transfer: { available: true, reasonCode: null }, join: { available: false, reasonCode: "TALKDESK_CONTROL_UNAVAILABLE" } },
  timeline: [
    { kind: "session", eventId: "evt_synthTimeline00001", at: "2026-10-17T14:55:00.000Z", auditEventId: "aud_synthAuditEvent00001", turnId: null, sessionGeneration: 1, change: "STARTED", assurance: "A0" },
    { kind: "session", eventId: "evt_synthTimeline00002", at: "2026-10-17T14:56:00.000Z", auditEventId: "aud_synthAuditEvent00002", turnId: "turn_synth01", sessionGeneration: 2, change: "VERIFIED", assurance: "A2" },
    {
      kind: "policy_decision",
      eventId: "evt_synthTimeline00003",
      at: "2026-10-17T14:56:10.000Z",
      auditEventId: "aud_synthAuditEvent00003",
      turnId: "turn_synth02",
      sessionGeneration: 2,
      decisionId: "dec_synthDecision000001",
      policyAction: "appointment:read",
      allow: true,
      reasonCodes: ["SELF_RELATIONSHIP"],
      policyVersion: "policy-fixture-v1",
      obligations: ["AUDIT_READ"],
    },
    {
      kind: "tool_invocation",
      eventId: "evt_synthTimeline00004",
      at: "2026-10-17T14:56:11.000Z",
      auditEventId: "aud_synthAuditEvent00004",
      turnId: "turn_synth02",
      sessionGeneration: 2,
      tool: { name: "get_appointment_options", version: "1.0.0" },
      status: "SUCCESS",
      reasonCode: null,
      policyDecisionId: "dec_synthDecision000001",
      latencyMs: 180,
    },
    {
      kind: "action",
      eventId: "evt_synthTimeline00005",
      at: "2026-10-17T14:57:00.000Z",
      auditEventId: "aud_synthAuditEvent00005",
      turnId: "turn_synth03",
      sessionGeneration: 2,
      actionId: "act_synthActionPrepared01",
      actionKind: "appointment.reschedule",
      state: "PREPARED",
      receiptId: null,
      commitOutcome: null,
    },
    {
      kind: "support_request",
      eventId: "evt_synthTimeline00006",
      at: "2026-10-17T14:57:30.000Z",
      auditEventId: "aud_synthAuditEvent00006",
      turnId: null,
      sessionGeneration: 2,
      referenceNumber: SUPPORT_REF,
      syncState: "RETRY_SCHEDULED",
    },
  ],
  supportRequestRefs: [SUPPORT_REF],
  contentAvailable: false,
});

export const destinations = (): DestinationsResponse => ({
  source: "trusted_configuration",
  destinations: DESTINATIONS.map((d) => ({
    destinationId: d.destinationId,
    purpose: d.purpose,
    fallbackDestinationIds: [...d.fallbackDestinationIds],
    languages: [...d.languages],
    vendorQueueConfigured: false,
  })),
});

export const supportTrace = (): SupportTraceResponse => ({
  supportRequest: {
    supportRequestId: "spr_synthSupportReq0001",
    referenceNumber: SUPPORT_REF,
    issueCategory: "appointment",
    disposition: "REQUEST_ACCEPTED",
    ownerQueue: "q_support_general",
    priority: "P3_STANDARD",
    restricted: false,
    sourceCallIds: [PRIMARY_CALL],
    createdAt: "2026-10-17T14:57:30.000Z",
    updatedAt: "2026-10-17T14:58:30.000Z",
  },
  sync: {
    state: "RETRY_SCHEDULED",
    attempts: 2,
    lastAttemptAt: "2026-10-17T14:58:30.000Z",
    lastReasonCode: "SALESFORCE_UNAVAILABLE",
    salesforceCaseId: null,
    syncedAt: null,
    outboxMessageIds: ["msg_synthOutboxSync00001"],
  },
  actions: [
    { actionId: "act_synthActionPrepared01", kind: "appointment.reschedule", state: "PREPARED", receiptId: null, commitOutcome: null, committedAt: null },
  ],
  workflows: [
    {
      workflowId: "wf_synthWorkflowSync0001",
      type: "support_request_sync",
      state: "WAITING_FOR_SYSTEM",
      definitionVersion: "support_request_sync@1",
      ownerQueue: "q_support_general",
      deadline: "2026-10-17T16:00:00.000Z",
      openTaskIds: [],
    },
  ],
  auditEventIds: ["aud_synthAuditEvent00006", "aud_synthAuditEvent00007"],
});

export const pendingActions = (): PendingActionsResponse => ({
  actions: [
    {
      actionId: "act_synthActionPrepared01",
      kind: "appointment.reschedule",
      state: "PREPARED",
      callId: PRIMARY_CALL,
      preparedAt: "2026-10-17T14:57:00.000Z",
      expiresAt: "2026-10-17T15:02:00.000Z",
      requiresStepUp: false,
      target: { system: "scheduling", recordType: "appointment" },
      digestPrefix: "3f2a9c0d81be",
      cancellable: true,
      notCancellableReason: null,
    },
    {
      actionId: "act_synthActionCommitting",
      kind: "billing.review.submit",
      state: "COMMITTING",
      callId: null,
      preparedAt: "2026-10-17T14:50:00.000Z",
      expiresAt: "2026-10-17T14:55:00.000Z",
      requiresStepUp: false,
      target: { system: "billing", recordType: "billing_review" },
      digestPrefix: "77c1e0aa4f09",
      cancellable: false,
      notCancellableReason: "COMMIT_IN_PROGRESS",
    },
  ],
});

export const reconciliation = (): ReconciliationResponse => ({
  actions: [
    {
      actionId: "act_synthActionUnknown01",
      kind: "appointment.reschedule",
      state: "UNKNOWN",
      providerSystem: "scheduling",
      since: "2026-10-17T14:40:00.000Z",
      attempts: 1,
      lastReconcile: null,
      retryEligible: false,
    },
  ],
  deadLetters: [
    {
      messageId: "msg_synthDeadLetter00001",
      topic: "support_request.sync",
      aggregateRef: "spr_synthSupportReq0001",
      attempts: 8,
      lastReasonCode: "SALESFORCE_UNAVAILABLE",
      createdAt: "2026-10-17T13:00:00.000Z",
      deadAt: "2026-10-17T14:00:00.000Z",
    },
  ],
});

export const workflowTasks = (): WorkflowTasksResponse => ({
  tasks: [
    {
      taskId: "wft_synthTaskBilling00001",
      workflowId: "wf_synthWorkflowBilling1",
      workflowType: "billing_dispute_review",
      workflowState: "WAITING_FOR_HUMAN",
      taskType: "billing_dispute_decision",
      requiredStaffRoles: ["supervisor", "support_agent"],
      status: "OPEN",
      ownerQueue: "q_billing_specialist",
      createdAt: "2026-10-17T12:00:00.000Z",
      expiresAt: "2026-10-20T12:00:00.000Z",
      sourceRecordRefs: ["spr_synthSupportReq0001"],
    },
    {
      taskId: "wft_synthTaskPartner00001",
      workflowId: "wf_synthWorkflowPartner1",
      workflowType: "partner_onboarding",
      workflowState: "WAITING_FOR_HUMAN",
      taskType: "partner_onboarding_approval",
      requiredStaffRoles: ["supervisor"],
      status: "OPEN",
      ownerQueue: "q_partner_support",
      createdAt: "2026-10-17T11:00:00.000Z",
      expiresAt: "2026-10-24T11:00:00.000Z",
      sourceRecordRefs: ["spr_synthSupportReq0002"],
    },
  ],
});

export const safetyEvents = (): SafetyEventsResponse => ({
  events: [
    {
      incidentId: "sev_synthSafetyIncident01",
      callId: SAFETY_CALL,
      detectedAt: "2026-10-17T14:58:05.000Z",
      route: "SAFETY_PRIORITY_HUMAN",
      signalSources: ["EXPLICIT_PHRASE"],
      ruleIds: ["rule.synthetic.explicit.v1"],
      strongestStrength: "CREDIBLE",
      destinationId: "dst_safety_priority",
      routeInitiatedAt: "2026-10-17T14:58:05.400Z",
      latencyMs: 400,
      targetMs: 2000,
      withinTarget: true,
      outcome: "IN_PROGRESS",
      auditStatus: "RECORDED",
      afterHours: false,
      locale: "en",
      localeSupported: true,
    },
  ],
});

export const releases = (): ReleasesResponse => ({
  releases: [
    {
      releaseId: "rls_synthPolicyRelease01",
      kind: "POLICY_BUNDLE",
      version: "policy-fixture-v2",
      previousVersion: "policy-fixture-v1",
      digest: "b".repeat(64),
      submittedAt: "2026-10-17T10:00:00.000Z",
      submittedBy: STAFF.deployOperator.staffId,
      diffSummary: { added: 1, removed: 0, changed: 1, entries: [{ ref: "rule.appointment.read", change: "CHANGED", summaryCode: "SCOPE_NARROWED" }, { ref: "rule.partner.intake", change: "ADDED", summaryCode: "NEW_RULE" }] },
      reviews: [],
      requiredApprovalScope: "POLICY_RELEASE",
      approvalStatus: "MISSING",
      approvalId: null,
    },
    {
      releaseId: "rls_synthKnowledgeRelease",
      kind: "KNOWLEDGE_SNAPSHOT",
      version: "knowledge-fixture-v2",
      previousVersion: "knowledge-fixture-v1",
      digest: "c".repeat(64),
      submittedAt: "2026-10-17T09:00:00.000Z",
      submittedBy: STAFF.knowledgeEditor.staffId,
      diffSummary: { added: 0, removed: 1, changed: 0, entries: [{ ref: "kb.synthetic.portal-login", change: "REMOVED", summaryCode: "EXPIRED_ITEM" }] },
      reviews: [],
      requiredApprovalScope: "KNOWLEDGE_RELEASE",
      approvalStatus: "MISSING",
      approvalId: null,
    },
  ],
});

export const budgets = (): BudgetsResponse => ({
  generatedAt: NOW,
  figuresIllustrative: true,
  budgets: [
    {
      budgetId: "bud_synthBudgetLocal0001",
      scope: { environment: "local", cohort: "*", workflow: "*", vendor: "*" },
      periodStart: "2026-10-01T00:00:00.000Z",
      periodEnd: "2026-11-01T00:00:00.000Z",
      limitUsd: 100,
      safetyReserveUsd: 20,
      spentUsd: 42.5,
      safetySpentUsd: 2.5,
      nonSafetySpentUsd: 40,
      burnRateUsdPerMinute: 0.05,
      projectedUsd: 45.5,
      nonessentialHeadroomUsd: 34.5,
      safetyReserveRemainingUsd: 17.5,
      meteringDelayMinutes: 60,
      exhausted: false,
      safetyReserveExceeded: false,
      approvedBy: null,
      version: "budget-fixture-v1",
    },
  ],
});

export const killSwitches = (): KillSwitchesResponse => ({
  switches: [
    { switchId: "ksw_synthKillSwitchAiAdm", scope: "AI_ADMISSION", target: "*", engaged: false, reason: "PLANNED_DRILL_COMPLETE", changedBy: STAFF.supervisor.staffId, changedAt: "2026-10-16T10:00:00.000Z" },
    { switchId: "ksw_synthKillSwitchWrites", scope: "WRITES", target: "*", engaged: false, reason: "ROOT_CAUSE_FIXED", changedBy: STAFF.securityAdmin.staffId, changedAt: "2026-10-16T11:00:00.000Z" },
    { switchId: "ksw_synthKillSwitchSfdc01", scope: "INTEGRATION", target: "salesforce", engaged: true, reason: `DEPENDENCY_OUTAGE:${INCIDENT_REF}`, changedBy: STAFF.supervisor.staffId, changedAt: "2026-10-17T14:30:00.000Z" },
    { switchId: "ksw_synthKillSwitchModel1", scope: "MODEL_VERSION", target: "model-fixture-v1", engaged: false, reason: "ROOT_CAUSE_FIXED", changedBy: STAFF.deployOperator.staffId, changedAt: "2026-10-15T09:00:00.000Z" },
  ],
  snapshot: { aiAdmission: false, writes: false, outboundNotifications: false, intents: [], integrations: ["salesforce"], modelVersions: [], voiceVersions: [] },
  targets: {
    INTENT: ["appointment_reschedule", "billing_dispute_intake"],
    INTEGRATION: ["salesforce", "scheduling", "billing"],
    MODEL_VERSION: ["model-fixture-v1"],
    VOICE_VERSION: ["voice-fixture-v1"],
  },
  safetyRoutesPreserved: true,
});

export const auditSearch = (): AuditSearchResponse => ({
  limit: 50,
  searchAuditEventId: "aud_synthAuditSearch0001",
  events: [
    {
      eventId: "aud_synthAuditEvent00005",
      occurredAt: "2026-10-17T14:57:00.000Z",
      correlationId: "cor_synthCorrelation0001",
      parentId: null,
      actorRef: "act_synthClientAvery01",
      subjectRef: "sub_synthClientAvery01",
      role: "client",
      sourceComponent: "actions",
      callId: PRIMARY_CALL,
      sessionGeneration: 2,
      action: "action.prepare",
      outcome: "SUCCEEDED",
      reasonCode: null,
      policyDecision: { decisionId: "dec_synthDecision000001", allow: true, reasonCodes: ["SELF_RELATIONSHIP"], policyVersion: "policy-fixture-v1" },
      assurance: "A2",
      dataClass: "SECURITY_AUDIT",
      evidencePointerCount: 1,
      sourceStream: "actions.main",
      sequence: 42,
      hash: "d".repeat(64),
    },
  ],
});
