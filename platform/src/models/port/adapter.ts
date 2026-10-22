/**
 * The provider adapter seam (WP-08). An adapter performs ONE provider exchange and keeps its provider's own
 * semantics; everything around the exchange (overall deadline, attempt timeout, bulkhead, breaker, bounded retries,
 * metrics, the typed result for every failure) is the ResilientModelPort's job, so no adapter can skip it.
 *
 *  - `attempt` resolves with a terminal outcome the provider produced (COMPLETED, REFUSED, INCOMPLETE, MALFORMED);
 *  - it throws ModelCallError for everything the resilience layer acts on (overload, server error, timeout,
 *    cancellation, transport failure, egress refusal);
 *  - it must honour `signal` by closing the provider exchange (FO-09-45: abort propagates to the provider stream).
 */
import type { ModelProvider, ModelRequest, ModelResult, ModelStreamEvent } from "./types.js";

/** The terminal results an attempt may return; the port fills the common fields. */
export type AttemptResult = DistributiveOmit<Extract<ModelResult, { outcome: "COMPLETED" | "REFUSED" | "INCOMPLETE" | "MALFORMED" }>, "invocationId" | "latencyMs" | "attempts" | "sentAttempts">;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export interface AttemptContext {
  /** Aborted on caller cancellation, the overall deadline or the attempt timeout. */
  signal: AbortSignal;
  /** Incremental events; the port tracks whether any reached the consumer (no retry after that). */
  emit: (event: ModelStreamEvent) => void;
  /** 1-based attempt number. */
  attempt: number;
}

export interface ModelAdapter {
  readonly provider: ModelProvider;
  /**
   * The endpoint enforces a request's `responseSchema` (OpenAI `text.format` json_schema, the Bedrock forced tool,
   * vLLM guided decoding when the endpoint enables it). Absent or false: the port refuses a structured-output request
   * before any I/O (MODEL_STRUCTURED_OUTPUT_UNSUPPORTED) instead of letting the schema be dropped silently.
   */
  readonly supportsStructuredOutput?: boolean;
  attempt(request: ModelRequest, ctx: AttemptContext): Promise<AttemptResult>;
}
