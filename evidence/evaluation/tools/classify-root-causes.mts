/**
 * Classification of historical non-PASS runs and their reruns (ANALYSIS ONLY; FO-17-10 "rerun and investigate
 * historical FAIL/INCONCLUSIVE cases, distinguishing product defect, fixture defect, impossible task and unmet
 * precondition with evidence"; FO-17-12 "preserve the original failing result and the corrected rerun").
 *
 * LOCAL FIXTURE — SYNTHETIC DATA — NOT PRODUCTION. Reads two root-cause attributions written by
 * attribute-root-causes.mts (the historical aggregate's and the rerun's) and the rerun's append-only run
 * directories (evidence/runs/<runId>/results.jsonl). Every historical FAIL / INCONCLUSIVE run gets:
 *   - category      PRODUCT_DEFECT | FIXTURE_DEFECT | IMPOSSIBLE_TASK | UNMET_PRECONDITION (FO-17-10), from its
 *                   root cause (the table below; an unmapped cause is NOT_CLASSIFIED, never silently dropped);
 *   - locus         product | fixture | scorer | expectation (where the defect or the missing decision lives);
 *   - rerun result  the verdict of the same scenario and repetition in the rerun (with the rerun's scenario
 *                   version and root cause), or NOT_RERUN when the rerun has no such run.
 * It also lists rerun non-PASS runs whose historical run was PASS (a historical PASS that the repaired scorer no
 * longer accepts is a scorer defect of the historical run). Verdicts are never changed; inputs are never written.
 *
 *   cd platform && npx tsx ../evidence/evaluation/tools/classify-root-causes.mts \
 *     --historical ../evidence/evaluation/corpus-local-20261018w4.root-causes.json \
 *     --historical-runs run_a,... --rerun ../evidence/evaluation/corpus-local-20261019w5.root-causes.json \
 *     --rerun-runs run_x,... --json <out.json> --md <out.md>
 *
 * Outputs are written exclusively (an existing file is never overwritten).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type Category = "PRODUCT_DEFECT" | "FIXTURE_DEFECT" | "IMPOSSIBLE_TASK" | "UNMET_PRECONDITION" | "NOT_CLASSIFIED";
type Locus = "product" | "fixture" | "scorer" | "expectation" | "unknown";
interface Classification { category: Category; locus: Locus; why: string }

/** Root cause -> FO-17-10 category and defect locus (the evidence engineer's reading; see each cause's title). */
const CLASSIFICATION: Record<string, Classification> = {
  COORDINATOR_COULD_NOT_INTERPRET: { category: "FIXTURE_DEFECT", locus: "fixture", why: "the LOCAL SIMULATED COORDINATOR (test fixture) could not parse a turn; no backend behaviour was exercised" },
  COORDINATOR_ROLE_NOT_RESOLVED: { category: "FIXTURE_DEFECT", locus: "fixture", why: "simulated coordinator keyword rule missed the role" },
  COORDINATOR_INTENT_MISSED: { category: "FIXTURE_DEFECT", locus: "fixture", why: "simulated coordinator keyword rule missed the intent" },
  COORDINATOR_MISREAD_INTENT: { category: "FIXTURE_DEFECT", locus: "fixture", why: "simulated coordinator keyword rule chose the wrong intent" },
  COORDINATOR_REPEATS_FLOW_ON_FOLLOW_UP: { category: "FIXTURE_DEFECT", locus: "fixture", why: "simulated coordinator re-ran a flow on a follow-up turn" },
  DRIVER_TRANSFER_FAULT_NOT_APPLIED_TO_STUDIO_ROUTE: { category: "FIXTURE_DEFECT", locus: "fixture", why: "the local driver did not arm the transfer fault on the Studio-initiated route" },
  FAULT_REACH_NOT_EVIDENCED_ON_EXEMPT_ROUTE: { category: "FIXTURE_DEFECT", locus: "fixture", why: "the fault is applied but the driver's call evidence holds no record of it on an exempt route (deferred audit, unbudgeted safety route); the reach rule cannot observe it" },
  FAULT_NOT_REACHED_BY_SCRIPT: { category: "IMPOSSIBLE_TASK", locus: "expectation", why: "the scenario pairs a fault with a script that never reaches its injection point" },
  FAULT_NOT_REACHED_BY_EXPECTED_FLOW: { category: "IMPOSSIBLE_TASK", locus: "expectation", why: "the dependency variant pairs a CRM outage with a flow that never writes to the CRM" },
  AFTER_COMMIT_FAULT_NOT_REACHED_SLOT_CONFLICT: { category: "IMPOSSIBLE_TASK", locus: "expectation", why: "the slot-conflict draft commits a taken slot, so the commit fails before the after-commit fault point" },
  SCREENING_INITIATED_SAFETY_ROUTE_SEQUENCE: { category: "FIXTURE_DEFECT", locus: "expectation", why: "the draft's expected tool sequence named the wrong safety tool; the safety gates passed" },
  SESSION_INVALID_ROUTED_TO_REVERIFICATION: { category: "FIXTURE_DEFECT", locus: "expectation", why: "the expectation contradicted the reviewed Studio rule (invalid session -> staffed re-verification)" },
  SAFETY_OVER_ROUTING_BORDERLINE: { category: "UNMET_PRECONDITION", locus: "expectation", why: "borderline safety language is routed to the safety human by design until the clinical safety lead decides (PRQ-008)" },
  SAFETY_ASR_UNCERTAIN_OVER_ROUTING: { category: "UNMET_PRECONDITION", locus: "expectation", why: "the ASR-uncertainty threshold is a placeholder pending clinical / ASR calibration (PRQ-008)" },
  KNOWLEDGE_NO_APPROVED_ANSWER: { category: "UNMET_PRECONDITION", locus: "expectation", why: "no approved knowledge article exists for the question (PRQ-032); the product correctly declines and routes to a person" },
  POLICY_ENGINE_ERROR_OUTCOME_EXPECTATION: { category: "UNMET_PRECONDITION", locus: "expectation", why: "the outcome for an engine failure (policy decline vs transfer) awaits the business outcome-mapping decision (PRQ-033); the fail-closed behaviour itself is correct" },
  RECONCILED_COMMIT_OUTCOME_REVISION: { category: "UNMET_PRECONDITION", locus: "expectation", why: "the outcome mapping for reconciled commits awaits the business decision (PRQ-033)" },
  MULTI_REQUEST_CALL_ENDS_WITH_HANDOFF: { category: "UNMET_PRECONDITION", locus: "expectation", why: "outcome precedence for multi-request calls awaits the business decision (PRQ-033)" },
  OUT_OF_ORDER_TRANSFER_EVENT_DROPPED: { category: "PRODUCT_DEFECT", locus: "product", why: "TransferCoordinator dropped an out-of-order event instead of holding it (workflows/transfer.ts; fix wave 5)" },
};
const classify = (cause: string): Classification => CLASSIFICATION[cause] ?? { category: "NOT_CLASSIFIED", locus: "unknown", why: `no classification for root cause ${cause}` };

