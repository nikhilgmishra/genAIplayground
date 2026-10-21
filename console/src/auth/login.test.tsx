import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { authConfigLocal, authConfigOidc, staffView } from "../test/fixtures";
import { createMockApi } from "../test/mock-api";
import { findPage, renderConsole } from "../test/render";

describe("sign-in and environment labelling", () => {
  it("[OPS-04] local mode offers a clearly labelled synthetic staff picker that obtains a token from the local IdP fixture endpoint", async () => {
    const api = createMockApi();
    const { user, tokens } = renderConsole({ signedIn: false, api });
    await findPage("Sign in to the operations console");
    expect(screen.getByRole("heading", { name: "LOCAL DEV SIGN-IN (synthetic staff)" })).toBeInTheDocument();
    expect(screen.getByTestId("local-fixture-badge")).toHaveTextContent("LOCAL FIXTURE — SYNTHETIC DATA");
    await screen.findByRole("radio", { name: /Synthetic Auditor/ });
    const submit = screen.getByRole("button", { name: "Sign in as selected synthetic staff" });
    expect(submit).toBeDisabled();
    await user.click(screen.getByRole("radio", { name: /Synthetic Auditor/ }));
    await user.click(submit);
    // "/" lands on the first section the auditor's roles permit.
    await findPage("Releases review");
    const tokenCalls = api.calls("auth.localToken");
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0]?.path).toBe("/console/api/v1/auth/local/token");
    expect(tokenCalls[0]?.body).toEqual({ staffId: "stf_synthAuditor00001" });
    expect(tokens.get()).toBe("synthetic-token.stf_synthAuditor00001");
    expect(screen.getByTestId("local-fixture-badge")).toBeInTheDocument();
  });

  it("[OPS-04] the local picker is not offered outside local/ci, even if a backend claims fixture mode", async () => {
    const api = createMockApi({ authConfig: authConfigLocal({ environment: "production" }) });
    renderConsole({ signedIn: false, api });
    await findPage("Sign in to the operations console");
    await screen.findByText(/Environment: PRODUCTION/);
    expect(screen.queryByRole("heading", { name: "LOCAL DEV SIGN-IN (synthetic staff)" })).not.toBeInTheDocument();
    expect(api.calls("auth.localStaff")).toHaveLength(0);
  });

  it("[SPEC-16.console] the LOCAL FIXTURE badge is persistent when localFixture is true and absent when false", async () => {
    const first = renderConsole({ path: "/overview" });
    await findPage("Overview");
    expect(screen.getByTestId("environment-banner")).toHaveTextContent("Environment: LOCAL");
    expect(screen.getByTestId("local-fixture-badge")).toHaveTextContent("LOCAL FIXTURE — SYNTHETIC DATA");
    first.unmount();

    const api = createMockApi({ meOverrides: { environment: "sandbox", localFixture: false } });
    renderConsole({ path: "/overview", api });
    await findPage("Overview");
    expect(screen.getByTestId("environment-banner")).toHaveTextContent("Environment: SANDBOX");
    expect(screen.queryByTestId("local-fixture-badge")).not.toBeInTheDocument();
  });

  it("[SPEC-7.staff] a session without MFA is refused and the token is dropped", async () => {
    const api = createMockApi();
    const { tokens } = renderConsole({ path: "/overview", staff: staffView("supervisor", { mfa: false, staffId: "stf_synthNoMfaStaff01" }), api });
    await findPage("Sign in to the operations console");
    expect(screen.getByRole("alert")).toHaveTextContent("STAFF_MFA_REQUIRED");
    expect(tokens.get()).toBeNull();
    expect(api.calls("overview")).toHaveLength(0);
  });

  it("[SPEC-7.staff-sso] workforce SSO shows BLOCKED with the prerequisite when no OIDC client is configured", async () => {
    renderConsole({ signedIn: false });
    await findPage("Sign in to the operations console");
    expect(screen.getByText(/Workforce SSO is BLOCKED/)).toHaveTextContent("PRQ-036");
    expect(screen.queryByRole("button", { name: "Sign in with workforce SSO" })).not.toBeInTheDocument();
  });

  it("[FO-05-09][FO-05-10][SPEC-7.staff-sso] backend-run authorization code + PKCE: the backend starts the login with our S256 challenge and redeems the code; IdP tokens never reach the browser", async () => {
    const api = createMockApi({ authConfig: authConfigOidc() });
    const redirect = vi.fn<(url: string) => void>();
    const first = renderConsole({ signedIn: false, api, redirect });
    await findPage("Sign in to the operations console");
    expect(screen.queryByRole("heading", { name: "LOCAL DEV SIGN-IN (synthetic staff)" })).not.toBeInTheDocument();
    await first.user.click(screen.getByRole("button", { name: "Sign in with workforce SSO" }));
    await waitFor(() => expect(redirect).toHaveBeenCalledTimes(1));
    const start = api.calls("auth.oidcStart");
    expect(start).toHaveLength(1);
    const startBody = start[0]?.body as { redirectUri: string; codeChallenge: string; codeChallengeMethod: string };
    expect(startBody).toMatchObject({ redirectUri: "http://console.test/auth/callback", codeChallengeMethod: "S256" });
    expect(startBody.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(startBody)).not.toMatch(/verifier|nonce|state/i);
    const authUrl = new URL(redirect.mock.calls[0]?.[0] ?? "");
    expect(`${authUrl.origin}${authUrl.pathname}`).toBe("https://sso-workforce.local.invalid/authorize");
    expect(authUrl.searchParams.get("code_challenge")).toBe(startBody.codeChallenge);
    const state = authUrl.searchParams.get("state") ?? "";
    first.unmount();

    // The IdP redirects back with the code; the verifier is consumed exactly once and sent with the backend state.
    const second = renderConsole({ signedIn: false, api, path: `/auth/callback?code=synthetic-code-0001&state=${state}` });
    await findPage("Overview");
    const exchange = api.calls("auth.oidcExchange");
    expect(exchange).toHaveLength(1);
    const body = exchange[0]?.body as { code: string; state: string; codeVerifier: string; redirectUri: string };
    expect(body).toMatchObject({ code: "synthetic-code-0001", state, redirectUri: "http://console.test/auth/callback" });
    expect(body.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(Object.keys(body).sort()).toEqual(["code", "codeVerifier", "redirectUri", "state"]);
    expect(sessionStorage.length).toBe(0);
    expect(localStorage.length).toBe(0);
    expect(second.locations.at(-1)).not.toContain("code=");
  });

  it("[FO-05-13] a backend answer pointing anywhere but the configured IdP endpoint is never followed", async () => {
    const api = createMockApi({
      authConfig: authConfigOidc(),
      handlers: {
        "auth.oidcStart": () => ({ status: 200, body: { authorizationUrl: "https://evil.local.invalid/authorize?state=x", state: "S".repeat(43), expiresAt: "2099-01-01T00:00:00.000Z" } }),
      },
    });
    const redirect = vi.fn<(url: string) => void>();
    const r = renderConsole({ signedIn: false, api, redirect });
    await findPage("Sign in to the operations console");
    await r.user.click(screen.getByRole("button", { name: "Sign in with workforce SSO" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("OIDC_ENDPOINT_MISMATCH");
    expect(redirect).not.toHaveBeenCalled();
    expect(sessionStorage.length).toBe(0);
  });

  it("[FO-05-19][FO-05-18] an SSO session is refreshed by bearer rotation; a refused refresh (idle, revoked) signs the user out with the server reason", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const api = createMockApi({ meOverrides: { sessionKind: "OIDC_SSO", idleTimeoutSeconds: 900, localFixture: false, environment: "sandbox" } });
      const { tokens } = renderConsole({ path: "/overview", api });
      await findPage("Overview");
      const before = tokens.get();
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 10);
      await waitFor(() => expect(api.calls("auth.refresh")).toHaveLength(1));
      const refresh = api.calls("auth.refresh")[0];
      expect(refresh?.headers.authorization).toBe(`Bearer ${before}`);
      await waitFor(() => expect(tokens.get()).not.toBe(before));
      api.setHandler("auth.refresh", () => ({ status: 401, body: { error: { reasonCode: "SESSION_IDLE_EXPIRED", correlationId: null, retryable: false } } }));
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 10);
      await findPage("Sign in to the operations console");
      expect(screen.getByRole("alert")).toHaveTextContent("SESSION_IDLE_EXPIRED");
      expect(tokens.get()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("[SPEC-7.staff-sso] a callback with an unknown state is refused and nothing is exchanged", async () => {
    const api = createMockApi({ authConfig: authConfigOidc() });
    renderConsole({ signedIn: false, api, path: `/auth/callback?code=synthetic-code-0002&state=${"x".repeat(43)}` });
    await findPage("Completing sign-in");
    expect(await screen.findByRole("alert")).toHaveTextContent("OIDC_STATE_MISMATCH");
    expect(api.calls("auth.oidcExchange")).toHaveLength(0);
  });
});
