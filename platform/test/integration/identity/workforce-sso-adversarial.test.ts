/**
 * Layer 2 (WP-05): adversarial and fidelity cases of console workforce SSO on Keycloak 26 and PostgreSQL 16, over
 * the same production path as workforce-sso.test.ts (OidcDiscovery, OidcRelyingPartyClient, WorkforceTokenVerifier
 * with the discovered keys, OidcGroupStaffDirectory, AesGcmTokenSealer, PgConsoleSessionStore, PgRecoveryService).
 * Own realms (unique names, deleted afterwards) and own database; the shared Keycloak is never reconfigured.
 *
 *   - Another sign-in's logout is no explanation for inactivity (residual D1, verifier probe A): a recovery custodian
 *     signed in on two browsers logs out of one (Keycloak keeps the other IdP session active: probe K1, asserted
 *     here), is then disabled at Keycloak, and the sweep's check of the OTHER browser's session suspends the
 *     custodian (CUSTODIAN_OFFBOARDED); recovery activation is refused.
 *   - Group names cannot grant a role (residual D3, probe K2): a top-level group named "vsp/security-admin" has the
 *     same full path as the managed nested group (fidelity finding, asserted here), so a group-PATH mapping would
 *     grant security_admin; the console maps the console client's own roles (CLIENT_ROLES) and grants supervisor only.
 *   - The default MFA rule on Keycloak: a login whose amr carries one factor value is refused (STAFF_MFA_REQUIRED).
 *   - The unauthenticated sign-in start is stateless (residual D2, verifier probe B): an anonymous flood stores
 *     nothing on PostgreSQL and a legitimate sign-in during it succeeds; a tampered or replayed state is refused
 *     before Keycloak redeems the code.
 *   - Every terminal path decides with Keycloak's answer, fail closed (verifier probes R and Q1, sessions.ts closeFamily):
 *     a disabled custodian's refresh that Keycloak refuses suspends them; a logout during a refresh held before Keycloak
 *     is asked suspends a disabled custodian at once (the refresh, then refused, decides nothing more) and keeps an
 *     employed one (the refresh, refused because the logout revoked the token, decides nothing more either); a logout
 *     after Keycloak redeemed the token (Keycloak then reports it inactive, asserted) suspends even an employed
 *     custodian, reinstated by their next sign-in, and the successor Keycloak issued is inactive there. The replay of a
 *     superseded bearer asks Keycloak about the family's live row: a custodian disabled after one refresh who presents
 *     the superseded bearer is suspended and cannot activate; an employed one is not. An idle expiry closure by the sweep
 *     asks Keycloak first: a custodian disabled after the last active check is suspended, an employed one is not. The
 *     live client's refresh is held through a delegating port (the only test seam; every call still reaches Keycloak).
 *   - Only a new sign-in reinstates (verifier probes N3-N5): a client role removed at Keycloak suspends the identity
 *     that carries it (CUSTODIAN_ROLES_REDUCED) at the next refresh; given back, Keycloak's positive answers at the next
 *     refresh, the active checks and the logout leave it suspended; the next sign-in reinstates it.
 */
import { generateKeyPairSync, randomBytes } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { afterAll, beforeAll, describe, expect } from "vitest";
import { s256Challenge } from "../../../src/adapters/live/oidc-client.js";
import { PgAuditWriter } from "../../../src/audit/writer.js";
import { WorkforceTokenVerifier } from "../../../src/console-api/auth.js";
import { PgBreakGlassIssuance } from "../../../src/console-api/break-glass-issuance.js";
import { OidcGroupStaffDirectory } from "../../../src/console-api/oidc-staff-directory.js";
import { BREAK_GLASS_MAX_DURATION_SECONDS } from "../../../src/console-api/plugin.js";
import { PgRecoveryService, signRecoveryChallenge, signRecoveryEnrollment, signRecoveryRequest } from "../../../src/console-api/recovery.js";
import { PgConsoleSessionStore, consoleSessionHash } from "../../../src/console-api/sessions.js";
import { consoleAuditInput } from "../../../src/console-api/stores.js";
import { DEFAULT_WORKFORCE_SESSION, parseWorkforceSsoConfig, rolesForGroups } from "../../../src/console-api/sso-config.js";
import type { WorkforceSsoConfig } from "../../../src/console-api/sso-config.js";
import { WorkforceSsoService } from "../../../src/console-api/sso.js";
import type { WorkforceOidcPort, WorkforceTokenSet } from "../../../src/console-api/sso.js";
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
const TENANT = "tnt_synthIdentityL2Adversary";
const REALM = realmName("wfadversary");
const ISSUER = `${IDP_ORIGIN}/realms/${REALM}`;
const SF_REALM = realmName("wfsinglefactor");
const SF_ISSUER = `${IDP_ORIGIN}/realms/${SF_REALM}`;
const CLIENT = { clientId: "vsp-console", secret: randomBytes(24).toString("base64url"), redirectUri: CONSOLE_REDIRECT };
const GROUPS = ["/vsp/supervisor", "/vsp/security-admin"];
const GROUP_CLIENT_ROLES = { "/vsp/supervisor": "supervisor", "/vsp/security-admin": "security-admin" };

