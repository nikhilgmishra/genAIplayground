/**
 * Continuous audit completeness monitoring (spec section 13 "monitored ingestion gaps,
 * integrity checks ... reconcile source event counts and critical actions"; OPS-01;
 * OPS-AUD-01). Run by the worker loop `audit.verify`.
 *
 * Each run, for every stream in audit_chain_heads:
 *   1. integrity   — IntegrityVerifier.verifyStream (local hash chain, links, sequence gaps,
 *                    columns, chain head) and, when a sink reader is composed,
 *                    verifyShipped (manifests, batch digests, chain continuity, local-vs-sink);
 *   2. ingestion   — the writer-side chain head (advanced in the same transaction as every
 *                    insert) against the rows present (COUNT_SHORTFALL / COUNT_EXCESS, i.e.
 *                    rows deleted or inserted out of band), and unshipped events older than
 *                    the export grace (SINK_INGESTION_LAG);
 * and per tenant:
 *   3. reconciliation — every COMMITTED action in the ledger within the lookback must have
 *                    its commit audit event (receipt.auditEventId, action.commit.succeeded or
 *                    action.reconciled, same tenant, idempotencyKey = the ledger's
 *                    provider_idempotency_key) present (keyed
 *                    reconcileCounts: a missing event is MISSING_AUDIT_EVIDENCE).
 * assessCompleteness combines them: PASS only when all three ran clean; no sink reader =>
 * shipped integrity not verified => INCONCLUSIVE (never PASS, OPS-03).
 *
 * Metrics (content free; observability/metrics.ts catalogue):
 *   vsp_audit_ingestion_gaps_total{source_component} — integrity findings, ingestion gaps and
 *       reconciliation discrepancies found in this run (0 is emitted as a heartbeat so the
 *       critical alarm can treat missing data as breaching); also an unlabelled aggregate.
 *   vsp_audit_export_completeness_ratio{source_component} — shipped / events recorded before
 *       the export grace (1 when none are due); also an unlabelled overall ratio.
 *   vsp_audit_backlog_events — events awaiting shipment (audit_backlog_stats()).
 * Findings are logged as codes and counts only.
 */
import type { Db } from "../db/types.js";
import { silentLogger } from "../observability/logger.js";
import type { Logger, Metrics } from "../observability/ports.js";
import { AuditSourceComponent, OpaqueId } from "../protocol/index.js";
import type { AuditSourceComponent as AuditSourceComponentT } from "../protocol/index.js";
import type { Clock } from "../shared/clock.js";
import { iso } from "../shared/clock.js";
import { ValidationError } from "../shared/errors.js";
import { guardStorage, toDateOrNull, toSafeInt } from "./internal.js";
import type { AuditSink } from "./ports.js";
import { IntegrityVerifier, assessCompleteness, reconcileCounts } from "./verifier.js";
import type { CompletenessVerdict, IngestionCheckResult, IngestionGap, ReconciliationResult, StreamVerification } from "./verifier.js";

/** Audit actions that evidence a committed ledger action (actions/action-service.ts). */
export const COMMIT_EVIDENCE_ACTIONS = ["action.commit.succeeded", "action.reconciled"] as const;
const RECONCILE_ACTION = "action.commit";

export interface AuditCompletenessMonitorOptions {
  db: Db;
  /**
   * Reader of the independent sink for verifyShipped. null: shipped integrity is not
   * verified and the verdict cannot be PASS (live S3 needs a reader identity, see README).
   */
  sink: AuditSink | null;
  clock: Clock;
  metrics: Metrics;
  tenantIds: readonly string[];
  logger?: Logger;
  /** Ledger lookback for reconciliation (default 24 h). */
  reconcileWindowSeconds?: number;
  /** Events younger than this are not yet expected in the sink (default 300 s, the audit maxBacklogAgeSeconds default). */
  exportGraceSeconds?: number;
}

