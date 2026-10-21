/**
 * Live composition root (WP-07; FO-16-11, FO-19-06, FO-21-03, FO-21-10, FO-00-26, FO-00-30, FO-14-53, FO-22-20).
 *
 * sandbox / staging / production compose the gateway (and the worker and console, which reuse this container)
 * from real adapters. local / ci keep the regression composition (container.ts buildContainer, FO-00-36,
 * FO-22-21) and are refused here.
 *
 * Order (no pool, store, port or listener is constructed before the guard accepts the configuration, OPS-04):
 *   1. configuration loaded; AWS clients from `infrastructure.aws`: endpoint overrides only in sandbox and only
 *      for emulator hosts, checked by the client factory itself BEFORE any client exists (refused elsewhere,
 *      FO-14-53), so the one request that precedes the guard (step 2) can only reach AWS or a sandbox emulator;
 *   2. the guard's inputs: the policy bundle (pre-built, pinned), the committed tool catalogue digest, the
 *      template catalogue digest and the release image digest (servedArtifacts), the connector profiles with
 *      the adapter credential references of this and every committed environment (credential separation,
 *      AUTH-02), and the approval trust key resolved from KMS ONLY (KmsTrustedKeyResolver, one GetPublicKey:
 *      a repository PEM or a fixture key is never a trust anchor here, FO-14-56), and the public keys of the
 *      runtime signing keys (KmsRuntimeSigningKeyResolver, GetPublicKey by key ARN, bare key id or mrk- id; the
 *      key separation check only: one it cannot obtain refuses the process); then the deployment guard:
 *      blocking violations refuse the process, capability violations make their capability NOT_CONFIGURED;
 *   3. substrate: PostgreSQL (PgPoolDb from the Secrets Manager database secret; schema must be current),
 *      DynamoDB sessions (DynamoKvStore), the SQS outbox publisher, the KMS assertion signer, the durable
 *      deferred-audit queue with the independent DynamoDB route-audit journal, the egress guard and the
 *      egress-classified connector transport every outbound client uses (JWKS, IdPs, Salesforce, OTLP);
 *   4. capabilities: each capability is composed from its live implementation when one exists and its inputs
 *      are configured; otherwise it is NOT_CONFIGURED in the activation map, its intents are refused at
 *      admission, its background work is held, and its port is a guard port (never a stub, never canned data);
 *   5. the gateway app: readiness (with the capability states), tool and MCP routes; the Talkdesk telephony
 *      surface is not mounted while contact_center.talkdesk is NOT_CONFIGURED.
 *
 * Fixtures are unreachable from this file by construction: modules.yaml lists it as a transitive production
 * entry point (no fixtures, LOCAL FIXTURE adapters, demo, evaluation or test code, directly or through any
 * module it imports), and the live registry refuses a local_fixture adapter at registration.
 */
