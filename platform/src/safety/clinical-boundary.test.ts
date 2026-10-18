import { describe, expect, it } from "vitest";
import { loadDefaultTemplateRegistry } from "../voice/registry.js";
import { CLINICAL_BOUNDARY_TEMPLATE_ID, CLINICAL_ROUTE_DESTINATION_ID, RuleBasedClinicalBoundaryDetector } from "./clinical-boundary.js";
import { SafetyPipeline } from "./pipeline.js";

const detector = new RuleBasedClinicalBoundaryDetector();
const pipeline = new SafetyPipeline();
const route = (text: string, locale = "en-US") => pipeline.evaluate({ text, locale, asrConfidence: null }, { afterHours: false, safetyModeActive: false }).decision;

describe("clinical boundary", () => {
  it.each([
    ["Do you think I have anxiety?", "DIAGNOSIS"],
    ["What's wrong with me?", "DIAGNOSIS"],
    ["Does this sound like depression?", "DIAGNOSIS"],
    ["Should I double my dose of Lexapro tonight?", "MEDICATION"],
    ["Can you prescribe something for sleep?", "MEDICATION"],
    ["Do I need medication for this?", "MEDICATION"],
    ["Can you give me some coping techniques?", "THERAPY_ADVICE"],
    ["Can you be my therapist?", "THERAPY_ADVICE"],
    ["Should I see a psychiatrist instead?", "THERAPY_ADVICE"],
    ["Can you run a PHQ-9 on me?", "CLINICAL_SCREENING"],
    ["Rate my depression from one to ten.", "CLINICAL_SCREENING"],
    ["Can you do the Columbia assessment?", "CLINICAL_SCREENING"],
  ])("[SAFE-01] '%s' is a %s boundary question", (text, category) => {
    expect(detector.detect({ text, locale: "en-US" }).map((f) => f.category)).toContain(category);
  });

  it.each([
    ["¿Debo subir la dosis de mi medicamento?", "MEDICATION"],
    ["¿Qué medicamento me recomienda para dormir?", "MEDICATION"],
    ["¿Será que tengo depresión?", "DIAGNOSIS"],
    ["Deme consejos para la ansiedad.", "THERAPY_ADVICE"],
    ["¿Qué tan grave es mi ansiedad?", "CLINICAL_SCREENING"],
  ])("[SAFE-01] es-US '%s' is a %s boundary question", (text, category) => {
    expect(detector.detect({ text, locale: "es-US" }).map((f) => f.category)).toContain(category);
  });

  it.each([
    "I need to reschedule my therapy session.",
    "Is my psychiatrist appointment on Thursday?",
    "How much is a therapy session?",
    "Does my plan cover medication management visits?",
    "Can I take my appointment by video?",
    "Necesito cambiar mi cita con el psiquiatra.",
    "¿Cuánto debo de mi factura?",
  ])("[SAFE-01] administrative question '%s' is not a boundary question", (text) => {
    expect(detector.detect({ text, locale: "en-US" })).toEqual([]);
  });

  it("[SAFE-01] clinical, medication and diagnosis questions route to the boundary template + clinician route, without authentication", () => {
    for (const text of ["Do you think I have depression?", "Should I stop taking my sertraline?", "Can you diagnose me?", "What kind of therapy should I do?"]) {
      const d = route(text);
      expect(d).toMatchObject({
        route: "CLINICAL_BOUNDARY_ROUTE",
        acknowledgmentTemplateId: CLINICAL_BOUNDARY_TEMPLATE_ID,
        destinationId: CLINICAL_ROUTE_DESTINATION_ID,
        requiresAuthentication: false,
        transferReason: "CLINICAL_QUESTION",
      });
      expect(d.reasonCode).toMatch(/^CLINICAL_BOUNDARY_/);
    }
  });

  it("[SAFE-01] the boundary statement template exists in every locale and carries no diagnostic, therapy or medication content", () => {
    const registry = loadDefaultTemplateRegistry();
    for (const locale of registry.locales()) {
      const t = registry.get(CLINICAL_BOUNDARY_TEMPLATE_ID, locale);
      expect(t?.responseClass).toBe("CLINICAL_BOUNDARY");
      expect(t?.approval.status).toBe("PENDING_CLINICAL_APPROVAL");
      expect(t?.text).not.toMatch(/diagnos|dose|dosis|medicat|medicament|therap|terapia|prescri|recet/i);
    }
  });

  it("[SAFE-01] malformed input yields no finding (the safety detector fails safe separately)", () => {
    expect(detector.detect({ text: 5 as unknown as string, locale: "en-US" })).toEqual([]);
  });
});
