/**
 * HTTP exchanges with an OpenID Connect provider (WP-05; follow-on FO-05-07, FO-05-09, FO-05-19,
 * FO-14-52; AUTH-01, AUTH-06, DATA-01).
 *
 * Every request goes through the egress-classified connector transport (platform/src/connectors/http):
 * https only, the host must be in the IdP destination's exact allowlist, the EgressGuard approves the
 * payload class per request, DNS answers are classified and pinned, redirects are refused and response
 * bodies are bounded. Classes: discovery and JWKS reads carry nothing (PUBLIC); a token, introspection
 * or revocation request carries an authorization code, a PKCE verifier, a refresh token or the client's
 * own credential (VERIFICATION_SECRET, which the EgressGuard sends only to a VERIFICATION_SERVICE
 * destination with an approval id, AUTH-06).
 *
 * Failures are reason-coded and never carry a token, a code or a provider message:
 *   - the egress policy refuses the URL                  ConfigurationRejectedError OIDC_EGRESS_REFUSED (never
 *                                                         retried, never reported as an outage: the configured
 *                                                         issuer or a discovered endpoint cannot be reached under
 *                                                         the egress policy, e.g. its path looks like PHI to the
 *                                                         URL heuristic); checked at construction for the
 *                                                         issuer's discovery URL (`preflight`)
 *   - nothing sent (DNS, connect, TLS)                   OIDC_PROVIDER_UNAVAILABLE, NOT_STARTED
 *   - a single-use grant sent, no answer                 OIDC_PROVIDER_OUTCOME_UNKNOWN, UNKNOWN (never retried:
 *                                                         an authorization code or rotated refresh token may be spent)
 *   - a read sent, no answer / 5xx                       OIDC_PROVIDER_UNAVAILABLE, FAILED
 *   - a body that is not the expected JSON               OIDC_PROVIDER_RESPONSE_INVALID
 */
import type { DestinationPolicy, TransportRequest, TransportResponse } from "../../connectors/http/transport.js";
import { TransportError } from "../../connectors/http/transport.js";
import { OIDC_REQUEST_TIMEOUT_MAX_MS } from "../../protocol/index.js";
import type { Classification } from "../../protocol/index.js";
import { AccessDeniedError, ConfigurationRejectedError, DependencyError, PlatformError, ValidationError } from "../../shared/errors.js";

/** The part of ConnectorHttpTransport the OIDC client uses (the production transport satisfies it). */
export interface OidcTransport {
  send(req: TransportRequest): Promise<TransportResponse>;
}

/**
 * The egress decision the transport applies per request (structurally the platform EgressGuard's `check`; the
 * composition passes the same guard instance it gives the transport). Used to refuse an unreachable issuer at
 * construction instead of at the first sign-in.
 */
export interface OidcEgressCheck {
  check(target: URL, dataClass: Classification): { allowed: boolean; reasonCode: string };
}

/** Reason code of an egress-policy refusal of an IdP URL (a configuration refusal, never an outage). */
export const OIDC_EGRESS_REFUSED = "OIDC_EGRESS_REFUSED";

/** `ConfigurationRejectedError` naming the refused endpoint and the egress reason: never retryable. */
export function oidcEgressRefusal(endpoint: string, egressReasonCode: string): ConfigurationRejectedError {
  return new ConfigurationRejectedError([`${OIDC_EGRESS_REFUSED}@identity_provider.${endpoint}:${egressReasonCode}`]);
}

/** True for the configuration refusal of `oidcEgressRefusal` (as opposed to an outage or a refused token). */
export function isOidcEgressRefusal(err: unknown): err is ConfigurationRejectedError {
  return err instanceof ConfigurationRejectedError && err.violations.some((v) => v.startsWith(`${OIDC_EGRESS_REFUSED}@`));
}

/** Where the provider's endpoints may live: exact hosts and the address class they must resolve to. */
export interface OidcDestination {
  allowedHosts: readonly string[];
  addressClass: DestinationPolicy["addressClass"];
}

