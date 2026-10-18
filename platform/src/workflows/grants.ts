/**
 * Durable action grants (spec section 7: "Asynchronous workflows use a narrowly
 * authorized durable action grant; they do not reuse an expired call token as
 * unlimited authority").
 *
 * When durable work is accepted (inside the accepting transaction), the trusted
 * backend issues a grant that names the subject (and optionally the actor) it was
 * issued for, a closed list of dotted action names it authorizes (for example
 * "billing.review.commit"), an expiry and the opaque source record that justified
 * it. Every guarded (disclosure / material change) workflow transition then
 * requires `check(...)` to be valid for exactly the action its definition
 * declares (VersionedWorkflowDefinition.grantActions). Revocation (consent
 * withdrawn, representation ended, account recovery, fraud or safety escalation)
 * applies immediately.
 *
 * Content rules (DATA-01): opaque ids, dotted code tokens and reason codes only;
 * no PHI, no session bearer, no call token. The grant id is a reference, not a
 * bearer secret: only trusted backend code checks it, inside the tenant's RLS
 * context. Times come from the injected Clock.
 */
import { z } from "zod";
import type { AuditWriter } from "../audit/ports.js";
import type { Db, Queryable } from "../db/types.js";
import { silentLogger } from "../observability/logger.js";
import type { Logger } from "../observability/ports.js";
import { OpaqueId, ReasonCode, SupportReference, opaqueIdWithPrefix, type AuditEventInput } from "../protocol/index.js";
import { addMs, iso, type Clock } from "../shared/clock.js";
import { AccessDeniedError, DependencyError, PlatformError, ValidationError } from "../shared/errors.js";
import { newId } from "../shared/ids.js";
import { GRANT_ACTION_RE } from "./types.js";

/** Reason codes returned by check(). Only GRANT_VALID means valid. */
export const GRANT_CHECK_REASONS = [
  "GRANT_VALID",
  "GRANT_INPUT_INVALID",
  "GRANT_NOT_FOUND",
  "GRANT_EXPIRED",
  "GRANT_REVOKED",
  "GRANT_ACTION_NOT_PERMITTED",
] as const;
export type GrantCheckReason = (typeof GRANT_CHECK_REASONS)[number];

export interface DurableGrantIssueInput {
  tenantId: string;
  subjectId: string;
  actorId: string | null;
  actions: string[];
  expiresAt: Date;
  sourceRef: string;
}

/** Port consumed by PgWorkflowEngine (and by the business layer that issues grants). */
export interface DurableGrantStore {
  readonly kind: "local_fixture" | "live";
  /** Optional `tx`: issue inside the accepting transaction (must already be scoped to `tenantId`). */
  issue(input: DurableGrantIssueInput, tx?: Queryable): Promise<{ grantRef: string }>;
  /**
   * Valid only when the grant exists in the tenant, is unrevoked, `now` is before
   * its expiry and `action` is one of its actions. A store outage throws
   * (DependencyError GRANT_STORE_UNAVAILABLE) and must fail closed at the caller.
   * Optional `tx`: check inside the caller's transaction (must be scoped to `tenantId`).
   */
  check(tenantId: string, grantRef: string, action: string, now: Date, tx?: Queryable): Promise<{ valid: boolean; reasonCode: string }>;
  /** Idempotent; a revoked grant stays revoked. Unknown grants are refused (GRANT_NOT_FOUND). */
  revoke(tenantId: string, grantRef: string, reasonCode: string): Promise<void>;
}

export interface PgDurableGrantStoreOptions {
  db: Db;
  clock: Clock;
  /** When configured, issue and revoke append an audit event in the same transaction (fail closed). */
  audit?: AuditWriter | null;
  logger?: Logger;
  /** Role for issue/revoke/check transactions the store opens itself (default app_runtime). */
  role?: "app_runtime" | "app_worker";
  /**
   * Upper bound on a grant's lifetime. ENGINEERING DEFAULT (30 days) pending security
   * approval; the issuing workflow should request the shortest expiry its deadlines allow.
   */
  maxTtlSeconds?: number;
  auditStream?: string;
}

