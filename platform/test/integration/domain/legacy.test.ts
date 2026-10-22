/**
 * Layer 2 (WP-23; FO-06-75, ACT-02, ACT-03): a NON-idempotent downstream API behind the canonical contract. The
 * reference API's legacy product creates another appointment on every delivery; its supported reconciliation path
 * is the by-reference lookup, visible only after the account's documented window. The production executor and the
 * legacy adapter never retry a create after it may have been sent: an unknown outcome is reconciled by reference,
 * every create is sent only under the delivery's own reservation of the reference (the dispatch marker), and an
 * absence is never decided by time: only the product's reference fence, asked once the create's dispatch deadline
 * (expiry + write timeout) and the clock-skew allowance have passed, makes it definitive (FENCED: no create can ever
 * be stored under the reference). Commit latency after the deadline is covered by fence.test.ts.
 */
import { afterAll, beforeAll, describe, expect } from "vitest";
import type { PrepareInput, ProviderCommitPort } from "../../../src/actions/ports.js";
import { actingPartyFor } from "../../../src/domain/authority.js";
import { externalRefFor } from "../../../src/domain/legacy.js";
import type { HttpLegacyScheduling } from "../../../src/domain/legacy.js";
import { systemClock } from "../../../src/shared/clock.js";
import { createIntegrationDb } from "../_harness/clients.js";
import type { IntegrationDb } from "../_harness/clients.js";
import { layer2, layer2Context } from "../_harness/layer2.js";
import { ledgerReplica } from "../substrate/reference-sor.js";
import type { LedgerReplica } from "../substrate/reference-sor.js";
import { DOMAIN_SERVICES, allowDecision, createDomainPki, dtmfConfirmation, eventually, provisionTenant, seedWorld, sessionOf, sleep } from "./support.js";
import type { DomainPki, Tenant, World } from "./support.js";

const it = layer2(DOMAIN_SERVICES);

const WINDOW_MS = 1_500;
const WRITE_TIMEOUT_MS = 2_000;
const ZONE = "America/Denver";

let pki: DomainPki;
let t: Tenant;
let w: World;
let idb: IntegrationDb;
let ledger: LedgerReplica;
let legacy: HttpLegacyScheduling;

beforeAll(async () => {
  const l2 = layer2Context(DOMAIN_SERVICES);
  pki = createDomainPki();
  // The lookup lags the write by the whole documented window (the worst case the system allows).
  t = await provisionTenant(l2, pki, { systems: ["legacy"], timeZone: ZONE, visibilityWindowMs: WINDOW_MS, lookupLagMs: WINDOW_MS, writeTimeoutMs: WRITE_TIMEOUT_MS });
  w = await seedWorld(t, ZONE);
  idb = await createIntegrationDb(l2);
  // Short preparations, so that a create's dispatch deadline passes inside a test and the reference fence can be asked.
  ledger = ledgerReplica(idb.db, systemClock, "domain-legacy", { minPrepareTtlSeconds: 5 });
  if (!t.adapters.legacyScheduling) throw new Error("legacy composed");
  legacy = t.adapters.legacyScheduling;
}, 180_000);

afterAll(async () => {
  await t?.dispose();
  await idb?.drop();
  pki?.dispose();
});

const port = (): ProviderCommitPort => legacy;

async function confirmedCreate(startsAt: string, ttlSeconds = 300) {
  const party = actingPartyFor(sessionOf(t.tenantId, w.client, "client"));
  const prep = legacy.prepareCreate(party, { providerRef: w.provider, startsAt, modality: "phone" });
  const ctx = sessionOf(t.tenantId, w.client, "client");
  const input: PrepareInput = { ...prep, ttlSeconds };
  const prepared = await ledger.service.prepare(ctx, input, allowDecision());
  const { confirmation, integration } = dtmfConfirmation(ctx, prepared);
  return { ctx, action: await ledger.service.confirm(confirmation, integration) };
}

const commit = (ctx: ReturnType<typeof sessionOf>, action: { actionId: string; digest: string }) =>
  ledger.service.commit(ctx, { actionId: action.actionId, digest: action.digest }, { reauthorize: async () => allowDecision(), provider: port() });

