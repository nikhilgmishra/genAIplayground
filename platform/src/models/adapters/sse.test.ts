/**
 * Incremental SSE parser (WP-08; FO-09-07, FO-09-08): split at any byte, CRLF and CR line endings, comments,
 * multi-line data, BOM, and the size and count bounds.
 */
import { describe, expect, it } from "vitest";
import { SseLimitError, SseParser } from "./sse.js";

const enc = (s: string) => new TextEncoder().encode(s);

describe("SseParser [FO-09-07]", () => {
  it("[FO-09-07] events complete only at their blank line and survive splitting at every byte", () => {
    const stream = "event: response.output_text.delta\ndata: {\"delta\":\"Hé\"}\n\n: keep-alive comment\n\ndata: line one\ndata: line two\n\n";
    for (let cut = 1; cut < stream.length; cut += 1) {
      const p = new SseParser();
      const bytes = enc(stream);
      const events = [...p.push(bytes.subarray(0, cut)), ...p.push(bytes.subarray(cut)), ...p.end()];
      expect(events, `cut ${cut}`).toEqual([
        { event: "response.output_text.delta", data: '{"delta":"Hé"}' },
        { event: "message", data: "line one\nline two" },
      ]);
    }
  });

  it("[FO-09-07] CRLF, CR, a leading BOM and a field without a space are handled; an unterminated last event is dropped", () => {
    const p = new SseParser();
    const out = [...p.push(enc("﻿event:a\r\ndata:1\r\n\r\nevent: b\rdata: 2\r\r")), ...p.push(enc("data: 3")), ...p.end()];
    expect(out).toEqual([
      { event: "a", data: "1" },
      { event: "b", data: "2" },
    ]);
  });

  it("[FO-09-09] adversarial: an oversized event or too many events refuse the stream", () => {
    const big = new SseParser({ maxEventBytes: 64, maxEvents: 10 });
    expect(() => big.push(enc(`data: ${"x".repeat(100)}\n`))).toThrow(SseLimitError);
    const many = new SseParser({ maxEventBytes: 1_024, maxEvents: 2 });
    expect(() => many.push(enc("data: 1\n\ndata: 2\n\ndata: 3\n\n"))).toThrow("SSE_TOO_MANY_EVENTS");
    const noNewline = new SseParser({ maxEventBytes: 16, maxEvents: 10 });
    expect(() => noNewline.push(enc("x".repeat(40)))).toThrow("SSE_EVENT_TOO_LARGE");
  });
});

describe("SseParser bounds are per event, not per chunk [FO-09-07][FO-09-09]", () => {
  it("[FO-09-07] a whole buffered body of many small events (well beyond 2 x maxEventBytes) parses as one chunk, linearly", () => {
    const event = `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "synthetic word " })}\n\n`;
    const body = event.repeat(20_000); // about 2.2 MB in one chunk; the per-event limit is 256 KiB
    const p = new SseParser();
    const started = Date.now();
    const events = [...p.push(enc(body)), ...p.end()];
    expect(events).toHaveLength(20_000);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("[FO-09-09] adversarial: one oversized event, one oversized comment line or an unterminated oversized line still refuse the stream", () => {
    const p = new SseParser({ maxEventBytes: 1_024, maxEvents: 100 });
    expect(() => p.push(enc(`data: ${"x".repeat(600)}\ndata: ${"x".repeat(600)}\n\n`))).toThrow("SSE_EVENT_TOO_LARGE");
    expect(() => new SseParser({ maxEventBytes: 1_024, maxEvents: 100 }).push(enc(`: ${"c".repeat(2_000)}\n`))).toThrow("SSE_EVENT_TOO_LARGE");
    const q = new SseParser({ maxEventBytes: 1_024, maxEvents: 100 });
    expect(q.push(enc("data: ok\n\n"))).toHaveLength(1);
    expect(() => q.push(enc("y".repeat(1_500)))).toThrow("SSE_EVENT_TOO_LARGE");
  });
});
