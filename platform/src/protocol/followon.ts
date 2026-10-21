/**
 * Follow-on contract registry (follow-on prompt section 4; FO-04-01, FO-04-42, FO-04-48).
 *
 * FOLLOWON_CONTRACTS describes each of the 34 required contracts: the schema the registry asserts
 * (strict, versioned, bounded, carrying its common envelope fields), the generated schema file,
 * the source file, the producing component and whether that producer already validates this exact
 * schema. CONTRACT_ALIASES records renamed contracts. FOLLOWON_SCHEMAS lists every follow-on
 * schema exported to schemas/protocol; generate-schemas.ts renders them together with the original
 * PROTOCOL_SCHEMAS (registry.ts).
 *
 * registry.ts, index.ts and tools.ts belong to the registry shared group (phase B owner WP-07);
 * merging FOLLOWON_SCHEMAS into PROTOCOL_SCHEMAS and re-exporting the new modules from index.ts is
 * that owner's integration step. Until then, import follow-on contracts from this module.
 */
import type { z } from "zod";
import { ACTIVATION_RECORD_SCHEMA_VERSION, ACTIVATION_REPORT_SCHEMA_VERSION, ActivationRecord, ActivationReport } from "./activation.js";
import { ACTION_GRANT_SCHEMA_VERSION, ActionGrant, COMMIT_RECEIPT_SCHEMA_VERSION, CONFIRMATION_RECEIPT_SCHEMA_VERSION, CommitReceipt, ConfirmationReceipt, PREPARED_ACTION_SCHEMA_VERSION, PreparedActionV2 } from "./actions.js";
import { AUDIT_SCHEMA_VERSION, AuditEvent } from "./audit.js";
import { AUTH_CONTEXT_SCHEMA_VERSION, AuthContext } from "./auth.js";
import { CALL_BINDING_SCHEMA_VERSION, CallBinding } from "./call-binding.js";
import type { CommonField } from "./common-fields.js";
import { CapabilityStatus, ConsentProfile, IssueOutcomeRecord, Money, PageRequest, TimeRange } from "./common.js";
import { CAPABILITY_EVIDENCE_SCHEMA_VERSION, CONNECTOR_PROFILE_SCHEMA_VERSION, CapabilityEvidence, ConnectorProfile } from "./connector.js";
import { CONTEXT_FACT_SCHEMA_VERSION, ContextFact, SOURCE_WATERMARK_SCHEMA_VERSION, SourceWatermark } from "./context-facts.js";
import { CONTEXT_SNAPSHOT_SCHEMA_VERSION, ContextSnapshot } from "./context-snapshot.js";
import { CASE_LINK_SCHEMA_VERSION, CaseLink, EFFECT_VERIFICATION_SCHEMA_VERSION, EffectVerification } from "./effects.js";
import { EVALUATION_RESULT_SCHEMA_VERSION, EvaluationResult, SCENARIO_DEFINITION_SCHEMA_VERSION, ScenarioDefinition } from "./evaluation.js";
import { IDENTITY_LINK_SCHEMA_VERSION, IdentityLink, PERSON_ROLE_ASSIGNMENT_SCHEMA_VERSION, PersonRoleAssignment } from "./identity-link.js";
import { CANARY_SPEC_SCHEMA_VERSION, CHANGE_PROPOSAL_SCHEMA_VERSION, CanarySpec, ChangeProposal } from "./improvement.js";
import { KNOWLEDGE_CITATION_SCHEMA_VERSION, KnowledgeCitation } from "./knowledge.js";
import { AUDIO_RELEASE_RECEIPT_SCHEMA_VERSION, AudioReleaseReceipt, CARRIER_EVENT_SCHEMA_VERSION, CarrierEvent, SPEECH_PLAN_SCHEMA_VERSION, SpeechPlan, TURN_ENVELOPE_SCHEMA_VERSION, TurnEnvelope } from "./media.js";
import { MODEL_DECISION_SCHEMA_VERSION, MODEL_INVOCATION_SCHEMA_VERSION, ModelDecision, ModelInvocation } from "./models.js";
import { LONG_HORIZON_PLAN_SCHEMA_VERSION, LongHorizonPlan } from "./plan.js";
import { APPROVAL_RECORD_SCHEMA_VERSION, ApprovalRecord, ReleaseManifest, StatusAxes } from "./release.js";
import { DATASET_ITEM_SCHEMA_VERSION, DatasetItem, REVIEW_RECORD_SCHEMA_VERSION, ReviewRecord } from "./review.js";
import { HANDOFF_PACKAGE_SCHEMA_VERSION, HandoffPackage, SUPPORT_REQUEST_SCHEMA_VERSION, SupportRequest } from "./support.js";
import { TENANT_CONFIG_SCHEMA_VERSION, TenantConfig } from "./tenant.js";
import { TOOL_REQUEST_V2_SCHEMA_VERSION, TOOL_RESULT_V2_SCHEMA_VERSION, ToolRequestV2, ToolResultV2 } from "./tool-envelope.js";
import { HUMAN_TASK_SCHEMA_VERSION, HumanTask, WORKFLOW_EVENT_SCHEMA_VERSION, WorkflowEvent } from "./workflow.js";

