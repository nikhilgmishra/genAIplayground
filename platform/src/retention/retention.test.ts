import { afterEach, describe, expect, it } from "vitest";
import type { PgliteDb } from "../db/pglite.js";
import { createTestDb } from "../db/testing.js";
import { OTHER_TENANT_ID, PEOPLE, STAFF, TENANT_ID } from "../fixtures/synthetic-world.js";
import { InTxAuditWriterFixture } from "../knowledge/testing.js";
import { SupportMemoryPg } from "../memory/support-memory.js";
import { createMemoryLogger } from "../observability/logger.js";
import type { DataClass, StaffActor } from "../protocol/index.js";
import { FakeClock } from "../shared/clock.js";
import { AccessDeniedError, AuditUnavailableError, ValidationError } from "../shared/errors.js";
import { RetentionJob, keyDigest } from "./job.js";
import { LegalHoldStorePg, RetentionPolicyStorePg, VendorDeletionQueuePg } from "./policies.js";
import type { RetentionDataset } from "./ports.js";
import { DatasetRegistry, SUPPORT_MEMORY_DATASET } from "./registry.js";
import { TestOnlyRetentionApprovalVerifierFixture } from "./testing.js";
import { cacheVerifier, derivedTableVerifier, unverifiableCopy } from "./verifiers.js";

let db: PgliteDb | undefined;
afterEach(async () => {
  await db?.close();
  db = undefined;
});

const NOW = "2026-10-17T15:00:00.000Z";
const DAY = 86_400_000;
const AVERY = PEOPLE.avery.subjectId;
const BLAKE = PEOPLE.blake.subjectId;
const APPROVAL = "apr_testOnlyRetentionSchedule";
/** TEST-ONLY arbitrary placeholder duration: retention is set by privacy counsel, never by this code. */
const TEST_ONLY_DAYS = 30;

const staff = (key: keyof typeof STAFF, over: Partial<StaffActor> = {}): StaffActor => ({
  staffId: STAFF[key].staffId,
  roles: [...STAFF[key].roles],
  mfa: true,
  authenticatedAt: NOW,
  breakGlass: null,
  ...over,
});

const tid = (n: number) => `trn_synthTranscript${String(n).padStart(6, "0")}`;
const aid = (n: number) => `aud_synthAudioRef${String(n).padStart(8, "0")}`;

/** SYNTHETIC test tables owned by this test: transcripts with a derived index, and audio references without a subject column. */
async function setup() {
  db = await createTestDb({ include: /^0[78]/ });
  await db.exec(`
    create table test_call_transcripts (transcript_id text primary key, tenant_id text not null, subject_id text, created_at timestamptz not null, vendor_ref text);
    create table test_transcript_index (tenant_id text not null, transcript_id text not null, term_digest text not null);
    create table test_audio_refs (audio_id text primary key, tenant_id text not null, created_at timestamptz not null);
    alter table test_call_transcripts enable row level security;
    alter table test_transcript_index enable row level security;
    alter table test_audio_refs enable row level security;
    create policy t1 on test_call_transcripts for all to app_worker using (tenant_id = app_tenant());
    create policy t2 on test_transcript_index for select to app_worker using (tenant_id = app_tenant());
    create policy t3 on test_audio_refs for all to app_worker using (tenant_id = app_tenant());
    grant select, delete on test_call_transcripts, test_audio_refs to app_worker;
    grant select on test_transcript_index to app_worker;
  `);
  const clock = new FakeClock(NOW);
  const audit = await InTxAuditWriterFixture.install(db);
  const approvals = new TestOnlyRetentionApprovalVerifierFixture(new Set([APPROVAL]));
  const policies = new RetentionPolicyStorePg({ db, approvals, clock, audit });
  const holds = new LegalHoldStorePg({ db, clock, audit });
  const vendor = new VendorDeletionQueuePg({ db, clock, audit });
  return { db, clock, audit, policies, holds, vendor };
}

