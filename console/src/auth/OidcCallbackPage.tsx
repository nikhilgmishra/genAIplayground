import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { toConsoleApiError } from "../api/client";
import { ErrorNotice } from "../components/ErrorNotice";
import { useDocumentTitle } from "../lib/useDocumentTitle";
import { useAuth } from "./AuthProvider";
import { OidcFlowError } from "./pkce";

/** Receives the authorization response, exchanges it via the backend, then removes the code from the URL. */
export function OidcCallbackPage() {
  useDocumentTitle("Completing sign-in");
  const auth = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const search = new URLSearchParams(location.search);
    auth.completeOidc(search).then(
      () => navigate("/", { replace: true }),
      (err: unknown) => {
        setError(err instanceof OidcFlowError ? err.reasonCode : toConsoleApiError(err).reasonCode);
        navigate("/auth/callback", { replace: true });
      },
    );
  }, [auth, location.search, navigate]);

  return (
    <main id="main-content" tabIndex={-1} className="app-main">
      <h1>Completing sign-in</h1>
      {error ? <ErrorNotice error={{ reasonCode: error, correlationId: null }} context="Sign-in failed." /> : <p className="loading">Verifying…</p>}
    </main>
  );
}
