/**
 * OTLP/HTTP JSON exporters for metrics and traces (WP-07; FO-03-30, DATA-01, FO-15-19).
 *
 * The OpenTelemetry SDK (MeterProvider, NodeTracerProvider) aggregates and batches; these exporters encode
 * one batch as an OTLP/HTTP JSON request (opentelemetry-proto JSON mapping: ExportMetricsServiceRequest at
 * `/v1/metrics`, ExportTraceServiceRequest at `/v1/traces`) and hand the body to an `OtlpPost` port. The live
 * composition binds that port to the egress-classified connector transport (platform/src/connectors/http):
 * https only, the collector host on the destination allowlist, the EgressGuard checked per request for the
 * INTERNAL (content-free telemetry) class, DNS pinned, redirects refused. The SDK's own OTLP exporters are not
 * used: they open sockets outside that transport.
 *
 * Content stays out (defence in depth behind the catalogue and the span allowlist, which already normalise
 * every value at the emitter):
 *   - a metric that is not in the platform catalogue is not exported;
 *   - a data-point attribute is exported only when its key is a declared label of that metric and its value
 *     is one of the label's closed codes (or `other`);
 *   - a span keeps only SPAN_ATTRIBUTE_ALLOWLIST attributes with valid values, span and event names from the
 *     closed registries of tracing.ts (SPAN_NAMES, SPAN_EVENT_NAMES; anything else is exported as
 *     invalid_span_name / invalid_event_name) and a reason-code status message; links are never exported.
 *     This holds for spans of the raw tracer too (Telemetry.rawTracer bypasses SafeTracer, so the exporter is
 *     the only filter there);
 *   - resource attributes are limited to the service identity keys with code-like values.
 * Every dropped attribute is counted in vsp_telemetry_attributes_dropped_total{signal} (alarm
 * `telemetry-attribute-dropped`). Export failures never throw into the SDK: the batch is reported FAILED and
 * counted in vsp_telemetry_export_total{signal,result}.
 */
import type { AttributeValue, Attributes, HrTime } from "@opentelemetry/api";
import type { PushMetricExporter, ResourceMetrics } from "@opentelemetry/sdk-metrics";
import { AggregationTemporality, DataPointType } from "@opentelemetry/sdk-metrics";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-node";
import { silentLogger } from "./logger.js";
import { noopMetrics } from "./metrics.js";
import type { MetricCatalogue } from "./metrics.js";
import type { Logger, Metrics } from "./ports.js";
import { SPAN_ATTRIBUTE_ALLOWLIST, isSpanReasonCode, spanEventNameOf, spanNameOf } from "./tracing.js";

/** Sends one OTLP/HTTP JSON request body; resolves with the HTTP status, rejects when nothing was answered. */
export interface OtlpPost {
  post(url: URL, body: string, timeoutMs: number): Promise<{ status: number }>;
}

type MetricExportResult = Parameters<Parameters<PushMetricExporter["export"]>[1]>[0];
type SpanExportResult = Parameters<Parameters<SpanExporter["export"]>[1]>[0];
/** ExportResultCode of @opentelemetry/core: SUCCESS = 0, FAILED = 1 (stable enum values of the SDK API). */
const SUCCESS = 0;
const FAILED = 1;

type AnyValue = { stringValue: string } | { boolValue: boolean } | { intValue: string } | { doubleValue: number } | { arrayValue: { values: AnyValue[] } };
interface KeyValue {
  key: string;
  value: AnyValue;
}

const REASON_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
/** Instrumentation scope names a platform span may carry (telemetry.ts getTracer); anything else is replaced. */
export const SPAN_SCOPE_NAMES: readonly string[] = ["vsp-platform"];
const SCOPE_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/;
const RESOURCE_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/;
const LONG_DIGIT_RUN = /\d{9,}/;
/** Resource attributes that identify the service; nothing else describes a process in an export. */
export const RESOURCE_ATTRIBUTE_ALLOWLIST: readonly string[] = [
  "service.name",
  "service.namespace",
  "service.version",
  "service.instance.id",
  "deployment.environment.name",
  "telemetry.sdk.name",
  "telemetry.sdk.language",
  "telemetry.sdk.version",
];

const nanos = (t: HrTime): string => (BigInt(t[0]) * 1_000_000_000n + BigInt(t[1])).toString();

function anyValue(v: AttributeValue): AnyValue | null {
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { boolValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) {
    const values = (v as unknown[]).map((x) => (x === null || x === undefined ? null : anyValue(x as AttributeValue))).filter((x): x is AnyValue => x !== null);
    return { arrayValue: { values } };
  }
  return null;
}

