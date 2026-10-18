import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { evaluateDeployability } from "../config/guard.js";
import type { GuardContext } from "../config/guard.js";
import { loadPlatformConfig } from "../config/loader.js";
import type { PlatformConfig } from "../config/ports.js";
import type { Environment } from "../protocol/index.js";
import { IDP, STAFF, TENANT_ID } from "../fixtures/synthetic-world.js";
import { ConfigurationRejectedError } from "../shared/errors.js";
import { BlockedWorkforceStaffDirectory, LocalWorkforceSignInFixture, WorkforceTokenVerifier } from "./auth.js";
import { CONSOLE_ENDPOINTS, PUBLIC_ENDPOINTS } from "./contract.js";
import type { AuthenticatedEndpointKey, EndpointKey } from "./contract.js";
import { createConsoleHarness } from "./fixtures/harness.fixture.js";
import type { ConsoleHarness } from "./fixtures/harness.fixture.js";
import { consoleRuntimeComponents, registerConsoleApi } from "./plugin.js";

let h: ConsoleHarness;
beforeAll(async () => {
  h = await createConsoleHarness();
});
afterAll(async () => {
  await h.close();
});

const AUTHENTICATED = (Object.keys(CONSOLE_ENDPOINTS) as EndpointKey[]).filter((k) => !(PUBLIC_ENDPOINTS as readonly string[]).includes(k)) as AuthenticatedEndpointKey[];
const SAMPLE_PARAMS: Record<string, string> = {
  callId: "cal_synthCallPrimary0001",
  ref: "SR-7KQM-W4XP",
  actionId: "act_synthAction000000001",
  messageId: "msg_synthMessage00000001",
  taskId: "tsk_synthTask0000000001",
  releaseId: "rel_synthRelease00000001",
};
const paramsFor = (k: EndpointKey): Record<string, string> =>
  Object.fromEntries([...CONSOLE_ENDPOINTS[k].path.matchAll(/:([A-Za-z]+)/g)].map((m) => [m[1] as string, SAMPLE_PARAMS[m[1] as string] as string]));
const loadConfigFile = (env: Environment): PlatformConfig => loadPlatformConfig({ environment: env, env: {} }).config;
const errorOf = (body: string): { reasonCode: string; correlationId: string | null; retryable: boolean } => (JSON.parse(body) as { error: { reasonCode: string; correlationId: string | null; retryable: boolean } }).error;

