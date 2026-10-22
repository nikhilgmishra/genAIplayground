/**
 * Structured output and tool names checked by the port (WP-08; FO-09-09, FO-09-08, FO-04-19; security review r4).
 * A response schema is never dropped silently, never sent uncompiled, and the answer is validated against it for
 * every provider; duplicate tool names are refused before any I/O. Per provider over the in-process protocol
 * emulator (production adapters, factory-composed port, the egress-classified transport over loopback HTTP), plus
 * unit checks of tool-calls.ts. Every answer text below is a neutral synthetic marker.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ModelEmulator } from "../../../test/emulators/models/server.js";
import { LOOKUP_TOOL, request, rig } from "../../../test/emulators/models/harness.js";
import { decideModelFallback, speakableText } from "./fallback.js";
import { TOOL_SCHEMA_CACHE_MAX, compileToolSchemas, structuredOutputViolation, toolCallViolation, toolSchemaCacheSize } from "./tool-calls.js";
import { ModelRequest } from "./types.js";
import type { ModelResult } from "./types.js";

let emulator: ModelEmulator;
beforeAll(async () => {
  emulator = await new ModelEmulator({ httpPort: 0, frameDelayMs: 1 }).start();
});
afterAll(async () => {
  await emulator.stop();
});

/** A strict 2020-12 response schema: one enum field, nothing else. */
const DECISION = { name: "decision", schema: { type: "object", properties: { decision: { type: "string", enum: ["synthetic_a", "synthetic_b"] } }, required: ["decision"], additionalProperties: false } };
const MARK = { freeText: "synthetic-free-text-marker-06", refusal: "I can't help with that request." };
const TEXT_PROVIDERS = ["openai_responses", "vllm_openai_compatible"] as const;
const ALL = ["openai_responses", "vllm_openai_compatible", "bedrock_converse"] as const;

function expectNotSpoken(result: ModelResult) {
  expect(speakableText(result)).toBeNull();
  expect(decideModelFallback(result, { safetySignalActive: false })).toMatchObject({ kind: "APPROVED_FALLBACK", suppressModelText: true });
}

