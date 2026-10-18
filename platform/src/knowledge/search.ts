/**
 * Permission-filtered retrieval over the approved corpus (spec section 9:
 * "Retrieve by authorization and policy filters before semantic search, and
 * filter results again before return").
 *
 * Order of operations:
 *  1. strict input validation; the audience/assurance are server-established;
 *  2. the database transaction runs as app_runtime with tenant RLS, whose
 *     policy only exposes SERVABLE rows (approved, not quarantined, not held,
 *     not superseded);
 *  3. a MATERIALIZED `permitted` CTE applies tenant, approval, quarantine,
 *     hold, supersession, effective window (against the supplied `now`),
 *     permitted intent, language, jurisdiction and audience filters BEFORE any
 *     ranking, so an item the caller may not see can never occupy a result
 *     slot or influence ordering;
 *  4. ranking among permitted rows only: ts_rank_cd over websearch_to_tsquery,
 *     plus optional pgvector cosine similarity (local fixture embedder offline);
 *  5. every returned row is re-checked in TypeScript against the same policy,
 *     its content digest is verified, and its excerpt is re-checked by the
 *     injection detector and sanitizer invariants before return.
 *
 * Audience rule: callers with assurance A0, or audience "public", see only
 * items with sensitivity PUBLIC that list the "public" audience. Other callers
 * see public items plus items that list their selected role.
 *
 * Hits carry citationId "kb_<sourceId>@v<version>" (exact version). Excerpts
 * are untrusted data for grounded low-risk paraphrase only; sensitive facts
 * come from structured source-of-truth tools, never from knowledge.
 */
import type { Db } from "../db/types.js";
import type { Logger, Metrics } from "../observability/ports.js";
import { stripControl, stripInvisible } from "../privacy/patterns.js";
import { sha256Hex } from "../shared/canonical.js";
import { ValidationError } from "../shared/errors.js";
import { toVectorLiteral, tokenize } from "./embedding.js";
import type { KnowledgeEmbedder } from "./embedding.js";
import { detectInjection } from "./injection.js";
import type { KnowledgeHit } from "./ports.js";
import { sanitizedTextViolations } from "./sanitize.js";
import { SearchInputSchema, citationIdFor } from "./schema.js";
import type { SearchInput } from "./schema.js";

export interface SearchTuning {
  /** Weight of full-text rank when vector similarity is available (vector weight = 1 - textWeight). */
  textWeight: number;
  /** Minimum cosine similarity for a vector-only (no lexical match) candidate. */
  minVectorSimilarity: number;
  maxExcerptChars: number;
}

export const DEFAULT_SEARCH_TUNING: SearchTuning = { textWeight: 0.7, minVectorSimilarity: 0.35, maxExcerptChars: 320 };

export interface SearchDeps {
  db: Db;
  logger: Logger;
  embedder: KnowledgeEmbedder | null;
  embeddingsAvailable: () => Promise<boolean>;
  tuning?: Partial<SearchTuning>;
  allowedLinkDomains?: readonly string[];
  /** Content-free vsp_knowledge_search_recheck_dropped_total{reason}. */
  metrics?: Metrics;
}

function countDropped(deps: SearchDeps, reason: string): void {
  try {
    deps.metrics?.increment("vsp_knowledge_search_recheck_dropped_total", { reason });
  } catch {
    // Metrics never re-admit a dropped hit.
  }
}

export interface RetrievedRow {
  tenant_id: string;
  source_id: string;
  version: number;
  title: string;
  body_sanitized: string;
  audiences: string[];
  permitted_intents: string[];
  sensitivity: string;
  language: string;
  jurisdiction: string;
  effective_from: Date | string;
  expires_at: Date | string | null;
  approval_status: string;
  quarantined: boolean;
  held_for_review: boolean;
  superseded_by_version: number | null;
  content_digest: string;
  score: number;
}

export interface DetailedHit extends KnowledgeHit {
  contentDigest: string;
}

export interface SearchOutcome {
  hits: DetailedHit[];
  /** Rows returned by SQL but rejected by the TypeScript re-check (should be zero). */
  droppedOnRecheck: number;
  usedVector: boolean;
  publicOnly: boolean;
}

export const isPublicOnly = (input: Pick<SearchInput, "audience" | "assurance">): boolean => input.audience === "public" || input.assurance === "A0";

