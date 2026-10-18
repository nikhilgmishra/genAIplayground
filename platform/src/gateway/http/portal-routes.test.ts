/**
 * Portal verification audit evidence over the LOCAL FIXTURE composition (container + local
 * console, fastify.inject only; SYNTHETIC people and staff; LOCAL FIXTURE OIDC provider).
 * The verification.bound / verification.failed audit event carries the call id, the NON-bearer
 * session binding ref and the generation of the transaction's own call, so the call's audit
 * timeline and the console investigation include the binding; the portal response stays
 * {bound, reasonCode} and the bearer session reference is never stored or returned.
 */
import { afterEach, describe, expect, it } from "vitest";
import { buildBusiness } from "../../business/index.js";
import { CALLS, IDP, PEOPLE, STAFF } from "../../fixtures/synthetic-world.js";
import { sessionBindingRefFor } from "../../identity/keys.js";
import { buildLocalConsole } from "../../main/console.js";
import { buildContainer } from "../../main/container.js";
import type { Container } from "../../main/container.js";
import { createMemoryLogger } from "../../observability/logger.js";
import type { AuditEvent } from "../../protocol/index.js";
import { FakeClock } from "../../shared/clock.js";
import { newId } from "../../shared/ids.js";
import { LOCAL_FIXTURE_TOKENS } from "../auth.js";

let c: Container | null = null;
afterEach(async () => {
  await c?.close();
  c = null;
});

const bearer = (channel: keyof typeof LOCAL_FIXTURE_TOKENS) => ({ authorization: `Bearer ${LOCAL_FIXTURE_TOKENS[channel]}` });
const AVERY_SMS = PEOPLE.avery.channels[0].channelRef;

async function compose(): Promise<{ c: Container; clock: FakeClock; records: unknown[] }> {
  const clock = new FakeClock("2026-10-18T09:00:00.000Z");
  const { logger, records } = createMemoryLogger();
  const built = await buildContainer({ environment: "local", buildBusiness, clock, env: {}, logger, rateLimit: null, ingestKnowledge: false });
  c = built;
  return { c: built, clock, records };
}

