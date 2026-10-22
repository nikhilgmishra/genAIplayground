/**
 * OpenAI Responses API adapter (WP-08; FO-09-07, FO-09-09, FO-19-09): `POST /v1/responses` with `stream: true`,
 * parsed as the documented Server-Sent Events of the Responses API. Request bodies are typed against the official
 * SDK's `ResponseCreateParamsStreaming` (type-only import: the wire client is the egress-classified transport).
 *
 * Provider semantics kept as they are:
 *  - text: `response.output_text.delta`; refusal: `response.refusal.delta` / `.done` (a REFUSED result, never text);
 *  - tool calls: `response.output_item.added` (function_call), `response.function_call_arguments.delta` / `.done`,
 *    `response.output_item.done`; arguments must parse to a JSON object or the result is MALFORMED. The stream must
 *    be consistent (security review r3, fail closed): a function_call that `response.output_item.done` never closed
 *    before a completed response (MODEL_TOOL_CALL_UNCLOSED), argument events after the item closed, a second
 *    `output_item.added` for an open index, or a closing item that renames the call (MODEL_TOOL_CALL_INVALID), a
 *    function_call in the terminal output that was never streamed (MODEL_TOOL_CALL_NOT_STREAMED), and a streamed
 *    call missing from, or different in, the terminal output (MODEL_TOOL_CALL_INCONSISTENT) are all MALFORMED;
 *  - terminal: `response.completed`, `response.incomplete` (max_output_tokens -> INCOMPLETE, content_filter ->
 *    REFUSED), `response.failed` and `error` (code -> error class); a stream without a terminal event is MALFORMED,
 *    and so is a terminal event whose embedded `response.status` disagrees with its type
 *    (MODEL_STREAM_STATUS_MISMATCH: the event type decides nothing on its own, and neither does the status);
 *  - every event carries `sequence_number` and it must increase strictly (a missing, replayed or reordered number is
 *    MALFORMED);
 *  - tool calls are returned as parsed proposals; the ResilientModelPort then checks them against the request
 *    (offered tool, tool choice, argument schema: port/tool-calls.ts);
 *  - usage: input, output, cached input and reasoning tokens from `response.usage`;
 *  - HTTP errors: 429 (`insufficient_quota` is PERMANENT, other 429s OVERLOADED with Retry-After / retry-after-ms),
 *    503 OVERLOADED, other 5xx RETRYABLE, 401/403 UNAVAILABLE (credential), 400/404/422 PERMANENT.
 * Data controls: every request is sent with `store: false` (no provider-side response storage, DATA-01, AIN-49).
 */
import type { ResponseCreateParamsStreaming, ResponseInputItem, FunctionTool } from "openai/resources/responses/responses";
import type { AttemptContext, AttemptResult, ModelAdapter } from "../port/adapter.js";
import type { BearerCredential } from "../port/credentials.js";
import { ModelCallError, errorClassForStatus, providerCode } from "../port/errors.js";
import type { ModelRequest, ModelToolCall, ModelUsage, OpenAiResponsesDetail } from "../port/types.js";
import type { ModelHttpExchange } from "./http-exchange.js";
import { parseJson, readBody, retryAfterFrom, watched } from "./http-exchange.js";
import { SseLimitError, SseParser } from "./sse.js";

export interface OpenAiResponsesSettings {
  /** Full `.../v1/responses` URL of the endpoint (models/port/config.ts invokeUrlFor). */
  url: URL;
  /** Provider model id: configuration data from the registry entry. */
  model: string;
  organization: string | null;
  project: string | null;
  strictToolSchemas: boolean;
  credential: BearerCredential;
  exchange: ModelHttpExchange;
  now?: () => Date;
}

