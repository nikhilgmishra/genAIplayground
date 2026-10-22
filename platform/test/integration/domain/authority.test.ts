/**
 * Layer 2 (WP-23; AUTH-02, AUTH-05, FO-01-25): the acting party of a domain write is the confirmed action's party,
 * never taken from the record it targets, so the system of record's own authority re-check is never vacuous.
 *
 *   - the business layer's commit ports (SchedulingCommitPort, BillingReviewCommitPort) over the HTTP adapters:
 *     the business port passes no acting party for a reschedule or a billing review, and the adapter refuses
 *     before any request (ACTING_PARTY_REQUIRED, a definite FAILED, nothing sent) instead of assuming the record's
 *     own client; with the action's party passed (the business-port change handed to WP-25), the system of record
 *     refuses another party's record with 403 (AUTHORITY_REFUSED) and nothing is applied;
 *   - the domain commit port sends the action's party and the system refuses a foreign session's action;
 *   - a role switch never carries authority: a provider-approved action confirmed in the provider role cannot be
 *     committed from the client role (a new session generation invalidates it), and a client session cannot commit
 *     a provider-approved preparation through the domain command path.
 * Effects and requests are read from the system of record (append-only effect log, request log). SYNTHETIC data.
 */
import { afterAll, beforeAll, describe, expect } from "vitest";
import type { PrepareInput } from "../../../src/actions/ports.js";
import { BillingReviewCommitPort, SchedulingCommitPort } from "../../../src/business/providers.js";
import { actingPartyFor } from "../../../src/domain/authority.js";
import type { CommitSubject } from "../../../src/domain/commit.js";
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

beforeAll(async () => {
  const l2 = layer2Context(DOMAIN_SERVICES);
  pki = createDomainPki();
  t = await provisionTenant(l2, pki, { systems: ["scheduling", "billing"] });
  idb = await createIntegrationDb(l2);
  ledger = ledgerReplica(idb.db, systemClock, "domain-authority");
}, 180_000);

afterAll(async () => {
  await t?.dispose();
  await idb?.drop();
  pki?.dispose();
});

const outcomeOf = (p: Promise<{ outcome: string; stateReason?: string | null }>) =>
  p.then(
    (r) => r.outcome,
    (e: unknown) => `threw:${(e as { reasonCode?: string }).reasonCode ?? "?"}`,
  );

async function confirmedBy(ctx: ReturnType<typeof sessionOf>, input: PrepareInput): Promise<PreparedAction> {
  const prepared = await ledger.service.prepare(ctx, input, allowDecision());
  const { confirmation, integration } = dtmfConfirmation(ctx, prepared);
  return ledger.service.confirm(confirmation, integration);
}

