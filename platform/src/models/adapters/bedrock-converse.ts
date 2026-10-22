/**
 * Amazon Bedrock ConverseStream adapter (WP-08; FO-09-06, FO-09-09, FO-19-09) on the pinned
 * `@aws-sdk/client-bedrock-runtime`: AWS's own SigV4 signing, request serialization, event-stream decoding and
 * modelled exceptions. The SDK's network handler is REPLACED by `TransportRequestHandler`, which sends every request
 * through the egress-classified transport (platform/src/connectors/http): host allowlist, pinned DNS, the per-request
 * model egress check and the caller's AbortSignal, so no Bedrock byte bypasses the egress guard.
 *
 * Client settings that keep the SDK from acting on its own: `maxAttempts: 1` (the ResilientModelPort is the one retry
 * owner), `defaultsMode: "standard"` (no instance-metadata probe), an explicit endpoint and region, FIPS and dual-stack
 * resolution off (the endpoint is explicit), and explicit credentials from the composition root's handle (the SDK's
 * default credential chain is never consulted, so an unconfigured adapter makes no metadata or STS call).
 *
 * The auth scheme is PINNED to SigV4 with that handle (security review D1): the SDK otherwise lets the environment
 * pick bearer authentication (`AWS_BEARER_TOKEN_BEDROCK`, `AWS_AUTH_SCHEME_PREFERENCE=httpBearerAuth`, or
 * `auth_scheme_preference` in ~/.aws/config), which would send an ambient Bedrock API key instead of the handle's
 * signature, or refresh an SSO token with the SDK's own HTTP client outside the egress-classified transport. Here the
 * scheme provider offers only `aws.auth#sigv4`, the preference is set explicitly (the environment is not read for
 * it), and the bearer identity provider refuses, so no ambient token is ever resolved or sent.
 *
 * Provider semantics kept as they are: text and tool-use content blocks (`contentBlockStart.start.toolUse`,
 * `contentBlockDelta.delta.toolUse.input`), `messageStop.stopReason` (end_turn / tool_use / stop_sequence ->
 * COMPLETED; guardrail_intervened -> REFUSED GUARDRAIL_INTERVENED; content_filtered -> REFUSED CONTENT_FILTER;
 * max_tokens / model_context_window_exceeded -> INCOMPLETE; malformed_* -> MALFORMED), the documented event order
 * (security review r4, fail closed; `bedrockStreamViolation`): nothing but metadata after messageStop, so a later stop
 * never overrides the first and no content is appended after it (MODEL_STREAM_CONTENT_AFTER_STOP); a refusal stop
 * (guardrail_intervened, content_filtered) is sticky, so such a stream is REFUSED whatever follows; one
 * contentBlockStart per index and no toolUse delta into a closed, unknown or text block (MODEL_TOOL_CALL_INVALID); every
 * toolUse block closed by contentBlockStop before a completing stop (MODEL_TOOL_CALL_UNCLOSED); and the stop reason
 * agreeing with the content, tool_use exactly when there is a call (MODEL_STOP_REASON_INCONSISTENT), `metadata.usage` and
 * `metadata.metrics.latencyMs`, guardrails through `guardrailConfig`, and the modelled exceptions (ThrottlingException,
 * ServiceUnavailableException and ModelNotReadyException -> OVERLOADED; InternalServerException,
 * ModelStreamErrorException, ModelTimeoutException -> RETRYABLE; ValidationException, ResourceNotFoundException ->
 * PERMANENT; AccessDeniedException -> UNAVAILABLE). Reasoning content deltas are dropped, never stored.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { Readable } from "node:stream";
import { BedrockRuntimeClient, ConverseStreamCommand } from "@aws-sdk/client-bedrock-runtime";
import type { BedrockRuntimeClientConfig, ContentBlock, ConverseStreamCommandInput, ConverseStreamOutput, Message, Tool } from "@aws-sdk/client-bedrock-runtime";
import type { Classification } from "../../protocol/common.js";
import type { AttemptContext, AttemptResult, ModelAdapter } from "../port/adapter.js";
import type { AwsCredential } from "../port/credentials.js";
import { ModelCallError, errorClassForStatus } from "../port/errors.js";
import type { BedrockConverseDetail, ModelRequest, ModelToolCall, ModelUsage } from "../port/types.js";
import type { ModelHttpExchange } from "./http-exchange.js";
import { transportFailureToModelError, watched } from "./http-exchange.js";

export interface BedrockConverseSettings {
  region: string;
  /** https endpoint: `bedrock-runtime.<region>.amazonaws.com`, a VPC endpoint DNS name, or a local/ci emulator. */
  endpoint: string;
  /**
   * Model id or inference profile id: configuration data from the registry entry. An ARN model id (application
   * inference profile, provisioned throughput) carries the 12-digit account id in the request path, which the egress
   * URL scan refuses (EGRESS_URL_CONTAINS_SENSITIVE_PATTERN, fail closed): the model guard runs the same check at
   * configuration, so such an endpoint is NOT_CONFIGURED and never composed until the egress policy can list the
   * pinned id as an opaque path value (documented limitation, security review r4).
   */
  modelId: string;
  guardrail: { identifier: string; version: string } | null;
  credential: AwsCredential;
  exchange: ModelHttpExchange;
}

