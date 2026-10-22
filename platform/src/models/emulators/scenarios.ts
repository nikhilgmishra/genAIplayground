/**
 * Scripted behaviour of the protocol-exact model emulators (WP-08; FO-16-18, FO-09-36). Pure functions: a script
 * plus the parsed request in, the exact wire response out (status, headers, body frames, and where the stream
 * stalls). The HTTP servers (platform/test/emulators/models/server.ts) only write these frames.
 *
 * Three wire protocols, each as its provider documents it:
 *  - OpenAI Responses SSE (`event: <type>` + `data: <json>`), event objects typed against the official SDK's
 *    `ResponseStreamEvent` union (`satisfies`), with strictly increasing `sequence_number`;
 *  - vLLM Chat Completions SSE (`data: <chat.completion.chunk>` ... `data: [DONE]`), typed against `ChatCompletionChunk`;
 *  - Bedrock ConverseStream AWS event stream (binary frames with CRCs, `:event-type` headers), payloads typed against
 *    the AWS SDK's ConverseStreamOutput members; modelled exceptions as `:message-type: exception` frames or HTTP
 *    errors with `x-amzn-errortype`.
 *
 * Fault injection points (FO-17-24 rows run by WP-15 / WP-17):
 *  - MODEL_REFUSAL: `refusal`, rendered the way each provider really refuses: an OpenAI `refusal` content part; for
 *    vLLM plain `content` with `finish_reason: stop` (vLLM has no refusal field and no content filter); for Bedrock
 *    `stopReason: guardrail_intervened` with the guardrail's blocked message ONLY when the request carried a
 *    `guardrailConfig`, otherwise plain refusal text with `stopReason: end_turn` (a model without a guardrail just
 *    declines in text). `guardrail` and `content_filter` follow the same rule for vLLM and Bedrock;
 *  - MODEL_HANG: `hang` (head and the first events written, then the stream stalls until the client closes it), or
 *    `hang` with `beforeHead` (nothing written);
 *  - MODEL_OVERLOAD: `overload` (429 or 503 with Retry-After / retry-after-ms; Bedrock ThrottlingException or
 *    ServiceUnavailableException, also mid-stream, with no Retry-After because Bedrock sends none; vLLM's 503 error
 *    document carries the Retry-After the script asks for, as the gateway or load balancer in front of a vLLM server
 *    sends it, since vLLM itself sends none).
 * Error-class scripts (FO-09-09): `request_rejected` (provider 4xx: OpenAI `invalid_*` / `model_not_found`, Bedrock
 * ValidationException / ResourceNotFoundException, vLLM 400 / 404 / 422), `context_window` (OpenAI 400
 * `context_length_exceeded`, Bedrock `model_context_window_exceeded`, vLLM 400), `engine_abort` (vLLM
 * `finish_reason: abort`, OpenAI `response.failed`, Bedrock ModelStreamErrorException), `stream_error` with a provider
 * code (an unrecognised code is the UNKNOWN class), `unexpected_status` (a status outside the documented error
 * model).
 * Content is SYNTHETIC: the emulator never echoes request text back (no caller content is reflected).
 */
import type { ResponseStreamEvent, Response as OpenAiResponse, ResponseOutputItem } from "openai/resources/responses/responses";
import type { ChatCompletionChunk } from "openai/resources/chat/completions/completions";
import type { ConverseStreamOutput } from "@aws-sdk/client-bedrock-runtime";
import { encodeEvent, encodeException } from "./eventstream.js";

export type EmulatorScript =
  | { kind: "text"; text: string; chunks?: number }
  | { kind: "tool_call"; name: string; arguments: Record<string, unknown>; text?: string }
  | { kind: "refusal"; message?: string }
  | { kind: "guardrail" }
  | { kind: "content_filter" }
  | { kind: "max_tokens"; text?: string }
  | { kind: "overload"; status?: 429 | 503; retryAfterSeconds?: number; retryAfterMs?: number; midStream?: boolean }
  | { kind: "hang"; afterEvents?: number; beforeHead?: boolean }
  | { kind: "server_error"; status?: 500 | 502 | 504 }
  | { kind: "stream_error"; code?: string }
  | { kind: "request_rejected"; status?: 400 | 404 | 422 }
  | { kind: "context_window" }
  | { kind: "engine_abort" }
  | { kind: "unexpected_status"; status: number }
  | {
      kind: "malformed";
      variant:
        | "bad_json"
        | "truncated"
        | "bad_tool_args"
        | "out_of_order"
        | "replayed_sequence"
        | "missing_sequence_number"
        | "tool_markup_leak"
        | "served_name_mismatch"
        | "missing_served_name"
        | "bad_crc"
        | "refusal_terminal_only"
        | "tool_call_unclosed"
        | "terminal_status_mismatch"
        | "tool_call_not_streamed"
        | "content_after_finish"
        | "tool_call_renamed"
        | "refusal_overridden";
    }
  | { kind: "auth_error" }
  | { kind: "quota_exhausted" };

