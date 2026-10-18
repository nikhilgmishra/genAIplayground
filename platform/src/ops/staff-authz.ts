/**
 * Staff authorization for administrative ops actions (spec section 7: separated
 * staff roles, MFA, least privilege, audited elevated access).
 */
import { StaffActor } from "../protocol/index.js";
import type { KillSwitchScope, StaffRole } from "../protocol/index.js";
import { AccessDeniedError } from "../shared/errors.js";

/** Roles allowed to change each kill switch scope. Model/voice switches also allow the deployment operator. */
export const KILL_SWITCH_ROLES: Readonly<Record<KillSwitchScope, readonly StaffRole[]>> = {
  AI_ADMISSION: ["security_admin", "supervisor"],
  INTENT: ["security_admin", "supervisor"],
  INTEGRATION: ["security_admin", "supervisor"],
  WRITES: ["security_admin", "supervisor"],
  OUTBOUND_NOTIFICATIONS: ["security_admin", "supervisor"],
  MODEL_VERSION: ["security_admin", "supervisor", "deployment_operator"],
  VOICE_VERSION: ["security_admin", "supervisor", "deployment_operator"],
};

/** Roles allowed to define budgets. The financial authority is the referenced approval record (approvedBy). */
export const BUDGET_ROLES: readonly StaffRole[] = ["security_admin", "supervisor", "deployment_operator"];

/** Tolerated clock skew for staff authentication timestamps. */
const AUTH_FUTURE_SKEW_MS = 5 * 60_000;

export interface StaffAuthorization {
  staff: StaffActor;
  role: StaffRole;
}

/**
 * Validates the server-established StaffActor (from workforce SSO) and checks
 * MFA and role. Throws AccessDeniedError with a reason code; never trusts a role
 * the request body claims beyond what the parsed StaffActor carries.
 */
export function authorizeStaff(staffInput: unknown, allowed: readonly StaffRole[], now: Date): StaffAuthorization {
  const parsed = StaffActor.safeParse(staffInput);
  if (!parsed.success) throw new AccessDeniedError("STAFF_INVALID");
  const staff = parsed.data;
  if (!staff.mfa) throw new AccessDeniedError("STAFF_MFA_REQUIRED");
  const authAt = Date.parse(staff.authenticatedAt);
  if (!Number.isFinite(authAt) || authAt > now.getTime() + AUTH_FUTURE_SKEW_MS) throw new AccessDeniedError("STAFF_AUTH_TIME_INVALID");
  if (staff.breakGlass && Date.parse(staff.breakGlass.expiresAt) <= now.getTime()) throw new AccessDeniedError("STAFF_BREAK_GLASS_EXPIRED");
  const role = allowed.find((r) => staff.roles.includes(r));
  if (!role) throw new AccessDeniedError("STAFF_ROLE_NOT_PERMITTED");
  return { staff, role };
}
