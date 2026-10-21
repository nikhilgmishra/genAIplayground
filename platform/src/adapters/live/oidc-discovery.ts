/**
 * OpenID Connect issuer discovery and the issuer's signing keys (WP-05; follow-on FO-05-07, FO-05-12,
 * FO-03-28; OpenID Connect Discovery 1.0 sections 4 and 4.3, RFC 8414).
 *
 * `OidcDiscovery.provider()`:
 *   - fetches `<issuer>/.well-known/openid-configuration` through the egress-classified transport
 *     (`OidcHttp`: https only, exact host allowlist, pinned DNS, no redirects);
 *   - requires `metadata.issuer` to equal the configured issuer EXACTLY (no normalisation, no trailing
 *     slash leniency: a mix-up or a substituted document is refused, OIDC_ISSUER_MISMATCH);
 *   - pins the endpoints it uses (authorization, token, JWKS, and the optional introspection, revocation
 *     and end-session endpoints): each must be https on an allowed host, otherwise the document is refused;
 *   - requires the authorization-code response type, PKCE S256 when the client uses the code flow, and at
 *     least one asymmetric ID-token signing algorithm (`none` and HMAC never count);
 *   - caches the validated metadata for `ttlSeconds` and FAILS CLOSED on any fetch or validation error:
 *     an expired cache entry is never served after a failed refresh (OIDC_DISCOVERY_UNAVAILABLE);
 *   - tells a configuration that cannot work apart from an outage: the issuer's discovery URL is checked
 *     against the egress policy at construction, and every discovered endpoint the server calls (token,
 *     introspection, revocation, JWKS) at validation; a refusal is a ConfigurationRejectedError
 *     OIDC_EGRESS_REFUSED (never retryable, never OIDC_*_UNAVAILABLE; `health()` reports OIDC_EGRESS_REFUSED);
 *   - accepts rotated metadata (a new JWKS or token endpoint) on the next refresh when it passes the same
 *     checks, and drops the key cache of a JWKS URI that changed.
 *
 * `keyResolver()` is a jose `JWTVerifyGetKey` over the discovered `jwks_uri`: the JWKS is fetched through
 * the same transport, refused when it holds private key material or no usable key, cached for
 * `jwksTtlSeconds`, and refetched when a token names an unknown `kid` (key rotation, FO-05-12) at most
 * once per `jwksRefetchCooldownSeconds`. Fetch failures are DependencyError OIDC_JWKS_UNAVAILABLE (a
 * dependency failure, never confused with an invalid token).
 */
import { createLocalJWKSet } from "jose";
import type { JSONWebKeySet, JWTVerifyGetKey } from "jose";
import { z } from "zod";
import type { Logger } from "../../observability/ports.js";
import { silentLogger } from "../../observability/logger.js";
import { sha256Hex } from "../../shared/canonical.js";
import type { Clock } from "../../shared/clock.js";
import { AccessDeniedError, DependencyError, PlatformError, ValidationError } from "../../shared/errors.js";
import type { AdapterHealth } from "../ports.js";
import { OIDC_EGRESS_REFUSED, isOidcEgressRefusal } from "./oidc-http.js";
import type { OidcHttp } from "./oidc-http.js";

/** Signing algorithms an ID token may use (asymmetric only). */
export const ASYMMETRIC_ID_TOKEN_ALGORITHMS = ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512", "EdDSA"] as const;

export interface DiscoveredProvider {
  issuer: string;
  authorizationEndpoint: URL;
  tokenEndpoint: URL;
  jwksUri: URL;
  introspectionEndpoint: URL | null;
  revocationEndpoint: URL | null;
  endSessionEndpoint: URL | null;
  codeChallengeMethods: string[];
  tokenEndpointAuthMethods: string[];
  idTokenSigningAlgorithms: string[];
  /** sha256 over the pinned endpoint set (rotation evidence; content-free). */
  metadataDigest: string;
  fetchedAt: Date;
}

export interface OidcDiscoveryOptions {
  /** Exact issuer identifier (https URL without query or fragment). */
  issuer: string;
  http: OidcHttp;
  clock: Clock;
  /** Metadata cache lifetime (default 900 s, 60..86 400). */
  ttlSeconds?: number;
  /** JWKS cache lifetime (default 600 s, 30..86 400). */
  jwksTtlSeconds?: number;
  /** Minimum spacing of unknown-kid refetches (default 30 s). */
  jwksRefetchCooldownSeconds?: number;
  /** The client uses the authorization-code flow: S256 PKCE must be advertised (default true). */
  requirePkceS256?: boolean;
  logger?: Logger;
}

