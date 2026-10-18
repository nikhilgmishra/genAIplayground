/**
 * Property tests (fast-check, fixed seeds => deterministic) for the safety
 * detector. SYNTHETIC text only.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CompositeSafetySignalDetector, SafetySignalSchema } from "./detector.js";
import { ALL_RULE_IDS } from "./lexicon.js";

const detector = new CompositeSafetySignalDetector();
const RUNS = { numRuns: 400, seed: 20261017 };

const EN_RISK = ["i want to kill myself", "i want to end my life", "i want to die", "i keep hurting myself", "i am going to take my own life"];
const ES_RISK = ["quiero matarme", "me quiero morir", "quiero quitarme la vida", "ya no quiero vivir", "me voy a suicidar"];
const PREFIXES = [
  "",
  "honestly",
  "i think",
  "um",
  "well",
  "you know",
  "my bill is late and",
  "this is about my appointment but",
  "i dont know",
  "sometimes",
  "lately",
  "the portal is down and",
  "i called yesterday and",
  "my phone",
  "esta factura y",
  "no se",
  "la verdad",
];
const SUFFIXES = ["", "and my invoice is wrong", "this hold music is killing me", "i could die of embarrassment", "por favor", "can you help", "es todo"];

describe("detector properties", () => {
  it("[SPEC-10.detection] an explicit risk phrase always yields at least one signal whatever surrounds it (negation/idioms never suppress)", () => {
    fc.assert(
      fc.property(fc.constantFrom(...EN_RISK, ...ES_RISK), fc.constantFrom(...PREFIXES), fc.constantFrom(...SUFFIXES), fc.constantFrom("en-US", "es-US"), (risk, prefix, suffix, locale) => {
        const text = `${prefix} ${risk}. ${suffix}`;
        expect(detector.detect({ text, locale, asrConfidence: null }).length).toBeGreaterThan(0);
      }),
      RUNS,
    );
  });

  it("[DATA-01] for arbitrary input every signal is schema-valid, uses a known rule id and never echoes a marker word", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), fc.constantFrom("", ...EN_RISK, ...ES_RISK), fc.constantFrom("en-US", "es-US", "fr-FR", "zz", "en_us"), fc.option(fc.double({ min: 0, max: 1, noNaN: true }), { nil: null }), (noise, risk, locale, asr) => {
        const marker = "Qvzmarkerword";
        const text = `${noise} ${marker} ${risk}`;
        const r = detector.analyze({ text, locale, asrConfidence: asr });
        for (const s of r.signals) {
          expect(SafetySignalSchema.safeParse(s).success).toBe(true);
          expect(ALL_RULE_IDS.has(s.ruleId)).toBe(true);
        }
        expect(JSON.stringify(r).toLowerCase()).not.toContain(marker.toLowerCase());
      }),
      RUNS,
    );
  });

  it("[SPEC-10.detection] detection is deterministic: the same input always yields the same signals", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 120 }), fc.constantFrom(...EN_RISK, ...ES_RISK, "this bill is killing me"), (noise, phrase) => {
        const input = { text: `${phrase} ${noise}`, locale: "en-US", asrConfidence: null };
        expect(detector.detect(input)).toEqual(detector.detect(input));
      }),
      { numRuns: 200, seed: 7 },
    );
  });

  it("[SPEC-10.frustration] frustration about administrative objects never raises a signal", () => {
    const objects = ["hold music", "phone menu", "billing department", "portal", "website", "invoice", "claim", "wait"];
    const shapes = ["i cant take this {o} anymore", "im so frustrated with this {o}", "i hate this {o}", "this {o} is ridiculous", "whats the point of this {o}", "i give up on this {o}", "ya no aguanto mas esta espera"];
    fc.assert(
      fc.property(fc.constantFrom(...shapes), fc.constantFrom(...objects), (shape, o) => {
        expect(detector.detect({ text: shape.replace("{o}", o), locale: "en-US", asrConfidence: null })).toEqual([]);
      }),
      { numRuns: 200, seed: 11 },
    );
  });
});
