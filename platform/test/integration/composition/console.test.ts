/**
 * Layer 2 (WP-07; FO-21-03, FO-03-49, FO-14-53, AUTH-02, OPS-04): the live console composed over the live
 * container in the sandbox profile, against the shared Keycloak 26 (through the test's front proxy as the
 * SYNTHETIC routable name idp.vsp-composition.example.com; the sandbox-only resolver maps it to the private host
 * interface). Everything under test is production code: buildLiveConsole, OidcDiscovery / OidcRelyingPartyClient
 * over OidcHttp sharing the container's EgressGuard and ConnectorHttpTransport, WorkforceTokenVerifier over the
 * discovered remote JWKS, OidcGroupStaffDirectory (CLIENT_ROLES), the AES-GCM sealer keyed from Secrets Manager,
 * PgConsoleSessionStore on PostgreSQL 16, the confidential client's secret from Secrets Manager, and the
 * workforce-sso adapter admitted by a KMS-signed VENDOR_SANDBOX_INTEGRATION approval.
 *
 * Covered: the console boots and serves auth/config from the IdP's own discovery; a staff member signs in with
 * the backend PKCE exchange and /me answers with the IdP-granted role (the verifier fetched the JWKS through the
 * transport); local sign-in is not registered and fixture or self-signed tokens are refused; the auth prefix is
 * rate limited; an unreachable IdP does not stop the console and sign-in fails closed. A staff safety escalation
 * without telephony control (the live console) still revokes the call's pending mutations and records the safety
 * event before the dial is refused (SAFE-HANDOFF-05).
 */
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect } from "vitest";
import { s256Challenge } from "../../../src/adapters/live/oidc-client.js";
import { buildAuditInput } from "../../../src/audit/build-input.js";
import { SESSION_AUDIT_ACTIONS } from "../../../src/business/contract.js";
import { DEFAULT_WORKFORCE_SESSION } from "../../../src/console-api/sso-config.js";
import { sessionRefHash } from "../../../src/identity/keys.js";
import { buildLiveConsole } from "../../../src/main/live-console.js";
import type { LiveConsole } from "../../../src/main/live-console.js";
import type { LiveContainer } from "../../../src/main/live-container.js";
import { ensurePolicyBundle } from "../../../src/policy/ensure-bundle.js";
import type { IntegrationIdentity } from "../../../src/protocol/index.js";
import { newId } from "../../../src/shared/ids.js";
import { Keycloak, totp } from "../_harness/keycloak.js";
import { layer2, layer2Context } from "../_harness/layer2.js";
import { CLIENT_ROLES_CLAIM, newUser, realmName, realmRep } from "../identity/support.js";
import { IDP_HOST, ProxyBrowser, SUBSTRATE, TENANT, TlsFrontProxy, bootLive, createPki, createSecretValue, kmsSignedApproval, privateResolver, provisionSandbox, refusal } from "./support.js";
import type { Sandbox, TestPki } from "./support.js";

const SERVICES = [...SUBSTRATE, "keycloak"];
const it = layer2(SERVICES);
const REALM = realmName("console");
const CLIENT = { clientId: "vsp-console", secret: randomBytes(24).toString("base64url") };
const REDIRECT = "https://console.vsp-composition.example.com/auth/callback";
const supervisor = newUser("comp-supervisor", ["/vsp/supervisor"]);

let sb: Sandbox;
let kc: Keycloak;
let pki: TestPki;
let proxy: TlsFrontProxy;
let origin: string;
let c: LiveContainer;
let live: LiveConsole;