import { GetPublicKeyCommand } from "@aws-sdk/client-kms";
import type { FastifyInstance } from "fastify";
import { LedgerActionService } from "../actions/action-service.js";
import { ToolRequestIdempotency } from "../actions/tool-idempotency.js";
import { createAwsClients } from "../adapters/live/aws-clients.js";
import { FeedDigester } from "../adapters/live/connector-feed.js";
import type { AwsClients } from "../adapters/live/aws-clients.js";
import { notConfiguredOperation, notConfiguredPort } from "../adapters/live/not-configured.js";
import { OidcDiscovery } from "../adapters/live/oidc-discovery.js";
import { OidcHttp } from "../adapters/live/oidc-http.js";
import { JwksOidcVerifier } from "../adapters/live/oidc-verifier.js";
import { TransportOtlpPost } from "../adapters/live/otlp-transport.js";
import { PgTransferStore } from "../adapters/live/pg-transfer-store.js";
import { SALESFORCE_SCHEMA_OWNER, SalesforceRestSupportRecords } from "../adapters/live/salesforce-rest-support-records.js";
import { transportJwksResolver } from "../adapters/live/transport-jwks.js";
import type { BillingSystem, ClaimsSystem, IdentityDirectory, NotificationSender, OidcVerifier, ProviderSystem, RelationshipDirectory, SchedulingSystem, SupportRecordSystem, TelephonyControl } from "../adapters/ports.js";
import { PgAuditHealth } from "../audit/health.js";
import { DurableDeferredAuditQueue, DynamoRouteAuditJournal } from "../audit/journal.js";
import { PgAuditQuery } from "../audit/query.js";
import { PgAuditWriter } from "../audit/writer.js";
import type { BuildBusiness, BusinessModule, ToolDeps } from "../business/contract.js";
import type { AccountStateLookup, ConsentRegistry } from "../business/recheck.js";
import { BusinessPreDisclosureRecheck } from "../business/recheck.js";
import { KmsRuntimeSigningKeyResolver, KmsTrustedKeyResolver } from "../config/approvals.js";
import type { KmsPublicKeyClient } from "../config/approvals.js";
import type { GuardReport } from "../config/guard.js";
import { loadInfrastructureEnv, loadPlatformConfig } from "../config/loader.js";
import type { PlatformConfig } from "../config/ports.js";
import { ADAPTER_CAPABILITY } from "../config/rules/index.js";
import { gatewayConfigOf } from "../config/schema.js";
import { loadDeployableConfig } from "../config/startup.js";
import type { AdmittedProfile } from "../connectors/profile/validate.js";
import { ConnectorHttpTransport } from "../connectors/http/transport.js";
import type { Resolver } from "../connectors/http/transport.js";
import { SecretsManagerSecretResolver } from "../connectors/secrets/resolver.js";
import type { SecretsManagerSender } from "../connectors/secrets/resolver.js";
import { PgPoolDb } from "../db/pg.js";
import { CATALOG_FILE, buildCatalog, catalogDriftAgainst, loadPinnedCatalogFile } from "../gateway/catalog.js";
import type { PinnedCatalog } from "../gateway/catalog.js";
import { JwtAccessTokenAuthenticator } from "../gateway/auth.js";
import type { IntegrationAuthenticator } from "../gateway/auth.js";
import { InteractionIndexCallSessions } from "../gateway/call-sessions.js";
import { CallOutcomeTracker, HandoffIndex } from "../gateway/call-state.js";
import { buildGatewayApp } from "../gateway/http/app.js";
import { ReadinessProbe, healthRoutes } from "../gateway/http/health-routes.js";
import { toolRoutes } from "../gateway/http/tool-routes.js";
import { mcpRoutes } from "../gateway/mcp.js";
import { ToolPipeline, routingFromPolicyCatalogue } from "../gateway/pipeline.js";
import { SessionBindingResolver } from "../gateway/session-binding.js";
import type { InteractionLookup } from "../gateway/session-binding.js";
import type { IntegrationIdentity } from "../protocol/index.js";
import { SignedAssertionService } from "../identity/assertions/assertion-service.js";
import { AssertionKeyRing } from "../identity/assertions/key-ring.js";
import { KmsAssertionSigner } from "../identity/assertions/signers.js";
import { identityConfigFromPlatform } from "../identity/config.js";
import { DynamoKvStore } from "../identity/kv/dynamo-kv-store.js";
import type { VerificationService } from "../identity/ports.js";
import { TrustedSessionService } from "../identity/session-service.js";
import { SecureVerificationService } from "../identity/verification-service.js";
import { KnowledgeServicePg } from "../knowledge/service.js";
import { SupportMemoryPg } from "../memory/support-memory.js";
import { alarmLogTap } from "../observability/alarms.js";
import { createPlatformMetricCatalogue } from "../observability/catalog/index.js";
import type { RuntimeCapabilityId } from "../observability/composition-catalog.js";
import { createLogger } from "../observability/logger.js";
import { InMemoryMetrics, teeMetrics } from "../observability/metrics.js";
import type { Logger, Metrics } from "../observability/ports.js";
import { startTelemetry } from "../observability/telemetry.js";
import type { Telemetry } from "../observability/telemetry.js";
import { CapabilityGatedAdmission, CapabilityHoldKillSwitches, intentIntegrationsFrom } from "../ops/capability-gate.js";
import { createOpsServices } from "../ops/compose.js";
import type { OpsServices } from "../ops/compose.js";
import { KillSwitchGatedSupportRecords } from "../ops/integration-gate.js";
import { KillSwitchGatedNotificationSender } from "../ops/notification-gate.js";
import { PgOutboxDispatcher } from "../outbox/dispatcher.js";
import { PgOutbox } from "../outbox/outbox.js";
import { SqsPublisher } from "../outbox/sqs-publisher.js";
import type { SqsBatchClient } from "../outbox/sqs-publisher.js";
import type { OpaWasmPolicyEngine } from "../policy/engine.js";
import { EgressGuard } from "../privacy/egress.js";
import { RedactionService } from "../privacy/redaction-service.js";
import type { QuarantineStore } from "../privacy/redaction-service.js";
import type { Environment, VersionSet } from "../protocol/index.js";
import { PROTOCOL_VERSION } from "../protocol/index.js";
import { CircuitBreakerRegistry } from "../resilience/circuit-breaker.js";
import { createPlatformDatasetRegistry } from "../retention/datasets.js";
import { RetentionJob } from "../retention/job.js";
import { RuleBasedSafetySignalDetector } from "../safety/detector.js";
import { SafetyPipeline } from "../safety/pipeline.js";
import { DeterministicSafetyRouter } from "../safety/router.js";
import { SafetyEventRecorder } from "../safety/safety-events.js";
import type { Clock } from "../shared/clock.js";
import { systemClock } from "../shared/clock.js";
import { ConfigurationRejectedError, PlatformError } from "../shared/errors.js";
import { TemplateResponseGate } from "../voice/gate.js";
import type { TemplateRegistry } from "../voice/ports.js";
import { PgWorkflowEngine } from "../workflows/engine.js";
import { PgDurableGrantStore } from "../workflows/grants.js";
import { createDefaultRegistry } from "../workflows/registry.js";
import { TransferCoordinator } from "../workflows/transfer.js";
import { ActivationMap, auditIndependentFact, buildActivationMap } from "./capabilities.js";
import type { CompositionFact } from "./capabilities.js";
import { RefusingIntegrationAuthenticator, addressClassFor, assertSchemaCurrent, committedSigningKeySets, connectorCredentialSets, pgConnectionString, secretBytes, secretString, servedArtifacts } from "./live-modules.js";

export const LIVE_CONTAINER_LABEL = "LIVE COMPOSITION";
export const LIVE_ENVIRONMENTS: readonly Environment[] = ["sandbox", "staging", "production"];

export interface LiveContainerOptions {
  environment: Environment;
  /** Business module factory (platform/src/business buildBusiness), injected by the entry point. */
  buildBusiness: BuildBusiness;
  clock?: Clock;
  env?: Readonly<Record<string, string | undefined>>;
  configDir?: string;
  repoRoot?: string;
  logger?: Logger;
  /** Process instance id (ECS task id); names this instance's outbox audit stream. Defaults to VSP_INSTANCE_ID. */
  instanceId?: string;
  /** Deployable unit this process runs (service name of its telemetry resource). */
  unit?: "gateway" | "worker" | "console";
  /**
   * SANDBOX ONLY: name resolution and additional trusted CAs of the outbound transport, for emulated vendor
   * endpoints on a private network. The address-class, allowlist, egress and TLS checks still apply. Refused in
   * staging and production (NETWORK_OVERRIDE_OUTSIDE_SANDBOX): there the transport uses the system resolver and
   * the system trust store only.
   */
  network?: { resolve?: Resolver; tlsCa?: readonly string[] };
  /** Pool size of the runtime database connection (default 10). */
  databasePoolSize?: number;
}

