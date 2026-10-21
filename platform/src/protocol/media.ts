/**
 * Media-runtime contracts (follow-on prompt sections 4 and 10; docs/ARCHITECTURE.md section 6.2):
 * TurnEnvelope, CarrierEvent, SpeechPlan and AudioReleaseReceipt.
 *
 * The runtime, not a prompt, decides which audio reaches the caller: no Mode A frame is emitted
 * unless it belongs to a gateway-issued SpeechPlan the release guard accepted, or to a fallback
 * clip from the signed clip manifest. Protected facts use fixed wording with deterministic trusted
 * slots; only low-risk classes may use bounded paraphrase or native speech (ACT-05, SAFE-01).
 *
 * Created by WP-02 in phase B; owned by WP-14 from phase C. Digest helpers live in digests.ts
 * (Node-only) so this file stays importable by browser code.
 */
import { z } from "zod";
import { CarrierInteractionRef, CarrierKind } from "./call-binding.js";
import {
  BusinessTimeZone,
  Classification,
  EvidencePointer,
  IsoDateTime,
  LocalDate,
  Money,
  OpaqueId,
  Sha256Hex,
  TurnId,
  VersionLabel,
  envelope,
  isAfter,
  opaqueIdWithPrefix,
} from "./common.js";
import { DestinationId, SupportReference } from "./support.js";
import { ReasonCode, ResponseClass } from "./tools.js";

export const TURN_ENVELOPE_SCHEMA_VERSION = "turn-envelope.v1";
export const CARRIER_EVENT_SCHEMA_VERSION = "carrier-event.v1";
export const SPEECH_PLAN_SCHEMA_VERSION = "speech-plan.v1";
export const AUDIO_RELEASE_RECEIPT_SCHEMA_VERSION = "audio-release-receipt.v1";

/** BCP 47 subset used across the platform (language plus optional region). */
export const LanguageTag = z.string().regex(/^[a-z]{2,3}(-[A-Z]{2})?$/);

/** Mode A controlled cascade or Mode B native full-duplex (follow-on prompt section 3). */
export const VoiceMode = z.enum(["CONTROLLED_CASCADE", "NATIVE_DUPLEX"]);
export type VoiceMode = z.infer<typeof VoiceMode>;

/* ------------------------------------------------------------------------ */
/* TurnEnvelope                                                              */
/* ------------------------------------------------------------------------ */

export const TurnSpeaker = z.enum(["caller", "agent_runtime", "human_agent", "system"]);
export type TurnSpeaker = z.infer<typeof TurnSpeaker>;

export const TurnInputKind = z.enum(["SPEECH", "DTMF_ISOLATED", "BACKCHANNEL", "INTERRUPTION", "SILENCE", "NON_SPEECH_NOISE", "SYSTEM_EVENT"]);
export type TurnInputKind = z.infer<typeof TurnInputKind>;

/**
 * Minimized, persisted record of one conversation turn (FO-04-07): who spoke, when, how confident
 * the recognizer was and under which session generation. Transcript text is never inline; it
 * lives in restricted storage behind `transcriptRef`. DTMF digits never appear (AUTH-06).
 */
