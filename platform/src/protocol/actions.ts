/**
 * Prepared actions, confirmations and commit receipts (spec section 8).
 *
 * A mutation is first prepared as a structured action with an authoritative
 * target, before-state version and exact change. The caller's affirmative
 * confirmation is bound to the digest of that prepared action (ACT-01). Commit
 * re-checks authorization, freshness, current state and confirmation, and is
 * idempotent under retry, redelivery and crash-after-commit (ACT-02/ACT-03).
 */
import { z } from "zod";
import { IsoDateTime, OpaqueId, Sha256Hex, VersionLabel } from "./common.js";
import { SessionRef } from "./auth.js";

export const ActionKind = z.enum([
  "appointment.reschedule",
  "appointment.create",
  "appointment.cancel",
  "billing.review.submit",
  "support_request.create",
  "callback.schedule",
]);
export type ActionKind = z.infer<typeof ActionKind>;

export const ActionState = z.enum([
  "PREPARED",
  "CONFIRMED",
  "COMMITTING",
  "COMMITTED",
  "FAILED",
  /** Outcome unknown after an ambiguous timeout or crash; must reconcile before retry or announcement. */
  "UNKNOWN",
  "INVALIDATED",
  "EXPIRED",
  "CANCELLED",
]);
export type ActionState = z.infer<typeof ActionState>;

/** Commit outcome classes for timeouts (spec section 8). */
export const CommitOutcome = z.enum(["NOT_STARTED", "COMMITTED", "FAILED", "UNKNOWN"]);
export type CommitOutcome = z.infer<typeof CommitOutcome>;

export const ActionTarget = z.strictObject({
  system: z.enum(["scheduling", "billing", "claims", "provider", "support_records", "internal"]),
  recordType: z.string().regex(/^[a-z_]{3,40}$/),
  recordRef: OpaqueId,
  /** Optimistic-concurrency version observed when the action was prepared. */
  beforeVersion: z.string().min(1).max(64),
});
export type ActionTarget = z.infer<typeof ActionTarget>;

export const MoneyAmount = z.strictObject({
  currency: z.literal("USD"),
  minorUnits: z.number().int(),
});
export type MoneyAmount = z.infer<typeof MoneyAmount>;

export const PreparedAction = z.strictObject({
  actionId: OpaqueId,
  kind: ActionKind,
  tenantId: OpaqueId,
  sessionRef: SessionRef,
  sessionGeneration: z.number().int().min(1),
  actorId: OpaqueId,
  subjectId: OpaqueId,
  target: ActionTarget,
  /** Exact structured change; values are opaque refs or typed scalars, never free text from the model. */
  change: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,40}$/), z.union([z.string().max(120), z.number(), z.boolean(), z.null()])),
  impact: z.strictObject({
    summaryTemplateId: z.string().regex(/^[a-z][a-z0-9_.]{2,80}$/),
    fees: MoneyAmount.nullable(),
    reversible: z.boolean(),
  }),
  policyDecisionId: OpaqueId,
  policyVersion: VersionLabel,
  preparedAt: IsoDateTime,
  expiresAt: IsoDateTime,
  /** Template id for the confirmation question presented to the caller. */
  confirmationTemplateId: z.string().regex(/^[a-z][a-z0-9_.]{2,80}$/),
  requiresStepUp: z.boolean(),
  /** sha256 over the canonical JSON of every field above (excluding digest and state). */
  digest: Sha256Hex,
  state: ActionState,
});
export type PreparedAction = z.infer<typeof PreparedAction>;

/** Confirmation is captured by a trusted deterministic component, not asserted by the model. */
export const ActionConfirmation = z.strictObject({
  actionId: OpaqueId,
  digest: Sha256Hex,
  sessionRef: SessionRef,
  sessionGeneration: z.number().int().min(1),
  turnId: z.string().regex(/^turn_[A-Za-z0-9_-]{4,64}$/),
  method: z.enum(["dtmf_keypress", "deterministic_skill_affirmative", "portal_approval", "human_agent"]),
  capturedBy: z.string().regex(/^[a-z0-9-]{3,64}$/),
  capturedAt: IsoDateTime,
});
export type ActionConfirmation = z.infer<typeof ActionConfirmation>;

export const CommitReceipt = z.strictObject({
  receiptId: OpaqueId,
  actionId: OpaqueId,
  idempotencyKey: z.string().min(16).max(128),
  outcome: CommitOutcome,
  providerSystem: ActionTarget.shape.system,
  /** Authoritative reference returned by the system of record; null unless COMMITTED. */
  providerReference: z.string().max(128).nullable(),
  providerIdempotencyKey: z.string().min(16).max(128),
  afterVersion: z.string().max(64).nullable(),
  committedAt: IsoDateTime.nullable(),
  recordedAt: IsoDateTime,
  /** sha256 of the canonical provider response evidence. */
  evidenceHash: Sha256Hex.nullable(),
  auditEventId: OpaqueId,
  reconciled: z.boolean(),
});
export type CommitReceipt = z.infer<typeof CommitReceipt>;
