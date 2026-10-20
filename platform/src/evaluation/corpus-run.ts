/**
 * Corpus runs with lineage, single-result reruns and the corpus-wide aggregate over the fixed required
 * denominator (FO-01-07, FO-17-10, FO-17-12, FO-17-14, FO-17-15, FO-17-41, FO-17-45).
 *
 *   pnpm evidence run-partition --partition journeys|development|tuning|heldout_acceptance|regression|risk
 *        [--shard k/n] [--run-id run_...] [--rerun-of run_a,...] [--supersedes <aggregate>] [--reason CODE]
 *        [--transport http|mcp]
 *        -> evidence/runs/<runId>/ (run.json, results.jsonl, result-context.jsonl, call-evidence.jsonl, summary, report)
 *   pnpm evidence rerun --scenario <id> [--version n] [--repetition n] [--seed s] [--rerun-of run_...] [--reason CODE] [--run-id run_...]
 *        -> one result, linked to the run it reruns (the exact command recorded on every result)
 *   pnpm evidence combine-runs --runs run_a,run_b,... --out <name> [--supersedes <aggregate>] [--reason CODE]
 *        -> evidence/evaluation/<name>.summary.json + <name>.report.md with the required-scenario manifests,
 *           coverage holes, fault coverage and latency slices; outputs are written exclusively
 *
 * Partitions are disjoint and together cover the corpus (journeys and faulted journeys; the routine corpus by
 * split; the risk drafts). The driver is the LOCAL FIXTURE LocalConversationDriver
 * (platform/src/evaluation/driver), executionMode local_fixture: results never satisfy a sandbox, staging or
 * production gate. Nothing here calls a paid or external endpoint.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CorpusSplit, EvaluationResult, ScenarioDefinition } from "../protocol/index.js";
import { aggregateResults, renderReport } from "./aggregate.js";
import type { EvaluationAggregate } from "./aggregate.js";
import { corpusDigest, loadCorpus } from "./corpus.js";
import type { CorpusEntry, LoadedCorpus } from "./corpus.js";
import { heldoutIndependenceOf, loadLineage, loadRequiredManifests } from "./corpus-manifests.js";
import type { CorpusLineage } from "./corpus-manifests.js";
import { driverSummary, readEvidenceIndex } from "./driver/run-corpus.js";
import type { EvidenceIndex } from "./driver/run-corpus.js";
import { LOCAL_FIXTURE_BADGE } from "./driver/labels.js";
import { LocalConversationDriver } from "./driver/local-driver.js";
import type { ToolTransport } from "./driver/local-stack.js";
import { REPO_ROOT, repoPaths } from "./paths.js";
import { RunResultWriter, readRunContexts, readRunLineage, readRunResults } from "./results.js";
import type { RunLineage } from "./result-context.js";
import { runScenarios } from "./runner.js";

export const PARTITIONS = ["journeys", "development", "tuning", "heldout_acceptance", "regression", "risk"] as const;
export type Partition = (typeof PARTITIONS)[number];

export function partitionEntries(corpus: LoadedCorpus, p: Partition): CorpusEntry[] {
  if (p === "journeys") return corpus.entries.filter((e) => e.kind === "journey" || e.kind === "journey_faulted");
  if (p === "risk") return corpus.entries.filter((e) => e.kind === "risk_draft");
  return corpus.entries.filter((e) => e.kind === "routine" && e.scenario.split === (p as CorpusSplit));
}

const RUN_ID = /^run_[A-Za-z0-9_-]{8,64}$/;
const NAME = /^[a-z0-9_-]{4,64}$/;
const REASON = /^[A-Z][A-Z0-9_]{2,63}$/;

function headCommit(root: string): string | null {
  try {
    return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

export interface PartitionRunOptions {
  partition: Partition;
  shard?: { k: number; n: number };
  runId?: string;
  rerunOf?: string[];
  supersedes?: string[];
  reason?: string | null;
  transport?: ToolTransport;
  evidenceRoot?: string;
  root?: string;
  command: string;
  /** Recorded in run.json when the tree under test is not exactly the commit (RunLineage.sourceTree). */
  sourceTree?: string | null;
}

