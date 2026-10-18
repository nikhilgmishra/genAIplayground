/**
 * Case follow-up and the repeat-caller recap (spec sections 8, 9; DATA-04) over the REAL
 * SupportMemoryPg, policy bundle and identity services; organization-scoped requests of
 * practice staff (AUTH-05 organization isolation).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IDP, ORGANIZATIONS, PEOPLE } from "../fixtures/synthetic-world.js";
import { telephony } from "../identity/identity-harness.fixture.js";
import { newId } from "../shared/ids.js";
import { createBusinessHarness, expectDone, type BusinessHarness } from "./testing/harness.js";

let h: BusinessHarness;
beforeEach(async () => {
  h = await createBusinessHarness();
});
afterEach(async () => {
  await h.close();
});

async function averyWithOpenRequest() {
  const first = await h.startCall("cal_synthCallPrimary0001");
  const a1 = await h.verify(PEOPLE.avery, first.sessionRef);
  const r = expectDone(await h.invoke("create_support_request", a1, { issueCategory: "appointment", linkToAccount: true, urgency: "STANDARD", language: "en" }));
  if (r.outcome.status !== "SUCCESS") throw new Error("setup");
  expect(r.masked).toMatchObject({ linkedToAccount: true });
  return (r.outcome.data as { request: { supportReference: string } }).request.supportReference;
}

describe("case follow-up", () => {
  it("[SPEC-9.recap] [DATA-04] a verified repeat caller hears a short recap of the open request from support memory (same subject, A2)", async () => {
    const ref = await averyWithOpenRequest();
    const repeat = await h.startCall("cal_synthCallRepeat00001");
    const auth = await h.verify(PEOPLE.avery, repeat.sessionRef);
    const r = expectDone(await h.invoke("get_authorized_case_status", auth, { supportReference: null }));
    if (r.outcome.status !== "SUCCESS") throw new Error("expected success");
    expect(r.masked).toMatchObject({ recapAvailable: true });
    expect(r.outcome.speech).toMatchObject({ templateId: "case.recap_open_issue", slots: { supportReference: ref, issueCategory: "appointment" } });
    const cases = (r.masked as { cases: { caseRef: string; status: string }[] }).cases;
    expect(cases.map((c) => c.caseRef)).toContain(ref);
    expect(cases.every((c) => c.status !== "COMPLETED")).toBe(true);
  });

  it("[DATA-04] no recap before authentication: an A0 caller on the same phone is denied the case tool", async () => {
    await averyWithOpenRequest();
    const repeat = await h.startCall("cal_synthCallRepeat00001");
    const r = await h.invoke("get_authorized_case_status", repeat.ctx, { supportReference: null });
    expect(r.stage).toBe("policy");
    // The service-level recap independently refuses below A2 and for another subject.
    expect(await h.services.cases.recap(repeat.ctx)).toBeNull();
  });

  it("[DATA-04] no recap for another subject and none once a participant change is flagged", async () => {
    await averyWithOpenRequest();
    const blakeCall = await h.startCall("cal_synthCallRepeat00001");
    const blake = await h.verify(PEOPLE.blake, blakeCall.sessionRef);
    expect(await h.services.cases.recap(blake)).toBeNull();
    const again = await h.startCall("cal_synthCallConcurrent1");
    const avery = await h.verify(PEOPLE.avery, again.sessionRef);
    expect(await h.services.cases.recap(avery)).not.toBeNull();
    expect(await h.services.cases.recap({ ...avery, riskFlags: ["PARTICIPANT_CHANGED"] })).toBeNull();
    expect(await h.services.cases.recap({ ...avery, assurance: "A1" })).toBeNull();
    // A real participant change drops privileges altogether.
    const changed = await h.deps.sessions.applyChange(again.sessionRef, telephony(), { kind: "PARTICIPANT_CHANGED" });
    expect(changed.assurance).toBe("A0");
    expect(await h.services.cases.recap(changed)).toBeNull();
  });

  it("[ACT-04] [SPEC-8.case-status] a support reference reports a status, never 'resolved' because a request or Case exists", async () => {
    const ref = await averyWithOpenRequest();
    const call = await h.startCall("cal_synthCallRepeat00001");
    const auth = await h.verify(PEOPLE.avery, call.sessionRef);
    const r = expectDone(await h.invoke("get_authorized_case_status", auth, { supportReference: ref }));
    if (r.outcome.status !== "SUCCESS") throw new Error("expected success");
    expect(r.outcome.speech).toMatchObject({ templateId: "case.status", slots: { supportReference: ref, caseStatus: "RECEIVED" } });
  });
});

/**
 * SYNTHETIC staff member of the SOUTH practice (LOCAL FIXTURE directory person + delegation-registry
 * record), so organization isolation is shown between two practices' staff over the real policy.
 */
const SAGE = {
  actorId: "act_synthStaffSage00001",
  accountId: "acc_synthStaffSage00001",
  subjectId: null,
  role: "practice_staff",
  displayName: "Sage",
  fullName: "Sage Synthetic-Staff",
  dateOfBirth: null,
  idpIssuer: IDP.providerIssuer,
  idpSubject: "provider|synth-sage",
  channels: [{ channelRef: "chn_synthSageEmail00001", kind: "email", verified: true, changedAt: null }],
  organizationId: ORGANIZATIONS.practiceSouth.organizationId,
  accountState: "ACTIVE",
} as const;

