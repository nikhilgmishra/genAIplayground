/**
 * Layer 2 (WP-05): console workforce SSO against Keycloak 26 over the production path: OidcDiscovery,
 * OidcRelyingPartyClient (client_secret_basic, PKCE S256, nonce, at_hash), WorkforceTokenVerifier with the
 * discovered key set, OidcGroupStaffDirectory, AesGcmTokenSealer and PgConsoleSessionStore on PostgreSQL 16
 * (every migration). The shared Keycloak is reached through the test's TLS proxy as
 * https://idp.vsp-identity.test (support.ts); realms are created per run and deleted afterwards.
 *
 * Covered: discovery (issuer match, pinned https endpoints, S256), backend code exchange with PKCE, a
 * replayed callback and a replayed code refused, unknown redirects refused (backend allowlist and the IdP's
 * own), MFA amr enforced (the default rule), the console client's IdP roles (granted through the managed groups)
 * mapped to staff roles with an unknown client role refused, idle expiry,
 * same-actor refresh with rotation (IdP refresh-token reuse detection included), offboarding through
 * introspection (including the dual-controlled recovery custodian: an operator disabled at Keycloak has their
 * recovery identity SUSPENDED by the sweep and can no longer activate recovery), logout revocation at the IdP
 * (asked of Keycloak itself: the session's own sealed refresh token is no longer honoured), and IDP_UNAVAILABLE.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { s256Challenge } from "../../../src/adapters/live/oidc-client.js";
import { OidcDiscovery } from "../../../src/adapters/live/oidc-discovery.js";
import { PgAuditWriter } from "../../../src/audit/writer.js";
import { WorkforceTokenVerifier } from "../../../src/console-api/auth.js";
import { PgBreakGlassIssuance } from "../../../src/console-api/break-glass-issuance.js";
import { OidcGroupStaffDirectory } from "../../../src/console-api/oidc-staff-directory.js";
import { BREAK_GLASS_MAX_DURATION_SECONDS } from "../../../src/console-api/plugin.js";
import { PgRecoveryService, signRecoveryChallenge, signRecoveryEnrollment, signRecoveryRequest } from "../../../src/console-api/recovery.js";
import { PgConsoleSessionStore, consoleSessionHash } from "../../../src/console-api/sessions.js";
import { consoleAuditInput } from "../../../src/console-api/stores.js";
import { DEFAULT_WORKFORCE_SESSION, parseWorkforceSsoConfig } from "../../../src/console-api/sso-config.js";
import type { WorkforceSsoConfig } from "../../../src/console-api/sso-config.js";
import { WorkforceSsoService } from "../../../src/console-api/sso.js";
import type { WorkforceOidcPort } from "../../../src/console-api/sso.js";
import { AesGcmTokenSealer } from "../../../src/console-api/token-sealer.js";
import { createMemoryLogger } from "../../../src/observability/logger.js";
import { createIntegrationDb } from "../_harness/clients.js";
import type { IntegrationDb } from "../_harness/clients.js";
import { Keycloak } from "../_harness/keycloak.js";
import { layer2, layer2Context } from "../_harness/layer2.js";
import { AheadClock, Browser, CLIENT_ROLES_CLAIM, CONSOLE_REDIRECT, IDP_ORIGIN, IdpTlsProxy, createIdentityPki, liveOidc, newUser, realmName, realmRep, waitForRealm } from "./support.js";
import type { LiveOidc, SyntheticUser, TestPki } from "./support.js";

const SERVICES = ["keycloak", "postgres"];
const it = layer2(SERVICES);
const TENANT = "tnt_synthIdentityL2Tenant";
const REALM = realmName("workforce");
const ISSUER = `${IDP_ORIGIN}/realms/${REALM}`;
const CLIENT = { clientId: "vsp-console", secret: randomBytes(24).toString("base64url"), redirectUri: CONSOLE_REDIRECT };
const GROUPS = ["/vsp/supervisor", "/vsp/security-admin", "/vsp/retired-role", "/hr/everyone"];
/** Each managed group grants one role of the console client (the CLIENT_ROLES membership source the console maps). */
const GROUP_CLIENT_ROLES = { "/vsp/supervisor": "supervisor", "/vsp/security-admin": "security-admin", "/vsp/retired-role": "retired-role" };

