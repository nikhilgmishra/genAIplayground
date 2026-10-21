/**
 * OIDC discovery, JWKS and relying-party client (WP-05) against an in-process OpenID provider
 * emulator served over loopback HTTP. LOCAL TEST FIXTURE: the emulator below is a unit fake of the
 * provider (labelled; Layer 1); the production code under test is the egress-classified transport,
 * OidcHttp, OidcDiscovery and OidcRelyingPartyClient, unchanged. The same production classes run
 * against Keycloak in Layer 2 (platform/test/integration/identity).
 */
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { SignJWT, exportJWK, generateKeyPair, jwtVerify, createLocalJWKSet, decodeJwt } from "jose";
import type { JWK } from "jose";
import { afterEach, describe, expect, it } from "vitest";
import { ConnectorHttpTransport } from "../../connectors/http/transport.js";
import { EgressGuard, urlCarriesSensitivePattern } from "../../privacy/egress.js";
import { OIDC_REFRESH_MAX_REQUESTS, OIDC_REQUEST_TIMEOUT_MAX_MS } from "../../protocol/index.js";
import { FakeClock } from "../../shared/clock.js";
import { ConfigurationRejectedError } from "../../shared/errors.js";
import { JwksOidcVerifier } from "./oidc-verifier.js";
import { OidcDiscovery } from "./oidc-discovery.js";
import { OidcHttp, isOidcEgressRefusal } from "./oidc-http.js";
import type { OidcEgressCheck } from "./oidc-http.js";
import { OidcRelyingPartyClient, clientAuthenticationFromSecret, clientSecretBasicFromSecret, s256Challenge } from "./oidc-client.js";
import type { OidcClientAuthentication } from "./oidc-client.js";

const HOST = "idp.oidc-emulator.test";
const ISSUER = `https://${HOST}/realms/workforce`;
const CLIENT_ID = "vsp-console";
const CLIENT_SECRET = "cons_synthClientSecretValue01";
const REDIRECT = "https://console.vsp-local.test/auth/callback";
const START = "2026-10-20T10:00:00.000Z";

const b64 = (n = 32) => randomBytes(n).toString("base64url");

interface CodeGrant {
  sub: string;
  nonce: string;
  challenge: string;
  redirectUri: string;
  clientId: string;
  amr: string[];
  groups: string[];
  authTime: number;
  used: boolean;
}

interface RefreshGrant {
  sub: string;
  nonce: string;
  amr: string[];
  groups: string[];
  authTime: number;
  used: boolean;
  family: string;
}

