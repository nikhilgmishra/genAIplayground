/**
 * Knowledge sanitizer (spec section 9: "sanitize embedded instructions, links,
 * attachments and executable content").
 *
 * Retrieved articles are untrusted model input (spec section 3). Before an item
 * is stored the sanitizer:
 *  - normalizes Unicode (NFKC), removes invisible/bidi/control characters;
 *  - decodes HTML entities to a fixpoint (so encoded markup cannot survive);
 *  - removes <script>/<style>/<iframe>/<object>/<embed>/<form>/... blocks with
 *    their content, HTML comments and every remaining tag;
 *  - removes fenced code blocks and inline code (executable content);
 *  - removes images, attachments, executable file references and data: URIs;
 *  - rewrites markdown/HTML links to their text; an allowlisted link target is
 *    kept only as plain text "host/path" (no scheme, query or fragment);
 *  - removes raw URLs and bare domains outside the allowlist;
 *  - repeats the pipeline until the text is stable, then hard-scrubs anything
 *    left that still violates the output invariants.
 *
 * Output invariants (property-tested): no "<" or ">", no "://", no "www.",
 * no javascript:/vbscript:/data: URI, and no bare domain outside the allowlist.
 *
 * Findings are reason codes. QUARANTINE-level findings (executable or embedded
 * content) make the ingestion pipeline quarantine the item; STRIP-level
 * findings (formatting, links) are recorded and the cleaned text is kept.
 */
import { stripControl, stripInvisible } from "../privacy/patterns.js";

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
  | "SANITIZER_HARD_SCRUB_APPLIED";

/** Findings that indicate executable or embedded content: the item is quarantined. */
export const QUARANTINE_FINDINGS: ReadonlySet<SanitizeFindingCode> = new Set([
  "SCRIPT_OR_STYLE_REMOVED",
  "EMBEDDED_OBJECT_REMOVED",
  "EVENT_HANDLER_REMOVED",
  "EXECUTABLE_URI_REMOVED",
  "DATA_URI_REMOVED",
  "CODE_BLOCK_REMOVED",
  "EXECUTABLE_ATTACHMENT_REMOVED",
  "SANITIZER_HARD_SCRUB_APPLIED",
]);

export interface SanitizeOptions {
  /** Exact approved hosts whose links may be kept as plain text. Lowercase, no scheme. */
  allowedLinkDomains?: readonly string[];
}

export interface SanitizeResult {
  text: string;
  findings: SanitizeFindingCode[];
  quarantineFindings: SanitizeFindingCode[];
}

const MAX_PASSES = 6;

