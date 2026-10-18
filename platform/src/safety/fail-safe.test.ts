/**
 * FAIL_SAFE safety signal source (spec section 10; SAFE-02, SAFE-03): inputs that could not be
 * assessed (malformed / oversize input, malformed signal, failed detection stage) raise an
 * UNRESOLVED FAIL_SAFE signal that always takes the safety route; it is never silently ignored
 * and is distinguishable from recognizer uncertainty (ASR_UNCERTAIN) in evidence and metrics.
 * SYNTHETIC text only.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PgliteDb } from "../db/pglite.js";
import { createTestDb } from "../db/testing.js";
import { CALLS, TENANT_ID } from "../fixtures/synthetic-world.js";
import { InMemoryMetrics } from "../observability/metrics.js";
import { HandoffPackage } from "../protocol/index.js";
import { FakeClock } from "../shared/clock.js";
import { FIXTURE_AUDIT_TABLE_SQL, RecordingAuditWriterFixture } from "./__fixtures__/audit-writer.fixture.js";
import { CompositeSafetySignalDetector, RuleBasedSafetySignalDetector, SafetySignalSchema, failSafeSignal } from "./detector.js";
import type { SemanticSignalDetector } from "./detector.js";
import { DETECTOR_RULE_IDS } from "./lexicon.js";
import { SafetyPipeline } from "./pipeline.js";
import type { SafetyDecision, SafetySignal } from "./ports.js";
import { DeterministicSafetyRouter } from "./router.js";
import { SafetyEventRecorder } from "./safety-events.js";

const CTX = { locale: "en-US", afterHours: false, safetyModeActive: false } as const;

/** LOCAL TEST FIXTURE: a semantic stage that is down. */
const failingSemantic: SemanticSignalDetector = {
  detectorId: "semantic.fixture.failing",
  kind: "local_fixture",
  version: "0.0.0-fixture",
  evaluationEvidenceRef: null,
  detect() {
    throw new Error("semantic endpoint unavailable");
  },
};

/** LOCAL TEST FIXTURE: a rule stage that crashes. */
class CrashingRulesFixture extends RuleBasedSafetySignalDetector {
  override run(): never {
    throw new Error("rule stage crashed");
  }
}

describe("FAIL_SAFE signal source", () => {
  it("[SAFE-03][SPEC-10.fail-safe] malformed and oversize input raise UNRESOLVED FAIL_SAFE signals (not ASR_UNCERTAIN)", () => {
    const detector = new CompositeSafetySignalDetector({ semantic: null });
    for (const bad of [null, { text: 7, locale: "en-US", asrConfidence: null }, { text: "x", locale: "en-US", asrConfidence: Number.NaN }]) {
      expect(detector.detect(bad as never)).toEqual([expect.objectContaining({ source: "FAIL_SAFE", strength: "UNRESOLVED", ruleId: DETECTOR_RULE_IDS.inputInvalid })]);
    }
    const oversize = detector.detect({ text: "please help me with my bill. ".repeat(800), locale: "en-US", asrConfidence: 0.95 });
    expect(oversize).toContainEqual(expect.objectContaining({ source: "FAIL_SAFE", ruleId: DETECTOR_RULE_IDS.inputOversize, strength: "UNRESOLVED" }));
    expect(oversize.some((s) => s.source === "ASR_UNCERTAIN")).toBe(false);
    expect(failSafeSignal(DETECTOR_RULE_IDS.signalMalformed, "es-US")).toMatchObject({ source: "FAIL_SAFE", strength: "UNRESOLVED", locale: "es-US" });
    expect(SafetySignalSchema.safeParse(failSafeSignal(DETECTOR_RULE_IDS.inputInvalid)).success).toBe(true);
  });

  it("[SAFE-03][SPEC-10.fail-safe] a failed rule stage is fail safe: FAIL_SAFE signal, degraded coverage, never 'no signal'", () => {
    const detector = new CompositeSafetySignalDetector({ rules: new CrashingRulesFixture(), semantic: failingSemantic });
    const a = detector.analyze({ text: "I have a question about my invoice", locale: "en-US", asrConfidence: 0.9 });
    expect(a.signals).toEqual([expect.objectContaining({ source: "FAIL_SAFE", ruleId: DETECTOR_RULE_IDS.stageFailed, strength: "UNRESOLVED" })]);
    expect(a.coverage.semanticDetector).toMatchObject({ degraded: true });
  });

  it("[SAFE-03][SPEC-10.fail-safe] a failed semantic stage on an utterance with a partial risk lexeme raises FAIL_SAFE; without one the rule assessment stands and coverage is degraded", () => {
    const detector = new CompositeSafetySignalDetector({ semantic: failingSemantic });
    const risky = detector.analyze({ text: "everything feels like it is ending for me", locale: "en-US", asrConfidence: 0.95 });
    if (risky.coverage.riskLexemePresent) {
      expect(risky.signals).toContainEqual(expect.objectContaining({ source: "FAIL_SAFE", ruleId: DETECTOR_RULE_IDS.semanticUnavailable }));
    }
    const forced = new CompositeSafetySignalDetector({ semantic: failingSemantic }).analyze({ text: "I want to die", locale: "en-US", asrConfidence: 0.95 });
    expect(forced.coverage.semanticDetector).toMatchObject({ degraded: true });
    expect(forced.signals.length).toBeGreaterThan(0);
    const benign = detector.analyze({ text: "Can I pay my invoice online?", locale: "en-US", asrConfidence: 0.95 });
    expect(benign.signals).toEqual([]);
    expect(benign.coverage.semanticDetector).toMatchObject({ degraded: true });
  });

  it("[SAFE-02][SAFE-03] the router sends fail-safe-only signals to the safety human with a distinct reason and routing reason; no authentication is required", () => {
    const router = new DeterministicSafetyRouter();
    const d = router.route({ signals: [failSafeSignal(DETECTOR_RULE_IDS.inputInvalid, "en-US")], context: CTX });
    expect(d).toMatchObject({
      route: "SAFETY_PRIORITY_HUMAN",
      reasonCode: "SAFETY_INPUT_UNASSESSED_FAIL_SAFE",
      safetyRoutingReason: "FAIL_SAFE",
      requiresAuthentication: false,
      enterSafetyMode: true,
      riskFlagToSet: "SAFETY_ESCALATION_ACTIVE",
      transferReason: "SAFETY_PRIORITY",
      strongestStrength: "UNRESOLVED",
      signalSources: ["FAIL_SAFE"],
    });
    // A real concern outranks the fail-safe signal as the primary routing reason.
    const explicit: SafetySignal = { source: "EXPLICIT_PHRASE", ruleId: "explicit.en.self_kill", strength: "CREDIBLE", subject: "SELF", temporal: "CURRENT", negated: false, locale: "en-US" };
    const both = router.route({ signals: [failSafeSignal(DETECTOR_RULE_IDS.inputOversize), explicit], context: CTX });
    expect(both).toMatchObject({ safetyRoutingReason: "EXPLICIT_PHRASE", reasonCode: "SAFETY_SIGNAL_CREDIBLE", signalSources: ["EXPLICIT_PHRASE", "FAIL_SAFE"] });
    // A malformed signal object is itself fail safe.
    const malformed = router.route({ signals: [{ source: "MODEL_SAYS_FINE" }], context: CTX });
    expect(malformed).toMatchObject({ route: "SAFETY_PRIORITY_HUMAN", reasonCode: "SAFETY_SIGNAL_MALFORMED_FAIL_SAFE", safetyRoutingReason: "FAIL_SAFE" });
  });

  it("[SAFE-03] the pipeline routes an unassessable utterance to the safety human end to end", () => {
    const evaluation = new SafetyPipeline().evaluate({ text: undefined, locale: "en-US", asrConfidence: null } as never, { afterHours: false, safetyModeActive: false });
    expect(evaluation.decision).toMatchObject({ route: "SAFETY_PRIORITY_HUMAN", safetyRoutingReason: "FAIL_SAFE" });
    expect(evaluation.signals.map((s) => s.source)).toEqual(["FAIL_SAFE"]);
  });

  it("[SPEC-10.handoff] the handoff package and the SafetyDecision port carry the extended routing fields (optional on the port)", () => {
    const d: SafetyDecision = new DeterministicSafetyRouter().decide([failSafeSignal(DETECTOR_RULE_IDS.inputInvalid)], CTX);
    expect(d).toMatchObject({ enterSafetyMode: true, riskFlagToSet: "SAFETY_ESCALATION_ACTIVE", interpreterRequired: false, transferReason: "SAFETY_PRIORITY", externalEmergencyConferencing: "NOT_AUTOMATED_HUMAN_OWNED" });
    // A minimal decision (older callers) still type-checks without the optional fields.
    const minimal: SafetyDecision = { route: "NONE", acknowledgmentTemplateId: null, revokePendingActions: false, requiresAuthentication: false, destinationId: null, reasonCode: "NO_SAFETY_SIGNAL" };
    expect(minimal.enterSafetyMode).toBeUndefined();
    const enumValues = (HandoffPackage.shape.safetyRoutingReason.unwrap() as unknown as { options: string[] }).options;
    expect(enumValues).toContain("FAIL_SAFE");
  });
});

