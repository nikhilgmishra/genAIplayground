/**
 * Action ledger service: prepare -> trusted confirm -> commit -> reconcile (spec section 8;
 * ACT-01, ACT-02, ACT-03, OPS-01, AUTH-04).
 *
 * Commit protocol (no external call is made while a database transaction is open):
 *   0. AuthContext must be unexpired and unrevoked before anything is read (AUTH-04).
 *   1. Snapshot checks: session binding, generation, digest, ledger integrity. COMMITTED returns
 *      the stored receipt (no provider call). UNKNOWN or stale COMMITTING reconciles first by
 *      provider idempotency key and never blind-retries (ACT-03).
 *   2. CONFIRMED only; preparation unexpired; confirmation fresh; step-up bound to the digest.
 *   3. Re-authorization (deps.reauthorize) must allow; audit health must accept consequential work.
 *   4. tx1: lock row FOR UPDATE, verify row version unchanged, claim the per-record commit slot
 *      (partial unique index: one COMMITTING/UNKNOWN per record), set COMMITTING, append audit
 *      "action.commit.started". Audit failure rolls tx1 back => zero provider calls (OPS-01).
 *   5. provider.currentVersion must equal target.beforeVersion, checked while the slot is held;
 *      otherwise INVALIDATED / STATE_CHANGED with no provider call.
 *   6. provider.commit(action, stableKey). NOT_STARTED => back to CONFIRMED (retry reuses the same
 *      key). FAILED => FAILED. Ambiguous timeout or any unexpected exception => UNKNOWN.
 *   7. tx2: COMMITTED + receipt + audit "action.commit.succeeded" + outbox "action.committed" +
 *      hooks, atomically. The receipt is returned only after tx2 commits. If tx2 fails, the
 *      action is UNKNOWN (or stays COMMITTING after a crash) and the caller never sees success.
 */
import { z } from "zod";
import type { AuditHealth, AuditWriter } from "../audit/ports.js";
import type { Db, Queryable } from "../db/types.js";
import type { Logger } from "../observability/ports.js";
import { silentLogger } from "../observability/logger.js";
import type { Outbox } from "../outbox/ports.js";
import {
  ActionConfirmation,
  ActionKind,
  ActionTarget,
  AuditEventInput,
  AuthContext,
  CommitReceipt,
  IntegrationIdentity,
  PolicyDecision,
  PreparedAction,
  ReasonCode,
  SessionRef,
  Sha256Hex,
  opaqueIdWithPrefix,
} from "../protocol/index.js";
import type {
  ActionConfirmation as ActionConfirmationT,
  ActionState,
  AuditEvent,
  AuditOutcome,
  AuthContext as AuthContextT,
  CommitOutcome,
  CommitReceipt as CommitReceiptT,
  IntegrationIdentity as IntegrationIdentityT,
  PolicyDecision as PolicyDecisionT,
  PreparedAction as PreparedActionT,
} from "../protocol/index.js";
import { constantTimeEqualHex } from "../shared/canonical.js";
import type { Clock } from "../shared/clock.js";
import { addMs, iso } from "../shared/clock.js";
import {
  AccessDeniedError,
  AuditUnavailableError,
  ConflictError,
  DependencyError,
  PlatformError,
  SessionInvalidError,
  ValidationError,
} from "../shared/errors.js";
import { newId } from "../shared/ids.js";
import {
  bindingRefFromHash,
  computeActionDigest,
  evidenceHashOf,
  providerIdempotencyKeyFor,
  sessionRefHash,
  verifyActionDigest,
} from "./digest.js";
import type { LedgerRow, StoredConfirmation } from "./ledger-row.js";
import { LEDGER_COLUMNS, rowConfirmation, rowReceipt, rowState, rowToAction, toDate, toIsoOrNull } from "./ledger-row.js";
import type { ActionService, CommitDeps, PrepareInput, ProviderCommitPort, ProviderCommitResult, ProviderLookupResult } from "./ports.js";
import { ActionReason as R, STATE_CHANGE_PROVIDER_REASONS } from "./reasons.js";

// ---------------------------------------------------------------- configuration

export const ActionLedgerConfig = z.strictObject({
  /** Confirmation must be at most this old at commit time (ACT-01). */
  confirmationFreshSeconds: z.number().int().min(10).max(900),
  /** COMMITTING older than this is treated as a crashed attempt and reconciled. Must exceed the provider timeout. */
  committingStaleAfterSeconds: z.number().int().min(5).max(3_600),
  minPrepareTtlSeconds: z.number().int().min(5).max(3_600),
  maxPrepareTtlSeconds: z.number().int().min(5).max(3_600),
  /** Policy decisions older than this are not accepted for prepare/commit. */
  decisionMaxAgeSeconds: z.number().int().min(1).max(600),
  /** Tolerated clock skew for timestamps captured by trusted components. */
  clockSkewSeconds: z.number().int().min(0).max(60),
  auditStream: z.string().regex(/^[a-z0-9_.-]{3,64}$/),
});
export type ActionLedgerConfig = z.infer<typeof ActionLedgerConfig>;

export const DEFAULT_ACTION_LEDGER_CONFIG: ActionLedgerConfig = {
  confirmationFreshSeconds: 120,
  committingStaleAfterSeconds: 30,
  minPrepareTtlSeconds: 15,
  maxPrepareTtlSeconds: 900,
  decisionMaxAgeSeconds: 60,
  clockSkewSeconds: 5,
  auditStream: "actions",
};

export type CommittedHook = NonNullable<CommitDeps["onCommitted"]>;

export interface LedgerActionServiceOptions {
  db: Db;
  clock: Clock;
  audit: AuditWriter;
  auditHealth: AuditHealth;
  outbox: Outbox;
  logger?: Logger;
  config?: Partial<ActionLedgerConfig>;
  /**
   * Service-level hook run inside the COMMITTED transaction on every path (direct commit and
   * reconciliation). Per-call `CommitDeps.onCommitted` runs after it on the direct-commit path.
   */
  onCommitted?: CommittedHook;
}

/** Console/worker view of a ledger entry (opaque references and codes only). */
export interface LedgerEntryView {
  action: PreparedActionT;
  stateReason: string | null;
  receipt: CommitReceiptT | null;
  confirmedAt: string | null;
  confirmationMethod: StoredConfirmation["method"] | null;
  commitAttempts: number;
  committingSince: string | null;
  reconcileAttempts: number;
  lastReconciledAt: string | null;
  providerIdempotencyKey: string;
  rowVersion: number;
}

// ---------------------------------------------------------------- schemas and constants

const ActionId = opaqueIdWithPrefix("act");
const TenantId = z.string().regex(/^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$/);
const CommitInput = z.strictObject({ actionId: ActionId, digest: Sha256Hex });

const ChangeSchema = PreparedAction.shape.change.refine((c) => Object.keys(c).length <= 32);
const ImpactSchema = PreparedAction.shape.impact.refine((i) => i.fees === null || Math.abs(i.fees.minorUnits) <= 100_000_000);

const CommittedResult = z.strictObject({
  outcome: z.literal("COMMITTED"),
  providerReference: z.string().min(1).max(128),
  afterVersion: z.string().min(1).max(64).nullable(),
  evidence: z.record(z.string(), z.unknown()),
});
const FailedResult = z.strictObject({ outcome: z.literal("FAILED"), reasonCode: z.string(), permanent: z.boolean() });
const LookupResult = z.discriminatedUnion("outcome", [
  CommittedResult,
  z.strictObject({ outcome: z.literal("NOT_FOUND") }),
  z.strictObject({ outcome: z.literal("UNKNOWN") }),
]);

/** Which target systems each action kind may change (a billing action cannot target scheduling). */
const KIND_SYSTEMS: Record<ActionKind, readonly ActionTarget["system"][]> = {
  "appointment.reschedule": ["scheduling"],
  "appointment.create": ["scheduling"],
  "appointment.cancel": ["scheduling"],
  "billing.review.submit": ["billing"],
  "support_request.create": ["support_records", "internal"],
  "callback.schedule": ["internal", "support_records", "scheduling"],
};

