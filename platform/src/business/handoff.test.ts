/**
 * Human request and safety route (spec section 10) over the REAL TransferCoordinator,
 * action ledger, identity services and assertions, with the LOCAL telephony fixture.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HandoffPackage } from "../protocol/index.js";
import { APPOINTMENTS, DESTINATIONS, PEOPLE, SLOTS, TENANT_ID } from "../fixtures/synthetic-world.js";
import type { DestinationConfig } from "../config/ports.js";
import { createBusinessHarness, expectDone, type BusinessHarness } from "./testing/harness.js";

let h: BusinessHarness;
let captured: HandoffPackage[];

async function setup(destinations?: DestinationConfig[]) {
  h = await createBusinessHarness(destinations ? { destinations } : {});
  captured = [];
  const original = h.transfers.requestTransfer.bind(h.transfers);
  h.transfers.requestTransfer = async (raw, opts) => {
    captured.push(raw as HandoffPackage);
    return original(raw, opts);
  };
}

beforeEach(async () => {
  await setup();
});
afterEach(async () => {
  await h.close();
});

const NO_EVIDENCE = { commitReceiptIds: [], informationProvided: false, requestAccepted: false, transferConnected: false, callerDisconnected: false, policyDeclined: false, failed: false };

describe("human request", () => {
  it("[SAFE-02] an unverified (A0) caller reaches a person; nothing about any account is disclosed", async () => {
    const { ctx } = await h.startCall();
    const r = expectDone(await h.invoke("request_human_transfer", ctx, { reason: "CALLER_REQUESTED_HUMAN", language: "en", issueCategory: null, accommodations: [] }));
    expect(r.decision.allow).toBe(true);
    expect(r.outcome.status).toBe("SUCCESS");
    if (r.outcome.status !== "SUCCESS") return;
    expect(r.masked).toMatchObject({ handoff: { status: "TRANSFER_REQUESTED", destinationPurpose: "STANDARD_SUPPORT" } });
    expect(r.outcome.speech?.templateId).toBe("transfer.in_progress");
    const pkg = captured[0];
    expect(pkg).toMatchObject({ assurance: "A0", authorizedSubjectRef: null, clinicalStatementsIncluded: false, verificationAssertion: null, destinationId: "dst_support_general" });
    expect(h.fixtures.telephony.dials.map((d) => d.destinationId)).toEqual(["dst_support_general"]);
  });

  it("[SAFE-02] the handoff service works with no resolvable session at all (ctx null)", async () => {
    const r = await h.business.handoff.requestHuman({ tenantId: TENANT_ID, callId: "cal_synthCallUnknown00001", ctx: null, reason: "CALLER_REQUESTED_HUMAN", language: "es", issueCategory: "billing_question" });
    expect(r.transferId).not.toBeNull();
    expect(captured[0]).toMatchObject({ assurance: "A0", language: "es", assuranceLimits: ["SESSION_UNRESOLVED_NO_ACCOUNT_CONTEXT"] });
    // Billing specialists are English only in the synthetic config: Spanish goes to the interpreter route.
    expect(captured[0]?.destinationId).toBe("dst_interpreter");
    expect(captured[0]?.accommodations).toContain("interpreter");
  });

  it("[SPEC-16.interpreter] an unsupported language is routed to the interpreter destination", async () => {
    const { ctx } = await h.startCall();
    const r = expectDone(await h.invoke("request_human_transfer", ctx, { reason: "UNSUPPORTED_LANGUAGE", language: "vi", issueCategory: null, accommodations: [] }));
    if (r.outcome.status !== "SUCCESS") throw new Error("expected success");
    expect(r.masked).toMatchObject({ handoff: { destinationPurpose: "INTERPRETER" } });
    expect(r.outcome.speech?.templateId).toBe("language.interpreter_route");
  });

  it("[SAFE-05] tool inputs cannot carry a destination, number or queue", () => {
    const tool = h.tool("request_human_transfer");
    for (const extra of [{ destinationId: "dst_safety_priority" }, { phoneNumber: "+15555550100" }, { queue: "TALKDESK_QUEUE_PLACEHOLDER_GENERAL" }]) {
      expect(tool.input.safeParse({ reason: "CALLER_REQUESTED_HUMAN", language: "en", issueCategory: null, accommodations: [], ...extra }).success).toBe(false);
    }
    expect(h.tool("request_safety_route").input.safeParse({ signalSource: "CALLER_REQUEST", concernSubject: "SELF", language: "en", destinationId: "dst_support_general" }).success).toBe(false);
  });

  it("[SAFE-05] the destination is resolved only from trusted configuration", async () => {
    await h.close();
    const custom: DestinationConfig[] = DESTINATIONS.map((d) => ({ ...d, fallbackDestinationIds: [...d.fallbackDestinationIds], languages: [...d.languages] }));
    const general = custom.find((d) => d.destinationId === "dst_support_general");
    if (!general) throw new Error("fixture");
    general.destinationId = "dst_support_config_only";
    for (const d of custom) d.fallbackDestinationIds = d.fallbackDestinationIds.map((f) => (f === "dst_support_general" ? "dst_support_config_only" : f));
    await setup(custom);
    const { ctx } = await h.startCall();
    await h.invoke("request_human_transfer", ctx, { reason: "CALLER_REQUESTED_HUMAN", language: "en", issueCategory: "other", accommodations: [] });
    expect(captured[0]?.destinationId).toBe("dst_support_config_only");
    for (const dial of h.fixtures.telephony.dials) expect(custom.map((d) => d.destinationId)).toContain(dial.destinationId);
  });

  it("[SAFE-04] a repeated human request returns the active journey and never dials twice; TRANSFERRED only after caller-confirmed connection", async () => {
    const { ctx } = await h.startCall();
    const a = await h.business.handoff.requestHuman({ tenantId: ctx.tenantId, callId: ctx.callId, ctx, reason: "CALLER_REQUESTED_HUMAN", language: "en", issueCategory: null });
    const b = await h.business.handoff.requestHuman({ tenantId: ctx.tenantId, callId: ctx.callId, ctx, reason: "CALLER_REQUESTED_HUMAN", language: "en", issueCategory: null });
    expect(b.handoffId).toBe(a.handoffId);
    expect(h.fixtures.telephony.dials).toHaveLength(1);
    const notYet = await h.business.outcomes.record({ tenantId: ctx.tenantId, callId: ctx.callId, contractId: "human_request@1", evidence: { ...NO_EVIDENCE, requestAccepted: true } });
    expect(notYet.outcome).toBe("REQUEST_ACCEPTED");
    const transferId = a.transferId as string;
    for (const event of ["RECEIVER_ACCEPTED", "BRIDGED"] as const) await h.transfers.applyEvent({ transferId, event, source: "talkdesk.fixture" });
    expect((await h.transfers.get(a.handoffId))?.connectedAt).toBeNull();
    await h.transfers.applyEvent({ transferId, event: "CALLER_CONFIRMED_CONNECTED", source: "talkdesk.fixture" });
    const journey = await h.transfers.get(a.handoffId);
    expect(journey?.connectedAt).not.toBeNull();
    const done = await h.business.outcomes.record({ tenantId: ctx.tenantId, callId: ctx.callId, contractId: "human_request@1", evidence: { ...NO_EVIDENCE, transferConnected: journey?.connectedAt !== null } });
    expect(done.outcome).toBe("TRANSFERRED");
  });

  it("[SPEC-10.handoff-package] a verified caller's package carries assurance, subject, receipts, a support reference and a single-use receiver assertion", async () => {
    const { sessionRef } = await h.startCall();
    const auth = await h.verify(PEOPLE.avery, sessionRef);
    const r = expectDone(await h.invoke("request_human_transfer", auth, { reason: "CALLER_REQUESTED_HUMAN", language: "en", issueCategory: "appointment", accommodations: ["slower_speech"] }));
    if (r.outcome.status !== "SUCCESS") throw new Error("expected success");
    const pkg = captured[0];
    expect(pkg).toMatchObject({ assurance: "A2", authorizedSubjectRef: PEOPLE.avery.subjectId, statedIssue: "appointment", accommodations: ["slower_speech"], clinicalStatementsIncluded: false });
    expect(pkg?.supportReference).toMatch(/^SR-/);
    expect((r.masked as { handoff: { supportReference: string } }).handoff.supportReference).toBe(pkg?.supportReference);
    const claims = await h.deps.assertions.verify(pkg?.verificationAssertion as string, { audience: `vsp-transfer-receiver.${pkg?.destinationId}`, purpose: "transfer_receiver" });
    expect(claims).toMatchObject({ sub: PEOPLE.avery.actorId, call: auth.callId, purpose: "transfer_receiver", actions: [] });
    expect(claims.sid.startsWith("ses_bnd_")).toBe(true);
    await expect(h.deps.assertions.verify(pkg?.verificationAssertion as string, { audience: `vsp-transfer-receiver.${pkg?.destinationId}`, purpose: "transfer_receiver" })).rejects.toBeTruthy();
  });

  it("[SAFE-01] a clinical question goes to the clinical route with the boundary template", async () => {
    const { ctx } = await h.startCall();
    const r = expectDone(await h.invoke("request_human_transfer", ctx, { reason: "CLINICAL_QUESTION", language: "en", issueCategory: "clinical_question_redirected", accommodations: [] }));
    if (r.outcome.status !== "SUCCESS") throw new Error("expected success");
    expect(r.outcome.speech?.templateId).toBe("clinical.boundary");
    expect(r.masked).toMatchObject({ handoff: { destinationPurpose: "CLINICAL_ROUTE" } });
  });
});

describe("safety route", () => {
  it("[SAFE-02] [SAFE-03] the safety route needs no session: priority journey to the safety destination with route timing", async () => {
    const validatedAt = h.clock.now();
    const r = await h.business.handoff.requestSafetyRoute({
      tenantId: TENANT_ID,
      callId: "cal_synthCallUnknown00002",
      ctx: null,
      signals: [{ source: "EXPLICIT_PHRASE", ruleId: "en.self.current", strength: "CREDIBLE", subject: "SELF", temporal: "CURRENT", negated: false, locale: "en-US" }],
      locale: "en-US",
      validatedAt,
    });
    expect(r.speechTemplateId).toBe("safety.acknowledgment");
    expect(r.journey?.priority).toBe("SAFETY");
    expect(r.journey?.safety?.validatedSafetyEventAt).toBe(validatedAt.toISOString());
    expect(r.journey?.safety?.withinTarget).toBe(true);
    expect(h.fixtures.telephony.dials[0]).toMatchObject({ destinationId: "dst_safety_priority", priority: "SAFETY" });
    expect(captured[0]).toMatchObject({ reason: "SAFETY_PRIORITY", safetyRoutingReason: "EXPLICIT_PHRASE", clinicalStatementsIncluded: false, authorizedSubjectRef: null });
  });

  it("[SAFE-02] [SPEC-10.stop-admin-work] the safety route invalidates pending mutations and escalates the session; a later commit is impossible", async () => {
    const { sessionRef } = await h.startCall();
    const auth = await h.verify(PEOPLE.avery, sessionRef);
    const p = expectDone(await h.invoke("prepare_appointment_change", auth, { appointmentId: APPOINTMENTS[0].appointmentId, startsAt: SLOTS[0].startsAt, modality: null }));
    if (p.outcome.status !== "SUCCESS") throw new Error("prepare failed");
    const change = (p.outcome.data as { change: { actionId: string; actionDigest: string } }).change;
    const r = expectDone(await h.invoke("request_safety_route", auth, { signalSource: "CALLER_REQUEST", concernSubject: "SELF", language: "en" }));
    expect(r.outcome.status).toBe("SUCCESS");
    expect(captured[0]?.pendingActionIds).toEqual([change.actionId]);
    expect(captured[0]?.reason).toBe("SAFETY_PRIORITY");
    expect((await h.actions.get(auth.tenantId, change.actionId))?.state).toBe("INVALIDATED");
    const after = await h.resolve(sessionRef);
    expect(after.riskFlags).toContain("SAFETY_ESCALATION_ACTIVE");
    expect(after.assurance).toBe("A0");
    expect(h.fixtures.scheduling.effects).toHaveLength(0);
  });

  it("[SAFE-03] the safety route still dials when audit evidence and support-record creation fail", async () => {
    const { ctx } = await h.startCall();
    h.deps.audit.appendStandalone = async () => {
      throw new Error("AUDIT_DOWN");
    };
    h.deps.audit.append = async () => {
      throw new Error("AUDIT_DOWN");
    };
    const r = await h.business.handoff.requestSafetyRoute({ tenantId: ctx.tenantId, callId: ctx.callId, ctx, signals: [], locale: "en", validatedAt: h.clock.now() });
    expect(r.transferId).not.toBeNull();
    expect(h.fixtures.telephony.dials).toHaveLength(1);
  });
});
