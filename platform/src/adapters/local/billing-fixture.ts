/**
 * LOCAL FIXTURE — BillingSystem over the SYNTHETIC world. NOT a vendor adapter;
 * rejected by the production configuration guard (OPS-04). The live billing
 * adapter is BLOCKED (live/business-systems-blocked.ts, PRQ-007, PRQ-050).
 *
 * Boundaries enforced (spec section 4):
 *  - invoices are returned from authoritative fields only (line codes, dates,
 *    integer minor units); explanation never decides insurance coverage;
 *  - `markInReview` only moves an OPEN invoice to IN_REVIEW. It never changes
 *    lines or balance: no fee waiver, no refund, no promise of either;
 *  - `hostedPaymentPath` returns an APPROVED portal path from configuration —
 *    the payment happens on a hosted page; card numbers and security codes are
 *    never collected by voice. The default path is a LOCAL FIXTURE placeholder
 *    until the billing owner approves the hosted payment page (PRQ-050). The path
 *    carries no identifiers: the portal shows the invoice after sign-in.
 *  - idempotency keys and lookup-by-key for reconciliation (ACT-02, ACT-03);
 *  - faults from the shared FaultInjector. PARTIAL_WRITE allocates the review
 *    reference without moving the invoice; a retry with the same key completes it.
 */
import { z } from "zod";
import { silentLogger } from "../../observability/logger.js";
import type { Logger } from "../../observability/ports.js";
import { OpaqueId } from "../../protocol/index.js";
import { iso, systemClock, type Clock } from "../../shared/clock.js";
import { ConflictError, PlatformError, ValidationError } from "../../shared/errors.js";
import { newId } from "../../shared/ids.js";
import type { AdapterHealth, BillingSystem, Invoice } from "../ports.js";
import { READ_FAULTS, WRITE_FAULTS, noFaults, type ActiveFaults, type FaultInjector } from "./faults.js";
import { IdempotencyKey, IdempotencyLedger, requestDigest } from "./idempotency.js";
import { LOCAL_FIXTURE_LABEL, type StoredInvoice, type SyntheticStore } from "./synthetic-store.js";

/** LOCAL FIXTURE placeholder — not an approved production payment path (PRQ-050). */
export const LOCAL_FIXTURE_PAYMENT_PATH = "/billing/pay";
const PORTAL_PATH = /^\/[a-z0-9_-]{1,32}(\/[a-z0-9_-]{1,32}){0,3}$/;

const MarkInReviewInput = z.strictObject({
  invoiceId: OpaqueId,
  beforeVersion: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
  idempotencyKey: IdempotencyKey,
});

export type BillingReviewResult = { invoice: Invoice; reference: string };

export interface BillingEffect {
  sequence: number;
  operation: "markInReview";
  idempotencyKey: string;
  invoiceId: string;
  beforeVersion: string;
  afterVersion: string;
  reference: string;
  at: string;
}

export interface BillingFixtureOptions {
  store: SyntheticStore;
  faults?: FaultInjector;
  clock?: Clock;
  logger?: Logger;
  /** Approved hosted payment portal path (no query string, no identifiers). */
  paymentPortalPath?: string;
}

export const BILLING_FIXTURE_OPERATIONS = {
  listInvoices: READ_FAULTS,
  getInvoice: READ_FAULTS,
  hostedPaymentPath: ["OUTAGE", "TIMEOUT_BEFORE_SEND", "SLOW", "QUOTA_EXHAUSTED"],
  markInReview: WRITE_FAULTS,
  findReviewByIdempotencyKey: ["OUTAGE", "TIMEOUT_BEFORE_SEND", "SLOW", "QUOTA_EXHAUSTED"],
} as const;

