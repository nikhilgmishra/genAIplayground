/**
 * Business-layer gaps closed after wave 2, over the REAL modules (PGlite, OPA bundle,
 * ledger, identity, transfer coordinator) and LOCAL SYNTHETIC fixtures:
 *  - a verified caller's complaint links to the caller's own subject (policy-authorized);
 *    unverified complaints stay unlinked;
 *  - a representative with valid authority creates subject-linked support requests;
 *  - practice staff read the onboarding status of their practice's providers only;
 *  - SupportRequestService.listForCall and the extended trace (lastReasonCode,
 *    syncedAt, outboxMessageIds, console view under row-level security);
 *  - console-initiated transfers: allowlisted staff-selected destination + initiator.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ORGANIZATIONS, PEOPLE, STAFF, TENANT_ID } from "../fixtures/synthetic-world.js";
import { staffActor } from "../ops/testing.js";
import type { AuthContext } from "../protocol/index.js";
import { AccessDeniedError } from "../shared/errors.js";
import { createBusinessHarness, expectDone, type BusinessHarness } from "./testing/harness.js";

let h: BusinessHarness;
beforeEach(async () => {
  h = await createBusinessHarness();
});
afterEach(async () => {
  await h.close();
});

let seq = 0;
const callId = (label: string) => `cal_synthGap${label}${String(++seq).padStart(6, "0")}`;

async function verified(person: (typeof PEOPLE)[keyof typeof PEOPLE], label: string): Promise<AuthContext> {
  const { sessionRef } = await h.startCall(callId(label));
  return h.verify(person, sessionRef);
}

const refOf = (data: unknown, key: "complaint" | "request"): string => (data as Record<string, { supportReference: string }>)[key]?.supportReference as string;

/** SYNTHETIC current legal authority Emery -> Blake that includes the support-request scope. */
function grantEmeryBlake(grantId = "gnt_synthEmeryBlakeSupport01", subjectId: string = PEOPLE.blake.subjectId as string) {
  h.fixtures.relationships.addGrant({
    grantId,
    kind: "legal_representative",
    actorId: PEOPLE.emery.actorId,
    subjectId,
    organizationId: null,
    scopes: ["support_request:create"],
    source: "legal_authority_registry",
    validFrom: "2026-01-01T00:00:00.000Z",
    validUntil: null,
    constraints: [],
  });
}

describe("complaint linking", () => {
  it("[AUTH-02] [SPEC-4.complaint] a verified (A2 self) caller's complaint is linked to the caller's own subject; an unverified complaint stays unlinked", async () => {
    const avery = await verified(PEOPLE.avery, "CmpAvery");
    const linked = expectDone(await h.invoke("submit_complaint", avery, { category: "SERVICE_EXPERIENCE", wantsCallback: true, language: "en" }));
    if (linked.outcome.status !== "SUCCESS") throw new Error("expected success");
    expect(linked.masked).toMatchObject({ linkedToAccount: true });
    const t1 = await h.business.supportRequests.trace(TENANT_ID, refOf(linked.outcome.data, "complaint"));
    expect(t1?.supportRequest).toMatchObject({ subjectRef: PEOPLE.avery.subjectId, issueCategory: "complaint", audience: "client" });

    const { ctx } = await h.startCall(callId("CmpAnon"));
    const anon = expectDone(await h.invoke("submit_complaint", ctx, { category: "SERVICE_EXPERIENCE", wantsCallback: false, language: "en" }));
    if (anon.outcome.status !== "SUCCESS") throw new Error("expected success");
    expect(anon.masked).toMatchObject({ linkedToAccount: false });
    expect((await h.business.supportRequests.trace(TENANT_ID, refOf(anon.outcome.data, "complaint")))?.supportRequest.subjectRef).toBeNull();
  });

  it("[AUTH-02] [SPEC-13.kill-switches] when policy refuses the subject link the complaint is still accepted, unlinked (the link is authorized, never assumed)", async () => {
    await h.ops.killSwitches.set({ tenantId: TENANT_ID, scope: "INTENT", target: "support_intake", engaged: true, reason: "INCIDENT_UNSAFE_OUTPUT", staff: staffActor("supervisor") });
    const avery = await verified(PEOPLE.avery, "CmpKill");
    const r = expectDone(await h.invoke("submit_complaint", avery, { category: "BILLING", wantsCallback: false, language: "en" }));
    if (r.outcome.status !== "SUCCESS") throw new Error("expected success");
    expect(r.masked).toMatchObject({ linkedToAccount: false });
    expect((await h.business.supportRequests.trace(TENANT_ID, refOf(r.outcome.data, "complaint")))?.supportRequest.subjectRef).toBeNull();
  });

  it("[DATA-01] a verified caller's privacy complaint is linked but stays a restricted record (hidden from the runtime view)", async () => {
    const avery = await verified(PEOPLE.avery, "CmpPrivacy");
    const r = expectDone(await h.invoke("submit_complaint", avery, { category: "PRIVACY_CONCERN", wantsCallback: false, language: "en" }));
    if (r.outcome.status !== "SUCCESS") throw new Error("expected success");
    const ref = refOf(r.outcome.data, "complaint");
    expect(await h.services.support.getByReference(TENANT_ID, ref)).toBeNull();
    expect((await h.business.supportRequests.trace(TENANT_ID, ref))?.supportRequest).toMatchObject({ restricted: true, subjectRef: PEOPLE.avery.subjectId });
  });
});

