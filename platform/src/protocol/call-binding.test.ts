/**
 * WP-11 additions to the CallBinding contract file: the media-path claim, the processing directive and the
 * MediaProcessingState readout with its cross-field rules (DATA-03), and the request bodies the media routes accept.
 * SYNTHETIC values only.
 */
import { describe, expect, it } from "vitest";
import {
  MEDIA_PROCESSING_RULES,
  MediaBindRequest,
  MediaBindingClaim,
  MediaConsentDecisionRequest,
  MediaHumanRouteRequest,
  MediaProcessingState,
  MediaRecorderCheckRequest,
  MediaRecorderCheckResponse,
  MediaSafetyRouteRequest,
  ProcessingDirective,
  permittedTaps,
  processingPermitted,
} from "./call-binding.js";
import type { ProcessingConsent } from "./call-binding.js";

const T0 = "2026-10-21T12:00:00.000Z";
const consent = (value: ProcessingConsent["value"], o: Partial<ProcessingConsent> = {}): ProcessingConsent => ({ value, expiresAt: null, capturedAt: value === "UNKNOWN" ? null : T0, templateVersion: "disclosure-v1", ...o });
const off = { phase: "OFF" as const, active: false, ref: null, changedAt: T0 };

function state(over: Partial<MediaProcessingState> = {}): MediaProcessingState {
  return {
    schemaVersion: "media-processing-state.v1",
    tenantId: "tnt_synthTenantMedia0001",
    interactionId: "int_synthInteraction0001",
    sessionGeneration: 2,
    occurredAt: T0,
    bindingId: "cbd_synthBinding00000001",
    recording: off,
    transcription: off,
    analysis: off,
    consent: { consentVersion: 1, recording: consent("UNKNOWN"), transcriptionAiProcessing: consent("UNKNOWN") },
    disclosureTemplateId: null,
    mismatch: null,
    // The recorder a readout names is listed (RECORDER_REF_NOT_LISTED), unless a case overrides the list.
    recorderRefs: over.recording?.ref ? [over.recording.ref] : [],
    changedAt: T0,
    ...over,
  };
}

const codes = (r: { success: boolean; error?: { issues: { message: string }[] } }) => (r.success ? [] : (r.error?.issues ?? []).map((i) => i.message));

describe("processingPermitted [DATA-03]", () => {
  it("[DATA-03] positive: GRANTED and NOT_REQUIRED permit processing while unexpired", () => {
    const now = new Date(T0);
    expect(processingPermitted(consent("GRANTED"), now)).toBe(true);
    expect(processingPermitted(consent("NOT_REQUIRED"), now)).toBe(true);
  });

  it("[DATA-03] adversarial: UNKNOWN is not consent; DECLINED, EXPIRED and an elapsed expiry never permit", () => {
    const now = new Date(T0);
    expect(processingPermitted(consent("UNKNOWN"), now)).toBe(false);
    expect(processingPermitted(consent("DECLINED"), now)).toBe(false);
    expect(processingPermitted(consent("EXPIRED"), now)).toBe(false);
    expect(processingPermitted(consent("GRANTED", { expiresAt: T0 }), now)).toBe(false);
    expect(processingPermitted(consent("GRANTED", { expiresAt: "2026-10-21T12:00:01.000Z" }), now)).toBe(true);
  });
});

