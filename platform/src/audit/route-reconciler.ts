/**
 * Route-audit intents and reconciliation (follow-on FO-01-34, FO-15-45, FO-15-48; OPS-01, OPS-02, SAFE-03).
 *
 * "No route is ever silently unaudited": a human or safety route whose audit event never arrived — the
 * process stopped while the route-tool execution was detached by its tool timeout, or both journals were
 * down — is turned into an explicit `audit.route.not_recorded` marker in the audit chain, linked to the
 * durable record of the route:
 *
 *  - SAFETY routes: every safety incident (safety_events, migration 0610: written by SafetyEventRecorder
 *    with audit_status RECORDED or AUDIT_UNAVAILABLE) older than `graceSeconds` is checked once. Route
 *    evidence is any of: handoff.safety_requested / handoff.safety_transfer_failed / safety.route.initiated
 *    for the incident's call in the audit outbox, or a pending/recorded deferral of those actions in the
 *    durable journal. Without it the reconciler appends audit.route.not_recorded (outcome UNKNOWN,
 *    evidence pointers db://safety_events/<event_id> for the incident's rows). Safety rows written without
 *    their own audit event (AUDIT_UNAVAILABLE) are listed in an audit.safety_event.unaudited marker even
 *    when the route itself is evidenced, so the chain shows every unaudited phase.
 *  - HUMAN routes: `PgRouteAuditIntents.open` records an intent when the route starts (route_audit_intents);
 *    the durable deferred sink resolves it when the route event is written or journaled; an intent still
 *    OPEN at its deadline is resolved here (evidence found late) or reported as audit.route.not_recorded.
 *    Evidence must be route evidence of the intent's kind (journal.ts routeKindOfAction): a SAFETY_ROUTE
 *    intent needs a handoff.safety_* or safety.route.* event, a HUMAN_TRANSFER intent any handoff.* or
 *    safety.route.* event; any other event that merely carries the correlation id never closes an intent.
 *
 * Each subject is reconciled exactly once (route_audit_reconciliations unique per subject, written in the
 * same transaction as the marker), so a crash mid-run neither loses nor duplicates a marker. Runs as
 * app_worker per tenant (worker loop; composed by the phase integration package).
 *
 * Metrics: vsp_route_audit_reconciled_total{subject, result} (content free).
 */
import type { Db, Queryable } from "../db/types.js";
import { silentLogger } from "../observability/logger.js";
import { noopMetrics } from "../observability/metrics.js";
import type { Logger, Metrics } from "../observability/ports.js";
import { OpaqueId } from "../protocol/index.js";
import type { Clock } from "../shared/clock.js";
import { addMs, iso } from "../shared/clock.js";
import { ValidationError } from "../shared/errors.js";
import { newId } from "../shared/ids.js";
import { buildAuditInput } from "./build-input.js";
import { routeEvidenceActionPattern } from "./journal.js";
import type { AuditWriter, RouteAuditIntentRecorder } from "./ports.js";
import { assertStreamName } from "./schema.js";

export const ROUTE_NOT_RECORDED_ACTION = "audit.route.not_recorded";
export const SAFETY_EVENT_UNAUDITED_ACTION = "audit.safety_event.unaudited";
/** Audit actions that evidence a safety route for a call. */
export const SAFETY_ROUTE_EVIDENCE_ACTIONS = ["handoff.safety_requested", "handoff.safety_transfer_failed", "safety.route.initiated"] as const;

const TENANT_ID = /^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$/;
/** Advisory-lock key space serializing reconcilers on one incident (exactly one marker per incident). */
const RECONCILE_LOCK_NAMESPACE = 7300041;

export interface PgRouteAuditIntentsOptions {
  db: Db;
  clock: Clock;
  role?: "app_runtime" | "app_console" | "app_worker";
}

/** Opens route intents (route_audit_intents). Idempotent per (tenant, route kind, correlation). */
export class PgRouteAuditIntents implements RouteAuditIntentRecorder {
  constructor(private readonly opts: PgRouteAuditIntentsOptions) {}

