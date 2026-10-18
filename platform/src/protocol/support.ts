/**
 * Support requests, handoff packages and transfer state (spec sections 8 and 10).
 */
import { z } from "zod";
import { Assurance, ConsentState, IsoDateTime, OpaqueId, Outcome, Role, VersionSet } from "./common.js";

/** Internal support reference. Never presented as a Salesforce Case number. */
export const SupportReference = z.string().regex(/^SR-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
export type SupportReference = z.infer<typeof SupportReference>;

export const IssueCategory = z.enum([
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
export type IssueCategory = z.infer<typeof IssueCategory>;

export const SyncState = z.enum(["PENDING", "SYNCING", "SYNCED", "RETRY_SCHEDULED", "DEAD_LETTER"]);
export type SyncState = z.infer<typeof SyncState>;

export const SupportRequest = z.strictObject({
  supportRequestId: OpaqueId,
  referenceNumber: SupportReference,
  tenantId: OpaqueId,
  /** External IDs used for idempotent Salesforce upsert. One interaction may address several issues. */
  interactionExternalId: z.string().regex(/^int_[A-Za-z0-9_-]{16,64}$/),
  issueExternalId: z.string().regex(/^iss_[A-Za-z0-9_-]{16,64}$/),
  audience: Role.nullable(),
  subjectRef: OpaqueId.nullable(),
  issueCategory: IssueCategory,
  disposition: Outcome,
  ownerQueue: z.string().regex(/^q_[a-z0-9_]{2,40}$/),
  priority: z.enum(["P1_SAFETY", "P2_URGENT", "P3_STANDARD", "P4_LOW"]),
  /** Minimized approved summary assembled from templates; never a full transcript. */
  summary: z.string().max(600),
  summaryProvenance: z.enum(["template_assembled", "human_reviewed"]),
  attempted: z.array(z.string().regex(/^[a-z_.]{3,64}$/)).max(16),
  commitReceiptIds: z.array(OpaqueId).max(16),
  sourceCallIds: z.array(OpaqueId).min(1).max(32),
  language: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/),
  consent: ConsentState,
  nextStep: z.string().max(200).nullable(),
  deadline: IsoDateTime.nullable(),
  versions: VersionSet,
  /** Privacy or safety events are stored as restricted records, not broadly visible Cases. */
  restricted: z.boolean(),
  syncState: SyncState,
  salesforceCaseId: z.string().regex(/^[a-zA-Z0-9]{15,18}$/).nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type SupportRequest = z.infer<typeof SupportRequest>;

export const TransferState = z.enum([
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
export type TransferState = z.infer<typeof TransferState>;

export const TransferReason = z.enum([
  "CALLER_REQUESTED_HUMAN",
  "SAFETY_PRIORITY",
  "CLINICAL_QUESTION",
  "POLICY_REQUIRES_HUMAN",
  "VERIFICATION_RECOVERY",
  "UNSUPPORTED_LANGUAGE",
  "ACCESSIBILITY",
  "DEPENDENCY_FAILURE",
  "AI_UNAVAILABLE",
  "CONSENT_DECLINED_ALTERNATIVE",
]);
export type TransferReason = z.infer<typeof TransferReason>;

/** Destination ids come only from trusted configuration (SAFE-05). */
export const DestinationId = z.string().regex(/^dst_[a-z0-9_]{2,40}$/);
export type DestinationId = z.infer<typeof DestinationId>;

export const HandoffPackage = z.strictObject({
  handoffId: OpaqueId,
  tenantId: OpaqueId,
  callId: OpaqueId,
  sessionGeneration: z.number().int().min(1),
  reason: TransferReason,
  destinationId: DestinationId,
  statedIssue: IssueCategory,
  /** Template-assembled; no clinical statements unless necessary and permitted. */
  issueSummary: z.string().max(400),
  assurance: Assurance,
  assuranceLimits: z.array(z.string().max(120)).max(8),
  authorizedSubjectRef: OpaqueId.nullable(),
  consent: ConsentState,
  actionReceiptIds: z.array(OpaqueId).max(16),
  pendingActionIds: z.array(OpaqueId).max(16),
  unresolvedTasks: z.array(z.string().max(160)).max(8),
  supportReference: SupportReference.nullable(),
  language: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/),
  accommodations: z.array(z.enum(["interpreter", "relay_service", "slower_speech", "repeat_on_request", "tty"])).max(5),
  safetyRoutingReason: z.enum(["EXPLICIT_PHRASE", "SEMANTIC_SIGNAL", "ASR_UNCERTAIN", "CALLER_REQUEST", "HUMAN_INTERVENTION", "FAIL_SAFE"]).nullable(),
  clinicalStatementsIncluded: z.boolean(),
  /** Signed verification result for the same call and authorized receiver (compact JWS) or null. */
  verificationAssertion: z.string().max(4096).nullable(),
  createdAt: IsoDateTime,
});
export type HandoffPackage = z.infer<typeof HandoffPackage>;

export const TransferRecord = z.strictObject({
  transferId: OpaqueId,
  handoffId: OpaqueId,
  callId: OpaqueId,
  destinationId: DestinationId,
  priority: z.enum(["SAFETY", "STANDARD"]),
  state: TransferState,
  history: z.array(z.strictObject({ state: TransferState, at: IsoDateTime, source: z.string().max(64) })).max(64),
  receiverAcknowledgedPackage: z.boolean(),
  fallbackDestinationIds: z.array(DestinationId).max(4),
  updatedAt: IsoDateTime,
});
export type TransferRecord = z.infer<typeof TransferRecord>;