interface CallScope {
  dataClass: Classification;
  timeoutMs: number;
  firstEventTimeoutMs: number;
  idleTimeoutMs: number;
}

type HandlerInput = { protocol?: string; hostname?: string; port?: number; path?: string; query?: Record<string, string | string[] | null>; headers?: Record<string, string>; body?: unknown; method?: string };

/**
 * The SDK request handler over the egress-classified transport. The data class and attempt timeout of the current
 * call come from an AsyncLocalStorage scope set around `client.send`; a request outside a scope is refused (fail
 * closed: nothing is sent without a data class to check).
 */
export class TransportRequestHandler {
  readonly metadata = { handlerProtocol: "http/1.1" };
  constructor(
    private readonly exchange: ModelHttpExchange,
    private readonly scope: AsyncLocalStorage<CallScope>,
  ) {}

  async handle(request: HandlerInput, options?: { abortSignal?: AbortSignal }): Promise<{ response: { statusCode: number; headers: Record<string, string>; body: Readable } }> {
    const call = this.scope.getStore();
    if (!call) throw new ModelCallError({ kind: "UNAVAILABLE", reasonCode: "MODEL_CALL_SCOPE_MISSING", errorClass: "PERMANENT", notStarted: true });
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(request.query ?? {})) {
      if (v === null) qs.append(k, "");
      else for (const item of Array.isArray(v) ? v : [v]) qs.append(k, item);
    }
    const q = qs.toString();
    const url = new URL(`${request.protocol ?? "https:"}//${request.hostname ?? ""}${request.port ? `:${request.port}` : ""}${request.path ?? "/"}${q ? `?${q}` : ""}`);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(request.headers ?? {})) {
      const name = k.toLowerCase();
      // The transport sets host and content-length itself (same values the signature covers).
      if (name === "host" || name === "content-length") continue;
      headers[name] = v;
    }
    const raw = request.body;
    // The SDK serializes to a Uint8Array; copy its bytes without calling any string method on it.
    const body = raw === undefined || raw === null ? null : typeof raw === "string" ? raw : raw instanceof Uint8Array ? Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength) : null;
    if (raw !== undefined && raw !== null && body === null) throw new ModelCallError({ kind: "UNAVAILABLE", reasonCode: "MODEL_REQUEST_BODY_UNSUPPORTED", errorClass: "PERMANENT", notStarted: true });
    // The stream watchdog closes the exchange itself when an incremental stream stalls (first event or idle gap).
    const watchdog = new AbortController();
    const signal = options?.abortSignal ? AbortSignal.any([options.abortSignal, watchdog.signal]) : watchdog.signal;
    const res = await this.exchange.send({ method: request.method === "GET" ? "GET" : "POST", url, headers, body, dataClass: call.dataClass, timeoutMs: call.timeoutMs, signal });
    const chunks = watched(res.body, { incremental: this.exchange.incremental, firstEventTimeoutMs: call.firstEventTimeoutMs, idleTimeoutMs: call.idleTimeoutMs, abort: () => watchdog.abort() });
    return { response: { statusCode: res.status, headers: { ...res.headers }, body: Readable.from(chunks) } };
  }

  updateHttpClientConfig(): void {
    // No socket pool or agent: every exchange is the transport's own connection.
  }

  httpHandlerConfigs(): Record<string, never> {
    return {};
  }

  destroy(): void {
    // Nothing to release.
  }
}

