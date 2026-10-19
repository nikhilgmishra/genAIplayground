/**
 * Common-field model of the follow-on contracts (follow-on prompt section 4; FO-04-42).
 *
 * The prompt asks for these common fields "where relevant": tenant_id, interaction_id, case_id,
 * workflow_id, opaque actor/subject references, session_generation, turn_id, request_id,
 * causation_id, schema_version, created_at, expires_at, policy/config/source versions, data
 * classification, source provenance and outcome. COMMON_FIELDS names each of them in the
 * protocol's camelCase vocabulary and COMMON_FIELD_SPEC_PHRASES maps every phrase of that list to
 * its fields (registry.test.ts parses the verbatim prompt line and checks that nothing is missing).
 *
 * "Where relevant" is decided HERE, not by the contract descriptors in followon.ts: each contract
 * has domain traits (it is tenant data, it lives inside a call, it is fenced by the session
 * generation, it expires, it is derived from a source, it records an outcome, ...) and each trait
 * requires its common fields (TRAIT_FIELDS). registry-check.ts then requires every descriptor to
 * map exactly the fields its traits require, checks each mapped property's shape in the generated
 * JSON Schema, and cross-checks the other direction structurally: a contract whose schema carries
 * a property with a common-field name (tenantId, callId, expiresAt, dataClass, ...) must have the
 * trait that makes that field relevant. A descriptor therefore cannot drop a relevant field, and a
 * trait table cannot omit a field the schema visibly carries.
 */
import type { FollowonContractName } from "./followon.js";

/** The common fields, in the order of the prompt's list. `occurredAt` is created_at. */
export const COMMON_FIELDS = [
  "tenantId",
  "interactionId",
  "caseId",
  "workflowId",
  "actorRef",
  "subjectRef",
  "sessionGeneration",
  "turnId",
  "requestId",
  "causationId",
  "schemaVersion",
  "occurredAt",
  "expiresAt",
  "versions",
  "dataClassification",
  "provenance",
  "outcome",
] as const;
export type CommonField = (typeof COMMON_FIELDS)[number];

/** Every phrase of the prompt's common-field list -> the fields it names. */
export const COMMON_FIELD_SPEC_PHRASES: Readonly<Record<string, readonly CommonField[]>> = {
  tenant_id: ["tenantId"],
  interaction_id: ["interactionId"],
  case_id: ["caseId"],
  workflow_id: ["workflowId"],
  "opaque actor/subject references": ["actorRef", "subjectRef"],
  session_generation: ["sessionGeneration"],
  turn_id: ["turnId"],
  request_id: ["requestId"],
  causation_id: ["causationId"],
  schema_version: ["schemaVersion"],
  created_at: ["occurredAt"],
  expires_at: ["expiresAt"],
  "policy/config/source versions": ["versions"],
  "data classification": ["dataClassification"],
  "source provenance": ["provenance"],
  outcome: ["outcome"],
};

/**
 * Domain traits that make common fields relevant. A trait describes what the record IS, so it can
 * be reviewed against the prompt without looking at the schema.
 */
export const CONTRACT_TRAITS_LIST = [
  /** Every contract: its instances carry the contract version. */
  "VERSIONED_CONTRACT",
  /** Persisted record or event with its own creation / occurrence instant. */
  "TIMESTAMPED",
  /** Holds tenant data; never valid outside its tenant. */
  "TENANT_SCOPED",
  /** Belongs to one call / interaction. */
  "CALL_SCOPED",
  /** Valid only for the session generation it was issued under (participant change, recovery or revocation invalidates it). */
  "SESSION_FENCED",
  /** Belongs to one conversation turn. */
  "TURN_SCOPED",
  /** Answers or belongs to one gateway request. */
  "REQUEST_SCOPED",
  /** Belongs to a durable case (support request). */
  "CASE_SCOPED",
  /** Belongs to a durable workflow instance. */
  "WORKFLOW_SCOPED",
  /** Caused by an earlier event, decision or request (causal chain for audit and replay). */
  "CAUSAL",
  /** Has a hard expiry enforced by application logic (AUTH-04). */
  "EXPIRING",
  /** Records an act or authority of an identified actor (opaque reference). */
  "ACTOR_ATTRIBUTED",
  /** Concerns one subject (person) whose records it may disclose or change (AUTH-05). */
  "SUBJECT_SCOPED",
  /** Carries content whose sensitivity governs disclosure, egress or retention (DATA-01..03, AUTH-06). */
  "CLASSIFIED_CONTENT",
  /** Its meaning depends on pinned policy, configuration, model, schema or source versions (OPS-06). */
  "VERSION_PINNED",
  /** Its content comes from a source, method or producer that must stay inspectable (DATA-04). */
  "SOURCE_DERIVED",
  /** Records an outcome, result or decision (ACT-04, OPS-03). */
  "OUTCOME_BEARING",
] as const;
export type ContractTrait = (typeof CONTRACT_TRAITS_LIST)[number];

