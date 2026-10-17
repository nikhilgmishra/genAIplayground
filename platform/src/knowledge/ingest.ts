/**
 * Controlled knowledge ingestion pipeline (spec section 9). Salesforce
 * Knowledge exports and approved runbooks enter through this pipeline, never by
 * a blind paste of operational documents.
 *
 * Per item:
 *  1. strict structural validation (unknown fields fail);
 *  2. sanitization of title and body (sanitize.ts);
 *  3. prompt-injection / dial-target detection on BOTH the raw (entity-decoded)
 *     input and the sanitized output, so instructions hidden in stripped markup
 *     still quarantine the item;
 *  4. personal-data pattern check (emails, SSN-like, card-like values):
 *     knowledge must not carry customer data;
 *  5. policy checks: approved with approver and time, owned, effective now,
 *     not expired, consistent window, public audience => PUBLIC sensitivity;
 *  6. version rules: a stored version is immutable (same version + different
 *     content => quarantined), older versions than the newest stored are stale;
 *  7. conflict detection against the batch and the stored corpus with approved
 *     source precedence (conflicts.ts);
 *  8. pinned snapshot (version + digest) of the servable corpus (OPS-06).
 */
import type { Queryable } from "../db/types.js";
import { detectSensitiveSpans } from "../privacy/patterns.js";
import { findConflicts, keyOf, resolveConflicts } from "./conflicts.js";
import type { ConflictCandidate, SourcePrecedence } from "./conflicts.js";
import { toVectorLiteral } from "./embedding.js";
import type { KnowledgeEmbedder } from "./embedding.js";
import { detectInjection } from "./injection.js";
import type { IngestReport } from "./ports.js";
import { sanitizeKnowledgeText } from "./sanitize.js";
import { APPROVER, KnowledgeItemInputSchema, OWNER, SOURCE_ID, contentDigestOf, itemDigestOf, normalizeLanguage } from "./schema.js";
import type { NormalizedKnowledgeItem } from "./schema.js";
import { computeSnapshot, persistSnapshotIfChanged } from "./snapshot.js";

export interface EvaluationContext {
  now: Date;
  allowedLinkDomains?: readonly string[];
}

export type ItemEvaluation =
  | { kind: "invalid"; sourceId: string; reasonCodes: string[] }
  | { kind: "evaluated"; item: NormalizedKnowledgeItem; reasonCodes: string[]; findings: string[] };

