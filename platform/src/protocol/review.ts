/**
 * ReviewRecord and DatasetItem (follow-on prompt sections 17 and 18).
 *
 * A ReviewRecord is a genuine human review (scenario, evaluation result, judge disagreement,
 * monitor flag, change proposal or sampled conversation): reviewer identity and role, labels with
 * severity, disagreement and a signature. Synthetic expected labels are never review records and a
 * scenario counts as HUMAN_REVIEWED only with one (AIN-31); software cannot author one.
 *
 * A DatasetItem records lineage for evaluation and training data: split at family level to prevent
 * leakage, provenance, license, consent/purpose, minimization and retention.
 *
 * Created by WP-02 in phase B; owned by WP-35 from phase F.
 */
import { z } from "zod";
import { EvidencePointer, IsoDateTime, ProcessingPurpose, Sha256Hex, StaffRole, envelope, isAfter, opaqueIdWithPrefix } from "./common.js";

export const REVIEW_RECORD_SCHEMA_VERSION = "review-record.v1";
export const DATASET_ITEM_SCHEMA_VERSION = "dataset-item.v1";

export const ReviewSubjectKind = z.enum(["SCENARIO", "EVALUATION_RESULT", "JUDGE_LABEL", "MONITOR_FLAG", "CHANGE_PROPOSAL", "CONVERSATION_SAMPLE", "SAFETY_TRANSFER"]);
export type ReviewSubjectKind = z.infer<typeof ReviewSubjectKind>;

export const ReviewSeverity = z.enum(["NONE", "MINOR", "MAJOR", "CRITICAL"]);

export const ReviewRecord = z
  .strictObject({
    ...envelope(REVIEW_RECORD_SCHEMA_VERSION, ["tenantId", "occurredAt"], ["causationId", "caseId", "interactionId"]),
    reviewId: opaqueIdWithPrefix("rvw"),
    subject: z.strictObject({ kind: ReviewSubjectKind, ref: z.string().regex(/^[A-Za-z0-9_.:@-]{3,128}$/), version: z.string().max(64).nullable() }),
    reviewer: z.strictObject({
      kind: z.literal("human"),
      staffId: z.string().regex(/^stf_[A-Za-z0-9_-]{8,64}$/),
      role: StaffRole,
      /** Clinical or domain qualification the review relies on, e.g. `clinical_safety_lead`. */
      qualification: z.string().regex(/^[a-z][a-z_]{2,40}$/).nullable(),
    }),
    labels: z
      .array(z.strictObject({ key: z.string().regex(/^[a-z][a-z0-9_.]{2,80}$/), value: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/), severity: ReviewSeverity }))
      .min(1)
      .max(32),
    verdict: z.enum(["PASS", "FAIL", "INCONCLUSIVE"]),
    disagreesWith: z.array(z.strictObject({ kind: z.enum(["JUDGE", "SYNTHETIC_EXPECTATION", "REVIEWER"]), ref: z.string().regex(/^[A-Za-z0-9_.:@-]{3,128}$/) })).max(8),
    rubricRef: EvidencePointer,
    signedAt: IsoDateTime,
    /** Detached signature by the reviewer's key; never synthesized (AIN-31). */
    signature: z.strictObject({ keyRef: z.string().regex(/^[A-Za-z0-9_:./-]{3,256}$/), value: z.string().min(16).max(1024).regex(/^[A-Za-z0-9_-]+$/) }),
  })
  .superRefine((r, ctx) => {
    if (r.verdict === "PASS" && r.labels.some((l) => l.severity === "CRITICAL")) ctx.addIssue({ code: "custom", message: "PASS_WITH_CRITICAL_LABEL", path: ["verdict"] });
    if (isAfter(r.occurredAt, r.signedAt)) ctx.addIssue({ code: "custom", message: "SIGNED_BEFORE_REVIEW", path: ["signedAt"] });
  });
export type ReviewRecord = z.infer<typeof ReviewRecord>;

/** Corpus splits; held-out items are never visible to optimizer feedback. */
export const DatasetSplit = z.enum(["development", "tuning", "heldout_acceptance", "regression"]);
export type DatasetSplit = z.infer<typeof DatasetSplit>;

export const DatasetProvenance = z.enum(["SYNTHETIC", "LICENSED", "CONSENTED_REVIEWED_PRODUCTION"]);

export const DatasetItem = z
  .strictObject({
    ...envelope(DATASET_ITEM_SCHEMA_VERSION, ["tenantId", "occurredAt", "dataClassification"], ["causationId", "expiresAt"]),
    itemId: opaqueIdWithPrefix("dsi"),
    datasetRef: z.string().regex(/^[a-z][a-z0-9_.-]{2,63}@[1-9][0-9]{0,5}$/),
    split: DatasetSplit,
    /** Family key (intent skeleton plus account); every item of a family is in the same split. */
    familyKey: z.string().regex(/^[a-z0-9][a-z0-9_.:-]{2,128}$/),
    provenance: DatasetProvenance,
    licenseRef: EvidencePointer.nullable(),
    consentRef: EvidencePointer.nullable(),
    purpose: ProcessingPurpose,
    minimizationApplied: z.boolean(),
    leakageCheckRef: EvidencePointer,
    contentRef: EvidencePointer,
    contentDigest: Sha256Hex,
    reviewRefs: z.array(opaqueIdWithPrefix("rvw")).max(8),
  })
  .superRefine((d, ctx) => {
    if (d.provenance === "LICENSED" && d.licenseRef === null) ctx.addIssue({ code: "custom", message: "LICENSED_WITHOUT_LICENSE", path: ["licenseRef"] });
    if (d.provenance === "CONSENTED_REVIEWED_PRODUCTION") {
      if (d.consentRef === null) ctx.addIssue({ code: "custom", message: "PRODUCTION_DATA_WITHOUT_CONSENT", path: ["consentRef"] });
      if (!d.minimizationApplied) ctx.addIssue({ code: "custom", message: "PRODUCTION_DATA_NOT_MINIMIZED", path: ["minimizationApplied"] });
      if (d.reviewRefs.length === 0) ctx.addIssue({ code: "custom", message: "PRODUCTION_DATA_UNREVIEWED", path: ["reviewRefs"] });
      if (d.expiresAt === null) ctx.addIssue({ code: "custom", message: "PRODUCTION_DATA_WITHOUT_RETENTION", path: ["expiresAt"] });
    }
    if (d.dataClassification === "VERIFICATION_SECRET") ctx.addIssue({ code: "custom", message: "VERIFICATION_SECRET_IN_DATASET", path: ["dataClassification"] });
    if (d.purpose === "marketing") ctx.addIssue({ code: "custom", message: "SUPPORT_DATA_FOR_MARKETING", path: ["purpose"] });
  });
export type DatasetItem = z.infer<typeof DatasetItem>;

/** Leakage check: no family key may appear in two splits. Returns the offending family keys. */
export function familiesLeakingAcrossSplits(items: readonly Pick<DatasetItem, "familyKey" | "split">[]): string[] {
  const seen = new Map<string, DatasetSplit>();
  const leaks = new Set<string>();
  for (const i of items) {
    const prior = seen.get(i.familyKey);
    if (prior !== undefined && prior !== i.split) leaks.add(i.familyKey);
    else seen.set(i.familyKey, i.split);
  }
  return [...leaks].sort();
}
