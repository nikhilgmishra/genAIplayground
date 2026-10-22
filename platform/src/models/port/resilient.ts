/**
 * ResilientModelPort (WP-08; FO-09-45, FO-09-09, FO-09-46, OPS-02, DATA-01): every model call goes through
 * platform/src/resilience.
 *
 *   request checks before any I/O: size, endpoint data-class ceiling (DATA-01), structured output supported by the
 *   endpoint, tool names unique, tool and response schemas compile
 *   overall deadline (bounds every attempt, every retry wait and a bulkhead queue wait)
 *     └─ callDependency: bounded retry (Retry-After honoured, allowlisted reason codes only)
 *          └─ circuit breaker (per endpoint; overload, server errors and hangs open it, including a hang ended by
 *             the overall deadline; refusals and caller cancellation do not)
 *               └─ bulkhead (bounded concurrency and queue: backpressure, never an unbounded backlog)
 *                    └─ attempt timeout (AbortSignal to the adapter, which closes the provider stream)
 *                         └─ adapter.attempt (one provider exchange)
 *   result checks: tool calls against the request (tool-calls.ts), refusal prose (refusal.ts), structured output
 *   against the response schema (tool-calls.ts)
 *
 * The overall deadline is NOT passed to callDependency as a caller signal: a caller abort is neutral for the breaker
 * (CALLER_ABORTED), but an exchange the port itself had to end at its deadline is a provider failure (the provider
 * hung), so the attempt ends with TIMED_OUT MODEL_DEADLINE_EXCEEDED, which the breaker counts. Only when the deadline
 * fires while NO exchange is in flight (the call is queued in the bulkhead or waiting between retries) is it relayed as
 * a cancellation, so the abandoned call leaves the bulkhead queue at once instead of holding a position.
 *
 * The port never throws for a provider outcome: every failure becomes a typed ModelResult (OVERLOADED, TIMED_OUT,
 * CANCELLED, UNAVAILABLE, MALFORMED, FAILED). A request is retried only while nothing has reached the consumer,
 * so an incremental consumer never sees a duplicated delta. Safety and human routing never depend on this port
 * (OPS-02): the fallback decision (fallback.ts) is computed from the typed result without calling a model.
 */
import type { Logger, Metrics } from "../../observability/ports.js";
import { silentLogger } from "../../observability/logger.js";
import type { Classification } from "../../protocol/common.js";
import type { Bulkhead } from "../../resilience/bulkhead.js";
import type { CircuitBreaker } from "../../resilience/circuit-breaker.js";
import { callDependency } from "../../resilience/policy.js";
import { RETRY_MAX_DELAY_MS, defaultSleep } from "../../resilience/retry.js";
import { systemTimers } from "../../resilience/timeout.js";
import type { TimerPort } from "../../resilience/timeout.js";
import type { Clock } from "../../shared/clock.js";
import { DependencyError, PlatformError, ValidationError } from "../../shared/errors.js";
import type { ModelAdapter } from "./adapter.js";
import { ModelCallError } from "./errors.js";
import { DEFAULT_REFUSAL_CLASSIFIER } from "./refusal.js";
import type { RefusalClassifier } from "./refusal.js";
import { compileToolSchemas, structuredOutputViolation, toolCallViolation } from "./tool-calls.js";
import { ModelRequest } from "./types.js";
import type { ModelCallBudget, ModelInvokeOptions, ModelPort, ModelProvider, ModelRequestInput, ModelResult, ModelStreamEvent, ModelUsage } from "./types.js";

/** Reason codes a retry may follow (all transient, all before any output reached the consumer). */
export const DEFAULT_MODEL_RETRY_ON: readonly string[] = ["MODEL_OVERLOADED", "MODEL_SERVER_ERROR", "MODEL_SERVER_ABORTED", "MODEL_STREAM_ERROR", "CONNECTION_REFUSED", "TIMEOUT_BEFORE_SEND", "CONNECTION_LOST"];

/**
 * Data classes a model endpoint may receive under its `maxDataClass`, in the platform's sensitivity order
 * (PUBLIC < INTERNAL < FINANCIAL < PHI < PHI_RESTRICTED). VERIFICATION_SECRET never reaches a model (AUTH-06).
 */
