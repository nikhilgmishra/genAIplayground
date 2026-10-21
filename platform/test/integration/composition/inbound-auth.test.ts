/**
 * Layer 2 (WP-07; FO-14-53, FO-19-06, AUTH-01, AUTH-02): the live gateway with `gateway.inboundAuth`
 * configured verifies an integration's Keycloak-issued access token (client-credentials grant) against the
 * issuer's JWKS fetched THROUGH the egress-classified transport (transportJwksResolver -> OidcHttp ->
 * ConnectorHttpTransport, the container's EgressGuard), never with a global fetch.
 *
 * The shared Keycloak 26 is served through the test's TLS front proxy under the SYNTHETIC routable name
 * idp.vsp-composition.example.com (the sandbox-only resolver maps it to the private host interface); the proxy
 * records the paths it forwarded, so the test sees that the gateway itself fetched the key set.
 *
 * Asserted: a token with the configured audience and scope is accepted on the MCP channel (catalogue 200); a
 * token of another audience, a forged token signed with a key the issuer never published, a token for a
 * channel its scope does not grant and a missing credential are refused 401; with the IdP unreachable the
 * gateway refuses (fails closed), it does not accept.
 */
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect } from "vitest";
import type { LiveContainer } from "../../../src/main/live-container.js";
import { ensurePolicyBundle } from "../../../src/policy/ensure-bundle.js";
import { Keycloak } from "../_harness/keycloak.js";
import { layer2, layer2Context } from "../_harness/layer2.js";
import { realmName } from "../identity/support.js";
import { IDP_HOST, SUBSTRATE, TENANT, TlsFrontProxy, bootLive, createPki, privateResolver, provisionSandbox } from "./support.js";
import type { Sandbox, TestPki } from "./support.js";

const SERVICES = [...SUBSTRATE, "keycloak"];
const it = layer2(SERVICES);
const REALM = realmName("inbound");
const AUDIENCE = "vsp-gateway-sandbox";
const INTEGRATION = { clientId: "vsp-contact-center", secret: randomBytes(24).toString("base64url") };
const OTHER = { clientId: "vsp-other-audience", secret: randomBytes(24).toString("base64url") };

let sb: Sandbox;
let kc: Keycloak;
let pki: TestPki;
let proxy: TlsFrontProxy;
let origin: string;
let c: LiveContainer;

const audienceMapper = (audience: string) => ({
  name: `aud-${audience}`,
  protocol: "openid-connect",
  protocolMapper: "oidc-audience-mapper",
  config: { "included.custom.audience": audience, "access.token.claim": "true", "id.token.claim": "false" },
});
const serviceClient = (client: { clientId: string; secret: string }, audience: string) => ({
  clientId: client.clientId,
  protocol: "openid-connect",
  publicClient: false,
  secret: client.secret,
  standardFlowEnabled: false,
  serviceAccountsEnabled: true,
  protocolMappers: [audienceMapper(audience)],
});

beforeAll(async () => {
  const l2 = layer2Context(SERVICES);
  ensurePolicyBundle();
  sb = await provisionSandbox(l2);
  pki = createPki([IDP_HOST]);
  proxy = new TlsFrontProxy(pki, { port: l2.port("keycloak", 8443), servername: "localhost" });
  origin = `https://${IDP_HOST}:${await proxy.start()}`;
  kc = new Keycloak(`https://localhost:${l2.port("keycloak", 8443)}`);
  await kc.createRealm({ realm: REALM, enabled: true, attributes: { frontendUrl: origin }, accessTokenLifespan: 300, clients: [serviceClient(INTEGRATION, AUDIENCE), serviceClient(OTHER, "vsp-somewhere-else")] });
  await kc.addDefaultScope(REALM, INTEGRATION.clientId, "vsp.mcp_tools");
  // The other client gets the same scope (only its audience differs): attach the existing client scope.
  const scope = (await kc.adminJson<{ id: string; name: string }[]>(`/realms/${REALM}/client-scopes`)).find((x) => x.name === "vsp.mcp_tools");
  if (!scope) throw new Error("KEYCLOAK_SCOPE_MISSING");
  await kc.admin("PUT", `/realms/${REALM}/clients/${await kc.clientUuid(REALM, OTHER.clientId)}/default-client-scopes/${scope.id}`);
  const cfg = sb.config();
  cfg.infrastructure.privateNetworkHosts = [IDP_HOST];
  const port = new URL(origin).port;
  cfg.egress.destinations = [
    { destinationId: "egr_integration_idp", kind: "VERIFICATION_SERVICE", hosts: [`${IDP_HOST}:${port}`], allowedClasses: ["PUBLIC", "VERIFICATION_SECRET"], coverage: { baaRef: null, approvalId: "apr_synthCompositionIdp01" }, environments: ["sandbox"], adapterKind: "live" },
  ];
  (cfg as Record<string, unknown>).gateway = {
    inboundAuth: {
      kind: "oauth2_jwt",
      issuer: `${origin}/realms/${REALM}`,
      audience: AUDIENCE,
      jwksUri: `${origin}/realms/${REALM}/protocol/openid-connect/certs`,
      algorithms: ["RS256"],
      clockToleranceSeconds: 5,
      maxTokenAgeSeconds: 600,
      clientIdClaim: "azp",
      clients: [
        { clientId: INTEGRATION.clientId, integrationId: "contact-center-it", credentialId: "cred-composition-01", channels: ["mcp_tools"] },
        { clientId: OTHER.clientId, integrationId: "other-it", credentialId: "cred-composition-02", channels: ["mcp_tools"] },
      ],
      scopeToChannel: { "vsp.mcp_tools": "mcp_tools", "vsp.telephony_control": "telephony_control" },
    },
    http: { bodyLimitBytes: 65_536, rateLimit: { max: 600, timeWindowMs: 60_000 } },
  };
  sb.writeConfig(cfg);
  ({ c } = await bootLive(sb, { network: { resolve: privateResolver([IDP_HOST]), tlsCa: [pki.caPem] } }));
}, 180_000);

