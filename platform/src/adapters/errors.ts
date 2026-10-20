/**
 * Adapter error types shared by LOCAL fixtures, documented live adapters and
 * BLOCKED stubs.
 *
 * Messages are reason codes only. Dependency response bodies, record values and
 * identifiers supplied by callers never appear in an error (spec section 6,
 * ARCHITECTURE section 3).
 *
 * Reason codes deliberately align with `RetryPolicy.retryOn` in
 * platform/src/protocol/tools.ts ("TIMEOUT_BEFORE_SEND", "CONNECTION_REFUSED",
 * "HTTP_429", "HTTP_503") so the resilience module can restrict retries to them.
 */
import { DependencyError, PlatformError } from "../shared/errors.js";

/** Reason code thrown by every capability whose vendor API or tenant evidence is missing (OPS-03). */
export const BLOCKED_CAPABILITY_UNVERIFIED = "BLOCKED_CAPABILITY_UNVERIFIED";

/** Reason codes produced by adapters for dependency failures. */
export const ADAPTER_REASON = {
  /** Connection refused / dependency down: the request provably never reached it. */
  CONNECTION_REFUSED: "CONNECTION_REFUSED",
  /** Timed out before the request was sent: nothing can have happened. */
  TIMEOUT_BEFORE_SEND: "TIMEOUT_BEFORE_SEND",
  /** Timed out after the request was sent: the effect may or may not exist (ACT-03). */
  TIMEOUT_AFTER_SEND: "TIMEOUT_AFTER_SEND",
  /** Read timed out; reads have no side effect. */
  READ_TIMEOUT: "READ_TIMEOUT",
  /** Quota or rate limit (HTTP 429): rejected before processing. */
  HTTP_429: "HTTP_429",
  /** Service unavailable (HTTP 503): rejected before processing. */
  HTTP_503: "HTTP_503",
  /** The dependency definitely refused the request; nothing was applied. */
  DEPENDENCY_REJECTED: "DEPENDENCY_REJECTED",
  /** Part of a multi-step write was applied; reconcile before retry (ACT-03). */
  PARTIAL_WRITE: "PARTIAL_WRITE",
} as const;

export interface AdapterDependencyErrorDetails {
  integrationId: string;
  operation: string;
  httpStatus?: number | null;
  /** Server-suggested delay before a retry, when the dependency supplied one. */
  retryAfterMs?: number | null;
  /** True when produced by the LOCAL FIXTURE fault injector rather than a real dependency. */
  injected?: boolean;
  /** Overrides the default (retryable only when outcome is NOT_STARTED). */
  retryable?: boolean;
}

/**
 * DependencyError with the integration and operation attached so circuit
 * breakers, kill switches and budgets can attribute it. `outcome` keeps the
 * shared semantics: NOT_STARTED (provably no effect), FAILED (definite failure,
 * no effect), UNKNOWN (may have had an effect; reconcile first).
 */
export class AdapterDependencyError extends DependencyError {
  readonly integrationId: string;
  readonly operation: string;
  readonly httpStatus: number | null;
  readonly retryAfterMs: number | null;
  readonly injected: boolean;

  constructor(reasonCode: string, outcome: "NOT_STARTED" | "FAILED" | "UNKNOWN", details: AdapterDependencyErrorDetails) {
    super(reasonCode, outcome, details.retryable ?? outcome === "NOT_STARTED");
    this.integrationId = details.integrationId;
    this.operation = details.operation;
    this.httpStatus = details.httpStatus ?? null;
    this.retryAfterMs = details.retryAfterMs ?? null;
    this.injected = details.injected ?? false;
  }
}

/**
 * Typed refusal reasons of operations an adapter will not perform (follow-on FO-06-25):
 *  - UNSUPPORTED_UNDOCUMENTED: the vendor behaviour is not documented (or the tenant evidence that
 *    would document it is missing), so it is unsupported ON PURPOSE and fails closed; a documented
 *    reference integration and an operator capability test replace it, never a success stub;
 *  - NOT_IMPLEMENTED: the behaviour IS documented but not built yet. A live composition must contain
 *    none: the live-registry scan (AdapterRegistry.liveCompositionRefusals, run by the composition root
 *    of WP-07) refuses any NOT_IMPLEMENTED operation outside local/ci.
 */
export const UNSUPPORTED_UNDOCUMENTED = "UNSUPPORTED_UNDOCUMENTED";
export const NOT_IMPLEMENTED = "NOT_IMPLEMENTED";
export type RefusalReason = typeof UNSUPPORTED_UNDOCUMENTED | typeof NOT_IMPLEMENTED;
export const REFUSAL_REASONS: readonly RefusalReason[] = [UNSUPPORTED_UNDOCUMENTED, NOT_IMPLEMENTED];

/**
 * Thrown by every method of a BLOCKED live stub. The capability is not
 * simulated as production success (spec section 16): it fails closed with
 * reason code BLOCKED_CAPABILITY_UNVERIFIED and names the prerequisites whose
 * evidence would unblock it. `refusal` says why it is blocked (default
 * UNSUPPORTED_UNDOCUMENTED: no documented API or tenant evidence exists).
 */
export class BlockedCapabilityError extends PlatformError {
  constructor(
    readonly integrationId: string,
    readonly operation: string,
    readonly prerequisites: readonly string[],
    readonly refusal: RefusalReason = UNSUPPORTED_UNDOCUMENTED,
  ) {
    super(BLOCKED_CAPABILITY_UNVERIFIED, BLOCKED_CAPABILITY_UNVERIFIED, false);
  }
}

/** Documented vendor behaviour that this adapter does not build yet (refused in live compositions). */
export class NotImplementedOperationError extends PlatformError {
  readonly refusal = NOT_IMPLEMENTED;
  constructor(
    readonly integrationId: string,
    readonly operation: string,
  ) {
    super(NOT_IMPLEMENTED, NOT_IMPLEMENTED, false);
  }
}

/** Undocumented vendor behaviour: deliberately unsupported, fails closed (never simulated). */
export class UnsupportedOperationError extends PlatformError {
  readonly refusal = UNSUPPORTED_UNDOCUMENTED;
  constructor(
    readonly integrationId: string,
    readonly operation: string,
  ) {
    super(UNSUPPORTED_UNDOCUMENTED, UNSUPPORTED_UNDOCUMENTED, false);
  }
}

/** The typed refusal reason of an error, or null when the error is not a refusal. */
export function refusalOf(err: unknown): RefusalReason | null {
  if (err instanceof BlockedCapabilityError || err instanceof NotImplementedOperationError || err instanceof UnsupportedOperationError) return err.refusal;
  return null;
}

/** Marker implemented by live stubs whose capability is BLOCKED; read by the adapter registry. */
export interface BlockedCapability {
  readonly capabilityStatus: "BLOCKED";
  /** PRQ ids from docs/prerequisites.yaml whose evidence is required. */
  readonly prerequisites: readonly string[];
}

/** Optional declaration of the operations an adapter refuses and why (read by the adapter registry). */
export interface DeclaresRefusals {
  readonly refusals: Readonly<Record<string, RefusalReason>>;
}

export function isBlockedCapability(value: unknown): value is BlockedCapability {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { capabilityStatus?: unknown }).capabilityStatus === "BLOCKED" &&
    Array.isArray((value as { prerequisites?: unknown }).prerequisites)
  );
}
