/**
 * Knowledge sanitizer (spec section 9: "sanitize embedded instructions, links,
 * attachments and executable content").
 *
 * Retrieved articles are untrusted model input (spec section 3). Before an item
 * is stored the sanitizer:
 *  - refuses (fails closed with the quarantine finding SANITIZER_INPUT_TOO_LARGE)
 *    any input longer than MAX_SANITIZE_INPUT_CHARS, raw or after any NFKC
 *    (including NFKC of entity-decoded text);
 *  - normalizes the text (normalizeStep): NFKC, the IDNA label separators
 *    U+3002, U+FF0E and U+FF61 folded to ".", then every Unicode format (Cf) and
 *    default-ignorable character (zero-width and joiner characters, bidi
 *    controls, variation selectors, tag characters), U+2800 BRAILLE PATTERN
 *    BLANK and every C0/C1 control other than tab and newline removed. Unicode
 *    tag characters also quarantine the item (HIDDEN_TAG_CHARACTERS); their
 *    decoded ASCII is returned as hiddenText for injection detection;
 *  - decodes HTML entities (numeric references and every named reference in the
 *    WHATWG table, html-entities.ts, matched as a browser's tokenizer matches
 *    them: case-sensitive, ";" required except for the 106 legacy names) to a
 *    fixpoint, repeating the normalization step after EVERY decode, so an
 *    entity-encoded character ("&#x200b;", "&#x81;", "&#xe0049;", "&#x2024;",
 *    "&eacute;", "&copf;") is treated exactly like its raw form (encoded markup
 *    cannot survive either), while "HR&IT" or "Rock&Grave" is not a reference
 *    and stays as written. A reference still decodable after MAX_ENTITY_DECODES
 *    rounds fails closed: ENTITY_DECODE_LIMIT_EXCEEDED (quarantine), and the
 *    reference is removed, never kept as literal nested entity text;
 *  - removes <script>/<style>/<iframe>/<object>/<embed>/<form>/... blocks with
 *    their content, HTML comments and every remaining tag;
 *  - removes fenced code blocks and inline code (executable content);
 *  - removes images, attachments, executable file references and data: URIs;
 *  - rewrites markdown/HTML links to their text; an allowlisted link target is
 *    kept only as plain text "host/path" (no scheme, port, query, fragment or
 *    dotted path segment);
 *  - removes raw URLs, bare domains and IP literals outside the allowlist;
 *  - repeats the pipeline until the text is stable, then hard-scrubs anything
 *    left that still violates the output invariants (quarantine; a scrub that
 *    does not settle within MAX_HARD_SCRUB_STEPS empties the text);
 *  - repeats that round until its output is a fixpoint; a text that has not
 *    settled after MAX_ROUNDS rounds (markdown or reference links nested 24 or
 *    more deep) is quarantined (SANITIZER_HARD_SCRUB_APPLIED) and kept only
 *    when one more round leaves it unchanged, otherwise emptied (fail closed).
 *
 * Output invariants (property-tested with an independent oracle, including
 * generated domains on arbitrary TLDs, decorated TLDs, IDNA separators,
 * IPv4/IPv6 literals, entity-encoded invisible, tag, control and NFKC-only
 * look-alike characters, and letters written as named references): no "<" or
 * ">", no "://", no "www.", no javascript:/vbscript:/data: URI, no bare domain
 * outside the allowlist, no IP literal, no invisible, default-ignorable, tag, C0
 * or C1 character and no decodable entity reference (numeric, or any name in the
 * HTML table, also after NFKC). sanitizedTextViolations checks them on two
 * readings and reports the union: the text as stored, and the text as this
 * sanitizer normalizes, decodes and strips it (the first keeps what NFKC would
 * destroy, such as "<" + U+0338, which composes to U+226E); the retrieval
 * re-check applies the same function to stored titles and excerpts, so rows
 * stored by an older sanitizer, or by none, are dropped. The sanitizer is
 * idempotent: every output is either a text one more round leaves unchanged or
 * "" (the fail-closed outputs), so sanitizing its own output gives it back
 * (property-tested on the same generators, and on links nested past the round
 * budget; '://[a]: b', whose scrub exposes a reference definition, is a
 * deterministic case).
 *
 * A "bare domain" is a dotted run of labels (letters of any script, combining
 * marks, digits, "_" or "-", joined by "." or an IDNA separator; percent escapes
 * are read both as written and decoded, so "%2E" is a separator and the label
 * characters "2E", and "%6F", "%C3%B3", "%E3%80%82" and "%E2%80%8B" are "o",
 * U+00F3, a separator and nothing) in which some label after the first, with
 * combining marks deleted, begins with 2-63 letters; anything after that letter
 * run is decoration ("evil.com-/reset", "evil.co<U+0332>m", "evil.com1" are
 * domains; xn-- A-labels are covered). An
 * IPv4 literal is a run of four or more numeric labels (optionally decorated
 * with "-"/"_"); an IPv6 literal is a (bracketed) colon-hex group sequence with
 * "::" or eight groups. Spelled-out or visibly spaced forms ("evil dot com",
 * "evil . com", a line break between labels), single-integer IPv4
 * ("3405803783", "0xCB007107") and TLD labels that start with a digit, "-" or
 * "_" are not domains under this definition (host-literals.ts; README, known
 * limitations).
 *
 * Rendering effects on prose (README, known limitations): removing joiners and
 * variation selectors splits emoji ZWJ sequences into separate glyphs, turns
 * emoji presentation into text presentation ("U+2764 U+FE0F" becomes U+2764, a
 * keycap loses U+FE0F) and changes Persian or Devanagari shaping where
 * ZWNJ/ZWJ was used. Format characters that render visibly are removed too: the
 * prepended concatenation marks (U+0600-0605, U+06DD, U+070F, U+0890-0891,
 * U+08E2, U+110BD, U+110CD: a sign drawn across the digits after it, which are
 * kept) and the Egyptian hieroglyph format controls; so are the
 * default-ignorable Hangul fillers (letters) and Khmer inherent vowels, and
 * U+2800 (a blank braille cell). A subdivision flag (Scotland, Wales, England) is
 * built from tag characters: it becomes a plain black flag and the item is
 * quarantined (HIDDEN_TAG_CHARACTERS), a false positive that fails closed.
 *
 * Sanitization time is linear in the input (VSP-KN-02): element matching
 * (blocks, anchors) pairs opening and closing tags in one pass (markup.ts)
 * instead of lazy cross-tag regexes, `<tag ...>` patterns are evaluated only up
 * to the last ">", host literals are found by a linear scan that memoizes path
 * ends (host-literals.ts), trailing punctuation and slashes are trimmed by
 * backward scans instead of `[...]+$` regexes, and every remaining quantifier
 * is delimiter-bounded or capped, so the work per start position is bounded by
 * a constant (at most the 2 000-character link-target cap of the markdown link
 * and autolink patterns). Entity decoding and the normalization after each
 * decode run at most MAX_ENTITY_DECODES times per pass, a pass at most
 * MAX_PASSES times per round, the hard scrub at most MAX_HARD_SCRUB_STEPS + 1
 * steps per round (a text still changing then fails closed as "") and a round
 * at most MAX_ROUNDS + 1 times (the last one only confirms a fixpoint), each a
 * linear step. Timing tests at 20 000 and 40 000 characters, and growth-ratio
 * tests from 5 000 to 40 000 (sanitizer, including a hard-scrub chain) and
 * 10 000 to 160 000 characters (re-check), check this. Combined with the input
 * cap this bounds sanitization time; there is no wall-clock deadline (output
 * must stay deterministic for content digests).
 *
 * Findings are reason codes. QUARANTINE-level findings (executable or embedded
 * content) make the ingestion pipeline quarantine the item; STRIP-level
 * findings (formatting, links) are recorded and the cleaned text is kept.
 */
