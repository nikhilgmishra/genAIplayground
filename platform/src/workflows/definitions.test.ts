import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { WorkflowStateName, WorkflowType, type Outcome } from "../protocol/index.js";
import { SHIPPED_DEFINITIONS, billingDisputeReviewV1, supportRequestSyncV1 } from "./definitions/index.js";
import { parseIsoDuration } from "./duration.js";
import { workflowOutcome } from "./outcome.js";
import { compareVersions, createDefaultRegistry, WorkflowDefinitionRegistry } from "./registry.js";
import { BUSINESS_ROLE_STAFF_MAPPING, OWNER_QUEUE_RE, TERMINAL_STATES, type VersionedWorkflowDefinition } from "./types.js";
import { assertValidDefinition, validateDefinition, WorkflowDefinitionInvalidError } from "./validator.js";

const clone = (d: VersionedWorkflowDefinition): VersionedWorkflowDefinition => structuredClone(d) as VersionedWorkflowDefinition;
const codes = (d: VersionedWorkflowDefinition) => validateDefinition(d).issues.map((i) => i.code);

function mutate(base: VersionedWorkflowDefinition, fn: (d: VersionedWorkflowDefinition) => void): VersionedWorkflowDefinition {
  const d = clone(base);
  fn(d);
  return d;
}

function st(d: VersionedWorkflowDefinition, name: WorkflowStateName) {
  const s = d.states[name];
  if (!s) throw new Error(`fixture state ${name} missing`);
  return s;
}

