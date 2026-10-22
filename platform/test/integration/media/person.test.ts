/**
 * Layer 2 (WP-11; SAFE-02, FO-10-46, FO-10-09; verifier r2 security findings D1 and D2): a caller who asked for a person
 * is never handed back to the AI, against the production worker processes, livekit-server, the live gateway
 * composition with the production HandoffService, Keycloak and DynamoDB Local (support.ts).
 *
 *   - D1, a person who could not be requested: the caller presses 0 while the handoff store fails for the worker's
 *     whole human deadline; the worker leaves the room. The gateway recorded the request for the room before each
 *     attempt, so once the store recovers the supervisor routes the owed person (for the call's interaction, with the
 *     caller's reason) instead of re-dispatching the AI, and no new binding is issued;
 *   - D2, a call already with a person: the caller presses 0 and the person is accepted; the worker host crashes. The
 *     supervisor leaves the caller with the person (never re-dispatches the AI), and a job dispatched to the room
 *     anyway (a replacement worker) is refused BINDING_WITH_PERSON: it stays in the room silent and suspended (its
 *     phase HUMAN_ROUTED), with no new binding, no new generation and no second person.
 *   - F2 (verifier r3), a person requested for the room by another party while the AI owner holds the call: the
 *     session-less human route (as another runtime or the supervisor's deadline route would ask) gets the person
 *     accepted; the live owner learns it at its next gateway contact and goes silent and suspended (HUMAN_ROUTED), its
 *     binding can no longer be renewed (409 BINDING_WITH_PERSON), and the room has one handoff only;
 *   - F1 (verifier r3), the binding store cannot be read while a caller's runtime is gone: the supervisor, reading the
 *     room's person request through a binding service over a DynamoDB table it cannot read (the real DynamoDB protocol,
 *     KV_READ_FAILED as in an outage), never re-dispatches the AI on a guess, and routes the caller to a person once
 *     (through the production HandoffService) when the room has been orphaned past its deadline.
 * Failure injection (labelled): the production HandoffService's requestHuman is replaced by a throwing function for the
 * length of the worker's human deadline (the handoff store is down), then restored; the F1 case gives the supervisor a
 * binding store over a table that does not exist.
 */
import { dispose } from "@livekit/rtc-node";
import { afterAll, afterEach, beforeAll, describe, expect } from "vitest";
import { CallBindingStore } from "../../../src/calls/binding/store.js";
import { DynamoKvStore } from "../../../src/identity/kv/dynamo-kv-store.js";
import { dynamoClient, uniqueName } from "../_harness/clients.js";
import { layer2, layer2Context } from "../_harness/layer2.js";
import { MEDIA_SERVICES, WorkerProcess, agentIn, dispatchClient, healthOf, joinCaller, roomService, sleep, startMediaStack, until } from "./support.js";
import type { MediaStack, SyntheticCaller } from "./support.js";

const it = layer2(MEDIA_SERVICES);
const AGENT = uniqueName("vsp-media-person");

let stack: MediaStack;
let workerA: WorkerProcess;
let workerB: WorkerProcess | null = null;
const callers: SyntheticCaller[] = [];
const rooms: string[] = [];

beforeAll(async () => {
  stack = await startMediaStack(layer2Context(MEDIA_SERVICES));
  workerA = new WorkerProcess(stack.workerEnv({ agentName: AGENT, recording: false, instance: "media-worker-pa1" }));
  await workerA.start();
}, 240_000);

afterEach(({ task }) => {
  if (task.result?.state === "fail") process.stderr.write(`--- media worker A ---\n${workerA?.output.slice(-6_000)}\n--- media worker B ---\n${workerB?.output.slice(-6_000) ?? ""}\n--- gateway (warn/error) ---\n${stack?.gatewayEvents().slice(-25).join("\n") ?? ""}\n`);
});

afterAll(async () => {
  for (const c of callers) await c.stop();
  await workerA?.stop();
  await workerB?.stop();
  for (const r of rooms) await roomService(stack.l2).deleteRoom(r).catch(() => undefined);
  await stack?.close();
  await dispose();
}, 180_000);

