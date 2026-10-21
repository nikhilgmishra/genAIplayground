/**
 * Evaluation aggregation (spec section 14; follow-on prompt section 17).
 *
 * - Fixed required denominator (FO-17-14): every rate and every gate is computed over the required
 *   scenario set (the per-gate manifest of scenarios/manifests/required-scenarios.json, or, without one,
 *   every scenario passed in at its declared repetitions). A required run without a result is NOT_RUN;
 *   NOT_RUN, INCONCLUSIVE and skipped runs count as not-PASS in every rate. A result for another
 *   scenario version, a repetition beyond the declared count or an unknown scenario is an exclusion, listed,
 *   never a pass.
 * - Slices by intent, language, audience, variant, risk class, failure severity, version, corpus split and
 *   execution mode, each with its required denominator.
 * - Every critical (hard-gate) failure is listed individually; it is never hidden inside an average.
 * - Production-frequency weighting applies only to the routine quality corpus and is reported separately
 *   from the deliberately oversampled risk sets, which are always unweighted.
 * - Zero-failure slices get rule-of-three / Clopper-Pearson upper bounds with an explicit caveat.
 * - Gate status per environment: local_fixture results can never satisfy a sandbox, staging or production
 *   gate; a gate PASSes only when every required run of its manifest is PASS.
 * - Coverage holes (FO-17-15): required runs not run, intents with no passing run, faults of the fixed
 *   registry without an independently reached and asserted run, unsupported driver steps and the most
 *   frequent INCONCLUSIVE reasons.
 * - Latency (FO-17-41): p50/p95/p99 with distribution-free intervals by intent, language, audience,
 *   assurance, model, voice, load and region, with sample counts, exclusions and missing observations,
 *   labelled with the clock they were measured on.
 * - Goal completion against the PROPOSED target (FO-17-46): named as proposed, with execution mode and
 *   sample size, never stated as met by local evidence.
 * - Verified resolution and containment are reported separately, by intent (SPEC-13.resolution-metrics);
 *   containment never feeds a rate, gate, target or regression.
 */
import type { Environment, EvaluationResult, RiskClass, ScenarioDefinition } from "../protocol/index.js";
import { GATE_RULES, parseRequiredRef } from "./corpus-manifests.js";
import type { RequiredManifests } from "./corpus-manifests.js";
import type { FaultPlan } from "./fault-plan.js";
import { ELIGIBLE_EXECUTION_MODES, severityOf } from "./scorer.js";
import type { Severity } from "./scorer.js";
import { UNCERTAINTY_CAVEAT, failureRateBound, quantileWithInterval } from "./stats.js";
import type { FailureRateBound, QuantileEstimate } from "./stats.js";

/** Proposed target (spec section 14, follow-on prompt section 17), not an approved launch criterion or a measurement. */
export const PROPOSED_GOAL_COMPLETION = 0.95;

export interface SliceStats {
  /** Results present in the slice (required or not). */
  runs: number;
  scenarios: number;
  /** Required runs of the slice: the fixed denominator. */
  required: number;
  /** Required runs with no result (counted as not-PASS). */
  notRun: number;
  pass: number;
  fail: number;
  inconclusive: number;
  other: number;
  criticalFailures: number;
  majorFailures: number;
  /** PASS among required runs / required runs (fixed denominator; NOT_RUN and INCONCLUSIVE are not-PASS); null without required runs. */
  taskCompletionRate: number | null;
  criticalBoundPerRun: FailureRateBound;
  /** Conservative: distinct scenarios with at least one critical failure over distinct scenarios. */
  criticalBoundPerScenario: FailureRateBound;
}

export interface CriticalFailure {
  scenarioId: string;
  repetition: number;
  intent: string | null;
  riskClass: RiskClass | null;
  executionMode: EvaluationResult["executionMode"];
  failureCode: string | null;
  failedHardAssertions: string[];
}

export interface ResolutionStats {
  runs: number;
  /** Runs whose final outcome was collected: the verified-resolution denominator. */
  runsWithOutcome: number;
  /** RESOLVED with the transaction hard gate passing (reconciled commit receipts). Never REQUEST_ACCEPTED (ACT-04). */
  verifiedResolutions: number;
  verifiedResolutionRate: number | null;
  /** Runs whose transfer evidence was collected: the containment denominator. */
  runsWithTransferEvidence: number;
  /** Runs that ended without a human transfer attempt (reported only; never a success measure). */
  contained: number;
  containmentRate: number | null;
  /** Contained runs without a verified resolution: containment is not resolution. */
  containedWithoutVerifiedResolution: number;
  /** Runs whose required handoff failed the safety hard gate. Never containment success. */
  requiredHandoffMissed: number;
}

export type GateStatus = "PASS" | "FAIL" | "INCONCLUSIVE" | "BLOCKED";

export interface GateEvaluation {
  status: GateStatus;
  eligibleExecutionModes: readonly string[];
  eligibleResults: number;
  /** The gate's fixed denominator: required runs of its manifest. */
  requiredRuns: number;
  requiredPass: number;
  requiredNotRun: number;
  requiredNotPass: number;
  manifest: string;
  reasons: string[];
}

export interface Exclusion {
  scenarioId: string;
  repetition: number;
  reason: "UNKNOWN_SCENARIO" | "VERSION_NOT_REQUIRED" | "REPETITION_BEYOND_REQUIRED" | "DUPLICATE_RESULT";
}

export interface FaultCoverage {
  faultId: string;
  /** Local runs that requested the fault. */
  requested: number;
  /** Local runs whose fault point was independently observed (reachedFault set). */
  reached: number;
  /** Reached runs whose verdict is PASS. */
  reachedAndPassed: number;
  /** Requested runs whose fault was not independently observed (INCONCLUSIVE, never PASS). */
  notReached: number;
  /** Layer-2 [FAULT:<id>] run status from the fault registry report, when supplied. */
  layer2: "PASS" | "FAIL" | "INCONCLUSIVE" | "NOT_RUN" | "UNKNOWN";
}

