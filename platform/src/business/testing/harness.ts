/**
 * LOCAL TEST HARNESS — NOT A COMPOSITION ROOT, NOT FOR PRODUCTION.
 *
 * Builds ToolDeps from the REAL wave-1 modules over PGlite (all migrations) and the
 * labelled LOCAL fixtures with SYNTHETIC data only (platform/src/fixtures/synthetic-world.ts):
 * PgAuditWriter/PgAuditHealth/PgAuditQuery, OpaWasmPolicyEngine (the built policy bundle),
 * TrustedSessionService/SecureVerificationService/SignedAssertionService (identity harness
 * fixture), LedgerActionService, PgOutbox, PgWorkflowEngine, TransferCoordinator,
 * KnowledgeServicePg (SYNTHETIC corpus), SupportMemoryPg, ops kill switches and admission,
 * the local adapter fixtures, the safety detector/router and the voice registry and gate.
 *
 * `invoke()` is a LOCAL test pipeline that mirrors the documented gateway request flow
 * (docs/ARCHITECTURE.md section 4: strict input -> authoritative resource -> OPA decision
 * -> execute -> strict output -> field mask) so the business tools can be exercised end
 * to end. The production pipeline is platform/src/gateway (gateway engineer).
 */
import { LedgerActionService } from "../../actions/action-service.js";
import { createLocalFixtureSet, type LocalFixtureSet } from "../../adapters/local/fixture-set.js";
import { PgAuditHealth } from "../../audit/health.js";
import { PgAuditQuery } from "../../audit/query.js";
import { PgAuditWriter } from "../../audit/writer.js";
import type { DestinationConfig } from "../../config/ports.js";
import { createTestDb } from "../../db/testing.js";
import type { PgliteDb } from "../../db/pglite.js";
import { CALLS, DESTINATIONS, PEOPLE, TENANT_ID } from "../../fixtures/synthetic-world.js";
import { applyFieldMask } from "../../gateway/mask.js";
import type { ToolModule, ToolOutcome } from "../../gateway/ports.js";
import { AssertionKeyRing } from "../../identity/assertions/key-ring.js";
import { SignedAssertionService } from "../../identity/assertions/assertion-service.js";
import { LocalEs256Signer } from "../../identity/assertions/signers.js";
import { createIdentityHarness, mcp, telephony, type IdentityHarness } from "../../identity/identity-harness.fixture.js";
import { KnowledgeServicePg } from "../../knowledge/service.js";
import { loadLocalCorpus } from "../../knowledge/corpus.js";
import type { KnowledgeItemInput } from "../../knowledge/ports.js";
import { SupportMemoryPg } from "../../memory/support-memory.js";
import { silentLogger } from "../../observability/logger.js";
import { InMemoryMetrics } from "../../observability/metrics.js";
import { createOpsServices, type OpsServices } from "../../ops/compose.js";
import { PgOutbox } from "../../outbox/outbox.js";
import { OpaWasmPolicyEngine } from "../../policy/engine.js";
import { ensurePolicyBundle } from "../../policy/ensure-bundle.js";
import { buildPolicyInput, toolPolicyRef } from "../../policy/input.js";
import type { AuthContext, PolicyDecision, ToolRequest, VersionSet } from "../../protocol/index.js";
import { RuleBasedSafetySignalDetector } from "../../safety/detector.js";
import { DeterministicSafetyRouter } from "../../safety/router.js";
import { digestOf, sha256Hex } from "../../shared/canonical.js";
import type { FakeClock } from "../../shared/clock.js";
import { iso } from "../../shared/clock.js";
import { newId, newTurnId } from "../../shared/ids.js";
import { TemplateResponseGate } from "../../voice/gate.js";
import { loadDefaultTemplateRegistry } from "../../voice/registry.js";
import { createDefaultRegistry } from "../../workflows/registry.js";
import { PgWorkflowEngine } from "../../workflows/engine.js";
import { MemoryTransferStore, TransferCoordinator } from "../../workflows/transfer.js";
import type { ToolDeps } from "../contract.js";
import { TOOL_DEFINITIONS } from "../../gateway/tools/definitions.js";
import { buildBusinessServices, type BuildBusinessOptions } from "../index.js";
import type { BusinessModule } from "../contract.js";
import type { BusinessServices } from "../services/types.js";

export const BUSINESS_HARNESS_LABEL = "LOCAL TEST HARNESS — SYNTHETIC DATA ONLY — NOT A PRODUCTION COMPOSITION";

