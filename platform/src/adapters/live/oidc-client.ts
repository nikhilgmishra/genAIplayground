/**
 * OpenID Connect relying-party client for the authorization-code flow with PKCE (WP-05; follow-on
 * FO-05-07, FO-05-09, FO-05-11, FO-05-19, FO-14-52, FO-01-09; RFC 6749, RFC 7636, RFC 7662, RFC 7009,
 * RFC 7523, OpenID Connect Core 1.0 sections 3.1.3.7 and 12.2).
 *
 * The backend performs every token exchange: the browser holds only its PKCE verifier and never an IdP
 * token. All HTTP goes through `OidcHttp` (the egress-classified transport) and every endpoint comes from
 * `OidcDiscovery` (issuer equality, pinned https endpoints, fail-closed cache).
 *
 *   authorizationRequest   builds the authorization URL from the DISCOVERED endpoint: response_type=code,
 *                          S256 code challenge (plain is never sent), state, nonce, scope with openid.
 *   exchangeCode           POST to the token endpoint with the code, the code_verifier and the exact
 *                          redirect_uri, authenticated as the client (client_secret_basic or
 *                          private_key_jwt, RFC 7523). A failure after the request was sent is UNKNOWN
 *                          (the single-use code may be spent; never retried). The ID token is then
 *                          validated: signature over the discovered JWKS, iss, aud, azp, exp, iat age,
 *                          nonce (constant time), auth_time present and within the caller's bound,
 *                          at_hash when present.
 *   refresh                refresh-token grant (rotation honoured: the new refresh token replaces the
 *                          old one). The refreshed ID token must carry the SAME iss and sub as the
 *                          original, the same auth_time when present and, when it carries a nonce, the
 *                          original nonce (Core 12.2): a subject change is reported, never adopted.
 *   introspect             RFC 7662 active-state check of a token (offboarding: a disabled or deleted
 *                          user, a revoked session or a revoked token reads `active: false`).
 *   revoke                 RFC 7009 token revocation (logout, deprovisioning).
 *
 * Errors carry reason codes only (OIDC_*); no token, code, verifier, secret or provider message is ever
 * logged, thrown or returned outside the result object.
 */
import { createHash, createPrivateKey, randomBytes, timingSafeEqual } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { SignJWT, decodeJwt, decodeProtectedHeader, jwtVerify } from "jose";
import { z } from "zod";
import type { SecretResolver } from "../../connectors/secrets/resolver.js";
import type { Logger } from "../../observability/ports.js";
import { silentLogger } from "../../observability/logger.js";
import { constantTimeEqualHex, sha256Hex } from "../../shared/canonical.js";
import type { Clock } from "../../shared/clock.js";
import { AccessDeniedError, DependencyError, PlatformError, ValidationError } from "../../shared/errors.js";
import type { AdapterHealth } from "../ports.js";
import type { DiscoveredProvider, OidcDiscovery } from "./oidc-discovery.js";
import { ASYMMETRIC_ID_TOKEN_ALGORITHMS } from "./oidc-discovery.js";
import type { OidcHttp } from "./oidc-http.js";
import { mapJoseError, tagResolverFailures } from "./oidc-verifier.js";

/** How the client authenticates at the token, introspection and revocation endpoints. */
export type OidcClientAuthentication =
  | { method: "client_secret_basic"; clientSecret: () => Promise<string> }
  | { method: "private_key_jwt"; signingKey: () => Promise<{ key: KeyObject; kid: string; alg: "ES256" | "ES384" | "RS256" | "PS256" }> };

export type IdTokenAlgorithm = (typeof ASYMMETRIC_ID_TOKEN_ALGORITHMS)[number];

export interface OidcClientOptions {
  /** Our client id at the provider (expected `aud`). */
  clientId: string;
  discovery: OidcDiscovery;
  http: OidcHttp;
  auth: OidcClientAuthentication;
  clock: Clock;
  /** Accepted ID-token algorithms (default RS256, PS256, ES256). */
  algorithms?: IdTokenAlgorithm[];
  clockToleranceSeconds?: number;
  /** Maximum age of an ID token's `iat` at validation (default 300 s). */
  maxTokenAgeSeconds?: number;
  /** Claim carrying workforce group membership (default "groups"); null: not read. */
  groupsClaim?: string | null;
  logger?: Logger;
}

