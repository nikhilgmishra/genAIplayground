/**
 * Kill switches (spec section 13) backed by PostgreSQL (migration 0600).
 *
 * - set(): MFA-authenticated supervisor or security_admin (plus deployment_operator
 *   for MODEL_VERSION / VOICE_VERSION). Current state, an append-only history row
 *   and the "killswitch.set" audit event are written in ONE transaction: if the
 *   audit event cannot be written durably the change does not happen (OPS-01).
 *   Denied attempts are audited too (best effort; the denial stands regardless).
 * - snapshot(): read on the runtime path (role app_runtime, tenant RLS). If the
 *   state cannot be read it FAILS CLOSED to "everything engaged", which stops new
 *   automation but never the safety and human routes (they are never gated).
 *
 * Cache TTL trade-off: `cacheTtlMs` defaults to 0 (read on every check). A
 * positive TTL reduces database reads but means an engaged switch can take up to
 * TTL to reach every instance (this instance's cache is invalidated on its own
 * writes). Because switches only ever restrict automation and safety/human routes
 * ignore them, staleness can delay containment but never block a safety route.
 */
import { z } from "zod";
import type { Db } from "../db/types.js";
import type { AuditWriter } from "../audit/ports.js";
import type { Logger, Metrics } from "../observability/ports.js";
import { silentLogger } from "../observability/logger.js";
import { KillSwitch, KillSwitchScope, OpaqueId, VersionLabel } from "../protocol/index.js";
import type { AuditEventInput, StaffActor } from "../protocol/index.js";
import type { Clock } from "../shared/clock.js";
import { iso } from "../shared/clock.js";
import { digestOf } from "../shared/canonical.js";
import { AccessDeniedError, AuditUnavailableError, ConflictError, DependencyError, PlatformError, ValidationError } from "../shared/errors.js";
import { newId } from "../shared/ids.js";
import type { AdmissionClass, KillSwitchService, KillSwitchSnapshot } from "./ports.js";
import { KILL_SWITCH_ROLES, authorizeStaff } from "./staff-authz.js";

export const GLOBAL_SCOPES: readonly KillSwitchScope[] = ["AI_ADMISSION", "WRITES", "OUTBOUND_NOTIFICATIONS"];

const INTENT_TARGET = /^[a-z][a-z0-9_.@:-]{1,79}$/;
const INTEGRATION_TARGET = /^[a-z0-9-]{3,64}$/;
/** Reason code, optionally followed by an opaque incident reference: never free text (no PHI). */
export const KILL_SWITCH_REASON = /^[A-Z][A-Z0-9_]{2,63}(:[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64})?$/;
const FOUR_DIGIT_RUN = /\d{4,}/;

export const KillSwitchSetInput = z
  .strictObject({
    tenantId: OpaqueId,
    scope: KillSwitchScope,
    target: z.string().min(1).max(80),
    engaged: z.boolean(),
    reason: z.string().regex(KILL_SWITCH_REASON),
    staff: z.unknown(),
    correlationId: OpaqueId.optional(),
  })
  .superRefine((v, ctx) => {
    const global = GLOBAL_SCOPES.includes(v.scope);
    const ok = global
      ? v.target === "*"
      : v.scope === "INTENT"
        ? INTENT_TARGET.test(v.target)
        : v.scope === "INTEGRATION"
          ? INTEGRATION_TARGET.test(v.target)
          : VersionLabel.safeParse(v.target).success;
    if (!ok) ctx.addIssue({ code: "custom", path: ["target"], message: "target shape" });
    if (FOUR_DIGIT_RUN.test(v.reason.split(":")[0] ?? "")) ctx.addIssue({ code: "custom", path: ["reason"], message: "reason code digit run" });
  });

/** Snapshot used when state cannot be read: every automation switch engaged. */
export const FAIL_CLOSED_SNAPSHOT: Readonly<KillSwitchSnapshot> = Object.freeze({
  aiAdmission: true,
  writes: true,
  outboundNotifications: true,
  intents: [],
  integrations: [],
  modelVersions: [],
  voiceVersions: [],
});

export const emptySnapshot = (): KillSwitchSnapshot => ({
  aiAdmission: false,
  writes: false,
  outboundNotifications: false,
  intents: [],
  integrations: [],
  modelVersions: [],
  voiceVersions: [],
});

