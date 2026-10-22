/**
 * Layer 2 (WP-11; FO-05-16, FO-10-46; AUTH-03, SAFE-02): the carrier interaction a binding names cannot be forged into
 * another call. The media worker holds the media-plane API secret (Agents registration needs it), so anything holding
 * that secret can mint a SIP-kind participant carrying any `sip.callID`, or rewrite one through UpdateParticipant
 * (both shown below against the shared livekit-server). The gateway therefore pins each call to ONE room at the first
 * touch (room server id, name digest, the SIP party whose call id names it) and refuses everything else:
 *
 *   - a second room whose SIP-kind participant carries the victim's sip.callID: the production worker's job there is
 *     refused BINDING_ROOM_MISMATCH (audited), the caller of that room is routed to a person under a fresh
 *     interaction (never the victim's), and the victim keeps its binding, generation and fencing token;
 *   - the victim's own SIP participant's call id rewritten through the server API: the next bind for the room is
 *     refused BINDING_CARRIER_CHANGED and the binding is revoked; the live owner is told (BINDING_REVOKED) and routes
 *     the caller to a person.
 * Everything that answers is real (support.ts): the live gateway composition with the media routes, DynamoDB Local,
 * Keycloak, livekit-server and the production worker process. The SIP-kind participants are tokens minted with the
 * local API secret (the attack itself), standing in for livekit-sip's participants (same kind and attribute).
 */
import { AccessToken } from "livekit-server-sdk";
import { Room, dispose } from "@livekit/rtc-node";
import { afterAll, afterEach, beforeAll, describe, expect } from "vitest";
import { uniqueName } from "../_harness/clients.js";
import { localEnv } from "../_harness/env.js";
import { layer2, layer2Context } from "../_harness/layer2.js";
import type { Layer2Context } from "../_harness/layer2.js";
import { MEDIA_SERVICES, WorkerProcess, dispatchClient, healthOf, readoutOf, roomService, startMediaStack, until } from "./support.js";
import type { MediaStack } from "./support.js";

const it = layer2(MEDIA_SERVICES);
const AGENT = uniqueName("vsp-media-carrier");
const CALL_ID = `SCL_${uniqueName("synthL2Victim").replace(/[^A-Za-z0-9]/g, "")}`;

let stack: MediaStack;
let worker: WorkerProcess;
const sipRooms: Room[] = [];
const rooms: string[] = [];

/** A SIP-kind participant minted with the media-plane API secret, carrying the given sip.callID (the attack). */
async function mintedSipParticipant(l2: Layer2Context, roomName: string, identity: string, callId: string): Promise<Room> {
  const t = new AccessToken(localEnv().livekitApiKey, localEnv().livekitApiSecret, { identity, ttl: 600, attributes: { "sip.callID": callId } });
  t.kind = "sip";
  t.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true });
  const room = new Room();
  await room.connect(l2.url("livekit", 7880, "ws"), await t.toJwt(), { autoSubscribe: false, dynacast: false });
  sipRooms.push(room);
  return room;
}

/** The agent participants of a room (kind AGENT, connected). */
async function agentsIn(l2: Layer2Context, roomName: string) {
  return (await roomService(l2).listParticipants(roomName)).filter((p) => p.kind === 4 && p.state !== 3);
}

beforeAll(async () => {
  stack = await startMediaStack(layer2Context(MEDIA_SERVICES));
  worker = new WorkerProcess(stack.workerEnv({ agentName: AGENT, recording: false, instance: "media-worker-c1" }));
  await worker.start();
}, 240_000);

afterEach(({ task }) => {
  if (task.result?.state === "fail") process.stderr.write(`--- media worker ---\n${worker?.output.slice(-6_000)}\n--- gateway (warn/error) ---\n${stack?.gatewayEvents().slice(-25).join("\n") ?? ""}\n`);
});

afterAll(async () => {
  for (const r of sipRooms) await r.disconnect().catch(() => undefined);
  await worker?.stop();
  for (const r of rooms) await roomService(stack.l2).deleteRoom(r).catch(() => undefined);
  await stack?.close();
  await dispose();
}, 120_000);

