/**
 * Sign-in page. Workforce SSO (OIDC authorization code + PKCE, MFA enforced by
 * the IdP and re-checked by the server). In local fixture mode only, a clearly
 * labelled synthetic staff picker obtains a token from the backend's local
 * workforce IdP fixture endpoint.
 */
import { useEffect, useId, useState } from "react";
import type { FormEvent } from "react";
import type { LocalStaffOption } from "../api/contract";
import { useApi } from "../api/ApiContext";
import { toConsoleApiError } from "../api/client";
import { EnvironmentBanner } from "../components/EnvironmentBanner";
import { ErrorNotice } from "../components/ErrorNotice";
import { useDocumentTitle } from "../lib/useDocumentTitle";
import { useAuth } from "./AuthProvider";
import { OidcFlowError } from "./pkce";
import { ROLE_LABELS } from "./roles";

function errorCode(err: unknown): string {
  return err instanceof OidcFlowError ? err.reasonCode : toConsoleApiError(err).reasonCode;
}

function LocalSignIn() {
  const api = useApi();
  const auth = useAuth();
  const legendId = useId();
  const [staff, setStaff] = useState<LocalStaffOption[] | null>(null);
  const [selected, setSelected] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.request("auth.localStaff", {}).then(
      (res) => {
        if (!cancelled) setStaff(res.staff);
      },
      (err: unknown) => {
        if (!cancelled) setError(errorCode(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await auth.signInLocal(selected);
    } catch (err) {
      setError(errorCode(err));
      setBusy(false);
    }
  };

  return (
    <section className="local-signin" aria-labelledby={legendId}>
      <h2 id={legendId}>LOCAL DEV SIGN-IN (synthetic staff)</h2>
      <p className="notice notice-warn">
        Local fixture only: these are synthetic staff from the local workforce IdP fixture. This sign-in exists only in local and CI
        environments; production configuration rejects it.
      </p>
      {error ? <ErrorNotice error={{ reasonCode: error, correlationId: null }} context="Local sign-in failed." /> : null}
      {staff === null && !error ? <p className="loading">Loading synthetic staff…</p> : null}
      {staff ? (
        <form onSubmit={(e) => void submit(e)}>
          <fieldset className="fieldset">
            <legend>Choose a synthetic staff member</legend>
            {staff.map((s) => (
              <div className="radio" key={s.staffId}>
                <input
                  type="radio"
                  id={`staff-${s.staffId}`}
                  name="synthetic-staff"
                  value={s.staffId}
                  checked={selected === s.staffId}
                  onChange={() => setSelected(s.staffId)}
                />
                <label htmlFor={`staff-${s.staffId}`}>
                  {s.displayLabel} — {s.roles.map((r) => ROLE_LABELS[r]).join(", ")} (<code>{s.staffId}</code>)
                </label>
              </div>
            ))}
          </fieldset>
          <button type="submit" disabled={!selected || busy}>
            Sign in as selected synthetic staff
          </button>
        </form>
      ) : null}
    </section>
  );
}

export function LoginPage() {
  useDocumentTitle("Sign in");
  const auth = useAuth();
  const [error, setError] = useState<string | null>(null);
  const cfg = auth.config;
  const signedOutReason = auth.state.status === "signed_out" ? auth.state.reasonCode : null;
  const oidc = cfg?.oidc ?? null;

  const startSso = async () => {
    setError(null);
    try {
      await auth.beginOidc();
    } catch (err) {
      setError(errorCode(err));
    }
  };

  return (
    <div className="app">
      <header className="app-header">
        <EnvironmentBanner environment={cfg?.environment ?? null} localFixture={cfg?.localFixture ?? false} />
        <div className="topbar">
          <p className="app-name">Operations and incident control console</p>
        </div>
      </header>
      <main id="main-content" tabIndex={-1} className="app-main">
        <h1>Sign in to the operations console</h1>
        <p>Staff sign in through workforce single sign-on with multi-factor authentication. Access follows least privilege per role.</p>
        {signedOutReason ? (
          <div role="alert" className="notice notice-error">
            <p>
              You are signed out. Reason code: <code>{signedOutReason}</code>
            </p>
          </div>
        ) : null}
        {auth.configError ? <ErrorNotice error={{ reasonCode: auth.configError, correlationId: null }} context="Sign-in configuration unavailable." /> : null}
        {error ? <ErrorNotice error={{ reasonCode: error, correlationId: null }} context="Single sign-on could not start." /> : null}

        <section aria-labelledby="sso-heading">
          <h2 id="sso-heading">Workforce single sign-on</h2>
          {oidc && oidc.status === "CONFIGURED" ? (
            <button type="button" onClick={() => void startSso()}>
              Sign in with workforce SSO
            </button>
          ) : (
            <p className="notice notice-warn">
              Workforce SSO is BLOCKED: no OIDC client is configured for this environment
              {oidc?.blockedReasonCode ? (
                <>
                  {" "}
                  (reason code <code>{oidc.blockedReasonCode}</code>)
                </>
              ) : null}
              . Owner: identity owner (prerequisite PRQ-036).
            </p>
          )}
        </section>

        {auth.localSignInAvailable ? <LocalSignIn /> : null}
      </main>
    </div>
  );
}
