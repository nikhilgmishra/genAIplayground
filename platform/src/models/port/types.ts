/**
 * ModelPort contract (WP-08; FO-09-09, FO-09-45, FO-09-46, follow-on prompt section 9, ADR-0018 decision 5.2).
 *
 * One request shape in (instructions in their own channel, caller/document/tool content as data), and a TYPED,
 * PROVIDER-SPECIFIC result union out. There is no lowest-common-denominator layer: every terminal result names its
 * provider and carries that provider's own stop / finish / status vocabulary (`detail`), so a caller can never
 * mistake an OpenAI `incomplete` for a Bedrock `guardrail_intervened` or a vLLM `abort`. What is common is only the
 * OUTCOME class the harness acts on (COMPLETED, REFUSED, INCOMPLETE, OVERLOADED, TIMED_OUT, CANCELLED, MALFORMED,
 * UNAVAILABLE, FAILED) and the error class the resilience layer acts on (RETRYABLE, PERMANENT, UNKNOWN).
 *
 * Model output is untrusted (FO-04-19): text and tool calls are PROPOSALS, never facts, and only a COMPLETED result
 * has speakable text. A refusal, a timeout, an overload or a malformed stream never yields text for the audio queue;
 * the harness answers it with the approved fallback (fallback.ts).
 *
 * Model identifiers are configuration data (the model registry, WP-09); this module never names a model.
 */
import { z } from "zod";
import { Classification } from "../../protocol/common.js";
import { InvocationId, ModelRole } from "../../protocol/models.js";

/** Provider protocols with an adapter here. Native audio (WP-16) and speech (WP-13) have their own ports. */
export const ModelProvider = z.enum(["openai_responses", "bedrock_converse", "vllm_openai_compatible"]);
export type ModelProvider = z.infer<typeof ModelProvider>;

/** Model id as configuration data: the provider's exact id (or served model name) from the registry entry. */
export const ProviderModelId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/);

const ToolName = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/);
/** Provider tool-call ids are opaque provider strings (bounded, printable, no whitespace). */
const ToolCallId = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);
/** JSON object (bounded by the request size limit of the transport). */
const JsonObject = z.record(z.string(), z.unknown());

export const ModelToolSpec = z.strictObject({
  name: ToolName,
  description: z.string().min(1).max(2_000),
  /** JSON Schema of the arguments (object schema). */
  parameters: JsonObject,
});
export type ModelToolSpec = z.infer<typeof ModelToolSpec>;

export const ModelToolCall = z.strictObject({
  callId: ToolCallId,
  name: ToolName,
  /**
   * Parsed JSON arguments: a proposal. Before a COMPLETED result is returned, the ResilientModelPort has checked that
   * the tool was offered by the request and allowed by its tool choice, and that the arguments validate against the
   * tool's declared parameters schema (tool-calls.ts; a violation is MALFORMED). The gateway still re-validates and
   * re-authorizes every proposal against its pinned catalogue.
   */
  arguments: JsonObject,
});
export type ModelToolCall = z.infer<typeof ModelToolCall>;

export const ModelMessage = z.discriminatedUnion("role", [
  z.strictObject({ role: z.literal("user"), content: z.string().min(1).max(64_000) }),
  z.strictObject({ role: z.literal("assistant"), content: z.string().max(64_000), toolCalls: z.array(ModelToolCall).max(16).default([]) }),
  /** A tool result returned to the model: the gateway's (masked) result body, serialized. */
  z.strictObject({ role: z.literal("tool"), callId: ToolCallId, name: ToolName, content: z.string().max(64_000) }),
]);
export type ModelMessage = z.infer<typeof ModelMessage>;

export const ToolChoice = z.union([z.enum(["auto", "none", "required"]), z.strictObject({ name: ToolName })]);
export type ToolChoice = z.infer<typeof ToolChoice>;

/**
 * Deadlines of one call (FO-09-45). `deadlineMs` bounds the whole call including retries; `attemptTimeoutMs` bounds
 * one provider exchange; `firstEventTimeoutMs` and `idleTimeoutMs` bound a stream that stops producing events (a
 * hang): they apply to the bytes as they arrive from the transport.
 */
export const ModelCallBudget = z
  .strictObject({
    deadlineMs: z.number().int().min(100).max(120_000),
    attemptTimeoutMs: z.number().int().min(100).max(120_000),
    firstEventTimeoutMs: z.number().int().min(50).max(120_000),
    idleTimeoutMs: z.number().int().min(50).max(120_000),
    maxOutputTokens: z.number().int().min(1).max(32_768),
    maxInputBytes: z.number().int().min(1_024).max(262_144),
  })
  .refine((b) => b.attemptTimeoutMs <= b.deadlineMs, { message: "ATTEMPT_TIMEOUT_EXCEEDS_DEADLINE" });
