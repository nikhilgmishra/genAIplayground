/**
 * Typed model-call failure (WP-08; FO-09-09, FO-09-45). Adapters throw it for every failure the resilience layer acts
 * on (overload, server error, timeout, cancellation, transport failure); the ResilientModelPort turns it into the
 * typed ModelResult. It is a DependencyError, so callDependency's breaker, bulkhead, timeout and retry classify it the
 * platform way: model inference has no vendor-side effect (requests are sent with provider storage off), so an
 * exchange that failed after it was sent is FAILED, never UNKNOWN; whether it is retried is decided by `retryable`
 * and the retry allowlist, never by the outcome alone.
 *
 * Reason codes only: provider messages never reach a log, a metric or a result (DATA-01).
 */
import { DependencyError } from "../../shared/errors.js";
import type { ModelErrorClass, ProviderDetail } from "./types.js";

export type ModelFailureKind = "OVERLOADED" | "TIMED_OUT" | "CANCELLED" | "FAILED" | "UNAVAILABLE" | "MALFORMED";
export type TimeoutPhase = "BEFORE_SEND" | "FIRST_EVENT" | "STREAM_IDLE" | "ATTEMPT" | "DEADLINE";

export interface ModelCallErrorInit {
  kind: ModelFailureKind;
  reasonCode: string;
  errorClass: ModelErrorClass;
  /** True when the exchange never reached the provider. */
  notStarted?: boolean;
  httpStatus?: number | null;
  /** Provider-directed delay (Retry-After, retry-after-ms) in ms. */
  retryAfterMs?: number | null;
  timeoutPhase?: TimeoutPhase | null;
  detail?: ProviderDetail | null;
}

export class ModelCallError extends DependencyError {
  readonly kind: ModelFailureKind;
  readonly errorClass: ModelErrorClass;
  readonly httpStatus: number | null;
  readonly retryAfterMs: number | null;
  readonly timeoutPhase: TimeoutPhase | null;
  readonly detail: ProviderDetail | null;

  constructor(init: ModelCallErrorInit) {
    super(init.reasonCode, init.notStarted ? "NOT_STARTED" : "FAILED", init.errorClass === "RETRYABLE");
    this.kind = init.kind;
    this.errorClass = init.errorClass;
    this.httpStatus = init.httpStatus ?? null;
    this.retryAfterMs = init.retryAfterMs ?? null;
    this.timeoutPhase = init.timeoutPhase ?? null;
    this.detail = init.detail ?? null;
  }

  /** The same failure, no longer retryable (output already reached the consumer, or the caller gave up). */
  final(): ModelCallError {
    const e = new ModelCallError({
      kind: this.kind,
      reasonCode: this.reasonCode,
      errorClass: this.errorClass === "RETRYABLE" ? "PERMANENT" : this.errorClass,
      notStarted: this.outcome === "NOT_STARTED",
      httpStatus: this.httpStatus,
      retryAfterMs: this.retryAfterMs,
      timeoutPhase: this.timeoutPhase,
      detail: this.detail,
    });
    return e;
  }
}

/**
 * HTTP status to error class, the common part of every provider's documented error model: 408/409/429/5xx are
 * transient (RETRYABLE); 400/401/403/404/413/422 are PERMANENT (the same request fails again); anything else is
 * UNKNOWN. Each adapter refines this with its provider's own error codes and modelled exceptions (`openAiHttpFailure`
 * in adapters/openai-responses.ts, `bedrockFailure` in adapters/bedrock-converse.ts, `vllmHttpFailure` in
 * adapters/vllm-chat.ts).
 */
export function errorClassForStatus(status: number): ModelErrorClass {
  if (status === 408 || status === 409 || status === 429 || (status >= 500 && status <= 599)) return "RETRYABLE";
  if (status >= 400 && status <= 499) return "PERMANENT";
  return "UNKNOWN";
}

/** Bounded, code-like rendering of a provider error code (never free text). */
export function providerCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  return /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/.test(v) ? v : null;
}
