/**
 * KnowledgeCitation (follow-on prompt section 8; FO-04-12).
 *
 * Every material factual assertion resolves to an allowed source span or field (no citation
 * laundering). A citation pins the exact article version, the knowledge snapshot digest, the span
 * and its digest, and the freshness and approval of the cited content. A retrieval rank is not a
 * confidence score or an authorization decision.
 *
 * Created by WP-02 in phase B; owned by WP-20 from phase D. The citation id keeps the existing
 * format of platform/src/knowledge/schema.ts citationIdFor().
 */
import { z } from "zod";
import { EvidencePointer, IsoDateTime, Jurisdiction, Role, Sha256Hex, envelope, isAfter } from "./common.js";

export const KNOWLEDGE_CITATION_SCHEMA_VERSION = "knowledge-citation.v1";

/** `kb_<sourceId>@v<version>` (platform/src/knowledge/schema.ts citationIdFor). */
export const CitationId = z.string().regex(/^kb_[A-Za-z0-9][A-Za-z0-9_.-]{2,63}@v[1-9][0-9]{0,8}$/, "knowledge citation id expected");
export type CitationId = z.infer<typeof CitationId>;

export const CitationSpan = z.discriminatedUnion("kind", [
  /** Character offsets into the approved article body of the pinned version. */
  z
    .strictObject({ kind: z.literal("chars"), start: z.number().int().min(0).max(1_000_000), end: z.number().int().min(1).max(1_000_000) })
    .refine((s) => s.end > s.start, "empty span"),
  /** A structured field of the article (e.g. `fees.lateCancellation`). */
  z.strictObject({ kind: z.literal("field"), fieldPath: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.]{0,80}$/) }),
]);
export type CitationSpan = z.infer<typeof CitationSpan>;

export const KnowledgeSensitivity = z.enum(["PUBLIC_FAQ", "PROTECTED_OPERATIONAL"]);

export const KnowledgeCitation = z
  .strictObject({
    ...envelope(KNOWLEDGE_CITATION_SCHEMA_VERSION, ["tenantId", "occurredAt"], ["causationId", "expiresAt"]),
    citationId: CitationId,
    articleVersion: z.number().int().min(1).max(999_999_999),
    snapshotDigest: Sha256Hex,
    span: CitationSpan,
    /** sha256 of the exact cited text or field value of the pinned version. */
    spanDigest: Sha256Hex,
    sensitivity: KnowledgeSensitivity,
    audiences: z.array(z.union([Role, z.literal("public")])).min(1).max(8),
    language: z.string().regex(/^[a-z]{2,3}(-[A-Za-z]{2})?$/),
    jurisdiction: Jurisdiction,
    effectiveFrom: IsoDateTime,
    approval: z.strictObject({ approvedAt: IsoDateTime, approvalRef: z.string().regex(/^apr_[A-Za-z0-9_-]{8,64}$/).nullable(), ownerRole: z.string().regex(/^[a-z][a-z_]{2,40}$/) }),
    retrieval: z.strictObject({
      method: z.enum(["FULL_TEXT", "VECTOR", "HYBRID", "HYBRID_RERANKED", "DIRECT_REFERENCE"]),
      /** 1-based position after ranking. Ranking order only; never a confidence or authorization signal. */
      rank: z.number().int().min(1).max(100),
    }),
    freshness: z.strictObject({ indexedAt: IsoDateTime, sourceUpdatedAt: IsoDateTime.nullable(), stale: z.boolean() }),
    sourceRef: EvidencePointer,
  })
  .superRefine((c, ctx) => {
    // The citation id names the version it cites (`kb_<source>@v<version>`); it must be the pinned one.
    if (c.citationId.slice(c.citationId.lastIndexOf("@v") + 2) !== String(c.articleVersion)) {
      ctx.addIssue({ code: "custom", message: "CITATION_VERSION_MISMATCH", path: ["articleVersion"] });
    }
    if (c.expiresAt !== null && !isAfter(c.expiresAt, c.effectiveFrom)) ctx.addIssue({ code: "custom", message: "CITATION_EXPIRES_BEFORE_EFFECTIVE", path: ["expiresAt"] });
    if (c.sensitivity === "PUBLIC_FAQ" && !c.audiences.includes("public")) {
      ctx.addIssue({ code: "custom", message: "PUBLIC_FAQ_WITHOUT_PUBLIC_AUDIENCE", path: ["audiences"] });
    }
  });
export type KnowledgeCitation = z.infer<typeof KnowledgeCitation>;

/** A citation is usable at `now` only when it is effective, unexpired and not marked stale. */
export function citationIsCurrent(c: KnowledgeCitation, now: Date): boolean {
  const t = now.getTime();
  if (c.freshness.stale) return false;
  if (Date.parse(c.effectiveFrom) > t) return false;
  return c.expiresAt === null || Date.parse(c.expiresAt) > t;
}