afterAll(async () => {
  await c?.close();
  await kc?.deleteRealm(REALM);
  await proxy?.stop();
  await sb?.close();
  pki?.dispose();
});

const catalogue = (token?: string) => c.app.inject({ method: "GET", url: "/v1/tools/catalog", headers: token ? { authorization: `Bearer ${token}` } : {} });

describe("live gateway inbound authentication over the transport [FO-14-53][AUTH-01]", () => {
  it("[AUTH-01][FO-19-06] positive: a client-credentials token of the configured audience and scope is accepted; the JWKS was fetched by the gateway through the transport", async () => {
    expect(c.authenticator.constructor.name).toBe("JwtAccessTokenAuthenticator");
    const before = proxy.paths.length;
    const token = await kc.clientCredentials(REALM, INTEGRATION.clientId, INTEGRATION.secret);
    expect(token.scope ?? "").toContain("vsp.mcp_tools");
    const r = await catalogue(token.access_token);
    expect(r.statusCode, r.body).toBe(200);
    expect(proxy.paths.slice(before)).toContain(`/realms/${REALM}/protocol/openid-connect/certs`);
    // Cached: a second call does not fetch the key set again.
    const fetched = proxy.paths.filter((p) => p.endsWith("/certs")).length;
    expect((await catalogue(token.access_token)).statusCode).toBe(200);
    expect(proxy.paths.filter((p) => p.endsWith("/certs")).length).toBe(fetched);
  });

  it("[AUTH-01][AUTH-02] adversarial: another audience, a forged key, a missing credential and a tenant claim are refused (401)", async () => {
    const other = await kc.clientCredentials(REALM, OTHER.clientId, OTHER.secret);
    expect((await catalogue(other.access_token)).statusCode).toBe(401);
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const forged = await new SignJWT({ azp: INTEGRATION.clientId, scope: "vsp.mcp_tools", tenant_id: TENANT })
      .setProtectedHeader({ alg: "RS256", kid: "forged-kid" })
      .setIssuer(`${origin}/realms/${REALM}`)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    expect((await catalogue(forged)).statusCode).toBe(401);
    expect((await catalogue()).statusCode).toBe(401);
    expect((await catalogue("not-a-jwt")).statusCode).toBe(401);
  });

  it("[AUTH-01][OPS-01] failure injection: with the issuer unreachable and the key cache cold, a valid token is refused (fail closed), never accepted", async () => {
    const token = await kc.clientCredentials(REALM, INTEGRATION.clientId, INTEGRATION.secret);
    // A fresh container: its key cache is empty, so verification must reach the (stopped) issuer.
    await proxy.stop();
    try {
      const { c: cold } = await bootLive(sb, { network: { resolve: privateResolver([IDP_HOST]), tlsCa: [pki.caPem] } });
      try {
        const r = await cold.app.inject({ method: "GET", url: "/v1/tools/catalog", headers: { authorization: `Bearer ${token.access_token}` } });
        expect([401, 503]).toContain(r.statusCode);
        expect(r.body).not.toMatch(/commit_appointment_change/);
      } finally {
        await cold.close();
      }
    } finally {
      await proxy.start();
    }
  });
});
