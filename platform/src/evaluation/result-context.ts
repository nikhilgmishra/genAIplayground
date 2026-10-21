/**
 * Result context and run lineage (follow-on prompt section 17 "EvaluationResult records scenario/run/seed/
 * split, expected scope and initial world, all version digests, requested/reached fault, observed tools,
 * deterministic checks, actual final source state, audio evidence, privacy/safety/auth results, human/judge
 * labels and disagreements, latency, cost, outcome, reviewer, errors and evidence refs. Use append-only
 * results and reproducible rerun commands"; FO-17-12, FO-17-44, FO-17-45).
 *
 * The EvaluationResult contract (platform/src/protocol/evaluation.ts, owned by WP-02 and then WP-34) has no
 * field yet for the initial-world digest, the observed tool list, the errors of a run or the full list of
 * requested faults. Until the contract owner adds them (recorded as an open issue of WP-01), the runner
 * writes them for every result into `result-context.jsonl` next to `results.jsonl`, keyed by
 * scenario id and repetition, strictly validated by `ResultContext`. Nothing here changes a verdict.
 *
 * Run lineage (`run.json`): every run records the runs it reruns (`rerunOf`) or supersedes (`supersedes`)
 * with a reason code, so an original failing result and its corrected rerun are both kept and linked
 * (FO-17-12). Run directories are created exclusively and never rewritten (results.ts).
 */
import { z } from "zod";
import { CorpusSplit, EvidencePointer } from "../protocol/index.js";
import type { ScenarioDefinition } from "../protocol/index.js";
import {
  APPOINTMENTS,
  CALLS,
  CLAIMS,
  DELEGATIONS,
  DESTINATIONS,
  INVOICES,
  ONBOARDING,
  ORGANIZATIONS,
  PEOPLE,
  REMITTANCES,
  SLOTS,
  STAFF,
  TREATING_RELATIONSHIPS,
} from "../fixtures/synthetic-world.js";
import { canonicalJson, sha256Hex } from "../shared/canonical.js";
import type { FaultPlan } from "./fault-plan.js";
import type { ReachObservation } from "./fault-reach.js";

export const RESULT_CONTEXT_VERSION = "evaluation-result-context.v1";
export const RUN_LINEAGE_VERSION = "evaluation-run-lineage.v1";

const RunId = z.string().regex(/^run_[A-Za-z0-9_-]{8,64}$/);
const ReasonCode = z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/);
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * Digest of the synthetic world every local scenario starts from (platform/src/fixtures/synthetic-world.ts
 * data exports; the local OIDC key material is excluded). A change of the world changes every initial-world
 * digest, so results before and after it are never compared as if they ran on the same world.
 */
export const SYNTHETIC_WORLD_DIGEST = sha256Hex(
  canonicalJson({ PEOPLE, ORGANIZATIONS, DELEGATIONS, TREATING_RELATIONSHIPS, APPOINTMENTS, SLOTS, INVOICES, CLAIMS, ONBOARDING, REMITTANCES, DESTINATIONS, STAFF, CALLS }),
);

/** Initial world of one scenario: fixture set, the requested faults at their plan versions and the world digest. */
export function initialWorldOf(s: ScenarioDefinition, plans: ReadonlyMap<string, FaultPlan>): { fixtureSet: string; faults: string[]; worldDigest: string; digest: string } {
  const faults = s.initialState.faults.map((f) => `${f}@v${plans.get(f)?.version ?? "MISSING"}`);
  const worldDigest = SYNTHETIC_WORLD_DIGEST;
  return { fixtureSet: s.initialState.fixtureSet, faults, worldDigest, digest: sha256Hex(canonicalJson({ fixtureSet: s.initialState.fixtureSet, faults, worldDigest })) };
}

