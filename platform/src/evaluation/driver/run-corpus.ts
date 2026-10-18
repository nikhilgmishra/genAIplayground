/**
 * Runs the scenario corpus through the LocalConversationDriver (LOCAL FIXTURE,
 * executionMode local_fixture) and writes append-only results with the existing
 * results writer under evidence/runs/<runId>/ (results.jsonl, call-evidence.jsonl,
 * summary.json, report.md).
 *
 *   pnpm evidence run --group journeys|development|heldout_acceptance|risk
 *        [--shard k/n] [--run-id run_...] [--transport http|mcp] [--limit N]
 *   pnpm evidence combine --runs run_a,run_b,... --out <name>
 *        -> evidence/evaluation/<name>.summary.json + <name>.report.md (corpus-wide aggregate)
 *   (from platform/: npx tsx src/evaluation/cli.ts run ... / combine ...)
 *
 * Groups: journeys = the nine journeys + fault-injected journeys; development /
 * heldout_acceptance = the generated routine corpus split; risk = the UNREVIEWED risk
 * drafts (both splits). Repetitions are never reduced (`--limit` only truncates the
 * scenario list and is recorded in the report). Results are LOCAL FIXTURE evidence:
 * they never satisfy a sandbox, staging or production gate.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EvaluationResult, ScenarioDefinition } from "../../protocol/index.js";
import { aggregateResults, renderReport } from "../aggregate.js";
import { corpusDigest, loadCorpus } from "../corpus.js";
import type { CorpusEntry, LoadedCorpus } from "../corpus.js";
import { repoPaths } from "../paths.js";
import { RunResultWriter, readRunResults } from "../results.js";
import { runScenarios } from "../runner.js";
import type { CallEvidence } from "../runner.js";
import { severityOf } from "../scorer.js";
import { DRIVER_LABEL, LOCAL_FIXTURE_BADGE, SIMULATED_COORDINATOR_LABEL } from "./labels.js";
import { LocalConversationDriver } from "./local-driver.js";
import type { ToolTransport } from "./local-stack.js";

export type CorpusGroup = "journeys" | "development" | "heldout_acceptance" | "risk";

export function scenariosFor(corpus: LoadedCorpus, group: CorpusGroup): CorpusEntry[] {
  switch (group) {
    case "journeys":
      return corpus.entries.filter((e) => e.kind === "journey" || e.kind === "journey_faulted");
    case "development":
      return corpus.entries.filter((e) => e.kind === "routine" && e.scenario.split === "development");
    case "heldout_acceptance":
      return corpus.entries.filter((e) => e.kind === "routine" && e.scenario.split === "heldout_acceptance");
    case "risk":
      return corpus.entries.filter((e) => e.kind === "risk_draft");
  }
}

type Verdicts = { runs: number; pass: number; fail: number; inconclusive: number; other: number };
const tally = (rs: readonly EvaluationResult[]): Verdicts => ({
  runs: rs.length,
  pass: rs.filter((r) => r.verdict === "PASS").length,
  fail: rs.filter((r) => r.verdict === "FAIL").length,
  inconclusive: rs.filter((r) => r.verdict === "INCONCLUSIVE").length,
  other: rs.filter((r) => !["PASS", "FAIL", "INCONCLUSIVE"].includes(r.verdict)).length,
});

function groupTally(rs: readonly EvaluationResult[], key: (r: EvaluationResult) => string): Record<string, Verdicts> {
  const m = new Map<string, EvaluationResult[]>();
  for (const r of rs) m.set(key(r), [...(m.get(key(r)) ?? []), r]);
  return Object.fromEntries([...m.keys()].sort().map((k) => [k, tally(m.get(k) ?? [])]));
}

/** Corpus group of a result's scenario. */
function groupOf(byFile: ReadonlyMap<string, CorpusEntry>, scenarioId: string): string {
  const e = byFile.get(scenarioId);
  if (!e) return "unknown";
  if (e.kind === "routine") return `routine_${e.scenario.split}`;
  if (e.kind === "risk_draft") return `risk_${e.scenario.split}`;
  return e.kind;
}

export interface EvidenceIndex {
  /** IntegrityVerifier verdict per result (from the call evidence). */
  integrityFailed: Set<string>;
  numericChainOk: Set<string>;
}

const keyOf = (scenarioId: string, repetition: number) => `${scenarioId}#${repetition}`;