const GrantId = opaqueIdWithPrefix("grt");
const GrantAction = z
  .string()
  .regex(GRANT_ACTION_RE)
  .refine((a) => !/\d{4,}/.test(a));
const IssueInputSchema = z.strictObject({
  tenantId: OpaqueId,
  subjectId: OpaqueId,
  actorId: OpaqueId.nullable(),
  actions: z
    .array(GrantAction)
    .min(1)
    .max(16)
    .refine((a) => new Set(a).size === a.length),
  expiresAt: z.date(),
  sourceRef: z.union([OpaqueId, SupportReference]),
});

interface GrantRow {
  grant_id: string;
  actions: string[];
  expires_at: Date | string;
  revoked_at: Date | string | null;
}

const ms = (v: Date | string): number => (v instanceof Date ? v.getTime() : Date.parse(v));

/** PostgreSQL-backed grants (migration 0402). "local_fixture" on embedded PGlite, "live" on pg/Aurora. */
export class PgDurableGrantStore implements DurableGrantStore {
  readonly kind: "local_fixture" | "live";
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly audit: AuditWriter | null;
  private readonly logger: Logger;
  private readonly role: "app_runtime" | "app_worker";
  private readonly maxTtlMs: number;
  private readonly auditStream: string;

  constructor(opts: PgDurableGrantStoreOptions) {
    this.db = opts.db;
    this.kind = opts.db.engine === "pglite" ? "local_fixture" : "live";
    this.clock = opts.clock;
    this.audit = opts.audit ?? null;
    this.logger = (opts.logger ?? silentLogger).child({ component: "durable_grants" });
    this.role = opts.role ?? "app_runtime";
    const ttl = opts.maxTtlSeconds ?? 30 * 86_400;
    if (!Number.isInteger(ttl) || ttl < 60 || ttl > 366 * 86_400) throw new ValidationError("GRANT_MAX_TTL_INVALID");
    this.maxTtlMs = ttl * 1000;
    this.auditStream = opts.auditStream ?? "workflows.grants";
    if (!/^[a-z0-9_.-]{3,64}$/.test(this.auditStream)) throw new ValidationError("GRANT_AUDIT_STREAM_INVALID");
  }

  async issue(raw: DurableGrantIssueInput, tx?: Queryable): Promise<{ grantRef: string }> {
    const parsed = IssueInputSchema.safeParse(raw);
    if (!parsed.success) throw new ValidationError("GRANT_ISSUE_INPUT_INVALID");
    const input = parsed.data;
    const now = this.clock.now();
    if (!Number.isFinite(input.expiresAt.getTime()) || input.expiresAt.getTime() <= now.getTime()) throw new ValidationError("GRANT_EXPIRY_NOT_IN_FUTURE");
    if (input.expiresAt.getTime() > addMs(now, this.maxTtlMs).getTime()) throw new ValidationError("GRANT_EXPIRY_BEYOND_MAXIMUM");
    const grantRef = newId("grt");
    const run = async (q: Queryable): Promise<{ grantRef: string }> => {
      await this.assertTenantContext(q, input.tenantId);
      await q.query(
        `insert into durable_action_grants (grant_id, tenant_id, subject_id, actor_id, actions, source_ref, issued_at, expires_at)
         values ($1, $2, $3, $4, $5::text[], $6, $7, $8)`,
        [grantRef, input.tenantId, input.subjectId, input.actorId, [...input.actions].sort(), input.sourceRef, iso(now), iso(input.expiresAt)],
      );
      await this.appendAudit(q, input.tenantId, "workflow.grant.issued", "SUCCEEDED", null, grantRef, input.actorId, now);
      return { grantRef };
    };
    const result = tx ? await run(tx) : await this.db.tx(run, { role: this.role, rls: { tenantId: input.tenantId } });
    this.logger.info("workflow.grant.issued", { grantId: grantRef, count: input.actions.length });
    return result;
  }