describe("the acting party is the confirmed action's party (Layer 2)", () => {
  it("[AUTH-02][AUTH-05] a foreign session's reschedule through the business SchedulingCommitPort is refused before any request; with its party passed, the system of record refuses it 403", async () => {
    const w = await seedWorld(t);
    const scheduling = t.adapters.scheduling;
    if (!scheduling) throw new Error("scheduling composed");
    const ctx = sessionOf(t.tenantId, w.otherClient, "client");
    const slot = await scheduling.slot(w.slots[2] as string);
    const appt = await scheduling.appointment(w.appointment);
    if (!slot || !appt) throw new Error("records");
    // A business-layer preparation of otherClient that targets the client's appointment (a forged target).
    const action = await confirmedBy(ctx, {
      kind: "appointment.reschedule",
      target: { system: "scheduling", recordType: "appointment", recordRef: w.appointment, beforeVersion: appt.version },
      change: { slotId: slot.slotId, toStartsAt: slot.startsAt, toTimeZone: slot.timeZone, toModality: slot.modality, fromStartsAt: appt.startsAt },
      impact: { summaryTemplateId: "appointment.change_confirmation", fees: null, reversible: true },
      confirmationTemplateId: "appointment.change_confirmation",
      ttlSeconds: 300,
      requiresStepUp: false,
    });
    const before = (await t.admin.requests(t.accountId)).filter((r) => r.operation === "scheduling.reschedule.put").length;
    const viaBusiness = await outcomeOf(ledger.service.commit(ctx, { actionId: action.actionId, digest: action.digest }, { reauthorize: async () => allowDecision(), provider: new SchedulingCommitPort(scheduling) }));
    expect(viaBusiness).toBe("FAILED");
    expect((await ledger.service.describe?.(t.tenantId, action.actionId))?.stateReason).toBe("ACTING_PARTY_REQUIRED");
    // Nothing reached the system of record, nothing was applied to the owner's appointment.
    expect((await t.admin.requests(t.accountId)).filter((r) => r.operation === "scheduling.reschedule.put")).toHaveLength(before);
    expect(await t.admin.effects(t.accountId, w.appointment)).toHaveLength(0);
    // With the action's party passed (the business-port change handed to WP-25), the system itself refuses it.
    await expect(
      scheduling.reschedule({ appointmentId: w.appointment, beforeVersion: appt.version, slotId: slot.slotId, idempotencyKey: `vsp-${"d1".repeat(24)}`, actingPartyId: w.otherClient }),
    ).rejects.toMatchObject({ reasonCode: "AUTHORITY_REFUSED" });
    expect((await t.admin.requests(t.accountId)).filter((r) => r.operation === "scheduling.reschedule.put" && r.status === 403)).toHaveLength(1);
    expect(await t.admin.effects(t.accountId, w.appointment)).toHaveLength(0);
    // The owner's own party passes the same re-check.
    const own = await scheduling.reschedule({ appointmentId: w.appointment, beforeVersion: appt.version, slotId: slot.slotId, idempotencyKey: `vsp-${"d2".repeat(24)}`, actingPartyId: w.client });
    expect(own.appointment.startsAt).toBe(slot.startsAt);
    expect(await t.admin.effects(t.accountId, w.appointment)).toHaveLength(1);
  });

  it("[AUTH-02][AUTH-05] a foreign session's billing review through the business BillingReviewCommitPort is refused before any request; with its party passed, the system of record refuses it 403", async () => {
    const w = await seedWorld(t);
    const billing = t.adapters.billing;
    if (!billing) throw new Error("billing composed");
    const ctx = sessionOf(t.tenantId, w.otherClient, "client");
    const inv = await billing.invoice(w.invoice);
    if (!inv) throw new Error("invoice");
    const action = await confirmedBy(ctx, {
      kind: "billing.review.submit",
      target: { system: "billing", recordType: "invoice", recordRef: w.invoice, beforeVersion: inv.version },
      change: {},
      impact: { summaryTemplateId: "billing.review_confirmation", fees: null, reversible: true },
      confirmationTemplateId: "billing.review_confirmation",
      ttlSeconds: 300,
      requiresStepUp: false,
    });
    const viaBusiness = await outcomeOf(ledger.service.commit(ctx, { actionId: action.actionId, digest: action.digest }, { reauthorize: async () => allowDecision(), provider: new BillingReviewCommitPort(billing) }));
    expect(viaBusiness).toBe("FAILED");
    expect((await t.admin.requests(t.accountId)).filter((r) => r.operation === "billing.review_request.put")).toHaveLength(0);
    await expect(billing.markInReview({ invoiceId: w.invoice, beforeVersion: inv.version, idempotencyKey: `vsp-${"d3".repeat(24)}`, actingPartyId: w.otherClient })).rejects.toMatchObject({ reasonCode: "AUTHORITY_REFUSED" });
    expect((await t.admin.requests(t.accountId)).filter((r) => r.operation === "billing.review_request.put" && r.status === 403)).toHaveLength(1);
    expect(await t.admin.effects(t.accountId, w.invoice)).toHaveLength(0);
    expect((await billing.invoice(w.invoice))?.status).toBe("OPEN");
  });

  it("[AUTH-02][AUTH-05] the domain commit port sends the action's own party: a foreign session's action on another client's appointment is refused 403 by the system of record", async () => {
    const w = await seedWorld(t);
    const port = t.adapters.commitPort;
    if (!port) throw new Error("commit port composed");
    const appt = await t.adapters.scheduling?.appointment(w.appointment);
    if (!appt) throw new Error("appointment");
    const forged: CommitSubject = {
      kind: "appointment.reschedule",
      subjectId: w.otherClient,
      target: { system: "scheduling", recordType: "appointment", recordRef: w.appointment, beforeVersion: appt.version },
      change: { slotId: w.slots[0] as string, slotVersion: "1", authority: "CLIENT_CONFIRMED", actingPartyRef: w.otherClient },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const refused = async () => (await t.admin.requests(t.accountId)).filter((r) => r.operation === "scheduling.reschedule.put" && r.status === 403).length;
    const before = await refused();
    expect(await port.commit(forged, `vsp-${"d4".repeat(24)}`)).toEqual({ outcome: "FAILED", reasonCode: "AUTHORITY_REFUSED", permanent: true });
    expect(await refused()).toBe(before + 1);
    expect(await t.admin.effects(t.accountId, w.appointment)).toHaveLength(0);
  });

  it("[AUTH-02][FO-01-25] a role switch never carries authority: a provider-approved action cannot be committed from the client role, nor a provider preparation from a client session", async () => {
    const w = await seedWorld(t);
    const port = t.adapters.commitPort;
    if (!port) throw new Error("commit port composed");
    const providerCtx = sessionOf(t.tenantId, w.provider, "provider");
    const prep = await port.prepare(actingPartyFor(providerCtx), { kind: "provider.appointment.reschedule", appointmentId: w.otherAppointment, slotId: w.slots[1] as string });
    expect(prep.input.confirmationTemplateId).toBe("provider.appointment.change_confirmation");
    if (prep.ledgerKind === null) throw new Error("ledger kind");
    const action = await confirmedBy(providerCtx, { ...prep.input, kind: prep.ledgerKind });
    // The same person switches to the client role: a new session generation of the same session.
    const switched = { ...providerCtx, selectedRole: "client" as const, sessionGeneration: providerCtx.sessionGeneration + 1 };
    const r = await outcomeOf(ledger.service.commit(switched, { actionId: action.actionId, digest: action.digest }, { reauthorize: async () => allowDecision(), provider: port }));
    expect(r).toBe("threw:SESSION_GENERATION_CHANGED");
    expect((await ledger.service.describe?.(t.tenantId, action.actionId))?.state).toBe("INVALIDATED");
    expect(await t.admin.effects(t.accountId, w.otherAppointment)).toHaveLength(0);
    // The domain command path refuses a provider preparation from a client session before any request.
    const block = await port.prepare(actingPartyFor(providerCtx), { kind: "provider.availability.block", slotId: w.slots[3] as string, reasonCode: "PROVIDER_UNAVAILABLE" });
    const requests = (await t.admin.requests(t.accountId)).length;
    await expect(port.commitCommand({ role: "client", partyRef: w.provider }, block, `vsp-${"d5".repeat(24)}`)).rejects.toMatchObject({ reasonCode: "CLIENT_CANNOT_APPROVE_PROVIDER_ACTION" });
    expect((await t.admin.requests(t.accountId)).length).toBe(requests);
    expect((await t.adapters.scheduling?.slot(w.slots[3] as string))?.state).toBe("OPEN");
  });
});
