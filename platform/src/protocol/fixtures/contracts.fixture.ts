/**
 * LOCAL TEST FIXTURE — SYNTHETIC, valid instances of the follow-on contracts for the protocol unit
 * tests. Identifiers come from platform/src/fixtures/synthetic-world.ts or are synthetic opaque ids;
 * no real people, phone numbers or PHI. Each builder returns a fresh object so tests can mutate it.
 */
import { CALLS, OTHER_TENANT_ID, TENANT_ID } from "../../fixtures/synthetic-world.js";
import { sha256Hex } from "../../shared/canonical.js";
import type { ActivationRecord, ActivationReport } from "../activation.js";
import type { ActionGrant, ConfirmationReceipt } from "../actions.js";
import type { CallBinding } from "../call-binding.js";
import type { ConsentDimensionState, IssueOutcomeRecord } from "../common.js";
import type { CapabilityEvidence, ConnectorProfile } from "../connector.js";
import type { ContextFact, SourceWatermark } from "../context-facts.js";
import type { ContextSnapshot } from "../context-snapshot.js";
import { sealSpeechPlan } from "../digests.js";
import type { CaseLink, EffectVerification } from "../effects.js";
import type { IdentityLink, PersonRoleAssignment } from "../identity-link.js";
import type { CanarySpec, ChangeProposal } from "../improvement.js";
import type { KnowledgeCitation } from "../knowledge.js";
import type { AudioReleaseReceipt, CarrierEvent, ReleaseCheck, SpeechPlan, TurnEnvelope } from "../media.js";
import type { ModelDecision, ModelInvocation } from "../models.js";
import type { LongHorizonPlan } from "../plan.js";
import type { DatasetItem, ReviewRecord } from "../review.js";
import type { TenantConfig } from "../tenant.js";
import type { ToolRequestV2 } from "../tool-envelope.js";
import type { HumanTask } from "../workflow.js";

export const SYNTH = {
  tenantId: TENANT_ID,
  otherTenantId: OTHER_TENANT_ID,
  interactionId: CALLS.primary.callId,
  secondInteractionId: CALLS.repeat.callId,
  actorRef: "act_synthClientAvery01",
  subjectRef: "sub_synthClientAvery01",
  otherSubjectRef: "sub_synthClientBlake01",
  caseId: "sr_synthSupportRequest01",
  secondCaseId: "sr_synthSupportRequest02",
  workflowId: "wf_synthWorkflow00000001",
  requestId: "req_synthRequest0000001",
  causationId: "evt_synthCausation000001",
  turnId: "turn_synth0001",
  sessionRef: "ses_synthSessionPrimary01",
  personRef: "per_synthPersonAvery0001",
  staffId: "stf_synthSupervisor01",
  reviewerStaffId: "stf_synthReviewer0001",
  t0: "2026-10-19T15:00:00.000Z",
} as const;

export const at = (offsetMs: number): string => new Date(Date.parse(SYNTH.t0) + offsetMs).toISOString();
export const digestOf = (label: string): string => sha256Hex(`synthetic:${label}`);

export function callBinding(): CallBinding {
  return {
    schemaVersion: "call-binding.v1",
    tenantId: SYNTH.tenantId,
    interactionId: SYNTH.interactionId,
    sessionGeneration: 1,
    occurredAt: SYNTH.t0,
    expiresAt: at(3_600_000),
    causationId: SYNTH.causationId,
    bindingId: "cbd_synthBinding00000001",
    carrier: { kind: "sip_reference", interactionRef: "sip-call-7f3a9c21-synthetic", routeRef: "dispatch/reference-trunk" },
    owner: { adapter: "controlled_cascade_runtime", instanceRef: "media-worker-a1", fencingToken: 7 },
    sessionBindingRef: null,
    boundBy: "carrier_dispatch_rule",
    state: "ACTIVE",
    supersedesBindingId: null,
  };
}

export function turnEnvelope(): TurnEnvelope {
  return {
    schemaVersion: "turn-envelope.v1",
    tenantId: SYNTH.tenantId,
    interactionId: SYNTH.interactionId,
    sessionGeneration: 1,
    turnId: SYNTH.turnId,
    occurredAt: SYNTH.t0,
    dataClassification: "INTERNAL",
    causationId: null,
    caseId: null,
    turnRevision: 0,
    speaker: "caller",
    inputKind: "SPEECH",
    voiceMode: "CONTROLLED_CASCADE",
    timing: { speechStartedAt: SYNTH.t0, speechEndedAt: at(1_800), endpointedAt: at(2_100), firstMeaningfulAudioAt: at(2_700) },
    asr: { engineRef: "asr-stream-1", language: "en-US", confidence: 0.91, final: true, entityUncertain: false },
    interruption: null,
    transcriptRef: "restricted/transcripts/turn_synth0001",
    dtmfCaptured: false,
    speechPlanRefs: [],
    toolRequestRefs: [SYNTH.requestId],
  };
}

