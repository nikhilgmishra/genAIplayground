/**
 * Property test (fast-check, fixed seed => deterministic): random interleavings of commit
 * retries, ambiguous timeouts, provider exceptions, process crashes, audit outages, lookup
 * faults, clock advances, outbox dispatch and duplicate redelivery, for two competing actions
 * prepared by different sessions against the same SYNTHETIC record.
 *
 * Provider-side idempotency is DISABLED in the FakeProviderFixture, so only the ledger protocol
 * can prevent duplicate effects.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import { TENANT_ID } from "../fixtures/synthetic-world.js";
import { MemoryPublisherFixture } from "../outbox/memory-publisher.fixture.js";
import { PgOutboxDispatcher } from "../outbox/dispatcher.js";
import { PgConsumerDedup } from "../outbox/consumer-dedup.js";
import type { AuthContext, CommitReceipt, PreparedAction } from "../protocol/index.js";
import { newId } from "../shared/ids.js";
import type { CommitDeps } from "./ports.js";
import { fixtureAuditRows } from "./fixtures/audit-writer.fixture.js";
import { CrashingDbFixture } from "./fixtures/crashing-db.fixture.js";
import { allowDecision, confirmationFor, createLedgerHarness, rescheduleInput, syntheticAuthContext, telephonyIntegration } from "./fixtures/world.fixture.js";
import type { LedgerHarness } from "./fixtures/world.fixture.js";
import type { LedgerActionService } from "./action-service.js";

type CommitFault =
  | "none"
  | "timeout_before_send"
  | "timeout_after_commit"
  | "provider_exception"
  | "process_crash"
  | "audit_outage_before"
  | "audit_fail_on_success"
  | "audit_outage_after_provider"
  | "lookup_unknown"
  | "version_unavailable";

type Op =
  | { kind: "commit"; who: "a" | "b"; fault: CommitFault }
  | { kind: "reconcile"; who: "a" | "b"; lookupUnknown: boolean }
  | { kind: "advance"; seconds: number }
  | { kind: "dispatch" }
  | { kind: "redeliver" };

const who = fc.oneof({ arbitrary: fc.constant<"a" | "b">("a"), weight: 3 }, { arbitrary: fc.constant<"a" | "b">("b"), weight: 1 });
const commitFault = fc.constantFrom<CommitFault>(
  "none",
  "timeout_before_send",
  "timeout_after_commit",
  "provider_exception",
  "process_crash",
  "audit_outage_before",
  "audit_fail_on_success",
  "audit_outage_after_provider",
  "lookup_unknown",
  "version_unavailable",
);
const opArb: fc.Arbitrary<Op> = fc.oneof(
  { arbitrary: fc.record({ kind: fc.constant("commit" as const), who, fault: commitFault }), weight: 6 },
  { arbitrary: fc.record({ kind: fc.constant("reconcile" as const), who, lookupUnknown: fc.boolean() }), weight: 3 },
  { arbitrary: fc.record({ kind: fc.constant("advance" as const), seconds: fc.integer({ min: 1, max: 40 }) }), weight: 2 },
  { arbitrary: fc.record({ kind: fc.constant("dispatch" as const) }), weight: 1 },
  { arbitrary: fc.record({ kind: fc.constant("redeliver" as const) }), weight: 1 },
);

let h: LedgerHarness;
let crashing: CrashingDbFixture;
let crashingService: LedgerActionService;
let publisher: MemoryPublisherFixture;
let dispatcher: PgOutboxDispatcher;

beforeAll(async () => {
  h = await createLedgerHarness({}, { providerDedupByKey: false });
  crashing = new CrashingDbFixture(h.db);
  crashingService = h.makeService(crashing);
  await h.db.exec(`create table test_consumer_effects (action_id text primary key, applied int not null);
                   grant select, insert, update on test_consumer_effects to app_worker;`);
  publisher = new MemoryPublisherFixture({ duplicateEveryDelivery: true });
  const dedup = new PgConsumerDedup({ db: h.db, clock: h.clock });
  publisher.subscribe(async (message) => {
    const m = message as typeof message & { tenantId: string };
    await dedup.processOnceForTenant(m.tenantId, "property-consumer", message.messageId, (tx) =>
      tx.query(
        `insert into test_consumer_effects (action_id, applied) values ($1, 1)
         on conflict (action_id) do update set applied = test_consumer_effects.applied + 1`,
        [String(message.payload.actionId)],
      ),
    );
  });
  dispatcher = new PgOutboxDispatcher({ db: h.db, publisher, clock: h.clock, tenants: [TENANT_ID], random: () => 0.5, config: { baseDelayMs: 10, maxDelayMs: 20 } });
});

afterAll(async () => {
  await h.db.close();
});

async function ledger(actionId: string): Promise<{ state: string; receipt: CommitReceipt | null }> {
  const r = await h.db.tx((tx) => tx.query<{ state: string; receipt: CommitReceipt | null }>("select state, receipt from action_ledger where action_id = $1", [actionId]), {
    role: "owner",
  });
  const row = r.rows[0];
  if (!row) throw new Error("missing ledger row");
  return row;
}

async function consumerApplied(actionId: string): Promise<number> {
  const r = await h.db.tx((tx) => tx.query<{ applied: number }>("select applied from test_consumer_effects where action_id = $1", [actionId]), { role: "owner" });
  return r.rows[0]?.applied ?? 0;
}

/** Invariants that must hold after every step. */
async function checkInvariants(actions: PreparedAction[], recordKey: string): Promise<void> {
  expect(h.provider.redundantCommitCalls).toBe(0);
  const recordEffects = h.provider.effects.filter((e) => e.recordKey === recordKey).length;
  // Both actions were prepared at the same before-version: at most one may ever take effect.
  expect(recordEffects).toBeLessThanOrEqual(1);
  for (const a of actions) {
    const effects = h.provider.effectsFor(a.actionId);
    expect(effects).toBeLessThanOrEqual(1);
    const { state, receipt } = await ledger(a.actionId);
    if (state === "COMMITTED") {
      expect(effects).toBe(1);
      expect(receipt).not.toBeNull();
      const audit = await fixtureAuditRows(h.db, a.actionId);
      expect(audit.some((e) => e.eventId === receipt?.auditEventId && (e.action === "action.commit.succeeded" || e.action === "action.reconciled"))).toBe(true);
    }
    // An applied effect is never hidden behind a "not done" state: it is COMMITTED or in doubt.
    if (effects === 1) expect(["COMMITTED", "COMMITTING", "UNKNOWN"]).toContain(state);
    if (effects === 0) expect(state).not.toBe("COMMITTED");
    expect(await consumerApplied(a.actionId)).toBeLessThanOrEqual(1);
  }
}

