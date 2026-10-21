/**
 * Layer 2 (WP-07; FO-03-30, DATA-01, OPS-01): OpenTelemetry export of the live composition to a real
 * OpenTelemetry Collector over OTLP/HTTP JSON and TLS.
 *
 * The collector is a THROWAWAY container owned by this test (the image pinned in
 * deploy/local/services/otel-collector.compose.yaml; the shared composition is never touched), published on a
 * private host interface with a certificate from a per-run test CA, writing what it receives to a file exporter
 * the test reads. The sandbox configuration allowlists the collector as a TELEMETRY_EXPORTER destination; the
 * live container posts through the egress-classified transport (sandbox-only resolver and test CA).
 *
 * Covered: catalogue metrics with the service identity resource reach the collector; content never does (a
 * sentinel carried in tool arguments, refused by the pipeline, is in no exported byte); spans reach the collector
 * with registered span and event names and allowlisted attributes only, also for the raw tracer (content in a span
 * name, attribute, event, status message or link is dropped and counted); an endpoint that is not on
 * the allowlist, or not a telemetry destination, refuses the environment; the collector stopped makes exports fail
 * (counted) while the gateway keeps serving.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:tls";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { afterAll, beforeAll, describe, expect } from "vitest";
import { createMemoryLogger } from "../../../src/observability/logger.js";
import { ensurePolicyBundle } from "../../../src/policy/ensure-bundle.js";
import { REPO_ROOT } from "../_harness/env.js";
import { layer2, layer2Context } from "../_harness/layer2.js";
import { OTEL_HOST, SUBSTRATE, TENANT, bootLive, createPki, privateInterfaceAddress, privateResolver, provisionSandbox, refusal } from "./support.js";
import type { Sandbox, TestPki } from "./support.js";

const it = layer2([...SUBSTRATE]);
const SENTINEL = "SENTINEL-telemetry-content-555-0142";

/** The collector image pinned by the compose fragment (one source for both). */
function collectorImage(): string {
  const doc = YAML.parse(readFileSync(join(REPO_ROOT, "deploy", "local", "services", "otel-collector.compose.yaml"), "utf8")) as { services: Record<string, { image: string }> };
  const image = doc.services["otel-collector"]?.image;
  if (!image || !/@sha256:[0-9a-f]{64}$/.test(image)) throw new Error("OTEL_COLLECTOR_IMAGE_NOT_PINNED");
  return image;
}

interface Collector {
  container: string;
  address: string;
  port: number;
  out: string;
  stop(): void;
  remove(): void;
}

