/**
 * Durable invalidation of IN-DOUBT actions (ACT-F1) and re-authorization of the staff retry after a
 * NOT_FOUND reconciliation (ACT-F3). Spec section 8: "An interruption, changed request, ambiguous
 * confirmation, identity change or expired preparation invalidates the pending action" and "Commit
 * rechecks authorization, action freshness, current state and confirmation"; section 10: a safety
 * concern revokes pending nonessential mutations. Real PostgreSQL (PGlite) with LOCAL FIXTURES
 * (FakeProviderFixture, InTxAuditWriterFixture). All data is SYNTHETIC.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SLOTS, TENANT_ID } from "../fixtures/synthetic-world.js";
import type { AuthContext } from "../protocol/index.js";
import { AccessDeniedError, DependencyError, SessionInvalidError } from "../shared/errors.js";
import { addMs, iso } from "../shared/clock.js";
import { AUDIT_FIXTURE_TABLE } from "./fixtures/audit-writer.fixture.js";
import { FakeProviderFixture } from "./fixtures/fake-provider.fixture.js";
import { allowDecision, confirmationFor, createLedgerHarness, rescheduleInput, syntheticAuthContext, telephonyIntegration } from "./fixtures/world.fixture.js";
import type { LedgerHarness } from "./fixtures/world.fixture.js";
import type { CommitDeps } from "./ports.js";

const STAFF = "stf_synthSupervisor01";

let h: LedgerHarness;
beforeEach(async () => {
  h = await createLedgerHarness();
  h.provider.operatorRetryAuthority = async () => allowDecision(h.clock);
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

/**
 * LOCAL FIXTURE provider (shares h.provider's records): the FIRST commit times out ambiguously before the
 * request reaches the system of record (nothing applied; lookup finds nothing); later commits are real.
 */
function firstCommitLost(): FakeProviderFixture {
  const real = h.provider;
  let first = true;
  const p = Object.create(real) as FakeProviderFixture;
  p.commit = async (a, k) => {
    if (first) {
      first = false;
      throw new DependencyError("FIXTURE_TIMEOUT_UNKNOWN", "UNKNOWN");
    }
    return real.commit(a, k);
  };
  return p;
}

async function row(actionId: string): Promise<{ state: string; state_reason: string | null; invalidation_reason: string | null }> {
  const r = await h.db.tx(
    (tx) => tx.query<{ state: string; state_reason: string | null; invalidation_reason: string | null }>("select state, state_reason, invalidation_reason from action_ledger where action_id = $1", [actionId]),
    { role: "owner" },
  );
  const out = r.rows[0];
  if (!out) throw new Error("ROW_MISSING");
  return out;
}

async function auditActions(actionId: string): Promise<string[]> {
  const r = await h.db.tx((tx) => tx.query<{ event: { action: string } }>(`select event from ${AUDIT_FIXTURE_TABLE} where correlation_id = $1 order by seq`, [actionId]), { role: "owner" });
  return r.rows.map((x) => x.event.action);
}

