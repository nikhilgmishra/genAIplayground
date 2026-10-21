/**
 * Reported status of the routing tools (request_safety_route, request_human_transfer) when no route can be
 * reached (WP-07; FO-21-10, SAFE-03, SAFE-04). Over the REAL TransferCoordinator and HandoffService with the
 * LOCAL telephony fixture; every dial refused is a LOCAL FIXTURE fault (OUTAGE on requestTransfer), the same
 * shape a NOT_CONFIGURED telephony guard port has in the live composition. SYNTHETIC data only.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBusinessHarness, expectDone, type BusinessHarness } from "../../business/testing/harness.js";
import { CALLS } from "../../fixtures/synthetic-world.js";
import { SafetyEventRecorder } from "../../safety/safety-events.js";
import { SAFETY_STUDIO_ROUTE_TEMPLATE_ID, routeUnreachable, safetySpeechTemplate, statusOf } from "./routing.js";

let h: BusinessHarness;
beforeEach(async () => {
  h = await createBusinessHarness();
});
afterEach(async () => {
  await h.close();
});

const ALL_DIALS_REFUSED = { integrationId: "talkdesk-telephony", operation: "requestTransfer", kind: "OUTAGE", mode: "persistent" } as const;

describe("routing tools never claim a transfer that cannot happen", () => {
  it("[FO-21-10][SAFE-04] statusOf: TRANSFER_REQUESTED only while an attempt can still connect", () => {
    const at = "2026-10-21T10:00:00.000Z";
    expect(statusOf(null)).toBe("ROUTE_UNAVAILABLE_USE_STUDIO_ROUTE");
    expect(statusOf({ status: "ROUTING", connectedAt: null, awaitingRetry: false })).toBe("TRANSFER_REQUESTED");
    expect(statusOf({ status: "ROUTING", connectedAt: null })).toBe("TRANSFER_REQUESTED");
    expect(statusOf({ status: "ROUTING", connectedAt: null, awaitingRetry: true })).toBe("ROUTE_UNAVAILABLE_USE_STUDIO_ROUTE");
    expect(statusOf({ status: "HOLDING_FOR_OPERATIONS", connectedAt: null, awaitingRetry: false })).toBe("ROUTE_UNAVAILABLE_USE_STUDIO_ROUTE");
    expect(statusOf({ status: "CONNECTED", connectedAt: at, awaitingRetry: false })).toBe("CONNECTED");
    expect(statusOf({ status: "CONNECTED", connectedAt: null, awaitingRetry: false })).toBe("TRANSFER_REQUESTED");
    expect(routeUnreachable({ status: "ROUTING", connectedAt: at, awaitingRetry: true })).toBe(false);
  });

  it("[FO-21-10][SAFE-03][SAFE-04] adversarial: every dial refused -> request_safety_route reports ROUTE_UNAVAILABLE_USE_STUDIO_ROUTE with no transfer id; the safety evidence is still recorded", async () => {
    h.deps.safetyEvents = new SafetyEventRecorder({ db: h.db, audit: h.deps.audit, clock: h.clock, metrics: h.metrics });
    h.fixtures.faults.inject(ALL_DIALS_REFUSED);
    const { ctx } = await h.startCall();
    const r = expectDone(await h.invoke("request_safety_route", ctx, { signalSource: "EXPLICIT_PHRASE", concernSubject: "SELF", language: "en" }));
    expect(r.decision.allow).toBe(true);
    expect(r.outcome.status).toBe("SUCCESS");
    expect(r.masked).toEqual({ handoff: { status: "ROUTE_UNAVAILABLE_USE_STUDIO_ROUTE", transferId: null, destinationPurpose: "SAFETY_PRIORITY" } });
    // The prompt follows the reported status: never "connecting you with a person" when no route is in flight.
    expect(r.outcome.status === "SUCCESS" ? r.outcome.speech?.templateId : null).toBe(SAFETY_STUDIO_ROUTE_TEMPLATE_ID);
    const [journey] = await h.transfers.journeysForCall(ctx.tenantId, ctx.callId);
    expect(journey).toMatchObject({ priority: "SAFETY", status: "ROUTING", awaitingRetry: true, connectedAt: null });
    expect(h.fixtures.telephony.dials).toHaveLength(0);
    const events = await h.db.tx(async (q) => (await q.query<{ phase: string; reason_code: string }>("select phase, reason_code from safety_events where call_id = $1", [ctx.callId])).rows, { role: "owner" });
    expect(events.length).toBeGreaterThan(0);
  });

  it("[FO-21-10][SAFE-04] adversarial: every dial refused -> request_human_transfer reports ROUTE_UNAVAILABLE_USE_STUDIO_ROUTE and never says 'connecting you now'", async () => {
    h.fixtures.faults.inject(ALL_DIALS_REFUSED);
    const { ctx } = await h.startCall();
    const r = expectDone(await h.invoke("request_human_transfer", ctx, { reason: "CALLER_REQUESTED_HUMAN", language: "en", issueCategory: null, accommodations: [] }));
    expect(r.outcome.status).toBe("SUCCESS");
    expect(r.masked).toMatchObject({ handoff: { status: "ROUTE_UNAVAILABLE_USE_STUDIO_ROUTE", transferId: null, destinationPurpose: "STANDARD_SUPPORT" } });
    expect(r.outcome.status === "SUCCESS" ? r.outcome.speech?.templateId : null).toBe("transfer.failed_next_route");
    const [journey] = await h.transfers.journeysForCall(ctx.tenantId, ctx.callId);
    expect(journey).toMatchObject({ priority: "STANDARD", status: "ROUTING", awaitingRetry: true });
  });

  it("[FO-21-10][SAFE-04] the spoken safety prompt matches the reported route status: the acknowledgment while a route can connect, the Studio route prompt when none can; neither template claims what the other status means", async () => {
    // Available: telephony accepts the dial.
    const { ctx } = await h.startCall();
    const args = { signalSource: "EXPLICIT_PHRASE", concernSubject: "SELF", language: "en" } as const;
    const available = expectDone(await h.invoke("request_safety_route", ctx, args));
    expect(available.masked).toMatchObject({ handoff: { status: "TRANSFER_REQUESTED", destinationPurpose: "SAFETY_PRIORITY" } });
    expect(available.outcome.status === "SUCCESS" ? available.outcome.speech?.templateId : null).toBe("safety.acknowledgment");
    // Unavailable: every dial refused (a second call).
    h.fixtures.faults.inject(ALL_DIALS_REFUSED);
    const second = await h.startCall(CALLS.concurrent.callId);
    const unavailable = expectDone(await h.invoke("request_safety_route", second.ctx, args));
    expect(unavailable.masked).toMatchObject({ handoff: { status: "ROUTE_UNAVAILABLE_USE_STUDIO_ROUTE", transferId: null } });
    expect(unavailable.outcome.status === "SUCCESS" ? unavailable.outcome.speech?.templateId : null).toBe(SAFETY_STUDIO_ROUTE_TEMPLATE_ID);
    // The mapping itself, for every status (including a transfer that could not even be requested: no journey).
    const at = "2026-10-21T10:00:00.000Z";
    expect(safetySpeechTemplate({ journey: null, speechTemplateId: "safety.acknowledgment" })).toBe(SAFETY_STUDIO_ROUTE_TEMPLATE_ID);
    for (const [j, expected] of [
      [{ status: "ROUTING", connectedAt: null, awaitingRetry: false }, "safety.acknowledgment"],
      [{ status: "ROUTING", connectedAt: null, awaitingRetry: true }, SAFETY_STUDIO_ROUTE_TEMPLATE_ID],
      [{ status: "HOLDING_FOR_OPERATIONS", connectedAt: null, awaitingRetry: false }, SAFETY_STUDIO_ROUTE_TEMPLATE_ID],
      [{ status: "CONNECTED", connectedAt: at, awaitingRetry: false }, "safety.acknowledgment"],
    ] as const) {
      expect(safetySpeechTemplate({ journey: j as never, speechTemplateId: "safety.acknowledgment" }), JSON.stringify(j)).toBe(expected);
    }
    // The texts say what each status means: only the acknowledgment says "connecting"; the Studio prompt never does.
    const ack = h.deps.templates.get("safety.acknowledgment", "en-US");
    const studio = h.deps.templates.get(SAFETY_STUDIO_ROUTE_TEMPLATE_ID, "en-US");
    expect(ack?.text).toMatch(/connecting you/i);
    expect(studio?.text).not.toMatch(/connect/i);
    expect(studio?.text).toMatch(/priority line/i);
    expect([studio?.responseClass, studio?.approval.status]).toEqual(["SAFETY", "PENDING_CLINICAL_APPROVAL"]);
    expect(h.deps.templates.get(SAFETY_STUDIO_ROUTE_TEMPLATE_ID, "es-US")?.text).not.toMatch(/comunic/i);
  });

  it("[FO-21-10][SAFE-04] control: once telephony accepts the sweep's retry the same tool reports the transfer in flight", async () => {
    const fault = h.fixtures.faults.inject(ALL_DIALS_REFUSED);
    const { ctx } = await h.startCall();
    const args = { signalSource: "CALLER_REQUEST", concernSubject: "SELF", language: "en" };
    expect(expectDone(await h.invoke("request_safety_route", ctx, args)).masked).toMatchObject({ handoff: { status: "ROUTE_UNAVAILABLE_USE_STUDIO_ROUTE" } });
    h.fixtures.faults.clear(fault);
    await h.transfers.sweepTimeouts();
    const again = expectDone(await h.invoke("request_safety_route", await h.resolve(ctx.sessionRef), args));
    expect(again.masked).toMatchObject({ handoff: { status: "TRANSFER_REQUESTED", destinationPurpose: "SAFETY_PRIORITY" } });
    expect((again.masked as { handoff: { transferId: string | null } }).handoff.transferId).toMatch(/^xfr_/);
    expect(h.fixtures.telephony.dials.length).toBeGreaterThan(0);
  });
});
