/**
 * Layer 2 (WP-23): prepare, commit, receipt and reconciliation of domain actions through the PRODUCTION action
 * executor (LedgerActionService on postgres:16) and the domain commit port over the reference business API
 * (FO-03-09, FO-06-75, FO-11-02, FO-01-25, FO-01-26; ACT-01, ACT-02, ACT-03, AUTH-02, AUTH-05).
 *
 * Exactly-once is a fact of the system of record: its append-only effect log (read through the fault-control
 * listener) and its request log, never a counter in test memory. The `[FAULT:<ID> seam]` tests exercise the
 * seams the reference API offers for WP-25's fault tests; they are seam tests and count for no fault row.
 */
import { afterAll, beforeAll, describe, expect } from "vitest";
import type { ActionService, PrepareInput, ProviderCommitPort } from "../../../src/actions/ports.js";
import { SchedulingCommitPort } from "../../../src/business/providers.js";
import { actingPartyFor } from "../../../src/domain/authority.js";
import { requestIdFor } from "../../../src/domain/changes.js";
import type { CommitSubject, DomainCommitPort, DomainPreparation } from "../../../src/domain/commit.js";
import type { PreparedAction } from "../../../src/protocol/index.js";
import { AccessDeniedError, ConflictError } from "../../../src/shared/errors.js";
import { systemClock } from "../../../src/shared/clock.js";
import { createIntegrationDb } from "../_harness/clients.js";
import type { IntegrationDb } from "../_harness/clients.js";
import { layer2, layer2Context } from "../_harness/layer2.js";
import { ledgerReplica } from "../substrate/reference-sor.js";
import type { LedgerReplica } from "../substrate/reference-sor.js";
import { DOMAIN_SERVICES, allowDecision, createDomainPki, dtmfConfirmation, eventually, provisionTenant, seedWorld, sessionOf } from "./support.js";
import type { DomainPki, Tenant } from "./support.js";

const it = layer2(DOMAIN_SERVICES);

const WRITE_TIMEOUT_MS = 2_000;
const WINDOW_MS = 1_500;

let pki: DomainPki;
let t: Tenant;
let idb: IntegrationDb;
let ledger: LedgerReplica;
let port: DomainCommitPort;

beforeAll(async () => {
  const l2 = layer2Context(DOMAIN_SERVICES);
  pki = createDomainPki();
  t = await provisionTenant(l2, pki, { systems: ["scheduling", "billing"], writeTimeoutMs: WRITE_TIMEOUT_MS, visibilityWindowMs: WINDOW_MS });
  idb = await createIntegrationDb(l2);
  ledger = ledgerReplica(idb.db, systemClock, "domain-commit");
  if (!t.adapters.commitPort) throw new Error("commit port composed");
  port = t.adapters.commitPort;
}, 180_000);

afterAll(async () => {
  await t?.dispose();
  await idb?.drop();
  pki?.dispose();
});

const svc = (): ActionService => ledger.service;

/** Prepares (ledger), confirms (trusted DTMF) and returns the session and the confirmed action. */
async function confirmed(role: "client" | "provider", partyRef: string, prep: DomainPreparation) {
  if (prep.ledgerKind === null) throw new Error("ledger kind expected");
  const ctx = sessionOf(t.tenantId, partyRef, role);
  const input: PrepareInput = { ...prep.input, kind: prep.ledgerKind };
  const prepared = await svc().prepare(ctx, input, allowDecision());
  const { confirmation, integration } = dtmfConfirmation(ctx, prepared);
  const action = await svc().confirm(confirmation, integration);
  return { ctx, action };
}

const commitVia = (ctx: ReturnType<typeof sessionOf>, action: PreparedAction, provider: ProviderCommitPort = port) =>
  svc().commit(ctx, { actionId: action.actionId, digest: action.digest }, { reauthorize: async () => allowDecision(), provider });

const keyOf = async (action: PreparedAction): Promise<string> => {
  const d = await ledger.service.describe?.(t.tenantId, action.actionId);
  if (!d) throw new Error("ledger entry");
  return d.providerIdempotencyKey;
};

const putsOf = async (operation: string, requestId: string) => (await t.admin.requests(t.accountId)).filter((r) => r.operation === operation && r.keyRef === requestId);