const users = {
  custodian: newUser("custodian", ["/vsp/supervisor"]),
  cosigner: newUser("cosigner", ["/vsp/supervisor"]),
  mallory: newUser("mallory", ["/vsp/supervisor"]),
  malloryProbe: newUser("mallory-probe", ["/vsp/supervisor"]),
  duringFlood: newUser("during-flood", ["/vsp/supervisor"]),
  tamperTarget: newUser("tamper-target", ["/vsp/supervisor"]),
  refusedRefresh: newUser("refused-refresh", ["/vsp/supervisor"]),
  raceRefused: newUser("race-refused", ["/vsp/supervisor"]),
  raceRedeemed: newUser("race-redeemed", ["/vsp/supervisor"]),
  raceActive: newUser("race-active", ["/vsp/supervisor"]),
  replayDodge: newUser("replay-dodge", ["/vsp/supervisor"]),
  replayEmployed: newUser("replay-employed", ["/vsp/supervisor"]),
  idleDisabled: newUser("idle-disabled", ["/vsp/supervisor"]),
  idleEmployed: newUser("idle-employed", ["/vsp/supervisor"]),
  reinstateOnly: newUser("reinstate-only", ["/vsp/supervisor", "/vsp/security-admin"]),
};
const sfUsers = { operator: newUser("sf-operator", ["/vsp/supervisor"]), probe: newUser("sf-probe", ["/vsp/supervisor"]) };

let kc: Keycloak;
let pki: TestPki;
let proxy: IdpTlsProxy;
let idb: IntegrationDb;
let clock: AheadClock;
let oidc: LiveOidc;
let groupsReader: LiveOidc;
let sfOidc: LiveOidc;
let service: WorkforceSsoService;
let sfService: WorkforceSsoService;
const sealer = new AesGcmTokenSealer({ current: { id: "l2-adversary-sealer-1", key: randomBytes(32) } });

function configFor(issuer: string, session: Partial<WorkforceSsoConfig["session"]> = {}): WorkforceSsoConfig {
  return parseWorkforceSsoConfig({
    tenantId: TENANT,
    issuer,
    clientId: CLIENT.clientId,
    scopes: ["openid"],
    redirectUris: [CONSOLE_REDIRECT],
    groupsClaim: CLIENT_ROLES_CLAIM,
    membershipSource: { kind: "CLIENT_ROLES" },
    groupRoles: { supervisor: "supervisor", "security-admin": "security_admin" },
    managedGroupPrefix: null,
    acceptedMfaAmr: null,
    maxAuthAgeSeconds: 600,
    loginTransactionTtlSeconds: 600,
    session: { ...DEFAULT_WORKFORCE_SESSION, idleTimeoutSeconds: 600, activityWriteIntervalSeconds: 0, activeCheckIntervalSeconds: 0, ...session },
    sessionParametersApprovalId: null,
  });
}

function serviceFor(o: LiveOidc, config: WorkforceSsoConfig, stream: string, port: WorkforceOidcPort = o.client): WorkforceSsoService {
  return new WorkforceSsoService({
    config,
    oidc: port,
    directory: new OidcGroupStaffDirectory(config),
    verifier: WorkforceTokenVerifier.withKeys({ issuer: config.issuer, audience: CLIENT.clientId, keys: o.discovery.keyResolver(), clock, acceptedMfaAmr: config.acceptedMfaAmr, algorithms: ["RS256", "ES256"] }),
    sessions: new PgConsoleSessionStore(idb.db),
    sealer,
    audit: new PgAuditWriter({ db: idb.db, clock, stream, standaloneRole: "app_console" }),
    clock,
    logger: createMemoryLogger().logger,
  });
}

/** One sign-in through the console in a NEW user agent (a separate browser, so a separate IdP session). */
async function signIn(svc: WorkforceSsoService, user: SyntheticUser) {
  const verifier = randomBytes(48).toString("base64url");
  const start = await svc.start({ redirectUri: CONSOLE_REDIRECT, codeChallenge: s256Challenge(verifier) });
  const back = await new Browser(pki, proxy).signIn(start.authorizationUrl, user, CONSOLE_REDIRECT);
  if ("refused" in back) throw new Error(`IDP_REFUSED_LOGIN: ${back.refused}`);
  return svc.exchange({ code: back.code, state: back.state, codeVerifier: verifier, redirectUri: CONSOLE_REDIRECT, correlationId: "cor_synthIdentityL2Adversary1" });
}

/** The production client's own code exchange (no console session): what the IdP itself returns. */
async function directTokens(o: LiveOidc, user: SyntheticUser) {
  const verifier = randomBytes(48).toString("base64url");
  const nonce = randomBytes(32).toString("base64url");
  const { url } = await o.client.authorizationRequest({ redirectUri: CONSOLE_REDIRECT, state: randomBytes(32).toString("base64url"), nonce, codeChallenge: s256Challenge(verifier), scopes: ["openid"] });
  const back = await new Browser(pki, proxy).signIn(url, user, CONSOLE_REDIRECT);
  if ("refused" in back) throw new Error(`IDP_REFUSED_LOGIN: ${back.refused}`);
  return o.client.exchangeCode({ code: back.code, codeVerifier: verifier, redirectUri: CONSOLE_REDIRECT, nonce, maxAuthAgeSeconds: 600 });
}

async function sealedRefreshToken(token: string): Promise<string> {
  const r = await idb.db.query<{ refresh_ciphertext: Buffer; refresh_iv: Buffer; refresh_tag: Buffer; refresh_key_id: string }>(
    "select refresh_ciphertext, refresh_iv, refresh_tag, refresh_key_id from console_sessions where session_hash = $1",
    [consoleSessionHash(token)],
  );
  const row = r.rows[0];
  if (!row) throw new Error("SESSION_ROW_MISSING");
  return sealer.open({ ciphertext: Buffer.from(row.refresh_ciphertext), iv: Buffer.from(row.refresh_iv), tag: Buffer.from(row.refresh_tag), keyId: row.refresh_key_id }, consoleSessionHash(token));
}

