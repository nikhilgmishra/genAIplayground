/**
 * Scenario runner and the ConversationDriver port (spec sections 14 and 16).
 *
 * A ConversationDriver drives one synthetic conversation against some stack
 * and reports what the BACKEND actually recorded. Implementations:
 *  - local stack driver (gateway/integration engineer; kind "local_fixture",
 *    executionMode "local_fixture") — not part of this module;
 *  - vendor sandbox / PSTN drivers — BLOCKED (PRQ-004, PRQ-034, PRQ-043).
 *
 * The runner never decides success. It injects deterministic fault plans,
 * feeds the scripted turns, collects evidence and hands it to the scorer.
 * Driver errors, unparseable evidence, missing fault plans or faults the
 * driver could not inject all yield INCONCLUSIVE, never PASS (OPS-03).
 */
import { z } from "zod";
import {
  Assurance,
  Classification,
  ConsentValue,
  EvaluationResult,
  Outcome,
  ToolStatus,
  VersionSet,
} from "../protocol/index.js";
import type { Environment, ScenarioDefinition, ScenarioTurn } from "../protocol/index.js";
import { systemClock } from "../shared/clock.js";
import type { Clock } from "../shared/clock.js";
import { newId } from "../shared/ids.js";
import { isImmediateTrigger } from "./fault-plan.js";
import type { FaultPlan } from "./fault-plan.js";
import { RESULT_CONTEXT_VERSION, ResultContext, deriveSeed, initialWorldOf, reachToContext, rerunCommandFor } from "./result-context.js";
import { scoreScenarioDetailed } from "./scorer.js";
import type { ScoreContext } from "./scorer.js";
import { EXECUTION_MODES } from "./types.js";
import type { ExecutionMode } from "./types.js";
import { ACTION_TOKEN } from "./vocabulary.js";

const Ref = z.string().min(1).max(128);

export const ToolCallObservation = z.strictObject({
  name: z.string().regex(/^[a-z_]+$/),
  version: z.string().max(32).nullable(),
  status: ToolStatus,
  turnIndex: z.number().int().min(0).nullable(),
  auditEventId: Ref.nullable(),
  /** Session state the gateway resolved server-side for this request. */
  sessionState: z.enum(["valid", "expired", "revoked", "none"]).nullable(),
  reasonCode: z.string().max(64).nullable(),
});
export type ToolCallObservation = z.infer<typeof ToolCallObservation>;

export const CommittedActionObservation = z.strictObject({
  actionKind: z.string().regex(/^[a-z_]+$/),
  actionId: Ref,
  targetRef: Ref.nullable(),
  receiptId: Ref.nullable(),
  auditEventId: Ref.nullable(),
  /** Commit was bound to the digest of the prepared action that was read back (ACT-01). */
  confirmationBound: z.boolean().nullable(),
  /** Confirmation was captured after the latest change / interruption, not a stale earlier yes. */
  confirmationFresh: z.boolean().nullable(),
  /** External effects observed in the AUTHORITATIVE system of record for this action (ACT-02). */
  effectCount: z.number().int().min(0).max(100),
  /** An UNKNOWN outcome was reconciled against authoritative state (ACT-03). */
  reconciled: z.boolean(),
});
export type CommittedActionObservation = z.infer<typeof CommittedActionObservation>;

/**
 * A reconciliation of one ambiguous (UNKNOWN_OUTCOME) consequential tool result against authoritative state
 * (ACT-03, FO-22-07): which call it resolved, what the system of record showed, and the position in the tool-call
 * sequence by which it had completed, so a retry can be judged as made after (or before) the reconciliation.
 */
export const ReconciliationObservation = z.strictObject({
  /** Index in `toolCalls` of the UNKNOWN_OUTCOME call this reconciliation resolved. */
  toolCallIndex: z.number().int().min(0).max(199),
  actionKind: z.string().regex(/^[a-z_]+$/),
  /** The effect exists (FOUND), does not exist (NOT_FOUND), or authoritative state could not tell (STILL_UNKNOWN). */
  outcome: z.enum(["FOUND", "NOT_FOUND", "STILL_UNKNOWN"]),
  /** Index in `toolCalls` of the first call made after the reconciliation completed (`toolCalls.length` when none was). */
  completedBeforeToolCallIndex: z.number().int().min(0).max(200),
  auditEventId: Ref.nullable(),
});
export type ReconciliationObservation = z.infer<typeof ReconciliationObservation>;

