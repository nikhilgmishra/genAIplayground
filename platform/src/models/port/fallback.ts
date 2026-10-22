/**
 * Safe, useful fallback on refusal, hang or overload (WP-08; FO-09-46, SAFE-03, OPS-02, ACT-05).
 *
 * The decision is computed from the typed ModelResult alone; it never calls a model and never depends on a breaker,
 * so it is available exactly when the model is not (OPS-02). It never lets model text through for a non-COMPLETED
 * result: a refusal message, partial deltas of a hung or overloaded stream and malformed output are suppressed, and
 * the caller hears the approved template `fallback.safe_explanation` with an offer of a human
 * (HANDOFF_PROPOSAL AI_UNAVAILABLE). The gateway still decides the final SpeechPlan and the human route (SAFE-05).
 *
 * Safety flow is unaffected (SAFE-03): when the turn carries an active safety signal, the model failure never
 * replaces or delays the safety route: the decision is the safety acknowledgment and a SAFETY_PRIORITY handoff, and
 * no refusal count, timeout, overload or cancellation can end that flow. Outside a safety turn a cancelled call
 * (barge-in) produces no speech at all.
 */
import { z } from "zod";
import { ModelDecisionBody } from "../../protocol/models.js";
import type { ModelResult } from "./types.js";

export const FALLBACK_TEMPLATE_ID = "fallback.safe_explanation";
export const SAFETY_ACK_TEMPLATE_ID = "safety.acknowledgment";

export type ModelFallbackReason = "MODEL_REFUSED" | "MODEL_HANG" | "MODEL_OVERLOAD" | "MODEL_UNAVAILABLE" | "MODEL_MALFORMED" | "MODEL_FAILED" | "MODEL_INCOMPLETE" | "MODEL_CANCELLED";

export interface FallbackContext {
  /** The safety detector raised a routing signal for this turn (runtime, before any model call; WP-15). */
  safetySignalActive: boolean;
}

export type ModelFallbackDecision =
  /** COMPLETED: the model's proposals go to the gateway (still re-authorized and re-validated there). */
  | { kind: "USE_MODEL_OUTPUT" }
  /**
   * CANCELLED without an active safety signal: the caller interrupted or the turn was superseded; nothing is spoken
   * for this call. With an active safety signal a cancelled call is APPROVED_FALLBACK with the safety route instead.
   */
  | { kind: "NO_SPEECH_CANCELLED" }
  | {
      kind: "APPROVED_FALLBACK";
      reason: ModelFallbackReason;
      /** Typed proposals for the gateway: an approved template and a human offer. Never model text. */
      decisions: ModelDecisionBody[];
      /** Always true: no text or refusal delta of this call may reach the audio queue. */
      suppressModelText: true;
      /** True when the safety route took precedence over the generic fallback. */
      safetyRoute: boolean;
    };

const Decisions = z.array(ModelDecisionBody).min(1).max(8);

export function fallbackReasonFor(result: ModelResult): ModelFallbackReason | null {
  switch (result.outcome) {
    case "COMPLETED":
    case "CANCELLED":
      return null;
    case "REFUSED":
      return "MODEL_REFUSED";
    case "TIMED_OUT":
      return "MODEL_HANG";
    case "OVERLOADED":
      return "MODEL_OVERLOAD";
    case "UNAVAILABLE":
      return result.reasonCode === "MODEL_CIRCUIT_OPEN" || result.reasonCode === "MODEL_BACKPRESSURE" ? "MODEL_OVERLOAD" : "MODEL_UNAVAILABLE";
    case "MALFORMED":
      return "MODEL_MALFORMED";
    case "INCOMPLETE":
      return "MODEL_INCOMPLETE";
    case "FAILED":
      return "MODEL_FAILED";
  }
}

/** The fallback decision for one model result (pure; metrics are counted by the caller with `countFallback`). */
export function decideModelFallback(result: ModelResult, ctx: FallbackContext): ModelFallbackDecision {
  if (result.outcome === "COMPLETED") return { kind: "USE_MODEL_OUTPUT" };
  // A cancelled call is silent, EXCEPT on a safety turn: cancellation (a barge-in, a superseded turn, or a harness
  // that wrongly passed a deadline as the abort signal) must never end the safety flow silently (SAFE-03), so the
  // safety acknowledgment and the SAFETY_PRIORITY handoff are proposed again.
  if (result.outcome === "CANCELLED" && !ctx.safetySignalActive) return { kind: "NO_SPEECH_CANCELLED" };
  const reason = result.outcome === "CANCELLED" ? "MODEL_CANCELLED" : (fallbackReasonFor(result) ?? "MODEL_FAILED");
  const decisions = ctx.safetySignalActive
    ? Decisions.parse([
        { kind: "SPEECH_REQUEST", utteranceClass: "SAFETY", templateId: SAFETY_ACK_TEMPLATE_ID, sourceRefs: [] },
        { kind: "HANDOFF_PROPOSAL", reason: "SAFETY_PRIORITY" },
      ])
    : Decisions.parse([
        { kind: "SPEECH_REQUEST", utteranceClass: "GENERIC_STATUS", templateId: FALLBACK_TEMPLATE_ID, sourceRefs: [] },
        { kind: "HANDOFF_PROPOSAL", reason: "AI_UNAVAILABLE" },
      ]);
  return { kind: "APPROVED_FALLBACK", reason, decisions, suppressModelText: true, safetyRoute: ctx.safetySignalActive };
}

/** Speakable model text: only a COMPLETED result has any (ACT-05: nothing else reaches the audio queue). */
export function speakableText(result: ModelResult): string | null {
  return result.outcome === "COMPLETED" && result.text.length > 0 ? result.text : null;
}
