/**
 * Recording and processing consent gate helpers (spec section 6, DATA-03).
 *
 *  - Recording and automated processing start only from an approved consent
 *    state. UNKNOWN is never consent; NOT_REQUIRED counts only when an APPROVED
 *    jurisdiction rule says consent is not required for that activity.
 *  - Unapproved processors never run.
 *  - A caller who declines recording is offered the approved alternative; when
 *    no approved alternative is configured the safe default is the human route.
 *  - The selected disclosure describes what is ACTUALLY running: the
 *    "not recorded" disclosure is never selected while any recorder,
 *    transcription, model processing or transcript retention continues.
 *
 * This module does not contain jurisdiction law or disclosure wording. Rules
 * come from configuration with an approval id (privacy counsel); disclosure
 * template ids are returned for the voice template registry, whose text is
 * BLOCKED pending jurisdiction approval (PRQ-028). Without an approved rule the
 * strictest behaviour applies (explicit GRANTED required).
 */
import { z } from "zod";
import { ConsentState } from "../protocol/index.js";
import type { ConsentValue } from "../protocol/index.js";
import { ValidationError } from "../shared/errors.js";

export const ProcessorKind = z.enum([
  "CALL_RECORDING",
  "QA_RECORDING",
  "LIVE_TRANSCRIPTION",
  "TRANSCRIPT_RETENTION",
  "MODEL_PROCESSING",
  "SPEECH_SYNTHESIS",
  "ANALYTICS",
]);
export type ProcessorKind = z.infer<typeof ProcessorKind>;

export const ActiveProcessor = z.strictObject({
  processorId: z.string().regex(/^[a-z][a-z0-9_-]{2,63}$/),
  kind: ProcessorKind,
  /** Processor approved for this environment (BAA/coverage and privacy approval recorded elsewhere). */
  approved: z.boolean(),
});
export type ActiveProcessor = z.infer<typeof ActiveProcessor>;

export const ConsentAlternative = z.enum(["CONTINUE_WITHOUT_RECORDING", "HUMAN_ROUTE", "CALLBACK"]);
export type ConsentAlternative = z.infer<typeof ConsentAlternative>;

/** Jurisdiction rule supplied by approved configuration. Never hard-coded here. */
export const JurisdictionConsentRule = z.strictObject({
  jurisdiction: z.string().regex(/^[A-Z]{2}(-[A-Z0-9]{1,3})?$/),
  recordingConsentRequired: z.enum(["REQUIRED", "NOT_REQUIRED", "UNKNOWN"]),
  processingConsentRequired: z.enum(["REQUIRED", "NOT_REQUIRED", "UNKNOWN"]),
  /** Approved alternative when recording is declined. */
  recordingDeclinedAlternative: ConsentAlternative.nullable(),
  approvalId: z.string().regex(/^apr_[A-Za-z0-9_-]{8,64}$/).nullable(),
});
export type JurisdictionConsentRule = z.infer<typeof JurisdictionConsentRule>;

/** Captures sound or words of the caller (anything that makes "unrecorded" false). */
export const CAPTURE_KINDS: ReadonlySet<ProcessorKind> = new Set(["CALL_RECORDING", "QA_RECORDING", "LIVE_TRANSCRIPTION", "TRANSCRIPT_RETENTION", "MODEL_PROCESSING"]);
const RECORDING_KINDS: ReadonlySet<ProcessorKind> = new Set(["CALL_RECORDING", "QA_RECORDING"]);

export const DISCLOSURE_TEMPLATE_IDS = {
  CONSENT_REQUEST: "disclosure.consent_request",
  RECORDED_AND_PROCESSED: "disclosure.recorded_and_processed",
  RECORDED_ONLY: "disclosure.recorded_only",
  PROCESSED_NOT_RECORDED: "disclosure.processed_not_recorded",
  NOT_RECORDED_NOT_PROCESSED: "disclosure.not_recorded_not_processed",
  PROCESSING_DECLINED_ALTERNATIVE: "disclosure.processing_declined_alternative",
} as const;
export type DisclosureTemplateId = (typeof DISCLOSURE_TEMPLATE_IDS)[keyof typeof DISCLOSURE_TEMPLATE_IDS];

export interface ActivityDecision {
  allowed: boolean;
  reasonCode: string;
}

