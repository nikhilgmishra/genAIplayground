/**
 * Row mapping for action_ledger. Every row read back is strictly re-validated against the
 * protocol schemas, so a corrupted or tampered row fails closed instead of being trusted.
 */
import { z } from "zod";
import { ActionState, CommitReceipt, PreparedAction } from "../protocol/index.js";
import type { ActionState as ActionStateT, CommitReceipt as CommitReceiptT, PreparedAction as PreparedActionT } from "../protocol/index.js";
import { ValidationError } from "../shared/errors.js";
import { bindingRefFromHash } from "./digest.js";

export interface LedgerRow {
  action_id: string;
  tenant_id: string;
  session_ref_hash: string;
  session_generation: number;
  call_id: string;
  actor_id: string;
  actor_role: string | null;
  subject_id: string;
  kind: string;
  target: unknown;
  change: unknown;
  impact: unknown;
  digest: string;
  state: string;
  state_reason: string | null;
  policy_decision_id: string;
  policy_version: string;
  policy_obligations: unknown;
  requires_step_up: boolean;
  confirmation_template_id: string;
  prepared_assurance: string;
  prepared_at: Date | string;
  expires_at: Date | string;
  confirmation: unknown;
  confirmed_at: Date | string | null;
  provider_idempotency_key: string;
  commit_attempt_id: string | null;
  commit_attempts: number;
  committing_since: Date | string | null;
  reconcile_attempts: number;
  last_reconciled_at: Date | string | null;
  receipt: unknown;
  /** Durable invalidation request recorded while the action was in doubt (migration 0102; ACT-01). */
  invalidation_requested_at: Date | string | null;
  invalidation_reason: string | null;
  row_version: number;
  created_at: Date | string;
  updated_at: Date | string;
}

export const LEDGER_COLUMNS = `action_id, tenant_id, session_ref_hash, session_generation, call_id, actor_id, actor_role,
  subject_id, kind, target, change, impact, digest, state, state_reason, policy_decision_id, policy_version,
  policy_obligations, requires_step_up, confirmation_template_id, prepared_assurance, prepared_at, expires_at,
  confirmation, confirmed_at, provider_idempotency_key, commit_attempt_id, commit_attempts, committing_since,
  reconcile_attempts, last_reconciled_at, receipt, invalidation_requested_at, invalidation_reason, row_version, created_at, updated_at`;

/** Trusted confirmation evidence as stored (the session bearer value is replaced by its binding ref). */
export const StoredConfirmation = z.strictObject({
  actionId: z.string(),
  digest: z.string(),
  sessionBinding: z.string(),
  sessionGeneration: z.number().int(),
  turnId: z.string(),
  method: z.enum(["dtmf_keypress", "deterministic_skill_affirmative", "portal_approval", "human_agent"]),
  capturedBy: z.string(),
  capturedAt: z.string(),
  receivedAt: z.string(),
  integrationId: z.string(),
  channel: z.enum(["telephony_control", "portal"]),
});
export type StoredConfirmation = z.infer<typeof StoredConfirmation>;

export function toDate(v: Date | string): Date {
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) throw new ValidationError("LEDGER_TIMESTAMP_INVALID");
  return d;
}

export const toIso = (v: Date | string): string => toDate(v).toISOString();
export const toIsoOrNull = (v: Date | string | null): string | null => (v === null ? null : toIso(v));

export function rowState(row: LedgerRow): ActionStateT {
  const s = ActionState.safeParse(row.state);
  if (!s.success) throw new ValidationError("LEDGER_STATE_INVALID");
  return s.data;
}

/** Rebuilds the PreparedAction. `sessionRef` is the non-bearer binding ref. */
export function rowToAction(row: LedgerRow): PreparedActionT {
  const parsed = PreparedAction.safeParse({
    actionId: row.action_id,
    kind: row.kind,
    tenantId: row.tenant_id,
    sessionRef: bindingRefFromHash(row.session_ref_hash),
    sessionGeneration: row.session_generation,
    actorId: row.actor_id,
    subjectId: row.subject_id,
    target: row.target,
    change: row.change,
    impact: row.impact,
    policyDecisionId: row.policy_decision_id,
    policyVersion: row.policy_version,
    preparedAt: toIso(row.prepared_at),
    expiresAt: toIso(row.expires_at),
    confirmationTemplateId: row.confirmation_template_id,
    requiresStepUp: row.requires_step_up,
    digest: row.digest,
    state: row.state,
  });
  if (!parsed.success) throw new ValidationError("LEDGER_ROW_INVALID");
  return parsed.data;
}

export function rowReceipt(row: LedgerRow): CommitReceiptT | null {
  if (row.receipt === null || row.receipt === undefined) return null;
  const parsed = CommitReceipt.safeParse(row.receipt);
  if (!parsed.success) throw new ValidationError("LEDGER_RECEIPT_INVALID");
  return parsed.data;
}

export function rowConfirmation(row: LedgerRow): StoredConfirmation | null {
  if (row.confirmation === null || row.confirmation === undefined) return null;
  const parsed = StoredConfirmation.safeParse(row.confirmation);
  if (!parsed.success) throw new ValidationError("LEDGER_CONFIRMATION_INVALID");
  return parsed.data;
}

export function rowObligations(row: LedgerRow): string[] {
  const parsed = z.array(z.string()).max(8).safeParse(row.policy_obligations);
  if (!parsed.success) throw new ValidationError("LEDGER_OBLIGATIONS_INVALID");
  return parsed.data;
}