/** The 34 required contracts, in follow-on prompt section 4 order. */
export const FOLLOWON_CONTRACT_NAMES = [
  "AuthContext",
  "CallBinding",
  "TurnEnvelope",
  "ContextSnapshot",
  "ContextFact",
  "SourceWatermark",
  "IdentityLink",
  "KnowledgeCitation",
  "ModelInvocation",
  "ModelDecision",
  "ToolRequest",
  "ToolResult",
  "PreparedAction",
  "ConfirmationReceipt",
  "ActionGrant",
  "CommitReceipt",
  "EffectVerification",
  "SupportRequest",
  "CaseLink",
  "WorkflowEvent",
  "HumanTask",
  "HandoffPackage",
  "CarrierEvent",
  "SpeechPlan",
  "AudioReleaseReceipt",
  "AuditEvent",
  "ConnectorProfile",
  "TenantConfig",
  "ScenarioDefinition",
  "EvaluationResult",
  "ChangeProposal",
  "ApprovalRecord",
  "ReleaseManifest",
  "ActivationReport",
] as const;
export type FollowonContractName = (typeof FOLLOWON_CONTRACT_NAMES)[number];

/**
 * Producer state, honestly:
 * - IN_USE: the producing component parses this exact schema at its boundary today;
 * - LEGACY_WIRE_IN_USE: the producer validates the original wire schema (`wireSchemaKey`); the
 *   follow-on version is adopted by `adoptionOwner`;
 * - PLANNED: no producing component exists yet; `adoptionOwner` builds it.
 */
export type ProducerStatus = "IN_USE" | "LEGACY_WIRE_IN_USE" | "PLANNED";

export interface ContractDescriptor {
  readonly name: FollowonContractName;
  /** Key in FOLLOWON_SCHEMAS / file name in schemas/protocol (`<schemaKey>.schema.json`). */
  readonly schemaKey: string;
  readonly schema: z.ZodType;
  /** Contract version carried in the payload (`versionField`). */
  readonly version: string;
  readonly versionField: "schemaVersion" | "manifestVersion";
  /**
   * Common field (common-fields.ts) -> property path carrying it in this contract (legacy names
   * allowed; a dotted path names a nested property). Which fields must be mapped is decided by the
   * contract's traits in common-fields.ts, not here.
   */
  readonly commonFields: Readonly<Partial<Record<CommonField, string>>>;
  /** Mapped properties that are optional until `adoptionOwner` populates them (additive, legacy records stay valid). */
  readonly optionalUntilAdoption: readonly string[];
  /** Protocol source file (platform/src/protocol/...). */
  readonly sourceFile: string;
  readonly producer: { readonly status: ProducerStatus; readonly path: string | null; readonly wireSchemaKey?: string };
  /** Package that adopts the follow-on schema or builds the producer; null when nothing is pending. */
  readonly adoptionOwner: string | null;
}

const d = (x: ContractDescriptor): ContractDescriptor => x;

