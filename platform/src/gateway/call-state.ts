/**
 * Small per-call state the gateway keeps for the telephony-control API.
 *
 * - SessionLeaseRegistry: the AI-capacity lease taken by admission at call start
 *   (released at call end). Keyed by sha256 of the bearer reference, never the
 *   bearer. Per process, like InMemorySessionCapacity (multi-instance deployment
 *   needs a shared counter: ops module gap).
 * - HandoffIndex: the latest handoff requested through the gateway for a call,
 *   for TC-12 handoff context. Bounded LRU; opaque ids only.
 * - PendingActionLookup: the current PREPARED action of a session for TC-07.
 *   The ActionService port has no session lookup yet (interface change request
 *   to the actions module: pendingForSession); until then a read-only query of
 *   action_ledger under the tenant's runtime RLS context finds the id and the
 *   ledger's own describe() returns the authoritative record.
 */
import type { Db } from "../db/types.js";
import { sessionRefHash } from "../identity/keys.js";
import type { AdmissionDecision } from "../ops/ports.js";
import type { Clock } from "../shared/clock.js";
import { iso } from "../shared/clock.js";
import type { HandoffResult } from "../business/contract.js";

export interface LeaseRecord {
  leaseId: string | null;
  decision: Pick<AdmissionDecision, "admitted" | "continuity" | "reasonCode">;
}

export class SessionLeaseRegistry {
  private readonly byHash = new Map<string, LeaseRecord>();
  constructor(private readonly maxEntries = 50_000) {}

  set(sessionRef: string, record: LeaseRecord): void {
    const k = sessionRefHash(sessionRef);
    this.byHash.delete(k);
    this.byHash.set(k, record);
    while (this.byHash.size > this.maxEntries) {
      const oldest = this.byHash.keys().next().value;
      if (oldest === undefined) break;
      this.byHash.delete(oldest);
    }
  }

  get(sessionRef: string): LeaseRecord | null {
    try {
      return this.byHash.get(sessionRefHash(sessionRef)) ?? null;
    } catch {
      return null;
    }
  }

  /** Removes and returns the record (call end). */
  take(sessionRef: string): LeaseRecord | null {
    try {
      const k = sessionRefHash(sessionRef);
      const r = this.byHash.get(k) ?? null;
      this.byHash.delete(k);
      return r;
    } catch {
      return null;
    }
  }

  get size(): number {
    return this.byHash.size;
  }
}

export interface IndexedHandoff {
  handoffId: string;
  transferId: string | null;
  destinationId: string;
  priority: "SAFETY" | "STANDARD";
  at: string;
}

export class HandoffIndex {
  private readonly byCall = new Map<string, IndexedHandoff>();
  constructor(
    private readonly clock: Clock,
    private readonly maxEntries = 50_000,
  ) {}

  record(callId: string, result: Pick<HandoffResult, "handoffId" | "transferId" | "destinationId">, priority: "SAFETY" | "STANDARD"): void {
    const prior = this.byCall.get(callId);
    // A STANDARD request never displaces an active safety handoff for the same call (SAFE-03).
    if (prior?.priority === "SAFETY" && priority === "STANDARD") return;
    this.byCall.delete(callId);
    this.byCall.set(callId, { handoffId: result.handoffId, transferId: result.transferId, destinationId: result.destinationId, priority, at: iso(this.clock.now()) });
    while (this.byCall.size > this.maxEntries) {
      const oldest = this.byCall.keys().next().value;
      if (oldest === undefined) break;
      this.byCall.delete(oldest);
    }
  }

  latest(callId: string): IndexedHandoff | null {
    return this.byCall.get(callId) ?? null;
  }
}

export interface PendingActionLookup {
  /** Most recent unexpired PREPARED action id for this session, or null. */
  pendingActionId(tenantId: string, sessionRef: string): Promise<string | null>;
}

export class PgPendingActionLookup implements PendingActionLookup {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  async pendingActionId(tenantId: string, sessionRef: string): Promise<string | null> {
    const hash = sessionRefHash(sessionRef);
    const rows = await this.db.tx(
      async (tx) =>
        (
          await tx.query<{ action_id: string }>(
            `select action_id from action_ledger
              where tenant_id = $1 and session_ref_hash = $2 and state = 'PREPARED' and expires_at > $3
              order by prepared_at desc, action_id limit 1`,
            [tenantId, hash, iso(this.clock.now())],
          )
        ).rows,
      { role: "app_runtime", rls: { tenantId } },
    );
    return rows[0]?.action_id ?? null;
  }
}
