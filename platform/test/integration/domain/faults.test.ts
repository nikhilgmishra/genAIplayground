/**
 * Layer 2 (WP-23): the domain faults of the FO-17-24 fault matrix at their injection points, over the production
 * domain adapters, connector runtime, TLS transport and action executor against the reference business API.
 * Each test proves reach from the system of record's side (endpoint counters, fault hit counters, request and
 * effect logs) and asserts the postconditions of the fault plan (scenarios/fixtures/failures/<ID>.json):
 *   SCHEDULING_UNAVAILABLE  connections refused for the duration: nothing sent, nothing committed, honest next step;
 *   BILLING_TIMEOUT         the billing API times out before sending: safe to retry, bounded, then succeeds once;
 *   CLAIMS_TIMEOUT          the claims API times out before the request is sent (the plan's reach evidence:
 *                           TIMEOUT_BEFORE_SEND): exactly first attempt + retry budget, honest unavailability, no
 *                           guessed status; a timeout reading the response (READ_TIMEOUT) is covered as a variant;
 *   PROVIDER_API_TIMEOUT    the provider network API times out before send: exactly first attempt + retry budget per
 *                           read, honest unavailability, no partial status;
 *   PARTIAL_WRITE           step 1 applied, step 2 failed: UNKNOWN, reconciled by key (completion of step 2), a
 *                           durable reconciliation record, exactly one effect.
 * Every test provisions its own tenant (own endpoints, own connector runtimes and breakers) so a fault never leaks.
 */
import { afterAll, afterEach, beforeAll, describe, expect } from "vitest";
import type { PrepareInput } from "../../../src/actions/ports.js";
import { actingPartyFor } from "../../../src/domain/authority.js";
import { requestIdFor } from "../../../src/domain/changes.js";
import type { DomainPreparation } from "../../../src/domain/commit.js";
import { DependencyError } from "../../../src/shared/errors.js";
import { systemClock } from "../../../src/shared/clock.js";
import { createIntegrationDb } from "../_harness/clients.js";
import type { IntegrationDb } from "../_harness/clients.js";
import type { Layer2Context } from "../_harness/layer2.js";
import { layer2, layer2Context } from "../_harness/layer2.js";
import { ledgerReplica } from "../substrate/reference-sor.js";
import type { LedgerReplica } from "../substrate/reference-sor.js";
import { DOMAIN_SERVICES, allowDecision, createDomainPki, dtmfConfirmation, provisionTenant, seedWorld, sessionOf } from "./support.js";
import type { DomainPki, Tenant, TenantOptions } from "./support.js";

const it = layer2(DOMAIN_SERVICES);

let pki: DomainPki;
let idb: IntegrationDb;
let ledger: LedgerReplica;
let l2ctx: Layer2Context;
const tenants: Tenant[] = [];

beforeAll(async () => {
  l2ctx = layer2Context(DOMAIN_SERVICES);
  pki = createDomainPki();
  idb = await createIntegrationDb(l2ctx);
  ledger = ledgerReplica(idb.db, systemClock, "domain-faults");
}, 120_000);

afterEach(async () => {
  for (const t of tenants.splice(0)) await t.dispose();
});

afterAll(async () => {
  await idb?.drop();
  pki?.dispose();
});

async function tenant(o: TenantOptions): Promise<Tenant> {
  const t = await provisionTenant(l2ctx, pki, o);
  tenants.push(t);
  return t;
}

async function confirmed(t: Tenant, partyRef: string, prep: DomainPreparation) {
  if (prep.ledgerKind === null) throw new Error("ledger kind expected");
  const ctx = sessionOf(t.tenantId, partyRef, "client");
  const input: PrepareInput = { ...prep.input, kind: prep.ledgerKind };
  const prepared = await ledger.service.prepare(ctx, input, allowDecision());
  const { confirmation, integration } = dtmfConfirmation(ctx, prepared);
  return { ctx, action: await ledger.service.confirm(confirmation, integration) };
}

const elapsed = async <T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> => {
  const started = Date.now();
  const value = await fn();
  return { value, ms: Date.now() - started };
};

