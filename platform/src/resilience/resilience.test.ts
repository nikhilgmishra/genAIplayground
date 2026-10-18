import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { FakeClock } from "../shared/clock.js";
import { AccessDeniedError, DependencyError, ValidationError } from "../shared/errors.js";
import { InMemoryMetrics } from "../observability/metrics.js";
import {
  Bulkhead,
  CircuitBreaker,
  CircuitBreakerRegistry,
  CircuitOpenError,
  NestedRetryError,
  RETRY_MAX_ATTEMPTS,
  callDependency,
  fullJitterDelay,
  isRetryScopeActive,
  isSafeToRetry,
  retry,
  retryOptionsFromToolPolicy,
  withTimeout,
} from "./index.js";
import type { CircuitBreakerSettings, TimerPort } from "./index.js";

/** LOCAL TEST FIXTURE: manual timer port so timeouts are deterministic. */
class ManualTimers implements TimerPort {
  private now = 0;
  private seq = 0;
  private readonly pending = new Map<number, { at: number; fn: () => void }>();
  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.pending.set(id, { at: this.now + ms, fn });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }
  advance(ms: number): void {
    this.now += ms;
    for (const [id, t] of [...this.pending.entries()].sort((a, b) => a[1].at - b[1].at)) {
      if (t.at <= this.now) {
        this.pending.delete(id);
        t.fn();
      }
    }
  }
  get size(): number {
    return this.pending.size;
  }
}

const noSleep = async () => undefined;
const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};
const flush = () => new Promise((r) => setImmediate(r));

describe("withTimeout", () => {
  it("[SPEC-12.timeouts] aborts the operation's signal and reports UNKNOWN outcome by default (ACT-03)", async () => {
    const timers = new ManualTimers();
    const metrics = new InMemoryMetrics();
    let seenSignal: AbortSignal | null = null;
    const p = withTimeout(
      1000,
      (signal) => {
        seenSignal = signal;
        return new Promise<string>(() => undefined);
      },
      { timers, dependency: "salesforce", metrics },
    );
    timers.advance(999);
    await flush();
    expect((seenSignal as AbortSignal | null)?.aborted).toBe(false);
    timers.advance(1);
    await expect(p).rejects.toMatchObject({ reasonCode: "TIMEOUT", outcome: "UNKNOWN", retryable: false });
    expect((seenSignal as AbortSignal | null)?.aborted).toBe(true);
    expect(metrics.counterValue("vsp_timeouts_total", { dependency: "salesforce" })).toBe(1);
  });

  it("[SPEC-12.timeouts] an idempotent operation's timeout is a retryable FAILED outcome", async () => {
    const timers = new ManualTimers();
    const p = withTimeout(50, () => new Promise<string>(() => undefined), { timers, idempotent: true });
    timers.advance(50);
    await expect(p).rejects.toMatchObject({ reasonCode: "TIMEOUT", outcome: "FAILED", retryable: true });
  });

  it("[SPEC-12.timeouts] resolves before the deadline and clears its timer", async () => {
    const timers = new ManualTimers();
    await expect(withTimeout(100, async () => "ok", { timers })).resolves.toBe("ok");
    expect(timers.size).toBe(0);
  });

  it("[SPEC-12.timeouts] honours caller cancellation: before start NOT_STARTED, after start UNKNOWN", async () => {
    const timers = new ManualTimers();
    const pre = new AbortController();
    pre.abort();
    let called = false;
    await expect(
      withTimeout(
        100,
        async () => {
          called = true;
          return 1;
        },
        { timers, signal: pre.signal },
      ),
    ).rejects.toMatchObject({ reasonCode: "CALLER_ABORTED", outcome: "NOT_STARTED" });
    expect(called).toBe(false);
    const mid = new AbortController();
    const p = withTimeout(100, () => new Promise<number>(() => undefined), { timers, signal: mid.signal });
    mid.abort();
    await expect(p).rejects.toMatchObject({ reasonCode: "CALLER_ABORTED", outcome: "UNKNOWN" });
  });

  it("[SPEC-12.timeouts] rejects unbounded or invalid timeouts", async () => {
    await expect(withTimeout(0, async () => 1)).rejects.toThrow(ValidationError);
    await expect(withTimeout(10_000_000, async () => 1)).rejects.toThrow("TIMEOUT_MS_INVALID");
  });
});

