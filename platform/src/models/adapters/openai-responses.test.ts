/**
 * OpenAI Responses adapter against the protocol-exact emulator (WP-08; FO-09-07, FO-09-09, FO-09-45, FO-09-46,
 * FO-16-18). The production path end to end: ResilientModelPort -> OpenAiResponsesAdapter -> TransportModelExchange
 * -> ConnectorHttpTransport (per-request model egress check) -> emulator over the local loopback route. The emulator
 * is an in-process test emulator (platform/test/emulators/models); no network beyond 127.0.0.1, no real provider.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decideModelFallback, speakableText } from "../port/fallback.js";
import type { ModelStreamEvent } from "../port/types.js";
import { ModelEmulator } from "../../../test/emulators/models/server.js";
import { LOOKUP_TOOL, request, rig } from "../../../test/emulators/models/harness.js";

let emulator: ModelEmulator;
beforeAll(async () => {
  emulator = await new ModelEmulator({ httpPort: 0, frameDelayMs: 1 }).start();
});
afterAll(async () => {
  await emulator.stop();
});

describe("OpenAI Responses adapter over the emulator [FO-09-07][FO-09-09]", () => {
  it("[FO-09-07][DATA-01] streams text deltas, reports usage, and sends store:false through the egress-classified transport", async () => {
    const r = await rig("openai_responses", { emulator });
    const events: ModelStreamEvent[] = [];
    const result = await r.port.invoke(request(), { onEvent: (e) => events.push(e) });
    expect(result).toMatchObject({ outcome: "COMPLETED", provider: "openai_responses", text: "This is a synthetic emulated reply.", toolCalls: [], attempts: 1 });
    expect(events.filter((e) => e.type === "text_delta").map((e) => (e as { text: string }).text).join("")).toBe("This is a synthetic emulated reply.");
    expect(events.filter((e) => e.type === "text_delta").length).toBeGreaterThanOrEqual(3);
    expect(result.usage).toMatchObject({ inputTokens: expect.any(Number), outputTokens: 6, cachedInputTokens: 0, reasoningTokens: 0 });
    if (result.outcome === "COMPLETED") expect(result.detail).toMatchObject({ provider: "openai_responses", status: "completed", responseId: expect.stringMatching(/^resp_/) });
    const [log] = r.emulator.requests(r.host);
    expect(log).toMatchObject({ api: "openai_responses", authorized: true, stream: true, store: false, model: "emulated-text", completed: true });
    // Loopback emulator route: the transport never resolved the name (no DNS, no other socket).
    expect(r.lookups).toEqual([]);
    expect(r.metrics.counterValue("vsp_model_calls_total", { provider: "openai_responses", outcome: "COMPLETED" })).toBe(1);
  });

  it("[FO-09-07][FO-09-09] tool call round trip: function_call deltas become a parsed tool call, and the tool result is accepted", async () => {
    const r = await rig("openai_responses", { emulator, endpoint: { model: { id: "emulated-tools", revision: "emulated.1" } } });
    const events: ModelStreamEvent[] = [];
    const first = await r.port.invoke(request({ tools: [LOOKUP_TOOL] }), { onEvent: (e) => events.push(e) });
    expect(first.outcome).toBe("COMPLETED");
    if (first.outcome !== "COMPLETED") return;
    expect(first.toolCalls).toEqual([{ callId: expect.stringMatching(/^call_/), name: "lookup_status", arguments: { reference: "synthetic" } }]);
    expect(events.some((e) => e.type === "tool_call_started")).toBe(true);
    expect(events.filter((e) => e.type === "tool_call_arguments_delta").length).toBeGreaterThanOrEqual(2);
    const call = first.toolCalls[0]!;
    const second = await r.port.invoke(
      request({
        tools: [LOOKUP_TOOL],
        messages: [
          { role: "user", content: "Synthetic caller turn." },
          { role: "assistant", content: "", toolCalls: [call] },
          { role: "tool", callId: call.callId, name: call.name, content: JSON.stringify({ status: "SYNTHETIC_OPEN" }) },
        ],
      }),
    );
    expect(second).toMatchObject({ outcome: "COMPLETED", text: "The synthetic tool result was received.", toolCalls: [] });
    expect(r.emulator.requests(r.host).map((l) => l.toolCount)).toEqual([1, 1]);
  });

  it("[FO-09-46][FAULT:MODEL_REFUSAL seam] a provider refusal is REFUSED, carries no speakable text, and the fallback is the approved template plus a human", async () => {
    const r = await rig("openai_responses", { emulator });
    r.emulator.injectFault(r.host, "MODEL_REFUSAL");
    const events: ModelStreamEvent[] = [];
    const result = await r.port.invoke(request(), { onEvent: (e) => events.push(e) });
    expect(result).toMatchObject({ outcome: "REFUSED", refusal: { source: "MODEL_REFUSAL", reasonCode: "MODEL_REFUSED" } });
    expect(events.some((e) => e.type === "refusal_delta")).toBe(true);
    expect(speakableText(result)).toBeNull();
    expect(decideModelFallback(result, { safetySignalActive: false })).toMatchObject({
      kind: "APPROVED_FALLBACK",
      reason: "MODEL_REFUSED",
      suppressModelText: true,
      decisions: [{ kind: "SPEECH_REQUEST", templateId: "fallback.safe_explanation" }, { kind: "HANDOFF_PROPOSAL", reason: "AI_UNAVAILABLE" }],
    });
    expect(r.emulator.requests(r.host)[0]?.script).toBe("refusal");
  });

  it("[FO-09-09] content filter and max_output_tokens keep their provider meaning: REFUSED CONTENT_FILTER and INCOMPLETE", async () => {
    const r = await rig("openai_responses", { emulator });
    r.emulator.queue(r.host, { kind: "content_filter" }, { kind: "max_tokens" });
    expect(await r.port.invoke(request())).toMatchObject({ outcome: "REFUSED", refusal: { source: "CONTENT_FILTER" }, detail: { incompleteReason: "content_filter" } });
    expect(await r.port.invoke(request())).toMatchObject({ outcome: "INCOMPLETE", reasonCode: "MODEL_MAX_OUTPUT_TOKENS", detail: { incompleteReason: "max_output_tokens", status: "incomplete" } });
  });

  it("[FO-09-45][FAULT:MODEL_OVERLOAD seam] 429 with Retry-After: one bounded retry that waits at least the provider's delay, then success", async () => {
    const r = await rig("openai_responses", { emulator, endpoint: { retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 5_000 } } });
    r.emulator.injectFault(r.host, "MODEL_OVERLOAD");
    const started = Date.now();
    const result = await r.port.invoke(request());
    expect(result).toMatchObject({ outcome: "COMPLETED", attempts: 2 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(950);
    expect(r.emulator.requests(r.host).map((l) => l.status)).toEqual([429, 200]);
  });

  it("[FO-09-45][FAULT:MODEL_OVERLOAD seam] overload without a retry budget is a typed OVERLOADED with the provider's Retry-After; insufficient_quota is never retried", async () => {
    const r = await rig("openai_responses", { emulator });
    r.emulator.injectFault(r.host, "MODEL_OVERLOAD", 1, { retryAfterMs: 1500 } as never);
    expect(await r.port.invoke(request())).toMatchObject({ outcome: "OVERLOADED", retryAfterMs: 1500, reasonCode: "MODEL_OVERLOADED" });
    const q = await rig("openai_responses", { emulator, endpoint: { retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 10 } } });
    q.emulator.queue(q.host, { kind: "quota_exhausted" }, { kind: "text", text: "never reached" });
    expect(await q.port.invoke(request())).toMatchObject({ outcome: "FAILED", errorClass: "PERMANENT", reasonCode: "MODEL_QUOTA_EXHAUSTED", httpStatus: 429, attempts: 1 });
    expect(q.emulator.requests(q.host)).toHaveLength(1);
  });

  it("[FO-09-45][FAULT:MODEL_HANG seam] a stalled stream ends at the attempt deadline as TIMED_OUT and the provider stream is closed", async () => {
    const r = await rig("openai_responses", { emulator, endpoint: { budget: { deadlineMs: 3_000, attemptTimeoutMs: 400, firstEventTimeoutMs: 400, idleTimeoutMs: 400, maxOutputTokens: 64, maxInputBytes: 65_536 } } });
    r.emulator.injectFault(r.host, "MODEL_HANG");
    const started = Date.now();
    const result = await r.port.invoke(request({ budget: { deadlineMs: 3_000, attemptTimeoutMs: 400, firstEventTimeoutMs: 400, idleTimeoutMs: 400, maxOutputTokens: 64, maxInputBytes: 65_536 } }));
    expect(result.outcome).toBe("TIMED_OUT");
    expect(Date.now() - started).toBeLessThan(2_500);
    expect(speakableText(result)).toBeNull();
    expect(decideModelFallback(result, { safetySignalActive: false })).toMatchObject({ kind: "APPROVED_FALLBACK", reason: "MODEL_HANG" });
    await expect.poll(() => r.emulator.requests(r.host)[0]?.clientClosedEarly, { timeout: 2_000 }).toBe(true);
    expect(r.emulator.requests(r.host)[0]?.framesWritten).toBeGreaterThan(0);
  });

  it("[FO-09-45] caller cancellation (barge-in) closes the provider stream and yields CANCELLED with no speech", async () => {
    const r = await rig("openai_responses", { emulator });
    r.emulator.queue(r.host, { kind: "hang", afterEvents: 2 });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 150);
    const result = await r.port.invoke(request(), { signal: ac.signal });
    expect(result).toMatchObject({ outcome: "CANCELLED", reasonCode: "MODEL_CALL_CANCELLED" });
    expect(decideModelFallback(result, { safetySignalActive: false })).toEqual({ kind: "NO_SPEECH_CANCELLED" });
    await expect.poll(() => r.emulator.requests(r.host)[0]?.clientClosedEarly, { timeout: 2_000 }).toBe(true);
  });

  it("[FO-09-06][AUTH-06] failure injection: a key the composition root cannot resolve is UNAVAILABLE MODEL_CREDENTIAL_UNAVAILABLE and nothing is sent", async () => {
    const r = await rig("openai_responses", {
      emulator,
      credential: {
        kind: "bearer",
        token: async () => {
          throw new Error("synthetic secret resolver failure");
        },
      },
    });
    expect(await r.port.invoke(request())).toMatchObject({ outcome: "UNAVAILABLE", reasonCode: "MODEL_CREDENTIAL_UNAVAILABLE", attempts: 1 });
    expect(r.emulator.requests(r.host)).toEqual([]);
  });

  it("[FO-09-09] malformed streams are MALFORMED, never text: invalid JSON, replayed sequence numbers, truncation, unparsable tool arguments", async () => {
    const r = await rig("openai_responses", { emulator });
    r.emulator.queue(r.host, { kind: "malformed", variant: "bad_json" }, { kind: "malformed", variant: "out_of_order" }, { kind: "malformed", variant: "replayed_sequence" }, { kind: "malformed", variant: "truncated" }, { kind: "malformed", variant: "bad_tool_args" });
    const codes = [];
    for (let i = 0; i < 5; i += 1) {
      const res = await r.port.invoke(request());
      expect(res.outcome).toBe("MALFORMED");
      expect(speakableText(res)).toBeNull();
      codes.push("reasonCode" in res ? res.reasonCode : null);
    }
    expect(codes).toEqual(["MODEL_STREAM_EVENT_INVALID", "MODEL_STREAM_OUT_OF_ORDER", "MODEL_STREAM_OUT_OF_ORDER", "MODEL_STREAM_TRUNCATED", "MODEL_TOOL_ARGUMENTS_INVALID"]);
  });

  it("[FO-09-07] adversarial: events without sequence_number (with a replayed delta) are MALFORMED, never duplicated text", async () => {
    const r = await rig("openai_responses", { emulator });
    r.emulator.queue(r.host, { kind: "malformed", variant: "missing_sequence_number" });
    const res = await r.port.invoke(request());
    expect(res).toMatchObject({ outcome: "MALFORMED", reasonCode: "MODEL_STREAM_SEQUENCE_MISSING" });
    expect(speakableText(res)).toBeNull();
  });

  it("[FO-09-07] adversarial (emulator variants): an unclosed function_call, an incomplete event claiming completed, and a function_call only in the terminal output are MALFORMED", async () => {
    const r = await rig("openai_responses", { emulator });
    r.emulator.queue(r.host, { kind: "malformed", variant: "tool_call_unclosed" }, { kind: "malformed", variant: "terminal_status_mismatch" }, { kind: "malformed", variant: "tool_call_not_streamed" });
    const results = [];
    for (let i = 0; i < 3; i += 1) results.push(await r.port.invoke(request({ tools: [LOOKUP_TOOL] })));
    expect(results.map((x) => [x.outcome, "reasonCode" in x ? x.reasonCode : null])).toEqual([
      ["MALFORMED", "MODEL_TOOL_CALL_UNCLOSED"],
      ["MALFORMED", "MODEL_STREAM_STATUS_MISMATCH"],
      ["MALFORMED", "MODEL_TOOL_CALL_NOT_STREAMED"],
    ]);
    for (const x of results) expect(speakableText(x)).toBeNull();
    expect(r.emulator.requests(r.host).map((l) => l.status)).toEqual([200, 200, 200]);
  });

  it("[FO-09-46][FO-09-07] adversarial: a refusal content part only in the terminal response (no refusal delta) is REFUSED, never an empty COMPLETED", async () => {
    const r = await rig("openai_responses", { emulator });
    r.emulator.queue(r.host, { kind: "malformed", variant: "refusal_terminal_only" });
    const res = await r.port.invoke(request());
    expect(res).toMatchObject({ outcome: "REFUSED", refusal: { source: "MODEL_REFUSAL", reasonCode: "MODEL_REFUSED" }, detail: { status: "completed" } });
    expect(decideModelFallback(res, { safetySignalActive: false })).toMatchObject({ kind: "APPROVED_FALLBACK", reason: "MODEL_REFUSED" });
  });

  it("[FO-09-09] error classes: a mid-stream server error is RETRYABLE, a rejected key UNAVAILABLE, a 500 retried within the budget", async () => {
    const r = await rig("openai_responses", { emulator });
    r.emulator.queue(r.host, { kind: "stream_error" }, { kind: "auth_error" });
    expect(await r.port.invoke(request())).toMatchObject({ outcome: "FAILED", errorClass: "RETRYABLE", reasonCode: "MODEL_SERVER_ERROR" });
    expect(await r.port.invoke(request())).toMatchObject({ outcome: "UNAVAILABLE", reasonCode: "MODEL_AUTH_REJECTED" });
    const s = await rig("openai_responses", { emulator, endpoint: { retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 10 } } });
    s.emulator.queue(s.host, { kind: "server_error" });
    expect(await s.port.invoke(request())).toMatchObject({ outcome: "COMPLETED", attempts: 2 });
  });

  it("[FO-09-45] the circuit breaker opens on provider failures; an open circuit fails fast without reaching the provider", async () => {
    const r = await rig("openai_responses", { emulator, endpoint: { breaker: { windowMs: 60_000, minimumRequests: 2, failureRateThreshold: 0.5, cooldownMs: 60_000, halfOpenMaxProbes: 1, halfOpenSuccessesToClose: 1 } } });
    r.emulator.queue(r.host, { kind: "server_error" }, { kind: "server_error" });
    expect((await r.port.invoke(request())).outcome).toBe("FAILED");
    expect((await r.port.invoke(request())).outcome).toBe("FAILED");
    const open = await r.port.invoke(request());
    expect(open).toMatchObject({ outcome: "UNAVAILABLE", reasonCode: "MODEL_CIRCUIT_OPEN", attempts: 0 });
    expect(decideModelFallback(open, { safetySignalActive: false })).toMatchObject({ kind: "APPROVED_FALLBACK", reason: "MODEL_OVERLOAD" });
    expect(r.emulator.requests(r.host)).toHaveLength(2);
  });

  it("[DATA-01] adversarial: PHI is never sent to a model endpoint whose ceiling is a synthetic class, and nothing reaches the provider", async () => {
    const r = await rig("openai_responses", { emulator });
    const result = await r.port.invoke(request({ dataClass: "PHI" }));
    expect(result).toMatchObject({ outcome: "UNAVAILABLE", reasonCode: "MODEL_DATA_CLASS_EXCEEDS_ENDPOINT", attempts: 0 });
    expect(r.emulator.requests(r.host)).toEqual([]);
    const secret = await r.port.invoke(request({ dataClass: "VERIFICATION_SECRET" }));
    expect(secret.outcome).toBe("UNAVAILABLE");
    expect(r.emulator.requests(r.host)).toEqual([]);
  });
});
