/**
 * Corpus and gate change guard (FO-17-13; follow-on prompt section 17: "Do not remove hard cases, relabel
 * unmet assertions, or weaken gates to get green").
 *
 *   scenarios/locks/corpus-lock.json   the reviewed baseline (`corpus-lock.v4`): every scenario id with its
 *                                      version, the digests of its expectations, its script, its non-fault
 *                                      world and its review status, and the fields the relaxation rules
 *                                      compare; every fault plan with its expectation ids, reach rules, trigger
 *                                      and effect; every scorer gate family with its registration (the gate it
 *                                      reports to, hard or soft, the verdict its mutation must reach)
 *   scenarios/changes/*.json           change records: what changed against the lock, why, by which role,
 *                                      whether it relaxes anything, and its review state
 *
 * `scenarios:check` compares the generated corpus, the fault registry and the scorer's gate registry with
 * the lock. A scenario differs in up to four ways, each its own difference with its own digests:
 * EXPECTATION_CHANGED (outcome, committed actions, support request, tool sequence, prohibited actions, faults,
 * repetitions, handoff, disclosure, assurance, permitted records, risk class), SCRIPT_CHANGED (turn speakers,
 * texts, DTMF, ASR confidence and the adversarial turn) and WORLD_CHANGED (fixture set, persona, synthetic
 * account, variant family, intent, audience, locale, channel, stop condition) and REVIEW_CHANGED (the scenario's
 * self-declared review status, reviewer and review time: the aggregate's CORPUS_NOT_HUMAN_REVIEWED and risk-corpus
 * gates read it). Every difference needs a change record that names it (same kind, ref, before and after digests):
 *  - a RELAXATION is accepted only with review state REVIEWED and a ReviewRecord (protocol/review.ts) under
 *    scenarios/reviews/ whose subject is the change id, whose verdict approves it (PASS) and which was made
 *    after the change was recorded (`reviewRefusal`). Nothing in this package can author one (AIN-31), so a
 *    relaxation blocks the check until a person reviews it. Relaxations (`scenarioRelaxations`,
 *    `planRelaxations`; each mirrors the scorer check the field feeds, so a change is a relaxation when a run the
 *    old expectation FAILed or left INCONCLUSIVE can PASS under the new one): a removed scenario, fault plan or
 *    scorer gate family; a scorer gate made soft, its mutation requirement lowered FAIL -> INCONCLUSIVE or the
 *    family moved to another gate (SCORER_GATE_CHANGED, `gateRelaxations`); a relabelled outcome; a removed or ADDED expected commit (an added one is no longer an
 *    unexpected commit); any change of a boolean support-request expectation (an equality check; only null to a
 *    value adds a check); a removed prohibited action, fault or expected tool (the old tool sequence must stay a
 *    subsequence of the new one); an effect-taking tool (commit_, submit_, create_) newly expected (no longer an
 *    unexpected consequential tool); for a SAFETY_PRIORITY scenario, verification before the safety route newly
 *    or no longer expected; fewer repetitions; a required handoff that admits a transfer purpose the old one did
 *    not, or none (`handoffAdmits`, over HANDOFF_PURPOSES); a protected disclosure newly expected, or an expected
 *    authorized disclosure no longer required; a higher assurance ceiling; more permitted records; a risk class
 *    change that is not a strict escalation (routine to a risk class; the risk classes are not ordered among
 *    themselves); an expectation digest change that no locked field explains (fail closed); a variant family
 *    moved to baseline; any script or world change of a HARD CASE (a non-baseline variant, a
 *    non-routine risk class, an adversarial turn or a requested fault, before or after the change); a removed
 *    or changed fault-plan expectation; a reach-rule change that is not a strict narrowing (a filter widened
 *    to null or to a superset, a rule source replaced, a rule added that no old rule subsumes); any trigger or
 *    effect change of a plan; a review status raised (UNREVIEWED < IN_REVIEW < HUMAN_REVIEWED) or a review
 *    re-attributed (`reviewRelaxations`: only a lowered status is not a relaxation, so a scenario becomes
 *    HUMAN_REVIEWED only through a change record that a human ReviewRecord approves);
 *  - any other change (a stricter expectation such as an added prohibited action, a lower assurance ceiling or
 *    a support-request check added, a new fault, more repetitions, a narrowed reach rule, a script or world
 *    change of a routine baseline scenario) is accepted with review state PENDING_INDEPENDENT_REVIEW
 *    and is listed by the check;
 *  - new scenarios, plans and gates need no record.
 * When every difference is recorded, `pnpm evidence corpus-lock --write` moves the lock forward; it refuses
 * to while an unrecorded or unreviewed relaxation exists.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ASSURANCE_RANK, Assurance, RiskClass, ScenarioDefinition, ScenarioTurn, VariantFamily } from "../protocol/index.js";
import { ReviewRecord } from "../protocol/review.js";
import { canonicalJson, sha256Hex } from "../shared/canonical.js";
import { expectationDigest } from "./corpus-manifests.js";
import { FaultPlan, ReachEvidence, isIndependentReachRule } from "./fault-plan.js";
import { SCORER_GATES } from "./scorer.js";
import { accountKeyOf } from "./split.js";
import { HANDOFF_PURPOSES, expectsVerificationBeforeSafetyRoute, isEffectTakingToolName } from "./vocabulary.js";

export const LOCK_PATH = "scenarios/locks/corpus-lock.json";
export const CHANGES_DIR = "scenarios/changes";
export const REVIEWS_DIR = "scenarios/reviews";

const Sha = z.string().regex(/^[0-9a-f]{64}$/);

export const LOCK_VERSION = "corpus-lock.v4";

/** A scenario's self-declared review state (ScenarioDefinition.review), ordered by how much it claims. */
const ReviewStatus = z.enum(["UNREVIEWED", "IN_REVIEW", "HUMAN_REVIEWED"]);
const REVIEW_RANK: Record<z.infer<typeof ReviewStatus>, number> = { UNREVIEWED: 0, IN_REVIEW: 1, HUMAN_REVIEWED: 2 };

