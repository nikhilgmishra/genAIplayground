/**
 * Live console unit (WP-07; FO-21-03, FO-14-53, FO-03-49, AUTH-02, OPS-04; WP-05 hand-offs).
 *
 * buildLiveConsole composes the operator console API over a LIVE container (unit "console", database role
 * app_console): the same database, ledger, outbox, workflows, transfers, knowledge, kill switches, budgets and
 * business module as the gateway and the worker, and the WP-05 workforce SSO wired with live adapters only:
 *
 *   - OidcDiscovery / OidcRelyingPartyClient over OidcHttp, which shares the container's EgressGuard and the
 *     egress-classified ConnectorHttpTransport (no global fetch); a ConfigurationRejectedError from discovery
 *     (issuer mismatch, egress refusal) refuses the unit at startup, an unreachable IdP does not (sign-in then
 *     shows as unavailable and every token fails closed);
 *   - WorkforceTokenVerifier.withKeys over the discovered remote JWKS (`discovery.keyResolver()`), the
 *     CLIENT_ROLES / GROUP_PATHS membership mapping and the MFA rule of `consoleAuth` (acceptedMfaAmr null =
 *     the default rule), OidcGroupStaffDirectory, PgConsoleSessionStore, the AES-GCM refresh-token sealer whose
 *     key is the Secrets Manager secret `infrastructure.secrets.consoleSessionSealerRef`, the confidential
 *     client's secret from `adapters.workforce-sso.credentialRef`;
 *   - PgRecoveryService with the logger and the identity-owner policy values (holder SSO evidence at most 14 d,
 *     enrollment challenge 24 h, request proof 120 s), PgBreakGlassGrantSource, LedgerReconciledRetry;
 *   - the WorkforceSsoService sweep (expired sessions, offboarding) on a bounded timer;
 *   - an application-level rate limit on the sign-in routes (/console/api/v1/auth/*), applied to the ROUTE
 *     Fastify matched (`routeOptions.url`, after its own percent-decoding), never to the raw URL, so an encoded
 *     path (`/console/api/v1/%61uth/...`) is the same route and the same budget; keyed on the CLIENT address:
 *     the socket peer, or, only when the peer lies in `infrastructure.trustedProxyCidrs` (the load balancer
 *     ranges), the right-most X-Forwarded-For entry that is not a trusted proxy. A direct client's
 *     X-Forwarded-For is ignored, IPv6 clients share their /64, and a full key table purges expired windows
 *     first and then puts new keys in one shared overflow bucket (tracked clients keep their windows). The guard
 *     makes operator.console NOT_CONFIGURED in staging and production without trusted proxy ranges, because
 *     behind the balancer every operator would otherwise share one key. The edge WAF rule (WP-39) adds a
 *     per-client limit in front.
 *
 * No development bypass is composed (FO-14-53): no local sign-in, no LOCAL FIXTURE workforce IdP or directory,
 * no fixture AMR; assertConsoleDeps refuses each of them outside local/ci as well. The unit refuses to start
 * while operator.console is NOT_CONFIGURED (it has nothing else to serve).
 *
 * Module graph: NOT a transitive production entry point yet. console-api/auth.ts (console-api group) defines the
 * LOCAL FIXTURE sign-in next to the live verifier, so the console-api module graph reaches fixture modules
 * although this file instantiates live classes only (hand-off: split auth.ts; modules.yaml lists this file
 * with `transitive: false`).
 */
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import type { FastifyInstance } from "fastify";
import { OidcRelyingPartyClient } from "../adapters/live/oidc-client.js";
import { OidcDiscovery } from "../adapters/live/oidc-discovery.js";
import { OidcHttp } from "../adapters/live/oidc-http.js";
import { PgAuditHealth } from "../audit/health.js";
import { PgAuditWriter } from "../audit/writer.js";
import { buildBusiness } from "../business/index.js";
import type { BuildBusiness } from "../business/contract.js";
import { WorkforceTokenVerifier } from "../console-api/auth.js";
import { PgBreakGlassIssuance } from "../console-api/break-glass-issuance.js";
import { PgBreakGlassGrantSource } from "../console-api/break-glass.js";
import type { ConsoleApiDeps } from "../console-api/deps.js";
import { OidcGroupStaffDirectory } from "../console-api/oidc-staff-directory.js";
import { CONSOLE_API_BASE } from "../console-api/contract.js";
import type { DependencyHealth } from "../console-api/contract.js";
import { BREAK_GLASS_MAX_DURATION_SECONDS, registerConsoleApi } from "../console-api/plugin.js";
import { LedgerReconciledRetry } from "../console-api/reconciled-retry.js";
import { PgRecoveryService } from "../console-api/recovery.js";
import type { RecoveryPolicy } from "../console-api/recovery.js";
import type { ConsoleSsoDeps } from "../console-api/routes/auth/workforce-auth.js";
import { PgConsoleSessionStore } from "../console-api/sessions.js";
import { parseWorkforceSsoConfig } from "../console-api/sso-config.js";
import type { WorkforceSsoConfig } from "../console-api/sso-config.js";
import { WorkforceSsoService } from "../console-api/sso.js";
import { AesGcmTokenSealer } from "../console-api/token-sealer.js";
import { loadInfrastructureEnv } from "../config/loader.js";
import { IntegrationAuthenticationError } from "../gateway/auth.js";
import type { IntegrationAuthenticator } from "../gateway/auth.js";
import { buildGatewayApp } from "../gateway/http/app.js";
import { routingFromPolicyCatalogue } from "../gateway/pipeline.js";
import type { Logger } from "../observability/ports.js";
import { sha256Hex } from "../shared/canonical.js";
import { addressBucket, clientAddress, parseCidr } from "../shared/cidr.js";
import type { Cidr } from "../shared/cidr.js";
import { iso } from "../shared/clock.js";
import { ConfigurationRejectedError, PlatformError } from "../shared/errors.js";
import { buildLiveContainer } from "./live-container.js";
import type { LiveContainer, LiveContainerOptions } from "./live-container.js";
import { addressClassFor, secretBytes, secretString } from "./live-modules.js";

