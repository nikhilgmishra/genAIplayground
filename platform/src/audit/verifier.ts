/**
 * Integrity verification and completeness reconciliation (spec section 13).
 *
 * "Signing or hashing alone does not establish completeness; reconcile source
 * event counts and critical actions." Accordingly this module separates:
 *   - verifyStream / verifyShipped : integrity of what is present (hash chain, links,
 *                                    gaps, manifests, local-vs-sink divergence)
 *   - detectIngestionGaps          : silence or shortfall against source-reported activity
 *   - reconcileCounts              : critical source actions vs audit evidence, keyed
 *   - assessCompleteness           : PASS only when integrity, ingestion monitoring AND
 *                                    reconciliation all ran clean; a clean hash chain with no
 *                                    reconciliation is INCONCLUSIVE, never PASS (OPS-03).
 * All findings are content free: codes, streams, sequences and opaque ids only.
 */
import { z } from "zod";
import type { Db, DbRole, Queryable } from "../db/types.js";
import { AuditEvent, IsoDateTime } from "../protocol/index.js";
import type { AuditEvent as AuditEventType, AuditManifest } from "../protocol/index.js";
import type { Clock } from "../shared/clock.js";
import { iso } from "../shared/clock.js";
import { ValidationError } from "../shared/errors.js";
import { batchDigestOf, objectKeyFor, parseNdjson, verifyChain } from "./chain.js";
import type { ChainFindingCode } from "./chain.js";
import { toDateOrNull, toSafeInt } from "./internal.js";
import type { AuditSink } from "./ports.js";
import { STREAM_NAME_RE } from "./schema.js";

export type IntegrityFindingCode =
  | ChainFindingCode
  | "COLUMN_MISMATCH"
  | "START_MISMATCH"
  | "HEAD_MISMATCH"
  | "HEAD_MISSING"
  | "MANIFEST_DIGEST_MISMATCH"
  | "MANIFEST_CONTENT_MISMATCH"
  | "MANIFEST_KEY_MISMATCH"
  | "MANIFEST_CHAIN_GAP"
  | "MANIFEST_OVERLAP"
  | "MANIFEST_LINK_MISMATCH"
  | "BATCH_MISSING"
  | "BATCH_LINE_INVALID"
  | "SHIPPED_MANIFEST_MISSING_FROM_SINK"
  | "SINK_MANIFEST_UNKNOWN_LOCALLY"
  | "LOCAL_SINK_DIVERGENCE"
  | "SINK_UNAVAILABLE";

export interface IntegrityFinding {
  code: IntegrityFindingCode;
  sourceStream: string;
  sequence: number | null;
  expectedSequence?: number;
  eventId?: string;
  manifestId?: string;
}

export interface StreamVerification {
  sourceStream: string;
  scope: "local" | "shipped";
  ok: boolean;
  checkedEvents: number;
  firstSequence: number | null;
  lastSequence: number | null;
  findings: IntegrityFinding[];
}

export interface SourceActivityReport {
  /** Stream the reporting source writes to. */
  sourceStream: string;
  /** Half-open window [windowStart, windowEnd) in which the source counted its emitted audit events. */
  windowStart: string;
  windowEnd: string;
  /** Count reported by the source itself (e.g. a durable counter or ledger), not by the audit store. */
  reportedEventCount: number;
}

const SourceActivityReportSchema = z.strictObject({
  sourceStream: z.string().regex(STREAM_NAME_RE),
  windowStart: IsoDateTime,
  windowEnd: IsoDateTime,
  reportedEventCount: z.number().int().min(0),
});

export type IngestionGapCode = "STREAM_SILENT" | "COUNT_SHORTFALL" | "COUNT_EXCESS" | "UNKNOWN_STREAM" | "SINK_INGESTION_LAG";

export interface IngestionGap {
  code: IngestionGapCode;
  sourceStream: string;
  reportedEventCount: number | null;
  observedEventCount: number | null;
  newestEventAgeSeconds: number | null;
  oldestUnshippedAgeSeconds: number | null;
}

export interface IngestionCheckResult {
  ok: boolean;
  checkedStreams: number;
  gaps: IngestionGap[];
}

/**
 * Critical-action inputs. Per action name, either the exact keys (e.g. idempotency
 * keys or action ids of committed ledger actions) or, when keys are unavailable, a
 * count. Keyed reconciliation is preferred: counts can mask one missing plus one duplicate.
 */
export type ActionTally = Readonly<Record<string, readonly string[] | number>>;

