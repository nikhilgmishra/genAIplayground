/**
 * OpenTelemetry SDK setup of the live composition (WP-07; FO-03-30, DATA-01, AIN-37).
 *
 * `startTelemetry` builds a MeterProvider (PeriodicExportingMetricReader over OtlpJsonMetricExporter) and a
 * NodeTracerProvider (BatchSpanProcessor over OtlpJsonSpanExporter) from PlatformConfig.observability, with a
 * resource limited to the service identity. Nothing is registered globally: the composition receives the
 * content-free `Metrics` bridge (OpenTelemetryMetrics over this provider's meter and the platform catalogue)
 * and a SafeTracer over this provider's tracer, so no other library can emit through these exporters and no
 * global state leaks between processes or tests.
 *
 * Without an OTLP endpoint (export not approved, AIN-37) the providers have no reader / processor: metrics and
 * spans are aggregated and discarded, never written anywhere else. Content export is not configurable: the
 * config schema accepts `contentAttributes: "DISABLED"` only, and the exporters drop any attribute outside the
 * allowlists (otlp.ts).
 */
import type { Tracer } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { BatchSpanProcessor, NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import type { Environment } from "../protocol/index.js";
import { silentLogger } from "./logger.js";
import { OpenTelemetryMetrics } from "./metrics.js";
import type { MetricCatalogue } from "./metrics.js";
import { OtlpJsonMetricExporter, OtlpJsonSpanExporter, sanitizeResourceAttributes } from "./otlp.js";
import type { OtlpPost } from "./otlp.js";
import type { Logger, Metrics } from "./ports.js";
import { createSafeTracer } from "./tracing.js";
import type { SafeTracer } from "./tracing.js";

export interface OtlpTelemetryConfig {
  /** Full OTLP/HTTP metrics URL (`https://<collector>/v1/metrics`), or null to not export metrics. */
  metricsUrl: string | null;
  /** Full OTLP/HTTP traces URL (`https://<collector>/v1/traces`), or null to not export traces. */
  tracesUrl: string | null;
  exportIntervalMs: number;
  timeoutMs: number;
}

export interface TelemetryOptions {
  serviceName: string;
  serviceVersion: string;
  environment: Environment;
  instanceId: string;
  catalogue: MetricCatalogue;
  /** Export configuration, or null when export is not configured (nothing leaves the process). */
  otlp: OtlpTelemetryConfig | null;
  /** The egress-classified sender (required when `otlp` names an endpoint). */
  post: OtlpPost | null;
  logger?: Logger;
  /**
   * In-process sink that also receives the exporters' self-observation (vsp_telemetry_export_total,
   * vsp_telemetry_attributes_dropped_total): an export failure must be visible to readiness and the alarm
   * evaluation even when it is exactly the export that fails.
   */
  localMetrics?: Pick<Metrics, "increment" | "observe" | "gauge"> | null;
}

export interface Telemetry {
  /** Content-free metrics bridge over this provider (catalogue allowlists applied at the emitter). */
  readonly metrics: OpenTelemetryMetrics;
  readonly tracer: SafeTracer;
  /** The raw tracer of this provider (only for instrumentation that goes through the span allowlist). */
  readonly rawTracer: Tracer;
  readonly exporting: { metrics: boolean; traces: boolean };
  forceFlush(): Promise<void>;
  /** Flushes and stops both providers (idempotent). */
  shutdown(): Promise<void>;
}

export function startTelemetry(o: TelemetryOptions): Telemetry {
  const logger = (o.logger ?? silentLogger).child({ component: "telemetry" });
  const res = sanitizeResourceAttributes({
    "service.name": o.serviceName,
    "service.version": o.serviceVersion,
    "service.instance.id": o.instanceId,
    "deployment.environment.name": o.environment,
  });
  if (res.dropped > 0) throw new RangeError("TELEMETRY_RESOURCE_INVALID");
  const resource = resourceFromAttributes(res.attributes);
  const metricsUrl = o.otlp?.metricsUrl ? new URL(o.otlp.metricsUrl) : null;
  const tracesUrl = o.otlp?.tracesUrl ? new URL(o.otlp.tracesUrl) : null;
  if ((metricsUrl || tracesUrl) && !o.post) throw new RangeError("TELEMETRY_SENDER_REQUIRED");
  const timeoutMs = o.otlp?.timeoutMs ?? 5_000;

  // Self-observation of the exporters goes through a late-bound bridge (the bridge needs the provider first).
  let bridge: OpenTelemetryMetrics | null = null;
  const local = o.localMetrics ?? null;
  const both = (f: (m: Pick<Metrics, "increment" | "observe" | "gauge">) => void) => {
    for (const m of [bridge, local]) {
      if (!m) continue;
      try {
        f(m);
      } catch {
        // self-observation never changes what the exporter does
      }
    }
  };
  const selfMetrics = {
    increment: (name: string, labels?: Record<string, string>, value?: number) => both((m) => m.increment(name, labels, value)),
    observe: (name: string, v: number, labels?: Record<string, string>) => both((m) => m.observe(name, v, labels)),
    gauge: (name: string, v: number, labels?: Record<string, string>) => both((m) => m.gauge(name, v, labels)),
  };
  const readers =
    metricsUrl && o.post && o.otlp
      ? [
          new PeriodicExportingMetricReader({
            exporter: new OtlpJsonMetricExporter({ url: metricsUrl, post: o.post, timeoutMs, metrics: selfMetrics, logger }, o.catalogue),
            exportIntervalMillis: o.otlp.exportIntervalMs,
            exportTimeoutMillis: Math.min(timeoutMs, o.otlp.exportIntervalMs),
          }),
        ]
      : [];
  const meterProvider = new MeterProvider({ resource, readers });
  bridge = new OpenTelemetryMetrics({ meter: meterProvider.getMeter("vsp-platform", o.serviceVersion), catalogue: o.catalogue, unknownMetric: "drop" });

  const spanProcessors =
    tracesUrl && o.post
      ? [new BatchSpanProcessor(new OtlpJsonSpanExporter({ url: tracesUrl, post: o.post, timeoutMs, metrics: selfMetrics, logger }), { maxQueueSize: 2048, maxExportBatchSize: 256, scheduledDelayMillis: 2_000, exportTimeoutMillis: timeoutMs })]
      : [];
  const tracerProvider = new NodeTracerProvider({ resource, spanProcessors });
  const rawTracer = tracerProvider.getTracer("vsp-platform", o.serviceVersion);
  let stopping: Promise<void> | null = null;
  logger.info("telemetry.started", { reasonCode: metricsUrl || tracesUrl ? "OTLP_EXPORT_CONFIGURED" : "OTLP_EXPORT_NOT_CONFIGURED" });
  const metrics = bridge;
  return {
    metrics,
    tracer: createSafeTracer(rawTracer),
    rawTracer,
    exporting: { metrics: readers.length > 0, traces: spanProcessors.length > 0 },
    async forceFlush() {
      await Promise.allSettled([meterProvider.forceFlush(), tracerProvider.forceFlush()]);
    },
    shutdown() {
      stopping ??= Promise.allSettled([meterProvider.shutdown(), tracerProvider.shutdown()]).then(() => undefined);
      return stopping;
    },
  };
}