async function startCollector(pki: TestPki, dir: string): Promise<Collector> {
  const tls = join(dir, "tls");
  const out = join(dir, "out");
  mkdirSync(tls, { recursive: true });
  mkdirSync(out, { recursive: true });
  writeFileSync(join(tls, "cert.pem"), pki.certPem);
  writeFileSync(join(tls, "key.pem"), pki.keyPem);
  writeFileSync(
    join(dir, "collector.yaml"),
    [
      "receivers:",
      "  otlp:",
      "    protocols:",
      "      http:",
      "        endpoint: 0.0.0.0:4318",
      "        tls:",
      "          cert_file: /etc/otelcol/tls/cert.pem",
      "          key_file: /etc/otelcol/tls/key.pem",
      "exporters:",
      "  file:",
      "    path: /out/telemetry.jsonl",
      "    flush_interval: 100ms",
      "service:",
      "  telemetry:",
      "    metrics:",
      "      level: none",
      "  pipelines:",
      "    metrics: { receivers: [otlp], exporters: [file] }",
      "    traces: { receivers: [otlp], exporters: [file] }",
      "",
    ].join("\n"),
  );
  // The collector runs as an unprivileged user: readable config and key, writable output directory.
  for (const f of [join(dir, "collector.yaml"), join(tls, "cert.pem"), join(tls, "key.pem")]) chmodSync(f, 0o644);
  chmodSync(tls, 0o755);
  chmodSync(dir, 0o755);
  chmodSync(out, 0o777);
  const container = `vsp-it-otel-${randomBytes(4).toString("hex")}`;
  const address = privateInterfaceAddress();
  const run = spawnSync(
    "docker",
    ["run", "-d", "--name", container, "--label", "io.vsp.test=composition-telemetry", "-v", `${dir}/collector.yaml:/etc/otelcol/collector.yaml:ro`, "-v", `${tls}:/etc/otelcol/tls:ro`, "-v", `${out}:/out`, "-p", `${address}::4318`, collectorImage(), "--config=/etc/otelcol/collector.yaml"],
    { encoding: "utf8" },
  );
  if (run.status !== 0) throw new Error(`OTEL_COLLECTOR_START_FAILED: ${run.stderr.trim().slice(0, 300)}`);
  const mapped = spawnSync("docker", ["port", container, "4318/tcp"], { encoding: "utf8" }).stdout.trim().split("\n")[0] ?? "";
  const port = Number(mapped.split(":").pop());
  if (!Number.isInteger(port) || port <= 0) throw new Error(`OTEL_COLLECTOR_PORT_UNKNOWN: ${mapped}`);
  // Ready when the TLS receiver completes a handshake with the test CA.
  const deadline = Date.now() + 60_000;
  for (;;) {
    const ok = await new Promise<boolean>((resolve) => {
      const s = connect({ host: address, port, servername: OTEL_HOST, ca: pki.caPem }, () => {
        s.end();
        resolve(true);
      });
      s.on("error", () => resolve(false));
    });
    if (ok) break;
    if (Date.now() > deadline) throw new Error("OTEL_COLLECTOR_NOT_READY");
    await new Promise((r) => setTimeout(r, 250));
  }
  return {
    container,
    address,
    port,
    out: join(out, "telemetry.jsonl"),
    stop: () => void spawnSync("docker", ["stop", "-t", "2", container], { encoding: "utf8" }),
    remove: () => void spawnSync("docker", ["rm", "-f", container], { encoding: "utf8" }),
  };
}

let sb: Sandbox;
let pki: TestPki;
let dir: string;
let collector: Collector;

beforeAll(async () => {
  ensurePolicyBundle();
  sb = await provisionSandbox(layer2Context(SUBSTRATE));
  pki = createPki([OTEL_HOST]);
  dir = mkdtempSync(join(tmpdir(), "vsp-composition-otel-"));
  collector = await startCollector(pki, dir);
}, 180_000);