/** Our messages as Bedrock Converse messages: alternating roles, tool results inside the following user turn. */
export function bedrockMessages(req: ModelRequest): Message[] {
  const out: Message[] = [];
  const push = (role: "user" | "assistant", blocks: ContentBlock[]) => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.content = [...(last.content ?? []), ...blocks];
    else out.push({ role, content: blocks });
  };
  for (const m of req.messages) {
    if (m.role === "user") push("user", [{ text: m.content }]);
    else if (m.role === "assistant") {
      const blocks: ContentBlock[] = [];
      if (m.content.length > 0) blocks.push({ text: m.content });
      for (const c of m.toolCalls) blocks.push({ toolUse: { toolUseId: c.callId, name: c.name, input: c.arguments as never } });
      if (blocks.length > 0) push("assistant", blocks);
    } else push("user", [{ toolResult: { toolUseId: m.callId, content: [{ text: m.content }] } }]);
  }
  return out;
}

export function bedrockConverseInput(s: Pick<BedrockConverseSettings, "modelId" | "guardrail">, req: ModelRequest): ConverseStreamCommandInput {
  const history = req.messages.some((m) => (m.role === "assistant" && m.toolCalls.length > 0) || m.role === "tool");
  let tools: Tool[] = req.tools.map((t) => ({ toolSpec: { name: t.name, description: t.description, inputSchema: { json: t.parameters as never } } }));
  let toolChoice: NonNullable<ConverseStreamCommandInput["toolConfig"]>["toolChoice"] | undefined;
  if (req.responseSchema) {
    if (tools.length > 0) throw new ModelCallError({ kind: "FAILED", reasonCode: "MODEL_STRUCTURED_OUTPUT_WITH_TOOLS", errorClass: "PERMANENT", notStarted: true });
    // Bedrock's documented structured-output pattern: one tool whose input schema is the output schema, forced.
    tools = [{ toolSpec: { name: req.responseSchema.name, description: "Structured output", inputSchema: { json: req.responseSchema.schema as never } } }];
    toolChoice = { tool: { name: req.responseSchema.name } };
  } else if (tools.length > 0) {
    const c = req.toolChoice;
    toolChoice = c === "required" ? { any: {} } : typeof c === "object" ? { tool: { name: c.name } } : c === "auto" || history ? { auto: {} } : undefined;
    // "none": Bedrock has no "none" choice; tools are withheld unless the history already holds tool blocks.
    if (c === "none" && !history) tools = [];
  }
  return {
    modelId: s.modelId,
    system: [{ text: req.instructions }],
    messages: bedrockMessages(req),
    inferenceConfig: { maxTokens: req.budget.maxOutputTokens, ...(req.temperature !== null ? { temperature: req.temperature } : {}) },
    ...(tools.length > 0 ? { toolConfig: { tools, ...(toolChoice ? { toolChoice } : {}) } } : {}),
    ...(s.guardrail ? { guardrailConfig: { guardrailIdentifier: s.guardrail.identifier, guardrailVersion: s.guardrail.version, trace: "enabled", streamProcessingMode: "sync" } } : {}),
  };
}

const OVERLOAD = new Set(["ThrottlingException", "ServiceUnavailableException", "ModelNotReadyException"]);
const RETRYABLE = new Set(["InternalServerException", "ModelStreamErrorException", "ModelTimeoutException"]);
const PERMANENT = new Set(["ValidationException", "ResourceNotFoundException", "ModelErrorException", "ConflictException"]);
const AUTH = new Set(["AccessDeniedException", "UnrecognizedClientException", "InvalidSignatureException", "ExpiredTokenException", "IncompleteSignatureException"]);

