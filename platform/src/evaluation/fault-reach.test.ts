/**
 * Independent fault-reach rules (fault-reach.ts; FO-17-11 "Scorer requires independent proof the fault point
 * was reached; unreached fault is INCONCLUSIVE or FAIL, never PASS"; OPS-03).
 *
 * Every rule source is exercised on all three branches: MATCH (with the exact pointer into the evidence),
 * NO_MATCH (the near misses a sloppy rule would accept: the wrong tool, status, reason code or session state,
 * non-adjacent or reversed transfer states, an ambiguous commit without an external effect, verification that
 * did raise assurance, a zero emulator count, a template that was not rendered) and NOT_COLLECTED (the
 * evidence the rule needs is null or absent). Then the scorer's use of the observation: only `reached === true`
 * is PASS; a fault with no rule, with uncollected evidence or with no matching record is INCONCLUSIVE and
 * records no reachedFault, even though the driver reports it injected. A `driver_self_report` rule (the
 * driver's own count of what it injected) never reaches: it only labels the observation as a self-report.
 *
 * The evidence objects are a labelled TEST FIXTURE (evidence.fixture.ts) mutated field by field; the plans are
 * synthetic copies of a committed plan with only `reachEvidence` replaced.
 */
import { describe, expect, it } from "vitest";
import type { ScenarioDefinition } from "../protocol/index.js";
import { loadCorpus } from "./corpus.js";
import { idealEvidenceFixture } from "./evidence.fixture.js";
import { ReachEvidence, isIndependentReachRule } from "./fault-plan.js";
import type { FaultPlan } from "./fault-plan.js";
import { evaluateFaultReach, selfReportLabel } from "./fault-reach.js";
import { JOURNEYS } from "./journeys.js";
import type { CallEvidence, CommittedActionObservation, ToolCallObservation } from "./runner.js";
import { scoreScenarioDetailed } from "./scorer.js";
import type { ScoreContext } from "./scorer.js";

const corpus = loadCorpus();
const template = corpus.faultPlans.get("POLICY_ENGINE_ERROR") as FaultPlan;
const reschedule = JOURNEYS.find((j) => j.scenarioId.startsWith("scn_journey_1_")) as ScenarioDefinition;

/** A synthetic plan: the committed POLICY_ENGINE_ERROR plan with its reach rules replaced and one expectation the reschedule journey meets. */
const planOf = (rules: ReachEvidence[], faultId = "SYNTH_REACH_FAULT"): FaultPlan => ({
  ...template,
  faultId,
  expectations: [{ check: "no_duplicate_effect", gate: "transaction" }],
  reachEvidence: rules,
  registry: { ...template.registry, requirementId: `FO-17-24.${faultId}` },
});

/** A collected, fault-free evidence object (TEST FIXTURE) with every reach-relevant field set explicitly. */
function base(): CallEvidence {
  const e = idealEvidenceFixture(reschedule, new Map());
  e.toolCalls = [];
  e.committedActions = [];
  e.supportRequests = [];
  e.transfer = { attempted: false, destinationIds: [], purposes: [], states: [], receiverAccepted: false, connectionVerified: false, fallbackInvoked: false, auditEventId: null };
  e.committedState = { driverNotes: [], spokenTemplates: [], ledger: [] };
  e.assurance = "A0";
  return e;
}

const tool = (over: Partial<ToolCallObservation> = {}): ToolCallObservation => ({
  name: "get_appointment_options",
  version: "1.0.0",
  status: "POLICY_DENIED",
  turnIndex: 1,
  auditEventId: null,
  sessionState: "valid",
  reasonCode: "POLICY_ENGINE_ERROR",
  ...over,
});

const action = (over: Partial<CommittedActionObservation> = {}): CommittedActionObservation => ({
  actionKind: "appointment_reschedule",
  actionId: "act_synthReach0001",
  targetRef: null,
  receiptId: "rcp_synthReach0001",
  auditEventId: "aud_synthReach0001",
  confirmationBound: true,
  confirmationFresh: true,
  effectCount: 1,
  reconciled: false,
  ...over,
});

