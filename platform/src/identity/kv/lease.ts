/**
 * Ownership leases with fencing tokens over the KvStore port (follow-on FO-03-22; AUTH-04, ACT-02).
 * DynamoDB in production (conditional writes, DynamoKvStore), the in-memory fixture offline.
 *
 * A lease record `lse#<resource>` holds { owner, fence, expiresAt }. Semantics:
 *  - acquire: creates the record (fence 1) with a conditional put, or takes over an EXPIRED (or own) lease
 *    with a compare-and-swap on the record version, incrementing the fence. Two contenders racing for the
 *    same resource cannot both win: exactly one conditional write succeeds.
 *  - renew / release: compare-and-swap / conditional delete, only by the holder of the current fence.
 *  - check: the READER enforces expiry (`expiresAt > now`), fence and owner. DynamoDB TTL deletion is
 *    lazy and is never the gate: an expired record that TTL has not removed yet is still expired.
 * The fence is what a downstream writer compares: a holder whose lease was taken over carries a smaller
 * fence and is refused even if it still believes it holds the lease (split-brain protection).
 */
import { ValidationError } from "../../shared/errors.js";
import type { Clock } from "../../shared/clock.js";
import type { KvStore } from "../ports.js";

export interface Lease {
  resource: string;
  owner: string;
  fence: number;
  expiresAt: string;
}

interface LeaseData {
  owner: string;
  fence: number;
  expiresAt: string;
}

const RESOURCE = /^[A-Za-z0-9:_.-]{3,200}$/;
const OWNER = /^[A-Za-z0-9:_.-]{3,128}$/;

export class KvLeaseStore {
  constructor(
    private readonly kv: KvStore,
    private readonly clock: Clock,
    /** Seconds the record outlives its expiry before TTL may delete it (cleanup only, never a gate). */
    private readonly ttlGraceSeconds = 3600,
  ) {
    if (!Number.isSafeInteger(ttlGraceSeconds) || ttlGraceSeconds < 60 || ttlGraceSeconds > 30 * 86_400) throw new ValidationError("LEASE_TTL_GRACE_INVALID");
  }

  private key(resource: string): string {
    if (!RESOURCE.test(resource)) throw new ValidationError("LEASE_RESOURCE_INVALID");
    return `lse#${resource}`;
  }

  private ttlFor(expiresAt: Date): number {
    return Math.floor(expiresAt.getTime() / 1000) + this.ttlGraceSeconds;
  }

  /** Acquires the lease or returns null when another owner holds an unexpired one. */
  async acquire(resource: string, owner: string, ttlSeconds: number): Promise<Lease | null> {
    if (!OWNER.test(owner)) throw new ValidationError("LEASE_OWNER_INVALID");
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 86_400) throw new ValidationError("LEASE_TTL_INVALID");
    const pk = this.key(resource);
    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
    const current = await this.kv.get<LeaseData>(pk);
    if (!current) {
      const data: LeaseData = { owner, fence: 1, expiresAt: expiresAt.toISOString() };
      return (await this.kv.putIfAbsent({ pk, version: 1, ttlEpochSeconds: this.ttlFor(expiresAt), data })) ? { resource, ...data } : null;
    }
    const held = Date.parse(current.data.expiresAt) > now.getTime();
    if (held && current.data.owner !== owner) return null;
    const data: LeaseData = { owner, fence: current.data.fence + 1, expiresAt: expiresAt.toISOString() };
    return (await this.kv.compareAndSwap(pk, current.version, data, this.ttlFor(expiresAt))) ? { resource, ...data } : null;
  }

  /** Extends the lease if `lease` is still the current, unexpired holder; null otherwise (it was lost). */
  async renew(lease: Lease, ttlSeconds: number): Promise<Lease | null> {
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 86_400) throw new ValidationError("LEASE_TTL_INVALID");
    const pk = this.key(lease.resource);
    const now = this.clock.now();
    const current = await this.kv.get<LeaseData>(pk);
    if (!current || current.data.owner !== lease.owner || current.data.fence !== lease.fence || Date.parse(current.data.expiresAt) <= now.getTime()) return null;
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
    const data: LeaseData = { owner: lease.owner, fence: lease.fence, expiresAt: expiresAt.toISOString() };
    return (await this.kv.compareAndSwap(pk, current.version, data, this.ttlFor(expiresAt))) ? { resource: lease.resource, ...data } : null;
  }

  /** Releases the lease if still held by this fence. */
  async release(lease: Lease): Promise<boolean> {
    const pk = this.key(lease.resource);
    const current = await this.kv.get<LeaseData>(pk);
    if (!current || current.data.owner !== lease.owner || current.data.fence !== lease.fence) return false;
    return this.kv.delete(pk, current.version);
  }

  /** True only when `lease` is the current holder and unexpired at the reader's clock (fail closed). */
  async check(lease: Lease): Promise<boolean> {
    const current = await this.kv.get<LeaseData>(this.key(lease.resource));
    return (
      current !== null &&
      current.data.owner === lease.owner &&
      current.data.fence === lease.fence &&
      Date.parse(current.data.expiresAt) > this.clock.now().getTime()
    );
  }

  /** Current fence of the resource (0 when never leased): what a fenced downstream write compares against. */
  async currentFence(resource: string): Promise<number> {
    const current = await this.kv.get<LeaseData>(this.key(resource));
    return current?.data.fence ?? 0;
  }
}
