/**
 * PgWorkflowEngine — the LOCAL DURABLE EXECUTOR for versioned follow-up
 * workflows (spec section 9), backed by PostgreSQL (Aurora in AWS, PGlite
 * offline). The same versioned definitions generate the AWS Step Functions
 * Standard ASL in infra/stepfunctions (see asl.ts); a deployment runs one
 * engine per workflow instance, never two (spec section 3).
 *
 * Guarantees implemented here:
 *  - Instances persist only opaque ids, queue ids, versions and references (no PHI).
 *  - Definition version is pinned per instance; old versions stay loadable.
 *  - Every transition is validated against the pinned definition, uses
 *    optimistic concurrency (row_version / expectedVersion), and duplicate
 *    signals (same dedupe key) are ignored.
 *  - Every nonterminal state has a deadline; tick() escalates overdue work and
 *    exhausted retry budgets to the escalation owner; nothing is dropped silently.
 *  - Every transition writes an append-only WorkflowEvent and a durable audit
 *    event in the same transaction; audit unavailability blocks the transition (OPS-01).
 *  - Human tasks: tokens are scoped to one task + one staff member, expire, are
 *    single use, are stored as SHA-256 only, and the staff member's authority
 *    (required role, MFA, unexpired break-glass) is re-validated at completion.
 *    HUMAN_APPROVED / HUMAN_REJECTED can only be produced by completeHumanTask,
 *    so a model or caller cannot complete a task by inventing an approval.
 *  - Every event is accepted only from the actor kinds the pinned definition
 *    declares for it (eventActors); anything else is refused with
 *    ACTOR_NOT_PERMITTED, audited, and leaves the instance unchanged.
 *  - Guarded (disclosure / material change) transitions require the instance's
 *    durable action grant to be valid for the transition's declared action
 *    (grantActions; when a DurableGrantStore is wired) and then run the recheck
 *    hook; a deny records POLICY_CHANGED_PENDING_ACTION and blocks the change.
 */
import { z } from "zod";
import type { AuditWriter } from "../audit/ports.js";
import type { Db, Queryable } from "../db/types.js";
import { silentLogger } from "../observability/logger.js";
import { noopMetrics } from "../observability/metrics.js";
import type { Logger, Metrics } from "../observability/ports.js";
import {
  OpaqueId,
  StaffActor,
  StaffRole,
  SupportReference,
  VersionLabel,
  WorkflowEvent,
  WorkflowType,
  opaqueIdWithPrefix,
  type AuditEventInput,
  type AuditOutcome,
  type StaffActor as StaffActorT,
  type StaffRole as StaffRoleT,
  type WorkflowStateName,
  type WorkflowType as WorkflowTypeT,
} from "../protocol/index.js";
import { digestOf, sha256Hex } from "../shared/canonical.js";
import { addMs, iso, type Clock } from "../shared/clock.js";
import { AccessDeniedError, ConflictError, DependencyError, PlatformError, ValidationError } from "../shared/errors.js";
import { newId } from "../shared/ids.js";
import { durationSeconds } from "./duration.js";
import type { DurableGrantStore } from "./grants.js";
import type { HumanTask, WorkflowEngine, WorkflowInstance, WorkflowStateDefinition } from "./ports.js";
import { RecheckResultSchema, unconfiguredRecheck, type PreDisclosureRecheck, type RecheckResult } from "./recheck.js";
import type { WorkflowDefinitionRegistry } from "./registry.js";
import { hashTaskToken, newTaskToken, taskTokenMatches } from "./tokens.js";
import {
  DEFINITION_VERSION_RE,
  ENGINE_ONLY_EVENTS,
  EVENT_NAME_RE,
  HUMAN_APPROVED,
  HUMAN_REJECTED,
  POLICY_CHANGED_PENDING_ACTION,
  RETRYABLE_FAILURE,
  TERMINAL_STATES,
  WORKFLOW_ACCEPTED,
  type TransitionGuard,
  type VersionedWorkflowDefinition,
} from "./types.js";

// ---------------------------------------------------------------------------
// Inputs (strictly parsed; extended inputs are supersets of the port inputs)
// ---------------------------------------------------------------------------

const SourceRecordRef = z.union([OpaqueId, SupportReference]);
const WorkflowId = opaqueIdWithPrefix("wf");
const TaskId = opaqueIdWithPrefix("wft");
const DedupeKey = z.string().regex(/^[A-Za-z0-9:._-]{1,128}$/);

const StartInputSchema = z.strictObject({
  tenantId: OpaqueId,
  type: WorkflowType,
  correlationId: OpaqueId,
  sourceRecordRefs: z.array(SourceRecordRef).max(16),
  grantRef: OpaqueId.nullable(),
  policySnapshotVersion: VersionLabel.nullable().optional(),
  definitionVersion: z.string().regex(DEFINITION_VERSION_RE).optional(),
});

const ActorSchema = z.strictObject({
  kind: z.enum(["system", "staff", "caller", "external_system"]),
  ref: OpaqueId.nullable(),
});

const SignalInputSchema = z.strictObject({
  tenantId: OpaqueId,
  workflowId: WorkflowId,
  event: z.string().regex(EVENT_NAME_RE),
  actor: ActorSchema,
  expectedVersion: z.number().int().min(1).optional(),
  dedupeKey: DedupeKey.optional(),
});

const CompleteInputSchema = z.strictObject({
  tenantId: OpaqueId,
  taskId: TaskId,
  taskToken: z.string().max(256),
  decision: z.enum(["APPROVE", "REJECT"]),
  staff: StaffActor,
});

const IssueTokenInputSchema = z.strictObject({ tenantId: OpaqueId, taskId: TaskId, staff: StaffActor });

/** Port start input plus optional policy snapshot and explicit definition version pin. */
export type WorkflowStartInput = Parameters<WorkflowEngine["start"]>[0] & {
  policySnapshotVersion?: string | null;
  definitionVersion?: string;
};
/** Port signal input plus an optional dedupe key (see interface change request in README). */
export type WorkflowSignalInput = Parameters<WorkflowEngine["signal"]>[0] & { dedupeKey?: string };
export type CompleteHumanTaskInput = Parameters<WorkflowEngine["completeHumanTask"]>[0];

export interface IssuedTaskToken {
  task: HumanTask;
  /** Plaintext token, returned exactly once. Deliver in an authenticated response body only — never a URL. */
  taskToken: string;
  tokenExpiresAt: string;
}

export interface TickReport {
  events: WorkflowEvent[];
  /** Instances that could not be escalated in this tick; they remain due and are retried next tick. */
  failures: { tenantId: string; workflowId: string; reasonCode: string }[];
}

/**
 * The actor kind is not declared as permitted for this event by the instance's
 * pinned definition (VersionedWorkflowDefinition.eventActors). Nothing changes;
 * the denial is audited.
 */
export class WorkflowActorNotPermittedError extends AccessDeniedError {
  constructor() {
    super("ACTOR_NOT_PERMITTED");
  }
}

