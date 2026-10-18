import { beforeAll, describe, expect, it } from "vitest";
import { ConsoleDecision, buildConsoleInput } from "./console.js";
import type { OpaWasmPolicyEngine } from "./engine.js";
import { NOW, STAFF_ROLE_IDS, TENANT_ID, VALID_BREAK_GLASS, consoleInput, loadTestEngine } from "./fixtures/inputs.fixture.js";

let engine: OpaWasmPolicyEngine;
beforeAll(async () => {
  engine = await loadTestEngine();
});

const decide = (x: unknown) => engine.decideConsoleSync(x);

describe("console policy: role separation (spec section 7)", () => {
  it("[SPEC-7.staff-separation] auditor runs a read-only audit search and every search is audited", async () => {
    const d = await engine.decideConsole(consoleInput("audit:search", "auditor"));
    expect(ConsoleDecision.safeParse(d).success).toBe(true);
    expect(d).toMatchObject({ allow: true, reasonCodes: ["ALLOW_STAFF_ROLE"], obligations: ["AUDIT_ADMIN_ACTION", "AUDIT_READ"] });
  });

  it("[SPEC-7.staff-separation] auditor cannot mutate anything, even with another role", () => {
    const mutating = Object.entries(engine.catalogue.console.actions).filter(([, a]) => a.mutates && !a.prohibited).map(([n]) => n);
    expect(mutating.length).toBeGreaterThan(10);
    for (const action of mutating) {
      const d = decide(consoleInput(action, "auditor", { killSwitchScope: "AI_ADMISSION", initiatorStaffId: STAFF_ROLE_IDS.supervisor }));
      expect(d.allow, action).toBe(false);
      expect(d.reasonCodes, action).toContain("AUDITOR_READ_ONLY");
    }
    const combined = consoleInput("secret:rotate", "security_admin");
    combined.staff.roles = ["auditor", "security_admin"];
    expect(decide(combined)).toMatchObject({ allow: false, reasonCodes: ["AUDITOR_READ_ONLY"] });
  });

  it("[SPEC-7.staff-separation] each role is limited to its own actions", () => {
    expect(decide(consoleInput("deployment:deploy", "deployment_operator")).allow).toBe(true);
    expect(decide(consoleInput("deployment:deploy", "security_admin")).reasonCodes).toEqual(["ROLE_NOT_PERMITTED"]);
    expect(decide(consoleInput("knowledge:edit", "knowledge_editor")).allow).toBe(true);
    expect(decide(consoleInput("knowledge:edit", "policy_approver")).reasonCodes).toEqual(["ROLE_NOT_PERMITTED"]);
    expect(decide(consoleInput("safety_event:acknowledge", "safety_responder")).allow).toBe(true);
    expect(decide(consoleInput("safety_event:acknowledge", "support_agent")).reasonCodes).toEqual(["ROLE_NOT_PERMITTED"]);
  });

  it("[SPEC-14.policy-expansion] a policy approver never approves their own change", () => {
    expect(decide(consoleInput("policy:approve", "policy_approver", { initiatorStaffId: STAFF_ROLE_IDS.policy_approver })).reasonCodes).toEqual(["SELF_APPROVAL_PROHIBITED"]);
    expect(decide(consoleInput("policy:approve", "policy_approver", { initiatorStaffId: STAFF_ROLE_IDS.knowledge_editor })).allow).toBe(true);
    expect(decide(consoleInput("policy:approve", "policy_approver")).reasonCodes).toEqual(["INITIATOR_REQUIRED"]);
  });

  it("[SPEC-16.console] raw queries, secrets, unrestricted transcripts and audit rewrites are never console actions", () => {
    for (const action of ["db:raw_query", "secret:view", "transcript:download_unrestricted", "audit:modify", "audit:delete", "break_glass:self_grant"]) {
      for (const role of Object.keys(STAFF_ROLE_IDS) as (keyof typeof STAFF_ROLE_IDS)[]) {
        const d = decide(consoleInput(action, role));
        expect(d.allow, `${action} ${role}`).toBe(false);
        expect(d.reasonCodes).toContain("CONSOLE_ACTION_PROHIBITED");
      }
    }
  });

  it("[SPEC-13.kill-switch] kill switch roles depend on scope; scope is required", () => {
    expect(decide(consoleInput("kill_switch:engage", "supervisor", { killSwitchScope: "WRITES" })).allow).toBe(true);
    expect(decide(consoleInput("kill_switch:engage", "deployment_operator", { killSwitchScope: "WRITES" })).allow).toBe(false);
    expect(decide(consoleInput("kill_switch:engage", "deployment_operator", { killSwitchScope: "VOICE_VERSION" })).allow).toBe(true);
    expect(decide(consoleInput("kill_switch:engage", "security_admin")).reasonCodes).toEqual(["KILL_SWITCH_SCOPE_REQUIRED", "ROLE_NOT_PERMITTED"]);
  });
});