const LockedScenario = z.strictObject({
  version: z.number().int().min(1),
  /** Digest of every expectation (corpus-manifests.ts expectationDigest). */
  expectationDigest: Sha,
  /** Digest of the script (turn speakers, texts, DTMF, ASR confidence) and the adversarial turn. */
  scriptDigest: Sha,
  /** Digest of the non-fault initial world and scenario frame (fixture set, persona, account, variant family, ...). */
  worldDigest: Sha,
  /** Digest of the self-declared review (status, reviewer, review time). */
  reviewDigest: Sha,
  outcome: z.string(),
  committedActions: z.array(z.string()),
  supportRequestCreated: z.boolean().nullable(),
  expectedToolSequence: z.array(z.string()),
  prohibitedActions: z.array(z.string()),
  faults: z.array(z.string()),
  repetitions: z.number().int(),
  requiredHandoff: ScenarioDefinition.shape.requiredHandoff,
  disclosedProtectedFields: z.boolean(),
  expectedAssurance: Assurance,
  permittedRecords: z.array(z.string()),
  riskClass: RiskClass,
  variantFamily: VariantFamily,
  adversarialTurn: z.number().int().nullable(),
  script: z.array(ScenarioTurn),
  world: z.strictObject({
    fixtureSet: z.string(),
    persona: z.string().nullable(),
    account: z.string(),
    intent: z.string(),
    audience: z.string().nullable(),
    locale: z.string(),
    channel: z.string(),
    stopCondition: z.string(),
  }),
  review: z.strictObject({ status: ReviewStatus, reviewer: z.string().max(80).nullable(), reviewedAt: z.string().max(40).nullable() }),
});
export type LockedScenario = z.infer<typeof LockedScenario>;

const LockedPlan = z.strictObject({
  version: z.number().int().min(1),
  /** Digest of the expectations, reach rules, trigger and effect. */
  expectationsDigest: Sha,
  expectations: z.array(z.string()),
  reachEvidence: z.array(ReachEvidence),
  trigger: FaultPlan.shape.trigger,
  effect: FaultPlan.shape.effect,
});
export type LockedPlan = z.infer<typeof LockedPlan>;

/** A scorer gate family as registered in SCORER_GATES: the gate it reports to, whether it is hard, the verdict its mutation must reach. */
const LockedGate = z.strictObject({ gate: z.string(), hard: z.boolean(), mustFailUnder: z.enum(["FAIL", "INCONCLUSIVE"]) });
export type LockedGate = z.infer<typeof LockedGate>;

export const CorpusLock = z.strictObject({
  lockVersion: z.literal(LOCK_VERSION),
  scenarios: z.record(z.string(), LockedScenario),
  faultPlans: z.record(z.string(), LockedPlan),
  scorerGates: z.record(z.string(), LockedGate),
});
export type CorpusLock = z.infer<typeof CorpusLock>;

export const ChangeKind = z.enum(["SCENARIO_REMOVED", "EXPECTATION_CHANGED", "SCRIPT_CHANGED", "WORLD_CHANGED", "REVIEW_CHANGED", "FAULT_PLAN_REMOVED", "FAULT_PLAN_CHANGED", "SCORER_GATE_REMOVED", "SCORER_GATE_CHANGED"]);
export type ChangeKind = z.infer<typeof ChangeKind>;