const users = {
  supervisor: newUser("supervisor", ["/vsp/supervisor", "/hr/everyone"]),
  admin: newUser("secadmin", ["/vsp/security-admin"]),
  pwdOnly: newUser("pwdonly", ["/vsp/supervisor"], false),
  drift: newUser("drift", ["/vsp/supervisor", "/vsp/retired-role"]),
  leaver: newUser("leaver", ["/vsp/supervisor"]),
  refresher: newUser("refresher", ["/vsp/supervisor"]),
  unassigned: newUser("unassigned", ["/vsp/supervisor"]),
  unassigned2: newUser("unassigned2", ["/vsp/supervisor"]),
  // Each user signs in once per run: Keycloak refuses an OTP reused within its 30 s step.
  nogroups: newUser("nogroups", []),
  nogroups2: newUser("nogroups2", []),
  custodian: newUser("custodian", ["/vsp/supervisor"]),
  cosigner: newUser("cosigner", ["/vsp/supervisor"]),
  loggedout: newUser("loggedout", ["/vsp/supervisor"]),
};

let kc: Keycloak;
let pki: TestPki;
let proxy: IdpTlsProxy;
let idb: IntegrationDb;
let oidc: LiveOidc;
let clock: AheadClock;
let config: WorkforceSsoConfig;
let service: WorkforceSsoService;
/** The test owns the sealer key, so it can open a session's sealed IdP refresh token and ask Keycloak about it. */
const sealer = new AesGcmTokenSealer({ current: { id: "l2-sealer-1", key: randomBytes(32) } });

function buildService(session: Partial<WorkforceSsoConfig["session"]> = {}): WorkforceSsoService {
  const cfg = { ...config, session: { ...config.session, ...session } };
  const port: WorkforceOidcPort = oidc.client;
  return new WorkforceSsoService({
    config: cfg,
    oidc: port,
    directory: new OidcGroupStaffDirectory(cfg),
    verifier: WorkforceTokenVerifier.withKeys({ issuer: ISSUER, audience: CLIENT.clientId, keys: oidc.discovery.keyResolver(), clock, acceptedMfaAmr: cfg.acceptedMfaAmr, algorithms: ["RS256", "ES256"] }),
    sessions: new PgConsoleSessionStore(idb.db),
    sealer,
    audit: new PgAuditWriter({ db: idb.db, clock, stream: "console.l2", standaloneRole: "app_console" }),
    clock,
    logger: createMemoryLogger().logger,
  });
}

async function signIn(svc: WorkforceSsoService, user: SyntheticUser) {
  const verifier = randomBytes(48).toString("base64url");
  const start = await svc.start({ redirectUri: CONSOLE_REDIRECT, codeChallenge: s256Challenge(verifier) });
  // A fresh user agent per sign-in: the IdP's own SSO cookie would otherwise sign the next user in as the last.
  const back = await new Browser(pki, proxy).signIn(start.authorizationUrl, user, CONSOLE_REDIRECT);
  if ("refused" in back) throw new Error(`IDP_REFUSED_LOGIN: ${back.refused}`);
  return { verifier, start, back, exchange: () => svc.exchange({ code: back.code, state: back.state, codeVerifier: verifier, redirectUri: CONSOLE_REDIRECT, correlationId: "cor_synthIdentityL2Login01" }) };
}

