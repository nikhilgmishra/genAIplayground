/**
 * 16-bit PCM helpers for the media path (WP-11; FO-10-02): byte order, framing, level and signal-to-noise measures.
 * Sample rates the runtime meets: 8 kHz (G.711 carriers), 16 kHz (ASR input), 24 kHz (TTS output) and 48 kHz
 * (WebRTC through LiveKit, Opus inside the RTC stack).
 */

export const SUPPORTED_RATES = [8_000, 16_000, 24_000, 48_000] as const;
export type SampleRate = (typeof SUPPORTED_RATES)[number];

export function assertRate(rate: number): asserts rate is SampleRate {
  if (!(SUPPORTED_RATES as readonly number[]).includes(rate)) throw new RangeError(`unsupported sample rate ${rate}`);
}

/** Samples in one frame of `ms` milliseconds at `rate`. */
export const frameSamples = (rate: number, ms: number): number => Math.round((rate * ms) / 1000);

/** Little-endian 16-bit bytes (WAV data, raw s16le) to samples. */
export function int16FromLE(bytes: Uint8Array): Int16Array {
  if (bytes.length % 2 !== 0) throw new RangeError("odd byte count for 16-bit PCM");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Int16Array(bytes.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true);
  return out;
}

export function int16ToLE(samples: Int16Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, samples[i] as number, true);
  return out;
}

/** Splits a sample run into whole frames; the remainder is returned separately (never padded silently). */
export function frames(samples: Int16Array, size: number): { frames: Int16Array[]; rest: Int16Array } {
  if (!Number.isInteger(size) || size <= 0) throw new RangeError("frame size must be a positive integer");
  const out: Int16Array[] = [];
  let i = 0;
  for (; i + size <= samples.length; i += size) out.push(samples.subarray(i, i + size));
  return { frames: out, rest: samples.subarray(i) };
}

export function concat(parts: readonly Int16Array[]): Int16Array {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** RMS level in dBFS (full scale 32768); -Infinity for digital silence. */
export function rmsDbfs(samples: Int16Array): number {
  if (samples.length === 0) return Number.NEGATIVE_INFINITY;
  let acc = 0;
  for (const s of samples) acc += s * s;
  const rms = Math.sqrt(acc / samples.length);
  return rms === 0 ? Number.NEGATIVE_INFINITY : 20 * Math.log10(rms / 32_768);
}

/**
 * Signal-to-noise ratio (dB) of `test` against `reference`, after the best integer alignment within `maxLag` samples
 * (codec and resampler filters delay the signal) and over the overlapping region minus `edge` samples at each end
 * (filter start-up). A gain mismatch counts as noise, as a listener would hear it.
 */
export function alignedSnrDb(reference: Int16Array, test: Int16Array, maxLag = 64, edge = 256): { snrDb: number; lag: number } {
  let best = { snrDb: Number.NEGATIVE_INFINITY, lag: 0 };
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let signal = 0;
    let noise = 0;
    const start = Math.max(edge, -lag + edge);
    const end = Math.min(reference.length - edge, test.length - lag - edge);
    if (end - start < 64) continue;
    for (let i = start; i < end; i++) {
      const r = reference[i] as number;
      const t = test[i + lag] as number;
      signal += r * r;
      noise += (r - t) * (r - t);
    }
    const snr = noise === 0 ? Number.POSITIVE_INFINITY : 10 * Math.log10(signal / noise);
    if (snr > best.snrDb) best = { snrDb: snr, lag: lag + 0 };
  }
  return best;
}

/**
 * Level (dBFS of the equivalent sine amplitude) of one frequency in a block, by the Goertzel algorithm. Phase
 * insensitive, so it measures a perceptual codec (Opus) or a resampled leg where waveform SNR does not apply, and it
 * detects a known test tone in received frames.
 */
export function toneLevelDb(samples: Int16Array, rate: number, frequency: number): number {
  const n = samples.length;
  if (n === 0) return Number.NEGATIVE_INFINITY;
  const k = Math.round((n * frequency) / rate);
  const w = (2 * Math.PI * k) / n;
  const coeff = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    const s0 = (samples[i] as number) + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
  const amplitude = (2 * Math.sqrt(Math.max(power, 0))) / n;
  return amplitude === 0 ? Number.NEGATIVE_INFINITY : 20 * Math.log10(amplitude / 32_768);
}
