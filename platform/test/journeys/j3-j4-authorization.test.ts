/**
 * [SPEC-16.journey-3] Provider/practice staff (SYNTHETIC Riley, delegated to the North
 * practice) checks the delegated practice's remittance: allowed; the South practice's
 * remittance: denied with nothing disclosed.
 * [SPEC-16.journey-4] Partner (SYNTHETIC Quinn, Acme) is denied every individual client
 * record (another person's invoice, appointment, claim, case) while organization-scoped
 * partner intake works (support request + partner_onboarding workflow with a durable grant).
 * Both over the LOCAL FIXTURE composition: Studio role menu, portal MFA verification, MCP tools.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APPOINTMENTS, CLAIMS, INVOICES, ORGANIZATIONS, PEOPLE, REMITTANCES, SLOTS } from "../../src/fixtures/synthetic-world.js";
import { QUINN, RILEY, createJourneyHarness } from "./harness.js";
import type { JourneyHarness } from "./harness.js";

let h: JourneyHarness;
beforeAll(async () => {
  h = await createJourneyHarness({ ingestKnowledge: false });
}, 180_000);
afterAll(async () => {
  await h?.close();
});

describe("[SPEC-16.journey-3] practice staff and delegated remittance", () => {
  it("[SPEC-16.journey-3][AUTH-02][AUTH-05] Riley reads North's remittance (delegated) and is denied South's; outcome INFORMATION_PROVIDED", async () => {
    const call = h.call();
    await call.start();
    await call.role("practice_staff");
    const v = await call.verify(RILEY, "riley.synthetic");
    expect(v.bound).toBe(true);

    const north = await call.tool("get_remittance_status", { practiceId: ORGANIZATIONS.practiceNorth.organizationId, fromDate: "2026-09-01", toDate: "2026-10-15" });
    expect(north.status).toBe("SUCCESS");
    const records = north.data?.remittances as { remittanceId: string }[];
    expect(records.map((r) => r.remittanceId).sort()).toEqual(REMITTANCES.filter((r) => r.practiceId === ORGANIZATIONS.practiceNorth.organizationId).map((r) => r.remittanceId).sort());
    expect(north.policyDecisionId).toMatch(/^pdc_|^[a-z]+_/);

    const south = await call.tool("get_remittance_status", { practiceId: ORGANIZATIONS.practiceSouth.organizationId, fromDate: "2026-09-01", toDate: "2026-10-15" });
    expect(south.status).toBe("POLICY_DENIED");
    expect(south.data ?? null).toBeNull();
    // Nothing of South's record reached the conversational layer in any result.
    const southId = REMITTANCES.find((r) => r.practiceId === ORGANIZATIONS.practiceSouth.organizationId)?.remittanceId as string;
    expect(JSON.stringify(call.results)).not.toContain(southId);

    const events = await h.auditFor(call.callId);
    const invokes = events.filter((e) => e.action === "tool.invoke" && e.evidencePointers.includes("db://tool_catalog/get_remittance_status/1.0.0"));
    expect(invokes.map((e) => e.outcome).sort()).toEqual(["DENIED", "SUCCEEDED"]);
    expect(invokes.find((e) => e.outcome === "DENIED")?.policyDecision?.allow).toBe(false);
    expect(invokes.every((e) => e.actorRef === RILEY.actorId && e.role === "practice_staff")).toBe(true);

    const end = await call.end("FLOW_COMPLETED");
    expect(end).toEqual({ ended: true, outcome: "INFORMATION_PROVIDED", reasonCode: "INFORMATION_PROVIDED" });
    await h.expectAuditChainIntact();
  }, 120_000);
});

describe("[SPEC-16.journey-3] practice staff follow up their practice's request", () => {
  it("[SPEC-16.journey-3][AUTH-05][SPEC-8.case-status] Riley's request linked to the account is organization-scoped (North): a later call finds it through get_authorized_case_status", async () => {
    const first = h.call();
    await first.start();
    await first.role("practice_staff");
    expect((await first.verify(RILEY, "riley.synthetic")).bound).toBe(true);
    const created = await first.tool("create_support_request", { issueCategory: "remittance", linkToAccount: true, urgency: "STANDARD", language: "en" });
    expect(created.status).toBe("SUCCESS");
    expect(created.data?.linkedToAccount).toBe(true);
    const ref = (created.data?.request as { supportReference: string }).supportReference;
    const [row] = await h.q<{ subject_ref: string | null; organization_ref: string | null }>("select subject_ref, organization_ref from support_requests where reference_number = $1", [ref]);
    expect(row).toEqual({ subject_ref: null, organization_ref: ORGANIZATIONS.practiceNorth.organizationId });
    expect((await first.end("FLOW_COMPLETED")).outcome).toBe("REQUEST_ACCEPTED");

    const later = h.call();
    await later.start();
    await later.role("practice_staff");
    expect((await later.verify(RILEY, "riley.synthetic")).bound).toBe(true);
    const status = await later.tool("get_authorized_case_status", { supportReference: null });
    expect(status.status).toBe("SUCCESS");
    expect((status.data?.cases as { caseRef: string }[]).map((c) => c.caseRef)).toContain(ref);
    expect(status.speech?.templateId).toBe("case.status");
    expect((await later.end("FLOW_COMPLETED")).outcome).toBe("INFORMATION_PROVIDED");
  }, 120_000);
});

describe("[SPEC-16.journey-4] partner denied an unrelated client's records", () => {
  it("[SPEC-16.journey-4][AUTH-05][AUTH-03] Quinn gets no individual record; organization intake is accepted with a workflow and grant; outcome REQUEST_ACCEPTED", async () => {
    const call = h.call();
    await call.start();
    await call.role("partner");
    expect((await call.verify(QUINN, "quinn.synthetic")).bound).toBe(true);

    const attempts: [string, Record<string, unknown>][] = [
      ["get_invoice_status", { invoiceId: INVOICES[0].invoiceId, detail: "BALANCE", serviceDate: null }],
      ["get_appointment_options", { appointmentId: APPOINTMENTS[0].appointmentId, fromDate: "2026-10-20", toDate: "2026-10-31" }],
      ["get_claim_status", { claimId: CLAIMS[0].claimId }],
      ["get_remittance_status", { practiceId: ORGANIZATIONS.practiceNorth.organizationId, fromDate: "2026-09-01", toDate: "2026-10-15" }],
      ["prepare_billing_review", { invoiceId: INVOICES[0].invoiceId, reasonCategory: "OTHER" }],
    ];
    for (const [tool, args] of attempts) {
      const r = await call.tool(tool, args);
      expect(r.status, tool).toBe("POLICY_DENIED");
      expect(r.data ?? null, tool).toBeNull();
      expect(r.speech, tool).toBeNull();
    }
    // Nothing was prepared on another person's behalf.
    expect(await h.q("select action_id from action_ledger where subject_id = $1 and actor_id = $2", [INVOICES[0].subjectId, QUINN.actorId])).toEqual([]);

    const intake = await call.tool("submit_partner_intake", { requestType: "NEW_PARTNER_ONBOARDING", urgency: "STANDARD", language: "en" });
    expect(intake.status).toBe("SUCCESS");
    const ref = JSON.stringify(intake.data).match(/SR-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}/)?.[0] as string;
    expect(ref).toBeDefined();
    const sr = await h.c.business.supportRequests.getByReference(h.c.config.tenantId, ref);
    expect(sr).toMatchObject({ issueCategory: "partner_intake", disposition: "REQUEST_ACCEPTED", subjectRef: null, ownerQueue: "q_partner_support" });
    const [row] = await h.q<{ organization_ref: string | null }>("select organization_ref from support_requests where reference_number = $1", [ref]);
    expect(row?.organization_ref).toBe(ORGANIZATIONS.partnerAcme.organizationId);
    const [wf] = await h.q<{ grant_ref: string | null; state: string }>("select grant_ref, state from workflow_instances where workflow_type = 'partner_onboarding' and correlation_id = $1", [sr?.supportRequestId]);
    expect(wf?.grant_ref).toMatch(/^grt_/);
    const [grant] = await h.q<{ subject_id: string; actor_id: string; actions: string[] }>("select subject_id, actor_id, actions from durable_action_grants where grant_id = $1", [wf?.grant_ref]);
    // The grant is organization-scoped: it names the partner organization, never an individual.
    expect(grant).toMatchObject({ subject_id: ORGANIZATIONS.partnerAcme.organizationId, actor_id: QUINN.actorId });
    expect([...(grant?.actions ?? [])].sort()).toEqual(["partner.onboarding.activate", "partner.onboarding.decision_notice"]);

    const end = await call.end("FLOW_COMPLETED");
    expect(end).toEqual({ ended: true, outcome: "REQUEST_ACCEPTED", reasonCode: "REQUEST_ACCEPTED_NOT_RESOLUTION" });

    const events = await h.auditFor(call.callId);
    const denied = events.filter((e) => e.action === "tool.invoke" && e.outcome === "DENIED");
    expect(denied).toHaveLength(attempts.length);
    expect(denied.every((e) => e.subjectRef === null || e.subjectRef !== INVOICES[0].subjectId)).toBe(true);
    await h.expectAuditChainIntact();
  }, 120_000);
});

describe("[SPEC-4.audience] provider's own schedule (LOCAL FIXTURE composition)", () => {
  it("[AUTH-02][AUTH-05][SPEC-4.audience] Dr. Morgan lists their own open slots (no appointment id) and gets no client record; an unrelated client's appointment stays denied", async () => {
    const call = h.call();
    await call.start();
    await call.role("provider");
    expect((await call.verify(PEOPLE.morgan, "morgan.synthetic")).bound).toBe(true);

    const own = await call.tool("get_appointment_options", { appointmentId: null, fromDate: "2026-10-20", toDate: "2026-10-31" });
    expect(own.status).toBe("SUCCESS");
    const records = own.data?.appointments as { slotId: string | null; appointmentId: string | null; status: string }[];
    expect(records.map((r) => r.slotId).sort()).toEqual(SLOTS.filter((x) => x.providerActorId === PEOPLE.morgan.actorId).map((x) => x.slotId).sort());
    expect(records.every((r) => r.status === "OPEN" && r.appointmentId === null)).toBe(true);
    expect(own.speech?.templateId).toBe("appointment.option_offer");
    for (const a of APPOINTMENTS) expect(JSON.stringify(own.data)).not.toContain(a.appointmentId);

    // Blake is not Dr. Morgan's treated client: knowing the appointment id grants nothing.
    const blakeAppt = APPOINTMENTS.find((a) => a.subjectId === PEOPLE.blake.subjectId)?.appointmentId as string;
    const other = await call.tool("get_appointment_options", { appointmentId: blakeAppt, fromDate: "2026-10-20", toDate: "2026-10-31" });
    expect(other.status).toBe("POLICY_DENIED");
    expect(other.data ?? null).toBeNull();

    const events = await h.auditFor(call.callId);
    const invokes = events.filter((e) => e.action === "tool.invoke" && e.evidencePointers.includes("db://tool_catalog/get_appointment_options/1.0.0"));
    expect(invokes.map((e) => e.outcome).sort()).toEqual(["DENIED", "SUCCEEDED"]);
    expect(invokes.find((e) => e.outcome === "SUCCEEDED")?.policyDecision?.reasonCodes).toEqual(["ALLOW_PROVIDER_OWN_SCHEDULE"]);
    expect((await call.end("FLOW_COMPLETED")).outcome).toBe("INFORMATION_PROVIDED");
  }, 120_000);
});