/** The production client's own code exchange (no console session): for asserting what the IdP itself returns. */
async function directTokens(user: SyntheticUser) {
  const verifier = randomBytes(48).toString("base64url");
  const state = randomBytes(32).toString("base64url");
  const nonce = randomBytes(32).toString("base64url");
  const { url } = await oidc.client.authorizationRequest({ redirectUri: CONSOLE_REDIRECT, state, nonce, codeChallenge: s256Challenge(verifier), scopes: ["openid"] });
  const back = await new Browser(pki, proxy).signIn(url, user, CONSOLE_REDIRECT);
  if ("refused" in back) throw new Error(`IDP_REFUSED_LOGIN: ${back.refused}`);
  return oidc.client.exchangeCode({ code: back.code, codeVerifier: verifier, redirectUri: CONSOLE_REDIRECT, nonce, maxAuthAgeSeconds: 600 });
}

const bearer = (t: string) => `Bearer ${t}`;

/** The IdP refresh token sealed in a console session row (opened with the test's sealer key). */
async function sealedRefreshToken(token: string): Promise<string> {
  const r = await idb.db.query<{ refresh_ciphertext: Buffer; refresh_iv: Buffer; refresh_tag: Buffer; refresh_key_id: string }>(
    "select refresh_ciphertext, refresh_iv, refresh_tag, refresh_key_id from console_sessions where session_hash = $1",
    [consoleSessionHash(token)],
  );
  const row = r.rows[0];
  if (!row) throw new Error("SESSION_ROW_MISSING");
  return sealer.open({ ciphertext: Buffer.from(row.refresh_ciphertext), iv: Buffer.from(row.refresh_iv), tag: Buffer.from(row.refresh_tag), keyId: row.refresh_key_id }, consoleSessionHash(token));
}
const reasonOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "NO_ERROR";
  } catch (e) {
    return (e as { reasonCode?: string }).reasonCode ?? String(e);
  }
};