export const TurnEnvelope = z
  .strictObject({
    ...envelope(TURN_ENVELOPE_SCHEMA_VERSION, ["tenantId", "interactionId", "sessionGeneration", "turnId", "occurredAt", "dataClassification"], ["causationId", "caseId"]),
    /** Incremented on barge-in or speaker switch; pending speech of an older revision is invalid. */
    turnRevision: z.number().int().min(0).max(10_000),
    speaker: TurnSpeaker,
    inputKind: TurnInputKind,
    voiceMode: VoiceMode,
    timing: z.strictObject({
      speechStartedAt: IsoDateTime.nullable(),
      speechEndedAt: IsoDateTime.nullable(),
      endpointedAt: IsoDateTime.nullable(),
      firstMeaningfulAudioAt: IsoDateTime.nullable(),
    }),
    asr: z
      .strictObject({
        engineRef: VersionLabel,
        language: LanguageTag,
        confidence: z.number().min(0).max(1).nullable(),
        final: z.boolean(),
        /** True when an important entity (date, amount, identifier) was recognized with low confidence. */
        entityUncertain: z.boolean(),
      })
      .nullable(),
    interruption: z
      .strictObject({ interruptedTurnId: TurnId, detectedAt: IsoDateTime, playbackStoppedAt: IsoDateTime.nullable() })
      .nullable(),
    /** Restricted transcript evidence (RESTRICTED_QA_MEDIA rules); null when nothing was transcribed. */
    transcriptRef: EvidencePointer.nullable(),
    /** True when digits were captured on the isolated DTMF path; the digits themselves never are. */
    dtmfCaptured: z.boolean(),
    speechPlanRefs: z.array(OpaqueId).max(8),
    toolRequestRefs: z.array(OpaqueId).max(16),
  })
  .superRefine((t, ctx) => {
    if (t.dataClassification === "VERIFICATION_SECRET") ctx.addIssue({ code: "custom", message: "TURN_HOLDS_VERIFICATION_SECRET", path: ["dataClassification"] });
    if (t.inputKind === "DTMF_ISOLATED" && (t.transcriptRef !== null || t.asr !== null)) {
      ctx.addIssue({ code: "custom", message: "DTMF_REACHED_TRANSCRIPT_OR_ASR", path: ["transcriptRef"] });
    }
    if (t.inputKind === "INTERRUPTION" && t.interruption === null) ctx.addIssue({ code: "custom", message: "INTERRUPTION_WITHOUT_DETAIL", path: ["interruption"] });
    const { speechStartedAt, speechEndedAt } = t.timing;
    if (speechStartedAt && speechEndedAt && Date.parse(speechEndedAt) < Date.parse(speechStartedAt)) {
      ctx.addIssue({ code: "custom", message: "SPEECH_ENDS_BEFORE_START", path: ["timing", "speechEndedAt"] });
    }
  });
export type TurnEnvelope = z.infer<typeof TurnEnvelope>;

/* ------------------------------------------------------------------------ */
/* CarrierEvent                                                              */
/* ------------------------------------------------------------------------ */

export const CarrierEventType = z.enum([
  "CALL_STARTED",
  "CALL_ANSWERED",
  "CALL_ENDED",
  "PARTICIPANT_JOINED",
  "PARTICIPANT_LEFT",
  "MEDIA_CONNECTED",
  "MEDIA_DISCONNECTED",
  "HOLD_STARTED",
  "HOLD_ENDED",
  "DTMF_RECEIVED",
  "RECORDING_STARTED",
  "RECORDING_STOPPED",
  "RECORDING_REFUSED",
  "TRANSFER_REQUESTED",
  "TRANSFER_QUEUED",
  "TRANSFER_RECEIVER_ACCEPTED",
  "TRANSFER_RECEIVER_DECLINED",
  "TRANSFER_RECEIVER_UNAVAILABLE",
  "TRANSFER_BRIDGED",
  "TRANSFER_CALLER_CONNECTED",
  "TRANSFER_COMPLETED",
  "TRANSFER_TIMED_OUT",
  "TRANSFER_BRIDGE_DROPPED",
  "TRANSFER_FAILED",
]);
export type CarrierEventType = z.infer<typeof CarrierEventType>;

/** Authentication mechanism actually used for the event (recorded, never assumed). */
export const CarrierEventAuth = z.enum(["vendor_signature_verified", "mtls_client_verified", "oauth_bearer_verified", "trusted_server_lookup", "local_fixture_hmac"]);
export type CarrierEventAuth = z.infer<typeof CarrierEventAuth>;

/**
 * Transfer state each transfer event evidences (support.ts TransferState values). The transfer
 * state machine still derives state only when prerequisites are evidenced; a late event never
 * rewrites a failed historical connection into success (SAFE-04).
 */
export const CARRIER_EVENT_TRANSFER_STATE = {
  TRANSFER_REQUESTED: "REQUESTED",
  TRANSFER_QUEUED: "QUEUED",
  TRANSFER_RECEIVER_ACCEPTED: "RECEIVER_ACCEPTED",
  TRANSFER_RECEIVER_DECLINED: "RECEIVER_DECLINED",
  TRANSFER_RECEIVER_UNAVAILABLE: "RECEIVER_UNAVAILABLE",
  TRANSFER_BRIDGED: "BRIDGED",
  TRANSFER_CALLER_CONNECTED: "CALLER_CONFIRMED_CONNECTED",
  TRANSFER_COMPLETED: "COMPLETED",
  TRANSFER_TIMED_OUT: "TIMED_OUT",
  TRANSFER_BRIDGE_DROPPED: "BRIDGE_DROPPED",
  TRANSFER_FAILED: "FAILED",
} as const satisfies Partial<Record<CarrierEventType, string>>;

