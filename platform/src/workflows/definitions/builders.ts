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
import { BUSINESS_ROLE_STAFF_MAPPING, type BusinessApprovalRole } from "../types.js";

/** Uniform escalation event name used by every shipped definition. */
export const ESCALATED = "ESCALATED";

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
