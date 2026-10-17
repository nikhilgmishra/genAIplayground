/**
 * Metric catalogue with label allowlists (spec sections 6 and 13, DATA-01).
 *
 * Every metric the platform emits is declared here with its type, unit and the
 * exact label keys it may carry. Each label key has a closed enum of allowed
 * values made of code constants. A label value outside the enum is collapsed to
 * "other" and an undeclared label key is dropped, so a caller that mistakenly
 * passes a name, phone number, date of birth, utterance or dependency free text
 * cannot create a time series containing it. Alert text is derived from metric
 * names and these enum values only.
 *
 * Two implementations of the `Metrics` port:
 *  - `InMemoryMetrics` (LOCAL FIXTURE, kind "local_fixture"): used by tests and the
 *    local demo; unknown metric names throw by default so typos fail tests.
 *  - `OpenTelemetryMetrics` (kind "live"): bridges to `@opentelemetry/api` meters.
 *    Exporter / collector configuration (CloudWatch, approved Datadog) is NOT part
 *    of this module and remains BLOCKED on the observability-vendor approval.
 */
import { metrics as otelMetrics } from "@opentelemetry/api";
import type { Attributes, Counter, Gauge, Histogram, Meter } from "@opentelemetry/api";
import {
  AuditSourceComponent,
  IssueCategory,
  KillSwitchScope,
  Outcome,
  RiskFlag,
  Role,
  ToolStatus,
  TransferReason,
  TransferState,
  VerificationMethod,
} from "../protocol/index.js";
import { ValidationError } from "../shared/errors.js";
import type { Metrics } from "./ports.js";

export type MetricType = "counter" | "histogram" | "gauge";
export type MetricUnit = "1" | "ms" | "s" | "usd_micro" | "ratio";

export type DashboardId =
  | "call_flow"
  | "identity"
  | "tools_dependencies"
  | "safety"
  | "clinical_boundary"
  | "crm_reconciliation"
  | "knowledge"
  | "voice_experience"
  | "cost_quotas"
  | "audit"
  | "resilience"
  | "admission_controls"
  | "service_objectives";

export interface MetricDefinition {
  readonly name: string;
  readonly type: MetricType;
  readonly unit: MetricUnit;
  readonly description: string;
  readonly dashboard: DashboardId;
  /** Allowed label keys, each with its closed enum of allowed values. */
  readonly labels: Readonly<Record<string, readonly string[]>>;
}

/** Value substituted for any label value outside a metric's allowlist. */
export const OTHER_LABEL_VALUE = "other";

// ---------------------------------------------------------------------------
// Label value enums (code constants only; never caller- or dependency-supplied)
// ---------------------------------------------------------------------------

/** Integration / dependency identifiers (config adapter keys plus infrastructure). */
export const DEPENDENCY_IDS = [
  "identity-directory",
  "oidc-client-idp",
  "oidc-provider-idp",
  "workforce-sso",
  "relationship-directory",
  "notifications",
  "scheduling",
  "billing",
  "claims",
  "provider-system",
  "salesforce",
  "talkdesk-telephony",
  "talkdesk-ai",
  "workflow-engine",
  "event-queue",
  "policy-engine",
  "database",
  "session-store",
  "audit-sink",
  "kms",
  "secrets-manager",
  "knowledge",
  "model-provider",
  "asr",
  "tts",
] as const;

/** Tool names from spec section 8 plus the initial workflow catalogue. Extendable at composition time. */
export const DEFAULT_TOOL_NAMES = [
  "search_approved_runbook",
  "get_authorized_case_status",
  "get_appointment_options",
  "prepare_appointment_change",
  "commit_appointment_change",
  "get_invoice_status",
  "submit_billing_review",
  "create_support_request",
  "request_human_transfer",
  "get_claim_status",
  "get_onboarding_status",
  "get_remittance_status",
  "submit_partner_intake",
  "submit_complaint_intake",
  "request_safety_handoff",
] as const;

export const ADMISSION_CLASSES = ["SAFETY", "HUMAN_ROUTE", "PROTECTED_READ", "WRITE", "PUBLIC", "ANALYTICS"] as const;