export const ChangeRecord = z.strictObject({
  changeVersion: z.literal("corpus-change.v1"),
  changeId: z.string().regex(/^chg_[a-z0-9_]{6,64}$/),
  createdAt: z.iso.datetime(),
  /** Role of the author (never a person's name in the repository). */
  authorRole: z.string().regex(/^[a-z][a-z_]{2,40}$/),
  reason: z.string().min(20).max(1200),
  items: z
    .array(
      z.strictObject({
        kind: ChangeKind,
        ref: z.string().max(96),
        before: Sha.nullable(),
        after: Sha.nullable(),
        relaxation: z.boolean(),
      }),
    )
    .min(1)
    .max(2000),
  review: z.strictObject({
    status: z.enum(["PENDING_INDEPENDENT_REVIEW", "REVIEWED"]),
    /** ReviewRecord id (rvw_...) stored at scenarios/reviews/<id>.json; required for REVIEWED. */
    reviewRecordRef: z.string().regex(/^rvw_[A-Za-z0-9_-]{16,64}$/).nullable(),
  }),
});
export type ChangeRecord = z.infer<typeof ChangeRecord>;

export interface GuardInputs {
  scenarios: readonly ScenarioDefinition[];
  plans: ReadonlyMap<string, FaultPlan>;
  /** Scorer gate registry (default SCORER_GATES). */
  scorerGates?: Readonly<Record<string, LockedGate>>;
}

const planDigest = (p: FaultPlan) => sha256Hex(canonicalJson({ expectations: p.expectations, reachEvidence: p.reachEvidence, trigger: p.trigger, effect: p.effect }));
const expectationIds = (p: FaultPlan) => p.expectations.map((x) => `${x.check}:${x.gate}${"outcomes" in x ? `:${[...x.outcomes].sort().join("|")}` : ""}${"tokens" in x ? `:${[...x.tokens].sort().join("|")}` : ""}${"kind" in x ? `:${x.kind}` : ""}`).sort();

/** The script as the lock records it (every turn field) plus the adversarial turn. */
const scriptOf = (s: ScenarioDefinition) => s.script.map((t) => ({ speaker: t.speaker, text: t.text, dtmf: t.dtmf, asrConfidence: t.asrConfidence }));
const worldOf = (s: ScenarioDefinition): LockedScenario["world"] => ({
  fixtureSet: s.initialState.fixtureSet,
  persona: s.persona,
  account: accountKeyOf(s),
  intent: s.intent,
  audience: s.audience,
  locale: s.locale,
  channel: s.channel,
  stopCondition: s.stopCondition,
});
export const scriptDigest = (s: ScenarioDefinition): string => sha256Hex(canonicalJson({ script: scriptOf(s), adversarialTurn: s.adversarialTurn }));
export const worldDigest = (s: ScenarioDefinition): string => sha256Hex(canonicalJson({ ...worldOf(s), variantFamily: s.variantFamily }));
const reviewOf = (s: ScenarioDefinition): LockedScenario["review"] => ({ status: s.review.status, reviewer: s.review.reviewer, reviewedAt: s.review.reviewedAt });
export const reviewDigest = (s: ScenarioDefinition): string => sha256Hex(canonicalJson(reviewOf(s)));

export function buildLock(inp: GuardInputs): CorpusLock {
  const scenarios = Object.fromEntries(
    [...inp.scenarios]
      .sort((a, b) => (a.scenarioId < b.scenarioId ? -1 : 1))
      .map((s): [string, LockedScenario] => [
        s.scenarioId,
        {
          version: s.version,
          expectationDigest: expectationDigest(s),
          scriptDigest: scriptDigest(s),
          worldDigest: worldDigest(s),
          reviewDigest: reviewDigest(s),
          outcome: s.expectedFinalState.outcome,
          committedActions: [...s.expectedFinalState.committedActions].sort(),
          supportRequestCreated: s.expectedFinalState.supportRequestCreated,
          expectedToolSequence: [...s.expectedToolSequence],
          prohibitedActions: [...s.prohibitedActions].sort(),
          faults: [...s.initialState.faults].sort(),
          repetitions: s.repetitions,
          requiredHandoff: s.requiredHandoff,
          disclosedProtectedFields: s.expectedFinalState.disclosedProtectedFields,
          expectedAssurance: s.expectedAssurance,
          permittedRecords: [...s.permittedRecords].sort(),
          riskClass: s.riskClass,
          variantFamily: s.variantFamily,
          adversarialTurn: s.adversarialTurn,
          script: scriptOf(s),
          world: worldOf(s),
          review: reviewOf(s),
        },
      ]),
  );
  const faultPlans = Object.fromEntries(
    [...inp.plans.values()]
      .sort((a, b) => (a.faultId < b.faultId ? -1 : 1))
      .map((p): [string, LockedPlan] => [p.faultId, { version: p.version, expectationsDigest: planDigest(p), expectations: expectationIds(p), reachEvidence: p.reachEvidence, trigger: p.trigger, effect: p.effect }]),
  );
  const scorerGates = Object.fromEntries(
    Object.entries(inp.scorerGates ?? SCORER_GATES)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([family, g]): [string, LockedGate] => [family, { gate: g.gate, hard: g.hard, mustFailUnder: g.mustFailUnder }]),
  );
  return CorpusLock.parse({ lockVersion: LOCK_VERSION, scenarios, faultPlans, scorerGates });
}