async function seedTranscripts(d: PgliteDb, rows: { n: number; ageDays: number; subject?: string; tenant?: string; vendorRef?: string | null; indexed?: boolean }[]) {
  for (const r of rows) {
    const createdAt = new Date(Date.parse(NOW) - r.ageDays * DAY).toISOString();
    await d.query("insert into test_call_transcripts values ($1, $2, $3, $4::timestamptz, $5)", [tid(r.n), r.tenant ?? TENANT_ID, r.subject ?? AVERY, createdAt, r.vendorRef ?? null]);
    if (r.indexed) await d.query("insert into test_transcript_index values ($1, $2, $3)", [r.tenant ?? TENANT_ID, tid(r.n), "0".repeat(64)]);
  }
}

function transcriptsDataset(extra: Partial<RetentionDataset> = {}): RetentionDataset {
  return {
    name: "test_call_transcripts",
    table: "test_call_transcripts",
    dataClass: "TRANSIENT_CONVERSATION",
    timestampColumn: "created_at",
    tenantColumn: "tenant_id",
    keyColumn: "transcript_id",
    subjectColumn: "subject_id",
    deleteStrategy: "HARD_DELETE",
    derivedCopies: [],
    vendorCopies: [],
    owner: "test",
    ...extra,
  };
}

const remaining = async (d: PgliteDb) => (await d.query<{ transcript_id: string }>("select transcript_id from test_call_transcripts order by transcript_id")).rows.map((r) => r.transcript_id);

async function approve(policies: RetentionPolicyStorePg, dataClass: DataClass, days = TEST_ONLY_DAYS, tenantId = TENANT_ID) {
  return policies.define({ tenantId, dataClass, retentionDays: days, legalPurpose: "TEST_ONLY_PLACEHOLDER_PURPOSE", approvalId: APPROVAL, staff: staff("securityAdmin") });
}

