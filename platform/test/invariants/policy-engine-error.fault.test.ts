/**
 * [FAULT:POLICY_ENGINE_ERROR] The fault plan scenarios/fixtures/failures/POLICY_ENGINE_ERROR.json at its real
 * injection point: "the in-process OPA evaluation throws or is undefined" (FO-17-24.POLICY_ENGINE_ERROR).
 *
 * Protocol: the REAL OpaWasmPolicyEngine of the full local container (compiled Rego bundle, WASM evaluation),
 * reached through the REAL MCP SDK client against the gateway on 127.0.0.1 (platform/test/journeys/harness.ts).
 * The in-process OPA WASM engine is an accepted Layer-2 protocol for this fault (work-packages.yaml WP-01);
 * the only test-specific part is the fault-injecting decorator around its evaluation seam
 * (platform/src/evaluation/policy-fault.ts), armed in THROW and UNDEFINED mode in turn. SYNTHETIC data only.
 *
 * Reach is proven from evidence independent of the injector's own count: the gateway's tool responses, the
 * durable audit events (verified hash chain) and the engine's fail-closed log line. The postconditions of the
 * plan are each asserted against backend state: protected reads and actions fail closed with
 * POLICY_ENGINE_ERROR, nothing is disclosed, prepared or committed, safety and human routes stay available
 * (SAFE-02), each denial is a durable audit event. The scorer then grades the same real records: the fault is
 * REACHED only with the real denial in the evidence, and a run whose fault never reached the engine is
 * INCONCLUSIVE, never PASS (FO-17-11, OPS-03).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadCorpus } from "../../src/evaluation/corpus.js";
import { idealEvidenceFixture } from "../../src/evaluation/evidence.fixture.js";
import { evaluateFaultReach } from "../../src/evaluation/fault-reach.js";
import { INJECTED_EVALUATION_ERROR, PolicyEvaluationFault } from "../../src/evaluation/policy-fault.js";
import type { PolicyFaultMode } from "../../src/evaluation/policy-fault.js";
import type { CallEvidence, ToolCallObservation } from "../../src/evaluation/runner.js";
import { scoreScenarioDetailed } from "../../src/evaluation/scorer.js";
import type { ScoreContext } from "../../src/evaluation/scorer.js";
import { APPOINTMENTS } from "../../src/fixtures/synthetic-world.js";
import type { AuditEvent, ScenarioDefinition } from "../../src/protocol/index.js";
import { AVERY, createJourneyHarness } from "../journeys/harness.js";
import type { JourneyCall, JourneyHarness, ToolResultView } from "../journeys/harness.js";

const APPT = APPOINTMENTS[0].appointmentId;
const READ_ARGS = { appointmentId: APPT, fromDate: "2026-10-20", toDate: "2026-10-31" } as const;
const FAIL_CLOSED_DETAIL: Record<PolicyFaultMode, string> = { THROW: "POLICY_EVALUATION_FAILED", UNDEFINED: "POLICY_RESULT_MALFORMED" };

const corpus = loadCorpus();
const plan = corpus.faultPlans.get("POLICY_ENGINE_ERROR");
/** The corpus scenarios that request this fault (development, held-out and regression splits). */
const faultScenarios: ScenarioDefinition[] = corpus.entries.map((x) => x.scenario).filter((s) => s.initialState.faults.includes("POLICY_ENGINE_ERROR"));

let h: JourneyHarness;
let fault: PolicyEvaluationFault;
beforeAll(async () => {
  h = await createJourneyHarness({ ingestKnowledge: false });
  fault = PolicyEvaluationFault.install(h.c.policy, { environment: "local" });
}, 180_000);
afterAll(async () => {
  fault?.uninstall();
  await h?.close();
});

async function verifiedClient(): Promise<JourneyCall> {
  const call = h.call();
  await call.start();
  await call.role("client");
  expect((await call.verify(AVERY, "avery.synthetic")).bound).toBe(true);
  return call;
}

type Option = { slotId: string | null; startsAt: string; status: string };
const openSlots = (r: ToolResultView): Option[] => ((r.data?.appointments as Option[] | undefined) ?? []).filter((a) => a.status === "OPEN");

