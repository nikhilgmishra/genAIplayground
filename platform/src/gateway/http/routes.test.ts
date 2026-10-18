/**
 * Gateway HTTP surface tests via fastify.inject (no sockets). LOCAL FIXTURE
 * integration tokens; SYNTHETIC people and calls; real policy bundle, PGlite,
 * audit writer, action ledger, identity services, response gate and safety pipeline.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CALLS, PEOPLE, SLOTS } from "../../fixtures/synthetic-world.js";
import { mcp } from "../../identity/identity-harness.fixture.js";
import { newId } from "../../shared/ids.js";
import { LOCAL_FIXTURE_TOKENS } from "../auth.js";
import { createAppHarness } from "../fixtures/app-harness.fixture.js";
import type { AppHarness } from "../fixtures/app-harness.fixture.js";
import { fixtureWebhookSignature } from "./webhook-routes.js";

let h: AppHarness;
afterEach(async () => {
  await h?.close();
});

const auth = (channel: keyof typeof LOCAL_FIXTURE_TOKENS) => ({ authorization: `Bearer ${LOCAL_FIXTURE_TOKENS[channel]}` });
const tel = (sessionRef?: string, extra: Record<string, string> = {}) => ({ ...auth("telephony_control"), ...(sessionRef ? { "x-vsp-session-ref": sessionRef } : {}), ...extra });
const consent = (at: string) => ({ recording: "GRANTED", automatedProcessing: "GRANTED", disclosureTemplateVersion: "disclosure-local-v1", capturedAt: at, capturedBy: "studio_flow" });

async function startCall(callId: string = CALLS.primary.callId): Promise<{ sessionRef: string; body: Record<string, unknown> }> {
  const res = await h.app.inject({ method: "POST", url: "/telephony/v1/calls", headers: tel(), payload: { callId, callerIdHash: null, consent: consent(h.identity.clock.now().toISOString()) } });
  expect(res.statusCode).toBe(201);
  const body = res.json() as Record<string, unknown>;
  return { sessionRef: body.sessionRef as string, body };
}

async function authGate(sessionRef?: string, extra: Record<string, string> = {}) {
  const res = await h.app.inject({ method: "GET", url: "/telephony/v1/session/auth-gate", headers: tel(sessionRef, extra) });
  expect(res.statusCode).toBe(200);
  return res.json() as Record<string, unknown>;
}

/** Full secure-link journey over the telephony and portal APIs. */
async function verifyAvery(sessionRef: string): Promise<void> {
  const begin = await h.app.inject({
    method: "POST",
    url: "/telephony/v1/session/verification",
    headers: tel(sessionRef),
    payload: { method: "secure_link", role: "client", locator: { fullName: PEOPLE.avery.fullName, dateOfBirth: PEOPLE.avery.dateOfBirth } },
  });
  expect(begin.statusCode).toBe(200);
  const matchCode = (begin.json() as { matchCode: string }).matchCode;
  const link = h.identity.linkFor(PEOPLE.avery.channels[0]?.channelRef ?? "");
  expect(link).not.toBeNull();
  if (!link) return;
  const described = await h.app.inject({ method: "POST", url: "/portal/v1/verification/describe", headers: auth("portal"), payload: link });
  expect(described.statusCode).toBe(200);
  expect((described.json() as { matchCode: string }).matchCode).toBe(matchCode);
  const idToken = await h.identity.idp.issueFor(PEOPLE.avery, { nonce: link.nonce, amr: ["pwd", "mfa"] });
  const approved = await h.app.inject({ method: "POST", url: "/portal/v1/verification/approve", headers: auth("portal"), payload: { ...link, idToken, matchCodeConfirmed: true } });
  expect(approved.json()).toEqual({ bound: true, reasonCode: "VERIFIED" });
}

