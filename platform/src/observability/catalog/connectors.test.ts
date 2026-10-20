/**
 * Connector metric catalogue fragment (WP-06; DATA-01): no name clash with the platform catalogue,
 * closed label enums only, and label values outside an enum collapse to "other" (a host, URL or credential
 * reference can never become a time series).
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_METRIC_CATALOGUE, InMemoryMetrics } from "../metrics.js";
import { CONNECTOR_METRICS, withConnectorMetrics } from "./connectors.js";

describe("connector metric catalogue [DATA-01]", () => {
  it("[DATA-01] every connector metric is new to the platform catalogue, vsp_-named and has closed label enums", () => {
    for (const d of CONNECTOR_METRICS) {
      expect(DEFAULT_METRIC_CATALOGUE.has(d.name), d.name).toBe(false);
      expect(d.name).toMatch(/^vsp_[a-z0-9_]+$/);
      for (const values of Object.values(d.labels)) for (const v of values) expect(v).toMatch(/^[a-z0-9][a-z0-9_.-]*$/);
    }
    expect(new Set(CONNECTOR_METRICS.map((d) => d.name)).size).toBe(CONNECTOR_METRICS.length);
  });

  it("[DATA-01] adversarial: a host, URL or credential reference passed as a label value collapses to other", () => {
    const m = new InMemoryMetrics({ catalogue: withConnectorMetrics(DEFAULT_METRIC_CATALOGUE) });
    m.increment("vsp_connector_http_requests_total", { dependency: "api.vendor.example.com", result: "success" });
    m.increment("vsp_connector_http_requests_total", { dependency: "scheduling", result: "arn:aws:secretsmanager:us-east-1:1:secret:x" });
    expect(m.find("vsp_connector_http_requests_total").map((s) => s.labels)).toEqual([
      { dependency: "other", result: "success" },
      { dependency: "scheduling", result: "other" },
    ]);
  });
});
