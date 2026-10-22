/** Test support: reads the committed PCM WAV fixtures (RIFF chunks; 16-bit mono only). */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { int16FromLE } from "../../src/codecs/pcm.js";

export const fixturePath = (name: string): string => fileURLToPath(new URL(`../fixtures/audio/${name}`, import.meta.url));

export function readWav(name: string): { rate: number; samples: Int16Array } {
  const buf = readFileSync(fixturePath(name));
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error(`not a WAV file: ${name}`);
  let off = 12;
  let rate = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "fmt ") {
      if (buf.readUInt16LE(off + 8) !== 1 || buf.readUInt16LE(off + 10) !== 1 || buf.readUInt16LE(off + 22) !== 16) throw new Error(`not 16-bit mono PCM: ${name}`);
      rate = buf.readUInt32LE(off + 12);
    }
    if (id === "data") return { rate, samples: int16FromLE(new Uint8Array(buf.buffer, buf.byteOffset + off + 8, size)) };
    off += 8 + size + (size % 2);
  }
  throw new Error(`no data chunk: ${name}`);
}

export const readRaw = (name: string): Uint8Array => new Uint8Array(readFileSync(fixturePath(name)));