/** Only trusted deterministic components may confirm (never the model-facing mcp_tools identity). */
const CONFIRMATION_METHODS_BY_CHANNEL: Partial<Record<IntegrationIdentityT["channel"], readonly ActionConfirmationT["method"][]>> = {
  telephony_control: ["dtmf_keypress", "deterministic_skill_affirmative", "human_agent"],
  portal: ["portal_approval"],
};

const PENDING_STATES: readonly ActionState[] = ["PREPARED", "CONFIRMED"];

type Scope = { tenantId: string; role: "app_runtime" | "app_worker" };

interface LedgerPatch {
  state?: ActionState;
  stateReason?: string | null;
  confirmation?: StoredConfirmation;
  confirmedAt?: string;
  commitAttemptId?: string | null;
  committingSince?: string | null;
  receipt?: CommitReceiptT;
  lastReconciledAt?: string;
  incrementCommitAttempts?: boolean;
  incrementReconcileAttempts?: boolean;
}

interface Rejection {
  error: PlatformError;
  /** Fail-safe transition applied (conditionally, by row version) before the error is thrown. */
  transition?: { to: "INVALIDATED" | "EXPIRED"; from: readonly ActionState[] };
  auditAction: string;
  turnId?: string | null;
  policy?: PolicyDecisionT | null;
}

interface AuditParams {
  action: string;
  outcome: AuditOutcome;
  reasonCode: string | null;
  turnId?: string | null;
  policy?: PolicyDecisionT | null;
  assurance?: AuthContextT["assurance"] | null;
  evidence?: string[];
  afterHash?: string | null;
  actorRef?: string | null;
}

const isUniqueViolation = (e: unknown): boolean => typeof e === "object" && e !== null && (e as { code?: unknown }).code === "23505";

function buildPrepareSchema(cfg: ActionLedgerConfig) {
  return z.strictObject({
    kind: ActionKind,
    target: ActionTarget,
    change: ChangeSchema,
    impact: ImpactSchema,
    confirmationTemplateId: PreparedAction.shape.confirmationTemplateId,
    ttlSeconds: z.number().int().min(cfg.minPrepareTtlSeconds).max(cfg.maxPrepareTtlSeconds),
    requiresStepUp: z.boolean(),
  });
}

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, reason: string): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new ValidationError(reason);
  return r.data;
}

// ---------------------------------------------------------------- service

export class LedgerActionService implements ActionService {
  readonly config: ActionLedgerConfig;
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly audit: AuditWriter;
  private readonly auditHealth: AuditHealth;
  private readonly outbox: Outbox;
  private readonly logger: Logger;
  private readonly serviceHook: CommittedHook | undefined;
  private readonly prepareSchema: ReturnType<typeof buildPrepareSchema>;

  constructor(opts: LedgerActionServiceOptions) {
    const cfg = ActionLedgerConfig.safeParse({ ...DEFAULT_ACTION_LEDGER_CONFIG, ...(opts.config ?? {}) });
    if (!cfg.success || cfg.data.minPrepareTtlSeconds > cfg.data.maxPrepareTtlSeconds) throw new ValidationError("ACTION_LEDGER_CONFIG_INVALID");
    this.config = cfg.data;
    this.db = opts.db;
    this.clock = opts.clock;
    this.audit = opts.audit;
    this.auditHealth = opts.auditHealth;
    this.outbox = opts.outbox;
    this.logger = opts.logger ?? silentLogger;
    this.serviceHook = opts.onCommitted;
    this.prepareSchema = buildPrepareSchema(this.config);
  }

  // ------------------------------------------------------------ prepare

  async prepare(ctx: AuthContextT, input: PrepareInput, decision: PolicyDecisionT): Promise<PreparedActionT> {
    const now = this.clock.now();
    const auth = parseOrThrow(AuthContext, ctx, R.INVALID_AUTH_CONTEXT);
    this.assertSessionUsable(auth, now);
    const inp = parseOrThrow(this.prepareSchema, input, R.INVALID_PREPARE_INPUT);
    const dec = parseOrThrow(PolicyDecision, decision, R.INVALID_POLICY_DECISION);
    if (!dec.allow) throw new AccessDeniedError(R.POLICY_DENIED);
    if (!dec.obligations.includes("REQUIRE_CONFIRMATION")) throw new AccessDeniedError(R.CONFIRMATION_OBLIGATION_MISSING);
    if (dec.obligations.includes("REQUIRE_HUMAN")) throw new AccessDeniedError(R.HUMAN_REQUIRED);
    if (!this.decisionFresh(dec, now)) throw new AccessDeniedError(R.POLICY_DECISION_STALE);
    if (auth.riskFlags.includes("SAFETY_ESCALATION_ACTIVE")) throw new AccessDeniedError("SAFETY_ESCALATION_ACTIVE");
    if (!auth.actorId) throw new AccessDeniedError(R.ACTOR_REQUIRED);
    if (!auth.subjectId) throw new AccessDeniedError(R.SUBJECT_REQUIRED);
    if (!KIND_SYSTEMS[inp.kind].includes(inp.target.system)) throw new ValidationError(R.KIND_TARGET_MISMATCH);

    // Nothing consequential is offered for confirmation while durable evidence cannot be written.
    await this.auditHealth.assertCanAcceptConsequential();

    const sessionHash = sessionRefHash(auth.sessionRef);
    const actionId = newId("act");
    const fields = {
      actionId,
      kind: inp.kind,
      tenantId: auth.tenantId,
      sessionRef: bindingRefFromHash(sessionHash),
      sessionGeneration: auth.sessionGeneration,
      actorId: auth.actorId,
      subjectId: auth.subjectId,
      target: inp.target,
      change: inp.change,
      impact: inp.impact,
      policyDecisionId: dec.decisionId,
      policyVersion: dec.policyVersion,
      preparedAt: iso(now),
      expiresAt: iso(addMs(now, inp.ttlSeconds * 1000)),
      confirmationTemplateId: inp.confirmationTemplateId,
      requiresStepUp: inp.requiresStepUp || dec.obligations.includes("REQUIRE_STEP_UP"),
    };
    const action = PreparedAction.parse({ ...fields, digest: computeActionDigest(fields), state: "PREPARED" });

    await this.db.tx(
      async (tx) => {
        // A changed request supersedes this session's pending actions on the same record.
        const pending = await tx.query<LedgerRow>(
          `select ${LEDGER_COLUMNS} from action_ledger
           where tenant_id = $1 and session_ref_hash = $2 and state in ('PREPARED', 'CONFIRMED')
             and target ->> 'system' = $3 and target ->> 'recordRef' = $4
           for update`,
          [auth.tenantId, sessionHash, inp.target.system, inp.target.recordRef],
        );
        for (const row of pending.rows) {
          const updated = await this.patch(tx, row, { state: "INVALIDATED", stateReason: R.SUPERSEDED }, now);
          if (updated) await this.appendAudit(tx, updated, { action: "action.invalidate", outcome: "INVALIDATED", reasonCode: R.SUPERSEDED });
        }
        const inserted = await tx.query<LedgerRow>(
          `insert into action_ledger (action_id, tenant_id, session_ref_hash, session_generation, call_id, actor_id, actor_role,
              subject_id, kind, target, change, impact, digest, state, state_reason, policy_decision_id, policy_version,
              policy_obligations, requires_step_up, confirmation_template_id, prepared_assurance, prepared_at, expires_at,
              provider_idempotency_key, created_at, updated_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12::jsonb, $13, 'PREPARED', null, $14, $15,
              $16::jsonb, $17, $18, $19, $20, $21, $22, $20, $20)
           returning ${LEDGER_COLUMNS}`,
          [
            action.actionId,
            action.tenantId,
            sessionHash,
            action.sessionGeneration,
            auth.callId,
            action.actorId,
            auth.selectedRole,
            action.subjectId,
            action.kind,
            JSON.stringify(action.target),
            JSON.stringify(action.change),
            JSON.stringify(action.impact),
            action.digest,
            action.policyDecisionId,
            action.policyVersion,
            JSON.stringify(dec.obligations),
            action.requiresStepUp,
            action.confirmationTemplateId,
            auth.assurance,
            action.preparedAt,
            action.expiresAt,
            providerIdempotencyKeyFor(action.actionId),
          ],
        );
        const row = inserted.rows[0];
        if (!row) throw new ConflictError(R.CONCURRENT_MODIFICATION);
        await tx.query("insert into action_locator (action_id, tenant_id, session_ref_hash, created_at) values ($1, $2, $3, $4)", [
          action.actionId,
          action.tenantId,
          sessionHash,
          action.preparedAt,
        ]);
        await this.appendAudit(tx, row, {
          action: "action.prepare",
          outcome: "PENDING",
          reasonCode: null,
          policy: dec,
          assurance: auth.assurance,
        });
      },
      { role: "app_runtime", rls: { tenantId: auth.tenantId } },
    );
    this.logger.info("action.prepared", { actionId, kind: action.kind });
    return action;
  }

