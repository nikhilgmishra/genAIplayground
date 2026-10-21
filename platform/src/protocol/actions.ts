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
import { EvidencePointer, IsoDateTime, Money, OpaqueId, Sha256Hex, VersionLabel, envelope, isAfter, opaqueIdWithPrefix } from "./common.js";
import { SessionRef } from "./auth.js";
import { PolicyPurpose } from "./policy.js";

export const PREPARED_ACTION_SCHEMA_VERSION = "prepared-action.v1";
export const CONFIRMATION_RECEIPT_SCHEMA_VERSION = "confirmation-receipt.v1";
export const ACTION_GRANT_SCHEMA_VERSION = "action-grant.v1";
export const COMMIT_RECEIPT_SCHEMA_VERSION = "commit-receipt.v1";

/** Same grammar as support.ts SupportReference (kept local: support.ts -> effects.ts -> actions.ts). */
const GrantSourceReference = z.string().regex(/^SR-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);

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

/** Money in integer minor units plus ISO 4217 currency (common.ts Money; FO-04-44). */
export const MoneyAmount = Money;
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
  change: z
    .record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,40}$/), z.union([z.string().max(120), z.number().min(-1e13).max(1e13), z.boolean(), z.null()]))
    .refine((c) => Object.keys(c).length <= 32, "too many change fields")
    .meta({ maxProperties: 32 }),
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

/**
 * Follow-on version of PreparedAction (FO-04-20): every PreparedAction field plus the contract
 * version and causal predecessor. PreparedAction itself stays field-for-field unchanged because
 * its digest covers every field it declares (actions/digest.ts DIGEST_FIELDS). The action owner
 * (WP-25) adopts V2 together with the digest field list and the ledger row, which must persist
 * both new fields because they become digest-covered.
 */
export const PreparedActionV2 = PreparedAction.extend({
  schemaVersion: z.literal(PREPARED_ACTION_SCHEMA_VERSION),
  causationId: OpaqueId.nullable(),
});
export type PreparedActionV2 = z.infer<typeof PreparedActionV2>;

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

/**
 * ConfirmationReceipt (follow-on prompt section 11; FO-04-21): the ActionConfirmation (alias, see
 * CONTRACT_ALIASES) plus the receipt id, the tenant, the confirming actor and an expiry. It binds a
 * fresh affirmation on a trusted channel to that digest, actor, session and expiry; an earlier
 * "yes", another subject's approval or a model-generated confirmation is never a receipt (ACT-01).
 */
export const ConfirmationReceipt = z
  .strictObject({
    ...envelope(CONFIRMATION_RECEIPT_SCHEMA_VERSION, ["tenantId", "actorRef", "sessionGeneration", "turnId", "expiresAt"], ["causationId"]),
    receiptId: opaqueIdWithPrefix("cfr"),
    actionId: OpaqueId,
    digest: Sha256Hex,
    sessionRef: SessionRef,
    method: ActionConfirmation.shape.method,
    capturedBy: ActionConfirmation.shape.capturedBy,
    capturedAt: IsoDateTime,
    auditEventId: OpaqueId.nullable(),
  })
  .superRefine((r, ctx) => {
    if (!isAfter(r.expiresAt, r.capturedAt)) ctx.addIssue({ code: "custom", message: "CONFIRMATION_EXPIRY_NOT_AFTER_CAPTURE", path: ["expiresAt"] });
  });
export type ConfirmationReceipt = z.infer<typeof ConfirmationReceipt>;

/** Builds the receipt for a captured confirmation; the trusted capturer supplies the receipt fields. */
export function confirmationReceiptFrom(
  confirmation: ActionConfirmation,
  receipt: { receiptId: string; tenantId: string; actorRef: string; expiresAt: string; auditEventId: string | null; causationId: string | null },
): ConfirmationReceipt {
  const c = ActionConfirmation.parse(confirmation);
  return ConfirmationReceipt.parse({
    schemaVersion: CONFIRMATION_RECEIPT_SCHEMA_VERSION,
    tenantId: receipt.tenantId,
    actorRef: receipt.actorRef,
    sessionGeneration: c.sessionGeneration,
    turnId: c.turnId,
    expiresAt: receipt.expiresAt,
    causationId: receipt.causationId,
    receiptId: receipt.receiptId,
    actionId: c.actionId,
    digest: c.digest,
    sessionRef: c.sessionRef,
    method: c.method,
    capturedBy: c.capturedBy,
    capturedAt: c.capturedAt,
    auditEventId: receipt.auditEventId,
  });
}

