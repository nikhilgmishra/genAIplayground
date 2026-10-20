/**
 * Fault reach over the real in-process LOCAL FIXTURE driver (FO-17-11, FO-17-44 "requestedFault and reachedFault
 * from independent evidence (not driver self-report)"; OPS-03).
 *
 * The DUPLICATE_WEBHOOK plan has two local signals. On the transfer path the telephony emulator records each
 * duplicate delivery it made (TELEPHONY_DUPLICATE_EVENTS_<n>, an emulator log): that is reach evidence. On the
 * outbox path the only signal is the driver's own count of the messages it re-published (DUPLICATE_REDELIVERIES_<n>):
 * a driver self-report, which never sets reachedFault, so the run is INCONCLUSIVE although every other hard gate
 * holds. Both scenarios run end to end through the runner, the LocalConversationDriver (full local container over
 * the gateway HTTP surface) and the scorer; nothing here is a fixture of the evidence.
 */
import { describe, expect, it } from "vitest";
import { loadCorpus } from "../../src/evaluation/corpus.js";
import { LocalConversationDriver } from "../../src/evaluation/driver/local-driver.js";
import { runScenarios } from "../../src/evaluation/runner.js";
import type { CallEvidence } from "../../src/evaluation/runner.js";
import type { EvaluationResult, ScenarioDefinition } from "../../src/protocol/index.js";

const corpus = loadCorpus();
const TIMEOUT = 60_000;

async function runOne(id: string): Promise<{ result: EvaluationResult; evidence: CallEvidence }> {
  const s = corpus.byId.get(id);
  if (!s) throw new Error(`missing scenario ${id}`);
  const one: ScenarioDefinition = { ...s, repetitions: 1 };
  const evidence: (CallEvidence | null)[] = [];
  const driver = new LocalConversationDriver({ transport: "http" });
  try {
    const out = await runScenarios(driver, [one], { executionMode: "local_fixture", environment: "local", faultPlans: corpus.faultPlans, runId: "run_faultReachDriver01", sink: { append: (_r, e) => void evidence.push(e) } });
    const e = evidence[0];
    if (!e) throw new Error("no evidence collected");
    return { result: out.results[0] as EvaluationResult, evidence: e };
  } finally {
    await driver.dispose();
  }
}

const notes = (e: CallEvidence) => ((e.committedState?.driverNotes as unknown[] | undefined) ?? []).filter((n): n is string => typeof n === "string");

describe("[FO-17-11][FO-17-44][OPS-03] DUPLICATE_WEBHOOK reach over the real local driver: emulator evidence reaches, a driver self-report never does", () => {
  it(
    "[FO-17-44][OPS-03] outbox path (scn_risk_duplicate_webhook_002): the driver reports its redeliveries, no emulator or backend record shows them: INCONCLUSIVE, no reachedFault, every other assertion PASS",
    async () => {
      const { result, evidence } = await runOne("scn_risk_duplicate_webhook_002");
      expect(evidence.faultsInjected).toContain("DUPLICATE_WEBHOOK");
      expect(notes(evidence).some((n) => /^DUPLICATE_REDELIVERIES_[1-9]\d*$/.test(n))).toBe(true);
      expect(notes(evidence)).toContain("TELEPHONY_DUPLICATE_EVENTS_0");
      expect(result.requestedFault).toBe("DUPLICATE_WEBHOOK");
      expect(result.reachedFault).toBeNull();
      expect(result.verdict).toBe("INCONCLUSIVE");
      expect(result.failureCode).toBe("INCONCLUSIVE_EVIDENCE_FAULT_REACHED_DUPLICATE_WEBHOOK");
      const reach = result.assertions.find((a) => a.assertionId === "evidence.fault_reached.duplicate_webhook");
      expect(reach).toMatchObject({ verdict: "INCONCLUSIVE", hardGate: true });
      expect(reach?.detail).toContain("driver_notes.outbox_redelivered (driver self-report)");
      expect(result.assertions.filter((a) => a.verdict !== "PASS").map((a) => a.assertionId)).toEqual(["evidence.fault_reached.duplicate_webhook"]);
    },
    TIMEOUT,
  );

  it(
    "[FO-17-11] transfer path (scn_risk_duplicate_webhook_021): the telephony emulator logged the duplicate deliveries: reached on emulator evidence and PASS",
    async () => {
      const { result, evidence } = await runOne("scn_risk_duplicate_webhook_021");
      expect(notes(evidence).some((n) => /^TELEPHONY_DUPLICATE_EVENTS_[1-9]\d*$/.test(n))).toBe(true);
      expect(result.reachedFault).toMatchObject({ faultId: "DUPLICATE_WEBHOOK", observedBy: "emulator_log.telephony_delivered" });
      expect(result.assertions.find((a) => a.assertionId === "evidence.fault_reached.duplicate_webhook")?.verdict).toBe("PASS");
      expect(result.verdict).toBe("PASS");
    },
    TIMEOUT,
  );
});
