/**
 * SafetyEventRecorder: content-free safety evidence (spec sections 10 and 13;
 * DATA-01, OPS-01) in `safety_events` (migration 0610) plus an audit event per
 * phase through the AuditWriter port, in the SAME transaction.
 *
 * Time to route: `begin()` captures the validated-signal instant from the
 * injected Clock with no I/O, so recording never delays the route. The caller
 * initiates the priority route, then calls `recordRouteInitiated()`, which
 * captures the initiation instant synchronously before any I/O and stores
 * latency_ms = initiation - validation, compared with the 2 s engineering
 * target. Utterance-to-detection latency is recorded separately when the
 * telephony layer supplies the end-of-utterance time.
 *
 * Fail-safe ordering: recording NEVER blocks or throws into the safety route.
 * If the audit event cannot be written, the row is still written with
 * audit_status = AUDIT_UNAVAILABLE so operations see the incident; if the
 * database is unavailable the result says so and the call keeps its route.
 * (Consequential administrative actions are blocked on audit failure by the
 * actions module; the safety route is the safe degradation path.)
 */
import type { AuditWriter } from "../audit/ports.js";
import type { Db, Queryable } from "../db/types.js";
import type { Logger, Metrics } from "../observability/ports.js";
import { silentLogger } from "../observability/logger.js";
import type { AuditEventInput, AuditOutcome } from "../protocol/index.js";
import { OpaqueId } from "../protocol/index.js";
import type { Clock } from "../shared/clock.js";
import { iso } from "../shared/clock.js";
import { digestOf } from "../shared/canonical.js";
import { AuditUnavailableError } from "../shared/errors.js";
import { newId } from "../shared/ids.js";
import { CLINICAL_BOUNDARY_CATEGORIES } from "./clinical-boundary.js";
import type { ClinicalBoundaryCategory } from "./clinical-boundary.js";
import { SafetySignalSchema, canonicalLocale, isSupportedSafetyLocale } from "./detector.js";
import type { SafetyDecision, SafetySignal, SafetySignalSource } from "./ports.js";

export const SAFETY_ROUTE_TARGET_MS = 2_000;

export type SafetyEventPhase = "SIGNAL_VALIDATED" | "ROUTE_INITIATED" | "OUTCOME";
export type SafetyRouteOutcome = "IN_PROGRESS" | "TRANSFERRED" | "CALLER_DISCONNECTED" | "FAILED" | "OUTCOME_UNKNOWN";

export interface SafetyIncidentInput {
  tenantId: string;
  callId: string;
  /** 0 when no trusted session exists yet (unverified caller). */
  sessionGeneration: number;
  turnId?: string | null;
  correlationId?: string | null;
  signals: readonly SafetySignal[];
  decision: Pick<SafetyDecision, "route" | "destinationId" | "reasonCode">;
  clinicalCategories?: readonly ClinicalBoundaryCategory[];
  locale: string;
  afterHours: boolean;
  /** End of the caller's utterance per the telephony layer, if known (detection latency). */
  utteranceEndedAt?: Date | null;
}

/** Content-free in-memory handle for one incident. */
export interface SafetyIncident {
  readonly incidentId: string;
  readonly correlationId: string;
  readonly detectedAt: Date;
  readonly valid: boolean;
  readonly invalidReason: string | null;
  readonly row: Readonly<SafetyIncidentRow>;
}

interface SafetyIncidentRow {
  tenantId: string;
  callId: string;
  sessionGeneration: number;
  turnId: string | null;
  signalSources: SafetySignalSource[];
  ruleIds: string[];
  clinicalCategories: ClinicalBoundaryCategory[];
  strongestStrength: SafetySignal["strength"] | null;
  anyThirdParty: boolean;
  anyHistorical: boolean;
  anyNegated: boolean;
  route: "SAFETY_PRIORITY_HUMAN" | "CLINICAL_BOUNDARY_ROUTE";
  destinationId: string;
  reasonCode: string;
  locale: string;
  localeSupported: boolean;
  afterHours: boolean;
  utteranceEndedAt: string | null;
  detectionLatencyMs: number | null;
}

export interface SafetyRecordResult {
  /** The safety_events row exists (inserted now or already present). */
  recorded: boolean;
  auditRecorded: boolean;
  duplicate: boolean;
  eventId: string | null;
  auditEventId: string | null;
  reasonCode: string | null;
}

export interface RouteInitiationResult extends SafetyRecordResult {
  latencyMs: number;
  withinTarget: boolean;
  targetMs: number;
}

