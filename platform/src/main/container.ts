/**
 * Composition root (gateway + worker). The configuration guard runs FIRST: the
 * reviewed config file for the environment is loaded, the policy bundle and
 * the committed tool catalogue digest are read, and `assertDeployable` decides
 * whether anything may be constructed (OPS-04). A rejected configuration throws
 * ConfigurationRejectedError before any database, adapter, HTTP server or port
 * exists.
 *
 * local / ci (IMPLEMENTED_OFFLINE): PGlite with every migration, the OPA WASM
 * policy bundle, the in-memory session store, the identity services over the
 * LOCAL FIXTURE directory / OIDC / notifications, the real audit writer, health,
 * query and shipper (LOCAL FIXTURE file sink), the action ledger, outbox +
 * dispatcher + in-memory publisher (LOCAL FIXTURE), the workflow engine, the
 * transfer coordinator over the telephony fixture, safety, voice templates and
 * response gate, the knowledge service over the SYNTHETIC approved corpus,
 * support memory, ops (kill switches, budgets with an ILLUSTRATIVE local budget,
 * capacity, admission), every local adapter fixture in the AdapterRegistry,
 * then the business module (BuildBusiness injected by the entry point), the
 * pinned catalogue (must equal schemas/tools/catalog.json), the ToolPipeline and
 * the gateway Fastify app with LOCAL FIXTURE integration tokens.
 *
 * sandbox / staging / production: after the guard, the live composition is
 * refused (LIVE_COMPOSITION_NOT_IMPLEMENTED): live database/session-store/
 * queue/audit-sink wiring, live business adapters and JWKS-backed inbound
 * authentication are not connected here (BLOCKED on the prerequisites listed
 * in the README). Nothing is simulated in their place.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { LedgerActionService } from "../actions/action-service.js";
import { ToolRequestIdempotency } from "../actions/tool-idempotency.js";
import { createLocalFixtureSet } from "../adapters/local/fixture-set.js";
import type { LocalFixtureSet } from "../adapters/local/fixture-set.js";
import { LocalIdentityDirectoryFixture } from "../adapters/local/identity-directory.js";
import { NotificationFixture } from "../adapters/local/notification-fixture.js";
import { LocalOidcProviderFixture, LocalOidcVerifierFixture } from "../adapters/local/oidc-fixture.js";
import { createBlockedLiveRegistry } from "../adapters/live/blocked-set.js";
import type { AdapterRegistry } from "../adapters/registry.js";
import { PgAuditHealth } from "../audit/health.js";
import { PgAuditQuery } from "../audit/query.js";
import { AuditShipper } from "../audit/shipper.js";
import { LocalFsAuditSinkFixture } from "../audit/sinks/local-fs.js";
import { PgAuditWriter } from "../audit/writer.js";
import type { BuildBusiness, BusinessModule, ToolDeps } from "../business/contract.js";
import { loadInfrastructureEnv } from "../config/loader.js";
import type { PlatformConfig } from "../config/ports.js";
import { gatewayConfigOf } from "../config/schema.js";
import { loadDeployableConfig } from "../config/startup.js";
import type { GuardReport } from "../config/guard.js";
import { migrate } from "../db/migrate.js";
import { PgliteDb } from "../db/pglite.js";
import { STAFF } from "../fixtures/synthetic-world.js";
import { CATALOG_FILE, buildCatalog, catalogDriftAgainst, loadPinnedCatalogFile } from "../gateway/catalog.js";
import type { PinnedCatalog } from "../gateway/catalog.js";
import { LocalFixtureTokenAuthenticator } from "../gateway/auth.js";
import type { IntegrationAuthenticator } from "../gateway/auth.js";
import { HandoffIndex, PgPendingActionLookup, SessionLeaseRegistry } from "../gateway/call-state.js";
import { GatewayAudit } from "../gateway/gateway-audit.js";
import { buildGatewayApp } from "../gateway/http/app.js";
import { ReadinessProbe, healthRoutes } from "../gateway/http/health-routes.js";
import { portalRoutes } from "../gateway/http/portal-routes.js";
import { telephonyRoutes } from "../gateway/http/telephony-routes.js";
import { toolRoutes } from "../gateway/http/tool-routes.js";
import { webhookRoutes } from "../gateway/http/webhook-routes.js";
import { mcpRoutes } from "../gateway/mcp.js";
import { ToolPipeline, routingFromPolicyCatalogue } from "../gateway/pipeline.js";
import { LocalInteractionLookupFixture, SessionBindingResolver } from "../gateway/session-binding.js";
import { AssertionKeyRing } from "../identity/assertions/key-ring.js";
import { SignedAssertionService } from "../identity/assertions/assertion-service.js";
import { LocalEs256Signer } from "../identity/assertions/signers.js";
import { identityConfigFromPlatform } from "../identity/config.js";
import { LOCAL_FIXTURE_OTP_PEPPER } from "../identity/identity-harness.fixture.js";
import { MemoryKvStoreFixture } from "../identity/kv/memory-kv-store.js";
import { TrustedSessionService } from "../identity/session-service.js";
import { SecureVerificationService } from "../identity/verification-service.js";
import { LOCAL_ALLOWED_LINK_DOMAINS, loadLocalCorpus } from "../knowledge/corpus.js";
import type { KnowledgeItemInput } from "../knowledge/ports.js";
import { KnowledgeServicePg } from "../knowledge/service.js";
import { SupportMemoryPg } from "../memory/support-memory.js";
import { createLogger } from "../observability/logger.js";
import { InMemoryMetrics, createMetricCatalogue } from "../observability/metrics.js";
import type { Logger } from "../observability/ports.js";
import { createOpsServices } from "../ops/compose.js";
import type { OpsServices } from "../ops/compose.js";
import { PgOutboxDispatcher } from "../outbox/dispatcher.js";
import { MemoryPublisherFixture } from "../outbox/memory-publisher.fixture.js";
import { PgOutbox } from "../outbox/outbox.js";
import { OpaWasmPolicyEngine } from "../policy/engine.js";
import { ensurePolicyBundle } from "../policy/ensure-bundle.js";
import type { Environment, VersionSet } from "../protocol/index.js";
import { PROTOCOL_VERSION } from "../protocol/index.js";
import { CircuitBreakerRegistry } from "../resilience/circuit-breaker.js";
import { DatasetRegistry, SUPPORT_MEMORY_DATASET } from "../retention/registry.js";
import { RetentionJob } from "../retention/job.js";
import { RuleBasedSafetySignalDetector } from "../safety/detector.js";
import { SafetyPipeline } from "../safety/pipeline.js";
import { DeterministicSafetyRouter } from "../safety/router.js";
import type { Clock } from "../shared/clock.js";
import { iso, systemClock } from "../shared/clock.js";
import { ConfigurationRejectedError } from "../shared/errors.js";
import { TemplateResponseGate } from "../voice/gate.js";
import { loadDefaultTemplateRegistry } from "../voice/registry.js";
import type { TemplateRegistry } from "../voice/ports.js";
import { InMemoryTurnTracker } from "../voice/turns.js";
import { PgWorkflowEngine } from "../workflows/engine.js";
import { createDefaultRegistry } from "../workflows/registry.js";
import { MemoryTransferStore, TransferCoordinator } from "../workflows/transfer.js";

export const LOCAL_CONTAINER_LABEL = "LOCAL FIXTURE COMPOSITION — SYNTHETIC DATA ONLY — NOT A PRODUCTION DEPLOYMENT";

/** Runtime components that are not business adapters but are reported to the guard (OPS-04). */
export const RUNTIME_COMPONENTS = ["session-store", "transfer-store", "outbox-publisher", "audit-sink", "integration-auth", "interaction-lookup", "metrics-sink"] as const;

