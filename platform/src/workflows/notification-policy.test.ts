import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { decideNotification, type NotificationPolicyConfig, type NotificationRequest } from "./notification-policy.js";

/** Test-only configuration values (SYNTHETIC); real quiet hours come from registered preferences. */
const cfg: NotificationPolicyConfig = { neutralTemplateIds: new Set(["notify.secure_message_waiting"]), outboundCallingEnabled: false };

function req(overrides: Partial<NotificationRequest> = {}): NotificationRequest {
  return {
    channelKind: "sms",
    channelVerified: true,
    templateId: "notify.secure_message_waiting",
    consent: "GRANTED",
    preferences: { optedOut: false, channels: ["sms", "email"] },
    quietHours: { startMinute: 21 * 60, endMinute: 8 * 60, timeZone: "America/New_York" },
    now: new Date("2026-10-17T15:00:00.000Z"), // 11:00 in New York (EDT)
    ...overrides,
  };
}

describe("follow-up notification policy", () => {
  it("[SPEC-9.notification] sends a neutral approved template on a preferred, verified, consented channel outside quiet hours", () => {
    expect(decideNotification(req(), cfg)).toEqual({ decision: "SEND", reasonCode: null });
  });

  it("[SPEC-9.notification] defers during quiet hours (window wrapping midnight) until the window ends", () => {
    const d = decideNotification(req({ now: new Date("2026-10-17T02:00:00.000Z") }), cfg); // 22:00 EDT
    expect(d).toEqual({ decision: "DEFER", reasonCode: "QUIET_HOURS", notBefore: "2026-10-17T12:00:00.000Z" });
    const early = decideNotification(req({ now: new Date("2026-10-17T11:30:00.000Z") }), cfg); // 07:30 EDT
    expect(early).toEqual({ decision: "DEFER", reasonCode: "QUIET_HOURS", notBefore: "2026-10-17T12:00:00.000Z" });
  });

  it.each<[string, Partial<NotificationRequest>, string]>([
    ["non-neutral template", { templateId: "notify.invoice_amount_due" }, "TEMPLATE_NOT_NEUTRAL_APPROVED"],
    ["consent declined", { consent: "DECLINED" }, "CONSENT_NOT_GRANTED"],
    ["consent unknown", { consent: "UNKNOWN" }, "CONSENT_NOT_GRANTED"],
    ["opted out", { preferences: { optedOut: true, channels: ["sms"] } }, "RECIPIENT_OPTED_OUT"],
    ["channel not preferred", { channelKind: "email", preferences: { optedOut: false, channels: ["sms"] } }, "CHANNEL_NOT_PREFERRED"],
    ["unverified channel", { channelVerified: false }, "CHANNEL_NOT_VERIFIED"],
    ["outbound voice not enabled", { channelKind: "voice", preferences: { optedOut: false, channels: ["voice"] } }, "OUTBOUND_CALLING_NOT_ENABLED"],
    ["invalid time zone", { quietHours: { startMinute: 0, endMinute: 60, timeZone: "Not/AZone" } }, "QUIET_HOURS_TIMEZONE_INVALID"],
    ["invalid window", { quietHours: { startMinute: -1, endMinute: 60, timeZone: "UTC" } }, "QUIET_HOURS_INVALID"],
  ])("[SPEC-9.notification] suppresses when %s", (_label, overrides, reasonCode) => {
    expect(decideNotification(req(overrides), cfg)).toEqual({ decision: "SUPPRESS", reasonCode });
  });

  it("[SPEC-9.notification] property: nothing is ever sent inside the quiet-hours window", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1439 }), fc.integer({ min: 0, max: 1439 }), fc.integer({ min: 0, max: 7 * 24 * 60 }), (start, end, offset) => {
        const now = new Date(Date.parse("2026-10-17T00:00:00.000Z") + offset * 60_000);
        const d = decideNotification(req({ now, quietHours: { startMinute: start, endMinute: end, timeZone: "UTC" } }), cfg);
        const local = now.getUTCHours() * 60 + now.getUTCMinutes();
        const inWindow = start <= end ? local >= start && local < end : local >= start || local < end;
        expect(d.decision).toBe(inWindow ? "DEFER" : "SEND");
        if (d.decision === "DEFER") {
          const nb = new Date(d.notBefore);
          const nbLocal = nb.getUTCHours() * 60 + nb.getUTCMinutes();
          expect(nbLocal).toBe(end);
          expect(nb.getTime()).toBeGreaterThan(now.getTime() - 60_000);
        }
      }),
      { numRuns: 500 },
    );
  });
});
