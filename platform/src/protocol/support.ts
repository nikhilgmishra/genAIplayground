/**
 * Support requests, handoff packages and transfer state (spec sections 8 and 10).
 */
import { z } from "zod";
import { Assurance, ConsentState, IsoDateTime, IssueOutcomeRecord, OpaqueId, Outcome, Role, VersionSet } from "./common.js";
import { CASE_LINK_SCHEMA_VERSION, CaseLink } from "./effects.js";

export const SUPPORT_REQUEST_SCHEMA_VERSION = "support-request.v1";
export const HANDOFF_PACKAGE_SCHEMA_VERSION = "handoff-package.v1";

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

export const SupportRequest = z
  .strictObject({
    /** Contract version and causal predecessor (follow-on envelope); optional until the support service sets them. */
    schemaVersion: z.literal(SUPPORT_REQUEST_SCHEMA_VERSION).optional(),
    causationId: OpaqueId.optional(),
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
    /**
     * DEPRECATED: CRM ids move to `caseLinks` (CaseLink, FO-04-25/26). Kept so existing records and
     * the Salesforce outbox (WP-29) keep working; caseLinksOf() derives the CaseLink view from it.
     */
    salesforceCaseId: z.string().regex(/^[a-zA-Z0-9]{15,18}$/).nullable(),
    /** External case links for any CRM/case system; each link's tenant and caseId are this request's (enforced below). */
    caseLinks: z.array(CaseLink).max(8).optional(),
    /** Per-issue outcome with reopened / partially resolved flags (follow-on prompt section 11). */
    issueOutcome: IssueOutcomeRecord.optional(),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
  })
  .superRefine((sr, ctx) => {
    // Every external case link belongs to THIS support request: same tenant, same internal case,
    // a call of this request (when it names one) and a unique link id. A link from another
    // tenant or another case can never be attached at the contract boundary (AUTH-05, FO-04-25).
    const linkIds = new Set<string>();
    sr.caseLinks?.forEach((l, i) => {
      if (l.tenantId !== sr.tenantId) ctx.addIssue({ code: "custom", message: "CASE_LINK_FROM_OTHER_TENANT", path: ["caseLinks", i, "tenantId"] });
      if (l.caseId !== sr.supportRequestId) ctx.addIssue({ code: "custom", message: "CASE_LINK_FOR_OTHER_CASE", path: ["caseLinks", i, "caseId"] });
      if (l.interactionId !== null && !sr.sourceCallIds.includes(l.interactionId)) {
        ctx.addIssue({ code: "custom", message: "CASE_LINK_FROM_UNRELATED_CALL", path: ["caseLinks", i, "interactionId"] });
      }
      if (linkIds.has(l.linkId)) ctx.addIssue({ code: "custom", message: "DUPLICATE_CASE_LINK", path: ["caseLinks", i, "linkId"] });
      linkIds.add(l.linkId);
    });
  });
export type SupportRequest = z.infer<typeof SupportRequest>;

/** Stable link id for the legacy Salesforce link of a support request (derived, not random). */
const legacyLinkId = (supportRequestId: string): string => `csl_${supportRequestId.slice(supportRequestId.indexOf("_") + 1).slice(0, 60)}`;

/**
 * External case links of a support request: the explicit `caseLinks`, or the CaseLink view of the
 * legacy `salesforceCaseId` (external id present only when the sync actually returned it).
 */
export function caseLinksOf(record: SupportRequest): CaseLink[] {
  // Parsed first, so a link from another tenant or case is refused here too, never returned verbatim.
  const sr = SupportRequest.parse(record);
  if (sr.caseLinks && sr.caseLinks.length > 0) return sr.caseLinks;
  if (sr.salesforceCaseId === null && sr.syncState === "PENDING") return [];
  const ref = sr.salesforceCaseId;
  return [
    CaseLink.parse({
      schemaVersion: CASE_LINK_SCHEMA_VERSION,
      tenantId: sr.tenantId,
      caseId: sr.supportRequestId,
      occurredAt: sr.createdAt,
      interactionId: null,
      causationId: null,
      linkId: legacyLinkId(sr.supportRequestId),
      system: "salesforce_service_cloud",
      kind: "PRIMARY_CASE",
      externalCaseRef: ref,
      externalIdempotencyKey: sr.issueExternalId,
      syncState: ref === null && sr.syncState === "SYNCED" ? "SYNCING" : sr.syncState,
      lastSyncedAt: ref === null ? null : sr.updatedAt,
      relatedCaseId: null,
    }),
  ];
}

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

/**
 * Transfer states of the follow-on programme: every TransferState plus RECEIVER_DECLINED (a human
 * receiver can decline; that is recorded and routed explicitly, never abandoned, SAFE-04).
 * TransferState keeps its original eleven values until the transfer owner (WP-28:
 * workflows/transfer.ts) and the console contract (console-api, console group owner) adopt this
 * enum together; TransferRecord moves to it at the same time.
 */
export const TransferStateV2 = z.enum([...TransferState.options, "RECEIVER_DECLINED"]);
export type TransferStateV2 = z.infer<typeof TransferStateV2>;

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
  /** Contract version and causal predecessor (follow-on envelope); optional until the handoff service sets them. */
  schemaVersion: z.literal(HANDOFF_PACKAGE_SCHEMA_VERSION).optional(),
  causationId: OpaqueId.optional(),
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
  /** ContextSnapshot the package was assembled from and the source watermarks it relied on (freshness). */
  contextSnapshotRef: z.string().regex(/^ctx_[A-Za-z0-9_-]{16,64}$/).nullable().optional(),
  watermarkRefs: z.array(z.string().regex(/^wmk_[A-Za-z0-9_-]{16,64}$/)).max(16).optional(),
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