export function carrierEvent(): CarrierEvent {
  return {
    schemaVersion: "carrier-event.v1",
    tenantId: SYNTH.tenantId,
    occurredAt: SYNTH.t0,
    interactionId: SYNTH.interactionId,
    causationId: null,
    eventId: "cev_synthCarrierEvent0001",
    carrier: "sip_reference",
    carrierInteractionRef: "sip-call-7f3a9c21-synthetic",
    providerEventId: "evt-000001",
    providerSequence: 1,
    type: "TRANSFER_RECEIVER_ACCEPTED",
    clockSource: "carrier",
    receivedAt: at(40),
    authentication: { mechanism: "vendor_signature_verified", keyRef: "arn:aws:kms:us-east-1:111122223333:key/synthetic-webhook" },
    payloadDigest: digestOf("carrier-payload"),
    payloadSchemaRef: "sip-events-1",
    participantRef: null,
    transfer: { transferRef: "trf_synthTransfer000001", destinationId: "dst_standard_support", receiverRef: "agt_synthReceiver000001" },
    recording: null,
  };
}

export function unsealedSpeechPlan(): Omit<SpeechPlan, "outputDecisionDigest"> {
  return {
    schemaVersion: "speech-plan.v1",
    tenantId: SYNTH.tenantId,
    interactionId: SYNTH.interactionId,
    sessionGeneration: 1,
    turnId: SYNTH.turnId,
    requestId: SYNTH.requestId,
    occurredAt: SYNTH.t0,
    expiresAt: at(30_000),
    causationId: SYNTH.causationId,
    planId: "spl_synthSpeechPlan00001",
    turnRevision: 0,
    utteranceClass: "FINANCIAL_FACT",
    route: "CONTROLLED",
    language: "en-US",
    segments: [
      {
        kind: "TEMPLATE_EXACT",
        templateId: "billing.balance_due",
        templateVersion: "1.0.0",
        text: "Your current balance is {balance}, due on {dueOn}.",
        slotNames: ["balance", "dueOn"],
      },
    ],
    protectedSlots: [
      { kind: "MONEY", name: "balance", value: { currency: "USD", minorUnits: 4_500 }, sourceRef: "billing/invoices/inv_synthInvoice0000001" },
      { kind: "DATE", name: "dueOn", value: "2026-10-31", timeZone: "America/Chicago", sourceRef: "billing/invoices/inv_synthInvoice0000001" },
    ],
    authorizationRef: "dec_synthDecision000001",
    sourceRefs: ["billing/invoices/inv_synthInvoice0000001"],
    receiptRefs: [],
    versions: { policyVersion: "policy-2026-10-17.1", configVersion: "tenant-config-3", templateCatalogDigest: digestOf("templates"), voice: "voice-a-1", contextSnapshotRef: "ctx_synthSnapshot0000001", contextRevision: 2 },
    allowedRenderers: ["controlled_tts", "fallback_clip"],
    dataClassification: "FINANCIAL",
  };
}

export const speechPlan = (): SpeechPlan => sealSpeechPlan(unsealedSpeechPlan());

export function passingCheck(offsetMs: number): ReleaseCheck {
  return { generationCurrent: true, turnCurrent: true, notCancelled: true, notExpired: true, notRevoked: true, digestVerified: true, fencingTokenCurrent: true, checkedAt: at(offsetMs) };
}

export function audioReleaseReceipt(): AudioReleaseReceipt {
  return {
    schemaVersion: "audio-release-receipt.v1",
    tenantId: SYNTH.tenantId,
    interactionId: SYNTH.interactionId,
    sessionGeneration: 1,
    turnId: SYNTH.turnId,
    occurredAt: at(3_200),
    causationId: "spl_synthSpeechPlan00001",
    receiptId: "arr_synthAudioReceipt001",
    source: { kind: "speech_plan", planId: "spl_synthSpeechPlan00001", outputDecisionDigest: digestOf("plan") },
    renderer: "controlled_tts",
    approvedContentDigest: digestOf("approved-text"),
    renderedAudioDigest: digestOf("rendered-audio"),
    enqueueCheck: passingCheck(2_900),
    emissionCheck: passingCheck(3_000),
    status: "EMITTED_COMPLETE",
    rejectionReason: null,
    playback: { firstFrameAt: at(3_000), lastFrameAt: at(6_200), emittedMs: 3_200, framesEmitted: 160, interruptedAt: null },
  };
}

