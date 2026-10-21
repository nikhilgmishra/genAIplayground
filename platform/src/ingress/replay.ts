/**
 * Audited operator replay of quarantined and dead-lettered inbound events (follow-on FO-06-97, FO-07-21;
 * OPS-01, OPS-03, AUTH-02).
 *
 * A replay returns the event to RECEIVED with a fresh attempt budget so the processor applies it (exactly
 * once: one inbox row, processed in one transaction). It is refused unless ALL hold:
 *   - the operator is an authenticated staff member (opaque stf_ reference, authenticated by the console)
 *     whose MFA was verified within the last `mfaMaxAgeSeconds` (default 900);
 *   - the reason code is on the allowlist;
 *   - the event is QUARANTINED or INBOUND_DEAD and has been replayed fewer than `maxReplays` times;
 *   - the audit event inbox.replay is appended in the SAME transaction: if the audit store cannot be
 *     written, nothing changes (fail closed; vsp_inbox_replays_total{result="refused_audit"}).
 * The replay record (inbound_replays) and the closing of the stream gap the event left are written in that
 * transaction too.
 */
import type { AuditWriter } from "../audit/ports.js";
import { buildAuditInput } from "../audit/build-input.js";
import type { Db } from "../db/types.js";
import { silentLogger } from "../observability/logger.js";
import { noopMetrics } from "../observability/metrics.js";
import type { Logger, Metrics } from "../observability/ports.js";
import type { Clock } from "../shared/clock.js";
import { iso } from "../shared/clock.js";
import { AccessDeniedError, AuditUnavailableError, ConflictError, PlatformError, ValidationError } from "../shared/errors.js";
import { newId } from "../shared/ids.js";

export const REPLAY_REASON_CODES = ["CONTRACT_UPDATED", "HANDLER_DEFECT_FIXED", "DEPENDENCY_RECOVERED", "SOURCE_CORRECTED_PAYLOAD", "OPERATOR_INVESTIGATION"] as const;
export type ReplayReasonCode = (typeof REPLAY_REASON_CODES)[number];

export interface ReplayRequest {
  tenantId: string;
  inboxId: string;
  operator: { staffRef: string; mfaVerifiedAt: string; reasonCode: string; correlationId?: string };
}

export interface ReplayResult {
  replayId: string;
  auditEventId: string;
  priorStatus: "QUARANTINED" | "INBOUND_DEAD";
  gapsClosed: number;
}

export interface InboxReplayServiceOptions {
  db: Db;
  audit: AuditWriter;
  clock: Clock;
  /** Role of the console API (default app_console). */
  role?: "app_console" | "app_worker";
  auditStream?: string;
  mfaMaxAgeSeconds?: number;
  maxReplays?: number;
  logger?: Logger;
  metrics?: Metrics;
}

export class InboxReplayService {
  private readonly logger: Logger;
  private readonly metrics: Metrics;
  private readonly mfaMaxAgeMs: number;
  private readonly maxReplays: number;

  constructor(private readonly opts: InboxReplayServiceOptions) {
    const mfa = opts.mfaMaxAgeSeconds ?? 900;
    const max = opts.maxReplays ?? 5;
    if (!Number.isSafeInteger(mfa) || mfa < 60 || mfa > 3600 || !Number.isSafeInteger(max) || max < 1 || max > 100) throw new ValidationError("INBOX_REPLAY_POLICY_INVALID");
    this.mfaMaxAgeMs = mfa * 1000;
    this.maxReplays = max;
    this.logger = (opts.logger ?? silentLogger).child({ component: "inbox_replay" });
    this.metrics = opts.metrics ?? noopMetrics;
  }

