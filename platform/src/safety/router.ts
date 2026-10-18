/**
 * Deterministic safety routing (spec section 10; SAFE-01, SAFE-02, SAFE-05).
 *
 * After any signal, fixed policy — not a model — selects the response and the
 * route:
 *  - any CREDIBLE or UNRESOLVED safety signal, or a call already in safety
 *    mode => SAFETY_PRIORITY_HUMAN: stop administrative troubleshooting, revoke
 *    pending nonessential mutations, play the fixed clinician-approved
 *    acknowledgment template (currently PENDING approval), and start priority
 *    human connection to the trusted destination `dst_safety_priority`;
 *  - otherwise a clinical question (diagnosis, medication, therapy, screening)
 *    => CLINICAL_BOUNDARY_ROUTE: boundary template + clinician/human route;
 *  - otherwise NONE.
 *
 * Authentication, account ownership and payment are never inputs and never
 * required (SAFE-02): the router has no access to identity state at all.
 * After hours the route is the same; unavailable responders are handled by
 * the transfer coordinator's staffed fallback chain, which never abandons a
 * SAFETY transfer. The destination is a fixed allowlisted id, never derived
 * from caller words, tool output or a model (SAFE-05).
 *
 * External crisis / emergency services are NEVER conferenced automatically
 * because a keyword fired. That decision (country and routing, operational
 * agreement, consent or emergency basis, data sharing) is owned by the human
 * safety responder under the safety lead's procedures.
 */
import type { RiskFlag, TransferReason } from "../protocol/index.js";
import { CLINICAL_BOUNDARY_CATEGORIES, CLINICAL_BOUNDARY_TEMPLATE_ID, CLINICAL_ROUTE_DESTINATION_ID } from "./clinical-boundary.js";
import type { ClinicalBoundaryCategory, ClinicalBoundaryFinding } from "./clinical-boundary.js";
import { SafetySignalSchema, canonicalLocale, failSafeSignal, isSupportedSafetyLocale } from "./detector.js";
import { DETECTOR_RULE_IDS } from "./lexicon.js";
import type { SafetyDecision, SafetyRouter, SafetySignal, SafetySignalSource } from "./ports.js";

export const SAFETY_ACKNOWLEDGMENT_TEMPLATE_ID = "safety.acknowledgment";
export const SAFETY_PRIORITY_DESTINATION_ID = "dst_safety_priority";
export const SAFETY_RISK_FLAG: RiskFlag = "SAFETY_ESCALATION_ACTIVE";

export interface SafetyRoutingContext {
  locale: string;
  afterHours: boolean;
  /** Sticky for the call. Anything other than an explicit `false` is treated as active (fail safe). */
  safetyModeActive: boolean;
}

export interface SafetyRoutingInput {
  signals: readonly unknown[];
  clinicalFindings?: readonly ClinicalBoundaryFinding[];
  context: SafetyRoutingContext;
}

export interface SafetyRoutingDecision extends SafetyDecision {
  /** Callers must persist safety mode for the rest of the call (session risk flag). */
  enterSafetyMode: boolean;
  safetyModeActive: boolean;
  riskFlagToSet: RiskFlag | null;
  /** Stop ordinary administrative troubleshooting and automation for this call. */
  suspendAdministrativeAutomation: boolean;
  transferReason: TransferReason | null;
  transferPriority: "SAFETY" | "STANDARD" | null;
  /** Unsupported locale: add the interpreter accommodation to the handoff. */
  interpreterRequired: boolean;
  afterHours: boolean;
  /** Never automated: a human safety responder owns any external emergency coordination. */
  externalEmergencyConferencing: "NOT_AUTOMATED_HUMAN_OWNED";
  strongestStrength: SafetySignal["strength"] | null;
  signalSources: SafetySignalSource[];
  ruleIds: string[];
  clinicalCategories: ClinicalBoundaryCategory[];
  /** Primary routing reason for the handoff package (spec HandoffPackage.safetyRoutingReason). */
  safetyRoutingReason: SafetySignalSource | null;
}

