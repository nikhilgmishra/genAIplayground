/**
 * LOCAL FIXTURE — notification sender. Captures messages in memory instead of
 * sending them, so tests can read the secure link or OTP a SYNTHETIC person
 * "received". Nothing leaves the process.
 *
 * Enforced like a production sender would be:
 *  - only APPROVED, NEUTRAL template ids (no company services, no clinical terms,
 *    no account facts; they direct the recipient to a secure channel);
 *  - slots must be exactly the template's declared slots and match their patterns
 *    (so a name, DOB or free text cannot be smuggled into a message);
 *  - only REGISTERED channel references are accepted. There is no way to pass a
 *    raw phone number or e-mail address, so a destination supplied during a call
 *    can never receive a challenge (spec section 7);
 *  - idempotency keys: a repeated key with the same payload returns the original
 *    message id without sending again; a different payload is a conflict.
 *
 * The approved wording below is a LOCAL FIXTURE placeholder pending privacy and
 * communications approval; it is not approved production copy. The live provider
 * adapter is BLOCKED on a BAA-covered notification vendor and its documented API.
 */
import { z } from "zod";
import { PEOPLE } from "../../fixtures/synthetic-world.js";
import type { Clock } from "../../shared/clock.js";
import { iso, systemClock } from "../../shared/clock.js";
import { canonicalJson } from "../../shared/canonical.js";
import { ConflictError, DependencyError, ValidationError } from "../../shared/errors.js";
import { newId } from "../../shared/ids.js";
import type { AdapterHealth, NotificationSender } from "../ports.js";

export interface NotificationTemplate {
  slots: Record<string, RegExp>;
  render(slots: Record<string, string>): string;
}

const LINK_PATH = /^\/[a-z0-9/_-]{1,64}\/[a-z]{2,4}_[A-Za-z0-9_-]{16,64}#n=[A-Za-z0-9_-]{43}$/;

/** Approved neutral templates (LOCAL FIXTURE wording). */
export const APPROVED_NOTIFICATION_TEMPLATES: Readonly<Record<string, NotificationTemplate>> = {
  "verify.secure_link": {
    slots: { linkPath: LINK_PATH },
    render: (s) =>
      `You asked to verify your account on a support call. Open https://portal.local.invalid${s.linkPath ?? ""} and sign in to continue. If you did not ask for this, you can ignore this message.`,
  },
  "verify.step_up_link": {
    slots: { linkPath: LINK_PATH },
    render: (s) =>
      `Please confirm a recent request. Open https://portal.local.invalid${s.linkPath ?? ""} and sign in to continue. If you did not ask for this, you can ignore this message.`,
  },
  "verify.otp_code": {
    slots: { code: /^\d{6}$/, expiryMinutes: /^\d{1,2}$/ },
    render: (s) =>
      `Your verification code is ${s.code ?? ""}. It expires in ${s.expiryMinutes ?? ""} minutes. Enter it only on your phone keypad when prompted. Never share it.`,
  },
  "notify.secure_message_waiting": {
    slots: {},
    render: () => "You have a new message. Please sign in to your secure account to view it.",
  },
};

const SendInput = z.strictObject({
  channelRef: z.string().regex(/^chn_[A-Za-z0-9_-]{16,64}$/),
  templateId: z.string().regex(/^[a-z][a-z0-9_.]{2,80}$/),
  slots: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,31}$/), z.string().max(256)),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_.:-]{8,128}$/),
});

export interface CapturedNotification {
  messageId: string;
  channelRef: string;
  templateId: string;
  slots: Record<string, string>;
  text: string;
  sentAt: string;
}

export interface NotificationFixtureOptions {
  /** Registered, verified channel refs. Defaults to every verified channel in the SYNTHETIC world. */
  registeredChannelRefs?: Iterable<string>;
  templates?: Readonly<Record<string, NotificationTemplate>>;
  clock?: Clock;
}

