/**
 * Layer 2 (WP-23; FO-06-75, ACT-02, ACT-03): crash after commit, per adapter (scheduling, billing, legacy).
 *
 * A child process (crash-child.ts) composes the production domain adapters of this file's tenant and commits a
 * confirmed action through the production LedgerActionService on postgres:16. The reference business API holds
 * the response after it applied and finalized the change (COMMIT_THEN_DELAY); as soon as the system's own effect
 * log shows the effect, the child is SIGKILLed: the platform process died after the commit and before the ledger
 * recorded it (COMMITTING). A fresh replica, once the commit slot is stale, reconciles by the same key: COMMITTED
 * once, never committed again, exactly one effect at the system of record. The legacy (non-idempotent) product is
 * reconciled by its reference only. SYNTHETIC data only.
 */
import { afterAll, beforeAll, describe, expect } from "vitest";
import type { PrepareInput, ProviderCommitPort } from "../../../src/actions/ports.js";
import { actingPartyFor } from "../../../src/domain/authority.js";
import { requestIdFor } from "../../../src/domain/changes.js";
import { externalRefFor } from "../../../src/domain/legacy.js";
import type { PreparedAction } from "../../../src/protocol/index.js";
import { FakeClock, systemClock } from "../../../src/shared/clock.js";
import { createIntegrationDb, postgresUrl } from "../_harness/clients.js";
import type { IntegrationDb } from "../_harness/clients.js";
import type { Layer2Context } from "../_harness/layer2.js";
import { layer2, layer2Context } from "../_harness/layer2.js";
import { runChild } from "../substrate/contention-harness.js";
import { ledgerReplica } from "../substrate/reference-sor.js";
import type { LedgerReplica } from "../substrate/reference-sor.js";
import { join } from "node:path";
import { DOMAIN_SERVICES, allowDecision, createDomainPki, dtmfConfirmation, eventually, provisionTenant, seedWorld, sessionOf } from "./support.js";
import type { DomainPki, Tenant, World } from "./support.js";

const it = layer2(DOMAIN_SERVICES);

const CHILD = join(import.meta.dirname, "crash-child.ts");

let l2: Layer2Context;
let pki: DomainPki;
let t: Tenant;
let w: World;
let idb: IntegrationDb;
let setup: LedgerReplica;

beforeAll(async () => {
  l2 = layer2Context(DOMAIN_SERVICES);
  pki = createDomainPki();
  t = await provisionTenant(l2, pki, { systems: ["scheduling", "billing", "legacy"], writeTimeoutMs: 5_000 });
  w = await seedWorld(t);
  idb = await createIntegrationDb(l2);
  setup = ledgerReplica(idb.db, systemClock, "domain-crash-setup");
}, 180_000);

afterAll(async () => {
  await t?.dispose();
  await idb?.drop();
  pki?.dispose();
});

async function confirmed(ctx: ReturnType<typeof sessionOf>, input: PrepareInput): Promise<PreparedAction> {
  const prepared = await setup.service.prepare(ctx, input, allowDecision());
  const { confirmation, integration } = dtmfConfirmation(ctx, prepared);
  return setup.service.confirm(confirmation, integration);
}

/**
 * Runs the commit in a child replica, SIGKILLs it once `applied()` (read from the system of record) is true, and
 * returns how it exited. The response is held at the system meanwhile, so the child cannot record the commit.
 */
async function crashAfterCommit(ctx: ReturnType<typeof sessionOf>, action: PreparedAction, port: "domain" | "legacy", applied: () => Promise<boolean>) {
  const run = runChild(CHILD, [], {
    VSP_CHILD_SPEC: JSON.stringify(t.spec),
    VSP_CHILD_SECRETS_ENDPOINT: l2.url("localstack", 4566),
    VSP_CHILD_DB_URL: postgresUrl(l2, idb.name),
    VSP_CHILD_CTX: JSON.stringify(ctx),
    VSP_CHILD_ACTION_ID: action.actionId,
    VSP_CHILD_DIGEST: action.digest,
    VSP_CHILD_PORT: port,
  });
  try {
    await eventually(applied, 60_000, 25);
  } finally {
    run.child.kill("SIGKILL");
  }
  return { exit: await run.exited, lines: run.lines };
}

async function recoverAndAssert(ctx: ReturnType<typeof sessionOf>, action: PreparedAction, provider: ProviderCommitPort): Promise<string> {
  const row = await setup.service.describe?.(t.tenantId, action.actionId);
  // The ledger never learned the outcome: the commit slot is held by the dead replica.
  expect(row?.state).toBe("COMMITTING");
  const key = row?.providerIdempotencyKey ?? "";
  // Not yet stale: a retry is refused rather than racing the (dead) attempt.
  const early = ledgerReplica(idb.db, systemClock, "domain-crash-early");
  await expect(early.service.commit(ctx, { actionId: action.actionId, digest: action.digest }, { reauthorize: async () => allowDecision(), provider })).rejects.toMatchObject({ reasonCode: "COMMIT_IN_PROGRESS" });
  // A fresh replica after the stale period reconciles by the same key (lookup only) and records COMMITTED once.
  const later = new FakeClock(new Date(Date.now() + 60_000));
  const restarted = ledgerReplica(idb.db, later, "domain-crash-restarted");
  const receipt = await restarted.service.commit(ctx, { actionId: action.actionId, digest: action.digest }, { reauthorize: async () => allowDecision(later), provider });
  expect(receipt).toMatchObject({ outcome: "COMMITTED", reconciled: true });
  expect((await restarted.service.describe?.(t.tenantId, action.actionId))?.state).toBe("COMMITTED");
  // A replay returns the stored receipt.
  expect((await restarted.service.commit(ctx, { actionId: action.actionId, digest: action.digest }, { reauthorize: async () => allowDecision(later), provider })).receiptId).toBe(receipt.receiptId);
  return key;
}