export interface LockDifference {
  kind: ChangeKind;
  ref: string;
  before: string | null;
  after: string | null;
  relaxation: boolean;
  why: string;
}

type RequiredHandoff = LockedScenario["requiredHandoff"];

/**
 * The transfer purposes a required-handoff change newly admits (null: it relaxes nothing). gate.safety.required_handoff
 * PASSes a transfer whose purpose is one of HANDOFF_PURPOSES[route], so a new route that admits a purpose the old one
 * did not passes a run that FAILed before (STANDARD_HUMAN -> INTERPRETER, INTERPRETER -> SAFETY_PRIORITY), and NONE
 * removes the gate. Moving away from SAFETY_PRIORITY also removes gate.safety.no_auth_before_safety_route; every other
 * route admits a purpose SAFETY_PRIORITY does not, so the purpose rule covers that case (pinned by a test).
 */
export function handoffAdmits(was: RequiredHandoff, now: RequiredHandoff): string[] | null {
  if (was === "NONE" || now === was) return null;
  if (now === "NONE") return [];
  const admitted = HANDOFF_PURPOSES[now].filter((p) => !HANDOFF_PURPOSES[was].includes(p));
  return admitted.length > 0 ? admitted : null;
}

/** The expectation fields the lock records (scenarioRelaxations compares each). */
const EXPECTATION_FIELDS = ["outcome", "committedActions", "supportRequestCreated", "expectedToolSequence", "prohibitedActions", "faults", "repetitions", "requiredHandoff", "disclosedProtectedFields", "expectedAssurance", "permittedRecords", "riskClass"] as const;

/** Elements of `was` (a multiset) that `now` no longer holds. */
function multisetRemoved(was: readonly string[], now: readonly string[]): string[] {
  const left = new Map<string, number>();
  for (const x of now) left.set(x, (left.get(x) ?? 0) + 1);
  const out: string[] = [];
  for (const x of was) {
    const n = left.get(x) ?? 0;
    if (n > 0) left.set(x, n - 1);
    else out.push(x);
  }
  return out;
}
const isSubsequence = (sub: readonly string[], seq: readonly string[]): boolean => {
  let i = 0;
  for (const x of seq) if (i < sub.length && x === sub[i]) i++;
  return i === sub.length;
};

/**
 * A HARD CASE: a scenario whose script or world is what makes it hard (a non-baseline variant, a risk class,
 * an adversarial turn or a requested fault). Any script or world change of one, before or after the change,
 * is a relaxation: replacing its malicious, noisy or failure turns with benign text removes the hard case
 * while every expectation stays the same.
 */
export const isHardCase = (x: Pick<LockedScenario, "variantFamily" | "riskClass" | "adversarialTurn" | "faults">): boolean =>
  x.variantFamily !== "baseline" || x.riskClass !== "routine" || x.adversarialTurn !== null || x.faults.length > 0;

/**
 * Reasons a scenario's expectation change relaxes it (empty: it does not). Each rule mirrors the scorer check the
 * field feeds: a change is a relaxation when some run the old expectation FAILed (or left INCONCLUSIVE) can PASS
 * under the new one. Equality checks (outcome, support request) are relabelled by any change; the expected commits
 * and the expected tools feed both a task check (a removal relaxes it) and a hard transaction gate (an addition
 * admits a commit or an effect-taking tool that gate FAILed before).
 */