describe("MediaProcessingState readout rules [DATA-03]", () => {
  it("[DATA-03] positive: an idle call and a consented recording parse", () => {
    expect(MediaProcessingState.safeParse(state()).success).toBe(true);
    const recording = { phase: "ON" as const, active: true, ref: "EG_synthEgress0001", changedAt: T0 };
    const ok = MediaProcessingState.safeParse(state({ recording, consent: { consentVersion: 2, recording: consent("GRANTED"), transcriptionAiProcessing: consent("GRANTED") } }));
    expect(codes(ok)).toEqual([]);
  });

  it(`[DATA-03] adversarial: ${MEDIA_PROCESSING_RULES.activeFlag}: a STOPPING recorder reported inactive (a call reported unrecorded while a tap runs) is refused`, () => {
    const r = MediaProcessingState.safeParse(state({ recording: { phase: "STOPPING", active: false, ref: "EG_synthEgress0001", changedAt: T0 } }));
    expect(codes(r)).toContain(MEDIA_PROCESSING_RULES.activeFlag);
    const r2 = MediaProcessingState.safeParse(state({ transcription: { phase: "OFF", active: true, ref: null, changedAt: T0 } }));
    expect(codes(r2)).toContain(MEDIA_PROCESSING_RULES.activeFlag);
  });

  it(`[DATA-03] adversarial: ${MEDIA_PROCESSING_RULES.recorderRef}: a recorder ON without its egress reference is refused`, () => {
    const r = MediaProcessingState.safeParse(state({ recording: { phase: "ON", active: true, ref: null, changedAt: T0 }, consent: { consentVersion: 2, recording: consent("GRANTED"), transcriptionAiProcessing: consent("GRANTED") } }));
    expect(codes(r)).toContain(MEDIA_PROCESSING_RULES.recorderRef);
  });

  it(`[DATA-03] adversarial: ${MEDIA_PROCESSING_RULES.recorderListed}: a running recorder the readout names but does not list (the list the gateway keeps for recovery) is refused`, () => {
    const granted = { consentVersion: 2, recording: consent("GRANTED"), transcriptionAiProcessing: consent("GRANTED") };
    const on = { phase: "ON" as const, active: true, ref: "EG_synthEgress0001", changedAt: T0 };
    expect(codes(MediaProcessingState.safeParse(state({ recording: on, consent: granted, recorderRefs: [] })))).toContain(MEDIA_PROCESSING_RULES.recorderListed);
    expect(codes(MediaProcessingState.safeParse(state({ recording: { ...on, phase: "STOPPING" }, consent: granted, recorderRefs: ["EG_synthEgress0002"] })))).toContain(MEDIA_PROCESSING_RULES.recorderListed);
    expect(codes(MediaProcessingState.safeParse(state({ recording: on, consent: granted, recorderRefs: ["EG_synthEgress0001", "EG_synthEgress0002"] })))).toEqual([]);
    // A stopped recorder keeps its last reference for the record; it is no longer listed as running.
    expect(codes(MediaProcessingState.safeParse(state({ recording: { ...on, phase: "OFF", active: false }, recorderRefs: [] })))).toEqual([]);
    expect(MediaProcessingState.safeParse(state({ recorderRefs: Array.from({ length: 9 }, (_, i) => `EG_synthEgress000${i}`) })).success).toBe(false);
  });

  it(`[DATA-03] adversarial: ${MEDIA_PROCESSING_RULES.unflagged}: a recorder or tap running under UNKNOWN or DECLINED consent must carry a mismatch`, () => {
    const recording = { phase: "ON" as const, active: true, ref: "EG_synthEgress0001", changedAt: T0 };
    expect(codes(MediaProcessingState.safeParse(state({ recording })))).toContain(MEDIA_PROCESSING_RULES.unflagged);
    const tap = { phase: "ON" as const, active: true, ref: null, changedAt: T0 };
    expect(codes(MediaProcessingState.safeParse(state({ analysis: tap, consent: { consentVersion: 3, recording: consent("GRANTED"), transcriptionAiProcessing: consent("DECLINED") } })))).toContain(
      MEDIA_PROCESSING_RULES.unflagged,
    );
    // The transcript and analysis taps are recording-dependent: AI processing alone does not permit them.
    expect(codes(MediaProcessingState.safeParse(state({ transcription: tap, consent: { consentVersion: 4, recording: consent("DECLINED"), transcriptionAiProcessing: consent("GRANTED") } })))).toContain(
      MEDIA_PROCESSING_RULES.unflagged,
    );
    expect(permittedTaps({ recording: consent("GRANTED"), transcriptionAiProcessing: consent("UNKNOWN") }, new Date(T0))).toEqual({ recording: true, transcription: false, analysis: false });
    expect(permittedTaps({ recording: consent("NOT_REQUIRED"), transcriptionAiProcessing: consent("GRANTED") }, new Date(T0))).toEqual({ recording: true, transcription: true, analysis: true });
    // A recorder draining after a decline (STOPPING) is still running, and is not itself a contradiction.
    expect(codes(MediaProcessingState.safeParse(state({ recording: { phase: "STOPPING", active: true, ref: "EG_synthEgress0001", changedAt: T0 } })))).toEqual([]);
    // Flagged, it parses: the readout is honest about the contradiction.
    expect(MediaProcessingState.safeParse(state({ recording, mismatch: "RECORDING_WITHOUT_CONSENT" })).success).toBe(true);
  });
});

