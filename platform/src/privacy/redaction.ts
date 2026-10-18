/**
 * Redaction / tokenization of free text before general logs, analytics, model
 * context and downstream sharing (spec section 6).
 *
 * PROBABILISTIC. Pattern detectors miss identifiers and over-match benign text.
 * The output is NOT de-identified: no HIPAA Safe Harbor or Expert Determination
 * is performed or claimed, and a redacted transcript remains PHI-bearing
 * (DATA-02, see classification.ts).
 *
 * Fail closed: when the input is invalid, a detector throws, or residual-risk
 * signals remain (confidence below the threshold), the result is QUARANTINED
 * with `redacted: null`. The original content must stay in its restricted
 * location; it is never forwarded to a debugging vendor (DATA-01). Callers use
 * `RedactionService` (redaction-service.ts) to route quarantines.
 *
 * Tokens carry a placeholder, a type and (when a tokenization key is supplied)
 * a keyed HMAC digest of the normalized value so equal values can be linked
 * without revealing them. Original values are never returned.
 */
import { hmacHex } from "../shared/canonical.js";
import { DIGIT_WORD_RE, detectSensitiveSpans, stripControl, stripInvisible } from "./patterns.js";
import type { SensitiveType } from "./patterns.js";

export const REDACTION_METHOD = "pattern-redaction.v1" as const;

/** Engineering default pending calibration by privacy/security; NOT a measured accuracy. */
export const DEFAULT_MIN_CONFIDENCE = 0.95;
export const DEFAULT_MAX_INPUT_CHARS = 100_000;

export interface RedactionContext {
  /** Names from trusted context (authenticated subject record, staff roster). Never caller-asserted. */
  names?: readonly string[];
  minConfidence?: number;
  maxInputChars?: number;
  /** Keyed tokenization secret (Secrets Manager in deployment). When absent, token digests are null. */
  tokenKey?: string | Buffer;
}

export interface RedactionToken {
  placeholder: string;
  type: SensitiveType;
  /** HMAC-SHA256 of the normalized value under the tokenization key; null without a key. */
  valueDigest: string | null;
  occurrences: number;
}

interface ResultBase {
  confidence: number;
  reasonCodes: string[];
  method: typeof REDACTION_METHOD;
  /** Always false: redaction is not de-identification. */
  deidentified: false;
  probabilistic: true;
}

export type RedactionResult =
  | (ResultBase & { status: "REDACTED"; redacted: string; tokens: RedactionToken[] })
  | (ResultBase & { status: "QUARANTINED"; redacted: null; tokens: [] });