export function contextFact(): ContextFact {
  return {
    schemaVersion: "context-fact.v1",
    tenantId: SYNTH.tenantId,
    occurredAt: at(-86_400_000),
    dataClassification: "FINANCIAL",
    subjectRef: SYNTH.subjectRef,
    causationId: null,
    expiresAt: null,
    factId: "fct_synthFactBalance0001",
    factType: "billing.balance",
    value: { kind: "money", value: { currency: "USD", minorUnits: 4_500 } },
    source: { system: "billing", recordRef: "inv_synthInvoice0000001", version: "7", eventId: null },
    effectiveFrom: at(-86_400_000),
    effectiveUntil: null,
    sourceUpdatedAt: at(-3_600_000),
    receivedAt: at(-3_590_000),
    observedAt: at(-1_000),
    authorityRank: 90,
    verification: "SOURCE_VERIFIED",
    allowedPurposes: ["support_administration"],
    evidenceRef: "billing/invoices/inv_synthInvoice0000001",
    supportingFactIds: [],
    lineage: { supersedes: null, correctionOf: null, retracted: false, retractionReason: null },
    watermarkId: "wmk_synthWatermarkBill01",
  };
}

export function sourceWatermark(): SourceWatermark {
  return {
    schemaVersion: "source-watermark.v1",
    tenantId: SYNTH.tenantId,
    occurredAt: SYNTH.t0,
    causationId: null,
    watermarkId: "wmk_synthWatermarkBill01",
    source: { system: "billing", stream: "invoices", connectorProfileRef: "cnp_synthProfileBilling1" },
    low: { offset: "1000", eventTime: at(-7 * 86_400_000) },
    high: { offset: "1042", eventTime: at(-60_000) },
    lastEventReceivedAt: at(-59_000),
    lastHeartbeatAt: at(-5_000),
    expectedCount: 42,
    deliveredCount: 42,
    gapState: "NO_GAP_DETECTED",
    snapshotBoundary: null,
    reconciledAt: at(-600_000),
    maxAgeMs: 300_000,
  };
}

export function contextSnapshot(): ContextSnapshot {
  return {
    schemaVersion: "context-snapshot.v1",
    tenantId: SYNTH.tenantId,
    interactionId: SYNTH.interactionId,
    sessionGeneration: 1,
    occurredAt: SYNTH.t0,
    expiresAt: at(120_000),
    caseId: null,
    subjectRef: SYNTH.subjectRef,
    turnId: SYNTH.turnId,
    causationId: null,
    snapshotId: "ctx_synthSnapshot0000001",
    revision: 2,
    purpose: "support_administration",
    policyPurpose: "caller_self_service",
    scope: {
      selectedRole: "client",
      assurance: "A2",
      policyVersion: "policy-2026-10-17.1",
      relationshipVersion: "rel-1",
      classificationCeiling: "FINANCIAL",
      aclFilters: [
        { kind: "TENANT", ref: SYNTH.tenantId },
        { kind: "SUBJECT", ref: SYNTH.subjectRef },
        { kind: "PURPOSE", ref: "support_administration" },
      ],
    },
    facts: [contextFact()],
    citations: ["kb_billing-faq@v3"],
    timelineSummary: { templateId: "context.summary.billing", text: "One open invoice; balance from the billing system.", supportingFactIds: ["fct_synthFactBalance0001"] },
    coverage: {
      coveredSources: [{ system: "billing", watermarkId: "wmk_synthWatermarkBill01" }],
      unavailableSources: [],
      truncated: false,
      truncationReason: null,
      omissions: [],
      conflicts: [],
    },
    completeness: "COMPLETE",
    watermarks: [sourceWatermark()],
    cacheKeyDigest: digestOf("cache-key"),
    budget: { tokenBudget: 4_000, latencyBudgetMs: 200, assemblyMs: 35 },
  };
}

