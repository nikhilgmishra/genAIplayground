/**
 * Every boundary rule of the protocol has a test (WP-02 refix). Each follow-on contract enforces
 * its safety rules in a superRefine that reports a stable code (e.g. RECORD_FROM_OTHER_TENANT,
 * PLAN_HOLDS_VERIFICATION_SECRET, FIXTURE_CREDENTIAL_FOR_PRODUCTION_WRITES). This file holds one
 * adversarial case per rule: a valid SYNTHETIC instance with the single change the rule forbids,
 * which must be refused WITH that code. A coverage test scans the protocol sources for every code
 * a rule can emit and fails when a rule has no case here, so a rule can be neither deleted nor
 * added without a test noticing.
 *
 * In-memory zod validation of the real contract schemas; SYNTHETIC values only
 * (fixtures/contracts.fixture.ts).
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { ActivationRecord, ActivationReport } from "./activation.js";
import { ActionGrant, ConfirmationReceipt } from "./actions.js";
import { ProcessingBasis } from "./auth.js";
import { CallBinding } from "./call-binding.js";
import { CapabilityStatus, ConsentDimensionState, IssueOutcomeRecord, TimeRange } from "./common.js";
import { CapabilityEvidence, ConnectorProfile } from "./connector.js";
import { ContextFact, SourceWatermark } from "./context-facts.js";
import { ContextSnapshot } from "./context-snapshot.js";
import { CaseLink, EffectVerification } from "./effects.js";
import { IdentityLink, PersonRoleAssignment } from "./identity-link.js";
import { CanarySpec, ChangeProposal } from "./improvement.js";
import { KnowledgeCitation } from "./knowledge.js";
import { AudioReleaseReceipt, CarrierEvent, SpeechPlan, TurnEnvelope } from "./media.js";
import { ModelDecision, ModelInvocation } from "./models.js";
import { LongHorizonPlan } from "./plan.js";
import { StatusAxes } from "./release.js";
import { DatasetItem, ReviewRecord } from "./review.js";
import { SupportRequest } from "./support.js";
import { TenantConfig } from "./tenant.js";
import { ToolRequestV2, ToolResultFreshness } from "./tool-envelope.js";
import { HumanTask } from "./workflow.js";
import * as F from "./fixtures/contracts.fixture.js";

const S = F.SYNTH;
const DAY = 86_400_000;

/* ---- valid SYNTHETIC bases not provided by the shared fixture ---------------------------- */

const supportRequest = () => ({
  supportRequestId: S.caseId,
  referenceNumber: "SR-7KQM-W4XP",
  tenantId: S.tenantId,
  interactionExternalId: "int_synthInteraction0001",
  issueExternalId: "iss_synthIssue0000000001",
  audience: "client",
  subjectRef: S.subjectRef,
  issueCategory: "billing_question",
  disposition: "REQUEST_ACCEPTED",
  ownerQueue: "q_billing",
  priority: "P3_STANDARD",
  summary: "Billing question; follow-up accepted.",
  summaryProvenance: "template_assembled",
  attempted: [],
  commitReceiptIds: [],
  sourceCallIds: [S.interactionId],
  language: "en",
  consent: { recording: "GRANTED", automatedProcessing: "GRANTED", disclosureTemplateVersion: "disclosure-en-1", capturedAt: S.t0, capturedBy: "studio_flow" },
  nextStep: null,
  deadline: null,
  versions: { agentConfig: "agent-1", model: "model-1", voice: "voice-1", promptTemplates: "prompts-1", policyBundle: "policy-1", toolCatalog: F.digestOf("catalog"), knowledgeSnapshot: "kb-1", schema: "2026-10-17.1" },
  restricted: false,
  syncState: "SYNCED",
  salesforceCaseId: null,
  caseLinks: [F.caseLink()],
  createdAt: S.t0,
  updatedAt: S.t0,
});
const capabilityStatus = () => ({ capabilityId: "platform.contracts", software: "IMPLEMENTED", environment: "NOT_CONFIGURED", qualification: "NOT_RUN", evidenceRefs: [] as string[], activationInputs: [] });
const statusAxes = () => ({ software: "IMPLEMENTED", environment: "NOT_CONFIGURED", qualification: "NOT_RUN", evidenceRefs: [] as string[], legacyReleaseStatus: null });
const connectorProfile = () => ({ ...F.connectorProfile(), configDigest: F.digestOf("connector-profile") });
const tenantConfig = () => ({ ...F.tenantConfig(), configDigest: F.digestOf("tenant-config") });
const freshness = () => ({ observedAt: S.t0, maxAgeMs: 60_000, sources: [{ system: "billing", watermarkId: "wmk_synthWatermarkBill01", sourceUpdatedAt: F.at(-5_000), ageMs: 5_000 }], stale: false });
const readOp = () => F.connectorProfile().operations[0]!;
const writeOp = (over: object = {}) => ({ operationId: "appointments.create", kind: "WRITE", enabled: true, method: "POST", pathTemplate: "/appointments", idempotency: "IDEMPOTENCY_KEY_HEADER", reconcileOperationId: null, ...over });
const promotedAuthorityChange = (over: object = {}) => {
  const cp = F.changeProposal();
  return {
    ...cp,
    authoredBy: { kind: "staff", ref: "stf_synthPolicyAuthor01" },
    changes: [{ ...cp.changes[0]!, target: "POLICY_BUNDLE" }],
    state: "PROMOTED",
    reviewRefs: ["rvw_synthReview000000001"],
    governanceReviewRef: "rvw_synthGovernance00001",
    tests: cp.tests.map((t) => ({ ...t, result: "PASS" })),
    ...over,
  };
};
const processingBasis = () => ({ basis: "HIPAA_TREATMENT_PAYMENT_OPERATIONS", purpose: "support_administration", jurisdiction: "US-IL", approvalRef: "apr_synthMatrix0001", establishedAt: S.t0, source: "policy_matrix" });
/** A plan variant with a placeholder digest (sealSpeechPlan would refuse an invalid plan before sealing it). */
const planVariant = (over: object) => ({ ...F.unsealedSpeechPlan(), ...over, outputDecisionDigest: F.digestOf("plan-under-test") });
const paraphrase = (text: string, maxChars: number) => ({ kind: "BOUNDED_PARAPHRASE", paraphrasePolicyId: "billing.explain", text, maxChars, allowedSourceRefs: ["billing/invoices/inv_synthInvoice0000001"] });

/* ---- the rule table ------------------------------------------------------------------------ */

interface RuleCase {
  /** Protocol source file whose rule emits `code`. */
  readonly file: string;
  readonly code: string;
  readonly schema: z.ZodType;
  readonly input: () => unknown;
}
const R = (file: string, code: string, schema: z.ZodType, input: () => unknown): RuleCase => ({ file, code, schema, input });