export async function runPartition(o: PartitionRunOptions): Promise<{ runId: string; dir: string; results: EvaluationResult[] }> {
  const root = o.root ?? REPO_ROOT;
  const corpus = loadCorpus(root);
  let entries = partitionEntries(corpus, o.partition);
  if (o.shard) entries = entries.filter((_, i) => i % (o.shard as { n: number }).n === (o.shard as { k: number }).k);
  const scenarios = entries.map((e) => e.scenario);
  const digest = corpusDigest(root).digest;
  const writer = RunResultWriter.create({
    evidenceRoot: o.evidenceRoot ?? repoPaths(root).evidence,
    ...(o.runId ? { runId: o.runId } : {}),
    lineage: { command: o.command, rerunOf: o.rerunOf ?? [], supersedes: o.supersedes ?? [], reason: o.reason ?? null, sourceCommit: headCommit(root), sourceTree: o.sourceTree ?? null, corpusDigest: digest },
  });
  const driver = new LocalConversationDriver({ transport: o.transport ?? "http" });
  let out;
  try {
    out = await runScenarios(driver, scenarios, { executionMode: "local_fixture", environment: "local", faultPlans: corpus.faultPlans, runId: writer.runId, sink: writer, evidenceRefFor: writer.evidenceRefFor });
  } finally {
    await driver.dispose();
  }
  // The partition (or shard) is this run's own denominator; the corpus-wide aggregate uses the required manifests.
  const agg = aggregateResults(out.results, scenarios, { faultPlans: corpus.faultPlans, latencySamples: latencySamplesOf([writer.dir]) });
  const ds = driverSummary(out.results, corpus, readEvidenceIndex(writer.dir));
  writer.finalize(
    { ...agg, driverSummary: ds, partition: o.partition, shard: o.shard ?? null, corpusDigest: digest, lineage: readRunLineage(writer.dir) },
    `${renderReport(agg, `Local evaluation run (${o.partition}${o.shard ? ` shard ${o.shard.k}/${o.shard.n}` : ""})`)}\n> ${LOCAL_FIXTURE_BADGE}. Corpus digest \`${digest}\`.\n`,
  );
  return { runId: writer.runId, dir: writer.dir, results: out.results };
}

export interface RerunOptions {
  scenarioId: string;
  version?: number;
  repetition: number;
  seed?: string;
  rerunOf?: string;
  reason?: string | null;
  runId?: string;
  evidenceRoot?: string;
  root?: string;
  command: string;
}

/** Reruns one result (one scenario, one repetition) and links it to the run it reruns. */
export async function rerunOne(o: RerunOptions): Promise<{ runId: string; dir: string; result: EvaluationResult }> {
  const root = o.root ?? REPO_ROOT;
  const corpus = loadCorpus(root);
  const scenario = corpus.byId.get(o.scenarioId);
  if (!scenario) throw new Error("RERUN_SCENARIO_UNKNOWN");
  // A rerun runs the scenario as it is now; a different requested version is refused, never silently substituted.
  if (o.version !== undefined && o.version !== scenario.version) throw new Error(`RERUN_VERSION_CHANGED: corpus holds ${o.scenarioId}@${scenario.version}, requested @${o.version}`);
  const writer = RunResultWriter.create({
    evidenceRoot: o.evidenceRoot ?? repoPaths(root).evidence,
    ...(o.runId ? { runId: o.runId } : {}),
    lineage: { command: o.command, rerunOf: o.rerunOf ? [o.rerunOf] : [], supersedes: [], reason: o.reason ?? (o.rerunOf ? "RERUN" : null), sourceCommit: headCommit(root), corpusDigest: corpusDigest(root).digest },
  });
  const driver = new LocalConversationDriver({ transport: "http" });
  let out;
  try {
    out = await runScenarios(driver, [scenario as ScenarioDefinition], {
      executionMode: "local_fixture",
      environment: "local",
      faultPlans: corpus.faultPlans,
      runId: writer.runId,
      sink: writer,
      evidenceRefFor: writer.evidenceRefFor,
      onlyRepetition: o.repetition,
      ...(o.seed ? { seedOverride: o.seed } : {}),
    });
  } finally {
    await driver.dispose();
  }
  const agg = aggregateResults(out.results, [{ ...scenario, repetitions: o.repetition }], { faultPlans: corpus.faultPlans });
  writer.finalize({ ...agg, lineage: readRunLineage(writer.dir) }, renderReport(agg, `Rerun of ${o.scenarioId} #${o.repetition}`));
  return { runId: writer.runId, dir: writer.dir, result: out.results[0] as EvaluationResult };
}