/** Thrown after a denied recheck has been durably recorded as POLICY_CHANGED_PENDING_ACTION. */
export class WorkflowRecheckDeniedError extends AccessDeniedError {
  constructor(
    reasonCode: string,
    readonly instance: WorkflowInstance,
  ) {
    super(reasonCode);
  }
}

export interface PgWorkflowEngineOptions {
  db: Db;
  registry: WorkflowDefinitionRegistry;
  audit: AuditWriter;
  clock: Clock;
  recheck?: PreDisclosureRecheck;
  /**
   * Durable action grants (spec section 7). When wired, every guarded transition of an
   * instance with a grantRef requires check(...).valid for the transition's declared action
   * (VersionedWorkflowDefinition.grantActions); an invalid, expired or revoked grant takes the
   * recheck-denied path (POLICY_CHANGED_PENDING_ACTION). When absent, grantRef is only passed
   * to the recheck hook (previous behaviour) and the gap is reported (GRANT_STORE_UNCONFIGURED).
   */
  grantStore?: DurableGrantStore;
  logger?: Logger;
  /** Content-free metrics (vsp_grant_checks_total). */
  metrics?: Metrics;
  /**
   * Lifetime of an issued task token (bounded by the task's own expiry).
   * Engineering default 900 s pending security approval of the final value.
   */
  taskTokenTtlSeconds?: number;
  /** Maximum instances examined per tick batch. */
  tickBatchSize?: number;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

interface InstanceRow {
  workflow_id: string;
  tenant_id: string;
  workflow_type: WorkflowTypeT;
  definition_version: string;
  state: WorkflowStateName;
  owner_queue: string;
  deadline: Date | string | null;
  attempts: number;
  retry_budget: number;
  escalation_count: number;
  source_record_refs: string[];
  grant_ref: string | null;
  correlation_id: string;
  policy_snapshot_version: string | null;
  row_version: number;
  state_entered_at: Date | string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface EventRow {
  event_id: string;
  workflow_id: string;
  workflow_type: WorkflowTypeT;
  definition_version: string;
  from_state: WorkflowStateName | null;
  to_state: WorkflowStateName;
  trigger: string;
  actor_kind: WorkflowEvent["actor"]["kind"];
  actor_ref: string | null;
  occurred_at: Date | string;
  deadline: Date | string | null;
  attempt: number;
  correlation_id: string;
  source_record_refs: string[];
}

interface TaskRow {
  task_id: string;
  tenant_id: string;
  workflow_id: string;
  task_type: string;
  state_name: WorkflowStateName;
  state_entry_version: number;
  required_roles: string[];
  owner_queue: string;
  token_hash: string | null;
  token_issued_to: string | null;
  token_expires_at: Date | string | null;
  expires_at: Date | string;
  status: HumanTask["status"];
}

const INSTANCE_COLUMNS = `workflow_id, tenant_id, workflow_type, definition_version, state, owner_queue, deadline, attempts,
  retry_budget, escalation_count, source_record_refs, grant_ref, correlation_id, policy_snapshot_version, row_version,
  state_entered_at, created_at, updated_at`;

const toIso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());
const toIsoOrNull = (v: Date | string | null): string | null => (v === null ? null : toIso(v));
const ms = (v: Date | string): number => (v instanceof Date ? v.getTime() : Date.parse(v));

function toInstance(r: InstanceRow): WorkflowInstance {
  return {
    workflowId: r.workflow_id,
    tenantId: r.tenant_id,
    type: r.workflow_type,
    definitionVersion: r.definition_version,
    state: r.state,
    ownerQueue: r.owner_queue,
    deadline: toIsoOrNull(r.deadline),
    attempts: r.attempts,
    sourceRecordRefs: [...r.source_record_refs],
    grantRef: r.grant_ref,
    version: r.row_version,
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
  };
}

function toEvent(r: EventRow): WorkflowEvent {
  return WorkflowEvent.parse({
    eventId: r.event_id,
    workflowId: r.workflow_id,
    workflowType: r.workflow_type,
    definitionVersion: r.definition_version,
    fromState: r.from_state,
    toState: r.to_state,
    trigger: r.trigger,
    actor: { kind: r.actor_kind, ref: r.actor_ref },
    occurredAt: toIso(r.occurred_at),
    deadline: toIsoOrNull(r.deadline),
    attempt: r.attempt,
    correlationId: r.correlation_id,
    sourceRecordRefs: [...r.source_record_refs],
  });
}

function toHumanTask(r: TaskRow): HumanTask {
  return {
    taskId: r.task_id,
    workflowId: r.workflow_id,
    taskType: r.task_type,
    requiredStaffRoles: [...r.required_roles],
    status: r.status,
    expiresAt: toIso(r.expires_at),
  };
}

/** Opaque actor reference for a staff member (staff ids shorter than the opaque-id minimum are pseudonymised). */
export function staffActorRef(staffId: string): string {
  return OpaqueId.safeParse(staffId).success ? staffId : `stf_${sha256Hex(staffId).slice(0, 32)}`;
}

/** Re-validates a staff member's current authority for a human task (spec sections 7 and 9). */
export function checkStaffAuthority(
  staff: StaffActorT,
  requiredRoles: readonly string[],
  now: Date,
): { ok: true; role: StaffRoleT } | { ok: false; reasonCode: string } {
  if (staff.mfa !== true) return { ok: false, reasonCode: "STAFF_MFA_REQUIRED" };
  if (Date.parse(staff.authenticatedAt) > now.getTime()) return { ok: false, reasonCode: "STAFF_AUTH_TIME_INVALID" };
  if (staff.breakGlass !== null && Date.parse(staff.breakGlass.expiresAt) <= now.getTime()) {
    return { ok: false, reasonCode: "BREAK_GLASS_EXPIRED" };
  }
  const role = staff.roles.find((r) => requiredRoles.includes(r));
  if (!role) return { ok: false, reasonCode: "STAFF_ROLE_NOT_PERMITTED" };
  return { ok: true, role };
}

function parseOrThrow<T>(schema: z.ZodType<T>, raw: unknown, reasonCode: string): T {
  const r = schema.safeParse(raw);
  if (!r.success) throw new ValidationError(reasonCode);
  return r.data;
}

function auditOutcomeFor(state: WorkflowStateName): AuditOutcome {
  if (state === "COMPLETED") return "SUCCEEDED";
  if (state === "FAILED") return "FAILED";
  if (state === "CANCELLED") return "INVALIDATED";
  return "PENDING";
}

const GrantCheckResultSchema = z.strictObject({ valid: z.boolean(), reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/) });

/** vsp_grant_checks_total result label per grant-store reason code (closed set; anything else is "other"). */
const GRANT_RESULT_LABEL: Readonly<Record<string, string>> = Object.freeze({
  GRANT_VALID: "valid",
  GRANT_INPUT_INVALID: "invalid_input",
  GRANT_NOT_FOUND: "not_found",
  GRANT_EXPIRED: "expired",
  GRANT_REVOKED: "revoked",
  GRANT_ACTION_NOT_PERMITTED: "action_not_permitted",
});

