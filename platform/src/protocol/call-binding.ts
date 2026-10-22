/**
 * CallBinding (follow-on prompt sections 4 and 5; ADR-0018 decision 1.4, TB-01).
 *
 * Binds one trusted carrier interaction to the platform interaction, the session generation and
 * the single conversation owner that holds the call-owner lease. It is produced only by the
 * trusted dispatch rule or carrier adapter (never from a model argument or a caller-supplied call
 * id) and is checked by the gateway on every tool call and speech request.
 *
 * Created by WP-02 in phase B; owned by WP-11 from phase C (store and issuance in
 * platform/src/calls/binding, worker side in media/src/binding).
 */
import { z } from "zod";
import { ConsentValueV2, ENVELOPE_FIELDS, IsoDateTime, OpaqueId, VersionLabel, envelope, isAfter, opaqueIdWithPrefix } from "./common.js";

export const CALL_BINDING_SCHEMA_VERSION = "call-binding.v1";

/** Carrier or media path that delivered the call. */
export const CarrierKind = z.enum(["talkdesk", "sip_reference", "livekit_webrtc", "local_softphone"]);
export type CarrierKind = z.infer<typeof CarrierKind>;

/** Conversation adapter that owns the call (exactly one at a time, ADR-0018 decision 1.4). */
export const ConversationAdapter = z.enum(["controlled_cascade_runtime", "native_duplex_runtime", "talkdesk_ai_agent_mcp", "human_only"]);
export type ConversationAdapter = z.infer<typeof ConversationAdapter>;

/** Phone-number shaped strings (E.164 or plain digit runs with separators) are never identifiers. */
const PHONE_SHAPED = /^\+?[0-9 ().-]{7,24}$/;
/** A party address (tel:, sip:, sips: URI) names a caller or callee, never an interaction. */
const PARTY_URI = /^(?:tel|sips?):/i;

/**
 * The carrier's own interaction identifier (vendor id, SIP Call-ID token). Opaque to the platform;
 * a value shaped like a phone number, or a tel:/sip:/sips: party URI (which would carry the ANI in
 * its user part), is refused so caller ANI can never become the binding key.
 */
export const CarrierInteractionRef = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/, "carrier interaction reference expected")
  .refine((v) => !PHONE_SHAPED.test(v), "phone-number shaped value is not an interaction reference")
  .refine((v) => !PARTY_URI.test(v), "a tel:/sip:/sips: party URI is not an interaction reference");
export type CarrierInteractionRef = z.infer<typeof CarrierInteractionRef>;

/** Non-bearer session binding reference (`ses_bnd_` + base64url sha256 of the bearer), see actions/digest.ts. */
export const SessionBindingRef = z.string().regex(/^ses_bnd_[A-Za-z0-9_-]{43}$/, "session binding reference expected");

/** How the binding was established. A model, a caller utterance or a tool argument is never a source. */
export const BindingSource = z.enum(["carrier_dispatch_rule", "carrier_webhook_verified", "trusted_server_lookup"]);
export type BindingSource = z.infer<typeof BindingSource>;

export const CallBindingState = z.enum(["ACTIVE", "SUPERSEDED", "ENDED", "REVOKED"]);
export type CallBindingState = z.infer<typeof CallBindingState>;

export const CallBinding = z
  .strictObject({
    ...envelope(CALL_BINDING_SCHEMA_VERSION, ["tenantId", "interactionId", "sessionGeneration", "occurredAt", "expiresAt"], ["causationId"]),
    bindingId: opaqueIdWithPrefix("cbd"),
    carrier: z.strictObject({
      kind: CarrierKind,
      interactionRef: CarrierInteractionRef,
      /** Trunk, dispatch rule or Studio flow reference from trusted configuration (never a dial string). */
      routeRef: z.string().regex(/^[A-Za-z0-9_:./-]{3,128}$/).nullable(),
    }),
    owner: z.strictObject({
      adapter: ConversationAdapter,
      /** Worker or replica instance holding the call-owner lease. */
      instanceRef: z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/),
      /** Monotonic fencing token of the call-owner lease; a stale token is refused. */
      fencingToken: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    }),
    /** Session the interaction is bound to, as a non-bearer reference; null before verification. */
    sessionBindingRef: SessionBindingRef.nullable(),
    boundBy: BindingSource,
    state: CallBindingState,
    supersedesBindingId: opaqueIdWithPrefix("cbd").nullable(),
  })
  .superRefine((b, ctx) => {
    if (!isAfter(b.expiresAt, b.occurredAt)) ctx.addIssue({ code: "custom", message: "BINDING_EXPIRY_NOT_AFTER_ISSUE", path: ["expiresAt"] });
    if (b.supersedesBindingId !== null && b.supersedesBindingId === b.bindingId) {
      ctx.addIssue({ code: "custom", message: "BINDING_SUPERSEDES_ITSELF", path: ["supersedesBindingId"] });
    }
  });
