/**
 * Token-bucket rate limiter with a vendor pause (spec section 12 quotas; follow-on FO-06-07).
 *
 * A connector's request rate is held under its declared budget BEFORE the vendor has to say 429. The
 * bucket is kept as a schedule (GCRA, equivalent to a token bucket of `burst` tokens refilled at
 * `ratePerSecond`): `take()` reserves the next start slot in FIFO order and waits until it is due, or
 * refuses with RATE_BUDGET_EXHAUSTED (NOT_STARTED, not retryable: backpressure propagates) when the wait
 * would exceed `maxWaitMs`, reserving nothing.
 *
 * `pauseUntil()` records a vendor Retry-After. No request starts before that instant, and the schedule
 * restarts at the pause end with a burst of ONE: the callers already waiting keep their order and are
 * re-spaced at the sustained rate from the pause end (1/rate apart), and later callers queue behind them.
 * Without that, every caller whose slot fell inside the pause would start at the same instant when it
 * ends, a burst sent right after the vendor asked to back off. Burst capacity comes back only as the
 * bucket idles again. A pause is never shortened by a later, shorter one.
 *
 * A reserved slot whose request never starts (the caller aborts, or a pause moves its slot beyond its
 * `maxWaitMs`) is returned when it is the latest reservation; otherwise it is left empty, which is never
 * faster than the budget. Time comes from the injected Clock; waiting uses the injected sleep, so tests
 * are deterministic.
 */
import type { Clock } from "../shared/clock.js";
import { DependencyError, ValidationError } from "../shared/errors.js";
import type { Metrics } from "../observability/ports.js";
import { defaultSleep } from "./retry.js";

export interface TokenBucketOptions {
  dependency: string;
  /** Sustained rate (tokens per second), > 0. */
  ratePerSecond: number;
  /** Bucket size: requests that may start back to back after an idle period. */
  burst: number;
  /** Longest a caller may wait for its token (or for a vendor pause to end). */
  maxWaitMs: number;
  clock: Clock;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  metrics?: Metrics;
}

/** A caller holding a reserved start slot that is not due yet. */
interface Reservation {
  /** Epoch ms at which the request may start; only ever moved later (by a vendor pause). */
  startAt: number;
  /** Reservation order (the latest reservation can be returned exactly). */
  readonly seq: number;
  /** A vendor pause moved the slot since the caller last looked (metrics). */
  moved: boolean;
}

export class TokenBucket {
  /** Milliseconds between starts at the sustained rate. */
  private readonly intervalMs: number;
  /** How far ahead of the schedule a start may be: (burst - 1) intervals. */
  private readonly toleranceMs: number;
  /** Theoretical arrival time: the next reservation starts at max(now, tat - tolerance). */
  private tat: number;
  private pausedUntilMs = 0;
  private seq = 0;
  /** Reservations not yet due, in reservation (FIFO) order. */
  private readonly waiting: Reservation[] = [];
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(private readonly opts: TokenBucketOptions) {
    const ok =
      Number.isFinite(opts.ratePerSecond) &&
      opts.ratePerSecond > 0 &&
      opts.ratePerSecond <= 100_000 &&
      Number.isInteger(opts.burst) &&
      opts.burst >= 1 &&
      opts.burst <= 100_000 &&
      Number.isInteger(opts.maxWaitMs) &&
      opts.maxWaitMs >= 0 &&
      opts.maxWaitMs <= 600_000;
    if (!ok) throw new ValidationError("TOKEN_BUCKET_SETTINGS_INVALID");
    this.intervalMs = 1_000 / opts.ratePerSecond;
    this.toleranceMs = (opts.burst - 1) * this.intervalMs;
    this.tat = opts.clock.now().getTime();
    this.sleep = opts.sleep ?? defaultSleep;
  }

  /** Instant (epoch ms) before which no request may start because the vendor asked to back off. */
  get pausedUntil(): number {
    return this.pausedUntilMs;
  }

  /** Tokens available now: at most `burst`; zero or negative while reservations or a vendor pause hold callers. */
  available(): number {
    const now = this.opts.clock.now().getTime();
    return Math.min(this.opts.burst, 1 + (now + this.toleranceMs - this.tat) / this.intervalMs);
  }

