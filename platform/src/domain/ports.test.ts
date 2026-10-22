/**
 * Unit (Docker-free): the live domain adapters satisfy the existing ports structurally, so the composition owner
 * can replace the LOCAL FIXTURE business systems and the business commit ports with them (coordinator hand-off:
 * same provider commit ports), and reads classify every failure honestly (FO-03-09, FO-06-72, FO-06-73).
 * The type assertions below are checked by `tsc --noEmit` (this file is in the platform project).
 */
import { describe, expect, it } from "vitest";
import type { ProviderCommitPort } from "../actions/ports.js";
import type { BillingSystem, ClaimsSystem, ProviderSystem, SchedulingSystem } from "../adapters/ports.js";
import { ConnectorSchemaDriftError } from "../connectors/dsl/errors.js";
import { ConnectorError, ConnectorRefusal } from "../connectors/runtime/errors.js";
import { HttpBilling, HttpClaims } from "./billing.js";
import { requestIdFor } from "./changes.js";
import { DomainCommitPort } from "./commit.js";
import { HttpLegacyScheduling } from "./legacy.js";
import { HttpProviderNetwork, HttpReferralStatus, MAX_REMITTANCE_PERIODS } from "./network.js";
import { readSafely, unavailable } from "./runner.js";
import { HttpScheduling } from "./scheduling.js";
import { scriptedConnector } from "./unit-fake.fixture.js";

