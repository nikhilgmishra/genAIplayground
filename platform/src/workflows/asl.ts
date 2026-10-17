/**
 * Amazon States Language generator for AWS Step Functions STANDARD workflows
 * (spec section 3: durable work that must survive hang-up, outages, approvals
 * or days of waiting). The versioned TypeScript definitions are the single
 * source of truth; infra/stepfunctions/*.asl.json is generated from them and
 * checked for drift in CI.
 *
 * Shape of every generated state machine:
 *  - Each nonterminal workflow state is a Task using
 *    "arn:aws:states:::sqs:sendMessage.waitForTaskToken". The SQS message
 *    carries only opaque references; the Step Functions task token travels in
 *    the message BODY to the trusted worker and never appears in any URL.
 *    TimeoutSeconds comes from the state's ISO-8601 deadline; HeartbeatSeconds
 *    is derived from it so a dead worker fleet surfaces as an escalation.
 *  - The worker answers SendTaskSuccess with exactly {"event": "<EVENT>"};
 *    ResultSelector keeps only that field and ResultPath "$.signal" stores it,
 *    so no payload accumulates in execution state.
 *  - A Choice state routes on $.signal.event to the declared transitions.
 *    Missing or undeclared events go to the escalation path (never dropped).
 *  - Retry uses the state's retry budget as MaxAttempts with FULL jitter.
 *    Catch routes timeouts and exhausted retries to escalation states that
 *    notify the escalation owner queue and then follow the declared
 *    escalation transition.
 *  - Guarded transitions (disclosure / material change) pass through a recheck
 *    task before the target; a deny follows POLICY_CHANGED_PENDING_ACTION.
 *  - Terminal states are Succeed (COMPLETED, CANCELLED) or Fail (FAILED).
 *  - Queue URLs are Terraform templatefile placeholders such as
 *    "${human_task_queue_url}" (see ASL_PLACEHOLDERS / infra/stepfunctions/README.md).
 */
import { WorkflowStateName } from "../protocol/index.js";
import { sha256Hex } from "../shared/canonical.js";
import { durationSeconds } from "./duration.js";
import type { WorkflowStateDefinition } from "./ports.js";
import { POLICY_CHANGED_PENDING_ACTION, type TransitionGuard, type VersionedWorkflowDefinition } from "./types.js";

export const STATE_MACHINE_TYPE = "STANDARD" as const;

/** Terraform templatefile variables referenced by the generated documents. */
export const ASL_PLACEHOLDERS = {
  system_task_queue_url: "SQS queue for system work items (ACCEPTED, VALIDATING, WAITING_FOR_SYSTEM, READY_TO_COMMIT), consumed by the workflow worker.",
  human_task_queue_url: "SQS queue for human-task work items (WAITING_FOR_HUMAN), consumed by the human-task bridge that opens the console task.",
  notify_queue_url: "SQS queue for caller follow-up (WAITING_FOR_CALLER): neutral notification per preferences/quiet hours/consent, then wait for the caller.",
  escalation_queue_url: "SQS queue that receives escalation notices (deadline exceeded, retry budget exhausted, invalid signal) for the escalation owner.",
  recheck_queue_url: "SQS queue for pre-disclosure / material-change rechecks (consent, representation, account state, current policy).",
} as const;
export type AslPlaceholder = keyof typeof ASL_PLACEHOLDERS;

export interface AslOptions {
  retryIntervalSeconds: number;
  backoffRate: number;
  maxRetryDelaySeconds: number;
  recheckTimeoutSeconds: number;
  notifyRetryAttempts: number;
}

/** Engineering defaults; operational values are reviewed with the Terraform plan. */
export const DEFAULT_ASL_OPTIONS: AslOptions = {
  retryIntervalSeconds: 30,
  backoffRate: 2,
  maxRetryDelaySeconds: 3600,
  recheckTimeoutSeconds: 300,
  notifyRetryAttempts: 3,
};