const ISSUER = /^https:\/\/[A-Za-z0-9.-]{1,253}(:\d{2,5})?(\/[A-Za-z0-9._~/%-]*)?$/;

/** Only the fields the platform relies on; other metadata is ignored (and never logged). */
const Metadata = z.object({
  issuer: z.string().min(8).max(512),
  authorization_endpoint: z.string().min(8).max(1024),
  token_endpoint: z.string().min(8).max(1024),
  jwks_uri: z.string().min(8).max(1024),
  introspection_endpoint: z.string().min(8).max(1024).optional(),
  revocation_endpoint: z.string().min(8).max(1024).optional(),
  end_session_endpoint: z.string().min(8).max(1024).optional(),
  response_types_supported: z.array(z.string().max(64)).min(1).max(64),
  code_challenge_methods_supported: z.array(z.string().max(16)).max(16).optional(),
  token_endpoint_auth_methods_supported: z.array(z.string().max(64)).max(32).optional(),
  id_token_signing_alg_values_supported: z.array(z.string().max(16)).min(1).max(64),
});

const PRIVATE_JWK_MEMBERS = ["d", "p", "q", "dp", "dq", "qi", "k", "oth"] as const;

const Jwks = z.object({
  keys: z
    .array(
      z
        .object({ kty: z.string().min(1).max(8), kid: z.string().min(1).max(256).optional(), use: z.string().max(8).optional(), alg: z.string().max(16).optional() })
        .passthrough(),
    )
    .min(1)
    .max(64),
});

const refuse = (reasonCode: string): never => {
  throw new AccessDeniedError(reasonCode);
};

function discoveryUrlFor(issuer: string): URL {
  // OpenID Connect Discovery 4: the issuer with any terminating "/" removed, then the well-known path.
  return new URL(`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`);
}

interface KeyCache {
  uri: string;
  resolver: JWTVerifyGetKey;
  fetchedAt: number;
}

export class OidcDiscovery {
  readonly issuer: string;
  private readonly opts: OidcDiscoveryOptions;
  private readonly ttlMs: number;
  private readonly jwksTtlMs: number;
  private readonly cooldownMs: number;
  private readonly logger: Logger;
  private cached: DiscoveredProvider | null = null;
  private inflight: Promise<DiscoveredProvider> | null = null;
  private keys: KeyCache | null = null;
  private keysInflight: Promise<KeyCache> | null = null;
  private lastForcedKeyFetch = Number.NEGATIVE_INFINITY;
  private lastFailure: string | null = null;

  constructor(opts: OidcDiscoveryOptions) {
    if (!ISSUER.test(opts.issuer)) throw new ValidationError("OIDC_ISSUER_URL_INVALID");
    const issuerUrl = new URL(opts.issuer);
    if (!opts.http.allows(issuerUrl)) throw new ValidationError("OIDC_ISSUER_HOST_NOT_ALLOWED");
    // A discovery URL the egress policy refuses can never be fetched: refused here as configuration
    // (ConfigurationRejectedError OIDC_EGRESS_REFUSED), not discovered later as a phantom IdP outage.
    opts.http.preflight(discoveryUrlFor(opts.issuer), "PUBLIC", "discovery");
    const ttl = opts.ttlSeconds ?? 900;
    const jwksTtl = opts.jwksTtlSeconds ?? 600;
    const cooldown = opts.jwksRefetchCooldownSeconds ?? 30;
    if (!Number.isInteger(ttl) || ttl < 60 || ttl > 86_400) throw new ValidationError("OIDC_DISCOVERY_TTL_INVALID");
    if (!Number.isInteger(jwksTtl) || jwksTtl < 30 || jwksTtl > 86_400) throw new ValidationError("OIDC_JWKS_TTL_INVALID");
    if (!Number.isInteger(cooldown) || cooldown < 0 || cooldown > 3_600) throw new ValidationError("OIDC_JWKS_COOLDOWN_INVALID");
    this.issuer = opts.issuer;
    this.opts = opts;
    this.ttlMs = ttl * 1000;
    this.jwksTtlMs = jwksTtl * 1000;
    this.cooldownMs = cooldown * 1000;
    this.logger = (opts.logger ?? silentLogger).child({ component: "identity.oidc_discovery" });
  }

