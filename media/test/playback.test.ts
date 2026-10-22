/**
 * Playback controls and DTMF navigation (media/src/playback) [FO-10-18][FO-10-09]: generation-fenced output,
 * flush, repeat, pitch-preserving slower speech, comfort noise, the DTMF menu.
 */
import { describe, expect, it } from "vitest";
import { rmsDbfs, toneLevelDb } from "../src/codecs/pcm.js";
import { ComfortNoise } from "../src/playback/comfort-noise.js";
import { DEFAULT_DTMF_MENU, DtmfMenu, DtmfMenuConfig } from "../src/playback/dtmf-menu.js";
import { PlaybackEngine } from "../src/playback/engine.js";
import type { PlaybackEvent } from "../src/playback/engine.js";
import { timeStretch } from "../src/playback/stretch.js";

const RATE = 16_000;
const tone = (hz: number, ms: number, amp = 8_000) => {
  const n = (RATE * ms) / 1000;
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.round(amp * Math.sin((2 * Math.PI * hz * i) / RATE));
  return out;
};
const drain = (e: PlaybackEngine, frames: number) => {
  const parts: Int16Array[] = [];
  for (let i = 0; i < frames; i++) parts.push(e.pull(160));
  const out = new Int16Array(parts.length * 160);
  parts.forEach((p, i) => out.set(p, i * 160));
  return out;
};