  // ------------------------------------------------------------ confirm

  async confirm(confirmation: ActionConfirmationT, integration: IntegrationIdentityT): Promise<PreparedActionT> {
    const now = this.clock.now();
    const integ = parseOrThrow(IntegrationIdentity, integration, R.INVALID_INTEGRATION);
    const conf = parseOrThrow(ActionConfirmation, confirmation, R.INVALID_CONFIRMATION);
    const scope: Scope = { tenantId: integ.tenantId, role: "app_runtime" };

    const allowedMethods = CONFIRMATION_METHODS_BY_CHANNEL[integ.channel];
    if (!allowedMethods || !allowedMethods.includes(conf.method)) {
      const reason = allowedMethods ? R.CONFIRMATION_METHOD_CHANNEL_MISMATCH : R.CONFIRMATION_CHANNEL_NOT_TRUSTED;
      this.logger.warn("action.confirm.untrusted", { actionId: conf.actionId, channel: integ.channel, reasonCode: reason });
      const row = await this.load(scope, conf.actionId).catch(() => null);
      if (row) return this.reject(row, scope, { error: new AccessDeniedError(reason), auditAction: "action.confirm.rejected", turnId: conf.turnId });
      throw new AccessDeniedError(reason);
    }

    let binding: string | null;
    try {
      binding = sessionRefHash(conf.sessionRef);
    } catch {
      binding = null;
    }

    type Outcome = { kind: "ok"; row: LedgerRow } | { kind: "notfound" } | ({ kind: "reject"; row: LedgerRow } & Omit<Rejection, "auditAction">);
    const outcome = await this.db.tx<Outcome>(
      async (tx) => {
        const row = await this.lockRow(tx, conf.actionId);
        if (!row) return { kind: "notfound" };
        const state = rowState(row);
        if (!binding || !constantTimeEqualHex(row.session_ref_hash, binding)) {
          return { kind: "reject", row, error: new AccessDeniedError(R.CONFIRMATION_SESSION_MISMATCH) };
        }
        if (state === "CONFIRMED") {
          const stored = rowConfirmation(row);
          const same =
            stored !== null &&
            stored.digest === conf.digest &&
            stored.turnId === conf.turnId &&
            stored.sessionGeneration === conf.sessionGeneration &&
            stored.method === conf.method &&
            stored.capturedAt === conf.capturedAt;
          // Redelivered identical confirmation is idempotent; anything else is rejected.
          if (same) return { kind: "ok", row };
          return { kind: "reject", row, error: new ConflictError(R.ACTION_ALREADY_CONFIRMED) };
        }
        if (state !== "PREPARED") return { kind: "reject", row, error: new ConflictError(R.ACTION_NOT_CONFIRMABLE) };

        const expiresAt = toDate(row.expires_at);
        const preparedAt = toDate(row.prepared_at);
        const captured = new Date(conf.capturedAt);
        const invalidate = { to: "INVALIDATED", from: ["PREPARED"] } as const;
        const expire = { to: "EXPIRED", from: ["PREPARED"] } as const;
        if (now.getTime() >= expiresAt.getTime()) return { kind: "reject", row, error: new ConflictError(R.PREPARATION_EXPIRED), transition: expire };
        if (conf.sessionGeneration !== row.session_generation) {
          return { kind: "reject", row, error: new SessionInvalidError(R.SESSION_GENERATION_CHANGED), transition: invalidate };
        }
        if (!constantTimeEqualHex(conf.digest, row.digest)) {
          return { kind: "reject", row, error: new AccessDeniedError(R.CONFIRMATION_DIGEST_MISMATCH), transition: invalidate };
        }
        if (captured.getTime() < preparedAt.getTime()) {
          return { kind: "reject", row, error: new AccessDeniedError(R.CONFIRMATION_PREDATES_PREPARATION), transition: invalidate };
        }
        if (captured.getTime() > now.getTime() + this.config.clockSkewSeconds * 1000) {
          return { kind: "reject", row, error: new AccessDeniedError(R.CONFIRMATION_IN_FUTURE), transition: invalidate };
        }
        if (captured.getTime() >= expiresAt.getTime()) return { kind: "reject", row, error: new ConflictError(R.CONFIRMATION_AFTER_EXPIRY), transition: expire };
        if (now.getTime() - captured.getTime() > this.config.confirmationFreshSeconds * 1000) {
          return { kind: "reject", row, error: new AccessDeniedError(R.CONFIRMATION_STALE), transition: invalidate };
        }
        if (!verifyActionDigest(rowToAction(row))) {
          this.logger.error("action.ledger.integrity_violation", { actionId: row.action_id });
          return { kind: "reject", row, error: new AccessDeniedError(R.LEDGER_INTEGRITY_VIOLATION) };
        }
        const anchor = new Date(Math.min(captured.getTime(), now.getTime()));
        const stored: StoredConfirmation = {
          actionId: conf.actionId,
          digest: conf.digest,
          sessionBinding: bindingRefFromHash(row.session_ref_hash),
          sessionGeneration: conf.sessionGeneration,
          turnId: conf.turnId,
          method: conf.method,
          capturedBy: conf.capturedBy,
          capturedAt: conf.capturedAt,
          receivedAt: iso(now),
          integrationId: integ.integrationId,
          channel: integ.channel === "portal" ? "portal" : "telephony_control",
        };
        const updated = await this.patch(tx, row, { state: "CONFIRMED", stateReason: null, confirmation: stored, confirmedAt: iso(anchor) }, now);
        if (!updated) throw new ConflictError(R.CONCURRENT_MODIFICATION, R.CONCURRENT_MODIFICATION, true);
        await this.appendAudit(tx, updated, {
          action: "action.confirm",
          outcome: "SUCCEEDED",
          reasonCode: null,
          turnId: conf.turnId,
        });
        return { kind: "ok", row: updated };
      },
      { role: scope.role, rls: { tenantId: scope.tenantId } },
    );
    if (outcome.kind === "notfound") throw new AccessDeniedError(R.ACTION_NOT_FOUND);
    if (outcome.kind === "reject") {
      return this.reject(outcome.row, scope, { ...outcome, auditAction: "action.confirm.rejected", turnId: conf.turnId });
    }
    return this.effective(rowToAction(outcome.row), now);
  }

  // ------------------------------------------------------------ invalidate / expire / cancel

  async invalidatePending(sessionRef: string, reasonCode: string): Promise<number> {
    if (!SessionRef.safeParse(sessionRef).success) throw new ValidationError("SESSION_REF_INVALID");
    const reason = parseOrThrow(ReasonCode, reasonCode, R.INVALID_REASON_CODE);
    const hash = sessionRefHash(sessionRef);
    const tenants = await this.db.tx(
      async (tx) =>
        (await tx.query<{ tenant_id: string }>("select distinct tenant_id from action_locator where session_ref_hash = $1", [hash])).rows.map(
          (r) => r.tenant_id,
        ),
      { role: "app_worker" },
    );
    let count = 0;
    for (const tenantId of tenants) {
      count += await this.transitionMany(
        { tenantId, role: "app_runtime" },
        `session_ref_hash = $1 and state in ('PREPARED', 'CONFIRMED')`,
        [hash],
        "INVALIDATED",
        reason,
        "action.invalidate",
      );
    }
    if (count > 0) this.logger.info("action.invalidated", { reasonCode: reason, invalidatedCount: count });
    return count;
  }