export const FOLLOWON_CONTRACTS: Readonly<Record<FollowonContractName, ContractDescriptor>> = {
  AuthContext: d({
    name: "AuthContext", schemaKey: "AuthContext", schema: AuthContext, version: AUTH_CONTEXT_SCHEMA_VERSION, versionField: "schemaVersion",
    commonFields: { schemaVersion: "schemaVersion", tenantId: "tenantId", interactionId: "callId", actorRef: "actorId", subjectRef: "subjectId", sessionGeneration: "sessionGeneration", expiresAt: "expiresAt", dataClassification: "dataClassification", versions: "policyVersion", provenance: "verificationMethod" },
    optionalUntilAdoption: ["schemaVersion", "dataClassification"],
    sourceFile: "auth.ts", producer: { status: "IN_USE", path: "src/identity/session-store.ts" }, adoptionOwner: "WP-05",
  }),
  CallBinding: d({
    name: "CallBinding", schemaKey: "CallBinding", schema: CallBinding, version: CALL_BINDING_SCHEMA_VERSION, versionField: "schemaVersion",
    commonFields: { schemaVersion: "schemaVersion", tenantId: "tenantId", interactionId: "interactionId", sessionGeneration: "sessionGeneration", causationId: "causationId", occurredAt: "occurredAt", expiresAt: "expiresAt", provenance: "boundBy" },
    optionalUntilAdoption: [], sourceFile: "call-binding.ts", producer: { status: "PLANNED", path: null }, adoptionOwner: "WP-11",
  }),
  TurnEnvelope: d({
    name: "TurnEnvelope", schemaKey: "TurnEnvelope", schema: TurnEnvelope, version: TURN_ENVELOPE_SCHEMA_VERSION, versionField: "schemaVersion",
    commonFields: { schemaVersion: "schemaVersion", tenantId: "tenantId", interactionId: "interactionId", caseId: "caseId", sessionGeneration: "sessionGeneration", turnId: "turnId", causationId: "causationId", occurredAt: "occurredAt", dataClassification: "dataClassification", versions: "asr.engineRef", provenance: "speaker" },
    optionalUntilAdoption: [], sourceFile: "media.ts", producer: { status: "PLANNED", path: null }, adoptionOwner: "WP-14",
  }),
  ContextSnapshot: d({
    name: "ContextSnapshot", schemaKey: "ContextSnapshot", schema: ContextSnapshot, version: CONTEXT_SNAPSHOT_SCHEMA_VERSION, versionField: "schemaVersion",
    commonFields: { schemaVersion: "schemaVersion", tenantId: "tenantId", interactionId: "interactionId", caseId: "caseId", subjectRef: "subjectRef", sessionGeneration: "sessionGeneration", turnId: "turnId", causationId: "causationId", occurredAt: "occurredAt", expiresAt: "expiresAt", dataClassification: "scope.classificationCeiling", versions: "scope.policyVersion", provenance: "coverage" },
    optionalUntilAdoption: [], sourceFile: "context-snapshot.ts", producer: { status: "PLANNED", path: null }, adoptionOwner: "WP-24",
  }),
  ContextFact: d({
    name: "ContextFact", schemaKey: "ContextFact", schema: ContextFact, version: CONTEXT_FACT_SCHEMA_VERSION, versionField: "schemaVersion",
    commonFields: { schemaVersion: "schemaVersion", tenantId: "tenantId", subjectRef: "subjectRef", causationId: "causationId", occurredAt: "occurredAt", expiresAt: "expiresAt", dataClassification: "dataClassification", versions: "source.version", provenance: "source" },
    optionalUntilAdoption: [], sourceFile: "context-facts.ts", producer: { status: "PLANNED", path: null }, adoptionOwner: "WP-18",
  }),
  SourceWatermark: d({
    name: "SourceWatermark", schemaKey: "SourceWatermark", schema: SourceWatermark, version: SOURCE_WATERMARK_SCHEMA_VERSION, versionField: "schemaVersion",
    commonFields: { schemaVersion: "schemaVersion", tenantId: "tenantId", causationId: "causationId", occurredAt: "occurredAt", provenance: "source" },
    optionalUntilAdoption: [], sourceFile: "context-facts.ts", producer: { status: "PLANNED", path: null }, adoptionOwner: "WP-18",
  }),
  IdentityLink: d({
    name: "IdentityLink", schemaKey: "IdentityLink", schema: IdentityLink, version: IDENTITY_LINK_SCHEMA_VERSION, versionField: "schemaVersion",
    commonFields: { schemaVersion: "schemaVersion", tenantId: "tenantId", subjectRef: "personRef", causationId: "causationId", occurredAt: "occurredAt", expiresAt: "expiresAt", versions: "canonicalIdVersion", provenance: "basis" },
    optionalUntilAdoption: [], sourceFile: "identity-link.ts", producer: { status: "PLANNED", path: null }, adoptionOwner: "WP-19",
  }),
  KnowledgeCitation: d({
    name: "KnowledgeCitation", schemaKey: "KnowledgeCitation", schema: KnowledgeCitation, version: KNOWLEDGE_CITATION_SCHEMA_VERSION, versionField: "schemaVersion",
    commonFields: { schemaVersion: "schemaVersion", tenantId: "tenantId", causationId: "causationId", occurredAt: "occurredAt", expiresAt: "expiresAt", dataClassification: "sensitivity", versions: "articleVersion", provenance: "sourceRef" },
    optionalUntilAdoption: [], sourceFile: "knowledge.ts", producer: { status: "PLANNED", path: null }, adoptionOwner: "WP-20",
  }),
  ModelInvocation: d({
    name: "ModelInvocation", schemaKey: "ModelInvocation", schema: ModelInvocation, version: MODEL_INVOCATION_SCHEMA_VERSION, versionField: "schemaVersion",
    commonFields: { schemaVersion: "schemaVersion", tenantId: "tenantId", interactionId: "interactionId", caseId: "caseId", turnId: "turnId", requestId: "requestId", causationId: "causationId", occurredAt: "occurredAt", dataClassification: "input.classification", versions: "pins", provenance: "model", outcome: "status" },
    optionalUntilAdoption: [], sourceFile: "models.ts", producer: { status: "PLANNED", path: null }, adoptionOwner: "WP-10",
  }),
  ModelDecision: d({
    name: "ModelDecision", schemaKey: "ModelDecision", schema: ModelDecision, version: MODEL_DECISION_SCHEMA_VERSION, versionField: "schemaVersion",
    commonFields: { schemaVersion: "schemaVersion", tenantId: "tenantId", interactionId: "interactionId", turnId: "turnId", causationId: "causationId", occurredAt: "occurredAt", provenance: "invocationId" },
    optionalUntilAdoption: [], sourceFile: "models.ts", producer: { status: "PLANNED", path: null }, adoptionOwner: "WP-10",
  }),
  ToolRequest: d({
    name: "ToolRequest", schemaKey: "ToolRequestV2", schema: ToolRequestV2, version: TOOL_REQUEST_V2_SCHEMA_VERSION, versionField: "schemaVersion",
    commonFields: { schemaVersion: "schemaVersion", tenantId: "tenantId", interactionId: "interactionId", sessionGeneration: "sessionGeneration", turnId: "turnId", requestId: "requestId", causationId: "causationId", occurredAt: "receivedAt", versions: "tool.version" },
    optionalUntilAdoption: [], sourceFile: "tool-envelope.ts",
    producer: { status: "LEGACY_WIRE_IN_USE", path: "src/gateway/pipeline.ts", wireSchemaKey: "ToolRequest" }, adoptionOwner: "WP-07",
  }),
  ToolResult: d({
    name: "ToolResult", schemaKey: "ToolResultV2", schema: ToolResultV2, version: TOOL_RESULT_V2_SCHEMA_VERSION, versionField: "schemaVersion",
    commonFields: { schemaVersion: "schemaVersion", tenantId: "tenantId", sessionGeneration: "sessionGeneration", turnId: "turnId", requestId: "requestId", causationId: "causationId", occurredAt: "completedAt", versions: "tool.version", provenance: "receiptRefs", outcome: "status" },
    optionalUntilAdoption: [], sourceFile: "tool-envelope.ts",
    producer: { status: "LEGACY_WIRE_IN_USE", path: "src/gateway/pipeline.ts", wireSchemaKey: "ToolResult" }, adoptionOwner: "WP-07",
  }),
  PreparedAction: d({
    name: "PreparedAction", schemaKey: "PreparedActionV2", schema: PreparedActionV2, version: PREPARED_ACTION_SCHEMA_VERSION, versionField: "schemaVersion",
    commonFields: { schemaVersion: "schemaVersion", tenantId: "tenantId", actorRef: "actorId", subjectRef: "subjectId", sessionGeneration: "sessionGeneration", causationId: "causationId", occurredAt: "preparedAt", expiresAt: "expiresAt", versions: "policyVersion", provenance: "target" },
    optionalUntilAdoption: [], sourceFile: "actions.ts",
    producer: { status: "LEGACY_WIRE_IN_USE", path: "src/actions/action-service.ts", wireSchemaKey: "PreparedAction" }, adoptionOwner: "WP-25",
  }),
  ConfirmationReceipt: d({
    name: "ConfirmationReceipt", schemaKey: "ConfirmationReceipt", schema: ConfirmationReceipt, version: CONFIRMATION_RECEIPT_SCHEMA_VERSION, versionField: "schemaVersion",
    commonFields: { schemaVersion: "schemaVersion", tenantId: "tenantId", actorRef: "actorRef", sessionGeneration: "sessionGeneration", turnId: "turnId", causationId: "causationId", occurredAt: "capturedAt", expiresAt: "expiresAt", provenance: "method" },
    optionalUntilAdoption: [], sourceFile: "actions.ts",
    producer: { status: "LEGACY_WIRE_IN_USE", path: "src/actions/action-service.ts", wireSchemaKey: "ActionConfirmation" }, adoptionOwner: "WP-25",
  }),
  ActionGrant: d({
    name: "ActionGrant", schemaKey: "ActionGrant", schema: ActionGrant, version: ACTION_GRANT_SCHEMA_VERSION, versionField: "schemaVersion",
    commonFields: { schemaVersion: "schemaVersion", tenantId: "tenantId", actorRef: "actorRef", subjectRef: "subjectRef", caseId: "caseId", workflowId: "workflowId", causationId: "causationId", occurredAt: "occurredAt", expiresAt: "expiresAt", provenance: "sourceRef" },
    optionalUntilAdoption: [], sourceFile: "actions.ts", producer: { status: "PLANNED", path: "src/workflows/grants.ts" }, adoptionOwner: "WP-25",
  }),
  CommitReceipt: d({
    name: "CommitReceipt", schemaKey: "CommitReceipt", schema: CommitReceipt, version: COMMIT_RECEIPT_SCHEMA_VERSION, versionField: "schemaVersion",
    commonFields: { schemaVersion: "schemaVersion", tenantId: "tenantId", causationId: "causationId", occurredAt: "recordedAt", versions: "afterVersion", provenance: "providerSystem", outcome: "outcome" },
    optionalUntilAdoption: ["schemaVersion", "tenantId", "causationId"], sourceFile: "actions.ts", producer: { status: "IN_USE", path: "src/actions/action-service.ts" }, adoptionOwner: "WP-25",
  }),
  EffectVerification: d({
    name: "EffectVerification", schemaKey: "EffectVerification", schema: EffectVerification, version: EFFECT_VERIFICATION_SCHEMA_VERSION, versionField: "schemaVersion",
    commonFields: { schemaVersion: "schemaVersion", tenantId: "tenantId", interactionId: "interactionId", caseId: "caseId", workflowId: "workflowId", causationId: "causationId", occurredAt: "occurredAt", versions: "expected.version", provenance: "method", outcome: "result" },
    optionalUntilAdoption: [], sourceFile: "effects.ts", producer: { status: "PLANNED", path: null }, adoptionOwner: "WP-25",
  }),
  SupportRequest: d({
    name: "SupportRequest", schemaKey: "SupportRequest", schema: SupportRequest, version: SUPPORT_REQUEST_SCHEMA_VERSION, versionField: "schemaVersion",
    commonFields: { schemaVersion: "schemaVersion", tenantId: "tenantId", caseId: "supportRequestId", subjectRef: "subjectRef", causationId: "causationId", occurredAt: "createdAt", versions: "versions", provenance: "summaryProvenance", outcome: "disposition" },
    optionalUntilAdoption: ["schemaVersion", "causationId"], sourceFile: "support.ts", producer: { status: "IN_USE", path: "src/business/support/support-request-service.ts" }, adoptionOwner: "WP-29",
  }),
  CaseLink: d({
    name: "CaseLink", schemaKey: "CaseLink", schema: CaseLink, version: CASE_LINK_SCHEMA_VERSION, versionField: "schemaVersion",
    commonFields: { schemaVersion: "schemaVersion", tenantId: "tenantId", interactionId: "interactionId", caseId: "caseId", causationId: "causationId", occurredAt: "occurredAt", provenance: "system" },
    optionalUntilAdoption: [], sourceFile: "effects.ts", producer: { status: "PLANNED", path: null }, adoptionOwner: "WP-29",
  }),
  WorkflowEvent: d({
    name: "WorkflowEvent", schemaKey: "WorkflowEvent", schema: WorkflowEvent, version: WORKFLOW_EVENT_SCHEMA_VERSION, versionField: "schemaVersion",
    commonFields: { schemaVersion: "schemaVersion", tenantId: "tenantId", workflowId: "workflowId", actorRef: "actor.ref", causationId: "causationId", occurredAt: "occurredAt", versions: "definitionVersion", provenance: "trigger" },
    optionalUntilAdoption: ["schemaVersion", "tenantId", "causationId"], sourceFile: "workflow.ts", producer: { status: "IN_USE", path: "src/workflows/engine.ts" }, adoptionOwner: "WP-26",
  }),
  HumanTask: d({
    name: "HumanTask", schemaKey: "HumanTask", schema: HumanTask, version: HUMAN_TASK_SCHEMA_VERSION, versionField: "schemaVersion",
    commonFields: { schemaVersion: "schemaVersion", tenantId: "tenantId", workflowId: "workflowId", caseId: "caseId", actorRef: "decidedBy", causationId: "causationId", occurredAt: "occurredAt", expiresAt: "expiresAt", outcome: "decision" },
    optionalUntilAdoption: [], sourceFile: "workflow.ts", producer: { status: "PLANNED", path: "src/workflows/engine.ts" }, adoptionOwner: "WP-26",
  }),
  HandoffPackage: d({
    name: "HandoffPackage", schemaKey: "HandoffPackage", schema: HandoffPackage, version: HANDOFF_PACKAGE_SCHEMA_VERSION, versionField: "schemaVersion",
    commonFields: { schemaVersion: "schemaVersion", tenantId: "tenantId", interactionId: "callId", sessionGeneration: "sessionGeneration", subjectRef: "authorizedSubjectRef", causationId: "causationId", occurredAt: "createdAt", provenance: "contextSnapshotRef" },
    optionalUntilAdoption: ["schemaVersion", "causationId", "contextSnapshotRef"], sourceFile: "support.ts", producer: { status: "IN_USE", path: "src/business/handoff.ts" }, adoptionOwner: "WP-28",
  }),
  CarrierEvent: d({
    name: "CarrierEvent", schemaKey: "CarrierEvent", schema: CarrierEvent, version: CARRIER_EVENT_SCHEMA_VERSION, versionField: "schemaVersion",
    commonFields: { schemaVersion: "schemaVersion", tenantId: "tenantId", interactionId: "interactionId", causationId: "causationId", occurredAt: "occurredAt", versions: "payloadSchemaRef", provenance: "authentication" },
    optionalUntilAdoption: [], sourceFile: "media.ts", producer: { status: "PLANNED", path: null }, adoptionOwner: "WP-04",
  }),
  SpeechPlan: d({
    name: "SpeechPlan", schemaKey: "SpeechPlan", schema: SpeechPlan, version: SPEECH_PLAN_SCHEMA_VERSION, versionField: "schemaVersion",
    commonFields: { schemaVersion: "schemaVersion", tenantId: "tenantId", interactionId: "interactionId", sessionGeneration: "sessionGeneration", turnId: "turnId", requestId: "requestId", causationId: "causationId", occurredAt: "occurredAt", expiresAt: "expiresAt", dataClassification: "dataClassification", versions: "versions", provenance: "sourceRefs" },
    optionalUntilAdoption: [], sourceFile: "media.ts", producer: { status: "PLANNED", path: null }, adoptionOwner: "WP-14",
  }),
  AudioReleaseReceipt: d({
    name: "AudioReleaseReceipt", schemaKey: "AudioReleaseReceipt", schema: AudioReleaseReceipt, version: AUDIO_RELEASE_RECEIPT_SCHEMA_VERSION, versionField: "schemaVersion",
    commonFields: { schemaVersion: "schemaVersion", tenantId: "tenantId", interactionId: "interactionId", sessionGeneration: "sessionGeneration", turnId: "turnId", causationId: "causationId", occurredAt: "occurredAt", provenance: "source", outcome: "status" },
    optionalUntilAdoption: [], sourceFile: "media.ts", producer: { status: "PLANNED", path: null }, adoptionOwner: "WP-14",
  }),
  AuditEvent: d({
    name: "AuditEvent", schemaKey: "AuditEvent", schema: AuditEvent, version: AUDIT_SCHEMA_VERSION, versionField: "schemaVersion",
    commonFields: { schemaVersion: "schemaVersion", tenantId: "tenantId", interactionId: "callId", actorRef: "actorRef", subjectRef: "subjectRef", sessionGeneration: "sessionGeneration", turnId: "turnId", causationId: "causationId", occurredAt: "occurredAt", dataClassification: "dataClass", versions: "versions", provenance: "sourceComponent", outcome: "outcome" },
    optionalUntilAdoption: ["causationId"], sourceFile: "audit.ts", producer: { status: "IN_USE", path: "src/audit/chain.ts" }, adoptionOwner: "WP-04",
  }),
  ConnectorProfile: d({
    name: "ConnectorProfile", schemaKey: "ConnectorProfile", schema: ConnectorProfile, version: CONNECTOR_PROFILE_SCHEMA_VERSION, versionField: "schemaVersion",
    commonFields: { schemaVersion: "schemaVersion", tenantId: "tenantId", causationId: "causationId", occurredAt: "occurredAt", dataClassification: "egressClass", versions: "vendor.apiVersion" },
    optionalUntilAdoption: [], sourceFile: "connector.ts", producer: { status: "PLANNED", path: null }, adoptionOwner: "WP-06",
  }),
  TenantConfig: d({
    name: "TenantConfig", schemaKey: "TenantConfig", schema: TenantConfig, version: TENANT_CONFIG_SCHEMA_VERSION, versionField: "schemaVersion",
    commonFields: { schemaVersion: "schemaVersion", tenantId: "tenantId", causationId: "causationId", occurredAt: "occurredAt", versions: "configVersion" },
    optionalUntilAdoption: [], sourceFile: "tenant.ts", producer: { status: "PLANNED", path: null }, adoptionOwner: "WP-31",
  }),
  ScenarioDefinition: d({
    name: "ScenarioDefinition", schemaKey: "ScenarioDefinition", schema: ScenarioDefinition, version: SCENARIO_DEFINITION_SCHEMA_VERSION, versionField: "schemaVersion",
    commonFields: { schemaVersion: "schemaVersion", versions: "version", outcome: "expectedFinalState.outcome" },
    optionalUntilAdoption: ["schemaVersion"], sourceFile: "evaluation.ts", producer: { status: "IN_USE", path: "src/evaluation/generate.ts" }, adoptionOwner: "WP-01",
  }),
  EvaluationResult: d({
    name: "EvaluationResult", schemaKey: "EvaluationResult", schema: EvaluationResult, version: EVALUATION_RESULT_SCHEMA_VERSION, versionField: "schemaVersion",
    commonFields: { schemaVersion: "schemaVersion", occurredAt: "runAt", versions: "versions", provenance: "executionMode", outcome: "verdict" },
    optionalUntilAdoption: ["schemaVersion"], sourceFile: "evaluation.ts", producer: { status: "IN_USE", path: "src/evaluation/scorer.ts" }, adoptionOwner: "WP-01",
  }),
  ChangeProposal: d({
    name: "ChangeProposal", schemaKey: "ChangeProposal", schema: ChangeProposal, version: CHANGE_PROPOSAL_SCHEMA_VERSION, versionField: "schemaVersion",
    commonFields: { schemaVersion: "schemaVersion", tenantId: "tenantId", actorRef: "authoredBy.ref", causationId: "causationId", occurredAt: "occurredAt", versions: "changes", provenance: "evidenceRefs" },
    optionalUntilAdoption: [], sourceFile: "improvement.ts", producer: { status: "PLANNED", path: null }, adoptionOwner: "WP-36",
  }),
  ApprovalRecord: d({
    name: "ApprovalRecord", schemaKey: "ApprovalRecord", schema: ApprovalRecord, version: APPROVAL_RECORD_SCHEMA_VERSION, versionField: "schemaVersion",
    commonFields: { schemaVersion: "schemaVersion", causationId: "causationId", occurredAt: "grantedAt", expiresAt: "expiresAt", provenance: "approver" },
    optionalUntilAdoption: ["schemaVersion", "causationId"], sourceFile: "release.ts", producer: { status: "IN_USE", path: "src/config/approvals.ts" }, adoptionOwner: "WP-07",
  }),
  ReleaseManifest: d({
    name: "ReleaseManifest", schemaKey: "ReleaseManifest", schema: ReleaseManifest, version: "release-manifest.v1", versionField: "manifestVersion",
    commonFields: { schemaVersion: "manifestVersion", occurredAt: "createdAt", versions: "versions", provenance: "sourceCommit", outcome: "status" },
    optionalUntilAdoption: [], sourceFile: "release.ts", producer: { status: "IN_USE", path: "src/evaluation/manifest.ts" }, adoptionOwner: "WP-40",
  }),
  ActivationReport: d({
    name: "ActivationReport", schemaKey: "ActivationReport", schema: ActivationReport, version: ACTIVATION_REPORT_SCHEMA_VERSION, versionField: "schemaVersion",
    commonFields: { schemaVersion: "schemaVersion", tenantId: "tenantId", causationId: "causationId", occurredAt: "occurredAt", versions: "tenantConfigDigest", provenance: "generatedBy" },
    optionalUntilAdoption: [], sourceFile: "activation.ts", producer: { status: "PLANNED", path: null }, adoptionOwner: "WP-31",
  }),
};

