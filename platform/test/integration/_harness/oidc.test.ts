/**
 * Layer 2, FO-16-13: Keycloak with client, provider and workforce realms (created per run through the
 * admin API, synthetic users, generated passwords) and the platform's three live token verifiers
 * tested against it over HTTPS (no loopback exception, the checkout's local CA):
 *   - JwksOidcVerifier: caller and provider ID tokens from the authorization-code flow (PKCE, nonce);
 *   - WorkforceTokenVerifier.remoteJwks: console access tokens, MFA required (TOTP enrolled and used);
 *   - JwtAccessTokenAuthenticator: integration client-credentials tokens with scope-to-channel mapping.
 * Real IdP claim sets, MFA policies and amr values of a tenant stay NOT_RUN (io.vsp.not-emulated).
 */
import { decodeJwt } from "jose";
import { afterAll, beforeAll, describe, expect } from "vitest";
import { JwksOidcVerifier } from "../../../src/adapters/live/oidc-verifier.js";
import type { TrustedIssuer } from "../../../src/adapters/live/oidc-verifier.js";
import { WorkforceTokenVerifier } from "../../../src/console-api/auth.js";
import { JwtAccessTokenAuthenticator } from "../../../src/gateway/auth.js";
import { systemClock } from "../../../src/shared/clock.js";
import { newId } from "../../../src/shared/ids.js";
import { Keycloak, secret } from "./keycloak.js";
import type { RealmUser, TokenSet } from "./keycloak.js";
import { layer2, layer2Context } from "./layer2.js";

const it = layer2(["keycloak"]);
const REDIRECT = "http://127.0.0.1:9/callback";
const suffix = newId("rlm", 6).slice(4).toLowerCase().replace(/[^a-z0-9]/g, "x");
const REALMS = { client: `vsp-it-client-${suffix}`, provider: `vsp-it-provider-${suffix}`, workforce: `vsp-it-workforce-${suffix}` };
const CLIENT_APP = { clientId: "vsp-client-app", clientSecret: secret(), redirectUri: REDIRECT };
const PROVIDER_APP = { clientId: "vsp-provider-app", clientSecret: secret(), redirectUri: REDIRECT };
const CONSOLE = { clientId: "vsp-console", clientSecret: secret(), redirectUri: REDIRECT };
const INTEGRATION = { clientId: "vsp-integration-telephony", clientSecret: secret() };
/** A service client of the same realm whose tokens are minted for another audience. */
const OTHER_AUDIENCE = { clientId: "vsp-console-batch", clientSecret: secret() };

const users = {
  client: { username: "synthetic-client", password: secret() } as RealmUser,
  provider: { username: "synthetic-provider", password: secret() } as RealmUser,
  staff: { username: "synthetic-staff", password: secret() } as RealmUser,
};

let kc: Keycloak;

function syntheticUser(u: RealmUser, label: string, requiredActions: string[] = []) {
  return {
    username: u.username,
    enabled: true,
    email: `${u.username}@layer2.example.test`,
    emailVerified: true,
    firstName: "Synthetic",
    lastName: label,
    credentials: [{ type: "password", value: u.password, temporary: false }],
    requiredActions,
  };
}

function rpClient(c: { clientId: string; clientSecret: string }, mappers: unknown[] = []) {
  return {
    clientId: c.clientId,
    protocol: "openid-connect",
    publicClient: false,
    secret: c.clientSecret,
    redirectUris: [REDIRECT],
    standardFlowEnabled: true,
    directAccessGrantsEnabled: false,
    attributes: { "pkce.code.challenge.method": "S256" },
    protocolMappers: [{ name: "amr", protocol: "openid-connect", protocolMapper: "oidc-amr-mapper", config: { "id.token.claim": "true", "access.token.claim": "true" } }, ...mappers],
  };
}

const audienceMapper = (audience: string) => ({
  name: `aud-${audience}`,
  protocol: "openid-connect",
  protocolMapper: "oidc-audience-mapper",
  config: { "included.custom.audience": audience, "access.token.claim": "true", "id.token.claim": "false" },
});

const issuerOf = (realm: string): TrustedIssuer["issuer"] => kc.issuer(realm);
const trusted = (realm: string, audience: string): TrustedIssuer => ({ issuer: issuerOf(realm), audience, jwksUri: `${issuerOf(realm)}/protocol/openid-connect/certs` });
const callerVerifier = (issuers: TrustedIssuer[]) => new JwksOidcVerifier({ integrationId: "oidc-client-idp", issuers, clock: systemClock });