export interface CoverageHoles {
  requiredNotRun: { count: number; byIntent: Record<string, number>; sample: string[] };
  intentsWithoutPass: string[];
  faultsWithoutReachedRun: string[];
  faults: FaultCoverage[];
  unsupportedDriverSteps: Record<string, number>;
  inconclusiveReasons: Record<string, number>;
  audiencesWithoutPass: string[];
  localesWithoutPass: string[];
}

export interface LatencySlice {
  calls: number;
  samples: number;
  /** Required runs of the slice whose latency observations are missing (no result or not collected). */
  missingObservations: number;
  p50: QuantileEstimate;
  p95: QuantileEstimate;
  p99: QuantileEstimate;
}

/** Latency slice dimensions (FO-17-41), in report order. */
export const LATENCY_DIMENSIONS = ["intent", "language", "audience", "assurance", "model", "voice", "load", "region"] as const;
export type LatencyDimension = (typeof LATENCY_DIMENSIONS)[number];

export interface LatencyReport {
  /** Clock the samples were taken on: simulated (FakeClock) for local fixture runs; real for audio drivers. */
  clock: "simulated" | "real" | "mixed" | "none";
  note: string;
  dimensions: Record<LatencyDimension, Record<string, LatencySlice>>;
}

export interface GoalCompletion {
  target: number;
  targetStatus: "PROPOSED";
  /** True only for measurements from an eligible non-local execution mode; local fixture evidence never is. */
  measured: boolean;
  executionModes: string[];
  /** Required routine runs (fixed denominator). */
  sampleSize: number;
  passes: number;
  rate: number | null;
  status: "MEETS_PROPOSED_TARGET" | "MISSES_PROPOSED_TARGET" | "INCONCLUSIVE";
  statement: string;
}

export interface EvaluationAggregate {
  aggregateVersion: "evaluation-aggregate.v2";
  runIds: string[];
  totals: SliceStats;
  criticalFailures: CriticalFailure[];
  slices: Record<"intent" | "language" | "audience" | "variant" | "riskClass" | "severity" | "version" | "corpusSplit" | "executionMode", Record<string, SliceStats>>;
  routineQuality: {
    weighting: "production_frequency";
    weightedTaskCompletion: number | null;
    weightsSource: string | null;
    reason: string;
    unweightedTaskCompletion: number | null;
    proposedTarget: number;
    goalCompletion: GoalCompletion;
    intentsBelowProposedTarget: string[];
  };
  oversampledRisk: { note: string; totals: SliceStats; byRiskClass: Record<string, SliceStats> };
  /** Verified resolution and containment, separately and by intent (reported; never part of a gate or rate above). */
  resolution: { note: string; totals: ResolutionStats; byIntent: Record<string, ResolutionStats> };
  executionModes: Record<string, number>;
  localFixtureOnly: boolean;
  denominator: { source: "required_manifest" | "scenario_set"; manifestDigest: string | null; requiredRuns: number; resultsInDenominator: number; exclusions: Exclusion[] };
  gates: Record<Environment, GateEvaluation>;
  coverageHoles: CoverageHoles;
  latency: LatencyReport;
  regression: RegressionReport | null;
  unknownScenarioIds: string[];
  caveats: string[];
}

export interface AggregateOptions {
  /** Production-frequency weights per intent (UNKNOWN until approved traffic data exists, PRQ-046). */
  productionWeights?: { source: string; weights: Record<string, number> } | null;
  baseline?: EvaluationAggregate | null;
  /** Human-reviewed risk scenarios required before a production gate can pass (spec: >= 500). */
  minimumHumanReviewedRisk?: number;
  /** Scenario ids of the deliberately oversampled risk set (default: the `scn_risk_` prefix). */
  isOversampledRisk?: (scenarioId: string) => boolean;
  /** Per-gate required manifests; without them every scenario passed in is required at its repetitions (the local rule). */
  required?: RequiredManifests | null;
  /** The fixed fault registry (every FO-17-24 fault id), for the fault coverage holes. */
  faultPlans?: ReadonlyMap<string, FaultPlan> | null;
  /** Layer-2 [FAULT:<id>] run status per fault from fault-registry.ts, when available. */
  layer2Faults?: Readonly<Record<string, FaultCoverage["layer2"]>> | null;
  /** Turn latencies per result (`<scenarioId>#<repetition>`) from the call evidence, and their clock. */
  latencySamples?: { clock: "simulated" | "real"; byResult: ReadonlyMap<string, readonly number[]> } | null;
}

export const DEFAULT_RISK_PREFIX = "scn_risk_";

const versionKey = (r: EvaluationResult) =>
  [r.versions.agentConfig, r.versions.model, r.versions.voice, r.versions.policyBundle, r.versions.toolCatalog.slice(0, 12), r.versions.knowledgeSnapshot].join("|");

/** A required run of the denominator with the result that satisfies it (null: NOT_RUN), or an extra result outside it. */
interface RunRecord {
  scenario: ScenarioDefinition | null;
  scenarioId: string;
  repetition: number;
  required: boolean;
  result: EvaluationResult | null;
}

const keyOf = (id: string, rep: number) => `${id}#${rep}`;

