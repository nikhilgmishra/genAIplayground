/**
 * KnowledgeService over PostgreSQL (Aurora in deployment, PGlite offline).
 *
 *  - ingest(): the controlled pipeline (ingest.ts) in one transaction as
 *    app_worker with tenant RLS; optional audit event `knowledge.ingest` in the
 *    same transaction (if the audit write fails, nothing is ingested: OPS-01).
 *  - search(): permission-filtered retrieval (search.ts) as app_runtime.
 *  - snapshot(): latest pinned snapshot (OPS-06), creating the first one if none.
 *  - reviewQueue(): metadata-only list of quarantined / held / expired items for
 *    knowledge editors (never bodies), plus the freshness gauges.
 *  - releaseHeld() / rejectHeld(): the human review decision for items held
 *    because of a conflict (MFA knowledge_editor only; audited when an audit
 *    writer is configured).
 *
 * Production refuses a LOCAL FIXTURE embedder (OPS-04).
 */
import { z } from "zod";
import type { AuditWriter } from "../audit/ports.js";
import type { Db } from "../db/types.js";
import type { Logger, Metrics } from "../observability/ports.js";
import { silentLogger } from "../observability/logger.js";
import { Environment, OpaqueId, StaffActor } from "../protocol/index.js";
import type { AuditEventInput } from "../protocol/index.js";
import type { Clock } from "../shared/clock.js";
import { iso, systemClock } from "../shared/clock.js";
import { AccessDeniedError, ConfigurationRejectedError, ValidationError } from "../shared/errors.js";
import { newId } from "../shared/ids.js";
import type { SourcePrecedence } from "./conflicts.js";
import type { KnowledgeEmbedder } from "./embedding.js";
import { runIngest } from "./ingest.js";
import type { IngestOutcome } from "./ingest.js";
import type { IngestReport, KnowledgeHit, KnowledgeItemInput, KnowledgeService } from "./ports.js";
import { MAX_BATCH, SOURCE_ID } from "./schema.js";
import { searchKnowledge } from "./search.js";
import type { SearchOutcome, SearchTuning } from "./search.js";
import { computeSnapshot, persistSnapshotIfChanged } from "./snapshot.js";

export interface KnowledgeServiceOptions {
  db: Db;
  environment: Environment;
  clock?: Clock;
  logger?: Logger;
  metrics?: Metrics;
  /** null = full text only. A local_fixture embedder is refused in production. */
  embedder?: KnowledgeEmbedder | null;
  /** Approved source precedence; null/unapproved = every conflict held for review. */
  precedence?: SourcePrecedence | null;
  /** Hosts whose links may be kept as plain text in sanitized content. */
  allowedLinkDomains?: readonly string[];
  audit?: AuditWriter | null;
  tuning?: Partial<SearchTuning>;
}

export interface ReviewQueueEntry {
  sourceId: string;
  version: number;
  sourceSystem: string;
  status: "QUARANTINED" | "HELD_FOR_REVIEW" | "EXPIRED_IN_SERVICE";
  reasonCodes: string[];
  statusChangedAt: string;
}

const ReviewDecisionInput = z.strictObject({
  tenantId: OpaqueId,
  sourceId: z.string().regex(SOURCE_ID),
  version: z.number().int().min(1),
  staff: StaffActor,
});

export class KnowledgeServicePg implements KnowledgeService {
  readonly kind = "live" as const;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private embeddingsTable: boolean | null = null;

  constructor(private readonly opts: KnowledgeServiceOptions) {
    const env = Environment.parse(opts.environment);
    if (env === "production" && opts.embedder?.kind === "local_fixture") {
      throw new ConfigurationRejectedError(["KNOWLEDGE_FIXTURE_EMBEDDER_IN_PRODUCTION"]);
    }
    this.clock = opts.clock ?? systemClock;
    this.logger = opts.logger ?? silentLogger;
  }

  /** True when the optional pgvector table exists (migration created it). */
  async embeddingsAvailable(): Promise<boolean> {
    if (this.embeddingsTable === null) {
      const r = await this.opts.db.query<{ present: boolean }>("select to_regclass('public.knowledge_embeddings') is not null as present");
      this.embeddingsTable = r.rows[0]?.present === true;
    }
    return this.embeddingsTable;
  }

