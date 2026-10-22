/**
 * CallBinding issuance, recovery and claim checks (WP-11; FO-05-16, FO-10-09, FO-10-46, FO-01-27; AUTH-03, AUTH-04,
 * DATA-03, OPS-01).
 *
 * Layer 1: the production CallBindingService over the production CallBindingStore, the production TrustedSessionService
 * (through the gateway's sessionServiceCallSessions adapter) and the production AES-256-GCM sealer. LOCAL FIXTURE /
 * labelled unit fakes: the in-memory KV store (MemoryKvStoreFixture), the media-plane lookup (FakeMediaPlane below),
 * the action invalidator and the audit sink recorders. The same service runs against DynamoDB Local and livekit-server
 * in the Layer-2 media suite (platform/test/integration/media).
 */
import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { AesGcmTokenSealer } from "../../console-api/token-sealer.js";
import { sessionServiceCallSessions } from "../../gateway/http/media-routes.js";
import { statusForError } from "../../gateway/http/route.js";
import { sessionConfig } from "../../identity/config.js";
import { MemoryKvStoreFixture } from "../../identity/kv/memory-kv-store.js";
import { TrustedSessionService } from "../../identity/session-service.js";
import type { IntegrationIdentity } from "../../protocol/index.js";
import type { MediaBindRequest, MediaBindingClaim, MediaProcessingState } from "../../protocol/call-binding.js";
import { FakeClock } from "../../shared/clock.js";
import { AccessDeniedError, AuditUnavailableError, DependencyError, ValidationError } from "../../shared/errors.js";
import { partyDigestOf } from "./livekit-lookup.js";
import type { BindingAuditEvent, BindingAuditSink, CarrierInteractionLookup, CarrierLookupInput, MediaRoomFacts, PendingActionInvalidator, RuntimeIdentity, SipParty } from "./ports.js";
import { BindingRefusedError, CallBindingService, claimOf } from "./service.js";
import type { CallBindingServiceConfig } from "./service.js";
import { CallBindingStore } from "./store.js";

const TENANT = "tnt_synthTenantMedia0001";

/**
 * LOCAL FIXTURE (unit fake): what the media plane's own API states for each room (server id, active SIP parties with
 * their `sip.callID`, jobs dispatched and agents present). Party identities are digested as the production lookup does.
 */
class FakeMediaPlane implements CarrierInteractionLookup {
  readonly rooms = new Map<string, { sid: string; sip: SipParty[]; jobs: Map<string, string>; agents: Set<string> }>();
  available = true;
  private clockMs = 1_000;
  /** A SIP call room: the caller's SIP participant carries the media plane's call id. */
  addSipRoom(room: string, callId: string, o: { sid?: string; identity?: string; trunk?: string | null } = {}): void {
    this.rooms.set(room, { sid: o.sid ?? `RM_synth${room.replace(/[^A-Za-z0-9]/g, "")}01`, sip: [], jobs: new Map(), agents: new Set() });
    this.addSipParty(room, o.identity ?? "sip_synthCaller", callId, o.trunk === undefined ? "sip-trunk:ST_synthTrunk01" : o.trunk);
  }
  /** A WebRTC call room: no SIP party; the room's server id names the call. */
  addWebRoom(room: string, sid: string): void {
    this.rooms.set(room, { sid, sip: [], jobs: new Map(), agents: new Set() });
  }
  addSipParty(room: string, identity: string, callId: string | null, routeRef: string | null = null, joinedAtMs?: number): void {
    this.rooms.get(room)!.sip.push({ partyDigest: partyDigestOf(identity), interactionRef: callId, routeRef, joinedAtMs: joinedAtMs ?? (this.clockMs += 1_000) });
  }
  removeSipParty(room: string, identity: string): void {
    const r = this.rooms.get(room)!;
    r.sip = r.sip.filter((p) => p.partyDigest !== partyDigestOf(identity));
  }
  /** What a holder of the media-plane API secret can do: rewrite a participant's `sip.callID` (UpdateParticipant). */
  rewriteCallId(room: string, identity: string, callId: string): void {
    const r = this.rooms.get(room)!;
    r.sip = r.sip.map((p) => (p.partyDigest === partyDigestOf(identity) ? { ...p, interactionRef: callId } : p));
  }
  dispatch(room: string, job: string, agent: string): void {
    const r = this.rooms.get(room)!;
    r.jobs.set(job, agent);
    r.agents.add(agent);
  }
  leave(room: string, agent: string): void {
    this.rooms.get(room)!.agents.delete(agent);
  }
  private facts(r: { sid: string; sip: SipParty[] }): MediaRoomFacts {
    return { roomSid: r.sid, sipParties: [...r.sip].sort((a, b) => a.joinedAtMs - b.joinedAtMs) };
  }
  async verify(input: CarrierLookupInput) {
    if (!this.available) throw new DependencyError("LIVEKIT_API_UNAVAILABLE", "FAILED", true);
    const r = this.rooms.get(input.roomName);
    if (!r) throw new AccessDeniedError("MEDIA_ROOM_NOT_FOUND");
    if (r.jobs.get(input.jobRef) !== input.agentIdentity) throw new AccessDeniedError("MEDIA_JOB_NOT_DISPATCHED");
    if (!r.agents.has(input.agentIdentity)) throw new AccessDeniedError("MEDIA_AGENT_NOT_IN_ROOM");
    return { ...this.facts(r), presentAgents: [...r.agents] };
  }
  async describeRoom(input: { roomName: string }) {
    if (!this.available) throw new DependencyError("LIVEKIT_API_UNAVAILABLE", "FAILED", true);
    const r = this.rooms.get(input.roomName);
    if (!r) throw new AccessDeniedError("MEDIA_ROOM_NOT_FOUND");
    return this.facts(r);
  }
}

/** Labelled unit fake of ActionService.invalidatePending: records the calls and reports one invalidated action each. */
class RecordingInvalidator implements PendingActionInvalidator {
  readonly calls: { sessionRef: string; reasonCode: string }[] = [];
  async invalidatePending(sessionRef: string, reasonCode: string): Promise<number> {
    this.calls.push({ sessionRef, reasonCode });
    return 1;
  }
}

class RecordingAudit implements BindingAuditSink {
  readonly events: BindingAuditEvent[] = [];
  failing = false;
  /** Actions whose next write fails once (one outage of the audit writer). */
  readonly failOnce = new Set<string>();
  /** Actions whose next write never returns: the gateway instance writing it died mid-request (nothing lands, nothing is marked). */
  readonly hangOnce = new Set<string>();
  async record(e: BindingAuditEvent): Promise<void> {
    if (this.failing) throw new Error("AUDIT_DOWN");
    if (this.failOnce.delete(e.action)) throw new Error("AUDIT_DOWN");
    if (this.hangOnce.delete(e.action)) return new Promise<void>(() => undefined);
    this.events.push(e);
  }
}

const runtime = (o: Partial<RuntimeIdentity> = {}): RuntimeIdentity => ({
  integrationId: "vsp-media-runtime",
  tenantId: TENANT,
  environment: "ci",
  channel: "conversation_runtime",
  credentialId: "cred-media-runtime-01",
  authMethod: "oauth2_client_credentials",
  adapters: ["controlled_cascade_runtime"],
  ...o,
});

const carrierIntegration: IntegrationIdentity = { integrationId: "livekit-media-plane", tenantId: TENANT, environment: "ci", channel: "telephony_control", credentialId: "cred-media-plane-01", authMethod: "mtls" };

const bindReq = (room: string, job: string, worker: string): MediaBindRequest => ({ roomName: room, jobRef: job, workerInstanceRef: worker, agentIdentity: `agent-${job}`, adapter: "controlled_cascade_runtime" });

function setup(cfg: Partial<CallBindingServiceConfig> = {}, o: { sessionTtlSeconds?: number } = {}) {
  const clock = new FakeClock("2026-10-21T12:00:00.000Z");
  const kv = new MemoryKvStoreFixture();
  const sessions = new TrustedSessionService({
    kv,
    clock,
    config: sessionConfig({ tenantId: TENANT, environment: "ci", policyVersion: "policy-ci-2026.10.21", sessionTtlSeconds: o.sessionTtlSeconds ?? 3_600, startCallChannels: ["telephony_control"], consentChannels: ["telephony_control"], resolveChannels: ["telephony_control", "mcp_tools"] }),
  });
  const plane = new FakeMediaPlane();
  const actions = new RecordingInvalidator();
  const audit = new RecordingAudit();
  const store = new CallBindingStore(kv);
  const sealer = new AesGcmTokenSealer({ current: { id: "binding-seal-k1", key: randomBytes(32) } });
  // The production session port, with the session starts counted (each start supersedes the call's previous session).
  const port = sessionServiceCallSessions(sessions, carrierIntegration, clock);
  const sessionStarts: string[] = [];
  const sessionFaults = { failStarts: 0 };
  const counted = {
    ...port,
    start: async (callId: string) => {
      sessionStarts.push(callId);
      if (sessionFaults.failStarts > 0) {
        sessionFaults.failStarts--;
        throw new DependencyError("SESSION_STORE_UNAVAILABLE", "FAILED", true);
      }
      return port.start(callId);
    },
  };
  const service = new CallBindingService(
    { tenantId: TENANT, environment: "ci", bindingTtlSeconds: 90, heartbeatIntervalSeconds: 15, recordingDeclinedRoute: "CONTINUE_UNRECORDED", ...cfg },
    { store, sessions: counted, lookup: plane, sealer, actions, audit, clock },
  );
  plane.addSipRoom("room-a", "SCL_synthCallA0001");
  return { clock, kv, sessions, sessionStarts, sessionFaults, plane, actions, audit, store, service };
}

type Env = ReturnType<typeof setup>;
let env: Env;
beforeEach(() => {
  env = setup();
});

async function firstBind(e: Env = env, job = "AJ_synthJobA0001", worker = "media-worker-a1") {
  e.plane.dispatch("room-a", job, `agent-${job}`);
  return e.service.bind(runtime(), bindReq("room-a", job, worker), "cor_synthCorrelation0001");
}

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    return (err as { reasonCode?: string }).reasonCode ?? String(err);
  }
  return "NOT_REFUSED";
}

