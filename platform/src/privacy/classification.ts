/**
 * Artifact classification (spec section 6, DATA-02).
 *
 * Four retention data classes: transient conversational data, business records
 * required for support, restricted QA media, and security/audit evidence.
 *
 * Rules that cannot be relaxed by any descriptor field:
 *  - Raw audio and pre-redaction transcripts are PHI_RESTRICTED / RESTRICTED_QA_MEDIA
 *    wherever they are received, even when a redacted derivative exists.
 *  - A redacted transcript remains PHI-bearing: redaction is probabilistic and is
 *    not de-identification. Formal de-identification is not performed here, so a
 *    descriptor claiming it is ignored (reason DEIDENTIFICATION_NOT_ESTABLISHED).
 *  - A failed / quarantined / unattempted redaction is treated as the
 *    pre-redaction artifact and quarantined from broad access.
 *  - Derived artifacts are at least as sensitive as their PHI-bearing sources.
 */
import { z } from "zod";
import type { Classification, DataClass } from "../protocol/index.js";

export const ArtifactKind = z.enum([
  "RAW_AUDIO",
  "PRE_REDACTION_TRANSCRIPT",
  "REDACTED_TRANSCRIPT",
  "CALL_SUMMARY",
  "SUPPORT_MEMORY_ENTRY",
  "BUSINESS_RECORD",
  "KNOWLEDGE_ARTICLE",
  "AUDIT_EVENT",
  "CONTENT_FREE_TELEMETRY",
  "VERIFICATION_SECRET",
]);
export type ArtifactKind = z.infer<typeof ArtifactKind>;

export const RedactionStatus = z.enum(["NOT_ATTEMPTED", "REDACTED", "FAILED", "QUARANTINED"]);
export type RedactionStatus = z.infer<typeof RedactionStatus>;

export const ArtifactDescriptor = z.strictObject({
  kind: ArtifactKind,
  redactionStatus: RedactionStatus.optional(),
  /** Kinds of the artifacts this one was derived from. */
  derivedFrom: z.array(ArtifactKind).max(16).optional(),
  /** Only meaningful for KNOWLEDGE_ARTICLE. */
  knowledgeSensitivity: z.enum(["PUBLIC", "INTERNAL"]).optional(),
  /** Accepted only so it can be explicitly ignored: de-identification is not established here. */
  claimsDeidentified: z.boolean().optional(),
});
export type ArtifactDescriptor = z.infer<typeof ArtifactDescriptor>;

export type ModelContextHandling = "ALLOWED" | "MINIMIZED_APPROVED_ENDPOINT_ONLY" | "FORBIDDEN";

export interface ArtifactHandling {
  /** May appear in general application logs. */
  generalLogs: boolean;
  /** May go to analytics sinks without a PHI approval (content-free only). */
  unapprovedAnalytics: boolean;
  modelContext: ModelContextHandling;
  /** Never true for PHI-bearing artifacts (DATA-01). */
  debuggingVendors: boolean;
  /** Public or long-lived links are never allowed for PHI-bearing artifacts. */
  publicOrLongLivedLinks: boolean;
  /** Must be stored in an access-controlled restricted store. */
  restrictedStore: boolean;
  /** May be persisted at all. */
  persist: boolean;
}

export interface ArtifactClassification {
  classification: Classification;
  /** Retention data class; null for content that is never a retained record (verification secrets, content-free telemetry). */
  dataClass: DataClass | null;
  phiBearing: boolean;
  /** Quarantined from broad access (redaction failure or not attempted). */
  quarantined: boolean;
  handling: ArtifactHandling;
  reasonCodes: string[];
}

const RANK: Record<Classification, number> = { PUBLIC: 0, INTERNAL: 1, FINANCIAL: 2, PHI: 3, PHI_RESTRICTED: 4, VERIFICATION_SECRET: 5 };

const PHI_SOURCE_KINDS: ReadonlySet<ArtifactKind> = new Set([
  "RAW_AUDIO",
  "PRE_REDACTION_TRANSCRIPT",
  "REDACTED_TRANSCRIPT",
  "CALL_SUMMARY",
  "SUPPORT_MEMORY_ENTRY",
  "BUSINESS_RECORD",
]);

function handlingFor(classification: Classification, persist = true): ArtifactHandling {
  const phi = classification === "PHI" || classification === "PHI_RESTRICTED";
  const secret = classification === "VERIFICATION_SECRET";
  const restricted = phi || secret || classification === "FINANCIAL";
  return {
    generalLogs: !restricted,
    unapprovedAnalytics: !restricted,
    modelContext: secret || classification === "PHI_RESTRICTED" ? "FORBIDDEN" : restricted ? "MINIMIZED_APPROVED_ENDPOINT_ONLY" : "ALLOWED",
    debuggingVendors: !restricted && classification === "PUBLIC",
    publicOrLongLivedLinks: classification === "PUBLIC",
    restrictedStore: restricted,
    persist,
  };
}

function restrictedMedia(reasons: string[], quarantinedFlag: boolean): ArtifactClassification {
  return {
    classification: "PHI_RESTRICTED",
    dataClass: "RESTRICTED_QA_MEDIA",
    phiBearing: true,
    quarantined: quarantinedFlag,
    handling: handlingFor("PHI_RESTRICTED"),
    reasonCodes: reasons,
  };
}

