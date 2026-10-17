/**
 * Follow-up notification decision (spec section 9): notifications follow
 * registered preferences, quiet hours and applicable consent, and use only
 * approved NEUTRAL templates that direct the recipient to a secure channel.
 * Outbound calling is a separately enabled feature and is refused here unless
 * explicitly enabled by configuration.
 *
 * This is a pure decision; delivery goes through NotificationSender
 * (platform/src/adapters/ports.ts) with an idempotency key. Quiet-hour windows
 * and the neutral template set are supplied by configuration — this module
 * does not invent them.
 */
export type NotificationChannelKind = "sms" | "voice" | "email" | "portal_push";

export interface QuietHours {
  /** Local minutes after midnight, 0..1439. A window may wrap past midnight (start > end). */
  startMinute: number;
  endMinute: number;
  /** IANA time zone of the recipient's registered preference. */
  timeZone: string;
}

export interface NotificationRequest {
  channelKind: NotificationChannelKind;
  channelVerified: boolean;
  templateId: string;
  consent: "GRANTED" | "DECLINED" | "UNKNOWN" | "NOT_REQUIRED";
  preferences: { optedOut: boolean; channels: readonly NotificationChannelKind[] };
  quietHours: QuietHours | null;
  now: Date;
}

export interface NotificationPolicyConfig {
  /** Approved neutral template ids (no PHI, no account details; direct to a secure channel). */
  neutralTemplateIds: ReadonlySet<string>;
  outboundCallingEnabled: boolean;
}

export type NotificationDecision =
  | { decision: "SEND"; reasonCode: null }
  | { decision: "DEFER"; reasonCode: "QUIET_HOURS"; notBefore: string }
  | { decision: "SUPPRESS"; reasonCode: string };

function localMinuteOfDay(now: Date, timeZone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
    const h = Number(parts.find((p) => p.type === "hour")?.value);
    const m = Number(parts.find((p) => p.type === "minute")?.value);
    return Number.isInteger(h) && Number.isInteger(m) ? h * 60 + m : null;
  } catch {
    return null;
  }
}

const validMinute = (m: number) => Number.isInteger(m) && m >= 0 && m < 1440;

export function decideNotification(req: NotificationRequest, cfg: NotificationPolicyConfig): NotificationDecision {
  if (!cfg.neutralTemplateIds.has(req.templateId)) return { decision: "SUPPRESS", reasonCode: "TEMPLATE_NOT_NEUTRAL_APPROVED" };
  if (req.consent !== "GRANTED" && req.consent !== "NOT_REQUIRED") return { decision: "SUPPRESS", reasonCode: "CONSENT_NOT_GRANTED" };
  if (req.preferences.optedOut) return { decision: "SUPPRESS", reasonCode: "RECIPIENT_OPTED_OUT" };
  if (!req.preferences.channels.includes(req.channelKind)) return { decision: "SUPPRESS", reasonCode: "CHANNEL_NOT_PREFERRED" };
  if (!req.channelVerified) return { decision: "SUPPRESS", reasonCode: "CHANNEL_NOT_VERIFIED" };
  if (req.channelKind === "voice" && !cfg.outboundCallingEnabled) return { decision: "SUPPRESS", reasonCode: "OUTBOUND_CALLING_NOT_ENABLED" };

  if (req.quietHours) {
    const q = req.quietHours;
    if (!validMinute(q.startMinute) || !validMinute(q.endMinute)) return { decision: "SUPPRESS", reasonCode: "QUIET_HOURS_INVALID" };
    const local = localMinuteOfDay(req.now, q.timeZone);
    if (local === null) return { decision: "SUPPRESS", reasonCode: "QUIET_HOURS_TIMEZONE_INVALID" };
    const inWindow = q.startMinute <= q.endMinute ? local >= q.startMinute && local < q.endMinute : local >= q.startMinute || local < q.endMinute;
    if (inWindow) {
      const minutesUntilEnd = (q.endMinute - local + 1440) % 1440 || 1440;
      const notBefore = new Date(req.now.getTime() - (req.now.getTime() % 60_000) + minutesUntilEnd * 60_000);
      // Re-evaluated at send time, so a daylight-saving shift inside the window cannot cause a quiet-hours send.
      return { decision: "DEFER", reasonCode: "QUIET_HOURS", notBefore: notBefore.toISOString() };
    }
  }
  return { decision: "SEND", reasonCode: null };
}
