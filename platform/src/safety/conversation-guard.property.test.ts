/**
 * Property tests (fast-check, fixed seeds => deterministic) for SAFE-03:
 * refusal counts, silence and cost limits never silently terminate a safety flow.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DEFAULT_GUARD_LIMITS, GUARD_ACTION_KINDS, decide, initialGuardState } from "./conversation-guard.js";
import type { GuardAction, GuardEvent, GuardLimits, GuardState } from "./conversation-guard.js";
import { SAFETY_PRIORITY_DESTINATION_ID } from "./router.js";

const nonSafetyEvent: fc.Arbitrary<GuardEvent> = fc.oneof(
  fc.constant<GuardEvent>({ type: "TURN_COMPLETED" }),
  fc.constant<GuardEvent>({ type: "SILENCE_TIMEOUT" }),
  fc.constant<GuardEvent>({ type: "MODEL_REFUSAL" }),
  fc.constant<GuardEvent>({ type: "GUARDRAIL_TRIGGERED" }),
  fc.constant<GuardEvent>({ type: "MAX_DURATION_REACHED" }),
  fc.integer({ min: 0, max: 5_000_000 }).map<GuardEvent>((microUsd) => ({ type: "COST_RECORDED", microUsd })),
  fc.constant<GuardEvent>({ type: "BUDGET_EXHAUSTED" }),
  fc.constant<GuardEvent>({ type: "BUDGET_RESTORED" }),
  fc.constant<GuardEvent>({ type: "CALLER_REQUESTED_HUMAN" }),
  fc.constant<GuardEvent>({ type: "HUMAN_OFFER_ACCEPTED" }),
  fc.constant<GuardEvent>({ type: "HUMAN_OFFER_DECLINED" }),
  fc.constant<GuardEvent>({ type: "UNSUPPORTED_LANGUAGE" }),
  fc.constantFrom<"STANDARD" | "SAFETY">("STANDARD", "SAFETY").map<GuardEvent>((priority) => ({ type: "TRANSFER_STARTED", priority })),
  fc.constant<GuardEvent>({ type: "TRANSFER_FAILED" }),
  fc.constant<GuardEvent>({ type: "TRANSFER_CONNECTED" }),
  fc.constant<GuardEvent>({ type: "CALLER_DISCONNECTED" }),
);
const anyEvent: fc.Arbitrary<GuardEvent> = fc.oneof({ arbitrary: nonSafetyEvent, weight: 9 }, { arbitrary: fc.constant<GuardEvent>({ type: "SAFETY_SIGNAL" }), weight: 1 });

const limitsArb: fc.Arbitrary<GuardLimits> = fc
  .record({
    softTurnLimit: fc.integer({ min: 1, max: 10 }),
    extraTurns: fc.integer({ min: 1, max: 10 }),
    silenceCheckIns: fc.integer({ min: 0, max: 3 }),
    extraSilences: fc.integer({ min: 1, max: 4 }),
    maxRefusals: fc.integer({ min: 1, max: 5 }),
    maxGuardrailTriggers: fc.integer({ min: 1, max: 5 }),
    vendorExtra: fc.option(fc.integer({ min: 1, max: 5 }), { nil: null }),
    maxCallCostMicroUsd: fc.option(fc.integer({ min: 0, max: 10_000_000 }), { nil: null }),
  })
  .map((r) => ({
    softTurnLimit: r.softTurnLimit,
    maxTurns: r.softTurnLimit + r.extraTurns,
    silenceCheckIns: r.silenceCheckIns,
    maxConsecutiveSilences: r.silenceCheckIns + r.extraSilences,
    maxRefusals: r.maxRefusals,
    maxGuardrailTriggers: r.maxGuardrailTriggers,
    vendorGuardrailTriggerLimit: r.vendorExtra === null ? null : r.maxGuardrailTriggers + r.vendorExtra,
    maxCallCostMicroUsd: r.maxCallCostMicroUsd,
  }));

function runAll(start: GuardState, events: readonly GuardEvent[]): { actions: GuardAction[]; states: GuardState[] } {
  let s = start;
  const actions: GuardAction[] = [];
  const states: GuardState[] = [];
  for (const e of events) {
    const d = decide(s, e);
    s = d.state;
    actions.push(d.action);
    states.push(s);
  }
  return { actions, states };
}

const isSafetyAction = (a: GuardAction) => a.kind === "SAFETY_ROUTE" && a.destinationId === SAFETY_PRIORITY_DESTINATION_ID && a.revokePendingActions && a.requiresAuthentication === false;

describe("conversation guard properties", () => {
  it("[SAFE-03] no sequence of events in safety mode ever yields a non-safety action", () => {
    fc.assert(
      fc.property(limitsArb, fc.array(anyEvent, { maxLength: 80 }), (limits, events) => {
        const { actions, states } = runAll(initialGuardState(limits, { safetyModeActive: true }), events);
        expect(actions.every(isSafetyAction)).toBe(true);
        expect(states.every((s) => s.safetyModeActive)).toBe(true);
      }),
      { numRuns: 500, seed: 20261017 },
    );
  });

  it("[SAFE-03] from the first SAFETY_SIGNAL onward every action is a safety action and safety mode never clears", () => {
    fc.assert(
      fc.property(limitsArb, fc.array(nonSafetyEvent, { maxLength: 40 }), fc.array(anyEvent, { maxLength: 60 }), (limits, before, after) => {
        const events: GuardEvent[] = [...before, { type: "SAFETY_SIGNAL" }, ...after];
        const { actions, states } = runAll(initialGuardState(limits), events);
        const k = before.length;
        expect(actions.slice(k).every(isSafetyAction)).toBe(true);
        expect(states.slice(k).every((s) => s.safetyModeActive)).toBe(true);
        expect(actions[k]).toMatchObject({ kind: "SAFETY_ROUTE" });
      }),
      { numRuns: 500, seed: 42 },
    );
  });

  it("[SAFE-03] [SPEC-2.guardrail] no event sequence ever yields an action outside the non-terminating vocabulary", () => {
    fc.assert(
      fc.property(limitsArb, fc.array(anyEvent, { maxLength: 80 }), (limits, events) => {
        for (const a of runAll(initialGuardState(limits), events).actions) {
          expect(GUARD_ACTION_KINDS).toContain(a.kind);
          expect(JSON.stringify(a)).not.toMatch(/HANG|TERMINAT|DISCONNECT_CALL|END_CALL/);
          if (a.kind === "OFFER_HUMAN" || a.kind === "TRANSFER_HUMAN" || a.kind === "SAFETY_ROUTE") expect(a.requiresAuthentication).toBe(false);
        }
      }),
      { numRuns: 500, seed: 9 },
    );
  });

  it("[SPEC-12.budget] budget exhaustion during safety mode keeps the safety route for any limits and history", () => {
    fc.assert(
      fc.property(limitsArb, fc.array(anyEvent, { maxLength: 30 }), (limits, history) => {
        const { states } = runAll(initialGuardState(limits), [...history, { type: "SAFETY_SIGNAL" }]);
        const last = states[states.length - 1] ?? initialGuardState(limits, { safetyModeActive: true });
        const d = decide(last, { type: "BUDGET_EXHAUSTED" });
        expect(isSafetyAction(d.action)).toBe(true);
      }),
      { numRuns: 300, seed: 5 },
    );
  });

  it("[SPEC-2.guardrail] outside safety mode, with no transfer or human, repeated silence always reaches a human transfer (never abandoned)", () => {
    fc.assert(
      fc.property(limitsArb, (limits) => {
        const { actions } = runAll(initialGuardState(limits), Array.from({ length: limits.maxConsecutiveSilences }, () => ({ type: "SILENCE_TIMEOUT" }) as GuardEvent));
        expect(actions[actions.length - 1]).toMatchObject({ kind: "TRANSFER_HUMAN", transferReason: "ACCESSIBILITY" });
      }),
      { numRuns: 200, seed: 13 },
    );
  });

  it("[SPEC-2.guardrail] counters never go negative and limits stay as configured", () => {
    fc.assert(
      fc.property(fc.array(anyEvent, { maxLength: 80 }), (events) => {
        for (const s of runAll(initialGuardState(DEFAULT_GUARD_LIMITS), events).states) {
          for (const v of [s.turns, s.consecutiveSilences, s.totalSilences, s.refusals, s.guardrailTriggers, s.costMicroUsd]) expect(v).toBeGreaterThanOrEqual(0);
          expect(s.limits).toEqual(DEFAULT_GUARD_LIMITS);
        }
      }),
      { numRuns: 200, seed: 21 },
    );
  });
});
