import { describe, expect, it } from "vitest";
import type { OidcClientConfig } from "../api/contract";
import { OidcFlowError, checkAuthorizationUrl, consumeTransient, createPkceSession, s256Challenge, saveTransient } from "./pkce";

const CONFIGURED: OidcClientConfig = {
  status: "CONFIGURED",
  issuer: "https://sso-workforce.local.invalid",
  clientId: "vsp-console-local",
  authorizationEndpoint: "https://sso-workforce.local.invalid/authorize",
  redirectPath: "/auth/callback",
  scopes: ["profile"],
  codeChallengeMethod: "S256",
  blockedReasonCode: null,
};

function reason(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof OidcFlowError) return err.reasonCode;
    throw err;
  }
  return "NO_ERROR";
}

describe("OIDC authorization code + PKCE helpers", () => {
  it("[SPEC-7.staff-sso] S256 matches the RFC 7636 appendix B test vector", async () => {
    expect(await s256Challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("[SPEC-7.staff-sso] sessions use a fresh 43-character verifier with its S256 challenge; state and nonce are the backend's", async () => {
    const a = await createPkceSession();
    const b = await createPkceSession();
    expect(a.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.codeChallenge).toBe(await s256Challenge(a.codeVerifier));
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
    expect(Object.keys(a).sort()).toEqual(["codeChallenge", "codeVerifier"]);
  });

  it("[FO-05-13][FO-05-10] the backend-built authorization URL is followed only for the configured HTTPS endpoint with our challenge, S256, openid and the backend state", async () => {
    const s = await createPkceSession();
    const state = "S".repeat(43);
    const good = new URL(CONFIGURED.authorizationEndpoint ?? "");
    good.search = new URLSearchParams({ response_type: "code", client_id: "vsp-console-local", scope: "openid profile", state, nonce: "n".repeat(43), code_challenge: s.codeChallenge, code_challenge_method: "S256", redirect_uri: "https://console.test/auth/callback" }).toString();
    expect(checkAuthorizationUrl(CONFIGURED, good.toString(), { state, codeChallenge: s.codeChallenge })).toBe(good.toString());
    const variant = (mutate: (u: URL) => void) => {
      const u = new URL(good.toString());
      mutate(u);
      return reason(() => checkAuthorizationUrl(CONFIGURED, u.toString(), { state, codeChallenge: s.codeChallenge }));
    };
    expect(variant((u) => (u.host = "evil.local.invalid"))).toBe("OIDC_ENDPOINT_MISMATCH");
    expect(variant((u) => (u.pathname = "/other"))).toBe("OIDC_ENDPOINT_MISMATCH");
    expect(variant((u) => (u.protocol = "http:"))).toBe("OIDC_ENDPOINT_NOT_HTTPS");
    expect(variant((u) => u.searchParams.set("code_challenge_method", "plain"))).toBe("OIDC_AUTHORIZATION_URL_INVALID");
    expect(variant((u) => u.searchParams.set("code_challenge", "x".repeat(43)))).toBe("OIDC_AUTHORIZATION_URL_INVALID");
    expect(variant((u) => u.searchParams.set("state", "T".repeat(43)))).toBe("OIDC_AUTHORIZATION_URL_INVALID");
    expect(variant((u) => u.searchParams.set("scope", "profile"))).toBe("OIDC_AUTHORIZATION_URL_INVALID");
    expect(reason(() => checkAuthorizationUrl({ ...CONFIGURED, status: "BLOCKED" }, good.toString(), { state, codeChallenge: s.codeChallenge }))).toBe("OIDC_NOT_CONFIGURED");
  });

  it("[SPEC-7.staff-sso] the transient PKCE verifier is single-use, bound to the backend state and expires after ten minutes", async () => {
    const s = await createPkceSession();
    const state = "A".repeat(43);
    const t0 = Date.parse("2026-10-17T15:00:00.000Z");
    saveTransient(state, s.codeVerifier, () => t0);
    expect(consumeTransient(state, () => t0 + 1000)).toEqual({ codeVerifier: s.codeVerifier });
    expect(sessionStorage.length).toBe(0);
    expect(reason(() => consumeTransient(state, () => t0 + 2000))).toBe("OIDC_STATE_MISMATCH");

    const late = await createPkceSession();
    saveTransient("B".repeat(43), late.codeVerifier, () => t0);
    expect(reason(() => consumeTransient("B".repeat(43), () => t0 + 10 * 60_000 + 1))).toBe("OIDC_STATE_EXPIRED");
    expect(reason(() => consumeTransient("short"))).toBe("OIDC_STATE_INVALID");
    expect(reason(() => saveTransient("short", late.codeVerifier))).toBe("OIDC_STATE_INVALID");
    // The backend's state is a sealed login state (up to 346 characters); anything beyond 512 is refused.
    const sealed = "S".repeat(346);
    saveTransient(sealed, late.codeVerifier, () => t0);
    expect(consumeTransient(sealed, () => t0 + 1000)).toEqual({ codeVerifier: late.codeVerifier });
    expect(reason(() => saveTransient("S".repeat(513), late.codeVerifier))).toBe("OIDC_STATE_INVALID");
  });
});
