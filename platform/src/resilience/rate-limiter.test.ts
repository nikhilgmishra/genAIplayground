/**
 * Token bucket, vendor pause and Retry-After hints (WP-06; FO-06-07, FO-06-08; spec section 12 quotas).
 * Deterministic: FakeClock and a recording sleep that advances it.
 */
import { describe, expect, it } from "vitest";
import { FakeClock } from "../shared/clock.js";
import { DependencyError } from "../shared/errors.js";
import { TokenBucket, parseRetryAfter } from "./rate-limiter.js";
import { retry } from "./retry.js";

function bucket(o: Partial<ConstructorParameters<typeof TokenBucket>[0]> = {}) {
  const clock = new FakeClock(new Date("2026-10-19T12:00:00Z"));
  const waits: number[] = [];
  const b = new TokenBucket({
    dependency: "scheduling",
    ratePerSecond: 2,
    burst: 2,
    maxWaitMs: 5_000,
    clock,
    sleep: async (ms) => {
      waits.push(ms);
      clock.advanceMs(ms);
    },
    ...o,
  });
  return { b, clock, waits };
}

describe("TokenBucket [FO-06-07]", () => {
  it("[FO-06-07] allows the burst, then spaces requests at the sustained rate", async () => {
    const { b, waits } = bucket();
    for (let i = 0; i < 5; i += 1) await b.take();
    expect(waits).toEqual([500, 500, 500]);
  });

  it("[FO-06-07] refuses (NOT_STARTED, not retryable) instead of waiting longer than maxWaitMs; the refused request returns its token", async () => {
    const { b } = bucket({ burst: 1, ratePerSecond: 1, maxWaitMs: 1_500 });
    await b.take();
    const pending = b.take(); // waits 1 000 ms
    await pending;
    const { b: tight } = bucket({ burst: 1, ratePerSecond: 0.5, maxWaitMs: 1_000 });
    await tight.take();
    const e = (await tight.take().then(() => null, (x: unknown) => x)) as DependencyError;
    expect([e.reasonCode, e.outcome, e.retryable]).toEqual(["RATE_BUDGET_EXHAUSTED", "NOT_STARTED", false]);
    expect(tight.available()).toBeGreaterThanOrEqual(-0.0001);
  });

  it("[FO-06-07] a vendor pause (Retry-After) holds every caller until it ends and is never shortened", async () => {
    const { b, clock, waits } = bucket();
    b.pauseUntil(clock.now().getTime() + 3_000);
    b.pauseUntil(clock.now().getTime() + 1_000);
    await b.take();
    expect(waits).toEqual([3_000]);
    b.pauseUntil(clock.now().getTime() + 60_000);
    await expect(b.take()).rejects.toThrow("RATE_BUDGET_EXHAUSTED");
  });

  it("[FO-06-07] a vendor pause that arrives while a caller waits for its token holds that caller until the pause ends; beyond maxWaitMs it is refused and its token returned", async () => {
    const clock = new FakeClock(new Date("2026-10-19T12:00:00Z"));
    const start = clock.now().getTime();
    const waits: number[] = [];
    let onFirstSleep: (() => void) | null = null;
    const sleep = async (ms: number) => {
      waits.push(ms);
      const hook = onFirstSleep;
      onFirstSleep = null;
      hook?.(); // a Retry-After answered to another request lands while this caller sleeps
      clock.advanceMs(ms);
    };
    const b = new TokenBucket({ dependency: "scheduling", ratePerSecond: 1, burst: 1, maxWaitMs: 6_000, clock, sleep });
    await b.take();
    onFirstSleep = () => b.pauseUntil(start + 5_000);
    await b.take(); // queued for its token (1 000 ms), then held by the pause
    expect(waits).toEqual([1_000, 4_000]);
    expect(clock.now().getTime() - start).toBe(5_000);

    const tight = new TokenBucket({ dependency: "scheduling", ratePerSecond: 1, burst: 1, maxWaitMs: 3_000, clock, sleep });
    const t0 = clock.now().getTime();
    await tight.take();
    onFirstSleep = () => tight.pauseUntil(t0 + 60_000);
    waits.length = 0;
    const e = (await tight.take().then(() => null, (x: unknown) => x)) as DependencyError;
    expect([e.reasonCode, e.outcome, e.retryable, waits]).toEqual(["RATE_BUDGET_EXHAUSTED", "NOT_STARTED", false, [1_000]]);
    // The refused request's slot was returned: when the pause ends the bucket holds its full burst (one
    // token; zero if the refused slot were still reserved), so the next caller starts at the pause end.
    clock.advanceMs(t0 + 60_000 - clock.now().getTime());
    expect(tight.available()).toBeCloseTo(1, 5);
    waits.length = 0;
    await tight.take();
    expect(waits).toEqual([]);
  });

  it("[FO-06-07] a vendor pause re-spaces the callers already queued: after it ends they start 1/rate apart in their order, never together", async () => {
    const clock = new FakeClock(new Date("2026-10-19T12:00:00Z"));
    const t0 = clock.now().getTime();
    // Virtual time: pending sleeps resolve in wake-time order and move the clock to their wake time.
    const timers: { at: number; n: number; res: () => void }[] = [];
    let n = 0;
    const sleep = (ms: number) => new Promise<void>((res) => void timers.push({ at: clock.now().getTime() + ms, n: (n += 1), res }));
    const tick = () => new Promise<void>((r) => setTimeout(r, 0));
    const drain = async () => {
      for (let guard = 0; guard < 1_000 && timers.length > 0; guard += 1) {
        timers.sort((x, y) => x.at - y.at || x.n - y.n);
        const next = timers.shift();
        if (!next) break;
        if (next.at > clock.now().getTime()) clock.advanceMs(next.at - clock.now().getTime());
        next.res();
        await tick();
      }
    };
    const b = new TokenBucket({ dependency: "scheduling", ratePerSecond: 5, burst: 1, maxWaitMs: 10_000, clock, sleep });
    const released: { caller: number; at: number }[] = [];
    const calls = Array.from({ length: 10 }, (_, caller) => b.take().then(() => void released.push({ caller, at: clock.now().getTime() - t0 })));
    await tick();
    b.pauseUntil(t0 + 3_000); // a Retry-After of 3 s answered to the first request
    await drain();
    await Promise.all(calls);
    // Caller 0 had started; the nine queued callers start at the pause end and 200 ms apart, in order.
    expect(released).toEqual([0, 3_000, 3_200, 3_400, 3_600, 3_800, 4_000, 4_200, 4_400, 4_600].map((at, caller) => ({ caller, at })));
    // A caller arriving now queues behind them, one interval after the last.
    const late = b.take().then(() => clock.now().getTime() - t0);
    await drain();
    expect(await late).toBe(4_800);

    // A pause with nobody waiting: an idle bucket of burst 5 restarts with a burst of one at the pause end.
    const idle = new TokenBucket({ dependency: "scheduling", ratePerSecond: 5, burst: 5, maxWaitMs: 10_000, clock, sleep });
    const t1 = clock.now().getTime();
    idle.pauseUntil(t1 + 1_000);
    const after = Array.from({ length: 3 }, () => idle.take().then(() => clock.now().getTime() - t1));
    await tick();
    await drain();
    expect(await Promise.all(after)).toEqual([1_000, 1_200, 1_400]);
  });

  it("[FO-06-07] a caller that aborts while waiting returns its slot when it is the latest reservation", async () => {
    const { b, clock, waits } = bucket({ ratePerSecond: 1, burst: 1 });
    await b.take();
    const ac = new AbortController();
    const pending = b.take(ac.signal);
    ac.abort();
    const e = (await pending.then(() => null, (x: unknown) => x)) as DependencyError;
    expect([e.reasonCode, e.outcome, waits]).toEqual(["CALLER_ABORTED", "NOT_STARTED", [1_000]]);
    // The aborted caller's slot (due now) is free again: the next caller starts without waiting.
    const at = clock.now().getTime();
    await b.take();
    expect([waits, clock.now().getTime() - at]).toEqual([[1_000], 0]);
  });

  it("[FO-06-07] Retry-After parsing: delta seconds, HTTP-date, malformed and capped", () => {
    const now = new Date("2026-10-19T12:00:00Z");
    expect(parseRetryAfter("7", now)).toBe(7_000);
    expect(parseRetryAfter("Mon, 19 Oct 2026 12:00:30 GMT", now)).toBe(30_000);
    expect(parseRetryAfter("Mon, 19 Oct 2026 11:00:00 GMT", now)).toBe(0);
    expect(parseRetryAfter("soon", now)).toBeNull();
    expect(parseRetryAfter(undefined, now)).toBeNull();
    expect(parseRetryAfter("99999", now)).toBe(300_000);
  });
});

