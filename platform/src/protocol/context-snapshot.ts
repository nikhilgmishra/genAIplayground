/**
 * ContextSnapshot (follow-on prompt section 7, context assembly; FO-04-08).
 *
 * The task-specific context handed to the harness and the response gate: explicit facts with
 * provenance and freshness, citations, a small template-assembled timeline summary whose claims
 * link to supporting facts, and an honest coverage report (covered and unavailable sources,
 * watermarks, truncation, conflicts, omissions). A partial snapshot is never labelled COMPLETE.
 * It is assembled only after authorization, under current identity, purpose and ACL filters.
 *
 * Created by WP-02 in phase B; owned by WP-24 from phase D.
 */
import { z } from "zod";
import { ContextFact, FactId, SourceWatermark, WatermarkId } from "./context-facts.js";
import {
  Assurance,
  Classification,
  ProcessingPurpose,
  Role,
  Sha256Hex,
  SourceSystemId,
  VersionLabel,
  envelope,
  isAfter,
  opaqueIdWithPrefix,
} from "./common.js";
import { CitationId } from "./knowledge.js";
import { PolicyPurpose } from "./policy.js";

export const CONTEXT_SNAPSHOT_SCHEMA_VERSION = "context-snapshot.v1";

/** Sensitivity order used for the snapshot classification ceiling. VERIFICATION_SECRET is never context. */
export const CLASSIFICATION_RANK: Readonly<Record<Classification, number>> = {
  PUBLIC: 0,
  INTERNAL: 1,
  FINANCIAL: 2,
  PHI: 3,
  PHI_RESTRICTED: 4,
  VERIFICATION_SECRET: 99,
};

export const AclFilterKind = z.enum(["TENANT", "SUBJECT", "ROLE_SCOPE", "RELATIONSHIP", "PURPOSE", "CLASSIFICATION_CEILING", "CONSENT", "PART2_SEGMENT"]);

const ReasonCode = z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/);