describe("CallBinding issuance [FO-05-16][AUTH-03]", () => {
  it("[FO-05-16][AUTH-03] positive: the binding names the carrier interaction the media plane reported and the session's current generation", async () => {
    const r = await firstBind();
    expect(r.issue).toBe("NEW_CALL");
    expect(r.binding.carrier).toEqual({ kind: "sip_reference", interactionRef: "SCL_synthCallA0001", routeRef: "sip-trunk:ST_synthTrunk01" });
    expect(r.binding.boundBy).toBe("trusted_server_lookup");
    expect(r.binding.sessionGeneration).toBe(1);
    expect(r.binding.owner).toEqual({ adapter: "controlled_cascade_runtime", instanceRef: "media-worker-a1", fencingToken: 1 });
    expect(r.binding.sessionBindingRef).toMatch(/^ses_bnd_[A-Za-z0-9_-]{43}$/);
    expect(r.claim).toEqual(claimOf(r.binding));
    // UNKNOWN consent at call start: nothing may record or process until the trusted capture (DATA-03).
    expect(r.directive.recording.value).toBe("UNKNOWN");
    expect(r.directive.transcriptionAiProcessing.value).toBe("UNKNOWN");
    expect(env.audit.events.map((e) => e.action)).toEqual(["call.binding.issued"]);
  });

  it("[AUTH-06][DATA-01] the bearer session reference is stored only sealed; no carrier id, room name or caller number is a key", async () => {
    const r = await firstBind();
    const { sessionRef } = await env.service.resolveClaim(runtime(), r.claim);
    // Test-only view of the in-memory fixture's items (the DynamoDB table holds exactly these attributes).
    const raw = JSON.stringify([...(env.kv as unknown as { items: Map<string, unknown> }).items.entries()]);
    expect(raw).toContain("vsp.call-binding-record.v3");
    expect(raw).not.toContain(sessionRef);
    expect(raw).toContain(r.binding.sessionBindingRef);
    expect(raw).not.toContain("room-a");
    expect(raw).not.toMatch(/"(cbr|cbx|cbm)#[^"]*(SCL_|RM_)/);
    // The caller's SIP participant identity is kept only as a digest.
    expect(raw).not.toContain("sip_synthCaller");
  });

  it("[AUTH-03] adversarial: the media plane's refusal (job not dispatched to this agent) refuses the binding and is audited", async () => {
    env.plane.dispatch("room-a", "AJ_synthJobA0001", "agent-AJ_synthJobA0001");
    const forged = { ...bindReq("room-a", "AJ_synthJobA0001", "media-worker-x9"), agentIdentity: "agent-impostor" };
    expect(await refusal(env.service.bind(runtime(), forged, "cor_synthCorrelation0002"))).toBe("MEDIA_JOB_NOT_DISPATCHED");
    expect(env.audit.events.at(-1)).toMatchObject({ action: "call.binding.refused", outcome: "DENIED", reasonCode: "MEDIA_JOB_NOT_DISPATCHED" });
  });

  it("[AUTH-03] adversarial: another tenant, environment or a non-runtime adapter credential is refused before any lookup", async () => {
    env.plane.dispatch("room-a", "AJ_synthJobA0001", "agent-AJ_synthJobA0001");
    const req = bindReq("room-a", "AJ_synthJobA0001", "media-worker-a1");
    expect(await refusal(env.service.bind(runtime({ tenantId: "tnt_synthTenantOther0001" }), req, "cor_synthCorrelation0003"))).toBe("RUNTIME_TENANT_MISMATCH");
    expect(await refusal(env.service.bind(runtime({ environment: "production" }), req, "cor_synthCorrelation0003"))).toBe("RUNTIME_ENVIRONMENT_MISMATCH");
    expect(await refusal(env.service.bind(runtime({ adapters: ["native_duplex_runtime"] }), req, "cor_synthCorrelation0003"))).toBe("RUNTIME_ADAPTER_NOT_ALLOWED");
  });

  it("[OPS-01] failure injection: issuance without durable audit evidence is refused (fail closed)", async () => {
    env.audit.failing = true;
    await expect(firstBind()).rejects.toBeInstanceOf(AuditUnavailableError);
  });

  it("a retry from the same worker and job returns the same binding (idempotent issuance)", async () => {
    const a = await firstBind();
    const b = await env.service.bind(runtime(), bindReq("room-a", "AJ_synthJobA0001", "media-worker-a1"), "cor_synthCorrelation0004");
    expect(b.binding.bindingId).toBe(a.binding.bindingId);
    expect(b.claim).toEqual(a.claim);
  });

  it("[AUTH-03] concurrent first binds of two workers: exactly one owns the call and its session is the live one", async () => {
    env.plane.dispatch("room-a", "AJ_synthJobA0001", "agent-AJ_synthJobA0001");
    env.plane.dispatch("room-a", "AJ_synthJobB0001", "agent-AJ_synthJobB0001");
    const results = await Promise.allSettled([
      env.service.bind(runtime(), bindReq("room-a", "AJ_synthJobA0001", "media-worker-a1"), "cor_synthCorrelation0005"),
      env.service.bind(runtime(), bindReq("room-a", "AJ_synthJobB0001", "media-worker-b1"), "cor_synthCorrelation0006"),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    expect(ok).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((rejected.reason as BindingRefusedError).reasonCode).toBe("BINDING_OWNER_ACTIVE");
    const winner = (ok[0] as PromiseFulfilledResult<Awaited<ReturnType<CallBindingService["bind"]>>>).value;
    // The surviving binding's session is live (the only one started): a heartbeat succeeds.
    expect(env.sessionStarts).toHaveLength(1);
    await expect(env.service.heartbeat(runtime(), winner.claim, "cor_synthCorrelation0007")).resolves.toMatchObject({ state: "ACTIVE" });
  });

  it("[AUTH-03][FO-10-46] a worker's retry racing its own first bind (the first answer lost in transit under load): one session is started, the call keeps ONE active binding with a live session, and the retry answers that same binding", async () => {
    env.plane.dispatch("room-a", "AJ_synthJobA0001", "agent-AJ_synthJobA0001");
    const req = bindReq("room-a", "AJ_synthJobA0001", "media-worker-a1");
    const results = await Promise.allSettled([env.service.bind(runtime(), req, "cor_synthCorrelation0051"), env.service.bind(runtime(), req, "cor_synthCorrelation0052")]);
    const answered = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<CallBindingService["bind"]>>> => r.status === "fulfilled").map((r) => r.value);
    expect(answered.length).toBeGreaterThanOrEqual(1);
    // A request that lost the race is refused retryably (the worker's recovery policy asks again), never revoked.
    for (const r of results) if (r.status === "rejected") expect(r.reason).toMatchObject({ reasonCode: "BINDING_CONCURRENT_UPDATE", retryable: true });
    const again = await env.service.bind(runtime(), req, "cor_synthCorrelation0053");
    for (const a of answered) expect(a.claim).toEqual(again.claim);
    expect(again.binding).toMatchObject({ state: "ACTIVE", sessionGeneration: 1, owner: { fencingToken: 1 } });
    // Only the request that created the call started a session: nothing superseded the session the record names.
    expect(env.sessionStarts).toHaveLength(1);
    await expect(env.service.heartbeat(runtime(), again.claim, "cor_synthCorrelation0054")).resolves.toMatchObject({ state: "ACTIVE" });
    expect(env.audit.events.filter((e) => e.action === "call.binding.revoked")).toEqual([]);
    expect(env.audit.events.filter((e) => e.action === "call.binding.issued")).toHaveLength(1);
  });

  it("[FO-10-46] failure injection: a first bind that failed before creating the record gives the lease up (the retry binds at once); a lease left by a request that died is taken over once it ran out", async () => {
    env.plane.dispatch("room-a", "AJ_synthJobA0001", "agent-AJ_synthJobA0001");
    const req = bindReq("room-a", "AJ_synthJobA0001", "media-worker-a1");
    env.sessionFaults.failStarts = 1;
    await expect(env.service.bind(runtime(), req, "cor_synthCorrelation0055")).rejects.toMatchObject({ reasonCode: "SESSION_STORE_UNAVAILABLE" });
    await expect(env.service.bind(runtime(), req, "cor_synthCorrelation0056")).resolves.toMatchObject({ issue: "NEW_CALL", binding: { state: "ACTIVE" } });

    // A gateway instance took the lease of another call and died before creating its record.
    env.plane.addSipRoom("room-b", "SCL_synthCallB0001");
    env.plane.dispatch("room-b", "AJ_synthJobB0001", "agent-AJ_synthJobB0001");
    const reqB = bindReq("room-b", "AJ_synthJobB0001", "media-worker-a1");
    const { interactionId } = await env.service.interactionOfRoom("room-b");
    expect(await env.store.takeFirstBindLease({ tenantId: TENANT, interactionId, holder: "cbl_synthDeadHolder01", nowMs: env.clock.now().getTime(), leaseMs: 15_000 })).toBe(true);
    const startsBefore = env.sessionStarts.length;
    await expect(env.service.bind(runtime(), reqB, "cor_synthCorrelation0058")).rejects.toMatchObject({ reasonCode: "BINDING_CONCURRENT_UPDATE", retryable: true });
    expect(env.sessionStarts).toHaveLength(startsBefore);
    env.clock.advanceMs(15_000);
    await expect(env.service.bind(runtime(), reqB, "cor_synthCorrelation0059")).resolves.toMatchObject({ issue: "NEW_CALL", binding: { state: "ACTIVE" } });
  });
});