function keyValues(attrs: Record<string, AttributeValue>): KeyValue[] {
  const out: KeyValue[] = [];
  for (const key of Object.keys(attrs).sort()) {
    const raw = attrs[key];
    if (raw === undefined) continue;
    const v = anyValue(raw);
    if (v) out.push({ key, value: v });
  }
  return out;
}

/** Resource attributes on the allowlist with code-like values; returns them and how many were dropped. */
export function sanitizeResourceAttributes(attrs: Attributes): { attributes: Record<string, string>; dropped: number } {
  const attributes: Record<string, string> = {};
  let dropped = 0;
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined) continue;
    if (RESOURCE_ATTRIBUTE_ALLOWLIST.includes(k) && typeof v === "string" && RESOURCE_VALUE.test(v) && !LONG_DIGIT_RUN.test(v)) attributes[k] = v;
    else dropped += 1;
  }
  return { attributes, dropped };
}

export interface EncodedRequest {
  body: string;
  /** Attributes, metrics, links or messages left out because they are not content-free by declaration. */
  dropped: number;
}

/** ExportMetricsServiceRequest (JSON mapping) for one collection, keeping only catalogue-declared series and labels. */
export function encodeMetricsRequest(rm: ResourceMetrics, catalogue: MetricCatalogue): EncodedRequest {
  let dropped = 0;
  const resource = sanitizeResourceAttributes(rm.resource.attributes);
  dropped += resource.dropped;
  const scopeMetrics = rm.scopeMetrics.map((sm) => {
    const metrics: Record<string, unknown>[] = [];
    for (const m of sm.metrics) {
      const def = catalogue.get(m.descriptor.name);
      if (!def) {
        dropped += 1;
        continue;
      }
      const attrsOf = (a: Attributes): KeyValue[] => {
        const kept: Record<string, AttributeValue> = {};
        for (const [k, v] of Object.entries(a)) {
          const allowed = Object.hasOwn(def.labels, k) ? def.labels[k] : undefined;
          if (allowed && typeof v === "string" && (allowed.includes(v) || v === "other")) kept[k] = v;
          else dropped += 1;
        }
        return keyValues(kept);
      };
      const temporality = m.aggregationTemporality === AggregationTemporality.DELTA ? 1 : 2;
      const base = { name: def.name, description: def.description, unit: def.unit };
      if (m.dataPointType === DataPointType.SUM) {
        metrics.push({
          ...base,
          sum: {
            aggregationTemporality: temporality,
            isMonotonic: m.isMonotonic,
            dataPoints: m.dataPoints.map((p) => ({ attributes: attrsOf(p.attributes), startTimeUnixNano: nanos(p.startTime), timeUnixNano: nanos(p.endTime), asDouble: p.value })),
          },
        });
      } else if (m.dataPointType === DataPointType.GAUGE) {
        metrics.push({
          ...base,
          gauge: { dataPoints: m.dataPoints.map((p) => ({ attributes: attrsOf(p.attributes), startTimeUnixNano: nanos(p.startTime), timeUnixNano: nanos(p.endTime), asDouble: p.value })) },
        });
      } else if (m.dataPointType === DataPointType.HISTOGRAM) {
        metrics.push({
          ...base,
          histogram: {
            aggregationTemporality: temporality,
            dataPoints: m.dataPoints.map((p) => ({
              attributes: attrsOf(p.attributes),
              startTimeUnixNano: nanos(p.startTime),
              timeUnixNano: nanos(p.endTime),
              count: String(p.value.count),
              ...(p.value.sum !== undefined ? { sum: p.value.sum } : {}),
              bucketCounts: p.value.buckets.counts.map((c) => String(c)),
              explicitBounds: [...p.value.buckets.boundaries],
              ...(p.value.min !== undefined ? { min: p.value.min } : {}),
              ...(p.value.max !== undefined ? { max: p.value.max } : {}),
            })),
          },
        });
      } else {
        // Exponential histograms are not configured by the platform; an unexpected one is not exported.
        dropped += 1;
      }
    }
    return { scope: { name: sm.scope.name, ...(sm.scope.version ? { version: sm.scope.version } : {}) }, metrics };
  });
  return { body: JSON.stringify({ resourceMetrics: [{ resource: { attributes: keyValues(resource.attributes) }, scopeMetrics }] }), dropped };
}