export const TransferState = z.enum([
  "REQUESTED",
  "QUEUED",
  "RECEIVER_ACCEPTED",
  "BRIDGED",
  "CALLER_CONFIRMED_CONNECTED",
  "COMPLETED",
  "TIMEOUT",
  "FAILED",
  "DISCONNECTED",
]);

export const TransferObservation = z.strictObject({
  attempted: z.boolean(),
  /** Destination ids in attempt order (trusted configuration ids, never dial strings). */
  destinationIds: z.array(z.string().max(64)).max(8),
  purposes: z.array(z.string().max(40)).max(8),
  states: z.array(TransferState).max(64),
  receiverAccepted: z.boolean(),
  connectionVerified: z.boolean(),
  fallbackInvoked: z.boolean(),
  auditEventId: Ref.nullable(),
});
export type TransferObservation = z.infer<typeof TransferObservation>;

export const SupportRequestObservation = z.strictObject({
  kind: z.enum(["salesforce_case", "internal_pending_sync"]),
  referenceIssued: z.boolean(),
  auditEventId: Ref.nullable(),
});

export const EgressObservation = z.strictObject({
  destination: z.string().max(120),
  classification: Classification,
  allowed: z.boolean(),
});

/**
 * Evidence collected after a call. `null` always means "not collected" and is
 * scored INCONCLUSIVE; an empty array means "collected, none observed".
 */
export const CallEvidence = z.strictObject({
  driverKind: z.enum(["local_fixture", "live"]),
  executionMode: z.enum(EXECUTION_MODES as [ExecutionMode, ...ExecutionMode[]]),
  fixtureSetEstablished: z.boolean(),
  faultsInjected: z.array(z.string().regex(/^[A-Z_]{3,64}$/)).max(8),
  /** Committed state must come from authoritative backend records, never from a transcript or an LLM judge. */
  committedStateSource: z.enum(["authoritative_backend", "transcript_inference", "llm_judge"]).nullable(),
  committedState: z.record(z.string(), z.unknown()).nullable(),
  committedActions: z.array(CommittedActionObservation).max(32).nullable(),
  /**
   * Reconciliations of ambiguous consequential results (authoritative backend records). Absent or null: not
   * collected (a retry after an ambiguous result is then INCONCLUSIVE, never PASS); an empty array: collected, none.
   */
  reconciliations: z.array(ReconciliationObservation).max(32).nullable().optional(),
  auditEventIds: z.array(Ref).max(5000).nullable(),
  toolCalls: z.array(ToolCallObservation).max(200).nullable(),
  transfer: TransferObservation.nullable(),
  supportRequests: z.array(SupportRequestObservation).max(16).nullable(),
  outcome: Outcome.nullable(),
  assurance: Assurance.nullable(),
  disclosedProtectedFields: z.boolean().nullable(),
  /** Observed-action tokens (vocabulary.ts) for speech, disclosure, collection, session and notification behaviour. */
  observedActions: z.array(z.string().regex(ACTION_TOKEN)).max(200).nullable(),
  consent: z
    .strictObject({
      recording: ConsentValue,
      automatedProcessing: ConsentValue,
      recordingStarted: z.boolean(),
      recordingStartedAfterDecline: z.boolean(),
    })
    .nullable(),
  egress: z.array(EgressObservation).max(500).nullable(),
  safety: z
    .strictObject({
      signalDetected: z.boolean(),
      /** Validated safety event to priority-route initiation (engineering target 2 s, spec section 10). */
      routeInitiationMs: z.number().min(0).nullable(),
      verificationRequestedBeforeRoute: z.boolean(),
    })
    .nullable(),
  /** True when the system (not the caller) ended the call. */
  systemTerminatedCall: z.boolean().nullable(),
  latencies: z.strictObject({ turnMs: z.array(z.number().min(0)).max(500) }).nullable(),
  versions: VersionSet.nullable(),
  vendor: z.strictObject({ interactionId: z.string().max(128).nullable(), sessionId: z.string().max(128).nullable() }),
  qualityScores: z.record(z.string().max(40), z.number().min(0).max(5).nullable()),
  /** Quality scores never establish committed state and never offset hard gates. */
  qualityScoreSource: z.enum(["none", "human_reviewer", "calibrated_llm_judge_approved_env"]),
  costUsd: z.number().min(0).nullable(),
  evidenceRef: z.string().max(256).nullable(),
  /** Capabilities or steps the driver could not exercise (each makes the result INCONCLUSIVE). */
  unsupported: z.array(z.string().max(160)).max(32),
});
export type CallEvidence = z.infer<typeof CallEvidence>;