  async check(tenantId: string, grantRef: string, action: string, now: Date, tx?: Queryable): Promise<{ valid: boolean; reasonCode: string }> {
    if (
      !OpaqueId.safeParse(tenantId).success ||
      !GrantId.safeParse(grantRef).success ||
      !GrantAction.safeParse(action).success ||
      !(now instanceof Date) ||
      !Number.isFinite(now.getTime())
    ) {
      return { valid: false, reasonCode: "GRANT_INPUT_INVALID" };
    }
    const read = async (q: Queryable): Promise<GrantRow | null> => {
      await this.assertTenantContext(q, tenantId);
      const r = await q.query<GrantRow>("select grant_id, actions, expires_at, revoked_at from durable_action_grants where grant_id = $1 and tenant_id = $2", [
        grantRef,
        tenantId,
      ]);
      return r.rows[0] ?? null;
    };
    let row: GrantRow | null;
    try {
      row = tx ? await read(tx) : await this.db.tx(read, { role: this.role, rls: { tenantId } });
    } catch (err) {
      if (err instanceof PlatformError) throw err;
      // Fail closed at the caller: an unreadable grant store is not a policy decision.
      throw new DependencyError("GRANT_STORE_UNAVAILABLE", "NOT_STARTED");
    }
    if (!row) return { valid: false, reasonCode: "GRANT_NOT_FOUND" };
    // Order matters: revocation and expiry are reported before scope so revoked grants never look merely mis-scoped.
    if (row.revoked_at !== null) return { valid: false, reasonCode: "GRANT_REVOKED" };
    if (now.getTime() >= ms(row.expires_at)) return { valid: false, reasonCode: "GRANT_EXPIRED" };
    if (!row.actions.includes(action)) return { valid: false, reasonCode: "GRANT_ACTION_NOT_PERMITTED" };
    return { valid: true, reasonCode: "GRANT_VALID" };
  }

  async revoke(tenantId: string, grantRef: string, reasonCode: string): Promise<void> {
    if (!OpaqueId.safeParse(tenantId).success || !GrantId.safeParse(grantRef).success) throw new ValidationError("GRANT_REVOKE_INPUT_INVALID");
    const reason = ReasonCode.safeParse(reasonCode);
    if (!reason.success || /\d{4,}/.test(reasonCode)) throw new ValidationError("GRANT_REVOKE_REASON_INVALID");
    const now = this.clock.now();
    const revoked = await this.db.tx(
      async (q) => {
        const r = await q.query<{ revoked_at: Date | string | null }>("select revoked_at from durable_action_grants where grant_id = $1 and tenant_id = $2 for update", [
          grantRef,
          tenantId,
        ]);
        const row = r.rows[0];
        if (!row) throw new AccessDeniedError("GRANT_NOT_FOUND");
        if (row.revoked_at !== null) return false; // idempotent: the first revocation stands
        await q.query("update durable_action_grants set revoked_at = $3, revoked_reason = $4 where grant_id = $1 and tenant_id = $2", [
          grantRef,
          tenantId,
          iso(now),
          reason.data,
        ]);
        await this.appendAudit(q, tenantId, "workflow.grant.revoked", "INVALIDATED", reason.data, grantRef, null, now);
        return true;
      },
      { role: this.role, rls: { tenantId } },
    );
    if (revoked) this.logger.info("workflow.grant.revoked", { grantId: grantRef, reasonCode: reason.data });
  }

  private async assertTenantContext(q: Queryable, tenantId: string): Promise<void> {
    const ctx = await q.query<{ t: string | null }>("select app_tenant() as t");
    if (ctx.rows[0]?.t !== tenantId) throw new AccessDeniedError("TENANT_CONTEXT_MISMATCH");
  }

  private async appendAudit(
    q: Queryable,
    tenantId: string,
    action: string,
    outcome: AuditEventInput["outcome"],
    reasonCode: string | null,
    grantRef: string,
    actorRef: string | null,
    now: Date,
  ): Promise<void> {
    if (!this.audit) return;
    await this.audit.append(
      q,
      {
        occurredAt: iso(now),
        correlationId: grantRef,
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
        evidencePointers: [`grant:${grantRef}`],
        beforeHash: null,
        afterHash: null,
        idempotencyKey: null,
        outcome,
        reasonCode,
        dataClass: "SECURITY_AUDIT",
      },
      this.auditStream,
    );
  }
}