export function identityLink(): IdentityLink {
  return {
    schemaVersion: "identity-link.v1",
    tenantId: SYNTH.tenantId,
    occurredAt: at(-30 * 86_400_000),
    causationId: null,
    expiresAt: null,
    linkId: "idl_synthIdentityLink001",
    personRef: SYNTH.personRef,
    canonicalIdVersion: 1,
    linked: { kind: "IDP_SUBJECT", system: "portal_idp", issuer: "https://idp.example.invalid/realms/clients", externalRefDigest: digestOf("idp-subject") },
    basis: "VERIFIED_IDP_LOGIN",
    authorizationEligible: true,
    state: "ACTIVE",
    verifiedAt: at(-30 * 86_400_000),
    verificationSource: "identity_provider",
    reviewEvidenceRef: null,
    validFrom: at(-30 * 86_400_000),
    validUntil: null,
    lineage: { supersedes: null, mergedFrom: [], splitFrom: null },
  };
}

export function personRoleAssignment(role: PersonRoleAssignment["role"], suffix: string, organizationRef: string | null = null): PersonRoleAssignment {
  return {
    schemaVersion: "person-role-assignment.v1",
    tenantId: SYNTH.tenantId,
    occurredAt: at(-86_400_000),
    causationId: null,
    expiresAt: null,
    assignmentId: `pra_synthAssignment${suffix}`,
    personRef: SYNTH.personRef,
    actorRef: `act_synthActor${suffix}`,
    role,
    organizationRef,
    delegations: [],
    source: "enrollment_system",
    validFrom: at(-86_400_000),
    validUntil: null,
    revoked: false,
  };
}

export function knowledgeCitation(): KnowledgeCitation {
  return {
    schemaVersion: "knowledge-citation.v1",
    tenantId: SYNTH.tenantId,
    occurredAt: SYNTH.t0,
    causationId: null,
    expiresAt: at(90 * 86_400_000),
    citationId: "kb_billing-faq@v3",
    articleVersion: 3,
    snapshotDigest: digestOf("kb-snapshot"),
    span: { kind: "chars", start: 0, end: 120 },
    spanDigest: digestOf("kb-span"),
    sensitivity: "PUBLIC_FAQ",
    audiences: ["public", "client"],
    language: "en",
    jurisdiction: "US",
    effectiveFrom: at(-10 * 86_400_000),
    approval: { approvedAt: at(-11 * 86_400_000), approvalRef: "apr_synthKnowledge01", ownerRole: "knowledge_editor" },
    retrieval: { method: "HYBRID_RERANKED", rank: 1 },
    freshness: { indexedAt: at(-10 * 86_400_000), sourceUpdatedAt: at(-11 * 86_400_000), stale: false },
    sourceRef: "knowledge/billing-faq",
  };
}

export function modelInvocation(): ModelInvocation {
  return {
    schemaVersion: "model-invocation.v1",
    tenantId: SYNTH.tenantId,
    requestId: SYNTH.requestId,
    occurredAt: SYNTH.t0,
    interactionId: SYNTH.interactionId,
    turnId: SYNTH.turnId,
    caseId: null,
    causationId: null,
    invocationId: "minv_synthInvocation0001",
    role: "router",
    model: { registryRef: "router.primary@1", revision: "rev-2026-10-01", endpointRef: "bedrock-us-east-1", region: "us-east-1" },
    pins: { promptTemplate: "router-prompt-4", harness: "harness-1.0.0", policyVersion: "policy-2026-10-17.1", toolSchemaDigest: digestOf("tools") },
    input: { digest: digestOf("model-input"), classification: "INTERNAL", contextSnapshotRef: null },
    scope: { allowedTools: ["get_appointment_options"], purposes: ["support_administration"] },
    budget: { maxInputTokens: 4_000, maxOutputTokens: 256, deadlineMs: 1_500 },
    status: "COMPLETED",
    completedAt: at(420),
    usage: { inputTokens: 1_200, outputTokens: 40, latencyMs: 420, costMicroUsd: 900, costVersion: "cost-2026-10" },
    egress: { endpointAllowlisted: true, retentionPolicyRef: "no-retention" },
    contentRecorded: false,
    errorCode: null,
  };
}

