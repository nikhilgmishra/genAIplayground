/**
 * Multi-signal safety detection (spec section 10).
 *
 * Sources implemented here:
 *  - EXPLICIT_PHRASE / CALLER_REQUEST: deterministic phrase rules (lexicon.ts)
 *    for en-US and es-US, with idiom masking, negation, historical and
 *    third-party handling. Negated or historical mentions are never dropped:
 *    they become UNRESOLVED signals and still reach a human.
 *  - ASR_UNCERTAIN: low recognizer confidence with any partial risk lexeme, and
 *    unsupported-locale speech with any multilingual risk lexeme.
 *  - SEMANTIC_SIGNAL: SemanticSignalDetector interface. Only a LOCAL HEURISTIC
 *    exists offline (labelled local_fixture); a real classifier is BLOCKED
 *    pending an approved model, approved data path and evaluation evidence.
 *  - HUMAN_INTERVENTION: humanInterventionSignal() for staff-raised concerns.
 *
 * Detection is never claimed complete or infallible. Signals carry stable rule
 * ids and closed-set attributes only; the caller's words are never stored,
 * returned or logged (DATA-01). Malformed input fails safe to an UNRESOLVED
 * signal (human route), never to "no signal".
 */
import { z } from "zod";
import type { Logger } from "../observability/ports.js";
import { silentLogger } from "../observability/logger.js";
import type { Environment } from "../protocol/index.js";
import {
  ADMIN_CONTEXT_TOKENS,
  DETECTOR_RULE_IDS,
  DISTRESS_PATTERNS,
  FIRST_PERSON_TOKENS,
  HISTORICAL_PATTERNS,
  IDIOM_PATTERNS,
  LEXICON_APPROVAL_STATUS,
  LEXICON_VERSION,
  MULTILINGUAL_LEXEMES,
  NEGATION_NO_EXCEPTIONS,
  NEGATION_TOKENS,
  NEGATION_WINDOW,
  PARTIAL_RISK_PATTERNS,
  PHRASE_RULES,
  RECENCY_PATTERNS,
  THIRD_PARTY_TOKENS,
} from "./lexicon.js";
import type { PhraseRuleSpec } from "./lexicon.js";
import type { SafetyDetectionInput, SafetySignal, SafetySignalDetector } from "./ports.js";
import {
  anyMatch,
  clauseRange,
  compilePhrase,
  findMatches,
  joinTokens,
  maskSentence,
  normalizeForLexemeScan,
  normalizeSentences,
} from "./text.js";
import type { NormalizedSentence } from "./text.js";

// ---------------------------------------------------------------------------
// Signal schema and locale handling
// ---------------------------------------------------------------------------

export const SafetySignalSourceSchema = z.enum(["EXPLICIT_PHRASE", "SEMANTIC_SIGNAL", "ASR_UNCERTAIN", "CALLER_REQUEST", "HUMAN_INTERVENTION"]);
export const LOCALE_RE = /^([a-z]{2,3}(-[A-Z]{2}|-[0-9]{3})?|und)$/;
export const RULE_ID_RE = /^[a-z][a-z0-9_.-]{2,80}$/;

/** Strict schema for a SafetySignal crossing a module boundary (e.g. from the console). */
export const SafetySignalSchema = z.strictObject({
  source: SafetySignalSourceSchema,
  ruleId: z.string().regex(RULE_ID_RE),
  strength: z.enum(["CREDIBLE", "UNRESOLVED"]),
  subject: z.enum(["SELF", "THIRD_PARTY", "UNKNOWN"]),
  temporal: z.enum(["CURRENT", "HISTORICAL", "UNKNOWN"]),
  negated: z.boolean(),
  locale: z.string().regex(LOCALE_RE),
});

/** Languages with reviewed-for-draft rule sets. Anything else is "unsupported" (interpreter path). */
export const SUPPORTED_SAFETY_LANGUAGES: ReadonlySet<string> = new Set(["en", "es"]);

/** Canonical BCP-47-ish locale ("en_us" -> "en-US"); anything unparseable becomes "und". */
export function canonicalLocale(locale: unknown): string {
  if (typeof locale !== "string" || locale.length > 35) return "und";
  const parts = locale.trim().replace(/_/g, "-").split("-");
  const lang = (parts[0] ?? "").toLowerCase();
  const region = parts[1];
  const candidate = region === undefined ? lang : `${lang}-${/^[0-9]{3}$/.test(region) ? region : region.toUpperCase()}`;
  return parts.length <= 2 && LOCALE_RE.test(candidate) ? candidate : "und";
}

