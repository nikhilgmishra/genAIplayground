import { beforeEach, describe, expect, it } from "vitest";
import { CALLS, PEOPLE } from "../../fixtures/synthetic-world.js";
import { FakeClock } from "../../shared/clock.js";
import { PlatformError, ValidationError } from "../../shared/errors.js";
import { newId, newSupportReference } from "../../shared/ids.js";
import type { CaseFields } from "../ports.js";
import { FaultInjector } from "./faults.js";
import { FIXTURE_NEW_CASE_STATUS, SupportRecordsFixture } from "./support-records-fixture.js";

const interaction = (callId: string = CALLS.primary.callId) => ({ callId, language: "en", consentStatus: "GRANTED", startedAt: "2026-10-17T15:00:00.000Z" });
const caseFields = (over: Partial<CaseFields> = {}): CaseFields => ({
  subjectRef: PEOPLE.avery.subjectId,
  audience: "client",
  issueCategory: "appointment",
  disposition: "REQUEST_ACCEPTED",
  ownerQueue: "q_scheduling",
  priority: "P3_STANDARD",
  summary: "Reschedule requested; slot conflict; caller offered alternatives.",
  attempted: ["appointment.reschedule"],
  commitReceiptIds: [],
  sourceCallIds: [CALLS.primary.callId],
  language: "en",
  consentStatus: "GRANTED",
  nextStep: null,
  deadline: null,
  versions: "policy-2026-10-17.1",
  restricted: false,
  supportReference: newSupportReference(),
  ...over,
});

let faults: FaultInjector;
let sf: SupportRecordsFixture;

async function rejection(p: Promise<unknown>): Promise<PlatformError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof PlatformError) return err;
    throw err;
  }
  throw new Error("expected rejection");
}

beforeEach(() => {
  faults = new FaultInjector();
  sf = new SupportRecordsFixture({ faults, clock: new FakeClock() });
});

