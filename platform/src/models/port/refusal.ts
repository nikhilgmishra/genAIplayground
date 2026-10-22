/**
 * Refusal classifier (WP-08; FO-09-46, FO-09-09, SAFE-03, ACT-05): recognises a refusal written as ordinary text.
 *
 * Providers signal refusals differently, and two of the three adapters have no protocol signal at all in common
 * deployments: a self-hosted vLLM model refuses in plain `content` with `finish_reason: stop` (vLLM streams no refusal
 * field and no content filter), and a Bedrock model called without a guardrail refuses in plain text with
 * `stopReason: end_turn`. OpenAI models usually send a `refusal` content part, but can also decline in prose. The port
 * runs this classifier on every COMPLETED text-only result (no tool calls), whatever the provider; a match becomes
 * REFUSED with source CLASSIFIED_REFUSAL, so the refusal text is never speakable and the harness answers with the
 * approved fallback and a human offer (fallback.ts).
 *
 * The rules are deliberately narrow (a refusal OPENING: the first sentence declines to help, assist or comply, or
 * says it must decline, optionally after "sorry" / "unfortunately"), plus the endpoint's configured phrases (for
 * example the blocked-output message of a tenant's Bedrock guardrail, or a self-hosted model's documented refusal
 * template). Best effort: a refusal worded otherwise stays COMPLETED text, which the harness and the gateway check
 * again before anything is spoken (WP-10); a false match only costs the caller the generic fallback and a human offer.
 * English and Spanish openings. The classifier never logs or returns the text, only a reason code.
 */
import { z } from "zod";

/** Endpoint configuration: extra refusal phrases (matched at the start of the normalized text). */
export const RefusalPhrases = z.array(z.string().min(8).max(200)).max(16);

/**
 * Openers that may precede a refusal ("I'm sorry, but", "Unfortunately,", "As an AI,", "No,"), at most two of them,
 * each followed by optional punctuation or a dash ("I'm sorry - I can't ...").
 */
const OPENER = String.raw`(?:(?:i am|i'm|im|we are|we're) sorry|sorry|unfortunately|apologies|my apologies|i apologi[sz]e|(?:i am|i'm|im) afraid|as an ai(?: (?:language model|assistant))?|no(?=\s*[,.!-]))`;
const PREFIX = String.raw`(?:${OPENER}\s*(?:[,.!;:]|-{1,2})?\s*(?:but\s*)?){0,2}`;
/** "I can't", "we cannot", "I'm unable to", "I am not able to", "I won't be able to", "I'm not going to". */
const NOT = String.raw`(?:(?:i|we) (?:can't|cannot|can not|won't|will not|(?:won't|will not) be able to|am unable to|am not able to|am not allowed to|am not permitted to|am not going to|are unable to|are not able to|are not allowed to|are not going to|would rather not)|(?:i'm|im|we're) (?:unable to|not able to|not allowed to|not permitted to|not going to)|(?:i'd|we'd) rather not)`;
const OBJECT = String.raw`(?:that|this|it|your request|this request|that request|the request|your question|this question|that question|that information|this information|those details|these details|that kind of (?:request|question|information|content)|requests? like (?:that|this)|(?:that|this|the|such|those|these) (?:topic|topics|subject|subjects|matter|matters|content)|topics like (?:that|this))`;
/**
 * Words that make a "cannot" statement conditional or temporary ("... until you are verified", "... right now"): a
 * free-form topic phrase may never run across one, so such a statement stays an ordinary support reply.
 */
const CONDITIONAL = String.raw`(?:until|unless|without|before|after|yet|right now|at the moment|today|once|while|if|here|from here)`;
/** A free-form topic of at most 100 characters that stops at a sentence end and never crosses a conditional word. */
const TOPIC = String.raw`(?:(?!\b${CONDITIONAL}\b)[^.!?;]){1,100}?`;
/**
 * The refusal must END the clause: end of text, punctuation, or a connective ("as", "because", "but"). A conditional
 * continuation ("I can't help with that until you are verified", "... right now") is an ordinary support reply.
 */
const TAIL = String.raw`(?=\s*(?:$|[.!;:,)]|(?:as|because|since|but|sorry)\b))`;