/** Span attributes the allowlist accepts (plus the discarded-attribute counter tracing.ts writes itself). */
function spanAttributes(a: Attributes): { kept: Record<string, AttributeValue>; dropped: number } {
  const kept: Record<string, AttributeValue> = {};
  let dropped = 0;
  for (const [k, v] of Object.entries(a)) {
    if (v === undefined) continue;
    if (k === "vsp.discarded_attributes" && typeof v === "number" && Number.isInteger(v) && v >= 0) {
      kept[k] = v;
      continue;
    }
    const validate = Object.hasOwn(SPAN_ATTRIBUTE_ALLOWLIST, k) ? SPAN_ATTRIBUTE_ALLOWLIST[k] : undefined;
    if (validate && validate(v)) kept[k] = v;
    else dropped += 1;
  }
  return { kept, dropped };
}

const HEX32 = /^[0-9a-f]{32}$/;
const HEX16 = /^[0-9a-f]{16}$/;

/** ExportTraceServiceRequest (JSON mapping) for one batch of ended spans. */
export function encodeTraceRequest(spans: readonly ReadableSpan[]): EncodedRequest {
  let dropped = 0;
  // Group by resource (one per provider) and scope.
  const byResource = new Map<string, { resource: Record<string, string>; scopes: Map<string, { scope: { name: string; version?: string }; spans: unknown[] }> }>();
  for (const s of spans) {
    const ctx = s.spanContext();
    if (!HEX32.test(ctx.traceId) || !HEX16.test(ctx.spanId)) {
      dropped += 1;
      continue;
    }
    const res = sanitizeResourceAttributes(s.resource.attributes);
    dropped += res.dropped;
    const resKey = JSON.stringify(res.attributes);
    let r = byResource.get(resKey);
    if (!r) {
      r = { resource: res.attributes, scopes: new Map() };
      byResource.set(resKey, r);
    }
    // The instrumentation scope is a closed name and a version label: a scope built from a value never leaves.
    const scopeName = SPAN_SCOPE_NAMES.includes(s.instrumentationScope.name) ? s.instrumentationScope.name : "invalid_scope";
    const rawVersion = s.instrumentationScope.version;
    const scopeVersion = rawVersion !== undefined && SCOPE_VERSION.test(rawVersion) && !LONG_DIGIT_RUN.test(rawVersion) ? rawVersion : undefined;
    if (scopeName !== s.instrumentationScope.name) dropped += 1;
    if (rawVersion !== undefined && rawVersion !== "" && scopeVersion === undefined) dropped += 1;
    const scopeKey = `${scopeName}@${scopeVersion ?? ""}`;
    let sc = r.scopes.get(scopeKey);
    if (!sc) {
      sc = { scope: { name: scopeName, ...(scopeVersion ? { version: scopeVersion } : {}) }, spans: [] };
      r.scopes.set(scopeKey, sc);
    }
    const attrs = spanAttributes(s.attributes);
    dropped += attrs.dropped + s.links.length;
    const parent = s.parentSpanContext?.spanId;
    const events = s.events.map((e) => {
      const ea = spanAttributes(e.attributes ?? {});
      dropped += ea.dropped;
      const name = spanEventNameOf(e.name);
      if (name !== e.name) dropped += 1;
      return { timeUnixNano: nanos(e.time), name, attributes: keyValues(ea.kept) };
    });
    const message = s.status.message !== undefined && isSpanReasonCode(s.status.message) ? s.status.message : undefined;
    if (s.status.message !== undefined && message === undefined) dropped += 1;
    const name = spanNameOf(s.name);
    if (name !== s.name) dropped += 1;
    sc.spans.push({
      traceId: ctx.traceId,
      spanId: ctx.spanId,
      ...(parent && HEX16.test(parent) ? { parentSpanId: parent } : {}),
      name,
      // proto SpanKind = API SpanKind + 1 (SPAN_KIND_INTERNAL = 1).
      kind: s.kind + 1,
      startTimeUnixNano: nanos(s.startTime),
      endTimeUnixNano: nanos(s.endTime),
      attributes: keyValues(attrs.kept),
      events,
      status: { code: s.status.code, ...(message ? { message } : {}) },
    });
  }
  const resourceSpans = [...byResource.values()].map((r) => ({
    resource: { attributes: keyValues(r.resource) },
    scopeSpans: [...r.scopes.values()].map((sc) => ({ scope: sc.scope, spans: sc.spans })),
  }));
  return { body: JSON.stringify({ resourceSpans }), dropped };
}

export interface OtlpExporterOptions {
  url: URL;
  post: OtlpPost;
  timeoutMs: number;
  /** Self-observation (the composition passes the same OpenTelemetryMetrics; never the exported batch itself). */
  metrics?: Metrics;
  logger?: Logger;
}