export function readEvidenceIndex(runDir: string): EvidenceIndex {
  const idx: EvidenceIndex = { integrityFailed: new Set(), numericChainOk: new Set() };
  const raw = readFileSync(join(runDir, "call-evidence.jsonl"), "utf8");
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as { scenarioId: string; repetition: number; evidence: CallEvidence | null };
    const integ = (row.evidence?.committedState as { auditIntegrity?: { localOk?: boolean; shippedOk?: boolean; numericOrderChainOk?: boolean } } | null | undefined)?.auditIntegrity;
    if (integ && !(integ.localOk && integ.shippedOk)) idx.integrityFailed.add(keyOf(row.scenarioId, row.repetition));
    if (integ?.numericOrderChainOk) idx.numericChainOk.add(keyOf(row.scenarioId, row.repetition));
  }
  return idx;
}

/** Driver-specific summary: verdicts per group / risk class / variant family, failing hard gates, attribution. */
export function driverSummary(results: readonly EvaluationResult[], corpus: LoadedCorpus, evidence: EvidenceIndex) {
  const byId = new Map(corpus.entries.map((e) => [e.scenario.scenarioId, e]));
  const scen = (id: string): ScenarioDefinition | undefined => byId.get(id)?.scenario;
  const failingHard = new Map<string, number>();
  const failures: { scenarioId: string; repetition: number; group: string; severity: string; failedHardAssertions: string[]; failedTaskAssertions: string[]; integrityVerifierFailed: boolean }[] = [];
  const inconclusiveReasons = new Map<string, number>();
  let onlyAuditIntegrity = 0;
  for (const r of results) {
    const hard = r.assertions.filter((a) => a.hardGate && a.verdict === "FAIL").map((a) => a.assertionId);
    const task = r.assertions.filter((a) => !a.hardGate && a.verdict === "FAIL").map((a) => a.assertionId);
    for (const h of hard) failingHard.set(h, (failingHard.get(h) ?? 0) + 1);
    const k = keyOf(r.scenarioId, r.repetition);
    if (r.verdict === "FAIL") {
      failures.push({ scenarioId: r.scenarioId, repetition: r.repetition, group: groupOf(byId, r.scenarioId), severity: severityOf(r), failedHardAssertions: hard, failedTaskAssertions: task, integrityVerifierFailed: evidence.integrityFailed.has(k) });
      if (hard.length === 1 && hard[0] === "gate.audit.consequential_actions_audited" && task.length === 0 && evidence.integrityFailed.has(k) && evidence.numericChainOk.has(k)) onlyAuditIntegrity++;
    }
    if (r.verdict === "INCONCLUSIVE") {
      const first = r.assertions.find((a) => a.verdict === "INCONCLUSIVE");
      const reason = first ? `${first.assertionId}: ${first.detail.replace(/\b[a-z][a-z0-9]{1,11}_(?=[A-Za-z0-9_-]*[A-Z0-9])[A-Za-z0-9_-]{12,}\b/g, "…").slice(0, 120)}` : "unknown";
      inconclusiveReasons.set(reason, (inconclusiveReasons.get(reason) ?? 0) + 1);
    }
  }
  return {
    label: LOCAL_FIXTURE_BADGE,
    driver: DRIVER_LABEL,
    coordinator: SIMULATED_COORDINATOR_LABEL,
    totals: tally(results),
    byGroup: groupTally(results, (r) => groupOf(byId, r.scenarioId)),
    byCorpusSplit: groupTally(results, (r) => r.corpusSplit),
    byRiskClass: groupTally(results, (r) => scen(r.scenarioId)?.riskClass ?? "unknown"),
    byVariantFamily: groupTally(results, (r) => r.variant),
    failingHardAssertions: Object.fromEntries([...failingHard.entries()].sort((a, b) => b[1] - a[1])),
    auditIntegrity: {
      runsWithIntegrityVerifierFailure: results.filter((r) => evidence.integrityFailed.has(keyOf(r.scenarioId, r.repetition))).length,
      runsWithNumericOrderChainIntact: results.filter((r) => evidence.numericChainOk.has(keyOf(r.scenarioId, r.repetition))).length,
      failsWhoseOnlyFailureIsAuditGateUnderVerifierFailure: onlyAuditIntegrity,
      note: "The audit gate counts only events in streams the platform IntegrityVerifier verifies. numericOrderChainIntact is an independent recomputation (verifyChain in numeric order) used only for root-cause attribution, never to pass a gate.",
    },
    inconclusiveReasons: Object.fromEntries([...inconclusiveReasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40)),
    failures: failures.slice(0, 2000),
  };
}

