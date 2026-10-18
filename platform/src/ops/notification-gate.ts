/**
 * Outbound-notification kill-switch gate (spec section 13 "separate kill switches for
 * ... an integration ... and outbound notifications"; OPS-KS-01; threat model T-29).
 *
 * Wraps a NotificationSender so that EVERY send reads the current kill-switch snapshot
 * first and is refused, before the provider is called, when
 *   - OUTBOUND_NOTIFICATIONS is engaged (`notificationAllowed`), or
 *   - INTEGRATION <integrationId> (default: the wrapped adapter's integrationId,
 *     "notifications") is engaged.
 * An unreadable snapshot is treated as "everything engaged" (FAIL_CLOSED_SNAPSHOT).
 *
 * Only purpose SAFETY_ESCALATION (staff paging that is part of the safety route) is
 * exempt, and that purpose is fixed when the wrapper is composed, never chosen per call
 * by a caller. Caller-facing verification links, step-up links and OTP codes are
 * ROUTINE.
 *
 * A refused send throws NotificationBlockedError (DependencyError, outcome NOT_STARTED,
 * not retryable, reason code KILL_SWITCH_OUTBOUND_NOTIFICATIONS / KILL_SWITCH_INTEGRATION
 * / KILL_SWITCH_STATE_UNAVAILABLE). Nothing was handed to the provider, so there is no
 * ambiguous outcome to reconcile. Logs carry reason codes only (no channel refs, no
 * template slots, no codes).
 */
import type { AdapterHealth, NotificationSender } from "../adapters/ports.js";
import { silentLogger } from "../observability/logger.js";
import type { Logger } from "../observability/ports.js";
import { DependencyError } from "../shared/errors.js";
import { FAIL_CLOSED_SNAPSHOT, notificationAllowed } from "./kill-switches.js";
import type { KillSwitchSnapshot } from "./ports.js";

export type NotificationPurpose = "ROUTINE" | "SAFETY_ESCALATION";

export type NotificationBlockReason = "KILL_SWITCH_OUTBOUND_NOTIFICATIONS" | "KILL_SWITCH_INTEGRATION";

export class NotificationBlockedError extends DependencyError {
  constructor(reasonCode: NotificationBlockReason) {
    super(reasonCode, "NOT_STARTED", false);
  }
}

export interface KillSwitchGatedNotificationSenderOptions {
  inner: NotificationSender;
  /**
   * Reads the current snapshot for the deployment's tenant (KillSwitchService.snapshot).
   * A throw, a rejection or a malformed result is treated as FAIL_CLOSED_SNAPSHOT.
   */
  snapshot: () => Promise<KillSwitchSnapshot>;
  /** Fixed at composition. Default ROUTINE. */
  purpose?: NotificationPurpose;
  /** INTEGRATION switch target that stops this sender. Default: inner.integrationId. */
  integrationId?: string;
  logger?: Logger;
}

/** Pure decision shared by the wrapper and its tests. */
export function notificationBlock(snapshot: KillSwitchSnapshot, purpose: NotificationPurpose, integrationId: string): NotificationBlockReason | null {
  if (purpose === "SAFETY_ESCALATION") return null;
  if (!notificationAllowed(snapshot, purpose)) return "KILL_SWITCH_OUTBOUND_NOTIFICATIONS";
  if (snapshot.integrations.includes(integrationId)) return "KILL_SWITCH_INTEGRATION";
  return null;
}

function wellFormed(s: unknown): s is KillSwitchSnapshot {
  const v = s as Partial<KillSwitchSnapshot> | null;
  return !!v && typeof v.outboundNotifications === "boolean" && Array.isArray(v.integrations);
}

export class KillSwitchGatedNotificationSender implements NotificationSender {
  readonly kind: NotificationSender["kind"];
  readonly integrationId: string;
  private readonly purpose: NotificationPurpose;
  private readonly gateTarget: string;
  private readonly logger: Logger;

  constructor(private readonly opts: KillSwitchGatedNotificationSenderOptions) {
    this.kind = opts.inner.kind;
    this.integrationId = opts.inner.integrationId;
    this.purpose = opts.purpose ?? "ROUTINE";
    this.gateTarget = opts.integrationId ?? opts.inner.integrationId;
    this.logger = (opts.logger ?? silentLogger).child({ component: "notification_gate" });
  }

  health(): Promise<AdapterHealth> {
    return this.opts.inner.health();
  }

  async send(input: { channelRef: string; templateId: string; slots: Record<string, string>; idempotencyKey: string }): Promise<{ messageId: string }> {
    let snapshot: KillSwitchSnapshot;
    let failedClosed = false;
    try {
      const s = await this.opts.snapshot();
      if (wellFormed(s)) snapshot = s;
      else {
        snapshot = FAIL_CLOSED_SNAPSHOT;
        failedClosed = true;
      }
    } catch {
      snapshot = FAIL_CLOSED_SNAPSHOT;
      failedClosed = true;
    }
    const reason = notificationBlock(snapshot, this.purpose, this.gateTarget);
    if (reason) {
      this.logger.warn("notification.blocked_by_kill_switch", { reasonCode: failedClosed ? "KILL_SWITCH_STATE_UNAVAILABLE" : reason });
      throw new NotificationBlockedError(reason);
    }
    return this.opts.inner.send(input);
  }
}
