/**
 * System-of-record commit ports (actions/ports.ts ProviderCommitPort) for the
 * consequential actions the business layer prepares (spec section 8; ACT-02, ACT-03).
 *
 * - The provider idempotency key from the ledger is passed on every attempt, so a
 *   retry, redelivery or crash-after-commit never creates a second effect.
 * - lookup() resolves an UNKNOWN outcome by that key before any retry.
 * - currentVersion() is the authoritative optimistic-concurrency version.
 * - Definite business refusals are returned as FAILED with a reason code
 *   (SLOT_UNAVAILABLE; STATE_CHANGED makes the ledger invalidate the action);
 *   dependency errors are rethrown so the ledger can classify NOT_STARTED / UNKNOWN.
 */
import type { ProviderCommitPort, ProviderCommitResult, ProviderLookupResult } from "../actions/ports.js";
import type { BillingSystem, SchedulingSystem } from "../adapters/ports.js";
import type { PreparedAction } from "../protocol/index.js";
import { ConflictError, DependencyError, ValidationError } from "../shared/errors.js";
import { utcDate } from "./shared.js";

/** Version token of an open slot targeted by appointment.create. */
export const SLOT_OPEN_VERSION = "slot.open";
export const SLOT_UNAVAILABLE_VERSION = "slot.unavailable";

function refusal(err: unknown): ProviderCommitResult | null {
  if (err instanceof DependencyError) return null;
  if (err instanceof ConflictError) {
    if (err.reasonCode === "STATE_CHANGED") return { outcome: "FAILED", reasonCode: "STATE_CHANGED", permanent: true };
    if (err.reasonCode === "SLOT_UNAVAILABLE") return { outcome: "FAILED", reasonCode: "SLOT_UNAVAILABLE", permanent: true };
    if (/^[A-Z][A-Z0-9_]{2,63}$/.test(err.reasonCode) && err.reasonCode !== "IDEMPOTENCY_KEY_REUSED") return { outcome: "FAILED", reasonCode: err.reasonCode, permanent: true };
    return null;
  }
  if (err instanceof ValidationError) return { outcome: "FAILED", reasonCode: "PROVIDER_REJECTED", permanent: true };
  return null;
}

const slotIdOf = (action: PreparedAction): string => {
  const v = action.change.slotId;
  if (typeof v !== "string") throw new ValidationError("PREPARED_CHANGE_INVALID");
  return v;
};

export class SchedulingCommitPort implements ProviderCommitPort {
  constructor(private readonly scheduling: SchedulingSystem) {}

  async commit(action: PreparedAction, key: string): Promise<ProviderCommitResult> {
    try {
      const r =
        action.kind === "appointment.reschedule"
          ? await this.scheduling.reschedule({ appointmentId: action.target.recordRef, beforeVersion: action.target.beforeVersion, slotId: slotIdOf(action), idempotencyKey: key })
          : action.kind === "appointment.create"
            ? await this.scheduling.create({ subjectId: action.subjectId, slotId: slotIdOf(action), idempotencyKey: key })
            : null;
      if (!r) return { outcome: "FAILED", reasonCode: "ACTION_KIND_UNSUPPORTED", permanent: true };
      return {
        outcome: "COMMITTED",
        providerReference: r.reference,
        afterVersion: r.appointment.version,
        evidence: { appointmentId: r.appointment.appointmentId, startsAt: r.appointment.startsAt, timeZone: r.appointment.timeZone, status: r.appointment.status },
      };
    } catch (err) {
      const mapped = refusal(err);
      if (mapped) return mapped;
      throw err;
    }
  }

  async lookup(_action: PreparedAction, key: string): Promise<ProviderLookupResult> {
    const r = await this.scheduling.findByIdempotencyKey(key);
    if (!r) return { outcome: "NOT_FOUND" };
    return {
      outcome: "COMMITTED",
      providerReference: r.reference,
      afterVersion: r.appointment.version,
      evidence: { appointmentId: r.appointment.appointmentId, startsAt: r.appointment.startsAt, timeZone: r.appointment.timeZone, status: r.appointment.status },
    };
  }

  async currentVersion(action: PreparedAction): Promise<string> {
    if (action.kind === "appointment.reschedule") {
      const a = await this.scheduling.getAppointment(action.target.recordRef);
      return a ? a.version : "absent";
    }
    // appointment.create targets an open slot: its version is whether it is still bookable for this subject.
    const startsAt = action.change.toStartsAt;
    if (typeof startsAt !== "string") throw new ValidationError("PREPARED_CHANGE_INVALID");
    const day = utcDate(new Date(startsAt));
    const slots = await this.scheduling.listSlots({ subjectId: action.subjectId, appointmentId: null, fromDate: day, toDate: day });
    return slots.some((s) => s.slotId === slotIdOf(action)) ? SLOT_OPEN_VERSION : SLOT_UNAVAILABLE_VERSION;
  }
}

export class BillingReviewCommitPort implements ProviderCommitPort {
  constructor(private readonly billing: BillingSystem) {}

  async commit(action: PreparedAction, key: string): Promise<ProviderCommitResult> {
    if (action.kind !== "billing.review.submit") return { outcome: "FAILED", reasonCode: "ACTION_KIND_UNSUPPORTED", permanent: true };
    try {
      const r = await this.billing.markInReview({ invoiceId: action.target.recordRef, beforeVersion: action.target.beforeVersion, idempotencyKey: key });
      return { outcome: "COMMITTED", providerReference: r.reference, afterVersion: r.invoice.version, evidence: { invoiceId: r.invoice.invoiceId, status: r.invoice.status } };
    } catch (err) {
      const mapped = refusal(err);
      if (mapped) return mapped;
      throw err;
    }
  }

  async lookup(_action: PreparedAction, key: string): Promise<ProviderLookupResult> {
    const r = await this.billing.findReviewByIdempotencyKey(key);
    if (!r) return { outcome: "NOT_FOUND" };
    return { outcome: "COMMITTED", providerReference: r.reference, afterVersion: r.invoice.version, evidence: { invoiceId: r.invoice.invoiceId, status: r.invoice.status } };
  }

  async currentVersion(action: PreparedAction): Promise<string> {
    const inv = await this.billing.getInvoice(action.target.recordRef);
    return inv ? inv.version : "absent";
  }
}
