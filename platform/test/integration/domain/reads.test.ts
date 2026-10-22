/**
 * Layer 2 (WP-23): canonical domain reads through the production HTTP adapters over the reference business API
 * (FO-06-72, FO-06-73, FO-01-30, FO-06-74, FO-06-76, FO-19-21; AUTH-05). Every record carries connector
 * provenance; prohibited source fields never reach a canonical record; another party's record reads as absent.
 */
import { afterAll, beforeAll, describe, expect } from "vitest";
import { actingPartyFor } from "../../../src/domain/authority.js";
import { PROHIBITED_SOURCE_FIELDS } from "../../../src/domain/contracts.js";
import { layer2, layer2Context } from "../_harness/layer2.js";
import { DOMAIN_SERVICES, createDomainPki, provisionTenant, seedWorld, sessionOf } from "./support.js";
import type { DomainPki, Tenant, World } from "./support.js";

const it = layer2(DOMAIN_SERVICES);

let pki: DomainPki;
let t: Tenant;
let w: World;
let legacyTenant: Tenant;
let lw: World;

beforeAll(async () => {
  const l2 = layer2Context(DOMAIN_SERVICES);
  pki = createDomainPki();
  t = await provisionTenant(l2, pki);
  w = await seedWorld(t);
  // A tenant whose scheduling product reports legacy codes: mapped through the profile's DSL enum tables.
  legacyTenant = await provisionTenant(l2, pki, { systems: ["scheduling", "legacy"], dialect: "legacy_codes", timeZone: "America/Denver" });
  lw = await seedWorld(legacyTenant, "America/Denver");
}, 120_000);

afterAll(async () => {
  await t?.dispose();
  await legacyTenant?.dispose();
  pki?.dispose();
});

const client = () => actingPartyFor(sessionOf(t.tenantId, w.client, "client"));
const provider = () => actingPartyFor(sessionOf(t.tenantId, w.provider, "provider"));

/** Every value of a canonical record, flattened (to assert that no prohibited source value leaked). */
const flat = (v: unknown): string => JSON.stringify(v);

