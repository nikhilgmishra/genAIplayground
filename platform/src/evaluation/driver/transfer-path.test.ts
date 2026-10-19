/**
 * The transfer path under redelivered vendor webhooks (ACT-02, SAFE-04): driver/evidence.ts derives, from
 * authoritative records, a repeated / reversed / skipped attempt state, a second dial for one attempt, an
 * attempt started without a failure of the one before it, and a handoff record beyond its business creation
 * key, and scorer.ts `no_duplicate_effect` fails on each. Pure functions and the scorer over the ideal evidence
 * fixture; the full-stack mutation runs are in local-driver.test.ts.
 */
import { describe, expect, it } from "vitest";
import { assembleSummary } from "../../business/support/summaries.js";
import { TransferReason } from "../../protocol/index.js";
import type { ScenarioDefinition } from "../../protocol/index.js";
import { loadCorpus } from "../corpus.js";
import { idealEvidenceFixture } from "../evidence.fixture.js";
import type { CallEvidence } from "../runner.js";
import { TRANSFER_PATH_DUPLICATE_TOKENS, scoreScenario } from "../scorer.js";
import { attemptHistoryInOrder, handoffReason, transferPathFindings } from "./evidence.js";
import type { TransferPathInput } from "./evidence.js";

const CONNECTED = ["REQUESTED", "QUEUED", "RECEIVER_ACCEPTED", "BRIDGED", "CALLER_CONFIRMED_CONNECTED"];
/** The attempt outcomes after which the transfer coordinator fails over (protocol states; written out here, not imported). */
const FAILOVER = new Set(["TIMED_OUT", "RECEIVER_UNAVAILABLE", "BRIDGE_DROPPED", "FAILED"]);

