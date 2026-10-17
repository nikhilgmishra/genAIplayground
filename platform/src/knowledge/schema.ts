/**
 * Strict schemas and normalization for knowledge items and search input.
 */
import { z } from "zod";
import { Assurance, IsoDateTime, OpaqueId, Role } from "../protocol/index.js";
import { digestOf, sha256Hex } from "../shared/canonical.js";

export const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{2,63}$/;
export const INTENT = /^[a-z][a-z0-9_]{2,63}$/;
export const OWNER = /^[a-z][a-z0-9_.-]{2,79}$/;
export const APPROVER = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{2,79}$/;
export const JURISDICTION = /^[A-Z]{2}(-[A-Z0-9]{1,3})?$/;
export const LANGUAGE = /^[a-z]{2,3}(-[A-Za-z]{2})?$/;

export const KnowledgeAudience = z.union([Role, z.literal("public")]);

export const MAX_BODY_CHARS = 20_000;
export const MAX_BATCH = 500;

/**
 * Structural schema. `owner` is nullable here so an unowned item produces the
 * reason code KNOWLEDGE_UNOWNED instead of a generic schema failure.
 */
export const KnowledgeItemInputSchema = z.strictObject({
  sourceId: z.string().regex(SOURCE_ID),
  sourceSystem: z.enum(["salesforce_knowledge", "approved_runbook"]),
  version: z.number().int().min(1).max(1_000_000),
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(MAX_BODY_CHARS),
  owner: z.string().max(120).nullable(),
  audiences: z.array(KnowledgeAudience).min(1).max(8),
  permittedIntents: z.array(z.string().regex(INTENT)).min(1).max(16),
  jurisdiction: z.string().regex(JURISDICTION),
  language: z.string().regex(LANGUAGE),
  effectiveFrom: IsoDateTime,
  expiresAt: IsoDateTime.nullable(),
  sensitivity: z.enum(["PUBLIC", "INTERNAL"]),
  approval: z.strictObject({
    status: z.enum(["APPROVED", "PENDING", "REJECTED"]),
    approvedBy: z.string().max(120).nullable(),
    approvedAt: IsoDateTime.nullable(),
  }),
});
export type ParsedKnowledgeItem = z.infer<typeof KnowledgeItemInputSchema>;

/** A structurally valid, sanitized item ready for policy evaluation and storage. */
export interface NormalizedKnowledgeItem {
  sourceId: string;
  sourceSystem: "salesforce_knowledge" | "approved_runbook";
  version: number;
  title: string;
  body: string;
  owner: string;
  audiences: string[];
  permittedIntents: string[];
  jurisdiction: string;
  language: string;
  effectiveFrom: string;
  expiresAt: string | null;
  sensitivity: "PUBLIC" | "INTERNAL";
  approval: ParsedKnowledgeItem["approval"];
  /** sha256 over sanitized title + body. */
  contentDigest: string;
  /** sha256 over every field except approval. */
  itemDigest: string;
}

export const normalizeLanguage = (lang: string): string => lang.toLowerCase();

export function contentDigestOf(title: string, body: string): string {
  return sha256Hex(`${title}\n\n${body}`);
}

export function itemDigestOf(i: Omit<NormalizedKnowledgeItem, "itemDigest" | "approval" | "contentDigest">): string {
  return digestOf({
    sourceId: i.sourceId,
    sourceSystem: i.sourceSystem,
    version: i.version,
    title: i.title,
    body: i.body,
    owner: i.owner,
    audiences: i.audiences,
    permittedIntents: i.permittedIntents,
    jurisdiction: i.jurisdiction,
    language: i.language,
    effectiveFrom: i.effectiveFrom,
    expiresAt: i.expiresAt,
    sensitivity: i.sensitivity,
  });
}

export const citationIdFor = (sourceId: string, version: number): string => `kb_${sourceId}@v${version}`;

export const SearchInputSchema = z.strictObject({
  tenantId: OpaqueId,
  query: z.string().min(1).max(500),
  audience: KnowledgeAudience,
  intent: z.string().regex(INTENT),
  language: z.string().regex(LANGUAGE),
  jurisdiction: z.string().regex(JURISDICTION),
  now: z.date().refine((d) => Number.isFinite(d.getTime()), "valid date"),
  limit: z.number().int().min(1).max(10),
  assurance: Assurance.optional(),
});
export type SearchInput = z.infer<typeof SearchInputSchema>;