  async ingest(tenantId: string, items: KnowledgeItemInput[]): Promise<IngestReport> {
    const { previousSnapshotDigest: _prev, ...report } = await this.ingestDetailed(tenantId, items);
    return report;
  }

  async ingestDetailed(tenantId: string, items: readonly unknown[]): Promise<IngestOutcome> {
    if (!OpaqueId.safeParse(tenantId).success) throw new ValidationError("KNOWLEDGE_TENANT_INVALID");
    if (!Array.isArray(items) || items.length > MAX_BATCH) throw new ValidationError("KNOWLEDGE_BATCH_INVALID");
    const now = this.clock.now();
    const embeddingsAvailable = await this.embeddingsAvailable();
    const outcome = await this.opts.db.tx(
      async (tx) => {
        const result = await runIngest(tx, tenantId, items, {
          now,
          allowedLinkDomains: this.opts.allowedLinkDomains,
          precedence: this.opts.precedence ?? null,
          embedder: this.opts.embedder ?? null,
          embeddingsAvailable,
        });
        if (this.opts.audit) {
          await this.opts.audit.append(tx, this.auditInput(tenantId, "knowledge.ingest", now, {
            evidencePointers: [`db://knowledge_snapshots/${result.snapshotVersion}`],
            beforeHash: result.previousSnapshotDigest,
            afterHash: result.snapshotDigest,
            reasonCode: result.quarantined.length > 0 ? "KNOWLEDGE_ITEMS_QUARANTINED" : null,
          }));
        }
        return result;
      },
      { role: "app_worker", rls: { tenantId } },
    );
    this.logger.info("knowledge.ingest.completed", {
      tenantId,
      count: outcome.accepted.length,
      quarantinedCount: outcome.quarantined.length,
      conflictCount: outcome.conflicts.length,
      version: outcome.snapshotVersion,
      snapshotDigest: outcome.snapshotDigest,
    });
    return outcome;
  }

  async search(input: Parameters<KnowledgeService["search"]>[0]): Promise<KnowledgeHit[]> {
    const out = await this.searchDetailed(input);
    return out.hits.map(({ contentDigest: _d, ...hit }) => hit);
  }

  async searchDetailed(input: unknown): Promise<SearchOutcome> {
    return searchKnowledge(
      {
        db: this.opts.db,
        logger: this.logger,
        embedder: this.opts.embedder ?? null,
        embeddingsAvailable: () => this.embeddingsAvailable(),
        tuning: this.opts.tuning,
        allowedLinkDomains: this.opts.allowedLinkDomains,
      },
      input,
    );
  }

  async snapshot(tenantId: string): Promise<{ version: string; digest: string }> {
    if (!OpaqueId.safeParse(tenantId).success) throw new ValidationError("KNOWLEDGE_TENANT_INVALID");
    const latest = await this.opts.db.tx(
      async (tx) => (await tx.query<{ snapshot_version: string; snapshot_digest: string }>(
        "select snapshot_version, snapshot_digest from knowledge_snapshots where tenant_id = $1 order by snapshot_seq desc limit 1",
        [tenantId],
      )).rows[0],
      { role: "app_runtime", rls: { tenantId } },
    );
    if (latest) return { version: latest.snapshot_version, digest: latest.snapshot_digest };
    const nowIso = iso(this.clock.now());
    const created = await this.opts.db.tx(async (tx) => persistSnapshotIfChanged(tx, tenantId, await computeSnapshot(tx, tenantId), nowIso), {
      role: "app_worker",
      rls: { tenantId },
    });
    return { version: created.version, digest: created.digest };
  }

