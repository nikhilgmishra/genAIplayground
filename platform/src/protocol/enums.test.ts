/**
 * Enum and field snapshot (WP-02 acceptance): pins the exact values later packages consume without
 * editing the protocol files, and the legacy-to-follow-on mappings (no value dropped). SYNTHETIC
 * values only.
 */
import { describe, expect, it } from "vitest";
import { IntegrationChannel, IntegrationIdentity } from "./auth.js";
import {
  ConsentDimension,
  ConsentDimensionState,
  ConsentState,
  ConsentValue,
  ConsentValueV2,
  EnvironmentStatus,
  IssueOutcome,
  ISSUE_OUTCOME_TO_LEGACY_OUTCOME,
  LEGACY_OUTCOME_TO_ISSUE_OUTCOME,
  Outcome,
  QualificationResult,
  SessionConsentValue,
  SoftwareStatus,
} from "./common.js";
import { AuditManifest } from "./audit.js";
import { CorpusSplit, EvaluationResult, ExecutionMode, ScenarioChannel } from "./evaluation.js";
import { CARRIER_EVENT_TRANSFER_STATE } from "./media.js";
import { PolicyInput } from "./policy.js";
import { LEGACY_RELEASE_STATUS_AXES, ReleaseStatus, statusAxesFromLegacy } from "./release.js";
import { TransferState, TransferStateV2 } from "./support.js";
import { ToolResult } from "./tools.js";
import { WorkflowStateName, WorkflowStateNameV2 } from "./workflow.js";

