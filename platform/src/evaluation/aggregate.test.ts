import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { EvaluationResult, ScenarioDefinition } from "../protocol/index.js";
import { LATENCY_DIMENSIONS, PROPOSED_GOAL_COMPLETION, aggregateResults, compareAggregates, isContainedResult, isVerifiedResolutionResult, latencySectionOf, renderReport } from "./aggregate.js";
import type { EvaluationAggregate } from "./aggregate.js";
import { loadCorpus } from "./corpus.js";
import { idealEvidenceFixture } from "./evidence.fixture.js";
import type { CallEvidence } from "./runner.js";
import { REPO_ROOT } from "./paths.js";
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
    const agg = aggregateResults(results, sample);
    for (const dim of ["intent", "language", "audience", "variant", "riskClass", "severity", "version", "corpusSplit", "executionMode"] as const) {
      expect(Object.keys(agg.slices[dim]).length, dim).toBeGreaterThan(0);
    }
    expect(Object.keys(agg.slices.intent).sort()).toEqual(["appointment_reschedule", "faq_hours", "invoice_explanation"]);
    expect(Object.keys(agg.slices.variant)).toHaveLength(8);
    expect(agg.totals.runs).toBe(sample.length);
    expect(agg.unknownScenarioIds).toEqual([]);
  });

  it("[SPEC-14.aggregation][SPEC-14.hard-gates] a rare critical failure is listed explicitly and is never hidden by a high weighted average", () => {
    const victim = sample.find((s) => s.intent === "faq_hours" && s.variantFamily === "baseline") as ScenarioDefinition;
    // Every required repetition is run; one repetition of the victim discloses protected fields.
    const results = sample.flatMap((s) => Array.from({ length: s.repetitions }, (_, i) => (s === victim && i === 0 ? score(s, (e) => (e.disclosedProtectedFields = true), 1) : score(s, undefined, i + 1))));
    const agg = aggregateResults(results, sample, { productionWeights: { source: "SYNTHETIC test weights", weights: { faq_hours: 0.01, appointment_reschedule: 0.6, invoice_explanation: 0.39 } } });
    expect(agg.criticalFailures).toHaveLength(1);
    expect(agg.criticalFailures[0]).toMatchObject({ scenarioId: victim.scenarioId, repetition: 1, intent: "faq_hours" });
    expect(agg.criticalFailures[0]?.failedHardAssertions).toContain("gate.privacy.no_unexpected_disclosure");
    expect(agg.routineQuality.weightedTaskCompletion as number).toBeGreaterThan(0.99);
    expect(agg.routineQuality.intentsBelowProposedTarget).toContain("faq_hours");
    expect(agg.gates.local.status).toBe("FAIL");
    expect(renderReport(agg)).toContain(victim.scenarioId);
  });

  it("[SPEC-14.aggregation] production-frequency weighting is UNKNOWN without approved traffic data and never includes oversampled risk sets", () => {
    const riskSample = riskDrafts.slice(0, 40);
    const results = [...sample.map((s) => score(s)), ...riskSample.map((s) => score(s))];
    const agg = aggregateResults(results, [...sample, ...riskSample]);
    expect(agg.routineQuality.weightedTaskCompletion).toBeNull();
    expect(agg.routineQuality.reason).toContain("PRQ-046");
    const riskRuns = Object.values(agg.oversampledRisk.byRiskClass).reduce((n, s) => n + s.runs, 0);
    expect(riskRuns).toBe(riskSample.length);
    expect(agg.oversampledRisk.totals.runs).toBe(riskSample.length);
    expect(agg.totals.runs).toBe(sample.length + riskSample.length);
    expect(agg.oversampledRisk.note).toContain("never folded into production-weighted rates");
    const weighted = aggregateResults(results, [...sample, ...riskSample], { productionWeights: { source: "SYNTHETIC", weights: { cross_account_request: 1 } } });
    expect(weighted.routineQuality.weightedTaskCompletion).toBeNull();
  });

  it("[SPEC-14.uncertainty] slices report bounds per run and per distinct scenario, and the caveat is always present", () => {
    const s = sample[0] as ScenarioDefinition;
    const results = [1, 2, 3, 4, 5].map((rep) => score(s, undefined, rep));
    const agg = aggregateResults(results, [{ ...s, repetitions: 5 }]);
    expect(agg.totals.criticalBoundPerRun.opportunities).toBe(5);
    expect(agg.totals.criticalBoundPerScenario.opportunities).toBe(1);
    expect(agg.totals.criticalBoundPerScenario.clopperPearsonUpper95).toBeCloseTo(0.95, 6);
    expect(agg.caveats.join(" ")).toContain("does not establish zero risk");
    expect(renderReport(agg)).toContain("not proof of zero risk");
  });

  it("[SPEC-14.aggregation] regression comparison reports new critical failures and slice regressions", () => {
    const base = aggregateResults(sample.map((s) => score(s, undefined, 1, "run_baseline00001")), sample);
    const broken = sample.map((s) => (s.intent === "invoice_explanation" && s.variantFamily === "baseline" ? score(s, (e) => (e.observedActions = ["speak:refund_promise"])) : score(s)));
    const cur = aggregateResults(broken, sample, { baseline: base });
    expect(cur.regression?.baselineRunIds).toEqual(["run_baseline00001"]);
    expect(cur.regression?.newCriticalFailures.map((c) => c.scenarioId)).toEqual(["scn_invoice_explanation__baseline"]);
    expect(cur.regression?.sliceRegressions.some((r) => r.dimension === "intent" && r.key === "invoice_explanation")).toBe(true);
    expect(compareAggregates(base, base).newCriticalFailures).toEqual([]);
  });

  it("[OPS-03] sandbox and production gates are BLOCKED on local fixture evidence and on an unreviewed corpus", () => {
    const local = aggregateResults(sample.map((s) => score(s)), sample);
    expect(local.gates.sandbox.status).toBe("BLOCKED");
    expect(local.gates.production.status).toBe("BLOCKED");
    const sandboxLike = sample.map((s) => ({ ...score(s), environment: "sandbox" as const, executionMode: "vendor_sandbox" as const }));
    const agg = aggregateResults(sandboxLike, sample);
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
    const good = aggregateResults([transferred], [handoff]);
    const bad = aggregateResults([suppressed], [handoff]);
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

describe("[FO-17-14][FO-17-15][FO-17-41][FO-17-46] fixed denominators, coverage holes, latency intervals and the PROPOSED goal line", () => {
  const set = routine.slice(0, 6);
  const allRuns = (s: ScenarioDefinition) => Array.from({ length: s.repetitions }, (_, i) => score(s, undefined, i + 1));
  const requiredRuns = set.reduce((n, s) => n + s.repetitions, 0);

  it("[FO-17-14][OPS-03] every rate uses the fixed required denominator: an unrun or INCONCLUSIVE run lowers the rate and fails the gate", () => {
    const full = aggregateResults(set.flatMap(allRuns), set);
    expect(full.denominator).toMatchObject({ source: "scenario_set", requiredRuns, resultsInDenominator: requiredRuns });
    expect(full.totals.taskCompletionRate).toBe(1);
    expect(full.gates.local.status).toBe("PASS");
    // Drop one scenario's runs and make another INCONCLUSIVE (evidence not collected).
    const [dropped, inconclusive, ...rest] = set as [ScenarioDefinition, ScenarioDefinition, ...ScenarioDefinition[]];
    const partial = aggregateResults(
      [...rest.flatMap(allRuns), ...Array.from({ length: inconclusive.repetitions }, (_, i) => score(inconclusive, (e) => void (e.toolCalls = null), i + 1))],
      set,
    );
    expect(partial.denominator.requiredRuns).toBe(requiredRuns);
    expect(partial.totals.required).toBe(requiredRuns);
    expect(partial.totals.notRun).toBe(dropped.repetitions);
    expect(partial.totals.taskCompletionRate).toBeCloseTo((requiredRuns - dropped.repetitions - inconclusive.repetitions) / requiredRuns, 10);
    expect(partial.gates.local.status).not.toBe("PASS");
    expect(partial.gates.local.requiredNotRun).toBe(dropped.repetitions);
    expect(partial.gates.local.reasons.some((r) => r.startsWith("REQUIRED_NOT_RUN"))).toBe(true);
  });

  it("[FO-17-14][FO-17-12][OPS-03] a result never substitutes for a required run it is not: another scenario version, a later duplicate (e.g. a passing rerun), a repetition beyond the required count and an unknown scenario are excluded with a reason", () => {
    const [a, b, c, ...rest] = set as [ScenarioDefinition, ScenarioDefinition, ScenarioDefinition, ...ScenarioDefinition[]];
    const restRuns = rest.flatMap(allRuns);
    // a: every required repetition was run on an OLDER scenario version only (expectations have changed since).
    const older = Array.from({ length: a.repetitions }, (_, i) => ({ ...score(a, undefined, i + 1), scenarioVersion: a.version + 1 }));
    // b: the first result of repetition 1 FAILED; a later passing result of the same run is a duplicate, not a replacement.
    const bFail = score(b, (e) => void (e.outcome = "FAILED"), 1);
    expect(bFail.verdict).toBe("FAIL");
    const bRuns = [bFail, ...Array.from({ length: b.repetitions - 1 }, (_, i) => score(b, undefined, i + 2)), score(b, undefined, 1, "run_aggregateRerun1")];
    // c: every required repetition plus one beyond the required count.
    const cRuns = [...allRuns(c), score(c, undefined, c.repetitions + 1)];
    const unknown = { ...score(c), scenarioId: "scn_not_in_the_corpus" };
    const agg = aggregateResults([...older, ...bRuns, ...cRuns, ...restRuns, unknown], set);
    const reasons = agg.denominator.exclusions.map((x) => `${x.scenarioId}#${x.repetition}:${x.reason}`).sort();
    expect(reasons).toEqual(
      [
        ...older.map((r) => `${a.scenarioId}#${r.repetition}:VERSION_NOT_REQUIRED`),
        `${b.scenarioId}#1:DUPLICATE_RESULT`,
        `${c.scenarioId}#${c.repetitions + 1}:REPETITION_BEYOND_REQUIRED`,
        "scn_not_in_the_corpus#1:UNKNOWN_SCENARIO",
      ].sort(),
    );
    expect(agg.denominator.requiredRuns).toBe(requiredRuns);
    expect(agg.denominator.resultsInDenominator).toBe(requiredRuns - a.repetitions);
    // The older-version runs leave a's required runs NOT_RUN; b's first (failing) result is the one that counts.
    expect(agg.totals.notRun).toBe(a.repetitions);
    expect(agg.gates.local.requiredNotRun).toBe(a.repetitions);
    expect(agg.gates.local.requiredPass).toBe(requiredRuns - a.repetitions - 1);
    expect(agg.totals.taskCompletionRate).toBeCloseTo((requiredRuns - a.repetitions - 1) / requiredRuns, 10);
    expect(agg.gates.local.status).toBe("FAIL");
    expect(agg.coverageHoles.requiredNotRun.count).toBe(a.repetitions);
    // Without the stale and duplicate results the same set passes (the exclusions above are what kept it from PASS).
    const clean = aggregateResults([...allRuns(a), ...allRuns(b), ...allRuns(c), ...restRuns], set);
    expect(clean.denominator.exclusions).toEqual([]);
    expect(clean.gates.local.status).toBe("PASS");
    expect(renderReport(agg)).toContain(`- ${b.scenarioId} #1: DUPLICATE_RESULT`);
  });

  it("[FO-17-15] the coverage-hole section lists required runs not run, intents and faults without a PASS, and the faults never reached", () => {
    const [dropped, ...rest] = set as [ScenarioDefinition, ...ScenarioDefinition[]];
    const agg = aggregateResults(rest.flatMap(allRuns), set, { faultPlans: corpus.faultPlans, layer2Faults: { POLICY_ENGINE_ERROR: "PASS" } });
    expect(agg.coverageHoles.requiredNotRun.count).toBe(dropped.repetitions);
    expect(agg.coverageHoles.requiredNotRun.byIntent[dropped.intent]).toBe(dropped.repetitions);
    if (!rest.some((s) => s.intent === dropped.intent)) expect(agg.coverageHoles.intentsWithoutPass).toContain(dropped.intent);
    // Every registry fault appears; one with a passing Layer-2 run is not a hole, the others are.
    expect(agg.coverageHoles.faults).toHaveLength(corpus.faultPlans.size);
    expect(agg.coverageHoles.faults.find((f) => f.faultId === "POLICY_ENGINE_ERROR")?.layer2).toBe("PASS");
    expect(agg.coverageHoles.faultsWithoutReachedRun).not.toContain("POLICY_ENGINE_ERROR");
    expect(agg.coverageHoles.faultsWithoutReachedRun).toContain("CRASH_AFTER_COMMIT");
    expect(renderReport(agg)).toMatch(/Coverage holes/i);
  });

  it("[FO-17-41] latency p50/p95/p99 by intent, language, audience, assurance, model, voice, load and region with sample counts, missing observations and intervals", () => {
    const results = set.flatMap(allRuns);
    const byResult = new Map(results.map((r, i) => [`${r.scenarioId}#${r.repetition}`, Array.from({ length: 40 }, (_, k) => 200 + ((i * 37 + k * 11) % 300))] as const));
    const [first] = results as [EvaluationResult];
    byResult.delete(`${first.scenarioId}#${first.repetition}`);
    const agg = aggregateResults(results, set, { latencySamples: { clock: "simulated", byResult } });
    expect(Object.keys(agg.latency.dimensions).sort()).toEqual(["assurance", "audience", "intent", "language", "load", "model", "region", "voice"]);
    expect(agg.latency.clock).toBe("simulated");
    const all = Object.values(agg.latency.dimensions.intent);
    expect(all.reduce((n, s) => n + s.missingObservations, 0)).toBeGreaterThanOrEqual(1);
    const withSamples = all.find((s) => s.samples >= 40) as NonNullable<(typeof all)[number]>;
    expect(withSamples.p50.estimate).not.toBeNull();
    expect(withSamples.p95.lower95 === null || (withSamples.p95.lower95 <= (withSamples.p95.estimate as number) && (withSamples.p95.estimate as number) <= (withSamples.p95.upper95 as number))).toBe(true);
    const none = aggregateResults(results, set);
    expect(none.latency.clock).toBe("none");
    expect(Object.values(none.latency.dimensions.intent).every((s) => s.samples === 0 && s.p95.estimate === null)).toBe(true);
  });

  it("[FO-17-46][OPS-03] the goal-completion line names the target as PROPOSED, states execution mode and sample size, and local evidence is never a measurement", () => {
    const agg = aggregateResults(set.flatMap(allRuns), set);
    const g = agg.routineQuality.goalCompletion;
    expect(g.targetStatus).toBe("PROPOSED");
    expect(g.measured).toBe(false);
    expect(g.executionModes).toEqual(["local_fixture"]);
    expect(g.sampleSize).toBe(requiredRuns);
    expect(g.statement).toMatch(/PROPOSED/);
    expect(g.statement).toContain("local_fixture");
    expect(g.statement).toContain(`/${requiredRuns}`);
    expect(g.statement).toMatch(/no target is stated as met/);
    expect(renderReport(agg)).toContain(g.statement);
  });
});

describe("[FO-17-15][FO-17-41][FO-17-46] every coverage-hole field, every latency dimension of the report and both goal-line verdicts", () => {
  const byId = (id: string): ScenarioDefinition => {
    const x = corpus.byId.get(id);
    if (!x) throw new Error(`missing scenario ${id}`);
    return x;
  };
  const client = byId("scn_appointment_reschedule__baseline"); // client, en-US: PASS
  const partner = byId("scn_partner_intake__baseline"); // partner, en-US: every run FAILs
  const spanish = byId("scn_safety_disclosure_spanish__baseline"); // no audience, es-US: every run FAILs
  const unsupported = byId("scn_faq_hours__baseline"); // prospective_client: every run INCONCLUSIVE (driver step unsupported)
  const crash = byId("scn_journey_1_client_reschedule_conflict__crash_after_commit");
  const runsOf = (sc: ScenarioDefinition, patch?: (e: CallEvidence) => void) => Array.from({ length: sc.repetitions }, (_, i) => score(sc, patch, i + 1));
  const leak = (e: CallEvidence) => void (e.disclosedProtectedFields = true);
  const steps = (e: CallEvidence) => void (e.unsupported = ["BARGE_IN_ON_TEXT_CHANNEL", "DRIVER_STEP_FAILED:TURN_2:TIMEOUT"]);
  const unreached = (e: CallEvidence) => void (e.toolCalls = (e.toolCalls ?? []).map((c) => ({ ...c, status: c.status === "UNKNOWN_OUTCOME" ? ("SUCCESS" as const) : c.status })));
  const set = [client, partner, spanish, unsupported, crash];
  const results = () => [
    ...runsOf(client),
    ...runsOf(partner, (e) => {
      e.disclosedProtectedFields = !partner.expectedFinalState.disclosedProtectedFields;
      e.outcome = "FAILED";
    }),
    ...runsOf(spanish, leak),
    ...runsOf(unsupported, steps),
    score(crash, undefined, 1, "run_aggregate0002"),
  ];

  it("[FO-17-15][OPS-03] intents, audiences and locales without a passing required run, unsupported driver steps, INCONCLUSIVE reasons and per-fault reach counts are each listed (and rendered)", () => {
    const unreachedCrash = score(crash, unreached, 1, "run_aggregate0003");
    expect(unreachedCrash.assertions.find((a) => a.assertionId === "evidence.fault_reached.crash_after_commit")?.verdict).toBe("INCONCLUSIVE");
    const agg = aggregateResults([...results(), { ...unreachedCrash, repetition: 2 }], set.map((x) => (x === crash ? { ...crash, repetitions: 2 } : x)), { faultPlans: corpus.faultPlans });
    const ch = agg.coverageHoles;
    expect(ch.requiredNotRun.count).toBe(0);
    expect(ch.intentsWithoutPass).toEqual([partner.intent, spanish.intent, unsupported.intent].sort());
    expect(ch.intentsWithoutPass).not.toContain(client.intent);
    expect(ch.audiencesWithoutPass).toEqual(["partner", "prospective_client", "unidentified"]);
    expect(ch.localesWithoutPass).toEqual(["es-US"]);
    expect(ch.unsupportedDriverSteps).toEqual({ BARGE_IN_ON_TEXT_CHANNEL: unsupported.repetitions, "DRIVER_STEP_FAILED:TURN_2": unsupported.repetitions });
    expect(ch.inconclusiveReasons).toEqual({ "evidence.driver_supported": unsupported.repetitions, "evidence.fault_reached": 1 });
    const crashRow = ch.faults.find((f) => f.faultId === "CRASH_AFTER_COMMIT");
    expect(crashRow).toEqual({ faultId: "CRASH_AFTER_COMMIT", requested: 2, reached: 1, reachedAndPassed: 1, notReached: 1, layer2: "UNKNOWN" });
    expect(ch.faultsWithoutReachedRun).not.toContain("CRASH_AFTER_COMMIT");
    expect(ch.faultsWithoutReachedRun).toContain("POLICY_ENGINE_ERROR");
    expect(ch.faultsWithoutReachedRun).toHaveLength(corpus.faultPlans.size - 1);
    // A fault that was requested but never independently reached, or reached only by failing runs, is still a hole.
    const crash2 = [{ ...crash, repetitions: 2 }];
    const onlyUnreached = aggregateResults([unreachedCrash], crash2, { faultPlans: corpus.faultPlans }).coverageHoles;
    expect(onlyUnreached.faults.find((f) => f.faultId === "CRASH_AFTER_COMMIT")).toMatchObject({ requested: 1, reached: 0, reachedAndPassed: 0, notReached: 1 });
    expect(onlyUnreached.faultsWithoutReachedRun).toContain("CRASH_AFTER_COMMIT");
    const reachedButFailed = score(crash, (e) => void (e.outcome = "FAILED"), 1, "run_aggregate0004");
    expect(reachedButFailed.reachedFault?.faultId).toBe("CRASH_AFTER_COMMIT");
    expect(reachedButFailed.verdict).toBe("FAIL");
    const failedOnly = aggregateResults([reachedButFailed], crash2, { faultPlans: corpus.faultPlans }).coverageHoles;
    expect(failedOnly.faults.find((f) => f.faultId === "CRASH_AFTER_COMMIT")).toMatchObject({ requested: 1, reached: 1, reachedAndPassed: 0, notReached: 0 });
    expect(failedOnly.faultsWithoutReachedRun).toContain("CRASH_AFTER_COMMIT");
    // A passing Layer-2 [FAULT:] run closes the hole even without a reached local run.
    expect(aggregateResults([unreachedCrash], crash2, { faultPlans: corpus.faultPlans, layer2Faults: { CRASH_AFTER_COMMIT: "PASS" } }).coverageHoles.faultsWithoutReachedRun).not.toContain("CRASH_AFTER_COMMIT");
    const report = renderReport(agg);
    expect(report).toContain(`- Intents with no passing required run: ${ch.intentsWithoutPass.join(", ")}`);
    expect(report).toContain("- Audiences with no passing run: partner, prospective_client, unidentified; locales with no passing run: es-US");
    expect(report).toContain(`- Unsupported driver steps: BARGE_IN_ON_TEXT_CHANNEL (${unsupported.repetitions}), DRIVER_STEP_FAILED:TURN_2 (${unsupported.repetitions})`);
    expect(report).toContain(`- Faults of the fixed registry without an independently reached, passing run (local or Layer-2): ${corpus.faultPlans.size - 1} of ${corpus.faultPlans.size}`);
    expect(report).toContain("| CRASH_AFTER_COMMIT | 2 | 1 | 1 | 1 | UNKNOWN |");
    // With every run passing, no population is a hole.
    const clean = aggregateResults(runsOf(client), [client]);
    expect([clean.coverageHoles.intentsWithoutPass, clean.coverageHoles.audiencesWithoutPass, clean.coverageHoles.localesWithoutPass]).toEqual([[], [], []]);
    expect(clean.coverageHoles.unsupportedDriverSteps).toEqual({});
  });

  it("[FO-17-41] the report renders one latency table per dimension (all eight), each with sample counts, missing observations and 95% intervals", () => {
    const rs = results();
    const byResult = new Map(rs.map((r, i) => [`${r.scenarioId}#${r.repetition}`, Array.from({ length: 30 }, (_, k) => 150 + ((i * 13 + k * 7) % 400))] as const));
    const agg = aggregateResults(rs, set, { latencySamples: { clock: "simulated", byResult } });
    const report = renderReport(agg);
    for (const d of LATENCY_DIMENSIONS) {
      expect(Object.keys(agg.latency.dimensions[d]).length, d).toBeGreaterThan(0);
      expect(report, d).toContain(`### ${d}\n\n| Key | Calls | Samples | Missing observations | p50 ms [95% CI] | p95 ms [95% CI] | p99 ms [95% CI] |`);
    }
    expect(LATENCY_DIMENSIONS).toEqual(["intent", "language", "audience", "assurance", "model", "voice", "load", "region"]);
    expect(report).toContain("| es-US |");
    expect(report).toContain("| unidentified |");
  });

  it("[FO-17-46][OPS-03] the goal line says MISSES below the PROPOSED target and MEETS at or above it, and local evidence is never stated as met", () => {
    const pass = routine.filter((x) => x.repetitions === 1).slice(0, 20);
    expect(pass).toHaveLength(20);
    const meets = aggregateResults(pass.map((x) => score(x)), pass).routineQuality.goalCompletion;
    expect(meets).toMatchObject({ status: "MEETS_PROPOSED_TARGET", rate: 1, measured: false, targetStatus: "PROPOSED", sampleSize: 20, passes: 20 });
    expect(meets.statement).toContain("MEETS_PROPOSED_TARGET on non-measured evidence: no target is stated as met");
    // 18 of 20 = 90% < 95%: one FAIL and one INCONCLUSIVE (both not-PASS over the fixed denominator).
    const [a, b, ...rest] = pass as [ScenarioDefinition, ScenarioDefinition, ...ScenarioDefinition[]];
    const misses = aggregateResults([score(a, (e) => void (e.outcome = "FAILED")), score(b, (e) => void (e.toolCalls = null)), ...rest.map((x) => score(x))], pass).routineQuality.goalCompletion;
    expect(PROPOSED_GOAL_COMPLETION).toBe(0.95);
    expect(misses).toMatchObject({ status: "MISSES_PROPOSED_TARGET", rate: 0.9, passes: 18, sampleSize: 20 });
    expect(misses.statement).toContain("18/20 = 90");
    expect(misses.statement).toContain("MISSES_PROPOSED_TARGET");
    // 19 of 20 = 95%: at the target, still PROPOSED and not measured.
    const atTarget = aggregateResults([score(a, (e) => void (e.outcome = "FAILED")), score(b), ...rest.map((x) => score(x))], pass).routineQuality.goalCompletion;
    expect(atTarget).toMatchObject({ status: "MEETS_PROPOSED_TARGET", rate: 0.95, measured: false });
    // No routine required run at all: INCONCLUSIVE, never MEETS.
    const none = aggregateResults([], riskDrafts.slice(0, 2)).routineQuality.goalCompletion;
    expect(none).toMatchObject({ status: "INCONCLUSIVE", rate: null, sampleSize: 0 });
  });
});

describe("[FO-17-41][FO-17-12] the committed w5 latency addendum (the w5 report lacks two of the eight tables)", () => {
  const ev = (f: string) => readFileSync(join(REPO_ROOT, "evidence", "evaluation", f), "utf8");
  const summary = JSON.parse(ev("corpus-local-20261019w5.summary.json")) as EvaluationAggregate;
  const addendum = ev("corpus-local-20261019w5.latency-addendum.md");
  const report = ev("corpus-local-20261019w5.report.md");
  /** The `### <d>` heading and the table rows under it (null when the report has no such table). */
  const table = (md: string, d: string) => {
    const lines = md.split("\n");
    const i = lines.indexOf(`### ${d}`);
    if (i < 0) return null;
    const rows: string[] = [];
    for (const l of lines.slice(i + 2)) {
      if (!l.startsWith("|")) break;
      rows.push(l);
    }
    return [lines[i], ...rows].join("\n");
  };

  it("[FO-17-41] the addendum is the current renderer's latency section of the unchanged w5 summary, with all eight tables, sample counts, missing observations and 95% intervals", () => {
    expect(addendum).toMatch(/^# corpus-local-20261019w5: latency addendum\n\n> \*\*LOCAL FIXTURE — SYNTHETIC DATA — NOT PRODUCTION/);
    const section = latencySectionOf(summary).join("\n");
    expect(addendum).toContain(section);
    expect([...addendum.matchAll(/^### ([a-z]+)$/gm)].map((m) => m[1])).toEqual([...LATENCY_DIMENSIONS]);
    for (const d of LATENCY_DIMENSIONS) {
      expect(table(addendum, d), d).toContain("| Key | Calls | Samples | Missing observations | p50 ms [95% CI] | p95 ms [95% CI] | p99 ms [95% CI] |");
      expect(Object.keys(summary.latency.dimensions[d]).length, d).toBeGreaterThan(0);
    }
  });

  it("[FO-17-12] the w5 report stays as written: its six tables equal the addendum's, and it lacks exactly the language and audience tables", () => {
    for (const d of LATENCY_DIMENSIONS) {
      const inReport = table(report, d);
      if (d === "language" || d === "audience") expect(inReport, d).toBeNull();
      else expect(inReport, d).toBe(table(addendum, d));
    }
  });
});
