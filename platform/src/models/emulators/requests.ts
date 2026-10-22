/**
 * Request validation of the protocol-exact model emulators (WP-08; FO-16-18). Each provider's documented request
 * rules are enforced the way the provider answers them (400 with its own error document), so an adapter that sends
 * a request the provider would refuse fails against the emulator too:
 *  - OpenAI Responses: `model`, `input` (string or item list), streaming; function tools with a name and a JSON
 *    schema; `function_call_output` items must answer a `function_call` earlier in the input;
 *  - Chat Completions (vLLM): `model`, a non-empty `messages` list with known roles, tool messages answering a
 *    preceding assistant tool call, streaming;
 *  - Bedrock Converse: a `messages` list that starts with a user turn and alternates roles, every `toolResult`
 *    answering a `toolUse` of the previous assistant turn, `inferenceConfig.maxTokens` positive, tool specs with an
 *    input schema, a well-formed `guardrailConfig` when present (whether the request carries one decides how the
 *    emulator renders a refusal: Bedrock reports `guardrail_intervened` only for a request that has a guardrail).
 * The parsed request is reduced to the RenderInput the scenario renderers need; request text is never kept.
 */
import type { RenderInput } from "./scenarios.js";

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

export type Parsed = { ok: true; input: Omit<RenderInput, "seed" | "createdAt">; stream: boolean; store: unknown } | { ok: false; status: 400 | 404; message: string };

const bad = (message: string): Parsed => ({ ok: false, status: 400, message });

export function parseOpenAiResponsesRequest(body: unknown, bytes: number): Parsed {
  if (!isObj(body)) return bad("The request body must be a JSON object.");
  if (typeof body.model !== "string" || body.model.length === 0) return bad("Missing required parameter: 'model'.");
  const input = body.input;
  if (typeof input !== "string" && !Array.isArray(input)) return bad("Missing required parameter: 'input'.");
  const callIds = new Set<string>();
  let lastToolResult: string | null = null;
  if (Array.isArray(input)) {
    for (const item of input) {
      if (!isObj(item)) return bad("Invalid input item.");
      if (item.type === "function_call") {
        if (typeof item.call_id !== "string" || typeof item.name !== "string" || typeof item.arguments !== "string") return bad("Invalid function_call item.");
        callIds.add(item.call_id);
        lastToolResult = null;
      } else if (item.type === "function_call_output") {
        if (typeof item.call_id !== "string" || !callIds.has(item.call_id)) return bad("No tool call found for function call output.");
        lastToolResult = item.call_id;
      } else if (item.type === undefined || item.type === "message") {
        if (item.role !== "user" && item.role !== "assistant" && item.role !== "system" && item.role !== "developer") return bad("Invalid message role.");
        lastToolResult = null;
      } else return bad("Unsupported input item type for this emulator.");
    }
  }
  const tools: RenderInput["tools"] = [];
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) return bad("Invalid 'tools'.");
    for (const t of body.tools) {
      if (!isObj(t) || t.type !== "function" || typeof t.name !== "string" || !isObj(t.parameters)) return bad("Invalid function tool.");
      tools.push({ name: t.name, parameters: t.parameters });
    }
  }
  // Structured output: `text.format` of type json_schema needs a name and a schema object.
  let responseSchema: Json | null = null;
  const format = isObj(body.text) && isObj(body.text.format) ? body.text.format : null;
  if (format && format.type === "json_schema") {
    if (typeof format.name !== "string" || !isObj(format.schema)) return bad("Invalid 'text.format': a json_schema format needs 'name' and 'schema'.");
    responseSchema = format.schema;
  }
  if (body.stream !== true) return bad("This emulator serves streaming responses only ('stream': true).");
  return { ok: true, input: { model: body.model, tools, lastToolResultCallId: lastToolResult, inputBytes: bytes, guardrail: false, responseSchema }, stream: true, store: body.store };
}

