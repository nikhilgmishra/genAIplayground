/**
 * Tool-call proposals against the request (WP-08; FO-04-19, FO-09-06, FO-09-07, FO-09-08). Unit level: the checks of
 * tool-calls.ts, and the ResilientModelPort turning a violation into MALFORMED (never COMPLETED). UNIT FAKE: the
 * `OneShot` adapter below returns one scripted attempt result; the provider protocols run against the emulators in
 * ../adapters/*.test.ts and the Layer-2 suite.
 */
import { describe, expect, it } from "vitest";
import { systemClock } from "../../shared/clock.js";
import { LOOKUP_TOOL, request } from "../../../test/emulators/models/harness.js";
import { VALID_CATALOG_ARGUMENTS, catalogTools, invalidCatalogArguments } from "../../../test/emulators/models/catalog-tools.js";
import type { AttemptResult, ModelAdapter } from "./adapter.js";
import { ResilientModelPort } from "./resilient.js";
import { TOOL_SCHEMA_DIALECT_2020_12, compileToolSchemas, toolCallViolation } from "./tool-calls.js";
import { ModelRequest } from "./types.js";
import type { ModelProvider, ModelRequestInput, ModelToolCall } from "./types.js";

const DETAIL = { provider: "openai_responses" as const, responseId: null, status: "completed" as const, incompleteReason: null, errorCode: null };
const call = (name: string, args: Record<string, unknown>, callId = `call_${name}`): ModelToolCall => ({ callId, name, arguments: args });
const OK_LOOKUP = call("lookup_status", { reference: "synthetic" });
const TRANSFER = { name: "transfer_funds", description: "Synthetic transfer tool.", parameters: { type: "object", properties: { amountCents: { type: "integer", maximum: 1000 } }, required: ["amountCents"], additionalProperties: false } };

/** UNIT FAKE adapter: one scripted COMPLETED attempt. */
class OneShot implements ModelAdapter {
  calls = 0;
  constructor(
    readonly provider: ModelProvider,
    private readonly toolCalls: ModelToolCall[],
    private readonly text = "",
  ) {}
  async attempt(): Promise<AttemptResult> {
    this.calls += 1;
    return { provider: "openai_responses", outcome: "COMPLETED", text: this.text, toolCalls: this.toolCalls, usage: null, detail: DETAIL } as AttemptResult;
  }
}

const portFor = (a: ModelAdapter) => new ResilientModelPort(a, { endpointRef: "ep.unit.tools", maxDataClass: "INTERNAL", clock: systemClock, retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 } });
const violation = (over: Partial<ModelRequestInput>, calls: ModelToolCall[], provider: ModelProvider = "openai_responses") => {
  const req = ModelRequest.parse(request(over));
  const compiled = compileToolSchemas(req, provider);
  if (!compiled.ok) return compiled.reasonCode;
  return toolCallViolation(req, provider, calls, compiled.offered);
};

