/**
 * Layer 2 (WP-05): caller A2 verification and the trusted call session over the production path:
 * TrustedSessionService and SecureVerificationService on DynamoDB Local (DynamoKvStore), the secure-link
 * approval verified by JwksOidcVerifier.fromDiscovery against Keycloak 26 (through the test's TLS proxy as
 * https://idp.vsp-identity.test), and the portal's own authorization-code + PKCE exchange done by
 * OidcRelyingPartyClient with the transaction nonce. The injected-clock SessionExpirySeam is the session
 * clock, so time moves while the DynamoDB record stays untouched (TTL cleanup has not run).
 *
 * Faults: [FAULT:AUTH_EXPIRY_IDLE] (idle limit while the caller is silent) and [FAULT:IDP_UNAVAILABLE]
 * (the caller IdP cannot complete the secure-link approval). Their postconditions are observed where a caller
 * meets them: through the production ToolPipeline over the same session store (gateway-support.ts: real OPA
 * bundle, PgAuditWriter on PostgreSQL 16, TemplateResponseGate), the Talkdesk auth gate and the speech gate.
 * The AUTH_EXPIRY_MID_CALL seam is exercised here on the live store; its end-to-end Layer-2 run
 * (prepare -> expiry -> commit) belongs to WP-07.
 */
import { createHash, randomBytes } from "node:crypto";
import { GetItemCommand } from "@aws-sdk/client-dynamodb";
import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { afterAll, beforeAll, describe, expect } from "vitest";
import { s256Challenge } from "../../../src/adapters/live/oidc-client.js";
import { JwksOidcVerifier } from "../../../src/adapters/live/oidc-verifier.js";
import { sessionConfig, verificationConfig } from "../../../src/identity/config.js";
import { SessionExpirySeam } from "../../../src/identity/expiry-seam.js";
import { kvKeys, sessionRefHash } from "../../../src/identity/keys.js";
import { DynamoKvStore } from "../../../src/identity/kv/dynamo-kv-store.js";
import { TrustedSessionService } from "../../../src/identity/session-service.js";
import { SecureVerificationService, effectiveAssuranceFor } from "../../../src/identity/verification-service.js";
import { createMemoryLogger } from "../../../src/observability/logger.js";
import { emptySnapshot } from "../../../src/ops/kill-switches.js";
import type { IntegrationIdentity } from "../../../src/protocol/index.js";
import { systemClock } from "../../../src/shared/clock.js";
import { newId } from "../../../src/shared/ids.js";
import { newTurnId } from "../../../src/shared/ids.js";
import { createIntegrationDb, dynamoClient } from "../_harness/clients.js";
import type { IntegrationDb } from "../_harness/clients.js";
import { Keycloak } from "../_harness/keycloak.js";
import { layer2, layer2Context } from "../_harness/layer2.js";
import { StandInRelationships, composeGateway } from "./gateway-support.js";
import type { ComposedGateway } from "./gateway-support.js";
import { Browser, CapturedLinks, IDP_ORIGIN, IdpTlsProxy, PORTAL_REDIRECT, StandInAccountDirectory, createIdentityPki, createSessionTable, liveOidc, newUser, realmName, realmRep, waitForRealm } from "./support.js";
import type { LiveOidc, StandInAccount, SyntheticUser, TestPki } from "./support.js";

const SERVICES = ["keycloak", "dynamodb", "postgres"];
const it = layer2(SERVICES);
const TENANT = "tnt_synthCallerL2Tenant01";
const REALM = realmName("caller");
const ISSUER = `${IDP_ORIGIN}/realms/${REALM}`;
const PORTAL = { clientId: "vsp-portal", secret: randomBytes(24).toString("base64url"), redirectUri: PORTAL_REDIRECT };
// One synthetic caller per scenario: Keycloak refuses an OTP reused within its 30 s step, so a user that signs
// in twice in a row waits for the next step (only the same-actor re-verification and step-up need that).
const users = {
  avery: newUser("avery", []),
  blake: newUser("blake", []),
  casey: newUser("casey", []),
  devon: newUser("devon", []),
  ellis: newUser("ellis", []),
  finley: newUser("finley", []),
  gray: newUser("gray", []),
  harper: newUser("harper", []),
  // Password only (no TOTP credential): Keycloak's login carries amr ["pwd"], one factor.
  indigo: newUser("indigo", [], false),
};

