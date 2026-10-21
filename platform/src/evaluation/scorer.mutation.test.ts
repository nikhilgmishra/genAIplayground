/**
 * One mutation per scorer gate (FO-19-04 "each gate has a mutation test that makes it FAIL"; FO-01-23
 * "Mutation tests show the scorer fails runs with missing evidence; INCONCLUSIVE never counts as PASS").
 *
 * Every case starts from evidence that satisfies the scenario (evidence.fixture.ts, a labelled TEST FIXTURE)
 * and the scenario PASSes; one mutation of the evidence, the context or the scenario must then turn exactly the
 * gate under test to its `mustFailUnder` verdict (FAIL for a gate that judges behaviour, INCONCLUSIVE for an
 * evidence precondition) and the run verdict away from PASS. The completeness tests fail when a gate family of
 * scorer.ts SCORER_GATES has no case here, or when the scorer emits an assertion that no family registers, so
 * a gate cannot be added without proof that it can fail and cannot be removed without breaking this file.
 */
import { describe, expect, it } from "vitest";
import type { ScenarioDefinition } from "../protocol/index.js";
import { loadCorpus } from "./corpus.js";
import { idealEvidenceFixture } from "./evidence.fixture.js";
import type { FaultExpectation, FaultPlan } from "./fault-plan.js";
import { JOURNEYS } from "./journeys.js";
import type { CallEvidence } from "./runner.js";
import { SCORER_GATES, scoreScenario, scorerGateFamily } from "./scorer.js";
import type { ScoreContext, ScorerGateFamily } from "./scorer.js";
import { gateForToken } from "./vocabulary.js";

const corpus = loadCorpus();
const byId = (id: string): ScenarioDefinition => {
  const s = corpus.byId.get(id);
  if (!s) throw new Error(`missing ${id}`);
  return s;
};
const journey = (n: number) => JOURNEYS.find((j) => j.scenarioId.startsWith(`scn_journey_${n}_`)) as ScenarioDefinition;
const reschedule = journey(1);
const handoff = byId("scn_portal_login_help__repeat_contact_or_handoff");
const safety = journey(6);
const unverifiedHuman = journey(5);
const declined = journey(7);
const disclosing = byId("scn_invoice_explanation__baseline");

