/**
 * LOCAL TEST FIXTURE — console API harness over REAL modules: PGlite with every
 * migration, PgAuditWriter / PgAuditHealth, the OPA WASM policy engine (built
 * from policy/), KillSwitchServicePg, BudgetServicePg, LedgerActionService,
 * PgOutboxDispatcher, PgWorkflowEngine, TransferCoordinator, KnowledgeServicePg,
 * SafetyEventRecorder and the LOCAL FIXTURE workforce IdP. Only the business
 * services (HandoffService, SupportRequestService) are labelled stand-ins
 * (business-stubs.fixture.ts), because that layer is being written concurrently.
 * SYNTHETIC data only (platform/src/fixtures/synthetic-world.ts).
 */
import Fastify from "fastify";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { LocalOidcProviderFixture } from "../../adapters/local/oidc-fixture.js";
import { TelephonyFixture } from "../../adapters/local/telephony-fixture.js";
import { LedgerActionService } from "../../actions/action-service.js";
import { FakeProviderFixture } from "../../actions/fixtures/fake-provider.fixture.js";
import { allowDecision, confirmationFor, rescheduleInput, syntheticAuthContext, telephonyIntegration } from "../../actions/fixtures/world.fixture.js";
import type { ProviderCommitPort } from "../../actions/ports.js";
import { buildAuditInput } from "../../audit/build-input.js";
import { PgAuditHealth } from "../../audit/health.js";
import { PgAuditWriter } from "../../audit/writer.js";
import { SESSION_AUDIT_ACTIONS } from "../../business/contract.js";
import type { DestinationConfig } from "../../config/ports.js";
import { createTestDb } from "../../db/testing.js";
import type { PgliteDb } from "../../db/pglite.js";
import { APPOINTMENTS, DESTINATIONS, IDP, STAFF, TENANT_ID } from "../../fixtures/synthetic-world.js";
import { KnowledgeServicePg } from "../../knowledge/service.js";
import { knowledgeItemFixture } from "../../knowledge/testing.js";
import { createMemoryLogger } from "../../observability/logger.js";
import type { LogRecord } from "../../observability/logger.js";
import { BudgetServicePg } from "../../ops/budgets.js";
import { InMemorySessionCapacity } from "../../ops/capacity.js";
import { KillSwitchServicePg } from "../../ops/kill-switches.js";
import { PgOutboxDispatcher } from "../../outbox/dispatcher.js";
import { MemoryPublisherFixture } from "../../outbox/memory-publisher.fixture.js";
import { PgOutbox } from "../../outbox/outbox.js";
import type { OpaWasmPolicyEngine } from "../../policy/engine.js";
import { loadTestEngine } from "../../policy/fixtures/inputs.fixture.js";
import type { Environment, PreparedAction, StaffActor, StaffRole } from "../../protocol/index.js";
import { humanInterventionSignal } from "../../safety/detector.js";
import { SafetyEventRecorder } from "../../safety/safety-events.js";
import { FakeClock, iso } from "../../shared/clock.js";
import { newId } from "../../shared/ids.js";
import { PgWorkflowEngine } from "../../workflows/engine.js";
import { createDefaultRegistry } from "../../workflows/registry.js";
import { MemoryTransferStore, TransferCoordinator } from "../../workflows/transfer.js";
import type { WorkflowInstance } from "../../workflows/ports.js";
import { RecheckFixture } from "../../workflows/workflow-test-fixtures.js";
import { LocalStaffDirectoryFixture, LocalWorkforceSignInFixture, WorkforceTokenVerifier } from "../auth.js";
import { PgBreakGlassGrantSource } from "../break-glass.js";
import type { BreakGlassGrantSource } from "../break-glass.js";
import { CONSOLE_API_BASE, CONSOLE_ENDPOINTS, IDEMPOTENCY_HEADER } from "../contract.js";
import type { EndpointKey } from "../contract.js";
import type { CallOwnershipSource, ConsoleApiDeps } from "../deps.js";
import { registerConsoleApi } from "../plugin.js";
import { ReleaseSubmissionRegistryPg } from "../stores.js";
import { HandoffServiceFixture, SupportRequestServiceFixture } from "./business-stubs.fixture.js";

export const HARNESS_LABEL = "LOCAL TEST FIXTURE — console API harness (PGlite, real modules, SYNTHETIC staff and calls)";
export const START = "2026-10-17T15:00:00.000Z";

export type StaffKey = keyof typeof STAFF;

