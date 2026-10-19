import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { Attributes, Counter, Gauge, Histogram, Meter } from "@opentelemetry/api";
import {
  ADMISSION_CLASSES,
  CONTRACT_INTENTS,
  DEFAULT_METRIC_CATALOGUE,
  InMemoryMetrics,
  MetricCatalogueError,
  OTHER_LABEL_VALUE,
  OpenTelemetryMetrics,
  createMetricCatalogue,
  REPEAT_CONTACT_WINDOWS,
  VERIFICATION_ABUSE_SIGNAL_KINDS,
  normalizeLabels,
} from "./metrics.js";
import { SERVICE_OBJECTIVES } from "./slo.js";
import { PEOPLE, CALLS } from "../fixtures/synthetic-world.js";

/** Spec section 13 operational dashboards and the metrics that cover each. */
const DASHBOARD_COVERAGE: Record<string, string[]> = {
  "call arrivals": ["vsp_call_arrivals_total"],
  "live sessions": ["vsp_live_sessions"],
  "queue age": ["vsp_queue_age_ms"],
  abandonment: ["vsp_abandonments_total"],
  "human demand": ["vsp_human_demand_total"],
  transfers: ["vsp_transfers_total"],
  disconnects: ["vsp_disconnects_total"],
  "identity success": ["vsp_identity_verifications_total"],
  "challenge abuse": ["vsp_challenge_abuse_signals_total"],
  denials: ["vsp_identity_denials_total"],
  "tool latency": ["vsp_tool_latency_ms"],
  "dependency health": ["vsp_dependency_health"],
  "unknown commits": ["vsp_unknown_commits_total"],
  backlog: ["vsp_backlog_items"],
  "safety signals": ["vsp_safety_signals_total"],
  "time to routing": ["vsp_safety_time_to_routing_ms"],
  "completed handoffs": ["vsp_safety_handoffs_total"],
  "unsupported clinical requests": ["vsp_unsupported_clinical_requests_total"],
  "CRM reconciliation": ["vsp_crm_reconciliation_total", "vsp_crm_sync_lag_ms"],
  "knowledge freshness": ["vsp_knowledge_freshness_age_seconds"],
  "ASR corrections and interruptions": ["vsp_interruptions_total"],
  "cost and quotas": ["vsp_cost_usd_micro_total", "vsp_quota_utilization_ratio", "vsp_budget_utilization_ratio"],
  "audit-export completeness": ["vsp_audit_export_completeness_ratio"],
};

/** Catalogue entries requested by the module reports (interface change requests), with their label keys. */
const REQUESTED_METRICS: Record<string, string[]> = {
  vsp_voice_gate_renders_total: ["response_class"],
  vsp_voice_gate_rejections_total: ["disposition", "reason"],
  vsp_retention_deleted_total: ["data_class"],
  vsp_retention_classes_blocked: ["data_class", "reason"],
  vsp_retention_unverified_copies: ["location", "status"],
  vsp_vendor_deletion_requests_pending: ["vendor"],
  vsp_redaction_results_total: ["result"],
  vsp_egress_denied_total: ["reason"],
  vsp_knowledge_ingest_items_total: ["result"],
  vsp_knowledge_search_recheck_dropped_total: ["reason"],
  vsp_memory_recap_withheld_total: ["reason"],
  vsp_safety_time_to_routing_ms: ["signal_source"],
  vsp_worker_loop_runs_total: ["loop", "result"],
  vsp_worker_loop_errors_total: ["loop"],
  vsp_worker_loop_processed_total: ["loop"],
  vsp_worker_loop_lag_ms: ["loop"],
  vsp_worker_loop_duration_ms: ["loop"],
  vsp_grant_checks_total: ["guard", "result"],
  vsp_verified_resolutions_total: ["intent", "source"],
  vsp_contained_interactions_total: ["intent", "outcome"],
  vsp_repeat_contacts_total: ["prior_intent", "prior_outcome", "window"],
  vsp_repeat_contact_checks_total: ["result"],
  vsp_case_status_observations_total: ["case_state"],
  vsp_cases_reopened_total: ["issue_category"],
  vsp_verification_abuse_signals_total: ["signal"],
};

