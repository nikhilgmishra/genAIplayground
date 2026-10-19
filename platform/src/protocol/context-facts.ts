/**
 * Context facts and source watermarks (follow-on prompt section 7; FO-04-09, FO-04-10).
 *
 * A ContextFact carries its own provenance, business-effective time separate from ingestion time,
 * classification, authority rank, verification status, expiry, allowed purposes and lineage, so a
 * context consumer can tell a verified source value from a caller report or an inference. A
 * SourceWatermark records how far a source feed is known to be complete; source silence is not
 * evidence of no activity.
 *
 * Created by WP-02 in phase B; owned by WP-18 from phase D.
 */
import { z } from "zod";
import {
  EvidencePointer,
  IsoDateTime,
  LocalDate,
  MAX_CLOCK_SKEW_MS,
  Money,
  OpaqueId,
  ProcessingPurpose,
  SourceSystemId,
  envelope,
  isAfter,
  opaqueIdWithPrefix,
} from "./common.js";

export const CONTEXT_FACT_SCHEMA_VERSION = "context-fact.v1";
export const SOURCE_WATERMARK_SCHEMA_VERSION = "source-watermark.v1";

export const FactId = opaqueIdWithPrefix("fct");
export const WatermarkId = opaqueIdWithPrefix("wmk");

/** Dotted fact type, e.g. `appointment.next.start`, `billing.balance`, `identity.portal_account.active`. */
export const FactType = z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,5}$/);

/** Verification status of a fact (follow-on prompt section 7). Memory and summaries never verify a fact (DATA-04). */
export const FactVerification = z.enum(["SOURCE_VERIFIED", "STAFF_ENTERED", "CALLER_REPORTED", "INFERRED"]);
export type FactVerification = z.infer<typeof FactVerification>;

/** Typed fact value. Free text is bounded and never authoritative for identity, consent or medical fact. */
export const FactValue = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("text"), value: z.string().max(400) }),
  z.strictObject({ kind: z.literal("number"), value: z.number().finite().min(-1e12).max(1e12) }),
  z.strictObject({ kind: z.literal("boolean"), value: z.boolean() }),
  z.strictObject({ kind: z.literal("money"), value: Money }),
  z.strictObject({ kind: z.literal("instant"), value: IsoDateTime }),
  z.strictObject({ kind: z.literal("date"), value: LocalDate }),
  z.strictObject({ kind: z.literal("code"), value: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/) }),
  z.strictObject({ kind: z.literal("reference"), value: OpaqueId }),
]);
export type FactValue = z.infer<typeof FactValue>;

/** Fact families no caller report, inference or summary can establish (AUTH-01, DATA-04). */
export const SOURCE_ONLY_FACT_PREFIXES = ["identity.", "authorization.", "delegation.", "consent.", "clinical."] as const;

export const ContextFact = z
  .strictObject({
    ...envelope(CONTEXT_FACT_SCHEMA_VERSION, ["tenantId", "occurredAt", "dataClassification"], ["subjectRef", "causationId", "expiresAt"]),
    factId: FactId,
    factType: FactType,
    value: FactValue,
    source: z.strictObject({
      system: SourceSystemId,
      /** Record identifier in the source system (opaque; never a name, phone number or date of birth). */
      recordRef: z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/),
      version: z.string().min(1).max(64).nullable(),
      eventId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/).nullable(),
    }),
    /** Business-effective validity interval; ingestion time never overwrites it. */
    effectiveFrom: IsoDateTime.nullable(),
    effectiveUntil: IsoDateTime.nullable(),
    sourceUpdatedAt: IsoDateTime.nullable(),
    receivedAt: IsoDateTime,
    observedAt: IsoDateTime,
    /** Higher wins under the signed per-field source-precedence configuration (0..100). */
    authorityRank: z.number().int().min(0).max(100),
    verification: FactVerification,
    allowedPurposes: z.array(ProcessingPurpose).min(1).max(13),
    evidenceRef: EvidencePointer,
    /** Facts an INFERRED fact (or a model summary claim) was derived from. */
    supportingFactIds: z.array(FactId).max(16),
    lineage: z.strictObject({
      supersedes: FactId.nullable(),
      correctionOf: FactId.nullable(),
      retracted: z.boolean(),
      retractionReason: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/).nullable(),
    }),
    watermarkId: WatermarkId.nullable(),
  })
  .superRefine((f, ctx) => {
    if (f.dataClassification === "VERIFICATION_SECRET") ctx.addIssue({ code: "custom", message: "FACT_HOLDS_VERIFICATION_SECRET", path: ["dataClassification"] });
    // PHI is about a person by definition: a PHI fact always names its subject, so a subject
    // filter can never be bypassed by leaving subjectRef empty (AUTH-05).
    if ((f.dataClassification === "PHI" || f.dataClassification === "PHI_RESTRICTED") && f.subjectRef === null) {
      ctx.addIssue({ code: "custom", message: "PHI_FACT_WITHOUT_SUBJECT", path: ["subjectRef"] });
    }
    if (f.effectiveFrom && f.effectiveUntil && !isAfter(f.effectiveUntil, f.effectiveFrom)) {
      ctx.addIssue({ code: "custom", message: "EFFECTIVE_INTERVAL_EMPTY", path: ["effectiveUntil"] });
    }
    if (SOURCE_ONLY_FACT_PREFIXES.some((p) => f.factType.startsWith(p)) && f.verification !== "SOURCE_VERIFIED") {
      ctx.addIssue({ code: "custom", message: "SOURCE_ONLY_FACT_NOT_SOURCE_VERIFIED", path: ["verification"] });
    }
    if (f.verification === "INFERRED" && f.supportingFactIds.length === 0) {
      ctx.addIssue({ code: "custom", message: "INFERRED_FACT_WITHOUT_SUPPORT", path: ["supportingFactIds"] });
    }
    if (f.verification !== "SOURCE_VERIFIED" && f.authorityRank > 50) {
      ctx.addIssue({ code: "custom", message: "UNVERIFIED_FACT_OUTRANKS_SOURCES", path: ["authorityRank"] });
    }
    if (f.lineage.retracted !== (f.lineage.retractionReason !== null)) {
      ctx.addIssue({ code: "custom", message: "RETRACTION_REASON_MISMATCH", path: ["lineage", "retractionReason"] });
    }
    if (f.lineage.supersedes === f.factId || f.lineage.correctionOf === f.factId) {
      ctx.addIssue({ code: "custom", message: "FACT_SUPERSEDES_ITSELF", path: ["lineage"] });
    }
  });