describe("console workforce authentication (spec section 7, AUTH-02/AUTH-03)", () => {
  it("[SPEC-7.staff-sso] local sign-in issues a short-lived MFA token for a SYNTHETIC staff member; identity and roles are server-established", async () => {
    const config = await h.call("auth.config");
    expect(JSON.parse(config.body)).toMatchObject({ mode: "local_fixture", localFixture: true, environment: "local", oidc: { status: "BLOCKED", blockedReasonCode: "WORKFORCE_OIDC_CLIENT_NOT_ISSUED" } });
    const picker = JSON.parse((await h.call("auth.localStaff")).body) as { label: string; staff: { staffId: string; roles: string[] }[] };
    expect(picker.label).toBe("LOCAL DEV SIGN-IN (synthetic staff)");
    expect(picker.staff.map((s) => s.staffId).sort()).toEqual(Object.values(STAFF).map((s) => s.staffId).sort());

    const issued = await h.call("auth.localToken", { body: { staffId: STAFF.agent.staffId } });
    expect(issued.statusCode).toBe(200);
    const token = JSON.parse(issued.body) as { accessToken: string; tokenType: string; expiresAt: string; localFixture: boolean };
    expect(token).toMatchObject({ tokenType: "Bearer", localFixture: true, expiresAt: "2026-10-17T15:15:00.000Z" });

    const me = await h.call("me", { token: token.accessToken });
    expect(me.statusCode).toBe(200);
    expect(JSON.parse(me.body)).toMatchObject({ staff: { staffId: STAFF.agent.staffId, roles: ["support_agent"], mfa: true, breakGlass: null }, tenantId: TENANT_ID, localFixture: true });
  });

  it("[AUTH-03] a request body cannot set roles or identity: unknown fields are rejected and roles come only from the directory", async () => {
    const r = await h.call("auth.localToken", { body: { staffId: STAFF.agent.staffId, roles: ["security_admin"] } });
    expect(r.statusCode).toBe(400);
    expect(errorOf(r.body).reasonCode).toBe("VALIDATION_FAILED");
    const unknown = await h.call("auth.localToken", { body: { staffId: "stf_notInTheDirectory01" } });
    expect(unknown.statusCode).toBe(404);
  });

  it("[SPEC-7.staff-sso] no MFA rejected: a token whose amr lacks an MFA method is refused on every authenticated endpoint", async () => {
    const token = await h.token("supervisor", { amr: ["pwd"] });
    for (const key of AUTHENTICATED) {
      const r = await h.call(key, { token, params: paramsFor(key) });
      expect(r.statusCode, key).toBe(401);
      expect(errorOf(r.body).reasonCode, key).toBe("STAFF_MFA_REQUIRED");
    }
  });

  it("[AUTH-02] missing, expired, wrong-audience, wrong-issuer, untrusted-key and over-long tokens fail closed with 401", async () => {
    expect(errorOf((await h.call("me")).body).reasonCode).toBe("UNAUTHENTICATED");
    expect(errorOf((await h.call("me", { headers: { authorization: "Basic abc" } })).body).reasonCode).toBe("UNAUTHENTICATED");
    const short = await h.token("supervisor", { ttlSeconds: 60 });
    h.clock.advanceSeconds(120);
    const expired = await h.call("me", { token: short });
    expect(expired.statusCode).toBe(401);
    expect(errorOf(expired.body).reasonCode).toBe("SESSION_EXPIRED");
    expect(errorOf((await h.call("me", { token: await h.token("supervisor", { audience: "vsp-portal-local" }) })).body).reasonCode).toBe("UNAUTHENTICATED");
    const forged = await h.idp.issueIdToken({ issuer: IDP.workforceIssuer, sub: STAFF.securityAdmin.idpSubject, nonce: "non_synthNonce00000001", audience: IDP.consoleAudience, amr: ["mfa"], signWithUntrustedKey: true });
    expect(errorOf((await h.call("me", { token: forged })).body).reasonCode).toBe("UNAUTHENTICATED");
    const otherIssuer = await h.idp.issueIdToken({ issuer: IDP.workforceIssuer, payloadIssuerOverride: IDP.clientIssuer, sub: STAFF.securityAdmin.idpSubject, nonce: "non_synthNonce00000002", audience: IDP.consoleAudience, amr: ["mfa"] });
    expect(errorOf((await h.call("me", { token: otherIssuer })).body).reasonCode).toBe("UNAUTHENTICATED");
    const longLived = await h.token("supervisor", { ttlSeconds: 7200 });
    expect(errorOf((await h.call("me", { token: longLived })).body).reasonCode).toBe("SESSION_LIFETIME_EXCEEDED");
  });

  it("[AUTH-04] logout revokes the session server-side in the same transaction as its audit event; the token then fails closed", async () => {
    const token = await h.token("knowledgeEditor");
    expect((await h.call("me", { token })).statusCode).toBe(200);
    const out = await h.call("auth.logout", { token });
    expect(out.statusCode).toBe(200);
    expect(JSON.parse(out.body)).toEqual({ loggedOut: true });
    const again = await h.call("me", { token });
    expect(again.statusCode).toBe(401);
    expect(errorOf(again.body).reasonCode).toBe("SESSION_REVOKED");
    const row = await h.db.query<{ audit_event_id: string }>("select audit_event_id from console_token_revocations where staff_id = $1", [STAFF.knowledgeEditor.staffId]);
    expect(row.rows).toHaveLength(1);
    const ev = await h.db.query<{ action: string; outcome: string }>("select action, outcome from audit_outbox where event_id = $1", [row.rows[0]?.audit_event_id]);
    expect(ev.rows[0]).toEqual({ action: "console.auth.logout", outcome: "SUCCEEDED" });
  });

  it("[SPEC-7.staff-separation] a role removed in the staff directory stops working on the next request (roles are not cached in the token)", async () => {
    const token = await h.token("deployOperator");
    expect((await h.call("budgets.list", { token })).statusCode).toBe(200);
    h.directory.update(STAFF.deployOperator.staffId, { active: false });
    try {
      const r = await h.call("budgets.list", { token });
      expect(r.statusCode).toBe(401);
      expect(errorOf(r.body).reasonCode).toBe("STAFF_NOT_PROVISIONED");
    } finally {
      h.directory.update(STAFF.deployOperator.staffId, { active: true });
    }
  });

  it("[OPS-04] local sign-in routes are absent in a production-config registration and answer 404 LOCAL_FIXTURE_DISABLED", async () => {
    const app = Fastify({ logger: false });
    const verifier = WorkforceTokenVerifier.remoteJwks({ issuer: "https://sso-workforce.example.com", audience: "vsp-console", jwksUrl: "https://sso-workforce.example.com/.well-known/jwks.json", clock: h.clock });
    await registerConsoleApi(app, { ...h.deps, environment: "production", localFixture: false, auth: { ...h.deps.auth, verifier, staffDirectory: new BlockedWorkforceStaffDirectory(), localSignIn: null } });
    await app.ready();
    try {
      expect(app.hasRoute({ method: "POST", url: "/console/api/v1/auth/local/token" })).toBe(false);
      expect(app.hasRoute({ method: "GET", url: "/console/api/v1/auth/local/staff" })).toBe(false);
      for (const [method, url] of [["POST", "/console/api/v1/auth/local/token"], ["GET", "/console/api/v1/auth/local/staff"]] as const) {
        const r = await app.inject({ method, url, headers: { "content-type": "application/json" }, payload: method === "POST" ? JSON.stringify({ staffId: STAFF.supervisor.staffId }) : undefined });
        expect(r.statusCode).toBe(404);
        expect(errorOf(r.body).reasonCode).toBe("LOCAL_FIXTURE_DISABLED");
      }
      const cfg = JSON.parse((await app.inject({ method: "GET", url: "/console/api/v1/auth/config" })).body) as { mode: string; localFixture: boolean; oidc: { status: string } };
      expect(cfg).toMatchObject({ mode: "oidc_workforce", localFixture: false, oidc: { status: "BLOCKED" } });
      // A local-fixture token is never accepted by the live verifier.
      expect((await app.inject({ method: "GET", url: "/console/api/v1/me", headers: { authorization: `Bearer ${await h.token("supervisor")}` } })).statusCode).toBe(401);
      const exchange = await app.inject({ method: "POST", url: "/console/api/v1/auth/oidc/exchange", headers: { "content-type": "application/json" }, payload: "{}" });
      expect(exchange.statusCode).toBe(400);
      expect(consoleRuntimeComponents({ auth: { ...h.deps.auth, verifier, localSignIn: null } })).toEqual({ "workforce-sso": "live" });
    } finally {
      await app.close();
    }
  });

  it("[OPS-04] registration fails closed when local fixture identity components are configured outside local/ci", async () => {
    for (const environment of ["sandbox", "staging", "production"] as const) {
      const app = Fastify({ logger: false });
      await expect(registerConsoleApi(app, { ...h.deps, environment })).rejects.toBeInstanceOf(ConfigurationRejectedError);
      await app.close();
      expect(() => new LocalWorkforceSignInFixture({ environment, idp: h.idp, directory: h.directory, clock: h.clock })).toThrow(ConfigurationRejectedError);
    }
  });

  it("[OPS-04] the configuration guard rejects a local_fixture workforce IdP or console local sign-in outside local/ci", () => {
    const ctxFor = (adapterKinds: GuardContext["adapterKinds"]): GuardContext => ({ approvals: [], adapterKinds, loadedPolicy: null, toolCatalogDigest: null, now: h.clock.now() });
    const has = (r: ReturnType<typeof evaluateDeployability>, code: string, path: string) => r.violations.some((v) => v.code === code && v.path === path);
    for (const env of ["sandbox", "staging", "production"] as const) {
      const cfg = structuredClone(loadConfigFile(env));
      const sso = cfg.adapters["workforce-sso"];
      if (!sso) throw new Error("workforce-sso adapter missing from committed config");
      cfg.adapters["workforce-sso"] = { ...sso, kind: "local_fixture" };
      const r = evaluateDeployability(cfg, ctxFor({ "workforce-sso": "local_fixture", "console-local-sign-in": "local_fixture" }));
      expect(r.deployable, env).toBe(false);
      // Declared kind: rejected in staging/production (sandbox keeps fixtures for unapproved systems, OPS-05).
      expect(has(r, "WORKFORCE_IDP_LOCAL_FIXTURE_OUTSIDE_OFFLINE", "adapters.workforce-sso"), env).toBe(env !== "sandbox");
      // Runtime components: rejected in every environment outside local/ci.
      expect(has(r, "WORKFORCE_IDP_LOCAL_FIXTURE_OUTSIDE_OFFLINE", "runtime.workforce-sso"), env).toBe(true);
      expect(has(r, "CONSOLE_LOCAL_SIGN_IN_OUTSIDE_OFFLINE", "runtime.console-local-sign-in"), env).toBe(true);
    }
    for (const env of ["local", "ci"] as const) {
      const r = evaluateDeployability(loadConfigFile(env), ctxFor(consoleRuntimeComponents(h.deps)));
      expect(r.violations.filter((v) => v.code.startsWith("WORKFORCE_") || v.code.startsWith("CONSOLE_")), env).toEqual([]);
    }
  });
});

