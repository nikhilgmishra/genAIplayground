/**
 * Layer 2 (WP-04): emergency and human route evidence survives process death (FO-01-19, FO-01-34, FO-15-44,
 * FO-15-45, FO-15-48; OPS-01). A real child process (route-audit-child.ts) runs the production
 * DurableDeferredAuditQueue against postgres:16 while the audit store refuses the append, and is killed with
 * SIGKILL (crash) or SIGTERM (graceful stop). A restarted replica (new pools, new queue) then appends every
 * journaled route event exactly once with its audit.deferred.recorded marker, even with two replicas
 * flushing at the same time. When PostgreSQL itself is read-only, the independent DynamoDB journal holds the
 * event, and tenant order holds across the journals and replicas: the next route event of a restarted replica
 * goes behind it (and a replica that cannot read DynamoDB journals instead of overtaking it). An item of that
 * journal tampered with by an insider is quarantined with a chain record and never blocks the tenant (so is a
 * forged item whose times JavaScript parses but postgres:16 cannot store, and one whose content postgres:16 refuses
 * when it is drained), and a bounded flush that reads it never lets a newer row overtake entries it has not read yet;
 * during the outage the pending gauges count what the DynamoDB journal holds.
 * A detached safety route stopped before its audit append is surfaced as audit.route.not_recorded
 * by the reconciler after restart, exactly once across two concurrent reconcilers.
 */
