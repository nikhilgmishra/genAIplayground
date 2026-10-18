import { describe, expect, it } from "vitest";
import { CLAIMS, ORGANIZATIONS, PEOPLE, REMITTANCES } from "../../fixtures/synthetic-world.js";
import { PlatformError, ValidationError } from "../../shared/errors.js";
import { ClaimsFixture } from "./claims-fixture.js";
import { FaultInjector } from "./faults.js";
import { ProviderFixture } from "./provider-fixture.js";
import { SyntheticStore } from "./synthetic-store.js";

async function rejection(p: Promise<unknown>): Promise<PlatformError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof PlatformError) return err;
    throw err;
  }
  throw new Error("expected rejection");
}

describe("ClaimsFixture (LOCAL FIXTURE, SYNTHETIC)", () => {
  it("[SPEC-4.claims] claim status is the insurer-reported status with its as-of time — no eligibility, coverage or payment-guarantee fields", async () => {
    const claims = new ClaimsFixture({ store: new SyntheticStore() });
    const [c] = await claims.listClaims(PEOPLE.avery.subjectId);
    expect(Object.keys(c ?? {}).sort()).toEqual(["claimId", "insurerStatus", "payerDisplayName", "serviceDate", "statusAsOf", "subjectId"]);
    expect(c).toMatchObject({ insurerStatus: "IN_PROCESS", statusAsOf: CLAIMS[0].statusAsOf });
    expect(await claims.listClaims(PEOPLE.blake.subjectId)).toEqual([]);
    expect(await claims.getClaim("clm_synthDoesNotExist001")).toBeNull();
    await expect(claims.getClaim("claim 1")).rejects.toBeInstanceOf(ValidationError);
  });

  it("[SPEC-14.faults] stale insurer status and outages are injectable", async () => {
    const faults = new FaultInjector();
    const claims = new ClaimsFixture({ store: new SyntheticStore(), faults });
    claims.simulateInsurerUpdate(CLAIMS[0].claimId, "ADJUDICATED_PAID", "2026-10-17T12:00:00.000Z");
    faults.inject({ integrationId: "claims", operation: "getClaim", kind: "STALE_READ" });
    expect((await claims.getClaim(CLAIMS[0].claimId))?.insurerStatus).toBe("IN_PROCESS");
    expect((await claims.getClaim(CLAIMS[0].claimId))?.insurerStatus).toBe("ADJUDICATED_PAID");
    faults.inject({ integrationId: "claims", operation: "listClaims", kind: "TIMEOUT_BEFORE_SEND" });
    expect(await rejection(claims.listClaims(PEOPLE.avery.subjectId))).toMatchObject({ reasonCode: "TIMEOUT_BEFORE_SEND", outcome: "NOT_STARTED" });
  });
});

describe("ProviderFixture (LOCAL FIXTURE, SYNTHETIC)", () => {
  it("[SPEC-4.provider] onboarding status exposes the stage, missing document types and the provider's practice organization only", async () => {
    const provider = new ProviderFixture({ store: new SyntheticStore() });
    expect(await provider.getOnboardingStatus(PEOPLE.newbie.subjectId)).toEqual({
      providerId: PEOPLE.newbie.subjectId,
      stage: "DOCUMENTS_PENDING",
      missingDocumentTypes: ["MALPRACTICE_INSURANCE", "W9"],
      asOf: "2026-10-14T12:00:00.000Z",
      organizationId: null,
    });
    // The practice comes from the SYNTHETIC provider record (enrolled practice), never from caller input.
    expect((await provider.getOnboardingStatus(PEOPLE.morgan.subjectId))?.organizationId).toBe(PEOPLE.morgan.organizationId);
    expect(await provider.getOnboardingStatus("prv_synthDoesNotExist01")).toBeNull();
  });

  it("[AUTH-05] remittances are scoped to the requested practice and filtered by period overlap", async () => {
    const provider = new ProviderFixture({ store: new SyntheticStore() });
    const north = await provider.listRemittances({ practiceId: ORGANIZATIONS.practiceNorth.organizationId, fromDate: "2026-09-01", toDate: "2026-10-31" });
    expect(north.map((r) => r.remittanceId)).toEqual([REMITTANCES[0].remittanceId, REMITTANCES[1].remittanceId]);
    expect(north.every((r) => r.practiceId === ORGANIZATIONS.practiceNorth.organizationId)).toBe(true);
    const october = await provider.listRemittances({ practiceId: ORGANIZATIONS.practiceNorth.organizationId, fromDate: "2026-10-10", toDate: "2026-10-12" });
    expect(october.map((r) => r.remittanceId)).toEqual([REMITTANCES[1].remittanceId]);
    expect(await provider.listRemittances({ practiceId: ORGANIZATIONS.practiceSouth.organizationId, fromDate: "2026-10-01", toDate: "2026-10-31" })).toEqual([]);
    expect(await rejection(provider.listRemittances({ practiceId: ORGANIZATIONS.practiceNorth.organizationId, fromDate: "2026-10-31", toDate: "2026-10-01" }))).toMatchObject({
      reasonCode: "REMITTANCE_RANGE_INVALID",
    });
    await expect(provider.listRemittances({ practiceId: "North Practice", fromDate: "2026-10-01", toDate: "2026-10-31" })).rejects.toBeInstanceOf(ValidationError);
  });

  it("[SPEC-14.faults] provider-network quota exhaustion and stale reads are injectable", async () => {
    const faults = new FaultInjector();
    const provider = new ProviderFixture({ store: new SyntheticStore(), faults });
    faults.inject({ integrationId: "provider-system", operation: "listRemittances", kind: "QUOTA_EXHAUSTED" });
    expect(await rejection(provider.listRemittances({ practiceId: ORGANIZATIONS.practiceNorth.organizationId, fromDate: "2026-09-01", toDate: "2026-10-31" }))).toMatchObject({
      reasonCode: "HTTP_429",
      outcome: "NOT_STARTED",
    });
    provider.simulateRemittanceUpdate(REMITTANCES[1].remittanceId, { status: "SENT", paidOn: "2026-10-17" });
    faults.inject({ integrationId: "provider-system", operation: "listRemittances", kind: "STALE_READ" });
    const stale = await provider.listRemittances({ practiceId: ORGANIZATIONS.practiceNorth.organizationId, fromDate: "2026-10-01", toDate: "2026-10-31" });
    expect(stale[0]?.status).toBe("SCHEDULED");
    provider.simulateOnboardingUpdate(PEOPLE.newbie.subjectId, { stage: "CREDENTIALING_IN_REVIEW", missingDocumentTypes: [] });
    expect((await provider.getOnboardingStatus(PEOPLE.newbie.subjectId))?.stage).toBe("CREDENTIALING_IN_REVIEW");
  });
});