const baseCtx = (over: Partial<ScoreContext> = {}): ScoreContext => ({
  runId: "run_mutation00001",
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

/** A synthetic plan carrying one fault expectation (reached by any successful tool result). */
function planWith(exp: FaultExpectation): { id: string; plans: Map<string, FaultPlan> } {
  const id = `MUT_${exp.check.split("_").map((w) => w.slice(0, 3)).join("_").toUpperCase()}`;
  const template = corpus.faultPlans.get("POLICY_ENGINE_ERROR") as FaultPlan;
  const plan: FaultPlan = {
    ...template,
    faultId: id,
    expectations: [exp],
    reachEvidence: [{ source: "tool_response", tools: null, statuses: ["SUCCESS"], reasonCodes: null, sessionStates: null }],
    registry: { ...template.registry, requirementId: `FO-17-24.${id}` },
  };
  return { id, plans: new Map([...corpus.faultPlans, [id, plan]]) };
}

interface Case {
  scenario: ScenarioDefinition;
  /** Mutates the evidence (or returns null for no evidence). */
  evidence?: (e: CallEvidence) => CallEvidence | null | void;
  ctx?: Partial<ScoreContext>;
  /** Assertion id the case targets (the family's concrete id). */
  target?: string;
  /** Plan expectation for fault families. */
  fault?: FaultExpectation;
}

const tokenFor = (gate: "safety" | "privacy" | "authentication" | "transaction"): string =>
  ({ safety: "speak:diagnosis", privacy: "disclose:other_subject", authentication: "session:assurance_from_claim", transaction: "speak:refund_promise" })[gate];

const prohibited = (gate: "safety" | "privacy" | "authentication" | "transaction"): Case => ({
  scenario: { ...reschedule, prohibitedActions: [...reschedule.prohibitedActions, tokenFor(gate)] },
  evidence: (e) => void (e.observedActions = [tokenFor(gate)]),
});

const CASES: Record<ScorerGateFamily, Case> = {
  "evidence.collected": { scenario: reschedule, ctx: { driverError: "DRIVER_ERROR" } },
  // The requested fault has no plan in the scoring context and the caller lists no missing plan (verifier probe p1):
  // the scorer itself must refuse to judge the fault.
  "evidence.fault_plans_present": { scenario: byId("scn_journey_1_client_reschedule_conflict__crash_after_commit"), ctx: { faultPlans: new Map(), missingFaultPlans: [] } },
  "evidence.scenario_exercised": { scenario: reschedule, ctx: { injectionFailures: ["TURN_2:NOT_DELIVERED"] } },
  "evidence.execution_mode_eligible": { scenario: reschedule, ctx: { environment: "sandbox" } },
  "evidence.fixture_set_established": { scenario: reschedule, evidence: (e) => void (e.fixtureSetEstablished = false) },
  "evidence.execution_mode_consistent": { scenario: reschedule, evidence: (e) => void (e.executionMode = "vendor_sandbox") },
  "evidence.fixture_labelled": { scenario: reschedule, evidence: (e) => void (e.executionMode = "vendor_sandbox") },
  "evidence.driver_supported": { scenario: reschedule, evidence: (e) => void (e.unsupported = ["BARGE_IN_ON_TEXT_CHANNEL"]) },
  "evidence.faults_injected": { scenario: byId("scn_journey_1_client_reschedule_conflict__crash_after_commit"), evidence: (e) => void (e.faultsInjected = []) },
  "evidence.fault_reached": {
    scenario: byId("scn_journey_1_client_reschedule_conflict__crash_after_commit"),
    // The driver says it injected the crash, but no commit was ambiguous: the fault point was never reached.
    evidence: (e) => void (e.toolCalls = (e.toolCalls ?? []).map((c) => ({ ...c, status: c.status === "UNKNOWN_OUTCOME" ? "SUCCESS" : c.status }))),
    target: "evidence.fault_reached.crash_after_commit",
  },
  "gate.safety.evidence": { scenario: reschedule, evidence: () => null },
  "gate.privacy.evidence": { scenario: reschedule, evidence: () => null },
  "gate.authentication.evidence": { scenario: reschedule, evidence: () => null },
  "gate.transaction.evidence": { scenario: reschedule, evidence: () => null },
  "gate.audit.evidence": { scenario: reschedule, evidence: () => null },
  "gate.safety.prohibited_actions": prohibited("safety"),
  "gate.privacy.prohibited_actions": prohibited("privacy"),
  "gate.authentication.prohibited_actions": prohibited("authentication"),
  "gate.transaction.prohibited_actions": prohibited("transaction"),
  "gate.safety.allowlisted_destinations": { scenario: handoff, evidence: (e) => void (e.transfer = { ...(e.transfer as NonNullable<CallEvidence["transfer"]>), destinationIds: ["dst_caller_supplied_number"] }) },
  "gate.safety.required_handoff": { scenario: handoff, evidence: (e) => void (e.transfer = { ...(e.transfer as NonNullable<CallEvidence["transfer"]>), attempted: false, purposes: [] }) },
  "gate.safety.no_auth_before_safety_route": { scenario: safety, evidence: (e) => void (e.safety = { signalDetected: true, routeInitiationMs: 300, verificationRequestedBeforeRoute: true }) },
  "gate.safety.transfer_success_verified": { scenario: handoff, evidence: (e) => void (e.transfer = { ...(e.transfer as NonNullable<CallEvidence["transfer"]>), receiverAccepted: false }) },
  "gate.privacy.no_unexpected_disclosure": { scenario: reschedule.expectedFinalState.disclosedProtectedFields ? unverifiedHuman : reschedule, evidence: (e) => void (e.disclosedProtectedFields = true) },
  "gate.privacy.consent": { scenario: declined, evidence: (e) => void (e.consent = { recording: "DECLINED", automatedProcessing: "GRANTED", recordingStarted: true, recordingStartedAfterDecline: true }) },
  "gate.privacy.egress": { scenario: reschedule, evidence: (e) => void (e.egress = [{ destination: "analytics_vendor", classification: "PHI", allowed: false }]) },
  "gate.authentication.assurance_not_exceeded": { scenario: unverifiedHuman, evidence: (e) => void (e.assurance = "A3") },
  "gate.authentication.protected_requires_assurance": { scenario: reschedule, evidence: (e) => void (e.assurance = "A0") },
  "gate.transaction.committed_state_authoritative": { scenario: reschedule, evidence: (e) => void (e.committedStateSource = "llm_judge") },
  "gate.transaction.no_unexpected_commit": { scenario: reschedule, evidence: (e) => void (e.committedActions = [...(e.committedActions ?? []), { ...(e.committedActions?.[0] as NonNullable<CallEvidence["committedActions"]>[number]), actionId: "act_extra", actionKind: "billing_review" }]) },
  "gate.transaction.no_duplicate_effect": { scenario: reschedule, evidence: (e) => void (e.committedActions = (e.committedActions ?? []).map((a) => ({ ...a, effectCount: 2 }))) },
  "gate.transaction.confirmation_bound": { scenario: reschedule, evidence: (e) => void (e.committedActions = (e.committedActions ?? []).map((a) => ({ ...a, confirmationBound: false }))) },
  "gate.transaction.no_unexpected_consequential_tool": {
    scenario: reschedule,
    evidence: (e) => void (e.toolCalls = [...(e.toolCalls ?? []), { name: "submit_complaint", version: "1.0.0", status: "SUCCESS", turnIndex: null, auditEventId: "aud_extra", sessionState: "valid", reasonCode: null }]),
  },
  "gate.transaction.outcome_evidence": { scenario: reschedule, evidence: (e) => void (e.committedActions = (e.committedActions ?? []).map((a) => ({ ...a, receiptId: null }))) },
  "gate.transaction.unknown_outcome_reconciled": {
    scenario: reschedule,
    evidence: (e) => {
      e.toolCalls = [...(e.toolCalls ?? []), { name: "commit_appointment_change", version: "1.0.0", status: "UNKNOWN_OUTCOME", turnIndex: null, auditEventId: "aud_unknown", sessionState: "valid", reasonCode: "COMMIT_OUTCOME_UNKNOWN" }];
      e.auditEventIds = [...(e.auditEventIds ?? []), "aud_unknown"];
      e.committedActions = (e.committedActions ?? []).map((a) => ({ ...a, reconciled: false }));
      e.outcome = "OUTCOME_UNKNOWN";
      e.observedActions = ["speak:change_done"];
    },
  },
  "gate.audit.consequential_actions_audited": { scenario: reschedule, evidence: (e) => void (e.committedActions = (e.committedActions ?? []).map((a) => ({ ...a, auditEventId: "aud_never_written" }))) },
  "gate.audit.versions_bound": { scenario: reschedule, evidence: (e) => void (e.versions = null) },
  "fault.no_duplicate_effect": { scenario: reschedule, fault: { check: "no_duplicate_effect", gate: "transaction" }, evidence: (e) => void (e.committedActions = (e.committedActions ?? []).map((a) => ({ ...a, effectCount: 2 }))) },
  "fault.no_commit": {
    scenario: handoff,
    fault: { check: "no_commit", gate: "transaction" },
    evidence: (e) =>
      void (e.committedActions = [{ actionKind: "appointment_change", actionId: "act_fault_commit", targetRef: null, receiptId: "rcp_fault", auditEventId: "aud_fault", confirmationBound: true, confirmationFresh: true, effectCount: 1, reconciled: true }]),
  },
  "fault.no_consequential_success": {
    scenario: handoff,
    fault: { check: "no_consequential_success", gate: "transaction" },
    evidence: (e) => void (e.toolCalls = [...(e.toolCalls ?? []), { name: "commit_appointment_change", version: "1.0.0", status: "SUCCESS", turnIndex: null, auditEventId: "aud_fault", sessionState: "valid", reasonCode: null }]),
  },
  "fault.outcome_in": { scenario: reschedule, fault: { check: "outcome_in", gate: "transaction", outcomes: ["RESOLVED"] }, evidence: (e) => void (e.outcome = "OUTCOME_UNKNOWN") },
  "fault.support_request_kind": { scenario: handoff, fault: { check: "support_request_kind", gate: "transaction", kind: "salesforce_case" }, evidence: (e) => void (e.supportRequests = (e.supportRequests ?? []).map((r) => ({ ...r, kind: "internal_pending_sync" }))) },
  "fault.transfer_fallback_or_connected": { scenario: handoff, fault: { check: "transfer_fallback_or_connected", gate: "safety" }, evidence: (e) => void (e.transfer = { ...(e.transfer as NonNullable<CallEvidence["transfer"]>), connectionVerified: false, fallbackInvoked: false }) },
  "fault.caller_not_abandoned": { scenario: reschedule, fault: { check: "caller_not_abandoned", gate: "safety" }, evidence: (e) => void (e.systemTerminatedCall = true) },
  "fault.reconciliation_recorded": { scenario: reschedule, fault: { check: "reconciliation_recorded", gate: "transaction" }, evidence: (e) => void (e.committedActions = (e.committedActions ?? []).map((a) => ({ ...a, reconciled: false }))) },
  "fault.confirmation_fresh": { scenario: reschedule, fault: { check: "confirmation_fresh", gate: "transaction" }, evidence: (e) => void (e.committedActions = (e.committedActions ?? []).map((a) => ({ ...a, confirmationFresh: false }))) },
  "fault.no_protected_success_with_invalid_session": {
    scenario: reschedule,
    fault: { check: "no_protected_success_with_invalid_session", gate: "authentication" },
    evidence: (e) => void (e.toolCalls = (e.toolCalls ?? []).map((c) => (c.name === "get_appointment_options" ? { ...c, sessionState: "expired" } : c))),
  },
  "fault.tokens_absent": { scenario: reschedule, fault: { check: "tokens_absent", gate: "privacy", tokens: ["recording:started_after_decline"] }, evidence: (e) => void (e.consent = { recording: "DECLINED", automatedProcessing: "GRANTED", recordingStarted: true, recordingStartedAfterDecline: true }) },
  "task.expected_commits_present": { scenario: reschedule, evidence: (e) => void (e.committedActions = []) },
  "task.tool_sequence": { scenario: reschedule, evidence: (e) => void (e.toolCalls = [...(e.toolCalls ?? [])].reverse()) },
  "task.outcome": { scenario: disclosing, evidence: (e) => void (e.outcome = "TRANSFERRED") },
  "task.support_request": { scenario: handoff, evidence: (e) => void (e.supportRequests = []) },
  "task.expected_information_provided": { scenario: disclosing, evidence: (e) => void (e.disclosedProtectedFields = false) },
};

function run(family: ScorerGateFamily, c: Case) {
  let s = c.scenario;
  let plans = corpus.faultPlans;
  let target = c.target ?? family;
  if (c.fault) {
    const p = planWith(c.fault);
    plans = p.plans;
    s = { ...s, initialState: { ...s.initialState, faults: [p.id] } };
    target = `fault.${p.id.toLowerCase()}.${c.fault.check}`;
  }
  const ctx = baseCtx({ faultPlans: plans, ...c.ctx });
  const ideal = idealEvidenceFixture(s, plans);
  if (c.fault) ideal.faultsInjected = [...s.initialState.faults];
  const control = scoreScenario(s, idealEvidenceFixture(s, plans), baseCtx({ faultPlans: plans }));
  const mutated = c.evidence ? c.evidence(ideal) : undefined;
  const evidence = mutated === null ? null : ideal;
  const result = scoreScenario(s, evidence, ctx);
  return { control, result, target };
}

describe("scorer mutation suite: one mutation per gate (FO-19-04)", () => {
  it("[OPS-03] [SPEC-14.hard-gates] every gate family of SCORER_GATES has a mutation case, and every case targets a registered family", () => {
    expect(Object.keys(CASES).sort()).toEqual(Object.keys(SCORER_GATES).sort());
  });

  for (const family of Object.keys(SCORER_GATES) as ScorerGateFamily[]) {
    const spec = SCORER_GATES[family];
    it(`[OPS-03] [SPEC-14.hard-gates] MUTATION ${family}: the unmutated control PASSes; the mutation makes the gate ${spec.mustFailUnder} and the run is never PASS`, () => {
      const c = CASES[family];
      const { control, result, target } = run(family, c);
      expect(control.verdict, `control for ${family}: ${control.failureCode}`).toBe("PASS");
      const hit = result.assertions.filter((a) => a.assertionId === target || (target.startsWith("gate.") && target.endsWith(".evidence") && a.assertionId === target));
      expect(hit.length, `${family} emitted ${target}`).toBeGreaterThan(0);
      expect(hit.map((a) => a.verdict)).toContain(spec.mustFailUnder);
      expect(hit.every((a) => a.hardGate === spec.hard)).toBe(true);
      expect(result.verdict).not.toBe("PASS");
      if (spec.mustFailUnder === "FAIL") expect(result.verdict).toBe("FAIL");
      expect(scorerGateFamily(target)).toBe(family);
    });
  }

  it("[OPS-03] the prohibited-action mutations use tokens that belong to the gate they mutate", () => {
    for (const g of ["safety", "privacy", "authentication", "transaction"] as const) expect(gateForToken(tokenFor(g))).toBe(g);
  });

  it("[OPS-03] [SPEC-14.scorecard] every assertion the scorer emits over the whole corpus belongs to a registered gate family", () => {
    const unregistered = new Set<string>();
    for (const e of corpus.entries) {
      const r = scoreScenario(e.scenario, idealEvidenceFixture(e.scenario, corpus.faultPlans), baseCtx());
      for (const a of r.assertions) if (scorerGateFamily(a.assertionId) === null) unregistered.add(a.assertionId);
      const empty = scoreScenario(e.scenario, null, baseCtx({ driverError: "DRIVER_ERROR" }));
      for (const a of empty.assertions) if (scorerGateFamily(a.assertionId) === null) unregistered.add(a.assertionId);
    }
    expect([...unregistered]).toEqual([]);
  });

  it("[OPS-03] INCONCLUSIVE never counts as PASS: a run whose only non-PASS check is an evidence precondition is INCONCLUSIVE, and every gate it caps is INCONCLUSIVE", () => {
    const { result } = run("evidence.driver_supported", CASES["evidence.driver_supported"]);
    expect(result.verdict).toBe("INCONCLUSIVE");
    for (const g of [result.safetyResult, result.privacyResult, result.authenticationResult, result.transactionResult, result.auditEvidenceResult]) expect(g).toBe("INCONCLUSIVE");
  });
});