interface TransitionSpec {
  trigger: string;
  toState: WorkflowStateName;
  actor: WorkflowEvent["actor"];
  reasonCode: string | null;
  dedupeKey: string | null;
  now: Date;
  /** Escalation hands work to the escalation owner queue. */
  escalation?: { ownerQueue: string };
  /** Status given to an open human task of the state being left (default CANCELLED). */
  closeOpenTaskAs?: "CANCELLED" | "EXPIRED";
  staffRole?: StaffRoleT | null;
  auditAction?: string;
}

type SignalResult =
  | { kind: "applied" | "duplicate"; instance: WorkflowInstance }
  | { kind: "recheck_denied"; instance: WorkflowInstance; reasonCode: string };

export class PgWorkflowEngine implements WorkflowEngine {
  /** "local_fixture" on embedded PGlite (offline), "live" on the pg/Aurora adapter. */
  readonly kind: "local_fixture" | "live";
  private readonly db: Db;
  private readonly registry: WorkflowDefinitionRegistry;
  private readonly audit: AuditWriter;
  private readonly clock: Clock;
  private readonly recheckHook: PreDisclosureRecheck;
  private readonly grantStore: DurableGrantStore | null;
  private readonly logger: Logger;
  private readonly metrics: Metrics;
  private readonly taskTokenTtlMs: number;
  private readonly tickBatchSize: number;

  constructor(opts: PgWorkflowEngineOptions) {
    this.db = opts.db;
    this.kind = opts.db.engine === "pglite" ? "local_fixture" : "live";
    this.registry = opts.registry;
    this.audit = opts.audit;
    this.clock = opts.clock;
    this.recheckHook = opts.recheck ?? unconfiguredRecheck;
    this.grantStore = opts.grantStore ?? null;
    this.logger = (opts.logger ?? silentLogger).child({ component: "workflow_engine" });
    this.metrics = opts.metrics ?? noopMetrics;
    const ttl = opts.taskTokenTtlSeconds ?? 900;
    if (!Number.isInteger(ttl) || ttl < 30 || ttl > 86_400) throw new ValidationError("TASK_TOKEN_TTL_INVALID");
    this.taskTokenTtlMs = ttl * 1000;
    this.tickBatchSize = Math.max(1, Math.min(opts.tickBatchSize ?? 200, 1000));
  }

  // -------------------------------------------------------------------------
  // start
  // -------------------------------------------------------------------------

  async start(raw: WorkflowStartInput, tx?: Queryable): Promise<WorkflowInstance> {
    const input = parseOrThrow(StartInputSchema, raw, "WORKFLOW_START_INPUT_INVALID");
    const def = input.definitionVersion
      ? this.registry.get(input.type, input.definitionVersion)
      : this.registry.latest(input.type);
    if (!def) throw new ValidationError("WORKFLOW_DEFINITION_UNAVAILABLE");
    const now = this.clock.now();

    const run = async (q: Queryable): Promise<WorkflowInstance> => {
      // A caller-supplied transaction must already be scoped (RLS) to the same tenant.
      const ctx = await q.query<{ t: string | null }>("select app_tenant() as t");
      if (ctx.rows[0]?.t !== input.tenantId) throw new AccessDeniedError("TENANT_CONTEXT_MISMATCH");

      const sdef = this.stateDef(def, def.initial);
      const workflowId = newId("wf");
      const deadline = this.deadlineFor(sdef, now);
      const inserted = await q.query<InstanceRow>(
        `insert into workflow_instances (workflow_id, tenant_id, workflow_type, definition_version, state, owner_queue, deadline,
           attempts, retry_budget, escalation_count, source_record_refs, grant_ref, correlation_id, policy_snapshot_version,
           row_version, state_entered_at, created_at, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,0,$8,0,$9,$10,$11,$12,1,$13,$13,$13)
         returning ${INSTANCE_COLUMNS}`,
        [
          workflowId,
          input.tenantId,
          def.type,
          def.version,
          def.initial,
          sdef.owner,
          deadline,
          sdef.retryBudget,
          input.sourceRecordRefs,
          input.grantRef,
          input.correlationId,
          input.policySnapshotVersion ?? null,
          iso(now),
        ],
      );
      const row = inserted.rows[0];
      if (!row) throw new DependencyError("WORKFLOW_INSERT_FAILED", "UNKNOWN");
      const actor = { kind: "system" as const, ref: null };
      const event = await this.insertEvent(q, row, {
        fromState: null,
        toState: def.initial,
        trigger: WORKFLOW_ACCEPTED,
        actor,
        now,
        deadline,
        attempt: 0,
        ownerQueue: sdef.owner,
        reasonCode: null,
        dedupeKey: null,
        seq: 1,
      });
      if (sdef.humanTask) await this.createTask(q, row, sdef, 1, sdef.owner, deadline, now);
      await this.appendAudit(q, {
        row,
        action: "workflow.start",
        outcome: "PENDING",
        reasonCode: null,
        actorRef: null,
        role: null,
        now,
        evidence: [`workflow:${workflowId}`, `workflow_event:${event.eventId}`],
        beforeHash: null,
        afterHash: this.stateDigest(row),
        idempotencyKey: null,
      });
      this.logger.info("workflow.started", { workflowId, toState: def.initial, version: def.version });
      return toInstance(row);
    };

    return tx ? run(tx) : this.db.tx(run, { role: "app_runtime", rls: { tenantId: input.tenantId } });
  }

  // -------------------------------------------------------------------------
  // signal
  // -------------------------------------------------------------------------