export function scenarioRelaxations(was: LockedScenario, now: LockedScenario): string[] {
  const reasons: string[] = [];
  if (now.outcome !== was.outcome) reasons.push(`outcome relabelled ${was.outcome} -> ${now.outcome}`);
  const droppedCommits = multisetRemoved(was.committedActions, now.committedActions);
  if (droppedCommits.length > 0) reasons.push(`expected commits removed: ${droppedCommits.join(",")}`);
  // gate.transaction.no_unexpected_commit FAILs a commit beyond the expected multiset: expecting it admits it.
  const addedCommits = multisetRemoved(now.committedActions, was.committedActions);
  if (addedCommits.length > 0) reasons.push(`expected commits added: ${addedCommits.join(",")} (no longer unexpected commits)`);
  // task.support_request is an equality check (null runs none), so any change from a boolean relabels it.
  if (was.supportRequestCreated !== null && now.supportRequestCreated !== was.supportRequestCreated) {
    reasons.push(`support request expectation relabelled ${String(was.supportRequestCreated)} -> ${String(now.supportRequestCreated)}`);
  }
  if (!isSubsequence(was.expectedToolSequence, now.expectedToolSequence)) {
    const dropped = multisetRemoved(was.expectedToolSequence, now.expectedToolSequence);
    reasons.push(dropped.length > 0 ? `expected tools removed: ${dropped.join(",")}` : "expected tool order changed (the old sequence is no longer required)");
  }
  // gate.transaction.no_unexpected_consequential_tool FAILs an effect-taking tool the scenario does not expect.
  const admittedTools = [...new Set(now.expectedToolSequence)].filter((t) => isEffectTakingToolName(t) && !was.expectedToolSequence.includes(t));
  if (admittedTools.length > 0) reasons.push(`effect-taking tools newly expected: ${admittedTools.join(",")} (no longer unexpected tools)`);
  // gate.safety.no_auth_before_safety_route checks tool order, or the driver's signal-relative flag when the script
  // verifies first: switching between the two changes which evidence the hard gate accepts.
  const verifyFirstWas = expectsVerificationBeforeSafetyRoute(was.expectedToolSequence);
  if (was.requiredHandoff === "SAFETY_PRIORITY" && verifyFirstWas !== expectsVerificationBeforeSafetyRoute(now.expectedToolSequence)) {
    reasons.push(`verification before the safety route ${verifyFirstWas ? "no longer" : "newly"} expected (the no-auth-before-safety-route gate accepts other evidence)`);
  }
  const droppedProhibited = was.prohibitedActions.filter((p) => !now.prohibitedActions.includes(p));
  if (droppedProhibited.length > 0) reasons.push(`prohibited actions removed: ${droppedProhibited.join(",")}`);
  const droppedFaults = was.faults.filter((f) => !now.faults.includes(f));
  if (droppedFaults.length > 0) reasons.push(`faults removed: ${droppedFaults.join(",")}`);
  if (now.repetitions < was.repetitions) reasons.push(`repetitions reduced ${was.repetitions} -> ${now.repetitions}`);
  const admittedRoutes = handoffAdmits(was.requiredHandoff, now.requiredHandoff);
  if (admittedRoutes !== null) reasons.push(`required handoff weakened ${was.requiredHandoff} -> ${now.requiredHandoff}${admittedRoutes.length > 0 ? ` (admits ${admittedRoutes.join(",")})` : " (no handoff gate)"}`);
  if (now.disclosedProtectedFields && !was.disclosedProtectedFields) reasons.push("protected disclosure newly expected");
  // task.expected_information_provided FAILs a run that withheld expected authorized information.
  if (was.disclosedProtectedFields && !now.disclosedProtectedFields) reasons.push("expected authorized disclosure no longer required");
  // expectedAssurance is a ceiling (gate.authentication.assurance_not_exceeded): raising it allows more.
  if (ASSURANCE_RANK[now.expectedAssurance] > ASSURANCE_RANK[was.expectedAssurance]) reasons.push(`assurance ceiling raised ${was.expectedAssurance} -> ${now.expectedAssurance}`);
  const addedRecords = now.permittedRecords.filter((r) => !was.permittedRecords.includes(r));
  if (addedRecords.length > 0) reasons.push(`permitted records added: ${addedRecords.join(",")}`);
  // Only routine -> a risk class is an escalation; the risk classes are not ordered among themselves.
  if (now.riskClass !== was.riskClass && !(was.riskClass === "routine" && now.riskClass !== "routine")) reasons.push(`risk class ${was.riskClass} -> ${now.riskClass} is not a strict escalation`);
  // Fail closed: a digest change no locked field explains (the order of the requested faults, of which the first is
  // the result's requestedFault) cannot be classified, so it is reviewed as a relaxation.
  if (now.expectationDigest !== was.expectationDigest && EXPECTATION_FIELDS.every((k) => canonicalJson(was[k]) === canonicalJson(now[k]))) {
    reasons.push("expectation digest changed but no locked expectation field did (unclassified change)");
  }
  return reasons;
}

/** Reasons a scenario's script or world change relaxes it (empty: a routine baseline case). */
export function scriptOrWorldRelaxations(kind: "SCRIPT_CHANGED" | "WORLD_CHANGED", was: LockedScenario, now: LockedScenario): string[] {
  // A non-baseline variant is a hard case, so moving one to baseline (a WORLD_CHANGED) is covered here too.
  const reasons: string[] = [];
  if (isHardCase(was) || isHardCase(now)) {
    const fields: string[] =
      kind === "SCRIPT_CHANGED"
        ? [...(canonicalJson(was.script) !== canonicalJson(now.script) ? ["turns"] : []), ...(was.adversarialTurn !== now.adversarialTurn ? ["adversarialTurn"] : [])]
        : [...(Object.keys(was.world) as (keyof LockedScenario["world"])[]).filter((k) => was.world[k] !== now.world[k]), ...(was.variantFamily !== now.variantFamily ? ["variantFamily"] : [])];
    reasons.push(`${kind === "SCRIPT_CHANGED" ? "script" : "world"} of a hard case changed (${fields.join(",")}; ${was.variantFamily}/${was.riskClass})`);
  }
  return reasons;
}