function resetFaults(): void {
  h.provider.clearFaults();
  h.provider.onCrash = undefined;
  h.audit.outage = false;
  h.audit.failActions.clear();
  h.health.forceUnhealthy = false;
  crashing.restart();
}

describe("commit protocol property", () => {
  it("[ACT-02][ACT-03][OPS-01] random retry/redelivery/crash interleavings: at most one effect per action and per record, no COMMITTED without receipt+audit", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 20 }), async (ops) => {
        resetFaults();
        const recordRef = newId("apt");
        h.provider.seedRecord("scheduling", recordRef, 1);
        const recordKey = `scheduling:${recordRef}`;
        const target = { system: "scheduling" as const, recordType: "appointment", recordRef, beforeVersion: "v1" };
        const ctxs: Record<"a" | "b", AuthContext> = { a: syntheticAuthContext(h.clock), b: syntheticAuthContext(h.clock) };
        const actions: Record<"a" | "b", PreparedAction> = {
          a: await h.service.prepare(ctxs.a, rescheduleInput({ target }), allowDecision(h.clock)),
          b: await h.service.prepare(ctxs.b, rescheduleInput({ target, change: { slotId: "slt_synthMorganSlot0003" } }), allowDecision(h.clock)),
        };
        h.clock.advanceSeconds(1);
        for (const k of ["a", "b"] as const) {
          actions[k] = await h.service.confirm(confirmationFor(actions[k], ctxs[k].sessionRef, h.clock), telephonyIntegration());
        }
        const deps = (): CommitDeps => ({ reauthorize: async () => allowDecision(h.clock), provider: h.provider });

        for (const op of ops) {
          resetFaults();
          if (op.kind === "advance") h.clock.advanceSeconds(op.seconds);
          else if (op.kind === "dispatch") await dispatcher.runOnce(50);
          else if (op.kind === "redeliver") await publisher.redeliverAll();
          else if (op.kind === "reconcile") {
            if (op.lookupUnknown) h.provider.injectLookupFault("unknown");
            const r = await h.service.reconcile(actions[op.who].actionId, h.provider).catch(() => null);
            if (r?.outcome === "COMMITTED") await checkInvariants(Object.values(actions), recordKey);
          } else {
            let svc = h.service;
            const original = h.provider.commit.bind(h.provider);
            const originalVersion = h.provider.currentVersion.bind(h.provider);
            switch (op.fault) {
              case "timeout_before_send":
              case "timeout_after_commit":
                h.provider.injectCommitFault(op.fault);
                break;
              case "provider_exception":
                h.provider.injectCommitFault("crash_after_commit");
                break;
              case "process_crash":
                svc = crashingService;
                h.provider.onCrash = () => crashing.crash();
                h.provider.injectCommitFault("crash_after_commit");
                break;
              case "audit_outage_before":
                h.audit.outage = true;
                break;
              case "audit_fail_on_success":
                h.audit.failActions.add("action.commit.succeeded");
                h.audit.failActions.add("action.reconciled");
                break;
              case "audit_outage_after_provider":
                h.provider.commit = async (a, key) => {
                  const result = await original(a, key);
                  h.audit.outage = true;
                  return result;
                };
                break;
              case "lookup_unknown":
                h.provider.injectLookupFault("unknown");
                break;
              case "version_unavailable":
                h.provider.currentVersion = async () => {
                  throw new Error("timeout");
                };
                break;
              case "none":
                break;
            }
            const a = actions[op.who];
            const r = await svc.commit(ctxs[op.who], { actionId: a.actionId, digest: a.digest }, deps()).catch(() => null);
            h.provider.commit = original;
            h.provider.currentVersion = originalVersion;
            resetFaults();
            // A COMMITTED answer is only ever given once the receipt and its audit row are durable.
            if (r?.outcome === "COMMITTED") await checkInvariants(Object.values(actions), recordKey);
          }
          resetFaults();
          await checkInvariants(Object.values(actions), recordKey);
        }

        // Drain: no faults, past the stale window; every in-doubt action must resolve by lookup.
        resetFaults();
        h.clock.advanceSeconds(31);
        for (const k of ["a", "b"] as const) {
          const { state } = await ledger(actions[k].actionId);
          if (state === "UNKNOWN" || state === "COMMITTING") {
            const r = await h.service.reconcile(actions[k].actionId, h.provider);
            expect(["COMMITTED", "NOT_STARTED"]).toContain(r.outcome);
          }
        }
        await dispatcher.runOnce(100);
        await publisher.redeliverAll();
        await checkInvariants(Object.values(actions), recordKey);
        for (const k of ["a", "b"] as const) {
          const { state } = await ledger(actions[k].actionId);
          const effects = h.provider.effectsFor(actions[k].actionId);
          expect(effects === 1).toBe(state === "COMMITTED");
          expect(await consumerApplied(actions[k].actionId)).toBe(state === "COMMITTED" ? 1 : 0);
        }
      }),
      { numRuns: 150, seed: 20261017, endOnFailure: true },
    );
  }, 600_000);
});