/** The common fields each trait makes relevant. */
export const TRAIT_FIELDS: Readonly<Record<ContractTrait, readonly CommonField[]>> = {
  VERSIONED_CONTRACT: ["schemaVersion"],
  TIMESTAMPED: ["occurredAt"],
  TENANT_SCOPED: ["tenantId"],
  CALL_SCOPED: ["interactionId"],
  SESSION_FENCED: ["sessionGeneration"],
  TURN_SCOPED: ["turnId"],
  REQUEST_SCOPED: ["requestId"],
  CASE_SCOPED: ["caseId"],
  WORKFLOW_SCOPED: ["workflowId"],
  CAUSAL: ["causationId"],
  EXPIRING: ["expiresAt"],
  ACTOR_ATTRIBUTED: ["actorRef"],
  SUBJECT_SCOPED: ["subjectRef"],
  CLASSIFIED_CONTENT: ["dataClassification"],
  VERSION_PINNED: ["versions"],
  SOURCE_DERIVED: ["provenance"],
  OUTCOME_BEARING: ["outcome"],
};

const T = (...traits: Exclude<ContractTrait, "VERSIONED_CONTRACT">[]): readonly ContractTrait[] => ["VERSIONED_CONTRACT", ...traits];

/**
 * Traits of each of the 34 contracts. Comments give the reason a trait that might be expected is
 * absent; registry-check.ts structurally verifies that no absent trait is visibly carried.
 */
