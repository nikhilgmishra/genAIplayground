/**
 * Integration (service) authentication for every inbound gateway channel
 * (spec section 8 "Use separate service identities and permissions per
 * environment and integration. Prefer short-lived OAuth2 access"; section 3
 * "IP allowlists are supplemental, not authentication").
 *
 * Service authentication proves WHICH integration is calling; it never
 * authenticates the caller (MCP is not a security guarantee, spec section 2).
 * Each authenticator returns a strictly validated IntegrationIdentity whose
 * channel must equal the channel the route requires; a credential for another
 * channel, environment or tenant is rejected (mcp-connection.md section 3).
 *
 * - LocalFixtureTokenAuthenticator: LOCAL FIXTURE. Synthetic, labelled static
 *   tokens per channel for local/ci only; refused in any other environment.
 * - JwtAccessTokenAuthenticator: live. OAuth2 client-credentials access tokens
 *   (JWS) verified with jose against the issuer JWKS (rotation supported):
 *   signature, issuer, audience, exp/nbf with bounded clock tolerance, an
 *   asymmetric algorithm allowlist, a client id -> integration mapping and a
 *   scope -> channel mapping. Verified offline only against a local JWKS.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, errors as joseErrors, jwtVerify } from "jose";
import type { JWTPayload, JWTVerifyGetKey } from "jose";
import { z } from "zod";
import { IntegrationIdentity } from "../protocol/index.js";
import type { Environment } from "../protocol/index.js";
import type { Clock } from "../shared/clock.js";
import { ConfigurationRejectedError, PlatformError, ValidationError } from "../shared/errors.js";

export type IntegrationChannel = IntegrationIdentity["channel"];

/** Transport authentication failed. Reason code only; never the presented credential. */
export class IntegrationAuthenticationError extends PlatformError {
  constructor(reasonCode: string) {
    super(reasonCode);
  }
}

export interface IntegrationAuthenticator {
  readonly kind: "local_fixture" | "live";
  /**
   * Verifies the `Authorization` header value and returns the integration identity.
   * Throws IntegrationAuthenticationError (401/403) on any failure.
   */
  authenticate(authorizationHeader: string | undefined, requiredChannel: IntegrationChannel): Promise<IntegrationIdentity>;
}

const BEARER = /^Bearer ([A-Za-z0-9._~+/-]{16,4096}=*)$/;

export function bearerFrom(header: string | undefined): string | null {
  if (typeof header !== "string" || header.length > 4200) return null;
  const m = BEARER.exec(header.trim());
  return m?.[1] ?? null;
}

const sha256 = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();

// ---------------------------------------------------------------------------
// LOCAL FIXTURE
// ---------------------------------------------------------------------------

export const LOCAL_FIXTURE_AUTH_BADGE = "LOCAL FIXTURE — synthetic static integration tokens, local/ci only";

/** Synthetic, labelled, non-secret tokens (local/ci only). They are printed in the local start banner. */
export const LOCAL_FIXTURE_TOKENS: Readonly<Record<Exclude<IntegrationChannel, "console" | "worker">, string>> = Object.freeze({
  mcp_tools: "local-fixture-mcp-tools-token-NOT-A-SECRET-0001",
  telephony_control: "local-fixture-telephony-control-token-NOT-A-SECRET-0001",
  portal: "local-fixture-portal-token-NOT-A-SECRET-0001",
  webhook: "local-fixture-webhook-token-NOT-A-SECRET-0001",
});

export interface LocalFixtureTokenAuthenticatorOptions {
  environment: Environment;
  tenantId: string;
  /** Integration id shared by the Talkdesk MCP and telephony-control credentials (identity binds sessions to it). */
  talkdeskIntegrationId?: string;
  portalIntegrationId?: string;
  /** Override the synthetic token table (tests). */
  tokens?: Partial<Record<IntegrationChannel, string>>;
}

export class LocalFixtureTokenAuthenticator implements IntegrationAuthenticator {
  readonly kind = "local_fixture" as const;
  readonly badge = LOCAL_FIXTURE_AUTH_BADGE;
  private readonly table: { digest: Buffer; identity: IntegrationIdentity }[] = [];

  constructor(opts: LocalFixtureTokenAuthenticatorOptions) {
    if (opts.environment !== "local" && opts.environment !== "ci") throw new ConfigurationRejectedError(["LOCAL_FIXTURE_AUTHENTICATOR_OUTSIDE_LOCAL_CI@gateway.auth"]);
    const talkdesk = opts.talkdeskIntegrationId ?? "talkdesk-local";
    const portal = opts.portalIntegrationId ?? "vsp-portal-local";
    const tokens: Partial<Record<IntegrationChannel, string>> = { ...LOCAL_FIXTURE_TOKENS, ...(opts.tokens ?? {}) };
    for (const [channel, token] of Object.entries(tokens) as [IntegrationChannel, string][]) {
      if (typeof token !== "string" || token.length < 16) continue;
      const identity = IntegrationIdentity.parse({
        integrationId: channel === "portal" ? portal : talkdesk,
        tenantId: opts.tenantId,
        environment: opts.environment,
        channel,
        credentialId: `cred-local-${channel.replace(/_/g, "-")}`,
        authMethod: "local_fixture",
      });
      this.table.push({ digest: sha256(token), identity });
    }
  }

