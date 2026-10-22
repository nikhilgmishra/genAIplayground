/**
 * Unit (Docker-free): every reviewed reference profile is admitted by the WP-06 loader rules, and every binding by
 * the domain binding rules (FO-06-74, FO-06-75, FO-06-76, FO-05-56; coordinator hand-off: profiles validated with
 * admitConnectorProfile in a test, no reliance on committedConfigCredentialRefs).
 */
import { describe, expect, it } from "vitest";
import { computeConnectorProfileDigest } from "../protocol/digests.js";
import { ConnectorHttpTransport } from "../connectors/http/transport.js";
import { ProfileRejectedError, admitConnectorProfile } from "../connectors/profile/validate.js";
import { LocalFixtureSecretResolver } from "../connectors/secrets/resolver.js";
import { EgressGuard } from "../privacy/egress.js";
import { systemClock } from "../shared/clock.js";
import { BindingRejectedError, admitBinding, bindingViolations } from "./binding.js";
import { PROHIBITED_SOURCE_FIELDS } from "./contracts.js";
import { createDomainAdapters } from "./factory.js";
import { CONTRACT_OF, capabilityOf, referenceBinding, referenceProfile } from "./profiles.js";
import type { ReferenceProfileInput, ReferenceSystem } from "./profiles.js";

const SYSTEMS: ReferenceSystem[] = ["scheduling", "billing", "claims", "provider", "referrals", "legacy"];
const WRITERS = new Set<ReferenceSystem>(["scheduling", "billing", "legacy"]);

const input = (key: ReferenceSystem, o: Partial<ReferenceProfileInput> = {}): ReferenceProfileInput => ({
  tenantId: "tnt_synthUnitTenant000001",
  profileId: `cnp_synthUnit${key}Profile01`,
  occurredAt: "2026-10-21T00:00:00.000Z",
  host: `${key}.refbiz.test`,
  externalAccountRef: "acc_synthUnitAccount00001",
  region: "us-east-1",
  readCredentialRef: `local-fixture:domain/${key}/read`,
  writeCredentialRef: WRITERS.has(key) ? `local-fixture:domain/${key}/write` : null,
  writeMode: WRITERS.has(key) ? "SANDBOX_WRITE" : "READ_ONLY",
  dialect: key === "legacy" ? "legacy_codes" : "canonical",
  businessTimeZone: "America/Chicago",
  addressClass: "PRIVATE_NETWORK",
  tlsCaRef: null,
  syntheticRecordId: null,
  ...o,
});

const bindingInput = { bindingId: "dbn_synthUnitBinding00001", visibilityWindowMs: 2_000, clockSkewAllowanceMs: 250, paymentPortalPath: "/billing/pay/{invoiceId}" };