const argv = process.argv.slice(2);
const arg = (n: string) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};
const need = (n: string): string => {
  const v = arg(n);
  if (!v) throw new Error(`missing ${n}`);
  return v;
};
const toolDir = dirname(fileURLToPath(import.meta.url));
const runsRoot = join(toolDir, "..", "..", "runs");

interface RcRow { scenarioId: string; scenarioVersion?: number; repetition: number; verdict: string; cause: string; group: string; split: string }
interface Rc { sourceRuns: string[]; nonPassRuns: number; rows: RcRow[] }
const historical = JSON.parse(readFileSync(need("--historical"), "utf8")) as Rc;
const rerunRc = JSON.parse(readFileSync(need("--rerun"), "utf8")) as Rc;
const rerunRuns = need("--rerun-runs").split(",").filter(Boolean);
const historicalRuns = (arg("--historical-runs") ?? historical.sourceRuns.join(",")).split(",").filter(Boolean);

type Result = { scenarioId: string; scenarioVersion: number; repetition: number; verdict: string };
const readResults = (ids: readonly string[]): Map<string, Result> => {
  const m = new Map<string, Result>();
  for (const id of ids) {
    for (const l of readFileSync(join(runsRoot, id, "results.jsonl"), "utf8").split("\n")) {
      if (!l.trim()) continue;
      const r = JSON.parse(l) as Result;
      m.set(`${r.scenarioId}#${r.repetition}`, { scenarioId: r.scenarioId, scenarioVersion: r.scenarioVersion, repetition: r.repetition, verdict: r.verdict });
    }
  }
  return m;
};
const rerunResults = readResults(rerunRuns);
const historicalResults = readResults(historicalRuns);
const rerunCause = new Map(rerunRc.rows.map((r) => [`${r.scenarioId}#${r.repetition}`, r.cause] as const));

