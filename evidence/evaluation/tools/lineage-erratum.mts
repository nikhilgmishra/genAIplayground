/**
 * Held-out independence erratum (ANALYSIS ONLY) for a committed combined run summary (FO-17-16, FO-17-17;
 * FO-17-12 append-only results; OPS-03).
 *
 * LOCAL FIXTURE — SYNTHETIC DATA — NOT PRODUCTION. Combined summaries written before `corpus-lineage.v2`
 * counted a held-out scenario as independent acceptance evidence when the scenario itself had been held out
 * under the previous scenario-level split (`scenario-split.v1`). That rule ignored the family: every such
 * scenario belongs to an intent skeleton with development members under `scenario-split.v1`, so the family was
 * tuned on even where this variant was not, and some were revised after corpus runs. The lineage now records
 * every reason (`independenceBlockers`, platform/src/evaluation/corpus-manifests.ts).
 *
 * The tool reads the summary's recorded `lineage.heldoutIndependence` (never changes the summary or its report:
 * both stay as written), lists the scenarios the old rule counted (held out now and under `scenario-split.v1`,
 * from the committed lineage's `previousSplit`) with the blockers the current lineage records for them, and
 * writes the corrected counts. Outputs are written exclusively (an existing file is never overwritten).
 *
 *   cd platform && npx tsx ../evidence/evaluation/tools/lineage-erratum.mts --summary corpus-local-20261019w5 \
 *     --json ../evidence/evaluation/corpus-local-20261019w5.lineage-erratum.json \
 *     --md ../evidence/evaluation/corpus-local-20261019w5.lineage-erratum.md
 *
 * Exit code 1 when the old rule does not reproduce the recorded count (the erratum would then not explain it).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { heldoutIndependenceOf, loadLineage } from "../../../platform/src/evaluation/corpus-manifests.js";
import { REPO_ROOT } from "../../../platform/src/evaluation/paths.js";
import { canonicalJson, sha256Hex } from "../../../platform/src/shared/canonical.js";

const argv = process.argv.slice(2);
const arg = (n: string) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};
const name = arg("--summary");
const jsonOut = arg("--json");
const mdOut = arg("--md");
if (!name || !/^[a-z0-9][a-z0-9-]{3,80}$/.test(name) || !jsonOut || !mdOut) {
  console.error("usage: lineage-erratum.mts --summary <combined run name> --json <file> --md <file>");
  process.exit(2);
}

interface RecordedIndependence {
  heldoutRequiredScenarios: number;
  acceptanceIndependent: number;
  lineageVersion?: string;
  note: string;
}
const summary = JSON.parse(readFileSync(join(REPO_ROOT, "evidence", "evaluation", `${name}.summary.json`), "utf8")) as { lineage: { heldoutIndependence: RecordedIndependence } };
const recorded = summary.lineage.heldoutIndependence;
const lineage = loadLineage(REPO_ROOT);
const corrected = heldoutIndependenceOf(lineage.scenarios);
// The rule the recorded count used (corpus-lineage.v1): held out now and under scenario-split.v1.
const oldRule = lineage.scenarios
  .filter((l) => l.split === "heldout_acceptance" && l.previousSplit === "heldout_acceptance")
  .map((l) => ({ scenarioId: l.scenarioId, version: l.version, intent: l.intent, independenceBlockers: l.independenceBlockers }));
const reproduced = oldRule.length === recorded.acceptanceIndependent && corrected.heldout === recorded.heldoutRequiredScenarios;

const label = "LOCAL FIXTURE — SYNTHETIC DATA — NOT PRODUCTION. Erratum to the held-out independence line of a committed combined run summary (analysis only; the summary and its report are unchanged).";
const out = {
  label,
  summary: `${name}.summary.json`,
  recorded: { lineageVersion: recorded.lineageVersion ?? "corpus-lineage.v1", heldout: recorded.heldoutRequiredScenarios, acceptanceIndependent: recorded.acceptanceIndependent, rule: "held out now and under scenario-split.v1" },
  corrected: { lineageVersion: lineage.lineageVersion, ...corrected, rule: "no independence blocker (corpus-manifests.ts INDEPENDENCE_BLOCKERS)" },
  oldRuleReproduced: reproduced,
  lineageDigest: sha256Hex(canonicalJson(lineage.scenarios.map((l) => [l.scenarioId, l.version, l.split, l.previousSplit, l.independenceBlockers]))),
  countedByOldRule: oldRule,
};
writeFileSync(jsonOut, `${JSON.stringify(out, null, 2)}\n`, { flag: "wx" });

const byBlocker = (b: string) => oldRule.filter((r) => r.independenceBlockers.includes(b as never)).length;
const md = [
  `# ${name}: held-out independence erratum`,
  "",
  `> **${label}**`,
  "",
  `The summary records **${recorded.acceptanceIndependent} of ${recorded.heldoutRequiredScenarios}** held-out scenarios as independent acceptance evidence (rule: held out now and under \`scenario-split.v1\`). That rule ignored the intent family. With the family rule of \`${lineage.lineageVersion}\` the count is **${corrected.acceptanceIndependent} of ${corrected.heldout}**.`,
  "",
  "| Blocker (among held-out scenarios) | Scenarios |",
  "|---|---|",
  ...Object.entries(corrected.blockers).map(([b, n]) => `| \`${b}\` | ${n} |`),
  "",
  `Of the ${oldRule.length} scenarios the old rule counted: ${byBlocker("INTENT_FAMILY_EXPOSED")} belong to an intent skeleton with development members under \`scenario-split.v1\` (\`INTENT_FAMILY_EXPOSED\`) and ${byBlocker("REVISED_AFTER_RUNS")} were revised after corpus runs (\`REVISED_AFTER_RUNS\`). The old rule ${reproduced ? "reproduces" : "does NOT reproduce"} the recorded count from the committed lineage.`,
  "",
  "Held-out results of this run are reported as results, not as independent acceptance evidence. Independent acceptance evidence needs held-out families that were never development or tuning evidence and whose expectations were not revised after runs (a newly authored, human-reviewed held-out set; AIN-31).",
  "",
  "| Scenario | Version | Intent | Blockers |",
  "|---|---|---|---|",
  ...oldRule.map((r) => `| \`${r.scenarioId}\` | ${r.version} | ${r.intent} | ${r.independenceBlockers.join(", ")} |`),
  "",
  `Command: \`cd platform && npx tsx ../evidence/evaluation/tools/lineage-erratum.mts --summary ${name} --json <file> --md <file>\`.`,
  "",
];
writeFileSync(mdOut, md.join("\n"), { flag: "wx" });
console.log(`${label} ${name}: recorded ${recorded.acceptanceIndependent}/${recorded.heldoutRequiredScenarios}, corrected ${corrected.acceptanceIndependent}/${corrected.heldout}; old rule reproduced: ${reproduced}`);
if (!reproduced) process.exit(1);