const isTransferEvent = (t: CarrierEventType): boolean => t.startsWith("TRANSFER_");
const isRecordingEvent = (t: CarrierEventType): boolean => t.startsWith("RECORDING_");

/**
 * Authenticated carrier event (SIP, LiveKit, Talkdesk) as persisted in the durable inbox before
 * acknowledgement. `providerEventId` is the deduplication key; `occurredAt` is the carrier's causal
 * time when it supplies one (`clockSource`), never the arrival order.
 */
export const CarrierEvent = z
  .strictObject({
    ...envelope(CARRIER_EVENT_SCHEMA_VERSION, ["tenantId", "occurredAt"], ["interactionId", "causationId"]),
    eventId: opaqueIdWithPrefix("cev"),
    carrier: CarrierKind,
    carrierInteractionRef: CarrierInteractionRef,
    providerEventId: z.string().regex(/^[A-Za-z0-9._:-]{3,128}$/),
    providerSequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
    type: CarrierEventType,
    clockSource: z.enum(["carrier", "platform_receipt"]),
    receivedAt: IsoDateTime,
    authentication: z.strictObject({
      mechanism: CarrierEventAuth,
      /** Signing key or client certificate reference (never the key material). */
      keyRef: z.string().regex(/^[A-Za-z0-9_:./-]{3,256}$/).nullable(),
    }),
    payloadDigest: Sha256Hex,
    payloadSchemaRef: VersionLabel,
    participantRef: OpaqueId.nullable(),
    transfer: z
      .strictObject({
        transferRef: OpaqueId,
        destinationId: DestinationId,
        /** Accepting receiver (human agent or queue member) when the carrier reports one. */
        receiverRef: OpaqueId.nullable(),
      })
      .nullable(),
    recording: z.strictObject({ recordingRef: OpaqueId.nullable(), reasonCode: ReasonCode.nullable() }).nullable(),
  })
  .superRefine((e, ctx) => {
    if (isTransferEvent(e.type) && e.transfer === null) ctx.addIssue({ code: "custom", message: "TRANSFER_EVENT_WITHOUT_TRANSFER", path: ["transfer"] });
    if (!isTransferEvent(e.type) && e.transfer !== null) ctx.addIssue({ code: "custom", message: "TRANSFER_DETAIL_ON_NON_TRANSFER_EVENT", path: ["transfer"] });
    if (isRecordingEvent(e.type) && e.recording === null) ctx.addIssue({ code: "custom", message: "RECORDING_EVENT_WITHOUT_DETAIL", path: ["recording"] });
    if (e.type === "TRANSFER_RECEIVER_ACCEPTED" && e.transfer?.receiverRef === null) {
      ctx.addIssue({ code: "custom", message: "ACCEPTANCE_WITHOUT_RECEIVER", path: ["transfer", "receiverRef"] });
    }
    if (e.clockSource === "platform_receipt" && e.occurredAt !== e.receivedAt) {
      ctx.addIssue({ code: "custom", message: "RECEIPT_CLOCK_MUST_EQUAL_RECEIVED_AT", path: ["occurredAt"] });
    }
  });
export type CarrierEvent = z.infer<typeof CarrierEvent>;

/* ------------------------------------------------------------------------ */
/* SpeechPlan                                                                */
/* ------------------------------------------------------------------------ */

/** Classes carrying protected facts: fixed wording, trusted slots, authorization and a source (ACT-05). */
export const FACT_PROTECTED_CLASSES = ["IDENTITY", "FINANCIAL_FACT", "COMMITMENT", "PROTECTED_FACT"] as const satisfies readonly ResponseClass[];
/** Classes with fixed approved wording that never need account authentication (SAFE-02). */
export const FIXED_WORDING_CLASSES = ["SAFETY", "CLINICAL_BOUNDARY", "RECORDING_DISCLOSURE"] as const satisfies readonly ResponseClass[];
/** Classes the routing table may mark NATIVE_ALLOWED after qualification. */
export const NATIVE_ELIGIBLE_CLASSES = ["LOW_RISK_GROUNDED", "GENERIC_STATUS"] as const satisfies readonly ResponseClass[];

