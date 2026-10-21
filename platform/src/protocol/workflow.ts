/**
 * Durable follow-up workflow events (spec section 9).
 * Workflow ids and names contain no PHI; task tokens never appear in URLs or logs.
 */
import { z } from "zod";
import { IsoDateTime, OpaqueId, StaffRole, VersionLabel, envelope, isAfter } from "./common.js";

export const WORKFLOW_EVENT_SCHEMA_VERSION = "workflow-event.v1";
export const HUMAN_TASK_SCHEMA_VERSION = "human-task.v1";

export const WorkflowStateName = z.enum([
  "ACCEPTED",
  "VALIDATING",
  "WAITING_FOR_SYSTEM",
  "WAITING_FOR_HUMAN",
  "WAITING_FOR_CALLER",
  "READY_TO_COMMIT",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
]);
export type WorkflowStateName = z.infer<typeof WorkflowStateName>;

/**
 * Durable workflow states of the follow-on programme (prompt section 12): every WorkflowStateName
 * plus INVESTIGATING, VERIFYING_EFFECT and EXPIRED. WorkflowStateName keeps its original nine values
 * until the workflow owner (WP-26: workflows/engine.ts, outcome.ts, generate-asl.ts) and the console
 * contract adopt this enum together; WorkflowEvent and HumanTask move to it at the same time.
 */
export const WorkflowStateNameV2 = z.enum([...WorkflowStateName.options, "INVESTIGATING", "VERIFYING_EFFECT", "EXPIRED"]);
export type WorkflowStateNameV2 = z.infer<typeof WorkflowStateNameV2>;

/** Terminal states: no owner, deadline or next action is required after them. */
export const TERMINAL_WORKFLOW_STATES = ["COMPLETED", "FAILED", "CANCELLED", "EXPIRED"] as const satisfies readonly WorkflowStateNameV2[];

export const WorkflowType = z.enum([
  "billing_dispute_review",
  "provider_document_review",
  "claim_investigation",
  "partner_onboarding",
  "support_request_sync",
  "callback_request",
  "complaint_review",
]);
export type WorkflowType = z.infer<typeof WorkflowType>;

export const WorkflowEvent = z.strictObject({
  /** Contract version, tenant and causal event (follow-on envelope); optional until the engine (WP-26) sets them. */
  schemaVersion: z.literal(WORKFLOW_EVENT_SCHEMA_VERSION).optional(),
  tenantId: OpaqueId.optional(),
  causationId: OpaqueId.optional(),
  eventId: OpaqueId,
  workflowId: OpaqueId,
  workflowType: WorkflowType,
  definitionVersion: VersionLabel,
  fromState: WorkflowStateName.nullable(),
  toState: WorkflowStateName,
  trigger: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/),
  actor: z.strictObject({
    kind: z.enum(["system", "staff", "caller", "external_system"]),
    ref: OpaqueId.nullable(),
  }),
  occurredAt: IsoDateTime,
  deadline: IsoDateTime.nullable(),
  attempt: z.number().int().min(0),
  correlationId: OpaqueId,
  /** Opaque references to source records; no PHI payloads. */
  sourceRecordRefs: z.array(z.string().max(160)).max(16),
});
export type WorkflowEvent = z.infer<typeof WorkflowEvent>;

/**
 * HumanTask (follow-on prompt section 12; FO-04-28): a workflow state waiting on an authenticated
 * human decision. Mirrors the HumanTask record of platform/src/workflows/ports.ts with the envelope
 * fields. The task token is scoped to one task, stored hashed and never part of this contract, so
 * it can never appear in a link, a log or a model context; a model never completes a human task.
 */
export const HumanTask = z
  .strictObject({
    ...envelope(HUMAN_TASK_SCHEMA_VERSION, ["tenantId", "workflowId", "occurredAt", "expiresAt"], ["caseId", "causationId"]),
    taskId: OpaqueId,
    taskType: z.string().regex(/^[a-z][a-z0-9_.]{2,63}$/),
    requiredStaffRoles: z.array(StaffRole).min(1).max(8),
    ownerQueue: z.string().regex(/^q_[a-z0-9_]{2,40}$/).nullable(),
    status: z.enum(["OPEN", "COMPLETED", "EXPIRED", "CANCELLED"]),
    decision: z.enum(["APPROVE", "REJECT"]).nullable(),
    decidedBy: z.string().regex(/^stf_[A-Za-z0-9_-]{8,64}$/).nullable(),
    decidedAt: IsoDateTime.nullable(),
  })
  .superRefine((t, ctx) => {
    if (!isAfter(t.expiresAt, t.occurredAt)) ctx.addIssue({ code: "custom", message: "TASK_EXPIRY_NOT_AFTER_CREATION", path: ["expiresAt"] });
    const decided = t.decision !== null || t.decidedBy !== null || t.decidedAt !== null;
    const complete = t.decision !== null && t.decidedBy !== null && t.decidedAt !== null;
    if (t.status === "COMPLETED" && !complete) ctx.addIssue({ code: "custom", message: "COMPLETED_TASK_WITHOUT_DECISION", path: ["decision"] });
    if (t.status !== "COMPLETED" && decided) ctx.addIssue({ code: "custom", message: "DECISION_ON_OPEN_TASK", path: ["decision"] });
    // A decision is recorded while the task is open: after it was created and before it expired.
    if (t.decidedAt !== null && isAfter(t.occurredAt, t.decidedAt)) ctx.addIssue({ code: "custom", message: "DECISION_BEFORE_TASK", path: ["decidedAt"] });
    if (t.decidedAt !== null && !isAfter(t.expiresAt, t.decidedAt)) ctx.addIssue({ code: "custom", message: "DECISION_AFTER_EXPIRY", path: ["decidedAt"] });
  });
export type HumanTask = z.infer<typeof HumanTask>;
