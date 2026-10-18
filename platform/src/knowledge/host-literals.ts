/**
 * Domain and IP-literal detection for the knowledge sanitizer (VSP-KN-01, spec
 * section 14 "malicious URLs", spec section 9 "sanitize ... links").
 *
 * The sanitizer's output invariant is "no bare domain or IP literal outside the
 * link allowlist". Definitions (deliberately broader than the public suffix
 * list, so a new or uncommon TLD cannot slip through):
 *  - a dotted run is a maximal sequence of labels (letters of any script,
 *    combining marks, digits, "_" or "-") joined by an IDNA label separator
 *    (".", U+3002, U+FF0E, U+FF61);
 *  - it is a DOMAIN when some label after the first is 2-63 letters or an
 *    xn-- A-label (so "account-help.support", "billing-portal.cc", "evil.zip"
 *    and "portal<U+3002>evil<U+3002>com" all count, while "2.5", "v1.2" and "a.m" do not);
 *  - it is an IPV4 literal when it has four or more numeric labels (decimal or
 *    0x-hex, covering dotted-quad and its octal/hex spellings);
 *  - an IPV6 literal is a colon-hex sequence of 3-8 groups (optionally in
 *    brackets) that contains "::" or has all eight groups; "10:30:00" is not.
 * A port and a path directly after a domain, IPv4 or bracketed IPv6 belong to
 * the literal. Every scan here is linear in the text length.
 */

/** IDNA label separators other than "." (UTS #46); NFKC already folds U+FF0E, U+2024 and U+FE52 to ".". */
export const IDNA_DOTS = /[\u3002\uFF0E\uFF61]/g;
const DOT_CLASS = ".\\u3002\\uFF0E\\uFF61";
const LABEL_CLASS = "\\p{L}\\p{M}\\p{N}_\\-";
/**
 * A maximal dotted run of labels. The lookbehind makes every attempt start at a
 * label start, and no separator is a label character, so a failing attempt
 * costs O(label) and the whole scan is linear.
 */
const DOTTED_RUN = new RegExp(`(?<![${LABEL_CLASS}])[${LABEL_CLASS}]+(?:[${DOT_CLASS}][${LABEL_CLASS}]+)+`, "gu");
/** IPv6 candidate (validated by isIpv6Literal); bounded: at most 9 groups of at most 4 hex digits. */
const IPV6_CANDIDATE = /(?<![\p{L}\p{N}_:])\[?[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,8}\]?/giu;
/** Port and path after a host literal (sticky, applied at the literal's end; same path class as URLs). */
const HOST_SUFFIX = /(?::\d{1,5})?(?:\/[^\s<>"'`)\]]*)?/y;
const SEPARATORS = /[.\u3002\uFF0E\uFF61]/;
const TLD_LABEL = /^(?:\p{L}{2,63}|xn--[a-z0-9-]{1,59})$/iu;
const NUMERIC_LABEL = /^(?:\d{1,10}|0x[0-9a-f]{1,8})$/i;
const HEX_GROUP = /^[0-9a-f]{0,4}$/i;

export type HostKind = "DOMAIN" | "IPV4" | "IPV6";

export interface HostLiteral {
  start: number;
  /** End of the host itself (exclusive). */
  hostEnd: number;
  /** End including port and path (exclusive). */
  end: number;
  /** Lowercased host with IDNA separators folded to ".". */
  host: string;
  kind: HostKind;
}

export function normalizeHost(host: string): string {
  return host.replace(IDNA_DOTS, ".").toLowerCase();
}

function classifyRun(run: string): HostKind | null {
  const labels = run.split(SEPARATORS);
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

/** Every domain, IPv4 and IPv6 literal in `text`, by position (not merged: overlapping literals are all reported). */
export function hostLiterals(text: string): HostLiteral[] {
  const out: HostLiteral[] = [];
  const suffixEnd = (at: number): number => {
    HOST_SUFFIX.lastIndex = at;
    const m = HOST_SUFFIX.exec(text);
    return at + (m ? m[0].length : 0);
  };
  for (const m of text.matchAll(DOTTED_RUN)) {
    const kind = classifyRun(m[0]);
    if (kind === null) continue;
    const hostEnd = m.index + m[0].length;
    out.push({ start: m.index, hostEnd, end: suffixEnd(hostEnd), host: normalizeHost(m[0]), kind });
  }
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
