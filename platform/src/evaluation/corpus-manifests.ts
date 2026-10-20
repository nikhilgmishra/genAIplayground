/**
 * Generated corpus manifests (FO-17-14, FO-17-16, FO-17-17), written by `scenarios:gen` and checked for drift
 * by `scenarios:check` together with the leakage check and the corpus guard (corpus-guard.ts):
 *
 *   scenarios/manifests/lineage.json             per scenario: split, family key, source, generator version,
 *                                                parent, the split it had before the family split and every
 *                                                reason it is not independent acceptance evidence
 *   scenarios/manifests/required-scenarios.json  per gate (environment): the fixed required denominator,
 *                                                every scenario id and version with its repetitions
 *
 * Both are pure functions of the generator inputs (skeletons, journeys, risk templates, fault plans), so the
 * same inputs always give byte-identical files.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { CorpusSplit, Environment } from "../protocol/index.js";
import type { ScenarioDefinition } from "../protocol/index.js";
import { canonicalJson, sha256Hex } from "../shared/canonical.js";
import { GENERATOR_ID } from "./generate.js";
import type { PlannedFile } from "./generate.js";
import { FAULTED_JOURNEYS, JOURNEYS, JOURNEY_INTENTS } from "./journeys.js";
import { SPLIT_SCHEME_VERSION, accountKeyOf, familyKeyOf, familySplit, leakageReport, stableSplitV1 } from "./split.js";
import type { LeakageReport } from "./split.js";

export const LINEAGE_PATH = "scenarios/manifests/lineage.json";
export const REQUIRED_PATH = "scenarios/manifests/required-scenarios.json";
export const RISK_GENERATOR_ID = "platform/src/evaluation/generate-risk.ts@2";

export type ScenarioSourceKind = "skeleton" | "journey" | "journey_faulted" | "risk_template";

/**
 * Why a scenario is not independent acceptance evidence (FO-17-16, FO-17-17). A held-out result is acceptance
 * evidence only if nothing of its family informed the system or the expectation it is scored against:
 *  - NOT_HELDOUT             it is not in heldout_acceptance now;
 *  - MOVED_INTO_HELDOUT      it was a development scenario under the previous split (scenario-split.v1), so its
 *                            own results were inspected while the coordinator and the corpus were fixed;
 *  - INTENT_FAMILY_EXPOSED   a scenario of its intent skeleton (itself or another) was outside the held-out split
 *                            under the previous split (journeys were always development): the family was tuned on
 *                            even if this variant was not (the family-level leakage the family split now prevents);
 *  - REVISED_AFTER_RUNS      its expectation or script was revised (version > 1); every revision so far was made
 *                            in a fix wave after corpus runs had been inspected.
 */
export const INDEPENDENCE_BLOCKERS = ["NOT_HELDOUT", "MOVED_INTO_HELDOUT", "INTENT_FAMILY_EXPOSED", "REVISED_AFTER_RUNS"] as const;
export const IndependenceBlocker = z.enum(INDEPENDENCE_BLOCKERS);
export type IndependenceBlocker = z.infer<typeof IndependenceBlocker>;

export interface CorpusMember {
  scenario: ScenarioDefinition;
  source: ScenarioSourceKind;
  /** Skeleton file, journey id or risk family the scenario was generated from. */
  sourceRef: string;
}

export const LineageEntry = z.strictObject({
  scenarioId: z.string().max(96),
  version: z.number().int().min(1),
  split: CorpusSplit,
  /** Split under the previous scenario-id split (scenario-split.v1); journeys were always development. */
  previousSplit: CorpusSplit,
  familyKey: z.string().regex(/^[a-z0-9][a-z0-9_.:-]{2,128}$/),
  intent: z.string(),
  account: z.string(),
  source: z.enum(["skeleton", "journey", "journey_faulted", "risk_template"]),
  sourceRef: z.string().max(160),
  generator: z.string().max(80),
  /** Scenario this one derives from (a faulted journey's base journey), or null. */
  parent: z.string().max(96).nullable(),
  /** Every reason the scenario cannot be independent acceptance evidence (INDEPENDENCE_BLOCKERS); empty when it can. */
  independenceBlockers: z.array(IndependenceBlocker).max(4),
  /** True only when `independenceBlockers` is empty. */
  acceptanceIndependent: z.boolean(),
});
export type LineageEntry = z.infer<typeof LineageEntry>;

