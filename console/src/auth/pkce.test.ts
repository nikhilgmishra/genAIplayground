import { describe, expect, it } from "vitest";
import type { OidcClientConfig } from "../api/contract";
import { OidcFlowError, buildAuthorizationUrl, consumeTransient, createPkceSession, s256Challenge, saveTransient } from "./pkce";

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

  it("[SPEC-7.staff-sso] sessions use a 43-character verifier and high-entropy state and nonce", async () => {
    const a = await createPkceSession();
    const b = await createPkceSession();
    expect(a.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.codeChallenge).toBe(await s256Challenge(a.codeVerifier));
    expect(a.state).not.toBe(b.state);
    expect(a.nonce).not.toBe(b.nonce);
  });

  it("[SPEC-7.staff-sso] the authorization URL requires a configured HTTPS endpoint and always requests openid with S256", async () => {
    const s = await createPkceSession();
    const url = new URL(buildAuthorizationUrl(CONFIGURED, "http://console.test/auth/callback", s));
    expect(url.searchParams.get("scope")).toBe("openid profile");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(reason(() => buildAuthorizationUrl({ ...CONFIGURED, authorizationEndpoint: "http://sso-workforce.local.invalid/authorize" }, "x", s))).toBe("OIDC_ENDPOINT_NOT_HTTPS");
    expect(reason(() => buildAuthorizationUrl({ ...CONFIGURED, status: "BLOCKED" }, "x", s))).toBe("OIDC_NOT_CONFIGURED");
  });

  it("[SPEC-7.staff-sso] transient PKCE state is single-use, bound to state and expires after ten minutes", async () => {
    const s = await createPkceSession();
    const t0 = Date.parse("2026-10-17T15:00:00.000Z");
    saveTransient(s, () => t0);
    expect(consumeTransient(s.state, () => t0 + 1000)).toEqual({ codeVerifier: s.codeVerifier, nonce: s.nonce });
    expect(sessionStorage.length).toBe(0);
    expect(reason(() => consumeTransient(s.state, () => t0 + 2000))).toBe("OIDC_STATE_MISMATCH");

    const late = await createPkceSession();
    saveTransient(late, () => t0);
    expect(reason(() => consumeTransient(late.state, () => t0 + 10 * 60_000 + 1))).toBe("OIDC_STATE_EXPIRED");
    expect(reason(() => consumeTransient("short"))).toBe("OIDC_STATE_INVALID");
  });
});