describe("one call, one room: a forged carrier reference never names another call [FO-05-16][AUTH-03]", () => {
  it("[AUTH-03][FO-05-16][SAFE-02] adversarial: a second room whose SIP-kind participant carries the victim's sip.callID is refused BINDING_ROOM_MISMATCH; its caller goes to a person under a fresh interaction; the victim keeps its binding, generation and fencing token", async ({ l2 }) => {
    const victimRoom = uniqueName("vsp-it-carrier-victim");
    const attackerRoom = uniqueName("vsp-it-carrier-forged");
    rooms.push(victimRoom, attackerRoom);
    await roomService(l2).createRoom({ name: victimRoom, emptyTimeout: 300, departureTimeout: 5 });
    await mintedSipParticipant(l2, victimRoom, "sip_synthVictimCaller", CALL_ID);
    await dispatchClient(l2).createDispatch(victimRoom, AGENT);
    const victim = await until("victim binding", () => stack.bindingOf(victimRoom), 90_000);
    expect(victim).toMatchObject({ generation: 1, state: "ACTIVE", claim: { fencingToken: 1 } });
    const record = await stack.store.load(stack.tenantId, victim.interactionId);
    expect(record?.data.carrier).toMatchObject({ kind: "sip_reference", interactionRef: CALL_ID });

    // The attack precondition is real: the minted participant is listed by the media plane as kind SIP with the call id.
    await roomService(l2).createRoom({ name: attackerRoom, emptyTimeout: 300, departureTimeout: 5 });
    await mintedSipParticipant(l2, attackerRoom, "sip_synthForged", CALL_ID);
    const forged = (await roomService(l2).listParticipants(attackerRoom)).find((p) => p.identity === "sip_synthForged");
    expect(forged?.kind).toBe(3);
    expect(forged?.attributes["sip.callID"]).toBe(CALL_ID);
    const routesBefore = stack.humanRoutes.length;
    await dispatchClient(l2).createDispatch(attackerRoom, AGENT);

    // The worker's job in the forged room is refused (audited); the caller there gets a person, never under the victim's call.
    await until("refusal audited", async () => (stack.audits.some((a) => a.action === "call.binding.refused" && a.reasonCode === "BINDING_ROOM_MISMATCH") ? true : null), 90_000);
    const route = await until("person for the forged room", async () => stack.humanRoutes.slice(routesBefore)[0] ?? null, 60_000);
    expect(route.callId).not.toBe(victim.interactionId);
    await until("unattributed route audited", async () => stack.audits.some((a) => a.action === "media.route.human_requested" && a.interactionId === route.callId && a.reasonCode === "ROUTE_UNATTRIBUTED"), 30_000);
    expect(await stack.bindingOf(attackerRoom)).toBeNull();

    // The victim is untouched: same binding, generation and fencing token, still renewed by its owner.
    await new Promise((r) => setTimeout(r, 6_000)); // more than one heartbeat interval
    const after = await stack.bindingOf(victimRoom);
    expect(after).toMatchObject({ state: "ACTIVE", generation: 1, claim: { bindingId: victim.claim.bindingId, fencingToken: 1 } });
    const owner = (await agentsIn(l2, victimRoom))[0] ?? null;
    expect(readoutOf(owner)).toMatchObject({ bindingId: victim.claim.bindingId, sessionGeneration: 1 });
    expect(healthOf(owner)?.phase).toBe("BOUND");
  }, 300_000);

  it("[AUTH-03][FO-05-16] adversarial: the victim's SIP participant's call id rewritten through UpdateParticipant: the next bind is refused BINDING_CARRIER_CHANGED, the binding is revoked, and the live owner routes the caller to a person", async ({ l2 }) => {
    const victimRoom = rooms[0] as string;
    const victim = await until("victim binding", () => stack.bindingOf(victimRoom));
    const owner = (await agentsIn(l2, victimRoom))[0];
    expect(owner).toBeTruthy();
    await roomService(l2).updateParticipant(victimRoom, "sip_synthVictimCaller", { attributes: { "sip.callID": `${CALL_ID}x` } });
    const routesBefore = stack.humanRoutes.length;
    await dispatchClient(l2).createDispatch(victimRoom, AGENT); // any later bind for the room re-checks the pinned carrier
    await until("carrier change refused", async () => (stack.audits.some((a) => a.action === "call.binding.refused" && a.reasonCode === "BINDING_CARRIER_CHANGED") ? true : null), 90_000);
    const revoked = await until("binding revoked", async () => {
      const b = await stack.bindingOf(victimRoom);
      return b?.state === "REVOKED" ? b : null;
    }, 30_000);
    expect(revoked.claim.bindingId).toBe(victim.claim.bindingId);
    // The live owner learns it at its next heartbeat (BINDING_REVOKED) and requests a person for the call.
    await until("owner HUMAN_ROUTED", async () => {
      const p = (await roomService(l2).listParticipants(victimRoom)).find((x) => x.identity === owner?.identity) ?? null;
      return healthOf(p)?.phase === "HUMAN_ROUTED" ? true : null;
    }, 60_000);
    expect(stack.humanRoutes.slice(routesBefore).some((h) => h.callId === victim.interactionId)).toBe(true);
    expect(worker.output).toContain("BINDING_REVOKED");
  }, 300_000);
});
