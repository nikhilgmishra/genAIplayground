/**
 * Layer 2 (WP-23; ACT-02, ACT-03, FO-06-75): duplicate delivery INSIDE the account's documented lookup lag.
 *
 * The tenant's account answers the lookup by request id (or by reference) only `lookupLagMs` after a change was
 * applied (within its documented visibility window), so a redelivery right after the first delivery cannot see it:
 *   - keyed writes: the business-layer create must not turn the slot the first delivery booked into a definite
 *     SLOT_UNAVAILABLE; the keyed write decides at the system (a 422 for the same id under another body is in
 *     doubt: UNKNOWN), never FAILED while the effect exists;
 *   - the non-idempotent legacy create: a redelivery never sends a second create, because only the dispatch that
 *     reserved the reference may create (the lagging lookup is not a dispatch marker); it answers UNKNOWN until the
 *     earlier appointment is visible, then that appointment. Asserted from the system's request and effect logs.
 * SYNTHETIC data only.
 */
import { afterAll, beforeAll, describe, expect } from "vitest";
import type { PrepareInput, ProviderCommitPort } from "../../../src/actions/ports.js";
import { SchedulingCommitPort } from "../../../src/business/providers.js";
import { actingPartyFor } from "../../../src/domain/authority.js";
import { requestIdFor } from "../../../src/domain/changes.js";
import { externalRefFor } from "../../../src/domain/legacy.js";
import type { PreparedAction } from "../../../src/protocol/index.js";
import { systemClock } from "../../../src/shared/clock.js";
import { createIntegrationDb } from "../_harness/clients.js";
import type { IntegrationDb } from "../_harness/clients.js";
import { layer2, layer2Context } from "../_harness/layer2.js";
import { ledgerReplica } from "../substrate/reference-sor.js";
import type { LedgerReplica } from "../substrate/reference-sor.js";
import { DOMAIN_SERVICES, allowDecision, createDomainPki, dtmfConfirmation, eventually, provisionTenant, seedWorld, sessionOf } from "./support.js";
import type { DomainPki, Tenant } from "./support.js";

const it = layer2(DOMAIN_SERVICES);

const LAG_MS = 1_200;
const WINDOW_MS = 1_500;

let pki: DomainPki;
let t: Tenant;
let idb: IntegrationDb;
let ledger: LedgerReplica;

beforeAll(async () => {
  const l2 = layer2Context(DOMAIN_SERVICES);
  pki = createDomainPki();
  t = await provisionTenant(l2, pki, { systems: ["scheduling", "legacy"], lookupLagMs: LAG_MS, visibilityWindowMs: WINDOW_MS });
  idb = await createIntegrationDb(l2);
  ledger = ledgerReplica(idb.db, systemClock, "domain-lag");
}, 180_000);

afterAll(async () => {
  await t?.dispose();
  await idb?.drop();
  pki?.dispose();
});

const settled = <T>(p: Promise<T>) =>
  p.then(
    (value) => ({ value, error: null as null | { outcome?: string; reasonCode?: string } }),
    (e: unknown) => ({ value: null, error: e as { outcome?: string; reasonCode?: string } }),
  );
const effectsOf = async (key: string) => (await t.admin.effects(t.accountId)).filter((e) => e.requestId === requestIdFor(key));
const writesOf = async (operation: string, key: string) => (await t.admin.requests(t.accountId)).filter((r) => r.operation === operation && r.keyRef === requestIdFor(key));

