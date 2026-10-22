/**
 * Resilience of FACTORY-COMPOSED ports over the protocol-exact emulator (WP-08; FO-09-45, OPS-02): the breaker and
 * the bulkhead come from the endpoint configuration through createModelPorts, exactly as the composition root builds
 * them, and the provider exchange is the real adapter over the egress-classified transport to the in-process emulator.
 *  - [FAULT:MODEL_HANG] a hang ended by the overall deadline counts as a provider failure (attempt timeout equal to
 *    the deadline): the breaker opens and later calls fail fast without reaching the provider;
 *  - the overall deadline (not the attempt timeout) ends a retried call when it comes first;
 *  - the configured bulkhead refuses a concurrent call (MODEL_BACKPRESSURE) instead of queueing it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ModelProvider } from "../port/types.js";
import { ModelEmulator } from "../../../test/emulators/models/server.js";
import { request, rig } from "../../../test/emulators/models/harness.js";

const PROVIDERS: readonly ModelProvider[] = ["openai_responses", "bedrock_converse", "vllm_openai_compatible"];
const BREAKER = { windowMs: 60_000, minimumRequests: 2, failureRateThreshold: 0.5, cooldownMs: 60_000, halfOpenMaxProbes: 1, halfOpenSuccessesToClose: 1 };

let emulator: ModelEmulator;
beforeAll(async () => {
  emulator = await new ModelEmulator({ httpPort: 0, frameDelayMs: 1 }).start();
});
afterAll(async () => {
  await emulator.stop();
});

describe("factory-composed resilience over the emulator [FO-09-45]", () => {
  for (const provider of PROVIDERS) {
    it(`[FO-09-45][FAULT:MODEL_HANG seam] ${provider}: hangs ended by the overall deadline (attempt timeout == deadline) open the breaker; later calls fail fast with no request`, async () => {
      const budget = { deadlineMs: 400, attemptTimeoutMs: 400, firstEventTimeoutMs: 300, idleTimeoutMs: 300, maxOutputTokens: 64, maxInputBytes: 65_536 };
      const r = await rig(provider, { emulator, endpoint: { budget, breaker: BREAKER } });
      r.emulator.injectFault(r.host, "MODEL_HANG", 4);
      const results = [];
      for (let i = 0; i < 4; i += 1) results.push(await r.port.invoke(request({ budget })));
      expect(results.slice(0, 2), provider).toMatchObject([{ outcome: "TIMED_OUT" }, { outcome: "TIMED_OUT" }]);
      expect(results.slice(2), provider).toMatchObject([
        { outcome: "UNAVAILABLE", reasonCode: "MODEL_CIRCUIT_OPEN", attempts: 0 },
        { outcome: "UNAVAILABLE", reasonCode: "MODEL_CIRCUIT_OPEN", attempts: 0 },
      ]);
      const log = r.emulator.requests(r.host);
      expect(log).toHaveLength(2);
      await expect.poll(() => r.emulator.requests(r.host).every((l) => l.clientClosedEarly), { timeout: 2_000 }).toBe(true);
    });
  }

  for (const provider of ["openai_responses", "vllm_openai_compatible"] as const) {
    it(`[FO-09-45] ${provider}: after a Retry-After wait the retried attempt hangs; the overall deadline (shorter than wait + attempt timeout) ends the call`, async () => {
      // 429 with a 400 ms Retry-After, then a hang. Attempt timeout 600 ms: on its own it would end attempt 2 at about
      // 1,000 ms; the 800 ms overall deadline comes first.
      const budget = { deadlineMs: 800, attemptTimeoutMs: 600, firstEventTimeoutMs: 500, idleTimeoutMs: 500, maxOutputTokens: 64, maxInputBytes: 65_536 };
      const r = await rig(provider, { emulator, endpoint: { budget, retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 1_000 } } });
      r.emulator.injectFault(r.host, "MODEL_OVERLOAD", 1, { status: provider === "openai_responses" ? 429 : 503, retryAfterMs: 400, retryAfterSeconds: undefined } as never);
      r.emulator.injectFault(r.host, "MODEL_HANG");
      const started = Date.now();
      const result = await r.port.invoke(request({ budget }));
      const elapsed = Date.now() - started;
      expect(result).toMatchObject({ outcome: "TIMED_OUT", phase: "DEADLINE", reasonCode: "MODEL_DEADLINE_EXCEEDED", attempts: 2 });
      expect(elapsed).toBeGreaterThanOrEqual(780);
      expect(elapsed).toBeLessThan(990);
      expect(r.emulator.requests(r.host).map((l) => l.script)).toEqual(["overload", "hang"]);
    });
  }

  for (const provider of PROVIDERS) {
    it(`[FO-09-45] ${provider}: the configured bulkhead (maxConcurrent 1, maxQueue 0) refuses a concurrent call with MODEL_BACKPRESSURE; the provider sees one request`, async () => {
      const r = await rig(provider, { emulator, endpoint: { bulkhead: { maxConcurrent: 1, maxQueue: 0, queueTimeoutMs: 1 } } });
      r.emulator.queue(r.host, { kind: "hang", afterEvents: 2 });
      const ac = new AbortController();
      const first = r.port.invoke(request(), { signal: ac.signal });
      await expect.poll(() => r.emulator.requests(r.host).length, { timeout: 2_000 }).toBe(1);
      const second = await r.port.invoke(request());
      expect(second).toMatchObject({ outcome: "UNAVAILABLE", reasonCode: "MODEL_BACKPRESSURE", attempts: 0 });
      ac.abort();
      expect((await first).outcome).toBe("CANCELLED");
      expect(r.emulator.requests(r.host)).toHaveLength(1);
      // The slot is free again once the first call ended.
      expect((await r.port.invoke(request())).outcome).toBe("COMPLETED");
    });
  }

  it("[FO-09-45][OPS-05] the endpoint budget composed by the factory is a ceiling: a request asking for a longer deadline still ends at the endpoint's", async () => {
    const budget = { deadlineMs: 500, attemptTimeoutMs: 500, firstEventTimeoutMs: 400, idleTimeoutMs: 400, maxOutputTokens: 64, maxInputBytes: 65_536 };
    const r = await rig("openai_responses", { emulator, endpoint: { budget } });
    r.emulator.injectFault(r.host, "MODEL_HANG");
    const started = Date.now();
    // The request asks for 20 s; the endpoint was reviewed for 500 ms.
    const result = await r.port.invoke(request({ budget: { deadlineMs: 20_000, attemptTimeoutMs: 20_000, firstEventTimeoutMs: 20_000, idleTimeoutMs: 20_000, maxOutputTokens: 32_768, maxInputBytes: 262_144 } }));
    expect(result.outcome).toBe("TIMED_OUT");
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});