beforeAll(async () => {
  const l2 = layer2Context(SERVICES);
  ensurePolicyBundle();
  sb = await provisionSandbox(l2);
  pki = createPki([IDP_HOST]);
  proxy = new TlsFrontProxy(pki, { port: l2.port("keycloak", 8443), servername: "localhost" });
  const port = await proxy.start();
  origin = `https://${IDP_HOST}:${port}`;
  kc = new Keycloak(`https://localhost:${l2.port("keycloak", 8443)}`);
  const rep = realmRep({ realm: REALM, client: { ...CLIENT, redirectUri: REDIRECT }, users: [supervisor], groups: ["/vsp/supervisor"], groupClientRoles: { "/vsp/supervisor": "supervisor" } });
  await kc.createRealm({ ...rep, attributes: { frontendUrl: origin } });
  await kc.setAuthenticatorReference(REALM, "browser", "auth-username-password-form", "pwd");
  await kc.setAuthenticatorReference(REALM, "browser", "auth-otp-form", "otp");

  const approval = await kmsSignedApproval(sb.kms, sb.keys.trust, { scope: "VENDOR_SANDBOX_INTEGRATION", role: "identity_owner" });
  sb.writeApproval(approval);
  const credentialRef = await createSecretValue(sb.sm, "workforce-client", JSON.stringify({ clientSecret: CLIENT.secret }));
  const cfg = sb.config();
  cfg.adapters["workforce-sso"] = { kind: "live", endpoint: origin, credentialRef, authMethod: "oauth2_client_credentials", exceptionApprovalId: null, timeoutMs: 5_000, integrationApprovalId: approval.approvalId };
  cfg.infrastructure.privateNetworkHosts = [IDP_HOST];
  cfg.egress.destinations = [
    { destinationId: "egr_workforce_idp", kind: "VERIFICATION_SERVICE", hosts: [`${IDP_HOST}:${port}`], allowedClasses: ["PUBLIC", "VERIFICATION_SECRET"], coverage: { baaRef: null, approvalId: "apr_synthCompositionIdp01" }, environments: ["sandbox"], adapterKind: "live" },
  ];
  (cfg as Record<string, unknown>).consoleAuth = {
    tenantId: TENANT,
    issuer: `${origin}/realms/${REALM}`,
    clientId: CLIENT.clientId,
    scopes: ["openid"],
    redirectUris: [REDIRECT],
    groupsClaim: CLIENT_ROLES_CLAIM,
    membershipSource: { kind: "CLIENT_ROLES" },
    groupRoles: { supervisor: "supervisor" },
    managedGroupPrefix: null,
    // The default MFA rule (no tenant override): Keycloak's password + TOTP login carries amr [pwd, otp].
    acceptedMfaAmr: null,
    maxAuthAgeSeconds: 600,
    loginTransactionTtlSeconds: 600,
    session: DEFAULT_WORKFORCE_SESSION,
    sessionParametersApprovalId: null,
  };
  sb.writeConfig(cfg);
  ({ c } = await bootLive(sb, { unit: "console", network: { resolve: privateResolver([IDP_HOST]), tlsCa: [pki.caPem] } }));
  live = await buildLiveConsole(c, { sweepIntervalMs: 0, authRateLimit: { max: 1_000, timeWindowMs: 60_000 } });
}, 180_000);

afterAll(async () => {
  await live?.close();
  await c?.close();
  await kc?.deleteRealm(REALM);
  await proxy?.stop();
  await sb?.close();
  pki?.dispose();
});

const json = (body: string) => JSON.parse(body) as Record<string, unknown>;

interface SignedIn {
  authorizationUrl: string;
  accessToken: string;
  sessionKind: string;
  localFixture: boolean;
}
let signedIn: SignedIn | null = null;

/**
 * The supervisor's console sign-in through the backend PKCE exchange (the hosted IdP login, test plumbing). Done
 * once per file and reused: Keycloak refuses a TOTP code a second time inside its 30-second window.
 */
async function signInSupervisor(): Promise<SignedIn> {
  if (signedIn) return signedIn;
  const verifier = randomBytes(48).toString("base64url");
  const start = await live.app.inject({ method: "POST", url: "/console/api/v1/auth/oidc/start", payload: { redirectUri: REDIRECT, codeChallenge: s256Challenge(verifier), codeChallengeMethod: "S256" } });
  expect(start.statusCode, start.body).toBe(200);
  const { authorizationUrl } = json(start.body) as { authorizationUrl: string };
  const back = await new ProxyBrowser({ origin, address: proxy.address, port: proxy.port, caPem: pki.caPem, totp: (k) => totp(k) }).signIn(authorizationUrl, supervisor, REDIRECT);
  if ("refused" in back) throw new Error(`IDP_REFUSED_LOGIN: ${back.refused}`);
  const exchange = await live.app.inject({ method: "POST", url: "/console/api/v1/auth/oidc/exchange", payload: { code: back.code, state: back.state, codeVerifier: verifier, redirectUri: REDIRECT } });
  expect(exchange.statusCode, exchange.body).toBe(200);
  const token = json(exchange.body) as { accessToken: string; sessionKind: string; localFixture: boolean };
  signedIn = { authorizationUrl, accessToken: token.accessToken, sessionKind: token.sessionKind, localFixture: token.localFixture };
  return signedIn;
}

