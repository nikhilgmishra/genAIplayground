/**
 * OTLP/HTTP JSON export (WP-07; FO-03-30, DATA-01): the SDK pipeline with the platform exporters over a
 * capturing sender (a UNIT FAKE of the transport: it records the request bodies; the egress-classified
 * transport and a real collector are exercised in platform/test/integration/composition/telemetry.test.ts).
 */
import { SpanStatusCode } from "@opentelemetry/api";
import { describe, expect, it } from "vitest";
import { PLATFORM_METRIC_CATALOGUE } from "./catalog/index.js";
import { InMemoryMetrics } from "./metrics.js";
import { encodeMetricsRequest, encodeTraceRequest, sanitizeResourceAttributes } from "./otlp.js";
import type { OtlpPost } from "./otlp.js";
import { startTelemetry } from "./telemetry.js";

class CapturingOtlpPostFixture implements OtlpPost {
  readonly bodies: { url: string; body: unknown }[] = [];
  status = 200;
  fail: Error | null = null;
  async post(url: URL, body: string): Promise<{ status: number }> {
    if (this.fail) throw this.fail;
    this.bodies.push({ url: url.pathname, body: JSON.parse(body) as unknown });
    return { status: this.status };
  }
}

const otlp = { metricsUrl: "https://otel.collector.example.test/v1/metrics", tracesUrl: "https://otel.collector.example.test/v1/traces", exportIntervalMs: 60_000, timeoutMs: 2_000 };

function telemetry(post: OtlpPost | null, withOtlp = true) {
  return startTelemetry({ serviceName: "vsp-gateway", serviceVersion: "0.1.0", environment: "sandbox", instanceId: "gateway-1", catalogue: PLATFORM_METRIC_CATALOGUE, otlp: withOtlp ? otlp : null, post });
}

type Json = Record<string, unknown>;
const metricsOf = (body: unknown): Json[] => ((body as Json).resourceMetrics as Json[]).flatMap((rm) => (rm.scopeMetrics as Json[]).flatMap((sm) => sm.metrics as Json[]));
const spansOf = (body: unknown): Json[] => ((body as Json).resourceSpans as Json[]).flatMap((rs) => (rs.scopeSpans as Json[]).flatMap((ss) => ss.spans as Json[]));
const attrKeys = (attrs: unknown): string[] => (attrs as { key: string }[]).map((a) => a.key);