type AslState = Record<string, unknown>;
export interface AslStateMachine {
  Comment: string;
  StartAt: string;
  States: Record<string, AslState>;
}

const WAIT_FOR_TOKEN = "arn:aws:states:::sqs:sendMessage.waitForTaskToken";
const SEND_MESSAGE = "arn:aws:states:::sqs:sendMessage";
/** Error name the worker uses with SendTaskFailure for a retryable failure (consumes the retry budget). */
export const RETRYABLE_ERROR = "Workflow.Retryable";

const placeholder = (p: AslPlaceholder) => `\${${p}}`;

function queueFor(state: WorkflowStateName): AslPlaceholder {
  if (state === "WAITING_FOR_HUMAN") return "human_task_queue_url";
  if (state === "WAITING_FOR_CALLER") return "notify_queue_url";
  return "system_task_queue_url";
}

export function heartbeatFor(timeoutSeconds: number): number | null {
  const hb = Math.min(3600, Math.floor(timeoutSeconds / 4));
  return hb >= 1 && hb < timeoutSeconds ? hb : null;
}

const name = {
  route: (s: string) => `${s}__Route`,
  deadline: (s: string) => `${s}__DeadlineEscalation`,
  failure: (s: string) => `${s}__FailureEscalation`,
  invalid: (s: string) => `${s}__InvalidSignalEscalation`,
  notify: (s: string) => `${s}__NotifyEscalation`,
  recheck: (s: string, e: string) => `${s}__Recheck_${e}`,
  decision: (s: string, e: string) => `${s}__Recheck_${e}__Decision`,
};

function baseBody(def: VersionedWorkflowDefinition, state: string): Record<string, unknown> {
  return {
    "workflowId.$": "$.workflowId",
    "tenantId.$": "$.tenantId",
    workflowType: def.type,
    definitionVersion: def.version,
    state,
  };
}

function terminalAsl(state: WorkflowStateName): AslState {
  if (state === "FAILED") return { Type: "Fail", Comment: "Workflow failed; the ledger records the reason code.", Error: "Workflow.Failed", Cause: "WORKFLOW_FAILED" };
  if (state === "CANCELLED") return { Type: "Succeed", Comment: "Workflow cancelled before any uncommitted work was applied." };
  return { Type: "Succeed", Comment: "Workflow completed. Completion is not resolution without commit receipts (ACT-04)." };
}

function taskState(def: VersionedWorkflowDefinition, state: WorkflowStateName, s: WorkflowStateDefinition, o: AslOptions): AslState {
  const timeout = durationSeconds(s.deadline ?? "");
  const body: Record<string, unknown> = { ...baseBody(def, state), ownerQueue: s.owner };
  if (s.humanTask) {
    body.taskType = s.humanTask.taskType;
    body.requiredStaffRoles = [...s.humanTask.requiredStaffRoles];
  }
  body["taskToken.$"] = "$$.Task.Token";
  const task: AslState = {
    Type: "Task",
    Comment: `owner ${s.owner}; deadline ${s.deadline}; retry budget ${s.retryBudget}; escalation ${s.escalation?.event} -> ${s.escalation?.ownerQueue}`,
    Resource: WAIT_FOR_TOKEN,
    Parameters: { QueueUrl: placeholder(queueFor(state)), MessageBody: body },
    TimeoutSeconds: timeout,
  };
  const hb = heartbeatFor(timeout);
  if (hb !== null) task.HeartbeatSeconds = hb;
  task.ResultSelector = { "event.$": "$.event" };
  task.ResultPath = "$.signal";
  task.Retry = [
    {
      ErrorEquals: [RETRYABLE_ERROR],
      IntervalSeconds: o.retryIntervalSeconds,
      MaxAttempts: s.retryBudget,
      BackoffRate: o.backoffRate,
      MaxDelaySeconds: Math.min(o.maxRetryDelaySeconds, timeout),
      JitterStrategy: "FULL",
    },
  ];
  task.Catch = [
    { ErrorEquals: ["States.Timeout", "States.HeartbeatTimeout"], ResultPath: null, Next: name.deadline(state) },
    { ErrorEquals: ["States.ALL"], ResultPath: null, Next: name.failure(state) },
  ];
  task.Next = name.route(state);
  return task;
}

