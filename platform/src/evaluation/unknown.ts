/**
 * One shared UNKNOWN classification (FO-22-07 "Preserve UNKNOWN handling"; ACT-03; OPS-03).
 *
 * Two kinds of "unknown" exist in the evaluation code and both are classified here, once:
 *
 *  1. Evidence and test status. Anything not recorded (null, undefined, a skipped or unrun test, a
 *     missing report, an unknown capability) is never PASS: it is INCONCLUSIVE or NOT_RUN. The scorer,
 *     the aggregate, the fault registry and the traceability generator all classify through
 *     `verdictOf` / `classifyRecordedTest` / `combineVerdicts`, so no module can count an unknown as a pass.
 *  2. Ambiguous action outcomes. A consequential tool that returned UNKNOWN_OUTCOME (timeout after send,
 *     crash after commit, lost receipt) is AMBIGUOUS until authoritative state reconciles it; success may
 *     be announced, and RESOLVED recorded, only after reconciliation (ACT-03), and a retry is legitimate
 *     only once reconciliation found no effect. `ambiguousOutcomes` classifies every ambiguous tool result
 *     of a call from backend-recorded evidence; the scorer's transaction gate uses it.
 */
import type { Verdict } from "../protocol/index.js";
import type { CallEvidence } from "./runner.js";
import { isConsequentialToolName } from "./vocabulary.js";

/** Never PASS for null/undefined; a boolean check maps to PASS/FAIL; everything else is INCONCLUSIVE. */
export function verdictOf(observation: boolean | null | undefined): Verdict {
  if (observation === true) return "PASS";
  if (observation === false) return "FAIL";
  return "INCONCLUSIVE";
}

/** Verdict combination: any FAIL wins, then INCONCLUSIVE, then BLOCKED; no verdicts at all is NOT_RUN (never PASS). */
export function combineVerdicts(verdicts: readonly Verdict[]): Verdict {
  if (verdicts.includes("FAIL")) return "FAIL";
  if (verdicts.includes("INCONCLUSIVE")) return "INCONCLUSIVE";
  if (verdicts.includes("BLOCKED")) return "BLOCKED";
  if (verdicts.length === 0) return "NOT_RUN";
  if (verdicts.includes("NOT_RUN")) return "INCONCLUSIVE";
  return "PASS";
}

/** Only a recorded PASS counts as a pass; INCONCLUSIVE, NOT_RUN, BLOCKED and a missing result do not. */
export const countsAsPass = (v: Verdict | null | undefined): boolean => v === "PASS";

export type RecordedTestStatus = "passed" | "failed" | "skipped" | "not_run";

/** Maps a raw test-report status to a recorded status; anything unrecognised is not_run (never passed). */
export function classifyRecordedTest(raw: string | null | undefined): RecordedTestStatus {
  if (raw === "passed") return "passed";
  if (raw === "failed") return "failed";
  if (raw === "skipped" || raw === "pending" || raw === "todo") return "skipped";
  return "not_run";
}

/** Combines the recorded statuses of several tests: passed only if there is at least one and every one passed. */
export function combineRecordedTests(statuses: readonly RecordedTestStatus[]): RecordedTestStatus {
  if (statuses.length === 0) return "not_run";
  if (statuses.includes("failed")) return "failed";
  if (statuses.every((s) => s === "passed")) return "passed";
  return statuses.includes("not_run") ? "not_run" : "skipped";
}

/** Verdict for a set of recorded test statuses (OPS-03: unrun or skipped is not PASS). */
export function verdictOfTests(statuses: readonly RecordedTestStatus[]): Verdict {
  const s = combineRecordedTests(statuses);
  return s === "passed" ? "PASS" : s === "failed" ? "FAIL" : statuses.length === 0 ? "NOT_RUN" : "INCONCLUSIVE";
}

export type Qualification = "NOT_RUN" | "FAIL" | "INCONCLUSIVE" | "PASS";

