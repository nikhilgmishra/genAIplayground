/**
 * LOCAL LOOPBACK load run (CLI entry point).
 *
 *   cd platform && npx tsx ../scripts/load/run-local-load.mts [--sustained 25] [--burst 5]
 *        [--rate 400] [--connections 40] [--burst-connections 100] [--warmup 3]
 *        [--reference-rate 20] [--reference 10]
 *
 * Drives autocannon (separate process) against a LOCAL FIXTURE gateway on 127.0.0.1, first at a
 * low reference rate (latency without queueing), then at the target rate, then unthrottled:
 *   - PUBLIC_READ    search_approved_runbook (A0 synthetic session)
 *   - PROTECTED_READ get_invoice_status      (verified synthetic session)
 * each for `--sustained` seconds at `--rate` req/s, then a `--burst` second unthrottled burst,
 * and writes evidence/load/<runId>.json labelled
 *   "LOCAL LOOPBACK, PGlite single connection, NOT the vendor/telephone path, NOT capacity evidence".
 *
 * Exit code: 0 when every phase was error-free and every success was audited; 1 otherwise.
 * Not meeting the 400 req/s target is REPORTED (verdict.sustainedTargetMet=false), not hidden.
 * The harness lives in platform/test/load/harness.ts (type-checked with the platform).
 */
import { campaignPhases, runLoadCampaign, writeLoadEvidence } from "../../platform/test/load/harness.js";
import { repoPaths } from "../../platform/src/evaluation/paths.js";

function num(argv: readonly string[], name: string, dflt: number): number {
  const i = argv.indexOf(name);
  if (i < 0) return dflt;
  const v = Number(argv[i + 1]);
  if (!Number.isFinite(v) || v <= 0) throw new Error(`invalid ${name}`);
  return v;
}

async function main(argv: readonly string[]): Promise<number> {
  const sustainedS = num(argv, "--sustained", 25);
  const burstS = num(argv, "--burst", 5);
  const rate = num(argv, "--rate", 400);
  const connections = num(argv, "--connections", 40);
  const burstConnections = num(argv, "--burst-connections", 100);
  const warmupS = num(argv, "--warmup", 3);
  const referenceRate = num(argv, "--reference-rate", 20);
  const referenceS = num(argv, "--reference", 10);
  const command = `cd platform && npx tsx ../scripts/load/run-local-load.mts --sustained ${sustainedS} --burst ${burstS} --rate ${rate} --connections ${connections} --burst-connections ${burstConnections} --warmup ${warmupS} --reference-rate ${referenceRate} --reference ${referenceS}`;
  const ev = await runLoadCampaign({ command, warmupS, phases: campaignPhases({ sustainedS, burstS, sustainedConnections: connections, burstConnections, rate, referenceRate, referenceS }) });
  const path = writeLoadEvidence(ev, repoPaths().evidence);
  console.log(`${ev.badge}`);
  console.log(`${ev.label}`);
  for (const p of ev.phases) {
    const r = p.result;
    console.log(
      `${p.name.padEnd(26)} ${p.endpoint.tool} (${p.endpoint.safetyClass}, ${p.endpoint.sessionAssurance}) c=${p.config.connections} rate=${p.config.overallRate ?? "unthrottled"}: ` +
        `${r.throughputRps} req/s, p50 ${r.latencyMs.p50} ms, p95 ${r.latencyMs.p95} ms, p99 ${r.latencyMs.p99} ms, ` +
        `responses ${r.responses}, errors ${r.errors}, timeouts ${r.timeouts}, non2xx ${r.non2xx}, non-SUCCESS ${r.bodyNotSuccess}` +
        (p.sustainedTargetMet === null ? "" : `, target ${ev.targetSustainedRps} req/s ${p.sustainedTargetMet ? "MET" : "NOT MET"}`),
    );
  }
  const f = ev.finalState;
  console.log(`audit: +${f.auditRowsDelta} rows for ${f.successfulResponses} successes (every success audited: ${f.everySuccessAudited}); backlog after ship ${f.auditBacklogAfterShip}; IntegrityVerifier localOk=${f.integrity.localOk} shippedOk=${f.integrity.shippedOk}; numeric-order chain ok=${f.integrity.numericOrderChainOk}`);
  for (const n of ev.verdict.notes) console.log(`note: ${n}`);
  console.log(`evidence: ${path}`);
  console.log(`${ev.badge}`);
  return ev.verdict.zeroErrors && f.everySuccessAudited ? 0 : 1;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`load run failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