describe("representative support requests", () => {
  it("[AUTH-05] [SPEC-4.audience] a representative with current authority (scope support_request:create) creates a request linked to the represented subject", async () => {
    grantEmeryBlake();
    const emery = await verified(PEOPLE.emery, "RepOk");
    expect(emery.selectedRole).toBe("personal_representative");
    const r = expectDone(await h.invoke("create_support_request", emery, { issueCategory: "billing_question", linkToAccount: true, urgency: "STANDARD", language: "en" }));
    expect(r.decision.reasonCodes).toEqual(["ALLOW_REPRESENTATIVE"]);
    if (r.outcome.status !== "SUCCESS") throw new Error("expected success");
    expect(r.masked).toMatchObject({ linkedToAccount: true });
    const trace = await h.business.supportRequests.trace(TENANT_ID, refOf(r.outcome.data, "request"));
    expect(trace?.supportRequest).toMatchObject({ subjectRef: PEOPLE.blake.subjectId, audience: "personal_representative" });
    // Without asking to link, the request stays unlinked.
    const plain = expectDone(await h.invoke("create_support_request", emery, { issueCategory: "other", linkToAccount: false, urgency: "STANDARD", language: "en" }));
    expect(plain.masked).toMatchObject({ linkedToAccount: false });
  });

  it("[AUTH-05] a representative without the scope, or whose authority expired, is denied a linked request, never linked to a guessed subject", async () => {
    // The SYNTHETIC registry holds only Emery's expired proxy without the support_request:create scope.
    const emery = await verified(PEOPLE.emery, "RepExpired");
    const r = await h.invoke("create_support_request", emery, { issueCategory: "other", linkToAccount: true, urgency: "STANDARD", language: "en" });
    expect(r.stage).toBe("policy");
    if (r.stage === "policy") expect(r.decision.reasonCodes).toContain("RELATIONSHIP_NOT_ESTABLISHED");
    // An expired authority that did carry the scope is denied with the human route (AUTHORIZATION_EXPIRED).
    h.fixtures.relationships.addGrant({
      grantId: "gnt_synthEmeryBlakeSupportOld",
      kind: "legal_representative",
      actorId: PEOPLE.emery.actorId,
      subjectId: PEOPLE.blake.subjectId,
      organizationId: null,
      scopes: ["support_request:create"],
      source: "legal_authority_registry",
      validFrom: "2025-01-01T00:00:00.000Z",
      validUntil: "2026-06-30T23:59:59.000Z",
      constraints: [],
    });
    const expired = await h.invoke("create_support_request", emery, { issueCategory: "other", linkToAccount: true, urgency: "STANDARD", language: "en" });
    expect(expired.stage).toBe("policy");
    if (expired.stage === "policy") {
      expect(expired.decision.reasonCodes).toContain("AUTHORIZATION_EXPIRED");
      expect(expired.decision.obligations).toContain("REQUIRE_HUMAN");
    }
    // Unlinked intake is still open to the representative.
    const plain = expectDone(await h.invoke("create_support_request", emery, { issueCategory: "other", linkToAccount: false, urgency: "STANDARD", language: "en" }));
    expect(plain.outcome.status).toBe("SUCCESS");
  });

  it("[AUTH-05] an ambiguous authority (two represented subjects) never links to either: policy denies", async () => {
    grantEmeryBlake("gnt_synthEmeryBlakeSupport01");
    grantEmeryBlake("gnt_synthEmeryAverySupport01", PEOPLE.avery.subjectId as string);
    const emery = await verified(PEOPLE.emery, "RepAmbiguous");
    const r = await h.invoke("create_support_request", emery, { issueCategory: "other", linkToAccount: true, urgency: "STANDARD", language: "en" });
    expect(r.stage).toBe("policy");
  });
});