export const KILL_SWITCH_TARGETS = {
  INTENT: ["appointment.reschedule", "billing.dispute"],
  INTEGRATION: ["talkdesk-telephony", "scheduling"],
  MODEL_VERSION: ["model-fixture-v1"],
  VOICE_VERSION: ["voice-fixture-v1"],
};

export interface HarnessOptions {
  environment?: Environment;
  /** Default true in local/ci. */
  localSignIn?: boolean;
  breakGlass?: BreakGlassGrantSource;
  callOwnership?: CallOwnershipSource | null;
  reconciledRetry?: ConsoleApiDeps["reconciledRetry"];
  /** Additional SYNTHETIC directory entries (multi-role or other-tenant staff) keyed by IdP subject. */
  extraStaff?: { staffId: string; tenantId: string; displayLabel: string; roles: StaffRole[]; idpSubject: string }[];
  /** Override for the deps the plugin receives (applied last). */
  patchDeps?: (deps: ConsoleApiDeps) => ConsoleApiDeps;
}

export interface InjectOptions {
  token?: string | null;
  body?: unknown;
  query?: Record<string, string>;
  params?: Record<string, string>;
  idempotencyKey?: string | null;
  headers?: Record<string, string>;
}

export interface ConsoleHarness {
  label: string;
  app: FastifyInstance;
  deps: ConsoleApiDeps;
  db: PgliteDb;
  clock: FakeClock;
  idp: LocalOidcProviderFixture;
  directory: LocalStaffDirectoryFixture;
  policy: OpaWasmPolicyEngine;
  consoleAudit: PgAuditWriter;
  runtimeAudit: PgAuditWriter;
  ledger: LedgerActionService;
  provider: FakeProviderFixture;
  outbox: PgOutbox;
  publisher: MemoryPublisherFixture;
  dispatcher: PgOutboxDispatcher;
  workflows: PgWorkflowEngine;
  transferStore: MemoryTransferStore;
  coordinator: TransferCoordinator;
  telephony: TelephonyFixture;
  killSwitches: KillSwitchServicePg;
  budgets: BudgetServicePg;
  knowledge: KnowledgeServicePg;
  safety: SafetyEventRecorder;
  releases: ReleaseSubmissionRegistryPg;
  handoff: HandoffServiceFixture;
  supportRequests: SupportRequestServiceFixture;
  logs: LogRecord[];
  token(staff: StaffKey, opts?: { amr?: string[]; ttlSeconds?: number; authTime?: number; audience?: string; issuer?: string }): Promise<string>;
  /** Token for an arbitrary directory subject (extraStaff). */
  tokenForSubject(subject: string): Promise<string>;
  call(key: EndpointKey, opts?: InjectOptions): Promise<LightMyRequestResponse>;
  staffActor(staff: StaffKey): StaffActor;
  close(): Promise<void>;
}

export function staffActorFixture(key: StaffKey, authenticatedAt = "2026-10-17T14:00:00.000Z"): StaffActor {
  const s = STAFF[key];
  return { staffId: s.staffId, roles: [...s.roles] as StaffRole[], mfa: true, authenticatedAt, breakGlass: null };
}

const destinations = (): DestinationConfig[] => DESTINATIONS.map((d) => ({ ...d, fallbackDestinationIds: [...d.fallbackDestinationIds], languages: [...d.languages] }));