/**
 * Reason codes produced by the admission controller (platform/src/ops). Kept here
 * so the label allowlist is closed; ops tests assert every code is listed.
 */
export const ADMISSION_REASON_CODES = [
  "SAFETY_ALWAYS_ADMITTED",
  "HUMAN_ROUTE_ALWAYS_ADMITTED",
  "SAFETY_RESERVE_EXCEEDED_ESCALATE",
  "ADMITTED",
  "ADMISSION_INPUT_INVALID",
  "KILL_SWITCH_STATE_UNAVAILABLE",
  "KILL_SWITCH_AI_ADMISSION",
  "KILL_SWITCH_WRITES",
  "KILL_SWITCH_INTENT",
  "KILL_SWITCH_INTEGRATION",
  "KILL_SWITCH_MODEL_VERSION",
  "KILL_SWITCH_VOICE_VERSION",
  "LOAD_SHED_ELEVATED",
  "LOAD_SHED_CONSTRAINED",
  "LOAD_SHED_DEGRADED",
  "CAPACITY_LIMIT",
  "BUDGET_EXHAUSTED",
  "BUDGET_NOT_CONFIGURED",
  "BUDGET_STATE_UNAVAILABLE",
] as const;

export const CONTINUITY_ROUTES = ["NONE", "HUMAN_QUEUE", "CALLBACK_INTAKE", "OUTAGE_MESSAGE_THEN_HUMAN"] as const;

/** Reason codes emitted by platform/src/resilience. */
export const DEPENDENCY_ERROR_REASONS = [
  "TIMEOUT",
  "CALLER_ABORTED",
  "CIRCUIT_OPEN",
  "BULKHEAD_FULL",
  "BULKHEAD_QUEUE_TIMEOUT",
  "TIMEOUT_BEFORE_SEND",
  "CONNECTION_REFUSED",
  "HTTP_429",
  "HTTP_503",
  "HTTP_5XX",
  "UNCLASSIFIED_ERROR",
] as const;

export const CIRCUIT_STATES = ["closed", "open", "half_open"] as const;

export const DESTINATION_PURPOSES = [
  "SAFETY_PRIORITY",
  "STANDARD_SUPPORT",
  "INTERPRETER",
  "CLINICAL_ROUTE",
  "PROVIDER_SUPPORT",
  "PARTNER_SUPPORT",
  "BILLING_SPECIALIST",
  "OUTAGE_CONTINUITY",
] as const;

const BOOL = ["true", "false"] as const;
const LANGUAGE = ["en", "es", "unsupported", "unknown"] as const;
const REGION = ["us-east-1", "us-east-2", "us-west-1", "us-west-2", "unknown"] as const;
const AUDIENCE = [...Role.options, "unknown"] as const;
const ENTRY = ["ai", "direct_human", "outage_mode"] as const;
const STAGE = ["ivr", "consent", "verification", "ai", "queue", "transfer", "callback"] as const;
const LOAD_BAND = ["lt_500", "500_to_1499", "1500_to_1999", "2000_to_2999", "gte_3000"] as const;
const VENDORS = [...DEPENDENCY_IDS, "telephony-carrier", "aws-platform"] as const;
const QUOTAS = [
  "ai_sessions",
  "call_starts",
  "trunks",
  "media_legs",
  "asr",
  "tts",
  "model_tokens",
  "tools",
  "exports",
  "salesforce_api",
  "notifications",
  "workflow_executions",
] as const;
const BACKLOGS = ["outbox", "reconciliation", "dead_letter", "crm_sync", "human_tasks", "audit_shipping"] as const;
const SAFETY_SIGNAL_SOURCES = ["explicit_phrase", "semantic", "uncertain_asr", "caller_request", "human_intervention"] as const;

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

export interface CatalogueExtensions {
  /** Tool names from the pinned tool catalogue (code constants). */
  toolNames?: readonly string[];
  /** Intent identifiers from resolution contracts. */
  intents?: readonly string[];
  /** Approved model / voice version labels from configuration. */
  models?: readonly string[];
  voices?: readonly string[];
}