/** A business-layer preparation of a booking (plain slot token, no slot version): the ledger confirms it. */
async function businessBooking(slotId: string, clientRef: string): Promise<{ ctx: ReturnType<typeof sessionOf>; action: PreparedAction }> {
  const s = t.adapters.scheduling;
  const slot = s ? await s.slot(slotId) : null;
  if (!slot) throw new Error("slot");
  const ctx = sessionOf(t.tenantId, clientRef, "client");
  const input: PrepareInput = {
    kind: "appointment.create",
    target: { system: "scheduling", recordType: "appointment_slot", recordRef: slot.slotId, beforeVersion: "slot.open" },
    change: { slotId: slot.slotId, toStartsAt: slot.startsAt, toTimeZone: slot.timeZone, toModality: slot.modality, providerName: slot.providerDisplayName },
    impact: { summaryTemplateId: "appointment.create_confirmation", fees: null, reversible: true },
    confirmationTemplateId: "appointment.create_confirmation",
    ttlSeconds: 300,
    requiresStepUp: false,
  };
  const prepared = await ledger.service.prepare(ctx, input, allowDecision());
  const { confirmation, integration } = dtmfConfirmation(ctx, prepared);
  return { ctx, action: await ledger.service.confirm(confirmation, integration) };
}

describe("redelivery within the documented lookup lag (Layer 2)", () => {
  it("[ACT-02][ACT-03] the business SchedulingCommitPort redelivered inside the lag is never FAILED while its booking exists: UNKNOWN (the system's 422), then the same booking once visible; one effect", async () => {
    const w = await seedWorld(t);
    const s = t.adapters.scheduling;
    if (!s) throw new Error("scheduling composed");
    const business: ProviderCommitPort = new SchedulingCommitPort(s);
    const { ctx, action } = await businessBooking(w.slots[0] as string, w.client);
    const receipt = await ledger.service.commit(ctx, { actionId: action.actionId, digest: action.digest }, { reauthorize: async () => allowDecision(), provider: business });
    expect(receipt.outcome).toBe("COMMITTED");
    const key = (await ledger.service.describe?.(t.tenantId, action.actionId))?.providerIdempotencyKey ?? "";
    // Right away (inside the lag) the key is not visible, and the slot reads BOOKED: never a definite refusal.
    const redelivered = await settled(business.commit(action, key));
    expect(redelivered.value?.outcome).not.toBe("FAILED");
    expect(redelivered.error).toMatchObject({ outcome: "UNKNOWN", reasonCode: "REQUEST_ID_IN_USE" });
    expect(await effectsOf(key)).toHaveLength(1);
    // The system answered the second write 422 (same id, another slot version): nothing applied twice.
    expect((await writesOf("scheduling.booking.put", key)).map((r) => r.status)).toEqual([200, 422]);
    // Once visible, a redelivery is the same booking.
    await eventually(async () => (await settled(business.commit(action, key))).value?.outcome === "COMMITTED", WINDOW_MS + 3_000, 200);
    const again = await business.commit(action, key);
    expect(again).toMatchObject({ outcome: "COMMITTED", providerReference: receipt.providerReference });
    expect(await effectsOf(key)).toHaveLength(1);
  });

  it("[ACT-02][ACT-03] the domain port, a business-prepared create redelivered inside the lag: UNKNOWN REQUEST_ID_IN_USE, never FAILED; a domain-prepared one replays COMMITTED; one effect each", async () => {
    const w = await seedWorld(t);
    const port = t.adapters.commitPort;
    if (!port) throw new Error("commit port composed");
    const { action } = await businessBooking(w.slots[1] as string, w.client);
    const k1 = `vsp-${"1a".repeat(24)}`;
    expect((await port.commit(action, k1)).outcome).toBe("COMMITTED");
    const again = await settled(port.commit(action, k1));
    expect(again.value?.outcome).not.toBe("FAILED");
    expect(again.error).toMatchObject({ outcome: "UNKNOWN", reasonCode: "REQUEST_ID_IN_USE" });
    expect(await effectsOf(k1)).toHaveLength(1);
    // A domain-prepared create carries its slot version: the redelivery is the same body, the system replays it.
    const client = actingPartyFor(sessionOf(t.tenantId, w.client, "client"));
    const prep = await port.prepare(client, { kind: "appointment.create", slotId: w.slots[2] as string });
    const subject = { kind: "appointment.create" as const, subjectId: w.client, target: prep.input.target, change: prep.input.change, expiresAt: new Date(Date.now() + 300_000).toISOString() };
    const k2 = `vsp-${"2a".repeat(24)}`;
    const first = await port.commit(subject, k2);
    expect(first.outcome).toBe("COMMITTED");
    expect(await port.commit(subject, k2)).toEqual(first);
    expect(await effectsOf(k2)).toHaveLength(1);
  });

  it("[ACT-02][FO-06-75] the non-idempotent legacy create delivered twice inside the lag: ONE create is ever sent; the duplicate is UNKNOWN until the appointment is visible, then that appointment", async () => {
    const w = await seedWorld(t);
    const legacy = t.adapters.legacyScheduling;
    if (!legacy) throw new Error("legacy composed");
    const party = actingPartyFor(sessionOf(t.tenantId, w.client, "client"));
    const prep = legacy.prepareCreate(party, { providerRef: w.provider, startsAt: new Date(Date.now() + 9 * 86_400_000).toISOString().slice(0, 16) + ":00.000Z", modality: "video" });
    const subject = { kind: "appointment.create" as const, subjectId: w.client, target: prep.target, change: prep.change, expiresAt: new Date(Date.now() + 300_000).toISOString() };
    const key = `vsp-${"3a".repeat(24)}`;
    const ref = externalRefFor(key);
    const posts = async () => (await t.admin.requests(t.accountId)).filter((r) => r.operation === "legacy.appointment.post").length;
    const created = async () => (await t.admin.effects(t.accountId)).filter((e) => e.operation === "legacy.appointment.post").length;
    const postsBefore = await posts();
    const createdBefore = await created();
    const first = await legacy.commit(subject, key);
    expect(first.outcome).toBe("COMMITTED");
    // Inside the lag the reference is not visible: the duplicate is in doubt, and it sends no create.
    expect(await legacy.byReference(ref)).toEqual([]);
    await expect(legacy.commit(subject, key)).rejects.toMatchObject({ outcome: "UNKNOWN", reasonCode: "EARLIER_DISPATCH_IN_DOUBT" });
    expect((await posts()) - postsBefore).toBe(1);
    expect((await created()) - createdBefore).toBe(1);
    expect(await t.admin.legacyReference(t.accountId, ref)).toMatchObject({ state: "POSTED" });
    // Once visible: the duplicate is the earlier appointment, still one create.
    await eventually(async () => (await legacy.byReference(ref)).length === 1, WINDOW_MS + 3_000, 200);
    const later = await legacy.commit(subject, key);
    expect(later).toMatchObject({ outcome: "COMMITTED", providerReference: first.outcome === "COMMITTED" ? first.providerReference : "" });
    expect((await posts()) - postsBefore).toBe(1);
    expect((await created()) - createdBefore).toBe(1);
  });

  it("[ACT-02][FO-06-75] two deliveries of the same legacy create racing each other: exactly one create; the other is UNKNOWN (never a second appointment)", async () => {
    const w = await seedWorld(t);
    const legacy = t.adapters.legacyScheduling;
    if (!legacy) throw new Error("legacy composed");
    const party = actingPartyFor(sessionOf(t.tenantId, w.client, "client"));
    const prep = legacy.prepareCreate(party, { providerRef: w.provider, startsAt: new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 16) + ":00.000Z", modality: "phone" });
    const subject = { kind: "appointment.create" as const, subjectId: w.client, target: prep.target, change: prep.change, expiresAt: new Date(Date.now() + 300_000).toISOString() };
    const key = `vsp-${"4a".repeat(24)}`;
    const created = async () => (await t.admin.effects(t.accountId)).filter((e) => e.operation === "legacy.appointment.post").length;
    const createdBefore = await created();
    const results = await Promise.all([settled(legacy.commit(subject, key)), settled(legacy.commit(subject, key))]);
    expect(results.filter((r) => r.value?.outcome === "COMMITTED")).toHaveLength(1);
    expect(results.filter((r) => r.error?.outcome === "UNKNOWN")).toHaveLength(1);
    expect((await created()) - createdBefore).toBe(1);
  });
});