/** Spec section 13 resolution measures ("Measure verified resolution, 24-hour and 7-day repeat contact, reopened cases ... Keep containment separate"). */
const RESOLUTION_MEASURES: Record<string, string[]> = {
  "verified resolution": ["vsp_verified_resolutions_total"],
  "24-hour and 7-day repeat contact": ["vsp_repeat_contacts_total", "vsp_repeat_contact_checks_total"],
  "reopened cases": ["vsp_cases_reopened_total", "vsp_case_status_observations_total"],
  containment: ["vsp_contained_interactions_total"],
};

describe("metric catalogue", () => {
  it("[SPEC-13.metrics][DATA-01] the catalogue entries requested by the module reports exist with closed label enums", () => {
    for (const [name, keys] of Object.entries(REQUESTED_METRICS)) {
      const d = DEFAULT_METRIC_CATALOGUE.get(name);
      expect(d, name).toBeDefined();
      expect(Object.keys(d?.labels ?? {}).sort(), name).toEqual([...keys].sort());
    }
    const m = new InMemoryMetrics();
    m.increment("vsp_worker_loop_runs_total", { loop: "Synthetic Person 555 0101", result: "ok" });
    m.increment("vsp_egress_denied_total", { reason: "EGRESS_URL_INSECURE" });
    m.increment("vsp_safety_signals_total", { signal_source: "fail_safe" });
    expect(m.counterValue("vsp_worker_loop_runs_total", { loop: OTHER_LABEL_VALUE, result: "ok" })).toBe(1);
    expect(m.counterValue("vsp_egress_denied_total", { reason: "EGRESS_URL_INSECURE" })).toBe(1);
    expect(m.counterValue("vsp_safety_signals_total", { signal_source: "fail_safe" })).toBe(1);
    expect(JSON.stringify(m.allSeries())).not.toContain("555");
  });

  it("[SPEC-13.dashboards] covers every operational dashboard listed in spec section 13", () => {
    for (const [dashboard, names] of Object.entries(DASHBOARD_COVERAGE)) {
      for (const name of names) expect(DEFAULT_METRIC_CATALOGUE.has(name), `${dashboard}: ${name}`).toBe(true);
    }
  });

  it("[DATA-01] every label key has a closed, non-empty enum of code-constant values", () => {
    for (const d of DEFAULT_METRIC_CATALOGUE.values()) {
      for (const [key, values] of Object.entries(d.labels)) {
        expect(key).toMatch(/^[a-z][a-z0-9_]{1,40}$/);
        expect(values.length).toBeGreaterThan(0);
        for (const v of values) {
          expect(v).toMatch(/^[A-Za-z0-9*][A-Za-z0-9._+*-]{0,63}$/);
          expect(v).not.toMatch(/\d{7,}/);
        }
      }
    }
  });

  it("[DATA-01] dynamic extensions reject PHI-like values (phone numbers, emails, free text)", () => {
    expect(() => createMetricCatalogue({ toolNames: ["get_status_for_+15555550101"] })).toThrow("METRIC_LABEL_VALUE_UNSAFE");
    expect(() => createMetricCatalogue({ intents: ["Avery Synthetic-Client"] })).toThrow("METRIC_LABEL_VALUE_UNSAFE");
    expect(() => createMetricCatalogue({ models: ["someone@example.com"] })).toThrow("METRIC_LABEL_VALUE_UNSAFE");
    expect(() => createMetricCatalogue({ voices: ["5555550101"] })).toThrow("METRIC_LABEL_VALUE_UNSAFE");
    const ok = createMetricCatalogue({ models: ["nova-model-2026-10-05"], toolNames: ["get_new_tool"] });
    expect(ok.get("vsp_turn_latency_ms")?.labels.model).toContain("nova-model-2026-10-05");
    expect(ok.get("vsp_tool_calls_total")?.labels.tool).toContain("get_new_tool");
  });

  it("[SPEC-13.resolution-metrics][DATA-01] resolution, containment, repeat-contact and reopened-case measures exist with content-free labels only", () => {
    for (const [measure, names] of Object.entries(RESOLUTION_MEASURES)) {
      for (const name of names) {
        const d = DEFAULT_METRIC_CATALOGUE.get(name);
        expect(d, `${measure}: ${name}`).toBeDefined();
        expect(d?.dashboard, name).toBe("resolution");
        // No identifier-shaped label key (subject, actor, account, call, session, case or request ids).
        for (const key of Object.keys(d?.labels ?? {})) expect(key, name).not.toMatch(/subject|actor|account|call|session|case_id|request|reference|_ref$|_id$/);
      }
    }
    const windows = DEFAULT_METRIC_CATALOGUE.get("vsp_repeat_contacts_total")?.labels.window ?? [];
    expect(windows).toEqual([...REPEAT_CONTACT_WINDOWS]);
    expect(windows).toEqual(expect.arrayContaining(["24h", "7d"]));
    // Verified resolution has no outcome dimension: only RESOLVED counts (ACT-04).
    expect(Object.keys(DEFAULT_METRIC_CATALOGUE.get("vsp_verified_resolutions_total")?.labels ?? {})).not.toContain("outcome");
    // Intent labels accept every resolution-contract intent and "unknown" (no silent collapse to other).
    for (const name of ["vsp_interaction_outcomes_total", "vsp_verified_resolutions_total", "vsp_contained_interactions_total"]) {
      expect(DEFAULT_METRIC_CATALOGUE.get(name)?.labels.intent, name).toEqual(expect.arrayContaining([...CONTRACT_INTENTS]));
    }
    expect(DEFAULT_METRIC_CATALOGUE.get("vsp_repeat_contacts_total")?.labels.prior_intent).toEqual(expect.arrayContaining([...CONTRACT_INTENTS]));
    const m = new InMemoryMetrics();
    m.increment("vsp_repeat_contacts_total", { window: "24h", prior_outcome: "RESOLVED", prior_intent: "appointment_reschedule", subject_ref: PEOPLE.avery.subjectId as string });
    m.increment("vsp_interaction_outcomes_total", { outcome: "OUTCOME_UNKNOWN", intent: "unknown" });
    expect(m.counterValue("vsp_repeat_contacts_total", { window: "24h", prior_outcome: "RESOLVED", prior_intent: "appointment_reschedule" })).toBe(1);
    expect(m.counterValue("vsp_interaction_outcomes_total", { intent: "unknown" })).toBe(1);
    expect(m.counterValue("vsp_metric_label_rejections_total", { action: "key_dropped" })).toBe(1);
    expect(m.counterValue("vsp_metric_label_rejections_total", { action: "collapsed_to_other" })).toBe(0);
    expect(JSON.stringify(m.allSeries())).not.toContain(PEOPLE.avery.subjectId as string);
  });

  it("[SPEC-13.resolution-metrics] no service objective is measured on containment or rewards a call for avoiding a transfer", () => {
    const resolutionMetrics = new Set(Object.values(RESOLUTION_MEASURES).flat());
    for (const slo of SERVICE_OBJECTIVES) expect(resolutionMetrics.has(slo.metric), slo.id).toBe(false);
    expect(SERVICE_OBJECTIVES.some((s) => s.metric === "vsp_contained_interactions_total")).toBe(false);
  });

  it("[SPEC-13.dashboards][DATA-01] the verification abuse metric is labelled with the closed signal kind only", () => {
    const d = DEFAULT_METRIC_CATALOGUE.get("vsp_verification_abuse_signals_total");
    expect(d).toMatchObject({ type: "counter", dashboard: "identity" });
    expect(d?.labels).toEqual({ signal: [...VERIFICATION_ABUSE_SIGNAL_KINDS] });
    const m = new InMemoryMetrics();
    m.increment("vsp_verification_abuse_signals_total", { signal: "OTP_ACCOUNT_LIMIT", account: PEOPLE.avery.accountId as string, session: "ses_synthSessionRef000001" });
    m.increment("vsp_verification_abuse_signals_total", { signal: PEOPLE.avery.accountId as string });
    expect(m.counterValue("vsp_verification_abuse_signals_total", { signal: "OTP_ACCOUNT_LIMIT" })).toBe(1);
    expect(m.counterValue("vsp_verification_abuse_signals_total", { signal: OTHER_LABEL_VALUE })).toBe(1);
    const serialized = JSON.stringify(m.allSeries());
    expect(serialized).not.toContain(PEOPLE.avery.accountId as string);
    expect(serialized).not.toContain("ses_synthSessionRef000001");
  });

  it("[SPEC-13.admission] admission class label enum matches the AdmissionClass port", () => {
    expect([...ADMISSION_CLASSES].sort()).toEqual(["ANALYTICS", "HUMAN_ROUTE", "PROTECTED_READ", "PUBLIC", "SAFETY", "WRITE"]);
  });
});

