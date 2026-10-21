/**
 * Invariant obligations of WP-01 at its own boundary, the evaluation gates (work-packages.yaml WP-01 invariant
 * obligations: AUTH-03, AUTH-05, DATA-01, DATA-04, ACT-04, SAFE-01, SAFE-05, OPS-03, OPS-04, OPS-06).
 *
 * For each invariant: a POSITIVE test (evidence that honours the invariant passes the gate that judges it), a
 * direct ADVERSARIAL test (evidence of exactly the violation makes that gate FAIL and the run not PASS) and a
 * FAILURE-injection test (the evidence the gate needs is not collected, or the evaluation itself fails: the
 * gate is INCONCLUSIVE and the run never PASS, OPS-03). The starting evidence is the scenario's ideal evidence
 * (evaluation/evidence.fixture.ts, a labelled TEST FIXTURE), so the only difference between the positive and the
 * negative case is the one injected change. The endpoint-level failure-injection tests of the same invariants
 * are in failure-injection.test.ts; this file proves the scorer cannot be fooled about them.
 */
import { describe, expect, it } from "vitest";
import { aggregateResults } from "../../src/evaluation/aggregate.js";
import { loadCorpus } from "../../src/evaluation/corpus.js";
import { buildRequiredManifests } from "../../src/evaluation/corpus-manifests.js";
import { idealEvidenceFixture } from "../../src/evaluation/evidence.fixture.js";
import { JOURNEYS } from "../../src/evaluation/journeys.js";
import type { CallEvidence } from "../../src/evaluation/runner.js";
import { scoreScenario } from "../../src/evaluation/scorer.js";
import type { ScoreContext } from "../../src/evaluation/scorer.js";
import { buildResultIndex, buildTraceability } from "../../src/evaluation/traceability.js";
import { loadCatalog } from "../../src/evaluation/catalog.js";
import { REPO_ROOT, repoPaths } from "../../src/evaluation/paths.js";
import type { EvaluationResult, ScenarioDefinition } from "../../src/protocol/index.js";

const corpus = loadCorpus();
const journey = (n: number) => JOURNEYS.find((j) => j.scenarioId.startsWith(`scn_journey_${n}_`)) as ScenarioDefinition;
const reschedule = journey(1);
const unverifiedHuman = journey(5);
const withProhibited = (token: string): ScenarioDefinition => {
  const s = corpus.entries.map((e) => e.scenario).find((x) => x.prohibitedActions.includes(token) && x.initialState.faults.length === 0);
  if (!s) throw new Error(`no scenario prohibits ${token}`);
  return s;
};
const handoff = corpus.byId.get("scn_portal_login_help__repeat_contact_or_handoff") as ScenarioDefinition;

const ctx = (over: Partial<ScoreContext> = {}): ScoreContext => ({
  runId: "run_invariantBoundary1",
  runAt: "2026-10-19T12:00:00.000Z",
  repetition: 1,
  environment: "local",
  executionMode: "local_fixture",
  missingFaultPlans: [],
  injectionFailures: [],
  driverError: null,
  faultPlans: corpus.faultPlans,
  ...over,
});

function judge(s: ScenarioDefinition, mutate: ((e: CallEvidence) => CallEvidence | null | void) | null, assertionId: string, over: Partial<ScoreContext> = {}) {
  let e: CallEvidence | null = idealEvidenceFixture(s);
  if (mutate) {
    const r = mutate(e);
    if (r !== undefined) e = r;
  }
  const result = scoreScenario(s, e, ctx(over));
  return { result, verdict: result.assertions.find((a) => a.assertionId === assertionId)?.verdict ?? "MISSING" };
}

/** Positive: the gate PASSes and so does the run. */
function positive(s: ScenarioDefinition, id: string): void {
  const { result, verdict } = judge(s, null, id);
  expect(verdict, id).toBe("PASS");
  expect(result.verdict).toBe("PASS");
}
/** Adversarial: exactly the violation makes the gate FAIL and the run FAIL. */
function adversarial(s: ScenarioDefinition, id: string, mutate: (e: CallEvidence) => void, over: Partial<ScoreContext> = {}): void {
  const { result, verdict } = judge(s, mutate, id, over);
  expect(verdict, id).toBe("FAIL");
  expect(result.verdict).toBe("FAIL");
}
/** Failure injection: the evidence is missing; the gate is INCONCLUSIVE and the run never PASS. */
function failure(s: ScenarioDefinition, id: string, mutate: ((e: CallEvidence) => CallEvidence | null | void) | null, over: Partial<ScoreContext> = {}): void {
  const { result, verdict } = judge(s, mutate, id, over);
  expect(verdict, id).toBe("INCONCLUSIVE");
  expect(result.verdict).not.toBe("PASS");
}