/** The request body of one call (exported for the protocol tests). */
export function openAiResponsesBody(model: string, req: ModelRequest, strictTools: boolean): ResponseCreateParamsStreaming {
  const input: ResponseInputItem[] = [];
  for (const m of req.messages) {
    if (m.role === "user") input.push({ type: "message", role: "user", content: [{ type: "input_text", text: m.content }] });
    else if (m.role === "assistant") {
      if (m.content.length > 0) input.push({ role: "assistant", content: m.content });
      for (const c of m.toolCalls) input.push({ type: "function_call", call_id: c.callId, name: c.name, arguments: JSON.stringify(c.arguments) });
    } else input.push({ type: "function_call_output", call_id: m.callId, output: m.content });
  }
  const tools: FunctionTool[] = req.tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters, strict: strictTools }));
  const choice = req.toolChoice;
  const body: ResponseCreateParamsStreaming = {
    model,
    instructions: req.instructions,
    input,
    stream: true,
    store: false,
    max_output_tokens: req.budget.maxOutputTokens,
    ...(tools.length > 0 ? { tools, tool_choice: typeof choice === "string" ? choice : { type: "function", name: choice.name }, parallel_tool_calls: true } : {}),
    ...(req.temperature !== null ? { temperature: req.temperature } : {}),
    ...(req.responseSchema ? { text: { format: { type: "json_schema", name: req.responseSchema.name, schema: req.responseSchema.schema, strict: true } } } : {}),
  };
  return body;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null);

function usageOf(u: unknown): ModelUsage | null {
  if (!isObj(u)) return null;
  const input = num(u.input_tokens);
  const output = num(u.output_tokens);
  if (input === null || output === null) return null;
  const cached = isObj(u.input_tokens_details) ? num(u.input_tokens_details.cached_tokens) : null;
  const reasoning = isObj(u.output_tokens_details) ? num(u.output_tokens_details.reasoning_tokens) : null;
  return { inputTokens: input, outputTokens: output, cachedInputTokens: cached, reasoningTokens: reasoning };
}

/** `error.code` of a failed response or an `error` event, mapped to the typed failure. */
function failureFor(code: string | null, detail: OpenAiResponsesDetail): ModelCallError {
  if (code === "rate_limit_exceeded" || code === "server_is_overloaded" || code === "slow_down") {
    return new ModelCallError({ kind: "OVERLOADED", reasonCode: "MODEL_OVERLOADED", errorClass: "RETRYABLE", detail });
  }
  if (code === "server_error" || code === "internal_error") return new ModelCallError({ kind: "FAILED", reasonCode: "MODEL_SERVER_ERROR", errorClass: "RETRYABLE", detail });
  if (code === "insufficient_quota") return new ModelCallError({ kind: "FAILED", reasonCode: "MODEL_QUOTA_EXHAUSTED", errorClass: "PERMANENT", detail });
  if (code !== null && /^(invalid_|context_length|unsupported|model_not_found)/.test(code)) return new ModelCallError({ kind: "FAILED", reasonCode: "MODEL_REQUEST_REJECTED", errorClass: "PERMANENT", detail });
  return new ModelCallError({ kind: "FAILED", reasonCode: "MODEL_RESPONSE_FAILED", errorClass: "UNKNOWN", detail });
}

/** HTTP status (and the documented error body) of a refused request, mapped to the typed failure. */
export function openAiHttpFailure(status: number, body: unknown, headers: Readonly<Record<string, string>>, now: Date): ModelCallError {
  const err = isObj(body) && isObj(body.error) ? body.error : {};
  const code = providerCode(err.code) ?? providerCode(err.type);
  const detail: OpenAiResponsesDetail = { provider: "openai_responses", responseId: null, status: null, incompleteReason: null, errorCode: code };
  const retryAfterMs = retryAfterFrom(headers, now);
  if (status === 429 && code === "insufficient_quota") return new ModelCallError({ kind: "FAILED", reasonCode: "MODEL_QUOTA_EXHAUSTED", errorClass: "PERMANENT", httpStatus: status, detail });
  if (status === 429 || status === 503) return new ModelCallError({ kind: "OVERLOADED", reasonCode: "MODEL_OVERLOADED", errorClass: "RETRYABLE", httpStatus: status, retryAfterMs, detail });
  if (status === 401 || status === 403) return new ModelCallError({ kind: "UNAVAILABLE", reasonCode: "MODEL_AUTH_REJECTED", errorClass: "PERMANENT", httpStatus: status, detail });
  if (status >= 500) return new ModelCallError({ kind: "FAILED", reasonCode: "MODEL_SERVER_ERROR", errorClass: "RETRYABLE", httpStatus: status, retryAfterMs, detail });
  const cls = errorClassForStatus(status);
  return new ModelCallError({ kind: "FAILED", reasonCode: cls === "PERMANENT" ? "MODEL_REQUEST_REJECTED" : "MODEL_HTTP_ERROR", errorClass: cls, httpStatus: status, retryAfterMs, detail });
}