const SOURCE_PRECEDENCE: readonly SafetySignalSource[] = ["HUMAN_INTERVENTION", "EXPLICIT_PHRASE", "CALLER_REQUEST", "SEMANTIC_SIGNAL", "ASR_UNCERTAIN", "FAIL_SAFE"];

export function safetyModeFromRiskFlags(flags: readonly string[]): boolean {
  return flags.includes(SAFETY_RISK_FLAG);
}

function validatedSignals(raw: readonly unknown[], locale: string): { signals: SafetySignal[]; malformed: boolean } {
  const signals: SafetySignal[] = [];
  let malformed = false;
  for (const s of raw) {
    const parsed = SafetySignalSchema.safeParse(s);
    if (parsed.success) signals.push(parsed.data);
    else {
      // A malformed signal still means something tried to raise a concern: fail safe.
      malformed = true;
      signals.push(failSafeSignal(DETECTOR_RULE_IDS.signalMalformed, locale));
    }
  }
  return { signals, malformed };
}

function safetyReason(signals: readonly SafetySignal[], malformed: boolean): string {
  if (malformed) return "SAFETY_SIGNAL_MALFORMED_FAIL_SAFE";
  if (signals.some((s) => s.source === "HUMAN_INTERVENTION")) return "SAFETY_HUMAN_INTERVENTION";
  if (signals.some((s) => s.strength === "CREDIBLE")) return "SAFETY_SIGNAL_CREDIBLE";
  if (signals.some((s) => s.source === "CALLER_REQUEST")) return "SAFETY_CALLER_REQUEST";
  // Only system fail-safe signals: the input could not be assessed, so the caller still reaches a human.
  if (signals.length > 0 && signals.every((s) => s.source === "FAIL_SAFE")) return "SAFETY_INPUT_UNASSESSED_FAIL_SAFE";
  return "SAFETY_SIGNAL_UNRESOLVED";
}

export class DeterministicSafetyRouter implements SafetyRouter {
  decide(signals: SafetySignal[], context: SafetyRoutingContext): SafetyRoutingDecision {
    return this.route({ signals, context });
  }

