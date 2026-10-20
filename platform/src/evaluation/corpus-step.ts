/**
 * The corpus-wide step of `scenarios:gen` / `scenarios:check` (run by generate-risk.ts main, which runs last):
 * the lineage and required-scenario manifests (corpus-manifests.ts), the family leakage check (split.ts) and
 * the corpus guard against the lock and change records (corpus-guard.ts). It works on the PLANNED corpus of
 * both generators, so a check run sees exactly what a write run would produce.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ScenarioDefinition } from "../protocol/index.js";
import { LOCK_PATH, buildLock, checkCorpusGuard, lockMayAdvance } from "./corpus-guard.js";
import type { GuardReport } from "./corpus-guard.js";
import { compactJson, planManifestFiles } from "./corpus-manifests.js";
import type { CorpusMember } from "./corpus-manifests.js";
import { loadFaultPlans } from "./fault-plan.js";
import { planCorpusFiles } from "./generate.js";
import type { PlannedFile } from "./generate.js";
import type { RiskBundle } from "./generate-risk.js";
import { FAULTED_JOURNEYS, JOURNEYS } from "./journeys.js";
import { repoPaths } from "./paths.js";
import { hasLeakage } from "./split.js";
import type { LeakageReport } from "./split.js";

/** Every planned scenario with its source (skeleton, journey, faulted journey, risk template). */
export function corpusMembers(root: string, riskBundles: readonly RiskBundle[]): CorpusMember[] {
  const { scenarios } = planCorpusFiles(root);
  const journeyIds = new Set(JOURNEYS.map((j) => j.scenarioId));
  const faultedIds = new Set(FAULTED_JOURNEYS.map((j) => j.scenarioId));
  const routine: CorpusMember[] = scenarios.map((s: ScenarioDefinition) =>
    journeyIds.has(s.scenarioId)
      ? { scenario: s, source: "journey", sourceRef: `platform/src/evaluation/journeys.ts#${s.scenarioId}` }
      : faultedIds.has(s.scenarioId)
        ? { scenario: s, source: "journey_faulted", sourceRef: `platform/src/evaluation/journeys.ts#${s.scenarioId}` }
        : { scenario: s, source: "skeleton", sourceRef: `scenarios/skeletons/${s.intent}.yaml@v${s.version}` },
  );
  const risk: CorpusMember[] = riskBundles.flatMap((b) => b.drafts.map((d): CorpusMember => ({ scenario: d.scenario, source: "risk_template", sourceRef: `scenarios/risk/${b.family}.json#${b.family}` })));
  return [...routine, ...risk];
}

export interface CorpusStepResult {
  files: PlannedFile[];
  drift: { missing: string[]; changed: string[] };
  leakage: LeakageReport;
  guard: GuardReport;
}

function driftOf(root: string, files: readonly PlannedFile[]): CorpusStepResult["drift"] {
  const drift = { missing: [] as string[], changed: [] as string[] };
  for (const f of files) {
    let current: string | null;
    try {
      current = readFileSync(join(root, f.path), "utf8");
    } catch {
      current = null;
    }
    if (current === null) drift.missing.push(f.path);
    else if (current !== f.content) drift.changed.push(f.path);
  }
  return drift;
}

export function planCorpusStep(root: string, riskBundles: readonly RiskBundle[]): CorpusStepResult {
  const members = corpusMembers(root, riskBundles);
  const { files, leakage } = planManifestFiles(members);
  const plans = loadFaultPlans(repoPaths(root).failures);
  const guard = checkCorpusGuard(root, { scenarios: members.map((m) => m.scenario), plans });
  return { files, drift: driftOf(root, files), leakage, guard };
}

/** Lines describing the guard state (also printed by a passing check, so pending reviews stay visible). */
export function guardLines(g: GuardReport): string[] {
  const out: string[] = [];
  if (!g.lockPresent) out.push(`corpus lock missing (${LOCK_PATH}): run pnpm evidence corpus-lock --write`);
  for (const d of g.unrecorded) out.push(`UNRECORDED ${d.kind} ${d.ref}: ${d.why} (add a change record under scenarios/changes)`);
  for (const d of g.unreviewedRelaxations) out.push(`RELAXATION_NOT_REVIEWED ${d.kind} ${d.ref}: ${d.why} (${d.reviewRefusal ?? "REVIEW_NOT_REVIEWED"}; needs an approving human ReviewRecord, AIN-31)`);
  for (const d of g.pendingReview) out.push(`pending independent review: ${d.kind} ${d.ref} (${d.recordedBy})`);
  if (g.lockPresent && g.lockStale && g.unrecorded.length === 0 && g.unreviewedRelaxations.length === 0) out.push("corpus lock out of date: every difference is recorded; run pnpm evidence corpus-lock --write");
  return out;
}