/** What a receipt is checked against: the prepared action it claims to confirm. */
export type ConfirmedActionView = Pick<PreparedAction, "actionId" | "digest" | "tenantId" | "sessionRef" | "sessionGeneration" | "actorId" | "preparedAt" | "expiresAt">;

export type ConfirmationReceiptCheck =
  | { valid: true }
  | {
      valid: false;
      reasonCode:
        | "RECEIPT_TENANT_MISMATCH"
        | "RECEIPT_ACTION_MISMATCH"
        | "RECEIPT_DIGEST_MISMATCH"
        | "RECEIPT_SESSION_MISMATCH"
        | "RECEIPT_GENERATION_STALE"
        | "RECEIPT_ACTOR_MISMATCH"
        | "RECEIPT_PREDATES_ACTION"
        | "RECEIPT_CAPTURED_IN_FUTURE"
        | "RECEIPT_EXPIRED"
        | "ACTION_EXPIRED";
    };

/**
 * Fail-closed check that a receipt confirms exactly this prepared action at `now` (ACT-01): the same
 * tenant, action, digest, session (reference AND generation) and actor; captured after the action
 * was prepared (an earlier "yes" is never a confirmation of it) and not after `now`; and neither the
 * receipt nor the action expired. Digest equality here is a plain comparison of public digests;
 * a caller comparing a secret uses its own constant-time compare.
 */
export function checkConfirmationReceipt(receipt: ConfirmationReceipt, action: ConfirmedActionView, now: Date): ConfirmationReceiptCheck {
  const t = now.getTime();
  if (receipt.tenantId !== action.tenantId) return { valid: false, reasonCode: "RECEIPT_TENANT_MISMATCH" };
  if (receipt.actionId !== action.actionId) return { valid: false, reasonCode: "RECEIPT_ACTION_MISMATCH" };
  if (receipt.digest !== action.digest) return { valid: false, reasonCode: "RECEIPT_DIGEST_MISMATCH" };
  if (receipt.sessionRef !== action.sessionRef) return { valid: false, reasonCode: "RECEIPT_SESSION_MISMATCH" };
  if (receipt.sessionGeneration !== action.sessionGeneration) return { valid: false, reasonCode: "RECEIPT_GENERATION_STALE" };
  if (receipt.actorRef !== action.actorId) return { valid: false, reasonCode: "RECEIPT_ACTOR_MISMATCH" };
  if (Date.parse(receipt.capturedAt) < Date.parse(action.preparedAt)) return { valid: false, reasonCode: "RECEIPT_PREDATES_ACTION" };
  if (Date.parse(receipt.capturedAt) > t) return { valid: false, reasonCode: "RECEIPT_CAPTURED_IN_FUTURE" };
  if (Date.parse(receipt.expiresAt) <= t) return { valid: false, reasonCode: "RECEIPT_EXPIRED" };
  if (Date.parse(action.expiresAt) <= t) return { valid: false, reasonCode: "ACTION_EXPIRED" };
  return { valid: true };
}

/** True only when checkConfirmationReceipt finds the receipt valid for this action at `now`. */
export const receiptConfirms = (receipt: ConfirmationReceipt, action: ConfirmedActionView, now: Date): boolean => checkConfirmationReceipt(receipt, action, now).valid;

/** Dotted grant action, e.g. `billing.review.commit` (same grammar as workflows/types.ts GRANT_ACTION_RE). */
export const GrantAction = z
  .string()
  .regex(/^[a-z][a-z0-9_]{1,31}(\.[a-z][a-z0-9_]{1,31}){1,4}$/)
  .refine((a) => !/\d{4,}/.test(a), "digit run in grant action");