  route(input: SafetyRoutingInput): SafetyRoutingDecision {
    const ctx = input.context as Partial<SafetyRoutingContext> | undefined;
    const locale = canonicalLocale(ctx?.locale);
    const alreadyActive = ctx?.safetyModeActive !== false;
    const afterHours = ctx?.afterHours === true;
    const interpreterRequired = !isSupportedSafetyLocale(locale);
    const rawSignals = Array.isArray(input.signals) ? input.signals : [];
    const { signals, malformed } = validatedSignals(rawSignals, locale);
    const clinical = (Array.isArray(input.clinicalFindings) ? input.clinicalFindings : []).filter((f) =>
      CLINICAL_BOUNDARY_CATEGORIES.includes(f.category),
    );
    const clinicalCategories = CLINICAL_BOUNDARY_CATEGORIES.filter((c) => clinical.some((f) => f.category === c));
    const sources = SOURCE_PRECEDENCE.filter((src) => signals.some((s) => s.source === src));
    const ruleIds = [...new Set(signals.map((s) => s.ruleId))].sort();
    const strongest: SafetySignal["strength"] | null = signals.length === 0 ? null : signals.some((s) => s.strength === "CREDIBLE") ? "CREDIBLE" : "UNRESOLVED";

    const common = {
      requiresAuthentication: false as const,
      afterHours,
      interpreterRequired,
      externalEmergencyConferencing: "NOT_AUTOMATED_HUMAN_OWNED" as const,
      strongestStrength: strongest,
      signalSources: sources,
      ruleIds,
      clinicalCategories,
    };

    if (signals.length > 0 || alreadyActive) {
      return {
        ...common,
        route: "SAFETY_PRIORITY_HUMAN",
        acknowledgmentTemplateId: SAFETY_ACKNOWLEDGMENT_TEMPLATE_ID,
        revokePendingActions: true,
        destinationId: SAFETY_PRIORITY_DESTINATION_ID,
        reasonCode: signals.length > 0 ? safetyReason(signals, malformed) : "SAFETY_MODE_ACTIVE",
        enterSafetyMode: !alreadyActive,
        safetyModeActive: true,
        riskFlagToSet: alreadyActive ? null : SAFETY_RISK_FLAG,
        suspendAdministrativeAutomation: true,
        transferReason: "SAFETY_PRIORITY",
        transferPriority: "SAFETY",
        safetyRoutingReason: sources[0] ?? null,
      };
    }

    if (clinicalCategories.length > 0) {
      return {
        ...common,
        route: "CLINICAL_BOUNDARY_ROUTE",
        acknowledgmentTemplateId: CLINICAL_BOUNDARY_TEMPLATE_ID,
        revokePendingActions: false,
        destinationId: CLINICAL_ROUTE_DESTINATION_ID,
        reasonCode: `CLINICAL_BOUNDARY_${clinicalCategories[0] ?? "DIAGNOSIS"}`,
        enterSafetyMode: false,
        safetyModeActive: false,
        riskFlagToSet: null,
        suspendAdministrativeAutomation: false,
        transferReason: "CLINICAL_QUESTION",
        transferPriority: "STANDARD",
        safetyRoutingReason: null,
      };
    }

    return {
      ...common,
      route: "NONE",
      acknowledgmentTemplateId: null,
      revokePendingActions: false,
      destinationId: null,
      reasonCode: "NO_SAFETY_SIGNAL",
      enterSafetyMode: false,
      safetyModeActive: false,
      riskFlagToSet: null,
      suspendAdministrativeAutomation: false,
      transferReason: null,
      transferPriority: null,
      safetyRoutingReason: null,
    };
  }
}

// ---------------------------------------------------------------------------
// Sticky safety mode per call
// ---------------------------------------------------------------------------

/** Per-call safety-mode latch. Automation can set it; nothing in automation clears it. */
export interface SafetyModeStore {
  readonly kind: "local_fixture" | "live";
  isActive(callId: string): boolean;
  activate(callId: string): void;
  /** Call ended: state may be discarded. */
  endCall(callId: string): void;
}

/**
 * LOCAL FIXTURE: in-process latch. In a deployment the latch is the session's
 * SAFETY_ESCALATION_ACTIVE risk flag held by the identity session store.
 */
export class InMemorySafetyModeStoreFixture implements SafetyModeStore {
  readonly kind = "local_fixture" as const;
  private readonly active = new Set<string>();
  isActive(callId: string): boolean {
    return this.active.has(callId);
  }
  activate(callId: string): void {
    this.active.add(callId);
  }
  endCall(callId: string): void {
    this.active.delete(callId);
  }
}

/** Wraps the deterministic router with a latch so safety mode stays on for the rest of the call. */
export class StickySafetyRouter {
  private readonly router: DeterministicSafetyRouter;
  constructor(
    private readonly store: SafetyModeStore,
    router?: DeterministicSafetyRouter,
  ) {
    this.router = router ?? new DeterministicSafetyRouter();
  }

  decideForCall(
    callId: string,
    signals: readonly unknown[],
    context: Omit<SafetyRoutingContext, "safetyModeActive"> & { safetyModeActive?: boolean },
    clinicalFindings: readonly ClinicalBoundaryFinding[] = [],
  ): SafetyRoutingDecision {
    const active = this.store.isActive(callId) || context.safetyModeActive === true;
    const decision = this.router.route({ signals, clinicalFindings, context: { ...context, safetyModeActive: active } });
    if (decision.route === "SAFETY_PRIORITY_HUMAN") this.store.activate(callId);
    return decision;
  }
}
