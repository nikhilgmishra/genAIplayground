/**
 * Layer 2 (WP-23; FO-03-09, FO-06-75, FO-11-02, FO-01-25; ACT-02, ACT-03, AUTH-02): the irreversible cancellation
 * write (`scheduling.cancellation.put`) through the PRODUCTION action executor (LedgerActionService on postgres:16)
 * and the domain commit port over the reference business API: a client's cancellation commits once with the
 * system's receipt, reads back CANCELLED and verifies; a redelivery replays; a timeout after send is reconciled by
 * key without a second effect; a provider-approved cancellation stays on the provider's own schedule and another
 * provider is refused by the system of record itself. Effects come from the system's append-only effect log, writes
 * from its request log. SYNTHETIC data only.
 */
import { afterAll, beforeAll, describe, expect } from "vitest";
import type { PrepareInput } from "../../../src/actions/ports.js";
import { actingPartyFor } from "../../../src/domain/authority.js";
import { requestIdFor } from "../../../src/domain/changes.js";
import type { CommitSubject, DomainCommitPort, DomainPreparation } from "../../../src/domain/commit.js";
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

const WRITE_TIMEOUT_MS = 2_000;

let pki: DomainPki;
let t: Tenant;
let idb: IntegrationDb;
let ledger: LedgerReplica;
let port: DomainCommitPort;

beforeAll(async () => {
  const l2 = layer2Context(DOMAIN_SERVICES);
  pki = createDomainPki();
  t = await provisionTenant(l2, pki, { systems: ["scheduling"], writeTimeoutMs: WRITE_TIMEOUT_MS });
  idb = await createIntegrationDb(l2);
  ledger = ledgerReplica(idb.db, systemClock, "domain-cancel");
  if (!t.adapters.commitPort) throw new Error("commit port composed");
  port = t.adapters.commitPort;
}, 180_000);

afterAll(async () => {
  await t?.dispose();
  await idb?.drop();
  pki?.dispose();
});

async function confirmed(role: "client" | "provider", partyRef: string, prep: DomainPreparation): Promise<{ ctx: ReturnType<typeof sessionOf>; action: PreparedAction }> {
  if (prep.ledgerKind === null) throw new Error("ledger kind expected");
  const ctx = sessionOf(t.tenantId, partyRef, role);
  const prepared = await ledger.service.prepare(ctx, { ...prep.input, kind: prep.ledgerKind } as PrepareInput, allowDecision());
  const { confirmation, integration } = dtmfConfirmation(ctx, prepared);
  return { ctx, action: await ledger.service.confirm(confirmation, integration) };
}

const commitVia = (ctx: ReturnType<typeof sessionOf>, action: PreparedAction) => ledger.service.commit(ctx, { actionId: action.actionId, digest: action.digest }, { reauthorize: async () => allowDecision(), provider: port });
const keyOf = async (action: PreparedAction): Promise<string> => (await ledger.service.describe?.(t.tenantId, action.actionId))?.providerIdempotencyKey ?? "";
const cancellations = async (appointmentId: string) => (await t.admin.effects(t.accountId, appointmentId)).filter((e) => e.operation === "scheduling.cancellation.put");
const putsOf = async (key: string) => (await t.admin.requests(t.accountId)).filter((r) => r.operation === "scheduling.cancellation.put" && r.keyRef === requestIdFor(key));

