/**
 * The room as the call sees it (WP-11): a narrow port over the LiveKit room (livekit-room.ts implements it with
 * @livekit/rtc-node) so the call's behaviour is unit-testable without a media server. Only what the call needs:
 * participants and their attributes, the caller's audio frames, mute changes, DTMF digits, one published output
 * track, the runtime's own attributes and disconnect.
 */
import type { ParticipantView } from "../lifecycle/parties.js";

export interface RoomHandlers {
  participantJoined(p: ParticipantView): void;
  participantLeft(p: ParticipantView): void;
  attributesChanged(p: ParticipantView): void;
  audioMuted(identity: string, muted: boolean): void;
  /** A participant's audio track was subscribed: mono 16-bit frames at the call's sample rate until it ends. */
  audioSubscribed(identity: string, trackSid: string, frames: AsyncIterable<Int16Array>): void;
  dtmf(identity: string, digit: string): void;
  disconnected(): void;
}

export interface OutputTrack {
  readonly trackSid: string;
  /** Queues one frame; resolves when the source has room for the next (paces the pump in real time). */
  capture(frame: Int16Array): Promise<void>;
  close(): Promise<void>;
}

export interface RoomPort {
  readonly name: string;
  localIdentity(): string;
  remoteParticipants(): ParticipantView[];
  /** Registers the handlers; returns the function that removes them. */
  on(handlers: RoomHandlers): () => void;
  publishOutput(sampleRate: number, frameSamples: number): Promise<OutputTrack>;
  setAttributes(attributes: Record<string, string>): Promise<void>;
  disconnect(): Promise<void>;
}
