/**
 * Deterministic failure fixtures ("fault plans", spec sections 14 and 16).
 *
 * Fault plans are hand-authored JSON in scenarios/fixtures/failures/. They are
 * independent of any LLM generation (`llmGenerated: false`, `deterministic: true`)
 * and describe exactly where a fault is injected, what it does, and which
 * machine-checkable expectations the scorer applies as hard gates.
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { z } from "zod";
import { Outcome } from "../protocol/index.js";
import { walkFiles } from "./paths.js";

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
]);

export const FaultTriggerKind = z.enum(["AT_CALL_START", "AT_TURN", "BEFORE_TOOL", "AFTER_TOOL_RESULT", "ON_TRANSFER_STATE", "AFTER_CALL"]);
export type FaultTriggerKind = z.infer<typeof FaultTriggerKind>;

export const FaultEffectKind = z.enum([
  "SESSION_EXPIRED",
  "CONCURRENT_SESSION_COMMIT",
  "BARGE_IN_DURING_CONFIRMATION",
  "DUPLICATE_DELIVERY",
  "OUT_OF_ORDER_DELIVERY",
  "PROCESS_CRASH",
  "DEPENDENCY_UNAVAILABLE",
  "DEPENDENCY_TIMEOUT",
  "PARTIAL_WRITE",
  "TRANSFER_REJECTED",
  "RECEIVER_UNAVAILABLE",
  "BRIDGE_DROPPED",
  "AUDIT_SINK_UNAVAILABLE",
  "QUOTA_EXHAUSTED",
  "KNOWLEDGE_STALE",
  "REDACTION_FAILURE",
  "REGION_FAILOVER",
  "POLICY_ENGINE_ERROR",
  "GUARDRAIL_LIMIT",
]);

export const FaultDependency = z.enum([
  "scheduling",
  "billing",
  "claims",
  "provider_network",
  "salesforce",
  "identity_provider",
  "notification_provider",
  "knowledge",
  "audit_sink",
  "telephony",
  "policy_engine",
  "database",
  "model_runtime",
  "redaction",
]);

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
]);
export type FaultExpectation = z.infer<typeof FaultExpectation>;

export const FaultPlan = z.strictObject({
  faultPlanVersion: z.literal("fault-plan.v1"),
  faultId: z.string().regex(/^[A-Z_]{3,64}$/),
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
    out.set(parsed.data.faultId, parsed.data);
  }
  return out;
}

/** Faults injected at a point in time; every other trigger kind is armed at call start and fired by the driver. */
export const isImmediateTrigger = (kind: FaultTriggerKind): boolean => kind === "AT_CALL_START" || kind === "AT_TURN";