describe("media path bodies [AUTH-03]", () => {
  const claim = { bindingId: "cbd_synthBinding00000001", tenantId: "tnt_synthTenantMedia0001", interactionId: "int_synthInteraction0001", sessionGeneration: 3, fencingToken: 2 };

  it("[AUTH-03] adversarial: a claim or bind request carrying any extra trusted field is refused (strict)", () => {
    expect(MediaBindingClaim.safeParse(claim).success).toBe(true);
    expect(MediaBindingClaim.safeParse({ ...claim, assurance: "A3" }).success).toBe(false);
    const bind = { roomName: "call-synth-room-01", jobRef: "AJ_synthJob0001", workerInstanceRef: "media-worker-a1", agentIdentity: "agent-AJ_synthJob0001", adapter: "controlled_cascade_runtime" };
    expect(MediaBindRequest.safeParse(bind).success).toBe(true);
    expect(MediaBindRequest.safeParse({ ...bind, sessionGeneration: 9 }).success).toBe(false);
    expect(MediaBindRequest.safeParse({ ...bind, interactionRef: "sip-call-synthetic" }).success).toBe(false);
    expect(MediaBindRequest.safeParse({ ...bind, adapter: "talkdesk_ai_agent_mcp" }).success).toBe(false);
  });

  it("[DATA-03] adversarial: the runtime may only lower consent (DECLINED or REVOKED), never grant it", () => {
    const base = { claim, dimension: "recording", decision: "DECLINED", capturedVia: "dtmf_menu", occurredAt: T0 };
    expect(MediaConsentDecisionRequest.safeParse(base).success).toBe(true);
    expect(MediaConsentDecisionRequest.safeParse({ ...base, decision: "GRANTED" }).success).toBe(false);
    expect(MediaConsentDecisionRequest.safeParse({ ...base, decision: "NOT_REQUIRED" }).success).toBe(false);
  });

  it("[SAFE-02][SAFE-05] the human and safety route bodies carry no binding, session or destination", () => {
    expect(MediaHumanRouteRequest.safeParse({ roomName: "call-synth-room-01", reason: "CALLER_REQUESTED_HUMAN", language: "en" }).success).toBe(true);
    // [SAFE-02] a SIP dispatch rule's room name carries the E.164 number: the human route must accept it.
    expect(MediaHumanRouteRequest.safeParse({ roomName: "vsp-call-_+15550199_Ab12Cd34", reason: "BINDING_UNAVAILABLE", language: "en" }).success).toBe(true);
    // [SAFE-02] any name the media plane can assign (a dispatch-rule prefix with a space or a slash, non-ASCII) is
    // accepted: a refused room name would leave the caller with no binding and no route to a person.
    for (const roomName of ["support line/probe 01", "room/../x", "sala-ñ-01", "r".repeat(256)]) expect(MediaHumanRouteRequest.safeParse({ roomName, reason: "BINDING_UNAVAILABLE", language: "en" }).success).toBe(true);
    for (const roomName of ["", "room\nX", "room\u0000x", "room\u0085x", "r".repeat(257)]) expect(MediaHumanRouteRequest.safeParse({ roomName, reason: "BINDING_UNAVAILABLE", language: "en" }).success).toBe(false);
    expect(MediaHumanRouteRequest.safeParse({ roomName: "call-synth-room-01", reason: "CALLER_REQUESTED_HUMAN", language: "en", destinationId: "dst_anything" }).success).toBe(false);
    const signal = { source: "FAIL_SAFE", ruleId: "media.runtime.fail_safe", strength: "UNRESOLVED", subject: "UNKNOWN", temporal: "UNKNOWN", negated: false };
    expect(MediaSafetyRouteRequest.safeParse({ roomName: "call-synth-room-01", signals: [signal], locale: "en-US" }).success).toBe(true);
    expect(MediaSafetyRouteRequest.safeParse({ roomName: "call-synth-room-01", signals: [], locale: "en-US" }).success).toBe(false);
  });

  it("[DATA-03][AUTH-03] the recorder check of a runtime without a binding names its job only: no claim, session or destination; the answer carries no binding", () => {
    const base = { roomName: "call-synth-room-01", jobRef: "AJ_synthJob0001", agentIdentity: "agent-AJ_synthJob0001", mismatch: null };
    expect(MediaRecorderCheckRequest.safeParse(base).success).toBe(true);
    expect(MediaRecorderCheckRequest.safeParse({ ...base, mismatch: "FOREIGN_RECORDER_ACTIVE" }).success).toBe(true);
    expect(MediaRecorderCheckRequest.safeParse({ ...base, mismatch: "SOMETHING_ELSE" }).success).toBe(false);
    expect(MediaRecorderCheckRequest.safeParse({ ...base, claim: { bindingId: "cbd_synthBinding000001" } }).success).toBe(false);
    const { mismatch: _omit, ...noMismatch } = base;
    expect(MediaRecorderCheckRequest.safeParse(noMismatch).success).toBe(false);
    expect(MediaRecorderCheckResponse.safeParse({ interactionId: null, directive: null, recorders: [] }).success).toBe(true);
    expect(MediaRecorderCheckResponse.safeParse({ interactionId: "int_synthInteraction0001", directive: null, recorders: ["EG_synthEgress0001"], claim: {} }).success).toBe(false);
    expect(MediaRecorderCheckResponse.safeParse({ interactionId: null, directive: null, recorders: Array.from({ length: 33 }, (_, i) => `EG_synthEgress${i}`) }).success).toBe(false);
  });

  it("[DATA-03] the directive pins its schema version and a positive consent version", () => {
    const d = { schemaVersion: "processing-directive.v1", consentVersion: 1, recording: consent("UNKNOWN"), transcriptionAiProcessing: consent("UNKNOWN"), disclosureTemplateId: null, recordingDeclinedRoute: "HUMAN", decidedAt: T0 };
    expect(ProcessingDirective.safeParse(d).success).toBe(true);
    expect(ProcessingDirective.safeParse({ ...d, consentVersion: 0 }).success).toBe(false);
    expect(ProcessingDirective.safeParse({ ...d, schemaVersion: "processing-directive.v2" }).success).toBe(false);
  });
});
