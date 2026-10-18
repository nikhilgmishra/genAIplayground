/**
 * Console application: providers, auth gate and role-guarded routes. Route
 * parameters are opaque identifiers only (spec section 6).
 */
import type { ReactElement } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import type { AuthenticatedEndpointKey } from "./api/contract";
import { ApiProvider } from "./api/ApiContext";
import type { ConsoleApiClient } from "./api/client";
import { AuthProvider, useAuth } from "./auth/AuthProvider";
import { LoginPage } from "./auth/LoginPage";
import { OidcCallbackPage } from "./auth/OidcCallbackPage";
import { RequireRoles } from "./auth/RequireRoles";
import { AnnouncerProvider } from "./components/Announcer";
import { Layout } from "./components/Layout";
import { navFor } from "./navigation";
import { ActiveCallsPage } from "./pages/ActiveCallsPage";
import { ApprovalsPage } from "./pages/ApprovalsPage";
import { AuditSearchPage } from "./pages/AuditSearchPage";
import { BudgetsPage } from "./pages/BudgetsPage";
import { CallInvestigationPage } from "./pages/CallInvestigationPage";
import { DestinationsPage } from "./pages/DestinationsPage";
import { KillSwitchesPage } from "./pages/KillSwitchesPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { OverviewPage } from "./pages/OverviewPage";
import { PendingActionsPage } from "./pages/PendingActionsPage";
import { PlaybooksPage } from "./pages/PlaybooksPage";
import { ReconciliationPage } from "./pages/ReconciliationPage";
import { ReleasesPage } from "./pages/ReleasesPage";
import { SafetyEventsPage } from "./pages/SafetyEventsPage";
import { SupportTracePage } from "./pages/SupportTracePage";

interface RouteDef {
  path: string;
  endpoint: AuthenticatedEndpointKey;
  element: ReactElement;
}

const ROUTES: readonly RouteDef[] = [
  { path: "/overview", endpoint: "overview", element: <OverviewPage /> },
  { path: "/calls", endpoint: "calls.list", element: <ActiveCallsPage /> },
  { path: "/calls/:callId", endpoint: "calls.get", element: <CallInvestigationPage /> },
  { path: "/trace", endpoint: "supportRequests.trace", element: <SupportTracePage /> },
  { path: "/support-requests/:ref", endpoint: "supportRequests.trace", element: <SupportTracePage /> },
  { path: "/actions", endpoint: "actions.pending", element: <PendingActionsPage /> },
  { path: "/reconciliation", endpoint: "reconciliation.list", element: <ReconciliationPage /> },
  { path: "/approvals", endpoint: "workflows.tasks", element: <ApprovalsPage /> },
  { path: "/safety-events", endpoint: "safetyEvents.list", element: <SafetyEventsPage /> },
  { path: "/releases", endpoint: "releases.list", element: <ReleasesPage /> },
  { path: "/budgets", endpoint: "budgets.list", element: <BudgetsPage /> },
  { path: "/kill-switches", endpoint: "killSwitches.list", element: <KillSwitchesPage /> },
  { path: "/audit", endpoint: "audit.search", element: <AuditSearchPage /> },
  { path: "/destinations", endpoint: "destinations.list", element: <DestinationsPage /> },
  { path: "/playbooks", endpoint: "me", element: <PlaybooksPage /> },
];

/** "/" goes to the first section the staff member's roles permit. */
function Home() {
  const { roles } = useAuth();
  const first = navFor(roles)[0];
  return <Navigate to={first ? first.path : "/playbooks"} replace />;
}

function AppRoutes() {
  const auth = useAuth();
  if (auth.state.status === "loading") {
    return (
      <main id="main-content" className="app-main">
        <h1>Operations console</h1>
        <p className="loading">Loading session…</p>
      </main>
    );
  }
  if (auth.state.status === "signed_out") {
    return (
      <Routes>
        <Route path="/auth/callback" element={<OidcCallbackPage />} />
        <Route path="*" element={<LoginPage />} />
      </Routes>
    );
  }
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Home />} />
        {ROUTES.map((r) => (
          <Route key={r.path} path={r.path} element={<RequireRoles endpoint={r.endpoint}>{r.element}</RequireRoles>} />
        ))}
        <Route path="/auth/callback" element={<Navigate to="/" replace />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}

export interface AppProps {
  client: ConsoleApiClient;
  /** IdP redirect (injectable for tests). */
  redirect?: (url: string) => void;
  origin?: string;
}

export function App({ client, redirect, origin }: AppProps) {
  return (
    <ApiProvider client={client}>
      <AnnouncerProvider>
        <AuthProvider redirect={redirect} origin={origin}>
          <AppRoutes />
        </AuthProvider>
      </AnnouncerProvider>
    </ApiProvider>
  );
}