describe("gateway HTTP — security posture and tool routes", () => {
  beforeEach(async () => {
    h = await createAppHarness();
  });

  it("[SPEC-14.http-security] helmet headers, no CORS, opaque request ids, generic error bodies with reason codes only", async () => {
    const res = await h.app.inject({ method: "GET", url: "/health/live", headers: { origin: "https://evil.example.invalid", "x-request-id": "Avery-Synthetic-1990-01-01" } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["strict-transport-security"]).toBeDefined();
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    expect(String(res.headers["x-request-id"])).toMatch(/^req_[A-Za-z0-9_-]{16,64}$/);
    const pre = await h.app.inject({ method: "OPTIONS", url: "/v1/tools/catalog", headers: { origin: "https://evil.example.invalid", "access-control-request-method": "GET" } });
    expect(pre.headers["access-control-allow-origin"]).toBeUndefined();
    const missing = await h.app.inject({ method: "GET", url: "/nope/Avery" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: { reasonCode: "NOT_FOUND", requestId: expect.stringMatching(/^req_/) } });
    expect(missing.body).not.toContain("Avery");
  });

  it("[SPEC-8.service-identity] every authenticated route requires its own channel credential", async () => {
    expect((await h.app.inject({ method: "GET", url: "/v1/tools/catalog" })).statusCode).toBe(401);
    expect((await h.app.inject({ method: "GET", url: "/v1/tools/catalog", headers: auth("telephony_control") })).statusCode).toBe(403);
    expect((await h.app.inject({ method: "GET", url: "/v1/tools/catalog", headers: auth("mcp_tools") })).statusCode).toBe(200);
    expect((await h.app.inject({ method: "POST", url: "/telephony/v1/calls", headers: auth("mcp_tools"), payload: {} })).statusCode).toBe(403);
    expect((await h.app.inject({ method: "POST", url: "/portal/v1/verification/describe", headers: auth("telephony_control"), payload: {} })).statusCode).toBe(403);
    const bad = await h.app.inject({ method: "GET", url: "/v1/tools/catalog", headers: { authorization: "Bearer not-a-real-token-at-all-0000" } });
    expect(bad.statusCode).toBe(401);
    expect(bad.json()).toMatchObject({ error: { reasonCode: "INTEGRATION_CREDENTIAL_INVALID" } });
  });

  it("[OPS-06][SPEC-8.tool-schema] GET /v1/tools/catalog serves the pinned catalogue and digest", async () => {
    const res = await h.app.inject({ method: "GET", url: "/v1/tools/catalog", headers: auth("mcp_tools") });
    const body = res.json() as { manifest: { digest: string; tools: { name: string }[] }; definitions: unknown[] };
    expect(body.manifest.digest).toBe(h.catalog.digest);
    expect(body.definitions).toHaveLength(h.catalog.definitions.length);
  });

  it("[SPEC-8.tool-pipeline] POST /v1/tools/:name/:version runs the same pipeline; session only from the trusted header", async () => {
    const { sessionRef } = await startCall();
    const res = await h.app.inject({ method: "POST", url: "/v1/tools/fixture_public_faq/1.0.0", headers: { ...auth("mcp_tools"), "x-vsp-session-ref": sessionRef, "x-vsp-turn-id": "turn_httpTurn001" }, payload: { arguments: { topic: "portal_login" } } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "SUCCESS", turnId: "turn_httpTurn001", tool: { name: "fixture_public_faq", version: "1.0.0" } });
    const unknown = await h.app.inject({ method: "POST", url: "/v1/tools/fixture_public_faq/2.0.0", headers: { ...auth("mcp_tools"), "x-vsp-session-ref": sessionRef }, payload: { arguments: { topic: "portal_login" } } });
    expect(unknown.json()).toMatchObject({ status: "PERMANENT_FAILURE", reasonCode: "UNKNOWN_TOOL_VERSION" });
    const extra = await h.app.inject({ method: "POST", url: "/v1/tools/fixture_public_faq/1.0.0", headers: auth("mcp_tools"), payload: { arguments: {}, sessionRef } });
    expect(extra.statusCode).toBe(400);
    expect(extra.body).not.toContain(sessionRef);
  });

  it("[SPEC-14.http-security] bodies are bounded JSON only", async () => {
    const big = await h.app.inject({ method: "POST", url: "/v1/tools/fixture_public_faq/1.0.0", headers: { ...auth("mcp_tools"), "content-type": "application/json" }, payload: JSON.stringify({ arguments: { topic: "x".repeat(70_000) } }) });
    expect(big.statusCode).toBe(413);
    expect(big.json()).toMatchObject({ error: { reasonCode: "PAYLOAD_TOO_LARGE" } });
    const text = await h.app.inject({ method: "POST", url: "/v1/tools/fixture_public_faq/1.0.0", headers: { ...auth("mcp_tools"), "content-type": "text/plain" }, payload: "hello" });
    expect(text.statusCode).toBe(415);
    const malformed = await h.app.inject({ method: "POST", url: "/v1/tools/fixture_public_faq/1.0.0", headers: { ...auth("mcp_tools"), "content-type": "application/json" }, payload: "{not json" });
    expect(malformed.statusCode).toBe(400);
  });

  it("[SPEC-13.readiness] /health/live and /health/ready report component readiness without versions or tenant data", async () => {
    expect((await h.app.inject({ method: "GET", url: "/health/live" })).json()).toEqual({ status: "live" });
    const ready = await h.app.inject({ method: "GET", url: "/health/ready" });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ ready: true, checks: { database: { ok: true, reasonCode: null }, policyBundle: { ok: true, reasonCode: null }, audit: { ok: true, reasonCode: null }, configGuard: { ok: true, reasonCode: null } } });
  });
});

