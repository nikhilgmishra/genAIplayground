/**
 * OIDC ID-token verification (spec section 7: the preferred verification journey
 * reuses the existing client and provider IdPs via OIDC).
 *
 * `JwksOidcVerifier` (kind "live") follows OpenID Connect Core 1.0 section 3.1.3.7
 * ID token validation using `jose`:
 *  - signature against the issuer's published JWKS (`createRemoteJWKSet`, https only),
 *    asymmetric algorithm allowlist (no `none`, no HMAC);
 *  - `iss` exactly one of the configured trusted issuers, `aud` our client id,
 *    `azp` when there are several audiences, `exp`, `iat` age (`maxTokenAge`) and
 *    clock tolerance evaluated against the injected Clock;
 *  - `nonce` equal to the transaction nonce (constant-time);
 *  - `auth_time` present and within the caller's `maxAuthAgeSeconds`.
 *
 * Only the claims the platform needs are extracted (other IdP claims, e.g. profile
 * fields, are dropped and never logged). Errors carry reason codes only, never the
 * token or claim values.
 *
 * STATUS: implemented against the documented OIDC/JWKS standards and tested against
 * LOCAL FIXTURE keys (injected local JWKS and a 127.0.0.1 HTTP JWKS server). Use
 * against a real IdP is BLOCKED on the identity owner's OIDC test clients
 * (issuer, client id, JWKS URI, emitted `amr`/`acr` values) — see the identity README.
 */
import { timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, customFetch, decodeJwt, jwtVerify } from "jose";
import type { FetchImplementation, JWTVerifyGetKey } from "jose";
import { z } from "zod";
import { sha256Hex } from "../../shared/canonical.js";
import type { Clock } from "../../shared/clock.js";
import { AccessDeniedError, DependencyError, PlatformError, ValidationError } from "../../shared/errors.js";
import type { AdapterHealth, OidcClaims, OidcVerifier } from "../ports.js";
import type { OidcDiscovery } from "./oidc-discovery.js";
import { isOidcEgressRefusal } from "./oidc-http.js";

export interface TrustedIssuer {
  /** Exact `iss` value. */
  issuer: string;
  /** Our OIDC client id at this IdP (expected `aud`). */
  audience: string;
  /** JWKS endpoint published by the IdP's discovery document. */
  jwksUri: string;
}

export const SUPPORTED_ID_TOKEN_ALGORITHMS = ["RS256", "PS256", "ES256", "ES384", "EdDSA"] as const;
export type IdTokenAlgorithm = (typeof SUPPORTED_ID_TOKEN_ALGORITHMS)[number];

export interface OidcVerificationPolicy {
  algorithms: IdTokenAlgorithm[];
  clockToleranceSeconds: number;
  /** Maximum age of the token itself (`iat`), independent of `auth_time`. */
  maxTokenAgeSeconds: number;
}

export const DEFAULT_OIDC_POLICY: OidcVerificationPolicy = {
  algorithms: ["RS256", "PS256", "ES256"],
  clockToleranceSeconds: 5,
  maxTokenAgeSeconds: 600,
};

export type KeyResolverFactory = (issuer: TrustedIssuer) => JWTVerifyGetKey;

const MAX_TOKEN_CHARS = 16_384;
const COMPACT_JWS = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

const Expected = z.strictObject({
  nonce: z.string().min(16).max(256),
  maxAuthAgeSeconds: z.number().int().min(1).max(86_400),
});

/** Only the needed claims; unknown IdP claims are deliberately dropped (third-party token). */
const IdTokenClaims = z.object({
  iss: z.string().min(1).max(512),
  sub: z.string().min(1).max(255),
  aud: z.union([z.string().min(1).max(512), z.array(z.string().min(1).max(512)).min(1).max(16)]),
  azp: z.string().min(1).max(512).optional(),
  nonce: z.string().min(1).max(256),
  auth_time: z.number().int().nonnegative(),
  amr: z.array(z.string().min(1).max(32)).max(16).optional(),
  acr: z.string().min(1).max(256).optional(),
});

function constantTimeEqualString(a: string, b: string): boolean {
  // Hash first so lengths are equal and the comparison leaks nothing about either value.
  return timingSafeEqual(Buffer.from(sha256Hex(a), "hex"), Buffer.from(sha256Hex(b), "hex"));
}

