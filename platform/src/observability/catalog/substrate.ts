/**
 * Metric catalogue fragment of the durable substrate (WP-04): the route-audit journal, the audit
 * exporter and verifier, the inbound event inbox and stream ingestion, and SQS dead-letter repair.
 *
 * Module-local catalogue file (docs/followon/work-packages.yaml ownership rules): the phase
 * integration package merges SUBSTRATE_METRICS into the platform catalogue
 * (platform/src/observability/catalog/index.ts, WP-07). Until then `withSubstrateMetrics` extends a
 * catalogue for the modules and tests that emit these metrics, and every emitter guards its metric
 * calls so an unmerged catalogue never changes what is written.
 *
 * Content free like every catalogue entry: labels are closed code enums, never ids, sources or digests.
 */
import type { MetricCatalogue, MetricDefinition } from "../metrics.js";

const def = (
  name: string,
  type: MetricDefinition["type"],
  unit: MetricDefinition["unit"],
  dashboard: MetricDefinition["dashboard"],
  description: string,
  labels: Record<string, readonly string[]> = {},
): MetricDefinition => ({ name, type, unit, dashboard, description, labels });

export const ROUTE_AUDIT_JOURNALS = ["postgres", "dynamodb", "memory"] as const;
export const INBOX_INGEST_RESULTS = [
  "accepted",
  "duplicate",
  "duplicate_conflict",
  "quarantined",
  "auth_rejected",
  "size_rejected",
  "source_unknown",
  "persist_failed",
] as const;
export const INBOX_AUTH_MECHANISMS = ["hmac_sha256_header", "hmac_sha1_header", "jwt_bearer", "mtls", "reconcile_by_lookup", "stream_iam"] as const;
export const INBOX_PROCESS_RESULTS = ["applied", "superseded", "no_projection", "retry_scheduled", "dead_lettered", "quarantined"] as const;

export const SUBSTRATE_METRICS: readonly MetricDefinition[] = [
  // Durable route-audit journal (platform/src/audit/journal.ts) and reconciler (route-reconciler.ts).
  def("vsp_audit_journal_entries_total", "counter", "1", "audit", "Route audit events journaled durably during an audit outage, flushed into the chain later, or not journaled", {
    journal: ROUTE_AUDIT_JOURNALS,
    result: ["journaled", "flushed", "journal_failed", "dropped"],
  }),
  def("vsp_audit_journal_pending", "gauge", "1", "audit", "Route audit events waiting in the durable journal (survive a crash)", { journal: ROUTE_AUDIT_JOURNALS }),
  def("vsp_route_audit_reconciled_total", "counter", "1", "audit", "Routes (safety incidents, route intents) reconciled against their audit evidence", {
    subject: ["safety_incident", "route_intent"],
    result: ["evidenced", "not_recorded"],
  }),
  // Audit exporter and separate verifier (platform/src/audit/exporter).
  def("vsp_audit_manifest_signatures_total", "counter", "1", "audit", "Audit manifests signed by the exporter or checked by the verifier", {
    result: ["signed", "verified", "invalid", "unsigned", "sign_failed"],
  }),
  def("vsp_audit_verifier_runs_total", "counter", "1", "audit", "Independent audit verifier runs by verdict", { verdict: ["pass", "fail", "inconclusive"] }),
  def("vsp_audit_reconciliation_discrepancies_total", "counter", "1", "audit", "Source records without matching exported audit evidence", {
    source: ["committed_action", "provider_receipt", "crm_write", "route_evidence"],
  }),
  // Inbound event inbox (platform/src/ingress).
  def("vsp_inbox_events_total", "counter", "1", "tools_dependencies", "Inbound events by ingestion result (authenticated before persistence, persisted before acknowledgement)", {
    result: INBOX_INGEST_RESULTS,
    auth: [...INBOX_AUTH_MECHANISMS, "none"],
  }),
  def("vsp_inbox_quarantined_total", "counter", "1", "tools_dependencies", "Inbound events quarantined for an unknown event type, schema or field", {
    reason: ["unknown_event_type", "schema_violation", "unknown_field", "payload_unparseable", "other"],
  }),
  def("vsp_inbox_processed_total", "counter", "1", "tools_dependencies", "Inbox processing attempts by result", { result: INBOX_PROCESS_RESULTS }),
  def("vsp_inbox_dead_letter_total", "counter", "1", "tools_dependencies", "Inbound events moved to INBOUND_DEAD after bounded attempts (alarm on any increase)"),
  def("vsp_inbox_replays_total", "counter", "1", "tools_dependencies", "Operator replays of quarantined or dead-lettered inbound events", {
    result: ["replayed", "refused_audit", "refused_policy", "refused_state"],
  }),
  def("vsp_inbox_backlog", "gauge", "1", "tools_dependencies", "Inbound events received and not yet processed"),
  def("vsp_inbox_stream_lag", "gauge", "1", "tools_dependencies", "Stream positions behind the source's newest position (summed over partitions)"),
  def("vsp_inbox_stream_open_gaps", "gauge", "1", "tools_dependencies", "Stream positions passed without processing (dead-lettered or quarantined records not yet replayed)"),
  // SQS dead-letter repair (platform/src/outbox/sqs-dlq.ts).
  def("vsp_outbox_dlq_redrive_total", "counter", "1", "resilience", "SQS dead-letter messages moved back to their source queue by an audited operator repair", {
    result: ["redriven", "refused_audit", "refused_policy", "failed"],
  }),
];

/** Returns a catalogue with the substrate metrics added (the base wins on a name clash; substrate.test.ts proves there is none). */
export function withSubstrateMetrics(base: MetricCatalogue): MetricCatalogue {
  const out = new Map(base);
  for (const d of SUBSTRATE_METRICS) if (!out.has(d.name)) out.set(d.name, d);
  return out;
}