const integ = (channel: IntegrationIdentity["channel"]): IntegrationIdentity => ({ integrationId: "talkdesk-l2", tenantId: TENANT, environment: "local", channel, credentialId: `cred-l2-${channel}`, authMethod: "oauth2_client_credentials" });

let kc: Keycloak;
let pki: TestPki;
let proxy: IdpTlsProxy;
let ddb: DynamoDBClient;
let table: string;
let seam: SessionExpirySeam;
let portal: LiveOidc;
let sessions: TrustedSessionService;
let links: CapturedLinks;
let directory: StandInAccountDirectory;
let idb: IntegrationDb;
let gw: ComposedGateway;
const accounts: Record<keyof typeof users, StandInAccount> = {} as Record<keyof typeof users, StandInAccount>;

function verificationService(): SecureVerificationService {
  // A verifier with its own discovery: nothing cached from earlier tests.
  const own = liveOidc({ pki, proxyPort: proxy.port, issuer: ISSUER, clientId: PORTAL.clientId, clientSecret: PORTAL.secret, clock: seam });
  return new SecureVerificationService({
    sessions,
    kv: DynamoKvStore.fromClient(ddb, table),
    directory,
    oidc: JwksOidcVerifier.fromDiscovery({ integrationId: "oidc-client-idp", clock: seam, providers: [{ discovery: own.discovery, audience: PORTAL.clientId }] }),
    notifications: links,
    clock: seam,
    config: verificationConfig({ otpEnabled: false }),
    otpPepper: randomBytes(32),
    logger: createMemoryLogger().logger,
    notificationSwitches: async () => emptySnapshot(),
  });
}

async function startCall() {
  const started = await sessions.startCall({ integration: integ("telephony_control"), callId: newId("cal"), callerIdHash: null, consent: { recording: "GRANTED", automatedProcessing: "GRANTED", disclosureTemplateVersion: "disclosure-l2-v1", capturedAt: seam.now().toISOString(), capturedBy: "studio_flow" } });
  return started.sessionRef;
}

/** The portal leg: the caller signs in at the IdP with the transaction nonce; the portal backend exchanges the code. */
async function portalIdToken(user: SyntheticUser, nonce: string): Promise<string> {
  const verifier = randomBytes(48).toString("base64url");
  const state = randomBytes(32).toString("base64url");
  const { url } = await portal.client.authorizationRequest({ redirectUri: PORTAL_REDIRECT, state, nonce, codeChallenge: s256Challenge(verifier), scopes: ["openid"] });
  const back = await new Browser(pki, proxy).signIn(url, user, PORTAL_REDIRECT);
  if ("refused" in back) throw new Error(`IDP_REFUSED_LOGIN: ${back.refused}`);
  expect(back.state).toBe(state);
  return (await portal.client.exchangeCode({ code: back.code, codeVerifier: verifier, redirectUri: PORTAL_REDIRECT, nonce, maxAuthAgeSeconds: 600 })).idTokenJwt;
}

async function verify(svc: SecureVerificationService, sessionRef: string, who: keyof typeof users) {
  const ctx = await sessions.resolve(sessionRef, integ("mcp_tools"));
  await svc.beginSecureLink(ctx, { role: "client", locator: { portalUsernameHint: accounts[who].portalUsernameHint } });
  const link = links.lastLink(accounts[who].channelRef);
  if (!link) throw new Error("NO_LINK_DELIVERED");
  const idToken = await portalIdToken(users[who], link.nonce);
  return svc.completeSecureLink({ ...link, idToken, matchCodeConfirmed: true });
}

const reasonOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "NO_ERROR";
  } catch (e) {
    return (e as { reasonCode?: string }).reasonCode ?? String(e);
  }
};

const recordExists = async (sessionRef: string): Promise<boolean> =>
  Boolean((await ddb.send(new GetItemCommand({ TableName: table, Key: { pk: { S: kvKeys.session(sessionRefHash(sessionRef)) } }, ConsistentRead: true }))).Item);