/** A Bedrock modelled exception (or a failure inside our handler), mapped to the typed failure. */
export function bedrockFailure(err: unknown, detail: BedrockConverseDetail): ModelCallError {
  if (err instanceof ModelCallError) return err;
  const cause = (err as { cause?: unknown } | null)?.cause;
  if (cause instanceof ModelCallError) return cause;
  const e = err as { name?: unknown; $metadata?: { httpStatusCode?: unknown; requestId?: unknown } } | null;
  const name = typeof e?.name === "string" && /^[A-Za-z]{1,80}$/.test(e.name) ? e.name : null;
  const status = typeof e?.$metadata?.httpStatusCode === "number" ? e.$metadata.httpStatusCode : null;
  if (typeof e?.$metadata?.requestId === "string" && /^[A-Za-z0-9-]{1,80}$/.test(e.$metadata.requestId)) detail.requestId = e.$metadata.requestId;
  if (name === "AbortError") return new ModelCallError({ kind: "CANCELLED", reasonCode: "MODEL_CALL_CANCELLED", errorClass: "PERMANENT", detail });
  if (name === null) return transportFailureToModelError(err);
  detail.exception = name;
  if (name === "ServiceQuotaExceededException") return new ModelCallError({ kind: "FAILED", reasonCode: "MODEL_QUOTA_EXHAUSTED", errorClass: "PERMANENT", httpStatus: status, detail });
  if (OVERLOAD.has(name)) return new ModelCallError({ kind: "OVERLOADED", reasonCode: "MODEL_OVERLOADED", errorClass: "RETRYABLE", httpStatus: status, detail });
  if (RETRYABLE.has(name)) return new ModelCallError({ kind: "FAILED", reasonCode: name === "ModelStreamErrorException" ? "MODEL_STREAM_ERROR" : "MODEL_SERVER_ERROR", errorClass: "RETRYABLE", httpStatus: status, detail });
  if (AUTH.has(name)) return new ModelCallError({ kind: "UNAVAILABLE", reasonCode: "MODEL_AUTH_REJECTED", errorClass: "PERMANENT", httpStatus: status, detail });
  if (PERMANENT.has(name)) return new ModelCallError({ kind: "FAILED", reasonCode: "MODEL_REQUEST_REJECTED", errorClass: "PERMANENT", httpStatus: status, detail });
  const cls = status === null ? "UNKNOWN" : errorClassForStatus(status);
  return new ModelCallError({ kind: "FAILED", reasonCode: "MODEL_PROVIDER_ERROR", errorClass: cls, httpStatus: status, detail });
}

/** The refusal a Bedrock stop reason signals (null for every other stop). */
function refusalFor(stopReason: BedrockConverseDetail["stopReason"]): { source: "GUARDRAIL_INTERVENED" | "CONTENT_FILTER"; reasonCode: string } | null {
  if (stopReason === "guardrail_intervened") return { source: "GUARDRAIL_INTERVENED", reasonCode: "MODEL_GUARDRAIL_INTERVENED" };
  if (stopReason === "content_filtered") return { source: "CONTENT_FILTER", reasonCode: "MODEL_CONTENT_FILTERED" };
  return null;
}

export interface BedrockStreamState {
  /** messageStart was seen. */
  started: boolean;
  /** messageStop was seen (its stop reason is final). */
  stopped: boolean;
  metadataSeen: boolean;
  blocks: ReadonlyMap<number, { kind: "text" | "toolUse" | "other"; closed: boolean }>;
}

const blockIndex = (i: unknown): i is number => typeof i === "number" && Number.isInteger(i) && i >= 0 && i < 1_024;

/**
 * The documented ConverseStream order, checked event by event (security review r4, fail closed): one messageStart
 * first; content blocks, each closed at most once by contentBlockStop; one messageStop; then only metadata (once).
 * Returns the reason code of the first violation, or null:
 *  - any content event, a second messageStop or a second messageStart after messageStop: MODEL_STREAM_CONTENT_AFTER_STOP
 *    (a later stop can never override the first one, and nothing after the stop is ever used);
 *  - a contentBlockStart at an index already used, a toolUse delta for an index that is not an open toolUse block
 *    (unknown, already closed, or a text block), or a text delta into a toolUse block: MODEL_TOOL_CALL_INVALID;
 *  - content before messageStart, a delta into a closed block, a block closed twice, an invalid index, or metadata
 *    before messageStop or twice: MODEL_STREAM_EVENT_INVALID.
 * Events of types this adapter does not know are ignored (they carry nothing the port uses).
 */