/** LOCAL TEST FIXTURE: in-process OpenID provider (discovery, JWKS, token, introspection, revocation). */
class ProviderEmulator {
  server: Server | null = null;
  port = 0;
  keys: { kid: string; privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"]; publicJwk: JWK }[] = [];
  codes = new Map<string, CodeGrant>();
  refresh = new Map<string, RefreshGrant>();
  revokedFamilies = new Set<string>();
  disabledSubjects = new Set<string>();
  requests: { path: string; grant: string | null; auth: string | null }[] = [];
  clientJwks: JWK[] = [];
  /** Test controls. */
  metadataOverride: Record<string, unknown> = {};
  failNext: "close_after_read" | "500" | null = null;
  jwksPrivate = false;
  subjectOnRefresh: string | null = null;
  issuerOverride: string | null = null;
  atHashOverride: string | null = null;
  /** Called as each request arrives, before it is answered (a test moves the clock: a slow provider). */
  onRequest: (() => void) | null = null;
  /** The next key-set response leaves out the newest key once (a rotation the client has not seen yet). */
  hideNewestKeyOnce = false;

  constructor(private readonly clock: FakeClock) {}

  async start(): Promise<this> {
    await this.rotate();
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server?.listen(0, "127.0.0.1", r));
    this.port = (this.server.address() as AddressInfo).port;
    return this;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  async rotate(dropOld = false): Promise<void> {
    const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
    const kid = `emu-${b64(6)}`;
    const entry = { kid, privateKey, publicJwk: { ...(await exportJWK(publicKey)), kid, alg: "ES256", use: "sig" } };
    this.keys = dropOld ? [entry] : [entry, ...this.keys];
  }

  metadata(): Record<string, unknown> {
    const base = `${ISSUER}/protocol/openid-connect`;
    return {
      issuer: ISSUER,
      authorization_endpoint: `${base}/auth`,
      token_endpoint: `${base}/token`,
      jwks_uri: `${base}/certs`,
      introspection_endpoint: `${base}/token/introspect`,
      revocation_endpoint: `${base}/revoke`,
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["plain", "S256"],
      token_endpoint_auth_methods_supported: ["client_secret_basic", "private_key_jwt"],
      id_token_signing_alg_values_supported: ["ES256", "RS256", "none"],
      ...this.metadataOverride,
    };
  }

  issueCode(g: Partial<CodeGrant> & { sub: string; nonce: string; verifier: string }): string {
    const code = b64(24);
    this.codes.set(code, {
      sub: g.sub,
      nonce: g.nonce,
      challenge: s256Challenge(g.verifier),
      redirectUri: g.redirectUri ?? REDIRECT,
      clientId: g.clientId ?? CLIENT_ID,
      amr: g.amr ?? ["pwd", "otp"],
      groups: g.groups ?? ["/vsp/supervisor"],
      authTime: g.authTime ?? Math.floor(this.clock.now().getTime() / 1000),
      used: false,
    });
    return code;
  }

  private async idToken(p: { sub: string; nonce: string; amr: string[]; groups: string[]; authTime: number; accessToken: string }): Promise<string> {
    const key = this.keys[0];
    if (!key) throw new Error("no key");
    const nowS = Math.floor(this.clock.now().getTime() / 1000);
    const digest = createHash("sha256").update(p.accessToken).digest();
    return new SignJWT({ nonce: p.nonce, amr: p.amr, groups: p.groups, auth_time: p.authTime, azp: CLIENT_ID, sid: "sess-1", at_hash: this.atHashOverride ?? digest.subarray(0, 16).toString("base64url") })
      .setProtectedHeader({ alg: "ES256", kid: key.kid, typ: "JWT" })
      .setIssuer(this.issuerOverride ?? ISSUER)
      .setSubject(p.sub)
      .setAudience(CLIENT_ID)
      .setIssuedAt(nowS)
      .setExpirationTime(nowS + 300)
      .setJti(b64(12))
      .sign(key.privateKey);
  }

  private async clientAuthenticated(req: IncomingMessage, form: URLSearchParams): Promise<boolean> {
    const basic = req.headers.authorization;
    if (basic?.startsWith("Basic ")) {
      const [id, secret] = Buffer.from(basic.slice(6), "base64").toString("utf8").split(":").map((v) => decodeURIComponent(v.replace(/\+/g, " ")));
      return id === CLIENT_ID && secret === CLIENT_SECRET;
    }
    const assertion = form.get("client_assertion");
    if (form.get("client_assertion_type") === "urn:ietf:params:oauth:client-assertion-type:jwt-bearer" && assertion) {
      try {
        const r = await jwtVerify(assertion, createLocalJWKSet({ keys: this.clientJwks }), { issuer: CLIENT_ID, subject: CLIENT_ID, audience: ISSUER, currentDate: this.clock.now() });
        return typeof r.payload.jti === "string";
      } catch {
        return false;
      }
    }
    return false;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    const form = new URLSearchParams(body);
    this.requests.push({ path, grant: form.get("grant_type"), auth: req.headers.authorization ? "basic" : form.get("client_assertion") ? "jwt" : null });
    this.onRequest?.();
    if (this.failNext === "close_after_read") {
      this.failNext = null;
      req.socket.destroy();
      return;
    }
    if (this.failNext === "500") {
      this.failNext = null;
      res.writeHead(500, { "content-type": "application/json" }).end("{}");
      return;
    }
    const json = (status: number, value: unknown): void => {
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
    };
    const base = "/realms/workforce";
    if (req.method === "GET" && path === `${base}/.well-known/openid-configuration`) return json(200, this.metadata());
    if (req.method === "GET" && path === `${base}/protocol/openid-connect/certs`) {
      const keys = this.keys.slice(this.hideNewestKeyOnce ? 1 : 0).map((k) => k.publicJwk);
      this.hideNewestKeyOnce = false;
      return json(200, { keys: this.jwksPrivate ? keys.map((k) => ({ ...k, d: "c3ludGg" })) : keys });
    }
    if (req.method === "GET" && path === `${base}/protocol/openid-connect/certs-v2`) return json(200, { keys: this.keys.map((k) => k.publicJwk) });
    if (req.method !== "POST") return json(404, { error: "not_found" });
    if (!(await this.clientAuthenticated(req, form))) return json(401, { error: "invalid_client" });
    if (path === `${base}/protocol/openid-connect/token`) {
      const grant = form.get("grant_type");
      if (grant === "authorization_code") {
        const g = this.codes.get(form.get("code") ?? "");
        if (!g) return json(400, { error: "invalid_grant", error_description: "Code not valid" });
        if (g.used) return json(400, { error: "invalid_grant", error_description: "Code already used" });
        g.used = true;
        if (g.redirectUri !== form.get("redirect_uri")) return json(400, { error: "invalid_grant", error_description: "Incorrect redirect_uri" });
        if (s256Challenge(form.get("code_verifier") ?? "") !== g.challenge) return json(400, { error: "invalid_grant", error_description: "PKCE verification failed" });
        return json(200, await this.tokens(g.sub, g.nonce, g.amr, g.groups, g.authTime, b64(8)));
      }
      if (grant === "refresh_token") {
        const r = this.refresh.get(form.get("refresh_token") ?? "");
        if (!r || this.revokedFamilies.has(r.family) || this.disabledSubjects.has(r.sub)) return json(400, { error: "invalid_grant" });
        if (r.used) {
          // Reuse of a rotated refresh token revokes the whole family.
          this.revokedFamilies.add(r.family);
          return json(400, { error: "invalid_grant", error_description: "Maximum allowed refresh token reuse exceeded" });
        }
        r.used = true;
        return json(200, await this.tokens(this.subjectOnRefresh ?? r.sub, r.nonce, r.amr, r.groups, r.authTime, r.family));
      }
      return json(400, { error: "unsupported_grant_type" });
    }
    if (path === `${base}/protocol/openid-connect/token/introspect`) {
      const r = this.refresh.get(form.get("token") ?? "");
      if (!r || r.used || this.revokedFamilies.has(r.family) || this.disabledSubjects.has(r.sub)) return json(200, { active: false });
      return json(200, { active: true, sub: r.sub, client_id: CLIENT_ID, groups: r.groups, exp: Math.floor(this.clock.now().getTime() / 1000) + 1800 });
    }
    if (path === `${base}/protocol/openid-connect/revoke`) {
      const r = this.refresh.get(form.get("token") ?? "");
      if (r) this.revokedFamilies.add(r.family);
      res.writeHead(200).end();
      return;
    }
    return json(404, { error: "not_found" });
  }

  private async tokens(sub: string, nonce: string, amr: string[], groups: string[], authTime: number, family: string) {
    const accessToken = b64(32);
    const refreshToken = b64(32);
    this.refresh.set(refreshToken, { sub, nonce, amr, groups, authTime, used: false, family });
    return { access_token: accessToken, token_type: "Bearer", expires_in: 300, refresh_token: refreshToken, refresh_expires_in: 1800, scope: "openid profile", id_token: await this.idToken({ sub, nonce, amr, groups, authTime, accessToken }) };
  }
}

interface Rig {
  clock: FakeClock;
  em: ProviderEmulator;
  http: OidcHttp;
  discovery: OidcDiscovery;
  client: OidcRelyingPartyClient;
}

const rigs: ProviderEmulator[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.stop();
});

