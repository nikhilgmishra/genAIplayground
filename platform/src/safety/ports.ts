/**
 * Administrative support with a safety escape route (spec section 10).
 * Detection is multi-signal and never claimed complete; deterministic policy
 * selects the response and the route after any signal. No diagnosis,
 * screening, severity scoring or inference of mental state from voice.
 */
import type { RiskFlag, TransferReason } from "../protocol/index.js";

/**
 * FAIL_SAFE: raised by the system itself because an input could not be assessed (malformed or
 * oversize input, a malformed signal, a failed detection stage). It is always UNRESOLVED and
 * always routes to the safety human (fail safe; never silently ignored). It is distinct from
 * ASR_UNCERTAIN (recognizer uncertainty) so dashboards and handoff packages can tell them apart.
 */
export type SafetySignalSource = "EXPLICIT_PHRASE" | "SEMANTIC_SIGNAL" | "ASR_UNCERTAIN" | "CALLER_REQUEST" | "HUMAN_INTERVENTION" | "FAIL_SAFE";

export interface SafetySignal {
  source: SafetySignalSource;
  /** Stable rule id that fired (for audit); never the caller's words. */
  ruleId: string;
  /** Credible = act now; unresolved = ambiguous but still routed to a human. */
  strength: "CREDIBLE" | "UNRESOLVED";
  subject: "SELF" | "THIRD_PARTY" | "UNKNOWN";
  temporal: "CURRENT" | "HISTORICAL" | "UNKNOWN";
  negated: boolean;
  locale: string;
}

export interface SafetyDetectionInput {
  text: string;
  locale: string;
  asrConfidence: number | null;
}

export interface SafetySignalDetector {
  detect(input: SafetyDetectionInput): SafetySignal[];
}

export type SafetyRoute = "NONE" | "SAFETY_PRIORITY_HUMAN" | "CLINICAL_BOUNDARY_ROUTE";

export interface SafetyDecision {
  route: SafetyRoute;
  /** Clinician-approved fixed acknowledgment template id (never model-generated text). */
  acknowledgmentTemplateId: string | null;
  /** Revoke pending nonessential mutations and stop administrative troubleshooting. */
  revokePendingActions: boolean;
  /** Authentication, account ownership and payment are never required for this route (SAFE-02). */
  requiresAuthentication: false;
  destinationId: string | null;
  reasonCode: string;
  /**
   * Optional extended fields (all set by DeterministicSafetyRouter; absent from older callers'
   * decisions). Callers must persist safety mode for the rest of the call when entered.
   */
  enterSafetyMode?: boolean;
  /** Session risk flag to set (SAFETY_ESCALATION_ACTIVE) when safety mode is entered; null otherwise. */
  riskFlagToSet?: RiskFlag | null;
  /** Unsupported locale: add the interpreter accommodation to the handoff. */
  interpreterRequired?: boolean;
  /** Transfer reason for the handoff (SAFETY_PRIORITY / CLINICAL_QUESTION); null when no transfer. */
  transferReason?: TransferReason | null;
  /** Never automated: a human safety responder owns any external emergency coordination. */
  externalEmergencyConferencing?: "NOT_AUTOMATED_HUMAN_OWNED";
}

export interface SafetyRouter {
  decide(signals: SafetySignal[], context: { locale: string; afterHours: boolean; safetyModeActive: boolean }): SafetyDecision;
}