export function isSupportedSafetyLocale(locale: string): boolean {
  return SUPPORTED_SAFETY_LANGUAGES.has(canonicalLocale(locale).split("-")[0] ?? "");
}

export interface DetectionCoverage {
  /** Canonical locale used for signals. */
  locale: string;
  localeSupported: boolean;
  /** Unsupported language: the caller goes to the staffed interpreter path. */
  interpreterRequired: boolean;
  asrLowConfidence: boolean;
  /** A partial risk lexeme appears somewhere (content-free boolean). */
  riskLexemePresent: boolean;
  lexiconVersion: string;
  semanticDetector: { detectorId: string; kind: "local_fixture" | "live"; degraded: boolean } | null;
}

export interface SafetyAnalysis {
  signals: SafetySignal[];
  coverage: DetectionCoverage;
}

// ---------------------------------------------------------------------------
// Compiled lexicon
// ---------------------------------------------------------------------------

interface CompiledRule {
  spec: PhraseRuleSpec;
  regexes: RegExp[];
}

const COMPILED_RULES: readonly CompiledRule[] = PHRASE_RULES.map((spec) => ({ spec, regexes: spec.patterns.map(compilePhrase) }));
const IDIOMS = IDIOM_PATTERNS.map(compilePhrase);
const RECENCY = RECENCY_PATTERNS.map(compilePhrase);
const HISTORICAL = HISTORICAL_PATTERNS.map(compilePhrase);
const PARTIAL_RISK = PARTIAL_RISK_PATTERNS.map(compilePhrase);
const DISTRESS = DISTRESS_PATTERNS.map(compilePhrase);
const MULTILINGUAL = MULTILINGUAL_LEXEMES.map(({ lexeme, mode }) => {
  const norm = normalizeForLexemeScan(lexeme);
  const escaped = norm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return mode === "substring" ? new RegExp(escaped, "u") : new RegExp(`(?<![\\p{L}\\p{N}])${escaped}`, "u");
});

const MAX_TEXT_CHARS = 20_000;
export const DEFAULT_ASR_CONFIDENCE_THRESHOLD = 0.6;

const DetectionInputSchema = z.strictObject({
  text: z.string(),
  locale: z.string().max(35),
  asrConfidence: z.number().nullable(),
});

// ---------------------------------------------------------------------------
// Context scans (negation, subject, temporal, administrative context)
// ---------------------------------------------------------------------------

function isNegated(tokens: readonly string[], startToken: number, clauseFrom: number): boolean {
  const stop = Math.max(clauseFrom, startToken - NEGATION_WINDOW);
  for (let i = startToken - 1; i >= stop; i--) {
    const t = tokens[i];
    if (t === undefined || !NEGATION_TOKENS.has(t)) continue;
    if (t === "no" && NEGATION_NO_EXCEPTIONS.has(tokens[i + 1] ?? "")) continue;
    return true;
  }
  return false;
}

function inferSubject(tokens: readonly string[], startToken: number, clauseFrom: number, fallback: SafetySignal["subject"]): SafetySignal["subject"] {
  for (let i = startToken - 1; i >= clauseFrom; i--) {
    const t = tokens[i];
    if (t === undefined) continue;
    if (THIRD_PARTY_TOKENS.has(t)) return "THIRD_PARTY";
    if (FIRST_PERSON_TOKENS.has(t)) return "SELF";
  }
  return fallback;
}

function temporalFor(
  sentence: NormalizedSentence,
  clauseText: string,
  fallback: "CURRENT" | "UNKNOWN",
): { temporal: SafetySignal["temporal"]; explicitRecency: boolean } {
  if (anyMatch(RECENCY, clauseText)) return { temporal: "CURRENT", explicitRecency: true };
  if (anyMatch(HISTORICAL, sentence.text)) return { temporal: "HISTORICAL", explicitRecency: false };
  return { temporal: fallback, explicitRecency: false };
}

function hasAdminContext(sentence: NormalizedSentence): boolean {
  return sentence.tokens.some((t) => ADMIN_CONTEXT_TOKENS.has(t));
}

function strengthFor(
  spec: Pick<PhraseRuleSpec, "baseStrength" | "upgradeOnRecency">,
  negated: boolean,
  temporal: SafetySignal["temporal"],
  explicitRecency: boolean,
): SafetySignal["strength"] {
  if (negated || temporal === "HISTORICAL") return "UNRESOLVED";
  if (spec.baseStrength === "CREDIBLE") return "CREDIBLE";
  return spec.upgradeOnRecency && explicitRecency ? "CREDIBLE" : "UNRESOLVED";
}

