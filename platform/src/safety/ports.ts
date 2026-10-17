/**
 * Administrative support with a safety escape route (spec section 10).
 * Detection is multi-signal and never claimed complete; deterministic policy
 * selects the response and the route after any signal. No diagnosis,
 * screening, severity scoring or inference of mental state from voice.
 */
export type SafetySignalSource = "EXPLICIT_PHRASE" | "SEMANTIC_SIGNAL" | "ASR_UNCERTAIN" | "CALLER_REQUEST" | "HUMAN_INTERVENTION";

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
}

export interface SafetyRouter {
  decide(signals: SafetySignal[], context: { locale: string; afterHours: boolean; safetyModeActive: boolean }): SafetyDecision;
}