const CONSOLE_BODY_LIMIT_BYTES = 8 * 1024;
const WORKFORCE_ADAPTER = "workforce-sso";

/** Identity-owner policy values of the dual-controlled recovery path (WP-05 hand-off). */
export const LIVE_RECOVERY_POLICY: Pick<RecoveryPolicy, "holderSsoMaxAgeSeconds" | "enrollmentTtlSeconds" | "requestProofMaxAgeSeconds"> = Object.freeze({
  holderSsoMaxAgeSeconds: 14 * 86_400,
  enrollmentTtlSeconds: 86_400,
  requestProofMaxAgeSeconds: 120,
});

/** Application-level ceiling on the anonymous sign-in endpoints (per source address and window). */
export const DEFAULT_AUTH_RATE_LIMIT = Object.freeze({ max: 60, timeWindowMs: 60_000 });

const noIntegrations: IntegrationAuthenticator = {
  kind: "live",
  async authenticate() {
    throw new IntegrationAuthenticationError("INTEGRATION_CHANNEL_NOT_ALLOWED");
  },
};

export interface LiveConsoleOptions {
  /** WorkforceSsoService.sweep interval (default 60 s; 0 disables the timer, the caller runs `sweepOnce`). */
  sweepIntervalMs?: number;
  /** Rate limit of /console/api/v1/auth/* (default DEFAULT_AUTH_RATE_LIMIT). */
  authRateLimit?: { max: number; timeWindowMs: number };
}

export interface LiveConsole {
  app: FastifyInstance;
  deps: ConsoleApiDeps;
  sso: ConsoleSsoDeps;
  discovery: OidcDiscovery;
  /** One sweep of expired console sessions and offboarded staff (also run by the timer). */
  sweepOnce(): Promise<{ checked: number; revoked: number; unverified: number; purgedLoginTransactions: number }>;
  close(): Promise<void>;
}

/** Shared bucket of the clients that arrive while the key table is full of live windows. */
const OVERFLOW_KEY = "overflow";

/**
 * Fixed-window limiter keyed by client bucket (bounded key table). A full table never drops a tracked client's
 * window: expired windows are purged first, then new clients share the overflow bucket until space frees up.
 */
export class AuthRateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();
  constructor(
    private readonly limit: { max: number; timeWindowMs: number },
    private readonly now: () => number,
    private readonly maxKeys = 10_000,
  ) {
    if (!Number.isInteger(limit.max) || limit.max < 1 || !Number.isInteger(limit.timeWindowMs) || limit.timeWindowMs < 1_000) throw new ConfigurationRejectedError(["CONSOLE_AUTH_RATE_LIMIT_INVALID@console.authRateLimit"]);
  }
  admit(bucket: string): boolean {
    const t = this.now();
    let key = bucket;
    const known = this.windows.get(key);
    if (!known && this.windows.size >= this.maxKeys) {
      for (const [k, w] of this.windows) if (t - w.start >= this.limit.timeWindowMs) this.windows.delete(k);
      if (this.windows.size >= this.maxKeys) key = OVERFLOW_KEY;
    }
    const w = this.windows.get(key);
    if (!w || t - w.start >= this.limit.timeWindowMs) {
      this.windows.set(key, { start: t, count: 1 });
      return true;
    }
    w.count += 1;
    return w.count <= this.limit.max;
  }
}

