/**
 * Layer-2 support (WP-05): the production trusted tool pipeline composed over the identity suite's live
 * pieces, so the caller fault tests observe their postconditions where a caller would meet them:
 *
 *   ToolPipeline (platform/src/gateway/pipeline.ts) with the SessionBindingResolver over the SAME
 *   TrustedSessionService on DynamoDB Local the test verifies against, the real OPA WASM policy bundle,
 *   PgAuditWriter / ToolRequestIdempotency / KillSwitchServicePg on PostgreSQL 16 (every migration), the
 *   real template registry and TemplateResponseGate, and the production circuit breakers.
 *
 * Test plumbing, labelled and SYNTHETIC (the system of record is not under test here; the identity, policy,
 * audit and speech components are):
 *   - `l2_get_appointments`: a PROTECTED_READ tool module over the real `appointment:read` policy action whose
 *     record source is an in-test list of SYNTHETIC appointments keyed by subject id;
 *   - `l2_request_human`: a SAFETY_AND_HUMAN_ROUTE tool module over `human:request` with a session-less path
 *     (SAFE-02), which records that a person was requested;
 *   - a relationship stand-in that returns the `self` fact for the stand-in accounts (the enrollment system).
 * Nothing here is imported from a LOCAL FIXTURE module (no-unit-fakes.ts).
 */
import { z } from "zod";
import type { AdapterHealth, RelationshipDirectory } from "../../../src/adapters/ports.js";
import { ToolRequestIdempotency } from "../../../src/actions/tool-idempotency.js";
import { PgAuditWriter } from "../../../src/audit/writer.js";
import type { Db } from "../../../src/db/types.js";
import { buildCatalog } from "../../../src/gateway/catalog.js";
import { ToolPipeline, routingFromPolicyCatalogue } from "../../../src/gateway/pipeline.js";
import type { ToolInvocation } from "../../../src/gateway/pipeline.js";
import type { ToolModule, ToolOutcome } from "../../../src/gateway/ports.js";
import { BlockedInteractionLookup, SessionBindingResolver } from "../../../src/gateway/session-binding.js";
import type { TrustedSessionService } from "../../../src/identity/session-service.js";
import { createMemoryLogger } from "../../../src/observability/logger.js";
import { InMemoryMetrics, createMetricCatalogue } from "../../../src/observability/metrics.js";
import { KillSwitchServicePg } from "../../../src/ops/kill-switches.js";
import { OpaWasmPolicyEngine } from "../../../src/policy/engine.js";
import { ensurePolicyBundle } from "../../../src/policy/ensure-bundle.js";
import { OpaqueId, PROTOCOL_VERSION } from "../../../src/protocol/index.js";
import type { IntegrationIdentity, RelationshipFact, Role, ToolResult } from "../../../src/protocol/index.js";
import { CircuitBreakerRegistry } from "../../../src/resilience/circuit-breaker.js";
import type { Clock } from "../../../src/shared/clock.js";
import { AccessDeniedError } from "../../../src/shared/errors.js";
import { newId } from "../../../src/shared/ids.js";
import { TemplateResponseGate } from "../../../src/voice/gate.js";
import type { GateContext } from "../../../src/voice/ports.js";
import { loadDefaultTemplateRegistry } from "../../../src/voice/registry.js";

export const L2_TOOL_NAMES = ["l2_get_appointments", "l2_request_human"] as const;

export interface SyntheticAppointment {
  appointmentId: string;
  subjectId: string;
  startsAt: string;
  timeZone: string;
}

const retryOnce = { maxAttempts: 1, backoffMs: 0, jitter: false, retryOn: [] as ("TIMEOUT_BEFORE_SEND" | "CONNECTION_REFUSED" | "HTTP_429" | "HTTP_503")[] };

const AppointmentRow = z.strictObject({
  appointmentId: OpaqueId,
  subjectId: OpaqueId,
  providerDisplayName: z.string().max(80),
  startsAt: z.string().max(40),
  timeZone: z.string().max(64),
  modality: z.enum(["video", "in_person", "phone"]),
  status: z.enum(["SCHEDULED", "CANCELLED", "COMPLETED"]),
});
const AppointmentsOutput = z.strictObject({ appointments: z.array(AppointmentRow).max(20), count: z.number().int().min(0) });
const NoInput = z.strictObject({});

