import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as PF from "../protocol/fixtures/contracts.fixture.js";
import type { ScenarioDefinition } from "../protocol/index.js";
import { canonicalJson } from "../shared/canonical.js";
import { loadCorpus } from "./corpus.js";
import { CHANGES_DIR, LOCK_PATH, LOCK_VERSION, REVIEWS_DIR, buildLock, checkCorpusGuard, diffAgainstLock, handoffAdmits, isHardCase, lockMayAdvance, ruleNarrows, scenarioRelaxations } from "./corpus-guard.js";
import { guardLines } from "./corpus-step.js";
import type { ChangeRecord, GuardInputs } from "./corpus-guard.js";
import type { FaultPlan, ReachEvidence } from "./fault-plan.js";
import { JOURNEYS } from "./journeys.js";
import { REPO_ROOT } from "./paths.js";
import { SCORER_GATES } from "./scorer.js";
import { expectsVerificationBeforeSafetyRoute, isEffectTakingToolName } from "./vocabulary.js";

const corpus = loadCorpus();
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const scenarios = JOURNEYS.slice(0, 3) as ScenarioDefinition[];
const plans = new Map([...corpus.faultPlans].filter(([id]) => ["POLICY_ENGINE_ERROR", "CRASH_AFTER_COMMIT"].includes(id)));
const base: GuardInputs = { scenarios, plans };

/** A temporary corpus root holding a lock built from `locked` (no change records yet). */
function tree(locked: GuardInputs = base): string {
  const root = mkdtempSync(join(tmpdir(), "vsp-guard-"));
  dirs.push(root);
  mkdirSync(join(root, "scenarios", "locks"), { recursive: true });
  writeFileSync(join(root, LOCK_PATH), JSON.stringify(buildLock(locked)));
  return root;
}
function record(root: string, rec: Omit<ChangeRecord, "changeVersion" | "createdAt" | "authorRole" | "reason">): void {
  mkdirSync(join(root, CHANGES_DIR), { recursive: true });
  const full: ChangeRecord = { changeVersion: "corpus-change.v1", createdAt: "2026-10-19T12:00:00.000Z", authorRole: "coding_agent", reason: "SYNTHETIC test change record for the corpus guard unit test", ...rec };
  writeFileSync(join(root, CHANGES_DIR, `${rec.changeId}.json`), JSON.stringify(full));
}
function review(root: string, reviewId: string, subjectRef: string, over: Record<string, unknown> = {}): void {
  mkdirSync(join(root, REVIEWS_DIR), { recursive: true });
  const r = { ...PF.reviewRecord(), reviewId, subject: { kind: "SCENARIO", ref: subjectRef, version: "1" }, ...over };
  writeFileSync(join(root, REVIEWS_DIR, `${reviewId}.json`), JSON.stringify(r));
}
const relabel = (s: ScenarioDefinition): ScenarioDefinition => ({ ...s, expectedFinalState: { ...s.expectedFinalState, outcome: s.expectedFinalState.outcome === "RESOLVED" ? "INFORMATION_PROVIDED" : "RESOLVED" } });