export interface LiveContainer {
  label: string;
  environment: Environment;
  config: PlatformConfig;
  report: GuardReport;
  activation: ActivationMap;
  tenantIds: readonly string[];
  mutationsEnabled: boolean;
  clock: Clock;
  logger: Logger;
  /** Content-free metrics (in-process aggregate + OpenTelemetry export). */
  metrics: Metrics;
  /** The in-process aggregate (alarm evaluation, readiness). */
  localMetrics: InMemoryMetrics;
  telemetry: Telemetry;
  aws: AwsClients;
  db: PgPoolDb;
  policy: OpaWasmPolicyEngine;
  kv: DynamoKvStore;
  identity: { sessions: TrustedSessionService; verification: VerificationService; assertions: SignedAssertionService };
  audit: PgAuditWriter;
  auditHealth: PgAuditHealth;
  auditQuery: PgAuditQuery;
  deferredAudit: DurableDeferredAuditQueue;
  privacy: { egress: EgressGuard; redaction: RedactionService };
  transport: ConnectorHttpTransport;
  secrets: SecretsManagerSecretResolver;
  outbox: PgOutbox;
  publisher: SqsPublisher;
  dispatcher: PgOutboxDispatcher;
  actions: LedgerActionService;
  toolIdempotency: ToolRequestIdempotency;
  workflows: PgWorkflowEngine;
  grants: PgDurableGrantStore;
  transferStore: PgTransferStore;
  /**
   * Transfer journeys as the unit's own views read them: the console unit reads under app_console (read only:
   * the coordinator's writes of the console's staff safety escalation go through `transferStore`); the gateway
   * and the worker read through `transferStore` itself.
   */
  transferReader: PgTransferStore;
  transfers: TransferCoordinator;
  knowledge: KnowledgeServicePg;
  memory: SupportMemoryPg;
  ops: OpsServices;
  /** Kill switches with NOT_CONFIGURED integrations held, and admission with the capability gate. */
  gates: { killSwitches: CapabilityHoldKillSwitches; admission: CapabilityGatedAdmission };
  templates: TemplateRegistry;
  safety: SafetyPipeline;
  versions: VersionSet;
  deps: ToolDeps;
  business: BusinessModule;
  catalog: PinnedCatalog;
  /** Connector profiles of this environment (loaded once, before the guard; the worker's feeds run them). */
  connectorProfiles: readonly AdmittedProfile[];
  /** Keyed digests of the connector feeds (per-environment key; the key itself is not exposed). */
  feedDigester: FeedDigester;
  /**
   * Every port the composition injects, by name (the business ports, the identity, privacy and recheck
   * ports, the call-session resolver): each is a live implementation or a guard port (FO-21-10 registry scan).
   */
  ports: Readonly<Record<string, unknown>>;
  pipeline: ToolPipeline;
  handoffs: HandoffIndex;
  callOutcomes: CallOutcomeTracker;
  authenticator: IntegrationAuthenticator;
  retention: RetentionJob;
  app: FastifyInstance;
  close(): Promise<void>;
}

function pinnedNamesOrEmpty(): string[] {
  try {
    return loadPinnedCatalogFile(CATALOG_FILE).definitions.map((d) => d.name);
  } catch {
    return [];
  }
}

/** Adapter keys whose live implementation exists in this build and is composed when its inputs are configured. */
const LIVE_IMPLEMENTED_ADAPTERS = ["oidc-client-idp", "oidc-provider-idp", "workforce-sso", "salesforce"] as const;

/**
 * The live Salesforce support-record adapter (crm.salesforce), or the reason it is not composed. Composed only
 * when the guard reports the salesforce component CONFIGURED, the tenant's Case schema is configured
 * (`crm.salesforce`) and its approval record is VALID; the adapter then refuses placeholder or invalid mappings
 * itself. Credentials are the connected app's client id and secret in the Secrets Manager secret of
 * `adapters.salesforce.credentialRef` ({"clientId": ..., "clientSecret": ...}), read on each token request.
 */
function composeSalesforce(
  config: PlatformConfig,
  report: GuardReport,
  deps: { secrets: SecretsManagerSecretResolver; transport: ConnectorHttpTransport; clock: Clock; logger: Logger },
): { adapter: SalesforceRestSupportRecords | null; fact: CompositionFact } {
  const a = config.adapters.salesforce;
  const component = report.components.find((c) => c.component === "salesforce");
  if (!a || a.kind !== "live" || !a.endpoint || !a.credentialRef || component?.state !== "CONFIGURED") return { adapter: null, fact: { composed: false, reasons: ["SALESFORCE_ADAPTER_NOT_CONFIGURED@adapters.salesforce"] } };
  const crm = config.crm?.salesforce ?? null;
  if (!crm) return { adapter: null, fact: { composed: false, reasons: ["SALESFORCE_CASE_SCHEMA_NOT_PROVIDED@crm.salesforce"] } };
  if (!report.approvals.some((e) => e.approvalId === crm.schemaApprovalId && e.status === "VALID")) return { adapter: null, fact: { composed: false, reasons: ["SALESFORCE_SCHEMA_APPROVAL_INVALID@crm.salesforce.schemaApprovalId"] } };
  const ref = a.credentialRef;
  try {
    const adapter = new SalesforceRestSupportRecords(
      {
        integrationId: "salesforce",
        myDomainUrl: new URL(a.endpoint).origin,
        apiVersion: crm.apiVersion,
        timeoutMs: a.timeoutMs,
        schema: { status: "PROVIDED", providedBy: SALESFORCE_SCHEMA_OWNER, evidenceRef: crm.schemaEvidenceRef, approvalId: crm.schemaApprovalId },
        mapping: crm.mapping as never,
      },
      {
        credentials: async () => {
          const v = (await deps.secrets.resolve(ref)).value.json();
          return { clientId: String(v.clientId ?? ""), clientSecret: String(v.clientSecret ?? "") };
        },
        transport: deps.transport,
        addressClass: addressClassFor(config, new URL(a.endpoint).hostname),
        clock: deps.clock,
        logger: deps.logger,
      },
    );
    return { adapter, fact: { composed: true } };
  } catch (err) {
    const code = err instanceof PlatformError && /^[A-Z][A-Z0-9_]{2,63}$/.test(err.reasonCode) ? err.reasonCode : "SALESFORCE_CONFIG_INVALID";
    return { adapter: null, fact: { composed: false, reasons: [`${code}@crm.salesforce`] } };
  }
}

