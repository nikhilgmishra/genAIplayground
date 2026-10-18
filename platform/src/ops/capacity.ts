/**
 * Concurrent AI session capacity with controlled admission (spec section 12).
 *
 * The standard pool is bounded (`maxConcurrentAiSessions`, planning figure 2000).
 * Safety and human-route sessions draw from a separate safety reserve that is
 * ALWAYS granted: exceeding the reserve size raises an alert for the escalation
 * owner but never refuses a safety session (SAFE-03).
 *
 * This implementation is per process. A multi-instance deployment needs either a
 * per-instance share of the contracted limit or a shared counter (for example a
 * DynamoDB conditional counter); the contracted vendor concurrency itself is
 * UNKNOWN (TB-10), so the configured limit is a planning value, not a contract.
 */
import { ValidationError } from "../shared/errors.js";
import { newId } from "../shared/ids.js";
import type { Metrics } from "../observability/ports.js";

export interface CapacityLease {
  leaseId: string;
  pool: "standard" | "safety_reserve";
}

export interface SessionCapacity {
  /** Returns null when the standard pool is full. */
  tryAcquire(): CapacityLease | null;
  /** Always succeeds. `overReserve` is true when the reserve size was exceeded (alert, not a block). */
  acquireReserve(): { lease: CapacityLease; overReserve: boolean };
  /** Idempotent. */
  release(leaseId: string): void;
  active(): { standard: number; safetyReserve: number };
  limits(): { maxConcurrentAiSessions: number; safetyReserveSessions: number };
}

export class InMemorySessionCapacity implements SessionCapacity {
  readonly scope = "per_process" as const;
  private readonly standard = new Set<string>();
  private readonly reserve = new Set<string>();

  constructor(
    private readonly opts: { maxConcurrentAiSessions: number; safetyReserveSessions: number; metrics?: Metrics },
  ) {
    const ok =
      Number.isInteger(opts.maxConcurrentAiSessions) &&
      opts.maxConcurrentAiSessions >= 1 &&
      Number.isInteger(opts.safetyReserveSessions) &&
      opts.safetyReserveSessions >= 0;
    if (!ok) throw new ValidationError("CAPACITY_SETTINGS_INVALID");
  }

  tryAcquire(): CapacityLease | null {
    if (this.standard.size >= this.opts.maxConcurrentAiSessions) return null;
    const lease: CapacityLease = { leaseId: newId("lse"), pool: "standard" };
    this.standard.add(lease.leaseId);
    this.publish();
    return lease;
  }

  acquireReserve(): { lease: CapacityLease; overReserve: boolean } {
    const lease: CapacityLease = { leaseId: newId("lse"), pool: "safety_reserve" };
    this.reserve.add(lease.leaseId);
    this.publish();
    return { lease, overReserve: this.reserve.size > this.opts.safetyReserveSessions };
  }

  release(leaseId: string): void {
    if (this.standard.delete(leaseId) || this.reserve.delete(leaseId)) this.publish();
  }

  active(): { standard: number; safetyReserve: number } {
    return { standard: this.standard.size, safetyReserve: this.reserve.size };
  }

  limits(): { maxConcurrentAiSessions: number; safetyReserveSessions: number } {
    return { maxConcurrentAiSessions: this.opts.maxConcurrentAiSessions, safetyReserveSessions: this.opts.safetyReserveSessions };
  }

  private publish(): void {
    this.opts.metrics?.gauge("vsp_ai_sessions_active", this.standard.size, { pool: "standard" });
    this.opts.metrics?.gauge("vsp_ai_sessions_active", this.reserve.size, { pool: "safety_reserve" });
  }
}