import { join } from "node:path";
import { GetItemCommand, PutItemCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { afterAll, beforeAll, describe, expect } from "vitest";
import { buildAuditInput } from "../../../src/audit/build-input.js";
import { DEFERRED_AUDIT_MARKER_ACTION } from "../../../src/audit/deferred.js";
import { DurableDeferredAuditQueue, DynamoRouteAuditJournal, JOURNAL_ENTRY_QUARANTINED_ACTION, journalEntryFor } from "../../../src/audit/journal.js";
import type { JournalEntry } from "../../../src/audit/journal.js";
import { ROUTE_NOT_RECORDED_ACTION, RouteAuditReconciler } from "../../../src/audit/route-reconciler.js";
import { PgAuditWriter } from "../../../src/audit/writer.js";
import type { Db } from "../../../src/db/types.js";
import { InMemoryMetrics, createMetricCatalogue } from "../../../src/observability/metrics.js";
import { withSubstrateMetrics } from "../../../src/observability/catalog/substrate.js";
import type { AuditEvent } from "../../../src/protocol/index.js";
import { canonicalJson, sha256Hex } from "../../../src/shared/canonical.js";
import { FakeClock, systemClock } from "../../../src/shared/clock.js";
import { newId } from "../../../src/shared/ids.js";
import { dynamoClient, uniqueName } from "../_harness/clients.js";
import { localEnv } from "../_harness/env.js";
import { layer2, layer2Context } from "../_harness/layer2.js";
import { CHILD_DIR, killAfter } from "./contention-harness.js";
import { createJournalTable, readOnlyDatabase } from "./seams.js";
import { createAuroraLikeDb } from "./support.js";
import type { AuroraLikeDb } from "./support.js";

const it = layer2(["postgres", "dynamodb"]);
const CHILD = join(CHILD_DIR, "route-audit-child.ts");
let adb: AuroraLikeDb;

interface Journaled {
  correlationId: string;
  callId: string;
  written: boolean;
  deferred: boolean;
  journal: string | null;
  deferralId: string | null;
  reasonCode: string | null;
}

const parse = <T>(lines: string[], marker: string): T[] => lines.filter((l) => l.startsWith(`${marker} `)).map((l) => JSON.parse(l.slice(marker.length + 1)) as T);

async function auditRows(tenantId: string): Promise<AuditEvent[]> {
  const r = await adb.db.tx((tx) => tx.query<{ event: AuditEvent }>("select event from audit_outbox where tenant_id = app_tenant() order by source_stream, sequence"), { role: "app_worker", rls: { tenantId } });
  return r.rows.map((x) => x.event);
}

async function deferrals(tenantId: string): Promise<{ deferral_id: string; status: string; journal: string; recorded_event_id: string | null; marker_event_id: string | null }[]> {
  const r = await adb.db.tx(
    (tx) => tx.query<{ deferral_id: string; status: string; journal: string; recorded_event_id: string | null; marker_event_id: string | null }>("select deferral_id, status, journal, recorded_event_id, marker_event_id from audit_deferred order by journal_seq"),
    { role: "app_worker", rls: { tenantId } },
  );
  return r.rows;
}

/** A restarted replica: its own pool and queue (nothing shared with the killed process). */
function replica(db: Db, tenantId: string, independent: DynamoRouteAuditJournal | null = null): DurableDeferredAuditQueue {
  return new DurableDeferredAuditQueue({ db, writer: new PgAuditWriter({ db, clock: systemClock, stream: "gateway.route-restarted" }), clock: systemClock, tenants: [tenantId], independent });
}

const childEnv = (tenantId: string, mode: string, extra: Record<string, string> = {}) => ({ VSP_CHILD_MODE: mode, VSP_CHILD_DB_URL: adb.appUrl, VSP_CHILD_TENANT: tenantId, ...extra });

describe("route-audit evidence across process death on postgres:16", () => {
  beforeAll(async () => {
    adb = await createAuroraLikeDb(layer2Context(["postgres", "dynamodb"]));
  });
  afterAll(async () => {
    await adb?.drop();
  });

  it("[FO-01-19][FO-15-44][FO-15-45][OPS-01] SIGKILL after journaling: two restarted replicas flushing at once append each route event exactly once, with its marker", async () => {
    const tenantId = newId("tnt");
    await adb.migrator.exec("revoke insert on audit_outbox from app_runtime");
    let run: Awaited<ReturnType<typeof killAfter>>;
    try {
      run = await killAfter(CHILD, [], "READY", "SIGKILL", childEnv(tenantId, "journal", { VSP_CHILD_EVENTS: "3" }));
    } finally {
      await adb.migrator.exec("grant insert on audit_outbox to app_runtime");
    }
    expect(run.exit.signal).toBe("SIGKILL");
    const journaled = parse<Journaled>(run.lines, "JOURNALED");
    expect(journaled).toHaveLength(3);
    for (const j of journaled) expect(j).toMatchObject({ written: false, deferred: true, journal: "postgres" });
    // The first is refused by the audit store; the later ones queue behind it (tenant order is preserved).
    expect(journaled.map((j) => j.reasonCode)).toEqual(["AUDIT_STORE_UNWRITABLE", "AUDIT_DEFERRED_QUEUE_PENDING", "AUDIT_DEFERRED_QUEUE_PENDING"]);
    expect((await deferrals(tenantId)).map((d) => d.status)).toEqual(["PENDING", "PENDING", "PENDING"]);
    expect(await auditRows(tenantId)).toEqual([]);

    const [a, b] = await Promise.all([replica(adb.pool(2), tenantId).flush(), replica(adb.pool(2), tenantId).flush()]);
    const third = await replica(adb.pool(2), tenantId).flush();
    expect(a.written + b.written + third.written).toBe(3);
    expect(third.remaining).toBe(0);
    expect((await replica(adb.pool(2), tenantId).flush()).written).toBe(0);

    const events = await auditRows(tenantId);
    for (const j of journaled) {
      const routeEvents = events.filter((e) => e.correlationId === j.correlationId && e.action === "handoff.safety_requested");
      expect(routeEvents, "exactly one route event per journaled deferral").toHaveLength(1);
      const markers = events.filter((e) => e.action === DEFERRED_AUDIT_MARKER_ACTION && e.evidencePointers.includes(`deferral:${j.deferralId}`));
      expect(markers).toHaveLength(1);
      expect(markers[0]?.parentId).toBe(routeEvents[0]?.eventId);
    }
    const rows = await deferrals(tenantId);
    expect(rows.every((r) => r.status === "RECORDED" && r.recorded_event_id && r.marker_event_id)).toBe(true);
  });

  it("[FO-15-45][FO-16-41][OPS-01] SIGTERM: the replica seals and exits cleanly; its durable deferral flushes after restart", async () => {
    const tenantId = newId("tnt");
    await adb.migrator.exec("revoke insert on audit_outbox from app_runtime");
    let run: Awaited<ReturnType<typeof killAfter>>;
    try {
      run = await killAfter(CHILD, [], "READY", "SIGTERM", childEnv(tenantId, "journal"));
    } finally {
      await adb.migrator.exec("grant insert on audit_outbox to app_runtime");
    }
    expect(run.exit).toEqual({ code: 0, signal: null });
    const [j] = parse<Journaled>(run.lines, "JOURNALED");
    expect(j?.journal).toBe("postgres");
    expect((await replica(adb.pool(2), tenantId).flush()).written).toBe(1);
    expect((await auditRows(tenantId)).filter((e) => e.correlationId === j?.correlationId && e.action === "handoff.safety_requested")).toHaveLength(1);
  });

  it("[FO-15-45][FAULT:LOCAL_PERSISTENCE_FAILURE seam][OPS-01] PostgreSQL read-only: the event goes to the independent DynamoDB journal, survives SIGKILL, and is drained into PostgreSQL once", async ({ l2 }) => {
    const tenantId = newId("tnt");
    const dynamo = dynamoClient(l2);
    const table = await createJournalTable(dynamo);
    const undo = await readOnlyDatabase(l2, adb);
    let run: Awaited<ReturnType<typeof killAfter>>;
    try {
      run = await killAfter(
        CHILD,
        [],
        "READY",
        "SIGKILL",
        childEnv(tenantId, "journal", { VSP_CHILD_DYNAMO_ENDPOINT: l2.url("dynamodb", 8000), VSP_CHILD_DYNAMO_TABLE: table, VSP_CHILD_AWS_KEY: localEnv().awsAccessKeyId, VSP_CHILD_AWS_SECRET: localEnv().awsSecretAccessKey }),
      );
    } finally {
      await undo();
    }
    const [j] = parse<Journaled>(run.lines, "JOURNALED");
    expect(j).toMatchObject({ deferred: true, journal: "dynamodb" });
    const independent = DynamoRouteAuditJournal.fromClient(dynamo, table);
    expect((await independent.pending(tenantId, 10)).map((e) => e.deferralId)).toEqual([j?.deferralId]);

    const restarted = replica(adb.pool(2), tenantId, independent);
    expect((await restarted.flush()).written).toBe(1);
    expect((await restarted.flush()).written).toBe(0);
    expect(await independent.pending(tenantId, 10)).toEqual([]);
    const rows = await deferrals(tenantId);
    expect(rows).toEqual([expect.objectContaining({ deferral_id: j?.deferralId, journal: "dynamodb", status: "RECORDED" })]);
    expect((await auditRows(tenantId)).filter((e) => e.correlationId === j?.correlationId && e.action === "handoff.safety_requested")).toHaveLength(1);
  });

  it("[FO-01-19][FO-15-45][OPS-01] tenant order across journals and replicas: a route event a killed replica left in the independent DynamoDB journal (PostgreSQL read-only) is appended BEFORE the next one a restarted replica receives; a replica that cannot read that journal journals behind it instead of overtaking", async ({ l2 }) => {
    const tenantId = newId("tnt");
    const dynamo = dynamoClient(l2);
    const table = await createJournalTable(dynamo);
    const independent = DynamoRouteAuditJournal.fromClient(dynamo, table);
    const stream = "gateway.route-child"; // the child's stream: every route event of this tenant lands in one chain
    /** A replica (child process) journals one safety route event while PostgreSQL is read-only, then is killed. */
    const killedReplicaJournals = async (): Promise<Journaled> => {
      const undo = await readOnlyDatabase(l2, adb);
      let run: Awaited<ReturnType<typeof killAfter>>;
      try {
        run = await killAfter(
          CHILD,
          [],
          "READY",
          "SIGKILL",
          childEnv(tenantId, "journal", { VSP_CHILD_DYNAMO_ENDPOINT: l2.url("dynamodb", 8000), VSP_CHILD_DYNAMO_TABLE: table, VSP_CHILD_AWS_KEY: localEnv().awsAccessKeyId, VSP_CHILD_AWS_SECRET: localEnv().awsSecretAccessKey }),
        );
      } finally {
        await undo();
      }
      const [j] = parse<Journaled>(run.lines, "JOURNALED");
      if (!j) throw new Error("child journaled nothing");
      expect(j).toMatchObject({ deferred: true, journal: "dynamodb" });
      return j;
    };
    const humanRoute = () => buildAuditInput({ tenantId, correlationId: newId("hnd"), sourceComponent: "gateway", action: "handoff.requested", outcome: "PENDING", callId: newId("call") }, systemClock);
    const order = async () => (await auditRows(tenantId)).filter((e) => e.sourceStream === stream && e.action.startsWith("handoff.")).map((e) => e.correlationId);

    // A restarted replica with a writable PostgreSQL: the older event goes first, then its own goes straight in.
    const first = await killedReplicaJournals();
    const secondInput = humanRoute();
    const second = await replica(adb.pool(2), tenantId, independent).appendOrDefer(secondInput, stream);
    expect(second).toMatchObject({ written: true, deferred: false });
    expect(await order()).toEqual([first.correlationId, secondInput.correlationId]);
    expect(await independent.pending(tenantId, 10)).toEqual([]);

    // A replica whose DynamoDB reads fail (here: a table it cannot find) cannot know what waits there: it journals.
    const third = await killedReplicaJournals();
    const blind = replica(adb.pool(2), tenantId, DynamoRouteAuditJournal.fromClient(dynamo, uniqueName("vsp-it-raj-missing")));
    const fourthInput = humanRoute();
    expect(await blind.appendOrDefer(fourthInput, stream)).toMatchObject({ written: false, deferred: true, journal: "postgres", reasonCode: "AUDIT_JOURNAL_READ_FAILED" });
    expect(await blind.flush()).toMatchObject({ written: 0, reasonCode: "AUDIT_JOURNAL_READ_FAILED" });
    expect(await order()).toEqual([first.correlationId, secondInput.correlationId]);
    expect((await replica(adb.pool(2), tenantId, independent).flush()).written).toBe(2);
    expect(await order()).toEqual([first.correlationId, secondInput.correlationId, third.correlationId, fourthInput.correlationId]);
    const rows = await deferrals(tenantId);
    expect(rows.map((r) => [r.journal, r.status])).toEqual([
      ["dynamodb", "RECORDED"],
      ["postgres", "RECORDED"],
      ["dynamodb", "RECORDED"],
    ]);
  });

  it("[FO-15-45][OPS-01][OPS-03] an item of the independent DynamoDB journal tampered with by an insider is quarantined with a chain record, never appended and never blocking the tenant: it waits while the record cannot be written, the older valid entry keeps its place, and later route events go straight in", async ({ l2 }) => {
    const tenantId = newId("tnt");
    const dynamo = dynamoClient(l2);
    const table = await createJournalTable(dynamo);
    const independent = DynamoRouteAuditJournal.fromClient(dynamo, table);
    const stream = "gateway.route-tamper";
    const routeInput = (action: string) => buildAuditInput({ tenantId, correlationId: newId("hnd"), sourceComponent: "gateway", action, outcome: "PENDING", callId: newId("call") }, systemClock);

    // PostgreSQL read-only: a replica journals two safety route events in the independent DynamoDB journal.
    const firstInput = routeInput("handoff.safety_requested");
    const secondInput = routeInput("handoff.safety_requested");
    const undo = await readOnlyDatabase(l2, adb);
    let journaled: Awaited<ReturnType<DurableDeferredAuditQueue["appendOrDefer"]>>[];
    try {
      const readOnly = replica(adb.pool(1), tenantId, independent);
      journaled = [await readOnly.appendOrDefer(firstInput, stream), await readOnly.appendOrDefer(secondInput, stream)];
    } finally {
      await undo();
    }
    expect(journaled.map((j) => j.journal)).toEqual(["dynamodb", "dynamodb"]);
    const stored = (await independent.read(tenantId, 10)).entries.find((e) => e.deferralId === journaled[1]?.deferralId);
    if (!stored) throw new Error("the second deferral is not in the independent journal");
    const secondKey = `${stored.deferredAt}#${stored.deferralId}`;
    const itemKey = { pk: { S: `raj#${tenantId}` }, sk: { S: secondKey } };
    // An insider with write access to the table rewrites the second item's stored input (its digest kept).
    await dynamo.send(
      new UpdateItemCommand({
        TableName: table,
        Key: itemKey,
        UpdateExpression: "SET #i = :i",
        ExpressionAttributeNames: { "#i": "input" },
        ExpressionAttributeValues: { ":i": { S: canonicalJson({ ...secondInput, action: "handoff.requested" }) } },
      }),
    );
    const itemStatus = async () => (await dynamo.send(new GetItemCommand({ TableName: table, Key: itemKey, ConsistentRead: true }))).Item;

    // The audit store refuses: the quarantine cannot be evidenced yet, so the item stays PENDING and the next event waits.
    const thirdInput = routeInput("handoff.requested");
    await adb.migrator.exec("revoke insert on audit_outbox from app_runtime");
    try {
      expect(await replica(adb.pool(2), tenantId, independent).appendOrDefer(thirdInput, stream)).toMatchObject({ written: false, deferred: true, journal: "postgres" });
    } finally {
      await adb.migrator.exec("grant insert on audit_outbox to app_runtime");
    }
    expect((await itemStatus())?.status?.S).toBe("PENDING");
    expect(await auditRows(tenantId)).toEqual([]);

    // Once the store accepts: the quarantine record, then the valid events in order; the tampered content never.
    expect(await replica(adb.pool(2), tenantId, independent).flush()).toMatchObject({ written: 2, dropped: 1, remaining: 0, reasonCode: null });
    const fourthInput = routeInput("handoff.requested");
    expect(await replica(adb.pool(2), tenantId, independent).appendOrDefer(fourthInput, stream)).toMatchObject({ written: true, deferred: false });
    const events = await auditRows(tenantId);
    const records = events.filter((e) => e.action === JOURNAL_ENTRY_QUARANTINED_ACTION);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ outcome: "FAILED", reasonCode: "AUDIT_JOURNAL_ENTRY_DIGEST_MISMATCH", dataClass: "SECURITY_AUDIT", evidencePointers: [`kv://route-audit-journal/${sha256Hex(secondKey)}`] });
    expect(events.filter((e) => e.sourceStream === stream && e.action.startsWith("handoff.")).map((e) => e.correlationId)).toEqual([firstInput.correlationId, thirdInput.correlationId, fourthInput.correlationId]);
    expect(events.some((e) => e.correlationId === secondInput.correlationId)).toBe(false);
    const item = await itemStatus();
    expect(item?.status?.S).toBe("QUARANTINED");
    expect(item?.quarantineEventId?.S).toBe(records[0]?.eventId);
    expect(item?.input?.S).toContain("handoff.requested"); // kept for forensics
    expect(await independent.read(tenantId, 10)).toEqual({ entries: [], rejected: [] });
    expect(await replica(adb.pool(2), tenantId, independent).flush()).toMatchObject({ written: 0, dropped: 0, remaining: 0 });
    expect((await auditRows(tenantId)).filter((e) => e.action === JOURNAL_ENTRY_QUARANTINED_ACTION)).toHaveLength(1);
  });

  it("[FO-01-19][FO-15-45][FO-15-48][OPS-01][OPS-03] PostgreSQL read-only: the pending gauges count what waits in the DynamoDB journal; afterwards a bounded flush that spends a read slot on a tampered item never lets a newer row overtake the entry it has not read yet", async ({ l2 }) => {
    const tenantId = newId("tnt");
    const dynamo = dynamoClient(l2);
    const table = await createJournalTable(dynamo);
    const independent = DynamoRouteAuditJournal.fromClient(dynamo, table);
    const stream = "gateway.route-bounded";
    const metrics = new InMemoryMetrics({ catalogue: withSubstrateMetrics(createMetricCatalogue()) });
    const queueOn = (db: Db) => new DurableDeferredAuditQueue({ db, writer: new PgAuditWriter({ db, clock: systemClock, stream }), clock: systemClock, tenants: [tenantId], independent, metrics });
    const safetyRoute = () => buildAuditInput({ tenantId, correlationId: newId("hnd"), sourceComponent: "gateway", action: "handoff.safety_requested", outcome: "PENDING", callId: newId("call") }, systemClock);
    const pendingGauge = (journal: string) => metrics.gaugeValue("vsp_audit_journal_pending", { journal });
    const inputs = [safetyRoute(), safetyRoute(), safetyRoute()];

    const undo = await readOnlyDatabase(l2, adb);
    try {
      const readOnly = queueOn(adb.pool(1));
      for (const input of inputs) expect(await readOnly.appendOrDefer(input, stream)).toMatchObject({ deferred: true, journal: "dynamodb" });
      // The flush cannot write PostgreSQL: nothing is appended, and the three held events stay visible.
      const blocked = await readOnly.flush();
      expect(blocked).toMatchObject({ written: 0, remaining: 3 });
      expect(blocked.reasonCode).not.toBeNull();
      expect([readOnly.depth, metrics.gaugeValue("vsp_audit_deferred_depth"), pendingGauge("dynamodb"), pendingGauge("postgres")]).toEqual([3, 3, 3, 0]);
    } finally {
      await undo();
    }
    // An insider rewrites the OLDEST item's stored input (digest kept): it sorts first and takes a read slot.
    const [oldest] = (await independent.read(tenantId, 10)).entries;
    if (!oldest) throw new Error("nothing in the independent journal");
    await dynamo.send(
      new UpdateItemCommand({
        TableName: table,
        Key: { pk: { S: `raj#${tenantId}` }, sk: { S: `${oldest.deferredAt}#${oldest.deferralId}` } },
        UpdateExpression: "SET #i = :i",
        ExpressionAttributeNames: { "#i": "input" },
        ExpressionAttributeValues: { ":i": { S: canonicalJson({ ...oldest.input, action: "handoff.requested" }) } },
      }),
    );
    const queue = queueOn(adb.pool(2));
    const newer = buildAuditInput({ tenantId, correlationId: newId("hnd"), sourceComponent: "gateway", action: "handoff.requested", outcome: "PENDING", callId: newId("call") }, systemClock);
    const inTx = await adb.pool(1).tx((tx) => queue.appendOrDeferIn(tx, newer, stream), { role: "app_runtime", rls: { tenantId } });
    expect(inTx).toMatchObject({ deferred: true, journal: "postgres", reasonCode: "AUDIT_DEFERRED_QUEUE_PENDING" });
    const order = async () => (await auditRows(tenantId)).filter((e) => e.sourceStream === stream && e.action.startsWith("handoff.")).map((e) => e.correlationId);
    // flush(2) reads the tampered item and the second: quarantine, append the second, hold the newer row.
    expect(await queue.flush(2)).toMatchObject({ written: 1, dropped: 1, remaining: 2, reasonCode: null });
    expect(await order()).toEqual([inputs[1]?.correlationId]);
    expect([pendingGauge("dynamodb"), pendingGauge("postgres")]).toEqual([1, 1]);
    expect(await queue.flush(2)).toMatchObject({ written: 2, dropped: 0, remaining: 0, reasonCode: null });
    expect(await order()).toEqual([inputs[1]?.correlationId, inputs[2]?.correlationId, newer.correlationId]);
    expect([queue.depth, metrics.gaugeValue("vsp_audit_deferred_depth"), pendingGauge("dynamodb"), pendingGauge("postgres")]).toEqual([0, 0, 0, 0]);
    expect((await auditRows(tenantId)).filter((e) => e.action === JOURNAL_ENTRY_QUARANTINED_ACTION)).toHaveLength(1);
  });

  it("[FO-15-45][OPS-01][OPS-03] a forged DynamoDB item whose times JavaScript parses but postgres:16 cannot store (deferredAt '2026' under its matching sort key, or an event time in year 0000; digest recomputed by an insider) is quarantined with a chain record and never blocks the tenant: the honest route evidence is appended", async ({ l2 }) => {
    const tenantId = newId("tnt");
    const dynamo = dynamoClient(l2);
    const table = await createJournalTable(dynamo);
    const independent = DynamoRouteAuditJournal.fromClient(dynamo, table);
    const stream = "gateway.route-forged";
    const queueOn = (db: Db) => new DurableDeferredAuditQueue({ db, writer: new PgAuditWriter({ db, clock: systemClock, stream }), clock: systemClock, tenants: [tenantId], independent });
    const routeInput = (action: string) => buildAuditInput({ tenantId, correlationId: newId("hnd"), sourceComponent: "gateway", action, outcome: "PENDING", callId: newId("call") }, systemClock);
    const honest = routeInput("handoff.safety_requested");
    const undo = await readOnlyDatabase(l2, adb);
    try {
      expect(await queueOn(adb.pool(1)).appendOrDefer(honest, stream)).toMatchObject({ journal: "dynamodb" });
    } finally {
      await undo();
    }
    // An insider with write access to the table writes well-formed items directly (the input digest is unkeyed, so it is
    // recomputed), each under its own sort key `<deferredAt>#<deferralId>`; both sort before the honest entry.
    const year = journalEntryFor(routeInput("handoff.requested"), stream, "DB_UNAVAILABLE", "2026");
    const ancient = journalEntryFor({ ...routeInput("handoff.requested"), occurredAt: "0000-01-01T00:00:00Z" }, stream, "DB_UNAVAILABLE", new Date(Date.now() - 60_000).toISOString());
    const keyOf = (e: JournalEntry) => `${e.deferredAt}#${e.deferralId}`;
    for (const e of [year, ancient]) {
      await dynamo.send(
        new PutItemCommand({
          TableName: table,
          Item: {
            pk: { S: `raj#${tenantId}` },
            sk: { S: keyOf(e) },
            deferralId: { S: e.deferralId },
            tenantId: { S: e.tenantId },
            stream: { S: stream },
            input: { S: canonicalJson(e.input) },
            inputDigest: { S: e.inputDigest },
            reasonCode: { S: e.reasonCode },
            deferredAt: { S: e.deferredAt },
            status: { S: "PENDING" },
          },
        }),
      );
    }
    const read = await independent.read(tenantId, 10);
    expect(read.entries.map((e) => e.input.correlationId)).toEqual([honest.correlationId]);
    expect(read.rejected.map((r) => [r.key, r.reasonCode])).toEqual([
      [keyOf(year), "AUDIT_JOURNAL_ENTRY_INVALID"],
      [keyOf(ancient), "AUDIT_JOURNAL_ENTRY_INVALID"],
    ]);
    const queue = queueOn(adb.pool(2));
    expect(await queue.flush()).toEqual({ written: 1, dropped: 2, remaining: 0, reasonCode: null });
    const events = await auditRows(tenantId);
    expect(events.filter((e) => e.action === JOURNAL_ENTRY_QUARANTINED_ACTION).map((e) => [e.reasonCode, e.evidencePointers])).toEqual([
      ["AUDIT_JOURNAL_ENTRY_INVALID", [`kv://route-audit-journal/${sha256Hex(keyOf(year))}`]],
      ["AUDIT_JOURNAL_ENTRY_INVALID", [`kv://route-audit-journal/${sha256Hex(keyOf(ancient))}`]],
    ]);
    expect(events.filter((e) => e.sourceStream === stream && e.action.startsWith("handoff.")).map((e) => e.correlationId)).toEqual([honest.correlationId]);
    for (const e of [year, ancient]) {
      const item = (await dynamo.send(new GetItemCommand({ TableName: table, Key: { pk: { S: `raj#${tenantId}` }, sk: { S: keyOf(e) } }, ConsistentRead: true }))).Item;
      expect(item?.status?.S).toBe("QUARANTINED");
    }
    // Nothing holds the tenant: the next route event goes straight in; another flush quarantines and appends nothing.
    expect(await queue.appendOrDefer(routeInput("handoff.requested"), stream)).toMatchObject({ written: true, deferred: false });
    expect(await queue.flush()).toEqual({ written: 0, dropped: 0, remaining: 0, reasonCode: null });
  });

  it("[FO-15-45][OPS-01][OPS-03] a DynamoDB item that validates but whose content postgres:16 refuses when it is drained (a CHECK violation, SQLSTATE 23514) is quarantined instead of failing every pass; the honest entries around it keep their order", async ({ l2 }) => {
    const tenantId = newId("tnt");
    const dynamo = dynamoClient(l2);
    const table = await createJournalTable(dynamo);
    const independent = DynamoRouteAuditJournal.fromClient(dynamo, table);
    const stream = "gateway.route-refused";
    const queueOn = (db: Db) => new DurableDeferredAuditQueue({ db, writer: new PgAuditWriter({ db, clock: systemClock, stream }), clock: systemClock, tenants: [tenantId], independent });
    const inputs = [0, 1, 2].map(() => buildAuditInput({ tenantId, correlationId: newId("hnd"), sourceComponent: "gateway", action: "handoff.safety_requested", outcome: "PENDING", callId: newId("call") }, systemClock));
    const undo = await readOnlyDatabase(l2, adb);
    const journaled: Awaited<ReturnType<DurableDeferredAuditQueue["appendOrDefer"]>>[] = [];
    try {
      const readOnly = queueOn(adb.pool(1));
      for (const input of inputs) journaled.push(await readOnly.appendOrDefer(input, stream));
    } finally {
      await undo();
    }
    expect(journaled.map((j) => j.journal)).toEqual(["dynamodb", "dynamodb", "dynamodb"]);
    const refused = inputs[1];
    if (!refused) throw new Error("no input");
    // A real CHECK constraint stands in for any content postgres:16 refuses on the drain's insert.
    const constraint = `vsp_it_refuse_${Date.now().toString(36)}`;
    await adb.migrator.exec(`alter table audit_deferred add constraint ${constraint} check (correlation_id <> '${refused.correlationId}')`);
    try {
      expect(await queueOn(adb.pool(2)).flush()).toEqual({ written: 2, dropped: 1, remaining: 0, reasonCode: null });
    } finally {
      await adb.migrator.exec(`alter table audit_deferred drop constraint ${constraint}`);
    }
    const events = await auditRows(tenantId);
    const [record] = events.filter((e) => e.action === JOURNAL_ENTRY_QUARANTINED_ACTION);
    expect(record).toMatchObject({ reasonCode: "AUDIT_JOURNAL_ENTRY_INVALID", outcome: "FAILED" });
    expect(events.filter((e) => e.sourceStream === stream && e.action.startsWith("handoff.")).map((e) => e.correlationId)).toEqual([inputs[0]?.correlationId, inputs[2]?.correlationId]);
    expect(await independent.read(tenantId, 10)).toEqual({ entries: [], rejected: [] });
    expect((await deferrals(tenantId)).map((d) => d.status)).toEqual(["RECORDED", "RECORDED"]);
  });

  it("[FO-01-19][FO-15-45][OPS-01] same-instant order across replicas on DynamoDB Local: an event journaled behind another replica's independent entries (deferred at one clock instant) is appended after all of them", async ({ l2 }) => {
    const tenantId = newId("tnt");
    const dynamo = dynamoClient(l2);
    const table = await createJournalTable(dynamo);
    const independent = DynamoRouteAuditJournal.fromClient(dynamo, table);
    const stream = "gateway.route-instant";
    const instant = new FakeClock(new Date());
    const queueOn = (db: Db) => new DurableDeferredAuditQueue({ db, writer: new PgAuditWriter({ db, clock: instant, stream }), clock: instant, tenants: [tenantId], independent });
    const route = (action: string) => buildAuditInput({ tenantId, correlationId: newId("hnd"), sourceComponent: "gateway", action, outcome: "PENDING", callId: newId("call") }, instant);
    const held = [route("handoff.safety_requested"), route("handoff.safety_requested")];
    const undo = await readOnlyDatabase(l2, adb);
    try {
      const replicaA = queueOn(adb.pool(1));
      for (const input of held) expect(await replicaA.appendOrDefer(input, stream)).toMatchObject({ journal: "dynamodb" });
    } finally {
      await undo();
    }
    // Replica B, at the same clock instant, journals in its caller's transaction behind what it sees.
    const replicaB = queueOn(adb.pool(2));
    const behind = route("handoff.requested");
    expect(await adb.pool(1).tx((tx) => replicaB.appendOrDeferIn(tx, behind, stream), { role: "app_runtime", rls: { tenantId } })).toMatchObject({ deferred: true, journal: "postgres", reasonCode: "AUDIT_DEFERRED_QUEUE_PENDING" });
    expect(await replicaB.flush()).toMatchObject({ written: 3, remaining: 0 });
    const order = (await auditRows(tenantId)).filter((e) => e.sourceStream === stream && e.action.startsWith("handoff.")).map((e) => e.correlationId);
    expect(order).toEqual([held[0]?.correlationId, held[1]?.correlationId, behind.correlationId]);
  });

  it("[FO-01-34][FO-15-48][OPS-01] a detached safety route killed before its audit append leaves a durable not-recorded marker after restart, exactly once across two reconcilers", async () => {
    const tenantId = newId("tnt");
    const run = await killAfter(CHILD, [], "READY", "SIGKILL", childEnv(tenantId, "detached-route"));
    const [route] = parse<{ callId: string; incidentId: string; correlationId: string }>(run.lines, "ROUTE_STARTED");
    if (!route) throw new Error("child did not start the route");
    const later = new FakeClock(new Date(Date.now() + 10 * 60_000));
    const reconciler = (db: Db) => new RouteAuditReconciler({ db, writer: new PgAuditWriter({ db, clock: later, stream: "worker.route-reconciler", standaloneRole: "app_worker" }), clock: later, tenants: [tenantId], stream: "worker.route-reconciler", graceSeconds: 60 });
    const [x, y] = await Promise.all([reconciler(adb.pool(2)).runOnce(), reconciler(adb.pool(2)).runOnce()]);
    expect(x.safetyIncidents.notRecorded + y.safetyIncidents.notRecorded).toBe(1);
    expect(x.routeIntents.notRecorded + y.routeIntents.notRecorded).toBe(1);
    const again = await reconciler(adb.pool(2)).runOnce();
    expect(again.markerEventIds).toEqual([]);

    const markers = (await auditRows(tenantId)).filter((e) => e.action === ROUTE_NOT_RECORDED_ACTION);
    expect(markers.map((m) => m.correlationId).sort()).toEqual([route.correlationId, route.incidentId].sort());
    expect(markers.every((m) => m.outcome === "UNKNOWN" && m.callId === route.callId && m.reasonCode === "ROUTE_AUDIT_NOT_RECORDED")).toBe(true);
    const state = await adb.db.tx(
      async (tx) => ({
        intents: (await tx.query<{ status: string }>("select status from route_audit_intents")).rows.map((r) => r.status),
        recon: (await tx.query<{ subject_kind: string; result: string }>("select subject_kind, result from route_audit_reconciliations order by subject_kind")).rows,
      }),
      { role: "app_worker", rls: { tenantId } },
    );
    expect(state.intents).toEqual(["NOT_RECORDED"]);
    expect(state.recon).toEqual([
      { subject_kind: "ROUTE_INTENT", result: "NOT_RECORDED" },
      { subject_kind: "SAFETY_INCIDENT", result: "NOT_RECORDED" },
    ]);
  });
});
