/**
 * Client-side role checks used to HIDE or DISABLE actions. They mirror the
 * contract's least-privilege tables; the server enforces the same rules on every
 * request and remains the only authority (AUTH-02).
 */
import { ENDPOINT_ROLES, KILL_SWITCH_SCOPE_ROLES, RELEASE_REVIEW_ROLES } from "../api/contract";
import type { AuthenticatedEndpointKey, HumanTaskView, KillSwitchScope, ReleaseKind, StaffRole } from "../api/contract";

export const hasAnyRole = (mine: readonly StaffRole[], allowed: readonly StaffRole[]): boolean => allowed.some((r) => mine.includes(r));

export const canUse = (endpoint: AuthenticatedEndpointKey, mine: readonly StaffRole[]): boolean => hasAnyRole(mine, ENDPOINT_ROLES[endpoint]);

export const canSetKillSwitchScope = (scope: KillSwitchScope, mine: readonly StaffRole[]): boolean =>
  canUse("killSwitches.set", mine) && hasAnyRole(mine, KILL_SWITCH_SCOPE_ROLES[scope]);

export const canDecideTask = (task: Pick<HumanTaskView, "requiredStaffRoles" | "status">, mine: readonly StaffRole[]): boolean =>
  task.status === "OPEN" && canUse("workflows.decision", mine) && hasAnyRole(mine, task.requiredStaffRoles);

export const canReviewRelease = (kind: ReleaseKind, mine: readonly StaffRole[]): boolean =>
  canUse("releases.review", mine) && hasAnyRole(mine, RELEASE_REVIEW_ROLES[kind]);

export const ROLE_LABELS: Readonly<Record<StaffRole, string>> = {
  support_agent: "Support agent",
  supervisor: "Supervisor",
  safety_responder: "Safety responder",
  auditor: "Auditor",
  knowledge_editor: "Knowledge editor",
  policy_approver: "Policy approver",
  deployment_operator: "Deployment operator",
  security_admin: "Security administrator",
};
