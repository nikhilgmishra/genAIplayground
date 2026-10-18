import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import type { JWK } from "jose";

type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
import { beforeAll, describe, expect, it } from "vitest";
import { TENANT_ID } from "../fixtures/synthetic-world.js";
import { FakeClock } from "../shared/clock.js";
import { ConfigurationRejectedError } from "../shared/errors.js";
import {
  IntegrationAuthenticationError,
  JwtAccessTokenAuthenticator,
  LOCAL_FIXTURE_TOKENS,
  LocalFixtureTokenAuthenticator,
  assertAuthenticatorAllowed,
} from "./auth.js";
import type { JwtAuthenticatorConfig } from "./auth.js";

const reason = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "NO_ERROR";
  } catch (e) {
    return e instanceof IntegrationAuthenticationError ? e.reasonCode : "OTHER";
  }
};

describe("LocalFixtureTokenAuthenticator (LOCAL FIXTURE)", () => {
  it("[SPEC-8.service-identity] maps each synthetic token to exactly one channel; other channels are refused", async () => {
    const a = new LocalFixtureTokenAuthenticator({ environment: "local", tenantId: TENANT_ID });
    const id = await a.authenticate(`Bearer ${LOCAL_FIXTURE_TOKENS.mcp_tools}`, "mcp_tools");
    expect(id).toMatchObject({ channel: "mcp_tools", integrationId: "talkdesk-local", authMethod: "local_fixture", tenantId: TENANT_ID });
    expect(await reason(a.authenticate(`Bearer ${LOCAL_FIXTURE_TOKENS.mcp_tools}`, "telephony_control"))).toBe("INTEGRATION_CHANNEL_NOT_ALLOWED");
    expect(await reason(a.authenticate(`Bearer ${LOCAL_FIXTURE_TOKENS.telephony_control}`, "mcp_tools"))).toBe("INTEGRATION_CHANNEL_NOT_ALLOWED");
    expect(await reason(a.authenticate(undefined, "mcp_tools"))).toBe("INTEGRATION_CREDENTIAL_MISSING");
    expect(await reason(a.authenticate("Basic abc", "mcp_tools"))).toBe("INTEGRATION_CREDENTIAL_MISSING");
    expect(await reason(a.authenticate("Bearer local-fixture-wrong-token-000000", "mcp_tools"))).toBe("INTEGRATION_CREDENTIAL_INVALID");
  });

  it("[OPS-04] the fixture authenticator is refused outside local/ci", () => {
    for (const environment of ["sandbox", "staging", "production"] as const) {
      expect(() => new LocalFixtureTokenAuthenticator({ environment, tenantId: TENANT_ID })).toThrow(ConfigurationRejectedError);
    }
    const local = new LocalFixtureTokenAuthenticator({ environment: "ci", tenantId: TENANT_ID });
    expect(() => assertAuthenticatorAllowed(local, "production")).toThrow(ConfigurationRejectedError);
    expect(() => assertAuthenticatorAllowed(local, "ci")).not.toThrow();
  });
});