describe("provider onboarding by practice", () => {
  it("[AUTH-05] [SPEC-4.provider] delegated practice staff read their practice's provider onboarding; providers outside the practice are denied", async () => {
    const riley = await verified(PEOPLE.riley, "OnbRiley");
    const morganRecord = await h.deps.adapters.provider.getOnboardingStatus(PEOPLE.morgan.subjectId as string);
    expect(morganRecord?.organizationId).toBe(ORGANIZATIONS.practiceNorth.organizationId);
    const ok = expectDone(await h.invoke("get_provider_onboarding_status", riley, { providerId: PEOPLE.morgan.subjectId, detail: "STAGE" }));
    expect(ok.decision.reasonCodes).toEqual(["ALLOW_PRACTICE_DELEGATION"]);
    expect(ok.outcome.status).toBe("SUCCESS");
    // A provider with no practice on record: no organization to match.
    expect((await h.invoke("get_provider_onboarding_status", riley, { providerId: PEOPLE.newbie.subjectId, detail: "STAGE" })).stage).toBe("policy");
    // A provider of another practice (SYNTHETIC record of the South practice).
    h.fixtures.store.insert("onboarding", { providerId: "prv_synthProvSouthOnly01", stage: "CONTRACTING", missingDocumentTypes: [], asOf: "2026-10-01T12:00:00.000Z", organizationId: ORGANIZATIONS.practiceSouth.organizationId });
    expect((await h.invoke("get_provider_onboarding_status", riley, { providerId: "prv_synthProvSouthOnly01", detail: "STAGE" })).stage).toBe("policy");
  });

  it("[AUTH-05] a provider still reads the own onboarding record through the self path", async () => {
    const newbie = await verified(PEOPLE.newbie, "OnbNewbie");
    const own = expectDone(await h.invoke("get_provider_onboarding_status", newbie, { providerId: null, detail: "DOCUMENTS" }));
    expect(own.decision.reasonCodes).toEqual(["ALLOW_SELF"]);
  });
});