export const SpeechRoute = z.enum(["CONTROLLED", "NATIVE_ALLOWED"]);
export type SpeechRoute = z.infer<typeof SpeechRoute>;

export const SpeechRenderer = z.enum(["controlled_tts", "fallback_clip", "native_buffer_checked"]);
export type SpeechRenderer = z.infer<typeof SpeechRenderer>;

const SlotName = z.string().regex(/^[a-z][a-zA-Z0-9]{0,40}$/);
const TemplateId = z.string().regex(/^[a-z][a-z0-9_.]{2,80}$/);
export const ClipRef = z.string().regex(/^clip_[a-z0-9_]{3,64}@v[1-9][0-9]{0,5}$/);

/** Deterministic trusted slot: typed value from a source fact or receipt, read out by a fixed rule. */
export const ProtectedSlot = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("MONEY"), name: SlotName, value: Money, sourceRef: EvidencePointer }),
  z.strictObject({ kind: z.literal("DATE"), name: SlotName, value: LocalDate, timeZone: BusinessTimeZone, sourceRef: EvidencePointer }),
  z.strictObject({ kind: z.literal("DATETIME"), name: SlotName, value: IsoDateTime, timeZone: BusinessTimeZone, sourceRef: EvidencePointer }),
  z.strictObject({ kind: z.literal("COUNT"), name: SlotName, value: z.number().int().min(0).max(1_000_000), sourceRef: EvidencePointer }),
  z.strictObject({ kind: z.literal("IDENTIFIER_SUFFIX"), name: SlotName, value: z.string().regex(/^[A-Z0-9]{2,6}$/), sourceRef: EvidencePointer }),
  z.strictObject({ kind: z.literal("SUPPORT_REFERENCE"), name: SlotName, value: SupportReference, sourceRef: EvidencePointer }),
  z.strictObject({ kind: z.literal("ENUM_CODE"), name: SlotName, value: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/), sourceRef: EvidencePointer }),
]);
export type ProtectedSlot = z.infer<typeof ProtectedSlot>;

export const SpeechSegment = z.discriminatedUnion("kind", [
  /**
   * Approved template: `text` is the template's exact approved wording with `{slotName}`
   * placeholders (the voice template catalog's syntax), and the renderer fills each placeholder from
   * the typed protected slot of that name with its deterministic readout. Protected values therefore
   * come only from `slotNames`; the placeholders and `slotNames` are the same set.
   */
  z.strictObject({
    kind: z.literal("TEMPLATE_EXACT"),
    templateId: TemplateId,
    templateVersion: VersionLabel,
    text: z.string().min(1).max(600),
    slotNames: z.array(SlotName).max(16),
  }),
  /** Bounded grounded paraphrase for low-risk explanation only; every claim cites an allowed source. */
  z.strictObject({
    kind: z.literal("BOUNDED_PARAPHRASE"),
    paraphrasePolicyId: TemplateId,
    text: z.string().min(1).max(400),
    maxChars: z.number().int().min(1).max(400),
    allowedSourceRefs: z.array(EvidencePointer).min(1).max(8),
  }),
  /** Pre-rendered, licensed, versioned clip from the signed clip manifest. */
  z.strictObject({ kind: z.literal("FALLBACK_CLIP"), clipRef: ClipRef, clipManifestDigest: Sha256Hex }),
]);
export type SpeechSegment = z.infer<typeof SpeechSegment>;

const PLACEHOLDER = /\{([a-z][a-zA-Z0-9]{0,40})\}/g;

/** Placeholder names of a template text, and whether a brace is left over outside a placeholder. */
export function templatePlaceholders(text: string): { names: string[]; strayBrace: boolean } {
  const names = [...text.matchAll(PLACEHOLDER)].map((m) => m[1] as string);
  return { names, strayBrace: /[{}]/.test(text.replace(PLACEHOLDER, "")) };
}

