/**
 * KvLeaseStore over the in-memory KvStore LOCAL FIXTURE (same conditional semantics as DynamoKvStore,
 * whose run against DynamoDB Local is test/integration/substrate/dynamo.test.ts) with a FakeClock.
 */
import { describe, expect, it } from "vitest";
import { FakeClock } from "../../shared/clock.js";
import { KvLeaseStore } from "./lease.js";
import { MemoryKvStoreFixture } from "./memory-kv-store.js";

describe("KvLeaseStore", () => {
  it("[FO-03-22][ACT-02] one owner holds a resource; a takeover after expiry increments the fence and the old holder is fenced out", async () => {
    const clock = new FakeClock();
    const kv = new MemoryKvStoreFixture();
    const leases = new KvLeaseStore(kv, clock);
    const a = await leases.acquire("call:call_synthCallPrimary0001", "worker-a", 30);
    expect(a).toMatchObject({ owner: "worker-a", fence: 1 });
    expect(await leases.acquire("call:call_synthCallPrimary0001", "worker-b", 30)).toBeNull();
    clock.advanceSeconds(31);
    expect(await leases.check(a!)).toBe(false); // expired: the reader enforces expiry, TTL cleanup has not run
    const b = await leases.acquire("call:call_synthCallPrimary0001", "worker-b", 30);
    expect(b).toMatchObject({ owner: "worker-b", fence: 2 });
    expect(await leases.renew(a!, 30)).toBeNull();
    expect(await leases.release(a!)).toBe(false);
    expect(await leases.check(b!)).toBe(true);
    expect(await leases.currentFence("call:call_synthCallPrimary0001")).toBe(2);
  });

  it("[FO-03-22][AUTH-04] renew extends only the current holder's lease; release frees the resource", async () => {
    const clock = new FakeClock();
    const leases = new KvLeaseStore(new MemoryKvStoreFixture(), clock);
    const a = await leases.acquire("case:cas_synthCase000000001", "worker-a", 10);
    clock.advanceSeconds(8);
    const renewed = await leases.renew(a!, 10);
    expect(renewed?.fence).toBe(1);
    clock.advanceSeconds(8);
    expect(await leases.check(renewed!)).toBe(true);
    expect(await leases.release(renewed!)).toBe(true);
    expect(await leases.acquire("case:cas_synthCase000000001", "worker-b", 10)).toMatchObject({ fence: 1 });
    await expect(leases.acquire("bad resource with spaces", "worker-a", 10)).rejects.toThrow("LEASE_RESOURCE_INVALID");
  });
});