const ORDER: readonly Classification[] = ["PUBLIC", "INTERNAL", "FINANCIAL", "PHI", "PHI_RESTRICTED"];

/** True when a request of `dataClass` may be sent to an endpoint whose ceiling is `maxDataClass`. */
export function dataClassWithinEndpoint(dataClass: Classification, maxDataClass: Classification): boolean {
  const c = ORDER.indexOf(dataClass);
  const m = ORDER.indexOf(maxDataClass === "VERIFICATION_SECRET" ? "PHI_RESTRICTED" : maxDataClass);
  return c >= 0 && m >= 0 && c <= m;
}

/**
 * A request budget capped field by field at the endpoint's ceiling. The result is still a valid budget: each
 * attempt timeout is at most its deadline, so the minimum of the two attempt timeouts is at most the minimum deadline.
 */
export function cappedBudget(requested: ModelCallBudget, ceiling: ModelCallBudget): ModelCallBudget {
  return {
    deadlineMs: Math.min(requested.deadlineMs, ceiling.deadlineMs),
    attemptTimeoutMs: Math.min(requested.attemptTimeoutMs, ceiling.attemptTimeoutMs),
    firstEventTimeoutMs: Math.min(requested.firstEventTimeoutMs, ceiling.firstEventTimeoutMs),
    idleTimeoutMs: Math.min(requested.idleTimeoutMs, ceiling.idleTimeoutMs),
    maxOutputTokens: Math.min(requested.maxOutputTokens, ceiling.maxOutputTokens),
    maxInputBytes: Math.min(requested.maxInputBytes, ceiling.maxInputBytes),
  };
}

/**
 * Bounded wait, after the overall deadline fired or the caller cancelled, for the ended exchange to settle: so the
 * breaker has counted it, and so the result knows whether its request bytes left the process (sentAttempts, which
 * decides the invocation audit record). An attempt still unsettled after this wait counts as sent.
 */
const SETTLE_GRACE_MS = 100;

export interface ModelRetrySettings {
  /** Total attempts including the first (1 = no retry; at most 3, the platform cap). */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  retryOn?: readonly string[];
}

export interface ResilientModelPortOptions {
  endpointRef: string;
  /** The endpoint's data-class ceiling (ModelEndpointConfig.maxDataClass), enforced on every request before any I/O. */
  maxDataClass: Classification;
  clock: Clock;
  retry: ModelRetrySettings;
  breaker?: CircuitBreaker;
  bulkhead?: Bulkhead;
  metrics?: Metrics;
  logger?: Logger;
  timers?: TimerPort;
  /** Refusal prose classifier (default: the built-in openings, refusal.ts). */
  refusalClassifier?: RefusalClassifier;
  /**
   * The endpoint's own budget (ModelEndpointConfig.budget) as a CEILING: every field of a request's budget is capped
   * at it (deadlines, output tokens, input bytes), so a caller can ask for less but never for more than the endpoint
   * was reviewed for. The factory always sets it.
   */
  budgetCeiling?: ModelCallBudget;
  /** Deterministic retry jitter and sleep for tests. */
  random?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const DEPENDENCY = "model-provider";

type Base = { provider: ModelProvider; invocationId: string; latencyMs: number; attempts: number; sentAttempts: number; usage: null };

/**
 * True when an attempt failed before any request byte left the process: a ModelCallError or transport error marked
 * NOT_STARTED, or a platform refusal raised before I/O (egress AccessDeniedError, configuration). Anything else,
 * including an unclassified error, counts as possibly sent (fail toward recording the egress).
 */
function neverSent(err: unknown): boolean {
  if (err instanceof DependencyError) return err.outcome === "NOT_STARTED";
  return err instanceof PlatformError;
}

export class ResilientModelPort implements ModelPort {
  readonly provider: ModelProvider;
  readonly endpointRef: string;
  private readonly logger: Logger;
  private readonly timers: TimerPort;
  private readonly refusal: RefusalClassifier;

