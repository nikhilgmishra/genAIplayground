/**
 * Metric catalogue fragment of the live composition (WP-07): the per-capability activation map, the
 * capability gate, telemetry export, the connector change-feed sync, the live outbox consumer and the start of
 * each deployable unit.
 *
 * Merged into the platform catalogue by `createPlatformMetricCatalogue` (catalog/index.ts) like every other
 * module fragment. Content free like every catalogue entry: labels are closed code enums (capability ids
 * from docs/followon/capabilities.yaml, states, results), never hosts, tenant inputs, ids or digests.
 */
import type { MetricCatalogue, MetricDefinition } from "./metrics.js";

const def = (
  name: string,
  type: MetricDefinition["type"],
  unit: MetricDefinition["unit"],
  dashboard: MetricDefinition["dashboard"],
  description: string,
  labels: Record<string, readonly string[]> = {},
): MetricDefinition => ({ name, type, unit, dashboard, description, labels });

/**
 * Capability ids the live composition gates on (a subset of docs/followon/capabilities.yaml; the activation
 * map test proves every id exists there and that the map uses no other id).
 */
export const RUNTIME_CAPABILITY_IDS = [
  "platform.substrate",
  "platform.composition",
  "audit.independent",
  "ingress.events",
  "identity.caller",
  "identity.workforce",
  "authority.registries",
  "connectors.runtime",
  "domain.business_systems",
  "crm.salesforce",
  "contact_center.talkdesk",
  "handoff.transfer",
  "notifications.messaging",
  "knowledge.retrieval",
  "operator.console",
  "workflows.durable",
  "privacy.operations",
  "context.store",
  "models.providers",
  "voice.media_runtime",
  "conversation.harness",
  "operations.resilience_cost",
] as const;
export type RuntimeCapabilityId = (typeof RUNTIME_CAPABILITY_IDS)[number];

/**
 * Error-level log events that page (platform/src/observability/alarms.ts): the composition's logger tap counts
 * each one in vsp_alarm_log_events_total, so a log-event alarm is evaluated (and exported) like a metric alarm.
 */
export const ALARM_LOG_EVENTS = [
  "console.sso.terminal_closure_unaudited",
  "console.sso.terminal_audit_unwritten",
  "audit.journal.memory_fallback",
  "audit.journal.lost_at_shutdown",
  "audit.deferred.lost_at_shutdown",
  "inbox.dead_lettered",
  "connectors.feed.dead_letter_refused",
  "capability.guard_port_reached",
] as const;
export type AlarmLogEvent = (typeof ALARM_LOG_EVENTS)[number];

export const CAPABILITY_STATES = ["configured", "not_configured"] as const;
/** Where a NOT_CONFIGURED capability was refused: admission (tool call), a background hold, a guard port. */
export const CAPABILITY_REFUSAL_SURFACES = ["admission", "hold", "guard_port"] as const;
export const TELEMETRY_SIGNALS = ["metrics", "traces"] as const;
export const DEPLOYABLE_UNITS = ["gateway", "worker", "console", "audit_exporter"] as const;

export const COMPOSITION_METRICS: readonly MetricDefinition[] = [
  def("vsp_capability_state", "gauge", "1", "service_objectives", "1 for the current activation state of each runtime capability (per-capability activation map)", {
    capability: RUNTIME_CAPABILITY_IDS,
    state: CAPABILITY_STATES,
  }),
  def("vsp_capability_refusals_total", "counter", "1", "service_objectives", "Requests or background work refused because the capability they need is NOT_CONFIGURED", {
    capability: RUNTIME_CAPABILITY_IDS,
    surface: CAPABILITY_REFUSAL_SURFACES,
  }),
  def("vsp_capability_not_configured_reached_total", "counter", "1", "service_objectives", "A NOT_CONFIGURED capability guard port was called (a gating defect: the admission gate or hold should have refused first; alarm on any)", {
    capability: RUNTIME_CAPABILITY_IDS,
  }),
  def("vsp_telemetry_export_total", "counter", "1", "resilience", "OTLP export requests through the egress-classified transport by signal and result", {
    signal: TELEMETRY_SIGNALS,
    result: ["exported", "failed", "refused"],
  }),
  def("vsp_telemetry_attributes_dropped_total", "counter", "1", "resilience", "Attributes dropped at export because they are not on the content-free allowlist (defence in depth; alarm on any)", {
    signal: TELEMETRY_SIGNALS,
  }),
  def("vsp_connector_feed_records_total", "counter", "1", "tools_dependencies", "Connector change-feed records by projection result", {
    result: ["indexed", "dead_lettered", "unchanged"],
  }),
  def("vsp_connector_feed_dead_letter_refused_total", "counter", "1", "tools_dependencies", "Connector change-feed dead-letter writes the dead-letter queue refused (consumption stopped, checkpoint kept; alarm on any)"),
  def("vsp_connector_feed_runs_total", "counter", "1", "tools_dependencies", "Connector change-feed sync runs by result", {
    result: ["caught_up", "page_limit", "stopped"],
  }),
  def("vsp_outbox_publish_failures_total", "counter", "1", "tools_dependencies", "Outbox messages the worker could not publish to the queue (left PENDING for a retry with backoff, or moved to DEAD after the attempt limit; alarm on any)", {
    reason: ["publish_failed", "dead_lettered"],
  }),
  def("vsp_action_reconcile_degraded_total", "counter", "1", "tools_dependencies", "Worker reconciliation runs that found actions to reconcile and settled none of them (every provider lookup inconclusive, or no provider for the kind; alarm on repeated runs)", {
    reason: ["all_inconclusive", "no_provider"],
  }),
  def("vsp_outbox_consume_failures_total", "counter", "1", "tools_dependencies", "Outbox messages the live worker could not consume (left to the queue for redelivery and the redrive policy; alarm on any)", {
    reason: ["consume_failed", "envelope_invalid", "no_consumer"],
  }),
  def("vsp_alarm_log_events_total", "counter", "1", "service_objectives", "Error-level log events that page, counted by the composition's logger tap (event names are code constants)", {
    event: ALARM_LOG_EVENTS,
  }),
  def("vsp_console_auth_rate_limited_total", "counter", "1", "resilience", "Console sign-in requests (/console/api/v1/auth/*) refused by the live console's per-source rate limit"),
  def("vsp_live_composition_starts_total", "counter", "1", "service_objectives", "Starts of a deployable unit from the live composition by result", {
    unit: DEPLOYABLE_UNITS,
    result: ["started", "refused"],
  }),
];

/** Returns a catalogue with the composition metrics added (fails on a name clash in createPlatformMetricCatalogue). */
export function withCompositionMetrics(base: MetricCatalogue): MetricCatalogue {
  const out = new Map(base);
  for (const d of COMPOSITION_METRICS) if (!out.has(d.name)) out.set(d.name, d);
  return out;
}