const deny = (reason: string): never => {
  throw new AccessDeniedError(reason);
};

export function mapJoseError(err: unknown): PlatformError {
  if (err instanceof PlatformError) return err;
  const code = typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
  const claim = typeof err === "object" && err !== null ? (err as { claim?: unknown }).claim : undefined;
  switch (code) {
    case "ERR_JWT_EXPIRED":
      // jose reports a too-old `iat` (maxTokenAge) as JWTExpired on claim "iat".
      return new AccessDeniedError(claim === "iat" ? "OIDC_TOKEN_TOO_OLD" : "OIDC_TOKEN_EXPIRED");
    case "ERR_JWT_CLAIM_VALIDATION_FAILED":
      if (claim === "iss") return new AccessDeniedError("OIDC_ISSUER_MISMATCH");
      if (claim === "aud") return new AccessDeniedError("OIDC_AUDIENCE_MISMATCH");
      if (claim === "iat") return new AccessDeniedError("OIDC_TOKEN_TOO_OLD");
      if (claim === "nbf") return new AccessDeniedError("OIDC_TOKEN_NOT_YET_VALID");
      if (claim === "nonce" || claim === "auth_time" || claim === "sub" || claim === "exp") return new AccessDeniedError("OIDC_REQUIRED_CLAIM_MISSING");
      return new AccessDeniedError("OIDC_CLAIM_INVALID");
    case "ERR_JOSE_ALG_NOT_ALLOWED":
    case "ERR_JOSE_NOT_SUPPORTED":
      return new AccessDeniedError("OIDC_ALG_NOT_ALLOWED");
    case "ERR_JWS_SIGNATURE_VERIFICATION_FAILED":
      return new AccessDeniedError("OIDC_SIGNATURE_INVALID");
    case "ERR_JWKS_NO_MATCHING_KEY":
      return new AccessDeniedError("OIDC_KEY_NOT_FOUND");
    case "ERR_JWKS_MULTIPLE_MATCHING_KEYS":
      return new AccessDeniedError("OIDC_KEY_AMBIGUOUS");
    case "ERR_JWS_INVALID":
    case "ERR_JWT_INVALID":
      return new AccessDeniedError("OIDC_TOKEN_MALFORMED");
    case "ERR_JWKS_TIMEOUT":
    case "ERR_JWKS_INVALID":
      return new DependencyError("OIDC_JWKS_UNAVAILABLE", "NOT_STARTED");
    default:
      return new AccessDeniedError("OIDC_TOKEN_INVALID");
  }
}

/**
 * Key-resolution failures other than "no / several matching keys" (HTTP errors,
 * timeouts, invalid JWKS documents, network faults) are dependency failures, not
 * token defects: they are tagged at the source so they cannot be confused with an
 * invalid token.
 */
export function tagResolverFailures(resolver: JWTVerifyGetKey): JWTVerifyGetKey {
  return async (header, token) => {
    try {
      return await resolver(header, token);
    } catch (err) {
      const code = typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
      if (code === "ERR_JWKS_NO_MATCHING_KEY" || code === "ERR_JWKS_MULTIPLE_MATCHING_KEYS") throw err;
      // A resolver that already classified its failure (discovery: OIDC_JWKS_PRIVATE_KEY_PUBLISHED, ...) keeps its
      // reason, and an egress-policy refusal stays a configuration refusal (never an outage).
      if (err instanceof DependencyError || isOidcEgressRefusal(err)) throw err;
      throw new DependencyError("OIDC_JWKS_UNAVAILABLE", "NOT_STARTED");
    }
  };
}

export interface VerifyCoreDeps {
  issuers: readonly TrustedIssuer[];
  resolverFor: (issuer: TrustedIssuer) => JWTVerifyGetKey;
  clock: Clock;
  policy: OidcVerificationPolicy;
}