/**
 * Reasons a scenario's review change relaxes it (empty: the status was lowered). The aggregate gates on the
 * self-declared status (CORPUS_NOT_HUMAN_REVIEWED, the human-reviewed risk-corpus minimum), so raising it, or
 * changing who reviewed it or when at the same status, removes a block; only a human ReviewRecord approving the
 * change record may do that (AIN-31).
 */
export function reviewRelaxations(was: LockedScenario, now: LockedScenario): string[] {
  if (REVIEW_RANK[now.review.status] < REVIEW_RANK[was.review.status]) return [];
  return [REVIEW_RANK[now.review.status] > REVIEW_RANK[was.review.status] ? `review status raised ${was.review.status} -> ${now.review.status}` : `review re-attributed at ${now.review.status} (reviewer or review time changed)`];
}

/** Allowed values of a rule filter (null: any value). */
const filterNarrows = <T>(now: readonly T[] | null, was: readonly T[] | null): boolean => was === null || (now !== null && now.every((x) => was.includes(x)));

/** True when every record the `now` rule matches is matched by the `was` rule (same source, each filter a subset). */
export function ruleNarrows(now: ReachEvidence, was: ReachEvidence): boolean {
  switch (now.source) {
    case "tool_response":
      return was.source === now.source && filterNarrows(now.tools, was.tools) && filterNarrows(now.statuses, was.statuses) && filterNarrows(now.reasonCodes, was.reasonCodes) && filterNarrows(now.sessionStates, was.sessionStates);
    case "ambiguous_commit_with_effect":
      return was.source === now.source && filterNarrows(now.tools, was.tools);
    case "transfer_states":
      return was.source === now.source && now.adjacent[0] === was.adjacent[0] && now.adjacent[1] === was.adjacent[1];
    case "support_request_kind":
      return was.source === now.source && now.kind === was.kind;
    case "verification_not_completed":
      return was.source === now.source;
    case "backend_record":
      return was.source === now.source && now.collection === was.collection && Object.entries(was.where).every(([f, allowed]) => filterNarrows(now.where[f] ?? null, allowed));
    case "response_template":
      return was.source === now.source && filterNarrows(now.templateIds, was.templateIds);
    case "emulator_log":
      return was.source === now.source && now.log === was.log;
    case "driver_self_report":
      // Never reach evidence: it matches nothing a reach rule could, so it narrows any rule set.
      return true;
  }
}

/** Reasons a fault plan change relaxes it (empty: a stricter or narrower plan). */
export function planRelaxations(was: LockedPlan, now: LockedPlan): string[] {
  const reasons: string[] = [];
  const dropped = was.expectations.filter((x) => !now.expectations.includes(x));
  if (dropped.length > 0) reasons.push(`expectations removed or changed: ${dropped.join(",")}`);
  // A plan is reached when ANY independent rule matches: the new rules narrow the old ones only if each new
  // independent rule is subsumed by an old independent rule. Removing a rule narrows; widening a filter to
  // null or a superset, replacing a rule's source or adding an unsubsumed rule does not.
  const oldRules = was.reachEvidence.filter(isIndependentReachRule);
  const widened = now.reachEvidence.filter(isIndependentReachRule).filter((r) => !oldRules.some((o) => ruleNarrows(r, o)));
  if (widened.length > 0) reasons.push(`reach rules widened or replaced: ${widened.map((r) => canonicalJson(r)).join(" ")}`);
  if (canonicalJson(now.trigger) !== canonicalJson(was.trigger)) reasons.push(`trigger changed ${canonicalJson(was.trigger)} -> ${canonicalJson(now.trigger)}`);
  if (canonicalJson(now.effect) !== canonicalJson(was.effect)) reasons.push(`effect changed ${canonicalJson(was.effect)} -> ${canonicalJson(now.effect)}`);
  return reasons;
}

const gateDigest = (family: string, g: LockedGate): string => sha256Hex(canonicalJson({ family, gate: g.gate, hard: g.hard, mustFailUnder: g.mustFailUnder }));

/**
 * Reasons a scorer gate family's registration change relaxes it (empty: a stricter registration). A hard gate made
 * soft no longer outranks an INCONCLUSIVE check and leaves the per-gate hard results; a mutation requirement lowered
 * from FAIL to INCONCLUSIVE accepts a gate that can no longer FAIL; a family moved to another gate leaves the gate
 * result it fed (the release decision reads per-gate results).
 */
export function gateRelaxations(was: LockedGate, now: LockedGate): string[] {
  const reasons: string[] = [];
  if (was.hard && !now.hard) reasons.push("hard gate made soft");
  if (was.mustFailUnder === "FAIL" && now.mustFailUnder === "INCONCLUSIVE") reasons.push("mutation requirement lowered FAIL -> INCONCLUSIVE");
  if (now.gate !== was.gate) reasons.push(`reported under another gate ${was.gate} -> ${now.gate}`);
  return reasons;
}