function sliceStats(records: readonly RunRecord[]): SliceStats {
  const results = records.flatMap((r) => (r.result ? [r.result] : []));
  const required = records.filter((r) => r.required);
  const requiredPass = required.filter((r) => r.result?.verdict === "PASS").length;
  const pass = results.filter((r) => r.verdict === "PASS").length;
  const fail = results.filter((r) => r.verdict === "FAIL").length;
  const inconclusive = results.filter((r) => r.verdict === "INCONCLUSIVE").length;
  const sev = results.map(severityOf);
  const critical = sev.filter((s) => s === "CRITICAL").length;
  const scenarios = new Set(results.map((r) => r.scenarioId));
  const criticalScenarios = new Set(results.filter((r) => severityOf(r) === "CRITICAL").map((r) => r.scenarioId));
  return {
    runs: results.length,
    scenarios: scenarios.size,
    required: required.length,
    notRun: required.filter((r) => r.result === null).length,
    pass,
    fail,
    inconclusive,
    other: results.length - pass - fail - inconclusive,
    criticalFailures: critical,
    majorFailures: sev.filter((s) => s === "MAJOR").length,
    taskCompletionRate: required.length > 0 ? requiredPass / required.length : null,
    criticalBoundPerRun: failureRateBound(critical, results.length),
    criticalBoundPerScenario: failureRateBound(criticalScenarios.size, scenarios.size),
  };
}

/** Verified resolution: RESOLVED with the transaction hard gate passing; anything else (an accepted request included) is not. */
export const isVerifiedResolutionResult = (r: EvaluationResult): boolean => r.finalResolution === "RESOLVED" && r.transactionResult === "PASS";

/**
 * Containment: transfer evidence collected and no human transfer attempted. An attempted transfer that did not
 * connect (NOT_CONNECTED) or continued on a fallback route (FALLBACK_INVOKED) is not containment, and neither is
 * a run without transfer evidence (null). Says nothing about resolution.
 */
export const isContainedResult = (r: EvaluationResult): boolean => r.transferOutcome === "NOT_ATTEMPTED";

function resolutionStats(results: readonly EvaluationResult[]): ResolutionStats {
  const withOutcome = results.filter((r) => r.finalResolution !== null);
  const withTransfer = results.filter((r) => r.transferOutcome !== null);
  const verified = results.filter(isVerifiedResolutionResult).length;
  const contained = results.filter(isContainedResult);
  return {
    runs: results.length,
    runsWithOutcome: withOutcome.length,
    verifiedResolutions: verified,
    verifiedResolutionRate: withOutcome.length > 0 ? verified / withOutcome.length : null,
    runsWithTransferEvidence: withTransfer.length,
    contained: contained.length,
    containmentRate: withTransfer.length > 0 ? contained.length / withTransfer.length : null,
    containedWithoutVerifiedResolution: contained.filter((r) => !isVerifiedResolutionResult(r)).length,
    requiredHandoffMissed: results.filter((r) => r.assertions.some((a) => a.assertionId === "gate.safety.required_handoff" && a.verdict === "FAIL")).length,
  };
}

function groupBy(records: readonly RunRecord[], key: (r: RunRecord) => string): Record<string, SliceStats> {
  const groups = new Map<string, RunRecord[]>();
  for (const r of records) groups.set(key(r), [...(groups.get(key(r)) ?? []), r]);
  return Object.fromEntries([...groups.keys()].sort().map((k) => [k, sliceStats(groups.get(k) ?? [])]));
}

/** Required runs of one gate (from its manifest, or every scenario at its repetitions). */
function requiredFor(env: Environment, byId: ReadonlyMap<string, ScenarioDefinition>, manifests: RequiredManifests | null | undefined): { id: string; version: number; repetitions: number }[] {
  if (manifests) return manifests.gates[env].required.map(parseRequiredRef).map((r) => ({ id: r.scenarioId, version: r.version, repetitions: r.repetitions }));
  return [...byId.values()].filter(GATE_RULES[env].includes).map((s) => ({ id: s.scenarioId, version: s.version, repetitions: s.repetitions }));
}

/** Matches results to the required runs (first result per scenario, version and repetition) and lists the rest as exclusions. */
function denominatorRecords(results: readonly EvaluationResult[], byId: ReadonlyMap<string, ScenarioDefinition>, required: readonly { id: string; version: number; repetitions: number }[]): { records: RunRecord[]; exclusions: Exclusion[] } {
  const req = new Map(required.map((r) => [r.id, r]));
  const matched = new Map<string, EvaluationResult>();
  const exclusions: Exclusion[] = [];
  const extra: RunRecord[] = [];
  for (const r of results) {
    const want = req.get(r.scenarioId);
    const scenario = byId.get(r.scenarioId) ?? null;
    let reason: Exclusion["reason"] | null = null;
    if (!want) reason = scenario ? null : "UNKNOWN_SCENARIO";
    else if (r.scenarioVersion !== want.version) reason = "VERSION_NOT_REQUIRED";
    else if (r.repetition > want.repetitions) reason = "REPETITION_BEYOND_REQUIRED";
    else if (matched.has(keyOf(r.scenarioId, r.repetition))) reason = "DUPLICATE_RESULT";
    if (want && reason === null) {
      matched.set(keyOf(r.scenarioId, r.repetition), r);
      continue;
    }
    if (reason) exclusions.push({ scenarioId: r.scenarioId, repetition: r.repetition, reason });
    extra.push({ scenario, scenarioId: r.scenarioId, repetition: r.repetition, required: false, result: r });
  }
  const records: RunRecord[] = [];
  for (const r of required) {
    for (let rep = 1; rep <= r.repetitions; rep++) records.push({ scenario: byId.get(r.id) ?? null, scenarioId: r.id, repetition: rep, required: true, result: matched.get(keyOf(r.id, rep)) ?? null });
  }
  return { records: [...records, ...extra], exclusions };
}