  async open(
    input: Parameters<RouteAuditIntentRecorder["open"]>[0],
    tx?: Queryable,
  ): Promise<{ intentId: string; created: boolean }> {
    if (!TENANT_ID.test(input.tenantId) || !OpaqueId.safeParse(input.correlationId).success || !OpaqueId.safeParse(input.callId).success) {
      throw new ValidationError("ROUTE_AUDIT_INTENT_INVALID");
    }
    if (input.safetyIncidentId != null && !/^sin_[A-Za-z0-9_-]{16,64}$/.test(input.safetyIncidentId)) throw new ValidationError("ROUTE_AUDIT_INTENT_INVALID");
    const deadline = input.deadlineSeconds ?? 300;
    if (!Number.isSafeInteger(deadline) || deadline < 30 || deadline > 86_400) throw new ValidationError("ROUTE_AUDIT_INTENT_DEADLINE_INVALID");
    const now = this.opts.clock.now();
    const intentId = newId("rai");
    const run = async (q: Queryable) => {
      const r = await q.query<{ intent_id: string }>(
        `insert into route_audit_intents (intent_id, tenant_id, route_kind, correlation_id, call_id, safety_incident_id, opened_at, deadline_at, status)
         values ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz, 'OPEN')
         on conflict (tenant_id, route_kind, correlation_id) do nothing
         returning intent_id`,
        [intentId, input.tenantId, input.routeKind, input.correlationId, input.callId, input.safetyIncidentId ?? null, iso(now), iso(addMs(now, deadline * 1000))],
      );
      if (r.rows[0]) return { intentId: r.rows[0].intent_id, created: true };
      const existing = await q.query<{ intent_id: string }>(
        "select intent_id from route_audit_intents where tenant_id = $1 and route_kind = $2 and correlation_id = $3",
        [input.tenantId, input.routeKind, input.correlationId],
      );
      return { intentId: existing.rows[0]?.intent_id ?? intentId, created: false };
    };
    if (tx) return run(tx);
    return this.opts.db.tx(run, { role: this.opts.role ?? "app_runtime", rls: { tenantId: input.tenantId } });
  }
}

export interface RouteAuditReconcilerOptions {
  db: Db;
  writer: AuditWriter;
  clock: Clock;
  tenants: readonly string[] | (() => Promise<readonly string[]>);
  /** Audit stream of the reconciler's markers (e.g. auditStreamName("worker", instanceId)). */
  stream: string;
  /** Minimum age of a safety incident before it is reconciled (default 300 s, 60..86400). */
  graceSeconds?: number;
  /** Subjects reconciled per tenant per run (default 100, 1..1000). */
  batchSize?: number;
  logger?: Logger;
  metrics?: Metrics;
}

export interface RouteReconcileResult {
  safetyIncidents: { evidenced: number; notRecorded: number };
  routeIntents: { evidenced: number; notRecorded: number };
  /** Marker event ids written in this run (audit.route.not_recorded and audit.safety_event.unaudited). */
  markerEventIds: string[];
}

interface IncidentRow {
  incident_id: string;
  call_id: string;
  first_detected_at: unknown;
  event_ids: string[];
  unaudited_ids: string[];
}

interface IntentRow {
  intent_id: string;
  route_kind: "HUMAN_TRANSFER" | "SAFETY_ROUTE";
  correlation_id: string;
  call_id: string;
  safety_incident_id: string | null;
}

export class RouteAuditReconciler {
  private readonly logger: Logger;
  private readonly metrics: Metrics;
  private readonly graceMs: number;
  private readonly batchSize: number;
  private readonly stream: string;