export interface BusinessHarness {
  label: string;
  clock: FakeClock;
  db: PgliteDb;
  deps: ToolDeps;
  identity: IdentityHarness;
  fixtures: LocalFixtureSet;
  ops: OpsServices;
  actions: LedgerActionService;
  workflows: PgWorkflowEngine;
  transfers: TransferCoordinator;
  policy: OpaWasmPolicyEngine;
  metrics: InMemoryMetrics;
  business: BusinessModule;
  services: BusinessServices;
  tool(name: string): ToolModule;
  /** A0 session for a call (consent granted by the Studio fixture). */
  startCall(callId?: string): Promise<{ sessionRef: string; ctx: AuthContext }>;
  /** Secure-link verification of a SYNTHETIC person (A2) and the fresh context. */
  verify(person: (typeof PEOPLE)[keyof typeof PEOPLE], sessionRef: string, role?: AuthContext["selectedRole"]): Promise<AuthContext>;
  resolve(sessionRef: string): Promise<AuthContext>;
  invoke(name: string, auth: AuthContext, args: Record<string, unknown>, opts?: { turnId?: string }): Promise<InvokeResult>;
  /** Trusted confirmation captured by the deterministic Studio step (telephony_control identity). */
  confirm(auth: AuthContext, actionId: string, digest: string): Promise<void>;
  close(): Promise<void>;
}

export type InvokeResult =
  | { stage: "input"; reasonCode: "TOOL_INPUT_INVALID" }
  | { stage: "policy"; decision: PolicyDecision; reasonCode: string }
  | { stage: "output"; reasonCode: "TOOL_OUTPUT_INVALID"; outcome: ToolOutcome<unknown> }
  | { stage: "done"; decision: PolicyDecision; outcome: ToolOutcome<unknown>; masked: Record<string, unknown> | null };

export interface BusinessHarnessOptions extends BuildBusinessOptions {
  destinations?: DestinationConfig[];
}

