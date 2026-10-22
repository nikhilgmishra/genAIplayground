/**
 * Consent-driven recording and processing control (media/src/recording) [DATA-03][FO-03-44][FO-10-46]
 * [FAULT:RECORDING_REFUSED]. The controller runs over a labelled unit fake of the recorder; the LiveKit egress
 * recorder runs over a labelled unit fake of the Twirp transport. The Layer-2 media suite runs both against the
 * real livekit-server and egress service.
 */
import { TokenVerifier } from "livekit-server-sdk";
import { describe, expect, it } from "vitest";
import { MediaProcessingState } from "@vsp/platform/src/protocol/call-binding.js";
import type { ConsentValueV2 } from "@vsp/platform/src/protocol/common.js";
import type { ProcessingDirective, ProcessingMismatch } from "@vsp/platform/src/protocol/call-binding.js";
import { ProcessingController } from "../src/recording/controller.js";
import type { CallRecorder, TapSink } from "../src/recording/controller.js";
import { LiveKitEgressRecorder, RecorderError } from "../src/recording/egress.js";
import type { ObservedEgress, RecorderTarget } from "../src/recording/egress.js";
import { RECORDING_REFUSED_FAULT, armedFaultSeams } from "../src/recording/refusal-seam.js";

const T0 = Date.parse("2026-10-21T12:00:00.000Z");
const IDS = { tenantId: "tnt_synthTenantMedia0001", interactionId: "int_synthInteraction0001", bindingId: "cbd_synthBinding00000001", sessionGeneration: 1 };

const consent = (value: ConsentValueV2) => ({ value, expiresAt: null, capturedAt: value === "UNKNOWN" ? null : new Date(T0).toISOString(), templateVersion: value === "UNKNOWN" ? null : "disclosure-en-v3" });
const directive = (version: number, recording: ConsentValueV2, ai: ConsentValueV2 = "GRANTED"): ProcessingDirective => ({
  schemaVersion: "processing-directive.v1",
  consentVersion: version,
  recording: consent(recording),
  transcriptionAiProcessing: consent(ai),
  disclosureTemplateId: "disclosure-en-v3",
  recordingDeclinedRoute: "CONTINUE_UNRECORDED",
  decidedAt: new Date(T0).toISOString(),
});

/** Labelled unit fake of the egress API: records starts and stops; `observe` answers from its own table. */
class RecorderFake implements CallRecorder {
  readonly running = new Map<string, ObservedEgress>();
  readonly starts: RecorderTarget[] = [];
  readonly stops: string[] = [];
  refuseStart = false;
  observeDown = false;
  ignoreStop = false;
  private n = 0;
  async start(t: RecorderTarget) {
    if (this.refuseStart) throw new RecorderError("RECORDER_UNAVAILABLE", true);
    this.starts.push(t);
    return Object.entries(t.tracks).map(([party, trackId]) => {
      const id = `EG_synthEgress${++this.n}`;
      this.running.set(id, { egressId: id, trackId, filepath: `${t.pathPrefix}/${party}-{time}.ogg`, running: true, status: "EGRESS_ACTIVE", defaultStorage: true });
      return id;
    });
  }
  async stop(_room: string, id: string) {
    this.stops.push(id);
    const e = this.running.get(id);
    if (e && !this.ignoreStop) this.running.set(id, { ...e, running: false, status: "EGRESS_COMPLETE" });
  }
  async observe() {
    if (this.observeDown) throw new RecorderError("RECORDER_API_UNAVAILABLE", true);
    return [...this.running.values()];
  }
  foreign() {
    this.running.set("EG_synthForeign01", { egressId: "EG_synthForeign01", trackId: "TR_x", filepath: "other/x.ogg", running: true, status: "EGRESS_ACTIVE", defaultStorage: true });
  }
}

/** Labelled unit fake of an in-process tap consumer: counts the frames it received. */
class SinkFake implements TapSink {
  frames = 0;
  closed = 0;
  write() {
    this.frames++;
  }
  close() {
    this.closed++;
  }
}