/**
 * ActionGrant (follow-on prompt section 11; FO-04-22): the narrow durable authority for long-running
 * work, tied to subject (and actor), purpose, the exact prepared action or an enumerated list of
 * permitted steps, parameter bounds, maximum uses, expiry, revocation and approval evidence. It
 * never reuses an expired call token and never waives a fresh confirmation for a different
 * consequential transaction. Mirrors the durable grant record of workflows/grants.ts.
 */
export const ActionGrant = z
  .strictObject({
    ...envelope(ACTION_GRANT_SCHEMA_VERSION, ["tenantId", "subjectRef", "occurredAt", "expiresAt"], ["actorRef", "caseId", "workflowId", "causationId"]),
    grantId: opaqueIdWithPrefix("grt"),
    purpose: PolicyPurpose,
    permittedActions: z
      .array(GrantAction)
      .min(1)
      .max(16)
      .refine((a) => new Set(a).size === a.length, "duplicate action"),
    /** Exact prepared action the grant is limited to, when it is limited to one. */
    preparedActionDigest: Sha256Hex.nullable(),
    parameterBounds: z
      .array(
        z.discriminatedUnion("kind", [
          z.strictObject({ kind: z.literal("MAX_MONEY"), field: z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,40}$/), max: Money }),
          z.strictObject({ kind: z.literal("ALLOWED_VALUES"), field: z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,40}$/), values: z.array(z.string().max(120)).min(1).max(16) }),
          z.strictObject({ kind: z.literal("TIME_WINDOW"), field: z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,40}$/), from: IsoDateTime, to: IsoDateTime }),
        ]),
      )
      .max(16),
    maxUses: z.number().int().min(1).max(100),
    usesConsumed: z.number().int().min(0).max(100),
    /** Accepting record that justified the grant (opaque id or support reference). */
    sourceRef: z.union([OpaqueId, GrantSourceReference]),
    approvalEvidenceRef: EvidencePointer.nullable(),
    revokedAt: IsoDateTime.nullable(),
    revocationReason: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/).nullable(),
  })
  .superRefine((g, ctx) => {
    if (!isAfter(g.expiresAt, g.occurredAt)) ctx.addIssue({ code: "custom", message: "GRANT_EXPIRY_NOT_AFTER_ISSUE", path: ["expiresAt"] });
    if (g.usesConsumed > g.maxUses) ctx.addIssue({ code: "custom", message: "GRANT_USES_EXCEEDED", path: ["usesConsumed"] });
    if ((g.revokedAt === null) !== (g.revocationReason === null)) ctx.addIssue({ code: "custom", message: "REVOCATION_REASON_MISMATCH", path: ["revocationReason"] });
    const boundFields = new Set<string>();
    g.parameterBounds.forEach((b, i) => {
      if (b.kind === "TIME_WINDOW" && !isAfter(b.to, b.from)) ctx.addIssue({ code: "custom", message: "EMPTY_TIME_WINDOW", path: ["parameterBounds", i] });
      // One bound per field: two bounds on one field would make the effective limit ambiguous.
      if (boundFields.has(b.field)) ctx.addIssue({ code: "custom", message: "DUPLICATE_PARAMETER_BOUND", path: ["parameterBounds", i, "field"] });
      boundFields.add(b.field);
    });
  });
export type ActionGrant = z.infer<typeof ActionGrant>;

/** A parameter value of one grant use: a scalar from the prepared change, or money. */
export type GrantParameterValue = string | number | boolean | null | Money;

/** One use of a grant: who it is for, why, which action and the exact parameters it would apply. */
export interface ActionGrantUse {
  tenantId: string;
  /** Subject the disclosure or effect concerns (trusted, from the durable work record). */
  subjectRef: string;
  /** Actor performing the use (trusted); checked when the grant names an actor. */
  actorRef: string | null;
  purpose: PolicyPurpose;
  action: string;
  preparedActionDigest: string | null;
  /** Parameters of the use by field name; every bounded field must be present and within its bound. */
  parameters: Readonly<Record<string, GrantParameterValue>>;
}

