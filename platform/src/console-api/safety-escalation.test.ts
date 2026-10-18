/**
 * Staff-raised safety escalation through the console (spec section 10: human intervention is a
 * safety signal; on a safety concern stop administrative work and revoke pending nonessential
 * mutations; finding SAFE-HANDOFF-05). LOCAL TEST FIXTURE console composition: the HandoffService
 * is the labelled business stand-in over the REAL TransferCoordinator; the ledger is real.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CALLS, STAFF, TENANT_ID } from "../fixtures/synthetic-world.js";
import { createConsoleHarness, seedCallEvents, seedPendingAction } from "./fixtures/harness.fixture.js";
import type { ConsoleHarness } from "./fixtures/harness.fixture.js";

let h: ConsoleHarness;
beforeAll(async () => {
  h = await createConsoleHarness();
});
afterAll(async () => {
  await h.close();
});

describe("console staff safety escalation (SAFE-HANDOFF-05)", () => {
  it("[SPEC-10.stop-admin-work][SAFE-03][SAFE-HANDOFF-05] a SAFETY_PRIORITY transfer takes the safety route with a HUMAN_INTERVENTION signal and revokes the call's pending mutations", async () => {
    await seedCallEvents(h, CALLS.concurrent.callId);
    const confirmed = await seedPendingAction(h, { callId: CALLS.concurrent.callId, confirm: true, appointmentIndex: 1 });
    const prepared = await seedPendingAction(h, { callId: CALLS.concurrent.callId, appointmentIndex: 3 });
    const otherCall = await seedPendingAction(h, { callId: CALLS.primary.callId, appointmentIndex: 4 });
    expect((await h.ledger.get(TENANT_ID, confirmed.action.actionId))?.state).toBe("CONFIRMED");

    const r = await h.call("calls.transfer", { token: await h.token("safety"), params: { callId: CALLS.concurrent.callId }, body: { destinationId: "dst_safety_priority", reason: "SAFETY_PRIORITY" } });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toMatchObject({ destinationId: "dst_safety_priority" });
    // The safety port was used (not a plain human request), with the staff member as the initiator.
    expect(h.handoff.safetyRequests.at(-1)).toEqual({ callId: CALLS.concurrent.callId, signalSources: ["HUMAN_INTERVENTION"], initiatedBy: STAFF.safety.staffId });
    // Pending mutations of THIS call are revoked through the ledger (audited there); other calls are untouched.
    expect((await h.ledger.get(TENANT_ID, confirmed.action.actionId))?.state).toBe("CANCELLED");
    expect((await h.ledger.get(TENANT_ID, prepared.action.actionId))?.state).toBe("CANCELLED");
    expect((await h.ledger.get(TENANT_ID, otherCall.action.actionId))?.state).toBe("PREPARED");
    const cancels = await h.db.query<{ actor: string; reason: string }>(
      "select event->>'actorRef' as actor, event->>'reasonCode' as reason from audit_outbox where action = 'action.cancel' and correlation_id = any($1::text[])",
      [[confirmed.action.actionId, prepared.action.actionId]],
    );
    expect(cancels.rows).toHaveLength(2);
    expect(cancels.rows.every((x) => x.actor === STAFF.safety.staffId && x.reason === "SAFETY_ESCALATION")).toBe(true);
    const done = await h.db.query<{ reason: string }>("select event->>'reasonCode' as reason from audit_outbox where action = 'console.calls.transfer' and outcome = 'SUCCEEDED' and call_id = $1", [CALLS.concurrent.callId]);
    expect(done.rows.map((x) => x.reason)).toContain("SAFETY_ESCALATION_ROUTED");
  });

  it("[SAFE-03][SAFE-HANDOFF-05] a safety-purpose destination chosen with another reason is also a safety escalation", async () => {
    await seedCallEvents(h, CALLS.repeat.callId);
    const before = h.handoff.safetyRequests.length;
    const r = await h.call("calls.transfer", { token: await h.token("supervisor"), params: { callId: CALLS.repeat.callId }, body: { destinationId: "dst_safety_backup", reason: "CALLER_REQUESTED_HUMAN" } });
    expect(r.statusCode).toBe(200);
    expect(h.handoff.safetyRequests.length).toBe(before + 1);
    expect(h.handoff.safetyRequests.at(-1)).toMatchObject({ callId: CALLS.repeat.callId, signalSources: ["HUMAN_INTERVENTION"], initiatedBy: STAFF.supervisor.staffId });
  });
});
