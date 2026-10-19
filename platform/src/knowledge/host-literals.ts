/**
 * Domain and IP-literal detection for the knowledge sanitizer (VSP-KN-01, spec
 * section 14 "malicious URLs", spec section 9 "sanitize ... links").
 *
 * The sanitizer's output invariant is "no bare domain or IP literal outside the
 * link allowlist". Definitions (deliberately broader than the public suffix
 * list, so a new or uncommon TLD cannot slip through):
 *  - a dotted run is a maximal sequence of labels (letters of any script,
 *    combining marks, digits, "_" or "-") joined by runs of IDNA label
 *    separators (".", U+3002, U+FF0E, U+FF61; "evil..com" is one run);
 *  - percent escapes are read BOTH ways, as a URL parser decodes them inside a
 *    host and as written, and a literal found by any reading is reported. The
 *    decoded readings are length-preserving (offsets stay those of the text):
 *    each escape (one byte, or a well-formed UTF-8 sequence) is folded as the
 *    sanitizer folds the raw character (NFKC, IDNA separators as ".", Cf,
 *    default-ignorable and C0/C1 characters deleted, any other character that
 *    is no label character a break) and padded with combining marks, which
 *    classification deletes; an escape that folds to separators only becomes
 *    as many "." as it is long. So "%2E", "%E3%80%82" (U+3002) and "%E2%80%A4"
 *    (U+2024) are separators, "%6F" and "%C3%B3" the letters "o" and U+00F3,
 *    "%E2%80%8B" nothing, "%C5%80" (U+0140, NFKC "l" + U+00B7) "l" and a break,
 *    and "%20", "%2F", "%25" a break ("%2F203.0.113.7" holds the IPv4 literal
 *    203.0.113.7). Separator escapes and the other escapes are decoded
 *    separately and together (four readings at most), so "evil%2Ecom",
 *    "billing-portal%2Ec%6Fm" and "billing-portal.%63%6F%6D" are domains (a URL
 *    parser resolves the last two to billing-portal.com), while the text as
 *    written still makes "%2E.com/pay" the host 2E.com and
 *    "%2Eportal.synthetic-health.test" the non-allowlisted host
 *    2Eportal.synthetic-health.test. A malformed, overlong or surrogate
 *    sequence is kept as written, and only one level is decoded: "%252E" stays
 *    the text "%2E" (README, known limitations);
 *  - labels are classified with combining marks deleted, because a mark does
 *    not change the letters a reader or a text-to-speech voice reproduces
 *    ("co<U+0332>m" reads as "com");
 *  - it is a DOMAIN when some label after the first BEGINS with 2-63 letters.
 *    Whatever follows that letter run is decoration ("com-", "com_", "com1",
 *    "com<U+0660>", "com-x" and xn-- A-labels all count), so
 *    "account-help.support", "billing-portal.cc", "evil.com-/reset" and
 *    "portal<U+3002>evil<U+3002>com" are domains, while "2.5", "v1.2", "a.m",
 *    "9.30am" and "2.5GB" are not (a label that starts with a digit, "-" or "_"
 *    is not a TLD: see README, known limitations);
 *  - it is an IPV4 literal when it has four or more numeric labels (decimal in
 *    any script's digits, or 0x-hex, covering dotted-quad and its octal/hex
 *    spellings), each optionally led or trailed by "-"/"_" decoration
 *    ("203.0.113.7-/login");
 *  - an IPV6 literal is a colon-hex sequence of 3-8 groups (optionally in
 *    brackets) that contains "::" or has all eight groups; "10:30:00" is not
 *    (every reading here too: "%2Effc::1" is ffc::1 after a dot and "%2E::" is
 *    2E::; the padding after a decoded hex digit or colon ends a group, so an
 *    IPv6 literal spelled with escaped hex digits or colons is found only in
 *    the parts the text as written shows, such as "66::1" in "%66%66::1").
 * A port and a path directly after a domain, IPv4 or bracketed IPv6 belong to
 * the literal.
 *
 * Time is linear in the text length (VSP-KN-02). Each regex attempt starts at a
 * label (or hex-group) start and fails in time bounded by that label and the
 * separator run after it, and the classes on either side of every quantifier
 * are disjoint; a text holding a percent escape is scanned once per distinct
 * reading (at most four times), and building a reading costs O(1) per escape.
 * Literals are reported even when they sit inside an earlier literal's path,
 * because hostSpans() and the retrieval re-check need them; the end of a path
 * (the next delimiter) is therefore memoized, so a path shared by many literals
 * is scanned once instead of once per literal (a repeated "a.bc/" unit used to
 * cost O(n^2)).
 */
