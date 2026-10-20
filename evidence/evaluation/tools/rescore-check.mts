/**
 * Rescore check (ANALYSIS ONLY): does the CURRENT scorer reproduce every recorded verdict of a run from the
 * evidence that run stored? (FO-01-07 "a fresh run follows scorer fixes"; FO-17-12 / FO-17-45 append-only
 * results; OPS-03.)
 *
 * LOCAL FIXTURE — SYNTHETIC DATA — NOT PRODUCTION. For every result of the given append-only run directories
 * (evidence/runs/<runId>/results.jsonl) the tool takes the driver evidence the result was scored from
 * (call-evidence.jsonl), rebuilds the score context the runner used (run id, time, repetition, environment,
 * execution mode, seed, rerun command and evidence reference from the result; driver error, missing fault plans
 * and injection failures from result-context.jsonl `errors`), scores it again with platform/src/evaluation/
 * scorer.ts against the scenario definition at the run's version and the committed fault plans, and compares
 * the verdict, failure code, the five gate results, every assertion verdict, requestedFault and reachedFault.
 * Nothing is rerun, no result is changed and the run directories are only read; a result whose scenario version
 * is no longer in the corpus is reported VERSION_MISMATCH and not compared.
 *
 *   cd platform && npx tsx ../evidence/evaluation/tools/rescore-check.mts \
 *     --runs run_a,run_b,... --json ../evidence/evaluation/<name>.rescore-check.json \
 *     --md ../evidence/evaluation/<name>.rescore-check.md
 *
 * Outputs are written exclusively (an existing file is never overwritten). Exit code 1 when any compared result
 * differs, so the check can gate a claim that later scorer changes leave a run's verdicts unchanged.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCorpus } from "../../../platform/src/evaluation/corpus.js";
import { scorerDigest } from "../../../platform/src/evaluation/manifest.js";
import { REPO_ROOT } from "../../../platform/src/evaluation/paths.js";
import { CallEvidence } from "../../../platform/src/evaluation/runner.js";
import { canonicalJson } from "../../../platform/src/shared/canonical.js";
import { scoreScenario } from "../../../platform/src/evaluation/scorer.js";
import type { ScoreContext } from "../../../platform/src/evaluation/scorer.js";
import type { EvaluationResult } from "../../../platform/src/protocol/index.js";

const argv = process.argv.slice(2);
const arg = (n: string) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};
const runs = (arg("--runs") ?? "").split(",").filter(Boolean);
const jsonOut = arg("--json");
const mdOut = arg("--md");
if (runs.length === 0 || !jsonOut || !mdOut) {
  console.error("usage: rescore-check.mts --runs run_a,... --json <file> --md <file>");
  process.exit(2);
}
for (const r of runs) if (!/^run_[A-Za-z0-9_-]{8,64}$/.test(r)) throw new Error(`RUN_ID_INVALID ${r}`);

const toolDir = dirname(fileURLToPath(import.meta.url));
const runsRoot = join(toolDir, "..", "..", "runs");
const corpus = loadCorpus();

const jsonl = <T,>(file: string): T[] =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as T);

interface StoredEvidence {
  scenarioId: string;
  repetition: number;
  evidence: unknown;
}
interface StoredContext {
  scenarioId: string;
  repetition: number;
  errors: string[];
}
type Diff = { field: string; recorded: unknown; rescored: unknown };
interface Row {
  runId: string;
  scenarioId: string;
  scenarioVersion: number;
  repetition: number;
  recordedVerdict: string;
  rescoredVerdict: string | null;
  status: "SAME" | "DIFFERENT" | "VERSION_MISMATCH" | "EVIDENCE_UNPARSEABLE";
  diffs: Diff[];
}

const DRIVER_ERRORS = new Set(["DRIVER_ERROR", "EVIDENCE_SCHEMA_INVALID"]);
const key = (id: string, rep: number) => `${id}#${rep}`;
const rows: Row[] = [];

for (const runId of runs) {
  const dir = join(runsRoot, runId);
  const results = jsonl<EvaluationResult>(join(dir, "results.jsonl"));
  const evidence = new Map(jsonl<StoredEvidence>(join(dir, "call-evidence.jsonl")).map((x) => [key(x.scenarioId, x.repetition), x.evidence] as const));
  const contexts = new Map(jsonl<StoredContext>(join(dir, "result-context.jsonl")).map((x) => [key(x.scenarioId, x.repetition), x] as const));
  for (const r of results) {
    const base = { runId, scenarioId: r.scenarioId, scenarioVersion: r.scenarioVersion, repetition: r.repetition, recordedVerdict: r.verdict };
    const s = corpus.byId.get(r.scenarioId);
    if (!s || s.version !== r.scenarioVersion) {
      rows.push({ ...base, rescoredVerdict: null, status: "VERSION_MISMATCH", diffs: [] });
      continue;
    }
    const k = key(r.scenarioId, r.repetition);
    const raw = evidence.get(k);
    const parsed = raw === undefined || raw === null ? null : CallEvidence.safeParse(raw);
    if (parsed !== null && !parsed.success) {
      rows.push({ ...base, rescoredVerdict: null, status: "EVIDENCE_UNPARSEABLE", diffs: [] });
      continue;
    }
    const errors = contexts.get(k)?.errors ?? [];
    const ctx: ScoreContext = {
      runId: r.runId,
      runAt: r.runAt,
      repetition: r.repetition,
      environment: r.environment,
      executionMode: r.executionMode,
      missingFaultPlans: errors.filter((x) => x.startsWith("FAULT_PLAN_MISSING:")).map((x) => x.slice("FAULT_PLAN_MISSING:".length)),
      injectionFailures: errors.filter((x) => !DRIVER_ERRORS.has(x) && !x.startsWith("FAULT_PLAN_MISSING:") && !x.startsWith("UNSUPPORTED:")),
      driverError: errors.find((x) => DRIVER_ERRORS.has(x)) ?? null,
      faultPlans: corpus.faultPlans,
      evidenceRef: r.evidenceRef,
      ...(r.seed !== undefined ? { seed: r.seed } : {}),
      ...(r.rerunCommand !== undefined ? { rerunCommand: r.rerunCommand } : {}),
    };
    const now = scoreScenario(s, parsed === null ? null : parsed.data, ctx);
    const diffs: Diff[] = [];
    const cmp = (field: string, a: unknown, b: unknown) => {
      if (canonicalJson(a ?? null) !== canonicalJson(b ?? null)) diffs.push({ field, recorded: a, rescored: b });
    };
    for (const f of ["verdict", "failureCode", "safetyResult", "privacyResult", "authenticationResult", "transactionResult", "auditEvidenceResult", "requestedFault", "reachedFault"] as const) cmp(f, r[f] ?? null, now[f] ?? null);
    const verdicts = (x: EvaluationResult) => Object.fromEntries(x.assertions.map((a) => [a.assertionId, a.verdict]));
    const before = verdicts(r);
    const after = verdicts(now);
    for (const id of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) cmp(`assertion:${id}`, before[id] ?? null, after[id] ?? null);
    rows.push({ ...base, rescoredVerdict: now.verdict, status: diffs.length === 0 ? "SAME" : "DIFFERENT", diffs });
  }
}

const count = (st: Row["status"]) => rows.filter((x) => x.status === st).length;
const summary = { results: rows.length, same: count("SAME"), different: count("DIFFERENT"), versionMismatch: count("VERSION_MISMATCH"), evidenceUnparseable: count("EVIDENCE_UNPARSEABLE") };
const label = "LOCAL FIXTURE — SYNTHETIC DATA — NOT PRODUCTION. Rescore of stored call evidence with the current scorer (analysis only; recorded results are unchanged).";
// The scorer that reproduced (or not) the recorded verdicts: the release manifest's scorer digest (manifest.ts SCORER_SOURCES).
const scorer = { digest: scorerDigest(REPO_ROOT), sources: "platform/src/evaluation/manifest.ts SCORER_SOURCES (working tree at the time of the check)" };
const out = { label, checkedAt: new Date().toISOString(), runs, scorer, summary, different: rows.filter((x) => x.status !== "SAME") };
writeFileSync(jsonOut, `${JSON.stringify(out, null, 2)}\n`, { flag: "wx" });
const md = [
  "# Rescore check",
  "",
  `> **${label}**`,
  "",
  `Runs: ${runs.map((r) => `\`${r}\``).join(", ")}.  `,
  `Scorer digest (release-manifest \`scorer_version\`): \`${scorer.digest ?? "UNREADABLE"}\`; checked at ${out.checkedAt}.`,
  "",
  "| Results | Same verdict and assertions | Different | Version not in corpus | Evidence unparseable |",
  "|---|---|---|---|---|",
  `| ${summary.results} | ${summary.same} | ${summary.different} | ${summary.versionMismatch} | ${summary.evidenceUnparseable} |`,
  "",
  "Compared per result: verdict, failure code, the five gate results, every assertion verdict, requestedFault and reachedFault.",
  "",
  ...(out.different.length === 0
    ? ["Every compared result is reproduced exactly by the current scorer."]
    : ["| Run | Scenario | Rep | Recorded | Rescored | Status | First differences |", "|---|---|---|---|---|---|---|", ...out.different.slice(0, 200).map((x) => `| ${x.runId} | ${x.scenarioId} | ${x.repetition} | ${x.recordedVerdict} | ${x.rescoredVerdict ?? "—"} | ${x.status} | ${x.diffs.slice(0, 3).map((d) => `${d.field}: ${JSON.stringify(d.recorded)} -> ${JSON.stringify(d.rescored)}`).join("; ")} |`)]),
  "",
  "Command: `cd platform && npx tsx ../evidence/evaluation/tools/rescore-check.mts --runs <runs> --json <file> --md <file>`.",
  "",
];
writeFileSync(mdOut, md.join("\n"), { flag: "wx" });
console.log(`${label} results ${summary.results}: same ${summary.same}, different ${summary.different}, version mismatch ${summary.versionMismatch}, unparseable ${summary.evidenceUnparseable}`);
process.exitCode = summary.different > 0 ? 1 : 0;