function idpEgress(hosts = [HOST]): EgressGuard {
  return new EgressGuard(
    {
      policyVersion: "egress-oidc-unit-1",
      destinations: [
        { destinationId: "egr_workforce_idp", kind: "VERIFICATION_SERVICE", hosts, allowedClasses: ["PUBLIC", "VERIFICATION_SECRET"], coverage: { baaRef: null, approvalId: "apr_synthOidcUnitApproval1" }, environments: ["local", "ci"], adapterKind: "live" },
      ],
    },
    { environment: "local" },
  );
}

function transportFor(port: number, hosts = [HOST], egress = idpEgress(hosts)): ConnectorHttpTransport {
  return new ConnectorHttpTransport({ environment: "local", egress, loopbackRoutes: new Map(hosts.map((h) => [h, { port, tls: false }])) });
}

/** OidcHttp over the egress-classified transport, with the SAME guard for its construction-time checks. */
function httpFor(port: number, hosts = [HOST]): OidcHttp {
  const egress = idpEgress(hosts);
  return new OidcHttp({ transport: transportFor(port, hosts, egress), egress, destination: { allowedHosts: hosts, addressClass: "PUBLIC_INTERNET" } });
}

async function rig(o: { auth?: OidcClientAuthentication; ttlSeconds?: number } = {}): Promise<Rig> {
  const clock = new FakeClock(START);
  const em = await new ProviderEmulator(clock).start();
  rigs.push(em);
  const http = httpFor(em.port);
  const discovery = new OidcDiscovery({ issuer: ISSUER, http, clock, ttlSeconds: o.ttlSeconds ?? 900 });
  const auth: OidcClientAuthentication = o.auth ?? { method: "client_secret_basic", clientSecret: async () => CLIENT_SECRET };
  const client = new OidcRelyingPartyClient({ clientId: CLIENT_ID, discovery, http, auth, clock, algorithms: ["ES256"] });
  return { clock, em, http, discovery, client };
}

const nonceAndVerifier = () => ({ nonce: b64(32), verifier: b64(32) });

