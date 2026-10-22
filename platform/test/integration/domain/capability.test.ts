/**
 * Layer 2 (WP-23; FO-16-17, FO-00-13, FO-06-74, FO-06-11): the operator capability test of domain connectors over
 * the reference business API. A read capability is READY only after authentication, metadata comparison, the
 * approved synthetic record (mapped into the canonical contract) and the system's documented visibility window
 * passed; a write capability only after an authorized sandbox write and its reconcile lookup. The evidence record
 * is content-free and digest-bound (EMULATOR_PASS: the production adapter over the real protocol, not a vendor).
 */
import { afterAll, afterEach, beforeAll, describe, expect } from "vitest";
import { runDomainCapabilityTest } from "../../../src/domain/capability.js";
import { requestIdFor } from "../../../src/domain/changes.js";
import type { DomainContract } from "../../../src/domain/binding.js";
import { actingPartyFor } from "../../../src/domain/authority.js";
import type { Layer2Context } from "../_harness/layer2.js";
import { layer2, layer2Context } from "../_harness/layer2.js";
import { DOMAIN_SERVICES, createDomainPki, provisionTenant, seedWorld, sessionOf, worldIds } from "./support.js";
import type { DomainPki, Tenant, TenantOptions } from "./support.js";

const it = layer2(DOMAIN_SERVICES);

let pki: DomainPki;
let l2ctx: Layer2Context;
const tenants: Tenant[] = [];

beforeAll(() => {
  l2ctx = layer2Context(DOMAIN_SERVICES);
  pki = createDomainPki();
});
afterEach(async () => {
  for (const t of tenants.splice(0)) await t.dispose();
});
afterAll(() => pki?.dispose());

async function tenant(o: TenantOptions): Promise<Tenant> {
  const t = await provisionTenant(l2ctx, pki, o);
  tenants.push(t);
  return t;
}

function runtimeOf(t: Tenant, contract: DomainContract) {
  const conn = t.adapters.connectors.get(contract);
  const rt = conn ? t.adapters.runtimes.get(conn.binding.binding.connectorProfileId) : undefined;
  if (!conn || !rt) throw new Error("connector composed");
  return { conn, rt };
}

const steps = (e: { steps: readonly { step: string; result: string; detailCode: string }[] }) => Object.fromEntries(e.steps.map((s) => [s.step, `${s.result}:${s.detailCode}`]));