export function snapshotFromEngaged(rows: readonly { scope: string; target: string }[]): KillSwitchSnapshot {
  const s = emptySnapshot();
  for (const r of rows) {
    if (r.scope === "AI_ADMISSION") s.aiAdmission = true;
    else if (r.scope === "WRITES") s.writes = true;
    else if (r.scope === "OUTBOUND_NOTIFICATIONS") s.outboundNotifications = true;
    else if (r.scope === "INTENT") s.intents.push(r.target);
    else if (r.scope === "INTEGRATION") s.integrations.push(r.target);
    else if (r.scope === "MODEL_VERSION") s.modelVersions.push(r.target);
    else if (r.scope === "VOICE_VERSION") s.voiceVersions.push(r.target);
  }
  for (const list of [s.intents, s.integrations, s.modelVersions, s.voiceVersions]) list.sort();
  return s;
}

export interface KillSwitchRequest {
  class: AdmissionClass;
  newSession?: boolean;
  intent?: string | null;
  integration?: string | null;
  modelVersion?: string | null;
  voiceVersion?: string | null;
}

export type KillSwitchBlockReason =
  | "KILL_SWITCH_AI_ADMISSION"
  | "KILL_SWITCH_WRITES"
  | "KILL_SWITCH_INTENT"
  | "KILL_SWITCH_INTEGRATION"
  | "KILL_SWITCH_MODEL_VERSION"
  | "KILL_SWITCH_VOICE_VERSION";

/**
 * Pure evaluation shared by admission and the gateway. SAFETY and HUMAN_ROUTE are
 * never blocked by any switch. AI_ADMISSION blocks only new AI sessions.
 */
export function killSwitchBlock(snapshot: KillSwitchSnapshot, req: KillSwitchRequest): KillSwitchBlockReason | null {
  if (req.class === "SAFETY" || req.class === "HUMAN_ROUTE") return null;
  if (req.newSession && snapshot.aiAdmission) return "KILL_SWITCH_AI_ADMISSION";
  if (req.class === "WRITE" && snapshot.writes) return "KILL_SWITCH_WRITES";
  if (req.intent && snapshot.intents.includes(req.intent)) return "KILL_SWITCH_INTENT";
  if (req.integration && snapshot.integrations.includes(req.integration)) return "KILL_SWITCH_INTEGRATION";
  if (req.modelVersion && snapshot.modelVersions.includes(req.modelVersion)) return "KILL_SWITCH_MODEL_VERSION";
  if (req.voiceVersion && snapshot.voiceVersions.includes(req.voiceVersion)) return "KILL_SWITCH_VOICE_VERSION";
  return null;
}

/**
 * Outbound notifications switch. Notifications that page staff for a safety
 * escalation are part of the safety route and are not gated.
 */
export function notificationAllowed(snapshot: KillSwitchSnapshot, purpose: "ROUTINE" | "SAFETY_ESCALATION"): boolean {
  return purpose === "SAFETY_ESCALATION" || !snapshot.outboundNotifications;
}

export interface KillSwitchServicePgOptions {
  db: Db;
  audit: AuditWriter;
  clock: Clock;
  metrics?: Metrics;
  logger?: Logger;
  /** Snapshot cache TTL in ms (default 0 = no cache). Bounded to 60 s. */
  cacheTtlMs?: number;
}

interface SwitchRow {
  switch_id: string;
  scope: string;
  target: string;
  engaged: boolean;
  reason: string;
  changed_by: string;
  changed_at: Date | string;
  version: number;
}

const toIso = (v: Date | string): string => new Date(v).toISOString();

function rowToKillSwitch(r: SwitchRow): KillSwitch {
  return KillSwitch.parse({
    switchId: r.switch_id,
    scope: r.scope,
    target: r.target,
    engaged: r.engaged,
    reason: r.reason,
    changedBy: r.changed_by,
    changedAt: toIso(r.changed_at),
  });
}

export class KillSwitchServicePg implements KillSwitchService {
  readonly kind = "live" as const;
  private readonly cache = new Map<string, { at: number; snapshot: KillSwitchSnapshot }>();
  private readonly ttlMs: number;
  private readonly logger: Logger;

  constructor(private readonly opts: KillSwitchServicePgOptions) {
    const ttl = opts.cacheTtlMs ?? 0;
    if (!Number.isInteger(ttl) || ttl < 0 || ttl > 60_000) throw new ValidationError("KILL_SWITCH_CACHE_TTL_INVALID");
    this.ttlMs = ttl;
    this.logger = (opts.logger ?? silentLogger).child({ component: "kill_switches" });
  }

