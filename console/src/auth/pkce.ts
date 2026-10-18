/**
 * OIDC authorization-code + PKCE (RFC 7636, S256) helpers for workforce SSO.
 *
 * The PKCE verifier, `state` and `nonce` must survive exactly one redirect
 * round-trip to the IdP, so they are kept in sessionStorage under a key derived
 * from `state` and deleted when the callback consumes them (or after 10 minutes).
 * This module is the ONLY place allowed to touch browser storage (eslint.config.js);
 * the console bearer token itself is never stored.
 *
 * Workforce SSO is BLOCKED until the identity owner issues the OIDC client
 * (PRQ-036). Nothing here is vendor-specific: it follows OAuth 2.0 / OpenID
 * Connect Core, with the authorization endpoint supplied by the backend from
 * the issuer's discovery document.
 */
import type { OidcClientConfig } from "../api/contract";
import { base64UrlEncode, randomUrlSafe } from "../lib/random";

const KEY_PREFIX = "vsp.console.oidc.";
const MAX_AGE_MS = 10 * 60_000;
const STATE_RE = /^[A-Za-z0-9_-]{32,128}$/;

export interface PkceSession {
  state: string;
  nonce: string;
  codeVerifier: string;
  codeChallenge: string;
}

export class OidcFlowError extends Error {
  constructor(readonly reasonCode: string) {
    super(reasonCode);
    this.name = "OidcFlowError";
  }
}

/** S256 code challenge: BASE64URL(SHA-256(ASCII(code_verifier))). */
export async function s256Challenge(codeVerifier: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier));
  return base64UrlEncode(new Uint8Array(digest));
}

export async function createPkceSession(): Promise<PkceSession> {
  // 32 random bytes -> 43-character verifier (RFC 7636 allows 43..128).
  const codeVerifier = randomUrlSafe(32);
  return { state: randomUrlSafe(32), nonce: randomUrlSafe(32), codeVerifier, codeChallenge: await s256Challenge(codeVerifier) };
}

export function saveTransient(session: PkceSession, now: () => number = () => Date.now()): void {
  try {
    sessionStorage.setItem(
      KEY_PREFIX + session.state,
      JSON.stringify({ codeVerifier: session.codeVerifier, nonce: session.nonce, createdAt: now() }),
    );
  } catch {
    throw new OidcFlowError("BROWSER_STORAGE_UNAVAILABLE");
  }
}

/** Reads and deletes the transient PKCE state for `state`. Unknown, malformed or stale state fails closed. */
export function consumeTransient(state: string, now: () => number = () => Date.now()): { codeVerifier: string; nonce: string } {
  if (!STATE_RE.test(state)) throw new OidcFlowError("OIDC_STATE_INVALID");
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(KEY_PREFIX + state);
    sessionStorage.removeItem(KEY_PREFIX + state);
  } catch {
    throw new OidcFlowError("BROWSER_STORAGE_UNAVAILABLE");
  }
  if (!raw) throw new OidcFlowError("OIDC_STATE_MISMATCH");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new OidcFlowError("OIDC_STATE_INVALID");
  }
  const rec = parsed as { codeVerifier?: unknown; nonce?: unknown; createdAt?: unknown };
  if (typeof rec.codeVerifier !== "string" || typeof rec.nonce !== "string" || typeof rec.createdAt !== "number") {
    throw new OidcFlowError("OIDC_STATE_INVALID");
  }
  if (now() - rec.createdAt > MAX_AGE_MS) throw new OidcFlowError("OIDC_STATE_EXPIRED");
  return { codeVerifier: rec.codeVerifier, nonce: rec.nonce };
}

export function buildAuthorizationUrl(oidc: OidcClientConfig, redirectUri: string, session: PkceSession): string {
  if (oidc.status !== "CONFIGURED" || !oidc.authorizationEndpoint || !oidc.clientId) throw new OidcFlowError("OIDC_NOT_CONFIGURED");
  let url: URL;
  try {
    url = new URL(oidc.authorizationEndpoint);
  } catch {
    throw new OidcFlowError("OIDC_NOT_CONFIGURED");
  }
  if (url.protocol !== "https:") throw new OidcFlowError("OIDC_ENDPOINT_NOT_HTTPS");
  const scopes = oidc.scopes.includes("openid") ? oidc.scopes : ["openid", ...oidc.scopes];
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", oidc.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("state", session.state);
  url.searchParams.set("nonce", session.nonce);
  url.searchParams.set("code_challenge", session.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}
