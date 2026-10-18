/**
 * Trusted tool pipeline (docs/ARCHITECTURE.md section 4; spec sections 7, 8, 11, 13).
 *
 * Every tool call from the untrusted conversational layer (MCP adapter or the
 * deterministic HTTP tool route) goes through exactly this sequence:
 *
 *  a. integration identity: authenticated transport identity, channel mcp_tools,
 *     same tenant and environment as this gateway;
 *  b. pinned catalogue: name + version must exist, else UNKNOWN_TOOL_VERSION;
 *  c. arguments: byte bound (definition.maxInputBytes), no server-established
 *     identity field anywhere, strict zod parse (values are never echoed);
 *  d. session: resolved server-side per sessionBinding.mode; any failure fails
 *     closed, except SAFETY_AND_HUMAN_ROUTE tools which continue without a
 *     session (SAFE-02);
 *  e. mutation fence, kill switches and admission (safety/human exempt);
 *  f. authoritative resource description + relationship facts;
 *  g. OPA decision (deny by default; a denial never blocks safety/human routes);
 *  h. tool-request idempotency for IDEMPOTENCY_KEY_REQUIRED tools;
 *  i. execution with the tool timeout, bounded retries and a per-dependency
 *     circuit breaker (safety/human routes are never behind a breaker);
 *  j. strict output validation (unexpected fields fail closed);
 *  k. policy field mask;
 *  l. speech directive completed (turn, generation, authorization) and
 *     pre-checked by the response gate;
 *  m. audit `tool.invoke` for every invocation (AUDIT_READ: before any data);
 *  n. ToolResult validated with the protocol schema;
 *  o. content-free metrics and logs.
 *
 * The pipeline never throws to the transport: every path returns a validated
 * ToolResult with a reason code. Bearer session references are never written to
 * audit, logs or metrics (the non-bearer binding ref is used instead).
 */
import { z } from "zod";
import type { RelationshipDirectory } from "../adapters/ports.js";
import type { AuditWriter } from "../audit/ports.js";
import { buildAuditInput } from "../audit/build-input.js";
import { sessionBindingRefFor } from "../identity/keys.js";
import type { Logger, Metrics } from "../observability/ports.js";
import type { KillSwitchService, KillSwitchSnapshot, AdmissionController, AdmissionClass } from "../ops/ports.js";
import { buildPolicyInput } from "../policy/input.js";
import type { PolicyKillSwitches } from "../policy/input.js";
import type { PolicyEngine } from "../policy/ports.js";
import {
  IntegrationIdentity,
  OpaqueId,
  ReasonCode,
  SpeechDirective,
  ToolRequest,
  ToolResult,
} from "../protocol/index.js";
import type {
  AuditOutcome,
  AuthContext,
  Environment,
  PolicyDecision,
  PolicyInput,
  PolicyPurpose,
  RelationshipFact,
  ToolDefinition,
  ToolSafetyClass,
  ToolStatus,
  VersionSet,
} from "../protocol/index.js";
import { CircuitBreakerRegistry } from "../resilience/circuit-breaker.js";
import { retry, retryOptionsFromToolPolicy } from "../resilience/retry.js";
import { withTimeout } from "../resilience/timeout.js";
import type { TimerPort } from "../resilience/timeout.js";
import { canonicalJson } from "../shared/canonical.js";
import type { Clock } from "../shared/clock.js";
import { iso } from "../shared/clock.js";
import { AccessDeniedError, AuditUnavailableError, ConflictError, DependencyError, PlatformError, SessionInvalidError, ValidationError } from "../shared/errors.js";
import { newId, newTurnId } from "../shared/ids.js";
import type { ResponseGate, TemplateRegistry } from "../voice/ports.js";
import { computeToolRequestHash } from "../actions/tool-idempotency.js";
import type { ReserveResult, IdempotencyScope, ToolMeta } from "../actions/tool-idempotency.js";
import { FORBIDDEN_ARGUMENT_FIELDS } from "./catalog.js";
import type { PinnedCatalog, PinnedToolEntry } from "./catalog.js";
import { applyFieldMask } from "./mask.js";
import type { ToolExecutionContext, ToolModule, ToolOutcome, SessionlessExecutionContext } from "./ports.js";
import type { BindingTransport, SessionBindingResolver } from "./session-binding.js";

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface ToolInvocation {
  /** Tool name as presented by the transport (untrusted). */
  name: unknown;
  /** Version from the HTTP route; null for MCP (the single pinned version applies). */
  version: unknown;
  /** Untrusted arguments. */
  arguments: unknown;
  /** Turn id from the trusted transport binding; minted when absent. */
  turnId?: unknown;
  /** Idempotency key from the transport (Idempotency-Key header or MCP request _meta). */
  idempotencyKey?: unknown;
  /** Locale for the speech pre-check (xx-YY); defaults to the gateway default. */
  locale?: unknown;
}

export interface TransportContext extends BindingTransport {
  kind: "mcp" | "http";
}

/** Subset of ToolRequestIdempotency the pipeline uses (actions module). */
export interface ToolIdempotencyStore {
  reserve(scope: IdempotencyScope, key: string, requestHash: string, meta: ToolMeta): Promise<ReserveResult>;
  complete(scope: IdempotencyScope, key: string, requestHash: string, response: Record<string, unknown>): Promise<void>;
  release(scope: IdempotencyScope, key: string, requestHash: string): Promise<void>;
}

export interface ToolRouting {
  /** Intent id used by INTENT kill switches and admission (policy catalogue `intent`). */
  intentFor(def: ToolDefinition): string | null;
  /** Dependency id for the circuit breaker and metrics (policy catalogue `integrations[0]`). */
  dependencyFor(def: ToolDefinition): string;
}