/** Valid bases: each must parse, so a refused variant is refused for its one change. */
const VALID: readonly [string, z.ZodType, () => unknown][] = [
  ["ActionGrant", ActionGrant, F.actionGrant],
  ["ActivationRecord", ActivationRecord, () => F.activationRecord()],
  ["ActivationReport", ActivationReport, F.activationReport],
  ["AudioReleaseReceipt", AudioReleaseReceipt, F.audioReleaseReceipt],
  ["CallBinding", CallBinding, F.callBinding],
  ["CanarySpec", CanarySpec, F.canarySpec],
  ["CapabilityEvidence", CapabilityEvidence, F.capabilityEvidence],
  ["CapabilityStatus", CapabilityStatus, capabilityStatus],
  ["CarrierEvent", CarrierEvent, F.carrierEvent],
  ["CaseLink", CaseLink, () => F.caseLink()],
  ["ChangeProposal", ChangeProposal, F.changeProposal],
  ["ChangeProposal(authority, promoted)", ChangeProposal, () => promotedAuthorityChange()],
  ["ConfirmationReceipt", ConfirmationReceipt, F.confirmationReceipt],
  ["ConnectorProfile", ConnectorProfile, connectorProfile],
  ["ConsentDimensionState", ConsentDimensionState, () => F.consentDimension()],
  ["ContextFact", ContextFact, F.contextFact],
  ["ContextSnapshot", ContextSnapshot, F.contextSnapshot],
  ["DatasetItem", DatasetItem, F.datasetItem],
  ["EffectVerification", EffectVerification, F.effectVerification],
  ["HumanTask", HumanTask, F.humanTask],
  ["IdentityLink", IdentityLink, F.identityLink],
  ["IssueOutcomeRecord", IssueOutcomeRecord, () => F.issueOutcome()],
  ["KnowledgeCitation", KnowledgeCitation, F.knowledgeCitation],
  ["LongHorizonPlan", LongHorizonPlan, F.longHorizonPlan],
  ["ModelDecision", ModelDecision, () => F.modelDecision()],
  ["ModelInvocation", ModelInvocation, F.modelInvocation],
  ["PersonRoleAssignment", PersonRoleAssignment, () => F.personRoleAssignment("client", "Client00001")],
  ["ProcessingBasis", ProcessingBasis, processingBasis],
  ["ReviewRecord", ReviewRecord, F.reviewRecord],
  ["SourceWatermark", SourceWatermark, F.sourceWatermark],
  ["SpeechPlan", SpeechPlan, F.speechPlan],
  ["StatusAxes", StatusAxes, statusAxes],
  ["SupportRequest", SupportRequest, supportRequest],
  ["TenantConfig", TenantConfig, tenantConfig],
  ["TimeRange", TimeRange, () => ({ from: S.t0, to: F.at(DAY) })],
  ["ToolRequestV2", ToolRequestV2, () => F.toolRequestV2()],
  ["ToolResultFreshness", ToolResultFreshness, freshness],
  ["TurnEnvelope", TurnEnvelope, F.turnEnvelope],
];

