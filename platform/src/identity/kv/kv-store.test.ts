/**
 * KvStore tests.
 *
 * 1. A shared behavioural suite runs against the LOCAL FIXTURE (MemoryKvStoreFixture)
 *    and against DynamoKvStore driven by a LOCAL STUB that emulates ONLY the exact
 *    condition/update expressions this store emits (any other expression throws).
 *    The stub is not DynamoDB; DynamoDB Local was NOT RUN here (no container runtime).
 * 2. CONTRACT tests assert the exact command classes and inputs DynamoKvStore sends.
 * 3. A fast-check model test checks CAS semantics of the fixture against a reference model.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { DependencyError, ValidationError } from "../../shared/errors.js";
import type { KvStore } from "../ports.js";
import { DynamoKvStore } from "./dynamo-kv-store.js";
import type { DocumentSender } from "./dynamo-kv-store.js";
import { MemoryKvStoreFixture } from "./memory-kv-store.js";

type Cmd = GetCommand | PutCommand | UpdateCommand | DeleteCommand;

const ccf = () => new ConditionalCheckFailedException({ message: "The conditional request failed", $metadata: {} });

/** LOCAL STUB emulating the expressions DynamoKvStore emits. Unknown expressions throw. */
class DynamoExpressionStub implements DocumentSender {
  readonly table = new Map<string, Record<string, unknown>>();
  readonly sent: Cmd[] = [];
  async send(cmd: Cmd): Promise<unknown> {
    this.sent.push(cmd);
    if (cmd instanceof GetCommand) {
      const it = this.table.get(String(cmd.input.Key?.pk));
      return { Item: it ? structuredClone(it) : undefined };
    }
    if (cmd instanceof PutCommand) {
      const item = cmd.input.Item as Record<string, unknown>;
      const pk = String(item.pk);
      const existing = this.table.get(pk);
      if (cmd.input.ConditionExpression === "attribute_not_exists(pk)") {
        if (existing) throw ccf();
      } else if (cmd.input.ConditionExpression === "#v = :expected") {
        if (!existing || existing.version !== cmd.input.ExpressionAttributeValues?.[":expected"]) throw ccf();
      } else throw new Error("UNSUPPORTED_EXPRESSION");
      this.table.set(pk, structuredClone(item));
      return {};
    }
    if (cmd instanceof DeleteCommand) {
      const pk = String(cmd.input.Key?.pk);
      const existing = this.table.get(pk);
      if (cmd.input.ConditionExpression === "attribute_exists(pk)") {
        if (!existing) throw ccf();
      } else if (cmd.input.ConditionExpression === "#v = :expected") {
        if (!existing || existing.version !== cmd.input.ExpressionAttributeValues?.[":expected"]) throw ccf();
      } else throw new Error("UNSUPPORTED_EXPRESSION");
      this.table.delete(pk);
      return {};
    }
    if (cmd instanceof UpdateCommand) {
      if (cmd.input.UpdateExpression !== "ADD #c :one, #v :one SET #t = if_not_exists(#t, :ttl)") throw new Error("UNSUPPORTED_EXPRESSION");
      const pk = String(cmd.input.Key?.pk);
      const existing = this.table.get(pk) ?? { pk };
      const next = { ...existing };
      next.counter = (typeof existing.counter === "number" ? existing.counter : 0) + 1;
      next.version = (typeof existing.version === "number" ? existing.version : 0) + 1;
      if (existing.ttl === undefined) next.ttl = cmd.input.ExpressionAttributeValues?.[":ttl"];
      this.table.set(pk, next);
      return { Attributes: { counter: next.counter, version: next.version, ttl: next.ttl } };
    }
    throw new Error("UNSUPPORTED_COMMAND");
  }
}

const TABLE = "vsp-local-sessions";

const implementations: [string, () => KvStore][] = [
  ["MemoryKvStoreFixture (LOCAL FIXTURE)", () => new MemoryKvStoreFixture()],
  ["DynamoKvStore over LOCAL expression stub", () => new DynamoKvStore(new DynamoExpressionStub(), TABLE)],
];