describe("shipped workflow definitions", () => {
  it("[SPEC-9.workflow] every workflow type ships a versioned definition", () => {
    expect(new Set(SHIPPED_DEFINITIONS.map((d) => d.type))).toEqual(new Set(WorkflowType.options));
    for (const d of SHIPPED_DEFINITIONS) expect(d.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("[SPEC-9.workflow] every nonterminal state has an owner queue, ISO-8601 deadline, retry budget and a routed escalation", () => {
    for (const d of SHIPPED_DEFINITIONS) {
      expect(validateDefinition(d), `${d.type}`).toEqual({ ok: true, issues: [] });
      for (const [name, s] of Object.entries(d.states)) {
        if (!s) continue;
        expect(s.owner).toMatch(OWNER_QUEUE_RE);
        if (TERMINAL_STATES.has(name as WorkflowStateName)) {
          expect(s.terminal).toBe(true);
          expect(s.deadline).toBeNull();
          continue;
        }
        expect(s.terminal).toBe(false);
        expect(parseIsoDuration(s.deadline ?? "").ok).toBe(true);
        expect(Number.isInteger(s.retryBudget)).toBe(true);
        expect(s.escalation).not.toBeNull();
        expect(s.escalation?.ownerQueue).toMatch(OWNER_QUEUE_RE);
        const target = s.transitions[s.escalation?.event ?? ""];
        expect(target).toBeDefined();
        // Escalation hands work to a human owner; it never ends the work.
        expect(TERMINAL_STATES.has(target as WorkflowStateName)).toBe(false);
      }
    }
  });

  it("[SPEC-9.human-task] human-task states declare required staff roles; billing specialist maps onto supervisor/support_agent", () => {
    expect([...BUSINESS_ROLE_STAFF_MAPPING.billing_specialist].sort()).toEqual(["supervisor", "support_agent"]);
    const human = st(billingDisputeReviewV1, "WAITING_FOR_HUMAN");
    expect(human.humanTask?.taskType).toBe("billing_dispute_decision");
    expect([...(human.humanTask?.requiredStaffRoles ?? [])].sort()).toEqual(["supervisor", "support_agent"]);
    expect(billingDisputeReviewV1.humanTaskRoles.WAITING_FOR_HUMAN).toBe("billing_specialist");
    for (const d of SHIPPED_DEFINITIONS) {
      const h = d.states.WAITING_FOR_HUMAN;
      if (!h) continue;
      expect(h.humanTask?.requiredStaffRoles.length).toBeGreaterThan(0);
      // No human task can be decided by auditors or by deployment/security operators.
      for (const r of h.humanTask?.requiredStaffRoles ?? []) expect(["auditor", "deployment_operator", "security_admin"]).not.toContain(r);
    }
  });

  it("[SPEC-8.reconciliation] support_request_sync has no cancel route so customer intent is preserved", () => {
    for (const s of Object.values(supportRequestSyncV1.states)) expect(s?.transitions.CANCEL).toBeUndefined();
  });

  it("[ACT-02] material changes cannot be cancelled after commit submission (external effect may be in flight)", () => {
    for (const d of SHIPPED_DEFINITIONS) {
      for (const [state, byEvent] of Object.entries(d.transitionGuards)) {
        for (const [event, guard] of Object.entries(byEvent ?? {})) {
          if (guard !== "material_change") continue;
          const after = d.states[d.states[state as WorkflowStateName]?.transitions[event] as WorkflowStateName];
          if (d.type === "provider_document_review" || d.type === "billing_dispute_review" || d.type === "partner_onboarding") {
            expect(after?.transitions.CANCEL, `${d.type} ${state}.${event}`).toBeUndefined();
          }
        }
      }
    }
  });

  it("[SPEC-9.workflow] registered definitions are frozen", () => {
    expect(Object.isFrozen(billingDisputeReviewV1)).toBe(true);
    expect(Object.isFrozen(st(billingDisputeReviewV1, "ACCEPTED").transitions)).toBe(true);
  });
});

describe("definition validator", () => {
  const base = billingDisputeReviewV1;

  it.each<[string, (d: VersionedWorkflowDefinition) => void, string]>([
    ["owner removed", (d) => void (st(d, "VALIDATING").owner = ""), "OWNER_MISSING"],
    ["owner not a queue id", (d) => void (st(d, "VALIDATING").owner = "billing team"), "OWNER_INVALID"],
    ["deadline removed", (d) => void (st(d, "WAITING_FOR_HUMAN").deadline = null), "DEADLINE_MISSING"],
    ["calendar deadline", (d) => void (st(d, "WAITING_FOR_HUMAN").deadline = "P1M"), "DEADLINE_CALENDAR_UNITS_NOT_SUPPORTED"],
    ["sub-minute deadline", (d) => void (st(d, "ACCEPTED").deadline = "PT10S"), "DEADLINE_TOO_SHORT"],
    ["non-ISO deadline", (d) => void (st(d, "ACCEPTED").deadline = "15 minutes"), "DEADLINE_NOT_ISO8601"],
    ["negative retry budget", (d) => void (st(d, "ACCEPTED").retryBudget = -1), "RETRY_BUDGET_INVALID"],
    ["fractional retry budget", (d) => void (st(d, "ACCEPTED").retryBudget = 1.5), "RETRY_BUDGET_INVALID"],
    ["escalation removed", (d) => void (st(d, "READY_TO_COMMIT").escalation = null), "ESCALATION_MISSING"],
    ["escalation not routed", (d) => void delete st(d, "READY_TO_COMMIT").transitions.ESCALATED, "ESCALATION_NOT_ROUTED"],
    ["escalation ends the work", (d) => void (st(d, "READY_TO_COMMIT").transitions.ESCALATED = "CANCELLED"), "ESCALATION_TERMINATES_WORK"],
    ["transition to undefined state", (d) => void delete d.states.WAITING_FOR_CALLER, "TRANSITION_TARGET_UNDEFINED"],
    ["unknown transition target name", (d) => void (st(d, "ACCEPTED").transitions.VALIDATE = "NOWHERE" as WorkflowStateName), "TRANSITION_TARGET_UNDEFINED"],
    [
      "unreachable state",
      (d) => {
        delete st(d, "VALIDATING").transitions.NEEDS_CALLER_INFO;
        delete st(d, "WAITING_FOR_HUMAN").transitions.NEEDS_CALLER_INFO;
      },
      "STATE_UNREACHABLE",
    ],
    ["reserved event declared", (d) => void (st(d, "ACCEPTED").transitions.RETRYABLE_FAILURE = "VALIDATING"), "EVENT_RESERVED"],
    ["lower-case event", (d) => void (st(d, "ACCEPTED").transitions.validate = "VALIDATING"), "EVENT_NAME_INVALID"],
    ["terminal state with transitions", (d) => void (st(d, "COMPLETED").transitions.REOPEN = "ACCEPTED"), "TERMINAL_HAS_TRANSITIONS"],
    ["terminal state with deadline", (d) => void (st(d, "COMPLETED").deadline = "P1D"), "TERMINAL_HAS_DEADLINE"],
    ["terminal flag on waiting state", (d) => void (st(d, "WAITING_FOR_CALLER").terminal = true), "TERMINAL_FLAG_MISMATCH"],
    [
      "initial state undefined",
      (d) => {
        d.initial = "READY_TO_COMMIT";
        delete d.states.READY_TO_COMMIT;
      },
      "INITIAL_STATE_UNDEFINED",
    ],
    ["initial state terminal", (d) => void (d.initial = "COMPLETED"), "INITIAL_STATE_TERMINAL"],
    ["human task without roles", (d) => void (st(d, "WAITING_FOR_HUMAN").humanTask = { requiredStaffRoles: [], taskType: "billing_dispute_decision" }), "HUMAN_TASK_ROLES_MISSING"],
    [
      "human task with unknown role",
      (d) => void (st(d, "WAITING_FOR_HUMAN").humanTask = { requiredStaffRoles: ["billing_god"], taskType: "billing_dispute_decision" }),
      "HUMAN_TASK_ROLE_UNKNOWN",
    ],
    ["human state without task", (d) => void delete st(d, "WAITING_FOR_HUMAN").humanTask, "HUMAN_STATE_WITHOUT_TASK"],
    [
      "human task on a non-human state",
      (d) => void (st(d, "VALIDATING").humanTask = { requiredStaffRoles: ["supervisor"], taskType: "billing_dispute_decision" }),
      "HUMAN_TASK_STATE_INVALID",
    ],
    ["human decision unrouted", (d) => void delete st(d, "WAITING_FOR_HUMAN").transitions.HUMAN_REJECTED, "HUMAN_TASK_DECISION_UNROUTED"],
    ["guard without policy-change route", (d) => void delete st(d, "READY_TO_COMMIT").transitions.POLICY_CHANGED_PENDING_ACTION, "GUARD_WITHOUT_POLICY_CHANGE_ROUTE"],
    ["guard on escalation route", (d) => void (d.transitionGuards.READY_TO_COMMIT = { COMMIT: "material_change", ESCALATED: "disclosure" }), "GUARD_ON_SAFETY_ROUTE"],
    ["guard on unknown transition", (d) => void (d.transitionGuards.ACCEPTED = { NOPE: "disclosure" }), "GUARD_UNKNOWN_TRANSITION"],
    ["role mapping mismatch", (d) => void (d.humanTaskRoles.WAITING_FOR_HUMAN = "partner_manager"), "HUMAN_TASK_ROLE_MAPPING_MISMATCH"],
  ])("[SPEC-9.workflow] rejects a definition with %s", (_label, fn, code) => {
    const d = mutate(base, fn);
    expect(codes(d)).toContain(code);
    expect(() => assertValidDefinition(d)).toThrow(WorkflowDefinitionInvalidError);
  });

  it("[SPEC-9.workflow] rejects trap cycles with no path to a terminal state", () => {
    const d: VersionedWorkflowDefinition = {
      type: "complaint_review",
      version: "0.0.1",
      description: "synthetic trap fixture",
      initial: "ACCEPTED",
      states: {
        ACCEPTED: { owner: "q_complaints", deadline: "PT1H", retryBudget: 1, escalation: { event: "ESCALATED", ownerQueue: "q_ops" }, terminal: false, transitions: { VALIDATE: "VALIDATING", ESCALATED: "VALIDATING" } },
        VALIDATING: { owner: "q_complaints", deadline: "PT1H", retryBudget: 1, escalation: { event: "ESCALATED", ownerQueue: "q_ops" }, terminal: false, transitions: { BACK: "ACCEPTED", ESCALATED: "ACCEPTED" } },
        COMPLETED: { owner: "q_complaints", deadline: null, retryBudget: 0, escalation: null, terminal: true, transitions: {} },
      },
      transitionGuards: {},
      humanTaskRoles: {},
    };
    const c = codes(d);
    expect(c).toContain("NO_PATH_TO_TERMINAL");
    expect(c).toContain("STATE_UNREACHABLE");
  });

  it("[SPEC-9.workflow] rejects structurally malformed definitions with a reason code only", () => {
    const r = validateDefinition({ type: "billing_dispute_review", version: "1.0.0", initial: "ACCEPTED", states: { ACCEPTED: { owner: 7 } } } as never);
    expect(r).toEqual({ ok: false, issues: [{ code: "DEFINITION_SHAPE_INVALID" }] });
  });

  it("[SPEC-9.workflow] property: removing an owner, deadline or escalation from any nonterminal state is always rejected", () => {
    const targets = SHIPPED_DEFINITIONS.flatMap((d) =>
      Object.entries(d.states)
        .filter(([, s]) => s && !s.terminal)
        .map(([name]) => ({ d, name: name as WorkflowStateName })),
    );
    fc.assert(
      fc.property(fc.constantFrom(...targets), fc.constantFrom("owner", "deadline", "escalation", "target"), ({ d, name }, kind) => {
        const m = mutate(d, (x) => {
          const s = st(x, name);
          if (kind === "owner") s.owner = "";
          if (kind === "deadline") s.deadline = null;
          if (kind === "escalation") s.escalation = null;
          if (kind === "target") s.transitions.SYNTHETIC_EVENT = "NOT_A_STATE" as WorkflowStateName;
        });
        const r = validateDefinition(m);
        expect(r.ok).toBe(false);
        const expected = { owner: "OWNER_MISSING", deadline: "DEADLINE_MISSING", escalation: "ESCALATION_MISSING", target: "TRANSITION_TARGET_UNDEFINED" }[kind];
        expect(r.issues.some((i) => i.code === expected && i.state === name)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it("[SPEC-9.workflow] property: every state reachable by walking declared transitions is a defined state", () => {
    fc.assert(
      fc.property(fc.constantFrom(...SHIPPED_DEFINITIONS), fc.array(fc.nat(20), { maxLength: 40 }), (d, picks) => {
        let cur: WorkflowStateName = d.initial;
        for (const p of picks) {
          const s = st(d, cur);
          const targets = Object.values(s.transitions).filter((t): t is WorkflowStateName => t !== undefined);
          if (s.terminal || targets.length === 0) {
            expect(s.terminal).toBe(true);
            break;
          }
          cur = targets[p % targets.length] as WorkflowStateName;
          expect(d.states[cur]).toBeDefined();
        }
      }),
      { numRuns: 300 },
    );
  });
});

describe("ISO-8601 deadlines", () => {
  it.each([
    ["PT15M", 900],
    ["PT1H", 3600],
    ["P2D", 172_800],
    ["P1W", 604_800],
    ["P1DT2H30M", 95_400],
  ])("[SPEC-9.workflow] parses %s", (v, seconds) => {
    expect(parseIsoDuration(v)).toEqual({ ok: true, seconds });
  });

  it.each(["P", "PT", "15M", "P1Y", "P2M", "PT0S", "P400D", "-PT5M", "PT5M ", ""])("[SPEC-9.workflow] rejects %j", (v) => {
    expect(parseIsoDuration(v).ok).toBe(false);
  });
});

describe("outcome mapping", () => {
  it("[ACT-04] property: no workflow state maps to RESOLVED without completion and commit receipt evidence", () => {
    fc.assert(
      fc.property(fc.constantFrom(...WorkflowStateName.options), fc.array(fc.string({ maxLength: 24 }), { maxLength: 4 }), (state, receipts) => {
        const out: Outcome = workflowOutcome(state, { commitReceiptIds: receipts });
        if (state !== "COMPLETED") expect(out).not.toBe("RESOLVED");
        if (out === "RESOLVED") expect(receipts.some((r) => r.length > 0)).toBe(true);
        if (!TERMINAL_STATES.has(state)) expect(out).toBe("REQUEST_ACCEPTED");
      }),
      { numRuns: 500 },
    );
  });
});

describe("definition registry", () => {
  it("[SPEC-15.phase5] keeps every version loadable and selects the newest by semantic version", () => {
    const r = new WorkflowDefinitionRegistry();
    const v1 = clone(billingDisputeReviewV1);
    const v10 = mutate(billingDisputeReviewV1, (d) => void (d.version = "1.10.0"));
    const v2 = mutate(billingDisputeReviewV1, (d) => void (d.version = "1.2.0"));
    r.register(v10);
    r.register(v1);
    r.register(v2);
    expect(r.versions("billing_dispute_review")).toEqual(["1.0.0", "1.2.0", "1.10.0"]);
    expect(r.latest("billing_dispute_review")?.version).toBe("1.10.0");
    expect(r.get("billing_dispute_review", "1.0.0")?.version).toBe("1.0.0");
    expect(r.latest("complaint_review")).toBeNull();
  });

  it("[SPEC-9.workflow] refuses to register an invalid definition", () => {
    const r = new WorkflowDefinitionRegistry();
    expect(() => r.register(mutate(billingDisputeReviewV1, (d) => void (st(d, "VALIDATING").escalation = null)))).toThrow(WorkflowDefinitionInvalidError);
    expect(r.all()).toHaveLength(0);
  });

  it("[SPEC-15.phase5] property: version ordering is a consistent total order", () => {
    const ver = fc.tuple(fc.nat(50), fc.nat(50), fc.nat(50)).map(([a, b, c]) => `${a}.${b}.${c}`);
    fc.assert(
      fc.property(ver, ver, (a, b) => {
        expect(Math.sign(compareVersions(a, b))).toBe(-Math.sign(compareVersions(b, a)));
        if (a === b) expect(compareVersions(a, b)).toBe(0);
      }),
    );
  });

  it("[SPEC-9.workflow] the default registry contains every shipped definition", () => {
    const r = createDefaultRegistry();
    expect(r.all().map((d) => `${d.type}@${d.version}`).sort()).toEqual(SHIPPED_DEFINITIONS.map((d) => `${d.type}@${d.version}`).sort());
  });
});