export const CorpusLineage = z.strictObject({
  lineageVersion: z.literal("corpus-lineage.v2"),
  splitSchemeVersion: z.literal(SPLIT_SCHEME_VERSION),
  generators: z.strictObject({ routine: z.literal(GENERATOR_ID), risk: z.literal(RISK_GENERATOR_ID) }),
  splits: z.record(CorpusSplit, z.strictObject({ scenarios: z.number().int(), families: z.number().int(), intents: z.number().int() })),
  leakage: z.strictObject({ leakedFamilies: z.number().int(), leakedIntents: z.number().int(), misassigned: z.number().int(), accountsAcrossSplits: z.number().int() }),
  movedIntoHeldout: z.number().int(),
  /** Held-out scenarios, how many are independent acceptance evidence and how often each blocker applies to them. */
  heldoutIndependence: z.strictObject({
    heldout: z.number().int(),
    acceptanceIndependent: z.number().int(),
    blockers: z.strictObject({ MOVED_INTO_HELDOUT: z.number().int(), INTENT_FAMILY_EXPOSED: z.number().int(), REVISED_AFTER_RUNS: z.number().int() }),
  }),
  scenarios: z.array(LineageEntry),
});
export type CorpusLineage = z.infer<typeof CorpusLineage>;

/** A required scenario as `<scenarioId>@<version>x<repetitions>` (compact: the gate lists are long). */
export const RequiredScenarioRef = z.string().regex(/^scn_[a-z0-9_]{3,80}@[1-9][0-9]*x[1-9][0-9]*$/);
export interface RequiredScenario {
  scenarioId: string;
  version: number;
  repetitions: number;
}
export function parseRequiredRef(ref: string): RequiredScenario {
  const m = /^(scn_[a-z0-9_]{3,80})@([1-9][0-9]*)x([1-9][0-9]*)$/.exec(ref);
  if (!m) throw new Error(`REQUIRED_REF_INVALID: ${ref}`);
  return { scenarioId: m[1] as string, version: Number(m[2]), repetitions: Number(m[3]) };
}
export const requiredRef = (r: RequiredScenario): string => `${r.scenarioId}@${r.version}x${r.repetitions}`;

export const RequiredManifests = z.strictObject({
  manifestVersion: z.literal("required-scenarios.v1"),
  /** sha256 over the sorted `<id>@<version>x<repetitions>` lines of every gate. */
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  gates: z.record(
    Environment,
    z.strictObject({
      rule: z.string().max(300),
      scenarios: z.number().int(),
      requiredRuns: z.number().int(),
      required: z.array(RequiredScenarioRef),
    }),
  ),
});
export type RequiredManifests = z.infer<typeof RequiredManifests>;

/** Which scenarios each gate requires (fixed denominator). */
export const GATE_RULES: Readonly<Record<Environment, { rule: string; includes: (s: ScenarioDefinition) => boolean }>> = {
  local: { rule: "every scenario of the corpus (all four splits, journeys, faulted journeys and risk drafts) at its declared repetitions", includes: () => true },
  ci: { rule: "the regression split (journeys, faulted journeys and every scenario of a journey intent) at its declared repetitions", includes: (s) => s.split === "regression" },
  sandbox: { rule: "every scenario of the corpus at its declared repetitions; eligible only with sandbox execution modes and human review", includes: () => true },
  staging: { rule: "every scenario of the corpus at its declared repetitions; eligible only with sandbox execution modes and human review", includes: () => true },
  production: { rule: "every scenario of the corpus at its declared repetitions; eligible only with pilot execution modes, human review and the reviewed-risk minimum", includes: () => true },
};