import { containsInvisibleOrControl, containsTagCharacters, decodeTagCharacters, stripControl, stripInvisible } from "../privacy/patterns.js";
import { IDNA_DOTS, hostLiterals, hostSpans, normalizeHost, replaceSpans } from "./host-literals.js";
import { HTML_LEGACY_REFERENCES, HTML_NAMED_REFERENCES, MAX_LEGACY_REFERENCE_LENGTH } from "./html-entities.js";
import { replaceElements, replaceTags } from "./markup.js";
import { MAX_BODY_CHARS } from "./schema.js";

export type SanitizeFindingCode =
  | "HTML_MARKUP_STRIPPED"
  | "HTML_COMMENT_REMOVED"
  | "SCRIPT_OR_STYLE_REMOVED"
  | "EMBEDDED_OBJECT_REMOVED"
  | "EVENT_HANDLER_REMOVED"
  | "EXECUTABLE_URI_REMOVED"
  | "DATA_URI_REMOVED"
  | "CODE_BLOCK_REMOVED"
  | "INLINE_CODE_REMOVED"
  | "EXECUTABLE_ATTACHMENT_REMOVED"
  | "ATTACHMENT_REMOVED"
  | "LINK_REWRITTEN_ALLOWLISTED"
  | "LINK_REMOVED"
  | "URL_REMOVED"
  | "INVISIBLE_CHARACTERS_REMOVED"
  | "HIDDEN_TAG_CHARACTERS"
  | "ENTITY_DECODE_LIMIT_EXCEEDED"
  | "SANITIZER_HARD_SCRUB_APPLIED"
  | "SANITIZER_INPUT_TOO_LARGE";

