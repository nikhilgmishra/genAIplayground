import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EvaluationResult } from "../protocol/index.js";
import type { ScenarioDefinition } from "../protocol/index.js";
import { FakeClock } from "../shared/clock.js";
import { aggregateResults, renderReport } from "./aggregate.js";
import { loadCorpus } from "./corpus.js";
import { ScriptedConversationDriverFixture, idealEvidenceFixture } from "./evidence.fixture.js";
import { FAULTED_JOURNEYS, JOURNEYS } from "./journeys.js";
import { readRunResults, RunResultWriter, ResultsWriterError } from "./results.js";
import { RunnerError, runScenarios } from "./runner.js";
import type { ConversationDriver } from "./runner.js";

const { faultPlans } = loadCorpus();
const byFault = (f: string): ScenarioDefinition => {
  const s = FAULTED_JOURNEYS.find((j) => j.initialState.faults.includes(f));
  if (!s) throw new Error("missing");
  return s;
};
const reschedule = JOURNEYS[0] as ScenarioDefinition;
const opts = { executionMode: "local_fixture" as const, environment: "local" as const, faultPlans, clock: new FakeClock(), runId: "run_runnerTest0001" };

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "vsp-eval-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("scenario runner with ScriptedConversationDriverFixture (labelled local fixture)", () => {
  it("[SPEC-14.repetitions] runs each scenario max(scenario.repetitions, requested minimum) times and never fewer than the scenario requires", async () => {
    const safety = JOURNEYS.find((j) => j.requiredHandoff === "SAFETY_PRIORITY") as ScenarioDefinition;
    const driver = new ScriptedConversationDriverFixture();
    const { results } = await runScenarios(driver, [reschedule, safety], { ...opts, repetitions: 2 });
    expect(results.filter((r) => r.scenarioId === reschedule.scenarioId).map((r) => r.repetition)).toEqual([1, 2]);
    expect(results.filter((r) => r.scenarioId === safety.scenarioId)).toHaveLength(5);
    expect(results.every((r) => EvaluationResult.safeParse(r).success)).toBe(true);
    expect(results.every((r) => r.verdict === "PASS")).toBe(true);
  });

  it("[SPEC-16.fault-injection] arms hook-triggered faults at call start and injects AT_TURN faults before the named turn", async () => {
    const driver = new ScriptedConversationDriverFixture();
    await runScenarios(driver, [byFault("CRASH_AFTER_COMMIT"), byFault("INTERRUPTED_CONFIRMATION"), byFault("SALESFORCE_OUTAGE")], opts);
    const [crash, interrupted, salesforce] = driver.calls;
    expect(crash?.faults).toEqual([{ faultId: "CRASH_AFTER_COMMIT", phase: "arm", beforeTurn: 0 }]);
    const turnIndex = faultPlans.get("INTERRUPTED_CONFIRMATION")?.trigger.turnIndex;
    expect(interrupted?.faults).toEqual([{ faultId: "INTERRUPTED_CONFIRMATION", phase: "now", beforeTurn: turnIndex }]);
    expect(salesforce?.faults).toEqual([{ faultId: "SALESFORCE_OUTAGE", phase: "now", beforeTurn: 0 }]);
    expect(driver.calls.every((c) => c.ended)).toBe(true);
  });

  it("[OPS-03] driver errors, invalid evidence, rejected faults and missing fault plans are INCONCLUSIVE, never PASS", async () => {
    const crash = byFault("CRASH_AFTER_COMMIT");
    const throwing = new ScriptedConversationDriverFixture({ throwOnStart: () => true });
    expect((await runScenarios(throwing, [reschedule], opts)).results[0]?.verdict).toBe("INCONCLUSIVE");
    const garbage = new ScriptedConversationDriverFixture({ evidenceFor: () => ({ outcome: "RESOLVED" }) });
    const g = (await runScenarios(garbage, [reschedule], opts)).results[0];
    expect(g?.verdict).toBe("INCONCLUSIVE");
    expect(g?.failureCode).toBe("INCONCLUSIVE_EVIDENCE_COLLECTED");
    const rejecting = new ScriptedConversationDriverFixture({ rejectFaults: ["CRASH_AFTER_COMMIT"] });
    expect((await runScenarios(rejecting, [crash], opts)).results[0]?.verdict).toBe("INCONCLUSIVE");
    const noPlans = new ScriptedConversationDriverFixture();
    expect((await runScenarios(noPlans, [crash], { ...opts, faultPlans: new Map() })).results[0]?.verdict).toBe("INCONCLUSIVE");
  });

  it("[OPS-03] a local fixture driver cannot be labelled as a vendor or PSTN execution", async () => {
    const driver = new ScriptedConversationDriverFixture();
    await expect(runScenarios(driver, [reschedule], { ...opts, executionMode: "vendor_sandbox" })).rejects.toThrow(RunnerError);
    const liar: ConversationDriver = Object.assign(Object.create(ScriptedConversationDriverFixture.prototype) as ConversationDriver, new ScriptedConversationDriverFixture(), {
      executionMode: "pstn_sandbox" as const,
    });
    await expect(runScenarios(liar, [reschedule], { ...opts, executionMode: "pstn_sandbox" })).rejects.toThrow("FIXTURE_DRIVER_CANNOT_CLAIM_LIVE_MODE");
  });

  it("[SPEC-14.scorecard] results stream to the append-only writer and can be read back; summary and report are written once", async () => {
    const root = tmp();
    const writer = RunResultWriter.create({ evidenceRoot: root, idSource: () => "run_writerTest0001" });
    const driver = new ScriptedConversationDriverFixture();
    const { runId, results } = await runScenarios(driver, JOURNEYS, { ...opts, runId: writer.runId, sink: writer, evidenceRefFor: writer.evidenceRefFor });
    expect(runId).toBe("run_writerTest0001");
    expect(writer.recordCount).toBe(results.length);
    const back = readRunResults(writer.dir);
    expect(back).toEqual(results);
    expect(back[0]?.evidenceRef).toBe(`evidence/runs/run_writerTest0001/call-evidence.jsonl#${JOURNEYS[0]?.scenarioId}/1`);
    const agg = aggregateResults(results, JOURNEYS);
    writer.finalize(agg, renderReport(agg));
    expect(JSON.parse(readFileSync(join(writer.dir, "summary.json"), "utf8")).aggregateVersion).toBe("evaluation-aggregate.v1");
    expect(readFileSync(join(writer.dir, "report.md"), "utf8")).toContain("Local fixture evidence only");
    expect(() => writer.finalize(agg, "x")).toThrow(ResultsWriterError);
    expect(() => writer.append(results[0] as EvaluationResult, null)).toThrow("RUN_FINALIZED");
  });
});