describe("WorkforceTokenVerifier (jose) claim checks", () => {
  const ISSUER = "https://sso-workforce.local.invalid";
  const AUD = "vsp-console-local";
  const setup = async (kind: "local_fixture" | "live" = "local_fixture") => {
    const { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } = await import("jose");
    const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
    const jwk = { ...(await exportJWK(publicKey)), kid: "local-test-key", alg: "ES256", use: "sig" };
    const verifier = new WorkforceTokenVerifier({
      kind,
      clock: h.clock,
      keys: createLocalJWKSet({ keys: [jwk] }),
      policy: { issuer: ISSUER, audience: AUD, algorithms: ["ES256"], clockToleranceSeconds: 5, maxTokenLifetimeSeconds: 3600, acceptedMfaAmr: ["mfa", "hwk"], allowLocalFixtureAmr: kind === "local_fixture" },
    });
    const nowS = Math.floor(h.clock.now().getTime() / 1000);
    const sign = (claims: Record<string, unknown>, alg = "ES256") =>
      new SignJWT({ auth_time: nowS, amr: ["mfa"], ...claims })
        .setProtectedHeader({ alg, kid: "local-test-key" })
        .setIssuer(ISSUER)
        .setAudience(AUD)
        .setSubject("workforce|synth-supervisor")
        .setIssuedAt(nowS)
        .setExpirationTime(nowS + 600)
        .setJti("jti_synthTokenId00000001")
        .sign(privateKey);
    return { verifier, sign, nowS };
  };

  it("[AUTH-02] a token that is not yet valid (nbf in the future) is refused", async () => {
    const { verifier, sign, nowS } = await setup();
    await expect(verifier.verify(await sign({ nbf: nowS + 600 }))).rejects.toMatchObject({ reasonCode: "SESSION_NOT_YET_VALID", status: 401 });
    await expect(verifier.verify(await sign({ nbf: nowS - 10 }))).resolves.toMatchObject({ subject: "workforce|synth-supervisor" });
  });

  it("[AUTH-02] required claims (jti, auth_time, amr) and the algorithm allowlist are enforced; an unsigned token is refused", async () => {
    const { verifier, sign } = await setup();
    await expect(verifier.verify(await sign({ auth_time: undefined }))).rejects.toMatchObject({ status: 401 });
    await expect(verifier.verify(await sign({ amr: undefined }))).rejects.toMatchObject({ status: 401 });
    const unsigned = `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${Buffer.from(JSON.stringify({ iss: ISSUER, aud: AUD, sub: "x" })).toString("base64url")}.`;
    await expect(verifier.verify(unsigned)).rejects.toMatchObject({ reasonCode: "UNAUTHENTICATED" });
    await expect(verifier.verify(await sign({ amr: ["pwd"] }))).rejects.toMatchObject({ reasonCode: "STAFF_MFA_REQUIRED" });
    await expect(verifier.verify(await sign({ auth_time: Math.floor(h.clock.now().getTime() / 1000) + 3600 }))).rejects.toMatchObject({ reasonCode: "STAFF_AUTH_TIME_INVALID" });
  });

  it("[OPS-04] a live verifier refuses LOCAL FIXTURE tokens even when they carry an MFA amr", async () => {
    const { verifier, sign } = await setup("live");
    await expect(verifier.verify(await sign({ amr: ["local_fixture", "mfa"] }))).rejects.toMatchObject({ reasonCode: "LOCAL_FIXTURE_TOKEN_REJECTED" });
    await expect(verifier.verify(await sign({ amr: ["hwk"] }))).resolves.toMatchObject({ localFixture: false });
    expect(() => new WorkforceTokenVerifier({ kind: "live", clock: h.clock, keys: async () => { throw new Error("unused"); }, policy: { ...verifier.policy, allowLocalFixtureAmr: true } })).toThrow();
  });
});