function signal(
  source: SafetySignal["source"],
  ruleId: string,
  strength: SafetySignal["strength"],
  locale: string,
  attrs: Partial<Pick<SafetySignal, "subject" | "temporal" | "negated">> = {},
): SafetySignal {
  return {
    source,
    ruleId,
    strength,
    subject: attrs.subject ?? "UNKNOWN",
    temporal: attrs.temporal ?? "UNKNOWN",
    negated: attrs.negated ?? false,
    locale,
  };
}

/** One signal per (source, ruleId); CREDIBLE wins over UNRESOLVED, then first seen. */
export function dedupeSignals(signals: readonly SafetySignal[]): SafetySignal[] {
  const out = new Map<string, SafetySignal>();
  for (const s of signals) {
    const key = `${s.source}|${s.ruleId}`;
    const prior = out.get(key);
    if (!prior || (prior.strength === "UNRESOLVED" && s.strength === "CREDIBLE")) out.set(key, s);
  }
  return [...out.values()];
}

/** Content-free fail-safe signal: routes to a human when input cannot be assessed. */
export function failSafeSignal(ruleId: string, locale = "und"): SafetySignal {
  return signal("ASR_UNCERTAIN", ruleId, "UNRESOLVED", canonicalLocale(locale));
}

/**
 * A staff member (supervisor, safety responder, support agent) raised a safety
 * concern for the call. Always CREDIBLE; never requires caller authentication.
 */
export function humanInterventionSignal(locale: string): SafetySignal {
  return signal("HUMAN_INTERVENTION", DETECTOR_RULE_IDS.humanIntervention, "CREDIBLE", canonicalLocale(locale), { temporal: "CURRENT" });
}

// ---------------------------------------------------------------------------
// Rule-based detector
// ---------------------------------------------------------------------------

interface RuleRun {
  analysis: SafetyAnalysis;
  /** Idiom-masked sentences, kept in memory only for the semantic stage. */
  masked: NormalizedSentence[];
  text: string;
}

export interface RuleBasedDetectorOptions {
  /** Below this recognizer confidence, any partial risk lexeme raises ASR_UNCERTAIN. Placeholder pending ASR calibration. */
  asrConfidenceThreshold?: number;
  logger?: Logger;
}

export class RuleBasedSafetySignalDetector implements SafetySignalDetector {
  /** Deterministic production code; its lexicon content still needs clinical approval (see approvalStatus). */
  readonly kind = "live" as const;
  readonly lexiconVersion = LEXICON_VERSION;
  readonly approvalStatus = LEXICON_APPROVAL_STATUS;
  private readonly threshold: number;
  private readonly logger: Logger;

  constructor(opts: RuleBasedDetectorOptions = {}) {
    const t = opts.asrConfidenceThreshold ?? DEFAULT_ASR_CONFIDENCE_THRESHOLD;
    if (!Number.isFinite(t) || t < 0 || t > 1) throw new Error("ASR_CONFIDENCE_THRESHOLD_INVALID");
    this.threshold = t;
    this.logger = (opts.logger ?? silentLogger).child({ component: "safety_detector" });
  }

  detect(input: SafetyDetectionInput): SafetySignal[] {
    return this.analyze(input).signals;
  }

  analyze(input: SafetyDetectionInput): SafetyAnalysis {
    return this.run(input).analysis;
  }

