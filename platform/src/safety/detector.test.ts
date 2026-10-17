import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createMemoryLogger } from "../observability/logger.js";
import {
  CompositeSafetySignalDetector,
  LocalHeuristicSemanticDetector,
  RuleBasedSafetySignalDetector,
  SafetySignalSchema,
  canonicalLocale,
  humanInterventionSignal,
  isSupportedSafetyLocale,
  safetyDetectorDeploymentViolations,
} from "./detector.js";
import type { SemanticSignalDetector } from "./detector.js";
import { ALL_RULE_IDS, DETECTOR_RULE_IDS, LEXICON_APPROVAL_STATUS } from "./lexicon.js";
import { SafetyPipeline } from "./pipeline.js";
import type { SafetySignal } from "./ports.js";

/** LOCAL FIXTURE: SYNTHETIC utterance corpus (developer-authored, not clinician-reviewed). */
interface CorpusCase {
  id: string;
  category: string;
  locale: string;
  asrConfidence: number | null;
  text: string;
  expect: {
    route: "NONE" | "SAFETY_PRIORITY_HUMAN" | "CLINICAL_BOUNDARY_ROUTE";
    strength?: "CREDIBLE" | "UNRESOLVED";
    sources?: string[];
    subjects?: string[];
    temporals?: string[];
    negated?: boolean;
    clinicalCategory?: string;
    interpreterRequired?: boolean;
  };
}

const here = dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(readFileSync(join(here, "__fixtures__", "utterances.json"), "utf8")) as { label: string; cases: CorpusCase[] };

const TAG_BY_CATEGORY: Record<string, string> = {
  explicit: "SPEC-10.explicit",
  indirect: "SPEC-10.indirect",
  semantic: "SPEC-10.semantic",
  negation: "SPEC-10.negation",
  historical: "SPEC-10.historical",
  third_party: "SPEC-10.third-party",
  threat: "SPEC-10.explicit",
  caller_request: "SAFE-02",
  idiom: "SPEC-10.idiom",
  frustration: "SPEC-10.frustration",
  clinical: "SAFE-01",
  medication: "SAFE-01",
  precedence: "SAFE-01",
  administrative: "SPEC-10.frustration",
  asr_uncertain: "SPEC-10.asr",
  unsupported_locale: "SPEC-11.interpreter",
};

const pipeline = new SafetyPipeline();
const evaluate = (c: CorpusCase) => pipeline.evaluate({ text: c.text, locale: c.locale, asrConfidence: c.asrConfidence }, { afterHours: false, safetyModeActive: false });

function mismatches(c: CorpusCase): string[] {
  const r = evaluate(c);
  const e = c.expect;
  const errs: string[] = [];
  if (r.decision.route !== e.route) errs.push(`route=${r.decision.route}`);
  if (e.strength && r.decision.strongestStrength !== e.strength) errs.push(`strength=${String(r.decision.strongestStrength)}`);
  if (e.sources) {
    const got = [...new Set(r.signals.map((s) => s.source))].sort().join(",");
    if (got !== [...e.sources].sort().join(",")) errs.push(`sources=${got}`);
  }
  for (const s of e.subjects ?? []) if (!r.signals.some((x) => x.subject === s)) errs.push(`subject!=${s}`);
  for (const t of e.temporals ?? []) if (!r.signals.some((x) => x.temporal === t)) errs.push(`temporal!=${t}`);
  if (e.negated !== undefined && r.signals.some((x) => x.negated) !== e.negated) errs.push(`negated!=${String(e.negated)}`);
  if (e.clinicalCategory && !r.decision.clinicalCategories.includes(e.clinicalCategory as never)) errs.push(`clinical!=${e.clinicalCategory}`);
  if (e.interpreterRequired !== undefined && r.coverage.interpreterRequired !== e.interpreterRequired) errs.push("interpreterRequired");
  return errs;
}

