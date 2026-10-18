import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDb } from "../db/testing.js";
import type { PgliteDb } from "../db/pglite.js";
import { OTHER_TENANT_ID, PEOPLE, TENANT_ID } from "../fixtures/synthetic-world.js";
import { createMemoryLogger } from "../observability/logger.js";
import { InMemoryMetrics, createMetricCatalogue } from "../observability/metrics.js";
import { FakeClock } from "../shared/clock.js";
import { ValidationError } from "../shared/errors.js";
import type { MemoryEntry } from "./ports.js";
import { SupportMemoryPg, memoryValueViolations, recapEligible, recapLabel } from "./support-memory.js";

let db: PgliteDb | undefined;
afterEach(async () => {
  await db?.close();
  db = undefined;
});

const NOW = "2026-10-17T15:00:00.000Z";
const AVERY = PEOPLE.avery.subjectId;
const BLAKE = PEOPLE.blake.subjectId;
const CALL_REF = "call://cal_synthCallPrimary0001";
const LEDGER_REF = "ledger://act_synthLedgerRecord0001";
const REVIEW_REF = "review://rvw_synthHumanReview00001";

async function setup(opts: { maxTtlMs?: number } = {}) {
  db = await createTestDb({ include: /^07/ });
  const clock = new FakeClock(NOW);
  const { logger, records } = createMemoryLogger();
  const mem = new SupportMemoryPg({ db, clock, logger, tenantIds: [TENANT_ID, OTHER_TENANT_ID], maxTtlMs: opts.maxTtlMs });
  return { db, clock, mem, records };
}

type NewEntry = Omit<MemoryEntry, "memoryId" | "createdAt">;
const entry = (over: Partial<NewEntry> = {}): NewEntry => ({
  tenantId: TENANT_ID,
  subjectId: AVERY,
  kind: "OPEN_ISSUE",
  value: { issueCategory: "BILLING_DISPUTE", status: "PENDING_REVIEW", supportReference: "SR-ABCD-EFGH" },
  provenance: "VERIFIED",
  sourceRef: LEDGER_REF,
  expiresAt: "2026-11-17T15:00:00.000Z",
  ...over,
});

const recap = (mem: SupportMemoryPg, over: Partial<Parameters<SupportMemoryPg["recapFor"]>[0]> = {}) =>
  mem.recapFor({ tenantId: TENANT_ID, subjectId: AVERY, assurance: "A2", authorizedSubjectId: AVERY, now: new Date(NOW), ...over });