describe("issuance and recovery evidence is written exactly once [OPS-01][FO-10-46]", () => {
  it("[OPS-01] failure injection: the issuance event cannot be written: the bind is refused AUDIT_UNAVAILABLE; the owner's retry writes exactly one event and is answered NEW_CALL with the same binding", async () => {
    env.plane.dispatch("room-a", "AJ_synthJobA0001", "agent-AJ_synthJobA0001");
    const req = bindReq("room-a", "AJ_synthJobA0001", "media-worker-a1");
    env.audit.failOnce.add("call.binding.issued");
    expect(await refusal(env.service.bind(runtime(), req, "cor_synthCorrelation0201"))).toBe("AUDIT_UNAVAILABLE");
    const stored = await env.store.load(TENANT, (await env.service.interactionOfRoom("room-a")).interactionId);
    expect(stored?.data.issuanceAudit.state).toBe("MISSING");
    const retry = await env.service.bind(runtime(), req, "cor_synthCorrelation0202");
    expect(retry).toMatchObject({ issue: "NEW_CALL", supersededBindingId: null, binding: { bindingId: stored?.data.binding.bindingId, state: "ACTIVE", owner: { fencingToken: 1 } } });
    const issued = env.audit.events.filter((e) => e.action === "call.binding.issued");
    expect(issued).toHaveLength(1);
    expect(issued[0]).toMatchObject({ bindingId: retry.binding.bindingId, reasonCode: "BINDING_ISSUED", correlationId: "cor_synthCorrelation0202" });
    // Written now: a further retry writes nothing more.
    await env.service.bind(runtime(), req, "cor_synthCorrelation0203");
    expect(env.audit.events.filter((e) => e.action === "call.binding.issued")).toHaveLength(1);
  });

  it("[OPS-01][FO-10-46] failure injection: the recovery event cannot be written: refused; the new owner's retry writes exactly one recovery event and is answered REBOUND_AFTER_OWNER_LOSS without advancing the generation again", async () => {
    const old = await firstBind();
    env.plane.leave("room-a", "agent-AJ_synthJobA0001");
    env.plane.dispatch("room-a", "AJ_synthJobA0002", "agent-AJ_synthJobA0002");
    const req = bindReq("room-a", "AJ_synthJobA0002", "media-worker-a2");
    env.audit.failOnce.add("call.binding.recovered");
    expect(await refusal(env.service.bind(runtime(), req, "cor_synthCorrelation0204"))).toBe("AUDIT_UNAVAILABLE");
    const retry = await env.service.bind(runtime(), req, "cor_synthCorrelation0205");
    expect(retry).toMatchObject({ issue: "REBOUND_AFTER_OWNER_LOSS", supersededBindingId: old.binding.bindingId, binding: { sessionGeneration: 2, owner: { fencingToken: 2 } } });
    const recovered = env.audit.events.filter((e) => e.action === "call.binding.recovered");
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ bindingId: retry.binding.bindingId, sessionGeneration: 2 });
    await env.service.bind(runtime(), req, "cor_synthCorrelation0206");
    expect(env.audit.events.filter((e) => e.action === "call.binding.recovered")).toHaveLength(1);
  });

  it("[OPS-01] a retry racing the request that is still writing the event is refused retryably; once the writer is gone (its pending time passed) the retry writes the event, once", async () => {
    env.plane.dispatch("room-a", "AJ_synthJobA0001", "agent-AJ_synthJobA0001");
    const req = bindReq("room-a", "AJ_synthJobA0001", "media-worker-a1");
    // The gateway instance writing the issuance event dies mid-write: nothing lands, the record stays PENDING.
    env.audit.hangOnce.add("call.binding.issued");
    void env.service.bind(runtime(), req, "cor_synthCorrelation0207");
    await new Promise((r) => setTimeout(r, 20));
    const interactionId = (await env.service.interactionOfRoom("room-a")).interactionId;
    expect((await env.store.load(TENANT, interactionId))?.data.issuanceAudit.state).toBe("PENDING");
    await expect(env.service.bind(runtime(), req, "cor_synthCorrelation0208")).rejects.toMatchObject({ reasonCode: "BINDING_CONCURRENT_UPDATE", retryable: true });
    env.clock.advanceMs(14_000);
    await expect(env.service.bind(runtime(), req, "cor_synthCorrelation0209")).rejects.toMatchObject({ reasonCode: "BINDING_CONCURRENT_UPDATE" });
    expect(env.audit.events.filter((e) => e.action === "call.binding.issued")).toHaveLength(0);
    env.clock.advanceMs(1_001);
    const retry = await env.service.bind(runtime(), req, "cor_synthCorrelation0210");
    expect(retry.issue).toBe("NEW_CALL");
    expect(env.audit.events.filter((e) => e.action === "call.binding.issued")).toHaveLength(1);
    expect((await env.store.load(TENANT, interactionId))?.data.issuanceAudit.state).toBe("WRITTEN");
  });
});

describe("a call whose caller is owed or with a person never goes back to the AI [SAFE-02][FO-10-46][DATA-03]", () => {
  const roomOf = async (room = "room-a") => {
    const r = await env.service.roomForRoute(room);
    expect(r.roomSid).not.toBeNull();
    return { roomSid: r.roomSid as string, interactionId: r.interactionId };
  };
  const crashAndRedispatch = (job: string) => {
    env.plane.leave("room-a", "agent-AJ_synthJobA0001");
    env.plane.dispatch("room-a", job, `agent-${job}`);
    return bindReq("room-a", job, "media-worker-r1");
  };

  it("[SAFE-02][FO-10-46] a person requested and not yet accepted (the handoff failed): the re-dispatched runtime is refused BINDING_PERSON_REQUESTED; no new binding, generation or session change", async () => {
    const a = await firstBind();
    const room = await roomOf();
    expect(room.interactionId).toBe(a.binding.interactionId);
    const pr = await env.service.notePersonRequested(room, { kind: "standard", reason: "CALLER_REQUESTED_HUMAN", language: "en" });
    expect(pr.standard).toMatchObject({ state: "OUTSTANDING", reason: "CALLER_REQUESTED_HUMAN", attempts: 1 });
    // A second attempt counts; the first reason and time are kept.
    expect((await env.service.notePersonRequested(room, { kind: "standard", reason: "RECOVERY_FAILED", language: "en" })).standard).toMatchObject({ reason: "CALLER_REQUESTED_HUMAN", attempts: 2 });
    expect(await env.service.personStateOfRoom({ sid: room.roomSid })).toBe("OUTSTANDING");
    const before = await env.store.load(TENANT, a.binding.interactionId);
    expect(await refusal(env.service.bind(runtime(), crashAndRedispatch("AJ_synthJobR0001"), "cor_synthCorrelation0301"))).toBe("BINDING_PERSON_REQUESTED");
    expect(await env.store.load(TENANT, a.binding.interactionId)).toEqual(before);
    expect(env.actions.calls).toEqual([]);
    expect(env.audit.events.filter((e) => e.action === "call.binding.recovered")).toEqual([]);
    expect(env.audit.events.at(-1)).toMatchObject({ action: "call.binding.refused", reasonCode: "BINDING_PERSON_REQUESTED" });
  });

  it("[SAFE-02][FO-10-46] a person already accepted for the call: a replacement is refused BINDING_WITH_PERSON (it stays silent); a safety route still owed outranks the accepted person", async () => {
    await firstBind();
    const room = await roomOf();
    await env.service.notePersonRequested(room, { kind: "standard", reason: "CALLER_REQUESTED_HUMAN", language: "en" });
    const accepted = await env.service.notePersonAccepted(room, "standard", { handoffId: "hnd_synthHandoff000001", destinationId: "dst_support_general", speechTemplateId: "human.offer" }, { kind: "standard", reason: "CALLER_REQUESTED_HUMAN", language: "en" });
    expect(accepted.standard).toMatchObject({ state: "ACCEPTED", handoff: { handoffId: "hnd_synthHandoff000001" } });
    // An accepted request is never reopened by a later standard request (no second handoff for the room).
    expect((await env.service.notePersonRequested(room, { kind: "standard", reason: "RECOVERY_FAILED", language: "en" })).standard?.state).toBe("ACCEPTED");
    expect(await env.service.personStateOfRoom({ sid: room.roomSid })).toBe("WITH_PERSON");
    const req = crashAndRedispatch("AJ_synthJobR0002");
    expect(await refusal(env.service.bind(runtime(), req, "cor_synthCorrelation0302"))).toBe("BINDING_WITH_PERSON");
    const signals = [{ source: "EXPLICIT_PHRASE" as const, ruleId: "safety.self_harm.explicit", strength: "CREDIBLE" as const, subject: "SELF" as const, temporal: "CURRENT" as const, negated: false }];
    await env.service.notePersonRequested(room, { kind: "safety", signals, locale: "en-US" });
    expect(await env.service.personStateOfRoom({ sid: room.roomSid })).toBe("OUTSTANDING");
    expect(await refusal(env.service.bind(runtime(), req, "cor_synthCorrelation0303"))).toBe("BINDING_PERSON_REQUESTED");
    await env.service.notePersonAccepted(room, "safety", { handoffId: "hnd_synthHandoff000002", destinationId: "dst_safety_priority", speechTemplateId: "safety.acknowledge" }, { kind: "safety", signals, locale: "en-US" });
    expect(await env.service.personStateOfRoom({ sid: room.roomSid })).toBe("WITH_PERSON");
    expect(await refusal(env.service.bind(runtime(), req, "cor_synthCorrelation0304"))).toBe("BINDING_WITH_PERSON");
  });

  it("[DATA-03][FO-10-46] the caller declined AI processing (the alternative is a person): recovery is refused BINDING_CONSENT_REQUIRES_PERSON before the session generation moves", async () => {
    const a = await firstBind();
    await env.service.consentDecision(runtime(), { claim: a.claim, dimension: "transcriptionAiProcessing", decision: "DECLINED", capturedVia: "dtmf_menu", occurredAt: env.clock.now().toISOString() }, "cor_synthCorrelation0305");
    const before = await env.store.load(TENANT, a.binding.interactionId);
    expect(await refusal(env.service.bind(runtime(), crashAndRedispatch("AJ_synthJobR0003"), "cor_synthCorrelation0306"))).toBe("BINDING_CONSENT_REQUIRES_PERSON");
    const after = await env.store.load(TENANT, a.binding.interactionId);
    expect(after?.data.binding).toEqual(before?.data.binding);
    expect(env.actions.calls).toEqual([]);
  });

  it("[DATA-03] recording declined: the replacement is refused where the tenant's alternative is a person, and re-bound (unrecorded) where it is to continue", async () => {
    const human = setup({ recordingDeclinedRoute: "HUMAN" });
    human.plane.dispatch("room-a", "AJ_synthJobA0001", "agent-AJ_synthJobA0001");
    const h = await human.service.bind(runtime(), bindReq("room-a", "AJ_synthJobA0001", "media-worker-a1"), "cor_synthCorrelation0307");
    await human.service.consentDecision(runtime(), { claim: h.claim, dimension: "recording", decision: "DECLINED", capturedVia: "dtmf_menu", occurredAt: human.clock.now().toISOString() }, "cor_synthCorrelation0308");
    human.plane.leave("room-a", "agent-AJ_synthJobA0001");
    human.plane.dispatch("room-a", "AJ_synthJobR0004", "agent-AJ_synthJobR0004");
    expect(await refusal(human.service.bind(runtime(), bindReq("room-a", "AJ_synthJobR0004", "media-worker-r1"), "cor_synthCorrelation0309"))).toBe("BINDING_CONSENT_REQUIRES_PERSON");
    const a = await firstBind();
    await env.service.consentDecision(runtime(), { claim: a.claim, dimension: "recording", decision: "DECLINED", capturedVia: "dtmf_menu", occurredAt: env.clock.now().toISOString() }, "cor_synthCorrelation0310");
    const again = await env.service.bind(runtime(), crashAndRedispatch("AJ_synthJobR0005"), "cor_synthCorrelation0311");
    expect(again).toMatchObject({ issue: "REBOUND_AFTER_OWNER_LOSS", directive: { recording: { value: "DECLINED" } } });
  });

  it("[SAFE-02] the room of a session-less route: a room the media plane reports gone is refused; an unreachable media plane gives a fresh, unattributed interaction without a room; a room whose carrier another room claimed is routed under a fresh interaction but keeps its own request", async () => {
    await firstBind();
    expect(await refusal(env.service.roomForRoute("no-such-room"))).toBe("MEDIA_ROOM_NOT_FOUND");
    env.plane.available = false;
    const down = await env.service.roomForRoute("room-a");
    expect(down).toMatchObject({ roomSid: null, attributed: false, reasonCode: "LIVEKIT_API_UNAVAILABLE" });
    env.plane.available = true;
    env.plane.addSipRoom("room-forged", "SCL_synthCallA0001", { sid: "RM_synthForgedRoom01", identity: "sip_synthForger" });
    const forged = await env.service.roomForRoute("room-forged");
    expect(forged).toMatchObject({ roomSid: "RM_synthForgedRoom01", attributed: false, reasonCode: "BINDING_ROOM_MISMATCH" });
    expect(forged.interactionId).not.toBe((await roomOf()).interactionId);
    const pr = await env.service.notePersonRequested({ roomSid: forged.roomSid as string, interactionId: forged.interactionId }, { kind: "standard", reason: "BINDING_UNAVAILABLE", language: "en" });
    expect(pr.roomSid).toBe("RM_synthForgedRoom01");
    // The victim's own room has no request.
    expect(await env.service.personStateOfRoom({ sid: (await roomOf()).roomSid })).toBe("NONE");
  });
});

