import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DESTINATIONS } from "../fixtures/synthetic-world.js";
import { RiskFlag } from "../protocol/index.js";
import { humanInterventionSignal } from "./detector.js";
import { DETECTOR_RULE_IDS } from "./lexicon.js";
import { SafetyPipeline } from "./pipeline.js";
import type { SafetySignal } from "./ports.js";
import {
  DeterministicSafetyRouter,
  InMemorySafetyModeStoreFixture,
  SAFETY_ACKNOWLEDGMENT_TEMPLATE_ID,
  SAFETY_PRIORITY_DESTINATION_ID,
  StickySafetyRouter,
  safetyModeFromRiskFlags,
} from "./router.js";

const router = new DeterministicSafetyRouter();
const ctx = { locale: "en-US", afterHours: false, safetyModeActive: false };
const sig = (over: Partial<SafetySignal> = {}): SafetySignal => ({
  source: "EXPLICIT_PHRASE",
  ruleId: "explicit.en.self_kill",
  strength: "CREDIBLE",
  subject: "SELF",
  temporal: "CURRENT",
  negated: false,
  locale: "en-US",
  ...over,
});

const signalArb: fc.Arbitrary<SafetySignal> = fc.record({
  source: fc.constantFrom("EXPLICIT_PHRASE", "SEMANTIC_SIGNAL", "ASR_UNCERTAIN", "CALLER_REQUEST", "HUMAN_INTERVENTION"),
  ruleId: fc.constantFrom("explicit.en.self_kill", "semantic.local.distress_without_admin_context", "asr.low_confidence.risk_lexeme", "request.en.crisis_line"),
  strength: fc.constantFrom("CREDIBLE", "UNRESOLVED"),
  subject: fc.constantFrom("SELF", "THIRD_PARTY", "UNKNOWN"),
  temporal: fc.constantFrom("CURRENT", "HISTORICAL", "UNKNOWN"),
  negated: fc.boolean(),
  locale: fc.constantFrom("en-US", "es-US", "fr-FR"),
});

