/**
 * Follow-on contract primitives (follow-on prompt section 4; FO-04-03, FO-04-42, FO-04-43,
 * FO-04-44): envelope builder, pagination, time ranges, UTC instants and business timezone, money,
 * per-issue outcomes, consent dimensions and capability status. In-memory; SYNTHETIC values only.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  BusinessTimeZone,
  CapabilityStatus,
  ConsentState,
  CurrencyCode,
  ENVELOPE_FIELD_NAMES,
  ENVELOPE_SPEC_NAMES,
  IsoDateTime,
  IssueOutcomeRecord,
  MAX_PAGE_SIZE,
  Money,
  PageInfo,
  PageRequest,
  TimeRange,
  consentPermits,
  consentProfileFromSession,
  decodeCursor,
  effectiveConsentValue,
  encodeCursor,
  envelope,
  minorUnitExponent,
  moneyToDecimalString,
  paged,
  timeRange,
  toBusinessDate,
} from "./common.js";
import * as F from "./fixtures/contracts.fixture.js";

describe("common envelope [FO-04-42]", () => {
  it("[FO-04-42] envelope() pins the contract version and builds required and nullable common fields", () => {
    const S = z.strictObject({ ...envelope("probe-contract.v1", ["tenantId", "occurredAt"], ["caseId"]), payload: z.string().max(10) });
    const ok = { schemaVersion: "probe-contract.v1", tenantId: F.SYNTH.tenantId, occurredAt: F.SYNTH.t0, caseId: null, payload: "x" };
    expect(S.safeParse(ok).success).toBe(true);
    expect(S.safeParse({ ...ok, schemaVersion: "probe-contract.v2" }).success).toBe(false);
    expect(S.safeParse({ ...ok, caseId: undefined }).success).toBe(false);
    expect(S.safeParse({ ...ok, tenantId: null }).success).toBe(false);
    expect(() => envelope("Not A Version", ["tenantId"])).toThrow();
    expect(() => envelope("probe-contract.v1", ["tenantId"], ["tenantId" as never])).toThrow();
  });

  it("[FO-04-42] every follow-on prompt common field has a camelCase envelope field", () => {
    const spec = Object.values(ENVELOPE_SPEC_NAMES);
    for (const n of ["tenant_id", "interaction_id", "case_id", "workflow_id", "session_generation", "turn_id", "request_id", "causation_id", "schema_version", "created_at", "expires_at", "data classification"]) expect(spec).toContain(n);
    expect(ENVELOPE_FIELD_NAMES).toHaveLength(13);
  });
});

describe("pagination and time ranges [FO-04-03]", () => {
  it("[FO-04-03] page requests and pages are bounded by MAX_PAGE_SIZE and consistent", () => {
    expect(PageRequest.safeParse({ pageSize: MAX_PAGE_SIZE, cursor: null }).success).toBe(true);
    expect(PageRequest.safeParse({ pageSize: MAX_PAGE_SIZE + 1, cursor: null }).success).toBe(false);
    expect(PageInfo.safeParse({ pageSize: 10, nextCursor: null, hasMore: true }).success).toBe(false);
    const Page = paged(z.string().max(5), 3);
    expect(Page.safeParse({ items: ["a", "b"], page: { pageSize: 2, nextCursor: null, hasMore: false } }).success).toBe(true);
    expect(Page.safeParse({ items: ["a", "b", "c"], page: { pageSize: 2, nextCursor: null, hasMore: false } }).success).toBe(false);
    expect(Page.safeParse({ items: ["a", "b", "c", "d"], page: { pageSize: 4, nextCursor: null, hasMore: false } }).success).toBe(false);
    expect(() => paged(z.string(), MAX_PAGE_SIZE + 1)).toThrow();
  });

  it("[FO-04-03] cursors are opaque positions; a tampered or foreign cursor decodes to null (fail closed)", () => {
    const pos = { afterKey: "sr_synthSupportRequest01", afterTime: F.SYNTH.t0 };
    const c = encodeCursor(pos);
    expect(c).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(c)).toEqual(pos);
    expect(decodeCursor(`${c.slice(0, -2)}!!`)).toBeNull();
    expect(decodeCursor("bm90LWpzb24tYXQtYWxs")).toBeNull();
    const injected = btoa(JSON.stringify({ afterKey: "x", afterTime: null, subjectId: "sub_synthClientBlake01" })).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
    expect(decodeCursor(injected)).toBeNull();
    expect(() => encodeCursor({ afterKey: "Avery Synthetic", afterTime: null })).toThrow();
  });

  it("[FO-04-03] time ranges are increasing and bounded in span", () => {
    expect(TimeRange.safeParse({ from: F.SYNTH.t0, to: F.at(3_600_000) }).success).toBe(true);
    expect(TimeRange.safeParse({ from: F.SYNTH.t0, to: F.SYNTH.t0 }).success).toBe(false);
    expect(TimeRange.safeParse({ from: F.SYNTH.t0, to: F.at(400 * 86_400_000) }).success).toBe(false);
    const day = timeRange(86_400_000);
    expect(day.safeParse({ from: F.SYNTH.t0, to: F.at(86_400_001) }).success).toBe(false);
    expect(z.toJSONSchema(day, { target: "draft-2020-12", io: "input" })).toMatchObject({ "x-max-span-ms": 86_400_000 });
  });
});

describe("UTC instants and business timezone [FO-04-43]", () => {
  it("[FO-04-43] instants are Z-suffixed UTC; offsets are refused", () => {
    expect(IsoDateTime.safeParse("2026-10-19T15:00:00.000Z").success).toBe(true);
    expect(IsoDateTime.safeParse("2026-10-19T10:00:00.000-05:00").success).toBe(false);
  });

  it("[FO-04-43] business dates are computed in the explicit timezone, across DST and the date line", () => {
    expect(toBusinessDate("2026-11-01T04:30:00.000Z", "America/Chicago")).toBe("2026-10-31");
    expect(toBusinessDate("2026-11-01T06:30:00.000Z", "America/Chicago")).toBe("2026-11-01");
    expect(toBusinessDate("2026-03-08T07:59:00.000Z", "America/New_York")).toBe("2026-03-08");
    expect(toBusinessDate("2026-10-19T23:30:00.000Z", "Pacific/Auckland")).toBe("2026-10-20");
    expect(toBusinessDate("2026-10-19T23:30:00.000Z", "UTC")).toBe("2026-10-19");
    for (const bad of ["+05:00", "EST5EDT0", "Mars/Olympus", "america/chicago ", ""]) expect(BusinessTimeZone.safeParse(bad).success, bad).toBe(false);
  });
});

describe("money [FO-04-44]", () => {
  it("[FO-04-44] money is integer minor units plus an ISO 4217 code with the right exponent", () => {
    expect(CurrencyCode.options.length).toBeGreaterThan(150);
    expect(Money.safeParse({ currency: "USD", minorUnits: 4_500 }).success).toBe(true);
    expect(Money.safeParse({ currency: "USD", minorUnits: 45.5 }).success).toBe(false);
    expect(Money.safeParse({ currency: "usd", minorUnits: 1 }).success).toBe(false);
    expect(Money.safeParse({ currency: "XAU", minorUnits: 1 }).success).toBe(false);
    expect(Money.safeParse({ currency: "USD", minorUnits: 1e14 }).success).toBe(false);
    expect(minorUnitExponent("JPY")).toBe(0);
    expect(minorUnitExponent("KWD")).toBe(3);
    expect(minorUnitExponent("CLF")).toBe(4);
    expect(moneyToDecimalString({ currency: "USD", minorUnits: 4_505 })).toBe("45.05");
    expect(moneyToDecimalString({ currency: "USD", minorUnits: 5 })).toBe("0.05");
    expect(moneyToDecimalString({ currency: "USD", minorUnits: -120 })).toBe("-1.20");
    expect(moneyToDecimalString({ currency: "JPY", minorUnits: 1_200 })).toBe("1200");
    expect(moneyToDecimalString({ currency: "BHD", minorUnits: 1_234 })).toBe("1.234");
  });
});

describe("per-issue outcomes and consent dimensions", () => {
  it("[ACT-04][SAFE-04] evidence outcomes need evidence, and a partially resolved issue is never RESOLVED_WITH_EVIDENCE", () => {
    expect(IssueOutcomeRecord.safeParse(F.issueOutcome()).success).toBe(true);
    expect(IssueOutcomeRecord.safeParse(F.issueOutcome({ evidenceRefs: [] })).success).toBe(false);
    expect(IssueOutcomeRecord.safeParse(F.issueOutcome({ outcome: "TRANSFERRED_WITH_ACCEPTANCE", evidenceRefs: [] })).success).toBe(false);
    expect(IssueOutcomeRecord.safeParse(F.issueOutcome({ partiallyResolved: true })).success).toBe(false);
    expect(IssueOutcomeRecord.safeParse(F.issueOutcome({ outcome: "WAITING_FOR_SYSTEM", partiallyResolved: true, reopened: true, evidenceRefs: [] })).success).toBe(true);
  });

  it("[DATA-03] consent dimensions stay distinct: an expired grant is EXPIRED, and a call capture never implies other dimensions", () => {
    const now = new Date(F.SYNTH.t0);
    const granted = F.consentDimension({ expiresAt: F.at(60_000) });
    expect(effectiveConsentValue(granted, now)).toBe("GRANTED");
    expect(consentPermits(granted, now)).toBe(true);
    expect(effectiveConsentValue(granted, new Date(F.at(60_000)))).toBe("EXPIRED");
    expect(consentPermits(granted, new Date(F.at(60_000)))).toBe(false);
    expect(consentPermits(F.consentDimension({ value: "NOT_REQUIRED" }), now)).toBe(false);
    const session = ConsentState.parse({ recording: "GRANTED", automatedProcessing: "DECLINED", disclosureTemplateVersion: "disclosure-en-1", capturedAt: F.SYNTH.t0, capturedBy: "studio_flow" });
    const profile = consentProfileFromSession(session);
    expect(profile.recording.value).toBe("GRANTED");
    expect(profile.transcriptionAiProcessing.value).toBe("DECLINED");
    for (const d of ["supportPurpose", "disclosureAuthority", "notificationSubscription", "marketing"] as const) expect(profile[d].value).toBe("UNKNOWN");
  });

  it("[OPS-03] capability status: PASS and verified software need evidence; environment cannot be verified without software", () => {
    const base = { capabilityId: "platform.contracts", software: "IMPLEMENTED", environment: "NOT_CONFIGURED", qualification: "NOT_RUN", evidenceRefs: [], activationInputs: [] } as const;
    expect(CapabilityStatus.safeParse(base).success).toBe(true);
    expect(CapabilityStatus.safeParse({ ...base, qualification: "PASS" }).success).toBe(false);
    expect(CapabilityStatus.safeParse({ ...base, software: "VERIFIED_LOCAL" }).success).toBe(false);
    expect(CapabilityStatus.safeParse({ ...base, software: "VERIFIED_LOCAL", evidenceRefs: ["platform/src/protocol/registry.test.ts"] }).success).toBe(true);
    expect(CapabilityStatus.safeParse({ ...base, software: "MISSING", environment: "VERIFIED_SANDBOX" }).success).toBe(false);
  });

  it("[OPS-03] the environment axis cannot be inflated: VERIFIED_SANDBOX and above need evidence and a PASS qualification", () => {
    const base = { capabilityId: "platform.contracts", software: "IMPLEMENTED", environment: "NOT_CONFIGURED", qualification: "NOT_RUN", evidenceRefs: [], activationInputs: [] } as const;
    const codes = (v: object): string[] => {
      const r = CapabilityStatus.safeParse(v);
      return r.success ? [] : r.error.issues.map((i) => i.message);
    };
    for (const environment of ["VERIFIED_SANDBOX", "APPROVED_PILOT", "VERIFIED_PRODUCTION"] as const) {
      expect(codes({ ...base, environment }), environment).toEqual(["ENVIRONMENT_VERIFIED_WITHOUT_EVIDENCE", "ENVIRONMENT_VERIFIED_WITHOUT_QUALIFICATION_PASS"]);
      for (const qualification of ["NOT_RUN", "FAIL", "INCONCLUSIVE"] as const) {
        expect(codes({ ...base, environment, qualification, evidenceRefs: ["evidence/qualification/q-1"] }), `${environment}/${qualification}`).toEqual(["ENVIRONMENT_VERIFIED_WITHOUT_QUALIFICATION_PASS"]);
      }
      expect(codes({ ...base, environment, qualification: "PASS", evidenceRefs: ["evidence/qualification/q-1"] })).toEqual([]);
    }
    // A failed qualification is recorded honestly at CONFIGURED; the record stays valid.
    expect(codes({ ...base, environment: "CONFIGURED", qualification: "FAIL", evidenceRefs: ["evidence/qualification/q-2"] })).toEqual([]);
    expect(codes({ ...base, environment: "CONFIGURED", qualification: "FAIL" })).toEqual([]);
  });
});
