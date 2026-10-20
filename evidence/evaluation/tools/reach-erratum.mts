/**
 * Fault-reach erratum (ANALYSIS ONLY) for a committed combined run summary (FO-17-11, FO-17-44 "reachedFault from
 * independent evidence, not driver self-report"; FO-17-12 append-only results; OPS-03).
 *
 * LOCAL FIXTURE — SYNTHETIC DATA — NOT PRODUCTION. Up to WP-01 refix round 3 the DUPLICATE_WEBHOOK plan counted
 * the local driver's own number of re-published outbox messages (DUPLICATE_REDELIVERIES_<n>) as an emulator-log
 * reach rule (`observedBy: emulator_log.outbox_redelivered`). That count is the driver's account of its own
 * injection, so the scorer now treats it as a driver self-report that never sets reachedFault (fault-plan.ts
 * `driver_self_report`); such runs are INCONCLUSIVE.
 *
 * The tool reads the summary (never changes the summary or its report: both stay as written) and a rescore check
 * of the same runs with the current scorer (evidence/evaluation/tools/rescore-check.mts), checks that every result
 * the rescore changed is exactly such a self-report correction (recorded PASS with reachedFault observed by
 * `emulator_log.outbox_redelivered`, rescored INCONCLUSIVE with no reachedFault, and no other assertion changed),
 * and writes the corrected totals and DUPLICATE_WEBHOOK fault coverage. Outputs are written exclusively.
 *
 *   cd platform && npx tsx ../evidence/evaluation/tools/reach-erratum.mts --summary corpus-local-20261019w5 \
 *     --rescore corpus-local-20261019w5.rescore-check-r4.json \
 *     --json ../evidence/evaluation/corpus-local-20261019w5.reach-erratum.json \
 *     --md ../evidence/evaluation/corpus-local-20261019w5.reach-erratum.md
 *
 * Exit code 1 when a changed result is not a self-report correction (the erratum would then not explain it).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../../../platform/src/evaluation/paths.js";

const argv = process.argv.slice(2);
const arg = (n: string) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};
const name = arg("--summary");
const rescoreName = arg("--rescore");
const jsonOut = arg("--json");
const mdOut = arg("--md");
if (!name || !/^[a-z0-9][a-z0-9-]{3,80}$/.test(name) || !rescoreName || !/^[a-z0-9][a-z0-9.-]{3,120}\.json$/.test(rescoreName) || !jsonOut || !mdOut) {
  console.error("usage: reach-erratum.mts --summary <combined run name> --rescore <rescore-check json in evidence/evaluation> --json <file> --md <file>");
  process.exit(2);
}

const FAULT = "DUPLICATE_WEBHOOK";
const SELF_REPORT_SOURCE = "emulator_log.outbox_redelivered";
const REACH_ASSERTION = `assertion:evidence.fault_reached.${FAULT.toLowerCase()}`;
/** Fields a self-report correction may change: the verdict, its failure code, the five gate results (capped by the evidence precondition), reachedFault and the reach assertion. */
const ALLOWED = new Set(["verdict", "failureCode", "safetyResult", "privacyResult", "authenticationResult", "transactionResult", "auditEvidenceResult", "reachedFault", REACH_ASSERTION]);

interface Diff {
  field: string;
  recorded: unknown;
  rescored: unknown;
}
interface Row {
  runId: string;
  scenarioId: string;
  scenarioVersion: number;
  repetition: number;
  recordedVerdict: string;
  rescoredVerdict: string | null;
  status: string;
  diffs: Diff[];
}
interface Rescore {
  label: string;
  checkedAt: string;
  runs: string[];
  scorer: { digest: string | null };
  summary: { results: number; same: number; different: number; versionMismatch: number; evidenceUnparseable: number };
  different: Row[];
}
interface FaultCoverage {
  faultId: string;
  requested: number;
  reached: number;
  reachedAndPassed: number;
  notReached: number;
  layer2: string;
}
interface Summary {
  runIds: string[];
  totals: { runs: number; required: number; pass: number; fail: number; inconclusive: number; notRun: number; taskCompletionRate: number | null };
  gates: Record<string, { status: string }>;
  coverageHoles: { faults: FaultCoverage[] };
}

const evalDir = join(REPO_ROOT, "evidence", "evaluation");
const summary = JSON.parse(readFileSync(join(evalDir, `${name}.summary.json`), "utf8")) as Summary;
const rescore = JSON.parse(readFileSync(join(evalDir, rescoreName), "utf8")) as Rescore;

const problems: string[] = [];
if ([...rescore.runs].sort().join(",") !== [...summary.runIds].sort().join(",")) problems.push("RESCORE_RUNS_DIFFER_FROM_SUMMARY");
if (rescore.summary.results !== summary.totals.runs) problems.push("RESCORE_RESULT_COUNT_DIFFERS");
if (rescore.summary.versionMismatch + rescore.summary.evidenceUnparseable > 0) problems.push("RESCORE_NOT_COMPLETE");
const corrected = rescore.different.map((r) => {
  const field = (f: string) => r.diffs.find((d) => d.field === f);
  const reached = field("reachedFault");
  const recordedReach = reached?.recorded as { faultId?: string; observedBy?: string; evidenceRef?: string } | null | undefined;
  const ok =
    r.status === "DIFFERENT" &&
    r.recordedVerdict === "PASS" &&
    r.rescoredVerdict === "INCONCLUSIVE" &&
    recordedReach?.faultId === FAULT &&
    recordedReach.observedBy === SELF_REPORT_SOURCE &&
    reached?.rescored === null &&
    field(REACH_ASSERTION)?.recorded === "PASS" &&
    field(REACH_ASSERTION)?.rescored === "INCONCLUSIVE" &&
    r.diffs.every((d) => ALLOWED.has(d.field));
  if (!ok) problems.push(`NOT_A_SELF_REPORT_CORRECTION ${r.runId} ${r.scenarioId}#${r.repetition}`);
  return { runId: r.runId, scenarioId: r.scenarioId, scenarioVersion: r.scenarioVersion, repetition: r.repetition, recordedVerdict: r.recordedVerdict, correctedVerdict: r.rescoredVerdict, recordedObservedBy: recordedReach?.observedBy ?? null, recordedEvidenceRef: recordedReach?.evidenceRef ?? null };
});