describe("[FO-17-13][OPS-03] corpus guard: no silent removal, relabel or gate weakening", () => {
  it("[FO-17-13] an unchanged corpus matches its lock", () => {
    const g = checkCorpusGuard(tree(), base);
    expect(g).toMatchObject({ lockPresent: true, ok: true, lockStale: false, differences: [] });
  });

  it("[FO-17-13] a missing lock is never ok", () => {
    const root = mkdtempSync(join(tmpdir(), "vsp-guard-"));
    dirs.push(root);
    expect(checkCorpusGuard(root, base)).toMatchObject({ lockPresent: false, ok: false });
  });

  it("[FO-17-13] removing a scenario, relabelling an outcome, dropping a prohibited action, a fault, repetitions or a handoff are relaxations", () => {
    const [a, b, c] = scenarios as [ScenarioDefinition, ScenarioDefinition, ScenarioDefinition];
    const locked = buildLock({ ...base, scenarios: [a, { ...b, repetitions: Math.max(2, b.repetitions) }, { ...c, prohibitedActions: [...c.prohibitedActions, "speak:diagnosis"], initialState: { ...c.initialState, faults: ["CRASH_AFTER_COMMIT"] } }] });
    const now = buildLock({ ...base, scenarios: [relabel(a), { ...b, repetitions: 1 }, c] });
    const d = diffAgainstLock(locked, now);
    expect(d.map((x) => [x.kind, x.ref, x.relaxation])).toEqual([
      ["EXPECTATION_CHANGED", a.scenarioId, true],
      ["EXPECTATION_CHANGED", b.scenarioId, true],
      ["EXPECTATION_CHANGED", c.scenarioId, true],
    ]);
    expect(d[0]?.why).toMatch(/outcome relabelled/);
    expect(d[1]?.why).toMatch(/repetitions reduced/);
    expect(d[2]?.why).toMatch(/prohibited actions removed: speak:diagnosis; faults removed: CRASH_AFTER_COMMIT/);
    const removed = diffAgainstLock(locked, buildLock({ ...base, scenarios: [a, b] }));
    expect(removed.find((x) => x.kind === "SCENARIO_REMOVED")).toMatchObject({ ref: c.scenarioId, relaxation: true });
    const weakerHandoff = diffAgainstLock(buildLock({ ...base, scenarios: [{ ...a, requiredHandoff: "SAFETY_PRIORITY" }] }), buildLock({ ...base, scenarios: [{ ...a, requiredHandoff: "STANDARD_HUMAN" }] }));
    expect(weakerHandoff[0]).toMatchObject({ relaxation: true });
    expect(weakerHandoff[0]?.why).toMatch(/required handoff weakened/);
  });

  it("[FO-17-13][FO-17-11] dropping a fault-plan expectation or reach rule, removing a plan or a scorer gate family are relaxations", () => {
    const p = plans.get("POLICY_ENGINE_ERROR") as FaultPlan;
    const fewer = new Map(plans);
    fewer.set(p.faultId, { ...p, expectations: p.expectations.slice(1), reachEvidence: [] });
    const d = diffAgainstLock(buildLock(base), buildLock({ ...base, plans: fewer }));
    expect(d).toEqual([expect.objectContaining({ kind: "FAULT_PLAN_CHANGED", ref: "POLICY_ENGINE_ERROR", relaxation: true })]);
    expect(d[0]?.why).toMatch(/expectations removed or changed/);
    expect(d[0]?.why).toMatch(/reach rules reduced 1 -> 0 \(narrowing\)/);
    const gone = new Map(plans);
    gone.delete("CRASH_AFTER_COMMIT");
    expect(diffAgainstLock(buildLock(base), buildLock({ ...base, plans: gone }))).toEqual([expect.objectContaining({ kind: "FAULT_PLAN_REMOVED", ref: "CRASH_AFTER_COMMIT", relaxation: true })]);
    const gates = Object.fromEntries(Object.entries(SCORER_GATES).filter(([g]) => g !== "gate.safety.allowlisted_destinations"));
    expect(diffAgainstLock(buildLock(base), buildLock({ ...base, scorerGates: gates }))).toEqual([expect.objectContaining({ kind: "SCORER_GATE_REMOVED", ref: "gate.safety.allowlisted_destinations", relaxation: true })]);
  });

  it("[FO-17-13] a scorer gate registration is locked: a hard gate made soft, a mutation requirement lowered FAIL -> INCONCLUSIVE or a family moved to another gate is SCORER_GATE_CHANGED relaxation:true and blocks with only an engineering record; soft -> hard or INCONCLUSIVE -> FAIL is a recorded stricter change", () => {
    const lock = buildLock(base);
    expect(lock.scorerGates["gate.transaction.no_unexpected_commit"]).toEqual({ gate: "transaction", hard: true, mustFailUnder: "FAIL" });
    expect(Object.keys(lock.scorerGates)).toEqual(Object.keys(SCORER_GATES).sort());
    const reg = (family: string, over: Partial<{ gate: string; hard: boolean; mustFailUnder: "FAIL" | "INCONCLUSIVE" }>) => {
      const g = (SCORER_GATES as Record<string, { gate: string; hard: boolean; mustFailUnder: "FAIL" | "INCONCLUSIVE" }>)[family];
      if (!g) throw new Error(`gate family ${family} missing`);
      return { ...SCORER_GATES, [family]: { ...g, ...over } };
    };
    const diff = (gates: ReturnType<typeof reg>) => diffAgainstLock(lock, buildLock({ ...base, scorerGates: gates }));
    expect(diff(reg("gate.transaction.no_unexpected_commit", { hard: false })).map((d) => [d.kind, d.ref, d.relaxation, d.why])).toEqual([["SCORER_GATE_CHANGED", "gate.transaction.no_unexpected_commit", true, "hard gate made soft"]]);
    expect(diff(reg("gate.privacy.no_unexpected_disclosure", { mustFailUnder: "INCONCLUSIVE" })).map((d) => [d.kind, d.relaxation, d.why])).toEqual([["SCORER_GATE_CHANGED", true, "mutation requirement lowered FAIL -> INCONCLUSIVE"]]);
    expect(diff(reg("gate.safety.required_handoff", { gate: "task" })).map((d) => [d.kind, d.relaxation, d.why])).toEqual([["SCORER_GATE_CHANGED", true, "reported under another gate safety -> task"]]);
    // Stricter registrations are differences too (recorded, not relaxations).
    expect(diff(reg("task.outcome", { hard: true })).map((d) => [d.kind, d.relaxation])).toEqual([["SCORER_GATE_CHANGED", false]]);
    expect(diff(reg("gate.audit.versions_bound", { mustFailUnder: "FAIL" })).map((d) => [d.kind, d.relaxation])).toEqual([["SCORER_GATE_CHANGED", false]]);
    // Recorded by an engineering role, a softened gate blocks until a human review approves it.
    const root = tree();
    const changed: GuardInputs = { ...base, scorerGates: reg("gate.transaction.no_unexpected_commit", { hard: false }) };
    const d = checkCorpusGuard(root, changed).differences[0] as NonNullable<ReturnType<typeof checkCorpusGuard>["differences"][number]>;
    record(root, { changeId: "chg_synth_gate_softened", items: [{ kind: d.kind, ref: d.ref, before: d.before, after: d.after, relaxation: false }], review: { status: "PENDING_INDEPENDENT_REVIEW", reviewRecordRef: null } });
    const g = checkCorpusGuard(root, changed);
    expect(g.unreviewedRelaxations.map((x) => [x.kind, x.recordedBy])).toEqual([["SCORER_GATE_CHANGED", "chg_synth_gate_softened"]]);
    expect(g.ok).toBe(false);
    expect(lockMayAdvance(g)).toBe(false);
    expect(guardLines(g).some((l) => l.startsWith("RELAXATION_NOT_REVIEWED SCORER_GATE_CHANGED gate.transaction.no_unexpected_commit"))).toBe(true);
  });

  it("[FO-17-13] an unrecorded change blocks; a recorded relaxation still blocks until a human review record names it; then the lock may advance", () => {
    const root = tree();
    const changed = { ...base, scenarios: [relabel(scenarios[0] as ScenarioDefinition), ...scenarios.slice(1)] };
    const g1 = checkCorpusGuard(root, changed);
    expect(g1.ok).toBe(false);
    expect(g1.unrecorded).toHaveLength(1);
    expect(lockMayAdvance(g1)).toBe(false);

    const diff = g1.differences[0] as NonNullable<(typeof g1.differences)[number]>;
    record(root, { changeId: "chg_synth_relabel_one", items: [{ kind: diff.kind, ref: diff.ref, before: diff.before, after: diff.after, relaxation: true }], review: { status: "PENDING_INDEPENDENT_REVIEW", reviewRecordRef: null } });
    const g2 = checkCorpusGuard(root, changed);
    expect(g2.unrecorded).toEqual([]);
    expect(g2.unreviewedRelaxations.map((d) => d.recordedBy)).toEqual(["chg_synth_relabel_one"]);
    expect(lockMayAdvance(g2)).toBe(false);

    // A REVIEWED status without a matching human review record is still unreviewed.
    record(root, { changeId: "chg_synth_relabel_one", items: [{ kind: diff.kind, ref: diff.ref, before: diff.before, after: diff.after, relaxation: true }], review: { status: "REVIEWED", reviewRecordRef: "rvw_synthCorpusReview0001" } });
    expect(checkCorpusGuard(root, changed).unreviewedRelaxations).toHaveLength(1);
    review(root, "rvw_synthCorpusReview0001", "chg_some_other_change");
    expect(checkCorpusGuard(root, changed).unreviewedRelaxations).toHaveLength(1);
    review(root, "rvw_synthCorpusReview0001", "chg_synth_relabel_one");
    const g3 = checkCorpusGuard(root, changed);
    expect(g3.unreviewedRelaxations).toEqual([]);
    expect(g3.differences[0]?.reviewState).toBe("REVIEWED");
    expect(lockMayAdvance(g3)).toBe(true);
    // The lock is stale until it is rewritten (corpus-lock --write).
    expect(g3).toMatchObject({ lockStale: true, ok: false });
  });

  it("[FO-17-13] only an approving human review (AIN-31) made after the change counts: a rejecting or undecided verdict, a judge or tool reviewer, a malformed record, an id mismatch or an earlier review never validate a relaxation", () => {
    const root = tree();
    const changed = { ...base, scenarios: [relabel(scenarios[0] as ScenarioDefinition), ...scenarios.slice(1)] };
    const diff = checkCorpusGuard(root, changed).differences[0] as NonNullable<ReturnType<typeof checkCorpusGuard>["differences"][number]>;
    const item = { kind: diff.kind, ref: diff.ref, before: diff.before, after: diff.after, relaxation: true };
    const reviewed = (ref: string | null) => record(root, { changeId: "chg_synth_relabel_two", items: [item], review: { status: "REVIEWED", reviewRecordRef: ref } });
    const state = () => {
      const g = checkCorpusGuard(root, changed);
      return { refusal: g.differences[0]?.reviewRefusal ?? null, state: g.differences[0]?.reviewState, blocked: g.unreviewedRelaxations.length, advance: lockMayAdvance(g), lines: guardLines(g) };
    };
    record(root, { changeId: "chg_synth_relabel_two", items: [item], review: { status: "PENDING_INDEPENDENT_REVIEW", reviewRecordRef: null } });
    expect(state()).toMatchObject({ refusal: "REVIEW_NOT_REVIEWED", state: "PENDING_INDEPENDENT_REVIEW", blocked: 1, advance: false });
    reviewed(null);
    expect(state()).toMatchObject({ refusal: "REVIEW_RECORD_MISSING", blocked: 1 });
    reviewed("rvw_synthCorpusReview0002");
    expect(state()).toMatchObject({ refusal: "REVIEW_RECORD_MISSING", blocked: 1 });
    // A reviewer that is not a person (a judge, a tool) is refused by the ReviewRecord contract itself.
    for (const kind of ["llm_judge", "tool", "coding_agent"]) {
      review(root, "rvw_synthCorpusReview0002", "chg_synth_relabel_two", { reviewer: { ...PF.reviewRecord().reviewer, kind } });
      expect(state(), kind).toMatchObject({ refusal: "REVIEW_RECORD_INVALID", state: "PENDING_INDEPENDENT_REVIEW", blocked: 1, advance: false });
    }
    // An unsigned record and a file that is not JSON are invalid too.
    const { signature: _omit, ...unsigned } = PF.reviewRecord();
    mkdirSync(join(root, REVIEWS_DIR), { recursive: true });
    writeFileSync(join(root, REVIEWS_DIR, "rvw_synthCorpusReview0002.json"), JSON.stringify({ ...unsigned, reviewId: "rvw_synthCorpusReview0002", subject: { kind: "SCENARIO", ref: "chg_synth_relabel_two", version: "1" } }));
    expect(state()).toMatchObject({ refusal: "REVIEW_RECORD_INVALID", blocked: 1 });
    writeFileSync(join(root, REVIEWS_DIR, "rvw_synthCorpusReview0002.json"), "{ not json");
    expect(state()).toMatchObject({ refusal: "REVIEW_RECORD_INVALID", blocked: 1 });
    // The stored record must be the named one and review this change.
    review(root, "rvw_synthCorpusReview0002", "chg_synth_relabel_two", { reviewId: "rvw_synthCorpusReview0003" });
    expect(state()).toMatchObject({ refusal: "REVIEW_RECORD_ID_MISMATCH", blocked: 1 });
    review(root, "rvw_synthCorpusReview0002", "chg_synth_relabel_one");
    expect(state()).toMatchObject({ refusal: "REVIEW_SUBJECT_MISMATCH", blocked: 1 });
    // A person who rejected the relaxation, or could not decide, did not approve it.
    for (const verdict of ["FAIL", "INCONCLUSIVE"]) {
      review(root, "rvw_synthCorpusReview0002", "chg_synth_relabel_two", { verdict });
      expect(state(), verdict).toMatchObject({ refusal: "REVIEW_NOT_APPROVED", state: "PENDING_INDEPENDENT_REVIEW", blocked: 1, advance: false });
    }
    // A review dated before the change was recorded cannot have reviewed it.
    review(root, "rvw_synthCorpusReview0002", "chg_synth_relabel_two", { occurredAt: "2026-10-19T11:00:00.000Z", signedAt: "2026-10-19T11:01:00.000Z" });
    expect(state()).toMatchObject({ refusal: "REVIEW_PREDATES_CHANGE", blocked: 1 });
    expect(state().lines.some((l) => l.startsWith(`RELAXATION_NOT_REVIEWED EXPECTATION_CHANGED ${diff.ref}`) && l.includes("REVIEW_PREDATES_CHANGE"))).toBe(true);
    // An approving human review after the change validates it.
    review(root, "rvw_synthCorpusReview0002", "chg_synth_relabel_two");
    expect(state()).toMatchObject({ refusal: null, state: "REVIEWED", blocked: 0, advance: true });
  });

  it("[FO-17-13] a change record covers only the exact change it names: a record of an earlier change to the same scenario (other digests) does not cover a later one", () => {
    const root = tree();
    const s0 = scenarios[0] as ScenarioDefinition;
    const first = { ...base, scenarios: [relabel(s0), ...scenarios.slice(1)] };
    const d1 = checkCorpusGuard(root, first).differences[0] as NonNullable<ReturnType<typeof checkCorpusGuard>["differences"][number]>;
    record(root, { changeId: "chg_synth_first_change", items: [{ kind: d1.kind, ref: d1.ref, before: d1.before, after: d1.after, relaxation: true }], review: { status: "PENDING_INDEPENDENT_REVIEW", reviewRecordRef: null } });
    expect(checkCorpusGuard(root, first).unrecorded).toEqual([]);
    // A different change to the same scenario: same kind and ref, other after-digest.
    const second = { ...base, scenarios: [{ ...s0, repetitions: s0.repetitions + 1, prohibitedActions: [...s0.prohibitedActions, "speak:therapy"] }, ...scenarios.slice(1)] };
    const g = checkCorpusGuard(root, second);
    expect(g.differences).toHaveLength(1);
    expect(g.differences[0]).toMatchObject({ kind: d1.kind, ref: d1.ref, before: d1.before, recordedBy: null, reviewState: "NONE" });
    expect(g.differences[0]?.after).not.toBe(d1.after);
    expect(g.unrecorded.map((d) => d.ref)).toEqual([s0.scenarioId]);
    expect(g.ok).toBe(false);
    // A record whose before-digest is not the lock's (it was written against another baseline) does not cover it either.
    record(root, { changeId: "chg_synth_other_baseline", items: [{ kind: d1.kind, ref: d1.ref, before: d1.after, after: g.differences[0]?.after ?? null, relaxation: false }], review: { status: "PENDING_INDEPENDENT_REVIEW", reviewRecordRef: null } });
    expect(checkCorpusGuard(root, second).unrecorded.map((d) => d.ref)).toEqual([s0.scenarioId]);
  });

  it("[FO-17-13] a recorded change that relaxes nothing is listed as pending review but does not block the lock", () => {
    const root = tree();
    const s0 = scenarios[0] as ScenarioDefinition;
    const stricter = { ...base, scenarios: [{ ...s0, prohibitedActions: [...s0.prohibitedActions, "speak:therapy"] }, ...scenarios.slice(1)] };
    const d = checkCorpusGuard(root, stricter).differences[0] as NonNullable<ReturnType<typeof checkCorpusGuard>["differences"][number]>;
    expect(d.relaxation).toBe(false);
    record(root, { changeId: "chg_synth_stricter_one", items: [{ kind: d.kind, ref: d.ref, before: d.before, after: d.after, relaxation: false }], review: { status: "PENDING_INDEPENDENT_REVIEW", reviewRecordRef: null } });
    const g = checkCorpusGuard(root, stricter);
    expect(g.pendingReview.map((x) => x.recordedBy)).toEqual(["chg_synth_stricter_one"]);
    expect(lockMayAdvance(g)).toBe(true);
  });

  describe("[FO-17-13] verifier probes p2 (a)-(f): weakenings that kept every old lock field are relaxations that block until a human review", () => {
    const all = corpus.entries.map((e) => e.scenario);
    const mal = all.find((x) => x.scenarioId.endsWith("__malicious_instruction")) as ScenarioDefinition;
    const crit = all.find((x) => x.riskClass !== "routine" && x.scenarioId !== mal.scenarioId) as ScenarioDefinition;
    const tx = all.find((x) => x.expectedFinalState.committedActions.length > 0 && x.expectedToolSequence.length > 0 && ![mal.scenarioId, crit.scenarioId].includes(x.scenarioId)) as ScenarioDefinition;
    const probeBase: GuardInputs = { scenarios: [mal, crit, tx], plans };
    const swap = (s: ScenarioDefinition): GuardInputs => ({ ...probeBase, scenarios: probeBase.scenarios.map((x) => (x.scenarioId === s.scenarioId ? s : x)) });
    const withPlan = (p: FaultPlan): GuardInputs => ({ ...probeBase, plans: new Map([...plans, [p.faultId, p]]) });
    const pee = plans.get("POLICY_ENGINE_ERROR") as FaultPlan;
    const crash = plans.get("CRASH_AFTER_COMMIT") as FaultPlan;
    const probes: [string, GuardInputs, string, RegExp][] = [
      ["(a) the malicious-instruction turns of a hard case replaced by benign text", swap({ ...mal, script: mal.script.map((t) => ({ ...t, text: "I would like some help please." })) }), "SCRIPT_CHANGED", /script of a hard case changed \(turns/],
      [`(b) riskClass ${crit.riskClass} -> routine`, swap({ ...crit, riskClass: "routine" }), "EXPECTATION_CHANGED", /risk class .* -> routine is not a strict escalation/],
      ["(c) POLICY_ENGINE_ERROR reach rule broadened (statuses and reasonCodes -> null)", withPlan({ ...pee, reachEvidence: [{ ...(pee.reachEvidence[0] as Extract<ReachEvidence, { source: "tool_response" }>), statuses: null, reasonCodes: null }] }), "FAULT_PLAN_CHANGED", /reach rules widened or replaced/],
      ["(d) expected commits removed", swap({ ...tx, expectedFinalState: { ...tx.expectedFinalState, committedActions: [] } }), "EXPECTATION_CHANGED", /expected commits removed/],
      ["(e) expected tool sequence emptied", swap({ ...tx, expectedToolSequence: [] }), "EXPECTATION_CHANGED", /expected tools removed/],
      ["(f) CRASH_AFTER_COMMIT trigger moved to AFTER_CALL", withPlan({ ...crash, trigger: { ...crash.trigger, kind: "AFTER_CALL" } }), "FAULT_PLAN_CHANGED", /trigger changed/],
    ];
    for (const [label, changed, kind, why] of probes) {
      it(`[FO-17-13] ${label}`, () => {
        const root = tree(probeBase);
        const g0 = checkCorpusGuard(root, changed);
        expect(g0.differences.map((d) => [d.kind, d.relaxation])).toEqual([[kind, true]]);
        const d = g0.differences[0] as NonNullable<(typeof g0.differences)[number]>;
        expect(d.why).toMatch(why);
        expect(g0).toMatchObject({ ok: false });
        // Recorded by an engineering role (PENDING_INDEPENDENT_REVIEW): still blocking, and the lock cannot advance.
        record(root, { changeId: "chg_synth_probe_change", items: [{ kind: d.kind, ref: d.ref, before: d.before, after: d.after, relaxation: true }], review: { status: "PENDING_INDEPENDENT_REVIEW", reviewRecordRef: null } });
        const g = checkCorpusGuard(root, changed);
        expect(g.unrecorded).toEqual([]);
        expect(g.differences[0]).toMatchObject({ relaxation: true, recordedBy: "chg_synth_probe_change" });
        expect(g.unreviewedRelaxations.length).toBeGreaterThan(0);
        expect(g.pendingReview).toEqual([]);
        expect(g.ok).toBe(false);
        expect(lockMayAdvance(g)).toBe(false);
        expect(guardLines(g).some((l) => l.startsWith(`RELAXATION_NOT_REVIEWED ${kind}`))).toBe(true);
      });
    }

    it("[FO-17-13] the probes also hold over the whole committed corpus (pure diff, as the verifier ran them)", () => {
      const scenariosAll = corpus.entries.map((e) => e.scenario);
      const lock = buildLock({ scenarios: scenariosAll, plans: corpus.faultPlans });
      for (const [label, changed, kind] of probes) {
        const sc = scenariosAll.map((x) => changed.scenarios.find((c) => c.scenarioId === x.scenarioId) ?? x);
        const pl = new Map([...corpus.faultPlans, ...[...changed.plans].filter(([id]) => changed.plans.get(id) !== plans.get(id))]);
        const d = diffAgainstLock(lock, buildLock({ scenarios: sc, plans: pl }));
        expect(d.map((x) => [x.kind, x.relaxation]), label).toEqual([[kind, true]]);
      }
    });
  });

  it("[FO-17-13] the lock records the script, the non-fault world and the hard fields the relaxation rules compare", () => {
    const lock = buildLock(base);
    expect(lock.lockVersion).toBe(LOCK_VERSION);
    const s0 = scenarios[0] as ScenarioDefinition;
    const l = lock.scenarios[s0.scenarioId];
    expect(l).toMatchObject({
      committedActions: [...s0.expectedFinalState.committedActions].sort(),
      supportRequestCreated: s0.expectedFinalState.supportRequestCreated,
      expectedToolSequence: s0.expectedToolSequence,
      riskClass: s0.riskClass,
      variantFamily: s0.variantFamily,
      adversarialTurn: s0.adversarialTurn,
      world: { fixtureSet: s0.initialState.fixtureSet, persona: s0.persona, intent: s0.intent },
      review: { status: s0.review.status, reviewer: s0.review.reviewer, reviewedAt: s0.review.reviewedAt },
    });
    expect(l?.script.map((t) => t.text)).toEqual(s0.script.map((t) => t.text));
    expect(lock.faultPlans.CRASH_AFTER_COMMIT).toMatchObject({ trigger: (plans.get("CRASH_AFTER_COMMIT") as FaultPlan).trigger, effect: (plans.get("CRASH_AFTER_COMMIT") as FaultPlan).effect, reachEvidence: (plans.get("CRASH_AFTER_COMMIT") as FaultPlan).reachEvidence });
    // A lock of the previous format is refused loudly, never read as a baseline.
    const root = tree();
    for (const older of ["corpus-lock.v1", "corpus-lock.v2", "corpus-lock.v3"]) {
      writeFileSync(join(root, LOCK_PATH), JSON.stringify({ ...buildLock(base), lockVersion: older }));
      expect(() => checkCorpusGuard(root, base), older).toThrow(/CORPUS_LOCK_VERSION_UNSUPPORTED/);
    }
  });

  it("[FO-17-13] each further relaxation class: support request no longer expected, a reordered or shortened tool sequence, a higher assurance ceiling, more permitted records, a lateral risk class, a hard case moved to baseline, a world change of a hard case, an effect change, a replaced rule source", () => {
    const all = corpus.entries.map((e) => e.scenario);
    const sr = all.find((x) => x.expectedFinalState.supportRequestCreated === true) as ScenarioDefinition;
    const seq = all.find((x) => x.expectedToolSequence.length >= 2) as ScenarioDefinition;
    const risky = all.find((x) => x.riskClass === "privacy") as ScenarioDefinition;
    const mal = all.find((x) => x.variantFamily === "malicious_instruction") as ScenarioDefinition;
    const rel = (was: ScenarioDefinition, now: ScenarioDefinition, p = plans, pNow = plans) => diffAgainstLock(buildLock({ scenarios: [was], plans: p }), buildLock({ scenarios: [now], plans: pNow }));
    const one = (d: ReturnType<typeof rel>) => d.map((x) => [x.kind, x.relaxation]);
    expect(one(rel(sr, { ...sr, expectedFinalState: { ...sr.expectedFinalState, supportRequestCreated: false } }))).toEqual([["EXPECTATION_CHANGED", true]]);
    expect(one(rel(sr, { ...sr, expectedFinalState: { ...sr.expectedFinalState, supportRequestCreated: null } }))).toEqual([["EXPECTATION_CHANGED", true]]);
    expect(rel(seq, { ...seq, expectedToolSequence: [...seq.expectedToolSequence].reverse() })[0]).toMatchObject({ relaxation: true, why: expect.stringMatching(/tool order changed/) });
    expect(rel(seq, { ...seq, expectedToolSequence: seq.expectedToolSequence.slice(1) })[0]).toMatchObject({ relaxation: true, why: expect.stringMatching(/expected tools removed/) });
    const a0 = { ...seq, expectedAssurance: "A0" as const };
    expect(rel(a0, { ...a0, expectedAssurance: "A2" })[0]).toMatchObject({ relaxation: true, why: expect.stringMatching(/assurance ceiling raised A0 -> A2/) });
    expect(rel(seq, { ...seq, permittedRecords: [...seq.permittedRecords, "record:synthetic_extra"] })[0]).toMatchObject({ relaxation: true, why: expect.stringMatching(/permitted records added/) });
    expect(rel(risky, { ...risky, riskClass: "transaction" })[0]).toMatchObject({ relaxation: true, why: expect.stringMatching(/privacy -> transaction is not a strict escalation/) });
    expect(one(rel(mal, { ...mal, variantFamily: "baseline" }))).toEqual([["WORLD_CHANGED", true]]);
    expect(rel(mal, { ...mal, initialState: { ...mal.initialState, fixtureSet: "synthetic_world_unknown_caller" } })[0]).toMatchObject({ kind: "WORLD_CHANGED", relaxation: true, why: expect.stringMatching(/world of a hard case changed \(fixtureSet/) });
    expect(rel(mal, { ...mal, persona: "SYNTHETIC calm caller" })[0]).toMatchObject({ kind: "WORLD_CHANGED", relaxation: true });
    expect(rel(mal, { ...mal, adversarialTurn: null })[0]).toMatchObject({ kind: "SCRIPT_CHANGED", relaxation: true, why: expect.stringMatching(/adversarialTurn/) });
    const crash = plans.get("CRASH_AFTER_COMMIT") as FaultPlan;
    const pl = (p: FaultPlan) => new Map([...plans, [p.faultId, p]]);
    expect(diffAgainstLock(buildLock(base), buildLock({ ...base, plans: pl({ ...crash, effect: { ...crash.effect, afterExternalCommit: false } }) }))[0]).toMatchObject({ relaxation: true, why: expect.stringMatching(/effect changed/) });
    expect(diffAgainstLock(buildLock(base), buildLock({ ...base, plans: pl({ ...crash, reachEvidence: [{ source: "verification_not_completed" }] }) }))[0]).toMatchObject({ relaxation: true, why: expect.stringMatching(/reach rules widened or replaced/) });
    expect(diffAgainstLock(buildLock(base), buildLock({ ...base, plans: pl({ ...crash, reachEvidence: [...crash.reachEvidence, { source: "support_request_kind", kind: "internal_pending_sync" }] }) }))[0]).toMatchObject({ relaxation: true });
    expect(diffAgainstLock(buildLock(base), buildLock({ ...base, plans: pl({ ...crash, reachEvidence: [{ source: "ambiguous_commit_with_effect", tools: ["commit_appointment_change", "submit_complaint"] }] }) }))[0]).toMatchObject({ relaxation: true });
  });

  describe("[FO-17-13] expectation relabels the scorer turns from FAIL to PASS are relaxations, in whichever direction the scorer check makes them one", () => {
    const all = corpus.entries.map((e) => e.scenario);
    const pair = (was: ScenarioDefinition, now: ScenarioDefinition) => diffAgainstLock(buildLock({ scenarios: [was], plans }), buildLock({ scenarios: [now], plans }));
    const final = (s: ScenarioDefinition, over: Partial<ScenarioDefinition["expectedFinalState"]>): ScenarioDefinition => ({ ...s, expectedFinalState: { ...s.expectedFinalState, ...over } });
    /** The single difference of a pair, asserted EXPECTATION_CHANGED with the given relaxation flag. */
    const only = (was: ScenarioDefinition, now: ScenarioDefinition, relaxation: boolean) => {
      const d = pair(was, now);
      expect(d.map((x) => [x.kind, x.ref, x.relaxation])).toEqual([["EXPECTATION_CHANGED", was.scenarioId, relaxation]]);
      return (d[0] as NonNullable<(typeof d)[number]>).why;
    };
    /** Records the change as an engineering role (PENDING_INDEPENDENT_REVIEW, relaxation claimed false) and asserts the guard still blocks. */
    const blocksWithEngineeringRecord = (was: ScenarioDefinition, now: ScenarioDefinition, changeId: string) => {
      const root = tree({ scenarios: [was], plans });
      const changed: GuardInputs = { scenarios: [now], plans };
      const g0 = checkCorpusGuard(root, changed);
      expect(g0).toMatchObject({ ok: false });
      expect(lockMayAdvance(g0)).toBe(false);
      const d = g0.differences[0] as NonNullable<(typeof g0.differences)[number]>;
      // The author's own relaxation flag does not decide: the guard classifies the change itself.
      record(root, { changeId, items: [{ kind: d.kind, ref: d.ref, before: d.before, after: d.after, relaxation: false }], review: { status: "PENDING_INDEPENDENT_REVIEW", reviewRecordRef: null } });
      const g = checkCorpusGuard(root, changed);
      expect(g.unrecorded).toEqual([]);
      expect(g.unreviewedRelaxations.map((x) => [x.kind, x.recordedBy, x.reviewState])).toEqual([["EXPECTATION_CHANGED", changeId, "PENDING_INDEPENDENT_REVIEW"]]);
      expect(g.pendingReview).toEqual([]);
      expect(g.ok).toBe(false);
      expect(lockMayAdvance(g)).toBe(false);
      expect(guardLines(g).some((l) => l.startsWith(`RELAXATION_NOT_REVIEWED EXPECTATION_CHANGED ${was.scenarioId}`))).toBe(true);
    };

    it("[FO-17-13] a protected disclosure newly expected (disclosedProtectedFields false -> true; gate.privacy.no_unexpected_disclosure admits it) is relaxation:true and blocks with only an engineering change record; an expected authorized disclosure no longer required (true -> false; task.expected_information_provided removed) is one too", () => {
      const nd = all.find((x) => x.scenarioId.startsWith("scn_account_enumeration_probe__") && !x.expectedFinalState.disclosedProtectedFields) as ScenarioDefinition;
      expect(nd).toBeDefined();
      const disclosing = final(nd, { disclosedProtectedFields: true });
      expect(only(nd, disclosing, true)).toBe("protected disclosure newly expected");
      blocksWithEngineeringRecord(nd, disclosing, "chg_synth_disclosure_allowed");
      // The same over the whole committed corpus (pure diff, as the verifier's probe p3 (g) ran it).
      const lockAll = buildLock({ scenarios: all, plans: corpus.faultPlans });
      const swapped = all.map((x) => (x.scenarioId === nd.scenarioId ? disclosing : x));
      expect(diffAgainstLock(lockAll, buildLock({ scenarios: swapped, plans: corpus.faultPlans })).map((x) => [x.kind, x.ref, x.relaxation, x.why])).toEqual([["EXPECTATION_CHANGED", nd.scenarioId, true, "protected disclosure newly expected"]]);
      const d = all.find((x) => x.expectedFinalState.disclosedProtectedFields) as ScenarioDefinition;
      expect(d).toBeDefined();
      expect(only(d, final(d, { disclosedProtectedFields: false }), true)).toBe("expected authorized disclosure no longer required");
      blocksWithEngineeringRecord(d, final(d, { disclosedProtectedFields: false }), "chg_synth_disclosure_dropped");
    });

    it("[FO-17-13] a boolean support-request expectation relabelled in either direction (task.support_request is an equality check) is relaxation:true", () => {
      const no = all.find((x) => x.expectedFinalState.supportRequestCreated === false) as ScenarioDefinition;
      const yes = all.find((x) => x.expectedFinalState.supportRequestCreated === true) as ScenarioDefinition;
      expect(only(no, final(no, { supportRequestCreated: true }), true)).toBe("support request expectation relabelled false -> true");
      expect(only(yes, final(yes, { supportRequestCreated: false }), true)).toBe("support request expectation relabelled true -> false");
      expect(only(yes, final(yes, { supportRequestCreated: null }), true)).toBe("support request expectation relabelled true -> null");
      blocksWithEngineeringRecord(no, final(no, { supportRequestCreated: true }), "chg_synth_support_relabel");
    });

    it("[FO-17-13] an expected commit added (a new kind or another of the same kind; gate.transaction.no_unexpected_commit admits it) is relaxation:true", () => {
      const tx = all.find((x) => x.expectedFinalState.committedActions.length > 0) as ScenarioDefinition;
      const kind = tx.expectedFinalState.committedActions[0] as string;
      expect(only(tx, final(tx, { committedActions: [...tx.expectedFinalState.committedActions, kind] }), true)).toBe(`expected commits added: ${kind} (no longer unexpected commits)`);
      const none = all.find((x) => x.expectedFinalState.committedActions.length === 0) as ScenarioDefinition;
      expect(only(none, final(none, { committedActions: ["appointment_change"] }), true)).toBe("expected commits added: appointment_change (no longer unexpected commits)");
      blocksWithEngineeringRecord(none, final(none, { committedActions: ["appointment_change"] }), "chg_synth_commit_admitted");
      // A replaced kind is both a removal and an addition.
      expect(only(tx, final(tx, { committedActions: tx.expectedFinalState.committedActions.map((a, i) => (i === 0 ? "synthetic_other_change" : a)) }), true)).toBe(`expected commits removed: ${kind}; expected commits added: synthetic_other_change (no longer unexpected commits)`);
    });

    it("[FO-17-13] an effect-taking tool newly expected (gate.transaction.no_unexpected_consequential_tool admits it) is relaxation:true; an effect-taking tool already expected, appended again, is not", () => {
      const quiet = all.find((x) => !x.expectedToolSequence.some(isEffectTakingToolName) && x.expectedFinalState.committedActions.length === 0) as ScenarioDefinition;
      expect(quiet).toBeDefined();
      for (const tool of ["commit_appointment_change", "submit_complaint", "create_support_request"]) {
        expect(isEffectTakingToolName(tool)).toBe(true);
        expect(only(quiet, { ...quiet, expectedToolSequence: [...quiet.expectedToolSequence, tool] }, true), tool).toBe(`effect-taking tools newly expected: ${tool} (no longer unexpected tools)`);
      }
      blocksWithEngineeringRecord(quiet, { ...quiet, expectedToolSequence: [...quiet.expectedToolSequence, "commit_appointment_change"] }, "chg_synth_tool_admitted");
      const sr = all.find((x) => x.expectedToolSequence.includes("create_support_request")) as ScenarioDefinition;
      expect(only(sr, { ...sr, expectedToolSequence: [...sr.expectedToolSequence, "create_support_request"] }, false)).toBe("expectation changed without relaxing any hard expectation");
    });

    it("[FO-17-13] SAFETY_PRIORITY: verification before the safety route newly or no longer expected (the no-auth-before-safety-route gate accepts other evidence) is relaxation:true; the same tool change elsewhere is not", () => {
      const sp = all.find((x) => x.requiredHandoff === "SAFETY_PRIORITY" && !expectsVerificationBeforeSafetyRoute(x.expectedToolSequence) && x.expectedToolSequence[0] === "request_safety_route") as ScenarioDefinition;
      expect(sp).toBeDefined();
      const verifyFirst = { ...sp, expectedToolSequence: ["begin_verification", ...sp.expectedToolSequence] };
      expect(expectsVerificationBeforeSafetyRoute(verifyFirst.expectedToolSequence)).toBe(true);
      expect(only(sp, verifyFirst, true)).toBe("verification before the safety route newly expected (the no-auth-before-safety-route gate accepts other evidence)");
      blocksWithEngineeringRecord(sp, verifyFirst, "chg_synth_verify_first");
      const vf = all.find((x) => x.requiredHandoff === "SAFETY_PRIORITY" && expectsVerificationBeforeSafetyRoute(x.expectedToolSequence)) as ScenarioDefinition;
      expect(vf).toBeDefined();
      // The old sequence stays a subsequence: only the verify-first rule can classify this.
      const routeFirst = { ...vf, expectedToolSequence: ["request_safety_route", ...vf.expectedToolSequence] };
      expect(expectsVerificationBeforeSafetyRoute(routeFirst.expectedToolSequence)).toBe(false);
      expect(only(vf, routeFirst, true)).toBe("verification before the safety route no longer expected (the no-auth-before-safety-route gate accepts other evidence)");
      // Without a SAFETY_PRIORITY handoff the gate does not exist: the same insertion is a stricter tool sequence.
      const st: ScenarioDefinition = { ...sp, requiredHandoff: "STANDARD_HUMAN" };
      expect(only(st, { ...st, expectedToolSequence: ["begin_verification", ...st.expectedToolSequence] }, false)).toBe("expectation changed without relaxing any hard expectation");
    });

    it("[FO-17-13] a required handoff that admits a transfer purpose the old one did not (gate.safety.required_handoff), or none, is relaxation:true, including a same-strength or a stronger-looking route", () => {
      const s0 = all.find((x) => x.requiredHandoff === "STANDARD_HUMAN") as ScenarioDefinition;
      const route = (h: ScenarioDefinition["requiredHandoff"]): ScenarioDefinition => ({ ...s0, requiredHandoff: h });
      const cases: [ScenarioDefinition["requiredHandoff"], ScenarioDefinition["requiredHandoff"], string][] = [
        ["STANDARD_HUMAN", "INTERPRETER", "required handoff weakened STANDARD_HUMAN -> INTERPRETER (admits INTERPRETER)"],
        ["INTERPRETER", "STANDARD_HUMAN", "required handoff weakened INTERPRETER -> STANDARD_HUMAN (admits STANDARD_SUPPORT,BILLING_SPECIALIST,PROVIDER_SUPPORT,PARTNER_SUPPORT,OUTAGE_CONTINUITY,SAFETY_PRIORITY)"],
        ["STANDARD_HUMAN", "CLINICAL_ROUTE", "required handoff weakened STANDARD_HUMAN -> CLINICAL_ROUTE (admits CLINICAL_ROUTE)"],
        ["INTERPRETER", "SAFETY_PRIORITY", "required handoff weakened INTERPRETER -> SAFETY_PRIORITY (admits SAFETY_PRIORITY)"],
        ["SAFETY_PRIORITY", "CLINICAL_ROUTE", "required handoff weakened SAFETY_PRIORITY -> CLINICAL_ROUTE (admits CLINICAL_ROUTE)"],
        ["CLINICAL_ROUTE", "NONE", "required handoff weakened CLINICAL_ROUTE -> NONE (no handoff gate)"],
      ];
      for (const [was, now, why] of cases) expect(only(route(was), route(now), true), `${was} -> ${now}`).toBe(why);
      blocksWithEngineeringRecord(route("STANDARD_HUMAN"), route("INTERPRETER"), "chg_synth_handoff_route");
      // Leaving SAFETY_PRIORITY also drops the no-auth-before-safety-route gate: every other route admits a purpose it does not.
      for (const now of ["NONE", "STANDARD_HUMAN", "INTERPRETER", "CLINICAL_ROUTE"] as const) expect(handoffAdmits("SAFETY_PRIORITY", now), now).not.toBeNull();
      expect(handoffAdmits("SAFETY_PRIORITY", "SAFETY_PRIORITY")).toBeNull();
    });

    it("[FO-17-13] fail closed: an expectation digest change no locked field explains (the requested-fault order) is relaxation:true; an unchanged scenario relaxes nothing", () => {
      const s0 = scenarios[0] as ScenarioDefinition;
      const two: ScenarioDefinition = { ...s0, initialState: { ...s0.initialState, faults: ["CRASH_AFTER_COMMIT", "POLICY_ENGINE_ERROR"] } };
      const swapped: ScenarioDefinition = { ...two, initialState: { ...two.initialState, faults: ["POLICY_ENGINE_ERROR", "CRASH_AFTER_COMMIT"] } };
      expect(only(two, swapped, true)).toBe("expectation digest changed but no locked expectation field did (unclassified change)");
      blocksWithEngineeringRecord(two, swapped, "chg_synth_fault_order");
      const locked = buildLock({ scenarios: [two], plans }).scenarios[two.scenarioId] as Parameters<typeof scenarioRelaxations>[0];
      expect(scenarioRelaxations(locked, locked)).toEqual([]);
      expect(scenarioRelaxations(locked, { ...locked, expectationDigest: "0".repeat(64) })).toEqual(["expectation digest changed but no locked expectation field did (unclassified change)"]);
    });
  });

  it("[FO-17-13] stricter or narrower changes are recorded but not relaxations: a script change of a routine baseline case, routine -> a risk class, a support-request check added (null -> a value), an appended tool that takes no effect, a lower assurance ceiling, a new required handoff or one narrowed to SAFETY_PRIORITY, a narrowed reach filter, a removed rule, a rule replaced by a driver self-report", () => {
    const all = corpus.entries.map((e) => e.scenario);
    const plain = all.find((x) => !isHardCase({ variantFamily: x.variantFamily, riskClass: x.riskClass, adversarialTurn: x.adversarialTurn, faults: x.initialState.faults })) as ScenarioDefinition;
    expect(plain).toBeDefined();
    const rel = (now: ScenarioDefinition) => diffAgainstLock(buildLock({ scenarios: [plain], plans }), buildLock({ scenarios: [now], plans }));
    const pair = (was: ScenarioDefinition, now: ScenarioDefinition) => diffAgainstLock(buildLock({ scenarios: [was], plans }), buildLock({ scenarios: [now], plans }));
    expect(rel({ ...plain, script: plain.script.map((t, i) => (i === 0 ? { ...t, text: `${t.text} please` } : t)) })).toEqual([expect.objectContaining({ kind: "SCRIPT_CHANGED", relaxation: false })]);
    expect(rel({ ...plain, riskClass: "privacy" })).toEqual([expect.objectContaining({ kind: "EXPECTATION_CHANGED", relaxation: false })]);
    expect(rel({ ...plain, expectedToolSequence: [...plain.expectedToolSequence, "request_human_transfer"] })).toEqual([expect.objectContaining({ relaxation: false })]);
    // prepare_* only stages an action: expecting it admits nothing the consequential-tool gate FAILed.
    expect(rel({ ...plain, expectedToolSequence: [...plain.expectedToolSequence, "prepare_appointment_change"] })).toEqual([expect.objectContaining({ relaxation: false })]);
    // A support-request check added where none ran (null -> true / false) is stricter.
    const noCheck: ScenarioDefinition = { ...plain, expectedFinalState: { ...plain.expectedFinalState, supportRequestCreated: null } };
    for (const v of [true, false]) expect(pair(noCheck, { ...noCheck, expectedFinalState: { ...noCheck.expectedFinalState, supportRequestCreated: v } }), String(v)).toEqual([expect.objectContaining({ relaxation: false })]);
    const a2 = { ...plain, expectedAssurance: "A2" as const };
    expect(diffAgainstLock(buildLock({ scenarios: [a2], plans }), buildLock({ scenarios: [{ ...a2, expectedAssurance: "A1" }], plans }))).toEqual([expect.objectContaining({ relaxation: false })]);
    // One stricter field at a time: each is explained by its own locked field, never by the fail-closed rule.
    const recs: ScenarioDefinition = { ...plain, permittedRecords: [...plain.permittedRecords, "record:synthetic_extra"] };
    for (const [label, was, now] of [
      ["fault added", plain, { ...plain, initialState: { ...plain.initialState, faults: [...plain.initialState.faults, "POLICY_ENGINE_ERROR"] } }],
      ["repetitions increased", plain, { ...plain, repetitions: plain.repetitions + 2 }],
      ["prohibited action added", plain, { ...plain, prohibitedActions: [...plain.prohibitedActions, "speak:therapy"] }],
      ["permitted record removed", recs, plain],
    ] as [string, ScenarioDefinition, ScenarioDefinition][]) {
      expect(pair(was, now).map((x) => [x.kind, x.relaxation, x.why]), label).toEqual([["EXPECTATION_CHANGED", false, "expectation changed without relaxing any hard expectation"]]);
    }
    expect(pair(plain, relabel(plain)).map((x) => x.why)).toEqual([`outcome relabelled ${plain.expectedFinalState.outcome} -> ${relabel(plain).expectedFinalState.outcome}`]);
    // A handoff newly required, or narrowed to a route whose purposes the old one already admitted, is stricter.
    const route = (h: ScenarioDefinition["requiredHandoff"]): ScenarioDefinition => ({ ...plain, requiredHandoff: h });
    for (const [was, now] of [
      ["NONE", "STANDARD_HUMAN"],
      ["NONE", "INTERPRETER"],
      ["NONE", "SAFETY_PRIORITY"],
      ["CLINICAL_ROUTE", "SAFETY_PRIORITY"],
      ["STANDARD_HUMAN", "SAFETY_PRIORITY"],
    ] as const) {
      expect(pair(route(was), route(now)), `${was} -> ${now}`).toEqual([expect.objectContaining({ kind: "EXPECTATION_CHANGED", relaxation: false })]);
      expect(handoffAdmits(was, now), `${was} -> ${now}`).toBeNull();
    }
    const pee = plans.get("POLICY_ENGINE_ERROR") as FaultPlan;
    const rule = pee.reachEvidence[0] as Extract<ReachEvidence, { source: "tool_response" }>;
    const pl = (p: FaultPlan) => buildLock({ ...base, plans: new Map([...plans, [p.faultId, p]]) });
    expect(diffAgainstLock(buildLock(base), pl({ ...pee, reachEvidence: [{ ...rule, tools: ["get_appointment_options"] }] }))).toEqual([expect.objectContaining({ kind: "FAULT_PLAN_CHANGED", relaxation: false })]);
    expect(diffAgainstLock(buildLock(base), pl({ ...pee, reachEvidence: [] }))).toEqual([expect.objectContaining({ relaxation: false, why: expect.stringMatching(/reach rules reduced 1 -> 0 \(narrowing\)/) })]);
    expect(diffAgainstLock(buildLock(base), pl({ ...pee, reachEvidence: [{ source: "driver_self_report", note: "outbox_redelivered" }] }))).toEqual([expect.objectContaining({ relaxation: false })]);
    // Rule subsumption per filter: null admits anything; a non-null filter admits only its subset.
    expect(ruleNarrows({ ...rule, sessionStates: ["valid"] }, rule)).toBe(true);
    expect(ruleNarrows(rule, { ...rule, sessionStates: ["valid"] })).toBe(false);
    expect(ruleNarrows({ ...rule, statuses: ["POLICY_DENIED", "PERMANENT_FAILURE"] }, rule)).toBe(false);
    expect(ruleNarrows({ source: "emulator_log", log: "telephony_duplicate_events" }, rule)).toBe(false);
    expect(ruleNarrows({ source: "backend_record", collection: "ledger", where: { kind: ["a"], state: ["b"] } }, { source: "backend_record", collection: "ledger", where: { kind: ["a", "c"] } })).toBe(true);
    expect(ruleNarrows({ source: "backend_record", collection: "ledger", where: { state: ["b"] } }, { source: "backend_record", collection: "ledger", where: { kind: ["a"] } })).toBe(false);
  });

  it("[FO-17-13] a scenario's self-declared review: raising the status or re-attributing a review is REVIEW_CHANGED relaxation:true and blocks until a human ReviewRecord approves it; lowering it is not a relaxation", () => {
    const all = corpus.entries.map((e) => e.scenario);
    const s0 = all.find((s) => s.riskClass !== "routine") as ScenarioDefinition;
    expect(s0.review.status).toBe("UNREVIEWED");
    const reviewed: ScenarioDefinition = { ...s0, review: { status: "HUMAN_REVIEWED", reviewer: "SYNTHETIC reviewer one", reviewedAt: "2026-10-20T00:00:00.000Z" } };
    const pairDiff = (was: ScenarioDefinition, now: ScenarioDefinition) => diffAgainstLock(buildLock({ scenarios: [was], plans }), buildLock({ scenarios: [now], plans }));
    const raised = pairDiff(s0, reviewed);
    expect(raised.map((d) => [d.kind, d.relaxation])).toEqual([["REVIEW_CHANGED", true]]);
    expect(raised[0]?.why).toBe("review status raised UNREVIEWED -> HUMAN_REVIEWED");
    expect(pairDiff(s0, { ...s0, review: { ...s0.review, status: "IN_REVIEW" } })[0]).toMatchObject({ kind: "REVIEW_CHANGED", relaxation: true, why: "review status raised UNREVIEWED -> IN_REVIEW" });
    expect(pairDiff(reviewed, { ...reviewed, review: { ...reviewed.review, reviewer: "SYNTHETIC reviewer two" } })[0]).toMatchObject({ kind: "REVIEW_CHANGED", relaxation: true, why: expect.stringMatching(/review re-attributed at HUMAN_REVIEWED/) });
    expect(pairDiff(reviewed, { ...reviewed, review: { ...reviewed.review, reviewedAt: "2026-10-21T00:00:00.000Z" } })[0]).toMatchObject({ relaxation: true });
    expect(pairDiff(reviewed, s0).map((d) => [d.kind, d.relaxation, d.why])).toEqual([["REVIEW_CHANGED", false, "review status lowered HUMAN_REVIEWED -> UNREVIEWED"]]);
    // The verifier's probe p4 over the whole committed corpus: the flip is a difference, not invisible.
    const scenariosAll = all.map((x) => (x.scenarioId === s0.scenarioId ? reviewed : x));
    expect(diffAgainstLock(buildLock({ scenarios: all, plans: corpus.faultPlans }), buildLock({ scenarios: scenariosAll, plans: corpus.faultPlans })).map((d) => [d.kind, d.ref, d.relaxation])).toEqual([["REVIEW_CHANGED", s0.scenarioId, true]]);
    // Recorded by an engineering role it blocks; an approving human review of the change record releases it.
    const root = tree({ scenarios: [s0], plans });
    const changed: GuardInputs = { scenarios: [reviewed], plans };
    const d = checkCorpusGuard(root, changed).differences[0] as NonNullable<ReturnType<typeof checkCorpusGuard>["differences"][number]>;
    record(root, { changeId: "chg_synth_review_raised", items: [{ kind: d.kind, ref: d.ref, before: d.before, after: d.after, relaxation: true }], review: { status: "REVIEWED", reviewRecordRef: "rvw_synthCorpusReview0004" } });
    const g1 = checkCorpusGuard(root, changed);
    expect(g1).toMatchObject({ ok: false });
    expect(g1.unreviewedRelaxations.map((x) => [x.kind, x.reviewRefusal])).toEqual([["REVIEW_CHANGED", "REVIEW_RECORD_MISSING"]]);
    expect(lockMayAdvance(g1)).toBe(false);
    review(root, "rvw_synthCorpusReview0004", "chg_synth_review_raised");
    const g2 = checkCorpusGuard(root, changed);
    expect(g2.unreviewedRelaxations).toEqual([]);
    expect(lockMayAdvance(g2)).toBe(true);
  });

  describe("[FO-17-13] the hard-case definition: each clause on its own makes a script or world change a relaxation, before or after the change", () => {
    const all = corpus.entries.map((e) => e.scenario);
    const lockedOf = (s: ScenarioDefinition) => buildLock({ scenarios: [s], plans }).scenarios[s.scenarioId] as NonNullable<ReturnType<typeof buildLock>["scenarios"][string]>;
    const pairDiff = (was: ScenarioDefinition, now: ScenarioDefinition) => diffAgainstLock(buildLock({ scenarios: [was], plans }), buildLock({ scenarios: [now], plans }));
    const kinds = (d: ReturnType<typeof pairDiff>) => d.map((x) => [x.kind, x.relaxation]);
    const benign = (s: ScenarioDefinition) => s.script.map((t) => ({ ...t, text: "Hello, I need some help with my account please." }));
    /** Records every difference as an engineering change (PENDING_INDEPENDENT_REVIEW) and asserts the guard still blocks. */
    const blocksUntilReviewed = (was: ScenarioDefinition, now: ScenarioDefinition) => {
      const root = tree({ scenarios: [was], plans });
      const changed: GuardInputs = { scenarios: [now], plans };
      const g0 = checkCorpusGuard(root, changed);
      record(root, { changeId: "chg_synth_hard_case_change", items: g0.differences.map((d) => ({ kind: d.kind, ref: d.ref, before: d.before, after: d.after, relaxation: true })), review: { status: "PENDING_INDEPENDENT_REVIEW", reviewRecordRef: null } });
      const g = checkCorpusGuard(root, changed);
      expect(g.unrecorded).toEqual([]);
      expect(g.unreviewedRelaxations.map((d) => d.kind)).toEqual(g0.differences.map((d) => d.kind));
      expect(g.pendingReview).toEqual([]);
      expect(g.ok).toBe(false);
      expect(lockMayAdvance(g)).toBe(false);
    };
    const plain = all.find((s) => s.variantFamily === "baseline" && s.riskClass === "routine" && s.adversarialTurn === null && s.initialState.faults.length === 0) as ScenarioDefinition;

    it("[FO-17-13] isHardCase: no clause holds for a routine baseline case; each clause alone (variant, risk class, adversarial turn, requested fault) makes a hard case", () => {
      const routine: Parameters<typeof isHardCase>[0] = { variantFamily: "baseline", riskClass: "routine", adversarialTurn: null, faults: [] };
      expect(isHardCase(routine)).toBe(false);
      expect(isHardCase({ ...routine, variantFamily: "interrupted_or_noisy" })).toBe(true);
      expect(isHardCase({ ...routine, riskClass: "privacy" })).toBe(true);
      expect(isHardCase({ ...routine, adversarialTurn: 0 })).toBe(true);
      expect(isHardCase({ ...routine, faults: ["CRASH_AFTER_COMMIT"] })).toBe(true);
      expect(plain).toBeDefined();
      expect(isHardCase(lockedOf(plain))).toBe(false);
    });

    it("[FO-17-13] (1) a script change of a baseline-variant scenario whose only hard clause is its risk class (no adversarial turn, no fault) is SCRIPT_CHANGED relaxation:true, for every risk class in the corpus", () => {
      const onlyRisk = all.filter((s) => s.variantFamily === "baseline" && s.riskClass !== "routine" && s.adversarialTurn === null && s.initialState.faults.length === 0);
      const byClass = new Map<string, ScenarioDefinition>();
      // One sample per risk class, a risk-corpus scenario (scn_risk_*) where the class has one.
      for (const s of onlyRisk) {
        const cur = byClass.get(s.riskClass);
        if (!cur || (!cur.scenarioId.startsWith("scn_risk_") && s.scenarioId.startsWith("scn_risk_"))) byClass.set(s.riskClass, s);
      }
      expect(byClass.size).toBeGreaterThanOrEqual(3);
      expect(byClass.has("privacy")).toBe(true);
      for (const [riskClass, s] of byClass) {
        expect(isHardCase(lockedOf(s)), s.scenarioId).toBe(true);
        const d = pairDiff(s, { ...s, script: benign(s) });
        expect(kinds(d), s.scenarioId).toEqual([["SCRIPT_CHANGED", true]]);
        expect(d[0]?.why).toBe(`script of a hard case changed (turns; baseline/${riskClass})`);
      }
      // A risk-corpus enumeration probe (privacy) defanged: blocking until a human review approves it.
      const probe = onlyRisk.find((s) => s.scenarioId.startsWith("scn_risk_enumeration_probe_")) as ScenarioDefinition;
      expect(probe).toBeDefined();
      blocksUntilReviewed(probe, { ...probe, script: benign(probe) });
      // A world change of one is a relaxation too.
      expect(kinds(pairDiff(probe, { ...probe, persona: "SYNTHETIC calm caller" }))).toEqual([["WORLD_CHANGED", true]]);
    });

    it("[FO-17-13] (2) a full defang that leaves the after-state non-hard (variant -> baseline, adversarial turn -> null, benign turns) is SCRIPT_CHANGED and WORLD_CHANGED relaxation:true, for every routine non-baseline variant family", () => {
      const families = new Map<string, ScenarioDefinition>();
      for (const s of all) if (s.variantFamily !== "baseline" && s.riskClass === "routine" && s.initialState.faults.length === 0 && !families.has(s.variantFamily)) families.set(s.variantFamily, s);
      expect(families.has("malicious_instruction")).toBe(true);
      expect(families.size).toBeGreaterThanOrEqual(3);
      for (const [family, s] of families) {
        const defanged: ScenarioDefinition = { ...s, variantFamily: "baseline", adversarialTurn: null, script: benign(s) };
        expect(isHardCase(lockedOf(s)), s.scenarioId).toBe(true);
        expect(isHardCase(lockedOf(defanged)), s.scenarioId).toBe(false);
        const d = pairDiff(s, defanged);
        expect(kinds(d), s.scenarioId).toEqual([
          ["SCRIPT_CHANGED", true],
          ["WORLD_CHANGED", true],
        ]);
        expect(d[0]?.why).toBe(`script of a hard case changed (turns${s.adversarialTurn !== null ? ",adversarialTurn" : ""}; ${family}/routine)`);
        expect(d[1]?.why).toBe(`world of a hard case changed (variantFamily; ${family}/routine)`);
      }
      const mal = families.get("malicious_instruction") as ScenarioDefinition;
      expect(mal.adversarialTurn).not.toBeNull();
      blocksUntilReviewed(mal, { ...mal, variantFamily: "baseline", adversarialTurn: null, script: benign(mal) });
    });

    it("[FO-17-13] (3) a synthetic routine baseline scenario with an adversarial turn, or with a requested fault, is a hard case: its script and world changes are relaxations; a change that makes a routine case hard is reviewed too", () => {
      const reworded = (s: ScenarioDefinition) => s.script.map((t, i) => (i === 0 ? { ...t, text: `${t.text} thanks` } : t));
      const adv: ScenarioDefinition = { ...plain, adversarialTurn: 0 };
      expect(isHardCase(lockedOf(adv))).toBe(true);
      expect(kinds(pairDiff(adv, { ...adv, script: reworded(adv) }))).toEqual([["SCRIPT_CHANGED", true]]);
      expect(pairDiff(adv, { ...adv, script: reworded(adv) })[0]?.why).toBe("script of a hard case changed (turns; baseline/routine)");
      blocksUntilReviewed(adv, { ...adv, script: benign(adv) });
      const faulted: ScenarioDefinition = { ...plain, initialState: { ...plain.initialState, faults: ["CRASH_AFTER_COMMIT"] } };
      expect(isHardCase(lockedOf(faulted))).toBe(true);
      expect(kinds(pairDiff(faulted, { ...faulted, script: reworded(faulted) }))).toEqual([["SCRIPT_CHANGED", true]]);
      expect(kinds(pairDiff(faulted, { ...faulted, persona: "SYNTHETIC calm caller" }))).toEqual([["WORLD_CHANGED", true]]);
      blocksUntilReviewed(faulted, { ...faulted, script: benign(faulted) });
      // The same rewording of the plain case is an ordinary recorded change (control for the clauses above).
      expect(kinds(pairDiff(plain, { ...plain, script: reworded(plain) }))).toEqual([["SCRIPT_CHANGED", false]]);
      // The after-state counts as well: a script change that gives a routine case an adversarial turn is reviewed.
      expect(kinds(pairDiff(plain, { ...plain, adversarialTurn: 0, script: reworded(plain) }))).toEqual([["SCRIPT_CHANGED", true]]);
    });
  });

  describe("[FO-17-13][FO-17-11] reach-rule narrowing per rule source: a filter widened to null or a superset, or a value replaced, is a relaxation; a strict subset is not", () => {
    const P = (id: string) => {
      const p = corpus.faultPlans.get(id);
      if (!p) throw new Error(`fault plan ${id} missing`);
      return p;
    };
    const planDiff = (was: FaultPlan, now: FaultPlan) => diffAgainstLock(buildLock({ scenarios: [], plans: new Map([[was.faultId, was]]) }), buildLock({ scenarios: [], plans: new Map([[now.faultId, now]]) }));
    const withRule = (p: FaultPlan, r: ReachEvidence): FaultPlan => ({ ...p, reachEvidence: [r] });
    const relaxes = (was: FaultPlan, r: ReachEvidence) => {
      const d = planDiff(was, withRule(was, r));
      expect(d.map((x) => x.kind)).toEqual(["FAULT_PLAN_CHANGED"]);
      if (d[0]?.relaxation) expect(d[0].why).toMatch(/reach rules widened or replaced/);
      return d[0]?.relaxation;
    };
    const only = <S extends ReachEvidence["source"]>(p: FaultPlan, source: S) => {
      expect(p.reachEvidence.map((r) => r.source)).toEqual([source]);
      return p.reachEvidence[0] as Extract<ReachEvidence, { source: S }>;
    };

    it("[FO-17-13] tool_response tools: [x] -> null, a superset or a replacement is a relaxation; a strict subset is a narrowing", () => {
      const p = P("AUTH_EXPIRY_MID_CALL");
      const r = only(p, "tool_response");
      expect(r.tools).toEqual(["commit_appointment_change"]);
      expect(relaxes(p, { ...r, tools: null })).toBe(true);
      expect(relaxes(p, { ...r, tools: ["commit_appointment_change", "get_appointment_options"] })).toBe(true);
      expect(relaxes(p, { ...r, tools: ["get_appointment_options"] })).toBe(true);
      expect(ruleNarrows({ ...r, tools: null }, r)).toBe(false);
      expect(ruleNarrows({ ...r, tools: ["commit_appointment_change", "get_appointment_options"] }, r)).toBe(false);
      const two = P("PROVIDER_API_TIMEOUT");
      const r2 = only(two, "tool_response");
      expect(r2.tools).toHaveLength(2);
      const sub = { ...r2, tools: [(r2.tools as string[])[0]] } as ReachEvidence;
      expect(relaxes(two, sub)).toBe(false);
      expect(planDiff(two, withRule(two, sub))[0]?.why).toBe("plan changed without relaxing an expectation, a reach rule, the trigger or the effect");
      expect(ruleNarrows(sub, r2)).toBe(true);
      expect(ruleNarrows(r2, sub)).toBe(false);
    });

    it("[FO-17-13] transfer_states: replacing either state of the adjacent pair, or reversing it, is a relaxation", () => {
      const p = P("BRIDGE_DROPPED");
      const r = only(p, "transfer_states");
      expect(r.adjacent).toEqual(["RECEIVER_ACCEPTED", "FAILED"]);
      expect(relaxes(p, { ...r, adjacent: ["RECEIVER_ACCEPTED", "DISCONNECTED"] })).toBe(true);
      expect(relaxes(p, { ...r, adjacent: ["QUEUED", "FAILED"] })).toBe(true);
      expect(relaxes(p, { ...r, adjacent: ["FAILED", "RECEIVER_ACCEPTED"] })).toBe(true);
      expect(ruleNarrows({ ...r, adjacent: ["RECEIVER_ACCEPTED", "DISCONNECTED"] }, r)).toBe(false);
      expect(ruleNarrows({ ...r, adjacent: ["QUEUED", "FAILED"] }, r)).toBe(false);
      expect(ruleNarrows({ ...r, adjacent: [...r.adjacent] }, r)).toBe(true);
    });

    it("[FO-17-13] support_request_kind: a changed kind is a relaxation", () => {
      const p = P("SALESFORCE_OUTAGE");
      const r = only(p, "support_request_kind");
      expect(r.kind).toBe("internal_pending_sync");
      expect(relaxes(p, { ...r, kind: "salesforce_case" })).toBe(true);
      expect(ruleNarrows({ ...r, kind: "salesforce_case" }, r)).toBe(false);
      expect(ruleNarrows({ ...r }, r)).toBe(true);
    });

    it("[FO-17-13] response_template templateIds: a superset or a replacement is a relaxation; a strict subset is a narrowing", () => {
      const p = P("KNOWLEDGE_STALE");
      const r = only(p, "response_template");
      expect(r.templateIds).toEqual(["knowledge.no_answer"]);
      expect(relaxes(p, { ...r, templateIds: ["knowledge.no_answer", "knowledge.answer_cited"] })).toBe(true);
      expect(relaxes(p, { ...r, templateIds: ["knowledge.answer_cited"] })).toBe(true);
      expect(ruleNarrows({ ...r, templateIds: ["knowledge.no_answer", "knowledge.answer_cited"] }, r)).toBe(false);
      const wider = withRule(p, { ...r, templateIds: ["knowledge.no_answer", "knowledge.answer_cited"] });
      const d = planDiff(wider, withRule(p, r));
      expect(d.map((x) => [x.kind, x.relaxation])).toEqual([["FAULT_PLAN_CHANGED", false]]);
      expect(ruleNarrows(r, { ...r, templateIds: ["knowledge.no_answer", "knowledge.answer_cited"] })).toBe(true);
    });

    it("[FO-17-13] backend_record: replacing the rule's collection with the same `where` (INTERRUPTED_CONFIRMATION ledger -> workflows, transfers, supportRequests) is a relaxation; the same collection with the same or a narrower `where` is not", () => {
      const p = P("INTERRUPTED_CONFIRMATION");
      const r = only(p, "backend_record");
      expect(r).toEqual({ source: "backend_record", collection: "ledger", where: { state: ["INVALIDATED"], confirmed: [false] } });
      for (const collection of ["workflows", "transfers", "supportRequests"] as const) {
        const moved: ReachEvidence = { ...r, collection };
        expect(ruleNarrows(moved, r), collection).toBe(false);
        expect(relaxes(p, moved), collection).toBe(true);
        expect(planDiff(p, withRule(p, moved))[0]?.why, collection).toBe(`reach rules widened or replaced: ${canonicalJson(moved)}`);
      }
      // Control: the same collection and filters, or a narrower filter set, is a narrowing.
      expect(ruleNarrows({ ...r, where: { ...r.where } }, r)).toBe(true);
      const narrower: ReachEvidence = { ...r, where: { ...r.where, kind: ["appointment_change"] } };
      expect(ruleNarrows(narrower, r)).toBe(true);
      expect(relaxes(p, narrower)).toBe(false);
      // Recorded by an engineering role, the replaced collection blocks until a human review approves it.
      const moved: FaultPlan = withRule(p, { ...r, collection: "workflows" });
      const root = tree({ scenarios: [], plans: new Map([[p.faultId, p]]) });
      const changed: GuardInputs = { scenarios: [], plans: new Map([[p.faultId, moved]]) };
      const d = checkCorpusGuard(root, changed).differences[0] as NonNullable<ReturnType<typeof checkCorpusGuard>["differences"][number]>;
      expect(d).toMatchObject({ kind: "FAULT_PLAN_CHANGED", ref: "INTERRUPTED_CONFIRMATION", relaxation: true });
      record(root, { changeId: "chg_synth_collection_moved", items: [{ kind: d.kind, ref: d.ref, before: d.before, after: d.after, relaxation: false }], review: { status: "PENDING_INDEPENDENT_REVIEW", reviewRecordRef: null } });
      const g = checkCorpusGuard(root, changed);
      expect(g.unreviewedRelaxations.map((x) => [x.kind, x.recordedBy])).toEqual([["FAULT_PLAN_CHANGED", "chg_synth_collection_moved"]]);
      expect(g.ok).toBe(false);
      expect(lockMayAdvance(g)).toBe(false);
    });

    it("[FO-17-13] a widened reach rule recorded by an engineering role blocks until a human review approves it", () => {
      const p = P("AUTH_EXPIRY_MID_CALL");
      const r = only(p, "tool_response");
      const locked: GuardInputs = { scenarios: [], plans: new Map([[p.faultId, p]]) };
      const changed: GuardInputs = { scenarios: [], plans: new Map([[p.faultId, withRule(p, { ...r, tools: null })]]) };
      const root = tree(locked);
      const d = checkCorpusGuard(root, changed).differences[0] as NonNullable<ReturnType<typeof checkCorpusGuard>["differences"][number]>;
      expect(d).toMatchObject({ kind: "FAULT_PLAN_CHANGED", ref: "AUTH_EXPIRY_MID_CALL", relaxation: true });
      record(root, { changeId: "chg_synth_reach_widened", items: [{ kind: d.kind, ref: d.ref, before: d.before, after: d.after, relaxation: true }], review: { status: "PENDING_INDEPENDENT_REVIEW", reviewRecordRef: null } });
      const g = checkCorpusGuard(root, changed);
      expect(g.unreviewedRelaxations.map((x) => x.recordedBy)).toEqual(["chg_synth_reach_widened"]);
      expect(g.ok).toBe(false);
      expect(lockMayAdvance(g)).toBe(false);
    });
  });

  it("[FO-17-13][FO-17-14] the committed corpus matches the committed lock (scenarios:check)", () => {
    const g = checkCorpusGuard(REPO_ROOT, { scenarios: corpus.entries.map((e) => e.scenario), plans: corpus.faultPlans });
    expect(g.unrecorded).toEqual([]);
    expect(g.unreviewedRelaxations).toEqual([]);
    expect(g.lockStale).toBe(false);
    expect(g.ok).toBe(true);
  });
});