const sortById = <T extends { scenarioId: string }>(xs: readonly T[]): T[] => [...xs].sort((a, b) => (a.scenarioId < b.scenarioId ? -1 : a.scenarioId > b.scenarioId ? 1 : 0));

export function buildRequiredManifests(scenarios: readonly ScenarioDefinition[]): RequiredManifests {
  const gates = Object.fromEntries(
    (Object.keys(GATE_RULES) as Environment[]).map((env) => {
      const required = sortById(scenarios.filter(GATE_RULES[env].includes)).map((s) => ({ scenarioId: s.scenarioId, version: s.version, repetitions: s.repetitions }));
      return [env, { rule: GATE_RULES[env].rule, scenarios: required.length, requiredRuns: required.reduce((n, r) => n + r.repetitions, 0), required: required.map(requiredRef) }];
    }),
  ) as RequiredManifests["gates"];
  const lines = (Object.keys(gates) as Environment[]).sort().flatMap((env) => gates[env].required.map((r) => `${env}:${r}`));
  return RequiredManifests.parse({ manifestVersion: "required-scenarios.v1", digest: sha256Hex(lines.join("\n")), gates });
}

export function buildLineage(members: readonly CorpusMember[]): { lineage: CorpusLineage; leakage: LeakageReport } {
  const scenarios = members.map((m) => m.scenario);
  const leakage = leakageReport(scenarios, JOURNEY_INTENTS);
  const journeyBase = new Map(FAULTED_JOURNEYS.map((f) => [f.scenarioId, JOURNEYS.find((j) => f.scenarioId.startsWith(`${j.scenarioId}__`))?.scenarioId ?? null]));
  const previousSplitOf = (m: CorpusMember): CorpusSplit => (m.source === "journey" || m.source === "journey_faulted" ? "development" : stableSplitV1(m.scenario.scenarioId));
  // Intent skeletons with at least one member outside the held-out split under the previous split.
  const exposedIntents = new Set(members.filter((m) => previousSplitOf(m) !== "heldout_acceptance").map((m) => m.scenario.intent));
  const entries = sortById(members.map((m) => ({ ...m, scenarioId: m.scenario.scenarioId }))).map((m): LineageEntry => {
    const s = m.scenario;
    const previousSplit = previousSplitOf(m);
    const independenceBlockers: IndependenceBlocker[] = [
      ...(s.split !== "heldout_acceptance" ? (["NOT_HELDOUT"] as const) : []),
      ...(previousSplit !== "heldout_acceptance" ? (["MOVED_INTO_HELDOUT"] as const) : []),
      ...(exposedIntents.has(s.intent) ? (["INTENT_FAMILY_EXPOSED"] as const) : []),
      ...(s.version > 1 ? (["REVISED_AFTER_RUNS"] as const) : []),
    ];
    return {
      scenarioId: s.scenarioId,
      version: s.version,
      split: s.split,
      previousSplit,
      familyKey: familyKeyOf(s),
      intent: s.intent,
      account: accountKeyOf(s),
      source: m.source,
      sourceRef: m.sourceRef,
      generator: m.source === "risk_template" ? RISK_GENERATOR_ID : GENERATOR_ID,
      parent: m.source === "journey_faulted" ? (journeyBase.get(s.scenarioId) ?? null) : null,
      independenceBlockers,
      acceptanceIndependent: independenceBlockers.length === 0,
    };
  });
  const splits = Object.fromEntries(
    CorpusSplit.options.map((sp) => {
      const inSplit = entries.filter((e) => e.split === sp);
      return [sp, { scenarios: inSplit.length, families: new Set(inSplit.map((e) => e.familyKey)).size, intents: new Set(inSplit.map((e) => e.intent)).size }];
    }),
  ) as CorpusLineage["splits"];
  const lineage = CorpusLineage.parse({
    lineageVersion: "corpus-lineage.v2",
    splitSchemeVersion: SPLIT_SCHEME_VERSION,
    generators: { routine: GENERATOR_ID, risk: RISK_GENERATOR_ID },
    splits,
    leakage: {
      leakedFamilies: leakage.leakedFamilies.length,
      leakedIntents: leakage.leakedIntents.length,
      misassigned: leakage.misassigned.length,
      accountsAcrossSplits: leakage.accountsAcrossSplits.length,
    },
    movedIntoHeldout: entries.filter((e) => e.split === "heldout_acceptance" && e.previousSplit !== "heldout_acceptance").length,
    heldoutIndependence: heldoutIndependenceOf(entries),
    scenarios: entries,
  });
  return { lineage, leakage };
}