describe("synthetic utterance corpus (LOCAL FIXTURE)", () => {
  it("[SPEC-10.detection] corpus is labelled SYNTHETIC, has >= 80 cases in en-US and es-US and covers every required category", () => {
    expect(corpus.label).toMatch(/SYNTHETIC/);
    expect(corpus.cases.length).toBeGreaterThanOrEqual(80);
    const locales = new Set(corpus.cases.map((c) => c.locale));
    expect(locales.has("en-US") && locales.has("es-US")).toBe(true);
    const categories = new Set(corpus.cases.map((c) => c.category));
    for (const required of ["explicit", "indirect", "negation", "historical", "third_party", "idiom", "frustration", "clinical", "medication", "asr_uncertain", "caller_request", "unsupported_locale"]) {
      expect(categories.has(required), required).toBe(true);
    }
    for (const cat of ["explicit", "indirect", "semantic", "negation", "historical", "third_party", "threat", "caller_request", "idiom", "frustration", "clinical", "medication", "administrative", "asr_uncertain"]) {
      expect(corpus.cases.some((c) => c.category === cat && c.locale === "es-US"), `es-US ${cat}`).toBe(true);
    }
    expect(new Set(corpus.cases.map((c) => c.id)).size).toBe(corpus.cases.length);
  });

  for (const c of corpus.cases) {
    it(`[${TAG_BY_CATEGORY[c.category] ?? "SPEC-10.detection"}] corpus ${c.id} (${c.category}, ${c.locale}) routes ${c.expect.route}`, () => {
      expect(mismatches(c)).toEqual([]);
    });
  }

  it("[SAFE-01] [SPEC-10.detection] confusion matrix over the corpus: zero safety false negatives, reported in test output", () => {
    const classes = ["SAFETY_PRIORITY_HUMAN", "CLINICAL_BOUNDARY_ROUTE", "NONE"] as const;
    const matrix: Record<string, Record<string, number>> = {};
    for (const a of classes) matrix[a] = Object.fromEntries(classes.map((p) => [p, 0]));
    const perCategory = new Map<string, { n: number; ok: number }>();
    for (const c of corpus.cases) {
      const predicted = evaluate(c).decision.route;
      const row = matrix[c.expect.route];
      if (row) row[predicted] = (row[predicted] ?? 0) + 1;
      const pc = perCategory.get(c.category) ?? { n: 0, ok: 0 };
      pc.n += 1;
      if (mismatches(c).length === 0) pc.ok += 1;
      perCategory.set(c.category, pc);
    }
    const lines = [
      "",
      "SAFETY CORPUS CONFUSION MATRIX (SYNTHETIC, developer-authored; not evidence of population performance)",
      `expected \\ predicted  ${classes.map((p) => p.padStart(24)).join("")}`,
      ...classes.map((a) => `${a.padEnd(22)} ${classes.map((p) => String(matrix[a]?.[p] ?? 0).padStart(24)).join("")}`),
      `per category (all attributes match): ${[...perCategory.entries()].map(([k, v]) => `${k} ${v.ok}/${v.n}`).join(", ")}`,
      "",
    ];
    process.stdout.write(`${lines.join("\n")}\n`);
    // Hard gate: no expected-safety utterance may be routed anywhere but the safety route.
    expect(matrix.SAFETY_PRIORITY_HUMAN?.NONE).toBe(0);
    expect(matrix.SAFETY_PRIORITY_HUMAN?.CLINICAL_BOUNDARY_ROUTE).toBe(0);
    expect(matrix.CLINICAL_BOUNDARY_ROUTE?.NONE).toBe(0);
  });
});

