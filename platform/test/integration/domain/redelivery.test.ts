/**
 * Layer 2 (WP-23; ACT-02, ACT-03, FO-06-75): duplicate delivery and key reuse at the reference business API.
 *
 *   - A redelivery of a committed action with the same key REPLAYS (COMMITTED, the same receipt, one effect): for
 *     domain-prepared actions the body follows from the confirmed action alone (the same request digest); for
 *     business-layer preparations (no slot version) the request id is looked up before any body is derived from
 *     current state, so the earlier delivery is the answer and no second, different body is sent under the key.
 *   - The same key with ANOTHER payload is never claimed for the second action: the system refuses the write (422,
 *     in doubt: UNKNOWN), and reconciliation compares the stored request digest and resource with the second
 *     action: PAYLOAD_MISMATCH (UNKNOWN), never the first action's booking.
 * Effects are read from the system's append-only effect log; requests from its request log. SYNTHETIC data only.
 */
import { afterAll, beforeAll, describe, expect } from "vitest";
import type { PrepareInput, ProviderCommitPort } from "../../../src/actions/ports.js";
import { SchedulingCommitPort } from "../../../src/business/providers.js";
import { actingPartyFor } from "../../../src/domain/authority.js";
import { requestIdFor } from "../../../src/domain/changes.js";
import type { CommitSubject, DomainCommitPort } from "../../../src/domain/commit.js";
import type { PreparedAction } from "../../../src/protocol/index.js";
import { systemClock } from "../../../src/shared/clock.js";
import { createIntegrationDb } from "../_harness/clients.js";
import type { IntegrationDb } from "../_harness/clients.js";
import { layer2, layer2Context } from "../_harness/layer2.js";
import { ledgerReplica } from "../substrate/reference-sor.js";
import type { LedgerReplica } from "../substrate/reference-sor.js";
import { DOMAIN_SERVICES, allowDecision, createDomainPki, dtmfConfirmation, provisionTenant, seedWorld, sessionOf } from "./support.js";
import type { DomainPki, Tenant } from "./support.js";

const it = layer2(DOMAIN_SERVICES);

let pki: DomainPki;
let t: Tenant;
let idb: IntegrationDb;
let ledger: LedgerReplica;
let port: DomainCommitPort;

beforeAll(async () => {
  const l2 = layer2Context(DOMAIN_SERVICES);
  pki = createDomainPki();
  t = await provisionTenant(l2, pki, { systems: ["scheduling", "billing"] });
  idb = await createIntegrationDb(l2);
  ledger = ledgerReplica(idb.db, systemClock, "domain-redelivery");
  if (!t.adapters.commitPort) throw new Error("commit port composed");
  port = t.adapters.commitPort;
}, 180_000);

afterAll(async () => {
  await t?.dispose();
  await idb?.drop();
  pki?.dispose();
});

const effectsOf = async (key: string) => (await t.admin.effects(t.accountId)).filter((e) => e.requestId === requestIdFor(key));
const writesOf = async (operation: string, key: string) => (await t.admin.requests(t.accountId)).filter((r) => r.operation === operation && r.keyRef === requestIdFor(key));
const expiry = () => new Date(Date.now() + 300_000).toISOString();

async function businessAction(ctx: ReturnType<typeof sessionOf>, input: PrepareInput): Promise<PreparedAction> {
  const prepared = await ledger.service.prepare(ctx, input, allowDecision());
  const { confirmation, integration } = dtmfConfirmation(ctx, prepared);
  return ledger.service.confirm(confirmation, integration);
}