/**
 * Spelled cardinal numbers per plan language (the platform's template locales, en and es). The
 * articles and pronouns `one`, `un`, `uno` and `una` are left out because approved wording uses
 * them as words ("One of them is ...", "una solicitud"); a template locale added to the catalog must
 * add its list here.
 */
const NUMBER_WORDS: Readonly<Record<string, ReadonlySet<string>>> = {
  en: new Set([
    "zero", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
    "seventeen", "eighteen", "nineteen", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety", "hundred", "thousand", "million", "billion",
  ]),
  es: new Set([
    "cero", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve", "diez", "once", "doce", "trece", "catorce", "quince", "dieciséis", "dieciseis",
    "diecisiete", "dieciocho", "diecinueve", "veinte", "veintiuno", "veintiún", "veintidós", "veintidos", "veintitrés", "veintitres", "veinticuatro", "veinticinco",
    "veintiséis", "veintiseis", "veintisiete", "veintiocho", "veintinueve", "treinta", "cuarenta", "cincuenta", "sesenta", "setenta", "ochenta", "noventa", "cien",
    "ciento", "cientos", "doscientos", "trescientos", "cuatrocientos", "quinientos", "seiscientos", "setecientos", "ochocientos", "novecientos", "mil", "millón",
    "millon", "millones",
  ]),
};

/**
 * True when the literal wording of a template (placeholders removed) states a value itself: a
 * digit, a currency symbol or a spelled number of the plan's language. Protected-fact classes must
 * take every such value from a typed trusted slot, never from fixed or generated text (ACT-05).
 */
export function literalStatesValue(text: string, language: string): boolean {
  const literal = text.replace(PLACEHOLDER, " ");
  if (/\p{Nd}|\p{Sc}/u.test(literal)) return true;
  const words = NUMBER_WORDS[language.slice(0, 2)];
  if (!words) return false;
  return literal
    .toLowerCase()
    .split(/[^\p{L}]+/u)
    .some((w) => words.has(w));
}

/** Renderers that turn plan text into audio (template or paraphrase segments). */
const SPEECH_RENDERERS: readonly SpeechRenderer[] = ["controlled_tts", "native_buffer_checked"];

/**
 * Gateway-issued plan for one utterance (FO-04-31). Carries the utterance class, exact text or
 * bounded paraphrase, typed protected slots, source and receipt refs, the policy/auth/context
 * versions, session generation, turn, expiry and the output-decision digest the release guard
 * verifies before rendering and again before emission.
 */
