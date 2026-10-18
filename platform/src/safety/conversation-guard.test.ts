import { describe, expect, it } from "vitest";
import { createMemoryLogger } from "../observability/logger.js";
import {
  ConversationGuard,
  DEFAULT_GUARD_LIMITS,
  GUARD_DESTINATIONS,
  GUARD_TEMPLATES,
  GuardLimitsSchema,
  decide,
  initialGuardState,
} from "./conversation-guard.js";
import type { GuardAction, GuardEvent, GuardState } from "./conversation-guard.js";
import { SAFETY_PRIORITY_DESTINATION_ID } from "./router.js";

const CALL = "cal_synthCallPrimary0001";

function run(events: GuardEvent[], start: GuardState = initialGuardState()): { state: GuardState; actions: GuardAction[] } {
  let state = start;
  const actions: GuardAction[] = [];
  for (const e of events) {
    const d = decide(state, e);
    state = d.state;
    actions.push(d.action);
  }
  return { state, actions };
}
const times = (n: number, e: GuardEvent): GuardEvent[] => Array.from({ length: n }, () => e);

describe("conversation guard: normal mode", () => {
  it("[SPEC-2.guardrail] silence never hangs up: check-in, then offer a human, then transfer to the accessibility route", () => {
    const { actions } = run(times(3, { type: "SILENCE_TIMEOUT" }));
    expect(actions.map((a) => a.kind)).toEqual(["PLAY_TEMPLATE", "OFFER_HUMAN", "TRANSFER_HUMAN"]);
    expect(actions[0]).toMatchObject({ templateId: GUARD_TEMPLATES.silenceCheckIn });
    expect(actions[2]).toMatchObject({ transferReason: "ACCESSIBILITY", destinationId: GUARD_DESTINATIONS.standard, requiresAuthentication: false });
  });

  it("[SPEC-2.guardrail] a caller turn resets the consecutive-silence counter", () => {
    const { state, actions } = run([{ type: "SILENCE_TIMEOUT" }, { type: "TURN_COMPLETED" }, { type: "SILENCE_TIMEOUT" }]);
    expect(actions[2]?.kind).toBe("PLAY_TEMPLATE");
    expect(state.totalSilences).toBe(2);
  });

  it("[SPEC-2.guardrail] refusal and guardrail-trigger limits offer, then transfer to a human instead of closing the conversation", () => {
    expect(run(times(2, { type: "MODEL_REFUSAL" })).actions.map((a) => a.kind)).toEqual(["OFFER_HUMAN", "TRANSFER_HUMAN"]);
    expect(run(times(2, { type: "GUARDRAIL_TRIGGERED" })).actions.map((a) => a.kind)).toEqual(["OFFER_HUMAN", "TRANSFER_HUMAN"]);
  });

  it("[SPEC-2.guardrail] the application guardrail limit must stay below the vendor trigger limit so we transfer before the vendor closes", () => {
    expect(GuardLimitsSchema.safeParse({ ...DEFAULT_GUARD_LIMITS, maxGuardrailTriggers: 3, vendorGuardrailTriggerLimit: 3 }).success).toBe(false);
    expect(GuardLimitsSchema.safeParse({ ...DEFAULT_GUARD_LIMITS, maxGuardrailTriggers: 2, vendorGuardrailTriggerLimit: 3 }).success).toBe(true);
    expect(DEFAULT_GUARD_LIMITS.vendorGuardrailTriggerLimit).toBeNull();
  });

  it("[SPEC-2.guardrail] max turns offers a human at the soft limit and transfers at the hard limit", () => {
    const limits = { ...DEFAULT_GUARD_LIMITS, softTurnLimit: 2, maxTurns: 4 };
    const { actions } = run(times(4, { type: "TURN_COMPLETED" }), initialGuardState(limits));
    expect(actions.map((a) => a.kind)).toEqual(["CONTINUE", "OFFER_HUMAN", "CONTINUE", "TRANSFER_HUMAN"]);
  });

  it("[SPEC-12.budget] budget exhaustion outside safety mode routes to the approved continuity service, never a disconnect", () => {
    const { actions } = run([{ type: "BUDGET_EXHAUSTED" }]);
    expect(actions[0]).toMatchObject({ kind: "TRANSFER_HUMAN", destinationId: GUARD_DESTINATIONS.continuity, templateId: GUARD_TEMPLATES.outageContinuity, transferReason: "AI_UNAVAILABLE" });
    const capped = run([{ type: "COST_RECORDED", microUsd: 600 }], initialGuardState({ ...DEFAULT_GUARD_LIMITS, maxCallCostMicroUsd: 500 }));
    expect(capped.actions[0]?.kind).toBe("TRANSFER_HUMAN");
  });

  it("[SAFE-02] a caller request for a person transfers without authentication", () => {
    const [a] = run([{ type: "CALLER_REQUESTED_HUMAN" }]).actions;
    expect(a).toMatchObject({ kind: "TRANSFER_HUMAN", transferReason: "CALLER_REQUESTED_HUMAN", requiresAuthentication: false });
  });

  it("[SPEC-11.interpreter] an unsupported language goes to the staffed interpreter path", () => {
    const [a] = run([{ type: "UNSUPPORTED_LANGUAGE" }]).actions;
    expect(a).toMatchObject({ kind: "TRANSFER_HUMAN", destinationId: GUARD_DESTINATIONS.interpreter, templateId: GUARD_TEMPLATES.unsupportedLanguage });
  });

  it("[SPEC-10.transfer] a failed standard transfer plays the update and invokes the next route; the call is never ended", () => {
    const { actions } = run([{ type: "TRANSFER_STARTED", priority: "STANDARD" }, { type: "TRANSFER_FAILED" }]);
    expect(actions[1]).toMatchObject({ kind: "TRANSFER_HUMAN", templateId: GUARD_TEMPLATES.transferFailed, destinationId: GUARD_DESTINATIONS.continuity });
  });

  it("[SAFE-03] during an active transfer limits are ignored; only a safety signal escalates", () => {
    const start = run([{ type: "TRANSFER_STARTED", priority: "STANDARD" }]).state;
    const { actions } = run([...times(10, { type: "SILENCE_TIMEOUT" }), ...times(5, { type: "MODEL_REFUSAL" }), { type: "BUDGET_EXHAUSTED" }, { type: "MAX_DURATION_REACHED" }], start);
    expect(actions.every((a) => a.kind === "CONTINUE")).toBe(true);
    const esc = decide(start, { type: "SAFETY_SIGNAL" });
    expect(esc.action).toMatchObject({ kind: "SAFETY_ROUTE", step: "INITIATE", destinationId: SAFETY_PRIORITY_DESTINATION_ID });
  });

  it("[SPEC-2.guardrail] decide is pure: the input state is frozen and unchanged", () => {
    const s = initialGuardState();
    expect(Object.isFrozen(s)).toBe(true);
    const before = JSON.stringify(s);
    decide(s, { type: "MODEL_REFUSAL" });
    expect(JSON.stringify(s)).toBe(before);
  });
});

