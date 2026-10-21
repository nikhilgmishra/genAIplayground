/**
 * Layer 2 (WP-04): multi-connection contention on postgres:16 (FO-10-43, FO-11-13, FO-16-41; ACT-02).
 * Every race here runs on two or more DIFFERENT pools (separate backends, as two replicas would), never on
 * PGlite's single connection (ADR-0018 decision 7.2):
 *  - two outbox dispatchers claim with FOR UPDATE SKIP LOCKED: every message is settled exactly once; a
 *    dispatcher whose lease expired cannot settle over the new claim (claim-token fencing);
 *  - two commit attempts of one action: one provider call, one effect, one receipt;
 *  - two actions on one record: at most one in-doubt commit (partial unique index), proven by a raw race and
 *    through the production service;
 *  - a stale COMMITTING takeover: the old attempt cannot overwrite the new one (commit_attempt_id fencing);
 *  - CRASH_AFTER_COMMIT: a replica SIGKILLed after the provider applied the effect leaves COMMITTING; the next
 *    replica reconciles by the same idempotency key, with no second provider commit;
 *  - row_version predicates: two workers claiming one support request, exactly one wins.
 * The provider is ReferenceSystemOfRecord (reference-sor.ts): a scheduling system honouring idempotency keys,
 * in its own database, so call and effect counts are database facts.
 */
import { CreateQueueCommand, ReceiveMessageCommand } from "@aws-sdk/client-sqs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect } from "vitest";
import { PgOutboxDispatcher } from "../../../src/outbox/dispatcher.js";
import { PgOutbox } from "../../../src/outbox/outbox.js";
import type { MessagePublisher } from "../../../src/outbox/ports.js";
import { SqsPublisher } from "../../../src/outbox/sqs-publisher.js";
import { FakeClock, systemClock } from "../../../src/shared/clock.js";
import { DependencyError } from "../../../src/shared/errors.js";
import { newId } from "../../../src/shared/ids.js";
import { awsQueueUrl, postgresUrl, sqsClient, uniqueName } from "../_harness/clients.js";
import { layer2, layer2Context } from "../_harness/layer2.js";
import { CHILD_DIR, killAfter, raceOnTwoConnections } from "./contention-harness.js";
import { allow, confirmedAction, createSorDatabase, ledgerReplica } from "./reference-sor.js";
import type { SorDatabase } from "./reference-sor.js";
import { createAuroraLikeDb, latch } from "./support.js";
import type { AuroraLikeDb } from "./support.js";

const it = layer2(["postgres", "elasticmq"]);
let adb: AuroraLikeDb;
let sorDb: SorDatabase;

async function ledgerRow(tenantId: string, actionId: string) {
  const r = await adb.db.tx(
    (tx) =>
      tx.query<{ state: string; commit_attempt_id: string | null; commit_attempts: number; row_version: number; receipt: { receiptId: string; reconciled: boolean } | null }>(
        "select state, commit_attempt_id, commit_attempts, row_version, receipt from action_ledger where action_id = $1",
        [actionId],
      ),
    { role: "app_runtime", rls: { tenantId } },
  );
  return r.rows[0];
}

async function auditCount(tenantId: string, action: string, correlationId: string): Promise<number> {
  const r = await adb.db.tx((tx) => tx.query("select 1 from audit_outbox where action = $1 and correlation_id = $2", [action, correlationId]), { role: "app_worker", rls: { tenantId } });
  return r.rows.length;
}

