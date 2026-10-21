/**
 * Layer-1 property suites the gap ledger names as missing (FO-17-02: "Deletion has no property tests; stale-speech /
 * session-generation coverage limited to the text speech queue"):
 *
 *  - session generation and stale speech: over random sequences of session changes on the REAL
 *    TrustedSessionService (identity harness: in-memory KV fixture, FakeClock), the generation increases by exactly
 *    one on every effective change and never otherwise, privileges never survive a change, and the REAL response
 *    gate (TemplateResponseGate over the committed template catalogue) drops every directive issued under an
 *    earlier generation (STALE_GENERATION, nothing spoken) while the same directive at the current generation is
 *    spoken;
 *  - deletion: over random row sets, ages, subjects, tenants and legal holds, the REAL RetentionJob on PGlite with
 *    the retention migrations deletes exactly the expired, unheld rows of the job's tenant, keeps every held,
 *    unexpired and foreign-tenant row, records a key digest of exactly the deleted keys and is idempotent.
 * SYNTHETIC data only; durations are TEST-ONLY placeholders (retention is set by privacy counsel).
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createTestDb } from "../../src/db/testing.js";
import { OTHER_TENANT_ID, PEOPLE, STAFF, TENANT_ID } from "../../src/fixtures/synthetic-world.js";
import { createIdentityHarness, telephony, mcp } from "../../src/identity/identity-harness.fixture.js";
import { InTxAuditWriterFixture } from "../../src/knowledge/testing.js";
import type { Role, SpeechDirective, StaffActor } from "../../src/protocol/index.js";
import { RetentionJob, keyDigest } from "../../src/retention/job.js";
import { LegalHoldStorePg, RetentionPolicyStorePg } from "../../src/retention/policies.js";
import type { RetentionDataset } from "../../src/retention/ports.js";
import { DatasetRegistry } from "../../src/retention/registry.js";
import { TestOnlyRetentionApprovalVerifierFixture } from "../../src/retention/testing.js";
import { FakeClock } from "../../src/shared/clock.js";
import { TemplateResponseGate } from "../../src/voice/gate.js";
import { loadDefaultTemplateRegistry } from "../../src/voice/registry.js";

// ---------------------------------------------------------------------------------------------------------
// Session generation and stale speech
// ---------------------------------------------------------------------------------------------------------

type Step = { kind: "role"; role: Role } | { kind: "change"; change: "PARTICIPANT_CHANGED" | "ACCOUNT_SWITCH" | "RECOVERY_STARTED" | "SAFETY_ESCALATION" };
const ROLES: Role[] = ["client", "provider", "practice_staff", "partner"];
const step: fc.Arbitrary<Step> = fc.oneof(
  fc.constantFrom(...ROLES).map((role) => ({ kind: "role" as const, role })),
  fc.constantFrom("PARTICIPANT_CHANGED" as const, "ACCOUNT_SWITCH" as const, "RECOVERY_STARTED" as const, "SAFETY_ESCALATION" as const).map((change) => ({ kind: "change" as const, change })),
);

const registry = loadDefaultTemplateRegistry();
const gate = new TemplateResponseGate({ registry });
const TURN = "turn_synthPropTurn0001";
/** A PUBLIC template directive (no authorization needed), so only the generation decides. */
const publicDirective = (generation: number): SpeechDirective => {
  const t = registry.get("fallback.safe_explanation", "en-US");
  if (!t) throw new Error("fallback template missing");
  return { templateId: t.templateId, templateVersion: t.version, responseClass: t.responseClass, slots: {}, authorizationRef: null, sourceRefs: [], turnId: TURN, sessionGeneration: generation } as SpeechDirective;
};

describe("[FO-17-02] property: session generation and stale speech", () => {
  it("[FO-17-02][AUTH-04][ACT-05][ACT-01] every effective change bumps the generation by exactly one and drops privileges; speech from any earlier generation is dropped, speech at the current one is spoken", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(step, { minLength: 1, maxLength: 12 }), async (steps) => {
        const h = await createIdentityHarness();
        const { sessionRef } = await h.startCall();
        let ctx = await h.sessions.resolve(sessionRef, mcp());
        const seen: number[] = [ctx.sessionGeneration];
        for (const s of steps) {
          const before = ctx;
          ctx = s.kind === "role" ? await h.sessions.selectRole(sessionRef, telephony(), s.role) : await h.sessions.applyChange(sessionRef, telephony(), { kind: s.change });
          const effective = s.kind === "change" || before.selectedRole !== s.role;
          expect(ctx.sessionGeneration).toBe(before.sessionGeneration + (effective ? 1 : 0));
          if (effective) {
            expect(ctx.assurance).toBe("A0");
            expect(ctx.actorId).toBeNull();
          }
          seen.push(ctx.sessionGeneration);
        }
        // Monotonic, never reused.
        for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1] as number);
        const current = ctx.sessionGeneration;
        const gctx = { sessionRef, currentTurnId: TURN, sessionGeneration: current, validAuthorizationRefs: new Set<string>(), locale: "en-US", environment: "local" as const };
        const spoken = gate.render(publicDirective(current), gctx);
        expect(spoken.ok).toBe(true);
        for (const old of new Set(seen.filter((g) => g < current))) {
          const late = gate.render(publicDirective(old), gctx);
          expect(late.ok).toBe(false);
          if (!late.ok) {
            expect(late.reasonCode).toBe("STALE_GENERATION");
            expect(late.disposition).toBe("DROP_STALE");
          }
        }
      }),
      { numRuns: 40, seed: 20261019 },
    );
  });
});

