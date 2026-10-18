import { beforeEach, describe, expect, it } from "vitest";
import { INVOICES, PEOPLE } from "../../fixtures/synthetic-world.js";
import { FakeClock } from "../../shared/clock.js";
import { ConflictError, PlatformError, ValidationError } from "../../shared/errors.js";
import { BillingFixture, LOCAL_FIXTURE_PAYMENT_PATH } from "./billing-fixture.js";
import { FaultInjector } from "./faults.js";
import { SyntheticStore } from "./synthetic-store.js";

const AVERY_INV = INVOICES[0].invoiceId;
const key = (n: string) => `idem-billing-review-${n}-00000`;

let store: SyntheticStore;
let faults: FaultInjector;
let billing: BillingFixture;

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
  store = new SyntheticStore();
  faults = new FaultInjector();
  billing = new BillingFixture({ store, faults, clock: new FakeClock() });
});

describe("BillingFixture (LOCAL FIXTURE, SYNTHETIC)", () => {
  it("[SPEC-4.billing] invoices are authoritative line codes and integer minor units only", async () => {
    const [inv] = await billing.listInvoices(PEOPLE.avery.subjectId);
    expect(inv).toEqual({
      invoiceId: AVERY_INV,
      subjectId: PEOPLE.avery.subjectId,
      issuedOn: "2026-10-01",
      dueOn: "2026-10-31",
      status: "OPEN",
      lines: INVOICES[0].lines.map((l) => ({ ...l })),
      balanceMinor: 10_000,
      currency: "USD",
      version: "v1",
    });
    expect(inv?.lines.every((l) => Number.isInteger(l.amountMinor))).toBe(true);
    expect(await billing.getInvoice("inv_synthDoesNotExist001")).toBeNull();
  });

  it("[ACT-04] marking a disputed invoice in review changes only its status — no refund, fee waiver or balance change", async () => {
    const r = await billing.markInReview({ invoiceId: AVERY_INV, beforeVersion: "v1", idempotencyKey: key("a") });
    expect(r.reference).toMatch(/^bilrev_/);
    expect(r.invoice.status).toBe("IN_REVIEW");
    expect(r.invoice.version).toBe("v2");
    expect(r.invoice.balanceMinor).toBe(INVOICES[0].balanceMinor);
    expect(r.invoice.lines).toEqual(INVOICES[0].lines.map((l) => ({ ...l })));
    expect(billing.effects).toHaveLength(1);
  });

  it("[ACT-02] markInReview is idempotent by key and findReviewByIdempotencyKey returns the committed review", async () => {
    const input = { invoiceId: AVERY_INV, beforeVersion: "v1", idempotencyKey: key("b") };
    const first = await billing.markInReview(input);
    expect(await billing.markInReview(input)).toEqual(first);
    expect(billing.effects).toHaveLength(1);
    expect(await billing.findReviewByIdempotencyKey(input.idempotencyKey)).toEqual(first);
    // A different key for the already-in-review invoice is not a second review.
    expect(await rejection(billing.markInReview({ ...input, beforeVersion: "v2", idempotencyKey: key("c") }))).toMatchObject({ reasonCode: "INVOICE_NOT_REVIEWABLE" });
  });

  it("[ACT-02] DUPLICATE_DELIVERY of a review request creates exactly one review", async () => {
    faults.inject({ integrationId: "billing", operation: "markInReview", kind: "DUPLICATE_DELIVERY" });
    await billing.markInReview({ invoiceId: AVERY_INV, beforeVersion: "v1", idempotencyKey: key("d") });
    expect(billing.deliveries).toBe(2);
    expect(billing.effects).toHaveLength(1);
  });

  it("[ACT-03] TIMEOUT_AFTER_COMMIT is UNKNOWN with the review recorded; lookup by key reconciles it", async () => {
    faults.inject({ integrationId: "billing", operation: "markInReview", kind: "TIMEOUT_AFTER_COMMIT" });
    const input = { invoiceId: AVERY_INV, beforeVersion: "v1", idempotencyKey: key("e") };
    expect(await rejection(billing.markInReview(input))).toMatchObject({ reasonCode: "TIMEOUT_AFTER_SEND", outcome: "UNKNOWN" });
    const found = await billing.findReviewByIdempotencyKey(input.idempotencyKey);
    expect(found?.invoice.status).toBe("IN_REVIEW");
    expect(found?.reference).toBe(billing.effects[0]?.reference);
    expect(await billing.markInReview(input)).toEqual(found);
    expect(billing.effects).toHaveLength(1);
  });

  it("[SPEC-14.faults] PARTIAL_WRITE allocates the review without moving the invoice; the same-key retry completes it with the same reference", async () => {
    faults.inject({ integrationId: "billing", operation: "markInReview", kind: "PARTIAL_WRITE" });
    const input = { invoiceId: AVERY_INV, beforeVersion: "v1", idempotencyKey: key("f") };
    expect(await rejection(billing.markInReview(input))).toMatchObject({ reasonCode: "PARTIAL_WRITE", outcome: "UNKNOWN" });
    expect(billing.partialWrites).toEqual([input.idempotencyKey]);
    expect(await billing.findReviewByIdempotencyKey(input.idempotencyKey)).toBeNull();
    expect((await billing.getInvoice(AVERY_INV))?.status).toBe("OPEN");
    const done = await billing.markInReview(input);
    expect(done.invoice.status).toBe("IN_REVIEW");
    expect(billing.partialWrites).toEqual([]);
    expect(billing.effects).toHaveLength(1);
  });

  it("[SPEC-16.journey] a stale invoice version is a STATE_CHANGED conflict", async () => {
    billing.simulateConcurrentChange(AVERY_INV);
    const err = await rejection(billing.markInReview({ invoiceId: AVERY_INV, beforeVersion: "v1", idempotencyKey: key("g") }));
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.reasonCode).toBe("STATE_CHANGED");
    expect(billing.effects).toHaveLength(0);
  });

  it("[DATA-01] payment uses the approved hosted portal path — no identifiers or card data in the path; non-payable invoices are refused", async () => {
    expect(await billing.hostedPaymentPath(AVERY_INV)).toEqual({ portalPath: LOCAL_FIXTURE_PAYMENT_PATH });
    await billing.markInReview({ invoiceId: AVERY_INV, beforeVersion: "v1", idempotencyKey: key("h") });
    expect(await rejection(billing.hostedPaymentPath(AVERY_INV))).toMatchObject({ reasonCode: "INVOICE_NOT_PAYABLE" });
    expect(() => new BillingFixture({ store, paymentPortalPath: "https://pay.example.invalid/card?number=4111111111111111" })).toThrow(ValidationError);
    expect(() => new BillingFixture({ store, paymentPortalPath: "/billing/pay/41111111" })).toThrow(ValidationError);
  });

  it("[ACT-02] strict input validation and read faults", async () => {
    await expect(billing.markInReview({ invoiceId: AVERY_INV, beforeVersion: "v1", idempotencyKey: key("i"), refundMinor: 7500 } as never)).rejects.toMatchObject({
      reasonCode: "BILLING_INPUT_INVALID",
    });
    faults.inject({ integrationId: "billing", operation: "getInvoice", kind: "OUTAGE" });
    expect(await rejection(billing.getInvoice(AVERY_INV))).toMatchObject({ reasonCode: "CONNECTION_REFUSED", outcome: "NOT_STARTED" });
    await billing.markInReview({ invoiceId: AVERY_INV, beforeVersion: "v1", idempotencyKey: key("j") });
    faults.inject({ integrationId: "billing", operation: "listInvoices", kind: "STALE_READ" });
    expect((await billing.listInvoices(PEOPLE.avery.subjectId))[0]?.status).toBe("OPEN");
    expect((await billing.listInvoices(PEOPLE.avery.subjectId))[0]?.status).toBe("IN_REVIEW");
  });
});