describe("console policy: MFA, origin and break-glass", () => {
  it("[SPEC-7.staff-mfa] MFA is required for every console action", () => {
    for (const [action, role] of [
      ["journey:inspect", "support_agent"],
      ["audit:search", "auditor"],
      ["secret:rotate", "security_admin"],
    ] as const) {
      const x = consoleInput(action, role);
      x.staff.mfa = false;
      expect(decide(x), action).toMatchObject({ allow: false, reasonCodes: ["STAFF_MFA_REQUIRED"], obligations: ["AUDIT_ADMIN_ACTION"] });
    }
  });

  it("[AUTH-03] the conversational agent cannot request or grant itself break-glass access", () => {
    const req = { ...consoleInput("break_glass:request", "support_agent"), origin: "conversational_agent" as const };
    expect(decide(req)).toMatchObject({ allow: false, reasonCodes: ["ORIGIN_NOT_PERMITTED"] });
    const approve = { ...consoleInput("break_glass:approve", "security_admin", { initiatorStaffId: STAFF_ROLE_IDS.supervisor }), origin: "service_automation" as const };
    expect(decide(approve).reasonCodes).toEqual(["ORIGIN_NOT_PERMITTED"]);
  });

  it("[SPEC-7.break-glass] emergency access is time-bound, justified and approved by someone else", () => {
    const view = () => {
      const x = consoleInput("restricted_record:view", "supervisor");
      x.staff.breakGlass = { ...VALID_BREAK_GLASS };
      return x;
    };
    expect(decide(view())).toMatchObject({ allow: true, reasonCodes: ["ALLOW_BREAK_GLASS", "ALLOW_STAFF_ROLE"], obligations: ["AUDIT_ADMIN_ACTION", "AUDIT_READ", "BREAK_GLASS_REVIEW"] });
    const none = consoleInput("restricted_record:view", "supervisor");
    expect(decide(none).reasonCodes).toEqual(["BREAK_GLASS_REQUIRED"]);
    const self = view();
    self.staff.breakGlass = { ...VALID_BREAK_GLASS, approvedBy: STAFF_ROLE_IDS.supervisor };
    expect(decide(self).reasonCodes).toEqual(["BREAK_GLASS_SELF_GRANTED"]);
    const expired = view();
    expired.staff.breakGlass = { ...VALID_BREAK_GLASS, expiresAt: NOW };
    expect(decide(expired).reasonCodes).toEqual(["BREAK_GLASS_EXPIRED"]);
    const long = view();
    long.staff.breakGlass = { ...VALID_BREAK_GLASS, grantedAt: "2026-10-17T09:00:00.000Z", expiresAt: "2026-10-17T21:00:00.000Z" };
    expect(decide(long).reasonCodes).toEqual(["BREAK_GLASS_DURATION_EXCEEDED"]);
    const roleless = consoleInput("restricted_record:view", "support_agent");
    roleless.staff.breakGlass = { ...VALID_BREAK_GLASS };
    expect(decide(roleless).reasonCodes).toEqual(["ROLE_NOT_PERMITTED"]);
  });

  it("[SPEC-7.break-glass] an unknown justification code is invalid input, not a justification", () => {
    const x = consoleInput("restricted_record:view", "supervisor");
    const bad = { ...x, staff: { ...x.staff, breakGlass: { ...VALID_BREAK_GLASS, justificationCode: "CURIOSITY" } } };
    expect(decide(bad)).toMatchObject({ allow: false, reasonCodes: ["POLICY_INPUT_INVALID"] });
  });

  it("[AUTH-03] extra staff fields (e.g. a claimed role) are rejected", () => {
    const x = consoleInput("journey:inspect", "support_agent");
    expect(decide({ ...x, staff: { ...x.staff, claimedRole: "security_admin" } }).reasonCodes).toEqual(["POLICY_INPUT_INVALID"]);
    expect(decide({ ...x, roles: ["security_admin"] }).reasonCodes).toEqual(["POLICY_INPUT_INVALID"]);
  });

  it("[SPEC-7.organization-isolation] staff cannot act on another tenant's resources", () => {
    expect(decide(consoleInput("journey:inspect", "supervisor", { tenantId: "tnt_synthTenantOther0001" })).reasonCodes).toEqual(["TENANT_MISMATCH"]);
  });

  it("[SPEC-7.staff-mfa] buildConsoleInput maps only trusted staff identity fields", () => {
    const input = buildConsoleInput({
      action: "audit:search",
      origin: "workforce_console",
      environment: "local",
      now: new Date(NOW),
      staff: { staffId: STAFF_ROLE_IDS.auditor, tenantId: TENANT_ID, roles: ["auditor"], mfa: true, authenticatedAt: "2026-10-17T14:00:00.000Z", breakGlass: null },
      resource: { type: "audit_index" },
    });
    expect(input.resource).toEqual({ type: "audit_index", tenantId: null, killSwitchScope: null, initiatorStaffId: null, assignedStaffId: null });
    expect(decide(input).allow).toBe(true);
  });
});
