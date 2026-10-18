import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { SessionInvalidError } from "../shared/errors.js";
import { InMemoryTurnTracker } from "./turns.js";

const SES = "ses_synthSessionPrimary000000001";

describe("InMemoryTurnTracker (LOCAL FIXTURE)", () => {
  it("[SPEC-11.barge-in] barge-in invalidates the current turn; a new turn becomes current", () => {
    const t = new InMemoryTurnTracker();
    expect(t.kind).toBe("local_fixture");
    const a = t.beginTurn(SES, 1);
    expect(t.isCurrent(SES, a, 1)).toBe(true);
    expect(t.bargeIn(SES)).toBe(a);
    expect(t.isCurrent(SES, a, 1)).toBe(false);
    expect(t.bargeIn(SES)).toBeNull();
    const b = t.beginTurn(SES, 1);
    expect(t.isCurrent(SES, b, 1)).toBe(true);
    expect(t.isCurrent(SES, a, 1)).toBe(false);
  });

  it("[SPEC-11.barge-in] turn ids and generations tag results: wrong generation or other session is never current", () => {
    const t = new InMemoryTurnTracker();
    const a = t.beginTurn(SES, 1);
    expect(t.isCurrent(SES, a, 2)).toBe(false);
    expect(t.isCurrent("ses_synthSessionOther0000000001", a, 1)).toBe(false);
    const b = t.beginTurn(SES, 2);
    expect(t.isCurrent(SES, a, 1)).toBe(false);
    expect(t.isCurrent(SES, b, 2)).toBe(true);
    expect(() => t.beginTurn(SES, 1)).toThrow(SessionInvalidError);
    expect(() => t.beginTurn(SES, 0)).toThrow("SESSION_GENERATION_INVALID");
    expect(() => t.beginTurn("+15555550101", 1)).toThrow("SESSION_REF_INVALID");
  });

  it("[SPEC-11.barge-in] invalidation listeners are told why a turn stopped being current", () => {
    const t = new InMemoryTurnTracker();
    const causes: string[] = [];
    t.onInvalidate((_s, _turn, cause) => causes.push(cause));
    t.beginTurn(SES, 1);
    t.beginTurn(SES, 1);
    t.bargeIn(SES);
    t.beginTurn(SES, 1);
    t.beginTurn(SES, 2);
    t.endSession(SES);
    expect(causes).toEqual(["NEW_TURN", "BARGE_IN", "GENERATION_CHANGED", "SESSION_ENDED"]);
  });

  it("[SPEC-11.barge-in] at most one turn is current per session for any sequence of operations", () => {
    fc.assert(
      fc.property(fc.array(fc.oneof(fc.constant("begin" as const), fc.constant("barge" as const), fc.constant("bump" as const)), { maxLength: 50 }), (ops) => {
        let n = 0;
        const t = new InMemoryTurnTracker({ newTurnId: () => `turn_synth${String(++n).padStart(4, "0")}` });
        let gen = 1;
        const issued: { id: string; gen: number }[] = [];
        for (const op of ops) {
          if (op === "begin") issued.push({ id: t.beginTurn(SES, gen), gen });
          else if (op === "bump") issued.push({ id: t.beginTurn(SES, ++gen), gen });
          else t.bargeIn(SES);
          expect(issued.filter((x) => t.isCurrent(SES, x.id, x.gen)).length).toBeLessThanOrEqual(1);
        }
      }),
      { numRuns: 300, seed: 17 },
    );
  });

  it("[SPEC-11.barge-in] the session map is bounded and evicted sessions fail closed", () => {
    const t = new InMemoryTurnTracker({ maxSessions: 1 });
    const a = t.beginTurn(SES, 1);
    t.beginTurn("ses_synthSessionOther0000000001", 1);
    expect(t.isCurrent(SES, a, 1)).toBe(false);
  });
});