const RULE_CASES: readonly RuleCase[] = [
  /* actions.ts */
  R("actions.ts", "CONFIRMATION_EXPIRY_NOT_AFTER_CAPTURE", ConfirmationReceipt, () => ({ ...F.confirmationReceipt(), expiresAt: S.t0 })),
  R("actions.ts", "GRANT_EXPIRY_NOT_AFTER_ISSUE", ActionGrant, () => ({ ...F.actionGrant(), expiresAt: S.t0 })),
  R("actions.ts", "GRANT_USES_EXCEEDED", ActionGrant, () => ({ ...F.actionGrant(), maxUses: 1, usesConsumed: 2 })),
  R("actions.ts", "REVOCATION_REASON_MISMATCH", ActionGrant, () => ({ ...F.actionGrant(), revokedAt: F.at(1_000) })),
  R("actions.ts", "EMPTY_TIME_WINDOW", ActionGrant, () => ({ ...F.actionGrant(), parameterBounds: [{ kind: "TIME_WINDOW", field: "startsAt", from: F.at(DAY), to: F.at(DAY) }] })),
  R("actions.ts", "DUPLICATE_PARAMETER_BOUND", ActionGrant, () => {
    const g = F.actionGrant();
    return { ...g, parameterBounds: [...g.parameterBounds, { kind: "MAX_MONEY", field: "disputedAmount", max: { currency: "USD", minorUnits: 90_000 } }] };
  }),

  /* auth.ts */
  R("auth.ts", "PROCESSING_BASIS_WITHOUT_APPROVAL", ProcessingBasis, () => ({ ...processingBasis(), basis: "HIPAA_AUTHORIZATION", approvalRef: null })),
  R("auth.ts", "UNKNOWN_BASIS_WITH_APPROVAL", ProcessingBasis, () => ({ ...processingBasis(), basis: "UNKNOWN" })),
  R("auth.ts", "BASIS_FOR_UNKNOWN_JURISDICTION", ProcessingBasis, () => ({ ...processingBasis(), jurisdiction: "UNKNOWN" })),

  /* activation.ts */
  R("activation.ts", "ELIGIBLE_WITHOUT_QUALIFICATION_PASS", ActivationRecord, () => F.activationRecord({ state: "ELIGIBLE", missingInputs: [], approvalsRequired: [], reasonCodes: [] })),
  R("activation.ts", "ELIGIBLE_WITH_MISSING_INPUTS", ActivationRecord, () => F.activationRecord({ state: "ELIGIBLE" })),
  R("activation.ts", "ELIGIBLE_WITH_MISSING_APPROVALS", ActivationRecord, () => F.activationRecord({ state: "ELIGIBLE" })),
  R("activation.ts", "ELIGIBLE_WITHOUT_SOFTWARE", ActivationRecord, () => F.activationRecord({ state: "ELIGIBLE", software: "MISSING" })),
  R("activation.ts", "ACTIVE_BELOW_APPROVED_PILOT", ActivationRecord, () => F.activationRecord({ state: "ACTIVE" })),
  R("activation.ts", "NOT_ELIGIBLE_WITHOUT_REASON", ActivationRecord, () => F.activationRecord({ missingInputs: [], approvalsRequired: [], reasonCodes: [] })),
  R("activation.ts", "SUMMARY_DOES_NOT_MATCH_RECORDS", ActivationReport, () => ({ ...F.activationReport(), summary: { active: 1, eligible: 0, notEligible: 0, suspended: 0, deactivated: 0 } })),
  R("activation.ts", "DUPLICATE_CAPABILITY_RECORD", ActivationReport, () => ({
    ...F.activationReport(),
    records: [F.activationRecord(), F.activationRecord({ recordId: "acr_synthActivation00002" })],
    summary: { active: 0, eligible: 0, notEligible: 2, suspended: 0, deactivated: 0 },
  })),
  R("activation.ts", "RECORD_FROM_OTHER_TENANT", ActivationReport, () => ({ ...F.activationReport(), records: [F.activationRecord({ tenantId: S.otherTenantId })] })),

  /* call-binding.ts */
  R("call-binding.ts", "BINDING_EXPIRY_NOT_AFTER_ISSUE", CallBinding, () => ({ ...F.callBinding(), expiresAt: S.t0 })),
  R("call-binding.ts", "BINDING_SUPERSEDES_ITSELF", CallBinding, () => ({ ...F.callBinding(), supersedesBindingId: "cbd_synthBinding00000001" })),

  /* common.ts: time ranges, outcomes, consent and the two status axes (three contracts share statusAxesIssues) */
  R("common.ts", "TIME_RANGE_NOT_INCREASING", TimeRange, () => ({ from: S.t0, to: S.t0 })),
  R("common.ts", "TIME_RANGE_TOO_WIDE", TimeRange, () => ({ from: S.t0, to: F.at(400 * DAY) })),
  R("common.ts", "OUTCOME_EVIDENCE_REQUIRED", IssueOutcomeRecord, () => F.issueOutcome({ evidenceRefs: [] })),
  R("common.ts", "PARTIAL_RESOLUTION_IS_NOT_RESOLVED", IssueOutcomeRecord, () => F.issueOutcome({ partiallyResolved: true })),
  R("common.ts", "GRANT_WITHOUT_CAPTURE", ConsentDimensionState, () => F.consentDimension({ capturedAt: null })),
  R("common.ts", "EXPIRY_NOT_AFTER_CAPTURE", ConsentDimensionState, () => F.consentDimension({ expiresAt: S.t0 })),
  R("common.ts", "PASS_WITHOUT_EVIDENCE", CapabilityStatus, () => ({ ...capabilityStatus(), qualification: "PASS" })),
  R("common.ts", "VERIFIED_WITHOUT_EVIDENCE", CapabilityStatus, () => ({ ...capabilityStatus(), software: "VERIFIED_LOCAL" })),
  R("common.ts", "ENVIRONMENT_VERIFIED_WITHOUT_SOFTWARE", CapabilityStatus, () => ({ ...capabilityStatus(), software: "MISSING", environment: "VERIFIED_SANDBOX", qualification: "PASS", evidenceRefs: ["evidence/q-1"] })),
  R("common.ts", "ENVIRONMENT_VERIFIED_WITHOUT_EVIDENCE", CapabilityStatus, () => ({ ...capabilityStatus(), environment: "VERIFIED_PRODUCTION", qualification: "NOT_RUN" })),
  R("common.ts", "ENVIRONMENT_VERIFIED_WITHOUT_QUALIFICATION_PASS", CapabilityStatus, () => ({ ...capabilityStatus(), environment: "VERIFIED_PRODUCTION", qualification: "FAIL", evidenceRefs: ["evidence/q-1"] })),
  R("common.ts", "ENVIRONMENT_VERIFIED_WITHOUT_QUALIFICATION_PASS", StatusAxes, () => ({ ...statusAxes(), environment: "VERIFIED_PRODUCTION", qualification: "FAIL", evidenceRefs: ["evidence/q-1"] })),
  R("common.ts", "ENVIRONMENT_VERIFIED_WITHOUT_EVIDENCE", StatusAxes, () => ({ ...statusAxes(), environment: "VERIFIED_SANDBOX", qualification: "INCONCLUSIVE", legacyReleaseStatus: "VERIFIED_SANDBOX" })),
  R("common.ts", "ENVIRONMENT_VERIFIED_WITHOUT_QUALIFICATION_PASS", ActivationRecord, () => F.activationRecord({ state: "SUSPENDED", environment: "VERIFIED_PRODUCTION", qualification: "FAIL", evidenceRefs: ["evidence/q-2"] })),
  R("common.ts", "VERIFIED_WITHOUT_EVIDENCE", ActivationRecord, () => F.activationRecord({ software: "RELEASE_PACKAGE_VERIFIED" })),

  /* connector.ts */
  R("connector.ts", "VENDOR_EVIDENCE_FIXTURE_KEY", CapabilityEvidence, () => ({
    ...F.capabilityEvidence(),
    level: "VENDOR_SANDBOX_PASS",
    signature: { signerRole: "integration_owner", keyRef: "local-fixture:vendor-signing", algorithm: "ED25519", value: "c2lnbmF0dXJlLXN5bnRoZXRpYw", signedAt: S.t0 },
  })),
  R("connector.ts", "WRITE_OVER_GET", ConnectorProfile, () => ({ ...connectorProfile(), writeMode: "SANDBOX_WRITE", accountBinding: { externalAccountRef: "acct-synthetic-001", tenantBindingVerified: true }, operations: [readOp(), writeOp({ method: "GET" })] })),
  R("connector.ts", "NON_IDEMPOTENT_WRITE_WITHOUT_RECONCILE", ConnectorProfile, () => ({ ...connectorProfile(), operations: [readOp(), writeOp({ enabled: false, idempotency: "NOT_IDEMPOTENT_RECONCILE_REQUIRED" })] })),
  R("connector.ts", "PROHIBITED_FIELD_AUTHORITATIVE", ConnectorProfile, () => ({ ...connectorProfile(), mappings: [{ ...F.connectorProfile().mappings[1]!, authoritative: true }] })),
  R("connector.ts", "VERIFICATION_SECRET_MAPPED", ConnectorProfile, () => ({ ...connectorProfile(), mappings: [{ ...F.connectorProfile().mappings[0]!, classification: "VERIFICATION_SECRET" }] })),
  R("connector.ts", "BASE_URL_HOST_NOT_ALLOWED", ConnectorProfile, () => ({ ...connectorProfile(), baseUrl: "https://other.example.invalid/api/v1" })),
  R("connector.ts", "DUPLICATE_ALLOWED_HOST", ConnectorProfile, () => ({ ...connectorProfile(), allowedHosts: ["scheduling.example.invalid", "scheduling.example.invalid"] })),
  R("connector.ts", "DUPLICATE_OPERATION", ConnectorProfile, () => ({ ...connectorProfile(), operations: [readOp(), readOp()] })),
  R("connector.ts", "WRITE_ENABLED_ON_READ_ONLY_PROFILE", ConnectorProfile, () => ({ ...connectorProfile(), operations: [readOp(), writeOp()] })),
  R("connector.ts", "UNKNOWN_RECONCILE_OPERATION", ConnectorProfile, () => ({ ...connectorProfile(), operations: [{ ...readOp(), reconcileOperationId: "appointments.lookup" }] })),
  R("connector.ts", "WRITES_WITHOUT_VERIFIED_ACCOUNT_BINDING", ConnectorProfile, () => ({ ...connectorProfile(), writeMode: "SANDBOX_WRITE" })),
  R("connector.ts", "FIXTURE_CREDENTIAL_FOR_PRODUCTION_WRITES", ConnectorProfile, () => ({
    ...connectorProfile(),
    writeMode: "PRODUCTION_WRITE",
    credentialRef: "local-fixture:scheduling-writer",
    accountBinding: { externalAccountRef: "acct-synthetic-001", tenantBindingVerified: true },
  })),
  R("connector.ts", "EVIDENCE_EXPIRY_NOT_AFTER_RUN", CapabilityEvidence, () => ({ ...F.capabilityEvidence(), expiresAt: S.t0 })),
  R("connector.ts", "VENDOR_EVIDENCE_UNSIGNED", CapabilityEvidence, () => ({ ...F.capabilityEvidence(), level: "VENDOR_SANDBOX_PASS" })),
  R("connector.ts", "PASS_WITH_FAILED_STEP", CapabilityEvidence, () => {
    const e = F.capabilityEvidence();
    return { ...e, steps: [e.steps[0]!, { ...e.steps[1]!, result: "FAIL" }] };
  }),
  R("connector.ts", "DUPLICATE_STEP", CapabilityEvidence, () => {
    const e = F.capabilityEvidence();
    return { ...e, steps: [e.steps[0]!, e.steps[0]!] };
  }),

  /* context-facts.ts */
  R("context-facts.ts", "FACT_HOLDS_VERIFICATION_SECRET", ContextFact, () => ({ ...F.contextFact(), dataClassification: "VERIFICATION_SECRET" })),
  R("context-facts.ts", "PHI_FACT_WITHOUT_SUBJECT", ContextFact, () => ({ ...F.contextFact(), dataClassification: "PHI", subjectRef: null })),
  R("context-facts.ts", "EFFECTIVE_INTERVAL_EMPTY", ContextFact, () => ({ ...F.contextFact(), effectiveUntil: F.at(-DAY) })),
  R("context-facts.ts", "SOURCE_ONLY_FACT_NOT_SOURCE_VERIFIED", ContextFact, () => ({ ...F.contextFact(), factType: "identity.portal_account.active", verification: "CALLER_REPORTED", authorityRank: 10 })),
  R("context-facts.ts", "INFERRED_FACT_WITHOUT_SUPPORT", ContextFact, () => ({ ...F.contextFact(), verification: "INFERRED", authorityRank: 10 })),
  R("context-facts.ts", "UNVERIFIED_FACT_OUTRANKS_SOURCES", ContextFact, () => ({ ...F.contextFact(), verification: "STAFF_ENTERED" })),
  R("context-facts.ts", "RETRACTION_REASON_MISMATCH", ContextFact, () => ({ ...F.contextFact(), lineage: { supersedes: null, correctionOf: null, retracted: true, retractionReason: null } })),
  R("context-facts.ts", "FACT_SUPERSEDES_ITSELF", ContextFact, () => ({ ...F.contextFact(), lineage: { supersedes: "fct_synthFactBalance0001", correctionOf: null, retracted: false, retractionReason: null } })),
  R("context-facts.ts", "HIGH_WATERMARK_BEFORE_LOW", SourceWatermark, () => ({ ...F.sourceWatermark(), high: { offset: "1042", eventTime: F.at(-8 * DAY) } })),
  R("context-facts.ts", "MISSING_EVENTS_REPORTED_AS_NO_GAP", SourceWatermark, () => ({ ...F.sourceWatermark(), deliveredCount: 40 })),
  R("context-facts.ts", "WATERMARK_EVIDENCE_AFTER_RECORD", SourceWatermark, () => ({ ...F.sourceWatermark(), lastHeartbeatAt: "2030-01-01T00:00:00.000Z" })),

  /* context-snapshot.ts */
  R("context-snapshot.ts", "RETRACTED_FACT_IN_SNAPSHOT", ContextSnapshot, () => {
    const s = F.contextSnapshot();
    return { ...s, facts: [{ ...s.facts[0]!, lineage: { ...s.facts[0]!.lineage, retracted: true, retractionReason: "SOURCE_CORRECTED" } }] };
  }),
  R("context-snapshot.ts", "EXPIRED_FACT_IN_SNAPSHOT", ContextSnapshot, () => {
    const s = F.contextSnapshot();
    return { ...s, facts: [{ ...s.facts[0]!, expiresAt: F.at(-1_000) }] };
  }),
  R("context-snapshot.ts", "SNAPSHOT_EXPIRY_NOT_AFTER_ASSEMBLY", ContextSnapshot, () => ({ ...F.contextSnapshot(), expiresAt: S.t0 })),
  R("context-snapshot.ts", "VERIFICATION_SECRET_CEILING", ContextSnapshot, () => {
    const s = F.contextSnapshot();
    return { ...s, scope: { ...s.scope, classificationCeiling: "VERIFICATION_SECRET" } };
  }),
  R("context-snapshot.ts", "FACT_FROM_OTHER_TENANT", ContextSnapshot, () => ({ ...F.contextSnapshot(), facts: [{ ...F.contextFact(), tenantId: S.otherTenantId }] })),
  R("context-snapshot.ts", "FACT_FOR_OTHER_SUBJECT", ContextSnapshot, () => ({ ...F.contextSnapshot(), facts: [{ ...F.contextFact(), subjectRef: S.otherSubjectRef }] })),
  R("context-snapshot.ts", "SUBJECT_DATA_WITHOUT_SUBJECT", ContextSnapshot, () => ({ ...F.contextSnapshot(), facts: [{ ...F.contextFact(), subjectRef: null }] })),
  R("context-snapshot.ts", "FACT_ABOVE_CLASSIFICATION_CEILING", ContextSnapshot, () => ({ ...F.contextSnapshot(), facts: [{ ...F.contextFact(), dataClassification: "PHI" }] })),
  R("context-snapshot.ts", "FACT_PURPOSE_NOT_ALLOWED", ContextSnapshot, () => ({ ...F.contextSnapshot(), facts: [{ ...F.contextFact(), allowedPurposes: ["evaluation"] }] })),
  R("context-snapshot.ts", "SUMMARY_CLAIM_WITHOUT_FACT", ContextSnapshot, () => {
    const s = F.contextSnapshot();
    return { ...s, timelineSummary: { ...s.timelineSummary!, supportingFactIds: ["fct_synthUnknownFact0001"] } };
  }),
  R("context-snapshot.ts", "CONFLICT_SELECTION_INVALID", ContextSnapshot, () => {
    const s = F.contextSnapshot();
    const conflict = { factType: "billing.balance", factIds: ["fct_synthFactBalance0001", "fct_synthFactBalance0002"], resolution: "AUTHORITATIVE_SOURCE_SELECTED", selectedFactId: null };
    return { ...s, coverage: { ...s.coverage, conflicts: [conflict] } };
  }),
  R("context-snapshot.ts", "COVERED_SOURCE_WITHOUT_WATERMARK", ContextSnapshot, () => {
    const s = F.contextSnapshot();
    return { ...s, coverage: { ...s.coverage, coveredSources: [{ system: "billing", watermarkId: "wmk_synthOtherWatermark1" }] } };
  }),
  R("context-snapshot.ts", "TRUNCATION_REASON_MISMATCH", ContextSnapshot, () => {
    const s = F.contextSnapshot();
    return { ...s, completeness: "PARTIAL", coverage: { ...s.coverage, truncated: true } };
  }),
  R("context-snapshot.ts", "PARTIAL_SNAPSHOT_LABELLED_COMPLETE", ContextSnapshot, () => {
    const s = F.contextSnapshot();
    return { ...s, coverage: { ...s.coverage, unavailableSources: [{ system: "claims", reasonCode: "SOURCE_TIMEOUT" }] } };
  }),
  // A covered source whose watermark reports a gap, an unverified silence or a reconciliation in
  // progress makes the snapshot partial (follow-on section 7: never label a partial snapshot COMPLETE).
  ...(["GAP_DETECTED", "SOURCE_SILENT_UNVERIFIED", "RECONCILING"] as const).map((gapState) =>
    R("context-snapshot.ts", "PARTIAL_SNAPSHOT_LABELLED_COMPLETE", ContextSnapshot, () => ({ ...F.contextSnapshot(), watermarks: [{ ...F.sourceWatermark(), gapState }] })),
  ),
  R("context-snapshot.ts", "WATERMARK_FROM_OTHER_TENANT", ContextSnapshot, () => ({ ...F.contextSnapshot(), watermarks: [{ ...F.sourceWatermark(), tenantId: S.otherTenantId }] })),
  R("context-snapshot.ts", "FACT_WATERMARK_NOT_IN_SNAPSHOT", ContextSnapshot, () => ({ ...F.contextSnapshot(), facts: [{ ...F.contextFact(), watermarkId: "wmk_synthOtherWatermark1" }] })),
  R("context-snapshot.ts", "COVERED_SOURCE_SYSTEM_MISMATCH", ContextSnapshot, () => {
    const s = F.contextSnapshot();
    return { ...s, coverage: { ...s.coverage, coveredSources: [{ system: "claims", watermarkId: "wmk_synthWatermarkBill01" }] } };
  }),

  /* effects.ts */
  R("effects.ts", "VERIFIED_WITHOUT_SOURCE_EVENT", EffectVerification, () => {
    const e = F.effectVerification();
    return { ...e, method: "TRUSTED_COMPLETION_EVENT", observed: { ...e.observed!, sourceEventRef: null } };
  }),
  R("effects.ts", "VERIFIED_WITHOUT_MATCHING_OBSERVATION", EffectVerification, () => {
    const v = F.effectVerification();
    return { ...v, observed: { ...v.observed!, stateDigest: F.digestOf("other-state") } };
  }),
  R("effects.ts", "VERIFIED_WITH_VERSION_MISMATCH", EffectVerification, () => {
    const v = F.effectVerification();
    return { ...v, observed: { ...v.observed!, version: "7" } };
  }),
  R("effects.ts", "HUMAN_ATTESTATION_IS_NOT_SOURCE_VERIFICATION", EffectVerification, () => ({ ...F.effectVerification(), method: "HUMAN_ATTESTATION" })),
  R("effects.ts", "MISMATCH_WITHOUT_DIFFERING_OBSERVATION", EffectVerification, () => ({ ...F.effectVerification(), result: "MISMATCH" })),
  R("effects.ts", "NOT_FOUND_WITHOUT_VISIBILITY_WINDOW", EffectVerification, () => ({ ...F.effectVerification(), result: "NOT_FOUND_WITHIN_WINDOW", observed: null })),
  R("effects.ts", "NOT_FOUND_IS_NOT_DEFINITIVE_INSIDE_WINDOW", EffectVerification, () => ({ ...F.effectVerification(), result: "NOT_FOUND_AFTER_WINDOW", visibilityWindowEndsAt: F.at(60_000) })),
  R("effects.ts", "WINDOW_ALREADY_CLOSED", EffectVerification, () => ({ ...F.effectVerification(), result: "NOT_FOUND_WITHIN_WINDOW", visibilityWindowEndsAt: F.at(1_000) })),
  R("effects.ts", "SYNCED_WITHOUT_EXTERNAL_RECORD", CaseLink, () => ({ ...F.caseLink(), externalCaseRef: null })),
  R("effects.ts", "RELATED_LINK_WITHOUT_CASE", CaseLink, () => ({ ...F.caseLink(), kind: "RELATED_CASE" })),
  R("effects.ts", "CASE_LINKED_TO_ITSELF", CaseLink, () => ({ ...F.caseLink(), kind: "REOPENED_FROM", relatedCaseId: S.caseId })),

  /* identity-link.ts */
  R("identity-link.ts", "ELIGIBLE_LINK_FROM_ANALYTICS", IdentityLink, () => ({ ...F.identityLink(), verificationSource: "analytics" })),
  R("identity-link.ts", "NON_AUTHORITATIVE_LINK_ELIGIBLE", IdentityLink, () => ({ ...F.identityLink(), basis: "PROBABILISTIC_MATCH" })),
  R("identity-link.ts", "ELIGIBLE_LINK_UNVERIFIED", IdentityLink, () => ({ ...F.identityLink(), verifiedAt: null })),
  R("identity-link.ts", "MERGE_WITHOUT_REVIEW_EVIDENCE", IdentityLink, () => ({ ...F.identityLink(), basis: "STAFF_REVIEWED_MERGE" })),
  R("identity-link.ts", "ISSUER_ONLY_FOR_IDP_SUBJECT", IdentityLink, () => {
    const l = F.identityLink();
    return { ...l, linked: { ...l.linked, issuer: null } };
  }),
  R("identity-link.ts", "LINK_VALIDITY_EMPTY", IdentityLink, () => ({ ...F.identityLink(), validUntil: F.at(-30 * DAY) })),
  R("identity-link.ts", "LINEAGE_REFERS_TO_SELF", IdentityLink, () => ({ ...F.identityLink(), lineage: { supersedes: null, mergedFrom: [S.personRef], splitFrom: null } })),
  R("identity-link.ts", "ASSIGNMENT_VALIDITY_EMPTY", PersonRoleAssignment, () => ({ ...F.personRoleAssignment("client", "Client00001"), validUntil: F.at(-DAY) })),
  R("identity-link.ts", "ORGANIZATION_ROLE_WITHOUT_ORGANIZATION", PersonRoleAssignment, () => F.personRoleAssignment("provider", "Provider0001", null)),

  /* improvement.ts */
  R("improvement.ts", "VERIFIED_CAUSE_WITHOUT_EVIDENCE", ChangeProposal, () => ({ ...F.changeProposal(), suspectedCause: { statementCode: "RETRIEVAL_MISSES_FEE_ARTICLE", status: "VERIFIED_CAUSE", evidenceRefs: [] } })),
  R("improvement.ts", "PROMOTION_WITHOUT_HUMAN_REVIEW", ChangeProposal, () => {
    const cp = F.changeProposal();
    return { ...cp, state: "PROMOTED", tests: cp.tests.map((t) => ({ ...t, result: "PASS" })) };
  }),
  R("improvement.ts", "PROMOTION_WITH_REQUIRED_TEST_NOT_PASSED", ChangeProposal, () => ({ ...F.changeProposal(), state: "CANARY", reviewRefs: ["rvw_synthReview000000001"] })),
  R("improvement.ts", "AUTHORITY_CHANGE_WITHOUT_GOVERNANCE_REVIEW", ChangeProposal, () => promotedAuthorityChange({ governanceReviewRef: null })),
  R("improvement.ts", "GOVERNANCE_REVIEW_NOT_SEPARATE", ChangeProposal, () => promotedAuthorityChange({ governanceReviewRef: "rvw_synthReview000000001" })),
  R("improvement.ts", "OPTIMIZER_CANNOT_CHANGE_AUTHORITY", ChangeProposal, () => {
    const cp = F.changeProposal();
    return { ...cp, changes: [{ ...cp.changes[0]!, target: "PERMISSION_SET" }] };
  }),
  R("improvement.ts", "CANARY_EXPIRY_NOT_AFTER_START", CanarySpec, () => ({ ...F.canarySpec(), expiresAt: S.t0 })),
  R("improvement.ts", "CANARY_MUST_EXCLUDE_PROTECTED_BEHAVIOURS", CanarySpec, () => ({ ...F.canarySpec(), excludedBehaviours: ["CRISIS_INSTRUCTIONS", "CRISIS_INSTRUCTIONS", "CONSENT_CONTROLS"] })),

  /* knowledge.ts */
  R("knowledge.ts", "CITATION_VERSION_MISMATCH", KnowledgeCitation, () => ({ ...F.knowledgeCitation(), articleVersion: 4 })),
  R("knowledge.ts", "CITATION_EXPIRES_BEFORE_EFFECTIVE", KnowledgeCitation, () => ({ ...F.knowledgeCitation(), expiresAt: F.at(-10 * DAY) })),
  R("knowledge.ts", "PUBLIC_FAQ_WITHOUT_PUBLIC_AUDIENCE", KnowledgeCitation, () => ({ ...F.knowledgeCitation(), audiences: ["client"] })),

  /* media.ts: TurnEnvelope */
  R("media.ts", "TURN_HOLDS_VERIFICATION_SECRET", TurnEnvelope, () => ({ ...F.turnEnvelope(), dataClassification: "VERIFICATION_SECRET" })),
  R("media.ts", "DTMF_REACHED_TRANSCRIPT_OR_ASR", TurnEnvelope, () => ({ ...F.turnEnvelope(), inputKind: "DTMF_ISOLATED", dtmfCaptured: true })),
  R("media.ts", "INTERRUPTION_WITHOUT_DETAIL", TurnEnvelope, () => ({ ...F.turnEnvelope(), inputKind: "INTERRUPTION" })),
  R("media.ts", "SPEECH_ENDS_BEFORE_START", TurnEnvelope, () => {
    const t = F.turnEnvelope();
    return { ...t, timing: { ...t.timing, speechEndedAt: F.at(-1_000) } };
  }),
  /* media.ts: CarrierEvent */
  R("media.ts", "TRANSFER_EVENT_WITHOUT_TRANSFER", CarrierEvent, () => ({ ...F.carrierEvent(), transfer: null })),
  R("media.ts", "TRANSFER_DETAIL_ON_NON_TRANSFER_EVENT", CarrierEvent, () => ({ ...F.carrierEvent(), type: "CALL_STARTED" })),
  R("media.ts", "RECORDING_EVENT_WITHOUT_DETAIL", CarrierEvent, () => ({ ...F.carrierEvent(), type: "RECORDING_STARTED", transfer: null })),
  R("media.ts", "ACCEPTANCE_WITHOUT_RECEIVER", CarrierEvent, () => {
    const e = F.carrierEvent();
    return { ...e, transfer: { ...e.transfer!, receiverRef: null } };
  }),
  R("media.ts", "RECEIPT_CLOCK_MUST_EQUAL_RECEIVED_AT", CarrierEvent, () => ({ ...F.carrierEvent(), clockSource: "platform_receipt" })),
  /* media.ts: SpeechPlan */
  R("media.ts", "TEMPLATE_PLACEHOLDER_MISMATCH", SpeechPlan, () => {
    const p = F.speechPlan();
    return { ...p, segments: [{ ...p.segments[0]!, text: "Your current balance is {balance}." }] };
  }),
  R("media.ts", "PROTECTED_VALUE_OUTSIDE_SLOT", SpeechPlan, () =>
    planVariant({ protectedSlots: [], segments: [{ kind: "TEMPLATE_EXACT", templateId: "billing.balance_due", templateVersion: "1.0.0", text: "Your balance is 45 dollars.", slotNames: [] }] }),
  ),
  R("media.ts", "UNUSED_PROTECTED_SLOT", SpeechPlan, () => {
    const p = F.speechPlan();
    return { ...p, protectedSlots: [...p.protectedSlots, { kind: "COUNT", name: "openItems", value: 2, sourceRef: "billing/invoices/inv_synthInvoice0000001" }] };
  }),
  R("media.ts", "SPOKEN_SEGMENT_WITHOUT_SPEECH_RENDERER", SpeechPlan, () => ({ ...F.speechPlan(), allowedRenderers: ["fallback_clip"] })),
  R("media.ts", "CLIP_SEGMENT_WITHOUT_CLIP_RENDERER", SpeechPlan, () => {
    const p = F.speechPlan();
    return { ...p, allowedRenderers: ["controlled_tts"], segments: [...p.segments, { kind: "FALLBACK_CLIP", clipRef: "clip_billing_followup@v1", clipManifestDigest: F.digestOf("clips") }] };
  }),
  R("media.ts", "PLAN_EXPIRY_NOT_AFTER_ISSUE", SpeechPlan, () => ({ ...F.speechPlan(), expiresAt: S.t0 })),
  R("media.ts", "PROTECTED_CLASS_NOT_NATIVE", SpeechPlan, () => ({ ...F.speechPlan(), route: "NATIVE_ALLOWED" })),
  R("media.ts", "NATIVE_RENDERER_ON_CONTROLLED_ROUTE", SpeechPlan, () => ({ ...F.speechPlan(), allowedRenderers: ["native_buffer_checked"] })),
  R("media.ts", "PARAPHRASE_FOR_PROTECTED_CLASS", SpeechPlan, () => {
    const p = F.speechPlan();
    return { ...p, segments: [...p.segments, paraphrase("About forty-five dollars.", 80)] };
  }),
  R("media.ts", "PROTECTED_FACT_WITHOUT_AUTHORIZATION", SpeechPlan, () => ({ ...F.speechPlan(), authorizationRef: null })),
  R("media.ts", "PROTECTED_FACT_WITHOUT_SOURCE", SpeechPlan, () => ({ ...F.speechPlan(), sourceRefs: [] })),
  R("media.ts", "COMMITMENT_WITHOUT_RECEIPT", SpeechPlan, () => ({ ...F.speechPlan(), utteranceClass: "COMMITMENT" })),
  R("media.ts", "DUPLICATE_SLOT", SpeechPlan, () => {
    const p = F.speechPlan();
    return { ...p, protectedSlots: [...p.protectedSlots, p.protectedSlots[0]!] };
  }),
  R("media.ts", "UNDECLARED_SLOT", SpeechPlan, () => {
    const p = F.speechPlan();
    const seg = p.segments[0]!;
    return { ...p, segments: [{ ...seg, slotNames: seg.kind === "TEMPLATE_EXACT" ? [...seg.slotNames, "undeclared"] : [] }] };
  }),
  R("media.ts", "PARAPHRASE_TOO_LONG", SpeechPlan, () => ({ ...F.speechPlan(), utteranceClass: "LOW_RISK_GROUNDED", protectedSlots: [], segments: [paraphrase("Statements are mailed monthly.", 10)] })),
  R("media.ts", "PLAN_HOLDS_VERIFICATION_SECRET", SpeechPlan, () => ({ ...F.speechPlan(), dataClassification: "VERIFICATION_SECRET" })),
  /* media.ts: AudioReleaseReceipt */
  R("media.ts", "PLAN_RENDERED_AS_CLIP", AudioReleaseReceipt, () => ({ ...F.audioReleaseReceipt(), renderer: "fallback_clip" })),
  R("media.ts", "EMITTED_AFTER_FAILED_ENQUEUE_CHECK", AudioReleaseReceipt, () => ({ ...F.audioReleaseReceipt(), enqueueCheck: { ...F.passingCheck(2_900), digestVerified: false } })),
  R("media.ts", "EMITTED_WITHOUT_PASSING_EMISSION_CHECK", AudioReleaseReceipt, () => ({ ...F.audioReleaseReceipt(), emissionCheck: { ...F.passingCheck(3_000), notRevoked: false } })),
  R("media.ts", "EMITTED_WITHOUT_PLAYBACK", AudioReleaseReceipt, () => ({ ...F.audioReleaseReceipt(), playback: null })),
  R("media.ts", "EMITTED_WITHOUT_AUDIO_DIGEST", AudioReleaseReceipt, () => ({ ...F.audioReleaseReceipt(), renderedAudioDigest: null })),
  R("media.ts", "EMITTED_WITH_REJECTION", AudioReleaseReceipt, () => ({ ...F.audioReleaseReceipt(), rejectionReason: "GENERATION_STALE" })),
  R("media.ts", "NOT_EMITTED_WITH_PLAYBACK", AudioReleaseReceipt, () => ({ ...F.audioReleaseReceipt(), status: "NOT_EMITTED_CANCELLED" })),
  R("media.ts", "REJECTION_WITHOUT_REASON", AudioReleaseReceipt, () => ({ ...F.audioReleaseReceipt(), status: "NOT_EMITTED_REJECTED", playback: null })),
  R("media.ts", "INTERRUPTION_WITHOUT_TIME", AudioReleaseReceipt, () => ({ ...F.audioReleaseReceipt(), status: "EMITTED_PARTIAL_INTERRUPTED" })),
  R("media.ts", "CLIP_RENDERER_MISMATCH", AudioReleaseReceipt, () => ({ ...F.audioReleaseReceipt(), source: { kind: "fallback_clip", clipRef: "clip_safety_route@v1", clipManifestDigest: F.digestOf("clips"), planId: null } })),
  R("media.ts", "LAST_FRAME_BEFORE_FIRST", AudioReleaseReceipt, () => {
    const r = F.audioReleaseReceipt();
    return { ...r, playback: { ...r.playback!, lastFrameAt: F.at(2_000) } };
  }),

  /* models.ts */
  R("models.ts", "VERIFICATION_SECRET_SENT_TO_MODEL", ModelInvocation, () => {
    const m = F.modelInvocation();
    return { ...m, input: { ...m.input, classification: "VERIFICATION_SECRET" } };
  }),
  R("models.ts", "STARTED_WITH_COMPLETION", ModelInvocation, () => ({ ...F.modelInvocation(), status: "STARTED" })),
  R("models.ts", "FINISHED_WITHOUT_COMPLETION_TIME", ModelInvocation, () => ({ ...F.modelInvocation(), completedAt: null })),
  R("models.ts", "USAGE_EXCEEDS_BUDGET", ModelInvocation, () => {
    const m = F.modelInvocation();
    return { ...m, usage: { ...m.usage!, outputTokens: 300 } };
  }),
  R("models.ts", "FAILURE_WITHOUT_CODE", ModelInvocation, () => ({ ...F.modelInvocation(), status: "FAILED" })),
  R("models.ts", "SERVER_ESTABLISHED_FIELD_IN_PROPOSAL", ModelDecision, () => F.modelDecision({ appointmentId: "apt_synthAveryAppt000001", tenant_id: S.otherTenantId })),
  R("models.ts", "TOO_MANY_ARGUMENTS", ModelDecision, () => F.modelDecision(Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`arg${i}`, i])))),
  R("models.ts", "ARGUMENTS_NOT_JSON", ModelDecision, () => F.modelDecision({ amount: 10n } as unknown as Record<string, unknown>)),
  R("models.ts", "ARGUMENTS_TOO_LARGE", ModelDecision, () => F.modelDecision({ note: "x".repeat(9_000) })),
  // 5,000 two-byte characters: about 5,000 UTF-16 code units but over 10,000 UTF-8 bytes (the bound is bytes).
  R("models.ts", "ARGUMENTS_TOO_LARGE", ModelDecision, () => F.modelDecision({ note: "\u00e9".repeat(5_000) })),

  /* plan.ts */
  R("plan.ts", "ACTION_ONLY_ON_ACTION_STEPS", LongHorizonPlan, () => {
    const p = F.longHorizonPlan();
    return { ...p, steps: [{ ...p.steps[0]!, action: "billing.review.commit" }, p.steps[1]!] };
  }),
  R("plan.ts", "ATTEMPTS_EXCEED_RETRY_BUDGET", LongHorizonPlan, () => {
    const p = F.longHorizonPlan();
    return { ...p, steps: [{ ...p.steps[0]!, attempts: 5 }, p.steps[1]!] };
  }),
  R("plan.ts", "DUPLICATE_STEP", LongHorizonPlan, () => {
    const p = F.longHorizonPlan();
    return { ...p, steps: [p.steps[0]!, p.steps[0]!] };
  }),
  R("plan.ts", "STEP_EXCEEDS_AUTHORITY_CEILING", LongHorizonPlan, () => {
    const p = F.longHorizonPlan();
    return { ...p, steps: [p.steps[0]!, { ...p.steps[1]!, action: "billing.refund.commit" }] };
  }),
  R("plan.ts", "UNKNOWN_STEP_DEPENDENCY", LongHorizonPlan, () => {
    const p = F.longHorizonPlan();
    return { ...p, steps: [p.steps[0]!, { ...p.steps[1]!, dependsOn: ["stp_missing"] }] };
  }),
  R("plan.ts", "AUTHORITY_WITHOUT_GRANT", LongHorizonPlan, () => {
    const p = F.longHorizonPlan();
    return { ...p, authorityCeiling: { ...p.authorityCeiling, grantRef: null } };
  }),
  R("plan.ts", "OPEN_PLAN_WITHOUT_NEXT_ACTION", LongHorizonPlan, () => ({ ...F.longHorizonPlan(), nextActionStepId: null })),
  R("plan.ts", "UNKNOWN_NEXT_ACTION", LongHorizonPlan, () => ({ ...F.longHorizonPlan(), nextActionStepId: "stp_missing" })),
  R("plan.ts", "REVISION_LINEAGE_INVALID", LongHorizonPlan, () => ({ ...F.longHorizonPlan(), revision: 2 })),

  /* review.ts */
  R("review.ts", "PASS_WITH_CRITICAL_LABEL", ReviewRecord, () => ({ ...F.reviewRecord(), labels: [{ key: "safety.routing", value: "MISSED", severity: "CRITICAL" }] })),
  R("review.ts", "SIGNED_BEFORE_REVIEW", ReviewRecord, () => ({ ...F.reviewRecord(), signedAt: F.at(-60_000) })),
  R("review.ts", "LICENSED_WITHOUT_LICENSE", DatasetItem, () => ({ ...F.datasetItem(), provenance: "LICENSED" })),
  R("review.ts", "PRODUCTION_DATA_WITHOUT_CONSENT", DatasetItem, () => ({ ...F.datasetItem(), provenance: "CONSENTED_REVIEWED_PRODUCTION" })),
  R("review.ts", "PRODUCTION_DATA_NOT_MINIMIZED", DatasetItem, () => ({ ...F.datasetItem(), provenance: "CONSENTED_REVIEWED_PRODUCTION", minimizationApplied: false })),
  R("review.ts", "PRODUCTION_DATA_UNREVIEWED", DatasetItem, () => ({ ...F.datasetItem(), provenance: "CONSENTED_REVIEWED_PRODUCTION" })),
  R("review.ts", "PRODUCTION_DATA_WITHOUT_RETENTION", DatasetItem, () => ({ ...F.datasetItem(), provenance: "CONSENTED_REVIEWED_PRODUCTION" })),
  R("review.ts", "VERIFICATION_SECRET_IN_DATASET", DatasetItem, () => ({ ...F.datasetItem(), dataClassification: "VERIFICATION_SECRET" })),
  R("review.ts", "SUPPORT_DATA_FOR_MARKETING", DatasetItem, () => ({ ...F.datasetItem(), purpose: "marketing" })),

  /* support.ts */
  R("support.ts", "CASE_LINK_FROM_OTHER_TENANT", SupportRequest, () => ({ ...supportRequest(), caseLinks: [{ ...F.caseLink(), tenantId: S.otherTenantId }] })),
  R("support.ts", "CASE_LINK_FOR_OTHER_CASE", SupportRequest, () => ({ ...supportRequest(), caseLinks: [F.caseLink(S.secondCaseId)] })),
  R("support.ts", "CASE_LINK_FROM_UNRELATED_CALL", SupportRequest, () => ({ ...supportRequest(), caseLinks: [F.caseLink(S.caseId, S.secondInteractionId)] })),
  R("support.ts", "DUPLICATE_CASE_LINK", SupportRequest, () => ({ ...supportRequest(), caseLinks: [F.caseLink(), F.caseLink()] })),

  /* tenant.ts */
  R("tenant.ts", "US_ONLY_REGION_OUTSIDE_US", TenantConfig, () => ({ ...tenantConfig(), regions: { primary: "us-east-1", secondary: "eu-west-1", usOnly: true } })),
  R("tenant.ts", "SUPPORT_TENANT_MARKETING_PURPOSE", TenantConfig, () => ({ ...tenantConfig(), processingPurposes: ["support_administration", "marketing"] })),
  R("tenant.ts", "PUBLISHED_WITHOUT_REVIEW", TenantConfig, () => ({ ...tenantConfig(), reviewedBy: null })),
  R("tenant.ts", "SELF_REVIEWED_PUBLICATION", TenantConfig, () => ({ ...tenantConfig(), reviewedBy: S.staffId })),
  R("tenant.ts", "DUPLICATE_JURISDICTION", TenantConfig, () => ({ ...tenantConfig(), jurisdictions: ["US", "US"] })),

  /* tool-envelope.ts */
  R("tool-envelope.ts", "TOO_MANY_KEYS", ToolRequestV2, () => F.toolRequestV2(Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`arg${i}`, i])))),
  R("tool-envelope.ts", "NOT_JSON", ToolRequestV2, () => F.toolRequestV2({ amount: 10n } as unknown as Record<string, unknown>)),
  R("tool-envelope.ts", "PAYLOAD_TOO_LARGE", ToolRequestV2, () => F.toolRequestV2({ note: "x".repeat(17_000) })),
  R("tool-envelope.ts", "SERVER_ESTABLISHED_FIELD_IN_ARGUMENTS", ToolRequestV2, () => F.toolRequestV2({ slotId: "slt_synthSlot0000000001", SubjectId: S.otherSubjectRef })),
  R("tool-envelope.ts", "STALE_RESULT_REPORTED_FRESH", ToolResultFreshness, () => {
    const f = freshness();
    return { ...f, sources: [{ ...f.sources[0]!, ageMs: null }] };
  }),
  R("tool-envelope.ts", "SOURCE_UPDATE_AFTER_OBSERVATION", ToolResultFreshness, () => {
    const f = freshness();
    return { ...f, sources: [{ ...f.sources[0]!, sourceUpdatedAt: F.at(60_000) }] };
  }),

  /* workflow.ts */
  R("workflow.ts", "TASK_EXPIRY_NOT_AFTER_CREATION", HumanTask, () => ({ ...F.humanTask(), expiresAt: S.t0 })),
  R("workflow.ts", "COMPLETED_TASK_WITHOUT_DECISION", HumanTask, () => ({ ...F.humanTask(), status: "COMPLETED" })),
  R("workflow.ts", "DECISION_ON_OPEN_TASK", HumanTask, () => ({ ...F.humanTask(), decision: "APPROVE" })),
  R("workflow.ts", "DECISION_BEFORE_TASK", HumanTask, () => ({ ...F.humanTask(), status: "COMPLETED", decision: "APPROVE", decidedBy: S.staffId, decidedAt: F.at(-1_000) })),
  R("workflow.ts", "DECISION_AFTER_EXPIRY", HumanTask, () => ({ ...F.humanTask(), status: "COMPLETED", decision: "APPROVE", decidedBy: S.staffId, decidedAt: F.at(3 * DAY) })),
];