/** PROTECTED_READ over `appointment:read` (A2, self relationship, AUDIT_READ). Reads counted in `reads`. */
function appointmentsTool(records: SyntheticAppointment[], counters: { reads: number }): ToolModule<z.infer<typeof NoInput>, z.infer<typeof AppointmentsOutput>> {
  return {
    definition: {
      name: "l2_get_appointments",
      version: "1.0.0",
      description: "LAYER-2 TEST TOOL: lists the authenticated client's own SYNTHETIC appointments.",
      safetyClass: "PROTECTED_READ",
      dataClassification: "PHI",
      minAssurance: "A2",
      permissions: ["appointment:read"],
      timeoutMs: 2_000,
      retryPolicy: retryOnce,
      idempotency: "NATURALLY_IDEMPOTENT",
      consequential: false,
      maxInputBytes: 64,
      contracts: [],
    },
    maskTarget: { collectionKey: "appointments", envelopeKeys: ["count"] },
    input: NoInput,
    output: AppointmentsOutput,
    purpose: () => "caller_self_service",
    async resolveResource(auth) {
      return { type: "appointment", tenantId: auth.tenantId, subjectId: auth.subjectId, organizationId: null, classification: "PHI", actionDigest: null };
    },
    async execute(ctx): Promise<ToolOutcome<z.infer<typeof AppointmentsOutput>>> {
      counters.reads += 1;
      const subjectId = ctx.auth.subjectId;
      if (!subjectId) throw new AccessDeniedError("SUBJECT_NOT_ESTABLISHED");
      const mine = records.filter((r) => r.subjectId === subjectId);
      const rows = mine.map((r) => ({ appointmentId: r.appointmentId, subjectId: r.subjectId, providerDisplayName: "Dr. Morgan", startsAt: r.startsAt, timeZone: r.timeZone, modality: "video" as const, status: "SCHEDULED" as const }));
      const first = mine[0];
      return {
        status: "SUCCESS",
        data: { appointments: rows, count: rows.length },
        speech: first
          ? { templateId: "appointment.facts", templateVersion: "0.1.0-draft", responseClass: "PROTECTED_FACT", slots: { providerName: "Dr. Morgan", date: first.startsAt.slice(0, 10), time: first.startsAt.slice(11, 16), timeZone: first.timeZone }, sourceRefs: [first.appointmentId] }
          : null,
      };
    },
  };
}

const HumanInput = z.strictObject({ reason: z.enum(["CALLER_REQUESTED_HUMAN"]), language: z.enum(["en"]) });
const RouteOutput = z.strictObject({ destinationPurpose: z.enum(["STANDARD_SUPPORT"]), status: z.enum(["REQUESTED"]), transferId: OpaqueId.nullable() });

/** SAFETY_AND_HUMAN_ROUTE over `human:request`, with and without a session (SAFE-02). */
function humanTool(requested: { withSession: number; withoutSession: number }): ToolModule<z.infer<typeof HumanInput>, z.infer<typeof RouteOutput>> {
  const outcome = (): ToolOutcome<z.infer<typeof RouteOutput>> => ({
    status: "PENDING",
    reasonCode: "TRANSFER_REQUESTED",
    pendingRef: newId("xfr"),
    data: { destinationPurpose: "STANDARD_SUPPORT", status: "REQUESTED", transferId: null },
    speech: { templateId: "transfer.in_progress", templateVersion: "0.1.0-draft", responseClass: "GENERIC_STATUS", slots: {}, sourceRefs: [] },
  });
  return {
    definition: {
      name: "l2_request_human",
      version: "1.0.0",
      description: "LAYER-2 TEST TOOL: requests a person; never requires authentication (SAFE-02).",
      safetyClass: "SAFETY_AND_HUMAN_ROUTE",
      dataClassification: "INTERNAL",
      minAssurance: "A0",
      permissions: ["human:request"],
      timeoutMs: 2_000,
      retryPolicy: retryOnce,
      idempotency: "NATURALLY_IDEMPOTENT",
      consequential: false,
      maxInputBytes: 128,
      contracts: [],
    },
    maskTarget: { collectionKey: null, envelopeKeys: [] },
    input: HumanInput,
    output: RouteOutput,
    purpose: () => "human_handoff",
    async resolveResource(auth) {
      return { type: "human_handoff", tenantId: auth.tenantId, subjectId: null, organizationId: null, classification: "INTERNAL", actionDigest: null };
    },
    async execute() {
      requested.withSession += 1;
      return outcome();
    },
    async executeWithoutSession() {
      requested.withoutSession += 1;
      return outcome();
    },
  };
}

/** Enrollment-system stand-in: the `self` fact of each stand-in account (client role). */
export class StandInRelationships implements RelationshipDirectory {
  readonly kind = "local_fixture" as const;
  readonly integrationId = "relationships-l2";
  constructor(private readonly selves: { actorId: string; subjectId: string }[]) {}
  async health(): Promise<AdapterHealth> {
    return { healthy: true, reasonCode: null };
  }
  async relationshipsFor(actorId: string, role: Role): Promise<RelationshipFact[]> {
    const me = this.selves.find((s) => s.actorId === actorId);
    if (!me || role !== "client") return [];
    return [{ type: "self", actorId, subjectId: me.subjectId, organizationId: null, scopes: ["appointment:read"], source: "identity_provider", validUntil: null, constraints: [] }];
  }
}

