/**
 * The committed fault-reach erratum of the w5 combined run (FO-17-11, FO-17-44, FO-17-12): the w5 summary and
 * report stay as written (append-only); the rescore check of the w5 runs with the current scorer
 * (`corpus-local-20261019w5.rescore-check-r4.json`) changes exactly the DUPLICATE_WEBHOOK results that had passed
 * on the local driver's own outbox redelivery count, and the erratum's corrected counts follow from those rows
 * (evidence/evaluation/tools/reach-erratum.mts).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadCorpus } from "./corpus.js";
import { REPO_ROOT } from "./paths.js";

const read = <T,>(name: string): T => JSON.parse(readFileSync(join(REPO_ROOT, "evidence", "evaluation", name), "utf8")) as T;

interface Totals {
  pass: number;
  fail: number;
  inconclusive: number;
  notRun: number;
  taskCompletionRate: number | null;
}
interface FaultRow {
  faultId: string;
  requested: number;
  reached: number;
  reachedAndPassed: number;
  notReached: number;
}
interface Erratum {
  label: string;
  summary: string;
  rescoreCheck: string;
  recorded: { totals: Totals; fault: FaultRow; localGate: string };
  corrected: { totals: Totals & { required: number }; fault: FaultRow; localGate: string };
  selfReportCorrections: number;
  explained: boolean;
  problems: string[];
  results: { runId: string; scenarioId: string; repetition: number; recordedVerdict: string; correctedVerdict: string; recordedObservedBy: string }[];
}
interface Rescore {
  runs: string[];
  summary: { results: number; same: number; different: number; versionMismatch: number; evidenceUnparseable: number };
  different: { runId: string; scenarioId: string; repetition: number; status: string; recordedVerdict: string; rescoredVerdict: string; diffs: { field: string; recorded: unknown; rescored: unknown }[] }[];
}
interface Summary {
  runIds: string[];
  totals: Totals & { runs: number; required: number };
  gates: Record<string, { status: string }>;
  coverageHoles: { faults: FaultRow[] };
}

describe("[FO-17-11][FO-17-44][FO-17-12][OPS-03] fault-reach erratum of the w5 run (committed evidence)", () => {
  const erratum = read<Erratum>("corpus-local-20261019w5.reach-erratum.json");
  const rescore = read<Rescore>("corpus-local-20261019w5.rescore-check-r4.json");
  const summary = read<Summary>("corpus-local-20261019w5.summary.json");
  const corpus = loadCorpus();

  it("[FO-17-12] the erratum names the unchanged w5 summary and a complete rescore of exactly its runs", () => {
    expect(erratum.label).toMatch(/^LOCAL FIXTURE — SYNTHETIC DATA — NOT PRODUCTION/);
    expect(erratum).toMatchObject({ summary: "corpus-local-20261019w5.summary.json", rescoreCheck: "corpus-local-20261019w5.rescore-check-r4.json", explained: true, problems: [] });
    expect([...rescore.runs].sort()).toEqual([...summary.runIds].sort());
    expect(rescore.summary).toMatchObject({ results: summary.totals.runs, versionMismatch: 0, evidenceUnparseable: 0 });
    expect(rescore.summary.same + rescore.summary.different).toBe(summary.totals.runs);
    const fault = summary.coverageHoles.faults.find((f) => f.faultId === "DUPLICATE_WEBHOOK");
    expect(erratum.recorded).toMatchObject({ totals: { pass: summary.totals.pass, fail: summary.totals.fail, inconclusive: summary.totals.inconclusive, notRun: summary.totals.notRun }, fault, localGate: summary.gates.local?.status });
  });

  it("[FO-17-11][FO-17-44] every result the rescore changed is a DUPLICATE_WEBHOOK run that had passed on the driver's outbox self-report and is INCONCLUSIVE without reachedFault now", () => {
    expect(rescore.different.length).toBe(erratum.selfReportCorrections);
    expect(erratum.results.length).toBe(rescore.different.length);
    expect(rescore.different.length).toBeGreaterThan(0);
    for (const r of rescore.different) {
      const id = `${r.runId} ${r.scenarioId}#${r.repetition}`;
      expect(corpus.byId.get(r.scenarioId)?.initialState.faults, id).toContain("DUPLICATE_WEBHOOK");
      expect([r.status, r.recordedVerdict, r.rescoredVerdict], id).toEqual(["DIFFERENT", "PASS", "INCONCLUSIVE"]);
      const reached = r.diffs.find((d) => d.field === "reachedFault");
      expect(reached?.recorded, id).toMatchObject({ faultId: "DUPLICATE_WEBHOOK", observedBy: "emulator_log.outbox_redelivered" });
      expect(reached?.rescored, id).toBeNull();
      expect(r.diffs.find((d) => d.field === "assertion:evidence.fault_reached.duplicate_webhook"), id).toMatchObject({ recorded: "PASS", rescored: "INCONCLUSIVE" });
      // No other assertion changed: only the verdict, its failure code, the gate results it caps and the reach.
      expect(r.diffs.filter((d) => d.field.startsWith("assertion:")).map((d) => d.field), id).toEqual(["assertion:evidence.fault_reached.duplicate_webhook"]);
      expect(erratum.results.some((x) => x.runId === r.runId && x.scenarioId === r.scenarioId && x.repetition === r.repetition && x.correctedVerdict === "INCONCLUSIVE")).toBe(true);
    }
  });

  it("[FO-17-11][OPS-03] the corrected counts follow from the rows: PASS and reached fall by the corrections, INCONCLUSIVE and not-reached rise, the local gate stays FAIL", () => {
    const n = erratum.selfReportCorrections;
    const t = summary.totals;
    expect(erratum.corrected.totals).toMatchObject({ pass: t.pass - n, fail: t.fail, inconclusive: t.inconclusive + n, notRun: t.notRun });
    expect(erratum.corrected.totals.taskCompletionRate).toBeCloseTo((t.pass - n) / t.required, 12);
    const f = erratum.recorded.fault;
    expect(erratum.corrected.fault).toMatchObject({ faultId: "DUPLICATE_WEBHOOK", requested: f.requested, reached: f.reached - n, reachedAndPassed: f.reachedAndPassed - n, notReached: f.notReached + n });
    expect(erratum.corrected.localGate).toBe("FAIL");
  });

  it("[FO-17-11] the committed plan no longer admits the outbox count as reach evidence (the cause of the erratum)", () => {
    const plan = corpus.faultPlans.get("DUPLICATE_WEBHOOK");
    expect(plan?.reachEvidence.some((r) => r.source === "emulator_log" && (r.log as string) === "outbox_redelivered_messages")).toBe(false);
    expect(plan?.reachEvidence).toContainEqual({ source: "driver_self_report", note: "outbox_redelivered" });
  });
});