  async signal(raw: WorkflowSignalInput): Promise<WorkflowInstance> {
    const input = parseOrThrow(SignalInputSchema, raw, "WORKFLOW_SIGNAL_INPUT_INVALID");
    if (ENGINE_ONLY_EVENTS.has(input.event)) {
      // HUMAN_APPROVED / HUMAN_REJECTED only come from completeHumanTask; policy-change events only from the engine.
      await this.auditDenial(input.tenantId, input.workflowId, "workflow.signal.denied", "EVENT_RESERVED_FOR_ENGINE", input.actor.ref, null);
      throw new AccessDeniedError("EVENT_RESERVED_FOR_ENGINE");
    }
    const now = this.clock.now();
    let result: SignalResult;
    try {
      result = await this.db.tx<SignalResult>(
        async (tx) => {
          const row = await this.lockInstance(tx, input.workflowId);
          if (!row) throw new AccessDeniedError("WORKFLOW_NOT_FOUND");
          const def = this.definitionFor(row);
          // Actor permission first (before dedupe, version or state checks reveal anything): the pinned
          // definition declares which actor kinds may send each event. Undeclared events cannot be sent at all.
          const permitted = def.eventActors[input.event];
          if (permitted === undefined) throw new ValidationError("TRANSITION_NOT_ALLOWED");
          if (!permitted.includes(input.actor.kind)) throw new WorkflowActorNotPermittedError();
          const dedupeKey = input.dedupeKey ?? (input.expectedVersion !== undefined ? `v${input.expectedVersion}:${input.event}` : null);
          if (dedupeKey !== null) {
            const dup = await tx.query("select 1 from workflow_events where workflow_id = $1 and dedupe_key = $2", [row.workflow_id, dedupeKey]);
            if (dup.rows.length > 0) return { kind: "duplicate", instance: toInstance(row) };
          }
          if (input.expectedVersion !== undefined && input.expectedVersion !== row.row_version) {
            throw new ConflictError("WORKFLOW_VERSION_CONFLICT");
          }
          if (TERMINAL_STATES.has(row.state)) throw new ValidationError("WORKFLOW_TERMINAL");
          const sdef = this.stateDef(def, row.state);

          if (input.event === RETRYABLE_FAILURE) {
            return { kind: "applied", instance: await this.applyRetry(tx, row, def, sdef, input.actor, dedupeKey, now) };
          }

          const target = sdef.transitions[input.event];
          if (target === undefined) throw new ValidationError("TRANSITION_NOT_ALLOWED");
          const isEscalation = sdef.escalation !== null && input.event === sdef.escalation.event;

          const guard = def.transitionGuards[row.state]?.[input.event];
          if (guard) {
            const decision = await this.runRecheck(tx, row, def, guard, input.event, target, input.actor, now);
            if (!decision.allow) {
              const denied = await this.recordPolicyChange(tx, row, def, sdef, input.actor, decision.reasonCode, now);
              return { kind: "recheck_denied", instance: denied, reasonCode: decision.reasonCode };
            }
          }

          const { instance: applied } = await this.applyTransition(tx, row, def, {
            trigger: input.event,
            toState: target,
            actor: input.actor,
            reasonCode: isEscalation ? "MANUAL_ESCALATION" : null,
            dedupeKey,
            now,
            escalation: isEscalation && sdef.escalation ? { ownerQueue: sdef.escalation.ownerQueue } : undefined,
          });
          return { kind: "applied", instance: applied };
        },
        { role: "app_runtime", rls: { tenantId: input.tenantId } },
      );
    } catch (err) {
      if (err instanceof WorkflowActorNotPermittedError) {
        // Security evidence; the transaction rolled back, so the instance is unchanged.
        await this.auditDenial(input.tenantId, input.workflowId, "workflow.signal.denied", err.reasonCode, input.actor.ref, null);
        this.logger.warn("workflow.signal.denied", { workflowId: input.workflowId, eventCode: input.event, kind: input.actor.kind, reasonCode: err.reasonCode });
      }
      throw err;
    }
    if (result.kind === "recheck_denied") throw new WorkflowRecheckDeniedError(result.reasonCode, result.instance);
    return result.instance;
  }

  // -------------------------------------------------------------------------
  // human tasks
  // -------------------------------------------------------------------------

  /**
   * Mints the task token for an authenticated, authorized, MFA-verified staff
   * member (called by the console approval endpoint). Returns the plaintext
   * exactly once; only its SHA-256 is stored. Re-issuing rotates the token and
   * invalidates any previously issued one.
   */
  async issueTaskToken(raw: { tenantId: string; taskId: string; staff: StaffActorT }): Promise<IssuedTaskToken> {
    const input = parseOrThrow(IssueTokenInputSchema, raw, "TASK_TOKEN_ISSUE_INPUT_INVALID");
    const now = this.clock.now();
    try {
      return await this.db.tx(
        async (tx) => {
          const task = await this.lockTask(tx, input.taskId);
          if (!task) throw new AccessDeniedError("TASK_NOT_FOUND");
          if (task.status !== "OPEN") throw new AccessDeniedError("TASK_NOT_OPEN");
          if (ms(task.expires_at) <= now.getTime()) throw new AccessDeniedError("TASK_EXPIRED");
          const authority = checkStaffAuthority(input.staff, task.required_roles, now);
          if (!authority.ok) throw new AccessDeniedError(authority.reasonCode);
          const row = await this.lockInstance(tx, task.workflow_id);
          if (!row || row.state !== task.state_name) throw new AccessDeniedError("TASK_STALE");

          const token = newTaskToken();
          const tokenExpiresAt = new Date(Math.min(ms(task.expires_at), now.getTime() + this.taskTokenTtlMs));
          await tx.query(
            `update workflow_tasks set token_hash = $2, token_issued_to = $3, token_issued_at = $4, token_expires_at = $5, updated_at = $4
             where task_id = $1`,
            [task.task_id, hashTaskToken(token), input.staff.staffId, iso(now), iso(tokenExpiresAt)],
          );
          await this.appendAudit(tx, {
            row,
            action: "workflow.human_task.token_issued",
            outcome: "ALLOWED",
            reasonCode: null,
            actorRef: staffActorRef(input.staff.staffId),
            role: authority.role,
            now,
            evidence: [`workflow:${row.workflow_id}`, `workflow_task:${task.task_id}`],
            beforeHash: null,
            afterHash: null,
            idempotencyKey: null,
          });
          return { task: toHumanTask(task), taskToken: token, tokenExpiresAt: iso(tokenExpiresAt) };
        },
        { role: "app_runtime", rls: { tenantId: input.tenantId } },
      );
    } catch (err) {
      if (err instanceof AccessDeniedError) {
        await this.auditDenial(input.tenantId, null, "workflow.human_task.token_denied", err.reasonCode, staffActorRef(input.staff.staffId), input.taskId);
      }
      throw err;
    }
  }