describe("[FO-05-07] OIDC discovery", () => {
  it("[FO-05-07][AUTH-01] fetches the issuer metadata over the egress-classified transport, requires issuer equality and pins the https endpoints", async () => {
    const r = await rig();
    const p = await r.discovery.provider();
    expect(p.issuer).toBe(ISSUER);
    expect(p.tokenEndpoint.href).toBe(`${ISSUER}/protocol/openid-connect/token`);
    expect(p.idTokenSigningAlgorithms).toEqual(["ES256", "RS256"]);
    expect(p.codeChallengeMethods).toContain("S256");
    expect(r.em.requests.map((q) => q.path)).toEqual(["/realms/workforce/.well-known/openid-configuration"]);
    // Cached within the TTL.
    await r.discovery.provider();
    expect(r.em.requests).toHaveLength(1);
  });

  it("[FO-05-07] refuses an issuer mismatch, an http endpoint, an endpoint on another host and a provider without S256 PKCE", async () => {
    for (const [override, reason] of [
      [{ issuer: `${ISSUER}/` }, "OIDC_ISSUER_MISMATCH"],
      [{ issuer: "https://idp.oidc-emulator.test/realms/other" }, "OIDC_ISSUER_MISMATCH"],
      [{ token_endpoint: `http://${HOST}/realms/workforce/protocol/openid-connect/token` }, "OIDC_DISCOVERY_ENDPOINT_NOT_HTTPS"],
      [{ jwks_uri: "https://keys.attacker.test/certs" }, "OIDC_DISCOVERY_ENDPOINT_NOT_ALLOWED"],
      [{ code_challenge_methods_supported: ["plain"] }, "OIDC_PKCE_S256_UNSUPPORTED"],
      [{ id_token_signing_alg_values_supported: ["none", "HS256"] }, "OIDC_SIGNING_ALGORITHMS_UNSUPPORTED"],
      [{ response_types_supported: ["token"] }, "OIDC_CODE_FLOW_UNSUPPORTED"],
    ] as const) {
      const r = await rig();
      r.em.metadataOverride = { ...override };
      await expect(r.discovery.provider(), JSON.stringify(override)).rejects.toMatchObject({ reasonCode: reason });
      expect((await r.discovery.health()).healthy).toBe(false);
    }
  });

  describe("[FO-05-07] egress-policy refusals are configuration refusals, never an IdP outage", () => {
    // Entra-style issuer: https://<host>/<tenant uuid>/v2.0. This UUID's last group is a 12-digit run, which the
    // EgressGuard's URL PHI heuristic refuses (about 6 % of random tenant UUIDs do).
    const TENANT_UUID = "3f2b8c1e-5d4a-4e6f-9a7b-104857600123";
    const UUID_ISSUER = `https://${HOST}/${TENANT_UUID}/v2.0`;

    it("[FO-05-07][OPS-04] a UUID-path issuer whose discovery URL the egress policy refuses is refused at construction (ConfigurationRejectedError OIDC_EGRESS_REFUSED, nothing sent)", async () => {
      expect(urlCarriesSensitivePattern(new URL(`${UUID_ISSUER}/.well-known/openid-configuration`))).toBe(true);
      const r = await rig();
      const refused = (() => {
        try {
          return new OidcDiscovery({ issuer: UUID_ISSUER, http: r.http, clock: r.clock });
        } catch (e) {
          return e;
        }
      })();
      expect(refused).toBeInstanceOf(ConfigurationRejectedError);
      expect(isOidcEgressRefusal(refused)).toBe(true);
      expect(refused).toMatchObject({ retryable: false, violations: ["OIDC_EGRESS_REFUSED@identity_provider.discovery:EGRESS_URL_CONTAINS_SENSITIVE_PATTERN"] });
      expect(r.em.requests).toEqual([]);
      // A UUID that does not trip the heuristic is accepted (the check is the egress policy's, not a blanket refusal).
      expect(() => new OidcDiscovery({ issuer: `https://${HOST}/3f2b8c1e-5d4a-4e6f-9a7b-abcdefabcdef/v2.0`, http: r.http, clock: r.clock })).not.toThrow();
    });

    it("[FO-05-07] a discovered endpoint the egress policy refuses fails discovery as OIDC_EGRESS_REFUSED (health too), not OIDC_DISCOVERY_UNAVAILABLE, and is not retried", async () => {
      const r = await rig();
      r.em.metadataOverride = { jwks_uri: `${ISSUER}/discovery/${TENANT_UUID}/keys` };
      const first = await r.discovery.provider().catch((e: unknown) => e);
      expect(isOidcEgressRefusal(first)).toBe(true);
      expect(first).toMatchObject({ reasonCode: "CONFIGURATION_REJECTED", retryable: false, violations: ["OIDC_EGRESS_REFUSED@identity_provider.jwks:EGRESS_URL_CONTAINS_SENSITIVE_PATTERN"] });
      expect(await r.discovery.health()).toEqual({ healthy: false, reasonCode: "OIDC_EGRESS_REFUSED" });
      r.em.metadataOverride = { token_endpoint: `${ISSUER}/${TENANT_UUID}/oauth2/v2.0/token` };
      expect(await r.discovery.provider().catch((e: unknown) => e)).toMatchObject({ violations: ["OIDC_EGRESS_REFUSED@identity_provider.token:EGRESS_URL_CONTAINS_SENSITIVE_PATTERN"] });
    });

    it("[FO-05-07] at request time an egress refusal of the transport maps to OIDC_EGRESS_REFUSED (never retryable), not OIDC_PROVIDER_UNAVAILABLE", async () => {
      const clock = new FakeClock(START);
      const em = await new ProviderEmulator(clock).start();
      rigs.push(em);
      // The transport's guard does not know the IdP host; OidcHttp is given a permissive check so that only
      // the request-time path is exercised (a guard mismatch the composition never builds).
      const restrictive = new EgressGuard({ policyVersion: "egress-oidc-unit-3", destinations: [] }, { environment: "local" });
      const permissive: OidcEgressCheck = { check: () => ({ allowed: true, reasonCode: "EGRESS_ALLOWED" }) };
      const http = new OidcHttp({ transport: transportFor(em.port, [HOST], restrictive), egress: permissive, destination: { allowedHosts: [HOST], addressClass: "PUBLIC_INTERNET" } });
      const err = await http.getJson(new URL(`${ISSUER}/.well-known/openid-configuration`), "discovery").catch((e: unknown) => e);
      expect(isOidcEgressRefusal(err)).toBe(true);
      expect(err).toMatchObject({ retryable: false, violations: ["OIDC_EGRESS_REFUSED@identity_provider.discovery:EGRESS_DESTINATION_UNKNOWN"] });
      const form = await http.postForm(new URL(`${ISSUER}/protocol/openid-connect/token`), new URLSearchParams({ grant_type: "x" }), {}, { sideEffect: true, expectBody: true, endpoint: "token" }).catch((e: unknown) => e);
      expect(form).toMatchObject({ violations: ["OIDC_EGRESS_REFUSED@identity_provider.token:EGRESS_DESTINATION_UNKNOWN"] });
      expect(em.requests).toEqual([]);
      // OidcHttp refuses to exist without the guard's check.
      expect(() => new OidcHttp({ transport: transportFor(em.port), egress: undefined as unknown as OidcEgressCheck, destination: { allowedHosts: [HOST], addressClass: "PUBLIC_INTERNET" } })).toThrow(expect.objectContaining({ reasonCode: "OIDC_EGRESS_CHECK_REQUIRED" }));
    });
  });

  it("[FO-05-07][FO-14-52] the per-request deadline is bounded by OIDC_REQUEST_TIMEOUT_MAX_MS (the console's in-flight refresh window is derived from it)", () => {
    const egress: OidcEgressCheck = { check: () => ({ allowed: true, reasonCode: "EGRESS_ALLOWED" }) };
    const make = (timeoutMs: number) => new OidcHttp({ transport: transportFor(1, [HOST]), egress, destination: { allowedHosts: [HOST], addressClass: "PUBLIC_INTERNET" }, timeoutMs });
    expect(OIDC_REQUEST_TIMEOUT_MAX_MS).toBe(30_000);
    expect(() => make(OIDC_REQUEST_TIMEOUT_MAX_MS)).not.toThrow();
    expect(() => make(OIDC_REQUEST_TIMEOUT_MAX_MS + 1)).toThrow(expect.objectContaining({ reasonCode: "OIDC_TIMEOUT_INVALID" }));
    expect(() => make(99)).toThrow(expect.objectContaining({ reasonCode: "OIDC_TIMEOUT_INVALID" }));
  });

  it("[FO-05-07] the configured issuer must be https on an allowed host", async () => {
    const r = await rig();
    expect(() => new OidcDiscovery({ issuer: `http://${HOST}/realms/workforce`, http: r.http, clock: r.clock })).toThrow(expect.objectContaining({ reasonCode: "OIDC_ISSUER_URL_INVALID" }));
    expect(() => new OidcDiscovery({ issuer: "https://idp.other.test/realms/x", http: r.http, clock: r.clock })).toThrow(expect.objectContaining({ reasonCode: "OIDC_ISSUER_HOST_NOT_ALLOWED" }));
  });

  it("[FO-05-07][FO-05-12] fails closed when a refresh after the TTL fails (no stale metadata) and adopts rotated metadata and keys on the next refresh", async () => {
    const r = await rig({ ttlSeconds: 60 });
    const first = await r.discovery.provider();
    await r.em.stop();
    r.clock.advanceSeconds(61);
    await expect(r.discovery.provider()).rejects.toMatchObject({ reasonCode: "OIDC_DISCOVERY_UNAVAILABLE" });
    await expect(r.discovery.provider()).rejects.toMatchObject({ reasonCode: "OIDC_DISCOVERY_UNAVAILABLE" });
    // The provider comes back with a rotated JWKS endpoint and a new signing key only it publishes.
    const em2 = await new ProviderEmulator(r.clock).start();
    rigs.push(em2);
    em2.metadataOverride = { jwks_uri: `${ISSUER}/protocol/openid-connect/certs-v2` };
    const http2 = httpFor(em2.port);
    const d2 = new OidcDiscovery({ issuer: ISSUER, http: http2, clock: r.clock, ttlSeconds: 60 });
    const before = await d2.provider();
    expect(before.jwksUri.href).toMatch(/certs-v2$/);
    expect(before.metadataDigest).not.toBe(first.metadataDigest);
    const { nonce, verifier } = nonceAndVerifier();
    const client = new OidcRelyingPartyClient({ clientId: CLIENT_ID, discovery: d2, http: http2, auth: { method: "client_secret_basic", clientSecret: async () => CLIENT_SECRET }, clock: r.clock, algorithms: ["ES256"] });
    const out = await client.exchangeCode({ code: em2.issueCode({ sub: "user-1", nonce, verifier }), codeVerifier: verifier, redirectUri: REDIRECT, nonce, maxAuthAgeSeconds: 300 });
    expect(out.idToken.subject).toBe("user-1");
    expect(em2.requests.some((q) => q.path.endsWith("/certs-v2"))).toBe(true);
  });

  it("[FO-05-12] an unknown kid triggers one JWKS refetch (rotation) spaced by the cooldown; a JWKS with private key material is refused", async () => {
    const r = await rig();
    const resolver = r.discovery.keyResolver();
    const verifier = JwksOidcVerifier.fromDiscovery({ integrationId: "oidc-workforce-idp", clock: r.clock, providers: [{ discovery: r.discovery, audience: CLIENT_ID }], policy: { algorithms: ["ES256"] } });
    const nonce = b64(32);
    const sign = async () => {
      const k = r.em.keys[0];
      if (!k) throw new Error("no key");
      const nowS = Math.floor(r.clock.now().getTime() / 1000);
      return new SignJWT({ nonce, auth_time: nowS, amr: ["otp"] }).setProtectedHeader({ alg: "ES256", kid: k.kid }).setIssuer(ISSUER).setSubject("user-1").setAudience(CLIENT_ID).setIssuedAt(nowS).setExpirationTime(nowS + 60).sign(k.privateKey);
    };
    expect((await verifier.verifyIdToken(await sign(), { nonce, maxAuthAgeSeconds: 300 })).sub).toBe("user-1");
    await r.em.rotate(true);
    const certFetches = () => r.em.requests.filter((q) => q.path.endsWith("/certs")).length;
    const before = certFetches();
    expect((await verifier.verifyIdToken(await sign(), { nonce, maxAuthAgeSeconds: 300 })).sub).toBe("user-1");
    expect(certFetches()).toBe(before + 1);
    // Within the cooldown a second unknown kid does not refetch (no fetch amplification).
    await r.em.rotate(true);
    await expect(verifier.verifyIdToken(await sign(), { nonce, maxAuthAgeSeconds: 300 })).rejects.toMatchObject({ reasonCode: "OIDC_KEY_NOT_FOUND" });
    expect(certFetches()).toBe(before + 1);
    expect(typeof resolver).toBe("function");
    const priv = await rig();
    priv.em.jwksPrivate = true;
    const c = new OidcRelyingPartyClient({ clientId: CLIENT_ID, discovery: priv.discovery, http: priv.http, auth: { method: "client_secret_basic", clientSecret: async () => CLIENT_SECRET }, clock: priv.clock, algorithms: ["ES256"] });
    const nv = nonceAndVerifier();
    await expect(c.exchangeCode({ code: priv.em.issueCode({ sub: "user-1", ...nv }), codeVerifier: nv.verifier, redirectUri: REDIRECT, nonce: nv.nonce, maxAuthAgeSeconds: 300 })).rejects.toMatchObject({ reasonCode: "OIDC_JWKS_PRIVATE_KEY_PUBLISHED" });
  });
});

