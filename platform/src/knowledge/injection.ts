/**
 * Prompt-injection and dial-target detector for knowledge content (spec
 * sections 3, 9 and SAFE-05).
 *
 * Retrieved documents are untrusted model input and a retrieved document must
 * never be able to choose a dial target. Knowledge therefore must not carry:
 *  - instructions aimed at the model ("ignore previous instructions", role
 *    markers such as "system:", persona switches such as "you are now");
 *  - routing directives ("transfer the caller to ...");
 *  - tool/secret directives ("call the tool", "reveal the system prompt");
 *  - phone numbers, dial/press instructions or tel:/sip: URIs.
 * Any hit QUARANTINES the item for human review. Detection is heuristic: a
 * clean result is not proof that text is harmless, which is why retrieval also
 * treats every excerpt as untrusted data and transfers only use allowlisted
 * destinations from trusted configuration.
 */
import { stripControl, stripInvisible, wordBreakingHiddenAsSpaces } from "../privacy/patterns.js";

export type InjectionReasonCode =
  | "INJECTION_INSTRUCTION_OVERRIDE"
  | "INJECTION_ROLE_MARKER"
  | "INJECTION_PERSONA_SWITCH"
  | "INJECTION_TRANSFER_DIRECTIVE"
  | "INJECTION_TOOL_DIRECTIVE"
  | "INJECTION_SECRET_REQUEST"
  | "DIAL_TARGET_PHONE_NUMBER"
  | "DIAL_TARGET_URI"
  | "DIAL_INSTRUCTION";

/** Common Cyrillic / Greek look-alikes folded to Latin before matching. */
const CONFUSABLES: Record<string, string> = {
  "\u0430": "a", "\u0435": "e", "\u043e": "o", "\u0440": "p", "\u0441": "c", "\u0443": "y", "\u0445": "x", "\u0456": "i", "\u0458": "j",
  "\u0455": "s", "\u0410": "a", "\u0415": "e", "\u041e": "o", "\u0420": "p", "\u0421": "c", "\u0425": "x", "\u03bf": "o", "\u03b1": "a",
  "\u03b5": "e", "\u03b9": "i", "\u03ba": "k", "\u03bd": "v", "\u03c1": "p", "\u03c4": "t", "\u03c5": "u",
};

/** Lowercase, NFKC, invisible and control characters (C0 other than tab/newline, C1) removed, confusables folded, whitespace collapsed. */
export function normalizeForDetection(text: string): string {
  let s = stripControl(stripInvisible(text.normalize("NFKC"))).toLowerCase();
  s = s.replace(/[\u0370-\u03ff\u0400-\u04ff]/g, (c) => CONFUSABLES[c] ?? c);
  return s.replace(/\s+/g, " ");
}