  /** @internal Used by CompositeSafetySignalDetector; the masked sentences never leave this module. */
  run(input: SafetyDetectionInput): RuleRun {
    const parsed = DetectionInputSchema.safeParse(input);
    if (!parsed.success) {
      const locale = canonicalLocale((input as { locale?: unknown } | null | undefined)?.locale);
      this.logger.warn("safety.detect.input_invalid", { reasonCode: "SAFETY_INPUT_INVALID" });
      return {
        analysis: { signals: [failSafeSignal(DETECTOR_RULE_IDS.inputInvalid, locale)], coverage: this.coverage(locale, false, false) },
        masked: [],
        text: "",
      };
    }
    const locale = canonicalLocale(parsed.data.locale);
    const supported = isSupportedSafetyLocale(locale);
    const signals: SafetySignal[] = [];
    let text = parsed.data.text;
    if (text.length > MAX_TEXT_CHARS) {
      // Oversized input is anomalous for one utterance: analyse the bounded prefix and route to a human.
      signals.push(failSafeSignal(DETECTOR_RULE_IDS.inputOversize, locale));
      text = text.slice(0, MAX_TEXT_CHARS);
    }
    const conf = parsed.data.asrConfidence;
    const asrLowConfidence = conf !== null && !(Number.isFinite(conf) && conf >= this.threshold && conf <= 1);

    const sentences = normalizeSentences(text);
    const masked = sentences.map((s) => maskSentence(s, IDIOMS));
    for (const sentence of masked) signals.push(...this.phraseSignals(sentence, locale));

    // Partial lexemes are screened on the UNMASKED text: when recognition is
    // uncertain, an idiom reading of the transcript is itself uncertain.
    const riskLexemePresent = sentences.some((s) => anyMatch(PARTIAL_RISK, s.text));
    if (asrLowConfidence && riskLexemePresent) {
      signals.push(signal("ASR_UNCERTAIN", DETECTOR_RULE_IDS.asrLowConfidence, "UNRESOLVED", locale));
    }
    let multilingualHit = false;
    if (!supported) {
      const scan = normalizeForLexemeScan(text);
      multilingualHit = MULTILINGUAL.some((re) => re.test(scan));
      if (multilingualHit || riskLexemePresent) {
        signals.push(signal("ASR_UNCERTAIN", DETECTOR_RULE_IDS.unsupportedLocale, "UNRESOLVED", locale));
      }
    }
    return {
      analysis: { signals: dedupeSignals(signals), coverage: this.coverage(locale, asrLowConfidence, riskLexemePresent || multilingualHit) },
      masked,
      text,
    };
  }

  private coverage(locale: string, asrLowConfidence: boolean, riskLexemePresent: boolean): DetectionCoverage {
    const supported = isSupportedSafetyLocale(locale);
    return {
      locale,
      localeSupported: supported,
      interpreterRequired: !supported,
      asrLowConfidence,
      riskLexemePresent,
      lexiconVersion: LEXICON_VERSION,
      semanticDetector: null,
    };
  }

