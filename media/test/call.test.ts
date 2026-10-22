/**
 * One call end to end in process (Layer 1): the worker's MediaCall over a LOCAL FIXTURE room and a labelled unit
 * fake recorder, against the production gateway routes and binding service (test/support/gateway.ts).
 * [FO-10-01][FO-10-02][FO-10-09][FO-10-18][FO-10-46][FO-05-16][AUTH-03][DATA-03][SAFE-02][FAULT:RECORDING_REFUSED]
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createMemoryLogger } from "@vsp/platform/src/observability/logger.js";
import type { Timers } from "../src/binding/manager.js";
import { DEFAULT_DTMF_MENU } from "../src/playback/dtmf-menu.js";
import type { CallRecorder } from "../src/recording/controller.js";
import type { ObservedEgress, RecorderTarget } from "../src/recording/egress.js";
import { MediaPlaneSupervisor } from "@vsp/platform/src/calls/binding/supervisor.js";
import type { MediaPlaneApi } from "@vsp/platform/src/calls/binding/livekit-lookup.js";
import { supervisorEndCall, supervisorHumanRoute, supervisorPersonState } from "@vsp/platform/src/gateway/http/media-routes.js";
import { silentLogger } from "@vsp/platform/src/observability/logger.js";
import { MediaGatewayClient } from "../src/binding/client.js";
import { MediaCall } from "../src/worker/call.js";
import type { MediaCallConfig } from "../src/worker/call.js";
import { DESTINATIONS, startGateway } from "./support/gateway.js";
import type { GatewayHarness } from "./support/gateway.js";
import { FakeRoom } from "./support/room.js";

let gw: GatewayHarness;
let seq = 0;
beforeAll(async () => {
  gw = await startGateway();
});
afterAll(async () => {
  await gw.close();
});
afterEach(() => {
  gw.transport.heal();
});

/** Labelled unit fake of the egress API. */
class RecorderFake implements CallRecorder {
  readonly running = new Map<string, ObservedEgress>();
  readonly starts: RecorderTarget[] = [];
  private n = 0;
  async start(t: RecorderTarget) {
    this.starts.push(t);
    return Object.entries(t.tracks).map(([party, trackId]) => {
      const id = `EG_synthEgress${++this.n}`;
      this.running.set(id, { egressId: id, trackId, filepath: `${t.pathPrefix}/${party}.ogg`, running: true, status: "EGRESS_ACTIVE", defaultStorage: true });
      return id;
    });
  }
  async stop(_r: string, id: string) {
    const e = this.running.get(id);
    if (e) this.running.set(id, { ...e, running: false, status: "EGRESS_COMPLETE" });
  }
  async observe() {
    return [...this.running.values()];
  }
  anyRunning() {
    return [...this.running.values()].some((e) => e.running);
  }
  ownRunning() {
    return [...this.running.values()].filter((e) => e.running && e.filepath?.startsWith("calls/"));
  }
  /** A recorder somebody else started on the caller's track (not under the call's opaque path). */
  foreign() {
    this.running.set("EG_synthForeign01", { egressId: "EG_synthForeign01", trackId: "TR_synthCaller01", filepath: "foreign/x.ogg", running: true, status: "EGRESS_ACTIVE", defaultStorage: true });
  }
}

/** Labelled unit fake of an in-process tap consumer (transcript store): counts frames and closes. */
class SinkFake {
  frames = 0;
  closed = 0;
  write() {
    this.frames++;
  }
  close() {
    this.closed++;
  }
}

class ManualTimers implements Timers {
  readonly fns = new Map<number, () => void>();
  private n = 0;
  setInterval(fn: () => void) {
    this.fns.set(++this.n, fn);
    return this.n;
  }
  clearInterval(h: unknown) {
    this.fns.delete(h as number);
  }
  async fireAll() {
    for (const fn of [...this.fns.values()]) fn();
    await new Promise((r) => setTimeout(r, 20));
    await gw.idle();
  }
  /** The call's timers in creation order: [health, heartbeat, reconcile] (a re-bind adds a new heartbeat). */
  keys() {
    return [...this.fns.keys()];
  }
  async fire(key: number | undefined) {
    if (key !== undefined) this.fns.get(key)?.();
    await new Promise((r) => setTimeout(r, 30));
    await gw.idle();
  }
}

const CONFIG: MediaCallConfig = {
  workerInstanceRef: "media-worker-a1",
  adapter: "controlled_cascade_runtime",
  language: "en",
  sampleRate: 16_000,
  comfortNoiseDbfs: -66,
  dtmfMenu: DEFAULT_DTMF_MENU,
  bindDeadlineMs: 2_000,
  humanDeadlineMs: 2_000,
  reconcileIntervalMs: 1_000,
  faultSeams: { environment: "ci", faultSeams: false },
  slowerRate: 0.8,
};