  constructor(private readonly opts: RouteAuditReconcilerOptions) {
    const grace = opts.graceSeconds ?? 300;
    const batch = opts.batchSize ?? 100;
    if (!Number.isSafeInteger(grace) || grace < 60 || grace > 86_400 || !Number.isSafeInteger(batch) || batch < 1 || batch > 1000) {
      throw new ValidationError("ROUTE_AUDIT_RECONCILER_CONFIG_INVALID");
    }
    this.graceMs = grace * 1000;
    this.batchSize = batch;
    this.stream = assertStreamName(opts.stream);
    this.logger = (opts.logger ?? silentLogger).child({ component: "route_audit_reconciler" });
    this.metrics = opts.metrics ?? noopMetrics;
  }

  async runOnce(): Promise<RouteReconcileResult> {
    const result: RouteReconcileResult = { safetyIncidents: { evidenced: 0, notRecorded: 0 }, routeIntents: { evidenced: 0, notRecorded: 0 }, markerEventIds: [] };
    const list = typeof this.opts.tenants === "function" ? await this.opts.tenants() : this.opts.tenants;
    for (const tenantId of new Set(list)) {
      if (!TENANT_ID.test(tenantId)) throw new ValidationError("ROUTE_AUDIT_RECONCILER_TENANT_INVALID");
      await this.reconcileIncidents(tenantId, result);
      await this.reconcileIntents(tenantId, result);
    }
    if (result.safetyIncidents.notRecorded + result.routeIntents.notRecorded > 0) {
      this.logger.error("audit.route.not_recorded", {
        reasonCode: "ROUTE_AUDIT_NOT_RECORDED",
        safetyIncidents: result.safetyIncidents.notRecorded,
        routeIntents: result.routeIntents.notRecorded,
      });
    }
    return result;
  }