describe("recovery after a worker crash [FO-10-46][AUTH-03]", () => {
  it("[FO-10-46][AUTH-03] the new worker is re-bound with a NEW session generation and fencing token; the old generation is refused", async () => {
    const old = await firstBind();
    env.plane.leave("room-a", "agent-AJ_synthJobA0001"); // the crashed worker's agent participant left the room
    env.plane.dispatch("room-a", "AJ_synthJobA0002", "agent-AJ_synthJobA0002");
    const fresh = await env.service.bind(runtime(), bindReq("room-a", "AJ_synthJobA0002", "media-worker-a2"), "cor_synthCorrelation0008");
    expect(fresh.issue).toBe("REBOUND_AFTER_OWNER_LOSS");
    expect(fresh.supersededBindingId).toBe(old.binding.bindingId);
    expect(fresh.binding.sessionGeneration).toBeGreaterThan(old.binding.sessionGeneration);
    expect(fresh.binding.owner.fencingToken).toBe(old.binding.owner.fencingToken + 1);
    expect(fresh.binding.interactionId).toBe(old.binding.interactionId);
    expect(fresh.binding.carrier).toEqual(old.binding.carrier);
    // Pending confirmations of the old owner are void.
    expect(env.actions.calls.map((c) => c.reasonCode)).toEqual(["CALL_OWNER_RECOVERED"]);
    // The old owner's claim is refused everywhere (never resumed).
    expect(await refusal(env.service.heartbeat(runtime(), old.claim, "cor_synthCorrelation0009"))).toBe("BINDING_SUPERSEDED");
    // A forged claim that names the new binding with the old generation or fencing token is refused too.
    expect(await refusal(env.service.heartbeat(runtime(), { ...fresh.claim, sessionGeneration: old.claim.sessionGeneration }, "cor_synthCorrelation0010"))).toBe("BINDING_GENERATION_STALE");
    expect(await refusal(env.service.heartbeat(runtime(), { ...fresh.claim, fencingToken: old.claim.fencingToken }, "cor_synthCorrelation0011"))).toBe("BINDING_FENCING_TOKEN_STALE");
    await expect(env.service.heartbeat(runtime(), fresh.claim, "cor_synthCorrelation0012")).resolves.toMatchObject({ sessionGeneration: fresh.binding.sessionGeneration });
    expect(env.audit.events.map((e) => e.action)).toContain("call.binding.recovered");
  });

  it("[AUTH-03] adversarial: a second worker cannot take a call whose owner is still present and renewing", async () => {
    await firstBind();
    env.plane.dispatch("room-a", "AJ_synthJobA0003", "agent-AJ_synthJobA0003");
    expect(await refusal(env.service.bind(runtime(), bindReq("room-a", "AJ_synthJobA0003", "media-worker-a3"), "cor_synthCorrelation0013"))).toBe("BINDING_OWNER_ACTIVE");
  });

  it("[AUTH-04] an owner that stopped renewing loses the call after the binding TTL, even while its participant lingers", async () => {
    const old = await firstBind();
    env.plane.dispatch("room-a", "AJ_synthJobA0004", "agent-AJ_synthJobA0004");
    env.clock.advanceSeconds(91);
    const fresh = await env.service.bind(runtime(), bindReq("room-a", "AJ_synthJobA0004", "media-worker-a4"), "cor_synthCorrelation0014");
    expect(fresh.binding.sessionGeneration).toBe(old.binding.sessionGeneration + 1);
    // The expired claim is refused (expiry is enforced by the reader, not by storage TTL).
    expect(await refusal(env.service.heartbeat(runtime(), old.claim, "cor_synthCorrelation0015"))).toBe("BINDING_SUPERSEDED");
  });

  it("[FO-10-46] failure injection: a revoked session is never silently replaced: recovery is refused (the worker routes to a person)", async () => {
    const old = await firstBind();
    const resolved = await env.service.resolveClaim(runtime(), old.claim);
    await env.sessions.revoke(resolved.sessionRef, "FRAUD_REVIEW_HOLD");
    env.plane.leave("room-a", "agent-AJ_synthJobA0001");
    env.plane.dispatch("room-a", "AJ_synthJobA0005", "agent-AJ_synthJobA0005");
    expect(await refusal(env.service.bind(runtime(), bindReq("room-a", "AJ_synthJobA0005", "media-worker-a5"), "cor_synthCorrelation0016"))).toBe("BINDING_SESSION_INVALID");
    expect(await refusal(env.service.bind(runtime(), bindReq("room-a", "AJ_synthJobA0005", "media-worker-a5"), "cor_synthCorrelation0017"))).toBe("BINDING_REVOKED");
  });
});

describe("heartbeat and claims [AUTH-03][AUTH-04]", () => {
  it("[AUTH-04] the renewed expiry is the binding TTL from now, and an expired binding is refused", async () => {
    const r = await firstBind();
    const hb = await env.service.heartbeat(runtime(), r.claim, "cor_synthCorrelation0018");
    expect(Date.parse(hb.expiresAt)).toBe(env.clock.now().getTime() + 90_000);
    env.clock.advanceSeconds(91);
    expect(await refusal(env.service.heartbeat(runtime(), r.claim, "cor_synthCorrelation0019"))).toBe("BINDING_EXPIRED");
  });

  it("[AUTH-04] a binding never outlives its session: with a session shorter than the binding TTL, issuance and renewal stop at the session's expiry, and the binding is refused once the session expired", async () => {
    env = setup({}, { sessionTtlSeconds: 60 }); // session 60 s, binding TTL 90 s
    const start = env.clock.now().getTime();
    const r = await firstBind();
    const sessionExpiry = start + 60_000;
    expect(Date.parse(r.binding.expiresAt)).toBe(sessionExpiry);
    env.clock.advanceSeconds(30);
    const hb = await env.service.heartbeat(runtime(), r.claim, "cor_synthCorrelation0090");
    expect(Date.parse(hb.expiresAt)).toBe(sessionExpiry);
    env.clock.advanceSeconds(31); // the session expired one second ago; the binding with it
    expect(await refusal(env.service.heartbeat(runtime(), r.claim, "cor_synthCorrelation0091"))).toMatch(/^BINDING_(EXPIRED|SESSION_INVALID)$/);
    await expect(env.service.resolveClaim(runtime(), r.claim)).rejects.toBeInstanceOf(BindingRefusedError);
  });

  it("[AUTH-03] a session generation advanced by the control plane is followed; the worker's old generation is refused afterwards", async () => {
    const r = await firstBind();
    const { sessionRef } = await env.service.resolveClaim(runtime(), r.claim);
    await env.sessions.selectRole(sessionRef, carrierIntegration, "client"); // TC-03 elsewhere: generation 2
    const hb = await env.service.heartbeat(runtime(), r.claim, "cor_synthCorrelation0020");
    expect(hb.sessionGeneration).toBe(2);
    expect(await refusal(env.service.heartbeat(runtime(), r.claim, "cor_synthCorrelation0021"))).toBe("BINDING_GENERATION_STALE");
    await expect(env.service.heartbeat(runtime(), { ...r.claim, sessionGeneration: 2 }, "cor_synthCorrelation0022")).resolves.toMatchObject({ sessionGeneration: 2 });
  });

  it("[AUTH-03] adversarial: claims of another tenant, an unknown binding or a malformed claim are refused", async () => {
    const r = await firstBind();
    expect(await refusal(env.service.heartbeat(runtime(), { ...r.claim, tenantId: "tnt_synthTenantOther0001" }, "cor_synthCorrelation0023"))).toBe("BINDING_TENANT_MISMATCH");
    expect(await refusal(env.service.heartbeat(runtime(), { ...r.claim, bindingId: "cbd_synthUnknownBinding01" }, "cor_synthCorrelation0024"))).toBe("BINDING_NOT_FOUND");
    expect(await refusal(env.service.heartbeat(runtime(), { ...r.claim, interactionId: "int_synthUnknownCall0001" }, "cor_synthCorrelation0025"))).toBe("BINDING_NOT_FOUND");
    expect(await refusal(env.service.heartbeat(runtime(), { ...r.claim, sessionGeneration: 0 } as MediaBindingClaim, "cor_synthCorrelation0026"))).toBe("BINDING_CLAIM_INVALID");
  });

  it("[AUTH-03] adversarial: a sealed session copied onto another call record does not open", async () => {
    const r = await firstBind();
    const rec = await env.store.load(TENANT, r.binding.interactionId);
    env.plane.addWebRoom("room-b", "RM_synthRoomB0001");
    env.plane.dispatch("room-b", "AJ_synthJobB0002", "agent-AJ_synthJobB0002");
    const other = await env.service.bind(runtime(), bindReq("room-b", "AJ_synthJobB0002", "media-worker-b2"), "cor_synthCorrelation0027");
    const target = await env.store.load(TENANT, other.binding.interactionId);
    await env.store.replace(target!.version, { ...target!.data, sealedSession: rec!.data.sealedSession });
    expect(await refusal(env.service.heartbeat(runtime(), other.claim, "cor_synthCorrelation0028"))).toBe("BINDING_SESSION_SEAL_INVALID");
  });
});

