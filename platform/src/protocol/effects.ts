/**
 * EffectVerification and CaseLink (follow-on prompt sections 4, 6 and 11; FO-04-24, FO-04-26).
 *
 * EffectVerification is independent of the model and of response text: it queries the source of
 * record (or validates a trusted completion event / external-key lookup), checks the exact target,
 * new state and version, and records the evidence. Eventual consistency is PENDING_VISIBILITY until
 * verified; "not found" inside the provider's visibility window is not definitive. A commit receipt
 * or HTTP success alone is never a verified effect (ACT-03, ACT-04).
 *
 * CaseLink links an internal support request (the durable case) to an external case record in any
 * CRM/case system. The external case reference is null until a sync actually returned it: a case
 * number is never invented, and a successful write is not proof of final disposition.
 *
 * Created by WP-02 in phase B; owned by WP-25 from phase D.
 */
import { z } from "zod";
import { ActionTarget } from "./actions.js";
import { EvidencePointer, IsoDateTime, OpaqueId, Sha256Hex, SourceSystemId, envelope, isAfter, opaqueIdWithPrefix } from "./common.js";

export const EFFECT_VERIFICATION_SCHEMA_VERSION = "effect-verification.v1";
export const CASE_LINK_SCHEMA_VERSION = "case-link.v1";

export const VerificationMethodKind = z.enum(["AUTHORITATIVE_READ_BACK", "TRUSTED_COMPLETION_EVENT", "EXTERNAL_KEY_LOOKUP", "HUMAN_ATTESTATION"]);
export type VerificationMethodKind = z.infer<typeof VerificationMethodKind>;

export const EffectVerificationResult = z.enum(["VERIFIED", "MISMATCH", "PENDING_VISIBILITY", "NOT_FOUND_WITHIN_WINDOW", "NOT_FOUND_AFTER_WINDOW", "UNVERIFIABLE"]);
export type EffectVerificationResult = z.infer<typeof EffectVerificationResult>;

export const EffectVerification = z
  .strictObject({
    ...envelope(EFFECT_VERIFICATION_SCHEMA_VERSION, ["tenantId", "causationId", "occurredAt"], ["caseId", "workflowId", "interactionId"]),
    verificationId: opaqueIdWithPrefix("efv"),
    actionId: OpaqueId,
    commitReceiptId: OpaqueId.nullable(),
    method: VerificationMethodKind,
    target: z.strictObject({
      system: ActionTarget.shape.system,
      recordType: ActionTarget.shape.recordType,
      recordRef: ActionTarget.shape.recordRef,
    }),
    /** Digest of the exact state the committed action should have produced (canonical fields). */
    expected: z.strictObject({ stateDigest: Sha256Hex, version: z.string().min(1).max(64).nullable() }),
    observed: z
      .strictObject({
        stateDigest: Sha256Hex.nullable(),
        version: z.string().min(1).max(64).nullable(),
        observedAt: IsoDateTime,
        /** Trusted completion event or read-back request id the observation came from. */
        sourceEventRef: z.string().min(3).max(128).regex(/^[A-Za-z0-9_.:-]+$/).nullable(),
      })
      .nullable(),
    result: EffectVerificationResult,
    /** End of the provider's documented visibility window; before it, "not found" is not definitive. */
    visibilityWindowEndsAt: IsoDateTime.nullable(),
    evidenceRef: EvidencePointer,
    evidenceDigest: Sha256Hex,
    verifier: z.strictObject({
      component: z.string().regex(/^[a-z][a-z0-9_.-]{2,63}$/),
      connectorProfileRef: OpaqueId.nullable(),
      /** Always true: the verifier never reads model output or response text. */
      independentOfModel: z.literal(true),
    }),
  })
  .superRefine((v, ctx) => {
    if (v.result === "VERIFIED") {
      if (v.observed === null || v.observed.stateDigest !== v.expected.stateDigest) {
        ctx.addIssue({ code: "custom", message: "VERIFIED_WITHOUT_MATCHING_OBSERVATION", path: ["observed"] });
      }
      if (v.expected.version !== null && v.observed?.version !== v.expected.version) {
        ctx.addIssue({ code: "custom", message: "VERIFIED_WITH_VERSION_MISMATCH", path: ["observed", "version"] });
      }
      if (v.method === "HUMAN_ATTESTATION") ctx.addIssue({ code: "custom", message: "HUMAN_ATTESTATION_IS_NOT_SOURCE_VERIFICATION", path: ["method"] });
      // An event- or lookup-based verification names the trusted event or lookup it observed.
      if (v.method !== "AUTHORITATIVE_READ_BACK" && v.observed !== null && v.observed.sourceEventRef === null) {
        ctx.addIssue({ code: "custom", message: "VERIFIED_WITHOUT_SOURCE_EVENT", path: ["observed", "sourceEventRef"] });
      }
    }
    if (v.result === "MISMATCH" && (v.observed === null || v.observed.stateDigest === v.expected.stateDigest)) {
      ctx.addIssue({ code: "custom", message: "MISMATCH_WITHOUT_DIFFERING_OBSERVATION", path: ["observed"] });
    }
    if (v.result === "NOT_FOUND_WITHIN_WINDOW" || v.result === "NOT_FOUND_AFTER_WINDOW") {
      if (v.visibilityWindowEndsAt === null) ctx.addIssue({ code: "custom", message: "NOT_FOUND_WITHOUT_VISIBILITY_WINDOW", path: ["visibilityWindowEndsAt"] });
      else {
        const at = v.observed?.observedAt ?? v.occurredAt;
        const within = !isAfter(at, v.visibilityWindowEndsAt);
        if (v.result === "NOT_FOUND_AFTER_WINDOW" && within) ctx.addIssue({ code: "custom", message: "NOT_FOUND_IS_NOT_DEFINITIVE_INSIDE_WINDOW", path: ["result"] });
        if (v.result === "NOT_FOUND_WITHIN_WINDOW" && !within) ctx.addIssue({ code: "custom", message: "WINDOW_ALREADY_CLOSED", path: ["result"] });
      }
    }
  });
