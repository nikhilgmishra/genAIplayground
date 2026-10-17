/**
 * Scenario corpus and evaluation result records (spec sections 14 and 16).
 * Missing evidence is INCONCLUSIVE, never PASS (OPS-03).
 */
import { z } from "zod";
import { Assurance, Environment, IsoDateTime, Outcome, Role, VersionSet } from "./common.js";

export const VariantFamily = z.enum([
  "baseline",
  "frustrated",
  "indirect_or_ambiguous",
  "interrupted_or_noisy",
  "verification_failure",
  "malicious_instruction",
  "dependency_failure",
  "repeat_contact_or_handoff",
]);
export type VariantFamily = z.infer<typeof VariantFamily>;

export const RiskClass = z.enum(["routine", "privacy", "authorization", "clinical_boundary", "safety_routing", "transaction"]);
export type RiskClass = z.infer<typeof RiskClass>;

export const CorpusSplit = z.enum(["development", "heldout_acceptance"]);
export type CorpusSplit = z.infer<typeof CorpusSplit>;

export const ScenarioTurn = z.strictObject({
  speaker: z.enum(["caller", "system_event"]),
  /** Caller utterance (synthetic) or a system event name such as BARGE_IN, SILENCE, CALL_END, DEPENDENCY_OUTAGE. */
  text: z.string().max(600),
  /** Optional DTMF entered through the isolated capture path (never passed to the model). */
  dtmf: z.string().regex(/^[0-9*#]{1,12}$/).nullable(),
  asrConfidence: z.number().min(0).max(1).nullable(),
});
export type ScenarioTurn = z.infer<typeof ScenarioTurn>;

export const ScenarioDefinition = z.strictObject({
  scenarioId: z.string().regex(/^scn_[a-z0-9_]{3,80}$/),
  version: z.number().int().min(1),
  split: CorpusSplit,
  intent: z.string().regex(/^[a-z_]{3,64}$/),
  audience: Role.nullable(),
  locale: z.string().regex(/^[a-z]{2}-[A-Z]{2}$/),
  channel: z.enum(["simulated_text", "simulated_voice", "pstn"]),
  variantFamily: VariantFamily,
  riskClass: RiskClass,
  /** Synthetic fixture identifiers describing the initial world state. */
  initialState: z.strictObject({ fixtureSet: z.string().regex(/^[a-z0-9_]{3,64}$/), faults: z.array(z.string().regex(/^[A-Z_]{3,64}$/)).max(8) }),
  permittedRecords: z.array(z.string().max(80)).max(16),
  expectedAssurance: Assurance,
  script: z.array(ScenarioTurn).min(1).max(40),
  persona: z.string().max(300).nullable(),
  adversarialTurn: z.number().int().min(0).nullable(),
  expectedToolSequence: z.array(z.string().regex(/^[a-z_]+$/)).max(20),
  prohibitedActions: z.array(z.string().regex(/^[a-z_.:]+$/)).max(20),
  requiredHandoff: z.enum(["NONE", "STANDARD_HUMAN", "SAFETY_PRIORITY", "INTERPRETER", "CLINICAL_ROUTE"]),
  expectedFinalState: z.strictObject({
    outcome: Outcome,
    committedActions: z.array(z.string()).max(8),
    supportRequestCreated: z.boolean().nullable(),
    disclosedProtectedFields: z.boolean(),
  }),
  stopCondition: z.enum(["CALL_END", "TRANSFER_CONNECTED", "TURN_LIMIT", "OUTCOME_RECORDED"]),
  review: z.strictObject({
    status: z.enum(["UNREVIEWED", "IN_REVIEW", "HUMAN_REVIEWED"]),
    reviewer: z.string().max(80).nullable(),
    reviewedAt: IsoDateTime.nullable(),
  }),
  /** Number of repetitions per release for nondeterministic cases (>= 5 for selected cases). */
  repetitions: z.number().int().min(1).max(50),
});
export type ScenarioDefinition = z.infer<typeof ScenarioDefinition>;

export const Verdict = z.enum(["PASS", "FAIL", "INCONCLUSIVE", "NOT_RUN", "BLOCKED"]);
export type Verdict = z.infer<typeof Verdict>;

export const AssertionResult = z.strictObject({
  assertionId: z.string().regex(/^[a-z0-9_.-]{3,80}$/),
  hardGate: z.boolean(),
  verdict: Verdict,
  detail: z.string().max(400),
});
export type AssertionResult = z.infer<typeof AssertionResult>;

export const EvaluationResult = z.strictObject({
  runId: z.string().regex(/^run_[A-Za-z0-9_-]{8,64}$/),
  runAt: IsoDateTime,
  environment: Environment,
  /** "local_fixture" results can never satisfy a sandbox or production gate. */
  executionMode: z.enum(["local_fixture", "vendor_sandbox", "pstn_sandbox", "production_pilot"]),
  scenarioId: z.string(),
  scenarioVersion: z.number().int(),
  repetition: z.number().int().min(1),
  corpusSplit: CorpusSplit,
  audience: Role.nullable(),
  language: z.string(),
  channel: z.string(),
  variant: VariantFamily,
  expectedPermissions: z.array(z.string()).max(32),
  versions: VersionSet,
  vendorInteractionId: z.string().max(128).nullable(),
  vendorSessionId: z.string().max(128).nullable(),
  assertions: z.array(AssertionResult).max(64),
  safetyResult: Verdict,
  privacyResult: Verdict,
  authenticationResult: Verdict,
  transactionResult: Verdict,
  auditEvidenceResult: Verdict,
  committedState: z.record(z.string(), z.unknown()),
  qualityScores: z.record(z.string(), z.number().min(0).max(5).nullable()),
  latencyMs: z.strictObject({ p50: z.number().nullable(), p95: z.number().nullable(), p99: z.number().nullable() }),
  costUsd: z.number().min(0).nullable(),
  transferOutcome: z.string().max(64).nullable(),
  finalResolution: Outcome.nullable(),
  failureCode: z.string().max(64).nullable(),
  evidenceRef: z.string().max(256).nullable(),
  reviewer: z.string().max(80).nullable(),
  verdict: Verdict,
});
export type EvaluationResult = z.infer<typeof EvaluationResult>;