describe("transfer path evidence (driver/evidence.ts)", () => {
  it("[SAFE-04] an attempt history moves forward one step at a time (QUEUED optional) and nothing follows its end", () => {
    for (const ok of [CONNECTED, [...CONNECTED, "COMPLETED"], ["REQUESTED", "RECEIVER_ACCEPTED", "BRIDGED"], ["REQUESTED", "QUEUED", "RECEIVER_UNAVAILABLE"], ["REQUESTED", "FAILED"], [...CONNECTED, "BRIDGE_DROPPED"], ["REQUESTED"]]) {
      expect(attemptHistoryInOrder(ok), ok.join(">")).toBe(true);
    }
    for (const bad of [
      ["REQUESTED", "QUEUED", "RECEIVER_ACCEPTED", "QUEUED"], // a redelivered QUEUED applied again
      ["REQUESTED", "QUEUED", "QUEUED"],
      ["REQUESTED", "QUEUED", "RECEIVER_ACCEPTED", "CALLER_CONFIRMED_CONNECTED"], // connected without the bridge
      ["REQUESTED", "QUEUED", "TIMED_OUT", "RECEIVER_ACCEPTED"], // progress after the attempt ended
      [...CONNECTED, "COMPLETED", "CALLER_CONFIRMED_CONNECTED"],
    ]) {
      expect(attemptHistoryInOrder(bad), bad.join(">")).toBe(false);
    }
  });

  // `failedAt` defaults to the start time for an attempt whose states end in a failover state.
  const journey = (attempts: { id: string; dst: string; at: string; states?: string[]; failedAt?: string | null }[], refs: Record<string, string>): TransferPathInput["journeys"][number] => ({
    handoffId: "hnd_synthLocalHandoff0001",
    vendorRefs: refs,
    attempts: attempts.map((a) => {
      const states = a.states ?? CONNECTED;
      return { transferId: a.id, destinationId: a.dst, startedAt: a.at, failedAt: a.failedAt !== undefined ? a.failedAt : FAILOVER.has(states.at(-1) ?? "") ? a.at : null, states };
    }),
  });
  const dial = (ref: string, dst: string, at: string, handoffId = "hnd_synthLocalHandoff0001") => ({ handoffId, transferRef: ref, destinationId: dst, at });

  it("[ACT-02] one dial per attempt across a fallback is clean; a second dial for an attempt or a dial no journey owns is a re-dial", () => {
    const fallback = journey(
      [
        { id: "xfr_a", dst: "dst_support_general", at: "2026-10-18T15:00:00.000Z", states: ["REQUESTED", "QUEUED", "RECEIVER_UNAVAILABLE"] },
        { id: "xfr_b", dst: "dst_outage_continuity", at: "2026-10-18T15:00:05.000Z" },
      ],
      { xfr_a: "tdx_a", xfr_b: "tdx_b" },
    );
    const clean = transferPathFindings({ journeys: [fallback], dials: [dial("tdx_a", "dst_support_general", "2026-10-18T15:00:00.000Z"), dial("tdx_b", "dst_outage_continuity", "2026-10-18T15:00:05.000Z")], handoffRecords: [{ kind: "STANDARD", reason: "CALLER_REQUESTED_HUMAN" }] });
    expect(clean.journeys[0]).toMatchObject({ dialsPerAttempt: [1, 1], unattributedDials: 0, attemptsWithoutFailover: 0, historyInOrder: [true, true] });
    expect(clean.tokens).toEqual([]);

    const single = journey([{ id: "xfr_a", dst: "dst_support_general", at: "2026-10-18T15:00:00.000Z" }], { xfr_a: "tdx_a" });
    const redial = transferPathFindings({ journeys: [single], dials: [dial("tdx_a", "dst_support_general", "2026-10-18T15:00:00.000Z"), dial("tdx_x", "dst_support_general", "2026-10-18T15:00:03.000Z")], handoffRecords: [] });
    expect(redial.journeys[0]?.dialsPerAttempt).toEqual([2]);
    expect(redial.tokens).toEqual(["transfer:attempt_redialled"]);

    const orphan = transferPathFindings({ journeys: [single], dials: [dial("tdx_a", "dst_support_general", "2026-10-18T15:00:00.000Z"), dial("tdx_y", "dst_support_general", "2026-10-18T15:00:01.000Z", "hnd_synthLocalHandoff0099")], handoffRecords: [] });
    expect(orphan.orphanDials).toBe(1);
    expect(orphan.tokens).toEqual(["transfer:attempt_redialled"]);
  });

  it("[ACT-02] [SAFE-04] each attempt after the first follows a failure of the one before it; a re-dial recorded as a new attempt is reported", () => {
    const T = (s: number) => `2026-10-18T15:00:${String(s).padStart(2, "0")}.000Z`;
    const dialsFor = (j: TransferPathInput["journeys"][number]) => j.attempts.map((a) => dial(j.vendorRefs[a.transferId] as string, a.destinationId, a.startedAt as string));
    const findings = (attempts: Parameters<typeof journey>[0]) => {
      const j = journey(attempts, Object.fromEntries(attempts.map((a) => [a.id, `tdx_${a.id}`])));
      return transferPathFindings({ journeys: [j], dials: dialsFor(j), handoffRecords: [] });
    };
    // Failover after each failure state, including a dial failure and a dropped bridge (SAFE-HANDOFF-01).
    for (const failure of ["TIMED_OUT", "RECEIVER_UNAVAILABLE", "BRIDGE_DROPPED", "FAILED"]) {
      const states = failure === "BRIDGE_DROPPED" ? [...CONNECTED, failure] : failure === "FAILED" ? ["REQUESTED", failure] : ["REQUESTED", "QUEUED", failure];
      const f = findings([
        { id: "xfr_a", dst: "dst_support_general", at: T(0), states, failedAt: T(4) },
        { id: "xfr_b", dst: "dst_outage_continuity", at: T(5) },
      ]);
      expect(f.journeys[0]?.attemptsWithoutFailover, failure).toBe(0);
      expect(f.tokens, failure).toEqual([]);
    }
    const redialled = [
      // A redelivered QUEUED restarts the route: a new attempt to the same destination while the first is accepted.
      [
        { id: "xfr_a", dst: "dst_support_general", at: T(0), states: ["REQUESTED", "QUEUED", "RECEIVER_ACCEPTED"] },
        { id: "xfr_b", dst: "dst_support_general", at: T(3) },
      ],
      // A redelivered RECEIVER_UNAVAILABLE fails over twice: the continuity attempt is replaced before it ended.
      [
        { id: "xfr_a", dst: "dst_support_general", at: T(0), states: ["REQUESTED", "QUEUED", "RECEIVER_UNAVAILABLE"], failedAt: T(2) },
        { id: "xfr_b", dst: "dst_outage_continuity", at: T(2), states: ["REQUESTED"] },
        { id: "xfr_c", dst: "dst_outage_continuity", at: T(2) },
      ],
      // The failure of the previous attempt was recorded only after the next one started.
      [
        { id: "xfr_a", dst: "dst_support_general", at: T(0), states: ["REQUESTED", "QUEUED", "TIMED_OUT"], failedAt: T(9) },
        { id: "xfr_b", dst: "dst_outage_continuity", at: T(5) },
      ],
      // Nothing follows a completed or caller-disconnected attempt.
      [
        { id: "xfr_a", dst: "dst_support_general", at: T(0), states: [...CONNECTED, "COMPLETED"] },
        { id: "xfr_b", dst: "dst_support_general", at: T(5) },
      ],
      [
        { id: "xfr_a", dst: "dst_support_general", at: T(0), states: ["REQUESTED", "QUEUED", "CALLER_DISCONNECTED"] },
        { id: "xfr_b", dst: "dst_outage_continuity", at: T(5) },
      ],
    ];
    for (const attempts of redialled) {
      const f = findings(attempts);
      expect(f.journeys[0]?.dialsPerAttempt.every((n) => n === 1), attempts.map((a) => a.id).join(",")).toBe(true);
      expect(f.journeys[0]?.attemptsWithoutFailover, attempts.map((a) => a.id).join(",")).toBe(1);
      expect(f.tokens).toEqual(["transfer:attempt_redialled"]);
    }
  });

  it("[ACT-02] [SAFE-04] handoff records follow the business creation keys: one SAFETY record per call, one STANDARD record per transfer reason", () => {
    const j = journey([{ id: "xfr_a", dst: "dst_support_general", at: "2026-10-18T15:00:00.000Z" }], { xfr_a: "tdx_a" });
    const dials = [dial("tdx_a", "dst_support_general", "2026-10-18T15:00:00.000Z")];
    const records = (handoffRecords: TransferPathInput["handoffRecords"]) => transferPathFindings({ journeys: [j], dials, handoffRecords });
    const distinct = records([
      { kind: "STANDARD", reason: "CONSENT_DECLINED_ALTERNATIVE" },
      { kind: "SAFETY", reason: null },
      { kind: "STANDARD", reason: "VERIFICATION_RECOVERY" },
    ]);
    expect(distinct.handoffRecords).toEqual({ standard: 2, safety: 1, duplicated: 0 });
    expect(distinct.tokens).toEqual([]);
    for (const [label, doubled] of [
      // Two safety records in one call, whatever their summaries say (e.g. different signal sources).
      ["safety", [{ kind: "SAFETY", reason: null }, { kind: "SAFETY", reason: null }]],
      ["standard, same reason", [{ kind: "STANDARD", reason: "CALLER_REQUESTED_HUMAN" }, { kind: "STANDARD", reason: "CALLER_REQUESTED_HUMAN" }]],
      // A reason that cannot be read is never assumed distinct.
      ["standard, unreadable reason", [{ kind: "STANDARD", reason: null }, { kind: "STANDARD", reason: null }]],
    ] as const) {
      const f = records(doubled);
      expect(f.handoffRecords.duplicated, label).toBe(1);
      expect(f.tokens, label).toEqual(["transfer:handoff_record_duplicated"]);
    }
  });

  it("[ACT-02] the transfer reason of a handoff record is read from its template-assembled summary (any issue category); other summaries have none", () => {
    for (const reason of TransferReason.options) {
      for (const issueCategory of ["general_question", "safety_concern"]) {
        expect(handoffReason(assembleSummary("summary.human_handoff", { reason, issueCategory })), `${reason}/${issueCategory}`).toBe(reason);
      }
    }
    expect(handoffReason(assembleSummary("summary.safety_route", { signalSource: "SCREENING" }))).toBeNull();
    expect(handoffReason("Caller asked for a person.")).toBeNull();
  });

  it("[SAFE-04] a reversed attempt history is reported", () => {
    const j = journey([{ id: "xfr_a", dst: "dst_safety_priority", at: "2026-10-18T15:00:00.000Z", states: ["REQUESTED", "QUEUED", "RECEIVER_ACCEPTED", "QUEUED"] }], { xfr_a: "tdx_a" });
    const f = transferPathFindings({ journeys: [j], dials: [dial("tdx_a", "dst_safety_priority", "2026-10-18T15:00:00.000Z")], handoffRecords: [] });
    expect(f.journeys[0]?.historyInOrder).toEqual([false]);
    expect(f.tokens).toEqual(["transfer:attempt_history_regressed"]);
  });
});

