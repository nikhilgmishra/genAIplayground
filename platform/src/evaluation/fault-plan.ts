/**
 * Deterministic failure fixtures ("fault plans", spec sections 14 and 16; follow-on prompt section 17
 * "FAULT MATRIX" and "SCORER REPAIR").
 *
 * Fault plans are hand-authored JSON in scenarios/fixtures/failures/. They are independent of any LLM
 * generation (`llmGenerated: false`, `deterministic: true`) and describe exactly where a fault is
 * injected, what it does, and which machine-checkable expectations the scorer applies as hard gates.
 *
 * Plan version 2 (`fault-plan.v2`) adds the fixed fault registry (one plan per FO-17-24.<FAULT_ID>
 * row of docs/followon/gap-ledger.yaml, the fixed denominator of the fault-matrix gate):
 *  - `registry`: the requirement row, the real injection point, the packages that build it
 *    (`injectionPointPackages`), the packages whose components the postconditions observe
 *    (`postconditionPackages`), the package that owns the Layer-2 run tagged `[FAULT:<ID>]`
 *    (`layer2Owner`) and what the in-process LOCAL FIXTURE driver does with the plan (`localDriver`).
 *    The local driver's in-process injection is never a Layer-2 run (FO-17-24). Whether a tagged run
 *    exists and passed is derived by fault-registry.ts from the test tree and the test reports, never
 *    declared in a plan; a fault without a reached-and-asserted run is INCONCLUSIVE in the fault
 *    matrix and listed as a coverage hole.
 *  - `reachEvidence`: how the scorer proves, from backend-recorded evidence only, that the fault point
 *    was reached (FO-17-11: "a fault scenario passes only if the intended failure path was reached";
 *    the driver's own `faultsInjected` report is necessary but never sufficient). An empty list means
 *    the plan has no independent local evidence rule, so every local run requesting it is INCONCLUSIVE.
 *  - `postconditions`: what a run that reached the fault must assert (the Layer-2 test asserts all of
 *    them; the scorer asserts the machine-checkable subset in `expectations`).
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { z } from "zod";
import { Outcome, ToolStatus } from "../protocol/index.js";
import { walkFiles } from "./paths.js";
import { ACTION_TOKEN } from "./vocabulary.js";

export const FAULT_PLAN_VERSION = "fault-plan.v2";

export const FaultCategory = z.enum([
  "identity",
  "concurrency",
  "conversation",
  "delivery",
  "process",
  "dependency",
  "telephony",
  "audit",
  "capacity",
  "knowledge",
  "privacy",
  "infrastructure",
  "policy",
  "context",
  "model",
  "media",
]);

export const FaultTriggerKind = z.enum([
  "AT_CALL_START",
  "AT_TURN",
  "BEFORE_TOOL",
  "AFTER_TOOL_RESULT",
  "ON_TRANSFER_STATE",
  "AFTER_CALL",
  /** While the agent's speech is being released (audio release boundary). */
  "DURING_SPEECH",
  /** While no caller turn is in progress (idle session). */
  "WHILE_IDLE",
  /** While accepted work outlives the call (durable grants, workflows). */
  "WHILE_WORK_PENDING",
]);
export type FaultTriggerKind = z.infer<typeof FaultTriggerKind>;

export const FaultEffectKind = z.enum([
  "SESSION_EXPIRED",
  "SESSION_IDLE_EXPIRED",
  "CONCURRENT_SESSION_COMMIT",
  "BARGE_IN_DURING_CONFIRMATION",
  "DUPLICATE_DELIVERY",
  "OUT_OF_ORDER_DELIVERY",
  "EVENT_NOT_DELIVERED",
  "PROCESS_CRASH",
  "DEPENDENCY_UNAVAILABLE",
  "DEPENDENCY_TIMEOUT",
  "PARTIAL_WRITE",
  "RECEIPT_NOT_DELIVERED",
  "RECEIPT_DELAYED",
  "SOURCE_VERSION_CHANGED",
  "SOURCE_STALE",
  "SOURCE_CONTRADICTION",
  "SOURCE_DELETED",
  "SUBJECT_MERGED",
  "SUBJECT_SPLIT",
  "SCHEMA_DRIFT",
  "DEAD_LETTER_UNAVAILABLE",
  "TRANSFER_REJECTED",
  "RECEIVER_UNAVAILABLE",
  "RECEIVER_DECLINED",
  "BRIDGE_DROPPED",
  "AUDIT_SINK_UNAVAILABLE",
  "DATABASE_UNAVAILABLE",
  "QUOTA_EXHAUSTED",
  "BUDGET_EXHAUSTED",
  "KNOWLEDGE_STALE",
  "REDACTION_FAILURE",
  "REGION_FAILOVER",
  "POLICY_ENGINE_ERROR",
  "GUARDRAIL_LIMIT",
  "DELEGATION_REVOKED",
  "CONSENT_REVOKED",
  "RECORDING_REFUSED",
  "MODEL_REFUSAL",
  "MODEL_HANG",
  "MODEL_OVERLOAD",
  "ASR_FAILURE",
  "TTS_FAILURE",
  "JUDGE_FAILURE",
]);