const reachOf = (rule: ReachEvidence, mutate: (e: CallEvidence) => void) => {
  const e = base();
  mutate(e);
  return evaluateFaultReach(planOf([rule]), e);
};

const TOOL_RULE: ReachEvidence = { source: "tool_response", tools: ["get_appointment_options"], statuses: ["POLICY_DENIED"], reasonCodes: ["POLICY_ENGINE_ERROR"], sessionStates: ["valid"] };

describe("[FO-17-11][OPS-03] fault reach: each rule source on its MATCH, NO_MATCH and NOT_COLLECTED branches", () => {
  it("[FO-17-11] tool_response: every named filter must match one gateway result; null filters match anything", () => {
    const hit = reachOf(TOOL_RULE, (e) => void (e.toolCalls = [tool({ name: "begin_verification", status: "SUCCESS", reasonCode: null }), tool({ auditEventId: "aud_reachTool0001" })]));
    expect(hit).toMatchObject({ reached: true, observedBy: "gateway.tool_response", evidenceRef: "audit_event#aud_reachTool0001" });
    // Without an audit id the pointer is the tool call's index in the evidence.
    expect(reachOf(TOOL_RULE, (e) => void (e.toolCalls = [tool({ status: "SUCCESS", reasonCode: null }), tool()])).evidenceRef).toBe("call-evidence#toolCalls/1");
    const misses: Record<string, Partial<ToolCallObservation>> = {
      "another tool": { name: "get_invoice_status" },
      "another status": { status: "RETRYABLE_FAILURE" },
      "no reason code": { reasonCode: null },
      "another reason code": { reasonCode: "POLICY_DENIED_ASSURANCE" },
      "no session state": { sessionState: null },
      "another session state": { sessionState: "expired" },
    };
    for (const [why, over] of Object.entries(misses)) {
      const r = reachOf(TOOL_RULE, (e) => void (e.toolCalls = [tool(over)]));
      expect(r.reached, why).toBe(false);
      expect(r.evidenceRef, why).toBeNull();
    }
    const open: ReachEvidence = { source: "tool_response", tools: null, statuses: ["POLICY_DENIED"], reasonCodes: null, sessionStates: null };
    expect(reachOf(open, (e) => void (e.toolCalls = [tool({ name: "get_invoice_status", reasonCode: null, sessionState: null })])).reached).toBe(true);
    expect(reachOf(open, (e) => void (e.toolCalls = [tool({ status: "SUCCESS" })])).reached).toBe(false);
    expect(reachOf(TOOL_RULE, (e) => void (e.toolCalls = [])).reached).toBe(false);
    expect(reachOf(TOOL_RULE, (e) => void (e.toolCalls = null))).toMatchObject({ reached: null, observedBy: null, evidenceRef: null });
  });

  it("[FO-17-11][ACT-02][SPEC-16.fault-crash-after-commit] ambiguous_commit_with_effect: an UNKNOWN_OUTCOME of a listed tool AND an effect in the authoritative system of record", () => {
    const rule: ReachEvidence = { source: "ambiguous_commit_with_effect", tools: ["commit_appointment_change"] };
    const unknown = tool({ name: "commit_appointment_change", status: "UNKNOWN_OUTCOME", reasonCode: "COMMIT_OUTCOME_UNKNOWN" });
    const hit = reachOf(rule, (e) => {
      e.toolCalls = [unknown];
      e.committedActions = [action({ actionId: "act_noEffect000001", effectCount: 0 }), action()];
    });
    expect(hit).toMatchObject({ reached: true, observedBy: "action_ledger", evidenceRef: "call-evidence#committedActions/1" });
    // A crash before the commit took effect (no external effect) never reached the after-commit fault point.
    expect(reachOf(rule, (e) => { e.toolCalls = [unknown]; e.committedActions = [action({ effectCount: 0 })]; }).reached).toBe(false);
    expect(reachOf(rule, (e) => { e.toolCalls = [unknown]; e.committedActions = []; }).reached).toBe(false);
    // An effect without an ambiguous result of the listed tool is a normal commit, not the fault.
    expect(reachOf(rule, (e) => { e.toolCalls = [{ ...unknown, status: "SUCCESS" }]; e.committedActions = [action()]; }).reached).toBe(false);
    expect(reachOf(rule, (e) => { e.toolCalls = [{ ...unknown, name: "submit_billing_review" }]; e.committedActions = [action()]; }).reached).toBe(false);
    for (const [why, mutate] of [
      ["tool calls not collected", (e: CallEvidence) => { e.toolCalls = null; e.committedActions = [action()]; }],
      ["committed actions not collected", (e: CallEvidence) => { e.toolCalls = [unknown]; e.committedActions = null; }],
      ["committed state from a transcript", (e: CallEvidence) => { e.toolCalls = [unknown]; e.committedActions = [action()]; e.committedStateSource = "transcript_inference"; }],
      ["committed state from a judge", (e: CallEvidence) => { e.toolCalls = [unknown]; e.committedActions = [action()]; e.committedStateSource = "llm_judge"; }],
    ] as const) {
      expect(reachOf(rule, mutate).reached, why).toBeNull();
    }
  });

  it("[FO-17-11][SAFE-04] transfer_states: the two states must be recorded consecutively and in order", () => {
    const rule: ReachEvidence = { source: "transfer_states", adjacent: ["QUEUED", "TIMEOUT"] };
    const states = (xs: NonNullable<CallEvidence["transfer"]>["states"]) => (e: CallEvidence) => void (e.transfer = { ...(e.transfer as NonNullable<CallEvidence["transfer"]>), attempted: true, states: [...xs] });
    expect(reachOf(rule, states(["REQUESTED", "RECEIVER_ACCEPTED", "QUEUED", "TIMEOUT", "REQUESTED"]))).toMatchObject({ reached: true, observedBy: "transfer_store", evidenceRef: "call-evidence#transfer/states/2" });
    expect(reachOf(rule, states(["REQUESTED", "QUEUED", "RECEIVER_ACCEPTED", "TIMEOUT"])).reached).toBe(false);
    expect(reachOf(rule, states(["REQUESTED", "TIMEOUT", "QUEUED"])).reached).toBe(false);
    expect(reachOf(rule, states(["REQUESTED", "QUEUED"])).reached).toBe(false);
    expect(reachOf(rule, states([])).reached).toBe(false);
    expect(reachOf(rule, (e) => void (e.transfer = null)).reached).toBeNull();
  });

  it("[FO-17-11] support_request_kind: a support record of exactly that kind", () => {
    const rule: ReachEvidence = { source: "support_request_kind", kind: "internal_pending_sync" };
    const sr = (kind: "salesforce_case" | "internal_pending_sync", auditEventId: string | null = null) => ({ kind, referenceIssued: true, auditEventId });
    expect(reachOf(rule, (e) => void (e.supportRequests = [sr("salesforce_case"), sr("internal_pending_sync", "aud_reachSupport01")]))).toMatchObject({
      reached: true,
      observedBy: "support_records",
      evidenceRef: "audit_event#aud_reachSupport01",
    });
    expect(reachOf(rule, (e) => void (e.supportRequests = [sr("salesforce_case"), sr("internal_pending_sync")])).evidenceRef).toBe("call-evidence#supportRequests/1");
    expect(reachOf(rule, (e) => void (e.supportRequests = [sr("salesforce_case")])).reached).toBe(false);
    expect(reachOf(rule, (e) => void (e.supportRequests = [])).reached).toBe(false);
    expect(reachOf(rule, (e) => void (e.supportRequests = null)).reached).toBeNull();
  });

  it("[FO-17-11][AUTH-04] verification_not_completed: verification begun successfully and assurance never raised above A0", () => {
    const rule: ReachEvidence = { source: "verification_not_completed" };
    const begun = tool({ name: "begin_verification", status: "SUCCESS", reasonCode: null, sessionState: "none" });
    expect(reachOf(rule, (e) => { e.toolCalls = [tool(), begun]; e.assurance = "A0"; })).toMatchObject({ reached: true, observedBy: "session_service", evidenceRef: "call-evidence#toolCalls/1+assurance/A0" });
    for (const tier of ["A1", "A2", "A3"] as const) expect(reachOf(rule, (e) => { e.toolCalls = [begun]; e.assurance = tier; }).reached, tier).toBe(false);
    expect(reachOf(rule, (e) => { e.toolCalls = [{ ...begun, status: "PERMANENT_FAILURE" }]; e.assurance = "A0"; }).reached).toBe(false);
    expect(reachOf(rule, (e) => { e.toolCalls = [tool()]; e.assurance = "A0"; }).reached).toBe(false);
    expect(reachOf(rule, (e) => { e.toolCalls = [begun]; e.assurance = null; }).reached).toBeNull();
    expect(reachOf(rule, (e) => { e.toolCalls = null; e.assurance = "A0"; }).reached).toBeNull();
  });

  it("[FO-17-11] backend_record: one authoritative row matching every named field (any allowed value per field)", () => {
    const rule: ReachEvidence = { source: "backend_record", collection: "ledger", where: { state: ["INVALIDATED", "EXPIRED"], confirmed: [true] } };
    const rows = (xs: unknown[]) => (e: CallEvidence) => void (e.committedState = { ledger: xs });
    expect(reachOf(rule, rows([{ state: "COMMITTED", confirmed: true }, { state: "EXPIRED", confirmed: true }]))).toMatchObject({
      reached: true,
      observedBy: "backend_record.ledger",
      evidenceRef: "call-evidence#committedState/ledger/1",
    });
    expect(reachOf(rule, rows([{ state: "INVALIDATED", confirmed: false }])).reached).toBe(false);
    expect(reachOf(rule, rows([{ state: "INVALIDATED", confirmed: "true" }])).reached).toBe(false);
    expect(reachOf(rule, rows([{ state: "INVALIDATED" }])).reached).toBe(false);
    expect(reachOf(rule, rows([null, "INVALIDATED", 1])).reached).toBe(false);
    expect(reachOf(rule, rows([])).reached).toBe(false);
    expect(reachOf(rule, (e) => void (e.committedState = { ledger: { state: "INVALIDATED", confirmed: true } })).reached).toBeNull();
    expect(reachOf(rule, (e) => void (e.committedState = {})).reached).toBeNull();
    expect(reachOf(rule, (e) => void (e.committedState = null)).reached).toBeNull();
    expect(reachOf(rule, (e) => { e.committedState = { ledger: [{ state: "INVALIDATED", confirmed: true }] }; e.committedStateSource = "transcript_inference"; }).reached).toBeNull();
  });

  it("[FO-17-11][DATA-04] response_template: the response gate RENDERED one of the templates (prefix is the whole template id)", () => {
    const rule: ReachEvidence = { source: "response_template", templateIds: ["knowledge.stale_notice"] };
    const spoken = (xs: unknown[]) => (e: CallEvidence) => void (e.committedState = { spokenTemplates: xs });
    expect(reachOf(rule, spoken(["greeting.open:APPROVED:RENDERED", "knowledge.stale_notice:APPROVED:RENDERED"]))).toMatchObject({
      reached: true,
      observedBy: "response_gate",
      evidenceRef: "call-evidence#committedState/spokenTemplates/1",
    });
    expect(reachOf(rule, spoken(["knowledge.stale_notice:APPROVED:BLOCKED"])).reached).toBe(false);
    expect(reachOf(rule, spoken(["knowledge.stale_notice_v2:APPROVED:RENDERED"])).reached).toBe(false);
    expect(reachOf(rule, spoken(["greeting.open:APPROVED:RENDERED"])).reached).toBe(false);
    expect(reachOf(rule, spoken([42, null])).reached).toBe(false);
    expect(reachOf(rule, (e) => void (e.committedState = {})).reached).toBeNull();
    expect(reachOf(rule, (e) => { e.committedState = { spokenTemplates: ["knowledge.stale_notice:APPROVED:RENDERED"] }; e.committedStateSource = "llm_judge"; }).reached).toBeNull();
  });

  it("[FO-17-11][ACT-02] emulator_log: only a positive telephony emulator count; a zero count or any other note (including the driver's redelivery count) is no reach", () => {
    const telephony: ReachEvidence = { source: "emulator_log", log: "telephony_duplicate_events" };
    const notes = (xs: unknown[]) => (e: CallEvidence) => void (e.committedState = { driverNotes: xs });
    expect(reachOf(telephony, notes(["AI_EXIT_LIMIT_REACHED", "TELEPHONY_DUPLICATE_EVENTS_2"]))).toMatchObject({
      reached: true,
      observedBy: "emulator_log.telephony_delivered",
      evidenceRef: "call-evidence#committedState/driverNotes/1",
    });
    for (const n of ["TELEPHONY_DUPLICATE_EVENTS_0", "TELEPHONY_DUPLICATE_EVENTS_01", "TELEPHONY_DUPLICATE_EVENTS_2x", "telephony_duplicate_events_2", "DUPLICATE_REDELIVERIES_3", "DUPLICATE_WEBHOOK", "CONCURRENT_CALL_COULD_NOT_COMMIT"]) {
      expect(reachOf(telephony, notes([n])).reached, n).toBe(false);
    }
    expect(reachOf(telephony, notes([7, null])).reached).toBe(false);
    expect(reachOf(telephony, (e) => void (e.committedState = {})).reached).toBeNull();
    expect(reachOf(telephony, (e) => void (e.committedState = null)).reached).toBeNull();
    // The outbox redelivery count is not an emulator log: the schema no longer admits it as one.
    expect(ReachEvidence.safeParse({ source: "emulator_log", log: "outbox_redelivered_messages" }).success).toBe(false);
  });

  it("[FO-17-11][FO-17-44][ACT-02] driver_self_report: the driver's own redelivery count is never reach evidence and is labelled a driver self-report, not emulator evidence", () => {
    const self: ReachEvidence = { source: "driver_self_report", note: "outbox_redelivered" };
    const notes = (xs: unknown[]) => (e: CallEvidence) => void (e.committedState = { driverNotes: xs });
    expect(selfReportLabel("outbox_redelivered")).toBe("driver_notes.outbox_redelivered (driver self-report)");
    const only = reachOf(self, notes(["AI_EXIT_LIMIT_REACHED", "DUPLICATE_REDELIVERIES_12"]));
    expect(only).toMatchObject({ reached: null, observedBy: "driver_notes.outbox_redelivered (driver self-report)", evidenceRef: "call-evidence#committedState/driverNotes/1" });
    expect(only.detail).toContain("not independent evidence");
    expect(only.observedBy).not.toMatch(/^emulator_log/);
    for (const n of ["DUPLICATE_REDELIVERIES_0", "TELEPHONY_DUPLICATE_EVENTS_4", "DUPLICATE_REDELIVERIES_", "DUPLICATE_REDELIVERIES_3x"]) {
      expect(reachOf(self, notes([n])), n).toMatchObject({ reached: null, observedBy: null, evidenceRef: null });
    }
    expect(reachOf(self, (e) => void (e.committedState = null))).toMatchObject({ reached: null, observedBy: null });
    // Beside an independent rule: the independent rule decides; the self-report only labels a run it did not prove.
    const telephony: ReachEvidence = { source: "emulator_log", log: "telephony_duplicate_events" };
    const plan = planOf([telephony, self]);
    const e = base();
    const withNotes = (xs: string[]): CallEvidence => ({ ...e, committedState: { driverNotes: xs } });
    expect(evaluateFaultReach(plan, withNotes(["TELEPHONY_DUPLICATE_EVENTS_1", "DUPLICATE_REDELIVERIES_2"]))).toMatchObject({ reached: true, observedBy: "emulator_log.telephony_delivered" });
    const selfOnly = evaluateFaultReach(plan, withNotes(["TELEPHONY_DUPLICATE_EVENTS_0", "DUPLICATE_REDELIVERIES_2"]));
    expect(selfOnly).toMatchObject({ reached: null, observedBy: "driver_notes.outbox_redelivered (driver self-report)", evidenceRef: "call-evidence#committedState/driverNotes/1" });
    expect(selfOnly.detail).toContain("emulator_log.telephony_delivered");
    expect(evaluateFaultReach(plan, withNotes(["TELEPHONY_DUPLICATE_EVENTS_0"]))).toMatchObject({ reached: false, observedBy: null });
    // A plan whose only rule is a self-report has no independent local rule.
    expect(evaluateFaultReach(planOf([self]), withNotes([]))).toMatchObject({ reached: null, observedBy: null, detail: expect.stringContaining("no independent local reach rule") });
    expect(isIndependentReachRule(self)).toBe(false);
    expect(isIndependentReachRule(telephony)).toBe(true);
  });

  it("[FO-17-11][FO-17-44] the committed DUPLICATE_WEBHOOK plan reaches only on the telephony emulator's log; its outbox redelivery count is a driver self-report", () => {
    const plan = corpus.faultPlans.get("DUPLICATE_WEBHOOK") as FaultPlan;
    expect(plan.reachEvidence).toEqual([
      { source: "emulator_log", log: "telephony_duplicate_events" },
      { source: "driver_self_report", note: "outbox_redelivered" },
    ]);
    expect(plan.notes).toMatch(/driver self-report/);
    // No committed plan labels a driver self-report as emulator or backend evidence.
    for (const p of corpus.faultPlans.values()) for (const r of p.reachEvidence) if (r.source === "emulator_log") expect(r.log, p.faultId).toBe("telephony_duplicate_events");
  });

  it("[FO-17-11][OPS-03] plan level: no rule or nothing collected is null, a collected miss is false, the first matching rule in plan order is the observation", () => {
    const e = base();
    expect(evaluateFaultReach(planOf([]), e)).toMatchObject({ reached: null, observedBy: null, evidenceRef: null, detail: expect.stringContaining(`owner ${template.registry.layer2Owner}`) });
    const transfer: ReachEvidence = { source: "transfer_states", adjacent: ["QUEUED", "TIMEOUT"] };
    const nothing = { ...e, transfer: null, toolCalls: null };
    expect(evaluateFaultReach(planOf([transfer, TOOL_RULE]), nothing)).toMatchObject({ reached: null, detail: expect.stringContaining("not collected") });
    expect(evaluateFaultReach(planOf([transfer, TOOL_RULE]), { ...nothing, toolCalls: [] })).toMatchObject({ reached: false, observedBy: null, evidenceRef: null });
    const both: CallEvidence = { ...e, toolCalls: [tool({ auditEventId: "aud_reachFirst0001" })], transfer: { ...(e.transfer as NonNullable<CallEvidence["transfer"]>), states: ["QUEUED", "TIMEOUT"] } };
    expect(evaluateFaultReach(planOf([transfer, TOOL_RULE]), both)).toMatchObject({ reached: true, observedBy: "transfer_store" });
    expect(evaluateFaultReach(planOf([TOOL_RULE, transfer]), both)).toMatchObject({ reached: true, observedBy: "gateway.tool_response", evidenceRef: "audit_event#aud_reachFirst0001" });
    // The pointer is sanitised and bounded whatever the evidence ids contain.
    const odd = evaluateFaultReach(planOf([TOOL_RULE]), { ...e, toolCalls: [tool({ auditEventId: "aud with spaces<script>" })] });
    expect(odd.evidenceRef).toBe("audit_event#aud_with_spaces_script_");
    expect(evaluateFaultReach(planOf([TOOL_RULE]), { ...e, toolCalls: [tool()] }, `evidence/${"x".repeat(300)}`).evidenceRef?.length).toBe(256);
  });
});

