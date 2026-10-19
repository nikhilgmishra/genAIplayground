/**
 * Layer 2, FO-17-03 (LiveKit/SIP): real media and real SIP signalling against livekit-server and
 * livekit-sip, using the official SDKs the media worker will use (livekit-server-sdk for the server
 * and SIP APIs, @livekit/rtc-node for WebRTC participants).
 *   - two participants join a room over WebRTC and the listener receives the publisher's audio frames;
 *   - an INVITE from a SIP user agent is matched by an inbound trunk, dispatched into a new room as a
 *     SIP participant, answered (200 OK with SDP) once another participant publishes audio the SIP
 *     participant can subscribe to (livekit-sip keeps the call ringing until then), and ended with BYE;
 *   - an INVITE for a number no trunk serves is refused.
 * Carrier trunks, TURN, PSTN codecs and carrier DTMF remain NOT_RUN (io.vsp.not-emulated).
 * Synthetic numbers only (555-01xx).
 */
import { AudioFrame, AudioSource, AudioStream, dispose, LocalAudioTrack, Room, RoomEvent, TrackKind, TrackPublishOptions, TrackSource } from "@livekit/rtc-node";
import type { RemoteTrack } from "@livekit/rtc-node";
import { AccessToken, RoomServiceClient, SipClient } from "livekit-server-sdk";
import { afterAll, describe, expect } from "vitest";
import { uniqueName } from "./clients.js";
import { localEnv } from "./env.js";
import { layer2 } from "./layer2.js";
import type { Layer2Context } from "./layer2.js";
import { SipUdpClient } from "./protocols.js";

const CALLED = "+15550100";
const UNSERVED = "+15550101";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function token(room: string, identity: string): Promise<string> {
  const t = new AccessToken(localEnv().livekitApiKey, localEnv().livekitApiSecret, { identity, ttl: 300 });
  t.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true });
  return t.toJwt();
}

const wsUrl = (l2: Layer2Context) => l2.url("livekit", 7880, "ws");
const roomService = (l2: Layer2Context) => new RoomServiceClient(l2.url("livekit", 7880), localEnv().livekitApiKey, localEnv().livekitApiSecret);

/** Counts audio frames of the first subscribed audio track until `want` arrived. */
function countAudioFrames(room: Room, want: number): Promise<number> {
  return new Promise((resolve) => {
    room.on(RoomEvent.TrackSubscribed, async (track: RemoteTrack) => {
      if (track.kind !== TrackKind.KIND_AUDIO) return;
      let frames = 0;
      for await (const _frame of new AudioStream(track)) {
        frames += 1;
        if (frames >= want) break;
      }
      resolve(frames);
    });
  });
}

async function publishTone(room: Room, stop: () => boolean): Promise<void> {
  const source = new AudioSource(48_000, 1);
  const track = LocalAudioTrack.createAudioTrack("synthetic-tone", source);
  const opts = new TrackPublishOptions();
  opts.source = TrackSource.SOURCE_MICROPHONE;
  await room.localParticipant?.publishTrack(track, opts);
  const samples = 480;
  let t = 0;
  for (let i = 0; i < 500 && !stop(); i++) {
    const data = new Int16Array(samples);
    for (let j = 0; j < samples; j++) data[j] = Math.round(6_000 * Math.sin((2 * Math.PI * 440 * t++) / 48_000));
    await source.captureFrame(new AudioFrame(data, 48_000, 1, samples));
  }
}

