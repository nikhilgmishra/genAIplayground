/**
 * Tool-call proposals checked against the request that offered them (WP-08; FO-04-19, FO-09-06, FO-09-07, FO-09-08).
 *
 * A model's tool call is a PROPOSAL from untrusted output. Before the port returns one, it must be a call the request
 * actually allowed:
 *  - the tool was offered by the request (`tools`), or is the forced structured-output tool of a Bedrock request;
 *  - the tool choice is respected: `none` and an empty tool list allow no call, a named choice allows only that tool
 *    and requires a call, `required` requires at least one call;
 *  - call ids are unique within the response;
 *  - the arguments validate against the tool's declared JSON schema (Ajv, the pinned validator, in the schema's
 *    declared dialect, strict, formats asserted, one isolated instance per schema; remote references are never
 *    fetched; see "Validator" below).
 * A violation is MALFORMED with a reason code (MODEL_TOOL_NOT_OFFERED, MODEL_TOOL_CHOICE_VIOLATED,
 * MODEL_TOOL_CALL_INVALID, MODEL_TOOL_ARGUMENTS_SCHEMA_INVALID), never a COMPLETED result. The gateway still
 * re-validates and re-authorizes every proposal against its pinned catalogue; this check only makes sure the port
 * never hands the harness a call the request did not allow.
 *
 * The tool schemas of a request are compiled before any provider I/O (`compileToolSchemas`): a schema that does not
 * compile refuses the request (MODEL_TOOL_SCHEMA_INVALID), so validation can never be skipped for a bad schema. Tool
 * names must be unique (MODEL_TOOL_NAME_DUPLICATE, security review r4): with two tools of one name the provider sees
 * both and a call could be checked against the looser one. For Bedrock the forced structured-output tool counts as
 * one of the request's tools, so a tool named like the response schema is the same refusal.
 *
 * Structured output (security review r4): the request's `responseSchema` is compiled before any provider I/O for EVERY
 * provider (MODEL_RESPONSE_SCHEMA_INVALID when it does not compile), and the COMPLETED output is checked against it
 * (`structuredOutputViolation`): the OpenAI and vLLM answer text must parse as JSON and validate; the Bedrock answer
 * is the forced tool call (checked like any tool call) with no free text beside it. A violation is MALFORMED
 * MODEL_STRUCTURED_OUTPUT_INVALID, never speakable: the provider's own enforcement (OpenAI strict json_schema, vLLM
 * guided decoding, Bedrock tool choice) is not trusted on its own.
 *
 * Validator (security review r3, D-ajv):
 *  - the dialect is the one the schema declares: JSON Schema 2020-12 (`$schema` absent or the 2020-12 URI, the
 *    dialect of the gateway's pinned catalogue, schemas/tools/catalog.json) or draft-07 (its URI); any other
 *    `$schema` refuses the request;
 *  - strict mode: an unknown or unsupported keyword, an ambiguous type or a `required` name without a property
 *    refuses the request instead of being silently ignored (a keyword the validator would skip can never make
 *    validation weaker than the schema declares), and a declared `format` is asserted (ajv-formats);
 *  - isolation: every schema is compiled by its OWN validator instance, with `addUsedSchema: false` and no schema
 *    loader. No `$id` is registered anywhere shared, so a schema compiles the same way whatever the process history
 *    (cache eviction cannot make it fail), and a `$ref` can only resolve inside the schema itself: a reference to a
 *    schema of another request, tenant or tool, or to a remote document, refuses the request. Compiled validators are
 *    cached by the digest of (dialect, schema) only, never by `$id`.
 */