function gateFor(
  env: Environment,
  results: readonly EvaluationResult[],
  byId: ReadonlyMap<string, ScenarioDefinition>,
  minReviewedRisk: number,
  manifests: RequiredManifests | null | undefined,
): GateEvaluation {
  const modes = ELIGIBLE_EXECUTION_MODES[env];
  const eligible = results.filter((r) => modes.includes(r.executionMode) && r.environment === env);
  const required = requiredFor(env, byId, manifests);
  const { records } = denominatorRecords(eligible, byId, required);
  const req = records.filter((r) => r.required);
  const requiredPass = req.filter((r) => r.result?.verdict === "PASS").length;
  const requiredNotRun = req.filter((r) => r.result === null).length;
  const base = {
    eligibleExecutionModes: modes,
    eligibleResults: eligible.length,
    requiredRuns: req.length,
    requiredPass,
    requiredNotRun,
    requiredNotPass: req.length - requiredPass,
    manifest: manifests ? `scenarios/manifests/required-scenarios.json#${env}` : `scenario set (${GATE_RULES[env].rule})`,
  };
  const reasons: string[] = [];
  const live = env === "sandbox" || env === "staging" || env === "production";
  if (eligible.length === 0) {
    const present = [...new Set(results.map((r) => r.executionMode))].join(",") || "none";
    reasons.push(
      live ? `NO_ELIGIBLE_EVIDENCE: results are ${present}; local_fixture evidence can never satisfy a ${env} gate` : `NO_ELIGIBLE_EVIDENCE: no ${modes.join("/")} results recorded for ${env}`,
    );
    if (req.length > 0) reasons.push(`REQUIRED_NOT_RUN: ${requiredNotRun} of ${req.length} required runs`);
    return { ...base, status: live ? "BLOCKED" : "INCONCLUSIVE", reasons };
  }
  if (live) {
    const unreviewed = eligible.filter((r) => byId.get(r.scenarioId)?.review.status !== "HUMAN_REVIEWED").length;
    if (unreviewed > 0) reasons.push(`CORPUS_NOT_HUMAN_REVIEWED: ${unreviewed} result(s) from scenarios without human review (PRQ-012, AIN-31)`);
    if (env === "production") {
      const reviewedRisk = [...byId.values()].filter((s) => s.riskClass !== "routine" && s.review.status === "HUMAN_REVIEWED").length;
      if (reviewedRisk < minReviewedRisk) reasons.push(`RISK_CORPUS_BELOW_MINIMUM: ${reviewedRisk} human-reviewed risk scenarios < ${minReviewedRisk}`);
    }
  }
  const critical = eligible.filter((r) => severityOf(r) === "CRITICAL").length;
  const failing = eligible.filter((r) => r.verdict === "FAIL").length;
  const inconclusive = eligible.filter((r) => r.verdict !== "PASS" && r.verdict !== "FAIL").length;
  if (critical > 0) reasons.push(`CRITICAL_FAILURES: ${critical}`);
  if (failing > 0) reasons.push(`FAILING_RESULTS: ${failing}`);
  if (inconclusive > 0) reasons.push(`INCONCLUSIVE_RESULTS: ${inconclusive}`);
  if (requiredNotRun > 0) reasons.push(`REQUIRED_NOT_RUN: ${requiredNotRun} of ${req.length} required runs`);
  const blocked = reasons.some((r) => r.startsWith("CORPUS_NOT_HUMAN_REVIEWED") || r.startsWith("RISK_CORPUS_BELOW_MINIMUM"));
  const status: GateStatus = critical > 0 || failing > 0 ? "FAIL" : blocked ? "BLOCKED" : requiredPass < req.length || inconclusive > 0 ? "INCONCLUSIVE" : "PASS";
  return { ...base, status, reasons };
}

export interface RegressionReport {
  baselineRunIds: string[];
  newCriticalFailures: { scenarioId: string; failureCode: string | null }[];
  sliceRegressions: { dimension: string; key: string; baselineRate: number; currentRate: number }[];
}

export function compareAggregates(current: EvaluationAggregate, baseline: EvaluationAggregate): RegressionReport {
  const before = new Set(baseline.criticalFailures.map((c) => c.scenarioId));
  const newCriticalFailures = [...new Map(current.criticalFailures.filter((c) => !before.has(c.scenarioId)).map((c) => [c.scenarioId, c])).values()].map((c) => ({
    scenarioId: c.scenarioId,
    failureCode: c.failureCode,
  }));
  const sliceRegressions: RegressionReport["sliceRegressions"] = [];
  for (const dim of ["intent", "language", "audience", "variant", "riskClass"] as const) {
    for (const [key, cur] of Object.entries(current.slices[dim])) {
      const prev = baseline.slices[dim][key];
      if (!prev || prev.taskCompletionRate === null || cur.taskCompletionRate === null) continue;
      if (cur.taskCompletionRate < prev.taskCompletionRate || cur.criticalFailures > prev.criticalFailures) {
        sliceRegressions.push({ dimension: dim, key, baselineRate: prev.taskCompletionRate, currentRate: cur.taskCompletionRate });
      }
    }
  }
  return { baselineRunIds: baseline.runIds, newCriticalFailures, sliceRegressions };
}

const firstInconclusiveFamily = (r: EvaluationResult): string => {
  const a = r.assertions.find((x) => x.verdict === "INCONCLUSIVE");
  if (!a) return "unknown";
  return a.assertionId.replace(/^evidence\.fault_reached\..*/, "evidence.fault_reached").replace(/^fault\.[a-z0-9_]+\./, "fault.");
};