export async function createConsoleHarness(opts: HarnessOptions = {}): Promise<ConsoleHarness> {
  const environment = opts.environment ?? "local";
  const db = await createTestDb();
  const clock = new FakeClock(START);
  const { logger, records } = createMemoryLogger();
  const policy = await loadTestEngine();
  const consoleAudit = new PgAuditWriter({ db, clock, stream: "console.harness", standaloneRole: "app_console" });
  const runtimeAudit = new PgAuditWriter({ db, clock, stream: "runtime.harness", standaloneRole: "app_runtime" });
  const auditHealth = new PgAuditHealth({ db, clock, policy: { maxBacklog: 100_000, maxBacklogAgeSeconds: 86_400 * 30 }, probeId: "console-harness", role: "app_console" });

  const idp = await LocalOidcProviderFixture.create({ clock, issuers: [IDP.workforceIssuer], audience: IDP.consoleAudience });
  const directory = new LocalStaffDirectoryFixture(IDP.workforceIssuer, TENANT_ID, (opts.extraStaff ?? []).map((e) => ({ ...e, active: true })));
  const verifier = WorkforceTokenVerifier.localFixture({ idp, clock });
  const offline = environment === "local" || environment === "ci";
  const localSignIn = (opts.localSignIn ?? offline) ? new LocalWorkforceSignInFixture({ environment, idp, directory, clock }) : null;

  const killSwitches = new KillSwitchServicePg({ db, audit: consoleAudit, clock, logger });
  const budgets = new BudgetServicePg({ db, audit: consoleAudit, clock, logger });
  const capacity = new InMemorySessionCapacity({ maxConcurrentAiSessions: 2000, safetyReserveSessions: 100 });

  const outbox = new PgOutbox({ clock });
  const provider = new FakeProviderFixture();
  provider.seedRecord("scheduling", APPOINTMENTS[0].appointmentId, 1);
  for (const a of APPOINTMENTS) provider.seedRecord("scheduling", a.appointmentId, 1);
  const ledger = new LedgerActionService({ db, clock, audit: runtimeAudit, auditHealth, outbox, logger });
  const publisher = new MemoryPublisherFixture();
  const dispatcher = new PgOutboxDispatcher({ db, publisher, clock, tenants: [TENANT_ID], config: { maxAttempts: 1 }, random: () => 0.5, audit: runtimeAudit, logger });

  const workflows = new PgWorkflowEngine({ db, registry: createDefaultRegistry(), audit: runtimeAudit, clock, recheck: new RecheckFixture(), logger });

  const dests = destinations();
  const telephony = new TelephonyFixture({ destinations: dests.map((d) => ({ destinationId: d.destinationId, vendorQueueRef: d.vendorQueueRef, purpose: d.purpose })), clock, defaultScript: { outcome: "STALLED", after: "QUEUED" } });
  const transferStore = new MemoryTransferStore();
  const coordinator = new TransferCoordinator({
    store: transferStore,
    telephony,
    destinations: dests,
    clock,
    audit: runtimeAudit,
    logger,
    config: { environment, updateTemplateIds: { STANDARD: "transfer.update.standard", SAFETY: "transfer.update.safety" }, attemptTimeoutMs: { STANDARD: 60_000, SAFETY: 20_000 }, maxStandardContinuityAttempts: 2 },
  });
  const knowledge = new KnowledgeServicePg({ db, environment: "local", clock, logger, audit: runtimeAudit });
  const safety = new SafetyEventRecorder({ db, audit: runtimeAudit, clock, logger });
  const releases = new ReleaseSubmissionRegistryPg(db);
  const handoff = new HandoffServiceFixture(coordinator, dests, clock);
  const supportRequests = new SupportRequestServiceFixture();

  let deps: ConsoleApiDeps = {
    environment,
    clock,
    logger,
    db,
    audit: consoleAudit,
    auditHealth,
    policy,
    auth: { verifier, staffDirectory: directory, breakGlass: opts.breakGlass ?? new PgBreakGlassGrantSource(db, logger), localSignIn, oidc: null },
    killSwitches,
    killSwitchTargets: KILL_SWITCH_TARGETS,
    budgets,
    budgetFiguresIllustrative: true,
    capacity,
    actions: ledger,
    providers: { "appointment.reschedule": provider, "appointment.create": provider, "appointment.cancel": provider },
    reconciledRetry: opts.reconciledRetry ?? null,
    outbox: dispatcher,
    workflows,
    transfers: transferStore,
    knowledge,
    handoff,
    supportRequests,
    destinations: dests,
    telephonyTransferAvailable: true,
    callOwnership: opts.callOwnership ?? null,
    dependencyHealth: async () => [{ dependencyId: "talkdesk-telephony", kind: "local_fixture", status: "HEALTHY", circuit: "CLOSED", reasonCode: null, checkedAt: iso(clock.now()) }],
    localFixture: true,
  };
  if (opts.patchDeps) deps = opts.patchDeps(deps);

  const app = Fastify({ logger: false });
  await registerConsoleApi(app, deps);
  await app.ready();

  const token = async (staff: StaffKey, t: { amr?: string[]; ttlSeconds?: number; authTime?: number; audience?: string; issuer?: string } = {}): Promise<string> => {
    const nowS = Math.floor(clock.now().getTime() / 1000);
    return idp.issueIdToken({
      issuer: t.issuer ?? IDP.workforceIssuer,
      sub: STAFF[staff].idpSubject,
      nonce: newId("non"),
      audience: t.audience ?? IDP.consoleAudience,
      amr: t.amr ?? ["local_fixture", "mfa"],
      authTime: t.authTime ?? nowS,
      issuedAt: nowS,
      ttlSeconds: t.ttlSeconds ?? 900,
    });
  };

  const tokenForSubject = async (subject: string): Promise<string> => {
    const nowS = Math.floor(clock.now().getTime() / 1000);
    return idp.issueIdToken({ issuer: IDP.workforceIssuer, sub: subject, nonce: newId("non"), audience: IDP.consoleAudience, amr: ["local_fixture", "mfa"], authTime: nowS, issuedAt: nowS, ttlSeconds: 900 });
  };

  const call = async (key: EndpointKey, o: InjectOptions = {}): Promise<LightMyRequestResponse> => {
    const spec = CONSOLE_ENDPOINTS[key];
    let path: string = spec.path;
    for (const [k, v] of Object.entries(o.params ?? {})) path = path.replace(`:${k}`, encodeURIComponent(v));
    const headers: Record<string, string> = { ...(o.headers ?? {}) };
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    if (spec.method === "POST") {
      headers["content-type"] = "application/json";
      if (o.idempotencyKey !== null) headers[IDEMPOTENCY_HEADER.toLowerCase()] = o.idempotencyKey ?? newId("idem").replace("idem_", "idemkey_");
    }
    return app.inject({ method: spec.method, url: path, headers, query: o.query, payload: spec.method === "POST" ? JSON.stringify(o.body ?? {}) : undefined });
  };

  return {
    label: HARNESS_LABEL,
    app,
    deps,
    db,
    clock,
    idp,
    directory,
    policy,
    consoleAudit,
    runtimeAudit,
    ledger,
    provider,
    outbox,
    publisher,
    dispatcher,
    workflows,
    transferStore,
    coordinator,
    telephony,
    killSwitches,
    budgets,
    knowledge,
    safety,
    releases,
    handoff,
    supportRequests,
    logs: records,
    token,
    tokenForSubject,
    call,
    staffActor: (s) => staffActorFixture(s),
    close: async () => {
      await app.close();
      await db.close();
    },
  };
}

