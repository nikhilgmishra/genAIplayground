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
 *    brackets) that contains "::" or has all eight groups; "10:30:00" is not.
 * A port and a path directly after a domain, IPv4 or bracketed IPv6 belong to
 * the literal.
 *
 * Time is linear in the text length (VSP-KN-02). Each regex attempt starts at a
 * label (or hex-group) start and fails in time bounded by that label and the
 * separator run after it, and the classes on either side of every quantifier
 * are disjoint. Literals are
 * reported even when they sit inside an earlier literal's path, because
 * hostSpans() and the retrieval re-check need them; the end of a path (the next
 * delimiter) is therefore memoized, so a path shared by many literals is scanned
 * once instead of once per literal (a repeated "a.bc/" unit used to cost O(n^2)).
 */

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

/** Classifies one dotted run. Exported for tests. */
export function classifyRun(run: string): HostKind | null {
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

/** Every domain, IPv4 and IPv6 literal in `text`, by position (not merged: overlapping literals are all reported). */
export function hostLiterals(text: string): HostLiteral[] {
  const out: HostLiteral[] = [];
  let suffixEnd = suffixScanner(text);
  for (const m of text.matchAll(DOTTED_RUN)) {
    const kind = classifyRun(m[0]);
    if (kind === null) continue;
    const hostEnd = m.index + m[0].length;
    out.push({ start: m.index, hostEnd, end: suffixEnd(hostEnd), host: normalizeHost(m[0]), kind });
  }
  // A second left-to-right pass: a fresh memo keeps its queries nondecreasing.
  suffixEnd = suffixScanner(text);
  for (const m of text.matchAll(IPV6_CANDIDATE)) {
    if (!isIpv6Literal(m[0])) continue;
    const hostEnd = m.index + m[0].length;
    out.push({ start: m.index, hostEnd, end: m[0].endsWith("]") ? suffixEnd(hostEnd) : hostEnd, host: m[0].toLowerCase(), kind: "IPV6" });
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
