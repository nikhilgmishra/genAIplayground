/**
 * Error classification shared by the resilience primitives.
 *
 * The commit outcome of a failed dependency call decides what may happen next
 * (spec section 8, ACT-02, ACT-03):
 *  - NOT_STARTED: the request provably never reached the dependency. Safe to retry
 *    unless the error explicitly says otherwise (circuit open, bulkhead full: those
 *    are backpressure signals and are deliberately not retryable).
 *  - FAILED: the dependency answered with a definite failure. Retried only when the
 *    error is explicitly marked retryable (e.g. HTTP 503 with no side effect).
 *  - UNKNOWN: the request may have had an effect. NEVER retried here; it must be
 *    reconciled by idempotency key or authoritative state first.
 * Errors that are not typed platform errors are unclassified and never retried.
 */
import { DependencyError, PlatformError } from "../shared/errors.js";

export type CommitOutcome = "NOT_STARTED" | "FAILED" | "UNKNOWN";

export function outcomeOf(err: unknown): CommitOutcome {
  if (err instanceof DependencyError) return err.outcome;
  return "UNKNOWN";
}

export function reasonCodeOf(err: unknown): string {
  return err instanceof PlatformError ? err.reasonCode : "UNCLASSIFIED_ERROR";
}

/**
 * True only for errors that are classified safe to retry. `retryOn`, when given,
 * additionally restricts retries to the listed reason codes (tool RetryPolicy).
 */
export function isSafeToRetry(err: unknown, retryOn?: readonly string[]): boolean {
  if (!(err instanceof PlatformError)) return false;
  if (err instanceof DependencyError && err.outcome === "UNKNOWN") return false;
  if (!err.retryable) return false;
  if (retryOn && !retryOn.includes(err.reasonCode)) return false;
  return true;
}

/**
 * Normalizes anything thrown by dependency client code into a DependencyError
 * whose message is a reason code only (dependency free text can carry PHI).
 * Unclassified errors are treated as UNKNOWN outcome: we cannot prove no effect.
 */
export function toDependencyError(err: unknown): PlatformError {
  if (err instanceof PlatformError) return err;
  return new DependencyError("UNCLASSIFIED_ERROR", "UNKNOWN", false);
}
