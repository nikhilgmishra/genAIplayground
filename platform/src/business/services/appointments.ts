/**
 * Appointment lookup, options and approved reschedule / create (spec sections 4, 8, 16:
 * "a verified client rescheduling an appointment with conflict handling").
 *
 * - Lookup and options only for the authorized subject (resource subject comes from
 *   the authoritative appointment record, never from the model).
 * - prepare uses the ActionService with target beforeVersion = the authoritative
 *   appointment version (create: the slot must still be open), and impact /
 *   confirmation templates that state date, time and time zone.
 * - commit goes through the ledger's commit protocol with SchedulingCommitPort.
 *   Slot taken -> SLOT_UNAVAILABLE with fresh options; appointment changed ->
 *   STATE_CHANGED (re-prepare); UNKNOWN -> reconcile before anything is announced.
 * No clinical suitability matching of any kind.
 */
import type { Appointment, Slot } from "../../adapters/ports.js";
import type { AuthContext, PolicyDecision, PreparedAction } from "../../protocol/index.js";
import { ValidationError } from "../../shared/errors.js";
import type { ToolDeps } from "../contract.js";
import { APPOINTMENT_CREATE, APPOINTMENT_RESCHEDULE } from "../contracts/index.js";
import type { InteractionIndex } from "../interactions.js";
import { commitAction, type CommitResult } from "../commit.js";
import type { ReauthorizeSpec } from "../policy.js";
import { decideNow } from "../policy.js";
import { SLOT_OPEN_VERSION, SchedulingCommitPort } from "../providers.js";
import { utcDate } from "../shared.js";

export const PREPARE_TTL_SECONDS = 300;
/** Window searched for fresh options after a conflict (engineering default). */
export const CONFLICT_OPTION_WINDOW_DAYS = 14;

export type PrepareOutcome =
  | { kind: "PREPARED"; action: PreparedAction; slot: Slot; from: Appointment | null }
  | { kind: "SLOT_UNAVAILABLE" }
  | { kind: "OPTION_AMBIGUOUS" }
  | { kind: "NOT_ELIGIBLE"; reasonCode: string };

export type AppointmentCommitOutcome =
  | { kind: "COMMITTED"; receiptId: string; actionId: string; appointment: Appointment }
  | { kind: "SLOT_UNAVAILABLE"; options: Slot[]; appointmentId: string | null }
  | Exclude<CommitResult, { kind: "COMMITTED" } | { kind: "FAILED" }>
  | { kind: "FAILED"; reasonCode: string };

const sameInstant = (a: string, b: string): boolean => Date.parse(a) === Date.parse(b);

export class AppointmentService {
  readonly provider: SchedulingCommitPort;

  constructor(
    private readonly deps: ToolDeps,
    private readonly interactions: InteractionIndex,
  ) {
    this.provider = new SchedulingCommitPort(deps.adapters.scheduling);
  }

  /** Authoritative subject of an appointment, or null when it does not exist. */
  async subjectOf(appointmentId: string): Promise<string | null> {
    const a = await this.deps.adapters.scheduling.getAppointment(appointmentId);
    return a?.subjectId ?? null;
  }

  async options(subjectId: string, input: { appointmentId: string | null; fromDate: string; toDate: string }): Promise<{ appointments: Appointment[]; slots: Slot[] }> {
    const s = this.deps.adapters.scheduling;
    if (input.appointmentId !== null) {
      const a = await s.getAppointment(input.appointmentId);
      if (!a || a.subjectId !== subjectId) throw new ValidationError("APPOINTMENT_NOT_AVAILABLE");
      const slots = a.status === "SCHEDULED" ? await s.listSlots({ subjectId, appointmentId: a.appointmentId, fromDate: input.fromDate, toDate: input.toDate }) : [];
      return { appointments: [a], slots };
    }
    const appointments = (await s.listAppointments(subjectId)).filter((a) => a.status === "SCHEDULED");
    const slots = await s.listSlots({ subjectId, appointmentId: null, fromDate: input.fromDate, toDate: input.toDate });
    return { appointments, slots };
  }

  /**
   * A provider's own schedule: that provider's open administrative slots only. Booked
   * appointments are clients' records and are never listed here (they need a treating
   * relationship and an appointment id).
   */
  async ownScheduleOptions(providerSubjectId: string, input: { fromDate: string; toDate: string }): Promise<{ appointments: Appointment[]; slots: Slot[] }> {
    const slots = await this.deps.adapters.scheduling.listSlots({ subjectId: providerSubjectId, appointmentId: null, fromDate: input.fromDate, toDate: input.toDate });
    return { appointments: [], slots };
  }

