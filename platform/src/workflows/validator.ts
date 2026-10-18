/**
 * Definition validator (spec section 9): every nonterminal state has an owner,
 * a deadline, a retry budget and an escalation route; every state is reachable;
 * every transition targets a defined state; every nonterminal state can still
 * reach a terminal state; human-task states declare the staff roles that may
 * decide them; guarded transitions have a POLICY_CHANGED_PENDING_ACTION route
 * and a durable-grant action; every event declares which actor kinds may send
 * it (human-task decisions: staff only; policy-change events: nobody).
 *
 * Issues are reason codes only (no free text) so they can be logged safely.
 */
import { z } from "zod";
import { StaffRole, WorkflowStateName, WorkflowType } from "../protocol/index.js";
import { ValidationError } from "../shared/errors.js";
import { parseIsoDuration } from "./duration.js";
import type { WorkflowDefinition } from "./ports.js";
import {
  BUSINESS_ROLE_STAFF_MAPPING,
  DEFINITION_VERSION_RE,
  EVENT_NAME_RE,
  GRANT_ACTION_RE,
  HUMAN_APPROVED,
  HUMAN_REJECTED,
  HUMAN_TASK_EVENTS,
  OWNER_QUEUE_RE,
  POLICY_CHANGED_PENDING_ACTION,
  RESERVED_UNDECLARABLE_EVENTS,
  RETRYABLE_FAILURE,
  TASK_TYPE_RE,
  TERMINAL_STATES,
  WORKFLOW_ACTOR_KINDS,
  type BusinessApprovalRole,
  type VersionedWorkflowDefinition,
  type WorkflowActorKind,
} from "./types.js";

export const MAX_RETRY_BUDGET = 10;

export interface DefinitionIssue {
  code: string;
  state?: string;
  event?: string;
}

export interface DefinitionValidation {
  ok: boolean;
  issues: DefinitionIssue[];
}

/** Structural shape (loose value types so semantic checks can emit precise reason codes). */
const StateShape = z.strictObject({
  owner: z.string().max(64),
  deadline: z.string().max(32).nullable(),
  retryBudget: z.number(),
  escalation: z.strictObject({ event: z.string().max(64), ownerQueue: z.string().max(64) }).nullable(),
  terminal: z.boolean(),
  transitions: z.record(z.string().max(64), z.string().max(64)),
  humanTask: z.strictObject({ requiredStaffRoles: z.array(z.string().max(64)).max(8), taskType: z.string().max(64) }).optional(),
});

const DefinitionShape = z.strictObject({
  type: z.string().max(64),
  version: z.string().max(32),
  initial: z.string().max(64),
  states: z.record(z.string().max(64), StateShape),
  description: z.string().max(400).optional(),
  transitionGuards: z.record(z.string().max(64), z.record(z.string().max(64), z.string().max(32))).optional(),
  humanTaskRoles: z.record(z.string().max(64), z.string().max(64)).optional(),
  eventActors: z.record(z.string().max(64), z.array(z.string().max(32)).max(8)).optional(),
  grantActions: z.record(z.string().max(64), z.record(z.string().max(64), z.string().max(160))).optional(),
});

type StateShape = z.infer<typeof StateShape>;