describe("InMemoryMetrics (LOCAL FIXTURE)", () => {
  it("[DATA-01] metric labels with PHI-like values collapse to other", () => {
    const m = new InMemoryMetrics();
    m.increment("vsp_call_arrivals_total", { audience: PEOPLE.avery.fullName, language: "en", entry: CALLS.primary.callerIdE164 });
    m.increment("vsp_call_arrivals_total", { audience: "client", language: PEOPLE.avery.dateOfBirth, entry: "ai" });
    const series = m.allSeries().filter((s) => s.name === "vsp_call_arrivals_total");
    const allValues = series.flatMap((s) => Object.values(s.labels));
    expect(allValues).not.toContain(PEOPLE.avery.fullName);
    expect(allValues).not.toContain(CALLS.primary.callerIdE164);
    expect(allValues).not.toContain(PEOPLE.avery.dateOfBirth);
    expect(m.counterValue("vsp_call_arrivals_total", { audience: OTHER_LABEL_VALUE })).toBe(1);
    expect(m.counterValue("vsp_call_arrivals_total", { language: OTHER_LABEL_VALUE })).toBe(1);
    expect(m.counterValue("vsp_metric_label_rejections_total", { action: "collapsed_to_other" })).toBe(3);
  });

  it("[DATA-01] undeclared label keys are dropped, never stored", () => {
    const m = new InMemoryMetrics();
    m.increment("vsp_tool_calls_total", { tool: "get_invoice_status", status: "SUCCESS", callerName: PEOPLE.blake.fullName });
    const [s] = m.find("vsp_tool_calls_total");
    expect(s?.labels).toEqual({ status: "SUCCESS", tool: "get_invoice_status" });
    expect(m.counterValue("vsp_metric_label_rejections_total", { action: "key_dropped" })).toBe(1);
  });

  it("[DATA-01] property: no arbitrary string ever survives as a label value unless it is in the allowlist", () => {
    const def = DEFAULT_METRIC_CATALOGUE.get("vsp_turn_latency_ms");
    if (!def) throw new Error("missing def");
    fc.assert(
      fc.property(fc.dictionary(fc.string({ minLength: 1, maxLength: 12 }), fc.string({ maxLength: 40 })), (labels) => {
        const n = normalizeLabels(def, labels);
        for (const [k, v] of Object.entries(n.labels)) {
          expect(Object.hasOwn(def.labels, k)).toBe(true);
          const allowed = def.labels[k];
          expect(v === OTHER_LABEL_VALUE || (allowed ?? []).includes(v)).toBe(true);
        }
      }),
    );
  });

  it("[SPEC-13.dashboards] unknown metric names and wrong instrument types throw in tests", () => {
    const m = new InMemoryMetrics();
    expect(() => m.increment("vsp_not_a_metric_total")).toThrow(MetricCatalogueError);
    expect(() => m.observe("vsp_call_arrivals_total", 5)).toThrow("METRIC_TYPE_MISMATCH");
    expect(() => m.increment("vsp_call_arrivals_total", {}, -1)).toThrow("METRIC_VALUE_INVALID");
    expect(() => m.gauge("vsp_live_sessions", Number.NaN)).toThrow("METRIC_VALUE_INVALID");
  });

  it("[SPEC-13.dashboards] lenient mode drops unknown metrics without throwing and counts them", () => {
    const m = new InMemoryMetrics({ unknownMetric: "drop" });
    m.increment("vsp_not_a_metric_total");
    expect(m.droppedCalls).toBe(1);
    expect(m.allSeries()).toHaveLength(0);
  });

  it("[SPEC-13.dashboards] records counters, gauges and histogram observations", () => {
    const m = new InMemoryMetrics();
    m.increment("vsp_tool_calls_total", { tool: "get_invoice_status", status: "SUCCESS" }, 2);
    m.gauge("vsp_live_sessions", 12, { session_mode: "ai" });
    m.gauge("vsp_live_sessions", 9, { session_mode: "ai" });
    m.observe("vsp_tool_latency_ms", 40, { tool: "get_invoice_status", status: "SUCCESS" });
    m.observe("vsp_tool_latency_ms", 60, { tool: "get_invoice_status", status: "SUCCESS" });
    expect(m.counterValue("vsp_tool_calls_total")).toBe(2);
    expect(m.gaugeValue("vsp_live_sessions", { session_mode: "ai" })).toBe(9);
    expect(m.observations("vsp_tool_latency_ms")).toEqual([40, 60]);
  });
});