describe("livekit-server and livekit-sip (WebRTC media and SIP signalling)", () => {
  afterAll(async () => {
    await dispose();
  });

  layer2(["livekit", "valkey"])("[FO-17-03] two WebRTC participants exchange audio through livekit-server; the server API lists and removes them", async ({ l2 }) => {
    const svc = roomService(l2);
    const name = uniqueName("vsp-it-room");
    await svc.createRoom({ name, emptyTimeout: 60 });
    const caller = new Room();
    const listener = new Room();
    try {
      const received = countAudioFrames(listener, 25);
      await caller.connect(wsUrl(l2), await token(name, "synthetic-caller"), { autoSubscribe: true, dynacast: false });
      await listener.connect(wsUrl(l2), await token(name, "synthetic-listener"), { autoSubscribe: true, dynacast: false });
      let frames = 0;
      void received.then((n) => {
        frames = n;
      });
      await publishTone(caller, () => frames >= 25);
      expect(await received).toBe(25);
      const participants = (await svc.listParticipants(name)).map((p) => p.identity).sort();
      expect(participants).toEqual(["synthetic-caller", "synthetic-listener"]);
      const disconnected = new Promise<void>((resolve) => listener.once(RoomEvent.Disconnected, () => resolve()));
      await svc.removeParticipant(name, "synthetic-listener");
      await disconnected;
    } finally {
      await caller.disconnect();
      await listener.disconnect();
      await svc.deleteRoom(name).catch(() => undefined);
    }
  });

  layer2(["livekit-sip", "livekit", "valkey"])("[FO-17-03] a SIP INVITE is dispatched into a LiveKit room by the inbound trunk, answered once an agent publishes audio, and ended by BYE", async ({ l2 }) => {
    const sip = new SipClient(l2.url("livekit", 7880), localEnv().livekitApiKey, localEnv().livekitApiSecret);
    const svc = roomService(l2);
    const prefix = `${uniqueName("vsp-it-call")}-`;
    const trunk = await sip.createSipInboundTrunk(uniqueName("vsp-it-trunk"), [CALLED], {});
    const rule = await sip.createSipDispatchRule({ type: "individual", roomPrefix: prefix }, { trunkIds: [trunk.sipTrunkId], name: uniqueName("vsp-it-rule") });
    const ua = await SipUdpClient.open(l2.port("livekit-sip", 5060, "udp"));
    const agent = new Room();
    try {
      ua.invite(CALLED);
      await ua.waitFor(/^SIP\/2\.0 18\d /, 10_000);
      let roomName = "";
      for (let i = 0; i < 50 && !roomName; i++) {
        roomName = (await svc.listRooms()).map((r) => r.name).find((n) => n.startsWith(prefix)) ?? "";
        if (!roomName) await sleep(200);
      }
      expect(roomName).not.toBe("");
      const sipParticipant = (await svc.listParticipants(roomName)).find((p) => p.attributes["sip.trunkID"] === trunk.sipTrunkId);
      expect(sipParticipant?.attributes["sip.phoneNumber"]).toBe("+15550199");
      expect(sipParticipant?.attributes["sip.ruleID"]).toBe(rule.sipDispatchRuleId);
      // livekit-sip answers only when the SIP participant has a track to subscribe to: the agent speaks.
      await agent.connect(wsUrl(l2), await token(roomName, "synthetic-agent"), { autoSubscribe: true, dynacast: false });
      let answered = false;
      const speaking = publishTone(agent, () => answered);
      const ok = await ua.waitFor(/^SIP\/2\.0 200 [^]*CSeq: 1 INVITE/m, 15_000);
      answered = true;
      await speaking;
      expect(ok).toMatch(/Content-Type: application\/sdp/i);
      expect(ok).toMatch(/m=audio \d+ RTP\/AVP/);
      ua.ackAndBye(ok, CALLED);
      await ua.waitFor(/^SIP\/2\.0 200 [^]*CSeq: 2 BYE/m, 10_000);
      let stillThere = true;
      for (let i = 0; i < 50 && stillThere; i++) {
        stillThere = (await svc.listParticipants(roomName).catch(() => [])).some((p) => p.attributes["sip.trunkID"] === trunk.sipTrunkId);
        if (stillThere) await sleep(200);
      }
      expect(stillThere).toBe(false);
    } finally {
      ua.close();
      await agent.disconnect();
      await sip.deleteSipDispatchRule(rule.sipDispatchRuleId).catch(() => undefined);
      await sip.deleteSipTrunk(trunk.sipTrunkId).catch(() => undefined);
    }
  });

  layer2(["livekit-sip", "livekit", "valkey"])("[FO-17-03] an INVITE for a number no inbound trunk serves is refused with a final 4xx", async ({ l2 }) => {
    const ua = await SipUdpClient.open(l2.port("livekit-sip", 5060, "udp"));
    try {
      ua.invite(UNSERVED);
      const final = await ua.waitFor(/^SIP\/2\.0 [4-6]\d\d /, 10_000);
      expect(final).toMatch(/^SIP\/2\.0 4\d\d /);
      expect(ua.statusLines().some((l) => /^SIP\/2\.0 200 /.test(l))).toBe(false);
    } finally {
      ua.close();
    }
  });
});