/** The trusted proxy ranges of the configuration (the guard already refused invalid or public ones). */
function trustedProxies(c: LiveContainer): Cidr[] {
  const out: Cidr[] = [];
  for (const raw of c.config.infrastructure?.trustedProxyCidrs ?? []) {
    const cidr = parseCidr(raw);
    if (!cidr) throw new ConfigurationRejectedError(["TRUSTED_PROXY_CIDR_INVALID@infrastructure.trustedProxyCidrs"]);
    out.push(cidr);
  }
  return out;
}

function killSwitchTargets(c: LiveContainer): ConsoleApiDeps["killSwitchTargets"] {
  const routing = routingFromPolicyCatalogue(c.policy.catalogue);
  const intents = [...new Set(c.catalog.definitions.map((d) => routing.intentFor(d)).filter((x): x is string => typeof x === "string"))].sort();
  return { INTENT: intents, INTEGRATION: Object.keys(c.config.adapters).sort(), MODEL_VERSION: [c.config.models.active.model], VOICE_VERSION: [c.config.models.active.voice] };
}

async function clientSecretOf(c: LiveContainer, ref: string): Promise<string> {
  const raw = await secretString(c.secrets, ref, `adapters.${WORKFORCE_ADAPTER}.credentialRef`);
  try {
    const doc = JSON.parse(raw) as { clientSecret?: unknown };
    if (typeof doc.clientSecret === "string" && doc.clientSecret.length >= 16) return doc.clientSecret;
  } catch {
    // a plain secret string
  }
  if (raw.length < 16) throw new ConfigurationRejectedError([`WORKFORCE_CLIENT_SECRET_INVALID@adapters.${WORKFORCE_ADAPTER}.credentialRef`]);
  return raw;
}