/* ------------------------------------------------------------------------ */
/* Seed helpers (SYNTHETIC)                                                   */
/* ------------------------------------------------------------------------ */

/** Content-free session/tool audit events for a call, as the gateway and telephony control would write them. */
export async function seedCallEvents(h: ConsoleHarness, callId: string, opts: { end?: boolean; tool?: boolean; generation?: number } = {}): Promise<void> {
  const base = { tenantId: TENANT_ID, callId, sessionGeneration: opts.generation ?? 1, correlationId: newId("cor") };
  const append = (fields: Parameters<typeof buildAuditInput>[0]) => h.runtimeAudit.appendStandalone(buildAuditInput({ occurredAt: iso(h.clock.now()), ...fields }));
  await append({ ...base, sourceComponent: "telephony_control", action: SESSION_AUDIT_ACTIONS.started, outcome: "SUCCEEDED", assurance: "A0" });
  h.clock.advanceSeconds(1);
  await append({ ...base, sourceComponent: "telephony_control", action: SESSION_AUDIT_ACTIONS.consentRecorded, outcome: "SUCCEEDED", assurance: "A0" });
  h.clock.advanceSeconds(1);
  await append({ ...base, sourceComponent: "identity", action: SESSION_AUDIT_ACTIONS.verificationBound, outcome: "SUCCEEDED", assurance: "A2" });
  if (opts.tool !== false) {
    h.clock.advanceSeconds(1);
    await append({
      ...base,
      sourceComponent: "gateway",
      action: SESSION_AUDIT_ACTIONS.toolInvoke,
      outcome: "SUCCEEDED",
      assurance: "A2",
      turnId: "turn_synthTurn0001",
      evidencePointers: ["db://tool_catalog/appointment_list/1.0.0"],
      policyDecision: { decisionId: newId("pdc"), allow: true, reasonCodes: ["ALLOW_SELF_SERVICE"], policyVersion: h.policy.policyVersion },
    });
  }
  if (opts.end) {
    h.clock.advanceSeconds(1);
    await append({ ...base, sourceComponent: "telephony_control", action: SESSION_AUDIT_ACTIONS.ended, outcome: "SUCCEEDED", assurance: "A2" });
  }
}