import { stripControl, stripInvisible } from "../privacy/patterns.js";

/** IDNA label separators other than "." (UTS #46); NFKC already folds U+FF0E, U+2024 and U+FE52 to ".". */
export const IDNA_DOTS = /[\u3002\uFF0E\uFF61]/g;
const DOT_CLASS = ".\\u3002\\uFF0E\\uFF61";
const LABEL_CLASS = "\\p{L}\\p{M}\\p{N}_\\-";
/**
 * A maximal dotted run of labels. The lookbehind makes every attempt start at a
 * label start, and no separator is a label character, so a failing attempt
 * costs O(label + following separator run) and the whole scan is linear.
 */
const DOTTED_RUN = new RegExp(`(?<![${LABEL_CLASS}])[${LABEL_CLASS}]+(?:[${DOT_CLASS}]+[${LABEL_CLASS}]+)+`, "gu");
/**
 * A run of percent escapes. A URL parser decodes escapes inside a host
 * ("billing-portal%2Ecom", "billing-portal%2Ec%6Fm" and
 * "billing-portal.%63%6F%6D" are all billing-portal.com) and a model may read
 * them decoded. The decoded readings are separate scans of a same-length copy of
 * the text (offsets stay valid): matching "%2E" as a separator alternative
 * instead would let the "2E" label characters inside a long "%2E%2E..." run
 * start an attempt each, a quadratic scan (VSP-KN-02). The text as written is
 * scanned too, because a reader may equally take "%2E.com" for the host
 * "2E.com" (the separator reading alone missed it).
 */
const PERCENT_RUN = /(?:%[0-9a-f]{2})+/gi;
/** Pads a decoded escape to the escape's length; classifyLabels deletes combining marks, so the padding reads as nothing. */
const ESCAPE_PAD = "\u0332";
const ONLY_SEPARATORS = /^\.+$/;
const ESCAPE_CHARS = 3;
const UTF8_ONE_BYTE_END = 0x80;
const UTF8_TWO_BYTE_LEAD = 0xc2;
const UTF8_THREE_BYTE_LEAD = 0xe0;
const UTF8_FOUR_BYTE_LEAD = 0xf0;
const UTF8_LEAD_END = 0xf5;
const UTF8_CONTINUATION_MIN = 0x80;
const UTF8_CONTINUATION_MAX = 0xbf;
const UTF8_PAYLOAD_BITS = 6;
const UTF8_PAYLOAD_MASK = 0x3f;

/** Bytes of the UTF-8 sequence a lead byte starts (0 for a continuation or invalid lead byte). */
function utf8SequenceLength(lead: number): number {
  if (lead < UTF8_ONE_BYTE_END) return 1;
  if (lead < UTF8_TWO_BYTE_LEAD) return 0;
  if (lead < UTF8_THREE_BYTE_LEAD) return 2;
  if (lead < UTF8_FOUR_BYTE_LEAD) return 3;
  return lead < UTF8_LEAD_END ? 4 : 0;
}

/** The allowed range of the byte after `lead` (Unicode Table 3-7: no overlong form, no surrogate, nothing past U+10FFFF). */
function secondByteRange(lead: number): [number, number] {
  if (lead === 0xe0) return [0xa0, UTF8_CONTINUATION_MAX];
  if (lead === 0xed) return [UTF8_CONTINUATION_MIN, 0x9f];
  if (lead === 0xf0) return [0x90, UTF8_CONTINUATION_MAX];
  if (lead === 0xf4) return [UTF8_CONTINUATION_MIN, 0x8f];
  return [UTF8_CONTINUATION_MIN, UTF8_CONTINUATION_MAX];
}

/**
 * The character a run of escapes encodes when it is exactly one well-formed UTF-8 sequence (what
 * decodeURIComponent accepts, without its exceptions), otherwise null.
 */
