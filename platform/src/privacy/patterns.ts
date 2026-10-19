/**
 * Sensitive-pattern detectors shared by redaction, egress URL checks, knowledge
 * ingestion and memory value validation (spec section 6).
 *
 * These are PROBABILISTIC pattern matchers. They miss identifiers that do not
 * look like the patterns below and they over-match benign text. A clean result
 * is never evidence that text is free of PHI, and nothing here performs or
 * claims formal de-identification.
 */

export type SensitiveType = "EMAIL" | "URL" | "CARD" | "SSN" | "PHONE" | "DATE" | "DIGITS" | "NAME";

export interface SensitiveSpan {
  type: SensitiveType;
  start: number;
  /** Exclusive end offset. */
  end: number;
}

/** Lower number wins when two spans of equal length overlap. */
const PRIORITY: Record<SensitiveType, number> = { EMAIL: 1, URL: 2, CARD: 3, SSN: 4, PHONE: 5, DATE: 6, DIGITS: 7, NAME: 8 };

/** Luhn checksum over a digit string (card-number-like detection). */
export function luhnValid(digits: string): boolean {
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

const MONTHS = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const DIGIT_WORDS = "zero|oh|one|two|three|four|five|six|seven|eight|nine";

interface Detector {
  type: SensitiveType | "CARD_OR_DIGITS";
  re: RegExp;
}

const DETECTORS: readonly Detector[] = [
  { type: "EMAIL", re: /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})*\.[A-Za-z]{2,24}/g },
  // Spoken email as an ASR transcript renders it: "avery at example dot com".
  { type: "EMAIL", re: /\b[a-z0-9._-]{1,64}\s+at\s+[a-z0-9-]{1,63}(?:\s+dot\s+[a-z0-9-]{1,63})*\s+dot\s+[a-z]{2,24}\b/gi },
  { type: "URL", re: /\b(?:https?|ftp|file):\/\/[^\s<>"'`]+|\bwww\.[^\s<>"'`]+/gi },
  { type: "CARD_OR_DIGITS", re: /(?<![\d])(?:\d[ -]?){12,18}\d(?![\d])/g },
  { type: "SSN", re: /(?<![\d-])\d{3}[- ]\d{2}[- ]\d{4}(?![\d-])/g },
  { type: "PHONE", re: /(?<![\d+])(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/g },
  { type: "PHONE", re: /(?<![\d+])\+\d{8,15}(?!\d)/g },
  { type: "PHONE", re: /(?<![\d.-])\d{3}[-.]\d{4}(?![\d.-])/g },
  { type: "DATE", re: /(?<!\d)\d{4}-\d{1,2}-\d{1,2}(?!\d)/g },
  { type: "DATE", re: /(?<!\d)\d{1,2}[/-]\d{1,2}[/-](?:\d{4}|\d{2})(?!\d)/g },
  { type: "DATE", re: new RegExp(`\\b(?:${MONTHS})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?\\b`, "gi") },
  { type: "DATE", re: new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?(?:${MONTHS})\\b(?:,?\\s+\\d{4})?`, "gi") },
  // Digits spoken as words (ASR output), e.g. "five five five one two".
  { type: "DIGITS", re: new RegExp(`\\b(?:${DIGIT_WORDS})(?:[\\s,-]+(?:${DIGIT_WORDS})){3,}\\b`, "gi") },
  // Spaced single digits, e.g. "4 7 2 9".
  { type: "DIGITS", re: /(?<![\d])\d(?:[\s,.-]+\d){3,}(?![\d])/g },
  { type: "DIGITS", re: /(?<!\d)\d{5,}(?!\d)/g },
];

/**
 * Detects sensitive spans. `names` are exact names supplied from trusted context
 * (e.g. the authenticated subject's record); they are matched case-insensitively
 * on word boundaries, including possessives.
 */
export function detectSensitiveSpans(text: string, opts: { names?: readonly string[] } = {}): SensitiveSpan[] {
  const raw: SensitiveSpan[] = [];
  for (const d of DETECTORS) {
    d.re.lastIndex = 0;
    for (const m of text.matchAll(d.re)) {
      const start = m.index;
      const end = start + m[0].length;
      if (d.type === "CARD_OR_DIGITS") {
        const digits = m[0].replace(/\D/g, "");
        if (luhnValid(digits)) raw.push({ type: "CARD", start, end });
        else if (digits.length >= 9) raw.push({ type: "DIGITS", start, end });
        continue;
      }
      raw.push({ type: d.type, start, end });
    }
  }
  for (const name of expandNames(opts.names ?? [])) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(name)}(?:['\u2019]s)?(?![\\p{L}\\p{N}])`, "giu");
    for (const m of text.matchAll(re)) raw.push({ type: "NAME", start: m.index, end: m.index + m[0].length });
  }
  return resolveOverlaps(raw);
}

/** True when any non-name sensitive pattern occurs. */
export function containsSensitivePattern(text: string, types?: readonly SensitiveType[]): boolean {
  const spans = detectSensitiveSpans(text);
  return types ? spans.some((s) => types.includes(s.type)) : spans.length > 0;
}

/** Splits full names into their parts as well ("Avery Synthetic-Client" -> both parts and the whole). */
export function expandNames(names: readonly string[]): string[] {
  const out = new Set<string>();
  for (const n of names) {
    const trimmed = n.normalize("NFKC").trim();
    if (trimmed.length >= 2) out.add(trimmed);
    for (const part of trimmed.split(/\s+/)) if (part.length >= 2) out.add(part);
  }
  // Longest first so the full name wins over its parts.
  return [...out].sort((a, b) => b.length - a.length || a.localeCompare(b));
}

/** Longest span wins; ties break on type priority, then position. Output sorted by start. */
export function resolveOverlaps(spans: readonly SensitiveSpan[]): SensitiveSpan[] {
  const ordered = [...spans].sort((a, b) => b.end - b.start - (a.end - a.start) || PRIORITY[a.type] - PRIORITY[b.type] || a.start - b.start);
  const picked: SensitiveSpan[] = [];
  for (const s of ordered) {
    if (picked.some((p) => s.start < p.end && p.start < s.end)) continue;
    picked.push(s);
  }
  return picked.sort((a, b) => a.start - b.start);
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Every Unicode format character (Cf) and default-ignorable code point: zero-width
 * and joiner characters, bidirectional controls (incl. U+061C), invisible operators,
 * deprecated format controls (U+206A-206F), interlinear annotation (U+FFF9-FFFB),
 * musical format controls, variation selectors and the tag block (U+E0000-E007F).
 * A hand-maintained list missed several of these, which let them split hosts and
 * hide tag-encoded text from matching (VSP-KN-01). U+2800 BRAILLE PATTERN BLANK is
 * neither, but it is a blank filler (like the default-ignorable Hangul fillers) that
 * is not whitespace, so a reader sees no break where it splits a host.
 */
const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}\u2800]/gu;