/**
 * Dynamic label values must still be code-like tokens: no whitespace, no "@",
 * no long digit runs (phone numbers, member numbers) and bounded length.
 */
const SAFE_DYNAMIC_LABEL = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const LONG_DIGIT_RUN = /\d{7,}/;

export function assertSafeDynamicLabelValue(value: string): void {
  if (!SAFE_DYNAMIC_LABEL.test(value) || LONG_DIGIT_RUN.test(value) || value === OTHER_LABEL_VALUE) {
    throw new ValidationError("METRIC_LABEL_VALUE_UNSAFE");
  }
}

function dyn(defaults: readonly string[], extra: readonly string[] | undefined): readonly string[] {
  const out = new Set<string>(defaults);
  for (const v of extra ?? []) {
    assertSafeDynamicLabelValue(v);
    out.add(v);
  }
  return [...out];
}

function def(
  name: string,
  type: MetricType,
  unit: MetricUnit,
  dashboard: DashboardId,
  description: string,
  labels: Record<string, readonly string[]> = {},
): MetricDefinition {
  return { name, type, unit, dashboard, description, labels };
}

export type MetricCatalogue = ReadonlyMap<string, MetricDefinition>;

export function createMetricCatalogue(ext: CatalogueExtensions = {}): MetricCatalogue {
  const tool = dyn(DEFAULT_TOOL_NAMES, ext.toolNames);
  const intent = dyn([...IssueCategory.options], ext.intents);
  const model = dyn(["unknown"], ext.models);
  const voice = dyn(["unknown"], ext.voices);

  const defs: MetricDefinition[] = [
    // --- call flow -------------------------------------------------------
    def("vsp_call_arrivals_total", "counter", "1", "call_flow", "Inbound calls reaching the platform", { audience: AUDIENCE, language: LANGUAGE, entry: ENTRY }),
    def("vsp_live_sessions", "gauge", "1", "call_flow", "Live sessions by mode", { session_mode: ["ai", "human", "safety_handoff", "callback_intake"] }),
    def("vsp_queue_age_ms", "histogram", "ms", "call_flow", "Age of the oldest waiting caller per destination purpose", { queue_purpose: DESTINATION_PURPOSES }),
    def("vsp_abandonments_total", "counter", "1", "call_flow", "Caller abandonment by stage", { stage: STAGE }),
    def("vsp_human_demand_total", "counter", "1", "call_flow", "Requests for a human route by reason", { reason: TransferReason.options }),
    def("vsp_transfers_total", "counter", "1", "call_flow", "Transfer state transitions", { queue_purpose: DESTINATION_PURPOSES, transfer_state: TransferState.options }),
    def("vsp_disconnects_total", "counter", "1", "call_flow", "Disconnects by stage and initiating party", { stage: STAGE, party: ["caller", "system", "vendor", "unknown"] }),
    def("vsp_routing_outcomes_total", "counter", "1", "service_objectives", "Calls routed to a usable support path (SLO routing_usable_path)", {
      routing_result: ["usable_path", "no_usable_path"],
      entry: ENTRY,
    }),
    def("vsp_interaction_outcomes_total", "counter", "1", "call_flow", "Interaction outcomes (RESOLVED requires evidence)", { outcome: Outcome.options, intent }),
    // --- identity --------------------------------------------------------
    def("vsp_identity_verifications_total", "counter", "1", "identity", "Verification attempts by method and result", {
      method: VerificationMethod.options,
      result: ["success", "failure", "abandoned", "locked", "expired"],
    }),
    def("vsp_identity_denials_total", "counter", "1", "identity", "Session or authorization denials by reason", {
      reason: [
        "SESSION_MISSING",
        "SESSION_EXPIRED",
        "SESSION_REVOKED",
        "GENERATION_MISMATCH",
        "INTEGRATION_MISMATCH",
        "ASSURANCE_INSUFFICIENT",
        "RELATIONSHIP_MISSING",
        "CONSENT_MISSING",
        "POLICY_DENIED",
      ],
    }),
    def("vsp_challenge_abuse_signals_total", "counter", "1", "identity", "Challenge abuse and risk signals", { signal: RiskFlag.options }),
    // --- tools and dependencies -----------------------------------------
    def("vsp_tool_calls_total", "counter", "1", "tools_dependencies", "Tool invocations by status", { tool, status: ToolStatus.options }),
    def("vsp_tool_latency_ms", "histogram", "ms", "tools_dependencies", "Tool latency at the gateway", { tool, status: ToolStatus.options }),
    def("vsp_dependency_health", "gauge", "1", "tools_dependencies", "1 for the dependency's current circuit state, 0 otherwise", { dependency: DEPENDENCY_IDS, circuit_state: CIRCUIT_STATES }),
    def("vsp_dependency_latency_ms", "histogram", "ms", "tools_dependencies", "Dependency call latency", { dependency: DEPENDENCY_IDS, result: ["success", "failure"] }),
    def("vsp_dependency_errors_total", "counter", "1", "tools_dependencies", "Dependency errors by commit outcome", {
      dependency: DEPENDENCY_IDS,
      outcome: ["NOT_STARTED", "FAILED", "UNKNOWN"],
      reason: DEPENDENCY_ERROR_REASONS,
    }),
    def("vsp_unknown_commits_total", "counter", "1", "tools_dependencies", "Commits whose outcome is UNKNOWN pending reconciliation", { dependency: DEPENDENCY_IDS }),
    def("vsp_backlog_items", "gauge", "1", "tools_dependencies", "Items waiting in durable backlogs", { backlog: BACKLOGS }),
    def("vsp_duplicate_effects_total", "counter", "1", "service_objectives", "Duplicate consequential effects detected (target zero)", { dependency: DEPENDENCY_IDS }),
    // --- safety and clinical boundary ------------------------------------
    def("vsp_safety_signals_total", "counter", "1", "safety", "Safety signals by source", { signal_source: SAFETY_SIGNAL_SOURCES }),
    def("vsp_safety_time_to_routing_ms", "histogram", "ms", "safety", "Validated safety event to priority route initiation", { signal_source: SAFETY_SIGNAL_SOURCES }),
    def("vsp_safety_handoffs_total", "counter", "1", "safety", "Safety handoff results", {
      result: ["completed", "failed", "receiver_unavailable", "caller_disconnected", "in_progress"],
    }),
    def("vsp_unsupported_clinical_requests_total", "counter", "1", "clinical_boundary", "Clinical questions redirected to a human or clinician route", { audience: AUDIENCE }),
    def("vsp_boundary_violations_total", "counter", "1", "service_objectives", "Confirmed privacy or clinical-boundary violations (zero tolerated)", {
      kind: ["privacy", "clinical_boundary"],
      severity: ["critical", "major", "minor"],
    }),
    // --- CRM -------------------------------------------------------------
    def("vsp_crm_reconciliation_total", "counter", "1", "crm_reconciliation", "Support-record synchronization results", {
      result: ["synced", "pending", "retried", "dead_lettered", "repaired"],
    }),
    def("vsp_crm_sync_lag_ms", "histogram", "ms", "crm_reconciliation", "Accepted finalization to CRM synchronization"),
    // --- knowledge ------------------------------------------------------
    def("vsp_knowledge_freshness_age_seconds", "gauge", "s", "knowledge", "Age of the oldest active approved item", { corpus: ["public_faq", "runbook", "salesforce_knowledge"] }),
    def("vsp_knowledge_items_needing_review", "gauge", "1", "knowledge", "Expired, conflicting or stale items awaiting review", {
      corpus: ["public_faq", "runbook", "salesforce_knowledge"],
      review_reason: ["expired", "conflict", "stale"],
    }),
    // --- voice experience -----------------------------------------------
    def("vsp_interruptions_total", "counter", "1", "voice_experience", "Barge-in, ASR corrections and repeat requests", { kind: ["barge_in", "asr_correction", "repeat_request"] }),
    def("vsp_barge_in_stop_ms", "histogram", "ms", "service_objectives", "Detected interruption to last bot audio at handset", { language: LANGUAGE }),
    def("vsp_turn_latency_ms", "histogram", "ms", "service_objectives", "Turn latency by turn kind and breakdown dimensions", {
      turn_kind: ["warm_simple", "tool_backed_substantive", "acknowledgment"],
      language: LANGUAGE,
      intent,
      region: REGION,
      audience: AUDIENCE,
      model,
      voice,
      auth_path: VerificationMethod.options,
      load_band: LOAD_BAND,
      dependencies_healthy: BOOL,
    }),
    // --- cost and quotas --------------------------------------------------
    def("vsp_cost_usd_micro_total", "counter", "usd_micro", "cost_quotas", "Recorded spend in integer micro-USD", { vendor: VENDORS, safety: BOOL }),
    def("vsp_budget_utilization_ratio", "gauge", "ratio", "cost_quotas", "Projected spend divided by budget limit", { vendor: [...VENDORS, "*"] }),
    def("vsp_quota_utilization_ratio", "gauge", "ratio", "cost_quotas", "Quota utilization", { quota: QUOTAS }),
    def("vsp_safety_reserve_overdraw_total", "counter", "1", "cost_quotas", "Safety admissions beyond the approved reserve (alert, never a cap)", { reserve: ["budget", "sessions"] }),
    def("vsp_cost_record_failures_total", "counter", "1", "cost_quotas", "Spend records that could not be written", { safety: BOOL }),
    // --- admission and kill switches -------------------------------------
    def("vsp_admission_decisions_total", "counter", "1", "admission_controls", "Admission decisions", {
      admission_class: ADMISSION_CLASSES,
      admitted: BOOL,
      reason: ADMISSION_REASON_CODES,
      continuity: CONTINUITY_ROUTES,
    }),
    def("vsp_ai_sessions_active", "gauge", "1", "admission_controls", "Concurrent AI sessions holding a capacity lease", { pool: ["standard", "safety_reserve"] }),
    def("vsp_killswitch_changes_total", "counter", "1", "admission_controls", "Kill switch changes", { scope: KillSwitchScope.options, engaged: BOOL }),
    def("vsp_killswitch_engaged", "gauge", "1", "admission_controls", "Number of engaged switches per scope", { scope: KillSwitchScope.options }),
    def("vsp_killswitch_snapshot_failures_total", "counter", "1", "admission_controls", "Kill switch reads that failed closed"),
    // --- audit -----------------------------------------------------------
    def("vsp_audit_export_completeness_ratio", "gauge", "ratio", "audit", "Shipped audit events divided by source event count", { source_component: AuditSourceComponent.options }),
    def("vsp_audit_backlog_events", "gauge", "1", "audit", "Audit events awaiting shipment"),
    def("vsp_audit_ingestion_gaps_total", "counter", "1", "audit", "Sequence gaps detected during audit ingestion", { source_component: AuditSourceComponent.options }),
    def("vsp_protected_actions_total", "counter", "1", "service_objectives", "Protected actions by authorization and audit evidence", {
      authorization: ["valid_decision", "missing_decision"],
      audit: ["recorded_before_ack", "not_recorded"],
    }),
    def("vsp_policy_decisions_total", "counter", "1", "service_objectives", "Policy decisions", { allow: BOOL, consequential: BOOL }),
    // --- resilience -------------------------------------------------------
    def("vsp_retry_attempts_total", "counter", "1", "resilience", "Retry wrapper outcomes", {
      dependency: DEPENDENCY_IDS,
      result: ["retry_scheduled", "succeeded", "exhausted", "not_retryable", "unknown_outcome_not_retried"],
    }),
    def("vsp_nested_retry_refused_total", "counter", "1", "resilience", "Retry wrappers refused because a retry was already active", { dependency: DEPENDENCY_IDS }),
    def("vsp_timeouts_total", "counter", "1", "resilience", "Operations aborted by timeout", { dependency: DEPENDENCY_IDS }),
    def("vsp_circuit_transitions_total", "counter", "1", "resilience", "Circuit breaker transitions", { dependency: DEPENDENCY_IDS, circuit_state: CIRCUIT_STATES }),
    def("vsp_circuit_rejections_total", "counter", "1", "resilience", "Calls rejected because the circuit was open", { dependency: DEPENDENCY_IDS }),
    def("vsp_bulkhead_rejections_total", "counter", "1", "resilience", "Bulkhead rejections", { dependency: DEPENDENCY_IDS, reason: ["BULKHEAD_FULL", "BULKHEAD_QUEUE_TIMEOUT", "CALLER_ABORTED"] }),
    def("vsp_bulkhead_active", "gauge", "1", "resilience", "Calls executing inside a bulkhead", { dependency: DEPENDENCY_IDS }),
    def("vsp_bulkhead_queued", "gauge", "1", "resilience", "Calls waiting for a bulkhead slot", { dependency: DEPENDENCY_IDS }),
    // --- metrics pipeline self-observation -------------------------------
    def("vsp_metric_label_rejections_total", "counter", "1", "resilience", "Label values collapsed to other or undeclared keys dropped", { action: ["collapsed_to_other", "key_dropped"] }),
  ];

  const map = new Map<string, MetricDefinition>();
  for (const d of defs) {
    if (!/^vsp_[a-z0-9_]{3,80}$/.test(d.name)) throw new ValidationError("METRIC_NAME_INVALID");
    if (map.has(d.name)) throw new ValidationError("METRIC_NAME_DUPLICATE");
    if (d.type === "counter" && !d.name.endsWith("_total")) throw new ValidationError("METRIC_COUNTER_SUFFIX");
    map.set(d.name, d);
  }
  return map;
}