function setup(o: { recorder?: RecorderFake | null; observer?: RecorderFake | null; drainBoundMs?: number; unobservedBoundMs?: number } = {}) {
  let now = T0;
  const recorder = o.recorder === undefined ? new RecorderFake() : o.recorder;
  const sinks = { transcription: new SinkFake(), analysis: new SinkFake() };
  const states: MediaProcessingState[] = [];
  const mismatches: ProcessingMismatch[] = [];
  const c = new ProcessingController({ roomName: "call-synth-room", recorder, observer: o.observer ?? null, sinks, now: () => new Date(now), drainBoundMs: o.drainBoundMs, unobservedBoundMs: o.unobservedBoundMs, onChange: (s) => states.push(s), onMismatch: (m) => mismatches.push(m) });
  return { c, recorder, sinks, states, mismatches, tick: (ms: number) => (now += ms) };
}

async function bound(s: ReturnType<typeof setup>, d: ProcessingDirective) {
  s.c.apply(d);
  s.c.bindTo(IDS);
  s.c.setTracks({ caller: "TR_synthCaller01", runtime: "TR_synthRuntime01" });
  await s.c.settled();
}

describe("recording follows consent [DATA-03][FO-03-44]", () => {
  it("[DATA-03] positive: GRANTED starts one egress per party under an opaque path and the transcript/analysis taps; the readout says so", async () => {
    const s = setup();
    await bound(s, directive(1, "GRANTED"));
    expect(s.recorder?.starts).toEqual([{ roomName: "call-synth-room", pathPrefix: `calls/${IDS.interactionId}/${IDS.bindingId}`, tracks: { caller: "TR_synthCaller01", runtime: "TR_synthRuntime01" } }]);
    const r = s.c.readout()!;
    expect(MediaProcessingState.safeParse(r).success).toBe(true);
    expect(r).toMatchObject({ recording: { phase: "ON", active: true, ref: "EG_synthEgress1" }, transcription: { phase: "ON" }, analysis: { phase: "ON" }, mismatch: null });
    s.c.feed(new Int16Array(480), 48_000);
    expect(s.sinks.transcription.frames).toBe(1);
  });

  it("[DATA-03] adversarial: UNKNOWN is not consent: no recorder start and no tap, ever, until the consent is GRANTED or NOT_REQUIRED", async () => {
    const s = setup();
    await bound(s, directive(1, "UNKNOWN", "UNKNOWN"));
    s.c.feed(new Int16Array(480), 48_000);
    expect(s.recorder?.starts).toEqual([]);
    expect(s.sinks.transcription.frames).toBe(0);
    expect(s.c.readout()).toMatchObject({ recording: { phase: "OFF", active: false }, transcription: { phase: "OFF" }, analysis: { phase: "OFF" } });
    // AI processing GRANTED but recording UNKNOWN: the transcript and analysis taps are recording-dependent.
    s.c.apply(directive(2, "UNKNOWN", "GRANTED"));
    await s.c.settled();
    expect(s.c.readout()).toMatchObject({ recording: { phase: "OFF" }, transcription: { phase: "OFF" }, analysis: { phase: "OFF" } });
    s.c.apply(directive(3, "NOT_REQUIRED", "GRANTED"));
    await s.c.settled();
    expect(s.c.readout()).toMatchObject({ recording: { phase: "ON" }, transcription: { phase: "ON" } });
  });

  it("[DATA-03][FAULT:RECORDING_REFUSED] a decline closes the taps at the next frame boundary and stops the egress; the readout stays running (STOPPING) until the egress API confirms", async () => {
    const s = setup();
    await bound(s, directive(1, "GRANTED"));
    const recorder = s.recorder as RecorderFake;
    recorder.ignoreStop = true; // the egress keeps writing for a moment
    s.c.declineLocal("recording");
    // Synchronously, before any network round trip: the next frame does not reach any tap.
    s.c.feed(new Int16Array(480), 48_000);
    expect(s.sinks.transcription.frames).toBe(0);
    expect(s.sinks.transcription.closed).toBe(1);
    await s.c.settled();
    const draining = s.c.readout()!;
    expect(draining.recording).toMatchObject({ phase: "STOPPING", active: true });
    expect(draining.consent.recording.value).toBe("DECLINED");
    // Never "unrecorded" while the egress API still lists it running.
    expect((await s.c.reconcile())!.recording.active).toBe(true);
    recorder.ignoreStop = false;
    const after = (await s.c.reconcile())!;
    expect(after.recording).toMatchObject({ phase: "OFF", active: false });
    expect(after.transcription.phase).toBe("OFF");
    expect(after.mismatch).toBeNull();
    // A late directive still carrying the grant (an older consent version) never restarts it; the decline is sticky.
    s.c.apply(directive(1, "GRANTED"));
    s.c.apply(directive(2, "GRANTED"));
    await s.c.settled();
    expect(recorder.starts).toHaveLength(1);
    expect(s.c.readout()!.recording.phase).toBe("OFF");
  });

  it("[FAULT:RECORDING_REFUSED] declined at the consent step before any start: nothing ever starts", async () => {
    const s = setup();
    s.c.apply(directive(1, "UNKNOWN"));
    s.c.bindTo(IDS);
    s.c.setTracks({ caller: "TR_synthCaller01" });
    s.c.declineLocal("recording");
    s.c.apply(directive(2, "GRANTED"));
    await s.c.settled();
    expect(s.recorder?.starts).toEqual([]);
    expect(s.c.readout()).toMatchObject({ recording: { phase: "OFF" }, transcription: { phase: "OFF" }, mismatch: null });
  });

  it("failure injection: a drain that outlasts its bound is flagged RECORDING_WITHOUT_CONSENT and reported once", async () => {
    const s = setup({ drainBoundMs: 1_000 });
    await bound(s, directive(1, "GRANTED"));
    (s.recorder as RecorderFake).ignoreStop = true;
    s.c.apply(directive(2, "DECLINED"));
    await s.c.settled();
    await s.c.reconcile();
    expect(s.mismatches).toEqual([]);
    s.tick(1_500);
    const r = (await s.c.reconcile())!;
    expect(r.mismatch).toBe("RECORDING_WITHOUT_CONSENT");
    expect(s.mismatches).toEqual(["RECORDING_WITHOUT_CONSENT"]);
    expect(MediaProcessingState.safeParse(r).success).toBe(true);
  });

  it("[DATA-03] the readout states the consent it follows: a new directive is published even when no recorder or tap changes", async () => {
    const s = setup();
    await bound(s, directive(1, "UNKNOWN"));
    const published = s.states.length;
    s.c.apply(directive(2, "DECLINED"));
    expect(s.states.length).toBeGreaterThan(published);
    expect(s.states.at(-1)).toMatchObject({ recording: { phase: "OFF" }, consent: { consentVersion: 2, recording: { value: "DECLINED" } } });
  });

  it("[DATA-03] a recorder stopped for a person (suspended under consent that still permits recording) that drains slowly stays STOPPING (running) and is NOT flagged as recording without consent; the same drain after a decline is", async () => {
    const s = setup({ drainBoundMs: 1_000 });
    await bound(s, directive(1, "GRANTED"));
    (s.recorder as RecorderFake).ignoreStop = true;
    void s.c.suspend();
    await new Promise((r) => setTimeout(r, 10));
    await s.c.reconcile();
    s.tick(1_500);
    const r = (await s.c.reconcile())!;
    expect(r).toMatchObject({ recording: { phase: "STOPPING", active: true }, mismatch: null });
    expect(s.mismatches).toEqual([]);
    // Consent withdrawn while the drain still runs: now it is a recorder running without consent.
    s.c.apply(directive(2, "DECLINED"));
    s.tick(1_500);
    expect((await s.c.reconcile())!.mismatch).toBe("RECORDING_WITHOUT_CONSENT");
    expect(s.mismatches).toEqual(["RECORDING_WITHOUT_CONSENT"]);
  });

  it("failure injection: the media plane refusing the recorder the disclosure promised is RECORDING_REFUSED_BY_MEDIA_PLANE (FAILED, not ON)", async () => {
    const recorder = new RecorderFake();
    recorder.refuseStart = true;
    const s = setup({ recorder });
    await bound(s, directive(1, "GRANTED"));
    expect(s.c.readout()).toMatchObject({ recording: { phase: "FAILED", active: false }, mismatch: "RECORDING_REFUSED_BY_MEDIA_PLANE" });
    expect(s.mismatches).toEqual(["RECORDING_REFUSED_BY_MEDIA_PLANE"]);
  });

  it("adversarial: a recorder nobody here started is FOREIGN_RECORDER_ACTIVE; an unreadable egress API while ours may run is RECORDER_STATE_UNKNOWN", async () => {
    const s = setup();
    await bound(s, directive(1, "UNKNOWN"));
    (s.recorder as RecorderFake).foreign();
    expect((await s.c.reconcile())!.mismatch).toBe("FOREIGN_RECORDER_ACTIVE");
    const s2 = setup();
    await bound(s2, directive(1, "GRANTED"));
    (s2.recorder as RecorderFake).observeDown = true;
    expect((await s2.c.reconcile())!.mismatch).toBe("RECORDER_STATE_UNKNOWN");
    // With nothing of ours running, an unreadable API is not a contradiction.
    const s3 = setup();
    await bound(s3, directive(1, "UNKNOWN"));
    (s3.recorder as RecorderFake).observeDown = true;
    expect((await s3.c.reconcile())!.mismatch).toBeNull();
  });

  it("[DATA-03] recovery: a new owner adopts the call's running recorder the gateway names for an earlier binding (instead of starting a second one or calling it foreign), and lists it as its own", async () => {
    const recorder = new RecorderFake();
    await recorder.start({ roomName: "call-synth-room", pathPrefix: `calls/${IDS.interactionId}/cbd_synthBindingOld0001`, tracks: { caller: "TR_synthCaller01" } });
    const adopted: (readonly string[])[] = [];
    const c = new ProcessingController({ roomName: "call-synth-room", recorder, observer: null, now: () => new Date(T0), onAdopted: (ids) => adopted.push(ids) });
    c.apply(directive(1, "GRANTED"));
    c.bindTo({ ...IDS, sessionGeneration: 2 }, ["EG_synthEgress1"]);
    c.setTracks({ caller: "TR_synthCaller01", runtime: "TR_synthRuntime02" });
    await c.settled();
    const r = (await c.reconcile())!;
    expect(recorder.starts).toHaveLength(1);
    expect(r).toMatchObject({ recording: { phase: "ON", ref: "EG_synthEgress1" }, mismatch: null, sessionGeneration: 2, recorderRefs: ["EG_synthEgress1"] });
    // The adoption is reported (the runtime logs how many it took over).
    expect(adopted).toEqual([["EG_synthEgress1"]]);
  });

  it("[DATA-03][SAFE-02] adversarial: a recorder named under the call's path that the gateway does not name, one with its own upload target, or one under another call's path is never adopted: FOREIGN_RECORDER_ACTIVE, a person", async () => {
    const cases: { label: string; egress: ObservedEgress; adoptable: string[] }[] = [
      { label: "not named by the gateway", egress: { egressId: "EG_synthExfil01", trackId: "TR_synthCaller01", filepath: `calls/${IDS.interactionId}/exfil-{time}.ogg`, running: true, status: "EGRESS_ACTIVE", defaultStorage: true }, adoptable: ["EG_synthOther001"] },
      { label: "own upload target", egress: { egressId: "EG_synthExfil02", trackId: "TR_synthCaller01", filepath: `calls/${IDS.interactionId}/cbd_synthBindingOld0001/caller-{time}.ogg`, running: true, status: "EGRESS_ACTIVE", defaultStorage: false }, adoptable: ["EG_synthExfil02"] },
      { label: "another call's path", egress: { egressId: "EG_synthExfil03", trackId: "TR_synthCaller01", filepath: "calls/int_synthOtherCall0001/cbd_synthBindingOld0001/caller-{time}.ogg", running: true, status: "EGRESS_ACTIVE", defaultStorage: true }, adoptable: ["EG_synthExfil03"] },
    ];
    for (const c of cases) {
      const recorder = new RecorderFake();
      recorder.running.set(c.egress.egressId, c.egress);
      const s = setup({ recorder });
      const mismatches = s.mismatches;
      s.c.apply(directive(1, "GRANTED"));
      s.c.bindTo({ ...IDS, sessionGeneration: 2 }, c.adoptable);
      s.c.setTracks({ caller: "TR_synthCaller01", runtime: "TR_synthRuntime02" });
      await s.c.settled();
      const r = (await s.c.reconcile())!;
      expect(r.mismatch, c.label).toBe("FOREIGN_RECORDER_ACTIVE");
      expect(r.recorderRefs, c.label).not.toContain(c.egress.egressId);
      expect(r.recording.ref, c.label).not.toBe(c.egress.egressId);
      expect(mismatches, c.label).toEqual(["FOREIGN_RECORDER_ACTIVE"]);
    }
  });

  it("suspend (binding lost, call ended) stops everything and nothing restarts", async () => {
    const s = setup();
    await bound(s, directive(1, "GRANTED"));
    await s.c.suspend();
    s.c.apply(directive(5, "GRANTED"));
    await s.c.settled();
    expect(s.c.readout()).toMatchObject({ recording: { phase: "OFF" }, transcription: { phase: "OFF" }, analysis: { phase: "OFF" } });
    expect(s.recorder?.starts).toHaveLength(1);
  });

  it("without a configured recorder the call is honestly unrecorded (OFF, no mismatch) while the egress API lists nothing for the room", async () => {
    const observer = new RecorderFake();
    const s = setup({ recorder: null, observer });
    await bound(s, directive(1, "GRANTED"));
    expect((await s.c.reconcile())!).toMatchObject({ recording: { phase: "OFF", ref: null }, mismatch: null });
    expect(observer.starts).toEqual([]);
  });

  it("[DATA-03] adversarial: with the recorder disabled, a recorder somebody else started on the room is still seen: FOREIGN_RECORDER_ACTIVE, never 'unrecorded'", async () => {
    const observer = new RecorderFake();
    const s = setup({ recorder: null, observer });
    await bound(s, directive(1, "UNKNOWN", "UNKNOWN"));
    observer.foreign();
    const r = (await s.c.reconcile())!;
    expect(r.mismatch).toBe("FOREIGN_RECORDER_ACTIVE");
    expect(s.mismatches).toEqual(["FOREIGN_RECORDER_ACTIVE"]);
    expect(observer.starts).toEqual([]);
    expect(observer.stops).toEqual([]); // observe-only: never touches the egress
  });

  it("[DATA-03] failure injection: with the recorder disabled, an egress API unreadable past its bound is RECORDER_STATE_UNKNOWN; a brief outage is tolerated", async () => {
    const observer = new RecorderFake();
    const s = setup({ recorder: null, observer, unobservedBoundMs: 10_000 });
    await bound(s, directive(1, "UNKNOWN", "UNKNOWN"));
    observer.observeDown = true;
    expect((await s.c.reconcile())!.mismatch).toBeNull();
    s.tick(5_000);
    expect((await s.c.reconcile())!.mismatch).toBeNull();
    // Readable again: the outage clock restarts.
    observer.observeDown = false;
    await s.c.reconcile();
    observer.observeDown = true;
    s.tick(9_000);
    expect((await s.c.reconcile())!.mismatch).toBeNull();
    s.tick(11_000);
    expect((await s.c.reconcile())!.mismatch).toBe("RECORDER_STATE_UNKNOWN");
    expect(s.mismatches).toEqual(["RECORDER_STATE_UNKNOWN"]);
  });

  it("[DATA-03] consent that expires mid-call: the first frame past the expiry reaches no tap, the taps close, and the recorder stops; no new directive is needed", async () => {
    const s = setup();
    const expiring = (v: ConsentValueV2) => ({ ...consent(v), expiresAt: new Date(T0 + 1_000).toISOString() });
    await bound(s, { ...directive(1, "GRANTED"), recording: expiring("GRANTED"), transcriptionAiProcessing: expiring("GRANTED") });
    s.c.feed(new Int16Array(480), 48_000);
    expect(s.sinks.transcription.frames).toBe(1);
    expect(s.sinks.analysis.frames).toBe(1);
    s.tick(1_000); // exactly at the expiry: no longer permitted
    for (let i = 0; i < 400; i++) s.c.feed(new Int16Array(480), 48_000);
    expect(s.sinks.transcription.frames).toBe(1);
    expect(s.sinks.analysis.frames).toBe(1);
    expect(s.sinks.transcription.closed).toBe(1);
    await s.c.settled();
    const r = (await s.c.reconcile())!;
    expect(r).toMatchObject({ recording: { phase: "OFF", active: false }, transcription: { phase: "OFF" }, analysis: { phase: "OFF" }, mismatch: null });
    expect([...(s.recorder as RecorderFake).running.values()].some((e) => e.running)).toBe(false);
    expect(s.mismatches).toEqual([]);
  });

  it("[DATA-03] consent that expires while no frame arrives (caller muted): the next reconciliation stops the recorder", async () => {
    const s = setup();
    await bound(s, { ...directive(1, "GRANTED"), recording: { ...consent("GRANTED"), expiresAt: new Date(T0 + 1_000).toISOString() } });
    expect(s.c.readout()!.recording.phase).toBe("ON");
    s.tick(2_000);
    await s.c.reconcile();
    const r = (await s.c.reconcile())!;
    expect(r.recording).toMatchObject({ phase: "OFF", active: false });
    expect([...(s.recorder as RecorderFake).running.values()].some((e) => e.running)).toBe(false);
  });
});

