/**
 * Layer 2 (WP-11; FO-10-01, FO-03-17, FO-03-18, FO-05-16, FO-19-10, FO-22-16; AUTH-03, SAFE-02): the production
 * media worker process against livekit-server, the live gateway composition and Keycloak (support.ts).
 *
 *   - the worker registers with livekit-server as an Agents worker and receives the explicitly dispatched room job;
 *   - a synthetic WebRTC caller joins: audio flows both ways (the caller's tone reaches the runtime, the runtime's
 *     output track reaches the caller), and the job holds a CallBinding issued by the gateway for the carrier
 *     interaction (bound to the session generation);
 *   - the worker host crashes (SIGKILL to the worker and its job processes); livekit-server does not move the job
 *     (deploy/local/README.md fidelity finding), so the platform's media-plane supervisor re-dispatches the room and
 *     the replacement worker re-binds the call with a NEW session generation and fencing token; the crashed owner's
 *     claim is refused at the gateway [AUTH-03];
 *   - the human and safety routes answer while no worker holds a live binding [SAFE-02].
 * Not emulated: carrier SIP trunks, PSTN codecs, TURN, real network loss (io.vsp.not-emulated of livekit).
 */
import { afterAll, afterEach, beforeAll, describe, expect } from "vitest";
import { dispose } from "@livekit/rtc-node";
import { uniqueName } from "../_harness/clients.js";
import { layer2, layer2Context } from "../_harness/layer2.js";
import { MEDIA_SERVICES, WorkerProcess, agentIn, dispatchClient, healthOf, joinCaller, readoutOf, roomService, startMediaStack, until } from "./support.js";
import type { MediaStack, SyntheticCaller } from "./support.js";

const it = layer2(MEDIA_SERVICES);
const AGENT = uniqueName("vsp-media-it");

let stack: MediaStack;
let workerA: WorkerProcess;
let workerB: WorkerProcess | null = null;
let caller: SyntheticCaller | null = null;
const room = uniqueName("vsp-it-media-room");

beforeAll(async () => {
  stack = await startMediaStack(layer2Context(MEDIA_SERVICES));
  workerA = new WorkerProcess(stack.workerEnv({ agentName: AGENT, recording: false, instance: "media-worker-a1" }));
  await workerA.start();
}, 240_000);

// Diagnostics for a failed run: the workers' content-free logs (the platform's redacting logger, framework warnings).
afterEach(({ task }) => {
  if (task.result?.state === "fail") process.stderr.write(`--- media worker A ---\n${workerA?.output.slice(-6_000)}\n--- media worker B ---\n${workerB?.output.slice(-6_000) ?? ""}\n--- gateway (warn/error) ---\n${stack?.gatewayEvents().slice(-25).join("\n") ?? ""}\n`);
});

afterAll(async () => {
  await caller?.stop();
  await workerA?.stop();
  await workerB?.stop();
  await roomService(stack.l2).deleteRoom(room).catch(() => undefined);
  await stack?.close();
  await dispose();
}, 120_000);