  async completeHumanTask(raw: CompleteHumanTaskInput): Promise<WorkflowInstance> {
    const input = parseOrThrow(CompleteInputSchema, raw, "TASK_COMPLETION_INPUT_INVALID");
    const now = this.clock.now();
    const staffRef = staffActorRef(input.staff.staffId);
    let result: SignalResult;
    try {
      result = await this.db.tx<SignalResult>(
        async (tx) => {
          const task = await this.lockTask(tx, input.taskId);
          if (!task) throw new AccessDeniedError("TASK_NOT_FOUND");
          if (task.status !== "OPEN") throw new AccessDeniedError("TASK_NOT_OPEN");
          if (ms(task.expires_at) <= now.getTime()) throw new AccessDeniedError("TASK_EXPIRED");
          if (task.token_hash === null || task.token_expires_at === null) throw new AccessDeniedError("TASK_TOKEN_NOT_ISSUED");
          if (!taskTokenMatches(input.taskToken, task.token_hash)) throw new AccessDeniedError("TASK_TOKEN_INVALID");
          if (ms(task.token_expires_at) <= now.getTime()) throw new AccessDeniedError("TASK_TOKEN_EXPIRED");
          if (task.token_issued_to !== input.staff.staffId) throw new AccessDeniedError("TASK_TOKEN_NOT_ISSUED_TO_ACTOR");
          // Current authority is re-validated at completion, not trusted from issuance time.
          const authority = checkStaffAuthority(input.staff, task.required_roles, now);
          if (!authority.ok) throw new AccessDeniedError(authority.reasonCode);

          const row = await this.lockInstance(tx, task.workflow_id);
          if (!row || row.state !== task.state_name || TERMINAL_STATES.has(row.state)) throw new AccessDeniedError("TASK_STALE");
          const def = this.definitionFor(row);
          const sdef = this.stateDef(def, row.state);
          if (!sdef.humanTask || sdef.humanTask.taskType !== task.task_type) throw new AccessDeniedError("TASK_STALE");

          const event = input.decision === "APPROVE" ? HUMAN_APPROVED : HUMAN_REJECTED;
          // Defence in depth: the pinned definition must declare the decision as a staff event.
          if (!(def.eventActors[event] ?? []).includes("staff")) throw new WorkflowActorNotPermittedError();
          const target = sdef.transitions[event];
          if (target === undefined) throw new ValidationError("TRANSITION_NOT_ALLOWED");

          // Single use: the token digest is erased with the completion.
          const done = await tx.query(
            `update workflow_tasks set status = 'COMPLETED', decision = $2, completed_by = $3, completed_at = $4, updated_at = $4,
               token_hash = null, token_issued_to = null, token_expires_at = null
             where task_id = $1 and status = 'OPEN'`,
            [task.task_id, input.decision, input.staff.staffId, iso(now)],
          );
          if (done.rowCount !== 1) throw new ConflictError("TASK_COMPLETION_CONFLICT");
          await this.appendAudit(tx, {
            row,
            action: "workflow.human_task.complete",
            outcome: "SUCCEEDED",
            reasonCode: input.decision === "APPROVE" ? "HUMAN_APPROVED" : "HUMAN_REJECTED",
            actorRef: staffRef,
            role: authority.role,
            now,
            evidence: [`workflow:${row.workflow_id}`, `workflow_task:${task.task_id}`],
            beforeHash: null,
            afterHash: null,
            idempotencyKey: task.task_id,
          });

          const actor = { kind: "staff" as const, ref: staffRef };
          const guard = def.transitionGuards[row.state]?.[event];
          if (guard) {
            const decision = await this.runRecheck(tx, row, def, guard, event, target, actor, now);
            if (!decision.allow) {
              const denied = await this.recordPolicyChange(tx, row, def, sdef, actor, decision.reasonCode, now);
              return { kind: "recheck_denied", instance: denied, reasonCode: decision.reasonCode };
            }
          }
          const { instance: applied } = await this.applyTransition(tx, row, def, {
            trigger: event,
            toState: target,
            actor,
            reasonCode: null,
            dedupeKey: `task:${task.task_id}`,
            now,
            staffRole: authority.role,
          });
          return { kind: "applied", instance: applied };
        },
        { role: "app_runtime", rls: { tenantId: input.tenantId } },
      );
    } catch (err) {
      if (err instanceof AccessDeniedError) {
        await this.auditDenial(input.tenantId, null, "workflow.human_task.denied", err.reasonCode, staffRef, input.taskId);
        this.logger.warn("workflow.human_task.denied", { taskId: input.taskId, reasonCode: err.reasonCode });
      }
      throw err;
    }
    if (result.kind === "recheck_denied") throw new WorkflowRecheckDeniedError(result.reasonCode, result.instance);
    return result.instance;
  }

  async openTasks(tenantId: string, staffRoles: string[]): Promise<HumanTask[]> {
    const t = parseOrThrow(OpaqueId, tenantId, "TENANT_ID_INVALID");
    const roles = parseOrThrow(z.array(StaffRole).max(8), staffRoles, "STAFF_ROLES_INVALID");
    if (roles.length === 0) return [];
    const now = this.clock.now();
    return this.db.tx(
      async (tx) => {
        const r = await tx.query<TaskRow>(
          `select task_id, tenant_id, workflow_id, task_type, state_name, state_entry_version, required_roles, owner_queue,
                  token_hash, token_issued_to, token_expires_at, expires_at, status
           from workflow_tasks where status = 'OPEN' and expires_at > $1 and required_roles && $2::text[]
           order by expires_at, task_id`,
          [iso(now), roles],
        );
        return r.rows.map(toHumanTask);
      },
      { role: "app_runtime", rls: { tenantId: t } },
    );
  }

  // -------------------------------------------------------------------------
  // tick: deadline escalation + retry budget exhaustion
  // -------------------------------------------------------------------------

  async tick(now: Date): Promise<WorkflowEvent[]> {
    return (await this.tickDetailed(now)).events;
  }

  async tickDetailed(now: Date): Promise<TickReport> {
    const report: TickReport = { events: [], failures: [] };
    const seen = new Set<string>();
    for (let batch = 0; batch < 20; batch++) {
      const due = await this.db.tx(
        (tx) =>
          tx.query<{ tenant_id: string; workflow_id: string }>("select tenant_id, workflow_id from workflow_due_instances($1, $2)", [
            iso(now),
            this.tickBatchSize + seen.size,
          ]),
        { role: "app_worker" },
      );
      const fresh = due.rows.filter((r) => !seen.has(r.workflow_id));
      if (fresh.length === 0) break;
      for (const d of fresh) {
        seen.add(d.workflow_id);
        try {
          const ev = await this.escalateIfDue(d.tenant_id, d.workflow_id, now);
          if (ev) report.events.push(ev);
        } catch (err) {
          const reasonCode = err instanceof PlatformError ? err.reasonCode : "TICK_ESCALATION_FAILED";
          report.failures.push({ tenantId: d.tenant_id, workflowId: d.workflow_id, reasonCode });
          this.logger.error("workflow.tick.escalation_failed", { workflowId: d.workflow_id, reasonCode });
        }
      }
    }
    if (report.events.length > 0 || report.failures.length > 0) {
      this.logger.info("workflow.tick.completed", { escalations: report.events.length, failures: report.failures.length });
    }
    return report;
  }

  private async escalateIfDue(tenantId: string, workflowId: string, now: Date): Promise<WorkflowEvent | null> {
    return this.db.tx(
      async (tx) => {
        const row = await this.lockInstance(tx, workflowId);
        if (!row || TERMINAL_STATES.has(row.state)) return null;
        const def = this.definitionFor(row);
        const sdef = this.stateDef(def, row.state);
        const overdue = row.deadline !== null && ms(row.deadline) <= now.getTime();
        const exhausted = row.attempts > row.retry_budget;
        if (!overdue && !exhausted) return null;
        if (!sdef.escalation) throw new ValidationError("ESCALATION_ROUTE_MISSING");
        const target = sdef.transitions[sdef.escalation.event];
        if (target === undefined) throw new ValidationError("ESCALATION_ROUTE_MISSING");
        const { event } = await this.applyTransition(tx, row, def, {
          trigger: sdef.escalation.event,
          toState: target,
          actor: { kind: "system", ref: null },
          reasonCode: overdue ? "DEADLINE_EXCEEDED" : "RETRY_BUDGET_EXHAUSTED",
          dedupeKey: null,
          now,
          escalation: { ownerQueue: sdef.escalation.ownerQueue },
          closeOpenTaskAs: "EXPIRED",
          auditAction: "workflow.escalate",
        });
        return event;
      },
      { role: "app_worker", rls: { tenantId } },
    );
  }

