/**
 * Service objectives from spec section 13, as code.
 *
 * EVERY target below is PROPOSED: an acceptance target to validate with
 * operations and vendors. None is a measured capability, a vendor commitment or
 * a statutory threshold. Evaluations computed from local synthetic samples are
 * labelled with their evidence kind so they cannot be mistaken for production
 * measurement. Missing or insufficient samples yield INCONCLUSIVE, never a pass
 * (OPS-03).
 *
 * Windows not stated in the specification (all except "monthly" routing) are
 * engineering proposals and are marked `windowSource: "ENGINEERING_PROPOSAL"`.
 */
import { ValidationError } from "../shared/errors.js";

export type SloKind = "ratio" | "latency" | "zero_tolerance";

export type BreakdownDimension = "language" | "intent" | "region" | "audience" | "model" | "voice" | "auth_path" | "load_band";

/** Spec section 13: publish percentiles by these dimensions. */
export const SLO_BREAKDOWNS: readonly BreakdownDimension[] = ["language", "intent", "region", "audience", "model", "voice", "auth_path", "load_band"];

export interface LatencyTarget {
  kind: "latency";
  /** Each listed percentile must be at most maxMs. */
  percentiles: readonly { p: 50 | 95 | 99; maxMs: number }[];
}
export interface RatioTarget {
  kind: "ratio";
  /** Minimum good / (total - excluded). 1 means 100 percent. */
  minRatio: number;
}
export interface ZeroToleranceTarget {
  kind: "zero_tolerance";
  maxEvents: 0;
}

export type SloWindow =
  | { kind: "calendar_month" }
  | { kind: "rolling_days"; days: number }
  /** Evaluated per release over the required failure/retry test runs. */
  | { kind: "per_release_test_run" };

export interface SloDefinition {
  readonly id: string;
  readonly description: string;
  readonly target: LatencyTarget | RatioTarget | ZeroToleranceTarget;
  /** Always "PROPOSED"; nothing here has been measured. */
  readonly targetStatus: "PROPOSED";
  readonly measured: false;
  readonly measurementPoint: string;
  readonly numerator: string;
  readonly denominator: string;
  readonly exclusions: readonly string[];
  readonly window: SloWindow;
  readonly windowSource: "SPECIFICATION" | "ENGINEERING_PROPOSAL";
  /** Catalogue metric that carries the samples (platform/src/observability/metrics.ts). */
  readonly metric: string;
  readonly breakdowns: readonly BreakdownDimension[];
  /** Quantities that must be reported alongside, never folded into attainment. */
  readonly reportSeparately: readonly string[];
  /** Operational consequence when the objective is missed. */
  readonly onMiss: string;
}