function newCall(o: { dispatched?: boolean; metadata?: string; config?: Partial<MediaCallConfig>; roomName?: string; recorder?: RecorderFake | null; egressObserver?: RecorderFake; sinks?: { transcription?: SinkFake; analysis?: SinkFake }; gateway?: MediaGatewayClient } = {}) {
  const n = ++seq;
  const roomName = o.roomName ?? `call-synth-room-${n}`;
  gw.plane.addSipRoom(roomName, `SCL_synthCallCase${n}`);
  const jobRef = `AJ_synthCallJob${n}`;
  const agentIdentity = o.dispatched === false ? `agent-${jobRef}` : gw.plane.dispatch(jobRef);
  const room = new FakeRoom(roomName, agentIdentity);
  room.participants.push({ identity: "sip_synthCaller", kind: "SIP", attributes: { "sip.callID": `SCL_synthCallCase${n}`, "sip.phoneNumber": "+15550100" } });
  const recorder = o.recorder === undefined ? new RecorderFake() : o.recorder;
  const timers = new ManualTimers();
  const log = createMemoryLogger();
  const call = new MediaCall(
    { room, gateway: o.gateway ?? gw.client, recorder, egressObserver: o.egressObserver ?? null, sinks: o.sinks, logger: log.logger, now: () => gw.clock.now().getTime(), timers, sleeper: { sleep: async (ms) => gw.clock.advanceMs(ms) } },
    { jobRef, agentIdentity, expectedCaller: null, metadata: o.metadata },
    { ...CONFIG, ...o.config },
  );
  return { call, room, recorder: recorder as RecorderFake, timers, log, roomName, jobRef, agentIdentity };
}

