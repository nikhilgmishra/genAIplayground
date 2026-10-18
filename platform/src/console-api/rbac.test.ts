import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CALLS, OTHER_TENANT_ID, STAFF, TENANT_ID } from "../fixtures/synthetic-world.js";
import { FailClosedPolicyEngine } from "../policy/engine.js";
import type { ConsoleBreakGlass } from "../policy/console.js";
import type { StaffRole } from "../protocol/index.js";
import { CONSOLE_ENDPOINTS, ENDPOINT_ROLES, PUBLIC_ENDPOINTS, STAFF_ROLES } from "./contract.js";
import type { AuthenticatedEndpointKey, EndpointKey } from "./contract.js";
import { createConsoleHarness, insertBreakGlassGrant, seedCallEvents } from "./fixtures/harness.fixture.js";
import type { ConsoleHarness, InjectOptions, StaffKey } from "./fixtures/harness.fixture.js";
import { auditActionFor } from "./stores.js";

const AUTHENTICATED = (Object.keys(CONSOLE_ENDPOINTS) as EndpointKey[]).filter((k) => !(PUBLIC_ENDPOINTS as readonly string[]).includes(k)) as AuthenticatedEndpointKey[];

const STAFF_BY_ROLE: Readonly<Record<StaffRole, StaffKey>> = {
  support_agent: "agent",
  supervisor: "supervisor",
  safety_responder: "safety",
  auditor: "auditor",
  knowledge_editor: "knowledgeEditor",
  policy_approver: "policyApprover",
  deployment_operator: "deployOperator",
  security_admin: "securityAdmin",
};

/** Minimal valid requests (resources mostly absent: a 404 proves authorization passed). */
const REQUEST: Readonly<Record<AuthenticatedEndpointKey, InjectOptions>> = {
  "auth.logout": {},
  me: {},
  overview: {},
  "calls.list": { query: { state: "active" } },
  "calls.get": { params: { callId: "cal_synthCallMissing0001" } },
  "calls.transfer": { params: { callId: "cal_synthCallMissing0001" }, body: { destinationId: "dst_support_general", reason: "CALLER_REQUESTED_HUMAN" } },
  "supportRequests.trace": { params: { ref: "SR-7KQM-W4XP" } },
  "supportRequests.repair": { params: { ref: "SR-7KQM-W4XP" }, body: { reason: "ROOT_CAUSE_FIXED" } },
  "actions.pending": {},
  "actions.cancel": { params: { actionId: "act_synthActionMissing01" }, body: { reason: "OPERATOR_ERROR_CORRECTION", expectedState: "PREPARED" } },
  "reconciliation.list": {},
  "reconciliation.reconcile": { params: { actionId: "act_synthActionMissing01" }, body: {} },
  "reconciliation.retry": { params: { actionId: "act_synthActionMissing01" }, body: { reconciliationId: "rcn_synthReconcile000001", reason: "RECONCILED_NOT_FOUND_RETRY" } },
  "outbox.requeue": { params: { messageId: "msg_synthMessageMissing1" }, body: { reason: "ROOT_CAUSE_FIXED" } },
  "workflows.tasks": {},
  "workflows.decision": { params: { taskId: "tsk_synthTaskMissing0001" }, body: { decision: "APPROVE", reason: "EVIDENCE_VERIFIED" } },
  "safetyEvents.list": {},
  "releases.list": {},
  "releases.review": { params: { releaseId: "rel_synthReleaseMissing1" }, body: { decision: "NO_OBJECTION", reason: "DIFF_REVIEWED" } },
  "budgets.list": {},
  "killSwitches.list": {},
  "killSwitches.set": { body: { scope: "MODEL_VERSION", target: "model-fixture-v1", engaged: false, reason: "ROOT_CAUSE_FIXED", confirmationPhrase: "RELEASE MODEL_VERSION model-fixture-v1" } },
  "audit.search": { query: { limit: "10" } },
  "destinations.list": {},
};

/**
 * Finer rules that legitimately deny an ENDPOINT_ROLES-permitted role for the
 * matrix request. support_agent may cancel only on calls assigned to them; no
 * call-ownership source exists, so the policy denies (fail closed).
 */
const FINER_DENIALS: Partial<Record<AuthenticatedEndpointKey, Partial<Record<StaffRole, string>>>> = {
  "actions.cancel": { support_agent: "STAFF_ROLE_NOT_PERMITTED" },
};

const errorOf = (body: string): { reasonCode: string } => (JSON.parse(body) as { error: { reasonCode: string } }).error;

