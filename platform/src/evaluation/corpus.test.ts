import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Role, ScenarioDefinition, VariantFamily } from "../protocol/index.js";
import { loadCatalog } from "./catalog.js";
import { corpusDigest, corpusStats, loadCorpus } from "./corpus.js";
import { idealEvidenceFixture } from "./evidence.fixture.js";
import { RiskBundle } from "./generate-risk.js";
import { checkDrift, planCorpusFiles, scenarioIdFor, VARIANT_FAMILIES } from "./generate.js";
import { checkRiskDrift, planRiskFiles } from "./generate-risk.js";
import { FAULTED_JOURNEYS, JOURNEYS, REQUIRED_JOURNEY_FAULTS } from "./journeys.js";
import { REPO_ROOT, repoPaths, walkFiles } from "./paths.js";
import { scoreScenario } from "./scorer.js";
import { loadSkeletons } from "./skeleton.js";
import { HELDOUT_PERMILLE, stableSplit } from "./split.js";
import { RISK_DRAFT_LABEL } from "./vocabulary.js";

const corpus = loadCorpus();
const routine = corpus.entries.filter((e) => e.kind === "routine").map((e) => e.scenario);
const risk = corpus.entries.filter((e) => e.kind === "risk_draft");
const paths = repoPaths();

describe("scenario corpus (synthetic, UNREVIEWED)", () => {
  it("[SPEC-16.scenario-definition] every generated, journey and risk scenario file validates strictly against ScenarioDefinition", () => {
    const files = [
      ...walkFiles(paths.generated, (f) => f.endsWith(".json")),
      ...walkFiles(paths.journeys, (f) => f.endsWith(".json")),
    ];
    expect(files.length).toBeGreaterThanOrEqual(400);
    for (const f of files) expect(ScenarioDefinition.safeParse(JSON.parse(readFileSync(f, "utf8"))).success, f).toBe(true);
    for (const f of walkFiles(paths.risk, (x) => x.endsWith(".json"))) expect(RiskBundle.safeParse(JSON.parse(readFileSync(f, "utf8"))).success, f).toBe(true);
  });

  it("[SPEC-14.intent-corpus] at least 50 intents, every intent in all 8 variant families, all audiences present", () => {
    const stats = corpusStats(corpus);
    expect(stats.routineIntents).toBeGreaterThanOrEqual(50);
    expect(stats.variantFamilies).toBe(8);
    const byIntent = new Map<string, Set<string>>();
    for (const s of routine) byIntent.set(s.intent, (byIntent.get(s.intent) ?? new Set()).add(s.variantFamily));
    for (const [intent, families] of byIntent) expect([...families].sort(), intent).toEqual([...VariantFamily.options].sort());
    const audiences = new Set(routine.map((s) => s.audience));
    for (const role of Role.options) expect(audiences.has(role), role).toBe(true);
    expect(audiences.has(null)).toBe(true);
    // client/prospective, provider/practice staff and partner/payer families are all represented
    for (const group of [["client", "prospective_client"], ["provider", "practice_staff"], ["partner", "payer_representative"]]) {
      expect(routine.filter((s) => s.audience !== null && group.includes(s.audience)).length).toBeGreaterThan(16);
    }
  });

  it("[SPEC-14.intent-corpus][OPS-03] nothing claims human review: every routine scenario is UNREVIEWED", () => {
    expect(routine.every((s) => s.review.status === "UNREVIEWED" && s.review.reviewer === null)).toBe(true);
    expect(corpusStats(corpus).routineHumanReviewed).toBe(0);
  });

  it("[SPEC-14.risk-corpus][OPS-03] >= 500 risk drafts, all UNREVIEWED, labelled as not satisfying the human-reviewed requirement, separate from routine tests", () => {
    expect(risk.length).toBeGreaterThanOrEqual(500);
    expect(risk.every((e) => e.scenario.review.status === "UNREVIEWED")).toBe(true);
    expect(risk.every((e) => e.scenario.riskClass !== "routine")).toBe(true);
    for (const f of walkFiles(paths.risk, (x) => x.endsWith(".json"))) {
      const b = RiskBundle.parse(JSON.parse(readFileSync(f, "utf8")));
      expect(b.label).toBe(RISK_DRAFT_LABEL);
      expect(b.label).toContain("does not satisfy the 500 human-reviewed requirement");
      expect(b.humanReviewed).toBe(false);
      expect(b.countsTowardHumanReviewedRequirement).toBe(false);
    }
    const routineIds = new Set(routine.map((s) => s.scenarioId));
    expect(risk.some((e) => routineIds.has(e.scenario.scenarioId))).toBe(false);
    const classes = new Set(risk.map((e) => e.scenario.riskClass));
    for (const c of ["privacy", "authorization", "clinical_boundary", "safety_routing"]) expect(classes.has(c as never), c).toBe(true);
    const families = new Set(risk.map((e) => e.riskFamily));
    for (const f of [
      "cross_account",
      "partner_overreach",
      "expired_proxy",
      "minor_confidentiality",
      "enumeration_probe",
      "prompt_injection_speech",
      "prompt_injection_knowledge",
      "dial_target_injection",
      "otp_leakage",
      "role_combining",
      "auth_gate_string_values",
      "safety_negation",
      "safety_historical",
      "safety_third_party",
      "safety_idiom",
      "safety_spanish",
      "clinical_medication",
      "clinical_diagnosis",
      "consent_declined",
      "audit_outage",
      "crash_after_commit",
      "duplicate_webhook",
    ]) {
      expect(families.has(f), f).toBe(true);
    }
  });

  it("[SPEC-16.scenario-definition] held-out split is a stable hash of the scenario id (~20%), independent of order, and matches the directory", () => {
    for (const e of corpus.entries.filter((x) => x.kind === "routine")) {
      expect(e.scenario.split).toBe(stableSplit(e.scenario.scenarioId));
      expect(e.file.includes(`/${e.scenario.split}/`)).toBe(true);
    }
    const heldout = routine.filter((s) => s.split === "heldout_acceptance").length / routine.length;
    expect(heldout).toBeGreaterThan(0.12);
    expect(heldout).toBeLessThan(0.28);
    expect(HELDOUT_PERMILLE).toBe(200);
    const ids = routine.map((s) => s.scenarioId);
    const shuffled = [...ids].reverse();
    expect(shuffled.map(stableSplit)).toEqual(ids.map(stableSplit).reverse());
    expect(stableSplit("scn_example__baseline")).toBe(stableSplit("scn_example__baseline"));
    expect(JOURNEYS.every((j) => j.split === "development")).toBe(true);
  });

  it("[SPEC-16.scenario-definition] generation is deterministic and the committed corpus has no drift (--check)", () => {
    const a = planCorpusFiles();
    const b = planCorpusFiles();
    expect(a.problems).toEqual([]);
    expect(a.files).toEqual(b.files);
    expect(checkDrift(REPO_ROOT, a.files)).toEqual({ missing: [], changed: [], stale: [] });
    const r = planRiskFiles();
    expect(r.problems).toEqual([]);
    expect(checkRiskDrift(REPO_ROOT, r.files)).toEqual({ missing: [], changed: [], stale: [] });
    for (const sk of loadSkeletons(paths.skeletons)) {
      for (const f of VARIANT_FAMILIES) expect(corpus.byId.has(scenarioIdFor(sk.intent, f))).toBe(true);
    }
  });

  it("[SPEC-16.journeys] the nine required demonstration journeys are present as ScenarioDefinitions", () => {
    const journeys = corpus.entries.filter((e) => e.kind === "journey").map((e) => e.scenario);
    expect(journeys).toHaveLength(9);
    const byIntent = new Map(journeys.map((j) => [j.intent, j]));
    expect(byIntent.get("appointment_reschedule")?.initialState.fixtureSet).toBe("synthetic_world_slot_conflict");
    expect(byIntent.get("billing_dispute")?.prohibitedActions).toContain("speak:refund_promise");
    expect(byIntent.get("billing_dispute")?.expectedFinalState.outcome).toBe("REQUEST_ACCEPTED");
    expect(byIntent.get("delegated_practice_remittance")?.audience).toBe("practice_staff");
    expect(byIntent.get("partner_employee_treatment_status")?.expectedFinalState.outcome).toBe("DECLINED_BY_POLICY");
    expect(byIntent.get("human_request")?.expectedAssurance).toBe("A0");
    const safety = byIntent.get("safety_disclosure_self");
    expect(safety?.requiredHandoff).toBe("SAFETY_PRIORITY");
    expect(safety?.expectedAssurance).toBe("A0");
    expect(safety?.prohibitedActions).toContain("tool:begin_verification");
    expect(byIntent.get("recording_declined")?.script.some((t) => t.text === "RECORDING_DECLINED")).toBe(true);
    expect(byIntent.get("unsupported_language")?.requiredHandoff).toBe("INTERPRETER");
    expect(byIntent.get("repeat_caller_resume_issue")?.initialState.fixtureSet).toBe("synthetic_world_open_case");
  });

  it("[SPEC-16.fault-injection] deterministic failure fixtures exist independent of LLM generation and every required journey fault is bound to a journey", () => {
    expect(corpus.faultPlans.size).toBeGreaterThanOrEqual(8);
    for (const id of [
      "AUTH_EXPIRY_MID_CALL",
      "CONCURRENT_SAME_ACCOUNT",
      "INTERRUPTED_CONFIRMATION",
      "DUPLICATE_WEBHOOK",
      "CRASH_AFTER_COMMIT",
      "SALESFORCE_OUTAGE",
      "TRANSFER_FAILED",
      "AUDIT_OUTAGE",
      "SCHEDULING_TIMEOUT_AFTER_COMMIT",
      "RECEIVER_UNAVAILABLE",
      "BRIDGE_DROPPED",
      "QUOTA_EXHAUSTED",
    ]) {
      const plan = corpus.faultPlans.get(id);
      expect(plan, id).toBeDefined();
      expect(plan?.llmGenerated).toBe(false);
      expect(plan?.deterministic).toBe(true);
      expect(plan?.expectations.length).toBeGreaterThan(0);
    }
    for (const fault of REQUIRED_JOURNEY_FAULTS) expect(FAULTED_JOURNEYS.some((j) => j.initialState.faults.includes(fault)), fault).toBe(true);
    const referenced = new Set(corpus.entries.flatMap((e) => e.scenario.initialState.faults));
    for (const f of referenced) expect(corpus.faultPlans.has(f), f).toBe(true);
  });

  it("[SPEC-14.failure-injection] fault plans cover the vendor and business failure list of section 14", () => {
    const effects = new Set([...corpus.faultPlans.values()].map((p) => p.effect.kind));
    for (const k of [
      "DEPENDENCY_TIMEOUT",
      "KNOWLEDGE_STALE",
      "QUOTA_EXHAUSTED",
      "OUT_OF_ORDER_DELIVERY",
      "DUPLICATE_DELIVERY",
      "PARTIAL_WRITE",
      "PROCESS_CRASH",
      "REGION_FAILOVER",
      "RECEIVER_UNAVAILABLE",
      "BRIDGE_DROPPED",
      "AUDIT_SINK_UNAVAILABLE",
      "REDACTION_FAILURE",
      "GUARDRAIL_LIMIT",
    ]) {
      expect(effects.has(k as never), k).toBe(true);
    }
    expect([...corpus.faultPlans.values()].some((p) => p.effect.afterExternalCommit)).toBe(true);
    // consent refusal is a scenario condition, not an infrastructure fault
    expect(corpus.entries.some((e) => e.scenario.script.some((t) => t.text === "RECORDING_DECLINED"))).toBe(true);
  });

  it("[SPEC-14.repetitions] safety, clinical-boundary, malicious and noisy scenarios repeat at least five times", () => {
    for (const e of corpus.entries) {
      const s = e.scenario;
      const selected = s.riskClass === "safety_routing" || s.riskClass === "clinical_boundary" || s.variantFamily === "malicious_instruction" || s.variantFamily === "interrupted_or_noisy";
      if (selected) expect(s.repetitions, s.scenarioId).toBeGreaterThanOrEqual(5);
    }
  });

  it("[SPEC-14.edge-populations] skeletons cover the listed edge populations", () => {
    const pops = new Set(loadSkeletons(paths.skeletons).flatMap((s) => s.edgePopulations));
    for (const p of ["long_pauses", "speech_impairment", "accented_speech", "hearing_relay", "interpreter_routing", "third_party_caller", "minors", "expired_proxy", "role_switching", "cross_account", "shared_device"]) {
      expect(pops.has(p), p).toBe(true);
    }
  });

  it("[SPEC-16.scenario-definition] every scenario is internally consistent: evidence matching its own expectations scores PASS", () => {
    const failures: string[] = [];
    for (const e of corpus.entries) {
      const r = scoreScenario(e.scenario, idealEvidenceFixture(e.scenario), {
        runId: "run_consistency01",
        runAt: "2026-10-17T15:00:00.000Z",
        repetition: 1,
        environment: "local",
        executionMode: "local_fixture",
        missingFaultPlans: [],
        injectionFailures: [],
        driverError: null,
        faultPlans: corpus.faultPlans,
      });
      if (r.verdict !== "PASS") failures.push(`${e.scenario.scenarioId}: ${r.failureCode}`);
    }
    expect(failures).toEqual([]);
  });

  it("[SPEC-16.offline-first] corpus text uses only fictional 555-01xx numbers and synthetic identifiers", () => {
    const text = walkFiles(paths.scenarios, (f) => /\.(json|ya?ml)$/.test(f))
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");
    for (const m of text.matchAll(/\b\d{3}-\d{4}\b/g)) expect(m[0], m[0]).toMatch(/^555-01\d\d$/);
    expect(text).not.toMatch(/\b\d{10,11}\b/);
    expect(text).not.toMatch(/\b\d{3}-\d{2}-\d{4}\b/); // SSN-shaped
  });

  it("[OPS-06] the corpus digest is deterministic over sorted scenario files", () => {
    const a = corpusDigest();
    const b = corpusDigest();
    expect(a.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(a).toEqual(b);
    expect(a.files.map((f) => f.path)).toEqual([...a.files.map((f) => f.path)].sort());
    expect(a.files.some((f) => f.path.startsWith("scenarios/fixtures/failures/"))).toBe(true);
  });

  it("[SPEC-14.traceability] requirement ids referenced by skeletons and fault plans exist in the catalogue", () => {
    const catalog = loadCatalog(join(REPO_ROOT, "docs/requirements/catalog.yaml"));
    const ids = [...loadSkeletons(paths.skeletons).flatMap((s) => s.requirementIds), ...[...corpus.faultPlans.values()].flatMap((p) => p.requirementIds)];
    for (const id of new Set(ids)) expect(catalog.resolve(id), id).toBeDefined();
  });
});
