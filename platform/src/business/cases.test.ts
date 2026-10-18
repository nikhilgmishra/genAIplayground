/**
 * Case follow-up and the repeat-caller recap (spec sections 8, 9; DATA-04) over the REAL
 * SupportMemoryPg, policy bundle and identity services.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PEOPLE } from "../fixtures/synthetic-world.js";
import { telephony } from "../identity/identity-harness.fixture.js";
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
