/**
 * Clinical boundary detection (spec section 10, SAFE-01).
 *
 * The administrative agent does not diagnose, provide therapy, screen clinical
 * severity, recommend medications, infer mental state from voice or run a
 * Columbia-style assessment. Questions that ask for any of these are routed
 * to CLINICAL_BOUNDARY_ROUTE: a concise approved boundary statement
 * (template "clinical.boundary") plus the clinician/human route. Nothing here
 * answers the question, scores anything, or stores the caller's words.
 *
 * Administrative questions that merely mention clinical words ("reschedule my
 * therapy session", "is my psychiatrist appointment on Thursday") are not
 * boundary questions. Rules are a LOCAL DRAFT pending clinical safety review.
 */
import { z } from "zod";
import { canonicalLocale } from "./detector.js";
import { LEXICON_VERSION } from "./lexicon.js";
import { anyMatch, compilePhrase, normalizeSentences } from "./text.js";

export type ClinicalBoundaryCategory = "DIAGNOSIS" | "MEDICATION" | "THERAPY_ADVICE" | "CLINICAL_SCREENING";
export const CLINICAL_BOUNDARY_CATEGORIES: readonly ClinicalBoundaryCategory[] = ["MEDICATION", "DIAGNOSIS", "CLINICAL_SCREENING", "THERAPY_ADVICE"];

export interface ClinicalBoundaryFinding {
  category: ClinicalBoundaryCategory;
  /** Stable rule id; never the caller's words. */
  ruleId: string;
  locale: string;
}

export interface ClinicalBoundaryDetector {
  detect(input: { text: string; locale: string }): ClinicalBoundaryFinding[];
}

export const CLINICAL_BOUNDARY_TEMPLATE_ID = "clinical.boundary";
export const CLINICAL_ROUTE_DESTINATION_ID = "dst_clinical_route";

interface ClinicalRuleSpec {
  ruleId: string;
  category: ClinicalBoundaryCategory;
  /** The sentence must also contain a medication word (for generic modal patterns). */
  requiresMedicationWord: boolean;
  patterns: readonly string[];
}

const MEDICATION_WORDS: ReadonlySet<string> = new Set([
  "medication", "medications", "meds", "medicine", "medicines", "dose", "doses", "dosage", "pill", "pills", "prescription",
  "prescriptions", "antidepressant", "antidepressants", "sertraline", "zoloft", "prozac", "fluoxetine", "lexapro",
  "escitalopram", "citalopram", "celexa", "xanax", "alprazolam", "adderall", "ritalin", "lithium", "lamotrigine",
  "lamictal", "seroquel", "quetiapine", "wellbutrin", "bupropion", "ativan", "lorazepam", "klonopin", "clonazepam",
  "trazodone", "abilify", "aripiprazole", "effexor", "venlafaxine", "cymbalta", "duloxetine", "buspirone", "gabapentin",
  "mirtazapine", "paxil", "paroxetine", "vyvanse", "concerta", "melatonin", "ambien", "zolpidem", "hydroxyzine",
  "propranolol", "prazosin", "risperidone", "olanzapine", "mg", "milligrams",
  "medicamento", "medicamentos", "medicina", "medicinas", "dosis", "pastilla", "pastillas", "receta", "recetas",
  "antidepresivo", "antidepresivos", "sertralina", "fluoxetina", "litio", "miligramos",
]);

const CONDITIONS =
  "(depression|anxiety|adhd|add|ptsd|ocd|bipolar|bipolar disorder|schizophrenia|an eating disorder|autism|a personality disorder|borderline|a mental illness|a disorder|something wrong with me|panic disorder|insomnia)";
const ES_CONDITIONS =
  "(depresion|ansiedad|tdah|trastorno|bipolaridad|esquizofrenia|algo malo|estres postraumatico|toc|un trastorno|una enfermedad mental)";