/** Classifies an artifact. Throws on an invalid descriptor (fail closed at the caller). */
export function classifyArtifact(input: ArtifactDescriptor): ArtifactClassification {
  const d = ArtifactDescriptor.parse(input);
  const reasons: string[] = [];
  if (d.claimsDeidentified) reasons.push("DEIDENTIFICATION_NOT_ESTABLISHED");

  let result: ArtifactClassification;
  switch (d.kind) {
    case "RAW_AUDIO":
      reasons.push("RAW_AUDIO_ALWAYS_RESTRICTED");
      if (d.redactionStatus === "REDACTED") reasons.push("REDACTION_DOES_NOT_DECLASSIFY_RAW_AUDIO");
      result = restrictedMedia(reasons, false);
      break;
    case "PRE_REDACTION_TRANSCRIPT":
      reasons.push("PRE_REDACTION_TRANSCRIPT_ALWAYS_RESTRICTED");
      result = restrictedMedia(reasons, false);
      break;
    case "REDACTED_TRANSCRIPT": {
      const status = d.redactionStatus ?? "NOT_ATTEMPTED";
      if (status !== "REDACTED") {
        reasons.push(status === "NOT_ATTEMPTED" ? "REDACTION_NOT_ATTEMPTED" : "REDACTION_FAILED_QUARANTINED");
        result = restrictedMedia(reasons, true);
        break;
      }
      reasons.push("REDACTION_IS_NOT_DEIDENTIFICATION");
      result = { classification: "PHI", dataClass: "TRANSIENT_CONVERSATION", phiBearing: true, quarantined: false, handling: handlingFor("PHI"), reasonCodes: reasons };
      break;
    }
    case "CALL_SUMMARY":
    case "SUPPORT_MEMORY_ENTRY":
    case "BUSINESS_RECORD":
      result = { classification: "PHI", dataClass: "BUSINESS_RECORD", phiBearing: true, quarantined: false, handling: handlingFor("PHI"), reasonCodes: reasons };
      break;
    case "KNOWLEDGE_ARTICLE": {
      const c: Classification = d.knowledgeSensitivity === "PUBLIC" ? "PUBLIC" : "INTERNAL";
      if (!d.knowledgeSensitivity) reasons.push("KNOWLEDGE_SENSITIVITY_UNKNOWN_DEFAULT_INTERNAL");
      result = { classification: c, dataClass: "BUSINESS_RECORD", phiBearing: false, quarantined: false, handling: handlingFor(c), reasonCodes: reasons };
      break;
    }
    case "AUDIT_EVENT":
      result = { classification: "INTERNAL", dataClass: "SECURITY_AUDIT", phiBearing: false, quarantined: false, handling: handlingFor("INTERNAL"), reasonCodes: reasons };
      break;
    case "CONTENT_FREE_TELEMETRY":
      result = { classification: "INTERNAL", dataClass: null, phiBearing: false, quarantined: false, handling: handlingFor("INTERNAL"), reasonCodes: reasons };
      break;
    case "VERIFICATION_SECRET":
      reasons.push("VERIFICATION_SECRET_NEVER_PERSISTED");
      result = { classification: "VERIFICATION_SECRET", dataClass: null, phiBearing: false, quarantined: false, handling: handlingFor("VERIFICATION_SECRET", false), reasonCodes: reasons };
      break;
  }

  // Derivation never lowers sensitivity. Telemetry is content-free by construction
  // and is checked separately by the egress guard, so it does not inherit PHI.
  const sources = d.derivedFrom ?? [];
  const fromPhi = sources.some((k) => PHI_SOURCE_KINDS.has(k));
  if (fromPhi && d.kind === "CONTENT_FREE_TELEMETRY") {
    result.reasonCodes.push("TELEMETRY_FROM_PHI_SOURCE_REQUIRES_CONTENT_FREE_CHECK");
  } else if (fromPhi && RANK[result.classification] < RANK.PHI) {
    result.reasonCodes.push("DERIVED_FROM_PHI_SOURCE");
    result = { ...result, classification: "PHI", phiBearing: true, handling: handlingFor("PHI", result.handling.persist) };
    if (result.dataClass === null) result.dataClass = "TRANSIENT_CONVERSATION";
  }
  if (sources.includes("VERIFICATION_SECRET") && d.kind !== "VERIFICATION_SECRET" && d.kind !== "CONTENT_FREE_TELEMETRY") {
    result.reasonCodes.push("DERIVED_FROM_VERIFICATION_SECRET");
    result = { ...result, classification: "VERIFICATION_SECRET", handling: handlingFor("VERIFICATION_SECRET", false) };
  }
  return result;
}

/** Highest of two classifications. */
export function maxClassification(a: Classification, b: Classification): Classification {
  return RANK[a] >= RANK[b] ? a : b;
}

export const isPhiClass = (c: Classification): boolean => c === "PHI" || c === "PHI_RESTRICTED";

/** Classes that are content-free and may reach telemetry / analytics without a PHI approval. */
export const CONTENT_FREE_CLASSES: readonly Classification[] = ["PUBLIC", "INTERNAL"];
