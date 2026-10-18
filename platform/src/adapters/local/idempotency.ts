/**
 * LOCAL FIXTURE idempotency ledger used by SYNTHETIC business-system fixtures to
 * model a provider that honours idempotency keys (the behaviour PRQ-007 asks
 * the real business-system owners to confirm).
 *
 *  - same key + same request digest  -> the original result, no second effect (ACT-02);
 *  - same key + different request    -> ConflictError IDEMPOTENCY_KEY_REUSED (never a silent overwrite);
 *  - lookup by key                   -> the committed result, for reconciliation of UNKNOWN outcomes (ACT-03).
 */
import { z } from "zod";
import { digestOf } from "../../shared/canonical.js";
import { ConflictError } from "../../shared/errors.js";

export const IdempotencyKey = z.string().regex(/^[A-Za-z0-9_.:-]{16,128}$/);

/** Digest of the operation and its business payload (idempotency key excluded). */
export const requestDigest = (operation: string, payload: Record<string, unknown>): string => digestOf({ operation, payload });

interface Entry<R> {
  digest: string;
  result: R;
  recordedAt: string;
}

export class IdempotencyLedger<R> {
  private readonly entries = new Map<string, Entry<R>>();

  /** Returns the stored result for a replay, null for a new key; throws when the key is reused for another request. */
  replay(key: string, digest: string): R | null {
    const e = this.entries.get(key);
    if (!e) return null;
    if (e.digest !== digest) throw new ConflictError("IDEMPOTENCY_KEY_REUSED");
    return structuredClone(e.result);
  }

  record(key: string, digest: string, result: R, recordedAt: string): void {
    if (this.entries.has(key)) throw new ConflictError("IDEMPOTENCY_KEY_REUSED");
    this.entries.set(key, { digest, result: structuredClone(result), recordedAt });
  }

  find(key: string): R | null {
    const e = this.entries.get(key);
    return e ? structuredClone(e.result) : null;
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}
