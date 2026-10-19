/**
 * LOCAL SIMULATED COORDINATOR keyword rules against a recording fake of the Studio / tool surface (no
 * stack): which backend calls a caller line leads to. The fake answers like the backend would for a
 * verified SYNTHETIC caller; the coordinator never decides authorization, so nothing here is a policy
 * result. NOT model evaluation. The full-stack behaviour of the same rules is in local-driver.test.ts.
 */
import { describe, expect, it } from "vitest";
import type { Role, ToolResult } from "../../protocol/index.js";
import { FakeClock } from "../../shared/clock.js";
import type { CallSession, ScreeningOutcome } from "./call-session.js";
import { SimulatedCoordinator } from "./coordinator.js";
import { personaFor } from "./personas.js";

type Audience = Role | null;

class FakeSession {
  readonly persona;
  readonly locale = "en-US";
  readonly notes: string[] = [];
  readonly calls: string[] = [];
  readonly spoken: string[] = [];
  readonly screenings: ScreeningOutcome[] = [];
  readonly stack = { clock: new FakeClock(new Date("2026-10-18T15:00:00.000Z")) };
  lastContext: { selectedRole: string } | null = null;
  turnIndex = 0;
  /** Tool results by name (default: SUCCESS with no records). */
  readonly results = new Map<string, Partial<ToolResult>>();

  constructor(audience: Audience) {
    this.persona = personaFor({ audience, intent: "x", initialState: { fixtureSet: "synthetic_world_v1", faults: [] } });
  }

  async screen(_text: string, _asr: number | null): Promise<ScreeningOutcome> {
    const out: ScreeningOutcome = { turnIndex: this.turnIndex, route: "NONE", handoffId: null, interpreterRequired: false, reasonCode: "NO_SAFETY_SIGNAL" };
    this.screenings.push(out);
    return out;
  }
  async tool(name: string, args: Record<string, unknown>, opts: { probe?: string } = {}): Promise<ToolResult | null> {
    this.calls.push(name === "request_human_transfer" ? `${name}:${String(args.reason)}` : opts.probe ? `${name}#${opts.probe}` : name);
    return { status: "SUCCESS", data: {}, speech: null, ...(this.results.get(name) ?? {}) } as unknown as ToolResult;
  }
  async studioHumanRequest(reason: string): Promise<boolean> {
    this.calls.push(`studio_human_request:${reason}`);
    return true;
  }
  async selectRole(role: string): Promise<boolean> {
    this.calls.push(`select_role:${role}`);
    this.lastContext = { selectedRole: role };
    return true;
  }
  async approveSecureLink(): Promise<boolean> {
    return true;
  }
  async authGate(): Promise<boolean> {
    return true;
  }
  speakTemplate(_source: string, templateId: string): void {
    this.spoken.push(templateId);
  }
  tick(): void {}
}

function coordinatorFor(audience: Audience) {
  const s = new FakeSession(audience);
  const c = new SimulatedCoordinator(s as unknown as CallSession, { idpAvailable: () => true });
  const say = async (...lines: string[]) => {
    for (const line of lines) {
      await c.onCallerTurn(line, null, s.turnIndex);
      s.turnIndex += 1;
    }
  };
  const approve = async () => {
    await c.onSystemEvent("VERIFICATION_SECURE_LINK_APPROVED", "", null);
    s.turnIndex += 1;
  };
  return { s, c, say, approve };
}