export function bedrockStreamViolation(ev: ConverseStreamOutput, s: BedrockStreamState): string | null {
  const content = ev.contentBlockStart ?? ev.contentBlockDelta ?? ev.contentBlockStop;
  if (!ev.messageStart && !ev.messageStop && !ev.metadata && !content) return null;
  if (ev.metadata) return !s.stopped || s.metadataSeen ? "MODEL_STREAM_EVENT_INVALID" : null;
  if (s.stopped) return "MODEL_STREAM_CONTENT_AFTER_STOP";
  if (ev.messageStart) return s.started ? "MODEL_STREAM_EVENT_INVALID" : null;
  if (!s.started) return "MODEL_STREAM_EVENT_INVALID";
  if (ev.messageStop) return null;
  if (ev.contentBlockStart) {
    const i = ev.contentBlockStart.contentBlockIndex;
    if (!blockIndex(i) || s.blocks.has(i)) return "MODEL_TOOL_CALL_INVALID";
    return null;
  }
  if (ev.contentBlockDelta) {
    const i = ev.contentBlockDelta.contentBlockIndex;
    const d = ev.contentBlockDelta.delta;
    if (!blockIndex(i)) return d?.toolUse ? "MODEL_TOOL_CALL_INVALID" : "MODEL_STREAM_EVENT_INVALID";
    const b = s.blocks.get(i);
    if (d?.toolUse) return b?.kind === "toolUse" && !b.closed ? null : "MODEL_TOOL_CALL_INVALID";
    if (b?.kind === "toolUse") return "MODEL_TOOL_CALL_INVALID";
    return b?.closed ? "MODEL_STREAM_EVENT_INVALID" : null;
  }
  const i = ev.contentBlockStop?.contentBlockIndex;
  if (!blockIndex(i)) return "MODEL_STREAM_EVENT_INVALID";
  return s.blocks.get(i)?.closed ? "MODEL_STREAM_EVENT_INVALID" : null;
}

/**
 * The only auth option the Bedrock client may choose: SigV4 for service `bedrock` in the call's region (the same option
 * the SDK's default provider lists first; its second option, bearer auth, is deliberately absent).
 */
const SIGV4_ONLY = ((params: { region: string }) => [
  {
    schemeId: "aws.auth#sigv4",
    signingProperties: { name: "bedrock", region: params.region },
    propertiesExtractor: (config: unknown, context: unknown) => ({ signingProperties: { config, context } }),
  },
]) as unknown as NonNullable<BedrockRuntimeClientConfig["httpAuthSchemeProvider"]>;

export class BedrockConverseAdapter implements ModelAdapter {
  readonly provider = "bedrock_converse" as const;
  /** The documented forced-tool pattern (bedrockConverseInput); the port validates the forced call. */
  readonly supportsStructuredOutput = true;
  private readonly client: BedrockRuntimeClient;
  private readonly scope = new AsyncLocalStorage<CallScope>();

  constructor(private readonly s: BedrockConverseSettings) {
    const config: BedrockRuntimeClientConfig = {
      region: s.region,
      endpoint: s.endpoint,
      // A credential the composition root cannot produce (task role unavailable, provider error) is the same typed
      // UNAVAILABLE result as for the bearer adapters; nothing is signed or sent.
      credentials: async () => {
        try {
          return await s.credential.credentials();
        } catch {
          throw new ModelCallError({ kind: "UNAVAILABLE", reasonCode: "MODEL_CREDENTIAL_UNAVAILABLE", errorClass: "PERMANENT", notStarted: true });
        }
      },
      requestHandler: new TransportRequestHandler(s.exchange, this.scope) as unknown as BedrockRuntimeClientConfig["requestHandler"],
      maxAttempts: 1,
      defaultsMode: "standard",
      useFipsEndpoint: false,
      useDualstackEndpoint: false,
      // SigV4 only, with the composition root's handle: never an ambient bearer key or an SSO token refresh.
      authSchemePreference: ["sigv4"],
      httpAuthSchemeProvider: SIGV4_ONLY,
      token: async () => {
        throw new ModelCallError({ kind: "UNAVAILABLE", reasonCode: "MODEL_BEARER_AUTH_REFUSED", errorClass: "PERMANENT", notStarted: true });
      },
    };
    this.client = new BedrockRuntimeClient(config);
  }