  /** Worker sweep: PREPARED/CONFIRMED past expiry become EXPIRED (reads already enforce expiry). */
  async expireDue(tenantId: string, limit = 100): Promise<number> {
    const tenant = parseOrThrow(TenantId, tenantId, R.INVALID_AUTH_CONTEXT);
    const max = parseOrThrow(z.number().int().min(1).max(1_000), limit, R.INVALID_COMMIT_INPUT);
    const now = this.clock.now();
    return this.transitionMany(
      { tenantId: tenant, role: "app_worker" },
      `action_id in (select action_id from action_ledger where state in ('PREPARED', 'CONFIRMED') and expires_at <= $1
                     order by expires_at limit ${max})`,
      [iso(now)],
      "EXPIRED",
      R.PREPARATION_EXPIRED,
      "action.expire",
    );
  }

  /** Operator/console cancellation of uncommitted work. Audited; fails closed without audit. */
  async cancelPending(tenantId: string, actionId: string, input: { reasonCode: string; actorRef: string }): Promise<PreparedActionT> {
    const tenant = parseOrThrow(TenantId, tenantId, R.INVALID_AUTH_CONTEXT);
    const id = parseOrThrow(ActionId, actionId, R.INVALID_COMMIT_INPUT);
    const reason = parseOrThrow(ReasonCode, input.reasonCode, R.INVALID_REASON_CODE);
    const actorRef = parseOrThrow(opaqueIdWithPrefix("stf").or(opaqueIdWithPrefix("act")), input.actorRef, R.INVALID_AUTH_CONTEXT);
    const now = this.clock.now();
    const row = await this.db.tx(
      async (tx) => {
        const locked = await this.lockRow(tx, id);
        if (!locked) throw new AccessDeniedError(R.ACTION_NOT_FOUND);
        if (!PENDING_STATES.includes(rowState(locked))) throw new ConflictError(R.ACTION_NOT_CANCELLABLE);
        const updated = await this.patch(tx, locked, { state: "CANCELLED", stateReason: reason }, now);
        if (!updated) throw new ConflictError(R.CONCURRENT_MODIFICATION, R.CONCURRENT_MODIFICATION, true);
        await this.appendAudit(tx, updated, { action: "action.cancel", outcome: "INVALIDATED", reasonCode: reason, actorRef });
        return updated;
      },
      { role: "app_runtime", rls: { tenantId: tenant } },
    );
    return rowToAction(row);
  }

  // ------------------------------------------------------------ commit

  async commit(ctx: AuthContextT, input: { actionId: string; digest: string }, deps: CommitDeps): Promise<CommitReceiptT> {
    const auth = parseOrThrow(AuthContext, ctx, R.INVALID_AUTH_CONTEXT);
    // AUTH-04: an expired or revoked context fails closed before any ledger read.
    this.assertSessionUsable(auth, this.clock.now());
    const req = parseOrThrow(CommitInput, input, R.INVALID_COMMIT_INPUT);
    if (!deps || typeof deps.reauthorize !== "function" || !deps.provider) throw new ValidationError(R.INVALID_COMMIT_INPUT);
    const binding = sessionRefHash(auth.sessionRef);
    const scope: Scope = { tenantId: auth.tenantId, role: "app_runtime" };

    // At most one reconciliation round: NOT_FOUND returns the action to CONFIRMED (same provider key).
    for (let round = 0; round < 2; round++) {
      const row = await this.load(scope, req.actionId);
      if (!row) {
        this.logger.warn("action.commit.not_found", { actionId: req.actionId });
        throw new AccessDeniedError(R.ACTION_NOT_FOUND);
      }
      const state = rowState(row);
      const rejected = "action.commit.rejected";
      if (!constantTimeEqualHex(row.session_ref_hash, binding)) {
        return this.reject(row, scope, { error: new AccessDeniedError(R.SESSION_MISMATCH), auditAction: rejected });
      }
      if (!constantTimeEqualHex(row.digest, req.digest)) {
        return this.reject(row, scope, {
          error: new AccessDeniedError(R.DIGEST_MISMATCH),
          transition: { to: "INVALIDATED", from: PENDING_STATES },
          auditAction: rejected,
        });
      }
      if (row.session_generation !== auth.sessionGeneration) {
        return this.reject(row, scope, {
          error: new SessionInvalidError(R.SESSION_GENERATION_CHANGED),
          transition: { to: "INVALIDATED", from: PENDING_STATES },
          auditAction: rejected,
        });
      }
      const action = rowToAction(row);
      if (!verifyActionDigest(action)) {
        this.logger.error("action.ledger.integrity_violation", { actionId: row.action_id });
        return this.reject(row, scope, { error: new AccessDeniedError(R.LEDGER_INTEGRITY_VIOLATION), auditAction: rejected });
      }
      if (state === "COMMITTED") {
        // Idempotent replay: stored receipt, no provider call (ACT-02).
        const receipt = rowReceipt(row);
        if (!receipt) throw new ConflictError(R.LEDGER_INTEGRITY_VIOLATION);
        return receipt;
      }
      if (state === "UNKNOWN" || state === "COMMITTING") {
        if (state === "COMMITTING" && !this.isStaleCommitting(row, this.clock.now())) {
          throw new ConflictError(R.COMMIT_IN_PROGRESS, R.COMMIT_IN_PROGRESS, true);
        }
        // ACT-03: reconcile by provider idempotency key before any retry.
        const reconciled = await this.reconcileRow(scope, row, deps.provider, deps.onCommitted);
        if (reconciled.outcome === "NOT_STARTED") continue;
        return reconciled;
      }
      if (state === "PREPARED") return this.reject(row, scope, { error: new ConflictError(R.ACTION_NOT_CONFIRMED), auditAction: rejected });
      if (state !== "CONFIRMED") return this.reject(row, scope, { error: new ConflictError(R.ACTION_NOT_COMMITTABLE), auditAction: rejected });
      return this.commitConfirmed(auth, scope, row, action, deps);
    }
    throw new ConflictError(R.RECONCILE_LOOP);
  }