function routeState(def: VersionedWorkflowDefinition, state: WorkflowStateName, s: WorkflowStateDefinition): AslState {
  const guards = def.transitionGuards[state] ?? {};
  const choices: AslState[] = [{ Not: { Variable: "$.signal.event", IsPresent: true }, Next: name.invalid(state) }];
  for (const event of Object.keys(s.transitions).sort()) {
    const target = s.transitions[event];
    if (target === undefined) continue;
    choices.push({ Variable: "$.signal.event", StringEquals: event, Next: guards[event] ? name.recheck(state, event) : target });
  }
  return {
    Type: "Choice",
    Comment: "Route the worker-reported event; undeclared events escalate.",
    Choices: choices,
    Default: name.invalid(state),
  };
}

function escalationStates(def: VersionedWorkflowDefinition, state: WorkflowStateName, s: WorkflowStateDefinition, o: AslOptions): Record<string, AslState> {
  const esc = s.escalation;
  if (!esc) throw new Error("ESCALATION_ROUTE_MISSING");
  const pass = (cause: string): AslState => ({
    Type: "Pass",
    Result: { event: esc.event, cause },
    ResultPath: "$.signal",
    Next: name.notify(state),
  });
  return {
    [name.deadline(state)]: pass("DEADLINE_EXCEEDED"),
    [name.failure(state)]: pass("RETRY_BUDGET_EXHAUSTED"),
    [name.invalid(state)]: pass("INVALID_SIGNAL"),
    [name.notify(state)]: {
      Type: "Task",
      Comment: `Notify escalation owner ${esc.ownerQueue}; escalation proceeds even if the notice cannot be sent.`,
      Resource: SEND_MESSAGE,
      Parameters: {
        QueueUrl: placeholder("escalation_queue_url"),
        MessageBody: { ...baseBody(def, state), escalationOwnerQueue: esc.ownerQueue, "cause.$": "$.signal.cause" },
      },
      ResultPath: null,
      Retry: [
        {
          ErrorEquals: ["States.ALL"],
          IntervalSeconds: 5,
          MaxAttempts: o.notifyRetryAttempts,
          BackoffRate: o.backoffRate,
          MaxDelaySeconds: 60,
          JitterStrategy: "FULL",
        },
      ],
      Catch: [{ ErrorEquals: ["States.ALL"], ResultPath: null, Next: name.route(state) }],
      Next: name.route(state),
    },
  };
}

function recheckStates(
  def: VersionedWorkflowDefinition,
  state: WorkflowStateName,
  s: WorkflowStateDefinition,
  event: string,
  guard: TransitionGuard,
  o: AslOptions,
): Record<string, AslState> {
  const target = s.transitions[event];
  const deniedTarget = s.transitions[POLICY_CHANGED_PENDING_ACTION];
  if (target === undefined || deniedTarget === undefined) throw new Error("GUARD_ROUTE_MISSING");
  return {
    [name.recheck(state, event)]: {
      Type: "Task",
      Comment: `Recheck consent, representation, account state and current policy before this ${guard.replace("_", " ")}.`,
      Resource: WAIT_FOR_TOKEN,
      Parameters: {
        QueueUrl: placeholder("recheck_queue_url"),
        MessageBody: { ...baseBody(def, state), event, toState: target, guard, "taskToken.$": "$$.Task.Token" },
      },
      TimeoutSeconds: o.recheckTimeoutSeconds,
      ResultSelector: { "decision.$": "$.decision" },
      ResultPath: "$.recheck",
      Retry: [
        {
          ErrorEquals: [RETRYABLE_ERROR],
          IntervalSeconds: 5,
          MaxAttempts: 3,
          BackoffRate: o.backoffRate,
          MaxDelaySeconds: 60,
          JitterStrategy: "FULL",
        },
      ],
      // Fail closed: an unavailable recheck never lets the change through; it escalates.
      Catch: [{ ErrorEquals: ["States.ALL"], ResultPath: null, Next: name.failure(state) }],
      Next: name.decision(state, event),
    },
    [name.decision(state, event)]: {
      Type: "Choice",
      Comment: "Only an explicit ALLOW proceeds; anything else records POLICY_CHANGED_PENDING_ACTION.",
      Choices: [
        { Not: { Variable: "$.recheck.decision", IsPresent: true }, Next: deniedTarget },
        { Variable: "$.recheck.decision", StringEquals: "ALLOW", Next: target },
      ],
      Default: deniedTarget,
    },
  };
}