describe("JwtAccessTokenAuthenticator (live code path, verified against a LOCAL JWKS only)", () => {
  const clock = new FakeClock("2026-10-17T15:00:00.000Z");
  const now = () => Math.floor(clock.now().getTime() / 1000);
  let privateKey: SigningKey;
  let otherKey: SigningKey;
  let jwk: JWK;
  const config: JwtAuthenticatorConfig = {
    environment: "sandbox",
    tenantId: TENANT_ID,
    issuer: "https://auth.local.invalid/issuer",
    audience: "vsp-gateway-sandbox",
    jwksUri: null,
    algorithms: ["ES256"],
    clockToleranceSeconds: 30,
    maxTokenAgeSeconds: 3600,
    clientIdClaim: "client_id",
    clients: [
      { clientId: "talkdesk-mcp-client", integrationId: "talkdesk-sandbox", credentialId: "cred-td-mcp", channels: ["mcp_tools"] },
      { clientId: "talkdesk-studio-client", integrationId: "talkdesk-sandbox", credentialId: "cred-td-studio", channels: ["telephony_control"] },
    ],
    scopeToChannel: { "vsp.mcp_tools": "mcp_tools", "vsp.telephony_control": "telephony_control" },
  };
  let auth: JwtAccessTokenAuthenticator;

  beforeAll(async () => {
    const kp = await generateKeyPair("ES256");
    privateKey = kp.privateKey;
    otherKey = (await generateKeyPair("ES256")).privateKey;
    jwk = { ...(await exportJWK(kp.publicKey)), kid: "local-test-kid", alg: "ES256" };
    auth = new JwtAccessTokenAuthenticator(config, { clock, getKey: createLocalJWKSet({ keys: [jwk] }) });
  });

  const token = (claims: Record<string, unknown> = {}, opts: { key?: SigningKey; kid?: string; alg?: string; iat?: number; exp?: number } = {}) =>
    new SignJWT({ client_id: "talkdesk-mcp-client", scope: "vsp.mcp_tools", ...claims })
      .setProtectedHeader({ alg: opts.alg ?? "ES256", kid: opts.kid ?? "local-test-kid" })
      .setIssuer((claims.iss as string) ?? config.issuer)
      .setAudience((claims.aud as string) ?? config.audience)
      .setIssuedAt(opts.iat ?? now())
      .setExpirationTime(opts.exp ?? now() + 300)
      .sign(opts.key ?? privateKey);

  it("[SPEC-8.oauth2] a valid client-credentials token maps to the registered integration and the scoped channel", async () => {
    const id = await auth.authenticate(`Bearer ${await token()}`, "mcp_tools");
    expect(id).toEqual({ integrationId: "talkdesk-sandbox", tenantId: TENANT_ID, environment: "sandbox", channel: "mcp_tools", credentialId: "cred-td-mcp", authMethod: "oauth2_client_credentials" });
  });

  it("[SPEC-8.oauth2] wrong channel scope, client not allowed the channel, and unknown clients are rejected", async () => {
    expect(await reason(auth.authenticate(`Bearer ${await token()}`, "telephony_control"))).toBe("INTEGRATION_CHANNEL_NOT_ALLOWED");
    expect(await reason(auth.authenticate(`Bearer ${await token({ scope: "vsp.telephony_control" })}`, "telephony_control"))).toBe("INTEGRATION_CHANNEL_NOT_ALLOWED");
    expect(await reason(auth.authenticate(`Bearer ${await token({ client_id: "unknown-client" })}`, "mcp_tools"))).toBe("INTEGRATION_CLIENT_UNKNOWN");
  });

  it("[SPEC-8.oauth2] issuer, audience (environment separation), expiry and clock tolerance are enforced", async () => {
    expect(await reason(auth.authenticate(`Bearer ${await token({ iss: "https://evil.local.invalid" })}`, "mcp_tools"))).toBe("INTEGRATION_TOKEN_ISSUER_INVALID");
    expect(await reason(auth.authenticate(`Bearer ${await token({ aud: "vsp-gateway-production" })}`, "mcp_tools"))).toBe("INTEGRATION_TOKEN_AUDIENCE_INVALID");
    expect(await reason(auth.authenticate(`Bearer ${await token({}, { exp: now() - 120 })}`, "mcp_tools"))).toBe("INTEGRATION_TOKEN_EXPIRED");
    // Within the configured tolerance an expired-by-10s token is still accepted.
    expect(await reason(auth.authenticate(`Bearer ${await token({}, { exp: now() - 10 })}`, "mcp_tools"))).toBe("NO_ERROR");
    expect(await reason(auth.authenticate(`Bearer ${await token({}, { iat: now() - 7200, exp: now() + 60 })}`, "mcp_tools"))).toBe("INTEGRATION_TOKEN_TOO_OLD");
  });

  it("[SPEC-8.oauth2] signatures from an unknown key, unknown kids and non-allowlisted algorithms are rejected", async () => {
    expect(await reason(auth.authenticate(`Bearer ${await token({}, { key: otherKey })}`, "mcp_tools"))).toBe("INTEGRATION_TOKEN_SIGNATURE_INVALID");
    expect(await reason(auth.authenticate(`Bearer ${await token({}, { kid: "other-kid" })}`, "mcp_tools"))).toBe("INTEGRATION_TOKEN_KEY_UNKNOWN");
    const unsigned = `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${Buffer.from(JSON.stringify({ client_id: "talkdesk-mcp-client", scope: "vsp.mcp_tools", iss: config.issuer, aud: config.audience, exp: now() + 60, iat: now() })).toString("base64url")}.`;
    expect(await reason(auth.authenticate(`Bearer ${unsigned}`, "mcp_tools"))).not.toBe("NO_ERROR");
  });

  it("[SPEC-8.oauth2] configuration is strict: http JWKS outside loopback and unmapped channels are refused", () => {
    expect(() => new JwtAccessTokenAuthenticator({ ...config, jwksUri: "http://auth.example.invalid/jwks" }, { clock })).toThrow(/JWKS_URI_NOT_HTTPS/);
    expect(() => new JwtAccessTokenAuthenticator({ ...config, scopeToChannel: { "vsp.mcp_tools": "mcp_tools" } }, { clock, getKey: createLocalJWKSet({ keys: [jwk] }) })).toThrow(/CHANNEL_WITHOUT_SCOPE/);
    expect(() => new JwtAccessTokenAuthenticator({ ...config, algorithms: ["HS256" as never] }, { clock })).toThrow(/CONFIG_INVALID/);
  });
});