export const SpeechPlan = z
  .strictObject({
    ...envelope(SPEECH_PLAN_SCHEMA_VERSION, ["tenantId", "interactionId", "sessionGeneration", "turnId", "requestId", "occurredAt", "expiresAt"], ["causationId"]),
    planId: opaqueIdWithPrefix("spl"),
    turnRevision: z.number().int().min(0).max(10_000),
    utteranceClass: ResponseClass,
    route: SpeechRoute,
    language: LanguageTag,
    segments: z.array(SpeechSegment).min(1).max(16),
    protectedSlots: z.array(ProtectedSlot).max(16),
    /** Policy decision authorizing a protected disclosure; null only for classes that need none. */
    authorizationRef: OpaqueId.nullable(),
    sourceRefs: z.array(EvidencePointer).max(16),
    receiptRefs: z.array(OpaqueId).max(16),
    versions: z.strictObject({
      policyVersion: VersionLabel,
      configVersion: VersionLabel,
      templateCatalogDigest: Sha256Hex,
      voice: VersionLabel,
      /** ContextSnapshot the facts came from, and its revision; null when no protected context was used. */
      contextSnapshotRef: OpaqueId.nullable(),
      contextRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
    }),
    allowedRenderers: z.array(SpeechRenderer).min(1).max(3),
    dataClassification: Classification,
    /** sha256 over the canonical plan without this field (digests.ts computeSpeechPlanDigest). */
    outputDecisionDigest: Sha256Hex,
  })
  .superRefine((p, ctx) => {
    const cls = p.utteranceClass;
    const factProtected = (FACT_PROTECTED_CLASSES as readonly string[]).includes(cls);
    const fixedWording = (FIXED_WORDING_CLASSES as readonly string[]).includes(cls);
    const nativeEligible = (NATIVE_ELIGIBLE_CLASSES as readonly string[]).includes(cls);
    if (!isAfter(p.expiresAt, p.occurredAt)) ctx.addIssue({ code: "custom", message: "PLAN_EXPIRY_NOT_AFTER_ISSUE", path: ["expiresAt"] });
    if (p.route === "NATIVE_ALLOWED" && !nativeEligible) ctx.addIssue({ code: "custom", message: "PROTECTED_CLASS_NOT_NATIVE", path: ["route"] });
    if (p.allowedRenderers.includes("native_buffer_checked") && p.route !== "NATIVE_ALLOWED") {
      ctx.addIssue({ code: "custom", message: "NATIVE_RENDERER_ON_CONTROLLED_ROUTE", path: ["allowedRenderers"] });
    }
    if ((factProtected || fixedWording) && p.segments.some((s) => s.kind === "BOUNDED_PARAPHRASE")) {
      ctx.addIssue({ code: "custom", message: "PARAPHRASE_FOR_PROTECTED_CLASS", path: ["segments"] });
    }
    if (factProtected && p.authorizationRef === null) ctx.addIssue({ code: "custom", message: "PROTECTED_FACT_WITHOUT_AUTHORIZATION", path: ["authorizationRef"] });
    if (factProtected && p.sourceRefs.length + p.receiptRefs.length === 0) ctx.addIssue({ code: "custom", message: "PROTECTED_FACT_WITHOUT_SOURCE", path: ["sourceRefs"] });
    if (cls === "COMMITMENT" && p.receiptRefs.length === 0) ctx.addIssue({ code: "custom", message: "COMMITMENT_WITHOUT_RECEIPT", path: ["receiptRefs"] });
    const names = new Set(p.protectedSlots.map((s) => s.name));
    if (names.size !== p.protectedSlots.length) ctx.addIssue({ code: "custom", message: "DUPLICATE_SLOT", path: ["protectedSlots"] });
    const used = new Set<string>();
    p.segments.forEach((s, i) => {
      if (s.kind === "TEMPLATE_EXACT") {
        for (const n of s.slotNames) {
          used.add(n);
          if (!names.has(n)) ctx.addIssue({ code: "custom", message: "UNDECLARED_SLOT", path: ["segments", i, "slotNames"] });
        }
        const placeholders = templatePlaceholders(s.text);
        const sameSet = new Set(placeholders.names).size === new Set(s.slotNames).size && placeholders.names.every((n) => s.slotNames.includes(n));
        if (placeholders.strayBrace || !sameSet || new Set(s.slotNames).size !== s.slotNames.length) {
          ctx.addIssue({ code: "custom", message: "TEMPLATE_PLACEHOLDER_MISMATCH", path: ["segments", i, "text"] });
        }
        if (factProtected && literalStatesValue(s.text, p.language)) ctx.addIssue({ code: "custom", message: "PROTECTED_VALUE_OUTSIDE_SLOT", path: ["segments", i, "text"] });
      }
      if (s.kind === "BOUNDED_PARAPHRASE" && s.text.length > s.maxChars) ctx.addIssue({ code: "custom", message: "PARAPHRASE_TOO_LONG", path: ["segments", i, "text"] });
    });
    p.protectedSlots.forEach((slot, i) => {
      if (!used.has(slot.name)) ctx.addIssue({ code: "custom", message: "UNUSED_PROTECTED_SLOT", path: ["protectedSlots", i, "name"] });
    });
    // The plan's renderers must be able to render its content: spoken segments need a speech
    // renderer and clip segments need the clip renderer (pre-emission check 3, permitted path).
    if (p.segments.some((s) => s.kind !== "FALLBACK_CLIP") && !p.allowedRenderers.some((r) => SPEECH_RENDERERS.includes(r))) {
      ctx.addIssue({ code: "custom", message: "SPOKEN_SEGMENT_WITHOUT_SPEECH_RENDERER", path: ["allowedRenderers"] });
    }
    if (p.segments.some((s) => s.kind === "FALLBACK_CLIP") && !p.allowedRenderers.includes("fallback_clip")) {
      ctx.addIssue({ code: "custom", message: "CLIP_SEGMENT_WITHOUT_CLIP_RENDERER", path: ["allowedRenderers"] });
    }
    if (p.dataClassification === "VERIFICATION_SECRET") ctx.addIssue({ code: "custom", message: "PLAN_HOLDS_VERIFICATION_SECRET", path: ["dataClassification"] });
  });
