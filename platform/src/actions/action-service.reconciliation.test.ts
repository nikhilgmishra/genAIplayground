/**
 * Durable reconciliation records, tenant-scoped reconcile/invalidate, session listing and the
 * staff-initiated retry after a NOT_FOUND reconciliation (spec section 8; ACT-02, ACT-03, OPS-01).
 * Real PostgreSQL (PGlite) with LOCAL FIXTURES (FakeProviderFixture, InTxAuditWriterFixture).
 * All data is SYNTHETIC.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OTHER_TENANT_ID, TENANT_ID } from "../fixtures/synthetic-world.js";
import type { AuthContext } from "../protocol/index.js";
import { AuditUnavailableError, DependencyError, ValidationError } from "../shared/errors.js";
import { newId } from "../shared/ids.js";
import { providerIdempotencyKeyFor, sessionBindingRef } from "./digest.js";
import { AUDIT_FIXTURE_TABLE, fixtureAuditRows } from "./fixtures/audit-writer.fixture.js";
import { FakeProviderFixture } from "./fixtures/fake-provider.fixture.js";
import { APPOINTMENT, allowDecision, confirmationFor, createLedgerHarness, rescheduleInput, syntheticAuthContext, telephonyIntegration } from "./fixtures/world.fixture.js";
import type { LedgerHarness } from "./fixtures/world.fixture.js";
import type { ActionService, CommitDeps } from "./ports.js";

const STAFF = "stf_synthSupervisor01";

let h: LedgerHarness;
beforeEach(async () => {
  h = await createLedgerHarness();
});
afterEach(async () => {
  await h.db.close();
});

const deps = (provider: FakeProviderFixture = h.provider): CommitDeps => ({ reauthorize: async () => allowDecision(h.clock), provider });
const reason = (p: Promise<unknown>) => p.then(() => "RESOLVED", (e: { reasonCode?: string }) => e.reasonCode ?? "NO_REASON_CODE");

async function prepareConfirmed(ctx: AuthContext = syntheticAuthContext(h.clock), input = rescheduleInput()) {
  const action = await h.service.prepare(ctx, input, allowDecision(h.clock));
  h.clock.advanceSeconds(2);
  const confirmed = await h.service.confirm(confirmationFor(action, ctx.sessionRef, h.clock), telephonyIntegration());
  return { ctx, action: confirmed };
}

/** A provider whose commit times out ambiguously WITHOUT applying anything (lookup then finds nothing). */
function silentTimeoutProvider(): FakeProviderFixture {
  const p = new FakeProviderFixture();
  p.seedRecord("scheduling", APPOINTMENT.appointmentId, 1);
  p.commit = async (_a, key) => {
    p.commitKeys.push(key);
    throw new DependencyError("FIXTURE_TIMEOUT_UNKNOWN", "UNKNOWN");
  };
  return p;
}

/** CONFIRMED action whose first commit was ambiguous and whose NOT_FOUND reconciliation is recorded. */
async function notFoundReconciled() {
  const { ctx, action } = await prepareConfirmed();
  const silent = silentTimeoutProvider();
  expect((await h.service.commit(ctx, { actionId: action.actionId, digest: action.digest }, deps(silent))).outcome).toBe("UNKNOWN");
  const rec = await h.service.reconcileWithResult(TENANT_ID, action.actionId, h.provider);
  expect(rec.result).toBe("NOT_FOUND");
  return { ctx, action, rec, silent };
}

async function stateOf(actionId: string): Promise<string> {
  const r = await h.db.tx((tx) => tx.query<{ state: string }>("select state from action_ledger where action_id = $1", [actionId]), { role: "owner" });
  return r.rows[0]?.state ?? "MISSING";
}

async function auditEventsFor(actionId: string): Promise<{ action: string; actorRef: string | null; reasonCode: string | null }[]> {
  const r = await h.db.tx(
    (tx) => tx.query<{ event: { action: string; actorRef: string | null; reasonCode: string | null } }>(`select event from ${AUDIT_FIXTURE_TABLE} where correlation_id = $1 order by seq`, [actionId]),
    { role: "owner" },
  );
  return r.rows.map((x) => ({ action: x.event.action, actorRef: x.event.actorRef, reasonCode: x.event.reasonCode }));
}

