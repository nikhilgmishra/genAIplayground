import type { Queryable } from "../db/types.js";
import type { StaffActor, WorkflowEvent, WorkflowStateName, WorkflowType } from "../protocol/index.js";

/**
 * Versioned durable workflow definition. A single TypeScript definition is the
 * source of truth for both the local durable executor (offline) and the
 * generated AWS Step Functions Standard ASL (deployed via Terraform).
 */
export interface WorkflowStateDefinition {
  owner: string;
  /** ISO-8601 duration; every nonterminal state has a deadline. */
  deadline: string | null;
  retryBudget: number;
  /** Event fired when the deadline passes or the retry budget is exhausted. */
  escalation: { event: string; ownerQueue: string } | null;
  terminal: boolean;
  /** event name -> target state */
  transitions: Partial<Record<string, WorkflowStateName>>;
  /** States that wait on a human approve/reject via an authenticated endpoint. */
  humanTask?: { requiredStaffRoles: string[]; taskType: string };
}

export interface WorkflowDefinition {
  type: WorkflowType;
  version: string;
  initial: WorkflowStateName;
  states: Partial<Record<WorkflowStateName, WorkflowStateDefinition>>;
}

export interface WorkflowInstance {
  workflowId: string;
  tenantId: string;
  type: WorkflowType;
  definitionVersion: string;
  state: WorkflowStateName;
  ownerQueue: string;
  deadline: string | null;
  attempts: number;
  /** Opaque references (support request id, action id, durable grant id). No PHI. */
  sourceRecordRefs: string[];
  grantRef: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface HumanTask {
  taskId: string;
  workflowId: string;
  taskType: string;
  requiredStaffRoles: string[];
  status: "OPEN" | "COMPLETED" | "EXPIRED" | "CANCELLED";
  expiresAt: string;
}

export interface WorkflowEngine {
  /** Starts inside the caller's transaction when given (atomic with the accepting action). */
  start(
    input: { tenantId: string; type: WorkflowType; correlationId: string; sourceRecordRefs: string[]; grantRef: string | null },
    tx?: Queryable,
  ): Promise<WorkflowInstance>;
  signal(input: { tenantId: string; workflowId: string; event: string; actor: WorkflowEvent["actor"]; expectedVersion?: number }): Promise<WorkflowInstance>;
  /**
   * Completes a human task. The task token is scoped to one task, expires, is
   * stored hashed, and the staff actor's current authority is re-validated.
   */
  completeHumanTask(input: { tenantId: string; taskId: string; taskToken: string; decision: "APPROVE" | "REJECT"; staff: StaffActor }): Promise<WorkflowInstance>;
  /** Applies deadline escalations and retry budgets; returns transitions performed. */
  tick(now: Date): Promise<WorkflowEvent[]>;
  get(tenantId: string, workflowId: string): Promise<WorkflowInstance | null>;
  history(tenantId: string, workflowId: string): Promise<WorkflowEvent[]>;
  openTasks(tenantId: string, staffRoles: string[]): Promise<HumanTask[]>;
}