export const CONTRACT_TRAITS: Readonly<Record<FollowonContractName, readonly ContractTrait[]>> = {
  // Reconstructed per request from session state (not a persisted record): no own creation instant, no cause.
  AuthContext: T("TENANT_SCOPED", "CALL_SCOPED", "SESSION_FENCED", "ACTOR_ATTRIBUTED", "SUBJECT_SCOPED", "EXPIRING", "CLASSIFIED_CONTENT", "VERSION_PINNED", "SOURCE_DERIVED"),
  CallBinding: T("TIMESTAMPED", "TENANT_SCOPED", "CALL_SCOPED", "SESSION_FENCED", "CAUSAL", "EXPIRING", "SOURCE_DERIVED"),
  TurnEnvelope: T("TIMESTAMPED", "TENANT_SCOPED", "CALL_SCOPED", "SESSION_FENCED", "TURN_SCOPED", "CASE_SCOPED", "CAUSAL", "CLASSIFIED_CONTENT", "VERSION_PINNED", "SOURCE_DERIVED"),
  ContextSnapshot: T(
    "TIMESTAMPED", "TENANT_SCOPED", "CALL_SCOPED", "SESSION_FENCED", "TURN_SCOPED", "CASE_SCOPED", "SUBJECT_SCOPED", "CAUSAL", "EXPIRING",
    "CLASSIFIED_CONTENT", "VERSION_PINNED", "SOURCE_DERIVED",
  ),
  ContextFact: T("TIMESTAMPED", "TENANT_SCOPED", "SUBJECT_SCOPED", "CAUSAL", "EXPIRING", "CLASSIFIED_CONTENT", "VERSION_PINNED", "SOURCE_DERIVED"),
  // Describes a source stream, not subject content.
  SourceWatermark: T("TIMESTAMPED", "TENANT_SCOPED", "CAUSAL", "SOURCE_DERIVED"),
  IdentityLink: T("TIMESTAMPED", "TENANT_SCOPED", "SUBJECT_SCOPED", "CAUSAL", "EXPIRING", "VERSION_PINNED", "SOURCE_DERIVED"),
  // Approved operational knowledge, not subject data.
  KnowledgeCitation: T("TIMESTAMPED", "TENANT_SCOPED", "CAUSAL", "EXPIRING", "CLASSIFIED_CONTENT", "VERSION_PINNED", "SOURCE_DERIVED"),
  ModelInvocation: T(
    "TIMESTAMPED", "TENANT_SCOPED", "CALL_SCOPED", "TURN_SCOPED", "REQUEST_SCOPED", "CASE_SCOPED", "CAUSAL", "CLASSIFIED_CONTENT", "VERSION_PINNED",
    "SOURCE_DERIVED", "OUTCOME_BEARING",
  ),
  // A proposal only: its versions and classification are those of the invocation it came from.
  ModelDecision: T("TIMESTAMPED", "TENANT_SCOPED", "CALL_SCOPED", "TURN_SCOPED", "CAUSAL", "SOURCE_DERIVED"),
  ToolRequest: T("TIMESTAMPED", "TENANT_SCOPED", "CALL_SCOPED", "SESSION_FENCED", "TURN_SCOPED", "REQUEST_SCOPED", "CAUSAL", "VERSION_PINNED"),
  // Correlated to its call through requestId.
  ToolResult: T("TIMESTAMPED", "TENANT_SCOPED", "SESSION_FENCED", "TURN_SCOPED", "REQUEST_SCOPED", "CAUSAL", "VERSION_PINNED", "SOURCE_DERIVED", "OUTCOME_BEARING"),
  // Session-bound (sessionRef + generation); the outcome is the CommitReceipt's.
  PreparedAction: T("TIMESTAMPED", "TENANT_SCOPED", "SESSION_FENCED", "ACTOR_ATTRIBUTED", "SUBJECT_SCOPED", "CAUSAL", "EXPIRING", "VERSION_PINNED", "SOURCE_DERIVED"),
  ConfirmationReceipt: T("TIMESTAMPED", "TENANT_SCOPED", "SESSION_FENCED", "TURN_SCOPED", "ACTOR_ATTRIBUTED", "CAUSAL", "EXPIRING", "SOURCE_DERIVED"),
  ActionGrant: T("TIMESTAMPED", "TENANT_SCOPED", "ACTOR_ATTRIBUTED", "SUBJECT_SCOPED", "CASE_SCOPED", "WORKFLOW_SCOPED", "CAUSAL", "EXPIRING", "SOURCE_DERIVED"),
  CommitReceipt: T("TIMESTAMPED", "TENANT_SCOPED", "CAUSAL", "VERSION_PINNED", "SOURCE_DERIVED", "OUTCOME_BEARING"),
  EffectVerification: T("TIMESTAMPED", "TENANT_SCOPED", "CALL_SCOPED", "CASE_SCOPED", "WORKFLOW_SCOPED", "CAUSAL", "VERSION_PINNED", "SOURCE_DERIVED", "OUTCOME_BEARING"),
  // A durable case spans many calls (sourceCallIds), so it is not scoped to one interaction.
  SupportRequest: T("TIMESTAMPED", "TENANT_SCOPED", "CASE_SCOPED", "SUBJECT_SCOPED", "CAUSAL", "VERSION_PINNED", "SOURCE_DERIVED", "OUTCOME_BEARING"),
  CaseLink: T("TIMESTAMPED", "TENANT_SCOPED", "CALL_SCOPED", "CASE_SCOPED", "CAUSAL", "SOURCE_DERIVED"),
  WorkflowEvent: T("TIMESTAMPED", "TENANT_SCOPED", "WORKFLOW_SCOPED", "ACTOR_ATTRIBUTED", "CAUSAL", "VERSION_PINNED", "SOURCE_DERIVED"),
  HumanTask: T("TIMESTAMPED", "TENANT_SCOPED", "WORKFLOW_SCOPED", "CASE_SCOPED", "ACTOR_ATTRIBUTED", "CAUSAL", "EXPIRING", "OUTCOME_BEARING"),
  HandoffPackage: T("TIMESTAMPED", "TENANT_SCOPED", "CALL_SCOPED", "SESSION_FENCED", "SUBJECT_SCOPED", "CAUSAL", "SOURCE_DERIVED"),
  CarrierEvent: T("TIMESTAMPED", "TENANT_SCOPED", "CALL_SCOPED", "CAUSAL", "VERSION_PINNED", "SOURCE_DERIVED"),
  SpeechPlan: T(
    "TIMESTAMPED", "TENANT_SCOPED", "CALL_SCOPED", "SESSION_FENCED", "TURN_SCOPED", "REQUEST_SCOPED", "CAUSAL", "EXPIRING", "CLASSIFIED_CONTENT",
    "VERSION_PINNED", "SOURCE_DERIVED",
  ),
  AudioReleaseReceipt: T("TIMESTAMPED", "TENANT_SCOPED", "CALL_SCOPED", "SESSION_FENCED", "TURN_SCOPED", "CAUSAL", "SOURCE_DERIVED", "OUTCOME_BEARING"),
  AuditEvent: T(
    "TIMESTAMPED", "TENANT_SCOPED", "CALL_SCOPED", "SESSION_FENCED", "TURN_SCOPED", "ACTOR_ATTRIBUTED", "SUBJECT_SCOPED", "CAUSAL", "CLASSIFIED_CONTENT",
    "VERSION_PINNED", "SOURCE_DERIVED", "OUTCOME_BEARING",
  ),
  // Reviewed configuration authored by an operator: no subject data, no outcome.
  ConnectorProfile: T("TIMESTAMPED", "TENANT_SCOPED", "CAUSAL", "CLASSIFIED_CONTENT", "VERSION_PINNED"),
  TenantConfig: T("TIMESTAMPED", "TENANT_SCOPED", "CAUSAL", "VERSION_PINNED"),
  // Synthetic corpus definition (deployment-level, no tenant); its outcome is the expected one.
  ScenarioDefinition: T("VERSION_PINNED", "OUTCOME_BEARING"),
  // Deployment-level evaluation evidence; its provenance is the execution mode that produced it.
  EvaluationResult: T("TIMESTAMPED", "VERSION_PINNED", "SOURCE_DERIVED", "OUTCOME_BEARING"),
  ChangeProposal: T("TIMESTAMPED", "TENANT_SCOPED", "ACTOR_ATTRIBUTED", "CAUSAL", "VERSION_PINNED", "SOURCE_DERIVED"),
  // Deployment-scoped human approval; the approved artifact versions are in `subject`, required per scope by config/approvals.ts.
  ApprovalRecord: T("TIMESTAMPED", "CAUSAL", "EXPIRING", "SOURCE_DERIVED"),
  ReleaseManifest: T("TIMESTAMPED", "VERSION_PINNED", "SOURCE_DERIVED", "OUTCOME_BEARING"),
  // Each record's `state` carries the per-capability outcome; the report is the tenant's evidence summary.
  ActivationReport: T("TIMESTAMPED", "TENANT_SCOPED", "CAUSAL", "VERSION_PINNED", "SOURCE_DERIVED"),
};