describe("retry", () => {
  it("[ACT-03] retry never retries UNKNOWN outcomes, even when marked retryable", async () => {
    const metrics = new InMemoryMetrics();
    let calls = 0;
    await expect(
      retry(
        async () => {
          calls += 1;
          throw new DependencyError("TIMEOUT", "UNKNOWN", true);
        },
        { dependency: "scheduling", maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100, sleep: noSleep, metrics },
      ),
    ).rejects.toMatchObject({ reasonCode: "TIMEOUT", outcome: "UNKNOWN" });
    expect(calls).toBe(1);
    expect(metrics.counterValue("vsp_retry_attempts_total", { dependency: "scheduling", result: "unknown_outcome_not_retried" })).toBe(1);
  });

  it("[ACT-02] retries NOT_STARTED failures up to the bound, then surfaces the error", async () => {
    let calls = 0;
    const delays: number[] = [];
    await expect(
      retry(
        async () => {
          calls += 1;
          throw new DependencyError("CONNECTION_REFUSED", "NOT_STARTED");
        },
        { dependency: "billing", maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000, random: () => 0.5, sleep: async (ms) => void delays.push(ms) },
      ),
    ).rejects.toMatchObject({ reasonCode: "CONNECTION_REFUSED" });
    expect(calls).toBe(3);
    expect(delays).toEqual([50, 100]);
  });

  it("[ACT-02] succeeds after a transient NOT_STARTED failure", async () => {
    let calls = 0;
    const metrics = new InMemoryMetrics();
    const v = await retry(
      async (attempt) => {
        calls += 1;
        if (attempt === 1) throw new DependencyError("HTTP_503", "NOT_STARTED");
        return "ok";
      },
      { dependency: "claims", maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1, sleep: noSleep, metrics },
    );
    expect(v).toBe("ok");
    expect(calls).toBe(2);
    expect(metrics.counterValue("vsp_retry_attempts_total", { result: "succeeded" })).toBe(1);
  });

  it("[ACT-03] does not retry unclassified errors, permanent failures, backpressure or caller errors", async () => {
    const cases: unknown[] = [
      new Error("socket hang up with dependency free text"),
      new DependencyError("HTTP_5XX", "FAILED"),
      new CircuitOpenError(),
      new DependencyError("BULKHEAD_FULL", "NOT_STARTED", false),
      new AccessDeniedError("POLICY_DENIED"),
    ];
    for (const err of cases) {
      let calls = 0;
      await expect(
        retry(
          async () => {
            calls += 1;
            throw err;
          },
          { dependency: "billing", maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1, sleep: noSleep },
        ),
      ).rejects.toBe(err);
      expect(calls).toBe(1);
    }
  });

  it("[SPEC-12.retries] retryOn restricts retries to listed reason codes", async () => {
    let calls = 0;
    await expect(
      retry(
        async () => {
          calls += 1;
          throw new DependencyError("CONNECTION_REFUSED", "NOT_STARTED");
        },
        { dependency: "billing", maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1, sleep: noSleep, retryOn: ["HTTP_429"] },
      ),
    ).rejects.toThrow("CONNECTION_REFUSED");
    expect(calls).toBe(1);
  });

  it("[SPEC-12.retries] nested retry wrappers are refused (no retries on top of retries)", async () => {
    const metrics = new InMemoryMetrics();
    let innerRan = false;
    let outerCalls = 0;
    await expect(
      retry(
        async () => {
          outerCalls += 1;
          expect(isRetryScopeActive()).toBe(true);
          return retry(
            async () => {
              innerRan = true;
              return 1;
            },
            { dependency: "salesforce", maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1, sleep: noSleep, metrics },
          );
        },
        { dependency: "scheduling", maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1, sleep: noSleep, metrics },
      ),
    ).rejects.toThrow(NestedRetryError);
    expect(innerRan).toBe(false);
    // NestedRetryError is not retryable, so the outer wrapper does not loop either.
    expect(outerCalls).toBe(1);
    expect(metrics.counterValue("vsp_nested_retry_refused_total", { dependency: "salesforce" })).toBe(1);
    expect(isRetryScopeActive()).toBe(false);
  });

  it("[SPEC-12.retries] sibling (non-nested) retries in parallel are allowed", async () => {
    const opts = { dependency: "billing", maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1, sleep: noSleep };
    const [a, b] = await Promise.all([retry(async () => "a", opts), retry(async () => "b", opts)]);
    expect([a, b]).toEqual(["a", "b"]);
  });

  it("[SPEC-12.retries] attempts are bounded and policies outside bounds are rejected", async () => {
    await expect(retry(async () => 1, { dependency: "x", maxAttempts: RETRY_MAX_ATTEMPTS + 1, baseDelayMs: 1, maxDelayMs: 1 })).rejects.toThrow("RETRY_POLICY_INVALID");
    await expect(retry(async () => 1, { dependency: "x", maxAttempts: 0, baseDelayMs: 1, maxDelayMs: 1 })).rejects.toThrow("RETRY_POLICY_INVALID");
    await expect(retry(async () => 1, { dependency: "x", maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 5 })).rejects.toThrow("RETRY_POLICY_INVALID");
  });

  it("[SPEC-12.retries] property: full-jitter delay is within [0, min(max, base*2^(n-1)))", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 6 }),
        fc.integer({ min: 0, max: 5000 }),
        fc.integer({ min: 0, max: 30_000 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (n, base, extra, r) => {
          const max = base + extra;
          const d = fullJitterDelay(n, base, max, () => r);
          const cap = Math.min(max, base * 2 ** (n - 1));
          expect(d).toBeGreaterThanOrEqual(0);
          expect(d).toBeLessThanOrEqual(cap);
          if (cap > 0) expect(d).toBeLessThan(cap + 1);
        },
      ),
    );
  });

  it("[SPEC-12.retries] maps a tool catalogue RetryPolicy", () => {
    const o = retryOptionsFromToolPolicy({ maxAttempts: 3, backoffMs: 200, jitter: true, retryOn: ["HTTP_429", "HTTP_503"] }, "billing");
    expect(o).toMatchObject({ dependency: "billing", maxAttempts: 3, baseDelayMs: 200, maxDelayMs: 800, retryOn: ["HTTP_429", "HTTP_503"] });
    expect(isSafeToRetry(new DependencyError("HTTP_503", "NOT_STARTED"), o.retryOn)).toBe(true);
    expect(isSafeToRetry(new DependencyError("HTTP_503", "UNKNOWN", true), o.retryOn)).toBe(false);
  });
});