export function modelDecision(args: Record<string, unknown> = { appointmentId: "apt_synthAveryAppt000001" }): ModelDecision {
  return {
    schemaVersion: "model-decision.v1",
    tenantId: SYNTH.tenantId,
    causationId: "minv_synthInvocation0001",
    occurredAt: at(420),
    interactionId: SYNTH.interactionId,
    turnId: SYNTH.turnId,
    decisionId: "mdec_synthDecision00001",
    invocationId: "minv_synthInvocation0001",
    authority: "PROPOSAL_ONLY",
    modelConfidence: 0.8,
    decisions: [{ kind: "TOOL_PROPOSAL", tool: { name: "get_appointment_options", version: "1.0.0" }, arguments: args }],
  };
}

export function effectVerification(): EffectVerification {
  return {
    schemaVersion: "effect-verification.v1",
    tenantId: SYNTH.tenantId,
    causationId: "rcp_synthCommitReceipt01",
    occurredAt: at(5_000),
    caseId: SYNTH.caseId,
    workflowId: null,
    interactionId: SYNTH.interactionId,
    verificationId: "efv_synthVerification001",
    actionId: "act_synthAction000000001",
    commitReceiptId: "rcp_synthCommitReceipt01",
    method: "AUTHORITATIVE_READ_BACK",
    target: { system: "scheduling", recordType: "appointment", recordRef: "apt_synthAveryAppt000001" },
    expected: { stateDigest: digestOf("rescheduled-state"), version: "8" },
    observed: { stateDigest: digestOf("rescheduled-state"), version: "8", observedAt: at(4_900), sourceEventRef: "readback-0001" },
    result: "VERIFIED",
    visibilityWindowEndsAt: null,
    evidenceRef: "evidence/effects/efv_synthVerification001",
    evidenceDigest: digestOf("effect-evidence"),
    verifier: { component: "effects.verifier", connectorProfileRef: "cnp_synthProfileSched001", independentOfModel: true },
  };
}

export function caseLink(caseId: string = SYNTH.caseId, interactionId: string | null = SYNTH.interactionId): CaseLink {
  return {
    schemaVersion: "case-link.v1",
    tenantId: SYNTH.tenantId,
    caseId,
    occurredAt: SYNTH.t0,
    interactionId,
    causationId: null,
    linkId: `csl_${caseId.slice(3)}Link`,
    system: "salesforce_service_cloud",
    kind: "PRIMARY_CASE",
    externalCaseRef: "500Ax00000SynthAAA",
    externalIdempotencyKey: "iss_synthIssue0000000001",
    syncState: "SYNCED",
    lastSyncedAt: at(60_000),
    relatedCaseId: null,
  };
}

export function connectorProfile(): Omit<ConnectorProfile, "configDigest"> {
  return {
    schemaVersion: "connector-profile.v1",
    tenantId: SYNTH.tenantId,
    occurredAt: SYNTH.t0,
    causationId: null,
    profileId: "cnp_synthProfileSched001",
    profileVersion: 1,
    family: "business_system",
    system: "scheduling",
    vendor: { name: "reference", api: "scheduling-api", apiVersion: "2026-09-01" },
    baseUrl: "https://scheduling.example.invalid/api/v1",
    allowedHosts: ["scheduling.example.invalid"],
    scopes: ["appointments:read"],
    credentialRef: "arn:aws:secretsmanager:us-east-1:111122223333:secret:vsp/scheduling-reader",
    region: "us-east-1",
    accountBinding: { externalAccountRef: "acct-synthetic-001", tenantBindingVerified: false },
    writeMode: "READ_ONLY",
    operations: [
      { operationId: "appointments.list", kind: "READ", enabled: true, method: "GET", pathTemplate: "/patients/{subjectRef}/appointments", idempotency: "NATURALLY_IDEMPOTENT", reconcileOperationId: null },
    ],
    mappings: [
      { sourceObject: "Appointment", sourcePointer: "/start", targetField: "startsAt", requirement: "REQUIRED", type: "instant", semantic: null, authoritative: true, classification: "PHI" },
      { sourceObject: "Appointment", sourcePointer: "/clinicalNotes", targetField: "clinicalNotes", requirement: "PROHIBITED", type: "string", semantic: null, authoritative: false, classification: "PHI_RESTRICTED" },
    ],
    eventSchema: null,
    pagination: { strategy: "CURSOR", maxPageSize: 50 },
    limits: { requestsPerSecond: 5, maxConcurrency: 4, timeoutMs: 2_000, retryBudget: 1 },
    deletionBehavior: "TOMBSTONE",
    retentionClass: "BUSINESS_RECORD",
    egressClass: "PHI",
    documentationUrl: "https://scheduling.example.invalid/docs",
    ownerRole: "integration_owner",
    capabilityEvidenceRefs: [],
  };
}