  /**
   * Vendor backoff (Retry-After): later instants extend the pause, earlier ones never shorten it. The
   * callers already waiting are re-spaced at the sustained rate from the pause end, in their order.
   */
  pauseUntil(epochMs: number): void {
    if (!Number.isFinite(epochMs) || epochMs <= this.pausedUntilMs) return;
    this.pausedUntilMs = epochMs;
    let next = epochMs; // a burst of one at the pause end
    for (const r of this.waiting) {
      if (r.startAt < next) {
        r.startAt = next;
        r.moved = true;
      }
      next = r.startAt + this.intervalMs;
    }
    // The next reservation starts one interval after the last waiting one (or at the pause end).
    this.tat = Math.max(this.tat, next + this.toleranceMs);
  }

  /**
   * Reserves the next start slot and resolves when the request may start. A vendor pause recorded while
   * the caller waits (a Retry-After answered to another request) moves its slot behind the pause, spaced
   * from the callers ahead of it; the whole wait stays within `maxWaitMs` of the call
   * (RATE_BUDGET_EXHAUSTED otherwise, with the slot returned).
   */
  async take(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new DependencyError("CALLER_ABORTED", "NOT_STARTED", false);
    const now = this.opts.clock.now().getTime();
    const deadline = now + this.opts.maxWaitMs;
    const startAt = Math.max(now, this.tat - this.toleranceMs);
    const reason = this.pausedUntilMs > now ? "vendor_pause" : "budget";
    if (startAt - now > this.opts.maxWaitMs) {
      this.count("vsp_rate_limit_rejections_total", reason); // nothing reserved: the request never starts
      throw new DependencyError("RATE_BUDGET_EXHAUSTED", "NOT_STARTED", false);
    }
    this.tat = Math.max(this.tat, now) + this.intervalMs;
    this.seq += 1;
    if (startAt <= now) return;
    const r: Reservation = { startAt, seq: this.seq, moved: false };
    this.waiting.push(r);
    this.count("vsp_rate_limit_waits_total", reason);
    try {
      for (;;) {
        const t = this.opts.clock.now().getTime();
        if (r.startAt <= t) return;
        if (r.startAt > deadline) {
          this.giveBack(r);
          this.count("vsp_rate_limit_rejections_total", "vendor_pause");
          throw new DependencyError("RATE_BUDGET_EXHAUSTED", "NOT_STARTED", false);
        }
        if (r.moved) {
          r.moved = false;
          this.count("vsp_rate_limit_waits_total", "vendor_pause");
        }
        try {
          await this.sleep(r.startAt - t, signal);
        } catch (e) {
          this.giveBack(r);
          throw e;
        }
        if (signal?.aborted) {
          this.giveBack(r);
          throw new DependencyError("CALLER_ABORTED", "NOT_STARTED", false);
        }
      }
    } finally {
      const i = this.waiting.indexOf(r);
      if (i >= 0) this.waiting.splice(i, 1);
    }
  }

  /**
   * Returns the slot of a request that never starts. Only the latest reservation can be returned exactly
   * (the schedule moves back one interval, never before the pause end); an earlier one leaves a gap,
   * because the callers behind it already hold their slots.
   */
  private giveBack(r: Reservation): void {
    if (r.seq !== this.seq) return;
    this.tat = Math.max(this.tat - this.intervalMs, this.pausedUntilMs + this.toleranceMs);
  }

  private count(name: string, reason: string): void {
    try {
      this.opts.metrics?.increment(name, { dependency: this.opts.dependency, reason });
    } catch {
      // Declared by the connector metric catalogue (platform/src/observability/catalog/connectors.ts); a
      // catalogue without it never changes whether a request is admitted.
    }
  }
}

/**
 * Parses an HTTP Retry-After value (RFC 9110 section 10.2.3: delay-seconds or an HTTP-date) into a delay
 * in milliseconds from `now`; null when absent or malformed; capped at `capMs`.
 */
export function parseRetryAfter(value: string | null | undefined, now: Date, capMs = 300_000): number | null {
  if (value === null || value === undefined) return null;
  const v = value.trim();
  if (/^\d{1,7}$/.test(v)) return Math.min(Number(v) * 1000, capMs);
  if (v.length > 64 || !/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(v)) return null;
  const t = Date.parse(v);
  if (!Number.isFinite(t)) return null;
  return Math.min(Math.max(0, t - now.getTime()), capMs);
}
