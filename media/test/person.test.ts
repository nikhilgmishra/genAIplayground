/**
 * A call whose caller was sent to, or is owed, a person never goes back to the AI (WP-11; SAFE-02, FO-10-46, DATA-03,
 * FO-10-09; verifier r2 security findings D1, D2, D3, D6).
 *
 * Production code: MediaCall, BindingManager, the recovery policy, ProcessingController, MediaGatewayClient, the gateway
 * media routes (personRouter), RuntimeCredentialVerifier, CallBindingService, CallBindingStore, TrustedSessionService,
 * MediaPlaneSupervisor with supervisorHumanRoute and supervisorPersonState. LOCAL FIXTURE / labelled unit fakes (from
 * media/test/support): FakeRoom, MemoryKvStoreFixture, FakeMediaPlane, HandoffRecorder (with failure injection), the
 * egress API fake and the supervisor's Twirp answers below. The Layer-2 media suite runs the same paths against
 * livekit-server, DynamoDB Local and the production HandoffService (platform/test/integration/media/person.test.ts).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { MediaPlaneSupervisor } from "@vsp/platform/src/calls/binding/supervisor.js";
import type { MediaPlaneApi } from "@vsp/platform/src/calls/binding/livekit-lookup.js";
import { supervisorEndCall, supervisorHumanRoute, supervisorPersonState } from "@vsp/platform/src/gateway/http/media-routes.js";
import { createMemoryLogger, silentLogger } from "@vsp/platform/src/observability/logger.js";
import type { Timers } from "../src/binding/manager.js";
import { DEFAULT_DTMF_MENU } from "../src/playback/dtmf-menu.js";
import type { CallRecorder } from "../src/recording/controller.js";
import type { ObservedEgress, RecorderTarget } from "../src/recording/egress.js";
import { MediaCall } from "../src/worker/call.js";
import type { MediaCallConfig } from "../src/worker/call.js";
import { DESTINATIONS, TENANT, startGateway } from "./support/gateway.js";
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
  gw.handoff.failing = false;
  gw.handoff.safetyFailing = false;
});

/** Labelled unit fake of the egress API (one table for the room, shared by every runtime of the call). */
class RecorderFake implements CallRecorder {
  readonly running = new Map<string, ObservedEgress>();
  readonly starts: RecorderTarget[] = [];
  private n = 0;
  async start(t: RecorderTarget) {
    this.starts.push(t);
    return Object.entries(t.tracks).map(([party, trackId]) => {
      const id = `EG_synthPerson${++this.n}`;
      this.running.set(id, { egressId: id, trackId, filepath: `${t.pathPrefix}/${party}-{time}.ogg`, running: true, status: "EGRESS_ACTIVE", defaultStorage: true });
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
    await new Promise((r) => setTimeout(r, 30));
    await gw.idle();
  }
}

const CONFIG: MediaCallConfig = {
  workerInstanceRef: "media-worker-p1",
  adapter: "controlled_cascade_runtime",
  language: "en",
  sampleRate: 16_000,
  comfortNoiseDbfs: -66,
  dtmfMenu: DEFAULT_DTMF_MENU,
  bindDeadlineMs: 20_000,
  humanDeadlineMs: 2_000,
  reconcileIntervalMs: 1_000,
  faultSeams: { environment: "ci", faultSeams: false },
  slowerRate: 0.8,
};
const SIGNAL = { source: "EXPLICIT_PHRASE" as const, ruleId: "safety.self_harm.explicit", strength: "CREDIBLE" as const, subject: "SELF" as const, temporal: "CURRENT" as const, negated: false };
const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

/** One runtime of a call: its job, agent, room view and timers (a replacement shares the room, the caller and the egress table). */
function runtime(roomName: string, o: { recorder?: RecorderFake | null; suffix: string; sleeper?: { sleep(ms: number): Promise<void> }; config?: Partial<MediaCallConfig> }) {
  const jobRef = `AJ_synthPerson${o.suffix}`;
  const agentIdentity = gw.plane.dispatch(jobRef);
  const room = new FakeRoom(roomName, agentIdentity);
  room.participants.push({ identity: "sip_synthCaller", kind: "SIP", attributes: {} });
  const timers = new ManualTimers();
  const log = createMemoryLogger();
  const call = new MediaCall(
    { room, gateway: gw.client, recorder: o.recorder ?? null, logger: log.logger, now: () => gw.clock.now().getTime(), timers, sleeper: o.sleeper ?? { sleep: async (ms) => gw.clock.advanceMs(ms) } },
    { jobRef, agentIdentity, expectedCaller: null, metadata: undefined },
    { ...CONFIG, workerInstanceRef: `media-worker-${o.suffix.toLowerCase()}`, ...o.config },
  );
  return { call, room, timers, log, jobRef, agentIdentity };
}

function newRoom(): string {
  const n = ++seq;
  const roomName = `person-room-${n}`;
  gw.plane.addSipRoom(roomName, `SCL_synthPersonCall${n}`);
  return roomName;
}

/** The runtime's process died: its agent participant is gone from the room (its timers die with it). */
function crash(rt: ReturnType<typeof runtime>): void {
  gw.plane.agents.delete(rt.agentIdentity);
  rt.timers.fns.clear();
}

const bindingEvents = (rt: ReturnType<typeof runtime>) => rt.log.records.filter((r) => r.event.startsWith("media.binding")).map((r) => [r.event, r.fields.outcome ?? r.fields.reasonCode]);
const recordOf = async (rt: ReturnType<typeof runtime>) => (await gw.bindings.roomForRoute(rt.room.name)).interactionId;

/** The AI may not speak: speech of the current generation is refused. */
const aiSilenced = (rt: ReturnType<typeof runtime>) => !rt.call.playbackEngine().enqueue({ id: "utt-ai", generation: Math.max(1, rt.call.playbackEngine().currentGeneration()), pcm: new Int16Array(1_600), repeatable: true });

describe("a call with a person never goes back to the AI after a crash [SAFE-02][FO-10-46]", () => {
  it("[SAFE-02][FO-10-46] the caller pressed 0 and the person was accepted; the runtime crashes: the re-dispatched job is refused BINDING_WITH_PERSON and stays silent and suspended; no second person, no new generation", async () => {
    const roomName = newRoom();
    const a = runtime(roomName, { suffix: "A1" });
    await a.call.start();
    const claim = a.call.binding().claim()!;
    const before = gw.handoff.human.length;
    a.room.dtmf("sip_synthCaller", "0");
    await settle();
    expect(a.call.currentPhase()).toBe("HUMAN_ROUTED");
    expect(gw.handoff.human.length).toBe(before + 1);
    crash(a);
    const b = runtime(roomName, { suffix: "B1" });
    await b.call.start();
    expect(b.call.currentPhase()).toBe("HUMAN_ROUTED");
    expect(bindingEvents(b)).toEqual([
      ["media.binding.unavailable", "WITH_PERSON"],
      ["media.binding.with_person", "BINDING_WITH_PERSON"],
    ]);
    expect(b.call.binding().claim()).toBeNull();
    expect(b.call.playbackEngine().heldFor()).toContain("HUMAN_ROUTE");
    expect(aiSilenced(b)).toBe(true);
    expect(gw.handoff.human.length).toBe(before + 1);
    // The gateway issued nothing new: the call's binding is still the first owner's, at its generation.
    const rec = await gw.bindings.resolveClaim({ integrationId: "vsp-media-runtime", tenantId: TENANT, environment: "ci", channel: "conversation_runtime", credentialId: "cred-media-runtime-01", authMethod: "oauth2_client_credentials", adapters: ["controlled_cascade_runtime"] }, claim);
    expect(rec.binding).toMatchObject({ bindingId: claim.bindingId, sessionGeneration: claim.sessionGeneration });
    expect(gw.audits.filter((x) => x.action === "call.binding.recovered" && x.interactionId === claim.interactionId)).toEqual([]);
    // The caller hangs up: the silent runtime ends its job.
    b.room.leave("sip_synthCaller");
    expect(await b.call.done).toEqual({ phase: "ENDED", reasonCode: "CALLER_HUNG_UP" });
  });

  it("[DATA-03][FO-10-46] the caller declined AI processing (DTMF 9; the alternative is a person): routed; after a crash the replacement stays with the person (BINDING_WITH_PERSON), never an AI turn", async () => {
    const roomName = newRoom();
    const a = runtime(roomName, { suffix: "A2" });
    await a.call.start();
    a.room.dtmf("sip_synthCaller", "9");
    await settle(100);
    expect(a.call.currentPhase()).toBe("HUMAN_ROUTED");
    crash(a);
    const b = runtime(roomName, { suffix: "B2" });
    await b.call.start();
    expect(b.call.currentPhase()).toBe("HUMAN_ROUTED");
    expect(aiSilenced(b)).toBe(true);
    expect(b.call.binding().claim()).toBeNull();
  });

  it("[DATA-03][FO-10-46] AI processing declined, then the runtime crashed before it could ask for the person: the replacement is refused BINDING_CONSENT_REQUIRES_PERSON (no new generation) and asks for the person itself", async () => {
    const roomName = newRoom();
    const a = runtime(roomName, { suffix: "A3" });
    await a.call.start();
    const claim = a.call.binding().claim()!;
    // The decline reached the gateway; the runtime died before its human route left.
    await gw.client.consentDecision({ claim, dimension: "transcriptionAiProcessing", decision: "DECLINED", capturedVia: "dtmf_menu", occurredAt: gw.clock.now().toISOString() });
    crash(a);
    const before = gw.handoff.human.length;
    const b = runtime(roomName, { suffix: "B3" });
    await b.call.start();
    expect(bindingEvents(b)[0]).toEqual(["media.binding.unavailable", "HUMAN"]);
    expect(b.log.records.find((r) => r.event === "media.binding.unavailable")?.fields.reasonCode).toBe("BINDING_CONSENT_REQUIRES_PERSON");
    expect(b.call.currentPhase()).toBe("HUMAN_ROUTED");
    expect(gw.handoff.human.length).toBe(before + 1);
    expect(gw.handoff.human.at(-1)?.reason).toBe("CONSENT_DECLINED_ALTERNATIVE");
    expect(aiSilenced(b)).toBe(true);
  });

  it("[SAFE-02] the safety route: the AI stops speaking and every tap is suspended (HUMAN_ROUTED); after a crash the replacement stays silent with the safety destination", async () => {
    const roomName = newRoom();
    const recorder = new RecorderFake();
    const a = runtime(roomName, { suffix: "A4", recorder });
    await a.call.start();
    a.room.subscribeAudio("sip_synthCaller", "TR_synthCaller01");
    await gw.grant(a.call.binding().claim()!);
    await a.timers.fireAll();
    await a.call.processing().settled();
    expect([...recorder.running.values()].some((e) => e.running)).toBe(true);
    const r = await a.call.routeToSafety([SIGNAL], "en-US");
    expect(r).toMatchObject({ accepted: true, destinationId: "dst_safety_priority" });
    expect(a.call.currentPhase()).toBe("HUMAN_ROUTED");
    expect(aiSilenced(a)).toBe(true);
    expect([...recorder.running.values()].some((e) => e.running)).toBe(false);
    expect(a.call.processing().readout()).toMatchObject({ recording: { phase: "OFF" }, transcription: { phase: "OFF" }, analysis: { phase: "OFF" } });
    crash(a);
    const b = runtime(roomName, { suffix: "B4", recorder });
    await b.call.start();
    expect(b.call.currentPhase()).toBe("HUMAN_ROUTED");
    expect(aiSilenced(b)).toBe(true);
    expect(recorder.starts).toHaveLength(1);
  });

  it("[SAFE-02] failure injection: the safety route is not accepted before the deadline: the runtime leaves the room, and the request stays owed so the supervisor's route retries the SAFETY route (never a standard person)", async () => {
    const roomName = newRoom();
    const a = runtime(roomName, { suffix: "A5" });
    await a.call.start();
    gw.handoff.safetyFailing = true;
    const r = await a.call.routeToSafety([SIGNAL], "en-US");
    expect(r).toMatchObject({ accepted: false, reasonCode: "SAFETY_ROUTE_FAILED" });
    expect(await a.call.done).toEqual({ phase: "ENDED", reasonCode: "SAFETY_ROUTE_UNAVAILABLE" });
    expect(await gw.bindings.personStateOfRoom({ sid: gw.plane.rooms.get(roomName)!.roomSid })).toBe("OUTSTANDING");
    gw.handoff.safetyFailing = false;
    const humans = gw.handoff.human.length;
    const safeties = gw.handoff.safety.length;
    await supervisorHumanRoute({ tenantId: TENANT, clock: gw.clock, bindings: gw.bindings, handoff: gw.handoff, destinations: DESTINATIONS, audit: { record: async () => undefined }, logger: silentLogger, language: "en" })(roomName);
    expect(gw.handoff.safety.length).toBe(safeties + 1);
    expect(gw.handoff.human.length).toBe(humans);
    expect(await gw.bindings.personStateOfRoom({ sid: gw.plane.rooms.get(roomName)!.roomSid })).toBe("WITH_PERSON");
  });
});

/** LOCAL FIXTURE (unit fake) of livekit-server's Twirp answers for the supervisor: one room, the caller, the agent holding a job now. */
class SupervisedRoom implements MediaPlaneApi {
  agent: string | null = null;
  readonly jobs: string[] = [];
  readonly created: unknown[] = [];
  constructor(
    readonly roomName: string,
    private readonly sid: string,
  ) {}
  async call(_s: string, method: string, body: Record<string, unknown>) {
    if (method === "ListRooms") return { rooms: [{ name: this.roomName, sid: this.sid }] };
    if (method === "ListDispatch") return { agent_dispatches: [{ id: "AD_synthPersonDisp01", agent_name: "vsp-media", room: this.roomName, state: { created_at: "1000000", jobs: this.jobs.map((j) => ({ id: j, state: { participant_identity: `agent-${j}`, started_at: "1000000" } })) } }] };
    if (method === "ListParticipants") {
      const ps: unknown[] = [{ identity: "sip_synthCaller", kind: "SIP", state: "ACTIVE" }];
      if (this.agent) ps.push({ identity: this.agent, kind: "AGENT", state: "ACTIVE" });
      return { participants: ps };
    }
    if (method === "CreateDispatch") {
      this.created.push(body);
      return {};
    }
    return {};
  }
}

describe("a person who could not be requested is still reached [SAFE-02][FO-10-46]", () => {
  it("[SAFE-02][FO-10-46] the handoff store fails for the runtime's whole deadline: it leaves; the supervisor routes the owed person once the store recovers and never re-dispatches the AI; a replacement dispatched anyway is refused BINDING_PERSON_REQUESTED and asks for the person itself", async () => {
    const roomName = newRoom();
    const a = runtime(roomName, { suffix: "A6" });
    await a.call.start();
    const api = new SupervisedRoom(roomName, gw.plane.rooms.get(roomName)!.roomSid);
    api.jobs.push(a.jobRef);
    api.agent = a.agentIdentity;
    let now = 1_000_000;
    const sup = new MediaPlaneSupervisor(
      { agentName: "vsp-media", redispatchGraceMs: 1_000, humanAfterMs: 5_000 },
      {
        api,
        now: () => now,
        routeToHuman: supervisorHumanRoute({ tenantId: TENANT, clock: gw.clock, bindings: gw.bindings, handoff: gw.handoff, destinations: DESTINATIONS, audit: { record: async () => undefined }, logger: silentLogger, language: "en" }),
        endCall: supervisorEndCall(gw.bindings),
        personState: supervisorPersonState(gw.bindings),
      },
    );
    const outcomes: string[] = [];
    outcomes.push(...(await sup.sweep()).map((r) => r.outcome));
    gw.handoff.failing = true;
    const before = gw.handoff.human.length;
    a.room.dtmf("sip_synthCaller", "0");
    expect(await a.call.done).toEqual({ phase: "ENDED", reasonCode: "HUMAN_ROUTE_UNAVAILABLE" });
    api.agent = null; // the runtime left the room
    // A replacement dispatched meanwhile (by the media plane, or an earlier sweep) is refused and asks for the person.
    const b = runtime(roomName, { suffix: "B6" });
    await b.call.start();
    expect(b.log.records.find((r) => r.event === "media.binding.unavailable")?.fields.reasonCode).toBe("BINDING_PERSON_REQUESTED");
    expect(b.call.binding().claim()).toBeNull();
    expect(await b.call.done).toEqual({ phase: "ENDED", reasonCode: "HUMAN_ROUTE_UNAVAILABLE" });
    gw.handoff.failing = false; // the store recovers
    for (let i = 0; i < 4; i++) {
      now += 2_000;
      outcomes.push(...(await sup.sweep()).map((r) => r.outcome));
    }
    expect(outcomes).toEqual(["OWNED", "HUMAN_ROUTED", "WITH_PERSON", "WITH_PERSON", "WITH_PERSON"]);
    expect(api.created).toEqual([]);
    expect(gw.handoff.human.length).toBe(before + 1);
    // The person was requested for the call's interaction, with the reason the caller gave.
    expect(gw.handoff.human.at(-1)).toMatchObject({ callId: await recordOf(a), reason: "CALLER_REQUESTED_HUMAN" });
  });

  it("[SAFE-02][FO-10-09] the caller presses 0 while the job is still binding (MEDIA_AGENT_NOT_IN_ROOM retries): the bind is cancelled; the call stays HUMAN_ROUTED with no heartbeat or reconcile timer, and a later session revocation changes nothing", async () => {
    const roomName = newRoom();
    let rt: ReturnType<typeof runtime> | null = null;
    let sleeps = 0;
    const sleeper = {
      sleep: async (ms: number) => {
        gw.clock.advanceMs(ms);
        if (++sleeps === 1 && rt) {
          rt.room.dtmf("sip_synthCaller", "0"); // the caller asks for a person while the job binds
          await settle(50);
          gw.plane.agents.add(rt.agentIdentity); // livekit-server lists the agent now: the next bind would succeed
        }
      },
    };
    rt = runtime(roomName, { suffix: "A7", sleeper });
    gw.plane.agents.delete(rt.agentIdentity); // the first binds are refused MEDIA_AGENT_NOT_IN_ROOM
    const before = gw.handoff.human.length;
    const binds = () => gw.transport.sent.filter((x) => x.path === "/media/v1/calls/bindings").length;
    const bindsBefore = binds();
    await rt.call.start();
    await settle();
    expect(rt.call.currentPhase()).toBe("HUMAN_ROUTED");
    expect(gw.handoff.human.length).toBe(before + 1);
    // The bind loop stopped at the person: no bind request left after the first (refused) one.
    expect(binds() - bindsBefore).toBe(1);
    expect(rt.call.binding().claim()).toBeNull();
    // Only the content-free health timer runs: no heartbeat, no reconciliation.
    expect(rt.timers.fns.size).toBe(1);
    expect(rt.call.playbackEngine().heldFor()).toContain("HUMAN_ROUTE");
    expect(bindingEvents(rt).filter(([e]) => e === "media.binding.bound")).toEqual([]);
    await rt.timers.fireAll();
    expect(rt.call.currentPhase()).toBe("HUMAN_ROUTED");
    expect(gw.handoff.human.length).toBe(before + 1);
    await rt.call.stop("TEST_DONE");
  });
});

describe("recorders after an owner loss [DATA-03][SAFE-02][FO-10-46]", () => {
  it("[DATA-03][SAFE-02] adversarial: during a crash a recorder is started on the caller's track under the call's own path; the replacement adopts only the call's recorder the gateway names, flags FOREIGN_RECORDER_ACTIVE and requests a person", async () => {
    const roomName = newRoom();
    const recorder = new RecorderFake();
    const a = runtime(roomName, { suffix: "A8", recorder });
    await a.call.start();
    a.room.subscribeAudio("sip_synthCaller", "TR_synthCaller01");
    await gw.grant(a.call.binding().claim()!);
    await a.timers.fireAll(); // reconcile + report: the gateway keeps the recorders this owner started
    await a.call.processing().settled();
    await a.timers.fireAll();
    const own = [...recorder.running.values()].filter((e) => e.running).map((e) => e.egressId);
    expect(own.length).toBeGreaterThan(0);
    const interactionId = a.call.binding().claim()!.interactionId;
    crash(a);
    // Anyone holding the media-plane secret or a roomRecord grant can name the call's path (it is published in the
    // runtime's processing attribute).
    recorder.running.set("EG_synthExfilCall01", { egressId: "EG_synthExfilCall01", trackId: "TR_synthCaller01", filepath: `calls/${interactionId}/exfil-{time}.ogg`, running: true, status: "EGRESS_ACTIVE", defaultStorage: true });
    const before = gw.handoff.human.length;
    const b = runtime(roomName, { suffix: "B8", recorder });
    await b.call.start();
    b.room.subscribeAudio("sip_synthCaller", "TR_synthCaller01");
    await b.call.processing().settled();
    expect(b.call.processing().readout()?.recorderRefs ?? []).toEqual(own);
    await b.timers.fireAll();
    await settle(100);
    expect(b.call.currentPhase()).toBe("HUMAN_ROUTED");
    expect(gw.handoff.human.length).toBe(before + 1);
    expect(gw.handoff.human.at(-1)?.reason).toBe("POLICY_REQUIRES_HUMAN");
    expect(JSON.parse(b.room.attributes["vsp.mediaProcessing"] as string)).toMatchObject({ mismatch: "FOREIGN_RECORDER_ACTIVE" });
    // No second recorder was started for the call.
    expect(recorder.starts).toHaveLength(1);
  });

  it("[DATA-03] the trusted capture records an AI-processing decline mid-call: the next heartbeat's directive routes the call to a person (the runtime cannot converse without it)", async () => {
    const roomName = newRoom();
    const a = runtime(roomName, { suffix: "A9" });
    await a.call.start();
    const claim = a.call.binding().claim()!;
    await gw.grant(claim, { recording: "GRANTED", processing: "DECLINED" });
    const before = gw.handoff.human.length;
    await a.call.binding().heartbeat();
    await settle(100);
    expect(a.call.currentPhase()).toBe("HUMAN_ROUTED");
    expect(gw.handoff.human.length).toBe(before + 1);
    expect(gw.handoff.human.at(-1)?.reason).toBe("CONSENT_DECLINED_ALTERNATIVE");
    expect(aiSilenced(a)).toBe(true);
    await a.call.stop("TEST_DONE");
  });
});

describe("a person requested for the room by anyone reaches the live AI owner [SAFE-02][FO-10-46]", () => {
  const supervisorRoute = () => supervisorHumanRoute({ tenantId: TENANT, clock: gw.clock, bindings: gw.bindings, handoff: gw.handoff, destinations: DESTINATIONS, audit: { record: async () => undefined }, logger: silentLogger, language: "en" });

  it("[SAFE-02][FO-10-46] a person owed for the room (the supervisor's route, the handoff failed): the live owner's next heartbeat is refused; it stops speaking and recording and asks for the person itself", async () => {
    const roomName = newRoom();
    const recorder = new RecorderFake();
    const a = runtime(roomName, { suffix: "A10", recorder });
    await a.call.start();
    a.room.subscribeAudio("sip_synthCaller", "TR_synthCaller01");
    await gw.grant(a.call.binding().claim()!);
    await a.timers.fireAll();
    await a.call.processing().settled();
    expect([...recorder.running.values()].some((e) => e.running)).toBe(true);
    expect(aiSilenced(a)).toBe(false);
    gw.handoff.failing = true;
    await expect(supervisorRoute()(roomName)).rejects.toMatchObject({ reasonCode: "HANDOFF_REQUEST_FAILED" });
    gw.handoff.failing = false;
    const before = gw.handoff.human.length;
    await a.call.binding().heartbeat();
    await settle(100);
    expect(a.call.binding().loss()).toMatchObject({ reason: "PERSON_REQUESTED", reasonCode: "BINDING_PERSON_REQUESTED" });
    expect(a.call.currentPhase()).toBe("HUMAN_ROUTED");
    expect(aiSilenced(a)).toBe(true);
    expect([...recorder.running.values()].some((e) => e.running)).toBe(false);
    // The person owed is requested once more (the first recorded reason), and then accepted for the room.
    expect(gw.handoff.human.length).toBe(before + 1);
    expect(gw.handoff.human.at(-1)?.reason).toBe("DEPENDENCY_FAILURE");
    expect(await gw.bindings.personStateOfRoom({ sid: gw.plane.rooms.get(roomName)!.roomSid })).toBe("WITH_PERSON");
    await a.call.stop("TEST_DONE");
  });

  it("[SAFE-02][FO-10-46] a person accepted for the room while the owner holds it: the owner's next heartbeat is refused BINDING_WITH_PERSON and it goes silent and suspended (no second person)", async () => {
    const roomName = newRoom();
    const a = runtime(roomName, { suffix: "A11" });
    await a.call.start();
    await supervisorRoute()(roomName);
    const before = gw.handoff.human.length;
    const humanRoutes = () => gw.transport.sent.filter((x) => x.path === "/media/v1/calls/human-route").length;
    const routesBefore = humanRoutes();
    await a.call.binding().heartbeat();
    await settle();
    expect(a.call.binding().loss()).toMatchObject({ reason: "WITH_PERSON" });
    // Silent with the person: it does not even ask the gateway for a person.
    expect(humanRoutes()).toBe(routesBefore);
    expect(a.call.currentPhase()).toBe("HUMAN_ROUTED");
    expect(aiSilenced(a)).toBe(true);
    expect(a.log.records.some((r) => r.event === "media.binding.with_person")).toBe(true);
    expect(gw.handoff.human.length).toBe(before);
    // The caller hangs up: the job ends.
    a.room.leave("sip_synthCaller");
    expect(await a.call.done).toMatchObject({ phase: "ENDED" });
  });

  it("[SAFE-02][FO-10-46] the answer to a lifecycle report says a person is on the call: the owner goes silent at once, before its next heartbeat", async () => {
    const roomName = newRoom();
    const a = runtime(roomName, { suffix: "A12" });
    await a.call.start();
    await supervisorRoute()(roomName);
    const before = gw.handoff.human.length;
    const humanRoutes = () => gw.transport.sent.filter((x) => x.path === "/media/v1/calls/human-route").length;
    const routesBefore = humanRoutes();
    a.room.join({ identity: "sip_synthTransferLeg", kind: "SIP", attributes: {} });
    await settle(100);
    expect(humanRoutes()).toBe(routesBefore);
    expect(a.log.records.some((r) => r.event === "media.binding.with_person")).toBe(true);
    expect(a.call.currentPhase()).toBe("HUMAN_ROUTED");
    expect(aiSilenced(a)).toBe(true);
    expect(a.log.records.find((r) => r.event === "media.lifecycle")?.fields.reasonCode).toBe("BINDING_WITH_PERSON");
    expect(gw.handoff.human.length).toBe(before);
    await a.call.stop("TEST_DONE");
  });

  it("[SAFE-02][FO-10-46] a second job dispatched to a room whose owner is present and renewing: refused BINDING_OWNER_ACTIVE until its deadline, then it leaves; no person is requested and the owner keeps the call", async () => {
    const roomName = newRoom();
    const a = runtime(roomName, { suffix: "A13" });
    await a.call.start();
    const before = gw.handoff.human.length;
    const b = runtime(roomName, { suffix: "B13", config: { bindDeadlineMs: 4_000 } });
    await b.call.start();
    expect(await b.call.done).toEqual({ phase: "ENDED", reasonCode: "BINDING_OWNER_ACTIVE" });
    expect(bindingEvents(b)).toContainEqual(["media.binding.unavailable", "LEAVE"]);
    expect(gw.handoff.human.length).toBe(before);
    expect(await gw.bindings.personStateOfRoom({ sid: gw.plane.rooms.get(roomName)!.roomSid })).toBe("NONE");
    // The owner still holds the call and may speak.
    await a.call.binding().heartbeat();
    expect(a.call.currentPhase()).toBe("BOUND");
    expect(a.call.binding().loss()).toBeNull();
    expect(aiSilenced(a)).toBe(false);
    await a.call.stop("TEST_DONE");
  });
});