function coverageHoles(records: readonly RunRecord[], results: readonly EvaluationResult[], byId: ReadonlyMap<string, ScenarioDefinition>, opts: AggregateOptions): CoverageHoles {
  const notRun = records.filter((r) => r.required && r.result === null);
  const byIntent: Record<string, number> = {};
  for (const r of notRun) byIntent[r.scenario?.intent ?? "UNKNOWN_SCENARIO"] = (byIntent[r.scenario?.intent ?? "UNKNOWN_SCENARIO"] ?? 0) + 1;
  const passBy = (key: (s: ScenarioDefinition) => string) => {
    const all = new Set<string>();
    const passed = new Set<string>();
    for (const r of records.filter((x) => x.required && x.scenario)) {
      const k = key(r.scenario as ScenarioDefinition);
      all.add(k);
      if (r.result?.verdict === "PASS") passed.add(k);
    }
    return [...all].filter((k) => !passed.has(k)).sort();
  };
  const faultIds = [...new Set([...(opts.faultPlans ? [...opts.faultPlans.keys()] : []), ...results.flatMap((r) => (r.requestedFault ? [r.requestedFault] : []))])].sort();
  const faults: FaultCoverage[] = faultIds.map((faultId) => {
    const requested = results.filter((r) => (byId.get(r.scenarioId)?.initialState.faults ?? (r.requestedFault ? [r.requestedFault] : [])).includes(faultId));
    const reached = requested.filter((r) => r.requestedFault === faultId && r.reachedFault?.faultId === faultId);
    return {
      faultId,
      requested: requested.length,
      reached: reached.length,
      reachedAndPassed: reached.filter((r) => r.verdict === "PASS").length,
      notReached: requested.filter((r) => r.assertions.some((a) => a.assertionId === `evidence.fault_reached.${faultId.toLowerCase()}` && a.verdict !== "PASS")).length,
      layer2: opts.layer2Faults?.[faultId] ?? "UNKNOWN",
    };
  });
  const unsupported: Record<string, number> = {};
  const inconclusive: Record<string, number> = {};
  for (const r of results) {
    const u = r.assertions.find((a) => a.assertionId === "evidence.driver_supported" && a.verdict !== "PASS");
    for (const step of u ? u.detail.replace(/^unsupported: /, "").split(",") : []) {
      const k = step.replace(/:[^:]*$/, "").slice(0, 80);
      unsupported[k] = (unsupported[k] ?? 0) + 1;
    }
    if (r.verdict === "INCONCLUSIVE") inconclusive[firstInconclusiveFamily(r)] = (inconclusive[firstInconclusiveFamily(r)] ?? 0) + 1;
  }
  const sortCount = (m: Record<string, number>) => Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 40));
  return {
    requiredNotRun: { count: notRun.length, byIntent: sortCount(byIntent), sample: notRun.slice(0, 50).map((r) => keyOf(r.scenarioId, r.repetition)) },
    intentsWithoutPass: passBy((s) => s.intent),
    faultsWithoutReachedRun: faults.filter((f) => f.reachedAndPassed === 0 && f.layer2 !== "PASS").map((f) => f.faultId),
    faults,
    unsupportedDriverSteps: sortCount(unsupported),
    inconclusiveReasons: sortCount(inconclusive),
    audiencesWithoutPass: passBy((s) => s.audience ?? "unidentified"),
    localesWithoutPass: passBy((s) => s.locale),
  };
}

function latencyReport(records: readonly RunRecord[], opts: AggregateOptions): LatencyReport {
  const samples = opts.latencySamples ?? null;
  const dims = LATENCY_DIMENSIONS;
  const keyFns: Record<LatencyDimension, (r: RunRecord) => string> = {
    intent: (r) => r.scenario?.intent ?? "UNKNOWN_SCENARIO",
    language: (r) => r.scenario?.locale ?? r.result?.language ?? "unknown",
    audience: (r) => r.scenario?.audience ?? "unidentified",
    assurance: (r) => r.scenario?.expectedAssurance ?? "unknown",
    model: (r) => r.result?.versions.model ?? "NOT_RUN",
    voice: (r) => r.result?.versions.voice ?? "NOT_RUN",
    // The local corpus runs one call at a time in a fresh stack; load profiles come from platform/test/load.
    load: (r) => (r.result ? (r.result.executionMode === "local_fixture" ? "single_call_no_concurrency" : "unrecorded") : "NOT_RUN"),
    region: (r) => (r.result ? (r.result.environment === "local" || r.result.environment === "ci" ? "local_process" : "unrecorded") : "NOT_RUN"),
  };
  const dimensions = Object.fromEntries(
    dims.map((d) => {
      const groups = new Map<string, RunRecord[]>();
      for (const r of records) groups.set(keyFns[d](r), [...(groups.get(keyFns[d](r)) ?? []), r]);
      return [
        d,
        Object.fromEntries(
          [...groups.keys()].sort().map((k) => {
            const rs = groups.get(k) ?? [];
            const values = rs.flatMap((r) => (r.result ? [...(samples?.byResult.get(keyOf(r.scenarioId, r.repetition)) ?? [])] : []));
            const missing = rs.filter((r) => r.required && (r.result === null || !samples || (samples.byResult.get(keyOf(r.scenarioId, r.repetition)) ?? []).length === 0)).length;
            return [k, { calls: rs.filter((r) => r.result).length, samples: values.length, missingObservations: missing, p50: quantileWithInterval(values, 0.5), p95: quantileWithInterval(values, 0.95), p99: quantileWithInterval(values, 0.99) } satisfies LatencySlice];
          }),
        ),
      ];
    }),
  ) as LatencyReport["dimensions"];
  return {
    clock: samples ? samples.clock : "none",
    note: samples
      ? `Turn latencies on the ${samples.clock} clock${samples.clock === "simulated" ? " (local fixture FakeClock: they are not real-time or handset latencies)" : ""}. Intervals are distribution-free 95% order-statistic intervals that assume independent samples; turns of one call and repetitions of one scenario are not independent, and null bounds mean the sample is too small.`
      : "No latency samples were supplied (call evidence not read); every slice reports missing observations only.",
    dimensions,
  };
}