/** scenarios:check / scenarios:gen corpus-wide step. Returns the exit code (0 ok, 1 drift or guard failure). */
export function runCorpusStep(root: string, riskBundles: readonly RiskBundle[], check: boolean): number {
  const r = planCorpusStep(root, riskBundles);
  const leak = r.leakage;
  const leakLine = `leakage check (${leak.splitSchemeVersion}): ${leak.families} families, ${leak.intents} intents; families shared across splits ${leak.leakedFamilies.length}, intents shared ${leak.leakedIntents.length}, misassigned ${leak.misassigned.length}; per split ${Object.entries(leak.scenariosPerSplit).map(([k, v]) => `${k}=${v}`).join(" ")}`;
  let code = 0;
  if (hasLeakage(leak)) {
    process.stderr.write(`${leakLine}\n${[...leak.leakedFamilies.map((f) => `  LEAKED_FAMILY ${f.familyKey} ${f.splits.join(",")}`), ...leak.leakedIntents.map((f) => `  LEAKED_INTENT ${f.intent} ${f.splits.join(",")}`), ...leak.misassigned.map((m) => `  MISASSIGNED ${m.scenarioId} ${m.split} != ${m.expected}`)].slice(0, 40).join("\n")}\n`);
    code = 1;
  } else process.stdout.write(`${leakLine}\n`);
  if (check) {
    if (r.drift.missing.length + r.drift.changed.length > 0) {
      process.stderr.write(`corpus manifest drift: ${[...r.drift.missing, ...r.drift.changed].join(", ")}\n`);
      code = 1;
    } else process.stdout.write("corpus manifests up to date (lineage, required scenarios per gate)\n");
  } else {
    for (const f of r.files) {
      mkdirSync(dirname(join(root, f.path)), { recursive: true });
      writeFileSync(join(root, f.path), f.content);
    }
    process.stdout.write(`wrote corpus manifests: ${r.files.map((f) => f.path).join(", ")}\n`);
  }
  const lines = guardLines(r.guard);
  if (!r.guard.ok) {
    process.stderr.write(`corpus guard FAILED:\n${lines.map((l) => `  ${l}`).join("\n")}\n`);
    code = 1;
  } else process.stdout.write(`corpus guard ok (${LOCK_PATH}; ${r.guard.differences.length} recorded difference(s))${lines.length ? `\n${lines.map((l) => `  ${l}`).join("\n")}` : ""}\n`);
  return code;
}

/** `pnpm evidence corpus-lock [--write]`: shows the guard state; --write moves the lock forward when allowed. */
export function runCorpusLock(root: string, riskBundles: readonly RiskBundle[], write: boolean): number {
  const members = corpusMembers(root, riskBundles);
  const plans = loadFaultPlans(repoPaths(root).failures);
  const guard = checkCorpusGuard(root, { scenarios: members.map((m) => m.scenario), plans });
  for (const l of guardLines(guard)) process.stdout.write(`${l}\n`);
  if (!write) return guard.ok ? 0 : 1;
  if (guard.lockPresent && !lockMayAdvance(guard)) {
    process.stderr.write("corpus lock NOT written: record every difference and obtain human review for every relaxation first\n");
    return 1;
  }
  const lock = buildLock({ scenarios: members.map((m) => m.scenario), plans });
  mkdirSync(dirname(join(root, LOCK_PATH)), { recursive: true });
  writeFileSync(join(root, LOCK_PATH), `${compactJson(lock)}\n`);
  process.stdout.write(`wrote ${LOCK_PATH}: ${Object.keys(lock.scenarios).length} scenarios, ${Object.keys(lock.faultPlans).length} fault plans, ${Object.keys(lock.scorerGates).length} scorer gate families\n`);
  return 0;
}
