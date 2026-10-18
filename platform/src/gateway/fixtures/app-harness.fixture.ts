/**
 * LOCAL TEST FIXTURE: the gateway Fastify app over the gateway pipeline harness,
 * the real action ledger, real audit writer/health, the identity session and
 * verification services, the real response gate and turn tracker, the real
 * safety pipeline and transfer coordinator over the telephony fixture, plus
 * recording HandoffService / InteractionOutcomeService doubles (the business
 * module is built by another engineer; these doubles only record requests).
 * SYNTHETIC data only; used by gateway route tests (fastify.inject).
 */
import type { FastifyInstance } from "fastify";
import { LedgerActionService } from "../../actions/action-service.js";
import { PgAuditHealth } from "../../audit/health.js";
import type { HandoffResult, HandoffService, InteractionOutcomeService } from "../../business/contract.js";
import type { DestinationConfig } from "../../config/ports.js";
import { DESTINATIONS, TENANT_ID } from "../../fixtures/synthetic-world.js";
import { PgOutbox } from "../../outbox/outbox.js";
import { SafetyPipeline } from "../../safety/pipeline.js";
import { newId } from "../../shared/ids.js";
import { TemplateResponseGate } from "../../voice/gate.js";
import { loadDefaultTemplateRegistry } from "../../voice/registry.js";
import { InMemoryTurnTracker } from "../../voice/turns.js";
import { MemoryTransferStore, TransferCoordinator } from "../../workflows/transfer.js";
import { LocalFixtureTokenAuthenticator } from "../auth.js";
import { HandoffIndex, SessionLeaseRegistry } from "../call-state.js";
import { GatewayAudit } from "../gateway-audit.js";
import { buildGatewayApp } from "../http/app.js";
import { ReadinessProbe, healthRoutes } from "../http/health-routes.js";
import { portalRoutes } from "../http/portal-routes.js";
import { telephonyRoutes } from "../http/telephony-routes.js";
import { toolRoutes } from "../http/tool-routes.js";
import { webhookRoutes } from "../http/webhook-routes.js";
import { mcpRoutes } from "../mcp.js";
import { createGatewayHarness } from "./harness.fixture.js";
import type { GatewayHarness, GatewayHarnessOptions } from "./harness.fixture.js";

export const FIXTURE_DESTINATIONS: DestinationConfig[] = DESTINATIONS.map((d) => ({ ...d, fallbackDestinationIds: [...d.fallbackDestinationIds], languages: [...d.languages] }));

/** LOCAL TEST FIXTURE HandoffService: records requests; destinations from the trusted synthetic allowlist only. */
export class RecordingHandoffFixture implements HandoffService {
  readonly humanRequests: Parameters<HandoffService["requestHuman"]>[0][] = [];
  readonly safetyRequests: Parameters<HandoffService["requestSafetyRoute"]>[0][] = [];
  failing = false;
  async requestHuman(input: Parameters<HandoffService["requestHuman"]>[0]): Promise<HandoffResult> {
    if (this.failing) throw new Error("HANDOFF_FIXTURE_DOWN");
    this.humanRequests.push(input);
    const destinationId = input.reason === "CLINICAL_QUESTION" ? "dst_clinical_route" : "dst_support_general";
    return { handoffId: newId("hof"), transferId: newId("xfr"), destinationId, journey: null, speechTemplateId: "transfer.in_progress" };
  }
  async requestSafetyRoute(input: Parameters<HandoffService["requestSafetyRoute"]>[0]): Promise<HandoffResult> {
    if (this.failing) throw new Error("HANDOFF_FIXTURE_DOWN");
    this.safetyRequests.push(input);
    return { handoffId: newId("hof"), transferId: newId("xfr"), destinationId: "dst_safety_priority", journey: null, speechTemplateId: "safety.acknowledgment" };
  }
}

/** LOCAL TEST FIXTURE outcome recorder (honest default: OUTCOME_UNKNOWN without evidence). */
export class RecordingOutcomeFixture implements InteractionOutcomeService {
  readonly calls: Parameters<InteractionOutcomeService["record"]>[0][] = [];
  async record(input: Parameters<InteractionOutcomeService["record"]>[0]) {
    this.calls.push(input);
    if (input.evidence.callerDisconnected) return { outcome: "CALLER_DISCONNECTED" as const, reasonCode: "CALLER_DISCONNECTED" };
    return { outcome: "OUTCOME_UNKNOWN" as const, reasonCode: "NO_SUCCESS_EVIDENCE" };
  }
}

