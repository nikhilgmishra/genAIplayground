/**
 * Shared token manager of the connector runtime (WP-06; FO-06-03, FO-06-14, FO-06-13, FO-15-26;
 * AUTH-02, AUTH-04, AUTH-06).
 *
 * One manager per connector; tokens are cached per capability credential (least privilege: the read
 * and write identities never share a token). Documented schemes:
 *   OAUTH2_CLIENT_CREDENTIALS  RFC 6749 section 4.4; client_secret_post or client_secret_basic;
 *   OAUTH2_JWT_BEARER          client credentials with a private_key_jwt client assertion (RFC 7523
 *                              section 2.2), signed with the key from the secret store;
 *   SIGNED_JWT_BEARER          a self-signed JWT presented directly as the bearer (key-pair schemes);
 *   API_KEY_HEADER             a static key in a declared header.
 * Behaviour:
 *   - cache: one in-flight request per credential; reuse until min(expires_in, tokenMaxAgeSeconds) minus a
 *     safety margin (expiry bound honoured even if the vendor advertises longer);
 *   - rotation: the secret is read from the SecretResolver on every token request, so a rotated value is
 *     used on the next request; a token endpoint that rejects the client (invalid_client) makes the
 *     manager refresh the secret once and retry with the new version only if the version changed;
 *   - rotation test: `grant(credential, op, "AWSPENDING")` authenticates with the pending version before
 *     promotion; its token is cached under its own key and never serves an AWSCURRENT request;
 *   - 401 on an API call: the caller invalidates the token and refreshes the secret, then asks once more
 *     (single refresh, no loop: the runtime enforces it);
 *   - scopes: granted scopes are compared with the credential's declared scopes; broader is refused
 *     (CONNECTOR_TOKEN_SCOPE_BROADER), narrower is flagged and only the missing-scope operations fail;
 *   - binding: when the profile says the token response reports the account or region, a mismatch
 *     refuses the token (CONNECTOR_ACCOUNT_BINDING_MISMATCH / CONNECTOR_REGION_MISMATCH).
 * Secret material and tokens are SecretValues; nothing about them is logged or put into an error.
 */
import { randomBytes } from "node:crypto";
import { SignJWT, importPKCS8 } from "jose";
import { z } from "zod";
import type { CapabilityCredential, ConnectorAuth, ConnectorProfile } from "../../protocol/connector.js";
import type { Logger, Metrics } from "../../observability/ports.js";
import { silentLogger } from "../../observability/logger.js";
import type { Clock } from "../../shared/clock.js";
import { PlatformError, ValidationError } from "../../shared/errors.js";
import { parseRetryAfter } from "../../resilience/rate-limiter.js";
import { readPointer, parsePointer } from "../dsl/pointer.js";
import type { ConnectorHttpTransport, DestinationPolicy } from "../http/transport.js";
import { TransportError } from "../http/transport.js";
import { SecretValue } from "../secrets/resolver.js";
import type { SecretResolver } from "../secrets/resolver.js";

/**
 * Version stage of a capability credential: traffic always uses AWSCURRENT; AWSPENDING is read only to
 * test a rotation before promotion (a token issued from it is cached apart and never serves traffic).
 */
export type CredentialStage = "AWSCURRENT" | "AWSPENDING";
import { ConnectorError } from "./errors.js";

export interface AuthorizationHeader {
  name: string;
  value: SecretValue;
}

export interface TokenGrant {
  readonly header: AuthorizationHeader;
  readonly expiresAtMs: number;
  /** Granted scopes (null: the scheme has none, e.g. an API key). */
  readonly grantedScopes: readonly string[] | null;
  /** Declared scopes the vendor did not grant; operations that need them are refused before I/O. */
  readonly missingScopes: readonly string[];
  /** Secrets Manager version that produced the grant (content-free, evidence). */
  readonly secretVersionId: string;
  readonly credentialRef: string;
}

export interface TokenManagerDeps {
  profile: ConnectorProfile;
  transport: ConnectorHttpTransport;
  secrets: SecretResolver;
  clock: Clock;
  metrics?: Metrics;
  logger?: Logger;
}

const MARGIN_MS = 30_000;
const TokenResponse = z
  .object({
    access_token: z.string().min(8).max(8_192),
    token_type: z.string().max(32).optional(),
    expires_in: z.union([z.number().int().min(1).max(31_536_000), z.string().regex(/^\d{1,8}$/)]).optional(),
    scope: z.string().max(4_096).optional(),
  })
  .loose();