import { createHash } from "node:crypto";
import { Ajv } from "ajv";
import type { Options, ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import * as ajvFormats from "ajv-formats";
import type { ModelProvider, ModelRequest, ModelToolCall } from "./types.js";

type FormatsPlugin = (ajv: Ajv | Ajv2020) => unknown;
/** ajv-formats is CommonJS: its default export is module.exports itself or its `default` property, by loader. */
const addFormats: FormatsPlugin = (() => {
  const m = ajvFormats as unknown as { default?: unknown };
  const fn = typeof m.default === "function" ? m.default : typeof (m.default as { default?: unknown } | undefined)?.default === "function" ? (m.default as { default: unknown }).default : m;
  return fn as FormatsPlugin;
})();

export const TOOL_SCHEMA_DIALECT_2020_12 = "https://json-schema.org/draft/2020-12/schema";
const DRAFT_07 = new Set(["http://json-schema.org/draft-07/schema#", "http://json-schema.org/draft-07/schema"]);
type Dialect = "2020-12" | "draft-07";

const VALIDATOR_OPTIONS: Options = {
  strict: true,
  allowUnionTypes: true,
  allErrors: false,
  validateFormats: true,
  addUsedSchema: false,
  logger: false,
  loadSchema: undefined,
};
/** At most this many compiled validators are cached (least recently used evicted first). */
export const TOOL_SCHEMA_CACHE_MAX = 256;
const cache = new Map<string, ValidateFunction>();

/** Compiled validators currently cached (never above TOOL_SCHEMA_CACHE_MAX). */
export function toolSchemaCacheSize(): number {
  return cache.size;
}

function dialectOf(schema: Record<string, unknown>): Dialect | null {
  const declared = schema.$schema;
  if (declared === undefined || declared === TOOL_SCHEMA_DIALECT_2020_12) return "2020-12";
  if (typeof declared === "string" && DRAFT_07.has(declared)) return "draft-07";
  return null;
}

/** A fresh, isolated validator instance (no shared `$id` registry, no loader, formats asserted). */
function validatorFor(dialect: Dialect): Ajv | Ajv2020 {
  const ajv = dialect === "2020-12" ? new Ajv2020(VALIDATOR_OPTIONS) : new Ajv(VALIDATOR_OPTIONS);
  addFormats(ajv);
  return ajv;
}

function compile(schema: Record<string, unknown>): ValidateFunction | null {
  const dialect = dialectOf(schema);
  if (dialect === null) return null;
  let serialized: string;
  try {
    serialized = JSON.stringify(schema);
  } catch {
    return null;
  }
  const key = createHash("sha256").update(dialect).update("\u0000").update(serialized).digest("hex");
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  let fn: ValidateFunction;
  try {
    // A structural copy: the compiled validator never shares an object with the caller's request.
    fn = validatorFor(dialect).compile(JSON.parse(serialized) as Record<string, unknown>);
  } catch {
    return null;
  }
  cache.set(key, fn);
  if (cache.size > TOOL_SCHEMA_CACHE_MAX) cache.delete(cache.keys().next().value as string);
  return fn;
}

interface OfferedTool {
  name: string;
  validate: ValidateFunction;
}

export type ToolSchemaCheck =
  | { ok: true; offered: ReadonlyMap<string, OfferedTool>; response: ValidateFunction | null }
  | { ok: false; reasonCode: "MODEL_TOOL_SCHEMA_INVALID" | "MODEL_TOOL_NAME_DUPLICATE" | "MODEL_RESPONSE_SCHEMA_INVALID" };

/**
 * The tools a request offers, with compiled argument validators, and the compiled response schema. Bedrock carries
 * structured output as one forced tool named after the response schema (adapters/bedrock-converse.ts), so that tool
 * is offered for a Bedrock request too.
 */
export function compileToolSchemas(request: Pick<ModelRequest, "tools" | "responseSchema">, provider: ModelProvider): ToolSchemaCheck {
  const offered = new Map<string, OfferedTool>();
  const specs = request.tools.map((t) => ({ name: t.name, parameters: t.parameters }));
  if (provider === "bedrock_converse" && request.responseSchema) specs.push({ name: request.responseSchema.name, parameters: request.responseSchema.schema });
  for (const t of specs) {
    if (offered.has(t.name)) return { ok: false, reasonCode: "MODEL_TOOL_NAME_DUPLICATE" };
    const validate = compile(t.parameters);
    if (!validate) return { ok: false, reasonCode: "MODEL_TOOL_SCHEMA_INVALID" };
    offered.set(t.name, { name: t.name, validate });
  }
  let response: ValidateFunction | null = null;
  if (request.responseSchema) {
    response = compile(request.responseSchema.schema);
    if (!response) return { ok: false, reasonCode: "MODEL_RESPONSE_SCHEMA_INVALID" };
  }
  return { ok: true, offered, response };
}

/**
 * Null when a COMPLETED answer satisfies the request's structured output (or the request has none); otherwise
 * MODEL_STRUCTURED_OUTPUT_INVALID. OpenAI and vLLM answer in text: it must parse as JSON and validate against the
 * response schema (a turn that only proposes tool calls, with no text, is checked through its calls instead). Bedrock
 * answers with the forced tool call, which `toolCallViolation` checks; free text beside it is not structured output.
 */
export function structuredOutputViolation(request: Pick<ModelRequest, "responseSchema">, provider: ModelProvider, answer: { text: string; toolCalls: readonly ModelToolCall[] }, response: ValidateFunction | null): "MODEL_STRUCTURED_OUTPUT_INVALID" | null {
  if (!request.responseSchema) return null;
  if (!response) return "MODEL_STRUCTURED_OUTPUT_INVALID";
  if (provider === "bedrock_converse") return answer.text.trim().length > 0 ? "MODEL_STRUCTURED_OUTPUT_INVALID" : null;
  if (answer.text.length === 0 && answer.toolCalls.length > 0) return null;
  let value: unknown;
  try {
    value = JSON.parse(answer.text);
  } catch {
    return "MODEL_STRUCTURED_OUTPUT_INVALID";
  }
  return response(value) ? null : "MODEL_STRUCTURED_OUTPUT_INVALID";
}

export type ToolCallViolation = "MODEL_TOOL_NOT_OFFERED" | "MODEL_TOOL_CHOICE_VIOLATED" | "MODEL_TOOL_CALL_INVALID" | "MODEL_TOOL_ARGUMENTS_SCHEMA_INVALID";

/** Null when every call is allowed by the request; otherwise the first violation (reason code only). */
export function toolCallViolation(request: Pick<ModelRequest, "tools" | "toolChoice" | "responseSchema">, provider: ModelProvider, calls: readonly ModelToolCall[], offered: ReadonlyMap<string, OfferedTool>): ToolCallViolation | null {
  const structured = provider === "bedrock_converse" && request.responseSchema !== null;
  const choice = structured && request.responseSchema ? { name: request.responseSchema.name } : request.toolChoice;
  if (calls.length > 0 && (choice === "none" || offered.size === 0)) return choice === "none" ? "MODEL_TOOL_CHOICE_VIOLATED" : "MODEL_TOOL_NOT_OFFERED";
  if (calls.length === 0 && offered.size > 0 && (choice === "required" || typeof choice === "object")) return "MODEL_TOOL_CHOICE_VIOLATED";
  const ids = new Set<string>();
  for (const c of calls) {
    if (ids.has(c.callId)) return "MODEL_TOOL_CALL_INVALID";
    ids.add(c.callId);
    const tool = offered.get(c.name);
    if (!tool) return "MODEL_TOOL_NOT_OFFERED";
    if (typeof choice === "object" && c.name !== choice.name) return "MODEL_TOOL_CHOICE_VIOLATED";
    if (!tool.validate(c.arguments)) return "MODEL_TOOL_ARGUMENTS_SCHEMA_INVALID";
  }
  return null;
}