describe("RECORDING_REFUSED injection seam [FAULT:RECORDING_REFUSED]", () => {
  it("arms only in local/ci with seams enabled and a job naming the fault", () => {
    const meta = JSON.stringify({ vspFault: RECORDING_REFUSED_FAULT });
    expect([...armedFaultSeams({ environment: "ci", faultSeams: true }, meta)]).toEqual([RECORDING_REFUSED_FAULT]);
    expect(armedFaultSeams({ environment: "production", faultSeams: true }, meta).size).toBe(0);
    expect(armedFaultSeams({ environment: "staging", faultSeams: true }, meta).size).toBe(0);
    expect(armedFaultSeams({ environment: "local", faultSeams: false }, meta).size).toBe(0);
    expect(armedFaultSeams({ environment: "local", faultSeams: true }, JSON.stringify({ vspFault: "ANYTHING_ELSE" })).size).toBe(0);
    expect(armedFaultSeams({ environment: "local", faultSeams: true }, "not json").size).toBe(0);
  });
});

/* -------------------------------------------------------------------------------------------------------------- */

const KEY = "lkkey_synthUnit01";
const SECRET = "lksecret_synthOnlyForUnitTests0123456789";

/** Labelled unit fake of the Twirp transport, answering the livekit Egress service JSON shapes. */
class EgressTwirpFake {
  readonly seen: { method: string; body: Record<string, unknown>; grants: Record<string, unknown>; sideEffect: boolean }[] = [];
  constructor(private readonly replies: Record<string, (body: Record<string, unknown>) => { status: number; body: unknown }>) {}
  async send(req: { url: URL; headers: Readonly<Record<string, string>>; body: string | Buffer | null; sideEffect: boolean }) {
    const claims = await new TokenVerifier(KEY, SECRET).verify((req.headers.authorization ?? "").replace(/^Bearer /, ""));
    const method = req.url.pathname.split("/").pop() ?? "";
    const body = JSON.parse(String(req.body)) as Record<string, unknown>;
    this.seen.push({ method, body, grants: (claims.video ?? {}) as Record<string, unknown>, sideEffect: req.sideEffect });
    const reply = this.replies[method]?.(body) ?? { status: 404, body: { code: "not_found" } };
    return { status: reply.status, headers: {}, body: Buffer.from(JSON.stringify(reply.body)) };
  }
}

