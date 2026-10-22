/**
 * Self-hosted vLLM adapter over vLLM's OpenAI-compatible Chat Completions server (WP-08; FO-09-08, FO-09-09).
 * `POST /v1/chat/completions` with `stream: true` and `stream_options.include_usage`, parsed as the documented
 * `chat.completion.chunk` Server-Sent Events ending with `data: [DONE]`. Request bodies are typed against the
 * official SDK's `ChatCompletionCreateParamsStreaming` (type-only import).
 *
 * vLLM-specific semantics kept as they are (compatibility is not universal):
 *  - tool calls exist only through the server's tool-call parser (`--enable-auto-tool-choice --tool-call-parser`),
 *    which is pinned per endpoint (`toolParser`, from the registry's model family). If the parser fails, raw
 *    tool-call markup of that parser leaks into `content`; the adapter detects the parser's markers and returns
 *    MALFORMED (`MODEL_TOOL_MARKUP_LEAKED`), so leaked markup is never spoken or treated as text;
 *  - every chunk names the served model; a chunk naming another model, or none, is MALFORMED
 *    (`MODEL_SERVED_NAME_MISMATCH`, `MODEL_SERVED_NAME_MISSING`): a self-hosted endpoint can never silently serve a
 *    different model than the one pinned;
 *  - `finish_reason`: stop / tool_calls -> COMPLETED, length -> INCOMPLETE, abort -> RETRYABLE failure (the engine
 *    dropped the request), error -> RETRYABLE server error, anything else -> MALFORMED;
 *  - refusals: vLLM has no refusal field and no content filter; a model refuses in plain content with
 *    `finish_reason: stop`, which the port's refusal classifier (port/refusal.ts) turns into REFUSED
 *    CLASSIFIED_REFUSAL. An OpenAI-style `refusal` delta from a server behind the endpoint is still a refusal;
 *  - structured output through `response_format: json_schema` (vLLM guided decoding) when the endpoint enables it; a
 *    request with a response schema to an endpoint without it is refused before any I/O
 *    (MODEL_STRUCTURED_OUTPUT_UNSUPPORTED, security review r4), never sent with the schema silently dropped;
 *  - errors: vLLM's error document (`{"object":"error", "code": <status>}`) in the body or inside the stream.
 */
