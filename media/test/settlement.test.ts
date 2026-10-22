/**
 * The recorders of a call whose runtime was refused into a person route (WP-11; DATA-03, FO-10-46, T-FO-11-03;
 * verifier r3 finding F4).
 *
 * Production code: RecorderSettlement, MediaCall, BindingManager, ProcessingController, the recovery policy,
 * MediaGatewayClient, the gateway media routes (media.recorders), RuntimeCredentialVerifier, CallBindingService,
 * CallBindingStore, TrustedSessionService (media/test/support/gateway.ts). LOCAL FIXTURE / labelled unit fakes:
 * FakeRoom, FakeMediaPlane, HandoffRecorder, MemoryKvStoreFixture, the egress API fake below (`hangStops` models a
 * StopEgress that has not reached the media plane when the owner dies) and the gateway check fake of the isolated
 * cases. The Layer-2 media suite runs the same path against livekit-server's egress API
 * (platform/test/integration/media/recording.test.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMemoryLogger } from "@vsp/platform/src/observability/logger.js";
import type { MediaRecorderCheckResponse, ProcessingDirective } from "@vsp/platform/src/protocol/call-binding.js";
import type { Timers } from "../src/binding/manager.js";
import { DEFAULT_DTMF_MENU } from "../src/playback/dtmf-menu.js";
import type { CallRecorder } from "../src/recording/controller.js";
import type { ObservedEgress, RecorderTarget } from "../src/recording/egress.js";
import { RecorderSettlement } from "../src/recording/settlement.js";
import { MediaCall } from "../src/worker/call.js";
import type { MediaCallConfig } from "../src/worker/call.js";
import { startGateway } from "./support/gateway.js";
import type { GatewayHarness } from "./support/gateway.js";
import { FakeRoom } from "./support/room.js";

/** Labelled unit fake of the egress API: one table for the room, shared by every runtime of the call. */
class EgressFake implements CallRecorder {
  readonly running = new Map<string, ObservedEgress>();
  readonly stopsSeen: string[] = [];
  hangStops = false;
  failObserve = false;
  private n = 0;
  async start(t: RecorderTarget) {
    return Object.entries(t.tracks).map(([party, trackId]) => {
      const id = `EG_synthSettle${++this.n}`;
      this.running.set(id, { egressId: id, trackId, filepath: `${t.pathPrefix}/${party}-{time}.ogg`, running: true, status: "EGRESS_ACTIVE", defaultStorage: true });
      return id;
    });
  }
  async stop(_room: string, id: string) {
    this.stopsSeen.push(id);
    if (this.hangStops) return new Promise<void>(() => undefined);
    const e = this.running.get(id);
    if (e) this.running.set(id, { ...e, running: false, status: "EGRESS_COMPLETE" });
  }
  async observe() {
    if (this.failObserve) throw new Error("EGRESS_API_UNAVAILABLE");
    return [...this.running.values()];
  }
  add(id: string, filepath: string) {
    this.running.set(id, { egressId: id, trackId: "TR_synthCaller01", filepath, running: true, status: "EGRESS_ACTIVE", defaultStorage: true });
  }
  runningIds() {
    return [...this.running.values()].filter((e) => e.running).map((e) => e.egressId);
  }
}

class ManualTimers implements Timers {
  readonly fns = new Map<number, () => void>();
  private n = 0;
  /** `quiet` waits for the gateway's answers to the requests the timers sent (GatewayHarness.idle). */
  constructor(private readonly quiet: () => Promise<void> = async () => undefined) {}
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
    await this.quiet();
  }
}

const T0 = "2026-10-21T12:00:00.000Z";
const consent = (value: "GRANTED" | "DECLINED" | "UNKNOWN") => ({ value, expiresAt: null, capturedAt: value === "UNKNOWN" ? null : T0, templateVersion: "disclosure-en-v3" });
const directive = (recording: "GRANTED" | "DECLINED" | "UNKNOWN"): ProcessingDirective => ({ schemaVersion: "processing-directive.v1", consentVersion: 3, recording: consent(recording), transcriptionAiProcessing: consent("GRANTED"), disclosureTemplateId: "disclosure-en-v3", recordingDeclinedRoute: "HUMAN", decidedAt: T0 });

