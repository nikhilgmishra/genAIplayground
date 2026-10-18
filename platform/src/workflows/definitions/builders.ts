/**
 * Small helpers that keep the versioned definitions explicit and reviewable.
 * Every nonterminal state is declared with an owner queue, an ISO-8601
 * deadline, a retry budget and an escalation route (spec section 9).
 *
 * DEADLINES ARE PROPOSED ENGINEERING DEFAULTS. They are not service-level
 * commitments; support operations must approve the per-workflow service
 * deadlines before production (see platform/src/workflows/README.md).
 */
import type { WorkflowStateName } from "../../protocol/index.js";
import type { WorkflowStateDefinition } from "../ports.js";
import { BUSINESS_ROLE_STAFF_MAPPING, type BusinessApprovalRole, type WorkflowActorKind } from "../types.js";

/** Uniform escalation event name used by every shipped definition. */
export const ESCALATED = "ESCALATED";

/**
 * Reviewed actor sets for workflow events (who may send an event through
 * WorkflowEngine.signal). Least privilege: a caller can only report that they
 * responded or submitted material; system outcomes come from the trusted
 * backend or the system of record; human decisions come only from
 * completeHumanTask; policy-change events are raised by the engine itself.
 */
export const ACTORS = Object.freeze({
  /** Trusted backend (worker, business layer) only. */
  SYSTEM: Object.freeze(["system"]) as readonly WorkflowActorKind[],
  /** Trusted backend or an authenticated, authorized staff member (console). */
  SYSTEM_OR_STAFF: Object.freeze(["system", "staff"]) as readonly WorkflowActorKind[],
  /** Trusted backend or the authenticated system of record (callback / webhook adapter). */
  SYSTEM_OR_EXTERNAL: Object.freeze(["system", "external_system"]) as readonly WorkflowActorKind[],
  /** The authenticated caller reporting their own response, or staff / backend recording it. */
  CALLER_RESPONSE: Object.freeze(["caller", "staff", "system"]) as readonly WorkflowActorKind[],
  /** Human-task decisions: staff only, and only through completeHumanTask. */
  HUMAN_DECISION: Object.freeze(["staff"]) as readonly WorkflowActorKind[],
  /** Raised by the engine; no actor may send it. */
  ENGINE_RAISED: Object.freeze([]) as readonly WorkflowActorKind[],
});

/** Event actor sets shared by every shipped definition that routes these events. */
export const COMMON_EVENT_ACTORS = Object.freeze({
  ESCALATED: ACTORS.SYSTEM_OR_STAFF,
  CANCEL: ACTORS.SYSTEM_OR_STAFF,
  RETRYABLE_FAILURE: ACTORS.SYSTEM_OR_EXTERNAL,
  HUMAN_APPROVED: ACTORS.HUMAN_DECISION,
  HUMAN_REJECTED: ACTORS.HUMAN_DECISION,
  POLICY_CHANGED_PENDING_ACTION: ACTORS.ENGINE_RAISED,
});

export function waitState(input: {
  owner: string;
  deadline: string;
  retryBudget: number;
  escalationOwner: string;
  transitions: Partial<Record<string, WorkflowStateName>>;
  humanTask?: { requiredStaffRoles: string[]; taskType: string };
}): WorkflowStateDefinition {
  const state: WorkflowStateDefinition = {
    owner: input.owner,
    deadline: input.deadline,
    retryBudget: input.retryBudget,
    escalation: { event: ESCALATED, ownerQueue: input.escalationOwner },
    terminal: false,
    transitions: { ...input.transitions },
  };
  if (input.humanTask) state.humanTask = { requiredStaffRoles: [...input.humanTask.requiredStaffRoles], taskType: input.humanTask.taskType };
  return state;
}

export function terminalState(owner: string): WorkflowStateDefinition {
  return { owner, deadline: null, retryBudget: 0, escalation: null, terminal: true, transitions: {} };
}

export function humanTaskFor(role: BusinessApprovalRole, taskType: string): { requiredStaffRoles: string[]; taskType: string } {
  return { requiredStaffRoles: [...BUSINESS_ROLE_STAFF_MAPPING[role]], taskType };
}

/** Recursively freezes a definition so a registered version cannot be mutated in place. */
export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}
