/**
 * Layer 2 (WP-11; FO-03-17, FO-05-16, FO-10-09, FO-16-19, FO-19-10): a SIP call reaches the production media worker.
 *
 *   - an INVITE from a SIP user agent (the harness's minimal UDP UA) is matched by an inbound trunk; the dispatch rule
 *     creates the call's room and its room configuration dispatches this runtime's agent (no explicit dispatch);
 *   - the worker joins the SIP call's room and binds it: the gateway's CallBinding is for the carrier interaction
 *     named by livekit-sip's own `sip.callID` attribute of the SIP participant (never the caller number), at
 *     session generation 1 [FO-05-16];
 *   - livekit-sip answers the INVITE (200 OK with SDP) only once the SIP participant can subscribe to an audio track:
 *     the runtime's published output track;
 *   - the caller hangs up (BYE): the worker records the hang-up, the binding ends and the job leaves the room
 *     [FO-10-09].
 * Not covered here: RTP media between the UA and livekit-sip (its RTP ports 10000-10099 are only inside the compose
 * network; the WebRTC caller in worker.test.ts covers audio both ways), carrier trunks, SIP TLS/SRTP, carrier DTMF.
 * Synthetic numbers only (555-01xx).
 */
import { afterAll, afterEach, beforeAll, describe, expect } from "vitest";
import { dispose } from "@livekit/rtc-node";
import { RoomAgentDispatch, RoomConfiguration, SipClient } from "livekit-server-sdk";
import { uniqueName } from "../_harness/clients.js";
import { localEnv } from "../_harness/env.js";
import { layer2, layer2Context } from "../_harness/layer2.js";
import type { Layer2Context } from "../_harness/layer2.js";
import { SipUdpClient } from "../_harness/protocols.js";
import { MEDIA_SERVICES, WorkerProcess, agentIn, readoutOf, roomService, startMediaStack, until } from "./support.js";
import type { MediaStack } from "./support.js";

const SERVICES = [...MEDIA_SERVICES, "livekit-sip"] as const;
const it = layer2(SERVICES);
const AGENT = uniqueName("vsp-media-sip");
/** The caller number the harness UA presents (synthetic); it must never reach the binding. */
const CALLER_DIGITS = "5550199";

let stack: MediaStack;
let worker: WorkerProcess;
let sip: SipClient;
const cleanup: (() => Promise<unknown>)[] = [];

const sipClient = (l2: Layer2Context) => new SipClient(l2.url("livekit", 7880), localEnv().livekitApiKey, localEnv().livekitApiSecret);

/** A called number in the synthetic 555-01xx range that no other inbound trunk serves right now. */
async function freeCalledNumber(): Promise<string> {
  const taken = new Set((await sip.listSipInboundTrunk()).flatMap((t) => t.numbers));
  for (let i = 0; i < 200; i++) {
    const n = `+1555${String(100 + 2 + Math.floor(Math.random() * 97)).padStart(4, "0")}`;
    if (!taken.has(n)) return n;
  }
  throw new Error("NO_FREE_SYNTHETIC_NUMBER");
}

beforeAll(async () => {
  stack = await startMediaStack(layer2Context(SERVICES));
  sip = sipClient(stack.l2);
  worker = new WorkerProcess(stack.workerEnv({ agentName: AGENT, recording: false, instance: "media-worker-s1" }));
  await worker.start();
}, 240_000);

afterEach(({ task }) => {
  if (task.result?.state === "fail") process.stderr.write(`--- media worker (SIP) ---\n${worker?.output.slice(-6_000)}\n--- gateway (warn/error) ---\n${stack?.gatewayEvents().slice(-25).join("\n") ?? ""}\n`);
});

afterAll(async () => {
  for (const c of cleanup.reverse()) await c().catch(() => undefined);
  await worker?.stop();
  await stack?.close();
  await dispose();
}, 120_000);

