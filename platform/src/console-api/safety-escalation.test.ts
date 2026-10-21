/**
 * Staff-raised safety escalation through the console (spec section 10: human intervention is a
 * safety signal; on a safety concern stop administrative work and revoke pending nonessential
 * mutations; finding SAFE-HANDOFF-05). LOCAL TEST FIXTURE console composition: the HandoffService
 * is the labelled business stand-in over the REAL TransferCoordinator; the ledger is real.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CALLS, STAFF, TENANT_ID } from "../fixtures/synthetic-world.js";
import { DependencyError } from "../shared/errors.js";
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

  describe("without telephony control (the live console: telephonyTransferAvailable false)", () => {
    let u: ConsoleHarness;
    let failRoute = false;
    beforeAll(async () => {
      u = await createConsoleHarness({
        patchDeps: (deps) => ({
          ...deps,
          telephonyTransferAvailable: false,
          // TEST-ONLY wrapper over the labelled business stand-in: can make the safety route request itself fail.
          handoff: {
            requestHuman: (i) => deps.handoff.requestHuman(i),
            requestSafetyRoute: async (i) => {
              const r = await deps.handoff.requestSafetyRoute(i);
              if (failRoute) throw new DependencyError("TRANSFER_REQUEST_FAILED", "NOT_STARTED");
              return r;
            },
          },
        }),
      });
    });
    afterAll(async () => {
      await u.close();
    });

    it("[SAFE-HANDOFF-05][SAFE-03][SPEC-10.stop-admin-work] a staff SAFETY escalation still takes the safety path and revokes the call's pending mutations; only the transfer is refused (503 TALKDESK_CONTROL_UNAVAILABLE), never claimed", async () => {
      await seedCallEvents(u, CALLS.concurrent.callId);
      const prepared = await seedPendingAction(u, { callId: CALLS.concurrent.callId, appointmentIndex: 1 });
      const before = u.handoff.safetyRequests.length;
      const r = await u.call("calls.transfer", { token: await u.token("safety"), params: { callId: CALLS.concurrent.callId }, body: { destinationId: "dst_safety_priority", reason: "SAFETY_PRIORITY" } });
      expect(r.statusCode).toBe(503);
      expect(JSON.parse(r.body)).toMatchObject({ error: { reasonCode: "TALKDESK_CONTROL_UNAVAILABLE", retryable: false } });
      expect(u.handoff.safetyRequests.length).toBe(before + 1);
      expect(u.handoff.safetyRequests.at(-1)).toEqual({ callId: CALLS.concurrent.callId, signalSources: ["HUMAN_INTERVENTION"], initiatedBy: STAFF.safety.staffId });
      expect((await u.ledger.get(TENANT_ID, prepared.action.actionId))?.state).toBe("CANCELLED");
      const audit = await u.db.query<{ outcome: string; reason: string }>("select outcome, event->>'reasonCode' as reason from audit_outbox where action = 'console.calls.transfer' and call_id = $1", [CALLS.concurrent.callId]);
      expect(audit.rows.map((x) => x.outcome)).not.toContain("SUCCEEDED");
      expect(audit.rows.map((x) => x.reason)).toEqual(expect.arrayContaining(["SAFETY_PRIORITY", "TALKDESK_CONTROL_UNAVAILABLE"]));
    });

    it("[SAFE-HANDOFF-05] adversarial: the pending mutations are revoked even when the safety route request itself fails", async () => {
      await seedCallEvents(u, CALLS.repeat.callId);
      const prepared = await seedPendingAction(u, { callId: CALLS.repeat.callId, appointmentIndex: 3 });
      failRoute = true;
      try {
        const r = await u.call("calls.transfer", { token: await u.token("safety"), params: { callId: CALLS.repeat.callId }, body: { destinationId: "dst_safety_priority", reason: "SAFETY_PRIORITY" } });
        expect(r.statusCode).toBeGreaterThanOrEqual(500);
      } finally {
        failRoute = false;
      }
      expect((await u.ledger.get(TENANT_ID, prepared.action.actionId))?.state).toBe("CANCELLED");
    });

    it("[SAFE-04] control: a plain transfer without telephony control is refused before anything is attempted (no handoff request, mutations untouched)", async () => {
      await seedCallEvents(u, CALLS.primary.callId);
      const prepared = await seedPendingAction(u, { callId: CALLS.primary.callId, appointmentIndex: 4 });
      const humans = u.handoff.requests.length;
      const safeties = u.handoff.safetyRequests.length;
      const r = await u.call("calls.transfer", { token: await u.token("supervisor"), params: { callId: CALLS.primary.callId }, body: { destinationId: "dst_support_general", reason: "CALLER_REQUESTED_HUMAN" } });
      expect(r.statusCode).toBe(503);
      expect(JSON.parse(r.body)).toMatchObject({ error: { reasonCode: "TALKDESK_CONTROL_UNAVAILABLE" } });
      expect([u.handoff.requests.length, u.handoff.safetyRequests.length]).toEqual([humans, safeties]);
      expect((await u.ledger.get(TENANT_ID, prepared.action.actionId))?.state).toBe("PREPARED");
    });
  });
});