const BREAKER: CircuitBreakerSettings = {
  windowMs: 10_000,
  minimumRequests: 4,
  failureRateThreshold: 0.5,
  cooldownMs: 30_000,
  halfOpenMaxProbes: 1,
  halfOpenSuccessesToClose: 2,
};
const fail = () => Promise.reject(new DependencyError("HTTP_5XX", "FAILED"));
const ok = () => Promise.resolve("ok");

describe("CircuitBreaker", () => {
  it("[SPEC-12.circuit-breakers] circuit breaker transitions closed → open → half-open → closed with FakeClock", async () => {
    const clock = new FakeClock();
    const metrics = new InMemoryMetrics();
    const b = new CircuitBreaker({ ...BREAKER, dependency: "salesforce", clock, metrics });
    expect(b.state()).toBe("closed");
    await b.execute(ok);
    await b.execute(ok);
    await expect(b.execute(fail)).rejects.toThrow("HTTP_5XX");
    expect(b.state()).toBe("closed"); // 1/3, below minimum requests
    await expect(b.execute(fail)).rejects.toThrow("HTTP_5XX");
    expect(b.state()).toBe("open"); // 2/4 = 50%
    let ran = false;
    await expect(
      b.execute(async () => {
        ran = true;
        return 1;
      }),
    ).rejects.toBeInstanceOf(CircuitOpenError);
    expect(ran).toBe(false);
    clock.advanceMs(29_999);
    expect(b.state()).toBe("open");
    clock.advanceMs(1);
    expect(b.state()).toBe("half_open");
    // only one concurrent probe
    const probe = deferred<string>();
    const p1 = b.execute(() => probe.promise);
    await expect(b.execute(ok)).rejects.toBeInstanceOf(CircuitOpenError);
    probe.resolve("ok");
    await p1;
    expect(b.state()).toBe("half_open");
    await b.execute(ok);
    expect(b.state()).toBe("closed");
    expect(metrics.counterValue("vsp_circuit_transitions_total", { dependency: "salesforce", circuit_state: "open" })).toBe(1);
    expect(metrics.counterValue("vsp_circuit_transitions_total", { dependency: "salesforce", circuit_state: "half_open" })).toBe(1);
    expect(metrics.counterValue("vsp_circuit_transitions_total", { dependency: "salesforce", circuit_state: "closed" })).toBe(1);
    expect(metrics.gaugeValue("vsp_dependency_health", { dependency: "salesforce", circuit_state: "closed" })).toBe(1);
    expect(metrics.gaugeValue("vsp_dependency_health", { dependency: "salesforce", circuit_state: "open" })).toBe(0);
  });

  it("[SPEC-12.circuit-breakers] a failed half-open probe re-opens the circuit and restarts the cooldown", async () => {
    const clock = new FakeClock();
    const b = new CircuitBreaker({ ...BREAKER, dependency: "billing", clock });
    b.trip();
    clock.advanceMs(30_000);
    await expect(b.execute(fail)).rejects.toThrow("HTTP_5XX");
    expect(b.state()).toBe("open");
    clock.advanceMs(29_000);
    expect(b.state()).toBe("open");
    clock.advanceMs(1_000);
    expect(b.state()).toBe("half_open");
  });

  it("[SPEC-12.circuit-breakers] failures outside the rolling window are forgotten", async () => {
    const clock = new FakeClock();
    const b = new CircuitBreaker({ ...BREAKER, dependency: "claims", clock });
    await expect(b.execute(fail)).rejects.toThrow();
    await expect(b.execute(fail)).rejects.toThrow();
    await expect(b.execute(fail)).rejects.toThrow();
    clock.advanceMs(10_001);
    await b.execute(ok);
    expect(b.snapshot()).toMatchObject({ state: "closed", windowRequests: 1, windowFailures: 0 });
  });

  it("[SPEC-12.circuit-breakers] caller-side and backpressure errors are neutral", async () => {
    const clock = new FakeClock();
    const b = new CircuitBreaker({ ...BREAKER, minimumRequests: 1, failureRateThreshold: 1, dependency: "billing", clock });
    await expect(b.execute(() => Promise.reject(new AccessDeniedError("POLICY_DENIED")))).rejects.toThrow();
    await expect(b.execute(() => Promise.reject(new DependencyError("BULKHEAD_FULL", "NOT_STARTED", false)))).rejects.toThrow();
    expect(b.state()).toBe("closed");
    expect(b.snapshot().windowRequests).toBe(0);
  });

  it("[SPEC-12.circuit-breakers] registry keeps one breaker per dependency with overrides", async () => {
    const clock = new FakeClock();
    const reg = new CircuitBreakerRegistry({ clock }, BREAKER, { salesforce: { cooldownMs: 5_000 } });
    expect(reg.get("salesforce")).toBe(reg.get("salesforce"));
    reg.get("salesforce").trip();
    reg.get("billing");
    expect(reg.openDependencies()).toEqual(["salesforce"]);
    clock.advanceMs(5_000);
    expect(reg.get("salesforce").state()).toBe("half_open");
    expect(() => new CircuitBreakerRegistry({ clock }, { ...BREAKER, failureRateThreshold: 0 })).toThrow("CIRCUIT_SETTINGS_INVALID");
  });
});