describe("durable reconciliation records", () => {
  it("[ACT-03][OPS-01] reconcileWithResult COMMITTED returns the authoritative receipt and a durable record written with the ledger transition", async () => {
    const { ctx, action } = await prepareConfirmed();
    h.provider.injectCommitFault("timeout_after_commit");
    expect((await h.service.commit(ctx, { actionId: action.actionId, digest: action.digest }, deps())).outcome).toBe("UNKNOWN");
    const r = await h.service.reconcileWithResult(TENANT_ID, action.actionId, h.provider);
    expect(r.result).toBe("COMMITTED");
    expect(r.receipt).toMatchObject({ outcome: "COMMITTED", reconciled: true, actionId: action.actionId });
    expect(r.reconciliationId).toMatch(/^rcn_[A-Za-z0-9_-]{16,64}$/);
    const latest = await h.service.latestReconciliation(TENANT_ID, action.actionId);
    expect(latest).toMatchObject({
      reconciliationId: r.reconciliationId,
      seq: 1,
      trigger: "RECONCILE_WITH_RESULT",
      lookupPerformed: true,
      result: "COMMITTED",
      ledgerStateAfter: "COMMITTED",
      receiptId: r.receipt?.receiptId,
      retryConsumed: false,
    });
    expect(h.provider.effectsFor(action.actionId)).toBe(1);
  });

  it("[ACT-03] reconcileWithResult NOT_FOUND / UNKNOWN returns no receipt; every reconciliation (worker, commit path, operator) is recorded in order", async () => {
    const { ctx, action } = await prepareConfirmed();
    h.provider.injectCommitFault("timeout_after_commit");
    await h.service.commit(ctx, { actionId: action.actionId, digest: action.digest }, deps());
    h.provider.injectLookupFault("unknown");
    expect(await h.service.reconcileWithResult(TENANT_ID, action.actionId, h.provider)).toMatchObject({ result: "UNKNOWN", receipt: null });
    h.provider.injectLookupFault("throw");
    expect((await h.service.reconcile(action.actionId, h.provider)).outcome).toBe("UNKNOWN");
    expect((await h.service.commit(ctx, { actionId: action.actionId, digest: action.digest }, deps())).outcome).toBe("COMMITTED");
    const rows = await h.db.tx(
      (tx) => tx.query<{ seq: number; trigger: string; result: string; ledger_state_after: string }>("select seq, trigger, result, ledger_state_after from action_reconciliations where action_id = $1 order by seq", [action.actionId]),
      { role: "owner" },
    );
    expect(rows.rows).toEqual([
      { seq: 1, trigger: "RECONCILE_WITH_RESULT", result: "UNKNOWN", ledger_state_after: "UNKNOWN" },
      { seq: 2, trigger: "RECONCILE", result: "UNKNOWN", ledger_state_after: "UNKNOWN" },
      { seq: 3, trigger: "COMMIT_RETRY", result: "COMMITTED", ledger_state_after: "COMMITTED" },
    ]);
    expect(h.provider.effectsFor(action.actionId)).toBe(1);
  });

  it("[ACT-03] a NOT_FOUND reconciliation records the ledger state it left (CONFIRMED while fresh)", async () => {
    const { action, rec } = await notFoundReconciled();
    expect(rec.receipt).toBeNull();
    expect(await h.service.latestReconciliation(TENANT_ID, action.actionId)).toMatchObject({ result: "NOT_FOUND", ledgerStateAfter: "CONFIRMED", lookupPerformed: true, receiptId: null });
    expect(await stateOf(action.actionId)).toBe("CONFIRMED");
  });

  it("[OPS-01] reconciliation records are append-only; the retry consumption is one-time; RLS isolates tenants", async () => {
    const { action, rec } = await notFoundReconciled();
    await expect(h.db.tx((tx) => tx.query("delete from action_reconciliations where reconciliation_id = $1", [rec.reconciliationId]), { role: "owner" })).rejects.toThrow(
      /ACTION_RECONCILIATION_APPEND_ONLY/,
    );
    await expect(
      h.db.tx((tx) => tx.query("update action_reconciliations set result = 'COMMITTED' where reconciliation_id = $1", [rec.reconciliationId]), { role: "owner" }),
    ).rejects.toThrow();
    const asRuntime = (t: string) => h.db.tx((tx) => tx.query("select 1 from action_reconciliations where action_id = $1", [action.actionId]), { role: "app_runtime", rls: { tenantId: t } });
    expect((await asRuntime(TENANT_ID)).rows).toHaveLength(1);
    expect((await asRuntime(OTHER_TENANT_ID)).rows).toHaveLength(0);
    expect(await h.service.latestReconciliation(OTHER_TENANT_ID, action.actionId)).toBeNull();
  });
});

