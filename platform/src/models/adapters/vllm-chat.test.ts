/**
 * vLLM OpenAI-compatible adapter against the protocol-exact emulator (WP-08; FO-09-08, FO-09-09, FO-09-45, FO-16-18).
 * Production path over the egress-classified transport; in-process test emulator on 127.0.0.1. A real vLLM server
 * (GPU host, AIN-27) is not used here: the emulator speaks vLLM's documented chunk protocol and its tool-parser
 * failure mode (raw parser markup in `content`).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { speakableText } from "../port/fallback.js";
import { ModelRequest } from "../port/types.js";
import { ModelEmulator } from "../../../test/emulators/models/server.js";
import { LOOKUP_TOOL, request, rig } from "../../../test/emulators/models/harness.js";
import { TOOL_PARSER_MARKERS, VllmChatAdapter, vllmChatBody } from "./vllm-chat.js";

let emulator: ModelEmulator;
beforeAll(async () => {
  emulator = await new ModelEmulator({ httpPort: 0, frameDelayMs: 1 }).start();
});
afterAll(async () => {
  await emulator.stop();
});

describe("vLLM Chat Completions adapter over the emulator [FO-09-08][FO-09-09]", () => {
  it("[FO-09-08] streams chunks to [DONE], checks the served model name, reports usage", async () => {
    const r = await rig("vllm_openai_compatible", { emulator });
    const result = await r.port.invoke(request());
    expect(result).toMatchObject({ outcome: "COMPLETED", provider: "vllm_openai_compatible", text: "This is a synthetic emulated reply.", detail: { finishReason: "stop", toolParser: "hermes", servedModel: "emulated-text" } });
    expect(result.usage).toMatchObject({ inputTokens: expect.any(Number), outputTokens: 6 });
    expect(r.emulator.requests(r.host)[0]).toMatchObject({ api: "chat_completions", authorized: true, stream: true });
  });

  it("[FO-09-08] the request carries the instructions as the system message, stream_options.include_usage and vLLM json_schema structured output", () => {
    const req = ModelRequest.parse(request({ responseSchema: { name: "intent", schema: { type: "object", properties: { intent: { type: "string" } }, required: ["intent"] } } }));
    const body = vllmChatBody("served-synth", req, "json_schema");
    expect(body.messages[0]).toEqual({ role: "system", content: req.instructions });
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.response_format).toMatchObject({ type: "json_schema", json_schema: { name: "intent", strict: true } });
    // An endpoint without json_schema support never builds the request with the schema dropped (security review r4).
    expect(() => vllmChatBody("served-synth", req, "none")).toThrow(expect.objectContaining({ reasonCode: "MODEL_STRUCTURED_OUTPUT_UNSUPPORTED", outcome: "NOT_STARTED" }));
    expect(vllmChatBody("served-synth", ModelRequest.parse(request()), "none").response_format).toBeUndefined();
  });

  it("[FO-09-08] adversarial: the adapter itself (defense in depth below the port) refuses a structured-output request on an endpoint without json_schema, before any exchange", async () => {
    let sends = 0;
    // UNIT FAKE exchange: counts sends; it must never be reached.
    const exchange = { incremental: false, async send(): Promise<never> { sends += 1; throw new Error("unreachable"); } };
    let tokenReads = 0;
    const credential = { kind: "bearer" as const, token: async () => ((tokenReads += 1), "key_synthWire") };
    const adapter = new VllmChatAdapter({ url: new URL("https://vllm.models.test/v1/chat/completions"), servedModel: "emulated-text", toolParser: "hermes", structuredOutput: "none", credential, exchange });
    expect(adapter.supportsStructuredOutput).toBe(false);
    const req = ModelRequest.parse(request({ responseSchema: { name: "intent", schema: { type: "object" } } }));
    await expect(adapter.attempt(req, { signal: new AbortController().signal, emit: () => {}, attempt: 1 })).rejects.toMatchObject({ reasonCode: "MODEL_STRUCTURED_OUTPUT_UNSUPPORTED", outcome: "NOT_STARTED" });
    // Refused before the credential is even read, and nothing is sent.
    expect(tokenReads).toBe(0);
    expect(sends).toBe(0);
  });

  it("[FO-09-08][FO-09-09] tool calls through the pinned parser: deltas become a parsed call and the tool message round trip is accepted", async () => {
    const r = await rig("vllm_openai_compatible", { emulator, endpoint: { model: { id: "emulated-tools", revision: "emulated.1" } } });
    const first = await r.port.invoke(request({ tools: [LOOKUP_TOOL] }));
    expect(first).toMatchObject({ outcome: "COMPLETED", detail: { finishReason: "tool_calls" } });
    if (first.outcome !== "COMPLETED") return;
    expect(first.toolCalls).toEqual([{ callId: expect.stringMatching(/^chatcmpl-tool-/), name: "lookup_status", arguments: { reference: "synthetic" } }]);
    const call = first.toolCalls[0]!;
    const second = await r.port.invoke(request({ tools: [LOOKUP_TOOL], messages: [{ role: "user", content: "Synthetic caller turn." }, { role: "assistant", content: "", toolCalls: [call] }, { role: "tool", callId: call.callId, name: call.name, content: "{}" }] }));
    expect(second).toMatchObject({ outcome: "COMPLETED", text: "The synthetic tool result was received." });
  });

  it("[FO-09-08] adversarial: raw tool-call markup of the pinned parser in content is MALFORMED and never speakable", async () => {
    const r = await rig("vllm_openai_compatible", { emulator });
    r.emulator.queue(r.host, { kind: "malformed", variant: "tool_markup_leak" });
    const result = await r.port.invoke(request());
    expect(result).toMatchObject({ outcome: "MALFORMED", reasonCode: "MODEL_TOOL_MARKUP_LEAKED" });
    expect(speakableText(result)).toBeNull();
    // Every parser vLLM ships has its own marker; plain prose matches none of them.
    for (const [parser, re] of Object.entries(TOOL_PARSER_MARKERS)) expect(re.test("Your synthetic appointment is on file."), parser).toBe(false);
    expect(TOOL_PARSER_MARKERS.mistral.test('[TOOL_CALLS][{"name":"x"}]')).toBe(true);
  });

  it("[FO-09-08][FO-19-09] adversarial: a chunk naming another served model, or chunks naming none, are MALFORMED (the pin cannot be bypassed)", async () => {
    const r = await rig("vllm_openai_compatible", { emulator });
    r.emulator.queue(r.host, { kind: "malformed", variant: "served_name_mismatch" }, { kind: "malformed", variant: "missing_served_name" });
    expect(await r.port.invoke(request())).toMatchObject({ outcome: "MALFORMED", reasonCode: "MODEL_SERVED_NAME_MISMATCH" });
    const unnamed = await r.port.invoke(request());
    expect(unnamed).toMatchObject({ outcome: "MALFORMED", reasonCode: "MODEL_SERVED_NAME_MISSING" });
    expect(speakableText(unnamed)).toBeNull();
  });

  it("[FO-09-08] adversarial: content after the choice finished, and a tool call renamed at the same index, are MALFORMED (never appended, never the original proposal)", async () => {
    const r = await rig("vllm_openai_compatible", { emulator });
    r.emulator.queue(r.host, { kind: "malformed", variant: "content_after_finish" }, { kind: "malformed", variant: "tool_call_renamed" });
    const after = await r.port.invoke(request());
    expect(after).toMatchObject({ outcome: "MALFORMED", reasonCode: "MODEL_STREAM_CONTENT_AFTER_FINISH" });
    expect(speakableText(after)).toBeNull();
    const TRANSFER = { name: "transfer_funds", description: "Synthetic transfer tool.", parameters: { type: "object", properties: { reference: { type: "string" } }, additionalProperties: false } };
    expect(await r.port.invoke(request({ tools: [LOOKUP_TOOL, TRANSFER] }))).toMatchObject({ outcome: "MALFORMED", reasonCode: "MODEL_TOOL_CALL_INVALID" });
    // Control: a well-formed tool call over several deltas (name only on the first) is COMPLETED.
    r.emulator.queue(r.host, { kind: "tool_call", name: "lookup_status", arguments: { reference: "synthetic" } });
    expect(await r.port.invoke(request({ tools: [LOOKUP_TOOL] }))).toMatchObject({ outcome: "COMPLETED", toolCalls: [{ name: "lookup_status", arguments: { reference: "synthetic" } }] });
  });

  it("[FO-09-09][FAULT:MODEL_OVERLOAD seam][FAULT:MODEL_REFUSAL seam] finish reasons and errors keep vLLM's meaning", async () => {
    const r = await rig("vllm_openai_compatible", { emulator });
    r.emulator.injectFault(r.host, "MODEL_OVERLOAD", 1, { status: 503 } as never);
    r.emulator.injectFault(r.host, "MODEL_REFUSAL");
    r.emulator.queue(r.host, { kind: "max_tokens" }, { kind: "stream_error" }, { kind: "malformed", variant: "truncated" }, { kind: "malformed", variant: "bad_tool_args" });
    expect(await r.port.invoke(request())).toMatchObject({ outcome: "OVERLOADED", reasonCode: "MODEL_OVERLOADED" });
    // vLLM's refusal is plain content with finish_reason stop; the port's classifier types it.
    expect(await r.port.invoke(request())).toMatchObject({ outcome: "REFUSED", refusal: { source: "CLASSIFIED_REFUSAL" }, detail: { finishReason: "stop" } });
    expect(await r.port.invoke(request())).toMatchObject({ outcome: "INCOMPLETE", detail: { finishReason: "length" } });
    expect(await r.port.invoke(request())).toMatchObject({ outcome: "FAILED", errorClass: "RETRYABLE", reasonCode: "MODEL_SERVER_ERROR" });
    expect(await r.port.invoke(request())).toMatchObject({ outcome: "MALFORMED", reasonCode: "MODEL_STREAM_TRUNCATED" });
    expect(await r.port.invoke(request())).toMatchObject({ outcome: "MALFORMED", reasonCode: "MODEL_TOOL_ARGUMENTS_INVALID" });
  });

  it("[FO-09-45][FAULT:MODEL_HANG seam] a stalled vLLM stream times out and the connection is closed", async () => {
    const budget = { deadlineMs: 3_000, attemptTimeoutMs: 400, firstEventTimeoutMs: 400, idleTimeoutMs: 400, maxOutputTokens: 64, maxInputBytes: 65_536 };
    const r = await rig("vllm_openai_compatible", { emulator, endpoint: { budget } });
    r.emulator.injectFault(r.host, "MODEL_HANG");
    expect((await r.port.invoke(request({ budget }))).outcome).toBe("TIMED_OUT");
    await expect.poll(() => r.emulator.requests(r.host)[0]?.clientClosedEarly, { timeout: 2_000 }).toBe(true);
  });

  it("[FO-09-08] a private vLLM server without --api-key is reached without a credential; with a key it must match", async () => {
    const r = await rig("vllm_openai_compatible", { emulator, credential: null, register: false });
    r.emulator.registerHost(r.host, { bearer: "none", models: ["emulated-text"] });
    expect((await r.port.invoke(request())).outcome).toBe("COMPLETED");
    expect(r.emulator.requests(r.host)[0]?.headerNames).not.toContain("authorization");
    const k = await rig("vllm_openai_compatible", { emulator, credential: { kind: "bearer", token: async () => "key_synthWrongKey" } });
    expect(await k.port.invoke(request())).toMatchObject({ outcome: "UNAVAILABLE", reasonCode: "MODEL_AUTH_REJECTED" });
  });
});
