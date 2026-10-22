/**
 * ResilientModelPort unit tests (WP-08; FO-09-45, FO-09-09, OPS-02). UNIT FAKE: `ScriptedAdapter` below is a
 * test-only adapter that replays scripted attempt outcomes; it is not an emulator and never runs outside this file.
 * The provider protocols are tested against the protocol-exact emulators in ../adapters/*.test.ts.
 */
import { describe, expect, it } from "vitest";
import { createMemoryLogger } from "../../observability/logger.js";
import { Bulkhead } from "../../resilience/bulkhead.js";
import { CircuitBreaker } from "../../resilience/circuit-breaker.js";
import { systemClock } from "../../shared/clock.js";
import { AccessDeniedError, ValidationError } from "../../shared/errors.js";
import { testMetrics, request } from "../../../test/emulators/models/harness.js";
import type { AttemptContext, AttemptResult, ModelAdapter } from "./adapter.js";
import { ModelCallError } from "./errors.js";
import { ResilientModelPort, dataClassWithinEndpoint } from "./resilient.js";
import type { ModelRequest } from "./types.js";

type Step = AttemptResult | ModelCallError | { delayMs: number; then: AttemptResult | ModelCallError } | ((ctx: AttemptContext) => Promise<AttemptResult>);

const DETAIL = { provider: "openai_responses" as const, responseId: null, status: "completed" as const, incompleteReason: null, errorCode: null };
const OK: AttemptResult = { provider: "openai_responses", outcome: "COMPLETED", text: "synthetic", toolCalls: [], usage: { inputTokens: 3, outputTokens: 1, cachedInputTokens: null, reasoningTokens: null }, detail: DETAIL };
const overload = (retryAfterMs: number | null = null) => new ModelCallError({ kind: "OVERLOADED", reasonCode: "MODEL_OVERLOADED", errorClass: "RETRYABLE", httpStatus: 429, retryAfterMs });
const serverError = () => new ModelCallError({ kind: "FAILED", reasonCode: "MODEL_SERVER_ERROR", errorClass: "RETRYABLE", httpStatus: 500 });

/** UNIT FAKE adapter (scripted outcomes; honours the AbortSignal like a real adapter). */
class ScriptedAdapter implements ModelAdapter {
  readonly provider = "openai_responses" as const;
  calls = 0;
  aborted = 0;
  constructor(private readonly steps: Step[]) {}
  async attempt(_req: ModelRequest, ctx: AttemptContext): Promise<AttemptResult> {
    const step = this.steps[this.calls++] ?? OK;
    if (typeof step === "function") return step(ctx);
    if ("delayMs" in step) {
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          clearTimeout(t);
          this.aborted += 1;
          reject(new ModelCallError({ kind: "CANCELLED", reasonCode: "MODEL_CALL_CANCELLED", errorClass: "PERMANENT" }));
        };
        const t = setTimeout(() => {
          ctx.signal.removeEventListener("abort", onAbort);
          resolve();
        }, step.delayMs);
        ctx.signal.addEventListener("abort", onAbort, { once: true });
      });
      if (step.then instanceof ModelCallError) throw step.then;
      return step.then;
    }
    if (step instanceof ModelCallError) throw step;
    return step;
  }
}

const port = (a: ModelAdapter, over: Partial<ConstructorParameters<typeof ResilientModelPort>[1]> = {}) =>
  new ResilientModelPort(a, { endpointRef: "ep.unit.synth", maxDataClass: "INTERNAL", clock: systemClock, retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 }, ...over });