const NAME_CUE = /\b(my name is|my name's|name is|this is|i am|i'm|speaking with|calling for|calling on behalf of)\s+([A-Za-z][A-Za-z'-]{1,40})/gi;
const NAME_CUE_STOPWORDS = new Set([
  "a", "an", "the", "about", "calling", "just", "not", "very", "so", "really", "trying", "looking", "having", "here", "there", "my", "your",
  "our", "their", "his", "her", "it", "is", "in", "on", "for", "to", "with", "regarding", "concerning", "still", "also", "sorry", "fine",
  "ok", "okay", "good", "great", "sure", "able", "unable", "worried", "confused", "frustrated", "new", "back", "again", "going", "waiting",
  "hoping", "wondering", "the", "that", "this", "what", "who", "how", "why", "when", "where", "because", "but", "and", "or", "if",
]);
const IDENTIFIER_CUE =
  /\b(social security|ssn|date of birth|dob|birth ?day|born(?: on| in)?|card number|credit card|debit card|cvv|cvc|security code|member (?:id|number)|account number|policy number|medical record|mrn|passcode|password|pin(?: number)?|verification code|one[- ]time code|last four)\b/gi;

const PLACEHOLDER_RE = /\[(?:EMAIL|URL|CARD|SSN|PHONE|DATE|DIGITS|NAME)_\d+\]/g;

function quarantined(reasonCodes: string[], confidence = 0): RedactionResult {
  return { status: "QUARANTINED", redacted: null, tokens: [], confidence, reasonCodes, method: REDACTION_METHOD, deidentified: false, probabilistic: true };
}

function normalizeValue(type: SensitiveType, value: string): string {
  if (type === "EMAIL" || type === "URL" || type === "NAME") return value.toLowerCase().replace(/['\u2019]s$/, "").replace(/\s+/g, " ").trim();
  const digits = value.replace(/\D/g, "");
  return digits.length > 0 ? digits : value.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Redacts sensitive spans. Pure and deterministic for a given input, context
 * and key.
 */
export function redactText(input: unknown, ctx: RedactionContext = {}): RedactionResult {
  const maxChars = ctx.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS;
  const minConfidence = ctx.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  if (typeof input !== "string") return quarantined(["REDACTION_INPUT_INVALID"]);
  if (input.length > maxChars) return quarantined(["REDACTION_INPUT_TOO_LARGE"]);
  if (!Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1) return quarantined(["REDACTION_CONTEXT_INVALID"]);
  const names = ctx.names ?? [];
  if (!Array.isArray(names) || names.some((n) => typeof n !== "string" || n.length > 120)) return quarantined(["REDACTION_CONTEXT_INVALID"]);

  try {
    const text = stripControl(stripInvisible(input.normalize("NFKC")));
    const spans = detectSensitiveSpans(text, { names });
    const counters = new Map<SensitiveType, number>();
    const byValue = new Map<string, RedactionToken>();
    const tokens: RedactionToken[] = [];
    let out = "";
    let cursor = 0;
    for (const span of spans) {
      const value = text.slice(span.start, span.end);
      const norm = `${span.type}:${normalizeValue(span.type, value)}`;
      let token = byValue.get(norm);
      if (!token) {
        const n = (counters.get(span.type) ?? 0) + 1;
        counters.set(span.type, n);
        token = {
          placeholder: `[${span.type}_${n}]`,
          type: span.type,
          valueDigest: ctx.tokenKey ? hmacHex(ctx.tokenKey, norm) : null,
          occurrences: 0,
        };
        byValue.set(norm, token);
        tokens.push(token);
      }
      token.occurrences += 1;
      out += text.slice(cursor, span.start) + token.placeholder;
      cursor = span.end;
    }
    out += text.slice(cursor);

    const { confidence, reasonCodes } = assessResidualRisk(out);
    if (confidence < minConfidence) return quarantined(["REDACTION_LOW_CONFIDENCE", ...reasonCodes], confidence);
    return { status: "REDACTED", redacted: out, tokens, confidence, reasonCodes, method: REDACTION_METHOD, deidentified: false, probabilistic: true };
  } catch {
    return quarantined(["REDACTION_FAILED"]);
  }
}

/**
 * Heuristic residual-risk assessment of already-redacted text. Confidence is a
 * score in [0, 1] built from explicit penalties; it is NOT a calibrated
 * probability that the text is free of identifiers.
 */
export function assessResidualRisk(redacted: string): { confidence: number; reasonCodes: string[] } {
  const reasons: string[] = [];
  let penalty = 0;
  const plain = redacted.replace(PLACEHOLDER_RE, " ");

  if (/@/.test(plain)) {
    reasons.push("RESIDUAL_AT_SIGN");
    penalty += 0.3;
  }
  for (const m of plain.matchAll(NAME_CUE)) {
    const cue = (m[1] ?? "").toLowerCase();
    const word = m[2] ?? "";
    if (NAME_CUE_STOPWORDS.has(word.toLowerCase())) continue;
    const strongCue = cue.startsWith("my name") || cue === "name is";
    if (strongCue || /^[A-Z]/.test(word)) {
      reasons.push("RESIDUAL_POSSIBLE_UNLISTED_NAME");
      penalty += 0.5;
      break;
    }
  }
  for (const m of plain.matchAll(IDENTIFIER_CUE)) {
    const after = plain.slice(m.index + m[0].length, m.index + m[0].length + 60);
    DIGIT_WORD_RE.lastIndex = 0;
    if (/\d/.test(after) || DIGIT_WORD_RE.test(after)) {
      reasons.push("RESIDUAL_IDENTIFIER_CUE_WITH_VALUE");
      penalty += 0.5;
      break;
    }
  }
  const digitWordRuns = plain.match(/\b(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)(?:[\s,-]+(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)){2}\b/gi);
  if (digitWordRuns && digitWordRuns.length > 0) {
    reasons.push("RESIDUAL_SPOKEN_DIGITS");
    penalty += 0.2;
  }
  if (/\d{4}/.test(plain) && /\b(code|number|id|account|card|member|policy|pin)\b/i.test(plain)) {
    reasons.push("RESIDUAL_DIGIT_GROUP_NEAR_IDENTIFIER_WORD");
    penalty += 0.2;
  }
  const confidence = Math.max(0, Math.round((1 - penalty) * 1000) / 1000);
  return { confidence, reasonCodes: [...new Set(reasons)] };
}