const languageMatches = (itemLang: string, callerLang: string): boolean => {
  const c = callerLang.toLowerCase();
  return itemLang === c || itemLang === c.split("-")[0];
};
const jurisdictionMatches = (itemJur: string, callerJur: string): boolean => itemJur === callerJur || itemJur === callerJur.split("-")[0];

/** The same policy predicate the SQL applies, re-evaluated on each returned row. */
export function rowPermitted(row: RetrievedRow, input: SearchInput): { ok: true } | { ok: false; reasonCode: string } {
  const now = input.now.getTime();
  const publicOnly = isPublicOnly(input);
  const isPublicItem = row.sensitivity === "PUBLIC" && row.audiences.includes("public");
  if (row.tenant_id !== input.tenantId) return { ok: false, reasonCode: "RECHECK_TENANT_MISMATCH" };
  if (row.approval_status !== "APPROVED" || row.quarantined || row.held_for_review || row.superseded_by_version !== null) return { ok: false, reasonCode: "RECHECK_NOT_SERVABLE" };
  if (new Date(row.effective_from).getTime() > now) return { ok: false, reasonCode: "RECHECK_NOT_YET_EFFECTIVE" };
  if (row.expires_at !== null && new Date(row.expires_at).getTime() <= now) return { ok: false, reasonCode: "RECHECK_EXPIRED" };
  if (!row.permitted_intents.includes(input.intent)) return { ok: false, reasonCode: "RECHECK_INTENT_NOT_PERMITTED" };
  if (!languageMatches(row.language, input.language)) return { ok: false, reasonCode: "RECHECK_LANGUAGE_MISMATCH" };
  if (!jurisdictionMatches(row.jurisdiction, input.jurisdiction)) return { ok: false, reasonCode: "RECHECK_JURISDICTION_MISMATCH" };
  if (publicOnly ? !isPublicItem : !(isPublicItem || row.audiences.includes(input.audience))) return { ok: false, reasonCode: "RECHECK_AUDIENCE_NOT_PERMITTED" };
  if (sha256Hex(`${row.title}\n\n${row.body_sanitized}`) !== row.content_digest) return { ok: false, reasonCode: "RECHECK_CONTENT_DIGEST_MISMATCH" };
  return { ok: true };
}