const until = async (cond: () => boolean, ms = 2_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not reached");
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe("MediaCall [FO-10-01][FO-05-16]", () => {
  it("[FO-10-01] binds the dispatched job, publishes its output, receives the caller's audio and publishes content-free media health", async () => {
    const t = newCall();
    await t.call.start();
    expect(t.call.currentPhase()).toBe("BOUND");
    const feed = t.room.subscribeAudio("sip_synthCaller", "TR_synthCaller01");
    for (let i = 0; i < 5; i++) feed.push(new Int16Array(160).fill(4_000));
    await until(() => t.room.captured.length > 3);
    await t.timers.fireAll();
    await until(() => (t.room.attributes["vsp.mediaHealth"] ?? "").includes('"inboundFrames":5'));
    expect(JSON.parse(t.room.attributes["vsp.mediaHealth"] as string)).toMatchObject({ inboundFrames: 5, inboundPeakDbfs: -18 });
    expect(t.room.processing()).toMatchObject({ recording: { phase: "OFF" }, consent: { recording: { value: "UNKNOWN" } } });
    await t.call.stop("TEST_DONE");
  });

  it("[DATA-03][FO-03-44] recording starts only after consent is GRANTED; the caller's decline key stops it and the readout shows recording and transcript off", async () => {
    const t = newCall();
    await t.call.start();
    t.room.subscribeAudio("sip_synthCaller", "TR_synthCaller01");
    expect(t.recorder.starts).toEqual([]);
    await gw.grant(t.call.binding().claim()!);
    await t.timers.fireAll(); // heartbeat carries the new directive
    await t.call.processing().settled();
    expect(t.recorder.starts).toHaveLength(1);
    expect(t.room.processing()).toMatchObject({ recording: { phase: "ON", active: true } });
    t.room.dtmf("sip_synthCaller", "8");
    await until(() => (t.room.processing() as { recording: { phase: string } }).recording.phase === "OFF");
    expect(t.recorder.anyRunning()).toBe(false);
    expect(t.room.processing()).toMatchObject({ recording: { phase: "OFF", active: false }, transcription: { phase: "OFF" }, consent: { recording: { value: "DECLINED" } }, mismatch: null });
    await until(() => gw.audits.some((a) => a.action === "media.consent.declined" && a.reasonCode === "RECORDING_DECLINED_CONTINUE_UNRECORDED"));
    // The configured alternative is to continue unrecorded: the call stays with the runtime.
    expect(t.call.currentPhase()).toBe("BOUND");
    await t.call.stop("TEST_DONE");
  });

  it("[AUTH-06] digits from anyone but the caller are ignored, and no digit is ever written to the log", async () => {
    const t = newCall();
    await t.call.start();
    t.room.join({ identity: "sip_other", kind: "SIP", attributes: {} });
    const humanRoutesBefore = gw.transport.sent.filter((s) => s.path === "/media/v1/calls/human-route").length;
    // A menu action runs synchronously up to its effect: another party's SLOWER key would change the rate at once.
    t.room.dtmf("sip_other", "2");
    expect(t.call.playbackEngine().speechRate()).toBe(1);
    t.room.dtmf("sip_other", "0");
    t.room.dtmf("sip_synthCaller", "7");
    t.room.dtmf("sip_synthCaller", "2");
    await until(() => t.call.playbackEngine().speechRate() === 0.8);
    // Let any (wrongly) started human route reach the gateway before asserting that none was requested.
    await new Promise((r) => setTimeout(r, 100));
    expect(gw.transport.sent.filter((s) => s.path === "/media/v1/calls/human-route").length).toBe(humanRoutesBefore);
    expect(t.call.currentPhase()).toBe("BOUND");
    expect(JSON.stringify(t.log.records)).not.toMatch(/"digit"|"7"/);
    await t.call.stop("TEST_DONE");
  });

  it("[FO-10-09][FO-10-02] a third party joining advances the session generation; speech prepared under the old one is cut at once", async () => {
    const t = newCall();
    await t.call.start();
    const g1 = t.call.binding().claim()!.sessionGeneration;
    t.call.playbackEngine().enqueue({ id: "utt-1", generation: g1, pcm: new Int16Array(16_000).fill(3_000), repeatable: true });
    t.room.join({ identity: "sip_third", kind: "SIP", attributes: {} });
    expect(t.call.playbackEngine().isSpeaking()).toBe(false);
    await until(() => (t.call.binding().claim()?.sessionGeneration ?? 0) > g1);
    expect(t.call.playbackEngine().currentGeneration()).toBe(g1 + 1);
    expect(t.call.playbackEngine().enqueue({ id: "utt-stale", generation: g1, pcm: new Int16Array(160), repeatable: true })).toBe(false);
    await t.call.stop("TEST_DONE");
  });

  it("[FO-10-01] the caller hanging up ends the binding, stops the recorder and ends the job", async () => {
    const t = newCall();
    await t.call.start();
    t.room.subscribeAudio("sip_synthCaller", "TR_synthCaller01");
    await gw.grant(t.call.binding().claim()!);
    await t.timers.fireAll();
    await t.call.processing().settled();
    expect(t.recorder.anyRunning()).toBe(true);
    t.room.leave("sip_synthCaller");
    const outcome = await t.call.done;
    expect(outcome).toEqual({ phase: "ENDED", reasonCode: "CALLER_HUNG_UP" });
    expect(t.recorder.anyRunning()).toBe(false);
    expect(t.room.outputClosed).toBe(true);
    expect(gw.audits.some((a) => a.action === "call.lifecycle.caller_hung_up")).toBe(true);
  });
});

describe("recovery and routes without a binding [SAFE-02][AUTH-03][FO-19-10]", () => {
  it("[SAFE-02] a job the media plane did not dispatch is never bound; the caller goes to a person through the session-less route", async () => {
    const before = gw.handoff.human.length;
    const t = newCall({ dispatched: false });
    await t.call.start();
    expect(t.call.currentPhase()).toBe("HUMAN_ROUTED");
    expect(t.call.binding().claim()).toBeNull();
    expect(gw.handoff.human.length).toBe(before + 1);
    expect(gw.handoff.human.at(-1)?.reason).toBeTruthy();
    await t.call.stop("TEST_DONE");
  });

  it("[SAFE-02] the safety route is reachable from a call that holds no binding", async () => {
    const t = newCall({ dispatched: false });
    const r = await t.call.routeToSafety([{ source: "EXPLICIT_PHRASE", ruleId: "safety.self_harm.explicit", strength: "CREDIBLE", subject: "SELF", temporal: "CURRENT", negated: false }], "en-US");
    expect(r).toMatchObject({ accepted: true, destinationId: "dst_safety_priority" });
  });

  it("[AUTH-03][FO-19-10] after a worker loss a new job re-binds with a new generation; the old owner's next heartbeat is refused and it leaves without touching the recorder the new owner adopted", async () => {
    const a = newCall();
    await a.call.start();
    a.room.subscribeAudio("sip_synthCaller", "TR_synthCaller01");
    // Consent granted: the first owner records (one egress per party under the call's opaque path).
    await gw.grant(a.call.binding().claim()!);
    await a.timers.fireAll();
    await a.call.processing().settled();
    const adopted = a.recorder.ownRunning().map((e) => e.egressId);
    expect(adopted.length).toBeGreaterThan(0);
    const g1 = a.call.binding().claim()!.sessionGeneration;
    // The first owner's agent is gone from the room; the media plane re-dispatches the room job.
    gw.plane.agents.delete(a.agentIdentity);
    const job2 = `${a.jobRef}r`;
    const id2 = gw.plane.dispatch(job2);
    const room2 = new FakeRoom(a.roomName, id2);
    room2.participants.push(...a.room.participants);
    const log = createMemoryLogger();
    const b = new MediaCall({ room: room2, gateway: gw.client, recorder: a.recorder, logger: log.logger, now: () => gw.clock.now().getTime(), timers: new ManualTimers() }, { jobRef: job2, agentIdentity: id2, expectedCaller: null, metadata: undefined }, { ...CONFIG, workerInstanceRef: "media-worker-b1" });
    await b.start();
    await b.processing().settled();
    expect(b.currentPhase()).toBe("BOUND");
    const g2 = b.binding().claim()!.sessionGeneration;
    expect(g2).toBeGreaterThan(g1);
    expect(log.records.filter((r) => r.event.startsWith("media.binding")).map((r) => [r.event, r.fields.outcome])).toEqual([["media.binding.bound", "REBOUND_AFTER_OWNER_LOSS"]]);
    // The new owner adopted the running recorder (no second start) under the still-granted consent.
    expect(a.recorder.starts).toHaveLength(1);
    expect(b.processing().readout()).toMatchObject({ recording: { phase: "ON", ref: adopted[0] }, sessionGeneration: g2 });
    // A re-bind fences playback to the new generation: the old generation's speech is refused, the new one plays.
    expect(b.playbackEngine().currentGeneration()).toBe(g2);
    expect(b.playbackEngine().enqueue({ id: "utt-old", generation: g1, pcm: new Int16Array(1_600), repeatable: true })).toBe(false);
    expect(b.playbackEngine().enqueue({ id: "utt-new", generation: g2, pcm: new Int16Array(1_600), repeatable: true })).toBe(true);
    await a.timers.fireAll();
    expect(await a.call.done).toEqual({ phase: "ENDED", reasonCode: "BINDING_SUPERSEDED" });
    // The superseded owner left without stopping the egress the new owner holds.
    expect(a.recorder.ownRunning().map((e) => e.egressId)).toEqual(adopted);
    expect(a.room.disconnected).toBe(true);
    await b.stop("TEST_DONE");
  });
});

describe("processing mismatch routes the call to a person [DATA-03][SAFE-02]", () => {
  const humanReasons = () => gw.handoff.human.map((h) => h.reason);

  it("[DATA-03][SAFE-02] a recorder nobody consented to: the person is requested (PROCESSING_MISMATCH, handoff POLICY_REQUIRES_HUMAN), the own recorder and every tap stop, the call is HUMAN_ROUTED", async () => {
    const transcription = new SinkFake();
    const t = newCall({ sinks: { transcription } });
    await t.call.start();
    const feed = t.room.subscribeAudio("sip_synthCaller", "TR_synthCaller01");
    await gw.grant(t.call.binding().claim()!);
    await t.timers.fireAll();
    await t.call.processing().settled();
    expect(t.recorder.ownRunning().length).toBeGreaterThan(0);
    feed.push(new Int16Array(160).fill(1_000));
    await until(() => transcription.frames === 1);
    const humanBefore = gw.handoff.human.length;
    t.recorder.foreign();
    await t.timers.fire(t.timers.keys()[2]); // one reconciliation tick
    await until(() => t.call.currentPhase() === "HUMAN_ROUTED");
    expect(gw.handoff.human.length).toBe(humanBefore + 1);
    expect(humanReasons().at(-1)).toBe("POLICY_REQUIRES_HUMAN");
    expect(gw.audits.some((a) => a.action === "media.route.human_requested" && a.reasonCode === "PROCESSING_MISMATCH")).toBe(true);
    // Processing is suspended: our egress ended (the foreign one is not ours to stop), the transcript tap is closed.
    await t.call.processing().settled();
    expect(t.recorder.ownRunning()).toEqual([]);
    expect(t.room.processing()).toMatchObject({ recording: { phase: "OFF", active: false }, transcription: { phase: "OFF" }, mismatch: "FOREIGN_RECORDER_ACTIVE" });
    expect(transcription.closed).toBe(1);
    feed.push(new Int16Array(160).fill(1_000));
    await new Promise((r) => setTimeout(r, 20));
    expect(transcription.frames).toBe(1);
    // The runtime publishes its phase: the media health attribute says HUMAN_ROUTED.
    await t.timers.fire(t.timers.keys()[0]);
    await until(() => (t.room.attributes["vsp.mediaHealth"] ?? "").includes('"phase":"HUMAN_ROUTED"'));
    await t.call.stop("TEST_DONE");
  });

  it("[SAFE-02] failure injection: the mismatch routes to a person even when the gateway cannot be told the readout", async () => {
    const t = newCall();
    await t.call.start();
    t.room.subscribeAudio("sip_synthCaller", "TR_synthCaller01");
    const humanBefore = gw.handoff.human.length;
    gw.transport.failNext(50, "/processing");
    t.recorder.foreign();
    await t.timers.fire(t.timers.keys()[2]);
    await until(() => t.call.currentPhase() === "HUMAN_ROUTED");
    expect(gw.handoff.human.length).toBe(humanBefore + 1);
    expect(gw.handoff.human.at(-1)?.reason).toBe("POLICY_REQUIRES_HUMAN");
    await t.call.stop("TEST_DONE");
  });

  it("[DATA-03][SAFE-02] recording disabled for the deployment: a recorder on the room is still seen (observe-only egress client), flagged at the gateway, and the call goes to a person", async () => {
    const observer = new RecorderFake();
    const t = newCall({ recorder: null, egressObserver: observer });
    await t.call.start();
    t.room.subscribeAudio("sip_synthCaller", "TR_synthCaller01");
    observer.foreign();
    await t.timers.fire(t.timers.keys()[2]);
    await until(() => t.call.currentPhase() === "HUMAN_ROUTED");
    await until(() => gw.audits.some((a) => a.action === "media.processing.mismatch" && a.reasonCode === "FOREIGN_RECORDER_ACTIVE" && a.interactionId === t.call.binding().binding()!.interactionId));
    expect(t.room.processing()).toMatchObject({ recording: { phase: "OFF", active: false }, mismatch: "FOREIGN_RECORDER_ACTIVE" });
    expect(observer.starts).toEqual([]);
    await t.call.stop("TEST_DONE");
  });

  it("[DATA-03] a revocation recorded in the control plane between heartbeats stops the recorder within one reconciliation tick, without a heartbeat and without a person", async () => {
    const t = newCall();
    await t.call.start();
    t.room.subscribeAudio("sip_synthCaller", "TR_synthCaller01");
    const claim = t.call.binding().claim()!;
    const [, heartbeat, reconcile] = t.timers.keys();
    await gw.grant(claim);
    await t.timers.fire(heartbeat);
    await t.call.processing().settled();
    expect(t.recorder.ownRunning().length).toBeGreaterThan(0);
    // Recording revoked, AI processing kept (the tenant's alternative to recording is to continue unrecorded).
    await gw.grant(claim, { recording: "DECLINED", processing: "GRANTED" });
    await t.timers.fire(reconcile);
    await t.call.processing().settled();
    await until(() => t.recorder.ownRunning().length === 0);
    await t.timers.fire(reconcile);
    expect(t.room.processing()).toMatchObject({ recording: { phase: "OFF" }, consent: { recording: { value: "DECLINED" } }, mismatch: null });
    expect(t.call.currentPhase()).toBe("BOUND");
    await t.call.stop("TEST_DONE");
  });

  it("[DATA-03] a non-caller's audio never reaches the taps; the caller's does", async () => {
    const transcription = new SinkFake();
    const analysis = new SinkFake();
    const t = newCall({ sinks: { transcription, analysis } });
    await t.call.start();
    await gw.grant(t.call.binding().claim()!);
    await t.timers.fireAll();
    await t.call.processing().settled();
    t.room.join({ identity: "sip_other", kind: "SIP", attributes: {} });
    const other = t.room.subscribeAudio("sip_other", "TR_synthOther01");
    for (let i = 0; i < 5; i++) other.push(new Int16Array(160).fill(2_000));
    await new Promise((r) => setTimeout(r, 30));
    expect(transcription.frames).toBe(0);
    expect(analysis.frames).toBe(0);
    await t.call.stop("TEST_DONE");
  });
});

describe("speech fencing on generation changes, holds and transfer legs [FO-10-09][AUTH-03]", () => {
  const seg = (id: string, generation: number, ms = 1_000) => ({ id, generation, pcm: new Int16Array((16 * ms) | 0).fill(3_000), repeatable: true });

  it("[FO-10-09] a generation advanced by the control plane and followed by the heartbeat: speech queued under the old generation never plays (no flush involved)", async () => {
    const t = newCall();
    await t.call.start();
    const g1 = t.call.binding().claim()!.sessionGeneration;
    const p = t.call.playbackEngine();
    expect(p.currentGeneration()).toBe(g1);
    for (const id of ["a", "b", "c"]) expect(p.enqueue(seg(`utt-${id}`, g1))).toBe(true);
    await gw.changeSession(t.call.binding().claim()!);
    await t.timers.fire(t.timers.keys()[1]); // heartbeat
    const g2 = t.call.binding().claim()!.sessionGeneration;
    expect(g2).toBe(g1 + 1);
    expect(p.currentGeneration()).toBe(g2);
    expect(p.isSpeaking()).toBe(false);
    expect(p.enqueue(seg("utt-stale", g1, 10))).toBe(false);
    expect(p.enqueue(seg("utt-new", g2, 10))).toBe(true);
    await t.call.stop("TEST_DONE");
  });

  it("[FO-10-46][FO-10-09] the binding expired while the gateway was unreachable: the same call re-binds with a new generation and its playback is fenced to it", async () => {
    const t = newCall();
    await t.call.start();
    const g1 = t.call.binding().claim()!.sessionGeneration;
    const p = t.call.playbackEngine();
    expect(p.enqueue(seg("utt-a", g1))).toBe(true);
    expect(p.enqueue(seg("utt-b", g1))).toBe(true);
    gw.transport.failNext(1, "/heartbeat");
    gw.clock.advanceMs(31_000);
    await t.timers.fire(t.timers.keys()[1]);
    await until(() => (t.call.binding().claim()?.sessionGeneration ?? 0) > g1 && t.call.currentPhase() === "BOUND");
    const g2 = t.call.binding().claim()!.sessionGeneration;
    expect(t.log.records.some((r) => r.event === "media.binding.rebound" && r.fields.outcome === "REBOUND_AFTER_OWNER_LOSS")).toBe(true);
    expect(p.currentGeneration()).toBe(g2);
    expect(p.isSpeaking()).toBe(false);
    expect(p.enqueue(seg("utt-old", g1, 10))).toBe(false);
    expect(p.enqueue(seg("utt-new", g2, 10))).toBe(true);
    await t.call.stop("TEST_DONE");
  });

  it("[FO-10-09] on hold and on a transfer leg no speech of the current generation is accepted until the hold or leg ends", async () => {
    const t = newCall();
    await t.call.start();
    const g = t.call.binding().claim()!.sessionGeneration;
    const p = t.call.playbackEngine();
    t.room.handlers!.audioMuted("sip_synthCaller", true); // SIP re-INVITE hold
    expect(p.enqueue(seg("utt-hold", g, 10))).toBe(false);
    await until(() => gw.audits.some((a) => a.action === "call.lifecycle.hold_started"));
    t.room.handlers!.audioMuted("sip_synthCaller", false);
    await until(() => p.enqueue(seg("utt-after-hold", g, 10)));
    t.room.join({ identity: "sip_humanAgent", kind: "SIP", attributes: { "vsp.participantRole": "human_agent" } });
    expect(p.enqueue(seg("utt-leg", g, 10))).toBe(false);
    await new Promise((r) => setTimeout(r, 30));
    expect(p.enqueue(seg("utt-leg-later", g, 10))).toBe(false);
    t.room.leave("sip_humanAgent");
    await until(() => p.enqueue(seg("utt-after-leg", g, 10)));
    expect(t.call.binding().claim()!.sessionGeneration).toBe(g);
    await t.call.stop("TEST_DONE");
  });
});

describe("lifecycle delivery [FO-10-09][ACT-01][SAFE-02]", () => {
  const identity = { integrationId: "vsp-media-runtime", tenantId: "tnt_synthTenantMedia0001", environment: "ci" as const, channel: "conversation_runtime" as const, credentialId: "cred-media-runtime-01", authMethod: "oauth2_client_credentials" as const, adapters: ["controlled_cascade_runtime" as const] };

  it("[FO-10-09] failure injection: a third party joining during a one-request gateway blip is retried until acknowledged: the generation advances at the gateway; no speech until then", async () => {
    const t = newCall();
    await t.call.start();
    const g1 = t.call.binding().claim()!.sessionGeneration;
    gw.transport.failNext(1, "/events");
    t.room.join({ identity: "sip_third", kind: "SIP", attributes: {} });
    expect(t.call.playbackEngine().enqueue({ id: "utt-x", generation: g1, pcm: new Int16Array(160), repeatable: true })).toBe(false);
    await until(() => (t.call.binding().claim()?.sessionGeneration ?? 0) > g1);
    const now = t.call.binding().claim()!;
    expect((await gw.bindings.resolveClaim(identity, now)).binding.sessionGeneration).toBe(g1 + 1);
    expect(t.log.records.find((r) => r.event === "media.lifecycle" && r.fields.kind === "PARTICIPANT_JOINED")?.fields.attempts).toBe(2);
    expect(t.call.playbackEngine().enqueue({ id: "utt-y", generation: g1 + 1, pcm: new Int16Array(160), repeatable: true })).toBe(true);
    expect(t.call.currentPhase()).toBe("BOUND");
    await t.call.stop("TEST_DONE");
  });

  it("[FO-10-09][SAFE-02] failure injection: a party change that cannot be reported within the bound fails safe: no speech, a person", async () => {
    const t = newCall({ config: { lifecycleDeadlineMs: 3_000 } });
    await t.call.start();
    const g1 = t.call.binding().claim()!.sessionGeneration;
    const humanBefore = gw.handoff.human.length;
    gw.transport.failNext(1_000, "/events");
    t.room.join({ identity: "sip_third", kind: "SIP", attributes: {} });
    await until(() => t.call.currentPhase() === "HUMAN_ROUTED");
    expect(gw.handoff.human.length).toBe(humanBefore + 1);
    expect(gw.handoff.human.at(-1)?.reason).toBe("DEPENDENCY_FAILURE");
    expect(t.log.records.some((r) => r.event === "media.lifecycle.fail_safe")).toBe(true);
    expect(t.call.playbackEngine().enqueue({ id: "utt-z", generation: g1, pcm: new Int16Array(160), repeatable: true })).toBe(false);
    await t.call.stop("TEST_DONE");
  });

  it("[FO-10-09][ACT-01] failure injection: a hang-up during a gateway blip is retried: the binding is ENDED and the session ended", async () => {
    const t = newCall();
    await t.call.start();
    const claim = t.call.binding().claim()!;
    gw.transport.failNext(2, "/events");
    t.room.leave("sip_synthCaller");
    expect(await t.call.done).toEqual({ phase: "ENDED", reasonCode: "CALLER_HUNG_UP" });
    expect(await gw.bindings.resolveClaim(identity, claim).then(() => "LIVE", (e: { reasonCode?: string }) => e.reasonCode)).toBe("BINDING_NOT_ACTIVE");
    expect(gw.audits.some((a) => a.action === "call.lifecycle.caller_hung_up" && a.interactionId === claim.interactionId)).toBe(true);
    expect(t.room.disconnected).toBe(true);
  });

  it("[FO-10-09][SAFE-02] the binding lost while a party change waits (session revoked): the call goes to a person, and a hang-up queued behind the unreported change still ends the job", async () => {
    const t = newCall();
    await t.call.start();
    await gw.revokeSession(t.call.binding().claim()!);
    t.room.join({ identity: "sip_third", kind: "SIP", attributes: {} });
    await until(() => t.call.currentPhase() === "HUMAN_ROUTED");
    expect(t.log.records.find((r) => r.event === "media.binding.lost")?.fields.reasonCode).toBe("BINDING_SESSION_INVALID");
    t.room.leave("sip_synthCaller");
    expect(await t.call.done).toEqual({ phase: "ENDED", reasonCode: "CALLER_HUNG_UP" });
  });

  it("[FO-10-09] a party change while the call is still binding is reported once bound (never dropped)", async () => {
    const t = newCall();
    const started = t.call.start();
    t.room.join({ identity: "sip_early", kind: "SIP", attributes: {} });
    await started;
    const g = t.call.binding().binding()!.sessionGeneration;
    await until(() => (t.call.binding().claim()?.sessionGeneration ?? 0) > g);
    expect(gw.audits.some((a) => a.action === "call.lifecycle.participant_joined" && a.interactionId === t.call.binding().claim()!.interactionId)).toBe(true);
    await t.call.stop("TEST_DONE");
  });
});
describe("RECORDING_REFUSED injection seam [FAULT:RECORDING_REFUSED][DATA-03]", () => {
  it("armed for the job, the runtime declines recording at call start through the production path: audited, nothing records, even after a later grant", async () => {
    const t = newCall({ metadata: JSON.stringify({ vspFault: "RECORDING_REFUSED" }), config: { faultSeams: { environment: "ci", faultSeams: true } } });
    await t.call.start();
    t.room.subscribeAudio("sip_synthCaller", "TR_synthCaller01");
    const claim = t.call.binding().claim()!;
    expect(gw.audits.some((a) => a.action === "media.consent.declined" && a.sessionGeneration === claim.sessionGeneration)).toBe(true);
    await gw.grant(claim);
    await t.timers.fireAll();
    await t.call.processing().settled();
    expect(t.recorder.starts).toEqual([]);
    expect(t.room.processing()).toMatchObject({ recording: { phase: "OFF" }, consent: { recording: { value: "DECLINED" } } });
    expect(t.log.records.some((r) => r.event === "media.fault.injected")).toBe(true);
    await t.call.stop("TEST_DONE");
  });

  it("not armed in production configuration even when the job asks", async () => {
    const t = newCall({ metadata: JSON.stringify({ vspFault: "RECORDING_REFUSED" }), config: { faultSeams: { environment: "production", faultSeams: true } } });
    await t.call.start();
    expect(t.log.records.some((r) => r.event === "media.fault.injected")).toBe(false);
    await t.call.stop("TEST_DONE");
  });
});

/**
 * LOCAL FIXTURE (unit fake) of livekit-server's Twirp server API as the supervisor reads it, for one room: the caller
 * present or gone, the runtime's agent present or gone, one dispatch to the runtime's agent name.
 */
class SupervisedRoom implements MediaPlaneApi {
  caller = true;
  agent: string | null = null;
  constructor(
    readonly roomName: string,
    private readonly jobRef: string,
  ) {}
  async call(_service: string, method: string) {
    if (method === "ListRooms") return { rooms: [{ name: this.roomName, sid: "RM_synthSupervised1" }] };
    if (method === "ListDispatch") return { agent_dispatches: [{ id: "AD_synthDispatch01", agent_name: "vsp-media", room: this.roomName, state: { created_at: "1000000", jobs: [{ id: this.jobRef, state: { participant_identity: `agent-${this.jobRef}` } }] } }] };
    if (method === "ListParticipants") {
      const ps = [];
      if (this.caller) ps.push({ identity: "sip_synthCaller", kind: "SIP", state: "ACTIVE" });
      if (this.agent) ps.push({ identity: this.agent, kind: "AGENT", state: "ACTIVE" });
      return { participants: ps };
    }
    return {};
  }
}

function supervisorFor(api: SupervisedRoom) {
  let now = 1_000_000;
  const sup = new MediaPlaneSupervisor(
    { agentName: "vsp-media", redispatchGraceMs: 1_000, humanAfterMs: 5_000 },
    {
      api,
      now: () => now,
      routeToHuman: supervisorHumanRoute({ tenantId: "tnt_synthTenantMedia0001", clock: gw.clock, bindings: gw.bindings, handoff: gw.handoff, destinations: DESTINATIONS, audit: { record: async (e) => void gw.audits.push(e) }, logger: silentLogger, language: "en" }),
      endCall: supervisorEndCall(gw.bindings),
      personState: supervisorPersonState(gw.bindings),
    },
  );
  return { sup, tick: (ms: number) => (now += ms) };
}

describe("a runtime that cannot reach a person leaves the room; the supervisor routes the caller [SAFE-02][FO-10-46]", () => {
  it("[SAFE-02] a refused (rotated) runtime token is dropped and retried once with a fresh one: the call binds", async () => {
    let tokens = 0;
    let invalidations = 0;
    let fresh = false;
    const client = new MediaGatewayClient({
      baseUrl: "https://gateway.vsp.test",
      transport: gw.transport,
      credential: async () => (tokens++, fresh ? gw.token() : "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJlLW5vdC12YWxpZA"),
      invalidateCredential: () => {
        invalidations++;
        fresh = true;
      },
      addressClass: "PRIVATE_NETWORK",
    });
    const t = newCall({ gateway: client });
    await t.call.start();
    expect(t.call.currentPhase()).toBe("BOUND");
    expect(invalidations).toBe(1);
    expect(tokens).toBe(2);
    await t.call.stop("TEST_DONE");
  });

  it("a refusal that is not about the runtime token (the media plane did not confirm the job) never fetches a fresh token", async () => {
    let invalidations = 0;
    const client = new MediaGatewayClient({ baseUrl: "https://gateway.vsp.test", transport: gw.transport, credential: () => gw.token(), invalidateCredential: () => void invalidations++, addressClass: "PRIVATE_NETWORK" });
    const t = newCall({ dispatched: false, gateway: client });
    await t.call.start();
    expect(t.call.currentPhase()).toBe("HUMAN_ROUTED");
    expect(invalidations).toBe(0);
    await t.call.stop("TEST_DONE");
  });

  it("[SAFE-02] failure injection: the runtime credential refused for good mid-call: the human route is refused too, the runtime leaves the room, and the supervisor routes the caller to a person", async () => {
    let refuse = false;
    const client = new MediaGatewayClient({
      baseUrl: "https://gateway.vsp.test",
      transport: gw.transport,
      credential: async () => (refuse ? "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJlLW5vdC12YWxpZA" : gw.token()),
      invalidateCredential: () => undefined,
      addressClass: "PRIVATE_NETWORK",
    });
    const t = newCall({ gateway: client });
    await t.call.start();
    expect(t.call.currentPhase()).toBe("BOUND");
    const humanBefore = gw.handoff.human.length;
    refuse = true;
    await t.timers.fire(t.timers.keys()[1]); // heartbeat 401 -> binding lost -> human route 401 -> leave
    expect(await t.call.done).toEqual({ phase: "ENDED", reasonCode: "HUMAN_ROUTE_UNAVAILABLE" });
    expect(t.room.disconnected).toBe(true);
    expect(gw.handoff.human.length).toBe(humanBefore);
    // The supervisor sees the caller without a runtime and, past its deadline, routes the caller itself.
    const api = new SupervisedRoom(t.roomName, t.jobRef);
    const { sup, tick } = supervisorFor(api);
    const outcomes: string[] = [];
    for (let i = 0; i < 4 && !outcomes.includes("HUMAN_ROUTED"); i++) {
      outcomes.push(...(await sup.sweep()).map((r) => r.outcome));
      tick(3_000);
    }
    expect(outcomes).toContain("HUMAN_ROUTED");
    expect(gw.handoff.human.length).toBe(humanBefore + 1);
    expect(gw.handoff.human.at(-1)).toMatchObject({ reason: "DEPENDENCY_FAILURE", callId: t.call.binding().binding()!.interactionId });
  });

  it("[SAFE-02] failure injection: a room name the gateway refuses (over the length bound): bind and human route answer 400, the runtime leaves, the supervisor routes the caller", async () => {
    const t = newCall({ roomName: `call-${"x".repeat(300)}` });
    const humanBefore = gw.handoff.human.length;
    await t.call.start();
    expect(await t.call.done).toEqual({ phase: "ENDED", reasonCode: "HUMAN_ROUTE_UNAVAILABLE" });
    expect(t.log.records.find((r) => r.event === "media.binding.unavailable")?.fields.reasonCode).toBe("INVALID_REQUEST_BODY");
    expect(gw.handoff.human.length).toBe(humanBefore);
    const { sup, tick } = supervisorFor(new SupervisedRoom(t.roomName, t.jobRef));
    const outcomes: string[] = [];
    for (let i = 0; i < 4 && !outcomes.includes("HUMAN_ROUTED"); i++) {
      outcomes.push(...(await sup.sweep()).map((r) => r.outcome));
      tick(3_000);
    }
    expect(outcomes).toContain("HUMAN_ROUTED");
    expect(gw.handoff.human.length).toBe(humanBefore + 1);
  });

  it("[FO-10-09][ACT-01] failure injection: a hang-up the gateway never heard of (unreachable throughout): the job still ends, and the supervisor ends the binding and the session when it sees the caller gone", async () => {
    const t = newCall({ config: { lifecycleDeadlineMs: 2_000, humanDeadlineMs: 1_000 } });
    await t.call.start();
    const claim = t.call.binding().claim()!;
    const api = new SupervisedRoom(t.roomName, t.jobRef);
    api.agent = t.agentIdentity;
    const { sup } = supervisorFor(api);
    expect((await sup.sweep()).map((r) => r.outcome)).toEqual(["OWNED"]);
    gw.transport.failing = true;
    t.room.leave("sip_synthCaller");
    expect(await t.call.done).toEqual({ phase: "ENDED", reasonCode: "CALLER_HUNG_UP" });
    gw.transport.heal();
    const identity = { integrationId: "vsp-media-runtime", tenantId: "tnt_synthTenantMedia0001", environment: "ci" as const, channel: "conversation_runtime" as const, credentialId: "cred-media-runtime-01", authMethod: "oauth2_client_credentials" as const, adapters: ["controlled_cascade_runtime" as const] };
    const { sessionRef } = await gw.bindings.resolveClaim(identity, claim);
    expect(sessionRef).toBeTruthy(); // the gateway still believes the call is live
    api.caller = false;
    api.agent = null;
    expect((await sup.sweep()).map((r) => r.outcome)).toEqual(["CALL_ENDED"]);
    expect(await gw.bindings.resolveClaim(identity, claim).then(() => "LIVE", (e: { reasonCode?: string }) => e.reasonCode)).toBe("BINDING_NOT_ACTIVE");
    expect(gw.audits.some((a) => a.action === "call.lifecycle.caller_gone" && a.interactionId === claim.interactionId)).toBe(true);
  });
});
