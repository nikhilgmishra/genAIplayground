import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PgliteDb } from "../db/pglite.js";
import { CALLS, STAFF } from "../fixtures/synthetic-world.js";
import { FakeClock, iso } from "../shared/clock.js";
import { AccessDeniedError, ValidationError } from "../shared/errors.js";
import { AuditWriterOutageFixture } from "./fixtures.js";
import { PgAuditQuery, auditedSearch } from "./query.js";
import { OTHER_TENANT_ID, TENANT_ID, createAuditTestDb, sampleAuditInput } from "./testing.js";
import { PgAuditWriter } from "./writer.js";

let db: PgliteDb;
let clock: FakeClock;
let writer: PgAuditWriter;

beforeEach(async () => {
  db = await createAuditTestDb();
  clock = new FakeClock();
  writer = new PgAuditWriter({ db, clock, stream: "console.synth-1" });
  await writer.appendStandalone(sampleAuditInput(clock, { action: "tool.invoke", outcome: "ALLOWED" }));
  clock.advanceSeconds(10);
  await writer.appendStandalone(sampleAuditInput(clock));
  clock.advanceSeconds(10);
  await writer.appendStandalone(sampleAuditInput(clock, { callId: CALLS.concurrent.callId, correlationId: "cor_synthCorrelation0009" }));
  await writer.appendStandalone(sampleAuditInput(clock, { tenantId: OTHER_TENANT_ID }));
});
afterEach(async () => {
  await db.close();
});

describe("PgAuditQuery (metadata only, app_auditor / app_console)", () => {
  it("[AUTH-05] returns only the requested tenant's events, newest first", async () => {
    const q = new PgAuditQuery(db);
    const mine = await q.search({ tenantId: TENANT_ID, limit: 200 });
    expect(mine).toHaveLength(3);
    expect(mine.every((e) => e.tenantId === TENANT_ID)).toBe(true);
    expect(mine.map((e) => e.occurredAt)).toEqual(["2026-10-17T15:00:20.000Z", "2026-10-17T15:00:10.000Z", "2026-10-17T15:00:00.000Z"]);
    const theirs = await new PgAuditQuery(db, "app_console").search({ tenantId: OTHER_TENANT_ID, limit: 10 });
    expect(theirs).toHaveLength(1);
  });

  it("[SPEC-13.5] filters by correlationId, callId, action and half-open time range", async () => {
    const q = new PgAuditQuery(db);
    expect(await q.search({ tenantId: TENANT_ID, correlationId: "cor_synthCorrelation0009", limit: 10 })).toHaveLength(1);
    expect(await q.search({ tenantId: TENANT_ID, callId: CALLS.primary.callId, limit: 10 })).toHaveLength(2);
    expect((await q.search({ tenantId: TENANT_ID, action: "tool.invoke", limit: 10 })).map((e) => e.outcome)).toEqual(["ALLOWED"]);
    const ranged = await q.search({ tenantId: TENANT_ID, from: "2026-10-17T15:00:10.000Z", to: "2026-10-17T15:00:20.000Z", limit: 10 });
    expect(ranged.map((e) => e.occurredAt)).toEqual(["2026-10-17T15:00:10.000Z"]);
    expect(await q.search({ tenantId: TENANT_ID, limit: 1 })).toHaveLength(1);
  });

  it("[SPEC-13.5] rejects unbounded or malformed filters", async () => {
    const q = new PgAuditQuery(db);
    await expect(q.search({ tenantId: TENANT_ID, limit: 201 })).rejects.toBeInstanceOf(ValidationError);
    await expect(q.search({ tenantId: TENANT_ID, limit: 0 })).rejects.toBeInstanceOf(ValidationError);
    await expect(q.search({ tenantId: "not a tenant", limit: 5 })).rejects.toBeInstanceOf(ValidationError);
    await expect(q.search({ tenantId: TENANT_ID, action: "drop table", limit: 5 })).rejects.toBeInstanceOf(ValidationError);
    await expect(q.search({ tenantId: TENANT_ID, from: "2026-10-18T00:00:00.000Z", to: "2026-10-17T00:00:00.000Z", limit: 5 })).rejects.toBeInstanceOf(ValidationError);
    await expect(q.search({ tenantId: TENANT_ID, limit: 5, ...({ subjectName: "Avery" } as object) } as { tenantId: string; limit: number })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it("[DATA-01] results carry security metadata only: pseudonymous session refs, no free text", async () => {
    const [e] = await new PgAuditQuery(db).search({ tenantId: TENANT_ID, limit: 1 });
    expect(e!.sessionRef).toMatch(/^sref_/);
    expect(Object.keys(e!).sort()).toEqual(
      [
        "action", "actorRef", "afterHash", "assurance", "beforeHash", "callId", "correlationId", "dataClass", "evidencePointers", "eventId",
        "hash", "idempotencyKey", "occurredAt", "outcome", "parentId", "policyDecision", "prevHash", "reasonCode", "role", "schemaVersion",
        "sequence", "sessionGeneration", "sessionRef", "sourceComponent", "sourceStream", "subjectRef", "tenantId", "turnId", "versions",
      ].sort(),
    );
  });

  it("[SPEC-13.5] auditedSearch records the access itself and fails closed if that record cannot be written", async () => {
    const accessor = { tenantId: TENANT_ID, staffRef: STAFF.auditor.staffId, role: "auditor" as const, correlationId: "cor_synthAuditorQuery01" };
    const q = new PgAuditQuery(db);
    const results = await auditedSearch(q, writer, clock, accessor, { tenantId: TENANT_ID, limit: 50 });
    expect(results).toHaveLength(3);
    const access = await q.search({ tenantId: TENANT_ID, action: "audit.query.executed", limit: 5 });
    expect(access).toHaveLength(1);
    expect(access[0]).toMatchObject({ actorRef: STAFF.auditor.staffId, role: "auditor", sourceComponent: "console", occurredAt: iso(clock.now()) });

    const outage = new AuditWriterOutageFixture(writer);
    outage.setOutage(true);
    await expect(auditedSearch(q, outage, clock, accessor, { tenantId: TENANT_ID, limit: 50 })).rejects.toMatchObject({ name: "AuditUnavailableError" });
    await expect(auditedSearch(q, writer, clock, accessor, { tenantId: OTHER_TENANT_ID, limit: 5 })).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(auditedSearch(q, writer, clock, { ...accessor, role: "support_agent" }, { tenantId: TENANT_ID, limit: 5 })).rejects.toBeInstanceOf(AccessDeniedError);
  });
});
