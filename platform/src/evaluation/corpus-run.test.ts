/**
 * Reruns and lineage on the REAL local stack (LocalConversationDriver, LOCAL FIXTURE; FO-17-12, FO-17-45): a
 * recorded result carries a rerun command that reproduces it, the rerun is a new append-only run linked to the
 * run it reruns with a reason, and a combined aggregate supersedes an earlier one without touching it.
 * Writes only under a temporary evidence root.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadLineage } from "./corpus-manifests.js";
import { HELDOUT_INDEPENDENCE_NOTE, combineRunsWithLineage, rerunOne } from "./corpus-run.js";
import { JOURNEYS } from "./journeys.js";
import { REPO_ROOT } from "./paths.js";
import { readRunContexts, readRunLineage } from "./results.js";

const evidenceRoot = mkdtempSync(join(tmpdir(), "vsp-rerun-"));
afterAll(() => rmSync(evidenceRoot, { recursive: true, force: true }));

/** Parses `pnpm evidence rerun --scenario s --version v --repetition n --seed x --rerun-of r` (the recorded command). */
function parseRerun(cmd: string): { scenarioId: string; version: number; repetition: number; seed: string; rerunOf: string } {
  const m = /^pnpm evidence rerun --scenario (\S+) --version (\d+) --repetition (\d+) --seed (\S+) --rerun-of (\S+)$/.exec(cmd);
  if (!m) throw new Error(`not a rerun command: ${cmd}`);
  return { scenarioId: m[1] as string, version: Number(m[2]), repetition: Number(m[3]), seed: m[4] as string, rerunOf: m[5] as string };
}
const comparable = (r: { verdict: string; assertions: { assertionId: string; verdict: string }[]; seed?: string | null }) => ({
  verdict: r.verdict,
  seed: r.seed ?? null,
  assertions: r.assertions.map((a) => `${a.assertionId}=${a.verdict}`).sort(),
});

describe("[FO-17-12][FO-17-45] reproducible reruns with lineage on the local stack", () => {
  const journey = JOURNEYS.find((j) => j.scenarioId.startsWith("scn_journey_5_")) ?? JOURNEYS[0];

  it("[FO-17-45][FO-17-12] the recorded rerun command reproduces the result in a new run linked to the original with a reason; append-only outputs; a changed version is refused", async () => {
    if (!journey) throw new Error("journey missing");
    const first = await rerunOne({ scenarioId: journey.scenarioId, repetition: 1, runId: "run_rerunTestOriginal01", evidenceRoot, command: "test: original run" });
    expect(first.result.rerunCommand).toMatch(/^pnpm evidence rerun /);
    const cmd = parseRerun(first.result.rerunCommand as string);
    expect(cmd).toMatchObject({ scenarioId: journey.scenarioId, version: journey.version, repetition: 1, rerunOf: "run_rerunTestOriginal01" });
    expect(cmd.seed).toBe(first.result.seed);

    const again = await rerunOne({ ...cmd, runId: "run_rerunTestReplay001", evidenceRoot, command: first.result.rerunCommand as string, reason: "REPRODUCE" });
    expect(comparable(again.result)).toEqual(comparable(first.result));
    expect(readRunLineage(again.dir)).toMatchObject({ runId: "run_rerunTestReplay001", rerunOf: ["run_rerunTestOriginal01"], reason: "REPRODUCE", command: first.result.rerunCommand });
    expect(readRunContexts(again.dir)[0]).toMatchObject({ scenarioId: journey.scenarioId, repetition: 1, seed: cmd.seed });
    // The original run is untouched and a run id is never reused.
    expect(readFileSync(join(first.dir, "results.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
    await expect(rerunOne({ ...cmd, runId: "run_rerunTestReplay001", evidenceRoot, command: "x" })).rejects.toThrow();
    await expect(rerunOne({ ...cmd, version: cmd.version + 1, evidenceRoot, command: "x" })).rejects.toThrow(/RERUN_VERSION_CHANGED/);
  }, 180_000);

  it("[FO-17-12] a combined aggregate supersedes an earlier one by name and reason; both are kept and neither is overwritten", () => {
    const a = combineRunsWithLineage({ runIds: ["run_rerunTestOriginal01"], name: "corpus-test-original", evidenceRoot });
    const b = combineRunsWithLineage({ runIds: ["run_rerunTestReplay001"], name: "corpus-test-rerun", supersedes: ["corpus-test-original"], reason: "SCORER_REPAIR", evidenceRoot });
    expect(b.summary.lineage).toMatchObject({ supersedes: ["corpus-test-original"], reason: "SCORER_REPAIR" });
    expect(b.summary.lineage.sourceRunLineage[0]).toMatchObject({ rerunOf: ["run_rerunTestOriginal01"] });
    // [FO-17-16] the summary carries the lineage's held-out independence (blocker counts included), never a recount.
    const lineage = loadLineage(REPO_ROOT);
    expect(b.summary.lineage.heldoutIndependence).toEqual({
      heldoutRequiredScenarios: lineage.heldoutIndependence.heldout,
      acceptanceIndependent: lineage.heldoutIndependence.acceptanceIndependent,
      blockers: lineage.heldoutIndependence.blockers,
      lineageVersion: "corpus-lineage.v2",
      note: HELDOUT_INDEPENDENCE_NOTE,
    });
    expect(readFileSync(b.reportPath, "utf8")).toContain(
      `Held-out independence: ${lineage.heldoutIndependence.acceptanceIndependent} of ${lineage.heldoutIndependence.heldout} held-out scenarios are independent acceptance evidence (blockers among held-out: MOVED_INTO_HELDOUT ${lineage.heldoutIndependence.blockers.MOVED_INTO_HELDOUT}, INTENT_FAMILY_EXPOSED ${lineage.heldoutIndependence.blockers.INTENT_FAMILY_EXPOSED}, REVISED_AFTER_RUNS ${lineage.heldoutIndependence.blockers.REVISED_AFTER_RUNS}).`,
    );
    expect(existsSync(a.summaryPath)).toBe(true);
    expect(() => combineRunsWithLineage({ runIds: ["run_rerunTestReplay001"], name: "corpus-test-rerun", evidenceRoot })).toThrow("COMBINE_OUTPUT_EXISTS");
    expect(() => combineRunsWithLineage({ runIds: ["run_rerunTestReplay001"], name: "corpus-test-third", supersedes: ["corpus-test-missing"], evidenceRoot })).toThrow(/COMBINE_SUPERSEDES_UNKNOWN/);
  });
});