export interface StartCallInput {
  runId: string;
  scenario: ScenarioDefinition;
  repetition: number;
  environment: Environment;
  /**
   * Seed for anything stochastic the driver does (simulated caller, model sampling). A deterministic driver
   * (the LOCAL FIXTURE driver) ignores it; the result still records it so a rerun uses the same value.
   */
  seed?: string;
}

export interface CallHandle {
  readonly callRef: string;
}

export interface TurnAck {
  delivered: boolean;
  reasonCode?: string;
}

export interface FaultAck {
  accepted: boolean;
  reasonCode?: string;
}

export interface ConversationDriver {
  /** Labelled: a local_fixture driver can never claim a vendor or PSTN execution mode. */
  readonly kind: "local_fixture" | "live";
  readonly executionMode: ExecutionMode;
  startCall(input: StartCallInput): Promise<CallHandle>;
  sendTurn(call: CallHandle, turn: ScenarioTurn, index: number): Promise<TurnAck>;
  /**
   * phase "arm": register a trigger the driver fires itself (BEFORE_TOOL, AFTER_TOOL_RESULT,
   * ON_TRANSFER_STATE, AFTER_CALL). phase "now": inject immediately (AT_CALL_START, AT_TURN).
   */
  injectFault(call: CallHandle, plan: FaultPlan, phase: "arm" | "now"): Promise<FaultAck>;
  endCall(call: CallHandle, reason: "SCRIPT_COMPLETE" | "DRIVER_ERROR"): Promise<void>;
  /** Returns raw evidence; the runner validates it against CallEvidence. */
  collectEvidence(call: CallHandle): Promise<unknown>;
}

export interface ResultSink {
  /** `context` carries the result fields the contract does not hold yet (result-context.ts). */
  append(result: EvaluationResult, evidence: CallEvidence | null, context?: ResultContext): void | Promise<void>;
}

export interface RunOptions {
  executionMode: ExecutionMode;
  environment: Environment;
  /** Minimum repetitions per scenario; a scenario's own `repetitions` (>= 5 for selected cases) is never reduced. */
  repetitions?: number;
  faultPlans: ReadonlyMap<string, FaultPlan>;
  clock?: Clock;
  runId?: string;
  idSource?: () => string;
  sink?: ResultSink;
  /** Allowlisted transfer destination ids (trusted configuration). Defaults to the synthetic world. */
  allowlistedDestinations?: ReadonlySet<string>;
  evidenceRefFor?: (scenarioId: string, repetition: number) => string;
  /** Run seed; per-repetition seeds derive from it (result-context.ts deriveSeed). Defaults to the run id. */
  seed?: string;
  /** Exact rerun command per result; defaults to `pnpm evidence rerun ...` (result-context.ts rerunCommandFor). */
  rerunCommandFor?: (runId: string, scenario: ScenarioDefinition, repetition: number, seed: string) => string;
  /** Run only this repetition of each scenario (a rerun of one result); it must not exceed the scenario's repetitions. */
  onlyRepetition?: number;
  /** Seed to use instead of the derived one (a rerun reproduces the original result's seed). */
  seedOverride?: string;
}

export class RunnerError extends Error {
  constructor(readonly reasonCode: string) {
    super(reasonCode);
  }
}

export interface RunOutput {
  runId: string;
  results: EvaluationResult[];
}

