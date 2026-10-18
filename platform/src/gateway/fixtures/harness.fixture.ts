/**
 * LOCAL TEST FIXTURE: wires the real ToolPipeline over the real policy bundle,
 * PGlite (all migrations), the real PgAuditWriter, the real tool-request
 * idempotency store and the identity module's TrustedSessionService, with
 * SYNTHETIC data and labelled local fixtures for everything external. Used only
 * by gateway tests; never by the composition root.
 */
import { createLocalFixtureSet } from "../../adapters/local/fixture-set.js";
import type { LocalFixtureSet } from "../../adapters/local/fixture-set.js";
import { ToolRequestIdempotency } from "../../actions/tool-idempotency.js";
import { AuditWriterOutageFixture } from "../../audit/fixtures.js";
import { PgAuditWriter } from "../../audit/writer.js";
import { createTestDb } from "../../db/testing.js";
import type { PgliteDb } from "../../db/pglite.js";
import { CALLS, PEOPLE, TENANT_ID } from "../../fixtures/synthetic-world.js";
import { createIdentityHarness, mcp } from "../../identity/identity-harness.fixture.js";
import type { IdentityHarness } from "../../identity/identity-harness.fixture.js";
import { InMemoryMetrics, createMetricCatalogue } from "../../observability/metrics.js";
import { createMemoryLogger } from "../../observability/logger.js";
import type { KillSwitchService, KillSwitchSnapshot, AdmissionController, AdmissionDecision } from "../../ops/ports.js";
import { OpaWasmPolicyEngine } from "../../policy/engine.js";
import { ensurePolicyBundle } from "../../policy/ensure-bundle.js";
import type { PolicyEngine } from "../../policy/ports.js";
import type { IntegrationIdentity, KillSwitch, VersionSet } from "../../protocol/index.js";
import { PROTOCOL_VERSION } from "../../protocol/index.js";
import { CircuitBreakerRegistry } from "../../resilience/circuit-breaker.js";
import type { TimerPort } from "../../resilience/timeout.js";
import { loadDefaultTemplateRegistry } from "../../voice/registry.js";
import { TemplateResponseGate } from "../../voice/gate.js";
import { buildCatalog } from "../catalog.js";
import type { PinnedCatalog } from "../catalog.js";
import { ToolPipeline, routingFromPolicyCatalogue } from "../pipeline.js";
import type { ToolInvocation, TransportContext } from "../pipeline.js";
import { LocalInteractionLookupFixture, SessionBindingResolver } from "../session-binding.js";
import type { SessionBindingMode } from "../session-binding.js";
import type { ToolModule } from "../ports.js";
import {
  FixtureFaults,
  fixtureAppointmentsTool,
  fixtureCommitTool,
  fixtureHumanTool,
  fixtureIntakeTool,
  fixturePublicFaqTool,
  fixtureSafetyToolWithoutSessionless,
} from "./tools.fixture.js";

export const FIXTURE_TOOL_NAMES = [
  "fixture_get_appointments",
  "fixture_public_faq",
  "fixture_request_human",
  "fixture_safety_route",
  "fixture_create_request",
  "fixture_commit_change",
] as const;

/** LOCAL TEST FIXTURE kill-switch state (in memory). */
export class StaticKillSwitchesFixture implements KillSwitchService {
  readonly kind = "local_fixture" as const;
  state: KillSwitchSnapshot = { aiAdmission: false, writes: false, outboundNotifications: false, intents: [], integrations: [], modelVersions: [], voiceVersions: [] };
  failing = false;
  async snapshot(): Promise<KillSwitchSnapshot> {
    if (this.failing) throw new Error("KILL_SWITCH_STORE_DOWN");
    return structuredClone(this.state);
  }
  async set(): Promise<KillSwitch> {
    throw new Error("NOT_SUPPORTED_IN_FIXTURE");
  }
  async list(): Promise<KillSwitch[]> {
    return [];
  }
}

