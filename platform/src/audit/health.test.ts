import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PgliteDb } from "../db/pglite.js";
import { FakeClock } from "../shared/clock.js";
import { AuditUnavailableError, ValidationError } from "../shared/errors.js";
import { FaultInjectingAuditSinkFixture, StaticAuditHealthFixture } from "./fixtures.js";
import { PgAuditHealth } from "./health.js";
import { AuditShipper } from "./shipper.js";
import { LocalFsAuditSinkFixture } from "./sinks/local-fs.js";
import { TENANT_ID, appendMany, createAuditTestDb } from "./testing.js";
import { PgAuditWriter } from "./writer.js";

let db: PgliteDb;
let clock: FakeClock;
let root: string;
let writer: PgAuditWriter;

beforeEach(async () => {
  db = await createAuditTestDb();
  clock = new FakeClock();
  root = mkdtempSync(join(tmpdir(), "vsp-audit-health-"));
  writer = new PgAuditWriter({ db, clock, stream: "gateway.synth-1" });
});
afterEach(async () => {
  await db.close();
  rmSync(root, { recursive: true, force: true });
});

const health = (maxBacklog = 5, maxBacklogAgeSeconds = 60) =>
  new PgAuditHealth({ db, clock, policy: { maxBacklog, maxBacklogAgeSeconds }, probeId: "gateway.synth-1", tenantId: TENANT_ID });

describe("PgAuditHealth bounded buffering policy", () => {
  it("[OPS-01] healthy when the backlog is within count and age bounds and the write probe succeeds", async () => {
    await appendMany(3, (i) => writer.appendStandalone(i), clock);
    clock.advanceSeconds(30);
    expect(await health().status()).toEqual({
      canAcceptConsequential: true,
      backlogCount: 3,
      oldestUnshippedAgeSeconds: 30,
      sinkHealthy: true,
      reasonCode: null,
    });
    await expect(health().assertCanAcceptConsequential()).resolves.toBeUndefined();
  });

  it("[OPS-01] blocks consequential actions when the backlog count exceeds maxBacklog", async () => {
    await appendMany(6, (i) => writer.appendStandalone(i), clock);
    const s = await health(5).status();
    expect(s).toMatchObject({ canAcceptConsequential: false, backlogCount: 6, reasonCode: "AUDIT_BACKLOG_EXCEEDED" });
    await expect(health(5).assertCanAcceptConsequential()).rejects.toMatchObject({ name: "AuditUnavailableError", reasonCode: "AUDIT_BACKLOG_EXCEEDED" });
  });

  it("[OPS-01] blocks consequential actions when the oldest unshipped event is older than maxBacklogAgeSeconds", async () => {
    await appendMany(1, (i) => writer.appendStandalone(i), clock);
    clock.advanceSeconds(61);
    const s = await health(5, 60).status();
    expect(s).toMatchObject({ canAcceptConsequential: false, oldestUnshippedAgeSeconds: 61, sinkHealthy: false, reasonCode: "AUDIT_SINK_STALE" });
    await expect(health(5, 60).assertCanAcceptConsequential()).rejects.toBeInstanceOf(AuditUnavailableError);
  });

  it("[OPS-01] shipping the backlog restores health; a sink outage within bounds is tolerated but reported", async () => {
    const faulty = new FaultInjectingAuditSinkFixture(new LocalFsAuditSinkFixture(root));
    const shipper = new AuditShipper({ db, sink: faulty, clock });
    await appendMany(2, (i) => writer.appendStandalone(i), clock);
    faulty.failPuts(1);
    await shipper.runOnce();
    const during = await health().status();
    expect(during).toMatchObject({ canAcceptConsequential: true, sinkHealthy: false, backlogCount: 2 });
    clock.advanceSeconds(120);
    expect(await health().status()).toMatchObject({ canAcceptConsequential: false, reasonCode: "AUDIT_SINK_STALE" });
    await shipper.runOnce();
    expect(await health().status()).toEqual({ canAcceptConsequential: true, backlogCount: 0, oldestUnshippedAgeSeconds: null, sinkHealthy: true, reasonCode: null });
  });

  it("[OPS-01] reports AUDIT_STORE_UNWRITABLE when the writer role lost its audit privileges", async () => {
    await db.exec("revoke insert on audit_outbox from app_runtime");
    expect(await health().status()).toMatchObject({ canAcceptConsequential: false, reasonCode: "AUDIT_STORE_UNWRITABLE" });
  });

  it("[OPS-01] reports AUDIT_STORE_UNWRITABLE when the audit store cannot be reached", async () => {
    await db.exec("revoke execute on function audit_backlog_stats() from app_runtime");
    expect(await health().status()).toMatchObject({ canAcceptConsequential: false, reasonCode: "AUDIT_STORE_UNWRITABLE" });
    const closed = await createAuditTestDb();
    const h = new PgAuditHealth({ db: closed, clock, policy: { maxBacklog: 1, maxBacklogAgeSeconds: 1 }, probeId: "gateway.synth-1" });
    await closed.close();
    await expect(h.assertCanAcceptConsequential()).rejects.toMatchObject({ reasonCode: "AUDIT_STORE_UNWRITABLE" });
  });

  it("[OPS-01] optional caching reuses only healthy results, never blocked ones", async () => {
    const h = new PgAuditHealth({ db, clock, policy: { maxBacklog: 5, maxBacklogAgeSeconds: 60 }, probeId: "gateway.synth-1", cacheTtlMs: 1000 });
    expect((await h.status()).canAcceptConsequential).toBe(true);
    await db.exec("revoke insert on audit_outbox from app_runtime");
    expect((await h.status()).canAcceptConsequential).toBe(true); // within TTL: cached healthy result
    clock.advanceMs(1000);
    expect(await h.status()).toMatchObject({ canAcceptConsequential: false, reasonCode: "AUDIT_STORE_UNWRITABLE" });
    await db.exec("grant insert on audit_outbox to app_runtime");
    await db.exec("revoke insert on audit_outbox from app_runtime");
    expect((await h.status()).canAcceptConsequential).toBe(false); // blocked results are not cached as healthy
    await db.exec("grant insert on audit_outbox to app_runtime");
    expect((await h.status()).canAcceptConsequential).toBe(true); // and recovery is seen immediately
    expect(() => new PgAuditHealth({ db, clock, policy: { maxBacklog: 5, maxBacklogAgeSeconds: 60 }, probeId: "gateway.synth-1", cacheTtlMs: 60_000 })).toThrow(ValidationError);
  });

  it("[OPS-01] rejects an invalid buffering policy instead of running unbounded", () => {
    expect(() => health(-1)).toThrow(ValidationError);
    expect(() => health(5, 0)).toThrow(ValidationError);
    expect(() => new PgAuditHealth({ db, clock, policy: { maxBacklog: 1, maxBacklogAgeSeconds: 1 }, probeId: "Bad Probe" })).toThrow(ValidationError);
  });

  it("[OPS-01] StaticAuditHealthFixture (LOCAL FIXTURE) lets other modules exercise the blocked path", async () => {
    const f = new StaticAuditHealthFixture();
    expect(f.kind).toBe("local_fixture");
    await expect(f.assertCanAcceptConsequential()).resolves.toBeUndefined();
    f.setBlocked("AUDIT_BACKLOG_EXCEEDED");
    await expect(f.assertCanAcceptConsequential()).rejects.toMatchObject({ reasonCode: "AUDIT_BACKLOG_EXCEEDED" });
    f.setHealthy();
    expect((await f.status()).canAcceptConsequential).toBe(true);
  });
});
