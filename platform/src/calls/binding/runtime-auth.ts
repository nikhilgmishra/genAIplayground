/**
 * Authentication of the conversation runtime (the `conversation_runtime` channel; ADR-0018 decision 1.6; AUTH-03).
 *
 * The media worker calls the gateway with its own OAuth2 client-credentials access token (JWS), verified exactly as
 * the gateway verifies every other integration (gateway/auth.ts JwtAccessTokenAuthenticator, WP-05): signature against
 * the issuer's JWKS (the composition passes the egress-transport key resolver, adapters/live/transport-jwks.ts),
 * exact issuer, environment-specific audience, exp/nbf with a bounded tolerance, an asymmetric algorithm allowlist, an
 * optional maximum token age, a registered client id and the runtime scope. The runtime's identity is never one of the
 * Studio (telephony_control) or model-facing (mcp_tools) identities: a token for those channels is refused here, and a
 * runtime token is refused on their routes (IntegrationIdentity has no runtime channel).
 *
 * There is no fixture token and no development bypass: a configuration without an issuer, audience and key resolver
 * does not construct.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { errors as joseErrors, jwtVerify } from "jose";
import type { JWTPayload, JWTVerifyGetKey } from "jose";
import { z } from "zod";
import { ConversationAdapter } from "../../protocol/call-binding.js";
import type { Clock } from "../../shared/clock.js";
import { AccessDeniedError, DependencyError, PlatformError, ValidationError } from "../../shared/errors.js";
import type { RuntimeIdentity } from "./ports.js";

/** Transport authentication of the runtime failed (401/403; reason code only, never the presented token). */
export class RuntimeAuthenticationError extends PlatformError {}

const AsymmetricAlg = z.enum(["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512", "EdDSA"]);

export const RuntimeAuthConfig = z.strictObject({
  environment: z.enum(["local", "ci", "sandbox", "staging", "production"]),
  tenantId: z.string().regex(/^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$/),
  issuer: z.string().url().max(512),
  /** Environment-specific audience; a token minted for another environment's gateway is refused. */
  audience: z.string().min(3).max(256),
  algorithms: z.array(AsymmetricAlg).min(1).max(10),
  clockToleranceSeconds: z.number().int().min(0).max(120),
  maxTokenAgeSeconds: z.number().int().min(30).max(86_400).nullable(),
  clientIdClaim: z.enum(["client_id", "azp", "sub"]),
  /** OAuth2 scope that grants the runtime channel. */
  scope: z.string().regex(/^[A-Za-z0-9._:-]{3,64}$/),
  clients: z
    .array(
      z.strictObject({
        clientId: z.string().min(3).max(256),
        integrationId: z.string().regex(/^[a-z0-9-]{3,64}$/),
        credentialId: z.string().min(3).max(128),
        adapters: z.array(ConversationAdapter.extract(["controlled_cascade_runtime", "native_duplex_runtime"])).min(1).max(2),
      }),
    )
    .min(1)
    .max(16),
});
export type RuntimeAuthConfig = z.infer<typeof RuntimeAuthConfig>;

const BEARER = /^Bearer ([A-Za-z0-9._~+/-]{16,4096}=*)$/;
const sha256 = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();

function scopesOf(payload: JWTPayload): string[] {
  const scope = (payload as { scope?: unknown }).scope;
  const scp = (payload as { scp?: unknown }).scp;
  if (typeof scope === "string") return scope.split(" ").filter(Boolean);
  if (Array.isArray(scp) && scp.every((s) => typeof s === "string")) return scp as string[];
  return [];
}

export class RuntimeCredentialVerifier {
  readonly kind = "live" as const;
  private readonly cfg: RuntimeAuthConfig;

  constructor(
    config: RuntimeAuthConfig,
    private readonly deps: { clock: Clock; getKey: JWTVerifyGetKey },
  ) {
    const parsed = RuntimeAuthConfig.safeParse(config);
    if (!parsed.success) throw new ValidationError("RUNTIME_AUTH_CONFIG_INVALID");
    if (new Set(parsed.data.clients.map((c) => c.clientId)).size !== parsed.data.clients.length) throw new ValidationError("RUNTIME_AUTH_CLIENT_DUPLICATE");
    if (typeof deps.getKey !== "function") throw new ValidationError("RUNTIME_AUTH_KEY_RESOLVER_MISSING");
    this.cfg = parsed.data;
  }

  /** Verifies the Authorization header value; throws RuntimeAuthenticationError (401) or AccessDeniedError (403). */
  async authenticate(authorizationHeader: string | undefined): Promise<RuntimeIdentity> {
    if (typeof authorizationHeader !== "string" || authorizationHeader.length > 4200) throw new RuntimeAuthenticationError("RUNTIME_CREDENTIAL_MISSING");
    const m = BEARER.exec(authorizationHeader.trim());
    const token = m?.[1];
    if (!token) throw new RuntimeAuthenticationError("RUNTIME_CREDENTIAL_MISSING");
    let payload: JWTPayload;
    try {
      const verified = await jwtVerify(token, this.deps.getKey, {
        issuer: this.cfg.issuer,
        audience: this.cfg.audience,
        algorithms: this.cfg.algorithms,
        clockTolerance: this.cfg.clockToleranceSeconds,
        currentDate: this.deps.clock.now(),
        ...(this.cfg.maxTokenAgeSeconds !== null ? { maxTokenAge: this.cfg.maxTokenAgeSeconds } : {}),
        requiredClaims: ["exp", "iat"],
      });
      payload = verified.payload;
    } catch (err) {
      if (err instanceof DependencyError) throw new DependencyError("RUNTIME_AUTH_KEYS_UNAVAILABLE", "FAILED", true);
      if (err instanceof joseErrors.JWTExpired) throw new RuntimeAuthenticationError("RUNTIME_CREDENTIAL_EXPIRED");
      if (err instanceof joseErrors.JWKSTimeout) throw new DependencyError("RUNTIME_AUTH_KEYS_UNAVAILABLE", "FAILED", true);
      throw new RuntimeAuthenticationError("RUNTIME_CREDENTIAL_INVALID");
    }
    const clientIdValue = (payload as Record<string, unknown>)[this.cfg.clientIdClaim];
    if (typeof clientIdValue !== "string") throw new RuntimeAuthenticationError("RUNTIME_CLIENT_UNKNOWN");
    const digest = sha256(clientIdValue);
    const client = this.cfg.clients.find((c) => {
      const d = sha256(c.clientId);
      return d.length === digest.length && timingSafeEqual(d, digest);
    });
    if (!client) throw new RuntimeAuthenticationError("RUNTIME_CLIENT_UNKNOWN");
    if (!scopesOf(payload).includes(this.cfg.scope)) throw new AccessDeniedError("RUNTIME_SCOPE_MISSING");
    return {
      integrationId: client.integrationId,
      tenantId: this.cfg.tenantId,
      environment: this.cfg.environment,
      channel: "conversation_runtime",
      credentialId: client.credentialId,
      authMethod: "oauth2_client_credentials",
      adapters: [...client.adapters],
    };
  }
}