function renderDriverSection(s: ReturnType<typeof driverSummary>, extra: string[]): string {
  const row = (k: string, v: Verdicts) => `| ${k} | ${v.runs} | ${v.pass} | ${v.fail} | ${v.inconclusive} |`;
  const table = (title: string, rec: Record<string, Verdicts>) => [`### ${title}`, "", "| Key | Runs | PASS | FAIL | INCONCLUSIVE |", "|---|---|---|---|---|", ...Object.entries(rec).map(([k, v]) => row(k, v)), ""];
  return [
    `> **${LOCAL_FIXTURE_BADGE}.** ${DRIVER_LABEL}.`,
    `> ${SIMULATED_COORDINATOR_LABEL}.`,
    "",
    ...extra,
    "## Local driver verdicts",
    "",
    ...table("By corpus group", s.byGroup),
    ...table("By corpus split", s.byCorpusSplit),
    ...table("By risk class", s.byRiskClass),
    ...table("By variant family", s.byVariantFamily),
    "### Failing hard assertions (count of runs)",
    "",
    ...Object.entries(s.failingHardAssertions).map(([k, v]) => `- ${k}: ${v}`),
    "",
    "### Audit integrity attribution",
    "",
    `- Runs where the IntegrityVerifier reported findings: ${s.auditIntegrity.runsWithIntegrityVerifierFailure}`,
    `- Runs whose chain is intact when recomputed in numeric sequence order: ${s.auditIntegrity.runsWithNumericOrderChainIntact}`,
    `- FAIL runs whose only failure is the audit gate while the verifier failed but the numeric chain is intact: ${s.auditIntegrity.failsWhoseOnlyFailureIsAuditGateUnderVerifierFailure}`,
    `- ${s.auditIntegrity.note}`,
    "",
    "### Most frequent INCONCLUSIVE reasons",
    "",
    ...Object.entries(s.inconclusiveReasons).map(([k, v]) => `- (${v}) ${k}`),
    "",
    ...failList(s.failures),
  ].join("\n");
}

/** FAIL runs listed by failing hard gate (unique scenario ids, run counts); task-only FAILs last. */
function failList(failures: ReturnType<typeof driverSummary>["failures"]): string[] {
  const byGate = new Map<string, Map<string, number>>();
  const add = (gate: string, id: string) => {
    const m = byGate.get(gate) ?? new Map<string, number>();
    m.set(id, (m.get(id) ?? 0) + 1);
    byGate.set(gate, m);
  };
  for (const f of failures) {
    if (f.failedHardAssertions.length === 0) add(`(no hard gate) ${f.failedTaskAssertions.join(", ") || "task"}`, f.scenarioId);
    for (const g of f.failedHardAssertions) add(g, f.scenarioId);
  }
  const out = ["### FAIL runs by failing hard gate", "", "Scenario ids with the number of failing runs in parentheses.", ""];
  for (const [gate, ids] of [...byGate.entries()].sort((a, b) => (a[0].startsWith("(") ? 1 : 0) - (b[0].startsWith("(") ? 1 : 0) || a[0].localeCompare(b[0]))) {
    const list = [...ids.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([id, n]) => `\`${id}\` (${n})`);
    out.push(`- **${gate}** — ${ids.size} scenario(s): ${list.join(", ")}`);
  }
  out.push("");
  return out;
}

export async function runGroup(opts: { group: CorpusGroup; shard?: { k: number; n: number }; runId?: string; transport?: ToolTransport; limit?: number; evidenceRoot?: string }): Promise<{ runId: string; dir: string; results: EvaluationResult[] }> {
  const corpus = loadCorpus();
  let entries = scenariosFor(corpus, opts.group);
  if (opts.shard) entries = entries.filter((_, i) => i % (opts.shard as { n: number }).n === (opts.shard as { k: number }).k);
  if (opts.limit !== undefined) entries = entries.slice(0, opts.limit);
  const scenarios = entries.map((e) => e.scenario);
  const writer = RunResultWriter.create({ evidenceRoot: opts.evidenceRoot ?? repoPaths().evidence, ...(opts.runId ? { runId: opts.runId } : {}) });
  const driver = new LocalConversationDriver({ transport: opts.transport ?? "http" });
  let out;
  try {
    out = await runScenarios(driver, scenarios, {
      executionMode: "local_fixture",
      environment: "local",
      faultPlans: corpus.faultPlans,
      runId: writer.runId,
      sink: writer,
      evidenceRefFor: writer.evidenceRefFor,
    });
  } finally {
    await driver.dispose();
  }
  const agg = aggregateResults(out.results, corpus.byId.values());
  const ds = driverSummary(out.results, corpus, readEvidenceIndex(writer.dir));
  const digest = corpusDigest().digest;
  const extra = [
    `Group: \`${opts.group}\`${opts.shard ? `, shard ${opts.shard.k}/${opts.shard.n}` : ""}${opts.limit !== undefined ? `, LIMITED to the first ${opts.limit} scenarios` : ""}; transport: ${opts.transport ?? "http"}; corpus digest \`${digest}\`.`,
    "",
  ];
  writer.finalize({ ...agg, driverSummary: ds, group: opts.group, shard: opts.shard ?? null, limit: opts.limit ?? null, corpusDigest: digest }, `${renderReport(agg, `Local evaluation run (${opts.group})`)}\n${renderDriverSection(ds, extra)}`);
  return { runId: writer.runId, dir: writer.dir, results: out.results };
}

