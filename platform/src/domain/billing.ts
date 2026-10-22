/**
 * Billing and claims status over the canonical contracts (WP-23; FO-06-72, FO-06-76, FO-11-02).
 *
 * `HttpBilling` serves the canonical, party-scoped reads (invoices with lines, payments the billing system
 * received) and the BillingSystem port of platform/src/adapters/ports.ts (structurally) for the business layer:
 * invoice reads, the tenant's approved hosted payment page path (configuration, never a card collection path) and
 * the one write, a review request that puts the invoice IN_REVIEW without changing an amount. `HttpClaims` serves
 * insurer-reported claim status only: never an eligibility or payment guarantee.
 */
import type { MappedRecord } from "../connectors/dsl/mapping.js";
import { ConflictError, DependencyError, ValidationError } from "../shared/errors.js";
import type { ActingParty } from "./authority.js";
import { ChangeRequests, requestIdFor } from "./changes.js";
import type { ChangeState } from "./changes.js";
import type { CanonicalClaimStatus, CanonicalInvoice, CanonicalPayment, DomainRead, SourceRef } from "./contracts.js";
import { CanonicalClaimStatus as ClaimSchema, CanonicalInvoice as InvoiceSchema, CanonicalPayment as PaymentSchema } from "./contracts.js";
import type { DomainConnector } from "./runner.js";
import { int, orNull, readSafely, single, str } from "./runner.js";
import { refusalOf } from "./scheduling.js";

/** Same shape as platform/src/adapters/ports.ts Invoice (structural). */
export interface PortInvoice {
  invoiceId: string;
  subjectId: string;
  issuedOn: string;
  dueOn: string;
  status: "OPEN" | "PAID" | "IN_REVIEW" | "VOID";
  lines: { lineId: string; code: "SESSION_FEE" | "LATE_CANCELLATION" | "NO_SHOW" | "ADJUSTMENT" | "PAYMENT"; serviceDate: string; amountMinor: number }[];
  balanceMinor: number;
  currency: "USD";
  version: string;
}

/** Same shape as platform/src/adapters/ports.ts ClaimStatus (structural). */
export interface PortClaimStatus {
  claimId: string;
  subjectId: string;
  serviceDate: string;
  payerDisplayName: string;
  insurerStatus: "RECEIVED" | "IN_PROCESS" | "ADJUDICATED_PAID" | "ADJUDICATED_DENIED" | "NEEDS_INFORMATION";
  statusAsOf: string;
}

const clientOnly = <T>(party: ActingParty, fn: () => Promise<DomainRead<T>>): Promise<DomainRead<T>> =>
  party.role === "client" ? fn() : Promise.resolve({ status: "UNAVAILABLE", reasonCode: "DOMAIN_ROLE_NOT_SUPPORTED", outcome: "NOT_STARTED", nextStep: "OFFER_HUMAN_OR_CALLBACK" });

export class HttpBilling {
  readonly kind = "live" as const;
  readonly integrationId = "billing";
  readonly changes: ChangeRequests;

  constructor(readonly conn: DomainConnector) {
    if (conn.binding.binding.contract !== "billing.v1") throw new ValidationError("DOMAIN_BINDING_CONTRACT_MISMATCH");
    this.changes = new ChangeRequests(conn);
  }

  async health(): Promise<{ healthy: boolean; reasonCode: string | null }> {
    return this.conn.runner.health();
  }

  private invoiceOf(r: MappedRecord, lines: MappedRecord[], source: SourceRef): CanonicalInvoice {
    const parsed = InvoiceSchema.safeParse({
      invoiceId: str(r, "invoiceId"),
      subjectId: str(r, "subjectId"),
      issuedOn: str(r, "issuedOn"),
      dueOn: str(r, "dueOn"),
      status: str(r, "status"),
      balanceMinor: int(r, "balanceMinor"),
      currency: str(r, "currency"),
      version: str(r, "version"),
      lines: lines.map((l) => ({ lineId: str(l, "lineId"), code: str(l, "code"), serviceDate: str(l, "serviceDate"), amountMinor: int(l, "amountMinor") })),
      source,
    });
    if (!parsed.success) throw new ValidationError("DOMAIN_RECORD_INVALID");
    return parsed.data;
  }

  async invoice(invoiceId: string): Promise<CanonicalInvoice | null> {
    return orNull(async () => {
      const result = await this.conn.run("getInvoice", { params: { invoiceId } });
      const lines = await this.conn.all("listInvoiceLines", { params: { invoiceId } });
      return this.invoiceOf(single(result), [...lines.records], this.conn.source(result));
    });
  }