  async authenticate(authorizationHeader: string | undefined, requiredChannel: IntegrationChannel): Promise<IntegrationIdentity> {
    const token = bearerFrom(authorizationHeader);
    if (!token) throw new IntegrationAuthenticationError("INTEGRATION_CREDENTIAL_MISSING");
    const digest = sha256(token);
    let match: IntegrationIdentity | null = null;
    for (const row of this.table) if (timingSafeEqual(row.digest, digest)) match = row.identity;
    if (!match) throw new IntegrationAuthenticationError("INTEGRATION_CREDENTIAL_INVALID");
    if (match.channel !== requiredChannel) throw new IntegrationAuthenticationError("INTEGRATION_CHANNEL_NOT_ALLOWED");
    return { ...match };
  }
}

// ---------------------------------------------------------------------------
// Live: OAuth2 access tokens (JWS) verified against the issuer JWKS
// ---------------------------------------------------------------------------

const AsymmetricAlg = z.enum(["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512", "EdDSA"]);

export const JwtAuthenticatorConfig = z.strictObject({
  environment: z.enum(["local", "ci", "sandbox", "staging", "production"]),
  tenantId: z.string().regex(/^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$/),
  /** Exact issuer (no prefix matching). */
  issuer: z.string().url().max(512),
  /** Environment-specific audience, e.g. vsp-gateway-sandbox: a sandbox token is rejected by production. */
  audience: z.string().min(3).max(256),
  /** https JWKS URI (http only for literal loopback in tests). */
  jwksUri: z.string().url().max(512).nullable(),
  algorithms: z.array(AsymmetricAlg).min(1).max(10),
  /** Bounded clock tolerance (seconds). Value is set by the identity owner; 0..120 accepted. */
  clockToleranceSeconds: z.number().int().min(0).max(120),
  /** Optional maximum token age from iat (seconds). */
  maxTokenAgeSeconds: z.number().int().min(30).max(86_400).nullable(),
  /** Which claim carries the OAuth2 client id. */
  clientIdClaim: z.enum(["client_id", "azp", "sub"]),
  /** Registered clients: client id -> integration identity and permitted channels. */
  clients: z
    .array(
      z.strictObject({
        clientId: z.string().min(3).max(256),
        integrationId: z.string().regex(/^[a-z0-9-]{3,64}$/),
        credentialId: z.string().min(3).max(128),
        channels: z.array(z.enum(["mcp_tools", "telephony_control", "portal", "webhook"])).min(1).max(4),
      }),
    )
    .min(1)
    .max(32),
  /** Scope -> channel mapping (proposed vsp.mcp_tools / vsp.telephony_control). */
  scopeToChannel: z.record(z.string().regex(/^[A-Za-z0-9._:-]{3,64}$/), z.enum(["mcp_tools", "telephony_control", "portal", "webhook"])),
});
export type JwtAuthenticatorConfig = z.infer<typeof JwtAuthenticatorConfig>;

export interface JwtAccessTokenAuthenticatorDeps {
  clock: Clock;
  /** Injected key resolver (tests: jose createLocalJWKSet). Defaults to createRemoteJWKSet(jwksUri). */
  getKey?: JWTVerifyGetKey;
  /** Test-only: permit an http JWKS URI on literal loopback. */
  allowLoopbackHttpJwks?: boolean;
}

function scopesOf(payload: JWTPayload): string[] {
  const scope = (payload as { scope?: unknown }).scope;
  const scp = (payload as { scp?: unknown }).scp;
  if (typeof scope === "string") return scope.split(" ").filter(Boolean);
  if (Array.isArray(scp) && scp.every((s) => typeof s === "string")) return scp as string[];
  return [];
}

export class JwtAccessTokenAuthenticator implements IntegrationAuthenticator {
  readonly kind = "live" as const;
  private readonly cfg: JwtAuthenticatorConfig;
  private readonly getKey: JWTVerifyGetKey;
  private readonly clock: Clock;

  constructor(config: JwtAuthenticatorConfig, deps: JwtAccessTokenAuthenticatorDeps) {
    const parsed = JwtAuthenticatorConfig.safeParse(config);
    if (!parsed.success) throw new ValidationError("JWT_AUTHENTICATOR_CONFIG_INVALID");
    this.cfg = parsed.data;
    this.clock = deps.clock;
    if (deps.getKey) this.getKey = deps.getKey;
    else {
      if (!this.cfg.jwksUri) throw new ValidationError("JWT_AUTHENTICATOR_JWKS_URI_MISSING");
      const url = new URL(this.cfg.jwksUri);
      const loopback = url.hostname === "127.0.0.1" || url.hostname === "::1";
      if (url.protocol !== "https:" && !(deps.allowLoopbackHttpJwks === true && loopback && url.protocol === "http:")) {
        throw new ValidationError("JWT_AUTHENTICATOR_JWKS_URI_NOT_HTTPS");
      }
      this.getKey = createRemoteJWKSet(url, { timeoutDuration: 2_000, cooldownDuration: 30_000, cacheMaxAge: 600_000 });
    }
    for (const c of this.cfg.clients) for (const ch of c.channels) if (!Object.values(this.cfg.scopeToChannel).includes(ch)) {
      throw new ValidationError("JWT_AUTHENTICATOR_CHANNEL_WITHOUT_SCOPE");
    }
  }

