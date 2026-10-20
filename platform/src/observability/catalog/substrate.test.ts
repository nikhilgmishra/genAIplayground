/**
 * Substrate metric catalogue fragment (WP-04; DATA-01, OPS-03): every name is new to the platform catalogue
 * and to the other module fragments (so `withSubstrateMetrics` never has to resolve a clash), vsp_-named,
 * unique, with closed code-valued label enums; a value outside an enum collapses to "other", so an id, a
 * source or a digest can never become a time series.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_METRIC_CATALOGUE, InMemoryMetrics } from "../metrics.js";
import { CONNECTOR_METRICS } from "./connectors.js";
import { SUBSTRATE_METRICS, withSubstrateMetrics } from "./substrate.js";

describe("substrate metric catalogue [DATA-01]", () => {
  it("[DATA-01][OPS-03] no name clashes with the platform catalogue or another fragment; names are unique and vsp_-prefixed; label enums are closed codes", () => {
    const connectorNames = new Set(CONNECTOR_METRICS.map((d) => d.name));
    for (const d of SUBSTRATE_METRICS) {
      expect(DEFAULT_METRIC_CATALOGUE.has(d.name), d.name).toBe(false);
      expect(connectorNames.has(d.name), d.name).toBe(false);
      expect(d.name).toMatch(/^vsp_[a-z0-9_]+$/);
      for (const values of Object.values(d.labels)) {
        expect(values.length).toBeGreaterThan(0);
        for (const v of values) expect(v).toMatch(/^[a-z0-9][a-z0-9_.-]*$/);
      }
    }
    expect(new Set(SUBSTRATE_METRICS.map((d) => d.name)).size).toBe(SUBSTRATE_METRICS.length);
    const merged = withSubstrateMetrics(DEFAULT_METRIC_CATALOGUE);
    expect(merged.size).toBe(DEFAULT_METRIC_CATALOGUE.size + SUBSTRATE_METRICS.length);
    for (const d of SUBSTRATE_METRICS) expect(merged.get(d.name)).toBe(d);
  });

  it("[DATA-01] adversarial: an inbox id, a source id or a digest passed as a label value collapses to other", () => {
    const m = new InMemoryMetrics({ catalogue: withSubstrateMetrics(DEFAULT_METRIC_CATALOGUE) });
    m.increment("vsp_inbox_events_total", { result: "inb_synthInboxRow000000001", auth: "hmac_sha256_header" });
    m.increment("vsp_inbox_events_total", { result: "accepted", auth: "receipts.synthetic" });
    m.increment("vsp_audit_reconciliation_discrepancies_total", { source: "a".repeat(64) });
    expect(m.find("vsp_inbox_events_total").map((s) => s.labels)).toEqual([
      { result: "other", auth: "hmac_sha256_header" },
      { result: "accepted", auth: "other" },
    ]);
    expect(m.find("vsp_audit_reconciliation_discrepancies_total").map((s) => s.labels)).toEqual([{ source: "other" }]);
  });
});
