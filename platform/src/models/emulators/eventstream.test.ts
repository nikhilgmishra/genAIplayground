/**
 * AWS event stream framing of the Bedrock emulator (WP-08; FO-09-06, FO-16-18): round trip, both CRCs, and the
 * cross-check that the AWS SDK's own decoder reads these frames is in ../adapters/bedrock-converse.test.ts.
 */
import { describe, expect, it } from "vitest";
import { decodeEventStream, encodeEvent, encodeEventStreamMessage, encodeException } from "./eventstream.js";

describe("AWS event stream framing [FO-09-06]", () => {
  it("[FO-09-06] frames round trip with their headers and payloads", () => {
    const buf = Buffer.concat([encodeEvent("messageStart", { role: "assistant" }), encodeException("throttlingException", "slow down")]);
    const msgs = decodeEventStream(buf);
    expect(msgs.map((m) => m.headers)).toEqual([
      { ":event-type": "messageStart", ":content-type": "application/json", ":message-type": "event" },
      { ":exception-type": "throttlingException", ":content-type": "application/json", ":message-type": "exception" },
    ]);
    expect(JSON.parse(msgs[0]!.payload.toString())).toEqual({ role: "assistant" });
  });

  it("[FO-09-06] adversarial: a flipped payload byte, a corrupt prelude or a truncated frame is refused", () => {
    const frame = encodeEventStreamMessage({ ":message-type": "event", ":event-type": "x" }, "{}");
    const payloadFlip = Buffer.from(frame);
    payloadFlip[payloadFlip.length - 6] = (payloadFlip[payloadFlip.length - 6] ?? 0) ^ 1;
    expect(() => decodeEventStream(payloadFlip)).toThrow("EVENTSTREAM_MESSAGE_CRC");
    const preludeFlip = Buffer.from(frame);
    preludeFlip[9] = (preludeFlip[9] ?? 0) ^ 1;
    expect(() => decodeEventStream(preludeFlip)).toThrow("EVENTSTREAM_PRELUDE_CRC");
    expect(() => decodeEventStream(frame.subarray(0, frame.length - 1))).toThrow("EVENTSTREAM_TRUNCATED");
  });
});
