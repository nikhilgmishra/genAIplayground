/**
 * RuntimeCredentialVerifier (WP-11; AUTH-03, AUTH-02): the conversation runtime's own OAuth2 access tokens, verified
 * against a local JWKS (jose createLocalJWKSet). The Layer-2 media suite verifies Keycloak-issued tokens through the
 * egress transport's JWKS resolver.
 */
import { generateKeyPairSync } from "node:crypto";
import { SignJWT, createLocalJWKSet, exportJWK } from "jose";
import type { JWK } from "jose";
import { describe, expect, it } from "vitest";
import { FakeClock } from "../../shared/clock.js";
import { RuntimeCredentialVerifier } from "./runtime-auth.js";
import type { RuntimeAuthConfig } from "./runtime-auth.js";

const clock = new FakeClock("2026-10-21T12:00:00.000Z");
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" } as JWK;
const getKey = createLocalJWKSet({ keys: [jwk] });

const cfg: RuntimeAuthConfig = {
  environment: "ci",
  tenantId: "tnt_synthTenantMedia0001",
  issuer: "https://idp.vsp.test/realms/media",
  audience: "vsp-gateway-ci",
  algorithms: ["RS256"],
  clockToleranceSeconds: 5,
  maxTokenAgeSeconds: 600,
  clientIdClaim: "azp",
  scope: "vsp.conversation_runtime",
  clients: [{ clientId: "vsp-media-runtime", integrationId: "vsp-media-runtime", credentialId: "cred-media-runtime-01", adapters: ["controlled_cascade_runtime"] }],
};

async function token(o: { azp?: string; scope?: string; aud?: string; iss?: string; key?: typeof privateKey; kid?: string; exp?: number } = {}) {
  const now = Math.floor(clock.now().getTime() / 1000);
  return new SignJWT({ azp: o.azp ?? "vsp-media-runtime", scope: o.scope ?? "openid vsp.conversation_runtime" })
    .setProtectedHeader({ alg: "RS256", kid: o.kid ?? "k1" })
    .setIssuer(o.iss ?? cfg.issuer)
    .setAudience(o.aud ?? cfg.audience)
    .setIssuedAt(now)
    .setExpirationTime(o.exp ?? now + 300)
    .sign(o.key ?? privateKey);
}

const verifier = new RuntimeCredentialVerifier(cfg, { clock, getKey });
const refusal = async (p: Promise<unknown>) => p.then(() => "NOT_REFUSED", (e: { reasonCode?: string }) => e.reasonCode ?? "UNKNOWN");

describe("RuntimeCredentialVerifier [AUTH-03]", () => {
  it("[AUTH-03] positive: a client-credentials token with the runtime scope yields the conversation_runtime identity", async () => {
    const id = await verifier.authenticate(`Bearer ${await token()}`);
    expect(id).toEqual({ integrationId: "vsp-media-runtime", tenantId: cfg.tenantId, environment: "ci", channel: "conversation_runtime", credentialId: "cred-media-runtime-01", authMethod: "oauth2_client_credentials", adapters: ["controlled_cascade_runtime"] });
  });

  it("[AUTH-03] adversarial: missing scope, unknown client, another audience or issuer, a forged key, expiry and a missing header are refused", async () => {
    expect(await refusal(verifier.authenticate(`Bearer ${await token({ scope: "vsp.telephony_control" })}`))).toBe("RUNTIME_SCOPE_MISSING");
    expect(await refusal(verifier.authenticate(`Bearer ${await token({ azp: "vsp-contact-center" })}`))).toBe("RUNTIME_CLIENT_UNKNOWN");
    expect(await refusal(verifier.authenticate(`Bearer ${await token({ aud: "vsp-gateway-production" })}`))).toBe("RUNTIME_CREDENTIAL_INVALID");
    expect(await refusal(verifier.authenticate(`Bearer ${await token({ iss: "https://idp.vsp.test/realms/other" })}`))).toBe("RUNTIME_CREDENTIAL_INVALID");
    expect(await refusal(verifier.authenticate(`Bearer ${await token({ key: other.privateKey })}`))).toBe("RUNTIME_CREDENTIAL_INVALID");
    expect(await refusal(verifier.authenticate(`Bearer ${await token({ exp: Math.floor(clock.now().getTime() / 1000) - 60 })}`))).toBe("RUNTIME_CREDENTIAL_EXPIRED");
    expect(await refusal(verifier.authenticate(undefined))).toBe("RUNTIME_CREDENTIAL_MISSING");
    expect(await refusal(verifier.authenticate("Basic dXNlcjpwYXNz"))).toBe("RUNTIME_CREDENTIAL_MISSING");
  });

  it("[OPS-04] there is no development bypass: a configuration without the required fields or a key resolver does not construct", () => {
    expect(() => new RuntimeCredentialVerifier({ ...cfg, issuer: "" } as RuntimeAuthConfig, { clock, getKey })).toThrow();
    expect(() => new RuntimeCredentialVerifier({ ...cfg, clients: [] }, { clock, getKey })).toThrow();
    expect(() => new RuntimeCredentialVerifier(cfg, { clock, getKey: undefined as unknown as typeof getKey })).toThrow();
  });
});