describe("Bulkhead", () => {
  it("[SPEC-12.bulkheads] bulkhead rejects overflow with BULKHEAD_FULL and admits queued work in order", async () => {
    const metrics = new InMemoryMetrics();
    const bh = new Bulkhead({ dependency: "scheduling", maxConcurrent: 2, maxQueue: 1, metrics });
    const gates = [deferred<number>(), deferred<number>(), deferred<number>()];
    const order: number[] = [];
    const p0 = bh.run(() => gates[0]!.promise.then((v) => (order.push(0), v)));
    const p1 = bh.run(() => gates[1]!.promise.then((v) => (order.push(1), v)));
    const p2 = bh.run(() => gates[2]!.promise.then((v) => (order.push(2), v)));
    await flush();
    expect(bh.active).toBe(2);
    expect(bh.queued).toBe(1);
    let overflowRan = false;
    await expect(
      bh.run(async () => {
        overflowRan = true;
        return 9;
      }),
    ).rejects.toMatchObject({ reasonCode: "BULKHEAD_FULL", outcome: "NOT_STARTED", retryable: false });
    expect(overflowRan).toBe(false);
    gates[0]!.resolve(0);
    await p0;
    await flush();
    expect(bh.queued).toBe(0);
    expect(bh.active).toBe(2);
    gates[2]!.resolve(2);
    gates[1]!.resolve(1);
    await Promise.all([p1, p2]);
    expect(bh.active).toBe(0);
    expect(metrics.counterValue("vsp_bulkhead_rejections_total", { dependency: "scheduling", reason: "BULKHEAD_FULL" })).toBe(1);
    expect(metrics.gaugeValue("vsp_bulkhead_active", { dependency: "scheduling" })).toBe(0);
  });

  it("[SPEC-12.bulkheads] queued calls time out or can be aborted without starting", async () => {
    const timers = new ManualTimers();
    const bh = new Bulkhead({ dependency: "billing", maxConcurrent: 1, maxQueue: 2, queueTimeoutMs: 500, timers });
    const hold = deferred<number>();
    const running = bh.run(() => hold.promise);
    const queuedTimeout = bh.run(async () => 1);
    const ac = new AbortController();
    const queuedAbort = bh.run(async () => 2, { signal: ac.signal });
    await flush();
    expect(bh.queued).toBe(2);
    ac.abort();
    await expect(queuedAbort).rejects.toMatchObject({ reasonCode: "CALLER_ABORTED", outcome: "NOT_STARTED" });
    timers.advance(500);
    await expect(queuedTimeout).rejects.toMatchObject({ reasonCode: "BULKHEAD_QUEUE_TIMEOUT", outcome: "NOT_STARTED" });
    hold.resolve(0);
    await running;
    expect(bh.active).toBe(0);
    expect(bh.queued).toBe(0);
  });

  it("[SPEC-12.bulkheads] property: concurrency never exceeds the limit", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 4 }), fc.integer({ min: 0, max: 6 }), fc.integer({ min: 1, max: 20 }), async (max, queue, n) => {
        const bh = new Bulkhead({ dependency: "billing", maxConcurrent: max, maxQueue: queue });
        let inFlight = 0;
        let peak = 0;
        const results = await Promise.allSettled(
          Array.from({ length: n }, () =>
            bh.run(async () => {
              inFlight += 1;
              peak = Math.max(peak, inFlight);
              await flush();
              inFlight -= 1;
            }),
          ),
        );
        expect(peak).toBeLessThanOrEqual(max);
        const fulfilled = results.filter((r) => r.status === "fulfilled").length;
        expect(fulfilled).toBe(Math.min(n, max + queue));
        expect(bh.active).toBe(0);
      }),
      { numRuns: 40 },
    );
  });
});