  private async commitConfirmed(auth: AuthContextT, scope: Scope, row: LedgerRow, action: PreparedActionT, deps: CommitDeps): Promise<CommitReceiptT> {
    const rejected = "action.commit.rejected";
    const now = this.clock.now();
    if (now.getTime() >= toDate(row.expires_at).getTime()) {
      return this.reject(row, scope, {
        error: new ConflictError(R.PREPARATION_EXPIRED),
        transition: { to: "EXPIRED", from: ["CONFIRMED"] },
        auditAction: rejected,
      });
    }
    if (!this.confirmationFresh(row, now)) {
      return this.reject(row, scope, {
        error: new ConflictError(R.CONFIRMATION_STALE),
        transition: { to: "EXPIRED", from: ["CONFIRMED"] },
        auditAction: rejected,
      });
    }
    if (auth.riskFlags.includes("SAFETY_ESCALATION_ACTIVE")) {
      return this.reject(row, scope, {
        error: new AccessDeniedError("SAFETY_ESCALATION_ACTIVE"),
        transition: { to: "INVALIDATED", from: ["CONFIRMED"] },
        auditAction: rejected,
      });
    }

    // Re-authorization with current session state (outside any transaction).
    let decision: PolicyDecisionT;
    try {
      decision = PolicyDecision.parse(await deps.reauthorize(action));
    } catch {
      return this.reject(row, scope, { error: new AccessDeniedError(R.POLICY_EVALUATION_FAILED), auditAction: rejected });
    }
    if (!decision.allow) return this.reject(row, scope, { error: new AccessDeniedError(R.POLICY_DENIED), auditAction: rejected, policy: decision });
    if (decision.obligations.includes("REQUIRE_HUMAN")) {
      return this.reject(row, scope, { error: new AccessDeniedError(R.HUMAN_REQUIRED), auditAction: rejected, policy: decision });
    }
    if (!this.decisionFresh(decision, now)) {
      return this.reject(row, scope, { error: new AccessDeniedError(R.POLICY_DECISION_STALE), auditAction: rejected, policy: decision });
    }
    const stepUpRequired = row.requires_step_up || decision.obligations.includes("REQUIRE_STEP_UP");
    if (stepUpRequired && !this.stepUpValid(auth, row, now)) {
      return this.reject(row, scope, { error: new AccessDeniedError(R.STEP_UP_REQUIRED), auditAction: rejected, policy: decision });
    }

    // OPS-01: block before any provider call when durable evidence cannot be written.
    await this.auditHealth.assertCanAcceptConsequential();

    // tx1: claim the commit.
    const attemptId = newId("cat");
    let committing: LedgerRow;
    try {
      committing = await this.db.tx(
        async (tx) => {
          const locked = await this.lockRow(tx, row.action_id);
          if (!locked || locked.row_version !== row.row_version) throw new ConflictError(R.CONCURRENT_MODIFICATION, R.CONCURRENT_MODIFICATION, true);
          const t = this.clock.now();
          if (t.getTime() >= toDate(locked.expires_at).getTime() || !this.confirmationFresh(locked, t)) {
            throw new ConflictError(R.CONFIRMATION_STALE, R.CONFIRMATION_STALE, true);
          }
          const target = action.target;
          const busy = await tx.query(
            `select 1 from action_ledger where tenant_id = $1 and target ->> 'system' = $2 and target ->> 'recordRef' = $3
               and state in ('COMMITTING', 'UNKNOWN') and action_id <> $4 limit 1`,
            [locked.tenant_id, target.system, target.recordRef, locked.action_id],
          );
          if (busy.rowCount > 0) throw new ConflictError(R.RECORD_COMMIT_IN_PROGRESS, R.RECORD_COMMIT_IN_PROGRESS, true);
          const updated = await this.patch(
            tx,
            locked,
            { state: "COMMITTING", stateReason: null, commitAttemptId: attemptId, committingSince: iso(t), incrementCommitAttempts: true },
            t,
          );
          if (!updated) throw new ConflictError(R.CONCURRENT_MODIFICATION, R.CONCURRENT_MODIFICATION, true);
          await this.appendAudit(tx, updated, {
            action: "action.commit.started",
            outcome: "PENDING",
            reasonCode: null,
            policy: decision,
            assurance: auth.assurance,
          });
          return updated;
        },
        { role: scope.role, rls: { tenantId: scope.tenantId } },
      );
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictError(R.RECORD_COMMIT_IN_PROGRESS, R.RECORD_COMMIT_IN_PROGRESS, true);
      throw err;
    }

    const committingAction = rowToAction(committing);

    // Optimistic concurrency against the system of record while this action holds the record slot.
    let current: unknown;
    try {
      current = await deps.provider.currentVersion(committingAction);
    } catch {
      await this.revertNotStarted(scope, committing, R.PROVIDER_VERSION_UNAVAILABLE);
      throw new DependencyError(R.PROVIDER_VERSION_UNAVAILABLE, "NOT_STARTED");
    }
    if (current !== action.target.beforeVersion) {
      return this.reject(committing, scope, {
        error: new ConflictError(R.STATE_CHANGED),
        transition: { to: "INVALIDATED", from: ["COMMITTING"] },
        auditAction: rejected,
      });
    }

    let raw: unknown;
    try {
      raw = await deps.provider.commit(committingAction, committing.provider_idempotency_key);
    } catch (err) {
      if (err instanceof DependencyError && err.outcome === "NOT_STARTED") {
        // Provably not sent: return to CONFIRMED; any bounded retry reuses the same provider key.
        await this.revertNotStarted(scope, committing, R.PROVIDER_NOT_STARTED);
        throw new DependencyError(R.PROVIDER_NOT_STARTED, "NOT_STARTED", true);
      }
      if (err instanceof DependencyError && err.outcome === "FAILED") {
        raw = { outcome: "FAILED", reasonCode: err.reasonCode, permanent: !err.retryable };
      } else {
        // Ambiguous timeout or unexpected exception: the effect may have happened (ACT-03).
        return this.markUnknown(scope, committing, err instanceof DependencyError ? R.COMMIT_OUTCOME_UNKNOWN : R.PROVIDER_EXCEPTION);
      }
    }

    const committed = CommittedResult.safeParse(raw);
    if (!committed.success) {
      const failed = FailedResult.safeParse(raw);
      if (!failed.success) return this.markUnknown(scope, committing, R.PROVIDER_RESPONSE_INVALID);
      if (STATE_CHANGE_PROVIDER_REASONS.has(failed.data.reasonCode)) {
        return this.reject(committing, scope, {
          error: new ConflictError(R.STATE_CHANGED),
          transition: { to: "INVALIDATED", from: ["COMMITTING"] },
          auditAction: rejected,
        });
      }
      const reason = ReasonCode.safeParse(failed.data.reasonCode).success ? failed.data.reasonCode : R.PROVIDER_REJECTED;
      return this.markFailed(scope, committing, reason);
    }

    try {
      return await this.recordCommitted(scope, committing.action_id, committed.data, { reconciled: false, hook: deps.onCommitted });
    } catch (err) {
      this.logger.error("action.commit.recording_failed", {
        actionId: committing.action_id,
        reasonCode: err instanceof PlatformError ? err.reasonCode : "UNEXPECTED_ERROR",
      });
      return this.markUnknown(scope, committing, R.COMMIT_RECORDING_FAILED);
    }
  }

  // ------------------------------------------------------------ reconcile

  async reconcile(actionId: string, provider: ProviderCommitPort): Promise<CommitReceiptT> {
    const id = parseOrThrow(ActionId, actionId, R.INVALID_COMMIT_INPUT);
    const tenantId = await this.db.tx(
      async (tx) => (await tx.query<{ tenant_id: string }>("select tenant_id from action_locator where action_id = $1", [id])).rows[0]?.tenant_id ?? null,
      { role: "app_worker" },
    );
    if (!tenantId) throw new AccessDeniedError(R.ACTION_NOT_FOUND);
    const scope: Scope = { tenantId, role: "app_worker" };
    const row = await this.load(scope, id);
    if (!row) throw new AccessDeniedError(R.ACTION_NOT_FOUND);
    return this.reconcileRow(scope, row, provider, undefined);
  }

  private async reconcileRow(scope: Scope, row: LedgerRow, provider: ProviderCommitPort, hook: CommittedHook | undefined): Promise<CommitReceiptT> {
    const state = rowState(row);
    if (state === "COMMITTED") {
      const receipt = rowReceipt(row);
      if (!receipt) throw new ConflictError(R.LEDGER_INTEGRITY_VIOLATION);
      return receipt;
    }
    if (state !== "UNKNOWN" && state !== "COMMITTING") throw new ConflictError(R.ACTION_NOT_RECONCILABLE);
    if (state === "COMMITTING" && !this.isStaleCommitting(row, this.clock.now())) throw new ConflictError(R.COMMIT_IN_PROGRESS, R.COMMIT_IN_PROGRESS, true);

    // A lookup that throws or returns an unexpected shape is inconclusive: the action stays in doubt.
    const lookup: ProviderLookupResult | null = await Promise.resolve()
      .then(() => provider.lookup(rowToAction(row), row.provider_idempotency_key))
      .then((raw) => {
        const parsed = LookupResult.safeParse(raw);
        return parsed.success ? parsed.data : null;
      })
      .catch(() => null);
    if (lookup?.outcome === "COMMITTED") return this.recordCommitted(scope, row.action_id, lookup, { reconciled: true, hook });
    if (lookup?.outcome === "NOT_FOUND") return this.recordNotFound(scope, row);
    return this.recordInconclusive(scope, row);
  }