describe("call lifecycle [FO-10-09]", () => {
  it("[FO-10-09][AUTH-03] a participant joining mid-call advances the generation (TC-03 equivalent), voids pending actions and resets the joined party's consent", async () => {
    const r = await firstBind();
    const resp = await env.service.lifecycle(runtime(), { claim: r.claim, event: { kind: "PARTICIPANT_JOINED", participantRole: "other", occurredAt: env.clock.now().toISOString() } }, "cor_synthCorrelation0029");
    expect(resp.generationChanged).toBe(true);
    expect(resp.claim.sessionGeneration).toBe(r.claim.sessionGeneration + 1);
    expect(resp.invalidatedActions).toBe(1);
    expect(env.actions.calls.at(-1)?.reasonCode).toBe("PARTICIPANT_CHANGED");
    expect(await refusal(env.service.heartbeat(runtime(), r.claim, "cor_synthCorrelation0030"))).toBe("BINDING_GENERATION_STALE");
    const hb = await env.service.heartbeat(runtime(), resp.claim, "cor_synthCorrelation0031");
    expect(hb.directive.recording.value).toBe("UNKNOWN");
  });

  it("[FO-10-09] a participant leaving is a participant change too; hold and a transfer leg void pending actions without a new generation", async () => {
    const r = await firstBind();
    const left = await env.service.lifecycle(runtime(), { claim: r.claim, event: { kind: "PARTICIPANT_LEFT", participantRole: "other", occurredAt: env.clock.now().toISOString() } }, "cor_synthCorrelation0032");
    expect(left.generationChanged).toBe(true);
    const hold = await env.service.lifecycle(runtime(), { claim: left.claim, event: { kind: "HOLD_STARTED", participantRole: null, occurredAt: env.clock.now().toISOString() } }, "cor_synthCorrelation0033");
    expect(hold.generationChanged).toBe(false);
    expect(hold.claim).toEqual(left.claim);
    const leg = await env.service.lifecycle(runtime(), { claim: hold.claim, event: { kind: "TRANSFER_LEG_STARTED", participantRole: null, occurredAt: env.clock.now().toISOString() } }, "cor_synthCorrelation0034");
    expect(leg.invalidatedActions).toBe(1);
    expect(env.actions.calls.map((c) => c.reasonCode)).toEqual(["PARTICIPANT_CHANGED", "CALL_ON_HOLD", "TRANSFER_STARTED"]);
  });

  it("[FO-10-09][AUTH-04] hang-up mid-turn ends the session (TC-11 equivalent): the binding is ENDED and no worker can re-bind the call", async () => {
    const r = await firstBind();
    const { sessionRef } = await env.service.resolveClaim(runtime(), r.claim);
    const end = await env.service.lifecycle(runtime(), { claim: r.claim, event: { kind: "CALLER_HUNG_UP", participantRole: "caller", occurredAt: env.clock.now().toISOString() } }, "cor_synthCorrelation0035");
    expect(end.state).toBe("ENDED");
    expect(env.actions.calls.at(-1)?.reasonCode).toBe("CALL_ENDED");
    await expect(env.sessions.resolve(sessionRef, carrierIntegration)).rejects.toMatchObject({ reasonCode: "SESSION_ENDED" });
    expect(await refusal(env.service.heartbeat(runtime(), r.claim, "cor_synthCorrelation0036"))).toBe("BINDING_NOT_ACTIVE");
    env.plane.leave("room-a", "agent-AJ_synthJobA0001");
    env.plane.dispatch("room-a", "AJ_synthJobA0006", "agent-AJ_synthJobA0006");
    expect(await refusal(env.service.bind(runtime(), bindReq("room-a", "AJ_synthJobA0006", "media-worker-a6"), "cor_synthCorrelation0037"))).toBe("BINDING_CALL_ENDED");
  });
});

describe("consent on the media path [DATA-03]", () => {
  async function grant(claim: MediaBindingClaim) {
    const { sessionRef } = await env.service.resolveClaim(runtime(), claim);
    await env.sessions.recordConsent(sessionRef, carrierIntegration, {
      recording: "GRANTED",
      automatedProcessing: "GRANTED",
      disclosureTemplateVersion: "disclosure-en-v3",
      capturedAt: env.clock.now().toISOString(),
      capturedBy: "studio_flow",
    });
  }

  it("[DATA-03] positive: the trusted capture's consent reaches the directive with a new consent version", async () => {
    const r = await firstBind();
    await grant(r.claim);
    const hb = await env.service.heartbeat(runtime(), r.claim, "cor_synthCorrelation0038");
    expect(hb.directive.recording.value).toBe("GRANTED");
    expect(hb.directive.disclosureTemplateId).toBe("disclosure-en-v3");
    expect(hb.directive.consentVersion).toBe(r.directive.consentVersion + 1);
  });

  it("[DATA-03][FAULT:RECORDING_REFUSED] the caller's decline on the media path outranks the stored grant, advances the version and returns the configured alternative", async () => {
    const r = await firstBind();
    await grant(r.claim);
    const before = await env.service.heartbeat(runtime(), r.claim, "cor_synthCorrelation0039");
    const d = await env.service.consentDecision(runtime(), { claim: r.claim, dimension: "recording", decision: "DECLINED", capturedVia: "dtmf_menu", occurredAt: env.clock.now().toISOString() }, "cor_synthCorrelation0040");
    expect(d.directive.recording.value).toBe("DECLINED");
    expect(d.directive.transcriptionAiProcessing.value).toBe("GRANTED");
    expect(d.directive.consentVersion).toBe(before.directive.consentVersion + 1);
    expect(d.routeToHuman).toBe(false);
    expect(d.reasonCode).toBe("RECORDING_DECLINED_CONTINUE_UNRECORDED");
    expect(env.audit.events.at(-1)).toMatchObject({ action: "media.consent.declined", reasonCode: "RECORDING_DECLINED_CONTINUE_UNRECORDED" });
    // The decline is sticky: a later heartbeat never re-enables recording.
    expect((await env.service.heartbeat(runtime(), r.claim, "cor_synthCorrelation0041")).directive.recording.value).toBe("DECLINED");
  });

  it("[DATA-03] declining AI processing always routes to a person; a decline is applied even when the audit write fails", async () => {
    const r = await firstBind();
    env.audit.failing = true;
    const d = await env.service.consentDecision(runtime(), { claim: r.claim, dimension: "transcriptionAiProcessing", decision: "REVOKED", capturedVia: "speech_intent", occurredAt: env.clock.now().toISOString() }, "cor_synthCorrelation0042");
    expect(d.routeToHuman).toBe(true);
    expect(d.directive.transcriptionAiProcessing.value).toBe("DECLINED");
  });

  it("[DATA-03] adversarial: a processing readout with a recorder running after the decline is a mismatch that routes to a person and is recorded", async () => {
    const r = await firstBind();
    await grant(r.claim);
    const d = await env.service.consentDecision(runtime(), { claim: r.claim, dimension: "recording", decision: "DECLINED", capturedVia: "dtmf_menu", occurredAt: env.clock.now().toISOString() }, "cor_synthCorrelation0043");
    const now = env.clock.now().toISOString();
    const running: MediaProcessingState = {
      schemaVersion: "media-processing-state.v1",
      tenantId: TENANT,
      interactionId: r.binding.interactionId,
      sessionGeneration: r.binding.sessionGeneration,
      occurredAt: now,
      bindingId: r.binding.bindingId,
      recording: { phase: "ON", active: true, ref: "EG_synthEgress0001", changedAt: now },
      transcription: { phase: "ON", active: true, ref: null, changedAt: now },
      analysis: { phase: "OFF", active: false, ref: null, changedAt: now },
      // A stale worker still holding the earlier grant: its own view sees no contradiction.
      consent: { consentVersion: d.directive.consentVersion - 1, recording: { ...d.directive.recording, value: "GRANTED" }, transcriptionAiProcessing: d.directive.transcriptionAiProcessing },
      disclosureTemplateId: "disclosure-en-v3",
      mismatch: null,
      recorderRefs: ["EG_synthEgress0001"],
      changedAt: now,
    };
    const report = await env.service.reportProcessing(runtime(), { claim: r.claim, state: running }, "cor_synthCorrelation0044");
    expect(report).toMatchObject({ accepted: false, mismatch: "RECORDING_WITHOUT_CONSENT", routeToHuman: true, reasonCode: "RECORDING_WITHOUT_CONSENT", directive: { consentVersion: d.directive.consentVersion, recording: { value: "DECLINED" } } });
    expect((await env.store.load(TENANT, r.binding.interactionId))?.data.lastMismatch?.mismatch).toBe("RECORDING_WITHOUT_CONSENT");
    // The transcript is recording-dependent processing: still running after the recording decline, it is a mismatch too.
    const off = { phase: "OFF" as const, active: false, ref: null, changedAt: now };
    const transcriptOnly = { ...running, recording: { ...off, ref: "EG_synthEgress0001" }, consent: { ...running.consent, consentVersion: d.directive.consentVersion, recording: d.directive.recording }, mismatch: "TAP_WITHOUT_CONSENT" as const };
    expect(await env.service.reportProcessing(runtime(), { claim: r.claim, state: transcriptOnly }, "cor_synthCorrelation0046")).toMatchObject({ accepted: false, mismatch: "TAP_WITHOUT_CONSENT", routeToHuman: true });
    const unflagged = { ...transcriptOnly, consent: running.consent, mismatch: null };
    expect(await env.service.reportProcessing(runtime(), { claim: r.claim, state: unflagged }, "cor_synthCorrelation0047")).toMatchObject({ accepted: false, mismatch: "TAP_WITHOUT_CONSENT" });
    // The consistent readout (recorder and the recording-dependent taps stopped) is accepted.
    const stopped = { ...transcriptOnly, transcription: off, mismatch: null };
    expect((await env.service.reportProcessing(runtime(), { claim: r.claim, state: stopped }, "cor_synthCorrelation0045")).accepted).toBe(true);
  });
});

