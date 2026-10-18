import { z } from "zod";
import type { RiskFlag } from "../protocol/index.js";
import type { Clock } from "../shared/clock.js";
import { sha256Hex } from "../shared/canonical.js";
import { ValidationError } from "../shared/errors.js";
import type { Metrics } from "../observability/ports.js";
import { noopMetrics } from "../observability/metrics.js";
import type { KvStore } from "./ports.js";
import { hourWindow } from "./keys.js";

/**
 * Account-keyed verification abuse monitoring (spec section 7: "account and destination abuse
 * detection", "risk signals for recent number changes", "monitoring for denial-of-service abuse";
 * section 14: account enumeration; AUTH-ENUM-01).
 *
 * Signals derived from ACCOUNT- or DESTINATION-specific facts (per-account and per-destination
 * throttles, the account OTP guess budget, lockouts of a real account's challenge, a recently
 * changed registered number) exist only for locators that matched a real, eligible account. They
 * are therefore recorded HERE, inside the restricted verification store, keyed by
 * `sha256(kind NUL id)` of the account or destination and an hourly window, and NEVER:
 *  - as a risk flag on the caller's session (policy turns session flags into a different tool
 *    result, which would disclose that the locator is an enrolled person),
 *  - in a policy input, tool result, speech slot or telephony-control response,
 *  - in a log line linked to the call or session.
 * The only other output is the aggregated `vsp_challenge_abuse_signals_total{signal}` counter.
 *
 * Session-scoped signals that every caller can trigger identically (too many verification begins,
 * a locked challenge, the session OTP failure budget) stay on the session (`ENUMERATION_SUSPECTED`,
 * `OTP_ABUSE_SUSPECTED`) because they reveal nothing about any account.
 *
 * Consumers: security monitoring (alarms on the metric; investigation reads `count`). Retention is
 * an engineering default pending Security approval (`VerificationConfig.abuseSignalRetentionHours`).
 */
export const AccountAbuseSignal = z.enum([
  /** More secure links requested for one account in the hour than `linkMaxPerAccountPerHour`; delivery suppressed. */
  "LINK_ACCOUNT_LIMIT",
  /** More OTP challenges for one account in the hour than `otpMaxPerAccountPerHour`; nothing sent. */
  "OTP_ACCOUNT_LIMIT",
  /** More OTP challenges to one registered destination in the hour than `otpMaxPerDestinationPerHour`; nothing sent. */
  "OTP_DESTINATION_LIMIT",
  /** The account's OTP guess budget for the hour is spent: no new code is sent and no guess is compared. */
  "OTP_ACCOUNT_GUESS_LIMIT",
  /** A challenge issued to a real account locked after its per-challenge attempts. */
  "OTP_ACCOUNT_CHALLENGE_LOCKED",
  /** SIM-swap risk: the registered number changed recently, so no possession challenge was sent. */
  "RECENT_NUMBER_CHANGE",
]);
export type AccountAbuseSignal = z.infer<typeof AccountAbuseSignal>;

export type AbuseSubject = { kind: "account" | "destination"; id: string };

/** The aggregated metric label (RiskFlag-valued, metric catalogue) each account signal is counted under. */
const METRIC_SIGNAL: Record<AccountAbuseSignal, RiskFlag> = {
  LINK_ACCOUNT_LIMIT: "OTP_ABUSE_SUSPECTED",
  OTP_ACCOUNT_LIMIT: "OTP_ABUSE_SUSPECTED",
  OTP_DESTINATION_LIMIT: "OTP_ABUSE_SUSPECTED",
  OTP_ACCOUNT_GUESS_LIMIT: "OTP_ABUSE_SUSPECTED",
  OTP_ACCOUNT_CHALLENGE_LOCKED: "OTP_ABUSE_SUSPECTED",
  RECENT_NUMBER_CHANGE: "RECENT_NUMBER_CHANGE",
};

const SubjectId = z.string().min(3).max(128);

export const abuseKey = (signal: AccountAbuseSignal, subject: AbuseSubject, window: number): string =>
  `abm#${signal}:${window}:${sha256Hex(`${subject.kind}\u0000${subject.id}`)}`;

export interface AbuseMonitorDeps {
  kv: KvStore;
  clock: Clock;
  metrics?: Metrics;
  /** How long an hourly signal counter is kept for investigation (storage TTL). */
  retentionHours: number;
}

export class VerificationAbuseMonitor {
  private readonly metrics: Metrics;

  constructor(private readonly deps: AbuseMonitorDeps) {
    if (!Number.isInteger(deps.retentionHours) || deps.retentionHours < 1 || deps.retentionHours > 24 * 90) throw new ValidationError("ABUSE_MONITOR_CONFIG_INVALID");
    this.metrics = deps.metrics ?? noopMetrics;
  }

  private subject(signal: AccountAbuseSignal, subject: AbuseSubject): void {
    if (!AccountAbuseSignal.safeParse(signal).success || (subject.kind !== "account" && subject.kind !== "destination") || !SubjectId.safeParse(subject.id).success) {
      throw new ValidationError("ABUSE_SIGNAL_INVALID");
    }
  }

  /**
   * Records one occurrence. Never throws and never changes anything the caller can observe: a
   * store failure only loses this monitoring increment (the protective action — suppressing the
   * send or the comparison — has already been decided by the caller).
   */
  async record(signal: AccountAbuseSignal, subject: AbuseSubject): Promise<void> {
    try {
      this.subject(signal, subject);
      const w = hourWindow(this.deps.clock.now());
      await this.deps.kv.increment(abuseKey(signal, subject, w), (w + 1 + this.deps.retentionHours) * 3600);
      this.metrics.increment("vsp_challenge_abuse_signals_total", { signal: METRIC_SIGNAL[signal] });
    } catch {
      // Monitoring is best effort by design; see the method comment.
    }
  }

  /** Occurrences of `signal` for `subject` in the hourly window containing `at` (default now). */
  async count(signal: AccountAbuseSignal, subject: AbuseSubject, at: Date = this.deps.clock.now()): Promise<number> {
    this.subject(signal, subject);
    const item = await this.deps.kv.get<{ count?: unknown }>(abuseKey(signal, subject, hourWindow(at)));
    const c = item?.data.count;
    return typeof c === "number" ? c : 0;
  }
}