describe("duplicate delivery and key reuse (Layer 2)", () => {
  it("[ACT-02][FO-06-75] a business-prepared create (no slot version) delivered twice with the same key through the domain port replays: COMMITTED twice, one booking, one write", async () => {
    const w = await seedWorld(t);
    const slot = await t.adapters.scheduling?.slot(w.slots[0] as string);
    if (!slot) throw new Error("slot");
    const action: CommitSubject = {
      kind: "appointment.create",
      subjectId: w.client,
      target: { system: "scheduling", recordType: "appointment_slot", recordRef: slot.slotId, beforeVersion: "slot.open" },
      change: { slotId: slot.slotId, toStartsAt: slot.startsAt, toTimeZone: slot.timeZone, toModality: slot.modality, providerName: slot.providerDisplayName },
      expiresAt: expiry(),
    };
    const key = `vsp-${"5e".repeat(24)}`;
    const first = await port.commit(action, key);
    const again = await port.commit(action, key);
    expect(first.outcome).toBe("COMMITTED");
    expect(again).toEqual(first);
    expect(await effectsOf(key)).toHaveLength(1);
    // The second delivery was answered from the lookup by key: one write only, never a second body.
    expect(await writesOf("scheduling.booking.put", key)).toHaveLength(1);
  });

  it("[ACT-02][FO-06-75] a business-prepared reschedule and billing review delivered twice through the domain port replay: COMMITTED, one effect each", async () => {
    const w = await seedWorld(t);
    const s = t.adapters.scheduling;
    const b = t.adapters.billing;
    if (!s || !b) throw new Error("composed");
    const appt = await s.appointment(w.appointment);
    const slot = await s.slot(w.slots[1] as string);
    const inv = await b.invoice(w.invoice);
    if (!appt || !slot || !inv) throw new Error("records");
    const reschedule: CommitSubject = {
      kind: "appointment.reschedule",
      subjectId: w.client,
      target: { system: "scheduling", recordType: "appointment", recordRef: appt.appointmentId, beforeVersion: appt.version },
      change: { slotId: slot.slotId, toStartsAt: slot.startsAt, toTimeZone: slot.timeZone, toModality: slot.modality, fromStartsAt: appt.startsAt },
      expiresAt: expiry(),
    };
    const k1 = `vsp-${"6a".repeat(24)}`;
    const r1 = await port.commit(reschedule, k1);
    expect(r1.outcome).toBe("COMMITTED");
    expect(await port.commit(reschedule, k1)).toEqual(r1);
    expect(await effectsOf(k1)).toHaveLength(1);
    expect(await writesOf("scheduling.reschedule.put", k1)).toHaveLength(1);
    const review: CommitSubject = { kind: "billing.review.submit", subjectId: w.client, target: { system: "billing", recordType: "invoice", recordRef: inv.invoiceId, beforeVersion: inv.version }, change: {}, expiresAt: expiry() };
    const k2 = `vsp-${"6b".repeat(24)}`;
    const r2 = await port.commit(review, k2);
    expect(r2.outcome).toBe("COMMITTED");
    expect(await port.commit(review, k2)).toEqual(r2);
    expect(await effectsOf(k2)).toHaveLength(1);
    // The billing body follows from the action alone: the redelivery is replayed by the system itself.
    expect(await writesOf("billing.review_request.put", k2)).toHaveLength(2);
  });

  it("[ACT-02] the business layer's SchedulingCommitPort: a create delivered twice with the same key returns the same booking (COMMITTED), one effect", async () => {
    const w = await seedWorld(t);
    const s = t.adapters.scheduling;
    if (!s) throw new Error("scheduling composed");
    const slot = await s.slot(w.slots[2] as string);
    if (!slot) throw new Error("slot");
    const ctx = sessionOf(t.tenantId, w.client, "client");
    const action = await businessAction(ctx, {
      kind: "appointment.create",
      target: { system: "scheduling", recordType: "appointment_slot", recordRef: slot.slotId, beforeVersion: "slot.open" },
      change: { slotId: slot.slotId, toStartsAt: slot.startsAt, toTimeZone: slot.timeZone, toModality: slot.modality, providerName: slot.providerDisplayName },
      impact: { summaryTemplateId: "appointment.create_confirmation", fees: null, reversible: true },
      confirmationTemplateId: "appointment.create_confirmation",
      ttlSeconds: 300,
      requiresStepUp: false,
    });
    const business: ProviderCommitPort = new SchedulingCommitPort(s);
    const receipt = await ledger.service.commit(ctx, { actionId: action.actionId, digest: action.digest }, { reauthorize: async () => allowDecision(), provider: business });
    expect(receipt.outcome).toBe("COMMITTED");
    const key = (await ledger.service.describe?.(t.tenantId, action.actionId))?.providerIdempotencyKey ?? "";
    // A redelivery of the same commit to the port (a second replica, a retried message) with the ledger's key.
    const redelivered = await business.commit(action, key);
    expect(redelivered).toMatchObject({ outcome: "COMMITTED", providerReference: receipt.providerReference });
    expect(await effectsOf(key)).toHaveLength(1);
    expect(await writesOf("scheduling.booking.put", key)).toHaveLength(1);
    // And through the executor: a repeated commit of the committed action returns the stored receipt.
    const replay = await ledger.service.commit(ctx, { actionId: action.actionId, digest: action.digest }, { reauthorize: async () => allowDecision(), provider: business });
    expect(replay.receiptId).toBe(receipt.receiptId);
  });

  it("[ACT-02][ACT-03] the same key with another payload: the system refuses the write (in doubt, UNKNOWN), and neither reconciliation nor a business-layer lookup-first ever claims the first action's booking for the second (PAYLOAD_MISMATCH)", async () => {
    const w = await seedWorld(t);
    const client = actingPartyFor(sessionOf(t.tenantId, w.client, "client"));
    const key = `vsp-${"9c".repeat(24)}`;
    const p1 = await port.prepare(client, { kind: "appointment.create", slotId: w.slots[0] as string });
    const s1: CommitSubject = { kind: "appointment.create", subjectId: w.client, target: p1.input.target, change: p1.input.change, expiresAt: expiry() };
    expect((await port.commit(s1, key)).outcome).toBe("COMMITTED");
    const p2 = await port.prepare(client, { kind: "appointment.create", slotId: w.slots[1] as string });
    const s2: CommitSubject = { kind: "appointment.create", subjectId: w.client, target: p2.input.target, change: p2.input.change, expiresAt: s1.expiresAt };
    await expect(port.commit(s2, key)).rejects.toMatchObject({ outcome: "UNKNOWN", reasonCode: "REQUEST_ID_IN_USE" });
    expect((await writesOf("scheduling.booking.put", key)).map((r) => r.status)).toEqual([200, 422]);
    expect(await port.reconcileDecision(s2, key)).toEqual({ outcome: "UNKNOWN", reasonCode: "PAYLOAD_MISMATCH" });
    expect(await port.lookup(s2, key)).toEqual({ outcome: "UNKNOWN" });
    // The first action's own reconciliation still finds its booking; only one booking exists under the key.
    expect((await port.lookup(s1, key)).outcome).toBe("COMMITTED");
    expect(await effectsOf(key)).toHaveLength(1);
    expect((await t.adapters.scheduling?.slot(w.slots[1] as string))?.state).toBe("OPEN");
    // A business-layer preparation (no slot version) under the same key looks the id up first and finds the FIRST
    // action's booking: never claimed for this action (the request digest and the slot differ), nothing sent.
    const slot3 = await t.adapters.scheduling?.slot(w.slots[2] as string);
    if (!slot3) throw new Error("slot");
    const s3: CommitSubject = {
      kind: "appointment.create",
      subjectId: w.client,
      target: { system: "scheduling", recordType: "appointment_slot", recordRef: slot3.slotId, beforeVersion: "slot.open" },
      change: { slotId: slot3.slotId, toStartsAt: slot3.startsAt, toTimeZone: slot3.timeZone, toModality: slot3.modality, providerName: slot3.providerDisplayName },
      expiresAt: s1.expiresAt,
    };
    await expect(port.commit(s3, key)).rejects.toMatchObject({ outcome: "UNKNOWN", reasonCode: "RECONCILE_PAYLOAD_MISMATCH" });
    expect((await writesOf("scheduling.booking.put", key)).map((r) => r.status)).toEqual([200, 422]);
    expect((await t.adapters.scheduling?.slot(w.slots[2] as string))?.state).toBe("OPEN");
    expect(await effectsOf(key)).toHaveLength(1);
  });
});