export function aggregateResults(results: readonly EvaluationResult[], scenarios: Iterable<ScenarioDefinition>, opts: AggregateOptions = {}): EvaluationAggregate {
  const byId = new Map<string, ScenarioDefinition>();
  for (const s of scenarios) byId.set(s.scenarioId, s);
  const isRisk = opts.isOversampledRisk ?? ((id: string) => id.startsWith(DEFAULT_RISK_PREFIX));
  const { records, exclusions } = denominatorRecords(results, byId, requiredFor("local", byId, opts.required));
  const intentOfRec = (r: RunRecord) => r.scenario?.intent ?? "UNKNOWN_SCENARIO";
  const riskOfRec = (r: RunRecord) => r.scenario?.riskClass ?? "UNKNOWN_SCENARIO";
  const routineRecs = records.filter((r) => r.scenario && !isRisk(r.scenarioId));
  const riskRecs = records.filter((r) => r.scenario && isRisk(r.scenarioId));
  const routineByIntent = groupBy(routineRecs, intentOfRec);

  let weighted: number | null = null;
  let reason = "UNKNOWN: production-frequency weights require approved traffic statistics (PRQ-046); weighted completion not computed.";
  if (opts.productionWeights) {
    let num = 0;
    let den = 0;
    for (const [intent, w] of Object.entries(opts.productionWeights.weights)) {
      const rate = routineByIntent[intent]?.taskCompletionRate;
      if (rate === null || rate === undefined || !(w > 0)) continue;
      num += w * rate;
      den += w;
    }
    weighted = den > 0 ? num / den : null;
    reason = den > 0 ? "Weighted by the supplied production-frequency weights over the routine quality corpus only (fixed denominators per intent)." : "Supplied weights matched no routine-corpus intent with results.";
  }
  const criticalFailures: CriticalFailure[] = results
    .filter((r) => severityOf(r) === "CRITICAL")
    .map((r) => ({
      scenarioId: r.scenarioId,
      repetition: r.repetition,
      intent: byId.get(r.scenarioId)?.intent ?? null,
      riskClass: byId.get(r.scenarioId)?.riskClass ?? null,
      executionMode: r.executionMode,
      failureCode: r.failureCode,
      failedHardAssertions: r.assertions.filter((a) => a.hardGate && a.verdict === "FAIL").map((a) => a.assertionId),
    }));
  const executionModes: Record<string, number> = {};
  for (const r of results) executionModes[r.executionMode] = (executionModes[r.executionMode] ?? 0) + 1;
  const minReviewed = opts.minimumHumanReviewedRisk ?? 500;
  const envs: Environment[] = ["local", "ci", "sandbox", "staging", "production"];
  const routineStats = sliceStats(routineRecs);
  const modesPresent = [...new Set(routineRecs.flatMap((r) => (r.result ? [r.result.executionMode] : [])))].sort();
  const measured = modesPresent.length > 0 && modesPresent.every((m) => m === "pstn_sandbox" || m === "production_pilot");
  const goalRate = routineStats.taskCompletionRate;
  const goalStatus: GoalCompletion["status"] = goalRate === null ? "INCONCLUSIVE" : goalRate >= PROPOSED_GOAL_COMPLETION ? "MEETS_PROPOSED_TARGET" : "MISSES_PROPOSED_TARGET";
  const pctText = (x: number | null) => (x === null ? "n/a" : `${(x * 100).toFixed(2)}%`);
  const routinePass = routineRecs.filter((r) => r.required && r.result?.verdict === "PASS").length;
  const goalCompletion: GoalCompletion = {
    target: PROPOSED_GOAL_COMPLETION,
    targetStatus: "PROPOSED",
    measured,
    executionModes: modesPresent,
    sampleSize: routineStats.required,
    passes: routinePass,
    rate: goalRate,
    status: goalStatus,
    statement: `Routine goal completion ${routinePass}/${routineStats.required} = ${pctText(goalRate)} over the fixed required denominator (NOT_RUN and INCONCLUSIVE count as not-PASS) against the PROPOSED ${pctText(PROPOSED_GOAL_COMPLETION)} target (an engineering proposal, not a legal threshold or a measurement); execution mode ${modesPresent.join(",") || "none"}; ${goalStatus}${measured ? "" : " on non-measured evidence: no target is stated as met"}.`,
  };

  const agg: EvaluationAggregate = {
    aggregateVersion: "evaluation-aggregate.v2",
    runIds: [...new Set(results.map((r) => r.runId))].sort(),
    totals: sliceStats(records),
    criticalFailures,
    slices: {
      intent: groupBy(records, intentOfRec),
      language: groupBy(records, (r) => r.scenario?.locale ?? r.result?.language ?? "unknown"),
      audience: groupBy(records, (r) => r.scenario?.audience ?? r.result?.audience ?? "unidentified"),
      variant: groupBy(records, (r) => r.scenario?.variantFamily ?? r.result?.variant ?? "unknown"),
      riskClass: groupBy(records, riskOfRec),
      severity: groupBy(records, (r): Severity | "NOT_RUN" => (r.result ? severityOf(r.result) : "NOT_RUN")),
      version: groupBy(records, (r) => (r.result ? versionKey(r.result) : "NOT_RUN")),
      corpusSplit: groupBy(records, (r) => r.scenario?.split ?? r.result?.corpusSplit ?? "unknown"),
      executionMode: groupBy(records, (r) => r.result?.executionMode ?? "NOT_RUN"),
    },
    routineQuality: {
      weighting: "production_frequency",
      weightedTaskCompletion: weighted,
      weightsSource: opts.productionWeights?.source ?? null,
      reason,
      unweightedTaskCompletion: routineStats.taskCompletionRate,
      proposedTarget: PROPOSED_GOAL_COMPLETION,
      goalCompletion,
      intentsBelowProposedTarget: Object.entries(routineByIntent)
        .filter(([, s]) => s.criticalFailures > 0 || s.taskCompletionRate === null || s.taskCompletionRate < PROPOSED_GOAL_COMPLETION)
        .map(([k]) => k),
    },
    oversampledRisk: {
      note: "Deliberately oversampled risk scenarios; reported unweighted and never folded into production-weighted rates.",
      totals: sliceStats(riskRecs),
      byRiskClass: groupBy(riskRecs, riskOfRec),
    },
    resolution: {
      note: "Verified resolution (RESOLVED with the transaction gate passing; an accepted request is not resolution) and containment (no human transfer attempted) are reported separately. Containment is never a success measure: it feeds no task-completion rate, gate, target or regression, and a missed required handoff is a safety hard-gate failure.",
      totals: resolutionStats(results),
      byIntent: Object.fromEntries(
        [...new Set(results.map((r) => byId.get(r.scenarioId)?.intent ?? "UNKNOWN_SCENARIO"))].sort().map((k) => [k, resolutionStats(results.filter((r) => (byId.get(r.scenarioId)?.intent ?? "UNKNOWN_SCENARIO") === k))]),
      ),
    },
    executionModes,
    localFixtureOnly: results.length > 0 && results.every((r) => r.executionMode === "local_fixture"),
    denominator: {
      source: opts.required ? "required_manifest" : "scenario_set",
      manifestDigest: opts.required?.digest ?? null,
      requiredRuns: records.filter((r) => r.required).length,
      resultsInDenominator: records.filter((r) => r.required && r.result).length,
      exclusions,
    },
    gates: Object.fromEntries(envs.map((env) => [env, gateFor(env, results, byId, minReviewed, opts.required)])) as Record<Environment, GateEvaluation>,
    coverageHoles: coverageHoles(records, results, byId, opts),
    latency: latencyReport(records, opts),
    regression: null,
    unknownScenarioIds: [...new Set(results.filter((r) => !byId.has(r.scenarioId)).map((r) => r.scenarioId))],
    caveats: [
      UNCERTAINTY_CAVEAT,
      "Quality scores are recorded separately and never offset a hard-gate failure.",
      "Every rate uses the fixed required denominator: NOT_RUN, INCONCLUSIVE and skipped runs count as not-PASS; missing evidence is never counted as PASS.",
      "The 95% goal-completion figure is a PROPOSED target from the specification, not an approved launch criterion, a legal threshold or a measurement.",
    ],
  };
  if (agg.localFixtureOnly) agg.caveats.push("All results come from labelled local fixtures; they do not satisfy sandbox, staging or production gates and are not measurements.");
  if (opts.baseline) agg.regression = compareAggregates(agg, opts.baseline);
  return agg;
}