describe("multi-connection contention on postgres:16", () => {
  beforeAll(async () => {
    const l2 = layer2Context(["postgres", "elasticmq"]);
    adb = await createAuroraLikeDb(l2, { poolSize: 4 });
    sorDb = await createSorDatabase((database?: string) => postgresUrl(l2, database));
  });
  afterAll(async () => {
    await sorDb?.drop();
    await adb?.drop();
  });

  it("[FO-16-41][FO-10-43][ACT-02] two dispatchers on two pools (FOR UPDATE SKIP LOCKED): forty messages, each published and settled exactly once", async ({ l2 }) => {
    const tenantId = newId("tnt");
    const sqs = sqsClient(l2);
    const name = uniqueName("vsp-it-contention");
    await sqs.send(new CreateQueueCommand({ QueueName: name }));
    const outbox = new PgOutbox({ clock: systemClock });
    const ids: string[] = [];
    await adb.db.tx(
      async (tx) => {
        for (let i = 0; i < 40; i++) ids.push(await outbox.enqueue(tx, { topic: "support_request.sync", key: `k:${i}`, payload: { supportRequestId: newId("sr") }, dedupeKey: `it:${newId("ddk")}` }));
      },
      { role: "app_runtime", rls: { tenantId } },
    );
    const publisher = new SqsPublisher({ client: sqs, queueUrl: awsQueueUrl(name), fifo: false });
    const dispatcher = () => new PgOutboxDispatcher({ db: adb.pool(2), publisher, clock: systemClock, tenants: [tenantId], config: { batchSize: 5 } });
    const loop = async (d: PgOutboxDispatcher) => {
      let total = 0;
      for (;;) {
        const r = await d.runOnce();
        total += r.dispatched;
        if (r.dispatched === 0) return total;
      }
    };
    const [a, b] = await Promise.all([loop(dispatcher()), loop(dispatcher())]);
    expect(a + b).toBe(40);
    expect(a, "both dispatchers took part").toBeGreaterThan(0);
    expect(b, "both dispatchers took part").toBeGreaterThan(0);
    const seen = new Map<string, number>();
    for (let i = 0; i < 20 && [...seen.values()].reduce((x, y) => x + y, 0) < 40; i++) {
      const got = (await sqs.send(new ReceiveMessageCommand({ QueueUrl: awsQueueUrl(name), MaxNumberOfMessages: 10, WaitTimeSeconds: 1, VisibilityTimeout: 60 }))).Messages ?? [];
      for (const m of got) {
        const id = String(JSON.parse(m.Body ?? "{}").messageId);
        seen.set(id, (seen.get(id) ?? 0) + 1);
      }
    }
    expect([...seen.keys()].sort()).toEqual([...ids].sort());
    expect([...seen.values()].every((n) => n === 1)).toBe(true);
  });

  it("[FO-16-41][FO-10-43] a dispatcher whose lease expired mid-publish cannot settle over the new claim (claim-token fencing), even while the new holder is still publishing; the message settles once, by the holder", async ({ l2 }) => {
    const tenantId = newId("tnt");
    const sqs = sqsClient(l2);
    const name = uniqueName("vsp-it-lease");
    await sqs.send(new CreateQueueCommand({ QueueName: name }));
    await adb.db.tx((tx) => new PgOutbox({ clock: systemClock }).enqueue(tx, { topic: "support_request.sync", key: "k:lease", payload: { supportRequestId: newId("sr") }, dedupeKey: `it:${newId("ddk")}` }), { role: "app_runtime", rls: { tenantId } });
    const real = new SqsPublisher({ client: sqs, queueUrl: awsQueueUrl(name), fifo: false });
    const held = (): { publisher: MessagePublisher; entered: ReturnType<typeof latch>; gate: ReturnType<typeof latch> } => {
      const entered = latch();
      const gate = latch();
      return {
        entered,
        gate,
        publisher: {
          kind: "live",
          publish: async (m) => {
            entered.release();
            await gate.promise; // the replica stalls inside its publish (GC pause, network partition)
            return real.publish(m);
          },
        },
      };
    };
    const a = held();
    const b = held();
    const stalled = new PgOutboxDispatcher({ db: adb.pool(2), publisher: a.publisher, clock: systemClock, tenants: [tenantId], config: { leaseSeconds: 5 } });
    const later = new FakeClock(new Date(Date.now() + 30_000));
    const takeover = new PgOutboxDispatcher({ db: adb.pool(2), publisher: b.publisher, clock: later, tenants: [tenantId], config: { leaseSeconds: 5 } });
    const first = stalled.runOnce();
    await a.entered.promise;
    const second = takeover.runOnce(); // A's lease expired: B re-claims with its own token
    await b.entered.promise;
    a.gate.release();
    expect((await first).dispatched, "the stale claim settles nothing while B holds the claim").toBe(0);
    const mid = await adb.db.tx((tx) => tx.query<{ status: string }>("select status from outbox_messages"), { role: "app_worker", rls: { tenantId } });
    expect(mid.rows.map((r) => r.status)).toEqual(["PENDING"]);
    b.gate.release();
    expect((await second).dispatched).toBe(1);
    const state = await adb.db.tx((tx) => tx.query<{ status: string }>("select status from outbox_messages"), { role: "app_worker", rls: { tenantId } });
    expect(state.rows.map((r) => r.status)).toEqual(["DISPATCHED"]);
  });

  it("[FO-10-43][FO-11-13][ACT-02] two replicas commit the same confirmed action at once: one provider commit, one effect, one receipt", async () => {
    const tenantId = newId("tnt");
    const recordRef = newId("apt");
    await sorDb.sor.seed(recordRef);
    const a = ledgerReplica(adb.pool(2), systemClock, "replica-a");
    const b = ledgerReplica(adb.pool(2), systemClock, "replica-b");
    const { ctx, action } = await confirmedAction(a, tenantId, recordRef);
    const slowSor = sorDb.sor.withHooks({ beforeApply: () => new Promise((r) => setTimeout(r, 250)) });
    const deps = { reauthorize: async () => allow(systemClock), provider: slowSor };
    const results = await Promise.allSettled([a.service.commit(ctx, { actionId: action.actionId, digest: action.digest }, deps), b.service.commit(ctx, { actionId: action.actionId, digest: action.digest }, deps)]);
    const ok = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof a.service.commit>>> => r.status === "fulfilled");
    expect(ok.length).toBeGreaterThanOrEqual(1);
    for (const r of results) if (r.status === "rejected") expect((r.reason as { reasonCode?: string }).reasonCode).toMatch(/^(COMMIT_IN_PROGRESS|CONCURRENT_MODIFICATION)$/);
    const row = await ledgerRow(tenantId, action.actionId);
    expect(row?.state).toBe("COMMITTED");
    expect(new Set(ok.map((r) => r.value.receiptId))).toEqual(new Set([row?.receipt?.receiptId]));
    expect(await sorDb.sor.calls("commit", undefined)).toBeGreaterThanOrEqual(1);
    expect(await sorDb.sor.effects(recordRef)).toBe(1);
    expect(await auditCount(tenantId, "action.commit.succeeded", action.actionId)).toBe(1);
  });

  it("[FO-11-13][ACT-02][FAULT:CONCURRENT_SAME_ACCOUNT seam] one in-doubt commit per record: a raw two-connection race on the partial unique index lets exactly one claim win", async () => {
    const tenantId = newId("tnt");
    const recordRef = newId("apt");
    await sorDb.sor.seed(recordRef);
    const r = ledgerReplica(adb.pool(2), systemClock, "race-setup");
    const x = await confirmedAction(r, tenantId, recordRef);
    const y = await confirmedAction(r, tenantId, recordRef);
    const claim = (actionId: string) => ({
      db: adb.pool(1),
      opts: { role: "app_runtime" as const, rls: { tenantId } },
      body: async (tx: Parameters<Parameters<typeof raceOnTwoConnections>[0]["body"]>[0], barrier: () => Promise<void>) => {
        await barrier();
        const u = await tx.query(
          `update action_ledger set state = 'COMMITTING', commit_attempt_id = $2, committing_since = now(), commit_attempts = commit_attempts + 1,
                  row_version = row_version + 1, updated_at = now() where action_id = $1 and state = 'CONFIRMED'`,
          [actionId, newId("cat")],
        );
        return u.rowCount;
      },
    });
    const [p, q] = await raceOnTwoConnections(claim(x.action.actionId), claim(y.action.actionId));
    expect(p.backendPid).not.toBe(q.backendPid);
    const outcomes = [p, q].map((o) => (o.ok ? "claimed" : String((o.error as { code?: string }).code)));
    expect(outcomes.sort()).toEqual(["23505", "claimed"]);
  });

  it("[FO-11-13][ACT-02] through the production service: while one action's provider call is in doubt, a second action on the same record is refused before any provider call", async () => {
    const tenantId = newId("tnt");
    const recordRef = newId("apt");
    await sorDb.sor.seed(recordRef);
    const a = ledgerReplica(adb.pool(2), systemClock, "slot-a");
    const b = ledgerReplica(adb.pool(2), systemClock, "slot-b");
    const first = await confirmedAction(a, tenantId, recordRef);
    const second = await confirmedAction(b, tenantId, recordRef);
    const entered = latch();
    const gate = latch();
    const held = sorDb.sor.withHooks({ beforeApply: async () => (entered.release(), gate.promise) });
    const running = a.service.commit(first.ctx, { actionId: first.action.actionId, digest: first.action.digest }, { reauthorize: async () => allow(systemClock), provider: held });
    await entered.promise;
    const commitsBefore = await sorDb.sor.calls("commit");
    await expect(b.service.commit(second.ctx, { actionId: second.action.actionId, digest: second.action.digest }, { reauthorize: async () => allow(systemClock), provider: sorDb.sor })).rejects.toMatchObject({ reasonCode: "RECORD_COMMIT_IN_PROGRESS" });
    expect(await sorDb.sor.calls("commit"), "the refused action made no provider call").toBe(commitsBefore);
    gate.release();
    expect((await running).outcome).toBe("COMMITTED");
    expect(await sorDb.sor.effects(recordRef)).toBe(1);
    expect((await ledgerRow(tenantId, second.action.actionId))?.state).toBe("CONFIRMED");
  });

  it("[FO-10-43][ACT-02] commit_attempt_id fencing: a stalled attempt whose provider call times out cannot mark the takeover's attempt UNKNOWN; one effect", async () => {
    const tenantId = newId("tnt");
    const recordRef = newId("apt");
    await sorDb.sor.seed(recordRef);
    const a = ledgerReplica(adb.pool(2), systemClock, "fence-a");
    const later = new FakeClock(new Date(Date.now() + 45_000)); // past committingStaleAfterSeconds (30 s)
    const b = ledgerReplica(adb.pool(2), later, "fence-b");
    const { ctx, action } = await confirmedAction(a, tenantId, recordRef);
    const aEntered = latch();
    const aGate = latch();
    const aProvider = sorDb.sor.withHooks({ beforeApply: async () => (aEntered.release(), aGate.promise), failWith: () => new DependencyError("PROVIDER_TIMEOUT", "UNKNOWN") });
    const aRun = a.service.commit(ctx, { actionId: action.actionId, digest: action.digest }, { reauthorize: async () => allow(systemClock), provider: aProvider }).then(
      (v) => ({ ok: true as const, v }),
      (e: unknown) => ({ ok: false as const, e }),
    );
    await aEntered.promise;
    const attemptA = (await ledgerRow(tenantId, action.actionId))?.commit_attempt_id;
    const bEntered = latch();
    const bGate = latch();
    const bProvider = sorDb.sor.withHooks({ beforeApply: async () => (bEntered.release(), bGate.promise) });
    const bRun = b.service.commit(ctx, { actionId: action.actionId, digest: action.digest }, { reauthorize: async () => allow(later), provider: bProvider });
    await bEntered.promise; // B reconciled (NOT_FOUND), re-claimed and is now inside its own provider call
    const attemptB = (await ledgerRow(tenantId, action.actionId))?.commit_attempt_id;
    expect(attemptB).toBeTruthy();
    expect(attemptB).not.toBe(attemptA);
    aGate.release();
    const aOut = await aRun;
    expect(aOut.ok).toBe(false);
    if (!aOut.ok) expect(aOut.e).toMatchObject({ reasonCode: "COMMIT_OUTCOME_UNKNOWN", outcome: "UNKNOWN" });
    const mid = await ledgerRow(tenantId, action.actionId);
    expect(mid).toMatchObject({ state: "COMMITTING", commit_attempt_id: attemptB });
    bGate.release();
    expect((await bRun).outcome).toBe("COMMITTED");
    expect(await sorDb.sor.effects(recordRef)).toBe(1);
    expect((await ledgerRow(tenantId, action.actionId))?.commit_attempts).toBe(2);
  });

  it("[FO-10-43][ACT-02][FAULT:CRASH_AFTER_COMMIT seam] a replica SIGKILLed after the provider applied the effect: the next replica reconciles by the same key, records COMMITTED once, and never commits again", async () => {
    const tenantId = newId("tnt");
    const recordRef = newId("apt");
    await sorDb.sor.seed(recordRef);
    const setup = ledgerReplica(adb.pool(2), systemClock, "crash-setup");
    const { ctx, action } = await confirmedAction(setup, tenantId, recordRef);
    const run = await killAfter(join(CHILD_DIR, "commit-child.ts"), [], "PROVIDER_APPLIED", "SIGKILL", {
      VSP_CHILD_DB_URL: adb.appUrl,
      VSP_CHILD_SOR_URL: sorDb.url,
      VSP_CHILD_CTX: JSON.stringify(ctx),
      VSP_CHILD_ACTION_ID: action.actionId,
      VSP_CHILD_DIGEST: action.digest,
    });
    expect(run.exit.signal).toBe("SIGKILL");
    const crashed = await ledgerRow(tenantId, action.actionId);
    expect(crashed?.state).toBe("COMMITTING");
    expect(crashed?.commit_attempt_id).toBeTruthy();
    expect(await sorDb.sor.effects(recordRef)).toBe(1);
    const key = (await adb.db.tx((tx) => tx.query<{ k: string }>("select provider_idempotency_key as k from action_ledger where action_id = $1", [action.actionId]), { role: "app_runtime", rls: { tenantId } })).rows[0]?.k ?? "";
    expect(await sorDb.sor.calls("commit", key)).toBe(1);

    // Not yet stale: a retry is refused rather than racing the (dead) attempt.
    const early = ledgerReplica(adb.pool(2), systemClock, "crash-early");
    await expect(early.service.commit(ctx, { actionId: action.actionId, digest: action.digest }, { reauthorize: async () => allow(systemClock), provider: sorDb.sor })).rejects.toMatchObject({ reasonCode: "COMMIT_IN_PROGRESS" });

    const later = new FakeClock(new Date(Date.now() + 60_000));
    const restarted = ledgerReplica(adb.pool(2), later, "crash-restarted");
    const receipt = await restarted.service.commit(ctx, { actionId: action.actionId, digest: action.digest }, { reauthorize: async () => allow(later), provider: sorDb.sor });
    expect(receipt).toMatchObject({ outcome: "COMMITTED", reconciled: true });
    expect(await sorDb.sor.calls("commit", key), "no second provider commit").toBe(1);
    expect(await sorDb.sor.calls("lookup", key)).toBe(1);
    expect(await sorDb.sor.effects(recordRef)).toBe(1);
    const final = await ledgerRow(tenantId, action.actionId);
    expect(final?.state).toBe("COMMITTED");
    expect(final?.receipt?.receiptId).toBe(receipt.receiptId);
    expect(await auditCount(tenantId, "action.reconciled", action.actionId)).toBe(1);
    // A replay returns the stored receipt without touching the provider.
    expect((await restarted.service.commit(ctx, { actionId: action.actionId, digest: action.digest }, { reauthorize: async () => allow(later), provider: sorDb.sor })).receiptId).toBe(receipt.receiptId);
    expect(await sorDb.sor.calls("lookup", key)).toBe(1);
  });

  it("[FO-11-13][ACT-02] row_version predicate: two workers claim one support request at the same instant on two connections; exactly one claim applies", async () => {
    const tenantId = newId("tnt");
    const srId = newId("sr");
    const callId = newId("call");
    const intId = newId("int");
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const pick = () => Array.from(randomBytes(4), (v) => alphabet.charAt(v % alphabet.length)).join("");
    await adb.db.tx(
      async (tx) => {
        await tx.query("insert into support_interactions (interaction_external_id, tenant_id, call_id, language, consent_status, started_at, created_at) values ($1, $2, $3, 'en', 'GRANTED', now(), now())", [intId, tenantId, callId]);
        await tx.query(
          `insert into support_requests (support_request_id, tenant_id, reference_number, interaction_external_id, issue_external_id, call_id, issue_category, disposition,
             owner_queue, priority, summary, summary_template_id, summary_provenance, attempted, commit_receipt_ids, source_call_ids, language, consent, versions,
             restricted, sync_state, created_at, updated_at)
           values ($1, $2, $3, $4, $5, $6, 'general_question', 'REQUEST_ACCEPTED', 'q_general', 'P3_STANDARD', 'Synthetic support request', 'summary.general_question',
             'template_assembled', '[]', '[]', $7::jsonb, 'en', '{}', '{}', false, 'PENDING', now(), now())`,
          [srId, tenantId, `SR-${pick()}-${pick()}`, intId, newId("iss"), callId, JSON.stringify([callId])],
        );
      },
      { role: "app_runtime", rls: { tenantId } },
    );
    const claim = () => ({
      db: adb.pool(1),
      opts: { role: "app_worker" as const, rls: { tenantId } },
      body: async (tx: Parameters<Parameters<typeof raceOnTwoConnections>[0]["body"]>[0], barrier: () => Promise<void>) => {
        const seen = await tx.query<{ row_version: number }>("select row_version from support_requests where support_request_id = $1", [srId]);
        await barrier(); // both read version 1 before either writes
        const u = await tx.query(
          `update support_requests set sync_state = 'SYNCING', sync_claim_token = $2, last_sync_attempt_at = now(), sync_attempts = sync_attempts + 1,
                  row_version = row_version + 1, updated_at = now() where support_request_id = $1 and row_version = $3`,
          [srId, newId("scl"), seen.rows[0]?.row_version],
        );
        return u.rowCount;
      },
    });
    const [p, q] = await raceOnTwoConnections(claim(), claim());
    expect(p.backendPid).not.toBe(q.backendPid);
    expect([p, q].map((o) => (o.ok ? o.value : -1)).sort()).toEqual([0, 1]);
    const row = await adb.db.tx((tx) => tx.query<{ row_version: number; sync_attempts: number }>("select row_version, sync_attempts from support_requests where support_request_id = $1", [srId]), { role: "app_worker", rls: { tenantId } });
    expect(row.rows[0]).toEqual({ row_version: 2, sync_attempts: 1 });
  });
});
