/**
 * Bounded read cache in front of a SupportRecordSystem (spec section 12:
 * "Avoid pulling Salesforce on every speech turn; use bounded authorized
 * caching, source timestamps and real-time commit checks").
 *
 *  - only `getCaseByExternalId` results are cached, for at most `ttlMs`
 *    (<= 60 s) and at most `maxEntries` entries (least recently used evicted);
 *  - every cached value carries its source timestamp (`fetchedAt`);
 *  - `getCaseFresh` bypasses the cache for real-time checks before a commit or a
 *    disclosure that must reflect the current state;
 *  - writes are never cached and invalidate the affected Case before AND after
 *    the call (also when the write fails or its outcome is UNKNOWN);
 *  - null (not found) and failures are never cached.
 *
 * The cache sits BELOW authorization: every read still passes the gateway's
 * policy decision first, and an instance serves one tenant configuration only.
 * It holds opaque ids, a status and a queue name — no summaries or PHI fields.
 */
import { systemClock, type Clock } from "../shared/clock.js";
import { ValidationError } from "../shared/errors.js";
import type { AdapterHealth, CaseFields, SupportRecordSystem } from "./ports.js";

type CaseView = { caseId: string; status: string; ownerQueue: string };

export interface CachedCase {
  value: CaseView;
  /** ISO timestamp at which the value was read from the source system. */
  fetchedAt: string;
  fromCache: boolean;
}

export interface CachingSupportRecordsOptions {
  ttlMs: number;
  maxEntries: number;
  clock?: Clock;
}

export const MAX_SUPPORT_CACHE_TTL_MS = 60_000;

export class CachingSupportRecords implements SupportRecordSystem {
  readonly kind: SupportRecordSystem["kind"];
  readonly integrationId: string;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly clock: Clock;
  private readonly entries = new Map<string, { value: CaseView; fetchedAtMs: number }>();
  private hitCount = 0;
  private missCount = 0;

  constructor(
    private readonly inner: SupportRecordSystem,
    opts: CachingSupportRecordsOptions,
  ) {
    if (!Number.isInteger(opts.ttlMs) || opts.ttlMs < 0 || opts.ttlMs > MAX_SUPPORT_CACHE_TTL_MS) throw new ValidationError("SUPPORT_CACHE_TTL_INVALID");
    if (!Number.isInteger(opts.maxEntries) || opts.maxEntries < 1 || opts.maxEntries > 10_000) throw new ValidationError("SUPPORT_CACHE_SIZE_INVALID");
    this.kind = inner.kind;
    this.integrationId = inner.integrationId;
    this.ttlMs = opts.ttlMs;
    this.maxEntries = opts.maxEntries;
    this.clock = opts.clock ?? systemClock;
  }

  /** Mirrors the wrapped adapter's capability status so a BLOCKED adapter stays BLOCKED in the registry. */
  get capabilityStatus(): unknown {
    return (this.inner as { capabilityStatus?: unknown }).capabilityStatus;
  }

  get prerequisites(): unknown {
    return (this.inner as { prerequisites?: unknown }).prerequisites;
  }

  get label(): unknown {
    return (this.inner as { label?: unknown }).label;
  }

  health(): Promise<AdapterHealth> {
    return this.inner.health();
  }

  upsertInteraction(
    externalId: string,
    fields: { callId: string; language: string; consentStatus: string; startedAt: string },
  ): Promise<{ recordId: string; created: boolean }> {
    return this.inner.upsertInteraction(externalId, fields);
  }

  async upsertCase(externalId: string, interactionExternalId: string, fields: CaseFields): Promise<{ caseId: string; created: boolean }> {
    this.entries.delete(externalId);
    try {
      return await this.inner.upsertCase(externalId, interactionExternalId, fields);
    } finally {
      this.entries.delete(externalId);
    }
  }

  async getCaseByExternalId(externalId: string): Promise<CaseView | null> {
    return (await this.getCaseWithSource(externalId))?.value ?? null;
  }

  /** Cached read with its source timestamp. */
  async getCaseWithSource(externalId: string): Promise<CachedCase | null> {
    const nowMs = this.clock.now().getTime();
    const hit = this.entries.get(externalId);
    if (hit && nowMs - hit.fetchedAtMs < this.ttlMs) {
      this.hitCount += 1;
      this.entries.delete(externalId);
      this.entries.set(externalId, hit);
      return { value: { ...hit.value }, fetchedAt: new Date(hit.fetchedAtMs).toISOString(), fromCache: true };
    }
    if (hit) this.entries.delete(externalId);
    this.missCount += 1;
    return this.fetch(externalId);
  }

  /** Real-time read for commit checks: always calls the source system and refreshes the cache. */
  async getCaseFresh(externalId: string): Promise<CachedCase | null> {
    this.entries.delete(externalId);
    return this.fetch(externalId);
  }

  invalidate(externalId?: string): void {
    if (externalId === undefined) this.entries.clear();
    else this.entries.delete(externalId);
  }

  get stats(): { hits: number; misses: number; size: number } {
    return { hits: this.hitCount, misses: this.missCount, size: this.entries.size };
  }

  private async fetch(externalId: string): Promise<CachedCase | null> {
    const fetchedAtMs = this.clock.now().getTime();
    const value = await this.inner.getCaseByExternalId(externalId);
    if (value === null) return null;
    if (this.ttlMs > 0) {
      this.entries.set(externalId, { value: { ...value }, fetchedAtMs });
      while (this.entries.size > this.maxEntries) {
        const oldest = this.entries.keys().next().value;
        if (oldest === undefined) break;
        this.entries.delete(oldest);
      }
    }
    return { value: { ...value }, fetchedAt: new Date(fetchedAtMs).toISOString(), fromCache: false };
  }
}
