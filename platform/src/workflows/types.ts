/**
 * Workflow module types that extend the shared ports (platform/src/workflows/ports.ts)
 * without changing their signatures.
 */
import type { StaffRole, WorkflowStateName } from "../protocol/index.js";
import type { WorkflowDefinition } from "./ports.js";

/** Transitions that disclose information later or materially change a record require a recheck (spec section 9). */
export type TransitionGuard = "disclosure" | "material_change";

/**
 * Business approval roles used by human-task states. The workforce directory
 * currently exposes only the protocol StaffRole set, so each business role is
 * mapped onto staff roles here. The mapping is an interim engineering decision
 * pending a dedicated workforce role (see README "Role mapping").
 */
export type BusinessApprovalRole =
  | "billing_specialist"
  | "provider_relations_specialist"
  | "claims_specialist"
  | "partner_manager"
  | "crm_repair_operator"
  | "callback_agent"
  | "complaints_reviewer";

export const BUSINESS_ROLE_STAFF_MAPPING: Readonly<Record<BusinessApprovalRole, readonly StaffRole[]>> = Object.freeze({
  billing_specialist: ["supervisor", "support_agent"],
  provider_relations_specialist: ["supervisor", "support_agent"],
  claims_specialist: ["supervisor", "support_agent"],
  partner_manager: ["supervisor"],
  crm_repair_operator: ["supervisor", "support_agent"],
  callback_agent: ["support_agent", "supervisor"],
  complaints_reviewer: ["supervisor"],
});

/**
 * A versioned definition as shipped by this module. It is a WorkflowDefinition
 * (the port shape consumed by every engine) plus review metadata:
 * transition guards and the business role behind each human task.
 */
export interface VersionedWorkflowDefinition extends WorkflowDefinition {
  /** Short reviewer-facing purpose. Never contains PHI. */
  description: string;
  /** state -> event -> guard. A guarded transition runs the pre-disclosure recheck first. */
  transitionGuards: Partial<Record<WorkflowStateName, Partial<Record<string, TransitionGuard>>>>;
  /** state -> business approval role (documentation of the staff-role mapping). */
  humanTaskRoles: Partial<Record<WorkflowStateName, BusinessApprovalRole>>;
}

/** Events the engine raises itself. They can never be signalled by a caller, the model or an integration. */
export const HUMAN_APPROVED = "HUMAN_APPROVED";
export const HUMAN_REJECTED = "HUMAN_REJECTED";
export const POLICY_CHANGED_PENDING_ACTION = "POLICY_CHANGED_PENDING_ACTION";
/** Engine-handled retry signal; consumes the state's retry budget and escalates when exhausted. */
export const RETRYABLE_FAILURE = "RETRYABLE_FAILURE";
/** Trigger recorded for the initial ACCEPTED event. */
export const WORKFLOW_ACCEPTED = "WORKFLOW_ACCEPTED";

/** Events that only the engine may apply (signal() rejects them). */
export const ENGINE_ONLY_EVENTS: ReadonlySet<string> = new Set([HUMAN_APPROVED, HUMAN_REJECTED, POLICY_CHANGED_PENDING_ACTION, WORKFLOW_ACCEPTED]);

/** Events that must never appear as declared transitions (they are handled by the engine itself). */
export const RESERVED_UNDECLARABLE_EVENTS: ReadonlySet<string> = new Set([RETRYABLE_FAILURE, WORKFLOW_ACCEPTED]);

export const TERMINAL_STATES: ReadonlySet<WorkflowStateName> = new Set<WorkflowStateName>(["COMPLETED", "FAILED", "CANCELLED"]);

export const EVENT_NAME_RE = /^[A-Z][A-Z0-9_]{2,63}$/;
export const OWNER_QUEUE_RE = /^q_[a-z0-9_]{2,40}$/;
export const TASK_TYPE_RE = /^[a-z][a-z0-9_]{2,63}$/;
export const DEFINITION_VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