describe("RuleBasedSafetySignalDetector", () => {
  const detector = new RuleBasedSafetySignalDetector();

  it("[SPEC-10.negation] negation never suppresses a risk phrase: it becomes an UNRESOLVED negated signal", () => {
    const signals = detector.detect({ text: "I am not going to kill myself.", locale: "en-US", asrConfidence: null });
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ source: "EXPLICIT_PHRASE", strength: "UNRESOLVED", negated: true });
  });

  it("[SPEC-10.historical] a historical reference is UNRESOLVED and HISTORICAL, never dropped", () => {
    const [s] = detector.detect({ text: "A long time ago I wanted to die.", locale: "en-US", asrConfidence: null });
    expect(s).toMatchObject({ strength: "UNRESOLVED", temporal: "HISTORICAL" });
  });

  it("[SPEC-10.historical] a recency cue in the same clause overrides an earlier historical cue", () => {
    const signals = detector.detect({ text: "I tried to kill myself years ago and I want to kill myself again tonight.", locale: "en-US", asrConfidence: null });
    expect(signals.some((s) => s.strength === "CREDIBLE" && s.temporal === "CURRENT")).toBe(true);
  });

  it("[SPEC-10.idiom] idioms are masked but an explicit phrase in the same utterance still fires", () => {
    expect(detector.detect({ text: "This bill is killing me.", locale: "en-US", asrConfidence: null })).toEqual([]);
    const both = detector.detect({ text: "This bill is killing me and honestly I want to kill myself.", locale: "en-US", asrConfidence: null });
    expect(both.map((s) => s.ruleId)).toContain("explicit.en.self_kill");
  });

  it("[SPEC-10.idiom] a person subject is not treated as a thing idiom ('my husband is killing me' is a safety signal)", () => {
    const signals = detector.detect({ text: "My husband is killing me.", locale: "en-US", asrConfidence: null });
    expect(signals.map((s) => s.ruleId)).toContain("threat.en.harmed_by_other");
  });

  it("[SPEC-10.asr] low ASR confidence with a partial risk lexeme raises ASR_UNCERTAIN; low confidence alone does not", () => {
    expect(detector.detect({ text: "i want to kill my", locale: "en-US", asrConfidence: 0.2 }).map((s) => s.source)).toEqual(["ASR_UNCERTAIN"]);
    expect(detector.detect({ text: "i want to pay my bill", locale: "en-US", asrConfidence: 0.2 })).toEqual([]);
    expect(detector.detect({ text: "i want to kill my", locale: "en-US", asrConfidence: 0.95 })).toEqual([]);
  });

  it("[SPEC-10.asr] an out-of-range ASR confidence is treated as low confidence (fail safe)", () => {
    expect(detector.detect({ text: "dying", locale: "en-US", asrConfidence: 7 }).map((s) => s.ruleId)).toContain(DETECTOR_RULE_IDS.asrLowConfidence);
  });

  it("[SPEC-11.interpreter] unsupported locale with a risk lexeme => UNRESOLVED with the locale flag; without => interpreter only", () => {
    const risky = detector.analyze({ text: "Je veux mourir", locale: "fr-FR", asrConfidence: null });
    expect(risky.signals).toEqual([expect.objectContaining({ ruleId: DETECTOR_RULE_IDS.unsupportedLocale, strength: "UNRESOLVED", locale: "fr-FR" })]);
    expect(risky.coverage).toMatchObject({ localeSupported: false, interpreterRequired: true });
    const benign = detector.analyze({ text: "Je voudrais payer ma facture", locale: "fr-FR", asrConfidence: null });
    expect(benign.signals).toEqual([]);
    expect(benign.coverage.interpreterRequired).toBe(true);
  });

  it("[SPEC-10.detection] malformed input fails safe to an UNRESOLVED signal (human route), never to no signal", () => {
    const bad = detector.detect({ text: 42 as unknown as string, locale: "en-US", asrConfidence: null });
    expect(bad).toEqual([expect.objectContaining({ ruleId: DETECTOR_RULE_IDS.inputInvalid, strength: "UNRESOLVED" })]);
    expect(detector.detect(null as never)[0]?.ruleId).toBe(DETECTOR_RULE_IDS.inputInvalid);
    expect(detector.detect({ text: "x", locale: "en-US", asrConfidence: Number.NaN })[0]?.ruleId).toBe(DETECTOR_RULE_IDS.inputInvalid);
  });

  it("[SPEC-10.detection] oversized input is analysed (bounded prefix) and also routed to a human", () => {
    const text = `I want to die. ${"filler words here ".repeat(2000)}`;
    const ids = detector.detect({ text, locale: "en-US", asrConfidence: null }).map((s) => s.ruleId);
    expect(ids).toContain(DETECTOR_RULE_IDS.inputOversize);
    expect(ids).toContain("explicit.en.want_die");
  });

  it("[SPEC-10.detection] Spanish rules run on en-US calls too (code-switching)", () => {
    const [s] = detector.detect({ text: "I need help, ya no quiero vivir.", locale: "en-US", asrConfidence: null });
    expect(s).toMatchObject({ ruleId: "explicit.es.want_die", locale: "en-US" });
  });

  it("[SPEC-10.detection] an invalid ASR threshold is rejected at construction", () => {
    expect(() => new RuleBasedSafetySignalDetector({ asrConfidenceThreshold: 2 })).toThrow("ASR_CONFIDENCE_THRESHOLD_INVALID");
  });

  it("[SPEC-10.detection] canonicalLocale normalizes and unknown locales become 'und' (unsupported)", () => {
    expect(canonicalLocale("en_us")).toBe("en-US");
    expect(canonicalLocale("es-mx")).toBe("es-MX");
    expect(canonicalLocale("es-419")).toBe("es-419");
    expect(canonicalLocale("<script>")).toBe("und");
    expect(canonicalLocale(undefined)).toBe("und");
    expect(isSupportedSafetyLocale("es-MX")).toBe(true);
    expect(isSupportedSafetyLocale("und")).toBe(false);
  });
});