describe("a SIP call on livekit-sip reaches the media worker [FO-03-17][FO-16-19]", () => {
  it("[FO-05-16][FO-10-09][FO-19-10] the INVITE's room dispatches the runtime, which binds the SIP call id at generation 1; livekit-sip answers once the runtime publishes; BYE ends the binding", async ({ l2 }) => {
    const called = await freeCalledNumber();
    const prefix = `${uniqueName("vsp-it-sipcall")}-`;
    const trunk = await sip.createSipInboundTrunk(uniqueName("vsp-it-media-trunk"), [called], {});
    cleanup.push(() => sip.deleteSipTrunk(trunk.sipTrunkId));
    const rule = await sip.createSipDispatchRule(
      { type: "individual", roomPrefix: prefix },
      { trunkIds: [trunk.sipTrunkId], name: uniqueName("vsp-it-media-rule"), roomConfig: new RoomConfiguration({ agents: [new RoomAgentDispatch({ agentName: AGENT })] }) },
    );
    cleanup.push(() => sip.deleteSipDispatchRule(rule.sipDispatchRuleId));
    const ua = await SipUdpClient.open(l2.port("livekit-sip", 5060, "udp"));
    cleanup.push(async () => ua.close());

    ua.invite(called);
    await ua.waitFor(/^SIP\/2\.0 18\d /, 15_000);
    const roomName = await until("SIP call room", async () => (await roomService(l2).listRooms()).map((r) => r.name).find((n) => n.startsWith(prefix)) ?? null, 20_000, 200);
    cleanup.push(() => roomService(l2).deleteRoom(roomName));
    const sipParticipant = await until("SIP participant", async () => (await roomService(l2).listParticipants(roomName)).find((p) => p.attributes["sip.trunkID"] === trunk.sipTrunkId) ?? null, 20_000, 200);
    const sipCallId = sipParticipant.attributes["sip.callID"] ?? "";
    expect(sipCallId).not.toBe("");

    // The room configuration dispatched this runtime: its agent joins and binds the call.
    const agent = await until("agent participant", () => agentIn(l2, roomName), 60_000);
    const bound = await until("binding", () => stack.bindingOf(roomName), 60_000);
    expect(bound.generation).toBe(1);
    // The binding's carrier is livekit-sip's own SIP call id of the SIP participant (read independently from
    // ListParticipants above), pinned with the room's server id and the SIP party at the first touch.
    const record = await stack.store.load(stack.tenantId, bound.interactionId);
    expect(record?.data.carrier).toEqual({ kind: "sip_reference", interactionRef: sipCallId, routeRef: `sip-trunk:${trunk.sipTrunkId}` });
    const roomSid = (await roomService(l2).listRooms([roomName]))[0]?.sid;
    expect(record?.data.room.sid).toBe(roomSid);
    expect(record?.data.carrierParty).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(record)).not.toContain(CALLER_DIGITS);

    // livekit-sip answers only when the SIP participant can subscribe to audio: the runtime's output track.
    const ok = await ua.waitFor(/^SIP\/2\.0 200 [^]*CSeq: 1 INVITE/m, 30_000);
    expect(ok).toMatch(/Content-Type: application\/sdp/i);
    expect(ok).toMatch(/m=audio \d+ RTP\/AVP/);
    const readout = await until("processing readout", async () => readoutOf(await agentIn(l2, roomName)), 30_000);
    expect(readout).toMatchObject({ bindingId: bound.claim.bindingId, sessionGeneration: 1, recording: { phase: "OFF", active: false }, consent: { recording: { value: "UNKNOWN" } }, mismatch: null });
    expect(JSON.stringify(readout)).not.toContain(CALLER_DIGITS);

    // The caller hangs up: the runtime records it, the binding ends and the job leaves the room.
    const beforeBye = await stack.store.load(stack.tenantId, bound.interactionId);
    // The media-plane supervisor runs throughout a deployment; here it has seen the call (owned, caller present).
    const supervisor = stack.supervisor(AGENT, { redispatchGraceMs: 30_000, humanAfterMs: 60_000 });
    expect((await supervisor.sweep()).find((r) => r.roomName === roomName)?.outcome).toBe("OWNED");
    ua.ackAndBye(ok, called);
    await ua.waitFor(/^SIP\/2\.0 200 [^]*CSeq: 2 BYE/m, 10_000);
    const endedByWorker = await until("binding ended by the runtime's hang-up report", async () => {
      const rec = await stack.store.load(stack.tenantId, bound.interactionId);
      return rec?.data.binding.state === "ENDED" ? rec : null;
    }, 30_000).catch(() => null);
    let ended = endedByWorker;
    if (!endedByWorker) {
      // Diagnosis (verifier r2 acceptance, run 4 under heavy host load): was the job alive after the BYE? A live job
      // renews its binding (expiresAt advances with every heartbeat); a job process that died silently does not.
      const now = await stack.store.load(stack.tenantId, bound.interactionId);
      const jobAliveAfterBye = Date.parse(now?.data.binding.expiresAt ?? "0") > Date.parse(beforeBye?.data.binding.expiresAt ?? "0");
      const participants = (await roomService(l2).listParticipants(roomName).catch(() => [])).map((p) => ({ kind: p.kind, state: p.state, agent: p.identity === agent.identity }));
      process.stderr.write(`--- SIP hang-up not reported by the runtime: ${JSON.stringify({ jobAliveAfterBye, state: now?.data.binding.state, participants, signals: (worker.output.match(/media\.lifecycle[^"]*"/g) ?? []).slice(-8) })}\n`);
      // A live job that missed the hang-up is a runtime defect: fail.
      expect(jobAliveAfterBye).toBe(false);
      // A job lost at the hang-up (its process gone): the media-plane supervisor ends the call when it sees the caller
      // gone, as the composition runs it (FO-10-09); the call must not stay bound.
      ended = await until("binding ended by the supervisor", async () => {
        await supervisor.sweep();
        const rec = await stack.store.load(stack.tenantId, bound.interactionId);
        return rec?.data.binding.state === "ENDED" ? rec : null;
      }, 30_000, 1_000);
      expect(stack.audits.some((a) => a.action === "call.lifecycle.caller_gone" && a.interactionId === bound.interactionId)).toBe(true);
    } else {
      // The runtime's own report ended it (the normal path).
      expect(stack.audits.some((a) => a.action === "call.lifecycle.caller_hung_up" && a.interactionId === bound.interactionId)).toBe(true);
    }
    expect(ended?.data.binding.bindingId).toBe(bound.claim.bindingId);
    await until("agent left the room", async () => ((await agentIn(l2, roomName).catch(() => null))?.identity === agent.identity ? null : true), 30_000);
    // The room name carried the caller number (no hidePhoneNumber on this rule): the worker never logged it.
    expect(roomName).toContain(CALLER_DIGITS);
    expect(worker.output).not.toContain(CALLER_DIGITS);
  }, 240_000);
});