/**
 * Builds the live container. Throws ConfigurationRejectedError (reason codes only) when the guard refuses the
 * configuration or mandatory substrate cannot be composed. Never binds a port.
 */
export async function buildLiveContainer(opts: LiveContainerOptions): Promise<LiveContainer> {
  const environment = opts.environment;
  if (!LIVE_ENVIRONMENTS.includes(environment)) throw new ConfigurationRejectedError(["LIVE_COMPOSITION_OFFLINE_ENVIRONMENT@environment"]);
  if (opts.network && environment !== "sandbox") throw new ConfigurationRejectedError(["NETWORK_OVERRIDE_OUTSIDE_SANDBOX@network"]);
  const clock = opts.clock ?? systemClock;
  const env = opts.env ?? process.env;
  const unit = opts.unit ?? "gateway";
  const infraEnv = loadInfrastructureEnv(env, { defaultPort: 8080, environment });
  const repoRoot = opts.repoRoot;
  const bootLogger = opts.logger ?? createLogger({ service: `vsp-${unit}` });

  // ------------------------------------------------------------------ 1. configuration and AWS clients
  const preliminary = loadPlatformConfig({ environment, configDir: opts.configDir, env }).config;
  const infra = preliminary.infrastructure;
  if (!infra) throw new ConfigurationRejectedError(["INFRASTRUCTURE_NOT_CONFIGURED@infrastructure"]);
  const aws = createAwsClients(infra.aws, { environment, env });
  const cleanup: (() => Promise<void> | void)[] = [() => aws.destroy()];
  const unwind = async () => {
    for (const f of cleanup.reverse()) await Promise.resolve(f()).catch(() => undefined);
  };

  try {
    // ---------------------------------------------------------------- 2. guard first (OPS-04)
    const served = await servedArtifacts(preliminary, { environment, clock, logger: bootLogger, releaseImageDigest: infraEnv.releaseImageDigest });
    const pinnedDigest = served.toolCatalogDigest;
    const credentials = connectorCredentialSets(preliminary, { environment, ...(opts.configDir ? { configDir: opts.configDir } : {}), ...(repoRoot ? { repoRoot } : {}) });
    const adapterKinds: Record<string, "live"> = {};
    for (const k of LIVE_IMPLEMENTED_ADAPTERS) if (preliminary.adapters[k]?.kind === "live") adapterKinds[k] = "live";
    const kmsResolver = new KmsTrustedKeyResolver(aws.kms as unknown as KmsPublicKeyClient, (input) => new GetPublicKeyCommand(input));
    const deployable = await loadDeployableConfig({
      environment,
      clock,
      adapterKinds,
      loadedPolicy: served.loadedPolicy,
      toolCatalogDigest: pinnedDigest,
      templateCatalogDigest: served.templateCatalogDigest,
      releaseImageDigest: served.releaseImageDigest,
      connectorCredentialSets: credentials.sets,
      // Key separation (FO-14-56): the runtime signing keys of every other committed environment configuration.
      committedSigningKeys: committedSigningKeySets({ environment, ...(opts.configDir ? { configDir: opts.configDir } : {}) }),
      env,
      configDir: opts.configDir,
      repoRoot,
      logger: bootLogger,
      // FO-14-56: the approval trust anchor is a KMS public key, never a file or a fixture key.
      keyResolvers: [kmsResolver],
      // Key separation by material: the runtime signing keys in every form the runtime signs with (bare ids too).
      signingKeyResolvers: [new KmsRuntimeSigningKeyResolver(aws.kms as unknown as KmsPublicKeyClient, (input) => new GetPublicKeyCommand(input))],
    });
    const config = deployable.config;
    const report = deployable.report;
    const policy = served.policy;
    if (!policy) throw new ConfigurationRejectedError(["POLICY_BUNDLE_NOT_LOADED@policy.bundlePath"]);
    if (config.toolCatalog.expectedDigest && pinnedDigest !== config.toolCatalog.expectedDigest) throw new ConfigurationRejectedError(["TOOL_CATALOG_DIGEST_MISMATCH@toolCatalog.expectedDigest"]);
    const ci = config.infrastructure;
    const egressPolicy = config.egress;
    // The guard refused both already; repeated so the types are narrowed without a cast.
    if (!ci || !ci.outbox || !ci.routeAuditJournalTable || !egressPolicy) throw new ConfigurationRejectedError(["INFRASTRUCTURE_NOT_CONFIGURED@infrastructure"]);
    if (!config.database.connectionRef || !config.sessionStore.tableName || !config.signing.assertionKeyRef || !ci.secrets.requestHashPepperRef) {
      throw new ConfigurationRejectedError(["MANDATORY_DATA_MISSING@infrastructure"]);
    }
    const tenantId = config.tenantId;
    const tenantIds = [tenantId];
    const gatewayConfig = gatewayConfigOf(config);

    // ---------------------------------------------------------------- 3. substrate
    const catalogue = createPlatformMetricCatalogue({ toolNames: pinnedNamesOrEmpty() });
    const localMetrics = new InMemoryMetrics({ catalogue, unknownMetric: "drop" });
    const egress = new EgressGuard(egressPolicy, { environment, logger: bootLogger, metrics: localMetrics });
    const transport = new ConnectorHttpTransport({
      environment,
      egress,
      ...(opts.network?.resolve ? { resolve: opts.network.resolve } : {}),
      ...(opts.network?.tlsCa ? { tlsCa: opts.network.tlsCa } : {}),
      metrics: localMetrics,
      logger: bootLogger,
    });
    const otlp = config.observability?.otlp ?? null;
    const otlpHosts = [otlp?.metricsUrl, otlp?.tracesUrl].filter((u): u is string => typeof u === "string").map((u) => new URL(u).hostname);
    const instanceId = opts.instanceId ?? env.VSP_INSTANCE_ID ?? `${unit}-1`;
    if (!/^[A-Za-z0-9_.-]{1,48}$/.test(instanceId)) throw new ConfigurationRejectedError(["INSTANCE_ID_INVALID@VSP_INSTANCE_ID"]);
    const telemetry = startTelemetry({
      serviceName: `vsp-${unit}`,
      serviceVersion: PROTOCOL_VERSION,
      environment,
      instanceId,
      catalogue,
      otlp,
      post: otlpHosts.length > 0 ? new TransportOtlpPost(transport, { allowedHosts: [...new Set(otlpHosts)], addressClass: addressClassFor(config, otlpHosts[0] ?? "") }) : null,
      logger: bootLogger,
      localMetrics,
    });
    cleanup.push(() => telemetry.shutdown());
    const metrics = teeMetrics(localMetrics, telemetry.metrics);
    const logger = alarmLogTap(bootLogger, metrics).child({ component: "live_container" });

    const secrets = new SecretsManagerSecretResolver(aws.secretsManager as unknown as SecretsManagerSender, { clock, metrics });
    const db = PgPoolDb.fromConnectionString(pgConnectionString(await secretString(secrets, config.database.connectionRef, "database.connectionRef"), { environment }), opts.databasePoolSize ?? 10, {
      applicationName: `vsp-${unit}`,
    });
    cleanup.push(() => db.close());
    await assertSchemaCurrent(db, unit === "worker" ? "app_worker" : unit === "console" ? "app_console" : "app_runtime");

    const kv = DynamoKvStore.fromClient(aws.dynamodb, config.sessionStore.tableName);
    const identityConfig = identityConfigFromPlatform(config, { policyVersion: policy.policyVersion, otpEnabled: false });
    const sessions = new TrustedSessionService({ kv, clock, logger, metrics, config: identityConfig.session });
    const assertions = new SignedAssertionService({ keyRing: new AssertionKeyRing(new KmsAssertionSigner(aws.kms, config.signing.assertionKeyRef)), kv, clock, issuer: `vsp-identity/${environment}` });

    const audit = new PgAuditWriter({ db, clock, stream: "runtime" });
    const auditHealth = new PgAuditHealth({ db, clock, policy: { maxBacklog: config.audit.maxBacklog, maxBacklogAgeSeconds: config.audit.maxBacklogAgeSeconds }, probeId: unit });
    const auditQuery = new PgAuditQuery(db, "app_auditor");
    // WP-04 hand-off: the durable deferral (PostgreSQL, then the independent DynamoDB journal) replaces the
    // process-local queue of the regression composition.
    const deferredAudit = new DurableDeferredAuditQueue({
      db,
      writer: audit,
      clock,
      tenants: tenantIds,
      independent: DynamoRouteAuditJournal.fromClient(aws.dynamodb, ci.routeAuditJournalTable),
      role: "app_runtime",
      logger,
      metrics,
      health: auditHealth,
    });

    const outbox = new PgOutbox({ clock });
    const publisher = new SqsPublisher({ client: aws.sqs as unknown as SqsBatchClient, queueUrl: ci.outbox.queueUrl, fifo: ci.outbox.fifo, logger });
    const dispatcher = new PgOutboxDispatcher({ db, publisher, clock, tenants: tenantIds, audit, logger, instanceId });
    const actions = new LedgerActionService({ db, clock, audit, auditHealth, outbox, logger });
    // DP-02: persisted request hashes keyed with the Secrets Manager pepper; the connector feed's digests are
    // keyed with an HKDF subkey of it under their own label (adapters/live/connector-feed.ts FeedDigester).
    const requestHashPepper = await secretBytes(secrets, ci.secrets.requestHashPepperRef, "infrastructure.secrets.requestHashPepperRef");
    const toolIdempotency = new ToolRequestIdempotency({
      db,
      clock,
      requestHashPepper: { ref: ci.secrets.requestHashPepperRef, key: requestHashPepper },
    });
    const feedDigester = FeedDigester.fromPepper(requestHashPepper);

    // ---------------------------------------------------------------- 4. capabilities
    const facts: Partial<Record<RuntimeCapabilityId, CompositionFact>> = {};
    const guard = <T extends object>(capabilityId: RuntimeCapabilityId, component: string, integrationId = component, props?: Readonly<Record<string, string | number | boolean | null>>) =>
      notConfiguredPort<T>({ capabilityId, component, integrationId, metrics, logger, ...(props ? { props } : {}) });

    // Ops first: the gates read the activation map, built once every fact is known (below).
    const ops = createOpsServices(config, { db, audit, clock, metrics, logger });
    let activation: ActivationMap | null = null;
    const states = {
      isConfigured: (id: RuntimeCapabilityId) => activation?.isConfigured(id) ?? false,
      capabilityOfIntegration: (i: string) => (Object.hasOwn(ADAPTER_CAPABILITY, i) ? (ADAPTER_CAPABILITY[i] ?? null) : null),
    };

    // Business systems, relationships, notifications, telephony: no live adapter in this build (software gaps).
    const scheduling = guard<SchedulingSystem>("domain.business_systems", "scheduling");
    const billing = guard<BillingSystem>("domain.business_systems", "billing");
    const claims = guard<ClaimsSystem>("domain.business_systems", "claims");
    const provider = guard<ProviderSystem>("domain.business_systems", "provider-system");
    facts["domain.business_systems"] = { composed: false, softwareGaps: [{ owner: "WP-23", reasonCode: "DOMAIN_LIVE_ADAPTERS_MISSING" }] };
    const relationships = guard<RelationshipDirectory>("authority.registries", "relationship-directory");
    facts["authority.registries"] = { composed: false, softwareGaps: [{ owner: "WP-19", reasonCode: "RELATIONSHIP_DIRECTORY_LIVE_ADAPTER_MISSING" }] };
    const notificationsPort = guard<NotificationSender>("notifications.messaging", "notifications");
    facts["notifications.messaging"] = { composed: false, softwareGaps: [{ owner: "WP-27", reasonCode: "NOTIFICATION_LIVE_SENDER_MISSING" }] };
    const telephony = guard<TelephonyControl>("contact_center.talkdesk", "talkdesk-telephony");
    const interactionLookup = guard<InteractionLookup>("contact_center.talkdesk", "talkdesk-interactions", "talkdesk-telephony");
    facts["contact_center.talkdesk"] = {
      composed: false,
      softwareGaps: [
        { owner: "WP-28", reasonCode: "TALKDESK_TELEPHONY_LIVE_ADAPTER_MISSING" },
        { owner: "WP-29", reasonCode: "TALKDESK_INTERACTION_LOOKUP_MISSING" },
        { owner: "WP-14", reasonCode: "TURN_TRACKER_LIVE_MISSING" },
      ],
    };
    facts["handoff.transfer"] = { composed: false, softwareGaps: [{ owner: "WP-28", reasonCode: "TRANSFER_TELEPHONY_LIVE_MISSING" }] };

    // Kill switches: NOT_CONFIGURED integrations are held (background work stays pending).
    const killSwitches = new CapabilityHoldKillSwitches(ops.killSwitches, { states, integrations: Object.keys(ADAPTER_CAPABILITY), metrics });
    const gatedNotifications = new KillSwitchGatedNotificationSender({ inner: notificationsPort, snapshot: () => killSwitches.snapshot(tenantId), logger });

    // Salesforce: the live REST adapter over the egress transport, composed only with the tenant's approved Case
    // schema (PRQ-006) and valid adapter inputs; otherwise crm.salesforce is NOT_CONFIGURED (guard port).
    const sf = composeSalesforce(config, report, { secrets, transport, clock, logger });
    facts["crm.salesforce"] = sf.fact;
    const supportRecordsInner: SupportRecordSystem = sf.adapter ?? guard<SupportRecordSystem>("crm.salesforce", "salesforce");
    const supportRecords = new KillSwitchGatedSupportRecords({ inner: supportRecordsInner, snapshot: () => killSwitches.snapshot(tenantId), logger });

    // Caller identity: the live identity directory does not exist in this build (WP-19). The caller IdPs'
    // id-token verifier is composed over the egress transport when configured (JwksOidcVerifier).
    const directory = guard<IdentityDirectory>("identity.caller", "identity-directory");
    let oidc: OidcVerifier = guard<OidcVerifier>("identity.caller", "oidc-client-idp");
    const idps = config.callerIdentity?.idps ?? [];
    if (idps.length > 0 && !report.notConfiguredCapabilities.includes("identity.caller")) {
      oidc = JwksOidcVerifier.fromDiscovery({
        integrationId: "oidc-client-idp",
        clock,
        providers: idps.map((p) => {
          const host = new URL(p.issuer).hostname;
          const http = new OidcHttp({ transport, egress, destination: { allowedHosts: [host], addressClass: addressClassFor(config, host) }, dependency: "identity_provider" });
          return { discovery: new OidcDiscovery({ issuer: p.issuer, http, clock, requirePkceS256: false, logger }), audience: p.audience };
        }),
      });
    }
    let verification: VerificationService = guard<VerificationService>("identity.caller", "verification-service", "identity-directory");
    if (ci.secrets.otpPepperRef && !report.notConfiguredCapabilities.includes("identity.caller")) {
      verification = new SecureVerificationService({
        sessions,
        kv,
        directory,
        oidc,
        notifications: gatedNotifications,
        notificationSwitches: () => killSwitches.snapshot(tenantId),
        clock,
        logger,
        metrics,
        otpPepper: await secretBytes(secrets, ci.secrets.otpPepperRef, "infrastructure.secrets.otpPepperRef"),
        config: identityConfig.verification,
      });
    }
    facts["identity.caller"] = { composed: false, softwareGaps: [{ owner: "WP-19", reasonCode: "IDENTITY_DIRECTORY_LIVE_ADAPTER_MISSING" }] };

    // Privacy: the restricted quarantine store has no live implementation yet (WP-22): artifacts that need
    // quarantine are refused (never stored elsewhere).
    const quarantine = guard<QuarantineStore>("privacy.operations", "quarantine-store", "quarantine-store", { destinationId: "egr_quarantine_not_configured" });
    const redaction = new RedactionService({
      quarantine,
      egress,
      logger,
      clock,
      metrics,
    });
    facts["privacy.operations"] = { composed: false, softwareGaps: [{ owner: "WP-22", reasonCode: "QUARANTINE_STORE_LIVE_MISSING" }] };

    // Durable work, transfers, knowledge, memory.
    const grants = new PgDurableGrantStore({ db, clock, audit, logger });
    const accountState = guard<AccountStateLookup>("identity.caller", "account-state", "identity-directory");
    const consentRegistry = guard<ConsentRegistry>("privacy.operations", "consent-registry", "consent-registry");
    const recheck = new BusinessPreDisclosureRecheck({
      policy,
      directory,
      relationships,
      billing,
      accounts: accountState,
      consent: consentRegistry,
      environment,
      logger,
    });
    const workflows = new PgWorkflowEngine({ db, registry: createDefaultRegistry(), audit, clock, logger, metrics, grantStore: grants, recheck });
    facts["workflows.durable"] = { composed: true };
    const transferStore = new PgTransferStore({ db, tenantId, role: unit === "worker" ? "app_worker" : "app_runtime" });
    const transferReader = unit === "console" ? new PgTransferStore({ db, tenantId, role: "app_console" }) : transferStore;
    const transfers = new TransferCoordinator({
      store: transferStore,
      telephony,
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
    const knowledge = new KnowledgeServicePg({ db, environment, clock, logger, metrics, embedder: null, allowedLinkDomains: config.knowledge?.allowedLinkDomains ?? [], audit });
    const snapshot = await knowledge.snapshot(tenantId);
    // Retrievable items only: approved, not quarantined, not held for review, not superseded (0500_knowledge.sql).
    const approvedItems = await db.tx(
      async (tx) =>
        Number(
          (
            await tx.query<{ n: unknown }>(
              "select count(*)::int as n from knowledge_items where tenant_id = $1 and approval_status = 'APPROVED' and not quarantined and not held_for_review and superseded_by_version is null",
              [tenantId],
            )
          ).rows[0]?.n ?? 0,
        ),
      { role: "app_runtime", rls: { tenantId } },
    );
    facts["knowledge.retrieval"] = approvedItems > 0 ? { composed: true } : { composed: false, reasons: ["KNOWLEDGE_NO_APPROVED_ITEMS@knowledge"] };
    const memory = new SupportMemoryPg({ db, tenantIds, clock, logger, metrics });
    facts["context.store"] = { composed: false, softwareGaps: [{ owner: "WP-18", reasonCode: "CONTEXT_STORE_MISSING" }] };

    // Platform and operations.
    facts["platform.substrate"] = { composed: true };
    facts["platform.composition"] = { composed: true };
    facts["operations.resilience_cost"] = { composed: true };
    facts["audit.independent"] = auditIndependentFact(config);
    facts["connectors.runtime"] = config.connectors?.profileDirectory ? { composed: true } : { composed: false, reasons: ["CONNECTOR_PROFILES_NOT_CONFIGURED@connectors.profileDirectory"] };
    // FO-00-30: the ingress inbox (platform/src/ingress) is not composed in this build: no source-profile loading,
    // no production event-contract registry or handlers, no webhook plugin, no processor loop (B2 hand-off to
    // WP-07). That is missing code, never a missing tenant input, so it is a software gap; the payload key
    // (infrastructure.ingressPayloadKeyId) is the one tenant input the guard checks for this capability.
    facts["ingress.events"] = { composed: false, softwareGaps: [{ owner: "WP-07", reasonCode: "INGRESS_PLUGIN_NOT_COMPOSED" }] };
    // Workforce SSO is composed by the console unit (live-console.ts) from consoleAuth and the confidential
    // client's credential (adapters.workforce-sso); the console additionally needs its session sealer key.
    const workforceAdapter = config.adapters["workforce-sso"];
    const workforceClient = workforceAdapter?.kind === "live" && Boolean(workforceAdapter.credentialRef);
    facts["identity.workforce"] = !config.consoleAuth
      ? { composed: false, reasons: ["WORKFORCE_SSO_NOT_CONFIGURED@consoleAuth"] }
      : workforceClient
        ? { composed: true }
        : { composed: false, reasons: ["WORKFORCE_CLIENT_CREDENTIAL_NOT_CONFIGURED@adapters.workforce-sso"] };
    facts["operator.console"] =
      config.consoleAuth && workforceClient && ci.secrets.consoleSessionSealerRef ? { composed: true } : { composed: false, reasons: ["CONSOLE_NOT_COMPOSABLE@consoleAuth"] };
    facts["models.providers"] = { composed: false, softwareGaps: [{ owner: "WP-08", reasonCode: "MODEL_PROVIDERS_MISSING" }] };
    facts["voice.media_runtime"] = { composed: false, softwareGaps: [{ owner: "WP-11", reasonCode: "MEDIA_RUNTIME_MISSING" }] };
    facts["conversation.harness"] = { composed: false, softwareGaps: [{ owner: "WP-10", reasonCode: "CONVERSATION_HARNESS_MISSING" }] };

    activation = buildActivationMap(report, facts);
    activation.export(metrics);
    const admission = new CapabilityGatedAdmission(ops.admission, { states: activation, intentIntegrations: intentIntegrationsFrom(policy.catalogue), metrics, logger });

    const safety = new SafetyPipeline();
    const templates = served.templates;
    const responseGate = new TemplateResponseGate({ registry: templates, metrics });
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

    const handoffs = new HandoffIndex(clock);
    const callOutcomes = new CallOutcomeTracker();
    const safetyEvents = new SafetyEventRecorder({ db, audit, clock, logger, metrics });
    // Inbound authentication: the integration owner's JWKS fetched over the egress transport (no global fetch).
    let authenticator: IntegrationAuthenticator = new RefusingIntegrationAuthenticator();
    const inbound = gatewayConfig?.inboundAuth ?? null;
    if (inbound) {
      const jwksHost = new URL(inbound.jwksUri).hostname;
      const http = new OidcHttp({ transport, egress, destination: { allowedHosts: [jwksHost], addressClass: addressClassFor(config, jwksHost) }, dependency: "identity_provider" });
      // The configuration's discriminator (`kind: "oauth2_jwt"`) is not an authenticator setting (its strict
      // schema refuses unknown keys): pass the verification settings only.
      const { kind: _kind, ...jwt } = inbound;
      authenticator = new JwtAccessTokenAuthenticator({ ...jwt, environment, tenantId }, { clock, getKey: transportJwksResolver({ http, jwksUri: inbound.jwksUri, clock }) });
    }
    // The call's trusted telephony integration identity comes from the Talkdesk telephony composition, which does
    // not exist in this build: the resolver is a guard operation (refusal, metric, alarm), never a canned null.
    const callSessionIntegration = notConfiguredOperation<[], IntegrationIdentity | null>(
      { capabilityId: "contact_center.talkdesk", component: "talkdesk-telephony", integrationId: "talkdesk-telephony", metrics, logger },
      "callSessionIntegration",
    );
    const callSessions = new InteractionIndexCallSessions({ lookup: interactionLookup, sessions, integration: callSessionIntegration });
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
      killSwitches,
      admission,
      adapters: { identityDirectory: directory, relationships, scheduling, billing, claims, provider, supportRecords, telephony, notifications: gatedNotifications },
      destinations: config.destinations,
      safety: { detector: new RuleBasedSafetySignalDetector(), router: new DeterministicSafetyRouter() },
      templates,
      responseGate,
      versions,
      localFixture: false,
      grants,
      handoffObserver: (callId, result, priority) => handoffs.record(callId, result, priority),
      deferredAudit,
      safetyEvents,
      callSessions,
    };
    const business = opts.buildBusiness(deps);
    const catalog = buildCatalog(business.tools);
    const drift = catalogDriftAgainst(catalog, loadPinnedCatalogFile(CATALOG_FILE));
    if (drift) throw new ConfigurationRejectedError([`${drift}@schemas/tools/catalog.json`]);
    Object.freeze(versions);

    const binding = new SessionBindingResolver({ mode: config.sessionBinding.mode, exceptionApprovalId: config.sessionBinding.exceptionApprovalId, sessions, lookup: interactionLookup });
    const pipeline = new ToolPipeline({
      tenantId,
      environment,
      clock,
      logger,
      metrics,
      catalog,
      binding,
      killSwitches,
      admission,
      policy,
      relationships,
      idempotency: toolIdempotency,
      audit,
      // Engineering defaults pending SRE review (spec section 12 resilience).
      breakers: new CircuitBreakerRegistry({ clock, metrics }, { windowMs: 60_000, minimumRequests: 10, failureRateThreshold: 0.5, cooldownMs: 30_000, halfOpenMaxProbes: 1, halfOpenSuccessesToClose: 2 }),
      speechPrecheck: responseGate,
      templates,
      versions,
      localFixture: false,
      routing: routingFromPolicyCatalogue(policy.catalogue),
      mutationsEnabled: infraEnv.mutationsEnabled,
      callOutcomes,
    });

    // The guard refuses a disabled limit in every live rule set (rules/gateway.ts); repeated here so a null never
    // reaches buildGatewayApp, where it would switch off both limiters.
    const configuredLimit = gatewayConfig?.http?.rateLimit;
    if (configuredLimit === null) throw new ConfigurationRejectedError(["GATEWAY_RATE_LIMIT_DISABLED@gateway.http.rateLimit"]);
    const rateLimit = configuredLimit ?? { max: 600, timeWindowMs: 60_000 };
    const map = activation;
    const app = await buildGatewayApp({
      logger,
      authenticator,
      rateLimit,
      clock,
      ...(gatewayConfig?.http ? { bodyLimitBytes: gatewayConfig.http.bodyLimitBytes } : {}),
      routes: [
        ...healthRoutes(new ReadinessProbe({ db, policy, auditHealth, configGuardPassed: report.deployable, capabilities: () => map.health() })),
        ...toolRoutes({ pipeline, catalog }),
        ...mcpRoutes({ pipeline, catalog, logger }),
      ],
    });
    cleanup.push(() => app.close());

    const retention = new RetentionJob({ db, registry: createPlatformDatasetRegistry(), tenantIds, clock, logger, audit, configRetention: config.retention });
    metrics.increment("vsp_live_composition_starts_total", { unit, result: "started" });
    logger.info("container.ready", { environment, reasonCode: "LIVE_COMPOSITION", catalogDigest: catalog.digest, policyVersion: policy.policyVersion, count: activation.notConfigured().length });

    let closed: Promise<void> | null = null;
    return {
      label: LIVE_CONTAINER_LABEL,
      environment,
      config,
      report,
      activation,
      tenantIds,
      mutationsEnabled: infraEnv.mutationsEnabled,
      clock,
      logger,
      metrics,
      localMetrics,
      telemetry,
      aws,
      db,
      policy,
      kv,
      identity: { sessions, verification, assertions },
      audit,
      auditHealth,
      auditQuery,
      deferredAudit,
      privacy: { egress, redaction },
      transport,
      secrets,
      outbox,
      publisher,
      dispatcher,
      actions,
      toolIdempotency,
      workflows,
      grants,
      transferStore,
      transferReader,
      transfers,
      knowledge,
      memory,
      ops,
      gates: { killSwitches, admission },
      templates,
      safety,
      versions,
      deps,
      business,
      catalog,
      connectorProfiles: credentials.profiles,
      feedDigester,
      ports: Object.freeze({
        ...deps.adapters,
        verification,
        oidcVerifier: oidc,
        interactionLookup,
        callSessionIntegration,
        callSessions,
        quarantine,
        consentRegistry,
        accountState,
        supportRecordsInner,
      }),
      pipeline,
      handoffs,
      callOutcomes,
      authenticator,
      retention,
      app,
      close() {
        closed ??= unwind();
        return closed;
      },
    };
  } catch (err) {
    await unwind();
    if (err instanceof ConfigurationRejectedError) bootLogger.error("container.refused", { environment, reasonCode: "CONFIGURATION_REJECTED", count: err.violations.length });
    throw err;
  }
}