describe("RecorderSettlement (isolated, labelled check fake) [DATA-03][FO-10-46]", () => {
  function setup(answer: MediaRecorderCheckResponse, o: { observeOnly?: boolean } = {}) {
    const egress = new EgressFake();
    const reports: (string | null)[] = [];
    let checkFails = 0;
    let now = Date.parse(T0);
    const log = createMemoryLogger();
    const settlement = new RecorderSettlement({
      roomName: "settle-room",
      recorder: o.observeOnly ? null : egress,
      observer: egress,
      check: async (mismatch) => {
        if (checkFails > 0) {
          checkFails--;
          throw new Error("GATEWAY_UNREACHABLE");
        }
        reports.push(mismatch);
        return answer;
      },
      logger: log.logger,
      now: () => new Date(now),
      drainBoundMs: 5_000,
    });
    return { egress, reports, settlement, log, failChecks: (n: number) => (checkFails = n), advance: (ms: number) => (now += ms) };
  }

  it("[DATA-03] the named recorders still running are stopped, whatever the consent; a recorder the consent permits is not flagged", async () => {
    const s = setup({ interactionId: "int_synthSettle0001", directive: directive("GRANTED"), recorders: ["EG_synthOwner01"] });
    s.egress.add("EG_synthOwner01", "calls/int_synthSettle0001/cbd_synthOwner/caller-{time}.ogg");
    s.egress.add("EG_synthOther01", "calls/int_synthSettle0001/compliance-{time}.ogg");
    await s.settlement.tick();
    expect(s.egress.runningIds()).toEqual(["EG_synthOther01"]);
    expect(s.settlement.view()).toMatchObject({ answered: true, stopsAsked: ["EG_synthOwner01"], flag: null });
    expect(s.reports).toEqual([null]);
  });

  it("[DATA-03] adversarial: under a declined recording a foreign recorder is flagged FOREIGN_RECORDER_ACTIVE and reported once (never stopped here: it is not the call's)", async () => {
    const s = setup({ interactionId: "int_synthSettle0002", directive: directive("DECLINED"), recorders: ["EG_synthOwner02"] });
    s.egress.add("EG_synthForeign2", "calls/int_synthSettle0002/x-{time}.ogg");
    await s.settlement.tick();
    await s.settlement.tick();
    expect(s.settlement.view()).toMatchObject({ flag: "FOREIGN_RECORDER_ACTIVE", reported: true });
    expect(s.reports).toEqual([null, "FOREIGN_RECORDER_ACTIVE"]);
    expect(s.egress.runningIds()).toEqual(["EG_synthForeign2"]);
    expect(s.log.records.find((r) => r.event === "media.processing.mismatch")?.fields.reasonCode).toBe("FOREIGN_RECORDER_ACTIVE");
  });

  it("[DATA-03] no consent shown (no call record, or its session is gone) permits nothing: a running recorder is flagged", async () => {
    const s = setup({ interactionId: null, directive: null, recorders: [] });
    s.egress.add("EG_synthStray001", "calls/elsewhere/x-{time}.ogg");
    await s.settlement.tick();
    expect(s.settlement.view().flag).toBe("FOREIGN_RECORDER_ACTIVE");
  });

  it("[DATA-03] failure injection: a named recorder whose stop does not land is flagged RECORDING_WITHOUT_CONSENT once the drain bound passes; an observe-only runtime flags it at once", async () => {
    // The egress API accepts the stop but the recorder keeps running: asked again on every tick, judged by the drain bound.
    const stuck = setup({ interactionId: "int_synthSettle0003", directive: directive("DECLINED"), recorders: ["EG_synthOwner03"] });
    stuck.egress.add("EG_synthOwner03", "calls/int_synthSettle0003/cbd_synthOwner/caller-{time}.ogg");
    stuck.egress.stop = async (_r, id) => void stuck.egress.stopsSeen.push(id); // accepted, never takes effect
    await stuck.settlement.tick();
    expect(stuck.settlement.view().flag).toBeNull();
    stuck.advance(6_000);
    await stuck.settlement.tick();
    expect(stuck.settlement.view()).toMatchObject({ flag: "RECORDING_WITHOUT_CONSENT", reported: true });
    const observeOnly = setup({ interactionId: "int_synthSettle0004", directive: directive("DECLINED"), recorders: ["EG_synthOwner04"] }, { observeOnly: true });
    observeOnly.egress.add("EG_synthOwner04", "calls/int_synthSettle0004/cbd_synthOwner/caller-{time}.ogg");
    await observeOnly.settlement.tick();
    expect(observeOnly.settlement.view()).toMatchObject({ flag: "RECORDING_WITHOUT_CONSENT", stopsAsked: [] });
    expect(observeOnly.egress.runningIds()).toEqual(["EG_synthOwner04"]);
  });

  it("failure injection: the gateway or the egress API unavailable: the tick is retried; a flag that cannot be reported is reported on a later tick", async () => {
    const s = setup({ interactionId: "int_synthSettle0005", directive: directive("DECLINED"), recorders: [] });
    s.egress.add("EG_synthForeign5", "calls/x/y-{time}.ogg");
    s.failChecks(1);
    await s.settlement.tick();
    expect(s.settlement.view()).toMatchObject({ answered: false, flag: null });
    s.egress.failObserve = true;
    await s.settlement.tick();
    expect(s.settlement.view()).toMatchObject({ answered: true, flag: null });
    s.egress.failObserve = false;
    s.failChecks(1);
    await s.settlement.tick();
    expect(s.settlement.view()).toMatchObject({ flag: "FOREIGN_RECORDER_ACTIVE", reported: false });
    await s.settlement.tick();
    expect(s.settlement.view()).toMatchObject({ reported: true });
    expect(s.reports).toEqual([null, "FOREIGN_RECORDER_ACTIVE"]);
  });
});