  constructor(
    private readonly adapter: ModelAdapter,
    private readonly opts: ResilientModelPortOptions,
  ) {
    if (!/^[a-z][a-z0-9_.-]{2,63}$/.test(opts.endpointRef)) throw new ValidationError("MODEL_ENDPOINT_REF_INVALID");
    if (!ORDER.includes(opts.maxDataClass) && opts.maxDataClass !== "VERIFICATION_SECRET") throw new ValidationError("MODEL_MAX_DATA_CLASS_INVALID");
    const r = opts.retry;
    if (!Number.isInteger(r.maxAttempts) || r.maxAttempts < 1 || r.maxAttempts > 3 || r.baseDelayMs < 0 || r.maxDelayMs < r.baseDelayMs || r.maxDelayMs > RETRY_MAX_DELAY_MS) {
      throw new ValidationError("MODEL_RETRY_POLICY_INVALID");
    }
    this.provider = adapter.provider;
    this.endpointRef = opts.endpointRef;
    this.logger = (opts.logger ?? silentLogger).child({ component: "model_port", provider: adapter.provider });
    this.timers = opts.timers ?? systemTimers;
    this.refusal = opts.refusalClassifier ?? DEFAULT_REFUSAL_CLASSIFIER;
  }

  async invoke(input: ModelRequestInput, options: ModelInvokeOptions = {}): Promise<ModelResult> {
    const parsed = ModelRequest.safeParse(input);
    if (!parsed.success) throw new ValidationError("MODEL_REQUEST_INVALID");
    const ceiling = this.opts.budgetCeiling;
    const request: ModelRequest = ceiling ? { ...parsed.data, budget: cappedBudget(parsed.data.budget, ceiling) } : parsed.data;
    const started = this.opts.clock.now().getTime();
    let attempts = 0;
    let sentAttempts = 0;
    /**
     * Adapter attempts handed to the adapter that have not settled yet. The port can return before an attempt settles
     * (a caller abort or an attempt timeout rejects at once, while the adapter is still closing its exchange), so an
     * open attempt COUNTS AS SENT (security review r4: fail toward recording; the invocation audit record must exist
     * for every request whose bytes may have reached the provider). Before a result is built the port waits, bounded,
     * for open attempts to settle, so an attempt refused before any I/O is normally known as such and not counted.
     */
    const open = new Set<Promise<void>>();
    const base = (): Base => ({ provider: this.provider, invocationId: request.invocationId, latencyMs: Math.max(0, this.opts.clock.now().getTime() - started), attempts, sentAttempts: sentAttempts + open.size, usage: null });
    const settleOpenAttempts = async (): Promise<void> => {
      if (open.size === 0) return;
      let graceTimer: unknown;
      const grace = new Promise<void>((resolve) => {
        graceTimer = this.timers.setTimeout(() => resolve(), SETTLE_GRACE_MS);
      });
      await Promise.race([Promise.all([...open]), grace]);
      this.timers.clearTimeout(graceTimer);
    };

    if (Buffer.byteLength(JSON.stringify({ i: request.instructions, m: request.messages, t: request.tools })) > request.budget.maxInputBytes) {
      return this.finish({ ...base(), outcome: "FAILED", errorClass: "PERMANENT", reasonCode: "MODEL_INPUT_TOO_LARGE", httpStatus: null, detail: null });
    }
    // DATA-01: the endpoint's own ceiling, per request and before any I/O (the egress destination may allow more,
    // because one destination can serve several endpoints with different data controls).
    if (!dataClassWithinEndpoint(request.dataClass, this.opts.maxDataClass)) {
      return this.finish({ ...base(), outcome: "UNAVAILABLE", reasonCode: "MODEL_DATA_CLASS_EXCEEDS_ENDPOINT", detail: null });
    }
    // Structured output only where the endpoint enforces it: a schema is never dropped silently (an endpoint without
    // json_schema support would answer free text the caller asked to be constrained).
    if (request.responseSchema && this.adapter.supportsStructuredOutput !== true) {
      return this.finish({ ...base(), outcome: "FAILED", errorClass: "PERMANENT", reasonCode: "MODEL_STRUCTURED_OUTPUT_UNSUPPORTED", httpStatus: null, detail: null });
    }
    const tools = compileToolSchemas(request, this.provider);
    if (!tools.ok) return this.finish({ ...base(), outcome: "FAILED", errorClass: "PERMANENT", reasonCode: tools.reasonCode, httpStatus: null, detail: null });
    const caller = options.signal;
    if (caller?.aborted) return this.finish({ ...base(), outcome: "CANCELLED", reasonCode: "MODEL_CALL_CANCELLED", detail: null });

    // Overall deadline (FO-09-45): bounds every attempt, every retry wait and a bulkhead queue wait.
    const deadline = new AbortController();
    // Aborted by the deadline only while NO exchange is in flight (the call waits in the bulkhead queue or between
    // retries): the abandoned call then leaves the queue at once instead of holding a queue position until
    // `queueTimeoutMs` (security review r3, bulkhead slots outliving callers). It is passed to callDependency as a
    // cancellation, which is neutral for the breaker, and that is right here: nothing reached the provider. An exchange
    // in flight is ended by `deadline` instead, as a provider failure the breaker counts (D4).
    const queueAbort = new AbortController();
    let inFlight = false;
    let deadlineFired!: () => void;
    const deadlineReached = new Promise<"DEADLINE">((resolve) => {
      deadlineFired = () => resolve("DEADLINE");
    });
    const deadlineTimer = this.timers.setTimeout(() => {
      deadline.abort();
      if (!inFlight) queueAbort.abort();
      deadlineFired();
    }, request.budget.deadlineMs);
    let emitted = false;
    const emit = (e: ModelStreamEvent) => {
      // Content (text, refusal and tool-call deltas) reached the consumer: no retry from here on. A usage report is
      // not content and does not block a retry.
      if (e.type !== "usage") emitted = true;
      try {
        options.onEvent?.(e);
      } catch {
        // A consumer callback never changes the call's outcome.
      }
    };
    const remainingMs = () => request.budget.deadlineMs - (this.opts.clock.now().getTime() - started);
    const sleep = this.opts.sleep ?? defaultSleep;
    const retry = this.opts.retry.maxAttempts > 1
      ? {
          maxAttempts: this.opts.retry.maxAttempts,
          baseDelayMs: this.opts.retry.baseDelayMs,
          maxDelayMs: this.opts.retry.maxDelayMs,
          retryOn: this.opts.retry.retryOn ?? DEFAULT_MODEL_RETRY_ON,
          ...(this.opts.random ? { random: this.opts.random } : {}),
          // A retry wait ends at the deadline; the next attempt then refuses to start (neutral, no exchange).
          sleep: (ms: number, s?: AbortSignal) => sleep(ms, s ? AbortSignal.any([s, deadline.signal]) : deadline.signal),
          // A provider Retry-After is honoured, never shortened; one the deadline cannot afford ends the retries.
          delayFor: (err: unknown) => {
            const hint = err instanceof ModelCallError ? err.retryAfterMs : null;
            if (hint === null) return null;
            return hint >= remainingMs() ? Number.POSITIVE_INFINITY : hint;
          },
        }
      : null;
    const call = callDependency(
      {
        dependency: DEPENDENCY,
        timeoutMs: request.budget.attemptTimeoutMs,
        // Inference has no vendor-side effect (provider storage off): a timed-out attempt is a definite failure.
        idempotent: true,
        retry,
        ...(this.opts.breaker ? { breaker: this.opts.breaker } : {}),
        ...(this.opts.bulkhead ? { bulkhead: this.opts.bulkhead } : {}),
        ...(this.opts.metrics ? { metrics: this.opts.metrics } : {}),
        clock: this.opts.clock,
        timers: this.timers,
      },
      async (attemptSignal) => {
        // The deadline passed while this attempt waited (retry wait, bulkhead queue): no exchange, neutral for the breaker.
        if (deadline.signal.aborted) throw new DependencyError("CALLER_ABORTED", "NOT_STARTED", false);
        attempts += 1;
        inFlight = true;
        let settle!: () => void;
        const settledAttempt = new Promise<void>((resolve) => {
          settle = resolve;
        });
        open.add(settledAttempt);
        const signal = AbortSignal.any(caller ? [attemptSignal, deadline.signal, caller] : [attemptSignal, deadline.signal]);
        try {
          const result = await this.adapter.attempt(request, { signal, emit, attempt: attempts });
          sentAttempts += 1;
          return result;
        } catch (err) {
          if (!neverSent(err)) sentAttempts += 1;
          // The port's own deadline ended a provider exchange: a provider failure (it hung), counted by the breaker
          // and never retried. A caller abort stays CANCELLED and neutral.
          if (deadline.signal.aborted && !caller?.aborted) {
            throw new ModelCallError({ kind: "TIMED_OUT", reasonCode: "MODEL_DEADLINE_EXCEEDED", errorClass: "PERMANENT", timeoutPhase: "DEADLINE", detail: err instanceof ModelCallError ? err.detail : null });
          }
          // Never retry once output reached the consumer: the deltas would be duplicated.
          if (emitted && err instanceof ModelCallError) throw err.final();
          throw err;
        } finally {
          inFlight = false;
          // sentAttempts already holds this attempt's verdict (sent or never sent) when it leaves the open set.
          open.delete(settledAttempt);
          settle();
        }
      },
      // The caller's cancellation, plus the deadline while nothing is in flight (queueAbort above); never the
      // deadline itself, so a hang the deadline ends is not mistaken for a caller abort.
      { signal: caller ? AbortSignal.any([caller, queueAbort.signal]) : queueAbort.signal },
    );
    const settled = call.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    try {
      const first = await Promise.race([settled, deadlineReached]);
      if (first === "DEADLINE") {
        // Let an exchange the deadline aborted settle (bounded), so the breaker has counted it before this returns.
        let graceTimer: unknown;
        const grace = new Promise<null>((resolve) => {
          graceTimer = this.timers.setTimeout(() => resolve(null), SETTLE_GRACE_MS);
        });
        const late = await Promise.race([settled, grace]);
        this.timers.clearTimeout(graceTimer);
        await settleOpenAttempts();
        const detail = late && !late.ok && late.error instanceof ModelCallError ? late.error.detail : null;
        return this.finish({ ...base(), outcome: "TIMED_OUT", phase: "DEADLINE", reasonCode: "MODEL_DEADLINE_EXCEEDED", detail });
      }
      if (!first.ok) {
        // A caller abort or an attempt timeout rejects before the adapter has closed its exchange: wait (bounded) for
        // the attempt to settle so sentAttempts is its real verdict; one still open counts as sent (base()).
        await settleOpenAttempts();
        return this.finish(this.toResult(first.error, base(), { callerAborted: caller?.aborted === true, deadlineHit: deadline.signal.aborted }));
      }
      const result = first.value;
      if (result.outcome === "COMPLETED") {
        const violation = toolCallViolation(request, this.provider, result.toolCalls, tools.offered);
        if (violation) return this.finish({ ...base(), usage: result.usage, outcome: "MALFORMED", reasonCode: violation, detail: result.detail } as ModelResult);
        if (result.toolCalls.length === 0) {
          const refusal = this.refusal.classify(result.text);
          if (refusal) return this.finish({ ...base(), usage: result.usage, outcome: "REFUSED", refusal: { source: "CLASSIFIED_REFUSAL", reasonCode: refusal }, detail: result.detail } as ModelResult);
        }
        const structured = structuredOutputViolation(request, this.provider, result, tools.response);
        if (structured) return this.finish({ ...base(), usage: result.usage, outcome: "MALFORMED", reasonCode: structured, detail: result.detail } as ModelResult);
      }
      return this.finish({ ...result, ...base(), usage: result.usage } as ModelResult);
    } finally {
      this.timers.clearTimeout(deadlineTimer);
    }
  }