export type ModelCallBudget = z.infer<typeof ModelCallBudget>;

export const ModelRequest = z.strictObject({
  invocationId: InvocationId,
  role: ModelRole,
  /** Instruction channel: the pinned prompt template rendered by the harness (WP-10), never caller content. */
  instructions: z.string().min(1).max(32_000),
  /** Data channel: caller, document and tool content, delimited from the instructions by the protocol itself. */
  messages: z.array(ModelMessage).min(1).max(64),
  tools: z.array(ModelToolSpec).max(32).default([]),
  toolChoice: ToolChoice.default("auto"),
  /**
   * Most sensitive class in the request. Checked per request before any provider I/O: against the endpoint's
   * `maxDataClass` (ResilientModelPort, MODEL_DATA_CLASS_EXCEEDS_ENDPOINT) and against the egress destination's
   * approved classes (the transport's per-request model egress check), DATA-01.
   */
  dataClass: Classification,
  budget: ModelCallBudget,
  temperature: z.number().min(0).max(2).nullable().default(null),
  /** Structured output: a JSON schema the provider must follow (when the endpoint supports it). */
  responseSchema: z.strictObject({ name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/), schema: JsonObject }).nullable().default(null),
});
export type ModelRequest = z.infer<typeof ModelRequest>;
export type ModelRequestInput = z.input<typeof ModelRequest>;

/* ------------------------------------------------------------------------ */
/* Streaming events                                                          */
/* ------------------------------------------------------------------------ */

/** Incremental events, in provider order. Text and refusal deltas are never speakable before the terminal result. */
export type ModelStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call_started"; index: number; callId: string; name: string }
  | { type: "tool_call_arguments_delta"; index: number; delta: string }
  | { type: "refusal_delta"; text: string }
  | { type: "usage"; usage: ModelUsage };

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  /** Provider-reported cached / reasoning token counts where the provider reports them (else null). */
  cachedInputTokens: number | null;
  reasoningTokens: number | null;
}

/* ------------------------------------------------------------------------ */
/* Provider-specific detail                                                  */
/* ------------------------------------------------------------------------ */

/** OpenAI Responses API terminal detail (response.status and incomplete_details.reason). */
export interface OpenAiResponsesDetail {
  provider: "openai_responses";
  responseId: string | null;
  status: "completed" | "incomplete" | "failed" | "cancelled" | "in_progress" | "queued" | null;
  incompleteReason: "max_output_tokens" | "content_filter" | null;
  /** `error.code` of a `response.failed` / `error` event, as a bounded code string. */
  errorCode: string | null;
}

/** Amazon Bedrock ConverseStream terminal detail (messageStop.stopReason and the modelled exception type). */
export interface BedrockConverseDetail {
  provider: "bedrock_converse";
  requestId: string | null;
  stopReason:
    | "end_turn"
    | "tool_use"
    | "max_tokens"
    | "stop_sequence"
    | "guardrail_intervened"
    | "content_filtered"
    | "malformed_model_output"
    | "malformed_tool_use"
    | "model_context_window_exceeded"
    | null;
  /** Modelled exception name (e.g. ThrottlingException, ModelStreamErrorException). */
  exception: string | null;
  /** Bedrock-reported model latency (metadata.metrics.latencyMs). */
  latencyMs: number | null;
}

/** vLLM OpenAI-compatible Chat Completions terminal detail (choices[0].finish_reason and the pinned tool parser). */
export interface VllmChatDetail {
  provider: "vllm_openai_compatible";
  completionId: string | null;
  finishReason: "stop" | "length" | "tool_calls" | "abort" | "error" | null;
  /** The server-side tool parser this endpoint is pinned to (vLLM --tool-call-parser). */
  toolParser: string;
  /** `model` field the server reported (served model name; must equal the pinned name). */
  servedModel: string | null;
}

export type ProviderDetail = OpenAiResponsesDetail | BedrockConverseDetail | VllmChatDetail;

/** Error class the resilience layer and the harness act on (FO-09-09). */
export type ModelErrorClass = "RETRYABLE" | "PERMANENT" | "UNKNOWN";

/** Why a request was refused (FO-09-46): the provider's own refusal signal, classified per provider. */
export type RefusalSource =
  /** The provider's own refusal signal: an OpenAI `refusal` content part (the model declined). */
  | "MODEL_REFUSAL"
  /** Bedrock guardrail intervention (only when the request carried the endpoint's guardrail). */
  | "GUARDRAIL_INTERVENED"
  /** Provider content filter (OpenAI incomplete content_filter, Bedrock content_filtered; vLLM has none). */
  | "CONTENT_FILTER"
  /**
   * The port's refusal classifier (refusal.ts) recognised a refusal opening in otherwise COMPLETED text-only output.
   * This is how a self-hosted vLLM model, or a Bedrock model without a guardrail, refuses: plain `content` with a
   * normal stop (vLLM streams no refusal field and no content filter). Best effort: prose the classifier does not
   * recognise stays COMPLETED text, which the harness (WP-10) still checks before anything is spoken.
   */
  | "CLASSIFIED_REFUSAL";