/** Turn latencies per result from the call evidence of the given run directories (simulated clock for the local driver). */
export function latencySamplesOf(dirs: readonly string[]): { clock: "simulated"; byResult: Map<string, number[]> } {
  const byResult = new Map<string, number[]>();
  for (const dir of dirs) {
    const path = join(dir, "call-evidence.jsonl");
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const row = JSON.parse(line) as { scenarioId: string; repetition: number; evidence: { latencies?: { turnMs?: number[] } | null } | null };
      const ms = row.evidence?.latencies?.turnMs;
      if (ms && ms.length > 0) byResult.set(`${row.scenarioId}#${row.repetition}`, ms);
    }
  }
  return { clock: "simulated", byResult };
}

export interface CombineOptions {
  runIds: readonly string[];
  name: string;
  supersedes?: string[];
  reason?: string | null;
  evidenceRoot?: string;
  root?: string;
  /** Layer-2 [FAULT:<id>] status per fault (fault-registry.ts), when known. */
  layer2Faults?: Record<string, "PASS" | "FAIL" | "INCONCLUSIVE" | "NOT_RUN" | "UNKNOWN"> | null;
}

/** How the combined summary qualifies held-out results (blocker definitions: corpus-manifests.ts INDEPENDENCE_BLOCKERS). */
export const HELDOUT_INDEPENDENCE_NOTE =
  "A held-out result is independent acceptance evidence only when nothing of its family informed the system or its expectation (lineage independenceBlockers): it was held out under the previous split, no scenario of its intent skeleton was development evidence then, and its expectation was never revised after corpus runs. Results of the other held-out scenarios are reported but are not independent acceptance evidence.";

export interface CombinedSummary extends EvaluationAggregate {
  driverSummary: ReturnType<typeof driverSummary>;
  sourceRuns: string[];
  corpusDigest: string;
  lineage: {
    supersedes: string[];
    reason: string | null;
    sourceRunLineage: (RunLineage | null)[];
    heldoutIndependence: { heldoutRequiredScenarios: number; acceptanceIndependent: number; blockers: CorpusLineage["heldoutIndependence"]["blockers"]; lineageVersion: string; note: string };
  };
  resultContexts: { results: number; withContext: number; faultsNotReached: number };
}