export const ContextSnapshot = z
  .strictObject({
    ...envelope(CONTEXT_SNAPSHOT_SCHEMA_VERSION, ["tenantId", "interactionId", "sessionGeneration", "occurredAt", "expiresAt"], ["caseId", "subjectRef", "turnId", "causationId"]),
    snapshotId: opaqueIdWithPrefix("ctx"),
    /** Incremented by every versioned context update pushed to the conversation. */
    revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    purpose: ProcessingPurpose,
    policyPurpose: PolicyPurpose,
    scope: z.strictObject({
      selectedRole: Role.nullable(),
      assurance: Assurance,
      policyVersion: VersionLabel,
      relationshipVersion: VersionLabel,
      classificationCeiling: Classification,
      /** Filters applied before search and checked again on return. */
      aclFilters: z.array(z.strictObject({ kind: AclFilterKind, ref: z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:@-]+$/) })).min(1).max(16),
    }),
    facts: z.array(ContextFact).max(256),
    citations: z.array(CitationId).max(32),
    /** Template-assembled summary; every claim links to supporting facts (never a model-written fact). */
    timelineSummary: z
      .strictObject({ templateId: z.string().regex(/^[a-z][a-z0-9_.]{2,80}$/), text: z.string().min(1).max(600), supportingFactIds: z.array(FactId).min(1).max(32) })
      .nullable(),
    coverage: z.strictObject({
      coveredSources: z.array(z.strictObject({ system: SourceSystemId, watermarkId: WatermarkId })).max(32),
      unavailableSources: z.array(z.strictObject({ system: SourceSystemId, reasonCode: ReasonCode })).max(32),
      truncated: z.boolean(),
      truncationReason: ReasonCode.nullable(),
      omissions: z.array(z.strictObject({ reasonCode: ReasonCode, count: z.number().int().min(1).max(100_000) })).max(16),
      conflicts: z
        .array(
          z.strictObject({
            factType: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,5}$/),
            factIds: z.array(FactId).min(2).max(8),
            resolution: z.enum(["AUTHORITATIVE_SOURCE_SELECTED", "AUTHORITATIVE_SOURCE_QUERIED", "UNRESOLVED_SURFACED"]),
            selectedFactId: FactId.nullable(),
          }),
        )
        .max(16),
    }),
    completeness: z.enum(["COMPLETE", "PARTIAL"]),
    watermarks: z.array(SourceWatermark).max(32),
    /** sha256 over tenant, subject, role, purpose, policy and relationship versions and data revision. */
    cacheKeyDigest: Sha256Hex,
    budget: z.strictObject({
      tokenBudget: z.number().int().min(0).max(1_000_000),
      latencyBudgetMs: z.number().int().min(0).max(60_000),
      assemblyMs: z.number().int().min(0).max(600_000),
    }),
  })
  .superRefine((s, ctx) => {
    if (!isAfter(s.expiresAt, s.occurredAt)) ctx.addIssue({ code: "custom", message: "SNAPSHOT_EXPIRY_NOT_AFTER_ASSEMBLY", path: ["expiresAt"] });
    if (s.scope.classificationCeiling === "VERIFICATION_SECRET") ctx.addIssue({ code: "custom", message: "VERIFICATION_SECRET_CEILING", path: ["scope", "classificationCeiling"] });
    const ceiling = CLASSIFICATION_RANK[s.scope.classificationCeiling];
    const ids = new Set<string>();
    s.facts.forEach((f, i) => {
      ids.add(f.factId);
      if (f.tenantId !== s.tenantId) ctx.addIssue({ code: "custom", message: "FACT_FROM_OTHER_TENANT", path: ["facts", i, "tenantId"] });
      if (f.subjectRef !== null && f.subjectRef !== s.subjectRef) ctx.addIssue({ code: "custom", message: "FACT_FOR_OTHER_SUBJECT", path: ["facts", i, "subjectRef"] });
      // In a subject-scoped snapshot only PUBLIC or INTERNAL facts may be subject-less; any fact
      // above INTERNAL must name the snapshot's subject, so the subject check cannot be skipped.
      if (s.subjectRef !== null && f.subjectRef === null && CLASSIFICATION_RANK[f.dataClassification] > CLASSIFICATION_RANK.INTERNAL) {
        ctx.addIssue({ code: "custom", message: "SUBJECT_DATA_WITHOUT_SUBJECT", path: ["facts", i, "subjectRef"] });
      }
      if (CLASSIFICATION_RANK[f.dataClassification] > ceiling) ctx.addIssue({ code: "custom", message: "FACT_ABOVE_CLASSIFICATION_CEILING", path: ["facts", i, "dataClassification"] });
      if (!f.allowedPurposes.includes(s.purpose)) ctx.addIssue({ code: "custom", message: "FACT_PURPOSE_NOT_ALLOWED", path: ["facts", i, "allowedPurposes"] });
      // A retracted fact, or one expired when the snapshot was assembled, is not usable context.
      if (f.lineage.retracted) ctx.addIssue({ code: "custom", message: "RETRACTED_FACT_IN_SNAPSHOT", path: ["facts", i, "lineage", "retracted"] });
      if (f.expiresAt !== null && !isAfter(f.expiresAt, s.occurredAt)) ctx.addIssue({ code: "custom", message: "EXPIRED_FACT_IN_SNAPSHOT", path: ["facts", i, "expiresAt"] });
    });
    s.timelineSummary?.supportingFactIds.forEach((id, i) => {
      if (!ids.has(id)) ctx.addIssue({ code: "custom", message: "SUMMARY_CLAIM_WITHOUT_FACT", path: ["timelineSummary", "supportingFactIds", i] });
    });
    s.coverage.conflicts.forEach((c, i) => {
      if (c.resolution === "AUTHORITATIVE_SOURCE_SELECTED" && (c.selectedFactId === null || !c.factIds.includes(c.selectedFactId))) {
        ctx.addIssue({ code: "custom", message: "CONFLICT_SELECTION_INVALID", path: ["coverage", "conflicts", i, "selectedFactId"] });
      }
    });
    // Watermarks belong to this snapshot's tenant, and coverage cites a watermark of the same source
    // system; a fact that names a watermark must name one carried by the snapshot (FO-04-09/10).
    const wmById = new Map(s.watermarks.map((w) => [w.watermarkId, w] as const));
    s.watermarks.forEach((w, i) => {
      if (w.tenantId !== s.tenantId) ctx.addIssue({ code: "custom", message: "WATERMARK_FROM_OTHER_TENANT", path: ["watermarks", i, "tenantId"] });
    });
    s.facts.forEach((f, i) => {
      if (f.watermarkId !== null && !wmById.has(f.watermarkId)) ctx.addIssue({ code: "custom", message: "FACT_WATERMARK_NOT_IN_SNAPSHOT", path: ["facts", i, "watermarkId"] });
    });
    let coveredSourceWithGap = false;
    s.coverage.coveredSources.forEach((c, i) => {
      const w = wmById.get(c.watermarkId);
      if (!w) {
        ctx.addIssue({ code: "custom", message: "COVERED_SOURCE_WITHOUT_WATERMARK", path: ["coverage", "coveredSources", i] });
        return;
      }
      if (w.source.system !== c.system) ctx.addIssue({ code: "custom", message: "COVERED_SOURCE_SYSTEM_MISMATCH", path: ["coverage", "coveredSources", i, "system"] });
      // A detected gap, an unverified silence or an in-progress reconciliation means the covered
      // source may be missing events: the snapshot is partial, whatever else it reports (section 7).
      if (w.gapState !== "NO_GAP_DETECTED") coveredSourceWithGap = true;
    });
    if (s.coverage.truncated !== (s.coverage.truncationReason !== null)) {
      ctx.addIssue({ code: "custom", message: "TRUNCATION_REASON_MISMATCH", path: ["coverage", "truncationReason"] });
    }
    const partial =
      s.coverage.unavailableSources.length > 0 ||
      s.coverage.truncated ||
      s.coverage.omissions.length > 0 ||
      s.coverage.conflicts.some((c) => c.resolution === "UNRESOLVED_SURFACED") ||
      coveredSourceWithGap;
    if (partial && s.completeness === "COMPLETE") ctx.addIssue({ code: "custom", message: "PARTIAL_SNAPSHOT_LABELLED_COMPLETE", path: ["completeness"] });
  });
export type ContextSnapshot = z.infer<typeof ContextSnapshot>;
