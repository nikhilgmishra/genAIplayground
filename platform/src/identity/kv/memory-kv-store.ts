import type { KvItem, KvStore } from "../ports.js";
import { assertData, assertKey, assertTtl, assertVersion } from "./validation.js";

/**
 * LOCAL FIXTURE — in-memory KvStore with the same compare-and-swap semantics as
 * the DynamoDB store (`DynamoKvStore`):
 *
 *  - `putIfAbsent` fails if ANY item exists under the key, including one whose
 *    TTL has passed (DynamoDB TTL deletion is lazy; an expired item is still
 *    physically present until the background sweep removes it).
 *  - `compareAndSwap` succeeds only if the stored version equals the expected
 *    version; the new version is expected + 1 and the item is fully replaced.
 *  - `get` IGNORES TTL. Readers must enforce expiry themselves (AUTH-04).
 *    `sweepExpired(nowEpochSeconds)` simulates the eventual TTL sweep in tests.
 *  - `increment` is an atomic counter (`counter` + `version` incremented, TTL set
 *    only if absent). A counter item reads back as `data: { count }`.
 *
 * Values are deep-copied on write and read so callers can never mutate stored
 * state by aliasing. Not durable; never used outside local/ci (OPS-04).
 */
interface Entry {
  version: number;
  ttl: number | null;
  data: Record<string, unknown> | null;
  counter: number | null;
}

export class MemoryKvStoreFixture implements KvStore {
  readonly kind = "local_fixture" as const;
  private readonly items = new Map<string, Entry>();

  async get<T>(pk: string): Promise<KvItem<T> | null> {
    assertKey(pk);
    const e = this.items.get(pk);
    if (!e) return null;
    return {
      pk,
      version: e.version,
      ttlEpochSeconds: e.ttl,
      data: structuredClone(e.data ?? { count: e.counter ?? 0 }) as T,
    };
  }

  async putIfAbsent<T>(item: KvItem<T>): Promise<boolean> {
    assertKey(item.pk);
    assertVersion(item.version);
    assertTtl(item.ttlEpochSeconds);
    assertData(item.data);
    if (this.items.has(item.pk)) return false;
    this.items.set(item.pk, { version: item.version, ttl: item.ttlEpochSeconds, data: structuredClone(item.data) as Record<string, unknown>, counter: null });
    return true;
  }

  async compareAndSwap<T>(pk: string, expectedVersion: number, data: T, ttlEpochSeconds: number | null): Promise<boolean> {
    assertKey(pk);
    assertVersion(expectedVersion);
    assertTtl(ttlEpochSeconds);
    assertData(data);
    const e = this.items.get(pk);
    if (!e || e.version !== expectedVersion) return false;
    this.items.set(pk, { version: expectedVersion + 1, ttl: ttlEpochSeconds, data: structuredClone(data) as Record<string, unknown>, counter: null });
    return true;
  }

  async delete(pk: string, expectedVersion?: number): Promise<boolean> {
    assertKey(pk);
    if (expectedVersion !== undefined) assertVersion(expectedVersion);
    const e = this.items.get(pk);
    if (!e) return false;
    if (expectedVersion !== undefined && e.version !== expectedVersion) return false;
    this.items.delete(pk);
    return true;
  }

  async increment(pk: string, ttlEpochSeconds: number): Promise<number> {
    assertKey(pk);
    assertTtl(ttlEpochSeconds);
    const e = this.items.get(pk);
    if (!e) {
      this.items.set(pk, { version: 1, ttl: ttlEpochSeconds, data: null, counter: 1 });
      return 1;
    }
    e.counter = (e.counter ?? 0) + 1;
    e.version += 1;
    if (e.ttl === null) e.ttl = ttlEpochSeconds;
    return e.counter;
  }

  // ---------------- test helpers (LOCAL FIXTURE only) ----------------

  /** Simulates DynamoDB's eventual TTL sweep: removes items whose TTL is <= now. Returns the number removed. */
  sweepExpired(nowEpochSeconds: number): number {
    let removed = 0;
    for (const [pk, e] of this.items) {
      if (e.ttl !== null && e.ttl <= nowEpochSeconds) {
        this.items.delete(pk);
        removed++;
      }
    }
    return removed;
  }

  /** Raw dump of every stored key and value, for tests asserting that no bearer value or secret is persisted. */
  dump(): string {
    return JSON.stringify([...this.items.entries()]);
  }

  keys(): string[] {
    return [...this.items.keys()];
  }

  get size(): number {
    return this.items.size;
  }
}