const CFG: MediaCallConfig = { workerInstanceRef: "media-worker-s1", adapter: "controlled_cascade_runtime", language: "en", sampleRate: 16_000, comfortNoiseDbfs: -66, dtmfMenu: DEFAULT_DTMF_MENU, bindDeadlineMs: 2_000, humanDeadlineMs: 2_000, reconcileIntervalMs: 1_000, faultSeams: { environment: "ci", faultSeams: false }, slowerRate: 0.8 };

/**
 * The owner records, the caller declines recording (DTMF), the owner's StopEgress has not reached the media plane when
 * its host dies; a replacement job is dispatched (verifier r3 probe F4, as a regression test).
 */
async function crashDuringDecline(gw: GatewayHarness, roomName: string, callId: string, o: { foreign?: boolean } = {}) {
  gw.plane.addSipRoom(roomName, callId);
  const egress = new EgressFake();
  const mk = (suffix: string) => {
    const jobRef = `AJ_synthSettle${suffix}`;
    const agentIdentity = gw.plane.dispatch(jobRef);
    const room = new FakeRoom(roomName, agentIdentity);
    room.participants.push({ identity: "sip_synthCaller", kind: "SIP", attributes: {} });
    const timers = new ManualTimers(() => gw.idle());
    const log = createMemoryLogger();
    const call = new MediaCall({ room, gateway: gw.client, recorder: egress, logger: log.logger, now: () => gw.clock.now().getTime(), timers, sleeper: { sleep: async (ms) => gw.clock.advanceMs(ms) } }, { jobRef, agentIdentity, expectedCaller: null, metadata: undefined }, { ...CFG, workerInstanceRef: `media-worker-${suffix.toLowerCase()}` });
    return { call, room, timers, log, agentIdentity };
  };
  const a = mk(`${roomName.replace(/[^A-Za-z0-9]/g, "")}A`);
  await a.call.start();
  a.room.subscribeAudio("sip_synthCaller", "TR_synthCaller01");
  await gw.grant(a.call.binding().claim()!);
  await a.timers.fireAll(); // reconcile + report: the gateway keeps the recorders this owner started
  await a.call.processing().settled();
  await a.timers.fireAll();
  const own = egress.runningIds();
  const interactionId = a.call.binding().claim()!.interactionId;
  egress.hangStops = true;
  void a.call.decline("recording", "dtmf_menu");
  await new Promise((r) => setTimeout(r, 60));
  gw.plane.agents.delete(a.agentIdentity); // crash: the agent is gone, its timers never fire again
  a.timers.fns.clear();
  gw.clock.advanceMs(31_000);
  egress.hangStops = false;
  if (o.foreign) egress.add("EG_synthForeignX1", `calls/${interactionId}/exfil-{time}.ogg`);
  const humanBefore = gw.handoff.human.length;
  const auditsBefore = gw.audits.length;
  const b = mk(`${roomName.replace(/[^A-Za-z0-9]/g, "")}B`);
  await b.call.start();
  for (let i = 0; i < 3; i++) {
    gw.clock.advanceMs(1_000);
    await b.timers.fireAll();
  }
  return { a, b, egress, own, interactionId, persons: gw.handoff.human.length - humanBefore, audits: gw.audits.slice(auditsBefore) };
}