const toInvoice = (i: StoredInvoice): Invoice => ({
  invoiceId: i.invoiceId,
  subjectId: i.subjectId,
  issuedOn: i.issuedOn,
  dueOn: i.dueOn,
  status: i.status,
  lines: i.lines.map((l) => ({ lineId: l.lineId, code: l.code, serviceDate: l.serviceDate, amountMinor: l.amountMinor })),
  balanceMinor: i.balanceMinor,
  currency: i.currency,
  version: i.version,
});

export class BillingFixture implements BillingSystem {
  readonly kind = "local_fixture" as const;
  readonly integrationId = "billing";
  readonly label = LOCAL_FIXTURE_LABEL;
  private readonly store: SyntheticStore;
  private readonly faults: FaultInjector;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly paymentPortalPath: string;
  private readonly ledger = new IdempotencyLedger<BillingReviewResult>();
  /** PARTIAL_WRITE first step: reference allocated, invoice not yet moved. */
  private readonly pending = new Map<string, { digest: string; reference: string }>();
  private readonly effectLog: BillingEffect[] = [];
  private deliveryCount = 0;

  constructor(opts: BillingFixtureOptions) {
    this.store = opts.store;
    this.faults = opts.faults ?? noFaults();
    this.clock = opts.clock ?? systemClock;
    this.logger = (opts.logger ?? silentLogger).child({ component: "billing_fixture" });
    const path = opts.paymentPortalPath ?? LOCAL_FIXTURE_PAYMENT_PATH;
    if (!PORTAL_PATH.test(path) || /\d{4,}/.test(path)) throw new ValidationError("PAYMENT_PORTAL_PATH_INVALID");
    this.paymentPortalPath = path;
    this.faults.declare(this.integrationId, BILLING_FIXTURE_OPERATIONS);
  }

  async health(): Promise<AdapterHealth> {
    return this.faults.isDegraded(this.integrationId) ? { healthy: false, reasonCode: "DEPENDENCY_UNAVAILABLE" } : { healthy: true, reasonCode: null };
  }

  async listInvoices(subjectId: string): Promise<Invoice[]> {
    if (!OpaqueId.safeParse(subjectId).success) throw new ValidationError("BILLING_INPUT_INVALID");
    const f = await this.read("listInvoices");
    const rows = f.has("STALE_READ") ? this.store.staleList("invoices") : this.store.list("invoices");
    return rows
      .filter((i) => i.subjectId === subjectId)
      .sort((a, b) => a.issuedOn.localeCompare(b.issuedOn) || a.invoiceId.localeCompare(b.invoiceId))
      .map(toInvoice);
  }

  async getInvoice(invoiceId: string): Promise<Invoice | null> {
    if (!OpaqueId.safeParse(invoiceId).success) throw new ValidationError("BILLING_INPUT_INVALID");
    const f = await this.read("getInvoice");
    const i = f.has("STALE_READ") ? this.store.staleGet("invoices", invoiceId) : this.store.get("invoices", invoiceId);
    return i ? toInvoice(i) : null;
  }

  async hostedPaymentPath(invoiceId: string): Promise<{ portalPath: string }> {
    if (!OpaqueId.safeParse(invoiceId).success) throw new ValidationError("BILLING_INPUT_INVALID");
    await this.read("hostedPaymentPath");
    const inv = this.store.get("invoices", invoiceId);
    if (!inv) throw new ValidationError("INVOICE_NOT_FOUND");
    if (inv.status !== "OPEN" || inv.balanceMinor <= 0) throw new ConflictError("INVOICE_NOT_PAYABLE");
    return { portalPath: this.paymentPortalPath };
  }

