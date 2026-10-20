/**
 * Latency addendum (ANALYSIS ONLY) for a committed combined run report (FO-17-41 "latency by intent, language,
 * audience, assurance, model, voice, load and region, with sample counts and 95% intervals"; FO-17-12
 * append-only results).
 *
 * LOCAL FIXTURE — SYNTHETIC DATA — NOT PRODUCTION. Reports rendered before 2026-10-19 skipped the language and
 * audience latency tables although the summary JSON holds all eight dimensions. The tool renders the "Latency
 * by slice" section of the committed summary with the current report renderer (platform/src/evaluation/
 * aggregate.ts renderReport) and writes it as an addendum; the summary and the report stay as written.
 * Outputs are written exclusively (an existing file is never overwritten).
 *
 *   cd platform && npx tsx ../evidence/evaluation/tools/latency-addendum.mts --summary corpus-local-20261019w5 \
 *     --md ../evidence/evaluation/corpus-local-20261019w5.latency-addendum.md
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { latencySectionOf } from "../../../platform/src/evaluation/aggregate.js";
import type { EvaluationAggregate } from "../../../platform/src/evaluation/aggregate.js";
import { REPO_ROOT } from "../../../platform/src/evaluation/paths.js";

const argv = process.argv.slice(2);
const arg = (n: string) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};
const name = arg("--summary");
const mdOut = arg("--md");
if (!name || !/^[a-z0-9][a-z0-9-]{3,80}$/.test(name) || !mdOut) {
  console.error("usage: latency-addendum.mts --summary <combined run name> --md <file>");
  process.exit(2);
}
const summary = JSON.parse(readFileSync(join(REPO_ROOT, "evidence", "evaluation", `${name}.summary.json`), "utf8")) as EvaluationAggregate;
writeFileSync(mdOut, latencyAddendum(name, summary), { flag: "wx" });
console.log(`wrote ${mdOut}`);

/** The addendum text: a header naming the summary, then the current renderer's latency section of it. */
function latencyAddendum(run: string, agg: EvaluationAggregate): string {
  return [
    `# ${run}: latency addendum`,
    "",
    "> **LOCAL FIXTURE — SYNTHETIC DATA — NOT PRODUCTION. Addendum to a committed combined run report (the summary and the report are unchanged).**",
    "",
    `The \`${run}.report.md\` renderer skipped the language and audience latency tables; \`${run}.summary.json\` holds all eight dimensions. This is the latency section of that summary rendered by the current report renderer (\`platform/src/evaluation/aggregate.ts\` \`latencySectionOf\`, the section \`renderReport\` writes). Latencies are on the simulated clock of the local fixture driver.`,
    "",
    ...latencySectionOf(agg),
    `Command: \`cd platform && npx tsx ../evidence/evaluation/tools/latency-addendum.mts --summary ${run} --md <file>\`.`,
    "",
  ].join("\n");
}