export type ContextFact = z.infer<typeof ContextFact>;

/** True when the fact is usable at `now`: not retracted, not expired and inside its effective interval. */
export function factIsCurrent(f: ContextFact, now: Date): boolean {
  const t = now.getTime();
  if (f.lineage.retracted) return false;
  if (f.expiresAt !== null && Date.parse(f.expiresAt) <= t) return false;
  if (f.effectiveFrom !== null && Date.parse(f.effectiveFrom) > t) return false;
  if (f.effectiveUntil !== null && Date.parse(f.effectiveUntil) <= t) return false;
  return true;
}

/** Position in a source stream: an opaque offset and/or the source event time. */
const StreamPosition = z
  .strictObject({
    offset: z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:/=+-]+$/).nullable(),
    eventTime: IsoDateTime.nullable(),
  })
  .refine((p) => p.offset !== null || p.eventTime !== null, "position needs an offset or an event time");

export const WatermarkGapState = z.enum(["NO_GAP_DETECTED", "GAP_DETECTED", "RECONCILING", "SOURCE_SILENT_UNVERIFIED"]);
export type WatermarkGapState = z.infer<typeof WatermarkGapState>;

/**
 * Per-source low/high watermark with heartbeat, expected/delivered counts, snapshot+delta boundary
 * and the freshness budget the context engine applies (FO-04-10).
 */
export const SourceWatermark = z
  .strictObject({
    ...envelope(SOURCE_WATERMARK_SCHEMA_VERSION, ["tenantId", "occurredAt"], ["causationId"]),
    watermarkId: WatermarkId,
    source: z.strictObject({
      system: SourceSystemId,
      stream: z.string().regex(/^[a-z][a-z0-9_.-]{1,63}$/),
      connectorProfileRef: OpaqueId.nullable(),
    }),
    low: StreamPosition,
    high: StreamPosition,
    lastEventReceivedAt: IsoDateTime.nullable(),
    lastHeartbeatAt: IsoDateTime.nullable(),
    expectedCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
    deliveredCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
    gapState: WatermarkGapState,
    snapshotBoundary: z.strictObject({ snapshotRef: z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:/-]+$/), deltaFromOffset: z.string().max(128).nullable() }).nullable(),
    reconciledAt: IsoDateTime.nullable(),
    /** Source-specific maximum age before facts from this source need a fresh authoritative read. */
    maxAgeMs: z.number().int().min(0).max(31 * 86_400_000),
  })
  .superRefine((w, ctx) => {
    const lo = w.low.eventTime;
    const hi = w.high.eventTime;
    if (lo && hi && Date.parse(hi) < Date.parse(lo)) ctx.addIssue({ code: "custom", message: "HIGH_WATERMARK_BEFORE_LOW", path: ["high"] });
    if (w.expectedCount !== null && w.deliveredCount !== null && w.deliveredCount < w.expectedCount && w.gapState === "NO_GAP_DETECTED") {
      ctx.addIssue({ code: "custom", message: "MISSING_EVENTS_REPORTED_AS_NO_GAP", path: ["gapState"] });
    }
    // Heartbeat and receipt times are stamped by the platform before it records the watermark, so
    // neither can be later than the record (beyond clock skew); a later one is not evidence.
    const recordedAt = Date.parse(w.occurredAt);
    for (const field of ["lastHeartbeatAt", "lastEventReceivedAt"] as const) {
      const at = w[field];
      if (at !== null && Date.parse(at) > recordedAt + MAX_CLOCK_SKEW_MS) ctx.addIssue({ code: "custom", message: "WATERMARK_EVIDENCE_AFTER_RECORD", path: [field] });
    }
  });
export type SourceWatermark = z.infer<typeof SourceWatermark>;

/**
 * Age of the newest evidence a watermark has for its source (heartbeat or last event), or null when
 * there is none. Null is "unknown freshness", never "fresh". Evidence stamped later than `now` plus
 * MAX_CLOCK_SKEW_MS (a clock fault or a forged heartbeat) makes the age unknown (null) instead of
 * zero: a future timestamp never makes a source look fresh.
 */
export function watermarkAgeMs(w: SourceWatermark, now: Date): number | null {
  const times = [w.lastHeartbeatAt, w.lastEventReceivedAt, w.high.eventTime].filter((t): t is string => t !== null).map((t) => Date.parse(t));
  if (times.length === 0) return null;
  const newest = Math.max(...times);
  if (newest > now.getTime() + MAX_CLOCK_SKEW_MS) return null;
  return Math.max(0, now.getTime() - newest);
}

/** Fresh only with known age within the budget and no detected or unverified gap. */
export function watermarkIsFresh(w: SourceWatermark, now: Date): boolean {
  const age = watermarkAgeMs(w, now);
  return age !== null && age <= w.maxAgeMs && w.gapState === "NO_GAP_DETECTED";
}
