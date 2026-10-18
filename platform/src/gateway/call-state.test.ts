/**
 * Per-call gateway state used by TC-11 / TC-12 (opaque ids only, bounded, per process).
 */
import { describe, expect, it } from "vitest";
import { FakeClock } from "../shared/clock.js";
import { CallOutcomeTracker, HandoffIndex } from "./call-state.js";

const CALL = "cal_synthCallStateTest0001";

describe("CallOutcomeTracker", () => {
  it("[ACT-04] only a successful informational read sets informationProvided; only a policy decision denial sets policyDeclined", () => {
    const t = new CallOutcomeTracker();
    t.observe(CALL, "PREPARE_MUTATION", "SUCCESS", false);
    t.observe(CALL, "PROTECTED_READ", "POLICY_DENIED", false); // e.g. no session: not a policy decision
    expect(t.flags(CALL)).toEqual({ informationProvided: false, policyDeclined: false });
    t.observe(CALL, "PROTECTED_READ", "POLICY_DENIED", true);
    t.observe(CALL, "PUBLIC_READ", "SUCCESS", false);
    expect(t.flags(CALL)).toEqual({ informationProvided: true, policyDeclined: true });
    expect(t.take(CALL)).toEqual({ informationProvided: true, policyDeclined: true });
    expect(t.flags(CALL)).toEqual({ informationProvided: false, policyDeclined: false });
  });

  it("[SPEC-12.capacity] the tracker is bounded (oldest calls evicted)", () => {
    const t = new CallOutcomeTracker(2);
    for (const n of [1, 2, 3]) t.observe(`cal_synthCallStateBound000${n}`, "PUBLIC_READ", "SUCCESS", false);
    expect(t.flags("cal_synthCallStateBound0001").informationProvided).toBe(false);
    expect(t.flags("cal_synthCallStateBound0003").informationProvided).toBe(true);
  });
});

describe("HandoffIndex", () => {
  it("[SAFE-03] a STANDARD handoff never displaces a SAFETY handoff; the support reference is kept for the same handoff", () => {
    const idx = new HandoffIndex(new FakeClock());
    idx.record(CALL, { handoffId: "hnd_synthSafetyHandoff0001", transferId: "xfr_synthSafetyTransfer001", destinationId: "dst_safety_priority" }, "SAFETY");
    idx.record(CALL, { handoffId: "hnd_synthStdHandoff000001", transferId: null, destinationId: "dst_support_general", supportReference: "SR-ABCD-EFGH" }, "STANDARD");
    expect(idx.latest(CALL)).toMatchObject({ handoffId: "hnd_synthSafetyHandoff0001", priority: "SAFETY", supportReference: null });
    const other = "cal_synthCallStateTest0002";
    idx.record(other, { handoffId: "hnd_synthStdHandoff000002", transferId: "xfr_synthStdTransfer00002", destinationId: "dst_support_general", supportReference: "SR-ABCD-EFGH" }, "STANDARD");
    idx.record(other, { handoffId: "hnd_synthStdHandoff000002", transferId: "xfr_synthStdTransfer00002", destinationId: "dst_support_general" }, "STANDARD");
    expect(idx.latest(other)?.supportReference).toBe("SR-ABCD-EFGH");
  });
});