const failClosedLines = (from: number) => h.logs.slice(from).filter((r) => r.event === "policy.decision.fail_closed");

/** The gateway's responses of one call as the evaluation records them (status, reason, audit id, session state). */
function observedToolCalls(call: JourneyCall, sessionValid: boolean): ToolCallObservation[] {
  return call.results.map(({ tool, result }, i) => ({
    name: tool,
    version: null,
    status: result.status,
    turnIndex: i,
    auditEventId: result.auditEventId,
    sessionState: call.sessionRef === null ? "none" : sessionValid ? "valid" : "expired",
    reasonCode: result.reasonCode ?? null,
  }));
}

const scoreCtx = (): ScoreContext => ({
  runId: "run_faultPolicyEngine01",
  runAt: h.clock.now().toISOString(),
  repetition: 1,
  environment: "local",
  executionMode: "local_fixture",
  missingFaultPlans: [],
  injectionFailures: [],
  driverError: null,
  faultPlans: corpus.faultPlans,
});

/**
 * Evidence of a scenario requesting POLICY_ENGINE_ERROR whose tool calls and audit ids are the REAL records of a
 * call on the local container. The remaining fields come from the scenario's ideal evidence WITHOUT any reach
 * record (unit fake for the conversation-level fields this test does not exercise, labelled as such).
 */
function evidenceFromRealCall(s: ScenarioDefinition, calls: ToolCallObservation[], audit: AuditEvent[]): CallEvidence {
  const e = idealEvidenceFixture(s, new Map());
  e.toolCalls = [...(e.toolCalls ?? []), ...calls];
  e.auditEventIds = [...(e.auditEventIds ?? []), ...audit.map((a) => a.eventId)];
  e.faultsInjected = ["POLICY_ENGINE_ERROR"];
  // Assurance from the backend record: a durable verification.bound event binds the session at A2
  // (business/contracts/public.ts "Session bound at A2 after the portal approval of the secure link").
  e.assurance = audit.some((a) => a.action === "verification.bound") ? "A2" : "A0";
  return e;
}