describe("session-less routes (SAFE-02)", () => {
  it("[SAFE-02] the human and safety routes resolve the room's interaction without any binding or session", async () => {
    const a = await env.service.interactionForRoom(runtime(), "room-a");
    const r = await firstBind();
    expect(a.interactionId).toBe(r.binding.interactionId);
    expect(a.carrier.interactionRef).toBe("SCL_synthCallA0001");
  });

  it("[SAFE-02][FO-05-16] adversarial: a room carrying another room's carrier reference is never attributed to that call", async () => {
    const r = await firstBind();
    env.plane.addSipRoom("room-forged", "SCL_synthCallA0001", { identity: "sip_synthForged" });
    expect(await refusal(env.service.interactionForRoom(runtime(), "room-forged"))).toBe("BINDING_ROOM_MISMATCH");
    expect((await env.service.interactionForRoom(runtime(), "room-a")).interactionId).toBe(r.binding.interactionId);
  });
});

describe("one call, one room: carrier facts pinned at the first touch [FO-05-16][AUTH-03]", () => {
  async function victim() {
    const a = await firstBind();
    return a;
  }

  it("[AUTH-03][FO-05-16] adversarial: a second room whose SIP participant carries the victim's sip.callID (minted with the media-plane secret) is refused; the live victim keeps its binding, generation and fencing token", async () => {
    const a = await victim();
    env.plane.addSipRoom("room-attacker", "SCL_synthCallA0001", { identity: "sip_synthForged" });
    env.plane.dispatch("room-attacker", "AJ_synthAttack0001", "agent-AJ_synthAttack0001");
    expect(await refusal(env.service.bind(runtime(), bindReq("room-attacker", "AJ_synthAttack0001", "media-worker-m1"), "cor_synthCorrelation0101"))).toBe("BINDING_ROOM_MISMATCH");
    expect(env.audit.events.at(-1)).toMatchObject({ action: "call.binding.refused", outcome: "DENIED", reasonCode: "BINDING_ROOM_MISMATCH" });
    // Even with the victim's own agent gone (a takeover would be "recovery"), another room never takes the call.
    env.plane.leave("room-a", "agent-AJ_synthJobA0001");
    expect(await refusal(env.service.bind(runtime(), bindReq("room-attacker", "AJ_synthAttack0001", "media-worker-m1"), "cor_synthCorrelation0102"))).toBe("BINDING_ROOM_MISMATCH");
    const hb = await env.service.heartbeat(runtime(), a.claim, "cor_synthCorrelation0103");
    expect(hb).toMatchObject({ state: "ACTIVE", sessionGeneration: a.binding.sessionGeneration });
    const rec = await env.store.load(TENANT, a.binding.interactionId);
    expect(rec?.data.binding).toMatchObject({ bindingId: a.binding.bindingId, owner: { fencingToken: 1, instanceRef: "media-worker-a1" } });
    expect(env.actions.calls).toEqual([]);
  });

  it("[AUTH-03] adversarial: a bind naming the call's room server id under another room name is refused (the name is pinned too)", async () => {
    await victim();
    const r = env.plane.rooms.get("room-a")!;
    env.plane.rooms.set("room-a-alias", { ...r, jobs: new Map(r.jobs), agents: new Set(r.agents) });
    env.plane.dispatch("room-a-alias", "AJ_synthAlias0001", "agent-AJ_synthAlias0001");
    env.plane.leave("room-a-alias", "agent-AJ_synthJobA0001");
    expect(await refusal(env.service.bind(runtime(), bindReq("room-a-alias", "AJ_synthAlias0001", "media-worker-a9"), "cor_synthCorrelation0104"))).toBe("BINDING_ROOM_MISMATCH");
  });

  it("[AUTH-03] the room is claimed by whoever touches it first: the forged room first, the real call's bind is refused (fail closed to a person), never merged", async () => {
    env.plane.addSipRoom("room-attacker", "SCL_synthCallA0001", { identity: "sip_synthForged" });
    env.plane.dispatch("room-attacker", "AJ_synthAttack0002", "agent-AJ_synthAttack0002");
    const m = await env.service.bind(runtime(), bindReq("room-attacker", "AJ_synthAttack0002", "media-worker-m2"), "cor_synthCorrelation0105");
    env.plane.dispatch("room-a", "AJ_synthJobA0001", "agent-AJ_synthJobA0001");
    expect(await refusal(env.service.bind(runtime(), bindReq("room-a", "AJ_synthJobA0001", "media-worker-a1"), "cor_synthCorrelation0106"))).toBe("BINDING_ROOM_MISMATCH");
    expect((await env.store.load(TENANT, m.binding.interactionId))?.data.room.sid).toBe(env.plane.rooms.get("room-attacker")!.sid);
  });

  it("[FO-05-16] the earliest-joined SIP party names the call; a transfer leg joining later does not change it on a re-bind", async () => {
    const a = await victim();
    env.plane.addSipParty("room-a", "sip_synthTransferLeg", "SCL_synthTransferLeg1");
    env.plane.leave("room-a", "agent-AJ_synthJobA0001");
    env.plane.dispatch("room-a", "AJ_synthJobA0010", "agent-AJ_synthJobA0010");
    const b = await env.service.bind(runtime(), bindReq("room-a", "AJ_synthJobA0010", "media-worker-a2"), "cor_synthCorrelation0107");
    expect(b.issue).toBe("REBOUND_AFTER_OWNER_LOSS");
    expect(b.binding.interactionId).toBe(a.binding.interactionId);
    expect(b.binding.carrier.interactionRef).toBe("SCL_synthCallA0001");
  });

  it("[FO-10-09][FO-05-16] the caller left while no runtime held the call and only a transfer leg remains: re-bind is refused BINDING_CALLER_GONE and the call is ended, never re-bound to the leg", async () => {
    const a = await victim();
    const { sessionRef } = await env.service.resolveClaim(runtime(), a.claim);
    env.plane.addSipParty("room-a", "sip_synthTransferLeg", "SCL_synthTransferLeg1");
    env.plane.removeSipParty("room-a", "sip_synthCaller");
    env.plane.leave("room-a", "agent-AJ_synthJobA0001");
    env.plane.dispatch("room-a", "AJ_synthJobA0011", "agent-AJ_synthJobA0011");
    expect(await refusal(env.service.bind(runtime(), bindReq("room-a", "AJ_synthJobA0011", "media-worker-a3"), "cor_synthCorrelation0108"))).toBe("BINDING_CALLER_GONE");
    const rec = await env.store.load(TENANT, a.binding.interactionId);
    expect(rec?.data).toMatchObject({ ended: true, binding: { state: "ENDED" } });
    expect(env.actions.calls.at(-1)?.reasonCode).toBe("CALL_ENDED");
    await expect(env.sessions.resolve(sessionRef, carrierIntegration)).rejects.toMatchObject({ reasonCode: "SESSION_ENDED" });
    expect(env.audit.events.map((e) => e.action)).toContain("call.lifecycle.caller_gone");
  });

  it("[AUTH-03] adversarial: the pinned SIP party's call id rewritten through the server API (UpdateParticipant) revokes the binding instead of re-binding", async () => {
    const a = await victim();
    env.plane.rewriteCallId("room-a", "sip_synthCaller", "SCL_synthRewritten01");
    env.plane.dispatch("room-a", "AJ_synthJobA0012", "agent-AJ_synthJobA0012");
    expect(await refusal(env.service.bind(runtime(), bindReq("room-a", "AJ_synthJobA0012", "media-worker-a4"), "cor_synthCorrelation0109"))).toBe("BINDING_CARRIER_CHANGED");
    expect((await env.store.load(TENANT, a.binding.interactionId))?.data.binding.state).toBe("REVOKED");
    // The live owner is told its binding was revoked (it routes the caller to a person), not that the call ended.
    expect(await refusal(env.service.heartbeat(runtime(), a.claim, "cor_synthCorrelation0110"))).toBe("BINDING_REVOKED");
  });

  it("[FO-05-16] two SIP parties that joined at the same instant are ambiguous; a SIP party without the call id is never named by anything else", async () => {
    env.plane.addSipRoom("room-two", "SCL_synthTwoA0001", { identity: "sip_synthTwoA" });
    const t = env.plane.rooms.get("room-two")!.sip[0]!.joinedAtMs;
    env.plane.addSipParty("room-two", "sip_synthTwoB", "SCL_synthTwoB0001", null, t);
    env.plane.dispatch("room-two", "AJ_synthTwo00001", "agent-AJ_synthTwo00001");
    expect(await refusal(env.service.bind(runtime(), bindReq("room-two", "AJ_synthTwo00001", "media-worker-t1"), "cor_synthCorrelation0111"))).toBe("MEDIA_CARRIER_AMBIGUOUS");
    env.plane.addSipRoom("room-nocall", "SCL_synthUnused0001", { identity: "sip_synthNoCall" });
    env.plane.rooms.get("room-nocall")!.sip[0]!.interactionRef = null;
    env.plane.dispatch("room-nocall", "AJ_synthNoCall001", "agent-AJ_synthNoCall001");
    expect(await refusal(env.service.bind(runtime(), bindReq("room-nocall", "AJ_synthNoCall001", "media-worker-t2"), "cor_synthCorrelation0112"))).toBe("MEDIA_SIP_CALL_ID_MISSING");
  });

  it("[FO-10-09] the supervisor's end of a room whose caller left ends the call once (endRoom), and is idempotent", async () => {
    const a = await victim();
    env.plane.removeSipParty("room-a", "sip_synthCaller");
    expect(await env.service.endRoom("room-a", "cor_synthCorrelation0113")).toBe("ENDED");
    expect(await env.service.endRoom("room-a", "cor_synthCorrelation0114")).toBe("ALREADY_ENDED");
    expect(await refusal(env.service.heartbeat(runtime(), a.claim, "cor_synthCorrelation0115"))).toBe("BINDING_NOT_ACTIVE");
    env.plane.addWebRoom("room-never", "RM_synthNeverBound1");
    expect(await env.service.endRoom("room-never", "cor_synthCorrelation0116")).toBe("NOT_BOUND");
  });
});