export function validateDefinition(def: WorkflowDefinition | VersionedWorkflowDefinition): DefinitionValidation {
  const issues: DefinitionIssue[] = [];
  const shape = DefinitionShape.safeParse(def);
  if (!shape.success) return { ok: false, issues: [{ code: "DEFINITION_SHAPE_INVALID" }] };
  const d = shape.data;

  if (!WorkflowType.safeParse(d.type).success) issues.push({ code: "TYPE_UNKNOWN" });
  if (!DEFINITION_VERSION_RE.test(d.version)) issues.push({ code: "VERSION_INVALID" });

  const states = new Map<string, StateShape>(Object.entries(d.states));
  for (const name of states.keys()) {
    if (!WorkflowStateName.safeParse(name).success) issues.push({ code: "STATE_NAME_UNKNOWN", state: name });
  }

  const initial = states.get(d.initial);
  if (!initial) issues.push({ code: "INITIAL_STATE_UNDEFINED", state: d.initial });
  else if (initial.terminal) issues.push({ code: "INITIAL_STATE_TERMINAL", state: d.initial });

  if (![...states.values()].some((s) => s.terminal)) issues.push({ code: "NO_TERMINAL_STATE" });

  for (const [name, s] of states) checkState(name, s, states, issues);

  // Reachability from the initial state.
  if (initial) {
    const reachable = reachableFrom(d.initial, states);
    for (const name of states.keys()) {
      if (!reachable.has(name)) issues.push({ code: "STATE_UNREACHABLE", state: name });
    }
    // Every nonterminal state must still be able to finish (no trap cycles).
    for (const [name, s] of states) {
      if (s.terminal) continue;
      const fromHere = reachableFrom(name, states);
      if (![...fromHere].some((n) => states.get(n)?.terminal === true)) issues.push({ code: "NO_PATH_TO_TERMINAL", state: name });
    }
  }

  checkGuards(d.transitionGuards ?? {}, states, issues);
  checkGrantActions(d.grantActions ?? {}, d.transitionGuards ?? {}, issues);
  checkHumanTaskRoles(d.humanTaskRoles ?? {}, states, issues);
  checkEventActors(d.eventActors ?? {}, states, issues);

  return { ok: issues.length === 0, issues };
}

function checkState(name: string, s: StateShape, states: Map<string, StateShape>, issues: DefinitionIssue[]): void {
  const expectTerminal = TERMINAL_STATES.has(name as WorkflowStateName);
  if (s.terminal !== expectTerminal) issues.push({ code: "TERMINAL_FLAG_MISMATCH", state: name });

  if (s.owner.length === 0) issues.push({ code: "OWNER_MISSING", state: name });
  else if (!OWNER_QUEUE_RE.test(s.owner)) issues.push({ code: "OWNER_INVALID", state: name });

  const events = Object.entries(s.transitions);
  if (s.terminal) {
    if (events.length > 0) issues.push({ code: "TERMINAL_HAS_TRANSITIONS", state: name });
    if (s.deadline !== null) issues.push({ code: "TERMINAL_HAS_DEADLINE", state: name });
    if (s.escalation !== null) issues.push({ code: "TERMINAL_HAS_ESCALATION", state: name });
    if (s.humanTask) issues.push({ code: "TERMINAL_HAS_HUMAN_TASK", state: name });
    return;
  }

  if (s.deadline === null || s.deadline.length === 0) issues.push({ code: "DEADLINE_MISSING", state: name });
  else {
    const p = parseIsoDuration(s.deadline);
    if (!p.ok) issues.push({ code: p.reasonCode, state: name });
  }
  if (!Number.isInteger(s.retryBudget) || s.retryBudget < 0 || s.retryBudget > MAX_RETRY_BUDGET) {
    issues.push({ code: "RETRY_BUDGET_INVALID", state: name });
  }
  if (s.escalation === null) issues.push({ code: "ESCALATION_MISSING", state: name });
  else {
    if (!EVENT_NAME_RE.test(s.escalation.event)) issues.push({ code: "ESCALATION_EVENT_INVALID", state: name });
    if (!OWNER_QUEUE_RE.test(s.escalation.ownerQueue)) issues.push({ code: "ESCALATION_OWNER_INVALID", state: name });
    if (s.transitions[s.escalation.event] === undefined) issues.push({ code: "ESCALATION_NOT_ROUTED", state: name, event: s.escalation.event });
    const target = s.transitions[s.escalation.event];
    if (target !== undefined && states.get(target)?.terminal === true) {
      // Escalation must hand the work to a human owner, never end it silently.
      issues.push({ code: "ESCALATION_TERMINATES_WORK", state: name, event: s.escalation.event });
    }
  }
  if (events.length === 0) issues.push({ code: "NO_TRANSITIONS", state: name });

  for (const [event, target] of events) {
    if (!EVENT_NAME_RE.test(event)) issues.push({ code: "EVENT_NAME_INVALID", state: name });
    if (RESERVED_UNDECLARABLE_EVENTS.has(event)) issues.push({ code: "EVENT_RESERVED", state: name, event });
    if (!WorkflowStateName.safeParse(target).success || !states.has(target)) {
      issues.push({ code: "TRANSITION_TARGET_UNDEFINED", state: name, event });
    }
  }

  const hasDecisionRoutes = s.transitions[HUMAN_APPROVED] !== undefined || s.transitions[HUMAN_REJECTED] !== undefined;
  if (s.humanTask) {
    if (name !== "WAITING_FOR_HUMAN") issues.push({ code: "HUMAN_TASK_STATE_INVALID", state: name });
    if (s.humanTask.requiredStaffRoles.length === 0) issues.push({ code: "HUMAN_TASK_ROLES_MISSING", state: name });
    for (const r of s.humanTask.requiredStaffRoles) {
      if (!StaffRole.safeParse(r).success) issues.push({ code: "HUMAN_TASK_ROLE_UNKNOWN", state: name });
    }
    if (!TASK_TYPE_RE.test(s.humanTask.taskType)) issues.push({ code: "HUMAN_TASK_TYPE_INVALID", state: name });
    if (s.transitions[HUMAN_APPROVED] === undefined || s.transitions[HUMAN_REJECTED] === undefined) {
      issues.push({ code: "HUMAN_TASK_DECISION_UNROUTED", state: name });
    }
  } else {
    if (name === "WAITING_FOR_HUMAN") issues.push({ code: "HUMAN_STATE_WITHOUT_TASK", state: name });
    if (hasDecisionRoutes) issues.push({ code: "HUMAN_DECISION_WITHOUT_TASK", state: name });
  }
}