describe("support request reads", () => {
  it("[SPEC-8.4] listForCall returns the requests of one call (restricted ones included, worker view) and nothing from other calls", async () => {
    const { ctx } = await h.startCall(callId("ListA"));
    const a = expectDone(await h.invoke("create_support_request", ctx, { issueCategory: "other", linkToAccount: false, urgency: "STANDARD", language: "en" }));
    const b = expectDone(await h.invoke("submit_complaint", ctx, { category: "PRIVACY_CONCERN", wantsCallback: false, language: "en" }));
    const other = await h.startCall(callId("ListB"));
    expectDone(await h.invoke("create_support_request", other.ctx, { issueCategory: "other", linkToAccount: false, urgency: "STANDARD", language: "en" }));
    const listed = await h.business.supportRequests.listForCall(TENANT_ID, ctx.callId);
    expect(listed.map((s) => s.referenceNumber).sort()).toEqual([refOf(a.outcome.status === "SUCCESS" ? a.outcome.data : null, "request"), refOf(b.outcome.status === "SUCCESS" ? b.outcome.data : null, "complaint")].sort());
    expect(listed.some((s) => s.restricted)).toBe(true);
    expect(await h.business.supportRequests.listForCall(TENANT_ID, "not a call id")).toEqual([]);
  });

  it("[SPEC-8.4] [OPS-03] the trace carries the last sync reason code, the outbox message ids and syncedAt only once Salesforce confirmed", async () => {
    const { ctx } = await h.startCall(callId("Trace"));
    const r = expectDone(await h.invoke("create_support_request", ctx, { issueCategory: "other", linkToAccount: false, urgency: "STANDARD", language: "en" }));
    const ref = refOf(r.outcome.status === "SUCCESS" ? r.outcome.data : null, "request");
    const first = await h.business.supportRequests.trace(TENANT_ID, ref);
    expect(first?.salesforce).toMatchObject({ syncState: "PENDING", lastReasonCode: null, syncedAt: null });
    expect(first?.outboxMessageIds).toHaveLength(1);
    const [messageId] = first?.outboxMessageIds ?? [];
    const payload = await h.db.tx(async (q) => (await q.query<{ payload: Record<string, unknown> }>("select payload from outbox_messages where message_id = $1", [messageId])).rows[0]?.payload, { role: "owner" });
    h.fixtures.faults.inject({ integrationId: "salesforce", operation: "*", kind: "OUTAGE", mode: "persistent" });
    await h.business.supportRequests.handleSyncMessage(messageId as string, payload as Record<string, unknown>);
    const failed = await h.business.supportRequests.trace(TENANT_ID, ref);
    expect(failed?.salesforce.syncState).toBe("RETRY_SCHEDULED");
    expect(failed?.salesforce.lastReasonCode).toMatch(/^[A-Z][A-Z0-9_]{2,63}$/);
    expect(failed?.salesforce.syncedAt).toBeNull();
  });

  it("[DATA-01] [SPEC-7.break-glass] the console view hides restricted requests unless the restricted-reader flag is set; non-restricted ones are visible either way", async () => {
    const { ctx } = await h.startCall(callId("ConsoleView"));
    const restricted = expectDone(await h.invoke("submit_complaint", ctx, { category: "PRIVACY_CONCERN", wantsCallback: false, language: "en" }));
    const plain = expectDone(await h.invoke("create_support_request", ctx, { issueCategory: "other", linkToAccount: false, urgency: "STANDARD", language: "en" }));
    const rRef = refOf(restricted.outcome.status === "SUCCESS" ? restricted.outcome.data : null, "complaint");
    const pRef = refOf(plain.outcome.status === "SUCCESS" ? plain.outcome.data : null, "request");
    const svc = h.business.supportRequests;
    expect(await svc.trace(TENANT_ID, rRef, { reader: { kind: "console", restrictedReader: false } })).toBeNull();
    expect((await svc.trace(TENANT_ID, rRef, { reader: { kind: "console", restrictedReader: true } }))?.supportRequest.restricted).toBe(true);
    expect((await svc.trace(TENANT_ID, pRef, { reader: { kind: "console", restrictedReader: false } }))?.supportRequest.restricted).toBe(false);
    // The flag is transaction-local: a later plain console read is hidden again.
    expect(await svc.trace(TENANT_ID, rRef, { reader: { kind: "console", restrictedReader: false } })).toBeNull();
  });
});

describe("console-initiated transfers", () => {
  it("[SAFE-05] [OPS-01] a staff-selected allowlisted destination is honoured and the staff member is audited as the initiator", async () => {
    const call = callId("StaffXfer");
    const r = await h.business.handoff.requestHuman({ tenantId: TENANT_ID, callId: call, ctx: null, reason: "CALLER_REQUESTED_HUMAN", language: "en", issueCategory: null, destinationId: "dst_billing_specialist", initiatedBy: { staffId: STAFF.supervisor.staffId } });
    expect(r.destinationId).toBe("dst_billing_specialist");
    expect(h.fixtures.telephony.dials.filter((d) => d.callId === call).map((d) => d.destinationId)).toEqual(["dst_billing_specialist"]);
    const events = await h.deps.auditQuery.search({ tenantId: TENANT_ID, correlationId: r.handoffId, limit: 20 });
    expect(events.find((e) => e.action === "handoff.requested")).toMatchObject({ sourceComponent: "console", actorRef: STAFF.supervisor.staffId, callId: call });
  });

  it("[SAFE-05] a destination outside the trusted allowlist is refused and nothing is dialled", async () => {
    const call = callId("StaffBad");
    const before = h.fixtures.telephony.dials.length;
    for (const bad of ["dst_not_configured", "+15555550100", "sip:queue@example.invalid"]) {
      await expect(h.business.handoff.requestHuman({ tenantId: TENANT_ID, callId: call, ctx: null, reason: "CALLER_REQUESTED_HUMAN", language: "en", issueCategory: null, destinationId: bad })).rejects.toBeInstanceOf(AccessDeniedError);
    }
    expect(h.fixtures.telephony.dials.length).toBe(before);
    await expect(h.business.handoff.requestHuman({ tenantId: TENANT_ID, callId: call, ctx: null, reason: "CALLER_REQUESTED_HUMAN", language: "en", issueCategory: null, initiatedBy: { staffId: "not a staff id" } })).rejects.toThrow("HANDOFF_INITIATOR_INVALID");
  });
});
