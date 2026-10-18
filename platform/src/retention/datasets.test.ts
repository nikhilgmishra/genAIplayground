/**
 * Platform dataset registration for the retention job (spec section 6; DATA-03, OPS-03) over the
 * full migration set on PGlite. Durations used here are TEST-ONLY placeholders labelled as such:
 * retention durations are set by privacy counsel, never by this code. All data is SYNTHETIC.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { PgliteDb } from "../db/pglite.js";
import { createTestDb } from "../db/testing.js";
import { STAFF, TENANT_ID } from "../fixtures/synthetic-world.js";
import { InTxAuditWriterFixture } from "../knowledge/testing.js";
import type { DataClass, StaffActor } from "../protocol/index.js";
import { FakeClock } from "../shared/clock.js";
import {
  CONSOLE_IDEMPOTENCY_DATASET,
  PLATFORM_RETENTION_DATASETS,
  SUPPORT_REQUESTS_DATASET,
  TOOL_REQUEST_IDEMPOTENCY_DATASET,
  createPlatformDatasetRegistry,
} from "./datasets.js";
import { RetentionJob, keyDigest } from "./job.js";
import { RetentionPolicyStorePg } from "./policies.js";
import { DatasetRegistry, SUPPORT_MEMORY_DATASET } from "./registry.js";
import { TestOnlyRetentionApprovalVerifierFixture } from "./testing.js";

const NOW = "2026-10-17T15:00:00.000Z";
const DAY = 86_400_000;
const APPROVAL = "apr_testOnlyRetentionSchedule";
/** TEST-ONLY arbitrary placeholder duration (not an approved value). */
const TEST_ONLY_DAYS = 30;

let db: PgliteDb | undefined;
afterEach(async () => {
  await db?.close();
  db = undefined;
});

const securityAdmin = (): StaffActor => ({ staffId: STAFF.securityAdmin.staffId, roles: [...STAFF.securityAdmin.roles], mfa: true, authenticatedAt: NOW, breakGlass: null });
const ago = (days: number) => new Date(Date.parse(NOW) - days * DAY).toISOString();

async function setup() {
  db = await createTestDb();
  const clock = new FakeClock(NOW);
  const audit = await InTxAuditWriterFixture.install(db);
  const policies = new RetentionPolicyStorePg({ db, approvals: new TestOnlyRetentionApprovalVerifierFixture(new Set([APPROVAL])), clock, audit });
  const approveAll = async () => {
    for (const dataClass of ["TRANSIENT_CONVERSATION", "BUSINESS_RECORD", "RESTRICTED_QA_MEDIA", "SECURITY_AUDIT"] as DataClass[]) {
      await policies.define({ tenantId: TENANT_ID, dataClass, retentionDays: TEST_ONLY_DAYS, legalPurpose: "TEST_ONLY_PLACEHOLDER_PURPOSE", approvalId: APPROVAL, staff: securityAdmin() });
    }
  };
  const job = new RetentionJob({ db, registry: createPlatformDatasetRegistry(), tenantIds: [TENANT_ID], clock, audit });
  return { db, clock, approveAll, job };
}

async function seedToolIdempotency(d: PgliteDb, rows: { integration: string; key: string; ageDays: number }[]) {
  for (const r of rows) {
    const created = ago(r.ageDays);
    await d.tx(
      (tx) =>
        tx.query(
          `insert into tool_request_idempotency (tenant_id, integration_id, idempotency_key, request_hash, tool_name, tool_version, status, response,
             lease_until, created_at, completed_at, expires_at, updated_at)
           values ($1, $2, $3, $4, 'get_invoice_status', '1.0.0', 'COMPLETED', '{"status":"SUCCESS"}'::jsonb, null, $5::timestamptz, $5::timestamptz,
             ($5::timestamptz + interval '1 day'), $5::timestamptz)`,
          [TENANT_ID, r.integration, r.key, "a".repeat(64), created],
        ),
      { role: "owner" },
    );
  }
}

async function seedConsoleIdempotency(d: PgliteDb, ageDays: number) {
  const created = ago(ageDays);
  await d.tx(
    (tx) =>
      tx.query(
        `insert into console_idempotency (tenant_id, staff_id, endpoint, idempotency_key_hash, request_digest, status, response_status, response_body, created_at, expires_at)
         values ($1, $2, 'outbox.requeue', $3, $4, 'COMPLETED', 200, '{"requeued":true}'::jsonb, $5::timestamptz, ($5::timestamptz + interval '1 day'))`,
        [TENANT_ID, STAFF.supervisor.staffId, "b".repeat(64), "c".repeat(64), created],
      ),
    { role: "owner" },
  );
}

