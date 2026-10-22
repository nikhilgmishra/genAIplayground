/**
 * Refusal classifier (WP-08; FO-09-46, FO-09-09, ACT-05): refusal openings in plain text (how a self-hosted vLLM model
 * or a Bedrock model without a guardrail refuses) become REFUSED CLASSIFIED_REFUSAL, never speakable text. UNIT FAKE:
 * the `TextOnly` adapter returns one scripted COMPLETED attempt; the emulator-level seams are in ../adapters.
 */
import { describe, expect, it } from "vitest";
import { systemClock } from "../../shared/clock.js";
import { request } from "../../../test/emulators/models/harness.js";
import type { AttemptResult, ModelAdapter } from "./adapter.js";
import { decideModelFallback, speakableText } from "./fallback.js";
import { DEFAULT_REFUSAL_CLASSIFIER, normalizeForRefusal, proseRefusalClassifier } from "./refusal.js";
import { ResilientModelPort } from "./resilient.js";

const REFUSALS = [
  "I can't help with that request.",
  "I’m sorry, but I can’t assist with that.",
  "Sorry, I cannot help you with this.",
  "Unfortunately, I am unable to comply with that request.",
  "I must decline.",
  "That's not something I can help with.",
  "Sorry, the model cannot answer this question.",
  "Lo siento, pero no puedo ayudar con eso.",
  "  **I won't help with that.**",
  // Subject forms and openers (security review r3: "I'm unable to" was missed before).
  "I'm unable to help with that.",
  "I'm not able to help with that request.",
  "I won't be able to assist with this.",
  "I'm afraid I can't help with that.",
  "I'm sorry, but as an AI, I can't do that.",
  "I cannot provide that information.",
  "We can't help with that, sorry.",
  "I can't help.",
  "No puedo hacer eso porque no es posible.",
  "Disculpe, pero no podemos ayudarle con esa solicitud.",
  // Recall forms from the security review r3 (neutral synthetic topics only).
  "I'm sorry — I can't help with that.",
  "Sorry - I can't help with that.",
  "I'm sorry – I cannot assist with this request.",
  "No, I can't help with that.",
  "I can't provide information or guidance on synthetic-refusal-topic-01. Can I help you with something else?",
  "I cannot provide any guidance about synthetic-refusal-topic-02.",
  "I'm not able to provide medical advice.",
  "I can't give synthetic-domain advice.",
  "I'm sorry, I can't discuss that topic.",
  "I can't discuss synthetic-refusal-topic-03.",
  "I cannot assist with changing account ownership.",
  "I'm unable to help with modifying synthetic-refusal-topic-04, sorry.",
  // Recall forms from the security review r4 (p03).
  "I'm sorry, but I cannot provide assistance with that.",
  "I can't support that request.",
  "I'm sorry, but I can't continue with this conversation.",
  "I can't create that content.",
  "I'd rather not help with that.",
  "I'm not comfortable helping with that request.",
  "I am not comfortable providing that information.",
  "I can't offer any help on this request.",
];
const ORDINARY = [
  "Your synthetic appointment is on file for Tuesday.",
  "I can't find a synthetic record with that reference; could you read it again?",
  "I can help with that. Let me look up the status.",
  "I cannot provide that until your identity is verified; I will ask you two questions.",
  "This synthetic reply mentions that I can't help with that later in the sentence, not at the start.",
  // Conditional or partial "cannot" statements of an ordinary support flow are not refusals.
  "I can't help with that until we verify your identity.",
  "I can't answer that until the synthetic record loads.",
  "I can't help with that right now, the synthetic system is busy; please hold.",
  "I can't process that payment without a card on file.",
  "I'm unable to locate that reference; could you spell it?",
  "No puedo encontrar esa referencia todavía.",
  // Conditional or partial forms of the recall patterns stay ordinary replies.
  "I can't provide information about your synthetic claim until you are verified.",
  "I can't help with changing your synthetic address until we verify your identity.",
  "I can't discuss the synthetic invoice here; the billing team will call you.",
  "I can't give details right now, the synthetic record is still loading.",
  "I can't provide claim details until the synthetic record loads.",
  "I'm sorry - I can't find that reference; could you repeat it?",
  "No, I can't find a synthetic record with that reference.",
  "No problem, I can help with that.",
  // Conditional or partial forms of the r4 recall patterns stay ordinary replies.
  "I can't support that request until your synthetic account is verified.",
  "I can't continue with this conversation right now; a colleague will call you back.",
  "I'm not comfortable helping with that until we confirm your identity.",
  "I can't provide assistance with that here, but the synthetic billing team can.",
  "I can provide assistance with that.",
  "",
];

