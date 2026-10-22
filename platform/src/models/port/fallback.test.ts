/**
 * Fallback decision (WP-08; FO-09-46, SAFE-03, OPS-02, ACT-05): every non-completed outcome is answered with an
 * approved template and a human offer, model text is never speakable, and an active safety signal always wins.
 */
import { describe, expect, it } from "vitest";
import { ModelDecisionBody } from "../../protocol/models.js";
import { FALLBACK_TEMPLATE_ID, decideModelFallback, fallbackReasonFor, speakableText } from "./fallback.js";
import type { ModelResult } from "./types.js";

const base = { provider: "openai_responses" as const, invocationId: "minv_synthFallback0000001", latencyMs: 5, attempts: 1, sentAttempts: 1, usage: null };
const detail = { provider: "openai_responses" as const, responseId: null, status: null, incompleteReason: null, errorCode: null };
const RESULTS: ModelResult[] = [
  { ...base, outcome: "REFUSED", refusal: { source: "MODEL_REFUSAL", reasonCode: "MODEL_REFUSED" }, detail },
  { ...base, outcome: "INCOMPLETE", reasonCode: "MODEL_MAX_OUTPUT_TOKENS", detail },
  { ...base, outcome: "OVERLOADED", retryAfterMs: 1_000, reasonCode: "MODEL_OVERLOADED", detail },
  { ...base, outcome: "TIMED_OUT", phase: "STREAM_IDLE", reasonCode: "MODEL_READ_TIMEOUT", detail },
  { ...base, outcome: "MALFORMED", reasonCode: "MODEL_TOOL_MARKUP_LEAKED", detail },
  { ...base, outcome: "UNAVAILABLE", reasonCode: "MODEL_CIRCUIT_OPEN", detail: null },
  { ...base, outcome: "UNAVAILABLE", reasonCode: "EGRESS_DESTINATION_UNKNOWN", detail: null },
  { ...base, outcome: "FAILED", errorClass: "UNKNOWN", reasonCode: "UNCLASSIFIED_ERROR", httpStatus: null, detail: null },
];

describe("model fallback decision [FO-09-46][SAFE-03]", () => {
  it("[FO-09-46] positive: a completed result uses the model output; a cancelled one is silent", () => {
    const ok: ModelResult = { ...base, outcome: "COMPLETED", text: "Synthetic reply.", toolCalls: [], detail };
    expect(decideModelFallback(ok, { safetySignalActive: false })).toEqual({ kind: "USE_MODEL_OUTPUT" });
    expect(speakableText(ok)).toBe("Synthetic reply.");
    expect(decideModelFallback({ ...base, outcome: "CANCELLED", reasonCode: "MODEL_CALL_CANCELLED", detail: null }, { safetySignalActive: false })).toEqual({ kind: "NO_SPEECH_CANCELLED" });
  });

  it("[FO-09-46][ACT-05] every refusal, hang, overload, malformed, unavailable or failed result gets the approved template and a human offer, never model text", () => {
    const reasons = RESULTS.map((r) => {
      const d = decideModelFallback(r, { safetySignalActive: false });
      expect(d.kind).toBe("APPROVED_FALLBACK");
      if (d.kind !== "APPROVED_FALLBACK") return null;
      expect(d.suppressModelText).toBe(true);
      expect(d.decisions).toEqual([
        { kind: "SPEECH_REQUEST", utteranceClass: "GENERIC_STATUS", templateId: FALLBACK_TEMPLATE_ID, sourceRefs: [] },
        { kind: "HANDOFF_PROPOSAL", reason: "AI_UNAVAILABLE" },
      ]);
      for (const body of d.decisions) expect(ModelDecisionBody.safeParse(body).success).toBe(true);
      expect(speakableText(r)).toBeNull();
      return d.reason;
    });
    expect(reasons).toEqual(["MODEL_REFUSED", "MODEL_INCOMPLETE", "MODEL_OVERLOAD", "MODEL_HANG", "MODEL_MALFORMED", "MODEL_OVERLOAD", "MODEL_UNAVAILABLE", "MODEL_FAILED"]);
  });

  it("[SAFE-03] adversarial: with an active safety signal, any model failure (including repeated refusals) keeps the safety route", () => {
    for (const r of RESULTS) {
      for (let i = 0; i < 3; i += 1) {
        const d = decideModelFallback(r, { safetySignalActive: true });
        expect(d).toMatchObject({ kind: "APPROVED_FALLBACK", safetyRoute: true, decisions: [{ kind: "SPEECH_REQUEST", utteranceClass: "SAFETY", templateId: "safety.acknowledgment" }, { kind: "HANDOFF_PROPOSAL", reason: "SAFETY_PRIORITY" }] });
      }
    }
  });

  it("[SAFE-03] adversarial: a cancelled call on a safety turn keeps the safety route (never silent); outside a safety turn it stays silent", () => {
    const cancelled: ModelResult = { ...base, outcome: "CANCELLED", reasonCode: "MODEL_CALL_CANCELLED", detail: null };
    expect(decideModelFallback(cancelled, { safetySignalActive: true })).toEqual({
      kind: "APPROVED_FALLBACK",
      reason: "MODEL_CANCELLED",
      suppressModelText: true,
      safetyRoute: true,
      decisions: [
        { kind: "SPEECH_REQUEST", utteranceClass: "SAFETY", templateId: "safety.acknowledgment", sourceRefs: [] },
        { kind: "HANDOFF_PROPOSAL", reason: "SAFETY_PRIORITY" },
      ],
    });
    expect(decideModelFallback(cancelled, { safetySignalActive: false })).toEqual({ kind: "NO_SPEECH_CANCELLED" });
    expect(speakableText(cancelled)).toBeNull();
  });

  it("[FO-09-46] failure injection: the decision needs no model and no breaker (it is computed from the typed result alone)", () => {
    expect(fallbackReasonFor({ ...base, outcome: "UNAVAILABLE", reasonCode: "MODEL_BACKPRESSURE", detail: null })).toBe("MODEL_OVERLOAD");
    expect(fallbackReasonFor({ ...base, outcome: "COMPLETED", text: "", toolCalls: [], detail })).toBeNull();
    expect(speakableText({ ...base, outcome: "COMPLETED", text: "", toolCalls: [], detail })).toBeNull();
  });
});