describe("[FAULT:POLICY_ENGINE_ERROR] in-process OPA WASM evaluation throws or is undefined", () => {
  it("[FAULT:POLICY_ENGINE_ERROR] the plan names this injection point, its packages and the reach rule the scorer applies", () => {
    expect(plan?.registry).toMatchObject({ requirementId: "FO-17-24.POLICY_ENGINE_ERROR", injectionPointPackages: ["WP-01"], layer2Owner: "WP-01", localDriver: "IN_PROCESS_FIXTURE_INJECTION" });
    expect(plan?.registry.injectionPoint).toBe("the in-process OPA evaluation throws or is undefined");
    expect(plan?.reachEvidence).toEqual([{ source: "tool_response", tools: null, statuses: ["POLICY_DENIED"], reasonCodes: ["POLICY_ENGINE_ERROR"], sessionStates: null }]);
    expect(faultScenarios.length).toBeGreaterThan(0);
  });

  it("[FAULT:POLICY_ENGINE_ERROR] the decorator refuses an engine without the evaluation seam (the test can never pass against an engine it did not reach)", () => {
    expect(() => PolicyEvaluationFault.install({} as never, { environment: "local" })).toThrow("POLICY_EVALUATOR_SEAM_MISSING");
    expect(() => PolicyEvaluationFault.install({ evaluator: { entrypoints: "x", evaluate: () => undefined } } as never, { environment: "local" })).toThrow("POLICY_EVALUATOR_SEAM_MISSING");
  });

  for (const mode of ["THROW", "UNDEFINED"] as const) {
    it(`[FAULT:POLICY_ENGINE_ERROR][AUTH-02][ACT-01][SAFE-02][OPS-03] ${mode}: protected reads and actions fail closed with POLICY_ENGINE_ERROR, nothing is disclosed, prepared or committed; safety and human routes stay available; each denial is audited`, async () => {
      const call = await verifiedClient();
      // Disarmed: the decorated engine decides exactly as the WASM engine (protected read allowed, prepare allowed).
      const before = await call.tool("get_appointment_options", READ_ARGS);
      expect(before.status).toBe("SUCCESS");
      const slot = openSlots(before)[0] as Option;
      const prepared = await call.tool("prepare_appointment_change", { appointmentId: APPT, startsAt: slot.startsAt, modality: null, slotId: slot.slotId });
      expect(prepared.status).toBe("SUCCESS");
      const change = prepared.data?.change as { actionId: string; actionDigest: string };
      await call.confirmPending();
      const effectsBefore = h.c.fixtures.scheduling.effects.length;
      const logFrom = h.logs.length;
      const injectedBefore = fault.injections;

      fault.arm(mode);
      const read = await call.tool("get_appointment_options", READ_ARGS);
      const prepare = await call.tool("prepare_appointment_change", { appointmentId: APPT, startsAt: slot.startsAt, modality: null, slotId: slot.slotId });
      const commit = await call.tool("commit_appointment_change", { actionId: change.actionId, digest: change.actionDigest });
      fault.disarm();
      // Disarmed: the same read is allowed again with the same data (the decorator is transparent when not armed).
      const after = await call.tool("get_appointment_options", READ_ARGS);
      expect(after.status).toBe("SUCCESS");
      expect(after.data).toEqual(before.data);

      fault.arm(mode);
      h.c.fixtures.telephony.scriptDestination("dst_safety_priority", { outcome: "CONNECTED" });
      const safety = await call.tool("request_safety_route", { signalSource: "CALLER_REQUEST", concernSubject: "SELF", language: "en-US" });
      const human = await call.tool("request_human_transfer", { reason: "CALLER_REQUESTED_HUMAN", language: "en-US", issueCategory: null, accommodations: [] });
      fault.disarm();

      // Fail closed with the engine-error reason; nothing protected comes back.
      for (const denied of [read, prepare, commit]) {
        expect(denied.status).toBe("POLICY_DENIED");
        expect(denied.reasonCode).toBe("POLICY_ENGINE_ERROR");
        expect(denied.data ?? null).toBeNull();
        expect(denied.auditEventId).toMatch(/^[a-z]{3}_/);
      }
      // No consequential action: no new ledger row from the faulted prepare, the confirmed action is not committed, no scheduling effect.
      const ledger = await h.q<{ action_id: string; state: string }>("select action_id, state from action_ledger where call_id = $1 order by prepared_at", [call.callId]);
      expect(ledger.map((r) => r.action_id)).toEqual([change.actionId]);
      expect(ledger[0]?.state).not.toBe("COMMITTED");
      expect(h.c.fixtures.scheduling.effects.length).toBe(effectsBefore);
      // SAFE-02: the safety route and the human route stay available under the engine failure.
      expect(safety.status).toBe("SUCCESS");
      expect(human.status).toBe("SUCCESS");
      expect(h.c.fixtures.telephony.dials.filter((d) => d.callId === call.callId).map((d) => d.priority)).toContain("SAFETY");

      // Reach, independent of the injector: durable audit events in the verified chain and the engine's fail-closed log.
      const audit = await h.auditFor(call.callId);
      const deniedEvents = audit.filter((e) => e.action === "tool.invoke" && e.outcome === "DENIED" && e.reasonCode === "POLICY_ENGINE_ERROR");
      expect(deniedEvents.map((e) => e.eventId).sort()).toEqual([read.auditEventId, prepare.auditEventId, commit.auditEventId].sort());
      const lines = failClosedLines(logFrom);
      expect(lines.length).toBeGreaterThanOrEqual(3);
      expect(new Set(lines.map((l) => l.fields.detailCode))).toEqual(new Set([FAIL_CLOSED_DETAIL[mode]]));
      expect(lines.every((l) => l.fields.reasonCode === "POLICY_ENGINE_ERROR")).toBe(true);
      expect(JSON.stringify(lines)).not.toContain(INJECTED_EVALUATION_ERROR);
      expect(fault.injections).toBeGreaterThan(injectedBefore);
      await h.expectAuditChainIntact();

      // The scorer grades the real records: reached via the gateway response that the audit chain holds.
      const calls = observedToolCalls(call, true);
      // The corpus scenario of a verified client that requests this fault (expected assurance A2, like this call).
      const s = faultScenarios.find((x) => x.audience === "client" && x.expectedAssurance === "A2") as ScenarioDefinition;
      expect(s).toBeDefined();
      const e = evidenceFromRealCall(s, calls, audit);
      const reach = evaluateFaultReach(plan as NonNullable<typeof plan>, e);
      expect(reach).toMatchObject({ faultId: "POLICY_ENGINE_ERROR", reached: true, observedBy: "gateway.tool_response" });
      expect(deniedEvents.map((x) => `audit_event#${x.eventId}`)).toContain(reach.evidenceRef);
      const scored = scoreScenarioDetailed(s, e, scoreCtx());
      expect(scored.result.requestedFault).toBe("POLICY_ENGINE_ERROR");
      expect(scored.result.reachedFault).toEqual({ faultId: "POLICY_ENGINE_ERROR", observedBy: "gateway.tool_response", evidenceRef: reach.evidenceRef });
      expect(scored.result.assertions.find((a) => a.assertionId === "evidence.fault_reached.policy_engine_error")?.verdict).toBe("PASS");
      for (const a of scored.result.assertions.filter((x) => x.assertionId.startsWith("fault.policy_engine_error."))) expect(a.verdict, a.assertionId).toBe("PASS");
      expect(scored.result.assertions.filter((a) => a.verdict !== "PASS")).toEqual([]);
      expect(scored.result.verdict).toBe("PASS");
      await call.end("CALLER_HANGUP");
    }, 120_000);
  }

  it("[FAULT:POLICY_ENGINE_ERROR][OPS-03] a run whose fault never reached the engine is INCONCLUSIVE, never PASS, even when the driver reports it injected", async () => {
    const call = await verifiedClient();
    // Armed then disarmed before any protected request: the driver "injected" the fault but the engine never failed.
    fault.arm("THROW");
    fault.disarm();
    const read = await call.tool("get_appointment_options", READ_ARGS);
    expect(read.status).toBe("SUCCESS");
    const audit = await h.auditFor(call.callId);
    expect(audit.some((e) => e.reasonCode === "POLICY_ENGINE_ERROR")).toBe(false);
    for (const s of faultScenarios) {
      const e = evidenceFromRealCall(s, observedToolCalls(call, true), audit);
      expect(e.faultsInjected).toEqual(["POLICY_ENGINE_ERROR"]);
      const scored = scoreScenarioDetailed(s, e, scoreCtx());
      expect(scored.reach[0]).toMatchObject({ faultId: "POLICY_ENGINE_ERROR", reached: false });
      expect(scored.result.requestedFault).toBe("POLICY_ENGINE_ERROR");
      expect(scored.result.reachedFault).toBeNull();
      expect(scored.result.assertions.find((a) => a.assertionId === "evidence.fault_reached.policy_engine_error")?.verdict).toBe("INCONCLUSIVE");
      expect(scored.result.verdict, s.scenarioId).not.toBe("PASS");
    }
    await call.end("CALLER_HANGUP");
  }, 120_000);

  it("[FAULT:POLICY_ENGINE_ERROR][AUTH-02] a denial for a different reason (unverified caller) is not mistaken for the engine fault", async () => {
    const call = h.call();
    await call.start();
    await call.role("client");
    const read = await call.tool("get_appointment_options", READ_ARGS);
    expect(read.status).toBe("POLICY_DENIED");
    expect(read.reasonCode).not.toBe("POLICY_ENGINE_ERROR");
    const audit = await h.auditFor(call.callId);
    const s = faultScenarios[0] as ScenarioDefinition;
    const reach = evaluateFaultReach(plan as NonNullable<typeof plan>, evidenceFromRealCall(s, observedToolCalls(call, true), audit));
    expect(reach.reached).toBe(false);
    await call.end("CALLER_HANGUP");
  }, 120_000);
});