describe("reference connector profiles and bindings", () => {
  it.each(SYSTEMS)("[FO-06-74] the %s profile is admitted for local and its binding is admitted", (key) => {
    const p = referenceProfile(key, input(key));
    const admitted = admitConnectorProfile(p, "local");
    expect(admitted.profile.configDigest).toBe(p.configDigest);
    const b = admitBinding(referenceBinding(key, p, bindingInput), admitted);
    expect(b.binding.contract).toBe(CONTRACT_OF[key]);
  });

  it.each(["canonical", "legacy_codes"] as const)("[FO-06-74] the scheduling profile maps the %s dialect through DSL enum tables to canonical codes", (dialect) => {
    const p = referenceProfile("scheduling", input("scheduling", { dialect }));
    admitConnectorProfile(p, "local");
    const status = p.mappingTables?.enums.find((t) => t.tableId === "appointment_status");
    expect(status?.entries.map((e) => e.to).sort()).toEqual(["CANCELLED", "COMPLETED", "SCHEDULED"]);
    expect(status?.entries.map((e) => e.from)).toEqual(dialect === "legacy_codes" ? ["BKD", "CXL", "CMP"] : ["SCHEDULED", "CANCELLED", "COMPLETED"]);
  });

  it("[FO-06-76][DATA-01] every field the platform must never ingest is PROHIBITED in the mappings", () => {
    const prohibited = new Set(SYSTEMS.flatMap((k) => referenceProfile(k, input(k)).mappings.filter((m) => m.requirement === "PROHIBITED").map((m) => m.targetField)));
    for (const f of PROHIBITED_SOURCE_FIELDS) expect(prohibited.has(f)).toBe(true);
    // ...and nothing maps them as a readable field anywhere.
    for (const k of SYSTEMS) for (const m of referenceProfile(k, input(k)).mappings) if ((PROHIBITED_SOURCE_FIELDS as readonly string[]).includes(m.targetField)) expect(m.requirement).toBe("PROHIBITED");
  });

  it("[FO-05-56][AUTH-02] reads and writes use separate least-privilege credentials and capabilities; the default credential is never the write credential", () => {
    for (const k of WRITERS) {
      const p = referenceProfile(k, input(k));
      const creds = p.capabilityCredentials ?? [];
      expect(creds.map((c) => `${c.capability}|${c.access}`).sort()).toEqual([`${capabilityOf(k, "read")}|READ`, `${capabilityOf(k, "write")}|WRITE`].sort());
      expect(new Set(creds.map((c) => c.credentialRef)).size).toBe(2);
      expect(p.credentialRef).not.toBe(creds.find((c) => c.access === "WRITE")?.credentialRef);
      for (const op of p.operations.filter((o) => o.enabled)) expect(op.capability).toBe(capabilityOf(k, op.kind === "WRITE" ? "write" : "read"));
    }
  });

  it("[FO-06-75][ACT-02] every write is keyed and declares its reconciliation lookup; the legacy create is NOT idempotent and reconciled by reference", () => {
    for (const k of WRITERS) {
      const p = referenceProfile(k, input(k));
      for (const w of p.operations.filter((o) => o.kind === "WRITE")) {
        expect(w.reconcileOperationId).not.toBeNull();
        // The legacy create is the non-idempotent write; its reference reservation, release and fence are keyed by the reference.
        if (k === "legacy") expect(w).toMatchObject(w.operationId === "legacy.appointment.post" ? { idempotency: "NOT_IDEMPOTENT_RECONCILE_REQUIRED" } : { idempotency: "EXTERNAL_ID_UPSERT", externalIdParam: "externalRef" });
        else expect(w).toMatchObject({ idempotency: "EXTERNAL_ID_UPSERT", externalIdParam: "requestId" });
      }
    }
  });

  it("[FO-06-75] a read-only profile enables no write and carries no write credential", () => {
    const p = referenceProfile("scheduling", input("scheduling", { writeMode: "READ_ONLY", writeCredentialRef: null }));
    expect(p.writeMode).toBe("READ_ONLY");
    expect(p.operations.filter((o) => o.kind === "WRITE" && o.enabled)).toHaveLength(0);
    expect((p.capabilityCredentials ?? []).some((c) => c.access === "WRITE")).toBe(false);
    admitConnectorProfile(p, "local");
  });

  it("refuses a writing profile without a write credential and a legacy profile without a business zone", () => {
    expect(() => referenceProfile("billing", input("billing", { writeCredentialRef: null }))).toThrow("WRITE_CREDENTIAL_REQUIRED");
    expect(() => referenceProfile("legacy", input("legacy", { businessTimeZone: undefined }))).toThrow("LEGACY_PROFILE_ZONE_REQUIRED");
  });

  it("[OPS-04] fixture credential references are refused outside local/ci and a sandbox profile in production", () => {
    const p = referenceProfile("claims", input("claims"));
    expect(() => admitConnectorProfile(p, "production")).toThrow(ProfileRejectedError);
    const sandbox = referenceProfile("billing", input("billing", { readCredentialRef: "arn:aws:secretsmanager:us-east-1:111122223333:secret:synth-read", writeCredentialRef: "arn:aws:secretsmanager:us-east-1:111122223333:secret:synth-write" }));
    expect(() => admitConnectorProfile(sandbox, "production")).toThrow(/SANDBOX_WRITE_PROFILE_IN_PRODUCTION/);
  });

  it("[FO-06-75] a binding whose write lacks a reconciliation, or names another lookup, is refused", () => {
    const p = referenceProfile("scheduling", input("scheduling"));
    const admitted = admitConnectorProfile(p, "local");
    const good = referenceBinding("scheduling", p, bindingInput);
    expect(bindingViolations({ ...good, reconciliation: null }, admitted)).toContain("BINDING_WRITE_WITHOUT_RECONCILIATION");
    expect(bindingViolations({ ...good, reconciliation: { ...good.reconciliation, lookupOperationId: "scheduling.appointment.get" } }, admitted)).toEqual(expect.arrayContaining(["BINDING_LOOKUP_NOT_THE_CONTRACT_LOOKUP", "BINDING_WRITE_LOOKUP_MISMATCH"]));
    expect(bindingViolations({ ...good, reconciliation: { ...good.reconciliation, completionOperationId: null } }, admitted)).toContain("BINDING_COMPLETION_INVALID");
    expect(bindingViolations({ ...good, operations: { ...good.operations, book: "scheduling.appointment.get" } }, admitted)).toContain("BINDING_OPERATION_KIND_MISMATCH");
    const { book: _drop, ...missing } = good.operations;
    expect(bindingViolations({ ...good, operations: missing }, admitted)).toContain("BINDING_OPERATION_MISSING");
    expect(bindingViolations({ ...good, operations: { ...good.operations, inventedOperation: "scheduling.slot.get" } }, admitted)).toContain("BINDING_OPERATION_UNKNOWN");
    expect(bindingViolations({ ...good, connectorProfileId: "cnp_synthSomeOtherProfile1" }, admitted)).toContain("BINDING_PROFILE_MISMATCH");
    expect(bindingViolations({ ...good, contract: "billing.v1" }, admitted)).toContain("BINDING_SYSTEM_MISMATCH");
    expect(bindingViolations({ ...good, paymentPortalPath: "/pay/{invoiceId}" }, admitted)).toContain("BINDING_PAYMENT_PORTAL_PATH_UNEXPECTED");
    expect(() => admitBinding({ ...good, reconciliation: null }, admitted)).toThrow(BindingRejectedError);
  });

  it("[FO-06-75] a non-idempotent write without the contract's lookup is refused by name", () => {
    const p = referenceProfile("legacy", input("legacy"));
    const admitted = admitConnectorProfile(p, "local");
    const good = referenceBinding("legacy", p, bindingInput);
    expect(bindingViolations({ ...good, reconciliation: null }, admitted)).toContain("BINDING_NON_IDEMPOTENT_WITHOUT_RECONCILIATION");
    expect(bindingViolations({ ...good, reconciliation: { ...good.reconciliation, lookupOperationId: "legacy.appointment.get" } }, admitted)).toContain("BINDING_NON_IDEMPOTENT_WITHOUT_RECONCILIATION");
  });

  it("[FO-06-75] billing needs the tenant's hosted payment page path; a read-only contract has no reconciliation", () => {
    const p = referenceProfile("billing", input("billing"));
    const admitted = admitConnectorProfile(p, "local");
    expect(bindingViolations({ ...referenceBinding("billing", p, bindingInput), paymentPortalPath: null }, admitted)).toContain("BINDING_PAYMENT_PORTAL_PATH_MISSING");
    const c = referenceProfile("claims", input("claims"));
    const ac = admitConnectorProfile(c, "local");
    const rb = referenceBinding("claims", c, bindingInput);
    expect(rb.reconciliation).toBeNull();
    expect(bindingViolations({ ...rb, reconciliation: { lookupOperationId: "claims.get", completionOperationId: null, visibilityWindowMs: 0, clockSkewAllowanceMs: 0, incompleteWrite: "ROUTE_TO_HUMAN", dispatchDeadline: "NONE", requestDigest: null, fenceOperationId: null, dispatchReservation: null } }, ac)).toContain("BINDING_RECONCILIATION_WITHOUT_WRITES");
  });

  it("[ACT-03][FO-06-75] a binding relying on the system's dispatch deadline needs every write to carry the instant notAfter field", () => {
    const p = referenceProfile("scheduling", input("scheduling"));
    const admitted = admitConnectorProfile(p, "local");
    const b = referenceBinding("scheduling", p, bindingInput);
    expect(b.reconciliation).toMatchObject({ dispatchDeadline: "REQUEST_NOT_AFTER", requestDigest: "REFBIZ_REQUEST_V1" });
    expect(bindingViolations(b, admitted)).toEqual([]);
    for (const w of p.operations.filter((o) => o.kind === "WRITE" && o.operationId !== "scheduling.change.complete")) {
      // The fence names the deadline it fences after (required); every change carries it (optional on the wire).
      expect(w.requestBody?.fields.find((f) => f.inputField === "notAfter"), w.operationId).toMatchObject({ type: "instant", requirement: w.operationId === "scheduling.change.fence" ? "REQUIRED" : "OPTIONAL" });
    }
    // A profile whose booking write lost the deadline field is refused for a deadline-relying binding (re-digested).
    const stripped = { ...p, operations: p.operations.map((o) => (o.operationId === "scheduling.booking.put" && o.requestBody ? { ...o, requestBody: { fields: o.requestBody.fields.filter((f) => f.inputField !== "notAfter") } } : o)) };
    const { configDigest: _d, ...rest } = stripped;
    const reDigested = { ...rest, configDigest: computeConnectorProfileDigest(rest) };
    const admittedStripped = admitConnectorProfile(reDigested, "local");
    expect(bindingViolations(referenceBinding("scheduling", reDigested, bindingInput), admittedStripped)).toEqual(["BINDING_DEADLINE_FIELD_MISSING"]);
    // ... and admitted for a binding that does not rely on a deadline (its absences are then never definitive).
    expect(bindingViolations(referenceBinding("scheduling", reDigested, { ...bindingInput, dispatchDeadline: "NONE" }), admittedStripped)).toEqual([]);
    // The legacy product keeps no change-request record: no digest scheme, but the enforced deadline.
    const l = referenceProfile("legacy", input("legacy"));
    expect(referenceBinding("legacy", l, bindingInput).reconciliation).toMatchObject({ dispatchDeadline: "REQUEST_NOT_AFTER", requestDigest: null });
  });

  it("[ACT-03][FO-06-75] absence needs the system's fence (with a deadline, the contract's own); a non-idempotent write needs a dispatch reservation and a fence", () => {
    const p = referenceProfile("scheduling", input("scheduling"));
    const admitted = admitConnectorProfile(p, "local");
    const b = referenceBinding("scheduling", p, bindingInput);
    expect(b.reconciliation).toMatchObject({ fenceOperationId: "scheduling.change.fence", dispatchReservation: null });
    expect(b.operations.fenceChange).toBe("scheduling.change.fence");
    // A fence without a dispatch deadline cannot exist (the system accepts it only after the deadline).
    const r = b.reconciliation as NonNullable<typeof b.reconciliation>;
    expect(bindingViolations({ ...b, reconciliation: { ...r, dispatchDeadline: "NONE" } }, admitted)).toContain("BINDING_FENCE_WITHOUT_DEADLINE");
    // The fence must be the contract's fence operation, and a write.
    expect(bindingViolations({ ...b, reconciliation: { ...r, fenceOperationId: "scheduling.change.complete" } }, admitted)).toContain("BINDING_FENCE_NOT_THE_CONTRACT_FENCE");
    expect(bindingViolations({ ...b, operations: { ...b.operations, fenceChange: "scheduling.change.lookup" }, reconciliation: { ...r, fenceOperationId: "scheduling.change.lookup" } }, admitted)).toContain("BINDING_FENCE_INVALID");
    // Without a fence the binding is admitted: its absences are then never definitive.
    expect(referenceBinding("scheduling", p, { ...bindingInput, fence: false }).reconciliation?.fenceOperationId).toBeNull();
    expect(bindingViolations(referenceBinding("scheduling", p, { ...bindingInput, fence: false }), admitted)).toEqual([]);
    // The legacy product: the create needs the reference reservation and the fence.
    const l = referenceProfile("legacy", input("legacy"));
    const al = admitConnectorProfile(l, "local");
    const lb = referenceBinding("legacy", l, bindingInput);
    expect(lb.reconciliation).toMatchObject({ fenceOperationId: "legacy.reference.fence", dispatchReservation: { reserveOperationId: "legacy.reference.reserve", releaseOperationId: "legacy.reference.release" } });
    expect(bindingViolations(lb, al)).toEqual([]);
    const lr = lb.reconciliation as NonNullable<typeof lb.reconciliation>;
    expect(bindingViolations({ ...lb, reconciliation: { ...lr, dispatchReservation: null } }, al)).toContain("BINDING_NON_IDEMPOTENT_WITHOUT_DISPATCH_RESERVATION");
    expect(bindingViolations({ ...lb, reconciliation: { ...lr, fenceOperationId: null } }, al)).toEqual(["BINDING_NON_IDEMPOTENT_WITHOUT_FENCE"]);
    expect(bindingViolations({ ...lb, reconciliation: { ...lr, dispatchReservation: { reserveOperationId: "legacy.reference.fence", releaseOperationId: "legacy.reference.release" } } }, al)).toContain("BINDING_DISPATCH_RESERVATION_NOT_THE_CONTRACT_RESERVATION");
  });

  it("[FO-05-56] the composition factory refuses a credential reused by two connectors and a contract bound twice; nothing is built", () => {
    const transport = new ConnectorHttpTransport({ environment: "local", egress: new EgressGuard({ policyVersion: "egress-unit-1", destinations: [] }, { environment: "local" }) });
    const secrets = new LocalFixtureSecretResolver(systemClock);
    const claims = referenceProfile("claims", input("claims"));
    const referrals = referenceProfile("referrals", input("referrals", { readCredentialRef: claims.credentialRef }));
    expect(() =>
      createDomainAdapters({
        environment: "local",
        transport,
        secrets,
        clock: systemClock,
        systems: [
          { profile: claims, binding: referenceBinding("claims", claims, bindingInput) },
          { profile: referrals, binding: referenceBinding("referrals", referrals, bindingInput) },
        ],
      }),
    ).toThrow(/CREDENTIAL_REUSED_ACROSS_CONNECTORS/);
    const claims2 = referenceProfile("claims", input("claims", { profileId: "cnp_synthUnitclaimsProfile02", readCredentialRef: "local-fixture:domain/claims2/read" }));
    expect(() =>
      createDomainAdapters({
        environment: "local",
        transport,
        secrets,
        clock: systemClock,
        systems: [
          { profile: claims, binding: referenceBinding("claims", claims, bindingInput) },
          { profile: claims2, binding: referenceBinding("claims", claims2, { ...bindingInput, bindingId: "dbn_synthUnitBinding00002" }) },
        ],
      }),
    ).toThrow("DOMAIN_CONTRACT_BOUND_TWICE");
    const built = createDomainAdapters({ environment: "local", transport, secrets, clock: systemClock, systems: [{ profile: claims, binding: referenceBinding("claims", claims, bindingInput) }] });
    expect(built.claims?.kind).toBe("live");
    expect(built.scheduling).toBeNull();
    expect(built.commitPort).toBeNull();
  });
});
