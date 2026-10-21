/**
 * Layer 2 (WP-05, residual D4): a returning operator whose Keycloak SSO session is older than maxAuthAgeSeconds signs
 * in again in the SAME browser. The console's authorization request carries max_age = maxAuthAgeSeconds, so Keycloak
 * re-authenticates (password and TOTP forms again) and the code carries a fresh auth_time the exchange accepts; before
 * the fix Keycloak silently re-issued a code with the old auth_time and the backend refused it after redeeming it
 * (401 OIDC_AUTH_TOO_OLD, verifier probe E). Within the bound, the IdP's SSO session answers without any form.
 * Production adapters on Keycloak 26 and PostgreSQL 16; own realm and database; real time (no clock offset).
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect } from "vitest";
import { s256Challenge } from "../../../src/adapters/live/oidc-client.js";
import { PgAuditWriter } from "../../../src/audit/writer.js";
import { WorkforceTokenVerifier } from "../../../src/console-api/auth.js";
import { OidcGroupStaffDirectory } from "../../../src/console-api/oidc-staff-directory.js";
import { PgConsoleSessionStore, consoleSessionHash } from "../../../src/console-api/sessions.js";
import { DEFAULT_WORKFORCE_SESSION, parseWorkforceSsoConfig } from "../../../src/console-api/sso-config.js";
import { WorkforceSsoService } from "../../../src/console-api/sso.js";
import { AesGcmTokenSealer } from "../../../src/console-api/token-sealer.js";
import { createMemoryLogger } from "../../../src/observability/logger.js";
import { systemClock } from "../../../src/shared/clock.js";
import { createIntegrationDb } from "../_harness/clients.js";
import type { IntegrationDb } from "../_harness/clients.js";
import { Keycloak } from "../_harness/keycloak.js";
import { layer2, layer2Context } from "../_harness/layer2.js";
import { Browser, CLIENT_ROLES_CLAIM, CONSOLE_REDIRECT, IDP_ORIGIN, IdpTlsProxy, createIdentityPki, liveOidc, newUser, realmName, realmRep, waitForRealm } from "./support.js";
import type { LiveOidc, TestPki } from "./support.js";

const SERVICES = ["keycloak", "postgres"];
const it = layer2(SERVICES);
const TENANT = "tnt_synthIdentityL2Reauthenticate";
const REALM = realmName("wfreauth");
const ISSUER = `${IDP_ORIGIN}/realms/${REALM}`;
const CLIENT = { clientId: "vsp-console", secret: randomBytes(24).toString("base64url"), redirectUri: CONSOLE_REDIRECT };
const MAX_AUTH_AGE_SECONDS = 30;
const operator = newUser("returning", ["/vsp/supervisor"]);

let kc: Keycloak;
let pki: TestPki;
let proxy: IdpTlsProxy;
let idb: IntegrationDb;
let oidc: LiveOidc;
let service: WorkforceSsoService;

describe("console workforce SSO: a returning operator in the same browser (max_age)", () => {
  beforeAll(async () => {
    const l2 = layer2Context(SERVICES);
    kc = new Keycloak(`https://localhost:${l2.port("keycloak", 8443)}`);
    pki = createIdentityPki();
    proxy = new IdpTlsProxy(pki, l2.port("keycloak", 8443));
    await proxy.start();
    await kc.createRealm(realmRep({ realm: REALM, client: CLIENT, users: [operator], groups: ["/vsp/supervisor"], groupClientRoles: { "/vsp/supervisor": "supervisor" } }));
    await kc.setAuthenticatorReference(REALM, "browser", "auth-username-password-form", "pwd");
    await kc.setAuthenticatorReference(REALM, "browser", "auth-otp-form", "otp");
    idb = await createIntegrationDb(l2);
    oidc = liveOidc({ pki, proxyPort: proxy.port, issuer: ISSUER, clientId: CLIENT.clientId, clientSecret: CLIENT.secret, clock: systemClock, groupsClaim: CLIENT_ROLES_CLAIM });
    await waitForRealm(oidc, ISSUER);
    const config = parseWorkforceSsoConfig({
      tenantId: TENANT,
      issuer: ISSUER,
      clientId: CLIENT.clientId,
      scopes: ["openid"],
      redirectUris: [CONSOLE_REDIRECT],
      groupsClaim: CLIENT_ROLES_CLAIM,
      membershipSource: { kind: "CLIENT_ROLES" },
      groupRoles: { supervisor: "supervisor" },
      managedGroupPrefix: null,
      acceptedMfaAmr: null,
      maxAuthAgeSeconds: MAX_AUTH_AGE_SECONDS,
      loginTransactionTtlSeconds: 600,
      session: { ...DEFAULT_WORKFORCE_SESSION },
      sessionParametersApprovalId: null,
    });
    service = new WorkforceSsoService({
      config,
      oidc: oidc.client,
      directory: new OidcGroupStaffDirectory(config),
      verifier: WorkforceTokenVerifier.withKeys({ issuer: ISSUER, audience: CLIENT.clientId, keys: oidc.discovery.keyResolver(), clock: systemClock, acceptedMfaAmr: config.acceptedMfaAmr, algorithms: ["RS256", "ES256"] }),
      sessions: new PgConsoleSessionStore(idb.db),
      sealer: new AesGcmTokenSealer({ current: { id: "l2-reauth-sealer-1", key: randomBytes(32) } }),
      audit: new PgAuditWriter({ db: idb.db, clock: systemClock, stream: "console.l2-reauth", standaloneRole: "app_console" }),
      clock: systemClock,
      logger: createMemoryLogger().logger,
    });
  }, 180_000);

  afterAll(async () => {
    await kc?.deleteRealm(REALM);
    await proxy?.stop();
    await idb?.drop();
    pki?.dispose();
  });

  it("[FO-01-09][FO-05-41][FO-05-09] one browser, an IdP session older than maxAuthAgeSeconds: the IdP re-authenticates (max_age) and the second sign-in succeeds with a fresh auth_time; within the bound the SSO session answers without forms (verifier probe E)", async () => {
    const browser = new Browser(pki, proxy); // ONE user agent: it keeps Keycloak's SSO cookie like a real browser
    const signIn = async () => {
      const verifier = randomBytes(48).toString("base64url");
      const start = await service.start({ redirectUri: CONSOLE_REDIRECT, codeChallenge: s256Challenge(verifier) });
      const maxAge = new URL(start.authorizationUrl).searchParams.get("max_age");
      const back = await browser.signIn(start.authorizationUrl, operator, CONSOLE_REDIRECT);
      if ("refused" in back) throw new Error(`IDP_REFUSED_LOGIN: ${back.refused}`);
      const forms = browser.formsSubmitted;
      const out = await service.exchange({ code: back.code, state: back.state, codeVerifier: verifier, redirectUri: CONSOLE_REDIRECT, correlationId: "cor_synthIdentityL2Reauth01" });
      const row = await idb.db.query<{ authenticated_at: Date }>("select authenticated_at from console_sessions where session_hash = $1", [consoleSessionHash(out.token)]);
      return { out, forms, maxAge, authenticatedAt: new Date(row.rows[0]?.authenticated_at ?? 0).getTime() };
    };
    const first = await signIn();
    expect(first.forms).toBeGreaterThanOrEqual(2); // password and TOTP
    expect(first.out.roles).toEqual(["supervisor"]);
    // The IdP session is now older than maxAuthAgeSeconds plus the adapter's 5 s clock tolerance (real time: Keycloak
    // judges max_age by its own clock, the adapter judges auth_time by the backend's).
    await new Promise((r) => setTimeout(r, (MAX_AUTH_AGE_SECONDS + 10) * 1000));
    // Without max_age the IdP would silently hand back a code with the OLD auth_time and this exchange would refuse
    // it (401 OIDC_AUTH_TOO_OLD) after spending the code.
    const second = await signIn();
    for (const s of [first, second]) expect(s.maxAge).toBe(String(MAX_AUTH_AGE_SECONDS));
    expect(second.forms, "the IdP asked for the credentials again").toBeGreaterThanOrEqual(1);
    expect(second.authenticatedAt - first.authenticatedAt).toBeGreaterThanOrEqual(MAX_AUTH_AGE_SECONDS * 1000);
    expect(second.out.roles).toEqual(["supervisor"]);
    // Inside the bound, the same browser's SSO session answers at once (no form) and the exchange accepts it.
    const third = await signIn();
    expect(third.forms).toBe(0);
    expect(third.authenticatedAt).toBe(second.authenticatedAt);
  }, 120_000);
});