describe("structured output is enforced by the port, per provider [FO-09-09][FO-04-19]", () => {
  it("[FO-09-09] positive control: a schema-valid JSON answer (OpenAI text.format, vLLM response_format) and the Bedrock forced tool call are COMPLETED", async () => {
    for (const provider of TEXT_PROVIDERS) {
      const r = await rig(provider, { emulator });
      const result = await r.port.invoke(request({ responseSchema: DECISION }));
      expect(result, provider).toMatchObject({ outcome: "COMPLETED", text: JSON.stringify({ decision: "synthetic_a" }) });
      expect(r.emulator.requests(r.host)).toHaveLength(1);
    }
    const b = await rig("bedrock_converse", { emulator, endpoint: { model: { id: "emulated-tools", revision: "emulated.1" } } });
    expect(await b.port.invoke(request({ responseSchema: DECISION }))).toMatchObject({ outcome: "COMPLETED", text: "", toolCalls: [{ name: "decision", arguments: { decision: "synthetic_a" } }] });
  });

  it("[FO-09-09][FO-04-19] adversarial (p02 S2/S3): answer text that breaks the schema (enum, extra field), is not JSON, or is empty is MALFORMED MODEL_STRUCTURED_OUTPUT_INVALID, never speakable", async () => {
    for (const provider of TEXT_PROVIDERS) {
      const r = await rig(provider, { emulator });
      r.emulator.queue(
        r.host,
        { kind: "text", text: JSON.stringify({ decision: "synthetic_c" }) },
        { kind: "text", text: JSON.stringify({ decision: "synthetic_a", extra: 1 }) },
        { kind: "text", text: MARK.freeText },
        { kind: "text", text: "" },
      );
      for (let i = 0; i < 4; i += 1) {
        const result = await r.port.invoke(request({ responseSchema: DECISION }));
        expect(result, `${provider} #${i}`).toMatchObject({ outcome: "MALFORMED", reasonCode: "MODEL_STRUCTURED_OUTPUT_INVALID" });
        expectNotSpoken(result);
      }
      // A plain refusal under structured output is still classified as a refusal (never MALFORMED, never spoken).
      r.emulator.queue(r.host, { kind: "text", text: MARK.refusal });
      expect(await r.port.invoke(request({ responseSchema: DECISION })), provider).toMatchObject({ outcome: "REFUSED", refusal: { source: "CLASSIFIED_REFUSAL" } });
    }
  });

  it("[FO-09-06] adversarial: free text beside the Bedrock forced structured-output call is MALFORMED (the forced call is the answer)", async () => {
    const b = await rig("bedrock_converse", { emulator, endpoint: { model: { id: "emulated-tools", revision: "emulated.1" } } });
    b.emulator.queue(b.host, { kind: "tool_call", name: "decision", arguments: { decision: "synthetic_a" }, text: MARK.freeText });
    const result = await b.port.invoke(request({ responseSchema: DECISION }));
    expect(result).toMatchObject({ outcome: "MALFORMED", reasonCode: "MODEL_STRUCTURED_OUTPUT_INVALID" });
    expectNotSpoken(result);
  });

  it("[FO-09-08] adversarial (p02 S1): a vLLM endpoint without json_schema support refuses a structured-output request before any I/O (MODEL_STRUCTURED_OUTPUT_UNSUPPORTED), never sends it with the schema dropped", async () => {
    const r = await rig("vllm_openai_compatible", { emulator, endpoint: { vllm: { toolParser: "hermes", structuredOutput: "none" } } });
    const result = await r.port.invoke(request({ responseSchema: DECISION }));
    expect(result).toMatchObject({ outcome: "FAILED", errorClass: "PERMANENT", reasonCode: "MODEL_STRUCTURED_OUTPUT_UNSUPPORTED", attempts: 0, sentAttempts: 0 });
    expect(r.emulator.requests(r.host)).toEqual([]);
    expect(r.lookups).toEqual([]);
    // The same endpoint still serves requests without a response schema.
    expect(await r.port.invoke(request())).toMatchObject({ outcome: "COMPLETED" });
    expect(r.emulator.requests(r.host)).toHaveLength(1);
  });

  it("[FO-09-09] adversarial (p02 S4): a response schema that does not compile (unknown type, unknown keyword) is refused before any I/O, for every provider", async () => {
    const broken = [
      { name: "decision", schema: { type: "object", properties: { decision: { type: "synthetic-unknown-type" } } } },
      { name: "decision", schema: { type: "object", syntheticUnknownKeyword: true } },
    ];
    for (const provider of ALL) {
      const r = await rig(provider, { emulator });
      for (const responseSchema of broken) {
        expect(await r.port.invoke(request({ responseSchema })), provider).toMatchObject({ outcome: "FAILED", errorClass: "PERMANENT", reasonCode: provider === "bedrock_converse" ? "MODEL_TOOL_SCHEMA_INVALID" : "MODEL_RESPONSE_SCHEMA_INVALID", attempts: 0 });
      }
      expect(r.emulator.requests(r.host), provider).toEqual([]);
    }
  });

  it("[FO-04-19] adversarial (p02 S5): duplicate tool names (strict first, permissive second) and a Bedrock tool named like the response schema are refused before any I/O", async () => {
    const strict = { ...LOOKUP_TOOL, parameters: { type: "object", properties: { reference: { type: "string", maxLength: 8 } }, required: ["reference"], additionalProperties: false } };
    const permissive = { ...LOOKUP_TOOL, description: "Synthetic permissive duplicate.", parameters: { type: "object" } };
    for (const provider of ALL) {
      const r = await rig(provider, { emulator, endpoint: { model: { id: "emulated-tools", revision: "emulated.1" } } });
      expect(await r.port.invoke(request({ tools: [strict, permissive] })), provider).toMatchObject({ outcome: "FAILED", errorClass: "PERMANENT", reasonCode: "MODEL_TOOL_NAME_DUPLICATE", attempts: 0 });
      expect(r.emulator.requests(r.host), provider).toEqual([]);
    }
    const b = await rig("bedrock_converse", { emulator });
    expect(await b.port.invoke(request({ tools: [{ ...LOOKUP_TOOL, name: "decision" }], responseSchema: DECISION }))).toMatchObject({ outcome: "FAILED", reasonCode: "MODEL_TOOL_NAME_DUPLICATE", attempts: 0 });
    expect(b.emulator.requests(b.host)).toEqual([]);
  });
});