/** Validated ID-token claims (other provider claims are dropped and never logged). */
export interface VerifiedIdToken {
  issuer: string;
  subject: string;
  audience: string;
  issuedAt: number;
  expiresAt: number;
  authTime: number | null;
  amr: string[];
  acr: string | null;
  /** sha256 of the nonce claim (the raw nonce is never kept). */
  nonceHash: string | null;
  /** sha256 of the provider session id (`sid`), when present. */
  sidHash: string | null;
  /** Group claim values, when the client reads groups; null when the claim is absent. */
  groups: string[] | null;
}

export interface OidcTokenResult {
  idToken: VerifiedIdToken;
  /** The compact ID token itself, for a second independent policy check by the caller (never stored). */
  idTokenJwt: string;
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string | null;
  refreshTokenExpiresAt: Date | null;
  scope: string[];
}

export interface OidcIntrospection {
  active: boolean;
  subject: string | null;
  groups: string[] | null;
  expiresAt: Date | null;
}

const MAX_TOKEN_CHARS = 16_384;
const COMPACT_JWS = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
/** OAuth `state`: a random value or a sealed login state (console: login-state.ts, up to 346 characters). */
const STATE = /^[A-Za-z0-9_-]{32,512}$/;
const NONCE = /^[A-Za-z0-9_-]{32,128}$/;
const CODE = /^[A-Za-z0-9._~+/=-]{8,2048}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const SCOPE = /^[\x21\x23-\x5B\x5D-\x7E]{1,64}$/;

const TokenResponse = z.object({
  access_token: z.string().min(16).max(MAX_TOKEN_CHARS),
  token_type: z.string().regex(/^[Bb][Ee][Aa][Rr][Ee][Rr]$/),
  expires_in: z.number().int().min(1).max(86_400),
  id_token: z.string().min(16).max(MAX_TOKEN_CHARS).optional(),
  refresh_token: z.string().min(16).max(MAX_TOKEN_CHARS).optional(),
  refresh_expires_in: z.number().int().min(0).max(31_536_000).optional(),
  scope: z.string().max(2048).optional(),
});

const OAuthError = z.object({ error: z.string().regex(/^[\x20-\x21\x23-\x5B\x5D-\x7E]{1,128}$/) });

const IdClaims = z.object({
  iss: z.string().min(1).max(512),
  sub: z.string().min(1).max(255),
  aud: z.union([z.string().min(1).max(512), z.array(z.string().min(1).max(512)).min(1).max(16)]),
  azp: z.string().min(1).max(512).optional(),
  exp: z.number().int().positive(),
  iat: z.number().int().positive(),
  auth_time: z.number().int().nonnegative().optional(),
  nonce: z.string().min(1).max(256).optional(),
  amr: z.array(z.string().min(1).max(32)).max(16).optional(),
  acr: z.string().min(1).max(256).optional(),
  sid: z.string().min(1).max(256).optional(),
  at_hash: z.string().min(16).max(128).optional(),
});

const Introspection = z.object({
  active: z.boolean(),
  sub: z.string().min(1).max(255).optional(),
  exp: z.number().int().positive().optional(),
  client_id: z.string().max(256).optional(),
});

const constantTimeEqual = (a: string, b: string): boolean => timingSafeEqual(Buffer.from(sha256Hex(a), "hex"), Buffer.from(sha256Hex(b), "hex"));

/** S256 PKCE challenge of a verifier (RFC 7636 section 4.2). */
export const s256Challenge = (verifier: string): string => createHash("sha256").update(verifier, "ascii").digest("base64url");

/** OAuth error responses to reason codes (never the provider's description). */
function oauthReason(body: Record<string, unknown>, fallback: string): string {
  const e = OAuthError.safeParse(body);
  if (!e.success) return fallback;
  switch (e.data.error) {
    case "invalid_grant":
      return "OIDC_GRANT_INVALID";
    case "invalid_client":
    case "unauthorized_client":
      return "OIDC_CLIENT_AUTH_FAILED";
    case "invalid_request":
      return "OIDC_TOKEN_REQUEST_INVALID";
    case "invalid_scope":
      return "OIDC_SCOPE_INVALID";
    default:
      return fallback;
  }
}