const BLOCK_ELEMENTS = /<\s*(script|style|iframe|object|embed|applet|form|noscript|template|svg|math|frameset|frame|base|link|meta)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi;
const UNCLOSED_BLOCK = /<\s*(script|style|iframe|object|embed|applet|form|noscript|template|svg|math)\b[\s\S]*$/i;
const VOID_EMBED = /<\s*(iframe|object|embed|applet|base|link|meta|frame|input|button)\b[^>]*>/gi;
const EVENT_HANDLER = /<[^>]*\son[a-z]{2,20}\s*=/i;
const HTML_COMMENT = /<!--[\s\S]*?(?:-->|$)/g;
const ANCHOR = /<a\b[^>]*?\bhref\s*=\s*(["']?)([^"'\s>]*)\1[^>]*>([\s\S]*?)<\s*\/\s*a\s*>/gi;
const IMG_TAG = /<\s*img\b[^>]*>/gi;
const TAG = /<\/?[A-Za-z!?][^<>]*>/g;
const FENCED = /(```|~~~)[\s\S]*?(?:\1|$)/g;
const INLINE_CODE = /`[^`\n]{0,400}`/g;
const MD_IMAGE = /!\[[^\]\n]{0,400}\]\([^)\n]{0,2000}\)/g;
const MD_LINK = /\[([^\]\n]{0,400})\]\(\s*<?([^)\s>]{0,2000})>?(?:\s+["'][^"'\n]{0,200}["'])?\s*\)/g;
const MD_REF_DEF = /^[ \t]{0,3}\[[^\]\n]{1,200}\]:[ \t]*\S+.*$/gm;
const MD_REF_LINK = /\[([^\]\n]{1,400})\]\[[^\]\n]{0,200}\]/g;
const AUTOLINK = /<((?:https?|mailto|ftp):[^>\s]{1,2000})>/gi;
const EXEC_URI = /(?:javascript|vbscript|livescript)\s*:[^\s]*/gi;
const DATA_URI = /\bdata\s*:\s*[a-z]+\/[a-z0-9.+-]+[;,][^\s]*/gi;
const SCHEME_URL = /(?<![a-z0-9+.-])[a-z][a-z0-9+.-]{1,15}:\/\/[^\s<>"'`)\]]*/gi;
const PROTOCOL_RELATIVE = /(^|[\s(["'])\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+[^\s<>"'`)\]]*/gi;
const WWW = /www\.[^\s<>"'`)\]]*/gi;
const OTHER_URI = /\b(?:file|mailto|tel|sip|sips|callto|sms|ftp|ws|wss)\s*:[^\s]*/gi;
const BARE_TLDS = "com|net|org|info|io|co|us|biz|gov|edu|health|care|app|dev|xyz|link|ly|me|ai|test|invalid|example|localhost|online|site|ru|cn|tk";
const BARE_DOMAIN = new RegExp(`(?<![a-z0-9-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+(?:${BARE_TLDS})\\b(?::\\d{1,5})?(?:\\/[^\\s<>"'\`)\\]]*)?`, "gi");
const EXEC_FILE = /\b[\w.-]{1,120}\.(?:exe|bat|cmd|ps1|psm1|sh|bash|vbs|vbe|js|jse|wsf|msi|scr|jar|apk|dmg|pkg|hta|lnk|iso|docm|xlsm|pptm|dll|bin)\b/gi;
const ATTACHMENT_REF = /\b(?:attachment|attached file|download)\s*:\s*\S+/gi;

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", tab: "\t", newline: "\n", colon: ":", sol: "/", lpar: "(", rpar: ")" };

function decodeEntitiesOnce(s: string): string {
  return s
    .replace(/&#x([0-9a-f]{1,6});?/gi, (_m, hex: string) => safeCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d{1,7});?/g, (_m, dec: string) => safeCodePoint(Number.parseInt(dec, 10)))
    .replace(/&([a-z]{2,8});?/gi, (m, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

function safeCodePoint(cp: number): string {
  if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return "";
  return String.fromCodePoint(cp);
}

function decodeEntities(s: string): string {
  let cur = s;
  for (let i = 0; i < 5; i += 1) {
    const next = decodeEntitiesOnce(cur);
    if (next === cur) break;
    cur = next;
  }
  return cur;
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
  return allowed.has(host.toLowerCase().replace(/\.$/, ""));
}

/**
 * Plain-text rendering of an allowlisted link: "host/path" without scheme,
 * credentials, port, query or fragment. Returns null when not allowlisted.
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
  const path = url.pathname.replace(/\/+$/, "");
  const safePath = /^[/A-Za-z0-9._~-]{0,120}$/.test(path) && !/\d{4,}/.test(path) ? path : "";
  return `${url.hostname.toLowerCase()}${safePath}`;
}

function onePass(input: string, allowed: ReadonlySet<string>, findings: Set<SanitizeFindingCode>): string {
  let s = decodeEntities(input);
  const record = (re: RegExp, code: SanitizeFindingCode) => {
    re.lastIndex = 0;
    if (re.test(s)) findings.add(code);
    re.lastIndex = 0;
  };

  record(HTML_COMMENT, "HTML_COMMENT_REMOVED");
  s = s.replace(HTML_COMMENT, " ");
  if (EVENT_HANDLER.test(s)) findings.add("EVENT_HANDLER_REMOVED");

  // Executable / embedded blocks with their content.
  BLOCK_ELEMENTS.lastIndex = 0;
  s = s.replace(BLOCK_ELEMENTS, (_m, tag: string) => {
    findings.add(/^(script|style|noscript|template|svg|math)$/i.test(tag) ? "SCRIPT_OR_STYLE_REMOVED" : "EMBEDDED_OBJECT_REMOVED");
    return " ";
  });
  const unclosed = UNCLOSED_BLOCK.exec(s);
  if (unclosed) {
    findings.add(/^(iframe|object|embed|applet|form)$/i.test(unclosed[1] ?? "") ? "EMBEDDED_OBJECT_REMOVED" : "SCRIPT_OR_STYLE_REMOVED");
    s = s.slice(0, unclosed.index);
  }
  record(VOID_EMBED, "EMBEDDED_OBJECT_REMOVED");
  s = s.replace(VOID_EMBED, " ");

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
  record(IMG_TAG, "ATTACHMENT_REMOVED");
  s = s.replace(IMG_TAG, " ");
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
  s = s.replace(ANCHOR, (_m, _q: string, target: string, text: string) => rewriteLink(text, target));
  s = s.replace(MD_LINK, (_m, text: string, target: string) => rewriteLink(text, target));
  record(MD_REF_DEF, "LINK_REMOVED");
  s = s.replace(MD_REF_DEF, " ");
  s = s.replace(MD_REF_LINK, (_m, text: string) => text);

  // Remaining markup.
  record(TAG, "HTML_MARKUP_STRIPPED");
  s = s.replace(TAG, " ");
  if (/[<>]/.test(s)) findings.add("HTML_MARKUP_STRIPPED");
  s = s.replace(/[<>]/g, " ");

  // Raw URLs and bare domains.
  const urlReplacer = (m: string) => {
    const trail = /[.,;:!?]+$/.exec(m)?.[0] ?? "";
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
  s = s.replace(BARE_DOMAIN, (m) => {
    const trail = /[.,;:!?]+$/.exec(m)?.[0] ?? "";
    const core = m.slice(0, m.length - trail.length);
    const host = core.replace(/[:/].*$/, "").toLowerCase();
    if (hostAllowed(host, allowed)) return `${plainTextLink(core, allowed) ?? host}${trail}`;
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

/** Output-invariant violations (empty = clean). Used by tests and by retrieval re-checks. */
export function sanitizedTextViolations(text: string, allowedDomains?: readonly string[]): string[] {
  const allowed = normalizeAllowedDomains(allowedDomains);
  const v: string[] = [];
  if (/[<>]/.test(text)) v.push("ANGLE_BRACKET");
  if (/:\/\//.test(text)) v.push("SCHEME_SEPARATOR");
  if (/www\./i.test(text)) v.push("WWW_HOST");
  if (/(?:java|vb|live)script\s*:/i.test(text)) v.push("EXECUTABLE_URI");
  if (/\bdata\s*:\s*[a-z]+\/[a-z0-9.+-]+[;,]/i.test(text)) v.push("DATA_URI");
  BARE_DOMAIN.lastIndex = 0;
  for (const m of text.matchAll(BARE_DOMAIN)) {
    const host = m[0].replace(/[:/].*$/, "").toLowerCase();
    if (!hostAllowed(host, allowed)) {
      v.push("BARE_DOMAIN_NOT_ALLOWLISTED");
      break;
    }
  }
  return v;
}

/** Last-resort removal guaranteeing the output invariants. Each step strictly shrinks the text. */
function hardScrub(text: string, allowed: ReadonlySet<string>): string {
  let s = text;
  for (let i = 0; i < 10_000; i += 1) {
    const before = s;
    s = s
      .replace(/[<>]/g, "")
      .replace(/:\/\//g, " ")
      .replace(/www\./gi, " ")
      .replace(/(?:java|vb|live)script\s*:/gi, " ")
      .replace(/\bdata\s*:\s*[a-z]+\/[a-z0-9.+-]+[;,]/gi, " ");
    BARE_DOMAIN.lastIndex = 0;
    s = s.replace(BARE_DOMAIN, (m) => (hostAllowed(m.replace(/[:/].*$/, ""), allowed) ? m : " "));
    if (s === before) break;
  }
  return s;
}

export function sanitizeKnowledgeText(input: string, opts: SanitizeOptions = {}): SanitizeResult {
  const allowed = normalizeAllowedDomains(opts.allowedLinkDomains);
  const findings = new Set<SanitizeFindingCode>();
  const normalized = input.normalize("NFKC");
  const visible = stripControl(stripInvisible(normalized));
  if (visible !== normalized.replace(/\r\n?/g, "\n")) findings.add("INVISIBLE_CHARACTERS_REMOVED");

  let cur = visible;
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const next = onePass(cur, allowed, findings);
    if (next === cur) break;
    cur = next;
  }
  cur = normalizeWhitespace(cur);
  if (sanitizedTextViolations(cur, [...allowed]).length > 0) {
    findings.add("SANITIZER_HARD_SCRUB_APPLIED");
    cur = normalizeWhitespace(hardScrub(cur, allowed));
  }
  const list = [...findings].sort();
  return { text: cur, findings: list, quarantineFindings: list.filter((f) => QUARANTINE_FINDINGS.has(f)) };
}