function reachableFrom(start: string, states: Map<string, StateShape>): Set<string> {
  const seen = new Set<string>([start]);
  const stack = [start];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    const s = states.get(cur);
    if (!s) continue;
    for (const target of Object.values(s.transitions)) {
      if (!seen.has(target) && states.has(target)) {
        seen.add(target);
        stack.push(target);
      }
    }
  }
  return seen;
}

function checkGuards(guards: Record<string, Record<string, string>>, states: Map<string, StateShape>, issues: DefinitionIssue[]): void {
  for (const [stateName, byEvent] of Object.entries(guards)) {
    const s = states.get(stateName);
    for (const [event, guard] of Object.entries(byEvent)) {
      if (guard !== "disclosure" && guard !== "material_change") issues.push({ code: "GUARD_INVALID", state: stateName, event });
      if (!s || s.transitions[event] === undefined) {
        issues.push({ code: "GUARD_UNKNOWN_TRANSITION", state: stateName, event });
        continue;
      }
      if (s.transitions[POLICY_CHANGED_PENDING_ACTION] === undefined) {
        issues.push({ code: "GUARD_WITHOUT_POLICY_CHANGE_ROUTE", state: stateName, event });
      }
      if (event === POLICY_CHANGED_PENDING_ACTION || (s.escalation && event === s.escalation.event)) {
        issues.push({ code: "GUARD_ON_SAFETY_ROUTE", state: stateName, event });
      }
    }
  }
}

/** Every guarded transition names the durable-grant action it consumes; grant actions exist only on guarded transitions. */
function checkGrantActions(grants: Record<string, Record<string, string>>, guards: Record<string, Record<string, string>>, issues: DefinitionIssue[]): void {
  for (const [stateName, byEvent] of Object.entries(guards)) {
    for (const event of Object.keys(byEvent)) {
      if (grants[stateName]?.[event] === undefined) issues.push({ code: "GUARD_GRANT_ACTION_MISSING", state: stateName, event });
    }
  }
  for (const [stateName, byEvent] of Object.entries(grants)) {
    for (const [event, action] of Object.entries(byEvent)) {
      if (!GRANT_ACTION_RE.test(action) || /\d{4,}/.test(action)) issues.push({ code: "GRANT_ACTION_INVALID", state: stateName, event });
      if (guards[stateName]?.[event] === undefined) issues.push({ code: "GRANT_ACTION_WITHOUT_GUARD", state: stateName, event });
    }
  }
}