describe("tool calls are checked against the request [FO-04-19][FO-09-07]", () => {
  it("[FO-09-07] positive: an offered tool with schema-valid arguments, under auto, required and a matching named choice", () => {
    expect(violation({ tools: [LOOKUP_TOOL] }, [OK_LOOKUP])).toBeNull();
    expect(violation({ tools: [LOOKUP_TOOL], toolChoice: "required" }, [OK_LOOKUP])).toBeNull();
    expect(violation({ tools: [LOOKUP_TOOL, TRANSFER], toolChoice: { name: "lookup_status" } }, [OK_LOOKUP])).toBeNull();
    expect(violation({ tools: [LOOKUP_TOOL] }, [])).toBeNull();
    expect(violation({}, [])).toBeNull();
  });

  it("[FO-04-19] adversarial: a tool that was not offered, a call under toolChoice none, a call with no tools, a named-choice mismatch", () => {
    expect(violation({ tools: [LOOKUP_TOOL] }, [call("transfer_funds", { amountCents: 999_999 })])).toBe("MODEL_TOOL_NOT_OFFERED");
    expect(violation({ tools: [LOOKUP_TOOL], toolChoice: "none" }, [OK_LOOKUP])).toBe("MODEL_TOOL_CHOICE_VIOLATED");
    expect(violation({ tools: [] }, [OK_LOOKUP])).toBe("MODEL_TOOL_NOT_OFFERED");
    expect(violation({ tools: [LOOKUP_TOOL, TRANSFER], toolChoice: { name: "lookup_status" } }, [call("transfer_funds", { amountCents: 1 })])).toBe("MODEL_TOOL_CHOICE_VIOLATED");
    expect(violation({ tools: [LOOKUP_TOOL], toolChoice: "required" }, [])).toBe("MODEL_TOOL_CHOICE_VIOLATED");
    expect(violation({ tools: [LOOKUP_TOOL], toolChoice: { name: "lookup_status" } }, [])).toBe("MODEL_TOOL_CHOICE_VIOLATED");
    expect(violation({ tools: [LOOKUP_TOOL] }, [OK_LOOKUP, { ...OK_LOOKUP }])).toBe("MODEL_TOOL_CALL_INVALID");
  });

  it("[FO-04-19] adversarial: arguments that violate the declared schema (wrong type, extra property, missing property, bound)", () => {
    expect(violation({ tools: [LOOKUP_TOOL] }, [call("lookup_status", { reference: 12_345 })])).toBe("MODEL_TOOL_ARGUMENTS_SCHEMA_INVALID");
    expect(violation({ tools: [LOOKUP_TOOL] }, [call("lookup_status", { reference: "x", extra: "y" })])).toBe("MODEL_TOOL_ARGUMENTS_SCHEMA_INVALID");
    expect(violation({ tools: [LOOKUP_TOOL] }, [call("lookup_status", {})])).toBe("MODEL_TOOL_ARGUMENTS_SCHEMA_INVALID");
    expect(violation({ tools: [TRANSFER] }, [call("transfer_funds", { amountCents: 999_999 })])).toBe("MODEL_TOOL_ARGUMENTS_SCHEMA_INVALID");
  });

  it("[FO-09-06] Bedrock structured output: the forced response-schema tool is offered for Bedrock only, and its input is validated", () => {
    const responseSchema = { name: "intent", schema: { type: "object", properties: { intent: { type: "string" } }, required: ["intent"], additionalProperties: false } };
    expect(violation({ responseSchema }, [call("intent", { intent: "billing" })], "bedrock_converse")).toBeNull();
    expect(violation({ responseSchema }, [call("intent", { intent: 3 })], "bedrock_converse")).toBe("MODEL_TOOL_ARGUMENTS_SCHEMA_INVALID");
    expect(violation({ responseSchema }, [], "bedrock_converse")).toBe("MODEL_TOOL_CHOICE_VIOLATED");
    expect(violation({ responseSchema }, [call("intent", { intent: "billing" })], "openai_responses")).toBe("MODEL_TOOL_NOT_OFFERED");
  });

  it("[FO-04-19] the port returns MALFORMED (never COMPLETED) for a violation, and refuses a request whose tool schema does not compile before any exchange", async () => {
    const a = new OneShot("openai_responses", [call("transfer_funds", { amountCents: 999_999 })]);
    expect(await portFor(a).invoke(request({ tools: [LOOKUP_TOOL] }))).toMatchObject({ outcome: "MALFORMED", reasonCode: "MODEL_TOOL_NOT_OFFERED", attempts: 1 });
    const b = new OneShot("openai_responses", [OK_LOOKUP]);
    expect(await portFor(b).invoke(request({ tools: [LOOKUP_TOOL] }))).toMatchObject({ outcome: "COMPLETED", toolCalls: [OK_LOOKUP] });
    const c = new OneShot("openai_responses", []);
    const badSchema = { ...LOOKUP_TOOL, name: "bad_schema", parameters: { type: "object", properties: { x: { type: "not-a-type" } } } };
    expect(await portFor(c).invoke(request({ tools: [badSchema] }))).toMatchObject({ outcome: "FAILED", errorClass: "PERMANENT", reasonCode: "MODEL_TOOL_SCHEMA_INVALID", attempts: 0 });
    expect(c.calls).toBe(0);
  });
});

