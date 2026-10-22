/**
 * Amazon Bedrock ConverseStream stream consistency on hand-built AWS event-stream frames (WP-08; FO-09-06, FO-09-09,
 * FO-09-46, FO-04-19; security review r4). Each body is binary event-stream framing as a provider (or an attacker in
 * the path) could send it; the AWS SDK's own decoder, the production BedrockConverseAdapter and the ResilientModelPort
 * must fail closed: a refusal stop that a later messageStop or content tries to override stays REFUSED; content after
 * messageStop, a toolUse block never closed, a second contentBlockStart at a used index, a toolUse delta after its
 * block closed, and a stop reason that contradicts the content are MALFORMED, never COMPLETED with a proposal or
 * speakable text.
 *
 * UNIT FAKE: `wireExchange` below hands one fixed body to the adapter instead of the egress-classified transport
 * (test only; production code never uses it). The frames are built with the emulator's event-stream encoder and
 * decoded by the SDK. The same shapes run over the real transport against the in-process protocol emulator in
 * bedrock-converse.test.ts (emulator variants tool_call_unclosed, content_after_finish, tool_call_renamed,
 * refusal_overridden).
 */
import { describe, expect, it } from "vitest";
import { systemClock } from "../../shared/clock.js";
import { LOOKUP_TOOL, request } from "../../../test/emulators/models/harness.js";
import { encodeEvent, encodeException } from "../emulators/eventstream.js";
import { decideModelFallback, speakableText } from "../port/fallback.js";
import { ResilientModelPort } from "../port/resilient.js";
import type { ModelResult } from "../port/types.js";
import { BedrockConverseAdapter } from "./bedrock-converse.js";
import type { ModelHttpExchange } from "./http-exchange.js";

/** UNIT FAKE exchange: one fixed event-stream body, counted. */
function wireExchange(frames: Buffer[]): ModelHttpExchange & { sends: number } {
  const x = {
    incremental: false,
    sends: 0,
    async send() {
      x.sends += 1;
      return { status: 200, headers: { "content-type": "application/vnd.amazon.eventstream", "x-amzn-requestid": "req-wire1" }, body: (async function* () { yield Buffer.concat(frames); })() };
    },
  };
  return x;
}

function portFor(exchange: ModelHttpExchange) {
  const adapter = new BedrockConverseAdapter({
    region: "us-east-1",
    endpoint: "https://bedrock-runtime.us-east-1.amazonaws.com",
    modelId: "emulated-text",
    guardrail: { identifier: "gr1synth", version: "1" },
    credential: { kind: "aws", credentials: async () => ({ accessKeyId: "akid_synthwire", secretAccessKey: "sk_synthwire" }) },
    exchange,
  });
  return new ResilientModelPort(adapter, { endpointRef: "ep.unit.bedrock-wire", maxDataClass: "INTERNAL", clock: systemClock, retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 } });
}

const start = () => encodeEvent("messageStart", { role: "assistant" });
const text = (i: number, t: string) => encodeEvent("contentBlockDelta", { contentBlockIndex: i, delta: { text: t } });
const blockStop = (i: number) => encodeEvent("contentBlockStop", { contentBlockIndex: i });
const stop = (stopReason: string) => encodeEvent("messageStop", { stopReason });
const meta = () => encodeEvent("metadata", { usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 }, metrics: { latencyMs: 10 } });
const toolStart = (i: number, id: string) => encodeEvent("contentBlockStart", { contentBlockIndex: i, start: { toolUse: { toolUseId: id, name: "lookup_status" } } });
const toolDelta = (i: number, input: string) => encodeEvent("contentBlockDelta", { contentBlockIndex: i, delta: { toolUse: { input } } });

/** Neutral synthetic markers only: none of these texts is a real request or answer. */
const MARK = { refusal: "synthetic-refusal-trigger-01", overflow: "synthetic-after-stop-marker-02", filtered: "synthetic-content-filter-marker-03", reply: "synthetic-reply-marker-04" };

async function run(frames: Buffer[], tools = [LOOKUP_TOOL]): Promise<ModelResult> {
  const x = wireExchange(frames);
  const result = await portFor(x).invoke(request({ tools }));
  expect(x.sends).toBe(1);
  return result;
}

/** Nothing of a failed-closed stream is speakable, and the fallback never uses model output. */
function expectNotSpoken(result: ModelResult) {
  expect(speakableText(result)).toBeNull();
  expect(decideModelFallback(result, { safetySignalActive: false })).toMatchObject({ kind: "APPROVED_FALLBACK", suppressModelText: true });
}