describe("caller A2 verification and the trusted session against Keycloak and DynamoDB Local", () => {
  beforeAll(async () => {
    const l2 = layer2Context(SERVICES);
    kc = new Keycloak(`https://localhost:${l2.port("keycloak", 8443)}`);
    pki = createIdentityPki();
    proxy = new IdpTlsProxy(pki, l2.port("keycloak", 8443));
    await proxy.start();
    await kc.createRealm(realmRep({ realm: REALM, client: PORTAL, users: Object.values(users), groups: [] }));
    await kc.setAuthenticatorReference(REALM, "browser", "auth-username-password-form", "pwd");
    await kc.setAuthenticatorReference(REALM, "browser", "auth-otp-form", "otp");
    for (const [key, u] of Object.entries(users) as [keyof typeof users, SyntheticUser][]) {
      u.id = (await kc.adminJson<{ id: string }[]>(`/realms/${REALM}/users?username=${encodeURIComponent(u.username)}&exact=true`))[0]?.id;
      accounts[key] = { accountId: newId("acc"), actorId: newId("act"), subjectId: newId("sub"), role: "client", portalUsernameHint: `${key}.synthetic`, channelRef: newId("chn"), idpIssuer: ISSUER, idpSubject: u.id ?? "", state: "ACTIVE" };
    }
    directory = new StandInAccountDirectory(Object.values(accounts));
    ddb = dynamoClient(l2);
    table = await createSessionTable(ddb);
    seam = SessionExpirySeam.wrap(systemClock, { environment: "local" });
    sessions = new TrustedSessionService({ kv: DynamoKvStore.fromClient(ddb, table), clock: seam, config: sessionConfig({ tenantId: TENANT, environment: "local", policyVersion: "policy-l2-2026.10.20" }) });
    portal = liveOidc({ pki, proxyPort: proxy.port, issuer: ISSUER, clientId: PORTAL.clientId, clientSecret: PORTAL.secret, clock: systemClock });
    await waitForRealm(portal, ISSUER);
    links = new CapturedLinks();
    idb = await createIntegrationDb(l2);
    gw = await composeGateway({
      db: idb.db,
      sessions,
      clock: seam,
      tenantId: TENANT,
      integration: integ("mcp_tools"),
      appointments: Object.values(accounts).map((a) => ({ appointmentId: newId("apt"), subjectId: a.subjectId, startsAt: "2026-11-03T09:30:00.000Z", timeZone: "America/Los_Angeles" })),
      relationships: new StandInRelationships(Object.values(accounts).map((a) => ({ actorId: a.actorId, subjectId: a.subjectId }))),
    });
  }, 180_000);

  afterAll(async () => {
    await kc?.deleteRealm(REALM);
    await proxy?.stop();
    await idb?.drop();
    pki?.dispose();
  });

  it("[FO-05-04][FO-05-09][FO-05-07] secure-link approval with a real IdP login (PKCE, transaction nonce) binds the caller at A2 with a server-established processing basis", async () => {
    seam.reset();
    const sessionRef = await startCall();
    const r = await verify(verificationService(), sessionRef, "avery");
    expect(r).toMatchObject({ bound: true, reasonCode: "VERIFIED" });
    const ctx = await sessions.resolve(sessionRef, integ("mcp_tools"));
    expect(ctx).toMatchObject({ assurance: "A2", actorId: accounts.avery.actorId, subjectId: accounts.avery.subjectId, verificationMethod: "secure_link_oidc", schemaVersion: "auth-context.v1" });
    expect(ctx.processingBasis).toMatchObject({ basis: "UNKNOWN", approvalRef: null, source: "identity_service" });
  });

  it("[FAULT:AUTH_EXPIRY_IDLE][FO-05-18][FO-05-19][AUTH-04][SAFE-02] after the idle limit a protected read fails closed and is audited while the DynamoDB record still exists; speech prepared before the expiry is never spoken; a person stays reachable without re-authentication; only the same actor re-verifies", async () => {
    seam.reset();
    const sessionRef = await startCall();
    const svc = verificationService();
    expect((await verify(svc, sessionRef, "casey")).bound).toBe(true);
    const before = await sessions.resolve(sessionRef, integ("mcp_tools"));
    // Before the expiry: the protected read succeeds and prepares protected speech for this generation.
    const turnId = newTurnId();
    const read = await gw.call("l2_get_appointments", sessionRef, {}, turnId);
    expect(read).toMatchObject({ status: "SUCCESS", sessionGeneration: before.sessionGeneration });
    const prepared = read.speech;
    if (!prepared?.authorizationRef) throw new Error("NO_PROTECTED_SPEECH_PREPARED");
    expect(prepared).toMatchObject({ responseClass: "PROTECTED_FACT", sessionGeneration: before.sessionGeneration, turnId });
    const speakable = gw.speechGate.render(prepared, gw.gateContext({ sessionRef, turnId, sessionGeneration: before.sessionGeneration, authorizationRefs: [prepared.authorizationRef] }));
    expect(speakable.ok).toBe(true);
    const readsBefore = gw.counters.reads;

    // The caller goes silent past the idle limit (injected clock; the record is untouched).
    seam.jumpPastIdle(before, sessions.config);
    // 1. A protected read after the idle limit fails closed with the idle reason, before any record is read,
    //    and the refused request is audited (backendEvidence).
    const refused = await gw.call("l2_get_appointments", sessionRef, {}, newTurnId());
    expect(refused).toMatchObject({ status: "POLICY_DENIED", reasonCode: "SESSION_IDLE_EXPIRED" });
    expect(gw.counters.reads).toBe(readsBefore);
    expect(await gw.auditRowFor(refused)).toMatchObject({ action: "tool.invoke", outcome: "DENIED", reasonCode: "SESSION_IDLE_EXPIRED" });
    expect(await recordExists(sessionRef)).toBe(true);
    // 2. The Talkdesk auth gate is closed, and the session is at A0 under a fenced generation.
    expect(await sessions.authGate(sessionRef, integ("telephony_control"))).toMatchObject({ isAuthenticated: false, sessionGeneration: before.sessionGeneration + 1 });
    const after = await sessions.resolve(sessionRef, integ("mcp_tools"));
    expect(after).toMatchObject({ assurance: "A0", actorId: null, subjectId: null, permittedScopes: [] });
    expect(after.sessionGeneration).toBe(before.sessionGeneration + 1);
    // 3. The speech prepared before the expiry discloses nothing after it: the speech gate drops it.
    const late = gw.speechGate.render(prepared, gw.gateContext({ sessionRef, turnId, sessionGeneration: after.sessionGeneration, authorizationRefs: [prepared.authorizationRef] }));
    expect(late).toMatchObject({ ok: false, reasonCode: "STALE_GENERATION", disposition: "DROP_STALE" });
    // 4. Safety and human routes stay available without re-authentication: with the lapsed session and with none.
    const human = await gw.call("l2_request_human", sessionRef, { reason: "CALLER_REQUESTED_HUMAN", language: "en" });
    expect(human).toMatchObject({ status: "PENDING", reasonCode: "TRANSFER_REQUESTED" });
    const humanNoSession = await gw.call("l2_request_human", null, { reason: "CALLER_REQUESTED_HUMAN", language: "en" });
    expect(humanNoSession).toMatchObject({ status: "PENDING", reasonCode: "TRANSFER_REQUESTED" });
    expect(gw.counters.human).toMatchObject({ withSession: 1, withoutSession: 1 });
    // 5. Re-verification: the real IdP signs Blake in fine, but the call is Casey's (no silent switch of person).
    seam.reset();
    expect(await verify(svc, sessionRef, "blake")).toMatchObject({ bound: false, reasonCode: "SESSION_ACTOR_MISMATCH" });
    expect((await verify(svc, sessionRef, "casey")).bound).toBe(true);
    expect(await sessions.resolve(sessionRef, integ("mcp_tools"))).toMatchObject({ assurance: "A2", actorId: accounts.casey.actorId });
  });

  it("[FAULT:AUTH_EXPIRY_IDLE][AUTH-07][AUTH-04] read FIRST after the idle limit, the Talkdesk auth gate is closed and fences the generation; the next protected read is refused and audited", async () => {
    seam.reset();
    const sessionRef = await startCall();
    expect((await verify(verificationService(), sessionRef, "devon")).bound).toBe(true);
    const before = await sessions.resolve(sessionRef, integ("mcp_tools"));
    expect(await sessions.authGate(sessionRef, integ("telephony_control"))).toMatchObject({ isAuthenticated: true, sessionGeneration: before.sessionGeneration });
    seam.jumpPastIdle(before, sessions.config);
    expect(await sessions.authGate(sessionRef, integ("telephony_control"))).toMatchObject({ isAuthenticated: false, sessionGeneration: before.sessionGeneration + 1 });
    expect(await recordExists(sessionRef)).toBe(true);
    const refused = await gw.call("l2_get_appointments", sessionRef, {}, newTurnId());
    expect(refused.status).toBe("POLICY_DENIED");
    expect(refused.sessionGeneration).toBe(before.sessionGeneration + 1);
    expect(await gw.auditRowFor(refused)).toMatchObject({ action: "tool.invoke", outcome: "DENIED" });
    seam.reset();
  });

  it("[FO-05-04][AUTH-01] a password-only real IdP login (amr [pwd], the account's own subject) cannot complete the secure link: MFA_REQUIRED, nothing bound, the transaction closed", async () => {
    seam.reset();
    const sessionRef = await startCall();
    const svc = verificationService();
    const ctx = await sessions.resolve(sessionRef, integ("mcp_tools"));
    await svc.beginSecureLink(ctx, { role: "client", locator: { portalUsernameHint: accounts.indigo.portalUsernameHint } });
    const link = links.lastLink(accounts.indigo.channelRef);
    if (!link) throw new Error("NO_LINK_DELIVERED");
    const pwdOnly = await portalIdToken(users.indigo, link.nonce);
    // The IdP really issued a single-factor token for the right person.
    expect((JSON.parse(Buffer.from(pwdOnly.split(".")[1] ?? "", "base64url").toString("utf8")) as { amr?: string[] }).amr).toEqual(["pwd"]);
    expect(await svc.completeSecureLink({ ...link, idToken: pwdOnly, matchCodeConfirmed: true })).toMatchObject({ bound: false, reasonCode: "MFA_REQUIRED" });
    expect(await sessions.resolve(sessionRef, integ("mcp_tools"))).toMatchObject({ assurance: "A0", actorId: null, subjectId: null });
    // Without A2 the protected read is refused before any record is read.
    const readsBefore = gw.counters.reads;
    expect(await gw.call("l2_get_appointments", sessionRef, {}, newTurnId())).toMatchObject({ status: "POLICY_DENIED" });
    expect(gw.counters.reads).toBe(readsBefore);
  });

  it("[FO-22-05][FO-05-19][AUTH-01] a different person's real IdP login cannot complete another account's secure link: ACTOR_MISMATCH, nothing bound", async () => {
    seam.reset();
    const sessionRef = await startCall();
    const svc = verificationService();
    const ctx = await sessions.resolve(sessionRef, integ("mcp_tools"));
    await svc.beginSecureLink(ctx, { role: "client", locator: { portalUsernameHint: accounts.ellis.portalUsernameHint } });
    const link = links.lastLink(accounts.ellis.channelRef);
    if (!link) throw new Error("NO_LINK_DELIVERED");
    // Finley obtained Ellis's link and signs in as himself at the real IdP with that transaction's nonce.
    const intruderToken = await portalIdToken(users.finley, link.nonce);
    expect(await svc.completeSecureLink({ ...link, idToken: intruderToken, matchCodeConfirmed: true })).toMatchObject({ bound: false, reasonCode: "ACTOR_MISMATCH" });
    expect(await sessions.resolve(sessionRef, integ("mcp_tools"))).toMatchObject({ assurance: "A0", actorId: null, subjectId: null });
    // The transaction is closed by the failed attempt: Ellis cannot be bound through the same link afterwards.
    const ownerToken = await portalIdToken(users.ellis, link.nonce);
    expect((await svc.completeSecureLink({ ...link, idToken: ownerToken, matchCodeConfirmed: true })).bound).toBe(false);
  });

  it("[FO-05-05][FO-05-11][ACT-01] step-up with a fresh real IdP login is bound to one action digest, single use and short-lived", async () => {
    seam.reset();
    const sessionRef = await startCall();
    const svc = verificationService();
    expect((await verify(svc, sessionRef, "gray")).bound).toBe(true);
    const digest = createHash("sha256").update("synthetic-action-l2-step-up").digest("hex");
    const otherDigest = createHash("sha256").update("synthetic-action-l2-other").digest("hex");
    const begun = await svc.beginStepUp(await sessions.resolve(sessionRef, integ("mcp_tools")), digest);
    expect(begun.response).toBe("IF_ELIGIBLE_A_LINK_WAS_SENT");
    const link = links.lastLink(accounts.gray.channelRef);
    if (!link) throw new Error("NO_LINK_DELIVERED");
    expect(link.transactionId).toBe(begun.transactionId);
    const idToken = await portalIdToken(users.gray, link.nonce);
    expect(await svc.completeStepUp({ ...link, idToken })).toMatchObject({ bound: true, reasonCode: "STEP_UP_VERIFIED" });
    // Single use: the same link and token cannot be redeemed again.
    expect(await svc.completeStepUp({ ...link, idToken })).toMatchObject({ bound: false, reasonCode: "VERIFICATION_TRANSACTION_ALREADY_USED" });
    const ctx = await sessions.resolve(sessionRef, integ("mcp_tools"));
    expect(effectiveAssuranceFor(ctx, digest, seam.now())).toBe("A3");
    expect(effectiveAssuranceFor(ctx, otherDigest, seam.now())).toBe("A2");
    // Short window: past the step-up validity the same digest is back at A2 (the session itself is still live).
    seam.advance(verificationConfig({ otpEnabled: false }).stepUpValiditySeconds * 1000 + 1_000);
    const later = await sessions.resolve(sessionRef, integ("mcp_tools"));
    expect(later.assurance).toBe("A2");
    expect(effectiveAssuranceFor(later, digest, seam.now())).toBe("A2");
    seam.reset();
  });

  it("[FAULT:AUTH_EXPIRY_MID_CALL seam][AUTH-04] the injected-clock seam drives the hard expiry on the live store: SESSION_EXPIRED while the record is untouched", async () => {
    seam.reset();
    const sessionRef = await startCall();
    const ctx = await sessions.resolve(sessionRef, integ("mcp_tools"));
    const item = await ddb.send(new GetItemCommand({ TableName: table, Key: { pk: { S: kvKeys.session(sessionRefHash(sessionRef)) } }, ConsistentRead: true }));
    seam.jumpPastExpiry(ctx.expiresAt);
    expect(await reasonOf(sessions.resolve(sessionRef, integ("mcp_tools")))).toBe("SESSION_EXPIRED");
    const still = await ddb.send(new GetItemCommand({ TableName: table, Key: { pk: { S: kvKeys.session(sessionRefHash(sessionRef)) } }, ConsistentRead: true }));
    expect(still.Item).toEqual(item.Item);
    seam.reset();
  });

  it("[FAULT:IDP_UNAVAILABLE][FO-05-30][AUTH-01][SAFE-02] the caller IdP is unreachable during secure-link approval: assurance stays A0, no protected read succeeds, no weaker method is substituted, the caller reaches a person", async () => {
    seam.reset();
    const sessionRef = await startCall();
    const svc = verificationService();
    const ctx = await sessions.resolve(sessionRef, integ("mcp_tools"));
    await svc.beginSecureLink(ctx, { role: "client", locator: { portalUsernameHint: accounts.harper.portalUsernameHint } });
    const link = links.lastLink(accounts.harper.channelRef);
    if (!link) throw new Error("NO_LINK_DELIVERED");
    // The caller completed the IdP login just before the outage; the platform cannot fetch the IdP keys.
    const idToken = await portalIdToken(users.harper, link.nonce);
    await proxy.stop();
    try {
      const r = await svc.completeSecureLink({ ...link, idToken, matchCodeConfirmed: true });
      expect(r).toMatchObject({ bound: false, reasonCode: "IDP_UNAVAILABLE" });
      const still = await sessions.resolve(sessionRef, integ("mcp_tools"));
      expect(still).toMatchObject({ assurance: "A0", actorId: null });
      // No protected read succeeds (refused and audited before any record is read).
      const readsBefore = gw.counters.reads;
      const refused = await gw.call("l2_get_appointments", sessionRef, {}, newTurnId());
      expect(refused.status).toBe("POLICY_DENIED");
      expect(gw.counters.reads).toBe(readsBefore);
      expect(await gw.auditRowFor(refused)).toMatchObject({ action: "tool.invoke", outcome: "DENIED" });
      // No fallback to a weaker method: OTP stays off and routes to a person.
      const otp = await svc.beginOtp(still, { role: "client", locator: { portalUsernameHint: accounts.harper.portalUsernameHint } });
      expect(otp.response).toBe("VERIFICATION_UNAVAILABLE_USE_HUMAN");
      // The caller reaches a person through the human route while the IdP is still down.
      const humanBefore = gw.counters.human.withSession;
      expect(await gw.call("l2_request_human", sessionRef, { reason: "CALLER_REQUESTED_HUMAN", language: "en" })).toMatchObject({ status: "PENDING", reasonCode: "TRANSFER_REQUESTED" });
      expect(gw.counters.human.withSession).toBe(humanBefore + 1);
    } finally {
      await proxy.start();
    }
  });
});