describe("ResilientModelPort [FO-09-45][FO-09-09]", () => {
  it("[FO-09-45] retries a transient overload within the budget, honouring the provider delay, and reports the attempts", async () => {
    const a = new ScriptedAdapter([overload(200), OK]);
    const sleeps: number[] = [];
    const p = port(a, { retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 1_000 }, sleep: async (ms) => void sleeps.push(ms), random: () => 0 });
    expect(await p.invoke(request())).toMatchObject({ outcome: "COMPLETED", attempts: 2 });
    expect(sleeps).toEqual([200]);
  });

  it("[OPS-06] sentAttempts counts only attempts whose request may have reached the provider (NOT_STARTED and pre-I/O refusals excluded)", async () => {
    const notStarted = () => new ModelCallError({ kind: "FAILED", reasonCode: "CONNECTION_REFUSED", errorClass: "RETRYABLE", notStarted: true });
    const retry = { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0, retryOn: ["MODEL_SERVER_ERROR", "CONNECTION_REFUSED"] };
    // Sent and failed, then refused before send, then refused before send: one sent attempt of three.
    expect(await port(new ScriptedAdapter([serverError(), notStarted(), notStarted()]), { retry }).invoke(request())).toMatchObject({ outcome: "FAILED", reasonCode: "CONNECTION_REFUSED", attempts: 3, sentAttempts: 1 });
    // Never sent at all.
    expect(await port(new ScriptedAdapter([notStarted(), notStarted(), notStarted()]), { retry }).invoke(request())).toMatchObject({ attempts: 3, sentAttempts: 0 });
    // Sent: a provider rejection (401 after send) and a completed exchange.
    const rejected = new ModelCallError({ kind: "UNAVAILABLE", reasonCode: "MODEL_AUTH_REJECTED", errorClass: "PERMANENT", httpStatus: 401 });
    expect(await port(new ScriptedAdapter([rejected])).invoke(request())).toMatchObject({ outcome: "UNAVAILABLE", reasonCode: "MODEL_AUTH_REJECTED", attempts: 1, sentAttempts: 1 });
    expect(await port(new ScriptedAdapter([serverError(), OK]), { retry }).invoke(request())).toMatchObject({ outcome: "COMPLETED", attempts: 2, sentAttempts: 2 });
    // An egress refusal raised by the transport before I/O (a PlatformError) is not sent; an unclassified error may have been.
    const egress = new ScriptedAdapter([async () => { throw new AccessDeniedError("EGRESS_CLASS_NOT_APPROVED_FOR_DESTINATION"); }]);
    expect(await port(egress).invoke(request())).toMatchObject({ outcome: "UNAVAILABLE", attempts: 1, sentAttempts: 0 });
    const unknown = new ScriptedAdapter([async () => { throw new Error("synthetic unclassified failure"); }]);
    expect(await port(unknown).invoke(request())).toMatchObject({ outcome: "FAILED", reasonCode: "UNCLASSIFIED_ERROR", attempts: 1, sentAttempts: 1 });
    // Refused before any attempt: zero of each.
    expect(await port(new ScriptedAdapter([OK])).invoke(request({ dataClass: "PHI" }))).toMatchObject({ attempts: 0, sentAttempts: 0 });
  });

  it("[FO-09-45][OPS-05] the endpoint budget is a ceiling: a request asking for more output tokens, input bytes or time is capped before the adapter sees it", async () => {
    const seen: ModelRequest["budget"][] = [];
    const capture: ModelAdapter = { provider: "openai_responses", attempt: async (req) => (seen.push(req.budget), OK) };
    const ceiling = { deadlineMs: 2_000, attemptTimeoutMs: 1_500, firstEventTimeoutMs: 800, idleTimeoutMs: 700, maxOutputTokens: 256, maxInputBytes: 8_192 };
    const p = port(capture, { budgetCeiling: ceiling });
    expect((await p.invoke(request({ budget: { deadlineMs: 120_000, attemptTimeoutMs: 120_000, firstEventTimeoutMs: 120_000, idleTimeoutMs: 120_000, maxOutputTokens: 32_768, maxInputBytes: 262_144 } }))).outcome).toBe("COMPLETED");
    expect(seen[0]).toEqual(ceiling);
    // Below the ceiling the request's own (smaller) values are kept.
    const small = { deadlineMs: 900, attemptTimeoutMs: 800, firstEventTimeoutMs: 300, idleTimeoutMs: 300, maxOutputTokens: 64, maxInputBytes: 4_096 };
    await p.invoke(request({ budget: small }));
    expect(seen[1]).toEqual(small);
    // The input-size check uses the capped bound: a request within its own bound but above the endpoint's is refused.
    const big = request({ messages: [{ role: "user", content: "x".repeat(10_000) }], budget: { deadlineMs: 5_000, attemptTimeoutMs: 4_000, firstEventTimeoutMs: 2_000, idleTimeoutMs: 2_000, maxOutputTokens: 256, maxInputBytes: 65_536 } });
    expect(await p.invoke(big)).toMatchObject({ outcome: "FAILED", reasonCode: "MODEL_INPUT_TOO_LARGE", attempts: 0 });
    expect(seen).toHaveLength(2);
  });

  it("[FO-09-45] a Retry-After the deadline cannot afford ends the retries: OVERLOADED with the provider's delay, one attempt", async () => {
    const a = new ScriptedAdapter([overload(10_000), OK]);
    const p = port(a, { retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 30_000 }, sleep: async () => undefined });
    expect(await p.invoke(request())).toMatchObject({ outcome: "OVERLOADED", retryAfterMs: 10_000, attempts: 1 });
    expect(a.calls).toBe(1);
  });

  it("[FO-09-45] adversarial: no retry once output reached the consumer (a delta is never duplicated)", async () => {
    const a = new ScriptedAdapter([
      async (ctx) => {
        ctx.emit({ type: "text_delta", text: "partial" });
        throw serverError();
      },
      OK,
    ]);
    const deltas: string[] = [];
    const p = port(a, { retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 10 }, sleep: async () => undefined });
    const r = await p.invoke(request(), { onEvent: (e) => e.type === "text_delta" && deltas.push(e.text) });
    expect(r).toMatchObject({ outcome: "FAILED", errorClass: "PERMANENT", reasonCode: "MODEL_SERVER_ERROR", attempts: 1 });
    expect(deltas).toEqual(["partial"]);
  });

  it("[FO-09-45] the overall deadline bounds attempts and waits: TIMED_OUT DEADLINE and the attempt's signal is aborted", async () => {
    const a = new ScriptedAdapter([{ delayMs: 5_000, then: OK }]);
    const p = port(a);
    const started = Date.now();
    const r = await p.invoke(request({ budget: { deadlineMs: 200, attemptTimeoutMs: 200, firstEventTimeoutMs: 100, idleTimeoutMs: 100, maxOutputTokens: 16, maxInputBytes: 65_536 } }));
    expect(r).toMatchObject({ outcome: "TIMED_OUT", phase: "DEADLINE", reasonCode: "MODEL_DEADLINE_EXCEEDED" });
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(a.aborted).toBe(1);
  });

  it("[FO-09-45] only the overall deadline ends the call when the attempt timeout is longer and retries are allowed (V29)", async () => {
    // Attempt 1 fails after 300 ms and is retried; attempt 2 hangs. Its attempt timeout (500 ms, shorter than the
    // 600 ms deadline) would end it at about 800 ms; the overall deadline ends it at 600 ms: the result is the
    // deadline's, with both attempts made.
    const a = new ScriptedAdapter([{ delayMs: 300, then: serverError() }, { delayMs: 10_000, then: OK }]);
    const p = port(a, { retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 10 }, random: () => 0 });
    const started = Date.now();
    const r = await p.invoke(request({ budget: { deadlineMs: 600, attemptTimeoutMs: 500, firstEventTimeoutMs: 400, idleTimeoutMs: 400, maxOutputTokens: 16, maxInputBytes: 65_536 } }));
    expect(r).toMatchObject({ outcome: "TIMED_OUT", phase: "DEADLINE", reasonCode: "MODEL_DEADLINE_EXCEEDED", attempts: 2 });
    expect(Date.now() - started).toBeLessThan(780);
    expect(a.aborted).toBe(1);
  });

  it("[FO-09-45] a retry wait is cut by the deadline: no further exchange starts, the result is the deadline's", async () => {
    // Default sleep (no injection): a 5 s backoff wait cannot outlive a 300 ms deadline.
    const a = new ScriptedAdapter([serverError(), OK]);
    const p = port(a, { retry: { maxAttempts: 2, baseDelayMs: 5_000, maxDelayMs: 5_000 }, random: () => 0.99 });
    const started = Date.now();
    const r = await p.invoke(request({ budget: { deadlineMs: 300, attemptTimeoutMs: 300, firstEventTimeoutMs: 200, idleTimeoutMs: 200, maxOutputTokens: 16, maxInputBytes: 65_536 } }));
    expect(r).toMatchObject({ outcome: "TIMED_OUT", phase: "DEADLINE", attempts: 1 });
    expect(a.calls).toBe(1);
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it("[FO-09-45][FAULT:MODEL_HANG seam] a hang ended by the overall deadline opens the breaker even when attempt timeout == deadline (D4); later calls fail fast", async () => {
    const breaker = new CircuitBreaker({ dependency: "model-provider", clock: systemClock, windowMs: 60_000, minimumRequests: 2, failureRateThreshold: 0.5, cooldownMs: 60_000, halfOpenMaxProbes: 1, halfOpenSuccessesToClose: 1 });
    const hang = { delayMs: 10_000, then: OK };
    const a = new ScriptedAdapter([hang, hang, hang, hang]);
    const p = port(a, { breaker });
    const budget = { deadlineMs: 150, attemptTimeoutMs: 150, firstEventTimeoutMs: 100, idleTimeoutMs: 100, maxOutputTokens: 16, maxInputBytes: 65_536 };
    const results = [];
    for (let i = 0; i < 4; i += 1) results.push(await p.invoke(request({ budget })));
    expect(results.slice(0, 2).map((r) => r.outcome)).toEqual(["TIMED_OUT", "TIMED_OUT"]);
    expect(breaker.state()).toBe("open");
    expect(results.slice(2)).toMatchObject([{ outcome: "UNAVAILABLE", reasonCode: "MODEL_CIRCUIT_OPEN", attempts: 0 }, { outcome: "UNAVAILABLE", reasonCode: "MODEL_CIRCUIT_OPEN", attempts: 0 }]);
    expect(a.calls).toBe(2);
  });

  it("[FO-09-45][OPS-02] caller cancellation (barge-in) stays neutral for the breaker, however often it happens", async () => {
    const breaker = new CircuitBreaker({ dependency: "model-provider", clock: systemClock, windowMs: 60_000, minimumRequests: 2, failureRateThreshold: 0.5, cooldownMs: 60_000, halfOpenMaxProbes: 1, halfOpenSuccessesToClose: 1 });
    const a = new ScriptedAdapter([{ delayMs: 5_000, then: OK }, { delayMs: 5_000, then: OK }, { delayMs: 5_000, then: OK }, OK]);
    const p = port(a, { breaker });
    for (let i = 0; i < 3; i += 1) {
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 20);
      expect((await p.invoke(request(), { signal: ac.signal })).outcome).toBe("CANCELLED");
    }
    expect(breaker.state()).toBe("closed");
    expect((await p.invoke(request())).outcome).toBe("COMPLETED");
  });

  it("[FO-09-45] an attempt timeout is reported as phase ATTEMPT (not the overall deadline)", async () => {
    const a = new ScriptedAdapter([{ delayMs: 5_000, then: OK }]);
    const r = await port(a).invoke(request({ budget: { deadlineMs: 3_000, attemptTimeoutMs: 150, firstEventTimeoutMs: 100, idleTimeoutMs: 100, maxOutputTokens: 16, maxInputBytes: 65_536 } }));
    expect(r).toMatchObject({ outcome: "TIMED_OUT", phase: "ATTEMPT", reasonCode: "MODEL_ATTEMPT_TIMEOUT" });
  });

  it("[DATA-01] adversarial: a request above the endpoint's data-class ceiling is refused before any exchange (the destination may allow it)", async () => {
    const a = new ScriptedAdapter([OK, OK, OK]);
    expect(await port(a).invoke(request({ dataClass: "PHI" }))).toMatchObject({ outcome: "UNAVAILABLE", reasonCode: "MODEL_DATA_CLASS_EXCEEDS_ENDPOINT", attempts: 0 });
    expect(await port(a, { maxDataClass: "PHI_RESTRICTED" }).invoke(request({ dataClass: "VERIFICATION_SECRET" }))).toMatchObject({ outcome: "UNAVAILABLE", reasonCode: "MODEL_DATA_CLASS_EXCEEDS_ENDPOINT" });
    expect(await port(a, { maxDataClass: "VERIFICATION_SECRET" }).invoke(request({ dataClass: "VERIFICATION_SECRET" }))).toMatchObject({ outcome: "UNAVAILABLE", reasonCode: "MODEL_DATA_CLASS_EXCEEDS_ENDPOINT" });
    expect(a.calls).toBe(0);
    // Positive: the platform's order (PUBLIC < INTERNAL < FINANCIAL < PHI < PHI_RESTRICTED).
    expect((await port(a, { maxDataClass: "PHI" }).invoke(request({ dataClass: "FINANCIAL" }))).outcome).toBe("COMPLETED");
    expect((await port(a, { maxDataClass: "PHI" }).invoke(request({ dataClass: "PHI" }))).outcome).toBe("COMPLETED");
    expect((await port(a).invoke(request({ dataClass: "PUBLIC" }))).outcome).toBe("COMPLETED");
    expect(() => port(a, { maxDataClass: "NOPE" as never })).toThrow(ValidationError);
  });

  it("[DATA-01] boundary: every class one rank above each ceiling is refused, every class at or below it is allowed (full order table)", async () => {
    const order = ["PUBLIC", "INTERNAL", "FINANCIAL", "PHI", "PHI_RESTRICTED"] as const;
    for (const [mi, ceiling] of order.entries()) {
      for (const [ci, cls] of order.entries()) expect(dataClassWithinEndpoint(cls, ceiling), `${cls} under ${ceiling}`).toBe(ci <= mi);
      expect(dataClassWithinEndpoint("VERIFICATION_SECRET", ceiling)).toBe(false);
    }
    const a = new ScriptedAdapter([OK, OK]);
    expect(await port(a, { maxDataClass: "INTERNAL" }).invoke(request({ dataClass: "FINANCIAL" }))).toMatchObject({ outcome: "UNAVAILABLE", reasonCode: "MODEL_DATA_CLASS_EXCEEDS_ENDPOINT", attempts: 0 });
    expect(await port(a, { maxDataClass: "FINANCIAL" }).invoke(request({ dataClass: "PHI" }))).toMatchObject({ outcome: "UNAVAILABLE", reasonCode: "MODEL_DATA_CLASS_EXCEEDS_ENDPOINT", attempts: 0 });
    expect(await port(a, { maxDataClass: "PUBLIC" }).invoke(request({ dataClass: "INTERNAL" }))).toMatchObject({ outcome: "UNAVAILABLE", reasonCode: "MODEL_DATA_CLASS_EXCEEDS_ENDPOINT", attempts: 0 });
    expect(a.calls).toBe(0);
    expect((await port(a, { maxDataClass: "FINANCIAL" }).invoke(request({ dataClass: "FINANCIAL" }))).outcome).toBe("COMPLETED");
  });

  it("[OPS-06][DATA-01] adversarial: a caller abort or an attempt timeout never reports sentAttempts before the in-flight attempt has settled (an exchange slow to close is still counted)", async () => {
    /** UNIT FAKE step: the request was sent; on abort the exchange takes `closeMs` to close, then fails as sent (or NOT_STARTED). */
    const slowToClose = (closeMs: number, notStarted = false) => (ctx: AttemptContext) =>
      new Promise<AttemptResult>((_resolve, reject) => {
        ctx.signal.addEventListener("abort", () => setTimeout(() => reject(new ModelCallError({ kind: "CANCELLED", reasonCode: "MODEL_CALL_CANCELLED", errorClass: "PERMANENT", notStarted })), closeMs), { once: true });
      });
    const cancelAfter = (ms: number) => {
      const ac = new AbortController();
      setTimeout(() => ac.abort(), ms);
      return ac.signal;
    };
    // Sent, closes 30 ms after the abort (inside the settle grace): the port waits and reports it as sent.
    expect(await port(new ScriptedAdapter([slowToClose(30)])).invoke(request(), { signal: cancelAfter(20) })).toMatchObject({ outcome: "CANCELLED", attempts: 1, sentAttempts: 1 });
    // Refused before send, known within the grace: not sent.
    expect(await port(new ScriptedAdapter([slowToClose(30, true)])).invoke(request(), { signal: cancelAfter(20) })).toMatchObject({ outcome: "CANCELLED", attempts: 1, sentAttempts: 0 });
    // Still open after the grace: counted as sent (fail toward recording), and the port does not wait for it.
    const t0 = Date.now();
    const stuck = await port(new ScriptedAdapter([slowToClose(2_000)])).invoke(request(), { signal: cancelAfter(20) });
    expect(stuck).toMatchObject({ outcome: "CANCELLED", attempts: 1, sentAttempts: 1 });
    expect(Date.now() - t0).toBeLessThan(1_000);
    // An attempt timeout (withTimeout rejects at once) settles the same way.
    const budget = { deadlineMs: 2_000, attemptTimeoutMs: 100, firstEventTimeoutMs: 100, idleTimeoutMs: 100, maxOutputTokens: 64, maxInputBytes: 65_536 };
    expect(await port(new ScriptedAdapter([slowToClose(30)])).invoke(request({ budget }))).toMatchObject({ outcome: "TIMED_OUT", phase: "ATTEMPT", attempts: 1, sentAttempts: 1 });
  });

  it("[FO-09-45] caller cancellation aborts the attempt and yields CANCELLED; a pre-aborted call never reaches the adapter", async () => {
    const a = new ScriptedAdapter([{ delayMs: 5_000, then: OK }]);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    expect(await port(a).invoke(request(), { signal: ac.signal })).toMatchObject({ outcome: "CANCELLED", reasonCode: "MODEL_CALL_CANCELLED" });
    expect(a.aborted).toBe(1);
    const b = new ScriptedAdapter([OK]);
    const pre = new AbortController();
    pre.abort();
    expect(await port(b).invoke(request(), { signal: pre.signal })).toMatchObject({ outcome: "CANCELLED", attempts: 0 });
    expect(b.calls).toBe(0);
  });

  it("[FO-09-45] backpressure: a full bulkhead refuses at once (UNAVAILABLE MODEL_BACKPRESSURE), never queues without bound", async () => {
    const a = new ScriptedAdapter([{ delayMs: 300, then: OK }, OK]);
    const p = port(a, { bulkhead: new Bulkhead({ dependency: "model-provider", maxConcurrent: 1, maxQueue: 0 }) });
    const first = p.invoke(request());
    const second = await p.invoke(request());
    expect(second).toMatchObject({ outcome: "UNAVAILABLE", reasonCode: "MODEL_BACKPRESSURE", attempts: 0 });
    expect((await first).outcome).toBe("COMPLETED");
  });

  it("[FO-09-45] a call whose deadline fires while it waits in the bulkhead queue leaves the queue at once (no slot outlives its caller), and the breaker stays neutral", async () => {
    const bulkhead = new Bulkhead({ dependency: "model-provider", maxConcurrent: 1, maxQueue: 2, queueTimeoutMs: 10_000 });
    const breaker = new CircuitBreaker({ dependency: "model-provider", clock: systemClock, windowMs: 60_000, minimumRequests: 2, failureRateThreshold: 0.5, cooldownMs: 60_000, halfOpenMaxProbes: 1, halfOpenSuccessesToClose: 1 });
    const a = new ScriptedAdapter([{ delayMs: 900, then: OK }, OK, OK, OK]);
    const p = port(a, { bulkhead, breaker });
    const holder = p.invoke(request({ budget: { deadlineMs: 3_000, attemptTimeoutMs: 3_000, firstEventTimeoutMs: 2_000, idleTimeoutMs: 2_000, maxOutputTokens: 16, maxInputBytes: 65_536 } }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    const short = { deadlineMs: 150, attemptTimeoutMs: 150, firstEventTimeoutMs: 100, idleTimeoutMs: 100, maxOutputTokens: 16, maxInputBytes: 65_536 };
    const queued = await Promise.all([p.invoke(request({ budget: short })), p.invoke(request({ budget: short }))]);
    expect(queued).toMatchObject([{ outcome: "TIMED_OUT", phase: "DEADLINE", attempts: 0, sentAttempts: 0 }, { outcome: "TIMED_OUT", phase: "DEADLINE", attempts: 0, sentAttempts: 0 }]);
    // Both abandoned waiters are gone from the queue: a fresh call queues (it is not refused MODEL_BACKPRESSURE) and
    // completes once the holder's slot frees.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(bulkhead.queued).toBe(0);
    const fresh = await p.invoke(request({ budget: { deadlineMs: 3_000, attemptTimeoutMs: 3_000, firstEventTimeoutMs: 2_000, idleTimeoutMs: 2_000, maxOutputTokens: 16, maxInputBytes: 65_536 } }));
    expect(fresh).toMatchObject({ outcome: "COMPLETED", attempts: 1 });
    expect((await holder).outcome).toBe("COMPLETED");
    // Queue-time deadlines reached no provider: neither waiter ran an attempt, and the breaker did not open.
    expect(a.calls).toBe(2);
    expect(breaker.state()).toBe("closed");
  });

  it("[FO-09-45][OPS-02] the breaker opens on failures and refusals do not count as failures", async () => {
    const breaker = new CircuitBreaker({ dependency: "model-provider", clock: systemClock, windowMs: 60_000, minimumRequests: 2, failureRateThreshold: 0.5, cooldownMs: 60_000, halfOpenMaxProbes: 1, halfOpenSuccessesToClose: 1 });
    const refused: AttemptResult = { provider: "openai_responses", outcome: "REFUSED", refusal: { source: "MODEL_REFUSAL", reasonCode: "MODEL_REFUSED" }, usage: null, detail: DETAIL };
    const a = new ScriptedAdapter([refused, refused, refused, serverError(), serverError(), serverError(), OK]);
    const p = port(a, { breaker });
    // A refusal is a provider answer, not a dependency failure: it counts as a successful exchange.
    for (let i = 0; i < 3; i += 1) expect((await p.invoke(request())).outcome).toBe("REFUSED");
    expect(breaker.state()).toBe("closed");
    await p.invoke(request());
    await p.invoke(request());
    expect(breaker.state()).toBe("closed"); // 2 failures of 5 exchanges: below the 50 % threshold
    await p.invoke(request());
    expect(breaker.state()).toBe("open");
    expect(await p.invoke(request())).toMatchObject({ outcome: "UNAVAILABLE", reasonCode: "MODEL_CIRCUIT_OPEN", attempts: 0 });
    expect(a.calls).toBe(6);
  });

  it("[FO-09-09] request validation and size: an invalid request throws; an oversized one is FAILED PERMANENT before any attempt", async () => {
    const a = new ScriptedAdapter([OK]);
    await expect(port(a).invoke({ ...request(), messages: [] })).rejects.toBeInstanceOf(ValidationError);
    const big = await port(a).invoke(request({ messages: [{ role: "user", content: "x".repeat(60_000) }], budget: { deadlineMs: 1_000, attemptTimeoutMs: 1_000, firstEventTimeoutMs: 500, idleTimeoutMs: 500, maxOutputTokens: 16, maxInputBytes: 2_048 } }));
    expect(big).toMatchObject({ outcome: "FAILED", errorClass: "PERMANENT", reasonCode: "MODEL_INPUT_TOO_LARGE", attempts: 0 });
    expect(a.calls).toBe(0);
  });

  it("[DATA-01] metrics and logs carry closed labels and reason codes only, never request or response text", async () => {
    const metrics = testMetrics();
    const { logger, records } = createMemoryLogger();
    const a = new ScriptedAdapter([serverError()]);
    const p = port(a, { metrics, logger });
    await p.invoke(request({ messages: [{ role: "user", content: "Synthetic caller says 555-0100" }] }));
    expect(metrics.counterValue("vsp_model_calls_total", { provider: "openai_responses", outcome: "FAILED" })).toBe(1);
    const dump = JSON.stringify(records);
    expect(dump).toContain("MODEL_SERVER_ERROR");
    expect(dump).not.toContain("555-0100");
    expect(dump).not.toContain("Synthetic caller");
  });

  it("[FO-09-09] a consumer callback that throws never changes the outcome", async () => {
    const a = new ScriptedAdapter([
      async (ctx) => {
        ctx.emit({ type: "text_delta", text: "x" });
        return OK;
      },
    ]);
    expect((await port(a).invoke(request(), { onEvent: () => { throw new Error("consumer bug"); } })).outcome).toBe("COMPLETED");
  });
});