/** Builds the live console over a live container. Throws ConfigurationRejectedError (reason codes only). */
export async function buildLiveConsole(c: LiveContainer, opts: LiveConsoleOptions = {}): Promise<LiveConsole> {
  if (!c.activation.isConfigured("operator.console") || !c.activation.isConfigured("identity.workforce") || !c.config.consoleAuth) {
    const reasons = [...(c.activation.get("operator.console")?.reasons ?? []), ...(c.activation.get("identity.workforce")?.reasons ?? [])];
    throw new ConfigurationRejectedError(reasons.length > 0 ? [...new Set(reasons)].slice(0, 16) : ["CONSOLE_NOT_CONFIGURED@consoleAuth"]);
  }
  const adapter = c.config.adapters[WORKFORCE_ADAPTER];
  const sealerRef = c.config.infrastructure?.secrets.consoleSessionSealerRef ?? null;
  if (!adapter || adapter.kind !== "live" || !adapter.credentialRef) throw new ConfigurationRejectedError([`WORKFORCE_CLIENT_CREDENTIAL_NOT_CONFIGURED@adapters.${WORKFORCE_ADAPTER}`]);
  if (!sealerRef) throw new ConfigurationRejectedError(["CONSOLE_SESSION_SEALER_REF_MISSING@infrastructure.secrets.consoleSessionSealerRef"]);
  let config: WorkforceSsoConfig;
  try {
    config = parseWorkforceSsoConfig(c.config.consoleAuth);
  } catch {
    throw new ConfigurationRejectedError(["WORKFORCE_SSO_CONFIG_INVALID@consoleAuth"]);
  }
  const { clock, db } = c;
  const logger = c.logger.child({ component: "live_console" });

  // Workforce IdP over the container's egress guard and transport (one EgressGuard for every outbound client).
  const issuerHost = new URL(config.issuer).hostname;
  const http = new OidcHttp({ transport: c.transport, egress: c.privacy.egress, destination: { allowedHosts: [issuerHost], addressClass: addressClassFor(c.config, issuerHost) }, dependency: "identity_provider" });
  let discovery: OidcDiscovery;
  try {
    discovery = new OidcDiscovery({ issuer: config.issuer, http, clock, logger });
  } catch (err) {
    throw new ConfigurationRejectedError([`${err instanceof PlatformError && /^[A-Z][A-Z0-9_]{2,63}$/.test(err.reasonCode) ? err.reasonCode : "OIDC_DISCOVERY_INVALID"}@consoleAuth.issuer`]);
  }
  try {
    await discovery.provider();
  } catch (err) {
    // A configuration refusal is a startup error; an unreachable IdP is not (sign-in shows as unavailable).
    if (err instanceof ConfigurationRejectedError) throw err;
    logger.warn("console.sso.discovery_unavailable", { reasonCode: err instanceof PlatformError ? err.reasonCode : "OIDC_PROVIDER_UNAVAILABLE" });
  }
  const credentialRef = adapter.credentialRef;
  const client = new OidcRelyingPartyClient({
    clientId: config.clientId,
    discovery,
    http,
    auth: { method: "client_secret_basic", clientSecret: () => clientSecretOf(c, credentialRef) },
    clock,
    algorithms: ["ES256", "RS256", "PS256"],
    groupsClaim: config.groupsClaim,
    logger,
  });
  const sealerKey = await secretBytes(c.secrets, sealerRef, "infrastructure.secrets.consoleSessionSealerRef");
  if (sealerKey.length !== 32) throw new ConfigurationRejectedError(["CONSOLE_SESSION_SEALER_KEY_INVALID@infrastructure.secrets.consoleSessionSealerRef"]);
  const sealer = new AesGcmTokenSealer({ current: { id: `sm-${sha256Hex(sealerRef).slice(0, 16)}`, key: sealerKey } });
  const directory = new OidcGroupStaffDirectory(config);
  const verifier = WorkforceTokenVerifier.withKeys({ issuer: config.issuer, audience: config.clientId, keys: discovery.keyResolver(), clock, acceptedMfaAmr: config.acceptedMfaAmr, algorithms: ["RS256", "ES256"] });
  const audit = new PgAuditWriter({ db, clock, stream: "console", standaloneRole: "app_console" });
  const auditHealth = new PgAuditHealth({ db, clock, policy: { maxBacklog: c.config.audit.maxBacklog, maxBacklogAgeSeconds: c.config.audit.maxBacklogAgeSeconds }, probeId: "console", role: "app_console" });
  const sessions = new PgConsoleSessionStore(db);
  const service = new WorkforceSsoService({ config, oidc: client, directory, verifier, sessions, sealer, audit, clock, logger });
  const sso: ConsoleSsoDeps = { service, config, authorizationEndpoint: async () => (await discovery.provider()).authorizationEndpoint.href };
  const issuance = new PgBreakGlassIssuance(db, audit, BREAK_GLASS_MAX_DURATION_SECONDS);
  const recovery = new PgRecoveryService({ db, audit, sessions, issuance, clock, tenantId: c.config.tenantId, policy: { ...LIVE_RECOVERY_POLICY }, logger });

  const dependencyHealth = async (): Promise<DependencyHealth[]> =>
    c.activation.entries().map((e) => ({
      dependencyId: e.capabilityId,
      kind: "live",
      status: e.state === "CONFIGURED" ? "HEALTHY" : "DOWN",
      circuit: "UNKNOWN",
      reasonCode: e.state === "CONFIGURED" ? null : "CAPABILITY_NOT_CONFIGURED",
      checkedAt: iso(clock.now()),
    }));

  const deps: ConsoleApiDeps = {
    environment: c.environment,
    clock,
    logger,
    db,
    audit,
    auditHealth,
    policy: c.policy,
    auth: { verifier, staffDirectory: directory, breakGlass: new PgBreakGlassGrantSource(db, logger), localSignIn: null, oidc: null, sso, recovery, breakGlassIssuance: issuance },
    killSwitches: c.ops.killSwitches,
    killSwitchTargets: killSwitchTargets(c),
    budgets: c.ops.budgets,
    budgetFiguresIllustrative: false,
    capacity: c.ops.capacity,
    actions: c.actions,
    providers: c.business.providers,
    // ACT-03: staff retry only after the ledger's latest reconciliation returned NOT_FOUND (same idempotency key).
    reconciledRetry: new LedgerReconciledRetry(c.actions, c.business.providers),
    outbox: c.dispatcher,
    workflows: c.workflows,
    // Read only, under app_console (least privilege: the console's views never write a journey).
    transfers: c.transferReader,
    knowledge: c.knowledge,
    handoff: c.business.handoff,
    supportRequests: c.business.supportRequests,
    destinations: c.config.destinations,
    // TB-07: the live Talkdesk transfer controls are not composed (contact_center.talkdesk NOT_CONFIGURED).
    telephonyTransferAvailable: false,
    callOwnership: null,
    dependencyHealth,
    localFixture: false,
  };
  const app = await buildGatewayApp({ logger, authenticator: noIntegrations, routes: [], rateLimit: null, bodyLimitBytes: CONSOLE_BODY_LIMIT_BYTES, clock });
  const limiter = new AuthRateLimiter(opts.authRateLimit ?? DEFAULT_AUTH_RATE_LIMIT, () => clock.now().getTime());
  const proxies = trustedProxies(c);
  const authPrefix = `${CONSOLE_API_BASE}/auth/`;
  app.addHook("onRequest", async (req, reply) => {
    // The matched route's pattern (decoded and normalised by the router), never the raw request URL.
    const route = req.routeOptions.url;
    if (typeof route !== "string" || !route.startsWith(authPrefix)) return;
    const client = clientAddress(req.socket.remoteAddress, req.headers["x-forwarded-for"], proxies);
    if (!limiter.admit(client ? addressBucket(client) : OVERFLOW_KEY)) {
      c.metrics.increment("vsp_console_auth_rate_limited_total");
      await reply.code(429).header("retry-after", "60").send({ error: { reasonCode: "RATE_LIMITED", correlationId: null, retryable: true } });
    }
  });
  await registerConsoleApi(app, deps);

  const sweepOnce = () => service.sweep();
  const interval = opts.sweepIntervalMs ?? 60_000;
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<unknown> | null = null;
  if (interval > 0) {
    timer = setInterval(() => {
      if (running) return;
      running = sweepOnce()
        .catch((err: unknown) => logger.error("console.sso.sweep_failed", { reasonCode: err instanceof PlatformError ? err.reasonCode : "SWEEP_FAILED" }))
        .finally(() => {
          running = null;
        });
    }, interval);
    timer.unref();
  }
  let closing: Promise<void> | null = null;
  return {
    app,
    deps,
    sso,
    discovery,
    sweepOnce,
    close() {
      closing ??= (async () => {
        if (timer) clearInterval(timer);
        await Promise.resolve(running).catch(() => undefined);
        await app.close().catch(() => undefined);
      })();
      return closing;
    },
  };
}