describe("live domain adapters behind the existing ports", () => {
  it("[FO-03-09] structural compatibility with SchedulingSystem, BillingSystem, ClaimsSystem, ProviderSystem and ProviderCommitPort", () => {
    const s = new HttpScheduling(scriptedConnector("scheduling", () => []).conn);
    const b = new HttpBilling(scriptedConnector("billing", () => []).conn);
    const c = new HttpClaims(scriptedConnector("claims", () => []).conn);
    const p = new HttpProviderNetwork(scriptedConnector("provider", () => []).conn);
    const l = new HttpLegacyScheduling(scriptedConnector("legacy", () => []).conn);
    const scheduling: SchedulingSystem = s;
    const billing: BillingSystem = b;
    const claims: ClaimsSystem = c;
    const providers: ProviderSystem = p;
    const commit: ProviderCommitPort = new DomainCommitPort({ scheduling: s, billing: b, clock: { now: () => new Date() } });
    const legacyCommit: ProviderCommitPort = l;
    for (const a of [scheduling, billing, claims, providers]) expect(a.kind).toBe("live");
    expect(typeof commit.lookup).toBe("function");
    expect(typeof legacyCommit.currentVersion).toBe("function");
    // An adapter is bound to its own contract only.
    expect(() => new HttpBilling(scriptedConnector("scheduling", () => []).conn)).toThrow("DOMAIN_BINDING_CONTRACT_MISMATCH");
    expect(() => new HttpReferralStatus(scriptedConnector("claims", () => []).conn)).toThrow("DOMAIN_BINDING_CONTRACT_MISMATCH");
  });

  it("[FO-06-72] read failures are classified honestly with a next step; nothing is retried here", async () => {
    expect(await readSafely(async () => null)).toEqual({ status: "NOT_FOUND" });
    expect(unavailable(new ConnectorError("CONNECTOR_NOT_FOUND", "FAILED", "x", "y"))).toEqual({ status: "NOT_FOUND" });
    expect(unavailable(new ConnectorError("TIMEOUT_BEFORE_SEND", "NOT_STARTED", "x", "y"))).toEqual({ status: "UNAVAILABLE", reasonCode: "TIMEOUT_BEFORE_SEND", outcome: "NOT_STARTED", nextStep: "OFFER_HUMAN_OR_CALLBACK" });
    expect(unavailable(new ConnectorError("READ_TIMEOUT", "FAILED", "x", "y"))).toMatchObject({ reasonCode: "READ_TIMEOUT", outcome: "FAILED" });
    expect(unavailable(new ConnectorRefusal("OPERATION_NOT_ENABLED", "x", "y"))).toMatchObject({ reasonCode: "OPERATION_NOT_ENABLED", outcome: "NOT_STARTED" });
    expect(unavailable(new ConnectorSchemaDriftError([{ kind: "UNKNOWN_ENUM_VALUE", targetField: "status" }], "0".repeat(64)))).toMatchObject({ reasonCode: "CONNECTOR_SCHEMA_DRIFT" });
    expect(unavailable(new Error("raw text that must not surface"))).toEqual({ status: "UNAVAILABLE", reasonCode: "DOMAIN_READ_FAILED", outcome: "FAILED", nextStep: "OFFER_HUMAN_OR_CALLBACK" });
  });

  it("[FO-06-73][FO-01-30] a record that does not satisfy the canonical contract is refused, never passed on", async () => {
    const { conn } = scriptedConnector("referrals", () => [{ referralId: "ref_synthUnitReferral00001", subjectId: "sub_synthUnitClient00001", specialtyCode: "BEHAVIORAL_HEALTH", status: "APPROVED_FOR_COVERAGE", statusAsOf: "2026-10-20T10:00:00.000Z", receivedOn: "2026-10-15", referringOrganizationId: null }]);
    const r = new HttpReferralStatus(conn);
    const read = await r.readReferral({ role: "client", partyRef: "sub_synthUnitClient00001" }, "ref_synthUnitReferral00001");
    expect(read).toMatchObject({ status: "UNAVAILABLE", reasonCode: "DOMAIN_RECORD_INVALID" });
  });

  it("[FO-06-72] remittances: a range beyond the source's documented bound is refused rather than returned incomplete", async () => {
    const rows = Array.from({ length: MAX_REMITTANCE_PERIODS }, (_, i) => ({
      remittanceId: `rem_synthUnitRemit${String(i).padStart(6, "x")}`,
      practiceId: "prc_synthUnitPractice00001",
      periodStart: `2026-${String((i % 9) + 1).padStart(2, "0")}-01`,
      periodEnd: `2026-${String((i % 9) + 1).padStart(2, "0")}-28`,
      totalMinor: 1_000,
      status: "SENT",
      paidOn: null,
    }));
    const p = new HttpProviderNetwork(scriptedConnector("provider", () => rows).conn);
    await expect(p.listRemittances({ practiceId: "prc_synthUnitPractice00001", fromDate: "2025-01-01", toDate: "2026-12-31" })).rejects.toThrow("REMITTANCE_RANGE_EXCEEDS_SOURCE_WINDOW");
    await expect(p.listRemittances({ practiceId: "prc_synthUnitPractice00001", fromDate: "2026-12-31", toDate: "2026-01-01" })).rejects.toThrow("REMITTANCE_RANGE_INVALID");
    expect((await p.listRemittances({ practiceId: "prc_synthUnitPractice00001", fromDate: "2026-02-01", toDate: "2026-02-28" })).length).toBeGreaterThan(0);
  });

  it("[ACT-03] the business port's key lookup without the action never reports an absence (UNKNOWN), and a rejected request is no effect", async () => {
    let lookup: Record<string, unknown>[] = [];
    const s = new HttpScheduling(scriptedConnector("scheduling", (op) => (op === "scheduling.change.lookup" ? (lookup as never) : [])).conn);
    await expect(s.findByIdempotencyKey(`vsp-${"cd".repeat(24)}`)).rejects.toMatchObject({ reasonCode: "RECONCILE_ABSENCE_NOT_DEFINITIVE", outcome: "UNKNOWN" });
    const key = `vsp-${"cd".repeat(24)}`;
    lookup = [{ requestId: requestIdFor(key), operation: "scheduling.booking.put", state: "REJECTED", receiptId: null, resourceType: null, resourceId: null, resourceVersion: null, resourceStartsAt: null, resourceTimeZone: null, failureCode: "SLOT_UNAVAILABLE" }];
    expect(await s.findByIdempotencyKey(key)).toBeNull();
    // A lookup answer for another request id is refused, never taken as this key's outcome.
    lookup = [{ ...lookup[0], requestId: "idk_synthUnitSomeOtherRequest0" }];
    await expect(s.findByIdempotencyKey(key)).rejects.toThrow("DOMAIN_LOOKUP_REQUEST_MISMATCH");
  });
});
