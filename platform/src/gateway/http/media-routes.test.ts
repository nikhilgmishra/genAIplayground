/**
 * Gateway media routes over the production Fastify gateway app (WP-11; AUTH-03, SAFE-02, FO-10-46).
 *
 * Production: buildGatewayApp, registerMediaRoutes, RuntimeCredentialVerifier (local JWKS), CallBindingService,
 * CallBindingStore, TrustedSessionService, AES-256-GCM sealer. LOCAL FIXTURE / labelled unit fakes: the in-memory KV,
 * the media-plane lookup, the handoff service recorder and the audit recorder.
 */
import { generateKeyPairSync, randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { SignJWT, createLocalJWKSet, exportJWK } from "jose";
import type { JWK } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { HandoffService } from "../../business/contract.js";
import { RuntimeCredentialVerifier } from "../../calls/binding/runtime-auth.js";
import type { BindingAuditEvent, CarrierInteraction, CarrierInteractionLookup, CarrierLookupInput, MediaRoomFacts } from "../../calls/binding/ports.js";
import { CallBindingService } from "../../calls/binding/service.js";
import { CallBindingStore } from "../../calls/binding/store.js";
import { AesGcmTokenSealer } from "../../console-api/token-sealer.js";
import { sessionConfig } from "../../identity/config.js";
import { MemoryKvStoreFixture } from "../../identity/kv/memory-kv-store.js";
import { TrustedSessionService } from "../../identity/session-service.js";
import { silentLogger } from "../../observability/logger.js";
import type { IntegrationIdentity } from "../../protocol/index.js";
import { FakeClock } from "../../shared/clock.js";
import { AccessDeniedError, DependencyError } from "../../shared/errors.js";
import { LOCAL_FIXTURE_TOKENS, LocalFixtureTokenAuthenticator } from "../auth.js";
import { buildGatewayApp } from "./app.js";
import { InMemoryAuditWriterFixture } from "../../audit/fixtures.js";
import { GatewayAudit } from "../gateway-audit.js";
import { MEDIA_ROUTE_SPECS, PERSON_ATTEMPT_LEASE_MS, gatewayBindingAudit, registerMediaRoutes, sessionServiceCallSessions, supervisorHumanRoute, supervisorPersonState } from "./media-routes.js";

const TENANT = "tnt_synthTenantMedia0001";
const ISSUER = "https://idp.vsp.test/realms/media";
const clock = new FakeClock("2026-10-21T12:00:00.000Z");
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" } as JWK;

async function runtimeToken(scope = "vsp.conversation_runtime"): Promise<string> {
  const now = Math.floor(clock.now().getTime() / 1000);
  return new SignJWT({ azp: "vsp-media-runtime", scope }).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(ISSUER).setAudience("vsp-gateway-ci").setIssuedAt(now).setExpirationTime(now + 300).sign(privateKey);
}

/** LOCAL FIXTURE (unit fake) media plane: one SIP call in room-a (and in "support line/01", a name with a space and a slash); jobs and agents set per test. */
class Plane implements CarrierInteractionLookup {
  agents = new Set<string>();
  jobs = new Map<string, string>();
  down = false;
  readonly carrier: CarrierInteraction = { kind: "sip_reference", interactionRef: "SCL_synthCallMedia01", routeRef: null };
  private readonly rooms = new Map<string, MediaRoomFacts>();
  private n = 2;
  constructor() {
    this.rooms.set("room-a", { roomSid: "RM_synthRoomMedia01", sipParties: [{ partyDigest: "a".repeat(64), interactionRef: this.carrier.interactionRef, routeRef: null, joinedAtMs: 1_000 }] });
    this.rooms.set("support line/01", { roomSid: "RM_synthRoomMedia02", sipParties: [{ partyDigest: "b".repeat(64), interactionRef: "SCL_synthCallMedia02", routeRef: null, joinedAtMs: 1_000 }] });
  }
  /** Another SIP call room (its own server id and call id). */
  addRoom(roomName: string): string {
    this.n += 1;
    const sid = `RM_synthRoomMedia${String(this.n).padStart(2, "0")}`;
    this.rooms.set(roomName, { roomSid: sid, sipParties: [{ partyDigest: "c".repeat(63) + String(this.n % 10), interactionRef: `SCL_synthCallMedia${String(this.n).padStart(2, "0")}`, routeRef: null, joinedAtMs: 1_000 }] });
    return sid;
  }
  private factsOf(roomName: string): MediaRoomFacts {
    const facts = this.rooms.get(roomName);
    if (!facts) throw new AccessDeniedError("MEDIA_ROOM_NOT_FOUND");
    return facts;
  }
  async verify(i: CarrierLookupInput) {
    const facts = this.factsOf(i.roomName);
    if (this.jobs.get(i.jobRef) !== i.agentIdentity || !this.agents.has(i.agentIdentity)) throw new AccessDeniedError("MEDIA_JOB_NOT_DISPATCHED");
    return { ...facts, presentAgents: [...this.agents] };
  }
  async describeRoom(i: { roomName: string }) {
    if (this.down) throw new DependencyError("LIVEKIT_API_UNAVAILABLE", "FAILED", true);
    return this.factsOf(i.roomName);
  }
}

/** Labelled unit fake of the HandoffService: records that a person or the safety route was requested. */
class HandoffRecorder implements Pick<HandoffService, "requestHuman" | "requestSafetyRoute"> {
  readonly human: { callId: string; reason: string; ctx: unknown }[] = [];
  readonly safety: { callId: string; ctx: unknown; ruleIds: string[] }[] = [];
  failing = false;
  safetyFailing = false;
  async requestHuman(i: Parameters<HandoffService["requestHuman"]>[0]) {
    if (this.failing) throw new DependencyError("HANDOFF_STORE_UNAVAILABLE", "FAILED", true);
    this.human.push({ callId: i.callId, reason: i.reason, ctx: i.ctx });
    return { handoffId: "hnd_synthHandoff000001", transferId: null, destinationId: "dst_support_general", journey: null, speechTemplateId: "human.offer", supportReference: null, priority: "STANDARD" as const };
  }
  async requestSafetyRoute(i: Parameters<HandoffService["requestSafetyRoute"]>[0]) {
    if (this.failing || this.safetyFailing) throw new DependencyError("HANDOFF_STORE_UNAVAILABLE", "FAILED", true);
    this.safety.push({ callId: i.callId, ctx: i.ctx, ruleIds: i.signals.map((x) => x.ruleId) });
    return { handoffId: "hnd_synthHandoff000002", transferId: null, destinationId: "dst_safety_priority", journey: null, speechTemplateId: "safety.acknowledge", supportReference: null, priority: "SAFETY" as const };
  }
}

let app: FastifyInstance;
let plane: Plane;
let handoff: HandoffRecorder;
let bindingService: CallBindingService;
const audits: BindingAuditEvent[] = [];
/**
 * LOCAL FIXTURE (validating audit writer): every binding event also goes through the production sink
 * (gatewayBindingAudit over GatewayAudit) into a writer that applies the audit store's event grammar, so an event the
 * store would reject (AUDIT_EVENT_INVALID) fails the issuance here as it does in the composition.
 */
const auditStore = new InMemoryAuditWriterFixture();
const productionSink = gatewayBindingAudit(new GatewayAudit(auditStore, clock, silentLogger, null));
const sink = { record: async (e: BindingAuditEvent) => { await productionSink.record(e); audits.push(e); } };
const carrierIntegration: IntegrationIdentity = { integrationId: "livekit-media-plane", tenantId: TENANT, environment: "ci", channel: "telephony_control", credentialId: "cred-media-plane-01", authMethod: "mtls" };

beforeAll(async () => {
  const kv = new MemoryKvStoreFixture();
  const sessions = new TrustedSessionService({ kv, clock, config: sessionConfig({ tenantId: TENANT, environment: "ci", policyVersion: "policy-ci-2026.10.21", startCallChannels: ["telephony_control"], consentChannels: ["telephony_control"], resolveChannels: ["telephony_control"] }) });
  plane = new Plane();
  handoff = new HandoffRecorder();
  const bindings = new CallBindingService(
    { tenantId: TENANT, environment: "ci", bindingTtlSeconds: 90, heartbeatIntervalSeconds: 15, recordingDeclinedRoute: "HUMAN" },
    {
      store: new CallBindingStore(kv),
      sessions: sessionServiceCallSessions(sessions, carrierIntegration, clock),
      lookup: plane,
      sealer: new AesGcmTokenSealer({ current: { id: "k1", key: randomBytes(32) } }),
      actions: { invalidatePending: async () => 0 },
      audit: sink,
      clock,
    },
  );
  bindingService = bindings;
  app = await buildGatewayApp({ logger: silentLogger, authenticator: new LocalFixtureTokenAuthenticator({ environment: "ci", tenantId: TENANT }), routes: [], rateLimit: { max: 3, timeWindowMs: 60_000 }, clock });
  registerMediaRoutes(app, {
    tenantId: TENANT,
    clock,
    logger: silentLogger,
    runtimeAuth: new RuntimeCredentialVerifier(
      { environment: "ci", tenantId: TENANT, issuer: ISSUER, audience: "vsp-gateway-ci", algorithms: ["RS256"], clockToleranceSeconds: 5, maxTokenAgeSeconds: 600, clientIdClaim: "azp", scope: "vsp.conversation_runtime", clients: [{ clientId: "vsp-media-runtime", integrationId: "vsp-media-runtime", credentialId: "cred-media-runtime-01", adapters: ["controlled_cascade_runtime"] }] },
      { clock, getKey: createLocalJWKSet({ keys: [jwk] }) },
    ),
    bindings,
    handoff,
    destinations: [
      { destinationId: "dst_support_general", purpose: "STANDARD_SUPPORT", vendorQueueRef: "queue-standard", fallbackDestinationIds: [], languages: ["en"] },
      { destinationId: "dst_safety_priority", purpose: "SAFETY_PRIORITY", vendorQueueRef: "queue-safety", fallbackDestinationIds: [], languages: ["en"] },
    ],
    rateLimit: { max: 8, timeWindowMs: 60_000 },
    audit: sink,
  });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
});

beforeEach(() => {
  handoff.failing = false;
  handoff.safetyFailing = false;
  plane.down = false;
});

const DESTINATIONS = [
  { destinationId: "dst_support_general", purpose: "STANDARD_SUPPORT" as const, vendorQueueRef: "queue-standard", fallbackDestinationIds: [], languages: ["en"] },
  { destinationId: "dst_safety_priority", purpose: "SAFETY_PRIORITY" as const, vendorQueueRef: "queue-safety", fallbackDestinationIds: [], languages: ["en"] },
];
const supervisorRoute = (audit: { record: (e: BindingAuditEvent) => Promise<void> } = { record: async (e) => void audits.push(e) }) =>
  supervisorHumanRoute({ tenantId: TENANT, clock, bindings: bindingService, handoff, destinations: DESTINATIONS, audit, logger: silentLogger, language: "en" });
const SIGNAL = { source: "EXPLICIT_PHRASE" as const, ruleId: "safety.self_harm.explicit", strength: "CREDIBLE" as const, subject: "SELF" as const, temporal: "CURRENT" as const, negated: false };

const post = async (url: string, body: unknown, token?: string) => app.inject({ method: "POST", url, payload: body as object, headers: token ? { authorization: `Bearer ${token}` } : {} });
const bindBody = (job: string, worker: string) => ({ roomName: "room-a", jobRef: job, workerInstanceRef: worker, agentIdentity: `agent-${job}`, adapter: "controlled_cascade_runtime" });

describe("media routes: authentication [AUTH-03]", () => {
  it("[AUTH-03] adversarial: no credential, a Studio (telephony_control) credential or a token without the runtime scope is refused before the body is read", async () => {
    expect((await post("/media/v1/calls/bindings", { junk: true })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/media/v1/calls/bindings", payload: bindBody("AJ_synthJob0001", "media-worker-a1"), headers: { authorization: `Bearer ${LOCAL_FIXTURE_TOKENS.telephony_control}` } })).statusCode).toBe(401);
    const r = await post("/media/v1/calls/bindings", bindBody("AJ_synthJob0001", "media-worker-a1"), await runtimeToken("vsp.mcp_tools"));
    expect(r.statusCode).toBe(403);
    expect(r.json()).toMatchObject({ error: { reasonCode: "RUNTIME_SCOPE_MISSING" } });
    // The human route needs no binding, but it still needs the runtime's own credential.
    expect((await post("/media/v1/calls/human-route", { roomName: "room-a", reason: "CALLER_REQUESTED_HUMAN", language: "en" })).statusCode).toBe(401);
  });

  it("the route table is complete and only the human and safety routes are rate-limit exempt", () => {
    expect(MEDIA_ROUTE_SPECS.map((s) => s.operationId)).toEqual(["media.bind", "media.heartbeat", "media.lifecycle", "media.consentDecision", "media.processingReport", "media.recorders", "media.humanRoute", "media.safetyRoute"]);
    expect(MEDIA_ROUTE_SPECS.filter((s) => s.rateLimitExempt).map((s) => s.operationId)).toEqual(["media.humanRoute", "media.safetyRoute"]);
  });
});

describe("media routes: binding and stale generations [AUTH-03][FO-10-46]", () => {
  it("[AUTH-03][FO-10-46] issue, recover after owner loss, and refuse the stale generation with 409 at the gateway", async () => {
    plane.jobs.set("AJ_synthJob0001", "agent-AJ_synthJob0001");
    plane.agents.add("agent-AJ_synthJob0001");
    const first = await post("/media/v1/calls/bindings", bindBody("AJ_synthJob0001", "media-worker-a1"), await runtimeToken());
    expect(first.statusCode, first.body).toBe(201);
    const old = first.json() as { claim: { bindingId: string; sessionGeneration: number }; binding: { carrier: unknown } };
    expect(old.binding.carrier).toEqual(plane.carrier);
    // Worker crash: its agent leaves; a new job for a new worker is dispatched.
    plane.agents.delete("agent-AJ_synthJob0001");
    plane.jobs.set("AJ_synthJob0002", "agent-AJ_synthJob0002");
    plane.agents.add("agent-AJ_synthJob0002");
    const second = await post("/media/v1/calls/bindings", bindBody("AJ_synthJob0002", "media-worker-a2"), await runtimeToken());
    expect(second.statusCode, second.body).toBe(201);
    const fresh = second.json() as { claim: { bindingId: string; sessionGeneration: number }; issue: string };
    expect(fresh.issue).toBe("REBOUND_AFTER_OWNER_LOSS");
    expect(fresh.claim.sessionGeneration).toBeGreaterThan(old.claim.sessionGeneration);
    const stale = await post(`/media/v1/calls/bindings/${old.claim.bindingId}/heartbeat`, { claim: old.claim }, await runtimeToken());
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: { reasonCode: "BINDING_SUPERSEDED" } });
    const forged = await post(`/media/v1/calls/bindings/${fresh.claim.bindingId}/heartbeat`, { claim: { ...fresh.claim, sessionGeneration: old.claim.sessionGeneration } }, await runtimeToken());
    expect(forged.statusCode).toBe(409);
    expect(forged.json()).toMatchObject({ error: { reasonCode: "BINDING_GENERATION_STALE" } });
    const ok = await post(`/media/v1/calls/bindings/${fresh.claim.bindingId}/heartbeat`, { claim: fresh.claim }, await runtimeToken());
    expect(ok.statusCode, ok.body).toBe(200);
    // A claim for one binding under another binding's path is refused.
    const mismatch = await post(`/media/v1/calls/bindings/${old.claim.bindingId}/heartbeat`, { claim: fresh.claim }, await runtimeToken());
    expect(mismatch.json()).toMatchObject({ error: { reasonCode: "BINDING_PATH_MISMATCH" } });
    // OPS-01: the issuance and the recovery are in the audit store (its own event grammar applied), each pointing at
    // its binding with a typed reference the store accepts.
    expect(auditStore.byAction("call.binding.issued").map((e) => e.evidencePointers)).toContainEqual([`call_binding:${old.claim.bindingId}`]);
    expect(auditStore.byAction("call.binding.recovered").map((e) => e.evidencePointers)).toContainEqual([`call_binding:${fresh.claim.bindingId}`]);
  });
});

describe("media routes: human and safety routes without a binding [SAFE-02]", () => {
  it("[SAFE-02] positive: a worker with no live binding gets a person and the safety route; the destination is the trusted one", async () => {
    const h = await post("/media/v1/calls/human-route", { roomName: "room-a", reason: "BINDING_UNAVAILABLE", language: "en" }, await runtimeToken());
    expect(h.statusCode, h.body).toBe(200);
    expect(h.json()).toMatchObject({ accepted: true, destinationId: "dst_support_general" });
    expect(handoff.human.at(-1)).toMatchObject({ reason: "DEPENDENCY_FAILURE", ctx: null });
    const s = await post("/media/v1/calls/safety-route", { roomName: "room-a", locale: "en-US", signals: [{ source: "FAIL_SAFE", ruleId: "media.runtime.fail_safe", strength: "UNRESOLVED", subject: "UNKNOWN", temporal: "UNKNOWN", negated: false }] }, await runtimeToken());
    expect(s.statusCode, s.body).toBe(200);
    expect(s.json()).toMatchObject({ accepted: true, destinationId: "dst_safety_priority" });
    expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(["media.route.human_requested", "media.route.safety_requested"]));
  });

  it("[SAFE-02][SAFE-03] failure injection: with the binding routes rate limited, the media plane down and the handoff store failing, the routes still answer with the trusted destination", async () => {
    // Exhaust the binding routes' limit (8 per window and credential): they are refused 429...
    let limited = 0;
    for (let i = 0; i < 12; i++) {
      const r = await post("/media/v1/calls/bindings/cbd_synthBinding00000001/heartbeat", { claim: { bindingId: "cbd_synthBinding00000001", tenantId: TENANT, interactionId: "int_synthInteraction0001", sessionGeneration: 1, fencingToken: 1 } }, await runtimeToken());
      if (r.statusCode === 429) limited += 1;
    }
    expect(limited).toBeGreaterThan(0);
    // The bucket is the call's: another binding of the same runtime credential is not limited by this one's flood.
    const other = await post("/media/v1/calls/bindings/cbd_synthBinding00000002/heartbeat", { claim: { bindingId: "cbd_synthBinding00000002", tenantId: TENANT, interactionId: "int_synthInteraction0002", sessionGeneration: 1, fencingToken: 1 } }, await runtimeToken());
    expect(other.statusCode).toBe(409);
    expect(other.json()).toMatchObject({ error: { reasonCode: "BINDING_NOT_FOUND" } });
    // ...while the human and safety routes are never limited, and fail safe when their dependencies fail.
    plane.down = true;
    handoff.failing = true;
    for (let i = 0; i < 5; i++) {
      const h = await post("/media/v1/calls/human-route", { roomName: "room-a", reason: "CALLER_REQUESTED_HUMAN", language: "en" }, await runtimeToken());
      expect(h.statusCode).toBe(200);
      expect(h.json()).toMatchObject({ accepted: false, destinationId: "dst_support_general", reasonCode: "HANDOFF_REQUEST_FAILED" });
    }
    const s = await post("/media/v1/calls/safety-route", { roomName: "room-a", locale: "en-US", signals: [{ source: "CALLER_REQUEST", ruleId: "media.caller.request", strength: "CREDIBLE", subject: "SELF", temporal: "CURRENT", negated: false }] }, await runtimeToken());
    expect(s.statusCode).toBe(200);
    expect(s.json()).toMatchObject({ accepted: false, destinationId: "dst_safety_priority" });
  });

  it("[SAFE-02] adversarial (STRIDE-D): a room the media plane positively reports as not existing is refused by both routes, with no handoff; a media-plane outage still routes", async () => {
    const humans = handoff.human.length;
    const safeties = handoff.safety.length;
    for (let i = 0; i < 5; i++) {
      const h = await post("/media/v1/calls/human-route", { roomName: `no-such-room-${i}`, reason: "CALLER_REQUESTED_HUMAN", language: "en" }, await runtimeToken());
      expect(h.statusCode).toBe(403);
      expect(h.json()).toMatchObject({ error: { reasonCode: "MEDIA_ROOM_NOT_FOUND" } });
      const s = await post("/media/v1/calls/safety-route", { roomName: `no-such-room-${i}`, locale: "en-US", signals: [SIGNAL] }, await runtimeToken());
      expect(s.statusCode).toBe(403);
    }
    expect(handoff.human.length).toBe(humans);
    expect(handoff.safety.length).toBe(safeties);
    plane.down = true;
    const routed = await post("/media/v1/calls/human-route", { roomName: "no-such-room-0", reason: "CALLER_REQUESTED_HUMAN", language: "en" }, await runtimeToken());
    expect(routed.json()).toMatchObject({ accepted: true });
    expect(handoff.human.length).toBe(humans + 1);
  });

  it("[SAFE-02] one room gets at most one standard and one safety handoff: repeated requests are answered from the accepted request; a failed one stays owed and is retried with its first reason", async () => {
    plane.addRoom("room-dedupe");
    handoff.failing = true;
    const failed = await post("/media/v1/calls/human-route", { roomName: "room-dedupe", reason: "CALLER_REQUESTED_HUMAN", language: "en" }, await runtimeToken());
    expect(failed.json()).toMatchObject({ accepted: false, reasonCode: "HANDOFF_REQUEST_FAILED" });
    handoff.failing = false;
    const humans = handoff.human.length;
    const answers = [];
    for (let i = 0; i < 5; i++) answers.push((await post("/media/v1/calls/human-route", { roomName: "room-dedupe", reason: "BINDING_UNAVAILABLE", language: "en" }, await runtimeToken())).json());
    expect(handoff.human.length).toBe(humans + 1);
    // The retry used the reason the caller first gave (CALLER_REQUESTED_HUMAN), not the later one.
    expect(handoff.human.at(-1)).toMatchObject({ reason: "CALLER_REQUESTED_HUMAN" });
    expect(answers[0]).toMatchObject({ accepted: true, reasonCode: "HANDOFF_REQUESTED", handoffId: "hnd_synthHandoff000001" });
    for (const a of answers.slice(1)) expect(a).toMatchObject({ accepted: true, reasonCode: "HANDOFF_ALREADY_ACCEPTED", handoffId: "hnd_synthHandoff000001", destinationId: "dst_support_general", speechTemplateId: "human.offer" });
    // The safety route is its own request: once, then answered from the record.
    const safeties = handoff.safety.length;
    for (let i = 0; i < 3; i++) expect((await post("/media/v1/calls/safety-route", { roomName: "room-dedupe", locale: "en-US", signals: [SIGNAL] }, await runtimeToken())).json()).toMatchObject({ accepted: true, destinationId: "dst_safety_priority" });
    expect(handoff.safety.length).toBe(safeties + 1);
    // With the safety route accepted, a person request is answered with it.
    expect((await post("/media/v1/calls/human-route", { roomName: "room-dedupe", reason: "CALLER_REQUESTED_HUMAN", language: "en" }, await runtimeToken())).json()).toMatchObject({ accepted: true, handoffId: "hnd_synthHandoff000002" });
  });

  it("[SAFE-02] concurrent requests for one room (a live owner told a person is owed while the request that recorded it is still attempting the handoff): one handoff; the other is answered HANDOFF_IN_PROGRESS, then from the record; an attempt whose holder died lapses", async () => {
    plane.addRoom("room-inflight");
    const real = handoff.requestHuman.bind(handoff);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    handoff.requestHuman = async (i) => {
      await gate;
      return real(i);
    };
    try {
      const humans = handoff.human.length;
      const first = post("/media/v1/calls/human-route", { roomName: "room-inflight", reason: "CALLER_REQUESTED_HUMAN", language: "en" }, await runtimeToken());
      await new Promise((r) => setTimeout(r, 50));
      const second = await post("/media/v1/calls/human-route", { roomName: "room-inflight", reason: "RECOVERY_FAILED", language: "en" }, await runtimeToken());
      expect(second.json()).toMatchObject({ accepted: false, reasonCode: "HANDOFF_IN_PROGRESS", destinationId: "dst_support_general", handoffId: null });
      // The supervisor's route is told the same (it throws, so it retries on its next sweep).
      await expect(supervisorRoute()("room-inflight")).rejects.toMatchObject({ reasonCode: "HANDOFF_IN_PROGRESS" });
      release();
      expect((await first).json()).toMatchObject({ accepted: true, reasonCode: "HANDOFF_REQUESTED" });
      expect((await post("/media/v1/calls/human-route", { roomName: "room-inflight", reason: "RECOVERY_FAILED", language: "en" }, await runtimeToken())).json()).toMatchObject({ accepted: true, reasonCode: "HANDOFF_ALREADY_ACCEPTED" });
      expect(handoff.human.length).toBe(humans + 1);
    } finally {
      handoff.requestHuman = real;
    }
    // A request whose gateway instance died mid-attempt: its attempt lapses, then the next request attempts itself.
    plane.addRoom("room-lapsed");
    const room = await bindingService.roomForRoute("room-lapsed");
    const at = { roomSid: room.roomSid as string, interactionId: room.interactionId };
    await bindingService.notePersonRequested(at, { kind: "standard", reason: "CALLER_REQUESTED_HUMAN", language: "en" }, { holder: "cpa_synthDeadHolder01", leaseMs: PERSON_ATTEMPT_LEASE_MS });
    expect((await post("/media/v1/calls/human-route", { roomName: "room-lapsed", reason: "RECOVERY_FAILED", language: "en" }, await runtimeToken())).json()).toMatchObject({ accepted: false, reasonCode: "HANDOFF_IN_PROGRESS" });
    clock.advanceMs(PERSON_ATTEMPT_LEASE_MS + 1);
    const humans = handoff.human.length;
    expect((await post("/media/v1/calls/human-route", { roomName: "room-lapsed", reason: "RECOVERY_FAILED", language: "en" }, await runtimeToken())).json()).toMatchObject({ accepted: true, reasonCode: "HANDOFF_REQUESTED" });
    expect(handoff.human.at(-1)).toMatchObject({ reason: "CALLER_REQUESTED_HUMAN" });
    expect(handoff.human.length).toBe(humans + 1);
  });

  it("[SAFE-02] a handoff the HandoffService could not place (no destination resolves, or the transfer request failed: the next-route prompt with no journey) is not a person on the call: the room stays owed, the attempt is released, the supervisor's route throws so it retries; once placed, the person is recorded", async () => {
    const sid = plane.addRoom("room-unplaced");
    const real = handoff.requestHuman.bind(handoff);
    let placed = 0;
    handoff.requestHuman = async () => {
      placed++;
      return { handoffId: "hnd_synthHandoff000003", transferId: null, destinationId: "dst_unconfigured", journey: null, speechTemplateId: "transfer.failed_next_route", supportReference: null, priority: "STANDARD" as const };
    };
    try {
      const first = await post("/media/v1/calls/human-route", { roomName: "room-unplaced", reason: "CALLER_REQUESTED_HUMAN", language: "en" }, await runtimeToken());
      expect(first.json()).toMatchObject({ accepted: false, reasonCode: "HANDOFF_NOT_PLACED", handoffId: null, destinationId: "dst_support_general", speechTemplateId: "transfer.failed_next_route" });
      expect(audits.at(-1)).toMatchObject({ action: "media.route.human_requested", outcome: "FAILED", reasonCode: "HANDOFF_NOT_PLACED" });
      expect(await bindingService.personStateOfRoom({ sid })).toBe("OUTSTANDING");
      // The attempt was released: the next request attempts the handoff again at once (never HANDOFF_IN_PROGRESS).
      expect((await post("/media/v1/calls/human-route", { roomName: "room-unplaced", reason: "RECOVERY_FAILED", language: "en" }, await runtimeToken())).json()).toMatchObject({ accepted: false, reasonCode: "HANDOFF_NOT_PLACED" });
      await expect(supervisorRoute()("room-unplaced")).rejects.toMatchObject({ reasonCode: "HANDOFF_NOT_PLACED" });
      expect(placed).toBe(3);
      expect(await bindingService.personStateOfRoom({ sid })).toBe("OUTSTANDING");
    } finally {
      handoff.requestHuman = real;
    }
    // Placed now: the person is recorded for the room, with the reason the caller first gave.
    expect((await post("/media/v1/calls/human-route", { roomName: "room-unplaced", reason: "RECOVERY_FAILED", language: "en" }, await runtimeToken())).json()).toMatchObject({ accepted: true, reasonCode: "HANDOFF_REQUESTED" });
    expect(handoff.human.at(-1)).toMatchObject({ reason: "CALLER_REQUESTED_HUMAN" });
    expect(await bindingService.personStateOfRoom({ sid })).toBe("WITH_PERSON");
  });

  it("[SAFE-02] a safety route still owed outranks a person request: the human route retries the safety route with the recorded signals", async () => {
    plane.addRoom("room-owed-safety");
    handoff.safetyFailing = true;
    expect((await post("/media/v1/calls/safety-route", { roomName: "room-owed-safety", locale: "en-US", signals: [SIGNAL] }, await runtimeToken())).json()).toMatchObject({ accepted: false });
    handoff.safetyFailing = false;
    const humans = handoff.human.length;
    const h = await post("/media/v1/calls/human-route", { roomName: "room-owed-safety", reason: "CALLER_REQUESTED_HUMAN", language: "en" }, await runtimeToken());
    expect(h.json()).toMatchObject({ accepted: true, reasonCode: "SAFETY_ROUTE_INITIATED", destinationId: "dst_safety_priority" });
    expect(handoff.human.length).toBe(humans);
    expect(handoff.safety.at(-1)).toMatchObject({ ruleIds: ["safety.self_harm.explicit"] });
  });
});