export interface ContainerOptions {
  environment: Environment;
  /** Business module factory (platform/src/business buildBusiness, or a stub in tests). */
  buildBusiness: BuildBusiness;
  clock?: Clock;
  env?: Readonly<Record<string, string | undefined>>;
  configDir?: string;
  repoRoot?: string;
  logger?: Logger;
  /** Tool names known to the metric catalogue (defaults to the committed catalogue's names). */
  metricToolNames?: readonly string[];
  /**
   * local/ci only: accept a business module whose catalogue differs from
   * schemas/tools/catalog.json (stub business in tests). Refused elsewhere.
   */
  allowUncommittedCatalog?: boolean;
  /** Ingest the SYNTHETIC approved knowledge corpus (default true). */
  ingestKnowledge?: boolean;
  /** OTP fallback switch (TB-03: default false). */
  otpEnabled?: boolean;
  /** Per-integration rate limit; null disables (tests). Defaults to the gateway config or 600/min. */
  rateLimit?: { max: number; timeWindowMs: number } | null;
  /** Directory for the LOCAL FIXTURE audit sink (a fresh temp dir by default, removed on close). */
  auditSinkDir?: string;
}

export interface Container {
  label: string;
  environment: Environment;
  config: PlatformConfig;
  report: GuardReport;
  tenantIds: readonly string[];
  mutationsEnabled: boolean;
  clock: Clock;
  logger: Logger;
  metrics: InMemoryMetrics;
  db: PgliteDb;
  policy: OpaWasmPolicyEngine;
  kv: MemoryKvStoreFixture;
  identity: {
    sessions: TrustedSessionService;
    verification: SecureVerificationService;
    assertions: SignedAssertionService;
    directory: LocalIdentityDirectoryFixture;
    notifications: NotificationFixture;
    idp: LocalOidcProviderFixture;
  };
  audit: PgAuditWriter;
  auditHealth: PgAuditHealth;
  auditQuery: PgAuditQuery;
  auditSink: LocalFsAuditSinkFixture;
  auditShipper: AuditShipper;
  outbox: PgOutbox;
  publisher: MemoryPublisherFixture;
  dispatcher: PgOutboxDispatcher;
  actions: LedgerActionService;
  toolIdempotency: ToolRequestIdempotency;
  fixtures: LocalFixtureSet;
  adapters: AdapterRegistry;
  workflows: PgWorkflowEngine;
  transferStore: MemoryTransferStore;
  transfers: TransferCoordinator;
  knowledge: KnowledgeServicePg;
  memory: SupportMemoryPg;
  ops: OpsServices;
  templates: TemplateRegistry;
  turns: InMemoryTurnTracker;
  safety: SafetyPipeline;
  versions: VersionSet;
  deps: ToolDeps;
  business: BusinessModule;
  catalog: PinnedCatalog;
  pipeline: ToolPipeline;
  interactionLookup: LocalInteractionLookupFixture;
  leases: SessionLeaseRegistry;
  handoffs: HandoffIndex;
  authenticator: IntegrationAuthenticator;
  retention: RetentionJob;
  app: FastifyInstance;
  close(): Promise<void>;
}

