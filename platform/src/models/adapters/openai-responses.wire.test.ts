/**
 * OpenAI Responses stream consistency on hand-written wire bodies (WP-08; FO-09-07, FO-09-09, FO-04-19; security
 * review r3). Each body is the exact SSE a provider (or an attacker in the path) could send; the production adapter
 * and the ResilientModelPort must fail closed: a call that was never closed, a terminal event whose embedded status
 * disagrees with its type, a function call only in the terminal output, or a terminal output that differs from the
 * streamed calls is MALFORMED, never COMPLETED with a proposal or speakable text.
 *
 * UNIT FAKE: `wireExchange` below hands one fixed body to the adapter instead of the egress-classified transport
 * (test only; production code never uses it). The same shapes run over the real transport against the in-process
 * protocol emulator in openai-responses.test.ts (emulator variants tool_call_unclosed, terminal_status_mismatch,
 * tool_call_not_streamed).
 */
import { describe, expect, it } from "vitest";
import { systemClock } from "../../shared/clock.js";
import { LOOKUP_TOOL, request } from "../../../test/emulators/models/harness.js";
import { speakableText } from "../port/fallback.js";
import { ResilientModelPort } from "../port/resilient.js";
import type { ModelHttpExchange } from "./http-exchange.js";
import { OpenAiResponsesAdapter } from "./openai-responses.js";

/** UNIT FAKE exchange: one fixed SSE body, counted. */
function wireExchange(body: string): ModelHttpExchange & { sends: number } {
  const x = {
    incremental: false,
    sends: 0,
    async send() {
      x.sends += 1;
      return { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" }, body: (async function* () { yield Buffer.from(body); })() };
    },
  };
  return x;
}

function portFor(exchange: ModelHttpExchange) {
  const adapter = new OpenAiResponsesAdapter({ url: new URL("https://wire.openai.models.test/v1/responses"), model: "emulated-tools", organization: null, project: null, strictToolSchemas: false, credential: { kind: "bearer", token: async () => "key_synthWire" }, exchange });
  return new ResilientModelPort(adapter, { endpointRef: "ep.unit.openai-wire", maxDataClass: "INTERNAL", clock: systemClock, retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 } });
}

/** Builds one SSE body with strictly increasing sequence numbers. */
function wire(...events: Record<string, unknown>[]): string {
  return events.map((e, i) => `event: ${String(e.type)}\ndata: ${JSON.stringify({ ...e, sequence_number: i })}\n\n`).join("");
}