const tool = (name: string, parameters: Record<string, unknown>) => ({ name, description: "Synthetic tool.", parameters });
const compiles = (parameters: Record<string, unknown>, name = "synthetic_tool") => compileToolSchemas({ tools: [tool(name, parameters)], responseSchema: null }, "openai_responses").ok;

describe("tool schemas: declared dialect, strict, isolated validators [FO-04-19][FO-09-09]", () => {
  it("[FO-04-19] positive: every pinned gateway catalogue input schema (2020-12) compiles; a valid call is allowed and calls that break the schema are refused, per provider", () => {
    const tools = catalogTools();
    expect(tools.length).toBe(18);
    expect(new Set(tools.map((t) => t.parameters.$schema))).toEqual(new Set([TOOL_SCHEMA_DIALECT_2020_12]));
    expect(Object.keys(VALID_CATALOG_ARGUMENTS).sort()).toEqual(tools.map((t) => t.name).sort());
    for (const provider of ["openai_responses", "bedrock_converse", "vllm_openai_compatible"] as const) {
      const req = ModelRequest.parse(request({ tools }));
      const compiled = compileToolSchemas(req, provider);
      expect(compiled.ok, provider).toBe(true);
      if (!compiled.ok) continue;
      for (const t of tools) {
        expect(toolCallViolation(req, provider, [call(t.name, VALID_CATALOG_ARGUMENTS[t.name] as Record<string, unknown>)], compiled.offered), `${provider} ${t.name} valid`).toBeNull();
        for (const bad of invalidCatalogArguments(t.name)) expect(toolCallViolation(req, provider, [call(t.name, bad)], compiled.offered), `${provider} ${t.name} ${JSON.stringify(bad)}`).toBe("MODEL_TOOL_ARGUMENTS_SCHEMA_INVALID");
      }
    }
  });

  it("[FO-04-19] positive: catalogue semantics are enforced (oneOf locator, date format and pattern, Unicode letter pattern, array bound)", () => {
    const tools = catalogTools();
    const req = ModelRequest.parse(request({ tools }));
    const compiled = compileToolSchemas(req, "openai_responses");
    if (!compiled.ok) throw new Error("catalogue did not compile");
    const v = (name: string, args: Record<string, unknown>) => toolCallViolation(req, "openai_responses", [call(name, args)], compiled.offered);
    expect(v("begin_verification", { method: "SECURE_LINK", locator: { kind: "NAME_AND_DATE_OF_BIRTH", fullName: "Synthé Person", dateOfBirth: "1990-01-31" } })).toBeNull();
    expect(v("begin_verification", { method: "SECURE_LINK", locator: { kind: "NAME_AND_DATE_OF_BIRTH", fullName: "Synth Person", dateOfBirth: "1990-02-30" } })).toBe("MODEL_TOOL_ARGUMENTS_SCHEMA_INVALID");
    expect(v("begin_verification", { method: "SECURE_LINK", locator: { kind: "PORTAL_USERNAME_HINT", hint: "synth.user01", fullName: "Synth Person" } })).toBe("MODEL_TOOL_ARGUMENTS_SCHEMA_INVALID");
    expect(v("search_approved_runbook", { intent: "portal_login_help", query: "1234 5678", language: "en" })).toBe("MODEL_TOOL_ARGUMENTS_SCHEMA_INVALID");
    expect(v("request_human_transfer", { reason: "CALLER_REQUESTED_HUMAN", language: "en", issueCategory: null, accommodations: ["tty", "tty", "tty", "tty", "tty", "tty"] })).toBe("MODEL_TOOL_ARGUMENTS_SCHEMA_INVALID");
    expect(v("prepare_appointment_change", { appointmentId: null, startsAt: "2026-11-03 15:00", modality: null })).toBe("MODEL_TOOL_ARGUMENTS_SCHEMA_INVALID");
  });

  it("[FO-04-19] adversarial: 2020-12 keywords are applied, never ignored (unevaluatedProperties, dependentRequired, prefixItems)", () => {
    const unevaluated = { $schema: TOOL_SCHEMA_DIALECT_2020_12, type: "object", properties: { a: { type: "string" } }, allOf: [{ properties: { b: { type: "string" } } }], unevaluatedProperties: false };
    const dependent = { type: "object", properties: { amount: { type: "integer" }, currency: { type: "string" } }, dependentRequired: { amount: ["currency"] } };
    const prefix = { type: "object", properties: { pair: { type: "array", prefixItems: [{ type: "string" }, { type: "integer" }], minItems: 2, items: false } }, required: ["pair"], additionalProperties: false };
    const req = ModelRequest.parse(request({ tools: [tool("unevaluated", unevaluated), tool("dependent", dependent), tool("prefix", prefix)] }));
    const compiled = compileToolSchemas(req, "openai_responses");
    if (!compiled.ok) throw new Error(compiled.reasonCode);
    const v = (name: string, args: Record<string, unknown>) => toolCallViolation(req, "openai_responses", [call(name, args)], compiled.offered);
    expect(v("unevaluated", { a: "x", b: "y" })).toBeNull();
    expect(v("unevaluated", { a: "x", b: "y", injected: "synthetic" })).toBe("MODEL_TOOL_ARGUMENTS_SCHEMA_INVALID");
    expect(v("dependent", { amount: 5, currency: "USD" })).toBeNull();
    expect(v("dependent", { amount: 5 })).toBe("MODEL_TOOL_ARGUMENTS_SCHEMA_INVALID");
    expect(v("prefix", { pair: ["x", 1] })).toBeNull();
    expect(v("prefix", { pair: ["x", 1, "extra"] })).toBe("MODEL_TOOL_ARGUMENTS_SCHEMA_INVALID");
    expect(v("prefix", { pair: [1, "x"] })).toBe("MODEL_TOOL_ARGUMENTS_SCHEMA_INVALID");
  });

  it("[FO-04-19] adversarial: strict mode refuses a schema the validator could not fully apply (unknown keyword, keyword of another dialect, unknown format, unknown $schema, required without property)", () => {
    expect(compiles({ type: "object", properties: { a: { type: "string" } }, "x-synthetic-keyword": true })).toBe(false);
    expect(compiles({ type: "object", properties: { a: { type: "string", format: "synthetic-format" } } })).toBe(false);
    expect(compiles({ $schema: "http://json-schema.org/draft-07/schema#", type: "object", properties: { a: { type: "string" } }, unevaluatedProperties: false })).toBe(false);
    expect(compiles({ $schema: "http://json-schema.org/draft-07/schema#", type: "object", dependentRequired: { a: ["b"] } })).toBe(false);
    expect(compiles({ $schema: "https://json-schema.org/draft/2019-09/schema", type: "object" })).toBe(false);
    expect(compiles({ $schema: "https://synthetic.example.test/schema", type: "object" })).toBe(false);
    expect(compiles({ type: "object", properties: { a: { type: "string" } }, required: ["b"] })).toBe(false);
    expect(compiles({ type: "object", properties: { pair: { type: "array", prefixItems: [{ type: "string" }, { type: "integer" }] } } })).toBe(false);
    // Controls: the same shapes in their own dialect compile.
    expect(compiles({ $schema: "http://json-schema.org/draft-07/schema#", type: "object", properties: { a: { type: "string" } }, additionalProperties: false })).toBe(true);
    expect(compiles({ type: "object", properties: { a: { type: "string", format: "date" } }, required: ["a"] })).toBe(true);
  });

  it("[FO-04-19] a declared format is asserted, not only annotated", () => {
    const req = ModelRequest.parse(request({ tools: [tool("dated", { type: "object", properties: { on: { type: "string", format: "date" }, at: { type: "string", format: "date-time" } }, required: ["on"], additionalProperties: false })] }));
    const compiled = compileToolSchemas(req, "openai_responses");
    if (!compiled.ok) throw new Error(compiled.reasonCode);
    expect(toolCallViolation(req, "openai_responses", [call("dated", { on: "2026-10-01", at: "2026-10-01T10:00:00Z" })], compiled.offered)).toBeNull();
    expect(toolCallViolation(req, "openai_responses", [call("dated", { on: "2026-13-45" })], compiled.offered)).toBe("MODEL_TOOL_ARGUMENTS_SCHEMA_INVALID");
    expect(toolCallViolation(req, "openai_responses", [call("dated", { on: "2026-10-01", at: "yesterday" })], compiled.offered)).toBe("MODEL_TOOL_ARGUMENTS_SCHEMA_INVALID");
  });

  it("[FO-04-19] adversarial: compilation does not depend on process history: a schema with $id still compiles after more schemas than the cache holds, and twice in one request", () => {
    const withId = { $id: "urn:synthetic:tools:lookup", type: "object", properties: { reference: { type: "string" } }, required: ["reference"], additionalProperties: false };
    expect(compiles(withId)).toBe(true);
    for (let i = 0; i < 300; i += 1) expect(compiles({ type: "object", properties: { [`p${i}`]: { type: "integer", maximum: i } } })).toBe(true);
    expect(compiles(withId)).toBe(true);
    // Two tools of one request declaring the same $id (e.g. one shared definition) compile independently.
    const both = compileToolSchemas({ tools: [tool("first_tool", withId), tool("second_tool", withId)], responseSchema: null }, "openai_responses");
    expect(both.ok).toBe(true);
  });

  it("[FO-04-19] adversarial: a $ref resolves only inside its own schema, never to another request's (or tool's) schema, nor to a remote document", () => {
    const owner = { $id: "urn:synthetic:tenant-a:amount", type: "object", properties: { amountCents: { type: "integer", maximum: 1_000 } }, required: ["amountCents"], additionalProperties: false };
    expect(compiles(owner, "tenant_a_tool")).toBe(true);
    // Request B (another tenant) references request A's $id: refused, so it cannot borrow (or be weakened by) A's schema.
    expect(compiles({ type: "object", properties: { payment: { $ref: "urn:synthetic:tenant-a:amount" } } }, "tenant_b_tool")).toBe(false);
    const sameRequest = compileToolSchemas({ tools: [tool("defines", owner), tool("borrows", { type: "object", properties: { payment: { $ref: "urn:synthetic:tenant-a:amount" } } })], responseSchema: null }, "openai_responses");
    expect(sameRequest).toEqual({ ok: false, reasonCode: "MODEL_TOOL_SCHEMA_INVALID" });
    expect(compiles({ type: "object", properties: { payment: { $ref: "https://schemas.synthetic.example.test/amount.json" } } })).toBe(false);
    // Control: a local reference inside the schema itself resolves and is applied.
    const local = { type: "object", $defs: { cents: { type: "integer", maximum: 1_000 } }, properties: { amountCents: { $ref: "#/$defs/cents" } }, required: ["amountCents"], additionalProperties: false };
    const req = ModelRequest.parse(request({ tools: [tool("local_ref", local)] }));
    const compiled = compileToolSchemas(req, "openai_responses");
    if (!compiled.ok) throw new Error(compiled.reasonCode);
    expect(toolCallViolation(req, "openai_responses", [call("local_ref", { amountCents: 5 })], compiled.offered)).toBeNull();
    expect(toolCallViolation(req, "openai_responses", [call("local_ref", { amountCents: 5_000 })], compiled.offered)).toBe("MODEL_TOOL_ARGUMENTS_SCHEMA_INVALID");
  });

  it("[FO-09-06] Bedrock structured output declared in 2020-12 compiles and is validated", () => {
    const responseSchema = { name: "intent", schema: { $schema: TOOL_SCHEMA_DIALECT_2020_12, type: "object", properties: { intent: { type: "string", enum: ["billing", "other"] } }, required: ["intent"], additionalProperties: false } };
    expect(violation({ responseSchema }, [call("intent", { intent: "billing" })], "bedrock_converse")).toBeNull();
    expect(violation({ responseSchema }, [call("intent", { intent: "billing", injected: true })], "bedrock_converse")).toBe("MODEL_TOOL_ARGUMENTS_SCHEMA_INVALID");
  });
});