/** The common fields relevant to a contract under its traits. */
export function relevantCommonFields(name: FollowonContractName): CommonField[] {
  const fields = new Set<CommonField>();
  for (const t of CONTRACT_TRAITS[name]) for (const f of TRAIT_FIELDS[t]) fields.add(f);
  return COMMON_FIELDS.filter((f) => fields.has(f));
}

/**
 * Unambiguous top-level property names that carry a common field. A contract whose schema has
 * one of these properties must find that field relevant (and map it).
 */
export const COMMON_FIELD_ALIASES: Readonly<Record<string, CommonField>> = {
  tenantId: "tenantId",
  interactionId: "interactionId",
  callId: "interactionId",
  caseId: "caseId",
  supportRequestId: "caseId",
  workflowId: "workflowId",
  actorRef: "actorRef",
  actorId: "actorRef",
  subjectRef: "subjectRef",
  subjectId: "subjectRef",
  authorizedSubjectRef: "subjectRef",
  sessionGeneration: "sessionGeneration",
  turnId: "turnId",
  requestId: "requestId",
  causationId: "causationId",
  occurredAt: "occurredAt",
  createdAt: "occurredAt",
  expiresAt: "expiresAt",
  dataClassification: "dataClassification",
  dataClass: "dataClassification",
  versions: "versions",
  policyVersion: "versions",
  outcome: "outcome",
};