describe("RetentionJob", () => {
  it("[DATA-03] classes without an approved duration are BLOCKED_RETENTION_UNSET and nothing is deleted", async () => {
    const { db, policies } = await setup();
    await seedTranscripts(db, [{ n: 1, ageDays: 400 }, { n: 2, ageDays: 1 }]);
    const registry = new DatasetRegistry().register(transcriptsDataset());
    const { logger, records } = createMemoryLogger();
    const job = new RetentionJob({ db, registry, tenantIds: [TENANT_ID], clock: new FakeClock(NOW), logger });
    const [report] = await job.run(new Date(NOW));
    expect(report?.status).toBe("BLOCKED_RETENTION_UNSET");
    expect(report?.classes.map((c) => c.status)).toEqual(["BLOCKED_RETENTION_UNSET", "BLOCKED_RETENTION_UNSET", "BLOCKED_RETENTION_UNSET", "BLOCKED_RETENTION_UNSET"]);
    expect(report?.classes.every((c) => c.retentionDays === null && c.cutoff === null)).toBe(true);
    expect(report?.datasets).toEqual([expect.objectContaining({ dataset: "test_call_transcripts", status: "SKIPPED_RETENTION_UNSET", deletedCount: 0 })]);
    expect(await remaining(db)).toEqual([tid(1), tid(2)]);
    expect(records.filter((r) => r.event === "retention.class.blocked")).toHaveLength(4);
    // An explicit "unset" policy (null duration) is equally blocked.
    await policies.define({ tenantId: TENANT_ID, dataClass: "TRANSIENT_CONVERSATION", retentionDays: null, legalPurpose: null, approvalId: null, staff: staff("securityAdmin") });
    const [again] = await job.run(new Date(NOW));
    expect(again?.classes.find((c) => c.dataClass === "TRANSIENT_CONVERSATION")).toMatchObject({ status: "BLOCKED_RETENTION_UNSET", policyVersion: 1 });
    expect(await remaining(db)).toEqual([tid(1), tid(2)]);
    const runs = await db.query<{ status: string }>("select status from retention_runs order by started_at");
    expect(runs.rows.map((r) => r.status)).toEqual(["BLOCKED_RETENTION_UNSET", "BLOCKED_RETENTION_UNSET"]);
  });

  it("[DATA-03] a duration needs an approval verified by the approval verifier, a legal purpose and authorized MFA staff", async () => {
    const { db, policies } = await setup();
    const base = { tenantId: TENANT_ID, dataClass: "BUSINESS_RECORD" as const, retentionDays: TEST_ONLY_DAYS, legalPurpose: "TEST_ONLY_PLACEHOLDER_PURPOSE" };
    await expect(policies.define({ ...base, approvalId: null, staff: staff("securityAdmin") })).rejects.toThrow("RETENTION_DURATION_REQUIRES_APPROVAL_AND_PURPOSE");
    await expect(policies.define({ ...base, approvalId: "apr_notARealApproval01", staff: staff("securityAdmin") })).rejects.toThrow("RETENTION_APPROVAL_INVALID");
    await expect(policies.define({ ...base, approvalId: APPROVAL, staff: staff("agent") })).rejects.toThrow(AccessDeniedError);
    await expect(policies.define({ ...base, approvalId: APPROVAL, staff: staff("securityAdmin", { mfa: false }) })).rejects.toThrow("STAFF_MFA_REQUIRED");
    const p = await policies.define({ ...base, approvalId: APPROVAL, staff: staff("policyApprover") });
    expect(p).toMatchObject({ retentionDays: TEST_ONLY_DAYS, approvalId: APPROVAL, approvedBy: "privacy_counsel", policyVersion: 1 });
    // The database itself refuses a duration without approval, and policy history is append-only.
    await expect(
      db.exec(`insert into retention_policies (tenant_id, data_class, policy_version, retention_days, defined_by, defined_at) values ('${TENANT_ID}', 'SECURITY_AUDIT', 1, 10, 'stf_synthSecurityAdm1', now())`),
    ).rejects.toThrow(/retention_policies_duration_requires_approval/);
    await expect(db.exec("update retention_policies set retention_days = 1")).rejects.toThrow(/RETENTION_EVIDENCE_APPEND_ONLY/);
  });

  it("[DATA-03] expired rows are deleted, unexpired and held rows are kept, and deletion evidence holds counts and digests only", async () => {
    const { db, policies, holds, audit } = await setup();
    await approve(policies, "TRANSIENT_CONVERSATION");
    await seedTranscripts(db, [
      { n: 1, ageDays: 31 },
      { n: 2, ageDays: 45 },
      { n: 3, ageDays: 29 },
      { n: 4, ageDays: 60, subject: BLAKE },
      { n: 5, ageDays: 60 },
      { n: 6, ageDays: 90, tenant: OTHER_TENANT_ID },
    ]);
    // Subject hold (Blake) and record hold (transcript 5).
    await holds.place({ tenantId: TENANT_ID, subjectId: BLAKE, matterRef: "mtr_synthMatterReference1", reasonCode: "LITIGATION_HOLD", staff: staff("securityAdmin") });
    await holds.place({ tenantId: TENANT_ID, recordKey: tid(5), dataset: "test_call_transcripts", matterRef: "mtr_synthMatterReference2", reasonCode: "COMPLAINT_INVESTIGATION", staff: staff("policyApprover") });
    const registry = new DatasetRegistry().register(transcriptsDataset());
    const job = new RetentionJob({ db, registry, tenantIds: [TENANT_ID], clock: new FakeClock(NOW), audit });
    const [report] = await job.run(new Date(NOW));
    expect(report?.status).toBe("COMPLETED");
    const ds = report?.datasets[0];
    expect(ds).toMatchObject({ status: "DELETED", deletedCount: 2, heldCount: 2, keyDigest: keyDigest([tid(1), tid(2)]) });
    expect(await remaining(db)).toEqual([tid(3), tid(4), tid(5), tid(6)]);
    const cls = report?.classes.find((c) => c.dataClass === "TRANSIENT_CONVERSATION");
    expect(cls).toMatchObject({ status: "EXECUTED", retentionDays: TEST_ONLY_DAYS, approvalId: APPROVAL, cutoff: new Date(Date.parse(NOW) - TEST_ONLY_DAYS * DAY).toISOString() });
    const evidence = await db.query<Record<string, unknown>>("select * from deletion_records");
    expect(evidence.rows).toHaveLength(1);
    expect(evidence.rows[0]).toMatchObject({ dataset: "test_call_transcripts", deleted_count: 2, held_count: 2, approval_id: APPROVAL, key_digest: keyDigest([tid(1), tid(2)]) });
    expect(JSON.stringify(evidence.rows)).not.toContain(tid(1));
    await expect(db.exec("delete from deletion_records")).rejects.toThrow(/RETENTION_EVIDENCE_APPEND_ONLY/);
    const actions = (await audit.committed()).map((e) => e.action).sort();
    expect(actions).toEqual(["retention.delete", "retention.hold.place", "retention.hold.place", "retention.policy.define"]);
    // A second run is idempotent: nothing more expired.
    const [second] = await job.run(new Date(NOW));
    expect(second?.datasets[0]).toMatchObject({ status: "NOTHING_EXPIRED", deletedCount: 0 });
  });

  it("[DATA-03] legal holds by class, dataset and tenant-wide scope are respected; holds are never deleted and release once", async () => {
    const { db, policies, holds } = await setup();
    await approve(policies, "TRANSIENT_CONVERSATION");
    await seedTranscripts(db, [{ n: 1, ageDays: 40 }]);
    const registry = new DatasetRegistry().register(transcriptsDataset());
    const job = new RetentionJob({ db, registry, tenantIds: [TENANT_ID], clock: new FakeClock(NOW) });
    const tenantWide = await holds.place({ tenantId: TENANT_ID, matterRef: "mtr_synthMatterReference3", reasonCode: "REGULATOR_REQUEST", staff: staff("securityAdmin") });
    expect((await job.run(new Date(NOW)))[0]?.datasets[0]).toMatchObject({ deletedCount: 0, heldCount: 1 });
    await holds.release({ tenantId: TENANT_ID, holdId: tenantWide.holdId, reasonCode: "MATTER_CLOSED", staff: staff("securityAdmin") });
    await expect(holds.release({ tenantId: TENANT_ID, holdId: tenantWide.holdId, reasonCode: "MATTER_CLOSED", staff: staff("securityAdmin") })).rejects.toThrow("LEGAL_HOLD_NOT_ACTIVE");
    await expect(db.exec("delete from legal_holds")).rejects.toThrow(/LEGAL_HOLD_NOT_DELETABLE/);
    await expect(db.exec("update legal_holds set reason_code = 'CHANGED_REASON'")).rejects.toThrow(/LEGAL_HOLD_ONLY_RELEASE_ALLOWED/);
    const classHold = await holds.place({ tenantId: TENANT_ID, dataClass: "TRANSIENT_CONVERSATION", matterRef: "mtr_synthMatterReference4", reasonCode: "LITIGATION_HOLD", staff: staff("securityAdmin") });
    expect((await job.run(new Date(NOW)))[0]?.datasets[0]).toMatchObject({ deletedCount: 0, heldCount: 1 });
    await holds.release({ tenantId: TENANT_ID, holdId: classHold.holdId, reasonCode: "MATTER_CLOSED", staff: staff("securityAdmin") });
    // A hold on a different class does not protect this dataset.
    await holds.place({ tenantId: TENANT_ID, dataClass: "BUSINESS_RECORD", matterRef: "mtr_synthMatterReference5", reasonCode: "LITIGATION_HOLD", staff: staff("securityAdmin") });
    expect((await job.run(new Date(NOW)))[0]?.datasets[0]).toMatchObject({ deletedCount: 1, heldCount: 0 });
    expect((await holds.listActive(TENANT_ID)).map((h) => h.dataClass)).toEqual(["BUSINESS_RECORD"]);
    await expect(holds.place({ tenantId: TENANT_ID, matterRef: "mtr_synthMatterReference6", reasonCode: "free text reason", staff: staff("securityAdmin") })).rejects.toThrow(ValidationError);
    await expect(holds.place({ tenantId: TENANT_ID, matterRef: "mtr_synthMatterReference6", reasonCode: "LITIGATION_HOLD", staff: staff("agent") })).rejects.toThrow(AccessDeniedError);
  });

  it("[DATA-03] a subject-scoped hold on a dataset without a subject column blocks the whole dataset (fail closed)", async () => {
    const { db, policies, holds } = await setup();
    await approve(policies, "RESTRICTED_QA_MEDIA");
    await db.query("insert into test_audio_refs values ($1, $2, $3::timestamptz)", [aid(1), TENANT_ID, new Date(Date.parse(NOW) - 100 * DAY).toISOString()]);
    await holds.place({ tenantId: TENANT_ID, subjectId: AVERY, matterRef: "mtr_synthMatterReference7", reasonCode: "LITIGATION_HOLD", staff: staff("securityAdmin") });
    const registry = new DatasetRegistry().register({ ...transcriptsDataset(), name: "test_audio_refs", table: "test_audio_refs", dataClass: "RESTRICTED_QA_MEDIA", keyColumn: "audio_id", subjectColumn: null });
    const [report] = await new RetentionJob({ db, registry, tenantIds: [TENANT_ID], clock: new FakeClock(NOW) }).run(new Date(NOW));
    expect(report?.datasets[0]).toMatchObject({ status: "HELD_SUBJECT_HOLD_UNRESOLVABLE", deletedCount: 0, heldCount: 1, reasonCode: "LEGAL_HOLD_SUBJECT_SCOPE_UNRESOLVABLE" });
    expect((await db.query<{ n: number }>("select count(*)::int as n from test_audio_refs")).rows[0]?.n).toBe(1);
  });

  it("[DATA-03] derived-copy verification detects leftovers in an index and a cache, and reports backups as unverifiable", async () => {
    const { db, policies } = await setup();
    await approve(policies, "TRANSIENT_CONVERSATION");
    await seedTranscripts(db, [{ n: 1, ageDays: 40, indexed: true }, { n: 2, ageDays: 40 }, { n: 3, ageDays: 40, indexed: true }]);
    const cache = new Map<string, string>([[tid(2), "cached-synthetic"]]);
    const registry = new DatasetRegistry().register(
      transcriptsDataset({
        derivedCopies: [
          derivedTableVerifier({ name: "transcript_index", table: "test_transcript_index", tenantColumn: "tenant_id", sourceKeyColumn: "transcript_id", location: "INDEX" }),
          cacheVerifier("transcript_cache", cache),
          unverifiableCopy("aurora_snapshots", "BACKUP", "BACKUP_DELETION_UNVERIFIABLE_OFFLINE"),
        ],
      }),
    );
    const [report] = await new RetentionJob({ db, registry, tenantIds: [TENANT_ID], clock: new FakeClock(NOW) }).run(new Date(NOW));
    expect(report?.status).toBe("COMPLETED_WITH_UNVERIFIED_COPIES");
    expect(report?.datasets[0]?.deletedCount).toBe(3);
    expect(report?.unverifiedCopies).toEqual([
      { dataset: "test_call_transcripts", verifier: "transcript_index", location: "INDEX", status: "LEFTOVERS_FOUND", leftoverCount: 2, reasonCode: "DERIVED_COPY_LEFTOVERS" },
      { dataset: "test_call_transcripts", verifier: "transcript_cache", location: "CACHE", status: "LEFTOVERS_FOUND", leftoverCount: 1, reasonCode: "DERIVED_COPY_LEFTOVERS" },
      { dataset: "test_call_transcripts", verifier: "aurora_snapshots", location: "BACKUP", status: "UNVERIFIABLE", leftoverCount: 0, reasonCode: "BACKUP_DELETION_UNVERIFIABLE_OFFLINE" },
    ]);
    const rows = await db.query<{ verifier: string; status: string; leftover_count: number; leftover_digest: string | null }>("select verifier, status, leftover_count, leftover_digest from deletion_verifications order by verifier");
    expect(rows.rows).toEqual([
      { verifier: "aurora_snapshots", status: "UNVERIFIABLE", leftover_count: 0, leftover_digest: null },
      { verifier: "transcript_cache", status: "LEFTOVERS_FOUND", leftover_count: 1, leftover_digest: keyDigest([tid(2)]) },
      { verifier: "transcript_index", status: "LEFTOVERS_FOUND", leftover_count: 2, leftover_digest: keyDigest([tid(1), tid(3)]) },
    ]);
    // After cleaning the derived copies, a re-verification of the same keys passes.
    await db.exec("delete from test_transcript_index");
    cache.clear();
    const v = derivedTableVerifier({ name: "transcript_index", table: "test_transcript_index", tenantColumn: "tenant_id", sourceKeyColumn: "transcript_id" });
    expect(await v.verify({ tenantId: TENANT_ID, dataset: "test_call_transcripts", deletedKeys: [tid(1), tid(3)], db })).toEqual({ status: "VERIFIED_ABSENT" });
  });

  it("[DATA-03] vendor copies get PENDING_VENDOR deletion requests; confirmation needs authorized staff and evidence", async () => {
    const { db, policies, vendor } = await setup();
    await approve(policies, "TRANSIENT_CONVERSATION");
    await seedTranscripts(db, [
      { n: 1, ageDays: 40, vendorRef: "td-interaction-synth-aaa" },
      { n: 2, ageDays: 40, vendorRef: "td-interaction-synth-bbb" },
      { n: 3, ageDays: 40, vendorRef: "5555550101" },
    ]);
    const registry = new DatasetRegistry().register(transcriptsDataset({ vendorCopies: [{ vendor: "talkdesk", refColumn: "vendor_ref" }] }));
    const [report] = await new RetentionJob({ db, registry, tenantIds: [TENANT_ID], clock: new FakeClock(NOW) }).run(new Date(NOW));
    expect(report?.datasets[0]?.vendorRequests).toEqual([expect.objectContaining({ vendor: "talkdesk", itemCount: 3, status: "PENDING_VENDOR" })]);
    const [pending] = await vendor.list(TENANT_ID, "PENDING_VENDOR");
    expect(pending).toMatchObject({ vendor: "talkdesk", itemCount: 3, rejectedRefCount: 1, status: "PENDING_VENDOR" });
    const refs = await db.query<{ item_refs: string[] }>("select item_refs from vendor_deletion_requests");
    expect(refs.rows[0]?.item_refs.sort()).toEqual(["td-interaction-synth-aaa", "td-interaction-synth-bbb"]);
    const requestId = pending?.requestId ?? "";
    await expect(vendor.transition({ tenantId: TENANT_ID, requestId, status: "CONFIRMED", evidenceRef: null, staff: staff("securityAdmin") })).rejects.toThrow("VENDOR_DELETION_CONFIRMATION_REQUIRES_EVIDENCE");
    await expect(vendor.transition({ tenantId: TENANT_ID, requestId, status: "SUBMITTED", evidenceRef: null, staff: staff("agent") })).rejects.toThrow(AccessDeniedError);
    // Skipping straight to CONFIRMED is refused by the database transition guard.
    await expect(vendor.transition({ tenantId: TENANT_ID, requestId, status: "CONFIRMED", evidenceRef: "ticket://synth-vendor-ticket-1", staff: staff("securityAdmin") })).rejects.toThrow(/VENDOR_DELETION_REQUEST_TRANSITION_INVALID/);
    await vendor.transition({ tenantId: TENANT_ID, requestId, status: "SUBMITTED", evidenceRef: null, staff: staff("supervisor") });
    await vendor.transition({ tenantId: TENANT_ID, requestId, status: "CONFIRMED", evidenceRef: "ticket://synth-vendor-ticket-1", staff: staff("securityAdmin") });
    expect((await vendor.list(TENANT_ID))[0]).toMatchObject({ status: "CONFIRMED", evidenceRef: "ticket://synth-vendor-ticket-1" });
  });

  it("[OPS-01] deletion and its evidence are atomic: if the audit event cannot be written nothing is deleted", async () => {
    const { db, policies, audit } = await setup();
    await approve(policies, "TRANSIENT_CONVERSATION");
    await seedTranscripts(db, [{ n: 1, ageDays: 40 }]);
    audit.failAppend = true;
    const registry = new DatasetRegistry().register(transcriptsDataset());
    const [report] = await new RetentionJob({ db, registry, tenantIds: [TENANT_ID], clock: new FakeClock(NOW), audit }).run(new Date(NOW));
    expect(report?.status).toBe("FAILED");
    expect(report?.datasets[0]).toMatchObject({ status: "FAILED", deletedCount: 0, reasonCode: new AuditUnavailableError().reasonCode });
    expect(await remaining(db)).toEqual([tid(1)]);
    expect((await db.query<{ n: number }>("select count(*)::int as n from deletion_records")).rows[0]?.n).toBe(0);
  });

  it("[DATA-03] a mismatch between the approved policy and platform configuration blocks the class", async () => {
    const { db, policies } = await setup();
    await approve(policies, "TRANSIENT_CONVERSATION");
    await seedTranscripts(db, [{ n: 1, ageDays: 40 }]);
    const registry = new DatasetRegistry().register(transcriptsDataset());
    const job = new RetentionJob({ db, registry, tenantIds: [TENANT_ID], clock: new FakeClock(NOW), configRetention: { TRANSIENT_CONVERSATION: null } });
    const [report] = await job.run(new Date(NOW));
    expect(report?.classes.find((c) => c.dataClass === "TRANSIENT_CONVERSATION")?.status).toBe("BLOCKED_RETENTION_CONFIG_MISMATCH");
    expect(await remaining(db)).toEqual([tid(1)]);
  });

  it("[DATA-03] deletion runs in bounded batches, each with its own evidence record", async () => {
    const { db, policies } = await setup();
    await approve(policies, "TRANSIENT_CONVERSATION");
    await seedTranscripts(db, [1, 2, 3, 4, 5].map((n) => ({ n, ageDays: 40 + n })));
    const registry = new DatasetRegistry().register(transcriptsDataset());
    const [report] = await new RetentionJob({ db, registry, tenantIds: [TENANT_ID], clock: new FakeClock(NOW), batchSize: 2 }).run(new Date(NOW));
    expect(report?.datasets[0]).toMatchObject({ deletedCount: 5, keyDigest: keyDigest([1, 2, 3, 4, 5].map(tid)) });
    expect(report?.datasets[0]?.deletionIds).toHaveLength(3);
    const bounded = await new RetentionJob({ db, registry, tenantIds: [TENANT_ID], clock: new FakeClock(NOW), batchSize: 2, maxBatchesPerDataset: 1 });
    await seedTranscripts(db, [6, 7, 8].map((n) => ({ n, ageDays: 50 })));
    expect((await bounded.run(new Date(NOW)))[0]?.datasets[0]?.deletedCount).toBe(2);
  });

  it("[DATA-04] support memory is a registered dataset: expired-by-policy entries are deleted, subject holds keep theirs", async () => {
    const { db, policies, holds, clock } = await setup();
    const mem = new SupportMemoryPg({ db, clock, tenantIds: [TENANT_ID] });
    const value = { issueCategory: "BILLING_DISPUTE", status: "OPEN" };
    await mem.record({ tenantId: TENANT_ID, subjectId: AVERY, kind: "OPEN_ISSUE", value, provenance: "VERIFIED", sourceRef: "ledger://act_synthLedgerRecord0001", expiresAt: "2027-06-01T00:00:00.000Z" });
    await mem.record({ tenantId: TENANT_ID, subjectId: BLAKE, kind: "OPEN_ISSUE", value, provenance: "VERIFIED", sourceRef: "ledger://act_synthLedgerRecord0002", expiresAt: "2027-06-01T00:00:00.000Z" });
    await approve(policies, "BUSINESS_RECORD");
    await holds.place({ tenantId: TENANT_ID, subjectId: BLAKE, dataset: "support_memory", matterRef: "mtr_synthMatterReference8", reasonCode: "LITIGATION_HOLD", staff: staff("securityAdmin") });
    const registry = new DatasetRegistry().register(SUPPORT_MEMORY_DATASET);
    const later = new Date(Date.parse(NOW) + (TEST_ONLY_DAYS + 1) * DAY);
    const [report] = await new RetentionJob({ db, registry, tenantIds: [TENANT_ID], clock: new FakeClock(later) }).run(later);
    expect(report?.datasets[0]).toMatchObject({ dataset: "support_memory", status: "DELETED", deletedCount: 1, heldCount: 1 });
    const left = await db.query<{ subject_id: string }>("select subject_id from support_memory");
    expect(left.rows.map((r) => r.subject_id)).toEqual([BLAKE]);
  });

  it("[DATA-03] the registry validates identifiers, names and vendors; its digest pins the configuration", () => {
    const r = new DatasetRegistry();
    expect(() => r.register(transcriptsDataset({ table: 'x"; drop table y; --' }))).toThrow("RETENTION_IDENTIFIER_INVALID");
    expect(() => r.register(transcriptsDataset({ name: "X" }))).toThrow("RETENTION_DATASET_NAME_INVALID");
    expect(() => r.register(transcriptsDataset({ vendorCopies: [{ vendor: "Bad Vendor", refColumn: "vendor_ref" }] }))).toThrow("RETENTION_VENDOR_INVALID");
    r.register(transcriptsDataset());
    expect(() => r.register(transcriptsDataset())).toThrow("RETENTION_DATASET_DUPLICATE");
    const d1 = r.digest();
    expect(d1).toMatch(/^[a-f0-9]{64}$/);
    expect(new DatasetRegistry().register(transcriptsDataset()).digest()).toBe(d1);
    expect(new DatasetRegistry().register(transcriptsDataset({ dataClass: "BUSINESS_RECORD" })).digest()).not.toBe(d1);
  });

  it("[DATA-03] CRYPTO_SHRED is reported BLOCKED, never simulated", async () => {
    const { db, policies } = await setup();
    await approve(policies, "TRANSIENT_CONVERSATION");
    await seedTranscripts(db, [{ n: 1, ageDays: 40 }]);
    const registry = new DatasetRegistry().register(transcriptsDataset({ deleteStrategy: "CRYPTO_SHRED" }));
    const [report] = await new RetentionJob({ db, registry, tenantIds: [TENANT_ID], clock: new FakeClock(NOW) }).run(new Date(NOW));
    expect(report?.datasets[0]).toMatchObject({ status: "STRATEGY_BLOCKED", reasonCode: "RETENTION_CRYPTO_SHRED_BLOCKED", deletedCount: 0 });
    expect(await remaining(db)).toEqual([tid(1)]);
  });
});