async function startCall(cc: Container, clock: FakeClock, callId: string): Promise<string> {
  const res = await cc.app.inject({
    method: "POST",
    url: "/telephony/v1/calls",
    headers: bearer("telephony_control"),
    payload: { callId, callerIdHash: null, consent: { recording: "GRANTED", automatedProcessing: "GRANTED", disclosureTemplateVersion: "disclosure-local-v1", capturedAt: clock.now().toISOString(), capturedBy: "studio_flow" } },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { sessionRef: string }).sessionRef;
}

async function beginLink(cc: Container, sessionRef: string): Promise<{ transactionId: string; nonce: string }> {
  const begin = await cc.app.inject({
    method: "POST",
    url: "/telephony/v1/session/verification",
    headers: { ...bearer("telephony_control"), "x-vsp-session-ref": sessionRef },
    payload: { method: "secure_link", role: "client", locator: { fullName: PEOPLE.avery.fullName, dateOfBirth: PEOPLE.avery.dateOfBirth } },
  });
  expect(begin.statusCode).toBe(200);
  const path = cc.identity.notifications.lastTo(AVERY_SMS)?.slots.linkPath ?? "";
  const m = /\/(vtx_[A-Za-z0-9_-]+)#n=([A-Za-z0-9_-]{43})$/.exec(path);
  if (!m?.[1] || !m[2]) throw new Error("FIXTURE_NO_LINK");
  return { transactionId: m[1], nonce: m[2] };
}

async function approve(cc: Container, link: { transactionId: string; nonce: string }, matchCodeConfirmed: boolean) {
  const idToken = await cc.identity.idp.issueFor(PEOPLE.avery, { nonce: link.nonce, amr: ["pwd", "mfa"] });
  const res = await cc.app.inject({ method: "POST", url: "/portal/v1/verification/approve", headers: bearer("portal"), payload: { ...link, idToken, matchCodeConfirmed } });
  expect(res.statusCode).toBe(200);
  return { body: res.json() as Record<string, unknown>, idToken };
}

const eventsFor = (cc: Container, filter: { callId?: string; action?: string }): Promise<AuditEvent[]> => cc.auditQuery.search({ tenantId: cc.config.tenantId, limit: 200, ...filter });

describe("portal verification audit evidence (verification.bound / verification.failed)", () => {
  it("[OPS-01][SPEC-13.audit-event][AUTH-06] verification.bound carries the bound call id, the non-bearer binding ref and the generation; the console call timeline shows the binding", async () => {
    const { c: cc, clock, records } = await compose();
    const callId = CALLS.primary.callId;
    const sessionRef = await startCall(cc, clock, callId);
    const link = await beginLink(cc, sessionRef);
    const { body, idToken } = await approve(cc, link, true);
    // The portal answer is unchanged: no binding, no call id, no session reference.
    expect(body).toEqual({ bound: true, reasonCode: "VERIFIED" });

    const bound = await eventsFor(cc, { callId, action: "verification.bound" });
    expect(bound).toHaveLength(1);
    expect(bound[0]).toMatchObject({
      callId,
      sessionRef: sessionBindingRefFor(sessionRef),
      sessionGeneration: 1,
      sourceComponent: "identity",
      outcome: "SUCCEEDED",
      reasonCode: "SECURE_LINK_BOUND",
    });
    // Never the bearer reference, the nonce, the transaction id or the ID token.
    const stored = JSON.stringify(await eventsFor(cc, { action: "verification.bound" }));
    for (const secret of [sessionRef, link.nonce, link.transactionId, idToken]) expect(stored).not.toContain(secret);
    for (const secret of [sessionRef, link.nonce, idToken]) expect(JSON.stringify(records)).not.toContain(secret);

    // The console investigation of this call includes the binding (session change VERIFIED).
    const consoleApp = await buildLocalConsole(cc);
    try {
      const nowS = Math.floor(clock.now().getTime() / 1000);
      const token = await consoleApp.workforceIdp.issueIdToken({
        issuer: IDP.workforceIssuer,
        sub: STAFF.supervisor.idpSubject,
        nonce: newId("non"),
        audience: IDP.consoleAudience,
        amr: ["local_fixture", "mfa"],
        authTime: nowS,
        issuedAt: nowS,
        ttlSeconds: 900,
      });
      const detail = await consoleApp.app.inject({ method: "GET", url: `/console/api/v1/calls/${callId}`, headers: { authorization: `Bearer ${token}` } });
      expect(detail.statusCode).toBe(200);
      const timeline = (detail.json() as { timeline: { kind: string; change?: string }[] }).timeline;
      expect(timeline.filter((e) => e.kind === "session").map((e) => e.change)).toContain("VERIFIED");
      expect(detail.body).not.toContain(sessionRef);
    } finally {
      await consoleApp.app.close();
    }
  }, 120_000);

  it("[OPS-01][SPEC-14.FIXATION] a refused approval of an opened transaction is attributed to that call; an unknown transaction is attributed to no call", async () => {
    const { c: cc, clock } = await compose();
    const callId = CALLS.concurrent.callId;
    const sessionRef = await startCall(cc, clock, callId);
    const link = await beginLink(cc, sessionRef);
    const refused = await approve(cc, link, false);
    expect(refused.body).toEqual({ bound: false, reasonCode: "MATCH_CODE_NOT_CONFIRMED" });
    const failed = await eventsFor(cc, { callId, action: "verification.failed" });
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ callId, sessionRef: sessionBindingRefFor(sessionRef), sessionGeneration: 1, outcome: "DENIED", reasonCode: "MATCH_CODE_NOT_CONFIRMED" });

    // A reused (now consumed) link and an unknown transaction: refused, audited, never attributed to a call.
    const before = (await eventsFor(cc, { action: "verification.failed" })).length;
    const reused = await approve(cc, link, true);
    expect(reused.body).toEqual({ bound: false, reasonCode: "VERIFICATION_TRANSACTION_ALREADY_USED" });
    const unknown = await approve(cc, { transactionId: "vtx_unknownUnknownUnknown000001", nonce: link.nonce }, true);
    expect(unknown.body).toEqual({ bound: false, reasonCode: "VERIFICATION_TRANSACTION_UNAVAILABLE" });
    const all = await eventsFor(cc, { action: "verification.failed" });
    expect(all).toHaveLength(before + 2);
    const unattributed = all.filter((x) => x.reasonCode === "VERIFICATION_TRANSACTION_ALREADY_USED" || x.reasonCode === "VERIFICATION_TRANSACTION_UNAVAILABLE");
    expect(unattributed).toHaveLength(2);
    for (const e of unattributed) expect(e).toMatchObject({ callId: null, sessionRef: null, sessionGeneration: null });
    expect((await eventsFor(cc, { callId })).filter((e) => e.action === "verification.failed")).toHaveLength(1);
  }, 120_000);
});
