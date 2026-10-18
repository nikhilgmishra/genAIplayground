/**
 * Versioned resolution contracts (spec section 4) and operational controls.
 */
import { z } from "zod";
import { Assurance, IsoDateTime, OpaqueId, Outcome, Role, VersionLabel } from "./common.js";

export const ResolutionContract = z.strictObject({
  contractId: z.string().regex(/^[a-z_]+@\d+$/),
  intent: z.string().regex(/^[a-z_]{3,64}$/),
  title: z.string().min(3).max(120),
  eligibleAudiences: z.array(Role).min(1),
  requiredAssurance: Assurance,
  permittedFields: z.array(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.]{0,80}$/)).max(64),
  sourceSystem: z.enum(["scheduling", "billing", "claims", "provider", "support_records", "knowledge", "identity", "internal", "none"]),
  allowedActions: z.array(z.string().regex(/^[a-z_.]+$/)).max(16),
  /** Exact evidence required to record RESOLVED; anything less is a different outcome. */
  successEvidence: z.array(z.string().min(5).max(200)).min(1),
  resolvedOutcome: Outcome,
  callerConfirmationRequired: z.boolean(),
  escalationOwner: z.string().regex(/^q_[a-z0-9_]{2,40}$/),
  serviceDeadline: z.string().regex(/^P(T?\d+[HMDW])+$/).nullable(),
  afterHoursBehavior: z.enum(["SELF_SERVICE_AVAILABLE", "INTAKE_AND_CALLBACK", "HUMAN_ROUTE_ONLY", "SAFETY_ROUTE_ALWAYS"]),
  prohibitedAssertions: z.array(z.string().min(5).max(200)).min(1),
  humanBoundary: z.array(z.string().min(5).max(200)),
  status: z.enum(["DRAFT", "APPROVED", "RETIRED"]),
  approvedBy: z.string().max(120).nullable(),
});
export type ResolutionContract = z.infer<typeof ResolutionContract>;

export const KillSwitchScope = z.enum([
  "AI_ADMISSION",
  "INTENT",
  "INTEGRATION",
  "WRITES",
  "MODEL_VERSION",
  "VOICE_VERSION",
  "OUTBOUND_NOTIFICATIONS",
]);
export type KillSwitchScope = z.infer<typeof KillSwitchScope>;

export const KillSwitch = z.strictObject({
  switchId: OpaqueId,
  scope: KillSwitchScope,
  /** Intent id, integration id or version label; "*" for global scopes. */
  target: z.string().min(1).max(80),
  engaged: z.boolean(),
  reason: z.string().max(300),
  changedBy: z.string().max(80),
  changedAt: IsoDateTime,
});
export type KillSwitch = z.infer<typeof KillSwitch>;

export const BudgetScope = z.strictObject({
  environment: z.string(),
  cohort: z.string().max(64),
  workflow: z.string().max(64),
  vendor: z.string().max(64),
});

export const Budget = z.strictObject({
  budgetId: OpaqueId,
  scope: BudgetScope,
  periodStart: IsoDateTime,
  periodEnd: IsoDateTime,
  limitUsd: z.number().min(0),
  /** Reserve that remains available for active safety handoffs; never used to disconnect callers. */
  safetyReserveUsd: z.number().min(0),
  spentUsd: z.number().min(0),
  /** Vendor metering delay acknowledged in admission decisions. */
  meteringDelayMinutes: z.number().int().min(0),
  approvedBy: z.string().max(120).nullable(),
  version: VersionLabel,
});
export type Budget = z.infer<typeof Budget>;