  async invoicesOf(subjectId: string): Promise<CanonicalInvoice[]> {
    const list = await this.conn.all("listInvoices", { params: { subjectId } });
    const out: CanonicalInvoice[] = [];
    for (const r of list.records) {
      const lines = await this.conn.all("listInvoiceLines", { params: { invoiceId: str(r, "invoiceId") } });
      out.push(this.invoiceOf(r, [...lines.records], list.source));
    }
    return out;
  }

  /** Payments the billing system itself received (fresher than any warehouse copy). */
  async payments(invoiceId: string): Promise<CanonicalPayment[]> {
    const { records, source } = await this.conn.all("listPayments", { params: { invoiceId } });
    return records.map((r) => {
      const parsed = PaymentSchema.safeParse({ paymentId: str(r, "paymentId"), invoiceId: str(r, "invoiceId"), amountMinor: int(r, "amountMinor"), receivedAt: str(r, "receivedAt"), method: str(r, "method"), source });
      if (!parsed.success) throw new ValidationError("DOMAIN_RECORD_INVALID");
      return parsed.data;
    });
  }

  // ---------------------------------------------------------------- party-scoped reads (AUTH-05)

  readInvoices(party: ActingParty): Promise<DomainRead<CanonicalInvoice[]>> {
    return clientOnly(party, () => readSafely(async () => (await this.invoicesOf(party.partyRef)).filter((i) => i.subjectId === party.partyRef)));
  }

  readInvoice(party: ActingParty, invoiceId: string): Promise<DomainRead<CanonicalInvoice>> {
    return clientOnly(party, () =>
      readSafely(async () => {
        const i = await this.invoice(invoiceId);
        return i !== null && i.subjectId === party.partyRef ? i : null;
      }),
    );
  }

  readPayments(party: ActingParty, invoiceId: string): Promise<DomainRead<CanonicalPayment[]>> {
    return clientOnly(party, () =>
      readSafely(async () => {
        const i = await this.invoice(invoiceId);
        if (i === null || i.subjectId !== party.partyRef) return null;
        return this.payments(invoiceId);
      }),
    );
  }

  // ---------------------------------------------------------------- BillingSystem port (platform/src/adapters/ports.ts)

  async listInvoices(subjectId: string): Promise<PortInvoice[]> {
    return (await this.invoicesOf(subjectId)).filter((i) => i.subjectId === subjectId).map(toPortInvoice);
  }

  async getInvoice(invoiceId: string): Promise<PortInvoice | null> {
    const i = await this.invoice(invoiceId);
    return i ? toPortInvoice(i) : null;
  }

  /** The tenant's approved hosted payment page path (binding configuration); card data is never collected by voice. */
  async hostedPaymentPath(invoiceId: string): Promise<{ portalPath: string }> {
    const template = this.conn.binding.binding.paymentPortalPath;
    if (template === null) throw new ValidationError("PAYMENT_PORTAL_NOT_CONFIGURED");
    if (!/^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$/.test(invoiceId)) throw new ValidationError("INVOICE_ID_INVALID");
    return { portalPath: template.replace("{invoiceId}", invoiceId) };
  }

  /**
   * Business-port review request, CLIENT_CONFIRMED by `actingPartyId`, which the caller takes from the confirmed
   * action (its subject); refused before any request without it (the invoice's own client is never assumed). The
   * body follows from the input alone, so a redelivery under the same key is replayed by the system.
   */
  async markInReview(input: { invoiceId: string; beforeVersion: string; idempotencyKey: string; actingPartyId?: string }): Promise<{ invoice: PortInvoice; reference: string }> {
    if (input.actingPartyId === undefined) throw new ConflictError("ACTING_PARTY_REQUIRED");
    const requestId = requestIdFor(input.idempotencyKey);
    let change: ChangeState;
    try {
      change = await this.changes.submit("requestReview", requestId, {
        invoiceId: input.invoiceId,
        expectedVersion: input.beforeVersion,
        reasonCode: "CHARGE_QUESTIONED",
        authority: "CLIENT_CONFIRMED",
        actingPartyId: input.actingPartyId,
      });
    } catch (e) {
      return refusalOf(e, "record");
    }
    return this.committed(change);
  }