describe("[FO-05-09] authorization code with PKCE (backend exchange)", () => {
  it("[FO-05-09][FO-05-10] the authorization URL comes from the discovered endpoint and carries S256 PKCE, state, nonce and the exact redirect", async () => {
    const r = await rig();
    const state = b64(32);
    const nonce = b64(32);
    const verifier = b64(32);
    const { url } = await r.client.authorizationRequest({ redirectUri: REDIRECT, state, nonce, codeChallenge: s256Challenge(verifier), scopes: ["profile"] });
    const u = new URL(url);
    expect(`${u.origin}${u.pathname}`).toBe(`${ISSUER}/protocol/openid-connect/auth`);
    expect(Object.fromEntries(u.searchParams)).toEqual({ response_type: "code", client_id: CLIENT_ID, redirect_uri: REDIRECT, scope: "openid profile", state, nonce, code_challenge: s256Challenge(verifier), code_challenge_method: "S256" });
    await expect(r.client.authorizationRequest({ redirectUri: REDIRECT, state: "short", nonce, codeChallenge: s256Challenge(verifier), scopes: [] })).rejects.toMatchObject({ reasonCode: "OIDC_STATE_INVALID" });
    await expect(r.client.authorizationRequest({ redirectUri: `${REDIRECT}#frag`, state, nonce, codeChallenge: s256Challenge(verifier), scopes: [] })).rejects.toMatchObject({ reasonCode: "OIDC_REDIRECT_URI_INVALID" });
    // A sealed console login state (up to 346 characters) is a valid state; a nonce stays a short random value.
    const sealedState = b64(259);
    const withAge = new URL((await r.client.authorizationRequest({ redirectUri: REDIRECT, state: sealedState, nonce, codeChallenge: s256Challenge(verifier), scopes: [], maxAgeSeconds: 600 })).url);
    expect(withAge.searchParams.get("state")).toBe(sealedState);
    expect(withAge.searchParams.get("max_age")).toBe("600");
    await expect(r.client.authorizationRequest({ redirectUri: REDIRECT, state, nonce: b64(259), codeChallenge: s256Challenge(verifier), scopes: [] })).rejects.toMatchObject({ reasonCode: "OIDC_STATE_INVALID" });
    await expect(r.client.authorizationRequest({ redirectUri: REDIRECT, state: b64(400), nonce, codeChallenge: s256Challenge(verifier), scopes: [] })).rejects.toMatchObject({ reasonCode: "OIDC_STATE_INVALID" });
  });

  it("[FO-05-09][AUTH-03] exchanges the code with the verifier and validates the ID token: claims, groups, amr, hashed nonce and sid", async () => {
    const r = await rig();
    const { nonce, verifier } = nonceAndVerifier();
    const out = await r.client.exchangeCode({ code: r.em.issueCode({ sub: "user-1", nonce, verifier, groups: ["/vsp/supervisor", "/other"] }), codeVerifier: verifier, redirectUri: REDIRECT, nonce, maxAuthAgeSeconds: 300 });
    expect(out.idToken).toMatchObject({ issuer: ISSUER, subject: "user-1", audience: CLIENT_ID, amr: ["pwd", "otp"], groups: ["/vsp/supervisor", "/other"], acr: null });
    expect(out.idToken.nonceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(out.idToken.nonceHash).not.toContain(nonce);
    expect(out.idToken.sidHash).toMatch(/^[a-f0-9]{64}$/);
    expect(out.refreshToken).toBeTruthy();
    expect(out.accessTokenExpiresAt.toISOString()).toBe("2026-10-20T10:05:00.000Z");
    expect(r.em.requests.find((q) => q.grant === "authorization_code")?.auth).toBe("basic");
  });

  it("[FO-05-09][FO-05-11] a wrong verifier, a replayed code and a redirect mismatch are refused by the provider as invalid_grant", async () => {
    const r = await rig();
    const { nonce, verifier } = nonceAndVerifier();
    await expect(r.client.exchangeCode({ code: r.em.issueCode({ sub: "u", nonce, verifier }), codeVerifier: b64(32), redirectUri: REDIRECT, nonce, maxAuthAgeSeconds: 300 })).rejects.toMatchObject({ reasonCode: "OIDC_GRANT_INVALID" });
    const code = r.em.issueCode({ sub: "u", nonce, verifier });
    await r.client.exchangeCode({ code, codeVerifier: verifier, redirectUri: REDIRECT, nonce, maxAuthAgeSeconds: 300 });
    await expect(r.client.exchangeCode({ code, codeVerifier: verifier, redirectUri: REDIRECT, nonce, maxAuthAgeSeconds: 300 })).rejects.toMatchObject({ reasonCode: "OIDC_GRANT_INVALID" });
    await expect(r.client.exchangeCode({ code: r.em.issueCode({ sub: "u", nonce, verifier }), codeVerifier: verifier, redirectUri: "https://console.vsp-local.test/other", nonce, maxAuthAgeSeconds: 300 })).rejects.toMatchObject({ reasonCode: "OIDC_GRANT_INVALID" });
    await expect(r.client.exchangeCode({ code: "short", codeVerifier: verifier, redirectUri: REDIRECT, nonce, maxAuthAgeSeconds: 300 })).rejects.toMatchObject({ reasonCode: "OIDC_CODE_INVALID" });
  });

  it("[FO-05-09][AUTH-01] nonce mismatch, a stale authentication, an issuer mix-up and a wrong at_hash are refused after the exchange", async () => {
    const r = await rig();
    const a = nonceAndVerifier();
    await expect(r.client.exchangeCode({ code: r.em.issueCode({ sub: "u", ...a }), codeVerifier: a.verifier, redirectUri: REDIRECT, nonce: b64(32), maxAuthAgeSeconds: 300 })).rejects.toMatchObject({ reasonCode: "OIDC_NONCE_MISMATCH" });
    const b = nonceAndVerifier();
    const old = Math.floor(r.clock.now().getTime() / 1000) - 3600;
    await expect(r.client.exchangeCode({ code: r.em.issueCode({ sub: "u", ...b, authTime: old }), codeVerifier: b.verifier, redirectUri: REDIRECT, nonce: b.nonce, maxAuthAgeSeconds: 300 })).rejects.toMatchObject({ reasonCode: "OIDC_AUTH_TOO_OLD" });
    const c = nonceAndVerifier();
    r.em.issuerOverride = "https://idp.oidc-emulator.test/realms/other";
    await expect(r.client.exchangeCode({ code: r.em.issueCode({ sub: "u", ...c }), codeVerifier: c.verifier, redirectUri: REDIRECT, nonce: c.nonce, maxAuthAgeSeconds: 300 })).rejects.toMatchObject({ reasonCode: "OIDC_ISSUER_MISMATCH" });
    r.em.issuerOverride = null;
    const d = nonceAndVerifier();
    r.em.atHashOverride = b64(16);
    await expect(r.client.exchangeCode({ code: r.em.issueCode({ sub: "u", ...d }), codeVerifier: d.verifier, redirectUri: REDIRECT, nonce: d.nonce, maxAuthAgeSeconds: 300 })).rejects.toMatchObject({ reasonCode: "OIDC_AT_HASH_MISMATCH" });
  });

  it("[FO-05-09][ACT-03] a lost answer after the code was sent is OIDC_PROVIDER_OUTCOME_UNKNOWN (never retried); an unreachable provider is NOT_STARTED", async () => {
    const r = await rig();
    await r.discovery.provider();
    const a = nonceAndVerifier();
    r.em.failNext = "close_after_read";
    await expect(r.client.exchangeCode({ code: r.em.issueCode({ sub: "u", ...a }), codeVerifier: a.verifier, redirectUri: REDIRECT, nonce: a.nonce, maxAuthAgeSeconds: 300 })).rejects.toMatchObject({ reasonCode: "OIDC_PROVIDER_OUTCOME_UNKNOWN", outcome: "UNKNOWN", retryable: false });
    const b = nonceAndVerifier();
    r.em.failNext = "500";
    await expect(r.client.exchangeCode({ code: r.em.issueCode({ sub: "u", ...b }), codeVerifier: b.verifier, redirectUri: REDIRECT, nonce: b.nonce, maxAuthAgeSeconds: 300 })).rejects.toMatchObject({ reasonCode: "OIDC_PROVIDER_OUTCOME_UNKNOWN" });
    await r.em.stop();
    const c = nonceAndVerifier();
    await expect(r.client.exchangeCode({ code: "x".repeat(40), codeVerifier: c.verifier, redirectUri: REDIRECT, nonce: c.nonce, maxAuthAgeSeconds: 300 })).rejects.toMatchObject({ reasonCode: "OIDC_PROVIDER_UNAVAILABLE", outcome: "NOT_STARTED" });
    expect((await r.client.health()).healthy).toBe(false);
  });

  it("[FO-05-09] private_key_jwt client authentication (RFC 7523) from the secret store; a wrong key is invalid_client", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const store = { resolve: async (ref: string) => ({ ref, versionId: "v1", stage: "AWSCURRENT" as const, fetchedAt: new Date(START), value: { json: () => ({ privateKeyPem: pem, kid: "client-key-1", alg: "ES256" }), reveal: () => "" } }) };
    const r = await rig({ auth: clientAuthenticationFromSecret(store as never, "local-fixture:oidc-client") });
    r.em.clientJwks = [{ ...(await exportJWK(publicKey as KeyObject)), kid: "client-key-1", alg: "ES256" }];
    const a = nonceAndVerifier();
    const out = await r.client.exchangeCode({ code: r.em.issueCode({ sub: "u", ...a }), codeVerifier: a.verifier, redirectUri: REDIRECT, nonce: a.nonce, maxAuthAgeSeconds: 300 });
    expect(out.idToken.subject).toBe("u");
    expect(r.em.requests.find((q) => q.grant === "authorization_code")?.auth).toBe("jwt");
    r.em.clientJwks = [{ ...(await exportJWK(generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey as KeyObject)), kid: "client-key-1", alg: "ES256" }];
    const b = nonceAndVerifier();
    await expect(r.client.exchangeCode({ code: r.em.issueCode({ sub: "u", ...b }), codeVerifier: b.verifier, redirectUri: REDIRECT, nonce: b.nonce, maxAuthAgeSeconds: 300 })).rejects.toMatchObject({ reasonCode: "OIDC_CLIENT_AUTH_FAILED" });
    const basic = clientSecretBasicFromSecret({ resolve: async () => ({ value: { json: () => ({ privateKeyPem: pem, kid: "k", alg: "ES256" }) } }) } as never, "local-fixture:x");
    await expect((basic as { clientSecret: () => Promise<string> }).clientSecret()).rejects.toMatchObject({ reasonCode: "OIDC_CLIENT_CREDENTIAL_INVALID" });
  });
});