  async health(): Promise<AdapterHealth> {
    return { healthy: this.lastFailure === null, reasonCode: this.lastFailure };
  }

  /** Validated provider metadata (cached; refreshed after the TTL; fails closed). */
  async provider(): Promise<DiscoveredProvider> {
    const now = this.opts.clock.now().getTime();
    if (this.cached && now - this.cached.fetchedAt.getTime() < this.ttlMs) return this.cached;
    if (!this.inflight) {
      this.inflight = this.fetchProvider().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  /** Drops the cached metadata and keys (operator-triggered refresh, or after an issuer configuration change). */
  invalidate(): void {
    this.cached = null;
    this.keys = null;
  }

  private async fetchProvider(): Promise<DiscoveredProvider> {
    let raw: Record<string, unknown>;
    try {
      raw = await this.opts.http.getJson(discoveryUrlFor(this.issuer), "discovery");
    } catch (err) {
      // Fail closed: an expired entry is never served after a failed refresh.
      this.cached = null;
      if (isOidcEgressRefusal(err)) throw this.recordFailure(err, OIDC_EGRESS_REFUSED);
      return this.fail("OIDC_DISCOVERY_UNAVAILABLE", err);
    }
    let provider: DiscoveredProvider;
    try {
      provider = this.validate(raw);
    } catch (err) {
      this.cached = null;
      if (isOidcEgressRefusal(err)) throw this.recordFailure(err, OIDC_EGRESS_REFUSED);
      throw this.recordFailure(err instanceof PlatformError ? err : new AccessDeniedError("OIDC_DISCOVERY_INVALID"));
    }
    const previous = this.cached;
    if (previous && previous.metadataDigest !== provider.metadataDigest) {
      this.logger.info("identity.oidc.discovery.rotated", { reasonCode: "OIDC_METADATA_ROTATED", digest: provider.metadataDigest });
    }
    if (this.keys && this.keys.uri !== provider.jwksUri.href) this.keys = null;
    this.cached = provider;
    this.lastFailure = null;
    return provider;
  }

  private validate(raw: Record<string, unknown>): DiscoveredProvider {
    const m = Metadata.safeParse(raw);
    if (!m.success) return refuse("OIDC_DISCOVERY_INVALID");
    const doc = m.data;
    if (doc.issuer !== this.issuer) return refuse("OIDC_ISSUER_MISMATCH");
    // `serverClass`: the data class the SERVER sends there (null: only the browser goes there), checked against
    // the egress policy now so an endpoint it refuses is a configuration refusal, not a later "outage".
    const endpoint = (value: string | undefined, required: boolean, name: string, serverClass: "PUBLIC" | "VERIFICATION_SECRET" | null): URL | null => {
      if (value === undefined) return required ? refuse("OIDC_DISCOVERY_ENDPOINT_MISSING") : null;
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        return refuse("OIDC_DISCOVERY_ENDPOINT_INVALID");
      }
      if (url.protocol !== "https:") return refuse("OIDC_DISCOVERY_ENDPOINT_NOT_HTTPS");
      if (!this.opts.http.allows(url)) return refuse("OIDC_DISCOVERY_ENDPOINT_NOT_ALLOWED");
      if (serverClass !== null) this.opts.http.preflight(url, serverClass, name);
      return url;
    };
    const authorizationEndpoint = endpoint(doc.authorization_endpoint, true, "authorization", null) as URL;
    const tokenEndpoint = endpoint(doc.token_endpoint, true, "token", "VERIFICATION_SECRET") as URL;
    const jwksUri = endpoint(doc.jwks_uri, true, "jwks", "PUBLIC") as URL;
    const introspectionEndpoint = endpoint(doc.introspection_endpoint, false, "introspection", "VERIFICATION_SECRET");
    const revocationEndpoint = endpoint(doc.revocation_endpoint, false, "revocation", "VERIFICATION_SECRET");
    const endSessionEndpoint = endpoint(doc.end_session_endpoint, false, "end_session", null);
    if (!doc.response_types_supported.includes("code")) refuse("OIDC_CODE_FLOW_UNSUPPORTED");
    const pkce = doc.code_challenge_methods_supported ?? [];
    if ((this.opts.requirePkceS256 ?? true) && !pkce.includes("S256")) refuse("OIDC_PKCE_S256_UNSUPPORTED");
    const algs = doc.id_token_signing_alg_values_supported.filter((a) => (ASYMMETRIC_ID_TOKEN_ALGORITHMS as readonly string[]).includes(a));
    if (algs.length === 0) refuse("OIDC_SIGNING_ALGORITHMS_UNSUPPORTED");
    const pinned = {
      issuer: doc.issuer,
      authorizationEndpoint: authorizationEndpoint.href,
      tokenEndpoint: tokenEndpoint.href,
      jwksUri: jwksUri.href,
      introspectionEndpoint: introspectionEndpoint?.href ?? null,
      revocationEndpoint: revocationEndpoint?.href ?? null,
      endSessionEndpoint: endSessionEndpoint?.href ?? null,
    };
    return {
      issuer: doc.issuer,
      authorizationEndpoint,
      tokenEndpoint,
      jwksUri,
      introspectionEndpoint,
      revocationEndpoint,
      endSessionEndpoint,
      codeChallengeMethods: [...pkce],
      tokenEndpointAuthMethods: [...(doc.token_endpoint_auth_methods_supported ?? ["client_secret_basic"])],
      idTokenSigningAlgorithms: algs,
      metadataDigest: sha256Hex(JSON.stringify(pinned)),
      fetchedAt: this.opts.clock.now(),
    };
  }

  /**
   * jose key resolver over the discovered JWKS. An unknown `kid` triggers one refetch (rotation),
   * spaced by the cooldown; every fetch failure is a DependencyError (OIDC_JWKS_UNAVAILABLE).
   */
  keyResolver(): JWTVerifyGetKey {
    return async (header, token) => {
      const current = await this.keySet(false);
      try {
        return await current.resolver(header, token);
      } catch (err) {
        if ((err as { code?: unknown } | null)?.code !== "ERR_JWKS_NO_MATCHING_KEY") throw err;
        const now = this.opts.clock.now().getTime();
        if (now - this.lastForcedKeyFetch < this.cooldownMs) throw err;
        this.lastForcedKeyFetch = now;
        const refreshed = await this.keySet(true);
        return refreshed.resolver(header, token);
      }
    };
  }

  private async keySet(force: boolean): Promise<KeyCache> {
    const provider = await this.provider();
    const now = this.opts.clock.now().getTime();
    const k = this.keys;
    if (!force && k && k.uri === provider.jwksUri.href && now - k.fetchedAt < this.jwksTtlMs) return k;
    if (!this.keysInflight) {
      this.keysInflight = this.fetchKeys(provider.jwksUri).finally(() => {
        this.keysInflight = null;
      });
    }
    return this.keysInflight;
  }

  private async fetchKeys(uri: URL): Promise<KeyCache> {
    let raw: Record<string, unknown>;
    try {
      raw = await this.opts.http.getJson(uri, "jwks");
    } catch (err) {
      if (isOidcEgressRefusal(err)) throw this.recordFailure(err, OIDC_EGRESS_REFUSED);
      return this.fail("OIDC_JWKS_UNAVAILABLE", err);
    }
    const parsed = Jwks.safeParse(raw);
    if (!parsed.success) return this.fail("OIDC_JWKS_UNAVAILABLE", null);
    // A published key set never carries private material; a document that does is not trusted at all.
    if (parsed.data.keys.some((key) => PRIVATE_JWK_MEMBERS.some((m) => Object.hasOwn(key, m)))) return this.fail("OIDC_JWKS_PRIVATE_KEY_PUBLISHED", null);
    const signing = parsed.data.keys.filter((key) => key.use === undefined || key.use === "sig");
    if (signing.length === 0) return this.fail("OIDC_JWKS_UNAVAILABLE", null);
    let resolver: JWTVerifyGetKey;
    try {
      resolver = createLocalJWKSet({ keys: signing } as JSONWebKeySet);
    } catch {
      return this.fail("OIDC_JWKS_UNAVAILABLE", null);
    }
    const cache: KeyCache = { uri: uri.href, resolver, fetchedAt: this.opts.clock.now().getTime() };
    this.keys = cache;
    return cache;
  }

  private recordFailure(err: PlatformError, reasonCode: string = err.reasonCode): PlatformError {
    this.lastFailure = reasonCode;
    this.logger.warn("identity.oidc.discovery.failed", { reasonCode });
    return err;
  }

  private fail(reasonCode: string, cause: unknown): never {
    const outcome = cause instanceof DependencyError ? cause.outcome : "NOT_STARTED";
    throw this.recordFailure(new DependencyError(reasonCode, outcome === "UNKNOWN" ? "FAILED" : outcome, true));
  }
}