export const SERVICE_OBJECTIVES: readonly SloDefinition[] = [
  {
    id: "routing_usable_path",
    description: "Routing to a usable support path",
    target: { kind: "ratio", minRatio: 0.9995 },
    targetStatus: "PROPOSED",
    measured: false,
    measurementPoint: "End to end: inbound call answered by the Talkdesk number to the caller reaching an admitted AI session, a staffed queue or callback intake, from telephony event exports (TB-07 dependent)",
    numerator: "Inbound calls that reached a usable support path (AI session admitted, staffed human queue, approved callback intake or safety route)",
    denominator: "All inbound calls answered by the platform's Talkdesk numbers",
    exclusions: ["Calls the caller abandoned before the routing decision was offered", "Synthetic test calls tagged as test traffic", "Calls that never reached Talkdesk (carrier failures are tracked separately)"],
    window: { kind: "calendar_month" },
    windowSource: "SPECIFICATION",
    metric: "vsp_routing_outcomes_total",
    breakdowns: ["language", "region", "audience", "load_band"],
    reportSeparately: ["calls routed via outage continuity mode", "calls abandoned before routing"],
    onMiss: "Incident review; AI-off continuity route capacity reassessed (OPS-02)",
  },
  {
    id: "warm_simple_turn_latency",
    description: "Warm simple-turn latency: end of caller speech to first meaningful audio at handset",
    target: { kind: "latency", percentiles: [{ p: 50, maxMs: 800 }, { p: 95, maxMs: 1500 }] },
    targetStatus: "PROPOSED",
    measured: false,
    measurementPoint: "Handset: end of caller speech (endpointing) to first meaningful bot audio, measured over the real telephone path",
    numerator: "Turn latency samples (distribution)",
    denominator: "Warm simple turns (no tool call) in the window",
    exclusions: ["First turn of a call (cold start)", "Tool-backed turns (see tool_backed_substantive_response)", "Acknowledgment-only audio does not count as meaningful audio"],
    window: { kind: "rolling_days", days: 7 },
    windowSource: "ENGINEERING_PROPOSAL",
    metric: "vsp_turn_latency_ms",
    breakdowns: SLO_BREAKDOWNS,
    reportSeparately: ["ASR endpointing, reasoning, policy validation, synthesis and network contributions"],
    onMiss: "Latency regression investigation per contribution; no release promotion on regression",
  },
  {
    id: "tool_backed_substantive_response",
    description: "Tool-backed substantive response latency when dependencies are healthy",
    target: { kind: "latency", percentiles: [{ p: 95, maxMs: 3000 }] },
    targetStatus: "PROPOSED",
    measured: false,
    measurementPoint: "Handset: end of caller speech to first substantive (non-acknowledgment) audio for turns that invoked a tool",
    numerator: "Substantive response latency samples (distribution)",
    denominator: "Tool-backed turns with all dependencies healthy",
    exclusions: ["Turns while any involved dependency circuit was open or half-open (dependencies not healthy)", "Acknowledgment latency (counted separately)"],
    window: { kind: "rolling_days", days: 7 },
    windowSource: "ENGINEERING_PROPOSAL",
    metric: "vsp_turn_latency_ms",
    breakdowns: SLO_BREAKDOWNS,
    reportSeparately: ["acknowledgment latency", "tool wait time", "turns during unhealthy dependencies"],
    onMiss: "Dependency latency review; acknowledgment must not hide a stall",
  },
  {
    id: "barge_in_stop",
    description: "Barge-in stop: detected interruption to last bot audio at handset",
    target: { kind: "latency", percentiles: [{ p: 95, maxMs: 250 }] },
    targetStatus: "PROPOSED",
    measured: false,
    measurementPoint: "Handset: detected caller interruption to the last bot audio frame heard",
    numerator: "Barge-in stop latency samples (distribution)",
    denominator: "Detected interruptions while bot audio was playing",
    exclusions: ["Interruptions detected after bot audio had already ended"],
    window: { kind: "rolling_days", days: 7 },
    windowSource: "ENGINEERING_PROPOSAL",
    metric: "vsp_barge_in_stop_ms",
    breakdowns: ["language"],
    reportSeparately: ["stale response segments invalidated after barge-in"],
    onMiss: "Voice runtime regression; affected language not promoted",
  },
  {
    id: "critical_action_authorization",
    description: "Protected actions require a valid server-side policy decision",
    target: { kind: "ratio", minRatio: 1 },
    targetStatus: "PROPOSED",
    measured: false,
    measurementPoint: "Gateway: before execution of every protected read or mutation",
    numerator: "Protected actions executed with a valid allow decision recorded before execution",
    denominator: "Protected actions executed",
    exclusions: [],
    window: { kind: "rolling_days", days: 30 },
    windowSource: "ENGINEERING_PROPOSAL",
    metric: "vsp_protected_actions_total",
    breakdowns: ["intent"],
    reportSeparately: ["policy denials"],
    onMiss: "Critical failure: contain affected automation immediately",
  },
  {
    id: "audited_accepted_actions",
    description: "Accepted actions durably recorded before acknowledgment",
    target: { kind: "ratio", minRatio: 1 },
    targetStatus: "PROPOSED",
    measured: false,
    measurementPoint: "Action ledger commit: audit event durably appended in the same transaction before the caller is told",
    numerator: "Accepted consequential actions with durable audit evidence recorded before acknowledgment",
    denominator: "Accepted consequential actions",
    exclusions: [],
    window: { kind: "rolling_days", days: 30 },
    windowSource: "ENGINEERING_PROPOSAL",
    metric: "vsp_protected_actions_total",
    breakdowns: ["intent"],
    reportSeparately: ["actions blocked because audit was unavailable"],
    onMiss: "Critical failure: block consequential actions (OPS-01)",
  },
  {
    id: "crm_synchronization",
    description: "CRM synchronization within 60 seconds after accepted finalization under normal dependencies",
    target: { kind: "ratio", minRatio: 0.999 },
    targetStatus: "PROPOSED",
    measured: false,
    measurementPoint: "Support-record outbox: accepted finalization to confirmed Salesforce upsert",
    numerator: "Support requests synchronized within 60 seconds",
    denominator: "Support requests finalized while Salesforce was healthy",
    exclusions: ["Periods with a declared Salesforce outage or open circuit (reported separately)"],
    window: { kind: "calendar_month" },
    windowSource: "ENGINEERING_PROPOSAL",
    metric: "vsp_crm_sync_lag_ms",
    breakdowns: [],
    reportSeparately: ["dead-lettered records", "records synchronized after an outage"],
    onMiss: "Reconciliation dashboard review and operator repair flow",
  },
  {
    id: "duplicate_consequential_actions",
    description: "Duplicate consequential actions in required failure and retry tests",
    target: { kind: "zero_tolerance", maxEvents: 0 },
    targetStatus: "PROPOSED",
    measured: false,
    measurementPoint: "Authoritative system state after the required retry, redelivery and crash-after-commit tests (ACT-02)",
    numerator: "Duplicate external effects detected",
    denominator: "Consequential operations exercised by the required failure and retry tests",
    exclusions: [],
    window: { kind: "per_release_test_run" },
    windowSource: "ENGINEERING_PROPOSAL",
    metric: "vsp_duplicate_effects_total",
    breakdowns: [],
    reportSeparately: ["sample size and approximate 95 percent upper bound"],
    onMiss: "Release blocked",
  },
  {
    id: "handoff_completion",
    description: "Accepted transfer attempts connect when a receiver is available",
    target: { kind: "ratio", minRatio: 0.995 },
    targetStatus: "PROPOSED",
    measured: false,
    measurementPoint: "Transfer state machine: CALLER_CONFIRMED_CONNECTED reached for accepted transfer attempts (SAFE-04)",
    numerator: "Accepted transfer attempts that reached a verified connection",
    denominator: "Accepted transfer attempts where a receiver was available",
    exclusions: ["Attempts with no receiver available (reported separately, never dropped)"],
    window: { kind: "calendar_month" },
    windowSource: "ENGINEERING_PROPOSAL",
    metric: "vsp_transfers_total",
    breakdowns: ["language", "audience"],
    reportSeparately: ["failed attempts", "receiver unavailable attempts"],
    onMiss: "Failed safety transfer playbook for any safety handoff failure",
  },
  {
    id: "privacy_clinical_boundary_violations",
    description: "Privacy or clinical-boundary violations",
    target: { kind: "zero_tolerance", maxEvents: 0 },
    targetStatus: "PROPOSED",
    measured: false,
    measurementPoint: "Confirmed events from review of detected critical events, safety transfers and stratified call samples",
    numerator: "Confirmed critical privacy or clinical-boundary violations",
    denominator: "Reviewed interactions",
    exclusions: [],
    window: { kind: "rolling_days", days: 30 },
    windowSource: "ENGINEERING_PROPOSAL",
    metric: "vsp_boundary_violations_total",
    breakdowns: ["intent", "language"],
    reportSeparately: ["sample size and approximate 95 percent upper bound"],
    onMiss: "Any confirmed event blocks the affected automation",
  },
];