  // -------------------------------------------------------------------------
  // reads
  // -------------------------------------------------------------------------

  async get(tenantId: string, workflowId: string): Promise<WorkflowInstance | null> {
    const t = parseOrThrow(OpaqueId, tenantId, "TENANT_ID_INVALID");
    if (!WorkflowId.safeParse(workflowId).success) return null;
    return this.db.tx(
      async (tx) => {
        const r = await tx.query<InstanceRow>(`select ${INSTANCE_COLUMNS} from workflow_instances where workflow_id = $1`, [workflowId]);
        const row = r.rows[0];
        return row ? toInstance(row) : null;
      },
      { role: "app_runtime", rls: { tenantId: t } },
    );
  }

  async history(tenantId: string, workflowId: string): Promise<WorkflowEvent[]> {
    const t = parseOrThrow(OpaqueId, tenantId, "TENANT_ID_INVALID");
    if (!WorkflowId.safeParse(workflowId).success) return [];
    return this.db.tx(
      async (tx) => {
        const r = await tx.query<EventRow>(
          `select event_id, workflow_id, workflow_type, definition_version, from_state, to_state, trigger, actor_kind, actor_ref,
                  occurred_at, deadline, attempt, correlation_id, source_record_refs
           from workflow_events where workflow_id = $1 order by seq`,
          [workflowId],
        );
        return r.rows.map(toEvent);
      },
      { role: "app_runtime", rls: { tenantId: t } },
    );
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private definitionFor(row: InstanceRow): VersionedWorkflowDefinition {
    const def = this.registry.get(row.workflow_type, row.definition_version);
    if (!def) throw new ValidationError("DEFINITION_VERSION_UNAVAILABLE");
    return def;
  }

  private stateDef(def: VersionedWorkflowDefinition, state: WorkflowStateName): WorkflowStateDefinition {
    const s = def.states[state];
    if (!s) throw new ValidationError("WORKFLOW_STATE_UNDEFINED");
    return s;
  }

  private deadlineFor(sdef: WorkflowStateDefinition, now: Date): string | null {
    if (sdef.terminal || sdef.deadline === null) return null;
    return iso(addMs(now, durationSeconds(sdef.deadline) * 1000));
  }

  private stateDigest(row: Pick<InstanceRow, "workflow_id" | "state" | "row_version" | "owner_queue" | "deadline">): string {
    return digestOf({
      workflowId: row.workflow_id,
      state: row.state,
      version: row.row_version,
      ownerQueue: row.owner_queue,
      deadline: toIsoOrNull(row.deadline),
    });
  }

  private async lockInstance(tx: Queryable, workflowId: string): Promise<InstanceRow | null> {
    const r = await tx.query<InstanceRow>(`select ${INSTANCE_COLUMNS} from workflow_instances where workflow_id = $1 for update`, [workflowId]);
    return r.rows[0] ?? null;
  }

  private async lockTask(tx: Queryable, taskId: string): Promise<TaskRow | null> {
    const r = await tx.query<TaskRow>(
      `select task_id, tenant_id, workflow_id, task_type, state_name, state_entry_version, required_roles, owner_queue,
              token_hash, token_issued_to, token_expires_at, expires_at, status
       from workflow_tasks where task_id = $1 for update`,
      [taskId],
    );
    return r.rows[0] ?? null;
  }

  private async createTask(
    tx: Queryable,
    row: InstanceRow,
    sdef: WorkflowStateDefinition,
    entryVersion: number,
    ownerQueue: string,
    deadline: string | null,
    now: Date,
  ): Promise<void> {
    if (!sdef.humanTask || deadline === null) return;
    await tx.query(
      `insert into workflow_tasks (task_id, tenant_id, workflow_id, task_type, state_name, state_entry_version, required_roles,
         owner_queue, expires_at, status, created_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'OPEN',$10,$10)`,
      [newId("wft"), row.tenant_id, row.workflow_id, sdef.humanTask.taskType, "WAITING_FOR_HUMAN", entryVersion, sdef.humanTask.requiredStaffRoles, ownerQueue, deadline, iso(now)],
    );
  }

  private async insertEvent(
    tx: Queryable,
    row: InstanceRow,
    e: {
      fromState: WorkflowStateName | null;
      toState: WorkflowStateName;
      trigger: string;
      actor: WorkflowEvent["actor"];
      now: Date;
      deadline: string | null;
      attempt: number;
      ownerQueue: string;
      reasonCode: string | null;
      dedupeKey: string | null;
      seq: number;
    },
  ): Promise<WorkflowEvent> {
    const event = WorkflowEvent.parse({
      eventId: newId("wfe"),
      workflowId: row.workflow_id,
      workflowType: row.workflow_type,
      definitionVersion: row.definition_version,
      fromState: e.fromState,
      toState: e.toState,
      trigger: e.trigger,
      actor: e.actor,
      occurredAt: iso(e.now),
      deadline: e.deadline,
      attempt: e.attempt,
      correlationId: row.correlation_id,
      sourceRecordRefs: [...row.source_record_refs],
    });
    await tx.query(
      `insert into workflow_events (event_id, tenant_id, workflow_id, seq, workflow_type, definition_version, from_state, to_state,
         trigger, actor_kind, actor_ref, occurred_at, deadline, attempt, correlation_id, source_record_refs, owner_queue, reason_code, dedupe_key)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [
        event.eventId,
        row.tenant_id,
        row.workflow_id,
        e.seq,
        event.workflowType,
        event.definitionVersion,
        event.fromState,
        event.toState,
        event.trigger,
        event.actor.kind,
        event.actor.ref,
        event.occurredAt,
        event.deadline,
        event.attempt,
        event.correlationId,
        event.sourceRecordRefs,
        e.ownerQueue,
        e.reasonCode,
        e.dedupeKey,
      ],
    );
    return event;
  }

  private async applyRetry(
    tx: Queryable,
    row: InstanceRow,
    def: VersionedWorkflowDefinition,
    sdef: WorkflowStateDefinition,
    actor: WorkflowEvent["actor"],
    dedupeKey: string | null,
    now: Date,
  ): Promise<WorkflowInstance> {
    const attempts = row.attempts + 1;
    if (attempts > sdef.retryBudget) {
      if (!sdef.escalation) throw new ValidationError("ESCALATION_ROUTE_MISSING");
      const target = sdef.transitions[sdef.escalation.event];
      if (target === undefined) throw new ValidationError("ESCALATION_ROUTE_MISSING");
      const { instance } = await this.applyTransition(tx, row, def, {
        trigger: sdef.escalation.event,
        toState: target,
        actor,
        reasonCode: "RETRY_BUDGET_EXHAUSTED",
        dedupeKey,
        now,
        escalation: { ownerQueue: sdef.escalation.ownerQueue },
        closeOpenTaskAs: "CANCELLED",
        auditAction: "workflow.escalate",
      });
      return instance;
    }
    const nextVersion = row.row_version + 1;
    const upd = await tx.query<InstanceRow>(
      `update workflow_instances set attempts = $3, row_version = $4, updated_at = $5
       where workflow_id = $1 and row_version = $2 returning ${INSTANCE_COLUMNS}`,
      [row.workflow_id, row.row_version, attempts, nextVersion, iso(now)],
    );
    const updated = upd.rows[0];
    if (!updated) throw new ConflictError("WORKFLOW_VERSION_CONFLICT");
    const event = await this.insertEvent(tx, updated, {
      fromState: row.state,
      toState: row.state,
      trigger: RETRYABLE_FAILURE,
      actor,
      now,
      deadline: toIsoOrNull(updated.deadline),
      attempt: attempts,
      ownerQueue: updated.owner_queue,
      reasonCode: "RETRY_SCHEDULED",
      dedupeKey,
      seq: nextVersion,
    });
    await this.appendAudit(tx, {
      row: updated,
      action: "workflow.retry",
      outcome: "PENDING",
      reasonCode: "RETRY_SCHEDULED",
      actorRef: actor.ref,
      role: null,
      now,
      evidence: [`workflow:${row.workflow_id}`, `workflow_event:${event.eventId}`],
      beforeHash: this.stateDigest(row),
      afterHash: this.stateDigest(updated),
      idempotencyKey: dedupeKey,
    });
    return toInstance(updated);
  }

  private async applyTransition(
    tx: Queryable,
    row: InstanceRow,
    def: VersionedWorkflowDefinition,
    t: TransitionSpec,
  ): Promise<{ instance: WorkflowInstance; event: WorkflowEvent }> {
    const tdef = this.stateDef(def, t.toState);
    const fromDef = this.stateDef(def, row.state);
    const deadline = this.deadlineFor(tdef, t.now);
    const ownerQueue = t.escalation?.ownerQueue ?? tdef.owner;
    const nextVersion = row.row_version + 1;
    const escalationCount = t.escalation ? row.escalation_count + 1 : 0;

    const upd = await tx.query<InstanceRow>(
      `update workflow_instances set state = $3, owner_queue = $4, deadline = $5, attempts = 0, retry_budget = $6,
         escalation_count = $7, row_version = $8, state_entered_at = $9, updated_at = $9
       where workflow_id = $1 and row_version = $2 returning ${INSTANCE_COLUMNS}`,
      [row.workflow_id, row.row_version, t.toState, ownerQueue, deadline, tdef.retryBudget, escalationCount, nextVersion, iso(t.now)],
    );
    const updated = upd.rows[0];
    if (!updated) throw new ConflictError("WORKFLOW_VERSION_CONFLICT");

    // Leaving (or re-entering) a human-task state closes its open task; the token digest is erased.
    if (fromDef.humanTask) {
      await tx.query(
        `update workflow_tasks set status = $2, updated_at = $3, token_hash = null, token_issued_to = null, token_expires_at = null
         where workflow_id = $1 and status = 'OPEN'`,
        [row.workflow_id, t.closeOpenTaskAs ?? "CANCELLED", iso(t.now)],
      );
    }
    if (tdef.humanTask) await this.createTask(tx, updated, tdef, nextVersion, ownerQueue, deadline, t.now);

    const event = await this.insertEvent(tx, updated, {
      fromState: row.state,
      toState: t.toState,
      trigger: t.trigger,
      actor: t.actor,
      now: t.now,
      deadline,
      attempt: 0,
      ownerQueue,
      reasonCode: t.reasonCode,
      dedupeKey: t.dedupeKey,
      seq: nextVersion,
    });
    await this.appendAudit(tx, {
      row: updated,
      action: t.auditAction ?? "workflow.transition",
      outcome: auditOutcomeFor(t.toState),
      reasonCode: t.reasonCode,
      actorRef: t.actor.ref,
      role: t.staffRole ?? null,
      now: t.now,
      evidence: [`workflow:${row.workflow_id}`, `workflow_event:${event.eventId}`],
      beforeHash: this.stateDigest(row),
      afterHash: this.stateDigest(updated),
      idempotencyKey: t.dedupeKey,
    });
    this.logger.info("workflow.transition", {
      workflowId: row.workflow_id,
      fromState: row.state,
      toState: t.toState,
      eventCode: t.trigger,
      reasonCode: t.reasonCode,
      queue: ownerQueue,
    });
    return { instance: toInstance(updated), event };
  }

  private async runRecheck(
    tx: Queryable,
    row: InstanceRow,
    def: VersionedWorkflowDefinition,
    guard: TransitionGuard,
    event: string,
    toState: WorkflowStateName,
    actor: WorkflowEvent["actor"],
    now: Date,
  ): Promise<RecheckResult> {
    // Later disclosure or material change after the call requires the narrowly scoped durable grant.
    if (row.grant_ref === null) {
      this.metrics.increment("vsp_grant_checks_total", { result: "absent", guard });
      this.logger.warn("workflow.grant.absent", { workflowId: row.workflow_id, eventCode: event, reasonCode: "GRANT_ABSENT" });
      return { allow: false, reasonCode: "DURABLE_GRANT_MISSING" };
    }
    const grantAction = def.grantActions[row.state]?.[event];
    if (grantAction === undefined) throw new ValidationError("GRANT_ACTION_UNDECLARED"); // the validator prevents this; fail closed
    if (this.grantStore) {
      const grant = await this.checkGrant(tx, row, grantAction, now);
      this.metrics.increment("vsp_grant_checks_total", { result: GRANT_RESULT_LABEL[grant.reasonCode] ?? "other", guard });
      if (!grant.valid) {
        await this.appendAudit(tx, {
          row,
          action: "workflow.grant.denied",
          outcome: "DENIED",
          reasonCode: grant.reasonCode,
          actorRef: actor.ref,
          role: null,
          now,
          evidence: [`workflow:${row.workflow_id}`, `grant:${row.grant_ref}`],
          beforeHash: null,
          afterHash: null,
          idempotencyKey: null,
        });
        this.logger.warn("workflow.grant.denied", { workflowId: row.workflow_id, eventCode: event, reasonCode: grant.reasonCode });
        return { allow: false, reasonCode: grant.reasonCode };
      }
    } else {
      this.metrics.increment("vsp_grant_checks_total", { result: "store_unconfigured", guard });
      this.logger.warn("workflow.grant.unverified", { workflowId: row.workflow_id, eventCode: event, reasonCode: "GRANT_STORE_UNCONFIGURED" });
    }
    let raw: unknown;
    try {
      raw = await this.recheckHook.recheck({
        tenantId: row.tenant_id,
        workflowId: row.workflow_id,
        workflowType: def.type,
        definitionVersion: def.version,
        fromState: row.state,
        toState,
        event,
        guard,
        grantRef: row.grant_ref,
        grantAction,
        sourceRecordRefs: [...row.source_record_refs],
        policySnapshotVersion: row.policy_snapshot_version,
        actor,
        now: iso(now),
      });
    } catch (err) {
      // Fail closed: no transition, nothing recorded as a policy change (it was not one).
      if (err instanceof PlatformError) throw err;
      throw new DependencyError("RECHECK_UNAVAILABLE", "NOT_STARTED");
    }
    const parsed = RecheckResultSchema.safeParse(raw);
    if (!parsed.success) throw new DependencyError("RECHECK_RESULT_INVALID", "NOT_STARTED");
    const decision = parsed.data;
    const policyDrift =
      decision.policyVersion !== undefined && row.policy_snapshot_version !== null && decision.policyVersion !== row.policy_snapshot_version;
    await this.appendAudit(tx, {
      row,
      action: decision.allow ? "workflow.recheck.allowed" : "workflow.recheck.denied",
      outcome: decision.allow ? "ALLOWED" : "DENIED",
      reasonCode: decision.allow ? (policyDrift ? "POLICY_VERSION_CHANGED" : null) : decision.reasonCode,
      actorRef: actor.ref,
      role: null,
      now,
      // Guard names are code-defined tokens; carried as a scheme-qualified pointer (audit pointer grammar).
      evidence: [`workflow:${row.workflow_id}`, `wf://workflows/${row.workflow_id}/guards/${guard}`],
      beforeHash: null,
      afterHash: null,
      idempotencyKey: null,
      policyDecision:
        decision.decisionId !== undefined
          ? {
              decisionId: decision.decisionId,
              allow: decision.allow,
              reasonCodes: decision.allow ? [] : [decision.reasonCode],
              policyVersion: decision.policyVersion ?? "unknown",
            }
          : null,
    });
    return decision;
  }