describe("crash after commit, per adapter (Layer 2)", () => {
  it("[FO-06-75][ACT-02][ACT-03] scheduling: the platform process dies after the booking committed; a fresh replica reconciles it by key, exactly one booking", async () => {
    const port = t.adapters.commitPort;
    if (!port) throw new Error("commit port composed");
    const ctx = sessionOf(t.tenantId, w.client, "client");
    const prep = await port.prepare(actingPartyFor(ctx), { kind: "appointment.create", slotId: w.slots[0] as string });
    const action = await confirmed(ctx, { ...prep.input, kind: "appointment.create" } as PrepareInput);
    const key = (await setup.service.describe?.(t.tenantId, action.actionId))?.providerIdempotencyKey ?? "";
    await t.admin.arm(t.accountId, { operation: "scheduling.booking.put", kind: "COMMIT_THEN_DELAY", delayMs: 60_000, times: 1 });
    const effects = async () => (await t.admin.effects(t.accountId)).filter((e) => e.requestId === requestIdFor(key));
    const run = await crashAfterCommit(ctx, action, "domain", async () => (await effects()).length === 1);
    expect(run.exit.signal).toBe("SIGKILL");
    expect(run.lines).toContain("COMMITTING");
    expect(await recoverAndAssert(ctx, action, port)).toBe(key);
    expect(await effects()).toHaveLength(1);
    expect((await t.adapters.scheduling?.slot(w.slots[0] as string))?.state).toBe("BOOKED");
    await t.admin.clearFaults(t.accountId);
  });

  it("[FO-06-75][ACT-02][ACT-03] billing: the platform process dies after the review request committed; a fresh replica reconciles it by key, exactly one review", async () => {
    const port = t.adapters.commitPort;
    if (!port) throw new Error("commit port composed");
    const ctx = sessionOf(t.tenantId, w.client, "client");
    const prep = await port.prepare(actingPartyFor(ctx), { kind: "billing.review.submit", invoiceId: w.invoice, reasonCode: "DUPLICATE_CHARGE_SUSPECTED" });
    const action = await confirmed(ctx, { ...prep.input, kind: "billing.review.submit" } as PrepareInput);
    const key = (await setup.service.describe?.(t.tenantId, action.actionId))?.providerIdempotencyKey ?? "";
    await t.admin.arm(t.accountId, { operation: "billing.review_request.put", kind: "COMMIT_THEN_DELAY", delayMs: 60_000, times: 1 });
    const effects = async () => (await t.admin.effects(t.accountId)).filter((e) => e.requestId === requestIdFor(key));
    const run = await crashAfterCommit(ctx, action, "domain", async () => (await effects()).length === 1);
    expect(run.exit.signal).toBe("SIGKILL");
    await recoverAndAssert(ctx, action, port);
    expect(await effects()).toHaveLength(1);
    expect((await t.adapters.billing?.invoice(w.invoice))?.status).toBe("IN_REVIEW");
    await t.admin.clearFaults(t.accountId);
  });

  it("[FO-06-75][ACT-02][ACT-03] legacy (non-idempotent): the platform process dies after the create; a fresh replica reconciles by reference only, exactly one appointment, no second POST", async () => {
    const legacy = t.adapters.legacyScheduling;
    if (!legacy) throw new Error("legacy composed");
    const ctx = sessionOf(t.tenantId, w.client, "client");
    const startsAt = new Date(Date.now() + 9 * 86_400_000);
    startsAt.setUTCHours(16, 0, 0, 0);
    const prep = legacy.prepareCreate(actingPartyFor(ctx), { providerRef: w.provider, startsAt: startsAt.toISOString(), modality: "video" });
    const action = await confirmed(ctx, { ...prep, ttlSeconds: 300 });
    const key = (await setup.service.describe?.(t.tenantId, action.actionId))?.providerIdempotencyKey ?? "";
    await t.admin.arm(t.accountId, { operation: "legacy.appointment.post", kind: "COMMIT_THEN_DELAY", delayMs: 60_000, times: 1 });
    const created = async () => (await legacy.byReference(externalRefFor(key))).length;
    const posts = async () => (await t.admin.effects(t.accountId)).filter((e) => e.operation === "legacy.appointment.post").length;
    const postsBefore = await posts();
    const run = await crashAfterCommit(ctx, action, "legacy", async () => (await posts()) === postsBefore + 1);
    expect(run.exit.signal).toBe("SIGKILL");
    await recoverAndAssert(ctx, action, legacy);
    expect(await created()).toBe(1);
    // The reconciliation was by reference: the product created exactly one appointment.
    expect(await posts()).toBe(postsBefore + 1);
    await t.admin.clearFaults(t.accountId);
  });
});
