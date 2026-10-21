/**
 * Workforce session state for the console.
 *
 * Production path: workforce SSO run by the backend (WP-05): authorization code + PKCE with MFA, the
 * backend binds state/nonce/challenge/redirect, redeems the code and issues an opaque console session with
 * idle and absolute expiry; the browser refreshes it periodically (bearer rotation; refresh never extends
 * the idle window) and is signed out with the server's reason code when it ends (SESSION_IDLE_EXPIRED,
 * STAFF_DEPROVISIONED, ...). Local path: a clearly labelled synthetic-staff
 * picker that obtains a token from the backend's local workforce IdP fixture
 * (`POST /console/api/v1/auth/local/token`), offered only when the backend
 * reports a local/ci environment running local fixtures (OPS-04).
 *
 * Staff identity and roles always come from the server (`GET me`); nothing the
 * browser holds can add a role.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { AuthConfigResponse, MeResponse, StaffRole } from "../api/contract";
import { useApi } from "../api/ApiContext";
import { toConsoleApiError } from "../api/client";
import { OidcFlowError, checkAuthorizationUrl, consumeTransient, createPkceSession, saveTransient } from "./pkce";

/** How often a live SSO session is refreshed (bearer rotation, IdP re-validation); never extends idle time. */
export const SESSION_REFRESH_INTERVAL_MS = 5 * 60_000;

export type AuthState =
  | { status: "loading" }
  | { status: "signed_out"; reasonCode: string | null }
  | { status: "signed_in"; me: MeResponse };

export interface AuthApi {
  state: AuthState;
  config: AuthConfigResponse | null;
  configError: string | null;
  roles: readonly StaffRole[];
  me: MeResponse | null;
  localSignInAvailable: boolean;
  signInLocal: (staffId: string) => Promise<void>;
  beginOidc: () => Promise<void>;
  completeOidc: (search: URLSearchParams) => Promise<void>;
  /** Rotates the console session bearer (OIDC_SSO sessions only). */
  refreshSession: () => Promise<void>;
  signOut: (reasonCode?: string | null) => Promise<void>;
}

const AuthContext = createContext<AuthApi | null>(null);
const NO_ROLES: readonly StaffRole[] = [];

export interface AuthProviderProps {
  children: ReactNode;
  /** Browser navigation for the IdP redirect (injectable for tests). */
  redirect?: (url: string) => void;
  /** Origin used to build the OIDC redirect URI. */
  origin?: string;
}