export interface AuditMonitorReport {
  verdict: CompletenessVerdict;
  reasonCodes: string[];
  streams: number;
  integrityFindings: number;
  ingestionGaps: number;
  reconciliationDiscrepancies: number;
  committedActionsChecked: number;
  backlog: number;
  exportCompleteness: Partial<Record<AuditSourceComponentT, number>>;
  gapsByComponent: Partial<Record<AuditSourceComponentT, number>>;
}

/** Stream name -> source component label ("runtime" is the gateway composition's writer stream). */
export function sourceComponentForStream(stream: string): AuditSourceComponentT {
  const head = stream.split(".")[0] ?? "";
  if (head === "runtime") return "gateway";
  const parsed = AuditSourceComponent.safeParse(head);
  return parsed.success ? parsed.data : "worker";
}

export class AuditCompletenessMonitor {
  private readonly logger: Logger;
  private readonly reconcileWindowMs: number;
  private readonly graceMs: number;

  constructor(private readonly opts: AuditCompletenessMonitorOptions) {
    const window = opts.reconcileWindowSeconds ?? 86_400;
    const grace = opts.exportGraceSeconds ?? 300;
    if (!Number.isFinite(window) || window <= 0 || !Number.isFinite(grace) || grace <= 0) throw new ValidationError("AUDIT_MONITOR_CONFIG_INVALID");
    for (const t of opts.tenantIds) if (!OpaqueId.safeParse(t).success) throw new ValidationError("AUDIT_MONITOR_CONFIG_INVALID");
    this.reconcileWindowMs = window * 1000;
    this.graceMs = grace * 1000;
    this.logger = (opts.logger ?? silentLogger).child({ component: "audit_monitor" });
  }

