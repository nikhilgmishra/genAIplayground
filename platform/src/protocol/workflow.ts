/**
 * Durable follow-up workflow events (spec section 9).
 * Workflow ids and names contain no PHI; task tokens never appear in URLs or logs.
 */
import { z } from "zod";
import { IsoDateTime, OpaqueId, VersionLabel } from "./common.js";

export const WorkflowStateName = z.enum([
  "ACCEPTED",
  "VALIDATING",
  "WAITING_FOR_SYSTEM",
  "WAITING_FOR_HUMAN",
  "WAITING_FOR_CALLER",
  "READY_TO_COMMIT",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
]);
export type WorkflowStateName = z.infer<typeof WorkflowStateName>;

export const WorkflowType = z.enum([
  "billing_dispute_review",
  "provider_document_review",
  "claim_investigation",
  "partner_onboarding",
  "support_request_sync",
  "callback_request",
  "complaint_review",
]);
export type WorkflowType = z.infer<typeof WorkflowType>;

export const WorkflowEvent = z.strictObject({
  eventId: OpaqueId,
  workflowId: OpaqueId,
  workflowType: WorkflowType,
  definitionVersion: VersionLabel,
  fromState: WorkflowStateName.nullable(),
  toState: WorkflowStateName,
  trigger: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/),
  actor: z.strictObject({
    kind: z.enum(["system", "staff", "caller", "external_system"]),
    ref: OpaqueId.nullable(),
  }),
  occurredAt: IsoDateTime,
  deadline: IsoDateTime.nullable(),
  attempt: z.number().int().min(0),
  correlationId: OpaqueId,
  /** Opaque references to source records; no PHI payloads. */
  sourceRecordRefs: z.array(z.string().max(160)).max(16),
});
export type WorkflowEvent = z.infer<typeof WorkflowEvent>;
