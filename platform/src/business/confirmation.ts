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
 */
import type { PreparedAction } from "../protocol/index.js";
import type { ToolDeps } from "./contract.js";
import { localDateTime } from "./shared.js";

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

export async function confirmationSlotsFor(deps: Pick<ToolDeps, "adapters">, action: PreparedAction): Promise<ConfirmationSlots | null> {
  const c = action.change;
  switch (action.kind) {
    case "appointment.reschedule": {
      const from = when(str(c.fromStartsAt), str(c.fromTimeZone));
      const to = when(str(c.toStartsAt), str(c.toTimeZone));
      if (!from || !to) return null;
      return { fromDate: from.date, fromTime: from.time, fromTimeZone: from.timeZone, toDate: to.date, toTime: to.time, toTimeZone: to.timeZone };
    }
    case "appointment.create": {
      const to = when(str(c.toStartsAt), str(c.toTimeZone));
      return to ? { date: to.date, time: to.time, timeZone: to.timeZone } : null;
    }
    case "billing.review.submit": {
      try {
        const invoice = await deps.adapters.billing.getInvoice(action.target.recordRef);
        // The invoice must still be the subject's and the one the action targets.
        if (!invoice || invoice.invoiceId !== action.target.recordRef || invoice.subjectId !== action.subjectId) return null;
        return { issuedDate: invoice.issuedOn };
      } catch {
        return null;
      }
    }
    default:
      return null;
  }
}