describe("OTLP/HTTP JSON exporters [FO-03-30][DATA-01]", () => {
  it("[FO-03-30] metrics: catalogue series reach the sender as OTLP JSON (sum, gauge, histogram) with only declared labels; the resource names the service only", async () => {
    const post = new CapturingOtlpPostFixture();
    const t = telemetry(post);
    t.metrics.increment("vsp_capability_refusals_total", { capability: "domain.business_systems", surface: "admission" });
    t.metrics.gauge("vsp_capability_state", 1, { capability: "platform.substrate", state: "configured" });
    t.metrics.observe("vsp_worker_loop_duration_ms", 12, { loop: "outbox.dispatch" });
    await t.forceFlush();
    const req = post.bodies.find((b) => b.url === "/v1/metrics");
    expect(req).toBeDefined();
    const metrics = metricsOf(req?.body);
    const byName = new Map(metrics.map((m) => [m.name as string, m]));
    const sum = byName.get("vsp_capability_refusals_total") as { sum: { isMonotonic: boolean; aggregationTemporality: number; dataPoints: Json[] } };
    expect(sum.sum).toMatchObject({ isMonotonic: true, aggregationTemporality: 2 });
    expect(sum.sum.dataPoints[0]).toMatchObject({ asDouble: 1, attributes: [{ key: "capability", value: { stringValue: "domain.business_systems" } }, { key: "surface", value: { stringValue: "admission" } }] });
    expect((byName.get("vsp_capability_state") as { gauge: { dataPoints: Json[] } }).gauge.dataPoints[0]).toMatchObject({ asDouble: 1 });
    expect((byName.get("vsp_worker_loop_duration_ms") as { histogram: { dataPoints: Json[] } }).histogram.dataPoints[0]).toMatchObject({ count: "1", sum: 12 });
    const resource = ((req?.body as Json).resourceMetrics as Json[])[0]?.resource as { attributes: { key: string }[] };
    expect(attrKeys(resource.attributes).sort()).toEqual(["deployment.environment.name", "service.instance.id", "service.name", "service.version"]);
    await t.shutdown();
  });

  it("[DATA-01] adversarial: an id, a name or free text passed as a label value is exported as other; an undeclared key is never exported", async () => {
    const post = new CapturingOtlpPostFixture();
    const t = telemetry(post);
    t.metrics.increment("vsp_capability_refusals_total", { capability: "tnt_synthTenantForExport01", surface: "Jane Example", phone: "5550100" });
    await t.forceFlush();
    const body = JSON.stringify(post.bodies.map((b) => b.body));
    expect(body).not.toContain("tnt_synthTenantForExport01");
    expect(body).not.toContain("Jane Example");
    expect(body).not.toContain("5550100");
    expect(body).not.toContain("phone");
    const m = metricsOf(post.bodies.find((b) => b.url === "/v1/metrics")?.body).find((x) => x.name === "vsp_capability_refusals_total") as { sum: { dataPoints: { attributes: unknown }[] } };
    expect(m.sum.dataPoints[0]?.attributes).toEqual([{ key: "capability", value: { stringValue: "other" } }, { key: "surface", value: { stringValue: "other" } }]);
    await t.shutdown();
  });

  it("[DATA-01] defence in depth: a series or label that bypassed the emitter allowlist is dropped at encoding and counted", () => {
    const now: [number, number] = [1_760_000_000, 0];
    const rm = {
      resource: { attributes: { "service.name": "vsp-gateway", "host.name": "ip-10-0-0-1.internal", "user.email": "someone@example.test" } },
      scopeMetrics: [
        {
          scope: { name: "vsp-platform" },
          metrics: [
            { descriptor: { name: "vsp_unknown_series_total", description: "", unit: "1", valueType: 1 }, aggregationTemporality: 1, dataPointType: 3, isMonotonic: true, dataPoints: [{ startTime: now, endTime: now, attributes: {}, value: 1 }] },
            {
              descriptor: { name: "vsp_capability_refusals_total", description: "", unit: "1", valueType: 1 },
              aggregationTemporality: 1,
              dataPointType: 3,
              isMonotonic: true,
              dataPoints: [{ startTime: now, endTime: now, attributes: { capability: "crm.salesforce", surface: "hold", subjectId: "sub_synthSubjectExport001" }, value: 2 }],
            },
          ],
        },
      ],
    } as unknown as Parameters<typeof encodeMetricsRequest>[0];
    const enc = encodeMetricsRequest(rm, PLATFORM_METRIC_CATALOGUE);
    expect(enc.body).not.toContain("vsp_unknown_series_total");
    expect(enc.body).not.toContain("sub_synthSubjectExport001");
    expect(enc.body).not.toContain("someone@example.test");
    expect(enc.body).not.toContain("ip-10-0-0-1");
    // unknown series 1 + subjectId attribute 1 + two resource attributes 2
    expect(enc.dropped).toBe(4);
    expect(sanitizeResourceAttributes({ "service.instance.id": "gateway-5550100123" }).dropped).toBe(1);
  });

  it("[FO-03-30][DATA-01] traces: allowlisted span attributes only, baggage never, exceptions never; a refused attribute is counted", async () => {
    const post = new CapturingOtlpPostFixture();
    const t = telemetry(post);
    await t.tracer.withSpan("gateway.http.request", { "vsp.operation": "tools.invoke", "vsp.http_method": "POST", "caller.phone": "555-0100", "vsp.request_id": "req_synthRequestExport000001" }, async (span) => {
      span.setAttribute("vsp.http_status_code", 200);
      span.setAttribute("free.text", "my appointment is tomorrow");
      span.addEvent("pipeline.policy_decided", { "vsp.reason_code": "POLICY_ALLOW", note: "freeform" });
    });
    await t.tracer
      .withSpan("gateway.http.request", { "vsp.operation": "tools.invoke" }, async () => {
        throw new Error("dependency said: patient Jane Example missed appointment");
      })
      .catch(() => undefined);
    await t.forceFlush();
    const req = post.bodies.find((b) => b.url === "/v1/traces");
    expect(req).toBeDefined();
    const body = JSON.stringify(req?.body);
    for (const leaked of ["555-0100", "caller.phone", "free.text", "tomorrow", "freeform", "Jane Example", "missed appointment"]) expect(body).not.toContain(leaked);
    const spans = spansOf(req?.body);
    expect(spans).toHaveLength(2);
    expect(attrKeys(spans[0]?.attributes)).toEqual(expect.arrayContaining(["vsp.operation", "vsp.http_method", "vsp.request_id", "vsp.http_status_code"]));
    expect(spans[1]?.status).toEqual({ code: 2, message: "UNCLASSIFIED_ERROR" });
    expect(spans[0]).toMatchObject({ kind: 1, name: "gateway.http.request" });
    expect(String(spans[0]?.traceId)).toMatch(/^[0-9a-f]{32}$/);
    await t.shutdown();
  });

  it("[DATA-01][FO-03-30] adversarial: a span of the RAW tracer (no SafeTracer) with content in its name, attributes, events, status and links is exported without any of it, and every drop is counted", async () => {
    const post = new CapturingOtlpPostFixture();
    const local = new InMemoryMetrics({ catalogue: PLATFORM_METRIC_CATALOGUE });
    const t = startTelemetry({ serviceName: "vsp-gateway", serviceVersion: "0.1.0", environment: "sandbox", instanceId: "gateway-1", catalogue: PLATFORM_METRIC_CATALOGUE, otlp, post, localMetrics: local });
    const SENT = "SENTINELcontent5550142";
    const other = t.rawTracer.startSpan("dependency.call");
    other.end();
    const s = t.rawTracer.startSpan(`patient.${SENT.toLowerCase()}`, {
      attributes: { "caller.name": `Jane ${SENT}`, "vsp.tool": `lookup ${SENT}`, "http.url": `https://x.example.test/?q=${SENT}`, "vsp.request_id": "req_synthRequestExport000002" },
      links: [{ context: other.spanContext(), attributes: { note: SENT } }],
    });
    s.addEvent("pipeline.policy_decided", { "vsp.reason_code": "POLICY_ALLOW", "caller.utterance": SENT });
    s.addEvent(`caller said ${SENT}`);
    s.setStatus({ code: SpanStatusCode.ERROR, message: `failed for ${SENT}` });
    s.end();
    await t.forceFlush();
    const req = post.bodies.find((b) => b.url === "/v1/traces");
    expect(req).toBeDefined();
    const body = JSON.stringify(req?.body);
    for (const leaked of [SENT, SENT.toLowerCase(), "caller.name", "caller.utterance", "http.url", "Jane", "lookup", "links"]) expect(body, leaked).not.toContain(leaked);
    const span = spansOf(req?.body).find((x) => x.name === "invalid_span_name") as { attributes: { key: string; value: { stringValue: string } }[]; events: { name: string; attributes: unknown }[]; status: Json } | undefined;
    expect(span).toBeDefined();
    expect(span?.attributes).toEqual([{ key: "vsp.request_id", value: { stringValue: "req_synthRequestExport000002" } }]);
    expect(span?.events.map((e) => e.name)).toEqual(["pipeline.policy_decided", "invalid_event_name"]);
    expect(span?.events[0]?.attributes).toEqual([{ key: "vsp.reason_code", value: { stringValue: "POLICY_ALLOW" } }]);
    expect(span?.status).toEqual({ code: 2 });
    // Dropped: 3 span attributes, 1 event attribute, 1 event name, the status message, the span name and the link.
    expect(local.counterValue("vsp_telemetry_attributes_dropped_total", { signal: "traces" })).toBe(8);
    await t.shutdown();
  });

  it("[DATA-01][FO-03-30] adversarial: the instrumentation scope is a closed name and a version label; a scope or version built from content is replaced or dropped and counted", () => {
    const span = (scope: { name: string; version?: string }) =>
      ({
        spanContext: () => ({ traceId: "a".repeat(32), spanId: "b".repeat(16), traceFlags: 1 }),
        resource: { attributes: { "service.name": "vsp-gateway" } },
        instrumentationScope: scope,
        attributes: {},
        links: [],
        events: [],
        status: { code: 0 },
        name: "tool.invoke",
        kind: 0,
        startTime: [1, 0],
        endTime: [1, 1000],
      }) as unknown as Parameters<typeof encodeTraceRequest>[0][number];
    const scopesOf = (r: { body: string }) => (JSON.parse(r.body) as { resourceSpans: { scopeSpans: { scope: unknown }[] }[] }).resourceSpans.flatMap((x) => x.scopeSpans.map((y) => y.scope));
    const ok = encodeTraceRequest([span({ name: "vsp-platform", version: "2026-10-17.1" })]);
    expect(scopesOf(ok)).toEqual([{ name: "vsp-platform", version: "2026-10-17.1" }]);
    expect(ok.dropped).toBe(0);
    const bad = encodeTraceRequest([span({ name: "patient-jane-doe", version: "dob 1980-01-01 5550142123" })]);
    expect(scopesOf(bad)).toEqual([{ name: "invalid_scope" }]);
    expect(bad.dropped).toBe(2);
    expect(bad.body).not.toMatch(/jane|5550142123|1980/);
  });

  it("[FO-03-30] failure: a rejected or failed export never throws into the SDK and is counted; without an endpoint nothing is sent", async () => {
    const post = new CapturingOtlpPostFixture();
    post.status = 503;
    const t = telemetry(post);
    t.metrics.increment("vsp_capability_refusals_total", { capability: "crm.salesforce", surface: "hold" });
    await t.forceFlush();
    post.status = 200;
    await t.forceFlush();
    const second = post.bodies.at(-1);
    const exportCounter = metricsOf(second?.body).find((m) => m.name === "vsp_telemetry_export_total") as { sum: { dataPoints: { attributes: { key: string; value: { stringValue: string } }[] }[] } } | undefined;
    const results = exportCounter?.sum.dataPoints.map((p) => p.attributes.find((a) => a.key === "result")?.value.stringValue);
    expect(results).toContain("failed");
    post.fail = Object.assign(new Error("transport"), { reasonCode: "CONNECTOR_HOST_NOT_ALLOWED" });
    await expect(t.forceFlush()).resolves.toBeUndefined();
    await t.shutdown();

    const silent = new CapturingOtlpPostFixture();
    const off = telemetry(silent, false);
    off.metrics.increment("vsp_capability_refusals_total", { capability: "crm.salesforce", surface: "hold" });
    await off.forceFlush();
    expect(silent.bodies).toEqual([]);
    expect(off.exporting).toEqual({ metrics: false, traces: false });
    await off.shutdown();
    expect(() => telemetry(null, true)).toThrow("TELEMETRY_SENDER_REQUIRED");
  });
});