describe("gateway HTTP — telephony control", () => {
  beforeEach(async () => {
    h = await createAppHarness();
  });

  it("[AUTH-07][SPEC-7.session] TC-01 creates an A0 session, returns authGate literal false, admits AI with a capacity lease, and audits without the bearer ref", async () => {
    const { sessionRef, body } = await startCall();
    expect(body).toMatchObject({ sessionGeneration: 1, authGate: false, admission: { admitted: true, continuity: "NONE", reasonCode: "ADMITTED" } });
    expect(h.admission.calls.at(-1)).toMatchObject({ class: "PUBLIC", newSession: true, vendor: "talkdesk-local" });
    expect(h.leases.get(sessionRef)?.decision.admitted).toBe(true);
    const rows = await h.auditRows();
    expect(rows.find((r) => r.action === "session.started")).toBeDefined();
    expect(JSON.stringify(rows)).not.toContain(sessionRef);
    expect(JSON.stringify(h.identity.records) + JSON.stringify(h.records)).not.toContain(sessionRef);
  });

  it("[AUTH-07] auth-gate matrix over HTTP: strict boolean true only for a current A2 session; false for missing, unknown, A0, expired, revoked, ended, superseded and other-call sessions", async () => {
    expect(await authGate()).toMatchObject({ isAuthenticated: false });
    expect(await authGate("ses_unknownUnknownUnknownUnknown0001")).toMatchObject({ isAuthenticated: false });
    const a0 = await startCall(CALLS.primary.callId);
    const gateA0 = await authGate(a0.sessionRef);
    expect(gateA0).toEqual({ isAuthenticated: false, sessionGeneration: 1, evaluatedAt: expect.any(String) });
    await verifyAvery(a0.sessionRef);
    const open = await authGate(a0.sessionRef);
    expect(open.isAuthenticated).toBe(true);
    expect(typeof open.isAuthenticated).toBe("boolean");
    expect(Object.keys(open).sort()).toEqual(["evaluatedAt", "isAuthenticated", "sessionGeneration"]);
    // Other call: the trusted interaction id names a different call.
    expect(await authGate(a0.sessionRef, { "x-vsp-interaction-id": CALLS.concurrent.callId })).toMatchObject({ isAuthenticated: false });
    // Participant change: new generation, privileges dropped.
    const change = await h.app.inject({ method: "POST", url: "/telephony/v1/session/change", headers: tel(a0.sessionRef), payload: { kind: "PARTICIPANT_CHANGED" } });
    expect(change.json()).toMatchObject({ sessionGeneration: 2 });
    expect(await authGate(a0.sessionRef)).toMatchObject({ isAuthenticated: false, sessionGeneration: 2 });
    // Reused session: a second call start for the same call supersedes (revokes) the first.
    await startCall(CALLS.primary.callId);
    expect(await authGate(a0.sessionRef)).toMatchObject({ isAuthenticated: false });
    // Expired and ended.
    const b = await startCall(CALLS.concurrent.callId);
    await verifyAvery(b.sessionRef);
    expect((await authGate(b.sessionRef)).isAuthenticated).toBe(true);
    h.identity.clock.advanceSeconds(7201);
    expect(await authGate(b.sessionRef)).toMatchObject({ isAuthenticated: false });
    const c = await startCall(CALLS.repeat.callId);
    await h.app.inject({ method: "POST", url: "/telephony/v1/session/end", headers: tel(c.sessionRef), payload: { reason: "CALLER_HANGUP" } });
    expect(await authGate(c.sessionRef)).toMatchObject({ isAuthenticated: false });
    // The model-facing credential cannot read the gate.
    expect((await h.app.inject({ method: "GET", url: "/telephony/v1/session/auth-gate", headers: { ...auth("mcp_tools"), "x-vsp-session-ref": c.sessionRef } })).statusCode).toBe(403);
  });

  it("[AUTH-01][SPEC-7.no-enumeration] verification begin returns the same generic response for zero, one and many matches; no locator value is echoed or logged", async () => {
    const { sessionRef } = await startCall();
    const bodies: unknown[] = [];
    for (const locator of [{ fullName: PEOPLE.avery.fullName, dateOfBirth: PEOPLE.avery.dateOfBirth }, { fullName: "Nobody Synthetic-Unknown", dateOfBirth: "1970-02-03" }]) {
      const r = await h.app.inject({ method: "POST", url: "/telephony/v1/session/verification", headers: tel(sessionRef), payload: { method: "secure_link", role: "client", locator } });
      const b = r.json() as Record<string, unknown>;
      bodies.push({ ...b, matchCode: typeof b.matchCode });
    }
    expect(bodies[0]).toEqual(bodies[1]);
    const everything = JSON.stringify(await h.auditRows()) + JSON.stringify(h.identity.records) + JSON.stringify(h.records);
    expect(everything).not.toContain("Nobody Synthetic-Unknown");
    expect(everything).not.toContain("1970-02-03");
  });

  it("[AUTH-06] OTP: disabled by default (TB-03) without touching the digits; when enabled, digits never appear in responses, logs or audit", async () => {
    const { sessionRef } = await startCall();
    const disabled = await h.app.inject({ method: "POST", url: "/telephony/v1/session/otp", headers: tel(sessionRef), payload: { challengeId: "otc_synthChallenge00000001", code: "481516" } });
    expect(disabled.statusCode).toBe(403);
    expect(disabled.json()).toMatchObject({ error: { reasonCode: "OTP_DISABLED_TB03" } });
    expect(disabled.body).not.toContain("481516");
    await h.close();
    h = await createAppHarness({ otpEnabled: true });
    const s = await startCall();
    const begin = await h.app.inject({ method: "POST", url: "/telephony/v1/session/verification", headers: tel(s.sessionRef), payload: { method: "otp", role: "client", locator: { fullName: PEOPLE.avery.fullName, dateOfBirth: PEOPLE.avery.dateOfBirth } } });
    const { challengeId, response } = begin.json() as { challengeId: string; response: string };
    expect(response).toBe("IF_ELIGIBLE_A_CODE_WAS_SENT");
    const code = h.identity.otpFor(PEOPLE.avery.channels[0]?.channelRef ?? "") as string;
    expect(code).toMatch(/^\d{6}$/);
    const wrongCode = code === "000000" ? "111111" : "000000";
    const wrong = await h.app.inject({ method: "POST", url: "/telephony/v1/session/otp", headers: tel(s.sessionRef), payload: { challengeId, code: wrongCode } });
    expect(wrong.json()).toEqual({ verified: false, reasonCode: "OTP_INCORRECT" });
    const malformed = await h.app.inject({ method: "POST", url: "/telephony/v1/session/otp", headers: tel(s.sessionRef), payload: { challengeId, code: `${code}9` } });
    expect(malformed.statusCode).toBe(400);
    const ok = await h.app.inject({ method: "POST", url: "/telephony/v1/session/otp", headers: tel(s.sessionRef), payload: { challengeId, code } });
    expect(ok.json()).toEqual({ verified: true, reasonCode: "VERIFIED" });
    const everything = [wrong.body, malformed.body, ok.body, JSON.stringify(await h.auditRows()), JSON.stringify(h.identity.records), JSON.stringify(h.records)].join("\n");
    expect(everything).not.toContain(code);
    expect(everything).not.toContain(wrongCode);
  });

  it("[ACT-01][ACT-05] TC-07 returns the server-side prepared action with a gateway-rendered prompt and a fresh turn; TC-08 binds confirmation to digest, generation and that turn", async () => {
    const { sessionRef } = await startCall();
    await verifyAvery(sessionRef);
    const ctx = await h.identity.sessions.resolve(sessionRef, mcp());
    const prepared = await h.actions.prepare(
      ctx,
      {
        kind: "appointment.reschedule",
        target: { system: "scheduling", recordType: "appointment", recordRef: "apt_synthAveryAppt00001", beforeVersion: "v1" },
        change: { slotId: SLOTS[0].slotId, fromDate: "2026-10-22", fromTime: "12:00", fromTimeZone: "America/Chicago", toDate: "2026-10-23", toTime: "12:00", toTimeZone: "America/Chicago" },
        impact: { summaryTemplateId: "appointment.change_confirmation", fees: null, reversible: true },
        confirmationTemplateId: "appointment.change_confirmation",
        ttlSeconds: 300,
        requiresStepUp: false,
      },
      { decisionId: newId("pdc"), allow: true, reasonCodes: ["ALLOW_SELF"], fieldMask: [], obligations: ["REQUIRE_CONFIRMATION"], policyVersion: ctx.policyVersion, evaluatedAt: h.identity.clock.now().toISOString() },
    );
    const pending = await h.app.inject({ method: "GET", url: "/telephony/v1/session/pending-confirmation", headers: tel(sessionRef) });
    expect(pending.statusCode).toBe(200);
    const p = pending.json() as { actionId: string; digest: string; turnId: string; promptText: string | null; sessionGeneration: number; routeToHuman: boolean };
    expect(p.actionId).toBe(prepared.actionId);
    expect(p.digest).toBe(prepared.digest);
    expect(p.routeToHuman).toBe(false);
    expect(p.promptText).toContain("October");
    // A digest from anything else (e.g. model-supplied) is not accepted.
    const confirmBody = { digest: p.digest, sessionGeneration: p.sessionGeneration, turnId: p.turnId, method: "dtmf_keypress", capturedAt: h.identity.clock.now().toISOString() };
    const ok = await h.app.inject({ method: "POST", url: `/telephony/v1/session/actions/${p.actionId}/confirm`, headers: tel(sessionRef), payload: confirmBody });
    expect(ok.json()).toEqual({ actionId: p.actionId, state: "CONFIRMED" });
    expect((await h.auditRows()).some((r) => r.action === "action.confirmation_captured" && r.outcome === "SUCCEEDED")).toBe(true);
  });

  it("[ACT-01][SPEC-11.barge-in] barge-in invalidates the confirmation turn and every pending action; a later confirmation is refused", async () => {
    const { sessionRef } = await startCall();
    await verifyAvery(sessionRef);
    const ctx = await h.identity.sessions.resolve(sessionRef, mcp());
    const prepared = await h.actions.prepare(
      ctx,
      {
        kind: "appointment.reschedule",
        target: { system: "scheduling", recordType: "appointment", recordRef: "apt_synthAveryAppt00001", beforeVersion: "v1" },
        change: { slotId: SLOTS[0].slotId },
        impact: { summaryTemplateId: "appointment.change_confirmation", fees: null, reversible: true },
        confirmationTemplateId: "appointment.change_confirmation",
        ttlSeconds: 300,
        requiresStepUp: false,
      },
      { decisionId: newId("pdc"), allow: true, reasonCodes: ["ALLOW_SELF"], fieldMask: [], obligations: ["REQUIRE_CONFIRMATION"], policyVersion: ctx.policyVersion, evaluatedAt: h.identity.clock.now().toISOString() },
    );
    const p = (await h.app.inject({ method: "GET", url: "/telephony/v1/session/pending-confirmation", headers: tel(sessionRef) })).json() as { turnId: string; digest: string; sessionGeneration: number; promptText: string | null };
    // Missing template slots: the prompt cannot be rendered, so Studio routes to a human.
    expect(p.promptText).toBeNull();
    const barge = await h.app.inject({ method: "POST", url: "/telephony/v1/session/barge-in", headers: tel(sessionRef) });
    expect(barge.json()).toEqual({ invalidatedTurn: true, invalidatedActions: 1 });
    const late = await h.app.inject({ method: "POST", url: `/telephony/v1/session/actions/${prepared.actionId}/confirm`, headers: tel(sessionRef), payload: { digest: p.digest, sessionGeneration: p.sessionGeneration, turnId: p.turnId, method: "dtmf_keypress", capturedAt: h.identity.clock.now().toISOString() } });
    expect(late.statusCode).toBe(409);
    expect(late.json()).toMatchObject({ error: { reasonCode: "CONFIRMATION_TURN_STALE" } });
    expect((await h.actions.get(ctx.tenantId, prepared.actionId))?.state).toBe("INVALIDATED");
    expect((await h.app.inject({ method: "GET", url: "/telephony/v1/session/pending-confirmation", headers: tel(sessionRef) })).statusCode).toBe(404);
  });

  it("[SAFE-02][DATA-01] utterance screening routes a safety signal to the priority route with no session at all; the text is never logged or audited", async () => {
    const text = "I want to kill myself tonight";
    const res = await h.app.inject({ method: "POST", url: "/telephony/v1/session/utterance-screening", headers: tel(), payload: { callId: CALLS.primary.callId, text, locale: "en-US", asrConfidence: 0.95 } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ route: "SAFETY_PRIORITY_HUMAN", destinationId: "dst_safety_priority", speechTemplateId: "safety.acknowledgment" });
    expect(h.handoff.safetyRequests).toHaveLength(1);
    expect(h.handoff.safetyRequests[0]).toMatchObject({ callId: CALLS.primary.callId, ctx: null });
    const rows = await h.auditRows();
    expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(["safety.signal", "safety.route_initiated"]));
    const everything = JSON.stringify(rows) + JSON.stringify(h.identity.records) + JSON.stringify(h.records);
    expect(everything).not.toContain("kill myself");
    expect(everything).not.toContain("tonight");
  });

  it("[SAFE-02][SAFE-03] the safety route still answers with the trusted safety destination when the handoff service fails; clinical questions take the clinical route", async () => {
    h.handoff.failing = true;
    const res = await h.app.inject({ method: "POST", url: "/telephony/v1/session/utterance-screening", headers: tel(), payload: { callId: CALLS.primary.callId, text: "I am going to end my life", locale: "en-US", asrConfidence: 0.9 } });
    expect(res.json()).toMatchObject({ route: "SAFETY_PRIORITY_HUMAN", destinationId: "dst_safety_priority", handoffId: null });
    h.handoff.failing = false;
    const clinical = await h.app.inject({ method: "POST", url: "/telephony/v1/session/utterance-screening", headers: tel(), payload: { callId: CALLS.primary.callId, text: "should I increase my medication dose", locale: "en-US", asrConfidence: 0.9 } });
    expect(clinical.json()).toMatchObject({ route: "CLINICAL_BOUNDARY_ROUTE", destinationId: "dst_clinical_route" });
    const none = await h.app.inject({ method: "POST", url: "/telephony/v1/session/utterance-screening", headers: tel(), payload: { callId: CALLS.primary.callId, text: "I need to reschedule my appointment", locale: "en-US", asrConfidence: 0.9 } });
    expect(none.json()).toMatchObject({ route: "NONE", handoffId: null });
  });

  it("[SAFE-02][SAFE-05] human request works with an invalid or missing session; a caller-supplied destination is rejected by the strict schema", async () => {
    const noSession = await h.app.inject({ method: "POST", url: "/telephony/v1/session/human-request", headers: tel(), payload: { callId: CALLS.primary.callId, reason: "CALLER_REQUESTED_HUMAN", language: "en", issueCategory: null } });
    expect(noSession.json()).toMatchObject({ accepted: true, destinationId: "dst_support_general" });
    const invalid = await h.app.inject({ method: "POST", url: "/telephony/v1/session/human-request", headers: tel("ses_revokedOrUnknownRefUnknown000001"), payload: { callId: CALLS.primary.callId, reason: "CALLER_REQUESTED_HUMAN", language: "en", issueCategory: null } });
    expect(invalid.json()).toMatchObject({ accepted: true });
    expect(h.handoff.humanRequests.every((r) => r.ctx === null)).toBe(true);
    for (const forged of [{ destinationId: "dst_safety_priority" }, { destination: "+15555550199" }, { queue: "sip:attacker@example.invalid" }]) {
      const r = await h.app.inject({ method: "POST", url: "/telephony/v1/session/human-request", headers: tel(), payload: { callId: CALLS.primary.callId, reason: "CALLER_REQUESTED_HUMAN", language: "en", issueCategory: null, ...forged } });
      expect(r.statusCode).toBe(400);
      expect(r.body).not.toContain("5555550199");
    }
    expect(h.handoff.humanRequests).toHaveLength(2);
    h.handoff.failing = true;
    const failing = await h.app.inject({ method: "POST", url: "/telephony/v1/session/human-request", headers: tel(), payload: { callId: CALLS.primary.callId, reason: "CALLER_REQUESTED_HUMAN", language: "en", issueCategory: null } });
    expect(failing.json()).toMatchObject({ accepted: false, destinationId: "dst_support_general", reasonCode: "HANDOFF_REQUEST_FAILED" });
  });

  it("[SAFE-05][SPEC-10.context] TC-12 handoff context: trusted destination, SAFETY priority after a safety escalation", async () => {
    const { sessionRef } = await startCall();
    const standard = await h.app.inject({ method: "GET", url: "/telephony/v1/session/handoff", headers: tel(sessionRef) });
    expect(standard.json()).toEqual({ destinationId: "dst_support_general", handoffId: null, supportReference: null, priority: "STANDARD" });
    await h.identity.sessions.applyChange(sessionRef, mcp({ channel: "telephony_control" }), { kind: "SAFETY_ESCALATION" });
    const safety = await h.app.inject({ method: "GET", url: "/telephony/v1/session/handoff", headers: tel(sessionRef) });
    expect(safety.json()).toMatchObject({ destinationId: "dst_safety_priority", priority: "SAFETY" });
  });

  it("[AUTH-04][ACT-04] TC-11 call end releases the lease, ends the session and records an evidence-based outcome (hang-up is not RESOLVED)", async () => {
    const { sessionRef } = await startCall();
    const res = await h.app.inject({ method: "POST", url: "/telephony/v1/session/end", headers: tel(sessionRef), payload: { reason: "CALLER_HANGUP" } });
    expect(res.json()).toEqual({ ended: true, outcome: "CALLER_DISCONNECTED", reasonCode: "CALLER_DISCONNECTED" });
    expect(h.leases.get(sessionRef)).toBeNull();
    expect(h.outcomes.calls[0]?.evidence).toMatchObject({ commitReceiptIds: [], callerDisconnected: true });
    const again = await h.app.inject({ method: "POST", url: "/telephony/v1/session/end", headers: tel(sessionRef), payload: { reason: "CALLER_HANGUP" } });
    expect(again.json()).toEqual({ ended: false, outcome: null, reasonCode: "SESSION_ENDED" });
    const tool = await h.call({ name: "fixture_public_faq", arguments: { topic: "portal_login" } }, { sessionRefHeader: sessionRef });
    expect(tool.status).toBe("POLICY_DENIED");
  });

  it("[AUTH-03] consent and role come only from the telephony identity; role change drops privileges", async () => {
    const { sessionRef } = await startCall();
    await verifyAvery(sessionRef);
    const role = await h.app.inject({ method: "POST", url: "/telephony/v1/session/role", headers: tel(sessionRef), payload: { role: "provider" } });
    expect(role.json()).toMatchObject({ sessionGeneration: 2 });
    expect(await authGate(sessionRef)).toMatchObject({ isAuthenticated: false });
    const consentRes = await h.app.inject({ method: "POST", url: "/telephony/v1/session/consent", headers: tel(sessionRef), payload: { ...consent(h.identity.clock.now().toISOString()), recording: "DECLINED" } });
    expect(consentRes.statusCode).toBe(200);
    const viaModel = await h.app.inject({ method: "POST", url: "/telephony/v1/session/consent", headers: { ...auth("mcp_tools"), "x-vsp-session-ref": sessionRef }, payload: consent(h.identity.clock.now().toISOString()) });
    expect(viaModel.statusCode).toBe(403);
  });
});