  private phraseSignals(sentence: NormalizedSentence, locale: string): SafetySignal[] {
    const out: SafetySignal[] = [];
    const admin = hasAdminContext(sentence);
    for (const { spec, regexes } of COMPILED_RULES) {
      if (spec.suppressWithAdminContext && admin) continue;
      for (const re of regexes) {
        for (const m of findMatches(re, sentence)) {
          const clause = clauseRange(sentence.tokens, m.startToken, m.endToken);
          const negated = isNegated(sentence.tokens, m.startToken, clause.from);
          const subject = spec.subject.kind === "fixed" ? spec.subject.subject : inferSubject(sentence.tokens, m.startToken, clause.from, spec.subject.fallback);
          const { temporal, explicitRecency } = temporalFor(sentence, joinTokens(sentence.tokens, clause.from, clause.to), spec.defaultTemporal);
          out.push(signal(spec.source, spec.ruleId, strengthFor(spec, negated, temporal, explicitRecency), locale, { subject, temporal, negated }));
        }
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Semantic detection (interface + LOCAL heuristic)
// ---------------------------------------------------------------------------

export interface SemanticDetectionInput {
  /** Idiom-masked, normalized sentences of the utterance (in memory only). */
  sentences: readonly NormalizedSentence[];
  locale: string;
}

/**
 * Contextual semantic detection. A live implementation would be an approved,
 * evaluated classifier running on an approved data path (DATA-01); none exists
 * offline, so a live adapter is BLOCKED. Implementations return content-free
 * signals only and must be synchronous (in-process) to fit SafetySignalDetector.
 */
export interface SemanticSignalDetector {
  readonly kind: "local_fixture" | "live";
  readonly detectorId: string;
  readonly version: string;
  /** Reference to approved evaluation evidence; null until it exists. */
  readonly evaluationEvidenceRef: string | null;
  detect(input: SemanticDetectionInput): SafetySignal[];
}

/**
 * LOCAL HEURISTIC — NOT A CLASSIFIER, NOT EVALUATED. Raises an UNRESOLVED
 * SEMANTIC_SIGNAL for generic distress expressions ("I can't take it anymore",
 * "no aguanto más") unless the same sentence is about an administrative object
 * (hold music, the bill, the portal), in which case it is treated as ordinary
 * frustration: not every expression of frustration is an emergency.
 */
export class LocalHeuristicSemanticDetector implements SemanticSignalDetector {
  readonly kind = "local_fixture" as const;
  readonly detectorId = "semantic.local-heuristic";
  readonly version = LEXICON_VERSION;
  readonly evaluationEvidenceRef = null;
  readonly badge = "LOCAL HEURISTIC — NOT AN APPROVED SEMANTIC CLASSIFIER";

  detect(input: SemanticDetectionInput): SafetySignal[] {
    const out: SafetySignal[] = [];
    for (const sentence of input.sentences) {
      if (!anyMatch(DISTRESS, sentence.text) || hasAdminContext(sentence)) continue;
      const subject = sentence.tokens.some((t) => FIRST_PERSON_TOKENS.has(t)) ? "SELF" : "UNKNOWN";
      const { temporal } = temporalFor(sentence, sentence.text, "UNKNOWN");
      out.push(signal("SEMANTIC_SIGNAL", DETECTOR_RULE_IDS.semanticDistress, "UNRESOLVED", input.locale, { subject, temporal }));
    }
    return dedupeSignals(out);
  }
}

// ---------------------------------------------------------------------------
// Composite detector
// ---------------------------------------------------------------------------

export interface CompositeDetectorOptions {
  rules?: RuleBasedSafetySignalDetector;
  /** Pass null to run without semantic detection (reported in coverage). */
  semantic?: SemanticSignalDetector | null;
  logger?: Logger;
}

/**
 * Runs the rule-based detector plus the semantic detector. If the semantic
 * stage fails, detection degrades to the rules and any partial risk lexeme
 * raises an UNRESOLVED signal (fail safe toward a human).
 */
export class CompositeSafetySignalDetector implements SafetySignalDetector {
  private readonly rules: RuleBasedSafetySignalDetector;
  private readonly semantic: SemanticSignalDetector | null;
  private readonly logger: Logger;

  constructor(opts: CompositeDetectorOptions = {}) {
    this.rules = opts.rules ?? new RuleBasedSafetySignalDetector();
    this.semantic = opts.semantic === undefined ? new LocalHeuristicSemanticDetector() : opts.semantic;
    this.logger = (opts.logger ?? silentLogger).child({ component: "safety_detector" });
  }

  get semanticKind(): "local_fixture" | "live" | null {
    return this.semantic?.kind ?? null;
  }

  detect(input: SafetyDetectionInput): SafetySignal[] {
    return this.analyze(input).signals;
  }

  analyze(input: SafetyDetectionInput): SafetyAnalysis {
    const run = this.rules.run(input);
    const { coverage } = run.analysis;
    const signals = [...run.analysis.signals];
    let degraded = false;
    if (this.semantic && run.masked.length > 0) {
      try {
        for (const s of this.semantic.detect({ sentences: run.masked, locale: coverage.locale })) {
          const parsed = SafetySignalSchema.safeParse(s);
          signals.push(parsed.success ? parsed.data : failSafeSignal(DETECTOR_RULE_IDS.signalMalformed, coverage.locale));
        }
      } catch {
        degraded = true;
        this.logger.warn("safety.semantic.failed", { reasonCode: "SEMANTIC_DETECTOR_FAILED", method: this.semantic.detectorId });
        if (coverage.riskLexemePresent) {
          signals.push(signal("SEMANTIC_SIGNAL", DETECTOR_RULE_IDS.semanticUnavailable, "UNRESOLVED", coverage.locale));
        }
      }
    }
    return {
      signals: dedupeSignals(signals),
      coverage: {
        ...coverage,
        semanticDetector: this.semantic ? { detectorId: this.semantic.detectorId, kind: this.semantic.kind, degraded } : null,
      },
    };
  }
}

/**
 * Deployment check (OPS-04 style): outside local/ci the lexicon must be
 * clinically approved and the semantic stage must be an approved live
 * classifier. Returns reason codes; empty means no violation found here.
 */
export function safetyDetectorDeploymentViolations(environment: Environment, detector: CompositeSafetySignalDetector): string[] {
  if (environment === "local" || environment === "ci") return [];
  const violations: string[] = [];
  if ((LEXICON_APPROVAL_STATUS as string) !== "APPROVED") violations.push("SAFETY_LEXICON_NOT_APPROVED");
  if (detector.semanticKind === null) violations.push("SEMANTIC_DETECTOR_MISSING");
  else if (detector.semanticKind === "local_fixture") violations.push("SEMANTIC_DETECTOR_LOCAL_FIXTURE");
  return violations;
}
