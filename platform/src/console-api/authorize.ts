/**
 * Console authorization (AUTH-02, spec sections 7 and 13). Every authenticated
 * endpoint is allowed only when BOTH hold:
 *   1. the staff member holds one of `ENDPOINT_ROLES[endpoint]` (contract), and
 *   2. `decideConsole` (OPA, policy/vsp/console.rego, deny by default) allows at
 *      least one of the console catalogue actions mapped to the endpoint below,
 *      for this server-established staff identity and resource.
 * Handlers then apply the finer per-scope / per-task / per-release rules.
 *
 * Mapping notes. Every read view maps to a dedicated, non-mutating catalogue
 * action with a least-privilege role set (policy/vsp/data.json console actions
 * console:session, operations:overview, budget:view, kill_switch:view,
 * reconciliation:view, human_task:view, release:view); mutations keep their
 * mutating actions (auditor read-only taint applies). See README "Policy mapping".
 */
import type { ConsoleBreakGlass, ConsoleDecision, ConsoleDecisionInput } from "../policy/console.js";
import { buildConsoleInput } from "../policy/console.js";
import type { Environment, StaffRole } from "../protocol/index.js";
import { ENDPOINT_ROLES } from "./contract.js";
import type { AuthenticatedEndpointKey, KillSwitchScope } from "./contract.js";

/** Server-established console identity (verified token + staff directory + break-glass record). */
export interface ConsoleIdentity {
  staffId: string;
  tenantId: string;
  displayLabel: string;
  roles: StaffRole[];
  /** Always true: tokens without an MFA amr are refused at authentication. */
  mfa: true;
  authenticatedAt: string;
  sessionExpiresAt: string;
  jtiHash: string;
  localFixture: boolean;
  /** Latest authoritative grant (possibly expired / self-granted), passed to policy unchanged. */
  breakGlass: ConsoleBreakGlass | null;
}

export interface ConsolePolicyEngine {
  readonly policyVersion: string;
  decideConsole(input: ConsoleDecisionInput): Promise<ConsoleDecision>;
}

export interface PolicyCheck {
  action: string;
  resource: {
    type: string;
    tenantId?: string | null;
    killSwitchScope?: KillSwitchScope | null;
    initiatorStaffId?: string | null;
    assignedStaffId?: string | null;
  };
}

/** Identity-only endpoints (me, logout): every staff role holds console:session (MFA, origin and tenant still apply). */
const SESSION_ACTIONS = ["console:session"] as const;

/**
 * Default console catalogue action(s) per endpoint (any one allowing suffices).
 * Handlers add resource details and, for dynamic endpoints, choose the action.
 */
export const ENDPOINT_POLICY_ACTIONS: Readonly<Record<AuthenticatedEndpointKey, readonly string[]>> = {
  "auth.logout": SESSION_ACTIONS,
  me: SESSION_ACTIONS,
  overview: ["operations:overview"],
  "calls.list": ["journey:inspect"],
  "calls.get": ["journey:inspect"],
  "calls.transfer": ["call:transfer"],
  /** Restricted support requests additionally need `restricted_record:view` (valid break-glass). */
  "supportRequests.trace": ["journey:inspect"],
  /** Same operator repair action as outbox.requeue; restricted requests additionally need `restricted_record:view`. */
  "supportRequests.repair": ["dlq:repair"],
  "actions.pending": ["pending_action:review"],
  /** support_agent only via assignedRoles when the call is assigned to them; supervisor via roles. */
  "actions.cancel": ["pending_action:cancel"],
  "reconciliation.list": ["reconciliation:view"],
  "reconciliation.reconcile": ["operation:retry_reconciled"],
  "reconciliation.retry": ["operation:retry_reconciled"],
  "outbox.requeue": ["dlq:repair"],
  "workflows.tasks": ["human_task:view"],
  "workflows.decision": ["human_task:decide"],
  "safetyEvents.list": ["safety_event:view"],
  /** Endpoint gate release:view; per item POLICY_BUNDLE additionally needs policy:review. */
  "releases.list": ["release:view"],
  /** Per kind: POLICY_BUNDLE -> policy:approve (initiator = submitter); KNOWLEDGE_SNAPSHOT -> knowledge:submit_release. */
  "releases.review": ["policy:approve", "knowledge:submit_release"],
  "budgets.list": ["budget:view"],
  "killSwitches.list": ["kill_switch:view"],
  /** engage / release with the requested scope. */
  "killSwitches.set": ["kill_switch:engage", "kill_switch:release"],
  "audit.search": ["audit:search"],
  "destinations.list": ["journey:inspect", "policy:review"],
};

/** Resource type labels for the policy input (`^[a-z_]{3,40}$`). */
export const ENDPOINT_RESOURCE_TYPES: Readonly<Record<AuthenticatedEndpointKey, string>> = {
  "auth.logout": "console_session",
  me: "console_session",
  overview: "operations_overview",
  "calls.list": "support_journey",
  "calls.get": "support_journey",
  "calls.transfer": "support_journey",
  "supportRequests.trace": "support_request",
  "supportRequests.repair": "support_request",
  "actions.pending": "pending_action",
  "actions.cancel": "pending_action",
  "reconciliation.list": "reconciliation_queue",
  "reconciliation.reconcile": "pending_action",
  "reconciliation.retry": "pending_action",
  "outbox.requeue": "dead_letter",
  "workflows.tasks": "human_task",
  "workflows.decision": "human_task",
  "safetyEvents.list": "safety_event",
  "releases.list": "release_candidate",
  "releases.review": "release_candidate",
  "budgets.list": "budget",
  "killSwitches.list": "kill_switch",
  "killSwitches.set": "kill_switch",
  "audit.search": "audit_metadata",
  "destinations.list": "destination_config",
};