/* ---- source scan --------------------------------------------------------------------------- */

const here = dirname(fileURLToPath(import.meta.url));
/** A rule code as emitted by a superRefine (`message: "X"` / `` message: `X:${..}` ``) or by statusAxesIssues (`code: "X"`). */
const RULE_CODE = /\b(?:message|code): [`"]([A-Z][A-Z0-9_]{2,})/g;

/** (file, code) -> number of emit sites, over every non-test protocol source file. */
function emittedRuleCodes(): Map<string, number> {
  const sites = new Map<string, number>();
  for (const file of readdirSync(here).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
    for (const m of readFileSync(join(here, file), "utf8").matchAll(RULE_CODE)) {
      const key = `${file}:${m[1]}`;
      sites.set(key, (sites.get(key) ?? 0) + 1);
    }
  }
  return sites;
}

const issueMessages = (r: { success: boolean; error?: { issues: { message: string }[] } }): string[] => (r.success ? [] : (r.error?.issues ?? []).map((i) => i.message));

describe("protocol boundary rules [WP-02]", () => {
  it("[WP-02] positive: every valid SYNTHETIC base parses", () => {
    for (const [name, schema, make] of VALID) {
      const r = schema.safeParse(make());
      expect(r.success, `${name}: ${issueMessages(r).join(", ")}`).toBe(true);
    }
  });

  it.each(RULE_CASES.map((c) => [`${c.file} ${c.code}`, c] as const))("[WP-02] adversarial: %s refuses the forbidden variant with its code", (_label, c) => {
    const messages = issueMessages(c.schema.safeParse(c.input()));
    expect(messages.some((m) => m === c.code || m.startsWith(`${c.code}:`)), `${c.code} not reported; got ${messages.join(", ") || "success"}`).toBe(true);
  });

  it("[WP-02] coverage: every rule code the protocol sources emit has at least one adversarial case per emit site, and no case names a code its file does not emit", () => {
    const sites = emittedRuleCodes();
    expect(sites.size).toBeGreaterThan(150);
    const cases = new Map<string, number>();
    for (const c of RULE_CASES) cases.set(`${c.file}:${c.code}`, (cases.get(`${c.file}:${c.code}`) ?? 0) + 1);
    const uncovered = [...sites].filter(([k, n]) => (cases.get(k) ?? 0) < n).map(([k, n]) => `${k} (${n} site(s), ${cases.get(k) ?? 0} case(s))`);
    expect(uncovered, "rules without a test").toEqual([]);
    expect([...cases.keys()].filter((k) => !sites.has(k)), "cases for codes that no longer exist").toEqual([]);
  });

  it("[WP-02] the coverage scan can fail: a code that no case covers is reported", () => {
    const sites = emittedRuleCodes();
    const covered = new Set(RULE_CASES.map((c) => `${c.file}:${c.code}`));
    expect(covered.has("media.ts:PLAN_HOLDS_VERIFICATION_SECRET")).toBe(true);
    const withoutOne = RULE_CASES.filter((c) => c.code !== "RECORD_FROM_OTHER_TENANT");
    const missing = [...sites.keys()].filter((k) => !new Set(withoutOne.map((c) => `${c.file}:${c.code}`)).has(k));
    expect(missing).toEqual(["activation.ts:RECORD_FROM_OTHER_TENANT"]);
  });
});