export interface SafetyEventRecorderOptions {
  db: Db;
  audit: AuditWriter;
  clock: Clock;
  logger?: Logger;
  metrics?: Metrics;
  /** Engineering target; operational commitments are separate (spec section 10). */
  targetMs?: number;
  auditStream?: string;
}

const SOURCE_LABEL: Record<SafetySignalSource, string> = {
  EXPLICIT_PHRASE: "explicit_phrase",
  SEMANTIC_SIGNAL: "semantic",
  ASR_UNCERTAIN: "uncertain_asr",
  FAIL_SAFE: "fail_safe",
  CALLER_REQUEST: "caller_request",
  HUMAN_INTERVENTION: "human_intervention",
};
const SOURCE_ORDER: readonly SafetySignalSource[] = ["HUMAN_INTERVENTION", "EXPLICIT_PHRASE", "CALLER_REQUEST", "SEMANTIC_SIGNAL", "ASR_UNCERTAIN", "FAIL_SAFE"];
const DESTINATION_RE = /^dst_[a-z0-9_]{2,40}$/;
const REASON_RE = /^[A-Z][A-Z0-9_]{2,63}$/;
const TURN_RE = /^turn_[A-Za-z0-9_-]{4,64}$/;
const TRANSFER_RE = /^xfr_[A-Za-z0-9_-]{16,64}$/;

const AUDIT_OUTCOME: Record<SafetyRouteOutcome, AuditOutcome> = {
  IN_PROGRESS: "PENDING",
  TRANSFERRED: "SUCCEEDED",
  CALLER_DISCONNECTED: "FAILED",
  FAILED: "FAILED",
  OUTCOME_UNKNOWN: "UNKNOWN",
};

const PHASE_ACTION: Record<SafetyEventPhase, string> = {
  SIGNAL_VALIDATED: "safety.signal.validated",
  ROUTE_INITIATED: "safety.route.initiated",
  OUTCOME: "safety.route.outcome",
};

export class SafetyEventRecorder {
  readonly kind = "live" as const;
  private readonly db: Db;
  private readonly audit: AuditWriter;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly metrics: Metrics | null;
  private readonly targetMs: number;
  private readonly stream: string | undefined;

  constructor(opts: SafetyEventRecorderOptions) {
    this.db = opts.db;
    this.audit = opts.audit;
    this.clock = opts.clock;
    this.logger = (opts.logger ?? silentLogger).child({ component: "safety_events" });
    this.metrics = opts.metrics ?? null;
    const t = opts.targetMs ?? SAFETY_ROUTE_TARGET_MS;
    if (!Number.isInteger(t) || t < 1 || t > 60_000) throw new Error("SAFETY_ROUTE_TARGET_INVALID");
    this.targetMs = t;
    this.stream = opts.auditStream;
  }

  /** Validated-signal instant. Synchronous, no I/O, never throws. */
  begin(input: SafetyIncidentInput): SafetyIncident {
    const detectedAt = this.clock.now();
    const incidentId = newId("sin");
    const correlation = input?.correlationId && OpaqueId.safeParse(input.correlationId).success ? input.correlationId : newId("cor");
    const built = buildRow(input, detectedAt);
    return Object.freeze({
      incidentId,
      correlationId: correlation,
      detectedAt,
      valid: built.ok,
      invalidReason: built.ok ? null : built.reason,
      row: Object.freeze(built.row),
    });
  }

  async recordValidated(incident: SafetyIncident): Promise<SafetyRecordResult> {
    if (incident.valid) {
      for (const src of incident.row.signalSources) this.safeMetric(() => this.metrics?.increment("vsp_safety_signals_total", { signal_source: SOURCE_LABEL[src] }));
    }
    return this.write(incident, "SIGNAL_VALIDATED", {});
  }

  /** Call immediately after initiating the priority route; the initiation instant is taken before any I/O. */
  async recordRouteInitiated(incident: SafetyIncident, opts: { transferId?: string | null } = {}): Promise<RouteInitiationResult> {
    const initiatedAt = this.clock.now();
    const latencyMs = Math.max(0, initiatedAt.getTime() - incident.detectedAt.getTime());
    const withinTarget = latencyMs <= this.targetMs;
    const primary = SOURCE_ORDER.find((s) => incident.row.signalSources.includes(s));
    if (primary) this.safeMetric(() => this.metrics?.observe("vsp_safety_time_to_routing_ms", latencyMs, { signal_source: SOURCE_LABEL[primary] }));
    if (!withinTarget) this.logger.warn("safety.route.target_missed", { incidentId: incident.incidentId, latencyMs, reasonCode: "SAFETY_ROUTE_TARGET_MISSED" });
    const r = await this.write(incident, "ROUTE_INITIATED", {
      routeInitiatedAt: iso(initiatedAt),
      latencyMs,
      withinTarget,
      transferId: opts.transferId ?? null,
    });
    return { ...r, latencyMs, withinTarget, targetMs: this.targetMs };
  }