/* ------------------------------------------------------------------------ */
/* Terminal result                                                           */
/* ------------------------------------------------------------------------ */

interface ResultBase {
  provider: ModelProvider;
  invocationId: string;
  /** Wall-clock of the whole call (including retries) in ms. */
  latencyMs: number;
  /** Adapter attempts started (1 + retries); 0 when refused before any attempt (ceiling, circuit, backpressure). */
  attempts: number;
  /**
   * Attempts whose request bytes reached (or may have reached) the provider. An attempt refused before any byte was
   * sent (egress refused, credential unavailable, connection or TLS refused, timed out before send) does not count;
   * every other attempt does, including one the provider rejected (401/403 MODEL_AUTH_REJECTED, 4xx, 5xx) or that
   * ended mid-stream. The invocation audit record exists exactly when this is at least 1 (invocation.ts).
   */
  sentAttempts: number;
  usage: ModelUsage | null;
}

export type ModelResult =
  | (ResultBase & { outcome: "COMPLETED"; text: string; toolCalls: ModelToolCall[]; detail: ProviderDetail })
  | (ResultBase & { outcome: "REFUSED"; refusal: { source: RefusalSource; reasonCode: string }; detail: ProviderDetail })
  /** Stopped early without a refusal (output token limit, context window): no speakable text. */
  | (ResultBase & { outcome: "INCOMPLETE"; reasonCode: string; detail: ProviderDetail })
  /** Provider overload (429/503, throttling) after the bounded retries; `retryAfterMs` as the provider asked. */
  | (ResultBase & { outcome: "OVERLOADED"; retryAfterMs: number | null; reasonCode: string; detail: ProviderDetail | null })
  /**
   * A deadline fired: before send, waiting for the first event, between events, the attempt timeout of one provider
   * exchange (ATTEMPT), or the overall deadline of the call (DEADLINE).
   */
  | (ResultBase & { outcome: "TIMED_OUT"; phase: "BEFORE_SEND" | "FIRST_EVENT" | "STREAM_IDLE" | "ATTEMPT" | "DEADLINE"; reasonCode: string; detail: ProviderDetail | null })
  /** The caller aborted (barge-in, turn superseded, call ended); the provider stream was closed. */
  | (ResultBase & { outcome: "CANCELLED"; reasonCode: string; detail: ProviderDetail | null })
  /** The stream or a tool call could not be parsed, or the server leaked raw tool-call markup into text. */
  | (ResultBase & { outcome: "MALFORMED"; reasonCode: string; detail: ProviderDetail | null })
  /** Not attempted: circuit open, bulkhead full, egress refused, data class above the endpoint's maximum, not configured. */
  | (ResultBase & { outcome: "UNAVAILABLE"; reasonCode: string; detail: null })
  | (ResultBase & { outcome: "FAILED"; errorClass: ModelErrorClass; reasonCode: string; httpStatus: number | null; detail: ProviderDetail | null });

export type ModelOutcome = ModelResult["outcome"];

/** Outcomes that never carry speakable model text. */
export const NON_SPEAKABLE_OUTCOMES: ReadonlySet<ModelOutcome> = new Set(["REFUSED", "INCOMPLETE", "OVERLOADED", "TIMED_OUT", "CANCELLED", "MALFORMED", "UNAVAILABLE", "FAILED"]);

/** Options of one call. */
export interface ModelInvokeOptions {
  /**
   * Caller cancellation only (barge-in, turn superseded, call ended): closes the provider stream, yields CANCELLED
   * (no speech) and is neutral for the circuit breaker. A deadline belongs in `budget.deadlineMs`, never here: the
   * port's own deadline yields TIMED_OUT DEADLINE, the approved fallback, and counts as a provider failure.
   */
  signal?: AbortSignal;
  /** Incremental events as they are parsed (bytes reach the parser as the transport delivers them). */
  onEvent?: (event: ModelStreamEvent) => void;
}

/** The port the harness (WP-10) calls. Never throws for a provider outcome: every outcome is a typed result. */
export interface ModelPort {
  readonly provider: ModelProvider;
  readonly endpointRef: string;
  invoke(request: ModelRequestInput, options?: ModelInvokeOptions): Promise<ModelResult>;
}