  private async reconcileIncidents(tenantId: string, result: RouteReconcileResult): Promise<void> {
    const cutoff = iso(new Date(this.opts.clock.now().getTime() - this.graceMs));
    const incidents = await this.opts.db.tx(
      async (tx) =>
        (
          await tx.query<IncidentRow>(
            `select s.incident_id, min(s.call_id) as call_id, min(s.detected_at) as first_detected_at,
                    array_agg(s.event_id order by s.recorded_at) as event_ids,
                    coalesce(array_agg(s.event_id order by s.recorded_at) filter (where s.audit_status = 'AUDIT_UNAVAILABLE'), '{}') as unaudited_ids
               from safety_events s
              where s.tenant_id = $1
                and not exists (select 1 from route_audit_reconciliations r
                                 where r.tenant_id = s.tenant_id and r.subject_kind = 'SAFETY_INCIDENT' and r.subject_id = s.incident_id)
              group by s.incident_id
             having min(s.detected_at) <= $2::timestamptz
              order by min(s.detected_at)
              limit $3`,
            [tenantId, cutoff, this.batchSize],
          )
        ).rows,
      { role: "app_worker", rls: { tenantId } },
    );
    for (const inc of incidents) {
      const detectedAt = inc.first_detected_at instanceof Date ? inc.first_detected_at : new Date(String(inc.first_detected_at));
      const outcome = await this.opts.db.tx(
        async (tx) => {
          // Exactly once per incident (a concurrent reconciler or a re-run after a crash finds the row).
          await tx.query("select pg_advisory_xact_lock($1, hashtext($2))", [RECONCILE_LOCK_NAMESPACE, inc.incident_id]);
          const done = await tx.query("select 1 from route_audit_reconciliations where tenant_id = $1 and subject_kind = 'SAFETY_INCIDENT' and subject_id = $2", [tenantId, inc.incident_id]);
          if (done.rows.length > 0) return null;
          const evidence = await this.safetyEvidence(tx, tenantId, inc.call_id, detectedAt);
          const unaudited = (inc.unaudited_ids ?? []).slice(0, 15);
          let markerId: string | null = null;
          if (!evidence) {
            const marker = await this.opts.writer.append(
              tx,
              buildAuditInput(
                {
                  tenantId,
                  correlationId: inc.incident_id,
                  sourceComponent: "worker",
                  action: ROUTE_NOT_RECORDED_ACTION,
                  outcome: "UNKNOWN",
                  callId: inc.call_id,
                  reasonCode: "ROUTE_AUDIT_NOT_RECORDED",
                  evidencePointers: [`safety_incident:${inc.incident_id}`, ...(inc.event_ids ?? []).slice(0, 15).map((id) => `db://safety_events/${id}`)],
                  dataClass: "SECURITY_AUDIT",
                },
                this.opts.clock,
              ),
              this.stream,
            );
            markerId = marker.eventId;
          } else if (unaudited.length > 0) {
            const marker = await this.opts.writer.append(
              tx,
              buildAuditInput(
                {
                  tenantId,
                  correlationId: inc.incident_id,
                  parentId: evidence.startsWith("dfr_") ? null : evidence,
                  sourceComponent: "worker",
                  action: SAFETY_EVENT_UNAUDITED_ACTION,
                  outcome: "SUCCEEDED",
                  callId: inc.call_id,
                  reasonCode: "SAFETY_EVENT_AUDIT_UNAVAILABLE",
                  evidencePointers: [`safety_incident:${inc.incident_id}`, ...unaudited.map((id) => `db://safety_events/${id}`)],
                  dataClass: "SECURITY_AUDIT",
                },
                this.opts.clock,
              ),
              this.stream,
            );
            markerId = marker.eventId;
          }
          await tx.query(
            `insert into route_audit_reconciliations (reconciliation_id, tenant_id, subject_kind, subject_id, call_id, result, audit_event_id,
                                                      unaudited_safety_event_ids, reconciled_at)
             values ($1, $2, 'SAFETY_INCIDENT', $3, $4, $5, $6, $7::text[], $8::timestamptz)`,
            [newId("rar"), tenantId, inc.incident_id, inc.call_id, evidence ? "EVIDENCED" : "NOT_RECORDED", markerId ?? evidence, inc.unaudited_ids ?? [], iso(this.opts.clock.now())],
          );
          return { evidenced: evidence !== null, markerId };
        },
        { role: "app_worker", rls: { tenantId } },
      );
      if (!outcome) continue;
      if (outcome.markerId) result.markerEventIds.push(outcome.markerId);
      if (outcome.evidenced) result.safetyIncidents.evidenced += 1;
      else result.safetyIncidents.notRecorded += 1;
      this.count("safety_incident", outcome.evidenced ? "evidenced" : "not_recorded");
    }
  }

  /** Event id (or deferral id) evidencing a safety route for the call since shortly before detection; null when none. */
  private async safetyEvidence(tx: Queryable, tenantId: string, callId: string, detectedAt: Date): Promise<string | null> {
    const since = iso(addMs(detectedAt, -60_000));
    const ev = await tx.query<{ event_id: string }>(
      `select event_id from audit_outbox where tenant_id = $1 and call_id = $2 and action = any($3::text[]) and occurred_at >= $4::timestamptz
        order by occurred_at limit 1`,
      [tenantId, callId, [...SAFETY_ROUTE_EVIDENCE_ACTIONS], since],
    );
    if (ev.rows[0]) return ev.rows[0].event_id;
    const deferred = await tx.query<{ deferral_id: string; recorded_event_id: string | null }>(
      `select deferral_id, recorded_event_id from audit_deferred where tenant_id = $1 and call_id = $2 and action = any($3::text[])
          and status in ('PENDING', 'RECORDED') and deferred_at >= $4::timestamptz order by deferred_at limit 1`,
      [tenantId, callId, [...SAFETY_ROUTE_EVIDENCE_ACTIONS], since],
    );
    const d = deferred.rows[0];
    return d ? (d.recorded_event_id ?? d.deferral_id) : null;
  }

