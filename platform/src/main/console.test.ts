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
});