export type ReconciliationCode = "MISSING_AUDIT_EVIDENCE" | "UNEXPECTED_AUDIT_EVIDENCE" | "DUPLICATE_AUDIT_EVIDENCE" | "COUNT_MISMATCH";

export interface ReconciliationDiscrepancy {
  code: ReconciliationCode;
  action: string;
  /** Present for keyed reconciliation. Keys must be opaque identifiers. */
  key?: string;
  expectedCount: number;
  observedCount: number;
}

export interface ReconciliationResult {
  ok: boolean;
  expectedTotal: number;
  observedTotal: number;
  discrepancies: ReconciliationDiscrepancy[];
}

/**
 * Compares what the source of truth says happened (e.g. COMMITTED rows in the
 * action ledger) with the audit evidence observed (e.g. "action.commit.succeeded"
 * events). A committed action with no audit event yields MISSING_AUDIT_EVIDENCE.
 */
export function reconcileCounts(expectedBySourceAction: ActionTally, observed: ActionTally): ReconciliationResult {
  const discrepancies: ReconciliationDiscrepancy[] = [];
  let expectedTotal = 0;
  let observedTotal = 0;
  const size = (v: readonly string[] | number | undefined) => (v === undefined ? 0 : typeof v === "number" ? v : v.length);
  const actions = [...new Set([...Object.keys(expectedBySourceAction), ...Object.keys(observed)])].sort();
  for (const action of actions) {
    const exp = expectedBySourceAction[action];
    const obs = observed[action];
    expectedTotal += size(exp);
    observedTotal += size(obs);
    if (Array.isArray(exp) && (Array.isArray(obs) || obs === undefined)) {
      const expCounts = countKeys(exp as readonly string[]);
      const obsCounts = countKeys((obs as readonly string[] | undefined) ?? []);
      for (const [key, n] of expCounts) {
        const o = obsCounts.get(key) ?? 0;
        if (o === 0) discrepancies.push({ code: "MISSING_AUDIT_EVIDENCE", action, key, expectedCount: n, observedCount: 0 });
        else if (o > n) discrepancies.push({ code: "DUPLICATE_AUDIT_EVIDENCE", action, key, expectedCount: n, observedCount: o });
        else if (o < n) discrepancies.push({ code: "MISSING_AUDIT_EVIDENCE", action, key, expectedCount: n, observedCount: o });
      }
      for (const [key, o] of obsCounts) {
        if (!expCounts.has(key)) discrepancies.push({ code: "UNEXPECTED_AUDIT_EVIDENCE", action, key, expectedCount: 0, observedCount: o });
      }
    } else if (exp === undefined && Array.isArray(obs)) {
      for (const [key, o] of countKeys(obs as readonly string[])) {
        discrepancies.push({ code: "UNEXPECTED_AUDIT_EVIDENCE", action, key, expectedCount: 0, observedCount: o });
      }
    } else {
      const e = size(exp);
      const o = size(obs);
      if (e !== o) {
        discrepancies.push({ code: o < e ? "MISSING_AUDIT_EVIDENCE" : "COUNT_MISMATCH", action, expectedCount: e, observedCount: o });
      }
    }
  }
  return { ok: discrepancies.length === 0, expectedTotal, observedTotal, discrepancies };
}

function countKeys(keys: readonly string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1);
  return m;
}

export type CompletenessVerdict = "PASS" | "FAIL" | "INCONCLUSIVE";

export interface CompletenessAssessment {
  verdict: CompletenessVerdict;
  reasonCodes: string[];
}

/**
 * Combines integrity, ingestion monitoring and reconciliation. Missing inputs are
 * INCONCLUSIVE: a verified hash chain does not prove that every event was written.
 */
export function assessCompleteness(input: {
  integrity: readonly StreamVerification[];
  ingestion: IngestionCheckResult | null;
  reconciliation: ReconciliationResult | null;
}): CompletenessAssessment {
  const reasons: string[] = [];
  let failed = false;
  if (input.integrity.some((v) => !v.ok)) {
    failed = true;
    reasons.push("INTEGRITY_FINDINGS");
  }
  if (input.ingestion && !input.ingestion.ok) {
    failed = true;
    reasons.push("INGESTION_GAPS");
  }
  if (input.reconciliation && !input.reconciliation.ok) {
    failed = true;
    reasons.push("RECONCILIATION_DISCREPANCIES");
  }
  if (failed) return { verdict: "FAIL", reasonCodes: reasons };
  if (input.integrity.length === 0) reasons.push("INTEGRITY_NOT_VERIFIED");
  if (!input.ingestion) reasons.push("INGESTION_NOT_MONITORED");
  if (!input.reconciliation) reasons.push("COMPLETENESS_NOT_RECONCILED");
  return reasons.length > 0 ? { verdict: "INCONCLUSIVE", reasonCodes: reasons } : { verdict: "PASS", reasonCodes: [] };
}