/** Groups claim: an array of short strings; anything else counts as absent (null). */
function readGroups(payload: Record<string, unknown>, claim: string | null): string[] | null {
  if (claim === null) return null;
  const v = payload[claim];
  if (!Array.isArray(v) || v.length > 128 || !v.every((g) => typeof g === "string" && g.length >= 1 && g.length <= 256)) return null;
  return [...(v as string[])];
}

/** at_hash (Core 3.1.3.8): left half of the hash of the access token, hash per the JWS alg. */
function atHash(accessToken: string, alg: string): string {
  const bits = /(384)$/.test(alg) ? "sha384" : /(512)$/.test(alg) ? "sha512" : "sha256";
  const digest = createHash(bits).update(accessToken, "ascii").digest();
  return digest.subarray(0, digest.length / 2).toString("base64url");
}

export class OidcRelyingPartyClient {
  readonly kind = "live" as const;
  readonly clientId: string;
  private readonly opts: OidcClientOptions;
  private readonly algorithms: IdTokenAlgorithm[];
  private readonly tolerance: number;
  private readonly maxTokenAge: number;
  private readonly logger: Logger;
  private lastFailure: string | null = null;

  constructor(opts: OidcClientOptions) {
    if (!/^[A-Za-z0-9._:-]{3,256}$/.test(opts.clientId)) throw new ValidationError("OIDC_CLIENT_ID_INVALID");
    this.algorithms = opts.algorithms ?? ["RS256", "PS256", "ES256"];
    if (this.algorithms.length === 0 || !this.algorithms.every((a) => (ASYMMETRIC_ID_TOKEN_ALGORITHMS as readonly string[]).includes(a))) throw new ValidationError("OIDC_ALGORITHMS_INVALID");
    this.tolerance = opts.clockToleranceSeconds ?? 5;
    this.maxTokenAge = opts.maxTokenAgeSeconds ?? 300;
    if (!Number.isInteger(this.tolerance) || this.tolerance < 0 || this.tolerance > 60) throw new ValidationError("OIDC_CLOCK_TOLERANCE_INVALID");
    if (!Number.isInteger(this.maxTokenAge) || this.maxTokenAge < 30 || this.maxTokenAge > 3_600) throw new ValidationError("OIDC_MAX_TOKEN_AGE_INVALID");
    if (opts.groupsClaim !== undefined && opts.groupsClaim !== null && !/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/.test(opts.groupsClaim)) throw new ValidationError("OIDC_GROUPS_CLAIM_INVALID");
    this.clientId = opts.clientId;
    this.opts = opts;
    this.logger = (opts.logger ?? silentLogger).child({ component: "identity.oidc_client" });
  }

  get issuer(): string {
    return this.opts.discovery.issuer;
  }

  async health(): Promise<AdapterHealth> {
    const d = await this.opts.discovery.health();
    if (!d.healthy) return d;
    return { healthy: this.lastFailure === null, reasonCode: this.lastFailure };
  }

  /** Authorization request URL on the discovered endpoint (S256 PKCE, state and nonce from the caller's server-side transaction). */
  async authorizationRequest(input: { redirectUri: string; state: string; nonce: string; codeChallenge: string; scopes: readonly string[]; prompt?: "login" | "consent" | null; maxAgeSeconds?: number | null }): Promise<{ url: string; provider: DiscoveredProvider }> {
    if (!STATE.test(input.state) || !NONCE.test(input.nonce)) throw new ValidationError("OIDC_STATE_INVALID");
    if (!CHALLENGE.test(input.codeChallenge)) throw new ValidationError("OIDC_CODE_CHALLENGE_INVALID");
    if (input.scopes.length > 16 || !input.scopes.every((s) => SCOPE.test(s))) throw new ValidationError("OIDC_SCOPE_INVALID");
    const redirect = this.parseRedirect(input.redirectUri);
    const provider = await this.provider();
    const url = new URL(provider.authorizationEndpoint.href);
    const scopes = input.scopes.includes("openid") ? [...input.scopes] : ["openid", ...input.scopes];
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.clientId);
    url.searchParams.set("redirect_uri", redirect);
    url.searchParams.set("scope", scopes.join(" "));
    url.searchParams.set("state", input.state);
    url.searchParams.set("nonce", input.nonce);
    url.searchParams.set("code_challenge", input.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    if (input.prompt) url.searchParams.set("prompt", input.prompt);
    if (input.maxAgeSeconds !== undefined && input.maxAgeSeconds !== null) {
      if (!Number.isInteger(input.maxAgeSeconds) || input.maxAgeSeconds < 0 || input.maxAgeSeconds > 86_400) throw new ValidationError("OIDC_MAX_AGE_INVALID");
      url.searchParams.set("max_age", String(input.maxAgeSeconds));
    }
    return { url: url.toString(), provider };
  }