  private async reconcileIntents(tenantId: string, result: RouteReconcileResult): Promise<void> {
    const now = iso(this.opts.clock.now());
    for (let i = 0; i < this.batchSize; i++) {
      const outcome = await this.opts.db.tx(
        async (tx) => {
          const r = await tx.query<IntentRow>(
            `select intent_id, route_kind, correlation_id, call_id, safety_incident_id from route_audit_intents
              where status = 'OPEN' and deadline_at <= $1::timestamptz order by deadline_at limit 1 for update skip locked`,
            [now],
          );
          const intent = r.rows[0];
          if (!intent) return null;
          // Late evidence: route evidence of the intent's kind only (routeKindOfAction), never just any event of the correlation.
          const evidenceActions = routeEvidenceActionPattern(intent.route_kind);
          const ev = await tx.query<{ event_id: string }>(
            `select event_id from audit_outbox where tenant_id = $1 and correlation_id = $2 and action ~ $3
              order by occurred_at limit 1`,
            [tenantId, intent.correlation_id, evidenceActions],
          );
          const df = await tx.query<{ deferral_id: string }>(
            `select deferral_id from audit_deferred where tenant_id = $1 and correlation_id = $2 and action ~ $3 and status in ('PENDING', 'RECORDED')
              order by deferred_at limit 1`,
            [tenantId, intent.correlation_id, evidenceActions],
          );
          const eventId = ev.rows[0]?.event_id ?? null;
          const deferralId = df.rows[0]?.deferral_id ?? null;
          let markerId: string | null = null;
          if (eventId || deferralId) {
            await tx.query(
              `update route_audit_intents set status = 'RECORDED', resolved_event_id = $2, resolved_deferral_id = $3, resolved_at = $4::timestamptz
                where intent_id = $1 and status = 'OPEN'`,
              [intent.intent_id, eventId, eventId ? null : deferralId, now],
            );
          } else {
            const marker = await this.opts.writer.append(
              tx,
              buildAuditInput(
                {
                  tenantId,
                  correlationId: intent.correlation_id,
                  sourceComponent: "worker",
                  action: ROUTE_NOT_RECORDED_ACTION,
                  outcome: "UNKNOWN",
                  callId: intent.call_id,
                  reasonCode: "ROUTE_AUDIT_NOT_RECORDED",
                  evidencePointers: [`route_intent:${intent.intent_id}`, ...(intent.safety_incident_id ? [`safety_incident:${intent.safety_incident_id}`] : [])],
                  dataClass: "SECURITY_AUDIT",
                },
                this.opts.clock,
              ),
              this.stream,
            );
            markerId = marker.eventId;
            await tx.query(
              `update route_audit_intents set status = 'NOT_RECORDED', resolved_event_id = $2, resolved_at = $3::timestamptz where intent_id = $1 and status = 'OPEN'`,
              [intent.intent_id, markerId, now],
            );
          }
          await tx.query(
            `insert into route_audit_reconciliations (reconciliation_id, tenant_id, subject_kind, subject_id, call_id, result, audit_event_id, reconciled_at)
             values ($1, $2, 'ROUTE_INTENT', $3, $4, $5, $6, $7::timestamptz)
             on conflict (tenant_id, subject_kind, subject_id) do nothing`,
            [newId("rar"), tenantId, intent.intent_id, intent.call_id, markerId ? "NOT_RECORDED" : "EVIDENCED", markerId ?? eventId, now],
          );
          return { evidenced: markerId === null, markerId };
        },
        { role: "app_worker", rls: { tenantId } },
      );
      if (!outcome) break;
      if (outcome.markerId) result.markerEventIds.push(outcome.markerId);
      if (outcome.evidenced) result.routeIntents.evidenced += 1;
      else result.routeIntents.notRecorded += 1;
      this.count("route_intent", outcome.evidenced ? "evidenced" : "not_recorded");
    }
  }

  private count(subject: "safety_incident" | "route_intent", result: "evidenced" | "not_recorded"): void {
    try {
      this.metrics.increment("vsp_route_audit_reconciled_total", { subject, result });
    } catch {
      // metrics never change what is reconciled
    }
  }
}