describe("supervisor human route (SAFE-02) [FO-19-10]", () => {
  it("[SAFE-02] an unrecovered room goes to a person without any runtime credential, binding or session, and the route is audited", async () => {
    plane.addRoom("room-sup-1");
    const before = handoff.human.length;
    await supervisorRoute()("room-sup-1");
    expect(handoff.human.length).toBe(before + 1);
    expect(handoff.human.at(-1)).toMatchObject({ reason: "DEPENDENCY_FAILURE", ctx: null });
    expect(audits.at(-1)).toMatchObject({ action: "media.route.human_requested", outcome: "SUCCEEDED", reasonCode: "RECOVERY_FAILED" });
    // A room the media plane reports gone has no caller to route: refused, never routed under a guessed interaction.
    await expect(supervisorRoute({ record: async () => undefined })("room-unknown")).rejects.toMatchObject({ reasonCode: "MEDIA_ROOM_NOT_FOUND" });
  });

  it("[SAFE-02] failure injection: with the media plane unavailable the person is still requested (a fresh, unattributed interaction); a failed handoff throws so the supervisor retries, and the request stays owed", async () => {
    const route = supervisorRoute();
    const sid = plane.addRoom("room-sup-2");
    plane.down = true;
    const before = handoff.human.length;
    await route("room-sup-2");
    expect(handoff.human.length).toBe(before + 1);
    expect(handoff.human.at(-1)?.callId).toMatch(/^int_/);
    expect(audits.at(-1)).toMatchObject({ action: "media.route.human_requested", outcome: "SUCCEEDED", reasonCode: "ROUTE_UNATTRIBUTED" });
    plane.down = false;
    const sid3 = plane.addRoom("room-sup-3");
    handoff.failing = true;
    await expect(route("room-sup-3")).rejects.toMatchObject({ reasonCode: "HANDOFF_REQUEST_FAILED" });
    expect(audits.at(-1)).toMatchObject({ action: "media.route.human_requested", outcome: "FAILED" });
    expect(await supervisorPersonState(bindingService)({ name: "room-sup-3", sid: sid3 })).toBe("OUTSTANDING");
    // Unattributed (the media plane could not name the room): nothing was recorded for it.
    expect(await supervisorPersonState(bindingService)({ name: "room-sup-2", sid })).toBe("NONE");
    handoff.failing = false;
    await route("room-sup-3");
    expect(await supervisorPersonState(bindingService)({ name: "room-sup-3", sid: sid3 })).toBe("WITH_PERSON");
  });

  it("[SAFE-02] a room still owed the SAFETY route: the supervisor's route retries the safety route with the recorded signals, not a standard person", async () => {
    plane.addRoom("room-sup-4");
    handoff.safetyFailing = true;
    const s = await post("/media/v1/calls/safety-route", { roomName: "room-sup-4", locale: "en-US", signals: [SIGNAL] }, await runtimeToken());
    expect(s.json()).toMatchObject({ accepted: false, reasonCode: "SAFETY_ROUTE_FAILED" });
    handoff.safetyFailing = false;
    const humans = handoff.human.length;
    await supervisorRoute()("room-sup-4");
    expect(handoff.human.length).toBe(humans);
    expect(handoff.safety.at(-1)).toMatchObject({ ruleIds: ["safety.self_harm.explicit"], ctx: null });
  });

  it("[SAFE-02] the session-less routes accept any room name the media plane assigns (a dispatch-rule prefix with a space and a slash)", async () => {
    const h = await post("/media/v1/calls/human-route", { roomName: "support line/01", reason: "CALLER_REQUESTED_HUMAN", language: "en" }, await runtimeToken());
    expect(h.statusCode, h.body).toBe(200);
    expect(h.json()).toMatchObject({ accepted: true });
    const long = await post("/media/v1/calls/human-route", { roomName: "r".repeat(257), reason: "CALLER_REQUESTED_HUMAN", language: "en" }, await runtimeToken());
    expect(long.statusCode).toBe(400);
  });
});
