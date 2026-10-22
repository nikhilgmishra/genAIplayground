/**
 * Per-provider matrix over the protocol-exact emulator (WP-08; FO-09-09, FO-09-46, FO-04-19, DATA-01, FO-09-07,
 * FO-09-08, FO-09-06): the same production path for every provider (createModelPorts -> ResilientModelPort ->
 * adapter -> egress-classified transport -> in-process emulator on 127.0.0.1), checked for
 *  - the error-class mapping RETRYABLE / PERMANENT / UNKNOWN, with the retry behaviour each class implies;
 *  - refusals rendered the way each provider really refuses (OpenAI refusal part; vLLM plain content; Bedrock
 *    guardrail_intervened only with a guardrail, otherwise plain text) and typed REFUSED;
 *  - tool-call proposals the request did not allow (MALFORMED, never COMPLETED);
 *  - the endpoint data-class ceiling and the destination classes (DATA-01), with zero provider requests;
 *  - long, well-formed streams on the buffered production exchange (COMPLETED, never a size failure).
 * Synthetic content only; no real provider is contacted.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decideModelFallback, speakableText } from "../port/fallback.js";
import type { ModelProvider } from "../port/types.js";
import { ModelEmulator } from "../../../test/emulators/models/server.js";
import { LOOKUP_TOOL, request, rig } from "../../../test/emulators/models/harness.js";
import { VALID_CATALOG_ARGUMENTS, catalogTools } from "../../../test/emulators/models/catalog-tools.js";

const PROVIDERS: readonly ModelProvider[] = ["openai_responses", "bedrock_converse", "vllm_openai_compatible"];
const RETRY = { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 10 };
const TRANSFER = { name: "transfer_funds", description: "Synthetic transfer tool.", parameters: { type: "object", properties: { amountCents: { type: "integer", maximum: 1000 } }, required: ["amountCents"], additionalProperties: false } };

let emulator: ModelEmulator;
beforeAll(async () => {
  emulator = await new ModelEmulator({ httpPort: 0, frameDelayMs: 0 }).start();
});
afterAll(async () => {
  await emulator.stop();
});

describe("error classes per provider [FO-09-09]", () => {
  it("[FO-09-09] OpenAI Responses: 5xx RETRYABLE (retried), invalid request / not found / context length PERMANENT, an unrecognised error code and an undocumented status UNKNOWN (never retried)", async () => {
    const r = await rig("openai_responses", { emulator, endpoint: { retry: RETRY } });
    r.emulator.queue(r.host, { kind: "server_error" }, { kind: "text", text: "Recovered synthetic reply.", chunks: 1 });
    expect(await r.port.invoke(request())).toMatchObject({ outcome: "COMPLETED", attempts: 2 });
    r.emulator.queue(r.host, { kind: "request_rejected" }, { kind: "request_rejected", status: 404 }, { kind: "context_window" }, { kind: "stream_error", code: "synthetic_unrecognised_code" }, { kind: "unexpected_status", status: 207 }, { kind: "engine_abort" }, { kind: "text", text: "Recovered.", chunks: 1 });
    expect(await r.port.invoke(request())).toMatchObject({ outcome: "FAILED", errorClass: "PERMANENT", reasonCode: "MODEL_REQUEST_REJECTED", httpStatus: 400, attempts: 1 });
    expect(await r.port.invoke(request())).toMatchObject({ outcome: "FAILED", errorClass: "PERMANENT", reasonCode: "MODEL_REQUEST_REJECTED", httpStatus: 404, attempts: 1 });
    expect(await r.port.invoke(request())).toMatchObject({ outcome: "FAILED", errorClass: "PERMANENT", reasonCode: "MODEL_REQUEST_REJECTED", detail: { errorCode: "context_length_exceeded" }, attempts: 1 });
    expect(await r.port.invoke(request())).toMatchObject({ outcome: "FAILED", errorClass: "UNKNOWN", reasonCode: "MODEL_RESPONSE_FAILED", detail: { errorCode: "synthetic_unrecognised_code" }, attempts: 1 });
    expect(await r.port.invoke(request())).toMatchObject({ outcome: "FAILED", errorClass: "UNKNOWN", reasonCode: "MODEL_HTTP_ERROR", httpStatus: 207, attempts: 1 });
    // response.failed (server_error) is RETRYABLE and retried.
    expect(await r.port.invoke(request())).toMatchObject({ outcome: "COMPLETED", attempts: 2 });
    expect(r.emulator.requests(r.host).map((l) => l.status)).toEqual([500, 200, 400, 404, 400, 200, 207, 200, 200]);
  });

  it("[FO-09-09] Bedrock ConverseStream: modelled exceptions keep their class (Validation / ResourceNotFound / ServiceQuotaExceeded PERMANENT, InternalServer and stream errors RETRYABLE, an unmodelled stream exception UNKNOWN); context window is INCOMPLETE", async () => {
    const r = await rig("bedrock_converse", { emulator, endpoint: { retry: RETRY } });
    r.emulator.queue(r.host, { kind: "request_rejected" }, { kind: "request_rejected", status: 404 }, { kind: "quota_exhausted" }, { kind: "stream_error", code: "syntheticUnmodelledException" }, { kind: "context_window" });
    expect(await r.port.invoke(request())).toMatchObject({ outcome: "FAILED", errorClass: "PERMANENT", reasonCode: "MODEL_REQUEST_REJECTED", httpStatus: 400, detail: { exception: "ValidationException" }, attempts: 1 });
    expect(await r.port.invoke(request())).toMatchObject({ outcome: "FAILED", errorClass: "PERMANENT", reasonCode: "MODEL_REQUEST_REJECTED", httpStatus: 404, detail: { exception: "ResourceNotFoundException" }, attempts: 1 });
    expect(await r.port.invoke(request())).toMatchObject({ outcome: "FAILED", errorClass: "PERMANENT", reasonCode: "MODEL_QUOTA_EXHAUSTED", detail: { exception: "ServiceQuotaExceededException" }, attempts: 1 });
    expect(await r.port.invoke(request())).toMatchObject({ outcome: "FAILED", errorClass: "UNKNOWN", reasonCode: "MODEL_PROVIDER_ERROR", detail: { exception: "syntheticUnmodelledException" }, attempts: 1 });
    const cw = await r.port.invoke(request());
    expect(cw).toMatchObject({ outcome: "INCOMPLETE", reasonCode: "MODEL_CONTEXT_WINDOW_EXCEEDED", detail: { stopReason: "model_context_window_exceeded" } });
    expect(speakableText(cw)).toBeNull();
    // RETRYABLE classes are retried within the budget.
    r.emulator.queue(r.host, { kind: "server_error" }, { kind: "text", text: "Recovered.", chunks: 1 }, { kind: "engine_abort" }, { kind: "text", text: "Recovered.", chunks: 1 });
    expect(await r.port.invoke(request())).toMatchObject({ outcome: "COMPLETED", attempts: 2 });
    expect(await r.port.invoke(request())).toMatchObject({ outcome: "COMPLETED", attempts: 2 });
    expect(r.emulator.requests(r.host)).toHaveLength(9);
  });

  it("[FO-09-09] vLLM: 400 / 404 / 422 and an over-long prompt PERMANENT, finish_reason abort RETRYABLE (retried), an undocumented status UNKNOWN", async () => {
    const r = await rig("vllm_openai_compatible", { emulator, endpoint: { retry: RETRY } });
    r.emulator.queue(r.host, { kind: "request_rejected" }, { kind: "request_rejected", status: 404 }, { kind: "request_rejected", status: 422 }, { kind: "context_window" }, { kind: "unexpected_status", status: 207 });
    for (const status of [400, 404, 422, 400]) expect(await r.port.invoke(request())).toMatchObject({ outcome: "FAILED", errorClass: "PERMANENT", reasonCode: "MODEL_REQUEST_REJECTED", httpStatus: status, attempts: 1 });
    expect(await r.port.invoke(request())).toMatchObject({ outcome: "FAILED", errorClass: "UNKNOWN", reasonCode: "MODEL_HTTP_ERROR", httpStatus: 207, attempts: 1 });
    // Without a retry budget the engine abort is a typed RETRYABLE failure; with one it is retried.
    const once = await rig("vllm_openai_compatible", { emulator });
    once.emulator.queue(once.host, { kind: "engine_abort" });
    expect(await once.port.invoke(request())).toMatchObject({ outcome: "FAILED", errorClass: "RETRYABLE", reasonCode: "MODEL_SERVER_ABORTED", detail: { finishReason: "abort" } });
    r.emulator.queue(r.host, { kind: "engine_abort" }, { kind: "text", text: "Recovered.", chunks: 1 });
    expect(await r.port.invoke(request())).toMatchObject({ outcome: "COMPLETED", attempts: 2 });
    // Overload through the gateway in front of vLLM: 503 with the Retry-After the fault script asks for.
    const o = await rig("vllm_openai_compatible", { emulator });
    o.emulator.injectFault(o.host, "MODEL_OVERLOAD", 1, { status: 503, retryAfterSeconds: 2 } as never);
    expect(await o.port.invoke(request())).toMatchObject({ outcome: "OVERLOADED", retryAfterMs: 2_000 });
  });
});

describe("refusals as each provider really sends them [FO-09-46][FAULT:MODEL_REFUSAL seam]", () => {
  it("[FO-09-46] OpenAI: the refusal content part is REFUSED MODEL_REFUSAL; a prose refusal without the part is REFUSED CLASSIFIED_REFUSAL", async () => {
    const r = await rig("openai_responses", { emulator });
    r.emulator.injectFault(r.host, "MODEL_REFUSAL");
    r.emulator.queue(r.host, { kind: "text", text: "I'm sorry, but I can't assist with that request.", chunks: 2 });
    expect(await r.port.invoke(request())).toMatchObject({ outcome: "REFUSED", refusal: { source: "MODEL_REFUSAL" } });
    const prose = await r.port.invoke(request());
    expect(prose).toMatchObject({ outcome: "REFUSED", refusal: { source: "CLASSIFIED_REFUSAL", reasonCode: "MODEL_REFUSAL_CLASSIFIED" } });
    expect(speakableText(prose)).toBeNull();
  });

  it("[FO-09-46] vLLM: the MODEL_REFUSAL seam is plain content with finish_reason stop (what vLLM sends); the port classifies it, the fallback replaces it", async () => {
    const r = await rig("vllm_openai_compatible", { emulator });
    r.emulator.injectFault(r.host, "MODEL_REFUSAL");
    const result = await r.port.invoke(request());
    expect(result).toMatchObject({ outcome: "REFUSED", refusal: { source: "CLASSIFIED_REFUSAL" }, detail: { finishReason: "stop", servedModel: "emulated-text" } });
    expect(speakableText(result)).toBeNull();
    expect(decideModelFallback(result, { safetySignalActive: false })).toMatchObject({ kind: "APPROVED_FALLBACK", reason: "MODEL_REFUSED", decisions: [{ templateId: "fallback.safe_explanation" }, { reason: "AI_UNAVAILABLE" }] });
    // vLLM has no content filter: the content_filter script is the same plain-text refusal, never a finish_reason it does not send.
    r.emulator.queue(r.host, { kind: "content_filter" });
    expect(await r.port.invoke(request())).toMatchObject({ outcome: "REFUSED", refusal: { source: "CLASSIFIED_REFUSAL" }, detail: { finishReason: "stop" } });
  });

  it("[FO-09-46][FO-09-06] Bedrock: guardrail_intervened only for a request that carries the endpoint's guardrail; without one the refusal is plain text with end_turn, classified", async () => {
    const g = await rig("bedrock_converse", { emulator, endpoint: { bedrock: { guardrail: { identifier: "gr1synth", version: "1" } } } });
    g.emulator.injectFault(g.host, "MODEL_REFUSAL");
    const guarded = await g.port.invoke(request());
    expect(guarded).toMatchObject({ outcome: "REFUSED", refusal: { source: "GUARDRAIL_INTERVENED", reasonCode: "MODEL_GUARDRAIL_INTERVENED" }, detail: { stopReason: "guardrail_intervened" } });
    expect(g.emulator.requests(g.host)[0]).toMatchObject({ guardrail: true, script: "refusal", sigv4: "VERIFIED" });
    const n = await rig("bedrock_converse", { emulator });
    n.emulator.injectFault(n.host, "MODEL_REFUSAL");
    const plain = await n.port.invoke(request());
    expect(plain).toMatchObject({ outcome: "REFUSED", refusal: { source: "CLASSIFIED_REFUSAL" }, detail: { stopReason: "end_turn" } });
    expect(n.emulator.requests(n.host)[0]).toMatchObject({ guardrail: false, script: "refusal" });
    for (const r of [guarded, plain]) {
      expect(speakableText(r)).toBeNull();
      expect(decideModelFallback(r, { safetySignalActive: true })).toMatchObject({ kind: "APPROVED_FALLBACK", safetyRoute: true });
    }
  });
});

describe("tool-call proposals the request did not allow are MALFORMED [FO-04-19]", () => {
  for (const provider of PROVIDERS) {
    it(`[FO-04-19] ${provider}: an un-offered tool, a call under toolChoice none, a call with no tools, schema-violating arguments`, async () => {
      const r = await rig(provider, { emulator });
      r.emulator.queue(
        r.host,
        { kind: "tool_call", name: "transfer_funds", arguments: { amountCents: 999_999 } },
        { kind: "tool_call", name: "lookup_status", arguments: { reference: "synthetic" } },
        { kind: "tool_call", name: "lookup_status", arguments: { reference: "synthetic" } },
        { kind: "tool_call", name: "lookup_status", arguments: { reference: 12_345, extra: "x" } },
        { kind: "tool_call", name: "transfer_funds", arguments: { amountCents: 999_999 } },
        { kind: "tool_call", name: "lookup_status", arguments: { reference: "synthetic" } },
      );
      expect(await r.port.invoke(request({ tools: [LOOKUP_TOOL] }))).toMatchObject({ outcome: "MALFORMED", reasonCode: "MODEL_TOOL_NOT_OFFERED" });
      expect(await r.port.invoke(request({ tools: [LOOKUP_TOOL], toolChoice: "none" }))).toMatchObject({ outcome: "MALFORMED", reasonCode: "MODEL_TOOL_CHOICE_VIOLATED" });
      expect(await r.port.invoke(request({ tools: [] }))).toMatchObject({ outcome: "MALFORMED", reasonCode: "MODEL_TOOL_NOT_OFFERED" });
      expect(await r.port.invoke(request({ tools: [LOOKUP_TOOL] }))).toMatchObject({ outcome: "MALFORMED", reasonCode: "MODEL_TOOL_ARGUMENTS_SCHEMA_INVALID" });
      // A schema bound the arguments break (amountCents above its maximum), with the tool offered.
      expect(await r.port.invoke(request({ tools: [LOOKUP_TOOL, TRANSFER] }))).toMatchObject({ outcome: "MALFORMED", reasonCode: "MODEL_TOOL_ARGUMENTS_SCHEMA_INVALID" });
      // Positive control: the allowed call is COMPLETED with the parsed proposal.
      expect(await r.port.invoke(request({ tools: [LOOKUP_TOOL] }))).toMatchObject({ outcome: "COMPLETED", toolCalls: [{ name: "lookup_status", arguments: { reference: "synthetic" } }] });
      expect(r.emulator.requests(r.host)).toHaveLength(6);
    });
  }
});

describe("the gateway's pinned tool catalogue offered to every provider [FO-04-19][FO-09-09]", () => {
  for (const provider of PROVIDERS) {
    it(`[FO-04-19] ${provider}: all 18 catalogue tools (2020-12 schemas) are offered and sent; a valid catalogue call is COMPLETED, a call that breaks its schema is MALFORMED`, async () => {
      const r = await rig(provider, { emulator });
      const tools = catalogTools();
      const claim = VALID_CATALOG_ARGUMENTS.get_claim_status as Record<string, unknown>;
      r.emulator.queue(
        r.host,
        { kind: "tool_call", name: "get_claim_status", arguments: claim },
        { kind: "tool_call", name: "get_claim_status", arguments: { ...claim, injected: "synthetic" } },
        { kind: "tool_call", name: "begin_verification", arguments: { method: "SECURE_LINK", locator: { kind: "NAME_AND_DATE_OF_BIRTH", fullName: "Synth Person", dateOfBirth: "1990-02-30" } } },
      );
      expect(await r.port.invoke(request({ tools }))).toMatchObject({ outcome: "COMPLETED", toolCalls: [{ name: "get_claim_status", arguments: claim }] });
      expect(await r.port.invoke(request({ tools }))).toMatchObject({ outcome: "MALFORMED", reasonCode: "MODEL_TOOL_ARGUMENTS_SCHEMA_INVALID" });
      expect(await r.port.invoke(request({ tools }))).toMatchObject({ outcome: "MALFORMED", reasonCode: "MODEL_TOOL_ARGUMENTS_SCHEMA_INVALID" });
      // Every request reached the provider with the catalogue tools (the schemas were not refused before I/O).
      expect(r.emulator.requests(r.host)).toHaveLength(3);
      expect(r.emulator.requests(r.host).every((l) => l.status === 200)).toBe(true);
    });
  }
});

describe("data classes per request [DATA-01]", () => {
  for (const provider of PROVIDERS) {
    it(`[DATA-01] ${provider}: PHI above the endpoint ceiling is refused before any request even when the destination allows PHI; a class the destination does not approve is refused per request by the transport's egress check`, async () => {
      const r = await rig(provider, { emulator, egressAllowsPhi: true });
      expect(r.endpoint.maxDataClass).toBe("INTERNAL");
      expect(await r.port.invoke(request({ dataClass: "PHI" }))).toMatchObject({ outcome: "UNAVAILABLE", reasonCode: "MODEL_DATA_CLASS_EXCEEDS_ENDPOINT", attempts: 0 });
      expect(await r.port.invoke(request({ dataClass: "VERIFICATION_SECRET" }))).toMatchObject({ outcome: "UNAVAILABLE", reasonCode: "MODEL_DATA_CLASS_EXCEEDS_ENDPOINT", attempts: 0 });
      expect(r.emulator.requests(r.host)).toEqual([]);
      // Endpoint ceiling PHI, destination approved for synthetic classes only: never composed (NOT_CONFIGURED,
      // EGRESS_PHI_NOT_APPROVED_FOR_DESTINATION), so there is no port that could send it.
      await expect(rig(provider, { emulator, endpoint: { maxDataClass: "PHI" } })).rejects.toThrow("port not composed");
      // Both allow PHI: the request is sent (synthetic content only).
      const both = await rig(provider, { emulator, endpoint: { maxDataClass: "PHI" }, egressAllowsPhi: true });
      expect((await both.port.invoke(request({ dataClass: "PHI" }))).outcome).toBe("COMPLETED");
      expect(both.emulator.requests(both.host)).toHaveLength(1);
      // Per request, the transport's own model egress check: FINANCIAL is under the endpoint ceiling (PHI) but the
      // destination approves PUBLIC, INTERNAL and PHI only, so the exchange is refused before any byte is sent.
      const fin = await both.port.invoke(request({ dataClass: "FINANCIAL" }));
      expect(fin).toMatchObject({ outcome: "UNAVAILABLE", reasonCode: "EGRESS_CLASS_NOT_APPROVED_FOR_DESTINATION", attempts: 1 });
      expect(both.emulator.requests(both.host)).toHaveLength(1);
      expect(both.metrics.counterValue("vsp_egress_denied_total", { reason: "EGRESS_CLASS_NOT_APPROVED_FOR_DESTINATION" })).toBe(1);
    });

    it(`[DATA-01] ${provider}: boundary: a class exactly one rank above the endpoint ceiling (FINANCIAL over INTERNAL) is refused before any request although the destination approves it; the ceiling class itself is sent`, async () => {
      const r = await rig(provider, { emulator, egressClasses: ["PUBLIC", "INTERNAL", "FINANCIAL"] });
      expect(r.endpoint.maxDataClass).toBe("INTERNAL");
      expect(await r.port.invoke(request({ dataClass: "FINANCIAL" }))).toMatchObject({ outcome: "UNAVAILABLE", reasonCode: "MODEL_DATA_CLASS_EXCEEDS_ENDPOINT", attempts: 0 });
      expect(r.emulator.requests(r.host)).toEqual([]);
      expect(r.metrics.counterValue("vsp_egress_denied_total", { reason: "EGRESS_CLASS_NOT_APPROVED_FOR_DESTINATION" })).toBe(0);
      // Control: the destination really approves FINANCIAL (an endpoint whose ceiling is FINANCIAL sends it).
      const fin = await rig(provider, { emulator, endpoint: { maxDataClass: "FINANCIAL" }, egressClasses: ["PUBLIC", "INTERNAL", "FINANCIAL"] });
      expect(await fin.port.invoke(request({ dataClass: "FINANCIAL" }))).toMatchObject({ outcome: "COMPLETED", attempts: 1 });
      expect(fin.emulator.requests(fin.host)).toHaveLength(1);
      // The ceiling class and the classes below it are sent on the INTERNAL endpoint.
      expect((await r.port.invoke(request({ dataClass: "INTERNAL" }))).outcome).toBe("COMPLETED");
      expect((await r.port.invoke(request({ dataClass: "PUBLIC" }))).outcome).toBe("COMPLETED");
      expect(r.emulator.requests(r.host)).toHaveLength(2);
    });
  }
});

describe("long well-formed streams on the buffered production exchange [FO-09-07][FO-09-08][FO-09-06]", () => {
  for (const provider of PROVIDERS) {
    it(`[FO-09-09] ${provider}: a 3,000-delta answer within the output budget and the transport cap is COMPLETED, never a size failure`, async () => {
      const r = await rig(provider, { emulator, endpoint: { budget: { deadlineMs: 20_000, attemptTimeoutMs: 20_000, firstEventTimeoutMs: 10_000, idleTimeoutMs: 10_000, maxOutputTokens: 8_192, maxInputBytes: 65_536 } } });
      const text = "word ".repeat(3_000);
      r.emulator.queue(r.host, { kind: "text", text, chunks: 3_000 });
      let deltas = 0;
      const result = await r.port.invoke(request({ budget: { deadlineMs: 20_000, attemptTimeoutMs: 20_000, firstEventTimeoutMs: 10_000, idleTimeoutMs: 10_000, maxOutputTokens: 8_192, maxInputBytes: 65_536 } }), { onEvent: (e) => e.type === "text_delta" && (deltas += 1) });
      expect(result).toMatchObject({ outcome: "COMPLETED", text });
      expect(deltas).toBe(3_000);
    }, 30_000);
  }
});