export type CallBinding = z.infer<typeof CallBinding>;

/** What a gateway request presents for the binding check. */
export const BindingClaim = z.strictObject({
  tenantId: ENVELOPE_FIELDS.tenantId,
  interactionId: OpaqueId,
  sessionGeneration: ENVELOPE_FIELDS.sessionGeneration,
  fencingToken: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
});
export type BindingClaim = z.infer<typeof BindingClaim>;

export type BindingCheck =
  | { current: true }
  | { current: false; reasonCode: "BINDING_NOT_ACTIVE" | "BINDING_EXPIRED" | "BINDING_TENANT_MISMATCH" | "BINDING_INTERACTION_MISMATCH" | "BINDING_GENERATION_STALE" | "BINDING_FENCING_TOKEN_STALE" };

/**
 * Fail-closed currency check of a claim against the stored binding: same tenant and interaction,
 * ACTIVE, unexpired at `now` (independent of storage TTL, AUTH-04), the current session generation
 * and the current fencing token. Any mismatch is refused, never "best effort".
 */
export function checkBinding(binding: CallBinding, claim: BindingClaim, now: Date): BindingCheck {
  if (binding.tenantId !== claim.tenantId) return { current: false, reasonCode: "BINDING_TENANT_MISMATCH" };
  if (binding.interactionId !== claim.interactionId) return { current: false, reasonCode: "BINDING_INTERACTION_MISMATCH" };
  if (binding.state !== "ACTIVE") return { current: false, reasonCode: "BINDING_NOT_ACTIVE" };
  if (Date.parse(binding.expiresAt) <= now.getTime()) return { current: false, reasonCode: "BINDING_EXPIRED" };
  if (binding.sessionGeneration !== claim.sessionGeneration) return { current: false, reasonCode: "BINDING_GENERATION_STALE" };
  if (binding.owner.fencingToken !== claim.fencingToken) return { current: false, reasonCode: "BINDING_FENCING_TOKEN_STALE" };
  return { current: true };
}

/* ======================================================================== */
/* Media path API and consent-driven processing (WP-11)                       */
/* ======================================================================== */

/**
 * The binding claim the media worker presents on every media-path request: the CallBinding claim plus the
 * binding it names. Every field is server-issued (the worker copies it from the issuance response, AUTH-03);
 * the gateway re-checks it against the stored binding with `checkBinding` and refuses a stale generation or
 * fencing token.
 */
export const MediaBindingClaim = z.strictObject({
  bindingId: opaqueIdWithPrefix("cbd"),
  tenantId: ENVELOPE_FIELDS.tenantId,
  interactionId: OpaqueId,
  sessionGeneration: ENVELOPE_FIELDS.sessionGeneration,
  fencingToken: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
});
export type MediaBindingClaim = z.infer<typeof MediaBindingClaim>;

/**
 * LiveKit room name as the media plane assigns it (a created room, or a SIP dispatch rule's prefix plus a server
 * suffix). Any name the media plane can assign is accepted, bounded by length and free of control characters: a
 * refusal here would leave the call without a binding AND without the session-less human and safety routes (SAFE-02).
 * An `individual` or `callee` SIP dispatch rule puts the E.164 number into the name (`<prefix>_+1..._<suffix>`,
 * verified against livekit-sip v1.18.0 in the Layer-2 media suite), so the name can carry a caller number: it is sent
 * only to the gateway and the media plane's own API (request bodies, never a URL path), kept by the gateway as a
 * SHA-256 digest, and never logged or audited; deployments set `hidePhoneNumber` on SIP dispatch rules so the number
 * stays out of names and attributes. Nothing derives a file path, key or URL from it.
 */