export type ActionGrantCheck =
  | { valid: true }
  | {
      valid: false;
      reasonCode:
        | "GRANT_TENANT_MISMATCH"
        | "GRANT_SUBJECT_MISMATCH"
        | "GRANT_ACTOR_MISMATCH"
        | "GRANT_PURPOSE_MISMATCH"
        | "GRANT_REVOKED"
        | "GRANT_NOT_YET_VALID"
        | "GRANT_EXPIRED"
        | "GRANT_EXHAUSTED"
        | "GRANT_ACTION_NOT_PERMITTED"
        | "GRANT_DIGEST_MISMATCH"
        | "GRANT_PARAMETER_MISSING"
        | "GRANT_PARAMETER_OUT_OF_BOUNDS";
      field?: string;
    };

/** True when `value` satisfies one parameter bound. Anything of the wrong type is out of bounds (fail closed). */
function withinBound(bound: ActionGrant["parameterBounds"][number], value: GrantParameterValue): boolean {
  switch (bound.kind) {
    case "MAX_MONEY": {
      const m = Money.safeParse(value);
      return m.success && m.data.currency === bound.max.currency && m.data.minorUnits >= 0 && m.data.minorUnits <= bound.max.minorUnits;
    }
    case "ALLOWED_VALUES":
      return typeof value === "string" && bound.values.includes(value);
    case "TIME_WINDOW": {
      const at = IsoDateTime.safeParse(value);
      return at.success && Date.parse(at.data) >= Date.parse(bound.from) && Date.parse(at.data) < Date.parse(bound.to);
    }
  }
}

/**
 * Fail-closed grant check before each disclosure or effect (ACT-01; follow-on prompt section 11):
 * the use must be for the grant's tenant, subject, actor (when the grant names one) and purpose,
 * inside its validity window, unrevoked (current revocation always applies), with uses left, for a
 * permitted action, for the exact prepared action when the grant is limited to one, and with every
 * bounded parameter present and within its bound.
 */
export function checkActionGrant(g: ActionGrant, use: ActionGrantUse, now: Date): ActionGrantCheck {
  const t = now.getTime();
  if (g.tenantId !== use.tenantId) return { valid: false, reasonCode: "GRANT_TENANT_MISMATCH" };
  if (g.subjectRef !== use.subjectRef) return { valid: false, reasonCode: "GRANT_SUBJECT_MISMATCH" };
  if (g.actorRef !== null && g.actorRef !== use.actorRef) return { valid: false, reasonCode: "GRANT_ACTOR_MISMATCH" };
  if (g.purpose !== use.purpose) return { valid: false, reasonCode: "GRANT_PURPOSE_MISMATCH" };
  if (g.revokedAt !== null) return { valid: false, reasonCode: "GRANT_REVOKED" };
  if (Date.parse(g.occurredAt) > t) return { valid: false, reasonCode: "GRANT_NOT_YET_VALID" };
  if (Date.parse(g.expiresAt) <= t) return { valid: false, reasonCode: "GRANT_EXPIRED" };
  if (g.usesConsumed >= g.maxUses) return { valid: false, reasonCode: "GRANT_EXHAUSTED" };
  if (!g.permittedActions.includes(use.action)) return { valid: false, reasonCode: "GRANT_ACTION_NOT_PERMITTED" };
  if (g.preparedActionDigest !== null && g.preparedActionDigest !== use.preparedActionDigest) return { valid: false, reasonCode: "GRANT_DIGEST_MISMATCH" };
  for (const b of g.parameterBounds) {
    if (!Object.prototype.hasOwnProperty.call(use.parameters, b.field)) return { valid: false, reasonCode: "GRANT_PARAMETER_MISSING", field: b.field };
    if (!withinBound(b, use.parameters[b.field] as GrantParameterValue)) return { valid: false, reasonCode: "GRANT_PARAMETER_OUT_OF_BOUNDS", field: b.field };
  }
  return { valid: true };
}

export const CommitReceipt = z.strictObject({
  /** Contract version, tenant and causal predecessor (follow-on envelope); optional until the action service sets them. */
  schemaVersion: z.literal(COMMIT_RECEIPT_SCHEMA_VERSION).optional(),
  tenantId: OpaqueId.optional(),
  causationId: OpaqueId.optional(),
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
  /** Independent EffectVerification for this commit (FO-04-23); a receipt alone is not a verified effect. */
  effectVerificationRef: opaqueIdWithPrefix("efv").nullable().optional(),
});
export type CommitReceipt = z.infer<typeof CommitReceipt>;