/** Shared verification core used by the live verifier and the LOCAL FIXTURE verifier. */
export async function verifyIdTokenCore(idToken: unknown, expectedRaw: unknown, deps: VerifyCoreDeps): Promise<OidcClaims> {
  const expected = Expected.safeParse(expectedRaw);
  if (!expected.success) throw new ValidationError("OIDC_EXPECTATION_INVALID");
  if (typeof idToken !== "string" || idToken.length > MAX_TOKEN_CHARS || !COMPACT_JWS.test(idToken)) deny("OIDC_TOKEN_MALFORMED");
  const token = idToken as string;

  let unverifiedIss: unknown;
  try {
    unverifiedIss = decodeJwt(token).iss;
  } catch {
    return deny("OIDC_TOKEN_MALFORMED");
  }
  const trusted = deps.issuers.find((i) => i.issuer === unverifiedIss);
  if (!trusted) return deny("OIDC_ISSUER_NOT_TRUSTED");

  const now = deps.clock.now();
  let payload: unknown;
  try {
    const result = await jwtVerify(token, tagResolverFailures(deps.resolverFor(trusted)), {
      issuer: trusted.issuer,
      audience: trusted.audience,
      algorithms: [...deps.policy.algorithms],
      clockTolerance: deps.policy.clockToleranceSeconds,
      maxTokenAge: deps.policy.maxTokenAgeSeconds,
      currentDate: now,
      requiredClaims: ["iss", "sub", "aud", "exp", "iat", "nonce", "auth_time"],
    });
    payload = result.payload;
  } catch (err) {
    throw mapJoseError(err);
  }

  const claims = IdTokenClaims.safeParse(payload);
  if (!claims.success) return deny("OIDC_CLAIM_INVALID");
  const c = claims.data;
  if (!constantTimeEqualString(c.nonce, expected.data.nonce)) deny("OIDC_NONCE_MISMATCH");
  if (Array.isArray(c.aud) && c.aud.length > 1 && c.azp !== trusted.audience) deny("OIDC_AZP_MISMATCH");
  if (c.azp !== undefined && c.azp !== trusted.audience) deny("OIDC_AZP_MISMATCH");

  const nowSeconds = Math.floor(now.getTime() / 1000);
  const tolerance = deps.policy.clockToleranceSeconds;
  if (c.auth_time > nowSeconds + tolerance) deny("OIDC_AUTH_TIME_IN_FUTURE");
  if (nowSeconds - c.auth_time > expected.data.maxAuthAgeSeconds + tolerance) deny("OIDC_AUTH_TOO_OLD");

  return {
    issuer: trusted.issuer,
    sub: c.sub,
    audience: trusted.audience,
    nonce: c.nonce,
    authTime: c.auth_time,
    amr: c.amr ? [...c.amr] : [],
    acr: c.acr ?? null,
  };
}

const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{2,5})?(\/|$)/;

export interface JwksOidcVerifierOptions {
  /** Adapter key, e.g. "oidc-client-idp" or "oidc-provider-idp". */
  integrationId: string;
  issuers: TrustedIssuer[];
  clock: Clock;
  policy?: Partial<OidcVerificationPolicy>;
  remote?: { timeoutMs?: number; cooldownMs?: number; cacheMaxAgeMs?: number; fetch?: FetchImplementation };
  /** Injection point for tests / pre-provisioned keys (e.g. jose `createLocalJWKSet`). Replaces remote fetching. */
  keyResolverFactory?: KeyResolverFactory;
  /** TESTS ONLY: permit http JWKS URIs on the loopback interface (local fixture JWKS server). */
  allowLoopbackHttp?: boolean;
}

export class JwksOidcVerifier implements OidcVerifier {
  readonly kind = "live" as const;
  readonly integrationId: string;
  private readonly policy: OidcVerificationPolicy;
  private readonly resolvers = new Map<string, JWTVerifyGetKey>();
  private lastFailure: string | null = null;