/**
 * Actor permissions per event (fail closed: an event without a declared actor
 * set can never be sent). Human-task decisions are staff-only and engine-raised
 * policy-change events are sendable by nobody; escalation must stay available
 * to the system actor (deadline sweeper and the ASL escalation path).
 */
function checkEventActors(actors: Record<string, string[]>, states: Map<string, StateShape>, issues: DefinitionIssue[]): void {
  const used = new Set<string>();
  for (const s of states.values()) for (const event of Object.keys(s.transitions)) used.add(event);
  for (const event of [...used].sort()) {
    if (actors[event] === undefined) issues.push({ code: "EVENT_ACTORS_MISSING", event });
  }
  if (actors[RETRYABLE_FAILURE] === undefined) issues.push({ code: "EVENT_ACTORS_MISSING", event: RETRYABLE_FAILURE });
  const known = new Set<string>(WORKFLOW_ACTOR_KINDS);
  for (const [event, set] of Object.entries(actors)) {
    if (!EVENT_NAME_RE.test(event)) issues.push({ code: "EVENT_ACTORS_EVENT_INVALID" });
    if (!used.has(event) && event !== RETRYABLE_FAILURE) issues.push({ code: "EVENT_ACTORS_UNUSED", event });
    const seen = new Set<string>();
    for (const kind of set) {
      if (!known.has(kind)) issues.push({ code: "EVENT_ACTOR_UNKNOWN", event });
      if (seen.has(kind)) issues.push({ code: "EVENT_ACTOR_DUPLICATE", event });
      seen.add(kind);
    }
    if (HUMAN_TASK_EVENTS.has(event)) {
      if (set.length !== 1 || set[0] !== "staff") issues.push({ code: "HUMAN_TASK_EVENT_ACTORS_INVALID", event });
    } else if (event === POLICY_CHANGED_PENDING_ACTION) {
      if (set.length !== 0) issues.push({ code: "ENGINE_EVENT_ACTORS_INVALID", event });
    } else if (set.length === 0) {
      issues.push({ code: "EVENT_ACTORS_EMPTY", event });
    }
    // A caller must never be able to burn a retry budget and force an escalation.
    if (event === RETRYABLE_FAILURE && set.includes("caller")) issues.push({ code: "RETRY_EVENT_CALLER_FORBIDDEN", event });
  }
  for (const [name, s] of states) {
    if (!s.escalation) continue;
    const set = actors[s.escalation.event];
    if (set !== undefined && !(set as WorkflowActorKind[]).includes("system")) issues.push({ code: "ESCALATION_ACTOR_SYSTEM_MISSING", state: name, event: s.escalation.event });
  }
}

function checkHumanTaskRoles(roles: Record<string, string>, states: Map<string, StateShape>, issues: DefinitionIssue[]): void {
  for (const [stateName, role] of Object.entries(roles)) {
    const s = states.get(stateName);
    const mapped = BUSINESS_ROLE_STAFF_MAPPING[role as BusinessApprovalRole] as readonly string[] | undefined;
    if (!s?.humanTask || !mapped) {
      issues.push({ code: "HUMAN_TASK_ROLE_MAPPING_UNKNOWN", state: stateName });
      continue;
    }
    const a = [...s.humanTask.requiredStaffRoles].sort().join(",");
    const b = [...mapped].sort().join(",");
    if (a !== b) issues.push({ code: "HUMAN_TASK_ROLE_MAPPING_MISMATCH", state: stateName });
  }
  for (const [name, s] of states) {
    if (s.humanTask && roles[name] === undefined && Object.keys(roles).length > 0) {
      issues.push({ code: "HUMAN_TASK_ROLE_MAPPING_UNDOCUMENTED", state: name });
    }
  }
}

export class WorkflowDefinitionInvalidError extends ValidationError {
  constructor(readonly issues: DefinitionIssue[]) {
    super("WORKFLOW_DEFINITION_INVALID", `WORKFLOW_DEFINITION_INVALID: ${issues.map((i) => i.code).join(",")}`);
  }
}

export function assertValidDefinition(def: WorkflowDefinition | VersionedWorkflowDefinition): void {
  const r = validateDefinition(def);
  if (!r.ok) throw new WorkflowDefinitionInvalidError(r.issues);
}