  private async recordNotFound(scope: Scope, row: LedgerRow): Promise<CommitReceiptT> {
    return this.db.tx(
      async (tx) => {
        const locked = await this.lockRow(tx, row.action_id);
        if (!locked) throw new AccessDeniedError(R.ACTION_NOT_FOUND);
        if (rowState(locked) === "COMMITTED") return rowReceipt(locked) ?? this.integrityFailure();
        if (locked.row_version !== row.row_version) throw new ConflictError(R.CONCURRENT_MODIFICATION, R.CONCURRENT_MODIFICATION, true);
        const now = this.clock.now();
        // Provider has no record for the key: treat as NOT_STARTED. Back to CONFIRMED only while
        // the original confirmation is still fresh; otherwise a new preparation is required.
        const fresh = now.getTime() < toDate(locked.expires_at).getTime() && this.confirmationFresh(locked, now);
        const updated = await this.patch(
          tx,
          locked,
          {
            state: fresh ? "CONFIRMED" : "EXPIRED",
            stateReason: R.PROVIDER_NOT_FOUND,
            committingSince: null,
            incrementReconcileAttempts: true,
            lastReconciledAt: iso(now),
          },
          now,
        );
        if (!updated) throw new ConflictError(R.CONCURRENT_MODIFICATION, R.CONCURRENT_MODIFICATION, true);
        const ev = await this.appendAudit(tx, updated, { action: "action.reconciled", outcome: "RECONCILED", reasonCode: R.PROVIDER_NOT_FOUND });
        return this.transientReceipt(updated, "NOT_STARTED", ev.eventId, true);
      },
      { role: scope.role, rls: { tenantId: scope.tenantId } },
    );
  }

  private async recordInconclusive(scope: Scope, row: LedgerRow): Promise<CommitReceiptT> {
    return this.db.tx(
      async (tx) => {
        const locked = await this.lockRow(tx, row.action_id);
        if (!locked) throw new AccessDeniedError(R.ACTION_NOT_FOUND);
        if (rowState(locked) === "COMMITTED") return rowReceipt(locked) ?? this.integrityFailure();
        if (locked.row_version !== row.row_version) throw new ConflictError(R.CONCURRENT_MODIFICATION, R.CONCURRENT_MODIFICATION, true);
        const now = this.clock.now();
        const updated = await this.patch(
          tx,
          locked,
          { state: "UNKNOWN", stateReason: R.RECONCILE_INCONCLUSIVE, incrementReconcileAttempts: true, lastReconciledAt: iso(now) },
          now,
        );
        if (!updated) throw new ConflictError(R.CONCURRENT_MODIFICATION, R.CONCURRENT_MODIFICATION, true);
        const ev = await this.appendAudit(tx, updated, { action: "action.reconcile.inconclusive", outcome: "UNKNOWN", reasonCode: R.RECONCILE_INCONCLUSIVE });
        return this.transientReceipt(updated, "UNKNOWN", ev.eventId, true);
      },
      { role: scope.role, rls: { tenantId: scope.tenantId } },
    );
  }

  // ------------------------------------------------------------ queries

  async get(tenantId: string, actionId: string): Promise<PreparedActionT | null> {
    const tenant = parseOrThrow(TenantId, tenantId, R.INVALID_AUTH_CONTEXT);
    const id = parseOrThrow(ActionId, actionId, R.INVALID_COMMIT_INPUT);
    const row = await this.load({ tenantId: tenant, role: "app_runtime" }, id);
    return row ? this.effective(rowToAction(row), this.clock.now()) : null;
  }

  async describe(tenantId: string, actionId: string): Promise<LedgerEntryView | null> {
    const tenant = parseOrThrow(TenantId, tenantId, R.INVALID_AUTH_CONTEXT);
    const id = parseOrThrow(ActionId, actionId, R.INVALID_COMMIT_INPUT);
    const row = await this.load({ tenantId: tenant, role: "app_worker" }, id);
    if (!row) return null;
    const confirmation = rowConfirmation(row);
    return {
      action: this.effective(rowToAction(row), this.clock.now()),
      stateReason: row.state_reason,
      receipt: rowReceipt(row),
      confirmedAt: toIsoOrNull(row.confirmed_at),
      confirmationMethod: confirmation?.method ?? null,
      commitAttempts: row.commit_attempts,
      committingSince: toIsoOrNull(row.committing_since),
      reconcileAttempts: row.reconcile_attempts,
      lastReconciledAt: toIsoOrNull(row.last_reconciled_at),
      providerIdempotencyKey: row.provider_idempotency_key,
      rowVersion: row.row_version,
    };
  }

  async listNeedingReconciliation(tenantId: string, limit: number): Promise<PreparedActionT[]> {
    const tenant = parseOrThrow(TenantId, tenantId, R.INVALID_AUTH_CONTEXT);
    const max = parseOrThrow(z.number().int().min(1).max(500), limit, R.INVALID_COMMIT_INPUT);
    const staleBefore = addMs(this.clock.now(), -this.config.committingStaleAfterSeconds * 1000);
    const rows = await this.db.tx(
      async (tx) =>
        (
          await tx.query<LedgerRow>(
            `select ${LEDGER_COLUMNS} from action_ledger
             where tenant_id = $1 and (state = 'UNKNOWN' or (state = 'COMMITTING' and committing_since <= $2))
             order by updated_at, action_id limit $3`,
            [tenant, iso(staleBefore), max],
          )
        ).rows,
      { role: "app_worker", rls: { tenantId: tenant } },
    );
    return rows.map(rowToAction);
  }

  // ------------------------------------------------------------ commit outcome recording

  private async recordCommitted(
    scope: Scope,
    actionId: string,
    result: Extract<ProviderCommitResult, { outcome: "COMMITTED" }>,
    opts: { reconciled: boolean; hook: CommittedHook | undefined },
  ): Promise<CommitReceiptT> {
    return this.db.tx(
      async (tx) => {
        const locked = await this.lockRow(tx, actionId);
        if (!locked) throw new AccessDeniedError(R.ACTION_NOT_FOUND);
        const state = rowState(locked);
        if (state === "COMMITTED") return rowReceipt(locked) ?? this.integrityFailure();
        if (state === "FAILED" || state === "PREPARED") {
          this.logger.error("action.ledger.provider_contradiction", { actionId, state });
          throw new ConflictError(R.LEDGER_PROVIDER_CONTRADICTION);
        }
        const now = this.clock.now();
        const target = ActionTarget.parse(locked.target);
        const receiptId = newId("rcp");
        const evidence = evidenceHashOf({
          providerSystem: target.system,
          providerReference: result.providerReference,
          afterVersion: result.afterVersion,
          evidence: result.evidence,
        });
        if (!evidence.canonical) this.logger.warn("action.commit.evidence_non_canonical", { actionId });
        const late = state !== "COMMITTING" && state !== "UNKNOWN";
        const reason = late ? R.LATE_PROVIDER_CONFIRMATION : opts.reconciled ? R.PROVIDER_CONFIRMED_COMMIT : null;
        const auditEvent = await this.appendAudit(tx, locked, {
          action: opts.reconciled ? "action.reconciled" : "action.commit.succeeded",
          outcome: opts.reconciled ? "RECONCILED" : "SUCCEEDED",
          reasonCode: reason,
          evidence: [`receipt:${receiptId}`],
          afterHash: evidence.hash,
        });
        const receipt = CommitReceipt.parse({
          receiptId,
          actionId,
          idempotencyKey: actionId,
          outcome: "COMMITTED",
          providerSystem: target.system,
          providerReference: result.providerReference,
          providerIdempotencyKey: locked.provider_idempotency_key,
          afterVersion: result.afterVersion,
          committedAt: iso(now),
          recordedAt: iso(now),
          evidenceHash: evidence.hash,
          auditEventId: auditEvent.eventId,
          reconciled: opts.reconciled,
        });
        const updated = await this.patch(
          tx,
          locked,
          {
            state: "COMMITTED",
            stateReason: reason,
            receipt,
            committingSince: null,
            ...(opts.reconciled ? { incrementReconcileAttempts: true, lastReconciledAt: iso(now) } : {}),
          },
          now,
        );
        if (!updated) throw new ConflictError(R.CONCURRENT_MODIFICATION, R.CONCURRENT_MODIFICATION, true);
        await this.outbox.enqueue(tx, {
          topic: "action.committed",
          key: `${target.system}:${target.recordRef}`,
          payload: {
            actionId,
            kind: updated.kind,
            receiptId,
            auditEventId: auditEvent.eventId,
            providerSystem: target.system,
            reconciled: opts.reconciled,
          },
          dedupeKey: `action.committed:${actionId}`,
        });
        const committedAction = rowToAction(updated);
        if (this.serviceHook) await this.serviceHook(tx, committedAction, receipt);
        if (opts.hook && opts.hook !== this.serviceHook) await opts.hook(tx, committedAction, receipt);
        return receipt;
      },
      { role: scope.role, rls: { tenantId: scope.tenantId } },
    ).then((receipt) => {
      this.logger.info(opts.reconciled ? "action.reconciled.committed" : "action.committed", { actionId, receiptId: receipt.receiptId });
      return receipt;
    });
  }