export function capabilityEvidence(): CapabilityEvidence {
  return {
    schemaVersion: "capability-evidence.v1",
    tenantId: SYNTH.tenantId,
    occurredAt: SYNTH.t0,
    expiresAt: at(30 * 86_400_000),
    causationId: null,
    evidenceId: "cpe_synthEvidence0000001",
    profileId: "cnp_synthProfileSched001",
    profileConfigDigest: digestOf("profile"),
    capability: "scheduling.appointments_read",
    level: "EMULATOR_PASS",
    result: "PASS",
    steps: [
      { step: "VALIDATE_CONFIGURATION", result: "PASS", detailCode: "CONFIG_VALID" },
      { step: "AUTHENTICATE", result: "PASS", detailCode: "TOKEN_ISSUED" },
      { step: "WRITE_RECONCILE_TEST", result: "NOT_RUN", detailCode: "READ_ONLY_PROFILE" },
    ],
    evidenceRef: "evidence/connectors/cpe_synthEvidence0000001",
    evidenceDigest: digestOf("evidence"),
    signature: null,
  };
}

export function changeProposal(): ChangeProposal {
  return {
    schemaVersion: "change-proposal.v1",
    tenantId: SYNTH.tenantId,
    occurredAt: SYNTH.t0,
    causationId: null,
    proposalId: "chp_synthProposal0000001",
    authoredBy: { kind: "optimizer", ref: "opt_synthOptimizer01" },
    evidenceRefs: ["evidence/evaluation/cluster-17"],
    suspectedCause: { statementCode: "RETRIEVAL_MISSES_FEE_ARTICLE", status: "HYPOTHESIS", evidenceRefs: [] },
    changes: [{ target: "RETRIEVAL_TUNING", targetRef: "retrieval/billing", fromVersion: "r-4", toVersion: "r-5", diffDigest: digestOf("diff"), diffRef: "improvement/diffs/chp-1" }],
    affectedCapabilities: ["knowledge.retrieval"],
    expectedBenefit: { metric: "retrieval.recall_at_5", direction: "INCREASE", magnitude: 0.04 },
    risks: ["CITATION_DRIFT"],
    tests: [{ suiteRef: "eval/retrieval-heldout", required: true, result: "NOT_RUN" }],
    rollback: { targetVersion: "r-4", procedureRef: "docs/RUNBOOKS/rollback" },
    state: "EVALUATING",
    reviewRefs: [],
    governanceReviewRef: null,
    heldOutFeedbackUsed: false,
  };
}

export function canarySpec(): CanarySpec {
  return {
    schemaVersion: "canary-spec.v1",
    tenantId: SYNTH.tenantId,
    occurredAt: SYNTH.t0,
    expiresAt: at(14 * 86_400_000),
    causationId: null,
    canaryId: "cny_synthCanary000000001",
    proposalId: "chp_synthProposal0000001",
    cohort: { cohortKey: "billing_en", intents: ["billing_statement_explain"], languages: ["en-US"], exposureBasisPoints: 500, assignment: "STABLE_HASH" },
    sampleTarget: 400,
    periodDays: 14,
    errorBudget: { metric: "resolution.failed_rate", maxRate: 0.02 },
    rollbackThresholds: [{ metric: "safety.missed_routing", comparator: "GT", threshold: 0 }],
    excludedBehaviours: ["CRISIS_INSTRUCTIONS", "CONSENT_CONTROLS", "AUTHORITY_CONTROLS"],
    rollbackOnCriticalFailure: true,
    signature: { signerRole: "deployment_operator", keyRef: "local-fixture:canary-signing", value: "c3ludGhldGljLXNpZ25hdHVyZQ", signedAt: SYNTH.t0 },
  };
}

export function activationRecord(overrides: Partial<ActivationRecord> = {}): ActivationRecord {
  return {
    schemaVersion: "activation-record.v1",
    tenantId: SYNTH.tenantId,
    occurredAt: SYNTH.t0,
    causationId: null,
    expiresAt: null,
    recordId: "acr_synthActivation00001",
    capabilityId: "workflows.billing_dispute",
    workflowRef: "billing_dispute_review",
    software: "IMPLEMENTED",
    environment: "NOT_CONFIGURED",
    qualification: "NOT_RUN",
    evidenceRefs: [],
    missingInputs: ["AIN-11"],
    approvalsRequired: ["PHI_PROCESSING"],
    approvalsPresent: [],
    state: "NOT_ELIGIBLE",
    reasonCodes: ["TENANT_INPUTS_MISSING"],
    ...overrides,
  };
}