interface PendingCall {
  index: number;
  callId: string;
  name: string;
  args: string;
  /** Closed by `response.output_item.done` (the only event that closes an output item). */
  done: boolean;
}

/** The `response.status` each terminal event type must carry (the documented pairs). */
const TERMINAL_STATUS: Readonly<Record<string, string>> = { "response.completed": "completed", "response.incomplete": "incomplete", "response.failed": "failed" };

export class OpenAiResponsesAdapter implements ModelAdapter {
  readonly provider = "openai_responses" as const;
  /** `text.format` json_schema with `strict: true`; the port still validates the answer text (tool-calls.ts). */
  readonly supportsStructuredOutput = true;
  private readonly now: () => Date;

  constructor(private readonly s: OpenAiResponsesSettings) {
    this.now = s.now ?? (() => new Date());
  }

  async attempt(req: ModelRequest, ctx: AttemptContext): Promise<AttemptResult> {
    let key: string;
    try {
      key = await this.s.credential.token();
    } catch {
      throw new ModelCallError({ kind: "UNAVAILABLE", reasonCode: "MODEL_CREDENTIAL_UNAVAILABLE", errorClass: "PERMANENT", notStarted: true });
    }
    const headers: Record<string, string> = { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "text/event-stream" };
    if (this.s.organization) headers["openai-organization"] = this.s.organization;
    if (this.s.project) headers["openai-project"] = this.s.project;
    const abort = new AbortController();
    const signal = AbortSignal.any([ctx.signal, abort.signal]);
    const res = await this.s.exchange.send({
      method: "POST",
      url: this.s.url,
      headers,
      body: JSON.stringify(openAiResponsesBody(this.s.model, req, this.s.strictToolSchemas)),
      dataClass: req.dataClass,
      timeoutMs: req.budget.attemptTimeoutMs,
      signal,
    });
    if (res.status !== 200) {
      const body = parseJson(await readBody(res.body).catch(() => Buffer.alloc(0)));
      throw openAiHttpFailure(res.status, body, res.headers, this.now());
    }
    if (!(res.headers["content-type"] ?? "").toLowerCase().startsWith("text/event-stream")) {
      throw new ModelCallError({ kind: "MALFORMED", reasonCode: "MODEL_STREAM_CONTENT_TYPE", errorClass: "PERMANENT", httpStatus: res.status });
    }
    return this.consume(req, ctx, res.body, abort);
  }