function decodeUtf8Escapes(escapes: string): string | null {
  const byteAt = (k: number): number => Number.parseInt(escapes.slice(ESCAPE_CHARS * k + 1, ESCAPE_CHARS * (k + 1)), 16);
  const lead = byteAt(0);
  const bytes = utf8SequenceLength(lead);
  if (bytes === 0 || bytes * ESCAPE_CHARS !== escapes.length) return null;
  if (bytes === 1) return String.fromCharCode(lead);
  const [lo, hi] = secondByteRange(lead);
  // The lead byte carries 7 - bytes payload bits.
  let cp = lead & ((1 << (7 - bytes)) - 1);
  for (let k = 1; k < bytes; k += 1) {
    const b = byteAt(k);
    if (b < (k === 1 ? lo : UTF8_CONTINUATION_MIN) || b > (k === 1 ? hi : UTF8_CONTINUATION_MAX)) return null;
    cp = (cp << UTF8_PAYLOAD_BITS) | (b & UTF8_PAYLOAD_MASK);
  }
  return String.fromCodePoint(cp);
}

/** A character of a folded escape that is neither a label character nor "." reads as a break (as the raw character does). */
const NOT_LABEL_OR_SEPARATOR = new RegExp(`[^${LABEL_CLASS}.]`, "gu");
const ESCAPE_BREAK = " ";

/**
 * How one escape (a single byte or a whole UTF-8 sequence) reads inside a host, folded as the sanitizer folds
 * the raw character: its NFKC form with IDNA separators as ".", every character stripInvisible or stripControl
 * removes deleted, and every other character that is no label character read as a break. So "%6F" reads "o",
 * "%EF%BD%83" (U+FF43) "c", "%E3%80%82" (U+3002) and "%E2%80%A4" (U+2024) ".", "%E2%80%8B" and "%C2%85" nothing,
 * "%C5%80" (U+0140, NFKC "l" + U+00B7) "l" and a break, and "%20", "%2F" or "%25" a break. Null for a malformed,
 * overlong or surrogate sequence, which a URL parser rejects (kept as written). The one NFKC form longer than its
 * escape (U+FDFA, 18 characters for 9) is cut to the escape's length: a reading never grows the text.
 */
function readEscape(escape: string): string | null {
  const decoded = decodeUtf8Escapes(escape);
  if (decoded === null) return null;
  const folded = stripControl(stripInvisible(decoded.normalize("NFKC").replace(IDNA_DOTS, ".")));
  return folded.slice(0, escape.length).replace(NOT_LABEL_OR_SEPARATOR, ESCAPE_BREAK);
}

/**
 * The text with its escapes read as decoded, length-preserving, so offsets stay those of the text: an escape
 * that reads as separators only is decoded when `separators` and becomes as many "." as the escape is long; any
 * other well-formed escape is decoded when `others` and becomes what it reads as (label characters, separators
 * and breaks, or nothing), padded with ESCAPE_PAD. Every other escape is kept as written. `read` is readEscape,
 * memoized per text: O(1) per escape.
 */
function percentReading(text: string, read: (escape: string) => string | null, separators: boolean, others: boolean): string {
  return text.replace(PERCENT_RUN, (run) => {
    let out = "";
    let i = 0;
    while (i < run.length) {
      const width = ESCAPE_CHARS * utf8SequenceLength(Number.parseInt(run.slice(i + 1, i + ESCAPE_CHARS), 16));
      const reads = width > 0 && i + width <= run.length ? read(run.slice(i, i + width)) : null;
      const separator = reads !== null && ONLY_SEPARATORS.test(reads);
      if (reads === null || !(separator ? separators : others)) {
        out += run.slice(i, i + ESCAPE_CHARS);
        i += ESCAPE_CHARS;
      } else {
        out += separator ? ".".repeat(width) : reads.padEnd(width, ESCAPE_PAD);
        i += width;
      }
    }
    return out;
  });
}

/**
 * The distinct readings of a text: as written, separator escapes decoded, the other escapes decoded, and both.
 * "%2E" alone gives the two readings it always had (separator, and the label characters "2E"); a text with no
 * escape gives one.
 */
