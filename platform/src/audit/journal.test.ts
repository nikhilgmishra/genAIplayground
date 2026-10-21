/**
 * Durable route-audit journal (FO-01-19, FO-15-45, FO-22-08) over real PostgreSQL SQL (PGlite: foundation,
 * audit and 2040 migrations), the real PgAuditWriter, a FakeClock and SYNTHETIC inputs. The audit outage
 * is a real privilege failure (`revoke insert on audit_outbox from app_runtime`); a PostgreSQL outage is
 * an unreachable database (DownDbFixture, labelled). PGlite is one connection: the multi-process
 * crash-restart and the concurrent-flusher runs are Layer 2 (platform/test/integration/substrate).
 */
import { PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PgliteDb } from "../db/pglite.js";
import { createTestDb } from "../db/testing.js";
import type { Db, Queryable, QueryResult } from "../db/types.js";
import { createMemoryLogger } from "../observability/logger.js";
import { InMemoryMetrics, createMetricCatalogue } from "../observability/metrics.js";
import { withSubstrateMetrics } from "../observability/catalog/substrate.js";
import type { AuditEvent, AuditEventInput } from "../protocol/index.js";
import { canonicalJson, sha256Hex } from "../shared/canonical.js";
import { FakeClock } from "../shared/clock.js";
import { AuditUnavailableError, DependencyError, ValidationError } from "../shared/errors.js";
import { verifyChain } from "./chain.js";
import { DEFERRED_AUDIT_MARKER_ACTION } from "./deferred.js";
import { PgAuditHealth } from "./health.js";
import {
  DurableDeferredAuditQueue,
  DynamoRouteAuditJournal,
  JOURNAL_ENTRY_QUARANTINED_ACTION,
  deferralTimeOfSortKey,
  insertDeferral,
  isCanonicalDeferralTime,
  journalEntryFor,
  parseJournalEntry,
  rejectedJournalItem,
} from "./journal.js";
import type { DurableDeferredAuditQueueOptions, IndependentRouteAuditJournal, JournalDocumentSender, JournalEntry, JournalRead, RejectedJournalItem } from "./journal.js";
import { PgRouteAuditIntents } from "./route-reconciler.js";
import { TENANT_ID, sampleAuditInput } from "./testing.js";
import { PgAuditWriter } from "./writer.js";

const STREAM = "runtime";
let db: PgliteDb;
let clock: FakeClock;

/** Creating and migrating an embedded PostgreSQL can take long on a contended shared machine. */
const PGLITE_SETUP_TIMEOUT_MS = 120_000;

beforeEach(async () => {
  db = await createTestDb({ include: /^(02|2040|2045)/ });
  clock = new FakeClock("2026-10-19T10:00:00.000Z");
}, PGLITE_SETUP_TIMEOUT_MS);
afterEach(async () => {
  await db.close();
});

const route = (action: string, correlationId: string): AuditEventInput =>
  sampleAuditInput(clock, { action, correlationId, sourceComponent: "gateway", outcome: "PENDING", assurance: "A0", actorRef: null, subjectRef: null, role: null, idempotencyKey: null, evidencePointers: [], turnId: null });

/** LOCAL TEST DOUBLE of the independent journal (the DynamoDB journal runs against DynamoDB Local in Layer 2). */
class IndependentJournalFixture implements IndependentRouteAuditJournal {
  readonly kind = "local_fixture" as const;
  readonly journal = "dynamodb" as const;
  /** Stored items by sort key (`deferredAt#deferralId`), in put order; `stored` is what a reader gets back. */
  readonly items = new Map<string, { partition: string; stored: JournalEntry; drained: boolean; quarantined: { at: string; recordEventId: string; reasonCode: string; ref: string } | null }>();
  down = false;
  /** Reads fail (DynamoDB unreachable for queries) while writes are not attempted. */
  readDown = false;
  failMarkOnce = false;
  async put(entry: JournalEntry): Promise<void> {
    if (this.down) throw new DependencyError("AUDIT_JOURNAL_WRITE_FAILED", "UNKNOWN", false);
    const key = `${entry.deferredAt}#${entry.deferralId}`;
    if (!this.items.has(key)) this.items.set(key, { partition: entry.tenantId, stored: structuredClone(entry), drained: false, quarantined: null });
  }
  async read(tenantId: string, limit: number): Promise<JournalRead> {
    if (this.readDown) throw new DependencyError("AUDIT_JOURNAL_READ_FAILED", "FAILED", true);
    const out: JournalRead = { entries: [], rejected: [] };
    // Ascending sort key, as a DynamoDB Query returns the partition.
    for (const [key, i] of [...this.items].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (i.drained || i.quarantined || i.partition !== tenantId) continue;
      try {
        const e = parseJournalEntry(structuredClone(i.stored));
        if (e.tenantId !== tenantId) throw new ValidationError("AUDIT_JOURNAL_ENTRY_INVALID");
        out.entries.push(e);
      } catch (err) {
        out.rejected.push(rejectedJournalItem(tenantId, key, err));
      }
      if (out.entries.length + out.rejected.length >= limit) break;
    }
    return out;
  }
  async newestPendingMs(tenantId: string): Promise<number | null> {
    if (this.readDown) throw new DependencyError("AUDIT_JOURNAL_READ_FAILED", "FAILED", true);
    // Descending sort key, as a DynamoDB Query with ScanIndexForward=false returns the partition.
    for (const [key, i] of [...this.items].sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))) {
      if (i.drained || i.quarantined || i.partition !== tenantId) continue;
      const ms = deferralTimeOfSortKey(key);
      if (ms !== null) return ms;
    }
    return null;
  }
  async markDrained(entry: JournalEntry): Promise<void> {
    if (this.failMarkOnce) {
      this.failMarkOnce = false;
      throw new DependencyError("AUDIT_JOURNAL_WRITE_FAILED", "UNKNOWN", false);
    }
    const i = this.items.get(`${entry.deferredAt}#${entry.deferralId}`);
    if (i) i.drained = true;
  }
  async quarantine(item: RejectedJournalItem, at: string, recordEventId: string): Promise<void> {
    const i = this.items.get(item.key);
    if (i && !i.drained && !i.quarantined) i.quarantined = { at, recordEventId, reasonCode: item.reasonCode, ref: item.ref };
  }
  /** Insider / corruption: rewrites the stored input of one deferral, keeping its digest. */
  tamper(deferralId: string, change: Partial<AuditEventInput>): string {
    for (const [key, i] of this.items) {
      if (i.stored.deferralId === deferralId) {
        i.stored = { ...i.stored, input: { ...i.stored.input, ...change } };
        return key;
      }
    }
    throw new Error("no such deferral");
  }
}