const n = corrected.length;
const fault = summary.coverageHoles.faults.find((f) => f.faultId === FAULT);
if (!fault) problems.push("FAULT_COVERAGE_ROW_MISSING");
const t = summary.totals;
const correctedTotals = { runs: t.runs, required: t.required, pass: t.pass - n, fail: t.fail, inconclusive: t.inconclusive + n, notRun: t.notRun, taskCompletionRate: t.required > 0 ? (t.pass - n) / t.required : null };
const label = "LOCAL FIXTURE — SYNTHETIC DATA — NOT PRODUCTION. Erratum to a committed combined run summary (analysis only; the summary, its report and the recorded results are unchanged).";
const out = {
  label,
  summary: `${name}.summary.json`,
  rescoreCheck: rescoreName,
  scorerDigest: rescore.scorer.digest,
  rule: `A ${FAULT} run is reached only on independent evidence (the telephony emulator's delivery log). The local driver's own count of the outbox messages it re-published (DUPLICATE_REDELIVERIES_<n>, recorded as observedBy ${SELF_REPORT_SOURCE}) is a driver self-report (fault-plan.ts driver_self_report): it never sets reachedFault, and such a run is INCONCLUSIVE.`,
  recorded: { totals: { pass: t.pass, fail: t.fail, inconclusive: t.inconclusive, notRun: t.notRun, taskCompletionRate: t.taskCompletionRate }, fault: fault ?? null, localGate: summary.gates.local?.status ?? null },
  corrected: {
    totals: correctedTotals,
    fault: fault ? { ...fault, reached: fault.reached - n, reachedAndPassed: fault.reachedAndPassed - n, notReached: fault.notReached + n } : null,
    // The local gate already FAILs on the recorded FAIL results; INCONCLUSIVE results never make it pass.
    localGate: summary.gates.local?.status === "FAIL" ? "FAIL" : "INCONCLUSIVE",
  },
  selfReportCorrections: n,
  explained: problems.length === 0,
  problems,
  results: corrected,
};
writeFileSync(jsonOut, `${JSON.stringify(out, null, 2)}\n`, { flag: "wx" });
const pct = (x: number | null) => (x === null ? "—" : `${(x * 100).toFixed(2)}%`);
const md = [
  `# ${name}: fault-reach erratum`,
  "",
  `> **${label}**`,
  "",
  out.rule,
  "",
  `Rescore check \`${rescoreName}\` (scorer digest \`${rescore.scorer.digest ?? "UNREADABLE"}\`, checked at ${rescore.checkedAt}): ${rescore.summary.results} results, ${rescore.summary.same} same, ${rescore.summary.different} different; every difference ${problems.length === 0 ? "is" : "is NOT"} a self-report correction.`,
  "",
  "| | PASS | FAIL | INCONCLUSIVE | NOT_RUN | Task completion (fixed denominator) | Local gate |",
  "|---|---|---|---|---|---|---|",
  `| Recorded in the summary and report | ${t.pass} | ${t.fail} | ${t.inconclusive} | ${t.notRun} | ${pct(t.taskCompletionRate)} | ${out.recorded.localGate ?? "—"} |`,
  `| Corrected | ${correctedTotals.pass} | ${correctedTotals.fail} | ${correctedTotals.inconclusive} | ${correctedTotals.notRun} | ${pct(correctedTotals.taskCompletionRate)} | ${out.corrected.localGate} |`,
  "",
  "| Fault | Requested runs | Independently reached | Reached and PASS | Not reached (INCONCLUSIVE) |",
  "|---|---|---|---|---|",
  ...(fault && out.corrected.fault
    ? [
        `| ${FAULT} (recorded) | ${fault.requested} | ${fault.reached} | ${fault.reachedAndPassed} | ${fault.notReached} |`,
        `| ${FAULT} (corrected) | ${out.corrected.fault.requested} | ${out.corrected.fault.reached} | ${out.corrected.fault.reachedAndPassed} | ${out.corrected.fault.notReached} |`,
      ]
    : []),
  "",
  `## Corrected results (${n})`,
  "",
  "| Run | Scenario | Rep | Recorded | Corrected | Recorded observedBy |",
  "|---|---|---|---|---|---|",
  ...corrected.map((r) => `| ${r.runId} | ${r.scenarioId} | ${r.repetition} | ${r.recordedVerdict} | ${r.correctedVerdict ?? "—"} | ${r.recordedObservedBy ?? "—"} |`),
  ...(problems.length > 0 ? ["", "## Problems", "", ...problems.map((p) => `- ${p}`)] : []),
  "",
  `Command: \`cd platform && npx tsx ../evidence/evaluation/tools/reach-erratum.mts --summary ${name} --rescore ${rescoreName} --json <file> --md <file>\`.`,
  "",
];
writeFileSync(mdOut, md.join("\n"), { flag: "wx" });
console.log(`${label} ${n} self-report correction(s); explained=${problems.length === 0}`);
process.exitCode = problems.length === 0 ? 0 : 1;
