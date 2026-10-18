/**
 * Safety module: multi-signal safety detection, clinical-boundary detection,
 * deterministic routing, the conversation guard (limits that never terminate a
 * safety flow) and content-free safety evidence. See README.md for what is a
 * LOCAL FIXTURE and what is BLOCKED.
 */
export * from "./ports.js";
export {
  CompositeSafetySignalDetector,
  DEFAULT_ASR_CONFIDENCE_THRESHOLD,
  LOCALE_RE,
  LocalHeuristicSemanticDetector,
  RULE_ID_RE,
  RuleBasedSafetySignalDetector,
  SUPPORTED_SAFETY_LANGUAGES,
  SafetySignalSchema,
  SafetySignalSourceSchema,
  canonicalLocale,
  dedupeSignals,
  failSafeSignal,
  humanInterventionSignal,
  isSupportedSafetyLocale,
  safetyDetectorDeploymentViolations,
} from "./detector.js";
export type {
  CompositeDetectorOptions,
  DetectionCoverage,
  RuleBasedDetectorOptions,
  SafetyAnalysis,
  SemanticDetectionInput,
  SemanticSignalDetector,
} from "./detector.js";
export {
  CLINICAL_BOUNDARY_CATEGORIES,
  CLINICAL_BOUNDARY_TEMPLATE_ID,
  CLINICAL_ROUTE_DESTINATION_ID,
  CLINICAL_RULE_IDS,
  RuleBasedClinicalBoundaryDetector,
} from "./clinical-boundary.js";
export type { ClinicalBoundaryCategory, ClinicalBoundaryDetector, ClinicalBoundaryFinding } from "./clinical-boundary.js";
export {
  DeterministicSafetyRouter,
  InMemorySafetyModeStoreFixture,
  SAFETY_ACKNOWLEDGMENT_TEMPLATE_ID,
  SAFETY_PRIORITY_DESTINATION_ID,
  SAFETY_RISK_FLAG,
  StickySafetyRouter,
  safetyModeFromRiskFlags,
} from "./router.js";
export type { SafetyModeStore, SafetyRoutingContext, SafetyRoutingDecision, SafetyRoutingInput } from "./router.js";
export {
  ConversationGuard,
  DEFAULT_GUARD_LIMITS,
  GUARD_ACTION_KINDS,
  GUARD_DESTINATIONS,
  GUARD_TEMPLATES,
  GuardEventSchema,
  GuardLimitsSchema,
  decide,
  initialGuardState,
} from "./conversation-guard.js";
export type { ConversationGuardOptions, GuardAction, GuardActionKind, GuardDecision, GuardEvent, GuardLimits, GuardState, SafetyRouteStep } from "./conversation-guard.js";
export { SAFETY_ROUTE_TARGET_MS, SafetyEventRecorder } from "./safety-events.js";
export type {
  RouteInitiationResult,
  SafetyEventPhase,
  SafetyEventRecorderOptions,
  SafetyIncident,
  SafetyIncidentInput,
  SafetyRecordResult,
  SafetyRouteOutcome,
} from "./safety-events.js";
export { SafetyPipeline } from "./pipeline.js";
export type { SafetyEvaluation } from "./pipeline.js";
export { ALL_RULE_IDS, DETECTOR_RULE_IDS, LEXICON_APPROVAL_STATUS, LEXICON_VERSION } from "./lexicon.js";
