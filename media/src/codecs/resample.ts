/**
 * Sample-rate conversion between the telephony, ASR, TTS and WebRTC rates (WP-11; FO-10-02), over the resampler of
 * the pinned LiveKit RTC SDK (@livekit/rtc-node AudioResampler, native, the same one the Agents framework uses), so
 * the runtime converts exactly as the media plane does. Streaming: `push` returns what is ready, `flush` drains the
 * filter at the end of a stream; a resampler holds a native handle and must be closed.
 */
import { AudioFrame, AudioResampler, AudioResamplerQuality } from "@livekit/rtc-node";
import { assertRate, concat } from "./pcm.js";
import type { SampleRate } from "./pcm.js";

export type ResampleQuality = "QUICK" | "LOW" | "MEDIUM" | "HIGH" | "VERY_HIGH";

const QUALITY: Record<ResampleQuality, AudioResamplerQuality> = {
  QUICK: AudioResamplerQuality.QUICK,
  LOW: AudioResamplerQuality.LOW,
  MEDIUM: AudioResamplerQuality.MEDIUM,
  HIGH: AudioResamplerQuality.HIGH,
  VERY_HIGH: AudioResamplerQuality.VERY_HIGH,
};

export class StreamResampler {
  private readonly native: AudioResampler | null;
  private closed = false;

  constructor(
    readonly inputRate: SampleRate,
    readonly outputRate: SampleRate,
    quality: ResampleQuality = "HIGH",
  ) {
    assertRate(inputRate);
    assertRate(outputRate);
    this.native = inputRate === outputRate ? null : new AudioResampler(inputRate, outputRate, 1, QUALITY[quality]);
  }

  /** Feeds mono samples at the input rate; returns the output samples that are ready. */
  push(samples: Int16Array): Int16Array {
    if (this.closed) throw new Error("resampler closed");
    if (!this.native) return samples.slice();
    if (samples.length === 0) return new Int16Array(0);
    const frames = this.native.push(new AudioFrame(samples.slice(), this.inputRate, 1, samples.length));
    return concat(frames.map((f) => f.data));
  }

  /** Drains the filter tail at the end of a stream. */
  flush(): Int16Array {
    if (this.closed || !this.native) return new Int16Array(0);
    return concat(this.native.flush().map((f) => f.data));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.native?.close();
  }
}

/** One-shot conversion of a whole buffer. */
export function resample(samples: Int16Array, inputRate: SampleRate, outputRate: SampleRate, quality: ResampleQuality = "HIGH"): Int16Array {
  const r = new StreamResampler(inputRate, outputRate, quality);
  try {
    return concat([r.push(samples), r.flush()]);
  } finally {
    r.close();
  }
}
