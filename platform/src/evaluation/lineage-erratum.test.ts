/**
 * The committed held-out independence erratum of the w5 combined run (FO-17-16, FO-17-17, FO-17-12): the w5
 * summary and report stay as written (append-only), and the erratum that corrects their held-out independence
 * line is consistent with them and with the committed lineage (evidence/evaluation/tools/lineage-erratum.mts).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { INDEPENDENCE_BLOCKERS, loadLineage } from "./corpus-manifests.js";
import { REPO_ROOT } from "./paths.js";

const read = <T,>(name: string): T => JSON.parse(readFileSync(join(REPO_ROOT, "evidence", "evaluation", name), "utf8")) as T;

interface Erratum {
  label: string;
  summary: string;
  recorded: { lineageVersion: string; heldout: number; acceptanceIndependent: number };
  corrected: { lineageVersion: string; heldout: number; acceptanceIndependent: number; blockers: Record<string, number> };
  oldRuleReproduced: boolean;
  countedByOldRule: { scenarioId: string; version: number; intent: string; independenceBlockers: string[] }[];
}

describe("[FO-17-16][FO-17-17][FO-17-12][OPS-03] held-out independence erratum (committed evidence)", () => {
  const erratum = read<Erratum>("corpus-local-20261019w5.lineage-erratum.json");
  const summary = read<{ lineage: { heldoutIndependence: { heldoutRequiredScenarios: number; acceptanceIndependent: number } } }>("corpus-local-20261019w5.summary.json");

  it("[FO-17-12] the erratum names what the unchanged w5 summary recorded and the old rule reproduces it", () => {
    expect(erratum.label).toMatch(/^LOCAL FIXTURE — SYNTHETIC DATA — NOT PRODUCTION/);
    expect(erratum.summary).toBe("corpus-local-20261019w5.summary.json");
    expect(erratum.recorded).toMatchObject({ lineageVersion: "corpus-lineage.v1", heldout: summary.lineage.heldoutIndependence.heldoutRequiredScenarios, acceptanceIndependent: summary.lineage.heldoutIndependence.acceptanceIndependent });
    expect(erratum.oldRuleReproduced).toBe(true);
    expect(erratum.countedByOldRule).toHaveLength(summary.lineage.heldoutIndependence.acceptanceIndependent);
    expect(readFileSync(join(REPO_ROOT, "evidence", "evaluation", "corpus-local-20261019w5.report.md"), "utf8")).toContain(
      `Held-out independence: ${erratum.recorded.acceptanceIndependent} of ${erratum.recorded.heldout} held-out scenarios are independent acceptance evidence.`,
    );
  });

  it("[FO-17-16][FO-17-17] every scenario the old rule counted has a family-level blocker, none is independent, and the corrected counts follow from the rows", () => {
    expect(erratum.countedByOldRule.length).toBeGreaterThan(0);
    for (const r of erratum.countedByOldRule) {
      expect(r.independenceBlockers.length, r.scenarioId).toBeGreaterThan(0);
      expect(r.independenceBlockers, r.scenarioId).toContain("INTENT_FAMILY_EXPOSED");
      expect(r.independenceBlockers.includes("REVISED_AFTER_RUNS"), r.scenarioId).toBe(r.version > 1);
      for (const b of r.independenceBlockers) expect(INDEPENDENCE_BLOCKERS as readonly string[]).toContain(b);
    }
    expect(erratum.corrected).toMatchObject({ lineageVersion: "corpus-lineage.v2", heldout: erratum.recorded.heldout, acceptanceIndependent: 0 });
    expect(erratum.corrected.blockers.INTENT_FAMILY_EXPOSED).toBe(erratum.corrected.heldout);
  });

  it("[FO-17-16] rows agree with the committed lineage for every scenario still at the erratum's version", () => {
    const lineage = new Map(loadLineage(REPO_ROOT).scenarios.map((l) => [l.scenarioId, l] as const));
    let compared = 0;
    for (const r of erratum.countedByOldRule) {
      const l = lineage.get(r.scenarioId);
      if (!l || l.version !== r.version) continue;
      compared++;
      expect({ split: l.split, previousSplit: l.previousSplit, blockers: l.independenceBlockers, independent: l.acceptanceIndependent }, r.scenarioId).toEqual({
        split: "heldout_acceptance",
        previousSplit: "heldout_acceptance",
        blockers: r.independenceBlockers,
        independent: false,
      });
    }
    expect(compared).toBe(erratum.countedByOldRule.length);
  });
});