/**
 * Renamed or superseded contracts: follow-on name -> what it replaces and how. The original names
 * stay registered (PROTOCOL_SCHEMAS) while their producers still emit them.
 */
export const CONTRACT_ALIASES: Readonly<Record<string, { readonly supersedes: string; readonly relation: string }>> = {
  ConfirmationReceipt: { supersedes: "ActionConfirmation", relation: "ActionConfirmation plus receiptId, tenantId, actorRef, expiresAt, auditEventId and causationId (confirmationReceiptFrom)" },
  TenantConfig: { supersedes: "PlatformConfig", relation: "tenant-scoped published configuration; PlatformConfig (platform/src/config/schema.ts) stays the deployment-scoped configuration" },
  ToolRequestV2: { supersedes: "ToolRequest", relation: "ToolRequest.extend with the common envelope and bounded arguments" },
  ToolResultV2: { supersedes: "ToolResult", relation: "every ToolResult branch plus envelope, receipt refs, explanation code and (SUCCESS/PENDING) freshness" },
  PreparedActionV2: { supersedes: "PreparedAction", relation: "PreparedAction.extend with schemaVersion and causationId (both digest-covered on adoption)" },
};

/** Supporting follow-on schemas exported alongside the 34 contracts. */
export const FOLLOWON_SUPPORTING_SCHEMAS: Readonly<Record<string, z.ZodType>> = {
  ActivationRecord,
  CapabilityEvidence,
  CapabilityStatus,
  CanarySpec,
  ConsentProfile,
  DatasetItem,
  IssueOutcomeRecord,
  LongHorizonPlan,
  Money,
  PageRequest,
  PersonRoleAssignment,
  ReviewRecord,
  StatusAxes,
  TimeRange,
};