/** LOCAL TEST DOUBLE: a PostgreSQL that cannot be reached (every call fails before running anything). */
class DownDbFixture implements Db {
  readonly engine = "pg" as const;
  down = true;
  constructor(private readonly inner: Db) {}
  private gate(): void {
    if (this.down) throw new DependencyError("DB_UNAVAILABLE", "NOT_STARTED");
  }
  async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
    this.gate();
    return this.inner.query<T>(sql, params);
  }
  async exec(sql: string): Promise<void> {
    this.gate();
    return this.inner.exec(sql);
  }
  async tx<T>(fn: (tx: Queryable) => Promise<T>, opts?: Parameters<Db["tx"]>[1]): Promise<T> {
    this.gate();
    return this.inner.tx(fn, opts);
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

function compose(opts: { db?: Db; independent?: IndependentRouteAuditJournal | null; maxInlineDrain?: number; clock?: FakeClock; health?: DurableDeferredAuditQueueOptions["health"] } = {}) {
  const { logger, records } = createMemoryLogger();
  const metrics = new InMemoryMetrics({ catalogue: withSubstrateMetrics(createMetricCatalogue()) });
  const d = opts.db ?? db;
  const c = opts.clock ?? clock;
  const writer = new PgAuditWriter({ db: d, clock: c, stream: STREAM });
  const queue = new DurableDeferredAuditQueue({
    db: d,
    writer,
    clock: c,
    tenants: [TENANT_ID],
    logger,
    metrics,
    independent: opts.independent ?? null,
    ...(opts.maxInlineDrain !== undefined ? { maxInlineDrain: opts.maxInlineDrain } : {}),
    ...(opts.health !== undefined ? { health: opts.health } : {}),
  });
  return { queue, records, metrics };
}

async function chain(): Promise<AuditEvent[]> {
  const r = await db.tx((tx) => tx.query<{ event: AuditEvent }>("select event from audit_outbox where source_stream = $1 order by sequence", [STREAM]), { role: "owner" });
  return r.rows.map((x) => x.event);
}

async function deferrals(): Promise<{ deferral_id: string; status: string; journal: string; action: string; recorded_event_id: string | null; marker_event_id: string | null }[]> {
  return (await db.tx((tx) => tx.query<{ deferral_id: string; status: string; journal: string; action: string; recorded_event_id: string | null; marker_event_id: string | null }>("select deferral_id, status, journal, action, recorded_event_id, marker_event_id from audit_deferred order by deferred_at, journal_seq"), { role: "owner" })).rows;
}

describe("DurableDeferredAuditQueue", () => {
  it("[FO-01-19][OPS-01] appends at once when the audit store is writable and resolves the route's open intent in the same transaction", async () => {
    const intents = new PgRouteAuditIntents({ db, clock });
    const opened = await intents.open({ tenantId: TENANT_ID, routeKind: "HUMAN_TRANSFER", correlationId: "hnd_synthHandoffIntent0001", callId: "call_synthCallPrimary0001" });
    expect(opened.created).toBe(true);
    expect((await intents.open({ tenantId: TENANT_ID, routeKind: "HUMAN_TRANSFER", correlationId: "hnd_synthHandoffIntent0001", callId: "call_synthCallPrimary0001" })).intentId).toBe(opened.intentId);
    const { queue } = compose();
    const r = await queue.appendOrDefer(route("handoff.requested", "hnd_synthHandoffIntent0001"));
    expect(r).toMatchObject({ written: true, deferred: false, journal: null });
    const intent = await db.tx((tx) => tx.query<{ status: string; resolved_event_id: string }>("select status, resolved_event_id from route_audit_intents"), { role: "owner" });
    expect(intent.rows[0]).toEqual({ status: "RECORDED", resolved_event_id: r.eventId });
  });

  it("[FO-01-19][FO-15-45][OPS-01][SAFE-03] during an audit outage route evidence is journaled durably; a NEW queue instance (process restart) appends it in order with a late-marker, exactly once", async () => {
    const { queue } = compose();
    await queue.appendOrDefer(route("handoff.requested", "hnd_synthHandoffBefore0001"));
    await db.exec("revoke insert on audit_outbox from app_runtime");
    const a = await queue.appendOrDefer(route("handoff.requested", "hnd_synthHandoffDuring0001"));
    clock.advanceMs(500);
    const b = await queue.appendOrDefer(route("handoff.safety_requested", "hnd_synthHandoffDuring0002"));
    expect(a).toMatchObject({ written: false, deferred: true, journal: "postgres", reasonCode: "AUDIT_STORE_UNWRITABLE" });
    expect(b).toMatchObject({ deferred: true, journal: "postgres" });
    expect((await deferrals()).map((d) => d.status)).toEqual(["PENDING", "PENDING"]);

    // The process "crashes": nothing in memory survives. A new instance flushes once the store recovers.
    await db.exec("grant insert on audit_outbox to app_runtime");
    const restarted = compose().queue;
    expect(restarted.depth).toBe(0);
    const flushed = await restarted.flush();
    expect(flushed).toMatchObject({ written: 2, dropped: 0, remaining: 0, reasonCode: null });
    const events = await chain();
    expect(events.map((e) => e.action)).toEqual([
      "handoff.requested",
      "handoff.requested",
      DEFERRED_AUDIT_MARKER_ACTION,
      "handoff.safety_requested",
      DEFERRED_AUDIT_MARKER_ACTION,
    ]);
    expect(events[1]?.correlationId).toBe("hnd_synthHandoffDuring0001");
    expect(events[2]).toMatchObject({ parentId: events[1]?.eventId, reasonCode: "AUDIT_STORE_UNWRITABLE" });
    expect(verifyChain(events, { sourceStream: STREAM, expectedSequence: 1, expectedPrevHash: null }).findings).toEqual([]);
    expect((await deferrals()).map((d) => d.status)).toEqual(["RECORDED", "RECORDED"]);
    // A second flush (or a concurrent flusher that lost the race) appends nothing again.
    expect(await compose().queue.flush()).toMatchObject({ written: 0, remaining: 0 });
    expect(await chain()).toHaveLength(5);
  });

  it("[FO-01-19][OPS-01] order is kept: while older deferrals are pending, a new event is journaled behind them, never appended ahead", async () => {
    const { queue } = compose({ maxInlineDrain: 0 });
    await db.exec("revoke insert on audit_outbox from app_runtime");
    await queue.appendOrDefer(route("handoff.requested", "hnd_synthHandoffOrder00001"));
    await db.exec("grant insert on audit_outbox to app_runtime");
    const later = await queue.appendOrDefer(route("handoff.requested", "hnd_synthHandoffOrder00002"));
    expect(later).toMatchObject({ deferred: true, reasonCode: "AUDIT_DEFERRED_QUEUE_PENDING" });
    await queue.flush();
    expect((await chain()).filter((e) => e.action === "handoff.requested").map((e) => e.correlationId)).toEqual(["hnd_synthHandoffOrder00001", "hnd_synthHandoffOrder00002"]);
  });

  it("[FO-15-45][OPS-02] when PostgreSQL itself is down the event goes to the independent journal; the drain is idempotent across a crash between insert and mark", async () => {
    const down = new DownDbFixture(db);
    const independent = new IndependentJournalFixture();
    const { queue, metrics } = compose({ db: down, independent });
    const r = await queue.appendOrDefer(route("handoff.safety_requested", "hnd_synthHandoffPgDown001"));
    expect(r).toMatchObject({ written: false, deferred: true, journal: "dynamodb" });
    expect(independent.items.size).toBe(1);
    expect(metrics.counterValue("vsp_audit_journal_entries_total", { journal: "dynamodb", result: "journaled" })).toBe(1);

    down.down = false;
    independent.failMarkOnce = true; // crash after the insert into audit_deferred, before marking it drained
    expect((await queue.flush()).reasonCode).toBe("AUDIT_JOURNAL_WRITE_FAILED");
    expect(await deferrals()).toHaveLength(1);
    const again = await queue.flush();
    expect(again).toMatchObject({ written: 1, remaining: 0 });
    expect(await deferrals()).toEqual([expect.objectContaining({ status: "RECORDED", journal: "dynamodb" })]);
    expect((await chain()).filter((e) => e.action === "handoff.safety_requested")).toHaveLength(1);
    expect([...independent.items.values()].every((i) => i.drained)).toBe(true);
  });

  const handoffOrder = async () => (await chain()).filter((e) => e.action.startsWith("handoff.")).map((e) => e.correlationId);

  it("[FO-01-19][FO-15-45][OPS-01] order across journals: an older route event held in the INDEPENDENT journal (PostgreSQL was down) is appended before a newer one once PostgreSQL is back", async () => {
    const pg = new DownDbFixture(db);
    const independent = new IndependentJournalFixture();
    const { queue } = compose({ db: pg, independent });
    expect(await queue.appendOrDefer(route("handoff.safety_requested", "hnd_synthOrderIndFirst001"))).toMatchObject({ deferred: true, journal: "dynamodb" });
    clock.advanceSeconds(5);
    pg.down = false;
    const second = await queue.appendOrDefer(route("handoff.requested", "hnd_synthOrderIndSecnd001"));
    // The older entry was drained into audit_deferred and appended first; the new event then went straight in.
    expect(second).toMatchObject({ written: true, deferred: false });
    expect(await handoffOrder()).toEqual(["hnd_synthOrderIndFirst001", "hnd_synthOrderIndSecnd001"]);
    expect(await deferrals()).toEqual([expect.objectContaining({ journal: "dynamodb", status: "RECORDED" })]);
    expect([...independent.items.values()].every((i) => i.drained)).toBe(true);
    expect(await queue.flush()).toMatchObject({ written: 0, remaining: 0 });
  });

  it("[FO-01-19][FO-15-45][OPS-01] order across journals and replicas: another replica that drains nothing inline journals the new event BEHIND the independent entry (same instant), and the flush appends both in order", async () => {
    const pg = new DownDbFixture(db);
    const independent = new IndependentJournalFixture();
    const replicaA = compose({ db: pg, independent }).queue;
    expect(await replicaA.appendOrDefer(route("handoff.safety_requested", "hnd_synthOrderRepFirst001"))).toMatchObject({ journal: "dynamodb" });
    pg.down = false; // same FakeClock instant: deferral time ties, journal order decides
    const replicaB = compose({ independent, maxInlineDrain: 0 }).queue;
    const second = await replicaB.appendOrDefer(route("handoff.requested", "hnd_synthOrderRepSecnd001"));
    expect(second).toMatchObject({ written: false, deferred: true, journal: "postgres", reasonCode: "AUDIT_DEFERRED_QUEUE_PENDING" });
    expect((await deferrals()).map((d) => [d.journal, d.status])).toEqual([
      ["dynamodb", "PENDING"],
      ["postgres", "PENDING"],
    ]);
    expect(await replicaB.flush()).toMatchObject({ written: 2, remaining: 0 });
    expect(await handoffOrder()).toEqual(["hnd_synthOrderRepFirst001", "hnd_synthOrderRepSecnd001"]);
  });

  it("[FO-01-19][FO-15-45][OPS-01][OPS-03] while the independent journal cannot be read, a new route event is journaled (never appended ahead of what it may hold) and nothing of the tenant flushes; once readable, both are appended in order", async () => {
    const pg = new DownDbFixture(db);
    const independent = new IndependentJournalFixture();
    const { queue, records, metrics } = compose({ db: pg, independent });
    await queue.appendOrDefer(route("handoff.safety_requested", "hnd_synthOrderUnrFirst001"));
    clock.advanceSeconds(2);
    pg.down = false;
    independent.readDown = true;
    const second = await queue.appendOrDefer(route("handoff.requested", "hnd_synthOrderUnrSecnd001"));
    expect(second).toMatchObject({ written: false, deferred: true, journal: "postgres", reasonCode: "AUDIT_JOURNAL_READ_FAILED" });
    // Nothing flushes, and what waits is still reported: the row in audit_deferred, and the unreadable independent
    // journal at its last known count (never 0 while it cannot be read).
    expect(await queue.flush()).toMatchObject({ written: 0, remaining: 2, reasonCode: "AUDIT_JOURNAL_READ_FAILED" });
    expect(queue.depth).toBe(2);
    expect(metrics.gaugeValue("vsp_audit_journal_pending", { journal: "postgres" })).toBe(1);
    expect(metrics.gaugeValue("vsp_audit_journal_pending", { journal: "dynamodb" })).toBe(1);
    expect(await chain()).toEqual([]);
    independent.readDown = false;
    expect(await queue.flush()).toMatchObject({ written: 2, remaining: 0 });
    expect(await handoffOrder()).toEqual(["hnd_synthOrderUnrFirst001", "hnd_synthOrderUnrSecnd001"]);
    expect(records.some((r) => r.event === "audit.journal.deferred" && r.fields.reasonCode === "AUDIT_JOURNAL_READ_FAILED")).toBe(true);
  });

  it("[FO-22-08][FO-15-45][OPS-01] appendOrDeferIn keeps order across journals: with an entry still in the independent journal, or its read failing, the event is journaled behind it in the caller's transaction", async () => {
    const pg = new DownDbFixture(db);
    const independent = new IndependentJournalFixture();
    const { queue } = compose({ db: pg, independent });
    const inTx = (correlationId: string) => db.tx((tx) => queue.appendOrDeferIn(tx, route("handoff.safety_requested", correlationId)), { role: "app_runtime", rls: { tenantId: TENANT_ID } });
    await queue.appendOrDefer(route("handoff.safety_requested", "hnd_synthOrderTxFirst0001"));
    clock.advanceSeconds(2);
    pg.down = false;
    // Nothing PENDING in audit_deferred, but the independent journal still holds the older event.
    expect(await inTx("hnd_synthOrderTxSecnd0001")).toMatchObject({ written: false, deferred: true, journal: "postgres", reasonCode: "AUDIT_DEFERRED_QUEUE_PENDING" });
    expect(await queue.flush()).toMatchObject({ written: 2, remaining: 0 });
    // Again an older event in the independent journal, and now its read fails.
    pg.down = true;
    clock.advanceSeconds(2);
    await queue.appendOrDefer(route("handoff.safety_requested", "hnd_synthOrderTxThird0001"));
    clock.advanceSeconds(2);
    pg.down = false;
    independent.readDown = true;
    expect(await inTx("hnd_synthOrderTxFourt0001")).toMatchObject({ deferred: true, journal: "postgres", reasonCode: "AUDIT_JOURNAL_READ_FAILED" });
    independent.readDown = false;
    expect(await queue.flush()).toMatchObject({ written: 2, remaining: 0 });
    expect(await handoffOrder()).toEqual(["hnd_synthOrderTxFirst0001", "hnd_synthOrderTxSecnd0001", "hnd_synthOrderTxThird0001", "hnd_synthOrderTxFourt0001"]);
  });

  it("[FO-15-45][OPS-01] an event held only in memory (both journals refused it) is not overtaken: appendOrDefer and appendOrDeferIn journal the next ones behind it", async () => {
    const pg = new DownDbFixture(db);
    const independent = new IndependentJournalFixture();
    independent.down = true;
    const { queue } = compose({ db: pg, independent, maxInlineDrain: 0 });
    expect(await queue.appendOrDefer(route("handoff.safety_requested", "hnd_synthOrderMemFirst001"))).toMatchObject({ journal: "memory" });
    clock.advanceSeconds(2);
    pg.down = false;
    independent.down = false;
    expect(await db.tx((tx) => queue.appendOrDeferIn(tx, route("handoff.requested", "hnd_synthOrderMemSecnd001")), { role: "app_runtime", rls: { tenantId: TENANT_ID } })).toMatchObject({
      deferred: true,
      journal: "postgres",
      reasonCode: "AUDIT_DEFERRED_QUEUE_PENDING",
    });
    clock.advanceSeconds(2);
    expect(await queue.appendOrDefer(route("handoff.requested", "hnd_synthOrderMemThird001"))).toMatchObject({ deferred: true, journal: "postgres", reasonCode: "AUDIT_DEFERRED_QUEUE_PENDING" });
    expect(queue.memoryDepth).toBe(0); // moved into audit_deferred before the new event was journaled
    expect(await queue.flush()).toMatchObject({ written: 3, remaining: 0 });
    expect(await handoffOrder()).toEqual(["hnd_synthOrderMemFirst001", "hnd_synthOrderMemSecnd001", "hnd_synthOrderMemThird001"]);
  });

  it("[FO-15-45][OPS-01] an older event held ONLY in memory (nothing pending in either durable journal) is not overtaken by the next appendOrDefer: journaled behind it without inline drain, appended after it with inline drain", async () => {
    const pg = new DownDbFixture(db);
    const independent = new IndependentJournalFixture();
    const both = (down: boolean) => {
      pg.down = down;
      independent.down = down;
    };
    // Without inline drain: the memory entry is moved into audit_deferred and the new event journaled behind it.
    const noInline = compose({ db: pg, independent, maxInlineDrain: 0 }).queue;
    both(true);
    expect(await noInline.appendOrDefer(route("handoff.safety_requested", "hnd_synthOrderMemOnly0001"))).toMatchObject({ journal: "memory" });
    clock.advanceSeconds(2);
    both(false);
    expect(await noInline.appendOrDefer(route("handoff.requested", "hnd_synthOrderMemOnly0002"))).toMatchObject({ written: false, deferred: true, journal: "postgres", reasonCode: "AUDIT_DEFERRED_QUEUE_PENDING" });
    expect(noInline.memoryDepth).toBe(0);
    expect((await deferrals()).map((d) => d.status)).toEqual(["PENDING", "PENDING"]);
    expect(await noInline.flush()).toMatchObject({ written: 2, remaining: 0 });
    // With inline drain (default): the memory entry is appended first, then the new event goes straight in.
    const inline = compose({ db: pg, independent }).queue;
    both(true);
    clock.advanceSeconds(2);
    expect(await inline.appendOrDefer(route("handoff.safety_requested", "hnd_synthOrderMemOnly0003"))).toMatchObject({ journal: "memory" });
    clock.advanceSeconds(2);
    both(false);
    expect(await inline.appendOrDefer(route("handoff.requested", "hnd_synthOrderMemOnly0004"))).toMatchObject({ written: true, deferred: false });
    expect(inline.memoryDepth).toBe(0);
    expect(await handoffOrder()).toEqual(["hnd_synthOrderMemOnly0001", "hnd_synthOrderMemOnly0002", "hnd_synthOrderMemOnly0003", "hnd_synthOrderMemOnly0004"]);
  });

  it("[FO-15-45][OPS-01][OPS-03] a tampered item in the independent journal is quarantined with a chain record, never appended and never blocking the tenant; until the record can be written it waits, and older valid entries keep their order", async () => {
    const pg = new DownDbFixture(db);
    const independent = new IndependentJournalFixture();
    const { queue, records, metrics } = compose({ db: pg, independent });
    const first = await queue.appendOrDefer(route("handoff.safety_requested", "hnd_synthTamperFirst00001"));
    clock.advanceSeconds(1);
    const second = await queue.appendOrDefer(route("handoff.safety_requested", "hnd_synthTamperSecnd00001"));
    expect([first.journal, second.journal]).toEqual(["dynamodb", "dynamodb"]);
    // Insider or corruption: the second item's stored input no longer matches its digest.
    const key = independent.tamper(second.deferralId ?? "", { action: "handoff.requested" });
    clock.advanceSeconds(1);
    pg.down = false;

    // The audit store refuses: the quarantine cannot be evidenced yet, so the item stays and the new event waits.
    await db.exec("revoke insert on audit_outbox from app_runtime");
    const third = await queue.appendOrDefer(route("handoff.requested", "hnd_synthTamperThird00001"));
    expect(third).toMatchObject({ written: false, deferred: true, journal: "postgres" });
    expect(independent.items.get(key)?.quarantined).toBeNull();
    expect(await chain()).toEqual([]);

    await db.exec("grant insert on audit_outbox to app_runtime");
    expect(await queue.flush()).toMatchObject({ written: 2, dropped: 1, remaining: 0, reasonCode: null });
    const events = await chain();
    const [record, ...rest] = events;
    expect(record).toMatchObject({
      action: JOURNAL_ENTRY_QUARANTINED_ACTION,
      outcome: "FAILED",
      reasonCode: "AUDIT_JOURNAL_ENTRY_DIGEST_MISMATCH",
      dataClass: "SECURITY_AUDIT",
      evidencePointers: [`kv://route-audit-journal/${sha256Hex(key)}`],
    });
    expect(independent.items.get(key)?.quarantined).toMatchObject({ recordEventId: record?.eventId, reasonCode: "AUDIT_JOURNAL_ENTRY_DIGEST_MISMATCH" });
    expect(rest.filter((e) => e.action.startsWith("handoff.")).map((e) => e.correlationId)).toEqual(["hnd_synthTamperFirst00001", "hnd_synthTamperThird00001"]);
    expect(events.some((e) => e.correlationId === "hnd_synthTamperSecnd00001")).toBe(false);
    expect(verifyChain(events, { sourceStream: STREAM, expectedSequence: 1, expectedPrevHash: null }).findings).toEqual([]);

    // Nothing waits any more: the next route event goes straight in, and a further flush quarantines nothing again.
    expect(await queue.appendOrDefer(route("handoff.requested", "hnd_synthTamperFourt00001"))).toMatchObject({ written: true });
    expect(await queue.flush()).toMatchObject({ written: 0, dropped: 0, remaining: 0 });
    expect((await chain()).filter((e) => e.action === JOURNAL_ENTRY_QUARANTINED_ACTION)).toHaveLength(1);
    expect(metrics.counterValue("vsp_audit_journal_entries_total", { journal: "dynamodb", result: "dropped" })).toBe(1);
    expect(records.some((r) => r.level === "error" && r.event === "audit.journal.quarantined" && r.fields.reasonCode === "AUDIT_JOURNAL_ENTRY_DIGEST_MISMATCH")).toBe(true);
    expect(JSON.stringify(records)).not.toContain(key);
  });

  it("[FO-15-45][OPS-01] appendOrDeferIn journals behind a tampered independent item until a flush has quarantined it", async () => {
    const pg = new DownDbFixture(db);
    const independent = new IndependentJournalFixture();
    const { queue } = compose({ db: pg, independent });
    const held = await queue.appendOrDefer(route("handoff.safety_requested", "hnd_synthTamperInTx00001"));
    independent.tamper(held.deferralId ?? "", { reasonCode: "OTHER_CODE" });
    pg.down = false;
    const inTx = (correlationId: string) => db.tx((tx) => queue.appendOrDeferIn(tx, route("handoff.safety_requested", correlationId)), { role: "app_runtime", rls: { tenantId: TENANT_ID } });
    expect(await inTx("hnd_synthTamperInTx00002")).toMatchObject({ deferred: true, journal: "postgres", reasonCode: "AUDIT_DEFERRED_QUEUE_PENDING" });
    expect(await queue.flush()).toMatchObject({ written: 1, dropped: 1, remaining: 0 });
    expect(await inTx("hnd_synthTamperInTx00003")).toMatchObject({ written: true });
  });

  /** An insider's well-formed item (input digest recomputed: it is unkeyed) stored under its own sort key `<deferredAt>#<deferralId>`. */
  const forgedEntry = (correlationId: string, deferredAt: string, change: Partial<AuditEventInput> = {}): JournalEntry =>
    journalEntryFor({ ...route("handoff.requested", correlationId), ...change }, STREAM, "AUDIT_STORE_UNWRITABLE", deferredAt);
  const keyOf = (e: JournalEntry) => `${e.deferredAt}#${e.deferralId}`;

  it("[FO-15-45][OPS-01][OPS-03] a forged independent item whose times JavaScript parses but PostgreSQL cannot store (deferredAt '2026', occurredAt in year 0000; digest recomputed) is quarantined with a chain record, never blocking the tenant: the honest entry is appended in order", async () => {
    const pg = new DownDbFixture(db);
    const independent = new IndependentJournalFixture();
    const { queue, records } = compose({ db: pg, independent });
    expect(await queue.appendOrDefer(route("handoff.safety_requested", "hnd_synthForgedHonest0001"))).toMatchObject({ journal: "dynamodb" });
    const year = forgedEntry("hnd_synthForgedYearOnly01", "2026");
    const ancient = forgedEntry("hnd_synthForgedAncient001", "2026-10-19T09:59:59.000Z", { occurredAt: "0000-01-01T00:00:00Z" });
    for (const forged of [year, ancient]) await independent.put(forged);
    expect(Date.parse(year.deferredAt)).not.toBeNaN(); // what the earlier check accepted
    expect(() => parseJournalEntry(structuredClone(year))).toThrow("AUDIT_JOURNAL_ENTRY_INVALID");
    expect(() => parseJournalEntry(structuredClone(ancient))).toThrow("AUDIT_EVENT_INVALID");
    pg.down = false;
    // Both forged keys sort before the honest one ("2026#" < "2026-"; 09:59:59 < 10:00:00) and take the first read slots.
    expect(await queue.flush()).toEqual({ written: 1, dropped: 2, remaining: 0, reasonCode: null });
    const events = await chain();
    const quarantines = events.filter((e) => e.action === JOURNAL_ENTRY_QUARANTINED_ACTION);
    expect(quarantines.map((e) => [e.reasonCode, e.evidencePointers])).toEqual([
      ["AUDIT_JOURNAL_ENTRY_INVALID", [`kv://route-audit-journal/${sha256Hex(keyOf(year))}`]],
      ["AUDIT_JOURNAL_ENTRY_INVALID", [`kv://route-audit-journal/${sha256Hex(keyOf(ancient))}`]],
    ]);
    expect(await handoffOrder()).toEqual(["hnd_synthForgedHonest0001"]);
    expect(events.some((e) => e.correlationId === year.input.correlationId || e.correlationId === ancient.input.correlationId)).toBe(false);
    for (const forged of [year, ancient]) expect(independent.items.get(keyOf(forged))?.quarantined).toMatchObject({ reasonCode: "AUDIT_JOURNAL_ENTRY_INVALID" });
    expect(verifyChain(events, { sourceStream: STREAM, expectedSequence: 1, expectedPrevHash: null }).findings).toEqual([]);
    // Nothing holds the tenant any more: the next route event goes straight in, and the flushes quarantine nothing again.
    expect(await queue.appendOrDefer(route("handoff.requested", "hnd_synthForgedNext00001"))).toMatchObject({ written: true });
    expect(await queue.flush()).toEqual({ written: 0, dropped: 0, remaining: 0, reasonCode: null });
    expect(JSON.stringify(records)).not.toContain(keyOf(year));
    // An honest caller's event in year 0000 is refused at once (it could never be appended), not deferred behind others.
    await expect(queue.appendOrDefer({ ...route("handoff.requested", "hnd_synthForgedCaller001"), occurredAt: "0000-01-01T00:00:00Z" })).rejects.toThrow("AUDIT_EVENT_INVALID");
  });

  it("[FO-15-45][OPS-01] deferral times are canonical: only the exact toISOString form of an instant from 1970 to 9999 is accepted, and a sort key yields its time only when it starts with one", () => {
    for (const ok of ["2026-10-19T10:00:00.000Z", "1970-01-01T00:00:00.000Z", "9999-12-31T23:59:59.999Z"]) expect(isCanonicalDeferralTime(ok), ok).toBe(true);
    for (const bad of ["2026", "2026-10-19", "2026-10-19T10:00:00Z", "2026-10-19T10:00:00.000+00:00", "2026-10-19T12:00:00.000+02:00", "+002026-10-19T10:00:00.000Z", "1969-12-31T23:59:59.999Z", "2026-02-30T00:00:00.000Z", "2026-10-19t10:00:00.000z", null, 1792404000000]) {
      expect(isCanonicalDeferralTime(bad), String(bad)).toBe(false);
    }
    expect(deferralTimeOfSortKey("2026-10-19T10:00:00.000Z#dfr_synthDeferralKey0001")).toBe(Date.parse("2026-10-19T10:00:00.000Z"));
    for (const key of ["2026#dfr_synthDeferralKey0001", "2026-10-19T10:00:00.000Zdfr_synthDeferralKey01", "zzzz", 7]) expect(deferralTimeOfSortKey(key), String(key)).toBeNull();
  });

  it("[FO-15-45][OPS-01][OPS-03] an independent item that validates but whose content PostgreSQL refuses when it is drained (a CHECK violation) is quarantined instead of failing every pass; while its record cannot be written it waits, and the honest entries keep their order", async () => {
    const pg = new DownDbFixture(db);
    const independent = new IndependentJournalFixture();
    const { queue } = compose({ db: pg, independent });
    const refusedId = "hnd_synthRefusedContent01";
    for (const id of ["hnd_synthRefusedOlder0001", refusedId, "hnd_synthRefusedNewer0001"]) {
      expect(await queue.appendOrDefer(route("handoff.safety_requested", id))).toMatchObject({ journal: "dynamodb" });
      clock.advanceSeconds(1);
    }
    pg.down = false;
    // A real PostgreSQL CHECK constraint stands in for any content the database refuses (SQLSTATE 23514).
    await db.exec(`alter table audit_deferred add constraint vsp_unit_refuse_content check (correlation_id <> '${refusedId}')`);
    const [, refused] = [...independent.items.keys()].sort();
    await db.exec("revoke insert on audit_outbox from app_runtime");
    // The quarantine record cannot be written yet: the drain stops at the refused item (the older entry is already in
    // audit_deferred, the refused and the newer one still wait in the independent journal); nothing is appended or lost.
    expect(await queue.flush()).toMatchObject({ written: 0, dropped: 0, remaining: 3, reasonCode: "AUDIT_STORE_UNWRITABLE" });
    expect(independent.items.get(refused ?? "")?.quarantined).toBeNull();
    await db.exec("grant insert on audit_outbox to app_runtime");
    expect(await queue.flush()).toEqual({ written: 2, dropped: 1, remaining: 0, reasonCode: null });
    expect(await handoffOrder()).toEqual(["hnd_synthRefusedOlder0001", "hnd_synthRefusedNewer0001"]);
    const [record] = (await chain()).filter((e) => e.action === JOURNAL_ENTRY_QUARANTINED_ACTION);
    expect(record).toMatchObject({ reasonCode: "AUDIT_JOURNAL_ENTRY_INVALID", evidencePointers: [`kv://route-audit-journal/${sha256Hex(refused ?? "")}`] });
    expect(independent.items.get(refused ?? "")?.quarantined).toMatchObject({ recordEventId: record?.eventId });
    expect((await deferrals()).map((d) => d.status)).toEqual(["RECORDED", "RECORDED"]);
  });

  it("[FO-15-45][OPS-01] a drain PostgreSQL refuses for any reason other than content (the runtime role lost its insert privilege on audit_deferred, SQLSTATE 42501) quarantines nothing: the honest entry waits and is appended once the privilege is back", async () => {
    const pg = new DownDbFixture(db);
    const independent = new IndependentJournalFixture();
    const { queue } = compose({ db: pg, independent });
    expect(await queue.appendOrDefer(route("handoff.safety_requested", "hnd_synthPrivilegeLost001"))).toMatchObject({ journal: "dynamodb" });
    pg.down = false;
    await db.exec("revoke insert on audit_deferred from app_runtime");
    expect(await queue.flush()).toMatchObject({ written: 0, dropped: 0, remaining: 1 });
    expect([...independent.items.values()].map((i) => [i.drained, i.quarantined])).toEqual([[false, null]]);
    expect(await chain()).toEqual([]);
    await db.exec("grant insert on audit_deferred to app_runtime");
    expect(await queue.flush()).toEqual({ written: 1, dropped: 0, remaining: 0, reasonCode: null });
    expect(await handoffOrder()).toEqual(["hnd_synthPrivilegeLost001"]);
  });

  it("[FO-15-48][FO-15-45][OPS-03] while AuditHealth reports the audit store unwritable a flush appends nothing but still recounts every store: a restarted process reports the deferrals another queue left, and keeps a store's last known count while it cannot be counted", async () => {
    const pg = new DownDbFixture(db);
    pg.down = false;
    const independent = new IndependentJournalFixture();
    await db.exec("revoke insert on audit_outbox from app_runtime");
    const deferring = compose({ db: pg, independent }).queue;
    for (const id of ["hnd_synthHealthPgHeld0001", "hnd_synthHealthPgHeld0002"]) expect(await deferring.appendOrDefer(route("handoff.safety_requested", id))).toMatchObject({ journal: "postgres" });
    pg.down = true;
    expect(await deferring.appendOrDefer(route("handoff.safety_requested", "hnd_synthHealthDynHeld001"))).toMatchObject({ journal: "dynamodb" });
    pg.down = false;
    // The production health check: its write probe fails while the runtime role cannot insert into the audit outbox.
    const health = new PgAuditHealth({ db, clock, policy: { maxBacklog: 10_000, maxBacklogAgeSeconds: 86_400 }, probeId: "gateway.journal-health" });
    expect((await health.status()).reasonCode).toBe("AUDIT_STORE_UNWRITABLE");
    const restarted = compose({ db: pg, independent, health });
    expect(restarted.queue.depth).toBe(0);
    const gauges = (m: InMemoryMetrics) => ({
      depth: m.gaugeValue("vsp_audit_deferred_depth"),
      postgres: m.gaugeValue("vsp_audit_journal_pending", { journal: "postgres" }),
      dynamodb: m.gaugeValue("vsp_audit_journal_pending", { journal: "dynamodb" }),
    });
    expect(await restarted.queue.flush()).toEqual({ written: 0, dropped: 0, remaining: 3, reasonCode: "AUDIT_STORE_UNWRITABLE" });
    expect(restarted.queue.depth).toBe(3);
    expect(gauges(restarted.metrics)).toEqual({ depth: 3, postgres: 2, dynamodb: 1 });
    // PostgreSQL becomes unreachable as well: its last known count is kept, the independent journal is still counted.
    pg.down = true;
    expect(await restarted.queue.flush()).toMatchObject({ written: 0, remaining: 3, reasonCode: "AUDIT_STORE_UNWRITABLE" });
    expect(gauges(restarted.metrics)).toEqual({ depth: 3, postgres: 2, dynamodb: 1 });
    pg.down = false;
    // A health check that cannot answer is treated as unwritable, and counts the same.
    const silent = { status: () => Promise.reject(new Error("probe failed")), assertCanAcceptConsequential: () => Promise.reject(new AuditUnavailableError("AUDIT_STORE_UNWRITABLE")) };
    const other = compose({ db: pg, independent, health: silent });
    expect(await other.queue.flush()).toEqual({ written: 0, dropped: 0, remaining: 3, reasonCode: "AUDIT_STORE_UNWRITABLE" });
    expect(gauges(other.metrics)).toEqual({ depth: 3, postgres: 2, dynamodb: 1 });
    expect(await chain()).toEqual([]);
    // Once the store accepts again, everything is appended in order and the counts return to 0.
    await db.exec("grant insert on audit_outbox to app_runtime");
    expect(await restarted.queue.flush()).toEqual({ written: 3, dropped: 0, remaining: 0, reasonCode: null });
    expect(gauges(restarted.metrics)).toEqual({ depth: 0, postgres: 0, dynamodb: 0 });
    expect(await handoffOrder()).toEqual(["hnd_synthHealthPgHeld0001", "hnd_synthHealthPgHeld0002", "hnd_synthHealthDynHeld001"]);
  });

  it("[FO-01-19][FO-15-45][OPS-01] clock skew across replicas: an event journaled behind the independent journal is timed after its NEWEST pending item (another replica's clock is 3 ms ahead), not only after the oldest one read, in appendOrDeferIn and after appendOrDefer's bounded inline drain", async () => {
    const pg = new DownDbFixture(db);
    const independent = new IndependentJournalFixture();
    const ahead = new FakeClock("2026-10-19T10:00:00.000Z");
    const replicaA = compose({ db: pg, independent, clock: ahead }).queue;
    /** Replica A (clock 3 ms ahead of the others by the third event) defers three route events into the independent journal. */
    const skewedEntries = async (prefix: string): Promise<string[]> => {
      pg.down = true;
      const ids = [`${prefix}Oldest0001`, `${prefix}Middle0001`, `${prefix}Newest0001`];
      for (const [i, id] of ids.entries()) {
        if (i === 2) ahead.advanceMs(3);
        expect(await replicaA.appendOrDefer({ ...route("handoff.safety_requested", id), occurredAt: ahead.now().toISOString() })).toMatchObject({ journal: "dynamodb" });
        if (i < 2) for (const c of [clock, ahead]) c.advanceSeconds(5);
      }
      pg.down = false;
      return ids;
    };
    // appendOrDeferIn on replica B (its caller's transaction): journaled behind, timed after the newest item.
    const first = await skewedEntries("hnd_synthSkewTx");
    const replicaB = compose({ independent }).queue;
    expect(await inTxOf(replicaB, "handoff.requested", "hnd_synthSkewBehindTx001")).toMatchObject({ deferred: true, journal: "postgres", reasonCode: "AUDIT_DEFERRED_QUEUE_PENDING" });
    expect(await replicaB.flush()).toMatchObject({ written: 4, remaining: 0, reasonCode: null });
    expect(await handoffOrder()).toEqual([...first, "hnd_synthSkewBehindTx001"]);
    // appendOrDefer on replica C, which drains one item inline (the oldest) and journals behind the rest.
    for (const c of [clock, ahead]) c.advanceSeconds(60);
    const second = await skewedEntries("hnd_synthSkewIn");
    const replicaC = compose({ independent, maxInlineDrain: 1 }).queue;
    expect(await replicaC.appendOrDefer(route("handoff.requested", "hnd_synthSkewBehindIn001"))).toMatchObject({ written: false, deferred: true, journal: "postgres", reasonCode: "AUDIT_DEFERRED_QUEUE_PENDING" });
    expect(await replicaC.flush()).toMatchObject({ written: 3, remaining: 0, reasonCode: null });
    expect(await handoffOrder()).toEqual([...first, "hnd_synthSkewBehindTx001", ...second, "hnd_synthSkewBehindIn001"]);
  });

  const inTxOf = (queue: DurableDeferredAuditQueue, action: string, correlationId: string) =>
    db.tx((tx) => queue.appendOrDeferIn(tx, route(action, correlationId)), { role: "app_runtime", rls: { tenantId: TENANT_ID } });

  it("[FO-01-19][FO-15-45][OPS-01] a bounded flush never overtakes independent entries it has not read: a tampered item takes a read slot, so a newer audit_deferred row waits until the older entries are appended", async () => {
    const pg = new DownDbFixture(db);
    const independent = new IndependentJournalFixture();
    const { queue } = compose({ db: pg, independent });
    const tampered = await queue.appendOrDefer(route("handoff.safety_requested", "hnd_synthBoundTamper0001"));
    clock.advanceSeconds(1);
    await queue.appendOrDefer(route("handoff.safety_requested", "hnd_synthBoundOlder00002"));
    clock.advanceSeconds(1);
    await queue.appendOrDefer(route("handoff.safety_requested", "hnd_synthBoundOlder00003"));
    expect(independent.items.size).toBe(3);
    independent.tamper(tampered.deferralId ?? "", { action: "handoff.requested" });
    clock.advanceSeconds(1);
    pg.down = false;
    expect(await inTxOf(queue, "handoff.requested", "hnd_synthBoundNewer00004")).toMatchObject({ deferred: true, journal: "postgres", reasonCode: "AUDIT_DEFERRED_QUEUE_PENDING" });
    // flush(2) reads two items, the tampered one and 00002: it quarantines the first, appends 00002 and HOLDS 00004,
    // because 00003 still waits unread in the independent journal.
    expect(await queue.flush(2)).toMatchObject({ written: 1, dropped: 1, remaining: 2, reasonCode: null });
    expect(await handoffOrder()).toEqual(["hnd_synthBoundOlder00002"]);
    expect(await queue.flush(2)).toMatchObject({ written: 2, dropped: 0, remaining: 0, reasonCode: null });
    expect(await handoffOrder()).toEqual(["hnd_synthBoundOlder00002", "hnd_synthBoundOlder00003", "hnd_synthBoundNewer00004"]);
    expect((await chain()).filter((e) => e.action === JOURNAL_ENTRY_QUARANTINED_ACTION)).toHaveLength(1);
  });

  it("[FO-01-19][FO-15-45][OPS-01] the inline drain is bounded the same way: with more independent items than maxInlineDrain (one tampered), appendOrDefer appends only what it read and journals the new event behind the rest", async () => {
    const pg = new DownDbFixture(db);
    const independent = new IndependentJournalFixture();
    const { queue } = compose({ db: pg, independent, maxInlineDrain: 3 });
    const older = ["hnd_synthInlineTamper001", "hnd_synthInlineOlder0002", "hnd_synthInlineOlder0003", "hnd_synthInlineOlder0004", "hnd_synthInlineOlder0005"];
    const held: (string | null)[] = [];
    for (const id of older) {
      held.push((await queue.appendOrDefer(route("handoff.safety_requested", id))).deferralId ?? null);
      clock.advanceSeconds(1);
    }
    independent.tamper(held[0] ?? "", { action: "handoff.requested" });
    pg.down = false;
    expect(await inTxOf(queue, "handoff.requested", "hnd_synthInlineNewer0006")).toMatchObject({ deferred: true, journal: "postgres" });
    clock.advanceSeconds(1);
    // The inline drain reads 3 items (the tampered one, 0002, 0003): it appends 0002 and 0003, holds 0006 (0004 and 0005
    // are unread) and journals 0007 behind everything that waits.
    expect(await queue.appendOrDefer(route("handoff.requested", "hnd_synthInlineNewer0007"))).toMatchObject({ written: false, deferred: true, journal: "postgres", reasonCode: "AUDIT_DEFERRED_QUEUE_PENDING" });
    expect(await handoffOrder()).toEqual(["hnd_synthInlineOlder0002", "hnd_synthInlineOlder0003"]);
    expect(await queue.flush()).toMatchObject({ written: 4, dropped: 0, remaining: 0, reasonCode: null });
    expect(await handoffOrder()).toEqual([...older.slice(1), "hnd_synthInlineNewer0006", "hnd_synthInlineNewer0007"]);
  });

  it("[FO-01-19][FO-15-45][OPS-01] an independent entry whose drain inserts nothing (already appended while its drained mark was lost in a crash) still takes a read slot and never lets a newer row through", async () => {
    const pg = new DownDbFixture(db);
    const independent = new IndependentJournalFixture();
    const { queue } = compose({ db: pg, independent });
    for (const id of ["hnd_synthReinsOlder00001", "hnd_synthReinsOlder00002", "hnd_synthReinsOlder00003"]) {
      await queue.appendOrDefer(route("handoff.safety_requested", id));
      clock.advanceSeconds(1);
    }
    pg.down = false;
    // Crash window: 00001 is inserted into audit_deferred but its drained mark fails; a replica that does not read the
    // independent journal then appends it, so its next read from DynamoDB inserts nothing.
    independent.failMarkOnce = true;
    expect(await queue.flush(1)).toMatchObject({ written: 0, reasonCode: "AUDIT_JOURNAL_WRITE_FAILED" });
    expect(await compose().queue.flush()).toMatchObject({ written: 1 });
    expect(await inTxOf(queue, "handoff.requested", "hnd_synthReinsNewer00004")).toMatchObject({ deferred: true, journal: "postgres", reasonCode: "AUDIT_DEFERRED_QUEUE_PENDING" });
    expect(await queue.flush(2)).toMatchObject({ written: 1, remaining: 2 });
    expect(await handoffOrder()).toEqual(["hnd_synthReinsOlder00001", "hnd_synthReinsOlder00002"]);
    expect(await queue.flush(2)).toMatchObject({ written: 2, remaining: 0 });
    expect(await handoffOrder()).toEqual(["hnd_synthReinsOlder00001", "hnd_synthReinsOlder00002", "hnd_synthReinsOlder00003", "hnd_synthReinsNewer00004"]);
  });

  it("[FO-15-48][FO-15-45][OPS-03] the pending gauges never hide held evidence: during a PostgreSQL outage the independent journal is counted (journal=dynamodb) and the last known PostgreSQL count is kept, never reported as 0", async () => {
    const pg = new DownDbFixture(db);
    pg.down = false;
    const independent = new IndependentJournalFixture();
    const { queue, metrics } = compose({ db: pg, independent });
    const gauges = (m: InMemoryMetrics = metrics) => ({
      depth: m.gaugeValue("vsp_audit_deferred_depth"),
      postgres: m.gaugeValue("vsp_audit_journal_pending", { journal: "postgres" }),
      dynamodb: m.gaugeValue("vsp_audit_journal_pending", { journal: "dynamodb" }),
      memory: m.gaugeValue("vsp_audit_journal_pending", { journal: "memory" }),
    });
    // Two route events journaled in audit_deferred during an audit outage, then PostgreSQL goes down: two more go to
    // the independent journal.
    await db.exec("revoke insert on audit_outbox from app_runtime");
    for (const id of ["hnd_synthGaugePgHeld0001", "hnd_synthGaugePgHeld0002"]) {
      expect(await queue.appendOrDefer(route("handoff.safety_requested", id))).toMatchObject({ journal: "postgres" });
      clock.advanceSeconds(1);
    }
    pg.down = true;
    for (const id of ["hnd_synthGaugeDynHeld001", "hnd_synthGaugeDynHeld002"]) {
      expect(await queue.appendOrDefer(route("handoff.safety_requested", id))).toMatchObject({ journal: "dynamodb" });
      clock.advanceSeconds(1);
    }
    expect(gauges()).toEqual({ depth: 4, postgres: 2, dynamodb: 2, memory: 0 });
    // The flush cannot reach PostgreSQL: nothing is appended and nothing is reported as gone.
    expect(await queue.flush()).toMatchObject({ written: 0, remaining: 4, reasonCode: "DB_UNAVAILABLE" });
    expect(queue.depth).toBe(4);
    expect(gauges()).toEqual({ depth: 4, postgres: 2, dynamodb: 2, memory: 0 });
    // A process restarted during the outage cannot count PostgreSQL yet: it reports no PostgreSQL value at all (never a
    // made-up 0; the reasonCode says why), and counts the independent journal.
    const restarted = compose({ db: pg, independent });
    expect(await restarted.queue.flush()).toMatchObject({ written: 0, remaining: 2, reasonCode: "DB_UNAVAILABLE" });
    expect(gauges(restarted.metrics)).toEqual({ depth: 2, postgres: undefined, dynamodb: 2, memory: 0 });
    // Recovery: everything is appended in order and every gauge returns to 0.
    pg.down = false;
    await db.exec("grant insert on audit_outbox to app_runtime");
    expect(await queue.flush()).toMatchObject({ written: 4, remaining: 0, reasonCode: null });
    expect(gauges()).toEqual({ depth: 0, postgres: 0, dynamodb: 0, memory: 0 });
    expect(await handoffOrder()).toEqual(["hnd_synthGaugePgHeld0001", "hnd_synthGaugePgHeld0002", "hnd_synthGaugeDynHeld001", "hnd_synthGaugeDynHeld002"]);
  });

  const deferralTimes = async () =>
    (await db.tx((tx) => tx.query<{ correlation_id: string; deferred_at: unknown }>("select correlation_id, deferred_at from audit_deferred order by deferred_at, (journal = 'dynamodb') desc, journal_seq"), { role: "owner" })).rows.map((r) => [
      r.correlation_id,
      new Date(r.deferred_at as string).toISOString(),
    ]);

  it("[FO-01-19][FO-15-45][OPS-01] same-instant order across replicas: an event journaled behind another replica's independent entries (deferred at one clock instant) is timed after the newest of them, not only the oldest one it read, and appended after all of them", async () => {
    const pg = new DownDbFixture(db);
    const independent = new IndependentJournalFixture();
    const replicaA = compose({ db: pg, independent }).queue;
    // Replica A defers two events into the independent journal at one clock instant; its deferral times still increase.
    expect(await replicaA.appendOrDefer(route("handoff.safety_requested", "hnd_synthTieReplicaA0001"))).toMatchObject({ journal: "dynamodb" });
    expect(await replicaA.appendOrDefer(route("handoff.safety_requested", "hnd_synthTieReplicaA0002"))).toMatchObject({ journal: "dynamodb" });
    pg.down = false;
    // Replica B, at the same instant, journals behind them in the caller's transaction (it reads the oldest entry and is
    // timed after the newest pending one).
    const replicaB = compose({ independent }).queue;
    expect(await inTxOf(replicaB, "handoff.requested", "hnd_synthTieReplicaB0003")).toMatchObject({ deferred: true, journal: "postgres", reasonCode: "AUDIT_DEFERRED_QUEUE_PENDING" });
    expect(await replicaB.flush()).toMatchObject({ written: 3, remaining: 0 });
    expect(await handoffOrder()).toEqual(["hnd_synthTieReplicaA0001", "hnd_synthTieReplicaA0002", "hnd_synthTieReplicaB0003"]);
    expect(await deferralTimes()).toEqual([
      ["hnd_synthTieReplicaA0001", "2026-10-19T10:00:00.000Z"],
      ["hnd_synthTieReplicaA0002", "2026-10-19T10:00:00.001Z"],
      ["hnd_synthTieReplicaB0003", "2026-10-19T10:00:00.002Z"],
    ]);
  });

  it("[FO-01-19][FO-15-45][OPS-01] same-instant order: an event that another replica's pending PostgreSQL deferral holds back, but that itself lands in the independent journal, is still appended after it", async () => {
    const independent = new IndependentJournalFixture();
    await db.exec("revoke insert on audit_outbox from app_runtime");
    const replicaA = compose({ independent }).queue;
    expect(await replicaA.appendOrDefer(route("handoff.safety_requested", "hnd_synthTiePgFirst00001"))).toMatchObject({ journal: "postgres", reasonCode: "AUDIT_STORE_UNWRITABLE" });
    // Replica B, same instant: it sees A's pending row, but PostgreSQL refuses B's own deferral (privilege lost).
    await db.exec("revoke insert on audit_deferred from app_runtime");
    const replicaB = compose({ independent }).queue;
    expect(await replicaB.appendOrDefer(route("handoff.requested", "hnd_synthTiePgSecnd00001"))).toMatchObject({ deferred: true, journal: "dynamodb", reasonCode: "AUDIT_DEFERRED_QUEUE_PENDING" });
    await db.exec("grant insert on audit_deferred to app_runtime");
    await db.exec("grant insert on audit_outbox to app_runtime");
    expect(await replicaA.flush()).toMatchObject({ written: 2, remaining: 0 });
    expect(await handoffOrder()).toEqual(["hnd_synthTiePgFirst00001", "hnd_synthTiePgSecnd00001"]);
    expect((await deferralTimes()).map(([, at]) => at)).toEqual(["2026-10-19T10:00:00.000Z", "2026-10-19T10:00:00.001Z"]);
  });

  it("[FO-01-19][FO-15-45][OPS-01] a PostgreSQL row deferred at the instant of the last entry a bounded pass read waits for an unread independent entry of that same instant", async () => {
    const pg = new DownDbFixture(db);
    const independent = new IndependentJournalFixture();
    const tampered = await compose({ db: pg, independent }).queue.appendOrDefer(route("handoff.safety_requested", "hnd_synthEdgeTampered001"));
    clock.advanceMs(1);
    // Two replicas defer into the independent journal at one instant (their deferral ids order them at random).
    const sameInstant = ["hnd_synthEdgeReplicaA001", "hnd_synthEdgeReplicaC001"];
    for (const id of sameInstant) expect(await compose({ db: pg, independent }).queue.appendOrDefer(route("handoff.safety_requested", id))).toMatchObject({ journal: "dynamodb" });
    independent.tamper(tampered.deferralId ?? "", { action: "handoff.requested" });
    pg.down = false;
    // A replica that cannot read the independent journal journals in PostgreSQL at that same instant.
    independent.readDown = true;
    expect(await compose({ independent }).queue.appendOrDefer(route("handoff.requested", "hnd_synthEdgeReplicaB001"))).toMatchObject({ journal: "postgres", reasonCode: "AUDIT_JOURNAL_READ_FAILED" });
    independent.readDown = false;
    const flusher = compose({ independent }).queue;
    // flush(2) reads the tampered item and ONE same-instant entry: the PostgreSQL row of that instant must wait.
    expect(await flusher.flush(2)).toMatchObject({ written: 1, dropped: 1, remaining: 2 });
    expect(await flusher.flush()).toMatchObject({ written: 2, remaining: 0 });
    const order = await handoffOrder();
    expect(order).toHaveLength(3);
    expect(order.slice(0, 2).sort()).toEqual(sameInstant);
    expect(order[2]).toBe("hnd_synthEdgeReplicaB001");
  });

  it("[FO-01-19][FO-15-45][OPS-01] a pending entry timed far ahead (a skewed replica or a forged row) cannot push a new deferral time more than 60 s past the clock", async () => {
    const { queue } = compose();
    await db.exec("revoke insert on audit_outbox from app_runtime");
    const ahead = journalEntryFor(route("handoff.safety_requested", "hnd_synthAheadForged0001"), STREAM, "AUDIT_STORE_UNWRITABLE", "2026-10-20T10:00:00.000Z");
    await db.tx((tx) => insertDeferral(tx, ahead, "postgres"), { role: "app_runtime", rls: { tenantId: TENANT_ID } });
    expect(await queue.appendOrDefer(route("handoff.requested", "hnd_synthAheadBehind0001"))).toMatchObject({ deferred: true, reasonCode: "AUDIT_DEFERRED_QUEUE_PENDING" });
    expect(await deferralTimes()).toEqual([
      ["hnd_synthAheadBehind0001", "2026-10-19T10:01:00.001Z"],
      ["hnd_synthAheadForged0001", "2026-10-20T10:00:00.000Z"],
    ]);
  });

  it("[FO-01-19][FO-15-45][OPS-01] one queue never issues a deferral time twice: an event that goes to the independent journal right after one journaled in PostgreSQL, at the same clock instant, stays behind it", async () => {
    const pg = new DownDbFixture(db);
    pg.down = false;
    const independent = new IndependentJournalFixture();
    const { queue } = compose({ db: pg, independent });
    await db.exec("revoke insert on audit_outbox from app_runtime");
    expect(await queue.appendOrDefer(route("handoff.safety_requested", "hnd_synthMonoFirst000001"))).toMatchObject({ journal: "postgres" });
    pg.down = true; // PostgreSQL becomes unreachable at the same instant: nothing pending can be seen
    expect(await queue.appendOrDefer(route("handoff.requested", "hnd_synthMonoSecnd000001"))).toMatchObject({ journal: "dynamodb", reasonCode: "DB_UNAVAILABLE" });
    pg.down = false;
    await db.exec("grant insert on audit_outbox to app_runtime");
    expect(await queue.flush()).toMatchObject({ written: 2, remaining: 0 });
    expect(await handoffOrder()).toEqual(["hnd_synthMonoFirst000001", "hnd_synthMonoSecnd000001"]);
  });

  it("[FO-15-45][OPS-03] with both journals down the event is held in memory LOUDLY; after seal it is reported lost, never silently", async () => {
    const down = new DownDbFixture(db);
    const independent = new IndependentJournalFixture();
    independent.down = true;
    const { queue, records } = compose({ db: down, independent });
    const r = await queue.appendOrDefer(route("handoff.requested", "hnd_synthHandoffMemory001"));
    expect(r).toMatchObject({ deferred: true, journal: "memory" });
    expect(queue.memoryDepth).toBe(1);
    expect(records.some((x) => x.level === "error" && x.event === "audit.journal.memory_fallback")).toBe(true);
    queue.seal();
    const lost = await queue.appendOrDefer(route("handoff.requested", "hnd_synthHandoffMemory002"));
    expect(lost).toMatchObject({ written: false, deferred: false, reasonCode: "AUDIT_DEFERRED_AFTER_SHUTDOWN" });
    expect(records.some((x) => x.level === "error" && x.event === "audit.journal.lost_at_shutdown")).toBe(true);
    // The memory entry still reaches the chain once PostgreSQL is back.
    down.down = false;
    expect(await queue.flush()).toMatchObject({ written: 1, remaining: 0 });
    expect(JSON.stringify(records)).not.toContain("ses_synthSession");
  });

  it("[FO-22-08][OPS-01] appendOrDeferIn: the deferral is written in the caller's transaction; a rollback of the caller removes both", async () => {
    const { queue } = compose();
    await db.exec("revoke insert on audit_outbox from app_runtime");
    const r = await db.tx((tx) => queue.appendOrDeferIn(tx, route("handoff.safety_requested", "hnd_synthHandoffInTx00001")), { role: "app_runtime", rls: { tenantId: TENANT_ID } });
    expect(r).toMatchObject({ deferred: true, journal: "postgres" });
    await expect(
      db.tx(
        async (tx) => {
          await queue.appendOrDeferIn(tx, route("handoff.safety_requested", "hnd_synthHandoffInTx00002"));
          throw new Error("caller failed after recording its route");
        },
        { role: "app_runtime", rls: { tenantId: TENANT_ID } },
      ),
    ).rejects.toThrow("caller failed");
    expect((await deferrals()).map((d) => d.status)).toEqual(["PENDING"]);
    await db.exec("grant insert on audit_outbox to app_runtime");
    const ok = await db.tx((tx) => queue.appendOrDeferIn(tx, route("handoff.requested", "hnd_synthHandoffInTx00003")), { role: "app_runtime", rls: { tenantId: TENANT_ID } });
    expect(ok).toMatchObject({ deferred: true, reasonCode: "AUDIT_DEFERRED_QUEUE_PENDING" }); // order: behind the pending one
  });

  it("[OPS-01][DATA-01] a journal entry that was tampered with is dropped loudly at flush, never appended", async () => {
    const { queue, records } = compose();
    await db.exec("revoke insert on audit_outbox from app_runtime");
    await queue.appendOrDefer(route("handoff.requested", "hnd_synthHandoffTamper001"));
    await db.exec("grant insert on audit_outbox to app_runtime");
    await db.exec("alter table audit_deferred disable trigger audit_deferred_guard");
    await db.exec("update audit_deferred set event_input = jsonb_set(event_input, '{reasonCode}', '\"TAMPERED_CODE\"')");
    await db.exec("alter table audit_deferred enable trigger audit_deferred_guard");
    expect(await queue.flush()).toMatchObject({ written: 0, dropped: 1 });
    expect(await deferrals()).toEqual([expect.objectContaining({ status: "DROPPED" })]);
    expect((await chain()).length).toBe(0);
    expect(records.some((x) => x.level === "error" && x.event === "audit.journal.dropped")).toBe(true);
  });

  it("[OPS-01] the journal rows are append-only: content cannot be rewritten and a terminal row cannot move", async () => {
    const { queue } = compose();
    await db.exec("revoke insert on audit_outbox from app_runtime");
    await queue.appendOrDefer(route("handoff.requested", "hnd_synthHandoffImmut0001"));
    const reason = (p: Promise<unknown>) => p.then(() => "RESOLVED", (e: Error) => e.message);
    expect(await reason(db.tx((tx) => tx.query("update audit_deferred set reason_code = 'OTHER_CODE'"), { role: "app_runtime", rls: { tenantId: TENANT_ID } }))).toMatch(/permission denied|AUDIT_DEFERRED_IMMUTABLE/);
    expect(await reason(db.tx((tx) => tx.query("delete from audit_deferred"), { role: "app_worker", rls: { tenantId: TENANT_ID } }))).toMatch(/permission denied|ROUTE_AUDIT_APPEND_ONLY/);
    expect(await reason(db.exec("update audit_deferred set action = 'handoff.other'"))).toContain("AUDIT_DEFERRED_IMMUTABLE");
  });

  it("[FO-15-41][OPS-01][SAFE-03] a deferral counts as route evidence only through the chain: it cannot be inserted recorded, nor marked recorded without its chained event and marker", async () => {
    const { queue } = compose();
    await db.exec("revoke insert on audit_outbox from app_runtime");
    await queue.appendOrDefer(route("handoff.safety_requested", "hnd_synthHandoffGuard0001"));
    await db.exec("grant insert on audit_outbox to app_runtime");
    const reason = (p: Promise<unknown>) => p.then(() => "RESOLVED", (e: Error) => e.message);
    const asRuntime = (sql: string, params: unknown[] = []) => reason(db.tx((tx) => tx.query(sql, params), { role: "app_runtime", rls: { tenantId: TENANT_ID } }));
    const [row] = await deferrals();
    const forgedId = "dfr_synthForgedDeferral0001";
    // Inserted already RECORDED (or PENDING with ids filled in): refused.
    const insert = (status: string, recorded: string | null, at: string | null) =>
      asRuntime(
        `insert into audit_deferred (deferral_id, tenant_id, source_stream, action, correlation_id, call_id, event_input, input_digest, reason_code, journal, deferred_at, status, recorded_event_id, recorded_at)
         select $1, tenant_id, source_stream, action, 'hnd_synthHandoffForged001', call_id, jsonb_set(event_input, '{correlationId}', '"hnd_synthHandoffForged001"'), input_digest, reason_code, journal, deferred_at, $2, $3, $4::timestamptz
           from audit_deferred where deferral_id = $5`,
        [forgedId, status, recorded, at, row?.deferral_id],
      );
    expect(await insert("RECORDED", "aud_synthForgedEvent000001", "2026-10-19T10:00:00.000Z")).toContain("AUDIT_DEFERRED_INVALID_START");
    expect(await insert("PENDING", "aud_synthForgedEvent000001", null)).toContain("AUDIT_DEFERRED_INVALID_START");
    // Marked RECORDED with an event id that is not the chained deferred event (and no marker): refused.
    const existing = (await db.tx((tx) => tx.query<{ event_id: string }>("select event_id from audit_outbox limit 1"), { role: "owner" })).rows[0]?.event_id ?? null;
    for (const fake of ["aud_synthForgedEvent000001", existing]) {
      expect(
        await asRuntime("update audit_deferred set status = 'RECORDED', recorded_event_id = $2, marker_event_id = $2, recorded_at = now() where deferral_id = $1", [row?.deferral_id, fake]),
      ).toContain("AUDIT_DEFERRED_EVIDENCE_MISSING");
    }
    expect((await deferrals())[0]).toMatchObject({ status: "PENDING" });
    // The production flush appends the event and its marker in the same transaction: accepted.
    expect((await queue.flush()).written).toBe(1);
    expect((await deferrals())[0]).toMatchObject({ status: "RECORDED" });
  });

  it("[FO-15-45] journal entries are validated on read: a digest that does not match the input is refused", () => {
    const e = journalEntryFor(route("handoff.requested", "hnd_synthHandoffDigest001"), STREAM, "AUDIT_STORE_UNWRITABLE", "2026-10-19T10:00:00.000Z");
    expect(parseJournalEntry(structuredClone(e))).toEqual(e);
    expect(() => parseJournalEntry({ ...e, inputDigest: "0".repeat(64) })).toThrow("AUDIT_JOURNAL_ENTRY_DIGEST_MISMATCH");
    expect(() => parseJournalEntry({ ...e, tenantId: "tnt_synthTenantOther0001" })).toThrow("AUDIT_JOURNAL_ENTRY_INVALID");
  });
});

/**
 * LOCAL TEST DOUBLE of the DynamoDB document client (one table in memory; the Query key condition, the PENDING
 * filter, ascending sort keys and the quarantine's `#s = :pending` condition applied as DynamoDB applies them).
 * The real table runs on DynamoDB Local in Layer 2 (platform/test/integration/substrate/dynamo.test.ts).
 */
class DocumentTableDouble implements JournalDocumentSender {
  items: Record<string, unknown>[] = [];
  updates: Record<string, unknown>[] = [];
  failUpdate: Error | null = null;
  async send(cmd: PutCommand | QueryCommand | UpdateCommand): Promise<unknown> {
    if (cmd instanceof QueryCommand) {
      const pk = cmd.input.ExpressionAttributeValues?.[":pk"];
      // Sort keys in byte order (DynamoDB compares UTF-8 bytes), ascending unless ScanIndexForward is false.
      const rows = this.items.filter((i) => i.pk === pk && i.status === "PENDING").sort((a, b) => (String(a.sk) < String(b.sk) ? -1 : String(a.sk) > String(b.sk) ? 1 : 0));
      if (cmd.input.ScanIndexForward === false) rows.reverse();
      return { Items: rows.map((i) => ({ ...i })) };
    }
    if (cmd instanceof UpdateCommand) {
      this.updates.push(cmd.input as Record<string, unknown>);
      if (this.failUpdate) throw this.failUpdate;
      const key = cmd.input.Key as { pk: string; sk: string };
      const item = this.items.find((x) => x.pk === key.pk && x.sk === key.sk);
      if (!item || item.status !== "PENDING") throw Object.assign(new Error("condition"), { name: "ConditionalCheckFailedException" });
      const v = cmd.input.ExpressionAttributeValues as Record<string, unknown>;
      Object.assign(item, { status: v[":quarantined"], quarantinedAt: v[":at"], quarantineReason: v[":reason"], quarantineRef: v[":ref"], quarantineEventId: v[":ev"] });
      return {};
    }
    throw new Error("unexpected command");
  }
}

describe("DynamoRouteAuditJournal item validation", () => {
  const OTHER_TENANT = "tnt_synthTenantOther0001";
  const entryAt = (correlationId: string, at: string, tenantId = TENANT_ID) =>
    journalEntryFor({ ...route("handoff.safety_requested", correlationId), tenantId }, STREAM, "DB_UNAVAILABLE", at);
  /** The item DynamoRouteAuditJournal.put writes for `e`, with optional stored changes. */
  const stored = (e: JournalEntry, change: Record<string, unknown> = {}) => ({
    pk: `raj#${TENANT_ID}`,
    sk: `${e.deferredAt}#${e.deferralId}`,
    deferralId: e.deferralId,
    tenantId: e.tenantId,
    stream: e.stream,
    input: canonicalJson(e.input),
    inputDigest: e.inputDigest,
    reasonCode: e.reasonCode,
    deferredAt: e.deferredAt,
    status: "PENDING",
    ...change,
  });

  it("[FO-15-45][OPS-01] items read back are re-validated: a tampered digest, another tenant's entry in this partition, an entry under another sort key and unparseable content are rejected (never entries), each addressed by its key only", async () => {
    const table = new DocumentTableDouble();
    const journal = new DynamoRouteAuditJournal(table, "vsp-unit-raj");
    const a = entryAt("hnd_synthItemValid000001", "2026-10-19T10:00:00.000Z");
    const b = entryAt("hnd_synthItemDigest00001", "2026-10-19T10:00:01.000Z");
    const c = entryAt("hnd_synthItemOtherTnt001", "2026-10-19T10:00:02.000Z", OTHER_TENANT);
    const d = entryAt("hnd_synthItemReKeyed0001", "2026-10-19T10:00:04.000Z");
    const e = entryAt("hnd_synthItemBadJson0001", "2026-10-19T10:00:03.000Z");
    table.items.push(
      stored(a),
      stored(b, { input: canonicalJson({ ...b.input, action: "handoff.requested" }) }),
      stored(c),
      stored(d, { sk: `2026-10-19T09:00:00.000Z#${d.deferralId}` }), // moved ahead of older entries
      stored(e, { input: "{not json" }),
    );
    const read = await journal.read(TENANT_ID, 10);
    expect(read.entries).toEqual([a]);
    const keys = [`2026-10-19T09:00:00.000Z#${d.deferralId}`, `${b.deferredAt}#${b.deferralId}`, `${c.deferredAt}#${c.deferralId}`, `${e.deferredAt}#${e.deferralId}`];
    expect(read.rejected).toEqual([
      { tenantId: TENANT_ID, key: keys[0], ref: sha256Hex(keys[0] ?? ""), reasonCode: "AUDIT_JOURNAL_ENTRY_INVALID" },
      { tenantId: TENANT_ID, key: keys[1], ref: sha256Hex(keys[1] ?? ""), reasonCode: "AUDIT_JOURNAL_ENTRY_DIGEST_MISMATCH" },
      { tenantId: TENANT_ID, key: keys[2], ref: sha256Hex(keys[2] ?? ""), reasonCode: "AUDIT_JOURNAL_ENTRY_INVALID" },
      { tenantId: TENANT_ID, key: keys[3], ref: sha256Hex(keys[3] ?? ""), reasonCode: "AUDIT_JOURNAL_ENTRY_INVALID" },
    ]);
    // The limit counts both kinds, in sort-key order; the strict reader refuses while anything is rejected.
    const two = await journal.read(TENANT_ID, 2);
    expect([two.rejected.length, two.entries.length]).toEqual([1, 1]);
    await expect(journal.pending(TENANT_ID, 10)).rejects.toThrow("AUDIT_JOURNAL_ENTRY_INVALID");
  });

  it("[FO-15-45][OPS-01] an item with a deferral time JavaScript parses but PostgreSQL cannot store ('2026', under its matching sort key, digest recomputed) or an event time in year 0000 is rejected, never an entry", async () => {
    const table = new DocumentTableDouble();
    const journal = new DynamoRouteAuditJournal(table, "vsp-unit-raj");
    const honest = entryAt("hnd_synthItemHonest00001", "2026-10-19T10:00:00.000Z");
    const year = entryAt("hnd_synthItemYearOnly001", "2026");
    const ancient = journalEntryFor({ ...route("handoff.safety_requested", "hnd_synthItemAncient0001"), occurredAt: "0000-01-01T00:00:00Z" }, STREAM, "DB_UNAVAILABLE", "2026-10-19T09:00:00.000Z");
    table.items.push(stored(honest), stored(year), stored(ancient));
    const read = await journal.read(TENANT_ID, 10);
    expect(read.entries).toEqual([honest]);
    expect(read.rejected.map((r) => [r.key, r.reasonCode])).toEqual([
      [`2026#${year.deferralId}`, "AUDIT_JOURNAL_ENTRY_INVALID"],
      [`2026-10-19T09:00:00.000Z#${ancient.deferralId}`, "AUDIT_JOURNAL_ENTRY_INVALID"],
    ]);
  });

  it("[FO-01-19][FO-15-45][OPS-01] newestPendingMs reads the partition newest first and returns the greatest PENDING sort key's canonical time, skipping non-canonical keys and items no longer pending", async () => {
    const table = new DocumentTableDouble();
    const journal = new DynamoRouteAuditJournal(table, "vsp-unit-raj");
    expect(await journal.newestPendingMs(TENANT_ID)).toBeNull();
    const [a, b, c] = ["2026-10-19T10:00:00.000Z", "2026-10-19T10:00:05.000Z", "2026-10-19T10:00:09.000Z"].map((at, i) => entryAt(`hnd_synthItemNewest0000${i}`, at));
    if (!a || !b || !c) throw new Error("entries");
    table.items.push(stored(a), stored(b), stored(c, { status: "DRAINED" }), stored(entryAt("hnd_synthItemJunkKey0001", "2026"), { sk: "zzzz#dfr_synthJunkSortKey00001" }));
    expect(await journal.newestPendingMs(TENANT_ID)).toBe(Date.parse(b.deferredAt));
    expect(await journal.newestPendingMs(OTHER_TENANT)).toBeNull();
    const query = new DynamoRouteAuditJournal({ send: () => Promise.reject(new Error("throttled")) }, "vsp-unit-raj");
    await expect(query.newestPendingMs(TENANT_ID)).rejects.toThrow("AUDIT_JOURNAL_READ_FAILED");
  });

  it("[FO-15-45][OPS-01] quarantine marks a rejected item once (only while PENDING), keeps its content, and is reason-coded on failure", async () => {
    const table = new DocumentTableDouble();
    const journal = new DynamoRouteAuditJournal(table, "vsp-unit-raj");
    const b = entryAt("hnd_synthItemQuarant0001", "2026-10-19T10:00:01.000Z");
    const tampered = canonicalJson({ ...b.input, action: "handoff.requested" });
    table.items.push(stored(b, { input: tampered }));
    const [item] = (await journal.read(TENANT_ID, 10)).rejected;
    if (!item) throw new Error("expected a rejected item");
    await journal.quarantine(item, "2026-10-19T10:01:00.000Z", "aud_synthQuarantineRec0001");
    expect(table.updates[0]).toMatchObject({ Key: { pk: `raj#${TENANT_ID}`, sk: item.key }, ConditionExpression: "#s = :pending" });
    expect(table.items[0]).toMatchObject({ status: "QUARANTINED", quarantineReason: "AUDIT_JOURNAL_ENTRY_DIGEST_MISMATCH", quarantineRef: item.ref, quarantineEventId: "aud_synthQuarantineRec0001", input: tampered });
    expect(await journal.read(TENANT_ID, 10)).toEqual({ entries: [], rejected: [] });
    await journal.quarantine(item, "2026-10-19T10:02:00.000Z", "aud_synthQuarantineRec0002"); // absorbed: no longer PENDING
    expect(table.items[0]).toMatchObject({ quarantineEventId: "aud_synthQuarantineRec0001" });
    table.failUpdate = new Error("throttled");
    await expect(journal.quarantine(item, "2026-10-19T10:03:00.000Z", "aud_synthQuarantineRec0003")).rejects.toThrow("AUDIT_JOURNAL_WRITE_FAILED");
    await expect(journal.quarantine({ ...item, ref: "not-a-digest" }, "2026-10-19T10:03:00.000Z", "aud_synthQuarantineRec0003")).rejects.toThrow("AUDIT_JOURNAL_QUARANTINE_INVALID");
  });
});