  async recordOutcome(incident: SafetyIncident, opts: { outcome: SafetyRouteOutcome; transferId?: string | null }): Promise<SafetyRecordResult> {
    const result = { completed: "completed", failed: "failed", receiver_unavailable: "receiver_unavailable", caller_disconnected: "caller_disconnected", in_progress: "in_progress" };
    const label =
      opts.outcome === "TRANSFERRED" ? result.completed : opts.outcome === "CALLER_DISCONNECTED" ? result.caller_disconnected : opts.outcome === "IN_PROGRESS" ? result.in_progress : result.failed;
    if (incident.row.route === "SAFETY_PRIORITY_HUMAN") this.safeMetric(() => this.metrics?.increment("vsp_safety_handoffs_total", { result: label }));
    return this.write(incident, "OUTCOME", { outcome: opts.outcome, transferId: opts.transferId ?? null });
  }

  // -------------------------------------------------------------------------

  private async write(
    incident: SafetyIncident,
    phase: SafetyEventPhase,
    extra: { routeInitiatedAt?: string; latencyMs?: number; withinTarget?: boolean; transferId?: string | null; outcome?: SafetyRouteOutcome },
  ): Promise<SafetyRecordResult> {
    const fail = (reasonCode: string): SafetyRecordResult => ({ recorded: false, auditRecorded: false, duplicate: false, eventId: null, auditEventId: null, reasonCode });
    if (!incident.valid) {
      this.logger.error("safety.event.invalid", { incidentId: incident.incidentId, reasonCode: incident.invalidReason ?? "SAFETY_EVENT_INVALID" });
      return fail(incident.invalidReason ?? "SAFETY_EVENT_INVALID");
    }
    if (extra.transferId != null && !TRANSFER_RE.test(extra.transferId)) return fail("SAFETY_EVENT_TRANSFER_ID_INVALID");
    if (extra.outcome === "TRANSFERRED" && extra.transferId == null) return fail("SAFETY_EVENT_TRANSFER_REQUIRED");

    const eventId = newId("sev");
    const recordedAt = iso(this.clock.now());
    const values = {
      eventId,
      incidentId: incident.incidentId,
      phase,
      ...incident.row,
      detectedAt: iso(incident.detectedAt),
      routeInitiatedAt: extra.routeInitiatedAt ?? null,
      latencyMs: extra.latencyMs ?? null,
      targetMs: this.targetMs,
      withinTarget: extra.withinTarget ?? null,
      transferId: extra.transferId ?? null,
      outcome: extra.outcome ?? null,
      recordedAt,
    };
    const rls = { tenantId: incident.row.tenantId };
    try {
      return await this.db.tx(async (tx) => {
        const existing = await this.existing(tx, incident, phase);
        if (existing) return { recorded: true, auditRecorded: existing.audit_status === "RECORDED", duplicate: true, eventId: existing.event_id, auditEventId: existing.audit_event_id, reasonCode: null };
        const auditEvent = await this.audit.append(tx, this.auditInput(incident, phase, values), this.stream);
        await this.insert(tx, values, auditEvent.eventId, "RECORDED");
        return { recorded: true, auditRecorded: true, duplicate: false, eventId, auditEventId: auditEvent.eventId, reasonCode: null };
      }, { rls });
    } catch (err) {
      const reasonCode = err instanceof AuditUnavailableError ? err.reasonCode : "SAFETY_EVENT_WRITE_FAILED";
      this.logger.error("safety.event.audit_or_store_failed", { incidentId: incident.incidentId, reasonCode });
    }
    // Fallback: keep operational visibility of the incident even without its audit event.
    try {
      return await this.db.tx(async (tx) => {
        const existing = await this.existing(tx, incident, phase);
        if (existing) return { recorded: true, auditRecorded: existing.audit_status === "RECORDED", duplicate: true, eventId: existing.event_id, auditEventId: existing.audit_event_id, reasonCode: null };
        await this.insert(tx, values, null, "AUDIT_UNAVAILABLE");
        return { recorded: true, auditRecorded: false, duplicate: false, eventId, auditEventId: null, reasonCode: "AUDIT_UNAVAILABLE" };
      }, { rls });
    } catch {
      this.logger.error("safety.event.record_failed", { incidentId: incident.incidentId, reasonCode: "SAFETY_EVENT_STORE_UNAVAILABLE" });
      return fail("SAFETY_EVENT_STORE_UNAVAILABLE");
    }
  }