describe("domain reads (Layer 2, reference business API)", () => {
  it("[FO-06-72][FO-19-21][AUTH-05] a client's appointments, options and invoices map into the canonical contract with connector provenance", async () => {
    const s = t.adapters.scheduling;
    const b = t.adapters.billing;
    if (!s || !b) throw new Error("scheduling and billing are composed");
    const appts = await s.readAppointments(client());
    expect(appts.status).toBe("AVAILABLE");
    if (appts.status !== "AVAILABLE") return;
    expect(appts.value.map((a) => a.appointmentId)).toEqual([w.appointment]);
    const a = appts.value[0];
    expect(a?.status).toBe("SCHEDULED");
    expect(a?.version).toBe("3");
    expect(a?.source.kind).toBe("CONNECTOR_READ");
    expect(a?.source.connectorProfileId).toBe(t.profiles.scheduling?.profileId);
    expect(a?.source.profileConfigDigest).toBe(t.profiles.scheduling?.configDigest);
    expect(a?.source.mappingDigest).toMatch(/^[0-9a-f]{64}$/);
    // The restricted visit reason exists at the source and never reaches the canonical record.
    expect(flat(appts.value)).not.toContain("synthetic restricted text");
    expect(Object.keys(a ?? {})).not.toContain("visitReason");

    const options = await s.readSlotOptions(client(), { appointmentId: w.appointment, days: 14 });
    expect(options.status).toBe("AVAILABLE");
    if (options.status === "AVAILABLE") {
      expect(options.value.map((o) => o.slotId).sort()).toEqual([...w.slots].sort());
      expect(options.value.every((o) => o.state === "OPEN" && o.providerRef === w.provider)).toBe(true);
    }

    const invoices = await b.readInvoices(client());
    expect(invoices.status).toBe("AVAILABLE");
    if (invoices.status === "AVAILABLE") {
      const open = invoices.value.find((i) => i.invoiceId === w.invoice);
      expect(open?.balanceMinor).toBe(12_500);
      expect(open?.lines).toHaveLength(1);
      expect(open?.currency).toBe("USD");
    }
    const payments = await b.readPayments(client(), w.paidInvoice);
    expect(payments.status).toBe("AVAILABLE");
    // Card fragments exist at the source and are PROHIBITED by the mapping.
    expect(flat(payments)).not.toContain("4242");
  });

  it("[FO-06-73][FO-01-30] claim, referral, authorization and eligibility status come from the system of record with their as-of times", async () => {
    const c = t.adapters.claims;
    const r = t.adapters.referrals;
    if (!c || !r) throw new Error("claims and referrals are composed");
    const claims = await c.readClaims(client());
    expect(claims.status).toBe("AVAILABLE");
    if (claims.status === "AVAILABLE") {
      expect(claims.value[0]?.insurerStatus).toBe("IN_PROCESS");
      expect(claims.value[0]?.source.system).toBe("claims");
    }
    expect(flat(claims)).not.toContain("SYNTH-RESTRICTED");
    const referrals = await r.readReferrals(client());
    const auths = await r.readAuthorizations(client());
    const elig = await r.readEligibility(client());
    expect(referrals.status).toBe("AVAILABLE");
    expect(auths.status).toBe("AVAILABLE");
    expect(elig.status).toBe("AVAILABLE");
    if (referrals.status === "AVAILABLE") expect(referrals.value[0]?.status).toBe("IN_REVIEW");
    if (auths.status === "AVAILABLE") expect(auths.value[0]).toMatchObject({ status: "APPROVED", unitsApproved: 12, unitsUsed: 3 });
    if (elig.status === "AVAILABLE") {
      expect(elig.value.coverageStatus).toBe("ACTIVE");
      expect(elig.value.source.kind).toBe("CONNECTOR_READ");
    }
    for (const field of PROHIBITED_SOURCE_FIELDS) expect(flat([claims, referrals, auths, elig])).not.toContain(`"${field}"`);
    expect(flat([referrals, elig])).not.toContain("synthetic restricted text");
    expect(flat(elig)).not.toContain("SYNTH-RESTRICTED");
  });

  it("[FO-06-72] a provider reads their own onboarding (missing documents derived from the source) and remittances, never a payout decision", async () => {
    const p = t.adapters.provider;
    if (!p) throw new Error("provider is composed");
    const onboarding = await p.readOnboarding(provider());
    expect(onboarding.status).toBe("AVAILABLE");
    if (onboarding.status === "AVAILABLE") {
      expect(onboarding.value.stage).toBe("DOCUMENTS_PENDING");
      expect([...onboarding.value.missingDocumentTypes].sort()).toEqual(["MALPRACTICE_INSURANCE", "W9"]);
    }
    const rem = await p.remittances(w.practice, 6);
    expect(rem).toHaveLength(3);
    expect(rem.every((x) => ["SCHEDULED", "SENT", "RETURNED"].includes(x.status))).toBe(true);
    expect(flat(rem)).not.toContain("6789");
    // A client has no provider-network authority (adversarial role).
    const asClient = await p.readOnboarding(client());
    expect(asClient).toMatchObject({ status: "UNAVAILABLE", reasonCode: "DOMAIN_ROLE_NOT_SUPPORTED" });
  });

  it("[AUTH-05] another client's appointment reads as absent; a provider sees only their own schedule", async () => {
    const s = t.adapters.scheduling;
    if (!s) throw new Error("scheduling is composed");
    // The record exists at the source but belongs to another client: same answer as a missing record.
    expect(await s.readAppointment(client(), w.otherAppointment)).toEqual({ status: "NOT_FOUND" });
    expect(await s.readAppointment(client(), "apt_doesNotExistAnywhere00")).toEqual({ status: "NOT_FOUND" });
    // The provider's own schedule: their open slots only, never another provider's.
    const mine = await s.readProviderSlots(provider(), 14);
    expect(mine.status).toBe("AVAILABLE");
    if (mine.status === "AVAILABLE") expect(mine.value.every((x) => x.providerRef === w.provider)).toBe(true);
    if (mine.status === "AVAILABLE") expect(mine.value.map((x) => x.slotId)).not.toContain(w.otherProviderSlot);
    // A provider reads an appointment of their own schedule; another provider's is absent.
    const other = actingPartyFor(sessionOf(t.tenantId, w.otherProvider, "provider"));
    expect((await s.readAppointment(provider(), w.otherAppointment)).status).toBe("AVAILABLE");
    expect(await s.readAppointment(other, w.otherAppointment)).toEqual({ status: "NOT_FOUND" });
  });

  it("[FO-06-74] a tenant on legacy codes is mapped through its profile's DSL tables into the same canonical values", async () => {
    const s = legacyTenant.adapters.scheduling;
    if (!s) throw new Error("scheduling is composed");
    const party = actingPartyFor(sessionOf(legacyTenant.tenantId, lw.client, "client"));
    const appts = await s.readAppointments(party);
    expect(appts.status).toBe("AVAILABLE");
    if (appts.status === "AVAILABLE") {
      // The wire says BKD / VID; the canonical record says SCHEDULED / video.
      expect(appts.value[0]).toMatchObject({ appointmentId: lw.appointment, status: "SCHEDULED", modality: "video" });
    }
    // The legacy product (wall-clock local times in the tenant's zone): mapped to the same UTC instant.
    const legacy = legacyTenant.adapters.legacyScheduling;
    if (!legacy) throw new Error("legacy is composed");
    const viaLegacy = await legacy.appointment(lw.appointment);
    const viaCanonical = appts.status === "AVAILABLE" ? appts.value[0] : undefined;
    expect(viaLegacy?.startsAt).toBe(viaCanonical?.startsAt);
    expect(viaLegacy?.timeZone).toBe("America/Denver");
    expect(viaLegacy?.status).toBe("SCHEDULED");
  });
});
