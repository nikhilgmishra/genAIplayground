/**
 * Intent skeletons (scenarios/skeletons/*.yaml): one reviewed skeleton per
 * support intent from which the deterministic generator derives the eight
 * variant families (spec section 16: "Generate matching persona variants from
 * one skeleton"). Skeletons are hand-authored, synthetic and UNREVIEWED until a
 * QA / language lead records a review (PRQ-012).
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { Assurance, Outcome, RiskClass, Role, ScenarioDefinition, VariantFamily } from "../protocol/index.js";
import { walkFiles } from "./paths.js";
import { ACTION_TOKEN, FIXTURE_SET_NAMES, SYSTEM_EVENT_NAMES } from "./vocabulary.js";

const SystemEventName = z.enum(SYSTEM_EVENT_NAMES as [string, ...string[]]);

/** Compact script turn: either a caller utterance or a deterministic system event. */
export const SkeletonTurn = z.union([
  z.strictObject({
    caller: z.string().min(1).max(600),
    asr: z.number().min(0).max(1).optional(),
  }),
  z.strictObject({
    event: SystemEventName,
    /** Optional detail appended to the event text, e.g. an Auth Gate value under test. */
    detail: z.string().max(120).optional(),
    dtmf: z.string().regex(/^[0-9*#]{1,12}$/).optional(),
  }),
]);
export type SkeletonTurn = z.infer<typeof SkeletonTurn>;

const ToolName = z.string().regex(/^[a-z_]+$/);
const ActionToken = z.string().regex(ACTION_TOKEN, "prohibited action must be <namespace>:<name>");
const FaultName = z.string().regex(/^[A-Z_]{3,64}$/);
const AudienceToken = z.union([Role, z.literal("unidentified")]);

const ExpectedFinalState = ScenarioDefinition.shape.expectedFinalState;
const PartialFinalState = z.strictObject({
  outcome: Outcome.optional(),
  committedActions: z.array(z.string()).max(8).optional(),
  supportRequestCreated: z.boolean().nullable().optional(),
  disclosedProtectedFields: z.boolean().optional(),
});

export const VariantOverride = z.strictObject({
  script: z.array(SkeletonTurn).min(1).max(40).optional(),
  persona: z.string().max(300).nullable().optional(),
  audience: AudienceToken.optional(),
  locale: z.string().regex(/^[a-z]{2}-[A-Z]{2}$/).optional(),
  channel: ScenarioDefinition.shape.channel.optional(),
  fixtureSet: z.enum(FIXTURE_SET_NAMES as [string, ...string[]]).optional(),
  faults: z.array(FaultName).max(8).optional(),
  expectedAssurance: Assurance.optional(),
  expectedToolSequence: z.array(ToolName).max(20).optional(),
  prohibitedActions: z.array(ActionToken).max(20).optional(),
  addProhibitedActions: z.array(ActionToken).max(20).optional(),
  requiredHandoff: ScenarioDefinition.shape.requiredHandoff.optional(),
  expectedFinalState: PartialFinalState.optional(),
  stopCondition: ScenarioDefinition.shape.stopCondition.optional(),
  riskClass: RiskClass.optional(),
  repetitions: z.number().int().min(1).max(50).optional(),
  /** Index into the final script of the adversarial turn (overrides the default placement). */
  adversarialTurn: z.number().int().min(0).nullable().optional(),
});
export type VariantOverride = z.infer<typeof VariantOverride>;

export const IntentSkeleton = z.strictObject({
  skeletonVersion: z.number().int().min(1),
  intent: z.string().regex(/^[a-z_]{3,64}$/),
  title: z.string().min(5).max(120),
  audiences: z.array(AudienceToken).min(1).max(7),
  riskClass: RiskClass,
  locale: z.string().regex(/^[a-z]{2}-[A-Z]{2}$/).default("en-US"),
  fixtureSet: z.enum(FIXTURE_SET_NAMES as [string, ...string[]]).default("synthetic_world_v1"),
  permittedRecords: z.array(z.string().max(80)).max(16),
  expectedAssurance: Assurance,
  persona: z.string().min(5).max(220),
  expectedToolSequence: z.array(ToolName).max(20),
  prohibitedActions: z.array(ActionToken).max(16),
  requiredHandoff: ScenarioDefinition.shape.requiredHandoff,
  expectedFinalState: ExpectedFinalState,
  stopCondition: ScenarioDefinition.shape.stopCondition,
  repetitions: z.number().int().min(1).max(50).optional(),
  script: z.array(SkeletonTurn).min(1).max(30),
  /** Indirect / ambiguous phrasing: replaces the first caller turn; extra entries are inserted after it. */
  indirect: z.array(z.string().min(3).max(600)).min(1).max(4),
  /** Adversarial caller instruction used by the malicious_instruction family (a default is used when absent). */
  malicious: z.string().min(5).max(600).optional(),
  /** Expectations when the intent's primary dependency fails (required: no generic default is safe). */
  dependencyFailure: z.strictObject({
    fault: FaultName,
    expectedToolSequence: z.array(ToolName).max(20),
    requiredHandoff: ScenarioDefinition.shape.requiredHandoff,
    expectedFinalState: ExpectedFinalState,
    stopCondition: ScenarioDefinition.shape.stopCondition.optional(),
  }),
  variants: z.partialRecord(VariantFamily, VariantOverride).default({}),
  /** Requirement ids this skeleton exercises (traceability hints). */
  requirementIds: z.array(z.string().max(40)).max(12).default([]),
  /** Edge populations / spec section 14 coverage labels. */
  edgePopulations: z.array(z.string().regex(/^[a-z_]{3,40}$/)).max(8).default([]),
  notes: z.string().max(800).nullable().default(null),
});
export type IntentSkeleton = z.infer<typeof IntentSkeleton>;

export class SkeletonError extends Error {
  constructor(
    readonly file: string,
    readonly reasonCode: string,
    readonly detail = "",
  ) {
    super(`${reasonCode}: ${file}${detail ? ` (${detail})` : ""}`);
  }
}

/** Loads every skeleton YAML under `dir`, strictly validated; file name must be `<intent>.yaml`. */
export function loadSkeletons(dir: string): IntentSkeleton[] {
  const out: IntentSkeleton[] = [];
  const seen = new Set<string>();
  for (const file of walkFiles(dir, (p) => p.endsWith(".yaml") || p.endsWith(".yml"))) {
    let raw: unknown;
    try {
      raw = parseYaml(readFileSync(file, "utf8"));
    } catch {
      throw new SkeletonError(basename(file), "SKELETON_UNPARSEABLE");
    }
    const parsed = IntentSkeleton.safeParse(raw);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new SkeletonError(basename(file), "SKELETON_INVALID", first ? `${first.path.join(".")}: ${first.message}` : "");
    }
    const s = parsed.data;
    if (basename(file).replace(/\.ya?ml$/, "") !== s.intent) throw new SkeletonError(basename(file), "SKELETON_FILENAME_MISMATCH");
    if (seen.has(s.intent)) throw new SkeletonError(basename(file), "SKELETON_DUPLICATE_INTENT");
    if (!s.script.some((t) => "caller" in t)) throw new SkeletonError(basename(file), "SKELETON_NO_CALLER_TURN");
    seen.add(s.intent);
    out.push(s);
  }
  return out.sort((a, b) => a.intent.localeCompare(b.intent));
}