describe("OpenTelemetryMetrics bridge", () => {
  /** LOCAL TEST FIXTURE meter capturing instrument calls. */
  function fixtureMeter() {
    const calls: { instrument: string; kind: string; value: number; attributes: Attributes | undefined }[] = [];
    const meter = {
      createCounter: (name: string) => ({ add: (value: number, attributes?: Attributes) => calls.push({ instrument: name, kind: "counter", value, attributes }) }) as unknown as Counter,
      createHistogram: (name: string) => ({ record: (value: number, attributes?: Attributes) => calls.push({ instrument: name, kind: "histogram", value, attributes }) }) as unknown as Histogram,
      createGauge: (name: string) => ({ record: (value: number, attributes?: Attributes) => calls.push({ instrument: name, kind: "gauge", value, attributes }) }) as unknown as Gauge,
    } as unknown as Meter;
    return { meter, calls };
  }

  it("[DATA-01] passes only allowlisted attributes to OpenTelemetry instruments", () => {
    const { meter, calls } = fixtureMeter();
    const m = new OpenTelemetryMetrics({ meter });
    m.increment("vsp_identity_denials_total", { reason: "SESSION_EXPIRED", phone: CALLS.primary.callerIdE164 });
    m.observe("vsp_queue_age_ms", 1200, { queue_purpose: PEOPLE.casey.fullName });
    m.gauge("vsp_backlog_items", 3, { backlog: "outbox" });
    const denial = calls.find((c) => c.instrument === "vsp_identity_denials_total");
    expect(denial?.attributes).toEqual({ reason: "SESSION_EXPIRED" });
    const queue = calls.find((c) => c.instrument === "vsp_queue_age_ms");
    expect(queue?.attributes).toEqual({ queue_purpose: OTHER_LABEL_VALUE });
    expect(calls.find((c) => c.instrument === "vsp_backlog_items")?.value).toBe(3);
    const serialized = JSON.stringify(calls);
    expect(serialized).not.toContain(CALLS.primary.callerIdE164);
    expect(serialized).not.toContain(PEOPLE.casey.fullName);
  });

  it("[SPEC-13.dashboards] works against the default no-op global meter and drops unknown names", () => {
    const m = new OpenTelemetryMetrics();
    expect(() => m.increment("vsp_call_arrivals_total", { entry: "ai" })).not.toThrow();
    m.increment("vsp_unknown_total");
    expect(m.droppedCalls).toBe(1);
  });
});