export const MEDIA_ROOM_NAME_MAX = 256;
// eslint-disable-next-line no-control-regex
export const MediaRoomName = z.string().min(1).max(MEDIA_ROOM_NAME_MAX).regex(/^[^\u0000-\u001f\u007f-\u009f]+$/u, "room name expected");
/** LiveKit agent job id assigned by livekit-server when it dispatches the room to a worker. */
export const AgentJobRef = z.string().regex(/^AJ_[A-Za-z0-9]{4,64}$/, "agent job id expected");
/** Worker or replica instance (same grammar as CallBinding.owner.instanceRef). */
export const RuntimeInstanceRef = z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/);
/** Participant identity in the media plane (the agent's own identity in the room). */
export const MediaParticipantIdentity = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);
/** Runtime adapters the media worker can own a call as (the Talkdesk and human-only adapters never bind here). */
export const RuntimeAdapter = ConversationAdapter.extract(["controlled_cascade_runtime", "native_duplex_runtime"]);
export type RuntimeAdapter = z.infer<typeof RuntimeAdapter>;
const LanguageTag = z.string().regex(/^[a-z]{2,3}(-[A-Z]{2})?$/);
const ReasonCode = z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/);

/* ---- consent-driven processing (DATA-03) -------------------------------- */

export const PROCESSING_DIRECTIVE_SCHEMA_VERSION = "processing-directive.v1";
export const MEDIA_PROCESSING_STATE_SCHEMA_VERSION = "media-processing-state.v1";

/** The two consent dimensions the media path acts on (common.ts ConsentDimension). */
export const MediaConsentDimension = z.enum(["recording", "transcriptionAiProcessing"]);
export type MediaConsentDimension = z.infer<typeof MediaConsentDimension>;

/** One consent dimension as delivered to the media path: the stored value, its expiry and the template the caller heard. */
export const ProcessingConsent = z.strictObject({
  value: ConsentValueV2,
  expiresAt: IsoDateTime.nullable(),
  capturedAt: IsoDateTime.nullable(),
  templateVersion: VersionLabel.nullable(),
});
export type ProcessingConsent = z.infer<typeof ProcessingConsent>;

/**
 * Only GRANTED or NOT_REQUIRED, unexpired at `now`, permits a recorder or a processing tap. UNKNOWN is not
 * consent; DECLINED and EXPIRED never permit (DATA-03). NOT_REQUIRED is set only by the trusted consent capture
 * under an approved jurisdiction rule, never by the media worker.
 */
export function processingPermitted(consent: ProcessingConsent, now: Date): boolean {
  if (consent.expiresAt !== null && Date.parse(consent.expiresAt) <= now.getTime()) return false;
  return consent.value === "GRANTED" || consent.value === "NOT_REQUIRED";
}

/**
 * Which recorder and taps the consent permits at `now` (DATA-03). The transcription tap (the retained transcript of
 * the call) and the analysis tap (retained analytics derived from the call audio) are recording-dependent processing:
 * each needs BOTH the recording and the transcription/AI-processing dimension. The live speech recognition that lets
 * the runtime converse is governed by the AI-processing dimension alone (a decline routes the call to a person).
 */
export function permittedTaps(consent: { recording: ProcessingConsent; transcriptionAiProcessing: ProcessingConsent }, now: Date): { recording: boolean; transcription: boolean; analysis: boolean } {
  const recording = processingPermitted(consent.recording, now);
  const derived = recording && processingPermitted(consent.transcriptionAiProcessing, now);
  return { recording, transcription: derived, analysis: derived };
}

/** Configured alternative when the caller declines recording: continue without any recorder, or a person. */
export const RecordingDeclinedRoute = z.enum(["CONTINUE_UNRECORDED", "HUMAN"]);
export type RecordingDeclinedRoute = z.infer<typeof RecordingDeclinedRoute>;