const AUDITOR_PLUS = { staffId: "stf_synthAuditorPlusSup1", tenantId: TENANT_ID, displayLabel: "Synthetic Auditor Supervisor", roles: ["auditor", "supervisor"] as StaffRole[], idpSubject: "workforce|synth-auditor-supervisor" };
const AUDITOR_APPROVER = { staffId: "stf_synthAuditorApprove1", tenantId: TENANT_ID, displayLabel: "Synthetic Auditor Approver", roles: ["auditor", "policy_approver"] as StaffRole[], idpSubject: "workforce|synth-auditor-approver" };
const OTHER_TENANT_SUPERVISOR = { staffId: "stf_synthOtherTenantSup1", tenantId: OTHER_TENANT_ID, displayLabel: "Synthetic Other Tenant Supervisor", roles: ["supervisor"] as StaffRole[], idpSubject: "workforce|synth-other-supervisor" };

let h: ConsoleHarness;
beforeAll(async () => {
  h = await createConsoleHarness({ extraStaff: [AUDITOR_PLUS, AUDITOR_APPROVER, OTHER_TENANT_SUPERVISOR] });
});
afterAll(async () => {
  await h.close();
});

describe("console RBAC: ENDPOINT_ROLES AND the console policy decision (AUTH-02, spec sections 7 and 13)", () => {
  it("[SPEC-13.console] RBAC matrix: every authenticated endpoint x every staff role; denials are 403 with a reason code and audited", async () => {
    const tokens = new Map<StaffRole, string>();
    for (const role of STAFF_ROLES) tokens.set(role, await h.token(STAFF_BY_ROLE[role]));
    const matrix: string[] = [];
    for (const key of AUTHENTICATED) {
      for (const role of STAFF_ROLES) {
        if (key === "auth.logout") continue; // exercised separately so the matrix tokens stay valid
        const r = await h.call(key, { ...REQUEST[key], token: tokens.get(role) });
        const permitted = (ENDPOINT_ROLES[key] as readonly string[]).includes(role);
        const finer = FINER_DENIALS[key]?.[role];
        if (!permitted || finer) {
          expect(r.statusCode, `${key} ${role}`).toBe(403);
          expect(errorOf(r.body).reasonCode, `${key} ${role}`).toBe(finer ?? "STAFF_ROLE_NOT_PERMITTED");
          const denied = await h.db.query<{ n: number }>("select count(*)::int as n from audit_outbox where action = $1 and outcome = 'DENIED' and event->>'actorRef' = $2", [
            auditActionFor(key),
            STAFF[STAFF_BY_ROLE[role]].staffId,
          ]);
          expect(denied.rows[0]?.n, `${key} ${role} denial audited`).toBeGreaterThan(0);
        } else {
          expect([401, 403], `${key} ${role}`).not.toContain(r.statusCode);
          expect(r.statusCode, `${key} ${role}`).toBeLessThan(500);
        }
        matrix.push(`${key}:${role}:${r.statusCode}`);
      }
    }
    expect(matrix.length).toBe((AUTHENTICATED.length - 1) * STAFF_ROLES.length);
    for (const role of STAFF_ROLES) {
      const r = await h.call("auth.logout", { token: await h.token(STAFF_BY_ROLE[role]) });
      expect(r.statusCode, `logout ${role}`).toBe(200);
    }
  });

  it("[SPEC-7.staff-separation] auditor cannot mutate: every mutating endpoint refuses the auditor role, and the auditor taint wins even with a mutating role", async () => {
    const auditor = await h.token("auditor");
    for (const key of AUTHENTICATED.filter((k) => CONSOLE_ENDPOINTS[k].method === "POST" && k !== "auth.logout")) {
      const r = await h.call(key, { ...REQUEST[key], token: auditor });
      expect(r.statusCode, key).toBe(403);
    }
    const plus = await h.tokenForSubject(AUDITOR_PLUS.idpSubject);
    const ks = await h.call("killSwitches.set", { token: plus, body: { scope: "WRITES", target: "*", engaged: true, reason: "INCIDENT_CONTAINMENT", confirmationPhrase: "ENGAGE WRITES *" } });
    expect(ks.statusCode).toBe(403);
    expect(errorOf(ks.body).reasonCode).toBe("AUDITOR_READ_ONLY");
    expect((await h.killSwitches.snapshot(TENANT_ID)).writes).toBe(false);
    const approver = await h.tokenForSubject(AUDITOR_APPROVER.idpSubject);
    const review = await h.call("releases.review", { ...REQUEST["releases.review"], token: approver });
    expect([403, 404]).toContain(review.statusCode);
    // Reads stay available to the auditor.
    expect((await h.call("audit.search", { token: auditor, query: { limit: "5" } })).statusCode).toBe(200);
    expect((await h.call("releases.list", { token: auditor })).statusCode).toBe(200);
  });

  it("[SPEC-13.kill-switch] support_agent cannot engage any kill switch; deployment_operator only the model/voice version switches", async () => {
    const agent = await h.token("agent");
    for (const [scope, target] of [["AI_ADMISSION", "*"], ["WRITES", "*"], ["INTENT", "appointment.reschedule"], ["MODEL_VERSION", "model-fixture-v1"]] as const) {
      const r = await h.call("killSwitches.set", { token: agent, body: { scope, target, engaged: true, reason: "INCIDENT_CONTAINMENT", confirmationPhrase: `ENGAGE ${scope} ${target}` } });
      expect(r.statusCode, scope).toBe(403);
      expect(errorOf(r.body).reasonCode, scope).toBe("STAFF_ROLE_NOT_PERMITTED");
    }
    const op = await h.token("deployOperator");
    const writes = await h.call("killSwitches.set", { token: op, body: { scope: "WRITES", target: "*", engaged: true, reason: "INCIDENT_CONTAINMENT", confirmationPhrase: "ENGAGE WRITES *" } });
    expect(writes.statusCode).toBe(403);
    expect(errorOf(writes.body).reasonCode).toBe("STAFF_ROLE_NOT_PERMITTED");
    const model = await h.call("killSwitches.set", { token: op, body: { scope: "MODEL_VERSION", target: "model-fixture-v1", engaged: true, reason: "VENDOR_BEHAVIOUR_CHANGE", confirmationPhrase: "ENGAGE MODEL_VERSION model-fixture-v1" } });
    expect(model.statusCode).toBe(200);
    const snap = await h.killSwitches.snapshot(TENANT_ID);
    expect(snap.modelVersions).toEqual(["model-fixture-v1"]);
    expect(snap.writes).toBe(false);
    const release = await h.call("killSwitches.set", { token: op, body: { scope: "MODEL_VERSION", target: "model-fixture-v1", engaged: false, reason: "ROOT_CAUSE_FIXED", confirmationPhrase: "RELEASE MODEL_VERSION model-fixture-v1" } });
    expect(release.statusCode).toBe(200);
  });

  it("[SPEC-7.break-glass] restricted records need a valid break-glass grant from someone else: missing, expired and not-yet-valid grants are refused", async () => {
    h.supportRequests.seed({ referenceNumber: "SR-RSTR-CTD2", restricted: true, now: h.clock.now() });
    const safety = await h.token("safety");
    const none = await h.call("supportRequests.trace", { token: safety, params: { ref: "SR-RSTR-CTD2" } });
    expect(none.statusCode).toBe(403);
    expect(errorOf(none.body).reasonCode).toBe("BREAK_GLASS_REQUIRED");
    // A role that may not view restricted records at all is told so, not invited to obtain break-glass.
    const agentRestricted = await h.call("supportRequests.trace", { token: await h.token("agent"), params: { ref: "SR-RSTR-CTD2" } });
    expect(errorOf(agentRestricted.body).reasonCode).toBe("STAFF_ROLE_NOT_PERMITTED");

    const now = h.clock.now().getTime();
    await insertBreakGlassGrant(h, { staffId: STAFF.safety.staffId, approvedBy: STAFF.securityAdmin.staffId, grantedAt: new Date(now - 3 * 3600_000).toISOString(), expiresAt: new Date(now - 3600_000).toISOString() });
    const expired = await h.call("supportRequests.trace", { token: await h.token("safety"), params: { ref: "SR-RSTR-CTD2" } });
    expect(expired.statusCode).toBe(403);
    expect(errorOf(expired.body).reasonCode).toBe("STAFF_BREAK_GLASS_EXPIRED");
    // An expired grant is not displayed as active.
    expect(JSON.parse((await h.call("me", { token: await h.token("safety") })).body).staff.breakGlass).toBeNull();

    await insertBreakGlassGrant(h, { staffId: STAFF.safety.staffId, approvedBy: STAFF.securityAdmin.staffId, grantedAt: new Date(now - 60_000).toISOString(), expiresAt: new Date(now + 3600_000).toISOString() });
    const valid = await h.call("supportRequests.trace", { token: await h.token("safety"), params: { ref: "SR-RSTR-CTD2" } });
    expect(valid.statusCode).toBe(200);
    expect(JSON.parse(valid.body).supportRequest.restricted).toBe(true);
    expect(JSON.parse((await h.call("me", { token: await h.token("safety") })).body).staff.breakGlass).toMatchObject({ approvedBy: STAFF.securityAdmin.staffId, justificationCode: "ACTIVE_SAFETY_INCIDENT" });
    // Break-glass never adds a role: the safety responder still cannot reach supervisor-only endpoints.
    expect((await h.call("reconciliation.list", { token: await h.token("safety") })).statusCode).toBe(403);
    // Unrestricted records need no grant.
    h.supportRequests.seed({ referenceNumber: "SR-PLAN-CTD3", now: h.clock.now() });
    expect((await h.call("supportRequests.trace", { token: await h.token("agent"), params: { ref: "SR-PLAN-CTD3" } })).statusCode).toBe(200);
  });

  it("[SPEC-7.break-glass] self-granted break-glass is rejected: the database refuses the record, and a self-approved grant denies every endpoint", async () => {
    const now = h.clock.now().getTime();
    await expect(
      insertBreakGlassGrant(h, { staffId: STAFF.supervisor.staffId, approvedBy: STAFF.supervisor.staffId, grantedAt: new Date(now).toISOString(), expiresAt: new Date(now + 3600_000).toISOString() }),
    ).rejects.toThrow();
    const selfGranted: ConsoleBreakGlass = { grantId: "bgl_synthSelfGranted0001", approvedBy: STAFF.supervisor.staffId, justificationCode: "SECURITY_INCIDENT", grantedAt: new Date(now).toISOString(), expiresAt: new Date(now + 3600_000).toISOString() };
    const tampered = await createConsoleHarness({ breakGlass: { kind: "local_fixture", grantFor: async () => selfGranted } });
    try {
      const token = await tampered.token("supervisor");
      for (const key of AUTHENTICATED) {
        const r = await tampered.call(key, { ...REQUEST[key], token });
        expect(r.statusCode, key).toBe(403);
        // ENDPOINT_ROLES is checked first; wherever the role is permitted the policy denies the self-granted identity.
        const expected = (ENDPOINT_ROLES[key] as readonly string[]).includes("supervisor") ? "BREAK_GLASS_SELF_GRANTED" : "STAFF_ROLE_NOT_PERMITTED";
        expect(errorOf(r.body).reasonCode, key).toBe(expected);
      }
    } finally {
      await tampered.close();
    }
  });

  it("[AUTH-02] deny by default: with no loadable policy bundle every authenticated endpoint is refused (POLICY_ENGINE_ERROR)", async () => {
    const failed = await createConsoleHarness({ patchDeps: (d) => ({ ...d, policy: new FailClosedPolicyEngine("POLICY_BUNDLE_NOT_FOUND", d.clock) }) });
    try {
      const token = await failed.token("securityAdmin");
      for (const key of AUTHENTICATED) {
        const r = await failed.call(key, { ...REQUEST[key], token });
        expect(r.statusCode, key).toBe(403);
        expect(errorOf(r.body).reasonCode, key).toBe((ENDPOINT_ROLES[key] as readonly string[]).includes("security_admin") ? "POLICY_ENGINE_ERROR" : "STAFF_ROLE_NOT_PERMITTED");
      }
    } finally {
      await failed.close();
    }
  });

  it("[AUTH-05] tenant isolation: staff of another tenant never see this tenant's calls, support requests or switches", async () => {
    await seedCallEvents(h, CALLS.repeat.callId);
    const own = JSON.parse((await h.call("calls.list", { token: await h.token("supervisor"), query: { state: "active" } })).body) as { calls: { callId: string }[] };
    expect(own.calls.map((c) => c.callId)).toContain(CALLS.repeat.callId);
    const other = await h.tokenForSubject(OTHER_TENANT_SUPERVISOR.idpSubject);
    const list = JSON.parse((await h.call("calls.list", { token: other, query: { state: "active" } })).body) as { calls: unknown[] };
    expect(list.calls).toEqual([]);
    expect((await h.call("calls.get", { token: other, params: { callId: CALLS.repeat.callId } })).statusCode).toBe(404);
    expect((await h.call("supportRequests.trace", { token: other, params: { ref: "SR-PLAN-CTD3" } })).statusCode).toBe(404);
  });

  it("[SPEC-6.no-phi-url] path parameters must be opaque references: a phone number or name in the URL is refused without echoing it", async () => {
    const token = await h.token("supervisor");
    for (const bad of ["+15555550101", "avery.smith", "cal_short"]) {
      const r = await h.call("calls.get", { token, params: { callId: bad } });
      expect(r.statusCode).toBe(400);
      expect(r.body).not.toContain(bad);
      expect(errorOf(r.body).reasonCode).toBe("VALIDATION_FAILED");
    }
    const query = await h.call("calls.list", { token, query: { state: "active", phone: "5555550101" } });
    expect(query.statusCode).toBe(400);
  });
});