export function generateAsl(def: VersionedWorkflowDefinition, options: Partial<AslOptions> = {}): AslStateMachine {
  const o = { ...DEFAULT_ASL_OPTIONS, ...options };
  const states: Record<string, AslState> = {};
  for (const state of WorkflowStateName.options) {
    const s = def.states[state];
    if (!s) continue;
    if (s.terminal) {
      states[state] = terminalAsl(state);
      continue;
    }
    states[state] = taskState(def, state, s, o);
    states[name.route(state)] = routeState(def, state, s);
    Object.assign(states, escalationStates(def, state, s, o));
    const guards = def.transitionGuards[state] ?? {};
    for (const event of Object.keys(guards).sort()) {
      const g = guards[event];
      if (g) Object.assign(states, recheckStates(def, state, s, event, g, o));
    }
  }
  for (const n of Object.keys(states)) if (n.length > 80) throw new Error("ASL_STATE_NAME_TOO_LONG");
  return {
    Comment: `GENERATED by platform/src/workflows/generate-asl.ts from ${def.type}@${def.version} - do not edit. Deploy as a ${STATE_MACHINE_TYPE} state machine. Execution input: {"workflowId","tenantId"} opaque ids only.`,
    StartAt: def.initial,
    States: states,
  };
}

export function renderAsl(def: VersionedWorkflowDefinition, options: Partial<AslOptions> = {}): string {
  return `${JSON.stringify(generateAsl(def, options), null, 2)}\n`;
}

export interface AslManifestEntry {
  workflowType: string;
  definitionVersion: string;
  file: string;
  sha256: string;
  stateMachineType: typeof STATE_MACHINE_TYPE;
}

export interface AslManifest {
  generator: string;
  stateMachineType: typeof STATE_MACHINE_TYPE;
  placeholders: typeof ASL_PLACEHOLDERS;
  logging: { level: string; includeExecutionData: false };
  workflows: AslManifestEntry[];
}

export const aslFileName = (type: string) => `${type}.asl.json`;

/** Builds every generated file (one ASL document per workflow type at its newest version, plus manifest.json). */
export function buildAslFiles(defs: readonly VersionedWorkflowDefinition[], options: Partial<AslOptions> = {}): Map<string, string> {
  const files = new Map<string, string>();
  const entries: AslManifestEntry[] = [];
  for (const def of [...defs].sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0))) {
    const file = aslFileName(def.type);
    if (files.has(file)) throw new Error("ASL_DUPLICATE_WORKFLOW_TYPE");
    const content = renderAsl(def, options);
    files.set(file, content);
    entries.push({ workflowType: def.type, definitionVersion: def.version, file, sha256: sha256Hex(content), stateMachineType: STATE_MACHINE_TYPE });
  }
  const manifest: AslManifest = {
    generator: "platform/src/workflows/generate-asl.ts",
    stateMachineType: STATE_MACHINE_TYPE,
    placeholders: ASL_PLACEHOLDERS,
    logging: { level: "ERROR", includeExecutionData: false },
    workflows: entries,
  };
  files.set("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
  return files;
}
