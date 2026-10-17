import type { Environment } from "../api/contract";

const ENV_LABEL: Readonly<Record<Environment, string>> = {
  local: "LOCAL",
  ci: "CI",
  sandbox: "SANDBOX",
  staging: "STAGING",
  production: "PRODUCTION",
};

/**
 * Persistent environment banner. When the backend runs against labelled local
 * fixtures an explicit badge is always visible (spec section 16).
 */
export function EnvironmentBanner({ environment, localFixture }: { environment: Environment | null; localFixture: boolean }) {
  const label = environment ? ENV_LABEL[environment] : "UNKNOWN";
  return (
    <div className={`env-banner env-${environment ?? "unknown"}`} data-testid="environment-banner">
      <p className="env-text">
        <span className="env-label">Environment: {label}</span>
        {localFixture ? (
          <span className="badge badge-fixture" data-testid="local-fixture-badge">
            LOCAL FIXTURE — SYNTHETIC DATA
          </span>
        ) : null}
        <span className="env-status">Status: IMPLEMENTED_OFFLINE scope; not verified against vendors or production.</span>
      </p>
    </div>
  );
}
