/**
 * Layer 2 (WP-05): the break-glass issuance workflow on PostgreSQL 16 (every migration, the app_console role
 * under row-level security, a real connection pool): request, independent decision, grant, the first use
 * opening exactly one post-use access review even when two connections race on it, and the independent
 * review. The database itself refuses a self-decided request, a self-granted grant and a self-review, so
 * a defect in the service cannot issue or close one. SYNTHETIC staff ids only.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect } from "vitest";
import type { AuditWriter } from "../../../src/audit/ports.js";
import { PgAuditWriter } from "../../../src/audit/writer.js";
import type { Queryable } from "../../../src/db/types.js";
import { PgBreakGlassIssuance } from "../../../src/console-api/break-glass-issuance.js";
import { BREAK_GLASS_MAX_DURATION_SECONDS } from "../../../src/console-api/plugin.js";
import { consoleAuditInput } from "../../../src/console-api/stores.js";
import type { AuditEvent, AuditEventInput, StaffRole } from "../../../src/protocol/index.js";
import { systemClock } from "../../../src/shared/clock.js";
import { newId } from "../../../src/shared/ids.js";
import { createIntegrationDb } from "../_harness/clients.js";
import type { IntegrationDb } from "../_harness/clients.js";
import { layer2, layer2Context } from "../_harness/layer2.js";

const SERVICES = ["postgres"];
const it = layer2(SERVICES);
const TENANT = "tnt_synthBreakGlassL2Tenant";
const staff = () => `stf_${randomBytes(15).toString("base64url")}`;

let idb: IntegrationDb;
let writer: PgAuditWriter;
let issuance: PgBreakGlassIssuance;

/**
 * Test seam around the real writer: first-use appends wait until `parties` transactions have arrived, so every
 * racing transaction has already passed its "no review yet" read before any of them inserts. The race is then
 * certain, not a matter of scheduling luck.
 */
class FirstUseBarrier implements AuditWriter {
  arrived = 0;
  private release: () => void = () => undefined;
  private readonly gate = new Promise<void>((resolve) => {
    this.release = resolve;
  });
  constructor(
    private readonly inner: AuditWriter,
    private readonly parties: number,
  ) {}
  async append(tx: Queryable, input: AuditEventInput, stream?: string): Promise<AuditEvent> {
    if (input.action === "console.break_glass.first_use") {
      this.arrived += 1;
      if (this.arrived >= this.parties) this.release();
      await Promise.race([this.gate, new Promise((r) => setTimeout(r, 10_000))]);
    }
    return this.inner.append(tx, input, stream);
  }
  appendStandalone(input: AuditEventInput, stream?: string): Promise<AuditEvent> {
    return this.inner.appendStandalone(input, stream);
  }
}

const audit = (staffId: string, role: StaffRole, action: string, reasonCode: string) =>
  consoleAuditInput({ tenantId: TENANT, correlationId: newId("cor"), staffId, role, action, outcome: "SUCCEEDED", reasonCode, occurredAt: systemClock.now() });

const reasonOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "NO_ERROR";
  } catch (e) {
    return (e as { reasonCode?: string; code?: string }).reasonCode ?? (e as { code?: string }).code ?? String(e);
  }
};

async function approvedGrant(holder: string, approver: string) {
  const now = systemClock.now();
  const req = await issuance.request({ tenantId: TENANT, staffId: holder, body: { justificationCode: "ACTIVE_SAFETY_INCIDENT", durationSeconds: 1800, reason: "INCIDENT_RESPONSE" }, now, audit: audit(holder, "safety_responder", "console.break_glass.request", "BREAK_GLASS_REQUESTED") });
  const decided = await issuance.decide({ tenantId: TENANT, deciderId: approver, requestId: req.requestId, body: { decision: "APPROVE", reason: "INCIDENT_VERIFIED" }, now, audit: audit(approver, "security_admin", "console.break_glass.decide", "BREAK_GLASS_APPROVED") });
  if (!decided.grantId) throw new Error("NO_GRANT");
  return { req, decided, grantId: decided.grantId };
}