const RULES: readonly { code: InjectionReasonCode; re: RegExp }[] = [
  {
    code: "INJECTION_INSTRUCTION_OVERRIDE",
    re: /\b(?:ignore|disregard|forget|override|bypass|skip)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|preceding|all|any|the|your|system|safety|existing)\b[^.\n]{0,40}\b(?:instructions?|prompts?|rules?|guidelines?|directives?|polic(?:y|ies)|guardrails?|restrictions?)\b/,
  },
  { code: "INJECTION_INSTRUCTION_OVERRIDE", re: /\bnew (?:instructions?|rules|system prompt)\b|\bfrom now on\b[^.\n]{0,60}\b(?:you|assistant|agent)\b/ },
  { code: "INJECTION_ROLE_MARKER", re: /(?:^|[\s"'([{>#*-])(?:system|assistant|developer|tool)\s*:/ },
  { code: "INJECTION_ROLE_MARKER", re: /<\|?(?:im_start|im_end|system|endoftext)\|?>|\[\/?inst\]|<<\/?sys>>|\bbegin (?:system|hidden) (?:prompt|instructions?)\b/ },
  { code: "INJECTION_PERSONA_SWITCH", re: /\byou are now\b|\bact as (?:an?|the)\b|\bpretend (?:to be|you are)\b|\bdeveloper mode\b|\bjailbreak\b|\bdo anything now\b|\broleplay as\b/ },
  {
    code: "INJECTION_TRANSFER_DIRECTIVE",
    re: /\b(?:transfer|connect|forward|route|patch|redirect|send|escalate)\b[^.\n]{0,30}\b(?:the )?(?:caller|callers|call|calls|customer|client|patient|member|user|person)\b[^.\n]{0,25}\bto\b/,
  },
  { code: "INJECTION_TOOL_DIRECTIVE", re: /\b(?:call|invoke|run|execute|trigger|use)\s+(?:the\s+)?(?:\w+\s+)?(?:tool|function|api|endpoint|command)\b/ },
  { code: "INJECTION_TOOL_DIRECTIVE", re: /\b(?:commit|prepare|submit|request|create|get|search)_[a-z]+(?:_[a-z]+)+\b/ },
  {
    code: "INJECTION_SECRET_REQUEST",
    re: /\b(?:reveal|disclose|print|repeat|output|show|tell|read out|leak)\b[^.\n]{0,30}\b(?:system prompt|hidden instructions|your instructions|password|passcode|verification code|one[- ]time code|otp|api key|access token|credentials?|secrets?)\b/,
  },
  { code: "DIAL_TARGET_URI", re: /\b(?:tel|sip|sips|callto|sms|facetime)\s*:/ },
  { code: "DIAL_INSTRUCTION", re: /\b(?:dial|call|phone|ring|text|sms)\s+(?:us\s+|them\s+)?(?:at\s+|on\s+)?\+?\(?\d(?:[\s().-]?\d){2,}/ },
  { code: "DIAL_INSTRUCTION", re: /\bpress\s+(?:\d|star|pound|hash|#|\*|zero|one|two|three|four|five|six|seven|eight|nine)\b/ },
  { code: "DIAL_INSTRUCTION", re: /\b(?:ext|extension)\.?\s*\d{1,6}\b/ },
  // NANP / E.164 / 7-digit local numbers, vanity numbers.
  { code: "DIAL_TARGET_PHONE_NUMBER", re: /(?<![\d])(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/ },
  { code: "DIAL_TARGET_PHONE_NUMBER", re: /(?<![\d])\+\d[\d\s.-]{7,18}\d(?!\d)/ },
  { code: "DIAL_TARGET_PHONE_NUMBER", re: /(?<![\d.-])\d{3}[\s.-]\d{4}(?![\d.-])/ },
  { code: "DIAL_TARGET_PHONE_NUMBER", re: /\b1[\s.-]?8(?:00|33|44|55|66|77|88)[\s.-]?[a-z0-9]{3}[\s.-]?[a-z0-9]{4}\b/ },
  { code: "DIAL_TARGET_PHONE_NUMBER", re: /(?<![\d])\d{7,}(?!\d)/ },
];

/**
 * Reason codes found in the text (sorted, unique). Empty means no rule matched. Every invisible or
 * control character is read as nothing ("ig<U+200B>nore"). One that can stand for a word break
 * (a C0/C1 control, U+200B, U+2060, U+FEFF or a blank filler) may also read as a space
 * ("ignore<U+0001>previous"), so text that holds one is checked in that reading too. An in-word
 * character (soft hyphen, joiner, variation selector) is not read as a space: "sub<U+00AD>system:"
 * is the word "subsystem", not the role marker "system:".
 */
export function detectInjection(text: string): InjectionReasonCode[] {
  const readings = [normalizeForDetection(text)];
  const spaced = wordBreakingHiddenAsSpaces(text);
  if (spaced !== text) readings.push(normalizeForDetection(spaced));
  const found = new Set<InjectionReasonCode>();
  for (const s of readings) for (const r of RULES) if (r.re.test(s)) found.add(r.code);
  return [...found].sort();
}