export const FaultDependency = z.enum([
  "scheduling",
  "billing",
  "claims",
  "provider_network",
  "salesforce",
  "identity_provider",
  "identity_directory",
  "relationship_directory",
  "consent_registry",
  "session_store",
  "notification_provider",
  "knowledge",
  "audit_sink",
  "telephony",
  "policy_engine",
  "database",
  "dead_letter_queue",
  "event_inbox",
  "context_source",
  "connector",
  "model_runtime",
  "asr",
  "tts",
  "judge",
  "media_runtime",
  "spend_ledger",
  "redaction",
]);

const HardGateName = z.enum(["safety", "privacy", "authentication", "transaction", "audit"]);

/** Machine-checkable expectations; every one is evaluated as a hard gate. */
export const FaultExpectation = z.discriminatedUnion("check", [
  z.strictObject({ check: z.literal("no_duplicate_effect"), gate: z.literal("transaction") }),
  z.strictObject({ check: z.literal("no_commit"), gate: z.enum(["transaction", "audit", "authentication"]) }),
  z.strictObject({ check: z.literal("no_consequential_success"), gate: z.enum(["transaction", "audit"]) }),
  z.strictObject({ check: z.literal("outcome_in"), gate: z.literal("transaction"), outcomes: z.array(Outcome).min(1).max(8) }),
  z.strictObject({
    check: z.literal("support_request_kind"),
    gate: z.literal("transaction"),
    kind: z.enum(["salesforce_case", "internal_pending_sync"]),
  }),
  z.strictObject({ check: z.literal("transfer_fallback_or_connected"), gate: z.literal("safety") }),
  z.strictObject({ check: z.literal("caller_not_abandoned"), gate: z.literal("safety") }),
  z.strictObject({ check: z.literal("reconciliation_recorded"), gate: z.literal("transaction") }),
  z.strictObject({ check: z.literal("confirmation_fresh"), gate: z.literal("transaction") }),
  z.strictObject({ check: z.literal("no_protected_success_with_invalid_session"), gate: z.literal("authentication") }),
  /** None of the observed-action tokens (vocabulary.ts) may be present after the fault. */
  z.strictObject({ check: z.literal("tokens_absent"), gate: HardGateName, tokens: z.array(z.string().regex(ACTION_TOKEN)).min(1).max(8) }),
]);
export type FaultExpectation = z.infer<typeof FaultExpectation>;

const ToolName = z.string().regex(/^[a-z_]+$/);
const CodeName = z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/);
const ReachTransferState = z.enum(["REQUESTED", "QUEUED", "RECEIVER_ACCEPTED", "BRIDGED", "CALLER_CONFIRMED_CONNECTED", "COMPLETED", "TIMEOUT", "FAILED", "DISCONNECTED"]);

/**
 * Independent evidence that the fault point was reached (FO-17-11). The scorer evaluates every rule over
 * the backend-recorded parts of CallEvidence only (tool results the gateway returned, the action ledger
 * and system-of-record effect counts, the transfer store, support records, the session service and the
 * response gate's rendered templates). Driver notes and `faultsInjected` are never independent evidence;
 * the one exception is an emulator's own delivery log (`emulator_log`), which the contract accepts as
 * independent ("an audit event, inbox row or emulator log", protocol/evaluation.ts reachedFault). Its
 * counter is still carried in the driver's notes (see `emulator_log` below and fault-reach.ts).
 * A rule matches when every filter it names matches one record; a plan is reached when any rule except a
 * `driver_self_report` matches. A `driver_self_report` rule is never reach evidence: it only labels the
 * observation when the driver alone reports the fault (reached stays null, reachedFault stays null).
 */