/**
 * What the media path may run, delivered by the gateway with the CallBinding and on every heartbeat. The
 * consent version is monotonic per call: a worker applies a directive only when its version is not lower than
 * the one it holds, so a late response never re-enables a recorder after a decline.
 */
export const ProcessingDirective = z.strictObject({
  schemaVersion: z.literal(PROCESSING_DIRECTIVE_SCHEMA_VERSION),
  consentVersion: z.number().int().min(1).max(1_000_000),
  recording: ProcessingConsent,
  transcriptionAiProcessing: ProcessingConsent,
  /** Approved disclosure template the caller heard (recording and processing notice); null when none was played. */
  disclosureTemplateId: VersionLabel.nullable(),
  recordingDeclinedRoute: RecordingDeclinedRoute,
  decidedAt: IsoDateTime,
});
export type ProcessingDirective = z.infer<typeof ProcessingDirective>;

/** Phase of one recorder or tap. STARTING, ON and STOPPING count as running: a call is never reported unrecorded while a tap may still capture. */
export const TapPhase = z.enum(["OFF", "STARTING", "ON", "STOPPING", "FAILED"]);
export type TapPhase = z.infer<typeof TapPhase>;
export const RUNNING_TAP_PHASES: readonly TapPhase[] = ["STARTING", "ON", "STOPPING"];
/**
 * Phases in which a tap captures by design. A tap capturing under consent that does not permit it is a mismatch;
 * STOPPING is the bounded drain after a decline (still running, so never reported as unrecorded), and a drain that
 * outlasts its bound is flagged by the worker's reconciliation.
 */
export const CAPTURING_TAP_PHASES: readonly TapPhase[] = ["STARTING", "ON"];

/** A recorder reference: the LiveKit egress id of one recorder the worker started for the call. */
export const RecorderRef = z.string().regex(/^[A-Za-z0-9_-]{3,64}$/);

export const TapState = z.strictObject({
  phase: TapPhase,
  active: z.boolean(),
  /** Recorder reference (the LiveKit egress id) for the recording tap; null for in-process taps or when none exists. */
  ref: RecorderRef.nullable(),
  changedAt: IsoDateTime,
});
export type TapState = z.infer<typeof TapState>;

/** Why the actual processing state contradicts the consent or the disclosure; any value routes the call to a person. */
export const ProcessingMismatch = z.enum([
  "RECORDING_WITHOUT_CONSENT",
  "TAP_WITHOUT_CONSENT",
  "RECORDER_STATE_UNKNOWN",
  "RECORDING_REFUSED_BY_MEDIA_PLANE",
  "FOREIGN_RECORDER_ACTIVE",
]);
export type ProcessingMismatch = z.infer<typeof ProcessingMismatch>;

/**
 * Typed readout of what the media path is actually doing for one call (FO-15 DATA-03; read by J12, RECORDING_REFUSED
 * and CONSENT_REVOKED). The worker publishes it from its recorder and taps; tests compare it with the LiveKit
 * egress API independently of the platform's own record.
 */
export const MediaProcessingState = z
  .strictObject({
    ...envelope(MEDIA_PROCESSING_STATE_SCHEMA_VERSION, ["tenantId", "interactionId", "sessionGeneration", "occurredAt"]),
    bindingId: opaqueIdWithPrefix("cbd"),
    recording: TapState,
    transcription: TapState,
    analysis: TapState,
    consent: z.strictObject({
      consentVersion: z.number().int().min(1).max(1_000_000),
      recording: ProcessingConsent,
      transcriptionAiProcessing: ProcessingConsent,
    }),
    disclosureTemplateId: VersionLabel.nullable(),
    mismatch: ProcessingMismatch.nullable(),
    /**
     * Every recorder (egress id) this worker started for the call and has not yet seen end, one per recorded party
     * track. The gateway keeps them per binding, so a replacement after an owner loss adopts exactly these recorders
     * and treats any other running recorder as foreign (DATA-03, T-FO-11-03).
     */
    recorderRefs: z.array(RecorderRef).max(8),
    changedAt: IsoDateTime,
  })
  .superRefine((s, ctx) => {
    for (const p of mediaProcessingStateProblems(s)) ctx.addIssue({ code: "custom", message: p.rule, path: p.path });
  });