/** LOCAL TEST FIXTURE admission controller (admits unless told otherwise). */
export class ScriptedAdmissionFixture implements AdmissionController {
  next: AdmissionDecision = { admitted: true, continuity: "NONE", reasonCode: "ADMITTED" };
  calls: Parameters<AdmissionController["admit"]>[0][] = [];
  async admit(input: Parameters<AdmissionController["admit"]>[0]): Promise<AdmissionDecision> {
    this.calls.push(input);
    if (input.class === "SAFETY" || input.class === "HUMAN_ROUTE") return { admitted: true, continuity: "NONE", reasonCode: "SAFETY_ALWAYS_ADMITTED" };
    return { ...this.next };
  }
  async recordCost(): Promise<void> {}
}

/** LOCAL TEST FIXTURE manual timer port: timeouts fire only when the test says so. */
export class ManualTimersFixture implements TimerPort {
  private seq = 0;
  readonly pending = new Map<number, { fn: () => void; ms: number }>();
  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.pending.set(id, { fn, ms });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }
  fireAll(): void {
    const all = [...this.pending.entries()];
    this.pending.clear();
    for (const [, t] of all) t.fn();
  }
}

/** Policy engine fixtures for failure tests. */
export class ThrowingPolicyEngineFixture implements PolicyEngine {
  readonly policyVersion = "fixture-throwing";
  readonly bundleDigest = "0".repeat(64);
  async decide(): Promise<never> {
    throw new Error("POLICY_EVALUATION_CRASHED");
  }
}

let sharedEngine: Promise<OpaWasmPolicyEngine> | null = null;
/** Loads the real policy bundle once per test process (built from policy/ when stale). */
export function loadTestPolicyEngine(): Promise<OpaWasmPolicyEngine> {
  if (!sharedEngine) sharedEngine = OpaWasmPolicyEngine.load({ bundleDir: ensurePolicyBundle().bundleDir });
  return sharedEngine;
}

export interface GatewayHarnessOptions {
  mode?: SessionBindingMode;
  exceptionApprovalId?: string | null;
  policy?: PolicyEngine;
  extraTools?: (h: { fixtures: LocalFixtureSet; faults: FixtureFaults }) => ToolModule[];
  mutationsEnabled?: boolean;
  timers?: TimerPort;
  useAdmission?: boolean;
}

export interface GatewayHarness {
  db: PgliteDb;
  identity: IdentityHarness;
  fixtures: LocalFixtureSet;
  faults: FixtureFaults;
  audit: AuditWriterOutageFixture;
  realAudit: PgAuditWriter;
  killSwitches: StaticKillSwitchesFixture;
  admission: ScriptedAdmissionFixture;
  metrics: InMemoryMetrics;
  records: ReturnType<typeof createMemoryLogger>["records"];
  catalog: PinnedCatalog;
  lookup: LocalInteractionLookupFixture;
  pipeline: ToolPipeline;
  engine: PolicyEngine;
  versions: VersionSet;
  mcpIdentity: IntegrationIdentity;
  /** Starts a SYNTHETIC call (consent granted) and returns the bearer session ref. */
  startCall(callId?: string): Promise<{ sessionRef: string; sessionGeneration: number }>;
  /** Starts a call and verifies Avery (A2) via the secure-link fixture journey. */
  verifiedAveryCall(callId?: string): Promise<{ sessionRef: string }>;
  call(inv: Partial<ToolInvocation> & { name: string }, transport?: Partial<TransportContext>, integration?: IntegrationIdentity): ReturnType<ToolPipeline["invoke"]>;
  auditRows(): Promise<{ action: string; outcome: string; reason_code: string | null; session_ref: string | null; event: Record<string, unknown> }[]>;
  close(): Promise<void>;
}