abstract class OtlpJsonExporterBase {
  protected stopped = false;
  protected readonly metrics: Metrics;
  protected readonly logger: Logger;

  constructor(
    protected readonly opts: OtlpExporterOptions,
    protected readonly signal: "metrics" | "traces",
  ) {
    if (opts.url.protocol !== "https:" && opts.url.protocol !== "http:") throw new RangeError("OTLP_URL_INVALID");
    if (!Number.isInteger(opts.timeoutMs) || opts.timeoutMs < 100 || opts.timeoutMs > 30_000) throw new RangeError("OTLP_TIMEOUT_INVALID");
    this.metrics = opts.metrics ?? noopMetrics;
    this.logger = (opts.logger ?? silentLogger).child({ component: "otlp_exporter" });
  }

  protected count(name: string, labels: Record<string, string>, value = 1): void {
    try {
      this.metrics.increment(name, labels, value);
    } catch {
      // self-observation never changes an export
    }
  }

  /** Posts one encoded batch; resolves true on a 2xx answer. Never rejects. */
  protected async send(encoded: EncodedRequest): Promise<{ ok: boolean; error?: Error }> {
    if (encoded.dropped > 0) this.count("vsp_telemetry_attributes_dropped_total", { signal: this.signal }, encoded.dropped);
    if (this.stopped) return { ok: false, error: new Error("OTLP_EXPORTER_SHUT_DOWN") };
    try {
      const r = await this.opts.post.post(this.opts.url, encoded.body, this.opts.timeoutMs);
      if (r.status >= 200 && r.status < 300) {
        this.count("vsp_telemetry_export_total", { signal: this.signal, result: "exported" });
        return { ok: true };
      }
      this.count("vsp_telemetry_export_total", { signal: this.signal, result: "failed" });
      this.logger.warn("telemetry.export_rejected", { kind: this.signal, httpStatus: r.status, reasonCode: "OTLP_EXPORT_REJECTED" });
      return { ok: false, error: new Error("OTLP_EXPORT_REJECTED") };
    } catch (err) {
      const rc = (err as { reasonCode?: unknown } | null)?.reasonCode;
      const reasonCode = typeof rc === "string" && REASON_CODE.test(rc) ? rc : "OTLP_EXPORT_FAILED";
      // A refusal before any I/O (egress policy, host or address class) is a configuration fault, not an outage.
      const refused = /EGRESS|NOT_ALLOWED/.test(reasonCode);
      this.count("vsp_telemetry_export_total", { signal: this.signal, result: refused ? "refused" : "failed" });
      this.logger.warn("telemetry.export_failed", { kind: this.signal, reasonCode });
      return { ok: false, error: new Error(reasonCode) };
    }
  }

  async forceFlush(): Promise<void> {
    // Batching belongs to the SDK reader / span processor; nothing is buffered here.
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
  }
}

/** PushMetricExporter over OTLP/HTTP JSON (cumulative temporality, the collector's default). */
export class OtlpJsonMetricExporter extends OtlpJsonExporterBase implements PushMetricExporter {
  constructor(
    opts: OtlpExporterOptions,
    private readonly catalogue: MetricCatalogue,
  ) {
    super(opts, "metrics");
  }

  export(metrics: ResourceMetrics, resultCallback: (result: MetricExportResult) => void): void {
    let encoded: EncodedRequest;
    try {
      encoded = encodeMetricsRequest(metrics, this.catalogue);
    } catch {
      resultCallback({ code: FAILED, error: new Error("OTLP_ENCODE_FAILED") } as MetricExportResult);
      return;
    }
    void this.send(encoded).then((r) => resultCallback((r.ok ? { code: SUCCESS } : { code: FAILED, error: r.error }) as MetricExportResult));
  }

  selectAggregationTemporality(): AggregationTemporality {
    return AggregationTemporality.CUMULATIVE;
  }
}

/** SpanExporter over OTLP/HTTP JSON. */
export class OtlpJsonSpanExporter extends OtlpJsonExporterBase implements SpanExporter {
  constructor(opts: OtlpExporterOptions) {
    super(opts, "traces");
  }

  export(spans: ReadableSpan[], resultCallback: (result: SpanExportResult) => void): void {
    let encoded: EncodedRequest;
    try {
      encoded = encodeTraceRequest(spans);
    } catch {
      resultCallback({ code: FAILED, error: new Error("OTLP_ENCODE_FAILED") } as SpanExportResult);
      return;
    }
    void this.send(encoded).then((r) => resultCallback((r.ok ? { code: SUCCESS } : { code: FAILED, error: r.error }) as SpanExportResult));
  }
}
