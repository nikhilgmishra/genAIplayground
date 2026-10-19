/**
 * Reopened-case measurement (spec section 13 "Measure ... reopened cases"; SPEC-13.resolution-metrics)
 * over the REAL PGlite schema (migration 0302), audit writer and support-request service, with the
 * LOCAL Salesforce-like fixture standing in for humans working the Case (setCaseStatus). The Case
 * Status values below are TEST-ONLY: the tenant's picklist is UNKNOWN until PRQ-006 / VQ-SF-04.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PEOPLE, TENANT_ID } from "../../fixtures/synthetic-world.js";
import { KillSwitchGatedSupportRecords } from "../../ops/integration-gate.js";
import type { KillSwitchSnapshot } from "../../ops/ports.js";
import type { SupportRecordSystem } from "../../adapters/ports.js";
import { createBusinessHarness, expectDone, type BusinessHarness } from "../testing/harness.js";
import { DEFAULT_CASE_STATE_MAPPING, PgSupportRequestService } from "./support-request-service.js";

/** TEST-ONLY mapping (never a default): the fixture creates Cases as "NEW". */
const TEST_CASE_STATES = { open: ["NEW", "WORKING_TEST_ONLY"], closed: ["CLOSED_TEST_ONLY"] };

let h: BusinessHarness;
beforeEach(async () => {
  h = await createBusinessHarness();
});
afterEach(async () => {
  await h.close();
});

const service = (opts: { caseStates?: typeof TEST_CASE_STATES; supportRecords?: SupportRecordSystem } = {}) =>
  new PgSupportRequestService({
    db: h.db,
    clock: h.clock,
    audit: h.deps.audit,
    outbox: h.deps.outbox,
    supportRecords: opts.supportRecords ?? h.fixtures.supportRecords,
    versions: h.deps.versions,
    metrics: h.metrics,
    ...(opts.caseStates ? { caseStates: opts.caseStates } : {}),
  });

/** A subject-linked support request after its sync messages ran once. Returns its ids and sync state. */
async function requestAfterSync(): Promise<{ supportRequestId: string; issueExternalId: string; syncState: string }> {
  const { sessionRef } = await h.startCall();
  const auth = await h.verify(PEOPLE.avery, sessionRef);
  const r = expectDone(await h.invoke("create_support_request", auth, { issueCategory: "billing_question", linkToAccount: true, urgency: "STANDARD", language: "en" }));
  if (r.outcome.status !== "SUCCESS") throw new Error(`create ${r.outcome.status}`);
  const ref = (r.outcome.data as { request: { supportReference: string } }).request.supportReference;
  const msgs = await h.db.tx(
    async (q) => (await q.query<{ message_id: string; payload: Record<string, unknown> }>("select message_id, payload from outbox_messages where topic = 'support_request.sync' order by created_at, message_id")).rows,
    { role: "owner" },
  );
  for (const m of msgs) await h.business.supportRequests.handleSyncMessage(m.message_id, m.payload);
  const sr = await h.services.support.getByReference(TENANT_ID, ref);
  if (!sr) throw new Error("request missing");
  return { supportRequestId: sr.supportRequestId, issueExternalId: sr.issueExternalId, syncState: sr.syncState };
}

/** A subject-linked support request synchronized to the fixture Case store. Returns its ids. */
async function syncedRequest(): Promise<{ supportRequestId: string; issueExternalId: string }> {
  const { supportRequestId, issueExternalId, syncState } = await requestAfterSync();
  if (syncState !== "SYNCED") throw new Error("not synced");
  return { supportRequestId, issueExternalId };
}

/** TEST-ONLY synthetic Case id (fixture id shape with the SYN marker): the Case found under the external id after a recreation. */
const RECREATED_CASE_ID = "500SYNRECREATED0001";

/** The fixture, except that the Case read under any external id carries another Case id (deleted and recreated in the vendor). */
const recreatedCaseRecords = (inner: SupportRecordSystem): SupportRecordSystem =>
  new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === "getCaseByExternalId") {
        return async (externalId: string) => {
          const c = await target.getCaseByExternalId(externalId);
          return c && { ...c, caseId: RECREATED_CASE_ID };
        };
      }
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });

const observations = async (supportRequestId: string) =>
  (
    await h.db.tx(
      (q) =>
        q.query<{ case_state: string; previous_state: string | null }>(
          "select case_state, previous_state from support_case_observations where support_request_id = $1 order by observed_at, observation_id",
          [supportRequestId],
        ),
      { role: "owner" },
    )
  ).rows;

const reopenAudits = async () => (await h.deps.auditQuery.search({ tenantId: TENANT_ID, action: "support_request.case_reopened", limit: 10 })).length;