describe("Bedrock ConverseStream stream consistency on hand-built event-stream frames [FO-09-06][FO-04-19]", () => {
  it("[FO-09-06] positive controls: a closed toolUse block with stop tool_use, and text with end_turn, are COMPLETED", async () => {
    const call = await run([start(), toolStart(0, "tooluse_wire1"), toolDelta(0, '{"reference":'), toolDelta(0, '"synthetic"}'), blockStop(0), stop("tool_use"), meta()]);
    expect(call).toMatchObject({ outcome: "COMPLETED", toolCalls: [{ callId: "tooluse_wire1", name: "lookup_status", arguments: { reference: "synthetic" } }], detail: { stopReason: "tool_use" }, usage: { inputTokens: 5 } });
    const reply = await run([start(), text(0, MARK.reply), blockStop(0), stop("end_turn"), meta()]);
    expect(reply).toMatchObject({ outcome: "COMPLETED", text: MARK.reply, toolCalls: [] });
    // A text block before a toolUse block is the documented mixed answer.
    const mixed = await run([start(), text(0, MARK.reply), blockStop(0), toolStart(1, "tooluse_wire2"), toolDelta(1, '{"reference":"synthetic"}'), blockStop(1), stop("tool_use"), meta()]);
    expect(mixed).toMatchObject({ outcome: "COMPLETED", text: MARK.reply, toolCalls: [{ callId: "tooluse_wire2" }] });
  });

  it("[FO-09-46] adversarial B1: guardrail_intervened followed by a second messageStop end_turn stays REFUSED (control: the guardrail stop alone)", async () => {
    const overridden = await run([start(), text(0, MARK.refusal), blockStop(0), stop("guardrail_intervened"), stop("end_turn"), meta()]);
    expect(overridden).toMatchObject({ outcome: "REFUSED", refusal: { source: "GUARDRAIL_INTERVENED", reasonCode: "MODEL_GUARDRAIL_INTERVENED" }, detail: { stopReason: "guardrail_intervened" } });
    expectNotSpoken(overridden);
    const control = await run([start(), text(0, MARK.refusal), blockStop(0), stop("guardrail_intervened"), meta()]);
    expect(control).toMatchObject({ outcome: "REFUSED", refusal: { source: "GUARDRAIL_INTERVENED" } });
  });

  it("[FO-09-46] adversarial B8: content_filtered followed by text and a second end_turn stays REFUSED CONTENT_FILTER", async () => {
    const result = await run([start(), stop("content_filtered"), text(0, MARK.filtered), stop("end_turn"), meta()]);
    expect(result).toMatchObject({ outcome: "REFUSED", refusal: { source: "CONTENT_FILTER", reasonCode: "MODEL_CONTENT_FILTERED" }, detail: { stopReason: "content_filtered" } });
    expectNotSpoken(result);
    // A duplicated metadata event, or an exception event, after a refusal stop does not undo the refusal (and never
    // turns it into a retryable failure).
    expect(await run([start(), stop("guardrail_intervened"), meta(), meta()])).toMatchObject({ outcome: "REFUSED", refusal: { source: "GUARDRAIL_INTERVENED" } });
    expect(await run([start(), stop("content_filtered"), encodeException("throttlingException", "synthetic-exception-marker-05")])).toMatchObject({ outcome: "REFUSED", refusal: { source: "CONTENT_FILTER" } });
    // Control: the same exception event without a refusal stop is the provider's overload.
    expect(await run([start(), text(0, MARK.reply), encodeException("throttlingException", "synthetic-exception-marker-05")])).toMatchObject({ outcome: "OVERLOADED" });
  });

  it("[FO-09-06] adversarial B2: a text delta after messageStop end_turn is MALFORMED MODEL_STREAM_CONTENT_AFTER_STOP, never appended", async () => {
    const result = await run([start(), text(0, MARK.reply), blockStop(0), stop("end_turn"), text(0, MARK.overflow), meta()]);
    expect(result).toMatchObject({ outcome: "MALFORMED", reasonCode: "MODEL_STREAM_CONTENT_AFTER_STOP" });
    expectNotSpoken(result);
    // A second messageStop with a completing reason, and a toolUse block opened after the stop, are the same violation.
    expect(await run([start(), text(0, MARK.reply), blockStop(0), stop("end_turn"), stop("end_turn"), meta()])).toMatchObject({ outcome: "MALFORMED", reasonCode: "MODEL_STREAM_CONTENT_AFTER_STOP" });
    expect(await run([start(), text(0, MARK.reply), blockStop(0), stop("end_turn"), toolStart(1, "tooluse_late"), toolDelta(1, "{}"), blockStop(1), meta()])).toMatchObject({ outcome: "MALFORMED", reasonCode: "MODEL_STREAM_CONTENT_AFTER_STOP" });
  });

  it("[FO-09-06][FO-09-09] adversarial B3: a toolUse block never closed by contentBlockStop is MALFORMED MODEL_TOOL_CALL_UNCLOSED", async () => {
    const result = await run([start(), toolStart(0, "tooluse_wire1"), toolDelta(0, '{"reference":"synthetic"}'), stop("tool_use"), meta()]);
    expect(result).toMatchObject({ outcome: "MALFORMED", reasonCode: "MODEL_TOOL_CALL_UNCLOSED" });
    expectNotSpoken(result);
    // An unclosed block cut by max_tokens stays INCOMPLETE (no proposal either way).
    expect(await run([start(), toolStart(0, "tooluse_wire1"), toolDelta(0, '{"reference":'), stop("max_tokens"), meta()])).toMatchObject({ outcome: "INCOMPLETE", reasonCode: "MODEL_MAX_OUTPUT_TOKENS" });
  });

  it("[FO-09-06][FO-09-09] adversarial B4: a second contentBlockStart at a used index (call replaced mid-stream) is MALFORMED MODEL_TOOL_CALL_INVALID", async () => {
    const result = await run([start(), toolStart(0, "tooluse_wire1"), toolDelta(0, '{"reference":"A1"'), toolStart(0, "tooluse_wire2"), toolDelta(0, '{"reference":"B2"}'), blockStop(0), stop("tool_use"), meta()]);
    expect(result).toMatchObject({ outcome: "MALFORMED", reasonCode: "MODEL_TOOL_CALL_INVALID" });
    // A toolUse block opened at the index of a text block is the same violation.
    expect(await run([start(), text(0, MARK.reply), toolStart(0, "tooluse_wire3"), toolDelta(0, "{}"), blockStop(0), stop("tool_use"), meta()])).toMatchObject({ outcome: "MALFORMED", reasonCode: "MODEL_TOOL_CALL_INVALID" });
  });

  it("[FO-09-06][FO-09-09] adversarial B5: a toolUse delta after its contentBlockStop, into a text block, or for an unknown index is MALFORMED MODEL_TOOL_CALL_INVALID", async () => {
    expect(await run([start(), toolStart(0, "tooluse_wire1"), toolDelta(0, '{"reference":'), blockStop(0), toolDelta(0, '"A1"}'), stop("tool_use"), meta()])).toMatchObject({ outcome: "MALFORMED", reasonCode: "MODEL_TOOL_CALL_INVALID" });
    expect(await run([start(), text(0, MARK.reply), toolDelta(0, "{}"), blockStop(0), stop("tool_use"), meta()])).toMatchObject({ outcome: "MALFORMED", reasonCode: "MODEL_TOOL_CALL_INVALID" });
    expect(await run([start(), toolDelta(3, "{}"), stop("tool_use"), meta()])).toMatchObject({ outcome: "MALFORMED", reasonCode: "MODEL_TOOL_CALL_INVALID" });
    // Text into a toolUse block, and text after its own block closed, are invalid too.
    expect(await run([start(), toolStart(0, "tooluse_wire1"), text(0, MARK.overflow), blockStop(0), stop("tool_use"), meta()])).toMatchObject({ outcome: "MALFORMED", reasonCode: "MODEL_TOOL_CALL_INVALID" });
    expect(await run([start(), text(0, MARK.reply), blockStop(0), text(0, MARK.overflow), stop("end_turn"), meta()])).toMatchObject({ outcome: "MALFORMED", reasonCode: "MODEL_STREAM_EVENT_INVALID" });
  });

  it("[FO-09-06][FO-09-09] adversarial B6/B7: the stop reason must agree with the content (tool_use without a call, end_turn or stop_sequence with a call)", async () => {
    const noCall = await run([start(), text(0, MARK.reply), blockStop(0), stop("tool_use"), meta()]);
    expect(noCall).toMatchObject({ outcome: "MALFORMED", reasonCode: "MODEL_STOP_REASON_INCONSISTENT" });
    expectNotSpoken(noCall);
    const callAtEndTurn = await run([start(), toolStart(0, "tooluse_wire1"), toolDelta(0, '{"reference":"synthetic"}'), blockStop(0), stop("end_turn"), meta()]);
    expect(callAtEndTurn).toMatchObject({ outcome: "MALFORMED", reasonCode: "MODEL_STOP_REASON_INCONSISTENT" });
    expect(await run([start(), toolStart(0, "tooluse_wire1"), toolDelta(0, "{}"), blockStop(0), stop("stop_sequence"), meta()])).toMatchObject({ outcome: "MALFORMED", reasonCode: "MODEL_STOP_REASON_INCONSISTENT" });
  });

  it("[FO-09-06] adversarial: the documented frame order (messageStart first and once, metadata only after messageStop and once, blocks closed once)", async () => {
    expect(await run([text(0, MARK.reply), blockStop(0), stop("end_turn"), meta()])).toMatchObject({ outcome: "MALFORMED", reasonCode: "MODEL_STREAM_EVENT_INVALID" });
    expect(await run([start(), start(), text(0, MARK.reply), blockStop(0), stop("end_turn"), meta()])).toMatchObject({ outcome: "MALFORMED", reasonCode: "MODEL_STREAM_EVENT_INVALID" });
    expect(await run([start(), meta(), text(0, MARK.reply), blockStop(0), stop("end_turn")])).toMatchObject({ outcome: "MALFORMED", reasonCode: "MODEL_STREAM_EVENT_INVALID" });
    expect(await run([start(), text(0, MARK.reply), blockStop(0), stop("end_turn"), meta(), meta()])).toMatchObject({ outcome: "MALFORMED", reasonCode: "MODEL_STREAM_EVENT_INVALID" });
    expect(await run([start(), text(0, MARK.reply), blockStop(0), blockStop(0), stop("end_turn"), meta()])).toMatchObject({ outcome: "MALFORMED", reasonCode: "MODEL_STREAM_EVENT_INVALID" });
  });
});
