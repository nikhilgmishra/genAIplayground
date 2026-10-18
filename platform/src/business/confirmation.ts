/**
 * Typed slot values for the trusted confirmation prompt of a PREPARED action (TC-07;
 * spec section 8 "Present a concise description to the caller", ACT-01, ACT-05).
 *
 * The confirmation is rendered by the gateway's response gate from the action's
 * approved confirmation template. Slot values come only from the authoritative
 * prepared action (its exact structured change) or, where the template names a fact
 * the change does not carry, from the system of record (the invoice's issue date).
 * Nothing comes from the model or the caller. Unknown kinds, missing facts or a
 * lookup failure return null, and the gateway then routes to a human instead of
 * speaking an incomplete commitment.
 *
 * Every caller-relevant field of the digest-bound change is read back (ACT-01, ACT-F5;
 * spec sections 8 and 11: "Confirm ... dates, time zones and consequences before
 * committing changes"): new and old date, time and time zone, the visit modality
 * (a reschedule to a slot of another modality changes how the visit happens), the
 * provider of a new booking, and the billing review reason. READBACK_FIELDS lists,
 * per kind, the change fields that must be stated; an action missing one is never
 * read back partially (null => human).
 */
import type { PreparedAction } from "../protocol/index.js";
import type { ToolDeps } from "./contract.js";
import { localDateTime } from "./shared.js";
import { BILLING_REVIEW_REASONS } from "./services/billing.js";

export type ConfirmationSlots = Record<string, string | number | boolean>;

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

const when = (startsAt: string | null, timeZone: string | null): { date: string; time: string; timeZone: string } | null => {
  if (!startsAt || !timeZone) return null;
  try {
    const p = localDateTime(startsAt, timeZone);
    return { date: p.date, time: p.time, timeZone };
  } catch {
    return null;
  }
};

const MODALITIES = new Set(["video", "in_person", "phone"]);
const modality = (v: unknown): string | null => (typeof v === "string" && MODALITIES.has(v) ? v : null);
const REVIEW_REASONS: ReadonlySet<string> = new Set(BILLING_REVIEW_REASONS);

/**
 * Caller-relevant change fields that MUST be read back, per action kind (ACT-F5). Fields not listed
 * are internal bindings (the opaque slot id, the requested invoice status) and are never spoken.
 * confirmation.test.ts asserts that every other change field the business layer writes is covered.
 */
export const READBACK_FIELDS: Readonly<Record<string, readonly string[]>> = {
  "appointment.reschedule": ["fromStartsAt", "fromTimeZone", "fromModality", "toStartsAt", "toTimeZone", "toModality"],
  "appointment.create": ["toStartsAt", "toTimeZone", "toModality", "providerName"],
  "billing.review.submit": ["reasonCategory"],
};
/** Change fields that bind the action to its target but carry nothing the caller decides on. */
export const INTERNAL_CHANGE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  "appointment.reschedule": ["slotId"],
  "appointment.create": ["slotId"],
  "billing.review.submit": ["requestedStatus"],
};

export async function confirmationSlotsFor(deps: Pick<ToolDeps, "adapters">, action: PreparedAction): Promise<ConfirmationSlots | null> {
  const c = action.change;
  switch (action.kind) {
    case "appointment.reschedule": {
      const from = when(str(c.fromStartsAt), str(c.fromTimeZone));
      const to = when(str(c.toStartsAt), str(c.toTimeZone));
      const fromModality = modality(c.fromModality);
      const toModality = modality(c.toModality);
      if (!from || !to || !fromModality || !toModality) return null;
      return { fromDate: from.date, fromTime: from.time, fromTimeZone: from.timeZone, fromModality, toDate: to.date, toTime: to.time, toTimeZone: to.timeZone, toModality };
    }
    case "appointment.create": {
      const to = when(str(c.toStartsAt), str(c.toTimeZone));
      const toModality = modality(c.toModality);
      const providerName = str(c.providerName);
      return to && toModality && providerName ? { date: to.date, time: to.time, timeZone: to.timeZone, modality: toModality, providerName } : null;
    }
    case "billing.review.submit": {
      const reasonCategory = typeof c.reasonCategory === "string" && REVIEW_REASONS.has(c.reasonCategory) ? c.reasonCategory : null;
      if (!reasonCategory) return null;
      try {
        const invoice = await deps.adapters.billing.getInvoice(action.target.recordRef);
        // The invoice must still be the subject's and the one the action targets.
        if (!invoice || invoice.invoiceId !== action.target.recordRef || invoice.subjectId !== action.subjectId) return null;
        return { issuedDate: invoice.issuedOn, reasonCategory };
      } catch {
        return null;
      }
    }
    default:
      return null;
  }
}