export type MediaProcessingState = z.infer<typeof MediaProcessingState>;

/** Rule codes of MediaProcessingState (tested in call-binding.test.ts). */
export const MEDIA_PROCESSING_RULES = {
  activeFlag: "TAP_ACTIVE_FLAG_INCONSISTENT",
  recorderRef: "RECORDING_ON_WITHOUT_RECORDER_REF",
  recorderListed: "RECORDER_REF_NOT_LISTED",
  unflagged: "PROCESSING_MISMATCH_NOT_FLAGGED",
} as const;

type ProcessingShape = Pick<MediaProcessingState, "recording" | "transcription" | "analysis" | "consent" | "mismatch" | "occurredAt" | "recorderRefs">;

/** Cross-field rules of the readout: `active` follows the phase, a running recorder names its egress, and running without consent is flagged. */
export function mediaProcessingStateProblems(s: ProcessingShape): { rule: string; path: (string | number)[] }[] {
  const out: { rule: string; path: (string | number)[] }[] = [];
  for (const tap of ["recording", "transcription", "analysis"] as const) {
    if (s[tap].active !== RUNNING_TAP_PHASES.includes(s[tap].phase)) out.push({ rule: MEDIA_PROCESSING_RULES.activeFlag, path: [tap, "active"] });
  }
  if (s.recording.phase === "ON" && s.recording.ref === null) out.push({ rule: MEDIA_PROCESSING_RULES.recorderRef, path: ["recording", "ref"] });
  // The recorder the readout names is one of the recorders it lists (the list is what the gateway keeps for recovery).
  if (RUNNING_TAP_PHASES.includes(s.recording.phase) && s.recording.ref !== null && !s.recorderRefs.includes(s.recording.ref)) out.push({ rule: MEDIA_PROCESSING_RULES.recorderListed, path: ["recorderRefs"] });
  if (unconsentedTaps(s, s.consent, new Date(s.occurredAt)).length > 0 && s.mismatch === null) out.push({ rule: MEDIA_PROCESSING_RULES.unflagged, path: ["mismatch"] });
  return out;
}

/** The taps of a readout that capture (STARTING or ON) although the given consent does not permit them at `now`. */
export function unconsentedTaps(
  s: Pick<MediaProcessingState, "recording" | "transcription" | "analysis">,
  consent: { recording: ProcessingConsent; transcriptionAiProcessing: ProcessingConsent },
  now: Date,
): ("recording" | "transcription" | "analysis")[] {
  const permitted = permittedTaps(consent, now);
  return (["recording", "transcription", "analysis"] as const).filter((t) => CAPTURING_TAP_PHASES.includes(s[t].phase) && !permitted[t]);
}

/* ---- media path requests and responses ----------------------------------- */

/** Issue (or, after the previous owner was lost, re-issue) the binding for one dispatched room job. */
export const MediaBindRequest = z.strictObject({
  roomName: MediaRoomName,
  jobRef: AgentJobRef,
  workerInstanceRef: RuntimeInstanceRef,
  agentIdentity: MediaParticipantIdentity,
  adapter: RuntimeAdapter,
});
export type MediaBindRequest = z.infer<typeof MediaBindRequest>;

export const BindingIssueKind = z.enum(["NEW_CALL", "REBOUND_AFTER_OWNER_LOSS"]);
export type BindingIssueKind = z.infer<typeof BindingIssueKind>;

export const MediaBindResponse = z.strictObject({
  binding: CallBinding,
  claim: MediaBindingClaim,
  directive: ProcessingDirective,
  issue: BindingIssueKind,
  supersededBindingId: opaqueIdWithPrefix("cbd").nullable(),
  heartbeatIntervalSeconds: z.number().int().min(1).max(60),
  /**
   * The recorders (egress ids) the owners of this call reported as their own: after an owner loss the new owner
   * adopts exactly these (when the egress API still lists them running, writing to the egress service's own storage
   * under the call's path) instead of starting a second recorder. Any other running recorder is foreign (DATA-03).
   * Empty for a new call.
   */
  adoptableRecorders: z.array(RecorderRef).max(32),
});
export type MediaBindResponse = z.infer<typeof MediaBindResponse>;