export function parseChatCompletionsRequest(body: unknown, bytes: number): Parsed {
  if (!isObj(body)) return bad("The request body must be a JSON object.");
  if (typeof body.model !== "string" || body.model.length === 0) return bad("model is required");
  if (!Array.isArray(body.messages) || body.messages.length === 0) return bad("messages must be a non-empty list");
  const callIds = new Set<string>();
  let lastToolResult: string | null = null;
  for (const m of body.messages) {
    if (!isObj(m)) return bad("invalid message");
    if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
      for (const c of m.tool_calls) if (isObj(c) && typeof c.id === "string") callIds.add(c.id);
      lastToolResult = null;
    } else if (m.role === "tool") {
      if (typeof m.tool_call_id !== "string" || !callIds.has(m.tool_call_id)) return bad("tool message does not answer a tool call");
      lastToolResult = m.tool_call_id;
    } else if (m.role === "system" || m.role === "user" || m.role === "assistant" || m.role === "developer") lastToolResult = null;
    else return bad("unknown message role");
  }
  const tools: RenderInput["tools"] = [];
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) return bad("invalid tools");
    for (const t of body.tools) {
      const fn = isObj(t) && t.type === "function" && isObj(t.function) ? t.function : null;
      if (!fn || typeof fn.name !== "string") return bad("invalid tool");
      tools.push({ name: fn.name, parameters: isObj(fn.parameters) ? fn.parameters : {} });
    }
  }
  // Structured output (vLLM guided decoding): `response_format` of type json_schema with `json_schema.schema`.
  let responseSchema: Json | null = null;
  const format = isObj(body.response_format) ? body.response_format : null;
  if (format && format.type === "json_schema") {
    const js = isObj(format.json_schema) ? format.json_schema : null;
    if (!js || typeof js.name !== "string" || !isObj(js.schema)) return bad("response_format json_schema needs a name and a schema");
    responseSchema = js.schema;
  }
  if (body.stream !== true) return bad("this emulator serves streaming responses only");
  return { ok: true, input: { model: body.model, tools, lastToolResultCallId: lastToolResult, inputBytes: bytes, guardrail: false, responseSchema }, stream: true, store: undefined };
}

export function parseBedrockConverseRequest(modelId: string, body: unknown, bytes: number): Parsed {
  if (!isObj(body)) return bad("The request body must be a JSON object.");
  if (!Array.isArray(body.messages) || body.messages.length === 0) return bad("A conversation must start with a user message.");
  let expected = "user" as "user" | "assistant";
  let pendingToolUse = new Set<string>();
  let lastToolResult: string | null = null;
  for (const m of body.messages) {
    if (!isObj(m) || (m.role !== "user" && m.role !== "assistant") || !Array.isArray(m.content) || m.content.length === 0) return bad("Malformed message.");
    if (m.role !== expected) return bad("A conversation must alternate between user and assistant roles. Make sure the conversation alternates between user and assistant roles and try again.");
    const uses = new Set<string>();
    lastToolResult = null;
    for (const block of m.content) {
      if (!isObj(block)) return bad("Malformed content block.");
      if (isObj(block.toolUse)) {
        if (m.role !== "assistant" || typeof block.toolUse.toolUseId !== "string" || typeof block.toolUse.name !== "string") return bad("Malformed toolUse block.");
        uses.add(block.toolUse.toolUseId);
      } else if (isObj(block.toolResult)) {
        if (m.role !== "user" || typeof block.toolResult.toolUseId !== "string" || !pendingToolUse.has(block.toolResult.toolUseId)) {
          return bad("The toolResult blocks at messages must match the toolUse blocks of the previous turn.");
        }
        lastToolResult = block.toolResult.toolUseId;
      } else if (typeof block.text !== "string") return bad("Unsupported content block for this emulator.");
    }
    pendingToolUse = m.role === "assistant" ? uses : new Set();
    expected = m.role === "user" ? "assistant" : "user";
  }
  const inference = isObj(body.inferenceConfig) ? body.inferenceConfig : {};
  if (inference.maxTokens !== undefined && (typeof inference.maxTokens !== "number" || inference.maxTokens < 1)) return bad("The maximum tokens you requested exceeds the model limit.");
  const tools: RenderInput["tools"] = [];
  if (isObj(body.toolConfig)) {
    if (!Array.isArray(body.toolConfig.tools) || body.toolConfig.tools.length === 0) return bad("toolConfig.tools must not be empty.");
    for (const t of body.toolConfig.tools) {
      const spec = isObj(t) && isObj(t.toolSpec) ? t.toolSpec : null;
      const schema = spec && isObj(spec.inputSchema) && isObj(spec.inputSchema.json) ? spec.inputSchema.json : null;
      if (!spec || typeof spec.name !== "string" || !schema) return bad("Malformed toolSpec.");
      tools.push({ name: spec.name, parameters: schema });
    }
  }
  let guardrail = false;
  if (body.guardrailConfig !== undefined) {
    const g = isObj(body.guardrailConfig) ? body.guardrailConfig : null;
    if (!g || typeof g.guardrailIdentifier !== "string" || typeof g.guardrailVersion !== "string") return bad("Malformed guardrailConfig.");
    guardrail = true;
  }
  // Bedrock has no response-format field: structured output is a forced tool (toolChoice.tool), rendered as a tool call.
  return { ok: true, input: { model: modelId, tools, lastToolResultCallId: lastToolResult, inputBytes: bytes, guardrail, responseSchema: null }, stream: true, store: undefined };
}