export const DEFAULT_METRIC_CATALOGUE: MetricCatalogue = createMetricCatalogue();

// ---------------------------------------------------------------------------
// Label normalization
// ---------------------------------------------------------------------------

export interface NormalizedLabels {
  labels: Record<string, string>;
  collapsed: number;
  droppedKeys: number;
}

/** Applies the metric's allowlist: undeclared keys are dropped, unknown values become "other". */
export function normalizeLabels(definition: MetricDefinition, labels: Record<string, string> | undefined): NormalizedLabels {
  const out: Record<string, string> = {};
  let collapsed = 0;
  let droppedKeys = 0;
  if (!labels) return { labels: out, collapsed, droppedKeys };
  for (const key of Object.keys(labels).sort()) {
    // Own properties only: prototype keys such as "toString" must never match.
    const allowed = Object.hasOwn(definition.labels, key) ? definition.labels[key] : undefined;
    if (!Array.isArray(allowed)) {
      droppedKeys += 1;
      continue;
    }
    const value = labels[key];
    if (typeof value === "string" && (allowed as readonly string[]).includes(value)) {
      out[key] = value;
    } else {
      out[key] = OTHER_LABEL_VALUE;
      collapsed += 1;
    }
  }
  return { labels: out, collapsed, droppedKeys };
}

