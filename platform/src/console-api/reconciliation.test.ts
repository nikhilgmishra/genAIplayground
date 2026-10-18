import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CALLS, STAFF, TENANT_ID } from "../fixtures/synthetic-world.js";
import { createConsoleHarness, seedCallEvents, seedDeadLetter, seedPendingAction, seedUnknownAction } from "./fixtures/harness.fixture.js";
import type { ConsoleHarness } from "./fixtures/harness.fixture.js";

let h: ConsoleHarness;
let supervisor: string;
beforeAll(async () => {
  h = await createConsoleHarness();
  supervisor = await h.token("supervisor");
});
afterAll(async () => {
  await h.close();
});

const errorOf = (body: string): { reasonCode: string; retryable: boolean } => (JSON.parse(body) as { error: { reasonCode: string; retryable: boolean } }).error;
interface ReconcileBody {
  actionId: string;
  result: { reconciliationId: string; result: string; receiptId: string | null };
  state: string;
  retryEligible: boolean;
  auditEventId: string;
}

describe("reconciliation queue and retry gating (ACT-03, spec section 13)", () => {
  it("[ACT-03] the queue lists UNKNOWN actions and dead letters; retry is refused until a reconcile in this console flow returned NOT_FOUND", async () => {
    const action = await seedUnknownAction(h, { appointmentIndex: 0 });
    const deadId = await seedDeadLetter(h);
    const list = JSON.parse((await h.call("reconciliation.list", { token: supervisor })).body) as { actions: { actionId: string; state: string; retryEligible: boolean; lastReconcile: unknown }[]; deadLetters: { messageId: string; topic: string }[] };
    expect(list.actions).toEqual([expect.objectContaining({ actionId: action.actionId, state: "UNKNOWN", retryEligible: false, lastReconcile: null })]);
    expect(list.deadLetters).toEqual([expect.objectContaining({ messageId: deadId, topic: "notification.send" })]);

    const early = await h.call("reconciliation.retry", { token: supervisor, params: { actionId: action.actionId }, body: { reconciliationId: "rcn_synthReconcileGuess01", reason: "RECONCILED_NOT_FOUND_RETRY" } });
    expect(early.statusCode).toBe(409);
    expect(errorOf(early.body).reasonCode).toBe("RECONCILE_REQUIRED");

    // An inconclusive lookup keeps the action in doubt: still no retry.
    h.provider.injectLookupFault("unknown");
    const inconclusive = await h.call("reconciliation.reconcile", { token: supervisor, params: { actionId: action.actionId }, body: {} });
    expect(inconclusive.statusCode).toBe(200);
    const inc = JSON.parse(inconclusive.body) as ReconcileBody;
    expect(inc).toMatchObject({ result: { result: "UNKNOWN", receiptId: null }, state: "UNKNOWN", retryEligible: false });
    const afterUnknown = await h.call("reconciliation.retry", { token: supervisor, params: { actionId: action.actionId }, body: { reconciliationId: inc.result.reconciliationId, reason: "RECONCILED_NOT_FOUND_RETRY" } });
    expect(errorOf(afterUnknown.body).reasonCode).toBe("RECONCILE_REQUIRED");

    // The provider has no record for the idempotency key: NOT_FOUND, back to CONFIRMED while the confirmation is fresh.
    const notFound = JSON.parse((await h.call("reconciliation.reconcile", { token: supervisor, params: { actionId: action.actionId }, body: {} })).body) as ReconcileBody;
    expect(notFound).toMatchObject({ result: { result: "NOT_FOUND" }, state: "CONFIRMED", retryEligible: true });
    expect(h.provider.effectsFor(action.actionId)).toBe(0);

    // The console reconciliation record and its audit event commit together.
    const rec = await h.db.query<{ audit_event_id: string; result: string; performed_by: string }>("select audit_event_id, result, performed_by from console_reconciliations where reconciliation_id = $1", [notFound.result.reconciliationId]);
    expect(rec.rows[0]).toMatchObject({ result: "NOT_FOUND", performed_by: STAFF.supervisor.staffId, audit_event_id: notFound.auditEventId });
    const ev = await h.db.query<{ action: string; outcome: string; source: string }>("select action, outcome, event->>'sourceComponent' as source from audit_outbox where event_id = $1", [notFound.auditEventId]);
    expect(ev.rows[0]).toEqual({ action: "console.reconciliation.reconcile", outcome: "RECONCILED", source: "console" });

    // A stale (superseded) reconciliation id is refused.
    const stale = await h.call("reconciliation.retry", { token: supervisor, params: { actionId: action.actionId }, body: { reconciliationId: inc.result.reconciliationId, reason: "RECONCILED_NOT_FOUND_RETRY" } });
    expect(errorOf(stale.body).reasonCode).toBe("RECONCILE_REQUIRED");
    const badReason = await h.call("reconciliation.retry", { token: supervisor, params: { actionId: action.actionId }, body: { reconciliationId: notFound.result.reconciliationId, reason: "ROOT_CAUSE_FIXED" } });
    expect(errorOf(badReason.body).reasonCode).toBe("REASON_NOT_ALLOWED");

    // Every gate passes, but the ledger has no staff-initiated retry entry point yet: refused, nothing consumed, nothing committed.
    for (let i = 0; i < 2; i++) {
      const gated = await h.call("reconciliation.retry", { token: supervisor, params: { actionId: action.actionId }, body: { reconciliationId: notFound.result.reconciliationId, reason: "RECONCILED_NOT_FOUND_RETRY" } });
      expect(gated.statusCode).toBe(503);
      expect(errorOf(gated.body)).toMatchObject({ reasonCode: "RETRY_PATH_UNAVAILABLE", retryable: false });
    }
    const consumed = await h.db.query<{ retry_consumed_at: unknown }>("select retry_consumed_at from console_reconciliations where reconciliation_id = $1", [notFound.result.reconciliationId]);
    expect(consumed.rows[0]?.retry_consumed_at).toBeNull();
    expect(h.provider.calls.commit).toBe(0);

    // A NOT_FOUND reconciliation goes stale: after the window a new reconcile is required.
    h.clock.advanceSeconds(11 * 60);
    const expired = await h.call("reconciliation.retry", { token: supervisor, params: { actionId: action.actionId }, body: { reconciliationId: notFound.result.reconciliationId, reason: "RECONCILED_NOT_FOUND_RETRY" } });
    expect(errorOf(expired.body).reasonCode).toBe("RECONCILE_REQUIRED");
  });

  it("[ACT-03] a reconcile that finds the commit records COMMITTED with the receipt; a retry is never eligible afterwards", async () => {
    const action = await seedUnknownAction(h, { applied: true, appointmentIndex: 1 });
    expect(h.provider.effectsFor(action.actionId)).toBe(1);
    const r = JSON.parse((await h.call("reconciliation.reconcile", { token: supervisor, params: { actionId: action.actionId }, body: {} })).body) as ReconcileBody;
    expect(r).toMatchObject({ result: { result: "COMMITTED" }, state: "COMMITTED", retryEligible: false });
    expect(r.result.receiptId).toMatch(/^rcp_/);
    const retry = await h.call("reconciliation.retry", { token: supervisor, params: { actionId: action.actionId }, body: { reconciliationId: r.result.reconciliationId, reason: "RECONCILED_NOT_FOUND_RETRY" } });
    expect(errorOf(retry.body).reasonCode).toBe("RECONCILE_REQUIRED");
    expect(h.provider.effectsFor(action.actionId)).toBe(1);
    const again = await h.call("reconciliation.reconcile", { token: supervisor, params: { actionId: action.actionId }, body: {} });
    expect(again.statusCode).toBe(409);
    expect(errorOf(again.body).reasonCode).toBe("ACTION_NOT_RECONCILABLE");
  });

  it("[ACT-02] dead letters are requeued with an allowlisted reason, audited, and only for the staff member's tenant", async () => {
    const deadId = await seedDeadLetter(h);
    const free = await h.call("outbox.requeue", { token: supervisor, params: { messageId: deadId }, body: { reason: "fixed it manually" } });
    expect(errorOf(free.body).reasonCode).toBe("REASON_NOT_ALLOWED");
    const r = await h.call("outbox.requeue", { token: supervisor, params: { messageId: deadId }, body: { reason: "ROOT_CAUSE_FIXED" } });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body) as { requeued: boolean; auditEventId: string };
    expect(body.requeued).toBe(true);
    const status = await h.db.query<{ status: string }>("select status from outbox_messages where message_id = $1", [deadId]);
    expect(status.rows[0]?.status).toBe("PENDING");
    const ev = await h.db.query<{ action: string; actor: string }>("select action, event->>'actorRef' as actor from audit_outbox where event_id = $1", [body.auditEventId]);
    expect(ev.rows[0]).toEqual({ action: "outbox.requeue", actor: STAFF.supervisor.staffId });
    const missing = await h.call("outbox.requeue", { token: supervisor, params: { messageId: "msg_synthOtherTenantMsg01" }, body: { reason: "ROOT_CAUSE_FIXED" } });
    expect(missing.statusCode).toBe(404);
  });
});