export interface LiveConsoleRuntime {
  container: LiveContainer;
  console: LiveConsole;
  url: string;
  close(): Promise<void>;
}

/** The live console process: the live container (unit "console") and the console app on PORT (default 8083). */
export async function startLiveConsole(
  opts: { env?: Readonly<Record<string, string | undefined>>; buildBusiness?: BuildBusiness; logger?: Logger; port?: number; console?: LiveConsoleOptions; container?: Omit<LiveContainerOptions, "environment" | "buildBusiness" | "env" | "unit"> } = {},
): Promise<LiveConsoleRuntime> {
  const env = opts.env ?? process.env;
  const infra = loadInfrastructureEnv(env, { defaultPort: 8083 });
  const container = await buildLiveContainer({ ...(opts.container ?? {}), environment: infra.environment, buildBusiness: opts.buildBusiness ?? buildBusiness, env, unit: "console", ...(opts.logger ? { logger: opts.logger } : {}) });
  try {
    const live = await buildLiveConsole(container, opts.console);
    try {
      await live.app.listen({ host: infra.listenHost, port: opts.port ?? infra.port });
    } catch (err) {
      await live.close();
      throw err;
    }
    container.metrics.increment("vsp_live_composition_starts_total", { unit: "console", result: "started" });
    let closing: Promise<void> | null = null;
    return {
      container,
      console: live,
      url: `http://${infra.listenHost}:${(live.app.server.address() as AddressInfo).port}`,
      close() {
        closing ??= live.close().then(() => container.close());
        return closing;
      },
    };
  } catch (err) {
    await container.close();
    throw err;
  }
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  startLiveConsole()
    .then((rt) => {
      const shutdown = () => {
        void rt.close().finally(() => process.exit(0));
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    })
    .catch((err: unknown) => {
      if (err instanceof ConfigurationRejectedError) process.stderr.write(`console.refused ${err.violations.join(" ")}\n`);
      else process.stderr.write(`console.failed ${err instanceof Error && /^[A-Z][A-Z0-9_]{2,63}$/.test(err.message) ? err.message : "STARTUP_FAILED"}\n`);
      process.exitCode = 1;
    });
}