export const ResultContext = z.strictObject({
  contextVersion: z.literal(RESULT_CONTEXT_VERSION),
  runId: RunId,
  scenarioId: z.string().max(96),
  scenarioVersion: z.number().int().min(1),
  repetition: z.number().int().min(1),
  split: CorpusSplit,
  seed: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  rerunCommand: z.string().min(3).max(400),
  /** What the scenario permits: assurance tier, permitted records, expected tools, required handoff. */
  expectedScope: z.strictObject({
    expectedAssurance: z.string().max(4),
    permittedRecords: z.array(z.string().max(80)).max(16),
    expectedToolSequence: z.array(z.string().max(64)).max(20),
    requiredHandoff: z.string().max(32),
  }),
  initialWorld: z.strictObject({ fixtureSet: z.string().max(64), faults: z.array(z.string().max(80)).max(8), worldDigest: Sha256, digest: Sha256 }),
  /** Every requested fault with its independent reach observation (the contract holds only the first). */
  faults: z
    .array(
      z.strictObject({
        faultId: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/),
        reached: z.boolean().nullable(),
        observedBy: z.string().max(64).nullable(),
        evidenceRef: EvidencePointer.nullable(),
        detail: z.string().max(400),
      }),
    )
    .max(8),
  /** Tools the backend recorded, in order (`<name>:<status>[:<reasonCode>]`); null when not collected. */
  observedTools: z.array(z.string().max(140)).max(200).nullable(),
  /** Driver errors, injection failures and steps the driver could not exercise. */
  errors: z.array(z.string().max(200)).max(64),
});
export type ResultContext = z.infer<typeof ResultContext>;

export function reachToContext(r: ReachObservation): ResultContext["faults"][number] {
  return { faultId: r.faultId, reached: r.reached, observedBy: r.observedBy, evidenceRef: r.evidenceRef, detail: r.detail.slice(0, 400) };
}

export const RunLineage = z.strictObject({
  lineageVersion: z.literal(RUN_LINEAGE_VERSION),
  runId: RunId,
  createdAt: z.iso.datetime(),
  /** Repository-relative command line that produced this run. */
  command: z.string().min(3).max(1200),
  /** Earlier runs this run reruns (their results stay as they are). */
  rerunOf: z.array(RunId).max(64),
  /** Named aggregates this run supersedes (e.g. corpus-local-20261018w4); they are kept unchanged. */
  supersedes: z.array(z.string().regex(/^[a-z0-9_-]{4,64}$/)).max(16),
  /** Why the rerun exists, e.g. FIX_WAVE_5_RERUN, SCORER_REPAIR, FAULT_REACH_EVIDENCE. Null for a first run. */
  reason: ReasonCode.nullable(),
  sourceCommit: z.string().regex(/^[0-9a-f]{7,40}$/).nullable(),
  /**
   * What the code under test was when it differs from the commit, e.g. a snapshot of the commit with one
   * package's working-tree overlay (`HEAD+overlay:<sha256 of the overlay files>`); null when it is the commit.
   */
  sourceTree: z.string().max(200).regex(/^[A-Za-z0-9 _.:/@+=,()-]*$/).nullable().default(null),
  corpusDigest: Sha256.nullable(),
});
export type RunLineage = z.infer<typeof RunLineage>;

/** Deterministic per-repetition seed: the same run seed, scenario version and repetition always give the same seed. */
export const deriveSeed = (runSeed: string, s: Pick<ScenarioDefinition, "scenarioId" | "version">, repetition: number): string =>
  `sd_${sha256Hex(`${runSeed}|${s.scenarioId}@${s.version}#${repetition}`).slice(0, 32)}`;

/** The exact command that reruns one result (repository-relative, no secrets; matches EvaluationResult.rerunCommand). */
export function rerunCommandFor(runId: string, s: Pick<ScenarioDefinition, "scenarioId" | "version">, repetition: number, seed: string): string {
  return `pnpm evidence rerun --scenario ${s.scenarioId} --version ${s.version} --repetition ${repetition} --seed ${seed} --rerun-of ${runId}`;
}