describe("pending actions: cancel uncommitted work only (spec section 13)", () => {
  it("[SPEC-13.console] the pending queue is content-free and cancel works only for PREPARED/CONFIRMED actions, with an audit event in the ledger transaction", async () => {
    await seedCallEvents(h, CALLS.primary.callId);
    const prepared = await seedPendingAction(h, { callId: CALLS.primary.callId, appointmentIndex: 2 });
    const list = JSON.parse((await h.call("actions.pending", { token: supervisor })).body) as { actions: Record<string, unknown>[] };
    const view = list.actions.find((a) => a.actionId === prepared.action.actionId);
    expect(view).toMatchObject({ state: "PREPARED", cancellable: true, callId: CALLS.primary.callId, digestPrefix: prepared.action.digest.slice(0, 12), target: { system: "scheduling", recordType: "appointment" } });
    expect(Object.keys(view ?? {}).sort()).toEqual(["actionId", "callId", "cancellable", "digestPrefix", "expiresAt", "kind", "notCancellableReason", "preparedAt", "requiresStepUp", "state", "target"]);
    expect(JSON.stringify(list)).not.toContain(prepared.sessionRef);

    const wrongState = await h.call("actions.cancel", { token: supervisor, params: { actionId: prepared.action.actionId }, body: { reason: "CALLER_CHANGED_REQUEST", expectedState: "CONFIRMED" } });
    expect(errorOf(wrongState.body).reasonCode).toBe("STATE_CONFLICT");
    const freeText = await h.call("actions.cancel", { token: supervisor, params: { actionId: prepared.action.actionId }, body: { reason: "caller asked", expectedState: "PREPARED" } });
    expect(errorOf(freeText.body).reasonCode).toBe("REASON_NOT_ALLOWED");

    const ok = await h.call("actions.cancel", { token: supervisor, params: { actionId: prepared.action.actionId }, body: { reason: "CALLER_CHANGED_REQUEST", expectedState: "PREPARED" } });
    expect(ok.statusCode).toBe(200);
    const body = JSON.parse(ok.body) as { state: string; auditEventId: string };
    expect(body.state).toBe("CANCELLED");
    expect((await h.ledger.get(TENANT_ID, prepared.action.actionId))?.state).toBe("CANCELLED");
    const ev = await h.db.query<{ action: string; actor: string; reason: string }>("select action, event->>'actorRef' as actor, event->>'reasonCode' as reason from audit_outbox where event_id = $1", [body.auditEventId]);
    expect(ev.rows[0]).toEqual({ action: "action.cancel", actor: STAFF.supervisor.staffId, reason: "CALLER_CHANGED_REQUEST" });

    const twice = await h.call("actions.cancel", { token: supervisor, params: { actionId: prepared.action.actionId }, body: { reason: "CALLER_CHANGED_REQUEST", expectedState: "PREPARED" } });
    expect(twice.statusCode).toBe(409);
    expect(errorOf(twice.body).reasonCode).toBe("ACTION_NOT_CANCELLABLE");
  });

  it("[ACT-03] work whose commit started (UNKNOWN) is never cancellable from the console", async () => {
    const unknown = await seedUnknownAction(h, { appointmentIndex: 2 });
    expect((await h.ledger.get(TENANT_ID, unknown.actionId))?.state).toBe("UNKNOWN");
    const r = await h.call("actions.cancel", { token: supervisor, params: { actionId: unknown.actionId }, body: { reason: "INCIDENT_CONTAINMENT", expectedState: "CONFIRMED" } });
    expect(r.statusCode).toBe(409);
    expect(errorOf(r.body).reasonCode).toBe("ACTION_NOT_CANCELLABLE");
  });

  it("[SPEC-13.console] a support agent may cancel only on a call assigned to them (no ownership source => supervisors only)", async () => {
    const owned = await createConsoleHarness({ callOwnership: { kind: "local_fixture", ownerOf: async (_t, callId) => (callId === CALLS.primary.callId ? STAFF.agent.staffId : null) } });
    try {
      const mine = await seedPendingAction(owned, { callId: CALLS.primary.callId, appointmentIndex: 0 });
      const theirs = await seedPendingAction(owned, { callId: CALLS.concurrent.callId, appointmentIndex: 1 });
      const agent = await owned.token("agent");
      const denied = await owned.call("actions.cancel", { token: agent, params: { actionId: theirs.action.actionId }, body: { reason: "DUPLICATE_REQUEST", expectedState: "PREPARED" } });
      expect(denied.statusCode).toBe(403);
      expect(errorOf(denied.body).reasonCode).toBe("STAFF_ROLE_NOT_PERMITTED");
      const allowed = await owned.call("actions.cancel", { token: agent, params: { actionId: mine.action.actionId }, body: { reason: "DUPLICATE_REQUEST", expectedState: "PREPARED" } });
      expect(allowed.statusCode).toBe(200);
    } finally {
      await owned.close();
    }
  });
});
