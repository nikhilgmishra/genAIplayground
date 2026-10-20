/**
 * The committed root-cause classification of the historical (w4) non-PASS runs (FO-17-10: "every historical
 * non-PASS run classified in the four categories with evidence and a rerun; reports retained").
 *
 * Reads only committed evidence (evidence/evaluation/*.json; the run directories under evidence/runs are
 * git-ignored): the w4 root-cause attribution (every w4 non-PASS run with its recorded verdict), the w5
 * attribution (every w5 non-PASS run) and the classification that joins them
 * (evidence/evaluation/tools/classify-root-causes.mts). It proves the classification is complete and consistent,
 * not that each category judgement is right (that is the analysis recorded per cause, `why`).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./paths.js";

const read = <T,>(name: string): T => JSON.parse(readFileSync(join(REPO_ROOT, "evidence", "evaluation", name), "utf8")) as T;

interface AttributionRow {
  scenarioId: string;
  repetition: number;
  verdict: string;
  cause?: string;
}
interface Attribution {
  nonPassRuns: number;
  sourceRuns: string[];
  causes: { id: string }[];
  rows: AttributionRow[];
}
interface ClassificationRow {
  scenarioId: string;
  repetition: number;
  verdict: string;
  cause: string;
  category: string;
  locus: string;
  rerun: { verdict: string; scenarioVersion: number; cause: string | null };
}
interface Classification {
  label: string;
  historicalSource: { runs: string[]; nonPassRuns: number };
  rerunSource: { runs: string[]; nonPassRuns: number };
  categories: string[];
  loci: string[];
  summary: { historicalByCategory: Record<string, number>; rerunVerdicts: Record<string, number>; notClassified: number; newlyNonPassInRerun: number };
  byCause: { cause: string; category: string; locus: string; why: string; runs: number }[];
  rows: ClassificationRow[];
  newlyNonPass: { scenarioId: string; repetition: number; rerunVerdict: string; cause: string; category: string; historicalVerdict: string }[];
}

const w4 = read<Attribution>("corpus-local-20261018w4.root-causes.json");
const w5 = read<Attribution>("corpus-local-20261019w5.root-causes.json");
const cls = read<Classification>("corpus-local-20261019w5.historical-classification.json");
const key = (r: { scenarioId: string; repetition: number }) => `${r.scenarioId}#${r.repetition}`;
const causeOf = (r: AttributionRow) => r.cause ?? (r as unknown as { causeId?: string }).causeId ?? null;

describe("[FO-17-10][OPS-03] historical non-PASS classification (committed evidence)", () => {
  it("[FO-17-10] every w4 non-PASS run is classified exactly once, with its recorded verdict, in one of the four categories", () => {
    expect(cls.label).toMatch(/^LOCAL FIXTURE — SYNTHETIC DATA — NOT PRODUCTION/);
    expect(cls.categories).toEqual(["PRODUCT_DEFECT", "FIXTURE_DEFECT", "IMPOSSIBLE_TASK", "UNMET_PRECONDITION"]);
    expect(cls.historicalSource.runs).toEqual(w4.sourceRuns);
    expect(cls.historicalSource.nonPassRuns).toBe(w4.nonPassRuns);
    expect(w4.rows).toHaveLength(w4.nonPassRuns);
    const historical = new Map(w4.rows.map((r) => [key(r), r] as const));
    expect(historical.size).toBe(w4.rows.length);
    expect(cls.rows).toHaveLength(w4.rows.length);
    expect(new Set(cls.rows.map(key)).size).toBe(cls.rows.length);
    for (const r of cls.rows) {
      const h = historical.get(key(r));
      expect(h, key(r)).toBeDefined();
      expect(r.verdict, key(r)).toBe(h?.verdict);
      expect(["FAIL", "INCONCLUSIVE"]).toContain(r.verdict);
      expect(cls.categories, key(r)).toContain(r.category);
      expect(cls.loci, key(r)).toContain(r.locus);
    }
    expect(cls.summary.notClassified).toBe(0);
    const byCategory: Record<string, number> = {};
    for (const r of cls.rows) byCategory[r.category] = (byCategory[r.category] ?? 0) + 1;
    expect(byCategory).toEqual(cls.summary.historicalByCategory);
  });

  it("[FO-17-10] each classification names its cause with the reasoning recorded for that cause, and agrees with the w4 attribution", () => {
    const causes = new Map(cls.byCause.map((c) => [c.cause, c] as const));
    const w4Causes = new Set(w4.causes.map((c) => c.id));
    const historical = new Map(w4.rows.map((r) => [key(r), r] as const));
    for (const r of cls.rows) {
      const c = causes.get(r.cause);
      expect(c, `${key(r)} cause ${r.cause}`).toBeDefined();
      expect(c?.category, key(r)).toBe(r.category);
      expect(c?.locus, key(r)).toBe(r.locus);
      expect((c?.why ?? "").length, r.cause).toBeGreaterThan(20);
      expect(w4Causes.has(r.cause), `${r.cause} is a w4 attribution cause`).toBe(true);
      const attributed = causeOf(historical.get(key(r)) as AttributionRow);
      if (attributed !== null) expect(r.cause, key(r)).toBe(attributed);
    }
    for (const c of cls.byCause) expect(cls.rows.filter((r) => r.cause === c.cause)).toHaveLength(c.runs);
  });

  it("[FO-17-10][FO-17-12] every classified run has a rerun result, and it matches the w5 rerun: non-PASS exactly when w5 lists it with that verdict", () => {
    expect(cls.rerunSource.runs).toEqual(w5.sourceRuns);
    expect(cls.rerunSource.nonPassRuns).toBe(w5.nonPassRuns);
    const rerun = new Map(w5.rows.map((r) => [key(r), r] as const));
    const verdicts: Record<string, number> = {};
    for (const r of cls.rows) {
      expect(["PASS", "FAIL", "INCONCLUSIVE"], key(r)).toContain(r.rerun.verdict);
      verdicts[r.rerun.verdict] = (verdicts[r.rerun.verdict] ?? 0) + 1;
      const w = rerun.get(key(r));
      if (r.rerun.verdict === "PASS") expect(w, `${key(r)} PASSed in w5, so w5 lists no non-PASS run for it`).toBeUndefined();
      else expect(w?.verdict, key(r)).toBe(r.rerun.verdict);
    }
    expect(verdicts).toEqual(cls.summary.rerunVerdicts);
    // Every w5 non-PASS run is either a rerun of a classified historical run or listed as newly non-PASS.
    const historical = new Set(cls.rows.map(key));
    const fresh = w5.rows.filter((r) => !historical.has(key(r)));
    expect(fresh.map(key).sort()).toEqual(cls.newlyNonPass.map(key).sort());
    expect(cls.summary.newlyNonPassInRerun).toBe(fresh.length);
    for (const n of cls.newlyNonPass) {
      expect(cls.categories, key(n)).toContain(n.category);
      expect(n.rerunVerdict, key(n)).toBe(rerun.get(key(n))?.verdict);
    }
  });
});