  async runOnce(): Promise<AuditMonitorReport> {
    const now = this.opts.clock.now();
    const verifier = new IntegrityVerifier({ db: this.opts.db, sink: this.opts.sink ?? UNAVAILABLE_SINK, clock: this.opts.clock, role: "app_worker" });
    const streams = await verifier.listStreams();
    const gaps = new Map<AuditSourceComponentT, number>();
    const bump = (c: AuditSourceComponentT, n: number) => gaps.set(c, (gaps.get(c) ?? 0) + n);

    // 1. Integrity of what is present (local) and of what was shipped (sink).
    const integrity: StreamVerification[] = [];
    for (const s of streams) {
      const local = await verifier.verifyStream(s);
      integrity.push(local);
      bump(sourceComponentForStream(s), local.findings.length);
      if (this.opts.sink) {
        const shipped = await verifier.verifyShipped(s);
        integrity.push(shipped);
        bump(sourceComponentForStream(s), shipped.findings.length);
      }
    }

    // 2. Ingestion: writer-side head vs rows present; shipping lag; export completeness.
    const cutoff = new Date(now.getTime() - this.graceMs);
    const stats = await this.streamStats(cutoff);
    const ingestionGaps: IngestionGap[] = [];
    const exportByComponent = new Map<AuditSourceComponentT, { eligible: number; shipped: number }>();
    for (const st of stats) {
      const component = sourceComponentForStream(st.stream);
      const expected = st.headSequence - st.purgedThrough;
      const unshippedAge = st.oldestUnshipped ? Math.max(0, Math.floor((now.getTime() - st.oldestUnshipped.getTime()) / 1000)) : null;
      const base = { sourceStream: st.stream, reportedEventCount: expected, observedEventCount: st.present, newestEventAgeSeconds: null, oldestUnshippedAgeSeconds: unshippedAge };
      if (st.present < expected) ingestionGaps.push({ code: "COUNT_SHORTFALL", ...base });
      if (st.present > expected) ingestionGaps.push({ code: "COUNT_EXCESS", ...base });
      if (unshippedAge !== null && unshippedAge * 1000 > this.graceMs) ingestionGaps.push({ code: "SINK_INGESTION_LAG", ...base });
      const e = exportByComponent.get(component) ?? { eligible: 0, shipped: 0 };
      e.eligible += st.eligible;
      e.shipped += st.shippedEligible;
      exportByComponent.set(component, e);
    }
    for (const g of ingestionGaps) bump(sourceComponentForStream(g.sourceStream), 1);
    const ingestion: IngestionCheckResult = { ok: ingestionGaps.length === 0, checkedStreams: stats.length, gaps: ingestionGaps };

    // 3. Reconciliation of committed ledger actions against their commit audit evidence.
    const from = new Date(now.getTime() - this.reconcileWindowMs);
    const expected: string[] = [];
    const observed: string[] = [];
    for (const tenantId of this.opts.tenantIds) {
      const rows = await this.committedEvidence(tenantId, from);
      for (const r of rows) {
        expected.push(r.actionId);
        if (r.evidenced) observed.push(r.actionId);
      }
    }
    const reconciliation: ReconciliationResult = reconcileCounts({ [RECONCILE_ACTION]: expected }, { [RECONCILE_ACTION]: observed });
    bump("actions", reconciliation.discrepancies.length);

    const assessment = assessCompleteness({ integrity, ingestion, reconciliation: this.opts.tenantIds.length > 0 ? reconciliation : null });
    if (!this.opts.sink && !assessment.reasonCodes.includes("SHIPPED_INTEGRITY_NOT_VERIFIED")) {
      assessment.reasonCodes.push("SHIPPED_INTEGRITY_NOT_VERIFIED");
      if (assessment.verdict === "PASS") assessment.verdict = "INCONCLUSIVE";
    }
    const backlog = await this.backlog();

    // Metrics: every component with a stream gets a data point each run (0 = heartbeat).
    for (const s of streams) if (!gaps.has(sourceComponentForStream(s))) gaps.set(sourceComponentForStream(s), 0);
    if (!gaps.has("actions")) gaps.set("actions", 0);
    let totalGaps = 0;
    for (const [component, n] of gaps) {
      this.opts.metrics.increment("vsp_audit_ingestion_gaps_total", { source_component: component }, n);
      totalGaps += n;
    }
    this.opts.metrics.increment("vsp_audit_ingestion_gaps_total", undefined, totalGaps);
    const exportCompleteness: Partial<Record<AuditSourceComponentT, number>> = {};
    let allEligible = 0;
    let allShipped = 0;
    for (const [component, e] of exportByComponent) {
      const ratio = e.eligible === 0 ? 1 : e.shipped / e.eligible;
      exportCompleteness[component] = ratio;
      allEligible += e.eligible;
      allShipped += e.shipped;
      this.opts.metrics.gauge("vsp_audit_export_completeness_ratio", ratio, { source_component: component });
    }
    this.opts.metrics.gauge("vsp_audit_export_completeness_ratio", allEligible === 0 ? 1 : allShipped / allEligible);
    this.opts.metrics.gauge("vsp_audit_backlog_events", backlog);

    const integrityFindings = integrity.reduce((n, v) => n + v.findings.length, 0);
    const report: AuditMonitorReport = {
      verdict: assessment.verdict,
      reasonCodes: assessment.reasonCodes,
      streams: streams.length,
      integrityFindings,
      ingestionGaps: ingestionGaps.length,
      reconciliationDiscrepancies: reconciliation.discrepancies.length,
      committedActionsChecked: expected.length,
      backlog,
      exportCompleteness,
      gapsByComponent: Object.fromEntries(gaps),
    };
    if (assessment.verdict === "FAIL") {
      this.logger.error("audit.monitor.completeness_failed", {
        reasonCode: assessment.reasonCodes[0] ?? "AUDIT_COMPLETENESS_FAILED",
        integrityFindings,
        ingestionGaps: ingestionGaps.length,
        reconciliationDiscrepancies: reconciliation.discrepancies.length,
      });
    }
    return report;
  }

