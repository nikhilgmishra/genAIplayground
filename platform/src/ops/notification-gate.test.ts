/**
 * OPS-KS-01: the OUTBOUND_NOTIFICATIONS and INTEGRATION("notifications") kill switches stop
 * every outbound notification. Unit tests for the gate, then the LOCAL FIXTURE composition
 * (buildContainer) driven through the real MCP tool path and the Studio telephony-control
 * path with switches engaged through the real console API. SYNTHETIC data only.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AdapterHealth, NotificationSender } from "../adapters/ports.js";
import { STAFF_SUPERVISOR, createJourneyHarness } from "../../test/journeys/harness.js";
import type { JourneyHarness } from "../../test/journeys/harness.js";
import { emptySnapshot } from "./kill-switches.js";
import { KillSwitchGatedNotificationSender, NotificationBlockedError, notificationBlock } from "./notification-gate.js";
import type { KillSwitchSnapshot } from "./ports.js";

class RecordingSenderFixture implements NotificationSender {
  readonly kind = "local_fixture" as const;
  readonly integrationId = "notifications";
  readonly sent: string[] = [];
  health(): Promise<AdapterHealth> {
    return Promise.resolve({ healthy: true, reasonCode: null });
  }
  send(input: { channelRef: string; templateId: string; slots: Record<string, string>; idempotencyKey: string }): Promise<{ messageId: string }> {
    this.sent.push(input.templateId);
    return Promise.resolve({ messageId: `msg_${this.sent.length}` });
  }
}

const MSG = { channelRef: "chn_synthFixture000001", templateId: "verify.secure_link", slots: {}, idempotencyKey: "vtx:fixture" };

describe("notification kill-switch gate (unit)", () => {
  const gate = (snap: () => Promise<KillSwitchSnapshot>, purpose?: "ROUTINE" | "SAFETY_ESCALATION") => {
    const inner = new RecordingSenderFixture();
    return { inner, sender: new KillSwitchGatedNotificationSender({ inner, snapshot: snap, ...(purpose ? { purpose } : {}) }) };
  };

  it("[SPEC-13.kill][OPS-KS-01] OUTBOUND_NOTIFICATIONS or INTEGRATION(notifications) engaged: the provider is never called", async () => {
    const cases: [KillSwitchSnapshot, string][] = [
      [{ ...emptySnapshot(), outboundNotifications: true }, "KILL_SWITCH_OUTBOUND_NOTIFICATIONS"],
      [{ ...emptySnapshot(), integrations: ["notifications"] }, "KILL_SWITCH_INTEGRATION"],
    ];
    for (const [snap, code] of cases) {
      const { inner, sender } = gate(() => Promise.resolve(snap));
      const err = await sender.send(MSG).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NotificationBlockedError);
      expect((err as NotificationBlockedError).reasonCode).toBe(code);
      expect((err as NotificationBlockedError).outcome).toBe("NOT_STARTED");
      expect(inner.sent).toEqual([]);
    }
  });

  it("[SPEC-13.kill][OPS-KS-01] unreadable or malformed kill-switch state fails closed", async () => {
    for (const snap of [() => Promise.reject(new Error("db down")), () => Promise.resolve(null as unknown as KillSwitchSnapshot)]) {
      const { inner, sender } = gate(snap);
      await expect(sender.send(MSG)).rejects.toBeInstanceOf(NotificationBlockedError);
      expect(inner.sent).toEqual([]);
    }
  });

  it("[SPEC-13.kill][OPS-KS-01] clear switches pass through; other integrations' switches do not stop notifications; safety paging is exempt", async () => {
    const clear = gate(() => Promise.resolve({ ...emptySnapshot(), integrations: ["salesforce"], writes: true }));
    expect(await clear.sender.send(MSG)).toEqual({ messageId: "msg_1" });
    expect(clear.sender.kind).toBe("local_fixture");
    expect(clear.sender.integrationId).toBe("notifications");
    const safety = gate(() => Promise.resolve({ ...emptySnapshot(), outboundNotifications: true, integrations: ["notifications"] }), "SAFETY_ESCALATION");
    expect(await safety.sender.send(MSG)).toEqual({ messageId: "msg_1" });
    expect(notificationBlock({ ...emptySnapshot(), outboundNotifications: true }, "SAFETY_ESCALATION", "notifications")).toBeNull();
  });
});

describe("notification kill switches through the LOCAL FIXTURE composition (MCP + telephony-control)", () => {
  let h: JourneyHarness;
  let seq = 0;
  beforeAll(async () => {
    h = await createJourneyHarness();
  }, 180_000);
  afterAll(async () => {
    await h?.close();
  });

  const setSwitch = async (scope: "OUTBOUND_NOTIFICATIONS" | "INTEGRATION", target: string, engaged: boolean) => {
    const res = await h.consoleRequest(
      STAFF_SUPERVISOR,
      "POST",
      "/console/api/v1/kill-switches",
      { scope, target, engaged, reason: engaged ? "INCIDENT_CONTAINMENT" : "INCIDENT_CLOSED", confirmationPhrase: `${engaged ? "ENGAGE" : "RELEASE"} ${scope} ${target}` },
      `idem_opsKs01Switch${String(++seq).padStart(12, "0")}`,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  };
  const beginBoth = async (hint = "avery.synthetic") => {
    // Fresh per-account verification throttle window for the SYNTHETIC person (identity limits are per hour).
    h.clock.advanceSeconds(2 * 3600);
    const before = h.c.identity.notifications.sent.length;
    const mcp = h.call();
    await mcp.start();
    await mcp.role("client");
    const viaMcp = await mcp.tool("begin_verification", { method: "SECURE_LINK", locator: { kind: "PORTAL_USERNAME_HINT", hint } });
    const studio = h.call();
    await studio.start();
    await studio.role("client");
    const viaStudio = await studio.studio("POST", "/telephony/v1/session/verification", { method: "secure_link", role: "client", locator: { portalUsernameHint: hint } });
    return { delivered: h.c.identity.notifications.sent.length - before, viaMcp, viaStudio, mcpCallId: mcp.callId, studioCallId: studio.callId };
  };
  /** What the caller is told on each path (the MCP verification view + speech template, the Studio response + template). */
  const told = (r: Awaited<ReturnType<typeof beginBoth>>) => {
    const v = (r.viaMcp.data as { verification?: { status?: unknown; nextStep?: unknown } } | null | undefined)?.verification;
    return {
      mcp: { status: r.viaMcp.status, verification: v ? { status: v.status, nextStep: v.nextStep } : null, speech: r.viaMcp.speech?.templateId ?? null },
      studio: { response: r.viaStudio.body.response, speechTemplateId: r.viaStudio.body.speechTemplateId },
    };
  };
  const HUMAN_ROUTE = {
    mcp: { status: "SUCCESS", verification: { status: "VERIFICATION_UNAVAILABLE_USE_HUMAN", nextStep: "HUMAN_VERIFICATION" }, speech: "verification.failed_generic" },
    studio: { response: "VERIFICATION_UNAVAILABLE_USE_HUMAN", speechTemplateId: "verification.failed_generic" },
  };
  /** The switch reason on the begin's audit events (tool.invoke over MCP, verification.begun over telephony control). */
  const auditedReasons = async (r: Awaited<ReturnType<typeof beginBoth>>) => {
    const invoke = (await h.auditFor(r.mcpCallId)).filter((e) => e.action === "tool.invoke" && (e.evidencePointers ?? []).some((p) => p.includes("/begin_verification/")));
    const begun = (await h.auditFor(r.studioCallId)).filter((e) => e.action === "verification.begun");
    return { mcp: invoke.map((e) => [e.outcome, e.reasonCode]), studio: begun.map((e) => [e.outcome, e.reasonCode]) };
  };

  it("[SPEC-13.kill][OPS-KS-01] control: with switches clear both paths deliver the secure link", async () => {
    const r = await beginBoth();
    expect(r.delivered).toBe(2);
  }, 120_000);

  it("[SPEC-13.kill][OPS-03][OPS-KS-01] OUTBOUND_NOTIFICATIONS engaged via the console: neither the MCP nor the telephony path sends anything", async () => {
    await setSwitch("OUTBOUND_NOTIFICATIONS", "*", true);
    const r = await beginBoth();
    expect(r.delivered).toBe(0);
    // Anti-enumeration: the caller-facing response stays neutral (it never reveals whether a send happened).
    expect(r.viaStudio.status).toBe(200);
    await setSwitch("OUTBOUND_NOTIFICATIONS", "*", false);
    expect((await beginBoth()).delivered).toBe(2);
  }, 120_000);

  it("[SPEC-13.kill][OPS-03][OPS-KS-01][SPEC-7.no-enumeration][AUTH-ENUM-01] OUTBOUND_NOTIFICATIONS engaged via the console: both paths answer the human route with verification.failed_generic, identically for real and unknown people, and audit the switch reason", async () => {
    await setSwitch("OUTBOUND_NOTIFICATIONS", "*", true);
    try {
      const real = await beginBoth("avery.synthetic");
      const unknown = await beginBoth("nobody.synthetic-unknown");
      expect(real.delivered + unknown.delivered).toBe(0);
      // Never "a link was sent" while nothing can be sent; the same answer whether or not the person exists.
      expect(told(real)).toEqual(HUMAN_ROUTE);
      expect(told(unknown)).toEqual(HUMAN_ROUTE);
      expect(JSON.stringify([real.viaMcp, real.viaStudio.body])).not.toContain("KILL_SWITCH");
      const reasons = { mcp: [["SUCCEEDED", "KILL_SWITCH_OUTBOUND_NOTIFICATIONS"]], studio: [["DENIED", "KILL_SWITCH_OUTBOUND_NOTIFICATIONS"]] };
      expect(await auditedReasons(real)).toEqual(reasons);
      expect(await auditedReasons(unknown)).toEqual(reasons);
    } finally {
      await setSwitch("OUTBOUND_NOTIFICATIONS", "*", false);
    }
    const released = await beginBoth("avery.synthetic");
    expect(released.delivered).toBe(2);
    expect(told(released).studio).toEqual({ response: "IF_ELIGIBLE_A_LINK_WAS_SENT", speechTemplateId: "verification.secure_link_sent" });
  }, 180_000);

  it("[SPEC-13.kill][OPS-KS-01][SPEC-7.no-enumeration] INTEGRATION(notifications) engaged via the console: both paths answer the human route for real and unknown people alike", async () => {
    await setSwitch("INTEGRATION", "notifications", true);
    try {
      const real = await beginBoth("avery.synthetic");
      const unknown = await beginBoth("nobody.synthetic-unknown");
      expect(real.delivered + unknown.delivered).toBe(0);
      expect(told(real)).toEqual(HUMAN_ROUTE);
      expect(told(unknown)).toEqual(HUMAN_ROUTE);
      expect((await auditedReasons(unknown)).studio).toEqual([["DENIED", "KILL_SWITCH_INTEGRATION"]]);
    } finally {
      await setSwitch("INTEGRATION", "notifications", false);
    }
    expect((await beginBoth()).delivered).toBe(2);
  }, 180_000);

  it("[SPEC-13.kill][OPS-KS-01] INTEGRATION(notifications) engaged via the console stops sends on both paths", async () => {
    await setSwitch("INTEGRATION", "notifications", true);
    expect((await beginBoth()).delivered).toBe(0);
    await setSwitch("INTEGRATION", "notifications", false);
    expect((await beginBoth()).delivered).toBe(2);
  }, 120_000);
});