export type SpeechPlan = z.infer<typeof SpeechPlan>;

/* ------------------------------------------------------------------------ */
/* AudioReleaseReceipt                                                       */
/* ------------------------------------------------------------------------ */

/** Checks the release guard performs at enqueue and again at emission (pre-emission check 4). */
export const ReleaseCheck = z.strictObject({
  generationCurrent: z.boolean(),
  turnCurrent: z.boolean(),
  notCancelled: z.boolean(),
  notExpired: z.boolean(),
  notRevoked: z.boolean(),
  digestVerified: z.boolean(),
  fencingTokenCurrent: z.boolean(),
  checkedAt: IsoDateTime,
});
export type ReleaseCheck = z.infer<typeof ReleaseCheck>;

export const releaseCheckPassed = (c: ReleaseCheck): boolean =>
  c.generationCurrent && c.turnCurrent && c.notCancelled && c.notExpired && c.notRevoked && c.digestVerified && c.fencingTokenCurrent;

export const AudioReleaseStatus = z.enum([
  "EMITTED_COMPLETE",
  "EMITTED_PARTIAL_INTERRUPTED",
  "PLAYBACK_UNCONFIRMED",
  "NOT_EMITTED_REJECTED",
  "NOT_EMITTED_CANCELLED",
  "NOT_EMITTED_EXPIRED",
]);
export type AudioReleaseStatus = z.infer<typeof AudioReleaseStatus>;

const EMITTED: readonly AudioReleaseStatus[] = ["EMITTED_COMPLETE", "EMITTED_PARTIAL_INTERRUPTED", "PLAYBACK_UNCONFIRMED"];

/**
 * What the release guard actually let reach the caller (pre-emission check 5): approved content
 * and audio digests plus the real playback status. A receipt that claims emission must show both
 * checks passed; it can never record audio that escaped a failing check (ACT-05).
 */
export const AudioReleaseReceipt = z
  .strictObject({
    ...envelope(AUDIO_RELEASE_RECEIPT_SCHEMA_VERSION, ["tenantId", "interactionId", "sessionGeneration", "turnId", "occurredAt"], ["causationId"]),
    receiptId: opaqueIdWithPrefix("arr"),
    /**
     * What the audio was: a plan rendered by a speech renderer, or a clip from the signed clip
     * manifest (standing in for `planId` when the plan allowed its fallback, else null). Clip audio
     * is always recorded as a clip, so a receipt never attributes clip audio to a plan's wording.
     */
    source: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("speech_plan"), planId: OpaqueId, outputDecisionDigest: Sha256Hex }),
      z.strictObject({ kind: z.literal("fallback_clip"), clipRef: ClipRef, clipManifestDigest: Sha256Hex, planId: OpaqueId.nullable() }),
    ]),
    renderer: SpeechRenderer,
    approvedContentDigest: Sha256Hex,
    renderedAudioDigest: Sha256Hex.nullable(),
    enqueueCheck: ReleaseCheck,
    emissionCheck: ReleaseCheck.nullable(),
    status: AudioReleaseStatus,
    rejectionReason: ReasonCode.nullable(),
    playback: z
      .strictObject({
        firstFrameAt: IsoDateTime,
        lastFrameAt: IsoDateTime,
        emittedMs: z.number().int().min(0).max(3_600_000),
        framesEmitted: z.number().int().min(0).max(10_000_000),
        interruptedAt: IsoDateTime.nullable(),
      })
      .nullable(),
  })
  .superRefine((r, ctx) => {
    const emitted = EMITTED.includes(r.status);
    if (emitted) {
      if (!releaseCheckPassed(r.enqueueCheck)) ctx.addIssue({ code: "custom", message: "EMITTED_AFTER_FAILED_ENQUEUE_CHECK", path: ["enqueueCheck"] });
      if (r.emissionCheck === null || !releaseCheckPassed(r.emissionCheck)) ctx.addIssue({ code: "custom", message: "EMITTED_WITHOUT_PASSING_EMISSION_CHECK", path: ["emissionCheck"] });
      if (r.playback === null) ctx.addIssue({ code: "custom", message: "EMITTED_WITHOUT_PLAYBACK", path: ["playback"] });
      if (r.renderedAudioDigest === null) ctx.addIssue({ code: "custom", message: "EMITTED_WITHOUT_AUDIO_DIGEST", path: ["renderedAudioDigest"] });
      if (r.rejectionReason !== null) ctx.addIssue({ code: "custom", message: "EMITTED_WITH_REJECTION", path: ["rejectionReason"] });
    } else if (r.playback !== null) {
      ctx.addIssue({ code: "custom", message: "NOT_EMITTED_WITH_PLAYBACK", path: ["playback"] });
    }
    if (r.status === "NOT_EMITTED_REJECTED" && r.rejectionReason === null) ctx.addIssue({ code: "custom", message: "REJECTION_WITHOUT_REASON", path: ["rejectionReason"] });
    if (r.status === "EMITTED_PARTIAL_INTERRUPTED" && r.playback?.interruptedAt == null) {
      ctx.addIssue({ code: "custom", message: "INTERRUPTION_WITHOUT_TIME", path: ["playback", "interruptedAt"] });
    }
    if (r.source.kind === "fallback_clip" && r.renderer !== "fallback_clip") ctx.addIssue({ code: "custom", message: "CLIP_RENDERER_MISMATCH", path: ["renderer"] });
    if (r.source.kind === "speech_plan" && r.renderer === "fallback_clip") ctx.addIssue({ code: "custom", message: "PLAN_RENDERED_AS_CLIP", path: ["renderer"] });
    if (r.playback && Date.parse(r.playback.lastFrameAt) < Date.parse(r.playback.firstFrameAt)) {
      ctx.addIssue({ code: "custom", message: "LAST_FRAME_BEFORE_FIRST", path: ["playback", "lastFrameAt"] });
    }
  });
