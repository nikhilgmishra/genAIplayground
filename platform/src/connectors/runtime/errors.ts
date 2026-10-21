/**
 * Typed errors of the connector runtime (WP-06). Reason codes only (DATA-01); `outcome` keeps the
 * platform's commit semantics so the resilience primitives classify them like every other dependency:
 *   NOT_STARTED  provably no effect (refused before I/O, throttled, connection refused, 429 / 503)
 *   FAILED       definite failure, no effect (rejected request, forbidden, drift, read failure)
 *   UNKNOWN      a write may have taken effect: reconcile before any retry or success claim (ACT-03)
 * Structurally compatible with AdapterDependencyError (integrationId, operation, httpStatus,
 * retryAfterMs), which the gateway pipeline and tools read by shape.
 */
import { DependencyError, PlatformError } from "../../shared/errors.js";

export class ConnectorError extends DependencyError {
  readonly httpStatus: number | null;
  readonly retryAfterMs: number | null;

  constructor(
    reasonCode: string,
    outcome: "NOT_STARTED" | "FAILED" | "UNKNOWN",
    readonly integrationId: string,
    readonly operation: string,
    opts: { retryable?: boolean; httpStatus?: number | null; retryAfterMs?: number | null } = {},
  ) {
    super(reasonCode, outcome, opts.retryable ?? outcome === "NOT_STARTED");
    this.httpStatus = opts.httpStatus ?? null;
    this.retryAfterMs = opts.retryAfterMs ?? null;
  }
}

/** The operation is not in the reviewed profile: a model or caller cannot invent an operation. */
export const OPERATION_NOT_DECLARED = "OPERATION_NOT_DECLARED";
/** The operation is declared but disabled in the profile: refused before any I/O (FO-06-15). */
export const OPERATION_NOT_ENABLED = "OPERATION_NOT_ENABLED";

/**
 * The runtime refused an operation before any request existed: not declared, not enabled, a scope or
 * capability credential the profile does not grant, a write on a read-only profile, a template value
 * that does not satisfy the reviewed parameter types. Never retryable: the same call is refused again.
 */
export class ConnectorRefusal extends PlatformError {
  constructor(
    reasonCode: string,
    readonly integrationId: string,
    readonly operation: string,
  ) {
    super(reasonCode, reasonCode, false);
  }
}