  async replay(req: ReplayRequest): Promise<ReplayResult> {
    const now = this.opts.clock.now();
    if (!/^inb_[A-Za-z0-9_-]{16,64}$/.test(req.inboxId) || !/^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$/.test(req.tenantId)) throw new ValidationError("INBOX_REPLAY_INPUT_INVALID");
    // Same grammar as the audit actorRef (OpaqueId), so a refused ref is a policy refusal, never an invalid audit event.
    if (!/^stf_[A-Za-z0-9_-]{16,64}$/.test(req.operator.staffRef)) return this.refuse("refused_policy", new AccessDeniedError("INBOX_REPLAY_OPERATOR_INVALID"));
    if (!(REPLAY_REASON_CODES as readonly string[]).includes(req.operator.reasonCode)) return this.refuse("refused_policy", new AccessDeniedError("INBOX_REPLAY_REASON_NOT_ALLOWED"));
    const mfaAt = Date.parse(req.operator.mfaVerifiedAt);
    if (Number.isNaN(mfaAt) || mfaAt > now.getTime() || now.getTime() - mfaAt > this.mfaMaxAgeMs) return this.refuse("refused_policy", new AccessDeniedError("INBOX_REPLAY_MFA_REQUIRED"));
    try {
      const result = await this.opts.db.tx(
        async (tx) => {
          const r = await tx.query<{ status: string; replay_count: number; source_id: string }>(
            "select status, replay_count, source_id from inbound_events where inbox_id = $1 for update",
            [req.inboxId],
          );
          const row = r.rows[0];
          if (!row) throw new ValidationError("INBOX_EVENT_NOT_FOUND");
          if (row.status !== "QUARANTINED" && row.status !== "INBOUND_DEAD") throw new ConflictError("INBOX_REPLAY_STATE_INVALID");
          if (row.replay_count >= this.maxReplays) throw new ConflictError("INBOX_REPLAY_LIMIT_REACHED");
          const replayId = newId("irp");
          // Audit FIRST, in this transaction: no audit, no replay.
          const audit = await this.opts.audit.append(
            tx,
            buildAuditInput(
              {
                tenantId: req.tenantId,
                correlationId: req.operator.correlationId ?? replayId,
                sourceComponent: "console",
                action: "inbox.replay",
                outcome: "SUCCEEDED",
                actorRef: req.operator.staffRef,
                reasonCode: req.operator.reasonCode,
                evidencePointers: [`inbox:${req.inboxId}`, `replay:${replayId}`],
                dataClass: "SECURITY_AUDIT",
              },
              this.opts.clock,
            ),
            this.opts.auditStream,
          );
          await tx.query(
            `insert into inbound_replays (replay_id, inbox_id, tenant_id, operator_ref, reason_code, mfa_verified_at, prior_status, requested_at, audit_event_id)
             values ($1, $2, $3, $4, $5, $6::timestamptz, $7, $8::timestamptz, $9)`,
            [replayId, req.inboxId, req.tenantId, req.operator.staffRef, req.operator.reasonCode, new Date(mfaAt).toISOString(), row.status, iso(now), audit.eventId],
          );
          await tx.query(
            `update inbound_events set status = 'RECEIVED', attempts = 0, next_attempt_at = $2::timestamptz, claim_token = null, claimed_until = null,
                    last_error_code = null, quarantine_reason = null, dead_reason = null, dead_at = null, schema_id = null, schema_version = null,
                    replay_count = replay_count + 1, updated_at = $2::timestamptz
              where inbox_id = $1`,
            [req.inboxId, iso(now)],
          );
          const gaps = await tx.query(
            "update inbox_stream_gaps set closed_at = $2::timestamptz, closed_by_replay_id = $3 where inbox_id = $1 and closed_at is null",
            [req.inboxId, iso(now), replayId],
          );
          return { replayId, auditEventId: audit.eventId, priorStatus: row.status as ReplayResult["priorStatus"], gapsClosed: gaps.rowCount };
        },
        { role: this.opts.role ?? "app_console", rls: { tenantId: req.tenantId } },
      );
      this.count("replayed");
      this.logger.info("inbox.replayed", { inboxId: req.inboxId, replayId: result.replayId, reasonCode: req.operator.reasonCode });
      return result;
    } catch (err) {
      if (err instanceof AuditUnavailableError) return this.refuse("refused_audit", err);
      if (err instanceof ConflictError || (err instanceof ValidationError && err.reasonCode === "INBOX_EVENT_NOT_FOUND")) return this.refuse("refused_state", err);
      if (err instanceof PlatformError) throw err;
      // A storage failure is reported as an unavailable audit/inbox store, never as success.
      return this.refuse("refused_audit", new AuditUnavailableError("INBOX_REPLAY_STORE_UNAVAILABLE"));
    }
  }

  private refuse(result: "refused_audit" | "refused_policy" | "refused_state", err: PlatformError): never {
    try {
      this.metrics.increment("vsp_inbox_replays_total", { result });
    } catch {
      // metrics never change the decision
    }
    this.logger.warn("inbox.replay_refused", { reasonCode: err.reasonCode });
    throw err;
  }

  private count(result: "replayed"): void {
    try {
      this.metrics.increment("vsp_inbox_replays_total", { result });
    } catch {
      // metrics never change the decision
    }
  }
}