  private async markUnknown(scope: Scope, committing: LedgerRow, reason: string): Promise<CommitReceiptT> {
    try {
      return await this.db.tx(
        async (tx) => {
          const locked = await this.lockRow(tx, committing.action_id);
          if (!locked) throw new AccessDeniedError(R.ACTION_NOT_FOUND);
          if (rowState(locked) === "COMMITTED") return rowReceipt(locked) ?? this.integrityFailure();
          if (rowState(locked) !== "COMMITTING" || locked.commit_attempt_id !== committing.commit_attempt_id) {
            throw new DependencyError(R.COMMIT_OUTCOME_UNKNOWN, "UNKNOWN");
          }
          const now = this.clock.now();
          const updated = await this.patch(tx, locked, { state: "UNKNOWN", stateReason: reason }, now);
          if (!updated) throw new DependencyError(R.COMMIT_OUTCOME_UNKNOWN, "UNKNOWN");
          const ev = await this.appendAudit(tx, updated, { action: "action.commit.unknown", outcome: "UNKNOWN", reasonCode: reason });
          this.logger.warn("action.commit.unknown", { actionId: committing.action_id, reasonCode: reason });
          return this.transientReceipt(updated, "UNKNOWN", ev.eventId, false);
        },
        { role: scope.role, rls: { tenantId: scope.tenantId } },
      );
    } catch (err) {
      if (err instanceof DependencyError) throw err;
      // Could not even record UNKNOWN (audit/db outage): the row stays COMMITTING and the
      // reconciler resolves it once stale. Never a success claim.
      this.logger.error("action.commit.unknown_unrecorded", { actionId: committing.action_id, reasonCode: reason });
      throw new DependencyError(reason === R.COMMIT_RECORDING_FAILED ? R.COMMIT_RECORDING_FAILED : R.COMMIT_OUTCOME_UNKNOWN, "UNKNOWN");
    }
  }

  private async markFailed(scope: Scope, committing: LedgerRow, reason: string): Promise<CommitReceiptT> {
    try {
      return await this.db.tx(
        async (tx) => {
          const locked = await this.lockRow(tx, committing.action_id);
          if (!locked) throw new AccessDeniedError(R.ACTION_NOT_FOUND);
          if (rowState(locked) !== "COMMITTING" || locked.commit_attempt_id !== committing.commit_attempt_id) {
            throw new DependencyError(reason, "FAILED");
          }
          const now = this.clock.now();
          const updated = await this.patch(tx, locked, { state: "FAILED", stateReason: reason, committingSince: null }, now);
          if (!updated) throw new DependencyError(reason, "FAILED");
          const ev = await this.appendAudit(tx, updated, { action: "action.commit.failed", outcome: "FAILED", reasonCode: reason });
          return this.transientReceipt(updated, "FAILED", ev.eventId, false);
        },
        { role: scope.role, rls: { tenantId: scope.tenantId } },
      );
    } catch (err) {
      if (err instanceof DependencyError) throw err;
      // FAILED could not be recorded: stays COMMITTING; reconciliation (lookup NOT_FOUND) resolves it.
      this.logger.error("action.commit.failed_unrecorded", { actionId: committing.action_id, reasonCode: reason });
      throw new DependencyError(reason, "FAILED");
    }
  }

  /** Provably-not-sent attempt goes back to CONFIRMED. If this cannot be recorded, it stays COMMITTING (safe). */
  private async revertNotStarted(scope: Scope, committing: LedgerRow, reason: string): Promise<void> {
    try {
      await this.db.tx(
        async (tx) => {
          const locked = await this.lockRow(tx, committing.action_id);
          if (!locked || rowState(locked) !== "COMMITTING" || locked.commit_attempt_id !== committing.commit_attempt_id) return;
          const now = this.clock.now();
          const updated = await this.patch(tx, locked, { state: "CONFIRMED", stateReason: reason, committingSince: null }, now);
          if (updated) await this.appendAudit(tx, updated, { action: "action.commit.not_started", outcome: "FAILED", reasonCode: reason });
        },
        { role: scope.role, rls: { tenantId: scope.tenantId } },
      );
    } catch (err) {
      this.logger.warn("action.commit.revert_unrecorded", {
        actionId: committing.action_id,
        reasonCode: err instanceof PlatformError ? err.reasonCode : "UNEXPECTED_ERROR",
      });
    }
  }

  // ------------------------------------------------------------ helpers

  private transientReceipt(row: LedgerRow, outcome: CommitOutcome, auditEventId: string, reconciled: boolean): CommitReceiptT {
    const target = ActionTarget.parse(row.target);
    return CommitReceipt.parse({
      receiptId: newId("rcp"),
      actionId: row.action_id,
      idempotencyKey: row.action_id,
      outcome,
      providerSystem: target.system,
      providerReference: null,
      providerIdempotencyKey: row.provider_idempotency_key,
      afterVersion: null,
      committedAt: null,
      recordedAt: iso(this.clock.now()),
      evidenceHash: null,
      auditEventId,
      reconciled,
    });
  }

  private integrityFailure(): never {
    throw new ConflictError(R.LEDGER_INTEGRITY_VIOLATION);
  }

  /** Reads report the effective state: an unexpired-looking pending action past expiry is EXPIRED. */
  private effective(action: PreparedActionT, now: Date): PreparedActionT {
    if (PENDING_STATES.includes(action.state) && now.getTime() >= new Date(action.expiresAt).getTime()) return { ...action, state: "EXPIRED" };
    return action;
  }

  private assertSessionUsable(auth: AuthContextT, now: Date): void {
    if (auth.revoked) throw new SessionInvalidError(R.SESSION_REVOKED);
    if (new Date(auth.expiresAt).getTime() <= now.getTime()) throw new SessionInvalidError(R.SESSION_EXPIRED);
    if (auth.integration.tenantId !== auth.tenantId) throw new SessionInvalidError(R.SESSION_INTEGRATION_MISMATCH);
  }

  private decisionFresh(decision: PolicyDecisionT, now: Date): boolean {
    const at = new Date(decision.evaluatedAt).getTime();
    return at <= now.getTime() + this.config.clockSkewSeconds * 1000 && now.getTime() - at <= this.config.decisionMaxAgeSeconds * 1000;
  }

  private confirmationFresh(row: LedgerRow, now: Date): boolean {
    if (row.confirmed_at === null) return false;
    return now.getTime() - toDate(row.confirmed_at).getTime() <= this.config.confirmationFreshSeconds * 1000;
  }