describe("[FO-19-05][FO-19-04] invariant obligations at the evaluation boundary (WP-01)", () => {
  it("[POSITIVE:AUTH-03][AUTH-03] server-established assurance within the scenario's tier passes the authentication gate", () => positive(unverifiedHuman, "gate.authentication.assurance_not_exceeded"));
  it("[ADVERSARIAL:AUTH-03][AUTH-03] assurance above the tier the server could establish (a claimed identity) fails the authentication gate", () =>
    adversarial(unverifiedHuman, "gate.authentication.assurance_not_exceeded", (e) => void (e.assurance = "A3")));
  it("[FAILURE:AUTH-03][AUTH-03] assurance not collected from the backend is INCONCLUSIVE, never PASS", () => failure(unverifiedHuman, "gate.authentication.assurance_not_exceeded", (e) => void (e.assurance = null)));

  it("[POSITIVE:AUTH-05][AUTH-05] a caller without a relationship to the record gets no protected disclosure and the privacy gate passes", () => positive(unverifiedHuman, "gate.privacy.no_unexpected_disclosure"));
  it("[ADVERSARIAL:AUTH-05][AUTH-05] a protected disclosure to a caller the scenario permits none fails the privacy gate", () =>
    adversarial(unverifiedHuman, "gate.privacy.no_unexpected_disclosure", (e) => void (e.disclosedProtectedFields = true)));
  it("[FAILURE:AUTH-05][AUTH-05] disclosure evidence not collected is INCONCLUSIVE, never PASS", () => failure(unverifiedHuman, "gate.privacy.no_unexpected_disclosure", (e) => void (e.disclosedProtectedFields = null)));

  it("[POSITIVE:DATA-01][DATA-01] only approved egress passes the privacy egress gate", () => positive(reschedule, "gate.privacy.egress"));
  it("[ADVERSARIAL:DATA-01][DATA-01] PHI sent to an unapproved destination fails the privacy egress gate", () =>
    adversarial(reschedule, "gate.privacy.egress", (e) => void (e.egress = [{ destination: "analytics_vendor", classification: "PHI", allowed: false }])));
  it("[FAILURE:DATA-01][DATA-01] egress observations not collected are INCONCLUSIVE, never PASS", () => failure(reschedule, "gate.privacy.egress", (e) => void (e.egress = null)));

  const recap = withProhibited("speak:recap_before_auth");
  it("[POSITIVE:DATA-04][DATA-04] no memory recap before authentication: the privacy prohibited-action gate passes", () => positive(recap, "gate.privacy.prohibited_actions"));
  it("[ADVERSARIAL:DATA-04][DATA-04] a recap from support memory before authentication fails the privacy gate", () =>
    adversarial(recap, "gate.privacy.prohibited_actions", (e) => void (e.observedActions = [...(e.observedActions ?? []), "speak:recap_before_auth"])));
  it("[FAILURE:DATA-04][DATA-04] spoken actions not observed are INCONCLUSIVE, never PASS", () => failure(recap, "gate.privacy.prohibited_actions", (e) => void (e.observedActions = null)));

  it("[POSITIVE:ACT-04][ACT-04] RESOLVED backed by the commit receipt passes the outcome-evidence gate", () => positive(reschedule, "gate.transaction.outcome_evidence"));
  it("[ADVERSARIAL:ACT-04][ACT-04] RESOLVED without a receipt (case created or workflow accepted only) fails the outcome-evidence gate", () =>
    adversarial(reschedule, "gate.transaction.outcome_evidence", (e) => void (e.committedActions = (e.committedActions ?? []).map((a) => ({ ...a, receiptId: null })))));
  it("[FAILURE:ACT-04][ACT-04] committed state not read from the authoritative backend is INCONCLUSIVE, never PASS", () =>
    failure(reschedule, "gate.transaction.committed_state_authoritative", (e) => void (e.committedStateSource = "llm_judge")));

  const clinical = withProhibited("speak:diagnosis");
  it("[POSITIVE:SAFE-01][SAFE-01] no diagnosis, therapy, screening or medication advice: the safety prohibited-action gate passes", () => positive(clinical, "gate.safety.prohibited_actions"));
  it("[ADVERSARIAL:SAFE-01][SAFE-01] a spoken diagnosis fails the safety gate", () => adversarial(clinical, "gate.safety.prohibited_actions", (e) => void (e.observedActions = [...(e.observedActions ?? []), "speak:diagnosis"])));
  it("[FAILURE:SAFE-01][SAFE-01] speech not observed is INCONCLUSIVE, never PASS", () => failure(clinical, "gate.safety.prohibited_actions", (e) => void (e.observedActions = null)));

  it("[POSITIVE:SAFE-05][SAFE-05] transfers only to allowlisted destination ids pass", () => positive(handoff, "gate.safety.allowlisted_destinations"));
  it("[ADVERSARIAL:SAFE-05][SAFE-05] a transfer to a caller-supplied target fails the safety gate", () =>
    adversarial(handoff, "gate.safety.allowlisted_destinations", (e) => void (e.transfer = { ...(e.transfer as NonNullable<CallEvidence["transfer"]>), destinationIds: ["dst_caller_supplied_number"] })));
  it("[FAILURE:SAFE-05][SAFE-05] transfer evidence not collected is INCONCLUSIVE, never PASS", () => failure(handoff, "gate.safety.allowlisted_destinations", (e) => void (e.transfer = null)));

  it("[POSITIVE:OPS-04][OPS-04] labelled local-fixture evidence is eligible for the local gate and raises no evidence finding", () => {
    const { result } = judge(reschedule, null, "evidence.fixture_labelled");
    expect(result.verdict).toBe("PASS");
    expect(result.executionMode).toBe("local_fixture");
    expect(result.assertions.filter((a) => a.assertionId.startsWith("evidence.") && a.verdict !== "PASS")).toEqual([]);
  });
  it("[ADVERSARIAL:OPS-04][OPS-04] fixture evidence relabelled as a vendor-sandbox run fails the labelling gate", () =>
    adversarial(reschedule, "evidence.fixture_labelled", (e) => void (e.executionMode = "vendor_sandbox")));
  it("[FAILURE:OPS-04][OPS-04] fixture evidence presented to the production gate is INCONCLUSIVE, never PASS", () => failure(reschedule, "evidence.execution_mode_eligible", null, { environment: "production" }));

  it("[POSITIVE:OPS-06][OPS-06] pinned versions bound to the result pass the audit gate", () => positive(reschedule, "gate.audit.versions_bound"));
  it("[ADVERSARIAL:OPS-06][OPS-06] an unpinned model or policy version never passes the audit gate", () => {
    const { result, verdict } = judge(reschedule, (e) => void (e.versions = { ...(e.versions as NonNullable<CallEvidence["versions"]>), model: "UNKNOWN", policyBundle: "UNPINNED" }), "gate.audit.versions_bound");
    expect(verdict).not.toBe("PASS");
    expect(result.verdict).not.toBe("PASS");
  });
  it("[FAILURE:OPS-06][OPS-06] versions not collected are INCONCLUSIVE, never PASS", () => failure(reschedule, "gate.audit.versions_bound", (e) => void (e.versions = null)));

  it("[POSITIVE:OPS-03][OPS-03] a recorded PASS of every required run passes the gate over the fixed denominator", () => {
    const results: EvaluationResult[] = [];
    for (let r = 1; r <= reschedule.repetitions; r++) results.push(scoreScenario(reschedule, idealEvidenceFixture(reschedule), ctx({ repetition: r })));
    const agg = aggregateResults(results, [reschedule], { required: buildRequiredManifests([reschedule]) });
    const local = agg.gates.local;
    expect(local.status).toBe("PASS");
    expect(local.requiredRuns).toBe(reschedule.repetitions);
  });
  it("[ADVERSARIAL:OPS-03][OPS-03] a required scenario that was never executed fails the gate (REQUIRED_NOT_RUN); skipping is not passing", () => {
    const results: EvaluationResult[] = [];
    for (let r = 1; r <= reschedule.repetitions; r++) results.push(scoreScenario(reschedule, idealEvidenceFixture(reschedule), ctx({ repetition: r })));
    // unverifiedHuman is required but has no result at all.
    const agg = aggregateResults(results, [reschedule, unverifiedHuman], { required: buildRequiredManifests([reschedule, unverifiedHuman]) });
    const local = agg.gates.local;
    expect(local.status).not.toBe("PASS");
    expect(local.requiredRuns).toBe(reschedule.repetitions + unverifiedHuman.repetitions);
    expect(local.reasons.some((r) => r.startsWith("REQUIRED_NOT_RUN"))).toBe(true);
  });
  it("[FAILURE:OPS-03][OPS-03] the driver crashed (no evidence) or no test report exists: INCONCLUSIVE / NOT_RUN, never PASS", () => {
    const crashed = scoreScenario(reschedule, null, ctx({ driverError: "DRIVER_CRASHED" }));
    expect(crashed.verdict).toBe("INCONCLUSIVE");
    const catalog = loadCatalog(repoPaths(REPO_ROOT).catalog);
    const rep = buildTraceability(catalog, [{ file: "platform/x.test.ts", line: 1, title: "[OPS-03] t", kind: "it", tags: ["OPS-03"] }], buildResultIndex(REPO_ROOT, []), "2026-10-19T12:00:00.000Z");
    expect(rep.rows.find((r) => r.id === "OPS-03")?.latestResult).toBe("NOT_RUN");
  });
});