/** Corpus-wide aggregate over the fixed required denominator (scenarios/manifests/required-scenarios.json). */
export function combineRunsWithLineage(o: CombineOptions): { summaryPath: string; reportPath: string; summary: CombinedSummary } {
  if (!NAME.test(o.name)) throw new Error("COMBINE_NAME_INVALID");
  if (o.reason && !REASON.test(o.reason)) throw new Error("COMBINE_REASON_INVALID");
  for (const id of o.runIds) if (!RUN_ID.test(id)) throw new Error("COMBINE_RUN_ID_INVALID");
  const root = o.root ?? REPO_ROOT;
  const evidenceRoot = o.evidenceRoot ?? repoPaths(root).evidence;
  const outDir = join(evidenceRoot, "evaluation");
  const summaryPath = join(outDir, `${o.name}.summary.json`);
  const reportPath = join(outDir, `${o.name}.report.md`);
  if (existsSync(summaryPath) || existsSync(reportPath)) throw new Error("COMBINE_OUTPUT_EXISTS");
  for (const s of o.supersedes ?? []) {
    if (!NAME.test(s) || !existsSync(join(outDir, `${s}.summary.json`))) throw new Error(`COMBINE_SUPERSEDES_UNKNOWN: ${s}`);
  }
  const corpus = loadCorpus(root);
  const dirs = o.runIds.map((id) => join(evidenceRoot, "runs", id));
  const results: EvaluationResult[] = dirs.flatMap((d) => readRunResults(d));
  const contexts = dirs.flatMap((d) => readRunContexts(d));
  const index: EvidenceIndex = { integrityFailed: new Set(), numericChainOk: new Set() };
  for (const d of dirs) {
    const idx = readEvidenceIndex(d);
    for (const k of idx.integrityFailed) index.integrityFailed.add(k);
    for (const k of idx.numericChainOk) index.numericChainOk.add(k);
  }
  const agg = aggregateResults(results, corpus.byId.values(), {
    required: loadRequiredManifests(root),
    faultPlans: corpus.faultPlans,
    layer2Faults: o.layer2Faults ?? null,
    latencySamples: latencySamplesOf(dirs),
  });
  const lineage = loadLineage(root);
  const independence = heldoutIndependenceOf(lineage.scenarios);
  const summary: CombinedSummary = {
    ...agg,
    driverSummary: driverSummary(results, corpus, index),
    sourceRuns: [...o.runIds],
    corpusDigest: corpusDigest(root).digest,
    lineage: {
      supersedes: o.supersedes ?? [],
      reason: o.reason ?? null,
      sourceRunLineage: dirs.map((d) => readRunLineage(d)),
      heldoutIndependence: {
        heldoutRequiredScenarios: independence.heldout,
        acceptanceIndependent: independence.acceptanceIndependent,
        blockers: independence.blockers,
        lineageVersion: lineage.lineageVersion,
        note: HELDOUT_INDEPENDENCE_NOTE,
      },
    },
    resultContexts: { results: results.length, withContext: contexts.length, faultsNotReached: contexts.reduce((n, c) => n + c.faults.filter((f) => f.reached !== true).length, 0) },
  };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, { flag: "wx" });
  const extra = [
    "## Lineage",
    "",
    `Source runs: ${o.runIds.map((r) => `\`${r}\``).join(", ")}.  `,
    `Supersedes: ${(o.supersedes ?? []).map((s) => `\`${s}\` (kept unchanged)`).join(", ") || "none"}; reason: ${o.reason ?? "—"}.  `,
    `Held-out independence: ${summary.lineage.heldoutIndependence.acceptanceIndependent} of ${summary.lineage.heldoutIndependence.heldoutRequiredScenarios} held-out scenarios are independent acceptance evidence (blockers among held-out: ${Object.entries(summary.lineage.heldoutIndependence.blockers).map(([b, n]) => `${b} ${n}`).join(", ")}). ${summary.lineage.heldoutIndependence.note}`,
    "",
  ];
  writeFileSync(reportPath, `${renderReport(agg, "Local evaluation — corpus-wide aggregate (fixed required denominator)")}\n${extra.join("\n")}\n> ${LOCAL_FIXTURE_BADGE}.\n`, { flag: "wx" });
  return { summaryPath, reportPath, summary };
}

function arg(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}
const list = (v: string | undefined) => (v ? v.split(",").filter(Boolean) : []);

export const CORPUS_RUN_USAGE = [
  "usage: cli.ts run-partition --partition journeys|development|tuning|heldout_acceptance|regression|risk [--shard k/n] [--run-id run_...] [--rerun-of run_a,...] [--supersedes name] [--reason CODE] [--source-tree TEXT] [--transport http|mcp]",
  "       cli.ts rerun --scenario <id> [--version n] [--repetition n] [--seed s] [--rerun-of run_...] [--reason CODE] [--run-id run_...]",
  "       cli.ts combine-runs --runs run_a,run_b,... --out <name> [--supersedes name] [--reason CODE]",
].join("\n");

/** CLI entry for run-partition / rerun / combine-runs (printing is done by cli.ts). */
export async function corpusRunCommand(command: "run-partition" | "rerun" | "combine-runs", argv: readonly string[]): Promise<{ code: number; lines: string[] }> {
  const cmdLine = `pnpm evidence ${command} ${argv.join(" ")}`.trim();
  const reason = arg(argv, "--reason") ?? null;
  if (reason !== null && !REASON.test(reason)) return { code: 2, lines: [CORPUS_RUN_USAGE] };
  if (command === "combine-runs") {
    const runs = list(arg(argv, "--runs"));
    const out = arg(argv, "--out");
    if (runs.length === 0 || !out) return { code: 2, lines: [CORPUS_RUN_USAGE] };
    const r = combineRunsWithLineage({ runIds: runs, name: out, supersedes: list(arg(argv, "--supersedes")), reason });
    const t = r.summary.totals;
    return { code: 0, lines: [`${LOCAL_FIXTURE_BADGE} aggregate ${r.summaryPath}: required ${t.required}, results ${t.runs}, PASS ${t.pass}, FAIL ${t.fail}, INCONCLUSIVE ${t.inconclusive}, NOT_RUN ${t.notRun}, critical ${t.criticalFailures}; local gate ${r.summary.gates.local.status}`] };
  }
  if (command === "rerun") {
    const scenarioId = arg(argv, "--scenario");
    if (!scenarioId) return { code: 2, lines: [CORPUS_RUN_USAGE] };
    const version = arg(argv, "--version");
    const rep = Number(arg(argv, "--repetition") ?? "1");
    const rerunOf = arg(argv, "--rerun-of");
    const runId = arg(argv, "--run-id");
    const seed = arg(argv, "--seed");
    if ((rerunOf && !RUN_ID.test(rerunOf)) || (runId && !RUN_ID.test(runId)) || !Number.isInteger(rep) || rep < 1) return { code: 2, lines: [CORPUS_RUN_USAGE] };
    const r = await rerunOne({ scenarioId, repetition: rep, command: cmdLine, reason, ...(version ? { version: Number(version) } : {}), ...(rerunOf ? { rerunOf } : {}), ...(runId ? { runId } : {}), ...(seed ? { seed } : {}) });
    return { code: 0, lines: [`${LOCAL_FIXTURE_BADGE} rerun ${r.runId}: ${scenarioId} #${rep} ${r.result.verdict}${rerunOf ? ` (rerun of ${rerunOf})` : ""} -> ${r.dir}`] };
  }
  const partition = arg(argv, "--partition") as Partition | undefined;
  if (!partition || !(PARTITIONS as readonly string[]).includes(partition)) return { code: 2, lines: [CORPUS_RUN_USAGE] };
  const shardArg = arg(argv, "--shard");
  const shard = shardArg ? { k: Number(shardArg.split("/")[0]), n: Number(shardArg.split("/")[1]) } : undefined;
  if (shard && !(Number.isInteger(shard.k) && Number.isInteger(shard.n) && shard.n > 0 && shard.k >= 0 && shard.k < shard.n)) return { code: 2, lines: [CORPUS_RUN_USAGE] };
  const runId = arg(argv, "--run-id");
  const rerunOf = list(arg(argv, "--rerun-of"));
  if ((runId && !RUN_ID.test(runId)) || rerunOf.some((r) => !RUN_ID.test(r))) return { code: 2, lines: [CORPUS_RUN_USAGE] };
  const t0 = Date.now();
  const r = await runPartition({
    partition,
    command: cmdLine,
    reason,
    rerunOf,
    supersedes: list(arg(argv, "--supersedes")),
    sourceTree: arg(argv, "--source-tree") ?? null,
    transport: (arg(argv, "--transport") as ToolTransport | undefined) ?? "http",
    ...(shard ? { shard } : {}),
    ...(runId ? { runId } : {}),
  });
  const v = (x: string) => r.results.filter((y) => y.verdict === x).length;
  return { code: 0, lines: [`${LOCAL_FIXTURE_BADGE} run ${r.runId} partition ${partition}${shard ? ` shard ${shard.k}/${shard.n}` : ""}: runs=${r.results.length} PASS=${v("PASS")} FAIL=${v("FAIL")} INCONCLUSIVE=${v("INCONCLUSIVE")} (${Math.round((Date.now() - t0) / 1000)} s) -> ${r.dir}`] };
}