describe("conversation guard: safety mode", () => {
  it("[SAFE-03] budget exhaustion during an active safety handoff keeps the safety route", () => {
    const s = run([{ type: "SAFETY_SIGNAL" }, { type: "TRANSFER_STARTED", priority: "SAFETY" }]).state;
    const d = decide(s, { type: "BUDGET_EXHAUSTED" });
    expect(d.action).toMatchObject({ kind: "SAFETY_ROUTE", step: "MAINTAIN", reasonCode: "SAFETY_RESERVE_IN_USE", destinationId: SAFETY_PRIORITY_DESTINATION_ID });
    expect(d.state.safetyModeActive).toBe(true);
  });

  it("[SAFE-03] refusal counts, silence, max turns and duration never end or downgrade a safety flow", () => {
    const { actions, state } = run([
      { type: "SAFETY_SIGNAL" },
      ...times(20, { type: "MODEL_REFUSAL" }),
      ...times(20, { type: "GUARDRAIL_TRIGGERED" }),
      ...times(20, { type: "SILENCE_TIMEOUT" }),
      ...times(60, { type: "TURN_COMPLETED" }),
      { type: "MAX_DURATION_REACHED" },
    ]);
    expect(actions.every((a) => a.kind === "SAFETY_ROUTE")).toBe(true);
    expect(actions[0]).toMatchObject({ step: "INITIATE", templateId: GUARD_TEMPLATES.safetyAcknowledgment, revokePendingActions: true, requiresAuthentication: false });
    expect(state.safetyModeActive).toBe(true);
  });

  it("[SAFE-03] a failed safety transfer updates the caller and retries; disconnect notifies the safety responder", () => {
    const s = run([{ type: "SAFETY_SIGNAL" }, { type: "TRANSFER_STARTED", priority: "SAFETY" }]).state;
    expect(decide(s, { type: "TRANSFER_FAILED" }).action).toMatchObject({ kind: "SAFETY_ROUTE", step: "UPDATE_CALLER", templateId: GUARD_TEMPLATES.safetyTransferUpdate });
    expect(decide(s, { type: "CALLER_DISCONNECTED" }).action).toMatchObject({ kind: "SAFETY_ROUTE", step: "NOTIFY_SAFETY_RESPONDER" });
    expect(decide(s, { type: "TRANSFER_CONNECTED" }).action).toMatchObject({ kind: "SAFETY_ROUTE", step: "HUMAN_CONNECTED" });
  });

  it("[SAFE-03] after a failed safety transfer a new signal or request re-initiates the safety route", () => {
    const s = run([{ type: "SAFETY_SIGNAL" }, { type: "TRANSFER_STARTED", priority: "SAFETY" }, { type: "TRANSFER_FAILED" }]).state;
    expect(decide(s, { type: "CALLER_REQUESTED_HUMAN" }).action).toMatchObject({ step: "INITIATE", reasonCode: "SAFETY_ROUTE_REINITIATE" });
  });
});

