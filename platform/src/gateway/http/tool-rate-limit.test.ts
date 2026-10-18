import { describe, expect, it } from "vitest";
import { CALLS } from "../../fixtures/synthetic-world.js";
import { FakeClock } from "../../shared/clock.js";
import { TOOL_DEFINITIONS } from "../tools/definitions.js";
import { ToolCallRateLimiter, callKeyOf, defaultPerCallWindow, isSafetyRouteTool, rateLimitHeaders } from "./tool-rate-limit.js";

const KEY = (callKey: string) => ({ integrationId: "talkdesk-local", channel: "mcp_tools", callKey });
const pinned = { definitions: Object.values(TOOL_DEFINITIONS) };

describe("ToolCallRateLimiter (SAFE-HANDOFF-03, VSP-GW-01, VSP-GW-03)", () => {
  it("[SAFE-02][SAFE-03][SAFE-HANDOFF-03] the pinned SAFETY_AND_HUMAN_ROUTE tools are classified exempt and never counted, even with every bucket empty", () => {
    expect(isSafetyRouteTool(pinned, "request_safety_route")).toBe(true);
    expect(isSafetyRouteTool(pinned, "request_human_transfer")).toBe(true);
    expect(isSafetyRouteTool(pinned, "search_approved_runbook")).toBe(false);
    expect(isSafetyRouteTool(pinned, "commit_appointment_change")).toBe(false);
    expect(isSafetyRouteTool(pinned, undefined)).toBe(false);
    // Every pinned safety/human tool, and nothing else, is exempt.
    const exempt = Object.values(TOOL_DEFINITIONS).filter((d) => isSafetyRouteTool(pinned, d.name)).map((d) => d.name).sort();
    expect(exempt).toEqual(Object.values(TOOL_DEFINITIONS).filter((d) => d.safetyClass === "SAFETY_AND_HUMAN_ROUTE").map((d) => d.name).sort());

    const clock = new FakeClock("2026-10-18T14:00:00.000Z");
    const l = new ToolCallRateLimiter({ clock, config: { integration: { max: 1, timeWindowMs: 60_000 }, perCall: { max: 1, timeWindowMs: 60_000 } } });
    expect(l.admit(KEY("call:a"), false).allowed).toBe(true);
    expect(l.admit(KEY("call:a"), false).allowed).toBe(false);
    for (let i = 0; i < 1000; i++) expect(l.admit(KEY("call:a"), true)).toEqual({ allowed: true, exempt: true });
    expect(rateLimitHeaders({ allowed: true, exempt: true })).toEqual({});
  });

  it("[SPEC-12.rate-limit][VSP-GW-01] per-call buckets isolate callers; the integration ceiling bounds the aggregate; nothing is consumed on refusal", () => {
    const clock = new FakeClock("2026-10-18T14:00:00.000Z");
    const l = new ToolCallRateLimiter({ clock, config: { integration: { max: 5, timeWindowMs: 60_000 }, perCall: { max: 2, timeWindowMs: 60_000 } } });
    expect([1, 2, 3].map(() => l.admit(KEY("call:a"), false).allowed)).toEqual([true, true, false]);
    const refused = l.admit(KEY("call:a"), false);
    expect(refused).toMatchObject({ allowed: false, scope: "CALL", remaining: 0 });
    expect(rateLimitHeaders(refused)["retry-after"]).toBe("60");
    expect([1, 2].map(() => l.admit(KEY("call:b"), false).allowed)).toEqual([true, true]);
    expect(l.admit(KEY("call:c"), false).allowed).toBe(true);
    // Aggregate ceiling (5) reached: a new call is refused by the integration bucket.
    expect(l.admit(KEY("call:d"), false)).toMatchObject({ allowed: false, scope: "INTEGRATION" });
    // The window rolls over with the injected clock.
    clock.advanceMs(60_000);
    expect(l.admit(KEY("call:a"), false).allowed).toBe(true);
    expect(l.admit(KEY("call:d"), false).allowed).toBe(true);
  });

  it("[SPEC-12.rate-limit] the default per-call share is a fifth of the ceiling, never below 120 unless the ceiling is lower", () => {
    expect(defaultPerCallWindow({ max: 600, timeWindowMs: 60_000 })).toEqual({ max: 120, timeWindowMs: 60_000 });
    expect(defaultPerCallWindow({ max: 10_000, timeWindowMs: 60_000 })).toEqual({ max: 2000, timeWindowMs: 60_000 });
    expect(defaultPerCallWindow({ max: 3, timeWindowMs: 1000 })).toEqual({ max: 3, timeWindowMs: 1000 });
    expect(() => new ToolCallRateLimiter({ clock: new FakeClock("2026-10-18T14:00:00.000Z"), config: { integration: { max: 0, timeWindowMs: 1 }, perCall: { max: 1, timeWindowMs: 1 } } })).toThrow(
      "TOOL_RATE_LIMIT_CONFIG_INVALID",
    );
  });

  it("[DATA-01][SPEC-12.rate-limit] the per-call key is the trusted interaction id or a session hash, never the bearer reference; the key map is bounded", () => {
    const sessionRef = `ses_${"A".repeat(43)}`;
    expect(callKeyOf({ interactionId: CALLS.primary.callId, sessionRef })).toBe(`call:${CALLS.primary.callId}`);
    const hashed = callKeyOf({ interactionId: null, sessionRef });
    expect(hashed.startsWith("ses:")).toBe(true);
    expect(hashed).not.toContain(sessionRef.slice(4));
    expect(callKeyOf({ interactionId: "+15555550100", sessionRef: "not-a-ref" })).toBe("unbound");
    const clock = new FakeClock("2026-10-18T14:00:00.000Z");
    const l = new ToolCallRateLimiter({ clock, config: { integration: { max: 10_000, timeWindowMs: 60_000 }, perCall: { max: 1, timeWindowMs: 60_000 } }, maxKeys: 4 });
    for (let i = 0; i < 50; i++) l.admit(KEY(`call:k${i}`), false);
    expect((l as unknown as { buckets: Map<string, unknown> }).buckets.size).toBeLessThanOrEqual(4);
  });
});