describe("reopened cases", () => {
  it("[SPEC-13.resolution-metrics][DATA-01] a Case observed closed and later open again is one reopening: recorded on change only, audited and counted by issue category", async () => {
    const svc = service({ caseStates: TEST_CASE_STATES });
    const { supportRequestId, issueExternalId } = await syncedRequest();
    expect(await svc.observeCaseStatus(TENANT_ID, supportRequestId)).toEqual({ observed: true, caseState: "OPEN", reopened: false, reasonCode: "CASE_STATUS_OBSERVED" });
    // Re-reading an unchanged state records nothing new.
    await svc.observeCaseStatus(TENANT_ID, supportRequestId);
    h.fixtures.supportRecords.setCaseStatus(issueExternalId, "CLOSED_TEST_ONLY");
    expect((await svc.observeCaseStatus(TENANT_ID, supportRequestId)).caseState).toBe("CLOSED");
    expect(h.metrics.counterValue("vsp_cases_reopened_total")).toBe(0);
    h.fixtures.supportRecords.setCaseStatus(issueExternalId, "WORKING_TEST_ONLY");
    expect(await svc.observeCaseStatus(TENANT_ID, supportRequestId)).toEqual({ observed: true, caseState: "OPEN", reopened: true, reasonCode: "CASE_REOPENED" });
    expect(await observations(supportRequestId)).toEqual([
      { case_state: "OPEN", previous_state: null },
      { case_state: "CLOSED", previous_state: "OPEN" },
      { case_state: "OPEN", previous_state: "CLOSED" },
    ]);
    expect(h.metrics.counterValue("vsp_cases_reopened_total", { issue_category: "billing_question" })).toBe(1);
    expect(h.metrics.counterValue("vsp_case_status_observations_total", { case_state: "open" })).toBe(3);
    expect(await reopenAudits()).toBe(1);
    // A second read of the reopened Case is not another reopening.
    expect((await svc.observeCaseStatus(TENANT_ID, supportRequestId)).reopened).toBe(false);
    expect(h.metrics.counterValue("vsp_cases_reopened_total")).toBe(1);
    // DATA-01: vendor status text, request and Case ids never reach a label.
    const series = JSON.stringify(h.metrics.allSeries());
    for (const s of ["WORKING_TEST_ONLY", "CLOSED_TEST_ONLY", supportRequestId, issueExternalId]) expect(series).not.toContain(s);
  });

  it("[SPEC-13.resolution-metrics][OPS-03] without an approved Case Status mapping (placeholder default) nothing is recorded or guessed", async () => {
    expect(DEFAULT_CASE_STATE_MAPPING).toEqual({ open: [], closed: [] });
    const svc = service();
    const { supportRequestId, issueExternalId } = await syncedRequest();
    h.fixtures.supportRecords.setCaseStatus(issueExternalId, "Closed");
    expect(await svc.observeCaseStatus(TENANT_ID, supportRequestId)).toEqual({ observed: false, caseState: "UNMAPPED", reopened: false, reasonCode: "CASE_STATUS_UNMAPPED" });
    expect(await observations(supportRequestId)).toEqual([]);
    expect(h.metrics.counterValue("vsp_case_status_observations_total", { case_state: "unmapped" })).toBe(1);
    expect(() => service({ caseStates: { open: ["X"], closed: ["X"] } })).toThrow("CASE_STATE_MAPPING_INVALID");
  });

  it("[SPEC-13.resolution-metrics][OPS-03] a missing request, a vendor outage and an engaged INTEGRATION kill switch change nothing", async () => {
    const svc = service({ caseStates: TEST_CASE_STATES });
    const { supportRequestId } = await syncedRequest();
    await svc.observeCaseStatus(TENANT_ID, supportRequestId);
    expect(await svc.observeCaseStatus(TENANT_ID, "sr_synthNoSuchRequest0001")).toMatchObject({ observed: false, reasonCode: "SUPPORT_REQUEST_NOT_FOUND" });

    h.fixtures.faults.inject({ integrationId: "salesforce", operation: "getCaseByExternalId", kind: "OUTAGE", mode: "once" });
    expect(await svc.observeCaseStatus(TENANT_ID, supportRequestId)).toMatchObject({ observed: false, caseState: null, reopened: false });

    const snapshot: KillSwitchSnapshot = { aiAdmission: false, writes: false, outboundNotifications: false, intents: [], integrations: ["salesforce"], modelVersions: [], voiceVersions: [] };
    const gated = service({ caseStates: TEST_CASE_STATES, supportRecords: new KillSwitchGatedSupportRecords({ inner: h.fixtures.supportRecords, snapshot: async () => snapshot }) });
    expect(await gated.observeCaseStatus(TENANT_ID, supportRequestId)).toMatchObject({ observed: false, reasonCode: "KILL_SWITCH_INTEGRATION" });
    expect(await observations(supportRequestId)).toHaveLength(1);
  });

  it("[SPEC-13.resolution-metrics][OPS-03] an unsynchronized request is never read from the vendor (CASE_NOT_SYNCED), even when a timed-out write left its Case there", async () => {
    const svc = service({ caseStates: TEST_CASE_STATES });
    // The Case write reaches the fixture but its response is lost: the platform has not recorded a Case id.
    h.fixtures.faults.inject({ integrationId: "salesforce", operation: "upsertCase", kind: "TIMEOUT_AFTER_COMMIT", mode: "once" });
    const { supportRequestId, issueExternalId, syncState } = await requestAfterSync();
    expect(syncState).not.toBe("SYNCED");
    const caseIds = await h.db.tx((q) => q.query<{ salesforce_case_id: string | null }>("select salesforce_case_id from support_requests where support_request_id = $1", [supportRequestId]), {
      role: "owner",
    });
    expect(caseIds.rows).toEqual([{ salesforce_case_id: null }]);
    expect(h.fixtures.supportRecords.records().cases.map((c) => c.externalId)).toContain(issueExternalId);
    const reads = h.fixtures.supportRecords.apiCallCount("getCaseByExternalId");
    expect(await svc.observeCaseStatus(TENANT_ID, supportRequestId)).toEqual({ observed: false, caseState: null, reopened: false, reasonCode: "CASE_NOT_SYNCED" });
    // No vendor read is spent on it (API allocation) and nothing is recorded or counted.
    expect(h.fixtures.supportRecords.apiCallCount("getCaseByExternalId")).toBe(reads);
    expect(await observations(supportRequestId)).toEqual([]);
    expect(h.metrics.counterValue("vsp_case_status_observations_total")).toBe(0);
  });

  it("[SPEC-13.resolution-metrics][OPS-03] a Case read under the request's external id with another Case id is CASE_ID_MISMATCH: nothing recorded, and a closed request is never counted reopened by a different Case", async () => {
    const svc = service({ caseStates: TEST_CASE_STATES });
    const { supportRequestId, issueExternalId } = await syncedRequest();
    await svc.observeCaseStatus(TENANT_ID, supportRequestId);
    h.fixtures.supportRecords.setCaseStatus(issueExternalId, "CLOSED_TEST_ONLY");
    expect((await svc.observeCaseStatus(TENANT_ID, supportRequestId)).caseState).toBe("CLOSED");
    // The Case under that external id is now another, open Case (deleted and recreated in the vendor).
    h.fixtures.supportRecords.setCaseStatus(issueExternalId, "WORKING_TEST_ONLY");
    const recreated = service({ caseStates: TEST_CASE_STATES, supportRecords: recreatedCaseRecords(h.fixtures.supportRecords) });
    expect(await recreated.observeCaseStatus(TENANT_ID, supportRequestId)).toEqual({ observed: false, caseState: null, reopened: false, reasonCode: "CASE_ID_MISMATCH" });
    expect(await observations(supportRequestId)).toEqual([
      { case_state: "OPEN", previous_state: null },
      { case_state: "CLOSED", previous_state: "OPEN" },
    ]);
    expect(h.metrics.counterValue("vsp_cases_reopened_total")).toBe(0);
    expect(await reopenAudits()).toBe(0);
    expect(JSON.stringify(h.metrics.allSeries())).not.toContain(RECREATED_CASE_ID);
  });

  it("[SPEC-13.resolution-metrics][DATA-03] observations are append-only and tenant-scoped under row-level security", async () => {
    const svc = service({ caseStates: TEST_CASE_STATES });
    const { supportRequestId } = await syncedRequest();
    await svc.observeCaseStatus(TENANT_ID, supportRequestId);
    await expect(h.db.tx((q) => q.query("update support_case_observations set case_state = 'CLOSED'"), { role: "owner" })).rejects.toThrow("SUPPORT_RECORDS_APPEND_ONLY");
    await expect(h.db.tx((q) => q.query("delete from support_case_observations"), { role: "owner" })).rejects.toThrow("SUPPORT_RECORDS_APPEND_ONLY");
    const visible = async (tenantId: string) =>
      (await h.db.tx((q) => q.query<{ n: number }>("select count(*)::int as n from support_case_observations"), { role: "app_worker", rls: { tenantId } })).rows[0]?.n ?? 0;
    expect(await visible(TENANT_ID)).toBe(1);
    expect(await visible("tnt_synthTenantOther0001")).toBe(0);
    await expect(h.db.tx((q) => q.query("select count(*) from support_case_observations"), { role: "app_runtime", rls: { tenantId: TENANT_ID } })).rejects.toThrow();
  });
});