const pct = (x: number | null) => (x === null ? "—" : `${(x * 100).toFixed(2)}%`);
const ms = (q: QuantileEstimate) => (q.estimate === null ? "—" : `${Math.round(q.estimate)} [${q.lower95 === null ? "?" : Math.round(q.lower95)}, ${q.upper95 === null ? "?" : Math.round(q.upper95)}]`);

/** Human-readable run report (report.md). Contains no conversation content. */
/**
 * The "Latency by slice" section of the report: one table for every latency dimension (FO-17-41: intent,
 * language, audience, assurance, model, voice, load, region) with sample counts, missing observations and the
 * 95% interval of each quantile. Also used for addenda to reports rendered before every table was written
 * (evidence/evaluation/tools/latency-addendum.mts).
 */
export function latencySectionOf(agg: Pick<EvaluationAggregate, "latency">): string[] {
  const lines = ["## Latency by slice", "", agg.latency.note, ""];
  for (const d of LATENCY_DIMENSIONS) {
    const rows = Object.entries(agg.latency.dimensions[d]);
    if (rows.length === 0) continue;
    lines.push(`### ${d}`, "", "| Key | Calls | Samples | Missing observations | p50 ms [95% CI] | p95 ms [95% CI] | p99 ms [95% CI] |", "|---|---|---|---|---|---|---|");
    for (const [k, s] of rows.slice(0, 80)) lines.push(`| ${k} | ${s.calls} | ${s.samples} | ${s.missingObservations} | ${ms(s.p50)} | ${ms(s.p95)} | ${ms(s.p99)} |`);
    lines.push("");
  }
  return lines;
}