  private streamStats(cutoff: Date): Promise<
    { stream: string; headSequence: number; purgedThrough: number; present: number; eligible: number; shippedEligible: number; oldestUnshipped: Date | null }[]
  > {
    return guardStorage("AUDIT_STORE_UNAVAILABLE", () =>
      this.opts.db.tx(
        async (tx) => {
          const rows = await tx.query<{ s: string; head: unknown; purged: unknown; present: unknown; eligible: unknown; shipped: unknown; oldest: unknown }>(
            `select h.source_stream as s, h.last_sequence::text as head,
                    coalesce(w.purged_through_sequence, 0)::text as purged,
                    (select count(*) from audit_outbox o where o.source_stream = h.source_stream)::text as present,
                    (select count(*) from audit_outbox o where o.source_stream = h.source_stream and o.recorded_at <= $1::timestamptz)::text as eligible,
                    (select count(*) from audit_outbox o where o.source_stream = h.source_stream and o.recorded_at <= $1::timestamptz and o.shipped_at is not null)::text as shipped,
                    (select min(o.recorded_at) from audit_outbox o where o.source_stream = h.source_stream and o.shipped_at is null) as oldest
               from audit_chain_heads h left join audit_purge_watermarks w on w.source_stream = h.source_stream
              order by h.source_stream`,
            [iso(cutoff)],
          );
          return rows.rows.map((r) => ({
            stream: r.s,
            headSequence: toSafeInt(r.head),
            purgedThrough: toSafeInt(r.purged),
            present: toSafeInt(r.present),
            eligible: toSafeInt(r.eligible),
            shippedEligible: toSafeInt(r.shipped),
            oldestUnshipped: toDateOrNull(r.oldest),
          }));
        },
        { role: "app_worker" },
      ),
    );
  }

  /** COMMITTED ledger actions in the window and whether their commit audit event is present and bound to them. */
  private committedEvidence(tenantId: string, from: Date): Promise<{ actionId: string; evidenced: boolean }[]> {
    return guardStorage("AUDIT_STORE_UNAVAILABLE", () =>
      this.opts.db.tx(
        async (tx) => {
          const rows = await tx.query<{ action_id: string; evidenced: boolean; purged: boolean }>(
            `select l.action_id,
                    (o.event_id is not null and o.action = any($2::text[]) and o.tenant_id = l.tenant_id
                       and o.event ->> 'idempotencyKey' = l.provider_idempotency_key) as evidenced,
                    (o.event_id is null and exists (select 1 from audit_purge_watermarks w where w.purged_at >= l.updated_at)) as purged
               from action_ledger l
               left join audit_outbox o on o.event_id = l.receipt ->> 'auditEventId'
              where l.state = 'COMMITTED' and l.updated_at >= $1::timestamptz
              order by l.action_id`,
            [iso(from), [...COMMIT_EVIDENCE_ACTIONS]],
          );
          // Events purged after verified shipping are checked by verifyShipped, not here.
          return rows.rows.filter((r) => !r.purged).map((r) => ({ actionId: r.action_id, evidenced: r.evidenced === true }));
        },
        { role: "app_worker", rls: { tenantId } },
      ),
    );
  }

  private backlog(): Promise<number> {
    return guardStorage("AUDIT_STORE_UNAVAILABLE", () =>
      this.opts.db.tx(async (tx) => toSafeInt((await tx.query<{ n: unknown }>("select backlog_count::text as n from audit_backlog_stats()")).rows[0]?.n ?? 0), {
        role: "app_worker",
      }),
    );
  }
}

/** Placeholder sink for a verifier that is never asked to read the sink (no sink reader composed). */
const UNAVAILABLE_SINK: AuditSink = {
  kind: "live",
  putBatch: () => Promise.reject(new ValidationError("AUDIT_SINK_READER_NOT_COMPOSED")),
  listManifests: () => Promise.reject(new ValidationError("AUDIT_SINK_READER_NOT_COMPOSED")),
  getBatch: () => Promise.reject(new ValidationError("AUDIT_SINK_READER_NOT_COMPOSED")),
};
