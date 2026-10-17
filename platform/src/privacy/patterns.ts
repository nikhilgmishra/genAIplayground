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

/** Removes zero-width, bidirectional-control and other invisible format characters. */
export function stripInvisible(text: string): string {
  return text.replace(/[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g, "");
}

/** ASCII control characters other than tab and newline. */
export function stripControl(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

export const DIGIT_WORD_RE = new RegExp(`\\b(?:${DIGIT_WORDS})\\b`, "gi");