const RULES: readonly ClinicalRuleSpec[] = [
  {
    ruleId: "clinical.en.diagnosis",
    category: "DIAGNOSIS",
    requiresMedicationWord: false,
    patterns: [
      `(do|could|might|would|can) (i|you think i) (have|be|be having) ${CONDITIONS}`,
      "do you think i (have|am|might have|might be|could have|could be)",
      "am i (depressed|bipolar|crazy|autistic|mentally ill|normal|having a breakdown|psychotic)",
      "(can|could|would) you diagnose",
      "(whats|what is) wrong with me",
      "is (it|this|that) normal to (feel|have|hear|be|see|think)",
      "(what|which) (disorder|condition|diagnosis|illness) (do i have|is this|would this be|could this be)",
      "(does|do) (this|that|it|these|my symptoms) sound like",
      "(is|are) (this|these|my symptoms) (a sign|signs|symptoms) of",
    ],
  },
  {
    ruleId: "clinical.es.diagnosis",
    category: "DIAGNOSIS",
    requiresMedicationWord: false,
    patterns: [
      `(tengo|tendre|sera que tengo|crees que tengo|cree que tengo|podria tener|usted cree que tengo) ${ES_CONDITIONS}`,
      "(sera que soy|crees que soy|cree que soy) (bipolar|loco|loca|enfermo mental|enferma mental)",
      "(puede|puedes|podria|podrias) (diagnosticarme|darme un diagnostico)",
      "es normal (sentir|sentirse|escuchar|oir|tener|ver|pensar)",
      "(esto|eso|estos sintomas) (suena|suenan|parece|parecen) (a|como)",
    ],
  },
  {
    ruleId: "clinical.en.medication_modal",
    category: "MEDICATION",
    requiresMedicationWord: true,
    patterns: [
      "(should|can|could|do|would) i (take|stop|stop taking|start|start taking|increase|decrease|lower|raise|double|skip|switch|mix|combine|quit|come off|cut back on|change)",
      "is it (ok|okay|safe|bad|fine|dangerous) to (take|drink|mix|combine|stop|skip|double|drive)",
      "(can|could|would) you (prescribe|recommend|refill|increase|change|adjust)",
    ],
  },
  {
    ruleId: "clinical.en.medication",
    category: "MEDICATION",
    requiresMedicationWord: false,
    patterns: [
      "(what|which) (medication|medications|medicine|antidepressant|dose|dosage|pill|meds) (should|would|do you|is|works|is best|do you recommend|would you recommend)",
      "side effects (of|from|for)",
      "how (much|many)( <w>){0,3} (should i take|can i take|mg|milligrams)",
      "(do|does) i need (medication|meds|medicine|an antidepressant)",
      "(can|could|would|will) you (prescribe|prescribe me)",
    ],
  },
  {
    ruleId: "clinical.es.medication_modal",
    category: "MEDICATION",
    requiresMedicationWord: true,
    patterns: [
      "(debo|deberia|puedo|podria|es seguro|esta bien|tengo que) (tomar|dejar de tomar|empezar a tomar|aumentar|bajar|subir|disminuir|duplicar|cambiar|mezclar|combinar|suspender|dejar)",
      "(puede|puedes|podria) (recetarme|recomendarme|darme|subirme|bajarme|cambiarme)",
    ],
  },
  {
    ruleId: "clinical.es.medication",
    category: "MEDICATION",
    requiresMedicationWord: false,
    patterns: [
      "(que|cual) (medicamento|medicina|antidepresivo|dosis|pastilla) (me recomienda|me recomiendas|debo tomar|es mejor|deberia tomar)",
      "efectos secundarios",
      "(cuanto|cuanta|cuantos|cuantas)( <w>){0,3} (debo tomar|puedo tomar|miligramos)",
      "(puede|puedes|podria|podrias) (recetarme|darme una receta)",
    ],
  },
  {
    ruleId: "clinical.en.therapy_advice",
    category: "THERAPY_ADVICE",
    requiresMedicationWord: false,
    patterns: [
      "(what|which) (kind of |type of |sort of )?(therapy|treatment|counseling) (should i|is best|would help|do you recommend|would you recommend|is right|works best)",
      "(can|could) you (give me|recommend|teach me|suggest) (some )?(coping|therapy|therapeutic|breathing|relaxation|grounding) (skills|techniques|exercises|strategies|tips|advice)",
      "how (do|can|should) i (cope|deal) with (my )?(anxiety|depression|panic|panic attacks|grief|trauma|stress|feelings|thoughts|ptsd|intrusive thoughts|anger|sadness|loneliness|insomnia)",
      "(can|could|would) you (be my therapist|do therapy with me|counsel me|talk me through)",
      "(give|tell) me (some )?(advice|tips) (on|for|about) (my )?(anxiety|depression|panic|mental health|grief|trauma|relationship)",
      "is (cbt|emdr|dbt|therapy|medication) (right|good|better) for me",
      "should i (see|switch to|try) a (psychiatrist|psychologist|different therapist|new therapist|therapist|counselor)",
    ],
  },
  {
    ruleId: "clinical.es.therapy_advice",
    category: "THERAPY_ADVICE",
    requiresMedicationWord: false,
    patterns: [
      "(que|cual) (tipo de )?(terapia|tratamiento) (me recomienda|me recomiendas|debo|deberia|es mejor|me sirve)",
      "como (puedo|debo|hago para) (manejar|controlar|lidiar con|superar|calmar) (mi |la |el |mis )?(ansiedad|depresion|tristeza|panico|estres|duelo|trauma|ataques de panico|pensamientos)",
      "(deme|dame|me da|me puede dar|me puedes dar) (algunos )?(consejos|tecnicas|ejercicios) (para|de|sobre) (la |mi )?(ansiedad|depresion|manejar|relajacion|respiracion|estres)",
      "(puede|puedes) ser mi terapeuta",
    ],
  },
  {
    ruleId: "clinical.en.screening",
    category: "CLINICAL_SCREENING",
    requiresMedicationWord: false,
    patterns: [
      "(can|could|would) you (screen|assess|evaluate|test) me",
      "(take|do|give me|run) (a|an|the) (depression|anxiety|mental health|adhd|ptsd|bipolar|suicide risk|risk) (test|screening|screen|quiz|assessment|questionnaire|evaluation)",
      "phq( 9)?|phq9|gad 7|gad7",
      "how (severe|bad|serious) is my (depression|anxiety|condition|ptsd|ocd|illness)",
      "(rate|score|grade) my (depression|anxiety|mood|symptoms|mental health)",
      "columbia (scale|protocol|assessment|screening)",
    ],
  },
  {
    ruleId: "clinical.es.screening",
    category: "CLINICAL_SCREENING",
    requiresMedicationWord: false,
    patterns: [
      "(puede|puedes|podria|podrias) (evaluarme|hacerme (una|un) (evaluacion|examen|prueba|cuestionario))",
      "(prueba|examen|cuestionario|test|evaluacion) (de|para) (depresion|ansiedad|salud mental|tdah)",
      "que tan (grave|severa|severo|mala|malo|seria|serio) es mi (depresion|ansiedad|condicion)",
    ],
  },
];