export type EffectVerification = z.infer<typeof EffectVerification>;

/** Only a VERIFIED result supports RESOLVED_WITH_EVIDENCE; PENDING_VISIBILITY reports accepted/pending. */
export const effectVerified = (v: EffectVerification): boolean => v.result === "VERIFIED";

/* ------------------------------------------------------------------------ */
/* CaseLink                                                                  */
/* ------------------------------------------------------------------------ */

/** Same values as support.ts SyncState (asserted equal in registry.test.ts; kept local to avoid an import cycle). */
export const CaseSyncState = z.enum(["PENDING", "SYNCING", "SYNCED", "RETRY_SCHEDULED", "DEAD_LETTER"]);
export type CaseSyncState = z.infer<typeof CaseSyncState>;

export const CaseLinkKind = z.enum(["PRIMARY_CASE", "RELATED_CASE", "REOPENED_FROM", "DUPLICATE_OF"]);
export type CaseLinkKind = z.infer<typeof CaseLinkKind>;

/** External case record id: vendor-issued, opaque (e.g. a 15/18-character Salesforce id). */
export const ExternalCaseRef = z.string().min(3).max(64).regex(/^[A-Za-z0-9_.:-]+$/);

export const CaseLink = z
  .strictObject({
    ...envelope(CASE_LINK_SCHEMA_VERSION, ["tenantId", "caseId", "occurredAt"], ["interactionId", "causationId"]),
    linkId: opaqueIdWithPrefix("csl"),
    /** CRM or case system, e.g. `salesforce_service_cloud`. */
    system: SourceSystemId,
    kind: CaseLinkKind,
    /** Null until the external system returned the record id; never invented (FO-04-26). */
    externalCaseRef: ExternalCaseRef.nullable(),
    /** Server-derived external idempotency key used for upsert. */
    externalIdempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
    syncState: CaseSyncState,
    lastSyncedAt: IsoDateTime.nullable(),
    /** Related support request for REOPENED_FROM / DUPLICATE_OF / RELATED_CASE links. */
    relatedCaseId: OpaqueId.nullable(),
  })
  .superRefine((l, ctx) => {
    if (l.syncState === "SYNCED" && (l.externalCaseRef === null || l.lastSyncedAt === null)) {
      ctx.addIssue({ code: "custom", message: "SYNCED_WITHOUT_EXTERNAL_RECORD", path: ["externalCaseRef"] });
    }
    if (l.kind !== "PRIMARY_CASE" && l.relatedCaseId === null) ctx.addIssue({ code: "custom", message: "RELATED_LINK_WITHOUT_CASE", path: ["relatedCaseId"] });
    if (l.relatedCaseId !== null && l.relatedCaseId === l.caseId) ctx.addIssue({ code: "custom", message: "CASE_LINKED_TO_ITSELF", path: ["relatedCaseId"] });
  });
export type CaseLink = z.infer<typeof CaseLink>;
