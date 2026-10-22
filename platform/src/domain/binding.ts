/**
 * Domain bindings (WP-23; FO-06-74, FO-06-75, FO-19-21): how one admitted ConnectorProfile serves one canonical
 * domain contract. A binding names, for each canonical operation of the contract, the reviewed profile operation
 * that performs it, and declares the reconciliation path of the system's writes: the lookup operation, the
 * documented visibility window of that lookup, and how an incomplete multi-step write is completed.
 *
 * `validateBinding` is the admission rule for live use (reason codes only):
 *   - every operation the contract needs is mapped to an enabled profile operation of the right kind;
 *   - every write is reconcilable: it declares a lookup in the profile and that lookup is the binding's
 *     reconciliation lookup. A NOT_IDEMPOTENT write without a declared lookup is refused
 *     (BINDING_NON_IDEMPOTENT_WITHOUT_RECONCILIATION), and so is any write without one (FO-06-75);
 *   - completing incomplete writes by request id needs a completion operation (a write keyed by the same id);
 *   - a binding that relies on the system's dispatch deadline (REQUEST_NOT_AFTER: the system gives up a write whose
 *     final deadline check fails) needs every write that applies a change to declare an instant `notAfter` body
 *     field. The deadline is liveness only: a COMMIT can land after it, so a lookup 404 is NEVER proof of absence;
 *   - absence is definitive only through a FENCE (`fenceOperationId`): a write the system accepts once the request's
 *     deadline has passed, which either returns the change stored under the id (authoritatively, no lookup lag) or
 *     records the id so that nothing can ever be applied under it. A fence needs the dispatch deadline
 *     (BINDING_FENCE_WITHOUT_DEADLINE) and must be the contract's fence operation. Without a fence an absent change
 *     stays UNKNOWN for good (ACT-03);
 *   - a NOT_IDEMPOTENT write needs a DISPATCH RESERVATION as well (`dispatchReservation`): the system's marker that
 *     one dispatch (a per-delivery id) holds the reference before the write, so a redelivery never sends a second
 *     write while the lookup still lags (BINDING_NON_IDEMPOTENT_WITHOUT_DISPATCH_RESERVATION); and a fence, so an
 *     unknown outcome can ever be settled (BINDING_NON_IDEMPOTENT_WITHOUT_FENCE);
 *   - the binding belongs to the profile (id) and to the profile's system.
 * Bindings are configuration data: tenant activation supplies them next to the connector profiles (AIN-10, AIN-36).
 */
import { z } from "zod";
import type { ConnectorOperation } from "../protocol/connector.js";
import type { AdmittedProfile } from "../connectors/profile/validate.js";

export const DomainContract = z.enum(["scheduling.v1", "billing.v1", "claims.v1", "provider.v1", "referrals.v1", "scheduling.legacy.v1"]);
export type DomainContract = z.infer<typeof DomainContract>;

export type OperationKindNeeded = "READ" | "WRITE" | "LOOKUP";

/** Canonical operations of each contract and the profile operation kind each needs. */
export const CONTRACT_OPERATIONS: Readonly<Record<DomainContract, Readonly<Record<string, OperationKindNeeded>>>> = Object.freeze({
  "scheduling.v1": {
    listAppointments: "READ",
    getAppointment: "READ",
    listSlotOptions: "READ",
    listProviderSlots: "READ",
    getSlot: "READ",
    book: "WRITE",
    reschedule: "WRITE",
    cancel: "WRITE",
    blockAvailability: "WRITE",
    lookupChange: "LOOKUP",
    completeChange: "WRITE",
    fenceChange: "WRITE",
    getReceipt: "READ",
    consistency: "READ",
  },
  "billing.v1": {
    listInvoices: "READ",
    getInvoice: "READ",
    listInvoiceLines: "READ",
    listPayments: "READ",
    requestReview: "WRITE",
    lookupChange: "LOOKUP",
    completeChange: "WRITE",
    fenceChange: "WRITE",
    getReceipt: "READ",
    consistency: "READ",
  },
  "claims.v1": { listClaims: "READ", getClaim: "READ", consistency: "READ" },
  "provider.v1": { getOnboarding: "READ", listDocuments: "READ", listRemittances: "READ", consistency: "READ" },
  "referrals.v1": { listReferrals: "READ", getReferral: "READ", listAuthorizations: "READ", getEligibility: "READ", consistency: "READ" },
  "scheduling.legacy.v1": {
    createAppointment: "WRITE",
    reserveReference: "WRITE",
    releaseReference: "WRITE",
    fenceReference: "WRITE",
    lookupByReference: "LOOKUP",
    getAppointment: "READ",
    consistency: "READ",
  },
});