describe("Keycloak realms and the live token verifiers", () => {
  beforeAll(async () => {
    kc = new Keycloak(`https://localhost:${layer2Context(["keycloak"]).port("keycloak", 8443)}`);
    await kc.createRealm({ realm: REALMS.client, enabled: true, clients: [rpClient(CLIENT_APP)], users: [syntheticUser(users.client, "Client")] });
    await kc.createRealm({ realm: REALMS.provider, enabled: true, clients: [rpClient(PROVIDER_APP)], users: [syntheticUser(users.provider, "Provider")] });
    await kc.createRealm({
      realm: REALMS.workforce,
      enabled: true,
      clients: [
        rpClient(CONSOLE, [audienceMapper("vsp-console")]),
        {
          clientId: INTEGRATION.clientId,
          protocol: "openid-connect",
          publicClient: false,
          secret: INTEGRATION.clientSecret,
          standardFlowEnabled: false,
          serviceAccountsEnabled: true,
          protocolMappers: [audienceMapper("vsp-gateway-local")],
        },
        {
          clientId: OTHER_AUDIENCE.clientId,
          protocol: "openid-connect",
          publicClient: false,
          secret: OTHER_AUDIENCE.clientSecret,
          standardFlowEnabled: false,
          serviceAccountsEnabled: true,
          protocolMappers: [audienceMapper("vsp-console")],
        },
      ],
      users: [syntheticUser(users.staff, "Staff", ["CONFIGURE_TOTP"])],
    });
    await kc.addDefaultScope(REALMS.workforce, INTEGRATION.clientId, "vsp.telephony_control");
    // amr values the workforce realm emits: "pwd" for the password form, "otp" for the OTP form.
    await kc.setAuthenticatorReference(REALMS.workforce, "browser", "auth-username-password-form", "pwd");
    await kc.setAuthenticatorReference(REALMS.workforce, "browser", "auth-otp-form", "otp");
  });

  afterAll(async () => {
    if (!kc) return;
    for (const realm of Object.values(REALMS)) await kc.deleteRealm(realm);
  });

  it("[FO-16-13][AUTH-03] client realm: an ID token from the authorization-code flow verifies with the live JWKS verifier over HTTPS", async () => {
    const nonce = secret(16);
    const tokens = await kc.login(REALMS.client, CLIENT_APP, users.client, nonce);
    const verifier = callerVerifier([trusted(REALMS.client, CLIENT_APP.clientId)]);
    expect(verifier.kind).toBe("live");
    const claims = await verifier.verifyIdToken(tokens.id_token, { nonce, maxAuthAgeSeconds: 300 });
    expect(claims.issuer).toBe(issuerOf(REALMS.client));
    expect(claims.audience).toBe(CLIENT_APP.clientId);
    expect(claims.nonce).toBe(nonce);
    expect(claims.sub).toMatch(/^[0-9a-f-]{36}$/);
    expect(Math.abs(claims.authTime - Date.now() / 1000)).toBeLessThan(120);
    expect(await verifier.health()).toEqual({ healthy: true, reasonCode: null });
  });

  it("[FO-16-13][AUTH-01] provider realm tokens verify only where the provider issuer is trusted; nonce, audience and signature are enforced", async () => {
    const nonce = secret(16);
    const provider: TokenSet = await kc.login(REALMS.provider, PROVIDER_APP, users.provider, nonce);
    const clientOnly = callerVerifier([trusted(REALMS.client, CLIENT_APP.clientId)]);
    await expect(clientOnly.verifyIdToken(provider.id_token, { nonce, maxAuthAgeSeconds: 300 })).rejects.toMatchObject({ reasonCode: "OIDC_ISSUER_NOT_TRUSTED" });
    const both = callerVerifier([trusted(REALMS.client, CLIENT_APP.clientId), trusted(REALMS.provider, PROVIDER_APP.clientId)]);
    expect((await both.verifyIdToken(provider.id_token, { nonce, maxAuthAgeSeconds: 300 })).issuer).toBe(issuerOf(REALMS.provider));
    await expect(both.verifyIdToken(provider.id_token, { nonce: secret(16), maxAuthAgeSeconds: 300 })).rejects.toMatchObject({ reasonCode: "OIDC_NONCE_MISMATCH" });
    const wrongAudience = callerVerifier([trusted(REALMS.provider, "some-other-app")]);
    await expect(wrongAudience.verifyIdToken(provider.id_token, { nonce, maxAuthAgeSeconds: 300 })).rejects.toMatchObject({ reasonCode: "OIDC_AUDIENCE_MISMATCH" });
    const [h, p, s] = provider.id_token.split(".");
    const tampered = `${h}.${p}.${(s ?? "").slice(0, -4)}${(s ?? "").endsWith("AAAA") ? "BBBB" : "AAAA"}`;
    await expect(both.verifyIdToken(tampered, { nonce, maxAuthAgeSeconds: 300 })).rejects.toMatchObject({ reasonCode: "OIDC_SIGNATURE_INVALID" });
  });

  it("[FO-16-13][AUTH-03] workforce realm: the live console verifier refuses a password-only session and accepts the TOTP-backed one", async () => {
    const issuer = issuerOf(REALMS.workforce);
    const verifier = WorkforceTokenVerifier.remoteJwks({ issuer, audience: "vsp-console", jwksUrl: `${issuer}/protocol/openid-connect/certs`, clock: systemClock });
    expect(verifier.kind).toBe("live");
    // First login enrols TOTP (required action); the session itself was password-only.
    const enrolment = await kc.login(REALMS.workforce, CONSOLE, users.staff, secret(16));
    expect(users.staff.totpSecret).toBeTruthy();
    const enrolmentClaims = decodeJwt(enrolment.access_token);
    expect({ aud: enrolmentClaims.aud, amr: enrolmentClaims.amr, hasJti: typeof enrolmentClaims.jti, hasAuthTime: typeof enrolmentClaims.auth_time }).toEqual({ aud: "vsp-console", amr: ["pwd"], hasJti: "string", hasAuthTime: "number" });
    expect(decodeJwt(enrolment.id_token).amr).toEqual(["pwd"]);
    await expect(verifier.verify(enrolment.access_token)).rejects.toMatchObject({ status: 401, reasonCode: "STAFF_MFA_REQUIRED" });
    const mfa = await kc.login(REALMS.workforce, CONSOLE, users.staff, secret(16));
    const staff = await verifier.verify(mfa.access_token);
    expect(staff.issuer).toBe(issuer);
    expect(staff.amr).toContain("otp");
    expect(staff.localFixture).toBe(false);
    const clientToken = await kc.login(REALMS.client, CLIENT_APP, users.client, secret(16));
    await expect(verifier.verify(clientToken.access_token)).rejects.toMatchObject({ status: 401 });
  });

  it("[FO-16-13][AUTH-03] integration client-credentials tokens map scope to channel in the live gateway authenticator", async () => {
    const issuer = issuerOf(REALMS.workforce);
    const tenantId = newId("tnt");
    const auth = new JwtAccessTokenAuthenticator(
      {
        environment: "local",
        tenantId,
        issuer,
        audience: "vsp-gateway-local",
        jwksUri: `${issuer}/protocol/openid-connect/certs`,
        algorithms: ["RS256"],
        clockToleranceSeconds: 5,
        maxTokenAgeSeconds: 600,
        clientIdClaim: "azp",
        clients: [{ clientId: INTEGRATION.clientId, integrationId: "telephony-it", credentialId: "cred-layer2-01", channels: ["telephony_control"] }],
        scopeToChannel: { "vsp.telephony_control": "telephony_control" },
      },
      { clock: systemClock },
    );
    const token = await kc.clientCredentials(REALMS.workforce, INTEGRATION.clientId, INTEGRATION.clientSecret);
    expect(token.scope ?? "").toContain("vsp.telephony_control");
    const identity = await auth.authenticate(`Bearer ${token.access_token}`, "telephony_control");
    expect(identity).toMatchObject({ integrationId: "telephony-it", tenantId, channel: "telephony_control", authMethod: "oauth2_client_credentials" });
    await expect(auth.authenticate(`Bearer ${token.access_token}`, "mcp_tools")).rejects.toMatchObject({ reasonCode: "INTEGRATION_CHANNEL_NOT_ALLOWED" });
    const otherAudience = await kc.clientCredentials(REALMS.workforce, OTHER_AUDIENCE.clientId, OTHER_AUDIENCE.clientSecret);
    await expect(auth.authenticate(`Bearer ${otherAudience.access_token}`, "telephony_control")).rejects.toMatchObject({ reasonCode: "INTEGRATION_TOKEN_AUDIENCE_INVALID" });
    // A token of another realm is signed with keys this issuer never published.
    const foreign = await kc.login(REALMS.client, CLIENT_APP, users.client, secret(16));
    await expect(auth.authenticate(`Bearer ${foreign.access_token}`, "telephony_control")).rejects.toMatchObject({ reasonCode: "INTEGRATION_TOKEN_KEY_UNKNOWN" });
    await expect(auth.authenticate(undefined, "telephony_control")).rejects.toMatchObject({ reasonCode: "INTEGRATION_CREDENTIAL_MISSING" });
  });
});