const rows = historical.rows.map((h) => {
  const key = `${h.scenarioId}#${h.repetition}`;
  const re = rerunResults.get(key) ?? null;
  const c = classify(h.cause);
  return {
    scenarioId: h.scenarioId,
    // Older attributions (w4) carry no version: read it from the historical run's own result.
    scenarioVersion: h.scenarioVersion ?? historicalResults.get(key)?.scenarioVersion ?? null,
    repetition: h.repetition,
    verdict: h.verdict,
    cause: h.cause,
    category: c.category,
    locus: c.locus,
    rerun: re ? { verdict: re.verdict, scenarioVersion: re.scenarioVersion, cause: re.verdict === "PASS" ? null : (rerunCause.get(key) ?? "UNATTRIBUTED") } : { verdict: "NOT_RERUN", scenarioVersion: null, cause: null },
  };
});
// Rerun non-PASS runs whose historical run PASSED: classified by their rerun cause; a historical PASS the repaired
// scorer no longer accepts is a scorer defect of the historical run.
const newlyNonPass = rerunRc.rows
  .filter((r) => historicalResults.get(`${r.scenarioId}#${r.repetition}`)?.verdict === "PASS")
  .map((r) => {
    const c = classify(r.cause);
    const scorerRepair = r.verdict === "INCONCLUSIVE" && /^FAULT_(REACH|NOT_REACHED)/.test(r.cause);
    return { scenarioId: r.scenarioId, repetition: r.repetition, rerunVerdict: r.verdict, cause: r.cause, category: c.category, locus: scorerRepair ? ("scorer" as Locus) : c.locus, historicalVerdict: "PASS", note: scorerRepair ? "historical PASS rested on the driver's self-reported fault injection; the repaired scorer (fault-plan.v2 reach check) requires independent evidence" : null };
  });

const count = <T,>(xs: readonly T[], key: (x: T) => string) => {
  const m: Record<string, number> = {};
  for (const x of xs) m[key(x)] = (m[key(x)] ?? 0) + 1;
  return Object.fromEntries(Object.entries(m).sort(([a], [b]) => (a < b ? -1 : 1)));
};
const byCause = [...new Set(rows.map((r) => r.cause))].sort().map((cause) => {
  const rs = rows.filter((r) => r.cause === cause);
  const c = classify(cause);
  return { cause, category: c.category, locus: c.locus, why: c.why, runs: rs.length, historical: count(rs, (r) => r.verdict), rerun: count(rs, (r) => r.rerun.verdict), rerunCauses: count(rs.filter((r) => r.rerun.cause), (r) => r.rerun.cause as string) };
});
const out = {
  label: "LOCAL FIXTURE — SYNTHETIC DATA — NOT PRODUCTION. Classification of historical non-PASS runs with their rerun results (analysis only; verdicts are unchanged).",
  historicalSource: { runs: historicalRuns, nonPassRuns: historical.nonPassRuns },
  rerunSource: { runs: rerunRuns, nonPassRuns: rerunRc.nonPassRuns },
  categories: ["PRODUCT_DEFECT", "FIXTURE_DEFECT", "IMPOSSIBLE_TASK", "UNMET_PRECONDITION"],
  loci: ["product", "fixture", "scorer", "expectation"],
  summary: {
    historicalByCategory: count(rows, (r) => r.category),
    historicalByLocus: count(rows, (r) => r.locus),
    rerunVerdicts: count(rows, (r) => r.rerun.verdict),
    rerunVerdictsByCategory: Object.fromEntries(["PRODUCT_DEFECT", "FIXTURE_DEFECT", "IMPOSSIBLE_TASK", "UNMET_PRECONDITION", "NOT_CLASSIFIED"].map((k) => [k, count(rows.filter((r) => r.category === k), (r) => r.rerun.verdict)])),
    notClassified: rows.filter((r) => r.category === "NOT_CLASSIFIED").length,
    newlyNonPassInRerun: newlyNonPass.length,
    newlyNonPassByLocus: count(newlyNonPass, (r) => r.locus),
  },
  byCause,
  rows,
  newlyNonPass,
};