  async markInReview(input: { invoiceId: string; beforeVersion: string; idempotencyKey: string }): Promise<BillingReviewResult> {
    const parsed = MarkInReviewInput.safeParse(input);
    if (!parsed.success) throw new ValidationError("BILLING_INPUT_INVALID");
    const req = parsed.data;
    const digest = requestDigest("markInReview", { invoiceId: req.invoiceId, beforeVersion: req.beforeVersion });
    const f = this.faults.begin(this.integrationId, "markInReview");
    await f.beforeSend();
    const copies = f.has("DUPLICATE_DELIVERY") ? 2 : 1;
    let result: BillingReviewResult | null = null;
    for (let delivery = 1; delivery <= copies; delivery++) {
      this.deliveryCount += 1;
      try {
        const r = this.applyMarkInReview(req, digest, f, delivery > 1);
        result ??= r;
      } catch (err) {
        this.logger.info("fixture.billing.review.rejected", { reasonCode: err instanceof PlatformError ? err.reasonCode : "UNCLASSIFIED_ERROR" });
        throw err;
      }
    }
    f.afterCommit();
    if (result === null) throw new ValidationError("BILLING_FIXTURE_NO_RESULT");
    return result;
  }

  async findReviewByIdempotencyKey(idempotencyKey: string): Promise<BillingReviewResult | null> {
    if (!IdempotencyKey.safeParse(idempotencyKey).success) throw new ValidationError("BILLING_INPUT_INVALID");
    await this.read("findReviewByIdempotencyKey");
    return this.ledger.find(idempotencyKey);
  }

  // ---------------- LOCAL FIXTURE test helpers ----------------

  get effects(): readonly BillingEffect[] {
    return this.effectLog.map((e) => ({ ...e }));
  }

  /** Write deliveries received, including DUPLICATE_DELIVERY copies. */
  get deliveries(): number {
    return this.deliveryCount;
  }

  /** Idempotency keys whose write is only partially applied. */
  get partialWrites(): string[] {
    return [...this.pending.keys()];
  }

  /** Simulates another channel changing the invoice (its version advances). */
  simulateConcurrentChange(invoiceId: string): void {
    this.store.update("invoices", invoiceId, () => undefined);
  }

  // ---------------- internals ----------------

  private async read(operation: keyof typeof BILLING_FIXTURE_OPERATIONS): Promise<ActiveFaults> {
    const f = this.faults.begin(this.integrationId, operation);
    await f.beforeSend();
    return f;
  }

  private applyMarkInReview(req: z.infer<typeof MarkInReviewInput>, digest: string, f: ActiveFaults, duplicate: boolean): BillingReviewResult {
    const prior = this.ledger.replay(req.idempotencyKey, digest);
    if (prior) return prior;
    const pending = this.pending.get(req.idempotencyKey);
    if (pending && pending.digest !== digest) throw new ConflictError("IDEMPOTENCY_KEY_REUSED");

    const inv = this.store.get("invoices", req.invoiceId);
    if (!inv) throw new ValidationError("INVOICE_NOT_FOUND");
    if (inv.version !== req.beforeVersion) {
      this.pending.delete(req.idempotencyKey);
      throw new ConflictError("STATE_CHANGED");
    }
    if (inv.status !== "OPEN") throw new ConflictError("INVOICE_NOT_REVIEWABLE");

    const reference = pending?.reference ?? newId("bilrev");
    if (f.has("PARTIAL_WRITE") && !pending && !duplicate) {
      this.pending.set(req.idempotencyKey, { digest, reference });
      throw f.partialWriteError();
    }
    const updated = this.store.update("invoices", inv.invoiceId, (d) => {
      d.status = "IN_REVIEW";
    });
    this.pending.delete(req.idempotencyKey);
    const result: BillingReviewResult = { invoice: toInvoice(updated), reference };
    const at = iso(this.clock.now());
    this.ledger.record(req.idempotencyKey, digest, result, at);
    this.effectLog.push({
      sequence: this.store.nextSequence(),
      operation: "markInReview",
      idempotencyKey: req.idempotencyKey,
      invoiceId: inv.invoiceId,
      beforeVersion: inv.version,
      afterVersion: updated.version,
      reference,
      at,
    });
    this.logger.info("fixture.billing.review.committed", { invoiceId: inv.invoiceId });
    return result;
  }
}
