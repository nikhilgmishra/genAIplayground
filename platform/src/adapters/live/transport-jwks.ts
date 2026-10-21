/**
 * JWKS key resolver over the egress-classified transport (WP-07; FO-14-53, AUTH-01, DATA-01).
 *
 * The gateway's inbound authenticator (JwtAccessTokenAuthenticator) verifies the integration's access tokens
 * against the integration owner's JWKS. jose's createRemoteJWKSet would fetch the key set with the global
 * fetch, outside the egress allowlist and the address-class checks; the live composition passes this resolver
 * instead, so the JWKS request goes through OidcHttp -> ConnectorHttpTransport with the same EgressGuard as
 * every other outbound client (one egress path, no bypass).
 *
 * Behaviour (as OidcDiscovery's discovered-JWKS resolver): the key set is cached for `ttlSeconds`; an unknown
 * `kid` refetches once, spaced by `refetchCooldownSeconds` (rotation without a refetch storm); a document with
 * private key members or without a signing key is refused; every failure is a reason-coded DependencyError
 * (JWKS_UNAVAILABLE / JWKS_PRIVATE_KEY_PUBLISHED), so the authenticator answers INTEGRATION_AUTH_UNAVAILABLE
 * rather than accepting anything.
 */
import { createLocalJWKSet } from "jose";
import type { JSONWebKeySet, JWTVerifyGetKey } from "jose";
import type { Clock } from "../../shared/clock.js";
import { DependencyError, ValidationError } from "../../shared/errors.js";
import type { OidcHttp } from "./oidc-http.js";

const PRIVATE_JWK_MEMBERS = ["d", "p", "q", "dp", "dq", "qi", "k", "oth"] as const;

export interface TransportJwksOptions {
  http: OidcHttp;
  jwksUri: string;
  clock: Clock;
  /** Key-set cache lifetime (default 600 s, 30..86 400). */
  ttlSeconds?: number;
  /** Minimum spacing of unknown-kid refetches (default 30 s). */
  refetchCooldownSeconds?: number;
}

interface Cache {
  resolver: JWTVerifyGetKey;
  fetchedAt: number;
}

export function transportJwksResolver(opts: TransportJwksOptions): JWTVerifyGetKey {
  let uri: URL;
  try {
    uri = new URL(opts.jwksUri);
  } catch {
    throw new ValidationError("JWKS_URI_INVALID");
  }
  if (uri.protocol !== "https:" || uri.username || uri.password || uri.hash) throw new ValidationError("JWKS_URI_INVALID");
  if (!opts.http.allows(uri)) throw new ValidationError("JWKS_URI_NOT_ALLOWED");
  // A key set is public: refuse at composition when the egress policy would refuse it (configuration error,
  // not a later "outage").
  opts.http.preflight(uri, "PUBLIC", "jwks");
  const ttlMs = (opts.ttlSeconds ?? 600) * 1000;
  const cooldownMs = (opts.refetchCooldownSeconds ?? 30) * 1000;
  if (ttlMs < 30_000 || ttlMs > 86_400_000 || cooldownMs < 0) throw new ValidationError("JWKS_CACHE_INVALID");
  let cache: Cache | null = null;
  let inflight: Promise<Cache> | null = null;
  let lastForced = Number.NEGATIVE_INFINITY;

  const fetchKeys = async (): Promise<Cache> => {
    let raw: Record<string, unknown>;
    try {
      raw = await opts.http.getJson(uri, "jwks");
    } catch (err) {
      cache = null;
      throw err instanceof DependencyError ? new DependencyError("JWKS_UNAVAILABLE", err.outcome === "UNKNOWN" ? "FAILED" : err.outcome, true) : err;
    }
    const keys = (raw as { keys?: unknown }).keys;
    if (!Array.isArray(keys) || keys.length === 0 || keys.length > 64 || !keys.every((k) => typeof k === "object" && k !== null && typeof (k as { kty?: unknown }).kty === "string")) {
      throw new DependencyError("JWKS_UNAVAILABLE", "FAILED", true);
    }
    if (keys.some((k) => PRIVATE_JWK_MEMBERS.some((m) => Object.hasOwn(k as object, m)))) throw new DependencyError("JWKS_PRIVATE_KEY_PUBLISHED", "FAILED", false);
    const signing = keys.filter((k) => {
      const use = (k as { use?: unknown }).use;
      return use === undefined || use === "sig";
    });
    if (signing.length === 0) throw new DependencyError("JWKS_UNAVAILABLE", "FAILED", true);
    let resolver: JWTVerifyGetKey;
    try {
      resolver = createLocalJWKSet({ keys: signing } as JSONWebKeySet);
    } catch {
      throw new DependencyError("JWKS_UNAVAILABLE", "FAILED", true);
    }
    cache = { resolver, fetchedAt: opts.clock.now().getTime() };
    return cache;
  };

  const keySet = (force: boolean): Promise<Cache> => {
    const now = opts.clock.now().getTime();
    if (!force && cache && now - cache.fetchedAt < ttlMs) return Promise.resolve(cache);
    inflight ??= fetchKeys().finally(() => {
      inflight = null;
    });
    return inflight;
  };

  return async (header, token) => {
    const current = await keySet(false);
    try {
      return await current.resolver(header, token);
    } catch (err) {
      if ((err as { code?: unknown } | null)?.code !== "ERR_JWKS_NO_MATCHING_KEY") throw err;
      const now = opts.clock.now().getTime();
      if (now - lastForced < cooldownMs) throw err;
      lastForced = now;
      const refreshed = await keySet(true);
      return refreshed.resolver(header, token);
    }
  };
}