describe("retry with server-directed delay [FO-06-07][FO-06-08][ACT-03]", () => {
  it("[FO-06-07] a Retry-After hint lengthens the backoff; a hint above maxDelayMs ends the retries instead of being shortened", async () => {
    const slept: number[] = [];
    let calls = 0;
    const out = await retry(
      async () => {
        calls += 1;
        if (calls === 1) throw Object.assign(new DependencyError("HTTP_429", "NOT_STARTED", true), { retryAfterMs: 2_000 });
        return "ok";
      },
      { dependency: "scheduling", maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 5_000, random: () => 0, sleep: async (ms) => void slept.push(ms), delayFor: (e) => (e as { retryAfterMs?: number }).retryAfterMs ?? null },
    );
    expect([out, slept]).toEqual(["ok", [2_000]]);
    calls = 0;
    const e = await retry(
      async () => {
        calls += 1;
        throw Object.assign(new DependencyError("HTTP_503", "NOT_STARTED", true), { retryAfterMs: 60_000 });
      },
      { dependency: "scheduling", maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 5_000, sleep: async () => undefined, delayFor: (x) => (x as { retryAfterMs?: number }).retryAfterMs ?? null },
    ).catch((x: unknown) => x as DependencyError);
    expect([e.reasonCode, calls]).toEqual(["HTTP_503", 1]);
  });

  it("[ACT-03] an UNKNOWN outcome is never retried, whatever hint it carries", async () => {
    let calls = 0;
    await expect(
      retry(
        async () => {
          calls += 1;
          throw Object.assign(new DependencyError("TIMEOUT_AFTER_SEND", "UNKNOWN", false), { retryAfterMs: 1 });
        },
        { dependency: "scheduling", maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 10, delayFor: () => 1 },
      ),
    ).rejects.toThrow("TIMEOUT_AFTER_SEND");
    expect(calls).toBe(1);
  });
});