  /** Grant check inside the transition's transaction; an unreadable store or malformed answer fails closed (no transition). */
  private async checkGrant(tx: Queryable, row: InstanceRow, action: string, now: Date): Promise<{ valid: boolean; reasonCode: string }> {
    const store = this.grantStore;
    if (!store || row.grant_ref === null) throw new ValidationError("GRANT_STORE_UNCONFIGURED");
    let raw: unknown;
    try {
      raw = await store.check(row.tenant_id, row.grant_ref, action, now, tx);
    } catch (err) {
      if (err instanceof PlatformError) throw err;
      throw new DependencyError("GRANT_STORE_UNAVAILABLE", "NOT_STARTED");
    }
    const parsed = GrantCheckResultSchema.safeParse(raw);
    if (!parsed.success) throw new DependencyError("GRANT_CHECK_RESULT_INVALID", "NOT_STARTED");
    // Only an explicit GRANT_VALID is valid; anything else is a denial even if `valid` were true.
    if (parsed.data.valid && parsed.data.reasonCode !== "GRANT_VALID") return { valid: false, reasonCode: "GRANT_CHECK_RESULT_INCONSISTENT" };
    return parsed.data;
  }

  private async recordPolicyChange(
    tx: Queryable,
    row: InstanceRow,
    def: VersionedWorkflowDefinition,
    sdef: WorkflowStateDefinition,
    actor: WorkflowEvent["actor"],
    reasonCode: string,
    now: Date,
  ): Promise<WorkflowInstance> {
    const target = sdef.transitions[POLICY_CHANGED_PENDING_ACTION];
    // The validator guarantees a route for every guarded state; fail closed if a definition lacks it.
    if (target === undefined) throw new AccessDeniedError(reasonCode);
    const { instance } = await this.applyTransition(tx, row, def, {
      trigger: POLICY_CHANGED_PENDING_ACTION,
      toState: target,
      actor,
      reasonCode,
      dedupeKey: null,
      now,
      auditAction: "workflow.policy_changed_pending_action",
    });
    this.logger.warn("workflow.policy_changed_pending_action", { workflowId: row.workflow_id, reasonCode });
    return instance;
  }

