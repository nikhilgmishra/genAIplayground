/**
 * Fault and seam board of the reference business API (WP-23; FO-17-24 fault matrix, follow-on prompt section 17).
 *
 * Only reachable through the fault-control listener (admin.ts), which exists only in local/ci with
 * REFBIZ_FAULT_CONTROL=enabled (config.ts). With no armed fault every check below is a no-op, so the API
 * behaves as documented. Faults are scoped to one account (one test's tenant) and one operation (or an
 * operation prefix ending in `.*`), fire at most `times` times, and count every hit: the hit counters are the
 * independent reach evidence a Layer-2 test reads back (the fault point was reached, not merely armed).
 *
 *   DELAY_RESPONSE              reads: the request is received and processed, the response is held `delayMs`
 *                               (a client deadline below it sees a read timeout after send)
 *   HTTP_STATUS                 any operation: answered `status` (503 with Retry-After) before processing
 *   PARTIAL_WRITE               writes: step 1 (the change) is applied, step 2 (finalization: receipt) fails with
 *                               500 PARTIAL_WRITE; the request id stays APPLIED until completed
 *   COMMIT_THEN_DELAY           writes: the change is applied and finalized, the response is held `delayMs`
 *                               (timeout after commit; SCHEDULING_TIMEOUT_AFTER_COMMIT seam)
 *   DROP_RESPONSE_AFTER_COMMIT  writes: applied and finalized, then the connection is destroyed without a
 *                               response (the receipt never arrives; RECEIPT_LOST seam)
 *   LATE_RECEIPT                writes: applied and finalized with the lookup index lagging `lagMs` (bounded by
 *                               the account's documented visibility window) and the response held `delayMs`
 *                               (RECEIPT_LATE seam)
 *   SLOT_VERSION_CHANGE         after `afterReads` reads of slot `resourceId`, its version is bumped by another
 *                               channel (CHANGED_SLOT_DURING_CONFIRMATION seam)
 *   STALL_BEFORE_COMMIT         writes (keyed and legacy create): the transaction passed its final deadline check and
 *                               is then held open `delayMs` before COMMIT (commit latency: a stalled process, a slow
 *                               fsync or a synchronous-replication wait), so the change becomes durable AFTER the
 *                               request's deadline; only a fence (never a clock) may then decide absence
 * Barriers (CONCURRENT_SAME_ACCOUNT seam) hold writes to one resource until `parties` requests arrived, then
 * release them together, so two commits race on the record's row lock deterministically.
 */
import { newId } from "./ids.js";

export const HTTP_FAULT_KINDS = ["DELAY_RESPONSE", "HTTP_STATUS", "PARTIAL_WRITE", "COMMIT_THEN_DELAY", "DROP_RESPONSE_AFTER_COMMIT", "LATE_RECEIPT", "SLOT_VERSION_CHANGE", "STALL_BEFORE_COMMIT"] as const;
export type HttpFaultKind = (typeof HTTP_FAULT_KINDS)[number];

export interface FaultSpec {
  operation: string;
  kind: HttpFaultKind;
  delayMs?: number | null;
  status?: number | null;
  retryAfterSeconds?: number | null;
  lagMs?: number | null;
  resourceId?: string | null;
  afterReads?: number | null;
  /** How many times the fault fires; null = until cleared. */
  times?: number | null;
}

export interface ArmedFault {
  readonly faultId: string;
  readonly accountId: string;
  readonly operation: string;
  readonly kind: HttpFaultKind;
  readonly delayMs: number;
  readonly status: number;
  readonly retryAfterSeconds: number | null;
  readonly lagMs: number;
  readonly resourceId: string | null;
  readonly afterReads: number;
  remaining: number | null;
  hits: number;
  reads: number;
  readonly armedAt: string;
  lastHitAt: string | null;
}

export interface Barrier {
  readonly barrierId: string;
  readonly accountId: string;
  readonly operation: string;
  readonly resourceId: string;
  readonly parties: number;
  readonly timeoutMs: number;
  arrived: number;
  released: boolean;
  timedOut: boolean;
  waiters: (() => void)[];
}

export interface RequestRecord {
  operation: string;
  keyRef: string | null;
  status: number;
  at: string;
}

const MAX_REQUESTS_PER_ACCOUNT = 10_000;

const matches = (pattern: string, operation: string): boolean => (pattern.endsWith(".*") ? operation.startsWith(pattern.slice(0, -1)) : pattern === operation);

export class FaultBoard {
  private readonly faults = new Map<string, ArmedFault[]>();
  private readonly barriers = new Map<string, Barrier[]>();
  private readonly requests = new Map<string, RequestRecord[]>();

