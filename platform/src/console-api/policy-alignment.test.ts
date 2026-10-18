/**
 * Console alignment with the dedicated console read actions, the restricted-reader
 * row-level-security flag, the extended support-request trace and console-initiated
 * transfers (staff-selected allowlisted destination + initiator). LOCAL FIXTURES and
 * SYNTHETIC staff only (fastify.inject).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CALLS, STAFF } from "../fixtures/synthetic-world.js";
import { ENDPOINT_POLICY_ACTIONS } from "./authorize.js";
import { ENDPOINT_ROLES } from "./contract.js";
import type { AuthenticatedEndpointKey } from "./contract.js";
import { createConsoleHarness, insertBreakGlassGrant, seedCallEvents } from "./fixtures/harness.fixture.js";
import type { ConsoleHarness } from "./fixtures/harness.fixture.js";

let h: ConsoleHarness;
beforeAll(async () => {
  h = await createConsoleHarness();
});
afterAll(async () => {
  await h.close();
});

const errorOf = (body: string): { reasonCode: string } => (JSON.parse(body) as { error: { reasonCode: string } }).error;

const READ_ENDPOINTS: Readonly<Partial<Record<AuthenticatedEndpointKey, string>>> = {
  me: "console:session",
  "auth.logout": "console:session",
  overview: "operations:overview",
  "budgets.list": "budget:view",
  "killSwitches.list": "kill_switch:view",
  "reconciliation.list": "reconciliation:view",
  "workflows.tasks": "human_task:view",
  "releases.list": "release:view",
};

describe("dedicated console read actions", () => {
  it("[AUTH-02] [SPEC-13.console] read views map to dedicated non-mutating catalogue actions whose role set equals the endpoint's least-privilege roles", () => {
    const actions = h.policy.catalogue.console.actions;
    for (const [endpoint, action] of Object.entries(READ_ENDPOINTS) as [AuthenticatedEndpointKey, string][]) {
      expect(ENDPOINT_POLICY_ACTIONS[endpoint], endpoint).toEqual([action]);
      const def = actions[action];
      expect(def, action).toBeDefined();
      expect(def?.mutates, action).toBe(false);
      expect(def?.requiresBreakGlass, action).toBe(false);
      expect([...(def?.roles ?? [])].sort(), endpoint).toEqual([...ENDPOINT_ROLES[endpoint]].sort());
    }
  });

  it("[SPEC-7.staff-separation] an auditor reads release candidates but never budgets, kill switches, the overview or reconciliation", async () => {
    const auditor = await h.token("auditor");
    expect((await h.call("releases.list", { token: auditor })).statusCode).toBe(200);
    for (const key of ["budgets.list", "killSwitches.list", "overview", "reconciliation.list"] as const) {
      const r = await h.call(key, { token: auditor });
      expect(r.statusCode, key).toBe(403);
      expect(errorOf(r.body).reasonCode, key).toBe("STAFF_ROLE_NOT_PERMITTED");
    }
    // A support agent sees the overview and human tasks but not the reconciliation queue.
    const agent = await h.token("agent");
    expect((await h.call("overview", { token: agent })).statusCode).toBe(200);
    expect((await h.call("workflows.tasks", { token: agent })).statusCode).toBe(200);
    expect((await h.call("reconciliation.list", { token: agent })).statusCode).toBe(403);
  });
});

describe("restricted support requests", () => {
  it("[SPEC-7.break-glass] [DATA-01] the restricted-reader RLS flag is set only for staff whose restricted_record:view decision allowed", async () => {
    h.supportRequests.seed({ referenceNumber: "SR-RSTR-RDR2", restricted: true, now: h.clock.now() });
    h.supportRequests.seed({ referenceNumber: "SR-PLAN-RDR3", now: h.clock.now() });
    const flagged = () => h.supportRequests.traceReads.filter((r) => r.reader === "console" && r.restrictedReader);

    // Not permitted at all, then permitted role without break-glass: refused, the flag never set.
    expect((await h.call("supportRequests.trace", { token: await h.token("agent"), params: { ref: "SR-RSTR-RDR2" } })).statusCode).toBe(403);
    expect((await h.call("supportRequests.trace", { token: await h.token("safety"), params: { ref: "SR-RSTR-RDR2" } })).statusCode).toBe(403);
    expect(flagged()).toEqual([]);

    // A non-restricted request is read through the console view without the flag.
    expect((await h.call("supportRequests.trace", { token: await h.token("agent"), params: { ref: "SR-PLAN-RDR3" } })).statusCode).toBe(200);
    expect(h.supportRequests.traceReads.at(-1)).toEqual({ referenceNumber: "SR-PLAN-RDR3", reader: "console", restrictedReader: false });
    expect(flagged()).toEqual([]);

    const now = h.clock.now().getTime();
    await insertBreakGlassGrant(h, { staffId: STAFF.safety.staffId, approvedBy: STAFF.securityAdmin.staffId, grantedAt: new Date(now - 60_000).toISOString(), expiresAt: new Date(now + 3600_000).toISOString() });
    const ok = await h.call("supportRequests.trace", { token: await h.token("safety"), params: { ref: "SR-RSTR-RDR2" } });
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body).supportRequest.restricted).toBe(true);
    expect(flagged()).toEqual([{ referenceNumber: "SR-RSTR-RDR2", reader: "console", restrictedReader: true }]);
  });

  it("[SPEC-8.4] the trace shows the last sync reason code and the outbox message ids", async () => {
    h.supportRequests.seed({ referenceNumber: "SR-SYNC-RDR4", now: h.clock.now(), syncState: "RETRY_SCHEDULED", lastReasonCode: "DEPENDENCY_UNAVAILABLE", outboxMessageIds: ["msg_synthSyncMessage00001", "msg_synthSyncMessage00002"] });
    const r = await h.call("supportRequests.trace", { token: await h.token("supervisor"), params: { ref: "SR-SYNC-RDR4" } });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).sync).toMatchObject({ state: "RETRY_SCHEDULED", lastReasonCode: "DEPENDENCY_UNAVAILABLE", syncedAt: null, outboxMessageIds: ["msg_synthSyncMessage00001", "msg_synthSyncMessage00002"] });
  });
});

describe("console-initiated transfers", () => {
  it("[SAFE-05] [OPS-01] the staff-selected allowlisted destination and the initiating staff member reach the handoff service; no substitution", async () => {
    await seedCallEvents(h, CALLS.concurrent.callId);
    const r = await h.call("calls.transfer", { token: await h.token("supervisor"), params: { callId: CALLS.concurrent.callId }, body: { destinationId: "dst_billing_specialist", reason: "CALLER_REQUESTED_HUMAN" } });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body) as { destinationId: string; auditEventId: string };
    expect(body.destinationId).toBe("dst_billing_specialist");
    expect(h.handoff.requests.at(-1)).toMatchObject({ callId: CALLS.concurrent.callId, destinationId: "dst_billing_specialist", initiatedBy: STAFF.supervisor.staffId, authenticated: false });
    const ev = await h.db.query<{ reason_code: string | null }>("select event ->> 'reasonCode' as reason_code from audit_outbox where event_id = $1", [body.auditEventId]);
    expect(ev.rows[0]?.reason_code).toBe("TRANSFER_REQUESTED");
  });
});