  /**
   * Authorization-code grant with PKCE; validates the ID token (nonce, auth_time bound). The expected
   * nonce is given either in clear (`nonce`) or as its sha256 hex (`nonceSha256`, when the caller keeps
   * only the hash of its server-side login transaction); exactly one of the two.
   */
  async exchangeCode(input: { code: string; codeVerifier: string; redirectUri: string; nonce?: string; nonceSha256?: string; maxAuthAgeSeconds: number }): Promise<OidcTokenResult> {
    if (!CODE.test(input.code)) throw new AccessDeniedError("OIDC_CODE_INVALID");
    if (!VERIFIER.test(input.codeVerifier)) throw new AccessDeniedError("OIDC_CODE_VERIFIER_INVALID");
    const expectedNonce = input.nonce !== undefined && input.nonceSha256 === undefined && NONCE.test(input.nonce) ? sha256Hex(input.nonce) : input.nonce === undefined && input.nonceSha256 !== undefined && /^[a-f0-9]{64}$/.test(input.nonceSha256) ? input.nonceSha256 : null;
    if (expectedNonce === null) throw new ValidationError("OIDC_NONCE_INVALID");
    const redirect = this.parseRedirect(input.redirectUri);
    const provider = await this.provider();
    const form = new URLSearchParams({ grant_type: "authorization_code", code: input.code, code_verifier: input.codeVerifier, redirect_uri: redirect });
    const res = await this.tokenRequest(provider, form, true);
    if (!res.id_token) return this.denied("OIDC_ID_TOKEN_MISSING");
    const idToken = await this.verifyIdToken(provider, res.id_token, { nonceSha256: expectedNonce, maxAuthAgeSeconds: input.maxAuthAgeSeconds, accessToken: res.access_token, requireAuthTime: true });
    return this.result(res, res.id_token, idToken);
  }

  /**
   * Refresh-token grant. The refreshed ID token must keep the original (iss, sub) (and auth_time and
   * nonce when present): a different subject is refused with OIDC_SUBJECT_CHANGED and never adopted.
   */
  async refresh(input: { refreshToken: string; expected: { subject?: string; isSameSubject?: (subject: string) => boolean; authTime: number | null; nonceHash: string | null } }): Promise<OidcTokenResult> {
    const same =
      input.expected.subject !== undefined && input.expected.isSameSubject === undefined
        ? (sub: string) => sub === input.expected.subject
        : input.expected.subject === undefined && input.expected.isSameSubject !== undefined
          ? input.expected.isSameSubject
          : null;
    if (same === null) throw new ValidationError("OIDC_REFRESH_EXPECTATION_INVALID");
    if (typeof input.refreshToken !== "string" || input.refreshToken.length < 16 || input.refreshToken.length > MAX_TOKEN_CHARS) throw new AccessDeniedError("OIDC_REFRESH_TOKEN_INVALID");
    const provider = await this.provider();
    const form = new URLSearchParams({ grant_type: "refresh_token", refresh_token: input.refreshToken });
    // A rotating refresh token is single use: a failure after send is UNKNOWN and never retried.
    const res = await this.tokenRequest(provider, form, true);
    if (!res.id_token) return this.denied("OIDC_ID_TOKEN_MISSING");
    const idToken = await this.verifyIdToken(provider, res.id_token, { nonceSha256: null, maxAuthAgeSeconds: null, accessToken: res.access_token, requireAuthTime: false });
    if (!same(idToken.subject)) {
      this.logger.warn("identity.oidc.refresh.subject_changed", { reasonCode: "OIDC_SUBJECT_CHANGED" });
      return this.denied("OIDC_SUBJECT_CHANGED");
    }
    if (input.expected.authTime !== null && idToken.authTime !== null && idToken.authTime !== input.expected.authTime) return this.denied("OIDC_AUTH_TIME_CHANGED");
    if (idToken.nonceHash !== null && input.expected.nonceHash !== null && idToken.nonceHash !== input.expected.nonceHash) return this.denied("OIDC_NONCE_MISMATCH");
    return this.result(res, res.id_token, idToken);
  }