const ClientSecretMaterial = z.strictObject({ clientId: z.string().min(1).max(512), clientSecret: z.string().min(1).max(4_096) });
const KeyMaterial = z.strictObject({
  clientId: z.string().min(1).max(512),
  subject: z.string().min(1).max(512).optional(),
  privateKeyPem: z.string().min(64).max(16_384),
  keyId: z.string().min(1).max(256).optional(),
  alg: z.enum(["RS256", "PS256", "ES256"]),
});
const ApiKeyMaterial = z.strictObject({ apiKey: z.string().min(8).max(4_096) });

function material<T>(schema: z.ZodType<T>, value: SecretValue): T {
  const r = schema.safeParse(value.json());
  if (!r.success) throw new PlatformError("CONNECTOR_SECRET_MALFORMED", "CONNECTOR_SECRET_MALFORMED", false);
  return r.data;
}

const scopeList = (s: string | undefined): string[] | null => (s === undefined ? null : [...new Set(s.split(/\s+/).filter((x) => x.length > 0))].sort());

export class TokenManager {
  private readonly cache = new Map<string, TokenGrant>();
  private readonly inFlight = new Map<string, Promise<TokenGrant>>();
  /** Bumped by invalidate(): a token request that was in flight across it is never cached. */
  private readonly generation = new Map<string, number>();
  private readonly auth: ConnectorAuth;
  private readonly logger: Logger;
  private requests = 0;

  constructor(private readonly deps: TokenManagerDeps) {
    if (!deps.profile.auth) throw new ValidationError("PROFILE_AUTH_MISSING");
    this.auth = deps.profile.auth;
    this.logger = (deps.logger ?? silentLogger).child({ component: "connector_token", integration: deps.profile.system });
  }

  /** Token requests made (tests assert caching and single refresh). */
  get tokenRequests(): number {
    return this.requests;
  }

  /**
   * Current grant for the credential, requesting one when absent or within the expiry margin. `stage`
   * AWSPENDING (a rotation test) is cached under its own key, so it never answers an AWSCURRENT request.
   */
  async grant(credential: CapabilityCredential, operation: string, stage: CredentialStage = "AWSCURRENT"): Promise<TokenGrant> {
    const key = `${credential.capability}|${credential.access}|${stage}`;
    const hit = this.cache.get(key);
    if (hit && this.deps.clock.now().getTime() < hit.expiresAtMs) return hit;
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const gen = this.generation.get(key) ?? 0;
    const p = this.issue(credential, operation, stage).finally(() => {
      if (this.inFlight.get(key) === p) this.inFlight.delete(key);
    });
    this.inFlight.set(key, p);
    const g = await p;
    // A token requested before an invalidate() (a 401, a rotation) may carry the stale secret: it answers the
    // callers that were already waiting for it, but is not cached for later ones.
    if ((this.generation.get(key) ?? 0) === gen) this.cache.set(key, g);
    return g;
  }

  /**
   * Drops the cached token of a credential (at `stage`) and its cached secret (after a 401: one refresh
   * only). A token request in flight at that moment is detached: later callers start a new one.
   */
  invalidate(credential: CapabilityCredential, stage: CredentialStage = "AWSCURRENT"): void {
    const key = `${credential.capability}|${credential.access}|${stage}`;
    this.generation.set(key, (this.generation.get(key) ?? 0) + 1);
    this.cache.delete(key);
    this.inFlight.delete(key);
    this.deps.secrets.refresh(credential.credentialRef);
  }

  private count(result: string): void {
    try {
      this.deps.metrics?.increment("vsp_connector_token_requests_total", { dependency: this.deps.profile.system, result });
    } catch {
      // metrics never change a token decision
    }
  }

  private err(reason: string, outcome: "NOT_STARTED" | "FAILED", operation: string, opts: { retryable?: boolean; httpStatus?: number | null; retryAfterMs?: number | null } = {}): ConnectorError {
    this.count(reason.toLowerCase().slice(0, 60));
    return new ConnectorError(reason, outcome, this.deps.profile.system, operation, opts);
  }