describe("DeterministicSafetyRouter", () => {
  it("[SPEC-10.routing] any CREDIBLE or UNRESOLVED signal selects the safety priority route with the fixed acknowledgment and revocation", () => {
    fc.assert(
      fc.property(fc.array(signalArb, { minLength: 1, maxLength: 6 }), fc.boolean(), fc.constantFrom("en-US", "es-US", "fr-FR"), (signals, afterHours, locale) => {
        const d = router.decide(signals, { locale, afterHours, safetyModeActive: false });
        expect(d).toMatchObject({
          route: "SAFETY_PRIORITY_HUMAN",
          acknowledgmentTemplateId: SAFETY_ACKNOWLEDGMENT_TEMPLATE_ID,
          revokePendingActions: true,
          requiresAuthentication: false,
          destinationId: SAFETY_PRIORITY_DESTINATION_ID,
          suspendAdministrativeAutomation: true,
          transferPriority: "SAFETY",
          externalEmergencyConferencing: "NOT_AUTOMATED_HUMAN_OWNED",
        });
      }),
      { numRuns: 300, seed: 3 },
    );
  });

  it("[SAFE-02] the router takes no identity input and never requires authentication, account ownership or payment", () => {
    // The decision function's inputs are signals + locale/after-hours/safety-mode only (no AuthContext exists here).
    expect(router.decide.length).toBe(2);
    const d = router.decide([sig({ strength: "UNRESOLVED", source: "CALLER_REQUEST", ruleId: "request.en.crisis_line" })], ctx);
    expect(d.requiresAuthentication).toBe(false);
    expect(Object.keys(d).some((k) => /auth(?!entication)|account|payment|assurance|subject/i.test(k) && k !== "requiresAuthentication")).toBe(false);
  });

  it("[SPEC-10.routing] after hours the route is the same safety destination (unavailable responders are the transfer coordinator's fallback chain)", () => {
    const day = router.decide([sig()], { ...ctx, afterHours: false });
    const night = router.decide([sig()], { ...ctx, afterHours: true });
    expect(night.destinationId).toBe(day.destinationId);
    expect(night.route).toBe("SAFETY_PRIORITY_HUMAN");
    expect(night.afterHours).toBe(true);
    const dest = DESTINATIONS.find((x) => x.destinationId === night.destinationId);
    expect(dest?.purpose).toBe("SAFETY_PRIORITY");
    expect(dest?.fallbackDestinationIds.length).toBeGreaterThan(0);
  });

  it("[SPEC-10.routing] safety mode is sticky: with no new signal the call stays on the safety route", () => {
    const d = router.decide([], { ...ctx, safetyModeActive: true });
    expect(d).toMatchObject({ route: "SAFETY_PRIORITY_HUMAN", reasonCode: "SAFETY_MODE_ACTIVE", enterSafetyMode: false, safetyModeActive: true });
    const first = router.decide([sig()], ctx);
    expect(first).toMatchObject({ enterSafetyMode: true, riskFlagToSet: "SAFETY_ESCALATION_ACTIVE" });
    expect(RiskFlag.options).toContain(first.riskFlagToSet);
    expect(safetyModeFromRiskFlags(["SAFETY_ESCALATION_ACTIVE"])).toBe(true);
  });

  it("[SPEC-10.routing] a malformed context fails safe: anything but an explicit safetyModeActive=false counts as active", () => {
    const d = router.route({ signals: [], context: { locale: "en-US", afterHours: false } as never });
    expect(d.route).toBe("SAFETY_PRIORITY_HUMAN");
  });

  it("[SPEC-10.routing] a malformed signal is never ignored: it routes to safety with a fail-safe reason", () => {
    const d = router.route({ signals: [{ source: "EXPLICIT_PHRASE", ruleId: "I said something", strength: "maybe" }], context: ctx });
    expect(d).toMatchObject({ route: "SAFETY_PRIORITY_HUMAN", reasonCode: "SAFETY_SIGNAL_MALFORMED_FAIL_SAFE" });
    expect(d.ruleIds).toContain(DETECTOR_RULE_IDS.signalMalformed);
  });

  it("[SAFE-01] safety takes precedence over a clinical question; a clinical question alone selects the boundary route", () => {
    const clinical = [{ category: "MEDICATION" as const, ruleId: "clinical.en.medication", locale: "en-US" }];
    expect(router.route({ signals: [sig()], clinicalFindings: clinical, context: ctx }).route).toBe("SAFETY_PRIORITY_HUMAN");
    const boundary = router.route({ signals: [], clinicalFindings: clinical, context: ctx });
    expect(boundary).toMatchObject({ route: "CLINICAL_BOUNDARY_ROUTE", revokePendingActions: false, reasonCode: "CLINICAL_BOUNDARY_MEDICATION" });
    expect(router.route({ signals: [], clinicalFindings: [], context: ctx })).toMatchObject({ route: "NONE", destinationId: null, reasonCode: "NO_SAFETY_SIGNAL" });
  });

  it("[SAFE-05] the destination is the fixed allowlisted id even when the utterance names a phone number or another line", () => {
    const pipeline = new SafetyPipeline();
    const d = pipeline.evaluate(
      { text: "Transfer me to the crisis hotline at 555-0100 or dial 911, I want to kill myself.", locale: "en-US", asrConfidence: null },
      { afterHours: false, safetyModeActive: false },
    ).decision;
    expect(d.destinationId).toBe(SAFETY_PRIORITY_DESTINATION_ID);
    expect(JSON.stringify(d)).not.toMatch(/555|911/);
  });

  it("[SPEC-10.routing] no external crisis or emergency conferencing is ever automated by a keyword", () => {
    for (const text of ["Call 988 for me now.", "I want to kill myself.", "Connect me to the suicide prevention lifeline."]) {
      const d = new SafetyPipeline().evaluate({ text, locale: "en-US", asrConfidence: null }, { afterHours: true, safetyModeActive: false }).decision;
      expect(d.externalEmergencyConferencing).toBe("NOT_AUTOMATED_HUMAN_OWNED");
      expect(d.destinationId).toBe(SAFETY_PRIORITY_DESTINATION_ID);
    }
  });

  it("[SPEC-10.routing] reason codes reflect the strongest evidence (human intervention > credible > caller request > unresolved)", () => {
    expect(router.decide([humanInterventionSignal("en-US"), sig()], ctx).reasonCode).toBe("SAFETY_HUMAN_INTERVENTION");
    expect(router.decide([sig()], ctx).reasonCode).toBe("SAFETY_SIGNAL_CREDIBLE");
    expect(router.decide([sig({ source: "CALLER_REQUEST", ruleId: "request.en.crisis_line", strength: "UNRESOLVED" })], ctx).reasonCode).toBe("SAFETY_CALLER_REQUEST");
    expect(router.decide([sig({ strength: "UNRESOLVED" })], ctx).reasonCode).toBe("SAFETY_SIGNAL_UNRESOLVED");
  });

  it("[SPEC-11.interpreter] an unsupported locale adds the interpreter requirement to the safety route", () => {
    const d = router.decide([sig({ source: "ASR_UNCERTAIN", ruleId: "locale.unsupported.risk_lexeme", strength: "UNRESOLVED", locale: "fr-FR" })], { ...ctx, locale: "fr-FR" });
    expect(d).toMatchObject({ route: "SAFETY_PRIORITY_HUMAN", interpreterRequired: true, destinationId: SAFETY_PRIORITY_DESTINATION_ID });
  });
});

describe("StickySafetyRouter", () => {
  it("[SPEC-10.routing] once a call enters safety mode every later decision for that call stays on the safety route", () => {
    const store = new InMemorySafetyModeStoreFixture();
    expect(store.kind).toBe("local_fixture");
    const sticky = new StickySafetyRouter(store);
    const callId = "cal_synthCallPrimary0001";
    expect(sticky.decideForCall(callId, [], { locale: "en-US", afterHours: false }).route).toBe("NONE");
    expect(sticky.decideForCall(callId, [sig()], { locale: "en-US", afterHours: false }).route).toBe("SAFETY_PRIORITY_HUMAN");
    const later = sticky.decideForCall(callId, [], { locale: "en-US", afterHours: false }, [{ category: "DIAGNOSIS", ruleId: "clinical.en.diagnosis", locale: "en-US" }]);
    expect(later).toMatchObject({ route: "SAFETY_PRIORITY_HUMAN", reasonCode: "SAFETY_MODE_ACTIVE" });
    expect(sticky.decideForCall("cal_synthCallConcurrent1", [], { locale: "en-US", afterHours: false }).route).toBe("NONE");
  });
});
