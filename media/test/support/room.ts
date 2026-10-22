/**
 * LOCAL FIXTURE (unit fake) of the room port: participants, attributes and DTMF are driven by the test; the output
 * track records what the runtime captured. The Layer-2 media suite uses the real LiveKitRoomPort in a real room.
 */
import type { ParticipantView } from "../../src/lifecycle/parties.js";
import type { OutputTrack, RoomHandlers, RoomPort } from "../../src/worker/room.js";

export class FakeRoom implements RoomPort {
  handlers: RoomHandlers | null = null;
  readonly attributes: Record<string, string> = {};
  readonly captured: Int16Array[] = [];
  readonly participants: ParticipantView[] = [];
  private feeds = new Map<string, { push(f: Int16Array): void; end(): void }>();
  outputClosed = false;
  disconnected = false;

  constructor(
    readonly name: string,
    private readonly identity: string,
  ) {}

  localIdentity() {
    return this.identity;
  }
  remoteParticipants() {
    return [...this.participants];
  }
  on(h: RoomHandlers) {
    this.handlers = h;
    return () => {
      this.handlers = null;
    };
  }
  async publishOutput(_rate: number, frameSamples: number): Promise<OutputTrack> {
    return {
      trackSid: "TR_synthRuntime01",
      capture: async (pcm) => {
        if (pcm.length !== frameSamples) throw new RangeError("frame size");
        this.captured.push(pcm);
        if (this.captured.length > 400) this.captured.shift();
        await new Promise((r) => setTimeout(r, 2));
      },
      close: async () => {
        this.outputClosed = true;
      },
    };
  }
  async setAttributes(a: Record<string, string>) {
    Object.assign(this.attributes, a);
  }
  async disconnect() {
    this.disconnected = true;
  }

  join(p: ParticipantView) {
    this.participants.push(p);
    this.handlers?.participantJoined(p);
  }
  leave(identity: string) {
    const i = this.participants.findIndex((p) => p.identity === identity);
    const [p] = this.participants.splice(i, 1);
    if (p) this.handlers?.participantLeft(p);
  }
  /** Subscribes the participant's audio; returns the function that pushes frames into it. */
  subscribeAudio(identity: string, trackSid: string): { push(f: Int16Array): void; end(): void } {
    const queue: Int16Array[] = [];
    let wake: (() => void) | null = null;
    let ended = false;
    const iterable: AsyncIterable<Int16Array> = {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          while (queue.length > 0) yield queue.shift() as Int16Array;
          if (ended) return;
          await new Promise<void>((r) => (wake = r));
        }
      },
    };
    const feed = {
      push: (f: Int16Array) => {
        queue.push(f);
        wake?.();
      },
      end: () => {
        ended = true;
        wake?.();
      },
    };
    this.feeds.set(identity, feed);
    this.handlers?.audioSubscribed(identity, trackSid, iterable);
    return feed;
  }
  dtmf(identity: string, digit: string) {
    this.handlers?.dtmf(identity, digit);
  }
  processing(): Record<string, unknown> | null {
    const raw = this.attributes["vsp.mediaProcessing"];
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
  }
}