describe("follow-on enum and field values (WP-02 snapshot)", () => {
  it("[WP-02] per-issue Outcome values, with reopened and partiallyResolved flags", () => {
    expect(IssueOutcome.options).toEqual([
      "RESOLVED_WITH_EVIDENCE",
      "INFORMATION_PROVIDED",
      "REQUEST_ACCEPTED",
      "WAITING_FOR_SYSTEM",
      "WAITING_FOR_HUMAN",
      "WAITING_FOR_CALLER",
      "TRANSFERRED_WITH_ACCEPTANCE",
      "DECLINED_BY_POLICY",
      "CALLER_DISCONNECTED",
      "FAILED",
      "OUTCOME_UNKNOWN",
    ]);
  });

  it("[WP-02][ACT-04] every legacy Outcome maps to a per-issue outcome (RESOLVED and TRANSFERRED mapped, not dropped) and back", () => {
    expect(Object.keys(LEGACY_OUTCOME_TO_ISSUE_OUTCOME).sort()).toEqual([...Outcome.options].sort());
    expect(LEGACY_OUTCOME_TO_ISSUE_OUTCOME.RESOLVED).toBe("RESOLVED_WITH_EVIDENCE");
    expect(LEGACY_OUTCOME_TO_ISSUE_OUTCOME.TRANSFERRED).toBe("TRANSFERRED_WITH_ACCEPTANCE");
    for (const o of Outcome.options) expect(ISSUE_OUTCOME_TO_LEGACY_OUTCOME[LEGACY_OUTCOME_TO_ISSUE_OUTCOME[o]]).toBe(o);
    expect(Object.keys(ISSUE_OUTCOME_TO_LEGACY_OUTCOME).sort()).toEqual([...IssueOutcome.options].sort());
    for (const waiting of ["WAITING_FOR_SYSTEM", "WAITING_FOR_HUMAN", "WAITING_FOR_CALLER"] as const) expect(ISSUE_OUTCOME_TO_LEGACY_OUTCOME[waiting]).not.toBe("RESOLVED");
  });

  it("[WP-02] the consent value set with EXPIRED is ConsentValueV2 (consent dimensions use it); ConsentValue and the session capture keep their four wire values for the existing consumers", () => {
    expect(ConsentValueV2.options).toEqual(["GRANTED", "DECLINED", "UNKNOWN", "EXPIRED", "NOT_REQUIRED"]);
    expect(ConsentDimensionState.shape.value.options).toEqual(ConsentValueV2.options);
    expect(ConsentDimension.options).toEqual(["recording", "transcriptionAiProcessing", "supportPurpose", "disclosureAuthority", "notificationSubscription", "marketing"]);
    // Widening ConsentValue in place made an EXPIRED registry value pass business/recheck.ts's consent
    // parse and fail later as an unaudited RECHECK_POLICY_INPUT_INVALID; it stays the original four.
    expect(ConsentValue.options).toEqual(["GRANTED", "DECLINED", "UNKNOWN", "NOT_REQUIRED"]);
    expect(SessionConsentValue.options).toEqual(["GRANTED", "DECLINED", "UNKNOWN", "NOT_REQUIRED"]);
    expect(ConsentState.shape.recording.options).toEqual(ConsentValue.options);
    expect(PolicyInput.shape.auth.shape.consentAutomatedProcessing.options).toEqual(ConsentValue.options);
  });

  it("[WP-02][SAFE-04] TransferStateV2 adds RECEIVER_DECLINED to every original TransferState, and carrier transfer events map only onto it", () => {
    expect(TransferStateV2.options).toEqual([...TransferState.options, "RECEIVER_DECLINED"]);
    expect(TransferState.options).toHaveLength(11);
    for (const s of Object.values(CARRIER_EVENT_TRANSFER_STATE)) expect(TransferStateV2.options).toContain(s);
    expect(CARRIER_EVENT_TRANSFER_STATE.TRANSFER_RECEIVER_DECLINED).toBe("RECEIVER_DECLINED");
  });

  it("[WP-02] WorkflowStateNameV2 adds INVESTIGATING, VERIFYING_EFFECT and EXPIRED", () => {
    expect(WorkflowStateNameV2.options).toEqual([...WorkflowStateName.options, "INVESTIGATING", "VERIFYING_EFFECT", "EXPIRED"]);
    expect(WorkflowStateNameV2.options).toEqual([
      "ACCEPTED",
      "VALIDATING",
      "WAITING_FOR_SYSTEM",
      "WAITING_FOR_HUMAN",
      "WAITING_FOR_CALLER",
      "READY_TO_COMMIT",
      "COMPLETED",
      "FAILED",
      "CANCELLED",
      "INVESTIGATING",
      "VERIFYING_EFFECT",
      "EXPIRED",
    ]);
  });

  it("[WP-02] the integration channel set adds conversation_runtime to the original channels", () => {
    expect(IntegrationChannel.options).toEqual(["mcp_tools", "telephony_control", "portal", "console", "worker", "webhook", "conversation_runtime"]);
    for (const c of IntegrationIdentity.shape.channel.options) expect(IntegrationChannel.options).toContain(c);
  });

  it("[WP-02][OPS-03] two-axis status types replace ReleaseStatus; every legacy value maps and is kept; a legacy label never becomes PASS", () => {
    expect(SoftwareStatus.options).toEqual(["MISSING", "IMPLEMENTED", "VERIFIED_LOCAL", "RELEASE_PACKAGE_VERIFIED"]);
    expect(EnvironmentStatus.options).toEqual(["NOT_CONFIGURED", "CONFIGURED", "VERIFIED_SANDBOX", "APPROVED_PILOT", "VERIFIED_PRODUCTION"]);
    expect(QualificationResult.options).toEqual(["NOT_RUN", "FAIL", "INCONCLUSIVE", "PASS"]);
    expect(Object.keys(LEGACY_RELEASE_STATUS_AXES).sort()).toEqual([...ReleaseStatus.options].sort());
    for (const s of ReleaseStatus.options) {
      const axes = statusAxesFromLegacy(s);
      expect(axes.legacyReleaseStatus).toBe(s);
      expect(axes.qualification).not.toBe("PASS");
    }
    // A legacy label is not evidence: no label yields a verified environment level (OPS-03).
    for (const s of ["VERIFIED_SANDBOX", "APPROVED_PILOT", "VERIFIED_PRODUCTION"] as const) {
      expect(statusAxesFromLegacy(s)).toEqual({ software: "IMPLEMENTED", environment: "CONFIGURED", qualification: "INCONCLUSIVE", evidenceRefs: [], legacyReleaseStatus: s });
    }
    expect(statusAxesFromLegacy("BLOCKED").environment).toBe("NOT_CONFIGURED");
    expect(statusAxesFromLegacy("IMPLEMENTED_OFFLINE").environment).toBe("NOT_CONFIGURED");
  });

  it("[FO-04-37] EvaluationResult gains seed, requested/reached fault, rerun command, judge labels and audio evidence; the standalone ExecutionMode enum includes local_emulator, model_text and audio, while EvaluationResult.executionMode still accepts only the original four (widening is handed over)", () => {
    const keys = Object.keys(EvaluationResult.shape);
    for (const k of ["schemaVersion", "seed", "requestedFault", "reachedFault", "rerunCommand", "judgeLabels", "audioEvidenceRefs"]) expect(keys).toContain(k);
    expect(ExecutionMode.options).toEqual(["local_fixture", "local_emulator", "model_text", "audio", "vendor_sandbox", "pstn_sandbox", "production_pilot"]);
    // Pinned so the hand-over stays visible: this assertion changes when WP-34 widens the field.
    expect(EvaluationResult.shape.executionMode.options).toEqual(["local_fixture", "vendor_sandbox", "pstn_sandbox", "production_pilot"]);
    expect(CorpusSplit.options).toEqual(["development", "heldout_acceptance", "tuning", "regression"]);
    expect(ScenarioChannel.options).toEqual(["simulated_text", "simulated_voice", "pstn", "sip_audio", "webrtc_audio"]);
  });

  it("[WP-02] AuditManifest adds signature {algorithm, keyRef, value}, signedAt and signerRole; PolicyInput adds jurisdiction, processingPurpose and part2", () => {
    const m = Object.keys(AuditManifest.shape);
    for (const k of ["signature", "signedAt", "signerRole"]) expect(m).toContain(k);
    const sig = AuditManifest.shape.signature.unwrap();
    expect(Object.keys(sig.shape).sort()).toEqual(["algorithm", "keyRef", "value"]);
    const p = Object.keys(PolicyInput.shape);
    for (const k of ["jurisdiction", "processingPurpose", "part2"]) expect(p).toContain(k);
    expect(Object.keys(PolicyInput.shape.part2.unwrap().shape).sort()).toEqual(["consentRef", "programRecord"]);
  });

  it("[FO-04-16] ToolResult stays a discriminated union of exactly six branches (regression)", () => {
    expect(ToolResult.options.map((o) => o.shape.status.value)).toEqual(["SUCCESS", "RETRYABLE_FAILURE", "PERMANENT_FAILURE", "POLICY_DENIED", "PENDING", "UNKNOWN_OUTCOME"]);
  });
});
