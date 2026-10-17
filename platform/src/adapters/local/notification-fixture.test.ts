import { describe, expect, it } from "vitest";
import { PEOPLE } from "../../fixtures/synthetic-world.js";
import { FakeClock } from "../../shared/clock.js";
import { ConflictError, DependencyError, ValidationError } from "../../shared/errors.js";
import { APPROVED_NOTIFICATION_TEMPLATES, NON_NEUTRAL_TERMS, NotificationFixture } from "./notification-fixture.js";

const SMS = PEOPLE.avery.channels[0].channelRef;
const LINK = "/verify/vtx_AbCdEfGhIjKlMnOpQrStUvWx#n=" + "A".repeat(43);

describe("NotificationFixture (LOCAL FIXTURE: captures, never sends)", () => {
  it("[SPEC-9.NOTIFY] captures approved neutral messages to registered channels for tests to read", async () => {
    const n = new NotificationFixture({ clock: new FakeClock() });
    expect(n.kind).toBe("local_fixture");
    const r = await n.send({ channelRef: SMS, templateId: "verify.secure_link", slots: { linkPath: LINK }, idempotencyKey: "idem-0001" });
    expect(r.messageId).toMatch(/^msg_/);
    const m = n.lastTo(SMS);
    expect(m).toMatchObject({ templateId: "verify.secure_link", slots: { linkPath: LINK }, sentAt: "2026-10-17T15:00:00.000Z" });
    expect(m?.text).toContain(LINK);
  });

  it("[AUTH-06] every approved template is neutral (no services, clinical words or account facts)", () => {
    for (const [id, t] of Object.entries(APPROVED_NOTIFICATION_TEMPLATES)) {
      const text = t.render({ linkPath: LINK, code: "123456", expiryMinutes: "5" }).toLowerCase();
      for (const term of NON_NEUTRAL_TERMS) expect([id, term, text.includes(term)]).toEqual([id, term, false]);
    }
  });

  it("[SPEC-9.NOTIFY] rejects unapproved templates, wrong or extra slots and slot values outside their pattern", async () => {
    const n = new NotificationFixture();
    const base = { channelRef: SMS, idempotencyKey: "idem-0002" };
    await expect(n.send({ ...base, templateId: "notify.invoice_amount_due", slots: {} })).rejects.toMatchObject({ reasonCode: "NOTIFICATION_TEMPLATE_NOT_APPROVED" });
    await expect(n.send({ ...base, templateId: "constructor", slots: {} })).rejects.toMatchObject({ reasonCode: "NOTIFICATION_TEMPLATE_NOT_APPROVED" });
    await expect(n.send({ ...base, templateId: "verify.otp_code", slots: { code: "123456" } })).rejects.toMatchObject({ reasonCode: "NOTIFICATION_SLOTS_INVALID" });
    await expect(n.send({ ...base, templateId: "verify.otp_code", slots: { code: "123456", expiryMinutes: "5", name: "Avery" } })).rejects.toMatchObject({ reasonCode: "NOTIFICATION_SLOTS_INVALID" });
    await expect(n.send({ ...base, templateId: "verify.otp_code", slots: { code: "1990-01-01", expiryMinutes: "5" } })).rejects.toMatchObject({ reasonCode: "NOTIFICATION_SLOTS_INVALID" });
    await expect(n.send({ ...base, templateId: "verify.secure_link", slots: { linkPath: "/verify/avery-synthetic-client" } })).rejects.toMatchObject({ reasonCode: "NOTIFICATION_SLOTS_INVALID" });
    expect(n.sent).toHaveLength(0);
  });

  it("[SPEC-7.OTP] only registered channel references are accepted; raw numbers and unknown refs are refused", async () => {
    const n = new NotificationFixture();
    const msg = { templateId: "verify.otp_code", slots: { code: "123456", expiryMinutes: "5" }, idempotencyKey: "idem-0003" };
    await expect(n.send({ ...msg, channelRef: "+15555550199" })).rejects.toBeInstanceOf(ValidationError);
    await expect(n.send({ ...msg, channelRef: "chn_notRegisteredChannel01" })).rejects.toMatchObject({ reasonCode: "NOTIFICATION_CHANNEL_NOT_REGISTERED" });
    const restricted = new NotificationFixture({ registeredChannelRefs: [] });
    await expect(restricted.send({ ...msg, channelRef: SMS })).rejects.toMatchObject({ reasonCode: "NOTIFICATION_CHANNEL_NOT_REGISTERED" });
  });

  it("[ACT-02] idempotency key: same payload returns the original message without resending; a different payload conflicts", async () => {
    const n = new NotificationFixture();
    const msg = { channelRef: SMS, templateId: "notify.secure_message_waiting", slots: {}, idempotencyKey: "idem-0004" };
    const a = await n.send(msg);
    const b = await n.send(msg);
    expect(b.messageId).toBe(a.messageId);
    expect(n.sent).toHaveLength(1);
    await expect(n.send({ ...msg, templateId: "verify.secure_link", slots: { linkPath: LINK } })).rejects.toBeInstanceOf(ConflictError);
  });

  it("[SPEC-9.NOTIFY] failure injection surfaces a NOT_STARTED dependency error", async () => {
    const n = new NotificationFixture();
    n.setFailing(true);
    const err = await n.send({ channelRef: SMS, templateId: "notify.secure_message_waiting", slots: {}, idempotencyKey: "idem-0005" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DependencyError);
    expect((err as DependencyError).outcome).toBe("NOT_STARTED");
    expect((await n.health()).healthy).toBe(false);
    n.setFailing(false);
    n.clear();
    expect(n.sent).toHaveLength(0);
  });
});