describe("gateway HTTP — portal and webhook", () => {
  it("[AUTH-07][SPEC-7.secure-link] matchCodeConfirmed must be a strict boolean; unknown transactions are indistinguishable", async () => {
    h = await createAppHarness();
    const { sessionRef } = await startCall();
    await h.app.inject({ method: "POST", url: "/telephony/v1/session/verification", headers: tel(sessionRef), payload: { method: "secure_link", role: "client", locator: { fullName: PEOPLE.avery.fullName, dateOfBirth: PEOPLE.avery.dateOfBirth } } });
    const link = h.identity.linkFor(PEOPLE.avery.channels[0]?.channelRef ?? "");
    if (!link) throw new Error("no link");
    const idToken = await h.identity.idp.issueFor(PEOPLE.avery, { nonce: link.nonce, amr: ["pwd", "mfa"] });
    const stringy = await h.app.inject({ method: "POST", url: "/portal/v1/verification/approve", headers: auth("portal"), payload: { ...link, idToken, matchCodeConfirmed: "true" } });
    expect(stringy.statusCode).toBe(400);
    const unconfirmed = await h.app.inject({ method: "POST", url: "/portal/v1/verification/approve", headers: auth("portal"), payload: { ...link, idToken, matchCodeConfirmed: false } });
    expect(unconfirmed.json()).toEqual({ bound: false, reasonCode: "MATCH_CODE_NOT_CONFIRMED" });
    const unknown = await h.app.inject({ method: "POST", url: "/portal/v1/verification/describe", headers: auth("portal"), payload: { transactionId: "vtx_unknownUnknownUnknown000001", nonce: link.nonce } });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ error: { reasonCode: "VERIFICATION_TRANSACTION_UNAVAILABLE" } });
    const all = JSON.stringify(await h.auditRows()) + JSON.stringify(h.identity.records) + JSON.stringify(h.records);
    expect(all).not.toContain(link.nonce);
    expect(all).not.toContain(idToken);
  });

  it("[TB-09][SPEC-8.webhook] transfer events: local fixture HMAC verified with timestamp window and replay protection; refused outside local/ci", async () => {
    h = await createAppHarness();
    const journey = await h.transfers.requestTransfer({
      handoffId: newId("hof"),
      tenantId: h.mcpIdentity.tenantId,
      callId: CALLS.primary.callId,
      sessionGeneration: 1,
      reason: "CALLER_REQUESTED_HUMAN",
      destinationId: "dst_support_general",
      statedIssue: "general_question",
      issueSummary: "Template-assembled synthetic summary.",
      assurance: "A0",
      assuranceLimits: [],
      authorizedSubjectRef: null,
      consent: { recording: "UNKNOWN", automatedProcessing: "UNKNOWN", disclosureTemplateVersion: null, capturedAt: null, capturedBy: "none" },
      actionReceiptIds: [],
      pendingActionIds: [],
      unresolvedTasks: [],
      supportReference: null,
      language: "en",
      accommodations: [],
      safetyRoutingReason: null,
      clinicalStatementsIncluded: false,
      verificationAssertion: null,
      createdAt: h.identity.clock.now().toISOString(),
    });
    const transferId = journey.currentTransferId as string;
    const body = { transferId, event: "QUEUED", eventId: "evt_fixture_0001" };
    const ts = Math.floor(h.identity.clock.now().getTime() / 1000);
    const headers = (sig: string, t = ts) => ({ "content-type": "application/json", "x-vsp-fixture-timestamp": String(t), "x-vsp-fixture-signature": sig });
    const ok = await h.app.inject({ method: "POST", url: "/v1/webhooks/transfer-events", headers: headers(fixtureWebhookSignature(ts, body)), payload: body });
    expect(ok.json()).toEqual({ accepted: true, decision: "applied" });
    const replay = await h.app.inject({ method: "POST", url: "/v1/webhooks/transfer-events", headers: headers(fixtureWebhookSignature(ts, body)), payload: body });
    expect(replay.json()).toMatchObject({ error: { reasonCode: "WEBHOOK_REPLAYED" } });
    const forged = await h.app.inject({ method: "POST", url: "/v1/webhooks/transfer-events", headers: headers(`sha256=${"0".repeat(64)}`), payload: { ...body, eventId: "evt_fixture_0002" } });
    expect(forged.json()).toMatchObject({ error: { reasonCode: "WEBHOOK_SIGNATURE_INVALID" } });
    const stale = await h.app.inject({ method: "POST", url: "/v1/webhooks/transfer-events", headers: headers(fixtureWebhookSignature(ts - 3600, body), ts - 3600), payload: body });
    expect(stale.json()).toMatchObject({ error: { reasonCode: "WEBHOOK_TIMESTAMP_INVALID" } });
    await h.close();
    h = await createAppHarness({ environment: "sandbox" });
    const refused = await h.app.inject({ method: "POST", url: "/v1/webhooks/transfer-events", headers: headers(fixtureWebhookSignature(ts, body)), payload: body });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: { reasonCode: "WEBHOOK_AUTH_UNVERIFIED" } });
  });

  it("[SPEC-12.rate-limit] per-integration rate limiting applies after authentication; safety and human routes are exempt", async () => {
    h = await createAppHarness({ rateLimit: { max: 2, timeWindowMs: 60_000 } });
    const codes: number[] = [];
    for (let i = 0; i < 3; i++) codes.push((await h.app.inject({ method: "GET", url: "/v1/tools/catalog", headers: auth("mcp_tools") })).statusCode);
    expect(codes).toEqual([200, 200, 429]);
    const human: number[] = [];
    for (let i = 0; i < 4; i++) human.push((await h.app.inject({ method: "POST", url: "/telephony/v1/session/human-request", headers: tel(), payload: { callId: CALLS.primary.callId, reason: "CALLER_REQUESTED_HUMAN", language: "en", issueCategory: null } })).statusCode);
    expect(human).toEqual([200, 200, 200, 200]);
  });
});
