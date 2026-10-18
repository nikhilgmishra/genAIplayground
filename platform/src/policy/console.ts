/**
 * Workforce console decision contract (entrypoint vsp/console/decision).
 *
 * Staff identity comes from workforce SSO (server-established StaffActor);
 * nothing in a console request body may set roles, MFA or break-glass state.
 * `origin` is set by the trusted transport: requests that arrive from a
 * conversational agent or service automation never reach console actions,
 * so the model cannot request or grant itself break-glass access (spec 7).
 */
import { z } from "zod";
import { Environment, IsoDateTime, OpaqueId, StaffRole, VersionLabel } from "../protocol/common.js";
import { KillSwitchScope } from "../protocol/contracts.js";
import { PolicyAction } from "../protocol/policy.js";
import { ReasonCode } from "../protocol/tools.js";
import { BreakGlassJustification } from "./catalogue.js";

export const StaffId = z.string().regex(/^stf_[A-Za-z0-9_-]{8,64}$/);

export const ConsoleOrigin = z.enum(["workforce_console", "conversational_agent", "service_automation"]);
export type ConsoleOrigin = z.infer<typeof ConsoleOrigin>;

export const ConsoleBreakGlass = z.strictObject({
  grantId: OpaqueId,
  /** Staff id of the approver; never the requesting staff member. */
  approvedBy: StaffId,
  justificationCode: BreakGlassJustification,
  grantedAt: IsoDateTime,
  expiresAt: IsoDateTime,
});
export type ConsoleBreakGlass = z.infer<typeof ConsoleBreakGlass>;

export const ConsoleDecisionInput = z.strictObject({
  action: PolicyAction,
  origin: ConsoleOrigin,
  environment: Environment,
  now: IsoDateTime,
  staff: z.strictObject({
    staffId: StaffId,
    tenantId: OpaqueId,
    roles: z.array(StaffRole).min(1).max(8),
    mfa: z.boolean(),
    authenticatedAt: IsoDateTime,
    breakGlass: ConsoleBreakGlass.nullable(),
  }),
  resource: z.strictObject({
    type: z.string().regex(/^[a-z_]{3,40}$/),
    tenantId: OpaqueId.nullable(),
    killSwitchScope: KillSwitchScope.nullable(),
    /** Who initiated the item being approved (policy change, break-glass request). */
    initiatorStaffId: StaffId.nullable(),
    /** Who the item is assigned to (own handoff). */
    assignedStaffId: StaffId.nullable(),
  }),
});
export type ConsoleDecisionInput = z.infer<typeof ConsoleDecisionInput>;

export const ConsoleObligation = z.enum(["AUDIT_ADMIN_ACTION", "AUDIT_READ", "BREAK_GLASS_REVIEW"]);

/** Raw Rego output for the console entrypoint. */
export const RegoConsoleDecision = z.strictObject({
  allow: z.boolean(),
  reasonCodes: z.array(ReasonCode).min(1).max(64),
  obligations: z.array(ConsoleObligation).max(8),
});

export const ConsoleDecision = z.strictObject({
  decisionId: OpaqueId,
  allow: z.boolean(),
  reasonCodes: z.array(ReasonCode).min(1).max(16),
  obligations: z.array(ConsoleObligation).max(8),
  policyVersion: VersionLabel,
  evaluatedAt: IsoDateTime,
});
export type ConsoleDecision = z.infer<typeof ConsoleDecision>;

/** Server-established staff identity (shape of protocol StaffActor plus tenant and grant details). */
export interface TrustedStaffIdentity {
  staffId: string;
  tenantId: string;
  roles: readonly z.infer<typeof StaffRole>[];
  mfa: boolean;
  authenticatedAt: string;
  breakGlass: ConsoleBreakGlass | null;
}

export interface BuildConsoleInputArgs {
  action: string;
  origin: ConsoleOrigin;
  environment: z.infer<typeof Environment>;
  now: Date;
  staff: TrustedStaffIdentity;
  resource: {
    type: string;
    tenantId?: string | null;
    killSwitchScope?: z.infer<typeof KillSwitchScope> | null;
    initiatorStaffId?: string | null;
    assignedStaffId?: string | null;
  };
}

/** Builds a console decision input from server-established fields only. */
export function buildConsoleInput(args: BuildConsoleInputArgs): ConsoleDecisionInput {
  return {
    action: args.action,
    origin: args.origin,
    environment: args.environment,
    now: args.now.toISOString(),
    staff: {
      staffId: args.staff.staffId,
      tenantId: args.staff.tenantId,
      roles: [...args.staff.roles],
      mfa: args.staff.mfa,
      authenticatedAt: args.staff.authenticatedAt,
      breakGlass: args.staff.breakGlass ? { ...args.staff.breakGlass } : null,
    },
    resource: {
      type: args.resource.type,
      tenantId: args.resource.tenantId ?? null,
      killSwitchScope: args.resource.killSwitchScope ?? null,
      initiatorStaffId: args.resource.initiatorStaffId ?? null,
      assignedStaffId: args.resource.assignedStaffId ?? null,
    },
  };
}