describe("domain faults at their injection points (Layer 2)", () => {
  it("[FAULT:SCHEDULING_UNAVAILABLE] connections refused: reads are UNAVAILABLE before sending with a human/callback next step; a commit is NOT_STARTED and nothing is written", async () => {
    const t = await tenant({ systems: ["scheduling"], readTimeoutMs: 1_000 });
    const w = await seedWorld(t);
    const s = t.adapters.scheduling;
    const port = t.adapters.commitPort;
    if (!s || !port) throw new Error("scheduling composed");
    const client = actingPartyFor(sessionOf(t.tenantId, w.client, "client"));
    const prep = await port.prepare(client, { kind: "appointment.reschedule", appointmentId: w.appointment, slotId: w.slots[0] as string });
    const { ctx, action } = await confirmed(t, w.client, prep);
    const before = (await t.admin.requests(t.accountId)).length;
    const ep = t.endpoints.scheduling;
    if (!ep) throw new Error("endpoint");
    await t.admin.setMode(ep.endpointId, "REFUSE_CONNECTIONS");

    // A refused connection is invisible to the system (its listener is closed): the attempts are counted by the
    // platform's transport, independently of the adapter's answer (failed before anything was sent).
    const refusedBefore = t.metrics.counterValue("vsp_connector_http_requests_total", { result: "failed_before_send" });
    const read = await s.readSlotOptions(client, { appointmentId: w.appointment, days: 14 });
    expect(read).toMatchObject({ status: "UNAVAILABLE", outcome: "NOT_STARTED", nextStep: "OFFER_HUMAN_OR_CALLBACK" });
    if (read.status === "UNAVAILABLE") expect(read.reasonCode).toBe("CONNECTION_REFUSED");
    // Bounded: the first attempt plus the profile's retry budget (1), no more.
    expect(t.metrics.counterValue("vsp_connector_http_requests_total", { result: "failed_before_send" }) - refusedBefore).toBe(2);
    const commit = await ledger.service.commit(ctx, { actionId: action.actionId, digest: action.digest }, { reauthorize: async () => allowDecision(), provider: port }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(commit).toBeInstanceOf(DependencyError);
    expect((commit as DependencyError).outcome).toBe("NOT_STARTED");
    // Reach: the endpoint was switched to refusing once, and nothing reached the system of record during the window.
    expect((await t.admin.endpoint(ep.endpointId)).refusedWindows).toBe(1);
    expect(t.metrics.counterValue("vsp_connector_http_requests_total", { result: "failed_before_send" }) - refusedBefore).toBeGreaterThan(2);
    expect((await t.admin.requests(t.accountId)).length).toBe(before);
    expect(await t.admin.effects(t.accountId, w.appointment)).toHaveLength(0);
    expect((await ledger.service.describe?.(t.tenantId, action.actionId))?.state).toBe("CONFIRMED");

    // Recovery: the same confirmed action commits once with the same key.
    await t.admin.setMode(ep.endpointId, "NORMAL");
    const receipt = await ledger.service.commit(ctx, { actionId: action.actionId, digest: action.digest }, { reauthorize: async () => allowDecision(), provider: port });
    expect(receipt.outcome).toBe("COMMITTED");
    expect(await t.admin.effects(t.accountId, w.appointment)).toHaveLength(1);
  });

  it("[FAULT:BILLING_TIMEOUT] the billing API times out before sending: a bounded retry, honest unavailability, a commit returns to CONFIRMED and later commits exactly once", async () => {
    const t = await tenant({ systems: ["billing"], readTimeoutMs: 700, retryBudget: 1 });
    const w = await seedWorld(t);
    const b = t.adapters.billing;
    const port = t.adapters.commitPort;
    if (!b || !port) throw new Error("billing composed");
    const client = actingPartyFor(sessionOf(t.tenantId, w.client, "client"));
    // Warm the token (the token endpoint is on the same host), prepare while the system answers.
    const prep = await port.prepare(client, { kind: "billing.review.submit", invoiceId: w.invoice, reasonCode: "AMOUNT_QUESTIONED" });
    const { ctx, action } = await confirmed(t, w.client, prep);
    const ep = t.endpoints.billing;
    if (!ep) throw new Error("endpoint");
    await t.admin.setMode(ep.endpointId, "STALL_HANDSHAKE");

    const { value: read, ms } = await elapsed(() => b.readInvoices(client));
    expect(read).toMatchObject({ status: "UNAVAILABLE", reasonCode: "TIMEOUT_BEFORE_SEND", outcome: "NOT_STARTED", nextStep: "OFFER_HUMAN_OR_CALLBACK" });
    // Bounded: the first attempt plus the profile's retry budget, each within the operation timeout.
    const stalledAfterRead = (await t.admin.endpoint(ep.endpointId)).stalled;
    expect(stalledAfterRead).toBe(2);
    expect(ms).toBeLessThan(2 * 700 + 2_000);
    const commit = await ledger.service.commit(ctx, { actionId: action.actionId, digest: action.digest }, { reauthorize: async () => allowDecision(), provider: port }).then(
      () => null,
      (e: unknown) => e,
    );
    expect((commit as DependencyError).outcome).toBe("NOT_STARTED");
    expect((await t.admin.endpoint(ep.endpointId)).stalled).toBeGreaterThan(stalledAfterRead);
    expect(await t.admin.effects(t.accountId, w.invoice)).toHaveLength(0);
    expect((await ledger.service.describe?.(t.tenantId, action.actionId))?.state).toBe("CONFIRMED");

    await t.admin.setMode(ep.endpointId, "NORMAL");
    expect((await ledger.service.commit(ctx, { actionId: action.actionId, digest: action.digest }, { reauthorize: async () => allowDecision(), provider: port })).outcome).toBe("COMMITTED");
    expect(await t.admin.effects(t.accountId, w.invoice)).toHaveLength(1);
    expect((await b.invoice(w.invoice))?.status).toBe("IN_REVIEW");
  });

  it("[FAULT:CLAIMS_TIMEOUT] the claims API times out before the request is sent: exactly first attempt + retry budget, UNAVAILABLE with a next step, never a guessed status", async () => {
    const t = await tenant({ systems: ["claims"], readTimeoutMs: 600, retryBudget: 1 });
    const w = await seedWorld(t);
    const c = t.adapters.claims;
    if (!c) throw new Error("claims composed");
    const client = actingPartyFor(sessionOf(t.tenantId, w.client, "client"));
    // Warm the token while the system answers (the token endpoint is on the same host).
    expect((await c.readClaims(client)).status).toBe("AVAILABLE");
    const ep = t.endpoints.claims;
    if (!ep) throw new Error("endpoint");
    const requestsBefore = (await t.admin.requests(t.accountId)).length;
    await t.admin.setMode(ep.endpointId, "STALL_HANDSHAKE");
    const { value: read, ms } = await elapsed(() => c.readClaims(client));
    expect(read).toMatchObject({ status: "UNAVAILABLE", reasonCode: "TIMEOUT_BEFORE_SEND", outcome: "NOT_STARTED", nextStep: "OFFER_HUMAN_OR_CALLBACK" });
    // Reach and bound, from the system's side: two held connections (first attempt + retry budget 1), no request.
    expect((await t.admin.endpoint(ep.endpointId)).stalled).toBe(2);
    expect((await t.admin.requests(t.accountId)).length).toBe(requestsBefore);
    expect(ms).toBeGreaterThanOrEqual(2 * 600 - 50);
    expect(ms).toBeLessThan(2 * 600 + 1_500);
    expect(JSON.stringify(read)).not.toContain("IN_PROCESS");
    await t.admin.setMode(ep.endpointId, "NORMAL");
    expect((await c.readClaim(client, w.claim)).status).toBe("AVAILABLE");
  });

  it("[FO-17-24] claims variant: a timeout reading the response (sent, processed, held) is bounded too and READ_TIMEOUT, never a guessed status", async () => {
    const t = await tenant({ systems: ["claims"], readTimeoutMs: 600, retryBudget: 1 });
    const w = await seedWorld(t);
    const c = t.adapters.claims;
    if (!c) throw new Error("claims composed");
    const client = actingPartyFor(sessionOf(t.tenantId, w.client, "client"));
    expect((await c.readClaims(client)).status).toBe("AVAILABLE");
    await t.admin.arm(t.accountId, { operation: "claims.*", kind: "DELAY_RESPONSE", delayMs: 1_500 });
    const { value: read, ms } = await elapsed(() => c.readClaims(client));
    expect(read).toMatchObject({ status: "UNAVAILABLE", outcome: "FAILED", nextStep: "OFFER_HUMAN_OR_CALLBACK" });
    if (read.status === "UNAVAILABLE") expect(read.reasonCode).toBe("READ_TIMEOUT");
    // Reach and bound: the system received and processed both attempts (first + retry budget), no more.
    const fault = (await t.admin.faults(t.accountId)).find((f) => f.kind === "DELAY_RESPONSE");
    expect(fault?.hits).toBe(2);
    expect(ms).toBeLessThan(2 * 600 + 2_000);
    expect(JSON.stringify(read)).not.toContain("IN_PROCESS");
    await t.admin.clearFaults(t.accountId);
    expect((await c.readClaim(client, w.claim)).status).toBe("AVAILABLE");
  });

  it("[FAULT:PROVIDER_API_TIMEOUT] the provider network API times out before send: exactly first attempt + retry budget per read, onboarding and remittance UNAVAILABLE, nothing partial is reported", async () => {
    const t = await tenant({ systems: ["provider"], readTimeoutMs: 600, retryBudget: 1 });
    const w = await seedWorld(t);
    const p = t.adapters.provider;
    if (!p) throw new Error("provider composed");
    const party = actingPartyFor(sessionOf(t.tenantId, w.provider, "provider"));
    expect((await p.readOnboarding(party)).status).toBe("AVAILABLE");
    const ep = t.endpoints.provider;
    if (!ep) throw new Error("endpoint");
    const requestsBefore = (await t.admin.requests(t.accountId)).length;
    await t.admin.setMode(ep.endpointId, "STALL_HANDSHAKE");
    const { value: read, ms } = await elapsed(() => p.readOnboarding(party));
    expect(read).toMatchObject({ status: "UNAVAILABLE", reasonCode: "TIMEOUT_BEFORE_SEND", outcome: "NOT_STARTED", nextStep: "OFFER_HUMAN_OR_CALLBACK" });
    expect((await t.admin.endpoint(ep.endpointId)).stalled).toBe(2);
    expect(ms).toBeGreaterThanOrEqual(2 * 600 - 50);
    expect(ms).toBeLessThan(2 * 600 + 1_500);
    const started = Date.now();
    await expect(p.listRemittances({ practiceId: w.practice, fromDate: "2026-01-01", toDate: "2026-12-31" })).rejects.toMatchObject({ reasonCode: "TIMEOUT_BEFORE_SEND" });
    expect(Date.now() - started).toBeLessThan(2 * 600 + 1_500);
    // Bounded per read: two more held connections, never more; no request reached the system.
    expect((await t.admin.endpoint(ep.endpointId)).stalled).toBe(4);
    expect((await t.admin.requests(t.accountId)).length).toBe(requestsBefore);
    await t.admin.setMode(ep.endpointId, "NORMAL");
    expect((await p.readOnboarding(party)).status).toBe("AVAILABLE");
  });

  it("[FAULT:PARTIAL_WRITE][ACT-02][ACT-03] step 1 applied, step 2 failed: UNKNOWN, reconciled by key with the completion of step 2, one effect, a durable reconciliation record", async () => {
    const t = await tenant({ systems: ["scheduling"] });
    const w = await seedWorld(t);
    const port = t.adapters.commitPort;
    if (!port) throw new Error("scheduling composed");
    const client = actingPartyFor(sessionOf(t.tenantId, w.client, "client"));
    const prep = await port.prepare(client, { kind: "appointment.create", slotId: w.slots[0] as string });
    const { ctx, action } = await confirmed(t, w.client, prep);
    await t.admin.arm(t.accountId, { operation: "scheduling.booking.put", kind: "PARTIAL_WRITE", times: 1 });
    const first = await ledger.service.commit(ctx, { actionId: action.actionId, digest: action.digest }, { reauthorize: async () => allowDecision(), provider: port });
    expect(first.outcome).toBe("UNKNOWN");
    expect((await t.admin.faults(t.accountId)).find((f) => f.kind === "PARTIAL_WRITE")?.hits).toBe(1);
    const key = (await ledger.service.describe?.(t.tenantId, action.actionId))?.providerIdempotencyKey;
    if (!key) throw new Error("key");
    // Step 1 is at the system of record (the slot is booked), the change request is incomplete (no receipt).
    expect((await t.adapters.scheduling?.slot(w.slots[0] as string))?.state).toBe("BOOKED");
    const reconciled = await ledger.service.reconcileWithResult?.(t.tenantId, action.actionId, port);
    expect(reconciled?.result).toBe("COMMITTED");
    expect(reconciled?.receipt?.outcome).toBe("COMMITTED");
    expect((await ledger.service.latestReconciliation?.(t.tenantId, action.actionId))?.result).toBe("COMMITTED");
    const effects = (await t.admin.effects(t.accountId)).filter((e) => e.requestId === requestIdFor(key));
    expect(effects).toHaveLength(1);
    // The write itself was sent once; the completion carried step 2 only.
    const sent = (await t.admin.requests(t.accountId)).filter((r) => r.keyRef === requestIdFor(key));
    expect(sent.filter((r) => r.operation === "scheduling.booking.put")).toHaveLength(1);
    expect(sent.filter((r) => r.operation === "change_requests.complete")).toHaveLength(1);
    expect((await ledger.service.describe?.(t.tenantId, action.actionId))?.state).toBe("COMMITTED");
  });
});
