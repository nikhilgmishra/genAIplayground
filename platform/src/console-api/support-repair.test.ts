/**
 * Console operator repair of a dead-lettered Salesforce sync (spec section 8 "dead-letter queue and
 * operator repair flow"; ACT-02, OPS-01, AUTH-02).
 *
 * Part 1: the plugin over real modules on PGlite with the labelled business-service stand-in
 * (SupportRequestServiceFixture). Part 2: the LOCAL FIXTURE composition (container with the REAL
 * business module, local console, worker loops): a Salesforce outage dead-letters a request, the
 * supervisor repairs it through the console API, the worker syncs exactly one Case. SYNTHETIC data only.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBusiness } from "../business/index.js";
import { CALLS, IDP, STAFF, TENANT_ID } from "../fixtures/synthetic-world.js";
import { LOCAL_FIXTURE_TOKENS } from "../gateway/auth.js";
import { buildLocalConsole } from "../main/console.js";
import { buildContainer } from "../main/container.js";
import { createMemoryLogger } from "../observability/logger.js";
import { FakeClock } from "../shared/clock.js";
import { newId } from "../shared/ids.js";
import { workerLoopsFor } from "../worker/worker.js";
import { createConsoleHarness, insertBreakGlassGrant } from "./fixtures/harness.fixture.js";
import type { ConsoleHarness } from "./fixtures/harness.fixture.js";

const errorOf = (body: string): { reasonCode: string; retryable: boolean } => (JSON.parse(body) as { error: { reasonCode: string; retryable: boolean } }).error;
const consoleEvents = (h: ConsoleHarness, outcome: string) =>
  h.db.query<{ n: number }>("select count(*)::int as n from audit_outbox where action = 'console.support_requests.repair' and outcome = $1", [outcome]).then((r) => r.rows[0]?.n ?? 0);

describe("console supportRequests.repair (plugin, labelled business stand-in)", () => {
  let h: ConsoleHarness;
  beforeAll(async () => {
    h = await createConsoleHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  it("[SPEC-8.salesforce][ACT-02][OPS-01] a supervisor repairs a DEAD_LETTER sync with an allowlisted reason code; the intent and completion are audited; a replayed key repairs once", async () => {
    const sr = h.supportRequests.seed({ referenceNumber: "SR-RPRA-DLQ2", now: h.clock.now(), syncState: "DEAD_LETTER", lastReasonCode: "SALESFORCE_SYNC_FAILED" });
    const token = await h.token("supervisor");
    const key = "idem_synthRepairKey0000001";
    const first = await h.call("supportRequests.repair", { token, params: { ref: "SR-RPRA-DLQ2" }, body: { reason: "ROOT_CAUSE_FIXED:inc_synthIncident0000001" }, idempotencyKey: key });
    expect(first.statusCode).toBe(200);
    const body = JSON.parse(first.body) as { referenceNumber: string; syncState: string; repaired: boolean; auditEventId: string };
    expect(body).toEqual({ referenceNumber: "SR-RPRA-DLQ2", syncState: "PENDING", repaired: true, auditEventId: expect.stringMatching(/^[a-z][a-z0-9]{1,11}_/) });
    // The business operation receives the staff member and the reason CODE only (never the incident suffix or free text).
    expect(h.supportRequests.repairs).toEqual([{ supportRequestId: sr.supportRequestId, actorRef: STAFF.supervisor.staffId, reasonCode: "ROOT_CAUSE_FIXED" }]);
    expect(await consoleEvents(h, "PENDING")).toBe(1);
    expect(await consoleEvents(h, "SUCCEEDED")).toBe(1);
    // Same Idempotency-Key: the first result, no second repair.
    const replay = await h.call("supportRequests.repair", { token, params: { ref: "SR-RPRA-DLQ2" }, body: { reason: "ROOT_CAUSE_FIXED:inc_synthIncident0000001" }, idempotencyKey: key });
    expect(replay.statusCode).toBe(200);
    expect(JSON.parse(replay.body)).toEqual(body);
    expect(h.supportRequests.repairs).toHaveLength(1);
    // A new key on a request that is no longer dead-lettered is a state conflict (nothing repaired, no intent written).
    const again = await h.call("supportRequests.repair", { token, params: { ref: "SR-RPRA-DLQ2" }, body: { reason: "ROOT_CAUSE_FIXED" }, idempotencyKey: "idem_synthRepairKey0000002" });
    expect(again.statusCode).toBe(409);
    expect(errorOf(again.body).reasonCode).toBe("STATE_CONFLICT");
    expect(h.supportRequests.repairs).toHaveLength(1);
    expect(await consoleEvents(h, "PENDING")).toBe(1);
    // Content-free response: no summary, next step, subject or Case data.
    expect(first.body).not.toContain(sr.summary);
    expect(first.body).not.toContain(sr.subjectRef as string);
  });

  it("[SPEC-8.salesforce][AUTH-02] unknown references are 404; free-text and foreign reason codes are refused; only DEAD_LETTER is repairable", async () => {
    const token = await h.token("supervisor");
    expect((await h.call("supportRequests.repair", { token, params: { ref: "SR-ZZZZ-ZZZZ" }, body: { reason: "ROOT_CAUSE_FIXED" } })).statusCode).toBe(404);
    h.supportRequests.seed({ referenceNumber: "SR-RPRB-DLQ3", now: h.clock.now(), syncState: "DEAD_LETTER" });
    for (const reason of ["the caller Avery asked again", "RECONCILED_NOT_FOUND_RETRY", "ROOT_CAUSE_FIXED: free text"]) {
      const r = await h.call("supportRequests.repair", { token, params: { ref: "SR-RPRB-DLQ3" }, body: { reason } });
      expect(r.statusCode, reason).toBe(400);
      expect(errorOf(r.body).reasonCode, reason).toBe("REASON_NOT_ALLOWED");
    }
    for (const [ref, syncState] of [["SR-RPSP-DLQ6", "PENDING"], ["SR-RPSR-DLQ7", "RETRY_SCHEDULED"], ["SR-RPSS-DLQ8", "SYNCING"], ["SR-RPSY-DLQ9", "SYNCED"]] as const) {
      h.supportRequests.seed({ referenceNumber: ref, now: h.clock.now(), syncState });
      const r = await h.call("supportRequests.repair", { token, params: { ref }, body: { reason: "ROOT_CAUSE_FIXED" } });
      expect(r.statusCode, syncState).toBe(409);
    }
    expect(h.supportRequests.repairs.filter((x) => x.reasonCode !== "ROOT_CAUSE_FIXED")).toEqual([]);
  });

  it("[SPEC-7.break-glass][AUTH-02] a restricted (privacy / safety) request needs the same valid break-glass as reading it", async () => {
    h.supportRequests.seed({ referenceNumber: "SR-RSTR-DLQ4", restricted: true, now: h.clock.now(), syncState: "DEAD_LETTER" });
    const before = h.supportRequests.repairs.length;
    const denied = await h.call("supportRequests.repair", { token: await h.token("supervisor"), params: { ref: "SR-RSTR-DLQ4" }, body: { reason: "INCIDENT_RECOVERY" } });
    expect(denied.statusCode).toBe(403);
    expect(h.supportRequests.repairs).toHaveLength(before);
    const now = h.clock.now().getTime();
    await insertBreakGlassGrant(h, { staffId: STAFF.supervisor.staffId, approvedBy: STAFF.securityAdmin.staffId, grantedAt: new Date(now - 60_000).toISOString(), expiresAt: new Date(now + 3_600_000).toISOString() });
    const ok = await h.call("supportRequests.repair", { token: await h.token("supervisor"), params: { ref: "SR-RSTR-DLQ4" }, body: { reason: "INCIDENT_RECOVERY" } });
    expect(ok.statusCode).toBe(200);
    expect(h.supportRequests.repairs).toHaveLength(before + 1);
  });

  it("[OPS-01] when the console intent event cannot be written nothing is repaired (503 AUDIT_UNAVAILABLE)", async () => {
    h.supportRequests.seed({ referenceNumber: "SR-RPRC-DLQ5", now: h.clock.now(), syncState: "DEAD_LETTER" });
    const before = h.supportRequests.repairs.length;
    const token = await h.token("supervisor");
    await h.db.exec("revoke insert on audit_outbox from app_console");
    try {
      const r = await h.call("supportRequests.repair", { token, params: { ref: "SR-RPRC-DLQ5" }, body: { reason: "ROOT_CAUSE_FIXED" } });
      expect(r.statusCode).toBe(503);
      expect(errorOf(r.body)).toMatchObject({ reasonCode: "AUDIT_UNAVAILABLE", retryable: true });
    } finally {
      await h.db.exec("grant insert on audit_outbox to app_console");
    }
    expect(h.supportRequests.repairs).toHaveLength(before);
    expect((await h.supportRequests.getByReference(TENANT_ID, "SR-RPRC-DLQ5"))?.syncState).toBe("DEAD_LETTER");
  });
});

describe("console supportRequests.repair over the local composition (real business module)", () => {
  it("[SPEC-8.salesforce][ACT-02][OPS-01] Salesforce outage -> dead letter -> audited console repair -> exactly one Case; the response names the business module's in-transaction audit event", async () => {
    const clock = new FakeClock("2026-10-18T09:00:00.000Z");
    const c = await buildContainer({ environment: "local", buildBusiness, clock, env: {}, logger: createMemoryLogger().logger, rateLimit: null, ingestKnowledge: false });
    const consoleApp = await buildLocalConsole(c);
    const { loops, closers } = workerLoopsFor(c);
    const run = async (...names: string[]) => {
      for (const n of names) await loops.find((l) => l.name === n)?.runOnce();
    };
    try {
      const tenantId = c.config.tenantId;
      const fault = c.fixtures.faults.inject({ integrationId: "salesforce", operation: "*", kind: "OUTAGE", mode: "persistent" });
      const human = await c.app.inject({
        method: "POST",
        url: "/telephony/v1/session/human-request",
        headers: { authorization: `Bearer ${LOCAL_FIXTURE_TOKENS.telephony_control}` },
        payload: { callId: CALLS.primary.callId, reason: "CALLER_REQUESTED_HUMAN", language: "en", issueCategory: null },
      });
      expect(human.statusCode).toBe(200);
      const [sr] = await c.business.supportRequests.listForCall(tenantId, CALLS.primary.callId);
      const ref = sr?.referenceNumber as string;
      await run("outbox.dispatch", "outbox.consume");
      for (let i = 0; i < 10 && (await c.business.supportRequests.getByReference(tenantId, ref))?.syncState !== "DEAD_LETTER"; i++) {
        clock.advanceMs(1_000_000);
        await run("support.sync_retry", "outbox.dispatch", "outbox.consume");
      }
      expect((await c.business.supportRequests.getByReference(tenantId, ref))?.syncState).toBe("DEAD_LETTER");
      c.fixtures.faults.clear(fault);

      const tokenFor = (sub: string) => {
        const nowS = Math.floor(clock.now().getTime() / 1000);
        return consoleApp.workforceIdp.issueIdToken({ issuer: IDP.workforceIssuer, sub, nonce: newId("non"), audience: IDP.consoleAudience, amr: ["local_fixture", "mfa"], authTime: nowS, issuedAt: nowS, ttlSeconds: 900 });
      };
      const repair = (token: string, key: string) =>
        consoleApp.app.inject({ method: "POST", url: `/console/api/v1/support-requests/${ref}/repair`, headers: { authorization: `Bearer ${token}`, "idempotency-key": key }, payload: { reason: "ROOT_CAUSE_FIXED" } });
      // A support agent may trace but not repair.
      expect((await repair(await tokenFor(STAFF.agent.idpSubject), "idem_synthRepairAgent00001")).statusCode).toBe(403);
      const res = await repair(await tokenFor(STAFF.supervisor.idpSubject), "idem_synthRepairSuperv0001");
      expect(res.statusCode).toBe(200);
      const body = res.json() as { syncState: string; repaired: boolean; auditEventId: string };
      expect(body).toMatchObject({ syncState: "PENDING", repaired: true });
      const [moduleEvent] = await c.auditQuery.search({ tenantId, action: "support_request.repair_requeued", limit: 5 });
      expect(moduleEvent).toMatchObject({ eventId: body.auditEventId, actorRef: STAFF.supervisor.staffId, reasonCode: "ROOT_CAUSE_FIXED", sourceComponent: "console" });

      await run("outbox.dispatch", "outbox.consume");
      const synced = await c.business.supportRequests.getByReference(tenantId, ref);
      expect(synced?.syncState).toBe("SYNCED");
      expect(c.fixtures.supportRecords.records().cases.filter((x) => x.caseId === synced?.salesforceCaseId)).toHaveLength(1);
      // Repeated sweeps and a second (refused) repair create no duplicate Case.
      clock.advanceMs(1_000_000);
      await run("support.sync_retry", "outbox.dispatch", "outbox.consume");
      expect((await repair(await tokenFor(STAFF.supervisor.idpSubject), "idem_synthRepairSuperv0002")).statusCode).toBe(409);
      expect(c.fixtures.supportRecords.records().cases).toHaveLength(1);
    } finally {
      for (const close of closers) close();
      await consoleApp.app.close();
      await c.close();
    }
  }, 120_000);
});