  private async consume(req: ModelRequest, ctx: AttemptContext, body: AsyncIterable<Buffer>, abort: AbortController): Promise<AttemptResult> {
    const detail: OpenAiResponsesDetail = { provider: "openai_responses", responseId: null, status: null, incompleteReason: null, errorCode: null };
    const parser = new SseParser();
    const calls = new Map<number, PendingCall>();
    let text = "";
    let refused = false;
    let lastSeq = -1;
    let terminal: Json | null = null;
    let terminalType: string | null = null;
    const malformed = (reasonCode: string) => new ModelCallError({ kind: "MALFORMED", reasonCode, errorClass: "PERMANENT", detail });

    const handle = (data: string): void => {
      if (data === "[DONE]") return;
      const ev = parseJson(data);
      if (!isObj(ev) || typeof ev.type !== "string") throw malformed("MODEL_STREAM_EVENT_INVALID");
      // Every Responses stream event carries `sequence_number`; a missing one is MALFORMED (fail closed), so a replayed
      // or reordered event can never slip through as an event without a number.
      const seq = num(ev.sequence_number);
      if (seq === null) throw malformed("MODEL_STREAM_SEQUENCE_MISSING");
      if (seq <= lastSeq) throw malformed("MODEL_STREAM_OUT_OF_ORDER");
      lastSeq = seq;
      switch (ev.type) {
        case "response.created":
        case "response.in_progress":
        case "response.queued":
          if (isObj(ev.response) && typeof ev.response.id === "string") detail.responseId = providerCode(ev.response.id) ?? detail.responseId;
          return;
        case "response.output_text.delta":
          if (typeof ev.delta !== "string") throw malformed("MODEL_STREAM_EVENT_INVALID");
          text += ev.delta;
          ctx.emit({ type: "text_delta", text: ev.delta });
          return;
        case "response.refusal.delta":
          refused = true;
          if (typeof ev.delta === "string") ctx.emit({ type: "refusal_delta", text: ev.delta });
          return;
        case "response.refusal.done":
          refused = true;
          return;
        case "response.output_item.added": {
          const item = isObj(ev.item) ? ev.item : null;
          const index = num(ev.output_index);
          if (item?.type === "function_call") {
            if (index === null || typeof item.call_id !== "string" || typeof item.name !== "string") throw malformed("MODEL_TOOL_CALL_INVALID");
            // One item per output index: a second `added` would silently replace (or re-open) a call.
            if (calls.has(index)) throw malformed("MODEL_TOOL_CALL_INVALID");
            calls.set(index, { index, callId: item.call_id, name: item.name, args: typeof item.arguments === "string" ? item.arguments : "", done: false });
            ctx.emit({ type: "tool_call_started", index, callId: item.call_id, name: item.name });
          }
          return;
        }
        case "response.function_call_arguments.delta": {
          const c = calls.get(num(ev.output_index) ?? -1);
          if (!c || c.done || typeof ev.delta !== "string") throw malformed("MODEL_TOOL_CALL_INVALID");
          c.args += ev.delta;
          ctx.emit({ type: "tool_call_arguments_delta", index: c.index, delta: ev.delta });
          return;
        }
        case "response.function_call_arguments.done": {
          const c = calls.get(num(ev.output_index) ?? -1);
          if (!c || c.done || typeof ev.arguments !== "string") throw malformed("MODEL_TOOL_CALL_INVALID");
          c.args = ev.arguments;
          return;
        }
        case "response.output_item.done": {
          const item = isObj(ev.item) ? ev.item : null;
          if (item?.type === "function_call") {
            const c = calls.get(num(ev.output_index) ?? -1);
            if (!c || c.done) throw malformed("MODEL_TOOL_CALL_INVALID");
            // The closing item is the same call: a different call id or name is a rename, never accepted.
            if ((item.call_id !== undefined && item.call_id !== c.callId) || (item.name !== undefined && item.name !== c.name)) throw malformed("MODEL_TOOL_CALL_INVALID");
            if (typeof item.arguments === "string") c.args = item.arguments;
            c.done = true;
          }
          return;
        }
        case "response.completed":
        case "response.incomplete":
        case "response.failed":
          terminal = isObj(ev.response) ? ev.response : {};
          terminalType = ev.type;
          return;
        case "error":
          detail.errorCode = providerCode(ev.code);
          throw failureFor(detail.errorCode, detail);
        default:
          // Other documented events (content parts, annotations, reasoning summaries) carry nothing the port uses.
          return;
      }
    };

    try {
      for await (const chunk of watched(body, { incremental: this.s.exchange.incremental, firstEventTimeoutMs: req.budget.firstEventTimeoutMs, idleTimeoutMs: req.budget.idleTimeoutMs, abort: () => abort.abort() })) {
        for (const e of parser.push(chunk)) {
          handle(e.data);
          if (terminal) break;
        }
        if (terminal) break;
      }
      if (!terminal) for (const e of parser.end()) handle(e.data);
    } catch (err) {
      if (err instanceof SseLimitError) throw malformed(err.reasonCode === "SSE_EVENT_TOO_LARGE" ? "MODEL_STREAM_EVENT_TOO_LARGE" : "MODEL_STREAM_TOO_LONG");
      throw err;
    }
    const final = terminal as Json | null;
    if (!final) throw malformed("MODEL_STREAM_TRUNCATED");
    if (typeof final.id === "string") detail.responseId = providerCode(final.id) ?? detail.responseId;
    const status = typeof final.status === "string" ? final.status : null;
    detail.status = status === "completed" || status === "incomplete" || status === "failed" || status === "cancelled" || status === "in_progress" || status === "queued" ? status : null;
    const usage: ModelUsage | null = usageOf(final.usage);
    if (usage) ctx.emit({ type: "usage", usage });
    // The terminal event type and the embedded status must agree (response.completed / completed, response.incomplete /
    // incomplete, response.failed / failed): a truncated or failed response never passes as completed, whichever of
    // the two says "completed".
    if (terminalType === null || status !== TERMINAL_STATUS[terminalType]) throw malformed("MODEL_STREAM_STATUS_MISMATCH");

    if (detail.status === "failed") {
      detail.errorCode = isObj(final.error) ? providerCode(final.error.code) : null;
      throw failureFor(detail.errorCode, detail);
    }
    if (detail.status === "incomplete") {
      const reason = isObj(final.incomplete_details) ? final.incomplete_details.reason : null;
      detail.incompleteReason = reason === "max_output_tokens" || reason === "content_filter" ? reason : null;
      if (detail.incompleteReason === "content_filter") return { provider: this.provider, outcome: "REFUSED", refusal: { source: "CONTENT_FILTER", reasonCode: "MODEL_CONTENT_FILTERED" }, usage, detail };
      return { provider: this.provider, outcome: "INCOMPLETE", reasonCode: detail.incompleteReason === "max_output_tokens" ? "MODEL_MAX_OUTPUT_TOKENS" : "MODEL_INCOMPLETE", usage, detail };
    }
    if (detail.status !== "completed") throw malformed("MODEL_STREAM_STATUS_UNKNOWN");
    // The terminal response repeats the output; a refusal content part there is a refusal even when no refusal delta
    // was streamed (fail closed: a refusal is never returned as COMPLETED, empty or not).
    if (!refused && Array.isArray(final.output)) {
      refused = final.output.some((item) => isObj(item) && item.type === "message" && Array.isArray(item.content) && item.content.some((part) => isObj(part) && part.type === "refusal"));
    }
    if (refused) return { provider: this.provider, outcome: "REFUSED", refusal: { source: "MODEL_REFUSAL", reasonCode: "MODEL_REFUSED" }, usage, detail };
    // Tool calls of a completed response: every streamed call was closed, and the terminal output repeats exactly the
    // streamed calls (none added, none dropped, none changed).
    const inconsistent = toolCallStreamInconsistency(calls, final.output);
    if (inconsistent) return { provider: this.provider, outcome: "MALFORMED", reasonCode: inconsistent, usage, detail };
    const toolCalls: ModelToolCall[] = [];
    for (const c of [...calls.values()].sort((a, b) => a.index - b.index)) {
      const args = parseJson(c.args.length > 0 ? c.args : "{}");
      if (!isObj(args)) return { provider: this.provider, outcome: "MALFORMED", reasonCode: "MODEL_TOOL_ARGUMENTS_INVALID", usage, detail };
      if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(c.callId) || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(c.name)) return { provider: this.provider, outcome: "MALFORMED", reasonCode: "MODEL_TOOL_CALL_INVALID", usage, detail };
      toolCalls.push({ callId: c.callId, name: c.name, arguments: args });
    }
    return { provider: this.provider, outcome: "COMPLETED", text, toolCalls, usage, detail };
  }
}