describe("a replacement refused into a person route settles the lost owner's recorders [DATA-03][FO-10-46][T-FO-11-03]", () => {
  let human: GatewayHarness;
  let cont: GatewayHarness;
  beforeAll(async () => {
    human = await startGateway({ recordingDeclinedRoute: "HUMAN" });
    cont = await startGateway({ recordingDeclinedRoute: "CONTINUE_UNRECORDED" });
  });
  afterAll(async () => {
    await human.close();
    await cont.close();
  });

  it("[DATA-03][FO-10-46] recording declined (the alternative is a person), owner crashed before its stop landed: the replacement is refused BINDING_CONSENT_REQUIRES_PERSON, routes the person, and stops the owner's named recorders", async () => {
    const r = await crashDuringDecline(human, "settle-decline-human", "SCL_synthSettleH1");
    expect(r.own.length).toBe(2);
    expect(r.b.log.records.find((x) => x.event === "media.binding.unavailable")?.fields.reasonCode).toBe("BINDING_CONSENT_REQUIRES_PERSON");
    expect(r.b.call.currentPhase()).toBe("HUMAN_ROUTED");
    expect(r.b.call.binding().claim()).toBeNull();
    expect(r.persons).toBe(1);
    expect(r.own.filter((id) => r.egress.running.get(id)?.running)).toEqual([]);
    expect(r.b.call.recorderSettlement()?.view()).toMatchObject({ answered: true, flag: null });
    await r.b.call.stop("TEST_DONE");
  });

  it("[DATA-03][T-FO-11-03] adversarial: a recorder started during the crash under the call's own path is not the call's: flagged FOREIGN_RECORDER_ACTIVE, recorded and audited at the gateway, and left to the operator (never stopped by the runtime)", async () => {
    const r = await crashDuringDecline(human, "settle-decline-foreign", "SCL_synthSettleF1", { foreign: true });
    expect(r.b.call.currentPhase()).toBe("HUMAN_ROUTED");
    expect(r.own.filter((id) => r.egress.running.get(id)?.running)).toEqual([]);
    expect(r.egress.running.get("EG_synthForeignX1")?.running).toBe(true);
    expect(r.b.call.recorderSettlement()?.view()).toMatchObject({ flag: "FOREIGN_RECORDER_ACTIVE", reported: true });
    expect(r.audits.filter((e) => e.action === "media.processing.mismatch").map((e) => e.reasonCode)).toEqual(["FOREIGN_RECORDER_ACTIVE"]);
    const rec = await human.bindings.roomForRoute("settle-decline-foreign");
    expect(rec.interactionId).toBe(r.interactionId);
    await r.b.call.stop("TEST_DONE");
  });

  it("[DATA-03] control: the alternative is to continue unrecorded: the replacement binds, adopts the named recorders and stops them itself (no settlement)", async () => {
    const r = await crashDuringDecline(cont, "settle-decline-cont", "SCL_synthSettleC1");
    expect(r.b.call.currentPhase()).toBe("BOUND");
    expect(r.b.call.recorderSettlement()).toBeNull();
    await r.b.call.processing().settled();
    expect(r.own.filter((id) => r.egress.running.get(id)?.running)).toEqual([]);
    expect(r.persons).toBe(0);
    await r.b.call.stop("TEST_DONE");
  });

  it("[AUTH-03] adversarial: the recorder check needs the job: a job not dispatched to the asking agent is refused and names nothing", async () => {
    human.plane.addSipRoom("settle-probe-room", "SCL_synthSettleP1");
    const err = await human.client.recorders({ roomName: "settle-probe-room", jobRef: "AJ_synthNotDispatched", agentIdentity: "agent-AJ_synthNotDispatched", mismatch: null }).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 403, reasonCode: "MEDIA_JOB_NOT_DISPATCHED" });
    // A dispatched job in a room nobody ever bound: no call, no consent, no recorders.
    const agent = human.plane.dispatch("AJ_synthSettleProbe1");
    expect(await human.client.recorders({ roomName: "settle-probe-room", jobRef: "AJ_synthSettleProbe1", agentIdentity: agent, mismatch: null })).toEqual({ interactionId: null, directive: null, recorders: [] });
  });
});