describe("SupportMemoryPg", () => {

  it("[SPEC-13.metrics][DATA-04] every withheld recap is counted by reason (vsp_memory_recap_withheld_total)", async () => {
    db = await createTestDb({ include: /^07/ });
    const metrics = new InMemoryMetrics({ catalogue: createMetricCatalogue({ toolNames: [] }) });
    const mem = new SupportMemoryPg({ db, tenantIds: [TENANT_ID], clock: new FakeClock("2026-10-18T09:00:00.000Z"), metrics });
    const base = { tenantId: TENANT_ID, subjectId: PEOPLE.avery.subjectId, now: new Date("2026-10-18T09:00:00.000Z") };
    expect(await mem.recapFor({ ...base, assurance: "A0", authorizedSubjectId: null })).toEqual([]);
    expect(await mem.recapFor({ ...base, assurance: "A2", authorizedSubjectId: PEOPLE.blake.subjectId })).toEqual([]);
    expect(await mem.recapFor({ ...base, assurance: "A2", authorizedSubjectId: PEOPLE.avery.subjectId, riskFlags: ["PARTICIPANT_CHANGED"] })).toEqual([]);
    expect(metrics.counterValue("vsp_memory_recap_withheld_total", { reason: "MEMORY_RECAP_REQUIRES_A2" })).toBe(1);
    expect(metrics.counterValue("vsp_memory_recap_withheld_total", { reason: "MEMORY_RECAP_SUBJECT_NOT_AUTHORIZED" })).toBe(1);
    expect(metrics.counterValue("vsp_memory_recap_withheld_total", { reason: "MEMORY_RECAP_RISK_FLAG" })).toBe(1);
  });
  it("[DATA-04][SPEC-9.memory] a verified returning caller (A2, same subject) hears a recap of unexpired entries with provenance labels", async () => {
    const { mem } = await setup();
    const a = await mem.record(entry());
    const b = await mem.record(entry({ kind: "PREFERENCE", value: { preferenceType: "CONTACT_WINDOW", preferenceValue: "MORNINGS", timeZone: "America/Chicago" }, provenance: "CALLER_REPORTED", sourceRef: CALL_REF }));
    const got = await recap(mem);
    expect(got.map((e) => e.memoryId).sort()).toEqual([a.memoryId, b.memoryId].sort());
    expect(got.find((e) => e.memoryId === b.memoryId)).toMatchObject({ provenance: "CALLER_REPORTED", sourceRef: CALL_REF, expiresAt: "2026-11-17T15:00:00.000Z" });
    expect(recapLabel(b)).toEqual({ label: "CALLER_REPORTED", grantsAuthorization: false, medicalFact: false });
    expect((await recap(mem, { assurance: "A3" })).length).toBe(2);
  });

  it("[DATA-04][SPEC-9.memory] no recap before authentication (A0/A1, shared phone), for another subject, or when unauthorized", async () => {
    const { mem, records } = await setup();
    await mem.record(entry());
    expect(await recap(mem, { assurance: "A0" })).toEqual([]);
    expect(await recap(mem, { assurance: "A1" })).toEqual([]);
    expect(await recap(mem, { assurance: "A9" })).toEqual([]);
    expect(await recap(mem, { authorizedSubjectId: null })).toEqual([]);
    expect(await recap(mem, { authorizedSubjectId: BLAKE })).toEqual([]);
    // An authenticated caller for another subject cannot read Avery's memory by asking for it.
    expect(await recap(mem, { subjectId: BLAKE, authorizedSubjectId: BLAKE })).toEqual([]);
    expect(await recap(mem, { tenantId: OTHER_TENANT_ID })).toEqual([]);
    expect(await recap(mem, { riskFlags: ["PARTICIPANT_CHANGED"] })).toEqual([]);
    expect(await recap(mem, { riskFlags: ["SAFETY_ESCALATION_ACTIVE"] })).toEqual([]);
    expect(records.filter((r) => r.event === "memory.recap.withheld").map((r) => r.fields.reasonCode)).toEqual(
      expect.arrayContaining(["MEMORY_RECAP_REQUIRES_A2", "MEMORY_RECAP_ASSURANCE_INVALID", "MEMORY_RECAP_SUBJECT_NOT_AUTHORIZED", "MEMORY_RECAP_RISK_FLAG"]),
    );
    await expect(recap(mem, { subjectId: "Avery Synthetic-Client" })).rejects.toThrow(ValidationError);
  });

  it("[DATA-04] keys that would establish identity, consent, authorization or medical fact are rejected", async () => {
    const { mem } = await setup();
    const forbidden: MemoryEntry["value"][] = [
      { assurance: "A3" },
      { consent: "GRANTED" },
      { role: "provider" },
      { authenticated: true },
      { diagnosis: "SYNTHETIC" },
      { medication: "SYNTHETIC" },
      { symptom: "SYNTHETIC" },
      { riskLevel: "HIGH" },
      { scope: "invoice:read" },
      { verifiedIdentity: true },
      { recordingConsent: "GRANTED" },
      { selectedRole: "client" },
      { treatmentStatus: "ACTIVE" },
    ];
    for (const value of forbidden) {
      await expect(mem.record(entry({ value }))).rejects.toThrow("MEMORY_FORBIDDEN_KEY");
    }
    // Clinical or authorization concepts smuggled into code values are rejected as well.
    for (const issueCategory of ["MEDICATION_QUESTION", "DIAGNOSIS_UPDATE", "CONSENT_GRANTED", "A2", "AUTHENTICATED_CALLER", "SUICIDAL_IDEATION"]) {
      await expect(mem.record(entry({ value: { issueCategory } }))).rejects.toThrow("MEMORY_FORBIDDEN_VALUE");
    }
    // Free text and unknown keys are rejected: memory values are structured only.
    await expect(mem.record(entry({ value: { issueCategory: "caller says they feel unwell" } }))).rejects.toThrow("MEMORY_VALUE_FORMAT");
    await expect(mem.record(entry({ value: { note: "free text" } }))).rejects.toThrow("MEMORY_KEY_NOT_ALLOWED_FOR_KIND");
    expect(await recap(mem)).toEqual([]);
  });

  it("[DATA-04] the database also rejects forbidden keys and nested values even if application checks are bypassed", async () => {
    const { db } = await setup();
    const insert = (value: string) =>
      db.tx(
        (tx) =>
          tx.query(
            `insert into support_memory (memory_id, tenant_id, subject_id, kind, value, provenance, source_ref, created_at, expires_at)
             values ('mem_synthDirectInsert0001', $1, $2, 'OPEN_ISSUE', $3::jsonb, 'VERIFIED', $4, $5::timestamptz, $6::timestamptz)`,
            [TENANT_ID, AVERY, value, LEDGER_REF, NOW, "2026-11-01T00:00:00.000Z"],
          ),
        { role: "app_runtime", rls: { tenantId: TENANT_ID, subjectId: AVERY } },
      );
    await expect(insert(JSON.stringify({ Assurance: "A2" }))).rejects.toThrow(/SUPPORT_MEMORY_FORBIDDEN_VALUE/);
    await expect(insert(JSON.stringify({ medicationName: "X" }))).rejects.toThrow(/SUPPORT_MEMORY_FORBIDDEN_VALUE/);
    await expect(insert(JSON.stringify({ issueCategory: { nested: true } }))).rejects.toThrow(/SUPPORT_MEMORY_FORBIDDEN_VALUE/);
    // RLS: the runtime role cannot write for a subject other than its context.
    await expect(
      db.tx((tx) => tx.query(`insert into support_memory (memory_id, tenant_id, subject_id, kind, value, provenance, source_ref, created_at, expires_at)
            values ('mem_synthDirectInsert0002', $1, $2, 'OPEN_ISSUE', '{"status":"OPEN"}'::jsonb, 'VERIFIED', $3, $4::timestamptz, $5::timestamptz)`, [TENANT_ID, BLAKE, LEDGER_REF, NOW, "2026-11-01T00:00:00.000Z"]), {
        role: "app_runtime",
        rls: { tenantId: TENANT_ID, subjectId: AVERY },
      }),
    ).rejects.toThrow(/row-level security/);
  });

  it("[DATA-04][SPEC-9.memory] machine-inferred entries are never recapped as facts; a human-reviewed summary is recapped with its label", async () => {
    const { mem } = await setup();
    await mem.record(entry({ provenance: "MACHINE_INFERRED", sourceRef: CALL_REF, value: { issueCategory: "BILLING_DISPUTE", status: "OPEN" } }));
    expect(await recap(mem)).toEqual([]);
    await expect(mem.record(entry({ kind: "REVIEWED_SUMMARY", provenance: "MACHINE_INFERRED", sourceRef: CALL_REF, value: { issueCategory: "BILLING_DISPUTE", status: "OPEN" } }))).rejects.toThrow(
      "MEMORY_REVIEWED_SUMMARY_REQUIRES_REVIEW_REF",
    );
    const reviewed = await mem.record(
      entry({ kind: "REVIEWED_SUMMARY", provenance: "MACHINE_INFERRED", sourceRef: REVIEW_REF, value: { issueCategory: "BILLING_DISPUTE", status: "PENDING_REVIEW", reviewedAt: NOW } }),
    );
    const got = await recap(mem);
    expect(got.map((e) => e.memoryId)).toEqual([reviewed.memoryId]);
    expect(got[0]?.provenance).toBe("MACHINE_INFERRED");
    expect(recapLabel(got[0] as MemoryEntry).label).toBe("MACHINE_SUMMARY_HUMAN_REVIEWED");
    expect(recapEligible({ kind: "OPEN_ISSUE", provenance: "MACHINE_INFERRED", sourceRef: REVIEW_REF })).toBe(false);
  });

  it("[DATA-04] provenance must match its source: caller-reported comes from a call, verified never does", async () => {
    const { mem } = await setup();
    await expect(mem.record(entry({ provenance: "CALLER_REPORTED", sourceRef: LEDGER_REF }))).rejects.toThrow("MEMORY_PROVENANCE_SOURCE_MISMATCH");
    await expect(mem.record(entry({ provenance: "VERIFIED", sourceRef: CALL_REF }))).rejects.toThrow("MEMORY_PROVENANCE_SOURCE_MISMATCH");
    await expect(mem.record(entry({ sourceRef: "https://example.invalid/x" }))).rejects.toThrow("MEMORY_ENTRY_INVALID");
  });

  it("[DATA-03][SPEC-9.memory] expiry is mandatory and enforced on read even before expire() runs", async () => {
    const { mem, clock, db } = await setup({ maxTtlMs: 90 * 86_400_000 });
    await expect(mem.record({ ...entry(), expiresAt: undefined } as unknown as NewEntry)).rejects.toThrow("MEMORY_ENTRY_INVALID");
    await expect(mem.record(entry({ expiresAt: NOW }))).rejects.toThrow("MEMORY_EXPIRY_NOT_IN_FUTURE");
    await expect(mem.record(entry({ expiresAt: "2027-06-01T00:00:00.000Z" }))).rejects.toThrow("MEMORY_EXPIRY_BEYOND_APPROVED_MAXIMUM");
    await mem.record(entry({ expiresAt: "2026-10-20T00:00:00.000Z" }));
    await mem.record(entry({ tenantId: OTHER_TENANT_ID, expiresAt: "2026-10-20T00:00:00.000Z" }));
    await mem.record(entry({ expiresAt: "2026-12-01T00:00:00.000Z", value: { issueCategory: "APPOINTMENT_CHANGE", status: "OPEN" } }));
    clock.set("2026-10-21T00:00:00.000Z");
    const later = await recap(mem, { now: clock.now() });
    expect(later.map((e) => e.value.issueCategory)).toEqual(["APPOINTMENT_CHANGE"]);
    expect(await mem.expire(clock.now())).toBe(2);
    const left = await db.query<{ n: number }>("select count(*)::int as n from support_memory");
    expect(left.rows[0]?.n).toBe(1);
    await expect(db.exec("update support_memory set expires_at = now() + interval '1 year'")).rejects.toThrow(/SUPPORT_MEMORY_IMMUTABLE/);
  });

  it("[DATA-04] property: no generated value containing a forbidden concept is ever accepted", () => {
    const forbiddenWord = fc.constantFrom("assurance", "consent", "role", "authenticated", "diagnosis", "medication", "symptom", "risk", "scope", "Verified", "Identity", "Therapy");
    const suffix = fc.constantFrom("", "Level", "Status", "Code", "Name");
    fc.assert(
      fc.property(forbiddenWord, suffix, fc.constantFrom<MemoryEntry["kind"]>("PREFERENCE", "OPEN_ISSUE", "COMPLETED_ACTION", "PROMISE", "DEADLINE", "REVIEWED_SUMMARY"), (w, s, kind) => {
        const key = `${w.charAt(0).toLowerCase()}${w.slice(1)}${s}`;
        expect(memoryValueViolations(kind, { [key]: "OPEN" })).toContain("MEMORY_FORBIDDEN_KEY");
      }),
      { numRuns: 200, seed: 4 },
    );
  });
});