export const ReachEvidence = z.discriminatedUnion("source", [
  /** A tool result returned by the gateway (status, reason code and resolved session state are backend values). */
  z.strictObject({
    source: z.literal("tool_response"),
    tools: z.array(ToolName).min(1).max(16).nullable(),
    statuses: z.array(ToolStatus).min(1).max(6).nullable(),
    reasonCodes: z.array(CodeName).min(1).max(16).nullable(),
    sessionStates: z.array(z.enum(["valid", "expired", "revoked", "none"])).min(1).max(4).nullable(),
  }),
  /** An ambiguous commit (UNKNOWN_OUTCOME) whose external effect exists in the system of record (after-commit faults). */
  z.strictObject({ source: z.literal("ambiguous_commit_with_effect"), tools: z.array(ToolName).min(1).max(8) }),
  /** Two consecutive transfer states recorded by the transfer store. */
  z.strictObject({ source: z.literal("transfer_states"), adjacent: z.tuple([ReachTransferState, ReachTransferState]) }),
  /** A support request of this kind in the support records. */
  z.strictObject({ source: z.literal("support_request_kind"), kind: z.enum(["salesforce_case", "internal_pending_sync"]) }),
  /** Verification begun (the gateway returned SUCCESS) and the session service never raised assurance above A0. */
  z.strictObject({ source: z.literal("verification_not_completed") }),
  /** A backend record collected into `committedState.<collection>` (an array of objects) matching every field. */
  z.strictObject({
    source: z.literal("backend_record"),
    collection: z.enum(["ledger", "transfers", "workflows", "supportRequests"]),
    where: z
      .record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,40}$/), z.array(z.union([z.string().max(80), z.boolean(), z.number()])).min(1).max(8))
      .refine((r) => Object.keys(r).length >= 1 && Object.keys(r).length <= 4, "1 to 4 fields"),
  }),
  /** A template the response gate rendered (`committedState.spokenTemplates` entries `<templateId>:<approval>:RENDERED`). */
  z.strictObject({ source: z.literal("response_template"), templateIds: z.array(z.string().regex(/^[a-z][a-z0-9_.]{2,80}$/)).min(1).max(8) }),
  /**
   * An emulator's delivery log as counted by the evidence collector: `telephony_duplicate_events` is the
   * telephony emulator's own record of duplicate deliveries it made (TELEPHONY_DUPLICATE_EVENTS_<n>, n >= 1),
   * carried in `committedState.driverNotes`; a zero count is NO_MATCH and a missing notes list is NOT_COLLECTED.
   */
  z.strictObject({ source: z.literal("emulator_log"), log: z.enum(["telephony_duplicate_events"]) }),
  /**
   * NOT reach evidence: the driver's own account of an injection it performed. `outbox_redelivered` is the
   * LOCAL FIXTURE driver's count of already-delivered outbox messages it published again with the same ids
   * (DUPLICATE_REDELIVERIES_<n>, n >= 1, in `committedState.driverNotes`). The count is taken by the driver
   * from its own re-publish, not recorded by the queue emulator or the consumer inbox, so it can never set
   * `reached` or `reachedFault` (FO-17-11, ADR decision 1); when it is the only signal the observation is
   * reached:null with observedBy `driver_notes.outbox_redelivered (driver self-report)` and the run is
   * INCONCLUSIVE. A Layer-2 run proves the duplicate with the inbox and consumer-dedup rows.
   */
  z.strictObject({ source: z.literal("driver_self_report"), note: z.enum(["outbox_redelivered"]) }),
]);

/** True for a rule that can prove reach (every source except `driver_self_report`). */
export const isIndependentReachRule = (r: ReachEvidence): boolean => r.source !== "driver_self_report";
export type ReachEvidence = z.infer<typeof ReachEvidence>;

export const WorkPackageId = z.string().regex(/^WP-\d{2}$/);

export const FaultRegistryEntry = z.strictObject({
  /** The FO-17-24.<FAULT_ID> row of docs/followon/requirements.yaml. */
  requirementId: z.string().regex(/^FO-17-24\.[A-Z][A-Z0-9_]{2,63}$/),
  /** `registry`: an original plan (fix waves 1-5); `prompt_section_17`: added for a follow-on prompt section 17 fault-matrix item. */
  origin: z.enum(["registry", "prompt_section_17"]),
  /** The real injection point (the parenthesised text of the requirement row). */
  injectionPoint: z.string().min(10).max(300),
  /** Packages that build the injection point as a seam with its own local test. */
  injectionPointPackages: z.array(WorkPackageId).min(1).max(6),
  /** Packages whose components the asserted postconditions observe. */
  postconditionPackages: z.array(WorkPackageId).min(1).max(8),
  /**
   * Package that owns the Layer-2 run tagged [FAULT:<ID>] (workPackage of the FO-17-24 row). Whether that
   * run exists and passed is never declared here: fault-registry.ts finds the tagged tests in the tree and
   * their results in the supplied test reports, so a plan cannot claim a run.
   */
  layer2Owner: WorkPackageId,
  /**
   * What the in-process LOCAL FIXTURE driver (platform/src/evaluation/driver) does with this plan. Its
   * injection is never cited as a Layer-2 run; REFUSED and NOT_SUPPORTED plans are INCONCLUSIVE locally.
   */
  localDriver: z.enum(["IN_PROCESS_FIXTURE_INJECTION", "REFUSED", "NOT_SUPPORTED"]),
});
export type FaultRegistryEntry = z.infer<typeof FaultRegistryEntry>;