describe("[ACT-F1] durable invalidation of in-doubt actions", () => {
  it("[ACT-01][ACT-03][ACT-F1] barge-in after an UNKNOWN commit is recorded durably; the reconcile-first commit finds NOT_FOUND and INVALIDATES; no effect", async () => {
    const { ctx, action } = await prepareConfirmed();
    const flaky = firstCommitLost();
    expect((await h.service.commit(ctx, { actionId: action.actionId, digest: action.digest }, deps(flaky))).outcome).toBe("UNKNOWN");

    h.clock.advanceSeconds(5);
    // The in-doubt action is not transitioned (it must be reconciled first) but the request is durable.
    expect(await h.service.invalidatePending(ctx.sessionRef, "BARGE_IN")).toBe(0);
    expect(await row(action.actionId)).toMatchObject({ state: "UNKNOWN", invalidation_reason: "BARGE_IN" });

    // The untrusted model commits the interrupted action again inside the confirmation window.
    h.clock.advanceSeconds(10);
    expect(await reason(h.service.commit(ctx, { actionId: action.actionId, digest: action.digest }, deps(flaky)))).toBe("ACTION_NOT_COMMITTABLE");
    expect(await row(action.actionId)).toMatchObject({ state: "INVALIDATED", state_reason: "BARGE_IN" });
    expect(h.provider.effectsFor(action.actionId)).toBe(0);
    const actions = await auditActions(action.actionId);
    expect(actions).toContain("action.invalidation_requested");
    const reconciled = actions.lastIndexOf("action.reconciled");
    expect(actions.slice(reconciled, reconciled + 3)).toEqual(["action.reconciled", "action.invalidate", "action.commit.rejected"]);
    // Recorded once: a second barge-in neither rewrites nor duplicates it.
    expect(await h.service.invalidatePending(ctx.sessionRef, "SAFETY_ESCALATION")).toBe(0);
    expect((await row(action.actionId)).state_reason).toBe("BARGE_IN");
  });

  it("[ACT-01][ACT-F1] changed request while the first action is in doubt: B supersedes A durably, A is never committed, B commits once", async () => {
    const ctx = syntheticAuthContext(h.clock);
    const flaky = firstCommitLost();
    const a = await prepareConfirmed(ctx, rescheduleInput({ change: { slotId: SLOTS[0].slotId } }));
    expect((await h.service.commit(ctx, { actionId: a.action.actionId, digest: a.action.digest }, deps(flaky))).outcome).toBe("UNKNOWN");

    h.clock.advanceSeconds(5);
    const b = await prepareConfirmed(ctx, rescheduleInput({ change: { slotId: SLOTS[1]?.slotId ?? "slt_synthSecondSlot00001" } }));
    expect(await row(a.action.actionId)).toMatchObject({ state: "UNKNOWN", invalidation_reason: "SUPERSEDED" });
    // B waits while A is in doubt (one in-doubt commit per record, ACT-03).
    expect(await reason(h.service.commit(ctx, { actionId: b.action.actionId, digest: b.action.digest }, deps(flaky)))).toBe("RECORD_COMMIT_IN_PROGRESS");
    // The model commits the abandoned request A: reconciled NOT_FOUND -> INVALIDATED, nothing sent.
    expect(await reason(h.service.commit(ctx, { actionId: a.action.actionId, digest: a.action.digest }, deps(flaky)))).toBe("ACTION_NOT_COMMITTABLE");
    expect((await row(a.action.actionId)).state).toBe("INVALIDATED");
    // The caller's changed request is the one written to the system of record.
    expect((await h.service.commit(ctx, { actionId: b.action.actionId, digest: b.action.digest }, deps(flaky))).outcome).toBe("COMMITTED");
    expect(h.provider.effectsFor(a.action.actionId)).toBe(0);
    expect(h.provider.effectsFor(b.action.actionId)).toBe(1);
  });

  it("[ACT-03][ACT-F1] an invalidation request never hides an effect that did happen: reconciliation records COMMITTED", async () => {
    const { ctx, action } = await prepareConfirmed();
    h.provider.injectCommitFault("timeout_after_commit");
    expect((await h.service.commit(ctx, { actionId: action.actionId, digest: action.digest }, deps())).outcome).toBe("UNKNOWN");
    expect(await h.service.invalidatePending(ctx.sessionRef, "SAFETY_ESCALATION")).toBe(0);
    const rec = await h.service.reconcileWithResult(TENANT_ID, action.actionId, h.provider);
    expect(rec.result).toBe("COMMITTED");
    expect((await row(action.actionId)).state).toBe("COMMITTED");
    expect(h.provider.effectsFor(action.actionId)).toBe(1);
  });

  it("[ACT-01][ACT-F1][ACT-F3] the worker reconciliation honours the request too: safety escalation while UNKNOWN -> INVALIDATED, the staff retry is refused", async () => {
    const { ctx, action } = await prepareConfirmed();
    expect((await h.service.commit(ctx, { actionId: action.actionId, digest: action.digest }, deps(firstCommitLost()))).outcome).toBe("UNKNOWN");
    expect(await h.service.invalidatePending(ctx.sessionRef, "SAFETY_ESCALATION")).toBe(0);
    h.clock.advanceSeconds(60);
    const rec = await h.service.reconcileWithResult(TENANT_ID, action.actionId, h.provider);
    expect(rec.result).toBe("NOT_FOUND");
    expect(await row(action.actionId)).toMatchObject({ state: "INVALIDATED", state_reason: "SAFETY_ESCALATION" });
    expect(await h.service.latestReconciliation(TENANT_ID, action.actionId)).toMatchObject({ ledgerStateAfter: "INVALIDATED" });
    expect(await reason(h.service.retryAfterReconcile(TENANT_ID, action.actionId, { reconciliationId: rec.reconciliationId, reasonCode: "OPERATOR_RETRY", staffRef: STAFF }, h.provider))).toBe(
      "ACTION_NOT_COMMITTABLE",
    );
    expect(h.provider.calls.commit).toBe(0);
    expect(h.provider.effectsFor(action.actionId)).toBe(0);
  });

  it("[ACT-01][ACT-F1] an interruption while the attempt is IN FLIGHT that then proves NOT_STARTED ends INVALIDATED, not CONFIRMED", async () => {
    const { ctx, action } = await prepareConfirmed();
    let release: () => void = () => undefined;
    h.provider.gate = new Promise<void>((r) => {
      release = r;
    });
    h.provider.injectCommitFault("timeout_before_send");
    const inFlight = h.service.commit(ctx, { actionId: action.actionId, digest: action.digest }, deps());
    // Wait until the provider call is in flight (state COMMITTING), then the caller interrupts.
    for (let i = 0; i < 200 && h.provider.calls.commit === 0; i++) await new Promise((r) => setTimeout(r, 5));
    expect((await row(action.actionId)).state).toBe("COMMITTING");
    expect(await h.service.invalidatePending(ctx.sessionRef, "BARGE_IN")).toBe(0);
    release();
    expect(await reason(inFlight)).toBe("PROVIDER_NOT_STARTED");
    expect(await row(action.actionId)).toMatchObject({ state: "INVALIDATED", state_reason: "BARGE_IN" });
    expect(await reason(h.service.commit(ctx, { actionId: action.actionId, digest: action.digest }, deps()))).toBe("ACTION_NOT_COMMITTABLE");
    expect(h.provider.effectsFor(action.actionId)).toBe(0);
  });

  it("[ACT-01][ACT-F1] database guard: a recorded invalidation request is immutable and its row can never re-enter CONFIRMED", async () => {
    const { ctx, action } = await prepareConfirmed();
    expect((await h.service.commit(ctx, { actionId: action.actionId, digest: action.digest }, deps(firstCommitLost()))).outcome).toBe("UNKNOWN");
    await h.service.invalidatePending(ctx.sessionRef, "CALL_ENDED");
    const asRuntime = (sql: string) =>
      h.db.tx((tx) => tx.query(sql, [action.actionId]), { role: "app_runtime", rls: { tenantId: TENANT_ID } }).then(
        () => "OK",
        (e: Error) => e.message,
      );
    expect(await asRuntime("update action_ledger set invalidation_requested_at = null, invalidation_reason = null, row_version = row_version + 1 where action_id = $1")).toMatch(
      /ACTION_LEDGER_INVALIDATION_IMMUTABLE/,
    );
    expect(await asRuntime("update action_ledger set state = 'CONFIRMED', row_version = row_version + 1 where action_id = $1")).toMatch(/ACTION_LEDGER_INVALIDATION_REQUESTED/);
    // A pending (not in-doubt) row cannot carry a request: it is invalidated directly.
    const other = await h.service.prepare(
      syntheticAuthContext(h.clock),
      rescheduleInput({ target: { system: "scheduling", recordType: "appointment", recordRef: "apt_synthOtherRecord0001", beforeVersion: "v1" } }),
      allowDecision(h.clock),
    );
    expect(
      await h.db
        .tx((tx) => tx.query("update action_ledger set invalidation_requested_at = now(), invalidation_reason = 'BARGE_IN', row_version = row_version + 1 where action_id = $1", [other.actionId]), {
          role: "app_runtime",
          rls: { tenantId: TENANT_ID },
        })
        .then(
          () => "OK",
          (e: Error) => e.message,
        ),
    ).toMatch(/ACTION_LEDGER_INVALIDATION_NOT_IN_DOUBT/);
  });
});