export function combineRuns(runIds: readonly string[], name: string, evidenceRoot = repoPaths().evidence): { summaryPath: string; reportPath: string } {
  if (!/^[a-z0-9_-]{4,64}$/.test(name)) throw new Error("COMBINE_NAME_INVALID");
  const corpus = loadCorpus();
  const results: EvaluationResult[] = [];
  const index: EvidenceIndex = { integrityFailed: new Set(), numericChainOk: new Set() };
  for (const id of runIds) {
    const dir = join(evidenceRoot, "runs", id);
    results.push(...readRunResults(dir));
    const idx = readEvidenceIndex(dir);
    for (const k of idx.integrityFailed) index.integrityFailed.add(k);
    for (const k of idx.numericChainOk) index.numericChainOk.add(k);
  }
  const agg = aggregateResults(results, corpus.byId.values());
  const ds = driverSummary(results, corpus, index);
  const outDir = join(evidenceRoot, "evaluation");
  mkdirSync(outDir, { recursive: true });
  const summaryPath = join(outDir, `${name}.summary.json`);
  const reportPath = join(outDir, `${name}.report.md`);
  writeFileSync(summaryPath, `${JSON.stringify({ ...agg, driverSummary: ds, sourceRuns: runIds, corpusDigest: corpusDigest().digest }, null, 2)}\n`, { flag: "wx" });
  writeFileSync(reportPath, `${renderReport(agg, "Local evaluation — corpus-wide aggregate")}\n${renderDriverSection(ds, [`Source runs: ${runIds.map((r) => `\`${r}\``).join(", ")}.`, ""])}`, { flag: "wx" });
  return { summaryPath, reportPath };
}

function arg(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export const RUN_USAGE = "usage: cli.ts run --group journeys|development|heldout_acceptance|risk [--shard k/n] [--run-id run_...] [--transport http|mcp] [--limit N]\n       cli.ts combine --runs run_a,run_b,... --out <name>";

/** `pnpm evidence run|combine ...` (printing is done by the CLI entry point, src/evaluation/cli.ts). */
export async function runCorpusCommand(command: "run" | "combine", argv: readonly string[]): Promise<{ code: number; lines: string[] }> {
  if (command === "combine") {
    const runs = arg(argv, "--runs");
    if (!runs) return { code: 2, lines: [RUN_USAGE] };
    const out = combineRuns(runs.split(",").filter(Boolean), arg(argv, "--out") ?? "corpus-local");
    return { code: 0, lines: [`${LOCAL_FIXTURE_BADGE} corpus aggregate: ${out.summaryPath} ${out.reportPath}`] };
  }
  const group = arg(argv, "--group") as CorpusGroup | undefined;
  if (!group || !["journeys", "development", "heldout_acceptance", "risk"].includes(group)) return { code: 2, lines: [RUN_USAGE] };
  const shardArg = arg(argv, "--shard");
  const shard = shardArg ? { k: Number(shardArg.split("/")[0]), n: Number(shardArg.split("/")[1]) } : undefined;
  if (shard && !(Number.isInteger(shard.k) && Number.isInteger(shard.n) && shard.n > 0 && shard.k >= 0 && shard.k < shard.n)) return { code: 2, lines: [RUN_USAGE] };
  const limitArg = arg(argv, "--limit");
  const runIdArg = arg(argv, "--run-id");
  const t0 = Date.now();
  const out = await runGroup({
    group,
    ...(shard ? { shard } : {}),
    ...(runIdArg ? { runId: runIdArg } : {}),
    transport: (arg(argv, "--transport") as ToolTransport | undefined) ?? "http",
    ...(limitArg ? { limit: Number(limitArg) } : {}),
  });
  const t = tally(out.results);
  return {
    code: 0,
    lines: [`${LOCAL_FIXTURE_BADGE} run ${out.runId} group ${group}${shard ? ` shard ${shard.k}/${shard.n}` : ""}: runs=${t.runs} PASS=${t.pass} FAIL=${t.fail} INCONCLUSIVE=${t.inconclusive} (${Math.round((Date.now() - t0) / 1000)} s) -> ${out.dir}`],
  };
}