describe("media worker on livekit-server [FO-10-01][FO-03-17][FO-05-16]", () => {
  it("[FO-10-01][FO-03-18] the worker registers as an Agents worker and receives the dispatched room job; audio flows both ways; the job holds a binding for the carrier interaction", async ({ l2 }) => {
    expect(workerA.workerId).toMatch(/^AW_/);
    await roomService(l2).createRoom({ name: room, emptyTimeout: 300, departureTimeout: 5 });
    const dispatch = await dispatchClient(l2).createDispatch(room, AGENT);
    caller = await joinCaller(l2, room);
    // The job lands on the registered worker: its agent participant joins the room.
    const agent = await until("agent participant", () => agentIn(l2, room), 60_000);
    const job = await until("dispatched job", async () => {
      const listed = await dispatchClient(l2).listDispatch(room);
      return listed.find((d) => d.id === dispatch.id)?.state?.jobs?.find((j) => j.state?.participantIdentity === agent.identity) ?? null;
    }, 30_000);
    expect(job.id).toMatch(/^AJ_/);
    // The runtime bound the call: the gateway's record names the room's interaction and generation 1.
    const bound = await until("binding", () => stack.bindingOf(room), 60_000);
    expect(bound.generation).toBe(1);
    // Caller -> runtime: the tone reached the runtime's inbound path (content-free health on its participant).
    const health = await until("inbound audio at the runtime", async () => {
      const h = healthOf(await agentIn(l2, room));
      return h && h.inboundFrames > 50 ? h : null;
    }, 30_000);
    expect(health.inboundPeakDbfs).toBeGreaterThanOrEqual(-20);
    expect(health.inboundPeakDbfs).toBeLessThanOrEqual(-10);
    expect(health.outboundFrames).toBeGreaterThan(50);
    // Runtime -> caller: the runtime's output track (idle comfort noise, never digital silence) reaches the caller.
    await until("audio from the runtime", async () => (caller && caller.received.frames > 50 && caller.received.peak > 0 ? true : null), 30_000);
    const rms = 20 * Math.log10(Math.sqrt(caller.received.sumSquares / caller.received.samples) / 32_768);
    expect(rms).toBeGreaterThan(-90);
    expect(rms).toBeLessThan(-40);
    // The readout the worker publishes: bound to the same binding, nothing recorded or tapped (consent UNKNOWN).
    const readout = await until("processing readout", async () => readoutOf(await agentIn(l2, room)), 30_000);
    expect(readout).toMatchObject({ bindingId: bound.claim.bindingId, sessionGeneration: 1, recording: { phase: "OFF", active: false }, transcription: { phase: "OFF" }, consent: { recording: { value: "UNKNOWN" } }, mismatch: null });
  }, 240_000);

  it("[FO-19-10][FO-22-16][AUTH-03] a crashed worker host: the supervisor re-dispatches the room to the replacement worker, which re-binds with a new generation; the crashed owner's claim is refused at the gateway", async ({ l2 }) => {
    const before = await until("binding", () => stack.bindingOf(room));
    const oldAgent = await until("agent participant", () => agentIn(l2, room));
    workerB = new WorkerProcess(stack.workerEnv({ agentName: AGENT, recording: false, instance: "media-worker-b1" }));
    await workerB.start();
    workerA.crash();
    // livekit-server does not move the dead worker's job (fidelity note in deploy/local/livekit/README.md): the
    // platform's media-plane supervisor sees the caller without a runtime and dispatches the room again.
    const supervisor = stack.supervisor(AGENT, { redispatchGraceMs: 5_000, humanAfterMs: 150_000 });
    const outcomes = new Set<string>();
    const after = await until(
      "re-bound binding",
      async () => {
        for (const r of await supervisor.sweep()) if (r.roomName === room) outcomes.add(r.outcome);
        const b = await stack.bindingOf(room);
        return b && b.generation > before.generation && b.claim.bindingId !== before.claim.bindingId ? b : null;
      },
      150_000,
      1_000,
    );
    expect(outcomes.has("REDISPATCHED")).toBe(true);
    expect(after.claim.fencingToken).toBeGreaterThan(before.claim.fencingToken);
    const newAgent = await until("replacement agent", () => agentIn(l2, room, oldAgent.identity), 60_000);
    expect(newAgent.identity).not.toBe(oldAgent.identity);
    // The stale owner's claim (old binding, old generation and fencing token) is refused, with the runtime's own valid credential.
    const token = await stack.runtimeToken();
    const stale = await stack.post(`/media/v1/calls/bindings/${before.claim.bindingId}/heartbeat`, { claim: before.claim }, token);
    expect(stale.status).toBe(409);
    expect(String((stale.json.error as { reasonCode?: string } | undefined)?.reasonCode)).toMatch(/^BINDING_(SUPERSEDED|GENERATION_STALE|FENCING_TOKEN_STALE)$/);
    const forged = await stack.post(`/media/v1/calls/bindings/${after.claim.bindingId}/heartbeat`, { claim: { ...after.claim, fencingToken: before.claim.fencingToken } }, token);
    expect(forged.status).toBe(409);
    // The replacement's readout follows the new generation.
    await until("readout on the new generation", async () => readoutOf(await agentIn(l2, room, oldAgent.identity))?.sessionGeneration === after.generation, 30_000);
  }, 300_000);

  it("[AUTH-03] adversarial: the media routes refuse a missing credential, a malformed token, a real Keycloak token of another client and one without the runtime scope, before any body is read", async () => {
    const b = await stack.bindingOf(room);
    const heartbeat = (token?: string) => stack.post(`/media/v1/calls/bindings/${b?.claim.bindingId}/heartbeat`, { claim: b?.claim }, token);
    expect((await heartbeat()).status).toBe(401);
    expect((await stack.post("/media/v1/calls/bindings", { roomName: room }, "not-a-jwt")).status).toBe(401);
    // Another client of the same realm with the runtime scope and the gateway audience: not a runtime client.
    const foreign = await heartbeat(await stack.tokenFor(stack.otherClients.foreign));
    expect(foreign.status).toBe(401);
    expect(foreign.json).toMatchObject({ error: { reasonCode: "RUNTIME_CLIENT_UNKNOWN" } });
    // A client the verifier knows, but whose token does not carry the runtime scope.
    const unscoped = await heartbeat(await stack.tokenFor(stack.otherClients.unscoped));
    expect(unscoped.status).toBe(403);
    expect(unscoped.json).toMatchObject({ error: { reasonCode: "RUNTIME_SCOPE_MISSING" } });
    // The human route is session-less but never credential-less.
    expect((await stack.post("/media/v1/calls/human-route", { roomName: room, reason: "BINDING_UNAVAILABLE", language: "en" }, await stack.tokenFor(stack.otherClients.foreign))).status).toBe(401);
    // Control: the runtime's own token is accepted (the claim is current).
    expect((await heartbeat(await stack.runtimeToken())).status).toBe(200);
  }, 240_000);

  it("[SAFE-02] with no worker holding a live binding, the human and safety routes still reach a person for the room; the supervisor routes an unrecovered call to a person", async ({ l2 }) => {
    await workerB?.stop();
    await until("no agent in the room", async () => ((await agentIn(l2, room)) ? null : true), 60_000);
    // No runtime comes back: past its deadline the supervisor routes the caller to a person, once.
    const supervisor = stack.supervisor(AGENT, { redispatchGraceMs: 1_000, humanAfterMs: 6_000 });
    const seen: string[] = [];
    await until("supervisor human route", async () => {
      for (const r of await supervisor.sweep()) if (r.roomName === room) seen.push(r.outcome);
      return seen.includes("HUMAN_ROUTED") ? true : null;
    }, 60_000, 1_000);
    expect(seen.filter((o) => o === "HUMAN_ROUTED")).toHaveLength(1);
    const token = await stack.runtimeToken();
    const human = await stack.post("/media/v1/calls/human-route", { roomName: room, reason: "BINDING_UNAVAILABLE", language: "en" }, token);
    expect(human.status).toBe(200);
    expect(human.json).toMatchObject({ accepted: true });
    expect(String(human.json.destinationId)).toMatch(/^dst_/);
    const safety = await stack.post("/media/v1/calls/safety-route", { roomName: room, signals: [{ source: "EXPLICIT_PHRASE", ruleId: "safety.self_harm.explicit", strength: "CREDIBLE", subject: "SELF", temporal: "CURRENT", negated: false }], locale: "en-US" }, token);
    expect(safety.status).toBe(200);
    expect(safety.json).toMatchObject({ accepted: true });
  }, 240_000);
});