export interface OidcHttpOptions {
  transport: OidcTransport;
  /** The EgressGuard the transport applies (same instance): construction-time checks of the issuer's URLs. */
  egress: OidcEgressCheck;
  destination: OidcDestination;
  /** Per-request deadline (default 5 s, at most OIDC_REQUEST_TIMEOUT_MAX_MS). */
  timeoutMs?: number;
  /** Metrics label of the transport (allowlisted there; others become "other"). */
  dependency?: string;
}

const MAX_JSON_BYTES = 262_144;
const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export interface OidcFormResponse {
  status: number;
  body: Record<string, unknown>;
}

function parseJsonObject(res: TransportResponse): Record<string, unknown> {
  const type = (res.headers["content-type"] ?? "").toLowerCase();
  if (!type.startsWith("application/json") && !type.startsWith("application/jwk-set+json")) throw new DependencyError("OIDC_PROVIDER_RESPONSE_INVALID", "FAILED", false);
  if (res.body.length > MAX_JSON_BYTES) throw new DependencyError("OIDC_PROVIDER_RESPONSE_INVALID", "FAILED", false);
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.body.toString("utf8"));
  } catch {
    throw new DependencyError("OIDC_PROVIDER_RESPONSE_INVALID", "FAILED", false);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new DependencyError("OIDC_PROVIDER_RESPONSE_INVALID", "FAILED", false);
  return parsed as Record<string, unknown>;
}

/** Maps a transport failure onto the OIDC client's reason codes (the request may have been a single-use grant). */
function mapTransportError(err: unknown, sideEffect: boolean, endpoint: string): PlatformError {
  if (err instanceof TransportError) {
    if (!err.requestSent) return new DependencyError("OIDC_PROVIDER_UNAVAILABLE", "NOT_STARTED", err.retryable);
    if (sideEffect) return new DependencyError("OIDC_PROVIDER_OUTCOME_UNKNOWN", "UNKNOWN", false);
    return new DependencyError("OIDC_PROVIDER_UNAVAILABLE", "FAILED", true);
  }
  // The EgressGuard refuses before any socket exists: the provider was never contacted, and asking again
  // cannot change the answer. A configuration refusal, distinct from an outage (never OIDC_*_UNAVAILABLE).
  if (err instanceof AccessDeniedError) return oidcEgressRefusal(endpoint, /^[A-Z][A-Z0-9_]{2,63}$/.test(err.reasonCode) ? err.reasonCode : "EGRESS_DENIED");
  if (err instanceof ValidationError) return err;
  return new DependencyError("OIDC_PROVIDER_UNAVAILABLE", "NOT_STARTED", false);
}

export class OidcHttp {
  private readonly opts: OidcHttpOptions;
  private readonly timeoutMs: number;