  async snapshot(tenantId: string): Promise<KillSwitchSnapshot> {
    if (!OpaqueId.safeParse(tenantId).success) return this.failClosed("KILL_SWITCH_TENANT_INVALID");
    const now = this.opts.clock.now().getTime();
    if (this.ttlMs > 0) {
      const hit = this.cache.get(tenantId);
      if (hit && now - hit.at < this.ttlMs) return structuredClone(hit.snapshot);
    }
    try {
      const rows = await this.opts.db.tx(
        async (tx) => (await tx.query<{ scope: string; target: string }>("select scope, target from kill_switches where engaged order by scope, target")).rows,
        { role: "app_runtime", rls: { tenantId } },
      );
      const snapshot = snapshotFromEngaged(rows);
      if (this.ttlMs > 0) this.cache.set(tenantId, { at: now, snapshot });
      this.publishGauges(rows);
      return structuredClone(snapshot);
    } catch {
      return this.failClosed("KILL_SWITCH_STATE_UNAVAILABLE");
    }
  }

  async list(tenantId: string): Promise<KillSwitch[]> {
    const t = OpaqueId.parse(tenantId);
    const rows = await this.opts.db.tx(
      async (tx) => (await tx.query<SwitchRow>("select switch_id, scope, target, engaged, reason, changed_by, changed_at, version from kill_switches order by scope, target")).rows,
      { role: "app_console", rls: { tenantId: t } },
    );
    return rows.map(rowToKillSwitch);
  }

  /** Append-only change history for the console (newest first). */
  async history(tenantId: string, limit = 100): Promise<(KillSwitch & { version: number; authorizingRole: string; auditEventId: string })[]> {
    const t = OpaqueId.parse(tenantId);
    const n = Math.min(Math.max(1, Math.trunc(limit)), 500);
    const rows = await this.opts.db.tx(
      async (tx) =>
        (
          await tx.query<SwitchRow & { authorizing_role: string; audit_event_id: string }>(
            `select switch_id, scope, target, engaged, reason, changed_by, changed_at, version, authorizing_role, audit_event_id
               from kill_switch_history order by history_seq desc limit $1`,
            [n],
          )
        ).rows,
      { role: "app_console", rls: { tenantId: t } },
    );
    return rows.map((r) => ({ ...rowToKillSwitch(r), version: r.version, authorizingRole: r.authorizing_role, auditEventId: r.audit_event_id }));
  }

  async set(input: { tenantId: string; scope: KillSwitchScope; target: string; engaged: boolean; reason: string; staff: StaffActor; correlationId?: string }): Promise<KillSwitch> {
    const parsed = KillSwitchSetInput.safeParse(input);
    if (!parsed.success) throw new ValidationError("KILL_SWITCH_INPUT_INVALID");
    const req = parsed.data;
    const now = this.opts.clock.now();
    const correlationId = req.correlationId ?? newId("cor");
    let authz;
    try {
      authz = authorizeStaff(req.staff, KILL_SWITCH_ROLES[req.scope], now);
    } catch (err) {
      const code = err instanceof PlatformError ? err.reasonCode : "STAFF_INVALID";
      await this.auditDenied(req.tenantId, correlationId, code, req.staff, now);
      throw err instanceof AccessDeniedError ? err : new AccessDeniedError(code);
    }
    const { staff, role } = authz;
    const reasonCode = req.reason.split(":")[0] ?? req.reason;

    let result: KillSwitch;
    try {
      result = await this.opts.db.tx(
        async (tx) => {
          const prior = (
            await tx.query<SwitchRow>(
              "select switch_id, scope, target, engaged, reason, changed_by, changed_at, version from kill_switches where scope = $1 and target = $2 for update",
              [req.scope, req.target],
            )
          ).rows[0];
          const switchId = prior?.switch_id ?? newId("ksw");
          const version = (prior?.version ?? 0) + 1;
          const changedAt = iso(now);
          if (prior) {
            const upd = await tx.query(
              `update kill_switches set engaged = $1, reason = $2, changed_by = $3, changed_at = $4::timestamptz, version = $5
                where scope = $6 and target = $7 and version = $8`,
              [req.engaged, req.reason, staff.staffId, changedAt, version, req.scope, req.target, prior.version],
            );
            if (upd.rowCount !== 1) throw new ConflictError("KILL_SWITCH_CONCURRENT_CHANGE");
          } else {
            await tx.query(
              `insert into kill_switches (tenant_id, scope, target, switch_id, engaged, reason, changed_by, changed_at, version)
               values ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9)`,
              [req.tenantId, req.scope, req.target, switchId, req.engaged, req.reason, staff.staffId, changedAt, version],
            );
          }
          const historyId = newId("ksh");
          const before = prior ? { scope: prior.scope, target: prior.target, engaged: prior.engaged, version: prior.version } : null;
          const after = { scope: req.scope, target: req.target, engaged: req.engaged, version };
          const event = await this.opts.audit.append(
            tx,
            this.auditInput({
              tenantId: req.tenantId,
              correlationId,
              staff,
              role,
              now,
              outcome: "SUCCEEDED",
              reasonCode,
              evidencePointers: [`db://kill_switch_history/${historyId}`],
              beforeHash: before ? digestOf(before) : null,
              afterHash: digestOf(after),
              decisionReason: "KILL_SWITCH_ROLE_AUTHORIZED",
            }),
          );
          await tx.query(
            `insert into kill_switch_history (history_id, tenant_id, switch_id, scope, target, engaged, previous_engaged, reason, changed_by,
                                              authorizing_role, changed_at, version, audit_event_id)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::timestamptz, $12, $13)`,
            [historyId, req.tenantId, switchId, req.scope, req.target, req.engaged, prior ? prior.engaged : null, req.reason, staff.staffId, role, changedAt, version, event.eventId],
          );
          return KillSwitch.parse({ switchId, scope: req.scope, target: req.target, engaged: req.engaged, reason: req.reason, changedBy: staff.staffId, changedAt });
        },
        { role: "app_console", rls: { tenantId: req.tenantId, actorId: staff.staffId } },
      );
    } catch (err) {
      // Audit unavailability and concurrent changes surface as-is; anything else is a
      // failed write whose commit state the caller must re-read (list) before retrying.
      if (err instanceof ConflictError || err instanceof AuditUnavailableError) throw err;
      throw new DependencyError("KILL_SWITCH_WRITE_FAILED", "UNKNOWN", false);
    }
    this.cache.delete(req.tenantId);
    this.opts.metrics?.increment("vsp_killswitch_changes_total", { scope: req.scope, engaged: String(req.engaged) });
    this.logger.info("killswitch.set", { scope: req.scope, engaged: req.engaged, staffId: staff.staffId, role, correlationId });
    return result;
  }