const md: string[] = [];
md.push("# Historical non-PASS runs: classification and rerun results", "");
md.push(`> **LOCAL FIXTURE — SYNTHETIC DATA — NOT PRODUCTION.** Analysis only; every verdict is unchanged. Generated by \`evidence/evaluation/tools/classify-root-causes.mts\` (FO-17-10, FO-17-12).`, "");
md.push(`Historical runs: ${historicalRuns.map((r) => `\`${r}\``).join(", ")} (${historical.nonPassRuns} non-PASS).  `);
md.push(`Rerun: ${rerunRuns.map((r) => `\`${r}\``).join(", ")} (${rerunRc.nonPassRuns} non-PASS).`, "");
md.push("Categories (FO-17-10): `PRODUCT_DEFECT`, `FIXTURE_DEFECT`, `IMPOSSIBLE_TASK`, `UNMET_PRECONDITION`. Locus: where the defect or the missing decision lives (`product`, `fixture`, `scorer`, `expectation`).", "");
md.push("## Summary", "");
md.push(`- Historical non-PASS by category: ${Object.entries(out.summary.historicalByCategory).map(([k, v]) => `${k} ${v}`).join(", ")}`);
md.push(`- Historical non-PASS by locus: ${Object.entries(out.summary.historicalByLocus).map(([k, v]) => `${k} ${v}`).join(", ")}`);
md.push(`- Rerun verdicts of those runs: ${Object.entries(out.summary.rerunVerdicts).map(([k, v]) => `${k} ${v}`).join(", ")}`);
for (const [k, v] of Object.entries(out.summary.rerunVerdictsByCategory)) if (Object.keys(v).length > 0) md.push(`  - ${k}: ${Object.entries(v).map(([a, b]) => `${a} ${b}`).join(", ")}`);
md.push(`- Not classified: ${out.summary.notClassified}`);
md.push(`- Rerun non-PASS runs whose historical run was PASS: ${newlyNonPass.length} (${Object.entries(out.summary.newlyNonPassByLocus).map(([k, v]) => `${k} ${v}`).join(", ") || "none"})`, "");
md.push("## By historical root cause", "");
md.push("| Root cause | Category | Locus | Runs | Historical | Rerun | Rerun root causes | Why |", "|---|---|---|---|---|---|---|---|");
for (const c of byCause) {
  const f = (o: Record<string, number>) => Object.entries(o).map(([k, v]) => `${k} ${v}`).join(", ") || "—";
  md.push(`| \`${c.cause}\` | ${c.category} | ${c.locus} | ${c.runs} | ${f(c.historical)} | ${f(c.rerun)} | ${f(c.rerunCauses)} | ${c.why} |`);
}
md.push("", "## Rerun non-PASS runs whose historical run was PASS", "");
if (newlyNonPass.length === 0) md.push("None.");
else {
  md.push("| Scenario | Rep | Rerun verdict | Rerun root cause | Category | Locus | Note |", "|---|---|---|---|---|---|---|");
  for (const r of newlyNonPass) md.push(`| \`${r.scenarioId}\` | ${r.repetition} | ${r.rerunVerdict} | \`${r.cause}\` | ${r.category} | ${r.locus} | ${r.note ?? "—"} |`);
}
md.push("", "## Every historical non-PASS run", "", "| Scenario | Rep | Version | Verdict | Root cause | Category | Locus | Rerun verdict | Rerun version | Rerun root cause |", "|---|---|---|---|---|---|---|---|---|---|");
for (const r of rows) md.push(`| \`${r.scenarioId}\` | ${r.repetition} | ${r.scenarioVersion} | ${r.verdict} | \`${r.cause}\` | ${r.category} | ${r.locus} | ${r.rerun.verdict} | ${r.rerun.scenarioVersion ?? "—"} | ${r.rerun.cause ? `\`${r.rerun.cause}\`` : "—"} |`);
md.push("");

const jsonOut = need("--json");
const mdOut = need("--md");
writeFileSync(jsonOut, `${JSON.stringify(out, null, 2)}\n`, { flag: "wx" });
writeFileSync(mdOut, md.join("\n"), { flag: "wx" });
process.stdout.write(`classified ${rows.length} historical non-PASS runs (${out.summary.notClassified} not classified); rerun verdicts ${JSON.stringify(out.summary.rerunVerdicts)}; newly non-PASS ${newlyNonPass.length}\n`);