export function activationReport(): ActivationReport {
  return {
    schemaVersion: "activation-report.v1",
    tenantId: SYNTH.tenantId,
    occurredAt: SYNTH.t0,
    causationId: null,
    reportId: "acp_synthActivationRep01",
    targetEnvironment: "sandbox",
    tenantConfigDigest: digestOf("tenant-config"),
    generatedBy: "qualification.runner",
    records: [activationRecord()],
    summary: { active: 0, eligible: 0, notEligible: 1, suspended: 0, deactivated: 0 },
  };
}

export function reviewRecord(): ReviewRecord {
  return {
    schemaVersion: "review-record.v1",
    tenantId: SYNTH.tenantId,
    occurredAt: SYNTH.t0,
    causationId: null,
    caseId: null,
    interactionId: null,
    reviewId: "rvw_synthReview000000001",
    subject: { kind: "SCENARIO", ref: "scn_billing_statement_explain_baseline", version: "1" },
    reviewer: { kind: "human", staffId: SYNTH.reviewerStaffId, role: "supervisor", qualification: null },
    labels: [{ key: "quality.clarity", value: "ACCEPTABLE", severity: "NONE" }],
    verdict: "PASS",
    disagreesWith: [],
    rubricRef: "docs/evaluation/rubric-v1",
    signedAt: at(60_000),
    signature: { keyRef: "local-fixture:reviewer-key", value: "c3ludGhldGljLXJldmlldy1zaWc" },
  };
}

export function datasetItem(): DatasetItem {
  return {
    schemaVersion: "dataset-item.v1",
    tenantId: SYNTH.tenantId,
    occurredAt: SYNTH.t0,
    dataClassification: "INTERNAL",
    causationId: null,
    expiresAt: null,
    itemId: "dsi_synthDatasetItem0001",
    datasetRef: "eval-billing@1",
    split: "development",
    familyKey: "billing_statement_explain:acct_a",
    provenance: "SYNTHETIC",
    licenseRef: null,
    consentRef: null,
    purpose: "evaluation",
    minimizationApplied: true,
    leakageCheckRef: "evidence/evaluation/leakage-1",
    contentRef: "scenarios/dev/billing_statement_explain_baseline",
    contentDigest: digestOf("dataset-content"),
    reviewRefs: [],
  };
}

export function longHorizonPlan(): LongHorizonPlan {
  return {
    schemaVersion: "long-horizon-plan.v1",
    tenantId: SYNTH.tenantId,
    caseId: SYNTH.caseId,
    workflowId: SYNTH.workflowId,
    occurredAt: SYNTH.t0,
    causationId: null,
    subjectRef: SYNTH.subjectRef,
    planId: "pln_synthPlan00000000001",
    revision: 1,
    supersedesRevision: null,
    policySnapshotVersion: "policy-2026-10-17.1",
    authorityCeiling: { grantRef: "grt_synthGrant0000000001", permittedActions: ["billing.review.commit"] },
    steps: [
      { stepId: "stp_collect", kind: "READ", capability: "billing.statements", action: null, ownerQueue: "q_billing", deadline: at(86_400_000), retryBudget: 2, attempts: 0, dependsOn: [], state: "IN_PROGRESS" },
      { stepId: "stp_submit", kind: "COMMIT_ACTION", capability: "billing.dispute_review", action: "billing.review.commit", ownerQueue: "q_billing", deadline: at(3 * 86_400_000), retryBudget: 1, attempts: 0, dependsOn: ["stp_collect"], state: "PENDING" },
    ],
    caseOwnerQueue: "q_billing",
    nextActionStepId: "stp_collect",
    lastVerifiedProgressAt: null,
  };
}