function ruleIsApproved(rule: JurisdictionConsentRule | null): rule is JurisdictionConsentRule {
  return rule !== null && rule.approvalId !== null;
}

function activityAllowed(value: ConsentValue, requirement: "REQUIRED" | "NOT_REQUIRED" | "UNKNOWN", approved: boolean, prefix: string): ActivityDecision {
  if (value === "GRANTED") return { allowed: true, reasonCode: `${prefix}_CONSENT_GRANTED` };
  if (value === "DECLINED") return { allowed: false, reasonCode: `${prefix}_CONSENT_DECLINED` };
  if (value === "NOT_REQUIRED") {
    return approved && requirement === "NOT_REQUIRED"
      ? { allowed: true, reasonCode: `${prefix}_CONSENT_NOT_REQUIRED_APPROVED_RULE` }
      : { allowed: false, reasonCode: `${prefix}_NOT_REQUIRED_WITHOUT_APPROVED_RULE` };
  }
  return { allowed: false, reasonCode: `${prefix}_CONSENT_UNKNOWN` };
}

export function evaluateRecording(consent: ConsentState, rule: JurisdictionConsentRule | null): ActivityDecision {
  const c = ConsentState.parse(consent);
  const approved = ruleIsApproved(rule);
  return activityAllowed(c.recording, approved ? rule.recordingConsentRequired : "UNKNOWN", approved, "RECORDING");
}

export function evaluateProcessing(consent: ConsentState, rule: JurisdictionConsentRule | null): ActivityDecision {
  const c = ConsentState.parse(consent);
  const approved = ruleIsApproved(rule);
  return activityAllowed(c.automatedProcessing, approved ? rule.processingConsentRequired : "UNKNOWN", approved, "PROCESSING");
}

export interface ProcessorGate {
  allowed: ActiveProcessor[];
  blocked: { processorId: string; kind: ProcessorKind; reasonCode: string }[];
}

/**
 * Which processors may run. Recorders need recording consent; transcription,
 * model processing, synthesis and analytics need processing consent; transcript
 * retention needs both (conservative engineering default pending counsel).
 */
export function gateProcessors(consent: ConsentState, rule: JurisdictionConsentRule | null, processors: readonly ActiveProcessor[]): ProcessorGate {
  const recording = evaluateRecording(consent, rule);
  const processing = evaluateProcessing(consent, rule);
  const out: ProcessorGate = { allowed: [], blocked: [] };
  for (const raw of processors) {
    const p = ActiveProcessor.parse(raw);
    let reason: string | null = null;
    if (!p.approved) reason = "PROCESSOR_NOT_APPROVED";
    else if (RECORDING_KINDS.has(p.kind) && !recording.allowed) reason = recording.reasonCode;
    else if (p.kind === "TRANSCRIPT_RETENTION" && (!recording.allowed || !processing.allowed)) reason = !recording.allowed ? recording.reasonCode : processing.reasonCode;
    else if (!RECORDING_KINDS.has(p.kind) && !processing.allowed) reason = processing.reasonCode;
    if (reason) out.blocked.push({ processorId: p.processorId, kind: p.kind, reasonCode: reason });
    else out.allowed.push(p);
  }
  return out;
}

export type ConsentRoute = "ASK_CONSENT" | "CONTINUE_AUTOMATED" | "CONTINUE_WITHOUT_RECORDING" | "APPROVED_ALTERNATIVE_HUMAN" | "APPROVED_ALTERNATIVE_CALLBACK";

export interface DisclosureSelection {
  templateId: DisclosureTemplateId;
  route: ConsentRoute;
  /** Processors that are active but must be stopped because consent does not cover them. */
  mustStop: string[];
  recordingActive: boolean;
  captureActive: boolean;
  reasonCodes: string[];
  /** Template text needs jurisdiction approval in the voice registry; never rendered from here. */
  requiresApprovedTemplate: true;
}

/**
 * Selects the disclosure that truthfully describes the processors that will run
 * after consent gating, plus the route for the caller.
 */