describe("organization-scoped support requests (practice staff)", () => {
  let o: BusinessHarness;
  beforeEach(async () => {
    o = await createBusinessHarness({
      extraPeople: [{ ...SAGE, roles: ["practice_staff"], portalUsername: "sage.synthetic", channels: SAGE.channels.map((c) => ({ ...c })) }],
    });
    o.fixtures.relationships.addGrant({
      grantId: "gnt_synthSageSouthDelegation",
      kind: "practice_delegation",
      actorId: SAGE.actorId,
      subjectId: null,
      organizationId: ORGANIZATIONS.practiceSouth.organizationId,
      scopes: ["remittance:read", "onboarding:read", "case:read"],
      source: "delegation_registry",
      validFrom: "2026-01-01T00:00:00.000Z",
      validUntil: "2027-01-01T00:00:00.000Z",
      constraints: [],
    });
  });
  afterEach(async () => {
    await o.close();
  });

  async function staff(person: typeof PEOPLE.riley | typeof SAGE, callId: string) {
    const { sessionRef } = await o.startCall(callId);
    return o.verify(person as typeof PEOPLE.riley, sessionRef);
  }

  async function caseRefs(auth: Awaited<ReturnType<typeof staff>>, supportReference: string | null): Promise<string[] | "DENIED"> {
    const r = await o.invoke("get_authorized_case_status", auth, { supportReference });
    if (r.stage === "policy") return "DENIED";
    const done = expectDone(r);
    if (done.outcome.status !== "SUCCESS") return "DENIED";
    return (done.masked as { cases: { caseRef: string }[] }).cases.map((c) => c.caseRef);
  }

  it("[AUTH-05][SPEC-4.audience][SPEC-8.case-status] a practice staff request linked to the account is linked to the practice: visible to the practice's staff by list and reference, denied to another practice's staff", async () => {
    const riley = await staff(PEOPLE.riley, newId("cal"));
    const r = expectDone(await o.invoke("create_support_request", riley, { issueCategory: "remittance", linkToAccount: true, urgency: "STANDARD", language: "en" }));
    if (r.outcome.status !== "SUCCESS") throw new Error(`create ${r.outcome.status}`);
    expect(r.masked).toMatchObject({ linkedToAccount: true });
    const ref = (r.outcome.data as { request: { supportReference: string } }).request.supportReference;
    const [row] = (await o.db.tx((tx) => tx.query<{ subject_ref: string | null; organization_ref: string | null; audience: string | null }>("select subject_ref, organization_ref, audience from support_requests where reference_number = $1", [ref]), { role: "owner" })).rows;
    expect(row).toMatchObject({ subject_ref: null, organization_ref: ORGANIZATIONS.practiceNorth.organizationId, audience: "practice_staff" });

    // The same practice's staff (a later call) finds it by listing the organization's cases and by reference.
    const again = await staff(PEOPLE.riley, newId("cal"));
    expect(await caseRefs(again, null)).toContain(ref);
    expect(await caseRefs(again, ref)).toEqual([ref]);

    // Staff of the South practice: not in their organization's list, and the reference is denied by policy.
    const sage = await staff(SAGE, newId("cal"));
    expect(sage.organizationId).toBe(ORGANIZATIONS.practiceSouth.organizationId);
    const southList = await caseRefs(sage, null);
    expect(southList).not.toBe("DENIED");
    expect(southList).not.toContain(ref);
    const denied = await o.invoke("get_authorized_case_status", sage, { supportReference: ref });
    expect(denied.stage).toBe("policy");
    if (denied.stage === "policy") expect(denied.decision.reasonCodes).toContain("RELATIONSHIP_NOT_ESTABLISHED");
    // South's own organization-scoped request stays South's.
    const s = expectDone(await o.invoke("create_support_request", sage, { issueCategory: "provider_onboarding", linkToAccount: true, urgency: "STANDARD", language: "en" }));
    if (s.outcome.status !== "SUCCESS") throw new Error("south create");
    const southRef = (s.outcome.data as { request: { supportReference: string } }).request.supportReference;
    expect(await caseRefs(sage, null)).toEqual([southRef]);
    expect(await caseRefs(again, null)).not.toContain(southRef);
  });

  it("[AUTH-05][OPS-03] the organization link is authorized now: without a live delegation it is refused (never a silently person-only request); without linking the request stays unlinked", async () => {
    const riley = await staff(PEOPLE.riley, newId("cal"));
    const unlinked = expectDone(await o.invoke("create_support_request", riley, { issueCategory: "other", linkToAccount: false, urgency: "STANDARD", language: "en" }));
    if (unlinked.outcome.status !== "SUCCESS") throw new Error("unlinked");
    expect(unlinked.masked).toMatchObject({ linkedToAccount: false });
    const unlinkedRef = (unlinked.outcome.data as { request: { supportReference: string } }).request.supportReference;
    expect(await caseRefs(riley, null)).not.toContain(unlinkedRef);

    // The delegation registry ends Riley's delegation: the organization link is refused by policy.
    o.fixtures.relationships.revokeGrant("gnt_synthRileyNorthDelegation", new Date(o.clock.now().getTime() - 1000).toISOString());
    const refused = expectDone(await o.invoke("create_support_request", riley, { issueCategory: "remittance", linkToAccount: true, urgency: "STANDARD", language: "en" }));
    expect(refused.outcome).toMatchObject({ status: "POLICY_DENIED", reasonCode: "AUTHORIZATION_EXPIRED" });
    const rows = (await o.db.tx((tx) => tx.query("select support_request_id from support_requests where organization_ref = $1", [ORGANIZATIONS.practiceNorth.organizationId]), { role: "owner" })).rows;
    expect(rows).toEqual([]);
  });
});