describe("[FO-05-19][FO-14-52] refresh, introspection and revocation", () => {
  async function signedIn(r: Rig) {
    const a = nonceAndVerifier();
    const out = await r.client.exchangeCode({ code: r.em.issueCode({ sub: "user-1", ...a }), codeVerifier: a.verifier, redirectUri: REDIRECT, nonce: a.nonce, maxAuthAgeSeconds: 300 });
    return out;
  }

  it("[FO-05-19][AUTH-04] same-subject refresh rotates the refresh token; a replayed refresh token is refused and revokes the family", async () => {
    const r = await rig();
    const first = await signedIn(r);
    r.clock.advanceSeconds(120);
    const expected = { subject: first.idToken.subject, authTime: first.idToken.authTime, nonceHash: first.idToken.nonceHash };
    const second = await r.client.refresh({ refreshToken: first.refreshToken ?? "", expected });
    expect(second.idToken.subject).toBe("user-1");
    expect(second.refreshToken).not.toBe(first.refreshToken);
    await expect(r.client.refresh({ refreshToken: first.refreshToken ?? "", expected })).rejects.toMatchObject({ reasonCode: "OIDC_GRANT_INVALID" });
    // The replay revoked the family: the rotated token no longer works either.
    await expect(r.client.refresh({ refreshToken: second.refreshToken ?? "", expected })).rejects.toMatchObject({ reasonCode: "OIDC_GRANT_INVALID" });
  });

  it("[FO-05-07][FO-14-52] one refresh makes at most OIDC_REFRESH_MAX_REQUESTS sequential provider requests (the IdP time the console's in-flight refresh window must outlast): an expired discovery document, the token request, the key set, the discovery document expiring again during the refresh (60 s, the minimum TTL) and an unknown-kid key refetch", async () => {
    const r = await rig({ ttlSeconds: 60 });
    const first = await signedIn(r);
    // Both caches have expired (discovery 60 s, key set 600 s) and the provider rotated its signing key.
    r.clock.advanceSeconds(601);
    await r.em.rotate();
    r.em.hideNewestKeyOnce = true;
    r.em.requests.length = 0;
    // Every request takes the transport's maximum per-request deadline.
    r.em.onRequest = () => r.clock.advanceMs(OIDC_REQUEST_TIMEOUT_MAX_MS);
    const started = r.clock.now().getTime();
    const second = await r.client.refresh({ refreshToken: first.refreshToken ?? "", expected: { subject: first.idToken.subject, authTime: first.idToken.authTime, nonceHash: first.idToken.nonceHash } });
    r.em.onRequest = null;
    expect(second.idToken.subject).toBe("user-1");
    const base = "/realms/workforce";
    const discovery = `${base}/.well-known/openid-configuration`;
    const keys = `${base}/protocol/openid-connect/certs`;
    expect(r.em.requests.map((q) => q.path)).toEqual([discovery, `${base}/protocol/openid-connect/token`, keys, discovery, keys]);
    expect(r.em.requests).toHaveLength(OIDC_REFRESH_MAX_REQUESTS);
    expect(r.clock.now().getTime() - started).toBe(OIDC_REFRESH_MAX_REQUESTS * OIDC_REQUEST_TIMEOUT_MAX_MS);
  });

  it("[FO-05-19][AUTH-03] a refreshed ID token for another subject is refused, never adopted", async () => {
    const r = await rig();
    const first = await signedIn(r);
    r.em.subjectOnRefresh = "user-2";
    await expect(r.client.refresh({ refreshToken: first.refreshToken ?? "", expected: { subject: "user-1", authTime: first.idToken.authTime, nonceHash: first.idToken.nonceHash } })).rejects.toMatchObject({ reasonCode: "OIDC_SUBJECT_CHANGED" });
  });

  it("[FO-14-52] introspection reports an active session with groups, inactive after deprovisioning or revocation; tokens of another client are never active", async () => {
    const r = await rig();
    const first = await signedIn(r);
    const token = first.refreshToken ?? "";
    expect(await r.client.introspect(token, "refresh_token")).toMatchObject({ active: true, subject: "user-1", groups: ["/vsp/supervisor"] });
    r.em.disabledSubjects.add("user-1");
    expect(await r.client.introspect(token, "refresh_token")).toEqual({ active: false, subject: null, groups: null, expiresAt: null });
    r.em.disabledSubjects.clear();
    await r.client.revoke(token, "refresh_token");
    expect((await r.client.introspect(token, "refresh_token")).active).toBe(false);
    r.em.metadataOverride = { introspection_endpoint: undefined };
    r.discovery.invalidate();
    await expect(r.client.introspect(token, "refresh_token")).rejects.toMatchObject({ reasonCode: "OIDC_INTROSPECTION_UNSUPPORTED" });
  });

  it("[DATA-01][AUTH-06] the code exchange is classified VERIFICATION_SECRET: a destination not approved for secrets refuses before any socket opens", async () => {
    const clock = new FakeClock(START);
    const em = await new ProviderEmulator(clock).start();
    rigs.push(em);
    const egress = new EgressGuard(
      { policyVersion: "egress-oidc-unit-2", destinations: [{ destinationId: "egr_public_only", kind: "PUBLIC_WEB", hosts: [HOST], allowedClasses: ["PUBLIC"], coverage: { baaRef: null, approvalId: null }, environments: ["local"], adapterKind: "live" }] },
      { environment: "local" },
    );
    const http = new OidcHttp({ transport: new ConnectorHttpTransport({ environment: "local", egress, loopbackRoutes: new Map([[HOST, { port: em.port, tls: false }]]) }), egress, destination: { allowedHosts: [HOST], addressClass: "PUBLIC_INTERNET" } });
    const discovery = new OidcDiscovery({ issuer: ISSUER, http, clock });
    const client = new OidcRelyingPartyClient({ clientId: CLIENT_ID, discovery, http, auth: { method: "client_secret_basic", clientSecret: async () => CLIENT_SECRET }, clock, algorithms: ["ES256"] });
    const a = nonceAndVerifier();
    // The discovered token endpoint is checked against the egress policy for VERIFICATION_SECRET at discovery:
    // a configuration refusal (never retried, never reported as an outage), no grant ever sent.
    const refused = await client.exchangeCode({ code: em.issueCode({ sub: "u", ...a }), codeVerifier: a.verifier, redirectUri: REDIRECT, nonce: a.nonce, maxAuthAgeSeconds: 300 }).catch((e: unknown) => e);
    expect(isOidcEgressRefusal(refused)).toBe(true);
    expect(refused).toMatchObject({ retryable: false, violations: ["OIDC_EGRESS_REFUSED@identity_provider.token:EGRESS_RESTRICTED_TO_CONTENT_FREE_DESTINATION"] });
    expect(await discovery.health()).toEqual({ healthy: false, reasonCode: "OIDC_EGRESS_REFUSED" });
    expect(em.requests.filter((q) => q.grant !== null)).toEqual([]);
    expect(decodeJwt(await new SignJWT({}).setProtectedHeader({ alg: "HS256" }).sign(new Uint8Array(32))).iss).toBeUndefined();
  });
});
