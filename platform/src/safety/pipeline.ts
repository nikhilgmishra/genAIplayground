/**
 * One-call convenience: detect safety signals and clinical-boundary questions
 * in an utterance and select the deterministic route. Content-free output.
 */
import { RuleBasedClinicalBoundaryDetector } from "./clinical-boundary.js";
import type { ClinicalBoundaryDetector, ClinicalBoundaryFinding } from "./clinical-boundary.js";
import { CompositeSafetySignalDetector } from "./detector.js";
import type { DetectionCoverage } from "./detector.js";
import type { SafetyDetectionInput, SafetySignal } from "./ports.js";
import { DeterministicSafetyRouter } from "./router.js";
import type { SafetyRoutingDecision } from "./router.js";

export interface SafetyEvaluation {
  signals: SafetySignal[];
  clinicalFindings: ClinicalBoundaryFinding[];
  coverage: DetectionCoverage;
  decision: SafetyRoutingDecision;
}

export class SafetyPipeline {
  private readonly detector: CompositeSafetySignalDetector;
  private readonly clinical: ClinicalBoundaryDetector;
  private readonly router: DeterministicSafetyRouter;

  constructor(
    opts: { detector?: CompositeSafetySignalDetector; clinical?: ClinicalBoundaryDetector; router?: DeterministicSafetyRouter } = {},
  ) {
    this.detector = opts.detector ?? new CompositeSafetySignalDetector();
    this.clinical = opts.clinical ?? new RuleBasedClinicalBoundaryDetector();
    this.router = opts.router ?? new DeterministicSafetyRouter();
  }

  evaluate(input: SafetyDetectionInput, context: { afterHours: boolean; safetyModeActive: boolean }): SafetyEvaluation {
    const { signals, coverage } = this.detector.analyze(input);
    const clinicalFindings = this.clinical.detect({ text: typeof input?.text === "string" ? input.text : "", locale: coverage.locale });
    const decision = this.router.route({
      signals,
      clinicalFindings,
      context: { locale: coverage.locale, afterHours: context.afterHours, safetyModeActive: context.safetyModeActive },
    });
    return { signals, clinicalFindings, coverage, decision };
  }
}