describe("tool-calls.ts structured-output and name checks (unit) [FO-09-09]", () => {
  it("[FO-04-19] the validator used for a call is the one tool of that name (no duplicate can loosen it)", () => {
    const strict = { ...LOOKUP_TOOL, parameters: { type: "object", properties: { reference: { type: "string", maxLength: 8 } }, required: ["reference"], additionalProperties: false } };
    const req = ModelRequest.parse(request({ tools: [strict] }));
    const compiled = compileToolSchemas(req, "openai_responses");
    if (!compiled.ok) throw new Error(compiled.reasonCode);
    expect(toolCallViolation(req, "openai_responses", [{ callId: "call_s5", name: "lookup_status", arguments: { reference: "SYNTHETIC-LONG-REFERENCE", injected: true } }], compiled.offered)).toBe("MODEL_TOOL_ARGUMENTS_SCHEMA_INVALID");
    expect(compileToolSchemas({ tools: [strict, { ...strict, parameters: { type: "object" } }], responseSchema: null }, "vllm_openai_compatible")).toEqual({ ok: false, reasonCode: "MODEL_TOOL_NAME_DUPLICATE" });
  });

  it("[FO-09-09] structuredOutputViolation: JSON text validated for OpenAI and vLLM; tool-only turns pass to the call checks; Bedrock text beside the forced call fails", () => {
    const req = ModelRequest.parse(request({ responseSchema: DECISION }));
    const compiled = compileToolSchemas(req, "openai_responses");
    if (!compiled.ok) throw new Error(compiled.reasonCode);
    const ok = JSON.stringify({ decision: "synthetic_b" });
    for (const provider of TEXT_PROVIDERS) {
      expect(structuredOutputViolation(req, provider, { text: ok, toolCalls: [] }, compiled.response)).toBeNull();
      expect(structuredOutputViolation(req, provider, { text: `${ok} ${MARK.freeText}`, toolCalls: [] }, compiled.response)).toBe("MODEL_STRUCTURED_OUTPUT_INVALID");
      expect(structuredOutputViolation(req, provider, { text: "[]", toolCalls: [] }, compiled.response)).toBe("MODEL_STRUCTURED_OUTPUT_INVALID");
      expect(structuredOutputViolation(req, provider, { text: "", toolCalls: [{ callId: "call_t", name: "lookup_status", arguments: {} }] }, compiled.response)).toBeNull();
      // Text beside tool calls is still the answer text: it must satisfy the schema too.
      expect(structuredOutputViolation(req, provider, { text: MARK.freeText, toolCalls: [{ callId: "call_t", name: "lookup_status", arguments: {} }] }, compiled.response)).toBe("MODEL_STRUCTURED_OUTPUT_INVALID");
      // A compiled schema is required whenever the request has one (fail closed).
      expect(structuredOutputViolation(req, provider, { text: ok, toolCalls: [] }, null)).toBe("MODEL_STRUCTURED_OUTPUT_INVALID");
    }
    expect(structuredOutputViolation(req, "bedrock_converse", { text: " ", toolCalls: [] }, compiled.response)).toBeNull();
    expect(structuredOutputViolation(req, "bedrock_converse", { text: MARK.freeText, toolCalls: [] }, compiled.response)).toBe("MODEL_STRUCTURED_OUTPUT_INVALID");
    // No response schema: nothing to check.
    expect(structuredOutputViolation(ModelRequest.parse(request()), "openai_responses", { text: MARK.freeText, toolCalls: [] }, null)).toBeNull();
  });

  it("[FO-04-19] the compiled-validator cache stays bounded, whatever number of distinct schemas a process sees", () => {
    for (let i = 0; i < TOOL_SCHEMA_CACHE_MAX + 8; i += 1) {
      const compiled = compileToolSchemas({ tools: [{ name: "bounded_tool", description: "Synthetic bounded tool.", parameters: { type: "object", properties: { [`field_${i}`]: { type: "integer", maximum: i } } } }], responseSchema: null }, "openai_responses");
      expect(compiled.ok).toBe(true);
      expect(toolSchemaCacheSize()).toBeLessThanOrEqual(TOOL_SCHEMA_CACHE_MAX);
    }
    expect(toolSchemaCacheSize()).toBe(TOOL_SCHEMA_CACHE_MAX);
  });
});