export function selectDisclosure(input: {
  consent: ConsentState;
  rule: JurisdictionConsentRule | null;
  activeProcessors: readonly ActiveProcessor[];
}): DisclosureSelection {
  const consent = ConsentState.parse(input.consent);
  const rule = input.rule === null ? null : JurisdictionConsentRule.parse(input.rule);
  const reasons: string[] = [];
  if (!ruleIsApproved(rule)) reasons.push("CONSENT_RULE_UNAPPROVED_STRICTEST_APPLIED");
  const gate = gateProcessors(consent, rule, input.activeProcessors);
  const remaining = gate.allowed;
  const recordingActive = remaining.some((p) => RECORDING_KINDS.has(p.kind));
  const captureActive = remaining.some((p) => CAPTURE_KINDS.has(p.kind));
  const processingActive = remaining.some((p) => CAPTURE_KINDS.has(p.kind) && !RECORDING_KINDS.has(p.kind));
  const mustStop = gate.blocked.map((b) => b.processorId);
  for (const b of gate.blocked) reasons.push(b.reasonCode);

  const base = { mustStop, recordingActive, captureActive, requiresApprovedTemplate: true as const };
  const dedupe = () => [...new Set(reasons)];

  // Consent not yet captured: ask before recording/processing begins.
  if (consent.recording === "UNKNOWN" || consent.automatedProcessing === "UNKNOWN") {
    return { ...base, templateId: DISCLOSURE_TEMPLATE_IDS.CONSENT_REQUEST, route: "ASK_CONSENT", reasonCodes: dedupe() };
  }
  const processing = evaluateProcessing(consent, rule);
  if (!processing.allowed) {
    // Automated processing declined: the approved alternative is a person.
    return { ...base, templateId: DISCLOSURE_TEMPLATE_IDS.PROCESSING_DECLINED_ALTERNATIVE, route: "APPROVED_ALTERNATIVE_HUMAN", reasonCodes: dedupe() };
  }
  const recording = evaluateRecording(consent, rule);
  let route: ConsentRoute = "CONTINUE_AUTOMATED";
  if (!recording.allowed) {
    const alt = ruleIsApproved(rule) ? rule.recordingDeclinedAlternative : null;
    if (alt === "CONTINUE_WITHOUT_RECORDING") route = "CONTINUE_WITHOUT_RECORDING";
    else if (alt === "CALLBACK") route = "APPROVED_ALTERNATIVE_CALLBACK";
    else {
      route = "APPROVED_ALTERNATIVE_HUMAN";
      if (alt === null) reasons.push("RECORDING_DECLINED_NO_APPROVED_ALTERNATIVE_HUMAN_ROUTE");
    }
  }
  let templateId: DisclosureTemplateId;
  if (recordingActive && processingActive) templateId = DISCLOSURE_TEMPLATE_IDS.RECORDED_AND_PROCESSED;
  else if (recordingActive) templateId = DISCLOSURE_TEMPLATE_IDS.RECORDED_ONLY;
  else if (captureActive) templateId = DISCLOSURE_TEMPLATE_IDS.PROCESSED_NOT_RECORDED;
  else templateId = DISCLOSURE_TEMPLATE_IDS.NOT_RECORDED_NOT_PROCESSED;
  assertTruthfulDisclosure(templateId, remaining);
  return { ...base, templateId, route, reasonCodes: dedupe() };
}

/**
 * Throws when a disclosure would claim the call is unrecorded / unprocessed
 * while a capture processor runs, or claim recording that is not happening.
 */
export function assertTruthfulDisclosure(templateId: DisclosureTemplateId, running: readonly ActiveProcessor[]): void {
  const capture = running.some((p) => CAPTURE_KINDS.has(p.kind));
  const recording = running.some((p) => RECORDING_KINDS.has(p.kind));
  if (templateId === DISCLOSURE_TEMPLATE_IDS.NOT_RECORDED_NOT_PROCESSED && capture) throw new ValidationError("DISCLOSURE_FALSE_UNRECORDED_CLAIM");
  if (templateId === DISCLOSURE_TEMPLATE_IDS.PROCESSED_NOT_RECORDED && recording) throw new ValidationError("DISCLOSURE_FALSE_UNRECORDED_CLAIM");
  if ((templateId === DISCLOSURE_TEMPLATE_IDS.RECORDED_ONLY || templateId === DISCLOSURE_TEMPLATE_IDS.RECORDED_AND_PROCESSED) && !recording) {
    throw new ValidationError("DISCLOSURE_CLAIMS_RECORDING_NOT_ACTIVE");
  }
}