const OFFLINE: readonly Environment[] = ["local", "ci"];

/** Policy bundle for the guard: built from sources offline; only the pre-built bundle elsewhere (null if unreadable). */
async function loadPolicyForGuard(environment: Environment, clock: Clock, logger: Logger): Promise<OpaWasmPolicyEngine | null> {
  try {
    if (OFFLINE.includes(environment)) return await OpaWasmPolicyEngine.load({ bundleDir: ensurePolicyBundle().bundleDir, clock, logger });
    return await OpaWasmPolicyEngine.load({ clock, logger });
  } catch {
    return null;
  }
}

function committedCatalogDigest(): string | null {
  try {
    return loadPinnedCatalogFile(CATALOG_FILE).manifest.digest;
  } catch {
    return null;
  }
}

/** What a non-offline process would instantiate today: BLOCKED live stubs for business systems and Talkdesk. */
function plannedLiveKinds(): Record<string, "local_fixture" | "live"> {
  return createBlockedLiveRegistry().kinds();
}

/**
 * Builds the container. Throws ConfigurationRejectedError (reason codes only)
 * when the guard rejects the configuration or the environment's composition is
 * not available. Never binds a port: entry points listen after it returns.
 */
export async function buildContainer(opts: ContainerOptions): Promise<Container> {
  const clock = opts.clock ?? systemClock;
  const environment = opts.environment;
  const offline = OFFLINE.includes(environment);
  const env = opts.env ?? process.env;
  const infra = loadInfrastructureEnv(env, { defaultPort: 8080, environment });
  const bootLogger = opts.logger ?? createLogger({ service: "vsp-gateway" });

  if (!offline && opts.allowUncommittedCatalog) throw new ConfigurationRejectedError(["UNCOMMITTED_CATALOG_OUTSIDE_LOCAL_CI@toolCatalog"]);

  // ------------------------------------------------------------------ guard first (OPS-04)
  const policy = await loadPolicyForGuard(environment, clock, bootLogger);
  const pinnedDigest = committedCatalogDigest();
  const identityKinds: Record<string, "local_fixture" | "live"> = offline
    ? {
        "identity-directory": "local_fixture",
        "oidc-client-idp": "local_fixture",
        notifications: "local_fixture",
        // The LOCAL console composition (main/console.ts) runs the workforce IdP fixture and local sign-in.
        "workforce-sso": "local_fixture",
        "console-local-sign-in": "local_fixture",
      }
    : {};
  const runtimeKinds: Record<string, "local_fixture" | "live"> = offline ? Object.fromEntries(RUNTIME_COMPONENTS.map((c) => [c, "local_fixture" as const])) : {};
  // Offline: exactly the components wired below (fixture set + identity fixtures + runtime fixtures).
  const adapterKinds = offline ? { ...plannedOfflineKinds(), ...identityKinds, ...runtimeKinds } : plannedLiveKinds();
  const deployable = await loadDeployableConfig({
    environment,
    clock,
    adapterKinds,
    loadedPolicy: policy ? { version: policy.policyVersion, digest: policy.bundleDigest } : null,
    toolCatalogDigest: pinnedDigest,
    env,
    configDir: opts.configDir,
    repoRoot: opts.repoRoot,
    logger: bootLogger,
  });
  const config = deployable.config;
  const gatewayConfig = gatewayConfigOf(config);

  if (!offline || !policy) {
    const reasons = ["LIVE_COMPOSITION_NOT_IMPLEMENTED@runtime"];
    if (!policy) reasons.push("POLICY_BUNDLE_NOT_LOADED@policy.bundlePath");
    if (!gatewayConfig?.inboundAuth) reasons.push("GATEWAY_INBOUND_AUTH_NOT_CONFIGURED@gateway.inboundAuth");
    bootLogger.error("container.refused", { environment, reasonCode: "LIVE_COMPOSITION_NOT_IMPLEMENTED" });
    throw new ConfigurationRejectedError(reasons);
  }
  if (config.toolCatalog.expectedDigest && pinnedDigest !== config.toolCatalog.expectedDigest) {
    throw new ConfigurationRejectedError(["TOOL_CATALOG_DIGEST_MISMATCH@toolCatalog.expectedDigest"]);
  }

  // ------------------------------------------------------------------ offline composition
  const logger = bootLogger.child({ component: "container" });
  const tenantId = config.tenantId;
  const tenantIds = [tenantId];
  const metrics = new InMemoryMetrics({
    catalogue: createMetricCatalogue({ toolNames: [...new Set([...(opts.metricToolNames ?? []), ...pinnedNamesOrEmpty()])] }),
    unknownMetric: "drop",
  });
  const db = await PgliteDb.create();
  const sinkDir = opts.auditSinkDir ?? mkdtempSync(join(tmpdir(), "vsp-local-audit-sink-"));
  const ownsSinkDir = opts.auditSinkDir === undefined;
  let app: FastifyInstance | null = null;
  try {
    await migrate(db);
    const templates = loadDefaultTemplateRegistry();

    // Identity (LOCAL FIXTURE directory, OIDC and notifications; in-memory session store).
    const kv = new MemoryKvStoreFixture();
    const directory = new LocalIdentityDirectoryFixture({ extraPeople: [] });
    const notifications = new NotificationFixture({ clock, registeredChannelRefs: directory.allVerifiedChannelRefs() });
    const idp = await LocalOidcProviderFixture.create({ clock });
    const oidc = new LocalOidcVerifierFixture(idp, { clock });
    const identityConfig = identityConfigFromPlatform(config, { policyVersion: policy.policyVersion, otpEnabled: opts.otpEnabled ?? false });
    const sessions = new TrustedSessionService({ kv, clock, logger, metrics, config: identityConfig.session });
    const verification = new SecureVerificationService({
      sessions,
      kv,
      directory,
      oidc,
      notifications,
      clock,
      logger,
      metrics,
      otpPepper: LOCAL_FIXTURE_OTP_PEPPER,
      config: identityConfig.verification,
    });
    const assertions = new SignedAssertionService({ keyRing: new AssertionKeyRing(new LocalEs256Signer()), kv, clock, issuer: "vsp-identity/local" });

    // Audit, outbox, ledger.
    const audit = new PgAuditWriter({ db, clock, stream: "runtime" });
    const auditHealth = new PgAuditHealth({ db, clock, policy: { maxBacklog: config.audit.maxBacklog, maxBacklogAgeSeconds: config.audit.maxBacklogAgeSeconds }, probeId: "gateway" });
    const auditQuery = new PgAuditQuery(db, "app_auditor");
    const auditSink = new LocalFsAuditSinkFixture(sinkDir);
    const auditShipper = new AuditShipper({ db, sink: auditSink, clock, logger });
    const outbox = new PgOutbox({ clock });
    const publisher = new MemoryPublisherFixture();
    const dispatcher = new PgOutboxDispatcher({ db, publisher, clock, tenants: tenantIds, audit, logger });
    const actions = new LedgerActionService({ db, clock, audit, auditHealth, outbox, logger });
    const toolIdempotency = new ToolRequestIdempotency({ db, clock });

    // Adapters (LOCAL FIXTURES registered under the config keys).
    const fixtureSet = createLocalFixtureSet({
      clock,
      logger,
      destinations: config.destinations.map((d) => ({ destinationId: d.destinationId, vendorQueueRef: d.vendorQueueRef, purpose: d.purpose })),
      extra: { "identity-directory": directory, "oidc-client-idp": oidc, notifications },
    });

    // Workflows, transfers, knowledge, memory, ops, safety, voice.
    const workflows = new PgWorkflowEngine({ db, registry: createDefaultRegistry(), audit, clock, logger });
    const transferStore = new MemoryTransferStore();
    const transfers = new TransferCoordinator({
      store: transferStore,
      telephony: fixtureSet.telephony,
      destinations: config.destinations,
      clock,
      audit,
      logger,
      config: {
        environment,
        updateTemplateIds: { STANDARD: "transfer.failed_next_route", SAFETY: "transfer.safety_update" },
        // Engineering defaults pending operations approval (TB-07: vendor transfer events unverified).
        attemptTimeoutMs: { STANDARD: 60_000, SAFETY: 30_000 },
        maxStandardContinuityAttempts: 3,
      },
    });
    const knowledge = new KnowledgeServicePg({ db, environment, clock, logger, metrics, embedder: null, allowedLinkDomains: LOCAL_ALLOWED_LINK_DOMAINS, audit });
    if (opts.ingestKnowledge !== false) {
      await knowledge.ingest(
        tenantId,
        loadLocalCorpus({ set: "approved", environment }).map((f) => f.item as KnowledgeItemInput),
      );
    }
    const snapshot = await knowledge.snapshot(tenantId);
    const memory = new SupportMemoryPg({ db, tenantIds, clock, logger });
    const ops = createOpsServices(config, { db, audit, clock, metrics, logger });
    if (config.ops?.budgets.requireBudget ?? true) await defineLocalIllustrativeBudget(ops, tenantId, environment, clock);
    const safety = new SafetyPipeline();
    const turns = new InMemoryTurnTracker();
    const responseGate = new TemplateResponseGate({ registry: templates });

    const versions: VersionSet = {
      agentConfig: config.models.active.agentConfig,
      model: config.models.active.model,
      voice: config.models.active.voice,
      promptTemplates: templates.digest(),
      policyBundle: policy.policyVersion,
      toolCatalog: pinnedDigest ?? "0".repeat(64),
      knowledgeSnapshot: snapshot.version,
      schema: PROTOCOL_VERSION,
    };

    const deps: ToolDeps = {
      tenantId,
      environment,
      clock,
      logger,
      metrics,
      db,
      audit,
      auditHealth,
      auditQuery,
      policy,
      sessions,
      verification,
      assertions,
      actions,
      outbox,
      workflows,
      transfers,
      knowledge,
      memory,
      killSwitches: ops.killSwitches,
      admission: ops.admission,
      adapters: {
        identityDirectory: directory,
        relationships: fixtureSet.relationships,
        scheduling: fixtureSet.scheduling,
        billing: fixtureSet.billing,
        claims: fixtureSet.claims,
        provider: fixtureSet.provider,
        supportRecords: fixtureSet.supportRecords,
        telephony: fixtureSet.telephony,
        notifications,
      },
      destinations: config.destinations,
      safety: { detector: new RuleBasedSafetySignalDetector(), router: new DeterministicSafetyRouter() },
      templates,
      responseGate,
      versions,
      localFixture: true,
    };

    // Business module and the pinned catalogue (must match the committed, reviewed file).
    const business = opts.buildBusiness(deps);
    const catalog = buildCatalog(business.tools);
    if (!opts.allowUncommittedCatalog) {
      const drift = catalogDriftAgainst(catalog, loadPinnedCatalogFile(CATALOG_FILE));
      if (drift) throw new ConfigurationRejectedError([`${drift}@schemas/tools/catalog.json`]);
    } else {
      versions.toolCatalog = catalog.digest;
    }
    Object.freeze(versions);

    const interactionLookup = new LocalInteractionLookupFixture();
    const binding = new SessionBindingResolver({
      mode: config.sessionBinding.mode,
      exceptionApprovalId: config.sessionBinding.exceptionApprovalId,
      sessions,
      lookup: interactionLookup,
    });
    const pipeline = new ToolPipeline({
      tenantId,
      environment,
      clock,
      logger,
      metrics,
      catalog,
      binding,
      killSwitches: ops.killSwitches,
      admission: ops.admission,
      policy,
      relationships: fixtureSet.relationships,
      idempotency: toolIdempotency,
      audit,
      // Engineering defaults pending SRE review (spec section 12 resilience).
      breakers: new CircuitBreakerRegistry({ clock, metrics }, { windowMs: 60_000, minimumRequests: 10, failureRateThreshold: 0.5, cooldownMs: 30_000, halfOpenMaxProbes: 1, halfOpenSuccessesToClose: 2 }),
      speechPrecheck: responseGate,
      templates,
      versions,
      localFixture: true,
      routing: routingFromPolicyCatalogue(policy.catalogue),
      mutationsEnabled: infra.mutationsEnabled,
    });

    const authenticator = new LocalFixtureTokenAuthenticator({ environment, tenantId });
    const leases = new SessionLeaseRegistry();
    const handoffs = new HandoffIndex(clock);
    const gatewayAudit = new GatewayAudit(audit, clock, logger, versions);
    const rateLimit =
      opts.rateLimit !== undefined
        ? opts.rateLimit
        : gatewayConfig?.http?.rateLimit !== undefined
          ? gatewayConfig.http.rateLimit
          : { max: 600, timeWindowMs: 60_000 };
    app = await buildGatewayApp({
      logger,
      authenticator,
      rateLimit,
      ...(gatewayConfig?.http ? { bodyLimitBytes: gatewayConfig.http.bodyLimitBytes } : {}),
      routes: [
        ...healthRoutes(new ReadinessProbe({ db, policy, auditHealth, configGuardPassed: deployable.report.deployable })),
        ...toolRoutes({ pipeline, catalog }),
        ...mcpRoutes({ pipeline, catalog, logger }),
        ...telephonyRoutes({
          tenantId,
          environment,
          clock,
          logger,
          sessions,
          verification,
          otpEnabled: identityConfig.verification.otpEnabled,
          actions,
          pendingActions: new PgPendingActionLookup(db, clock),
          admission: ops.admission,
          turns,
          gate: new TemplateResponseGate({ registry: templates, turnTracker: turns }),
          templates,
          safety,
          handoff: business.handoff,
          outcomes: business.outcomes,
          auditHealth,
          audit: gatewayAudit,
          interactionLookup,
          leases,
          handoffs,
          versions,
          destinations: config.destinations,
        }),
        ...portalRoutes({ tenantId, verification, audit: gatewayAudit }),
        ...webhookRoutes({ environment, clock, transfers }),
      ],
    });

    const registry = new DatasetRegistry().register(SUPPORT_MEMORY_DATASET);
    const retention = new RetentionJob({ db, registry, tenantIds, clock, logger, audit, configRetention: config.retention });

    logger.info("container.ready", { environment, reasonCode: "LOCAL_FIXTURE_COMPOSITION", catalogDigest: catalog.digest, policyVersion: policy.policyVersion });
    const builtApp = app;
    return {
      label: LOCAL_CONTAINER_LABEL,
      environment,
      config,
      report: deployable.report,
      tenantIds,
      mutationsEnabled: infra.mutationsEnabled,
      clock,
      logger,
      metrics,
      db,
      policy,
      kv,
      identity: { sessions, verification, assertions, directory, notifications, idp },
      audit,
      auditHealth,
      auditQuery,
      auditSink,
      auditShipper,
      outbox,
      publisher,
      dispatcher,
      actions,
      toolIdempotency,
      fixtures: fixtureSet,
      adapters: fixtureSet.registry,
      workflows,
      transferStore,
      transfers,
      knowledge,
      memory,
      ops,
      templates,
      turns,
      safety,
      versions,
      deps,
      business,
      catalog,
      pipeline,
      interactionLookup,
      leases,
      handoffs,
      authenticator,
      retention,
      app: builtApp,
      async close() {
        await builtApp.close().catch(() => undefined);
        await db.close().catch(() => undefined);
        if (ownsSinkDir) rmSync(sinkDir, { recursive: true, force: true });
      },
    };
  } catch (err) {
    await app?.close().catch(() => undefined);
    await db.close().catch(() => undefined);
    if (ownsSinkDir) rmSync(sinkDir, { recursive: true, force: true });
    throw err;
  }
}