  private isStaleCommitting(row: LedgerRow, now: Date): boolean {
    if (row.committing_since === null) return true;
    return now.getTime() - toDate(row.committing_since).getTime() >= this.config.committingStaleAfterSeconds * 1000;
  }

  /** A3 step-up is transaction-bound: same digest, unexpired, verified after preparation. */
  private stepUpValid(auth: AuthContextT, row: LedgerRow, now: Date): boolean {
    const s = auth.stepUp;
    if (!s) return false;
    if (!constantTimeEqualHex(s.actionDigest, row.digest)) return false;
    const verifiedAt = new Date(s.verifiedAt).getTime();
    if (new Date(s.expiresAt).getTime() <= now.getTime()) return false;
    if (verifiedAt > now.getTime() + this.config.clockSkewSeconds * 1000) return false;
    return verifiedAt >= toDate(row.prepared_at).getTime();
  }

  private async load(scope: Scope, actionId: string): Promise<LedgerRow | null> {
    return this.db.tx(
      async (tx) => (await tx.query<LedgerRow>(`select ${LEDGER_COLUMNS} from action_ledger where action_id = $1`, [actionId])).rows[0] ?? null,
      { role: scope.role, rls: { tenantId: scope.tenantId } },
    );
  }

  private async lockRow(tx: Queryable, actionId: string): Promise<LedgerRow | null> {
    return (await tx.query<LedgerRow>(`select ${LEDGER_COLUMNS} from action_ledger where action_id = $1 for update`, [actionId])).rows[0] ?? null;
  }

  /** Conditional update by row version (optimistic concurrency). Returns null when the row moved on. */
  private async patch(tx: Queryable, row: LedgerRow, p: LedgerPatch, now: Date): Promise<LedgerRow | null> {
    const sets: string[] = [];
    const params: unknown[] = [row.action_id, row.row_version];
    const add = (column: string, value: unknown, cast = ""): void => {
      params.push(value);
      sets.push(`${column} = $${params.length}${cast}`);
    };
    if (p.state !== undefined) add("state", p.state);
    if (p.stateReason !== undefined) add("state_reason", p.stateReason);
    if (p.confirmation !== undefined) add("confirmation", JSON.stringify(p.confirmation), "::jsonb");
    if (p.confirmedAt !== undefined) add("confirmed_at", p.confirmedAt);
    if (p.commitAttemptId !== undefined) add("commit_attempt_id", p.commitAttemptId);
    if (p.committingSince !== undefined) add("committing_since", p.committingSince);
    if (p.receipt !== undefined) add("receipt", JSON.stringify(p.receipt), "::jsonb");
    if (p.lastReconciledAt !== undefined) add("last_reconciled_at", p.lastReconciledAt);
    if (p.incrementCommitAttempts) sets.push("commit_attempts = commit_attempts + 1");
    if (p.incrementReconcileAttempts) sets.push("reconcile_attempts = reconcile_attempts + 1");
    add("updated_at", iso(now));
    sets.push("row_version = row_version + 1");
    const r = await tx.query<LedgerRow>(
      `update action_ledger set ${sets.join(", ")} where action_id = $1 and row_version = $2 returning ${LEDGER_COLUMNS}`,
      params,
    );
    return r.rows[0] ?? null;
  }

  private auditInput(row: LedgerRow, p: AuditParams): AuditEventInput {
    const now = this.clock.now();
    return AuditEventInput.parse({
      occurredAt: iso(now),
      correlationId: row.action_id,
      parentId: null,
      tenantId: row.tenant_id,
      actorRef: p.actorRef ?? row.actor_id,
      subjectRef: row.subject_id,
      role: p.actorRef ? null : row.actor_role,
      sourceComponent: "actions",
      callId: row.call_id,
      sessionRef: bindingRefFromHash(row.session_ref_hash),
      sessionGeneration: row.session_generation,
      turnId: p.turnId ?? null,
      versions: null,
      action: p.action,
      policyDecision: p.policy
        ? { decisionId: p.policy.decisionId, allow: p.policy.allow, reasonCodes: p.policy.reasonCodes, policyVersion: p.policy.policyVersion }
        : null,
      assurance: p.assurance ?? null,
      evidencePointers: [`action:${row.action_id}`, ...(p.evidence ?? [])],
      beforeHash: row.digest,
      afterHash: p.afterHash ?? null,
      idempotencyKey: row.provider_idempotency_key,
      outcome: p.outcome,
      reasonCode: p.reasonCode,
      dataClass: "SECURITY_AUDIT",
    });
  }

  private async appendAudit(tx: Queryable, row: LedgerRow, p: AuditParams): Promise<AuditEvent> {
    return this.audit.append(tx, this.auditInput(row, p), this.config.auditStream);
  }

  /**
   * Rejects with a stable reason code. Fail-safe transitions (INVALIDATED/EXPIRED) are applied
   * conditionally by row version together with a denial audit event; if audit is unavailable the
   * fail-safe transition is still applied (it only removes capability). The error is always thrown.
   */
  private async reject(row: LedgerRow, scope: Scope, rej: Rejection): Promise<never> {
    const state = rowState(row);
    const transition = rej.transition && rej.transition.from.includes(state) ? rej.transition : undefined;
    const write = (withAudit: boolean) =>
      this.db.tx(
        async (tx) => {
          let current = row;
          if (transition) {
            const updated = await this.patch(
              tx,
              row,
              { state: transition.to, stateReason: rej.error.reasonCode, ...(state === "COMMITTING" ? { committingSince: null } : {}) },
              this.clock.now(),
            );
            if (updated) current = updated;
          }
          if (withAudit) {
            const transitioned = current !== row;
            await this.appendAudit(tx, current, {
              action: transitioned ? (transition?.to === "EXPIRED" ? "action.expire" : "action.invalidate") : rej.auditAction,
              outcome: transitioned ? "INVALIDATED" : "DENIED",
              reasonCode: ReasonCode.safeParse(rej.error.reasonCode).success ? rej.error.reasonCode : null,
              turnId: rej.turnId ?? null,
              policy: rej.policy ?? null,
            });
          }
        },
        { role: scope.role, rls: { tenantId: scope.tenantId } },
      );
    try {
      await write(true);
    } catch (err) {
      if (err instanceof AuditUnavailableError) {
        this.logger.warn("action.reject.audit_unavailable", { actionId: row.action_id, reasonCode: rej.error.reasonCode });
        if (transition) await write(false).catch(() => this.logger.error("action.reject.transition_failed", { actionId: row.action_id }));
      } else {
        this.logger.error("action.reject.record_failed", { actionId: row.action_id, reasonCode: rej.error.reasonCode });
      }
    }
    throw rej.error;
  }

  /** Bulk fail-safe transition with audit; falls back to the transition alone if audit is unavailable. */
  private async transitionMany(scope: Scope, where: string, params: unknown[], to: "INVALIDATED" | "EXPIRED", reason: string, auditAction: string): Promise<number> {
    const run = (withAudit: boolean) =>
      this.db.tx(
        async (tx) => {
          const rows = await tx.query<LedgerRow>(`select ${LEDGER_COLUMNS} from action_ledger where ${where} for update`, params);
          const now = this.clock.now();
          let n = 0;
          for (const row of rows.rows) {
            if (!PENDING_STATES.includes(rowState(row))) continue;
            const updated = await this.patch(tx, row, { state: to, stateReason: reason }, now);
            if (!updated) continue;
            n += 1;
            if (withAudit) await this.appendAudit(tx, updated, { action: auditAction, outcome: "INVALIDATED", reasonCode: reason });
          }
          return n;
        },
        { role: scope.role, rls: { tenantId: scope.tenantId } },
      );
    try {
      return await run(true);
    } catch (err) {
      if (!(err instanceof AuditUnavailableError)) throw err;
      this.logger.warn("action.transition.audit_unavailable", { reasonCode: reason });
      return run(false);
    }
  }
}

/** Convenience factory. */
export const createActionService = (opts: LedgerActionServiceOptions): LedgerActionService => new LedgerActionService(opts);