describe.each(implementations)("KvStore semantics: %s", (_name, make) => {
  it("[SPEC-7.KV] putIfAbsent creates once and reports conflict without overwriting", async () => {
    const kv = make();
    expect(await kv.putIfAbsent({ pk: "ses#abc", version: 1, ttlEpochSeconds: 100, data: { a: 1 } })).toBe(true);
    expect(await kv.putIfAbsent({ pk: "ses#abc", version: 1, ttlEpochSeconds: 100, data: { a: 2 } })).toBe(false);
    expect(await kv.get("ses#abc")).toEqual({ pk: "ses#abc", version: 1, ttlEpochSeconds: 100, data: { a: 1 } });
  });

  it("[SPEC-7.KV] compareAndSwap succeeds only on the expected version and increments it", async () => {
    const kv = make();
    await kv.putIfAbsent({ pk: "ses#k", version: 1, ttlEpochSeconds: null, data: { n: 0 } });
    expect(await kv.compareAndSwap("ses#k", 2, { n: 9 }, null)).toBe(false);
    expect(await kv.compareAndSwap("ses#k", 1, { n: 1 }, 500)).toBe(true);
    expect(await kv.compareAndSwap("ses#k", 1, { n: 2 }, 500)).toBe(false);
    expect(await kv.get("ses#k")).toEqual({ pk: "ses#k", version: 2, ttlEpochSeconds: 500, data: { n: 1 } });
    expect(await kv.compareAndSwap("ses#missing", 1, { n: 1 }, null)).toBe(false);
    expect(await kv.get("ses#missing")).toBeNull();
  });

  it("[SPEC-7.KV] delete honours the expected version and reports missing items", async () => {
    const kv = make();
    await kv.putIfAbsent({ pk: "vtx#d", version: 3, ttlEpochSeconds: null, data: {} });
    expect(await kv.delete("vtx#d", 2)).toBe(false);
    expect(await kv.delete("vtx#d", 3)).toBe(true);
    expect(await kv.delete("vtx#d")).toBe(false);
    await kv.putIfAbsent({ pk: "vtx#e", version: 1, ttlEpochSeconds: null, data: {} });
    expect(await kv.delete("vtx#e")).toBe(true);
    expect(await kv.get("vtx#e")).toBeNull();
  });

  it("[SPEC-7.KV] increment is an atomic counter that keeps the first window TTL", async () => {
    const kv = make();
    expect(await kv.increment("thr#w1", 1000)).toBe(1);
    expect(await kv.increment("thr#w1", 2000)).toBe(2);
    const results = await Promise.all(Array.from({ length: 10 }, () => kv.increment("thr#w1", 3000)));
    expect(new Set(results).size).toBe(10);
    expect(Math.max(...results)).toBe(12);
    const item = await kv.get<{ count: number }>("thr#w1");
    expect(item?.data.count).toBe(12);
    expect(item?.ttlEpochSeconds).toBe(1000);
  });

  it("[AUTH-04] reads ignore storage TTL: an expired item is still returned (readers enforce expiry)", async () => {
    const kv = make();
    await kv.putIfAbsent({ pk: "ses#old", version: 1, ttlEpochSeconds: 1, data: { expiresAt: "2000-01-01T00:00:00.000Z" } });
    expect((await kv.get("ses#old"))?.data).toEqual({ expiresAt: "2000-01-01T00:00:00.000Z" });
    // putIfAbsent still conflicts with a TTL-expired but not yet swept item.
    expect(await kv.putIfAbsent({ pk: "ses#old", version: 1, ttlEpochSeconds: null, data: {} })).toBe(false);
  });

  it("[SPEC-7.KV] rejects malformed keys, versions, TTLs and data before any I/O", async () => {
    const kv = make();
    await expect(kv.get("no-namespace")).rejects.toBeInstanceOf(ValidationError);
    await expect(kv.get("ses#has space")).rejects.toBeInstanceOf(ValidationError);
    await expect(kv.putIfAbsent({ pk: "ses#x", version: -1, ttlEpochSeconds: null, data: {} })).rejects.toBeInstanceOf(ValidationError);
    await expect(kv.putIfAbsent({ pk: "ses#x", version: 1, ttlEpochSeconds: 1.5, data: {} })).rejects.toBeInstanceOf(ValidationError);
    await expect(kv.putIfAbsent({ pk: "ses#x", version: 1, ttlEpochSeconds: null, data: [] as unknown as Record<string, unknown> })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(kv.compareAndSwap("ses#x", 1, null, null)).rejects.toBeInstanceOf(ValidationError);
  });

  it("[SPEC-7.KV] stored values are not aliased to caller objects", async () => {
    const kv = make();
    const data = { nested: { v: 1 } };
    await kv.putIfAbsent({ pk: "ses#alias", version: 1, ttlEpochSeconds: null, data });
    data.nested.v = 2;
    const read = await kv.get<{ nested: { v: number } }>("ses#alias");
    expect(read?.data.nested.v).toBe(1);
    if (read) read.data.nested.v = 3;
    expect((await kv.get<{ nested: { v: number } }>("ses#alias"))?.data.nested.v).toBe(1);
  });
});

describe("DynamoKvStore CONTRACT (stub client asserts exact command inputs)", () => {
  class RecordingSender implements DocumentSender {
    readonly sent: Cmd[] = [];
    constructor(private readonly respond: (cmd: Cmd) => unknown) {}
    async send(cmd: Cmd): Promise<unknown> {
      this.sent.push(cmd);
      const r = this.respond(cmd);
      if (r instanceof Error) throw r;
      return r;
    }
  }

  it("[SPEC-7.KV] get uses a strongly consistent GetCommand on pk", async () => {
    const s = new RecordingSender(() => ({ Item: { pk: "ses#a", version: 4, ttl: 99, data: { x: true } } }));
    const kv = new DynamoKvStore(s, TABLE);
    expect(await kv.get("ses#a")).toEqual({ pk: "ses#a", version: 4, ttlEpochSeconds: 99, data: { x: true } });
    expect(s.sent[0]).toBeInstanceOf(GetCommand);
    expect(s.sent[0]?.input).toEqual({ TableName: TABLE, Key: { pk: "ses#a" }, ConsistentRead: true });
  });

  it("[SPEC-7.KV] putIfAbsent uses PutCommand with attribute_not_exists(pk) and the ttl attribute", async () => {
    const s = new RecordingSender(() => ({}));
    const kv = new DynamoKvStore(s, TABLE);
    expect(await kv.putIfAbsent({ pk: "ses#a", version: 1, ttlEpochSeconds: 1234, data: { y: 1 } })).toBe(true);
    expect(s.sent[0]).toBeInstanceOf(PutCommand);
    expect(s.sent[0]?.input).toEqual({
      TableName: TABLE,
      Item: { pk: "ses#a", version: 1, data: { y: 1 }, ttl: 1234 },
      ConditionExpression: "attribute_not_exists(pk)",
    });
    await kv.putIfAbsent({ pk: "ses#b", version: 1, ttlEpochSeconds: null, data: {} });
    expect((s.sent[1]?.input as { Item: Record<string, unknown> }).Item).toEqual({ pk: "ses#b", version: 1, data: {} });
  });

  it("[SPEC-7.KV] compareAndSwap uses ConditionExpression #v = :expected and writes version + 1", async () => {
    const s = new RecordingSender(() => ({}));
    const kv = new DynamoKvStore(s, TABLE);
    expect(await kv.compareAndSwap("ses#a", 7, { z: "q" }, 555)).toBe(true);
    expect(s.sent[0]).toBeInstanceOf(PutCommand);
    expect(s.sent[0]?.input).toEqual({
      TableName: TABLE,
      Item: { pk: "ses#a", version: 8, data: { z: "q" }, ttl: 555 },
      ConditionExpression: "#v = :expected",
      ExpressionAttributeNames: { "#v": "version" },
      ExpressionAttributeValues: { ":expected": 7 },
    });
  });

  it("[SPEC-7.KV] ConditionalCheckFailedException maps to false (instance or by name)", async () => {
    const byInstance = new DynamoKvStore(new RecordingSender(() => ccf()), TABLE);
    expect(await byInstance.compareAndSwap("ses#a", 1, {}, null)).toBe(false);
    expect(await byInstance.putIfAbsent({ pk: "ses#a", version: 1, ttlEpochSeconds: null, data: {} })).toBe(false);
    expect(await byInstance.delete("ses#a")).toBe(false);
    const byName = new DynamoKvStore(
      new RecordingSender(() => Object.assign(new Error("x"), { name: "ConditionalCheckFailedException" })),
      TABLE,
    );
    expect(await byName.compareAndSwap("ses#a", 1, {}, null)).toBe(false);
  });

  it("[SPEC-7.KV] delete with and without expected version", async () => {
    const s = new RecordingSender(() => ({}));
    const kv = new DynamoKvStore(s, TABLE);
    await kv.delete("vtx#a");
    await kv.delete("vtx#a", 3);
    expect(s.sent[0]).toBeInstanceOf(DeleteCommand);
    expect(s.sent[0]?.input).toEqual({ TableName: TABLE, Key: { pk: "vtx#a" }, ConditionExpression: "attribute_exists(pk)" });
    expect(s.sent[1]?.input).toEqual({
      TableName: TABLE,
      Key: { pk: "vtx#a" },
      ConditionExpression: "#v = :expected",
      ExpressionAttributeNames: { "#v": "version" },
      ExpressionAttributeValues: { ":expected": 3 },
    });
  });

  it("[SPEC-7.KV] increment uses UpdateCommand ADD with if_not_exists TTL and returns the new counter", async () => {
    const s = new RecordingSender(() => ({ Attributes: { counter: 3, version: 3, ttl: 42 } }));
    const kv = new DynamoKvStore(s, TABLE);
    expect(await kv.increment("thr#w", 42)).toBe(3);
    expect(s.sent[0]).toBeInstanceOf(UpdateCommand);
    expect(s.sent[0]?.input).toEqual({
      TableName: TABLE,
      Key: { pk: "thr#w" },
      UpdateExpression: "ADD #c :one, #v :one SET #t = if_not_exists(#t, :ttl)",
      ExpressionAttributeNames: { "#c": "counter", "#v": "version", "#t": "ttl" },
      ExpressionAttributeValues: { ":one": 1, ":ttl": 42 },
      ReturnValues: "UPDATED_NEW",
    });
  });

  it("[SPEC-7.KV] other SDK errors become reason-coded DependencyErrors without the SDK message", async () => {
    const secretish = new Error("ValidationException: value ses_SECRETBEARERVALUE0000000 invalid");
    const kv = new DynamoKvStore(new RecordingSender(() => secretish), TABLE);
    const read = await kv.get("ses#a").catch((e: unknown) => e);
    expect(read).toBeInstanceOf(DependencyError);
    expect((read as DependencyError).reasonCode).toBe("KV_READ_FAILED");
    expect((read as Error).message).not.toContain("SECRET");
    const write = await kv.compareAndSwap("ses#a", 1, {}, null).catch((e: unknown) => e);
    expect((write as DependencyError).reasonCode).toBe("KV_WRITE_FAILED");
    expect((write as DependencyError).outcome).toBe("UNKNOWN");
    const inc = await kv.increment("thr#a", 1).catch((e: unknown) => e);
    expect((inc as DependencyError).reasonCode).toBe("KV_INCREMENT_FAILED");
  });

  it("[SPEC-7.KV] malformed stored items fail closed", async () => {
    const kv = new DynamoKvStore(new RecordingSender(() => ({ Item: { pk: "ses#a", version: "1", data: {} } })), TABLE);
    await expect(kv.get("ses#a")).rejects.toMatchObject({ reasonCode: "KV_ITEM_MALFORMED" });
    const wrongPk = new DynamoKvStore(new RecordingSender(() => ({ Item: { pk: "ses#b", version: 1, data: {} } })), TABLE);
    await expect(wrongPk.get("ses#a")).rejects.toMatchObject({ reasonCode: "KV_ITEM_MALFORMED" });
  });

  it("[SPEC-7.KV] rejects an invalid table name and declares kind live", () => {
    expect(() => new DynamoKvStore(new RecordingSender(() => ({})), "x")).toThrow(ValidationError);
    expect(new DynamoKvStore(new RecordingSender(() => ({})), TABLE).kind).toBe("live");
    expect(new MemoryKvStoreFixture().kind).toBe("local_fixture");
  });
});

describe("MemoryKvStoreFixture model test", () => {
  type Op =
    | { op: "put"; key: number; ver: number }
    | { op: "cas"; key: number; expected: number; val: number }
    | { op: "del"; key: number; expected: number | undefined }
    | { op: "get"; key: number };

  const opArb: fc.Arbitrary<Op> = fc.oneof(
    fc.record({ op: fc.constant("put" as const), key: fc.integer({ min: 0, max: 3 }), ver: fc.integer({ min: 0, max: 3 }) }),
    fc.record({ op: fc.constant("cas" as const), key: fc.integer({ min: 0, max: 3 }), expected: fc.integer({ min: 0, max: 5 }), val: fc.integer() }),
    fc.record({ op: fc.constant("del" as const), key: fc.integer({ min: 0, max: 3 }), expected: fc.option(fc.integer({ min: 0, max: 5 }), { nil: undefined }) }),
    fc.record({ op: fc.constant("get" as const), key: fc.integer({ min: 0, max: 3 }) }),
  );

  it("[SPEC-7.KV] compare-and-swap semantics match a reference model for random operation sequences", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { maxLength: 60 }), async (ops) => {
        const kv = new MemoryKvStoreFixture();
        const model = new Map<string, { version: number; val: number }>();
        for (const o of ops) {
          const pk = `ses#k${o.key}`;
          const cur = model.get(pk);
          if (o.op === "put") {
            const ok = await kv.putIfAbsent({ pk, version: o.ver, ttlEpochSeconds: null, data: { val: -1 } });
            expect(ok).toBe(!cur);
            if (!cur) model.set(pk, { version: o.ver, val: -1 });
          } else if (o.op === "cas") {
            const ok = await kv.compareAndSwap(pk, o.expected, { val: o.val }, null);
            const should = !!cur && cur.version === o.expected;
            expect(ok).toBe(should);
            if (should) model.set(pk, { version: o.expected + 1, val: o.val });
          } else if (o.op === "del") {
            const ok = await kv.delete(pk, o.expected);
            const should = !!cur && (o.expected === undefined || cur.version === o.expected);
            expect(ok).toBe(should);
            if (should) model.delete(pk);
          } else {
            const item = await kv.get<{ val: number }>(pk);
            expect(item === null ? null : { version: item.version, val: item.data.val }).toEqual(cur ?? null);
          }
        }
      }),
      { seed: 20261017, numRuns: 200 },
    );
  });

  it("[AUTH-04] sweepExpired simulates the lazy DynamoDB TTL sweep", async () => {
    const kv = new MemoryKvStoreFixture();
    await kv.putIfAbsent({ pk: "ses#a", version: 1, ttlEpochSeconds: 10, data: {} });
    await kv.putIfAbsent({ pk: "ses#b", version: 1, ttlEpochSeconds: null, data: {} });
    expect(kv.sweepExpired(9)).toBe(0);
    expect(kv.sweepExpired(10)).toBe(1);
    expect(kv.keys()).toEqual(["ses#b"]);
  });
});