  /**
   * `recording`: whether the request log is kept (only with the fault-control listener: in a deployment there is
   * no reader of it, so nothing is kept in memory).
   */
  constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly recording = true,
  ) {}

  arm(accountId: string, spec: FaultSpec): ArmedFault {
    const f: ArmedFault = {
      faultId: newId("flt"),
      accountId,
      operation: spec.operation,
      kind: spec.kind,
      delayMs: spec.delayMs ?? 0,
      status: spec.status ?? 503,
      retryAfterSeconds: spec.retryAfterSeconds ?? null,
      lagMs: spec.lagMs ?? 0,
      resourceId: spec.resourceId ?? null,
      afterReads: spec.afterReads ?? 0,
      remaining: spec.times ?? null,
      hits: 0,
      reads: 0,
      armedAt: this.now().toISOString(),
      lastHitAt: null,
    };
    const list = this.faults.get(accountId) ?? [];
    list.push(f);
    this.faults.set(accountId, list);
    return f;
  }

  list(accountId: string): readonly ArmedFault[] {
    return this.faults.get(accountId) ?? [];
  }

  clear(accountId: string, faultId?: string): void {
    if (faultId === undefined) {
      this.faults.delete(accountId);
      return;
    }
    this.faults.set(
      accountId,
      (this.faults.get(accountId) ?? []).filter((f) => f.faultId !== faultId),
    );
  }

  /** The active fault of one of `kinds` for this operation, consumed (hit counted) when found. */
  take(accountId: string, operation: string, kinds: readonly HttpFaultKind[], resourceId: string | null = null): ArmedFault | null {
    const list = this.faults.get(accountId);
    if (!list) return null;
    for (const f of list) {
      if (!kinds.includes(f.kind) || !matches(f.operation, operation)) continue;
      if (f.resourceId !== null && f.resourceId !== resourceId) continue;
      if (f.remaining !== null && f.remaining <= 0) continue;
      if (f.remaining !== null) f.remaining -= 1;
      f.hits += 1;
      f.lastHitAt = this.now().toISOString();
      return f;
    }
    return null;
  }

  /**
   * Counts a read of a slot; returns true when an armed SLOT_VERSION_CHANGE fault says the version must now
   * change (after its `afterReads` reads). The caller bumps the version in the database.
   */
  slotReadTriggersChange(accountId: string, slotId: string): boolean {
    const list = this.faults.get(accountId);
    if (!list) return false;
    for (const f of list) {
      if (f.kind !== "SLOT_VERSION_CHANGE" || f.resourceId !== slotId) continue;
      if (f.remaining !== null && f.remaining <= 0) continue;
      f.reads += 1;
      if (f.reads < f.afterReads) continue;
      if (f.remaining !== null) f.remaining -= 1;
      f.hits += 1;
      f.lastHitAt = this.now().toISOString();
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- barriers (CONCURRENT_SAME_ACCOUNT seam)

  addBarrier(accountId: string, operation: string, resourceId: string, parties: number, timeoutMs: number): Barrier {
    const b: Barrier = { barrierId: newId("bar"), accountId, operation, resourceId, parties, timeoutMs, arrived: 0, released: false, timedOut: false, waiters: [] };
    const list = this.barriers.get(accountId) ?? [];
    list.push(b);
    this.barriers.set(accountId, list);
    return b;
  }

  barriersOf(accountId: string): readonly Barrier[] {
    return this.barriers.get(accountId) ?? [];
  }

  /** Waits at an armed, unreleased barrier for (operation, resource); returns immediately when there is none. */
  async arrive(accountId: string, operation: string, resourceId: string): Promise<void> {
    const b = (this.barriers.get(accountId) ?? []).find((x) => !x.released && matches(x.operation, operation) && x.resourceId === resourceId);
    if (!b) return;
    b.arrived += 1;
    if (b.arrived >= b.parties) {
      b.released = true;
      for (const w of b.waiters.splice(0)) w();
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        b.timedOut = true;
        b.released = true;
        for (const w of b.waiters.splice(0)) w();
      }, b.timeoutMs);
      b.waiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  // ---------------------------------------------------------------- request log (reach and retry evidence)

  record(accountId: string, r: Omit<RequestRecord, "at">): void {
    if (!this.recording) return;
    const list = this.requests.get(accountId) ?? [];
    list.push({ ...r, at: this.now().toISOString() });
    if (list.length > MAX_REQUESTS_PER_ACCOUNT) list.splice(0, list.length - MAX_REQUESTS_PER_ACCOUNT);
    this.requests.set(accountId, list);
  }

  requestsOf(accountId: string): readonly RequestRecord[] {
    return this.requests.get(accountId) ?? [];
  }

  /** Forgets everything about an account (test teardown). */
  forget(accountId: string): void {
    this.faults.delete(accountId);
    this.requests.delete(accountId);
    for (const b of this.barriers.get(accountId) ?? []) {
      b.released = true;
      for (const w of b.waiters.splice(0)) w();
    }
    this.barriers.delete(accountId);
  }
}