  /** RFC 7662 introspection. A provider without an introspection endpoint cannot prove an active state (fail closed). */
  async introspect(token: string, hint: "refresh_token" | "access_token"): Promise<OidcIntrospection> {
    const provider = await this.provider();
    if (!provider.introspectionEndpoint) return this.denied("OIDC_INTROSPECTION_UNSUPPORTED");
    const form = new URLSearchParams({ token, token_type_hint: hint });
    const res = await this.authenticatedPost(provider, provider.introspectionEndpoint, form, false, true);
    if (res.status !== 200) return this.denied(oauthReason(res.body, "OIDC_INTROSPECTION_REFUSED"));
    const parsed = Introspection.safeParse(res.body);
    if (!parsed.success) throw new DependencyError("OIDC_PROVIDER_RESPONSE_INVALID", "FAILED", false);
    if (!parsed.data.active) return { active: false, subject: null, groups: null, expiresAt: null };
    // A token issued to another client is never accepted as evidence about our session.
    if (parsed.data.client_id !== undefined && parsed.data.client_id !== this.clientId) return { active: false, subject: null, groups: null, expiresAt: null };
    return {
      active: true,
      subject: parsed.data.sub ?? null,
      groups: readGroups(res.body, this.opts.groupsClaim === undefined ? "groups" : this.opts.groupsClaim),
      expiresAt: parsed.data.exp ? new Date(parsed.data.exp * 1000) : null,
    };
  }

  /** RFC 7009 revocation (best effort by contract: the caller has already revoked its own session). */
  async revoke(token: string, hint: "refresh_token" | "access_token"): Promise<void> {
    const provider = await this.provider();
    if (!provider.revocationEndpoint) throw new DependencyError("OIDC_REVOCATION_UNSUPPORTED", "NOT_STARTED", false);
    const res = await this.authenticatedPost(provider, provider.revocationEndpoint, new URLSearchParams({ token, token_type_hint: hint }), true, false);
    if (res.status !== 200) throw new DependencyError(oauthReason(res.body, "OIDC_REVOCATION_REFUSED"), "FAILED", false);
  }

  // ---------------------------------------------------------------------------

