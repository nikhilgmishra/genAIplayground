/**
 * Layer 2 (WP-11; FO-03-44, FO-10-46; DATA-03, SAFE-02; FAULT:RECORDING_REFUSED injection point): consent-driven
 * recording on the media path, checked against what the LiveKit egress service and MinIO actually hold, not only
 * against the platform's own record.
 *
 *   - UNKNOWN consent: nothing records (the egress API lists nothing for the room);
 *   - consent GRANTED: the worker starts TrackEgress for the call's parties; the egress API lists them running and
 *     the files land in the egress service's bucket under the opaque interaction path;
 *   - the caller presses the decline key (RFC 4733 DTMF from the WebRTC caller): the egress stops (the egress API
 *     reports it ended), the readout shows recording and transcription off, the gateway holds the decline;
 *   - a recorder nobody consented to (a foreign egress on the caller's track) next to the worker's own consented one is
 *     a mismatch: the readout flags it, the gateway records it, the worker requests a person (the HandoffService gets
 *     POLICY_REQUIRES_HUMAN for the call's interaction), its own egress ends (egress API) and its phase is HUMAN_ROUTED;
 *   - with recording disabled for the worker, a foreign egress is still seen (observe-only egress client) and routed
 *     the same way: the call is never reported unrecorded while a recorder runs;
 *   - the RECORDING_REFUSED seam armed for a job declines at call start through the same path: nothing ever records;
 *   - recovery adopts only the call's own recorders: the worker host crashes while it records, and during the crash a
 *     recorder is started on the caller's track under the call's own path (as anyone holding the media-plane secret or
 *     a roomRecord grant can, reading the interaction from the runtime's published readout). The re-dispatched
 *     replacement adopts the recorder the gateway names for the crashed binding (its log reports the adoption),
 *     refuses to adopt the other one (FOREIGN_RECORDER_ACTIVE in its readout and at the gateway) and requests a person
 *     (verifier r2 finding D3);
 *   - a replacement refused into a person route still settles the call's recorders (verifier r3 finding F4): the
 *     owner crashes after the caller's declines reached the gateway but before its stop reached the egress service;
 *     the replacement is refused BINDING_CONSENT_REQUIRES_PERSON, stops the owner's named recorder (egress API), flags
 *     the recorder that is not the call's to the gateway (recorded and audited) without stopping it, and is with the
 *     person.
 * Egress runs as a throwaway livekit/egress container (support.ts startEgress); not emulated: carrier recordings,
 * S3 Object Lock retention of recordings, KMS encryption of the recording bucket.
 */
import { CreateBucketCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { dispose } from "@livekit/rtc-node";
import { EgressClient, EgressStatus, TrackType } from "livekit-server-sdk";
import { afterAll, afterEach, beforeAll, describe, expect } from "vitest";
import { s3Client, uniqueName } from "../_harness/clients.js";
import { localEnv } from "../_harness/env.js";
import { layer2, layer2Context } from "../_harness/layer2.js";
import { MEDIA_SERVICES, WorkerProcess, agentIn, dispatchClient, healthOf, joinCaller, readoutOf, roomService, startEgress, startMediaStack, until } from "./support.js";
import type { EgressService, MediaStack, SyntheticCaller } from "./support.js";

const SERVICES = [...MEDIA_SERVICES, "minio"] as const;
const it = layer2(SERVICES);
const AGENT = uniqueName("vsp-media-rec");
/** A second worker of the same deployment with recording disabled (observe-only egress client). */
const AGENT_NOREC = uniqueName("vsp-media-norec");
const RUNNING = new Set([EgressStatus.EGRESS_STARTING, EgressStatus.EGRESS_ACTIVE, EgressStatus.EGRESS_ENDING]);

let stack: MediaStack;
let worker: WorkerProcess;
let workerNoRec: WorkerProcess;
let workerReplacement: WorkerProcess | null = null;
/** The owner and the replacement of the refused-replacement case (their own agent name, so no other call reaches them). */
let settleOwner: WorkerProcess | null = null;
let settleReplacement: WorkerProcess | null = null;
let egress: EgressService;
const callers: SyntheticCaller[] = [];
const rooms: string[] = [];

const egressApi = () => new EgressClient(stack.l2.url("livekit", 7880), localEnv().livekitApiKey, localEnv().livekitApiSecret);
/** How many of the call's named recorders a worker reported adopting after an owner loss (its content-free log). */
const adoptedCounts = (output: string): number[] =>
  output
    .split("\n")
    .filter((l) => l.includes('"event":"media.recording.adopted"'))
    .map((l) => Number((JSON.parse(l) as { count?: number }).count ?? -1));
const runningEgress = async (room: string) => (await egressApi().listEgress({ roomName: room })).filter((e) => RUNNING.has(e.status));

async function newCall(metadata?: string, agentName = AGENT) {
  const room = uniqueName("vsp-it-rec-room");
  rooms.push(room);
  await roomService(stack.l2).createRoom({ name: room, emptyTimeout: 300, departureTimeout: 5 });
  await dispatchClient(stack.l2).createDispatch(room, agentName, metadata ? { metadata } : undefined);
  const caller = await joinCaller(stack.l2, room);
  callers.push(caller);
  await until("agent participant", () => agentIn(stack.l2, room), 60_000);
  const bound = await until("binding", () => stack.bindingOf(room), 60_000);
  return { room, caller, bound };
}

beforeAll(async () => {
  const l2 = layer2Context(SERVICES);
  stack = await startMediaStack(l2);
  const bucket = uniqueName("vsp-it-recordings");
  const s3 = s3Client(l2);
  await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  s3.destroy();
  egress = await startEgress(l2, bucket);
  // Every call of this suite stays open until the end (up to four on this worker at once): eight call slots keep the
  // worker's reported load low enough for livekit-server to keep offering it jobs.
  worker = new WorkerProcess(stack.workerEnv({ agentName: AGENT, recording: true, faultSeams: true, instance: "media-worker-rec1", maxConcurrentCalls: 8 }));
  workerNoRec = new WorkerProcess(stack.workerEnv({ agentName: AGENT_NOREC, recording: false, instance: "media-worker-norec1" }));
  await Promise.all([worker.start(), workerNoRec.start()]);
}, 300_000);

afterEach(({ task }) => {
  if (task.result?.state === "fail") process.stderr.write(`--- media worker ---\n${worker?.output.slice(-6_000)}\n--- media worker (recording disabled) ---\n${workerNoRec?.output.slice(-3_000)}\n--- replacement media worker ---\n${workerReplacement?.output.slice(-4_000) ?? ""}\n--- refused-replacement case: owner ---\n${settleOwner?.output.slice(-3_000) ?? ""}\n--- refused-replacement case: replacement ---\n${settleReplacement?.output.slice(-4_000) ?? ""}\n--- egress ---\n${egress?.logs().slice(-4_000)}\n--- gateway (warn/error) ---\n${stack?.gatewayEvents().slice(-25).join("\n") ?? ""}\n`);
});

afterAll(async () => {
  for (const c of callers) await c.stop();
  await worker?.stop();
  await workerNoRec?.stop();
  await workerReplacement?.stop();
  await settleOwner?.stop();
  await settleReplacement?.stop();
  for (const r of rooms) {
    for (const e of await runningEgress(r).catch(() => [])) await egressApi().stopEgress(e.egressId).catch(() => undefined);
    await roomService(stack.l2).deleteRoom(r).catch(() => undefined);
  }
  egress?.remove();
  await stack?.close();
  await dispose();
}, 180_000);

describe("recording follows consent on the media path [DATA-03][FO-03-44]", () => {
  it("[DATA-03][FO-03-44][FAULT:RECORDING_REFUSED] UNKNOWN records nothing; GRANTED records; the caller's decline key stops the egress and the readout shows recording and transcription off", async ({ l2 }) => {
    const { room, caller, bound } = await newCall();
    // UNKNOWN is not consent: no egress for the room, the readout says OFF.
    await until("first readout", async () => readoutOf(await agentIn(l2, room)));
    expect(readoutOf(await agentIn(l2, room))).toMatchObject({ recording: { phase: "OFF", active: false }, consent: { recording: { value: "UNKNOWN" } } });
    expect(await runningEgress(room)).toEqual([]);

    // The trusted consent capture records GRANTED; the next heartbeat carries it to the worker.
    await stack.grant(bound.claim);
    const on = await until("recording on", async () => {
      const r = readoutOf(await agentIn(l2, room));
      return r?.recording.phase === "ON" ? r : null;
    }, 60_000);
    expect(on.recording.ref).toMatch(/^EG_/);
    // Independently of the worker: the egress API lists our recorders running, on audio tracks of this room.
    const running = await until("egress active", async () => {
      const list = (await runningEgress(room)).filter((e) => e.status === EgressStatus.EGRESS_ACTIVE);
      return list.some((e) => e.egressId === on.recording.ref) ? list : null;
    }, 60_000);
    expect(running.map((e) => e.egressId)).toContain(on.recording.ref);
    await new Promise((r) => setTimeout(r, 3_000)); // a few seconds of the call recorded

    // The caller declines with the menu's decline key (DTMF 8 from the caller's own participant).
    await caller.room.localParticipant?.publishDtmf(8, "8");
    const off = await until("recording off", async () => {
      const r = readoutOf(await agentIn(l2, room));
      return r && r.recording.phase === "OFF" && !r.recording.active ? r : null;
    }, 60_000);
    expect(off).toMatchObject({ recording: { phase: "OFF", active: false }, transcription: { phase: "OFF", active: false }, analysis: { phase: "OFF" }, consent: { recording: { value: "DECLINED" } }, mismatch: null });
    // The egress API agrees: nothing of the room is running any more; ours ended.
    expect(await runningEgress(room)).toEqual([]);
    const ended = (await egressApi().listEgress({ roomName: room })).find((e) => e.egressId === on.recording.ref);
    expect([EgressStatus.EGRESS_COMPLETE, EgressStatus.EGRESS_ABORTED]).toContain(ended?.status);
    // The gateway holds the decline (it outranks the stored grant) and the consent version advanced.
    const after = await stack.bindingOf(room);
    expect(after?.recordingDeclined).toBe(true);
    expect(after?.consentVersion).toBeGreaterThan(1);
    // A completed recorder uploaded what it recorded before the decline, under the opaque interaction path (never the
    // room name). An aborted one (the egress service gave up before it finalized a file, which it reports itself)
    // uploads nothing, so the bucket must then hold nothing for the call under any other path either.
    const s3 = s3Client(l2);
    const list = async () => {
      const r = await s3.send(new ListObjectsV2Command({ Bucket: egress.bucket }));
      return r.Contents ?? [];
    };
    if (ended?.status === EgressStatus.EGRESS_COMPLETE) {
      const objects = await until("recording files", async () => {
        const r = await s3.send(new ListObjectsV2Command({ Bucket: egress.bucket, Prefix: `calls/${bound.interactionId}/` }));
        return (r.Contents ?? []).length > 0 ? r.Contents : null;
      }, 60_000);
      expect(objects?.every((o) => !String(o.Key).includes(room))).toBe(true);
    }
    expect((await list()).filter((o) => String(o.Key).includes(room))).toEqual([]);
    s3.destroy();
    // A later grant never restarts it (the decline is sticky for the call).
    await stack.grant(after!.claim);
    await new Promise((r) => setTimeout(r, 7_000));
    expect(await runningEgress(room)).toEqual([]);
  }, 240_000);

  it("[DATA-03][SAFE-02] adversarial: a recorder nobody consented to next to the call's own consented recorder is a mismatch: flagged in the readout and at the gateway; the worker requests a person, its own egress ends and it is HUMAN_ROUTED", async ({ l2 }) => {
    const { room, caller, bound } = await newCall();
    await until("first readout", async () => readoutOf(await agentIn(l2, room)));
    // Consent granted: the worker's own recorders run (independently listed by the egress API).
    await stack.grant(bound.claim);
    const on = await until("recording on", async () => {
      const r = readoutOf(await agentIn(l2, room));
      return r?.recording.phase === "ON" ? r : null;
    }, 60_000);
    const own = await until("own egress active", async () => {
      const list = (await runningEgress(room)).filter((e) => e.status === EgressStatus.EGRESS_ACTIVE);
      return list.some((e) => e.egressId === on.recording.ref) ? list.map((e) => e.egressId) : null;
    }, 60_000);
    expect(own).toContain(on.recording.ref);
    const routesBefore = stack.humanRoutes.length;
    const callerInfo = (await roomService(l2).listParticipants(room)).find((p) => p.identity === caller.identity);
    const track = callerInfo?.tracks.find((t) => t.type === TrackType.AUDIO);
    expect(track?.sid).toBeTruthy();
    const foreign = await egressApi().startTrackEgress(room, { filepath: "foreign/{room_name}-{time}.ogg" } as never, track!.sid);
    try {
      const flagged = await until("mismatch", async () => {
        const r = readoutOf(await agentIn(l2, room));
        return r?.mismatch ? r : null;
      }, 60_000);
      expect(flagged.mismatch).toBe("FOREIGN_RECORDER_ACTIVE");
      // The person was requested for the call's interaction, for the mismatch (POLICY_REQUIRES_HUMAN at the handoff).
      const route = await until("human route requested", async () => stack.humanRoutes.slice(routesBefore).find((h) => h.callId === bound.interactionId) ?? null, 60_000);
      expect(route.reason).toBe("POLICY_REQUIRES_HUMAN");
      await until("human route audited", async () => stack.audits.some((a) => a.action === "media.route.human_requested" && a.interactionId === bound.interactionId && a.reasonCode === "PROCESSING_MISMATCH"), 30_000);
      // The worker is with a person now, and its own processing is suspended: its egress ended (egress API).
      await until("runtime HUMAN_ROUTED", async () => healthOf(await agentIn(l2, room))?.phase === "HUMAN_ROUTED", 30_000);
      await until("own egress ended", async () => {
        const list = await egressApi().listEgress({ roomName: room });
        return own.every((id) => [EgressStatus.EGRESS_COMPLETE, EgressStatus.EGRESS_ABORTED].includes(list.find((e) => e.egressId === id)?.status as EgressStatus)) ? true : null;
      }, 60_000);
      // The readout follows the egress API: OFF once ours ended (STOPPING, never "unrecorded", while it drained).
      const off = await until("readout recording off", async () => {
        const r = readoutOf(await agentIn(l2, room));
        return r?.recording.phase === "OFF" ? r : null;
      }, 30_000);
      expect(off).toMatchObject({ recording: { phase: "OFF", active: false }, transcription: { phase: "OFF" }, mismatch: "FOREIGN_RECORDER_ACTIVE" });
      const rec = await until("gateway mismatch record", async () => {
        const b = await stack.bindingOf(room);
        return b?.lastMismatch ? b : null;
      }, 30_000);
      expect(rec.lastMismatch).toBe("FOREIGN_RECORDER_ACTIVE");
    } finally {
      await egressApi().stopEgress(foreign.egressId).catch(() => undefined);
    }
  }, 240_000);

  it("[DATA-03][SAFE-02] adversarial: with recording disabled for the worker, a recorder on the caller's track is still seen (observe-only egress client): mismatch in the readout and at the gateway, a person requested; never 'unrecorded'", async ({ l2 }) => {
    const { room, caller, bound } = await newCall(undefined, AGENT_NOREC);
    const first = await until("first readout", async () => readoutOf(await agentIn(l2, room)));
    expect(first).toMatchObject({ recording: { phase: "OFF" }, mismatch: null });
    const routesBefore = stack.humanRoutes.length;
    const track = (await roomService(l2).listParticipants(room)).find((p) => p.identity === caller.identity)?.tracks.find((t) => t.type === TrackType.AUDIO);
    const foreign = await egressApi().startTrackEgress(room, { filepath: "foreign/{time}.ogg" } as never, track!.sid);
    try {
      await until("egress active", async () => ((await runningEgress(room)).some((e) => e.egressId === foreign.egressId && e.status === EgressStatus.EGRESS_ACTIVE) ? true : null), 60_000);
      const flagged = await until("mismatch", async () => {
        const r = readoutOf(await agentIn(l2, room));
        return r?.mismatch ? r : null;
      }, 60_000);
      expect(flagged).toMatchObject({ mismatch: "FOREIGN_RECORDER_ACTIVE", recording: { phase: "OFF" } });
      const rec = await until("gateway mismatch record", async () => {
        const b = await stack.bindingOf(room);
        return b?.lastMismatch ? b : null;
      }, 30_000);
      expect(rec.lastMismatch).toBe("FOREIGN_RECORDER_ACTIVE");
      const route = await until("human route requested", async () => stack.humanRoutes.slice(routesBefore).find((h) => h.callId === bound.interactionId) ?? null, 60_000);
      expect(route.reason).toBe("POLICY_REQUIRES_HUMAN");
      await until("runtime HUMAN_ROUTED", async () => healthOf(await agentIn(l2, room))?.phase === "HUMAN_ROUTED", 30_000);
      // Observe-only: the worker never stopped (or started) anything; the foreign egress is still the egress API's.
      expect((await runningEgress(room)).map((e) => e.egressId)).toContain(foreign.egressId);
    } finally {
      await egressApi().stopEgress(foreign.egressId).catch(() => undefined);
    }
  }, 240_000);

  it("[FAULT:RECORDING_REFUSED][DATA-03] the seam armed for the job declines recording at call start through the production path: audited at the gateway, nothing ever records", async ({ l2 }) => {
    const { room, bound } = await newCall(JSON.stringify({ vspFault: "RECORDING_REFUSED" }));
    const declined = await until("decline recorded at the gateway", async () => {
      const b = await stack.bindingOf(room);
      return b?.recordingDeclined ? b : null;
    }, 60_000);
    expect(declined.generation).toBe(bound.generation);
    await stack.grant(declined.claim);
    await new Promise((r) => setTimeout(r, 7_000));
    expect(await runningEgress(room)).toEqual([]);
    expect((await egressApi().listEgress({ roomName: room })).length).toBe(0);
    expect(readoutOf(await agentIn(l2, room))).toMatchObject({ recording: { phase: "OFF" }, consent: { recording: { value: "DECLINED" } } });
  }, 240_000);
  it("[DATA-03][SAFE-02][FO-10-46] adversarial: the worker host crashes while recording and a recorder is started on the caller's track under the call's own path; the replacement adopts only the call's recorder the gateway names, flags FOREIGN_RECORDER_ACTIVE and requests a person", async ({ l2 }) => {
    const { room, caller, bound } = await newCall();
    await until("first readout", async () => readoutOf(await agentIn(l2, room)));
    await stack.grant(bound.claim);
    const on = await until("recording on", async () => {
      const r = readoutOf(await agentIn(l2, room));
      return r?.recording.phase === "ON" && r.recorderRefs.length > 0 ? r : null;
    }, 60_000);
    // The gateway keeps the recorders the owner reported (every reconciliation tick reports them).
    await until("recorders kept at the gateway", async () => {
      const rec = await stack.store.load(stack.tenantId, bound.interactionId);
      return on.recorderRefs.every((id) => rec?.data.recorders.some((r) => r.egressId === id)) ? true : null;
    }, 30_000);
    const oldAgent = await until("agent participant", () => agentIn(l2, room));
    workerReplacement = new WorkerProcess(stack.workerEnv({ agentName: AGENT, recording: true, instance: "media-worker-rec2", maxConcurrentCalls: 8 }));
    await workerReplacement.start();
    worker.crash();
    await until("crashed runtime gone from the room", async () => ((await agentIn(l2, room)) === null ? true : null), 90_000, 500);
    // What any participant reads from the runtime's published readout: the call's interaction (its recorder path).
    const callerTrack = (await roomService(l2).listParticipants(room)).find((p) => p.identity === caller.identity)?.tracks.find((t) => t.type === TrackType.AUDIO);
    const foreign = await egressApi().startTrackEgress(room, { filepath: `calls/${on.interactionId}/exfil-{time}.ogg` } as never, callerTrack!.sid);
    try {
      await until("foreign egress active", async () => ((await runningEgress(room)).some((e) => e.egressId === foreign.egressId && e.status === EgressStatus.EGRESS_ACTIVE) ? true : null), 60_000);
      const routesBefore = stack.humanRoutes.length;
      const supervisor = stack.supervisor(AGENT, { redispatchGraceMs: 5_000, humanAfterMs: 150_000 });
      const rebound = await until("re-bound by the replacement", async () => {
        await supervisor.sweep();
        const b = await stack.bindingOf(room);
        return b && b.generation > bound.generation ? b : null;
      }, 150_000, 1_000);
      expect(rebound.claim.fencingToken).toBeGreaterThan(bound.claim.fencingToken);
      const flagged = await until("replacement flags the foreign recorder", async () => {
        const r = readoutOf(await agentIn(l2, room, oldAgent.identity));
        return r?.mismatch ? r : null;
      }, 60_000);
      expect(flagged.mismatch).toBe("FOREIGN_RECORDER_ACTIVE");
      // The call's own recorder (the crashed owner's, on the caller's track, still running) was adopted.
      expect(adoptedCounts(workerReplacement.output).some((n) => n >= 1)).toBe(true);
      // The foreign recorder was never adopted as the call's own; nothing new was started for the call.
      expect(flagged.recorderRefs).not.toContain(foreign.egressId);
      expect(flagged.recording.ref).not.toBe(foreign.egressId);
      // Independently of the worker: the egress API lists no recorder for the room but the crashed owner's and the foreign one.
      const all = (await egressApi().listEgress({ roomName: room })).map((e) => e.egressId);
      expect(all.filter((id) => id !== foreign.egressId && !on.recorderRefs.includes(id))).toEqual([]);
      const route = await until("human route requested", async () => stack.humanRoutes.slice(routesBefore).find((h) => h.callId === bound.interactionId) ?? null, 60_000);
      expect(route.reason).toBe("POLICY_REQUIRES_HUMAN");
      await until("replacement HUMAN_ROUTED", async () => healthOf(await agentIn(l2, room, oldAgent.identity))?.phase === "HUMAN_ROUTED", 30_000);
      const rec = await until("gateway mismatch record", async () => {
        const b = await stack.bindingOf(room);
        return b?.lastMismatch ? b : null;
      }, 30_000);
      expect(rec.lastMismatch).toBe("FOREIGN_RECORDER_ACTIVE");
    } finally {
      await egressApi().stopEgress(foreign.egressId).catch(() => undefined);
    }
  }, 360_000);

  it("[DATA-03][FO-10-46][T-FO-11-03] adversarial: the owner crashes after the caller declined recording and AI processing, before its stop reached the egress service; the replacement is refused BINDING_CONSENT_REQUIRES_PERSON and, while it routes the person, stops the owner's named recorder and flags (never stops) a recorder that is not the call's", async ({ l2 }) => {
    const agent = uniqueName("vsp-media-settle");
    settleOwner = new WorkerProcess(stack.workerEnv({ agentName: agent, recording: true, instance: "media-worker-settle1" }));
    await settleOwner.start();
    const { room, caller, bound } = await newCall(undefined, agent);
    await until("first readout", async () => readoutOf(await agentIn(l2, room)));
    await stack.grant(bound.claim);
    const on = await until("recording on", async () => {
      const r = readoutOf(await agentIn(l2, room));
      return r?.recording.phase === "ON" && r.recorderRefs.length > 0 ? r : null;
    }, 60_000);
    await until("recorders kept at the gateway", async () => {
      const rec = await stack.store.load(stack.tenantId, bound.interactionId);
      return on.recorderRefs.every((id) => rec?.data.recorders.some((r) => r.egressId === id)) ? true : null;
    }, 30_000);
    const oldAgent = await until("agent participant", () => agentIn(l2, room));
    // The owner's host dies; the caller's declines had reached the gateway (within the binding's lifetime), its stops
    // never reached the egress service.
    const claim = (await stack.bindingOf(room))!.claim;
    settleOwner.crash();
    await stack.decline(claim, "recording");
    await stack.decline(claim, "transcriptionAiProcessing");
    await until("crashed runtime gone from the room", async () => ((await agentIn(l2, room)) === null ? true : null), 90_000, 500);
    // The owner's recorder of the caller's track keeps recording the caller (who is still in the room).
    const leftRunning = await until("owner's recorder still running", async () => {
      const ids = (await runningEgress(room)).map((e) => e.egressId).filter((id) => on.recorderRefs.includes(id));
      return ids.length > 0 ? ids : null;
    }, 30_000);
    const callerTrack = (await roomService(l2).listParticipants(room)).find((p) => p.identity === caller.identity)?.tracks.find((t) => t.type === TrackType.AUDIO);
    const foreign = await egressApi().startTrackEgress(room, { filepath: `calls/${on.interactionId}/exfil-{time}.ogg` } as never, callerTrack!.sid);
    try {
      await until("foreign egress active", async () => ((await runningEgress(room)).some((e) => e.egressId === foreign.egressId && e.status === EgressStatus.EGRESS_ACTIVE) ? true : null), 60_000);
      settleReplacement = new WorkerProcess(stack.workerEnv({ agentName: agent, recording: true, instance: "media-worker-settle2" }));
      await settleReplacement.start();
      const routesBefore = stack.humanRoutes.length;
      const supervisor = stack.supervisor(agent, { redispatchGraceMs: 5_000, humanAfterMs: 150_000 });
      await until("replacement refused into a person route", async () => {
        await supervisor.sweep();
        return /BINDING_CONSENT_REQUIRES_PERSON/.test(settleReplacement?.output ?? "") ? true : null;
      }, 150_000, 1_000);
      // The egress API itself: the owner's named recorders end; the other one keeps running (it is not the call's).
      await until("owner's recorders stopped", async () => {
        const list = await egressApi().listEgress({ roomName: room });
        return leftRunning.every((id) => !RUNNING.has(list.find((e) => e.egressId === id)?.status as EgressStatus)) ? true : null;
      }, 60_000);
      expect((await runningEgress(room)).map((e) => e.egressId)).toContain(foreign.egressId);
      // Nothing new was started for the call.
      expect((await egressApi().listEgress({ roomName: room })).map((e) => e.egressId).filter((id) => id !== foreign.egressId && !on.recorderRefs.includes(id))).toEqual([]);
      // The flag reached the gateway: recorded for the call and audited, though no binding was issued to the replacement.
      const rec = await until("gateway mismatch record", async () => {
        const b = await stack.bindingOf(room);
        return b?.lastMismatch ? b : null;
      }, 60_000);
      expect(rec.lastMismatch).toBe("FOREIGN_RECORDER_ACTIVE");
      expect(rec.claim.bindingId).toBe(claim.bindingId);
      expect(rec.generation).toBe(claim.sessionGeneration);
      // The gateway writes the audit event after the record (best effort, never blocking the answer): wait for it.
      await until("mismatch audited", async () => (stack.audits.some((a) => a.action === "media.processing.mismatch" && a.interactionId === bound.interactionId && a.reasonCode === "FOREIGN_RECORDER_ACTIVE" && a.bindingId === null) ? true : null), 30_000);
      // The person was requested for the call, with the consent alternative as the reason; the replacement is with the person.
      const route = await until("human route requested", async () => stack.humanRoutes.slice(routesBefore).find((h) => h.callId === bound.interactionId) ?? null, 60_000);
      expect(route.reason).toBe("CONSENT_DECLINED_ALTERNATIVE");
      await until("replacement HUMAN_ROUTED", async () => healthOf(await agentIn(l2, room, oldAgent.identity))?.phase === "HUMAN_ROUTED", 30_000);
    } finally {
      await egressApi().stopEgress(foreign.egressId).catch(() => undefined);
    }
  }, 420_000);
});
