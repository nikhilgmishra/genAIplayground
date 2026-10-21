/**
 * LongHorizonPlan (follow-on prompt section 12).
 *
 * Executable bounded steps drawn from approved capabilities, each with an owner, deadline and retry
 * budget. Every action-bearing step stays inside the plan's authority ceiling (the durable
 * ActionGrant's permitted actions), so replanning can change the investigation but never
 * self-expand authority. The policy snapshot is retained for explanation; current revocations
 * still apply at execution.
 *
 * Created by WP-02 in phase B; owned by WP-30 from phase E.
 */
import { z } from "zod";
import { IsoDateTime, OpaqueId, VersionLabel, envelope, opaqueIdWithPrefix } from "./common.js";

export const LONG_HORIZON_PLAN_SCHEMA_VERSION = "long-horizon-plan.v1";

const GrantAction = z.string().regex(/^[a-z][a-z0-9_]{1,31}(\.[a-z][a-z0-9_]{1,31}){1,4}$/);

export const PlanStepKind = z.enum(["READ", "PREPARE_ACTION", "COMMIT_ACTION", "WAIT_FOR_SYSTEM", "WAIT_FOR_HUMAN", "WAIT_FOR_CALLER", "NOTIFY", "VERIFY_EFFECT", "ESCALATE"]);
export type PlanStepKind = z.infer<typeof PlanStepKind>;

export const PlanStepState = z.enum(["PENDING", "IN_PROGRESS", "WAITING", "DONE", "FAILED", "SKIPPED", "ESCALATED"]);

const ACTION_STEPS: readonly PlanStepKind[] = ["PREPARE_ACTION", "COMMIT_ACTION"];

export const PlanStep = z
  .strictObject({
    stepId: z.string().regex(/^stp_[a-z0-9_]{2,40}$/),
    kind: PlanStepKind,
    /** Approved capability the step uses, e.g. `billing.dispute_review`. */
    capability: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,3}$/),
    /** Dotted grant action for action-bearing steps; null otherwise. */
    action: GrantAction.nullable(),
    ownerQueue: z.string().regex(/^q_[a-z0-9_]{2,40}$/),
    deadline: IsoDateTime,
    retryBudget: z.number().int().min(0).max(20),
    attempts: z.number().int().min(0).max(100),
    dependsOn: z.array(z.string().regex(/^stp_[a-z0-9_]{2,40}$/)).max(8),
    state: PlanStepState,
  })
  .superRefine((s, ctx) => {
    if (ACTION_STEPS.includes(s.kind) !== (s.action !== null)) ctx.addIssue({ code: "custom", message: "ACTION_ONLY_ON_ACTION_STEPS", path: ["action"] });
    if (s.attempts > s.retryBudget + 1) ctx.addIssue({ code: "custom", message: "ATTEMPTS_EXCEED_RETRY_BUDGET", path: ["attempts"] });
  });
export type PlanStep = z.infer<typeof PlanStep>;

export const LongHorizonPlan = z
  .strictObject({
    ...envelope(LONG_HORIZON_PLAN_SCHEMA_VERSION, ["tenantId", "caseId", "workflowId", "occurredAt"], ["causationId", "subjectRef"]),
    planId: opaqueIdWithPrefix("pln"),
    revision: z.number().int().min(1).max(10_000),
    supersedesRevision: z.number().int().min(1).max(10_000).nullable(),
    policySnapshotVersion: VersionLabel,
    authorityCeiling: z.strictObject({
      grantRef: OpaqueId.nullable(),
      permittedActions: z.array(GrantAction).max(16),
    }),
    steps: z.array(PlanStep).min(1).max(32),
    /** Owner of the case while any step is nonterminal (no abandoned task). */
    caseOwnerQueue: z.string().regex(/^q_[a-z0-9_]{2,40}$/),
    nextActionStepId: z.string().regex(/^stp_[a-z0-9_]{2,40}$/).nullable(),
    lastVerifiedProgressAt: IsoDateTime.nullable(),
  })
  .superRefine((p, ctx) => {
    const ids = new Set<string>();
    p.steps.forEach((s, i) => {
      if (ids.has(s.stepId)) ctx.addIssue({ code: "custom", message: "DUPLICATE_STEP", path: ["steps", i, "stepId"] });
      ids.add(s.stepId);
      if (s.action !== null && !p.authorityCeiling.permittedActions.includes(s.action)) {
        ctx.addIssue({ code: "custom", message: "STEP_EXCEEDS_AUTHORITY_CEILING", path: ["steps", i, "action"] });
      }
    });
    p.steps.forEach((s, i) => {
      for (const d of s.dependsOn) if (!ids.has(d) || d === s.stepId) ctx.addIssue({ code: "custom", message: "UNKNOWN_STEP_DEPENDENCY", path: ["steps", i, "dependsOn"] });
    });
    if (p.authorityCeiling.permittedActions.length > 0 && p.authorityCeiling.grantRef === null) {
      ctx.addIssue({ code: "custom", message: "AUTHORITY_WITHOUT_GRANT", path: ["authorityCeiling", "grantRef"] });
    }
    const open = p.steps.some((s) => s.state !== "DONE" && s.state !== "SKIPPED" && s.state !== "FAILED");
    if (open && p.nextActionStepId === null) ctx.addIssue({ code: "custom", message: "OPEN_PLAN_WITHOUT_NEXT_ACTION", path: ["nextActionStepId"] });
    if (p.nextActionStepId !== null && !ids.has(p.nextActionStepId)) ctx.addIssue({ code: "custom", message: "UNKNOWN_NEXT_ACTION", path: ["nextActionStepId"] });
    if ((p.supersedesRevision === null) !== (p.revision === 1) || (p.supersedesRevision !== null && p.supersedesRevision >= p.revision)) {
      ctx.addIssue({ code: "custom", message: "REVISION_LINEAGE_INVALID", path: ["supersedesRevision"] });
    }
  });
export type LongHorizonPlan = z.infer<typeof LongHorizonPlan>;

/**
 * A replan may change steps but never widen authority: the new ceiling must be a subset of the
 * previous one and keep the same grant. Returns the actions that would be added (empty when valid).
 */
export function authorityExpansion(previous: LongHorizonPlan, next: LongHorizonPlan): string[] {
  const before = new Set(previous.authorityCeiling.permittedActions);
  const added = next.authorityCeiling.permittedActions.filter((a) => !before.has(a));
  if (previous.authorityCeiling.grantRef !== next.authorityCeiling.grantRef && next.authorityCeiling.permittedActions.length > 0) added.push("<grant-changed>");
  return added;
}
