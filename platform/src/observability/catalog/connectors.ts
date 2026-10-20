/**
 * Metric catalogue fragment of the connector runtime (WP-06): the egress-classified transport, secret
 * resolution, the token manager, rate budgets, operations, readiness and vendor usage.
 *
 * Module-local catalogue file (docs/followon/work-packages.yaml ownership rules): the phase integration
 * package merges CONNECTOR_METRICS into the platform catalogue (WP-07). Until then `withConnectorMetrics`
 * extends a catalogue for the modules and tests that emit these metrics, and every emitter guards its
 * metric calls, so an unmerged catalogue never changes what a connector does.
 *
 * Content free like every catalogue entry: labels are closed code enums (dependency ids, results, kinds),
 * never hosts, URLs, credential references, cursors or record values.
 */
import { DEPENDENCY_IDS } from "../metrics.js";
import type { MetricCatalogue, MetricDefinition } from "../metrics.js";

const def = (
  name: string,
  type: MetricDefinition["type"],
  unit: MetricDefinition["unit"],
  dashboard: MetricDefinition["dashboard"],
  description: string,
  labels: Record<string, readonly string[]> = {},
): MetricDefinition => ({ name, type, unit, dashboard, description, labels });

/** Dependency label values: the platform's dependency ids plus the source-system ids of planned connector families. */
export const CONNECTOR_DEPENDENCY_IDS = [
  ...DEPENDENCY_IDS,
  "salesforce_service_cloud",
  "talkdesk",
  "segment",
  "snowflake",
  "iceberg",
  "reference_business_api",
  "knowledge_base",
  "email",
  "sms",
] as const;

export const CONNECTOR_HTTP_RESULTS = ["success", "client_error", "server_error", "refused_pre_io", "failed_before_send", "failed_after_send"] as const;
export const CONNECTOR_OPERATION_KINDS = ["read", "write", "subscribe", "reconcile_lookup"] as const;
export const CONNECTOR_OPERATION_RESULTS = ["success", "refused", "schema_drift", "not_started", "failed", "unknown", "error"] as const;
export const CONNECTOR_TOKEN_RESULTS = [
  "issued",
  "scope_narrower",
  "connector_token_scope_broader",
  "connector_token_client_rejected",
  "connector_token_scope_rejected",
  "connector_token_request_rejected",
  "connector_token_response_invalid",
  "connector_token_endpoint_unavailable",
  "connector_account_binding_mismatch",
  "connector_region_mismatch",
  "connector_credential_unavailable",
  "connector_credential_invalid",
  "connector_signing_key_invalid",
  "http_429",
  "http_503",
  "timeout_before_send",
  "connection_refused",
] as const;

export const CONNECTOR_METRICS: readonly MetricDefinition[] = [
  def("vsp_connector_http_requests_total", "counter", "1", "tools_dependencies", "Connector HTTP exchanges by result (refused before I/O, failed before or after the request was sent)", {
    dependency: CONNECTOR_DEPENDENCY_IDS,
    result: CONNECTOR_HTTP_RESULTS,
  }),
  def("vsp_connector_secret_resolutions_total", "counter", "1", "tools_dependencies", "Connector credential resolutions from the secret store by result", {
    result: ["cache_hit", "fetched", "refreshed", "unavailable", "malformed"],
  }),
  def("vsp_connector_token_requests_total", "counter", "1", "tools_dependencies", "Connector token requests and refusals by result (scope and binding checks included)", {
    dependency: CONNECTOR_DEPENDENCY_IDS,
    result: CONNECTOR_TOKEN_RESULTS,
  }),
  def("vsp_rate_limit_rejections_total", "counter", "1", "cost_quotas", "Requests refused by a rate budget before reaching the dependency (budget or vendor pause)", {
    dependency: CONNECTOR_DEPENDENCY_IDS,
    reason: ["budget", "vendor_pause"],
  }),
  def("vsp_rate_limit_waits_total", "counter", "1", "cost_quotas", "Requests delayed by a rate budget or a vendor Retry-After before they started", {
    dependency: CONNECTOR_DEPENDENCY_IDS,
    reason: ["budget", "vendor_pause"],
  }),
  def("vsp_connector_operations_total", "counter", "1", "tools_dependencies", "Connector operations by kind and result (refused, drift, commit outcome)", {
    dependency: CONNECTOR_DEPENDENCY_IDS,
    kind: CONNECTOR_OPERATION_KINDS,
    result: CONNECTOR_OPERATION_RESULTS,
  }),
  def("vsp_connector_operation_latency_ms", "histogram", "ms", "tools_dependencies", "Connector operation latency including budget waits and the single 401 refresh", {
    dependency: CONNECTOR_DEPENDENCY_IDS,
    kind: CONNECTOR_OPERATION_KINDS,
  }),
  def("vsp_connector_capability_ready", "gauge", "1", "tools_dependencies", "1 when the capability passed its active probes, else 0 (labelled with the readiness state)", {
    dependency: CONNECTOR_DEPENDENCY_IDS,
    readiness: ["ready", "not_ready", "unknown"],
  }),
  def("vsp_connector_vendor_quota_remaining_ratio", "gauge", "ratio", "cost_quotas", "Vendor-reported remaining share of the API allocation (from the profile's usage headers)", {
    dependency: CONNECTOR_DEPENDENCY_IDS,
  }),
];

/** Returns a catalogue with the connector metrics added (the base wins on a name clash, which the test forbids). */
export function withConnectorMetrics(base: MetricCatalogue): MetricCatalogue {
  const out = new Map(base);
  for (const d of CONNECTOR_METRICS) if (!out.has(d.name)) out.set(d.name, d);
  return out;
}