  async attempt(req: ModelRequest, ctx: AttemptContext): Promise<AttemptResult> {
    const detail: BedrockConverseDetail = { provider: this.provider, requestId: null, stopReason: null, exception: null, latencyMs: null };
    const input = bedrockConverseInput(this.s, req);
    let stream: AsyncIterable<ConverseStreamOutput>;
    try {
      const scope: CallScope = { dataClass: req.dataClass, timeoutMs: req.budget.attemptTimeoutMs, firstEventTimeoutMs: req.budget.firstEventTimeoutMs, idleTimeoutMs: req.budget.idleTimeoutMs };
      const out = await this.scope.run(scope, () => this.client.send(new ConverseStreamCommand(input), { abortSignal: ctx.signal }));
      if (typeof out.$metadata.requestId === "string" && /^[A-Za-z0-9-]{1,80}$/.test(out.$metadata.requestId)) detail.requestId = out.$metadata.requestId;
      if (!out.stream) throw new ModelCallError({ kind: "MALFORMED", reasonCode: "MODEL_STREAM_MISSING", errorClass: "PERMANENT", detail });
      stream = out.stream;
    } catch (err) {
      throw bedrockFailure(err, detail);
    }
    const calls = new Map<number, { index: number; callId: string; name: string; args: string }>();
    /** Every content block index seen, its kind and whether `contentBlockStop` closed it. */
    const blocks = new Map<number, { kind: "text" | "toolUse" | "other"; closed: boolean }>();
    let text = "";
    let usage: ModelUsage | null = null;
    let started = false;
    let stopped = false;
    let metadataSeen = false;
    /** The first protocol violation; reading stops there (fail closed, nothing after it is used). */
    let violation: string | null = null;
    const malformed = (reasonCode: string) => new ModelCallError({ kind: "MALFORMED", reasonCode, errorClass: "PERMANENT", detail });
    try {
      for await (const ev of stream) {
        violation = bedrockStreamViolation(ev, { started, stopped, metadataSeen, blocks });
        if (violation !== null) break;
        if (ev.messageStart) {
          started = true;
        } else if (ev.contentBlockStart) {
          const tu = ev.contentBlockStart.start?.toolUse;
          const index = ev.contentBlockStart.contentBlockIndex as number;
          if (tu) {
            if (!tu.toolUseId || !tu.name) throw malformed("MODEL_TOOL_CALL_INVALID");
            blocks.set(index, { kind: "toolUse", closed: false });
            calls.set(index, { index, callId: tu.toolUseId, name: tu.name, args: "" });
            ctx.emit({ type: "tool_call_started", index, callId: tu.toolUseId, name: tu.name });
          } else blocks.set(index, { kind: "other", closed: false });
        } else if (ev.contentBlockDelta) {
          const d = ev.contentBlockDelta.delta;
          const index = ev.contentBlockDelta.contentBlockIndex as number;
          if (d?.text !== undefined) {
            if (!blocks.has(index)) blocks.set(index, { kind: "text", closed: false });
            text += d.text;
            ctx.emit({ type: "text_delta", text: d.text });
          } else if (d?.toolUse) {
            const c = calls.get(index) as { args: string };
            c.args += d.toolUse.input ?? "";
            ctx.emit({ type: "tool_call_arguments_delta", index, delta: d.toolUse.input ?? "" });
          } else if (!blocks.has(index)) blocks.set(index, { kind: "other", closed: false });
          // Reasoning and citation deltas carry nothing the port uses; reasoning is never stored.
        } else if (ev.contentBlockStop) {
          const index = ev.contentBlockStop.contentBlockIndex as number;
          const b = blocks.get(index);
          if (b) b.closed = true;
          else blocks.set(index, { kind: "text", closed: true });
        } else if (ev.messageStop) {
          // The FIRST stop decides; a second messageStop is a violation (bedrockStreamViolation), never an override.
          detail.stopReason = (ev.messageStop.stopReason as BedrockConverseDetail["stopReason"]) ?? null;
          stopped = true;
        } else if (ev.metadata) {
          metadataSeen = true;
          const u = ev.metadata.usage;
          if (u && typeof u.inputTokens === "number" && typeof u.outputTokens === "number") {
            usage = { inputTokens: u.inputTokens, outputTokens: u.outputTokens, cachedInputTokens: typeof u.cacheReadInputTokens === "number" ? u.cacheReadInputTokens : null, reasoningTokens: null };
            ctx.emit({ type: "usage", usage });
          }
          if (typeof ev.metadata.metrics?.latencyMs === "number") detail.latencyMs = ev.metadata.metrics.latencyMs;
        }
      }
    } catch (err) {
      // An exception event after a refusal stop does not turn the refusal into a retryable failure either.
      const sticky = refusalFor(stopped ? detail.stopReason : null);
      if (sticky) return { provider: this.provider, outcome: "REFUSED", refusal: sticky, usage, detail };
      throw bedrockFailure(err, detail);
    }
    // A refusal stop is sticky: a guardrail intervention or a content filter is never overridden by anything the
    // stream sends after it (a second messageStop, more content), so such a stream is REFUSED, not MALFORMED.
    const refusal = refusalFor(stopped ? detail.stopReason : null);
    if (refusal) return { provider: this.provider, outcome: "REFUSED", refusal, usage, detail };
    if (violation !== null) throw malformed(violation);
    if (!stopped) throw malformed("MODEL_STREAM_TRUNCATED");
    switch (detail.stopReason) {
      case "max_tokens":
        return { provider: this.provider, outcome: "INCOMPLETE", reasonCode: "MODEL_MAX_OUTPUT_TOKENS", usage, detail };
      case "model_context_window_exceeded":
        return { provider: this.provider, outcome: "INCOMPLETE", reasonCode: "MODEL_CONTEXT_WINDOW_EXCEEDED", usage, detail };
      case "malformed_model_output":
      case "malformed_tool_use":
        return { provider: this.provider, outcome: "MALFORMED", reasonCode: detail.stopReason === "malformed_tool_use" ? "MODEL_TOOL_CALL_INVALID" : "MODEL_OUTPUT_MALFORMED", usage, detail };
      case "end_turn":
      case "tool_use":
      case "stop_sequence":
        break;
      default:
        throw malformed("MODEL_STOP_REASON_UNKNOWN");
    }
    // A completed message: every toolUse block was closed by contentBlockStop before messageStop, and the stop reason
    // agrees with the content (tool_use exactly when there is at least one call). A truncated or contradictory stream
    // never yields a proposal or speakable text.
    for (const b of blocks.values()) if (b.kind === "toolUse" && !b.closed) return { provider: this.provider, outcome: "MALFORMED", reasonCode: "MODEL_TOOL_CALL_UNCLOSED", usage, detail };
    if ((detail.stopReason === "tool_use") !== calls.size > 0) return { provider: this.provider, outcome: "MALFORMED", reasonCode: "MODEL_STOP_REASON_INCONSISTENT", usage, detail };
    const toolCalls: ModelToolCall[] = [];
    for (const c of [...calls.values()].sort((a, b) => a.index - b.index)) {
      let args: unknown;
      try {
        args = JSON.parse(c.args.length > 0 ? c.args : "{}");
      } catch {
        args = undefined;
      }
      if (typeof args !== "object" || args === null || Array.isArray(args) || !/^[A-Za-z0-9_.:-]{1,128}$/.test(c.callId) || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(c.name)) {
        return { provider: this.provider, outcome: "MALFORMED", reasonCode: "MODEL_TOOL_ARGUMENTS_INVALID", usage, detail };
      }
      toolCalls.push({ callId: c.callId, name: c.name, arguments: args as Record<string, unknown> });
    }
    return { provider: this.provider, outcome: "COMPLETED", text, toolCalls, usage, detail };
  }
}