  private async existing(tx: Queryable, incident: SafetyIncident, phase: SafetyEventPhase): Promise<{ event_id: string; audit_event_id: string | null; audit_status: string } | null> {
    if (phase === "OUTCOME") return null;
    const r = await tx.query<{ event_id: string; audit_event_id: string | null; audit_status: string }>(
      "select event_id, audit_event_id, audit_status from safety_events where tenant_id = $1 and incident_id = $2 and phase = $3",
      [incident.row.tenantId, incident.incidentId, phase],
    );
    return r.rows[0] ?? null;
  }

  private async insert(tx: Queryable, v: SafetyRowValues, auditEventId: string | null, auditStatus: "RECORDED" | "AUDIT_UNAVAILABLE"): Promise<void> {
    await tx.query(
      `insert into safety_events (
         event_id, incident_id, tenant_id, call_id, session_generation, turn_id, phase, signal_sources, rule_ids,
         clinical_categories, strongest_strength, any_third_party, any_historical, any_negated, route, destination_id,
         reason_code, locale, locale_supported, after_hours, utterance_ended_at, detected_at, detection_latency_ms,
         route_initiated_at, latency_ms, target_ms, within_target, transfer_id, outcome, audit_event_id, audit_status, recorded_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8::text[], $9::text[], $10::text[], $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
               $21::timestamptz, $22::timestamptz, $23, $24::timestamptz, $25, $26, $27, $28, $29, $30, $31, $32::timestamptz)`,
      [
        v.eventId, v.incidentId, v.tenantId, v.callId, v.sessionGeneration, v.turnId, v.phase, v.signalSources, v.ruleIds,
        v.clinicalCategories, v.strongestStrength, v.anyThirdParty, v.anyHistorical, v.anyNegated, v.route, v.destinationId,
        v.reasonCode, v.locale, v.localeSupported, v.afterHours, v.utteranceEndedAt, v.detectedAt, v.detectionLatencyMs,
        v.routeInitiatedAt, v.latencyMs, v.targetMs, v.withinTarget, v.transferId, v.outcome, auditEventId, auditStatus, v.recordedAt,
      ],
    );
  }

  private auditInput(incident: SafetyIncident, phase: SafetyEventPhase, v: SafetyRowValues): AuditEventInput {
    const outcome: AuditOutcome = phase === "SIGNAL_VALIDATED" ? "SUCCEEDED" : phase === "ROUTE_INITIATED" ? "PENDING" : AUDIT_OUTCOME[v.outcome ?? "OUTCOME_UNKNOWN"];
    const pointers = [`db://safety_events/${v.eventId}`];
    if (v.transferId) pointers.push(`transfer:${v.transferId}`);
    return {
      occurredAt: phase === "SIGNAL_VALIDATED" ? v.detectedAt : (v.routeInitiatedAt ?? v.recordedAt),
      correlationId: incident.correlationId,
      parentId: null,
      tenantId: v.tenantId,
      actorRef: null,
      subjectRef: null,
      role: null,
      sourceComponent: "safety",
      callId: v.callId,
      sessionRef: null,
      sessionGeneration: v.sessionGeneration,
      turnId: v.turnId,
      versions: null,
      action: PHASE_ACTION[phase],
      policyDecision: null,
      assurance: null,
      evidencePointers: pointers,
      beforeHash: null,
      afterHash: digestOf(v),
      // Validation and initiation happen once per incident; outcomes may be appended repeatedly.
      idempotencyKey: phase === "OUTCOME" ? `${incident.incidentId}:outcome:${v.eventId}` : `${incident.incidentId}:${phase.toLowerCase()}`,
      outcome,
      reasonCode: v.reasonCode,
      dataClass: "SECURITY_AUDIT",
    };
  }

  private safeMetric(fn: () => void): void {
    try {
      fn();
    } catch {
      // Metrics must never interfere with the safety route.
    }
  }
}

type SafetyRowValues = SafetyIncidentRow & {
  eventId: string;
  incidentId: string;
  phase: SafetyEventPhase;
  detectedAt: string;
  routeInitiatedAt: string | null;
  latencyMs: number | null;
  targetMs: number;
  withinTarget: boolean | null;
  transferId: string | null;
  outcome: SafetyRouteOutcome | null;
  recordedAt: string;
};

