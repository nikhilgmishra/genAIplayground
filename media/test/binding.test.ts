/**
 * The worker side of the CallBinding against the production gateway routes and binding service, in process
 * (test/support/gateway.ts: real routes, service, verifier and sealer; LOCAL FIXTURE KV and media plane).
 * [FO-05-16][FO-10-46][AUTH-03][SAFE-02]
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ProcessingDirective } from "@vsp/platform/src/protocol/call-binding.js";
import { GatewayRefusedError, GatewayUnavailableError, MediaGatewayClient } from "../src/binding/client.js";
import { BindingManager } from "../src/binding/manager.js";
import type { BindingLoss, Timers } from "../src/binding/manager.js";
import { ClientCredentialsTokenSource, RuntimeCredentialError } from "../src/binding/runtime-credential.js";
import { startGateway } from "./support/gateway.js";
import type { GatewayHarness } from "./support/gateway.js";

let gw: GatewayHarness;
let seq = 0;
const ROOM = "call-synth-room";

beforeAll(async () => {
  gw = await startGateway();
});
afterAll(async () => {
  await gw.close();
});

/** Manual timers: the heartbeat runs only when a test says so. */
class ManualTimers implements Timers {
  readonly handles = new Map<number, () => void>();
  private n = 0;
  setInterval(fn: () => void) {
    this.handles.set(++this.n, fn);
    return this.n;
  }
  clearInterval(h: unknown) {
    this.handles.delete(h as number);
  }
}

function newRoom(): { room: string; jobRef: string; agentIdentity: string } {
  const room = `${ROOM}-${++seq}`;
  gw.plane.addSipRoom(room, `SCL_synthCallMedia${seq}`);
  const jobRef = `AJ_synthJob${seq}a`;
  return { room, jobRef, agentIdentity: gw.plane.dispatch(jobRef) };
}

function manager() {
  const events = { directives: [] as ProcessingDirective[], generations: [] as [number, number][], losses: [] as BindingLoss[] };
  const timers = new ManualTimers();
  const m = new BindingManager(gw.client, { onDirective: (d) => events.directives.push(d), onGeneration: (a, b) => events.generations.push([a, b]), onLost: (l) => events.losses.push(l) }, () => gw.clock.now().getTime(), timers);
  return { m, events, timers };
}

const bindReq = (r: ReturnType<typeof newRoom>, worker = "media-worker-a1") => ({ roomName: r.room, jobRef: r.jobRef, workerInstanceRef: worker, agentIdentity: r.agentIdentity, adapter: "controlled_cascade_runtime" as const });

beforeEach(() => {
  gw.transport.failing = false;
});