/** Every difference between the lock and the current corpus, with its relaxation classification. */
export function diffAgainstLock(lock: CorpusLock, current: CorpusLock): LockDifference[] {
  const out: LockDifference[] = [];
  for (const [id, was] of Object.entries(lock.scenarios)) {
    const now = current.scenarios[id];
    if (!now) {
      out.push({ kind: "SCENARIO_REMOVED", ref: id, before: was.expectationDigest, after: null, relaxation: true, why: "hard cases are never removed silently" });
      continue;
    }
    if (now.expectationDigest !== was.expectationDigest) {
      const reasons = scenarioRelaxations(was, now);
      out.push({
        kind: "EXPECTATION_CHANGED",
        ref: id,
        before: was.expectationDigest,
        after: now.expectationDigest,
        relaxation: reasons.length > 0,
        why: reasons.length > 0 ? reasons.join("; ") : "expectation changed without relaxing any hard expectation",
      });
    }
    for (const [kind, field] of [
      ["SCRIPT_CHANGED", "scriptDigest"],
      ["WORLD_CHANGED", "worldDigest"],
    ] as const) {
      if (now[field] === was[field]) continue;
      const reasons = scriptOrWorldRelaxations(kind, was, now);
      out.push({
        kind,
        ref: id,
        before: was[field],
        after: now[field],
        relaxation: reasons.length > 0,
        why: reasons.length > 0 ? reasons.join("; ") : `${kind === "SCRIPT_CHANGED" ? "script" : "world"} of a routine baseline scenario changed`,
      });
    }
    if (now.reviewDigest !== was.reviewDigest) {
      const reasons = reviewRelaxations(was, now);
      out.push({
        kind: "REVIEW_CHANGED",
        ref: id,
        before: was.reviewDigest,
        after: now.reviewDigest,
        relaxation: reasons.length > 0,
        why: reasons.length > 0 ? reasons.join("; ") : `review status lowered ${was.review.status} -> ${now.review.status}`,
      });
    }
  }
  for (const [id, was] of Object.entries(lock.faultPlans)) {
    const now = current.faultPlans[id];
    if (!now) {
      out.push({ kind: "FAULT_PLAN_REMOVED", ref: id, before: was.expectationsDigest, after: null, relaxation: true, why: "a fault plan of the fixed registry was removed" });
      continue;
    }
    if (now.expectationsDigest === was.expectationsDigest) continue;
    const reasons = planRelaxations(was, now);
    const narrowed = now.reachEvidence.filter(isIndependentReachRule).length < was.reachEvidence.filter(isIndependentReachRule).length;
    out.push({
      kind: "FAULT_PLAN_CHANGED",
      ref: id,
      before: was.expectationsDigest,
      after: now.expectationsDigest,
      relaxation: reasons.length > 0,
      why: [...reasons, ...(narrowed ? [`reach rules reduced ${was.reachEvidence.filter(isIndependentReachRule).length} -> ${now.reachEvidence.filter(isIndependentReachRule).length} (narrowing)`] : [])].join("; ") || "plan changed without relaxing an expectation, a reach rule, the trigger or the effect",
    });
  }
  for (const [family, was] of Object.entries(lock.scorerGates)) {
    const now = current.scorerGates[family];
    if (!now) {
      out.push({ kind: "SCORER_GATE_REMOVED", ref: family, before: gateDigest(family, was), after: null, relaxation: true, why: "a scorer gate family was removed (gate weakening)" });
      continue;
    }
    if (gateDigest(family, now) === gateDigest(family, was)) continue;
    const reasons = gateRelaxations(was, now);
    out.push({
      kind: "SCORER_GATE_CHANGED",
      ref: family,
      before: gateDigest(family, was),
      after: gateDigest(family, now),
      relaxation: reasons.length > 0,
      why: reasons.length > 0 ? reasons.join("; ") : "gate registration made stricter (soft -> hard or mutation requirement INCONCLUSIVE -> FAIL)",
    });
  }
  return out;
}

export function loadChangeRecords(root: string): ChangeRecord[] {
  const dir = join(root, CHANGES_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => {
      const rec = ChangeRecord.parse(JSON.parse(readFileSync(join(dir, f), "utf8")));
      if (`${rec.changeId}.json` !== f) throw new Error(`CHANGE_RECORD_FILENAME_MISMATCH: ${f}`);
      return rec;
    });
}

export type ReviewRefusal =
  | "REVIEW_NOT_REVIEWED"
  | "REVIEW_RECORD_MISSING"
  | "REVIEW_RECORD_INVALID"
  | "REVIEW_RECORD_ID_MISMATCH"
  | "REVIEW_SUBJECT_MISMATCH"
  | "REVIEW_NOT_APPROVED"
  | "REVIEW_PREDATES_CHANGE";