/** Findings that indicate executable or embedded content: the item is quarantined. */
export const QUARANTINE_FINDINGS: ReadonlySet<SanitizeFindingCode> = new Set([
  // Tag-character smuggling hides text from readers and matchers alike (VSP-KN-01).
  "HIDDEN_TAG_CHARACTERS",
  // Entities nested deeper than the decode budget: never served as literal entity text (VSP-KN-01).
  "ENTITY_DECODE_LIMIT_EXCEEDED",
  "SCRIPT_OR_STYLE_REMOVED",
  "EMBEDDED_OBJECT_REMOVED",
  "EVENT_HANDLER_REMOVED",
  "EXECUTABLE_URI_REMOVED",
  "DATA_URI_REMOVED",
  "CODE_BLOCK_REMOVED",
  "EXECUTABLE_ATTACHMENT_REMOVED",
  "SANITIZER_HARD_SCRUB_APPLIED",
  "SANITIZER_INPUT_TOO_LARGE",
]);

/**
 * Hard cap on sanitizer input, checked on the raw input and again after NFKC
 * (which can expand a character up to 18-fold). Twice the schema's body bound
 * leaves room for ordinary normalization; anything larger fails closed.
 */
export const MAX_SANITIZE_INPUT_CHARS = 2 * MAX_BODY_CHARS;

export interface SanitizeOptions {
  /** Exact approved hosts whose links may be kept as plain text. Lowercase, no scheme. */
  allowedLinkDomains?: readonly string[];
}

export interface SanitizeResult {
  text: string;
  findings: SanitizeFindingCode[];
  quarantineFindings: SanitizeFindingCode[];
  /**
   * ASCII hidden in Unicode tag characters, raw or entity-encoded, decoded so injection detection
   * can inspect it ("" when there is none). Never stored or served.
   */
  hiddenText: string;
}

const MAX_PASSES = 6;

