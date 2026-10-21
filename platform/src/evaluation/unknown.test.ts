import { describe, expect, it } from "vitest";
import type { CallEvidence, ToolCallObservation } from "./runner.js";
import {
  ambiguousOutcomes,
  classifyRecordedTest,
  combineQualification,
  combineRecordedTests,
  combineVerdicts,
  countsAsPass,
  verdictOf,
  verdictOfTests,
} from "./unknown.js";

const call = (name: string, status: ToolCallObservation["status"]): ToolCallObservation => ({ name, version: "1.0.0", status, turnIndex: null, auditEventId: null, sessionState: "valid", reasonCode: null });
const committed = (reconciled: boolean, effectCount = 1): NonNullable<CallEvidence["committedActions"]>[number] => ({
  actionKind: "appointment_reschedule",
  actionId: "act_synthUnknown0001",
  targetRef: null,
  receiptId: "rcp_synthUnknown0001",
  auditEventId: "aud_synthUnknown0001",
  confirmationBound: true,
  confirmationFresh: true,
  effectCount,
  reconciled,
});

describe("[FO-22-07][OPS-03][ACT-03] one shared UNKNOWN classification", () => {
  it("[FO-22-07][OPS-03] an unknown observation, an empty or unrun test set and any unrecognised report status are never PASS", () => {
    expect([verdictOf(true), verdictOf(false), verdictOf(null), verdictOf(undefined)]).toEqual(["PASS", "FAIL", "INCONCLUSIVE", "INCONCLUSIVE"]);
    expect(combineVerdicts([])).toBe("NOT_RUN");
    expect(combineVerdicts(["PASS", "NOT_RUN"])).toBe("INCONCLUSIVE");
    expect(combineVerdicts(["PASS", "INCONCLUSIVE"])).toBe("INCONCLUSIVE");
    expect(combineVerdicts(["PASS", "BLOCKED"])).toBe("BLOCKED");
    expect(combineVerdicts(["INCONCLUSIVE", "FAIL"])).toBe("FAIL");
    expect(combineVerdicts(["PASS", "PASS"])).toBe("PASS");
    expect(["INCONCLUSIVE", "NOT_RUN", "BLOCKED", null, undefined].map((v) => countsAsPass(v as never))).toEqual([false, false, false, false, false]);
    expect(["passed", "failed", "skipped", "pending", "todo", "unknown", null].map((s) => classifyRecordedTest(s))).toEqual(["passed", "failed", "skipped", "skipped", "skipped", "not_run", "not_run"]);
    expect(combineRecordedTests([])).toBe("not_run");
    expect(combineRecordedTests(["passed", "skipped"])).toBe("skipped");
    expect(combineRecordedTests(["passed", "not_run"])).toBe("not_run");
    expect(verdictOfTests([])).toBe("NOT_RUN");
    expect(verdictOfTests(["passed", "skipped"])).toBe("INCONCLUSIVE");
    expect(verdictOfTests(["passed", "passed"])).toBe("PASS");
  });

  it("[FO-22-07][FO-00-29] qualification roll-up: PASS only when every member passed; any FAIL fails; nothing run is NOT_RUN; INCONCLUSIVE or unrun members never roll up to PASS", () => {
    expect(combineQualification([])).toBe("NOT_RUN");
    expect(combineQualification(["NOT_RUN", "NOT_RUN"])).toBe("NOT_RUN");
    expect(combineQualification(["PASS", "PASS"])).toBe("PASS");
    expect(combineQualification(["PASS", "INCONCLUSIVE"])).toBe("INCONCLUSIVE");
    expect(combineQualification(["INCONCLUSIVE"])).toBe("INCONCLUSIVE");
    expect(combineQualification(["PASS", "NOT_RUN"])).toBe("INCONCLUSIVE");
    expect(combineQualification(["PASS", "FAIL", "INCONCLUSIVE"])).toBe("FAIL");
  });

  it("[FO-22-07][ACT-03] ambiguous outcomes: reconciled before success, a retry only after a NOT_FOUND reconciliation that completed first, and unreconciled otherwise; null when not collected", () => {
    const base = { committedStateSource: "authoritative_backend" as const };
    expect(ambiguousOutcomes({ ...base, toolCalls: null, committedActions: [] })).toBeNull();
    expect(ambiguousOutcomes({ ...base, toolCalls: [call("commit_appointment_change", "SUCCESS")], committedActions: [] })).toEqual([]);
    // A prepare that timed out is not an ambiguous effect; reads never are.
    expect(ambiguousOutcomes({ ...base, toolCalls: [call("prepare_appointment_change", "UNKNOWN_OUTCOME"), call("get_appointment_options", "UNKNOWN_OUTCOME")], committedActions: [] })).toEqual([]);
    const unknown = [call("commit_appointment_change", "UNKNOWN_OUTCOME")];
    expect(ambiguousOutcomes({ ...base, toolCalls: unknown, committedActions: null })).toBeNull();
    expect(ambiguousOutcomes({ committedStateSource: "transcript_inference", toolCalls: unknown, committedActions: [committed(true)] })).toBeNull();
    expect(ambiguousOutcomes({ ...base, toolCalls: unknown, committedActions: [committed(true)] })).toEqual([{ tool: "commit_appointment_change", index: 0, retryIndex: null, class: "RECONCILED_COMMITTED" }]);
    expect(ambiguousOutcomes({ ...base, toolCalls: unknown, committedActions: [committed(false)] })).toEqual([{ tool: "commit_appointment_change", index: 0, retryIndex: null, class: "UNRECONCILED" }]);
    // A reconciled receipt without an effect in the system of record is not a reconciled commit.
    expect(ambiguousOutcomes({ ...base, toolCalls: unknown, committedActions: [committed(true, 0)] })?.[0]?.class).toBe("UNRECONCILED");

    // Retries: unknown commit at 0, a read at 1, the retried commit at 2.
    const retried = [...unknown, call("get_appointment_options", "SUCCESS"), call("commit_appointment_change", "SUCCESS")];
    const rec = (over: Partial<NonNullable<CallEvidence["reconciliations"]>[number]>): NonNullable<CallEvidence["reconciliations"]>[number] => ({
      toolCallIndex: 0,
      actionKind: "appointment_reschedule",
      outcome: "NOT_FOUND",
      completedBeforeToolCallIndex: 1,
      auditEventId: "aud_synthReconcile0001",
      ...over,
    });
    const classOf = (reconciliations: CallEvidence["reconciliations"], committedActions = [committed(false)]) => ambiguousOutcomes({ ...base, toolCalls: retried, committedActions, reconciliations })?.[0];
    // Not collected (absent or null): the retry cannot be judged.
    expect(classOf(undefined)).toEqual({ tool: "commit_appointment_change", index: 0, retryIndex: 2, class: "RETRY_RECONCILIATION_NOT_COLLECTED" });
    expect(classOf(null)?.class).toBe("RETRY_RECONCILIATION_NOT_COLLECTED");
    // Collected: legitimate only after a NOT_FOUND reconciliation of THIS call that completed before the retry.
    expect(classOf([rec({})])).toEqual({ tool: "commit_appointment_change", index: 0, retryIndex: 2, class: "RETRIED_AFTER_NOT_FOUND" });
    expect(classOf([rec({ completedBeforeToolCallIndex: 2 })])?.class).toBe("RETRIED_AFTER_NOT_FOUND");
    expect(classOf([])?.class).toBe("RETRIED_WITHOUT_RECONCILIATION");
    expect(classOf([rec({ outcome: "FOUND" })])?.class).toBe("RETRIED_WITHOUT_RECONCILIATION");
    expect(classOf([rec({ outcome: "STILL_UNKNOWN" })])?.class).toBe("RETRIED_WITHOUT_RECONCILIATION");
    // Completed only after the retry was made.
    expect(classOf([rec({ completedBeforeToolCallIndex: 3 })])?.class).toBe("RETRIED_WITHOUT_RECONCILIATION");
    // A reconciliation of another call does not cover this one; nor does one "completed" before the ambiguous call itself.
    expect(classOf([rec({ toolCallIndex: 1 })])?.class).toBe("RETRIED_WITHOUT_RECONCILIATION");
    expect(classOf([rec({ completedBeforeToolCallIndex: 0 })])?.class).toBe("RETRIED_WITHOUT_RECONCILIATION");
    // A retry after the original was reconciled as committed is still a retry without a NOT_FOUND reconciliation.
    expect(classOf([rec({ outcome: "FOUND" })], [committed(true)])?.class).toBe("RETRIED_WITHOUT_RECONCILIATION");
    // A later call that failed again is not a retry that took effect.
    expect(ambiguousOutcomes({ ...base, toolCalls: [...unknown, call("commit_appointment_change", "RETRYABLE_FAILURE")], committedActions: [committed(false)], reconciliations: [] })?.[0]).toMatchObject({ retryIndex: null, class: "UNRECONCILED" });
  });
});