describe("PlaybackEngine [FO-10-09][FO-10-18]", () => {
  it("[FO-10-09] speech of an older session generation is refused at enqueue and cut mid-segment when the generation advances", () => {
    const events: PlaybackEvent[] = [];
    const e = new PlaybackEngine({ sampleRate: RATE, onEvent: (x) => events.push(x) });
    e.advance(2);
    expect(e.enqueue({ id: "utt-1", generation: 2, pcm: tone(440, 500), repeatable: true })).toBe(true);
    expect(e.enqueue({ id: "utt-old", generation: 1, pcm: tone(440, 100), repeatable: true })).toBe(false);
    drain(e, 5);
    e.advance(3);
    expect(events).toEqual([{ kind: "STARTED", id: "utt-1" }, { kind: "CUT", id: "utt-1", reason: "GENERATION" }]);
    expect(e.isSpeaking()).toBe(false);
    // What follows is comfort noise, not the cut speech.
    expect(toneLevelDb(drain(e, 10), RATE, 440)).toBeLessThan(-60);
    expect(e.repeat()).toBe(false);
  });

  it("[FO-10-18] repeat replays the last completed repeatable segment of the current generation; a one-time readback is never repeated", () => {
    const e = new PlaybackEngine({ sampleRate: RATE });
    e.advance(1);
    e.enqueue({ id: "utt-1", generation: 1, pcm: tone(440, 100), repeatable: true });
    drain(e, 10);
    e.enqueue({ id: "otp-readback", generation: 1, pcm: tone(880, 100), repeatable: false });
    drain(e, 10);
    expect(e.repeat()).toBe(true);
    const again = drain(e, 10);
    expect(toneLevelDb(again, RATE, 440)).toBeGreaterThan(-20);
    expect(toneLevelDb(again, RATE, 880)).toBeLessThan(-50);
  });

  it("flush cuts at the next frame and drops the queue (barge-in, hold, transfer, hang-up)", () => {
    const e = new PlaybackEngine({ sampleRate: RATE });
    e.advance(1);
    e.enqueue({ id: "a", generation: 1, pcm: tone(440, 200), repeatable: true });
    e.enqueue({ id: "b", generation: 1, pcm: tone(660, 200), repeatable: true });
    drain(e, 2);
    e.flush();
    const next = e.pull(160);
    expect(rmsDbfs(next)).toBeLessThan(-55);
    expect(e.isSpeaking()).toBe(false);
  });

  it("[FO-10-18] slower speech: duration grows by 1/rate and the pitch stays (WSOLA); a pre-rendered segment is not stretched twice", () => {
    const src = tone(500, 1_000);
    const slow = timeStretch(src, 0.75, RATE);
    expect(slow.length).toBe(Math.ceil(src.length / 0.75));
    expect(toneLevelDb(slow, RATE, 500)).toBeGreaterThan(toneLevelDb(src, RATE, 500) - 3);
    expect(toneLevelDb(slow, RATE, 375)).toBeLessThan(toneLevelDb(slow, RATE, 500) - 20);
    const e = new PlaybackEngine({ sampleRate: RATE });
    e.advance(1);
    e.setRate(0.75);
    e.enqueue({ id: "a", generation: 1, pcm: src, repeatable: true });
    let frames = 0;
    while (e.isSpeaking()) {
      e.pull(160);
      frames++;
    }
    expect(frames).toBe(Math.ceil(slow.length / 160));
    e.enqueue({ id: "b", generation: 1, pcm: src, repeatable: true, renderedAtRate: true });
    frames = 0;
    while (e.isSpeaking()) {
      e.pull(160);
      frames++;
    }
    expect(frames).toBe(src.length / 160);
    expect(() => e.setRate(0.3)).toThrow();
  });

  it("[FO-10-09] queued speech of an older generation is never emitted after advance(), without any flush: neither the playing segment nor the ones waiting behind it", () => {
    const events: PlaybackEvent[] = [];
    const e = new PlaybackEngine({ sampleRate: RATE, onEvent: (x) => events.push(x) });
    e.advance(1);
    expect(e.enqueue({ id: "g1-playing", generation: 1, pcm: tone(440, 300), repeatable: true })).toBe(true);
    expect(e.enqueue({ id: "g1-queued-a", generation: 1, pcm: tone(660, 300), repeatable: true })).toBe(true);
    expect(e.enqueue({ id: "g1-queued-b", generation: 1, pcm: tone(880, 300), repeatable: true })).toBe(true);
    drain(e, 3); // the first segment is playing
    e.advance(2);
    expect(e.isSpeaking()).toBe(false);
    const after = drain(e, 120); // longer than all three segments together
    expect(events).toEqual([{ kind: "STARTED", id: "g1-playing" }, { kind: "CUT", id: "g1-playing", reason: "GENERATION" }]);
    for (const hz of [440, 660, 880]) expect(toneLevelDb(after, RATE, hz)).toBeLessThan(-60);
    // The new generation speaks normally.
    expect(e.enqueue({ id: "g2", generation: 2, pcm: tone(440, 100), repeatable: true })).toBe(true);
    expect(toneLevelDb(drain(e, 10), RATE, 440)).toBeGreaterThan(-20);
  });

  it("[FO-10-09] a segment of a generation above the binding's is refused and never moves the generation; nothing speaks before the binding sets one", () => {
    const e = new PlaybackEngine({ sampleRate: RATE });
    expect(e.enqueue({ id: "before-bind", generation: 1, pcm: tone(440, 100), repeatable: true })).toBe(false);
    e.advance(3);
    expect(e.enqueue({ id: "ahead", generation: 4, pcm: tone(440, 100), repeatable: true })).toBe(false);
    expect(e.currentGeneration()).toBe(3);
    expect(e.enqueue({ id: "current", generation: 3, pcm: tone(440, 100), repeatable: true })).toBe(true);
  });

  it("[FO-10-09] a hold (call on hold, transfer leg, unacknowledged party change) refuses speech of the CURRENT generation and cuts what plays, until every hold is released", () => {
    const events: PlaybackEvent[] = [];
    const e = new PlaybackEngine({ sampleRate: RATE, onEvent: (x) => events.push(x) });
    e.advance(1);
    e.enqueue({ id: "before-hold", generation: 1, pcm: tone(440, 300), repeatable: true });
    drain(e, 2);
    e.hold("HOLD");
    expect(events.at(-1)).toEqual({ kind: "CUT", id: "before-hold", reason: "FLUSH" });
    expect(e.enqueue({ id: "during-hold", generation: 1, pcm: tone(440, 100), repeatable: true })).toBe(false);
    e.hold("TRANSFER_LEG");
    e.release("HOLD");
    expect(e.isHeld()).toBe(true);
    expect(e.enqueue({ id: "during-leg", generation: 1, pcm: tone(440, 100), repeatable: true })).toBe(false);
    expect(e.repeat()).toBe(false);
    e.release("TRANSFER_LEG");
    expect(e.enqueue({ id: "after", generation: 1, pcm: tone(440, 100), repeatable: true })).toBe(true);
  });

  it("[FO-10-18][FO-10-09] repeat is refused while held (hold or transfer leg): a COMPLETED repeatable segment is not replayed, only comfort noise is emitted; after the release repeat works again", () => {
    const events: PlaybackEvent[] = [];
    const e = new PlaybackEngine({ sampleRate: RATE, comfortNoiseDbfs: -66, onEvent: (x) => events.push(x) });
    e.advance(1);
    e.enqueue({ id: "said-before-hold", generation: 1, pcm: tone(440, 100), repeatable: true });
    drain(e, 15); // played to the end: it is the repeatable segment now
    expect(events.at(-1)).toEqual({ kind: "COMPLETED", id: "said-before-hold" });
    for (const reason of ["HOLD", "TRANSFER_LEG"] as const) {
      e.hold(reason);
      // A DTMF "repeat" during the hold or the transfer leg replays nothing to the caller.
      expect(e.repeat()).toBe(false);
      expect(e.isSpeaking()).toBe(false);
      const held = drain(e, 20);
      expect(toneLevelDb(held, RATE, 440)).toBeLessThan(-60);
      expect(rmsDbfs(held)).toBeLessThan(-55);
      e.release(reason);
      // Released: the same completed segment can be repeated again.
      expect(e.repeat()).toBe(true);
      expect(toneLevelDb(drain(e, 15), RATE, 440)).toBeGreaterThan(-20);
    }
    expect(events.filter((x) => x.kind === "STARTED").map((x) => x.id)).toEqual(["said-before-hold", "said-before-hold", "said-before-hold"]);
  });

  it("idle output is low-level comfort noise, never digital silence, never louder than the configured level", () => {
    const e = new PlaybackEngine({ sampleRate: RATE, comfortNoiseDbfs: -66 });
    const idle = drain(e, 50);
    const level = rmsDbfs(idle);
    expect(level).toBeGreaterThan(-80);
    expect(level).toBeLessThan(-55);
    expect(() => new ComfortNoise(-20)).toThrow();
  });
});

