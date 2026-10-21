/**
 * Workforce authentication route handlers of the console API (WP-05; follow-on FO-01-09, FO-05-09,
 * FO-05-13, FO-05-18, FO-05-19, FO-05-41, FO-14-02, FO-14-51). `plugin.ts` mounts them under the public
 * auth endpoints of contract.ts; every handler returns a contract response and nothing else.
 *
 *   auth.oidcStart          server-bound authorization request (state, nonce, PKCE challenge, exact redirect)
 *   auth.oidcExchange       backend code exchange -> opaque console session (IdP tokens stay server side)
 *   auth.refresh            same-actor refresh with bearer rotation (never extends the idle window)
 *   auth.recoveryChallenge  dual-controlled SSO-outage recovery: challenge for two custodians (signed request
 *                           by the requester's own key; anonymous requests consume nothing)
 *   auth.recoveryActivate   two custodian signatures -> short RECOVERY session (+ post-use access review)
 *
 * Only reason codes leave these handlers; no token, code, state, verifier or subject is logged.
 */
import { iso } from "../../../shared/clock.js";
import type * as C from "../../contract.js";
import { unavailable } from "../../errors.js";
import type { PgRecoveryService } from "../../recovery.js";
import type { WorkforceSsoConfig } from "../../sso-config.js";
import type { WorkforceSsoService } from "../../sso.js";

/** The live workforce SSO the composition root wires (opaque console sessions over the workforce IdP). */
export interface ConsoleSsoDeps {
  service: WorkforceSsoService;
  config: WorkforceSsoConfig;
  /**
   * Authorization endpoint from the issuer's OpenID Connect discovery document; null while discovery is
   * unavailable (the console then shows sign-in as unavailable instead of guessing an endpoint).
   */
  authorizationEndpoint(): Promise<string | null>;
}

const BLOCKED_REASON = "WORKFORCE_OIDC_CLIENT_NOT_ISSUED";

/** Client view of the workforce OIDC configuration (never secrets; the client is confidential, server side). */
export async function oidcClientView(sso: ConsoleSsoDeps | null, configured: C.OidcClientConfig | null): Promise<C.OidcClientConfig> {
  if (!sso) {
    return (
      configured ?? {
        status: "BLOCKED",
        issuer: null,
        clientId: null,
        authorizationEndpoint: null,
        redirectPath: "/auth/callback",
        scopes: ["openid"],
        codeChallengeMethod: "S256",
        blockedReasonCode: BLOCKED_REASON,
      }
    );
  }
  // Discovery failure is reported, never thrown: the configuration view must stay readable.
  const endpoint: string | null = await sso.authorizationEndpoint().catch(() => null);
  return {
    status: "CONFIGURED",
    issuer: sso.config.issuer,
    clientId: sso.config.clientId,
    authorizationEndpoint: endpoint,
    redirectPath: "/auth/callback",
    scopes: [...sso.config.scopes],
    codeChallengeMethod: "S256",
    blockedReasonCode: endpoint === null ? "WORKFORCE_IDP_UNAVAILABLE" : null,
  };
}

export function sessionPolicyView(sso: ConsoleSsoDeps | null): C.SessionPolicyView | null {
  return sso ? { idleTimeoutSeconds: sso.config.session.idleTimeoutSeconds, absoluteLifetimeSeconds: sso.config.session.absoluteLifetimeSeconds } : null;
}

const requireSso = (sso: ConsoleSsoDeps | null): ConsoleSsoDeps => {
  if (!sso) throw unavailable("OIDC_NOT_CONFIGURED", false);
  return sso;
};

export async function startSignIn(sso: ConsoleSsoDeps | null, body: C.OidcStartRequest): Promise<C.OidcStartResponse> {
  const out = await requireSso(sso).service.start({ redirectUri: body.redirectUri, codeChallenge: body.codeChallenge });
  return { authorizationUrl: out.authorizationUrl, state: out.state, expiresAt: iso(out.expiresAt) };
}

export async function exchangeCode(sso: ConsoleSsoDeps | null, body: C.OidcExchangeRequest, correlationId: string): Promise<C.TokenResponse> {
  const out = await requireSso(sso).service.exchange({ code: body.code, state: body.state, codeVerifier: body.codeVerifier, redirectUri: body.redirectUri, correlationId });
  return { accessToken: out.token, tokenType: "Bearer", expiresAt: iso(out.expiresAt), localFixture: false, sessionKind: "OIDC_SSO", idleTimeoutSeconds: out.idleTimeoutSeconds };
}

export async function refreshSession(sso: ConsoleSsoDeps | null, authorization: string | undefined, correlationId: string): Promise<C.TokenResponse> {
  const out = await requireSso(sso).service.refresh(authorization, correlationId);
  return { accessToken: out.token, tokenType: "Bearer", expiresAt: iso(out.expiresAt), localFixture: false, sessionKind: "OIDC_SSO", idleTimeoutSeconds: out.idleTimeoutSeconds };
}

const requireRecovery = (recovery: PgRecoveryService | null): PgRecoveryService => {
  if (!recovery) throw unavailable("RECOVERY_NOT_CONFIGURED", false);
  return recovery;
};

export async function recoveryChallenge(recovery: PgRecoveryService | null, body: C.RecoveryChallengeRequest, correlationId: string): Promise<C.RecoveryChallengeResponse> {
  return requireRecovery(recovery).challenge({ identityId: body.identityId, proof: body.proof, correlationId });
}

export async function recoveryActivate(recovery: PgRecoveryService | null, body: C.RecoveryActivateRequest, correlationId: string): Promise<C.TokenResponse> {
  const out = await requireRecovery(recovery).activate({ body, correlationId });
  return { accessToken: out.token, tokenType: "Bearer", expiresAt: iso(out.expiresAt), localFixture: false, sessionKind: "RECOVERY", idleTimeoutSeconds: out.idleTimeoutSeconds };
}