/** The synthetic refusal a model writes in plain text (what the port's refusal classifier recognises). */
export const SYNTHETIC_REFUSAL_TEXT = "I can't help with that request.";
/** Amazon Bedrock's default guardrail blocked-output message (a guardrail's configured text). */
export const GUARDRAIL_BLOCKED_TEXT = "Sorry, the model cannot answer this question.";

/** Fault ids of the FO-17-24 matrix this emulator injects, and the script each one queues. */
export const FAULT_SCRIPTS = {
  MODEL_REFUSAL: { kind: "refusal" },
  MODEL_HANG: { kind: "hang", afterEvents: 1 },
  MODEL_OVERLOAD: { kind: "overload", status: 429, retryAfterSeconds: 1 },
} as const satisfies Record<string, EmulatorScript>;
export type EmulatorFault = keyof typeof FAULT_SCRIPTS;

export interface EmulatedResponse {
  status: number;
  headers: Record<string, string>;
  frames: Buffer[];
  /** Write this many frames, then stall until the client goes away (null: end normally). */
  stallAfterFrames: number | null;
  /** Never write the response head (the request hangs before any byte). */
  stallBeforeHead: boolean;
}

/** What the renderers need from a parsed request. */
export interface RenderInput {
  model: string;
  /** Tools declared by the request (name and JSON schema). */
  tools: { name: string; parameters: Record<string, unknown> }[];
  /** The tool-call id of the last message when it is a tool result (round trip). */
  lastToolResultCallId: string | null;
  /** Bedrock only: the request carried a `guardrailConfig` (refusals then intervene through the guardrail). */
  guardrail: boolean;
  /**
   * The JSON schema of a structured-output request (OpenAI `text.format` json_schema, vLLM `response_format`
   * json_schema); null otherwise and always for Bedrock, whose structured output is a forced tool.
   */
  responseSchema: Record<string, unknown> | null;
  inputBytes: number;
  /** Deterministic ids for this response. */
  seed: string;
  createdAt: number;
}

/** Built-in fixture model ids (configuration of the local profile; any other `emulated-*` id behaves as text). */
export const FIXTURE_MODELS: Readonly<Record<string, EmulatorScript>> = {
  "emulated-text": { kind: "text", text: "This is a synthetic emulated reply.", chunks: 3 },
  "emulated-refusal": FAULT_SCRIPTS.MODEL_REFUSAL,
  "emulated-guardrail": { kind: "guardrail" },
  "emulated-overload": FAULT_SCRIPTS.MODEL_OVERLOAD,
  "emulated-hang": FAULT_SCRIPTS.MODEL_HANG,
  "emulated-malformed": { kind: "malformed", variant: "bad_json" },
};

/** Arguments that satisfy a tool's JSON schema at the shape level (required properties, synthetic values). */
export function syntheticArguments(schema: Record<string, unknown>): Record<string, unknown> {
  const props = (schema.properties ?? {}) as Record<string, { type?: string; enum?: unknown[] }>;
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : Object.keys(props);
  const out: Record<string, unknown> = {};
  for (const k of required) {
    const p = props[k] ?? {};
    if (Array.isArray(p.enum) && p.enum.length > 0) out[k] = p.enum[0];
    else if (p.type === "number" || p.type === "integer") out[k] = 1;
    else if (p.type === "boolean") out[k] = true;
    else out[k] = "synthetic";
  }
  return out;
}

/** The default script for a request with no queued script. */
export function defaultScript(input: RenderInput): EmulatorScript {
  // A structured-output request to a text model: the provider constrains the text to the schema (synthetic values).
  if (input.responseSchema && (input.model === "emulated-text" || !(input.model in FIXTURE_MODELS))) {
    return { kind: "text", text: JSON.stringify(syntheticArguments(input.responseSchema)), chunks: 3 };
  }
  if (input.model in FIXTURE_MODELS) return FIXTURE_MODELS[input.model] as EmulatorScript;
  if (input.model === "emulated-tools") {
    if (input.lastToolResultCallId !== null) return { kind: "text", text: "The synthetic tool result was received.", chunks: 2 };
    const t = input.tools[0];
    if (t) return { kind: "tool_call", name: t.name, arguments: syntheticArguments(t.parameters) };
  }
  return { kind: "text", text: "This is a synthetic emulated reply.", chunks: 3 };
}

function split(text: string, n: number): string[] {
  const parts: string[] = [];
  const size = Math.max(1, Math.ceil(text.length / Math.max(1, n)));
  for (let i = 0; i < text.length; i += size) parts.push(text.slice(i, i + size));
  return parts.length > 0 ? parts : [""];
}

const words = (s: string) => (s.trim() === "" ? 0 : s.trim().split(/\s+/).length);
const tokensIn = (input: RenderInput) => Math.max(1, Math.ceil(input.inputBytes / 4));

function retryHeaders(s: Extract<EmulatorScript, { kind: "overload" }>): Record<string, string> {
  const h: Record<string, string> = {};
  if (s.retryAfterSeconds !== undefined) h["retry-after"] = String(s.retryAfterSeconds);
  if (s.retryAfterMs !== undefined) h["retry-after-ms"] = String(s.retryAfterMs);
  return h;
}

