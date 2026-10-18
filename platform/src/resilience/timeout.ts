/**
 * AbortSignal-aware timeout wrapper.
 *
 * A timed-out call may still have reached the dependency, so by default the
 * timeout is reported as outcome UNKNOWN and is not retryable (ACT-03). Only an
 * operation the caller declares `idempotent` (a read with no side effects) is
 * reported as FAILED + retryable on timeout.
 */
import { DependencyError, ValidationError } from "../shared/errors.js";
import type { Metrics } from "../observability/ports.js";

export interface TimerPort {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemTimers: TimerPort = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export const MAX_TIMEOUT_MS = 600_000;

export interface TimeoutOptions {
  /** Dependency id used for metrics (allowlisted label; unknown ids become "other"). */
  dependency?: string;
  /** Caller cancellation (e.g. barge-in, call ended). */
  signal?: AbortSignal;
  /** The operation has no side effects, so a timeout is a definite, retryable failure. */
  idempotent?: boolean;
  timers?: TimerPort;
  metrics?: Metrics;
}

export async function withTimeout<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>, opts: TimeoutOptions = {}): Promise<T> {
  if (!Number.isInteger(ms) || ms < 1 || ms > MAX_TIMEOUT_MS) throw new ValidationError("TIMEOUT_MS_INVALID");
  if (opts.signal?.aborted) throw new DependencyError("CALLER_ABORTED", "NOT_STARTED", false);
  const timers = opts.timers ?? systemTimers;
  const controller = new AbortController();

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (fnSettle: () => void) => {
      if (settled) return;
      settled = true;
      timers.clearTimeout(handle);
      opts.signal?.removeEventListener("abort", onParentAbort);
      fnSettle();
    };
    const onParentAbort = () => {
      controller.abort();
      // The operation was already started: its effect is unknown.
      finish(() => reject(new DependencyError("CALLER_ABORTED", "UNKNOWN", false)));
    };
    const handle = timers.setTimeout(() => {
      controller.abort();
      opts.metrics?.increment("vsp_timeouts_total", { dependency: opts.dependency ?? "unknown" });
      finish(() =>
        reject(opts.idempotent ? new DependencyError("TIMEOUT", "FAILED", true) : new DependencyError("TIMEOUT", "UNKNOWN", false)),
      );
    }, ms);
    opts.signal?.addEventListener("abort", onParentAbort, { once: true });

    let p: Promise<T>;
    try {
      p = fn(controller.signal);
    } catch (err) {
      finish(() => reject(err));
      return;
    }
    p.then(
      (v) => finish(() => resolve(v)),
      (err: unknown) => finish(() => reject(err)),
    );
  });
}