  private async appendAudit(
    tx: Queryable,
    a: {
      row: Pick<InstanceRow, "tenant_id" | "correlation_id" | "workflow_id">;
      action: string;
      outcome: AuditOutcome;
      reasonCode: string | null;
      actorRef: string | null;
      role: StaffRoleT | null;
      now: Date;
      evidence: string[];
      beforeHash: string | null;
      afterHash: string | null;
      idempotencyKey: string | null;
      policyDecision?: AuditEventInput["policyDecision"];
    },
  ): Promise<void> {
    const input: AuditEventInput = {
      occurredAt: iso(a.now),
      correlationId: a.row.correlation_id,
      parentId: null,
      tenantId: a.row.tenant_id,
      actorRef: a.actorRef,
      subjectRef: null,
      role: a.role,
      sourceComponent: "workflow",
      callId: null,
      sessionRef: null,
      sessionGeneration: null,
      turnId: null,
      versions: null,
      action: a.action,
      policyDecision: a.policyDecision ?? null,
      assurance: null,
      evidencePointers: a.evidence,
      beforeHash: a.beforeHash,
      afterHash: a.afterHash,
      idempotencyKey: a.idempotencyKey,
      outcome: a.outcome,
      reasonCode: a.reasonCode,
      dataClass: "BUSINESS_RECORD",
    };
    // AuditWriter throws AuditUnavailableError when evidence cannot be written; the transaction
    // then rolls back and the transition does not happen (OPS-01, fail closed).
    await this.audit.append(tx, input);
  }

  /** Records a denied attempt (security evidence). Never turns a denial into success when audit is down. */
  private async auditDenial(
    tenantId: string,
    workflowId: string | null,
    action: string,
    reasonCode: string,
    actorRef: string | null,
    taskId: string | null,
  ): Promise<void> {
    const now = this.clock.now();
    const evidence: string[] = [];
    if (workflowId && WorkflowId.safeParse(workflowId).success) evidence.push(`workflow:${workflowId}`);
    if (taskId && TaskId.safeParse(taskId).success) evidence.push(`workflow_task:${taskId}`);
    try {
      await this.audit.appendStandalone({
        occurredAt: iso(now),
        correlationId: newId("cor"),
        parentId: null,
        tenantId,
        actorRef,
        subjectRef: null,
        role: null,
        sourceComponent: "workflow",
        callId: null,
        sessionRef: null,
        sessionGeneration: null,
        turnId: null,
        versions: null,
        action,
        policyDecision: null,
        assurance: null,
        evidencePointers: evidence,
        beforeHash: null,
        afterHash: null,
        idempotencyKey: null,
        outcome: "DENIED",
        reasonCode,
        dataClass: "SECURITY_AUDIT",
      });
    } catch {
      this.logger.error("workflow.audit.denial_unrecorded", { reasonCode });
    }
  }
}
