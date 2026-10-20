/**
 * Layer 2 (WP-04): the production DynamoDB adapters against DynamoDB Local (amazon/dynamodb-local).
 * FO-03-22 / FO-19-07a: DynamoKvStore conditional writes and compare-and-swap under real concurrency, TTL is
 * never a gate; ownership leases with fencing tokens; FO-02-04 / AUTH-04 at this boundary: the production
 * session service over DynamoDB fails closed on expiry and revocation even while DynamoDB still holds the item
 * (positive, adversarial and failure-injection tests); FO-15-45: the independent route-audit journal, including
 * re-validation of every item read back, the conditional quarantine of a tampered one, and the newest-first read of
 * the newest pending deferral time (descending query with a status filter across pages).
 */
import { GetItemCommand, DynamoDBClient, PutItemCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { describe, expect } from "vitest";
import { DynamoRouteAuditJournal, journalEntryFor } from "../../../src/audit/journal.js";
import { buildAuditInput } from "../../../src/audit/build-input.js";
import { DynamoKvStore } from "../../../src/identity/kv/dynamo-kv-store.js";
import { KvLeaseStore } from "../../../src/identity/kv/lease.js";
import { sessionRefHash } from "../../../src/identity/keys.js";
import { canonicalJson } from "../../../src/shared/canonical.js";
import { DependencyError, SessionInvalidError } from "../../../src/shared/errors.js";
import { FakeClock, iso } from "../../../src/shared/clock.js";
import { newId } from "../../../src/shared/ids.js";
import { dynamoClient, REGION } from "../_harness/clients.js";
import { layer2 } from "../_harness/layer2.js";
import { createJournalTable, createKvTable, dynamoSessionSeam } from "./seams.js";

const it = layer2(["dynamodb"]);

describe("DynamoKvStore on DynamoDB Local", () => {
  it("[FO-03-22][FO-19-07a] conditional create, compare-and-swap and versioned delete; a stale version never wins", async ({ l2 }) => {
    const client = dynamoClient(l2);
    const kv = DynamoKvStore.fromClient(client, await createKvTable(client));
    expect(kv.kind).toBe("live");
    const pk = `bnd#${newId("call")}`;
    expect(await kv.putIfAbsent({ pk, version: 1, ttlEpochSeconds: 2_000_000_000, data: { owner: "a" } })).toBe(true);
    expect(await kv.putIfAbsent({ pk, version: 1, ttlEpochSeconds: 2_000_000_000, data: { owner: "b" } })).toBe(false);
    expect(await kv.compareAndSwap(pk, 1, { owner: "a", step: 2 }, null)).toBe(true);
    expect(await kv.compareAndSwap(pk, 1, { owner: "stale" }, null)).toBe(false);
    expect(await kv.get(pk)).toMatchObject({ version: 2, data: { owner: "a", step: 2 }, ttlEpochSeconds: null });
    expect(await kv.delete(pk, 1)).toBe(false);
    expect(await kv.delete(pk, 2)).toBe(true);
    expect(await kv.get(pk)).toBeNull();
  });

  it("[FO-03-22][ACT-02] ten concurrent compare-and-swaps on one version: exactly one wins; twenty concurrent increments count twenty", async ({ l2 }) => {
    const client = dynamoClient(l2);
    const kv = DynamoKvStore.fromClient(client, await createKvTable(client));
    const pk = `ses#${newId("x1")}`;
    await kv.putIfAbsent({ pk, version: 1, ttlEpochSeconds: null, data: { gen: 1 } });
    const wins = await Promise.all(Array.from({ length: 10 }, (_, i) => kv.compareAndSwap(pk, 1, { gen: 2, by: i }, null)));
    expect(wins.filter(Boolean)).toHaveLength(1);
    const counter = `thr#${newId("x1")}`;
    const values = await Promise.all(Array.from({ length: 20 }, () => kv.increment(counter, 2_000_000_000)));
    expect([...values].sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it("[FO-03-22][AUTH-04] an expired item that TTL has not removed is still returned by the store; expiry is the reader's decision", async ({ l2 }) => {
    const client = dynamoClient(l2);
    const kv = DynamoKvStore.fromClient(client, await createKvTable(client));
    const pk = `ses#${newId("x1")}`;
    const past = Math.floor(Date.now() / 1000) - 3600;
    expect(await kv.putIfAbsent({ pk, version: 1, ttlEpochSeconds: past, data: { expiresAt: new Date(past * 1000).toISOString() } })).toBe(true);
    const got = await kv.get<{ expiresAt: string }>(pk);
    expect(got?.ttlEpochSeconds).toBe(past);
    expect(Date.parse(got?.data.expiresAt ?? "") < Date.now()).toBe(true);
    // And a putIfAbsent cannot resurrect the key while the expired item is physically present.
    expect(await kv.putIfAbsent({ pk, version: 1, ttlEpochSeconds: null, data: {} })).toBe(false);
  });

  it("[FO-03-22][ACT-02] ownership leases: of eight concurrent contenders exactly one holds; a takeover after expiry raises the fence and fences out the old holder", async ({ l2 }) => {
    const client = dynamoClient(l2);
    const kv = DynamoKvStore.fromClient(client, await createKvTable(client));
    const clock = new FakeClock(new Date());
    const leases = new KvLeaseStore(kv, clock);
    const resource = `call:${newId("call")}`;
    const got = await Promise.all(Array.from({ length: 8 }, (_, i) => leases.acquire(resource, `worker-${i}`, 30)));
    const holders = got.filter((g) => g !== null);
    expect(holders).toHaveLength(1);
    const first = holders[0];
    if (!first) throw new Error("no holder");
    expect(first.fence).toBe(1);
    expect(await leases.acquire(resource, "worker-late", 30)).toBeNull();
    clock.advanceSeconds(31);
    expect(await leases.check(first)).toBe(false);
    const second = await leases.acquire(resource, "worker-late", 30);
    expect(second).toMatchObject({ owner: "worker-late", fence: 2 });
    expect(await leases.renew(first, 30)).toBeNull();
    expect(await leases.currentFence(resource)).toBe(2);
  });
});

describe("[AUTH-04] sessions over DynamoDB Local (FO-02-04 at the storage boundary)", () => {
  it("[AUTH-04][FO-02-04] positive: a live session resolves; adversarial: another integration's channel or call is refused", async ({ l2 }) => {
    const s = await dynamoSessionSeam(l2);
    const started = await s.sessions.startCall({ integration: s.telephony, callId: newId("call"), callerIdHash: null, consent: { recording: "UNKNOWN", automatedProcessing: "UNKNOWN", disclosureTemplateVersion: null, capturedAt: null, capturedBy: "none" } });
    const ctx = await s.sessions.resolve(started.sessionRef, s.mcp);
    expect(ctx).toMatchObject({ tenantId: s.tenantId, sessionGeneration: 1, revoked: false });
    await expect(s.sessions.resolve(started.sessionRef, s.mcp, { expectedCallId: newId("call") })).rejects.toBeInstanceOf(SessionInvalidError);
    await expect(s.sessions.resolve(started.sessionRef, { ...s.mcp, tenantId: newId("tnt") })).rejects.toBeInstanceOf(SessionInvalidError);
    await expect(s.sessions.resolve(newId("ses", 32), s.mcp)).rejects.toBeInstanceOf(SessionInvalidError);
  });

  it("[AUTH-04][FO-02-04][FAULT:AUTH_EXPIRY_MID_CALL seam] failure injection: the clock passes expiry mid-call; DynamoDB still holds the item; every read fails closed; revocation fails closed at once", async ({ l2 }) => {
    const s = await dynamoSessionSeam(l2, 120);
    const consent = { recording: "UNKNOWN", automatedProcessing: "UNKNOWN", disclosureTemplateVersion: null, capturedAt: null, capturedBy: "none" } as const;
    const a = await s.sessions.startCall({ integration: s.telephony, callId: newId("call"), callerIdHash: null, consent });
    await s.sessions.resolve(a.sessionRef, s.mcp);
    s.clock.advanceSeconds(121);
    await expect(s.sessions.resolve(a.sessionRef, s.mcp)).rejects.toMatchObject({ reasonCode: expect.stringMatching(/EXPIRED/) });
    const item = await s.dynamo.send(new GetItemCommand({ TableName: s.table, Key: { pk: { S: `ses#${sessionRefHash(a.sessionRef)}` } }, ConsistentRead: true }));
    expect(item.Item, "TTL cleanup has not run: the item is still there").toBeDefined();
    const b = await s.sessions.startCall({ integration: s.telephony, callId: newId("call"), callerIdHash: null, consent });
    await s.sessions.revoke(b.sessionRef, "SECURITY_REVOKED");
    await expect(s.sessions.resolve(b.sessionRef, s.mcp)).rejects.toBeInstanceOf(SessionInvalidError);
  });

  it("[AUTH-04][OPS-03] failure injection: the session store is unreachable; resolve fails closed with a dependency error, never a context", async ({ l2 }) => {
    const s = await dynamoSessionSeam(l2);
    const a = await s.sessions.startCall({ integration: s.telephony, callId: newId("call"), callerIdHash: null, consent: { recording: "UNKNOWN", automatedProcessing: "UNKNOWN", disclosureTemplateVersion: null, capturedAt: null, capturedBy: "none" } });
    const dead = new DynamoDBClient({ region: REGION, endpoint: "http://127.0.0.1:1", credentials: { accessKeyId: "x", secretAccessKey: "y" }, maxAttempts: 1 });
    const { TrustedSessionService } = await import("../../../src/identity/session-service.js");
    const broken = new TrustedSessionService({ kv: DynamoKvStore.fromClient(dead, s.table), clock: s.clock, config: s.sessions.config });
    await expect(broken.resolve(a.sessionRef, s.mcp)).rejects.toBeInstanceOf(DependencyError);
  });
});

describe("DynamoRouteAuditJournal on DynamoDB Local", () => {
  it("[FO-15-45][OPS-02] entries are written once (conditional put), listed per tenant in deferral order, and marked drained idempotently", async ({ l2 }) => {
    const client = dynamoClient(l2);
    const journal = DynamoRouteAuditJournal.fromClient(client, await createJournalTable(client));
    const tenantId = newId("tnt");
    const base = Date.now();
    const entries = [2, 0, 1].map((i) =>
      journalEntryFor(
        buildAuditInput({ tenantId, correlationId: newId("hnd"), sourceComponent: "gateway", action: "handoff.safety_requested", outcome: "PENDING", occurredAt: iso(new Date(base + i * 1000)) }),
        "runtime",
        "DB_UNAVAILABLE",
        iso(new Date(base + i * 1000)),
      ),
    );
    for (const e of entries) await journal.put(e);
    await journal.put(entries[0] as (typeof entries)[number]); // a retried put of the same deferral is absorbed
    const pending = await journal.pending(tenantId, 10);
    expect(pending.map((p) => p.deferralId)).toEqual([entries[1], entries[2], entries[0]].map((e) => e?.deferralId));
    expect(pending[0]).toEqual(entries[1]);
    await journal.markDrained(pending[0] as (typeof pending)[number], iso(new Date()));
    await journal.markDrained(pending[0] as (typeof pending)[number], iso(new Date()));
    expect((await journal.pending(tenantId, 10)).map((p) => p.deferralId)).toEqual([entries[2], entries[0]].map((e) => e?.deferralId));
    expect(await journal.pending(newId("tnt"), 10)).toEqual([]);
  });

  it("[FO-01-19][FO-15-45][OPS-01] newestPendingMs reads the partition newest first across filtered pages: newer drained items and a non-canonical key are skipped, another tenant's items are not seen", async ({ l2 }) => {
    const client = dynamoClient(l2);
    const table = await createJournalTable(client);
    const journal = DynamoRouteAuditJournal.fromClient(client, table);
    const tenantId = newId("tnt");
    expect(await journal.newestPendingMs(tenantId)).toBeNull();
    const base = Date.now() - 600_000;
    const entries = Array.from({ length: 32 }, (_, i) =>
      journalEntryFor(
        buildAuditInput({ tenantId, correlationId: newId("hnd"), sourceComponent: "gateway", action: "handoff.safety_requested", outcome: "PENDING", occurredAt: iso(new Date(base + i * 1000)) }),
        "runtime",
        "DB_UNAVAILABLE",
        iso(new Date(base + i * 1000)),
      ),
    );
    for (const e of entries) await journal.put(e);
    expect(await journal.newestPendingMs(tenantId)).toBe(base + 31_000);
    // The 30 newest are drained (more than one 25-item page of the descending query is filtered out): the newest pending one is entries[1].
    for (const e of entries.slice(2)) await journal.markDrained(e, iso(new Date()));
    // An insider's item under a key that sorts after every canonical one is skipped (it is rejected, and quarantined, by the flush).
    await client.send(new PutItemCommand({ TableName: table, Item: { pk: { S: `raj#${tenantId}` }, sk: { S: "zzzz#dfr_synthJunkSortKey00001" }, status: { S: "PENDING" } } }));
    expect(await journal.newestPendingMs(tenantId)).toBe(base + 1000);
    expect(await journal.newestPendingMs(newId("tnt"))).toBeNull();
    await journal.markDrained(entries[1] as (typeof entries)[number], iso(new Date()));
    await journal.markDrained(entries[0] as (typeof entries)[number], iso(new Date()));
    expect(await journal.newestPendingMs(tenantId)).toBeNull();
  });

  it("[FO-15-45][OPS-01] items read back are re-validated: an item rewritten by an insider and another tenant's entry copied into the partition are rejected (never entries), quarantined once with their content kept, and no longer listed", async ({ l2 }) => {
    const client = dynamoClient(l2);
    const table = await createJournalTable(client);
    const journal = DynamoRouteAuditJournal.fromClient(client, table);
    const tenantId = newId("tnt");
    const base = Date.now();
    const entry = (tid: string, i: number) =>
      journalEntryFor(
        buildAuditInput({ tenantId: tid, correlationId: newId("hnd"), sourceComponent: "gateway", action: "handoff.safety_requested", outcome: "PENDING", occurredAt: iso(new Date(base + i * 1000)) }),
        "runtime",
        "DB_UNAVAILABLE",
        iso(new Date(base + i * 1000)),
      );
    const [a, b, other] = [entry(tenantId, 0), entry(tenantId, 1), entry(newId("tnt"), 2)];
    for (const e of [a, b, other]) await journal.put(e as (typeof a));
    const keyOf = (e: typeof a, partition = tenantId) => ({ pk: { S: `raj#${partition}` }, sk: { S: `${e.deferredAt}#${e.deferralId}` } });
    await client.send(
      new UpdateItemCommand({ TableName: table, Key: keyOf(b), UpdateExpression: "SET #i = :i", ExpressionAttributeNames: { "#i": "input" }, ExpressionAttributeValues: { ":i": { S: canonicalJson({ ...b.input, action: "handoff.requested" }) } } }),
    );
    const copied = await client.send(new GetItemCommand({ TableName: table, Key: keyOf(other, other.tenantId), ConsistentRead: true }));
    await client.send(new PutItemCommand({ TableName: table, Item: { ...copied.Item, pk: { S: `raj#${tenantId}` } } }));

    const read = await journal.read(tenantId, 10);
    expect(read.entries).toEqual([a]);
    expect(read.rejected.map((r) => [r.key, r.reasonCode])).toEqual([
      [`${b.deferredAt}#${b.deferralId}`, "AUDIT_JOURNAL_ENTRY_DIGEST_MISMATCH"],
      [`${other.deferredAt}#${other.deferralId}`, "AUDIT_JOURNAL_ENTRY_INVALID"],
    ]);
    await expect(journal.pending(tenantId, 10)).rejects.toThrow("AUDIT_JOURNAL_ENTRY_DIGEST_MISMATCH");
    const recordIds = read.rejected.map(() => newId("aud"));
    for (const [i, r] of read.rejected.entries()) await journal.quarantine(r, iso(new Date()), recordIds[i] ?? "");
    await journal.quarantine(read.rejected[0] as (typeof read.rejected)[number], iso(new Date()), newId("aud")); // absorbed: no longer PENDING
    expect(await journal.read(tenantId, 10)).toEqual({ entries: [a], rejected: [] });
    const kept = (await client.send(new GetItemCommand({ TableName: table, Key: keyOf(b), ConsistentRead: true }))).Item;
    expect([kept?.status?.S, kept?.quarantineReason?.S, kept?.quarantineEventId?.S]).toEqual(["QUARANTINED", "AUDIT_JOURNAL_ENTRY_DIGEST_MISMATCH", recordIds[0]]);
    expect(kept?.input?.S).toContain("handoff.requested");
    expect((await journal.read(other.tenantId, 10)).entries).toEqual([other]); // the other tenant's own item is untouched
  });
});