export interface ToolPipelineDeps {
  tenantId: string;
  environment: Environment;
  clock: Clock;
  logger: Logger;
  metrics: Metrics;
  catalog: PinnedCatalog;
  binding: SessionBindingResolver;
  killSwitches: KillSwitchService;
  /** Admission control per request (budgets, load shedding, kill switches); null disables it (tests only). */
  admission: AdmissionController | null;
  policy: PolicyEngine;
  relationships: RelationshipDirectory;
  idempotency: ToolIdempotencyStore;
  audit: AuditWriter;
  breakers: CircuitBreakerRegistry;
  /** Response gate WITHOUT a turn tracker (turn currency is checked again at render time by the speech layer). */
  speechPrecheck: ResponseGate;
  templates: TemplateRegistry;
  versions: VersionSet;
  localFixture: boolean;
  routing?: ToolRouting;
  defaultLocale?: string;
  /** VSP_MUTATIONS_ENABLED: false fences every PREPARE/COMMIT tool (regional write fence). */
  mutationsEnabled?: boolean;
  /** Channels allowed to invoke tools (default mcp_tools only). */
  allowedChannels?: readonly IntegrationIdentity["channel"][];
  cohort?: string;
  timers?: TimerPort;
  retrySleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
}

// ---------------------------------------------------------------------------
// Reason codes
// ---------------------------------------------------------------------------

export const PIPELINE_REASON = {
  INTEGRATION_NOT_PERMITTED: "INTEGRATION_NOT_PERMITTED",
  UNKNOWN_TOOL_VERSION: "UNKNOWN_TOOL_VERSION",
  INVALID_ARGUMENTS: "INVALID_ARGUMENTS",
  ARGUMENTS_TOO_LARGE: "ARGUMENTS_TOO_LARGE",
  IDENTITY_FIELD_IN_ARGUMENTS: "IDENTITY_FIELD_IN_ARGUMENTS",
  MUTATIONS_FENCED: "MUTATIONS_FENCED",
  POLICY_INPUT_INVALID: "POLICY_INPUT_INVALID",
  POLICY_ENGINE_ERROR: "POLICY_ENGINE_ERROR",
  RESOURCE_UNRESOLVED: "RESOURCE_UNRESOLVED",
  RELATIONSHIPS_UNAVAILABLE: "RELATIONSHIPS_UNAVAILABLE",
  IDEMPOTENCY_KEY_REQUIRED: "IDEMPOTENCY_KEY_REQUIRED",
  IDEMPOTENCY_KEY_REUSED: "IDEMPOTENCY_KEY_REUSED",
  IDEMPOTENCY_IN_PROGRESS: "IDEMPOTENCY_IN_PROGRESS",
  IDEMPOTENCY_STORE_UNAVAILABLE: "IDEMPOTENCY_STORE_UNAVAILABLE",
  IDEMPOTENT_REPLAY: "IDEMPOTENT_REPLAY",
  OUTPUT_SCHEMA_VIOLATION: "OUTPUT_SCHEMA_VIOLATION",
  AUDIT_UNAVAILABLE: "AUDIT_UNAVAILABLE",
  SESSIONLESS_ROUTE_UNSUPPORTED: "SESSIONLESS_ROUTE_UNSUPPORTED",
  TOOL_RESULT_INVALID: "TOOL_RESULT_INVALID",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  KILL_SWITCH_STATE_UNAVAILABLE: "KILL_SWITCH_STATE_UNAVAILABLE",
  SPEECH_PRECHECK_FAILED: "SPEECH_PRECHECK_FAILED",
} as const;

const UNKNOWN_TOOL = { name: "unknown_tool", version: "0.0.0" } as const;
const TURN_ID = /^turn_[A-Za-z0-9_-]{4,64}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,128}$/;
const LOCALE = /^[a-z]{2}-[A-Z]{2}$/;
const FALLBACK_TEMPLATE_ID = "fallback.safe_explanation";
const FORBIDDEN = new Set(FORBIDDEN_ARGUMENT_FIELDS);
const FAIL_CLOSED_SWITCHES: KillSwitchSnapshot = {
  aiAdmission: true,
  writes: true,
  outboundNotifications: true,
  intents: [],
  integrations: [],
  modelVersions: [],
  voiceVersions: [],
};

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

/** Recursively finds a forbidden (server-established) key anywhere in the arguments. */
export function containsForbiddenField(value: unknown, depth = 0): boolean {
  if (depth > 32) return true; // pathological nesting fails closed
  if (Array.isArray(value)) return value.some((v) => containsForbiddenField(v, depth + 1));
  if (typeof value === "object" && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN.has(k)) return true;
      if (containsForbiddenField(v, depth + 1)) return true;
    }
  }
  return false;
}

const safeReason = (code: unknown, fallback: string): string => (typeof code === "string" && ReasonCode.safeParse(code).success && !/\d{4,}/.test(code) ? code : fallback);

function admissionClassFor(c: ToolSafetyClass): AdmissionClass {
  switch (c) {
    case "SAFETY_AND_HUMAN_ROUTE":
      return "SAFETY";
    case "PUBLIC_READ":
    case "INTAKE":
      return "PUBLIC";
    case "PROTECTED_READ":
      return "PROTECTED_READ";
    case "PREPARE_MUTATION":
    case "COMMIT_MUTATION":
      return "WRITE";
  }
}

const AUDIT_OUTCOME: Record<ToolStatus, AuditOutcome> = {
  SUCCESS: "SUCCEEDED",
  PENDING: "PENDING",
  POLICY_DENIED: "DENIED",
  PERMANENT_FAILURE: "FAILED",
  RETRYABLE_FAILURE: "FAILED",
  UNKNOWN_OUTCOME: "UNKNOWN",
};

type Outcome = ToolOutcome<unknown>;