export type RecordedDifference = LockDifference & {
  recordedBy: string | null;
  reviewState: "NONE" | "PENDING_INDEPENDENT_REVIEW" | "REVIEWED";
  /** Why the change record's review does not count (null when there is no record or the review is valid). */
  reviewRefusal: ReviewRefusal | null;
};

export interface GuardReport {
  lockPresent: boolean;
  differences: RecordedDifference[];
  /** Differences with no change record naming them: blocking. */
  unrecorded: RecordedDifference[];
  /** Relaxations without a valid human review: blocking. */
  unreviewedRelaxations: RecordedDifference[];
  /** Recorded non-relaxing changes still waiting for independent review: listed, not blocking. */
  pendingReview: RecordedDifference[];
  /** The lock differs from the current corpus (run corpus-lock --write once every difference is recorded). */
  lockStale: boolean;
  ok: boolean;
}

/**
 * Why a change record's review does not validate it (null: valid). A review counts only when the record says
 * REVIEWED, names a ReviewRecord stored under scenarios/reviews/ whose id and subject are this change, the
 * reviewer APPROVED it (verdict PASS: a review that rejects or cannot decide the change is not an approval) and
 * it took place after the change was recorded. The ReviewRecord contract admits human reviewers only
 * (reviewer.kind is the literal "human" and a signature is required, AIN-31), so a record written by a judge,
 * a tool or this package never parses and is REVIEW_RECORD_INVALID.
 */
export function reviewRefusal(root: string, rec: ChangeRecord): ReviewRefusal | null {
  if (rec.review.status !== "REVIEWED") return "REVIEW_NOT_REVIEWED";
  if (rec.review.reviewRecordRef === null) return "REVIEW_RECORD_MISSING";
  const path = join(root, REVIEWS_DIR, `${rec.review.reviewRecordRef}.json`);
  if (!existsSync(path)) return "REVIEW_RECORD_MISSING";
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return "REVIEW_RECORD_INVALID";
  }
  const parsed = ReviewRecord.safeParse(raw);
  if (!parsed.success) return "REVIEW_RECORD_INVALID";
  if (parsed.data.reviewId !== rec.review.reviewRecordRef) return "REVIEW_RECORD_ID_MISMATCH";
  if (parsed.data.subject.ref !== rec.changeId) return "REVIEW_SUBJECT_MISMATCH";
  if (parsed.data.verdict !== "PASS") return "REVIEW_NOT_APPROVED";
  if (Date.parse(parsed.data.occurredAt) < Date.parse(rec.createdAt)) return "REVIEW_PREDATES_CHANGE";
  return null;
}

/** Compares the current corpus with the lock and the change records (scenarios:check). */
export function checkCorpusGuard(root: string, inp: GuardInputs): GuardReport {
  const current = buildLock(inp);
  const lockFile = join(root, LOCK_PATH);
  if (!existsSync(lockFile)) {
    return { lockPresent: false, differences: [], unrecorded: [], unreviewedRelaxations: [], pendingReview: [], lockStale: true, ok: false };
  }
  const raw = JSON.parse(readFileSync(lockFile, "utf8")) as { lockVersion?: unknown };
  if (raw.lockVersion !== LOCK_VERSION) throw new Error(`CORPUS_LOCK_VERSION_UNSUPPORTED: ${LOCK_PATH} is ${String(raw.lockVersion)}, expected ${LOCK_VERSION}`);
  const lock = CorpusLock.parse(raw);
  const records = loadChangeRecords(root);
  const diffs = diffAgainstLock(lock, current);
  const differences = diffs.map((d): RecordedDifference => {
    const rec = records.find((r) => r.items.some((i) => i.kind === d.kind && i.ref === d.ref && i.before === d.before && i.after === d.after));
    const refusal = rec ? reviewRefusal(root, rec) : null;
    const reviewState = !rec ? "NONE" : refusal === null ? "REVIEWED" : "PENDING_INDEPENDENT_REVIEW";
    return { ...d, recordedBy: rec?.changeId ?? null, reviewState, reviewRefusal: refusal };
  });
  const unrecorded = differences.filter((d) => d.recordedBy === null);
  const unreviewedRelaxations = differences.filter((d) => d.recordedBy !== null && d.relaxation && d.reviewState !== "REVIEWED");
  const pendingReview = differences.filter((d) => d.recordedBy !== null && !d.relaxation && d.reviewState !== "REVIEWED");
  const lockStale = canonicalJson(lock) !== canonicalJson(current);
  return { lockPresent: true, differences, unrecorded, unreviewedRelaxations, pendingReview, lockStale, ok: unrecorded.length === 0 && unreviewedRelaxations.length === 0 && !lockStale };
}

/** True when the lock may be moved forward: every difference recorded and every relaxation reviewed. */
export const lockMayAdvance = (r: GuardReport): boolean => r.unrecorded.length === 0 && r.unreviewedRelaxations.length === 0;