export interface AppHarness extends GatewayHarness {
  app: FastifyInstance;
  actions: LedgerActionService;
  handoff: RecordingHandoffFixture;
  outcomes: RecordingOutcomeFixture;
  turns: InMemoryTurnTracker;
  transfers: TransferCoordinator;
  leases: SessionLeaseRegistry;
  auditHealth: PgAuditHealth;
}

export interface AppHarnessOptions extends GatewayHarnessOptions {
  environment?: "local" | "ci" | "sandbox";
  otpEnabled?: boolean;
  rateLimit?: { max: number; timeWindowMs: number } | null;
  /** Per-call tool limit (SAFE-HANDOFF-03 / VSP-GW-01 tests); default derived from rateLimit. */
  perCallRateLimit?: { max: number; timeWindowMs: number };
}

export async function createAppHarness(opts: AppHarnessOptions = {}): Promise<AppHarness> {
  const h = await createGatewayHarness(opts);
  const clock = h.identity.clock;
  const auditHealth = new PgAuditHealth({ db: h.db, clock, policy: { maxBacklog: 100_000, maxBacklogAgeSeconds: 86_400 }, probeId: "gateway.test" });
  const actions = new LedgerActionService({ db: h.db, clock, audit: h.realAudit, auditHealth, outbox: new PgOutbox({ clock }) });
  const templates = loadDefaultTemplateRegistry();
  const turns = new InMemoryTurnTracker();
  const gate = new TemplateResponseGate({ registry: templates, turnTracker: turns });
  const handoff = new RecordingHandoffFixture();
  const outcomes = new RecordingOutcomeFixture();
  const transfers = new TransferCoordinator({
    store: new MemoryTransferStore(),
    telephony: h.fixtures.telephony,
    destinations: FIXTURE_DESTINATIONS,
    clock,
    audit: h.realAudit,
    config: { environment: "local", updateTemplateIds: { STANDARD: "transfer.failed_next_route", SAFETY: "transfer.safety_update" }, attemptTimeoutMs: { STANDARD: 60_000, SAFETY: 30_000 }, maxStandardContinuityAttempts: 3 },
  });
  const leases = new SessionLeaseRegistry();
  const gatewayAudit = new GatewayAudit(h.audit, clock, h.identity.logger, h.versions);
  const environment = opts.environment ?? "local";
  const authenticator = new LocalFixtureTokenAuthenticator({ environment: environment === "sandbox" ? "local" : environment, tenantId: TENANT_ID });
  const app = await buildGatewayApp({
    logger: h.identity.logger,
    authenticator,
    rateLimit: opts.rateLimit === undefined ? null : opts.rateLimit,
    ...(opts.perCallRateLimit ? { perCallRateLimit: opts.perCallRateLimit } : {}),
    routes: [
      ...healthRoutes(new ReadinessProbe({ db: h.db, policy: h.engine, auditHealth, configGuardPassed: true })),
      ...toolRoutes({ pipeline: h.pipeline, catalog: h.catalog }),
      ...mcpRoutes({ pipeline: h.pipeline, catalog: h.catalog, logger: h.identity.logger }),
      ...telephonyRoutes({
        tenantId: TENANT_ID,
        environment: "local",
        clock,
        logger: h.identity.logger,
        sessions: h.identity.sessions,
        verification: h.identity.verification,
        otpEnabled: opts.otpEnabled ?? false,
        actions,
        admission: h.admission,
        turns,
        gate,
        templates,
        safety: new SafetyPipeline(),
        handoff,
        outcomes,
        auditHealth,
        audit: gatewayAudit,
        interactionLookup: h.lookup,
        leases,
        handoffs: new HandoffIndex(clock),
        versions: h.versions,
        destinations: FIXTURE_DESTINATIONS,
      }),
      ...portalRoutes({ tenantId: TENANT_ID, verification: h.identity.verification, audit: gatewayAudit }),
      ...webhookRoutes({ environment, clock, transfers }),
    ],
  });
  const close = h.close;
  return {
    ...h,
    app,
    actions,
    handoff,
    outcomes,
    turns,
    transfers,
    leases,
    auditHealth,
    async close() {
      await app.close();
      await close();
    },
  };
}