  /** Metadata-only review queue (no bodies) and knowledge freshness gauges. */
  async reviewQueue(tenantId: string): Promise<ReviewQueueEntry[]> {
    if (!OpaqueId.safeParse(tenantId).success) throw new ValidationError("KNOWLEDGE_TENANT_INVALID");
    const nowIso = iso(this.clock.now());
    const rows = await this.opts.db.tx(
      async (tx) =>
        (
          await tx.query<{
            source_id: string;
            version: number;
            source_system: string;
            quarantined: boolean;
            quarantine_reasons: string[];
            held_for_review: boolean;
            review_reasons: string[];
            servable: boolean;
            expired: boolean;
            audiences: string[];
            status_changed_at: Date | string;
            effective_from: Date | string;
          }>(
            `select source_id, version, source_system, quarantined, quarantine_reasons, held_for_review, review_reasons, servable,
                    (expires_at is not null and expires_at <= $2::timestamptz) as expired, audiences, status_changed_at, effective_from
               from knowledge_items
              where tenant_id = $1 and superseded_by_version is null
              order by source_id, version`,
            [tenantId, nowIso],
          )
        ).rows,
      { role: "app_console", rls: { tenantId } },
    );
    const out: ReviewQueueEntry[] = [];
    const counts = new Map<string, number>();
    const oldestServable = new Map<string, number>();
    const corpusOf = (r: { source_system: string; audiences: string[] }) =>
      r.source_system === "approved_runbook" ? "runbook" : r.audiences.includes("public") ? "public_faq" : "salesforce_knowledge";
    for (const r of rows) {
      const changedAt = new Date(r.status_changed_at).toISOString();
      if (r.quarantined) out.push({ sourceId: r.source_id, version: r.version, sourceSystem: r.source_system, status: "QUARANTINED", reasonCodes: r.quarantine_reasons, statusChangedAt: changedAt });
      else if (r.held_for_review) {
        out.push({ sourceId: r.source_id, version: r.version, sourceSystem: r.source_system, status: "HELD_FOR_REVIEW", reasonCodes: r.review_reasons, statusChangedAt: changedAt });
        const k = `${corpusOf(r)}|conflict`;
        counts.set(k, (counts.get(k) ?? 0) + 1);
      } else if (r.servable && r.expired) {
        out.push({ sourceId: r.source_id, version: r.version, sourceSystem: r.source_system, status: "EXPIRED_IN_SERVICE", reasonCodes: ["KNOWLEDGE_EXPIRED"], statusChangedAt: changedAt });
        const k = `${corpusOf(r)}|expired`;
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
      if (r.servable && !r.expired) {
        const t = new Date(r.effective_from).getTime();
        const corpus = corpusOf(r);
        oldestServable.set(corpus, Math.min(oldestServable.get(corpus) ?? t, t));
      }
    }
    if (this.opts.metrics) {
      for (const corpus of ["public_faq", "runbook", "salesforce_knowledge"]) {
        for (const reason of ["expired", "conflict"]) this.opts.metrics.gauge("vsp_knowledge_items_needing_review", counts.get(`${corpus}|${reason}`) ?? 0, { corpus, review_reason: reason });
      }
      for (const [corpus, t] of oldestServable) {
        this.opts.metrics.gauge("vsp_knowledge_freshness_age_seconds", Math.max(0, Math.round((this.clock.now().getTime() - t) / 1000)), { corpus });
      }
    }
    return out;
  }

  /** Human decision: release an item held for conflict review back into service. */
  async releaseHeld(input: { tenantId: string; sourceId: string; version: number; staff: unknown }): Promise<{ snapshotVersion: string; snapshotDigest: string }> {
    return this.decide(input, "RELEASE");
  }

  /** Human decision: reject a held item (quarantined with KNOWLEDGE_REJECTED_BY_REVIEW). */
  async rejectHeld(input: { tenantId: string; sourceId: string; version: number; staff: unknown }): Promise<{ snapshotVersion: string; snapshotDigest: string }> {
    return this.decide(input, "REJECT");
  }

  private async decide(raw: unknown, decision: "RELEASE" | "REJECT"): Promise<{ snapshotVersion: string; snapshotDigest: string }> {
    const parsed = ReviewDecisionInput.safeParse(raw);
    if (!parsed.success) throw new ValidationError("KNOWLEDGE_REVIEW_INPUT_INVALID");
    const { tenantId, sourceId, version, staff } = parsed.data;
    if (!staff.mfa) throw new AccessDeniedError("STAFF_MFA_REQUIRED");
    if (!staff.roles.includes("knowledge_editor")) throw new AccessDeniedError("STAFF_ROLE_NOT_PERMITTED");
    if (staff.breakGlass && Date.parse(staff.breakGlass.expiresAt) <= this.clock.now().getTime()) throw new AccessDeniedError("STAFF_BREAK_GLASS_EXPIRED");
    const now = this.clock.now();
    const nowIso = iso(now);
    const embeddingsAvailable = await this.embeddingsAvailable();
    const result = await this.opts.db.tx(
      async (tx) => {
        await tx.query("select pg_advisory_xact_lock(hashtext($1))", [`knowledge:${tenantId}`]);
        const row = (
          await tx.query<{ held_for_review: boolean; quarantined: boolean; superseded_by_version: number | null; expires_at: Date | string | null }>(
            "select held_for_review, quarantined, superseded_by_version, expires_at from knowledge_items where tenant_id = $1 and source_id = $2 and version = $3 for update",
            [tenantId, sourceId, version],
          )
        ).rows[0];
        if (!row || !row.held_for_review || row.quarantined || row.superseded_by_version !== null) throw new ValidationError("KNOWLEDGE_NOT_HELD_FOR_REVIEW");
        if (decision === "RELEASE") {
          if (row.expires_at !== null && new Date(row.expires_at).getTime() <= now.getTime()) throw new ValidationError("KNOWLEDGE_EXPIRED");
          await tx.query(
            "update knowledge_items set held_for_review = false, review_reasons = '{}', status_changed_at = $4::timestamptz where tenant_id = $1 and source_id = $2 and version = $3",
            [tenantId, sourceId, version, nowIso],
          );
          const older = await tx.query<{ version: number }>(
            `update knowledge_items set superseded_by_version = $3, status_changed_at = $4::timestamptz
              where tenant_id = $1 and source_id = $2 and version < $3 and superseded_by_version is null returning version`,
            [tenantId, sourceId, version, nowIso],
          );
          if (embeddingsAvailable) {
            for (const r of older.rows) await tx.query("delete from knowledge_embeddings where tenant_id = $1 and source_id = $2 and version = $3", [tenantId, sourceId, r.version]);
          }
        } else {
          await tx.query(
            `update knowledge_items set held_for_review = false, review_reasons = '{}', quarantined = true,
                    quarantine_reasons = array['KNOWLEDGE_REJECTED_BY_REVIEW'], status_changed_at = $4::timestamptz
              where tenant_id = $1 and source_id = $2 and version = $3`,
            [tenantId, sourceId, version, nowIso],
          );
          if (embeddingsAvailable) await tx.query("delete from knowledge_embeddings where tenant_id = $1 and source_id = $2 and version = $3", [tenantId, sourceId, version]);
        }
        const before = (await tx.query<{ snapshot_digest: string }>("select snapshot_digest from knowledge_snapshots where tenant_id = $1 order by snapshot_seq desc limit 1", [tenantId])).rows[0];
        const snap = await persistSnapshotIfChanged(tx, tenantId, await computeSnapshot(tx, tenantId), nowIso);
        if (this.opts.audit) {
          await this.opts.audit.append(tx, {
            ...this.auditInput(tenantId, decision === "RELEASE" ? "knowledge.review.release" : "knowledge.review.reject", now, {
              evidencePointers: [`db://knowledge_snapshots/${snap.version}`],
              beforeHash: before?.snapshot_digest ?? null,
              afterHash: snap.digest,
              reasonCode: decision === "RELEASE" ? "KNOWLEDGE_RELEASED_BY_REVIEW" : "KNOWLEDGE_REJECTED_BY_REVIEW",
            }),
            actorRef: staff.staffId,
            role: "knowledge_editor",
          });
        }
        return snap;
      },
      { role: "app_worker", rls: { tenantId, actorId: staff.staffId } },
    );
    this.logger.info("knowledge.review.decided", { tenantId, actorId: staff.staffId, outcome: decision, version: result.version });
    return { snapshotVersion: result.version, snapshotDigest: result.digest };
  }

  private auditInput(
    tenantId: string,
    action: string,
    now: Date,
    extra: { evidencePointers: string[]; beforeHash: string | null; afterHash: string | null; reasonCode: string | null },
  ): AuditEventInput {
    return {
      occurredAt: iso(now),
      correlationId: newId("cor"),
      parentId: null,
      tenantId,
      actorRef: null,
      subjectRef: null,
      role: null,
      sourceComponent: "knowledge",
      callId: null,
      sessionRef: null,
      sessionGeneration: null,
      turnId: null,
      versions: null,
      action,
      policyDecision: null,
      assurance: null,
      evidencePointers: extra.evidencePointers,
      beforeHash: extra.beforeHash,
      afterHash: extra.afterHash,
      idempotencyKey: null,
      outcome: "SUCCEEDED",
      reasonCode: extra.reasonCode,
      dataClass: "SECURITY_AUDIT",
    };
  }
}