describe("[ACT-F3] staff retry re-authorization", () => {
  /** CONFIRMED action whose first commit was lost and whose NOT_FOUND reconciliation is recorded. */
  async function notFoundReconciled(ctx: AuthContext = syntheticAuthContext(h.clock), input = rescheduleInput()) {
    const { action } = await prepareConfirmed(ctx, input);
    expect((await h.service.commit(ctx, { actionId: action.actionId, digest: action.digest }, deps(firstCommitLost()))).outcome).toBe("UNKNOWN");
    const rec = await h.service.reconcileWithResult(TENANT_ID, action.actionId, h.provider);
    expect(rec.result).toBe("NOT_FOUND");
    expect((await row(action.actionId)).state).toBe("CONFIRMED");
    return { ctx, action, rec, retry: () => h.service.retryAfterReconcile(TENANT_ID, action.actionId, { reconciliationId: rec.reconciliationId, reasonCode: "OPERATOR_RETRY", staffRef: STAFF }, h.provider) };
  }

  it("[ACT-01][ACT-F3] refused once the caller's confirmation is stale (180 s > confirmationFreshSeconds): the action expires, nothing is sent", async () => {
    const { action, retry, rec } = await notFoundReconciled();
    h.clock.advanceSeconds(180);
    expect(await reason(retry())).toBe("CONFIRMATION_STALE");
    expect((await row(action.actionId)).state).toBe("EXPIRED");
    expect(h.provider.calls.commit).toBe(0);
    expect(h.provider.operatorRetryAuthorizations).toBe(0);
    expect(await h.service.latestReconciliation(TENANT_ID, action.actionId)).toMatchObject({ reconciliationId: rec.reconciliationId, retryConsumed: false });
  });

  it("[ACT-01][ACT-F3] a port that cannot re-establish the caller's current authority is refused (REAUTHORIZATION_UNAVAILABLE)", async () => {
    const { action, retry } = await notFoundReconciled();
    h.provider.operatorRetryAuthority = undefined;
    expect(await reason(retry())).toBe("REAUTHORIZATION_UNAVAILABLE");
    const bare: FakeProviderFixture = Object.create(h.provider) as FakeProviderFixture;
    Object.defineProperty(bare, "authorizeOperatorRetry", { value: undefined });
    expect(await reason(h.service.retryAfterReconcile(TENANT_ID, action.actionId, { reconciliationId: (await h.service.latestReconciliation(TENANT_ID, action.actionId))?.reconciliationId ?? "", reasonCode: "OPERATOR_RETRY", staffRef: STAFF }, bare))).toBe("REAUTHORIZATION_UNAVAILABLE");
    expect((await row(action.actionId)).state).toBe("CONFIRMED");
    expect(h.provider.calls.commit).toBe(0);
  });

  it("[ACT-01][SAFE-02][ACT-F3] current policy, kill switches and session state decide: deny, REQUIRE_HUMAN, stale decision and safety escalation all refuse before the provider", async () => {
    const { action, retry } = await notFoundReconciled();
    h.provider.operatorRetryAuthority = async () => allowDecision(h.clock, { allow: false, reasonCodes: ["KILL_SWITCH_WRITES"] });
    expect(await reason(retry())).toBe("POLICY_DENIED");
    h.provider.operatorRetryAuthority = async () => allowDecision(h.clock, { obligations: ["REQUIRE_HUMAN"] });
    expect(await reason(retry())).toBe("HUMAN_REQUIRED");
    h.provider.operatorRetryAuthority = async () => allowDecision(h.clock, { evaluatedAt: iso(addMs(h.clock.now(), -300_000)) });
    expect(await reason(retry())).toBe("POLICY_DECISION_STALE");
    h.provider.operatorRetryAuthority = async () => allowDecision(h.clock, { obligations: ["REQUIRE_CONFIRMATION", "REQUIRE_STEP_UP"] });
    expect(await reason(retry())).toBe("STEP_UP_REQUIRED");
    expect((await row(action.actionId)).state).toBe("CONFIRMED");
    // The caller's authority is gone for good: the confirmed action is invalidated.
    h.provider.operatorRetryAuthority = async () => {
      throw new AccessDeniedError("SAFETY_ESCALATION_ACTIVE");
    };
    expect(await reason(retry())).toBe("SAFETY_ESCALATION_ACTIVE");
    expect(await row(action.actionId)).toMatchObject({ state: "INVALIDATED", state_reason: "SAFETY_ESCALATION_ACTIVE" });
    expect(h.provider.calls.commit).toBe(0);
    expect(h.provider.effectsFor(action.actionId)).toBe(0);
  });

  it("[AUTH-04][ACT-F3] a revoked or ended caller session invalidates the action; an evaluation error is a denial without a transition", async () => {
    const a = await notFoundReconciled();
    h.provider.operatorRetryAuthority = async () => {
      throw new Error("FIXTURE_POLICY_ENGINE_DOWN");
    };
    expect(await reason(a.retry())).toBe("POLICY_EVALUATION_FAILED");
    expect((await row(a.action.actionId)).state).toBe("CONFIRMED");
    h.provider.operatorRetryAuthority = async () => {
      throw new SessionInvalidError("SESSION_REVOKED");
    };
    expect(await reason(a.retry())).toBe("SESSION_REVOKED");
    expect((await row(a.action.actionId)).state).toBe("INVALIDATED");
    expect(h.provider.calls.commit).toBe(0);
  });

  it("[ACT-01][ACT-F3] within the window and with a fresh allow the retry commits once, the decision recorded on the started event", async () => {
    const { action, retry } = await notFoundReconciled();
    h.clock.advanceSeconds(60);
    const receipt = await retry();
    expect(receipt.outcome).toBe("COMMITTED");
    expect(h.provider.operatorRetryAuthorizations).toBe(1);
    expect(h.provider.effectsFor(action.actionId)).toBe(1);
    const r = await h.db.tx(
      (tx) =>
        tx.query<{ event: { action: string; policyDecision: { allow: boolean } | null } }>(`select event from ${AUDIT_FIXTURE_TABLE} where correlation_id = $1 order by seq`, [action.actionId]),
      { role: "owner" },
    );
    expect(r.rows.find((x) => x.event.action === "action.retry_after_reconcile.started")?.event.policyDecision?.allow).toBe(true);
  });
});