/**
 * Consistency of the streamed function calls with the terminal output of a completed response (null when
 * consistent). The terminal `response.output` is the complete list of output items, so it must contain every
 * streamed call, with the same name and arguments, and no function call the stream never announced.
 */
function toolCallStreamInconsistency(calls: ReadonlyMap<number, PendingCall>, output: unknown): string | null {
  for (const c of calls.values()) if (!c.done) return "MODEL_TOOL_CALL_UNCLOSED";
  if (!Array.isArray(output)) return calls.size > 0 ? "MODEL_TOOL_CALL_INCONSISTENT" : null;
  const streamed = new Map<string, PendingCall>([...calls.values()].map((c) => [c.callId, c]));
  const seen = new Set<string>();
  for (const item of output) {
    if (!isObj(item) || item.type !== "function_call") continue;
    const c = typeof item.call_id === "string" ? streamed.get(item.call_id) : undefined;
    if (!c) return "MODEL_TOOL_CALL_NOT_STREAMED";
    if (seen.has(c.callId)) return "MODEL_TOOL_CALL_INCONSISTENT";
    seen.add(c.callId);
    if (item.name !== c.name || (typeof item.arguments === "string" && item.arguments !== c.args)) return "MODEL_TOOL_CALL_INCONSISTENT";
  }
  return seen.size === streamed.size ? null : "MODEL_TOOL_CALL_INCONSISTENT";
}