const ARGS = JSON.stringify({ reference: "synthetic" });
const CALL = { id: "fc_wire1", type: "function_call", call_id: "call_wire1", name: "lookup_status", arguments: ARGS, status: "completed" };
const created = { type: "response.created", response: { id: "resp_wire1", status: "in_progress", output: [] } };
const added = { type: "response.output_item.added", output_index: 0, item: { ...CALL, arguments: "", status: "in_progress" } };
const delta = { type: "response.function_call_arguments.delta", output_index: 0, item_id: CALL.id, delta: ARGS };
const argsDone = { type: "response.function_call_arguments.done", output_index: 0, item_id: CALL.id, arguments: ARGS };
const itemDone = { type: "response.output_item.done", output_index: 0, item: CALL };
const completedWith = (output: unknown[]) => ({ type: "response.completed", response: { id: "resp_wire1", status: "completed", output, usage: { input_tokens: 10, output_tokens: 4 } } });
const TEXT = "This synthetic reply was cut";
const textDelta = { type: "response.output_text.delta", output_index: 0, item_id: "msg_wire1", content_index: 0, delta: TEXT };
const textItem = { id: "msg_wire1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: TEXT, annotations: [] }] };

async function run(body: string, tools = [LOOKUP_TOOL]) {
  const x = wireExchange(body);
  const result = await portFor(x).invoke(request({ tools }));
  expect(x.sends).toBe(1);
  return result;
}

describe("OpenAI Responses stream consistency on hand-written wire bodies [FO-09-07][FO-04-19]", () => {
  it("[FO-09-07] positive control: a closed function_call repeated by the terminal output is COMPLETED with the parsed proposal", async () => {
    expect(await run(wire(created, added, delta, argsDone, itemDone, completedWith([CALL])))).toMatchObject({ outcome: "COMPLETED", toolCalls: [{ callId: "call_wire1", name: "lookup_status", arguments: { reference: "synthetic" } }] });
    // Without function_call_arguments.done (output_item.done carries the final arguments) it is still closed.
    expect(await run(wire(created, added, delta, itemDone, completedWith([CALL])))).toMatchObject({ outcome: "COMPLETED" });
  });

  it("[FO-09-07] adversarial: a function_call never closed by output_item.done is MALFORMED MODEL_TOOL_CALL_UNCLOSED (with or without arguments.done)", async () => {
    const neither = await run(wire(created, added, delta, completedWith([CALL])));
    expect(neither).toMatchObject({ outcome: "MALFORMED", reasonCode: "MODEL_TOOL_CALL_UNCLOSED" });
    expect(speakableText(neither)).toBeNull();
    expect(await run(wire(created, added, delta, argsDone, completedWith([CALL])))).toMatchObject({ outcome: "MALFORMED", reasonCode: "MODEL_TOOL_CALL_UNCLOSED" });
  });

  it("[FO-09-07][FO-09-09] adversarial: the terminal event type must agree with response.status (incomplete or failed claiming completed, completed claiming incomplete or no status)", async () => {
    const terminal = (type: string, status: string | undefined) => ({ type, response: { id: "resp_wire1", ...(status === undefined ? {} : { status }), output: [textItem], incomplete_details: { reason: "max_output_tokens" } } });
    for (const [type, status] of [["response.incomplete", "completed"], ["response.failed", "completed"], ["response.completed", "incomplete"], ["response.completed", "failed"], ["response.completed", undefined], ["response.incomplete", "failed"]] as const) {
      const r = await run(wire(created, textDelta, terminal(type, status)), []);
      expect(r, `${type} / ${String(status)}`).toMatchObject({ outcome: "MALFORMED", reasonCode: "MODEL_STREAM_STATUS_MISMATCH" });
      expect(speakableText(r)).toBeNull();
    }
    // Controls: the documented pairs keep their meaning.
    expect(await run(wire(created, textDelta, terminal("response.incomplete", "incomplete")), [])).toMatchObject({ outcome: "INCOMPLETE", reasonCode: "MODEL_MAX_OUTPUT_TOKENS" });
    expect(await run(wire(created, textDelta, { type: "response.completed", response: { id: "resp_wire1", status: "completed", output: [textItem] } }), [])).toMatchObject({ outcome: "COMPLETED", text: TEXT });
  });

  it("[FO-09-07] adversarial: a function_call only in the terminal output (never streamed) is MALFORMED, never dropped behind speakable text", async () => {
    const r = await run(wire(created, { ...textDelta, delta: "Your status is ready." }, completedWith([{ ...textItem, content: [{ type: "output_text", text: "Your status is ready.", annotations: [] }] }, CALL])));
    expect(r).toMatchObject({ outcome: "MALFORMED", reasonCode: "MODEL_TOOL_CALL_NOT_STREAMED" });
    expect(speakableText(r)).toBeNull();
  });

  it("[FO-09-07] adversarial: the terminal output must repeat the streamed calls exactly (missing call, changed arguments, changed name, duplicated call)", async () => {
    const streamed = [created, added, delta, argsDone, itemDone] as const;
    expect(await run(wire(...streamed, completedWith([])))).toMatchObject({ outcome: "MALFORMED", reasonCode: "MODEL_TOOL_CALL_INCONSISTENT" });
    expect(await run(wire(...streamed, completedWith([{ ...CALL, arguments: JSON.stringify({ reference: "other" }) }])))).toMatchObject({ outcome: "MALFORMED", reasonCode: "MODEL_TOOL_CALL_INCONSISTENT" });
    expect(await run(wire(...streamed, completedWith([{ ...CALL, name: "transfer_funds" }])))).toMatchObject({ outcome: "MALFORMED", reasonCode: "MODEL_TOOL_CALL_INCONSISTENT" });
    expect(await run(wire(...streamed, completedWith([CALL, CALL])))).toMatchObject({ outcome: "MALFORMED", reasonCode: "MODEL_TOOL_CALL_INCONSISTENT" });
    const { output: _omit, ...withoutOutput } = completedWith([]).response;
    expect(await run(wire(...streamed, { type: "response.completed", response: withoutOutput }))).toMatchObject({ outcome: "MALFORMED", reasonCode: "MODEL_TOOL_CALL_INCONSISTENT" });
  });

  it("[FO-09-07] adversarial: events on a closed call, a second item at an open index, and a closing item that renames the call are MALFORMED", async () => {
    expect(await run(wire(created, added, delta, itemDone, { ...delta, delta: "{}" }, completedWith([CALL])))).toMatchObject({ outcome: "MALFORMED", reasonCode: "MODEL_TOOL_CALL_INVALID" });
    expect(await run(wire(created, added, delta, itemDone, argsDone, completedWith([CALL])))).toMatchObject({ outcome: "MALFORMED", reasonCode: "MODEL_TOOL_CALL_INVALID" });
    expect(await run(wire(created, added, delta, itemDone, itemDone, completedWith([CALL])))).toMatchObject({ outcome: "MALFORMED", reasonCode: "MODEL_TOOL_CALL_INVALID" });
    expect(await run(wire(created, added, { ...added, item: { ...added.item, call_id: "call_wire2" } }, delta, itemDone, completedWith([CALL])))).toMatchObject({ outcome: "MALFORMED", reasonCode: "MODEL_TOOL_CALL_INVALID" });
    // The same item announced twice (a re-opened call, its arguments streamed again) is refused even when the closing
    // item names neither the call id nor the tool.
    const bareDone = { ...itemDone, item: { id: CALL.id, type: "function_call", arguments: ARGS, status: "completed" } };
    expect(await run(wire(created, added, delta, added, delta, bareDone, completedWith([CALL])))).toMatchObject({ outcome: "MALFORMED", reasonCode: "MODEL_TOOL_CALL_INVALID" });
    expect(await run(wire(created, added, delta, { ...itemDone, item: { ...CALL, name: "transfer_funds" } }, completedWith([{ ...CALL, name: "transfer_funds" }])))).toMatchObject({ outcome: "MALFORMED", reasonCode: "MODEL_TOOL_CALL_INVALID" });
    expect(await run(wire(created, added, delta, { ...itemDone, item: { ...CALL, call_id: "call_other" } }, completedWith([{ ...CALL, call_id: "call_other" }])))).toMatchObject({ outcome: "MALFORMED", reasonCode: "MODEL_TOOL_CALL_INVALID" });
  });

  it("[FO-09-09] an unclosed call cut by max_output_tokens stays INCOMPLETE (no proposal, no speech)", async () => {
    const r = await run(wire(created, added, delta, { type: "response.incomplete", response: { id: "resp_wire1", status: "incomplete", output: [{ ...CALL, status: "incomplete" }], incomplete_details: { reason: "max_output_tokens" } } }));
    expect(r).toMatchObject({ outcome: "INCOMPLETE", reasonCode: "MODEL_MAX_OUTPUT_TOKENS" });
    expect(speakableText(r)).toBeNull();
  });
});
