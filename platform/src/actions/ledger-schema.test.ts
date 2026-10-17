/**
 * Database-level controls of the 01xx migrations on real PostgreSQL (PGlite): row-level
 * security, least-privilege grants, the ledger state-machine trigger and the per-record
 * in-doubt unique index. Data is SYNTHETIC.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OTHER_TENANT_ID, TENANT_ID } from "../fixtures/synthetic-world.js";
import type { Queryable } from "../db/types.js";
import { allowDecision, confirmationFor, createLedgerHarness, rescheduleInput, syntheticAuthContext, telephonyIntegration } from "./fixtures/world.fixture.js";
import type { LedgerHarness } from "./fixtures/world.fixture.js";

let h: LedgerHarness;
beforeEach(async () => {
  h = await createLedgerHarness();
});
afterEach(async () => {
  await h.db.close();
});

const asRuntime = <T>(tenantId: string, fn: (tx: Queryable) => Promise<T>) => h.db.tx(fn, { role: "app_runtime", rls: { tenantId } });
const asWorker = <T>(tenantId: string | null, fn: (tx: Queryable) => Promise<T>) =>
  h.db.tx(fn, tenantId ? { role: "app_worker", rls: { tenantId } } : { role: "app_worker" });
const failure = (p: Promise<unknown>) => p.then(() => "OK", (e: Error) => e.message);

async function preparedAction() {
  const ctx = syntheticAuthContext(h.clock);
  const action = await h.service.prepare(ctx, rescheduleInput(), allowDecision(h.clock));
  return { ctx, action };
}

describe("row-level security", () => {
  it("[AUTH-05] ledger rows are invisible and unmodifiable across tenants for runtime and worker roles", async () => {
    const { action } = await preparedAction();
    const own = await asRuntime(TENANT_ID, (tx) => tx.query("select action_id from action_ledger"));
    expect(own.rows).toHaveLength(1);
    const other = await asRuntime(OTHER_TENANT_ID, (tx) => tx.query("select action_id from action_ledger"));
    expect(other.rows).toHaveLength(0);
    const otherWorker = await asWorker(OTHER_TENANT_ID, (tx) => tx.query("select action_id from action_ledger"));
    expect(otherWorker.rows).toHaveLength(0);
    const noTenant = await asRuntime("", (tx) => tx.query("select action_id from action_ledger")).catch(() => ({ rows: [] }));
    expect(noTenant.rows).toHaveLength(0);
    const upd = await asRuntime(OTHER_TENANT_ID, (tx) =>
      tx.query("update action_ledger set state = 'CANCELLED', row_version = row_version + 1 where action_id = $1", [action.actionId]),
    );
    expect(upd.rowCount).toBe(0);
  });

  it("[AUTH-05] a runtime transaction cannot insert a ledger row for another tenant (WITH CHECK)", async () => {
    await preparedAction();
    const msg = await failure(
      asRuntime(OTHER_TENANT_ID, (tx) =>
        tx.query(
          `insert into action_locator (action_id, tenant_id, session_ref_hash, created_at) values ($1, $2, $3, now())`,
          ["act_synthCrossTenantInsert01", TENANT_ID, "a".repeat(64)],
        ),
      ),
    );
    expect(msg).toMatch(/row-level security/);
  });

  it("[AUTH-05] outbox, consumer dedup and tool idempotency rows are tenant isolated", async () => {
    await asRuntime(TENANT_ID, (tx) => h.outbox.enqueue(tx, { topic: "workflow.start", key: "wf:test", payload: { workflowId: "wfl_synthWorkflow000001" }, dedupeKey: "workflow.start:t1" }));
    expect((await asWorker(TENANT_ID, (tx) => tx.query("select 1 from outbox_messages"))).rows).toHaveLength(1);
    expect((await asWorker(OTHER_TENANT_ID, (tx) => tx.query("select 1 from outbox_messages"))).rows).toHaveLength(0);
    for (const t of ["consumer_dedup", "tool_request_idempotency"]) {
      expect((await asRuntime(OTHER_TENANT_ID, (tx) => tx.query(`select 1 from ${t}`))).rows).toHaveLength(0);
    }
  });

  it("[SPEC-8.3] RLS is FORCED on every 01xx table", async () => {
    const r = await h.db.tx(
      (tx) =>
        tx.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
          `select relname, relrowsecurity, relforcerowsecurity from pg_class
           where relname in ('action_ledger', 'action_locator', 'tool_request_idempotency', 'outbox_messages', 'consumer_dedup') order by relname`,
        ),
      { role: "owner" },
    );
    expect(r.rows).toHaveLength(5);
    for (const row of r.rows) {
      expect(row.relrowsecurity).toBe(true);
      expect(row.relforcerowsecurity).toBe(true);
    }
  });
});

describe("least privilege", () => {
  it("[ACT-02] no runtime or worker role can DELETE ledger, outbox or dedupe evidence", async () => {
    const { action } = await preparedAction();
    for (const [role, table] of [
      ["app_runtime", "action_ledger"],
      ["app_worker", "action_ledger"],
      ["app_runtime", "action_locator"],
      ["app_runtime", "outbox_messages"],
      ["app_worker", "outbox_messages"],
      ["app_worker", "consumer_dedup"],
      ["app_runtime", "tool_request_idempotency"],
    ] as const) {
      const msg = await failure(h.db.tx((tx) => tx.query(`delete from ${table} where true`), { role, rls: { tenantId: TENANT_ID } }));
      expect(msg, `${role} delete ${table}`).toMatch(/permission denied/);
    }
    const n = await asRuntime(TENANT_ID, (tx) => tx.query("select 1 from action_ledger where action_id = $1", [action.actionId]));
    expect(n.rows).toHaveLength(1);
  });

  it("[SPEC-8.3] the console and auditor roles have no access to the ledger; the worker cannot insert ledger rows", async () => {
    for (const role of ["app_console", "app_auditor"] as const) {
      expect(await failure(h.db.tx((tx) => tx.query("select 1 from action_ledger"), { role, rls: { tenantId: TENANT_ID } }))).toMatch(/permission denied/);
    }
    expect(await failure(asWorker(TENANT_ID, (tx) => tx.query("insert into action_ledger (action_id) values ('act_synthWorkerInsert001')")))).toMatch(
      /permission denied/,
    );
  });

  it("[SPEC-8.3] the worker may resolve an opaque action id to its tenant via the locator, the runtime may not across tenants", async () => {
    const { action } = await preparedAction();
    const w = await asWorker(null, (tx) => tx.query<{ tenant_id: string }>("select tenant_id from action_locator where action_id = $1", [action.actionId]));
    expect(w.rows[0]?.tenant_id).toBe(TENANT_ID);
    const r = await asRuntime(OTHER_TENANT_ID, (tx) => tx.query("select tenant_id from action_locator where action_id = $1", [action.actionId]));
    expect(r.rows).toHaveLength(0);
  });
});

describe("ledger state-machine guard", () => {
  it("[ACT-01] digest-covered fields are immutable after preparation", async () => {
    const { action } = await preparedAction();
    for (const set of [
      `change = '{"slotId":"slt_synthTamper0000001"}'::jsonb`,
      `digest = '${"0".repeat(64)}'`,
      `expires_at = expires_at + interval '1 hour'`,
      `session_ref_hash = '${"b".repeat(64)}'`,
      `provider_idempotency_key = 'vsp-tampered-key-000000'`,
    ]) {
      const msg = await failure(asRuntime(TENANT_ID, (tx) => tx.query(`update action_ledger set ${set}, row_version = row_version + 1 where action_id = $1`, [action.actionId])));
      expect(msg, set).toContain("ACTION_LEDGER_IMMUTABLE_FIELD");
    }
  });

  it("[ACT-01] illegal transitions are rejected (PREPARED cannot jump to COMMITTING or COMMITTED)", async () => {
    const { action } = await preparedAction();
    expect(
      await failure(
        asRuntime(TENANT_ID, (tx) =>
          tx.query(
            `update action_ledger set state = 'COMMITTING', commit_attempt_id = 'cat_x', committing_since = now(), row_version = row_version + 1 where action_id = $1`,
            [action.actionId],
          ),
        ),
      ),
    ).toMatch(/ACTION_LEDGER_ILLEGAL_TRANSITION|action_ledger_confirmed_has_confirmation/);
    expect(
      await failure(
        asRuntime(TENANT_ID, (tx) => tx.query(`update action_ledger set state = 'COMMITTED', receipt = '{}'::jsonb, row_version = row_version + 1 where action_id = $1`, [action.actionId])),
      ),
    ).toMatch(/ACTION_LEDGER_ILLEGAL_TRANSITION|action_ledger_confirmed_has_confirmation/);
  });

  it("[OPS-01] COMMITTED requires a receipt and is terminal; the row version must advance by exactly one", async () => {
    const { ctx, action } = await preparedAction();
    h.clock.advanceSeconds(1);
    await h.service.confirm(confirmationFor(action, ctx.sessionRef, h.clock), telephonyIntegration());
    expect(await failure(asRuntime(TENANT_ID, (tx) => tx.query("update action_ledger set state = 'INVALIDATED' where action_id = $1", [action.actionId])))).toContain(
      "ACTION_LEDGER_ROW_VERSION",
    );
    await h.service.commit(ctx, { actionId: action.actionId, digest: action.digest }, { reauthorize: async () => allowDecision(h.clock), provider: h.provider });
    expect(
      await failure(asRuntime(TENANT_ID, (tx) => tx.query("update action_ledger set state = 'INVALIDATED', row_version = row_version + 1 where action_id = $1", [action.actionId]))),
    ).toContain("ACTION_LEDGER_TERMINAL_STATE");
    expect(
      await failure(asRuntime(TENANT_ID, (tx) => tx.query("update action_ledger set receipt = null, row_version = row_version + 1 where action_id = $1", [action.actionId]))),
    ).toContain("ACTION_LEDGER_TERMINAL_STATE");
  });

  it("[ACT-02] at most one in-doubt (COMMITTING/UNKNOWN) action per target record is enforced by a unique index", async () => {
    const make = async () => {
      const ctx = syntheticAuthContext(h.clock);
      const a = await h.service.prepare(ctx, rescheduleInput(), allowDecision(h.clock));
      await h.service.confirm(confirmationFor(a, ctx.sessionRef, h.clock), telephonyIntegration());
      return a;
    };
    const a = await make();
    const b = await make();
    const toCommitting = (id: string) =>
      asRuntime(TENANT_ID, (tx) =>
        tx.query(
          `update action_ledger set state = 'COMMITTING', commit_attempt_id = 'cat_synthAttempt000001', committing_since = now(),
                  row_version = row_version + 1 where action_id = $1`,
          [id],
        ),
      );
    await toCommitting(a.actionId);
    expect(await failure(toCommitting(b.actionId))).toMatch(/action_ledger_one_in_doubt_per_record/);
  });

  it("[SPEC-8.3] rows can only be inserted in PREPARED state", async () => {
    const { action } = await preparedAction();
    const msg = await failure(
      h.db.tx(
        async (tx) => {
          const row = (await tx.query<Record<string, unknown>>("select * from action_ledger where action_id = $1", [action.actionId])).rows[0];
          if (!row) throw new Error("missing");
          await tx.query(
            `insert into action_ledger (action_id, tenant_id, session_ref_hash, session_generation, call_id, actor_id, subject_id, kind, target, change, impact,
               digest, state, policy_decision_id, policy_version, requires_step_up, confirmation_template_id, prepared_assurance, prepared_at, expires_at,
               provider_idempotency_key, created_at, updated_at)
             select 'act_synthInsertedCommitted', tenant_id, session_ref_hash, session_generation, call_id, actor_id, subject_id, kind, target, change, impact,
               digest, 'CONFIRMED', policy_decision_id, policy_version, requires_step_up, confirmation_template_id, prepared_assurance, prepared_at, expires_at,
               'vsp-another-key-0000000001', created_at, updated_at from action_ledger where action_id = $1`,
            [action.actionId],
          );
        },
        { role: "app_runtime", rls: { tenantId: TENANT_ID } },
      ),
    );
    expect(msg).toMatch(/ACTION_LEDGER_INVALID_INSERT|action_ledger_confirmed_has_confirmation/);
  });
});