describe("append-only results writer", () => {
  it("[SPEC-14.scorecard] refuses to reopen or overwrite an existing run directory", () => {
    const root = tmp();
    RunResultWriter.create({ evidenceRoot: root, runId: "run_duplicate0001" });
    expect(() => RunResultWriter.create({ evidenceRoot: root, runId: "run_duplicate0001" })).toThrow("RUN_ALREADY_EXISTS");
  });

  it("[SPEC-14.scorecard] validates every record, rejects foreign run ids and invalid run ids", () => {
    const root = tmp();
    expect(() => RunResultWriter.create({ evidenceRoot: root, runId: "bad id" })).toThrow("RUN_ID_INVALID");
    const w = RunResultWriter.create({ evidenceRoot: root, idSource: () => "run_validation001" });
    const good = { ...idealResult(), runId: "run_validation001" };
    w.append(good, null);
    expect(() => w.append({ ...good, runId: "run_someoneElse01" }, null)).toThrow("RESULT_RUN_ID_MISMATCH");
    expect(() => w.append({ ...good, verdict: "MAYBE" } as unknown as EvaluationResult, null)).toThrow("RESULT_SCHEMA_INVALID");
    expect(readRunResults(w.dir)).toHaveLength(1);
  });

  it("[SPEC-14.scorecard] uses the injectable id source for the run id", () => {
    const root = tmp();
    let n = 0;
    const ids = () => `run_injected000${++n}`;
    expect(RunResultWriter.create({ evidenceRoot: root, idSource: ids }).runId).toBe("run_injected0001");
    expect(RunResultWriter.create({ evidenceRoot: root, idSource: ids }).runId).toBe("run_injected0002");
  });
});

function idealResult(): EvaluationResult {
  return {
    runId: "run_validation001",
    runAt: "2026-10-17T15:00:00.000Z",
    environment: "local",
    executionMode: "local_fixture",
    scenarioId: reschedule.scenarioId,
    scenarioVersion: 1,
    repetition: 1,
    corpusSplit: "development",
    audience: "client",
    language: "en-US",
    channel: "simulated_voice",
    variant: "baseline",
    expectedPermissions: [],
    versions: idealEvidenceFixture(reschedule).versions ?? (null as never),
    vendorInteractionId: null,
    vendorSessionId: null,
    assertions: [],
    safetyResult: "PASS",
    privacyResult: "PASS",
    authenticationResult: "PASS",
    transactionResult: "PASS",
    auditEvidenceResult: "PASS",
    committedState: {},
    qualityScores: {},
    latencyMs: { p50: null, p95: null, p99: null },
    costUsd: null,
    transferOutcome: null,
    finalResolution: "RESOLVED",
    failureCode: null,
    evidenceRef: null,
    reviewer: null,
    verdict: "PASS",
  };
}