  private async issue(credential: CapabilityCredential, operation: string, stage: CredentialStage): Promise<TokenGrant> {
    let secret = await this.resolve(credential, operation, stage);
    const maxAgeMs = this.auth.tokenMaxAgeSeconds * 1000;
    switch (this.auth.scheme) {
      case "API_KEY_HEADER": {
        const m = material(ApiKeyMaterial, secret.value);
        return { header: { name: (this.auth.apiKeyHeader ?? "").toLowerCase(), value: new SecretValue(m.apiKey) }, expiresAtMs: this.deps.clock.now().getTime() + maxAgeMs, grantedScopes: null, missingScopes: [], secretVersionId: secret.versionId, credentialRef: credential.credentialRef };
      }
      case "SIGNED_JWT_BEARER": {
        const m = material(KeyMaterial, secret.value);
        const lifetime = Math.min(maxAgeMs, 3_600_000);
        const jwt = await this.sign(m, this.auth.audience ?? "", lifetime, operation);
        return { header: { name: "authorization", value: new SecretValue(`Bearer ${jwt}`) }, expiresAtMs: this.deps.clock.now().getTime() + Math.max(lifetime - MARGIN_MS, lifetime / 2), grantedScopes: null, missingScopes: [], secretVersionId: secret.versionId, credentialRef: credential.credentialRef };
      }
      case "OAUTH2_CLIENT_CREDENTIALS":
      case "OAUTH2_JWT_BEARER": {
        try {
          return await this.oauthToken(credential, secret, operation);
        } catch (e) {
          if (!(e instanceof ConnectorError) || e.reasonCode !== "CONNECTOR_TOKEN_CLIENT_REJECTED") throw e;
          // A pending version under test is the answer itself: the vendor does not accept it (yet).
          if (stage !== "AWSCURRENT") throw e;
          // The vendor no longer accepts this client secret: a rotation may have happened. Re-read once.
          this.deps.secrets.refresh(credential.credentialRef);
          const fresh = await this.resolve(credential, operation, stage);
          if (fresh.versionId === secret.versionId) throw e;
          secret = fresh;
          return this.oauthToken(credential, secret, operation);
        }
      }
    }
  }

  private async resolve(credential: CapabilityCredential, operation: string, stage: CredentialStage) {
    try {
      return await this.deps.secrets.resolve(credential.credentialRef, stage);
    } catch (e) {
      const reason = e instanceof PlatformError ? e.reasonCode : "SECRET_STORE_UNAVAILABLE";
      // Without a credential nothing was sent: NOT_STARTED; retryable only when the store itself was unavailable.
      throw this.err(reason === "SECRET_STORE_UNAVAILABLE" ? "CONNECTOR_CREDENTIAL_UNAVAILABLE" : "CONNECTOR_CREDENTIAL_INVALID", "NOT_STARTED", operation, { retryable: reason === "SECRET_STORE_UNAVAILABLE" });
    }
  }

  private async sign(m: z.infer<typeof KeyMaterial>, audience: string, lifetimeMs: number, operation: string): Promise<string> {
    try {
      const key = await importPKCS8(m.privateKeyPem, m.alg);
      const now = Math.floor(this.deps.clock.now().getTime() / 1000);
      const jwt = new SignJWT({})
        .setProtectedHeader({ alg: m.alg, typ: "JWT", ...(m.keyId ? { kid: m.keyId } : {}) })
        .setIssuer(m.clientId)
        .setSubject(m.subject ?? m.clientId)
        .setAudience(audience)
        .setIssuedAt(now)
        .setExpirationTime(now + Math.floor(lifetimeMs / 1000))
        .setJti(randomBytes(16).toString("base64url"));
      return await jwt.sign(key);
    } catch {
      throw this.err("CONNECTOR_SIGNING_KEY_INVALID", "NOT_STARTED", operation, { retryable: false });
    }
  }

  private tokenPolicy(): DestinationPolicy {
    return { allowedHosts: this.deps.profile.allowedHosts, addressClass: this.deps.profile.network?.addressClass ?? "PUBLIC_INTERNET", dataClass: "INTERNAL" };
  }