export function tenantConfig(): Omit<TenantConfig, "configDigest"> {
  return {
    schemaVersion: "tenant-config.v1",
    tenantId: SYNTH.tenantId,
    occurredAt: SYNTH.t0,
    causationId: null,
    configVersion: 3,
    status: "PUBLISHED",
    label: "Synthetic Behavioral Health Group",
    businessTimeZone: "America/Chicago",
    locales: ["en-US", "es-US"],
    jurisdictions: ["US", "US-IL"],
    regions: { primary: "us-east-1", secondary: "us-west-2", usOnly: true },
    processingPurposes: ["support_administration", "safety_routing", "human_handoff"],
    retentionDays: { TRANSIENT_CONVERSATION: null, BUSINESS_RECORD: null, RESTRICTED_QA_MEDIA: null, SECURITY_AUDIT: null },
    retentionPolicyRef: null,
    connectorProfileRefs: ["cnp_synthProfileSched001"],
    enabledCapabilities: ["scheduling.appointments_read"],
    escalationDestinations: ["dst_standard_support", "dst_safety_priority"],
    approvalsRequired: ["PHI_PROCESSING"],
    publishedBy: SYNTH.staffId,
    reviewedBy: SYNTH.reviewerStaffId,
  };
}

export function confirmationReceipt(): ConfirmationReceipt {
  return {
    schemaVersion: "confirmation-receipt.v1",
    tenantId: SYNTH.tenantId,
    actorRef: SYNTH.actorRef,
    sessionGeneration: 1,
    turnId: SYNTH.turnId,
    expiresAt: at(120_000),
    causationId: null,
    receiptId: "cfr_synthConfirmation001",
    actionId: "act_synthAction000000001",
    digest: digestOf("prepared-action"),
    sessionRef: SYNTH.sessionRef,
    method: "dtmf_keypress",
    capturedBy: "telephony-control",
    capturedAt: SYNTH.t0,
    auditEventId: "aud_synthAudit000000001",
  };
}

export function actionGrant(): ActionGrant {
  return {
    schemaVersion: "action-grant.v1",
    tenantId: SYNTH.tenantId,
    subjectRef: SYNTH.subjectRef,
    occurredAt: SYNTH.t0,
    expiresAt: at(14 * 86_400_000),
    actorRef: SYNTH.actorRef,
    caseId: SYNTH.caseId,
    workflowId: SYNTH.workflowId,
    causationId: null,
    grantId: "grt_synthGrant0000000001",
    purpose: "durable_follow_up",
    permittedActions: ["billing.review.commit"],
    preparedActionDigest: null,
    parameterBounds: [{ kind: "MAX_MONEY", field: "disputedAmount", max: { currency: "USD", minorUnits: 50_000 } }],
    maxUses: 1,
    usesConsumed: 0,
    sourceRef: "SR-7KQM-W4XP",
    approvalEvidenceRef: null,
    revokedAt: null,
    revocationReason: null,
  };
}

export function humanTask(): HumanTask {
  return {
    schemaVersion: "human-task.v1",
    tenantId: SYNTH.tenantId,
    workflowId: SYNTH.workflowId,
    occurredAt: SYNTH.t0,
    expiresAt: at(2 * 86_400_000),
    caseId: SYNTH.caseId,
    causationId: null,
    taskId: "tsk_synthTask0000000001",
    taskType: "billing.dispute_review",
    requiredStaffRoles: ["supervisor"],
    ownerQueue: "q_billing",
    status: "OPEN",
    decision: null,
    decidedBy: null,
    decidedAt: null,
  };
}

export function toolRequestV2(args: Record<string, unknown> = { appointmentId: "apt_synthAveryAppt000001" }): ToolRequestV2 {
  return {
    schemaVersion: "tool-request.v2",
    tenantId: SYNTH.tenantId,
    interactionId: SYNTH.interactionId,
    sessionGeneration: 1,
    causationId: "mdec_synthDecision00001",
    requestId: SYNTH.requestId,
    tool: { name: "get_appointment_options", version: "1.0.0" },
    sessionRef: null,
    turnId: SYNTH.turnId,
    arguments: args,
    idempotencyKey: null,
    receivedAt: SYNTH.t0,
  };
}

export function issueOutcome(overrides: Partial<IssueOutcomeRecord> = {}): IssueOutcomeRecord {
  return { outcome: "RESOLVED_WITH_EVIDENCE", reopened: false, partiallyResolved: false, evidenceRefs: ["efv_synthVerification001"], recordedAt: SYNTH.t0, ...overrides };
}

export function consentDimension(overrides: Partial<ConsentDimensionState> = {}): ConsentDimensionState {
  return { value: "GRANTED", expiresAt: null, capturedAt: SYNTH.t0, capturedBy: "studio_flow", templateVersion: "disclosure-en-1", evidenceRef: null, ...overrides };
}