describe("DATA-01: signals are content-free", () => {
  it("[DATA-01] every corpus signal is schema-valid, uses a known stable rule id and carries no caller text", () => {
    for (const c of corpus.cases) {
      const r = evaluate(c);
      for (const s of r.signals) {
        expect(SafetySignalSchema.safeParse(s).success, c.id).toBe(true);
        expect(ALL_RULE_IDS.has(s.ruleId), `${c.id}:${s.ruleId}`).toBe(true);
        expect(Object.keys(s).sort()).toEqual(["locale", "negated", "ruleId", "source", "strength", "subject", "temporal"]);
      }
    }
  });

  it("[DATA-01] a unique marker in the utterance never appears in signals, coverage, decision or logs", () => {
    const { logger, records } = createMemoryLogger();
    const detector = new CompositeSafetySignalDetector({ rules: new RuleBasedSafetySignalDetector({ logger }), logger });
    const text = "My name is Zqxmarkername Synthetic and I want to kill myself, call me at 555-0101.";
    const r = new SafetyPipeline({ detector }).evaluate({ text, locale: "en-US", asrConfidence: 0.1 }, { afterHours: false, safetyModeActive: false });
    const blob = JSON.stringify({ r, records });
    expect(r.signals.length).toBeGreaterThan(0);
    expect(blob).not.toMatch(/zqxmarkername/i);
    expect(blob).not.toContain("555-0101");
    expect(blob).not.toContain("call me");
  });
});

describe("semantic detection (LOCAL HEURISTIC)", () => {
  it("[SPEC-10.semantic] the local heuristic is labelled as a local fixture with no evaluation evidence", () => {
    const h = new LocalHeuristicSemanticDetector();
    expect(h.kind).toBe("local_fixture");
    expect(h.evaluationEvidenceRef).toBeNull();
    expect(h.badge).toMatch(/NOT AN APPROVED SEMANTIC CLASSIFIER/);
  });

  it("[SPEC-10.frustration] distress phrasing about an administrative object is frustration, not a signal", () => {
    const d = new CompositeSafetySignalDetector();
    expect(d.detect({ text: "I can't take this hold music anymore.", locale: "en-US", asrConfidence: null })).toEqual([]);
    expect(d.detect({ text: "I can't take it anymore.", locale: "en-US", asrConfidence: null }).map((s) => s.source)).toEqual(["SEMANTIC_SIGNAL"]);
  });

  it("[SPEC-10.semantic] a failing semantic detector degrades to rules and fails safe when a risk lexeme is present", () => {
    const failing: SemanticSignalDetector = {
      kind: "live",
      detectorId: "semantic.test-failing",
      version: "t",
      evaluationEvidenceRef: null,
      detect: () => {
        throw new Error("model unavailable");
      },
    };
    const d = new CompositeSafetySignalDetector({ semantic: failing });
    const risky = d.analyze({ text: "everything feels dead", locale: "en-US", asrConfidence: null });
    expect(risky.signals.map((s) => s.ruleId)).toContain(DETECTOR_RULE_IDS.semanticUnavailable);
    expect(risky.coverage.semanticDetector).toMatchObject({ degraded: true });
    expect(d.detect({ text: "I need my invoice", locale: "en-US", asrConfidence: null })).toEqual([]);
  });

  it("[SPEC-10.semantic] a malformed semantic signal is replaced by a fail-safe signal (never trusted as-is)", () => {
    const malformed: SemanticSignalDetector = {
      kind: "live",
      detectorId: "semantic.test-malformed",
      version: "t",
      evaluationEvidenceRef: null,
      detect: () => [{ source: "SEMANTIC_SIGNAL", ruleId: "Free text the caller said", strength: "CREDIBLE", subject: "SELF", temporal: "CURRENT", negated: false, locale: "en-US" } as SafetySignal],
    };
    const signals = new CompositeSafetySignalDetector({ semantic: malformed }).detect({ text: "hello", locale: "en-US", asrConfidence: null });
    expect(signals).toEqual([expect.objectContaining({ ruleId: DETECTOR_RULE_IDS.signalMalformed, strength: "UNRESOLVED" })]);
  });

  it("[OPS-04] outside local/ci the pending lexicon and the local heuristic are deployment violations", () => {
    expect(LEXICON_APPROVAL_STATUS).toBe("PENDING_CLINICAL_APPROVAL");
    expect(safetyDetectorDeploymentViolations("local", new CompositeSafetySignalDetector())).toEqual([]);
    expect(safetyDetectorDeploymentViolations("production", new CompositeSafetySignalDetector())).toEqual(["SAFETY_LEXICON_NOT_APPROVED", "SEMANTIC_DETECTOR_LOCAL_FIXTURE"]);
    expect(safetyDetectorDeploymentViolations("staging", new CompositeSafetySignalDetector({ semantic: null }))).toContain("SEMANTIC_DETECTOR_MISSING");
  });
});

describe("human intervention", () => {
  it("[SPEC-10.human-intervention] a staff-raised concern is a CREDIBLE HUMAN_INTERVENTION signal with a canonical locale", () => {
    const s = humanInterventionSignal("es_us");
    expect(s).toEqual({ source: "HUMAN_INTERVENTION", ruleId: DETECTOR_RULE_IDS.humanIntervention, strength: "CREDIBLE", subject: "UNKNOWN", temporal: "CURRENT", negated: false, locale: "es-US" });
  });
});