/**
 * Qualification roll-up over members (a capability, an invariant's test roles): FAIL if any member failed; PASS
 * only when there is at least one member and every one passed; NOT_RUN when nothing ran; INCONCLUSIVE otherwise
 * (a mixture that includes unrun or inconclusive members is never PASS).
 */
export function combineQualification(qs: readonly Qualification[]): Qualification {
  if (qs.includes("FAIL")) return "FAIL";
  if (qs.length > 0 && qs.every((q) => q === "PASS")) return "PASS";
  if (qs.every((q) => q === "NOT_RUN")) return "NOT_RUN";
  return "INCONCLUSIVE";
}

export type AmbiguityClass =
  /** Authoritative state shows the effect and a reconciliation that bound it (receipt reconciled). */
  | "RECONCILED_COMMITTED"
  /** A later call of the same tool took effect after a reconciliation found NO effect and completed before it: legitimate. */
  | "RETRIED_AFTER_NOT_FOUND"
  /**
   * A later call of the same tool took effect without a NOT_FOUND reconciliation completed before it (none, FOUND,
   * STILL_UNKNOWN, or one that completed only after the retry): the retry risks a second effect (ACT-03).
   */
  | "RETRIED_WITHOUT_RECONCILIATION"
  /** A later call of the same tool took effect, but reconciliation records were not collected: cannot be judged. */
  | "RETRY_RECONCILIATION_NOT_COLLECTED"
  /** Still ambiguous at the end of the evidence: no reconciled record of the effect. */
  | "UNRECONCILED";

export interface AmbiguousOutcome {
  tool: string;
  index: number;
  class: AmbiguityClass;
  /** Index of the retry (a later SUCCESS or PENDING call of the same tool), or null when there was none. */
  retryIndex: number | null;
}

/**
 * Every consequential tool result that was UNKNOWN_OUTCOME, classified from backend-recorded evidence: ambiguous
 * outcomes are reconciled before retry or success (FO-22-07, ACT-03). A retry is legitimate only when a
 * reconciliation of that ambiguous call found NO effect (NOT_FOUND) and completed before the retry was made; the
 * scorer does not take the action service's word for it. Returns null when the tool calls or the authoritative
 * committed actions were not collected.
 */
export function ambiguousOutcomes(e: Pick<CallEvidence, "toolCalls" | "committedActions" | "committedStateSource" | "reconciliations">): AmbiguousOutcome[] | null {
  if (e.toolCalls === null) return null;
  const calls = e.toolCalls;
  const ambiguous = calls.map((c, index) => ({ c, index })).filter(({ c }) => isConsequentialToolName(c.name) && !c.name.startsWith("prepare_") && c.status === "UNKNOWN_OUTCOME");
  if (ambiguous.length === 0) return [];
  if (e.committedStateSource !== "authoritative_backend" || e.committedActions === null) return null;
  const reconciled = e.committedActions.some((a) => a.reconciled && a.effectCount >= 1);
  const recs = e.reconciliations ?? null;
  return ambiguous.map(({ c, index }) => {
    const later = calls.findIndex((x, j) => j > index && x.name === c.name && (x.status === "SUCCESS" || x.status === "PENDING"));
    const retryIndex = later >= 0 ? later : null;
    if (retryIndex === null) return { tool: c.name, index, retryIndex, class: reconciled ? "RECONCILED_COMMITTED" : "UNRECONCILED" };
    if (recs === null) return { tool: c.name, index, retryIndex, class: "RETRY_RECONCILIATION_NOT_COLLECTED" };
    const notFoundFirst = recs.some((r) => r.toolCallIndex === index && r.outcome === "NOT_FOUND" && r.completedBeforeToolCallIndex <= retryIndex && r.completedBeforeToolCallIndex > index);
    return { tool: c.name, index, retryIndex, class: notFoundFirst ? "RETRIED_AFTER_NOT_FOUND" : "RETRIED_WITHOUT_RECONCILIATION" };
  });
}