export interface IntegrityVerifierOptions {
  db: Db;
  sink: AuditSink;
  clock: Clock;
  /** Role able to read every stream (default app_worker). */
  role?: Extract<DbRole, "app_worker" | "owner">;
  pageSize?: number;
}

interface LocalRow {
  event_id: string;
  tenant_id: string;
  source_stream: string;
  sequence: unknown;
  prev_hash: string | null;
  hash: string;
  event: unknown;
  occurred_at: unknown;
  correlation_id: string;
  call_id: string | null;
  action: string;
  outcome: string;
  data_class: string;
  manifest_id: string | null;
}

export class IntegrityVerifier {
  private readonly role: Extract<DbRole, "app_worker" | "owner">;
  private readonly pageSize: number;

  constructor(private readonly opts: IntegrityVerifierOptions) {
    this.role = opts.role ?? "app_worker";
    this.pageSize = opts.pageSize ?? 1000;
  }

  private tx<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return this.opts.db.tx(fn, { role: this.role });
  }

  async listStreams(): Promise<string[]> {
    return this.tx(async (tx) => (await tx.query<{ s: string }>("select source_stream as s from audit_chain_heads order by 1")).rows.map((r) => r.s));
  }

  /** Verifies the local outbox of one stream: schema, recomputed hashes, links, gaps, columns, chain head. */
  async verifyStream(sourceStream: string): Promise<StreamVerification> {
    assertStream(sourceStream);
    return this.tx(async (tx) => {
      const findings: IntegrityFinding[] = [];
      const head = (
        await tx.query<{ last_sequence: unknown; last_hash: string | null }>(
          "select last_sequence::text as last_sequence, last_hash from audit_chain_heads where source_stream = $1",
          [sourceStream],
        )
      ).rows[0];
      const wm = (
        await tx.query<{ s: unknown; h: string }>(
          "select purged_through_sequence::text as s, purged_through_hash as h from audit_purge_watermarks where source_stream = $1",
          [sourceStream],
        )
      ).rows[0];
      let expectedSequence = wm ? toSafeInt(wm.s) + 1 : 1;
      let expectedPrevHash: string | null = wm ? wm.h : null;
      let checked = 0;
      let first: number | null = null;
      let last: number | null = null;
      let lastHash: string | null = null;
      let after = expectedSequence - 1;
      for (;;) {
        const rows = (
          await tx.query<LocalRow>(
            `select event_id, tenant_id, source_stream, sequence::text as sequence, prev_hash, hash, event, occurred_at,
                    correlation_id, call_id, action, outcome, data_class, manifest_id
               from audit_outbox where source_stream = $1 and sequence > $2 order by sequence limit $3`,
            [sourceStream, after, this.pageSize],
          )
        ).rows;
        if (rows.length === 0) break;
        for (const row of rows) {
          const seq = toSafeInt(row.sequence);
          if (first === null) first = seq;
          const parsed = AuditEvent.safeParse(row.event);
          if (!parsed.success) {
            findings.push({ code: "EVENT_SCHEMA_INVALID", sourceStream, sequence: seq, eventId: row.event_id });
          } else {
            if (!columnsMatch(row, parsed.data, seq)) {
              findings.push({ code: "COLUMN_MISMATCH", sourceStream, sequence: seq, eventId: row.event_id });
            }
            const res = verifyChain([parsed.data], { sourceStream, expectedSequence, expectedPrevHash });
            for (const f of res.findings) findings.push({ ...f, sourceStream });
          }
          // Advance from the stored row so every later event is still checked.
          expectedSequence = seq + 1;
          expectedPrevHash = row.hash;
          last = seq;
          lastHash = row.hash;
          after = seq;
          checked += 1;
        }
        if (rows.length < this.pageSize) break;
      }
      if (first === null && wm === undefined && head && toSafeInt(head.last_sequence) > 0) {
        // Head says events exist but none (and no purge watermark) are present.
        findings.push({ code: "SEQUENCE_GAP", sourceStream, sequence: null, expectedSequence: 1 });
      }
      if (!head) {
        findings.push({ code: "HEAD_MISSING", sourceStream, sequence: null });
      } else {
        const headSeq = toSafeInt(head.last_sequence);
        const presentThrough = last ?? (wm ? toSafeInt(wm.s) : 0);
        const presentHash = lastHash ?? (wm ? wm.h : null);
        if (headSeq !== presentThrough || head.last_hash !== presentHash) {
          // e.g. trailing events deleted (truncation) or the head was rewound.
          findings.push({ code: "HEAD_MISMATCH", sourceStream, sequence: headSeq, expectedSequence: presentThrough + 1 });
        }
      }
      return { sourceStream, scope: "local", ok: findings.length === 0, checkedEvents: checked, firstSequence: first, lastSequence: last, findings };
    });
  }

  /**
   * Verifies what the independent sink holds for a stream: each manifest's batch
   * digest and content, chain continuity across manifests from sequence 1,
   * agreement with locally recorded SHIPPED manifests, and agreement with local
   * rows still present. With markVerified, clean manifests get verified_at (which
   * is the precondition for purging the local copy).
   */
  async verifyShipped(sourceStream: string, opts: { markVerified?: boolean } = {}): Promise<StreamVerification> {
    assertStream(sourceStream);
    const findings: IntegrityFinding[] = [];
    let manifests: AuditManifest[];
    try {
      manifests = await this.opts.sink.listManifests(sourceStream);
    } catch {
      findings.push({ code: "SINK_UNAVAILABLE", sourceStream, sequence: null });
      return { sourceStream, scope: "shipped", ok: false, checkedEvents: 0, firstSequence: null, lastSequence: null, findings };
    }
    manifests = [...manifests].sort((a, b) => a.firstSequence - b.firstSequence || a.lastSequence - b.lastSequence);

    let expectedSequence = 1;
    let expectedPrevHash: string | null = null;
    let checked = 0;
    const cleanManifestIds: string[] = [];
    const sinkHashes = new Map<number, string>();
    for (const m of manifests) {
      const before = findings.length;
      if (m.sourceStream !== sourceStream || m.objectKey !== objectKeyFor(sourceStream, m.firstSequence, m.lastSequence)) {
        findings.push({ code: "MANIFEST_KEY_MISMATCH", sourceStream, sequence: m.firstSequence, manifestId: m.manifestId });
      }
      if (m.firstSequence > expectedSequence) {
        findings.push({ code: "MANIFEST_CHAIN_GAP", sourceStream, sequence: m.firstSequence, expectedSequence, manifestId: m.manifestId });
      } else if (m.firstSequence < expectedSequence) {
        findings.push({ code: "MANIFEST_OVERLAP", sourceStream, sequence: m.firstSequence, expectedSequence, manifestId: m.manifestId });
      }
      if (m.firstSequence === expectedSequence && m.firstPrevHash !== expectedPrevHash) {
        findings.push({ code: "MANIFEST_LINK_MISMATCH", sourceStream, sequence: m.firstSequence, manifestId: m.manifestId });
      }
      let body: string | null = null;
      try {
        body = await this.opts.sink.getBatch(m.objectKey);
      } catch {
        findings.push({ code: "BATCH_MISSING", sourceStream, sequence: m.firstSequence, manifestId: m.manifestId });
      }
      if (body !== null) {
        if (batchDigestOf(body) !== m.batchDigest) {
          findings.push({ code: "MANIFEST_DIGEST_MISMATCH", sourceStream, sequence: m.firstSequence, manifestId: m.manifestId });
        }
        const lines = parseNdjson(body);
        const events: AuditEventType[] = [];
        for (const l of lines) {
          if (l.ok) events.push(l.event);
          else findings.push({ code: "BATCH_LINE_INVALID", sourceStream, sequence: m.firstSequence + l.lineNumber - 1, manifestId: m.manifestId });
        }
        const firstEv = events[0];
        const lastEv = events[events.length - 1];
        if (
          !firstEv ||
          !lastEv ||
          lines.length !== m.eventCount ||
          firstEv.sequence !== m.firstSequence ||
          lastEv.sequence !== m.lastSequence ||
          firstEv.prevHash !== m.firstPrevHash ||
          lastEv.hash !== m.lastHash
        ) {
          findings.push({ code: "MANIFEST_CONTENT_MISMATCH", sourceStream, sequence: m.firstSequence, manifestId: m.manifestId });
        }
        const res = verifyChain(events, { sourceStream, expectedSequence: m.firstSequence, expectedPrevHash: m.firstPrevHash });
        for (const f of res.findings) findings.push({ ...f, sourceStream, manifestId: m.manifestId });
        for (const e of events) sinkHashes.set(e.sequence, e.hash);
        checked += events.length;
      }
      if (findings.length === before) cleanManifestIds.push(m.manifestId);
      expectedSequence = Math.max(expectedSequence, m.lastSequence + 1);
      expectedPrevHash = m.lastHash;
    }

    // Cross-check with local records: shipped manifests must exist in the sink, and
    // local rows that still exist must match the shipped copy byte for byte (hash).
    const sinkIds = new Set(manifests.map((m) => m.manifestId));
    const local = await this.tx(async (tx) => {
      const ms = await tx.query<{ manifest_id: string; first_sequence: unknown }>(
        "select manifest_id, first_sequence::text as first_sequence from audit_manifests where source_stream = $1 and status = 'SHIPPED'",
        [sourceStream],
      );
      const rows = await tx.query<{ sequence: unknown; hash: string; event_id: string }>(
        "select sequence::text as sequence, hash, event_id from audit_outbox where source_stream = $1 and manifest_id is not null order by sequence",
        [sourceStream],
      );
      return { manifests: ms.rows, rows: rows.rows };
    });
    const localIds = new Set(local.manifests.map((m) => m.manifest_id));
    for (const lm of local.manifests) {
      if (!sinkIds.has(lm.manifest_id)) {
        findings.push({ code: "SHIPPED_MANIFEST_MISSING_FROM_SINK", sourceStream, sequence: toSafeInt(lm.first_sequence), manifestId: lm.manifest_id });
      }
    }
    for (const m of manifests) {
      if (!localIds.has(m.manifestId)) {
        findings.push({ code: "SINK_MANIFEST_UNKNOWN_LOCALLY", sourceStream, sequence: m.firstSequence, manifestId: m.manifestId });
      }
    }
    for (const r of local.rows) {
      const seq = toSafeInt(r.sequence);
      const shipped = sinkHashes.get(seq);
      if (shipped !== undefined && shipped !== r.hash) {
        findings.push({ code: "LOCAL_SINK_DIVERGENCE", sourceStream, sequence: seq, eventId: r.event_id });
      }
    }

    const ok = findings.length === 0;
    if (opts.markVerified && ok && cleanManifestIds.length > 0) {
      await this.tx(async (tx) => {
        await tx.query(
          `update audit_manifests set verified_at = $2::timestamptz
            where manifest_id = any($1::text[]) and status = 'SHIPPED' and verified_at is null`,
          [cleanManifestIds, iso(this.opts.clock.now())],
        );
      });
    }
    const firstM = manifests[0];
    const lastM = manifests[manifests.length - 1];
    return {
      sourceStream,
      scope: "shipped",
      ok,
      checkedEvents: checked,
      firstSequence: firstM ? firstM.firstSequence : null,
      lastSequence: lastM ? lastM.lastSequence : null,
      findings,
    };
  }

  /**
   * Monitors ingestion gaps against source-reported activity: a stream that the
   * source says was active but whose newest audit event is older than the threshold
   * (STREAM_SILENT), fewer or more events than the source reported in the window
   * (COUNT_SHORTFALL / COUNT_EXCESS), activity for a stream the store has never seen
   * (UNKNOWN_STREAM), and unshipped events older than the threshold (SINK_INGESTION_LAG).
   */
  async detectIngestionGaps(input: { reports: readonly SourceActivityReport[]; silenceThresholdSeconds: number }): Promise<IngestionCheckResult> {
    if (!Number.isFinite(input.silenceThresholdSeconds) || input.silenceThresholdSeconds <= 0) throw new ValidationError("AUDIT_THRESHOLD_INVALID");
    const reports = input.reports.map((r) => {
      const parsed = SourceActivityReportSchema.safeParse(r);
      if (!parsed.success || Date.parse(parsed.data.windowEnd) < Date.parse(parsed.data.windowStart)) throw new ValidationError("AUDIT_ACTIVITY_REPORT_INVALID");
      return parsed.data;
    });
    const now = this.opts.clock.now().getTime();
    const ageOf = (d: Date | null) => (d ? Math.max(0, Math.floor((now - d.getTime()) / 1000)) : null);
    const gaps: IngestionGap[] = [];
    await this.tx(async (tx) => {
      for (const r of reports) {
        const head = (await tx.query<{ s: string }>("select source_stream as s from audit_chain_heads where source_stream = $1", [r.sourceStream])).rows[0];
        if (!head) {
          if (r.reportedEventCount > 0) {
            gaps.push({ code: "UNKNOWN_STREAM", sourceStream: r.sourceStream, reportedEventCount: r.reportedEventCount, observedEventCount: 0, newestEventAgeSeconds: null, oldestUnshippedAgeSeconds: null });
          }
          continue;
        }
        const stats = (
          await tx.query<{ observed: unknown; newest: unknown; oldest_unshipped: unknown }>(
            `select
               (select count(*)::text from audit_outbox where source_stream = $1 and occurred_at >= $2::timestamptz and occurred_at < $3::timestamptz) as observed,
               (select max(occurred_at) from audit_outbox where source_stream = $1) as newest,
               (select min(recorded_at) from audit_outbox where source_stream = $1 and shipped_at is null) as oldest_unshipped`,
            [r.sourceStream, r.windowStart, r.windowEnd],
          )
        ).rows[0];
        const observed = toSafeInt(stats?.observed ?? 0);
        const newestAge = ageOf(toDateOrNull(stats?.newest));
        const unshippedAge = ageOf(toDateOrNull(stats?.oldest_unshipped));
        const base = { sourceStream: r.sourceStream, reportedEventCount: r.reportedEventCount, observedEventCount: observed, newestEventAgeSeconds: newestAge, oldestUnshippedAgeSeconds: unshippedAge };
        if (r.reportedEventCount > 0 && (newestAge === null || newestAge > input.silenceThresholdSeconds)) gaps.push({ code: "STREAM_SILENT", ...base });
        if (observed < r.reportedEventCount) gaps.push({ code: "COUNT_SHORTFALL", ...base });
        if (observed > r.reportedEventCount) gaps.push({ code: "COUNT_EXCESS", ...base });
        if (unshippedAge !== null && unshippedAge > input.silenceThresholdSeconds) gaps.push({ code: "SINK_INGESTION_LAG", ...base });
      }
    });
    return { ok: gaps.length === 0, checkedStreams: reports.length, gaps };
  }

  /**
   * Observed audit evidence per action for reconciliation, keyed by idempotencyKey
   * (events without one are counted under the empty-key bucket "(none)").
   */
  async observedActionKeys(input: { tenantId: string; actions: readonly string[]; from: string; to: string }): Promise<Record<string, string[]>> {
    const parsed = z
      .strictObject({ tenantId: z.string().min(3).max(80), actions: z.array(z.string().regex(/^[a-z][a-z0-9_.]{2,80}$/)).min(1).max(32), from: IsoDateTime, to: IsoDateTime })
      .safeParse(input);
    if (!parsed.success) throw new ValidationError("AUDIT_RECONCILE_INPUT_INVALID");
    const out: Record<string, string[]> = Object.fromEntries(parsed.data.actions.map((a) => [a, [] as string[]]));
    await this.tx(async (tx) => {
      const rows = await tx.query<{ action: string; k: string | null }>(
        `select action, event ->> 'idempotencyKey' as k from audit_outbox
          where tenant_id = $1 and action = any($2::text[]) and occurred_at >= $3::timestamptz and occurred_at < $4::timestamptz
          order by action, sequence`,
        [parsed.data.tenantId, parsed.data.actions, parsed.data.from, parsed.data.to],
      );
      for (const r of rows.rows) (out[r.action] ??= []).push(r.k ?? "(none)");
    });
    return out;
  }
}

function assertStream(stream: string): void {
  if (!STREAM_NAME_RE.test(stream)) throw new ValidationError("AUDIT_STREAM_INVALID");
}

function columnsMatch(row: LocalRow, e: AuditEventType, seq: number): boolean {
  const occurred = toDateOrNull(row.occurred_at);
  return (
    row.event_id === e.eventId &&
    row.tenant_id === e.tenantId &&
    row.source_stream === e.sourceStream &&
    seq === e.sequence &&
    row.prev_hash === e.prevHash &&
    row.hash === e.hash &&
    row.correlation_id === e.correlationId &&
    row.call_id === e.callId &&
    row.action === e.action &&
    row.outcome === e.outcome &&
    row.data_class === e.dataClass &&
    occurred !== null &&
    occurred.getTime() === Date.parse(e.occurredAt)
  );
}