describe("[FO-17-11][FO-01-23][OPS-03] the scorer accepts only an independently observed fault point", () => {
  const ctx = (plans: ReadonlyMap<string, FaultPlan>): ScoreContext => ({
    runId: "run_faultReach00001",
    runAt: "2026-10-19T12:00:00.000Z",
    repetition: 1,
    environment: "local",
    executionMode: "local_fixture",
    missingFaultPlans: [],
    injectionFailures: [],
    driverError: null,
    faultPlans: plans,
  });
  const NOTE_RULE: ReachEvidence = { source: "emulator_log", log: "telephony_duplicate_events" };
  /** The reschedule journey requesting one synthetic fault (driver reports it injected); `mutate` edits the evidence. */
  const scored = (rules: ReachEvidence[], mutate: (e: CallEvidence) => void = () => undefined) => {
    const plan = planOf(rules);
    const plans = new Map([...corpus.faultPlans, [plan.faultId, plan]]);
    const s: ScenarioDefinition = { ...reschedule, initialState: { ...reschedule.initialState, faults: [plan.faultId] } };
    const e = idealEvidenceFixture(s, plans);
    e.faultsInjected = [plan.faultId];
    mutate(e);
    const r = scoreScenarioDetailed(s, e, ctx(plans));
    return { ...r, reachCheck: r.result.assertions.find((a) => a.assertionId === "evidence.fault_reached.synth_reach_fault") };
  };

  it("[FO-17-11][OPS-03] control: the same run with a matching backend record is reached and PASSes", () => {
    const r = scored([NOTE_RULE]);
    expect(r.reach[0]).toMatchObject({ reached: true, observedBy: "emulator_log.telephony_delivered" });
    expect(r.reachCheck).toMatchObject({ verdict: "PASS", hardGate: true });
    expect(r.result.reachedFault).toEqual({ faultId: "SYNTH_REACH_FAULT", observedBy: "emulator_log.telephony_delivered", evidenceRef: "call-evidence#committedState/driverNotes/0" });
    expect(r.result.verdict).toBe("PASS");
  });

  it("[FO-17-11][OPS-03] a fault plan with no reach rule is INCONCLUSIVE (reached null), never PASS, although the driver reports it injected", () => {
    const r = scored([]);
    expect(r.reach[0]?.reached).toBeNull();
    expect(r.reachCheck).toMatchObject({ verdict: "INCONCLUSIVE", hardGate: true });
    expect(r.result.reachedFault).toBeNull();
    expect(r.result.requestedFault).toBe("SYNTH_REACH_FAULT");
    expect(r.result.assertions.filter((a) => a.verdict !== "PASS").map((a) => a.assertionId)).toEqual(["evidence.fault_reached.synth_reach_fault"]);
    expect(r.result.verdict).toBe("INCONCLUSIVE");
    expect(r.result.failureCode).toBe("INCONCLUSIVE_EVIDENCE_FAULT_REACHED_SYNTH_REACH_FAULT");
  });

  it("[FO-17-11][OPS-03] reach evidence that was not collected is INCONCLUSIVE (reached null), never PASS", () => {
    const r = scored([NOTE_RULE], (e) => void (e.committedState = {}));
    expect(r.reach[0]?.reached).toBeNull();
    expect(r.reachCheck?.verdict).toBe("INCONCLUSIVE");
    expect(r.result.reachedFault).toBeNull();
    expect(r.result.verdict).toBe("INCONCLUSIVE");
  });

  it("[FO-17-11][OPS-03] collected evidence without a matching record (a zero emulator count) is INCONCLUSIVE (reached false), never PASS", () => {
    const r = scored([NOTE_RULE], (e) => void (e.committedState = { driverNotes: ["TELEPHONY_DUPLICATE_EVENTS_0"] }));
    expect(r.reach[0]?.reached).toBe(false);
    expect(r.reachCheck?.verdict).toBe("INCONCLUSIVE");
    expect(r.result.reachedFault).toBeNull();
    expect(r.result.verdict).toBe("INCONCLUSIVE");
  });

  it("[FO-17-11][FO-17-44][OPS-03] a fault only the driver reports (driver self-report) is INCONCLUSIVE with no reachedFault, never PASS (verifier D3)", () => {
    const SELF: ReachEvidence = { source: "driver_self_report", note: "outbox_redelivered" };
    const r = scored([NOTE_RULE, SELF], (e) => void (e.committedState = { driverNotes: ["TELEPHONY_DUPLICATE_EVENTS_0", "DUPLICATE_REDELIVERIES_5"] }));
    expect(r.reach[0]).toMatchObject({ reached: null, observedBy: "driver_notes.outbox_redelivered (driver self-report)" });
    expect(r.reachCheck).toMatchObject({ verdict: "INCONCLUSIVE", hardGate: true });
    expect(r.reachCheck?.detail).toContain("driver self-report");
    expect(r.result.reachedFault).toBeNull();
    expect(r.result.verdict).toBe("INCONCLUSIVE");
    // The committed DUPLICATE_WEBHOOK journey on the outbox path (no telephony duplicate): INCONCLUSIVE, not PASS.
    const s = corpus.byId.get("scn_journey_2_disputed_charge_review__duplicate_webhook") as ScenarioDefinition;
    const e = idealEvidenceFixture(s, corpus.faultPlans);
    e.committedState = { ...(e.committedState ?? {}), driverNotes: ["TELEPHONY_DUPLICATE_EVENTS_0", "DUPLICATE_REDELIVERIES_3"] };
    const w = scoreScenarioDetailed(s, e, ctx(corpus.faultPlans));
    expect(w.result).toMatchObject({ verdict: "INCONCLUSIVE", requestedFault: "DUPLICATE_WEBHOOK", reachedFault: null });
    expect(w.reach[0]?.observedBy).toBe("driver_notes.outbox_redelivered (driver self-report)");
  });

  it("[FO-17-11] every requested fault gets its own reach check; requestedFault is the first, and one unreached fault keeps the run from PASS", () => {
    const reached = planOf([NOTE_RULE], "SYNTH_REACH_ONE");
    const unreached = planOf([], "SYNTH_REACH_TWO");
    const plans = new Map([...corpus.faultPlans, [reached.faultId, reached], [unreached.faultId, unreached]]);
    const s: ScenarioDefinition = { ...reschedule, initialState: { ...reschedule.initialState, faults: [reached.faultId, unreached.faultId] } };
    const e = idealEvidenceFixture(s, plans);
    e.faultsInjected = [reached.faultId, unreached.faultId];
    const r = scoreScenarioDetailed(s, e, ctx(plans));
    expect(r.reach.map((o) => [o.faultId, o.reached])).toEqual([
      ["SYNTH_REACH_ONE", true],
      ["SYNTH_REACH_TWO", null],
    ]);
    const v = (id: string) => r.result.assertions.find((a) => a.assertionId === id)?.verdict;
    expect([v("evidence.fault_reached.synth_reach_one"), v("evidence.fault_reached.synth_reach_two")]).toEqual(["PASS", "INCONCLUSIVE"]);
    expect(r.result.requestedFault).toBe("SYNTH_REACH_ONE");
    expect(r.result.reachedFault?.faultId).toBe("SYNTH_REACH_ONE");
    expect(r.result.verdict).toBe("INCONCLUSIVE");
  });
});