describe("scorer no_duplicate_effect on the transfer path", () => {
  const corpus = loadCorpus();
  const s = corpus.byId.get("scn_risk_duplicate_webhook_019") as ScenarioDefinition;
  const score = (patch: (e: CallEvidence) => void, scenario: ScenarioDefinition = s) => {
    const e = idealEvidenceFixture(scenario);
    patch(e);
    const r = scoreScenario(scenario, e, { runId: "run_transferpath0001", runAt: "2026-10-18T15:00:00.000Z", repetition: 1, environment: "local", executionMode: "local_fixture", missingFaultPlans: [], injectionFailures: [], driverError: null, faultPlans: corpus.faultPlans });
    return { verdict: r.verdict, check: r.assertions.find((a) => a.assertionId.startsWith("fault.") && a.assertionId.endsWith(".no_duplicate_effect")) };
  };

  it("[ACT-02] [SPEC-16.fault-injection] a transfer-only DUPLICATE_WEBHOOK draft: PASS only without a transfer-path duplicate; each duplicate token is a hard FAIL; uncollected observations are INCONCLUSIVE", () => {
    expect(s.initialState.faults).toEqual(["DUPLICATE_WEBHOOK"]);
    expect(score(() => undefined)).toMatchObject({ verdict: "PASS", check: { verdict: "PASS", hardGate: true } });
    for (const token of TRANSFER_PATH_DUPLICATE_TOKENS) {
      const r = score((e) => void (e.observedActions = [token]));
      expect(r.verdict, token).toBe("FAIL");
      expect(r.check, token).toMatchObject({ verdict: "FAIL", hardGate: true, detail: expect.stringContaining(token) });
    }
    expect(score((e) => void (e.observedActions = null)).check?.verdict).toBe("INCONCLUSIVE");
  });

  it("[ACT-02] a duplicate shown by one source FAILs even when the other was not collected; only a clean result needs both", () => {
    // A committed action with two external effects, observed actions not collected (fault-level, not only the transaction gate).
    for (const id of ["scn_risk_duplicate_webhook_001", "scn_risk_crash_after_commit_001"]) {
      const withCommit = corpus.byId.get(id) as ScenarioDefinition;
      expect(idealEvidenceFixture(withCommit).committedActions?.length, id).toBeGreaterThan(0);
      const r = score((e) => {
        e.committedActions = (e.committedActions ?? []).map((a) => ({ ...a, effectCount: 2 }));
        e.observedActions = null;
      }, withCommit);
      expect(r.check, id).toMatchObject({ verdict: "FAIL", hardGate: true, detail: "duplicate external effect observed" });
      expect(r.verdict, id).toBe("FAIL");
    }
    // A transfer-path duplicate with committed actions not collected.
    const transferOnly = score((e) => {
      e.committedActions = null;
      e.observedActions = ["transfer:attempt_redialled"];
    });
    expect(transferOnly.check).toMatchObject({ verdict: "FAIL", detail: expect.stringContaining("transfer:attempt_redialled") });
    // No duplicate shown and either source missing: INCONCLUSIVE, never PASS.
    expect(score((e) => void (e.committedActions = null)).check?.verdict).toBe("INCONCLUSIVE");
  });
});
