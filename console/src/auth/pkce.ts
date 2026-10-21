/**
 * OIDC authorization-code + PKCE (RFC 7636, S256) helpers for workforce SSO.
 *
 * The backend runs the flow (WP-05): it creates `state` and `nonce`, keeps them server side bound to this
 * browser's S256 challenge and the exact redirect URI, builds the authorization URL from the issuer's
 * discovery document and later redeems the code itself; IdP tokens never reach the browser. The browser
 * only holds its PKCE verifier across exactly one redirect, in sessionStorage under a key derived from the
 * backend's `state`, deleted when the callback consumes it (or after 10 minutes). This module is the ONLY
 * place allowed to touch browser storage (eslint.config.js); the console session bearer is never stored.
 */
import type { OidcClientConfig } from "../api/contract";
import { base64UrlEncode, randomUrlSafe } from "../lib/random";

const KEY_PREFIX = "vsp.console.oidc.";
const MAX_AGE_MS = 10 * 60_000;
const STATE_RE = /^[A-Za-z0-9_-]{32,512}$/;

export interface PkceSession {
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
  return { codeVerifier, codeChallenge: await s256Challenge(codeVerifier) };
}

/** Keeps the verifier for the backend-issued `state` until the callback (one redirect round-trip). */
export function saveTransient(state: string, codeVerifier: string, now: () => number = () => Date.now()): void {
  if (!STATE_RE.test(state)) throw new OidcFlowError("OIDC_STATE_INVALID");
  try {
    sessionStorage.setItem(KEY_PREFIX + state, JSON.stringify({ codeVerifier, createdAt: now() }));
  } catch {
    throw new OidcFlowError("BROWSER_STORAGE_UNAVAILABLE");
  }
}

/** Reads and deletes the transient PKCE verifier for `state`. Unknown, malformed or stale state fails closed. */
export function consumeTransient(state: string, now: () => number = () => Date.now()): { codeVerifier: string } {
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
  const rec = parsed as { codeVerifier?: unknown; createdAt?: unknown };
  if (typeof rec.codeVerifier !== "string" || typeof rec.createdAt !== "number") throw new OidcFlowError("OIDC_STATE_INVALID");
  if (now() - rec.createdAt > MAX_AGE_MS) throw new OidcFlowError("OIDC_STATE_EXPIRED");
  return { codeVerifier: rec.codeVerifier };
}

/**
 * Checks the backend-built authorization URL before the browser follows it: HTTPS, the configured IdP's
 * authorization endpoint (same origin and path), our challenge with S256 and the backend's state. Anything
 * else is refused (a compromised or misconfigured backend response never redirects staff elsewhere).
 */
export function checkAuthorizationUrl(oidc: OidcClientConfig | null, raw: string, expected: { state: string; codeChallenge: string }): string {
  if (!oidc || oidc.status !== "CONFIGURED" || !oidc.authorizationEndpoint) throw new OidcFlowError("OIDC_NOT_CONFIGURED");
  let url: URL;
  let endpoint: URL;
  try {
    url = new URL(raw);
    endpoint = new URL(oidc.authorizationEndpoint);
  } catch {
    throw new OidcFlowError("OIDC_AUTHORIZATION_URL_INVALID");
  }
  if (url.protocol !== "https:" || endpoint.protocol !== "https:") throw new OidcFlowError("OIDC_ENDPOINT_NOT_HTTPS");
  if (url.origin !== endpoint.origin || url.pathname !== endpoint.pathname) throw new OidcFlowError("OIDC_ENDPOINT_MISMATCH");
  const q = url.searchParams;
  if (q.get("response_type") !== "code" || q.get("code_challenge_method") !== "S256" || q.get("code_challenge") !== expected.codeChallenge || q.get("state") !== expected.state) {
    throw new OidcFlowError("OIDC_AUTHORIZATION_URL_INVALID");
  }
  if (!(q.get("scope") ?? "").split(" ").includes("openid")) throw new OidcFlowError("OIDC_AUTHORIZATION_URL_INVALID");
  return url.toString();
}