const EMPTY_ROW: SafetyIncidentRow = {
  tenantId: "",
  callId: "",
  sessionGeneration: 0,
  turnId: null,
  signalSources: [],
  ruleIds: [],
  clinicalCategories: [],
  strongestStrength: null,
  anyThirdParty: false,
  anyHistorical: false,
  anyNegated: false,
  route: "SAFETY_PRIORITY_HUMAN",
  destinationId: "dst_safety_priority",
  reasonCode: "SAFETY_EVENT_INVALID",
  locale: "und",
  localeSupported: false,
  afterHours: false,
  utteranceEndedAt: null,
  detectionLatencyMs: null,
};

/** Builds the content-free row; only closed-set values derived from validated signals survive. */
function buildRow(input: SafetyIncidentInput, detectedAt: Date): { ok: true; row: SafetyIncidentRow } | { ok: false; reason: string; row: SafetyIncidentRow } {
  const bad = (reason: string) => ({ ok: false as const, reason, row: EMPTY_ROW });
  if (!input || typeof input !== "object") return bad("SAFETY_EVENT_INPUT_INVALID");
  if (!OpaqueId.safeParse(input.tenantId).success) return bad("SAFETY_EVENT_TENANT_INVALID");
  if (!OpaqueId.safeParse(input.callId).success) return bad("SAFETY_EVENT_CALL_INVALID");
  if (!Number.isInteger(input.sessionGeneration) || input.sessionGeneration < 0) return bad("SAFETY_EVENT_GENERATION_INVALID");
  if (input.turnId != null && !TURN_RE.test(input.turnId)) return bad("SAFETY_EVENT_TURN_INVALID");
  const route = input.decision?.route;
  if (route !== "SAFETY_PRIORITY_HUMAN" && route !== "CLINICAL_BOUNDARY_ROUTE") return bad("SAFETY_EVENT_ROUTE_NOT_RECORDABLE");
  if (typeof input.decision.destinationId !== "string" || !DESTINATION_RE.test(input.decision.destinationId)) return bad("SAFETY_EVENT_DESTINATION_INVALID");
  if (typeof input.decision.reasonCode !== "string" || !REASON_RE.test(input.decision.reasonCode)) return bad("SAFETY_EVENT_REASON_INVALID");
  const signals: SafetySignal[] = [];
  for (const s of Array.isArray(input.signals) ? input.signals : []) {
    const parsed = SafetySignalSchema.safeParse(s);
    if (!parsed.success) return bad("SAFETY_EVENT_SIGNAL_INVALID");
    signals.push(parsed.data);
  }
  if (route === "SAFETY_PRIORITY_HUMAN" && signals.length === 0) return bad("SAFETY_EVENT_SIGNALS_REQUIRED");
  const clinical = CLINICAL_BOUNDARY_CATEGORIES.filter((c) => (input.clinicalCategories ?? []).includes(c));
  if (route === "CLINICAL_BOUNDARY_ROUTE" && (signals.length > 0 || clinical.length === 0)) return bad("SAFETY_EVENT_CLINICAL_SHAPE_INVALID");
  const locale = canonicalLocale(input.locale);
  const utt = input.utteranceEndedAt instanceof Date && !Number.isNaN(input.utteranceEndedAt.getTime()) && input.utteranceEndedAt <= detectedAt ? input.utteranceEndedAt : null;
  return {
    ok: true,
    row: {
      tenantId: input.tenantId,
      callId: input.callId,
      sessionGeneration: input.sessionGeneration,
      turnId: input.turnId ?? null,
      signalSources: SOURCE_ORDER.filter((src) => signals.some((s) => s.source === src)),
      ruleIds: [...new Set(signals.map((s) => s.ruleId))].sort().slice(0, 32),
      clinicalCategories: clinical,
      strongestStrength: signals.length === 0 ? null : signals.some((s) => s.strength === "CREDIBLE") ? "CREDIBLE" : "UNRESOLVED",
      anyThirdParty: signals.some((s) => s.subject === "THIRD_PARTY"),
      anyHistorical: signals.some((s) => s.temporal === "HISTORICAL"),
      anyNegated: signals.some((s) => s.negated),
      route,
      destinationId: input.decision.destinationId,
      reasonCode: input.decision.reasonCode,
      locale,
      localeSupported: isSupportedSafetyLocale(locale),
      afterHours: input.afterHours === true,
      utteranceEndedAt: utt ? iso(utt) : null,
      detectionLatencyMs: utt ? detectedAt.getTime() - utt.getTime() : null,
    },
  };
}