  private parseRedirect(raw: string): string {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new ValidationError("OIDC_REDIRECT_URI_INVALID");
    }
    if (url.hash || url.username || url.password || url.href !== raw) throw new ValidationError("OIDC_REDIRECT_URI_INVALID");
    return raw;
  }

  private async provider(): Promise<DiscoveredProvider> {
    try {
      return await this.opts.discovery.provider();
    } catch (err) {
      this.lastFailure = err instanceof PlatformError ? err.reasonCode : "OIDC_DISCOVERY_UNAVAILABLE";
      throw err;
    }
  }

  private denied(reasonCode: string): never {
    throw new AccessDeniedError(reasonCode);
  }

  private async tokenRequest(provider: DiscoveredProvider, form: URLSearchParams, sideEffect: boolean): Promise<z.infer<typeof TokenResponse>> {
    const res = await this.authenticatedPost(provider, provider.tokenEndpoint, form, sideEffect, true);
    if (res.status !== 200) {
      const reason = oauthReason(res.body, "OIDC_TOKEN_REQUEST_REFUSED");
      this.logger.info("identity.oidc.token.refused", { reasonCode: reason, status: res.status });
      return this.denied(reason);
    }
    const parsed = TokenResponse.safeParse(res.body);
    if (!parsed.success) throw new DependencyError("OIDC_PROVIDER_RESPONSE_INVALID", sideEffect ? "UNKNOWN" : "FAILED", false);
    return parsed.data;
  }

  private async authenticatedPost(provider: DiscoveredProvider, endpoint: URL, form: URLSearchParams, sideEffect: boolean, expectBody: boolean) {
    const headers: Record<string, string> = {};
    const auth = this.opts.auth;
    if (auth.method === "client_secret_basic") {
      let secret: string;
      try {
        secret = await auth.clientSecret();
      } catch {
        throw new DependencyError("OIDC_CLIENT_CREDENTIAL_UNAVAILABLE", "NOT_STARTED", true);
      }
      // RFC 6749 2.3.1: both parts form-encoded before base64.
      const enc = (v: string) => encodeURIComponent(v).replace(/%20/g, "+");
      headers.authorization = `Basic ${Buffer.from(`${enc(this.clientId)}:${enc(secret)}`, "utf8").toString("base64")}`;
    } else {
      let key: Awaited<ReturnType<typeof auth.signingKey>>;
      try {
        key = await auth.signingKey();
      } catch {
        throw new DependencyError("OIDC_CLIENT_CREDENTIAL_UNAVAILABLE", "NOT_STARTED", true);
      }
      const nowS = Math.floor(this.opts.clock.now().getTime() / 1000);
      // RFC 7523: iss = sub = client id; aud = the issuer identifier; short-lived, unique jti.
      const assertion = await new SignJWT({})
        .setProtectedHeader({ alg: key.alg, kid: key.kid, typ: "JWT" })
        .setIssuer(this.clientId)
        .setSubject(this.clientId)
        .setAudience(provider.issuer)
        .setIssuedAt(nowS)
        .setExpirationTime(nowS + 60)
        .setJti(randomBytes(18).toString("base64url"))
        .sign(key.key);
      form.set("client_assertion_type", "urn:ietf:params:oauth:client-assertion-type:jwt-bearer");
      form.set("client_assertion", assertion);
      form.set("client_id", this.clientId);
    }
    try {
      const label = endpoint === provider.tokenEndpoint ? "token" : endpoint === provider.introspectionEndpoint ? "introspection" : endpoint === provider.revocationEndpoint ? "revocation" : "form_endpoint";
      const res = await this.opts.http.postForm(endpoint, form, headers, { sideEffect, expectBody, endpoint: label });
      this.lastFailure = null;
      return res;
    } catch (err) {
      this.lastFailure = err instanceof PlatformError ? err.reasonCode : "OIDC_PROVIDER_UNAVAILABLE";
      throw err;
    }
  }

  private async verifyIdToken(
    provider: DiscoveredProvider,
    token: string,
    expect: { nonceSha256: string | null; maxAuthAgeSeconds: number | null; accessToken: string; requireAuthTime: boolean },
  ): Promise<VerifiedIdToken> {
    if (token.length > MAX_TOKEN_CHARS || !COMPACT_JWS.test(token)) return this.denied("OIDC_TOKEN_MALFORMED");
    let alg: unknown;
    try {
      alg = decodeProtectedHeader(token).alg;
      // A token naming another issuer is refused before any key is fetched.
      if (decodeJwt(token).iss !== provider.issuer) return this.denied("OIDC_ISSUER_MISMATCH");
    } catch (err) {
      if (err instanceof PlatformError) throw err;
      return this.denied("OIDC_TOKEN_MALFORMED");
    }
    const now = this.opts.clock.now();
    let payload: Record<string, unknown>;
    try {
      const r = await jwtVerify(token, tagResolverFailures(this.opts.discovery.keyResolver()), {
        issuer: provider.issuer,
        audience: this.clientId,
        algorithms: this.algorithms.filter((a) => provider.idTokenSigningAlgorithms.includes(a)),
        clockTolerance: this.tolerance,
        maxTokenAge: this.maxTokenAge,
        currentDate: now,
        requiredClaims: ["iss", "sub", "aud", "exp", "iat"],
      });
      payload = r.payload as Record<string, unknown>;
    } catch (err) {
      const mapped = mapJoseError(err);
      if (mapped instanceof DependencyError) this.lastFailure = mapped.reasonCode;
      throw mapped;
    }
    const c = IdClaims.safeParse(payload);
    if (!c.success) return this.denied("OIDC_CLAIM_INVALID");
    const claims = c.data;
    if (Array.isArray(claims.aud) && claims.aud.length > 1 && claims.azp !== this.clientId) this.denied("OIDC_AZP_MISMATCH");
    if (claims.azp !== undefined && claims.azp !== this.clientId) this.denied("OIDC_AZP_MISMATCH");
    if (expect.nonceSha256 !== null && (claims.nonce === undefined || !constantTimeEqualHex(sha256Hex(claims.nonce), expect.nonceSha256))) this.denied("OIDC_NONCE_MISMATCH");
    const nowS = Math.floor(now.getTime() / 1000);
    if (claims.auth_time === undefined) {
      if (expect.requireAuthTime) this.denied("OIDC_REQUIRED_CLAIM_MISSING");
    } else {
      if (claims.auth_time > nowS + this.tolerance) this.denied("OIDC_AUTH_TIME_IN_FUTURE");
      if (expect.maxAuthAgeSeconds !== null && nowS - claims.auth_time > expect.maxAuthAgeSeconds + this.tolerance) this.denied("OIDC_AUTH_TOO_OLD");
    }
    if (claims.at_hash !== undefined && typeof alg === "string" && !constantTimeEqual(claims.at_hash, atHash(expect.accessToken, alg))) this.denied("OIDC_AT_HASH_MISMATCH");
    return {
      issuer: claims.iss,
      subject: claims.sub,
      audience: this.clientId,
      issuedAt: claims.iat,
      expiresAt: claims.exp,
      authTime: claims.auth_time ?? null,
      amr: claims.amr ? [...claims.amr] : [],
      acr: claims.acr ?? null,
      nonceHash: claims.nonce !== undefined ? sha256Hex(claims.nonce) : null,
      sidHash: claims.sid !== undefined ? sha256Hex(`oidc-sid:${claims.sid}`) : null,
      groups: readGroups(payload, this.opts.groupsClaim === undefined ? "groups" : this.opts.groupsClaim),
    };
  }

  private result(res: z.infer<typeof TokenResponse>, idTokenJwt: string, idToken: VerifiedIdToken): OidcTokenResult {
    const now = this.opts.clock.now().getTime();
    return {
      idToken,
      idTokenJwt,
      accessToken: res.access_token,
      accessTokenExpiresAt: new Date(now + res.expires_in * 1000),
      refreshToken: res.refresh_token ?? null,
      refreshTokenExpiresAt: res.refresh_token && res.refresh_expires_in ? new Date(now + res.refresh_expires_in * 1000) : null,
      scope: (res.scope ?? "").split(" ").filter(Boolean),
    };
  }
}

