import { describe, expect, it } from "vitest";
import type { ConsentState } from "../protocol/index.js";
import { DISCLOSURE_TEMPLATE_IDS, assertTruthfulDisclosure, evaluateProcessing, evaluateRecording, gateProcessors, selectDisclosure } from "./consent.js";
import type { ActiveProcessor, JurisdictionConsentRule } from "./consent.js";

const consent = (recording: ConsentState["recording"], automatedProcessing: ConsentState["automatedProcessing"]): ConsentState => ({
  recording,
  automatedProcessing,
  disclosureTemplateVersion: "disclosure-test.1",
  capturedAt: "2026-10-17T15:00:00.000Z",
  capturedBy: "studio_flow",
});

/** TEST-ONLY synthetic rule: not legal advice, not an approved jurisdiction rule. */
const RULE: JurisdictionConsentRule = {
  jurisdiction: "US",
  recordingConsentRequired: "REQUIRED",
  processingConsentRequired: "REQUIRED",
  recordingDeclinedAlternative: "CONTINUE_WITHOUT_RECORDING",
  approvalId: "apr_testOnlyConsentRule",
};

const P = {
  recorder: { processorId: "call-recorder", kind: "CALL_RECORDING", approved: true },
  asr: { processorId: "live-asr", kind: "LIVE_TRANSCRIPTION", approved: true },
  model: { processorId: "agent-model", kind: "MODEL_PROCESSING", approved: true },
  tts: { processorId: "agent-tts", kind: "SPEECH_SYNTHESIS", approved: true },
  retention: { processorId: "transcript-store", kind: "TRANSCRIPT_RETENTION", approved: true },
  unapprovedQa: { processorId: "qa-recorder", kind: "QA_RECORDING", approved: false },
} satisfies Record<string, ActiveProcessor>;
const ALL = Object.values(P);