const keyOf = async (actionId: string): Promise<string> => {
  const d = await ledger.service.describe?.(t.tenantId, actionId);
  if (!d) throw new Error("ledger entry");
  return d.providerIdempotencyKey;
};

/** Appointments the legacy POST actually created: the system's append-only effect log (one row per processed POST). */
const created = async () => (await t.admin.effects(t.accountId)).filter((e) => e.operation === "legacy.appointment.post").length;
const refused503 = async () => (await t.admin.requests(t.accountId)).filter((r) => r.operation === "legacy.appointment.post" && r.status === 503).length;
const createdWith = async (ref: string) => (await legacy.byReference(ref)).length;

const at = (days: number, hour: number): string => {
  const d = new Date(Date.now() + days * 86_400_000);
  d.setUTCHours(hour, 30, 0, 0);
  return d.toISOString();
};

describe("non-idempotent legacy create behind the canonical contract (Layer 2)", () => {
  it("[FO-06-75][FO-06-74][ACT-02] a confirmed create commits once; the tenant's wall-clock times map through the profile's zone table", async () => {
    const startsAt = at(4, 16);
    const { ctx, action } = await confirmedCreate(startsAt);
    const receipt = await commit(ctx, action);
    expect(receipt.outcome).toBe("COMMITTED");
    const ref = externalRefFor(await keyOf(action.actionId));
    await eventually(async () => (await createdWith(ref)) === 1, WINDOW_MS + 3_000);
    const [appt] = await legacy.byReference(ref);
    // The system stored a local wall-clock time in America/Denver; the DSL zone table maps it back to the instant.
    expect(appt?.startsAt).toBe(startsAt);
    expect(appt?.timeZone).toBe(ZONE);
    expect(appt).toMatchObject({ subjectId: w.client, providerRef: w.provider, status: "SCHEDULED", modality: "phone" });
  });

  it("[ACT-03][FO-06-75] a timeout after the create was sent is never retried: UNKNOWN until the reference is visible, then COMMITTED with exactly one appointment", async () => {
    const { ctx, action } = await confirmedCreate(at(5, 15));
    await t.admin.arm(t.accountId, { operation: "legacy.appointment.post", kind: "COMMIT_THEN_DELAY", delayMs: WRITE_TIMEOUT_MS + 1_500, times: 1 });
    const createdBefore = await created();
    const first = await commit(ctx, action);
    expect(first.outcome).toBe("UNKNOWN");
    expect((await t.admin.faults(t.accountId)).find((f) => f.kind === "COMMIT_THEN_DELAY")?.hits).toBe(1);
    const ref = externalRefFor(await keyOf(action.actionId));
    // Inside the window the reference is not visible yet: the executor's second commit reconciles (lookup only).
    const second = await commit(ctx, action);
    expect(second.outcome === "UNKNOWN" || second.outcome === "COMMITTED").toBe(true);
    await eventually(async () => (await createdWith(ref)) === 1, WINDOW_MS + 5_000);
    const reconciled = await ledger.service.reconcile(action.actionId, port(), t.tenantId);
    expect(reconciled.outcome).toBe("COMMITTED");
    // Exactly one POST was processed for this action (each processed POST creates an appointment); one carries the reference.
    await sleep(WRITE_TIMEOUT_MS);
    expect((await created()) - createdBefore).toBe(1);
    expect(await createdWith(ref)).toBe(1);
    await t.admin.clearFaults(t.accountId);
  });

  it("[ACT-03][FO-06-75] a create answered 503 is UNKNOWN (it may have been processed); NOT_FOUND only from the reference fence after its deadline (FENCED), never a blind retry", async () => {
    const { ctx, action } = await confirmedCreate(at(6, 17), 5);
    await t.admin.arm(t.accountId, { operation: "legacy.appointment.post", kind: "HTTP_STATUS", status: 503, retryAfterSeconds: 0, times: 1 });
    const createdBefore = await created();
    const refusedBefore = await refused503();
    const first = await commit(ctx, action);
    expect(first.outcome).toBe("UNKNOWN");
    const key = await keyOf(action.actionId);
    // Fresh action: absence is not definitive.
    expect(await legacy.lookup(action, key)).toEqual({ outcome: "UNKNOWN" });
    // Past the deadline (expiry + write timeout) + skew, the lookup asks the product's fence: the reservation whose
    // create was refused is FENCED, so no create can ever be stored under the reference: only then NOT_FOUND.
    const fencesBefore = (await t.admin.requests(t.accountId)).filter((r) => r.operation === "legacy.reference.fence").length;
    await sleep(5_000 + WRITE_TIMEOUT_MS + 250 + 500);
    expect(await legacy.lookup(action, key)).toEqual({ outcome: "NOT_FOUND" });
    expect((await t.admin.requests(t.accountId)).filter((r) => r.operation === "legacy.reference.fence").length - fencesBefore).toBe(1);
    expect(await t.admin.legacyReference(t.accountId, externalRefFor(key))).toMatchObject({ state: "FENCED" });
    const reconciled = await ledger.service.reconcileWithResult?.(t.tenantId, action.actionId, port());
    expect(reconciled?.result).toBe("NOT_FOUND");
    expect(["EXPIRED", "CONFIRMED"]).toContain((await ledger.service.describe?.(t.tenantId, action.actionId))?.state);
    // Exactly one POST (the refused one, never retried) and no appointment under the reference.
    expect((await refused503()) - refusedBefore).toBe(1);
    expect((await created()) - createdBefore).toBe(0);
    expect(await createdWith(externalRefFor(key))).toBe(0);
    // A late delivery of the same key can never create under the fenced reference (refused before any POST).
    const postsBefore = (await t.admin.requests(t.accountId)).filter((r) => r.operation === "legacy.appointment.post").length;
    expect(await legacy.commit(action, key)).toEqual({ outcome: "FAILED", reasonCode: "REQUEST_FENCED", permanent: true });
    expect((await t.admin.requests(t.accountId)).filter((r) => r.operation === "legacy.appointment.post").length).toBe(postsBefore);
    // The caller re-confirms a new action: it creates exactly one appointment.
    const again = await confirmedCreate(at(6, 17));
    expect((await commit(again.ctx, again.action)).outcome).toBe("COMMITTED");
    await eventually(async () => (await createdWith(externalRefFor(await keyOf(again.action.actionId)))) === 1, WINDOW_MS + 3_000);
    expect((await created()) - createdBefore).toBe(1);
  });

  it("[ACT-02][FO-06-75] a redelivery of a committed create, once its reference is visible, returns the earlier appointment without a second POST", async () => {
    const { ctx, action } = await confirmedCreate(at(8, 15));
    expect((await commit(ctx, action)).outcome).toBe("COMMITTED");
    const key = await keyOf(action.actionId);
    const ref = externalRefFor(key);
    await eventually(async () => (await createdWith(ref)) === 1, WINDOW_MS + 3_000);
    const posts = async () => (await t.admin.requests(t.accountId)).filter((r) => r.operation === "legacy.appointment.post").length;
    const postsBefore = await posts();
    const createdBefore = await created();
    // The same commit delivered again to the port (a second replica, a retried message) with the same key.
    const [appt] = await legacy.byReference(ref);
    const again = await port().commit(action, key);
    expect(again).toMatchObject({ outcome: "COMMITTED", providerReference: appt?.appointmentId });
    expect(await posts()).toBe(postsBefore);
    expect(await created()).toBe(createdBefore);
    expect(await createdWith(ref)).toBe(1);
  });

  it("[AUTH-02] a provider cannot book a client into the legacy product (provider approval is not client consent)", () => {
    const provider = actingPartyFor(sessionOf(t.tenantId, w.provider, "provider"));
    expect(() => legacy.prepareCreate(provider, { providerRef: w.provider, startsAt: at(7, 15), modality: "video" })).toThrow(expect.objectContaining({ reasonCode: "PROVIDER_APPROVAL_IS_NOT_CLIENT_CONSENT" }));
  });
});