describe("live console over the live container [FO-21-03]", () => {
  it("[FO-21-03][FO-03-49][OPS-04] positive: the console boots in the sandbox profile; auth/config is served from the IdP's own discovery (SSO mode, no local fixture)", async () => {
    expect([c.activation.state("identity.workforce"), c.activation.state("operator.console")]).toEqual(["CONFIGURED", "CONFIGURED"]);
    const r = await live.app.inject({ method: "GET", url: "/console/api/v1/auth/config" });
    expect(r.statusCode, r.body).toBe(200);
    const body = json(r.body) as { mode: string; localFixture: boolean; environment: string; oidc: { status: string; authorizationEndpoint: string | null; issuer: string | null } };
    expect([body.mode, body.localFixture, body.environment, body.oidc.status]).toEqual(["oidc_workforce", false, "sandbox", "CONFIGURED"]);
    expect(body.oidc.authorizationEndpoint).toBe(`${origin}/realms/${REALM}/protocol/openid-connect/auth`);
    expect(proxy.paths).toContain(`/realms/${REALM}/.well-known/openid-configuration`);
  });

  it("[FO-21-03][AUTH-02] positive: a staff member signs in with the backend PKCE exchange; /me answers with the IdP-granted role, verified against the remote JWKS fetched through the transport", async () => {
    const token = await signInSupervisor();
    expect(new URL(token.authorizationUrl).origin).toBe(origin);
    expect([token.sessionKind, token.localFixture]).toEqual(["OIDC_SSO", false]);
    const me = await live.app.inject({ method: "GET", url: "/console/api/v1/me", headers: { authorization: `Bearer ${token.accessToken}` } });
    expect(me.statusCode, me.body).toBe(200);
    expect(json(me.body)).toMatchObject({ staff: { roles: ["supervisor"], mfa: true }, tenantId: TENANT, localFixture: false });
    // The backend exchanged the code and fetched the key set through the egress-classified transport.
    expect(proxy.paths).toEqual(expect.arrayContaining([`/realms/${REALM}/protocol/openid-connect/token`, `/realms/${REALM}/protocol/openid-connect/certs`]));
  });

  it("[SAFE-HANDOFF-05][SAFE-03][FO-21-03][OPS-01] adversarial: without telephony control (the live console) a staff SAFETY escalation still revokes the call's pending mutations and records the safety event; only the dial is refused (telephony guard port) and the response says so; a plain transfer is refused before anything happens", async () => {
    // A call with a verified A2 session and a PREPARED action, through the production session store, audit writer
    // and ledger. The telephony unit's session events are written as that unit writes them (its routes are not
    // mounted in this build): the console's call view reads them. Caller verification is NOT_CONFIGURED here
    // (identity.caller, WP-19), so the verified state is written through the SessionStore (labelled plumbing).
    const ident = (channel: IntegrationIdentity["channel"]): IntegrationIdentity => ({ integrationId: "it-contact-center", tenantId: TENANT, environment: "sandbox", channel, credentialId: `cred-${channel.replace(/_/g, "-")}`, authMethod: "oauth2_client_credentials" });
    const startCallWithEvents = async () => {
      const callId = newId("cal");
      const started = await c.identity.sessions.startCall({
        integration: ident("telephony_control"),
        callId,
        callerIdHash: null,
        consent: { recording: "GRANTED", automatedProcessing: "GRANTED", disclosureTemplateVersion: "disclosure-l2-v1", capturedAt: new Date().toISOString(), capturedBy: "studio_flow" },
      });
      for (const action of [SESSION_AUDIT_ACTIONS.started, SESSION_AUDIT_ACTIONS.consentRecorded]) {
        await c.audit.appendStandalone(
          buildAuditInput({ tenantId: TENANT, callId, sessionGeneration: 1, correlationId: newId("cor"), sourceComponent: "telephony_control", action, outcome: "SUCCEEDED", assurance: "A0", occurredAt: new Date().toISOString() }),
        );
      }
      return { callId, started };
    };
    const { callId, started } = await startCallWithEvents();
    const bound = await c.identity.sessions.store.mutate(sessionRefHash(started.sessionRef), (rec, now) => ({
      ...rec,
      lastActivityAt: now.toISOString(),
      actorId: "act_synthConsoleSafetyCaller1",
      accountId: "acc_synthConsoleSafetyCaller1",
      selectedRole: "client",
      subjectId: "sub_synthConsoleSafetyCaller1",
      organizationId: null,
      delegatedAuthority: [],
      permittedScopes: ["appointment:prepare_change", "appointment:commit_change"],
      assurance: "A2",
      authenticatedAt: now.toISOString(),
      verificationMethod: "secure_link_oidc",
      stepUp: null,
      lastChange: "VERIFIED_SECURE_LINK",
    }));
    expect("aborted" in bound).toBe(false);
    const auth = await c.identity.sessions.resolve(started.sessionRef, ident("mcp_tools"));
    const prepared = await c.actions.prepare(
      auth,
      {
        kind: "appointment.reschedule",
        target: { system: "scheduling", recordType: "appointment", recordRef: "apt_synthConsoleSafety0001", beforeVersion: "v1" },
        change: { slotId: "slt_synthConsoleSafety0001" },
        impact: { summaryTemplateId: "appointment.reschedule.summary", fees: null, reversible: true },
        confirmationTemplateId: "appointment.reschedule.confirm",
        ttlSeconds: 300,
        requiresStepUp: false,
      },
      { decisionId: newId("pdc"), allow: true, reasonCodes: ["ALLOW_SELF_SERVICE"], fieldMask: [], obligations: ["REQUIRE_CONFIRMATION"], policyVersion: c.policy.policyVersion, evaluatedAt: new Date().toISOString() },
    );
    expect(prepared.state).toBe("PREPARED");

    const { accessToken } = await signInSupervisor();
    const transfer = (id: string, payload: { destinationId: string; reason: string }) =>
      live.app.inject({ method: "POST", url: `/console/api/v1/calls/${id}/transfer`, headers: { authorization: `Bearer ${accessToken}`, "idempotency-key": newId("idk") }, payload });
    const dialsRefused = () => c.localMetrics.find("vsp_capability_not_configured_reached_total").filter((x) => x.labels.capability === "contact_center.talkdesk").reduce((n, x) => n + x.value, 0);

    // The staff safety escalation: the route is unavailable (503), yet administrative work is stopped and the
    // safety event recorded; the dial itself reached the telephony guard port and was refused.
    const before = dialsRefused();
    const r = await transfer(callId, { destinationId: "dst_safety_priority", reason: "SAFETY_PRIORITY" });
    expect(r.statusCode, r.body).toBe(503);
    expect(json(r.body)).toMatchObject({ error: { reasonCode: "TALKDESK_CONTROL_UNAVAILABLE", retryable: false } });
    expect((await c.actions.describe(TENANT, prepared.actionId))?.action.state).toBe("CANCELLED");
    const evidence = await sb.idb.db.tx(async (tx) => (await tx.query<{ phase: string }>("select phase from safety_events where call_id = $1", [callId])).rows, { role: "owner" });
    expect(evidence.length).toBeGreaterThan(0);
    expect(dialsRefused()).toBeGreaterThan(before);
    // The safety journey exists (the route was requested), nothing connected, and every dial attempt failed.
    const journeys = await c.transfers.journeysForCall(TENANT, callId);
    expect(journeys.map((j) => ({ priority: j.priority, connectedAt: j.connectedAt, awaitingRetry: j.awaitingRetry }))).toEqual([{ priority: "SAFETY", connectedAt: null, awaitingRetry: true }]);
    expect(journeys[0]?.attempts.every((a) => a.state === "FAILED")).toBe(true);
    // The console's own audit trail: the write-ahead intent and the unavailable outcome, never SUCCEEDED.
    const consoleAudit = await sb.idb.db.tx(async (tx) => (await tx.query<{ outcome: string; reason: string }>("select outcome, event->>'reasonCode' as reason from audit_outbox where action = 'console.calls.transfer' and call_id = $1", [callId])).rows, { role: "owner" });
    expect(consoleAudit.map((x) => x.outcome)).not.toContain("SUCCEEDED");
    expect(consoleAudit.map((x) => x.reason)).toContain("TALKDESK_CONTROL_UNAVAILABLE");

    // Control: a plain (non-safety) transfer without telephony control is refused before anything is attempted.
    const plain = await startCallWithEvents();
    const atPlain = dialsRefused();
    const p = await transfer(plain.callId, { destinationId: "dst_support_general", reason: "CALLER_REQUESTED_HUMAN" });
    expect(p.statusCode, p.body).toBe(503);
    expect(json(p.body)).toMatchObject({ error: { reasonCode: "TALKDESK_CONTROL_UNAVAILABLE" } });
    expect(await c.transfers.journeysForCall(TENANT, plain.callId)).toEqual([]);
    expect(dialsRefused()).toBe(atPlain);
  });

  it("[FO-14-53][FO-03-49][AUTH-02] adversarial: local sign-in is not registered, and fixture-style or self-signed staff tokens are refused (401)", async () => {
    expect((await live.app.inject({ method: "GET", url: "/console/api/v1/auth/local/staff" })).statusCode).toBe(404);
    expect((await live.app.inject({ method: "POST", url: "/console/api/v1/auth/local/token", payload: { staffId: "stf_synthCompositionStaff1" } })).statusCode).toBe(404);
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const forged = await new SignJWT({ amr: ["pwd", "otp"], [CLIENT_ROLES_CLAIM]: ["supervisor"], local_fixture: true })
      .setProtectedHeader({ alg: "ES256", kid: "forged-key" })
      .setIssuer(`${origin}/realms/${REALM}`)
      .setAudience(CLIENT.clientId)
      .setSubject("synthetic-forged-staff")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    for (const t of [forged, "local-fixture-staff-token-synthetic"]) {
      const me = await live.app.inject({ method: "GET", url: "/console/api/v1/me", headers: { authorization: `Bearer ${t}` } });
      expect(me.statusCode).toBe(401);
    }
  });

  it("[FO-21-03][OPS-01] adversarial: the sign-in prefix is rate limited per source address; other endpoints are not counted", async () => {
    const limited = await buildLiveConsole(c, { sweepIntervalMs: 0, authRateLimit: { max: 2, timeWindowMs: 60_000 } });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 4; i++) codes.push((await limited.app.inject({ method: "GET", url: "/console/api/v1/auth/config" })).statusCode);
      expect(codes).toEqual([200, 200, 429, 429]);
      expect((await limited.app.inject({ method: "GET", url: "/console/api/v1/me" })).statusCode).toBe(401);
    } finally {
      await limited.close();
    }
  });

  it("[FO-21-03][OPS-01][STRIDE-D] adversarial: a percent-encoded path is the same route and the same budget (%61uth, %63onsole, %2F); a spoofed X-Forwarded-For from a direct client changes nothing", async () => {
    const limited = await buildLiveConsole(c, { sweepIntervalMs: 0, authRateLimit: { max: 2, timeWindowMs: 60_000 } });
    try {
      const get = (url: string, headers: Record<string, string> = {}) => limited.app.inject({ method: "GET", url, headers }).then((r) => r.statusCode);
      // The encoded variants are served by the auth route (the router decodes them) and count against its budget.
      expect([await get("/console/api/v1/%61uth/config"), await get("/console/api/v1/%61%75%74%68/config")]).toEqual([200, 200]);
      expect([await get("/console/api/v1/%61uth/config"), await get("/%63onsole/api/v1/auth/config"), await get("/console/api/v1/auth/config")]).toEqual([429, 429, 429]);
      // An encoded separator is never a way around the budget: it is not the route (404), or it is (429).
      expect([404, 429]).toContain(await get("/console/api/v1/auth%2Fconfig"));
      const start = await limited.app.inject({ method: "POST", url: "/console/api/v1/%61uth/oidc/start", payload: { redirectUri: REDIRECT, codeChallenge: s256Challenge(randomBytes(48).toString("base64url")), codeChallengeMethod: "S256" } });
      expect(start.statusCode).toBe(429);
      // A direct client (no trusted proxy is configured) cannot pick another key with X-Forwarded-For.
      const spoofed: number[] = [];
      for (let i = 1; i <= 3; i++) spoofed.push(await get("/console/api/v1/auth/config", { "x-forwarded-for": `198.51.100.${i}` }));
      expect(spoofed).toEqual([429, 429, 429]);
      // Another source address has its own budget (the limit is per client, not global).
      expect(await limited.app.inject({ method: "GET", url: "/console/api/v1/auth/config", remoteAddress: "192.0.2.44" }).then((r) => r.statusCode)).toBe(200);
      expect(c.localMetrics.find("vsp_console_auth_rate_limited_total").reduce((n, x) => n + x.value, 0)).toBeGreaterThanOrEqual(7);
    } finally {
      await limited.close();
    }
  });

  it("[FO-21-03][OPS-01][STRIDE-D] behind the load balancer: only a trusted proxy peer names the client; each client keeps its own budget, so one anonymous client cannot lock every operator out", async () => {
    const current = readFileSync(join(sb.configDir, "sandbox.json"), "utf8");
    const cfg = JSON.parse(current) as ReturnType<Sandbox["config"]>;
    (cfg.infrastructure as Record<string, unknown>).trustedProxyCidrs = ["10.20.0.0/16"];
    sb.writeConfig(cfg);
    let behind: LiveConsole | null = null;
    try {
      const { c: c4 } = await bootLive(sb, { unit: "console", network: { resolve: privateResolver([IDP_HOST]), tlsCa: [pki.caPem] } });
      try {
        behind = await buildLiveConsole(c4, { sweepIntervalMs: 0, authRateLimit: { max: 2, timeWindowMs: 60_000 } });
        const via = (client: string, peer = "10.20.3.4") => behind!.app.inject({ method: "GET", url: "/console/api/v1/auth/config", remoteAddress: peer, headers: { "x-forwarded-for": client } }).then((r) => r.statusCode);
        // The attacker behind the balancer exhausts its own budget...
        expect([await via("198.51.100.7"), await via("198.51.100.7"), await via("198.51.100.7")]).toEqual([200, 200, 429]);
        // ...while an operator behind the same balancer (same peer address) still signs in.
        expect(await via("203.0.113.20")).toBe(200);
        // A spoofed left-most entry does not change the key: the proxy-appended (right-most untrusted) entry counts.
        expect(await via("192.0.2.1, 198.51.100.7")).toBe(429);
        // A peer outside the trusted ranges is the client itself, whatever it claims.
        const direct: number[] = [];
        for (let i = 1; i <= 3; i++) direct.push(await via(`203.0.113.${100 + i}`, "198.51.100.200"));
        expect(direct).toEqual([200, 200, 429]);
      } finally {
        await behind?.close();
        await c4.close();
      }
    } finally {
      sb.writeConfig(JSON.parse(current) as ReturnType<Sandbox["config"]>);
    }
  });

  it("[FO-21-03][OPS-01] failure injection: with the IdP unreachable the console still starts, shows sign-in as unavailable and every sign-in fails closed", async () => {
    await proxy.stop();
    let degraded: LiveConsole | null = null;
    try {
      const { c: c2 } = await bootLive(sb, { unit: "console", network: { resolve: privateResolver([IDP_HOST]), tlsCa: [pki.caPem] } });
      try {
        degraded = await buildLiveConsole(c2, { sweepIntervalMs: 0 });
        const conf = json((await degraded.app.inject({ method: "GET", url: "/console/api/v1/auth/config" })).body) as { oidc: { authorizationEndpoint: string | null } };
        expect(conf.oidc.authorizationEndpoint).toBeNull();
        const start = await degraded.app.inject({ method: "POST", url: "/console/api/v1/auth/oidc/start", payload: { redirectUri: REDIRECT, codeChallenge: s256Challenge(randomBytes(48).toString("base64url")), codeChallengeMethod: "S256" } });
        expect(start.statusCode).toBeGreaterThanOrEqual(500);
      } finally {
        await degraded?.close();
        await c2.close();
      }
    } finally {
      await proxy.start();
    }
  });

  it("[FO-21-03][OPS-04] adversarial: without its session sealer key the console refuses to start (operator.console NOT_CONFIGURED), while the gateway still starts", async () => {
    const current = readFileSync(join(sb.configDir, "sandbox.json"), "utf8");
    const withConsole = JSON.parse(current) as ReturnType<Sandbox["config"]>;
    withConsole.infrastructure.secrets.consoleSessionSealerRef = null;
    sb.writeConfig(withConsole);
    try {
      const { c: c3 } = await bootLive(sb, { unit: "console", network: { resolve: privateResolver([IDP_HOST]), tlsCa: [pki.caPem] } });
      try {
        expect(c3.report.deployable).toBe(true);
        expect(c3.activation.state("operator.console")).toBe("NOT_CONFIGURED");
        const v = await refusal(buildLiveConsole(c3));
        expect(v.length).toBeGreaterThan(0);
      } finally {
        await c3.close();
      }
    } finally {
      sb.writeConfig(JSON.parse(current) as ReturnType<Sandbox["config"]>);
    }
  });
});
