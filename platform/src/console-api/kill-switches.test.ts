import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CALLS, TENANT_ID } from "../fixtures/synthetic-world.js";
import { killSwitchBlock, notificationAllowed } from "../ops/kill-switches.js";
import { anonymous, loadTestEngine, withKs } from "../policy/fixtures/inputs.fixture.js";
import { createConsoleHarness, seedCallEvents } from "./fixtures/harness.fixture.js";
import type { ConsoleHarness } from "./fixtures/harness.fixture.js";

let h: ConsoleHarness;
beforeAll(async () => {
  h = await createConsoleHarness();
});
afterAll(async () => {
  await h.close();
});

const errorOf = (body: string): { reasonCode: string; retryable: boolean } => (JSON.parse(body) as { error: { reasonCode: string; retryable: boolean } }).error;
const engage = (scope: string, target = "*") => ({ scope, target, engaged: true, reason: "INCIDENT_CONTAINMENT:inc_synthIncident000001", confirmationPhrase: `ENGAGE ${scope} ${target}` });

describe("kill switches through the console (spec section 13, OPS-01, SAFE-02)", () => {
  it("[SPEC-13.console] typed confirmation is re-checked server-side; a mismatch changes nothing and is audited as a denial", async () => {
    const token = await h.token("supervisor");
    for (const phrase of ["ENGAGE WRITES", "engage WRITES *", "ENGAGE AI_ADMISSION *", "RELEASE WRITES *", "ENGAGE  WRITES *"]) {
      const r = await h.call("killSwitches.set", { token, body: { ...engage("WRITES"), confirmationPhrase: phrase } });
      expect(r.statusCode, phrase).toBe(400);
      expect(["CONFIRMATION_MISMATCH", "VALIDATION_FAILED"], phrase).toContain(errorOf(r.body).reasonCode);
    }
    expect((await h.killSwitches.snapshot(TENANT_ID)).writes).toBe(false);
    const denials = await h.db.query<{ n: number }>("select count(*)::int as n from audit_outbox where action = 'console.kill_switches.set' and outcome = 'DENIED' and event->>'reasonCode' = 'CONFIRMATION_MISMATCH'");
    expect(denials.rows[0]?.n).toBeGreaterThan(0);
  });

  it("[SPEC-13.console] the reason is an allowlisted reason code: free text, digit runs and codes for the other direction are refused", async () => {
    const token = await h.token("supervisor");
    for (const reason of ["the caller was upset", "DOB_19800101", "ROOT_CAUSE_FIXED", "NOT_IN_THE_CATALOGUE"]) {
      const r = await h.call("killSwitches.set", { token, body: { ...engage("WRITES"), reason } });
      expect(r.statusCode, reason).toBe(400);
      expect(errorOf(r.body).reasonCode, reason).toBe("REASON_NOT_ALLOWED");
    }
    const unknownTarget = await h.call("killSwitches.set", { token, body: engage("INTENT", "free.typed.intent") });
    expect(errorOf(unknownTarget.body).reasonCode).toBe("KILL_SWITCH_TARGET_UNKNOWN");
    const globalWithTarget = await h.call("killSwitches.set", { token, body: engage("WRITES", "scheduling") });
    expect(errorOf(globalWithTarget.body).reasonCode).toBe("KILL_SWITCH_TARGET_UNKNOWN");
    expect((await h.killSwitches.snapshot(TENANT_ID)).writes).toBe(false);
  });

  it("[OPS-01] engaging AI_ADMISSION and WRITES writes state, history and a console audit event in one transaction; the response names that event", async () => {
    const token = await h.token("supervisor");
    for (const scope of ["AI_ADMISSION", "WRITES"]) {
      const r = await h.call("killSwitches.set", { token, body: engage(scope) });
      expect(r.statusCode, scope).toBe(200);
      const body = JSON.parse(r.body) as { switch: { scope: string; engaged: boolean; changedBy: string; reason: string }; auditEventId: string; safetyRoutesPreserved: boolean };
      expect(body).toMatchObject({ switch: { scope, engaged: true, changedBy: "stf_synthSupervisor01", reason: "INCIDENT_CONTAINMENT:inc_synthIncident000001" }, safetyRoutesPreserved: true });
      const audit = await h.db.query<{ action: string; outcome: string; source: string; actor: string }>(
        "select action, outcome, event->>'sourceComponent' as source, event->>'actorRef' as actor from audit_outbox where event_id = $1",
        [body.auditEventId],
      );
      expect(audit.rows[0]).toEqual({ action: "killswitch.set", outcome: "SUCCEEDED", source: "console", actor: "stf_synthSupervisor01" });
      const history = await h.db.query<{ n: number }>("select count(*)::int as n from kill_switch_history where audit_event_id = $1 and scope = $2", [body.auditEventId, scope]);
      expect(history.rows[0]?.n).toBe(1);
    }
    const snap = await h.killSwitches.snapshot(TENANT_ID);
    expect(snap).toMatchObject({ aiAdmission: true, writes: true });
    const list = JSON.parse((await h.call("killSwitches.list", { token })).body) as { switches: { scope: string; engaged: boolean }[]; safetyRoutesPreserved: boolean; snapshot: { aiAdmission: boolean } };
    expect(list.safetyRoutesPreserved).toBe(true);
    expect(list.snapshot.aiAdmission).toBe(true);
    const overview = JSON.parse((await h.call("overview", { token })).body) as { aiAdmission: { state: string }; killSwitchesEngaged: number };
    expect(overview.aiAdmission.state).toBe("CLOSED_BY_KILL_SWITCH");
    expect(overview.killSwitchesEngaged).toBe(2);
  });

  it("[SAFE-02] after AI_ADMISSION and WRITES are engaged, safety:route and human:request are still allowed by policy and the human route still transfers", async () => {
    const snap = await h.killSwitches.snapshot(TENANT_ID);
    expect(snap.aiAdmission && snap.writes).toBe(true);
    const engine = await loadTestEngine();
    const ks = { aiAdmission: snap.aiAdmission, writes: snap.writes, intents: snap.intents, integrations: snap.integrations };
    const safety = await engine.decide(withKs(anonymous("safety:route", "safety_routing"), ks));
    const human = await engine.decide(withKs(anonymous("human:request", "human_handoff"), ks));
    expect(safety).toMatchObject({ allow: true, reasonCodes: ["SAFETY_ROUTE_ALWAYS_AVAILABLE"] });
    expect(human).toMatchObject({ allow: true, reasonCodes: ["HUMAN_ROUTE_ALWAYS_AVAILABLE"] });
    // A protected read is blocked by the same snapshot, so the switch is genuinely engaged.
    expect((await engine.decide(withKs(anonymous("appointment:read", "caller_self_service", "appointment", "PHI"), ks))).allow).toBe(false);
    expect(killSwitchBlock(snap, { class: "SAFETY", newSession: true })).toBeNull();
    expect(killSwitchBlock(snap, { class: "HUMAN_ROUTE", newSession: true })).toBeNull();
    expect(killSwitchBlock(snap, { class: "WRITE" })).toBe("KILL_SWITCH_WRITES");
    expect(notificationAllowed({ ...snap, outboundNotifications: true }, "SAFETY_ESCALATION")).toBe(true);

    await seedCallEvents(h, CALLS.concurrent.callId);
    const r = await h.call("calls.transfer", { token: await h.token("safety"), params: { callId: CALLS.concurrent.callId }, body: { destinationId: "dst_safety_priority", reason: "SAFETY_PRIORITY" } });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body) as { state: string; destinationId: string };
    expect(["REQUESTED", "QUEUED"]).toContain(body.state);
    expect(body.destinationId).toBe("dst_safety_priority");
    expect(h.handoff.requests.at(-1)).toMatchObject({ callId: CALLS.concurrent.callId, reason: "SAFETY_PRIORITY", authenticated: false });
  });

  it("[OPS-01] when the audit event cannot be written the switch is not engaged (fail closed, AUDIT_UNAVAILABLE)", async () => {
    const token = await h.token("securityAdmin");
    await h.db.exec("revoke insert on audit_outbox from app_console");
    try {
      const r = await h.call("killSwitches.set", { token, body: engage("OUTBOUND_NOTIFICATIONS") });
      expect(r.statusCode).toBe(503);
      expect(errorOf(r.body)).toMatchObject({ reasonCode: "AUDIT_UNAVAILABLE", retryable: true });
    } finally {
      await h.db.exec("grant insert on audit_outbox to app_console");
    }
    expect((await h.killSwitches.snapshot(TENANT_ID)).outboundNotifications).toBe(false);
  });

  it("[ACT-02] a repeated Idempotency-Key returns the first result without a second change; a reused key with another request is refused", async () => {
    const token = await h.token("supervisor");
    const key = "idemKillSwitchRelease0001";
    const release = { scope: "WRITES", target: "*", engaged: false, reason: "INCIDENT_CLOSED", confirmationPhrase: "RELEASE WRITES *" };
    const first = await h.call("killSwitches.set", { token, body: release, idempotencyKey: key });
    const second = await h.call("killSwitches.set", { token, body: release, idempotencyKey: key });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(JSON.parse(second.body)).toEqual(JSON.parse(first.body));
    const history = await h.db.query<{ n: number }>("select count(*)::int as n from kill_switch_history where scope = 'WRITES' and engaged = false");
    expect(history.rows[0]?.n).toBe(1);
    const reused = await h.call("killSwitches.set", { token, body: { ...release, reason: "ROOT_CAUSE_FIXED" }, idempotencyKey: key });
    expect(reused.statusCode).toBe(409);
    expect(errorOf(reused.body).reasonCode).toBe("IDEMPOTENCY_KEY_REUSED");
    const missing = await h.call("killSwitches.set", { token, body: release, idempotencyKey: null });
    expect(errorOf(missing.body).reasonCode).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });
});