const recorderOver = (fake: EgressTwirpFake) => new LiveKitEgressRecorder({ apiUrl: "https://livekit.vsp.test", transport: fake, credentials: async () => ({ apiKey: KEY, apiSecret: SECRET }), addressClass: "PRIVATE_NETWORK" });

describe("LiveKitEgressRecorder over the Egress Twirp API [FO-03-44]", () => {
  it("starts a TrackEgress per party with a roomRecord token for the room, file output under the opaque path; lists and stops", async () => {
    let n = 0;
    const fake = new EgressTwirpFake({
      StartTrackEgress: (b) => ({ status: 200, body: { egressId: `EG_synthEgress${++n}`, roomName: b.roomName, status: "EGRESS_STARTING", track: { roomName: b.roomName, trackId: b.trackId, file: b.file } } }),
      ListEgress: () => ({
        status: 200,
        body: {
          items: [
            { egressId: "EG_synthEgress1", status: "EGRESS_ACTIVE", track: { trackId: "TR_a", file: { filepath: "calls/int_x/cbd_y/caller-{time}.ogg" } } },
            { egressId: "EG_synthEgress2", status: "EGRESS_COMPLETE" },
            // A recorder with its own upload target (anyone holding a roomRecord grant can ask for one): never the call's own.
            { egressId: "EG_synthExfil01", status: "EGRESS_ACTIVE", track: { trackId: "TR_a", file: { filepath: "calls/int_x/exfil-{time}.ogg", s3: { bucket: "synth-elsewhere", region: "us-east-1" } } } },
          ],
        },
      }),
      StopEgress: (b) => ({ status: 200, body: { egressId: b.egressId, status: "EGRESS_ENDING" } }),
    });
    const rec = recorderOver(fake);
    const ids = await rec.start({ roomName: "call-synth-room", pathPrefix: "calls/int_synthInteraction0001/cbd_synthBinding00000001", tracks: { caller: "TR_a", runtime: "TR_b" } });
    expect(ids).toEqual(["EG_synthEgress1", "EG_synthEgress2"]);
    expect(fake.seen[0]).toMatchObject({ method: "StartTrackEgress", grants: { roomRecord: true, room: "call-synth-room" }, sideEffect: true });
    expect(fake.seen[0]?.body).toMatchObject({ roomName: "call-synth-room", trackId: "TR_a", file: { filepath: "calls/int_synthInteraction0001/cbd_synthBinding00000001/caller-{time}.ogg", disableManifest: true } });
    expect(JSON.stringify(fake.seen.map((x) => x.body))).not.toMatch(/s3|secret|accessKey/i);
    const seen = await rec.observe("call-synth-room");
    expect(seen).toEqual([
      { egressId: "EG_synthEgress1", trackId: "TR_a", filepath: "calls/int_x/cbd_y/caller-{time}.ogg", running: true, status: "EGRESS_ACTIVE", defaultStorage: true },
      { egressId: "EG_synthEgress2", trackId: null, filepath: null, running: false, status: "EGRESS_COMPLETE", defaultStorage: false },
      { egressId: "EG_synthExfil01", trackId: "TR_a", filepath: "calls/int_x/exfil-{time}.ogg", running: true, status: "EGRESS_ACTIVE", defaultStorage: false },
    ]);
    expect(fake.seen.at(-1)?.sideEffect).toBe(false);
    await rec.stop("call-synth-room", "EG_synthEgress1");
    expect(fake.seen.at(-1)).toMatchObject({ method: "StopEgress", body: { egressId: "EG_synthEgress1" } });
  });

  it("failure injection: a refused second start stops the first; an already-ended egress stop is not an error; an unsafe path is refused", async () => {
    let n = 0;
    const fake = new EgressTwirpFake({
      StartTrackEgress: () => (++n === 1 ? { status: 200, body: { egressId: "EG_synthEgress1", status: "EGRESS_STARTING" } } : { status: 503, body: { code: "unavailable" } }),
      StopEgress: () => ({ status: 412, body: { code: "failed_precondition" } }),
    });
    const rec = recorderOver(fake);
    const err = await rec.start({ roomName: "r", pathPrefix: "calls/int_a/cbd_b", tracks: { caller: "TR_a", runtime: "TR_b" } }).then(() => null, (e: RecorderError) => e);
    expect(err?.reasonCode).toBe("RECORDER_UNAVAILABLE");
    expect(fake.seen.map((x) => x.method)).toEqual(["StartTrackEgress", "StartTrackEgress", "StopEgress"]);
    await expect(rec.stop("r", "EG_synthEgress1")).resolves.toBeUndefined();
    await expect(rec.start({ roomName: "r", pathPrefix: "calls/../etc", tracks: { caller: "TR_a" } })).rejects.toMatchObject({ reasonCode: "RECORDER_PATH_INVALID" });
    expect(() => new LiveKitEgressRecorder({ apiUrl: "http://livekit.vsp.test", transport: fake, credentials: async () => ({ apiKey: KEY, apiSecret: SECRET }), addressClass: "PRIVATE_NETWORK" })).toThrow();
  });
});