describe("ConversationGuard (LOCAL FIXTURE store)", () => {
  it("[SAFE-03] invalid events fail safe (human offer outside safety mode, safety route inside) and are logged content-free", () => {
    const { logger, records } = createMemoryLogger();
    const g = new ConversationGuard({ logger });
    expect(g.kind).toBe("local_fixture");
    g.start(CALL);
    expect(g.apply(CALL, { type: "HANG_UP" }).action.kind).toBe("OFFER_HUMAN");
    g.apply(CALL, { type: "SAFETY_SIGNAL" });
    expect(g.apply(CALL, { type: "TERMINATE_CALL", text: "caller words" }).action.kind).toBe("SAFETY_ROUTE");
    expect(JSON.stringify(records)).not.toContain("caller words");
  });

  it("[SAFE-03] lost guard state cannot downgrade a safety call: the session hint re-establishes safety mode", () => {
    const g = new ConversationGuard();
    const d = g.apply(CALL, { type: "MODEL_REFUSAL" }, { safetyModeActive: true });
    expect(d.action.kind).toBe("SAFETY_ROUTE");
    expect(g.state(CALL)?.safetyModeActive).toBe(true);
  });

  it("[DATA-01] call keys must be opaque ids", () => {
    const g = new ConversationGuard();
    expect(() => g.apply("+15555550101", { type: "TURN_COMPLETED" })).toThrow("GUARD_CALL_ID_INVALID");
  });

  it("[SPEC-2.guardrail] the per-call state map is bounded", () => {
    const g = new ConversationGuard({ maxCalls: 2 });
    g.start("cal_synthCallPrimary0001");
    g.start("cal_synthCallConcurrent1");
    g.start("cal_synthCallRepeat00001");
    expect(g.state("cal_synthCallPrimary0001")).toBeNull();
    expect(g.state("cal_synthCallRepeat00001")).not.toBeNull();
  });
});