describe("SupportRecordsFixture — Salesforce-like LOCAL FIXTURE (SYNTHETIC, not Salesforce)", () => {
  it("[SPEC-8.4] upsert by external id never duplicates interactions or Cases", async () => {
    const call = newId("int");
    const issue = newId("iss");
    const i1 = await sf.upsertInteraction(call, interaction());
    const i2 = await sf.upsertInteraction(call, interaction());
    const c1 = await sf.upsertCase(issue, call, caseFields());
    const c2 = await sf.upsertCase(issue, call, caseFields({ nextStep: "Callback within one business day" }));
    expect(i1.created).toBe(true);
    expect(i2).toEqual({ recordId: i1.recordId, created: false });
    expect(c1.created).toBe(true);
    expect(c2).toEqual({ caseId: c1.caseId, created: false });
    expect(c1.caseId).toMatch(/^500SYN[A-Za-z0-9]{12}$/);
    const r = sf.records();
    expect(r.interactions).toHaveLength(1);
    expect(r.cases).toHaveLength(1);
    expect(r.cases[0]?.fields.nextStep).toBe("Callback within one business day");
  });

  it("[SPEC-8.4] interaction and issue are separate: one call addresses several Cases and a repeat call links an existing Case", async () => {
    const first = newId("int");
    const repeat = newId("int");
    const billing = newId("iss");
    const appointment = newId("iss");
    await sf.upsertInteraction(first, interaction());
    await sf.upsertInteraction(repeat, interaction(CALLS.repeat.callId));
    await sf.upsertCase(billing, first, caseFields({ issueCategory: "billing_dispute", ownerQueue: "q_billing" }));
    await sf.upsertCase(appointment, first, caseFields());
    await sf.upsertCase(billing, repeat, caseFields({ issueCategory: "case_follow_up", ownerQueue: "q_billing", sourceCallIds: [CALLS.primary.callId, CALLS.repeat.callId] }));
    expect(sf.casesForInteraction(first)).toEqual([appointment, billing].sort());
    expect(sf.interactionsForCase(billing)).toEqual([first, repeat].sort());
    expect(sf.records().cases).toHaveLength(2);
    expect(sf.records().links).toHaveLength(3);
  });

  it("[ACT-04] a created Case is not a resolution: status is managed in Salesforce and an upsert never resets it", async () => {
    const call = newId("int");
    const issue = newId("iss");
    await sf.upsertInteraction(call, interaction());
    await sf.upsertCase(issue, call, caseFields({ disposition: "REQUEST_ACCEPTED" }));
    expect((await sf.getCaseByExternalId(issue))?.status).toBe(FIXTURE_NEW_CASE_STATUS);
    sf.setCaseStatus(issue, "WORKING");
    await sf.upsertCase(issue, call, caseFields());
    expect(await sf.getCaseByExternalId(issue)).toMatchObject({ status: "WORKING", ownerQueue: "q_scheduling" });
  });

  it("[SPEC-8.4] privacy / safety events are stored as RESTRICTED records and stay restricted", async () => {
    const call = newId("int");
    const issue = newId("iss");
    await sf.upsertInteraction(call, interaction());
    await sf.upsertCase(issue, call, caseFields({ issueCategory: "privacy_concern", restricted: true, priority: "P2_URGENT", ownerQueue: "q_privacy" }));
    await sf.upsertCase(issue, call, caseFields({ issueCategory: "privacy_concern", restricted: false, ownerQueue: "q_privacy" }));
    expect(sf.records().cases[0]?.visibility).toBe("RESTRICTED");
  });

  it("[SPEC-8.4] Salesforce outage fails NOT_STARTED with nothing written (caller keeps an internal support reference)", async () => {
    faults.inject({ integrationId: "salesforce", operation: "*", kind: "OUTAGE", mode: "persistent" });
    expect(await sf.health()).toEqual({ healthy: false, reasonCode: "DEPENDENCY_UNAVAILABLE" });
    expect(await rejection(sf.upsertInteraction(newId("int"), interaction()))).toMatchObject({ reasonCode: "CONNECTION_REFUSED", outcome: "NOT_STARTED", retryable: true });
    expect(await rejection(sf.getCaseByExternalId(newId("iss")))).toMatchObject({ outcome: "NOT_STARTED" });
    expect(sf.records().interactions).toHaveLength(0);
  });

  it("[ACT-03] timeout after the write: the record exists, the outcome is UNKNOWN, reconciliation by external id finds it, the retry does not duplicate", async () => {
    const call = newId("int");
    const issue = newId("iss");
    await sf.upsertInteraction(call, interaction());
    faults.inject({ integrationId: "salesforce", operation: "upsertCase", kind: "TIMEOUT_AFTER_COMMIT" });
    expect(await rejection(sf.upsertCase(issue, call, caseFields()))).toMatchObject({ reasonCode: "TIMEOUT_AFTER_SEND", outcome: "UNKNOWN" });
    const found = await sf.getCaseByExternalId(issue);
    expect(found).not.toBeNull();
    expect(await sf.upsertCase(issue, call, caseFields())).toEqual({ caseId: found?.caseId, created: false });
    expect(sf.records().cases).toHaveLength(1);
  });

  it("[ACT-02] PARTIAL_WRITE (Case written, link missing) and DUPLICATE_DELIVERY heal through idempotent upserts", async () => {
    const call = newId("int");
    const issue = newId("iss");
    await sf.upsertInteraction(call, interaction());
    faults.inject({ integrationId: "salesforce", operation: "upsertCase", kind: "PARTIAL_WRITE" });
    expect(await rejection(sf.upsertCase(issue, call, caseFields()))).toMatchObject({ reasonCode: "PARTIAL_WRITE", outcome: "UNKNOWN" });
    expect(sf.records().cases).toHaveLength(1);
    expect(sf.records().links).toHaveLength(0);
    await sf.upsertCase(issue, call, caseFields());
    expect(sf.records().links).toHaveLength(1);

    faults.inject({ integrationId: "salesforce", operation: "upsertInteraction", kind: "DUPLICATE_DELIVERY" });
    const dupCall = newId("int");
    const r = await sf.upsertInteraction(dupCall, interaction());
    expect(r.created).toBe(true);
    expect(sf.deliveries).toBeGreaterThanOrEqual(2);
    expect(sf.records().interactions.filter((i) => i.externalId === dupCall)).toHaveLength(1);
    expect(sf.records().interactions.find((i) => i.externalId === dupCall)?.writes).toBe(2);
  });

  it("[SPEC-12.caching] API calls are counted so callers can prove they do not pull Salesforce every turn", async () => {
    const issue = newId("iss");
    await sf.getCaseByExternalId(issue);
    await sf.getCaseByExternalId(issue);
    expect(sf.apiCallCount("getCaseByExternalId")).toBe(2);
  });

  it("[ACT-02] strict validation: unknown fields, unbounded summaries, bad external ids and a missing interaction are rejected", async () => {
    const call = newId("int");
    await expect(sf.upsertInteraction("call-123", interaction())).rejects.toBeInstanceOf(ValidationError);
    await expect(sf.upsertInteraction(call, { ...interaction(), transcript: "full transcript" } as never)).rejects.toMatchObject({ reasonCode: "SUPPORT_INTERACTION_FIELDS_INVALID" });
    await sf.upsertInteraction(call, interaction());
    await expect(sf.upsertCase(newId("iss"), call, { ...caseFields(), summary: "x".repeat(601) })).rejects.toMatchObject({ reasonCode: "SUPPORT_CASE_FIELDS_INVALID" });
    await expect(sf.upsertCase(newId("iss"), call, { ...caseFields(), issueCategory: "diagnosis" as never })).rejects.toMatchObject({ reasonCode: "SUPPORT_CASE_FIELDS_INVALID" });
    await expect(sf.upsertCase(newId("iss"), newId("int"), caseFields())).rejects.toMatchObject({ reasonCode: "SUPPORT_INTERACTION_NOT_FOUND" });
    expect(sf.records().cases).toHaveLength(0);
  });
});