/**
 * The live client behind a delegating port that can hold its NEXT refresh: before Keycloak is asked (nothing redeemed
 * yet) and/or after Keycloak redeemed the token (before the new tokens reach the console). Every call reaches Keycloak.
 */
function holdingPort(inner: WorkforceOidcPort) {
  let next: { before?: () => Promise<void>; after?: (tokens: WorkforceTokenSet) => Promise<void> } = {};
  const port: WorkforceOidcPort = {
    kind: inner.kind,
    clientId: inner.clientId,
    issuer: inner.issuer,
    authorizationRequest: (i) => inner.authorizationRequest(i),
    exchangeCode: (i) => inner.exchangeCode(i),
    refresh: async (i) => {
      const hold = next;
      next = {};
      if (hold.before) await hold.before();
      const tokens = await inner.refresh(i);
      if (hold.after) await hold.after(tokens);
      return tokens;
    },
    introspect: (t, h) => inner.introspect(t, h),
    revoke: (t, h) => inner.revoke(t, h),
    health: () => inner.health(),
  };
  return { port, holdNext: (h: typeof next) => (next = h) };
}

/** Recovery custodians over the given service (propose by admin A, holder proof in their SSO session, approve by B). */
function custodianKit(svc: WorkforceSsoService) {
  const audit = new PgAuditWriter({ db: idb.db, clock, stream: `console.l2-adversary-recovery-${randomBytes(4).toString("hex")}`, standaloneRole: "app_console" });
  const recovery = new PgRecoveryService({ db: idb.db, audit, sessions: new PgConsoleSessionStore(idb.db), issuance: new PgBreakGlassIssuance(idb.db, audit, BREAK_GLASS_MAX_DURATION_SECONDS), clock, tenantId: TENANT });
  const [adminA, adminB] = [`stf_${randomBytes(15).toString("base64url")}`, `stf_${randomBytes(15).toString("base64url")}`];
  const ev = (staffId: string, action: string, reasonCode: string) => consoleAuditInput({ tenantId: TENANT, correlationId: `cor_${randomBytes(12).toString("base64url")}`, staffId, role: "security_admin", action, outcome: "SUCCEEDED", reasonCode, occurredAt: clock.now() });
  const enroll = async (token: string, roles: ("supervisor" | "security_admin")[] = ["supervisor"]) => {
    const holder = await svc.authenticate(bearer(token));
    const k = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const j = k.publicKey.export({ format: "jwk" }) as { x: string; y: string };
    const p = await recovery.propose({ proposerId: adminA, body: { staffId: holder.staffId, publicJwk: { kty: "EC", crv: "P-256", x: j.x, y: j.y }, attestationRef: `att_synth${randomBytes(12).toString("base64url")}`, roles }, now: clock.now(), audit: ev(adminA, "console.recovery_identities.propose", "RECOVERY_IDENTITY_PROPOSED") });
    const signature = await signRecoveryEnrollment({ privateKey: k.privateKey, tenantId: TENANT, identityId: p.identity.identityId, staffId: holder.staffId, keyThumbprint: p.identity.keyThumbprint, challenge: p.enrollment.challenge, now: clock.now() });
    await recovery.confirm({ holder: { staffId: holder.staffId, sessionKind: holder.kind, sessionHash: holder.sessionHash, roles: holder.roles }, identityId: p.identity.identityId, signature, now: clock.now(), audit: ev(holder.staffId, "console.recovery_identities.confirm", "RECOVERY_IDENTITY_HOLDER_CONFIRMED") });
    expect((await recovery.approve({ approverId: adminB, identityId: p.identity.identityId, now: clock.now(), audit: ev(adminB, "console.recovery_identities.approve", "RECOVERY_IDENTITY_APPROVED") })).status).toBe("ACTIVE");
    return { identityId: p.identity.identityId, privateKey: k.privateKey, staffId: holder.staffId };
  };
  const activate = async (x: { identityId: string; privateKey: KeyObject }, y: { identityId: string; privateKey: KeyObject }) => {
    const c = await recovery.challenge({ identityId: x.identityId, proof: await signRecoveryRequest({ privateKey: x.privateKey, tenantId: TENANT, identityId: x.identityId, now: clock.now() }), correlationId: `cor_${randomBytes(12).toString("base64url")}` });
    const sign = (who: { identityId: string; privateKey: KeyObject }) => signRecoveryChallenge({ privateKey: who.privateKey, tenantId: TENANT, activationId: c.activationId, challenge: c.challenge, identityId: who.identityId, now: clock.now() });
    return recovery.activate({ body: { activationId: c.activationId, approvals: [{ identityId: x.identityId, signature: await sign(x) }, { identityId: y.identityId, signature: await sign(y) }] }, correlationId: `cor_${randomBytes(12).toString("base64url")}` });
  };
  const identity = async (identityId: string) =>
    (await idb.db.query<{ status: string; suspend_reason: string | null }>("select status, suspend_reason from console_recovery_identities where identity_id = $1", [identityId])).rows[0];
  return { enroll, activate, identity };
}