  /** Reconciliation by key (see HttpScheduling.findByIdempotencyKey: an absence is never definitive here). */
  async findReviewByIdempotencyKey(idempotencyKey: string): Promise<{ invoice: PortInvoice; reference: string } | null> {
    const requestId = requestIdFor(idempotencyKey);
    let found = await this.changes.lookup("requestReview", requestId);
    if (found === null) throw new DependencyError("RECONCILE_ABSENCE_NOT_DEFINITIVE", "UNKNOWN", false);
    if (found.state === "REJECTED") return null;
    if (found.state === "INCOMPLETE") {
      if (this.conn.binding.binding.reconciliation?.incompleteWrite !== "COMPLETE_BY_REQUEST_ID") throw new DependencyError("INCOMPLETE_WRITE_ROUTED_TO_HUMAN", "UNKNOWN", false);
      found = await this.changes.complete(requestId);
    }
    return this.committed(found);
  }

  private async committed(change: ChangeState): Promise<{ invoice: PortInvoice; reference: string }> {
    if (change.state !== "COMPLETED" || change.receiptId === null || change.resourceId === null) throw new DependencyError("RECEIPT_MISSING", "UNKNOWN", false);
    const inv = await this.invoice(change.resourceId);
    if (!inv) throw new DependencyError("RECEIPT_TARGET_NOT_READABLE", "UNKNOWN", false);
    return { invoice: toPortInvoice(inv), reference: change.receiptId };
  }
}

export const toPortInvoice = (i: CanonicalInvoice): PortInvoice => ({
  invoiceId: i.invoiceId,
  subjectId: i.subjectId,
  issuedOn: i.issuedOn,
  dueOn: i.dueOn,
  status: i.status,
  lines: i.lines.map((l) => ({ ...l })),
  balanceMinor: i.balanceMinor,
  currency: i.currency,
  version: i.version,
});

export class HttpClaims {
  readonly kind = "live" as const;
  readonly integrationId = "claims";

  constructor(readonly conn: DomainConnector) {
    if (conn.binding.binding.contract !== "claims.v1") throw new ValidationError("DOMAIN_BINDING_CONTRACT_MISMATCH");
  }

  async health(): Promise<{ healthy: boolean; reasonCode: string | null }> {
    return this.conn.runner.health();
  }

  private claimOf(r: MappedRecord, source: SourceRef): CanonicalClaimStatus {
    const parsed = ClaimSchema.safeParse({
      claimId: str(r, "claimId"),
      subjectId: str(r, "subjectId"),
      serviceDate: str(r, "serviceDate"),
      payerDisplayName: str(r, "payerDisplayName"),
      insurerStatus: str(r, "insurerStatus"),
      statusAsOf: str(r, "statusAsOf"),
      source,
    });
    if (!parsed.success) throw new ValidationError("DOMAIN_RECORD_INVALID");
    return parsed.data;
  }

  async claim(claimId: string): Promise<CanonicalClaimStatus | null> {
    return orNull(async () => {
      const result = await this.conn.run("getClaim", { params: { claimId } });
      return this.claimOf(single(result), this.conn.source(result));
    });
  }

  async claimsOf(subjectId: string): Promise<CanonicalClaimStatus[]> {
    const { records, source } = await this.conn.all("listClaims", { params: { subjectId } });
    return records.map((r) => this.claimOf(r, source));
  }

  readClaims(party: ActingParty): Promise<DomainRead<CanonicalClaimStatus[]>> {
    return clientOnly(party, () => readSafely(async () => (await this.claimsOf(party.partyRef)).filter((c) => c.subjectId === party.partyRef)));
  }

  readClaim(party: ActingParty, claimId: string): Promise<DomainRead<CanonicalClaimStatus>> {
    return clientOnly(party, () =>
      readSafely(async () => {
        const c = await this.claim(claimId);
        return c !== null && c.subjectId === party.partyRef ? c : null;
      }),
    );
  }

  // ClaimsSystem port (platform/src/adapters/ports.ts)
  async listClaims(subjectId: string): Promise<PortClaimStatus[]> {
    return (await this.claimsOf(subjectId)).filter((c) => c.subjectId === subjectId).map(toPortClaim);
  }

  async getClaim(claimId: string): Promise<PortClaimStatus | null> {
    const c = await this.claim(claimId);
    return c ? toPortClaim(c) : null;
  }
}

const toPortClaim = (c: CanonicalClaimStatus): PortClaimStatus => ({
  claimId: c.claimId,
  subjectId: c.subjectId,
  serviceDate: c.serviceDate,
  payerDisplayName: c.payerDisplayName,
  insurerStatus: c.insurerStatus,
  statusAsOf: c.statusAsOf,
});
