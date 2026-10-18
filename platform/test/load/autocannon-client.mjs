/**
 * LOCAL LOOPBACK load generator (child process). Runs autocannon 8 against ONE
 * 127.0.0.1 tool endpoint and writes a single JSON summary line to stdout.
 *
 * It runs in its own process so the load generator does not share the event loop
 * (and CPU) of the gateway under test, which is single-threaded with PGlite on the
 * same thread. Input: one JSON argument (see harness.ts LoadPhaseConfig). Response
 * bodies are checked for ToolResult status SUCCESS (verifyBody -> mismatches); they
 * are never printed (SYNTHETIC data, but bodies stay out of logs regardless).
 */
import autocannon from "autocannon";

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function round(n) {
  return n === null || n === undefined || Number.isNaN(n) ? null : Math.round(n * 100) / 100;
}

/** Ratios keep 6 decimals so a handful of errors in thousands of requests never rounds to 0. */
function ratio(n) {
  return n === null || n === undefined || Number.isNaN(n) ? null : Math.round(n * 1e6) / 1e6;
}

const cfg = JSON.parse(process.argv[2] ?? "{}");
const url = new URL(cfg.url);
if (url.hostname !== "127.0.0.1") {
  process.stdout.write(JSON.stringify({ error: "LOOPBACK_REQUIRED" }) + "\n");
  process.exit(2);
}

const latencies = [];
const statusCounts = {};
let bodyChecked = 0;
let bodyNotSuccess = 0;
const reasonCodes = {};

const instance = autocannon({
  url: cfg.url,
  method: "POST",
  headers: cfg.headers,
  body: cfg.body,
  connections: cfg.connections,
  ...(cfg.durationS ? { duration: cfg.durationS } : {}),
  ...(cfg.amount ? { amount: cfg.amount } : {}),
  ...(cfg.overallRate ? { overallRate: cfg.overallRate } : {}),
  timeout: cfg.timeoutS ?? 10,
  pipelining: 1,
  verifyBody: (body) => {
    bodyChecked += 1;
    try {
      const parsed = JSON.parse(body);
      if (parsed && parsed.status === "SUCCESS") return true;
      const code = parsed && typeof parsed.reasonCode === "string" ? parsed.reasonCode : `STATUS_${parsed && parsed.status}`;
      reasonCodes[code] = (reasonCodes[code] ?? 0) + 1;
    } catch {
      reasonCodes.UNPARSEABLE_BODY = (reasonCodes.UNPARSEABLE_BODY ?? 0) + 1;
    }
    bodyNotSuccess += 1;
    return false;
  },
});

instance.on("response", (_client, statusCode, _resBytes, responseTime) => {
  latencies.push(responseTime);
  statusCounts[statusCode] = (statusCounts[statusCode] ?? 0) + 1;
});

instance.on("done", (r) => {
  const sorted = latencies.slice().sort((a, b) => a - b);
  const durationS = r.duration;
  const completed = latencies.length;
  const summary = {
    label: cfg.label,
    url: `${url.origin}${url.pathname}`,
    connections: r.connections,
    targetRate: cfg.overallRate ?? null,
    durationS: round(durationS),
    requestsSent: r.requests.sent,
    responses: completed,
    status2xx: r["2xx"],
    non2xx: r.non2xx,
    errors: r.errors,
    timeouts: r.timeouts,
    bodyChecked,
    bodyNotSuccess,
    reasonCodes,
    statusCounts,
    errorRate: completed + r.errors + r.timeouts === 0 ? null : ratio((r.non2xx + r.errors + r.timeouts + bodyNotSuccess) / (completed + r.errors + r.timeouts)),
    throughputRps: durationS > 0 ? round(completed / durationS) : null,
    throughputBytesPerS: round(r.throughput.average),
    latencyMs: {
      p50: round(percentile(sorted, 50)),
      p95: round(percentile(sorted, 95)),
      p99: round(percentile(sorted, 99)),
      max: round(sorted.at(-1) ?? null),
      mean: round(sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null),
    },
    autocannonLatencyMs: { p50: r.latency.p50, p90: r.latency.p90, p99: r.latency.p99 },
  };
  process.stdout.write(JSON.stringify(summary) + "\n");
});
