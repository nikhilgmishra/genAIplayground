/**
 * Pre-disclosure / pre-material-change recheck hook (spec section 9).
 *
 * Before a later disclosure or a material change the engine rechecks consent,
 * representation, account state and current policy. Policies are snapshotted at
 * start for reproducibility, but revocations and updated legal constraints
 * apply immediately: the hook evaluates CURRENT state. A deny records a
 * POLICY_CHANGED_PENDING_ACTION event. A hook failure or a malformed result
 * fails closed (no transition).
 *
 * The live implementation belongs to the policy / identity modules (OPA
 * decision + consent and representation registries); this module only defines
 * the contract and fails closed when none is wired.
 */
import { z } from "zod";
import type { WorkflowEvent, WorkflowStateName, WorkflowType } from "../protocol/index.js";
import { OpaqueId, ReasonCode, VersionLabel } from "../protocol/index.js";
import { AccessDeniedError } from "../shared/errors.js";
import type { TransitionGuard } from "./types.js";

export interface RecheckContext {
  tenantId: string;
  workflowId: string;
  workflowType: WorkflowType;
  definitionVersion: string;
  fromState: WorkflowStateName;
  toState: WorkflowStateName;
  event: string;
  guard: TransitionGuard;
  /** Durable action grant (narrow authorization) the workflow was started with. */
  grantRef: string;
  sourceRecordRefs: readonly string[];
  /** Policy version snapshotted when the workflow was accepted (null if none was recorded). */
  policySnapshotVersion: string | null;
  actor: WorkflowEvent["actor"];
  now: string;
}

export type RecheckResult =
  | { allow: true; policyVersion?: string; decisionId?: string }
  | { allow: false; reasonCode: string; policyVersion?: string; decisionId?: string };

export interface PreDisclosureRecheck {
  readonly kind: "local_fixture" | "live";
  recheck(ctx: RecheckContext): Promise<RecheckResult>;
}

/** Strict parse of hook output; anything unexpected fails closed. */
export const RecheckResultSchema = z.discriminatedUnion("allow", [
  z.strictObject({ allow: z.literal(true), policyVersion: VersionLabel.optional(), decisionId: OpaqueId.optional() }),
  z.strictObject({ allow: z.literal(false), reasonCode: ReasonCode, policyVersion: VersionLabel.optional(), decisionId: OpaqueId.optional() }),
]);

/** Default when no recheck is wired: every guarded transition is refused (fail closed). */
export const unconfiguredRecheck: PreDisclosureRecheck = {
  kind: "live",
  async recheck(): Promise<RecheckResult> {
    throw new AccessDeniedError("RECHECK_NOT_CONFIGURED");
  },
};