const decodeForDetection = (s: string): string =>
  s
    .replace(/&#x([0-9a-f]{1,6});?/gi, (_m, h: string) => safeChar(Number.parseInt(h, 16)))
    .replace(/&#(\d{1,7});?/g, (_m, d: string) => safeChar(Number.parseInt(d, 10)))
    .replace(/&(lt|gt|amp|quot|apos|nbsp|colon);?/gi, (_m, n: string) => ({ lt: "<", gt: ">", amp: "&", quot: '"', apos: "'", nbsp: " ", colon: ":" })[n.toLowerCase()] ?? "");

function safeChar(cp: number): string {
  return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : "";
}

/** Pure evaluation of one raw item. Deterministic for a given input and context. */
export function evaluateKnowledgeItem(raw: unknown, index: number, ctx: EvaluationContext): ItemEvaluation {
  const fallbackId =
    raw && typeof raw === "object" && typeof (raw as { sourceId?: unknown }).sourceId === "string" && SOURCE_ID.test((raw as { sourceId: string }).sourceId)
      ? (raw as { sourceId: string }).sourceId
      : `unparseable-item-${index}`;
  const parsed = KnowledgeItemInputSchema.safeParse(raw);
  if (!parsed.success) {
    const ownerOnly = parsed.error.issues.every((i) => i.path[0] === "owner");
    return { kind: "invalid", sourceId: fallbackId, reasonCodes: [ownerOnly ? "KNOWLEDGE_UNOWNED" : "KNOWLEDGE_SCHEMA_INVALID"] };
  }
  const p = parsed.data;
  if (p.owner === null || !OWNER.test(p.owner.trim())) {
    return { kind: "invalid", sourceId: p.sourceId, reasonCodes: ["KNOWLEDGE_UNOWNED"] };
  }

  const reasons = new Set<string>();
  const sanitizedTitle = sanitizeKnowledgeText(p.title, { allowedLinkDomains: ctx.allowedLinkDomains });
  const sanitizedBody = sanitizeKnowledgeText(p.body, { allowedLinkDomains: ctx.allowedLinkDomains });
  const findings = [...new Set([...sanitizedTitle.findings, ...sanitizedBody.findings])].sort();
  if (sanitizedTitle.quarantineFindings.length + sanitizedBody.quarantineFindings.length > 0) reasons.add("KNOWLEDGE_EXECUTABLE_CONTENT");
  for (const f of [...sanitizedTitle.quarantineFindings, ...sanitizedBody.quarantineFindings]) reasons.add(`KNOWLEDGE_${f}`);
  if (sanitizedTitle.text.length === 0 || sanitizedBody.text.length === 0) reasons.add("KNOWLEDGE_EMPTY_AFTER_SANITIZE");

  for (const text of [p.title, p.body, decodeForDetection(p.title), decodeForDetection(p.body), sanitizedTitle.text, sanitizedBody.text]) {
    for (const code of detectInjection(text)) reasons.add(code);
  }
  if (detectSensitiveSpans(`${p.title}\n${p.body}`).some((s) => s.type === "EMAIL" || s.type === "SSN" || s.type === "CARD")) {
    reasons.add("KNOWLEDGE_PERSONAL_DATA_PATTERN");
  }

  // Policy checks.
  const now = ctx.now.getTime();
  const effectiveFrom = Date.parse(p.effectiveFrom);
  const expiresAt = p.expiresAt === null ? null : Date.parse(p.expiresAt);
  if (p.approval.status === "PENDING") reasons.add("KNOWLEDGE_NOT_APPROVED");
  if (p.approval.status === "REJECTED") reasons.add("KNOWLEDGE_APPROVAL_REJECTED");
  if (p.approval.status === "APPROVED") {
    if (p.approval.approvedBy === null || !APPROVER.test(p.approval.approvedBy) || p.approval.approvedAt === null) reasons.add("KNOWLEDGE_APPROVAL_INCOMPLETE");
    else if (Date.parse(p.approval.approvedAt) > now) reasons.add("KNOWLEDGE_APPROVAL_IN_FUTURE");
  }
  if (expiresAt !== null && expiresAt <= effectiveFrom) reasons.add("KNOWLEDGE_WINDOW_INVALID");
  if (expiresAt !== null && expiresAt <= now) reasons.add("KNOWLEDGE_EXPIRED");
  if (effectiveFrom > now) reasons.add("KNOWLEDGE_NOT_YET_EFFECTIVE");
  if (p.audiences.includes("public") && p.sensitivity !== "PUBLIC") reasons.add("KNOWLEDGE_PUBLIC_AUDIENCE_REQUIRES_PUBLIC_SENSITIVITY");
  if (new Set(p.audiences).size !== p.audiences.length || new Set(p.permittedIntents).size !== p.permittedIntents.length) reasons.add("KNOWLEDGE_DUPLICATE_METADATA_VALUES");

  const title = sanitizedTitle.text.slice(0, 200) || "untitled";
  const body = sanitizedBody.text.slice(0, 20_000) || "empty";
  const base = {
    sourceId: p.sourceId,
    sourceSystem: p.sourceSystem,
    version: p.version,
    title,
    body,
    owner: p.owner.trim(),
    audiences: [...new Set(p.audiences)].sort(),
    permittedIntents: [...new Set(p.permittedIntents)].sort(),
    jurisdiction: p.jurisdiction,
    language: normalizeLanguage(p.language),
    effectiveFrom: new Date(effectiveFrom).toISOString(),
    expiresAt: expiresAt === null ? null : new Date(expiresAt).toISOString(),
    sensitivity: p.sensitivity,
  };
  const item: NormalizedKnowledgeItem = {
    ...base,
    approval: p.approval,
    contentDigest: contentDigestOf(title, body),
    itemDigest: itemDigestOf(base),
  };
  return { kind: "evaluated", item, reasonCodes: [...reasons].sort(), findings };
}

interface StoredRow {
  source_id: string;
  version: number;
  source_system: "salesforce_knowledge" | "approved_runbook";
  audiences: string[];
  permitted_intents: string[];
  language: string;
  jurisdiction: string;
  effective_from: Date | string;
  expires_at: Date | string | null;
  content_digest: string;
  item_digest: string;
  approval_status: string;
  quarantined: boolean;
  held_for_review: boolean;
  review_reasons: string[];
  quarantine_reasons: string[];
  superseded_by_version: number | null;
}

const isoOf = (v: Date | string | null): string | null => (v === null ? null : new Date(v).toISOString());

function candidateFromRow(r: StoredRow): ConflictCandidate {
  return {
    sourceId: r.source_id,
    version: r.version,
    sourceSystem: r.source_system,
    audiences: r.audiences,
    permittedIntents: r.permitted_intents,
    language: r.language,
    jurisdiction: r.jurisdiction,
    effectiveFrom: isoOf(r.effective_from) ?? "",
    expiresAt: isoOf(r.expires_at),
    contentDigest: r.content_digest,
  };
}

const candidateFromItem = (i: NormalizedKnowledgeItem): ConflictCandidate => ({
  sourceId: i.sourceId,
  version: i.version,
  sourceSystem: i.sourceSystem,
  audiences: i.audiences,
  permittedIntents: i.permittedIntents,
  language: i.language,
  jurisdiction: i.jurisdiction,
  effectiveFrom: i.effectiveFrom,
  expiresAt: i.expiresAt,
  contentDigest: i.contentDigest,
});

export interface IngestDeps {
  now: Date;
  allowedLinkDomains?: readonly string[];
  precedence?: SourcePrecedence | null;
  embedder?: KnowledgeEmbedder | null;
  embeddingsAvailable: boolean;
}

export interface IngestOutcome extends IngestReport {
  previousSnapshotDigest: string | null;
}

/**
 * Runs the pipeline inside the caller's transaction (role app_worker, tenant RLS).
 * Serialized per tenant with a transaction-scoped advisory lock.
 */
export async function runIngest(tx: Queryable, tenantId: string, rawItems: readonly unknown[], deps: IngestDeps): Promise<IngestOutcome> {
  const nowIso = deps.now.toISOString();
  await tx.query("select pg_advisory_xact_lock(hashtext($1))", [`knowledge:${tenantId}`]);

  const quarantined = new Map<string, Set<string>>();
  const addQuarantine = (sourceId: string, codes: readonly string[]) => {
    const set = quarantined.get(sourceId) ?? new Set<string>();
    for (const c of codes) set.add(c);
    quarantined.set(sourceId, set);
  };
  const accepted = new Set<string>();

  // 1-5: evaluate; reject duplicates within the batch.
  const seen = new Set<string>();
  const evaluated: Extract<ItemEvaluation, { kind: "evaluated" }>[] = [];
  rawItems.forEach((raw, index) => {
    const ev = evaluateKnowledgeItem(raw, index, { now: deps.now, allowedLinkDomains: deps.allowedLinkDomains });
    if (ev.kind === "invalid") {
      addQuarantine(ev.sourceId, ev.reasonCodes);
      return;
    }
    const key = keyOf(ev.item);
    if (seen.has(key)) {
      addQuarantine(ev.item.sourceId, ["KNOWLEDGE_DUPLICATE_IN_BATCH"]);
      return;
    }
    seen.add(key);
    evaluated.push(ev);
  });
  evaluated.sort((x, y) => x.item.sourceId.localeCompare(y.item.sourceId) || x.item.version - y.item.version);

  const stored = (
    await tx.query<StoredRow>(
      `select source_id, version, source_system, audiences, permitted_intents, language, jurisdiction, effective_from, expires_at,
              content_digest, item_digest, approval_status, quarantined, held_for_review, review_reasons, quarantine_reasons, superseded_by_version
         from knowledge_items where tenant_id = $1`,
      [tenantId],
    )
  ).rows;
  const storedByKey = new Map(stored.map((r) => [`${r.source_id}@v${r.version}`, r]));
  const maxVersion = new Map<string, number>();
  for (const r of stored) maxVersion.set(r.source_id, Math.max(maxVersion.get(r.source_id) ?? 0, r.version));

  // 6: version rules; split into quarantine inserts/updates, revivals and new candidates.
  const quarantineInserts: Extract<ItemEvaluation, { kind: "evaluated" }>[] = [];
  const quarantineUpdates: Extract<ItemEvaluation, { kind: "evaluated" }>[] = [];
  const candidates: { item: NormalizedKnowledgeItem; existing: boolean }[] = [];
  for (const ev of evaluated) {
    const { item } = ev;
    const existing = storedByKey.get(keyOf(item));
    if (existing) {
      if (existing.item_digest !== item.itemDigest) {
        addQuarantine(item.sourceId, ["KNOWLEDGE_VERSION_IMMUTABLE"]);
        continue;
      }
      if (existing.superseded_by_version !== null) {
        addQuarantine(item.sourceId, ["KNOWLEDGE_VERSION_SUPERSEDED"]);
        continue;
      }
      if (ev.reasonCodes.length > 0) {
        quarantineUpdates.push(ev);
        addQuarantine(item.sourceId, ev.reasonCodes);
        continue;
      }
      if (!existing.quarantined && existing.approval_status === "APPROVED") {
        if (existing.held_for_review) addQuarantine(item.sourceId, existing.review_reasons);
        else accepted.add(item.sourceId);
        continue;
      }
      candidates.push({ item, existing: true });
      continue;
    }
    if ((maxVersion.get(item.sourceId) ?? 0) > item.version) {
      addQuarantine(item.sourceId, ["KNOWLEDGE_VERSION_STALE"]);
      continue;
    }
    if (ev.reasonCodes.length > 0) {
      quarantineInserts.push(ev);
      addQuarantine(item.sourceId, ev.reasonCodes);
      continue;
    }
    candidates.push({ item, existing: false });
  }

  // 7: conflicts against the batch and the stored live/held corpus.
  const candidateSources = new Set(candidates.map((c) => c.item.sourceId));
  const comparable = stored.filter(
    (r) => r.approval_status === "APPROVED" && !r.quarantined && r.superseded_by_version === null && !candidateSources.has(r.source_id),
  );
  const pairs = findConflicts(candidates.map((c) => candidateFromItem(c.item)), comparable.map(candidateFromRow));
  const resolution = resolveConflicts(pairs, deps.precedence);
  // Newest candidate version per source that ends up live (not held): it supersedes older versions.
  const newestLive = new Map<string, number>();
  for (const c of candidates) {
    if (resolution.held.has(keyOf(c.item))) continue;
    newestLive.set(c.item.sourceId, Math.max(newestLive.get(c.item.sourceId) ?? 0, c.item.version));
  }

  // Writes.
  const insertSql = `insert into knowledge_items (
      tenant_id, source_id, version, source_system, title, body_sanitized, owner, audiences, permitted_intents, jurisdiction, language,
      effective_from, expires_at, sensitivity, approval_status, approved_by, approved_at, content_digest, item_digest,
      quarantined, quarantine_reasons, held_for_review, review_reasons, superseded_by_version, ingested_at, status_changed_at)
    values ($1,$2,$3,$4,$5,$6,$7,$8::text[],$9::text[],$10,$11,$12::timestamptz,$13::timestamptz,$14,$15,$16,$17::timestamptz,$18,$19,
            $20,$21::text[],$22,$23::text[],$24,$25::timestamptz,$25::timestamptz)`;
  const insertParams = (i: NormalizedKnowledgeItem, q: string[], held: string[], supersededBy: number | null) => [
    tenantId,
    i.sourceId,
    i.version,
    i.sourceSystem,
    i.title,
    i.body,
    i.owner,
    i.audiences,
    i.permittedIntents,
    i.jurisdiction,
    i.language,
    i.effectiveFrom,
    i.expiresAt,
    i.sensitivity,
    i.approval.status,
    i.approval.approvedBy,
    i.approval.approvedAt,
    i.contentDigest,
    i.itemDigest,
    q.length > 0,
    q,
    held.length > 0,
    held,
    supersededBy,
    nowIso,
  ];

  for (const ev of quarantineInserts) await tx.query(insertSql, insertParams(ev.item, ev.reasonCodes, [], null));
  for (const ev of quarantineUpdates) {
    await tx.query(
      `update knowledge_items set quarantined = true, quarantine_reasons = $4::text[], held_for_review = false, review_reasons = '{}',
              approval_status = $5, approved_by = $6, approved_at = $7::timestamptz, status_changed_at = $8::timestamptz
        where tenant_id = $1 and source_id = $2 and version = $3`,
      [tenantId, ev.item.sourceId, ev.item.version, ev.reasonCodes, ev.item.approval.status, ev.item.approval.approvedBy, ev.item.approval.approvedAt, nowIso],
    );
    await deleteEmbeddings(tx, deps, tenantId, ev.item.sourceId, ev.item.version);
  }

  for (const c of candidates) {
    const { item } = c;
    const newest = newestLive.get(item.sourceId) ?? 0;
    const supersededBy = newest > item.version ? newest : null;
    const heldReason = resolution.held.get(keyOf(item));
    const held = heldReason ? [heldReason] : [];
    if (c.existing) {
      await tx.query(
        `update knowledge_items set quarantined = false, quarantine_reasons = '{}', held_for_review = $4, review_reasons = $5::text[],
                approval_status = $6, approved_by = $7, approved_at = $8::timestamptz, superseded_by_version = $9, status_changed_at = $10::timestamptz
          where tenant_id = $1 and source_id = $2 and version = $3`,
        [tenantId, item.sourceId, item.version, held.length > 0, held, item.approval.status, item.approval.approvedBy, item.approval.approvedAt, supersededBy, nowIso],
      );
    } else {
      await tx.query(insertSql, insertParams(item, [], held, supersededBy));
    }
    // Superseded within this batch by a newer live version of the same source: not reported.
    if (supersededBy !== null) continue;
    if (held.length > 0) {
      addQuarantine(item.sourceId, held);
      await upsertEmbedding(tx, deps, tenantId, item, nowIso);
      continue;
    }
    accepted.add(item.sourceId);
    await upsertEmbedding(tx, deps, tenantId, item, nowIso);
    // A live new version supersedes every older stored version of the same source.
    const older = await tx.query<{ version: number }>(
      `update knowledge_items set superseded_by_version = $3, status_changed_at = $4::timestamptz
        where tenant_id = $1 and source_id = $2 and version < $3 and superseded_by_version is null returning version`,
      [tenantId, item.sourceId, item.version, nowIso],
    );
    for (const r of older.rows) await deleteEmbeddings(tx, deps, tenantId, item.sourceId, r.version);
  }

  // Stored items newly held because a new candidate conflicts with them.
  for (const r of comparable) {
    const reason = resolution.held.get(`${r.source_id}@v${r.version}`);
    if (!reason) continue;
    const reasons = [...new Set([...r.review_reasons, reason])].sort();
    await tx.query(
      `update knowledge_items set held_for_review = true, review_reasons = $4::text[], status_changed_at = $5::timestamptz
        where tenant_id = $1 and source_id = $2 and version = $3`,
      [tenantId, r.source_id, r.version, reasons, nowIso],
    );
    addQuarantine(r.source_id, [reason]);
  }

  // 8: snapshot.
  const previous = await tx.query<{ snapshot_digest: string }>(
    "select snapshot_digest from knowledge_snapshots where tenant_id = $1 order by snapshot_seq desc limit 1",
    [tenantId],
  );
  const snapshot = await computeSnapshot(tx, tenantId);
  const persisted = await persistSnapshotIfChanged(tx, tenantId, snapshot, nowIso);

  const conflictsOut = new Map<string, { sourceIds: string[]; reasonCode: string }>();
  for (const c of resolution.reported) conflictsOut.set(`${c.sourceIds.join("|")}:${c.reasonCode}`, c);
  return {
    accepted: [...accepted].sort(),
    quarantined: [...quarantined.entries()]
      .map(([sourceId, codes]) => ({ sourceId, reasonCodes: [...codes].sort() }))
      .sort((a, b) => a.sourceId.localeCompare(b.sourceId)),
    conflicts: [...conflictsOut.values()].sort((a, b) => a.sourceIds.join().localeCompare(b.sourceIds.join())),
    snapshotVersion: persisted.version,
    snapshotDigest: persisted.digest,
    previousSnapshotDigest: previous.rows[0]?.snapshot_digest ?? null,
  };
}

async function upsertEmbedding(tx: Queryable, deps: IngestDeps, tenantId: string, item: NormalizedKnowledgeItem, nowIso: string): Promise<void> {
  if (!deps.embeddingsAvailable || !deps.embedder) return;
  const vec = await deps.embedder.embed(`${item.title}\n${item.body}`);
  await tx.query("delete from knowledge_embeddings where tenant_id = $1 and source_id = $2 and version = $3 and embedding_model = $4", [
    tenantId,
    item.sourceId,
    item.version,
    deps.embedder.modelId,
  ]);
  await tx.query(
    "insert into knowledge_embeddings (tenant_id, source_id, version, embedding_model, embedding, created_at) values ($1, $2, $3, $4, $5::vector, $6::timestamptz)",
    [tenantId, item.sourceId, item.version, deps.embedder.modelId, toVectorLiteral(vec), nowIso],
  );
}

async function deleteEmbeddings(tx: Queryable, deps: IngestDeps, tenantId: string, sourceId: string, version: number): Promise<void> {
  if (!deps.embeddingsAvailable) return;
  await tx.query("delete from knowledge_embeddings where tenant_id = $1 and source_id = $2 and version = $3", [tenantId, sourceId, version]);
}
