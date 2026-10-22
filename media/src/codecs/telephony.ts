/**
 * Telephony leg codecs (WP-11; FO-10-02): 20 ms G.711 frames (160 bytes at 8 kHz) to and from the runtime's wideband
 * PCM, through the native resampler. Used where the runtime meets a narrowband leg itself (a G.711 recording or
 * evidence leg, the telephony layer of the audio tests); on the LiveKit SIP route livekit-sip transcodes the carrier's
 * PCMU/PCMA to Opus, and the worker receives 48 kHz PCM from the RTC stack.
 */
import { decodeG711, encodeG711 } from "./g711.js";
import type { G711Law } from "./g711.js";
import { concat, frames } from "./pcm.js";
import type { SampleRate } from "./pcm.js";
import { StreamResampler } from "./resample.js";

export const G711_RATE = 8_000;
export const G711_FRAME_MS = 20;
export const G711_FRAME_BYTES = 160;

/** Wideband PCM in, whole 20 ms G.711 frames out (a partial frame waits for more input). */
export class TelephonyEncoder {
  private readonly down: StreamResampler;
  private pending = new Int16Array(0);

  constructor(
    readonly law: G711Law,
    readonly inputRate: SampleRate,
  ) {
    this.down = new StreamResampler(inputRate, G711_RATE, "HIGH");
  }

  encode(samples: Int16Array): Uint8Array[] {
    return this.take(this.down.push(samples));
  }

  /** Drains the resampler; a final partial frame is dropped, never zero-padded into a false frame. */
  flush(): Uint8Array[] {
    return this.take(this.down.flush());
  }

  close(): void {
    this.down.close();
  }

  private take(narrow: Int16Array): Uint8Array[] {
    const all = concat([this.pending, narrow]);
    const { frames: whole, rest } = frames(all, G711_FRAME_BYTES);
    this.pending = rest.slice();
    return whole.map((f) => encodeG711(f, this.law));
  }
}

/** G.711 frames in, wideband PCM out. */
export class TelephonyDecoder {
  private readonly up: StreamResampler;

  constructor(
    readonly law: G711Law,
    readonly outputRate: SampleRate,
  ) {
    this.up = new StreamResampler(G711_RATE, outputRate, "HIGH");
  }

  decode(frame: Uint8Array): Int16Array {
    return this.up.push(decodeG711(frame, this.law));
  }

  flush(): Int16Array {
    return this.up.flush();
  }

  close(): void {
    this.up.close();
  }
}