export const MediaHeartbeatRequest = z.strictObject({ claim: MediaBindingClaim });
export type MediaHeartbeatRequest = z.infer<typeof MediaHeartbeatRequest>;
export const MediaHeartbeatResponse = z.strictObject({
  state: CallBindingState,
  expiresAt: IsoDateTime,
  sessionGeneration: ENVELOPE_FIELDS.sessionGeneration,
  directive: ProcessingDirective,
});
export type MediaHeartbeatResponse = z.infer<typeof MediaHeartbeatResponse>;

/** Call lifecycle observed by the media worker (FO-10-09); each maps to a control-plane session change. */
export const MediaLifecycleEventKind = z.enum([
  "PARTICIPANT_JOINED",
  "PARTICIPANT_LEFT",
  "HOLD_STARTED",
  "HOLD_ENDED",
  "TRANSFER_LEG_STARTED",
  "TRANSFER_LEG_ENDED",
  "CALLER_HUNG_UP",
  "MEDIA_DISCONNECTED",
]);
export type MediaLifecycleEventKind = z.infer<typeof MediaLifecycleEventKind>;
export const MediaParticipantRole = z.enum(["caller", "human_agent", "other"]);
export type MediaParticipantRole = z.infer<typeof MediaParticipantRole>;

export const MediaLifecycleRequest = z.strictObject({
  claim: MediaBindingClaim,
  event: z.strictObject({ kind: MediaLifecycleEventKind, participantRole: MediaParticipantRole.nullable(), occurredAt: IsoDateTime }),
});
export type MediaLifecycleRequest = z.infer<typeof MediaLifecycleRequest>;

export const MediaLifecycleResponse = z.strictObject({
  claim: MediaBindingClaim,
  state: CallBindingState,
  /** True when the control-plane session changed generation (pending speech of the old generation is void). */
  generationChanged: z.boolean(),
  invalidatedActions: z.number().int().min(0).max(10_000),
  routeToHuman: z.boolean(),
  reasonCode: ReasonCode,
});
export type MediaLifecycleResponse = z.infer<typeof MediaLifecycleResponse>;

/** The caller declined or revoked a processing dimension on the media path (the RECORDING_REFUSED injection point). Only a decrease is accepted from the runtime. */
export const MediaConsentDecisionRequest = z.strictObject({
  claim: MediaBindingClaim,
  dimension: MediaConsentDimension,
  decision: z.enum(["DECLINED", "REVOKED"]),
  capturedVia: z.enum(["dtmf_menu", "speech_intent"]),
  occurredAt: IsoDateTime,
});
export type MediaConsentDecisionRequest = z.infer<typeof MediaConsentDecisionRequest>;

export const MediaConsentDecisionResponse = z.strictObject({
  directive: ProcessingDirective,
  routeToHuman: z.boolean(),
  reasonCode: ReasonCode,
});
export type MediaConsentDecisionResponse = z.infer<typeof MediaConsentDecisionResponse>;

export const MediaProcessingReportRequest = z.strictObject({ claim: MediaBindingClaim, state: MediaProcessingState });
export type MediaProcessingReportRequest = z.infer<typeof MediaProcessingReportRequest>;
/**
 * The gateway's verdict on a readout plus the current processing directive: the worker reports on every
 * reconciliation tick, so a consent change recorded in the control plane reaches the recorder and the taps within one
 * reconciliation interval, not only at the next heartbeat (DATA-03).
 */
export const MediaProcessingReportResponse = z.strictObject({
  accepted: z.boolean(),
  mismatch: ProcessingMismatch.nullable(),
  routeToHuman: z.boolean(),
  reasonCode: ReasonCode,
  directive: ProcessingDirective,
});
export type MediaProcessingReportResponse = z.infer<typeof MediaProcessingReportResponse>;