  async authenticate(authorizationHeader: string | undefined, requiredChannel: IntegrationChannel): Promise<IntegrationIdentity> {
    const token = bearerFrom(authorizationHeader);
    if (!token) throw new IntegrationAuthenticationError("INTEGRATION_CREDENTIAL_MISSING");
    let payload: JWTPayload;
    try {
      const verified = await jwtVerify(token, this.getKey, {
        issuer: this.cfg.issuer,
        audience: this.cfg.audience,
        algorithms: this.cfg.algorithms,
        clockTolerance: this.cfg.clockToleranceSeconds,
        currentDate: this.clock.now(),
        requiredClaims: ["exp", "iat"],
        ...(this.cfg.maxTokenAgeSeconds ? { maxTokenAge: this.cfg.maxTokenAgeSeconds } : {}),
      });
      payload = verified.payload;
    } catch (err) {
      throw new IntegrationAuthenticationError(joseReason(err));
    }
    const clientId = (payload as Record<string, unknown>)[this.cfg.clientIdClaim];
    const client = typeof clientId === "string" ? this.cfg.clients.find((c) => c.clientId === clientId) : undefined;
    if (!client) throw new IntegrationAuthenticationError("INTEGRATION_CLIENT_UNKNOWN");
    const channels = new Set(scopesOf(payload).map((s) => (Object.hasOwn(this.cfg.scopeToChannel, s) ? this.cfg.scopeToChannel[s] : undefined)).filter(Boolean));
    if (!channels.has(requiredChannel as never) || !client.channels.includes(requiredChannel as never)) {
      throw new IntegrationAuthenticationError("INTEGRATION_CHANNEL_NOT_ALLOWED");
    }
    const identity = IntegrationIdentity.safeParse({
      integrationId: client.integrationId,
      tenantId: this.cfg.tenantId,
      environment: this.cfg.environment,
      channel: requiredChannel,
      credentialId: client.credentialId,
      authMethod: "oauth2_client_credentials",
    });
    if (!identity.success) throw new IntegrationAuthenticationError("INTEGRATION_IDENTITY_INVALID");
    return identity.data;
  }
}

function joseReason(err: unknown): string {
  if (err instanceof joseErrors.JWTExpired) return (err as { claim?: unknown }).claim === "iat" ? "INTEGRATION_TOKEN_TOO_OLD" : "INTEGRATION_TOKEN_EXPIRED";
  if (err instanceof joseErrors.JWTClaimValidationFailed) {
    const claim = (err as { claim?: unknown }).claim;
    if (claim === "iss") return "INTEGRATION_TOKEN_ISSUER_INVALID";
    if (claim === "aud") return "INTEGRATION_TOKEN_AUDIENCE_INVALID";
    if (claim === "nbf") return "INTEGRATION_TOKEN_NOT_YET_VALID";
    if (claim === "iat") return "INTEGRATION_TOKEN_TOO_OLD";
    return "INTEGRATION_TOKEN_CLAIMS_INVALID";
  }
  if (err instanceof joseErrors.JOSEAlgNotAllowed) return "INTEGRATION_TOKEN_ALG_NOT_ALLOWED";
  if (err instanceof joseErrors.JWSSignatureVerificationFailed) return "INTEGRATION_TOKEN_SIGNATURE_INVALID";
  if (err instanceof joseErrors.JWKSNoMatchingKey) return "INTEGRATION_TOKEN_KEY_UNKNOWN";
  if (err instanceof joseErrors.JWKSTimeout) return "INTEGRATION_KEYS_UNAVAILABLE";
  if (err instanceof joseErrors.JOSEError) return "INTEGRATION_TOKEN_INVALID";
  // createRemoteJWKSet fetch failures (network) surface as plain errors: the key set is unavailable.
  if (err instanceof Error && /fetch|network|ECONN|ENOTFOUND/i.test(err.name + err.message)) return "INTEGRATION_KEYS_UNAVAILABLE";
  return "INTEGRATION_TOKEN_INVALID";
}

/** Fails closed: a fixture authenticator may only exist in local/ci (OPS-04). */
export function assertAuthenticatorAllowed(authenticator: IntegrationAuthenticator, environment: Environment): void {
  if (authenticator.kind === "local_fixture" && environment !== "local" && environment !== "ci") {
    throw new ConfigurationRejectedError(["LOCAL_FIXTURE_AUTHENTICATOR_OUTSIDE_LOCAL_CI@gateway.auth"]);
  }
}
