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

  it("[SPEC-7.staff-sso] OIDC authorization code + PKCE: redirect carries S256 challenge; callback exchange sends verifier and nonce via the backend", async () => {
    const api = createMockApi({ authConfig: authConfigOidc() });
    const redirect = vi.fn<(url: string) => void>();
    const first = renderConsole({ signedIn: false, api, redirect });
    await findPage("Sign in to the operations console");
    expect(screen.queryByRole("heading", { name: "LOCAL DEV SIGN-IN (synthetic staff)" })).not.toBeInTheDocument();
    await first.user.click(screen.getByRole("button", { name: "Sign in with workforce SSO" }));
    // beginOidc awaits the S256 digest (crypto.subtle) before redirecting, so wait for it.
    await waitFor(() => expect(redirect).toHaveBeenCalledTimes(1));
    const authUrl = new URL(redirect.mock.calls[0]?.[0] ?? "");
    expect(`${authUrl.origin}${authUrl.pathname}`).toBe("https://sso-workforce.local.invalid/authorize");
    expect(authUrl.searchParams.get("response_type")).toBe("code");
    expect(authUrl.searchParams.get("client_id")).toBe("vsp-console-local");
    expect(authUrl.searchParams.get("redirect_uri")).toBe("http://console.test/auth/callback");
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authUrl.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const state = authUrl.searchParams.get("state") ?? "";
    const nonce = authUrl.searchParams.get("nonce") ?? "";
    expect(state.length).toBeGreaterThanOrEqual(32);
    first.unmount();

    // The IdP redirects back with the code; transient PKCE state is consumed exactly once.
    const second = renderConsole({ signedIn: false, api, path: `/auth/callback?code=synthetic-code-0001&state=${state}` });
    await findPage("Overview");
    const exchange = api.calls("auth.oidcExchange");
    expect(exchange).toHaveLength(1);
    const body = exchange[0]?.body as { code: string; codeVerifier: string; redirectUri: string; nonce: string };
    expect(body.code).toBe("synthetic-code-0001");
    expect(body.nonce).toBe(nonce);
    expect(body.redirectUri).toBe("http://console.test/auth/callback");
    expect(body.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(sessionStorage.length).toBe(0);
    expect(localStorage.length).toBe(0);
    expect(second.locations.at(-1)).not.toContain("code=");
  });

  it("[SPEC-7.staff-sso] a callback with an unknown state is refused and nothing is exchanged", async () => {
    const api = createMockApi({ authConfig: authConfigOidc() });
    renderConsole({ signedIn: false, api, path: `/auth/callback?code=synthetic-code-0002&state=${"x".repeat(43)}` });
    await findPage("Completing sign-in");
    expect(await screen.findByRole("alert")).toHaveTextContent("OIDC_STATE_MISMATCH");
    expect(api.calls("auth.oidcExchange")).toHaveLength(0);
  });
});