const BLOCK_NAMES = "script|style|iframe|object|embed|applet|form|noscript|template|svg|math|frameset|frame|base|link|meta";
/** "<name" prefix of an executable/embedded block element (paired with BLOCK_CLOSE by replaceElements). */
const BLOCK_OPEN = new RegExp(`<\\s*(${BLOCK_NAMES})\\b`, "gi");
const BLOCK_CLOSE = new RegExp(`<\\s*\\/\\s*(${BLOCK_NAMES})\\s*>`, "gi");
const UNCLOSED_BLOCK = /<\s*(script|style|iframe|object|embed|applet|form|noscript|template|svg|math)\b[\s\S]*$/i;
// `<prefix>[^>]*>` patterns: applied only up to the last ">" (replaceTags), which makes them linear.
const VOID_EMBED = /<\s*(iframe|object|embed|applet|base|link|meta|frame|input|button)\b[^>]*>/gi;
const IMG_TAG = /<\s*img\b[^>]*>/gi;
// Equivalent to /<[^>]*\son.../ (the last bracket before the attribute is "<") without its O(n^2) rescans.
const EVENT_HANDLER = /<[^<>]*\son[a-z]{2,20}\s*=/i;
const HTML_COMMENT = /<!--[\s\S]*?(?:-->|$)/g;
const ANCHOR_OPEN = /<(a)\b/gi;
const ANCHOR_CLOSE = /<\s*\/\s*(a)\s*>/gi;
const HREF_ATTR = /\bhref\s*=\s*(["']?)([^"'\s>]*)\1/i;
const TAG = /<\/?[A-Za-z!?][^<>]*>/g;
const FENCED = /(```|~~~)[\s\S]*?(?:\1|$)/g;
// Capped runs that must end at a delimiter use the atomic idiom `(?=(X{0,n}))\k`: a shorter run can
// never be followed by the delimiter, so forbidding the backtrack keeps the semantics and removes the
// per-start backtracking over the cap (VSP-KN-02).
const INLINE_CODE = /`(?=([^`\n]{0,400}))\1`/g;
const MD_IMAGE = /!\[(?=([^\]\n]{0,400}))\1\]\((?=([^)\n]{0,2000}))\2\)/g;
const MD_LINK = /\[(?=([^\]\n]{0,400}))\1\]\(\s*<?(?=([^)\s>]{0,2000}))\2>?(?:\s+["'][^"'\n]{0,200}["'])?\s*\)/g;
const MD_REF_DEF = /^[ \t]{0,3}\[[^\]\n]{1,200}\]:[ \t]*\S+.*$/gm;
const MD_REF_LINK = /\[(?=([^\]\n]{1,400}))\1\]\[(?=([^\]\n]{0,200}))\2\]/g;
// An autolink cannot contain "<" (CommonMark); excluding it ends every attempt at the next tag.
const AUTOLINK = /<((?:https?|mailto|ftp):[^<>\s]{1,2000})>/gi;
const EXEC_URI = /(?:javascript|vbscript|livescript)\s*:[^\s]*/gi;
const DATA_URI = /\bdata\s*:\s*[a-z]+\/[a-z0-9.+-]+[;,][^\s]*/gi;
const SCHEME_URL = /(?<![a-z0-9+.-])[a-z][a-z0-9+.-]{1,15}:\/\/[^\s<>"'`)\]]*/gi;
const PROTOCOL_RELATIVE = /(^|[\s(["'])\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+[^\s<>"'`)\]]*/gi;
const WWW = /www\.[^\s<>"'`)\]]*/gi;
const OTHER_URI = /\b(?:file|mailto|tel|sip|sips|callto|sms|ftp|ws|wss)\s*:[^\s]*/gi;
const EXEC_FILE = /\b[\w.-]{1,120}\.(?:exe|bat|cmd|ps1|psm1|sh|bash|vbs|vbe|js|jse|wsf|msi|scr|jar|apk|dmg|pkg|hta|lnk|iso|docm|xlsm|pptm|dll|bin)\b/gi;
const ATTACHMENT_REF = /\b(?:attachment|attached file|download)\s*:\s*\S+/gi;

const HEX_REFERENCE = /&#x([0-9a-f]{1,6});?/gi;
const DECIMAL_REFERENCE = /&#(\d{1,7});?/g;
/** "&" + an ASCII alphanumeric run + an optional ";": every candidate named reference (namedReferenceMatch decides). */
const NAMED_CANDIDATE = /&([A-Za-z0-9]+)(;?)/g;

/**
 * The named reference at a candidate, with HTML tokenizer semantics (WHATWG "named character
 * reference state", text content): the longest identifier in the table wins. "run;" is a match
 * when `run` is a name; otherwise the longest prefix of `run` that is a legacy name matches without
 * ";" ("&eacute.com", "&notit;" = U+00AC + "it;"). Names are case-sensitive and any other name
 * needs its ";": "HR&IT", "Rock&Grave" and "&Amp;" are not references. Returns the decoded
 * characters and the part of the candidate it did not consume, or null.
 */
function namedReferenceMatch(run: string, semicolon: string): { value: string; rest: string } | null {
  if (semicolon === ";") {
    const value = HTML_NAMED_REFERENCES.get(run);
    if (value !== undefined) return { value, rest: "" };
  }
  for (let len = Math.min(run.length, MAX_LEGACY_REFERENCE_LENGTH); len >= 2; len -= 1) {
    const prefix = run.slice(0, len);
    if (HTML_LEGACY_REFERENCES.has(prefix)) return { value: HTML_NAMED_REFERENCES.get(prefix) ?? "", rest: `${run.slice(len)}${semicolon}` };
  }
  return null;
}

/**
 * One decode of every numeric reference and every HTML named reference (the full WHATWG table in
 * html-entities.ts, with the tokenizer's matching rules). Every named reference a browser decodes
 * is decoded here, so text with no reference left cannot render or read as anything other than
 * what the sanitizer inspected. The earlier 60-name table, looked up case-insensitively with ";"
 * optional, left "caf&eacute;.com" and "&copf;&oopf;&mopf;" (NFKC "com") as literal entity text that
 * hid the host, and turned "HR&IT" into "HR" + U+2062 INVISIBLE TIMES (VSP-KN-01).
 */
function decodeEntitiesOnce(s: string): string {
  return s
    .replace(HEX_REFERENCE, (_m, hex: string) => safeCodePoint(Number.parseInt(hex, 16)))
    .replace(DECIMAL_REFERENCE, (_m, dec: string) => safeCodePoint(Number.parseInt(dec, 10)))
    .replace(NAMED_CANDIDATE, (m, run: string, semicolon: string) => {
      const ref = namedReferenceMatch(run, semicolon);
      return ref === null ? m : `${ref.value}${ref.rest}`;
    });
}

/**
 * Replaces every reference decodeEntitiesOnce would decode with a space. A space cannot complete a
 * reference, and whether "&..." is a reference depends only on the characters after "&", so one
 * sweep leaves none (used when the decode budget is exhausted: fail closed).
 */
function removeEntityReferences(s: string): string {
  return s
    .replace(HEX_REFERENCE, " ")
    .replace(DECIMAL_REFERENCE, " ")
    .replace(NAMED_CANDIDATE, (m, run: string, semicolon: string) => {
      const ref = namedReferenceMatch(run, semicolon);
      return ref === null ? m : ` ${ref.rest}`;
    });
}

function safeCodePoint(cp: number): string {
  if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return "";
  return String.fromCodePoint(cp);
}

/** Entity decodes per call; legitimate exports are at most double- or triple-encoded. */
const MAX_ENTITY_DECODES = 8;

/**
 * The input with HTML entities decoded to a fixpoint (at most MAX_ENTITY_DECODES rounds) and
 * nothing else changed: markup, invisible and control characters stay, so injection detection can
 * inspect content the sanitizer strips (an instruction inside an HTML comment) and read an
 * entity-encoded invisible or control character both as nothing and as a word break. Each decode
 * looks at the NFKC form, as the sanitizer's does, so a reference that only NFKC completes (a
 * fullwidth "&#xff06;#x69;" inside a comment) is decoded too; the text returned is the last decode
 * itself, not its NFKC form (detectInjection applies NFKC after reading word breaks).
 */
export function decodeEntitiesForDetection(text: string): string {
  let cur = text;
  for (let i = 0; i < MAX_ENTITY_DECODES; i += 1) {
    const folded = cur.normalize("NFKC");
    const next = decodeEntitiesOnce(folded);
    if (next === folded) break;
    cur = next;
  }
  return cur;
}

/** Thrown when normalization grows the text past MAX_SANITIZE_INPUT_CHARS; sanitizeKnowledgeText fails closed. */
class InputTooLarge extends Error {}

interface PipelineState {
  findings: Set<SanitizeFindingCode>;
  /** Tag-encoded ASCII decoded at every normalization step, raw or entity-decoded (VSP-KN-01). */
  hidden: string[];
  /** Enforce MAX_SANITIZE_INPUT_CHARS after every NFKC (the sanitizer); the re-check runs uncapped. */
  capped: boolean;
}

const newState = (capped: boolean): PipelineState => ({ findings: new Set(), hidden: [], capped });

/**
 * One normalization step. It runs on the raw input and again after EVERY entity decode, so a
 * character that only an entity produced (&#x200b;, &#x81;, &#xe0049;, &#x2024;) is normalized
 * and stripped exactly like its raw form: NFKC (cap re-checked), the IDNA separators folded to ".",
 * tag characters recorded and decoded for inspection, then every invisible / default-ignorable
 * character and every C0/C1 control other than tab and newline removed.
 */
function normalizeStep(s: string, st: PipelineState): string {
  const nfkc = s.normalize("NFKC");
  if (st.capped && nfkc.length > MAX_SANITIZE_INPUT_CHARS) throw new InputTooLarge();
  const folded = nfkc.replace(IDNA_DOTS, ".");
  if (containsTagCharacters(folded)) {
    st.findings.add("HIDDEN_TAG_CHARACTERS");
    st.hidden.push(decodeTagCharacters(folded));
  }
  const visible = stripControl(stripInvisible(folded));
  if (visible !== folded.replace(/\r\n?/g, "\n")) st.findings.add("INVISIBLE_CHARACTERS_REMOVED");
  return visible;
}

/**
 * Decodes HTML entities to a fixpoint, normalizing after every decode, so the result contains no
 * decodable reference and is stable under normalizeStep. A reference still decodable after
 * MAX_ENTITY_DECODES rounds fails closed: ENTITY_DECODE_LIMIT_EXCEEDED (quarantine) and every
 * remaining reference is removed, never served as literal nested entity text.
 */
function decodeToFixpoint(input: string, st: PipelineState): string {
  let cur = normalizeStep(input, st);
  for (let i = 0; i < MAX_ENTITY_DECODES; i += 1) {
    const next = decodeEntitiesOnce(cur);
    if (next === cur) return cur;
    cur = normalizeStep(next, st);
  }
  if (decodeEntitiesOnce(cur) === cur) return cur;
  st.findings.add("ENTITY_DECODE_LIMIT_EXCEEDED");
  return removeEntityReferences(cur);
}

/** Normalizes an allowlist entry; invalid entries are dropped (never widen). */
export function normalizeAllowedDomains(domains: readonly string[] | undefined): Set<string> {
  const out = new Set<string>();
  for (const d of domains ?? []) {
    const v = String(d).trim().toLowerCase();
    if (/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/.test(v)) out.add(v);
  }
  return out;
}

function hostAllowed(host: string, allowed: ReadonlySet<string>): boolean {
  return allowed.has(normalizeHost(host).replace(/\.$/, ""));
}

/** Sentence punctuation that may follow a URL or host literal without belonging to it. */
const TRAILING_PUNCTUATION = ".,;:!?";

/**
 * The trailing run of `s` made of characters in `chars`, found by a backward
 * scan. A `[...]+$` regex is O(n^2) on a long run that is not at the end (it
 * rescans the run from every start), which a path such as "a.bc/" + 20 000
 * commas + "x" would trigger (VSP-KN-02).
 */
function trailingRun(s: string, chars: string): string {
  let i = s.length;
  while (i > 0 && chars.includes(s.charAt(i - 1))) i -= 1;
  return s.slice(i);
}

function trimTrailing(s: string, chars: string): string {
  return s.slice(0, s.length - trailingRun(s, chars).length);
}

/**
 * Plain-text rendering of an allowlisted link: "host/path" without scheme,
 * credentials, port, query or fragment. A path is kept only when it is short,
 * carries no long digit run and no "." (a dotted path segment would itself read
 * as a domain). Returns null when not allowlisted.
 */
export function plainTextLink(target: string, allowed: ReadonlySet<string>): string | null {
  let t = target.trim();
  if (/^www\./i.test(t)) t = `https://${t}`;
  if (!/^https?:\/\//i.test(t) && /^[a-z0-9.-]+\.[a-z]{2,24}(?:\/|$)/i.test(t)) t = `https://${t}`;
  let url: URL;
  try {
    url = new URL(t);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  if (!hostAllowed(url.hostname, allowed)) return null;
  const path = trimTrailing(url.pathname, "/");
  const safePath = /^[/A-Za-z0-9_~-]{0,120}$/.test(path) && !/\d{4,}/.test(path) ? path : "";
  return `${url.hostname.toLowerCase()}${safePath}`;
}

function onePass(input: string, allowed: ReadonlySet<string>, st: PipelineState): string {
  const { findings } = st;
  let s = decodeToFixpoint(input, st);
  const record = (re: RegExp, code: SanitizeFindingCode) => {
    re.lastIndex = 0;
    if (re.test(s)) findings.add(code);
    re.lastIndex = 0;
  };

  record(HTML_COMMENT, "HTML_COMMENT_REMOVED");
  s = s.replace(HTML_COMMENT, " ");
  if (EVENT_HANDLER.test(s)) findings.add("EVENT_HANDLER_REMOVED");

  // Executable / embedded blocks with their content.
  s = replaceElements(
    s,
    BLOCK_OPEN,
    BLOCK_CLOSE,
    () => "",
    (tag) => {
      findings.add(/^(script|style|noscript|template|svg|math)$/i.test(tag) ? "SCRIPT_OR_STYLE_REMOVED" : "EMBEDDED_OBJECT_REMOVED");
      return " ";
    },
  );
  const unclosed = UNCLOSED_BLOCK.exec(s);
  if (unclosed) {
    findings.add(/^(iframe|object|embed|applet|form)$/i.test(unclosed[1] ?? "") ? "EMBEDDED_OBJECT_REMOVED" : "SCRIPT_OR_STYLE_REMOVED");
    s = s.slice(0, unclosed.index);
  }
  s = replaceTags(s, VOID_EMBED, () => {
    findings.add("EMBEDDED_OBJECT_REMOVED");
    return " ";
  });

  // Code (executable content).
  record(FENCED, "CODE_BLOCK_REMOVED");
  s = s.replace(FENCED, " ");
  record(INLINE_CODE, "INLINE_CODE_REMOVED");
  s = s.replace(INLINE_CODE, " ");

  // URIs that execute or embed content.
  record(EXEC_URI, "EXECUTABLE_URI_REMOVED");
  s = s.replace(EXEC_URI, " ");
  record(DATA_URI, "DATA_URI_REMOVED");
  s = s.replace(DATA_URI, " ");

  // Images, attachments, executable file references.
  record(MD_IMAGE, "ATTACHMENT_REMOVED");
  s = s.replace(MD_IMAGE, " ");
  s = replaceTags(s, IMG_TAG, () => {
    findings.add("ATTACHMENT_REMOVED");
    return " ";
  });
  record(ATTACHMENT_REF, "ATTACHMENT_REMOVED");
  s = s.replace(ATTACHMENT_REF, " ");
  record(EXEC_FILE, "EXECUTABLE_ATTACHMENT_REMOVED");
  s = s.replace(EXEC_FILE, " ");

  // Links: keep text; keep allowlisted target as plain text only.
  const rewriteLink = (text: string, target: string): string => {
    const plain = plainTextLink(target, allowed);
    if (plain) {
      findings.add("LINK_REWRITTEN_ALLOWLISTED");
      return `${text} (${plain})`;
    }
    findings.add("LINK_REMOVED");
    return text;
  };
  s = s.replace(AUTOLINK, (_m, target: string) => rewriteLink("", target));
  s = replaceElements(
    s,
    ANCHOR_OPEN,
    ANCHOR_CLOSE,
    (tag) => HREF_ATTR.exec(tag)?.[2] ?? null,
    (_name, target, text) => rewriteLink(text, target),
  );
  s = s.replace(MD_LINK, (_m, text: string, target: string) => rewriteLink(text, target));
  record(MD_REF_DEF, "LINK_REMOVED");
  s = s.replace(MD_REF_DEF, " ");
  s = s.replace(MD_REF_LINK, (_m, text: string) => text);

  // Remaining markup.
  record(TAG, "HTML_MARKUP_STRIPPED");
  s = s.replace(TAG, " ");
  if (/[<>]/.test(s)) findings.add("HTML_MARKUP_STRIPPED");
  s = s.replace(/[<>]/g, " ");

  // Raw URLs, bare domains and IP literals.
  const urlReplacer = (m: string) => {
    const trail = trailingRun(m, TRAILING_PUNCTUATION);
    const plain = plainTextLink(m.slice(0, m.length - trail.length), allowed);
    if (plain) {
      findings.add("LINK_REWRITTEN_ALLOWLISTED");
      return `${plain}${trail}`;
    }
    findings.add("URL_REMOVED");
    return ` ${trail}`;
  };
  s = s.replace(SCHEME_URL, urlReplacer);
  s = s.replace(PROTOCOL_RELATIVE, (_m, lead: string) => {
    findings.add("URL_REMOVED");
    return `${lead} `;
  });
  s = s.replace(WWW, urlReplacer);
  record(OTHER_URI, "URL_REMOVED");
  s = s.replace(OTHER_URI, " ");
  s = replaceSpans(s, hostSpans(s, (h) => hostAllowed(h, allowed)), (span, m) => {
    const trail = trailingRun(m, TRAILING_PUNCTUATION);
    if (span.allowedHost !== null) return `${plainTextLink(m.slice(0, m.length - trail.length), allowed) ?? span.allowedHost}${trail}`;
    findings.add("URL_REMOVED");
    return ` ${trail}`;
  });
  return s;
}

function normalizeWhitespace(s: string): string {
  return s
    .replace(/\t/g, " ")
    .split("\n")
    .map((line) => line.replace(/ {2,}/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Output-invariant violations (empty = clean). Used by the sanitizer on its own output and by the
 * retrieval re-check on stored titles and excerpts. Every construct check runs on two readings and
 * reports the union: the text as stored, and the text normalized, entity-decoded and stripped
 * exactly as the sanitizer does (decodeToFixpoint). The second reading sees a host that an
 * invisible, control or entity-encoded character splits in a row stored by an older sanitizer; the
 * first sees what NFKC would destroy before the second looks ("<" + U+0338 composes to U+226E, and
 * "evil<U+2474>.com" becomes "evil(1).com", no host), which a stored row written by no sanitizer
 * version can still serve as written. Any hidden character left in the text, and any entity
 * reference decodable as written or after NFKC (a stored fullwidth "<U+FF06>#x200b;" is "&#x200b;"
 * to the sanitizer), is a violation itself: the sanitizer never outputs either.
 */
export function sanitizedTextViolations(text: string, allowedDomains?: readonly string[]): string[] {
  const allowed = normalizeAllowedDomains(allowedDomains);
  const v: string[] = [];
  if (containsInvisibleOrControl(text)) v.push("INVISIBLE_OR_CONTROL_CHARACTER");
  const folded = text.normalize("NFKC");
  if (decodeEntitiesOnce(text) !== text || decodeEntitiesOnce(folded) !== folded) v.push("ENTITY_REFERENCE");
  const seen = decodeToFixpoint(text, newState(false));
  const readings = seen === text ? [text] : [text, seen];
  const found = (re: RegExp): boolean => readings.some((r) => re.test(r));
  if (found(/[<>]/)) v.push("ANGLE_BRACKET");
  if (found(/:\/\//)) v.push("SCHEME_SEPARATOR");
  if (found(/www\./i)) v.push("WWW_HOST");
  if (found(/(?:java|vb|live)script\s*:/i)) v.push("EXECUTABLE_URI");
  if (found(/\bdata\s*:\s*[a-z]+\/[a-z0-9.+-]+[;,]/i)) v.push("DATA_URI");
  const literals = readings.flatMap((r) => hostLiterals(r));
  if (literals.some((l) => l.kind === "DOMAIN" && !hostAllowed(l.host, allowed))) v.push("BARE_DOMAIN_NOT_ALLOWLISTED");
  if (literals.some((l) => l.kind !== "DOMAIN")) v.push("IP_LITERAL");
  return v;
}

/**
 * One hard-scrub step: normalize, decode and strip the text as the sanitizer does (the second reading
 * sanitizedTextViolations inspects), then remove every construct an output invariant forbids. The scrub
 * stops only at a step that changes nothing, where the text as stored (the first reading) is that
 * scrubbed form itself.
 */
function hardScrubStep(text: string, allowed: ReadonlySet<string>): string {
  const s = decodeToFixpoint(text, newState(false))
    .replace(/[<>]/g, "")
    .replace(/:\/\//g, " ")
    .replace(/www\./gi, " ")
    .replace(/(?:java|vb|live)script\s*:/gi, " ")
    .replace(/\bdata\s*:\s*[a-z]+\/[a-z0-9.+-]+[;,]/gi, " ");
  // An allowlisted span keeps only its host: port and path (which may hold more literals) go.
  return replaceSpans(s, hostSpans(s, (h) => hostAllowed(h, allowed)), (span) => (span.allowedHost !== null ? span.allowedHost : " "));
}

/**
 * Hard-scrub steps before the scrub gives up. Each step is linear; a removal can expose one more
 * construct ("data:" nested k deep before "text/plain," needs k steps), so an unbounded loop cost
 * O(k * n): about 0.9 s at 40 000 characters (VSP-KN-02).
 */
const MAX_HARD_SCRUB_STEPS = 16;

/**
 * Last-resort removal guaranteeing the output invariants: hard-scrub steps until one changes
 * nothing. A text still changing after MAX_HARD_SCRUB_STEPS fails closed as "" (the item is
 * already quarantined with SANITIZER_HARD_SCRUB_APPLIED), which keeps sanitization linear.
 */
function hardScrub(text: string, allowed: ReadonlySet<string>): string {
  let s = text;
  for (let i = 0; i < MAX_HARD_SCRUB_STEPS; i += 1) {
    const next = hardScrubStep(s, allowed);
    if (next === s) return s;
    s = next;
  }
  return hardScrubStep(s, allowed) === s ? s : "";
}

function tooLarge(): SanitizeResult {
  return { text: "", findings: ["SANITIZER_INPUT_TOO_LARGE"], quarantineFindings: ["SANITIZER_INPUT_TOO_LARGE"], hiddenText: "" };
}

/**
 * One round: passes until stable (at most MAX_PASSES), entity check, whitespace normalization and,
 * if an output invariant still fails, the hard scrub. `stable` is true when the last pass changed
 * nothing and neither did anything after it, so the output is a fixpoint of the whole pipeline.
 */
function sanitizeRound(input: string, allowed: ReadonlySet<string>, st: PipelineState): { text: string; stable: boolean } {
  let cur = input;
  let converged = false;
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const next = onePass(cur, allowed, st);
    if (next === cur) {
      converged = true;
      break;
    }
    cur = next;
  }
  const passed = cur;
  // Link rewriting in the last allowed pass can complete a reference that no pass is left to decode.
  if (decodeEntitiesOnce(cur) !== cur) {
    st.findings.add("ENTITY_DECODE_LIMIT_EXCEEDED");
    cur = removeEntityReferences(cur);
  }
  let out = normalizeWhitespace(cur);
  if (sanitizedTextViolations(out, [...allowed]).length > 0) {
    st.findings.add("SANITIZER_HARD_SCRUB_APPLIED");
    out = normalizeWhitespace(hardScrub(out, allowed));
  }
  return { text: out, stable: converged && out === passed };
}

/**
 * Rounds of the pipeline until its output is a fixpoint, which makes the sanitizer idempotent:
 * whitespace normalization and the hard scrub can expose more content to remove (a "[a]: b"
 * reference definition that only starts its line once "://" is scrubbed). A text still changing
 * after MAX_ROUNDS is quarantined with SANITIZER_HARD_SCRUB_APPLIED and, as in hardScrub, kept only
 * when one more round leaves it unchanged, otherwise emptied. Each pass rewrites only the innermost
 * of nested links, so 24 or more nested markdown or reference links do not settle; 25 of them
 * ("[[[x](t0)](t1)...") used to come back as "[x](t24)" the first time and as "x" the second.
 */
const MAX_ROUNDS = 4;

export function sanitizeKnowledgeText(input: string, opts: SanitizeOptions = {}): SanitizeResult {
  if (input.length > MAX_SANITIZE_INPUT_CHARS) return tooLarge();
  const allowed = normalizeAllowedDomains(opts.allowedLinkDomains);
  const st = newState(true);
  let cur: string;
  try {
    cur = normalizeStep(input, st);
    let stable = false;
    for (let round = 0; round < MAX_ROUNDS && !stable; round += 1) {
      const r = sanitizeRound(cur, allowed, st);
      stable = r.stable;
      cur = r.text;
    }
    if (!stable) {
      st.findings.add("SANITIZER_HARD_SCRUB_APPLIED");
      const check = sanitizeRound(cur, allowed, st);
      if (!check.stable || check.text !== cur) cur = "";
    }
  } catch (e) {
    if (e instanceof InputTooLarge) return tooLarge();
    throw e;
  }
  const list = [...st.findings].sort();
  return { text: cur, findings: list, quarantineFindings: list.filter((f) => QUARANTINE_FINDINGS.has(f)), hiddenText: st.hidden.join("\n") };
}