/**
 * Canonical operations a binding may leave out: the provider availability block (a tenant may not offer
 * provider-approved schedule changes) and the reconciliation operations whose absence the rules below judge
 * (without a fence no absence is ever definitive; a non-idempotent write without a reservation is refused).
 */
const OPTIONAL_OPERATIONS: ReadonlySet<string> = new Set(["blockAvailability", "fenceChange", "fenceReference", "reserveReference", "releaseReference"]);
/** The contract's fence operation name per contract (the binding's `fenceOperationId` must be the one mapped). */
const FENCE_OPERATION_OF: Readonly<Partial<Record<DomainContract, string>>> = Object.freeze({ "scheduling.v1": "fenceChange", "billing.v1": "fenceChange", "scheduling.legacy.v1": "fenceReference" });

const SYSTEM_OF_CONTRACT: Readonly<Record<DomainContract, string>> = Object.freeze({
  "scheduling.v1": "scheduling",
  "billing.v1": "billing",
  "claims.v1": "claims",
  "provider.v1": "provider",
  "referrals.v1": "referrals",
  "scheduling.legacy.v1": "scheduling",
});

const OperationIdRef = z.string().regex(/^[a-z][a-z0-9_.]{2,63}$/);

export const DomainBinding = z.strictObject({
  bindingId: z.string().regex(/^dbn_[A-Za-z0-9_-]{16,64}$/),
  contract: DomainContract,
  connectorProfileId: z.string().regex(/^cnp_[A-Za-z0-9_-]{16,64}$/),
  /** Canonical operation -> reviewed profile operation id. */
  operations: z.record(z.string().regex(/^[a-z][A-Za-z]{2,40}$/), OperationIdRef),
  /** The declared reconciliation path of the contract's writes; null for a read-only contract. */
  reconciliation: z
    .strictObject({
      lookupOperationId: OperationIdRef,
      /** Write that completes an incomplete multi-step write by its request id (never applies it again). */
      completionOperationId: OperationIdRef.nullable(),
      /** The system's documented bound between a write being received and its lookup seeing it. */
      visibilityWindowMs: z.number().int().min(0).max(600_000),
      /** Allowance for clock difference between the platform and the system of record. */
      clockSkewAllowanceMs: z.number().int().min(0).max(60_000),
      incompleteWrite: z.enum(["COMPLETE_BY_REQUEST_ID", "ROUTE_TO_HUMAN"]),
      /**
       * How the system bounds a late application: REQUEST_NOT_AFTER, every write carries a dispatch deadline the
       * system enforces in its own transaction (an absence after the deadline plus the window is definitive);
       * NONE, the system may apply a received write at any later time (an absence is never definitive).
       */
      dispatchDeadline: z.enum(["REQUEST_NOT_AFTER", "NONE"]),
      /**
       * The system's documented request digest over each change request (write answer, lookup, receipt), which
       * binds a change found under a request id to the exact request; null when the system offers none (the
       * found change is then matched on its resource only).
       */
      requestDigest: z.enum(["REFBIZ_REQUEST_V1"]).nullable(),
      /**
       * The system's fence: accepted once a request's dispatch deadline has passed, it returns the change stored
       * under the request id / reference (authoritatively, without the lookup's lag; waiting for a delivery still in
       * its transaction) or records the id so that nothing can ever be applied under it. The ONLY proof of absence
       * (NOT_FOUND); null: absence is never definitive. Ordering at the system's unique key, never by a clock.
       */
      fenceOperationId: OperationIdRef.nullable(),
      /**
       * A non-idempotent write's dispatch marker at the system: `reserve` holds the reference for one dispatch (a
       * fresh id per delivery) before the write, the first reservation wins, so a redelivery never writes a second
       * time; `release` gives back a reservation whose write was provably never sent. Null for idempotent writes.
       */
      dispatchReservation: z.strictObject({ reserveOperationId: OperationIdRef, releaseOperationId: OperationIdRef }).nullable(),
    })
    .nullable(),
  /** The tenant's approved hosted payment page path for an invoice (billing only), never a card collection path. */
  paymentPortalPath: z
    .string()
    .regex(/^\/[A-Za-z0-9/_-]{0,80}\{invoiceId\}[A-Za-z0-9/_-]{0,40}$/)
    .nullable(),
});
export type DomainBinding = z.infer<typeof DomainBinding>;