/** Why the runtime asks for a person; the destination always comes from trusted configuration (SAFE-05). */
export const MediaHumanRouteReason = z.enum([
  "CALLER_REQUESTED_HUMAN",
  "CONSENT_DECLINED_ALTERNATIVE",
  "PROCESSING_MISMATCH",
  "RECOVERY_FAILED",
  "BINDING_UNAVAILABLE",
  "AI_UNAVAILABLE",
]);
export type MediaHumanRouteReason = z.infer<typeof MediaHumanRouteReason>;

/** Human route: needs only the runtime credential and the room, never a live binding or session (SAFE-02). */
export const MediaHumanRouteRequest = z.strictObject({ roomName: MediaRoomName, reason: MediaHumanRouteReason, language: LanguageTag });
export type MediaHumanRouteRequest = z.infer<typeof MediaHumanRouteRequest>;

export const MediaRouteResponse = z.strictObject({
  accepted: z.boolean(),
  destinationId: z.string().regex(/^dst_[a-z0-9_]{2,40}$/),
  handoffId: OpaqueId.nullable(),
  speechTemplateId: z.string().regex(/^[a-z][a-z0-9_.]{2,80}$/),
  reasonCode: ReasonCode,
});
export type MediaRouteResponse = z.infer<typeof MediaRouteResponse>;

/** Safety route: the deterministic signal (rule id, never the caller's words) and the locale; no binding or session needed (SAFE-02). */
export const MediaSafetyRouteRequest = z.strictObject({
  roomName: MediaRoomName,
  signals: z
    .array(
      z.strictObject({
        source: z.enum(["EXPLICIT_PHRASE", "SEMANTIC_SIGNAL", "ASR_UNCERTAIN", "CALLER_REQUEST", "FAIL_SAFE"]),
        ruleId: z.string().regex(/^[a-z][a-z0-9_.-]{2,63}$/),
        strength: z.enum(["CREDIBLE", "UNRESOLVED"]),
        subject: z.enum(["SELF", "THIRD_PARTY", "UNKNOWN"]),
        temporal: z.enum(["CURRENT", "HISTORICAL", "UNKNOWN"]),
        negated: z.boolean(),
      }),
    )
    .min(1)
    .max(8),
  locale: z.string().regex(/^[a-z]{2}-[A-Z]{2}$/),
});
export type MediaSafetyRouteRequest = z.infer<typeof MediaSafetyRouteRequest>;

/**
 * The call's recorders for a runtime that holds no binding for its room job: one refused into a person route
 * (BINDING_CONSENT_REQUIRES_PERSON, BINDING_PERSON_REQUESTED, BINDING_WITH_PERSON) after the call's owner was lost. The
 * gateway confirms the job as it does for a bind (dispatched in the room, assigned to the named agent participant,
 * which is present); no binding, claim or session is issued. The runtime stops the recorders the gateway names that
 * still run and reports a running recorder the consent does not permit (`mismatch`; DATA-03, FO-10-46).
 */
export const MediaRecorderCheckRequest = z.strictObject({
  roomName: MediaRoomName,
  jobRef: AgentJobRef,
  agentIdentity: MediaParticipantIdentity,
  /** What the runtime observed since its last check: a recorder running that the consent does not permit, or null. */
  mismatch: ProcessingMismatch.nullable(),
});
export type MediaRecorderCheckRequest = z.infer<typeof MediaRecorderCheckRequest>;

export const MediaRecorderCheckResponse = z.strictObject({
  /** The room's call, or null when no runtime ever bound it. */
  interactionId: OpaqueId.nullable(),
  /**
   * The call's current processing directive (the consent the recorders answer to), or null when there is no call or
   * its session can no longer be read: then nothing is consented (UNKNOWN is not consent).
   */
  directive: ProcessingDirective.nullable(),
  /** Every recorder (egress id) an owner of the call reported as its own, newest last. */
  recorders: z.array(RecorderRef).max(32),
});
export type MediaRecorderCheckResponse = z.infer<typeof MediaRecorderCheckResponse>;
