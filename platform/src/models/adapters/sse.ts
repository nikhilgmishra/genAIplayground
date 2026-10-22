/**
 * Incremental Server-Sent Events parser (WHATWG HTML "event stream" interpretation) for the OpenAI Responses and
 * vLLM Chat Completions streams (WP-08). Bytes are fed as the transport delivers them; complete events are returned
 * as soon as their blank-line terminator arrives, so a consumer sees deltas before the stream ends whenever the
 * transport delivers incrementally.
 *
 * Bounded PER EVENT, never per chunk: an event (or a line still waiting for its terminator) larger than
 * `maxEventBytes`, or more than `maxEvents` events, refuse the stream (SSE_EVENT_TOO_LARGE / SSE_TOO_MANY_EVENTS)
 * instead of growing without limit. A chunk may hold any number of complete events (the buffered exchange delivers a
 * whole response body, up to the transport's response cap, as one chunk), and parsing is linear in its size. CR, LF
 * and CRLF line endings, `:` comments, multi-line `data` fields and a leading BOM are handled as the specification
 * says; `id` and `retry` are ignored (a model stream is never resumed).
 */
export interface SseEvent {
  /** `event:` field, or "message" when absent. */
  event: string;
  data: string;
}

export class SseLimitError extends Error {
  constructor(readonly reasonCode: "SSE_EVENT_TOO_LARGE" | "SSE_TOO_MANY_EVENTS") {
    super(reasonCode);
  }
}

export class SseParser {
  private buffer = "";
  private eventName = "";
  private data: string[] = [];
  private dataBytes = 0;
  private count = 0;
  private first = true;
  private readonly decoder = new TextDecoder("utf-8");

  constructor(private readonly limits: { maxEventBytes: number; maxEvents: number } = { maxEventBytes: 262_144, maxEvents: 100_000 }) {}

  /** Feeds bytes; returns the events completed by them. */
  push(chunk: Uint8Array): SseEvent[] {
    let text = this.decoder.decode(chunk, { stream: true });
    if (this.first && text.length > 0) {
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      this.first = false;
    }
    this.buffer += text;
    const out = this.drain(false);
    // What is left is one unterminated line: bounded like an event, whatever the chunk size was.
    if (this.buffer.length > this.limits.maxEventBytes) throw new SseLimitError("SSE_EVENT_TOO_LARGE");
    return out;
  }

  /** End of stream: an unterminated last event is discarded, as the specification requires. */
  end(): SseEvent[] {
    this.buffer += this.decoder.decode();
    const out = this.drain(true);
    this.buffer = "";
    this.reset();
    return out;
  }

  /** Complete lines of the buffer, scanned once with a cursor (linear in the buffer size). */
  private drain(final: boolean): SseEvent[] {
    const out: SseEvent[] = [];
    const b = this.buffer;
    let pos = 0;
    for (;;) {
      let i = pos;
      while (i < b.length && b.charCodeAt(i) !== 10 && b.charCodeAt(i) !== 13) i += 1;
      if (i >= b.length) break;
      let next = i + 1;
      if (b.charCodeAt(i) === 13) {
        // A lone CR at the end of the buffer may be the first half of CRLF: wait for more bytes.
        if (i === b.length - 1 && !final) break;
        if (b.charCodeAt(i + 1) === 10) next = i + 2;
      }
      const ev = this.line(b.slice(pos, i));
      if (ev) out.push(ev);
      pos = next;
    }
    this.buffer = pos === 0 ? b : b.slice(pos);
    return out;
  }

  private line(line: string): SseEvent | null {
    if (line.length > this.limits.maxEventBytes) throw new SseLimitError("SSE_EVENT_TOO_LARGE");
    if (line === "") {
      if (this.data.length === 0) {
        this.eventName = "";
        return null;
      }
      this.count += 1;
      if (this.count > this.limits.maxEvents) throw new SseLimitError("SSE_TOO_MANY_EVENTS");
      const ev = { event: this.eventName || "message", data: this.data.join("\n") };
      this.reset();
      return ev;
    }
    if (line.startsWith(":")) return null;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.eventName = value;
    else if (field === "data") {
      this.dataBytes += value.length + 1;
      if (this.dataBytes > this.limits.maxEventBytes) throw new SseLimitError("SSE_EVENT_TOO_LARGE");
      this.data.push(value);
    }
    return null;
  }

  private reset(): void {
    this.eventName = "";
    this.data = [];
    this.dataBytes = 0;
  }
}