export async function createGatewayHarness(opts: GatewayHarnessOptions = {}): Promise<GatewayHarness> {
  const identity = await createIdentityHarness();
  const clock = identity.clock;
  const db = await createTestDb();
  const fixtures = createLocalFixtureSet({ clock });
  const faults = new FixtureFaults();
  const realAudit = new PgAuditWriter({ db, clock, stream: "gateway.test" });
  const audit = new AuditWriterOutageFixture(realAudit);
  const { logger, records } = createMemoryLogger();
  const metrics = new InMemoryMetrics({ catalogue: createMetricCatalogue({ toolNames: FIXTURE_TOOL_NAMES }) });
  const engine = opts.policy ?? (await loadTestPolicyEngine());
  const killSwitches = new StaticKillSwitchesFixture();
  const admission = new ScriptedAdmissionFixture();
  const templates = loadDefaultTemplateRegistry();
  const tools: ToolModule[] = [
    fixtureAppointmentsTool(fixtures.scheduling, faults) as unknown as ToolModule,
    fixturePublicFaqTool(faults) as unknown as ToolModule,
    fixtureHumanTool(faults) as unknown as ToolModule,
    fixtureSafetyToolWithoutSessionless(faults) as unknown as ToolModule,
    fixtureIntakeTool(faults) as unknown as ToolModule,
    fixtureCommitTool(faults) as unknown as ToolModule,
    ...(opts.extraTools ? opts.extraTools({ fixtures, faults }) : []),
  ];
  const catalog = buildCatalog(tools);
  const lookup = new LocalInteractionLookupFixture();
  const binding = new SessionBindingResolver({ mode: opts.mode ?? "trusted_header", exceptionApprovalId: opts.exceptionApprovalId ?? null, sessions: identity.sessions, lookup });
  const versions: VersionSet = {
    agentConfig: "local-fixture-agent",
    model: "local-fixture-model",
    voice: "local-fixture-voice",
    promptTemplates: templates.digest(),
    policyBundle: engine.policyVersion === "fixture-throwing" ? "fixture-throwing" : engine.policyVersion,
    toolCatalog: catalog.digest,
    knowledgeSnapshot: "knowledge-local-fixture",
    schema: PROTOCOL_VERSION,
  };
  const engineCatalogue = (engine as { catalogue?: unknown }).catalogue as Parameters<typeof routingFromPolicyCatalogue>[0];
  const pipeline = new ToolPipeline({
    tenantId: TENANT_ID,
    environment: "local",
    clock,
    logger,
    metrics,
    catalog,
    binding,
    killSwitches,
    admission: opts.useAdmission === false ? null : admission,
    policy: engine,
    relationships: fixtures.relationships,
    idempotency: new ToolRequestIdempotency({ db, clock }),
    audit,
    breakers: new CircuitBreakerRegistry({ clock, metrics }, { windowMs: 60_000, minimumRequests: 3, failureRateThreshold: 0.5, cooldownMs: 30_000, halfOpenMaxProbes: 1, halfOpenSuccessesToClose: 1 }),
    speechPrecheck: new TemplateResponseGate({ registry: templates }),
    templates,
    versions,
    localFixture: true,
    routing: routingFromPolicyCatalogue(engineCatalogue),
    mutationsEnabled: opts.mutationsEnabled ?? true,
    timers: opts.timers,
    retrySleep: async () => undefined,
    random: () => 0,
  });
  const mcpIdentity = mcp();

  async function startCall(callId: string = CALLS.primary.callId) {
    const started = await identity.startCall(callId);
    lookup.bind({ tenantId: TENANT_ID, integrationId: mcpIdentity.integrationId, interactionId: callId }, started.sessionRef);
    return { sessionRef: started.sessionRef, sessionGeneration: started.sessionGeneration };
  }

  return {
    db,
    identity,
    fixtures,
    faults,
    audit,
    realAudit,
    killSwitches,
    admission,
    metrics,
    records,
    catalog,
    lookup,
    pipeline,
    engine,
    versions,
    mcpIdentity,
    startCall,
    async verifiedAveryCall(callId = CALLS.primary.callId) {
      const { sessionRef } = await startCall(callId);
      const r = await identity.verifyWithSecureLink(PEOPLE.avery, sessionRef);
      if (!r.result.bound) throw new Error(`FIXTURE_VERIFY_FAILED_${r.result.reasonCode}`);
      return { sessionRef };
    },
    call(inv, transport = {}, integration = mcpIdentity) {
      return pipeline.invoke(
        { version: null, arguments: {}, ...inv },
        integration,
        { kind: "mcp", sessionRefHeader: null, interactionIdHeader: null, ...transport },
      );
    },
    async auditRows() {
      const r = await db.query<{ event: Record<string, unknown> }>("select event from audit_outbox order by recorded_at, sequence");
      return r.rows.map((row) => ({
        action: String(row.event.action),
        outcome: String(row.event.outcome),
        reason_code: (row.event.reasonCode as string | null) ?? null,
        session_ref: (row.event.sessionRef as string | null) ?? null,
        event: row.event,
      }));
    },
    async close() {
      await db.close();
    },
  };
}