  /**
   * The offered option is re-resolved from AUTHORITATIVE availability: startsAt (plus the
   * optional modality and the optional opaque slotId from get_appointment_options) must
   * match exactly one open slot. A slotId never selects a slot on its own.
   */
  async prepare(auth: AuthContext, decision: PolicyDecision, input: { appointmentId: string | null; startsAt: string; modality: Slot["modality"] | null; slotId?: string | null }): Promise<PrepareOutcome> {
    const subjectId = auth.subjectId;
    if (!subjectId) return { kind: "NOT_ELIGIBLE", reasonCode: "SUBJECT_REQUIRED" };
    const s = this.deps.adapters.scheduling;
    const day = utcDate(new Date(input.startsAt));
    let from: Appointment | null = null;
    if (input.appointmentId !== null) {
      from = await s.getAppointment(input.appointmentId);
      // Same answer for "absent" and "another subject's": no existence disclosure.
      if (!from || from.subjectId !== subjectId) return { kind: "NOT_ELIGIBLE", reasonCode: "APPOINTMENT_NOT_AVAILABLE" };
      if (from.status !== "SCHEDULED") return { kind: "NOT_ELIGIBLE", reasonCode: "APPOINTMENT_NOT_RESCHEDULABLE" };
    }
    const slots = await s.listSlots({ subjectId, appointmentId: input.appointmentId, fromDate: day, toDate: day });
    const slotId = input.slotId ?? null;
    const matches = slots.filter((x) => sameInstant(x.startsAt, input.startsAt) && (input.modality === null || x.modality === input.modality) && (slotId === null || x.slotId === slotId));
    if (matches.length === 0) return { kind: "SLOT_UNAVAILABLE" };
    if (matches.length > 1) return { kind: "OPTION_AMBIGUOUS" };
    const slot = matches[0] as Slot;

    const action =
      from !== null
        ? await this.deps.actions.prepare(
            auth,
            {
              kind: "appointment.reschedule",
              target: { system: "scheduling", recordType: "appointment", recordRef: from.appointmentId, beforeVersion: from.version },
              change: { slotId: slot.slotId, toStartsAt: slot.startsAt, toTimeZone: slot.timeZone, fromStartsAt: from.startsAt, fromTimeZone: from.timeZone },
              impact: { summaryTemplateId: "appointment.change_confirmation", fees: null, reversible: true },
              confirmationTemplateId: "appointment.change_confirmation",
              ttlSeconds: PREPARE_TTL_SECONDS,
              requiresStepUp: false,
            },
            decision,
          )
        : await this.deps.actions.prepare(
            auth,
            {
              kind: "appointment.create",
              target: { system: "scheduling", recordType: "appointment_slot", recordRef: slot.slotId, beforeVersion: SLOT_OPEN_VERSION },
              change: { slotId: slot.slotId, toStartsAt: slot.startsAt, toTimeZone: slot.timeZone },
              impact: { summaryTemplateId: "appointment.create_confirmation", fees: null, reversible: true },
              confirmationTemplateId: "appointment.create_confirmation",
              ttlSeconds: PREPARE_TTL_SECONDS,
              requiresStepUp: false,
            },
            decision,
          );
    await this.interactions.recordPrepared({
      tenantId: auth.tenantId,
      callId: auth.callId,
      actionId: action.actionId,
      kind: action.kind,
      contractId: action.kind === "appointment.reschedule" ? APPOINTMENT_RESCHEDULE.contractId : APPOINTMENT_CREATE.contractId,
    });
    return { kind: "PREPARED", action, slot, from };
  }

  async commit(auth: AuthContext, input: { actionId: string; digest: string }, reauthorize: ReauthorizeSpec): Promise<AppointmentCommitOutcome> {
    const action = await this.deps.actions.get(auth.tenantId, input.actionId);
    if (!action || (action.kind !== "appointment.reschedule" && action.kind !== "appointment.create")) return { kind: "DENIED", reasonCode: "ACTION_NOT_AVAILABLE" };
    const result = await commitAction(this.deps.actions, auth, input, {
      provider: this.provider,
      reauthorize: (a) => decideNow(this.deps, auth, { ...reauthorize, resource: { ...reauthorize.resource, actionDigest: a.digest } }),
    });
    if (result.kind === "COMMITTED") {
      await this.interactions.recordReceipt(auth.tenantId, result.receipt).catch(() => undefined);
      const appointment = await this.committedAppointment(action, result.receipt.providerIdempotencyKey);
      if (!appointment) return { kind: "UNKNOWN", reasonCode: "COMMITTED_RECORD_UNREADABLE", reconciliationRef: action.actionId };
      return { kind: "COMMITTED", receiptId: result.receipt.receiptId, actionId: action.actionId, appointment };
    }
    if (result.kind === "FAILED") {
      await this.interactions.recordReceipt(auth.tenantId, result.receipt).catch(() => undefined);
      if (result.reasonCode === "SLOT_UNAVAILABLE") return this.slotUnavailable(action);
      return { kind: "FAILED", reasonCode: result.reasonCode };
    }
    // For a new booking the only state that can change is the slot's availability.
    if (result.kind === "STATE_CHANGED" && action.kind === "appointment.create") return this.slotUnavailable(action);
    return result;
  }

  private async committedAppointment(action: PreparedAction, providerKey: string): Promise<Appointment | null> {
    const s = this.deps.adapters.scheduling;
    if (action.kind === "appointment.reschedule") return s.getAppointment(action.target.recordRef);
    return (await s.findByIdempotencyKey(providerKey))?.appointment ?? null;
  }

  private async slotUnavailable(action: PreparedAction): Promise<AppointmentCommitOutcome> {
    const appointmentId = action.kind === "appointment.reschedule" ? action.target.recordRef : null;
    const now = this.deps.clock.now();
    const options = await this.deps.adapters.scheduling
      .listSlots({ subjectId: action.subjectId, appointmentId, fromDate: utcDate(now), toDate: utcDate(now, CONFLICT_OPTION_WINDOW_DAYS) })
      .catch(() => [] as Slot[]);
    return { kind: "SLOT_UNAVAILABLE", options: options.slice(0, 5), appointmentId };
  }
}