/** Removes every invisible format / default-ignorable character (see INVISIBLE). */
export function stripInvisible(text: string): string {
  return text.replace(INVISIBLE, "");
}

/** Unicode tag characters (U+E0000-E007F) encode hidden ASCII; legitimate support text never uses them. */
const TAG_CHARACTERS = /[\u{E0000}-\u{E007F}]/u;

export function containsTagCharacters(text: string): boolean {
  return TAG_CHARACTERS.test(text);
}

/** Decodes tag-encoded ASCII (U+E0020-E007E -> U+0020-007E) so hidden text can be inspected; other characters are dropped. */
export function decodeTagCharacters(text: string): string {
  let out = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp >= 0xe0020 && cp <= 0xe007e) out += String.fromCharCode(cp - 0xe0000);
  }
  return out;
}

/**
 * Removes C0 controls other than tab and newline (CR and CRLF become a newline), DEL and the C1
 * controls U+0080-009F. C1 characters are neither Cf nor default-ignorable, so stripInvisible keeps
 * them, and they split hosts just as invisibly (VSP-KN-01).
 */
export function stripControl(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "");
}

/**
 * Every character that stripInvisible or stripControl removes, plus CR (which stripControl turns
 * into a newline): text that has been through both contains none of them.
 */
// eslint-disable-next-line no-control-regex
const HIDDEN = /[\p{Cf}\p{Default_Ignorable_Code_Point}\u2800\u0000-\u0008\u000B-\u001F\u007F-\u009F]/u;

/** True when the text still holds an invisible, default-ignorable, tag, U+2800, C0 (other than tab/newline) or C1 character. */
export function containsInvisibleOrControl(text: string): boolean {
  return HIDDEN.test(text);
}

/**
 * The hidden characters that can stand for a word break: C0 controls other than tab and newline (CR
 * included), DEL, C1 controls, U+200B ZERO WIDTH SPACE, U+2060 WORD JOINER, U+FEFF and the blank
 * fillers U+2800, U+3164 and U+FFA0 (they render as a blank). Characters that belong inside a word
 * (U+00AD SOFT HYPHEN, ZWJ/ZWNJ, U+034F COMBINING GRAPHEME JOINER, variation selectors) and the
 * other format characters (bidi controls, invisible operators, tags) are not: reading
 * "sub<U+00AD>system:" as "sub system:" turned an ordinary word into an injection role marker.
 */
// eslint-disable-next-line no-control-regex
const WORD_BREAKING_HIDDEN = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200B\u2060\uFEFF\u2800\u3164\uFFA0]/g;

/** Replaces each hidden character that can stand for a word break (see WORD_BREAKING_HIDDEN) with a space. */
export function wordBreakingHiddenAsSpaces(text: string): string {
  return text.replace(WORD_BREAKING_HIDDEN, " ");
}

export const DIGIT_WORD_RE = new RegExp(`\\b(?:${DIGIT_WORDS})\\b`, "gi");
