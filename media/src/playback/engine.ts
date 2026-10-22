/**
 * Output playback of the conversation runtime (WP-11; FO-10-18, FO-10-09, FO-10-46).
 *
 * Holds the approved audio segments queued for the caller and hands out fixed-size frames to the output track.
 * Every segment carries the session generation it was approved under. The engine's generation is set only by the
 * binding (`advance`, from the gateway's answers); a segment of any other generation is refused at enqueue (an older
 * one is stale; a newer one is not the binding's, and never moves the generation), and queued or playing segments of
 * an older generation are dropped (cut mid-frame-sequence) the moment the generation advances, so speech prepared
 * before a party change or an owner recovery never reaches the caller (FO-10-09). `hold(reason)` refuses all speech
 * until every hold is released (the call is on hold, a transfer leg is up, a party change is not yet acknowledged by
 * the gateway, the call is not bound): the hold and transfer states fence speech of the CURRENT generation too.
 * `flush()` cuts playback at the next frame (barge-in, hold, transfer, hang-up). `repeat()` replays the last completed segment
 * that was marked repeatable, only while its generation is still current. `setRate()` sets the call's speech-rate
 * preference ("slower, please"): segments rendered afterwards are time-stretched without changing pitch.
 * While nothing is queued the engine emits low-level comfort noise so the RTP stream stays alive.
 */
import { ComfortNoise } from "./comfort-noise.js";
import { MAX_SPEECH_RATE, MIN_SPEECH_RATE, timeStretch } from "./stretch.js";

export interface PlaybackSegment {
  /** Opaque id of the approved utterance or clip (never its text). */
  id: string;
  generation: number;
  /** Mono 16-bit PCM at the engine's sample rate. */
  pcm: Int16Array;
  /** True when the caller may hear it again on "repeat" (a one-time code readback is not repeatable). */
  repeatable: boolean;
  /** True when the audio was already rendered at the call's speech rate (a TTS render that honoured it). */
  renderedAtRate?: boolean;
}

export type PlaybackEvent =
  | { kind: "STARTED"; id: string }
  | { kind: "COMPLETED"; id: string }
  | { kind: "CUT"; id: string; reason: "FLUSH" | "GENERATION" };

export interface PlaybackOptions {
  sampleRate: number;
  comfortNoiseDbfs?: number;
  /** Bound on queued segments; a runaway producer is refused rather than buffered without limit. */
  maxQueued?: number;
  onEvent?: (e: PlaybackEvent) => void;
}

interface Playing {
  seg: PlaybackSegment;
  pcm: Int16Array;
  offset: number;
}

/** Why speech is refused right now; any one of them refuses it. */
export type PlaybackHold = "UNBOUND" | "HOLD" | "TRANSFER_LEG" | "PARTY_CHANGE" | "HUMAN_ROUTE" | "ENDING";

export class PlaybackEngine {
  private readonly queue: PlaybackSegment[] = [];
  private readonly holds = new Set<PlaybackHold>();
  private playing: Playing | null = null;
  private lastRepeatable: PlaybackSegment | null = null;
  private generation = 0;
  private rate = 1;
  private readonly noise: ComfortNoise;
  private readonly maxQueued: number;

  constructor(private readonly o: PlaybackOptions) {
    if (!Number.isInteger(o.sampleRate) || o.sampleRate < 8_000 || o.sampleRate > 48_000) throw new RangeError("playback sample rate out of range");
    this.noise = new ComfortNoise(o.comfortNoiseDbfs ?? -66);
    this.maxQueued = o.maxQueued ?? 32;
  }

  currentGeneration(): number {
    return this.generation;
  }

  speechRate(): number {
    return this.rate;
  }

  isSpeaking(): boolean {
    return this.playing !== null || this.queue.length > 0;
  }

  /** Speech is refused while any hold is in place. */
  isHeld(): boolean {
    return this.holds.size > 0;
  }

  heldFor(): PlaybackHold[] {
    return [...this.holds];
  }

  /** Refuses speech (and cuts what plays) until `release(reason)`; holds of different reasons stack. */
  hold(reason: PlaybackHold): void {
    this.holds.add(reason);
    this.flush();
  }

  release(reason: PlaybackHold): void {
    this.holds.delete(reason);
  }

  /**
   * Queues an approved segment; false when speech is held, the segment is not of the binding's current generation
   * (older: stale; newer: not issued by the binding, so it never moves the generation) or the queue is full.
   */
  enqueue(seg: PlaybackSegment): boolean {
    if (this.holds.size > 0 || seg.generation !== this.generation || this.generation === 0 || this.queue.length >= this.maxQueued) return false;
    this.queue.push(seg);
    return true;
  }

  /** The session generation advanced: everything prepared under an older one is void. Never moves back. */
  advance(generation: number): void {
    if (generation <= this.generation) return;
    this.generation = generation;
    if (this.playing && this.playing.seg.generation < generation) this.cut("GENERATION");
    for (let i = this.queue.length - 1; i >= 0; i--) if ((this.queue[i] as PlaybackSegment).generation < generation) this.queue.splice(i, 1);
    if (this.lastRepeatable && this.lastRepeatable.generation < generation) this.lastRepeatable = null;
  }

  /** Stops speaking at the next frame and drops the queue (barge-in, hold, transfer, hang-up, binding lost). */
  flush(): void {
    if (this.playing) this.cut("FLUSH");
    this.queue.length = 0;
  }

  /** Replays the last completed repeatable segment of the current generation; false when there is none. */
  repeat(): boolean {
    const last = this.lastRepeatable;
    if (this.holds.size > 0 || !last || last.generation !== this.generation) return false;
    this.flush();
    this.queue.push({ ...last, renderedAtRate: false });
    return true;
  }

  setRate(rate: number): void {
    if (!(rate >= MIN_SPEECH_RATE && rate <= MAX_SPEECH_RATE)) throw new RangeError("speech rate out of range");
    this.rate = rate;
  }

  /** The next `samples` of output: queued speech, or comfort noise when idle. Always exactly `samples` long. */
  pull(samples: number): Int16Array {
    const out = new Int16Array(samples);
    let filled = 0;
    while (filled < samples) {
      if (!this.playing) {
        const next = this.queue.shift();
        if (!next) break;
        const pcm = this.rate < 1 && !next.renderedAtRate ? timeStretch(next.pcm, this.rate, this.o.sampleRate) : next.pcm;
        this.playing = { seg: next, pcm, offset: 0 };
        this.o.onEvent?.({ kind: "STARTED", id: next.id });
      }
      const p = this.playing;
      const n = Math.min(samples - filled, p.pcm.length - p.offset);
      out.set(p.pcm.subarray(p.offset, p.offset + n), filled);
      filled += n;
      p.offset += n;
      if (p.offset >= p.pcm.length) {
        this.playing = null;
        if (p.seg.repeatable) this.lastRepeatable = p.seg;
        this.o.onEvent?.({ kind: "COMPLETED", id: p.seg.id });
      }
    }
    if (filled < samples) out.set(this.noise.frame(samples - filled), filled);
    return out;
  }

  private cut(reason: "FLUSH" | "GENERATION"): void {
    const p = this.playing;
    if (!p) return;
    this.playing = null;
    this.o.onEvent?.({ kind: "CUT", id: p.seg.id, reason });
  }
}