export class MetricCatalogueError extends ValidationError {
  constructor(
    reasonCode: "METRIC_UNKNOWN" | "METRIC_TYPE_MISMATCH" | "METRIC_VALUE_INVALID",
    readonly metricName: string,
  ) {
    super(reasonCode);
  }
}

export type UnknownMetricMode = "throw" | "drop";

const seriesKey = (name: string, labels: Record<string, string>): string =>
  `${name}{${Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k] ?? ""}`)
    .join(",")}}`;

function resolveDefinition(
  catalogue: MetricCatalogue,
  name: string,
  expected: MetricType,
  value: number,
  mode: UnknownMetricMode,
  onDrop: () => void,
): MetricDefinition | null {
  const d = catalogue.get(name);
  let code: "METRIC_UNKNOWN" | "METRIC_TYPE_MISMATCH" | "METRIC_VALUE_INVALID" | null = null;
  if (!d) code = "METRIC_UNKNOWN";
  else if (d.type !== expected) code = "METRIC_TYPE_MISMATCH";
  else if (!Number.isFinite(value) || ((expected === "counter" || expected === "histogram") && value < 0)) code = "METRIC_VALUE_INVALID";
  if (code) {
    if (mode === "throw") throw new MetricCatalogueError(code, name);
    onDrop();
    return null;
  }
  return d ?? null;
}

// ---------------------------------------------------------------------------
// In-memory implementation (LOCAL FIXTURE)
// ---------------------------------------------------------------------------

export interface MetricSeries {
  name: string;
  type: MetricType;
  labels: Record<string, string>;
  /** Counter sum or last gauge value. */
  value: number;
  /** Histogram observations (bounded ring, most recent last). */
  observations: number[];
}

const MAX_OBSERVATIONS_PER_SERIES = 10_000;

/**
 * LOCAL FIXTURE metrics sink. Holds series in memory for tests, the local demo
 * and SLO evaluation over synthetic runs. Not an exporter.
 */
export class InMemoryMetrics implements Metrics {
  readonly kind = "local_fixture" as const;
  private readonly store = new Map<string, MetricSeries>();
  private readonly catalogue: MetricCatalogue;
  private readonly mode: UnknownMetricMode;
  /** Count of calls dropped in "drop" mode (unknown name, wrong type, invalid value). */
  droppedCalls = 0;

  constructor(opts: { catalogue?: MetricCatalogue; unknownMetric?: UnknownMetricMode } = {}) {
    this.catalogue = opts.catalogue ?? DEFAULT_METRIC_CATALOGUE;
    this.mode = opts.unknownMetric ?? "throw";
  }

  increment(name: string, labels?: Record<string, string>, value = 1): void {
    const d = resolveDefinition(this.catalogue, name, "counter", value, this.mode, () => (this.droppedCalls += 1));
    if (!d) return;
    this.series(d, labels).value += value;
  }

  observe(name: string, valueMs: number, labels?: Record<string, string>): void {
    const d = resolveDefinition(this.catalogue, name, "histogram", valueMs, this.mode, () => (this.droppedCalls += 1));
    if (!d) return;
    const s = this.series(d, labels);
    s.observations.push(valueMs);
    if (s.observations.length > MAX_OBSERVATIONS_PER_SERIES) s.observations.shift();
    s.value += 1;
  }

  gauge(name: string, value: number, labels?: Record<string, string>): void {
    const d = resolveDefinition(this.catalogue, name, "gauge", value, this.mode, () => (this.droppedCalls += 1));
    if (!d) return;
    this.series(d, labels).value = value;
  }

  private series(d: MetricDefinition, raw: Record<string, string> | undefined): MetricSeries {
    const n = normalizeLabels(d, raw);
    this.recordRejections(n);
    const key = seriesKey(d.name, n.labels);
    let s = this.store.get(key);
    if (!s) {
      s = { name: d.name, type: d.type, labels: n.labels, value: 0, observations: [] };
      this.store.set(key, s);
    }
    return s;
  }

  private recordRejections(n: NormalizedLabels): void {
    const meta = this.catalogue.get("vsp_metric_label_rejections_total");
    if (!meta) return;
    const bump = (action: string, by: number) => {
      if (by <= 0) return;
      const key = seriesKey(meta.name, { action });
      let s = this.store.get(key);
      if (!s) {
        s = { name: meta.name, type: "counter", labels: { action }, value: 0, observations: [] };
        this.store.set(key, s);
      }
      s.value += by;
    };
    bump("collapsed_to_other", n.collapsed);
    bump("key_dropped", n.droppedKeys);
  }

  /** All series whose labels include `match` (after normalization of the match itself is NOT applied). */
  find(name: string, match: Record<string, string> = {}): MetricSeries[] {
    return [...this.store.values()].filter((s) => s.name === name && Object.entries(match).every(([k, v]) => s.labels[k] === v));
  }

  /** Sum of counter values across series matching `match`. */
  counterValue(name: string, match: Record<string, string> = {}): number {
    return this.find(name, match).reduce((acc, s) => acc + s.value, 0);
  }

  gaugeValue(name: string, match: Record<string, string> = {}): number | undefined {
    const found = this.find(name, match);
    return found.length === 1 ? found[0]?.value : undefined;
  }

  observations(name: string, match: Record<string, string> = {}): number[] {
    return this.find(name, match).flatMap((s) => s.observations);
  }

  allSeries(): MetricSeries[] {
    return [...this.store.values()].map((s) => ({ ...s, labels: { ...s.labels }, observations: [...s.observations] }));
  }

  reset(): void {
    this.store.clear();
    this.droppedCalls = 0;
  }
}

// ---------------------------------------------------------------------------
// OpenTelemetry bridge (kind "live"; exporter configuration is out of scope)
// ---------------------------------------------------------------------------

type Instrument = { kind: "counter"; i: Counter } | { kind: "histogram"; i: Histogram } | { kind: "gauge"; i: Gauge };

/**
 * Bridges the `Metrics` port to `@opentelemetry/api` instruments. Labels are
 * normalized against the same allowlist before becoming metric attributes.
 * Without a registered MeterProvider the API's no-op meter is used.
 */
export class OpenTelemetryMetrics implements Metrics {
  readonly kind = "live" as const;
  private readonly meter: Meter;
  private readonly catalogue: MetricCatalogue;
  private readonly mode: UnknownMetricMode;
  private readonly instruments = new Map<string, Instrument>();
  droppedCalls = 0;

  constructor(opts: { meter?: Meter; catalogue?: MetricCatalogue; unknownMetric?: UnknownMetricMode; meterName?: string; meterVersion?: string } = {}) {
    this.meter = opts.meter ?? otelMetrics.getMeter(opts.meterName ?? "vsp-platform", opts.meterVersion);
    this.catalogue = opts.catalogue ?? DEFAULT_METRIC_CATALOGUE;
    this.mode = opts.unknownMetric ?? "drop";
  }

  private instrument(d: MetricDefinition): Instrument {
    let inst = this.instruments.get(d.name);
    if (!inst) {
      const options = { description: d.description, unit: d.unit };
      if (d.type === "counter") inst = { kind: "counter", i: this.meter.createCounter(d.name, options) };
      else if (d.type === "histogram") inst = { kind: "histogram", i: this.meter.createHistogram(d.name, options) };
      else inst = { kind: "gauge", i: this.meter.createGauge(d.name, options) };
      this.instruments.set(d.name, inst);
    }
    return inst;
  }

  private attributes(d: MetricDefinition, labels: Record<string, string> | undefined): Attributes {
    const n = normalizeLabels(d, labels);
    if (n.collapsed > 0 || n.droppedKeys > 0) {
      const meta = this.catalogue.get("vsp_metric_label_rejections_total");
      if (meta) {
        const c = this.instrument(meta);
        if (c.kind === "counter") {
          if (n.collapsed > 0) c.i.add(n.collapsed, { action: "collapsed_to_other" });
          if (n.droppedKeys > 0) c.i.add(n.droppedKeys, { action: "key_dropped" });
        }
      }
    }
    return n.labels;
  }

  increment(name: string, labels?: Record<string, string>, value = 1): void {
    const d = resolveDefinition(this.catalogue, name, "counter", value, this.mode, () => (this.droppedCalls += 1));
    if (!d) return;
    const inst = this.instrument(d);
    if (inst.kind === "counter") inst.i.add(value, this.attributes(d, labels));
  }

  observe(name: string, valueMs: number, labels?: Record<string, string>): void {
    const d = resolveDefinition(this.catalogue, name, "histogram", valueMs, this.mode, () => (this.droppedCalls += 1));
    if (!d) return;
    const inst = this.instrument(d);
    if (inst.kind === "histogram") inst.i.record(valueMs, this.attributes(d, labels));
  }

  gauge(name: string, value: number, labels?: Record<string, string>): void {
    const d = resolveDefinition(this.catalogue, name, "gauge", value, this.mode, () => (this.droppedCalls += 1));
    if (!d) return;
    const inst = this.instrument(d);
    if (inst.kind === "gauge") inst.i.record(value, this.attributes(d, labels));
  }
}

/** Discards everything; for code paths that do not need metrics in a given test. */
export const noopMetrics: Metrics = {
  increment: () => undefined,
  observe: () => undefined,
  gauge: () => undefined,
};