export async function runScenarios(driver: ConversationDriver, scenarios: readonly ScenarioDefinition[], opts: RunOptions): Promise<RunOutput> {
  if (driver.executionMode !== opts.executionMode) throw new RunnerError("EXECUTION_MODE_MISMATCH");
  if (driver.kind === "local_fixture" && opts.executionMode !== "local_fixture") throw new RunnerError("FIXTURE_DRIVER_CANNOT_CLAIM_LIVE_MODE");
  const clock = opts.clock ?? systemClock;
  const runId = opts.runId ?? (opts.idSource ?? (() => newId("run")))();
  if (!/^run_[A-Za-z0-9_-]{8,64}$/.test(runId)) throw new RunnerError("RUN_ID_INVALID");
  const minimum = Math.max(1, Math.floor(opts.repetitions ?? 1));
  const results: EvaluationResult[] = [];
  const runSeed = opts.seed ?? runId;
  const rerunFor = opts.rerunCommandFor ?? rerunCommandFor;

  for (const scenario of scenarios) {
    const reps = Math.max(scenario.repetitions, minimum);
    if (opts.onlyRepetition !== undefined && (!Number.isInteger(opts.onlyRepetition) || opts.onlyRepetition < 1 || opts.onlyRepetition > reps)) throw new RunnerError("REPETITION_OUT_OF_RANGE");
    for (let repetition = opts.onlyRepetition ?? 1; repetition <= (opts.onlyRepetition ?? reps); repetition++) {
      const runAt = clock.now().toISOString();
      const seed = opts.seedOverride ?? deriveSeed(runSeed, scenario, repetition);
      const missingFaultPlans: string[] = [];
      const injectionFailures: string[] = [];
      let evidence: CallEvidence | null = null;
      let driverError: string | null = null;
      try {
        const call = await driver.startCall({ runId, scenario, repetition, environment: opts.environment, seed });
        const atTurn = new Map<number, FaultPlan[]>();
        for (const faultId of scenario.initialState.faults) {
          const plan = opts.faultPlans.get(faultId);
          if (!plan) {
            missingFaultPlans.push(faultId);
            continue;
          }
          if (plan.trigger.kind === "AT_TURN") {
            const at = plan.trigger.turnIndex ?? 0;
            atTurn.set(at, [...(atTurn.get(at) ?? []), plan]);
            continue;
          }
          const ack = await driver.injectFault(call, plan, isImmediateTrigger(plan.trigger.kind) ? "now" : "arm");
          if (!ack.accepted) injectionFailures.push(`${faultId}:${ack.reasonCode ?? "NOT_ACCEPTED"}`);
        }
        for (const [index, turn] of scenario.script.entries()) {
          for (const plan of atTurn.get(index) ?? []) {
            const ack = await driver.injectFault(call, plan, "now");
            if (!ack.accepted) injectionFailures.push(`${plan.faultId}:${ack.reasonCode ?? "NOT_ACCEPTED"}`);
          }
          const ack = await driver.sendTurn(call, turn, index);
          if (!ack.delivered) injectionFailures.push(`TURN_${index}:${ack.reasonCode ?? "NOT_DELIVERED"}`);
        }
        for (const [index, plans] of atTurn) {
          if (index >= scenario.script.length) for (const p of plans) injectionFailures.push(`${p.faultId}:TURN_INDEX_BEYOND_SCRIPT`);
        }
        await driver.endCall(call, "SCRIPT_COMPLETE");
        const raw = await driver.collectEvidence(call);
        const parsed = CallEvidence.safeParse(raw);
        if (parsed.success) evidence = parsed.data;
        else driverError = "EVIDENCE_SCHEMA_INVALID";
      } catch {
        driverError = "DRIVER_ERROR";
      }
      const ctx: ScoreContext = {
        runId,
        runAt,
        repetition,
        environment: opts.environment,
        executionMode: opts.executionMode,
        missingFaultPlans,
        injectionFailures,
        driverError,
        faultPlans: opts.faultPlans,
        allowlistedDestinations: opts.allowlistedDestinations,
        evidenceRef: opts.evidenceRefFor?.(scenario.scenarioId, repetition) ?? null,
        seed,
        rerunCommand: rerunFor(runId, scenario, repetition, seed),
      };
      const { result, reach } = scoreScenarioDetailed(scenario, evidence, ctx);
      results.push(result);
      const context = ResultContext.parse({
        contextVersion: RESULT_CONTEXT_VERSION,
        runId,
        scenarioId: scenario.scenarioId,
        scenarioVersion: scenario.version,
        repetition,
        split: scenario.split,
        seed,
        rerunCommand: ctx.rerunCommand,
        expectedScope: {
          expectedAssurance: scenario.expectedAssurance,
          permittedRecords: scenario.permittedRecords,
          expectedToolSequence: scenario.expectedToolSequence,
          requiredHandoff: scenario.requiredHandoff,
        },
        initialWorld: initialWorldOf(scenario, opts.faultPlans),
        faults: reach.map(reachToContext),
        observedTools: evidence?.toolCalls?.map((c) => `${c.name}:${c.status}${c.reasonCode ? `:${c.reasonCode}` : ""}`.slice(0, 140)) ?? null,
        errors: [...(driverError ? [driverError] : []), ...missingFaultPlans.map((f) => `FAULT_PLAN_MISSING:${f}`), ...injectionFailures, ...(evidence?.unsupported ?? []).map((u) => `UNSUPPORTED:${u}`)]
          .map((x) => x.slice(0, 200))
          .slice(0, 64),
      });
      await opts.sink?.append(result, evidence, context);
    }
  }
  return { runId, results };
}