export function sloById(id: string): SloDefinition {
  const d = SERVICE_OBJECTIVES.find((s) => s.id === id);
  if (!d) throw new ValidationError("SLO_UNKNOWN");
  return d;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export type EvidenceKind = "synthetic_local" | "sandbox" | "production";

export interface SloSample {
  /** ISO-8601 UTC timestamp of the observation. */
  at: string;
  /** Latency SLOs. */
  valueMs?: number;
  /** Ratio and zero-tolerance SLOs: true = good / no violation. */
  good?: boolean;
  /** Sample falls under one of the SLO's declared exclusions. */
  excluded?: boolean;
  labels?: Partial<Record<BreakdownDimension, string>>;
}

export interface PercentileSummary {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export interface SloCheck {
  label: string;
  observed: number | null;
  threshold: number;
  met: boolean | null;
}

export type SloStatus = "MEETS_PROPOSED_TARGET" | "MISSES_PROPOSED_TARGET" | "INCONCLUSIVE";

export interface SloEvaluation {
  sloId: string;
  targetStatus: "PROPOSED";
  evidence: EvidenceKind;
  window: { start: string; end: string };
  sampleCount: number;
  excludedCount: number;
  minSamplesForConclusion: number;
  status: SloStatus;
  attainment: number | null;
  percentiles: PercentileSummary | null;
  checks: SloCheck[];
  /** Zero-tolerance: approximate one-sided 95 percent upper bound on the event rate when zero events were seen. */
  zeroEventUpperBound95: number | null;
}

/**
 * Nearest-rank percentile over an ascending-sorted array: the smallest value
 * such that at least p percent of samples are less than or equal to it.
 */
export function percentile(sortedAscending: readonly number[], p: number): number {
  if (sortedAscending.length === 0) throw new ValidationError("PERCENTILE_EMPTY");
  if (!(p > 0 && p <= 100)) throw new ValidationError("PERCENTILE_RANGE");
  const rank = Math.ceil((p / 100) * sortedAscending.length);
  const v = sortedAscending[Math.max(0, rank - 1)];
  if (v === undefined) throw new ValidationError("PERCENTILE_EMPTY");
  return v;
}

export function summarizeLatency(values: readonly number[]): PercentileSummary | null {
  const clean = values.filter((v) => Number.isFinite(v) && v >= 0);
  if (clean.length === 0) return null;
  const sorted = [...clean].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

/** Exact one-sided 95% upper bound for a rate after zero events in n independent opportunities (≈ 3/n). */
export function zeroEventUpperBound95(n: number): number | null {
  if (!Number.isInteger(n) || n <= 0) return null;
  return 1 - Math.pow(0.05, 1 / n);
}

/**
 * Smallest sample count at which the target is distinguishable at all:
 * latency → enough samples for the highest target percentile to differ from the
 * maximum (ceil(100 / (100 - p))); ratio below 1 → 1 / (1 - minRatio) so a single
 * bad sample cannot be invisible; 100 percent and zero-tolerance → 1.
 */
export function minSamplesForConclusion(def: SloDefinition): number {
  const t = def.target;
  if (t.kind === "latency") {
    const highest = Math.max(...t.percentiles.map((x) => x.p));
    return highest >= 100 ? 1 : Math.ceil(100 / (100 - highest) - 1e-9);
  }
  if (t.kind === "ratio" && t.minRatio < 1) return Math.ceil(1 / (1 - t.minRatio) - 1e-9);
  return 1;
}

export function windowBounds(def: SloDefinition, evaluationEnd: Date): { start: Date; end: Date } {
  const w = def.window;
  if (w.kind === "calendar_month") {
    const start = new Date(Date.UTC(evaluationEnd.getUTCFullYear(), evaluationEnd.getUTCMonth(), 1));
    return { start, end: evaluationEnd };
  }
  if (w.kind === "rolling_days") return { start: new Date(evaluationEnd.getTime() - w.days * 86_400_000), end: evaluationEnd };
  // per_release_test_run: the caller supplies exactly the samples of the run being evaluated.
  return { start: new Date(0), end: evaluationEnd };
}

export interface EvaluateOptions {
  /** End of the evaluation window (inject from Clock). */
  now: Date;
  evidence: EvidenceKind;
}

export function evaluateSlo(def: SloDefinition, samples: readonly SloSample[], opts: EvaluateOptions): SloEvaluation {
  const { start, end } = windowBounds(def, opts.now);
  const inWindow = samples.filter((s) => {
    const t = Date.parse(s.at);
    return Number.isFinite(t) && t >= start.getTime() && t <= end.getTime();
  });
  const excluded = inWindow.filter((s) => s.excluded === true);
  const counted = inWindow.filter((s) => s.excluded !== true);
  const minSamples = minSamplesForConclusion(def);
  const base = {
    sloId: def.id,
    targetStatus: "PROPOSED" as const,
    evidence: opts.evidence,
    window: { start: start.toISOString(), end: end.toISOString() },
    excludedCount: excluded.length,
    minSamplesForConclusion: minSamples,
  };
  const t = def.target;

  if (t.kind === "latency") {
    const values = counted.map((s) => s.valueMs).filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0);
    const summary = summarizeLatency(values);
    const checks: SloCheck[] = t.percentiles.map(({ p, maxMs }) => {
      const observed = summary ? (p === 50 ? summary.p50 : p === 95 ? summary.p95 : summary.p99) : null;
      return { label: `P${p} <= ${maxMs} ms`, observed, threshold: maxMs, met: observed === null ? null : observed <= maxMs };
    });
    const conclusive = values.length >= minSamples;
    return {
      ...base,
      sampleCount: values.length,
      status: !conclusive ? "INCONCLUSIVE" : checks.every((c) => c.met === true) ? "MEETS_PROPOSED_TARGET" : "MISSES_PROPOSED_TARGET",
      attainment: null,
      percentiles: summary,
      checks,
      zeroEventUpperBound95: null,
    };
  }

  const judged = counted.filter((s) => typeof s.good === "boolean");
  const good = judged.filter((s) => s.good === true).length;
  const bad = judged.length - good;
  const attainment = judged.length === 0 ? null : good / judged.length;
  if (t.kind === "ratio") {
    const conclusive = judged.length >= minSamples;
    const met = attainment === null ? null : attainment >= t.minRatio;
    return {
      ...base,
      sampleCount: judged.length,
      status: !conclusive || met === null ? "INCONCLUSIVE" : met ? "MEETS_PROPOSED_TARGET" : "MISSES_PROPOSED_TARGET",
      attainment,
      percentiles: null,
      checks: [{ label: `ratio >= ${t.minRatio}`, observed: attainment, threshold: t.minRatio, met }],
      zeroEventUpperBound95: null,
    };
  }

  // zero tolerance: any violation misses immediately, regardless of sample size.
  const status: SloStatus = bad > 0 ? "MISSES_PROPOSED_TARGET" : judged.length >= minSamples ? "MEETS_PROPOSED_TARGET" : "INCONCLUSIVE";
  return {
    ...base,
    sampleCount: judged.length,
    status,
    attainment,
    percentiles: null,
    checks: [{ label: "violations == 0", observed: judged.length === 0 ? null : bad, threshold: 0, met: judged.length === 0 ? null : bad === 0 }],
    zeroEventUpperBound95: bad === 0 ? zeroEventUpperBound95(judged.length) : null,
  };
}

/**
 * Evaluates the SLO separately per value of one breakdown dimension so averages
 * cannot hide a poorly served minority slice. Samples without the label are
 * grouped under "unlabelled".
 */
export function evaluateSloByBreakdown(
  def: SloDefinition,
  samples: readonly SloSample[],
  dimension: BreakdownDimension,
  opts: EvaluateOptions,
): Record<string, SloEvaluation> {
  if (!def.breakdowns.includes(dimension)) throw new ValidationError("SLO_BREAKDOWN_NOT_DECLARED");
  const groups = new Map<string, SloSample[]>();
  for (const s of samples) {
    const key = s.labels?.[dimension] ?? "unlabelled";
    const g = groups.get(key) ?? [];
    g.push(s);
    groups.set(key, g);
  }
  const out: Record<string, SloEvaluation> = {};
  for (const [k, g] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) out[k] = evaluateSlo(def, g, opts);
  return out;
}