  private auditInput(p: {
    tenantId: string;
    correlationId: string;
    staff: { staffId: string } | null;
    role: string | null;
    now: Date;
    outcome: "SUCCEEDED" | "DENIED";
    reasonCode: string;
    evidencePointers: string[];
    beforeHash: string | null;
    afterHash: string | null;
    decisionReason: string;
  }): AuditEventInput {
    return {
      occurredAt: iso(p.now),
      correlationId: p.correlationId,
      parentId: null,
      tenantId: p.tenantId,
      actorRef: p.staff?.staffId ?? null,
      subjectRef: null,
      role: (p.role as AuditEventInput["role"]) ?? null,
      sourceComponent: "console",
      callId: null,
      sessionRef: null,
      sessionGeneration: null,
      turnId: null,
      versions: null,
      action: "killswitch.set",
      policyDecision: { decisionId: newId("dec"), allow: p.outcome === "SUCCEEDED", reasonCodes: [p.decisionReason], policyVersion: "ops-killswitch-rbac-v1" },
      assurance: null,
      evidencePointers: p.evidencePointers,
      beforeHash: p.beforeHash,
      afterHash: p.afterHash,
      idempotencyKey: null,
      outcome: p.outcome,
      reasonCode: p.reasonCode,
      dataClass: "SECURITY_AUDIT",
    };
  }

  private async auditDenied(tenantId: string, correlationId: string, code: string, staffInput: unknown, now: Date): Promise<void> {
    const staffId = typeof (staffInput as { staffId?: unknown } | null)?.staffId === "string" ? (staffInput as { staffId: string }).staffId : null;
    const actor = staffId && OpaqueId.safeParse(staffId).success ? { staffId } : null;
    try {
      await this.opts.audit.appendStandalone(
        this.auditInput({ tenantId, correlationId, staff: actor, role: null, now, outcome: "DENIED", reasonCode: code, evidencePointers: [], beforeHash: null, afterHash: null, decisionReason: code }),
      );
    } catch (err) {
      // The denial stands even if it could not be audited.
      this.logger.warn("killswitch.set.denial_unaudited", { reasonCode: err instanceof PlatformError ? err.reasonCode : "UNCLASSIFIED_ERROR" });
    }
  }

  private failClosed(reasonCode: string): KillSwitchSnapshot {
    this.opts.metrics?.increment("vsp_killswitch_snapshot_failures_total");
    this.logger.warn("killswitch.snapshot.failed_closed", { reasonCode });
    return structuredClone(FAIL_CLOSED_SNAPSHOT) as KillSwitchSnapshot;
  }

  private publishGauges(rows: readonly { scope: string }[]): void {
    const m = this.opts.metrics;
    if (!m) return;
    for (const scope of KillSwitchScope.options) m.gauge("vsp_killswitch_engaged", rows.filter((r) => r.scope === scope).length, { scope });
  }
}
