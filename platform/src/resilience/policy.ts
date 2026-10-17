/**
 * Composition of the resilience primitives for one dependency call:
 *
 *   retry (outermost, at most once per call chain)
 *     └─ circuit breaker (each attempt counted; open circuit fails fast, not retried)
 *          └─ bulkhead (bounded concurrency + queue; overflow rejected)
 *               └─ timeout (AbortSignal passed to the operation)
 *                    └─ operation
 *
 * Anything the operation throws that is not a typed platform error is converted
 * into DependencyError("UNCLASSIFIED_ERROR", "UNKNOWN") so dependency free text
 * never propagates and an unclassified failure is never retried.
 */
import type { Metrics } from "../observability/ports.js";
import type { Clock } from "../shared/clock.js";
import type { Bulkhead } from "./bulkhead.js";
import type { CircuitBreaker } from "./circuit-breaker.js";
import { outcomeOf, reasonCodeOf, toDependencyError } from "./classify.js";
import { retry } from "./retry.js";
import type { RetryOptions } from "./retry.js";
import { withTimeout } from "./timeout.js";
import type { TimerPort } from "./timeout.js";

export interface DependencyCallPolicy {
  dependency: string;
  timeoutMs: number;
  /** The operation has no side effects; timeouts become retryable FAILED instead of UNKNOWN. */
  idempotent: boolean;
  /** Omit or null for no retries (consequential commits rely on reconciliation instead). */
  retry?: Omit<RetryOptions, "dependency" | "metrics" | "signal"> | null;
  breaker?: CircuitBreaker;
  bulkhead?: Bulkhead;
  metrics?: Metrics;
  clock: Clock;
  timers?: TimerPort;
}

export async function callDependency<T>(policy: DependencyCallPolicy, op: (signal: AbortSignal) => Promise<T>, opts: { signal?: AbortSignal } = {}): Promise<T> {
  const m = policy.metrics;
  const attemptOnce = async (): Promise<T> => {
    const started = policy.clock.now().getTime();
    const guarded = () =>
      withTimeout(
        policy.timeoutMs,
        async (signal) => {
          try {
            return await op(signal);
          } catch (err) {
            throw toDependencyError(err);
          }
        },
        { dependency: policy.dependency, signal: opts.signal, idempotent: policy.idempotent, timers: policy.timers, metrics: m },
      );
    const bulkheaded = () => (policy.bulkhead ? policy.bulkhead.run(guarded, { signal: opts.signal }) : guarded());
    try {
      const v = await (policy.breaker ? policy.breaker.execute(bulkheaded) : bulkheaded());
      m?.observe("vsp_dependency_latency_ms", Math.max(0, policy.clock.now().getTime() - started), { dependency: policy.dependency, result: "success" });
      return v;
    } catch (err) {
      const e = toDependencyError(err);
      m?.observe("vsp_dependency_latency_ms", Math.max(0, policy.clock.now().getTime() - started), { dependency: policy.dependency, result: "failure" });
      m?.increment("vsp_dependency_errors_total", { dependency: policy.dependency, outcome: outcomeOf(e), reason: reasonCodeOf(e) });
      if (outcomeOf(e) === "UNKNOWN") m?.increment("vsp_unknown_commits_total", { dependency: policy.dependency });
      throw e;
    }
  };
  if (!policy.retry) return attemptOnce();
  return retry(() => attemptOnce(), { ...policy.retry, dependency: policy.dependency, metrics: m, signal: opts.signal });
}
