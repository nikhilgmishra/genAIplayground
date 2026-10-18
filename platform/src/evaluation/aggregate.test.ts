import { describe, expect, it } from "vitest";
import type { EvaluationResult, ScenarioDefinition } from "../protocol/index.js";
import { aggregateResults, compareAggregates, renderReport } from "./aggregate.js";
import { loadCorpus } from "./corpus.js";
import { idealEvidenceFixture } from "./evidence.fixture.js";
import type { CallEvidence } from "./runner.js";
import { scoreScenario } from "./scorer.js";
import { binomialCdf, clopperPearsonUpper, failureRateBound, ruleOfThreeUpper, UNCERTAINTY_CAVEAT } from "./stats.js";

const corpus = loadCorpus();
const routine = corpus.entries.filter((e) => e.kind === "routine").map((e) => e.scenario);
const riskDrafts = corpus.entries.filter((e) => e.kind === "risk_draft").map((e) => e.scenario);

const score = (s: ScenarioDefinition, patch?: (e: CallEvidence) => void, repetition = 1, runId = "run_aggregate0001"): EvaluationResult => {
  const e = idealEvidenceFixture(s);
  patch?.(e);
  return scoreScenario(s, e, {
    runId,
    runAt: "2026-10-17T15:00:00.000Z",
    repetition,
    environment: "local",
    executionMode: "local_fixture",
    missingFaultPlans: [],
    injectionFailures: [],
    driverError: null,
    faultPlans: corpus.faultPlans,
  });
};

describe("uncertainty bounds", () => {
  it("[SPEC-14.uncertainty] zero failures in 3,000 independent opportunities gives a one-sided 95% upper bound near 0.1%", () => {
    const cp = clopperPearsonUpper(0, 3000);
    expect(cp).toBeCloseTo(0.000998, 5);
    expect(ruleOfThreeUpper(0, 3000)).toBeCloseTo(0.001, 6);
    expect(ruleOfThreeUpper(1, 3000)).toBeNull();
    expect(UNCERTAINTY_CAVEAT).toContain("does not establish zero risk");
  });

  it("[SPEC-14.uncertainty] Clopper-Pearson upper bounds for observed failures are exact and monotone", () => {
    const one = clopperPearsonUpper(1, 100) as number;
    expect(one).toBeCloseTo(0.0466, 3);
    expect(binomialCdf(1, 100, one)).toBeCloseTo(0.05, 6);
    expect(clopperPearsonUpper(5, 100) as number).toBeGreaterThan(one);
    expect(clopperPearsonUpper(10, 10)).toBe(1);
    expect(clopperPearsonUpper(0, 0)).toBeNull();
    expect(failureRateBound(0, 20)).toMatchObject({ failures: 0, opportunities: 20, observedRate: 0 });
  });
});