export const FaultPlan = z.strictObject({
  faultPlanVersion: z.literal(FAULT_PLAN_VERSION),
  faultId: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/),
  version: z.number().int().min(1),
  title: z.string().min(5).max(120),
  description: z.string().min(10).max(800),
  category: FaultCategory,
  target: z.strictObject({
    /** Module path(s) whose behaviour is exercised, e.g. "platform/src/actions". */
    components: z.array(z.string().min(3).max(120)).min(1).max(6),
    dependency: FaultDependency.nullable(),
  }),
  trigger: z.strictObject({
    kind: FaultTriggerKind,
    /** For BEFORE_TOOL / AFTER_TOOL_RESULT: the tool; null means the first consequential tool of the call. */
    tool: z.string().regex(/^[a-z_]+$/).nullable(),
    turnIndex: z.number().int().min(0).nullable(),
    transferState: z.enum(["REQUESTED", "QUEUED", "RECEIVER_ACCEPTED", "BRIDGED", "CALLER_CONFIRMED_CONNECTED"]).nullable(),
  }),
  effect: z.strictObject({
    kind: FaultEffectKind,
    /** True when the fault happens after the external system already committed (ACT-02, ACT-03). */
    afterExternalCommit: z.boolean(),
    count: z.number().int().min(1).max(10).nullable(),
    durationMs: z.number().int().min(0).max(600_000).nullable(),
  }),
  deterministic: z.literal(true),
  llmGenerated: z.literal(false),
  expectations: z.array(FaultExpectation).min(1).max(12),
  callerVisible: z.string().min(10).max(600),
  backendEvidence: z.array(z.string().min(5).max(300)).min(1).max(12),
  requirementIds: z.array(z.string().regex(/^(AUTH|DATA|ACT|SAFE|OPS)-\d{2}$|^SPEC-\d{1,2}\.[a-z0-9-]+$/)).min(1).max(12),
  appliesToIntents: z.array(z.string().regex(/^[a-z_]{3,64}$/)).max(32),
  notes: z.string().max(800).nullable(),
  registry: FaultRegistryEntry,
  /**
   * Reach evidence for local runs: independent rules, plus `driver_self_report` rules that only label a
   * driver-reported fault (no independent rule: no local proof; INCONCLUSIVE).
   */
  reachEvidence: z.array(ReachEvidence).max(6),
  /** Postconditions a reached fault must satisfy (asserted by the Layer-2 [FAULT:<ID>] test). */
  postconditions: z.array(z.string().min(10).max(300)).min(1).max(12),
});
export type FaultPlan = z.infer<typeof FaultPlan>;

export class FaultPlanError extends Error {
  constructor(
    readonly file: string,
    readonly reasonCode: string,
  ) {
    super(`${reasonCode}: ${file}`);
  }
}

/** Loads and strictly validates every `<FAULT_ID>.json` under `dir`. File name must equal the faultId. */
export function loadFaultPlans(dir: string): Map<string, FaultPlan> {
  const out = new Map<string, FaultPlan>();
  for (const file of walkFiles(dir, (p) => p.endsWith(".json"))) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      throw new FaultPlanError(basename(file), "FAULT_PLAN_UNPARSEABLE");
    }
    const parsed = FaultPlan.safeParse(raw);
    if (!parsed.success) throw new FaultPlanError(basename(file), "FAULT_PLAN_INVALID");
    if (basename(file) !== `${parsed.data.faultId}.json`) throw new FaultPlanError(basename(file), "FAULT_PLAN_FILENAME_MISMATCH");
    if (out.has(parsed.data.faultId)) throw new FaultPlanError(basename(file), "FAULT_PLAN_DUPLICATE");
    if (parsed.data.registry.requirementId !== `FO-17-24.${parsed.data.faultId}`) throw new FaultPlanError(basename(file), "FAULT_PLAN_REQUIREMENT_MISMATCH");
    // The scorer names each check `fault.<fault>.<check>` and each reach check `evidence.fault_reached.<fault>`;
    // both must fit the 80-character AssertionResult id, or a result for this plan could not be recorded.
    const longest = Math.max(...parsed.data.expectations.map((x) => `fault.${parsed.data.faultId.toLowerCase()}.${x.check}`.length), `evidence.fault_reached.${parsed.data.faultId.toLowerCase()}`.length);
    if (longest > 80) throw new FaultPlanError(basename(file), "FAULT_PLAN_ASSERTION_ID_TOO_LONG");
    out.set(parsed.data.faultId, parsed.data);
  }
  return out;
}

/** Faults injected at a point in time; every other trigger kind is armed at call start and fired by the driver. */
export const isImmediateTrigger = (kind: FaultTriggerKind): boolean => kind === "AT_CALL_START" || kind === "AT_TURN";