describe("MediaGatewayClient over the gateway media routes [FO-05-16][AUTH-03]", () => {
  it("[FO-05-16] positive: the binding is issued for the dispatched job, bound to the carrier interaction, with the runtime credential on every request", async () => {
    const r = newRoom();
    const res = await gw.client.bind(bindReq(r));
    expect(res.issue).toBe("NEW_CALL");
    expect(res.binding).toMatchObject({ tenantId: "tnt_synthTenantMedia0001", state: "ACTIVE", sessionGeneration: 1 });
    expect(res.directive.recording.value).toBe("UNKNOWN");
    expect(gw.transport.sent.at(-1)).toMatchObject({ path: "/media/v1/calls/bindings" });
    expect(gw.transport.sent.at(-1)?.authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  });

  it("[AUTH-03] adversarial: a forged claim (another binding id, a raised generation or fencing token) is refused with 409 and a reason code only", async () => {
    const r = newRoom();
    const { claim } = await gw.client.bind(bindReq(r));
    for (const forged of [{ ...claim, sessionGeneration: claim.sessionGeneration + 1 }, { ...claim, fencingToken: claim.fencingToken + 5 }]) {
      const err = await gw.client.heartbeat(forged).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(GatewayRefusedError);
      expect((err as GatewayRefusedError).status).toBe(409);
      expect((err as GatewayRefusedError).reasonCode).toMatch(/^BINDING_/);
    }
  });

  it("failure injection: an unreachable gateway is GatewayUnavailableError (never a guessed answer); a malformed success body is refused", async () => {
    gw.transport.failing = true;
    const err = await gw.client.humanRoute({ roomName: "call-x", reason: "AI_UNAVAILABLE", language: "en" }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(GatewayUnavailableError);
    expect((err as GatewayUnavailableError).reasonCode).toBe("TRANSPORT_CONNECT_FAILED");
    const broken = new MediaGatewayClient({ baseUrl: "https://gateway.vsp.test", transport: { send: async () => ({ status: 200, headers: {}, body: Buffer.from(JSON.stringify({ accepted: "yes" })) }) }, credential: async () => "t", addressClass: "PRIVATE_NETWORK" });
    const e2 = await broken.humanRoute({ roomName: "call-x", reason: "AI_UNAVAILABLE", language: "en" }).then(() => null, (e: unknown) => e);
    expect((e2 as GatewayUnavailableError).reasonCode).toBe("GATEWAY_RESPONSE_INVALID");
    expect(() => new MediaGatewayClient({ baseUrl: "http://gateway.vsp.test", transport: { send: async () => Promise.reject(new Error("x")) }, credential: async () => "t", addressClass: "PRIVATE_NETWORK" })).toThrow("MEDIA_GATEWAY_URL_INVALID");
  });

  it("[SAFE-02] the human and safety routes answer without any binding for the room", async () => {
    const r = newRoom();
    const human = await gw.client.humanRoute({ roomName: r.room, reason: "BINDING_UNAVAILABLE", language: "en" });
    expect(human).toMatchObject({ accepted: true, destinationId: "dst_support_general" });
    const safety = await gw.client.safetyRoute({ roomName: r.room, signals: [{ source: "CALLER_REQUEST", ruleId: "caller.requested_help", strength: "CREDIBLE", subject: "SELF", temporal: "CURRENT", negated: false }], locale: "en-US" });
    expect(safety).toMatchObject({ accepted: true, destinationId: "dst_safety_priority" });
    expect(gw.handoff.human.length).toBeGreaterThan(0);
    expect(gw.handoff.safety.length).toBeGreaterThan(0);
  });
});

describe("BindingManager [FO-10-46][FO-10-09][AUTH-03]", () => {
  it("[FO-10-09] follows the session generation on lifecycle changes and heartbeats; a directive with a lower consent version never replaces a newer one", async () => {
    const r = newRoom();
    const { m, events, timers } = manager();
    const b = await m.bind(bindReq(r));
    expect(timers.handles.size).toBe(1);
    expect(events.directives).toHaveLength(1);
    const lc = await m.lifecycle("PARTICIPANT_JOINED", "other");
    expect(lc.generationChanged).toBe(true);
    expect(events.generations).toEqual([[b.binding.sessionGeneration, b.binding.sessionGeneration + 1]]);
    expect(m.claim()?.sessionGeneration).toBe(b.binding.sessionGeneration + 1);
    await gw.grant(m.claim()!);
    await m.heartbeat();
    const granted = events.directives.at(-1)!;
    expect(granted.recording.value).toBe("GRANTED");
    // A stale directive (an older consent version) is ignored.
    (m as unknown as { applyDirective(d: ProcessingDirective): void }).applyDirective({ ...granted, consentVersion: granted.consentVersion - 1, recording: { ...granted.recording, value: "DECLINED" } });
    expect(m.directive()?.recording.value).toBe("GRANTED");
  });

  it("[AUTH-03][FO-10-09] an older answer (a heartbeat answered before the generation advanced, delivered late) never moves the generation back", async () => {
    const r = newRoom();
    // Labelled unit fake around the real client: the heartbeat answer is rewritten to an older generation, as a
    // reordered response would arrive. Every other call reaches the in-process gateway unchanged.
    let staleGeneration: number | null = null;
    const client = {
      bind: (q: Parameters<MediaGatewayClient["bind"]>[0]) => gw.client.bind(q),
      heartbeat: async (c: Parameters<MediaGatewayClient["heartbeat"]>[0]) => {
        const res = await gw.client.heartbeat(c);
        return staleGeneration === null ? res : { ...res, sessionGeneration: staleGeneration };
      },
      lifecycle: (q: Parameters<MediaGatewayClient["lifecycle"]>[0]) => gw.client.lifecycle(q),
      consentDecision: (q: Parameters<MediaGatewayClient["consentDecision"]>[0]) => gw.client.consentDecision(q),
      reportProcessing: (c: Parameters<MediaGatewayClient["reportProcessing"]>[0], s: Parameters<MediaGatewayClient["reportProcessing"]>[1]) => gw.client.reportProcessing(c, s),
    } as unknown as MediaGatewayClient;
    const events = { generations: [] as [number, number][], losses: [] as BindingLoss[] };
    const m = new BindingManager(client, { onDirective: () => undefined, onGeneration: (a, b) => events.generations.push([a, b]), onLost: (l) => events.losses.push(l) }, () => gw.clock.now().getTime(), new ManualTimers());
    const b = await m.bind(bindReq(r));
    const g = b.binding.sessionGeneration;
    await m.lifecycle("PARTICIPANT_JOINED", "other");
    expect(m.claim()?.sessionGeneration).toBe(g + 1);
    staleGeneration = g;
    await m.heartbeat();
    expect(m.claim()?.sessionGeneration).toBe(g + 1);
    expect(m.binding()?.sessionGeneration).toBe(g + 1);
    expect(events.generations).toEqual([[g, g + 1]]);
    expect(events.losses).toEqual([]);
  });

  it("[AUTH-03] a newer owner supersedes this one: the next heartbeat declares the binding lost and stops the heartbeat; the old claim is never used again", async () => {
    const r = newRoom();
    const a = manager();
    await a.m.bind(bindReq(r));
    // The first owner's agent leaves the room (crashed); a re-dispatched job binds with a new generation.
    gw.plane.agents.delete(r.agentIdentity);
    const job2 = `${r.jobRef}b`;
    const id2 = gw.plane.dispatch(job2);
    const b = manager();
    const res = await b.m.bind({ ...bindReq(r, "media-worker-b1"), jobRef: job2, agentIdentity: id2 });
    expect(res.issue).toBe("REBOUND_AFTER_OWNER_LOSS");
    expect(res.binding.sessionGeneration).toBeGreaterThan(a.m.binding()!.sessionGeneration);
    await a.m.heartbeat();
    expect(a.events.losses).toEqual([{ reason: "SUPERSEDED", reasonCode: "BINDING_SUPERSEDED" }]);
    expect(a.m.claim()).toBeNull();
    expect(a.timers.handles.size).toBe(0);
    await expect(a.m.lifecycle("HOLD_STARTED", "caller")).rejects.toMatchObject({ status: 409 });
  });

  it("failure injection: the gateway unreachable past the binding expiry is EXPIRED_UNREACHABLE; before expiry it is not a loss", async () => {
    const r = newRoom();
    const { m, events } = manager();
    await m.bind(bindReq(r));
    gw.transport.failing = true;
    await m.heartbeat();
    expect(events.losses).toEqual([]);
    gw.clock.advanceMs(31_000);
    await m.heartbeat();
    expect(events.losses).toEqual([{ reason: "EXPIRED_UNREACHABLE", reasonCode: "BINDING_EXPIRED" }]);
  });

  it("a hang-up ends the binding and stops the heartbeat", async () => {
    const r = newRoom();
    const { m, timers } = manager();
    await m.bind(bindReq(r));
    const res = await m.lifecycle("CALLER_HUNG_UP", "caller");
    expect(res.state).toBe("ENDED");
    expect(timers.handles.size).toBe(0);
  });
});

describe("ClientCredentialsTokenSource [AUTH-02]", () => {
  const ok = (token: string, expiresIn = 300) => ({ status: 200, headers: {}, body: Buffer.from(JSON.stringify({ access_token: token, expires_in: expiresIn, token_type: "Bearer" })) });

  it("caches the token until the refresh margin, sends client_secret_basic and the runtime scope", async () => {
    let now = 0;
    const seen: { auth: string | undefined; body: string }[] = [];
    let n = 0;
    const src = new ClientCredentialsTokenSource({
      tokenUrl: "https://idp.vsp.test/realms/media/protocol/openid-connect/token",
      clientId: "vsp-media-runtime",
      clientSecret: () => "rtsecret_synthOnlyForUnitTests",
      scope: "vsp.conversation_runtime",
      addressClass: "PRIVATE_NETWORK",
      now: () => now,
      transport: { send: async (req) => (seen.push({ auth: req.headers.authorization, body: String(req.body) }), ok(`token-number-${++n}-abcdefgh`)) },
    });
    expect(await src.token()).toBe("token-number-1-abcdefgh");
    expect(await src.token()).toBe("token-number-1-abcdefgh");
    now = 241_000; // past expiry minus the 60 s margin
    expect(await src.token()).toBe("token-number-2-abcdefgh");
    expect(seen[0]?.auth).toBe(`Basic ${Buffer.from("vsp-media-runtime:rtsecret_synthOnlyForUnitTests").toString("base64")}`);
    expect(seen[0]?.body).toBe("grant_type=client_credentials&scope=vsp.conversation_runtime");
  });

  it("adversarial: a refused client, a malformed answer and an unreachable IdP are typed failures, never a token", async () => {
    const make = (send: () => Promise<{ status: number; headers: Record<string, string>; body: Buffer }>) =>
      new ClientCredentialsTokenSource({ tokenUrl: "https://idp.vsp.test/t", clientId: "vsp-media-runtime", clientSecret: () => "x", scope: "vsp.conversation_runtime", addressClass: "PRIVATE_NETWORK", transport: { send } });
    const code = async (s: ClientCredentialsTokenSource) => s.token().then(() => "NONE", (e: RuntimeCredentialError) => e.reasonCode);
    expect(await code(make(async () => ({ status: 401, headers: {}, body: Buffer.from("{}") })))).toBe("RUNTIME_CLIENT_REFUSED");
    expect(await code(make(async () => ({ status: 200, headers: {}, body: Buffer.from(JSON.stringify({ access_token: "short", token_type: "Bearer" })) })))).toBe("RUNTIME_TOKEN_RESPONSE_INVALID");
    expect(await code(make(async () => Promise.reject(new Error("ECONNREFUSED"))))).toBe("RUNTIME_TOKEN_UNAVAILABLE");
    expect(() => new ClientCredentialsTokenSource({ tokenUrl: "http://idp.vsp.test/t", clientId: "c1x", clientSecret: () => "x", scope: "vsp.conversation_runtime", addressClass: "PRIVATE_NETWORK", transport: { send: async () => ok("x") } })).toThrow();
  });
});