/** Supporting schema versions (contract-shaped supporting schemas carry their own schemaVersion). */
export const SUPPORTING_SCHEMA_VERSIONS: Readonly<Record<string, string>> = {
  ActivationRecord: ACTIVATION_RECORD_SCHEMA_VERSION,
  CapabilityEvidence: CAPABILITY_EVIDENCE_SCHEMA_VERSION,
  CanarySpec: CANARY_SPEC_SCHEMA_VERSION,
  DatasetItem: DATASET_ITEM_SCHEMA_VERSION,
  LongHorizonPlan: LONG_HORIZON_PLAN_SCHEMA_VERSION,
  PersonRoleAssignment: PERSON_ROLE_ASSIGNMENT_SCHEMA_VERSION,
  ReviewRecord: REVIEW_RECORD_SCHEMA_VERSION,
};

/** Every follow-on schema by file key: the 34 contracts (by schemaKey) plus the supporting schemas. */
export const FOLLOWON_SCHEMAS: Readonly<Record<string, z.ZodType>> = {
  ...Object.fromEntries(Object.values(FOLLOWON_CONTRACTS).map((c) => [c.schemaKey, c.schema])),
  ...FOLLOWON_SUPPORTING_SCHEMAS,
};

/**
 * Common-field map (common field -> property path) by schema key, written as `x-common-fields`
 * into each generated contract file so consumers can find every common field without the source.
 */
export const COMMON_FIELDS_BY_SCHEMA_KEY: Readonly<Record<string, Readonly<Partial<Record<CommonField, string>>>>> = Object.fromEntries(
  Object.values(FOLLOWON_CONTRACTS).map((c) => [c.schemaKey, c.commonFields]),
);

/** Contract version by schema key, written as `x-contract-version` into each generated file. */
export const CONTRACT_VERSION_BY_SCHEMA_KEY: Readonly<Record<string, string>> = {
  ...Object.fromEntries(Object.values(FOLLOWON_CONTRACTS).map((c) => [c.schemaKey, c.version])),
  ...SUPPORTING_SCHEMA_VERSIONS,
};
