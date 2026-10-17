import { ValidationError } from "../../shared/errors.js";

/**
 * ECDSA signature encoding conversion. AWS KMS `Sign` returns ECDSA signatures as
 * DER-encoded `ECDSA-Sig-Value ::= SEQUENCE { r INTEGER, s INTEGER }` (RFC 3279);
 * JWS ES256 requires the fixed-width concatenation r || s (RFC 7518 section 3.4).
 * Parsing is strict (minimal INTEGER encoding, no trailing bytes, positive values)
 * so a malformed or malleated signature is rejected rather than "repaired".
 */
const fail = (): never => {
  throw new ValidationError("SIGNATURE_DER_INVALID");
};

export function derToJose(der: Uint8Array, size = 32): Uint8Array {
  let i = 0;
  const byte = (): number => {
    const b = der[i++];
    return b === undefined ? fail() : b;
  };
  if (byte() !== 0x30) fail();
  let seqLen = byte();
  if (seqLen & 0x80) {
    if ((seqLen & 0x7f) !== 1) fail();
    seqLen = byte();
    if (seqLen < 0x80) fail(); // long form only when required
  }
  if (seqLen !== der.length - i) fail();

  const readInt = (): Uint8Array => {
    if (byte() !== 0x02) fail();
    const len = byte();
    if (len === 0 || len & 0x80 || i + len > der.length) fail();
    const v = der.subarray(i, i + len);
    i += len;
    const first = v[0] ?? fail();
    if (first & 0x80) fail(); // negative
    if (len > 1 && first === 0 && ((v[1] ?? 0) & 0x80) === 0) fail(); // non-minimal
    const stripped = first === 0 ? v.subarray(1) : v;
    if (stripped.length > size || stripped.length === 0) fail();
    const out = new Uint8Array(size);
    out.set(stripped, size - stripped.length);
    if (out.every((b) => b === 0)) fail(); // r and s must be non-zero
    return out;
  };
  const r = readInt();
  const s = readInt();
  if (i !== der.length) fail();
  const sig = new Uint8Array(size * 2);
  sig.set(r, 0);
  sig.set(s, size);
  return sig;
}

/** Inverse conversion (used by tests and by any verifier that needs DER). */
export function joseToDer(sig: Uint8Array, size = 32): Uint8Array {
  if (sig.length !== size * 2) fail();
  const int = (bytes: Uint8Array): number[] => {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) start++;
    const body = Array.from(bytes.subarray(start));
    if ((body[0] ?? 0) & 0x80) body.unshift(0);
    return [0x02, body.length, ...body];
  };
  const content = [...int(sig.subarray(0, size)), ...int(sig.subarray(size))];
  const len = content.length < 0x80 ? [content.length] : [0x81, content.length];
  return Uint8Array.from([0x30, ...len, ...content]);
}
