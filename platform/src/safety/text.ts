/**
 * Text normalization and phrase matching for the safety and clinical-boundary
 * rules (spec section 10).
 *
 * Caller words are processed in memory only. Nothing in this file persists,
 * logs or returns caller text; matches are reported as token offsets so the
 * detectors can emit rule ids and closed-set attributes only (DATA-01).
 *
 * Normalization (deterministic):
 *  - Unicode NFKD, combining marks stripped (so "daño" == "dano"), lower case;
 *  - apostrophes removed ("don't" -> "dont", "I'm" -> "im");
 *  - sentence split on . ! ? ellipsis and new lines;
 *  - clause punctuation (, ; : brackets quotes dashes) kept as a "," token so
 *    negation / subject scans stop at clause boundaries while phrase patterns
 *    may still span a comma ("I want to, um, die");
 *  - hesitation fillers ("um", "uh", "er", ...) dropped;
 *  - everything else outside [a-z0-9] becomes a word break.
 */

export const CLAUSE_TOKEN = ",";

export interface NormalizedSentence {
  /** Word tokens plus "," clause markers. */
  readonly tokens: readonly string[];
  /** tokens joined by single spaces (no leading/trailing space). */
  readonly text: string;
}

const FILLERS = new Set(["um", "umm", "uh", "uhh", "uhm", "er", "erm", "hmm", "hm", "mm", "mmm", "mhm", "ah", "ahh", "eh", "ehh"]);

const SENTENCE_SPLIT = /[.!?…\n\r。！？]+/u;
const CLAUSE_PUNCT = /[,;:()[\]{}"“”«»–—|]+/gu;
const APOSTROPHES = /['‘’ʼ`´]/gu;

function tokenizeSentence(raw: string): NormalizedSentence | null {
  const cleaned = raw.replace(CLAUSE_PUNCT, " , ").replace(/[^a-z0-9,]+/g, " ");
  const tokens: string[] = [];
  for (const t of cleaned.split(" ")) {
    if (t.length === 0) continue;
    if (t === CLAUSE_TOKEN) {
      if (tokens.length > 0 && tokens[tokens.length - 1] !== CLAUSE_TOKEN) tokens.push(CLAUSE_TOKEN);
      continue;
    }
    if (FILLERS.has(t)) continue;
    tokens.push(t);
  }
  while (tokens.length > 0 && tokens[tokens.length - 1] === CLAUSE_TOKEN) tokens.pop();
  if (tokens.length === 0) return null;
  return { tokens, text: tokens.join(" ") };
}

/** Latin-script normalization used by every en/es rule. */
export function normalizeSentences(input: string): NormalizedSentence[] {
  const base = input.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase().replace(APOSTROPHES, "");
  const out: NormalizedSentence[] = [];
  for (const s of base.split(SENTENCE_SPLIT)) {
    const sentence = tokenizeSentence(s);
    if (sentence) out.push(sentence);
  }
  return out;
}

/**
 * Script-preserving normalization for the multilingual lexeme screen used when
 * the locale is unsupported: NFKC, lower case, letters / marks / digits kept,
 * everything else collapsed to single spaces. Applied identically to lexemes.
 */
export function normalizeForLexemeScan(input: string): string {
  return input
    .normalize("NFKC")
    .toLowerCase()
    .replace(APOSTROPHES, "")
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
    .trim();
}

/** Joins words in a phrase source; optional "," clause markers may sit between words. */
const WORD_SEP = "(?: ,)* ";

/**
 * Compiles a phrase source into a global RegExp over NormalizedSentence.text.
 * Grammar: plain regex where a literal space means "word boundary, optionally
 * across clause commas", and `<w>` means "any single word token". Matches are
 * anchored at word boundaries on both sides.
 */
export function compilePhrase(source: string): RegExp {
  if (/[A-Z]/.test(source)) throw new Error("PHRASE_SOURCE_NOT_LOWER_CASE");
  const body = source.replace(/<w>/g, "[a-z0-9]+").replace(/ /g, WORD_SEP);
  return new RegExp(`(?<![a-z0-9])(?:${body})(?![a-z0-9])`, "g");
}

export interface PhraseMatch {
  /** Index of the first token of the match. */
  readonly startToken: number;
  /** Index one past the last token of the match. */
  readonly endToken: number;
}

function spacesIn(text: string, from: number, to: number): number {
  let n = 0;
  for (let i = from; i < to; i++) if (text.charCodeAt(i) === 32) n++;
  return n;
}

export function findMatches(re: RegExp, sentence: NormalizedSentence): PhraseMatch[] {
  const out: PhraseMatch[] = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sentence.text)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex += 1;
      continue;
    }
    const startToken = spacesIn(sentence.text, 0, m.index);
    const endToken = startToken + spacesIn(m[0], 0, m[0].length) + 1;
    out.push({ startToken, endToken });
  }
  return out;
}

export function anyMatch(res: readonly RegExp[], text: string): boolean {
  for (const re of res) {
    re.lastIndex = 0;
    if (re.test(text)) return true;
  }
  return false;
}

/** Replaces every match of the given patterns with a neutral placeholder token. */
export const MASK_TOKEN = "xmaskedx";

export function maskSentence(sentence: NormalizedSentence, patterns: readonly RegExp[]): NormalizedSentence {
  let text = sentence.text;
  for (const re of patterns) {
    re.lastIndex = 0;
    text = text.replace(re, MASK_TOKEN);
  }
  if (text === sentence.text) return sentence;
  const tokens = text.split(" ").filter((t) => t.length > 0);
  return { tokens, text: tokens.join(" ") };
}

/** Tokens that end a clause for negation / subject / recency scans. */
const CLAUSE_BREAKERS = new Set([CLAUSE_TOKEN, "but", "however", "although", "though", "pero", "aunque", "sino"]);

export function clauseRange(tokens: readonly string[], startToken: number, endToken: number): { from: number; to: number } {
  let from = startToken;
  while (from > 0 && !CLAUSE_BREAKERS.has(tokens[from - 1] ?? CLAUSE_TOKEN)) from--;
  let to = endToken;
  while (to < tokens.length && !CLAUSE_BREAKERS.has(tokens[to] ?? CLAUSE_TOKEN)) to++;
  return { from, to };
}

export function joinTokens(tokens: readonly string[], from: number, to: number): string {
  return tokens.slice(Math.max(0, from), Math.max(0, to)).join(" ");
}