  constructor(opts: OidcHttpOptions) {
    if (opts.destination.allowedHosts.length === 0 || opts.destination.allowedHosts.length > 8 || !opts.destination.allowedHosts.every((h) => HOST.test(h))) {
      throw new ValidationError("OIDC_DESTINATION_INVALID");
    }
    if (typeof opts.egress?.check !== "function") throw new ValidationError("OIDC_EGRESS_CHECK_REQUIRED");
    const timeoutMs = opts.timeoutMs ?? 5_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > OIDC_REQUEST_TIMEOUT_MAX_MS) throw new ValidationError("OIDC_TIMEOUT_INVALID");
    this.opts = opts;
    this.timeoutMs = timeoutMs;
  }

  /**
   * Refuses (ConfigurationRejectedError OIDC_EGRESS_REFUSED) a URL the egress policy would refuse for `dataClass`,
   * without any I/O: lets the discovery refuse an unusable issuer at construction and a discovered endpoint at
   * validation, instead of at the first request (where it would otherwise look like an outage).
   */
  preflight(url: URL, dataClass: "PUBLIC" | "VERIFICATION_SECRET", endpoint: string): void {
    let decision: { allowed: boolean; reasonCode: string };
    try {
      decision = this.opts.egress.check(url, dataClass);
    } catch {
      throw oidcEgressRefusal(endpoint, "EGRESS_CHECK_FAILED");
    }
    if (!decision.allowed) throw oidcEgressRefusal(endpoint, /^[A-Z][A-Z0-9_]{2,63}$/.test(decision.reasonCode) ? decision.reasonCode : "EGRESS_DENIED");
  }

  /** True when `url` is https on an allowed host (no userinfo, no fragment). Used to pin discovered endpoints. */
  allows(url: URL): boolean {
    return url.protocol === "https:" && !url.username && !url.password && !url.hash && this.opts.destination.allowedHosts.includes(url.hostname.toLowerCase());
  }

  private policy(dataClass: "PUBLIC" | "VERIFICATION_SECRET"): DestinationPolicy {
    return { allowedHosts: this.opts.destination.allowedHosts, addressClass: this.opts.destination.addressClass, dataClass };
  }

  /** GET of a public JSON document (discovery metadata, JWKS). Status must be 200. */
  async getJson(url: URL, endpoint = "document"): Promise<Record<string, unknown>> {
    if (!this.allows(url)) throw new DependencyError("OIDC_ENDPOINT_NOT_ALLOWED", "NOT_STARTED", false);
    let res: TransportResponse;
    try {
      res = await this.opts.transport.send({
        method: "GET",
        url,
        headers: { accept: "application/json" },
        body: null,
        policy: this.policy("PUBLIC"),
        sideEffect: false,
        timeoutMs: this.timeoutMs,
        dependency: this.opts.dependency ?? "identity_provider",
      });
    } catch (err) {
      throw mapTransportError(err, false, endpoint);
    }
    if (res.status >= 500 || res.status === 429) throw new DependencyError("OIDC_PROVIDER_UNAVAILABLE", "FAILED", true);
    if (res.status !== 200) throw new DependencyError("OIDC_PROVIDER_RESPONSE_INVALID", "FAILED", false);
    return parseJsonObject(res);
  }

  /**
   * POST of an `application/x-www-form-urlencoded` body (token, introspection, revocation). Returns the
   * status and the JSON object of any 2xx or 4xx answer (OAuth errors are JSON 400/401); a 5xx is a
   * dependency failure. `sideEffect` marks single-use grants (authorization code, rotating refresh
   * token): a failure after the request was sent is UNKNOWN and must not be retried.
   */
  async postForm(url: URL, form: URLSearchParams, headers: Readonly<Record<string, string>>, opts: { sideEffect: boolean; expectBody: boolean; endpoint?: string }): Promise<OidcFormResponse> {
    if (!this.allows(url)) throw new DependencyError("OIDC_ENDPOINT_NOT_ALLOWED", "NOT_STARTED", false);
    let res: TransportResponse;
    try {
      res = await this.opts.transport.send({
        method: "POST",
        url,
        headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded", ...headers },
        body: form.toString(),
        policy: this.policy("VERIFICATION_SECRET"),
        sideEffect: opts.sideEffect,
        timeoutMs: this.timeoutMs,
        dependency: this.opts.dependency ?? "identity_provider",
      });
    } catch (err) {
      throw mapTransportError(err, opts.sideEffect, opts.endpoint ?? "form_endpoint");
    }
    if (res.status >= 500 || res.status === 429) {
      throw opts.sideEffect ? new DependencyError("OIDC_PROVIDER_OUTCOME_UNKNOWN", "UNKNOWN", false) : new DependencyError("OIDC_PROVIDER_UNAVAILABLE", "FAILED", true);
    }
    if (!opts.expectBody && res.status >= 200 && res.status < 300) return { status: res.status, body: {} };
    if (res.status < 200 || (res.status >= 300 && res.status < 400) || res.status >= 500) throw new DependencyError("OIDC_PROVIDER_RESPONSE_INVALID", "FAILED", false);
    return { status: res.status, body: parseJsonObject(res) };
  }
}