  private async oauthToken(credential: CapabilityCredential, secret: { value: SecretValue; versionId: string }, operation: string): Promise<TokenGrant> {
    const tokenUrl = this.auth.tokenUrl;
    if (tokenUrl === null) throw new ValidationError("AUTH_TOKEN_URL_MISSING");
    const form = new URLSearchParams({ grant_type: "client_credentials" });
    if (credential.scopes.length > 0) form.set("scope", credential.scopes.join(" "));
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
    if (this.auth.scheme === "OAUTH2_CLIENT_CREDENTIALS") {
      const m = material(ClientSecretMaterial, secret.value);
      if (this.auth.clientAuth === "CLIENT_SECRET_BASIC") {
        headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(m.clientId)}:${encodeURIComponent(m.clientSecret)}`).toString("base64")}`;
      } else {
        form.set("client_id", m.clientId);
        form.set("client_secret", m.clientSecret);
      }
    } else {
      const m = material(KeyMaterial, secret.value);
      form.set("client_id", m.clientId);
      form.set("client_assertion_type", "urn:ietf:params:oauth:client-assertion-type:jwt-bearer");
      form.set("client_assertion", await this.sign(m, this.auth.audience ?? tokenUrl, 60_000, operation));
    }
    this.requests += 1;
    let res;
    try {
      res = await this.deps.transport.send({
        method: "POST",
        url: new URL(tokenUrl),
        headers,
        body: form.toString(),
        policy: this.tokenPolicy(),
        sideEffect: false,
        timeoutMs: this.deps.profile.limits.timeoutMs,
        dependency: this.deps.profile.system,
      });
    } catch (e) {
      // The business request has not been sent, whatever happened to the token request.
      if (e instanceof TransportError) throw this.err(e.reasonCode === "TIMEOUT_BEFORE_SEND" || e.reasonCode === "READ_TIMEOUT" ? "TIMEOUT_BEFORE_SEND" : e.phase === "PRE_IO" ? e.reasonCode : "CONNECTION_REFUSED", "NOT_STARTED", operation, { retryable: e.phase !== "PRE_IO" });
      throw e;
    }
    const retryAfterMs = parseRetryAfter(res.headers["retry-after"], this.deps.clock.now());
    if (res.status === 429 || res.status === 503) throw this.err(res.status === 429 ? "HTTP_429" : "HTTP_503", "NOT_STARTED", operation, { httpStatus: res.status, retryAfterMs });
    if (res.status >= 500) throw this.err("CONNECTOR_TOKEN_ENDPOINT_UNAVAILABLE", "NOT_STARTED", operation, { httpStatus: res.status, retryable: true });
    if (res.status === 400 || res.status === 401) {
      const body = safeJson(res.body);
      const code = typeof body === "object" && body !== null ? (body as { error?: unknown }).error : undefined;
      if (code === "invalid_client" || res.status === 401) throw this.err("CONNECTOR_TOKEN_CLIENT_REJECTED", "NOT_STARTED", operation, { httpStatus: res.status, retryable: false });
      if (code === "invalid_scope") throw this.err("CONNECTOR_TOKEN_SCOPE_REJECTED", "NOT_STARTED", operation, { httpStatus: res.status, retryable: false });
      throw this.err("CONNECTOR_TOKEN_REQUEST_REJECTED", "NOT_STARTED", operation, { httpStatus: res.status, retryable: false });
    }
    if (res.status !== 200) throw this.err("CONNECTOR_TOKEN_REQUEST_REJECTED", "NOT_STARTED", operation, { httpStatus: res.status, retryable: false });
    const json = safeJson(res.body);
    const parsed = TokenResponse.safeParse(json);
    if (!parsed.success || (parsed.data.token_type !== undefined && parsed.data.token_type.toLowerCase() !== "bearer")) {
      throw this.err("CONNECTOR_TOKEN_RESPONSE_INVALID", "NOT_STARTED", operation, { retryable: false });
    }
    this.verifyBinding(json, operation);
    const declared = [...credential.scopes].sort();
    const granted = scopeList(parsed.data.scope) ?? declared; // RFC 6749 5.1: omitted means as requested
    const broader = granted.filter((s) => !declared.includes(s));
    if (broader.length > 0) {
      this.logger.warn("connector.token.scope_broader", { reasonCode: "CONNECTOR_TOKEN_SCOPE_BROADER" });
      throw this.err("CONNECTOR_TOKEN_SCOPE_BROADER", "NOT_STARTED", operation, { retryable: false });
    }
    const missing = declared.filter((s) => !granted.includes(s));
    if (missing.length > 0) {
      this.count("scope_narrower");
      this.logger.warn("connector.token.scope_narrower", { reasonCode: "CONNECTOR_TOKEN_SCOPE_NARROWER" });
    }
    const advertised = parsed.data.expires_in === undefined ? null : Number(parsed.data.expires_in) * 1000;
    const bound = Math.min(advertised ?? this.auth.tokenMaxAgeSeconds * 1000, this.auth.tokenMaxAgeSeconds * 1000);
    const lifetime = bound > 2 * MARGIN_MS ? bound - MARGIN_MS : Math.floor(bound / 2);
    this.count("issued");
    return {
      header: { name: "authorization", value: new SecretValue(`Bearer ${parsed.data.access_token}`) },
      expiresAtMs: this.deps.clock.now().getTime() + lifetime,
      grantedScopes: granted,
      missingScopes: missing,
      secretVersionId: secret.versionId,
      credentialRef: credential.credentialRef,
    };
  }

  /** Account / region reported in the token response must match the profile binding (FO-06-13). */
  private verifyBinding(json: unknown, operation: string): void {
    const b = this.deps.profile.bindingVerification;
    const check = (src: { source: string; locator: string } | null | undefined, expected: string, reason: string) => {
      if (!src || src.source !== "TOKEN_RESPONSE") return;
      const v = readPointer(json, parsePointer(src.locator));
      if (typeof v !== "string" || v !== expected) throw this.err(reason, "NOT_STARTED", operation, { retryable: false });
    };
    check(b?.account, this.deps.profile.accountBinding.externalAccountRef, "CONNECTOR_ACCOUNT_BINDING_MISMATCH");
    check(b?.region, this.deps.profile.region, "CONNECTOR_REGION_MISMATCH");
  }
}

function safeJson(buf: Buffer): unknown {
  try {
    return JSON.parse(buf.toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}