export interface ComposedGateway {
  pipeline: ToolPipeline;
  speechGate: TemplateResponseGate;
  counters: { reads: number; human: { withSession: number; withoutSession: number } };
  /** Invokes a tool as the MCP transport would; `sessionRef` null = no session header (SAFE-02 path). */
  call(name: (typeof L2_TOOL_NAMES)[number], sessionRef: string | null, args: Record<string, unknown>, turnId?: string): Promise<ToolResult>;
  /** The speech layer's render context for the CURRENT session state. */
  gateContext(input: { sessionRef: string; turnId: string; sessionGeneration: number; authorizationRefs: string[] }): GateContext;
  /** The `tool.invoke` audit row for a result (PostgreSQL), or null. */
  auditRowFor(result: ToolResult): Promise<{ action: string; outcome: string; reasonCode: string | null } | null>;
}

export async function composeGateway(o: { db: Db; sessions: TrustedSessionService; clock: Clock; tenantId: string; integration: IntegrationIdentity; appointments: SyntheticAppointment[]; relationships: RelationshipDirectory }): Promise<ComposedGateway> {
  const engine = await OpaWasmPolicyEngine.load({ bundleDir: ensurePolicyBundle().bundleDir });
  const { logger } = createMemoryLogger();
  const metrics = new InMemoryMetrics({ catalogue: createMetricCatalogue({ toolNames: L2_TOOL_NAMES }) });
  const audit = new PgAuditWriter({ db: o.db, clock: o.clock, stream: "gateway.identity-l2" });
  const templates = loadDefaultTemplateRegistry();
  const counters = { reads: 0, human: { withSession: 0, withoutSession: 0 } };
  const tools = [appointmentsTool(o.appointments, counters), humanTool(counters.human)] as unknown as ToolModule[];
  const catalog = buildCatalog(tools);
  const pipeline = new ToolPipeline({
    tenantId: o.tenantId,
    environment: "local",
    clock: o.clock,
    logger,
    metrics,
    catalog,
    binding: new SessionBindingResolver({ mode: "trusted_header", exceptionApprovalId: null, sessions: o.sessions, lookup: new BlockedInteractionLookup() }),
    killSwitches: new KillSwitchServicePg({ db: o.db, audit, clock: o.clock }),
    admission: null,
    policy: engine,
    relationships: o.relationships,
    idempotency: new ToolRequestIdempotency({ db: o.db, clock: o.clock }),
    audit,
    breakers: new CircuitBreakerRegistry({ clock: o.clock, metrics }, { windowMs: 60_000, minimumRequests: 3, failureRateThreshold: 0.5, cooldownMs: 30_000, halfOpenMaxProbes: 1, halfOpenSuccessesToClose: 1 }),
    speechPrecheck: new TemplateResponseGate({ registry: templates }),
    templates,
    versions: {
      agentConfig: "l2-identity-agent",
      model: "l2-no-model",
      voice: "l2-no-voice",
      promptTemplates: templates.digest(),
      policyBundle: engine.policyVersion,
      toolCatalog: catalog.digest,
      knowledgeSnapshot: "l2-no-knowledge",
      schema: PROTOCOL_VERSION,
    },
    // The tool modules are Layer-2 test plumbing (their record source is in the test).
    localFixture: true,
    routing: routingFromPolicyCatalogue(engine.catalogue),
    mutationsEnabled: false,
    retrySleep: async () => undefined,
    random: () => 0,
  });
  const speechGate = new TemplateResponseGate({ registry: templates });
  return {
    pipeline,
    speechGate,
    counters,
    call(name, sessionRef, args, turnId) {
      const inv: ToolInvocation = { name, version: null, arguments: args, ...(turnId ? { turnId } : {}) };
      return pipeline.invoke(inv, o.integration, { kind: "mcp", sessionRefHeader: sessionRef, interactionIdHeader: null });
    },
    gateContext({ sessionRef, turnId, sessionGeneration, authorizationRefs }) {
      return { sessionRef, currentTurnId: turnId, sessionGeneration, validAuthorizationRefs: new Set(authorizationRefs), locale: "en-US", environment: "local" };
    },
    async auditRowFor(result) {
      if (!result.auditEventId) return null;
      const r = await o.db.query<{ action: string; outcome: string; event: { reasonCode?: string | null } }>("select action, outcome, event from audit_outbox where event_id = $1", [result.auditEventId]);
      const row = r.rows[0];
      return row ? { action: row.action, outcome: row.outcome, reasonCode: row.event.reasonCode ?? null } : null;
    },
  };
}