describe("consent gate", () => {
  it("[DATA-03] UNKNOWN is never consent and NOT_REQUIRED needs an approved rule", () => {
    expect(evaluateRecording(consent("UNKNOWN", "GRANTED"), RULE)).toEqual({ allowed: false, reasonCode: "RECORDING_CONSENT_UNKNOWN" });
    expect(evaluateRecording(consent("NOT_REQUIRED", "GRANTED"), { ...RULE, recordingConsentRequired: "NOT_REQUIRED", approvalId: null }).allowed).toBe(false);
    expect(evaluateRecording(consent("NOT_REQUIRED", "GRANTED"), { ...RULE, recordingConsentRequired: "NOT_REQUIRED" }).allowed).toBe(true);
    expect(evaluateRecording(consent("NOT_REQUIRED", "GRANTED"), null).allowed).toBe(false);
    expect(evaluateProcessing(consent("GRANTED", "DECLINED"), RULE)).toEqual({ allowed: false, reasonCode: "PROCESSING_CONSENT_DECLINED" });
  });

  it("[DATA-03] processors follow consent: declined recording stops recorders and transcript retention, never unapproved processors", () => {
    const gate = gateProcessors(consent("DECLINED", "GRANTED"), RULE, ALL);
    expect(gate.allowed.map((p) => p.processorId).sort()).toEqual(["agent-model", "agent-tts", "live-asr"]);
    expect(gate.blocked).toEqual(
      expect.arrayContaining([
        { processorId: "call-recorder", kind: "CALL_RECORDING", reasonCode: "RECORDING_CONSENT_DECLINED" },
        { processorId: "transcript-store", kind: "TRANSCRIPT_RETENTION", reasonCode: "RECORDING_CONSENT_DECLINED" },
        { processorId: "qa-recorder", kind: "QA_RECORDING", reasonCode: "PROCESSOR_NOT_APPROVED" },
      ]),
    );
    const granted = gateProcessors(consent("GRANTED", "GRANTED"), RULE, ALL);
    expect(granted.blocked.map((b) => b.processorId)).toEqual(["qa-recorder"]);
  });

  it("[DATA-03] declined recording with processing still active never selects an 'unrecorded' disclosure", () => {
    const sel = selectDisclosure({ consent: consent("DECLINED", "GRANTED"), rule: RULE, activeProcessors: ALL });
    expect(sel.templateId).toBe(DISCLOSURE_TEMPLATE_IDS.PROCESSED_NOT_RECORDED);
    expect(sel.templateId).not.toBe(DISCLOSURE_TEMPLATE_IDS.NOT_RECORDED_NOT_PROCESSED);
    expect(sel).toMatchObject({ route: "CONTINUE_WITHOUT_RECORDING", recordingActive: false, captureActive: true, requiresApprovedTemplate: true });
    expect(sel.mustStop.sort()).toEqual(["call-recorder", "qa-recorder", "transcript-store"]);
    expect(() => assertTruthfulDisclosure(DISCLOSURE_TEMPLATE_IDS.NOT_RECORDED_NOT_PROCESSED, [P.asr])).toThrow("DISCLOSURE_FALSE_UNRECORDED_CLAIM");
    expect(() => assertTruthfulDisclosure(DISCLOSURE_TEMPLATE_IDS.PROCESSED_NOT_RECORDED, [P.recorder])).toThrow("DISCLOSURE_FALSE_UNRECORDED_CLAIM");
    expect(() => assertTruthfulDisclosure(DISCLOSURE_TEMPLATE_IDS.RECORDED_ONLY, [P.asr])).toThrow("DISCLOSURE_CLAIMS_RECORDING_NOT_ACTIVE");
  });

  it("[DATA-03] declined recording routes to the approved alternative, or to a person when none is approved", () => {
    const callback = selectDisclosure({ consent: consent("DECLINED", "GRANTED"), rule: { ...RULE, recordingDeclinedAlternative: "CALLBACK" }, activeProcessors: [P.asr] });
    expect(callback.route).toBe("APPROVED_ALTERNATIVE_CALLBACK");
    const none = selectDisclosure({ consent: consent("DECLINED", "GRANTED"), rule: { ...RULE, recordingDeclinedAlternative: null }, activeProcessors: [P.asr] });
    expect(none.route).toBe("APPROVED_ALTERNATIVE_HUMAN");
    expect(none.reasonCodes).toContain("RECORDING_DECLINED_NO_APPROVED_ALTERNATIVE_HUMAN_ROUTE");
    const unapprovedRule = selectDisclosure({ consent: consent("DECLINED", "GRANTED"), rule: { ...RULE, approvalId: null }, activeProcessors: [P.asr] });
    expect(unapprovedRule.route).toBe("APPROVED_ALTERNATIVE_HUMAN");
    expect(unapprovedRule.reasonCodes).toContain("CONSENT_RULE_UNAPPROVED_STRICTEST_APPLIED");
  });

  it("[DATA-03] consent not yet captured asks before recording; declined processing goes to a person", () => {
    const ask = selectDisclosure({ consent: consent("UNKNOWN", "UNKNOWN"), rule: RULE, activeProcessors: ALL });
    expect(ask).toMatchObject({ templateId: DISCLOSURE_TEMPLATE_IDS.CONSENT_REQUEST, route: "ASK_CONSENT", recordingActive: false, captureActive: false });
    const declined = selectDisclosure({ consent: consent("GRANTED", "DECLINED"), rule: RULE, activeProcessors: ALL });
    expect(declined).toMatchObject({ templateId: DISCLOSURE_TEMPLATE_IDS.PROCESSING_DECLINED_ALTERNATIVE, route: "APPROVED_ALTERNATIVE_HUMAN" });
    expect(declined.mustStop).toEqual(expect.arrayContaining(["live-asr", "agent-model"]));
  });

  it("[DATA-03] full consent with recorder and processing selects the combined disclosure; nothing capturing selects 'not recorded'", () => {
    expect(selectDisclosure({ consent: consent("GRANTED", "GRANTED"), rule: RULE, activeProcessors: ALL }).templateId).toBe(DISCLOSURE_TEMPLATE_IDS.RECORDED_AND_PROCESSED);
    expect(selectDisclosure({ consent: consent("GRANTED", "GRANTED"), rule: RULE, activeProcessors: [P.recorder, P.tts] }).templateId).toBe(DISCLOSURE_TEMPLATE_IDS.RECORDED_ONLY);
    expect(selectDisclosure({ consent: consent("DECLINED", "GRANTED"), rule: RULE, activeProcessors: [P.tts] }).templateId).toBe(DISCLOSURE_TEMPLATE_IDS.NOT_RECORDED_NOT_PROCESSED);
  });
});
