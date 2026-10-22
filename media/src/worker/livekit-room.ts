/**
 * RoomPort over a connected @livekit/rtc-node Room (WP-11): the job's room after `ctx.connect()`.
 * Audio in: every subscribed remote audio track is read with an AudioStream at the call's sample rate (mono).
 * Audio out: one AudioSource published as the runtime's microphone track. DTMF arrives as RoomEvent.DtmfReceived
 * (RFC 4733 events relayed by livekit-sip, or a WebRTC participant's publishDtmf).
 */
import { AudioFrame, AudioSource, AudioStream, LocalAudioTrack, RoomEvent, TrackKind, TrackPublishOptions, TrackSource } from "@livekit/rtc-node";
import type { Participant, RemoteParticipant, RemoteTrack, RemoteTrackPublication, Room, TrackPublication } from "@livekit/rtc-node";
import { KIND_BY_NUMBER } from "../lifecycle/parties.js";
import type { ParticipantView } from "../lifecycle/parties.js";
import type { OutputTrack, RoomHandlers, RoomPort } from "./room.js";

export function participantView(p: Participant): ParticipantView {
  return { identity: p.identity, kind: KIND_BY_NUMBER[p.kind as number] ?? "UNKNOWN", attributes: { ...p.attributes } };
}

async function* frames(stream: AudioStream): AsyncIterable<Int16Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done || !value) return;
      yield value.data;
    }
  } finally {
    reader.releaseLock();
  }
}

export class LiveKitRoomPort implements RoomPort {
  constructor(
    private readonly room: Room,
    private readonly sampleRate: number,
  ) {}

  get name(): string {
    return this.room.name ?? "";
  }

  localIdentity(): string {
    return this.room.localParticipant?.identity ?? "";
  }

  remoteParticipants(): ParticipantView[] {
    return [...this.room.remoteParticipants.values()].map(participantView);
  }

  on(h: RoomHandlers): () => void {
    const joined = (p: RemoteParticipant) => h.participantJoined(participantView(p));
    const left = (p: RemoteParticipant) => h.participantLeft(participantView(p));
    const attrs = (_c: Record<string, string>, p: Participant) => h.attributesChanged(participantView(p));
    const muted = (pub: TrackPublication, p: Participant) => {
      if (pub.kind === TrackKind.KIND_AUDIO) h.audioMuted(p.identity, true);
    };
    const unmuted = (pub: TrackPublication, p: Participant) => {
      if (pub.kind === TrackKind.KIND_AUDIO) h.audioMuted(p.identity, false);
    };
    const subscribed = (track: RemoteTrack, pub: RemoteTrackPublication, p: RemoteParticipant) => {
      if (track.kind !== TrackKind.KIND_AUDIO) return;
      h.audioSubscribed(p.identity, pub.sid ?? track.sid ?? "", frames(new AudioStream(track, { sampleRate: this.sampleRate, numChannels: 1 })));
    };
    const dtmf = (_code: number, digit: string, p: RemoteParticipant) => h.dtmf(p.identity, digit);
    const disconnected = () => h.disconnected();
    this.room
      .on(RoomEvent.ParticipantConnected, joined)
      .on(RoomEvent.ParticipantDisconnected, left)
      .on(RoomEvent.ParticipantAttributesChanged, attrs)
      .on(RoomEvent.TrackMuted, muted)
      .on(RoomEvent.TrackUnmuted, unmuted)
      .on(RoomEvent.TrackSubscribed, subscribed)
      .on(RoomEvent.DtmfReceived, dtmf)
      .on(RoomEvent.Disconnected, disconnected);
    // Tracks subscribed before the handlers existed.
    for (const p of this.room.remoteParticipants.values()) {
      for (const pub of p.trackPublications.values()) if (pub.track && pub.subscribed) subscribed(pub.track as RemoteTrack, pub, p);
    }
    return () => {
      this.room
        .off(RoomEvent.ParticipantConnected, joined)
        .off(RoomEvent.ParticipantDisconnected, left)
        .off(RoomEvent.ParticipantAttributesChanged, attrs)
        .off(RoomEvent.TrackMuted, muted)
        .off(RoomEvent.TrackUnmuted, unmuted)
        .off(RoomEvent.TrackSubscribed, subscribed)
        .off(RoomEvent.DtmfReceived, dtmf)
        .off(RoomEvent.Disconnected, disconnected);
    };
  }

  async publishOutput(sampleRate: number, frameSamples: number): Promise<OutputTrack> {
    const local = this.room.localParticipant;
    if (!local) throw new Error("ROOM_NOT_CONNECTED");
    // 100 ms of queue: the pump stays at most that far ahead of real time (flush latency stays bounded).
    const source = new AudioSource(sampleRate, 1, 100);
    const track = LocalAudioTrack.createAudioTrack("vsp-runtime-output", source);
    const pub = await local.publishTrack(track, new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE, dtx: false }));
    return {
      trackSid: pub.sid ?? "",
      capture: async (pcm: Int16Array) => {
        if (pcm.length !== frameSamples) throw new RangeError("output frame size");
        await source.captureFrame(new AudioFrame(pcm, sampleRate, 1, frameSamples));
      },
      close: async () => {
        await local.unpublishTrack(pub.sid ?? "").catch(() => undefined);
        await track.close(true).catch(() => undefined);
      },
    };
  }

  async setAttributes(attributes: Record<string, string>): Promise<void> {
    await this.room.localParticipant?.setAttributes(attributes);
  }

  async disconnect(): Promise<void> {
    await this.room.disconnect();
  }
}
