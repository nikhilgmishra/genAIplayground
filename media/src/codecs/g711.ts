/**
 * ITU-T G.711 companding (WP-11; FO-10-02): mu-law (PCMU, North America and Japan) and A-law (PCMA, elsewhere),
 * 8 kHz, one byte per sample, the payload of RTP payload types 0 and 8 that carrier trunks and SIP peers send.
 *
 * Decoding uses the reference reconstruction levels. Encoding picks, for every 14-bit linear magnitude, the code whose
 * reconstruction level is nearest (decision levels at the midpoints, as G.711 specifies), built once into a 16 384-entry
 * table exactly as FFmpeg's pcm_mulaw / pcm_alaw encoders build theirs; the unit tests compare every encoded byte with
 * FFmpeg's output over committed fixtures.
 */

const SIGN_BIT = 0x80;
const QUANT_MASK = 0x0f;
const SEG_SHIFT = 4;
const SEG_MASK = 0x70;
const BIAS = 0x84;

/** One mu-law byte to a 16-bit linear sample. */
export function mulawToLinear(byte: number): number {
  const u = ~byte & 0xff;
  let t = ((u & QUANT_MASK) << 3) + BIAS;
  t <<= (u & SEG_MASK) >> SEG_SHIFT;
  return u & SIGN_BIT ? BIAS - t : t - BIAS;
}

/** One A-law byte to a 16-bit linear sample. */
export function alawToLinear(byte: number): number {
  const a = (byte ^ 0x55) & 0xff;
  const t = a & QUANT_MASK;
  const seg = (a & SEG_MASK) >> SEG_SHIFT;
  const v = seg ? (t + t + 1 + 32) << (seg + 2) : (t + t + 1) << 3;
  return a & SIGN_BIT ? v : -v;
}

/** Nearest-code table over 14-bit linear values (index (sample + 32768) >> 2). */
function buildTable(toLinear: (b: number) => number, mask: number): Uint8Array {
  const table = new Uint8Array(16_384);
  let j = 1;
  table[8192] = mask;
  for (let i = 0; i < 127; i++) {
    const v1 = toLinear(i ^ mask);
    const v2 = toLinear((i + 1) ^ mask);
    const v = (v1 + v2 + 4) >> 3;
    for (; j < v; j++) {
      table[8192 - j] = i ^ (mask ^ 0x80);
      table[8192 + j] = i ^ mask;
    }
  }
  for (; j < 8192; j++) {
    table[8192 - j] = 127 ^ (mask ^ 0x80);
    table[8192 + j] = 127 ^ mask;
  }
  table[0] = table[1] as number;
  return table;
}

const ULAW_TABLE = buildTable(mulawToLinear, 0xff);
const ALAW_TABLE = buildTable(alawToLinear, 0xd5);

const index = (sample: number): number => (Math.max(-32_768, Math.min(32_767, Math.trunc(sample))) + 32_768) >> 2;

/** One 16-bit linear sample to a mu-law byte. */
export const linearToMulaw = (sample: number): number => ULAW_TABLE[index(sample)] as number;
/** One 16-bit linear sample to an A-law byte. */
export const linearToAlaw = (sample: number): number => ALAW_TABLE[index(sample)] as number;

export type G711Law = "PCMU" | "PCMA";

/** 16-bit PCM to G.711 bytes. */
export function encodeG711(pcm: Int16Array, law: G711Law): Uint8Array {
  const out = new Uint8Array(pcm.length);
  const table = law === "PCMU" ? ULAW_TABLE : ALAW_TABLE;
  for (let i = 0; i < pcm.length; i++) out[i] = table[((pcm[i] as number) + 32_768) >> 2] as number;
  return out;
}

/** G.711 bytes to 16-bit PCM. */
export function decodeG711(bytes: Uint8Array, law: G711Law): Int16Array {
  const out = new Int16Array(bytes.length);
  const f = law === "PCMU" ? mulawToLinear : alawToLinear;
  for (let i = 0; i < bytes.length; i++) out[i] = f(bytes[i] as number);
  return out;
}