/** Default checks for an endpoint (tenant-scoped resource, no scope / initiator / assignee). */
export function defaultChecks(endpoint: AuthenticatedEndpointKey, tenantId: string): PolicyCheck[] {
  return ENDPOINT_POLICY_ACTIONS[endpoint].map((action) => ({ action, resource: { type: ENDPOINT_RESOURCE_TYPES[endpoint], tenantId } }));
}

export function hasEndpointRole(endpoint: AuthenticatedEndpointKey, roles: readonly StaffRole[]): StaffRole | null {
  return ENDPOINT_ROLES[endpoint].find((r) => roles.includes(r)) ?? null;
}

/** Policy deny reasons mapped to the most actionable console reason code (first match wins). */
const DENY_PRIORITY: readonly [string, string][] = [
  ["BREAK_GLASS_SELF_GRANTED", "BREAK_GLASS_SELF_GRANTED"],
  ["STAFF_MFA_REQUIRED", "STAFF_MFA_REQUIRED"],
  ["ORIGIN_NOT_PERMITTED", "ORIGIN_NOT_PERMITTED"],
  ["TENANT_MISMATCH", "TENANT_MISMATCH"],
  ["STAFF_AUTH_TIME_INVALID", "STAFF_AUTH_TIME_INVALID"],
  ["STAFF_AUTH_STALE", "STAFF_AUTH_STALE"],
  ["AUDITOR_READ_ONLY", "AUDITOR_READ_ONLY"],
  ["SELF_APPROVAL_PROHIBITED", "SELF_REVIEW_FORBIDDEN"],
  // A role that could never perform the action is reported before break-glass state (break-glass never adds a role).
  ["ROLE_NOT_PERMITTED", "STAFF_ROLE_NOT_PERMITTED"],
  ["BREAK_GLASS_EXPIRED", "STAFF_BREAK_GLASS_EXPIRED"],
  ["BREAK_GLASS_NOT_YET_VALID", "BREAK_GLASS_NOT_YET_VALID"],
  ["BREAK_GLASS_DURATION_EXCEEDED", "BREAK_GLASS_DURATION_EXCEEDED"],
  ["BREAK_GLASS_JUSTIFICATION_INVALID", "BREAK_GLASS_JUSTIFICATION_INVALID"],
  ["BREAK_GLASS_REQUIRED", "BREAK_GLASS_REQUIRED"],
  ["INITIATOR_REQUIRED", "SUBMITTER_UNKNOWN"],
  ["KILL_SWITCH_SCOPE_REQUIRED", "VALIDATION_FAILED"],
  ["CONSOLE_ACTION_PROHIBITED", "CONSOLE_ACTION_PROHIBITED"],
  ["ACTION_UNKNOWN", "POLICY_ACTION_UNKNOWN"],
  ["POLICY_INPUT_INVALID", "POLICY_INPUT_INVALID"],
  ["POLICY_ENGINE_ERROR", "POLICY_ENGINE_ERROR"],
];

function denyRank(decision: ConsoleDecision): { rank: number; reason: string } {
  for (const [i, [policyReason, consoleReason]] of DENY_PRIORITY.entries()) if (decision.reasonCodes.includes(policyReason)) return { rank: i, reason: consoleReason };
  return { rank: DENY_PRIORITY.length, reason: decision.reasonCodes[0] ?? "DEFAULT_DENY" };
}

export function consoleReasonFor(decision: ConsoleDecision): string {
  return denyRank(decision).reason;
}

export interface AuthorizationOutcome {
  allowed: boolean;
  /** The allowing decision, or the first denying decision. */
  decision: ConsoleDecision;
  /** Console reason code for a denial (null when allowed). */
  reasonCode: string | null;
  action: string;
}

/**
 * Evaluates the checks in order (any one allowing suffices). The policy engine
 * never throws; a missing bundle denies everything (FailClosedPolicyEngine).
 */
export async function authorize(
  policy: ConsolePolicyEngine,
  identity: ConsoleIdentity,
  checks: readonly PolicyCheck[],
  ctx: { environment: Environment; now: Date },
): Promise<AuthorizationOutcome> {
  if (checks.length === 0) throw new Error("CONSOLE_POLICY_CHECKS_EMPTY");
  let best: { outcome: AuthorizationOutcome; rank: number } | null = null;
  for (const check of checks) {
    const input = buildConsoleInput({
      action: check.action,
      origin: "workforce_console",
      environment: ctx.environment,
      now: ctx.now,
      staff: {
        staffId: identity.staffId,
        tenantId: identity.tenantId,
        roles: identity.roles,
        mfa: identity.mfa,
        authenticatedAt: identity.authenticatedAt,
        breakGlass: identity.breakGlass,
      },
      resource: { tenantId: identity.tenantId, ...check.resource },
    });
    const decision = await policy.decideConsole(input);
    if (decision.allow) return { allowed: true, decision, reasonCode: null, action: check.action };
    // Report the most specific denial across the candidates (e.g. AUDITOR_READ_ONLY over ROLE_NOT_PERMITTED).
    const { rank, reason } = denyRank(decision);
    if (!best || rank < best.rank) best = { rank, outcome: { allowed: false, decision, reasonCode: reason, action: check.action } };
  }
  return (best as { outcome: AuthorizationOutcome }).outcome;
}
