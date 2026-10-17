/**
 * Action ledger commit-protocol tests against real PostgreSQL (PGlite) with LOCAL FIXTURES:
 * FakeProviderFixture (system of record), InTxAuditWriterFixture (audit), CrashingDbFixture.
 * All data is SYNTHETIC (platform/src/fixtures/synthetic-world.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContext, CommitReceipt, PreparedAction } from "../protocol/index.js";
import { sha256Hex } from "../shared/canonical.js";
import { iso, addMs } from "../shared/clock.js";
import { DependencyError } from "../shared/errors.js";
import { newTurnId } from "../shared/ids.js";
import { OTHER_TENANT_ID, PEOPLE, SLOTS } from "../fixtures/synthetic-world.js";
import { MemoryPublisherFixture } from "../outbox/memory-publisher.fixture.js";
import { PgOutboxDispatcher } from "../outbox/dispatcher.js";
import { PgConsumerDedup } from "../outbox/consumer-dedup.js";
import type { CommitDeps } from "./ports.js";
import { computeActionDigest, isSessionBindingRef, providerIdempotencyKeyFor, sessionBindingRef, verifyActionDigest } from "./digest.js";
import { fixtureAuditRows } from "./fixtures/audit-writer.fixture.js";
import { CrashingDbFixture } from "./fixtures/crashing-db.fixture.js";
import { FakeProviderFixture } from "./fixtures/fake-provider.fixture.js";
import {
  APPOINTMENT,
  allowDecision,
  confirmationFor,
  createLedgerHarness,
  mcpIntegration,
  portalIntegration,
  rescheduleInput,
  syntheticAuthContext,
  telephonyIntegration,
} from "./fixtures/world.fixture.js";
import type { LedgerHarness } from "./fixtures/world.fixture.js";

let h: LedgerHarness;

beforeEach(async () => {
  h = await createLedgerHarness();
});
afterEach(async () => {
  await h.db.close();
});

const deps = (overrides: Partial<CommitDeps> = {}): CommitDeps => ({
  reauthorize: async () => allowDecision(h.clock),
  provider: h.provider,
  ...overrides,
});

async function prepare(ctx: AuthContext = syntheticAuthContext(h.clock), input = rescheduleInput()) {
  const action = await h.service.prepare(ctx, input, allowDecision(h.clock));
  return { ctx, action };
}

async function prepareConfirmed(ctx: AuthContext = syntheticAuthContext(h.clock), input = rescheduleInput()) {
  const { action } = await prepare(ctx, input);
  h.clock.advanceSeconds(2);
  const confirmed = await h.service.confirm(confirmationFor(action, ctx.sessionRef, h.clock), telephonyIntegration());
  return { ctx, action: confirmed };
}

const commitOf = (ctx: AuthContext, action: PreparedAction, d: CommitDeps = deps()) =>
  h.service.commit(ctx, { actionId: action.actionId, digest: action.digest }, d);

async function stateOf(actionId: string): Promise<string> {
  const r = await h.db.tx((tx) => tx.query<{ state: string }>("select state from action_ledger where action_id = $1", [actionId]), { role: "owner" });
  return r.rows[0]?.state ?? "MISSING";
}

async function auditActions(actionId: string): Promise<string[]> {
  return (await fixtureAuditRows(h.db, actionId)).map((r) => r.action);
}

const reason = (p: Promise<unknown>) => p.then(() => "RESOLVED", (e: { reasonCode?: string }) => e.reasonCode ?? "NO_REASON_CODE");

// ---------------------------------------------------------------- prepare

describe("prepare", () => {
  it("[ACT-01] persists PREPARED with a digest over every field except digest/state, bound to the session hash not the bearer", async () => {
    const { ctx, action } = await prepare();
    expect(action.state).toBe("PREPARED");
    expect(action.digest).toBe(computeActionDigest(action));
    expect(verifyActionDigest(action)).toBe(true);
    expect(action.sessionRef).not.toBe(ctx.sessionRef);
    expect(isSessionBindingRef(action.sessionRef)).toBe(true);
    expect(action.sessionRef).toBe(sessionBindingRef(ctx.sessionRef));
    const row = (await h.db.tx((tx) => tx.query<Record<string, unknown>>("select * from action_ledger where action_id = $1", [action.actionId]), { role: "owner" })).rows[0];
    expect(row?.session_ref_hash).toBe(sha256Hex(ctx.sessionRef));
    expect(row?.provider_idempotency_key).toBe(providerIdempotencyKeyFor(action.actionId));
    expect(await auditActions(action.actionId)).toEqual(["action.prepare"]);
    expect(await h.service.get(ctx.tenantId, action.actionId)).toEqual(action);
  });

  it("[DATA-01] the session bearer value never reaches the ledger, locator, audit or outbox", async () => {
    const { ctx, action } = await prepareConfirmed();
    await commitOf(ctx, action);
    const dump = await h.db.tx(
      async (tx) => {
        const parts: string[] = [];
        for (const t of ["action_ledger", "action_locator", "test_fixture_audit_events", "outbox_messages"]) {
          parts.push(JSON.stringify((await tx.query(`select * from ${t}`)).rows));
        }
        return parts.join("\n");
      },
      { role: "owner" },
    );
    expect(dump).not.toContain(ctx.sessionRef);
    expect(dump).toContain(sha256Hex(ctx.sessionRef));
  });

  it("[ACT-01] requires decision.allow and the REQUIRE_CONFIRMATION obligation; REQUIRE_HUMAN and stale decisions fail closed", async () => {
    const ctx = syntheticAuthContext(h.clock);
    const input = rescheduleInput();
    expect(await reason(h.service.prepare(ctx, input, allowDecision(h.clock, { allow: false, reasonCodes: ["DENY_DEFAULT"] })))).toBe("POLICY_DENIED");
    expect(await reason(h.service.prepare(ctx, input, allowDecision(h.clock, { obligations: [] })))).toBe("CONFIRMATION_OBLIGATION_MISSING");
    expect(await reason(h.service.prepare(ctx, input, allowDecision(h.clock, { obligations: ["REQUIRE_CONFIRMATION", "REQUIRE_HUMAN"] })))).toBe("HUMAN_REQUIRED");
    const stale = allowDecision(h.clock, { evaluatedAt: iso(addMs(h.clock.now(), -120_000)) });
    expect(await reason(h.service.prepare(ctx, input, stale))).toBe("POLICY_DECISION_STALE");
    const n = await h.db.tx((tx) => tx.query<{ n: number }>("select count(*)::int as n from action_ledger"), { role: "owner" });
    expect(n.rows[0]?.n).toBe(0);
  });

  it("[ACT-01] REQUIRE_STEP_UP obligation forces requiresStepUp into the digest-covered action", async () => {
    const ctx = syntheticAuthContext(h.clock);
    const action = await h.service.prepare(ctx, rescheduleInput(), allowDecision(h.clock, { obligations: ["REQUIRE_CONFIRMATION", "REQUIRE_STEP_UP"] }));
    expect(action.requiresStepUp).toBe(true);
    expect(action.digest).toBe(computeActionDigest(action));
  });

  it("[SPEC-8.3] strict input: unknown fields, out-of-range ttl and kind/target mismatch are rejected", async () => {
    const ctx = syntheticAuthContext(h.clock);
    const d = allowDecision(h.clock);
    const extra = { ...rescheduleInput(), callerSays: "free text" } as unknown as ReturnType<typeof rescheduleInput>;
    expect(await reason(h.service.prepare(ctx, extra, d))).toBe("INVALID_PREPARE_INPUT");
    expect(await reason(h.service.prepare(ctx, rescheduleInput({ ttlSeconds: 86_400 }), d))).toBe("INVALID_PREPARE_INPUT");
    const mismatch = rescheduleInput({ target: { system: "billing", recordType: "appointment", recordRef: APPOINTMENT.appointmentId, beforeVersion: "v1" } });
    expect(await reason(h.service.prepare(ctx, mismatch, d))).toBe("KIND_TARGET_MISMATCH");
    const freeTextChange = rescheduleInput({ change: { "slot id": "x" } as unknown as Record<string, string> });
    expect(await reason(h.service.prepare(ctx, freeTextChange, d))).toBe("INVALID_PREPARE_INPUT");
  });

  it("[ACT-01] a changed request supersedes the session's earlier pending action on the same record", async () => {
    const ctx = syntheticAuthContext(h.clock);
    const first = await h.service.prepare(ctx, rescheduleInput(), allowDecision(h.clock));
    const second = await h.service.prepare(ctx, rescheduleInput({ change: { slotId: SLOTS[1].slotId } }), allowDecision(h.clock));
    expect(await stateOf(first.actionId)).toBe("INVALIDATED");
    expect(await stateOf(second.actionId)).toBe("PREPARED");
    expect(first.digest).not.toBe(second.digest);
    // The superseded action's digest can no longer be confirmed.
    expect(await reason(h.service.confirm(confirmationFor(first, ctx.sessionRef, h.clock), telephonyIntegration()))).toBe("ACTION_NOT_CONFIRMABLE");
  });
});

// ---------------------------------------------------------------- confirm (ACT-01)

describe("confirm", () => {
  it("[ACT-01] trusted telephony confirmation bound to the digest moves PREPARED -> CONFIRMED and is audited", async () => {
    const { ctx, action } = await prepare();
    h.clock.advanceSeconds(3);
    const confirmed = await h.service.confirm(confirmationFor(action, ctx.sessionRef, h.clock), telephonyIntegration());
    expect(confirmed.state).toBe("CONFIRMED");
    expect(confirmed.digest).toBe(action.digest);
    expect(await auditActions(action.actionId)).toEqual(["action.prepare", "action.confirm"]);
    const stored = await h.db.tx((tx) => tx.query<{ confirmation: Record<string, unknown> }>("select confirmation from action_ledger where action_id = $1", [action.actionId]), {
      role: "owner",
    });
    expect(JSON.stringify(stored.rows[0]?.confirmation)).not.toContain(ctx.sessionRef);
  });

  it("[ACT-01] a confirmation for a different digest is rejected, never confirms, and invalidates the pending action", async () => {
    const { ctx, action } = await prepare();
    const other = sha256Hex("some-other-prepared-action");
    expect(await reason(h.service.confirm(confirmationFor(action, ctx.sessionRef, h.clock, { digest: other }), telephonyIntegration()))).toBe(
      "CONFIRMATION_DIGEST_MISMATCH",
    );
    expect(await stateOf(action.actionId)).toBe("INVALIDATED");
    expect(await auditActions(action.actionId)).toEqual(["action.prepare", "action.invalidate"]);
    expect(await reason(commitOf(ctx, action))).toBe("ACTION_NOT_COMMITTABLE");
    expect(h.provider.calls.commit).toBe(0);
  });

  it("[ACT-01] a confirmation captured before the action was prepared (an earlier turn's yes) is rejected", async () => {
    const { ctx, action } = await prepare();
    const earlier = iso(addMs(new Date(action.preparedAt), -1_000));
    expect(await reason(h.service.confirm(confirmationFor(action, ctx.sessionRef, h.clock, { capturedAt: earlier }), telephonyIntegration()))).toBe(
      "CONFIRMATION_PREDATES_PREPARATION",
    );
    expect(await stateOf(action.actionId)).toBe("INVALIDATED");
  });

  it("[ACT-01] the model-facing mcp_tools channel (and console/worker/webhook) cannot confirm; state is unchanged", async () => {
    const { ctx, action } = await prepare();
    for (const channel of ["mcp_tools", "console", "worker", "webhook"] as const) {
      const integ = { ...mcpIntegration(), channel };
      expect(await reason(h.service.confirm(confirmationFor(action, ctx.sessionRef, h.clock), integ))).toBe("CONFIRMATION_CHANNEL_NOT_TRUSTED");
    }
    expect(await stateOf(action.actionId)).toBe("PREPARED");
    expect((await auditActions(action.actionId)).filter((a) => a === "action.confirm.rejected")).toHaveLength(4);
    expect(await reason(commitOf(ctx, action))).toBe("ACTION_NOT_CONFIRMED");
    expect(h.provider.calls.commit).toBe(0);
  });

  it("[ACT-01] confirmation method must match the trusted channel (portal approval only via portal)", async () => {
    const { ctx, action } = await prepare();
    expect(await reason(h.service.confirm(confirmationFor(action, ctx.sessionRef, h.clock, { method: "dtmf_keypress" }), portalIntegration()))).toBe(
      "CONFIRMATION_METHOD_CHANNEL_MISMATCH",
    );
    expect(await reason(h.service.confirm(confirmationFor(action, ctx.sessionRef, h.clock, { method: "portal_approval" }), telephonyIntegration()))).toBe(
      "CONFIRMATION_METHOD_CHANNEL_MISMATCH",
    );
    const ok = await h.service.confirm(confirmationFor(action, ctx.sessionRef, h.clock, { method: "portal_approval" }), portalIntegration());
    expect(ok.state).toBe("CONFIRMED");
  });

  it("[ACT-01] a session generation change invalidates the pending action (identity change)", async () => {
    const { ctx, action } = await prepare();
    expect(await reason(h.service.confirm(confirmationFor(action, ctx.sessionRef, h.clock, { sessionGeneration: 2 }), telephonyIntegration()))).toBe(
      "SESSION_GENERATION_CHANGED",
    );
    expect(await stateOf(action.actionId)).toBe("INVALIDATED");
  });

  it("[ACT-01] a generation change after confirmation invalidates the action at commit with zero provider calls", async () => {
    const { ctx, action } = await prepareConfirmed();
    const bumped = { ...ctx, sessionGeneration: 2 };
    expect(await reason(commitOf(bumped, action))).toBe("SESSION_GENERATION_CHANGED");
    expect(await stateOf(action.actionId)).toBe("INVALIDATED");
    expect(h.provider.calls.commit + h.provider.calls.currentVersion).toBe(0);
  });

  it("[ACT-01] a confirmation from a different session is rejected without changing state (no session swap)", async () => {
    const { ctx, action } = await prepare();
    const intruder = syntheticAuthContext(h.clock);
    expect(await reason(h.service.confirm(confirmationFor(action, intruder.sessionRef, h.clock), telephonyIntegration()))).toBe("CONFIRMATION_SESSION_MISMATCH");
    // The non-bearer binding ref is not accepted as proof of the session either.
    expect(await reason(h.service.confirm(confirmationFor(action, action.sessionRef, h.clock), telephonyIntegration()))).toBe("CONFIRMATION_SESSION_MISMATCH");
    expect(await stateOf(action.actionId)).toBe("PREPARED");
    const ok = await h.service.confirm(confirmationFor(action, ctx.sessionRef, h.clock), telephonyIntegration());
    expect(ok.state).toBe("CONFIRMED");
  });

  it("[ACT-01] another tenant's telephony integration cannot see or confirm the action", async () => {
    const { ctx, action } = await prepare();
    expect(await reason(h.service.confirm(confirmationFor(action, ctx.sessionRef, h.clock), telephonyIntegration(OTHER_TENANT_ID)))).toBe("ACTION_NOT_FOUND");
    expect(await stateOf(action.actionId)).toBe("PREPARED");
    expect(await h.service.get(OTHER_TENANT_ID, action.actionId)).toBeNull();
  });

  it("[ACT-01] an expired preparation cannot be confirmed and reads report EXPIRED before any sweep", async () => {
    const { ctx, action } = await prepare();
    h.clock.advanceSeconds(301);
    expect((await h.service.get(ctx.tenantId, action.actionId))?.state).toBe("EXPIRED");
    expect(await stateOf(action.actionId)).toBe("PREPARED");
    expect(await reason(h.service.confirm(confirmationFor(action, ctx.sessionRef, h.clock), telephonyIntegration()))).toBe("PREPARATION_EXPIRED");
    expect(await stateOf(action.actionId)).toBe("EXPIRED");
  });

  it("[ACT-01] an expired preparation cannot be committed", async () => {
    const { ctx, action } = await prepare(syntheticAuthContext(h.clock), rescheduleInput({ ttlSeconds: 60 }));
    h.clock.advanceSeconds(2);
    await h.service.confirm(confirmationFor(action, ctx.sessionRef, h.clock), telephonyIntegration());
    h.clock.advanceSeconds(60);
    expect(await reason(commitOf(ctx, action))).toBe("PREPARATION_EXPIRED");
    expect(await stateOf(action.actionId)).toBe("EXPIRED");
    expect(h.provider.calls.commit).toBe(0);
  });

  it("[ACT-01] a confirmation older than the freshness window cannot commit (default 120s)", async () => {
    const { ctx, action } = await prepareConfirmed();
    h.clock.advanceSeconds(121);
    expect(await reason(commitOf(ctx, action))).toBe("CONFIRMATION_STALE");
    expect(await stateOf(action.actionId)).toBe("EXPIRED");
    expect(h.provider.calls.commit).toBe(0);
  });

  it("[ACT-01] interrupted confirmation: invalidatePending (barge-in) invalidates PREPARED and CONFIRMED actions, which then cannot commit", async () => {
    const ctx = syntheticAuthContext(h.clock);
    const { action: confirmed } = await prepareConfirmed(ctx);
    h.provider.seedRecord("scheduling", "apt_synthOtherRecord0001", 1);
    const pending = await h.service.prepare(
      ctx,
      rescheduleInput({ target: { system: "scheduling", recordType: "appointment", recordRef: "apt_synthOtherRecord0001", beforeVersion: "v1" } }),
      allowDecision(h.clock),
    );
    const other = await prepare(syntheticAuthContext(h.clock), rescheduleInput({ target: { system: "scheduling", recordType: "appointment", recordRef: "apt_synthThirdRecord0001", beforeVersion: "v1" } }));
    expect(await h.service.invalidatePending(ctx.sessionRef, "BARGE_IN")).toBe(2);
    expect(await stateOf(confirmed.actionId)).toBe("INVALIDATED");
    expect(await stateOf(pending.actionId)).toBe("INVALIDATED");
    expect(await stateOf(other.action.actionId)).toBe("PREPARED");
    expect(await reason(commitOf(ctx, confirmed))).toBe("ACTION_NOT_COMMITTABLE");
    expect(await reason(h.service.confirm(confirmationFor(pending, ctx.sessionRef, h.clock), telephonyIntegration()))).toBe("ACTION_NOT_CONFIRMABLE");
    expect(h.provider.calls.commit).toBe(0);
    expect(await h.service.invalidatePending(ctx.sessionRef, "BARGE_IN")).toBe(0);
  });

  it("[ACT-01] invalidatePending never touches in-doubt (UNKNOWN) actions: they must be reconciled", async () => {
    const { ctx, action } = await prepareConfirmed();
    h.provider.injectCommitFault("timeout_after_commit");
    const r = await commitOf(ctx, action);
    expect(r.outcome).toBe("UNKNOWN");
    expect(await h.service.invalidatePending(ctx.sessionRef, "SAFETY_ESCALATION")).toBe(0);
    expect(await stateOf(action.actionId)).toBe("UNKNOWN");
  });

  it("[ACT-01] redelivered identical confirmation is idempotent; a different confirmation after CONFIRMED is rejected", async () => {
    const { ctx, action } = await prepare();
    const c = confirmationFor(action, ctx.sessionRef, h.clock);
    await h.service.confirm(c, telephonyIntegration());
    expect((await h.service.confirm(c, telephonyIntegration())).state).toBe("CONFIRMED");
    expect(await reason(h.service.confirm({ ...c, turnId: newTurnId() }, telephonyIntegration()))).toBe("ACTION_ALREADY_CONFIRMED");
    expect(await stateOf(action.actionId)).toBe("CONFIRMED");
  });

  it("[ACT-01] confirmation timestamps in the future beyond clock skew are rejected", async () => {
    const { ctx, action } = await prepare();
    const future = iso(addMs(h.clock.now(), 60_000));
    expect(await reason(h.service.confirm(confirmationFor(action, ctx.sessionRef, h.clock, { capturedAt: future }), telephonyIntegration()))).toBe(
      "CONFIRMATION_IN_FUTURE",
    );
  });
});

// ---------------------------------------------------------------- commit happy path, idempotency (ACT-02)

describe("commit", () => {
  it("[ACT-02] commit records COMMITTED with receipt, audit and outbox event; retry returns the same receipt with exactly one provider effect", async () => {
    const { ctx, action } = await prepareConfirmed();
    const first = await commitOf(ctx, action);
    expect(first.outcome).toBe("COMMITTED");
    expect(first.providerIdempotencyKey).toBe(providerIdempotencyKeyFor(action.actionId));
    expect(first.evidenceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.reconciled).toBe(false);
    const again = await commitOf(ctx, action);
    const third = await commitOf(ctx, action);
    expect(again).toEqual(first);
    expect(third).toEqual(first);
    expect(h.provider.effectsFor(action.actionId)).toBe(1);
    expect(h.provider.calls.commit).toBe(1);
    expect(await auditActions(action.actionId)).toEqual(["action.prepare", "action.confirm", "action.commit.started", "action.commit.succeeded"]);
    const audit = await fixtureAuditRows(h.db, action.actionId);
    expect(audit.find((a) => a.action === "action.commit.succeeded")?.eventId).toBe(first.auditEventId);
    const outbox = await h.db.tx((tx) => tx.query<{ topic: string; dedupe_key: string }>("select topic, dedupe_key from outbox_messages"), { role: "owner" });
    expect(outbox.rows).toEqual([{ topic: "action.committed", dedupe_key: `action.committed:${action.actionId}` }]);
    expect((await h.service.get(ctx.tenantId, action.actionId))?.state).toBe("COMMITTED");
  });

  it("[ACT-02] crash after the provider commit (process dies before tx2) then reconcile -> COMMITTED with exactly one effect", async () => {
    const { ctx, action } = await prepareConfirmed();
    const crashing = new CrashingDbFixture(h.db);
    const doomed = h.makeService(crashing);
    h.provider.onCrash = () => crashing.crash();
    h.provider.injectCommitFault("crash_after_commit");
    const crashedResult = await doomed.commit(ctx, { actionId: action.actionId, digest: action.digest }, deps()).catch((e: unknown) => e);
    expect(crashedResult).toBeInstanceOf(DependencyError);
    expect((crashedResult as DependencyError).outcome).toBe("UNKNOWN");
    expect(h.provider.effectsFor(action.actionId)).toBe(1);
    expect(await stateOf(action.actionId)).toBe("COMMITTING");

    // "Restart": a fresh service instance on the healthy database.
    crashing.restart();
    const restarted = h.makeService();
    expect(await reason(restarted.commit(ctx, { actionId: action.actionId, digest: action.digest }, deps()))).toBe("COMMIT_IN_PROGRESS");
    expect(await restarted.listNeedingReconciliation(ctx.tenantId, 10)).toEqual([]);
    h.clock.advanceSeconds(31);
    expect((await restarted.listNeedingReconciliation(ctx.tenantId, 10)).map((a) => a.actionId)).toEqual([action.actionId]);
    const receipt = await restarted.reconcile(action.actionId, h.provider);
    expect(receipt.outcome).toBe("COMMITTED");
    expect(receipt.reconciled).toBe(true);
    expect(h.provider.effectsFor(action.actionId)).toBe(1);
    expect(h.provider.redundantCommitCalls).toBe(0);
    expect(await auditActions(action.actionId)).toContain("action.reconciled");
    // A later commit retry from the caller returns the reconciled receipt; still one effect.
    expect(await restarted.commit(ctx, { actionId: action.actionId, digest: action.digest }, deps())).toEqual(receipt);
    expect(h.provider.effectsFor(action.actionId)).toBe(1);
  });

  it("[ACT-02] a provider exception after applying the effect is treated as UNKNOWN, then reconciled to COMMITTED with one effect", async () => {
    const { ctx, action } = await prepareConfirmed();
    h.provider.injectCommitFault("crash_after_commit");
    const r = await commitOf(ctx, action);
    expect(r.outcome).toBe("UNKNOWN");
    expect(r.providerReference).toBeNull();
    expect(await stateOf(action.actionId)).toBe("UNKNOWN");
    const again = await commitOf(ctx, action);
    expect(again.outcome).toBe("COMMITTED");
    expect(h.provider.calls.commit).toBe(1);
    expect(h.provider.effectsFor(action.actionId)).toBe(1);
  });

  it("[ACT-02] duplicate outbox delivery of action.committed is processed exactly once by a deduplicating consumer", async () => {
    const { ctx, action } = await prepareConfirmed();
    await commitOf(ctx, action);
    await h.db.exec(`create table test_consumer_effects (action_id text primary key, applied int not null);
                     grant select, insert, update on test_consumer_effects to app_worker;`);
    const publisher = new MemoryPublisherFixture({ duplicateEveryDelivery: true });
    const dedup = new PgConsumerDedup({ db: h.db, clock: h.clock });
    publisher.subscribe(async (message) => {
      const m = message as typeof message & { tenantId: string };
      await dedup.processOnceForTenant(m.tenantId, "support-link-consumer", message.messageId, (tx) =>
        tx.query(
          `insert into test_consumer_effects (action_id, applied) values ($1, 1)
           on conflict (action_id) do update set applied = test_consumer_effects.applied + 1`,
          [String(message.payload.actionId)],
        ),
      );
    });
    const dispatcher = new PgOutboxDispatcher({ db: h.db, publisher, clock: h.clock, tenants: [ctx.tenantId], random: () => 0.5 });
    expect(await dispatcher.runOnce()).toEqual({ dispatched: 1, failed: 0, deadLettered: 0 });
    await publisher.redeliverAll();
    expect(publisher.deliveries.length).toBe(3);
    const applied = await h.db.tx((tx) => tx.query<{ applied: number }>("select applied from test_consumer_effects where action_id = $1", [action.actionId]), {
      role: "owner",
    });
    expect(applied.rows[0]?.applied).toBe(1);
    expect(await dispatcher.runOnce()).toEqual({ dispatched: 0, failed: 0, deadLettered: 0 });
  });

  it("[SPEC-8.3] onCommitted hook runs inside the COMMITTED transaction; a hook failure never yields success and reconcile records COMMITTED", async () => {
    const { ctx, action } = await prepareConfirmed();
    const seen: CommitReceipt[] = [];
    const failing = deps({
      onCommitted: async (_tx, a, receipt) => {
        expect(a.state).toBe("COMMITTED");
        seen.push(receipt);
        throw new Error("hook failed");
      },
    });
    const r = await commitOf(ctx, action, failing);
    expect(r.outcome).toBe("UNKNOWN");
    expect(seen).toHaveLength(1);
    expect(await stateOf(action.actionId)).toBe("UNKNOWN");
    const outbox = await h.db.tx((tx) => tx.query<{ n: number }>("select count(*)::int as n from outbox_messages"), { role: "owner" });
    expect(outbox.rows[0]?.n).toBe(0);
    const ok = await commitOf(ctx, action);
    expect(ok.outcome).toBe("COMMITTED");
    expect(h.provider.effectsFor(action.actionId)).toBe(1);
  });

  it("[SPEC-8.3] a permanent provider failure records FAILED with audit; the action is terminal", async () => {
    const { ctx, action } = await prepareConfirmed();
    h.provider.injectCommitFault("permanent_failure");
    const r = await commitOf(ctx, action);
    expect(r.outcome).toBe("FAILED");
    expect(await stateOf(action.actionId)).toBe("FAILED");
    expect(await auditActions(action.actionId)).toContain("action.commit.failed");
    expect(await reason(commitOf(ctx, action))).toBe("ACTION_NOT_COMMITTABLE");
    expect(h.provider.effectsFor(action.actionId)).toBe(0);
    expect((await h.service.describe(ctx.tenantId, action.actionId))?.stateReason).toBe("FIXTURE_PERMANENT_REJECTION");
  });

  it("[ACT-01] commit re-checks authorization: a deny or a policy error blocks the commit with zero provider calls", async () => {
    const { ctx, action } = await prepareConfirmed();
    expect(await reason(commitOf(ctx, action, deps({ reauthorize: async () => allowDecision(h.clock, { allow: false, reasonCodes: ["KILL_SWITCH_WRITES"] }) })))).toBe(
      "POLICY_DENIED",
    );
    expect(
      await reason(
        commitOf(
          ctx,
          action,
          deps({
            reauthorize: async () => {
              throw new Error("opa unavailable");
            },
          }),
        ),
      ),
    ).toBe("POLICY_EVALUATION_FAILED");
    expect(await reason(commitOf(ctx, action, deps({ reauthorize: async () => ({ allow: true }) as never })))).toBe("POLICY_EVALUATION_FAILED");
    expect(h.provider.calls.commit + h.provider.calls.currentVersion).toBe(0);
    expect(await stateOf(action.actionId)).toBe("CONFIRMED");
    expect((await commitOf(ctx, action)).outcome).toBe("COMMITTED");
  });

  it("[ACT-01] step-up: commit without a digest-bound unexpired step-up is denied; a matching step-up commits", async () => {
    const ctx = syntheticAuthContext(h.clock);
    const { action } = await prepareConfirmed(ctx, rescheduleInput({ requiresStepUp: true }));
    expect(await reason(commitOf(ctx, action))).toBe("STEP_UP_REQUIRED");
    const now = h.clock.now();
    const wrongDigest = { ...ctx, assurance: "A3" as const, stepUp: { actionDigest: sha256Hex("other"), verifiedAt: iso(now), expiresAt: iso(addMs(now, 60_000)) } };
    expect(await reason(commitOf(wrongDigest, action))).toBe("STEP_UP_REQUIRED");
    const expired = { ...ctx, assurance: "A3" as const, stepUp: { actionDigest: action.digest, verifiedAt: iso(now), expiresAt: iso(addMs(now, -1)) } };
    expect(await reason(commitOf(expired, action))).toBe("STEP_UP_REQUIRED");
    expect(h.provider.calls.commit).toBe(0);
    const good = { ...ctx, assurance: "A3" as const, stepUp: { actionDigest: action.digest, verifiedAt: iso(now), expiresAt: iso(addMs(now, 60_000)) } };
    expect((await commitOf(good, action)).outcome).toBe("COMMITTED");
  });

  it("[SPEC-10.1] an active safety escalation blocks the commit and invalidates the pending action", async () => {
    const { ctx, action } = await prepareConfirmed();
    expect(await reason(commitOf({ ...ctx, riskFlags: ["SAFETY_ESCALATION_ACTIVE"] }, action))).toBe("SAFETY_ESCALATION_ACTIVE");
    expect(await stateOf(action.actionId)).toBe("INVALIDATED");
    expect(h.provider.calls.commit).toBe(0);
  });

  it("[SPEC-8.3] a ledger row whose content no longer matches its digest fails closed", async () => {
    const { ctx, action } = await prepareConfirmed();
    await h.db.tx(
      async (tx) => {
        await tx.exec("alter table action_ledger disable trigger action_ledger_guard");
        await tx.query(`update action_ledger set change = '{"slotId":"slt_synthTamperedSlot01"}'::jsonb where action_id = $1`, [action.actionId]);
        await tx.exec("alter table action_ledger enable trigger action_ledger_guard");
      },
      { role: "owner" },
    );
    expect(await reason(commitOf(ctx, action))).toBe("LEDGER_INTEGRITY_VIOLATION");
    expect(h.provider.calls.commit).toBe(0);
  });

  it("[SPEC-8.3] a commit with a digest that is not the prepared action's invalidates it", async () => {
    const { ctx, action } = await prepareConfirmed();
    expect(await reason(h.service.commit(ctx, { actionId: action.actionId, digest: sha256Hex("x") }, deps()))).toBe("DIGEST_MISMATCH");
    expect(await stateOf(action.actionId)).toBe("INVALIDATED");
    expect(h.provider.calls.commit).toBe(0);
  });

  it("[AUTH-02] a different session (even same tenant) cannot commit another session's action", async () => {
    const { action } = await prepareConfirmed();
    const other = syntheticAuthContext(h.clock, { actorId: PEOPLE.blake.actorId, subjectId: PEOPLE.blake.subjectId });
    expect(await reason(commitOf(other, action))).toBe("SESSION_MISMATCH");
    expect(await stateOf(action.actionId)).toBe("CONFIRMED");
    const otherTenant = syntheticAuthContext(h.clock, { tenantId: OTHER_TENANT_ID });
    expect(await reason(commitOf(otherTenant, action))).toBe("ACTION_NOT_FOUND");
    expect(h.provider.calls.commit).toBe(0);
  });
});

// ---------------------------------------------------------------- ambiguous outcomes (ACT-03)

describe("ambiguous outcomes and reconciliation", () => {
  it("[ACT-03] an ambiguous timeout after send yields UNKNOWN (never success) and the action is queued for reconciliation", async () => {
    const { ctx, action } = await prepareConfirmed();
    h.provider.injectCommitFault("timeout_after_commit");
    const r = await commitOf(ctx, action);
    expect(r.outcome).toBe("UNKNOWN");
    expect(r.committedAt).toBeNull();
    expect(r.providerReference).toBeNull();
    expect(await stateOf(action.actionId)).toBe("UNKNOWN");
    expect(await auditActions(action.actionId)).toContain("action.commit.unknown");
    expect((await h.service.listNeedingReconciliation(ctx.tenantId, 10)).map((a) => a.actionId)).toEqual([action.actionId]);
    expect(await h.service.listNeedingReconciliation(OTHER_TENANT_ID, 10)).toEqual([]);
  });

  it("[ACT-03] commit retry on UNKNOWN reconciles first: lookup COMMITTED records the receipt with no second provider commit", async () => {
    const { ctx, action } = await prepareConfirmed();
    h.provider.injectCommitFault("timeout_after_commit");
    await commitOf(ctx, action);
    const r = await commitOf(ctx, action);
    expect(r.outcome).toBe("COMMITTED");
    expect(r.reconciled).toBe(true);
    expect(h.provider.calls.lookup).toBe(1);
    expect(h.provider.calls.commit).toBe(1);
    expect(h.provider.effectsFor(action.actionId)).toBe(1);
    expect(await auditActions(action.actionId)).toEqual([
      "action.prepare",
      "action.confirm",
      "action.commit.started",
      "action.commit.unknown",
      "action.reconciled",
    ]);
  });

  it("[ACT-03] commit retry on UNKNOWN with lookup NOT_FOUND retries with the SAME provider idempotency key", async () => {
    const { ctx, action } = await prepareConfirmed();
    // Ambiguous failure where the provider did not actually apply anything.
    const failingProvider = new FakeProviderFixture();
    failingProvider.seedRecord("scheduling", APPOINTMENT.appointmentId, 1);
    failingProvider.commit = async (a, key) => {
      failingProvider.commitKeys.push(key);
      void a;
      throw new DependencyError("FIXTURE_TIMEOUT_UNKNOWN", "UNKNOWN");
    };
    const r1 = await commitOf(ctx, action, deps({ provider: failingProvider }));
    expect(r1.outcome).toBe("UNKNOWN");
    const r2 = await commitOf(ctx, action, deps({ provider: h.provider }));
    expect(r2.outcome).toBe("COMMITTED");
    expect(h.provider.calls.lookup).toBe(1);
    expect(h.provider.commitKeys).toEqual([failingProvider.commitKeys[0]]);
    expect(h.provider.commitKeys[0]).toBe(providerIdempotencyKeyFor(action.actionId));
    expect(h.provider.effectsFor(action.actionId)).toBe(1);
    expect(await auditActions(action.actionId)).toContain("action.reconciled");
  });

  it("[ACT-03] lookup UNKNOWN keeps the action UNKNOWN and returns UNKNOWN (no blind retry)", async () => {
    const { ctx, action } = await prepareConfirmed();
    h.provider.injectCommitFault("timeout_after_commit");
    await commitOf(ctx, action);
    h.provider.injectLookupFault("unknown", "throw");
    expect((await commitOf(ctx, action)).outcome).toBe("UNKNOWN");
    expect((await h.service.reconcile(action.actionId, h.provider)).outcome).toBe("UNKNOWN");
    expect(h.provider.calls.commit).toBe(1);
    expect(await stateOf(action.actionId)).toBe("UNKNOWN");
    const view = await h.service.describe(ctx.tenantId, action.actionId);
    expect(view?.reconcileAttempts).toBe(2);
    expect((await h.service.reconcile(action.actionId, h.provider)).outcome).toBe("COMMITTED");
    expect(h.provider.effectsFor(action.actionId)).toBe(1);
  });

  it("[ACT-03] reconcile NOT_FOUND after the confirmation went stale expires the action (re-prepare required)", async () => {
    const { ctx, action } = await prepareConfirmed();
    const noop = new FakeProviderFixture();
    noop.seedRecord("scheduling", APPOINTMENT.appointmentId, 1);
    noop.commit = async () => {
      throw new DependencyError("FIXTURE_TIMEOUT_UNKNOWN", "UNKNOWN");
    };
    await commitOf(ctx, action, deps({ provider: noop }));
    h.clock.advanceSeconds(200);
    const r = await h.service.reconcile(action.actionId, h.provider);
    expect(r.outcome).toBe("NOT_STARTED");
    expect(r.reconciled).toBe(true);
    expect(await stateOf(action.actionId)).toBe("EXPIRED");
    expect(await reason(commitOf(ctx, action))).toBe("ACTION_NOT_COMMITTABLE");
    expect(h.provider.calls.commit).toBe(0);
  });

  it("[ACT-03] timeout before send (NOT_STARTED) returns the action to CONFIRMED; a bounded retry reuses the same key; one effect", async () => {
    const { ctx, action } = await prepareConfirmed();
    h.provider.injectCommitFault("timeout_before_send");
    const err = await commitOf(ctx, action).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DependencyError);
    expect((err as DependencyError).outcome).toBe("NOT_STARTED");
    expect((err as DependencyError).retryable).toBe(true);
    expect(await stateOf(action.actionId)).toBe("CONFIRMED");
    expect((await commitOf(ctx, action)).outcome).toBe("COMMITTED");
    expect(new Set(h.provider.commitKeys).size).toBe(1);
    expect(h.provider.effectsFor(action.actionId)).toBe(1);
  });

  it("[ACT-03] a non-stale COMMITTING action is not reconciled (COMMIT_IN_PROGRESS); a stale one is", async () => {
    const { ctx, action } = await prepareConfirmed();
    const crashing = new CrashingDbFixture(h.db);
    h.provider.onCrash = () => crashing.crash();
    h.provider.injectCommitFault("crash_after_commit");
    await h.makeService(crashing).commit(ctx, { actionId: action.actionId, digest: action.digest }, deps()).catch(() => undefined);
    crashing.restart();
    expect(await reason(h.service.reconcile(action.actionId, h.provider))).toBe("COMMIT_IN_PROGRESS");
    expect(h.provider.calls.lookup).toBe(0);
    h.clock.advanceSeconds(30);
    expect((await commitOf(ctx, action)).outcome).toBe("COMMITTED");
    expect(h.provider.calls.lookup).toBe(1);
    expect(h.provider.effectsFor(action.actionId)).toBe(1);
  });

  it("[ACT-03] an in-doubt (UNKNOWN) action blocks other commits on the same record until it is reconciled", async () => {
    const ctxA = syntheticAuthContext(h.clock);
    const ctxB = syntheticAuthContext(h.clock, { actorId: PEOPLE.avery.actorId });
    const { action: a } = await prepareConfirmed(ctxA);
    const { action: b } = await prepareConfirmed(ctxB, rescheduleInput({ change: { slotId: SLOTS[2].slotId } }));
    h.provider.injectCommitFault("timeout_after_commit");
    expect((await commitOf(ctxA, a)).outcome).toBe("UNKNOWN");
    expect(await reason(commitOf(ctxB, b))).toBe("RECORD_COMMIT_IN_PROGRESS");
    expect(h.provider.calls.commit).toBe(1);
    expect((await h.service.reconcile(a.actionId, h.provider)).outcome).toBe("COMMITTED");
    expect(await reason(commitOf(ctxB, b))).toBe("STATE_CHANGED");
    expect(h.provider.effects).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- audit fail-closed (OPS-01)

describe("audit evidence", () => {
  it("[OPS-01] audit outage blocks commit before any provider call (zero effects) and leaves the action CONFIRMED", async () => {
    const { ctx, action } = await prepareConfirmed();
    h.audit.outage = true;
    expect(await reason(commitOf(ctx, action))).toBe("AUDIT_FIXTURE_OUTAGE");
    expect(h.provider.calls.commit + h.provider.calls.currentVersion).toBe(0);
    expect(h.provider.effects).toHaveLength(0);
    expect(await stateOf(action.actionId)).toBe("CONFIRMED");
    h.audit.outage = false;
    expect((await commitOf(ctx, action)).outcome).toBe("COMMITTED");
  });

  it("[OPS-01] audit health beyond its bounded-buffer policy blocks commit even while appends still work (zero provider calls)", async () => {
    const { ctx, action } = await prepareConfirmed();
    h.health.forceUnhealthy = true;
    expect(await reason(commitOf(ctx, action))).toBe("AUDIT_FIXTURE_OUTAGE");
    expect(h.provider.calls.commit + h.provider.calls.currentVersion).toBe(0);
    expect(await stateOf(action.actionId)).toBe("CONFIRMED");
    expect(await auditActions(action.actionId)).not.toContain("action.commit.started");
  });

  it("[OPS-01] audit health OK but the in-transaction commit.started append fails: tx1 rolls back and no provider call is made", async () => {
    const { ctx, action } = await prepareConfirmed();
    h.audit.failActions.add("action.commit.started");
    expect(await reason(commitOf(ctx, action))).toBe("AUDIT_FIXTURE_OUTAGE");
    expect(h.provider.calls.commit + h.provider.calls.currentVersion).toBe(0);
    expect(await stateOf(action.actionId)).toBe("CONFIRMED");
  });

  it("[OPS-01] success is never returned without the audit row committed: success-audit failure -> UNKNOWN, recovery reconciles with audit", async () => {
    const { ctx, action } = await prepareConfirmed();
    h.audit.failActions.add("action.commit.succeeded");
    const r = await commitOf(ctx, action);
    expect(r.outcome).toBe("UNKNOWN");
    expect(h.provider.effectsFor(action.actionId)).toBe(1);
    const rows = await h.db.tx((tx) => tx.query<{ state: string; receipt: unknown }>("select state, receipt from action_ledger where action_id = $1", [action.actionId]), {
      role: "owner",
    });
    expect(rows.rows[0]).toEqual({ state: "UNKNOWN", receipt: null });
    expect(await auditActions(action.actionId)).not.toContain("action.commit.succeeded");
    h.audit.failActions.clear();
    const ok = await h.service.reconcile(action.actionId, h.provider);
    expect(ok.outcome).toBe("COMMITTED");
    const audit = await fixtureAuditRows(h.db, action.actionId);
    expect(audit.find((e) => e.eventId === ok.auditEventId)?.action).toBe("action.reconciled");
    expect(h.provider.effectsFor(action.actionId)).toBe(1);
  });

  it("[OPS-01] a total audit outage after the provider call leaves the action COMMITTING and throws (no success claim)", async () => {
    const { ctx, action } = await prepareConfirmed();
    const original = h.provider.commit.bind(h.provider);
    h.provider.commit = async (a, key) => {
      const result = await original(a, key);
      h.audit.outage = true;
      return result;
    };
    const err = await commitOf(ctx, action).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DependencyError);
    expect((err as DependencyError).reasonCode).toBe("COMMIT_RECORDING_FAILED");
    expect((err as DependencyError).outcome).toBe("UNKNOWN");
    expect(await stateOf(action.actionId)).toBe("COMMITTING");
    h.audit.outage = false;
    h.provider.commit = original;
    h.clock.advanceSeconds(31);
    expect((await h.service.reconcile(action.actionId, h.provider)).outcome).toBe("COMMITTED");
    expect(h.provider.effectsFor(action.actionId)).toBe(1);
  });

  it("[OPS-01] audit outage blocks prepare (nothing is offered for confirmation)", async () => {
    h.health.forceUnhealthy = true;
    expect(await reason(prepare())).toBe("AUDIT_FIXTURE_OUTAGE");
    h.health.forceUnhealthy = false;
    h.audit.outage = true;
    expect(await reason(prepare())).toBe("AUDIT_FIXTURE_OUTAGE");
    const n = await h.db.tx((tx) => tx.query<{ n: number }>("select count(*)::int as n from action_ledger"), { role: "owner" });
    expect(n.rows[0]?.n).toBe(0);
  });

  it("[OPS-01] fail-safe invalidation still applies during an audit outage; confirmation does not", async () => {
    const { ctx, action } = await prepare();
    h.audit.outage = true;
    expect(await reason(h.service.confirm(confirmationFor(action, ctx.sessionRef, h.clock), telephonyIntegration()))).toBe("AUDIT_FIXTURE_OUTAGE");
    expect(await stateOf(action.actionId)).toBe("PREPARED");
    expect(await h.service.invalidatePending(ctx.sessionRef, "SAFETY_ESCALATION")).toBe(1);
    expect(await stateOf(action.actionId)).toBe("INVALIDATED");
  });
});

// ---------------------------------------------------------------- concurrency

describe("concurrency", () => {
  it("[ACT-02] two sessions prepare changes to the same record: only one commit succeeds, the other gets STATE_CHANGED, no duplicate effect", async () => {
    const ctxA = syntheticAuthContext(h.clock);
    const ctxB = syntheticAuthContext(h.clock);
    const { action: a } = await prepareConfirmed(ctxA);
    const { action: b } = await prepareConfirmed(ctxB, rescheduleInput({ change: { slotId: SLOTS[1].slotId } }));
    expect((await commitOf(ctxA, a)).outcome).toBe("COMMITTED");
    expect(await reason(commitOf(ctxB, b))).toBe("STATE_CHANGED");
    expect(await stateOf(b.actionId)).toBe("INVALIDATED");
    expect(h.provider.effects).toHaveLength(1);
    expect(h.provider.calls.commit).toBe(1);
    expect(await auditActions(b.actionId)).toContain("action.invalidate");
  });

  it("[ACT-02] concurrent commits on the same record: the in-flight holder blocks the other, which then gets STATE_CHANGED; one effect", async () => {
    const ctxA = syntheticAuthContext(h.clock);
    const ctxB = syntheticAuthContext(h.clock);
    const { action: a } = await prepareConfirmed(ctxA);
    const { action: b } = await prepareConfirmed(ctxB, rescheduleInput({ change: { slotId: SLOTS[1].slotId } }));
    let release: () => void = () => undefined;
    h.provider.gate = new Promise<void>((r) => {
      release = r;
    });
    const pendingA = commitOf(ctxA, a);
    await vi.waitFor(() => expect(h.provider.calls.commit).toBe(1));
    expect(await reason(commitOf(ctxB, b))).toBe("RECORD_COMMIT_IN_PROGRESS");
    release();
    h.provider.gate = undefined;
    expect((await pendingA).outcome).toBe("COMMITTED");
    expect(await reason(commitOf(ctxB, b))).toBe("STATE_CHANGED");
    expect(h.provider.effects).toHaveLength(1);
    expect(h.provider.calls.commit).toBe(1);
  });

  it("[ACT-02] parallel commit retries of the same action produce exactly one effect", async () => {
    const { ctx, action } = await prepareConfirmed();
    const results = await Promise.allSettled([commitOf(ctx, action), commitOf(ctx, action), commitOf(ctx, action)]);
    const ok = results.filter((r): r is PromiseFulfilledResult<CommitReceipt> => r.status === "fulfilled");
    expect(ok.length).toBeGreaterThanOrEqual(1);
    for (const r of ok) expect(r.value.outcome).toBe("COMMITTED");
    for (const r of results) if (r.status === "rejected") expect((r.reason as { reasonCode: string }).reasonCode).toMatch(/^(CONCURRENT_MODIFICATION|COMMIT_IN_PROGRESS)$/);
    expect(h.provider.effectsFor(action.actionId)).toBe(1);
    expect((await commitOf(ctx, action)).receiptId).toBe(ok[0]?.value.receiptId);
  });

  it("[SPEC-8.3] a concurrent version change observed by the optimistic-concurrency check invalidates with STATE_CHANGED and no provider commit", async () => {
    const { ctx, action } = await prepareConfirmed();
    h.provider.injectConcurrentVersionChange();
    expect(await reason(commitOf(ctx, action))).toBe("STATE_CHANGED");
    expect(await stateOf(action.actionId)).toBe("INVALIDATED");
    expect(h.provider.calls.commit).toBe(0);
  });

  it("[SPEC-8.3] a version conflict detected by the provider itself maps to STATE_CHANGED", async () => {
    const { ctx, action } = await prepareConfirmed();
    h.provider.injectCommitFault("version_conflict_on_commit");
    expect(await reason(commitOf(ctx, action))).toBe("STATE_CHANGED");
    expect(await stateOf(action.actionId)).toBe("INVALIDATED");
    expect(h.provider.effects).toHaveLength(0);
  });

  it("[SPEC-8.3] provider version unavailable is NOT_STARTED and returns the action to CONFIRMED", async () => {
    const { ctx, action } = await prepareConfirmed();
    h.provider.currentVersion = async () => {
      throw new Error("timeout");
    };
    const err = await commitOf(ctx, action).catch((e: unknown) => e);
    expect((err as DependencyError).reasonCode).toBe("PROVIDER_VERSION_UNAVAILABLE");
    expect((err as DependencyError).outcome).toBe("NOT_STARTED");
    expect(await stateOf(action.actionId)).toBe("CONFIRMED");
    expect(h.provider.calls.commit).toBe(0);
  });
});

// ---------------------------------------------------------------- session validity (AUTH-04)

describe("session validity", () => {
  it("[AUTH-04] an expired session context cannot commit even though no TTL cleanup ran (no provider call)", async () => {
    const { ctx, action } = await prepareConfirmed();
    const expired = { ...ctx, expiresAt: iso(addMs(h.clock.now(), -1)) };
    expect(await reason(commitOf(expired, action))).toBe("SESSION_EXPIRED");
    h.clock.set(new Date(ctx.expiresAt));
    expect(await reason(commitOf(ctx, action))).toBe("SESSION_EXPIRED");
    expect(h.provider.calls.commit + h.provider.calls.currentVersion).toBe(0);
  });

  it("[AUTH-04] a revoked session context cannot prepare or commit", async () => {
    const { ctx, action } = await prepareConfirmed();
    const revoked = { ...ctx, revoked: true };
    expect(await reason(commitOf(revoked, action))).toBe("SESSION_REVOKED");
    expect(await reason(h.service.prepare(revoked, rescheduleInput(), allowDecision(h.clock)))).toBe("SESSION_REVOKED");
    expect(h.provider.calls.commit).toBe(0);
    expect(await stateOf(action.actionId)).toBe("CONFIRMED");
  });

  it("[AUTH-04] an expired context cannot obtain the stored receipt of a committed action", async () => {
    const { ctx, action } = await prepareConfirmed();
    await commitOf(ctx, action);
    expect(await reason(commitOf({ ...ctx, expiresAt: iso(addMs(h.clock.now(), -1)) }, action))).toBe("SESSION_EXPIRED");
  });

  it("[AUTH-03] a context whose integration tenant differs from the session tenant fails closed", async () => {
    const { ctx, action } = await prepareConfirmed();
    expect(await reason(commitOf({ ...ctx, integration: mcpIntegration(OTHER_TENANT_ID) }, action))).toBe("SESSION_INTEGRATION_MISMATCH");
  });
});

// ---------------------------------------------------------------- operator paths

describe("operator and worker paths", () => {
  it("[SPEC-13.4] cancelPending cancels uncommitted work with an audited operator reference", async () => {
    const { ctx, action } = await prepareConfirmed();
    const cancelled = await h.service.cancelPending(ctx.tenantId, action.actionId, { reasonCode: "OPERATOR_CANCEL", actorRef: "stf_synthSupervisor01" });
    expect(cancelled.state).toBe("CANCELLED");
    expect(await auditActions(action.actionId)).toContain("action.cancel");
    expect(await reason(commitOf(ctx, action))).toBe("ACTION_NOT_COMMITTABLE");
    expect(await reason(h.service.cancelPending(ctx.tenantId, action.actionId, { reasonCode: "OPERATOR_CANCEL", actorRef: "stf_synthSupervisor01" }))).toBe(
      "ACTION_NOT_CANCELLABLE",
    );
  });

  it("[SPEC-13.4] cancelPending fails closed when the operator action cannot be audited", async () => {
    const { ctx, action } = await prepareConfirmed();
    h.audit.outage = true;
    expect(await reason(h.service.cancelPending(ctx.tenantId, action.actionId, { reasonCode: "OPERATOR_CANCEL", actorRef: "stf_synthSupervisor01" }))).toBe(
      "AUDIT_FIXTURE_OUTAGE",
    );
    expect(await stateOf(action.actionId)).toBe("CONFIRMED");
  });

  it("[AUTH-04] expireDue sweeps expired pending actions; reads already reported them EXPIRED", async () => {
    const { ctx, action } = await prepare();
    h.clock.advanceSeconds(400);
    expect((await h.service.get(ctx.tenantId, action.actionId))?.state).toBe("EXPIRED");
    expect(await h.service.expireDue(ctx.tenantId)).toBe(1);
    expect(await stateOf(action.actionId)).toBe("EXPIRED");
    expect(await h.service.expireDue(ctx.tenantId)).toBe(0);
  });
});
