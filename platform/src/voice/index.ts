/**
 * Voice response layer: approved template catalog, before-speech response
 * gate, turn/generation tracking and the speech segment queue. See README.md
 * for what is a LOCAL FIXTURE and what is BLOCKED.
 */
export * from "./ports.js";
export {
  APPROVAL_ID_RE,
  ApprovalStatus,
  CLINICAL_REVIEW_MARKER,
  CatalogTemplateRegistry,
  LEGAL_REVIEW_MARKER,
  MAX_SAFETY_TEMPLATE_TEXT_CHARS,
  MAX_TEMPLATE_TEXT_CHARS,
  PROHIBITED_CLINICAL_CONTENT,
  REQUIRED_PRODUCTION_TEMPLATE_IDS,
  TEMPLATE_ID_RE,
  TemplateCatalogError,
  TemplateCatalogFileSchema,
  assertCatalogDeployable,
  catalogDeploymentViolations,
  containsProhibitedClinicalContent,
  hasControlCharacters,
  loadDefaultTemplateRegistry,
} from "./registry.js";
export type { CatalogTemplate, TemplateCatalogFile, TemplateMetadata, TemplateRegistryOptions } from "./registry.js";
export {
  AUTHORIZATION_EXEMPT_CLASSES,
  DEFAULT_FALLBACK_LOCALE,
  FALLBACK_TEMPLATE_ID,
  LOCAL_UNAPPROVED_BADGE,
  MAX_UTTERANCE_CHARS,
  PROTECTED_RESPONSE_CLASSES,
  SOURCE_REQUIRED_CLASSES,
  TemplateResponseGate,
  UNAPPROVED_TEMPLATES_ALLOWED_IN,
  isGateApproved,
  isGateFallback,
  postCheck,
} from "./gate.js";
export type { GateDisposition, GateRejection, GatedUtterance, ResponseRecord, TemplateResponseGateOptions } from "./gate.js";
export { InMemoryTurnTracker } from "./turns.js";
export type { InMemoryTurnTrackerOptions, TurnInvalidationListener } from "./turns.js";
export { SpeechQueue, splitSegments } from "./speech-queue.js";
export type { BargeInResult, EnqueueResult, SpeechQueueOptions, SpeechSegment } from "./speech-queue.js";
export { PERSON_DISPLAY_NAME_RE, SUPPORT_REFERENCE_RE, TIME_ZONE_NAMES, isValidCalendarDate, renderSlotValue, spellOut, validateSlotValue } from "./slots.js";
export type { CatalogSlotSpec, SlotCheck, SlotLanguage } from "./slots.js";
