/**
 * Codec conversion over ffmpeg-generated golden fixtures (WP-11; FO-10-02): G.711 mu-law and A-law bit-exact with
 * ffmpeg's encoders and decoded within the codec's SNR, resampling 48 <-> 8/16/24 kHz with the pinned native resampler
 * within an SNR bound of ffmpeg/soxr's references, the 20 ms telephony leg, and Opus decoded through the pinned
 * framework's decoder. SYNTHETIC tones only; fixtures and how they were made: test/fixtures/audio/generate.sh.
 */
import { dispose } from "@livekit/rtc-node";
import { afterAll, describe, expect, it } from "vitest";
import { G711_FRAME_BYTES, TelephonyDecoder, TelephonyEncoder, alawToLinear, alignedSnrDb, concat, decodeAudioFile, decodeG711, encodeG711, frames, linearToAlaw, linearToMulaw, mulawToLinear, resample, rmsDbfs, StreamResampler, toneLevelDb } from "../src/codecs/index.js";
import { fixturePath, readRaw, readWav } from "./support/wav.js";

afterAll(async () => {
  await dispose();
});

describe("G.711 [FO-10-02]", () => {
  const ref8 = readWav("tone-8k.wav");

  it("[FO-10-02] mu-law and A-law encodings are bit-exact with ffmpeg's pcm_mulaw / pcm_alaw over the golden tone", () => {
    expect(ref8.rate).toBe(8_000);
    expect(Buffer.from(encodeG711(ref8.samples, "PCMU")).equals(Buffer.from(readRaw("tone-8k.ulaw")))).toBe(true);
    expect(Buffer.from(encodeG711(ref8.samples, "PCMA")).equals(Buffer.from(readRaw("tone-8k.alaw")))).toBe(true);
  });

  it("[FO-10-02] round trip: decoded G.711 stays within the companding SNR bound (>= 30 dB on a -10 dBFS tone)", () => {
    for (const law of ["PCMU", "PCMA"] as const) {
      const back = decodeG711(encodeG711(ref8.samples, law), law);
      const { snrDb, lag } = alignedSnrDb(ref8.samples, back, 0, 0);
      expect(lag).toBe(0);
      expect(snrDb, law).toBeGreaterThan(30);
    }
  });

  it("[FO-10-02] every code word decodes to a value that re-encodes to itself (idempotent tables, both laws)", () => {
    for (let b = 0; b < 256; b++) {
      expect(linearToMulaw(mulawToLinear(b)), `mu ${b}`).toBe(b === 0x7f ? 0xff : b);
      expect(linearToAlaw(alawToLinear(b)), `a ${b}`).toBe(b);
    }
    // Clipping and sign handling at the extremes.
    expect(mulawToLinear(linearToMulaw(32_767))).toBe(32_124);
    expect(mulawToLinear(linearToMulaw(-32_768))).toBe(-32_124);
    expect(alawToLinear(linearToAlaw(-32_768))).toBe(-32_256);
  });
});

describe("resampling [FO-10-02]", () => {
  const ref48 = readWav("tone-48k.wav");

  it.each([
    ["tone-8k.wav", 8_000],
    ["tone-16k.wav", 16_000],
    ["tone-24k.wav", 24_000],
  ] as const)("[FO-10-02] 48 kHz -> %s matches ffmpeg/soxr within 30 dB SNR", (file, rate) => {
    const ours = resample(ref48.samples, 48_000, rate);
    const theirs = readWav(file);
    expect(theirs.rate).toBe(rate);
    expect(Math.abs(ours.length - theirs.samples.length)).toBeLessThanOrEqual(Math.ceil(rate / 1000) * 2);
    expect(alignedSnrDb(theirs.samples, ours, 64, Math.ceil(rate / 100)).snrDb).toBeGreaterThan(30);
  });

  it.each([8_000, 16_000, 24_000] as const)("[FO-10-02] round trip 48 kHz -> %d Hz -> 48 kHz keeps the in-band tone (>= 25 dB SNR)", (rate) => {
    const back = resample(resample(ref48.samples, 48_000, rate), rate, 48_000);
    expect(alignedSnrDb(ref48.samples, back, 256, 960).snrDb).toBeGreaterThan(25);
  });

  it("[FO-10-02] streaming in 10 ms chunks equals the one-shot conversion", () => {
    const r = new StreamResampler(48_000, 16_000);
    const out: Int16Array[] = [];
    for (const f of frames(ref48.samples, 480).frames) out.push(r.push(f));
    out.push(r.flush());
    r.close();
    const oneShot = resample(ref48.samples.subarray(0, Math.floor(ref48.samples.length / 480) * 480), 48_000, 16_000);
    expect(alignedSnrDb(oneShot, concat(out), 8, 160).snrDb).toBeGreaterThan(60);
    expect(() => r.push(new Int16Array(10))).toThrow();
  });

  it("refuses rates the media path does not use", () => {
    expect(() => new StreamResampler(44_100 as never, 48_000)).toThrow();
  });
});

describe("telephony leg and Opus [FO-10-02]", () => {
  const ref48 = readWav("tone-48k.wav");

  it("[FO-10-02] 48 kHz -> 20 ms PCMU frames -> 48 kHz: whole 160-byte frames, in-band tone preserved (>= 20 dB SNR)", () => {
    for (const law of ["PCMU", "PCMA"] as const) {
      const enc = new TelephonyEncoder(law, 48_000);
      const dec = new TelephonyDecoder(law, 48_000);
      const out: Int16Array[] = [];
      const sent: Uint8Array[] = [];
      for (const f of frames(ref48.samples, 960).frames) sent.push(...enc.encode(f));
      sent.push(...enc.flush());
      for (const f of sent) {
        expect(f.length).toBe(G711_FRAME_BYTES);
        out.push(dec.decode(f));
      }
      out.push(dec.flush());
      enc.close();
      dec.close();
      expect(sent.length).toBeGreaterThanOrEqual(24);
      expect(alignedSnrDb(ref48.samples, concat(out), 512, 1_920).snrDb, law).toBeGreaterThan(20);
    }
  });

  it("[FO-10-02] Opus (Ogg, 64 kbit/s, as WebRTC carries it) decodes through the framework's pinned decoder to the source tone", async () => {
    const decoded = await decodeAudioFile(fixturePath("tone-48k.opus"), 48_000, "ogg");
    expect(Math.abs(decoded.length - ref48.samples.length)).toBeLessThan(4_800);
    expect(Math.abs(rmsDbfs(decoded) - rmsDbfs(ref48.samples))).toBeLessThan(1.5);
    // Opus is perceptual (waveform SNR does not apply; its VoIP mode high-passes the low band): each partial keeps its
    // level within 3 dB, and a frequency the source does not contain stays 40 dB below them.
    const mid = (x: Int16Array) => x.subarray(4_800, 4_800 + 19_200);
    for (const f of [440, 1_000, 2_200]) {
      expect(Math.abs(toneLevelDb(mid(decoded), 48_000, f) - toneLevelDb(mid(ref48.samples), 48_000, f)), `${f} Hz`).toBeLessThan(3);
    }
    expect(toneLevelDb(mid(decoded), 48_000, 1_600)).toBeLessThan(toneLevelDb(mid(ref48.samples), 48_000, 1_000) - 40);
  }, 30_000);
});