/**
 * Pretty JSON whose long arrays keep one element per line (the manifests and the lock list every scenario;
 * one line per scenario keeps them reviewable in a diff).
 */
export function compactJson(v: unknown, indent = ""): string {
  const next = `${indent}  `;
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    return `[\n${v.map((x) => `${next}${JSON.stringify(x)}`).join(",\n")}\n${indent}]`;
  }
  if (v !== null && typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    const flat = (x: unknown) => x === null || typeof x !== "object" || (Array.isArray(x) && x.every((y) => y === null || typeof y !== "object"));
    const leaf = entries.every(([, x]) => flat(x));
    if (leaf && indent.length >= 4) return JSON.stringify(v);
    return `{\n${entries.map(([k, x]) => `${next}${JSON.stringify(k)}: ${compactJson(x, next)}`).join(",\n")}\n${indent}}`;
  }
  return JSON.stringify(v);
}

const json = (v: unknown) => `${compactJson(v)}\n`;

/** Planned manifest files for the whole corpus (routine, journeys, faulted journeys, risk drafts). */
export function planManifestFiles(members: readonly CorpusMember[]): { files: PlannedFile[]; leakage: LeakageReport; required: RequiredManifests } {
  const { lineage, leakage } = buildLineage(members);
  const required = buildRequiredManifests(members.map((m) => m.scenario));
  return { files: [{ path: LINEAGE_PATH, content: json(lineage) }, { path: REQUIRED_PATH, content: json(required) }], leakage, required };
}

/** Loads the committed required-scenario manifests (scenarios/manifests/required-scenarios.json). */
export function loadRequiredManifests(root: string): RequiredManifests {
  return RequiredManifests.parse(JSON.parse(readFileSync(join(root, REQUIRED_PATH), "utf8")));
}

/** Held-out independence counts over lineage entries (the lineage manifest and the combined run summary use it). */
export function heldoutIndependenceOf(entries: readonly LineageEntry[]): CorpusLineage["heldoutIndependence"] {
  const held = entries.filter((e) => e.split === "heldout_acceptance");
  const count = (b: IndependenceBlocker) => held.filter((e) => e.independenceBlockers.includes(b)).length;
  return {
    heldout: held.length,
    acceptanceIndependent: held.filter((e) => e.acceptanceIndependent).length,
    blockers: { MOVED_INTO_HELDOUT: count("MOVED_INTO_HELDOUT"), INTENT_FAMILY_EXPOSED: count("INTENT_FAMILY_EXPOSED"), REVISED_AFTER_RUNS: count("REVISED_AFTER_RUNS") },
  };
}

/** Loads the committed lineage manifest. */
export function loadLineage(root: string): CorpusLineage {
  return CorpusLineage.parse(JSON.parse(readFileSync(join(root, LINEAGE_PATH), "utf8")));
}

/** Canonical digest of a scenario's expectations (corpus-guard.ts uses it to detect relabelled expectations). */
export const expectationDigest = (s: ScenarioDefinition): string =>
  sha256Hex(
    canonicalJson({
      expectedAssurance: s.expectedAssurance,
      permittedRecords: [...s.permittedRecords].sort(),
      expectedToolSequence: s.expectedToolSequence,
      prohibitedActions: [...s.prohibitedActions].sort(),
      requiredHandoff: s.requiredHandoff,
      expectedFinalState: s.expectedFinalState,
      faults: s.initialState.faults,
      repetitions: s.repetitions,
      riskClass: s.riskClass,
    }),
  );

export { familySplit };