const COMPILED = RULES.map((r) => ({ ...r, regexes: r.patterns.map(compilePhrase) }));

const InputSchema = z.strictObject({ text: z.string().max(20_000), locale: z.string().max(35) });

export class RuleBasedClinicalBoundaryDetector implements ClinicalBoundaryDetector {
  readonly kind = "live" as const;
  readonly rulesVersion = LEXICON_VERSION;
  readonly approvalStatus = "PENDING_CLINICAL_APPROVAL" as const;

  detect(input: { text: string; locale: string }): ClinicalBoundaryFinding[] {
    const parsed = InputSchema.safeParse(input);
    // Unassessable input yields no clinical finding; the safety detector fails safe separately.
    if (!parsed.success) return [];
    const locale = canonicalLocale(parsed.data.locale);
    const seen = new Set<string>();
    const out: ClinicalBoundaryFinding[] = [];
    for (const sentence of normalizeSentences(parsed.data.text)) {
      const hasMedWord = sentence.tokens.some((t) => MEDICATION_WORDS.has(t));
      for (const rule of COMPILED) {
        if (seen.has(rule.ruleId)) continue;
        if (rule.requiresMedicationWord && !hasMedWord) continue;
        if (anyMatch(rule.regexes, sentence.text)) {
          seen.add(rule.ruleId);
          out.push({ category: rule.category, ruleId: rule.ruleId, locale });
        }
      }
    }
    return out;
  }
}

export const CLINICAL_RULE_IDS: ReadonlySet<string> = new Set(RULES.map((r) => r.ruleId));
