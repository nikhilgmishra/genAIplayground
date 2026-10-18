/**
 * Scenario corpus loader and digest.
 *
 * Corpus layout (see scenarios/README.md):
 *   scenarios/generated/{development,heldout_acceptance}/*.json  routine quality corpus (one ScenarioDefinition per file)
 *   scenarios/journeys/*.json, scenarios/journeys/faulted/*.json  demonstration journeys (+ fault-injected)
 *   scenarios/risk/<family>.json                                 risk-scenario DRAFT bundles (separate from routine tests)
 *   scenarios/fixtures/failures/<FAULT_ID>.json                  deterministic fault plans
 *   scenarios/skeletons/<intent>.yaml                            generator input
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ScenarioDefinition } from "../protocol/index.js";
import { sha256Hex } from "../shared/canonical.js";
import { loadFaultPlans } from "./fault-plan.js";
import type { FaultPlan } from "./fault-plan.js";
import { RiskBundle } from "./generate-risk.js";
import { REPO_ROOT, posixRelative, repoPaths, walkFiles } from "./paths.js";

export type CorpusKind = "routine" | "journey" | "journey_faulted" | "risk_draft";

export interface CorpusEntry {
  kind: CorpusKind;
  file: string;
  scenario: ScenarioDefinition;
  /** Risk drafts only. */
  borderline?: boolean;
  riskFamily?: string;
}

export interface LoadedCorpus {
  entries: CorpusEntry[];
  faultPlans: Map<string, FaultPlan>;
  byId: Map<string, ScenarioDefinition>;
}

export class CorpusError extends Error {
  constructor(
    readonly file: string,
    readonly reasonCode: string,
  ) {
    super(`${reasonCode}: ${file}`);
  }
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new CorpusError(file, "CORPUS_FILE_UNPARSEABLE");
  }
}

function loadScenarioFiles(root: string, dir: string, kind: CorpusKind, recursive: boolean): CorpusEntry[] {
  return walkFiles(dir, (f) => f.endsWith(".json"))
    .filter((f) => recursive || !posixRelative(dir, f).includes("/"))
    .map((file) => {
      const parsed = ScenarioDefinition.safeParse(readJson(file));
      if (!parsed.success) throw new CorpusError(posixRelative(root, file), "SCENARIO_INVALID");
      return { kind, file: posixRelative(root, file), scenario: parsed.data };
    });
}

/** Loads and strictly validates the whole corpus. Duplicate scenario ids are an error. */
export function loadCorpus(root = REPO_ROOT): LoadedCorpus {
  const p = repoPaths(root);
  const entries: CorpusEntry[] = [
    ...loadScenarioFiles(root, join(p.generated, "development"), "routine", false),
    ...loadScenarioFiles(root, join(p.generated, "heldout_acceptance"), "routine", false),
    ...loadScenarioFiles(root, p.journeys, "journey", false),
    ...loadScenarioFiles(root, join(p.journeys, "faulted"), "journey_faulted", false),
  ];
  for (const file of walkFiles(p.risk, (f) => f.endsWith(".json"))) {
    const parsed = RiskBundle.safeParse(readJson(file));
    if (!parsed.success) throw new CorpusError(posixRelative(root, file), "RISK_BUNDLE_INVALID");
    for (const d of parsed.data.drafts) {
      entries.push({ kind: "risk_draft", file: posixRelative(root, file), scenario: d.scenario, borderline: d.borderline, riskFamily: parsed.data.family });
    }
  }
  const byId = new Map<string, ScenarioDefinition>();
  for (const e of entries) {
    if (byId.has(e.scenario.scenarioId)) throw new CorpusError(e.file, "DUPLICATE_SCENARIO_ID");
    byId.set(e.scenario.scenarioId, e.scenario);
  }
  return { entries, faultPlans: loadFaultPlans(p.failures), byId };
}

export interface CorpusDigest {
  digest: string;
  files: { path: string; sha256: string }[];
}

/**
 * sha256 over the sorted list of `<relative path>:<sha256(content)>` for every
 * .json / .yaml file under scenarios/ (README excluded). Pinned in the
 * ReleaseManifest as `evaluationCorpusDigest` (OPS-06).
 */
export function corpusDigest(root = REPO_ROOT): CorpusDigest {
  const scenariosDir = repoPaths(root).scenarios;
  const files = walkFiles(scenariosDir, (f) => /\.(json|ya?ml)$/.test(f))
    .map((f) => ({ path: posixRelative(root, f), sha256: sha256Hex(readFileSync(f)) }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { digest: sha256Hex(files.map((f) => `${f.path}:${f.sha256}`).join("\n")), files };
}

/** Corpus coverage summary used by tests, the release manifest and the README. */
export function corpusStats(corpus: LoadedCorpus) {
  const routine = corpus.entries.filter((e) => e.kind === "routine").map((e) => e.scenario);
  const risk = corpus.entries.filter((e) => e.kind === "risk_draft");
  const reviewed = (xs: ScenarioDefinition[]) => xs.filter((s) => s.review.status === "HUMAN_REVIEWED").length;
  return {
    routineScenarios: routine.length,
    routineIntents: new Set(routine.map((s) => s.intent)).size,
    routineHumanReviewed: reviewed(routine),
    heldout: routine.filter((s) => s.split === "heldout_acceptance").length,
    variantFamilies: new Set(routine.map((s) => s.variantFamily)).size,
    audiences: [...new Set(routine.map((s) => s.audience ?? "unidentified"))].sort(),
    journeys: corpus.entries.filter((e) => e.kind === "journey").length,
    faultedJourneys: corpus.entries.filter((e) => e.kind === "journey_faulted").length,
    riskDrafts: risk.length,
    riskHumanReviewed: reviewed(risk.map((e) => e.scenario)),
    riskBorderline: risk.filter((e) => e.borderline).length,
    faultPlans: corpus.faultPlans.size,
  };
}