const json = (status: number, body: unknown, extra: Record<string, string> = {}): EmulatedResponse => ({
  status,
  headers: { "content-type": "application/json", ...extra },
  frames: [Buffer.from(JSON.stringify(body))],
  stallAfterFrames: null,
  stallBeforeHead: false,
});

/* ------------------------------------------------------------------------ */
/* OpenAI Responses                                                          */
/* ------------------------------------------------------------------------ */

const sse = (ev: ResponseStreamEvent): Buffer => Buffer.from(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);

function openAiResponse(input: RenderInput, status: OpenAiResponse["status"], output: ResponseOutputItem[], extra: Partial<OpenAiResponse> = {}): OpenAiResponse {
  return {
    id: `resp_${input.seed}`,
    object: "response",
    created_at: input.createdAt,
    model: input.model,
    status,
    output,
    output_text: "",
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    parallel_tool_calls: true,
    temperature: null,
    tool_choice: "auto",
    tools: [],
    top_p: null,
    access_programs: null,
    ...extra,
  };
}

export function renderOpenAiResponses(script: EmulatorScript, input: RenderInput): EmulatedResponse {
  switch (script.kind) {
    case "overload":
      if (!script.midStream) return json(script.status ?? 429, { error: { message: "Rate limit reached (emulated).", type: "requests", param: null, code: (script.status ?? 429) === 429 ? "rate_limit_exceeded" : "server_is_overloaded" } }, retryHeaders(script));
      break;
    case "server_error":
      return json(script.status ?? 500, { error: { message: "The server had an error (emulated).", type: "server_error", param: null, code: "server_error" } });
    case "auth_error":
      return json(401, { error: { message: "Incorrect API key provided (emulated).", type: "invalid_request_error", param: null, code: "invalid_api_key" } });
    case "quota_exhausted":
      return json(429, { error: { message: "Quota exceeded (emulated).", type: "insufficient_quota", param: null, code: "insufficient_quota" } });
    case "request_rejected": {
      const status = script.status ?? 400;
      return json(status, { error: { message: "Invalid request (emulated).", type: "invalid_request_error", param: null, code: status === 404 ? "model_not_found" : "invalid_value" } });
    }
    case "context_window":
      return json(400, { error: { message: "Context length exceeded (emulated).", type: "invalid_request_error", param: "input", code: "context_length_exceeded" } });
    case "unexpected_status":
      return json(script.status, { error: { message: "Unexpected status (emulated).", type: "server_error", param: null, code: null } });
    default:
      break;
  }
  let seq = 0;
  const frames: Buffer[] = [];
  const push = (ev: ResponseStreamEvent) => {
    frames.push(sse(ev));
  };
  const outTokens = { n: 0 };
  push({ type: "response.created", sequence_number: seq++, response: openAiResponse(input, "in_progress", []) });
  push({ type: "response.in_progress", sequence_number: seq++, response: openAiResponse(input, "in_progress", []) });
  const usage = () => ({ input_tokens: tokensIn(input), input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens: outTokens.n, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: tokensIn(input) + outTokens.n });
  const msgId = `msg_${input.seed}`;
  const finish = (status: "completed" | "incomplete", output: ResponseOutputItem[], extra: Partial<OpenAiResponse> = {}) =>
    push({ type: status === "completed" ? "response.completed" : "response.incomplete", sequence_number: seq++, response: openAiResponse(input, status, output, { usage: usage(), ...extra }) } as ResponseStreamEvent);

  const textItem = (text: string, status: "completed" | "incomplete"): ResponseOutputItem => ({ id: msgId, type: "message", role: "assistant", status, content: [{ type: "output_text", text, annotations: [] }] });
  const streamText = (text: string, chunks: number) => {
    push({ type: "response.output_item.added", sequence_number: seq++, output_index: 0, item: { id: msgId, type: "message", role: "assistant", status: "in_progress", content: [] } });
    push({ type: "response.content_part.added", sequence_number: seq++, output_index: 0, item_id: msgId, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
    for (const d of split(text, chunks)) push({ type: "response.output_text.delta", sequence_number: seq++, output_index: 0, item_id: msgId, content_index: 0, delta: d, logprobs: [] });
    push({ type: "response.output_text.done", sequence_number: seq++, output_index: 0, item_id: msgId, content_index: 0, text, logprobs: [] });
    outTokens.n += words(text);
  };

  switch (script.kind) {
    case "text":
    case "max_tokens": {
      const text = script.text ?? "This synthetic reply was cut";
      streamText(text, script.kind === "text" ? (script.chunks ?? 3) : 2);
      push({ type: "response.output_item.done", sequence_number: seq++, output_index: 0, item: textItem(text, script.kind === "text" ? "completed" : "incomplete") });
      if (script.kind === "text") finish("completed", [textItem(text, "completed")], { output_text: text });
      else finish("incomplete", [textItem(text, "incomplete")], { incomplete_details: { reason: "max_output_tokens" } });
      break;
    }
    case "tool_call": {
      const callItemId = `fc_${input.seed}`;
      const callId = `call_${input.seed}`;
      const args = JSON.stringify(script.arguments);
      push({ type: "response.output_item.added", sequence_number: seq++, output_index: 0, item: { id: callItemId, type: "function_call", call_id: callId, name: script.name, arguments: "", status: "in_progress" } });
      for (const d of split(args, 3)) push({ type: "response.function_call_arguments.delta", sequence_number: seq++, output_index: 0, item_id: callItemId, delta: d });
      push({ type: "response.function_call_arguments.done", sequence_number: seq++, output_index: 0, item_id: callItemId, arguments: args });
      const item: ResponseOutputItem = { id: callItemId, type: "function_call", call_id: callId, name: script.name, arguments: args, status: "completed" };
      push({ type: "response.output_item.done", sequence_number: seq++, output_index: 0, item });
      outTokens.n += 8;
      finish("completed", [item]);
      break;
    }
    case "refusal": {
      const message = script.message ?? SYNTHETIC_REFUSAL_TEXT;
      push({ type: "response.output_item.added", sequence_number: seq++, output_index: 0, item: { id: msgId, type: "message", role: "assistant", status: "in_progress", content: [] } });
      push({ type: "response.content_part.added", sequence_number: seq++, output_index: 0, item_id: msgId, content_index: 0, part: { type: "refusal", refusal: "" } });
      for (const d of split(message, 2)) push({ type: "response.refusal.delta", sequence_number: seq++, output_index: 0, item_id: msgId, content_index: 0, delta: d });
      push({ type: "response.refusal.done", sequence_number: seq++, output_index: 0, item_id: msgId, content_index: 0, refusal: message });
      const item: ResponseOutputItem = { id: msgId, type: "message", role: "assistant", status: "completed", content: [{ type: "refusal", refusal: message }] };
      push({ type: "response.output_item.done", sequence_number: seq++, output_index: 0, item });
      outTokens.n += words(message);
      finish("completed", [item]);
      break;
    }
    case "content_filter":
    case "guardrail":
      finish("incomplete", [], { incomplete_details: { reason: "content_filter" } });
      break;
    case "overload":
      // Mid-stream overload: the documented `error` event, then the stream ends.
      push({ type: "error", sequence_number: seq++, code: "rate_limit_exceeded", message: "Rate limit reached (emulated).", param: null });
      break;
    case "stream_error":
      push({ type: "error", sequence_number: seq++, code: script.code ?? "server_error", message: "The server had an error (emulated).", param: null });
      break;
    case "engine_abort":
      // The Responses API reports a server-side failure of a started response as `response.failed`.
      push({ type: "response.failed", sequence_number: seq++, response: openAiResponse(input, "failed", [], { error: { code: "server_error", message: "The server had an error (emulated)." } }) });
      break;
    case "hang":
      streamText("This synthetic reply never finishes", 3);
      return { status: 200, headers: sseHeaders(), frames, stallAfterFrames: Math.min(frames.length, 2 + (script.afterEvents ?? 1)), stallBeforeHead: script.beforeHead === true };
    case "malformed":
      return malformedOpenAi(script.variant, input, frames, seq);
  }
  return { status: 200, headers: sseHeaders(), frames, stallAfterFrames: null, stallBeforeHead: false };
}

function sseHeaders(): Record<string, string> {
  return { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", "x-request-id": "req_emulated" };
}

function malformedOpenAi(variant: Extract<EmulatorScript, { kind: "malformed" }>["variant"], input: RenderInput, frames: Buffer[], seq: number): EmulatedResponse {
  const res = (f: Buffer[]) => ({ status: 200, headers: sseHeaders(), frames: f, stallAfterFrames: null, stallBeforeHead: false });
  switch (variant) {
    case "bad_json":
      return res([...frames, Buffer.from("event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\n\n")]);
    case "truncated":
      return res(frames);
    case "out_of_order":
      return res([...frames, sse({ type: "response.output_text.delta", sequence_number: 0, output_index: 0, item_id: "msg_x", content_index: 0, delta: "replayed", logprobs: [] })]);
    case "replayed_sequence":
      // The last event's sequence number again (a duplicated event), not a lower one.
      return res([...frames, sse({ type: "response.output_text.delta", sequence_number: seq - 1, output_index: 0, item_id: "msg_x", content_index: 0, delta: "replayed", logprobs: [] })]);
    case "missing_sequence_number": {
      // A well-formed text stream whose events carry no `sequence_number` at all, with one delta replayed: without
      // the field nothing would reveal the duplicate.
      const strip = (ev: Record<string, unknown>) => {
        const { sequence_number: _n, ...rest } = ev;
        return Buffer.from(`event: ${String(rest.type)}\ndata: ${JSON.stringify(rest)}\n\n`);
      };
      const delta = { type: "response.output_text.delta", output_index: 0, item_id: `msg_${input.seed}`, content_index: 0, delta: "Synthetic reply. ", logprobs: [] };
      const done = openAiResponse(input, "completed", [], { output_text: "Synthetic reply. Synthetic reply. " });
      return res([strip({ type: "response.created", response: openAiResponse(input, "in_progress", []) }), strip(delta), strip(delta), strip({ type: "response.completed", response: done })]);
    }
    case "refusal_terminal_only": {
      // Adversarial shape (OpenAI streams `response.refusal.delta` first): the refusal content part appears ONLY in the
      // terminal response, with no refusal or text delta before it.
      const item: ResponseOutputItem = { id: `msg_${input.seed}`, type: "message", role: "assistant", status: "completed", content: [{ type: "refusal", refusal: SYNTHETIC_REFUSAL_TEXT }] };
      return res([...frames, sse({ type: "response.completed", sequence_number: seq, response: openAiResponse(input, "completed", [item]) })]);
    }
    case "tool_call_unclosed": {
      // Adversarial shape: a function_call is announced and its arguments streamed, but neither
      // `function_call_arguments.done` nor `output_item.done` closes it before `response.completed` (whose output still
      // lists the call). A truncated call must never pass as a completed proposal.
      const args = JSON.stringify({ reference: "synthetic" });
      const item: ResponseOutputItem = { id: `fc_${input.seed}`, type: "function_call", call_id: `call_${input.seed}`, name: "lookup_status", arguments: args, status: "completed" };
      return res([
        ...frames,
        sse({ type: "response.output_item.added", sequence_number: seq, output_index: 0, item: { ...item, arguments: "", status: "in_progress" } }),
        sse({ type: "response.function_call_arguments.delta", sequence_number: seq + 1, output_index: 0, item_id: item.id as string, delta: args }),
        sse({ type: "response.completed", sequence_number: seq + 2, response: openAiResponse(input, "completed", [item]) }),
      ]);
    }
    case "terminal_status_mismatch": {
      // Adversarial shape: a `response.incomplete` event (output cut at max_output_tokens) whose embedded status claims
      // "completed". The truncated text must never become a completed, speakable answer.
      const text = "This synthetic reply was cut";
      const msgItem: ResponseOutputItem = { id: `msg_${input.seed}`, type: "message", role: "assistant", status: "incomplete", content: [{ type: "output_text", text, annotations: [] }] };
      return res([
        ...frames,
        sse({ type: "response.output_text.delta", sequence_number: seq, output_index: 0, item_id: `msg_${input.seed}`, content_index: 0, delta: text, logprobs: [] }),
        sse({ type: "response.incomplete", sequence_number: seq + 1, response: openAiResponse(input, "completed", [msgItem], { incomplete_details: { reason: "max_output_tokens" } }) } as ResponseStreamEvent),
      ]);
    }
    case "tool_call_not_streamed": {
      // Adversarial shape: plain text is streamed, and the terminal output carries a function_call that was never
      // announced by the stream. It must not be dropped silently (the reply would be spoken without the call).
      const text = "Your status is ready.";
      const msgItem: ResponseOutputItem = { id: `msg_${input.seed}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
      const hidden: ResponseOutputItem = { id: `fc_${input.seed}`, type: "function_call", call_id: `call_${input.seed}`, name: "lookup_status", arguments: JSON.stringify({ reference: "synthetic" }), status: "completed" };
      return res([
        ...frames,
        sse({ type: "response.output_text.delta", sequence_number: seq, output_index: 0, item_id: `msg_${input.seed}`, content_index: 0, delta: text, logprobs: [] }),
        sse({ type: "response.completed", sequence_number: seq + 1, response: openAiResponse(input, "completed", [msgItem, hidden], { output_text: text }) }),
      ]);
    }
    case "bad_tool_args": {
      const item: ResponseOutputItem = { id: `fc_${input.seed}`, type: "function_call", call_id: `call_${input.seed}`, name: "synthetic_tool", arguments: "{not json", status: "completed" };
      return res([
        ...frames,
        sse({ type: "response.output_item.added", sequence_number: seq, output_index: 0, item: { ...item, arguments: "", status: "in_progress" } }),
        sse({ type: "response.output_item.done", sequence_number: seq + 1, output_index: 0, item }),
        sse({ type: "response.completed", sequence_number: seq + 2, response: openAiResponse(input, "completed", [item]) }),
      ]);
    }
    default:
      return res([...frames, Buffer.from("data: not-json\n\n")]);
  }
}

/* ------------------------------------------------------------------------ */
/* vLLM Chat Completions                                                     */
/* ------------------------------------------------------------------------ */

const data = (chunk: ChatCompletionChunk | string): Buffer => Buffer.from(`data: ${typeof chunk === "string" ? chunk : JSON.stringify(chunk)}\n\n`);

export function renderChatCompletions(script: EmulatorScript, input: RenderInput, opts: { toolMarkup: string } = { toolMarkup: "<tool_call>" }): EmulatedResponse {
  const vllmError = (status: number, message: string, type: string, extra: Record<string, string> = {}) => json(status, { object: "error", message, type, param: null, code: status }, extra);
  switch (script.kind) {
    case "overload":
      if (!script.midStream) return vllmError(script.status ?? 503, "The engine is overloaded (emulated).", "ServiceUnavailableError", retryHeaders(script));
      break;
    case "request_rejected": {
      const status = script.status ?? 400;
      return vllmError(status, "Invalid request (emulated).", status === 404 ? "NotFoundError" : status === 422 ? "UnprocessableEntityError" : "BadRequestError");
    }
    case "context_window":
      return vllmError(400, "The prompt is longer than the maximum model length (emulated).", "BadRequestError");
    case "unexpected_status":
      return json(script.status, { object: "error", message: "Unexpected status (emulated).", type: "UnexpectedStatus", param: null });
    case "server_error":
      return vllmError(script.status ?? 500, "Internal server error (emulated).", "InternalServerError");
    case "auth_error":
      return json(401, { error: "Unauthorized" });
    case "quota_exhausted":
      return vllmError(429, "Too many requests (emulated).", "TooManyRequests");
    default:
      break;
  }
  const id = `chatcmpl-${input.seed}`;
  const model = script.kind === "malformed" && script.variant === "served_name_mismatch" ? `${input.model}-other` : input.model;
  const unnamed = script.kind === "malformed" && script.variant === "missing_served_name";
  const chunk = (delta: ChatCompletionChunk.Choice.Delta, finish: ChatCompletionChunk.Choice["finish_reason"] | "abort" = null): ChatCompletionChunk => {
    const c = { id, object: "chat.completion.chunk", created: input.createdAt, model, choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }] } as ChatCompletionChunk;
    if (unnamed) delete (c as Partial<ChatCompletionChunk>).model;
    return c;
  };
  const frames: Buffer[] = [data(chunk({ role: "assistant", content: "" }))];
  let out = 0;
  const usageChunk = (): ChatCompletionChunk => {
    const c: ChatCompletionChunk = { id, object: "chat.completion.chunk", created: input.createdAt, model, choices: [], usage: { prompt_tokens: tokensIn(input), completion_tokens: out, total_tokens: tokensIn(input) + out } };
    if (unnamed) delete (c as Partial<ChatCompletionChunk>).model;
    return c;
  };
  const text = (t: string, n: number) => {
    for (const d of split(t, n)) frames.push(data(chunk({ content: d })));
    out += words(t);
  };
  const end = (finish: ChatCompletionChunk.Choice["finish_reason"] | "abort") => {
    frames.push(data(chunk({}, finish)));
    frames.push(data(usageChunk()));
    frames.push(data("[DONE]"));
  };
  const sseOk = (f: Buffer[], stall: number | null = null, beforeHead = false): EmulatedResponse => ({ status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" }, frames: f, stallAfterFrames: stall, stallBeforeHead: beforeHead });
  switch (script.kind) {
    case "text":
      text(script.text, script.chunks ?? 3);
      end("stop");
      break;
    case "max_tokens":
      text(script.text ?? "This synthetic reply was cut", 2);
      end("length");
      break;
    case "tool_call": {
      const args = JSON.stringify(script.arguments);
      frames.push(data(chunk({ tool_calls: [{ index: 0, id: `chatcmpl-tool-${input.seed}`, type: "function", function: { name: script.name, arguments: "" } }] })));
      for (const d of split(args, 3)) frames.push(data(chunk({ tool_calls: [{ index: 0, function: { arguments: d } }] })));
      out += 8;
      end("tool_calls");
      break;
    }
    case "refusal":
    case "content_filter":
    case "guardrail":
      // vLLM has no refusal field, no content filter and no guardrail: a model that declines writes it as ordinary
      // content and stops normally.
      text(script.kind === "refusal" ? (script.message ?? SYNTHETIC_REFUSAL_TEXT) : SYNTHETIC_REFUSAL_TEXT, 2);
      end("stop");
      break;
    case "engine_abort":
      // The engine dropped the request before generating (preemption, shutdown): vLLM's `abort` finish reason.
      end("abort");
      break;
    case "overload":
      frames.push(data(JSON.stringify({ object: "error", message: "The engine is overloaded (emulated).", type: "ServiceUnavailableError", param: null, code: 503 })));
      break;
    case "stream_error":
      frames.push(data(JSON.stringify({ object: "error", message: "Internal server error (emulated).", type: "InternalServerError", param: null, code: 500 })));
      break;
    case "hang":
      text("This synthetic reply never finishes", 3);
      return sseOk(frames, Math.min(frames.length, 1 + (script.afterEvents ?? 1)), script.beforeHead === true);
    case "malformed":
      switch (script.variant) {
        case "tool_markup_leak":
          text(`${opts.toolMarkup}{"name": "synthetic_tool", "arguments": {}}`, 2);
          end("stop");
          break;
        case "bad_tool_args":
          frames.push(data(chunk({ tool_calls: [{ index: 0, id: `chatcmpl-tool-${input.seed}`, type: "function", function: { name: "synthetic_tool", arguments: "{not json" } }] })));
          end("tool_calls");
          break;
        case "served_name_mismatch":
          text("This reply names another model", 1);
          end("stop");
          break;
        case "missing_served_name":
          text("Reply from an unpinned model.", 1);
          end("stop");
          break;
        case "content_after_finish":
          // Adversarial shape: the choice finishes (stop), then more content arrives before the usage chunk and [DONE].
          text("Your request is approved", 1);
          frames.push(data(chunk({}, "stop")));
          frames.push(data(chunk({ content: " and the fee is waived." })));
          frames.push(data(usageChunk()));
          frames.push(data("[DONE]"));
          break;
        case "tool_call_renamed":
          // Adversarial shape: a tool call starts as one tool and a later delta at the same index names another one.
          frames.push(data(chunk({ tool_calls: [{ index: 0, id: `chatcmpl-tool-${input.seed}`, type: "function", function: { name: "lookup_status", arguments: "" } }] })));
          frames.push(data(chunk({ tool_calls: [{ index: 0, function: { name: "transfer_funds", arguments: JSON.stringify({ reference: "synthetic" }) } }] })));
          end("tool_calls");
          break;
        case "truncated":
          text("This synthetic reply is cut off", 2);
          break;
        default:
          frames.push(data("not-json"));
          break;
      }
      break;
  }
  return sseOk(frames);
}

/* ------------------------------------------------------------------------ */
/* Bedrock ConverseStream                                                    */
/* ------------------------------------------------------------------------ */

type Member<K extends string> = Extract<ConverseStreamOutput, Record<K, unknown>>[K & keyof Extract<ConverseStreamOutput, Record<K, unknown>>];
const ev = <K extends "messageStart" | "contentBlockStart" | "contentBlockDelta" | "contentBlockStop" | "messageStop" | "metadata">(k: K, body: Member<K>): Buffer => encodeEvent(k, body);

/** Bedrock's HTTP error document and `x-amzn-errortype` header for a modelled exception. */
export function bedrockHttpError(status: number, exception: string, message: string): EmulatedResponse {
  return json(status, { message }, { "x-amzn-errortype": `${exception}:http://internal.amazon.com/coral/com.amazon.bedrock/`, "x-amzn-requestid": "req-emulated" });
}

export function renderBedrockConverse(script: EmulatorScript, input: RenderInput): EmulatedResponse {
  switch (script.kind) {
    case "overload":
      if (!script.midStream) return (script.status ?? 429) === 503 ? bedrockHttpError(503, "ServiceUnavailableException", "Service unavailable (emulated).") : bedrockHttpError(429, "ThrottlingException", "Too many requests (emulated).");
      break;
    case "server_error":
      return bedrockHttpError(500, "InternalServerException", "Internal server error (emulated).");
    case "auth_error":
      return bedrockHttpError(403, "AccessDeniedException", "Access denied (emulated).");
    case "quota_exhausted":
      return bedrockHttpError(400, "ServiceQuotaExceededException", "Quota exceeded (emulated).");
    case "request_rejected":
      return (script.status ?? 400) === 404 ? bedrockHttpError(404, "ResourceNotFoundException", "The model was not found (emulated).") : bedrockHttpError(400, "ValidationException", "Malformed input request (emulated).");
    case "unexpected_status":
      return bedrockHttpError(script.status, "SyntheticUnmodelledException", "Unexpected status (emulated).");
    default:
      break;
  }
  const frames: Buffer[] = [ev("messageStart", { role: "assistant" })];
  let out = 0;
  const text = (t: string, n: number, index = 0) => {
    for (const d of split(t, n)) frames.push(ev("contentBlockDelta", { contentBlockIndex: index, delta: { text: d } }));
    frames.push(ev("contentBlockStop", { contentBlockIndex: index }));
    out += words(t);
  };
  const stop = (stopReason: NonNullable<Member<"messageStop">>["stopReason"]) => {
    frames.push(ev("messageStop", { stopReason }));
    frames.push(ev("metadata", { usage: { inputTokens: tokensIn(input), outputTokens: out, totalTokens: tokensIn(input) + out }, metrics: { latencyMs: 25 } }));
  };
  const ok = (stall: number | null = null, beforeHead = false): EmulatedResponse => ({
    status: 200,
    headers: { "content-type": "application/vnd.amazon.eventstream", "x-amzn-requestid": `req-${input.seed}` },
    frames,
    stallAfterFrames: stall,
    stallBeforeHead: beforeHead,
  });
  switch (script.kind) {
    case "text":
      text(script.text, script.chunks ?? 3);
      stop("end_turn");
      break;
    case "max_tokens":
      text(script.text ?? "This synthetic reply was cut", 2);
      stop("max_tokens");
      break;
    case "tool_call": {
      let index = 0;
      if (script.text) text(script.text, 1, index++);
      frames.push(ev("contentBlockStart", { contentBlockIndex: index, start: { toolUse: { toolUseId: `tooluse_${input.seed}`, name: script.name } } }));
      for (const d of split(JSON.stringify(script.arguments), 3)) frames.push(ev("contentBlockDelta", { contentBlockIndex: index, delta: { toolUse: { input: d } } }));
      frames.push(ev("contentBlockStop", { contentBlockIndex: index }));
      out += 8;
      stop("tool_use");
      break;
    }
    case "refusal":
    case "guardrail":
      if (input.guardrail) {
        // A request with a guardrail: the guardrail intervenes with its blocked-output message.
        text(GUARDRAIL_BLOCKED_TEXT, 1);
        stop("guardrail_intervened");
      } else {
        // No guardrail on the request: Bedrock never reports guardrail_intervened; the model declines in text.
        text(script.kind === "refusal" ? (script.message ?? SYNTHETIC_REFUSAL_TEXT) : SYNTHETIC_REFUSAL_TEXT, 1);
        stop("end_turn");
      }
      break;
    case "content_filter":
      stop("content_filtered");
      break;
    case "context_window":
      text("This synthetic reply ran out of context", 1);
      stop("model_context_window_exceeded");
      break;
    case "engine_abort":
      frames.push(encodeException("modelStreamErrorException", "The model stream failed (emulated)."));
      break;
    case "overload":
      frames.push(encodeException("throttlingException", "Too many requests (emulated)."));
      break;
    case "stream_error":
      frames.push(encodeException(script.code ?? "modelStreamErrorException", "The model stream failed (emulated)."));
      break;
    case "hang":
      text("This synthetic reply never finishes", 3);
      return ok(Math.min(frames.length, 1 + (script.afterEvents ?? 1)), script.beforeHead === true);
    case "malformed":
      switch (script.variant) {
        case "bad_tool_args":
          frames.push(ev("contentBlockStart", { contentBlockIndex: 0, start: { toolUse: { toolUseId: `tooluse_${input.seed}`, name: "synthetic_tool" } } }));
          frames.push(ev("contentBlockDelta", { contentBlockIndex: 0, delta: { toolUse: { input: "{not json" } } }));
          frames.push(ev("contentBlockStop", { contentBlockIndex: 0 }));
          stop("tool_use");
          break;
        case "truncated":
          text("This synthetic reply is cut off", 2);
          break;
        case "tool_call_unclosed":
          // Adversarial shape: a toolUse block streamed but never closed by contentBlockStop before messageStop tool_use.
          frames.push(ev("contentBlockStart", { contentBlockIndex: 0, start: { toolUse: { toolUseId: `tooluse_${input.seed}`, name: "lookup_status" } } }));
          frames.push(ev("contentBlockDelta", { contentBlockIndex: 0, delta: { toolUse: { input: JSON.stringify({ reference: "synthetic" }) } } }));
          stop("tool_use");
          break;
        case "content_after_finish":
          // Adversarial shape: the message stops (end_turn), then more text arrives before the metadata event.
          text("This synthetic reply is complete", 1);
          frames.push(ev("messageStop", { stopReason: "end_turn" }));
          frames.push(ev("contentBlockDelta", { contentBlockIndex: 0, delta: { text: " synthetic-after-stop-marker-02" } }));
          frames.push(ev("metadata", { usage: { inputTokens: tokensIn(input), outputTokens: 6, totalTokens: tokensIn(input) + 6 }, metrics: { latencyMs: 25 } }));
          break;
        case "tool_call_renamed":
          // Adversarial shape: a second contentBlockStart at the same index replaces the call mid-stream.
          frames.push(ev("contentBlockStart", { contentBlockIndex: 0, start: { toolUse: { toolUseId: `tooluse_${input.seed}`, name: "lookup_status" } } }));
          frames.push(ev("contentBlockDelta", { contentBlockIndex: 0, delta: { toolUse: { input: '{"reference":' } } }));
          frames.push(ev("contentBlockStart", { contentBlockIndex: 0, start: { toolUse: { toolUseId: `tooluse_${input.seed}b`, name: "transfer_funds" } } }));
          frames.push(ev("contentBlockDelta", { contentBlockIndex: 0, delta: { toolUse: { input: '{"reference":"synthetic"}' } } }));
          frames.push(ev("contentBlockStop", { contentBlockIndex: 0 }));
          stop("tool_use");
          break;
        case "refusal_overridden":
          // Adversarial shape: the guardrail intervenes, then a second messageStop end_turn tries to override it.
          text(GUARDRAIL_BLOCKED_TEXT, 1);
          frames.push(ev("messageStop", { stopReason: "guardrail_intervened" }));
          stop("end_turn");
          break;
        default: {
          // A frame whose message CRC is wrong (bad_crc and every other variant): the SDK's decoder must refuse it.
          text("This frame is corrupt", 1);
          const last = Buffer.from(frames[frames.length - 1] as Buffer);
          last.writeUInt32BE((last.readUInt32BE(last.length - 4) ^ 0xffffffff) >>> 0, last.length - 4);
          frames[frames.length - 1] = last;
          break;
        }
      }
      break;
  }
  return ok();
}
