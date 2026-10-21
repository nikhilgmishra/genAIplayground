/**
 * Corpus splits at family level (follow-on prompt section 17: "Maintain development, tuning, held-out
 * acceptance and regression corpora, with lineage and splits at scenario family/account/conversation level
 * to prevent leakage"; FO-17-16, FO-17-17).
 *
 * Family key: the intent skeleton plus the synthetic account the caller is (`<intent>:<account>`, the format
 * of DatasetItem.familyKey in protocol/review.ts). Every scenario of one intent skeleton (all eight variant
 * families, the journeys and faulted journeys of that intent and every risk draft of that intent, whatever
 * its account) lands in one split, so no (intent, account) family and no intent skeleton straddles two
 * splits; repetitions of a scenario (the conversation level) always share its split. Accounts themselves
 * are shared across intents by construction (the synthetic world has a handful of people); the leakage
 * check reports that separately and it is not a family leak.
 *
 * Assignment (split scheme version `family-split.v2`):
 *  - an intent that has a demonstration journey is `regression` (the journeys are inspected on every change
 *    and run as the regression suite, so neither they nor any variant of their intents can be acceptance
 *    evidence);
 *  - otherwise a stable hash of the intent: ~20 percent `heldout_acceptance`, ~10 percent `tuning`, the rest
 *    `development`.
 * The hash depends only on the intent, so adding, removing or reordering scenarios never moves another
 * family. The previous scenario-level split (`stableSplitV1`, version `scenario-split.v1`) is kept so the
 * lineage manifest records where each scenario was before the family split (corpus-manifests.ts).
 */
import type { CorpusSplit, ScenarioDefinition } from "../protocol/index.js";
import { sha256Hex } from "../shared/canonical.js";
import { personaFor } from "./driver/personas.js";

export const SPLIT_SCHEME_VERSION = "family-split.v2";
/** Target held-out fraction of non-regression families, in permille (~20 percent). */
export const HELDOUT_PERMILLE = 200;
/** Target tuning fraction of non-regression families, in permille (~10 percent). */
export const TUNING_PERMILLE = 100;
const SALT = "vsp-corpus-split.v2:";
const SALT_V1 = "vsp-corpus-split.v1:";

/** Previous scenario-id split (scenario-split.v1): kept for lineage only; never used to assign a split. */
export function stableSplitV1(scenarioId: string): CorpusSplit {
  const bucket = Number.parseInt(sha256Hex(SALT_V1 + scenarioId).slice(0, 8), 16) % 1000;
  return bucket < HELDOUT_PERMILLE ? "heldout_acceptance" : "development";
}

/** Synthetic account of a scenario's caller (the fixture person, or the unregistered role when there is none). */
export function accountKeyOf(s: Pick<ScenarioDefinition, "audience" | "intent" | "initialState">): string {
  const p = personaFor(s);
  return p.personKey ?? `unregistered_${s.audience ?? "unidentified"}`;
}

/** Family key `<intent>:<account>` (DatasetItem.familyKey format). */
export const familyKeyOf = (s: Pick<ScenarioDefinition, "audience" | "intent" | "initialState">): string => `${s.intent}:${accountKeyOf(s)}`;

/**
 * Split of an intent skeleton family. `regressionIntents` are the intents with a demonstration journey
 * (journeys.ts JOURNEY_INTENTS); they are always `regression`.
 */
export function familySplit(intent: string, regressionIntents: ReadonlySet<string>): CorpusSplit {
  if (regressionIntents.has(intent)) return "regression";
  const bucket = Number.parseInt(sha256Hex(SALT + intent).slice(0, 8), 16) % 1000;
  if (bucket < HELDOUT_PERMILLE) return "heldout_acceptance";
  if (bucket < HELDOUT_PERMILLE + TUNING_PERMILLE) return "tuning";
  return "development";
}

export interface LeakageReport {
  splitSchemeVersion: typeof SPLIT_SCHEME_VERSION;
  families: number;
  intents: number;
  /** (intent, account) families present in more than one split: must be empty. */
  leakedFamilies: { familyKey: string; splits: CorpusSplit[] }[];
  /** Intent skeletons present in more than one split: must be empty. */
  leakedIntents: { intent: string; splits: CorpusSplit[] }[];
  /** Scenarios whose split is not the one their family assignment gives: must be empty. */
  misassigned: { scenarioId: string; split: CorpusSplit; expected: CorpusSplit }[];
  /** Informational: synthetic accounts that appear in several splits through different intents (not a family leak). */
  accountsAcrossSplits: { account: string; splits: CorpusSplit[] }[];
  scenariosPerSplit: Record<CorpusSplit, number>;
}

/** Leakage check across the development, tuning, held-out and regression corpora (FO-17-17). */
export function leakageReport(scenarios: readonly ScenarioDefinition[], regressionIntents: ReadonlySet<string>): LeakageReport {
  const byFamily = new Map<string, Set<CorpusSplit>>();
  const byIntent = new Map<string, Set<CorpusSplit>>();
  const byAccount = new Map<string, Set<CorpusSplit>>();
  const perSplit: Record<CorpusSplit, number> = { development: 0, tuning: 0, heldout_acceptance: 0, regression: 0 };
  const misassigned: LeakageReport["misassigned"] = [];
  const add = (m: Map<string, Set<CorpusSplit>>, k: string, v: CorpusSplit) => m.set(k, (m.get(k) ?? new Set()).add(v));
  for (const s of scenarios) {
    add(byFamily, familyKeyOf(s), s.split);
    add(byIntent, s.intent, s.split);
    add(byAccount, accountKeyOf(s), s.split);
    perSplit[s.split] += 1;
    const expected = familySplit(s.intent, regressionIntents);
    if (expected !== s.split) misassigned.push({ scenarioId: s.scenarioId, split: s.split, expected });
  }
  const multi = (m: Map<string, Set<CorpusSplit>>) =>
    [...m.entries()]
      .filter(([, v]) => v.size > 1)
      .map(([k, v]) => [k, [...v].sort()] as const)
      .sort(([a], [b]) => (a < b ? -1 : 1));
  return {
    splitSchemeVersion: SPLIT_SCHEME_VERSION,
    families: byFamily.size,
    intents: byIntent.size,
    leakedFamilies: multi(byFamily).map(([familyKey, splits]) => ({ familyKey, splits })),
    leakedIntents: multi(byIntent).map(([intent, splits]) => ({ intent, splits })),
    misassigned,
    accountsAcrossSplits: multi(byAccount).map(([account, splits]) => ({ account, splits })),
    scenariosPerSplit: perSplit,
  };
}

export const hasLeakage = (r: LeakageReport): boolean => r.leakedFamilies.length + r.leakedIntents.length + r.misassigned.length > 0;