/** Secret format of the client credential in the secret store (never logged; `reveal()` only here). */
const ClientCredentialSecret = z.union([
  z.strictObject({ clientSecret: z.string().min(16).max(512) }),
  z.strictObject({ privateKeyPem: z.string().min(64).max(16_384), kid: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/), alg: z.enum(["ES256", "ES384", "RS256", "PS256"]) }),
]);

/**
 * Client authentication read from the secret store through the connector SecretResolver (Secrets
 * Manager in live composition): the credential is resolved per use (the resolver caches with a TTL),
 * so a rotation is picked up without a restart. `private_key_jwt` is preferred (no shared secret
 * crosses the network).
 */
export function clientAuthenticationFromSecret(resolver: Pick<SecretResolver, "resolve">, ref: string): OidcClientAuthentication & { readonly secretRef: string } {
  const load = async () => {
    const resolved = await resolver.resolve(ref);
    const parsed = ClientCredentialSecret.safeParse(resolved.value.json());
    if (!parsed.success) throw new ValidationError("OIDC_CLIENT_CREDENTIAL_INVALID");
    return parsed.data;
  };
  return {
    secretRef: ref,
    method: "private_key_jwt",
    signingKey: async () => {
      const c = await load();
      if (!("privateKeyPem" in c)) throw new ValidationError("OIDC_CLIENT_CREDENTIAL_KIND_MISMATCH");
      return { key: createPrivateKey(c.privateKeyPem), kid: c.kid, alg: c.alg };
    },
  } as const;
}

/** client_secret_basic from the secret store (`{"clientSecret": ...}`), for providers without private_key_jwt. */
export function clientSecretBasicFromSecret(resolver: Pick<SecretResolver, "resolve">, ref: string): OidcClientAuthentication & { readonly secretRef: string } {
  return {
    secretRef: ref,
    method: "client_secret_basic",
    clientSecret: async () => {
      const parsed = ClientCredentialSecret.safeParse((await resolver.resolve(ref)).value.json());
      if (!parsed.success || !("clientSecret" in parsed.data)) throw new ValidationError("OIDC_CLIENT_CREDENTIAL_INVALID");
      return parsed.data.clientSecret;
    },
  };
}
