/**
 * Per-call index of prepared actions and their commit receipts (migration 0300,
 * table interaction_actions). Used for handoff packages (receipts, pending
 * actions) and for outcome evidence (RESOLVED needs a COMMITTED receipt of the
 * contract's action kind, ACT-04). Opaque ids and codes only.
 */
import type { Db, Queryable } from "../db/types.js";
import type { ActionKind, CommitReceipt } from "../protocol/index.js";
import type { Clock } from "../shared/clock.js";
import { iso } from "../shared/clock.js";

export interface InteractionActionRecord {
  actionId: string;
  callId: string;
  actionKind: ActionKind;
  contractId: string | null;
  receiptId: string | null;
  receiptOutcome: CommitReceipt["outcome"] | null;
}

interface Row {
  action_id: string;
  call_id: string;
  action_kind: ActionKind;
  contract_id: string | null;
  receipt_id: string | null;
  receipt_outcome: CommitReceipt["outcome"] | null;
}

const toRecord = (r: Row): InteractionActionRecord => ({
  actionId: r.action_id,
  callId: r.call_id,
  actionKind: r.action_kind,
  contractId: r.contract_id,
  receiptId: r.receipt_id,
  receiptOutcome: r.receipt_outcome,
});

export class InteractionIndex {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  async recordPrepared(input: { tenantId: string; callId: string; actionId: string; kind: ActionKind; contractId: string | null }): Promise<void> {
    const now = iso(this.clock.now());
    await this.db.tx(
      (q) =>
        q.query(
          `insert into interaction_actions (action_id, tenant_id, call_id, action_kind, contract_id, created_at, updated_at)
           values ($1, $2, $3, $4, $5, $6, $6) on conflict (action_id) do nothing`,
          [input.actionId, input.tenantId, input.callId, input.kind, input.contractId, now],
        ),
      { role: "app_runtime", rls: { tenantId: input.tenantId } },
    );
  }

  /** Records the receipt outcome; a COMMITTED receipt is final (DB trigger). */
  async recordReceipt(tenantId: string, receipt: Pick<CommitReceipt, "actionId" | "receiptId" | "outcome">, role: "app_runtime" | "app_worker" = "app_runtime", q?: Queryable): Promise<void> {
    const sql = `update interaction_actions set receipt_id = $2, receipt_outcome = $3, updated_at = $4
                  where action_id = $1 and (receipt_outcome is null or receipt_outcome <> 'COMMITTED')`;
    const params = [receipt.actionId, receipt.receiptId, receipt.outcome, iso(this.clock.now())];
    if (q) await q.query(sql, params);
    else await this.db.tx((t) => t.query(sql, params), { role, rls: { tenantId } });
  }

  async forCall(tenantId: string, callId: string): Promise<InteractionActionRecord[]> {
    const r = await this.db.tx(
      (q) =>
        q.query<Row>(
          `select action_id, call_id, action_kind, contract_id, receipt_id, receipt_outcome from interaction_actions
            where call_id = $1 order by created_at, action_id limit 32`,
          [callId],
        ),
      { role: "app_runtime", rls: { tenantId } },
    );
    return r.rows.map(toRecord);
  }

  async get(tenantId: string, actionId: string, q?: Queryable): Promise<InteractionActionRecord | null> {
    const sql = "select action_id, call_id, action_kind, contract_id, receipt_id, receipt_outcome from interaction_actions where action_id = $1";
    const r = q ? await q.query<Row>(sql, [actionId]) : await this.db.tx((t) => t.query<Row>(sql, [actionId]), { role: "app_runtime", rls: { tenantId } });
    return r.rows[0] ? toRecord(r.rows[0]) : null;
  }

  /** Tenant of a recorded action for outbox consumers whose payload carries no tenant (narrow definer lookup). */
  async tenantOf(actionId: string): Promise<string | null> {
    if (!/^act_[A-Za-z0-9_-]{16,64}$/.test(actionId)) return null;
    const r = await this.db.tx((q) => q.query<{ t: string | null }>("select business_action_tenant($1) as t", [actionId]), { role: "app_worker" });
    return r.rows[0]?.t ?? null;
  }
}