import type { ChatCompletionCreateParamsStreaming, ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions/completions";
import type { AttemptContext, AttemptResult, ModelAdapter } from "../port/adapter.js";
import type { VllmToolParser } from "../port/config.js";
import type { BearerCredential } from "../port/credentials.js";
import { ModelCallError, errorClassForStatus, providerCode } from "../port/errors.js";
import type { ModelRequest, ModelToolCall, ModelUsage, VllmChatDetail } from "../port/types.js";
import type { ModelHttpExchange } from "./http-exchange.js";
import { parseJson, readBody, retryAfterFrom, watched } from "./http-exchange.js";
import { SseLimitError, SseParser } from "./sse.js";

export interface VllmChatSettings {
  /** Full `.../v1/chat/completions` URL. */
  url: URL;
  /** `--served-model-name` the endpoint is pinned to (configuration data). */
  servedModel: string;
  toolParser: VllmToolParser;
  structuredOutput: "json_schema" | "none";
  /** vLLM `--api-key`, when the server requires one (null: private network only, no key). */
  credential: BearerCredential | null;
  exchange: ModelHttpExchange;
  now?: () => Date;
}

/**
 * Raw markup each vLLM tool parser consumes. Finding it in `content` means the parser did not recognise a tool call
 * (wrong parser for the model family, or a malformed call): the output is MALFORMED, never text.
 */
export const TOOL_PARSER_MARKERS: Readonly<Record<VllmToolParser, RegExp>> = {
  hermes: /<\/?tool_call>/,
  mistral: /\[TOOL_CALLS\]/,
  llama3_json: /<\|python_tag\|>|^\s*\{\s*"(name|type)"\s*:/,
  llama4_pythonic: /<\|python_start\|>|^\s*\[[A-Za-z_]\w*\(/,
  pythonic: /^\s*\[[A-Za-z_]\w*\(/,
  granite: /<\|tool_call\|>|<tool_call>/,
  "granite-20b-fc": /<function_call>/,
  internlm: /<\|action_start\|>/,
  jamba: /<\/?tool_calls>/,
  xlam: /\[TOOL_CALLS\]|<tool_call>|^\s*\[\s*\{\s*"name"\s*:/,
  phi4_mini_json: /functools\[/,
  deepseek_v3: /<｜tool▁calls▁begin｜>|<｜tool▁call▁begin｜>/,
  kimi_k2: /<\|tool_calls_section_begin\|>|<\|tool_call_begin\|>/,
  qwen3_coder: /<tool_call>|<function=/,
  openai: /<\|call\|>|<\|channel\|>commentary/,
};

export function vllmChatBody(servedModel: string, req: ModelRequest, structuredOutput: "json_schema" | "none"): ChatCompletionCreateParamsStreaming {
  if (req.responseSchema && structuredOutput !== "json_schema") throw structuredOutputUnsupported();
  const messages: ChatCompletionMessageParam[] = [{ role: "system", content: req.instructions }];
  for (const m of req.messages) {
    if (m.role === "user") messages.push({ role: "user", content: m.content });
    else if (m.role === "assistant") {
      messages.push({
        role: "assistant",
        content: m.content.length > 0 ? m.content : null,
        ...(m.toolCalls.length > 0 ? { tool_calls: m.toolCalls.map((c) => ({ id: c.callId, type: "function" as const, function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) } : {}),
      });
    } else messages.push({ role: "tool", tool_call_id: m.callId, content: m.content });
  }
  const tools: ChatCompletionTool[] = req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
  const choice = req.toolChoice;
  return {
    model: servedModel,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    max_completion_tokens: req.budget.maxOutputTokens,
    ...(tools.length > 0 ? { tools, tool_choice: typeof choice === "string" ? choice : { type: "function", function: { name: choice.name } } } : {}),
    ...(req.temperature !== null ? { temperature: req.temperature } : {}),
    ...(req.responseSchema ? { response_format: { type: "json_schema", json_schema: { name: req.responseSchema.name, schema: req.responseSchema.schema, strict: true } } } : {}),
  };
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null);

/** vLLM's error document (`{"object":"error",...}` or `{"error":{...}}`): its numeric code, when present. */
function vllmErrorStatus(doc: unknown): number | null {
  if (!isObj(doc)) return null;
  const e = isObj(doc.error) ? doc.error : doc.object === "error" ? doc : null;
  if (!e) return null;
  const code = typeof e.code === "number" ? e.code : typeof e.code === "string" && /^\d{3}$/.test(e.code) ? Number(e.code) : null;
  return code ?? 500;
}

export function vllmHttpFailure(status: number, headers: Readonly<Record<string, string>>, now: Date, detail: VllmChatDetail): ModelCallError {
  const retryAfterMs = retryAfterFrom(headers, now);
  if (status === 429 || status === 503) return new ModelCallError({ kind: "OVERLOADED", reasonCode: "MODEL_OVERLOADED", errorClass: "RETRYABLE", httpStatus: status, retryAfterMs, detail });
  if (status === 401 || status === 403) return new ModelCallError({ kind: "UNAVAILABLE", reasonCode: "MODEL_AUTH_REJECTED", errorClass: "PERMANENT", httpStatus: status, detail });
  if (status >= 500) return new ModelCallError({ kind: "FAILED", reasonCode: "MODEL_SERVER_ERROR", errorClass: "RETRYABLE", httpStatus: status, retryAfterMs, detail });
  const cls = errorClassForStatus(status);
  return new ModelCallError({ kind: "FAILED", reasonCode: cls === "PERMANENT" ? "MODEL_REQUEST_REJECTED" : "MODEL_HTTP_ERROR", errorClass: cls, httpStatus: status, detail });
}

interface PendingCall {
  index: number;
  callId: string;
  name: string;
  args: string;
}

const structuredOutputUnsupported = () => new ModelCallError({ kind: "FAILED", reasonCode: "MODEL_STRUCTURED_OUTPUT_UNSUPPORTED", errorClass: "PERMANENT", notStarted: true });

export class VllmChatAdapter implements ModelAdapter {
  readonly provider = "vllm_openai_compatible" as const;
  readonly supportsStructuredOutput: boolean;
  private readonly now: () => Date;

  constructor(private readonly s: VllmChatSettings) {
    this.now = s.now ?? (() => new Date());
    this.supportsStructuredOutput = s.structuredOutput === "json_schema";
  }

  async attempt(req: ModelRequest, ctx: AttemptContext): Promise<AttemptResult> {
    // Defense in depth (the port refuses first): never send a structured-output request with its schema dropped.
    if (req.responseSchema && this.s.structuredOutput !== "json_schema") throw structuredOutputUnsupported();
    const headers: Record<string, string> = { "content-type": "application/json", accept: "text/event-stream" };
    if (this.s.credential) {
      try {
        headers.authorization = `Bearer ${await this.s.credential.token()}`;
      } catch {
        throw new ModelCallError({ kind: "UNAVAILABLE", reasonCode: "MODEL_CREDENTIAL_UNAVAILABLE", errorClass: "PERMANENT", notStarted: true });
      }
    }
    const detail: VllmChatDetail = { provider: this.provider, completionId: null, finishReason: null, toolParser: this.s.toolParser, servedModel: null };
    const abort = new AbortController();
    const res = await this.s.exchange.send({
      method: "POST",
      url: this.s.url,
      headers,
      body: JSON.stringify(vllmChatBody(this.s.servedModel, req, this.s.structuredOutput)),
      dataClass: req.dataClass,
      timeoutMs: req.budget.attemptTimeoutMs,
      signal: AbortSignal.any([ctx.signal, abort.signal]),
    });
    if (res.status !== 200) {
      await readBody(res.body).catch(() => Buffer.alloc(0));
      throw vllmHttpFailure(res.status, res.headers, this.now(), detail);
    }
    if (!(res.headers["content-type"] ?? "").toLowerCase().startsWith("text/event-stream")) {
      throw new ModelCallError({ kind: "MALFORMED", reasonCode: "MODEL_STREAM_CONTENT_TYPE", errorClass: "PERMANENT", httpStatus: res.status, detail });
    }
    const malformed = (reasonCode: string) => new ModelCallError({ kind: "MALFORMED", reasonCode, errorClass: "PERMANENT", detail });
    const parser = new SseParser();
    const calls = new Map<number, PendingCall>();
    let text = "";
    let refused = false;
    let usage: ModelUsage | null = null;
    let done = false;

    const handle = (data: string) => {
      if (data === "[DONE]") {
        done = true;
        return;
      }
      const chunk = parseJson(data);
      const errStatus = vllmErrorStatus(chunk);
      if (errStatus !== null) throw vllmHttpFailure(errStatus, {}, this.now(), detail);
      if (!isObj(chunk) || chunk.object !== "chat.completion.chunk" || !Array.isArray(chunk.choices)) throw malformed("MODEL_STREAM_EVENT_INVALID");
      // vLLM names the served model on EVERY chunk (the usage chunk included): a missing name is MALFORMED, so the
      // pin cannot be bypassed by a server that omits the field.
      if (typeof chunk.model !== "string") throw malformed("MODEL_SERVED_NAME_MISSING");
      if (chunk.model !== this.s.servedModel) throw malformed("MODEL_SERVED_NAME_MISMATCH");
      detail.servedModel = chunk.model;
      if (typeof chunk.id === "string") detail.completionId = providerCode(chunk.id) ?? detail.completionId;
      if (isObj(chunk.usage)) {
        const p = num(chunk.usage.prompt_tokens);
        const c = num(chunk.usage.completion_tokens);
        if (p !== null && c !== null) usage = { inputTokens: p, outputTokens: c, cachedInputTokens: isObj(chunk.usage.prompt_tokens_details) ? num(chunk.usage.prompt_tokens_details.cached_tokens) : null, reasoningTokens: null };
      }
      for (const choice of chunk.choices) {
        if (!isObj(choice) || choice.index !== 0) continue;
        const delta = isObj(choice.delta) ? choice.delta : {};
        // The choice finished in an earlier chunk: nothing may follow it except the usage chunk (choices: []) and
        // [DONE]. Content, a refusal, a tool-call delta or a second finish_reason after it is MALFORMED, so text can
        // never be appended to an answer the server already ended.
        if (detail.finishReason !== null) {
          const carries = (typeof delta.content === "string" && delta.content.length > 0) || (typeof delta.refusal === "string" && delta.refusal.length > 0) || (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) || typeof choice.finish_reason === "string";
          if (carries) throw malformed("MODEL_STREAM_CONTENT_AFTER_FINISH");
        }
        if (typeof delta.content === "string" && delta.content.length > 0) {
          text += delta.content;
          ctx.emit({ type: "text_delta", text: delta.content });
        }
        // vLLM itself never streams `refusal` (its refusals are plain content, classified by the port's refusal
        // classifier); a server behind this endpoint that sends the OpenAI field is still treated as refusing.
        if (typeof delta.refusal === "string" && delta.refusal.length > 0) {
          refused = true;
          ctx.emit({ type: "refusal_delta", text: delta.refusal });
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            if (!isObj(tc)) throw malformed("MODEL_TOOL_CALL_INVALID");
            const index = num(tc.index);
            if (index === null) throw malformed("MODEL_TOOL_CALL_INVALID");
            const fn = isObj(tc.function) ? tc.function : {};
            let c = calls.get(index);
            if (!c) {
              if (typeof tc.id !== "string" || typeof fn.name !== "string") throw malformed("MODEL_TOOL_CALL_INVALID");
              c = { index, callId: tc.id, name: fn.name, args: "" };
              calls.set(index, c);
              ctx.emit({ type: "tool_call_started", index, callId: c.callId, name: c.name });
            } else if ((typeof tc.id === "string" && tc.id !== c.callId) || (typeof fn.name === "string" && fn.name.length > 0 && fn.name !== c.name)) {
              // A later delta at the same index that names another call id or tool is a rename (or a second call
              // folded into the first): never accepted as the original proposal.
              throw malformed("MODEL_TOOL_CALL_INVALID");
            }
            if (typeof fn.arguments === "string" && fn.arguments.length > 0) {
              c.args += fn.arguments;
              ctx.emit({ type: "tool_call_arguments_delta", index, delta: fn.arguments });
            }
          }
        }
        const fr = choice.finish_reason;
        if (typeof fr === "string") {
          // vLLM's finish reasons; `content_filter` (an OpenAI value vLLM has no filter for) is unknown here: MALFORMED.
          if (fr === "stop" || fr === "length" || fr === "tool_calls" || fr === "abort" || fr === "error") detail.finishReason = fr;
          else throw malformed("MODEL_FINISH_REASON_UNKNOWN");
        }
      }
    };

    try {
      for await (const chunk of watched(res.body, { incremental: this.s.exchange.incremental, firstEventTimeoutMs: req.budget.firstEventTimeoutMs, idleTimeoutMs: req.budget.idleTimeoutMs, abort: () => abort.abort() })) {
        for (const e of parser.push(chunk)) {
          handle(e.data);
          if (done) break;
        }
        if (done) break;
      }
      if (!done) for (const e of parser.end()) handle(e.data);
    } catch (err) {
      if (err instanceof SseLimitError) throw malformed(err.reasonCode === "SSE_EVENT_TOO_LARGE" ? "MODEL_STREAM_EVENT_TOO_LARGE" : "MODEL_STREAM_TOO_LONG");
      throw err;
    }
    if (usage) ctx.emit({ type: "usage", usage });
    if (refused) return { provider: this.provider, outcome: "REFUSED", refusal: { source: "MODEL_REFUSAL", reasonCode: "MODEL_REFUSED" }, usage, detail };
    if (detail.finishReason === null) throw malformed("MODEL_STREAM_TRUNCATED");
    if (detail.finishReason === "abort") throw new ModelCallError({ kind: "FAILED", reasonCode: "MODEL_SERVER_ABORTED", errorClass: "RETRYABLE", detail });
    if (detail.finishReason === "error") throw new ModelCallError({ kind: "FAILED", reasonCode: "MODEL_SERVER_ERROR", errorClass: "RETRYABLE", detail });
    if (TOOL_PARSER_MARKERS[this.s.toolParser].test(text)) return { provider: this.provider, outcome: "MALFORMED", reasonCode: "MODEL_TOOL_MARKUP_LEAKED", usage, detail };
    if (detail.finishReason === "length") return { provider: this.provider, outcome: "INCOMPLETE", reasonCode: "MODEL_MAX_OUTPUT_TOKENS", usage, detail };
    const toolCalls: ModelToolCall[] = [];
    for (const c of [...calls.values()].sort((a, b) => a.index - b.index)) {
      const args = parseJson(c.args.length > 0 ? c.args : "{}");
      if (!isObj(args) || !/^[A-Za-z0-9_.:-]{1,128}$/.test(c.callId) || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(c.name)) {
        return { provider: this.provider, outcome: "MALFORMED", reasonCode: "MODEL_TOOL_ARGUMENTS_INVALID", usage, detail };
      }
      toolCalls.push({ callId: c.callId, name: c.name, arguments: args });
    }
    return { provider: this.provider, outcome: "COMPLETED", text, toolCalls, usage, detail };
  }
}
