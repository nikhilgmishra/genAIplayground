/**
 * AUTH-05 end to end through the REAL OPA policy bundle: providers, partners, practice
 * staff and expired or limited representatives cannot read unrelated records even when
 * they present valid record ids. Resources come from authoritative lookups only.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APPOINTMENTS, CLAIMS, INVOICES, ONBOARDING, ORGANIZATIONS, PEOPLE } from "../fixtures/synthetic-world.js";
import type { AuthContext } from "../protocol/index.js";
import { createBusinessHarness, expectDone, type BusinessHarness } from "./testing/harness.js";

let h: BusinessHarness;
const ctx: Record<string, AuthContext> = {};
let averyReference = "";

const CALL_IDS = {
  avery: "cal_synthCallAccessAvery01",
  morgan: "cal_synthCallAccessMorgan1",
  riley: "cal_synthCallAccessRiley01",
  quinn: "cal_synthCallAccessQuinn01",
  emery: "cal_synthCallAccessEmery01",
  dana: "cal_synthCallAccessDana001",
  newbie: "cal_synthCallAccessNewbie1",
} as const;

beforeAll(async () => {
  h = await createBusinessHarness();
  for (const [name, callId] of Object.entries(CALL_IDS)) {
    const person = PEOPLE[name as keyof typeof PEOPLE];
    const { sessionRef } = await h.startCall(callId);
    ctx[name] = await h.verify(person, sessionRef);
  }
  const sr = expectDone(await h.invoke("create_support_request", ctx.avery as AuthContext, { issueCategory: "appointment", linkToAccount: true, urgency: "STANDARD", language: "en" }));
  if (sr.outcome.status !== "SUCCESS") throw new Error("setup");
  averyReference = (sr.outcome.data as { request: { supportReference: string } }).request.supportReference;
}, 120_000);
afterAll(async () => {
  await h.close();
});

const as = (name: keyof typeof CALL_IDS): AuthContext => ctx[name] as AuthContext;

async function denied(name: keyof typeof CALL_IDS, tool: string, args: Record<string, unknown>) {
  const r = await h.invoke(tool, as(name), args);
  expect(r.stage, `${name} ${tool}`).toBe("policy");
  return r.stage === "policy" ? r.decision.reasonCodes : [];
}

describe("[AUTH-05] no access to unrelated records with valid ids", () => {
  it("[AUTH-05] every persona verified at A2 with server-established role and scope", () => {
    for (const name of Object.keys(CALL_IDS)) expect(as(name as keyof typeof CALL_IDS).assurance).toBe("A2");
    expect(as("quinn").organizationId).toBe(ORGANIZATIONS.partnerAcme.organizationId);
    expect(as("riley").organizationId).toBe(ORGANIZATIONS.practiceNorth.organizationId);
  });

  it("[AUTH-05] a provider cannot read a client's invoice or claim, nor an untreated client's appointment", async () => {
    await denied("morgan", "get_invoice_status", { invoiceId: INVOICES[0].invoiceId, detail: "BALANCE", serviceDate: null });
    await denied("morgan", "get_claim_status", { claimId: CLAIMS[0].claimId });
    // Blake's appointment is with Dr. Morgan in the schedule, but there is no authoritative treating relationship.
    await denied("morgan", "get_appointment_options", { appointmentId: APPOINTMENTS[1].appointmentId, fromDate: "2026-10-20", toDate: "2026-10-31" });
    await denied("morgan", "get_authorized_case_status", { supportReference: averyReference });
  });

  it("[AUTH-05] positive control: the treating provider may read administrative appointment facts of the treated client", async () => {
    const r = expectDone(await h.invoke("get_appointment_options", as("morgan"), { appointmentId: APPOINTMENTS[0].appointmentId, fromDate: "2026-10-20", toDate: "2026-10-31" }));
    expect(r.decision.allow).toBe(true);
    expect(r.outcome.status).toBe("SUCCESS");
  });

  it("[AUTH-05] a partner never reaches an individual's records (case, invoice, appointment)", async () => {
    const reasons = await denied("quinn", "get_authorized_case_status", { supportReference: averyReference });
    expect(reasons.length).toBeGreaterThan(0);
    await denied("quinn", "get_invoice_status", { invoiceId: INVOICES[0].invoiceId, detail: "BALANCE", serviceDate: null });
    await denied("quinn", "get_appointment_options", { appointmentId: APPOINTMENTS[0].appointmentId, fromDate: "2026-10-20", toDate: "2026-10-31" });
  });

  it("[AUTH-05] an expired proxy cannot read the formerly represented client's records", async () => {
    const reasons = await denied("emery", "get_appointment_options", { appointmentId: APPOINTMENTS[1].appointmentId, fromDate: "2026-10-20", toDate: "2026-10-31" });
    expect(reasons).toContain("AUTHORIZATION_EXPIRED");
    await denied("emery", "get_invoice_status", { invoiceId: INVOICES[1].invoiceId, detail: "BALANCE", serviceDate: null });
  });

  it("[AUTH-05] a parent over a minor is not served automatically (minor confidentiality review)", async () => {
    await denied("dana", "get_appointment_options", { appointmentId: APPOINTMENTS[2].appointmentId, fromDate: "2026-10-20", toDate: "2026-10-31" });
  });

  it("[AUTH-05] practice staff see only the delegating practice's remittances", async () => {
    await denied("riley", "get_remittance_status", { practiceId: ORGANIZATIONS.practiceSouth.organizationId, fromDate: "2026-09-01", toDate: "2026-10-31" });
    const ok = expectDone(await h.invoke("get_remittance_status", as("riley"), { practiceId: null, fromDate: "2026-09-01", toDate: "2026-10-31" }));
    if (ok.outcome.status !== "SUCCESS") throw new Error("expected success");
    const data = ok.outcome.data as { remittances: { remittanceId: string }[] };
    expect(data.remittances.map((r) => r.remittanceId).sort()).toEqual(["rem_synthNorthRemit00001", "rem_synthNorthRemit00002"]);
    expect(ok.outcome.speech?.templateId).toBe("remittance.status");
    await denied("riley", "get_claim_status", { claimId: CLAIMS[0].claimId });
  });

  it("[AUTH-05] a provider sees only the own onboarding record", async () => {
    await denied("morgan", "get_provider_onboarding_status", { providerId: ONBOARDING[0].providerId, detail: "DOCUMENTS" });
    const own = expectDone(await h.invoke("get_provider_onboarding_status", as("newbie"), { providerId: null, detail: "DOCUMENTS" }));
    if (own.outcome.status !== "SUCCESS") throw new Error("expected success");
    expect(own.outcome.speech).toMatchObject({ templateId: "credentialing.documents_missing", slots: { missingCount: 2, documentType: "MALPRACTICE_INSURANCE" } });
  });

  it("[AUTH-05] an unknown record id is denied exactly like another person's record (no existence disclosure)", async () => {
    const unknown = await denied("avery", "get_invoice_status", { invoiceId: "inv_synthDoesNotExist0001", detail: "BALANCE", serviceDate: null });
    const other = await denied("avery", "get_invoice_status", { invoiceId: INVOICES[1].invoiceId, detail: "BALANCE", serviceDate: null });
    expect(unknown).toEqual(other);
    const unknownCase = await denied("avery", "get_authorized_case_status", { supportReference: "SR-AAAA-BBBB" });
    expect(unknownCase.length).toBeGreaterThan(0);
  });

  it("[AUTH-05] [SPEC-4.partner-intake] partner intake is organization-scoped and creates no individual record", async () => {
    const r = expectDone(await h.invoke("submit_partner_intake", as("quinn"), { requestType: "NEW_PARTNER_ONBOARDING", urgency: "STANDARD", language: "en" }));
    if (r.outcome.status !== "SUCCESS") throw new Error("expected success");
    const ref = (r.outcome.data as { intake: { supportReference: string } }).intake.supportReference;
    const sr = await h.services.support.getByReference(as("quinn").tenantId, ref);
    expect(sr).toMatchObject({ subjectRef: null, issueCategory: "partner_intake", disposition: "REQUEST_ACCEPTED" });
    expect(await h.services.support.organizationOf(as("quinn").tenantId, sr?.supportRequestId ?? "")).toBe(ORGANIZATIONS.partnerAcme.organizationId);
    expect(r.masked).toMatchObject({ workflowAccepted: true });
    // The partner can follow up its own organization's request, never an individual's.
    const status = expectDone(await h.invoke("get_authorized_case_status", as("quinn"), { supportReference: ref }));
    expect(status.outcome.status).toBe("SUCCESS");
    // A client cannot use the partner tool.
    await denied("avery", "submit_partner_intake", { requestType: "OTHER", urgency: "STANDARD", language: "en" });
  });
});