export function renderReport(agg: EvaluationAggregate, title = "Evaluation run report"): string {
  const lines: string[] = [];
  const t = agg.totals;
  lines.push(`# ${title}`, "");
  lines.push(`Runs: ${agg.runIds.join(", ") || "—"}  `);
  lines.push(`Execution modes: ${Object.entries(agg.executionModes).map(([k, v]) => `${k}=${v}`).join(", ") || "—"}`, "");
  if (agg.localFixtureOnly) lines.push("> **Local fixture evidence only.** These results cannot satisfy sandbox, staging or production gates and are not measurements.", "");
  lines.push(
    `Fixed denominator: ${agg.denominator.requiredRuns} required runs (${agg.denominator.source === "required_manifest" ? `required-scenario manifest \`${(agg.denominator.manifestDigest ?? "").slice(0, 16)}…\`` : "every scenario of the set at its declared repetitions"}); ${agg.denominator.resultsInDenominator} have a result; ${agg.denominator.exclusions.length} result(s) excluded.`,
    "",
  );
  lines.push("## Totals", "", "| Results | Scenarios | Required | NOT_RUN | PASS | FAIL | INCONCLUSIVE | Critical | Task completion (fixed denominator) |", "|---|---|---|---|---|---|---|---|---|");
  lines.push(`| ${t.runs} | ${t.scenarios} | ${t.required} | ${t.notRun} | ${t.pass} | ${t.fail} | ${t.inconclusive} | ${t.criticalFailures} | ${pct(t.taskCompletionRate)} |`, "");
  lines.push("## Gates", "", "| Environment | Status | Required runs | Required PASS | NOT_RUN | Eligible results | Reasons |", "|---|---|---|---|---|---|---|");
  for (const [env, g] of Object.entries(agg.gates)) lines.push(`| ${env} | ${g.status} | ${g.requiredRuns} | ${g.requiredPass} | ${g.requiredNotRun} | ${g.eligibleResults} | ${g.reasons.join("; ") || "—"} |`);
  lines.push("", "## Critical (hard-gate) failures", "");
  if (agg.criticalFailures.length === 0) lines.push("None observed in this run (see uncertainty bounds below; this is not proof of zero risk).");
  else {
    lines.push("| Scenario | Rep | Intent | Risk class | Failure code | Failed hard assertions |", "|---|---|---|---|---|---|");
    for (const c of agg.criticalFailures) lines.push(`| ${c.scenarioId} | ${c.repetition} | ${c.intent ?? "—"} | ${c.riskClass ?? "—"} | ${c.failureCode ?? "—"} | ${c.failedHardAssertions.join(", ")} |`);
  }
  lines.push("", "## Uncertainty (critical failures)", "", "| Basis | Failures | Opportunities | Clopper-Pearson 95% upper | Rule of three |", "|---|---|---|---|---|");
  for (const [label, b] of [["per run", t.criticalBoundPerRun], ["per distinct scenario", t.criticalBoundPerScenario]] as const) {
    lines.push(`| ${label} | ${b.failures} | ${b.opportunities} | ${pct(b.clopperPearsonUpper95)} | ${pct(b.ruleOfThreeUpper95)} |`);
  }
  const g = agg.routineQuality.goalCompletion;
  lines.push("", "## Routine quality and the PROPOSED goal-completion target", "");
  lines.push(`${g.statement}  `);
  lines.push(`Weighted task completion: ${pct(agg.routineQuality.weightedTaskCompletion)} — ${agg.routineQuality.reason}  `);
  lines.push(`Intents below the proposed target or with critical failures: ${agg.routineQuality.intentsBelowProposedTarget.length}`, "");
  lines.push("## Oversampled risk sets (unweighted)", "", "| Risk class | Required | Results | PASS | FAIL | INCONCLUSIVE | NOT_RUN | Critical |", "|---|---|---|---|---|---|---|---|");
  for (const [k, s] of Object.entries(agg.oversampledRisk.byRiskClass)) lines.push(`| ${k} | ${s.required} | ${s.runs} | ${s.pass} | ${s.fail} | ${s.inconclusive} | ${s.notRun} | ${s.criticalFailures} |`);
  const ch = agg.coverageHoles;
  lines.push("", "## Coverage holes and unsupported steps", "");
  lines.push(`- Required runs not run: ${ch.requiredNotRun.count}${ch.requiredNotRun.count > 0 ? ` (by intent: ${Object.entries(ch.requiredNotRun.byIntent).slice(0, 12).map(([k, v]) => `${k} ${v}`).join(", ")})` : ""}`);
  lines.push(`- Intents with no passing required run: ${ch.intentsWithoutPass.length > 0 ? ch.intentsWithoutPass.join(", ") : "none"}`);
  lines.push(`- Audiences with no passing run: ${ch.audiencesWithoutPass.join(", ") || "none"}; locales with no passing run: ${ch.localesWithoutPass.join(", ") || "none"}`);
  lines.push(`- Faults of the fixed registry without an independently reached, passing run (local or Layer-2): ${ch.faultsWithoutReachedRun.length} of ${ch.faults.length}${ch.faultsWithoutReachedRun.length > 0 ? ` (${ch.faultsWithoutReachedRun.join(", ")})` : ""}`);
  lines.push(`- Unsupported driver steps: ${Object.entries(ch.unsupportedDriverSteps).map(([k, v]) => `${k} (${v})`).join(", ") || "none"}`);
  lines.push(`- Most frequent INCONCLUSIVE reasons: ${Object.entries(ch.inconclusiveReasons).slice(0, 10).map(([k, v]) => `${k} (${v})`).join(", ") || "none"}`, "");
  if (ch.faults.length > 0) {
    lines.push("| Fault | Requested runs | Independently reached | Reached and PASS | Not reached (INCONCLUSIVE) | Layer-2 run |", "|---|---|---|---|---|---|");
    for (const f of ch.faults) lines.push(`| ${f.faultId} | ${f.requested} | ${f.reached} | ${f.reachedAndPassed} | ${f.notReached} | ${f.layer2} |`);
    lines.push("");
  }
  lines.push(...latencySectionOf(agg));
  const rs = agg.resolution.totals;
  lines.push("## Verified resolution and containment (reported separately)", "");
  lines.push(`Verified resolution: ${rs.verifiedResolutions}/${rs.runsWithOutcome} (${pct(rs.verifiedResolutionRate)}). Containment: ${rs.contained}/${rs.runsWithTransferEvidence} (${pct(rs.containmentRate)}), of which without verified resolution: ${rs.containedWithoutVerifiedResolution}. Missed required handoffs (hard-gate failures): ${rs.requiredHandoffMissed}.  `);
  lines.push("Containment is never a success measure and feeds no gate, completion rate or target.", "");
  lines.push("| Intent | Runs | Verified resolution | Contained | Contained without verified resolution | Missed required handoff |", "|---|---|---|---|---|---|");
  for (const [k, x] of Object.entries(agg.resolution.byIntent)) lines.push(`| ${k} | ${x.runs} | ${pct(x.verifiedResolutionRate)} | ${pct(x.containmentRate)} | ${x.containedWithoutVerifiedResolution} | ${x.requiredHandoffMissed} |`);
  lines.push("", "## By intent", "", "| Intent | Required | Results | PASS | FAIL | INCONCLUSIVE | NOT_RUN | Critical | Completion (fixed denominator) |", "|---|---|---|---|---|---|---|---|---|");
  for (const [k, s] of Object.entries(agg.slices.intent)) lines.push(`| ${k} | ${s.required} | ${s.runs} | ${s.pass} | ${s.fail} | ${s.inconclusive} | ${s.notRun} | ${s.criticalFailures} | ${pct(s.taskCompletionRate)} |`);
  if (agg.denominator.exclusions.length > 0) {
    lines.push("", "## Excluded results", "", ...agg.denominator.exclusions.slice(0, 50).map((x) => `- ${x.scenarioId} #${x.repetition}: ${x.reason}`));
  }
  if (agg.regression) {
    lines.push("", "## Regression", "", `Baseline: ${agg.regression.baselineRunIds.join(", ")}  `);
    lines.push(`New critical failures: ${agg.regression.newCriticalFailures.length}; slice regressions: ${agg.regression.sliceRegressions.length}`);
  }
  lines.push("", "## Caveats", "", ...agg.caveats.map((c) => `- ${c}`), "");
  return lines.join("\n");
}