describe("break-glass issuance and post-use review on PostgreSQL 16", () => {
  beforeAll(async () => {
    idb = await createIntegrationDb(layer2Context(SERVICES));
    writer = new PgAuditWriter({ db: idb.db, clock: systemClock, stream: "console.l2", standaloneRole: "app_console" });
    issuance = new PgBreakGlassIssuance(idb.db, writer, BREAK_GLASS_MAX_DURATION_SECONDS);
  }, 120_000);

  afterAll(async () => {
    await idb?.drop();
  });

  it("[FO-05-45][AUTH-02] a request grants nothing until a different admin approves; self-decision is refused by the service and by the database", async () => {
    const holder = staff();
    const approver = staff();
    const now = systemClock.now();
    const req = await issuance.request({ tenantId: TENANT, staffId: holder, body: { justificationCode: "SECURITY_INCIDENT", durationSeconds: 900, reason: "INCIDENT_RESPONSE" }, now, audit: audit(holder, "security_admin", "console.break_glass.request", "BREAK_GLASS_REQUESTED") });
    expect(req).toMatchObject({ status: "PENDING", grantId: null });
    expect(await reasonOf(issuance.decide({ tenantId: TENANT, deciderId: holder, requestId: req.requestId, body: { decision: "APPROVE", reason: "INCIDENT_VERIFIED" }, now, audit: audit(holder, "security_admin", "console.break_glass.decide", "BREAK_GLASS_APPROVED") }))).toBe("SELF_APPROVAL_PROHIBITED");
    // Below the service: row-level security hides the request from its requester for update (0 rows)...
    const viaRls = await idb.db.tx((tx) => tx.query("update console_break_glass_requests set status = 'APPROVED', decided_by = $2, decided_at = now(), decision_reason = 'INCIDENT_VERIFIED' where request_id = $1", [req.requestId, holder]), { role: "app_console", rls: { tenantId: TENANT, actorId: holder } });
    expect(viaRls.rowCount).toBe(0);
    // ...and the table constraints refuse the same thing for any writer, even one that bypasses RLS.
    expect(await reasonOf(idb.db.tx((tx) => tx.query("update console_break_glass_requests set status = 'REJECTED', decided_by = requested_by, decided_at = now(), decision_reason = 'INCIDENT_VERIFIED', decision_audit_event_id = request_audit_event_id where request_id = $1", [req.requestId]), { role: "owner" }))).toBe("23514");
    expect(await reasonOf(idb.db.tx((tx) => tx.query("insert into console_break_glass_grants (grant_id, tenant_id, staff_id, approved_by, justification_code, granted_at, expires_at, recorded_at) values ($1, $2, $3, $3, 'SECURITY_INCIDENT', now(), now() + interval '10 minutes', now())", [newId("bgl", 24), TENANT, holder]), { role: "owner" }))).toBe("23514");
    const decided = await issuance.decide({ tenantId: TENANT, deciderId: approver, requestId: req.requestId, body: { decision: "APPROVE", reason: "INCIDENT_VERIFIED" }, now, audit: audit(approver, "security_admin", "console.break_glass.decide", "BREAK_GLASS_APPROVED") });
    expect(decided).toMatchObject({ status: "APPROVED", decidedBy: approver });
    const grant = await idb.db.tx((tx) => tx.query<{ staff_id: string; approved_by: string; seconds: number }>("select staff_id, approved_by, extract(epoch from (expires_at - granted_at))::int as seconds from console_break_glass_grants where grant_id = $1", [decided.grantId]), { role: "owner" });
    expect(grant.rows[0]).toEqual({ staff_id: holder, approved_by: approver, seconds: 900 });
  });

  it("[FO-05-45][OPS-01] two connections racing on the first use open exactly one review and commit exactly one first-use audit event", async () => {
    const holder = staff();
    const approver = staff();
    const { grantId } = await approvedGrant(holder, approver);
    const barrier = new FirstUseBarrier(writer, 4);
    const racing = new PgBreakGlassIssuance(idb.db, barrier, BREAK_GLASS_MAX_DURATION_SECONDS);
    const use = (svc: PgBreakGlassIssuance = racing) => svc.recordUse({ tenantId: TENANT, holderId: holder, approverId: approver, subjectKind: "BREAK_GLASS_GRANT", subjectRef: grantId, now: systemClock.now(), audit: { ...audit(holder, "safety_responder", "console.break_glass.first_use", "BREAK_GLASS_USED"), evidencePointers: [`break_glass_grant:${grantId}`] } });
    const results = await Promise.all([use(), use(), use(), use()]);
    // All four passed the "no review yet" read before any insert: the race really happened.
    expect(barrier.arrived).toBe(4);
    expect(new Set(results.map((r) => r.reviewId)).size).toBe(1);
    expect(results.filter((r) => r.auditEventId !== null)).toHaveLength(1);
    const counts = await idb.db.tx(
      (tx) =>
        tx.query<{ reviews: number; audits: number }>(
          `select (select count(*)::int from console_access_reviews where subject_ref = $1) as reviews,
                  (select count(*)::int from audit_outbox where action = 'console.break_glass.first_use' and event->>'actorRef' = $2) as audits`,
          [grantId, holder],
        ),
      { role: "owner" },
    );
    expect(counts.rows[0]).toEqual({ reviews: 1, audits: 1 });
    // A later use neither re-opens nor re-audits.
    expect(await use(issuance)).toEqual({ reviewId: results[0]?.reviewId, auditEventId: null });
  });

  it("[FO-05-45][AUTH-02] the review is completed only by a third person; the database refuses a self-review written around the service", async () => {
    const holder = staff();
    const approver = staff();
    const reviewer = staff();
    const { grantId } = await approvedGrant(holder, approver);
    const { reviewId } = await issuance.recordUse({ tenantId: TENANT, holderId: holder, approverId: approver, subjectKind: "BREAK_GLASS_GRANT", subjectRef: grantId, now: systemClock.now(), audit: { ...audit(holder, "safety_responder", "console.break_glass.first_use", "BREAK_GLASS_USED"), evidencePointers: [`break_glass_grant:${grantId}`] } });
    const body = { outcome: "APPROPRIATE" as const, reason: "USE_MATCHED_JUSTIFICATION" };
    const complete = (reviewerId: string) => issuance.completeReview({ tenantId: TENANT, reviewerId, reviewId, body, now: systemClock.now(), audit: audit(reviewerId, "security_admin", "console.access_reviews.complete", "ACCESS_REVIEW_COMPLETED") });
    expect(await reasonOf(complete(holder))).toBe("SELF_REVIEW_FORBIDDEN");
    expect(await reasonOf(complete(approver))).toBe("SELF_REVIEW_FORBIDDEN");
    expect(await reasonOf(idb.db.tx((tx) => tx.query("update console_access_reviews set status = 'COMPLETED', outcome = 'APPROPRIATE', reason = 'USE_MATCHED_JUSTIFICATION', reviewer_staff_id = approver_staff_id, completed_at = now(), completion_audit_event_id = first_use_audit_event_id where review_id = $1", [reviewId]), { role: "owner" }))).toBe("23514");
    expect(await complete(reviewer)).toMatchObject({ status: "COMPLETED", outcome: "APPROPRIATE", reviewerStaffId: reviewer });
    expect(await reasonOf(complete(staff()))).toBe("ACCESS_REVIEW_COMPLETED");
  });
});