/** Refusal openings (normalized text: lower case, straight apostrophes, single spaces). */
const OPENINGS: readonly RegExp[] = [
  new RegExp(String.raw`^${PREFIX}${NOT} (?:help|assist)(?: you)?(?: with ${OBJECT})?${TAIL}`),
  // "I cannot assist with changing ...": help or assist with an activity (a gerund), unconditionally.
  new RegExp(String.raw`^${PREFIX}${NOT} (?:help|assist)(?: you)? with [a-z]+ing\b${TOPIC}${TAIL}`),
  new RegExp(String.raw`^${PREFIX}${NOT} (?:comply with|fulfill|fulfil|complete|answer|provide|share|discuss|do|process|respond to|support|create|generate|produce|write|continue with) ${OBJECT}${TAIL}`),
  // "I cannot provide assistance with that", "I can't offer help on this request".
  new RegExp(String.raw`^${PREFIX}${NOT} (?:provide|offer|give) (?:any )?(?:assistance|help|support)(?: (?:with|on|for) ${OBJECT})?${TAIL}`),
  // "I can't continue with this conversation", "I'm not able to continue the discussion".
  new RegExp(String.raw`^${PREFIX}${NOT} continue (?:with )?(?:this|that|the|our) (?:conversation|discussion|chat|topic)${TAIL}`),
  // "I'm not comfortable helping with that request", "I am not comfortable providing that information".
  new RegExp(String.raw`^${PREFIX}(?:i'm|im|i am|we're|we are) not comfortable (?:(?:helping|assisting)(?: you)?(?: with ${OBJECT})?|(?:providing|sharing|discussing|answering|doing|creating) ${OBJECT})${TAIL}`),
  // "I can't provide information or guidance on ...", "I'm not able to provide medical advice", unconditionally.
  new RegExp(String.raw`^${PREFIX}${NOT} (?:provide|give|offer|share) (?:any )?(?:[a-z-]+ )?(?:information|guidance|advice|details)(?: or (?:information|guidance|advice|details))?(?: (?:on|about|regarding|related to)${TOPIC})?${TAIL}`),
  // "I can't discuss ..." (any topic), unconditionally.
  new RegExp(String.raw`^${PREFIX}${NOT} (?:discuss|talk about|go into)${TOPIC}${TAIL}`),
  new RegExp(String.raw`^${PREFIX}(?:i|we) (?:must|have to|need to) (?:respectfully |politely )?decline\b`),
  new RegExp(String.raw`^${PREFIX}(?:that|this)(?:'s| is) not something (?:i|we) (?:can|am able to|are able to) (?:help|assist) with\b`),
  // Amazon Bedrock's default guardrail blocked-output message.
  /^sorry, the model cannot answer this question\b/,
  // Spanish openings.
  /^(?:lo siento,? (?:pero )?|disculpa,? (?:pero )?|disculpe,? (?:pero )?)?no (?:puedo|podemos) (?:ayudar|ayudarte|ayudarle|asistir|asistirte|asistirle)(?: con (?:eso|esto|esa solicitud|esta solicitud|tu solicitud|su solicitud|esa pregunta|tu pregunta|su pregunta))?(?=\s*(?:$|[.!;:,]|(?:porque|ya que|pero)\b))/,
  /^(?:lo siento,? (?:pero )?|disculpa,? (?:pero )?|disculpe,? (?:pero )?)?no (?:puedo|podemos) (?:responder|proporcionar|compartir|hacer) (?:eso|esto|esa pregunta|esa información|esa informacion)(?=\s*(?:$|[.!;:,]|(?:porque|ya que|pero)\b))/,
  /^(?:lo siento,? (?:pero )?)?(?:debo|tengo que) rechazar\b/,
];

/** Lower case, straight apostrophes and quotes, single spaces, no leading quotes or markup, at most 240 characters. */
export function normalizeForRefusal(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[‘’ʼ′]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^[\s"'*_>#-]+/, "")
    .slice(0, 240)
    .trim();
}

export interface RefusalClassifier {
  /** A reason code when the text is a refusal, otherwise null. */
  classify(text: string): "MODEL_REFUSAL_CLASSIFIED" | null;
}

/** The prose refusal classifier with the endpoint's extra phrases. */
export function proseRefusalClassifier(extraPhrases: readonly string[] = []): RefusalClassifier {
  const phrases = RefusalPhrases.parse(extraPhrases).map((p) => normalizeForRefusal(p));
  return {
    classify(text: string) {
      const t = normalizeForRefusal(text);
      if (t === "") return null;
      if (OPENINGS.some((re) => re.test(t))) return "MODEL_REFUSAL_CLASSIFIED";
      if (phrases.some((p) => p !== "" && t.startsWith(p))) return "MODEL_REFUSAL_CLASSIFIED";
      return null;
    },
  };
}

/** The classifier every port uses unless the composition root configures phrases. */
export const DEFAULT_REFUSAL_CLASSIFIER: RefusalClassifier = proseRefusalClassifier();