async function newCall() {
  const room = uniqueName("vsp-it-person-room");
  rooms.push(room);
  await roomService(stack.l2).createRoom({ name: room, emptyTimeout: 300, departureTimeout: 5 });
  await dispatchClient(stack.l2).createDispatch(room, AGENT);
  const caller = await joinCaller(stack.l2, room);
  callers.push(caller);
  const agent = await until("agent participant", () => agentIn(stack.l2, room), 60_000);
  const bound = await until("binding", () => stack.bindingOf(room), 60_000);
  return { room, caller, agent, bound };
}

/** The production HandoffService of the composition (the stack's handoff observer calls it on every request). */
const handoffService = () => (stack.c as unknown as { business: { handoff: { requestHuman: (...a: unknown[]) => Promise<unknown> } } }).business.handoff;

describe("a caller who asked for a person is never handed back to the AI [SAFE-02][FO-10-46]", () => {
  it("[SAFE-02][FO-10-46] failure injection: the handoff store fails for the worker's whole deadline; the worker leaves; once the store recovers the supervisor routes the owed person and never re-dispatches the AI", async ({ l2 }) => {
    const { room, caller, bound } = await newCall();
    const handoff = handoffService();
    const real = handoff.requestHuman.bind(handoff);
    handoff.requestHuman = async () => {
      throw new Error("HANDOFF_STORE_DOWN");
    };
    let restored = false;
    try {
      const routesBefore = stack.humanRoutes.length;
      await caller.room.localParticipant?.publishDtmf(0, "0");
      // The worker asks until its human deadline (30 s here), then leaves the room so the supervisor takes over.
      await until("the worker's job left the room", async () => ((await agentIn(l2, room)) === null ? true : null), 90_000, 500);
      expect(workerA.output).toMatch(/media\.human_route\.not_routed/);
      // The gateway recorded each attempt for the room before the handoff failed: the person is owed.
      const sid = (await roomService(l2).listRooms([room]))[0]?.sid ?? "";
      expect(await stack.bindings.personStateOfRoom({ sid })).toBe("OUTSTANDING");
      handoff.requestHuman = real;
      restored = true;
      // The supervisor (the loop the composition schedules), with a re-dispatch grace far below the time it is given.
      const supervisor = stack.supervisor(AGENT, { redispatchGraceMs: 2_000, humanAfterMs: 120_000 });
      const outcomes: string[] = [];
      await until("person routed by the supervisor", async () => {
        for (const r of await supervisor.sweep()) if (r.roomName === room) outcomes.push(r.outcome);
        return outcomes.includes("HUMAN_ROUTED") ? true : null;
      }, 60_000, 1_000);
      // Keep sweeping well past the re-dispatch grace: the caller stays with the person.
      const t0 = Date.now();
      while (Date.now() - t0 < 10_000) {
        for (const r of await supervisor.sweep()) if (r.roomName === room) outcomes.push(r.outcome);
        await new Promise((r) => setTimeout(r, 1_000));
      }
      expect(outcomes).not.toContain("REDISPATCHED");
      expect(outcomes.at(-1)).toBe("WITH_PERSON");
      const persons = stack.humanRoutes.slice(routesBefore).filter((h) => h.callId === bound.interactionId);
      expect(persons).toHaveLength(1);
      expect(persons[0]?.reason).toBe("CALLER_REQUESTED_HUMAN");
      // No runtime was put back on the call: the binding is still the first one, no recovery happened.
      expect(await agentIn(l2, room)).toBeNull();
      const now = await stack.bindingOf(room);
      expect(now?.claim.bindingId).toBe(bound.claim.bindingId);
      expect(now?.generation).toBe(bound.generation);
      expect(stack.audits.some((a) => a.action === "call.binding.recovered" && a.interactionId === bound.interactionId)).toBe(false);
    } finally {
      if (!restored) handoff.requestHuman = real;
    }
  }, 300_000);

  it("[SAFE-02][FO-10-46] the person was accepted, then the worker host crashed: the supervisor leaves the caller with the person, and a replacement job dispatched to the room is refused BINDING_WITH_PERSON and stays silent; no new binding, generation or person", async ({ l2 }) => {
    const { room, caller, agent, bound } = await newCall();
    const routesBefore = stack.humanRoutes.length;
    await caller.room.localParticipant?.publishDtmf(0, "0");
    await until("person requested", async () => stack.humanRoutes.slice(routesBefore).find((h) => h.callId === bound.interactionId) ?? null, 60_000);
    await until("runtime HUMAN_ROUTED", async () => healthOf(await agentIn(l2, room))?.phase === "HUMAN_ROUTED", 30_000);
    workerB = new WorkerProcess(stack.workerEnv({ agentName: AGENT, recording: false, instance: "media-worker-pb1" }));
    await workerB.start();
    workerA.crash();
    await until("crashed runtime gone from the room", async () => ((await agentIn(l2, room)) === null ? true : null), 90_000, 500);
    const supervisor = stack.supervisor(AGENT, { redispatchGraceMs: 2_000, humanAfterMs: 20_000 });
    const outcomes: string[] = [];
    const t0 = Date.now();
    while (Date.now() - t0 < 8_000) {
      for (const r of await supervisor.sweep()) if (r.roomName === room) outcomes.push(r.outcome);
      await new Promise((r) => setTimeout(r, 1_000));
    }
    expect(outcomes.length).toBeGreaterThan(0);
    expect(new Set(outcomes)).toEqual(new Set(["WITH_PERSON"]));
    // A job dispatched to the room anyway (as the media plane or an earlier sweep might): the replacement is refused.
    await dispatchClient(l2).createDispatch(room, AGENT);
    const replacement = await until("replacement agent", () => agentIn(l2, room, agent.identity), 60_000);
    await until("replacement silent with the person", async () => healthOf(await agentIn(l2, room, agent.identity))?.phase === "HUMAN_ROUTED", 60_000);
    expect(workerB.output).toMatch(/media\.binding\.with_person/);
    expect(replacement.identity).not.toBe(agent.identity);
    await new Promise((r) => setTimeout(r, 5_000));
    const now = await stack.bindingOf(room);
    expect(now?.claim.bindingId).toBe(bound.claim.bindingId);
    expect(now?.generation).toBe(bound.generation);
    expect(stack.audits.some((a) => a.action === "call.binding.recovered" && a.interactionId === bound.interactionId)).toBe(false);
    expect(stack.audits.some((a) => a.action === "call.binding.refused" && a.interactionId === bound.interactionId && a.reasonCode === "BINDING_WITH_PERSON")).toBe(true);
    expect(stack.humanRoutes.slice(routesBefore).filter((h) => h.callId === bound.interactionId)).toHaveLength(1);
    expect(healthOf(await agentIn(l2, room, agent.identity))?.phase).toBe("HUMAN_ROUTED");
  }, 300_000);

  it("[SAFE-02][FO-10-46] a person accepted for the room by another party while the AI owner holds the call: the owner's next heartbeat is refused BINDING_WITH_PERSON and it goes silent and suspended; no second person, no new binding", async ({ l2 }) => {
    const { room, bound } = await newCall();
    await until("runtime BOUND", async () => healthOf(await agentIn(l2, room))?.phase === "BOUND", 30_000);
    const routesBefore = stack.humanRoutes.length;
    const answer = await stack.post("/media/v1/calls/human-route", { roomName: room, reason: "RECOVERY_FAILED", language: "en" }, await stack.runtimeToken());
    expect(answer.status).toBe(200);
    expect(answer.json).toMatchObject({ accepted: true, reasonCode: "HANDOFF_REQUESTED" });
    const sid = (await roomService(l2).listRooms([room]))[0]?.sid ?? "";
    expect(await stack.bindings.personStateOfRoom({ sid })).toBe("WITH_PERSON");
    // At its next gateway contact (a processing answer, every reconciliation tick, or the heartbeat, 5 s here) the owner
    // learns it and suspends with the person: no AI turn from then on. Told while the handoff was still being attempted
    // (a person owed), it asks too and is answered "in progress", then from the record: never a second handoff.
    await until("owner silent with the person", async () => healthOf(await agentIn(l2, room))?.phase === "HUMAN_ROUTED", 30_000);
    // Its binding can no longer be renewed: the gateway refuses the claim (BINDING_WITH_PERSON), whoever presents it.
    const refused = await stack.post(`/media/v1/calls/bindings/${bound.claim.bindingId}/heartbeat`, { claim: (await stack.bindingOf(room))!.claim }, await stack.runtimeToken());
    expect(refused).toMatchObject({ status: 409, json: { error: { reasonCode: "BINDING_WITH_PERSON" } } });
    await sleep(6_000);
    expect(stack.humanRoutes.slice(routesBefore).filter((h) => h.callId === bound.interactionId)).toHaveLength(1);
    const now = await stack.bindingOf(room);
    expect(now?.claim.bindingId).toBe(bound.claim.bindingId);
    expect(healthOf(await agentIn(l2, room))?.phase).toBe("HUMAN_ROUTED");
  }, 180_000);

  it("[SAFE-02][FO-10-46][FO-19-10] failure injection: the binding store cannot be read while a caller's runtime is gone: the supervisor never re-dispatches the AI on a guess, and routes the caller to a person once the room has been orphaned past its deadline", async ({ l2 }) => {
    // The person requests are unreadable: the real DynamoDB protocol against a table that does not exist.
    const dynamo = dynamoClient(l2);
    const over = stack.bindingsOver(new CallBindingStore(DynamoKvStore.fromClient(dynamo, uniqueName("vsp-it-unreadable"))));
    try {
      // A call whose runtime is gone: a caller in the room, the room dispatched to an agent name no worker serves.
      const orphanAgent = uniqueName("vsp-media-orphan");
      const room = uniqueName("vsp-it-person-orphan");
      rooms.push(room);
      await roomService(l2).createRoom({ name: room, emptyTimeout: 300, departureTimeout: 5 });
      await dispatchClient(l2).createDispatch(room, orphanAgent);
      callers.push(await joinCaller(l2, room));
      expect(await over.personStateOfRoom({ sid: (await roomService(l2).listRooms([room]))[0]?.sid ?? "" }).catch((e: { reasonCode?: string }) => e.reasonCode)).toBe("KV_READ_FAILED");
      const routesBefore = stack.humanRoutes.length;
      const supervisor = stack.supervisor(orphanAgent, { redispatchGraceMs: 2_000, humanAfterMs: 8_000 }, over);
      const outcomes: { atMs: number; outcome: string }[] = [];
      const t0 = Date.now();
      // Sweep (about once a second) until the person was routed and at least four further sweeps saw the room, so the
      // test holds however long a sweep takes on a loaded host (bounded by the test timeout).
      const sweepsAfterRoute = () => outcomes.length - 1 - outcomes.findIndex((o) => o.outcome === "HUMAN_ROUTED");
      while (Date.now() - t0 < 90_000 && !(outcomes.some((o) => o.outcome === "HUMAN_ROUTED") && sweepsAfterRoute() >= 4)) {
        for (const r of await supervisor.sweep()) if (r.roomName === room) outcomes.push({ atMs: Date.now() - t0, outcome: r.outcome });
        await sleep(1_000);
      }
      const seq = outcomes.map((o) => o.outcome);
      // Before the deadline: unknown, nothing re-dispatched; at the deadline (8 s after the first orphaned sweep) one
      // person; on every later sweep no second one.
      const routed = outcomes.filter((o) => o.outcome === "HUMAN_ROUTED");
      expect(routed).toHaveLength(1);
      expect(routed[0]!.atMs).toBeGreaterThanOrEqual(8_000);
      expect(outcomes.filter((o) => o.atMs < routed[0]!.atMs).length).toBeGreaterThan(0);
      expect(outcomes.filter((o) => o.atMs < routed[0]!.atMs).every((o) => o.outcome === "PERSON_STATE_UNKNOWN")).toBe(true);
      expect(sweepsAfterRoute()).toBeGreaterThanOrEqual(4);
      expect(outcomes.filter((o) => o.atMs > routed[0]!.atMs).every((o) => o.outcome === "PERSON_STATE_UNKNOWN")).toBe(true);
      expect(seq).not.toContain("REDISPATCHED");
      // livekit-server lists only the call's first dispatch: the AI was never dispatched again.
      expect((await dispatchClient(l2).listDispatch(room)).filter((d) => d.agentName === orphanAgent)).toHaveLength(1);
      // The person was requested through the production HandoffService, once (unrecorded: the store cannot be written either).
      const persons = stack.humanRoutes.slice(routesBefore);
      expect(persons).toHaveLength(1);
      expect(persons[0]?.reason).toBe("DEPENDENCY_FAILURE");
    } finally {
      dynamo.destroy();
    }
  }, 120_000);
});
