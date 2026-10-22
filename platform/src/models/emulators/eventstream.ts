/**
 * AWS event stream binary framing (`application/vnd.amazon.eventstream`), the response framing of Amazon Bedrock
 * ConverseStream (WP-08; FO-09-06, FO-16-18). Used by the protocol-exact Bedrock emulator to write frames and by
 * tests to read them; the production adapter decodes through the AWS SDK's own event stream marshaller, so the
 * emulator's frames are cross-checked by AWS's decoder in every adapter test.
 *
 * Message layout (all integers big-endian):
 *   total length u32 | headers length u32 | prelude CRC32 u32 | headers | payload | message CRC32 u32
 * Header: name length u8 | name (UTF-8) | value type u8 (7 = string) | value length u16 | value (UTF-8).
 * Only string headers are written (every header ConverseStream uses is a string).
 */
import { crc32 } from "node:zlib";

const PRELUDE_BYTES = 12;
const MESSAGE_CRC_BYTES = 4;
const STRING_HEADER = 7;
/** The documented ceilings of the framing: 16 MiB per message, 128 KiB of headers. */
export const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
export const MAX_HEADERS_BYTES = 128 * 1024;

export type EventStreamHeaders = Readonly<Record<string, string>>;

export interface EventStreamMessage {
  headers: Record<string, string>;
  payload: Buffer;
}

function encodeHeaders(headers: EventStreamHeaders): Buffer {
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(headers)) {
    const n = Buffer.from(name, "utf8");
    const v = Buffer.from(value, "utf8");
    if (n.length === 0 || n.length > 255 || v.length > 32_767) throw new RangeError("EVENTSTREAM_HEADER_TOO_LARGE");
    const h = Buffer.alloc(1 + n.length + 1 + 2 + v.length);
    let o = h.writeUInt8(n.length, 0);
    o += n.copy(h, o);
    o = h.writeUInt8(STRING_HEADER, o);
    o = h.writeUInt16BE(v.length, o);
    v.copy(h, o);
    parts.push(h);
  }
  return Buffer.concat(parts);
}

/** One framed message. */
export function encodeEventStreamMessage(headers: EventStreamHeaders, payload: Buffer | string): Buffer {
  const body = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  const h = encodeHeaders(headers);
  if (h.length > MAX_HEADERS_BYTES) throw new RangeError("EVENTSTREAM_HEADERS_TOO_LARGE");
  const total = PRELUDE_BYTES + h.length + body.length + MESSAGE_CRC_BYTES;
  if (total > MAX_MESSAGE_BYTES) throw new RangeError("EVENTSTREAM_MESSAGE_TOO_LARGE");
  const out = Buffer.alloc(total);
  out.writeUInt32BE(total, 0);
  out.writeUInt32BE(h.length, 4);
  out.writeUInt32BE(crc32(out.subarray(0, 8)), 8);
  h.copy(out, PRELUDE_BYTES);
  body.copy(out, PRELUDE_BYTES + h.length);
  out.writeUInt32BE(crc32(out.subarray(0, total - MESSAGE_CRC_BYTES)), total - MESSAGE_CRC_BYTES);
  return out;
}

/** An `event` message of a Bedrock stream (`:event-type` names the ConverseStreamOutput member). */
export function encodeEvent(eventType: string, body: unknown): Buffer {
  return encodeEventStreamMessage({ ":event-type": eventType, ":content-type": "application/json", ":message-type": "event" }, JSON.stringify(body));
}

/** An in-stream modelled exception (`:exception-type`, e.g. `throttlingException`). */
export function encodeException(exceptionType: string, message: string): Buffer {
  return encodeEventStreamMessage({ ":exception-type": exceptionType, ":content-type": "application/json", ":message-type": "exception" }, JSON.stringify({ message }));
}

/** Decodes a complete buffer of framed messages, verifying both CRCs (throws on a corrupt or truncated frame). */
export function decodeEventStream(buf: Buffer): EventStreamMessage[] {
  const out: EventStreamMessage[] = [];
  let at = 0;
  while (at < buf.length) {
    if (buf.length - at < PRELUDE_BYTES + MESSAGE_CRC_BYTES) throw new RangeError("EVENTSTREAM_TRUNCATED");
    const total = buf.readUInt32BE(at);
    const headersLen = buf.readUInt32BE(at + 4);
    if (total > MAX_MESSAGE_BYTES || total < PRELUDE_BYTES + MESSAGE_CRC_BYTES + headersLen || at + total > buf.length) throw new RangeError("EVENTSTREAM_TRUNCATED");
    if (crc32(buf.subarray(at, at + 8)) !== buf.readUInt32BE(at + 8)) throw new RangeError("EVENTSTREAM_PRELUDE_CRC");
    if (crc32(buf.subarray(at, at + total - MESSAGE_CRC_BYTES)) !== buf.readUInt32BE(at + total - MESSAGE_CRC_BYTES)) throw new RangeError("EVENTSTREAM_MESSAGE_CRC");
    const headers: Record<string, string> = {};
    let h = at + PRELUDE_BYTES;
    const hEnd = h + headersLen;
    while (h < hEnd) {
      const nameLen = buf.readUInt8(h);
      const name = buf.subarray(h + 1, h + 1 + nameLen).toString("utf8");
      h += 1 + nameLen;
      const type = buf.readUInt8(h);
      if (type !== STRING_HEADER) throw new RangeError("EVENTSTREAM_HEADER_TYPE_UNSUPPORTED");
      const len = buf.readUInt16BE(h + 1);
      headers[name] = buf.subarray(h + 3, h + 3 + len).toString("utf8");
      h += 3 + len;
    }
    out.push({ headers, payload: Buffer.from(buf.subarray(hEnd, at + total - MESSAGE_CRC_BYTES)) });
    at += total;
  }
  return out;
}