  private toResult(err: unknown, b: Base, how: { callerAborted: boolean; deadlineHit: boolean }): ModelResult {
    const base = { ...b, usage: null };
    if (how.callerAborted) return { ...base, outcome: "CANCELLED", reasonCode: "MODEL_CALL_CANCELLED", detail: err instanceof ModelCallError ? err.detail : null };
    if (how.deadlineHit) return { ...base, outcome: "TIMED_OUT", phase: "DEADLINE", reasonCode: "MODEL_DEADLINE_EXCEEDED", detail: err instanceof ModelCallError ? err.detail : null };
    if (err instanceof ModelCallError) {
      switch (err.kind) {
        case "OVERLOADED":
          return { ...base, outcome: "OVERLOADED", retryAfterMs: err.retryAfterMs, reasonCode: err.reasonCode, detail: err.detail };
        case "TIMED_OUT":
          return { ...base, outcome: "TIMED_OUT", phase: err.timeoutPhase ?? "ATTEMPT", reasonCode: err.reasonCode, detail: err.detail };
        case "CANCELLED":
          return { ...base, outcome: "CANCELLED", reasonCode: err.reasonCode, detail: err.detail };
        case "UNAVAILABLE":
          return { ...base, outcome: "UNAVAILABLE", reasonCode: err.reasonCode, detail: null };
        case "MALFORMED":
          return { ...base, outcome: "MALFORMED", reasonCode: err.reasonCode, detail: err.detail };
        default:
          return { ...base, outcome: "FAILED", errorClass: err.errorClass, reasonCode: err.reasonCode, httpStatus: err.httpStatus, detail: err.detail };
      }
    }
    if (err instanceof DependencyError) {
      if (err.reasonCode === "CIRCUIT_OPEN") return { ...base, outcome: "UNAVAILABLE", reasonCode: "MODEL_CIRCUIT_OPEN", detail: null };
      if (err.reasonCode === "BULKHEAD_FULL" || err.reasonCode === "BULKHEAD_QUEUE_TIMEOUT") return { ...base, outcome: "UNAVAILABLE", reasonCode: "MODEL_BACKPRESSURE", detail: null };
      // The attempt timeout of callDependency (withTimeout): one provider exchange took too long and was closed.
      if (err.reasonCode === "TIMEOUT") return { ...base, outcome: "TIMED_OUT", phase: "ATTEMPT", reasonCode: "MODEL_ATTEMPT_TIMEOUT", detail: null };
      if (err.reasonCode === "CALLER_ABORTED") return { ...base, outcome: "CANCELLED", reasonCode: "MODEL_CALL_CANCELLED", detail: null };
      return { ...base, outcome: "FAILED", errorClass: err.outcome === "UNKNOWN" ? "UNKNOWN" : err.retryable ? "RETRYABLE" : "PERMANENT", reasonCode: err.reasonCode, httpStatus: null, detail: null };
    }
    // Egress refusal (AccessDeniedError), configuration and other platform errors: refused before any provider I/O.
    if (err instanceof PlatformError) return { ...base, outcome: "UNAVAILABLE", reasonCode: err.reasonCode, detail: null };
    return { ...base, outcome: "FAILED", errorClass: "UNKNOWN", reasonCode: "UNCLASSIFIED_ERROR", httpStatus: null, detail: null };
  }
  private finish(result: ModelResult): ModelResult {
    const m = this.opts.metrics;
    try {
      m?.increment("vsp_model_calls_total", { provider: result.provider, outcome: result.outcome });
      m?.observe("vsp_model_call_latency_ms", result.latencyMs, { provider: result.provider, outcome: result.outcome });
      const u: ModelUsage | null = result.usage;
      if (u) {
        m?.increment("vsp_model_tokens_total", { provider: result.provider, direction: "input" }, u.inputTokens);
        m?.increment("vsp_model_tokens_total", { provider: result.provider, direction: "output" }, u.outputTokens);
      }
    } catch {
      // Metrics never change a model call's outcome.
    }
    if (result.outcome !== "COMPLETED") {
      this.logger.warn("model.call.not_completed", { outcome: result.outcome, reasonCode: "reasonCode" in result ? result.reasonCode : null, attempts: result.attempts, endpointRef: this.endpointRef });
    }
    return result;
  }
}