describe("FAIL_SAFE evidence (safety_events + metrics)", () => {
  let db: PgliteDb;
  beforeEach(async () => {
    db = await createTestDb({ include: /^061/ });
    await db.exec(FIXTURE_AUDIT_TABLE_SQL);
  });
  afterEach(async () => db.close());

  it("[SAFE-03][SPEC-13.metrics] a fail-safe incident is recorded with signal source FAIL_SAFE and counted under signal_source=fail_safe", async () => {
    const clock = new FakeClock("2026-10-17T15:00:00.000Z");
    const metrics = new InMemoryMetrics();
    const recorder = new SafetyEventRecorder({ db, audit: new RecordingAuditWriterFixture({ table: "fixture_audit_events" }), clock, metrics });
    const signals = [failSafeSignal(DETECTOR_RULE_IDS.inputInvalid, "en-US")];
    const decision = new DeterministicSafetyRouter().route({ signals, context: CTX });
    const incident = recorder.begin({
      tenantId: TENANT_ID,
      callId: CALLS.primary.callId,
      sessionGeneration: 0,
      turnId: "turn_synthTurn0002",
      signals,
      decision: { route: decision.route, destinationId: decision.destinationId, reasonCode: decision.reasonCode },
      locale: "en-US",
      afterHours: false,
    });
    expect((await recorder.recordValidated(incident)).recorded).toBe(true);
    clock.advanceMs(300);
    expect((await recorder.recordRouteInitiated(incident)).recorded).toBe(true);
    const rows = await db.tx((tx) => tx.query<{ signal_sources: string[]; reason_code: string }>("select signal_sources, reason_code from safety_events order by recorded_at"), { role: "owner" });
    expect(rows.rows.map((r) => r.signal_sources)).toEqual([["FAIL_SAFE"], ["FAIL_SAFE"]]);
    expect(rows.rows[0]?.reason_code).toBe("SAFETY_INPUT_UNASSESSED_FAIL_SAFE");
    expect(metrics.counterValue("vsp_safety_signals_total", { signal_source: "fail_safe" })).toBe(1);
    expect(metrics.observations("vsp_safety_time_to_routing_ms", { signal_source: "fail_safe" })).toEqual([300]);
  });
});
