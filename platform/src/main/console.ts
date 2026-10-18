/**
 * LOCAL FIXTURE console composition: ConsoleApiDeps over a built local
 * Container (same database, ledger, outbox, workflows, transfers, knowledge,
 * ops and business module), with the LOCAL FIXTURE workforce IdP, SYNTHETIC
 * staff directory and local sign-in. Served on its own loopback app (never on
 * the gateway's public surface; the deployed console access path is not in
 * the infrastructure plan). Refused outside local/ci (OPS-04): workforce SSO
 * is BLOCKED (PRQ-036).
 */
import type { FastifyInstance } from "fastify";
import { PgAuditHealth } from "../audit/health.js";
import { PgAuditWriter } from "../audit/writer.js";
import { LocalOidcProviderFixture } from "../adapters/local/oidc-fixture.js";
import { LocalStaffDirectoryFixture, LocalWorkforceSignInFixture, WorkforceTokenVerifier } from "../console-api/auth.js";
import { PgBreakGlassGrantSource } from "../console-api/break-glass.js";
import type { DependencyHealth } from "../console-api/contract.js";
import type { ConsoleApiDeps } from "../console-api/deps.js";
import { registerConsoleApi } from "../console-api/plugin.js";
import { LedgerReconciledRetry } from "../console-api/reconciled-retry.js";
import { IDP } from "../fixtures/synthetic-world.js";
import { IntegrationAuthenticationError } from "../gateway/auth.js";
import type { IntegrationAuthenticator } from "../gateway/auth.js";
import { buildGatewayApp } from "../gateway/http/app.js";
import { routingFromPolicyCatalogue } from "../gateway/pipeline.js";
import { iso } from "../shared/clock.js";
import { ConfigurationRejectedError } from "../shared/errors.js";
import type { Container } from "./container.js";

const CONSOLE_BODY_LIMIT_BYTES = 8 * 1024;

const noIntegrations: IntegrationAuthenticator = {
  kind: "live",
  async authenticate() {
    throw new IntegrationAuthenticationError("INTEGRATION_CHANNEL_NOT_ALLOWED");
  },
};

export interface LocalConsole {
  app: FastifyInstance;
  deps: ConsoleApiDeps;
  workforceIdp: LocalOidcProviderFixture;
}

/** Kill-switch targets from trusted configuration only (catalogue intents, registered integrations, active versions). */
function killSwitchTargets(c: Container): ConsoleApiDeps["killSwitchTargets"] {
  const routing = routingFromPolicyCatalogue(c.policy.catalogue);
  const intents = [...new Set(c.catalog.definitions.map((d) => routing.intentFor(d)).filter((x): x is string => typeof x === "string"))].sort();
  const integrations = [...new Set([...Object.keys(c.adapters.kinds()), "talkdesk-local"])].sort();
  return { INTENT: intents, INTEGRATION: integrations, MODEL_VERSION: [c.config.models.active.model], VOICE_VERSION: [c.config.models.active.voice] };
}

export async function buildLocalConsole(c: Container): Promise<LocalConsole> {
  if (c.environment !== "local" && c.environment !== "ci") throw new ConfigurationRejectedError(["CONSOLE_LOCAL_COMPOSITION_OUTSIDE_LOCAL_CI@console"]);
  const { clock, db, logger } = c;
  const workforceIdp = await LocalOidcProviderFixture.create({ clock, issuers: [IDP.workforceIssuer], audience: IDP.consoleAudience });
  const staffDirectory = new LocalStaffDirectoryFixture(IDP.workforceIssuer, c.config.tenantId, []);
  const verifier = WorkforceTokenVerifier.localFixture({ idp: workforceIdp, clock });
  const localSignIn = new LocalWorkforceSignInFixture({ environment: c.environment, idp: workforceIdp, directory: staffDirectory, clock });
  const audit = new PgAuditWriter({ db, clock, stream: "console", standaloneRole: "app_console" });
  const auditHealth = new PgAuditHealth({
    db,
    clock,
    policy: { maxBacklog: c.config.audit.maxBacklog, maxBacklogAgeSeconds: c.config.audit.maxBacklogAgeSeconds },
    probeId: "console",
    role: "app_console",
  });
  const dependencyHealth = async (): Promise<DependencyHealth[]> => {
    const rows = await c.adapters.healthReport();
    return rows.map((r) => ({
      dependencyId: r.component,
      kind: r.kind,
      status: r.healthy ? "HEALTHY" : "DOWN",
      circuit: "UNKNOWN",
      reasonCode: r.reasonCode,
      checkedAt: iso(clock.now()),
    }));
  };
  const deps: ConsoleApiDeps = {
    environment: c.environment,
    clock,
    logger,
    db,
    audit,
    auditHealth,
    policy: c.policy,
    auth: { verifier, staffDirectory, breakGlass: new PgBreakGlassGrantSource(db, logger), localSignIn, oidc: null },
    killSwitches: c.ops.killSwitches,
    killSwitchTargets: killSwitchTargets(c),
    budgets: c.ops.budgets,
    budgetFiguresIllustrative: true,
    capacity: c.ops.capacity,
    actions: c.actions,
    providers: c.business.providers,
    // ACT-03: staff retry only after the ledger's latest reconciliation returned NOT_FOUND (same idempotency key).
    reconciledRetry: new LedgerReconciledRetry(c.actions, c.business.providers),
    outbox: c.dispatcher,
    workflows: c.workflows,
    transfers: c.transferStore,
    knowledge: c.knowledge,
    handoff: c.business.handoff,
    supportRequests: c.business.supportRequests,
    destinations: c.config.destinations,
    telephonyTransferAvailable: c.fixtures.telephony.kind === "local_fixture",
    callOwnership: null,
    dependencyHealth,
    localFixture: true,
  };
  const app = await buildGatewayApp({ logger, authenticator: noIntegrations, routes: [], rateLimit: null, bodyLimitBytes: CONSOLE_BODY_LIMIT_BYTES });
  await registerConsoleApi(app, deps);
  return { app, deps, workforceIdp };
}