  constructor(private readonly opts: JwksOidcVerifierOptions) {
    if (!/^[a-z][a-z0-9-]{2,63}$/.test(opts.integrationId)) throw new ValidationError("OIDC_INTEGRATION_ID_INVALID");
    if (opts.issuers.length === 0 || opts.issuers.length > 8) throw new ValidationError("OIDC_ISSUERS_INVALID");
    for (const i of opts.issuers) {
      const httpsOk = (u: string) => /^https:\/\/[A-Za-z0-9.-]{1,253}(:\d{2,5})?(\/[A-Za-z0-9._~/%-]*)?$/.test(u);
      const loopbackOk = (u: string) => opts.allowLoopbackHttp === true && LOOPBACK.test(u);
      if (!(httpsOk(i.issuer) || loopbackOk(i.issuer)) || !(httpsOk(i.jwksUri) || loopbackOk(i.jwksUri))) throw new ValidationError("OIDC_ISSUER_URL_INVALID");
      if (!/^[A-Za-z0-9._:-]{3,256}$/.test(i.audience)) throw new ValidationError("OIDC_AUDIENCE_INVALID");
    }
    if (new Set(opts.issuers.map((i) => i.issuer)).size !== opts.issuers.length) throw new ValidationError("OIDC_ISSUERS_DUPLICATE");
    this.integrationId = opts.integrationId;
    this.policy = { ...DEFAULT_OIDC_POLICY, ...opts.policy };
    if (this.policy.algorithms.length === 0 || this.policy.algorithms.some((a) => !SUPPORTED_ID_TOKEN_ALGORITHMS.includes(a))) {
      throw new ValidationError("OIDC_ALGORITHMS_INVALID");
    }
  }

  /**
   * Live verifier whose keys come from each issuer's DISCOVERED JWKS (OidcDiscovery: exact issuer match,
   * pinned https endpoints, fail-closed cache, unknown-kid refetch) through the egress-classified transport.
   * Preferred over a configured JWKS URI (FO-05-07): the URI is never typed by hand.
   */
  static fromDiscovery(opts: {
    integrationId: string;
    clock: Clock;
    providers: readonly { discovery: Pick<OidcDiscovery, "issuer" | "keyResolver">; audience: string }[];
    policy?: Partial<OidcVerificationPolicy>;
  }): JwksOidcVerifier {
    const byIssuer = new Map(opts.providers.map((p) => [p.discovery.issuer, p.discovery] as const));
    return new JwksOidcVerifier({
      integrationId: opts.integrationId,
      clock: opts.clock,
      ...(opts.policy ? { policy: opts.policy } : {}),
      // The JWKS URI here is informational only: keys are resolved through discovery.
      issuers: opts.providers.map((p) => ({ issuer: p.discovery.issuer, audience: p.audience, jwksUri: `${p.discovery.issuer.replace(/\/$/, "")}/.well-known/openid-configuration` })),
      keyResolverFactory: (issuer) => {
        const d = byIssuer.get(issuer.issuer);
        if (!d) throw new ValidationError("OIDC_ISSUER_NOT_DISCOVERED");
        return d.keyResolver();
      },
    });
  }

  async health(): Promise<AdapterHealth> {
    return { healthy: this.lastFailure === null, reasonCode: this.lastFailure };
  }

  async verifyIdToken(idToken: string, expected: { nonce: string; maxAuthAgeSeconds: number }): Promise<OidcClaims> {
    try {
      const claims = await verifyIdTokenCore(idToken, expected, {
        issuers: this.opts.issuers,
        resolverFor: (i) => this.resolverFor(i),
        clock: this.opts.clock,
        policy: this.policy,
      });
      this.lastFailure = null;
      return claims;
    } catch (err) {
      if (err instanceof DependencyError) this.lastFailure = err.reasonCode;
      throw err;
    }
  }

  private resolverFor(issuer: TrustedIssuer): JWTVerifyGetKey {
    const cached = this.resolvers.get(issuer.issuer);
    if (cached) return cached;
    let resolver: JWTVerifyGetKey;
    if (this.opts.keyResolverFactory) {
      resolver = this.opts.keyResolverFactory(issuer);
    } else {
      const remote = this.opts.remote ?? {};
      resolver = createRemoteJWKSet(new URL(issuer.jwksUri), {
        timeoutDuration: remote.timeoutMs ?? 2_500,
        cooldownDuration: remote.cooldownMs ?? 30_000,
        cacheMaxAge: remote.cacheMaxAgeMs ?? 600_000,
        ...(remote.fetch ? { [customFetch]: remote.fetch } : {}),
      });
    }
    this.resolvers.set(issuer.issuer, resolver);
    return resolver;
  }
}
