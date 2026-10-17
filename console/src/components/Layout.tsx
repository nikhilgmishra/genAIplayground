/**
 * Role-aware application shell: skip link, banner (persistent environment
 * banner + local fixture badge), navigation, main and footer landmarks, and the
 * live region for action results.
 */
import { useEffect, useRef } from "react";
import type { MouseEvent } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { ROLE_LABELS } from "../auth/roles";
import { navFor } from "../navigation";
import { LiveRegion } from "./Announcer";
import { EnvironmentBanner } from "./EnvironmentBanner";
import { Timestamp } from "./Timestamp";

export function Layout() {
  const auth = useAuth();
  const me = auth.me;
  const location = useLocation();
  const mainRef = useRef<HTMLElement>(null);
  const firstRender = useRef(true);

  // Move focus to the main region after client-side navigation so keyboard and screen-reader users land on the new page.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    mainRef.current?.focus();
  }, [location.pathname]);

  if (!me) return null;
  const items = navFor(me.staff.roles);

  const skipToMain = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    mainRef.current?.focus();
  };

  return (
    <div className="app">
      <a className="skip-link" href="#main-content" onClick={skipToMain}>
        Skip to main content
      </a>
      <header className="app-header">
        <EnvironmentBanner environment={me.environment} localFixture={me.localFixture} />
        <div className="topbar">
          <p className="app-name">Operations and incident control console</p>
          <div className="whoami">
            <p>
              Signed in as <strong>{me.staff.displayLabel}</strong> (<code>{me.staff.staffId}</code>). Roles:{" "}
              {me.staff.roles.map((r) => ROLE_LABELS[r]).join(", ")}. MFA: {me.staff.mfa ? "verified" : "missing"}.
            </p>
            <button type="button" className="button-secondary" onClick={() => void auth.signOut()}>
              Sign out
            </button>
          </div>
        </div>
        {me.staff.breakGlass ? (
          <p className="notice notice-warn" data-testid="break-glass-banner">
            Break-glass access is active until <Timestamp value={me.staff.breakGlass.expiresAt} />, granted by{" "}
            <code>{me.staff.breakGlass.approvedBy}</code> (justification <code>{me.staff.breakGlass.justificationCode}</code>). It is
            time-bound, audited and reviewed; it cannot be requested or extended from this console.
          </p>
        ) : null}
      </header>
      <nav aria-label="Console sections" className="app-nav">
        <ul>
          {items.map((item) => (
            <li key={item.path}>
              <NavLink to={item.path}>{item.label}</NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <main id="main-content" ref={mainRef} tabIndex={-1} className="app-main">
        <LiveRegion />
        <Outlet />
      </main>
      <footer className="app-footer">
        <p>
          Safe, tested actions only: no raw database queries, shared secrets, transcripts or recordings are available in this console. Every
          administrative action is audited, and the server enforces every permission.
        </p>
      </footer>
    </div>
  );
}