/** A binding validated against its admitted profile. */
export interface AdmittedBinding {
  readonly binding: DomainBinding;
  readonly admitted: AdmittedProfile;
  /** Profile operation for a canonical operation (validated to exist and be enabled). */
  op(canonical: string): ConnectorOperation;
}

export class BindingRejectedError extends Error {
  constructor(readonly violations: readonly string[]) {
    super(`DOMAIN_BINDING_REJECTED:${[...new Set(violations)].sort().join(",")}`);
    this.name = "BindingRejectedError";
  }
}

const isRead = (o: ConnectorOperation) => o.kind === "READ" || o.kind === "RECONCILE_LOOKUP";

/** Every violation of `binding` against `admitted` (empty: admissible). */
export function bindingViolations(raw: unknown, admitted: AdmittedProfile): string[] {
  const parsed = DomainBinding.safeParse(raw);
  if (!parsed.success) return ["BINDING_SCHEMA_INVALID"];
  const b = parsed.data;
  const v: string[] = [];
  const p = admitted.profile;
  if (b.connectorProfileId !== p.profileId) v.push("BINDING_PROFILE_MISMATCH");
  if (SYSTEM_OF_CONTRACT[b.contract] !== p.system) v.push("BINDING_SYSTEM_MISMATCH");
  const needed = CONTRACT_OPERATIONS[b.contract];
  for (const name of Object.keys(b.operations)) if (!(name in needed)) v.push("BINDING_OPERATION_UNKNOWN");
  const writes: ConnectorOperation[] = [];
  for (const [name, kind] of Object.entries(needed)) {
    const id = b.operations[name];
    if (id === undefined) {
      if (!OPTIONAL_OPERATIONS.has(name)) v.push("BINDING_OPERATION_MISSING");
      continue;
    }
    const op = admitted.operations.get(id);
    if (!op || !op.enabled) {
      v.push("BINDING_OPERATION_NOT_ENABLED");
      continue;
    }
    if (kind === "WRITE" && op.kind !== "WRITE") v.push("BINDING_OPERATION_KIND_MISMATCH");
    if ((kind === "READ" || kind === "LOOKUP") && !isRead(op)) v.push("BINDING_OPERATION_KIND_MISMATCH");
    if (kind === "WRITE") writes.push(op);
  }
  if (writes.length > 0) {
    const r = b.reconciliation;
    if (r === null) {
      v.push(writes.some((w) => w.idempotency === "NOT_IDEMPOTENT_RECONCILE_REQUIRED") ? "BINDING_NON_IDEMPOTENT_WITHOUT_RECONCILIATION" : "BINDING_WRITE_WITHOUT_RECONCILIATION");
    } else {
      const lookup = admitted.operations.get(r.lookupOperationId);
      if (!lookup || !lookup.enabled || !isRead(lookup)) v.push("BINDING_LOOKUP_INVALID");
      const lookupName = Object.entries(needed).find(([, k]) => k === "LOOKUP")?.[0];
      if (lookupName !== undefined && b.operations[lookupName] !== r.lookupOperationId) v.push("BINDING_LOOKUP_NOT_THE_CONTRACT_LOOKUP");
      for (const w of writes) {
        // Every write must declare THIS lookup as its reconciliation path in the reviewed profile.
        if (w.reconcileOperationId !== r.lookupOperationId) v.push(w.idempotency === "NOT_IDEMPOTENT_RECONCILE_REQUIRED" ? "BINDING_NON_IDEMPOTENT_WITHOUT_RECONCILIATION" : "BINDING_WRITE_LOOKUP_MISMATCH");
      }
      if (r.dispatchDeadline === "REQUEST_NOT_AFTER") {
        // The completion of an incomplete write (step 2 only) and the release of an unused reservation never apply a
        // change: no deadline needed.
        for (const w of writes) {
          if (w.operationId === r.completionOperationId || w.operationId === r.dispatchReservation?.releaseOperationId) continue;
          if (!w.requestBody?.fields.some((f) => f.inputField === "notAfter" && f.type === "instant")) v.push("BINDING_DEADLINE_FIELD_MISSING");
        }
      }
      const writeOp = (id: string | null | undefined): ConnectorOperation | undefined => (id === null || id === undefined ? undefined : admitted.operations.get(id));
      if (r.fenceOperationId !== null) {
        const f = writeOp(r.fenceOperationId);
        if (!f || !f.enabled || f.kind !== "WRITE") v.push("BINDING_FENCE_INVALID");
        const fenceName = FENCE_OPERATION_OF[b.contract];
        if (fenceName === undefined || b.operations[fenceName] !== r.fenceOperationId) v.push("BINDING_FENCE_NOT_THE_CONTRACT_FENCE");
        // The fence is accepted only once the request's deadline has passed: without a deadline it cannot exist.
        if (r.dispatchDeadline !== "REQUEST_NOT_AFTER") v.push("BINDING_FENCE_WITHOUT_DEADLINE");
      }
      const nonIdempotent = writes.some((w) => w.idempotency === "NOT_IDEMPOTENT_RECONCILE_REQUIRED");
      if (r.dispatchReservation !== null) {
        const reserve = writeOp(r.dispatchReservation.reserveOperationId);
        const release = writeOp(r.dispatchReservation.releaseOperationId);
        if (!reserve || !reserve.enabled || reserve.kind !== "WRITE" || !release || !release.enabled || release.kind !== "WRITE") v.push("BINDING_DISPATCH_RESERVATION_INVALID");
        if (b.operations.reserveReference !== r.dispatchReservation.reserveOperationId || b.operations.releaseReference !== r.dispatchReservation.releaseOperationId) {
          v.push("BINDING_DISPATCH_RESERVATION_NOT_THE_CONTRACT_RESERVATION");
        }
      }
      if (nonIdempotent) {
        // A redelivery inside the lookup's lag cannot see the first write: only a reservation at the system keeps a
        // second write from being sent, and only a fence can ever settle an unknown outcome.
        if (r.dispatchReservation === null) v.push("BINDING_NON_IDEMPOTENT_WITHOUT_DISPATCH_RESERVATION");
        if (r.fenceOperationId === null) v.push("BINDING_NON_IDEMPOTENT_WITHOUT_FENCE");
      }
      if (r.incompleteWrite === "COMPLETE_BY_REQUEST_ID") {
        const c = r.completionOperationId === null ? undefined : admitted.operations.get(r.completionOperationId);
        if (!c || !c.enabled || c.kind !== "WRITE") v.push("BINDING_COMPLETION_INVALID");
      }
    }
  } else if (b.reconciliation !== null) {
    v.push("BINDING_RECONCILIATION_WITHOUT_WRITES");
  }
  if (b.contract === "billing.v1" && b.paymentPortalPath === null) v.push("BINDING_PAYMENT_PORTAL_PATH_MISSING");
  if (b.contract !== "billing.v1" && b.paymentPortalPath !== null) v.push("BINDING_PAYMENT_PORTAL_PATH_UNEXPECTED");
  return v;
}

/** Admits a binding for live use, or throws BindingRejectedError with every violation. */
export function admitBinding(raw: unknown, admitted: AdmittedProfile): AdmittedBinding {
  const violations = bindingViolations(raw, admitted);
  if (violations.length > 0) throw new BindingRejectedError(violations);
  const binding = DomainBinding.parse(raw);
  return {
    binding,
    admitted,
    op(canonical: string): ConnectorOperation {
      const id = binding.operations[canonical];
      const op = id === undefined ? undefined : admitted.operations.get(id);
      if (!op) throw new BindingRejectedError(["BINDING_OPERATION_MISSING"]);
      return op;
    },
  };
}