describe("action.committed outbox payload", () => {
  it("[SPEC-8.outbox][AUTH-05] carries the tenant id (opaque) so consumers set their RLS context without a cross-tenant lookup", async () => {
    const { ctx, action } = await prepareConfirmed();
    await h.service.commit(ctx, { actionId: action.actionId, digest: action.digest }, deps());
    const rows = await h.db.tx(
      (tx) => tx.query<{ tenant_id: string; payload: Record<string, unknown> }>("select tenant_id, payload from outbox_messages where dedupe_key = $1", [`action.committed:${action.actionId}`]),
      { role: "owner" },
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.payload).toMatchObject({ actionId: action.actionId, tenantId: TENANT_ID, kind: "appointment.reschedule", reconciled: false });
    expect(rows.rows[0]?.payload.tenantId).toBe(rows.rows[0]?.tenant_id);
  });
});

describe("tenant-scoped reconcile and invalidatePending (optional tenantId)", () => {
  it("[AUTH-05][ACT-03] reconcile with a tenant id resolves inside that tenant only; old call sites without it keep working", async () => {
    const { ctx, action } = await prepareConfirmed();
    h.provider.injectCommitFault("timeout_after_commit");
    await h.service.commit(ctx, { actionId: action.actionId, digest: action.digest }, deps());
    expect(await reason(h.service.reconcile(action.actionId, h.provider, OTHER_TENANT_ID))).toBe("ACTION_NOT_FOUND");
    expect(h.provider.calls.lookup).toBe(0);
    expect((await h.service.reconcile(action.actionId, h.provider, TENANT_ID)).outcome).toBe("COMMITTED");
    expect((await h.service.reconcile(action.actionId, h.provider)).outcome).toBe("COMMITTED");
    expect(h.provider.effectsFor(action.actionId)).toBe(1);
  });

  it("[AUTH-05][ACT-01] invalidatePending with a tenant id only touches that tenant's pending actions", async () => {
    const ctx = syntheticAuthContext(h.clock);
    const action = await h.service.prepare(ctx, rescheduleInput(), allowDecision(h.clock));
    expect(await h.service.invalidatePending(ctx.sessionRef, "BARGE_IN", OTHER_TENANT_ID)).toBe(0);
    expect(await stateOf(action.actionId)).toBe("PREPARED");
    expect(await h.service.invalidatePending(ctx.sessionRef, "BARGE_IN", TENANT_ID)).toBe(1);
    expect(await stateOf(action.actionId)).toBe("INVALIDATED");
    await expect(h.service.invalidatePending(ctx.sessionRef, "BARGE_IN", "not a tenant")).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("listForSession", () => {
  it("[ACT-04][DATA-01] lists every action bound to the session in any state with state and receipt id, by bearer or binding ref, never echoing the bearer", async () => {
    const ctx = syntheticAuthContext(h.clock);
    const other = syntheticAuthContext(h.clock);
    const { action: committed } = await prepareConfirmed(ctx);
    const receipt = await h.service.commit(ctx, { actionId: committed.actionId, digest: committed.digest }, deps());
    const pending = await h.service.prepare(ctx, rescheduleInput({ target: { system: "scheduling", recordType: "appointment", recordRef: "apt_synthOtherAppointment1", beforeVersion: "v1" } }), allowDecision(h.clock));
    await h.service.prepare(other, rescheduleInput(), allowDecision(h.clock));

    const viaBearer = await h.service.listForSession(TENANT_ID, ctx.sessionRef);
    expect(viaBearer.map((v) => [v.action.actionId, v.state, v.receiptId])).toEqual([
      [committed.actionId, "COMMITTED", receipt.receiptId],
      [pending.actionId, "PREPARED", null],
    ]);
    const viaBinding = await h.service.listForSession(TENANT_ID, sessionBindingRef(ctx.sessionRef));
    expect(viaBinding).toEqual(viaBearer);
    expect(JSON.stringify(viaBearer)).not.toContain(ctx.sessionRef);
    expect(await h.service.listForSession(OTHER_TENANT_ID, ctx.sessionRef)).toEqual([]);
    // Expiry is effective on read before any sweep.
    h.clock.advanceSeconds(400);
    expect((await h.service.listForSession(TENANT_ID, ctx.sessionRef)).find((v) => v.action.actionId === pending.actionId)?.state).toBe("EXPIRED");
    await expect(h.service.listForSession(TENANT_ID, "caller 555 0101")).rejects.toBeInstanceOf(ValidationError);
    await expect(h.service.listForSession("not a tenant", ctx.sessionRef)).rejects.toBeInstanceOf(ValidationError);
  });

  it("[SPEC-8.3] the port exposes the new operations as optional methods implemented by the ledger service", () => {
    const port: ActionService = h.service;
    expect(typeof port.listForSession).toBe("function");
    expect(typeof port.reconcileWithResult).toBe("function");
    expect(typeof port.retryAfterReconcile).toBe("function");
    expect(typeof port.latestReconciliation).toBe("function");
  });
});

describe("retryAfterReconcile (staff retry after NOT_FOUND)", () => {
  it("[ACT-02][ACT-03] commits with the SAME provider idempotency key, exactly one effect, audited with the staff actor; the reconciliation is consumed", async () => {
    const { action, rec, silent } = await notFoundReconciled();
    const receipt = await h.service.retryAfterReconcile(TENANT_ID, action.actionId, { reconciliationId: rec.reconciliationId, reasonCode: "OPERATOR_RETRY", staffRef: STAFF }, h.provider);
    expect(receipt).toMatchObject({ outcome: "COMMITTED", actionId: action.actionId, reconciled: false });
    expect(h.provider.effectsFor(action.actionId)).toBe(1);
    expect([...silent.commitKeys, ...h.provider.commitKeys]).toEqual([providerIdempotencyKeyFor(action.actionId), providerIdempotencyKeyFor(action.actionId)]);
    expect(await stateOf(action.actionId)).toBe("COMMITTED");
    expect(await h.service.latestReconciliation(TENANT_ID, action.actionId)).toMatchObject({ reconciliationId: rec.reconciliationId, retryConsumed: true });
    const events = await auditEventsFor(action.actionId);
    expect(events.filter((e) => e.actorRef === STAFF).map((e) => e.action)).toEqual(["action.retry_after_reconcile.started", "action.commit.succeeded"]);
    expect(events.find((e) => e.action === "action.retry_after_reconcile.started")?.reasonCode).toBe("OPERATOR_RETRY");
    // The follow-up event still goes through the outbox exactly once.
    const outbox = await h.db.tx((tx) => tx.query("select 1 from outbox_messages where dedupe_key = $1", [`action.committed:${action.actionId}`]), { role: "owner" });
    expect(outbox.rows).toHaveLength(1);
    // Single use: the same reconciliation cannot authorize a second retry.
    expect(
      await reason(h.service.retryAfterReconcile(TENANT_ID, action.actionId, { reconciliationId: rec.reconciliationId, reasonCode: "OPERATOR_RETRY", staffRef: STAFF }, h.provider)),
    ).toBe("RECONCILIATION_ALREADY_CONSUMED");
    expect(h.provider.calls.commit).toBe(1);
  });

  it("[ACT-03] never retries after a COMMITTED or UNKNOWN reconciliation", async () => {
    const { ctx, action } = await prepareConfirmed();
    h.provider.injectCommitFault("timeout_after_commit");
    await h.service.commit(ctx, { actionId: action.actionId, digest: action.digest }, deps());
    h.provider.injectLookupFault("unknown");
    const unknown = await h.service.reconcileWithResult(TENANT_ID, action.actionId, h.provider);
    expect(unknown.result).toBe("UNKNOWN");
    expect(await reason(h.service.retryAfterReconcile(TENANT_ID, action.actionId, { reconciliationId: unknown.reconciliationId, reasonCode: "OPERATOR_RETRY", staffRef: STAFF }, h.provider))).toBe(
      "RECONCILIATION_RESULT_NOT_RETRYABLE",
    );
    const committed = await h.service.reconcileWithResult(TENANT_ID, action.actionId, h.provider);
    expect(committed.result).toBe("COMMITTED");
    expect(await reason(h.service.retryAfterReconcile(TENANT_ID, action.actionId, { reconciliationId: committed.reconciliationId, reasonCode: "OPERATOR_RETRY", staffRef: STAFF }, h.provider))).toBe(
      "RECONCILIATION_RESULT_NOT_RETRYABLE",
    );
    expect(h.provider.calls.commit).toBe(1);
    expect(h.provider.effectsFor(action.actionId)).toBe(1);
    const denied = (await auditEventsFor(action.actionId)).filter((e) => e.action === "action.retry_after_reconcile.rejected");
    expect(denied.map((d) => [d.reasonCode, d.actorRef])).toEqual([
      ["RECONCILIATION_RESULT_NOT_RETRYABLE", STAFF],
      ["RECONCILIATION_RESULT_NOT_RETRYABLE", STAFF],
    ]);
  });

  it("[ACT-03] only the LATEST reconciliation can authorize a retry", async () => {
    const { ctx, action, rec } = await notFoundReconciled();
    // The caller retries again and that attempt is also ambiguous: a newer reconciliation now exists.
    expect((await h.service.commit(ctx, { actionId: action.actionId, digest: action.digest }, deps(silentTimeoutProvider()))).outcome).toBe("UNKNOWN");
    const newer = await h.service.reconcileWithResult(TENANT_ID, action.actionId, h.provider);
    expect(newer.result).toBe("NOT_FOUND");
    expect(await reason(h.service.retryAfterReconcile(TENANT_ID, action.actionId, { reconciliationId: rec.reconciliationId, reasonCode: "OPERATOR_RETRY", staffRef: STAFF }, h.provider))).toBe(
      "RECONCILIATION_NOT_LATEST",
    );
    expect(await reason(h.service.retryAfterReconcile(TENANT_ID, action.actionId, { reconciliationId: newId("rcn"), reasonCode: "OPERATOR_RETRY", staffRef: STAFF }, h.provider))).toBe(
      "RECONCILIATION_NOT_LATEST",
    );
    expect(h.provider.calls.commit).toBe(0);
    expect((await h.service.retryAfterReconcile(TENANT_ID, action.actionId, { reconciliationId: newer.reconciliationId, reasonCode: "OPERATOR_RETRY", staffRef: STAFF }, h.provider)).outcome).toBe(
      "COMMITTED",
    );
    expect(h.provider.effectsFor(action.actionId)).toBe(1);
  });

  it("[ACT-01][ACT-03] refused when the action expired, the confirmation went stale before reconciliation, or the action changed since", async () => {
    // (a) expired after the reconciliation
    const a = await notFoundReconciled();
    h.clock.advanceSeconds(400);
    expect(await reason(h.service.retryAfterReconcile(TENANT_ID, a.action.actionId, { reconciliationId: a.rec.reconciliationId, reasonCode: "OPERATOR_RETRY", staffRef: STAFF }, h.provider))).toBe(
      "PREPARATION_EXPIRED",
    );
    expect(await stateOf(a.action.actionId)).toBe("EXPIRED");

    // (b) NOT_FOUND after the caller's confirmation went stale: the reconciliation expired the action
    const { ctx, action } = await prepareConfirmed();
    await h.service.commit(ctx, { actionId: action.actionId, digest: action.digest }, deps(silentTimeoutProvider()));
    h.clock.advanceSeconds(200);
    const stale = await h.service.reconcileWithResult(TENANT_ID, action.actionId, h.provider);
    expect(stale.result).toBe("NOT_FOUND");
    expect(await stateOf(action.actionId)).toBe("EXPIRED");
    expect(await reason(h.service.retryAfterReconcile(TENANT_ID, action.actionId, { reconciliationId: stale.reconciliationId, reasonCode: "OPERATOR_RETRY", staffRef: STAFF }, h.provider))).toBe(
      "ACTION_NOT_COMMITTABLE",
    );

    // (c) the session's pending actions were invalidated (barge-in / identity change) after the reconciliation
    const c = await notFoundReconciled();
    expect(await h.service.invalidatePending(c.ctx.sessionRef, "SESSION_IDENTITY_CHANGED", TENANT_ID)).toBe(1);
    expect(await reason(h.service.retryAfterReconcile(TENANT_ID, c.action.actionId, { reconciliationId: c.rec.reconciliationId, reasonCode: "OPERATOR_RETRY", staffRef: STAFF }, h.provider))).toBe(
      "ACTION_CHANGED_SINCE_RECONCILIATION",
    );
    expect(h.provider.calls.commit).toBe(0);
    expect(h.provider.effects).toHaveLength(0);
  });

  it("[AUTH-05][SPEC-8.3] strict input; another tenant cannot retry; audit outage blocks before any provider call and leaves the reconciliation unconsumed", async () => {
    const { action, rec } = await notFoundReconciled();
    const good = { reconciliationId: rec.reconciliationId, reasonCode: "OPERATOR_RETRY", staffRef: STAFF };
    await expect(h.service.retryAfterReconcile(TENANT_ID, action.actionId, { ...good, staffRef: "Dr Synthetic" }, h.provider)).rejects.toBeInstanceOf(ValidationError);
    await expect(h.service.retryAfterReconcile(TENANT_ID, action.actionId, { ...good, reasonCode: "retry please" }, h.provider)).rejects.toBeInstanceOf(ValidationError);
    await expect(h.service.retryAfterReconcile(TENANT_ID, action.actionId, { ...good, reconciliationId: "rec_1" }, h.provider)).rejects.toBeInstanceOf(ValidationError);
    expect(await reason(h.service.retryAfterReconcile(OTHER_TENANT_ID, action.actionId, good, h.provider))).toBe("ACTION_NOT_FOUND");
    h.health.forceUnhealthy = true;
    try {
      await expect(h.service.retryAfterReconcile(TENANT_ID, action.actionId, good, h.provider)).rejects.toBeInstanceOf(AuditUnavailableError);
    } finally {
      h.health.forceUnhealthy = false;
    }
    expect(h.provider.calls.commit).toBe(0);
    expect(await h.service.latestReconciliation(TENANT_ID, action.actionId)).toMatchObject({ retryConsumed: false });
    expect((await h.service.retryAfterReconcile(TENANT_ID, action.actionId, good, h.provider)).outcome).toBe("COMMITTED");
  });

  it("[ACT-02][ACT-03] an ambiguous retry is UNKNOWN again (never success) and the next reconciliation finds the single effect", async () => {
    const { action, rec } = await notFoundReconciled();
    h.provider.injectCommitFault("timeout_after_commit");
    const r = await h.service.retryAfterReconcile(TENANT_ID, action.actionId, { reconciliationId: rec.reconciliationId, reasonCode: "OPERATOR_RETRY", staffRef: STAFF }, h.provider);
    expect(r.outcome).toBe("UNKNOWN");
    expect(await stateOf(action.actionId)).toBe("UNKNOWN");
    const after = await h.service.reconcileWithResult(TENANT_ID, action.actionId, h.provider);
    expect(after.result).toBe("COMMITTED");
    expect(h.provider.effectsFor(action.actionId)).toBe(1);
    expect(h.provider.redundantCommitCalls).toBe(0);
    const events = await fixtureAuditRows(h.db, action.actionId);
    expect(events.map((e) => e.action)).toContain("action.commit.unknown");
  });

  it("[ACT-02] provider-side dedup disabled: the ledger alone prevents a duplicate effect across caller retry, reconcile and staff retry", async () => {
    await h.db.close();
    h = await createLedgerHarness({}, { providerDedupByKey: false });
    const { ctx, action, rec } = await notFoundReconciled();
    expect((await h.service.retryAfterReconcile(TENANT_ID, action.actionId, { reconciliationId: rec.reconciliationId, reasonCode: "OPERATOR_RETRY", staffRef: STAFF }, h.provider)).outcome).toBe("COMMITTED");
    // A late caller retry and further reconciliations return the stored receipt with no provider commit.
    expect((await h.service.commit(ctx, { actionId: action.actionId, digest: action.digest }, deps())).outcome).toBe("COMMITTED");
    expect((await h.service.reconcileWithResult(TENANT_ID, action.actionId, h.provider)).result).toBe("COMMITTED");
    expect(h.provider.calls.commit).toBe(1);
    expect(h.provider.effectsFor(action.actionId)).toBe(1);
  });
});