/** A PREPARED (and optionally CONFIRMED) appointment reschedule on the given call. */
export async function seedPendingAction(h: ConsoleHarness, opts: { callId?: string; confirm?: boolean; appointmentIndex?: number } = {}): Promise<{ action: PreparedAction; sessionRef: string }> {
  const ctx = syntheticAuthContext(h.clock, opts.callId ? { callId: opts.callId } : {});
  const appt = APPOINTMENTS[opts.appointmentIndex ?? 0] ?? APPOINTMENTS[0];
  const input = rescheduleInput({ target: { system: "scheduling", recordType: "appointment", recordRef: appt.appointmentId, beforeVersion: "v1" } });
  let action = await h.ledger.prepare(ctx, input, allowDecision(h.clock));
  if (opts.confirm) action = await h.ledger.confirm(confirmationFor(action, ctx.sessionRef, h.clock), telephonyIntegration());
  return { action, sessionRef: ctx.sessionRef };
}

/** An action left UNKNOWN by an ambiguous provider failure that applied NOTHING (lookup -> NOT_FOUND). */
export async function seedUnknownAction(h: ConsoleHarness, opts: { applied?: boolean; appointmentIndex?: number } = {}): Promise<PreparedAction> {
  const ctx = syntheticAuthContext(h.clock);
  const appt = APPOINTMENTS[opts.appointmentIndex ?? 0] ?? APPOINTMENTS[0];
  const input = rescheduleInput({ target: { system: "scheduling", recordType: "appointment", recordRef: appt.appointmentId, beforeVersion: "v1" } });
  let action = await h.ledger.prepare(ctx, input, allowDecision(h.clock));
  action = await h.ledger.confirm(confirmationFor(action, ctx.sessionRef, h.clock), telephonyIntegration());
  const provider: ProviderCommitPort = opts.applied
    ? {
        currentVersion: (a) => h.provider.currentVersion(a),
        lookup: (a, k) => h.provider.lookup(a, k),
        commit: async (a, k) => {
          h.provider.injectCommitFault("timeout_after_commit");
          return h.provider.commit(a, k);
        },
      }
    : {
        currentVersion: (a) => h.provider.currentVersion(a),
        lookup: (a, k) => h.provider.lookup(a, k),
        // LOCAL TEST FIXTURE: an unexpected failure before anything reached the provider; the ledger cannot know that.
        commit: async () => {
          throw new Error("SIMULATED_AMBIGUOUS_FAILURE_FIXTURE");
        },
      };
  const receipt = await h.ledger.commit(ctx, { actionId: action.actionId, digest: action.digest }, { reauthorize: async () => allowDecision(h.clock), provider });
  if (receipt.outcome !== "UNKNOWN") throw new Error(`fixture expected UNKNOWN, got ${receipt.outcome}`);
  return action;
}

/** A dead-lettered outbox message for the tenant. */
export async function seedDeadLetter(h: ConsoleHarness): Promise<string> {
  const messageId = await h.db.tx((tx) => h.outbox.enqueue(tx, { topic: "notification.send", key: "notify:ntf_synthNotification01", payload: { notificationId: "ntf_synthNotification01" }, dedupeKey: `notify:${newId("ded")}` }), {
    role: "app_runtime",
    rls: { tenantId: TENANT_ID },
  });
  h.publisher.failMessage(messageId, 5);
  await h.dispatcher.runOnce();
  return messageId;
}

/** A workflow waiting on a human task (billing dispute: billing_specialist -> supervisor/support_agent). */
export async function seedHumanTask(h: ConsoleHarness, type: "billing_dispute_review" | "complaint_review" = "billing_dispute_review"): Promise<{ instance: WorkflowInstance; taskId: string }> {
  let w = await h.workflows.start({ tenantId: TENANT_ID, type, correlationId: newId("cor"), sourceRecordRefs: ["srq_synthSupportRequest01"], grantRef: newId("grt") });
  const system = { kind: "system" as const, ref: null };
  const path = type === "billing_dispute_review" ? ["VALIDATE", "VALIDATION_PASSED"] : ["ESCALATED"];
  for (const event of path) w = await h.workflows.signal({ tenantId: TENANT_ID, workflowId: w.workflowId, event, actor: system });
  if (w.state !== "WAITING_FOR_HUMAN") throw new Error(`fixture expected WAITING_FOR_HUMAN, got ${w.state}`);
  const task = (await h.workflows.openTasks(TENANT_ID, ["supervisor", "support_agent"])).find((t) => t.workflowId === w.workflowId);
  if (!task) throw new Error("fixture task missing");
  return { instance: w, taskId: task.taskId };
}