interface InvocationState {
  requestId: string;
  turnId: string;
  receivedAt: string;
  startedMs: number;
  transport: TransportContext;
  integration: IntegrationIdentity | null;
  entry: PinnedToolEntry | null;
  ctx: AuthContext | null;
  /** Non-bearer binding ref for audit (never the bearer). */
  bindingRef: string | null;
  /** When no session resolved: the call id from the trusted transport binding (audit evidence only, never authority). */
  transportCallId: string | null;
  decision: PolicyDecision | null;
  obligations: Set<string>;
  idempotencyKey: string | null;
  evidence: string[];
  auditReason: string | null;
  locale: string;
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export class ToolPipeline {
  private readonly deps: ToolPipelineDeps;
  private readonly allowedChannels: readonly IntegrationIdentity["channel"][];
  private readonly defaultLocale: string;

  constructor(deps: ToolPipelineDeps) {
    this.deps = deps;
    this.allowedChannels = deps.allowedChannels ?? ["mcp_tools"];
    this.defaultLocale = deps.defaultLocale ?? "en-US";
  }

  get catalog(): PinnedCatalog {
    return this.deps.catalog;
  }

  async invoke(inv: ToolInvocation, integration: IntegrationIdentity, transport: TransportContext): Promise<ToolResult> {
    const now = this.deps.clock.now();
    const st: InvocationState = {
      requestId: newId("req"),
      turnId: typeof inv?.turnId === "string" && TURN_ID.test(inv.turnId) ? inv.turnId : newTurnId(),
      receivedAt: iso(now),
      startedMs: now.getTime(),
      transport,
      integration: null,
      entry: null,
      ctx: null,
      bindingRef: null,
      transportCallId: null,
      decision: null,
      obligations: new Set(),
      idempotencyKey: typeof inv?.idempotencyKey === "string" && IDEMPOTENCY_KEY.test(inv.idempotencyKey) ? inv.idempotencyKey : null,
      evidence: [],
      auditReason: null,
      locale: typeof inv?.locale === "string" && LOCALE.test(inv.locale) ? inv.locale : this.defaultLocale,
    };
    try {
      return await this.run(inv, integration, st);
    } catch (err) {
      // Defensive: no exception ever reaches the transport (fail closed, reason code only).
      this.deps.logger.error("gateway.pipeline.unexpected_error", { reasonCode: err instanceof PlatformError ? err.reasonCode : "UNCLASSIFIED_ERROR", requestId: st.requestId });
      return this.finish(st, { status: "PERMANENT_FAILURE", reasonCode: PIPELINE_REASON.INTERNAL_ERROR }, null, null);
    }
  }

  private async run(inv: ToolInvocation, integration: IntegrationIdentity, st: InvocationState): Promise<ToolResult> {
    const d = this.deps;

    // (a) integration identity -------------------------------------------------
    const integ = IntegrationIdentity.safeParse(integration);
    if (!integ.success || !this.allowedChannels.includes(integ.data.channel) || integ.data.tenantId !== d.tenantId || integ.data.environment !== d.environment) {
      return this.finish(st, { status: "POLICY_DENIED", reasonCode: PIPELINE_REASON.INTEGRATION_NOT_PERMITTED }, null, null);
    }
    st.integration = integ.data;

    // (b) pinned catalogue -----------------------------------------------------
    const name = typeof inv?.name === "string" ? inv.name : null;
    const version = inv?.version === null || inv?.version === undefined ? (name ? d.catalog.pinnedVersion(name) : null) : typeof inv.version === "string" ? inv.version : null;
    const entry = name && version ? d.catalog.get(name, version) : null;
    if (!entry) return this.finish(st, { status: "PERMANENT_FAILURE", reasonCode: PIPELINE_REASON.UNKNOWN_TOOL_VERSION }, null, null);
    st.entry = entry;
    st.evidence.push(`db://tool_catalog/${entry.definition.name}/${entry.definition.version}`);
    const def = entry.definition;
    const module = entry.module as ToolModule<unknown, unknown>;
    const isSafety = def.safetyClass === "SAFETY_AND_HUMAN_ROUTE";

    // (c) argument bound, forbidden identity fields, strict schema -----------------------
    if (!isPlainObject(inv.arguments)) return this.finish(st, { status: "PERMANENT_FAILURE", reasonCode: PIPELINE_REASON.INVALID_ARGUMENTS }, null, null);
    let bytes: number;
    try {
      bytes = Buffer.byteLength(JSON.stringify(inv.arguments), "utf8");
    } catch {
      return this.finish(st, { status: "PERMANENT_FAILURE", reasonCode: PIPELINE_REASON.INVALID_ARGUMENTS }, null, null);
    }
    if (bytes > def.maxInputBytes) return this.finish(st, { status: "PERMANENT_FAILURE", reasonCode: PIPELINE_REASON.ARGUMENTS_TOO_LARGE }, null, null);
    const args: Record<string, unknown> = { ...inv.arguments };
    let argumentSessionRef: string | null = null;
    if (d.binding.readsArgumentSessionRef && Object.hasOwn(args, "sessionRef")) {
      argumentSessionRef = typeof args.sessionRef === "string" ? args.sessionRef : null;
      delete args.sessionRef;
    }
    if (containsForbiddenField(args)) return this.finish(st, { status: "PERMANENT_FAILURE", reasonCode: PIPELINE_REASON.IDENTITY_FIELD_IN_ARGUMENTS }, null, null);
    const parsedInput = module.input.safeParse(args);
    if (!parsedInput.success) return this.finish(st, { status: "PERMANENT_FAILURE", reasonCode: PIPELINE_REASON.INVALID_ARGUMENTS }, null, null);
    const input = parsedInput.data;

    // (d) session ------------------------------------------------------------
    const bound = await d.binding.resolve(st.transport, integ.data, argumentSessionRef);
    let sessionRef: string | null;
    if (bound.ok) {
      st.ctx = bound.ctx;
      sessionRef = bound.sessionRef;
      st.bindingRef = sessionBindingRefFor(bound.sessionRef);
    } else {
      st.bindingRef = bindingRefOrNull(bound.sessionRef);
      st.transportCallId = bound.callId;
      if (!isSafety) {
        return this.finish(st, bound.retryable ? { status: "RETRYABLE_FAILURE", reasonCode: bound.reasonCode, retryAfterMs: 1000 } : { status: "POLICY_DENIED", reasonCode: bound.reasonCode }, null, null);
      }
      // SAFE-02: safety routing and human requests never require a session.
      return this.runSessionless(st, entry, module, input, args, bound.reasonCode, bound.callId);
    }
    const ctx = bound.ctx;

    const request = this.toolRequest(st, def, args, sessionRef);
    if (!request) return this.finish(st, { status: "PERMANENT_FAILURE", reasonCode: PIPELINE_REASON.INVALID_ARGUMENTS }, null, null);

    // (e) mutation fence, kill switches, admission (safety/human exempt) --------------------
    let switches: PolicyKillSwitches = { aiAdmission: false, writes: false, intents: [], integrations: [] };
    if (!isSafety) {
      if (d.mutationsEnabled === false && (def.safetyClass === "PREPARE_MUTATION" || def.safetyClass === "COMMIT_MUTATION")) {
        return this.finish(st, { status: "POLICY_DENIED", reasonCode: PIPELINE_REASON.MUTATIONS_FENCED }, null, null);
      }
      let snapshot: KillSwitchSnapshot;
      let unreadable = false;
      try {
        snapshot = await d.killSwitches.snapshot(d.tenantId);
      } catch {
        snapshot = FAIL_CLOSED_SWITCHES;
        unreadable = true;
      }
      const modelKilled = snapshot.modelVersions.includes(d.versions.model);
      const voiceKilled = snapshot.voiceVersions.includes(d.versions.voice);
      // AI_ADMISSION itself is enforced at call start (new sessions only); in flight, a killed
      // model or voice version stops automation (policy denies every non-exempt action). An
      // unreadable switch state fails closed to "all automation stopped".
      switches = { aiAdmission: unreadable || modelKilled || voiceKilled, writes: snapshot.writes, intents: snapshot.intents, integrations: snapshot.integrations };
      if (d.admission) {
        let decision;
        try {
          decision = await d.admission.admit({
            tenantId: d.tenantId,
            class: admissionClassFor(def.safetyClass),
            vendor: integ.data.integrationId,
            workflow: d.routing?.intentFor(def) ?? null,
            cohort: d.cohort ?? "default",
            modelVersion: d.versions.model,
            voiceVersion: d.versions.voice,
          });
        } catch {
          decision = { admitted: false, continuity: "HUMAN_QUEUE" as const, reasonCode: "ADMISSION_UNAVAILABLE" };
        }
        if (!decision.admitted) return this.finish(st, { status: "POLICY_DENIED", reasonCode: safeReason(decision.reasonCode, "ADMISSION_REFUSED") }, null, null);
      }
    }

    // (f) authoritative resource + relationship facts --------------------------------------
    let resource: PolicyInput["resource"];
    try {
      resource = await withTimeout(def.timeoutMs, () => module.resolveResource(ctx, input), {
        dependency: this.dependency(def),
        idempotent: true,
        timers: d.timers,
        metrics: d.metrics,
      });
    } catch (err) {
      if (isSafety) resource = sessionlessResource(d.tenantId, def);
      else return this.finish(st, this.outcomeFromError(err, def, st, PIPELINE_REASON.RESOURCE_UNRESOLVED, false), null, null);
    }
    let relationships: RelationshipFact[] = [];
    if (ctx.actorId && ctx.selectedRole) {
      try {
        relationships = await d.relationships.relationshipsFor(ctx.actorId, ctx.selectedRole);
      } catch (err) {
        if (!isSafety) {
          const retryable = err instanceof DependencyError && err.outcome === "NOT_STARTED";
          return this.finish(st, retryable ? { status: "RETRYABLE_FAILURE", reasonCode: PIPELINE_REASON.RELATIONSHIPS_UNAVAILABLE, retryAfterMs: 1000 } : { status: "POLICY_DENIED", reasonCode: PIPELINE_REASON.RELATIONSHIPS_UNAVAILABLE }, null, null);
        }
      }
    }

    // (g) policy ----------------------------------------------------------------
    let purpose: PolicyPurpose;
    try {
      purpose = module.purpose(ctx, input);
    } catch {
      purpose = isSafety ? safetyPurpose(def) : "caller_self_service";
    }
    const verdict = await this.decideAll(def, { auth: ctx, tenantId: d.tenantId, purpose, resource, relationships, switches });
    st.decision = verdict.primary;
    for (const o of verdict.obligations) st.obligations.add(o);
    if (verdict.primary) st.evidence.push(`decision:${verdict.primary.decisionId}`);
    if (!verdict.allow && !isSafety) return this.finish(st, { status: "POLICY_DENIED", reasonCode: verdict.reasonCode }, null, null);

    // (h) idempotency -----------------------------------------------------------------
    const idem = await this.reserveIdempotency(st, def, input, isSafety);
    if (idem.kind === "result") return idem.result;

    // (i) execute -----------------------------------------------------------------
    const execCtx: ToolExecutionContext = { auth: ctx, request, decision: verdict.primary ?? denyPlaceholder(d.clock.now()), now: d.clock.now() };
    let outcome: Outcome;
    try {
      outcome = await this.execute(def, isSafety, () => module.execute(execCtx, input));
    } catch (err) {
      outcome = this.outcomeFromError(err, def, st, "DEPENDENCY_FAILED", true);
    }

    // (j)-(n)
    const fieldMask = verdict.allow && verdict.primary ? verdict.primary.fieldMask : [];
    const result = await this.complete(st, entry, module, outcome, fieldMask);
    await this.settleIdempotency(idem, result);
    return result;
  }

  /** SAFE-02 path: SAFETY_AND_HUMAN_ROUTE tool without a resolvable session. */
  private async runSessionless(
    st: InvocationState,
    entry: PinnedToolEntry,
    module: ToolModule<unknown, unknown>,
    input: unknown,
    args: Record<string, unknown>,
    sessionReasonCode: string,
    callId: string | null,
  ): Promise<ToolResult> {
    const d = this.deps;
    const def = entry.definition;
    st.auditReason = sessionReasonCode;
    const request = this.toolRequest(st, def, args, null);
    if (!request || !st.integration) return this.finish(st, { status: "PERMANENT_FAILURE", reasonCode: PIPELINE_REASON.INVALID_ARGUMENTS }, null, null);
    // The decision is recorded for evidence and the field mask; the route never depends on it.
    const verdict = await this.decideAll(def, {
      auth: null,
      tenantId: d.tenantId,
      purpose: safetyPurpose(def),
      resource: sessionlessResource(d.tenantId, def),
      relationships: [],
      switches: { aiAdmission: false, writes: false, intents: [], integrations: [] },
    });
    st.decision = verdict.primary;
    if (verdict.primary) st.evidence.push(`decision:${verdict.primary.decisionId}`);
    if (typeof module.executeWithoutSession !== "function") {
      return this.finish(st, { status: "PERMANENT_FAILURE", reasonCode: PIPELINE_REASON.SESSIONLESS_ROUTE_UNSUPPORTED }, null, null);
    }
    const idem = await this.reserveIdempotency(st, def, input, true);
    if (idem.kind === "result") return idem.result;
    const ctx: SessionlessExecutionContext = {
      auth: null,
      tenantId: d.tenantId,
      integration: st.integration,
      callId,
      request,
      decision: verdict.allow ? verdict.primary : null,
      sessionReasonCode,
      now: d.clock.now(),
    };
    let outcome: Outcome;
    try {
      const run = module.executeWithoutSession.bind(module);
      outcome = await this.execute(def, true, () => run(ctx, input));
    } catch (err) {
      outcome = this.outcomeFromError(err, def, st, "DEPENDENCY_FAILED", true);
    }
    const fieldMask = verdict.allow && verdict.primary ? verdict.primary.fieldMask : [];
    const result = await this.complete(st, entry, module, outcome, fieldMask);
    await this.settleIdempotency(idem, result);
    return result;
  }

  // -------------------------------------------------------------------------
  // Steps
  // -------------------------------------------------------------------------

  private toolRequest(st: InvocationState, def: ToolDefinition, args: Record<string, unknown>, sessionRef: string | null): ToolRequest | null {
    const r = ToolRequest.safeParse({
      requestId: st.requestId,
      tool: { name: def.name, version: def.version },
      sessionRef,
      turnId: st.turnId,
      arguments: args,
      idempotencyKey: st.idempotencyKey,
      receivedAt: st.receivedAt,
    });
    return r.success ? r.data : null;
  }

  private dependency(def: ToolDefinition): string {
    return this.deps.routing?.dependencyFor(def) ?? def.name;
  }

  private async decideAll(
    def: ToolDefinition,
    args: { auth: AuthContext | null; tenantId: string; purpose: PolicyPurpose; resource: PolicyInput["resource"]; relationships: RelationshipFact[]; switches: PolicyKillSwitches },
  ): Promise<{ allow: boolean; primary: PolicyDecision | null; reasonCode: string; obligations: string[] }> {
    const decisions: PolicyDecision[] = [];
    for (const action of def.permissions) {
      let input: PolicyInput;
      try {
        input = buildPolicyInput({
          auth: args.auth,
          tenantId: args.tenantId,
          action,
          purpose: args.purpose,
          tool: def,
          resource: args.resource,
          relationships: args.relationships,
          killSwitches: args.switches,
          environment: this.deps.environment,
          now: this.deps.clock.now(),
        });
      } catch {
        return { allow: false, primary: decisions[0] ?? null, reasonCode: PIPELINE_REASON.POLICY_INPUT_INVALID, obligations: [] };
      }
      let decision: PolicyDecision;
      try {
        decision = await this.deps.policy.decide(input);
      } catch {
        return { allow: false, primary: decisions[0] ?? null, reasonCode: PIPELINE_REASON.POLICY_ENGINE_ERROR, obligations: [] };
      }
      if (!decision || typeof decision.allow !== "boolean" || !OpaqueId.safeParse(decision.decisionId).success) {
        return { allow: false, primary: decisions[0] ?? null, reasonCode: PIPELINE_REASON.POLICY_ENGINE_ERROR, obligations: [] };
      }
      decisions.push(decision);
      if (!decision.allow) {
        return { allow: false, primary: decisions[0] ?? decision, reasonCode: safeReason(decision.reasonCodes[0], "POLICY_DENIED"), obligations: decision.obligations };
      }
    }
    const obligations = [...new Set(decisions.flatMap((x) => x.obligations))];
    return { allow: decisions.length > 0, primary: decisions[0] ?? null, reasonCode: "ALLOWED", obligations };
  }

  private async reserveIdempotency(
    st: InvocationState,
    def: ToolDefinition,
    input: unknown,
    isSafety: boolean,
  ): Promise<{ kind: "none" } | { kind: "reserved"; scope: IdempotencyScope; key: string; hash: string } | { kind: "result"; result: ToolResult }> {
    const d = this.deps;
    const required = def.idempotency === "IDEMPOTENCY_KEY_REQUIRED";
    if (!st.idempotencyKey) {
      if (required && !isSafety) return { kind: "result", result: await this.finish(st, { status: "PERMANENT_FAILURE", reasonCode: PIPELINE_REASON.IDEMPOTENCY_KEY_REQUIRED }, null, null) };
      return { kind: "none" };
    }
    if (!required && !isSafety) return { kind: "none" };
    if (!st.integration) return { kind: "none" };
    const scope: IdempotencyScope = { tenantId: d.tenantId, integrationId: st.integration.integrationId };
    let hash: string;
    try {
      hash = computeToolRequestHash({
        toolName: def.name,
        toolVersion: def.version,
        arguments: JSON.parse(canonicalJson(input)) as Record<string, unknown>,
        sessionBinding: st.bindingRef,
      });
    } catch {
      return { kind: "result", result: await this.finish(st, { status: "PERMANENT_FAILURE", reasonCode: PIPELINE_REASON.INVALID_ARGUMENTS }, null, null) };
    }
    let reserved: ReserveResult;
    try {
      reserved = await d.idempotency.reserve(scope, st.idempotencyKey, hash, { toolName: def.name, toolVersion: def.version });
    } catch (err) {
      if (err instanceof ConflictError && err.reasonCode === "IDEMPOTENCY_KEY_REUSED") {
        return { kind: "result", result: await this.finish(st, { status: "PERMANENT_FAILURE", reasonCode: PIPELINE_REASON.IDEMPOTENCY_KEY_REUSED }, null, null) };
      }
      if (isSafety) return { kind: "none" }; // never block a safety or human route on the replay cache
      return { kind: "result", result: await this.finish(st, { status: "RETRYABLE_FAILURE", reasonCode: PIPELINE_REASON.IDEMPOTENCY_STORE_UNAVAILABLE, retryAfterMs: 1000 }, null, null) };
    }
    if (reserved.status === "IN_PROGRESS") {
      return { kind: "result", result: await this.finish(st, { status: "RETRYABLE_FAILURE", reasonCode: PIPELINE_REASON.IDEMPOTENCY_IN_PROGRESS, retryAfterMs: 1000 }, null, null) };
    }
    if (reserved.status === "REPLAY") {
      const stored = ToolResult.safeParse(reserved.response);
      if (stored.success) {
        st.auditReason = PIPELINE_REASON.IDEMPOTENT_REPLAY;
        await this.appendAudit(st, stored.data.status, PIPELINE_REASON.IDEMPOTENT_REPLAY, false);
        this.observe(st, stored.data.status, PIPELINE_REASON.IDEMPOTENT_REPLAY);
        return { kind: "result", result: stored.data };
      }
      return { kind: "result", result: await this.finish(st, { status: "PERMANENT_FAILURE", reasonCode: PIPELINE_REASON.TOOL_RESULT_INVALID }, null, null) };
    }
    return { kind: "reserved", scope, key: st.idempotencyKey, hash };
  }

  private async settleIdempotency(idem: { kind: string; scope?: IdempotencyScope; key?: string; hash?: string }, result: ToolResult): Promise<void> {
    if (idem.kind !== "reserved" || !idem.scope || !idem.key || !idem.hash) return;
    try {
      if (result.status === "RETRYABLE_FAILURE") await this.deps.idempotency.release(idem.scope, idem.key, idem.hash);
      else await this.deps.idempotency.complete(idem.scope, idem.key, idem.hash, result as unknown as Record<string, unknown>);
    } catch (err) {
      // The effect (if any) already happened; a lost replay record only means a retry re-executes,
      // which consequential tools absorb through the action ledger (ACT-02).
      this.deps.logger.warn("gateway.idempotency.settle_failed", { reasonCode: err instanceof PlatformError ? err.reasonCode : "UNCLASSIFIED_ERROR", requestId: result.requestId });
    }
  }

  private async execute(def: ToolDefinition, isSafety: boolean, op: () => Promise<Outcome>): Promise<Outcome> {
    const d = this.deps;
    const dependency = this.dependency(def);
    const timed = () =>
      withTimeout(def.timeoutMs, () => op(), {
        dependency,
        idempotent: !def.consequential && def.idempotency === "NATURALLY_IDEMPOTENT",
        timers: d.timers,
        metrics: d.metrics,
      });
    // Safety and human routing is never placed behind a breaker whose opening would block it (OPS-02).
    const once = isSafety ? timed : () => d.breakers.get(dependency).execute(timed);
    if (isSafety || def.retryPolicy.maxAttempts <= 1) return once();
    return retry(() => once(), retryOptionsFromToolPolicy(def.retryPolicy, dependency, { metrics: d.metrics, ...(d.retrySleep ? { sleep: d.retrySleep } : {}), ...(d.random ? { random: d.random } : {}) }));
  }

  /** Maps a thrown error to a ToolOutcome (DependencyError NOT_STARTED/UNKNOWN/FAILED semantics, ACT-03). */
  private outcomeFromError(err: unknown, def: ToolDefinition, st: InvocationState, fallback: string, executed: boolean): Outcome {
    if (err instanceof DependencyError) {
      const reasonCode = safeReason(err.reasonCode, fallback);
      if (err.outcome === "NOT_STARTED") {
        const after = (err as { retryAfterMs?: unknown }).retryAfterMs;
        return { status: "RETRYABLE_FAILURE", reasonCode, retryAfterMs: typeof after === "number" && after >= 0 && after <= 60_000 ? Math.floor(after) : 1000 };
      }
      if (err.outcome === "UNKNOWN") {
        if (!executed || !def.consequential) return { status: "RETRYABLE_FAILURE", reasonCode, retryAfterMs: 1000 };
        return { status: "UNKNOWN_OUTCOME", reasonCode, reconciliationRef: st.requestId };
      }
      // FAILED: a definite failure. Retryable only when the dependency explicitly said so.
      return err.retryable ? { status: "RETRYABLE_FAILURE", reasonCode, retryAfterMs: 1000 } : { status: "PERMANENT_FAILURE", reasonCode };
    }
    if (err instanceof AuditUnavailableError) return { status: "RETRYABLE_FAILURE", reasonCode: PIPELINE_REASON.AUDIT_UNAVAILABLE, retryAfterMs: 5000 };
    if (err instanceof SessionInvalidError || err instanceof AccessDeniedError) return { status: "POLICY_DENIED", reasonCode: safeReason(err.reasonCode, "ACCESS_DENIED") };
    if (err instanceof ConflictError) {
      return err.retryable ? { status: "RETRYABLE_FAILURE", reasonCode: safeReason(err.reasonCode, "CONFLICT"), retryAfterMs: 1000 } : { status: "PERMANENT_FAILURE", reasonCode: safeReason(err.reasonCode, "CONFLICT") };
    }
    if (err instanceof ValidationError) return { status: "PERMANENT_FAILURE", reasonCode: safeReason(err.reasonCode, PIPELINE_REASON.INVALID_ARGUMENTS) };
    if (err instanceof PlatformError) {
      return err.retryable ? { status: "RETRYABLE_FAILURE", reasonCode: safeReason(err.reasonCode, fallback), retryAfterMs: 1000 } : { status: "PERMANENT_FAILURE", reasonCode: safeReason(err.reasonCode, fallback) };
    }
    // Unclassified: an executed consequential operation may have had an effect (ACT-03).
    if (executed && def.consequential) return { status: "UNKNOWN_OUTCOME", reasonCode: "UNCLASSIFIED_ERROR", reconciliationRef: st.requestId };
    return { status: "PERMANENT_FAILURE", reasonCode: PIPELINE_REASON.INTERNAL_ERROR };
  }

  /** (j) output validation, (k) mask, (l) speech, then (m)-(o). */
  private async complete(st: InvocationState, entry: PinnedToolEntry, module: ToolModule<unknown, unknown>, outcome: Outcome, fieldMask: readonly string[]): Promise<ToolResult> {
    const def = entry.definition;
    if (outcome.status !== "SUCCESS" && outcome.status !== "PENDING") return this.finish(st, sanitizeFailure(outcome, st), null, null);
    const out = module.output.safeParse(outcome.data);
    if (!out.success || !isPlainObject(out.data)) {
      // Unexpected or missing fields fail closed. A consequential effect may already exist, so it is reported as unknown.
      return this.finish(
        st,
        def.consequential
          ? { status: "UNKNOWN_OUTCOME", reasonCode: PIPELINE_REASON.OUTPUT_SCHEMA_VIOLATION, reconciliationRef: st.requestId }
          : { status: "PERMANENT_FAILURE", reasonCode: PIPELINE_REASON.OUTPUT_SCHEMA_VIOLATION },
        null,
        null,
      );
    }
    if (outcome.status === "PENDING" && (!OpaqueId.safeParse(outcome.pendingRef).success || !ReasonCode.safeParse(outcome.reasonCode).success)) {
      return this.finish(st, { status: "PERMANENT_FAILURE", reasonCode: PIPELINE_REASON.TOOL_RESULT_INVALID }, null, null);
    }
    const masked = applyFieldMask(out.data, fieldMask, module.maskTarget);
    const speech = this.completeSpeech(st, outcome.speech);
    if (outcome.status === "PENDING") st.evidence.push(`pending:${outcome.pendingRef}`);
    return this.finish(st, outcome.status === "PENDING" ? { ...outcome, data: masked } : { status: "SUCCESS", data: masked, speech: null }, masked, speech);
  }

  private completeSpeech(st: InvocationState, partial: Exclude<Outcome, { status: "RETRYABLE_FAILURE" | "PERMANENT_FAILURE" | "POLICY_DENIED" | "UNKNOWN_OUTCOME" }>["speech"]): SpeechDirective | null {
    // Without a trusted session there is no generation to bind speech to; Studio plays the fixed route prompt.
    if (!partial || !st.ctx) return null;
    const d = this.deps;
    const locale = st.locale;
    const authorizationRef = st.decision?.allow ? st.decision.decisionId : null;
    const directive = SpeechDirective.safeParse({ ...partial, turnId: st.turnId, sessionGeneration: st.ctx.sessionGeneration, authorizationRef });
    if (directive.success) {
      const gate = d.speechPrecheck.render(directive.data, {
        sessionRef: st.bindingRef ?? "ses_bnd_unbound",
        currentTurnId: st.turnId,
        sessionGeneration: st.ctx.sessionGeneration,
        validAuthorizationRefs: new Set(authorizationRef ? [authorizationRef] : []),
        locale,
        environment: d.environment,
      });
      if (gate.ok) return directive.data;
    }
    d.logger.warn("gateway.speech.precheck_failed", { reasonCode: PIPELINE_REASON.SPEECH_PRECHECK_FAILED, requestId: st.requestId });
    // Fail closed to the approved safe explanation (dependency or model text is never spoken).
    const fb = d.templates.get(FALLBACK_TEMPLATE_ID, locale);
    if (!fb) return null;
    const fallback = SpeechDirective.safeParse({
      templateId: fb.templateId,
      templateVersion: fb.version,
      responseClass: fb.responseClass,
      slots: {},
      authorizationRef: null,
      sourceRefs: [],
      turnId: st.turnId,
      sessionGeneration: st.ctx.sessionGeneration,
    });
    return fallback.success ? fallback.data : null;
  }

  /** (m) audit, (n) result validation, (o) metrics. */
  private async finish(st: InvocationState, outcome: Outcome, data: Record<string, unknown> | null, speech: SpeechDirective | null): Promise<ToolResult> {
    const tool = st.entry ? { name: st.entry.definition.name, version: st.entry.definition.version } : { ...UNKNOWN_TOOL };
    const reasonCode = "reasonCode" in outcome ? outcome.reasonCode : null;
    const auditReadRequired = st.obligations.has("AUDIT_READ") && (outcome.status === "SUCCESS" || outcome.status === "PENDING");
    const isSafety = st.entry?.definition.safetyClass === "SAFETY_AND_HUMAN_ROUTE";
    const auditEventId = await this.appendAudit(st, outcome.status, st.auditReason ?? reasonCode, auditReadRequired && !isSafety);
    if (auditReadRequired && !isSafety && auditEventId === null) {
      // AUDIT_READ: the disclosure must be durably recorded before any data is returned.
      const blocked: Outcome = { status: "RETRYABLE_FAILURE", reasonCode: PIPELINE_REASON.AUDIT_UNAVAILABLE, retryAfterMs: 5000 };
      return this.build(st, tool, blocked, null, null, null);
    }
    return this.build(st, tool, outcome, data, speech, auditEventId);
  }

  private build(st: InvocationState, tool: { name: string; version: string }, outcome: Outcome, data: Record<string, unknown> | null, speech: SpeechDirective | null, auditEventId: string | null): ToolResult {
    const d = this.deps;
    const base = {
      requestId: st.requestId,
      tool,
      turnId: st.turnId,
      sessionGeneration: st.ctx?.sessionGeneration ?? 0,
      completedAt: iso(d.clock.now()),
      auditEventId,
      policyDecisionId: st.decision?.decisionId ?? null,
      speech,
      localFixture: d.localFixture,
    };
    let candidate: unknown;
    switch (outcome.status) {
      case "SUCCESS":
        candidate = { ...base, status: "SUCCESS", data: data ?? {} };
        break;
      case "PENDING":
        candidate = { ...base, status: "PENDING", reasonCode: outcome.reasonCode, pendingRef: outcome.pendingRef, data: data ?? {} };
        break;
      case "RETRYABLE_FAILURE":
        candidate = { ...base, speech: null, status: "RETRYABLE_FAILURE", reasonCode: outcome.reasonCode, retryAfterMs: Math.max(0, Math.min(60_000, Math.floor(outcome.retryAfterMs))) };
        break;
      case "UNKNOWN_OUTCOME":
        candidate = { ...base, speech: null, status: "UNKNOWN_OUTCOME", reasonCode: outcome.reasonCode, reconciliationRef: outcome.reconciliationRef };
        break;
      default:
        candidate = { ...base, speech: null, status: outcome.status, reasonCode: outcome.reasonCode };
    }
    const parsed = ToolResult.safeParse(candidate);
    const result: ToolResult = parsed.success
      ? parsed.data
      : ToolResult.parse({ ...base, speech: null, status: "PERMANENT_FAILURE", reasonCode: PIPELINE_REASON.TOOL_RESULT_INVALID });
    this.observe(st, result.status, "reasonCode" in result ? result.reasonCode : null);
    return result;
  }

  /** Appends the `tool.invoke` audit event. Returns the event id, or null when it could not be written. */
  private async appendAudit(st: InvocationState, status: ToolStatus, reasonCode: string | null, required: boolean): Promise<string | null> {
    const d = this.deps;
    const ctx = st.ctx;
    const def = st.entry?.definition ?? null;
    try {
      const input = buildAuditInput(
        {
          tenantId: d.tenantId,
          correlationId: st.requestId,
          sourceComponent: st.transport.kind === "mcp" ? "mcp_adapter" : "gateway",
          action: "tool.invoke",
          outcome: AUDIT_OUTCOME[status],
          actorRef: ctx?.actorId ?? null,
          subjectRef: ctx?.subjectId ?? null,
          role: ctx?.selectedRole ?? null,
          callId: ctx?.callId ?? st.transportCallId,
          sessionRef: st.bindingRef,
          sessionGeneration: ctx?.sessionGeneration ?? null,
          turnId: st.turnId,
          versions: d.versions,
          policyDecision: st.decision
            ? { decisionId: st.decision.decisionId, allow: st.decision.allow, reasonCodes: st.decision.reasonCodes.slice(0, 16), policyVersion: st.decision.policyVersion }
            : null,
          assurance: ctx?.assurance ?? null,
          evidencePointers: st.evidence.slice(0, 16),
          idempotencyKey: st.idempotencyKey,
          reasonCode: reasonCode && ReasonCode.safeParse(reasonCode).success && !/\d{4,}/.test(reasonCode) ? reasonCode : null,
          dataClass: "SECURITY_AUDIT",
        },
        d.clock,
      );
      const ev = await d.audit.appendStandalone(input);
      return ev.eventId;
    } catch (err) {
      d.logger[required ? "error" : "warn"]("gateway.audit.append_failed", {
        reasonCode: err instanceof PlatformError ? err.reasonCode : "AUDIT_UNAVAILABLE",
        requestId: st.requestId,
        tool: def?.name ?? null,
      });
      return null;
    }
  }

  private observe(st: InvocationState, status: ToolStatus, reasonCode: string | null): void {
    const d = this.deps;
    const tool = st.entry?.definition.name ?? "other";
    const durationMs = Math.max(0, d.clock.now().getTime() - st.startedMs);
    try {
      d.metrics.increment("vsp_tool_calls_total", { tool, status });
      d.metrics.observe("vsp_tool_latency_ms", durationMs, { tool, status });
      if (st.entry?.definition.consequential && (status === "SUCCESS" || status === "PENDING")) {
        d.metrics.increment("vsp_protected_actions_total", {
          authorization: st.decision?.allow ? "valid_decision" : "missing_decision",
          audit: "recorded_before_ack",
        });
      }
    } catch {
      // Metrics never affect the result.
    }
    d.logger.info("gateway.tool.completed", { tool, status, reasonCode, requestId: st.requestId, durationMs, transport: st.transport.kind });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bindingRefOrNull(sessionRef: string | null): string | null {
  if (!sessionRef) return null;
  try {
    return sessionBindingRefFor(sessionRef);
  } catch {
    return null;
  }
}

function safetyPurpose(def: ToolDefinition): PolicyPurpose {
  return def.permissions.includes("safety:route") ? "safety_routing" : "human_handoff";
}

/** Resource for a sessionless safety/human route: no subject, no record, nothing disclosed. */
function sessionlessResource(tenantId: string, def: ToolDefinition): PolicyInput["resource"] {
  return {
    type: def.permissions.includes("safety:route") ? "safety_route" : "human_handoff",
    tenantId,
    subjectId: null,
    organizationId: null,
    classification: "INTERNAL",
    actionDigest: null,
  };
}

/** Placeholder decision for safety/human execution when policy evaluation failed (never authorizes disclosure). */
function denyPlaceholder(now: Date): PolicyDecision {
  return {
    decisionId: newId("pdc"),
    allow: false,
    reasonCodes: ["POLICY_ENGINE_ERROR"],
    fieldMask: [],
    obligations: [],
    policyVersion: "unavailable",
    evaluatedAt: iso(now),
  };
}

function sanitizeFailure(outcome: Exclude<Outcome, { status: "SUCCESS" | "PENDING" }>, st: InvocationState): Outcome {
  const reasonCode = safeReason(outcome.reasonCode, "DEPENDENCY_FAILED");
  switch (outcome.status) {
    case "RETRYABLE_FAILURE":
      return { status: "RETRYABLE_FAILURE", reasonCode, retryAfterMs: Number.isFinite(outcome.retryAfterMs) ? outcome.retryAfterMs : 1000 };
    case "UNKNOWN_OUTCOME":
      return { status: "UNKNOWN_OUTCOME", reasonCode, reconciliationRef: OpaqueId.safeParse(outcome.reconciliationRef).success ? outcome.reconciliationRef : st.requestId };
    case "POLICY_DENIED":
      return { status: "POLICY_DENIED", reasonCode };
    default:
      return { status: "PERMANENT_FAILURE", reasonCode };
  }
}

/** Routing helper from the loaded policy catalogue (intent + first integration per action). */
export function routingFromPolicyCatalogue(catalogue: { actions: Record<string, { intent?: string; integrations?: readonly string[] }> } | null | undefined): ToolRouting {
  const actions = catalogue?.actions ?? {};
  const action = (def: ToolDefinition) => {
    const name = def.permissions[0];
    return name && Object.hasOwn(actions, name) ? actions[name] : undefined;
  };
  return {
    intentFor: (def) => action(def)?.intent ?? null,
    dependencyFor: (def) => action(def)?.integrations?.[0] ?? def.name,
  };
}

/** Strict schema of the HTTP tool route body (deterministic alternative to MCP). */
export const HttpToolCallBody = z.strictObject({
  arguments: z.record(z.string(), z.unknown()),
  turnId: z.string().regex(TURN_ID).optional(),
  locale: z.string().regex(LOCALE).optional(),
});
export type HttpToolCallBody = z.infer<typeof HttpToolCallBody>;