const bearer = (t: string) => `Bearer ${t}`;
const reasonOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "NO_ERROR";
  } catch (e) {
    return (e as { reasonCode?: string }).reasonCode ?? String(e);
  }
};
const userId = async (realm: string, u: SyntheticUser) => (await kc.adminJson<{ id: string }[]>(`/realms/${realm}/users?username=${encodeURIComponent(u.username)}&exact=true`))[0]?.id;

describe("console workforce SSO on Keycloak: adversarial and fidelity cases", () => {
  beforeAll(async () => {
    const l2 = layer2Context(SERVICES);
    kc = new Keycloak(`https://localhost:${l2.port("keycloak", 8443)}`);
    pki = createIdentityPki();
    proxy = new IdpTlsProxy(pki, l2.port("keycloak", 8443));
    await proxy.start();
    await kc.createRealm(realmRep({ realm: REALM, client: CLIENT, users: Object.values(users), groups: GROUPS, groupClientRoles: GROUP_CLIENT_ROLES }));
    await kc.setAuthenticatorReference(REALM, "browser", "auth-username-password-form", "pwd");
    await kc.setAuthenticatorReference(REALM, "browser", "auth-otp-form", "otp");
    // The single-factor realm labels ONLY the OTP step: its password + TOTP logins carry amr ["otp"], one factor value.
    await kc.createRealm(realmRep({ realm: SF_REALM, client: CLIENT, users: Object.values(sfUsers), groups: GROUPS, groupClientRoles: GROUP_CLIENT_ROLES }));
    await kc.setAuthenticatorReference(SF_REALM, "browser", "auth-otp-form", "otp");
    for (const u of Object.values(users)) u.id = await userId(REALM, u);
    idb = await createIntegrationDb(l2);
    clock = new AheadClock();
    oidc = liveOidc({ pki, proxyPort: proxy.port, issuer: ISSUER, clientId: CLIENT.clientId, clientSecret: CLIENT.secret, clock, groupsClaim: CLIENT_ROLES_CLAIM });
    groupsReader = liveOidc({ pki, proxyPort: proxy.port, issuer: ISSUER, clientId: CLIENT.clientId, clientSecret: CLIENT.secret, clock, groupsClaim: "groups" });
    sfOidc = liveOidc({ pki, proxyPort: proxy.port, issuer: SF_ISSUER, clientId: CLIENT.clientId, clientSecret: CLIENT.secret, clock, groupsClaim: CLIENT_ROLES_CLAIM });
    await waitForRealm(oidc, ISSUER);
    await waitForRealm(sfOidc, SF_ISSUER);
    service = serviceFor(oidc, configFor(ISSUER), "console.l2-adversary");
    sfService = serviceFor(sfOidc, configFor(SF_ISSUER), "console.l2-single-factor");
  }, 180_000);

  afterAll(async () => {
    await kc?.deleteRealm(REALM);
    await kc?.deleteRealm(SF_REALM);
    await proxy?.stop();
    await idb?.drop();
    pki?.dispose();
  });

  it("[FO-14-52][FO-14-51][AUTH-04] a custodian who logged out of one browser and is then disabled at Keycloak is offboarded through the OTHER browser's session: the sweep suspends the identity (CUSTODIAN_OFFBOARDED) and recovery activation is refused (verifier probe A)", async () => {
    const { enroll, activate } = custodianKit(service);

    const browser1 = await signIn(service, users.custodian);
    const x = await enroll(browser1.token);
    const y = await enroll((await signIn(service, users.cosigner)).token);
    const browser2 = await signIn(service, users.custodian);
    // The path works while the custodian is employed.
    expect((await activate(x, y)).staffId).toBe(x.staffId);
    // Normal use: the custodian logs out of browser 1 (RFC 7009 revocation of that session's refresh token).
    clock.advanceSeconds(1);
    await service.logout(await service.authenticate(bearer(browser1.token)), clock.now());
    // Keycloak semantics (probe K1): browser 2's IdP session and refresh token stay active after that logout.
    expect(await oidc.client.introspect(await sealedRefreshToken(browser1.token), "refresh_token")).toMatchObject({ active: false });
    expect(await oidc.client.introspect(await sealedRefreshToken(browser2.token), "refresh_token")).toMatchObject({ active: true });
    // Offboarding: disabled at Keycloak; no console request from the custodian; the sweep checks browser 2.
    await kc.admin("PUT", `/realms/${REALM}/users/${users.custodian.id}`, { enabled: false });
    clock.advanceSeconds(2);
    const swept = await service.sweep();
    expect(swept.revoked).toBeGreaterThanOrEqual(1);
    const ident = await idb.db.query<{ status: string; suspend_reason: string | null }>("select status, suspend_reason from console_recovery_identities where identity_id = $1", [x.identityId]);
    expect(ident.rows[0]).toEqual({ status: "SUSPENDED", suspend_reason: "CUSTODIAN_OFFBOARDED" });
    const reasons = await idb.db.query<{ session_hash: string; revoke_reason: string | null }>("select session_hash, revoke_reason from console_sessions where staff_id = $1 and kind = 'OIDC_SSO'", [x.staffId]);
    expect(reasons.rows.find((r) => r.session_hash === consoleSessionHash(browser1.token))?.revoke_reason).toBe("STAFF_LOGOUT");
    expect(reasons.rows.find((r) => r.session_hash === consoleSessionHash(browser2.token))?.revoke_reason).toBe("STAFF_DEPROVISIONED");
    expect(await reasonOf(service.authenticate(bearer(browser2.token)))).toBe("SESSION_REVOKED");
    expect(await reasonOf(activate(x, y))).toBe("RECOVERY_IDENTITY_UNAVAILABLE");
    const audited = await idb.db.query<{ n: number }>("select count(*)::int as n from audit_outbox where action = 'console.recovery_identity.suspended' and event->>'actorRef' = $1 and event->>'reasonCode' = 'CUSTODIAN_OFFBOARDED'", [x.staffId]);
    expect(audited.rows[0]?.n).toBeGreaterThan(0);
    // The co-signer (still employed) is untouched.
    expect((await idb.db.query<{ status: string }>("select status from console_recovery_identities where identity_id = $1", [y.identityId])).rows[0]?.status).toBe("ACTIVE");
  });

  it("[FO-05-41][FO-01-09] a lookalike top-level group named 'vsp/security-admin' (same full path as the managed group on Keycloak 26) grants nothing: the console maps the console client's roles, not group paths (verifier probe K2)", async () => {
    const created = await kc.admin("POST", `/realms/${REALM}/groups`, { name: "vsp/security-admin" });
    expect(created.status).toBe(201);
    // Fidelity finding: the lookalike's path is byte-identical to the nested managed group's.
    type GroupRep = { id: string; name: string; path: string };
    const topLevel = await kc.adminJson<GroupRep[]>(`/realms/${REALM}/groups?briefRepresentation=false&max=100`);
    const lookalike = topLevel.find((g) => g.name === "vsp/security-admin");
    const parent = topLevel.find((g) => g.name === "vsp");
    if (!parent) throw new Error("managed parent group missing");
    const managed = (await kc.adminJson<GroupRep[]>(`/realms/${REALM}/groups/${parent.id}/children?briefRepresentation=false&max=100`)).find((g) => g.name === "security-admin");
    expect(lookalike?.path).toBe("/vsp/security-admin");
    expect(managed?.path).toBe("/vsp/security-admin");
    if (!lookalike) throw new Error("lookalike group missing");
    for (const u of [users.mallory, users.malloryProbe]) expect((await kc.admin("PUT", `/realms/${REALM}/users/${u.id}/groups/${lookalike.id}`)).status).toBe(204);
    // What a group-PATH mapping would see: the groups claim names the lookalike exactly like the managed group, and
    // a path mapping turns it into security_admin. This is why the console refuses GROUP_PATHS without an approval.
    const claimed = await directTokens(groupsReader, users.malloryProbe);
    expect(claimed.idToken.groups).toEqual(expect.arrayContaining(["/vsp/supervisor", "/vsp/security-admin"]));
    const pathMapping = rolesForGroups({ membershipSource: { kind: "GROUP_PATHS", unambiguousPathsRef: "apr_synthPathsIllustration01" }, groupRoles: { "/vsp/supervisor": "supervisor", "/vsp/security-admin": "security_admin" }, managedGroupPrefix: "/vsp/" }, claimed.idToken.groups);
    expect(pathMapping).toEqual({ roles: ["supervisor", "security_admin"] });
    // The console's own sign-in: the client-role claim carries only the role the managed group grants.
    const s = await signIn(service, users.mallory);
    expect(s.roles).toEqual(["supervisor"]);
    expect((await service.authenticate(bearer(s.token))).roles).toEqual(["supervisor"]);
    const row = await idb.db.query<{ roles: string[] }>("select roles from console_sessions where session_hash = $1", [consoleSessionHash(s.token)]);
    expect(row.rows[0]?.roles).toEqual(["supervisor"]);
    // And the active-state check (introspection) maps the same claim: still supervisor only.
    clock.advanceSeconds(1);
    expect((await service.authenticate(bearer(s.token))).roles).toEqual(["supervisor"]);
  });

  it("[FO-05-10][FO-05-11][STRIDE-D] an anonymous flood of sign-in starts stores nothing on PostgreSQL 16 and a legitimate Keycloak sign-in during it succeeds; a tampered or replayed state is refused before the IdP redeems the code (verifier probe B)", async () => {
    const rows = async () => (await idb.db.query<{ n: number }>("select count(*)::int as n from console_login_transactions")).rows[0]?.n ?? 0;
    const before = await rows();
    const flood = Array.from({ length: 300 }, () => service.start({ redirectUri: CONSOLE_REDIRECT, codeChallenge: s256Challenge(randomBytes(48).toString("base64url")) }));
    const [signedIn, ...started] = await Promise.all([signIn(service, users.duringFlood), ...flood]);
    expect(signedIn?.roles).toEqual(["supervisor"]);
    expect(started.every((x) => typeof x.state === "string")).toBe(true);
    // Only the one redeemed state left a (single-use) row.
    expect(await rows()).toBe(before + 1);
    // A tampered state never reaches Keycloak; the untouched one still redeems the same code; a replay is refused.
    const verifier = randomBytes(48).toString("base64url");
    const start = await service.start({ redirectUri: CONSOLE_REDIRECT, codeChallenge: s256Challenge(verifier) });
    const back = await new Browser(pki, proxy).signIn(start.authorizationUrl, users.tamperTarget, CONSOLE_REDIRECT);
    if ("refused" in back) throw new Error(`IDP_REFUSED_LOGIN: ${back.refused}`);
    const raw = Buffer.from(back.state, "base64url");
    raw[raw.length - 50] = (raw[raw.length - 50] ?? 0) ^ 1;
    const exchange = (state: string) => service.exchange({ code: back.code, state, codeVerifier: verifier, redirectUri: CONSOLE_REDIRECT, correlationId: "cor_synthIdentityL2Tampered1" });
    expect(await reasonOf(exchange(raw.toString("base64url")))).toBe("LOGIN_TRANSACTION_UNAVAILABLE");
    expect((await exchange(back.state)).roles).toEqual(["supervisor"]);
    expect(await reasonOf(exchange(back.state))).toBe("LOGIN_TRANSACTION_UNAVAILABLE");
    expect(await rows()).toBe(before + 2);
  });

  it("[FO-05-41][AUTH-01] the default MFA rule on Keycloak: a login whose amr carries a single factor value is refused STAFF_MFA_REQUIRED (the pwd + otp login of the main suite passes)", async () => {
    const probe = await directTokens(sfOidc, sfUsers.probe);
    expect(probe.idToken.amr).toEqual(["otp"]);
    expect(await reasonOf(signIn(sfService, sfUsers.operator))).toBe("STAFF_MFA_REQUIRED");
    const refused = await idb.db.query<{ n: number }>("select count(*)::int as n from audit_outbox where action = 'console.auth.oidc_exchange' and event->>'reasonCode' = 'STAFF_MFA_REQUIRED'");
    expect(refused.rows[0]?.n).toBeGreaterThan(0);
  });

  it("[FO-14-52][FO-14-51][AUTH-04] on Keycloak, logout and refresh of one session decide with Keycloak's answer, fail closed (verifier probe R): a disabled custodian's refused refresh suspends them; a logout during a refresh held before Keycloak is asked suspends a disabled custodian at once and keeps an employed one, and the refresh Keycloak then refuses decides nothing more; a logout after Keycloak redeemed the token suspends even an employed custodian (reinstated by the next sign-in) and the successor tokens are inactive at Keycloak", async () => {
    // Active checks at the production cadence, so a logout during an in-flight refresh is not refused by its own check.
    const held = holdingPort(oidc.client);
    const svc = serviceFor(oidc, configFor(ISSUER, { activeCheckIntervalSeconds: 60 }), "console.l2-adversary-race", held.port);
    const { enroll, activate, identity } = custodianKit(svc);
    const cosigner = await enroll((await signIn(svc, users.cosigner)).token);
    const disable = async (u: SyntheticUser) => expect((await kc.admin("PUT", `/realms/${REALM}/users/${u.id}`, { enabled: false })).status).toBe(204);
    const offboarded = { status: "SUSPENDED", suspend_reason: "CUSTODIAN_OFFBOARDED" };
    const kept = { status: "ACTIVE", suspend_reason: null };
    const cor = "cor_synthIdentityL2RaceRefresh1";
    const revokeReason = async (token: string) => (await idb.db.query<{ revoke_reason: string | null }>("select revoke_reason from console_sessions where session_hash = $1", [consoleSessionHash(token)])).rows[0]?.revoke_reason ?? null;
    /** Holds the next refresh before Keycloak is asked; returns when it is held and how to release it. */
    const holdBeforeKeycloak = () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let reached!: () => void;
      const atKeycloak = new Promise<void>((r) => (reached = r));
      held.holdNext({
        before: async () => {
          reached();
          await gate;
        },
      });
      return { atKeycloak, release };
    };

    // 1. Disabled at Keycloak, the custodian's next refresh is refused (invalid_grant): suspended.
    const s1 = await signIn(svc, users.refusedRefresh);
    const x1 = await enroll(s1.token);
    expect((await activate(x1, cosigner)).staffId).toBe(x1.staffId);
    await disable(users.refusedRefresh);
    clock.advanceSeconds(1);
    expect(await reasonOf(svc.refresh(bearer(s1.token), cor))).toBe("SESSION_REFRESH_REFUSED");
    expect(await identity(x1.identityId)).toEqual(offboarded);
    expect(await reasonOf(activate(x1, cosigner))).toBe("RECOVERY_IDENTITY_UNAVAILABLE");

    // 2. Probe R: disabled at Keycloak, a refresh of the session is held before Keycloak is asked, and the custodian logs
    //    out of that session. Keycloak reports the token inactive to the logout, which suspends at once; Keycloak then
    //    refuses the refresh, which finds the family closed and decides nothing more.
    const s2 = await signIn(svc, users.raceRefused);
    const x2 = await enroll(s2.token);
    await disable(users.raceRefused);
    const h2 = holdBeforeKeycloak();
    clock.advanceSeconds(1);
    const refreshing = reasonOf(svc.refresh(bearer(s2.token), cor));
    await h2.atKeycloak;
    await svc.logout(await svc.authenticate(bearer(s2.token)), clock.now());
    expect(await identity(x2.identityId)).toEqual(offboarded);
    h2.release();
    expect(await refreshing).toBe("SESSION_REFRESH_REFUSED");
    expect(await identity(x2.identityId)).toEqual(offboarded);
    expect(await reasonOf(activate(x2, cosigner))).toBe("RECOVERY_IDENTITY_UNAVAILABLE");
    expect(await revokeReason(s2.token)).toBe("STAFF_LOGOUT");

    // 2b. An EMPLOYED custodian, same race: Keycloak answers the logout active (nothing redeemed yet), the identity stays;
    //     Keycloak then refuses the refresh (the logout revoked the token there), which decides nothing more.
    const sa = await signIn(svc, users.raceActive);
    const xa = await enroll(sa.token);
    const ha = holdBeforeKeycloak();
    clock.advanceSeconds(1);
    const refreshingA = reasonOf(svc.refresh(bearer(sa.token), cor));
    await ha.atKeycloak;
    await svc.logout(await svc.authenticate(bearer(sa.token)), clock.now());
    expect(await identity(xa.identityId)).toEqual(kept);
    ha.release();
    expect(await refreshingA).toBe("SESSION_REFRESH_REFUSED");
    expect(await identity(xa.identityId)).toEqual(kept);
    expect((await activate(xa, cosigner)).staffId).toBe(xa.staffId);

    // 3. An employed custodian: Keycloak redeems the refresh token, and the logout runs before the console records the
    //    rotation. Keycloak reports the redeemed token inactive (asserted), nothing explains that away: suspended (fail
    //    closed); the successor Keycloak just issued is inactive (the console revokes it; Keycloak's revocation of the
    //    redeemed token by the logout ends it as well: fidelity note). The next sign-in reinstates the custodian.
    const s3 = await signIn(svc, users.raceRedeemed);
    const x3 = await enroll(s3.token);
    const oldRefresh = await sealedRefreshToken(s3.token);
    let issued: string | null = null;
    let oldTokenAtLogout: boolean | null = null;
    held.holdNext({
      after: async (tokens) => {
        issued = tokens.refreshToken;
        oldTokenAtLogout = (await oidc.client.introspect(oldRefresh, "refresh_token")).active;
        await svc.logout(await svc.authenticate(bearer(s3.token)), clock.now());
      },
    });
    clock.advanceSeconds(1);
    expect(await reasonOf(svc.refresh(bearer(s3.token), cor))).toBe("SESSION_REVOKED");
    expect(issued).not.toBeNull();
    // Keycloak semantics (revokeRefreshToken, max reuse 0): the redeemed token is reported inactive to the logout.
    expect(oldTokenAtLogout).toBe(false);
    expect(await identity(x3.identityId)).toEqual(offboarded);
    expect(await oidc.client.introspect(issued as unknown as string, "refresh_token")).toMatchObject({ active: false });
    expect(await reasonOf(activate(x3, cosigner))).toBe("RECOVERY_IDENTITY_UNAVAILABLE");
    await signIn(svc, users.raceRedeemed);
    expect(await identity(x3.identityId)).toEqual(kept);
    expect((await activate(x3, cosigner)).staffId).toBe(x3.staffId);
  });

  it("[FO-14-52][FO-14-51][AUTH-04] on Keycloak, the refresh-token replay closure decides with Keycloak's answer about the family's live row (verifier probe Q1): refreshed once, disabled at Keycloak, the superseded bearer presented: SUSPENDED CUSTODIAN_OFFBOARDED, the sweep changes nothing, activation refused; an employed custodian's replay keeps the identity", async () => {
    const svc = serviceFor(oidc, configFor(ISSUER, { activeCheckIntervalSeconds: 60 }), "console.l2-adversary-replay");
    const { enroll, activate, identity } = custodianKit(svc);
    const cosigner = await enroll((await signIn(svc, users.cosigner)).token);
    const cor = "cor_synthIdentityL2ReplayDodge1";
    const reasons = async (familyOf: string) =>
      (await idb.db.query<{ revoke_reason: string | null }>("select revoke_reason from console_sessions where family_id = (select family_id from console_sessions where session_hash = $1) order by generation", [consoleSessionHash(familyOf)])).rows.map((r) => r.revoke_reason);

    // Q1: one refresh while employed (the console keeps the successor, the custodian also keeps the superseded bearer),
    //     disabled at Keycloak while the successor is live, then the superseded bearer instead of a logout.
    const s1 = await signIn(svc, users.replayDodge);
    const x = await enroll(s1.token);
    clock.advanceSeconds(1);
    const s2 = await svc.refresh(bearer(s1.token), cor);
    expect((await kc.admin("PUT", `/realms/${REALM}/users/${users.replayDodge.id}`, { enabled: false })).status).toBe(204);
    clock.advanceSeconds(2);
    expect(await reasonOf(svc.refresh(bearer(s1.token), cor))).toBe("SESSION_TOKEN_REPLAYED");
    expect(await identity(x.identityId)).toEqual({ status: "SUSPENDED", suspend_reason: "CUSTODIAN_OFFBOARDED" });
    expect(await reasons(s1.token)).toEqual(["SESSION_TOKEN_REPLAYED", "SESSION_TOKEN_REPLAYED"]);
    expect(await reasonOf(svc.authenticate(bearer(s2.token)))).toBe("SESSION_REVOKED");
    clock.advanceSeconds(61);
    await svc.sweep();
    expect(await identity(x.identityId)).toEqual({ status: "SUSPENDED", suspend_reason: "CUSTODIAN_OFFBOARDED" });
    expect(await reasonOf(activate(x, cosigner))).toBe("RECOVERY_IDENTITY_UNAVAILABLE");

    // An employed custodian's replay: Keycloak vouches for the live row's subject with the role, the identity stays (the
    // family is revoked all the same).
    const e1 = await signIn(svc, users.replayEmployed);
    const y = await enroll(e1.token);
    clock.advanceSeconds(1);
    await svc.refresh(bearer(e1.token), cor);
    clock.advanceSeconds(2);
    expect(await reasonOf(svc.refresh(bearer(e1.token), cor))).toBe("SESSION_TOKEN_REPLAYED");
    expect(await identity(y.identityId)).toEqual({ status: "ACTIVE", suspend_reason: null });
    expect(await reasons(e1.token)).toEqual(["SESSION_TOKEN_REPLAYED", "SESSION_TOKEN_REPLAYED"]);
    expect((await activate(y, cosigner)).staffId).toBe(y.staffId);
  });

  it("[FO-14-52][FO-14-51][AUTH-04] on Keycloak, only a new sign-in reinstates a SUSPENDED identity: a client role removed at Keycloak suspends the identity carrying it (CUSTODIAN_ROLES_REDUCED) at the next refresh; with the role given back, Keycloak's positive answers at the next refresh, the active checks and the logout leave it suspended, and the next MFA sign-in reinstates it (verifier probes N3-N5)", async () => {
    const svc = serviceFor(oidc, configFor(ISSUER), "console.l2-adversary-reinstate");
    const { enroll, identity } = custodianKit(svc);
    type GroupRep = { id: string; name: string };
    const parent = (await kc.adminJson<GroupRep[]>(`/realms/${REALM}/groups?briefRepresentation=false&max=100`)).find((g) => g.name === "vsp");
    if (!parent) throw new Error("managed parent group missing");
    const securityAdmin = (await kc.adminJson<GroupRep[]>(`/realms/${REALM}/groups/${parent.id}/children?briefRepresentation=false&max=100`)).find((g) => g.name === "security-admin");
    if (!securityAdmin) throw new Error("managed group missing");
    const membership = async (method: "PUT" | "DELETE") => expect((await kc.admin(method, `/realms/${REALM}/users/${users.reinstateOnly.id}/groups/${securityAdmin.id}`)).status).toBe(204);
    const sorted = (roles: readonly string[]) => [...roles].sort();
    const REDUCED = { status: "SUSPENDED", suspend_reason: "CUSTODIAN_ROLES_REDUCED" };
    const cor = "cor_synthIdentityL2Reinstate01";

    const s1 = await signIn(svc, users.reinstateOnly);
    expect(sorted(s1.roles)).toEqual(["security_admin", "supervisor"]);
    const x = await enroll(s1.token, ["supervisor", "security_admin"]);
    // The security-admin group (its client role) is removed at Keycloak: the refresh maps supervisor only.
    await membership("DELETE");
    clock.advanceSeconds(1);
    const s2 = await svc.refresh(bearer(s1.token), cor);
    expect(s2.roles).toEqual(["supervisor"]);
    expect(await identity(x.identityId)).toEqual(REDUCED);
    // Given back: the next refresh maps both roles again, the identity stays suspended.
    await membership("PUT");
    clock.advanceSeconds(1);
    const s3 = await svc.refresh(bearer(s2.token), cor);
    expect(sorted(s3.roles)).toEqual(["security_admin", "supervisor"]);
    expect(await identity(x.identityId)).toEqual(REDUCED);
    // The active checks (introspection) see the role go and come back: still suspended.
    await membership("DELETE");
    expect((await svc.authenticate(bearer(s3.token))).roles).toEqual(["supervisor"]);
    await membership("PUT");
    const back = await svc.authenticate(bearer(s3.token));
    expect(sorted(back.roles)).toEqual(["security_admin", "supervisor"]);
    expect(await identity(x.identityId)).toEqual(REDUCED);
    // Keycloak vouches for the person with both roles at the logout: still suspended.
    await svc.logout(back, clock.now());
    expect(await reasonOf(svc.authenticate(bearer(s3.token)))).toBe("SESSION_REVOKED");
    expect(await identity(x.identityId)).toEqual(REDUCED);
    // Only the next MFA sign-in reinstates.
    await signIn(svc, users.reinstateOnly);
    expect(await identity(x.identityId)).toEqual({ status: "ACTIVE", suspend_reason: null });
  });

  it("[FO-14-52][FO-14-51][AUTH-04] on Keycloak, the sweep's idle expiry closure asks Keycloak before it closes (sweep ordering): a custodian disabled after the last active check whose session then idles out is suspended; an employed one is not", async () => {
    // No active check would be due before the idle expiry: only the expiry closure can decide.
    const svc = serviceFor(oidc, configFor(ISSUER, { activeCheckIntervalSeconds: 900 }), "console.l2-adversary-expiry");
    const { enroll, identity } = custodianKit(svc);
    const d = await signIn(svc, users.idleDisabled);
    const xd = await enroll(d.token);
    const e = await signIn(svc, users.idleEmployed);
    const xe = await enroll(e.token);
    expect((await kc.admin("PUT", `/realms/${REALM}/users/${users.idleDisabled.id}`, { enabled: false })).status).toBe(204);
    clock.advanceSeconds(601);
    await svc.sweep();
    const reason = async (token: string) => (await idb.db.query<{ revoke_reason: string | null }>("select revoke_reason from console_sessions where session_hash = $1", [consoleSessionHash(token)])).rows[0]?.revoke_reason ?? null;
    expect(await reason(d.token)).toBe("SESSION_IDLE_EXPIRED");
    expect(await reason(e.token)).toBe("SESSION_IDLE_EXPIRED");
    expect(await identity(xd.identityId)).toEqual({ status: "SUSPENDED", suspend_reason: "CUSTODIAN_OFFBOARDED" });
    expect(await identity(xe.identityId)).toEqual({ status: "ACTIVE", suspend_reason: null });
  });
});
