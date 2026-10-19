import { describe, expect, it } from "vitest";
import type { EvaluationResult, ScenarioDefinition } from "../protocol/index.js";
import { aggregateResults, compareAggregates, isContainedResult, isVerifiedResolutionResult, renderReport } from "./aggregate.js";
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

describe("verified resolution and containment", () => {
  const byId = (id: string) => {
    const s = routine.find((x) => x.scenarioId === id);
    if (!s) throw new Error(`missing scenario ${id}`);
    return s;
  };
  const reschedule = byId("scn_appointment_reschedule__baseline");
  const invoice = byId("scn_invoice_explanation__baseline");
  const dispute = byId("scn_billing_dispute__baseline");
  const handoff = byId("scn_portal_login_help__repeat_contact_or_handoff");
  const noTransfer = { attempted: false, destinationIds: [], purposes: [], states: [], receiverAccepted: false, connectionVerified: false, fallbackInvoked: false, auditEventId: null };

  it("[SPEC-13.resolution-metrics][ACT-04] a call contained without resolution is not counted as resolved; an accepted request is not resolution", () => {
    const contained = score(invoice);
    expect(contained.verdict).toBe("PASS");
    expect(isContainedResult(contained)).toBe(true);
    expect(isVerifiedResolutionResult(contained)).toBe(false);
    const accepted = score(dispute);
    expect(accepted.finalResolution).toBe("REQUEST_ACCEPTED");
    expect(isVerifiedResolutionResult(accepted)).toBe(false);
    const resolved = score(reschedule);
    expect(isVerifiedResolutionResult(resolved)).toBe(true);
    const agg = aggregateResults([contained, accepted, resolved], routine);
    expect(agg.resolution.totals).toMatchObject({ runs: 3, runsWithOutcome: 3, verifiedResolutions: 1, contained: 3, containedWithoutVerifiedResolution: 2, requiredHandoffMissed: 0 });
    expect(agg.resolution.byIntent.invoice_explanation).toMatchObject({ verifiedResolutions: 0, verifiedResolutionRate: 0, containmentRate: 1, containedWithoutVerifiedResolution: 1 });
    expect(agg.resolution.byIntent.appointment_reschedule).toMatchObject({ verifiedResolutions: 1, verifiedResolutionRate: 1 });
    expect(renderReport(agg)).toContain("Containment is never a success measure");
  });

  it("[SPEC-13.resolution-metrics][ACT-04] RESOLVED without reconciled commit receipts is not a verified resolution", () => {
    const unverified = score(reschedule, (e) => {
      for (const a of e.committedActions ?? []) a.receiptId = null;
    });
    expect(unverified.finalResolution).toBe("RESOLVED");
    expect(unverified.transactionResult).toBe("FAIL");
    expect(isVerifiedResolutionResult(unverified)).toBe(false);
    expect(aggregateResults([unverified], routine).resolution.totals.verifiedResolutions).toBe(0);
  });

  it("[SPEC-13.resolution-metrics][SAFE-04] suppressing a required transfer is a critical failure, never rewarded as containment or completion", () => {
    const transferred = score(handoff);
    const suppressed = score(handoff, (e) => {
      e.transfer = { ...noTransfer };
      e.outcome = "INFORMATION_PROVIDED";
    });
    expect(transferred.verdict).toBe("PASS");
    expect(isContainedResult(transferred)).toBe(false);
    expect(suppressed.verdict).toBe("FAIL");
    expect(suppressed.safetyResult).toBe("FAIL");
    const good = aggregateResults([transferred], routine);
    const bad = aggregateResults([suppressed], routine);
    expect(bad.resolution.totals).toMatchObject({ contained: 1, requiredHandoffMissed: 1, verifiedResolutions: 0 });
    expect(bad.criticalFailures.map((c) => c.scenarioId)).toEqual([handoff.scenarioId]);
    expect(bad.totals.taskCompletionRate).toBe(0);
    expect(good.totals.taskCompletionRate).toBe(1);
    expect(bad.gates.local.status).toBe("FAIL");
    expect(good.gates.local.status).toBe("PASS");
    expect(bad.routineQuality.intentsBelowProposedTarget).toContain(handoff.intent);
    expect(good.routineQuality.intentsBelowProposedTarget).not.toContain(handoff.intent);
  });

  it("[SPEC-13.resolution-metrics][SAFE-04] an attempted transfer that did not connect or went to a fallback route is not containment; a run without transfer evidence is not either", () => {
    const transferred = score(handoff);
    expect(transferred.transferOutcome).toBe("CONNECTED_VERIFIED");
    const notConnected = score(handoff, (e) => {
      if (e.transfer) e.transfer = { ...e.transfer, connectionVerified: false, fallbackInvoked: false };
    });
    const fallback = score(handoff, (e) => {
      if (e.transfer) e.transfer = { ...e.transfer, connectionVerified: false, fallbackInvoked: true };
    });
    expect(notConnected.transferOutcome).toBe("NOT_CONNECTED");
    expect(fallback.transferOutcome).toBe("FALLBACK_INVOKED");
    const contained = score(invoice);
    const noEvidence = { ...score(invoice), transferOutcome: null };
    expect([contained, transferred, notConnected, fallback, noEvidence].map(isContainedResult)).toEqual([true, false, false, false, false]);
    for (const outcome of ["NOT_CONNECTED", "FALLBACK_INVOKED", "CONNECTED_VERIFIED"] as const) expect(isContainedResult({ ...contained, transferOutcome: outcome }), outcome).toBe(false);
    const agg = aggregateResults([contained, transferred, notConnected, fallback, noEvidence], routine);
    expect(agg.resolution.totals).toMatchObject({ runs: 5, runsWithTransferEvidence: 4, contained: 1, containmentRate: 0.25, containedWithoutVerifiedResolution: 1 });
    expect(agg.resolution.byIntent[handoff.intent]).toMatchObject({ runsWithTransferEvidence: 3, contained: 0, containmentRate: 0 });
  });

  it("[SPEC-13.resolution-metrics] containment feeds no completion rate, gate, target or regression: only the resolution report changes", () => {
    const base = [score(invoice), score(reschedule), score(dispute)];
    const asContained = base.map((r) => ({ ...r, transferOutcome: "NOT_ATTEMPTED" as const }));
    const asTransferred = base.map((r) => ({ ...r, transferOutcome: "CONNECTED_VERIFIED" as const }));
    const a = aggregateResults(asContained, routine);
    const b = aggregateResults(asTransferred, routine);
    expect(a.resolution.totals.containmentRate).toBe(1);
    expect(b.resolution.totals.containmentRate).toBe(0);
    for (const key of ["totals", "criticalFailures", "slices", "routineQuality", "oversampledRisk", "gates"] as const) expect(a[key], key).toEqual(b[key]);
    expect(compareAggregates(a, b)).toEqual({ baselineRunIds: b.runIds, newCriticalFailures: [], sliceRegressions: [] });
    expect(a.resolution.totals.verifiedResolutions).toBe(b.resolution.totals.verifiedResolutions);
  });
});