describe("callDependency composition", () => {
  it("[ACT-03] converts unclassified errors to UNKNOWN (never retried, no free text) and counts unknown commits", async () => {
    const clock = new FakeClock();
    const metrics = new InMemoryMetrics();
    let calls = 0;
    const err = await callDependency(
      { dependency: "scheduling", timeoutMs: 1000, idempotent: false, clock, metrics, retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1, sleep: noSleep } },
      async () => {
        calls += 1;
        throw new Error("upstream said: Avery Synthetic-Client not found");
      },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DependencyError);
    expect((err as DependencyError).outcome).toBe("UNKNOWN");
    expect((err as DependencyError).message).toBe("UNCLASSIFIED_ERROR");
    expect(calls).toBe(1);
    expect(metrics.counterValue("vsp_unknown_commits_total", { dependency: "scheduling" })).toBe(1);
    expect(metrics.counterValue("vsp_dependency_errors_total", { dependency: "scheduling", outcome: "UNKNOWN", reason: "UNCLASSIFIED_ERROR" })).toBe(1);
  });

  it("[SPEC-12.circuit-breakers] each attempt passes the breaker; an opened circuit stops further retries", async () => {
    const clock = new FakeClock();
    const breaker = new CircuitBreaker({ ...BREAKER, minimumRequests: 2, failureRateThreshold: 1, dependency: "billing", clock });
    let calls = 0;
    await expect(
      callDependency(
        { dependency: "billing", timeoutMs: 1000, idempotent: true, clock, breaker, retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1, sleep: noSleep } },
        async () => {
          calls += 1;
          throw new DependencyError("HTTP_503", "NOT_STARTED");
        },
      ),
    ).rejects.toBeInstanceOf(CircuitOpenError);
    expect(calls).toBe(2);
    expect(breaker.state()).toBe("open");
  });

  it("[SPEC-12.retries] a dependency call inside another retry wrapper is refused", async () => {
    const clock = new FakeClock();
    await expect(
      retry(
        () => callDependency({ dependency: "claims", timeoutMs: 100, idempotent: true, clock, retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1, sleep: noSleep } }, async () => 1),
        { dependency: "claims", maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1, sleep: noSleep },
      ),
    ).rejects.toThrow("NESTED_RETRY_REFUSED");
  });

  it("[SPEC-12.timeouts] succeeds through every layer and records latency", async () => {
    const clock = new FakeClock();
    const metrics = new InMemoryMetrics();
    const v = await callDependency(
      {
        dependency: "billing",
        timeoutMs: 1000,
        idempotent: true,
        clock,
        metrics,
        breaker: new CircuitBreaker({ ...BREAKER, dependency: "billing", clock }),
        bulkhead: new Bulkhead({ dependency: "billing", maxConcurrent: 1, maxQueue: 0 }),
        retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1, sleep: noSleep },
      },
      async (signal) => {
        expect(signal.aborted).toBe(false);
        clock.advanceMs(42);
        return "done";
      },
    );
    expect(v).toBe("done");
    expect(metrics.observations("vsp_dependency_latency_ms", { dependency: "billing", result: "success" })).toEqual([42]);
  });
});