/** Best-matching sentence(s) of the sanitized body, bounded in length. */
export function buildExcerpt(body: string, query: string, maxChars: number): string {
  const terms = new Set(tokenize(query));
  const sentences = body
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  let best = sentences[0] ?? "";
  let bestScore = -1;
  for (const s of sentences) {
    const score = tokenize(s).filter((t) => terms.has(t)).length;
    if (score > bestScore) {
      best = s;
      bestScore = score;
    }
  }
  if (best.length <= maxChars) return best;
  const cut = best.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > maxChars / 2 ? cut.slice(0, lastSpace) : cut).trim()}...`;
}

/**
 * Caller text becomes a bag of search terms: invisible/control characters,
 * quotes and negation operators are removed, and the terms are OR-ed in SQL so
 * a natural-language question matches articles that share any term (ranked by
 * how many and how often).
 */
export function cleanQuery(q: string): string {
  return stripControl(stripInvisible(q.normalize("NFKC")))
    .replace(/["\u201c\u201d]/g, " ")
    .replace(/(^|\s)[-!]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

const FTS_CONFIG_SQL = "(case split_part(lower($3), '-', 1) when 'en' then 'english' when 'es' then 'spanish' else 'simple' end)::regconfig";

export async function searchKnowledge(deps: SearchDeps, raw: unknown): Promise<SearchOutcome> {
  const parsed = SearchInputSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError("KNOWLEDGE_SEARCH_INPUT_INVALID");
  const input = parsed.data;
  const tuning = { ...DEFAULT_SEARCH_TUNING, ...deps.tuning };
  const publicOnly = isPublicOnly(input);
  const query = cleanQuery(input.query);
  if (query.length === 0) return { hits: [], droppedOnRecheck: 0, usedVector: false, publicOnly };

  const useVector = deps.embedder !== null && (await deps.embeddingsAvailable());
  const vector = useVector && deps.embedder ? toVectorLiteral(await deps.embedder.embed(query)) : null;
  const fetchLimit = Math.min(50, input.limit + 10);

  const params: unknown[] = [
    input.tenantId,
    query,
    input.language,
    input.jurisdiction,
    input.intent,
    input.now.toISOString(),
    publicOnly,
    publicOnly ? "" : input.audience,
    fetchLimit,
  ];
  let vectorSelect = "0::float8 as vec_sim";
  let vectorJoin = "";
  let match = "p.tsv @@ q.tsq";
  let score = "ts_rank_cd(p.tsv, q.tsq, 32)::float8";
  if (vector && deps.embedder) {
    params.push(vector, deps.embedder.modelId, tuning.minVectorSimilarity, tuning.textWeight);
    vectorJoin = "left join knowledge_embeddings e on e.tenant_id = p.tenant_id and e.source_id = p.source_id and e.version = p.version and e.embedding_model = $11";
    vectorSelect = "coalesce(1 - (e.embedding <=> $10::vector), 0)::float8 as vec_sim";
    match = "(p.tsv @@ q.tsq or coalesce(1 - (e.embedding <=> $10::vector), 0) >= $12)";
    score = "($13::float8 * ts_rank_cd(p.tsv, q.tsq, 32) + (1 - $13::float8) * coalesce(1 - (e.embedding <=> $10::vector), 0))::float8";
  }

  // Policy filters live in the MATERIALIZED CTE: they are applied before ranking and LIMIT.
  const sql = `
    with q as (select replace(websearch_to_tsquery(${FTS_CONFIG_SQL}, $2)::text, ' & ', ' | ')::tsquery as tsq),
    permitted as materialized (
      select k.tenant_id, k.source_id, k.version, k.title, k.body_sanitized, k.audiences, k.permitted_intents, k.sensitivity,
             k.language, k.jurisdiction, k.effective_from, k.expires_at, k.approval_status, k.quarantined, k.held_for_review,
             k.superseded_by_version, k.content_digest, k.tsv
        from knowledge_items k
       where k.tenant_id = $1
         and k.approval_status = 'APPROVED' and not k.quarantined and not k.held_for_review and k.superseded_by_version is null
         and k.effective_from <= $6::timestamptz and (k.expires_at is null or k.expires_at > $6::timestamptz)
         and $5 = any (k.permitted_intents)
         and (k.language = lower($3) or k.language = split_part(lower($3), '-', 1))
         and (k.jurisdiction = $4 or k.jurisdiction = split_part($4, '-', 1))
         and (case when $7::boolean then (k.sensitivity = 'PUBLIC' and 'public' = any (k.audiences))
                   else ((k.sensitivity = 'PUBLIC' and 'public' = any (k.audiences)) or $8 = any (k.audiences)) end)
    )
    select p.tenant_id, p.source_id, p.version, p.title, p.body_sanitized, p.audiences, p.permitted_intents, p.sensitivity, p.language,
           p.jurisdiction, p.effective_from, p.expires_at, p.approval_status, p.quarantined, p.held_for_review, p.superseded_by_version,
           p.content_digest, ${vectorSelect}, ${score} as score
      from permitted p cross join q
      ${vectorJoin}
     where ${match}
     order by score desc, p.source_id asc
     limit $9`;

  const rows = await deps.db.tx(async (tx) => (await tx.query<RetrievedRow>(sql, params)).rows, { role: "app_runtime", rls: { tenantId: input.tenantId } });

  const hits: DetailedHit[] = [];
  let dropped = 0;
  for (const row of rows) {
    const verdict = rowPermitted(row, input);
    if (!verdict.ok) {
      dropped += 1;
      deps.logger.warn("knowledge.search.recheck_dropped", { reasonCode: verdict.reasonCode, intent: input.intent });
      countDropped(deps, verdict.reasonCode);
      continue;
    }
    const excerpt = buildExcerpt(row.body_sanitized, query, tuning.maxExcerptChars);
    if (detectInjection(excerpt).length > 0 || detectInjection(row.title).length > 0 || sanitizedTextViolations(excerpt, deps.allowedLinkDomains).length > 0) {
      dropped += 1;
      deps.logger.warn("knowledge.search.recheck_dropped", { reasonCode: "RECHECK_EXCERPT_UNSAFE", intent: input.intent });
      countDropped(deps, "RECHECK_EXCERPT_UNSAFE");
      continue;
    }
    hits.push({
      citationId: citationIdFor(row.source_id, row.version),
      sourceId: row.source_id,
      version: row.version,
      title: row.title,
      excerpt,
      score: Math.round(Number(row.score) * 1e6) / 1e6,
      contentDigest: row.content_digest,
    });
    if (hits.length >= input.limit) break;
  }
  deps.logger.info("knowledge.search.completed", { intent: input.intent, count: hits.length, dropped, usedVector: useVector, publicOnly });
  return { hits, droppedOnRecheck: dropped, usedVector: useVector, publicOnly };
}