// ---------------------------------------------------------------------------------------------------------
// Deletion
// ---------------------------------------------------------------------------------------------------------

const NOW = "2026-10-19T12:00:00.000Z";
const DAY = 86_400_000;
const TEST_ONLY_DAYS = 30;
const APPROVAL = "apr_testOnlyRetentionSchedule";
const staff = (): StaffActor => ({ staffId: STAFF.securityAdmin.staffId, roles: [...STAFF.securityAdmin.roles], mfa: true, authenticatedAt: NOW, breakGlass: null });
const tid = (n: number) => `trn_synthPropRow${String(n).padStart(8, "0")}`;

interface Row {
  ageDays: number;
  subject: "avery" | "blake";
  foreignTenant: boolean;
  recordHold: boolean;
}
const row: fc.Arbitrary<Row> = fc.record({ ageDays: fc.integer({ min: 0, max: 120 }), subject: fc.constantFrom("avery" as const, "blake" as const), foreignTenant: fc.boolean(), recordHold: fc.boolean() });

const dataset: RetentionDataset = {
  name: "test_prop_transcripts",
  table: "test_prop_transcripts",
  dataClass: "TRANSIENT_CONVERSATION",
  timestampColumn: "created_at",
  tenantColumn: "tenant_id",
  keyColumn: "transcript_id",
  subjectColumn: "subject_id",
  deleteStrategy: "HARD_DELETE",
  derivedCopies: [],
  vendorCopies: [],
  owner: "test",
};

describe("[FO-17-02] property: deletion", () => {
  it("[FO-17-02][DATA-03] the retention job deletes exactly the expired, unheld rows of its tenant, keeps every held, unexpired and foreign row, records the digest of exactly the deleted keys and is idempotent", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(row, { minLength: 1, maxLength: 14 }), fc.boolean(), async (rows, holdBlake) => {
        const db = await createTestDb({ include: /^0[78]/ });
        try {
          await db.exec(`
            create table test_prop_transcripts (transcript_id text primary key, tenant_id text not null, subject_id text, created_at timestamptz not null);
            alter table test_prop_transcripts enable row level security;
            create policy p1 on test_prop_transcripts for all to app_worker using (tenant_id = app_tenant());
            grant select, delete on test_prop_transcripts to app_worker;
          `);
          const clock = new FakeClock(NOW);
          const audit = await InTxAuditWriterFixture.install(db);
          const policies = new RetentionPolicyStorePg({ db, approvals: new TestOnlyRetentionApprovalVerifierFixture(new Set([APPROVAL])), clock, audit });
          const holds = new LegalHoldStorePg({ db, clock, audit });
          await policies.define({ tenantId: TENANT_ID, dataClass: "TRANSIENT_CONVERSATION", retentionDays: TEST_ONLY_DAYS, legalPurpose: "TEST_ONLY_PLACEHOLDER_PURPOSE", approvalId: APPROVAL, staff: staff() });
          for (const [i, r] of rows.entries()) {
            const subject = r.subject === "avery" ? PEOPLE.avery.subjectId : PEOPLE.blake.subjectId;
            await db.query("insert into test_prop_transcripts values ($1, $2, $3, $4::timestamptz)", [tid(i), r.foreignTenant ? OTHER_TENANT_ID : TENANT_ID, subject, new Date(Date.parse(NOW) - r.ageDays * DAY).toISOString()]);
            if (r.recordHold && !r.foreignTenant) {
              await holds.place({ tenantId: TENANT_ID, recordKey: tid(i), dataset: dataset.name, matterRef: `mtr_synthPropMatter${String(i).padStart(4, "0")}`, reasonCode: "LITIGATION_HOLD", staff: staff() });
            }
          }
          if (holdBlake) await holds.place({ tenantId: TENANT_ID, subjectId: PEOPLE.blake.subjectId, matterRef: "mtr_synthPropMatterSubj", reasonCode: "LITIGATION_HOLD", staff: staff() });

          const expired = (r: Row) => r.ageDays > TEST_ONLY_DAYS;
          const held = (r: Row) => r.recordHold || (holdBlake && r.subject === "blake");
          const expectDeleted = rows.map((r, i) => ({ r, i })).filter(({ r }) => !r.foreignTenant && expired(r) && !held(r)).map(({ i }) => tid(i));
          const job = new RetentionJob({ db, registry: new DatasetRegistry().register(dataset), tenantIds: [TENANT_ID], clock, audit });
          const [report] = await job.run(new Date(NOW));
          const ds = report?.datasets.find((d) => d.dataset === dataset.name);
          expect(ds?.deletedCount).toBe(expectDeleted.length);
          if (expectDeleted.length > 0) expect(ds?.keyDigest).toBe(keyDigest(expectDeleted));
          const left = (await db.query<{ transcript_id: string }>("select transcript_id from test_prop_transcripts order by transcript_id")).rows.map((x) => x.transcript_id);
          const expectLeft = rows.map((_, i) => tid(i)).filter((k) => !expectDeleted.includes(k)).sort();
          expect(left).toEqual(expectLeft);
          // Idempotent: a second run deletes nothing more.
          const [second] = await job.run(new Date(NOW));
          expect(second?.datasets.find((d) => d.dataset === dataset.name)?.deletedCount ?? 0).toBe(0);
          // Deletion evidence carries counts and digests only, never a key.
          const evidence = JSON.stringify((await db.query("select * from deletion_records")).rows);
          for (const k of expectDeleted) expect(evidence).not.toContain(k);
        } finally {
          await db.close();
        }
      }),
      { numRuns: 6, seed: 20261019 },
    );
  }, 180_000);
});