describe("domain commit through the action executor (Layer 2)", () => {
  it("[ACT-02][FO-03-09][FO-11-02] a confirmed reschedule commits once; duplicate delivery replays; the effect is verified by read-back", async () => {
    const w = await seedWorld(t);
    const client = actingPartyFor(sessionOf(t.tenantId, w.client, "client"));
    const prep = await port.prepare(client, { kind: "appointment.reschedule", appointmentId: w.appointment, slotId: w.slots[0] as string });
    expect(prep.input.target.beforeVersion).toMatch(/^a3\.s1$/);
    const { ctx, action } = await confirmed("client", w.client, prep);
    const receipt = await commitVia(ctx, action);
    expect(receipt.outcome).toBe("COMMITTED");
    const effects = await t.admin.effects(t.accountId, w.appointment);
    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({ operation: "scheduling.reschedule.put", beforeVersion: "3", afterVersion: "4" });

    // Redelivery of the same commit with the same key: the system replays the change, no second effect.
    const key = await keyOf(action);
    const again = await port.commit(action, key);
    expect(again.outcome).toBe("COMMITTED");
    if (again.outcome === "COMMITTED") expect(again.afterVersion).toBe("4");
    expect(await t.admin.effects(t.accountId, w.appointment)).toHaveLength(1);
    expect(await putsOf("scheduling.reschedule.put", requestIdFor(key))).toHaveLength(2);

    // Independent effect verification: an authoritative read-back of the record (never response text).
    if (again.outcome !== "COMMITTED") return;
    const v = await port.verifyEffect({ tenantId: t.tenantId, actionId: action.actionId, causationId: action.actionId, commitReceiptId: null, action, receipt: { providerReference: again.providerReference, afterVersion: again.afterVersion, evidence: again.evidence, committedAt: new Date().toISOString() } });
    expect(v.result).toBe("VERIFIED");
    expect(v.verifier.independentOfModel).toBe(true);
    const appt = await t.adapters.scheduling?.appointment(w.appointment);
    expect(appt?.startsAt).toBe(prep.input.change.toStartsAt);
  });

  it("[ACT-03][FAULT:SCHEDULING_TIMEOUT_AFTER_COMMIT seam] a timeout after the booking committed is reconciled by key: no duplicate, never retried blindly", async () => {
    const w = await seedWorld(t);
    const client = actingPartyFor(sessionOf(t.tenantId, w.client, "client"));
    const prep = await port.prepare(client, { kind: "appointment.create", slotId: w.slots[1] as string });
    const { ctx, action } = await confirmed("client", w.client, prep);
    await t.admin.arm(t.accountId, { operation: "scheduling.booking.put", kind: "COMMIT_THEN_DELAY", delayMs: WRITE_TIMEOUT_MS + 2_000, times: 1 });
    // The executor records UNKNOWN and returns a transient UNKNOWN receipt: never a success claim.
    expect((await commitVia(ctx, action)).outcome).toBe("UNKNOWN");
    // Reach: the fault fired at the system of record, after the change was applied.
    expect((await t.admin.faults(t.accountId)).find((f) => f.kind === "COMMIT_THEN_DELAY")?.hits).toBe(1);
    const key = await keyOf(action);
    expect((await ledger.service.describe?.(t.tenantId, action.actionId))?.state).toBe("UNKNOWN");
    // A repeated commit of the in-doubt action is never a blind retry: the executor reconciles it by key first.
    const again = await commitVia(ctx, action);
    expect(again).toMatchObject({ outcome: "COMMITTED", reconciled: true });
    const receipt = await ledger.service.reconcile(action.actionId, port, t.tenantId);
    expect(receipt.outcome).toBe("COMMITTED");
    expect(receipt.providerReference).toBe(again.providerReference);
    const bookings = (await t.admin.effects(t.accountId)).filter((e) => e.requestId === requestIdFor(key));
    expect(bookings).toHaveLength(1);
    // The write was sent exactly once (the second attempt never reached the system of record).
    expect((await putsOf("scheduling.booking.put", requestIdFor(key))).length).toBeLessThanOrEqual(1);
    await t.admin.clearFaults(t.accountId);
  });

  it("[ACT-03][FAULT:RECEIPT_LOST seam] a change whose response is lost after commit is reconciled to its receipt, one effect", async () => {
    const w = await seedWorld(t);
    const client = actingPartyFor(sessionOf(t.tenantId, w.client, "client"));
    const prep = await port.prepare(client, { kind: "appointment.reschedule", appointmentId: w.appointment, slotId: w.slots[2] as string });
    const { ctx, action } = await confirmed("client", w.client, prep);
    await t.admin.arm(t.accountId, { operation: "scheduling.reschedule.put", kind: "DROP_RESPONSE_AFTER_COMMIT", times: 1 });
    expect((await commitVia(ctx, action)).outcome).toBe("UNKNOWN");
    expect((await t.admin.faults(t.accountId)).find((f) => f.kind === "DROP_RESPONSE_AFTER_COMMIT")?.hits).toBe(1);
    const receipt = await ledger.service.reconcile(action.actionId, port, t.tenantId);
    expect(receipt.outcome).toBe("COMMITTED");
    expect(await t.admin.effects(t.accountId, w.appointment)).toHaveLength(1);
    await t.admin.clearFaults(t.accountId);
  });

  it("[ACT-03][FAULT:RECEIPT_LATE seam] a receipt that becomes visible only after the write timed out: strictly UNKNOWN (NOT_VISIBLE_WITHIN_WINDOW, never NOT_FOUND) at the first reconcile, then COMMITTED", async () => {
    // A tenant whose documented window (3 s) is longer than the write timeout (1 s): the seam's lag (3 s) and held
    // response (3.5 s) make the receipt invisible when the executor first reconciles.
    const late = await provisionTenant(layer2Context(DOMAIN_SERVICES), pki, { systems: ["scheduling"], writeTimeoutMs: 1_000, visibilityWindowMs: 3_000 });
    try {
      const latePort = late.adapters.commitPort;
      if (!latePort) throw new Error("commit port composed");
      const w = await seedWorld(late);
      const client = actingPartyFor(sessionOf(late.tenantId, w.client, "client"));
      const prep = await latePort.prepare(client, { kind: "appointment.reschedule", appointmentId: w.appointment, slotId: w.slots[3] as string });
      const ctx = sessionOf(late.tenantId, w.client, "client");
      const prepared = await svc().prepare(ctx, { ...prep.input, kind: "appointment.reschedule" } as PrepareInput, allowDecision());
      const { confirmation, integration } = dtmfConfirmation(ctx, prepared);
      const action = await svc().confirm(confirmation, integration);
      await late.admin.arm(late.accountId, { operation: "scheduling.reschedule.put", kind: "LATE_RECEIPT", lagMs: 3_000, delayMs: 3_500, times: 1 });
      const committedAt = Date.now();
      expect((await svc().commit(ctx, { actionId: action.actionId, digest: action.digest }, { reauthorize: async () => allowDecision(), provider: latePort })).outcome).toBe("UNKNOWN");
      expect((await late.admin.faults(late.accountId)).find((f) => f.kind === "LATE_RECEIPT")?.hits).toBe(1);
      const key = (await ledger.service.describe?.(late.tenantId, action.actionId))?.providerIdempotencyKey ?? "";
      // The change is at the system (one effect) but its lookup lags: the platform must not see it yet.
      expect(await late.admin.effects(late.accountId, w.appointment)).toHaveLength(1);
      expect(Date.now() - committedAt).toBeLessThan(2_500);
      expect(await latePort.reconcileDecision(action, key)).toEqual({ outcome: "UNKNOWN", reasonCode: "NOT_VISIBLE_WITHIN_WINDOW" });
      const early = await ledger.service.reconcileWithResult?.(late.tenantId, action.actionId, latePort);
      expect(early?.result).toBe("UNKNOWN");
      await eventually(async () => (await latePort.reconcileDecision(action, key)).outcome === "COMMITTED", 8_000);
      const receipt = await ledger.service.reconcile(action.actionId, latePort, late.tenantId);
      expect(receipt.outcome).toBe("COMMITTED");
      expect(await late.admin.effects(late.accountId, w.appointment)).toHaveLength(1);
    } finally {
      await late.dispose();
    }
  });

  it("[ACT-01][FAULT:CHANGED_SLOT_DURING_CONFIRMATION seam] a slot changed by another channel after the read-back refuses the commit; nothing is written", async () => {
    const w = await seedWorld(t);
    const slot = w.slots[0] as string;
    await t.admin.arm(t.accountId, { operation: "scheduling.slot.get", kind: "SLOT_VERSION_CHANGE", resourceId: slot, afterReads: 1, times: 1 });
    const client = actingPartyFor(sessionOf(t.tenantId, w.client, "client"));
    const prep = await port.prepare(client, { kind: "appointment.reschedule", appointmentId: w.appointment, slotId: slot });
    const { ctx, action } = await confirmed("client", w.client, prep);
    await expect(commitVia(ctx, action)).rejects.toBeInstanceOf(ConflictError);
    expect((await t.admin.faults(t.accountId)).find((f) => f.kind === "SLOT_VERSION_CHANGE")?.hits).toBe(1);
    expect((await ledger.service.describe?.(t.tenantId, action.actionId))?.state).toBe("INVALIDATED");
    expect(await t.admin.effects(t.accountId, w.appointment)).toHaveLength(0);
    // The system of record re-checks the version itself: a stale token sent anyway is refused there.
    const stale: CommitSubject = { ...action, target: { ...action.target, beforeVersion: "a3.s1" }, change: { ...action.change, slotVersion: "1" } };
    const r = await port.commit(stale, `vsp-${"ab".repeat(24)}`);
    expect(r).toEqual({ outcome: "FAILED", reasonCode: "STATE_CHANGED", permanent: true });
    expect(await t.admin.effects(t.accountId, w.appointment)).toHaveLength(0);
    await t.admin.clearFaults(t.accountId);
  });

  it("[ACT-02][FAULT:CONCURRENT_SAME_ACCOUNT seam] two commits racing for the same slot at the system of record: exactly one booking, the other refused", async () => {
    const w = await seedWorld(t);
    const slot = w.slots[3] as string;
    const a = await confirmed("client", w.client, await port.prepare(actingPartyFor(sessionOf(t.tenantId, w.client, "client")), { kind: "appointment.create", slotId: slot }));
    const b = await confirmed("client", w.otherClient, await port.prepare(actingPartyFor(sessionOf(t.tenantId, w.otherClient, "client")), { kind: "appointment.create", slotId: slot }));
    // Two executors (two replicas or channels of the same account) send their keyed writes at the same moment: the
    // barrier holds both at the system of record until both arrived, then they race on the slot's row lock.
    await t.admin.barrier(t.accountId, { operation: "scheduling.booking.put", resourceId: slot, parties: 2, timeoutMs: 10_000 });
    const [ka, kb] = [`vsp-${"a1".repeat(24)}`, `vsp-${"b2".repeat(24)}`];
    const results = await Promise.all([port.commit(a.action, ka), port.commit(b.action, kb)]);
    const barrier = (await t.admin.barriers(t.accountId)).find((x) => x.arrived >= 2);
    expect(barrier?.released).toBe(true);
    expect(barrier?.timedOut).toBe(false);
    expect(results.filter((r) => r.outcome === "COMMITTED")).toHaveLength(1);
    expect(results.filter((r) => r.outcome === "FAILED")).toHaveLength(1);
    const ids = new Set([requestIdFor(ka), requestIdFor(kb)]);
    const bookings = (await t.admin.effects(t.accountId)).filter((e) => e.operation === "scheduling.booking.put" && e.requestId !== null && ids.has(e.requestId));
    expect(bookings).toHaveLength(1);
    // Through the executor, the slot is already taken: the confirmed actions cannot book it a second time.
    const viaLedger = await Promise.allSettled([commitVia(a.ctx, a.action), commitVia(b.ctx, b.action)]);
    expect(viaLedger.filter((r) => r.status === "fulfilled" && r.value.outcome === "COMMITTED")).toHaveLength(0);
    const slotRow = await t.adapters.scheduling?.slot(slot);
    expect(slotRow?.state).toBe("BOOKED");
  });

  it("[AUTH-02][FO-01-25][FO-01-26] a provider's approval is never a client's consent; provider-approved changes stay on the provider's own schedule", async () => {
    const w = await seedWorld(t);
    const provider = actingPartyFor(sessionOf(t.tenantId, w.provider, "provider"));
    const client = actingPartyFor(sessionOf(t.tenantId, w.client, "client"));
    // A provider cannot prepare a client action, a client cannot prepare a provider action (before any I/O).
    await expect(port.prepare(provider, { kind: "appointment.reschedule", appointmentId: w.appointment, slotId: w.slots[0] as string })).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(port.prepare(client, { kind: "provider.availability.block", slotId: w.slots[0] as string, reasonCode: "PROVIDER_UNAVAILABLE" })).rejects.toBeInstanceOf(AccessDeniedError);
    // A provider-approved reschedule of an appointment on the provider's own schedule commits through the executor.
    const prep = await port.prepare(provider, { kind: "provider.appointment.reschedule", appointmentId: w.otherAppointment, slotId: w.slots[1] as string });
    expect(prep.input.change.authority).toBe("PROVIDER_APPROVED");
    const { ctx, action } = await confirmed("provider", w.provider, prep);
    expect((await commitVia(ctx, action)).outcome).toBe("COMMITTED");
    expect(await t.admin.effects(t.accountId, w.otherAppointment)).toHaveLength(1);
    // Another provider is refused by the system of record itself (adversarial: forged action, no effect).
    const forged: CommitSubject = { ...action, subjectId: w.otherProvider, change: { ...action.change, actingPartyRef: w.otherProvider, slotId: w.slots[2] as string, slotVersion: "1" }, target: { ...action.target, beforeVersion: "a2.s1" } };
    expect(await port.commit(forged, `vsp-${"cd".repeat(24)}`)).toEqual({ outcome: "FAILED", reasonCode: "AUTHORITY_REFUSED", permanent: true });
    // A client action carrying provider authority is refused by the system (the client is not the provider).
    const clientForged: CommitSubject = { ...forged, subjectId: w.client, change: { ...forged.change, actingPartyRef: w.client } };
    expect(await port.commit(clientForged, `vsp-${"ef".repeat(24)}`)).toEqual({ outcome: "FAILED", reasonCode: "AUTHORITY_REFUSED", permanent: true });
    // A booking can never be committed under provider authority (refused before any request).
    const before = (await t.admin.requests(t.accountId)).length;
    const createAsProvider: CommitSubject = { kind: "appointment.create", subjectId: w.client, target: { system: "scheduling", recordType: "appointment_slot", recordRef: w.slots[3] as string, beforeVersion: "s1" }, change: { slotId: w.slots[3] as string, slotVersion: "1", authority: "PROVIDER_APPROVED", actingPartyRef: w.client }, expiresAt: new Date(Date.now() + 60_000).toISOString() };
    expect(await port.commit(createAsProvider, `vsp-${"12".repeat(24)}`)).toEqual({ outcome: "FAILED", reasonCode: "PROVIDER_APPROVAL_IS_NOT_CLIENT_CONSENT", permanent: true });
    expect((await t.admin.requests(t.accountId)).length).toBe(before);
    expect(await t.admin.effects(t.accountId, w.otherAppointment)).toHaveLength(1);
  });

  it("[AUTH-02][FO-01-26] a provider blocks availability on their own schedule through the domain command path; another provider's slot is not theirs", async () => {
    const w = await seedWorld(t);
    const provider = actingPartyFor(sessionOf(t.tenantId, w.provider, "provider"));
    const prep = await port.prepare(provider, { kind: "provider.availability.block", slotId: w.slots[2] as string, reasonCode: "PROVIDER_UNAVAILABLE" });
    expect(prep.ledgerKind).toBeNull();
    expect(prep.input.change).toMatchObject({ authority: "PROVIDER_APPROVED", actingPartyRef: w.provider });
    const key = `vsp-${"6d".repeat(24)}`;
    const r = await port.commitCommand(provider, prep, key);
    expect(r.outcome).toBe("COMMITTED");
    expect((await t.adapters.scheduling?.slot(w.slots[2] as string))?.state).toBe("BLOCKED");
    // The same command again (a redelivery) replays: one effect.
    expect((await port.commitCommand(provider, prep, key)).outcome).toBe("COMMITTED");
    expect((await t.admin.effects(t.accountId, w.slots[2] as string)).filter((e) => e.operation === "scheduling.availability_block.put")).toHaveLength(1);
    // Another provider's slot reads as not available (no disclosure), and a preparation of one party is not another's.
    await expect(port.prepare(provider, { kind: "provider.availability.block", slotId: w.otherProviderSlot, reasonCode: "ADMINISTRATIVE" })).rejects.toMatchObject({ reasonCode: "TARGET_NOT_AVAILABLE" });
    const other = actingPartyFor(sessionOf(t.tenantId, w.otherProvider, "provider"));
    await expect(port.commitCommand(other, prep, `vsp-${"7e".repeat(24)}`)).rejects.toMatchObject({ reasonCode: "DOMAIN_ACTING_PARTY_MISMATCH" });
    // The command path never commits a kind the ledger knows (the client's cancellation runs only through the ledger).
    const client = actingPartyFor(sessionOf(t.tenantId, w.client, "client"));
    const cancel = await port.prepare(client, { kind: "appointment.cancel", appointmentId: w.appointment, reasonCode: "CLIENT_REQUEST" });
    const before = (await t.admin.requests(t.accountId)).length;
    await expect(port.commitCommand(client, cancel, `vsp-${"8e".repeat(24)}`)).rejects.toMatchObject({ reasonCode: "DOMAIN_KIND_REQUIRES_LEDGER" });
    expect((await t.admin.requests(t.accountId)).length).toBe(before);
    expect((await t.adapters.scheduling?.appointment(w.appointment))?.status).toBe("SCHEDULED");
  });

  it("[AUTH-05] a client cannot prepare or commit a change to another client's appointment", async () => {
    const w = await seedWorld(t);
    const client = actingPartyFor(sessionOf(t.tenantId, w.client, "client"));
    await expect(port.prepare(client, { kind: "appointment.reschedule", appointmentId: w.otherAppointment, slotId: w.slots[0] as string })).rejects.toMatchObject({ reasonCode: "TARGET_NOT_AVAILABLE" });
    const forged: CommitSubject = {
      kind: "appointment.reschedule",
      subjectId: w.client,
      target: { system: "scheduling", recordType: "appointment", recordRef: w.otherAppointment, beforeVersion: "a1.s1" },
      change: { slotId: w.slots[0] as string, slotVersion: "1", authority: "CLIENT_CONFIRMED", actingPartyRef: w.client },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    expect(await port.commit(forged, `vsp-${"34".repeat(24)}`)).toEqual({ outcome: "FAILED", reasonCode: "AUTHORITY_REFUSED", permanent: true });
    expect(await t.admin.effects(t.accountId, w.otherAppointment)).toHaveLength(0);
  });

  it("[ACT-03] an absent request is never NOT_FOUND by itself: after its deadline the system's fence records it FENCED, and a later delivery can never apply", async () => {
    const w = await seedWorld(t);
    const client = actingPartyFor(sessionOf(t.tenantId, w.client, "client"));
    const prep = await port.prepare(client, { kind: "appointment.create", slotId: w.slots[0] as string });
    const never = `vsp-${"5a".repeat(24)}`;
    const fresh: CommitSubject = { kind: "appointment.create", subjectId: w.client, target: prep.input.target, change: prep.input.change, expiresAt: new Date(Date.now() + 300_000).toISOString() };
    expect(await port.reconcileDecision(fresh, never)).toEqual({ outcome: "UNKNOWN", reasonCode: "NOT_VISIBLE_WITHIN_WINDOW" });
    expect(await port.lookup(fresh, never)).toEqual({ outcome: "UNKNOWN" });
    expect(await putsOf("change_requests.fence", requestIdFor(never))).toHaveLength(0);
    // Long past its deadline: the absence is proved by the system (FENCED), not by the time that passed.
    const late: CommitSubject = { ...fresh, expiresAt: new Date(Date.now() - (WRITE_TIMEOUT_MS + WINDOW_MS + 250 + 1_000)).toISOString() };
    expect(await port.reconcileDecision(late, never)).toEqual({ outcome: "NOT_FOUND", reasonCode: "REQUEST_FENCED" });
    expect(await t.admin.changeRequest(t.accountId, requestIdFor(never))).toMatchObject({ state: "FAILED", failure_code: "FENCED" });
    expect((await putsOf("change_requests.fence", requestIdFor(never))).map((r) => r.status)).toEqual([200]);
    // A delivery of the fenced request id (a write still on its way) is refused by the system: nothing is applied.
    expect(await port.commit(late, never)).toEqual({ outcome: "FAILED", reasonCode: "STATE_CHANGED", permanent: true });
    expect((await t.admin.effects(t.accountId)).filter((e) => e.requestId === requestIdFor(never))).toHaveLength(0);
    expect((await t.adapters.scheduling?.slot(w.slots[0] as string))?.state).toBe("OPEN");
    // The fence is idempotent: the decision stays NOT_FOUND.
    expect(await port.lookup(late, never)).toEqual({ outcome: "NOT_FOUND" });
  });

  it("[ACT-02][FO-03-09] a billing review commits once through the executor and the invoice reads IN_REVIEW", async () => {
    const w = await seedWorld(t);
    const client = actingPartyFor(sessionOf(t.tenantId, w.client, "client"));
    const prep = await port.prepare(client, { kind: "billing.review.submit", invoiceId: w.invoice, reasonCode: "CHARGE_QUESTIONED" });
    expect(prep.input.target.beforeVersion).toBe("i2");
    const { ctx, action } = await confirmed("client", w.client, prep);
    const receipt = await commitVia(ctx, action);
    expect(receipt.outcome).toBe("COMMITTED");
    expect((await t.adapters.billing?.invoice(w.invoice))?.status).toBe("IN_REVIEW");
    expect(await t.admin.effects(t.accountId, w.invoice)).toHaveLength(1);
    // A second review of a reviewed invoice is a stale preparation: refused, no second effect.
    await expect(port.prepare(client, { kind: "billing.review.submit", invoiceId: w.invoice, reasonCode: "CHARGE_QUESTIONED" })).rejects.toMatchObject({ reasonCode: "INVOICE_NOT_REVIEWABLE" });
  });

  it("[FO-03-09] the business layer's SchedulingCommitPort runs over the HTTP adapter unchanged; its key lookup never claims an absence", async () => {
    const w = await seedWorld(t);
    const scheduling = t.adapters.scheduling;
    if (!scheduling) throw new Error("scheduling composed");
    const business = new SchedulingCommitPort(scheduling);
    const slot = (await scheduling.slot(w.slots[2] as string)) ?? undefined;
    if (!slot) throw new Error("slot");
    const ctx = sessionOf(t.tenantId, w.client, "client");
    const prepared = await svc().prepare(
      ctx,
      {
        kind: "appointment.create",
        target: { system: "scheduling", recordType: "appointment_slot", recordRef: slot.slotId, beforeVersion: "slot.open" },
        change: { slotId: slot.slotId, toStartsAt: slot.startsAt, toTimeZone: slot.timeZone, toModality: slot.modality, providerName: slot.providerDisplayName },
        impact: { summaryTemplateId: "appointment.create_confirmation", fees: null, reversible: true },
        confirmationTemplateId: "appointment.create_confirmation",
        ttlSeconds: 300,
        requiresStepUp: false,
      },
      allowDecision(),
    );
    const { confirmation, integration } = dtmfConfirmation(ctx, prepared);
    const action = await svc().confirm(confirmation, integration);
    const receipt = await commitVia(ctx, action, business);
    expect(receipt.outcome).toBe("COMMITTED");
    // Without the action's expiry the port cannot prove an absence: an unseen key is UNKNOWN, never NOT_FOUND.
    await expect(business.lookup(action, `vsp-${"9f".repeat(24)}`)).rejects.toMatchObject({ outcome: "UNKNOWN" });
    // The domain port reads a business-prepared action's commit-time version in the business token: the slot is taken.
    expect(await port.currentVersion(action)).toBe("slot.unavailable");
  });
});