describe("operator capability tests (Layer 2)", () => {
  it("[FO-16-17][FO-00-13] a read-only claims connector qualifies READY with EMULATOR_PASS evidence: auth, metadata, canonical synthetic record, visibility window", async () => {
    const ids = worldIds();
    const t = await tenant({ systems: ["claims"], syntheticRecords: { claims: ids.claim } });
    await seedWorld(t, "America/Chicago", ids);
    const { conn, rt } = runtimeOf(t, "claims.v1");
    const claims = t.adapters.claims;
    if (!claims) throw new Error("claims composed");
    const result = await runDomainCapabilityTest({ runtime: rt, connector: conn, now: () => new Date(), level: "EMULATOR_PASS", evidenceRef: "evidence://domain/capability/claims", evidenceTtlMs: 86_400_000, canonicalSynthetic: () => claims.claim(ids.claim) });
    expect(result.reportedVisibilityWindowMs).toBe(1_500);
    expect(result.evidence).toHaveLength(1);
    const ev = result.evidence[0];
    expect(ev).toMatchObject({ capability: "domain.claims.read", level: "EMULATOR_PASS", result: "PASS", profileId: t.profiles.claims?.profileId, profileConfigDigest: t.profiles.claims?.configDigest, signature: null });
    expect(steps(ev ?? { steps: [] })).toMatchObject({
      AUTHENTICATE: "PASS:TOKEN_ISSUED",
      INSPECT_METADATA: "PASS:MAPPING_MATCHES_METADATA",
      INSPECT_SYNTHETIC_RECORD: "PASS:SYNTHETIC_RECORD_MAPPED",
      COMPARE_MAPPING: "PASS:MAPPING_DIGEST_PINNED",
      FRESHNESS_TEST: "PASS:VISIBILITY_WINDOW_WITHIN_BINDING",
    });
    expect(rt.readiness()).toEqual([expect.objectContaining({ capability: "domain.claims.read", status: "READY" })]);
    // Content-free: the evidence carries codes and digests only, never record values.
    expect(JSON.stringify(result.evidence)).not.toContain(ids.claim);
  });

  it("[FO-16-17][FO-06-11] a write capability is qualified only by an authorized sandbox write and its reconcile lookup", async () => {
    const ids = worldIds();
    const t = await tenant({ systems: ["scheduling"], syntheticRecords: { scheduling: ids.appointment } });
    await seedWorld(t, "America/Chicago", ids);
    const { conn, rt } = runtimeOf(t, "scheduling.v1");
    const s = t.adapters.scheduling;
    if (!s) throw new Error("scheduling composed");
    const synthetic = () => s.appointment(ids.appointment);
    const base = { runtime: rt, connector: conn, now: () => new Date(), level: "EMULATOR_PASS" as const, evidenceRef: "evidence://domain/capability/scheduling", evidenceTtlMs: 86_400_000, canonicalSynthetic: synthetic };
    const withoutWrite = await runDomainCapabilityTest(base);
    const byCap = Object.fromEntries(withoutWrite.report.capabilities.map((c) => [c.capability, c]));
    expect(byCap["domain.scheduling.read"]?.status).toBe("READY");
    expect(byCap["domain.scheduling.write"]).toMatchObject({ status: "UNKNOWN", reasonCode: "WRITE_RECONCILE_TEST_NOT_RUN" });
    // The tenant-approved sandbox write: a provider-approved availability block of a synthetic slot.
    const requestId = requestIdFor(`vsp-${"7c".repeat(24)}`);
    const withWrite = await runDomainCapabilityTest({
      ...base,
      sandboxWrite: {
        operationId: "scheduling.availability_block.put",
        input: {
          params: { requestId },
          body: { providerId: ids.provider, slotId: ids.slots[3] as string, slotVersion: "1", reasonCode: "ADMINISTRATIVE", authority: "PROVIDER_APPROVED", actingPartyId: ids.provider },
          idempotencyKey: requestId,
        },
      },
    });
    const write = withWrite.evidence.find((e) => e.capability === "domain.scheduling.write");
    expect(write?.result).toBe("PASS");
    expect(steps(write ?? { steps: [] }).WRITE_RECONCILE_TEST).toBe("PASS:WRITE_RECONCILED");
    expect((await s.slot(ids.slots[3] as string))?.state).toBe("BLOCKED");
    expect((await t.admin.effects(t.accountId)).filter((e) => e.requestId === requestId)).toHaveLength(1);
  });

  it("[FO-16-17][ACT-03][FO-06-75] a binding that proves absence by the system's fence is READY only when the system offers it and an authorized fence probe of a fresh synthetic id comes back FENCED; the legacy binding also needs the dispatch reservation", async () => {
    const ids = worldIds();
    const t = await tenant({ systems: ["scheduling", "legacy"], syntheticRecords: { scheduling: ids.appointment } });
    await seedWorld(t, "America/Chicago", ids);
    const { conn, rt } = runtimeOf(t, "scheduling.v1");
    expect(conn.binding.binding.reconciliation).toMatchObject({ fenceOperationId: "scheduling.change.fence", dispatchDeadline: "REQUEST_NOT_AFTER" });
    const s = t.adapters.scheduling;
    if (!s) throw new Error("scheduling composed");
    const fencesBefore = (await t.admin.requests(t.accountId)).filter((r) => r.operation === "change_requests.fence").length;
    const r = await runDomainCapabilityTest({ runtime: rt, connector: conn, now: () => new Date(), level: "EMULATOR_PASS", evidenceRef: "evidence://domain/capability/fence", evidenceTtlMs: 86_400_000, canonicalSynthetic: () => s.appointment(ids.appointment), fenceProbe: { operation: "scheduling.booking.put" } });
    expect(steps(r.evidence.find((e) => e.capability === "domain.scheduling.read") ?? { steps: [] }).FRESHNESS_TEST).toBe("PASS:VISIBILITY_WINDOW_WITHIN_BINDING");
    // The probe reached the system: one synthetic id fenced, asked twice (idempotent), nothing applied.
    const fences = (await t.admin.requests(t.accountId)).filter((x) => x.operation === "change_requests.fence").slice(fencesBefore);
    expect(fences.map((x) => x.status)).toEqual([200, 200]);
    expect(fences[0]?.keyRef).toBe(fences[1]?.keyRef);
    expect(await t.admin.changeRequest(t.accountId, fences[0]?.keyRef as string)).toMatchObject({ state: "FAILED", failure_code: "FENCED" });
    // The legacy product: the binding's reservation and fence are offered and enforced too.
    const legacy = runtimeOf(t, "scheduling.legacy.v1");
    expect(legacy.conn.binding.binding.reconciliation).toMatchObject({ fenceOperationId: "legacy.reference.fence", dispatchReservation: { reserveOperationId: "legacy.reference.reserve", releaseOperationId: "legacy.reference.release" } });
    const lr = await runDomainCapabilityTest({ runtime: legacy.rt, connector: legacy.conn, now: () => new Date(), level: "EMULATOR_PASS", evidenceRef: "evidence://domain/capability/legacy-fence", evidenceTtlMs: 86_400_000, canonicalSynthetic: null, fenceProbe: { operation: "legacy.appointment.post" } });
    expect(lr.report.steps.find((x) => x.step === "FRESHNESS_TEST")).toMatchObject({ result: "PASS" });
    expect((await t.admin.requests(t.accountId)).filter((x) => x.operation === "legacy.reference.fence").map((x) => x.status)).toEqual([200, 200]);
  });

  it("[FO-16-17][ACT-03] a binding that relies on a shorter visibility window than the system documents is NOT_READY (absence could be misread)", async () => {
    const ids = worldIds();
    const t = await tenant({ systems: ["billing"], visibilityWindowMs: 3_000, bindingWindowMs: 500, syntheticRecords: { billing: ids.invoice } });
    await seedWorld(t, "America/Chicago", ids);
    const { conn, rt } = runtimeOf(t, "billing.v1");
    const b = t.adapters.billing;
    if (!b) throw new Error("billing composed");
    const r = await runDomainCapabilityTest({ runtime: rt, connector: conn, now: () => new Date(), level: "EMULATOR_PASS", evidenceRef: "evidence://domain/capability/billing", evidenceTtlMs: 86_400_000, canonicalSynthetic: () => b.invoice(ids.invoice) });
    expect(r.reportedVisibilityWindowMs).toBe(3_000);
    expect(r.report.capabilities.every((c) => c.status === "NOT_READY" && c.reasonCode === "VISIBILITY_WINDOW_EXCEEDS_BINDING")).toBe(true);
    expect(r.evidence.every((e) => e.result === "FAIL")).toBe(true);
  });

  it("[FO-06-74][FO-06-76] a tenant whose system answers in codes the reviewed profile does not map is schema drift: reads refused whole, the capability not ready", async () => {
    const ids = worldIds();
    // The account reports legacy codes; the reviewed profile maps the canonical dialect.
    const t = await tenant({ systems: ["scheduling"], dialect: "legacy_codes", profileDialect: "canonical", syntheticRecords: { scheduling: ids.appointment } });
    await seedWorld(t, "America/Chicago", ids);
    const s = t.adapters.scheduling;
    if (!s) throw new Error("scheduling composed");
    const read = await s.readAppointments(actingPartyFor(sessionOf(t.tenantId, ids.client, "client")));
    expect(read).toMatchObject({ status: "UNAVAILABLE", reasonCode: "CONNECTOR_SCHEMA_DRIFT", outcome: "FAILED" });
    const { conn, rt } = runtimeOf(t, "scheduling.v1");
    const r = await runDomainCapabilityTest({ runtime: rt, connector: conn, now: () => new Date(), level: "EMULATOR_PASS", evidenceRef: "evidence://domain/capability/drift", evidenceTtlMs: 86_400_000, canonicalSynthetic: () => s.appointment(ids.appointment) });
    expect(steps(r.evidence[0] ?? { steps: [] }).INSPECT_METADATA).toBe("FAIL:CONNECTOR_SCHEMA_DRIFT");
    expect(r.report.capabilities.some((c) => c.status === "READY")).toBe(false);
  });
});