describe("aggregation", () => {
  const sample = routine.filter((s) => s.intent === "appointment_reschedule" || s.intent === "faq_hours" || s.intent === "invoice_explanation");

  it("[SPEC-14.aggregation] slices by intent, language, audience, variant, risk class, severity, version and split", () => {
    const results = sample.map((s) => score(s));
    const agg = aggregateResults(results, routine);
    for (const dim of ["intent", "language", "audience", "variant", "riskClass", "severity", "version", "corpusSplit", "executionMode"] as const) {
      expect(Object.keys(agg.slices[dim]).length, dim).toBeGreaterThan(0);
    }
    expect(Object.keys(agg.slices.intent).sort()).toEqual(["appointment_reschedule", "faq_hours", "invoice_explanation"]);
    expect(Object.keys(agg.slices.variant)).toHaveLength(8);
    expect(agg.totals.runs).toBe(sample.length);
    expect(agg.unknownScenarioIds).toEqual([]);
  });

  it("[SPEC-14.aggregation][SPEC-14.hard-gates] a rare critical failure is listed explicitly and is never hidden by a high weighted average", () => {
    const results = sample.map((s) => score(s));
    const victim = sample.find((s) => s.intent === "faq_hours" && s.variantFamily === "baseline") as ScenarioDefinition;
    results.push(score(victim, (e) => (e.disclosedProtectedFields = true), 2));
    const agg = aggregateResults(results, routine, { productionWeights: { source: "SYNTHETIC test weights", weights: { faq_hours: 0.01, appointment_reschedule: 0.6, invoice_explanation: 0.39 } } });
    expect(agg.criticalFailures).toHaveLength(1);
    expect(agg.criticalFailures[0]).toMatchObject({ scenarioId: victim.scenarioId, repetition: 2, intent: "faq_hours" });
    expect(agg.criticalFailures[0]?.failedHardAssertions).toContain("gate.privacy.no_unexpected_disclosure");
    expect(agg.routineQuality.weightedTaskCompletion as number).toBeGreaterThan(0.99);
    expect(agg.routineQuality.intentsBelowProposedTarget).toContain("faq_hours");
    expect(agg.gates.local.status).toBe("FAIL");
    expect(renderReport(agg)).toContain(victim.scenarioId);
  });

  it("[SPEC-14.aggregation] production-frequency weighting is UNKNOWN without approved traffic data and never includes oversampled risk sets", () => {
    const riskSample = riskDrafts.slice(0, 40);
    const results = [...sample.map((s) => score(s)), ...riskSample.map((s) => score(s))];
    const agg = aggregateResults(results, [...routine, ...riskDrafts]);
    expect(agg.routineQuality.weightedTaskCompletion).toBeNull();
    expect(agg.routineQuality.reason).toContain("PRQ-046");
    const riskRuns = Object.values(agg.oversampledRisk.byRiskClass).reduce((n, s) => n + s.runs, 0);
    expect(riskRuns).toBe(riskSample.length);
    expect(agg.oversampledRisk.totals.runs).toBe(riskSample.length);
    expect(agg.totals.runs).toBe(sample.length + riskSample.length);
    expect(agg.oversampledRisk.note).toContain("never folded into production-weighted rates");
    const weighted = aggregateResults(results, [...routine, ...riskDrafts], { productionWeights: { source: "SYNTHETIC", weights: { cross_account_request: 1 } } });
    expect(weighted.routineQuality.weightedTaskCompletion).toBeNull();
  });

  it("[SPEC-14.uncertainty] slices report bounds per run and per distinct scenario, and the caveat is always present", () => {
    const s = sample[0] as ScenarioDefinition;
    const results = [1, 2, 3, 4, 5].map((rep) => score(s, undefined, rep));
    const agg = aggregateResults(results, routine);
    expect(agg.totals.criticalBoundPerRun.opportunities).toBe(5);
    expect(agg.totals.criticalBoundPerScenario.opportunities).toBe(1);
    expect(agg.totals.criticalBoundPerScenario.clopperPearsonUpper95).toBeCloseTo(0.95, 6);
    expect(agg.caveats.join(" ")).toContain("does not establish zero risk");
    expect(renderReport(agg)).toContain("not proof of zero risk");
  });

  it("[SPEC-14.aggregation] regression comparison reports new critical failures and slice regressions", () => {
    const base = aggregateResults(sample.map((s) => score(s, undefined, 1, "run_baseline00001")), routine);
    const broken = sample.map((s) => (s.intent === "invoice_explanation" && s.variantFamily === "baseline" ? score(s, (e) => (e.observedActions = ["speak:refund_promise"])) : score(s)));
    const cur = aggregateResults(broken, routine, { baseline: base });
    expect(cur.regression?.baselineRunIds).toEqual(["run_baseline00001"]);
    expect(cur.regression?.newCriticalFailures.map((c) => c.scenarioId)).toEqual(["scn_invoice_explanation__baseline"]);
    expect(cur.regression?.sliceRegressions.some((r) => r.dimension === "intent" && r.key === "invoice_explanation")).toBe(true);
    expect(compareAggregates(base, base).newCriticalFailures).toEqual([]);
  });

  it("[OPS-03] sandbox and production gates are BLOCKED on local fixture evidence and on an unreviewed corpus", () => {
    const local = aggregateResults(sample.map((s) => score(s)), routine);
    expect(local.gates.sandbox.status).toBe("BLOCKED");
    expect(local.gates.production.status).toBe("BLOCKED");
    const sandboxLike = sample.map((s) => ({ ...score(s), environment: "sandbox" as const, executionMode: "vendor_sandbox" as const }));
    const agg = aggregateResults(sandboxLike, routine);
    expect(agg.gates.sandbox.status).toBe("BLOCKED");
    expect(agg.gates.sandbox.reasons.join(" ")).toContain("CORPUS_NOT_HUMAN_REVIEWED");
    expect(agg.localFixtureOnly).toBe(false);
  });
});