export function AuthProvider({ children, redirect, origin }: AuthProviderProps) {
  const api = useApi();
  const [state, setState] = useState<AuthState>({ status: "loading" });
  const [config, setConfig] = useState<AuthConfigResponse | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const mounted = useRef(true);

  const signedOut = useCallback(
    (reasonCode: string | null) => {
      api.tokens.clear();
      if (mounted.current) setState({ status: "signed_out", reasonCode });
    },
    [api],
  );

  /** Loads the server-established identity; refuses sessions without MFA. */
  const loadMe = useCallback(async () => {
    const me = await api.request("me", {});
    if (!me.staff.mfa) {
      signedOut("STAFF_MFA_REQUIRED");
      return;
    }
    if (mounted.current) setState({ status: "signed_in", me });
  }, [api, signedOut]);

  useEffect(() => {
    mounted.current = true;
    api.onUnauthenticated((code) => signedOut(code));
    let cancelled = false;
    void (async () => {
      try {
        const cfg = await api.request("auth.config", {});
        if (!cancelled) setConfig(cfg);
      } catch (err) {
        if (!cancelled) setConfigError(toConsoleApiError(err).reasonCode);
      }
      if (cancelled) return;
      if (api.tokens.get()) {
        try {
          await loadMe();
        } catch (err) {
          signedOut(toConsoleApiError(err).reasonCode);
        }
      } else {
        setState({ status: "signed_out", reasonCode: null });
      }
    })();
    return () => {
      cancelled = true;
      mounted.current = false;
      api.onUnauthenticated(null);
    };
  }, [api, loadMe, signedOut]);

  const localSignInAvailable =
    config !== null && config.mode === "local_fixture" && config.localFixture && (config.environment === "local" || config.environment === "ci");

  const signInLocal = useCallback(
    async (staffId: string) => {
      if (!localSignInAvailable) throw new OidcFlowError("LOCAL_FIXTURE_DISABLED");
      const token = await api.request("auth.localToken", { body: { staffId } });
      if (!token.localFixture) {
        signedOut("LOCAL_FIXTURE_TOKEN_EXPECTED");
        return;
      }
      api.tokens.set(token.accessToken, token.expiresAt);
      await loadMe();
    },
    [api, loadMe, localSignInAvailable, signedOut],
  );

  const redirectUri = `${origin ?? globalThis.location.origin}/auth/callback`;

  const beginOidc = useCallback(async () => {
    if (!config?.oidc || config.oidc.status !== "CONFIGURED") throw new OidcFlowError("OIDC_NOT_CONFIGURED");
    const session = await createPkceSession();
    const started = await api.request("auth.oidcStart", { body: { redirectUri, codeChallenge: session.codeChallenge, codeChallengeMethod: "S256" } });
    const url = checkAuthorizationUrl(config.oidc, started.authorizationUrl, { state: started.state, codeChallenge: session.codeChallenge });
    saveTransient(started.state, session.codeVerifier);
    (redirect ?? ((u: string) => globalThis.location.assign(u)))(url);
  }, [api, config, redirect, redirectUri]);

  const completeOidc = useCallback(
    async (search: URLSearchParams) => {
      if (search.get("error")) throw new OidcFlowError("OIDC_AUTHORIZATION_DENIED");
      const code = search.get("code");
      const returnedState = search.get("state");
      if (!code || !returnedState) throw new OidcFlowError("OIDC_RESPONSE_INVALID");
      const transient = consumeTransient(returnedState);
      const token = await api.request("auth.oidcExchange", {
        body: { code, state: returnedState, codeVerifier: transient.codeVerifier, redirectUri },
      });
      api.tokens.set(token.accessToken, token.expiresAt);
      await loadMe();
    },
    [api, loadMe, redirectUri],
  );

  const refreshSession = useCallback(async () => {
    if (state.status !== "signed_in" || state.me.sessionKind !== "OIDC_SSO" || !api.tokens.get()) return;
    try {
      const token = await api.request("auth.refresh", {});
      api.tokens.set(token.accessToken, token.expiresAt);
    } catch (err) {
      const e = toConsoleApiError(err);
      // A refused refresh ends the session (idle, revoked, offboarded, replayed); an outage does not.
      if (e.status === 401) signedOut(e.reasonCode);
    }
  }, [api, signedOut, state]);

  useEffect(() => {
    if (state.status !== "signed_in" || state.me.sessionKind !== "OIDC_SSO") return;
    const timer = setInterval(() => void refreshSession(), SESSION_REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refreshSession, state]);

  const signOut = useCallback(
    async (reasonCode: string | null = null) => {
      try {
        if (api.tokens.get()) await api.request("auth.logout", {});
      } catch {
        // Local sign-out proceeds even if the server call fails; the token is dropped from memory.
      }
      signedOut(reasonCode);
    },
    [api, signedOut],
  );

  const value = useMemo<AuthApi>(() => {
    const me = state.status === "signed_in" ? state.me : null;
    return {
      state,
      config,
      configError,
      me,
      roles: me ? me.staff.roles : NO_ROLES,
      localSignInAvailable,
      signInLocal,
      beginOidc,
      completeOidc,
      refreshSession,
      signOut,
    };
  }, [state, config, configError, localSignInAvailable, signInLocal, beginOidc, completeOidc, refreshSession, signOut]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthApi {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("AuthProvider missing");
  return ctx;
}

/** Roles of the signed-in staff member (empty when signed out). */
export const useRoles = (): readonly StaffRole[] => useAuth().roles;