afterAll(async () => {
  collector?.remove();
  await sb?.close();
  pki?.dispose();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function telemetryConfig(o: { kind?: string; listed?: boolean } = {}) {
  const cfg = sb.config();
  const host = `${OTEL_HOST}:${collector.port}`;
  (cfg as Record<string, unknown>).observability = {
    contentAttributes: "DISABLED",
    otlp: { metricsUrl: `https://${host}/v1/metrics`, tracesUrl: `https://${host}/v1/traces`, exportIntervalMs: 5_000, timeoutMs: 3_000 },
  };
  cfg.infrastructure.privateNetworkHosts = [OTEL_HOST];
  cfg.egress.destinations =
    o.listed === false
      ? []
      : [{ destinationId: "egr_otel_collector", kind: o.kind ?? "TELEMETRY_EXPORTER", hosts: [host], allowedClasses: ["INTERNAL"], coverage: { baaRef: null, approvalId: null }, environments: ["sandbox"], adapterKind: "live" }];
  return cfg;
}

const network = () => ({ resolve: privateResolver([OTEL_HOST], collector.address), tlsCa: [pki.caPem] });

async function exported(predicate: (text: string) => boolean, timeoutMs = 20_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const text = existsSync(collector.out) ? readFileSync(collector.out, "utf8") : "";
    if (predicate(text)) return text;
    if (Date.now() > deadline) throw new Error(`OTEL_EXPORT_NOT_RECEIVED (${text.length} bytes received)`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe("OpenTelemetry export to a real collector [FO-03-30]", () => {
  it("[FO-03-30][DATA-01] positive: catalogue metrics with the service identity reach the collector over OTLP/HTTP and TLS; content never does", async () => {
    sb.writeConfig(telemetryConfig());
    const memory = createMemoryLogger();
    const { c } = await bootLive(sb, { network: network(), memory });
    try {
      expect(c.telemetry.exporting).toEqual({ metrics: true, traces: true });
      // Content arrives at the gateway and is refused: it must not appear in any exported byte.
      const ident = { integrationId: "it-contact-center", tenantId: TENANT, environment: "sandbox" as const, channel: "mcp_tools" as const, credentialId: "cred-mcp-tools", authMethod: "oauth2_client_credentials" as const };
      const r = await c.pipeline.invoke({ name: "request_human_transfer", version: null, arguments: { reason: SENTINEL, language: "en", note: SENTINEL } }, ident, { kind: "mcp", sessionRefHeader: null, interactionIdHeader: null });
      expect(r.status).toBe("PERMANENT_FAILURE");
      await c.telemetry.forceFlush();
      const text = await exported((t) => t.includes("vsp_live_composition_starts_total")).catch((e: unknown) => {
        const status = spawnSync("docker", ["ps", "-a", "--filter", `name=${collector.container}`, "--format", "{{.Status}} {{.Ports}}"], { encoding: "utf8" }).stdout.trim();
        const logs = spawnSync("docker", ["logs", "--tail", "8", collector.container], { encoding: "utf8" });
        throw new Error(`${String(e)} port=${collector.port} status=${status} logs=${(logs.stdout + logs.stderr).slice(-1500)} ${JSON.stringify(memory.records.filter((r) => r.event.startsWith("telemetry") || r.event.startsWith("connector")).slice(0, 3))}`);
      });
      expect(text).not.toContain(SENTINEL);
      expect(text).not.toMatch(/555-01\d\d|arn:aws|sessionRef|"arguments"/);
      const lines = text.trim().split("\n").map((l) => JSON.parse(l) as { resourceMetrics?: { resource: { attributes: { key: string; value: { stringValue?: string } }[] } }[] });
      const resource = lines.flatMap((l) => l.resourceMetrics ?? [])[0]?.resource.attributes ?? [];
      const attr = Object.fromEntries(resource.map((a) => [a.key, a.value.stringValue]));
      expect(attr["service.name"]).toBe("vsp-gateway");
      expect(attr["deployment.environment.name"]).toBe("sandbox");
      expect(Object.keys(attr).every((k) => ["service.name", "service.namespace", "service.version", "service.instance.id", "deployment.environment.name", "telemetry.sdk.name", "telemetry.sdk.language", "telemetry.sdk.version"].includes(k))).toBe(true);
      const exportedOk = c.localMetrics.find("vsp_telemetry_export_total").filter((s) => s.labels.result === "exported").reduce((n, s) => n + s.value, 0);
      expect(exportedOk).toBeGreaterThan(0);
    } finally {
      await c.close();
    }
  });

  it("[FO-03-30][DATA-01][OPS-04] adversarial: an OTLP endpoint that is not allowlisted, or allowlisted as a non-telemetry destination, refuses the environment", async () => {
    sb.writeConfig(telemetryConfig({ listed: false }));
    try {
      const v = await refusal(bootLive(sb, { network: network() }));
      expect(v).toEqual(expect.arrayContaining(["TELEMETRY_ENDPOINT_NOT_ALLOWLISTED@observability.otlp.metricsUrl", "TELEMETRY_ENDPOINT_NOT_ALLOWLISTED@observability.otlp.tracesUrl"]));
      sb.writeConfig(telemetryConfig({ kind: "SYSTEM_OF_RECORD" }));
      expect(await refusal(bootLive(sb, { network: network() }))).toContain("TELEMETRY_ENDPOINT_NOT_TELEMETRY_DESTINATION@observability.otlp.metricsUrl");
    } finally {
      sb.writeConfig(sb.config());
    }
  });

  it("[FO-03-30][DATA-01] adversarial: spans reach the collector with registered names and allowlisted attributes only; content in a span name, attribute, event, status message or link (raw tracer, no SafeTracer) never does", async () => {
    sb.writeConfig(telemetryConfig());
    const { c } = await bootLive(sb, { network: network() });
    try {
      const SENT = "SENTINELspan5550142";
      // The generated id grammar (shared/ids.ts newId: 24 base64url characters); digits replaced so no 7-digit run.
      const requestId = `req_synth${randomBytes(15).toString("base64url").replace(/\d/g, "x").slice(0, 19)}`;
      // A SafeTracer span of a registered name, and raw-tracer spans that carry content everywhere a span can.
      await c.telemetry.tracer.withSpan("gateway.http.request", { "vsp.operation": "tools.invoke", "vsp.http_method": "POST", "vsp.request_id": requestId, "caller.name": SENT }, async (span) => {
        span.addEvent("pipeline.policy_decided", { "vsp.reason_code": "POLICY_ALLOW", "caller.utterance": SENT });
      });
      const linked = c.telemetry.rawTracer.startSpan("dependency.call", { attributes: { "vsp.request_id": requestId } });
      linked.end();
      const raw = c.telemetry.rawTracer.startSpan(`patient.${SENT.toLowerCase()}`, {
        attributes: { "vsp.request_id": requestId, "caller.phone": SENT, "vsp.tool": `lookup ${SENT}` },
        links: [{ context: linked.spanContext(), attributes: { note: SENT } }],
      });
      raw.addEvent(`caller said ${SENT}`, { "exception.message": SENT });
      raw.setStatus({ code: 2, message: `failed for ${SENT}` });
      raw.end();
      await c.telemetry.forceFlush();
      const text = await exported((t) => t.split("\n").filter((l) => l.includes(requestId)).length > 0 && t.includes("invalid_span_name"));
      expect(text.toLowerCase()).not.toContain(SENT.toLowerCase());
      expect(text).not.toMatch(/caller\.(name|phone|utterance)|exception\.message|"links":\s*\[\s*\{/);
      type Span = { name: string; attributes?: { key: string }[]; events?: { name: string }[]; status?: { message?: string } };
      const spans = text
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { resourceSpans?: { scopeSpans: { spans: Span[] }[] }[] })
        .flatMap((l) => l.resourceSpans ?? [])
        .flatMap((rs) => rs.scopeSpans.flatMap((ss) => ss.spans))
        .filter((sp) => JSON.stringify(sp).includes(requestId));
      expect(spans.map((sp) => sp.name).sort()).toEqual(["dependency.call", "gateway.http.request", "invalid_span_name"]);
      for (const sp of spans) for (const a of sp.attributes ?? []) expect(a.key, sp.name).toMatch(/^vsp\./);
      expect(spans.find((sp) => sp.name === "gateway.http.request")?.events?.map((e) => e.name)).toEqual(["pipeline.policy_decided"]);
      expect(spans.find((sp) => sp.name === "invalid_span_name")?.events?.map((e) => e.name)).toEqual(["invalid_event_name"]);
      expect(spans.find((sp) => sp.name === "invalid_span_name")?.status?.message).toBeUndefined();
      // Every drop at the exporter is counted (the telemetry-attribute-dropped alarm's metric).
      expect(c.localMetrics.find("vsp_telemetry_attributes_dropped_total").filter((x) => x.labels.signal === "traces").reduce((n, x) => n + x.value, 0)).toBeGreaterThanOrEqual(6);
    } finally {
      await c.close();
      sb.writeConfig(sb.config());
    }
  });

  it("[FO-03-30][OPS-01] failure injection: with the collector stopped, exports fail and are counted; the gateway keeps serving", async () => {
    sb.writeConfig(telemetryConfig());
    const { c } = await bootLive(sb, { network: network() });
    try {
      collector.stop();
      await c.telemetry.forceFlush();
      const failed = () => c.localMetrics.find("vsp_telemetry_export_total").filter((s) => s.labels.result === "failed").reduce((n, s) => n + s.value, 0);
      const deadline = Date.now() + 15_000;
      while (failed() === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 250));
        await c.telemetry.forceFlush();
      }
      expect(failed()).toBeGreaterThan(0);
      expect((await c.app.inject({ method: "GET", url: "/health/ready" })).statusCode).toBe(200);
    } finally {
      await c.close();
      sb.writeConfig(sb.config());
    }
  });
});