/** A validated safety signal with an initiated priority route (content-free safety_events rows). */
export async function seedSafetyIncident(h: ConsoleHarness, callId: string): Promise<string> {
  const incident = h.safety.begin({
    tenantId: TENANT_ID,
    callId,
    sessionGeneration: 1,
    signals: [humanInterventionSignal("en")],
    decision: { route: "SAFETY_PRIORITY_HUMAN", destinationId: "dst_safety_priority", reasonCode: "SAFETY_SIGNAL_VALIDATED" },
    locale: "en",
    afterHours: false,
  });
  await h.safety.recordValidated(incident);
  h.clock.advanceMs(400);
  await h.safety.recordRouteInitiated(incident);
  return incident.incidentId;
}

/** Inserts an authoritative break-glass grant as the separate access process would (owner role; no app role may). */
export async function insertBreakGlassGrant(h: ConsoleHarness, g: { staffId: string; approvedBy: string; grantedAt: string; expiresAt: string; justificationCode?: string }): Promise<string> {
  const grantId = newId("bgl");
  await h.db.tx(
    (tx) =>
      tx.query(
        `insert into console_break_glass_grants (grant_id, tenant_id, staff_id, approved_by, justification_code, granted_at, expires_at, recorded_at)
         values ($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz, $8::timestamptz)`,
        [grantId, TENANT_ID, g.staffId, g.approvedBy, g.justificationCode ?? "ACTIVE_SAFETY_INCIDENT", g.grantedAt, g.expiresAt, iso(h.clock.now())],
      ),
    { role: "owner" },
  );
  return grantId;
}

/** Release submissions for the loaded policy bundle and the current knowledge snapshot (as the release pipeline would record them). */
export async function seedReleases(h: ConsoleHarness): Promise<{ policyReleaseId: string; knowledgeReleaseId: string }> {
  await h.knowledge.ingest(TENANT_ID, [
    knowledgeItemFixture({ sourceId: "faq-portal-login", permittedIntents: ["portal_login_help"] }),
    knowledgeItemFixture({ sourceId: "faq-reschedule-a", permittedIntents: ["appointment_reschedule"] }),
    knowledgeItemFixture({ sourceId: "faq-reschedule-b", permittedIntents: ["appointment_reschedule"], body: "This synthetic article gives different steps to reschedule an appointment." }),
  ]);
  const snap = await h.knowledge.snapshot(TENANT_ID);
  const policyRelease = await h.releases.record(
    {
      tenantId: TENANT_ID,
      kind: "POLICY_BUNDLE",
      version: h.policy.policyVersion,
      previousVersion: null,
      digest: h.policy.bundleDigest,
      submittedBy: STAFF.deployOperator.staffId,
      submittedAt: iso(h.clock.now()),
      diff: { added: 1, removed: 0, changed: 1, entries: [{ ref: "rule.console.kill_switch", change: "CHANGED", summaryCode: "SCOPE_NARROWED" }] },
    },
    h.clock.now(),
  );
  const knowledgeRelease = await h.releases.record(
    {
      tenantId: TENANT_ID,
      kind: "KNOWLEDGE_SNAPSHOT",
      version: snap.version,
      previousVersion: null,
      digest: snap.digest,
      submittedBy: STAFF.knowledgeEditor.staffId,
      submittedAt: iso(h.clock.now()),
      diff: { added: 1, removed: 0, changed: 0, entries: [{ ref: "kb:faq-portal-login", change: "ADDED", summaryCode: "NEW_ARTICLE" }] },
    },
    h.clock.now(),
  );
  return { policyReleaseId: policyRelease.releaseId, knowledgeReleaseId: knowledgeRelease.releaseId };
}

/** An illustrative local budget with some spend (SYNTHETIC figures, not an approved budget). */
export async function seedBudget(h: ConsoleHarness): Promise<void> {
  await h.budgets.defineBudget({
    tenantId: TENANT_ID,
    environment: "local",
    cohort: "*",
    workflow: "*",
    vendor: "*",
    periodStart: "2026-10-01T00:00:00.000Z",
    periodEnd: "2026-11-01T00:00:00.000Z",
    limitUsd: 100,
    safetyReserveUsd: 20,
    meteringDelayMinutes: 60,
    approvedBy: null,
    version: "budget-fixture-v1",
    staff: staffActorFixture("supervisor"),
  });
  await h.budgets.recordSpend({ tenantId: TENANT_ID, environment: "local", vendor: "talkdesk", workflow: "appointment", cohort: "pilot", usd: 12.5, safety: false, occurredAt: h.clock.now() });
}

export const consolePath = (p: string): string => `${CONSOLE_API_BASE}${p}`;
