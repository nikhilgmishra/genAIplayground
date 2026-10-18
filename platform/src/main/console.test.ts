/**
 * LOCAL console composition over the local container (fastify.inject only).
 * SYNTHETIC staff via the LOCAL FIXTURE workforce IdP.
 */
import { afterEach, describe, expect, it } from "vitest";
import { buildBusiness } from "../business/index.js";
import { CALLS, IDP, STAFF } from "../fixtures/synthetic-world.js";
import { LOCAL_FIXTURE_TOKENS } from "../gateway/auth.js";
import { createMemoryLogger } from "../observability/logger.js";
import { FakeClock } from "../shared/clock.js";
import { newId } from "../shared/ids.js";
import { iso } from "../shared/clock.js";
import { buildLocalConsole } from "./console.js";
import { buildContainer } from "./container.js";
import type { Container } from "./container.js";

let c: Container | null = null;
afterEach(async () => {
  await c?.close();
  c = null;
});

describe("local console composition", () => {
  it("[SPEC-16.console][OPS-04] the console API runs over the same local composition: staff see the call started through the gateway; no token is refused", async () => {
    const clock = new FakeClock("2026-10-18T09:00:00.000Z");
    c = await buildContainer({ environment: "local", buildBusiness, clock, env: {}, logger: createMemoryLogger().logger, rateLimit: null, ingestKnowledge: false });
    const consoleApp = await buildLocalConsole(c);
    try {
      const start = await c.app.inject({
        method: "POST",
        url: "/telephony/v1/calls",
        headers: { authorization: `Bearer ${LOCAL_FIXTURE_TOKENS.telephony_control}` },
        payload: { callId: CALLS.primary.callId, callerIdHash: null, consent: { recording: "GRANTED", automatedProcessing: "GRANTED", disclosureTemplateVersion: "disclosure-local-v1", capturedAt: clock.now().toISOString(), capturedBy: "studio_flow" } },
      });
      expect(start.statusCode).toBe(201);
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
      expect((await consoleApp.app.inject({ method: "GET", url: "/console/api/v1/overview" })).statusCode).toBe(401);
      const overview = await consoleApp.app.inject({ method: "GET", url: "/console/api/v1/overview", headers: { authorization: `Bearer ${token}` } });
      expect(overview.statusCode).toBe(200);
      const calls = await consoleApp.app.inject({ method: "GET", url: "/console/api/v1/calls?state=active", headers: { authorization: `Bearer ${token}` } });
      expect(calls.statusCode).toBe(200);
      expect(calls.body).toContain(CALLS.primary.callId);
      // The bearer session reference never reaches the console.
      expect(calls.body).not.toContain((start.json() as { sessionRef: string }).sessionRef);
      expect(consoleApp.deps.killSwitchTargets.MODEL_VERSION).toEqual([c.config.models.active.model]);
    } finally {
      await consoleApp.app.close();
    }
  }, 120_000);

  it("[SPEC-7.break-glass][DATA-01] with the REAL business layer a restricted privacy complaint is readable in the console only after break-glass; the RLS restricted-reader flag gates the row", async () => {
    const clock = new FakeClock("2026-10-18T09:00:00.000Z");
    c = await buildContainer({ environment: "local", buildBusiness, clock, env: {}, logger: createMemoryLogger().logger, rateLimit: null, ingestKnowledge: false });
    const container = c;
    const consoleApp = await buildLocalConsole(container);
    try {
      const start = await container.app.inject({
        method: "POST",
        url: "/telephony/v1/calls",
        headers: { authorization: `Bearer ${LOCAL_FIXTURE_TOKENS.telephony_control}` },
        payload: { callId: CALLS.concurrent.callId, callerIdHash: null, consent: { recording: "GRANTED", automatedProcessing: "GRANTED", disclosureTemplateVersion: "disclosure-local-v1", capturedAt: clock.now().toISOString(), capturedBy: "studio_flow" } },
      });
      const sessionRef = (start.json() as { sessionRef: string }).sessionRef;
      const complaint = await container.app.inject({
        method: "POST",
        url: "/v1/tools/submit_complaint/1.0.0",
        headers: { authorization: `Bearer ${LOCAL_FIXTURE_TOKENS.mcp_tools}`, "x-vsp-session-ref": sessionRef, "idempotency-key": "idem_synthConsoleComplaint01" },
        payload: { arguments: { category: "PRIVACY_CONCERN", wantsCallback: false, language: "en" } },
      });
      const result = complaint.json() as { status: string; reasonCode?: string; data: { complaint: { supportReference: string } } };
      expect({ status: result.status, reasonCode: result.reasonCode ?? null }).toEqual({ status: "SUCCESS", reasonCode: null });
      const ref = result.data.complaint.supportReference;
      const tokenFor = async (subject: string) => {
        const nowS = Math.floor(clock.now().getTime() / 1000);
        return consoleApp.workforceIdp.issueIdToken({ issuer: IDP.workforceIssuer, sub: subject, nonce: newId("non"), audience: IDP.consoleAudience, amr: ["local_fixture", "mfa"], authTime: nowS, issuedAt: nowS, ttlSeconds: 900 });
      };
      const trace = async (subject: string) => consoleApp.app.inject({ method: "GET", url: `/console/api/v1/support-requests/${ref}/trace`, headers: { authorization: `Bearer ${await tokenFor(subject)}` } });
      expect((await trace(STAFF.agent.idpSubject)).statusCode).toBe(403);
      expect((await trace(STAFF.safety.idpSubject)).statusCode).toBe(403);
      const now = clock.now().getTime();
      await container.db.tx(
        (tx) =>
          tx.query(
            `insert into console_break_glass_grants (grant_id, tenant_id, staff_id, approved_by, justification_code, granted_at, expires_at, recorded_at)
             values ($1, $2, $3, $4, 'PRIVACY_INCIDENT', $5::timestamptz, $6::timestamptz, $7::timestamptz)`,
            [newId("bgl"), container.config.tenantId, STAFF.safety.staffId, STAFF.securityAdmin.staffId, iso(new Date(now - 60_000)), iso(new Date(now + 3_600_000)), iso(clock.now())],
          ),
        { role: "owner" },
      );
      const allowed = await trace(STAFF.safety.idpSubject);
      expect(allowed.statusCode).toBe(200);
      expect(JSON.parse(allowed.body)).toMatchObject({ supportRequest: { referenceNumber: ref, restricted: true }, sync: { state: "PENDING" } });
      expect((JSON.parse(allowed.body) as { sync: { outboxMessageIds: string[] } }).sync.outboxMessageIds).toHaveLength(1);
      // The same row is invisible to a console-view read without the flag (row-level security, not only the API gate).
      expect(await container.business.supportRequests.trace(container.config.tenantId, ref, { reader: { kind: "console", restrictedReader: false } })).toBeNull();
    } finally {
      await consoleApp.app.close();
    }
  }, 120_000);
});