describe("the cancellation write through the executor (Layer 2)", () => {
  it("[ACT-02][FO-03-09][FO-11-02] a client's cancellation commits once with the system's receipt, reads CANCELLED, verifies by read-back; a redelivery replays with one effect", async () => {
    const w = await seedWorld(t);
    const client = actingPartyFor(sessionOf(t.tenantId, w.client, "client"));
    const prep = await port.prepare(client, { kind: "appointment.cancel", appointmentId: w.appointment, reasonCode: "CLIENT_REQUEST" });
    expect(prep).toMatchObject({ ledgerKind: "appointment.cancel", input: { target: { recordRef: w.appointment, beforeVersion: "a3" }, change: { authority: "CLIENT_CONFIRMED", actingPartyRef: w.client, reasonCode: "CLIENT_REQUEST" } } });
    const { ctx, action } = await confirmed("client", w.client, prep);
    const receipt = await commitVia(ctx, action);
    expect(receipt.outcome).toBe("COMMITTED");
    const key = await keyOf(action);
    // The receipt is the system's own (its change record's receipt id), on the confirmed record and version.
    const stored = await t.admin.changeRequest(t.accountId, requestIdFor(key));
    expect(stored).toMatchObject({ state: "COMPLETED", failure_code: null, resource_id: w.appointment });
    expect(receipt.providerReference).toBe(stored?.receipt_id);
    const effects = await cancellations(w.appointment);
    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({ requestId: requestIdFor(key), beforeVersion: "3", afterVersion: "4" });
    expect((await t.adapters.scheduling?.appointment(w.appointment))?.status).toBe("CANCELLED");
    // A redelivery of the same commit with the same key replays: the same receipt, no second effect.
    const again = await port.commit(action, key);
    expect(again).toMatchObject({ outcome: "COMMITTED", providerReference: receipt.providerReference, evidence: { appointmentId: w.appointment, status: "CANCELLED" } });
    expect(await cancellations(w.appointment)).toHaveLength(1);
    expect((await putsOf(key)).map((r) => r.status)).toEqual([200, 200]);
    // Independent effect verification: the record and the system's receipt read back.
    if (again.outcome !== "COMMITTED") return;
    const v = await port.verifyEffect({ tenantId: t.tenantId, actionId: action.actionId, causationId: action.actionId, commitReceiptId: null, action, receipt: { providerReference: again.providerReference, afterVersion: again.afterVersion, evidence: again.evidence, committedAt: new Date().toISOString() } });
    expect(v.result).toBe("VERIFIED");
    // A second cancellation of a cancelled appointment is a stale preparation: refused, no second effect.
    await expect(port.prepare(client, { kind: "appointment.cancel", appointmentId: w.appointment, reasonCode: "CLIENT_REQUEST" })).rejects.toMatchObject({ reasonCode: "APPOINTMENT_NOT_CANCELLABLE" });
  });

  it("[ACT-03][FO-06-75] a cancellation whose response is held past the write timeout (applied at the system) is UNKNOWN, then reconciled by key: COMMITTED, one effect, the write sent once", async () => {
    const w = await seedWorld(t);
    const client = actingPartyFor(sessionOf(t.tenantId, w.client, "client"));
    const prep = await port.prepare(client, { kind: "appointment.cancel", appointmentId: w.appointment, reasonCode: "SCHEDULING_CONFLICT" });
    const { ctx, action } = await confirmed("client", w.client, prep);
    await t.admin.arm(t.accountId, { operation: "scheduling.cancellation.put", kind: "COMMIT_THEN_DELAY", delayMs: WRITE_TIMEOUT_MS + 2_000, times: 1 });
    expect((await commitVia(ctx, action)).outcome).toBe("UNKNOWN");
    expect((await t.admin.faults(t.accountId)).find((f) => f.kind === "COMMIT_THEN_DELAY")?.hits).toBe(1);
    expect((await ledger.service.describe?.(t.tenantId, action.actionId))?.state).toBe("UNKNOWN");
    const key = await keyOf(action);
    // Reconciliation by key (never a blind retry): the applied cancellation with its receipt.
    const rec = await ledger.service.reconcileWithResult?.(t.tenantId, action.actionId, port);
    expect(rec?.result).toBe("COMMITTED");
    expect((await ledger.service.describe?.(t.tenantId, action.actionId))?.state).toBe("COMMITTED");
    expect(await cancellations(w.appointment)).toHaveLength(1);
    expect((await t.adapters.scheduling?.appointment(w.appointment))?.status).toBe("CANCELLED");
    // The write reached the system once; the reconciliation only read (a lookup by key, never a second PUT). The
    // first PUT's response was abandoned by the client, and the request log records delivered responses only, so
    // that one PUT may or may not be listed: never more than it.
    expect(await t.admin.changeRequest(t.accountId, requestIdFor(key))).toMatchObject({ state: "COMPLETED", resource_id: w.appointment });
    const forKey = (await t.admin.requests(t.accountId)).filter((r) => r.keyRef === requestIdFor(key));
    expect(forKey.some((r) => r.operation === "change_requests.get" && r.status === 200)).toBe(true);
    expect((await putsOf(key)).length).toBeLessThanOrEqual(1);
    await t.admin.clearFaults(t.accountId);
  });

  it("[AUTH-02][FO-01-25] a provider-approved cancellation on the provider's own schedule commits through the executor; another provider is refused by the system of record (403, no effect)", async () => {
    const w = await seedWorld(t);
    const provider = actingPartyFor(sessionOf(t.tenantId, w.provider, "provider"));
    const prep = await port.prepare(provider, { kind: "provider.appointment.cancel", appointmentId: w.otherAppointment, reasonCode: "PROVIDER_UNAVAILABLE" });
    expect(prep).toMatchObject({ ledgerKind: "appointment.cancel", input: { confirmationTemplateId: "provider.appointment.cancel_confirmation", change: { authority: "PROVIDER_APPROVED", actingPartyRef: w.provider } } });
    // Another provider's forged action on the same appointment (its own party, its own authority): the system says no.
    const forged: CommitSubject = { kind: "appointment.cancel", subjectId: w.otherProvider, target: prep.input.target, change: { ...prep.input.change, actingPartyRef: w.otherProvider }, expiresAt: new Date(Date.now() + 60_000).toISOString() };
    expect(await port.commit(forged, `vsp-${"c3".repeat(24)}`)).toEqual({ outcome: "FAILED", reasonCode: "AUTHORITY_REFUSED", permanent: true });
    expect(await cancellations(w.otherAppointment)).toHaveLength(0);
    expect((await t.admin.requests(t.accountId)).filter((r) => r.operation === "scheduling.cancellation.put" && r.keyRef === requestIdFor(`vsp-${"c3".repeat(24)}`)).map((r) => r.status)).toEqual([403]);
    // The provider's own cancellation, confirmed with the provider template, commits once.
    const { ctx, action } = await confirmed("provider", w.provider, prep);
    const receipt = await commitVia(ctx, action);
    expect(receipt.outcome).toBe("COMMITTED");
    const effects = await cancellations(w.otherAppointment);
    expect(effects).toHaveLength(1);
    expect(effects[0]?.requestId).toBe(requestIdFor(await keyOf(action)));
    expect((await t.adapters.scheduling?.appointment(w.otherAppointment))?.status).toBe("CANCELLED");
  });
});