function readingsOf(text: string): string[] {
  if (!text.includes("%")) return [text];
  const memo = new Map<string, string | null>();
  const read = (escape: string): string | null => {
    const known = memo.get(escape);
    if (known !== undefined) return known;
    const reads = readEscape(escape);
    memo.set(escape, reads);
    return reads;
  };
  return [...new Set([text, percentReading(text, read, true, false), percentReading(text, read, false, true), percentReading(text, read, true, true)])];
}

/** IPv6 candidate (validated by isIpv6Literal); bounded: at most 9 groups of at most 4 hex digits. */
const IPV6_CANDIDATE = /(?<![\p{L}\p{N}_:])\[?[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,8}\]?/giu;
/**
 * Characters that end a path after a host literal (the same class as the URL
 * patterns in sanitize.ts). Global, used with lastIndex to find the next one.
 */
const PATH_DELIMITER = /[\s<>"'`)\]]/g;
const SEPARATOR_RUN = /[.\u3002\uFF0E\uFF61]+/;
const COMBINING_MARKS = /\p{M}/gu;
/** A TLD-like label (marks already deleted): it begins with 2-63 letters; the rest is decoration. */
const TLD_LABEL = /^\p{L}{2,63}(?!\p{L})/u;
/** A numeric label (marks already deleted): decimal or 0x-hex, optionally led or trailed by "-"/"_". */
const NUMERIC_LABEL = /^[-_]*(?:0x[0-9a-f]{1,8}|\p{Nd}{1,10})[-_]*$/iu;
const HEX_GROUP = /^[0-9a-f]{0,4}$/i;
const ASCII_DIGIT_0 = 48;
const ASCII_DIGIT_9 = 57;
const COLON = 58;
const SLASH = 47;
const MAX_PORT_DIGITS = 5;

export type HostKind = "DOMAIN" | "IPV4" | "IPV6";

export interface HostLiteral {
  start: number;
  /** End of the host itself (exclusive). */
  hostEnd: number;
  /** End including port and path (exclusive). */
  end: number;
  /** Lowercased host with IDNA separators folded to "." (decoration kept, so a decorated host never matches the allowlist). */
  host: string;
  kind: HostKind;
}

export function normalizeHost(host: string): string {
  return host.replace(IDNA_DOTS, ".").toLowerCase();
}

/**
 * Classifies one dotted run under every reading of its percent escapes (decoded, or as written: "%2E" as a
 * label separator or as the label characters "2E"): "evil%2Ecom", "%2E.com" and "evil.c%6Fm" are all
 * domains. Exported for tests.
 */
export function classifyRun(run: string): HostKind | null {
  for (const reading of readingsOf(run)) {
    const kind = classifyLabels(reading);
    if (kind !== null) return kind;
  }
  return null;
}

/** Classifies a run as written (an escape is no separator here; hostLiterals' runs never contain "%"). */
function classifyLabels(run: string): HostKind | null {
  const labels = run
    .replace(COMBINING_MARKS, "")
    .split(SEPARATOR_RUN)
    .filter((l) => l.length > 0);
  if (labels.length >= 4 && labels.every((l) => NUMERIC_LABEL.test(l))) return "IPV4";
  for (let i = 1; i < labels.length; i += 1) {
    if (TLD_LABEL.test(labels[i] ?? "")) return "DOMAIN";
  }
  return null;
}

function isIpv6Literal(candidate: string): boolean {
  const bare = candidate.replace(/^\[/, "").replace(/\]$/, "");
  const groups = bare.split(":");
  if (groups.length < 3 || groups.length > 8) return false;
  if (!groups.every((g) => HEX_GROUP.test(g)) || !groups.some((g) => g.length > 0)) return false;
  return bare.includes("::") || groups.length === 8;
}

/**
 * End of the optional ":port" (1-5 ASCII digits, greedy) and "/path" (up to the
 * next delimiter) after a host literal: exactly the sticky pattern
 * `(?::\d{1,5})?(?:\/[^\s<>"'`)\]]*)?`. The next-delimiter lookup is memoized:
 * there is no delimiter in [from, at), so any later query inside that interval
 * is answered without scanning, and with nondecreasing queries the scanned
 * intervals are disjoint (O(n) in total).
 */
function suffixScanner(text: string): (at: number) => number {
  let memoFrom = -1;
  let memoAt = -1;
  const nextDelimiter = (from: number): number => {
    if (from >= memoFrom && from <= memoAt) return memoAt;
    PATH_DELIMITER.lastIndex = from;
    const m = PATH_DELIMITER.exec(text);
    memoFrom = from;
    memoAt = m ? m.index : text.length;
    return memoAt;
  };
  return (at: number): number => {
    let p = at;
    if (text.charCodeAt(p) === COLON) {
      let digits = 0;
      while (digits < MAX_PORT_DIGITS && isAsciiDigit(text.charCodeAt(p + 1 + digits))) digits += 1;
      if (digits > 0) p += 1 + digits;
    }
    if (text.charCodeAt(p) === SLASH) p = nextDelimiter(p + 1);
    return p;
  };
}

function isAsciiDigit(code: number): boolean {
  return code >= ASCII_DIGIT_0 && code <= ASCII_DIGIT_9;
}

/**
 * Every domain, IPv4 and IPv6 literal in `text`, by position (not merged: overlapping literals are all reported),
 * under every reading of its percent escapes: the text as written ("%2E.com" holds the host 2E.com, "%2E::" the IPv6
 * literal 2E::) and with escapes decoded ("evil%2Ecom", "%2Effc::1" is ".ffc::1", "billing-portal.%63%6F%6D" is a
 * .com host). Offsets and port/path ends are those of `text` in every reading; a literal several readings find is
 * reported once.
 */
export function hostLiterals(text: string): HostLiteral[] {
  const out: HostLiteral[] = [];
  const reported = new Set<string>();
  const report = (lit: HostLiteral): void => {
    const key = `${lit.kind}:${lit.start}:${lit.hostEnd}`;
    if (reported.has(key)) return;
    reported.add(key);
    out.push(lit);
  };
  for (const reading of readingsOf(text)) {
    // Each scan is a left-to-right pass with a fresh memo, which keeps its queries nondecreasing.
    let suffixEnd = suffixScanner(text);
    for (const m of reading.matchAll(DOTTED_RUN)) {
      const kind = classifyLabels(m[0]);
      if (kind === null) continue;
      const hostEnd = m.index + m[0].length;
      report({ start: m.index, hostEnd, end: suffixEnd(hostEnd), host: normalizeHost(m[0]), kind });
    }
    suffixEnd = suffixScanner(text);
    for (const m of reading.matchAll(IPV6_CANDIDATE)) {
      if (!isIpv6Literal(m[0])) continue;
      const hostEnd = m.index + m[0].length;
      report({ start: m.index, hostEnd, end: m[0].endsWith("]") ? suffixEnd(hostEnd) : hostEnd, host: m[0].toLowerCase(), kind: "IPV6" });
    }
  }
  return out.sort((a, b) => a.start - b.start || b.end - a.end);
}

export interface HostSpan {
  start: number;
  end: number;
  /** The allowlisted host when the span is one allowlisted domain (its port/path may still hold more literals). */
  allowedHost: string | null;
}

/**
 * Merges overlapping literals into spans. A span keeps its allowlisted status
 * only while every merged literal lies inside it: an inner literal can only sit
 * in the path, which the caller must drop or reduce.
 */
export function hostSpans(text: string, isAllowed: (host: string) => boolean): HostSpan[] {
  const spans: HostSpan[] = [];
  let cur: HostSpan | null = null;
  for (const lit of hostLiterals(text)) {
    if (cur && lit.start < cur.end) {
      if (lit.end > cur.end) {
        cur.end = lit.end;
        cur.allowedHost = null;
      }
      continue;
    }
    cur = { start: lit.start, end: lit.end, allowedHost: lit.kind === "DOMAIN" && isAllowed(lit.host) ? lit.host : null };
    spans.push(cur);
  }
  return spans;
}

/** Replaces each span with `fn(span, matchedText)`. */
export function replaceSpans(text: string, spans: readonly HostSpan[], fn: (span: HostSpan, matched: string) => string): string {
  if (spans.length === 0) return text;
  let out = "";
  let cursor = 0;
  for (const span of spans) {
    out += text.slice(cursor, span.start) + fn(span, text.slice(span.start, span.end));
    cursor = span.end;
  }
  return out + text.slice(cursor);
}
