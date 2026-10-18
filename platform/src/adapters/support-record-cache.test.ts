import { beforeEach, describe, expect, it } from "vitest";
import { CALLS, PEOPLE } from "../fixtures/synthetic-world.js";
import { FakeClock } from "../shared/clock.js";
import { ValidationError } from "../shared/errors.js";
import { newId, newSupportReference } from "../shared/ids.js";
import { FaultInjector } from "./local/faults.js";
import { SupportRecordsFixture } from "./local/support-records-fixture.js";
import { createBlockedLiveRegistry } from "./live/blocked-set.js";
import type { CaseFields, SupportRecordSystem } from "./ports.js";
import { AdapterRegistry } from "./registry.js";
import { CachingSupportRecords } from "./support-record-cache.js";

const caseFields = (): CaseFields => ({
  subjectRef: PEOPLE.avery.subjectId,
  audience: "client",
  issueCategory: "case_follow_up",
  disposition: "REQUEST_ACCEPTED",
  ownerQueue: "q_support",
  priority: "P3_STANDARD",
  summary: "Follow-up on an open request.",
  attempted: [],
  commitReceiptIds: [],
  sourceCallIds: [CALLS.primary.callId],
  language: "en",
  consentStatus: "GRANTED",
  nextStep: null,
  deadline: null,
  versions: "policy-2026-10-17.1",
  restricted: false,
  supportReference: newSupportReference(),
});

let clock: FakeClock;
let faults: FaultInjector;
let inner: SupportRecordsFixture;
let cache: CachingSupportRecords;
let call: string;
let issue: string;

beforeEach(async () => {
  clock = new FakeClock();
  faults = new FaultInjector();
  inner = new SupportRecordsFixture({ faults, clock });
  cache = new CachingSupportRecords(inner, { ttlMs: 30_000, maxEntries: 2, clock });
  call = newId("int");
  issue = newId("iss");
  await cache.upsertInteraction(call, { callId: CALLS.primary.callId, language: "en", consentStatus: "GRANTED", startedAt: "2026-10-17T15:00:00.000Z" });
  await cache.upsertCase(issue, call, caseFields());
});

describe("CachingSupportRecords — bounded caching instead of per-turn Salesforce reads", () => {
  it("[SPEC-12.caching] repeated reads within the TTL make one source call and carry the source timestamp", async () => {
    const a = await cache.getCaseWithSource(issue);
    clock.advanceSeconds(10);
    const b = await cache.getCaseWithSource(issue);
    expect(inner.apiCallCount("getCaseByExternalId")).toBe(1);
    expect(a?.fromCache).toBe(false);
    expect(b).toEqual({ value: a?.value, fetchedAt: a?.fetchedAt, fromCache: true });
    expect(cache.stats).toMatchObject({ hits: 1, misses: 1 });
  });

  it("[SPEC-12.caching] entries expire after the TTL; real-time commit checks bypass the cache", async () => {
    await cache.getCaseByExternalId(issue);
    clock.advanceSeconds(31);
    await cache.getCaseByExternalId(issue);
    expect(inner.apiCallCount("getCaseByExternalId")).toBe(2);
    const fresh = await cache.getCaseFresh(issue);
    expect(fresh?.fromCache).toBe(false);
    expect(inner.apiCallCount("getCaseByExternalId")).toBe(3);
  });

  it("[ACT-03] writes invalidate the cached Case, also when the write outcome is UNKNOWN", async () => {
    await cache.getCaseByExternalId(issue);
    inner.setCaseStatus(issue, "WORKING");
    faults.inject({ integrationId: "salesforce", operation: "upsertCase", kind: "TIMEOUT_AFTER_COMMIT" });
    await expect(cache.upsertCase(issue, call, caseFields())).rejects.toMatchObject({ outcome: "UNKNOWN" });
    expect((await cache.getCaseByExternalId(issue))?.status).toBe("WORKING");
    expect(inner.apiCallCount("getCaseByExternalId")).toBe(2);
  });

  it("[SPEC-12.caching] not-found results and failures are never cached; size is bounded (LRU)", async () => {
    const missing = newId("iss");
    expect(await cache.getCaseByExternalId(missing)).toBeNull();
    expect(await cache.getCaseByExternalId(missing)).toBeNull();
    expect(inner.apiCallCount("getCaseByExternalId")).toBe(2);
    faults.inject({ integrationId: "salesforce", operation: "getCaseByExternalId", kind: "OUTAGE" });
    await expect(cache.getCaseByExternalId(issue)).rejects.toMatchObject({ reasonCode: "CONNECTION_REFUSED" });
    expect(cache.stats.size).toBe(0);
    for (const id of [issue, newId("iss"), newId("iss")]) {
      await cache.upsertCase(id, call, caseFields());
      await cache.getCaseByExternalId(id);
    }
    expect(cache.stats.size).toBe(2);
  });

  it("[OPS-03] the wrapper keeps the inner kind and BLOCKED status visible to the registry; TTL is bounded", () => {
    const blocked = createBlockedLiveRegistry({ freeze: false }).get<SupportRecordSystem>("salesforce");
    const registry = new AdapterRegistry();
    registry.register("salesforce", new CachingSupportRecords(blocked, { ttlMs: 10_000, maxEntries: 10 }));
    expect(registry.summary().components[0]).toMatchObject({ kind: "live", capabilityStatus: "BLOCKED" });
    expect(cache.kind).toBe("local_fixture");
    expect(() => new CachingSupportRecords(inner, { ttlMs: 600_000, maxEntries: 10 })).toThrow(ValidationError);
    expect(() => new CachingSupportRecords(inner, { ttlMs: 1_000, maxEntries: 0 })).toThrow(ValidationError);
  });
});