const count = async (d: PgliteDb, table: string) => Number((await d.tx((tx) => tx.query<{ n: number }>(`select count(*)::int as n from ${table}`), { role: "owner" })).rows[0]?.n ?? 0);

describe("platform retention datasets", () => {
  it("[DATA-03] registers support records, interactions, outcomes and the idempotency stores with their data classes", () => {
    const registry = createPlatformDatasetRegistry();
    expect(registry.list().map((d) => [d.name, d.dataClass, d.deleteStrategy])).toEqual([
      ["console_idempotency", "SECURITY_AUDIT", "HARD_DELETE"],
      ["interaction_actions", "BUSINESS_RECORD", "APPEND_ONLY_PURGE_REQUIRED"],
      ["interaction_outcomes", "BUSINESS_RECORD", "APPEND_ONLY_PURGE_REQUIRED"],
      ["support_interactions", "BUSINESS_RECORD", "APPEND_ONLY_PURGE_REQUIRED"],
      ["support_memory", "BUSINESS_RECORD", "HARD_DELETE"],
      ["support_request_links", "BUSINESS_RECORD", "APPEND_ONLY_PURGE_REQUIRED"],
      ["support_requests", "BUSINESS_RECORD", "APPEND_ONLY_PURGE_REQUIRED"],
      ["tool_request_idempotency", "TRANSIENT_CONVERSATION", "HARD_DELETE"],
    ]);
    expect(PLATFORM_RETENTION_DATASETS).toHaveLength(8);
    // Derived copies: links of a deleted request, the Salesforce Case copy, unverifiable backups.
    expect(SUPPORT_REQUESTS_DATASET.derivedCopies.map((v) => [v.name, v.location])).toEqual([
      ["support_request_links_by_request", "DERIVED_TABLE"],
      ["database_backups", "BACKUP"],
    ]);
    expect(SUPPORT_REQUESTS_DATASET.vendorCopies).toEqual([{ vendor: "salesforce", refColumn: "salesforce_case_id" }]);
    expect(TOOL_REQUEST_IDEMPOTENCY_DATASET.keyColumns).toEqual(["integration_id", "idempotency_key"]);
    expect(CONSOLE_IDEMPOTENCY_DATASET.keyColumns).toEqual(["staff_id", "endpoint", "idempotency_key_hash"]);
    // The configuration digest (ReleaseManifest.retentionConfigurationDigest) changes with the registration.
    expect(registry.digest()).not.toBe(new DatasetRegistry().register(SUPPORT_MEMORY_DATASET).digest());
    expect(createPlatformDatasetRegistry().digest()).toBe(registry.digest());
  });

  it("[DATA-03] composite-key declarations are validated", () => {
    const r = new DatasetRegistry();
    expect(() => r.register({ ...TOOL_REQUEST_IDEMPOTENCY_DATASET, keyColumns: ["idempotency_key"] })).toThrow("RETENTION_KEY_COLUMNS_INVALID");
    expect(() => r.register({ ...TOOL_REQUEST_IDEMPOTENCY_DATASET, keyColumns: ["idempotency_key", "integration_id"] })).toThrow("RETENTION_KEY_COLUMNS_INVALID");
    expect(() => r.register({ ...TOOL_REQUEST_IDEMPOTENCY_DATASET, keyColumns: ["integration_id", 'x"; drop table y; --'] })).toThrow("RETENTION_IDENTIFIER_INVALID");
  });

  it("[DATA-03][OPS-03] without counsel-approved durations every class is BLOCKED_RETENTION_UNSET and nothing is deleted", async () => {
    const { db, job } = await setup();
    await seedToolIdempotency(db, [{ integration: "talkdesk-mcp-local", key: "synthIdemKey000000000001", ageDays: 400 }]);
    await seedConsoleIdempotency(db, 400);
    const [report] = await job.run(new Date(NOW));
    expect(report?.status).toBe("BLOCKED_RETENTION_UNSET");
    expect(report?.classes.every((c) => c.status === "BLOCKED_RETENTION_UNSET")).toBe(true);
    expect(report?.datasets.every((d) => d.status === "SKIPPED_RETENTION_UNSET" && d.deletedCount === 0)).toBe(true);
    expect(report?.datasets).toHaveLength(8);
    expect(await count(db, "tool_request_idempotency")).toBe(1);
    expect(await count(db, "console_idempotency")).toBe(1);
  });

  it("[DATA-03][OPS-03][ACT-02] with TEST-ONLY durations: idempotency rows are purged by their full composite key; append-only support records report a required purge path; missing worker privilege is reported, never a silent no-op", async () => {
    const { db, job, approveAll } = await setup();
    await approveAll();
    // The same client key under two integrations: only the expired one may go (a live replay record must survive).
    await seedToolIdempotency(db, [
      { integration: "talkdesk-mcp-local", key: "synthIdemKeyShared000001", ageDays: 45 },
      { integration: "talkdesk-telephony-local", key: "synthIdemKeyShared000001", ageDays: 1 },
      { integration: "talkdesk-mcp-local", key: "synthIdemKeyFresh0000001", ageDays: 2 },
    ]);
    await seedConsoleIdempotency(db, 45);
    const [report] = await job.run(new Date(NOW));
    const byName = new Map(report?.datasets.map((d) => [d.dataset, d]));

    const tool = byName.get("tool_request_idempotency");
    expect(tool).toMatchObject({ status: "DELETED", deletedCount: 1, keyDigest: keyDigest(["talkdesk-mcp-local/synthIdemKeyShared000001"]) });
    expect(tool?.verifications).toEqual([expect.objectContaining({ verifier: "database_backups", location: "BACKUP", status: "UNVERIFIABLE" })]);
    const left = await db.tx((tx) => tx.query<{ integration_id: string; idempotency_key: string }>("select integration_id, idempotency_key from tool_request_idempotency order by integration_id, idempotency_key"), { role: "owner" });
    expect(left.rows).toEqual([
      { integration_id: "talkdesk-mcp-local", idempotency_key: "synthIdemKeyFresh0000001" },
      { integration_id: "talkdesk-telephony-local", idempotency_key: "synthIdemKeyShared000001" },
    ]);

    for (const name of ["support_requests", "support_request_links", "support_interactions", "interaction_actions", "interaction_outcomes"]) {
      expect(byName.get(name), name).toMatchObject({ status: "STRATEGY_BLOCKED", reasonCode: "RETENTION_PURGE_PATH_REQUIRED", deletedCount: 0 });
    }
    expect(byName.get("console_idempotency")).toMatchObject({ status: "STRATEGY_BLOCKED", reasonCode: "RETENTION_DELETE_PRIVILEGE_MISSING", deletedCount: 0 });
    expect(await count(db, "console_idempotency")).toBe(1);
    expect(report?.status).toBe("COMPLETED_WITH_UNVERIFIED_COPIES");
    expect(report?.unverifiedCopies.some((u) => u.dataset === "tool_request_idempotency" && u.status === "UNVERIFIABLE")).toBe(true);
    // Deletion evidence is content-free: dataset, counts and digests only.
    const evidence = await db.tx((tx) => tx.query<{ dataset: string; deleted_count: number }>("select dataset, deleted_count from deletion_records"), { role: "owner" });
    expect(evidence.rows).toEqual([{ dataset: "tool_request_idempotency", deleted_count: 1 }]);
  });

  it("[DATA-03][OPS-03] expired rows that the worker cannot delete (no row-level DELETE policy) make the dataset FAILED, never NOTHING_EXPIRED", async () => {
    const { db, approveAll } = await setup();
    await approveAll();
    await db.exec(`
      create table test_rls_blocked (row_id text primary key, tenant_id text not null, created_at timestamptz not null);
      alter table test_rls_blocked enable row level security;
      alter table test_rls_blocked force row level security;
      create policy test_rls_blocked_read on test_rls_blocked for select to app_worker using (tenant_id = app_tenant());
      grant select, delete on test_rls_blocked to app_worker;
    `);
    await db.tx((tx) => tx.query("insert into test_rls_blocked values ('row_synthBlockedRow000001', $1, $2::timestamptz)", [TENANT_ID, ago(90)]), { role: "owner" });
    const registry = new DatasetRegistry().register({
      name: "test_rls_blocked",
      table: "test_rls_blocked",
      dataClass: "TRANSIENT_CONVERSATION",
      timestampColumn: "created_at",
      tenantColumn: "tenant_id",
      keyColumn: "row_id",
      subjectColumn: null,
      deleteStrategy: "HARD_DELETE",
      derivedCopies: [],
      vendorCopies: [],
      owner: "test",
    });
    const [report] = await new RetentionJob({ db, registry, tenantIds: [TENANT_ID], clock: new FakeClock(NOW) }).run(new Date(NOW));
    expect(report?.datasets[0]).toMatchObject({ status: "FAILED", reasonCode: "RETENTION_DELETE_BLOCKED", deletedCount: 0 });
    expect(report?.status).toBe("FAILED");
    expect(await count(db, "test_rls_blocked")).toBe(1);
  });
});
