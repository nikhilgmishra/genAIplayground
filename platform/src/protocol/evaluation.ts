/**
 * Scenario corpus and evaluation result records (spec sections 14 and 16).
 * Missing evidence is INCONCLUSIVE, never PASS (OPS-03).
 */
import { z } from "zod";
import { Assurance, Environment, EvidencePointer, IsoDateTime, Outcome, Role, VersionSet } from "./common.js";

export const SCENARIO_DEFINITION_SCHEMA_VERSION = "scenario-definition.v1";
export const EVALUATION_RESULT_SCHEMA_VERSION = "evaluation-result.v1";

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

export const CorpusSplit = z.enum(["development", "heldout_acceptance", "tuning", "regression"]);
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

/** Scenario channels, including the follow-on SIP and WebRTC audio modes (Layer 4 and 5). */
export const ScenarioChannel = z.enum(["simulated_text", "simulated_voice", "pstn", "sip_audio", "webrtc_audio"]);
export type ScenarioChannel = z.infer<typeof ScenarioChannel>;

export const ScenarioDefinition = z.strictObject({
  /** Contract version (follow-on envelope); optional so the committed corpus files stay valid. */
  schemaVersion: z.literal(SCENARIO_DEFINITION_SCHEMA_VERSION).optional(),
  scenarioId: z.string().regex(/^scn_[a-z0-9_]{3,80}$/),
  version: z.number().int().min(1),
  split: CorpusSplit,
  intent: z.string().regex(/^[a-z_]{3,64}$/),
  audience: Role.nullable(),
  locale: z.string().regex(/^[a-z]{2}-[A-Z]{2}$/),
  channel: ScenarioChannel,
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
    committedActions: z.array(z.string().max(80)).max(8),
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

const LatencyMs = z.number().min(0).max(3_600_000);

export const Verdict = z.enum(["PASS", "FAIL", "INCONCLUSIVE", "NOT_RUN", "BLOCKED"]);
export type Verdict = z.infer<typeof Verdict>;

export const AssertionResult = z.strictObject({
  assertionId: z.string().regex(/^[a-z0-9_.-]{3,80}$/),
  hardGate: z.boolean(),
  verdict: Verdict,
  detail: z.string().max(400),
});
export type AssertionResult = z.infer<typeof AssertionResult>;

/**
 * How a result was produced (follow-on prompt section 17 layers). `local_fixture` (in-process unit
 * fakes), `local_emulator` (production adapters over real protocols against emulators) and
 * `model_text` / `audio` (real model or audio runs) are all local evidence: none of them can
 * satisfy a sandbox or production gate.
 */
export const ExecutionMode = z.enum(["local_fixture", "local_emulator", "model_text", "audio", "vendor_sandbox", "pstn_sandbox", "production_pilot"]);
export type ExecutionMode = z.infer<typeof ExecutionMode>;

/** Fault id of the fixed fault registry (scenarios/fixtures/failures, FO-17-24.<FAULT_ID>). */
export const FaultId = z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/);

/** Judge label with severity and the human adjudication when one exists. */
export const JudgeLabel = z.strictObject({
  judgeRef: z.string().regex(/^[a-z][a-z0-9_.-]{1,63}@[A-Za-z0-9._-]{1,32}$/),
  label: z.string().regex(/^[a-z][a-z0-9_.]{2,80}$/),
  value: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
  severity: z.enum(["NONE", "MINOR", "MAJOR", "CRITICAL"]),
  /** Human review that agreed or disagreed with the judge; null when no human adjudicated. */
  humanReviewRef: z.string().regex(/^rvw_[A-Za-z0-9_-]{16,64}$/).nullable(),
  humanAgrees: z.boolean().nullable(),
});
export type JudgeLabel = z.infer<typeof JudgeLabel>;

export const EvaluationResult = z.strictObject({
  /** Contract version (follow-on envelope); optional so the committed historical results stay valid. */
  schemaVersion: z.literal(EVALUATION_RESULT_SCHEMA_VERSION).optional(),
  runId: z.string().regex(/^run_[A-Za-z0-9_-]{8,64}$/),
  runAt: IsoDateTime,
  environment: Environment,
  /**
   * Only vendor_sandbox, pstn_sandbox and production_pilot results can satisfy a non-local gate.
   * Restricted to the original four modes: widening it breaks platform/src/evaluation/aggregate.ts.
   * Hand-over: WP-01 adapts evaluation/types.ts and aggregate.ts to the full ExecutionMode; the
   * field itself is widened by the owner of this file after phase B (WP-34, work-packages.yaml).
   */
  executionMode: ExecutionMode.extract(["local_fixture", "vendor_sandbox", "pstn_sandbox", "production_pilot"]),
  scenarioId: z.string().max(96),
  scenarioVersion: z.number().int().min(1).max(1_000_000),
  repetition: z.number().int().min(1),
  corpusSplit: CorpusSplit,
  audience: Role.nullable(),
  language: z.string().max(16),
  channel: z.string().max(32),
  variant: VariantFamily,
  expectedPermissions: z.array(z.string().max(80)).max(32),
  versions: VersionSet,
  vendorInteractionId: z.string().max(128).nullable(),
  vendorSessionId: z.string().max(128).nullable(),
  assertions: z.array(AssertionResult).max(64),
  safetyResult: Verdict,
  privacyResult: Verdict,
  authenticationResult: Verdict,
  transactionResult: Verdict,
  auditEvidenceResult: Verdict,
  committedState: z
    .record(z.string().max(64), z.unknown())
    .refine((r) => Object.keys(r).length <= 64, "too many committed-state keys")
    .meta({ maxProperties: 64 }),
  qualityScores: z
    .record(z.string().max(64), z.number().min(0).max(5).nullable())
    .refine((r) => Object.keys(r).length <= 32, "too many quality scores")
    .meta({ maxProperties: 32 }),
  latencyMs: z.strictObject({ p50: LatencyMs.nullable(), p95: LatencyMs.nullable(), p99: LatencyMs.nullable() }),
  costUsd: z.number().min(0).max(1_000_000_000).nullable(),
  transferOutcome: z.string().max(64).nullable(),
  finalResolution: Outcome.nullable(),
  failureCode: z.string().max(64).nullable(),
  evidenceRef: z.string().max(256).nullable(),
  reviewer: z.string().max(80).nullable(),
  verdict: Verdict,
  /* ---- follow-on fields (prompt section 17); optional until the scorer (WP-01) populates them ---- */
  /** Seed of the stochastic run (simulator, model sampling) so the run can be reproduced. */
  seed: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
  /** Fault the scenario asked for (FO-17-24.<FAULT_ID>); null for a fault-free scenario. */
  requestedFault: FaultId.nullable().optional(),
  /**
   * Fault actually reached, from independent evidence (an audit event, inbox row or emulator log),
   * never from the driver's own report. A fault scenario passes only when this equals requestedFault.
   */
  reachedFault: z
    .strictObject({ faultId: FaultId, evidenceRef: EvidencePointer, observedBy: z.string().regex(/^[a-z][a-z0-9_.-]{2,63}$/) })
    .nullable()
    .optional(),
  /** Exact command that reruns this result (no secrets; repository-relative). */
  rerunCommand: z.string().min(3).max(400).regex(/^[A-Za-z0-9 _./:=@+,-]+$/).optional(),
  judgeLabels: z.array(JudgeLabel).max(32).optional(),
  /** Caller-heard audio, model transcript and independent ASR transcript evidence (restricted). */
  audioEvidenceRefs: z.array(EvidencePointer).max(16).optional(),
  /** Qualification record this result contributes to, when it is part of one. */
  qualificationRef: EvidencePointer.nullable().optional(),
});
export type EvaluationResult = z.infer<typeof EvaluationResult>;

/** Modes whose results can count toward a sandbox or production gate (OPS-03, OPS-04). */
export const NON_LOCAL_EXECUTION_MODES = ["vendor_sandbox", "pstn_sandbox", "production_pilot"] as const satisfies readonly ExecutionMode[];

/** A fault scenario's result is fault-valid only when the requested fault was independently observed. */
export function faultReached(r: Pick<EvaluationResult, "requestedFault" | "reachedFault">): boolean {
  if (r.requestedFault === undefined || r.requestedFault === null) return true;
  return r.reachedFault !== undefined && r.reachedFault !== null && r.reachedFault.faultId === r.requestedFault;
}