describe("refusal classifier [FO-09-46]", () => {
  it("[FO-09-46] refusal openings are recognised in English and Spanish, whatever the quotes, case and markup", () => {
    for (const t of REFUSALS) expect(DEFAULT_REFUSAL_CLASSIFIER.classify(t), t).toBe("MODEL_REFUSAL_CLASSIFIED");
  });

  it("[FO-09-46] adversarial: ordinary support replies, including ones that say what cannot be done yet, are not refusals", () => {
    for (const t of ORDINARY) expect(DEFAULT_REFUSAL_CLASSIFIER.classify(t), t).toBeNull();
  });

  it("[FO-09-46] endpoint phrases (a guardrail's configured blocked message) are matched at the start of the normalized text", () => {
    const c = proseRefusalClassifier(["This synthetic assistant does not discuss that topic."]);
    expect(c.classify("this synthetic assistant does NOT discuss that topic. Is there anything else?")).toBe("MODEL_REFUSAL_CLASSIFIED");
    expect(c.classify("Is there anything else? This synthetic assistant does not discuss that topic.")).toBeNull();
    expect(() => proseRefusalClassifier(["short"])).toThrow();
    expect(normalizeForRefusal("  “Quoted”   Text ")).toBe('quoted" text');
  });

  it("[FO-09-46][ACT-05] the port turns a text-only refusal into REFUSED CLASSIFIED_REFUSAL with the approved fallback; tool calls are never reclassified", async () => {
    const detail = { provider: "vllm_openai_compatible" as const, completionId: null, finishReason: "stop" as const, toolParser: "hermes", servedModel: "emulated-text" };
    const adapter = (text: string, toolCalls: { callId: string; name: string; arguments: Record<string, unknown> }[] = []): ModelAdapter => ({
      provider: "vllm_openai_compatible",
      attempt: async () => ({ provider: "vllm_openai_compatible", outcome: "COMPLETED", text, toolCalls, usage: null, detail }) as AttemptResult,
    });
    const port = (a: ModelAdapter) => new ResilientModelPort(a, { endpointRef: "ep.unit.refusal", maxDataClass: "INTERNAL", clock: systemClock, retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 } });
    const refused = await port(adapter("I can't help with that request.")).invoke(request());
    expect(refused).toMatchObject({ outcome: "REFUSED", refusal: { source: "CLASSIFIED_REFUSAL", reasonCode: "MODEL_REFUSAL_CLASSIFIED" }, detail: { finishReason: "stop" } });
    expect(speakableText(refused)).toBeNull();
    expect(decideModelFallback(refused, { safetySignalActive: false })).toMatchObject({ kind: "APPROVED_FALLBACK", reason: "MODEL_REFUSED" });
    const lookup = { name: "lookup_status", description: "Synthetic lookup.", parameters: { type: "object", properties: { reference: { type: "string" } }, required: ["reference"] } };
    const withCall = await port(adapter("I can't help with that, so I will look it up.", [{ callId: "call_synth1", name: "lookup_status", arguments: { reference: "x" } }])).invoke(request({ tools: [lookup] }));
    expect(withCall.outcome).toBe("COMPLETED");
    expect((await port(adapter("Your synthetic appointment is on file.")).invoke(request())).outcome).toBe("COMPLETED");
  });
});