export type AudioReleaseReceipt = z.infer<typeof AudioReleaseReceipt>;

/**
 * Cross-check of a receipt against the plan it names (release guard and audit verification): same
 * tenant, interaction, session generation and turn; a plan-sourced receipt carries the plan's
 * output-decision digest and a renderer the plan allowed; a clip standing in for a plan is allowed
 * only when the plan allowed the clip renderer, and when the plan lists clip segments it must be one
 * of them with the same manifest digest; audio emitted after the plan expired is refused. Returns
 * the issue codes; an empty list means the receipt is consistent with the plan.
 */
export function receiptPlanIssues(receipt: AudioReleaseReceipt, plan: SpeechPlan): string[] {
  const out: string[] = [];
  const planId = receipt.source.planId;
  if (planId !== plan.planId) return ["RECEIPT_FOR_OTHER_PLAN"];
  if (receipt.tenantId !== plan.tenantId) out.push("RECEIPT_TENANT_MISMATCH");
  if (receipt.interactionId !== plan.interactionId) out.push("RECEIPT_INTERACTION_MISMATCH");
  if (receipt.sessionGeneration !== plan.sessionGeneration) out.push("RECEIPT_GENERATION_MISMATCH");
  if (receipt.turnId !== plan.turnId) out.push("RECEIPT_TURN_MISMATCH");
  if (!plan.allowedRenderers.includes(receipt.renderer)) out.push("RENDERER_NOT_ALLOWED_BY_PLAN");
  if (receipt.source.kind === "speech_plan" && receipt.source.outputDecisionDigest !== plan.outputDecisionDigest) out.push("RECEIPT_PLAN_DIGEST_MISMATCH");
  if (receipt.source.kind === "fallback_clip") {
    const clips = plan.segments.filter((s): s is Extract<SpeechSegment, { kind: "FALLBACK_CLIP" }> => s.kind === "FALLBACK_CLIP");
    const { clipRef, clipManifestDigest } = receipt.source;
    if (clips.length > 0 && !clips.some((c) => c.clipRef === clipRef && c.clipManifestDigest === clipManifestDigest)) out.push("CLIP_NOT_IN_PLAN");
  }
  if (receipt.playback !== null && Date.parse(receipt.playback.firstFrameAt) >= Date.parse(plan.expiresAt)) out.push("EMITTED_AFTER_PLAN_EXPIRY");
  return out;
}