describe("control-plane consent changes reach the worker within one reconciliation tick [DATA-03]", () => {
  const readout = (r: Awaited<ReturnType<CallBindingService["bind"]>>, consent: MediaProcessingState["consent"], recording: "ON" | "OFF" | "STOPPING"): MediaProcessingState => {
    const now = env.clock.now().toISOString();
    const tap = (phase: "ON" | "OFF" | "STOPPING", ref: string | null) => ({ phase, active: phase !== "OFF", ref, changedAt: now });
    return {
      schemaVersion: "media-processing-state.v1",
      tenantId: TENANT,
      interactionId: r.binding.interactionId,
      sessionGeneration: r.binding.sessionGeneration,
      occurredAt: now,
      bindingId: r.binding.bindingId,
      recording: tap(recording, recording === "OFF" ? null : "EG_synthEgress0001"),
      transcription: tap("OFF", null),
      analysis: tap("OFF", null),
      consent,
      disclosureTemplateId: "disclosure-en-v3",
      mismatch: null,
      recorderRefs: recording === "OFF" ? [] : ["EG_synthEgress0001"],
      changedAt: now,
    };
  };

  it("[DATA-03] a revocation recorded between heartbeats: the next readout (still under the grant it was told) is consistent and its answer carries the revoked directive; a readout that ignores the told revocation is a mismatch", async () => {
    const r = await firstBind();
    const { sessionRef } = await env.service.resolveClaim(runtime(), r.claim);
    const at = env.clock.now().toISOString();
    await env.sessions.recordConsent(sessionRef, carrierIntegration, { recording: "GRANTED", automatedProcessing: "GRANTED", disclosureTemplateVersion: "disclosure-en-v3", capturedAt: at, capturedBy: "studio_flow" });
    const granted = (await env.service.heartbeat(runtime(), r.claim, "cor_synthCorrelation0120")).directive;
    expect(granted.recording.value).toBe("GRANTED");
    const told = { consentVersion: granted.consentVersion, recording: granted.recording, transcriptionAiProcessing: granted.transcriptionAiProcessing };
    // The caller revokes through the trusted consent capture (no heartbeat in between).
    await env.sessions.recordConsent(sessionRef, carrierIntegration, { recording: "DECLINED", automatedProcessing: "DECLINED", disclosureTemplateVersion: "disclosure-en-v3", capturedAt: at, capturedBy: "studio_flow" });
    const first = await env.service.reportProcessing(runtime(), { claim: r.claim, state: readout(r, told, "ON") }, "cor_synthCorrelation0121");
    expect(first).toMatchObject({ accepted: true, mismatch: null, routeToHuman: false });
    expect(first.directive).toMatchObject({ consentVersion: granted.consentVersion + 1, recording: { value: "DECLINED" }, transcriptionAiProcessing: { value: "DECLINED" } });
    // Told now: the same readout again (the recorder still ON under the old grant) is a stale worker.
    const again = await env.service.reportProcessing(runtime(), { claim: r.claim, state: readout(r, told, "ON") }, "cor_synthCorrelation0122");
    expect(again).toMatchObject({ accepted: false, mismatch: "RECORDING_WITHOUT_CONSENT", routeToHuman: true });
    // The worker that applied the revocation (recorder draining) is consistent.
    const applied = { consentVersion: first.directive.consentVersion, recording: first.directive.recording, transcriptionAiProcessing: first.directive.transcriptionAiProcessing };
    expect((await env.service.reportProcessing(runtime(), { claim: r.claim, state: readout(r, applied, "STOPPING") }, "cor_synthCorrelation0123")).accepted).toBe(true);
    // A late heartbeat answer never carries the older grant at an equal or higher version.
    const hb = await env.service.heartbeat(runtime(), r.claim, "cor_synthCorrelation0124");
    expect(hb.directive).toMatchObject({ consentVersion: first.directive.consentVersion, recording: { value: "DECLINED" } });
  });

  it("[AUTH-03][DATA-03] adversarial: a readout of another call, another binding or an older generation, presented under this call's current claim, is refused 400 PROCESSING_STATE_BINDING_MISMATCH: nothing is stored and no directive is answered", async () => {
    const r = await firstBind();
    // A party change advances the generation (the claim follows it); the readout of the old generation is now stale.
    const changed = await env.service.lifecycle(runtime(), { claim: r.claim, event: { kind: "PARTICIPANT_JOINED", participantRole: "other", occurredAt: env.clock.now().toISOString() } }, "cor_synthCorrelation0126");
    expect(changed.claim.sessionGeneration).toBe(2);
    const claim = changed.claim;
    const current = { ...r, binding: { ...r.binding, sessionGeneration: 2 } };
    const consent = { consentVersion: r.directive.consentVersion, recording: r.directive.recording, transcriptionAiProcessing: r.directive.transcriptionAiProcessing };
    // The consistent readout of this binding and generation is accepted (the refusals below are about the identity only).
    expect((await env.service.reportProcessing(runtime(), { claim, state: readout(current, consent, "OFF") }, "cor_synthCorrelation0127")).accepted).toBe(true);
    const before = await env.store.load(TENANT, r.binding.interactionId);
    const auditsBefore = env.audit.events.length;
    const foreign: [string, MediaProcessingState][] = [
      ["another call", { ...readout(current, consent, "OFF"), interactionId: "int_synthOtherCall0001" }],
      ["another binding", { ...readout(current, consent, "OFF"), bindingId: "cbd_synthOtherBinding001" }],
      ["an older generation", { ...readout(current, consent, "OFF"), sessionGeneration: 1 }],
      ["another tenant", { ...readout(current, consent, "OFF"), tenantId: "tnt_synthOtherTenant001" }],
    ];
    for (const [label, state] of foreign) {
      let err: unknown = null;
      let answered: unknown = null;
      try {
        answered = await env.service.reportProcessing(runtime(), { claim, state }, "cor_synthCorrelation0128");
      } catch (e) {
        err = e;
      }
      expect(answered, label).toBeNull();
      expect(err, label).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).reasonCode, label).toBe("PROCESSING_STATE_BINDING_MISMATCH");
      expect(statusForError(err).status, label).toBe(400);
    }
    // Nothing was stored: same record version and data (no mismatch, no consent or delivery change), no audit event.
    const after = await env.store.load(TENANT, r.binding.interactionId);
    expect(after).toEqual(before);
    expect(after?.data.lastMismatch).toBeNull();
    expect(env.audit.events.length).toBe(auditsBefore);
  });

  it("[DATA-03] adversarial: a readout claiming a consent version the gateway never issued is refused", async () => {
    const r = await firstBind();
    const forged = { consentVersion: r.directive.consentVersion + 5, recording: { ...r.directive.recording, value: "GRANTED" as const }, transcriptionAiProcessing: r.directive.transcriptionAiProcessing };
    expect(await refusal(env.service.reportProcessing(runtime(), { claim: r.claim, state: readout(r, forged, "OFF") }, "cor_synthCorrelation0125"))).toBe("PROCESSING_STATE_VERSION_INVALID");
  });
});

/** A readout of the binding's call (helper for the tests below). */
function readoutOf(r: Awaited<ReturnType<CallBindingService["bind"]>>, recorderRefs: string[] = []): MediaProcessingState {
  const now = env.clock.now().toISOString();
  const tap = (phase: "ON" | "OFF", ref: string | null) => ({ phase, active: phase !== "OFF", ref, changedAt: now });
  return {
    schemaVersion: "media-processing-state.v1",
    tenantId: TENANT,
    interactionId: r.binding.interactionId,
    sessionGeneration: r.binding.sessionGeneration,
    occurredAt: now,
    bindingId: r.binding.bindingId,
    recording: tap("OFF", null),
    transcription: tap("OFF", null),
    analysis: tap("OFF", null),
    consent: { consentVersion: r.directive.consentVersion, recording: r.directive.recording, transcriptionAiProcessing: r.directive.transcriptionAiProcessing },
    disclosureTemplateId: null,
    mismatch: null,
    recorderRefs,
    changedAt: now,
  };
}

