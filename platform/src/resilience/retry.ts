/**
 * Bounded retry with full jitter (spec section 12: bounded retries with jitter,
 * avoid retries on top of retries).
 *
 * - At most RETRY_MAX_ATTEMPTS total attempts (aligned with the protocol's tool
 *   RetryPolicy maximum of 3).
 * - Full jitter: delay = random() * min(maxDelayMs, baseDelayMs * 2^(retry-1)).
 * - Only errors classified safe are retried (see classify.ts). UNKNOWN commit
 *   outcomes are never retried: they need reconciliation first (ACT-03).
 * - No nested retries: entering a retry wrapper while another retry wrapper is
 *   active in the same async call chain throws NestedRetryError before doing any
 *   work, so retries cannot multiply (3 x 3 x 3 ...).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { DependencyError, PlatformError, ValidationError } from "../shared/errors.js";
import type { RetryPolicy } from "../protocol/index.js";
import type { Metrics } from "../observability/ports.js";
import { isSafeToRetry } from "./classify.js";

export const RETRY_MAX_ATTEMPTS = 3;
export const RETRY_MAX_DELAY_MS = 30_000;

export class NestedRetryError extends PlatformError {
  constructor() {
    super("NESTED_RETRY_REFUSED");
  }
}

export interface RetryOptions {
  dependency: string;
  /** Total attempts including the first (1..RETRY_MAX_ATTEMPTS). */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Optional reason-code allowlist (tool RetryPolicy.retryOn). */
  retryOn?: readonly string[];
  /** Injectable randomness in [0, 1) for deterministic tests. */
  random?: () => number;
  /** Injectable sleep for deterministic tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  metrics?: Metrics;
  signal?: AbortSignal;
}

const scope = new AsyncLocalStorage<{ dependency: string }>();

/** True when called (directly or transitively) from inside an active retry wrapper. */
export function isRetryScopeActive(): boolean {
  return scope.getStore() !== undefined;
}

export const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (ms <= 0 || signal?.aborted) return resolve();
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/** Full-jitter delay for the given retry number (1 = first retry). */
export function fullJitterDelay(retryNumber: number, baseDelayMs: number, maxDelayMs: number, random: () => number): number {
  const cap = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, retryNumber - 1));
  const r = random();
  const unit = Number.isFinite(r) ? Math.min(Math.max(r, 0), 1 - Number.EPSILON) : 0;
  return Math.floor(unit * cap);
}

function validate(opts: RetryOptions): void {
  const ok =
    Number.isInteger(opts.maxAttempts) &&
    opts.maxAttempts >= 1 &&
    opts.maxAttempts <= RETRY_MAX_ATTEMPTS &&
    Number.isFinite(opts.baseDelayMs) &&
    opts.baseDelayMs >= 0 &&
    Number.isFinite(opts.maxDelayMs) &&
    opts.maxDelayMs >= opts.baseDelayMs &&
    opts.maxDelayMs <= RETRY_MAX_DELAY_MS;
  if (!ok) throw new ValidationError("RETRY_POLICY_INVALID");
}

export async function retry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<T> {
  validate(opts);
  if (isRetryScopeActive()) {
    opts.metrics?.increment("vsp_nested_retry_refused_total", { dependency: opts.dependency });
    throw new NestedRetryError();
  }
  const random = opts.random ?? Math.random;
  const sleep = opts.sleep ?? defaultSleep;
  const m = opts.metrics;
  const labels = (result: string) => ({ dependency: opts.dependency, result });

  return scope.run({ dependency: opts.dependency }, async () => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        const value = await fn(attempt);
        if (attempt > 1) m?.increment("vsp_retry_attempts_total", labels("succeeded"));
        return value;
      } catch (err) {
        if (err instanceof DependencyError && err.outcome === "UNKNOWN") {
          m?.increment("vsp_retry_attempts_total", labels("unknown_outcome_not_retried"));
          throw err;
        }
        if (!isSafeToRetry(err, opts.retryOn)) {
          m?.increment("vsp_retry_attempts_total", labels("not_retryable"));
          throw err;
        }
        if (attempt >= opts.maxAttempts || opts.signal?.aborted) {
          m?.increment("vsp_retry_attempts_total", labels("exhausted"));
          throw err;
        }
        m?.increment("vsp_retry_attempts_total", labels("retry_scheduled"));
        await sleep(fullJitterDelay(attempt, opts.baseDelayMs, opts.maxDelayMs, random), opts.signal);
        if (opts.signal?.aborted) {
          m?.increment("vsp_retry_attempts_total", labels("exhausted"));
          throw err;
        }
      }
    }
  });
}

/** Maps a tool catalogue RetryPolicy onto retry options. jitter:false keeps a fixed backoff. */
export function retryOptionsFromToolPolicy(
  policy: RetryPolicy,
  dependency: string,
  deps: Pick<RetryOptions, "random" | "sleep" | "metrics" | "signal"> = {},
): RetryOptions {
  return {
    dependency,
    maxAttempts: Math.min(policy.maxAttempts, RETRY_MAX_ATTEMPTS),
    baseDelayMs: policy.backoffMs,
    maxDelayMs: Math.min(RETRY_MAX_DELAY_MS, Math.max(policy.backoffMs, policy.backoffMs * 2 ** (RETRY_MAX_ATTEMPTS - 1))),
    retryOn: policy.retryOn,
    ...deps,
    ...(policy.jitter ? {} : { random: () => 1 - Number.EPSILON }),
  };
}