export class NotificationFixture implements NotificationSender {
  readonly kind = "local_fixture" as const;
  readonly integrationId = "notifications";
  private readonly registered: Set<string>;
  private readonly templates: Readonly<Record<string, NotificationTemplate>>;
  private readonly clock: Clock;
  private readonly byKey = new Map<string, { digest: string; messageId: string }>();
  private readonly captured: CapturedNotification[] = [];
  private failing = false;

  constructor(opts: NotificationFixtureOptions = {}) {
    this.registered = new Set(
      opts.registeredChannelRefs ?? Object.values(PEOPLE).flatMap((p) => p.channels.filter((c) => c.verified).map((c) => c.channelRef)),
    );
    this.templates = opts.templates ?? APPROVED_NOTIFICATION_TEMPLATES;
    this.clock = opts.clock ?? systemClock;
  }

  async health(): Promise<AdapterHealth> {
    return this.failing ? { healthy: false, reasonCode: "FIXTURE_UNAVAILABLE" } : { healthy: true, reasonCode: null };
  }

  async send(input: { channelRef: string; templateId: string; slots: Record<string, string>; idempotencyKey: string }): Promise<{ messageId: string }> {
    const parsed = SendInput.safeParse(input);
    if (!parsed.success) throw new ValidationError("NOTIFICATION_INPUT_INVALID");
    const { channelRef, templateId, slots, idempotencyKey } = parsed.data;
    const template = Object.prototype.hasOwnProperty.call(this.templates, templateId) ? this.templates[templateId] : undefined;
    if (!template) throw new ValidationError("NOTIFICATION_TEMPLATE_NOT_APPROVED");
    const declared = Object.keys(template.slots).sort();
    const given = Object.keys(slots).sort();
    if (declared.length !== given.length || declared.some((k, i) => k !== given[i])) throw new ValidationError("NOTIFICATION_SLOTS_INVALID");
    for (const k of declared) {
      const pattern = template.slots[k];
      const value = slots[k];
      if (!pattern || value === undefined || !pattern.test(value)) throw new ValidationError("NOTIFICATION_SLOTS_INVALID");
    }
    if (!this.registered.has(channelRef)) throw new ValidationError("NOTIFICATION_CHANNEL_NOT_REGISTERED");
    if (this.failing) throw new DependencyError("NOTIFICATION_PROVIDER_UNAVAILABLE", "NOT_STARTED");

    const digest = canonicalJson({ channelRef, templateId, slots });
    const prior = this.byKey.get(idempotencyKey);
    if (prior) {
      if (prior.digest !== digest) throw new ConflictError("NOTIFICATION_IDEMPOTENCY_CONFLICT");
      return { messageId: prior.messageId };
    }
    const messageId = newId("msg");
    this.byKey.set(idempotencyKey, { digest, messageId });
    this.captured.push({ messageId, channelRef, templateId, slots: { ...slots }, text: template.render(slots), sentAt: iso(this.clock.now()) });
    return { messageId };
  }

  // ---------------- test helpers (LOCAL FIXTURE only) ----------------

  get sent(): readonly CapturedNotification[] {
    return this.captured.map((c) => ({ ...c, slots: { ...c.slots } }));
  }

  lastTo(channelRef: string): CapturedNotification | null {
    for (let i = this.captured.length - 1; i >= 0; i--) {
      const c = this.captured[i];
      if (c && c.channelRef === channelRef) return { ...c, slots: { ...c.slots } };
    }
    return null;
  }

  setFailing(failing: boolean): void {
    this.failing = failing;
  }

  clear(): void {
    this.captured.length = 0;
  }
}

/**
 * Terms an approved neutral template must never contain: they would disclose that
 * the recipient uses mental-health services or reveal account facts (spec sections 6, 7 and 9).
 */
export const NON_NEUTRAL_TERMS = [
  "therap",
  "mental",
  "psych",
  "counsel",
  "diagnos",
  "medicat",
  "clinic",
  "treatment",
  "appointment",
  "session",
  "invoice",
  "balance",
  "claim",
  "provider",
  "crisis",
  "behavioral",
  "health",
] as const;
