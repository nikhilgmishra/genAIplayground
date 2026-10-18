/**
 * Linear-time markup matching for the knowledge sanitizer (VSP-KN-02, spec
 * section 14 "denial of service": regex backtracking in sanitizers).
 *
 * The sanitizer used lazy cross-tag regexes such as
 *   /<a\b[^>]*?\bhref\s*=\s*(["']?)([^"'\s>]*)\1[^>]*>([\s\S]*?)<\s*\/\s*a\s*>/gi
 * which rescan the rest of the text from every unterminated opening tag: O(n^2)
 * for blocks and O(n^3) for anchors (a 16 KB body of repeated "<a href=" took
 * about 67 s). The helpers below keep the exact match semantics of those
 * regexes while visiting every ">" and every closing tag a bounded number of
 * times. They are internal to the knowledge module (not re-exported).
 */

/**
 * `s.replace(re, fn)` for a global pattern of the form `<prefix>[^>]*>`. Such a
 * match always ends at the first ">" after its prefix, so no match can start
 * after the last ">" and every attempt before it succeeds at the first ">":
 * the replacement is linear instead of rescanning to the end from every "<".
 */
export function replaceTags(s: string, re: RegExp, fn: () => string): string {
  const last = s.lastIndexOf(">");
  if (last < 0) return s;
  re.lastIndex = 0;
  return s.slice(0, last + 1).replace(re, fn) + s.slice(last + 1);
}

/**
 * Linear-time equivalent of
 *   `s.replace(/<OPEN name>[^>]*>([\s\S]*?)<CLOSE same name>/gi, ...)`.
 *
 * `open` (global) matches the "<name" prefix of an opening tag and captures
 * the name; `close` (global) matches a closing tag and captures the name. As in
 * the regex, the opening tag ends at the first ">" after the prefix and the
 * element ends at the first closing tag of the same name that starts after
 * that ">"; matching resumes after the element. `attr` returns the value the
 * element needs from its opening tag ("" when it needs none) or null to reject
 * the tag. A rejected tag is not re-examined from a later start inside it: any
 * such start sees a suffix of the same tag, whose attribute matches are a
 * subset of the rejected tag's (true for `\b`-anchored attribute patterns,
 * because a start is always a "<").
 */
export function replaceElements(
  s: string,
  open: RegExp,
  close: RegExp,
  attr: (tag: string) => string | null,
  fn: (name: string, attrValue: string, inner: string) => string,
): string {
  const closes = new Map<string, { starts: number[]; ends: number[]; next: number }>();
  for (const m of s.matchAll(close)) {
    const name = (m[1] ?? "").toLowerCase();
    let list = closes.get(name);
    if (!list) {
      list = { starts: [], ends: [], next: 0 };
      closes.set(name, list);
    }
    list.starts.push(m.index);
    list.ends.push(m.index + m[0].length);
  }
  if (closes.size === 0) return s;
  let out = "";
  let cursor = 0;
  let rejectedThrough = -1;
  let gtFrom = -1;
  let gtAt = -1;
  for (const m of s.matchAll(open)) {
    const start = m.index;
    if (start < cursor || start <= rejectedThrough) continue;
    const from = start + m[0].length;
    // First ">" at or after `from`. `from` never decreases, so the search is memoized:
    // a cached answer stays valid for every `from` up to it.
    if (gtAt < 0 || from < gtFrom || from > gtAt) {
      gtFrom = from;
      gtAt = s.indexOf(">", from);
    }
    if (gtAt < 0) break; // no ">" left: no later opening tag can be complete either
    const name = (m[1] ?? "").toLowerCase();
    const list = closes.get(name);
    if (!list) continue;
    // Closing tags of this name are consumed in order; queries (gtAt) never decrease.
    while (list.next < list.starts.length && (list.starts[list.next] ?? 0) <= gtAt) list.next += 1;
    if (list.next >= list.starts.length) continue;
    const value = attr(s.slice(start, gtAt + 1));
    if (value === null) {
      rejectedThrough = gtAt;
      continue;
    }
    out += s.slice(cursor, start) + fn(name, value, s.slice(gtAt + 1, list.starts[list.next]));
    cursor = list.ends[list.next] ?? s.length;
    list.next += 1;
  }
  return out + s.slice(cursor);
}