describe("console workforce SSO against Keycloak (live adapters, PostgreSQL sessions)", () => {
  beforeAll(async () => {
    const l2 = layer2Context(SERVICES);
    kc = new Keycloak(`https://localhost:${l2.port("keycloak", 8443)}`);
    pki = createIdentityPki();
    proxy = new IdpTlsProxy(pki, l2.port("keycloak", 8443));
    await proxy.start();
    await kc.createRealm(realmRep({ realm: REALM, client: CLIENT, users: Object.values(users), groups: GROUPS, groupClientRoles: GROUP_CLIENT_ROLES }));
    await kc.setAuthenticatorReference(REALM, "browser", "auth-username-password-form", "pwd");
    await kc.setAuthenticatorReference(REALM, "browser", "auth-otp-form", "otp");
    for (const u of Object.values(users)) u.id = (await kc.adminJson<{ id: string }[]>(`/realms/${REALM}/users?username=${encodeURIComponent(u.username)}&exact=true`))[0]?.id;
    idb = await createIntegrationDb(l2);
    clock = new AheadClock();
    oidc = liveOidc({ pki, proxyPort: proxy.port, issuer: ISSUER, clientId: CLIENT.clientId, clientSecret: CLIENT.secret, clock, groupsClaim: CLIENT_ROLES_CLAIM });
    await waitForRealm(oidc, ISSUER);
    config = parseWorkforceSsoConfig({
      tenantId: TENANT,
      issuer: ISSUER,
      clientId: CLIENT.clientId,
      scopes: ["openid"],
      redirectUris: [CONSOLE_REDIRECT],
      // The console client's own roles (granted through the managed groups), never group names or paths: a
      // lookalike group cannot grant a role (workforce-sso-adversarial.test.ts).
      groupsClaim: CLIENT_ROLES_CLAIM,
      membershipSource: { kind: "CLIENT_ROLES" },
      groupRoles: { supervisor: "supervisor", "security-admin": "security_admin" },
      managedGroupPrefix: null,
      // The default MFA rule (no tenant override): Keycloak's password + TOTP login carries amr [pwd, otp].
      acceptedMfaAmr: null,
      maxAuthAgeSeconds: 600,
      loginTransactionTtlSeconds: 600,
      session: { ...DEFAULT_WORKFORCE_SESSION, idleTimeoutSeconds: 120, activityWriteIntervalSeconds: 0, activeCheckIntervalSeconds: 0 },
      sessionParametersApprovalId: null,
    });
    service = buildService();
  }, 120_000);

  // Provider tokens use real time: every test starts with the console clock back on real time.
  beforeEach(() => {
    if (clock) clock.offsetMs = 0;
  });

  afterAll(async () => {
    await kc?.deleteRealm(REALM);
    await proxy?.stop();
    await idb?.drop();
    pki?.dispose();
  });

  it("[FO-05-07][FO-03-28] discovery of the real IdP: exact issuer, pinned https endpoints, S256 advertised; a different issuer string is refused", async () => {
    const p = await oidc.discovery.provider();
    expect(p.issuer).toBe(ISSUER);
    for (const u of [p.authorizationEndpoint, p.tokenEndpoint, p.jwksUri, p.introspectionEndpoint, p.revocationEndpoint]) expect(u?.href.startsWith(`${IDP_ORIGIN}/realms/${REALM}/`), u?.href).toBe(true);
    expect(p.codeChallengeMethods).toContain("S256");
    const trailing = new OidcDiscovery({ issuer: `${ISSUER}/`, http: oidc.http, clock });
    expect(await reasonOf(trailing.provider())).toBe("OIDC_ISSUER_MISMATCH");
  });

  it("[FO-05-09][FO-05-10][FO-05-41][FO-14-02][AUTH-01] backend PKCE exchange yields an opaque console session; roles come from the IdP groups; the IdP tokens stay sealed server side", async () => {
    const login = await signIn(service, users.supervisor);
    const url = new URL(login.start.authorizationUrl);
    expect(url.origin).toBe(IDP_ORIGIN);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    const out = await login.exchange();
    expect(out.token).toMatch(/^vcs_[A-Za-z0-9_-]{43}$/);
    expect(out.roles).toEqual(["supervisor"]);
    const id = await service.authenticate(bearer(out.token));
    expect(id).toMatchObject({ kind: "OIDC_SSO", tenantId: TENANT, roles: ["supervisor"] });
    const row = await idb.db.query<{ refresh_ciphertext: Buffer | null; subject_digest: string; staff_id: string }>("select refresh_ciphertext, subject_digest, staff_id from console_sessions where session_hash = $1", [consoleSessionHash(out.token)]);
    expect(row.rows[0]?.refresh_ciphertext).toBeTruthy();
    expect(JSON.stringify(row.rows[0])).not.toContain(users.supervisor.id ?? "never");
    const audit = await idb.db.query<{ n: number }>("select count(*)::int as n from audit_outbox where action = 'console.auth.oidc_exchange' and outcome = 'SUCCEEDED'");
    expect(audit.rows[0]?.n).toBeGreaterThan(0);
  });

  it("[FO-05-11][FO-05-10] a replayed callback is refused by the backend and a replayed code by the IdP", async () => {
    const login = await signIn(service, users.admin);
    expect((await login.exchange()).roles).toEqual(["security_admin"]);
    expect(await reasonOf(login.exchange())).toBe("LOGIN_TRANSACTION_UNAVAILABLE");
    // Same code under a fresh login transaction with the SAME PKCE challenge: only the code reuse is wrong.
    const again = await service.start({ redirectUri: CONSOLE_REDIRECT, codeChallenge: s256Challenge(login.verifier) });
    const replay = await reasonOf(service.exchange({ code: login.back.code, state: again.state, codeVerifier: login.verifier, redirectUri: CONSOLE_REDIRECT, correlationId: "cor_synthIdentityL2Replay1" }));
    expect(replay).toBe("OIDC_GRANT_INVALID");
  });

  it("[FO-05-13] callback allowlist: the backend refuses an unknown redirect before the IdP is involved, and the IdP refuses one too", async () => {
    const challenge = s256Challenge(randomBytes(48).toString("base64url"));
    expect(await reasonOf(service.start({ redirectUri: "https://console.vsp-identity.test/auth/callback/x", codeChallenge: challenge }))).toBe("REDIRECT_URI_NOT_ALLOWED");
    const start = await service.start({ redirectUri: CONSOLE_REDIRECT, codeChallenge: challenge });
    const tampered = new URL(start.authorizationUrl);
    tampered.searchParams.set("redirect_uri", "https://evil.vsp-identity.test/auth/callback");
    const back = await new Browser(pki, proxy).signIn(tampered.toString(), users.supervisor, "https://evil.vsp-identity.test/auth/callback");
    expect("refused" in back).toBe(true);
  });

  it("[FO-05-41][AUTH-01] MFA amr is required (password-only refused) and an unknown managed group refuses sign-in", async () => {
    const pwd = await signIn(service, users.pwdOnly);
    expect(await reasonOf(pwd.exchange())).toBe("STAFF_MFA_REQUIRED");
    const drift = await signIn(service, users.drift);
    expect(await reasonOf(drift.exchange())).toBe("STAFF_GROUP_UNKNOWN");
  });

  it("[FO-05-18][AUTH-04] idle expiry is enforced on every use against the stored activity, independent of the IdP session", async () => {
    const s = await (await signIn(service, users.supervisor)).exchange();
    clock.advanceSeconds(100);
    expect((await service.authenticate(bearer(s.token))).staffId).toBe(s.staffId);
    clock.advanceSeconds(100);
    expect((await service.authenticate(bearer(s.token))).staffId).toBe(s.staffId);
    clock.advanceSeconds(121);
    expect(await reasonOf(service.authenticate(bearer(s.token)))).toBe("SESSION_IDLE_EXPIRED");
    expect(await reasonOf(service.authenticate(bearer(s.token)))).toBe("SESSION_REVOKED");
  });

  it("[FO-05-19][FO-01-31] same-actor refresh rotates the console bearer and the IdP refresh token; the superseded bearer is a replay that revokes the family", async () => {
    const s = await (await signIn(service, users.refresher)).exchange();
    const before = await idb.db.query<{ refresh_ciphertext: Buffer }>("select refresh_ciphertext from console_sessions where session_hash = $1", [consoleSessionHash(s.token)]);
    const r = await service.refresh(bearer(s.token), "cor_synthIdentityL2Refresh");
    expect(r.staffId).toBe(s.staffId);
    expect(r.token).not.toBe(s.token);
    const after = await idb.db.query<{ refresh_ciphertext: Buffer; generation: number }>("select refresh_ciphertext, generation from console_sessions where session_hash = $1", [consoleSessionHash(r.token)]);
    expect(after.rows[0]?.generation).toBe(2);
    expect(Buffer.compare(after.rows[0]?.refresh_ciphertext ?? Buffer.alloc(0), before.rows[0]?.refresh_ciphertext ?? Buffer.alloc(0))).not.toBe(0);
    expect((await service.authenticate(bearer(r.token))).staffId).toBe(s.staffId);
    clock.advanceSeconds(10);
    expect(await reasonOf(service.authenticate(bearer(s.token)))).toBe("SESSION_TOKEN_REPLAYED");
    expect(await reasonOf(service.authenticate(bearer(r.token)))).toBe("SESSION_REVOKED");
  });

  it("[FO-14-52][AUTH-04] an operator disabled at the IdP loses the session at the next active-state check and cannot sign in again", async () => {
    const s = await (await signIn(service, users.leaver)).exchange();
    expect((await service.authenticate(bearer(s.token))).roles).toEqual(["supervisor"]);
    await kc.admin("PUT", `/realms/${REALM}/users/${users.leaver.id}`, { enabled: false });
    expect(await reasonOf(service.authenticate(bearer(s.token)))).toBe("STAFF_DEPROVISIONED");
    const row = await idb.db.query<{ revoke_reason: string }>("select revoke_reason from console_sessions where session_hash = $1", [consoleSessionHash(s.token)]);
    expect(row.rows[0]?.revoke_reason).toBe("STAFF_DEPROVISIONED");
    const start = await service.start({ redirectUri: CONSOLE_REDIRECT, codeChallenge: s256Challenge(randomBytes(48).toString("base64url")) });
    const back = await new Browser(pki, proxy).signIn(start.authorizationUrl, users.leaver, CONSOLE_REDIRECT);
    expect("refused" in back).toBe(true);
  });

  it("[FO-14-52][FO-19-07][AUTH-04] an operator removed from every managed group (account still enabled) loses the session at the next active check and in the sweep", async () => {
    const group = await kc.adminJson<{ id: string }>(`/realms/${REALM}/group-by-path/vsp/supervisor`);
    const unassign = async (u: SyntheticUser) => {
      const r = await kc.admin("DELETE", `/realms/${REALM}/users/${u.id}/groups/${group.id}`);
      expect(r.status).toBe(204);
    };
    // Through a request.
    const s = await (await signIn(service, users.unassigned)).exchange();
    expect((await service.authenticate(bearer(s.token))).roles).toEqual(["supervisor"]);
    await unassign(users.unassigned);
    // Emulator fidelity (Keycloak 26): for an enabled user without groups (so without client roles) introspection
    // says active and the membership claim is ABSENT, not [] (the ID token omits it too).
    const direct = await directTokens(users.nogroups);
    expect(direct.idToken.groups).toBeNull();
    expect(await oidc.client.introspect(direct.refreshToken ?? "", "refresh_token")).toMatchObject({ active: true, groups: null });
    expect(await reasonOf(service.authenticate(bearer(s.token)))).toBe("STAFF_NOT_PROVISIONED");
    const row = await idb.db.query<{ revoke_reason: string }>("select revoke_reason from console_sessions where session_hash = $1", [consoleSessionHash(s.token)]);
    expect(row.rows[0]?.revoke_reason).toBe("STAFF_NOT_PROVISIONED");
    // Through the sweeper, without any console request.
    const s2 = await (await signIn(service, users.unassigned2)).exchange();
    await unassign(users.unassigned2);
    clock.advanceSeconds(1);
    const swept = await service.sweep();
    expect(swept.revoked).toBeGreaterThanOrEqual(1);
    const row2 = await idb.db.query<{ revoke_reason: string }>("select revoke_reason from console_sessions where session_hash = $1", [consoleSessionHash(s2.token)]);
    expect(row2.rows[0]?.revoke_reason).toBe("STAFF_NOT_PROVISIONED");
    expect(await reasonOf(service.authenticate(bearer(s2.token)))).toBe("SESSION_REVOKED");
    // A user without groups cannot sign in (the ID token carries no groups claim).
    expect(await reasonOf((await signIn(service, users.nogroups2)).exchange())).toBe("STAFF_NOT_PROVISIONED");
  });

  it("[FO-14-52] logout revokes the IdP refresh token too (RFC 7009): Keycloak itself no longer honours this session's own token", async () => {
    const s = await (await signIn(service, users.loggedout)).exchange();
    const idpToken = await sealedRefreshToken(s.token);
    // Before: Keycloak answers that the session's own refresh token is active.
    expect(await oidc.client.introspect(idpToken, "refresh_token")).toMatchObject({ active: true });
    const id = await service.authenticate(bearer(s.token));
    await service.logout(id, clock.now());
    expect(await reasonOf(service.authenticate(bearer(s.token)))).toBe("SESSION_REVOKED");
    expect(await reasonOf(service.refresh(bearer(s.token), "cor_synthIdentityL2Logout1"))).toBe("SESSION_REVOKED");
    // After: asked directly, Keycloak reports the token inactive and refuses to redeem it.
    expect(await oidc.client.introspect(idpToken, "refresh_token")).toMatchObject({ active: false });
    expect(await reasonOf(oidc.client.refresh({ refreshToken: idpToken, expected: { isSameSubject: () => true, authTime: null, nonceHash: null } }))).toBe("OIDC_GRANT_INVALID");
  });

  it("[FO-14-52][FO-14-51][AUTH-04] an operator who is a recovery custodian and is disabled at Keycloak loses the recovery path: the sweep suspends their identity, ends their RECOVERY session, and activation is refused", async () => {
    const recovery = new PgRecoveryService({
      db: idb.db,
      audit: new PgAuditWriter({ db: idb.db, clock, stream: "console.l2-recovery", standaloneRole: "app_console" }),
      sessions: new PgConsoleSessionStore(idb.db),
      issuance: new PgBreakGlassIssuance(idb.db, new PgAuditWriter({ db: idb.db, clock, stream: "console.l2-recovery", standaloneRole: "app_console" }), BREAK_GLASS_MAX_DURATION_SECONDS),
      clock,
      tenantId: TENANT,
    });
    const [adminA, adminB] = [`stf_${randomBytes(15).toString("base64url")}`, `stf_${randomBytes(15).toString("base64url")}`];
    const ev = (staffId: string, action: string, reasonCode: string) => consoleAuditInput({ tenantId: TENANT, correlationId: `cor_${randomBytes(12).toString("base64url")}`, staffId, role: "security_admin", action, outcome: "SUCCEEDED", reasonCode, occurredAt: clock.now() });
    // Each custodian signs in through Keycloak (MFA) and enrolls with a key held only by them, in that SSO session.
    const enroll = async (user: SyntheticUser) => {
      const s = await (await signIn(service, user)).exchange();
      const holder = await service.authenticate(bearer(s.token));
      const k = generateKeyPairSync("ec", { namedCurve: "P-256" });
      const j = k.publicKey.export({ format: "jwk" }) as { x: string; y: string };
      const p = await recovery.propose({ proposerId: adminA, body: { staffId: holder.staffId, publicJwk: { kty: "EC", crv: "P-256", x: j.x, y: j.y }, attestationRef: `att_synth${randomBytes(12).toString("base64url")}`, roles: ["supervisor"] }, now: clock.now(), audit: ev(adminA, "console.recovery_identities.propose", "RECOVERY_IDENTITY_PROPOSED") });
      const signature = await signRecoveryEnrollment({ privateKey: k.privateKey, tenantId: TENANT, identityId: p.identity.identityId, staffId: holder.staffId, keyThumbprint: p.identity.keyThumbprint, challenge: p.enrollment.challenge, now: clock.now() });
      await recovery.confirm({ holder: { staffId: holder.staffId, sessionKind: holder.kind, sessionHash: holder.sessionHash, roles: holder.roles }, identityId: p.identity.identityId, signature, now: clock.now(), audit: ev(holder.staffId, "console.recovery_identities.confirm", "RECOVERY_IDENTITY_HOLDER_CONFIRMED") });
      expect((await recovery.approve({ approverId: adminB, identityId: p.identity.identityId, now: clock.now(), audit: ev(adminB, "console.recovery_identities.approve", "RECOVERY_IDENTITY_APPROVED") })).status).toBe("ACTIVE");
      return { identityId: p.identity.identityId, privateKey: k.privateKey, staffId: holder.staffId, token: s.token };
    };
    const activate = async (x: { identityId: string; privateKey: import("node:crypto").KeyObject }, y: { identityId: string; privateKey: import("node:crypto").KeyObject }) => {
      const c = await recovery.challenge({ identityId: x.identityId, proof: await signRecoveryRequest({ privateKey: x.privateKey, tenantId: TENANT, identityId: x.identityId, now: clock.now() }), correlationId: `cor_${randomBytes(12).toString("base64url")}` });
      const sign = (who: { identityId: string; privateKey: import("node:crypto").KeyObject }) => signRecoveryChallenge({ privateKey: who.privateKey, tenantId: TENANT, activationId: c.activationId, challenge: c.challenge, identityId: who.identityId, now: clock.now() });
      return recovery.activate({ body: { activationId: c.activationId, approvals: [{ identityId: x.identityId, signature: await sign(x) }, { identityId: y.identityId, signature: await sign(y) }] }, correlationId: `cor_${randomBytes(12).toString("base64url")}` });
    };
    const x = await enroll(users.custodian);
    const y = await enroll(users.cosigner);
    // The path works while the operator is employed.
    const live = await activate(x, y);
    expect(await service.authenticate(bearer(live.token))).toMatchObject({ kind: "RECOVERY", staffId: x.staffId });
    // Disabled at Keycloak; no console request from the operator: the sweep's active check sees it.
    await kc.admin("PUT", `/realms/${REALM}/users/${users.custodian.id}`, { enabled: false });
    clock.advanceSeconds(1);
    await service.sweep();
    const ident = await idb.db.query<{ status: string; suspend_reason: string | null }>("select status, suspend_reason from console_recovery_identities where identity_id = $1", [x.identityId]);
    expect(ident.rows[0]).toEqual({ status: "SUSPENDED", suspend_reason: "CUSTODIAN_OFFBOARDED" });
    const ended = await idb.db.query<{ revoke_reason: string | null }>("select revoke_reason from console_sessions where session_hash = $1", [consoleSessionHash(live.token)]);
    expect(ended.rows[0]?.revoke_reason).toBe("CUSTODIAN_OFFBOARDED");
    expect(await reasonOf(service.authenticate(bearer(live.token)))).toBe("SESSION_REVOKED");
    expect(await reasonOf(activate(x, y))).toBe("RECOVERY_IDENTITY_UNAVAILABLE");
    const audited = await idb.db.query<{ n: number }>("select count(*)::int as n from audit_outbox where action = 'console.recovery_identity.suspended' and event->>'actorRef' = $1", [x.staffId]);
    expect(audited.rows[0]?.n).toBeGreaterThan(0);
    // The co-signer (still employed) is untouched.
    expect((await idb.db.query<{ status: string }>("select status from console_recovery_identities where identity_id = $1", [y.identityId])).rows[0]?.status).toBe("ACTIVE");
  });

  it("[FAULT:IDP_UNAVAILABLE][OPS-01] workforce IdP unreachable: sign-in fails closed as unavailable; a live session keeps working only within the staleness bound", async () => {
    const svc = buildService({ activeCheckIntervalSeconds: 1, activeCheckMaxStalenessSeconds: 60 });
    const s = await (await signIn(svc, users.supervisor)).exchange();
    await proxy.stop();
    try {
      const fresh = new OidcDiscovery({ issuer: ISSUER, http: oidc.http, clock });
      expect(await reasonOf(fresh.provider())).toBe("OIDC_DISCOVERY_UNAVAILABLE");
      clock.advanceSeconds(2);
      expect((await svc.authenticate(bearer(s.token))).staffId).toBe(s.staffId);
      clock.advanceSeconds(61);
      expect(await reasonOf(svc.authenticate(bearer(s.token)))).toBe("STAFF_ACTIVE_STATE_UNVERIFIED");
      expect(await reasonOf(svc.refresh(bearer(s.token), "cor_synthIdentityL2IdpDown"))).toBe("WORKFORCE_IDP_UNAVAILABLE");
    } finally {
      await proxy.start();
    }
    expect((await svc.authenticate(bearer(s.token))).staffId).toBe(s.staffId);
  });
});