describe("DtmfMenu [FO-10-18][AUTH-06]", () => {
  it("maps digits to navigation actions; unmapped and invalid digits select nothing", () => {
    const m = new DtmfMenu();
    expect(["0", "1", "2", "3", "8", "9"].map((d) => m.onDigit(d))).toEqual(["REQUEST_HUMAN", "REPEAT", "SLOWER", "NORMAL_SPEED", "DECLINE_RECORDING", "DECLINE_AI_PROCESSING"]);
    expect(m.onDigit("5")).toBeNull();
    expect(m.onDigit("A")).toBeNull();
  });

  it("[AUTH-06] during secure entry every digit goes to the collector only and selects no action", () => {
    const m = new DtmfMenu();
    const got: string[] = [];
    const release = m.beginSecureEntry({ accept: (d) => got.push(d) });
    expect(m.onDigit("0")).toBeNull();
    expect(m.onDigit("8")).toBeNull();
    release();
    expect(got).toEqual(["0", "8"]);
    expect(m.onDigit("0")).toBe("REQUEST_HUMAN");
  });

  it("[SAFE-02] a menu without a way to a person is refused", () => {
    expect(DtmfMenuConfig.safeParse({ "1": "REPEAT" }).success).toBe(false);
    expect(DtmfMenuConfig.safeParse(DEFAULT_DTMF_MENU).success).toBe(true);
  });
});