export async function createBusinessHarness(opts: BusinessHarnessOptions = {}): Promise<BusinessHarness> {
  const identity = await createIdentityHarness();
  const clock = identity.clock;
  const db = await createTestDb();
  const logger = silentLogger;
  const metrics = new InMemoryMetrics();
  const audit = new PgAuditWriter({ db, clock, stream: "business-test" });
  const auditHealth = new PgAuditHealth({ db, clock, policy: { maxBacklog: 1_000_000, maxBacklogAgeSeconds: 86_400 * 365 }, probeId: "business-test" });
  const auditQuery = new PgAuditQuery(db, "app_auditor");
  const outbox = new PgOutbox({ clock });
  const actions = new LedgerActionService({ db, clock, audit, auditHealth, outbox });
  const fixtures = createLocalFixtureSet({ clock, freeze: false });
  const workflows = new PgWorkflowEngine({ db, registry: createDefaultRegistry(), audit, clock });
  const destinations: DestinationConfig[] = opts.destinations ?? DESTINATIONS.map((d) => ({ ...d, fallbackDestinationIds: [...d.fallbackDestinationIds], languages: [...d.languages] }));
  const transfers = new TransferCoordinator({
    store: new MemoryTransferStore(),
    telephony: fixtures.telephony,
    destinations,
    clock,
    audit,
    config: {
      environment: "local",
      updateTemplateIds: { STANDARD: "transfer.failed_next_route", SAFETY: "transfer.safety_update" },
      attemptTimeoutMs: { STANDARD: 60_000, SAFETY: 60_000 },
      maxStandardContinuityAttempts: 3,
    },
  });
  const knowledge = new KnowledgeServicePg({ db, environment: "local", clock, embedder: null, allowedLinkDomains: ["portal.synthetic-health.test", "pay.synthetic-health.test"] });
  await knowledge.ingest(
    TENANT_ID,
    loadLocalCorpus({ set: "approved", environment: "local" }).map((f) => f.item as KnowledgeItemInput),
  );
  const snapshot = await knowledge.snapshot(TENANT_ID);
  const memory = new SupportMemoryPg({ db, tenantIds: [TENANT_ID], clock });
  const ops = createOpsServices({ environment: "local" }, { db, audit, clock, metrics });
  const policy = await OpaWasmPolicyEngine.load({ bundleDir: ensurePolicyBundle().bundleDir, clock });
  const templates = loadDefaultTemplateRegistry();
  const keyRing = new AssertionKeyRing(new LocalEs256Signer());
  const assertions = new SignedAssertionService({ keyRing, kv: identity.kv, clock, issuer: "vsp-identity/local-test" });
  const versions: VersionSet = {
    agentConfig: "local-agent-unpinned",
    model: "unselected",
    voice: "unselected",
    promptTemplates: templates.digest(),
    policyBundle: policy.policyVersion,
    toolCatalog: digestOf(Object.values(TOOL_DEFINITIONS)),
    knowledgeSnapshot: snapshot.version,
    schema: "2026-10-17.1",
  };
  const deps: ToolDeps = {
    tenantId: TENANT_ID,
    environment: "local",
    clock,
    logger,
    metrics,
    db,
    audit,
    auditHealth,
    auditQuery,
    policy,
    sessions: identity.sessions,
    verification: identity.verification,
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
      identityDirectory: identity.directory,
      relationships: fixtures.relationships,
      scheduling: fixtures.scheduling,
      billing: fixtures.billing,
      claims: fixtures.claims,
      provider: fixtures.provider,
      supportRecords: fixtures.supportRecords,
      telephony: fixtures.telephony,
      notifications: identity.notifications,
    },
    destinations,
    safety: { detector: new RuleBasedSafetySignalDetector(), router: new DeterministicSafetyRouter() },
    templates,
    responseGate: new TemplateResponseGate({ registry: templates }),
    versions,
    localFixture: true,
  };
  const { module, services } = buildBusinessServices(deps, opts);
  const byName = new Map(module.tools.map((t) => [t.definition.name, t]));

  const h: BusinessHarness = {
    label: BUSINESS_HARNESS_LABEL,
    clock,
    db,
    deps,
    identity,
    fixtures,
    ops,
    actions,
    workflows,
    transfers,
    policy,
    metrics,
    business: module,
    services,
    tool(name) {
      const t = byName.get(name);
      if (!t) throw new Error(`HARNESS_TOOL_UNKNOWN:${name}`);
      return t;
    },
    async startCall(callId = CALLS.primary.callId) {
      const started = await identity.startCall(callId);
      return { sessionRef: started.sessionRef, ctx: started.ctx };
    },
    async verify(person, sessionRef, role) {
      if (role && role !== person.role) await identity.sessions.selectRole(sessionRef, telephony(), role);
      else await identity.sessions.selectRole(sessionRef, telephony(), person.role);
      const r = await identity.verifyWithSecureLink(person, sessionRef, (role ?? person.role) as (typeof person)["role"]);
      if (!r.result.bound) throw new Error(`HARNESS_VERIFICATION_FAILED:${r.result.reasonCode}`);
      return identity.sessions.resolve(sessionRef, mcp());
    },
    resolve: (sessionRef) => identity.sessions.resolve(sessionRef, mcp()),
    async invoke(name, auth, args, o = {}) {
      const tool = h.tool(name);
      const parsed = tool.input.safeParse(args);
      if (!parsed.success) return { stage: "input", reasonCode: "TOOL_INPUT_INVALID" };
      const input = parsed.data;
      const resource = await tool.resolveResource(auth, input);
      const relationships = auth.actorId && auth.selectedRole ? await fixtures.relationships.relationshipsFor(auth.actorId, auth.selectedRole) : [];
      const ks = await ops.killSwitches.snapshot(auth.tenantId);
      const now = clock.now();
      const decision = await policy.decide(
        buildPolicyInput({
          auth,
          action: tool.definition.permissions[0] as string,
          purpose: tool.purpose(auth, input),
          tool: toolPolicyRef(tool.definition),
          resource,
          relationships,
          killSwitches: { aiAdmission: ks.aiAdmission, writes: ks.writes, intents: ks.intents, integrations: ks.integrations },
          environment: "local",
          now,
        }),
      );
      if (!decision.allow) return { stage: "policy", decision, reasonCode: decision.reasonCodes[0] ?? "POLICY_DENIED" };
      const request: ToolRequest = {
        requestId: newId("req"),
        tool: { name: tool.definition.name, version: tool.definition.version },
        sessionRef: null,
        turnId: o.turnId ?? newTurnId(),
        arguments: args,
        idempotencyKey: null,
        receivedAt: iso(now),
      };
      const outcome = await tool.execute({ auth, request, decision, now }, input);
      if (outcome.status === "SUCCESS" || outcome.status === "PENDING") {
        const out = tool.output.safeParse(outcome.data);
        if (!out.success) return { stage: "output", reasonCode: "TOOL_OUTPUT_INVALID", outcome };
        return { stage: "done", decision, outcome, masked: applyFieldMask(out.data as Record<string, unknown>, decision.fieldMask, tool.maskTarget) };
      }
      return { stage: "done", decision, outcome, masked: null };
    },
    async confirm(auth, actionId, digest) {
      await actions.confirm(
        {
          actionId,
          digest,
          sessionRef: auth.sessionRef,
          sessionGeneration: auth.sessionGeneration,
          turnId: `turn_${sha256Hex(actionId).slice(0, 12)}`,
          method: "dtmf_keypress",
          capturedBy: "talkdesk-studio",
          capturedAt: iso(clock.now()),
        },
        telephony(),
      );
    },
    async close() {
      await db.close();
    },
  };
  return h;
}

/** Narrowing helper for tests. */
export function expectDone(r: InvokeResult): Extract<InvokeResult, { stage: "done" }> {
  if (r.stage !== "done") throw new Error(`HARNESS_EXPECTED_DONE:${r.stage}:${"reasonCode" in r ? r.reasonCode : ""}`);
  return r;
}

export { PEOPLE, CALLS, TENANT_ID };