/** Kinds of the components `createLocalFixtureSet` registers (same keys as platform/config/*.json). */
function plannedOfflineKinds(): Record<string, "local_fixture" | "live"> {
  return Object.fromEntries(["scheduling", "billing", "claims", "provider-system", "relationship-directory", "salesforce", "talkdesk-telephony"].map((k) => [k, "local_fixture" as const]));
}

function pinnedNamesOrEmpty(): string[] {
  try {
    return loadPinnedCatalogFile(CATALOG_FILE).definitions.map((d) => d.name);
  } catch {
    return [];
  }
}

/**
 * LOCAL FIXTURE budget: ILLUSTRATIVE figures (not an approved budget; approvedBy
 * null is reported as unapproved) so admission's fail-closed budget check
 * (requireBudget) can be exercised offline. Defined by the SYNTHETIC security
 * admin through the real BudgetServicePg (audited).
 */
async function defineLocalIllustrativeBudget(ops: OpsServices, tenantId: string, environment: Environment, clock: Clock): Promise<void> {
  const now = clock.now();
  await ops.budgets.defineBudget({
    tenantId,
    environment,
    cohort: "*",
    workflow: "*",
    vendor: "*",
    periodStart: iso(new Date(now.getTime() - 86_400_000)),
    periodEnd: iso(new Date(now.getTime() + 365 * 86_400_000)),
    limitUsd: 1000,
    safetyReserveUsd: 100,
    meteringDelayMinutes: 60,
    approvedBy: null,
    version: "local-illustrative-1",
    staff: { staffId: STAFF.securityAdmin.staffId, roles: [...STAFF.securityAdmin.roles], mfa: true, authenticatedAt: iso(now), breakGlass: null },
  });
}