describe("SimulatedCoordinator — keyword rules (LOCAL FIXTURE; not model evaluation)", () => {
  it("[SAFE-02] [SPEC-14.intent-corpus] safety-adjacent 'make it' idioms are never read as an appointment request: screened, no tool, reported uninterpreted", async () => {
    const lines = ["I can't make it on my own anymore.", "I can't make it this far anymore.", "I won't make it tonight.", "I'm not going to make it.", "I won't be able to make it through tonight."];
    for (const line of lines) {
      const { s, c, say } = coordinatorFor("client");
      await say(line);
      expect(s.screenings, line).toHaveLength(1);
      expect(s.calls, line).toEqual([]);
      expect(c.unsupported(), line).toEqual(["COORDINATOR_COULD_NOT_INTERPRET_TURNS:0"]);
    }
  });

  it("[SAFE-02] [SPEC-14.intent-corpus] the attendance guard: a non-attendance WITH an explicit time next to a guarded word (anymore, on my own, much longer, through, this far) is screened, no tool, reported uninterpreted", async () => {
    // Each line's first clause alone is the cancellation handoff, so the time phrase matched and only the guard keeps
    // the line out of the administrative path. The backend screen may raise no signal for lines like these (the fake
    // screen here never does), which is why the coordinator must not read them as an appointment request.
    const lines = [
      "I can't make it next week, I can't manage on my own anymore.",
      "I can't make it tomorrow, I can't keep up anymore.",
      "I can't make it next week, I'm on my own with all of it.",
      "I won't be able to make it tomorrow, I don't know how much longer I can keep going.",
      "I can't make it today, I'm not sure I'll get through the week.",
      "I'm not going to make it on Friday, I never thought it would get this far.",
    ];
    for (const line of lines) {
      const clause = coordinatorFor("client");
      await clause.say(`${line.split(",")[0] ?? line}.`);
      expect(clause.s.calls, line).toEqual(["select_role:client", "begin_verification"]);

      const { s, c, say } = coordinatorFor("client");
      await say(line);
      expect(s.screenings, line).toHaveLength(1);
      expect(s.calls, line).toEqual([]);
      expect(c.unsupported(), line).toEqual(["COORDINATOR_COULD_NOT_INTERPRET_TURNS:0"]);
    }
  });

  it("[SPEC-4.workflow-catalogue] a stated non-attendance with an explicit time is the cancellation handoff: verification, then a person, never a mutation", async () => {
    const { s, say, approve } = coordinatorFor("client");
    await say("I'm not going to be able to make it next week after all.");
    await approve();
    expect(s.calls).toEqual(["select_role:client", "begin_verification", "request_human_transfer:POLICY_REQUIRES_HUMAN"]);
  });

  it("[DATA-04] 'what we talked about' is a case-status recap; 'remind me what' alone does not take over appointment or billing questions", async () => {
    const recap = coordinatorFor("client");
    await recap.say("Can you remind me what we talked about last time?");
    await recap.approve();
    expect(recap.s.calls).toEqual(["select_role:client", "begin_verification", "get_authorized_case_status"]);

    const time = coordinatorFor("client");
    await time.say("Can you remind me what time my appointment is?");
    await time.approve();
    expect(time.s.calls.at(-1)).toBe("get_appointment_options");

    const owe = coordinatorFor("client");
    await owe.say("Remind me what I owe you.");
    await owe.approve();
    expect(owe.s.calls.at(-1)).toBe("get_invoice_status");
  });

  it("[SPEC-4.workflow-catalogue] waiting on the insurer about a session is a claim-status question, not appointment options; insurance paperwork stays a support request", async () => {
    const claim = coordinatorFor("client");
    await claim.say("I'm waiting to hear back from my insurance about a session in September.");
    await claim.approve();
    expect(claim.s.calls).toEqual(["select_role:client", "begin_verification", "get_claim_status"]);

    const paperwork = coordinatorFor("client");
    await paperwork.say("My insurance wants some kind of paperwork from you.");
    await paperwork.approve();
    expect(paperwork.s.calls.at(-1)).toBe("create_support_request");
  });

  it("[SPEC-4.workflow-catalogue] an explicit hours question outranks a bare billing mention (A0, no role asked); a dispute and a non-question 'for hours' stay billing", async () => {
    const hours = coordinatorFor(null);
    await hours.say("About my bill. No, I'm not in any danger. I just want to know when you're open.");
    expect(hours.s.calls[0]).toBe("search_approved_runbook");
    expect(hours.s.spoken).not.toContain("intake.role_selection");

    const dispute = coordinatorFor("client");
    await dispute.say("I want to dispute this charge. What are your hours?");
    expect(dispute.s.calls).toEqual(["select_role:client", "begin_verification"]);

    const onHold = coordinatorFor(null);
    await onHold.say("I've been on hold for hours about my bill.");
    expect(onHold.s.calls).toEqual([]);
    expect(onHold.s.spoken).toEqual(["intake.role_selection"]);
  });

  it("[AUTH-05] another person's records phrased indirectly ('one of our people', 'who from our plan', 'coordinate care for someone') are forwarded as hostile probes", async () => {
    for (const [audience, line] of [
      ["provider", "I'm trying to coordinate care for someone and need some details."],
      ["payer_representative", "We're doing an audit and need to know who from our plan has been using your services."],
      ["partner", "One of our people has been out a lot and I want to know if they're getting help through our plan."],
    ] as const) {
      const { s, say, approve } = coordinatorFor(audience);
      await say(line);
      if (s.calls.includes("begin_verification")) await approve();
      expect(s.calls.filter((x) => x.includes("#OTHER_SUBJECT_")), line).toHaveLength(1);
      expect(s.spoken.at(-1), line).toBe("policy.denied_generic");
    }
  });

  it("[SPEC-4.role-selection] announcing 'one personal' selects no role; only a stated personal request switches a provider to the client role", async () => {
    const { s, c, say } = coordinatorFor("provider");
    await say("Couple of things today, one for my practice and one personal.");
    expect(s.calls).toEqual([]);
    expect(c.unsupported()).toEqual(["COORDINATOR_COULD_NOT_INTERPRET_TURNS:0"]);
    await say("Also, as a patient myself, can you check my own bill?");
    expect(s.calls).toEqual(["select_role:client", "begin_verification"]);
  });

  it("[AUTH-04] [AUTH-07] a tool refused for an invalid session: the approved verification-failed notice, then re-verification by a person", async () => {
    const { s, say, approve } = coordinatorFor("client");
    s.results.set("get_appointment_options", { status: "POLICY_DENIED", reasonCode: "SESSION_EXPIRED", speech: null } as unknown as Partial<ToolResult>);
    await say("When is my next appointment?");
    await approve();
    expect(s.calls.slice(-2)).toEqual(["get_appointment_options", "request_human_transfer:VERIFICATION_RECOVERY"]);
    expect(s.spoken.at(-1)).toBe("verification.failed_generic");
  });

  it("[DATA-03] [SAFE-02] a recording decline takes the AI out of the call at once; a later AI exit and a repeated decline add no second Studio route", async () => {
    const { s, c } = coordinatorFor("client");
    c.markConsentDeclined();
    expect(c.aiActive).toBe(false);
    expect(c.isRouted).toBe(true);
    await c.aiExit("LIMIT_REACHED"); // GUARDRAIL_LIMIT armed before Studio's alternative was requested
    await c.consentDeclinedAlternative();
    await c.consentDeclinedAlternative();
    expect(s.calls).toEqual(["studio_human_request:CONSENT_DECLINED_ALTERNATIVE"]);
    expect(s.spoken).toEqual(["recording.decline_alternative"]);
    await c.onCallerTurn("I want to check my bill.", null, 1);
    expect(s.calls).toEqual(["studio_human_request:CONSENT_DECLINED_ALTERNATIVE"]);
    expect(s.screenings).toHaveLength(1); // still screened after the decline
  });
});