describe("a person requested for the room reaches a live AI binding [SAFE-02][FO-10-46]", () => {
  const roomOf = async () => {
    const r = await env.service.roomForRoute("room-a");
    return { roomSid: r.roomSid as string, interactionId: r.interactionId };
  };
  const wanted = { kind: "standard" as const, reason: "RECOVERY_FAILED" as const, language: "en" };
  const handoff = { handoffId: "hnd_synthHandoff000009", destinationId: "dst_support_general", speechTemplateId: "human.offer" };

  it("[SAFE-02][FO-10-46] a person owed (requested by another party, e.g. the supervisor's deadline route): the live owner's heartbeat is refused BINDING_PERSON_REQUESTED, its lifecycle and processing answers carry it; accepted: BINDING_WITH_PERSON", async () => {
    const a = await firstBind();
    expect((await env.service.heartbeat(runtime(), a.claim, "cor_synthCorrelation0401")).state).toBe("ACTIVE");
    const room = await roomOf();
    await env.service.notePersonRequested(room, wanted);
    expect(await refusal(env.service.heartbeat(runtime(), a.claim, "cor_synthCorrelation0402"))).toBe("BINDING_PERSON_REQUESTED");
    expect(env.audit.events.at(-1)).toMatchObject({ action: "call.binding.claim_refused", outcome: "DENIED", reasonCode: "BINDING_PERSON_REQUESTED", bindingId: a.binding.bindingId });
    // The facts are still recorded (pending actions void on hold; the readout is checked and stored), and answered so.
    const hold = await env.service.lifecycle(runtime(), { claim: a.claim, event: { kind: "HOLD_STARTED", participantRole: null, occurredAt: env.clock.now().toISOString() } }, "cor_synthCorrelation0403");
    expect(hold).toMatchObject({ routeToHuman: true, reasonCode: "BINDING_PERSON_REQUESTED", invalidatedActions: 1 });
    const report = await env.service.reportProcessing(runtime(), { claim: a.claim, state: readoutOf(a, ["EG_synthEgress0009"]) }, "cor_synthCorrelation0404");
    expect(report).toMatchObject({ accepted: true, mismatch: null, routeToHuman: true, reasonCode: "BINDING_PERSON_REQUESTED" });
    expect((await env.store.load(TENANT, a.binding.interactionId))?.data.recorders).toEqual([{ bindingId: a.binding.bindingId, egressId: "EG_synthEgress0009" }]);
    await env.service.notePersonAccepted(room, "standard", handoff, wanted);
    expect(await refusal(env.service.heartbeat(runtime(), a.claim, "cor_synthCorrelation0405"))).toBe("BINDING_WITH_PERSON");
    expect((await env.service.reportProcessing(runtime(), { claim: a.claim, state: readoutOf(a) }, "cor_synthCorrelation0406")).reasonCode).toBe("BINDING_WITH_PERSON");
    // The hang-up still ends the call, with no person flag (there is nobody left to route).
    const bye = await env.service.lifecycle(runtime(), { claim: a.claim, event: { kind: "CALLER_HUNG_UP", participantRole: "caller", occurredAt: env.clock.now().toISOString() } }, "cor_synthCorrelation0407");
    expect(bye).toMatchObject({ state: "ENDED", routeToHuman: false, reasonCode: "LIFECYCLE_CALLER_HUNG_UP" });
  });

  it("[SAFE-02][FO-10-46] the AI action path (WP-14's runtime tool calls) resolves a live claim only while no person is requested for the room: owed or accepted, the claim is refused for an AI action, whatever the worker does with its heartbeat answers", async () => {
    const a = await firstBind();
    expect((await env.service.resolveClaimForAiAction(runtime(), a.claim, "cor_synthCorrelation0430")).binding.bindingId).toBe(a.binding.bindingId);
    const room = await roomOf();
    await env.service.notePersonRequested(room, wanted);
    expect(await refusal(env.service.resolveClaimForAiAction(runtime(), a.claim, "cor_synthCorrelation0431"))).toBe("BINDING_PERSON_REQUESTED");
    expect(env.audit.events.at(-1)).toMatchObject({ action: "call.binding.claim_refused", outcome: "DENIED", reasonCode: "BINDING_PERSON_REQUESTED", bindingId: a.binding.bindingId });
    await env.service.notePersonAccepted(room, "standard", handoff, wanted);
    expect(await refusal(env.service.resolveClaimForAiAction(runtime(), a.claim, "cor_synthCorrelation0432"))).toBe("BINDING_WITH_PERSON");
    // The plain resolution (the gateway's own bookkeeping of the call, not an AI action) still names the binding.
    expect((await env.service.resolveClaim(runtime(), a.claim)).binding.bindingId).toBe(a.binding.bindingId);
  });

  it("[SAFE-02] control: a room without a person request renews and answers without a flag", async () => {
    const a = await firstBind();
    expect((await env.service.heartbeat(runtime(), a.claim, "cor_synthCorrelation0408")).state).toBe("ACTIVE");
    expect(await env.service.lifecycle(runtime(), { claim: a.claim, event: { kind: "HOLD_STARTED", participantRole: null, occurredAt: env.clock.now().toISOString() } }, "cor_synthCorrelation0409")).toMatchObject({ routeToHuman: false, reasonCode: "LIFECYCLE_HOLD_STARTED" });
    expect(await env.service.reportProcessing(runtime(), { claim: a.claim, state: readoutOf(a) }, "cor_synthCorrelation0410")).toMatchObject({ routeToHuman: false, reasonCode: "PROCESSING_STATE_CONSISTENT" });
  });

  it("[SAFE-02][FO-10-46] race: a person recorded and accepted between a re-dispatched runtime's person read and its write: the binding just written is never answered to the AI", async () => {
    await firstBind();
    const room = await roomOf();
    env.plane.leave("room-a", "agent-AJ_synthJobA0001");
    env.clock.advanceMs(91_000); // the crashed owner's binding expired
    env.plane.dispatch("room-a", "AJ_synthJobR0401", "agent-AJ_synthJobR0401");
    // The supervisor's deadline route lands right after the bind's first read of the room's person request.
    const get = env.kv.get.bind(env.kv);
    let hooked = false;
    (env.kv as { get: unknown }).get = async (pk: string) => {
      const v = await get(pk);
      if (!hooked && pk.startsWith("cbp#")) {
        hooked = true;
        await env.service.notePersonRequested(room, wanted);
        await env.service.notePersonAccepted(room, "standard", handoff, wanted);
      }
      return v;
    };
    expect(await refusal(env.service.bind(runtime(), bindReq("room-a", "AJ_synthJobR0401", "media-worker-r1"), "cor_synthCorrelation0411"))).toBe("BINDING_WITH_PERSON");
    expect(hooked).toBe(true);
    expect(env.audit.events.at(-1)).toMatchObject({ action: "call.binding.refused", reasonCode: "BINDING_WITH_PERSON" });
    // The binding the losing bind wrote is revoked: the record names no live AI owner of a call that is with a person.
    const stored = (await env.store.load(TENANT, room.interactionId))?.data;
    expect(stored?.binding).toMatchObject({ state: "REVOKED", sessionGeneration: 2 });
    expect(stored?.history.at(-1)).toMatchObject({ bindingId: stored?.binding.bindingId, state: "REVOKED" });
    expect(env.audit.events.filter((e) => e.action === "call.binding.revoked")).toEqual([expect.objectContaining({ outcome: "DENIED", bindingId: stored?.binding.bindingId, reasonCode: "BINDING_WITH_PERSON" })]);
  });

  it("[DATA-03][FO-10-46] the owner's own retry of its issuance after the caller declined AI processing is refused BINDING_CONSENT_REQUIRES_PERSON (never answered as a live binding)", async () => {
    const a = await firstBind();
    await env.service.consentDecision(runtime(), { claim: a.claim, dimension: "transcriptionAiProcessing", decision: "DECLINED", capturedVia: "dtmf_menu", occurredAt: env.clock.now().toISOString() }, "cor_synthCorrelation0412");
    expect(await refusal(env.service.bind(runtime(), bindReq("room-a", "AJ_synthJobA0001", "media-worker-a1"), "cor_synthCorrelation0413"))).toBe("BINDING_CONSENT_REQUIRES_PERSON");
    expect(env.audit.events.at(-1)).toMatchObject({ action: "call.binding.refused", reasonCode: "BINDING_CONSENT_REQUIRES_PERSON" });
  });
});

describe("the call's recorders are kept per binding and named to the next owner [DATA-03][FO-10-46]", () => {
  it("[DATA-03] each owner's reported recorders are kept once each, in order, and the next owner's bind answer names them all", async () => {
    const a = await firstBind();
    await env.service.reportProcessing(runtime(), { claim: a.claim, state: readoutOf(a, ["EG_synthEgressA001", "EG_synthEgressA002"]) }, "cor_synthCorrelation0420");
    // A repeated readout adds nothing.
    await env.service.reportProcessing(runtime(), { claim: a.claim, state: readoutOf(a, ["EG_synthEgressA002"]) }, "cor_synthCorrelation0421");
    expect((await env.store.load(TENANT, a.binding.interactionId))?.data.recorders).toEqual([
      { bindingId: a.binding.bindingId, egressId: "EG_synthEgressA001" },
      { bindingId: a.binding.bindingId, egressId: "EG_synthEgressA002" },
    ]);
    // Owner A crashes; B binds and is told A's recorders (the only ones it may adopt).
    env.plane.leave("room-a", "agent-AJ_synthJobA0001");
    env.plane.dispatch("room-a", "AJ_synthJobB0001", "agent-AJ_synthJobB0001");
    const b = await env.service.bind(runtime(), bindReq("room-a", "AJ_synthJobB0001", "media-worker-b1"), "cor_synthCorrelation0422");
    expect(b.issue).toBe("REBOUND_AFTER_OWNER_LOSS");
    expect(b.adoptableRecorders).toEqual(["EG_synthEgressA001", "EG_synthEgressA002"]);
    // B adopts one and starts its own: kept under B's binding; the same egress id under two bindings is named once.
    await env.service.reportProcessing(runtime(), { claim: b.claim, state: readoutOf(b, ["EG_synthEgressA002", "EG_synthEgressB001"]) }, "cor_synthCorrelation0423");
    const rec = (await env.store.load(TENANT, a.binding.interactionId))?.data.recorders;
    expect(rec).toEqual([
      { bindingId: a.binding.bindingId, egressId: "EG_synthEgressA001" },
      { bindingId: a.binding.bindingId, egressId: "EG_synthEgressA002" },
      { bindingId: b.binding.bindingId, egressId: "EG_synthEgressA002" },
      { bindingId: b.binding.bindingId, egressId: "EG_synthEgressB001" },
    ]);
    env.plane.leave("room-a", "agent-AJ_synthJobB0001");
    env.plane.dispatch("room-a", "AJ_synthJobC0001", "agent-AJ_synthJobC0001");
    const c = await env.service.bind(runtime(), bindReq("room-a", "AJ_synthJobC0001", "media-worker-c1"), "cor_synthCorrelation0424");
    expect(c.adoptableRecorders).toEqual(["EG_synthEgressA001", "EG_synthEgressA002", "EG_synthEgressB001"]);
  });
});
