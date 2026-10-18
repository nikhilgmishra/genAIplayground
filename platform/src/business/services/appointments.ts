/**
 * Appointment lookup, options and approved reschedule / create (spec sections 4, 8, 16:
 * "a verified client rescheduling an appointment with conflict handling").
 *
 * - Lookup and options only for the authorized subject (resource subject comes from
 *   the authoritative appointment record, never from the model).
 * - prepare uses the ActionService with target beforeVersion = the authoritative
 *   appointment version (create: the slot must still be open). The digest-bound change
 *   carries EVERY caller-relevant fact the commit will apply: the new date, time and time
 *   zone, the visit modality (video / in person / phone; the scheduling commit copies the
 *   slot's modality onto the appointment) and, for a new booking, the provider. The
 *   confirmation templates read all of them back (ACT-01, ACT-F5).
 * - commit goes through the ledger's commit protocol with SchedulingCommitPort.
 *   Slot taken -> SLOT_UNAVAILABLE with fresh options; appointment changed ->
 *   STATE_CHANGED (re-prepare); UNKNOWN -> reconcile before anything is announced.
 * - The success view is the AUTHORITATIVE receipt's: a value is spoken only when its provider
 *   evidence hashes to the receipt's evidenceHash at the receipt's afterVersion. A stale or
 *   lagging re-read is never spoken; when nothing matches the receipt the result is UNKNOWN
 *   (COMMITTED_RECORD_UNREADABLE), never a guessed time (ACT-05, ACT-F4).
 * No clinical suitability matching of any kind.
 */
import type { Appointment, Slot } from "../../adapters/ports.js";
import { evidenceHashOf } from "../../actions/digest.js";
import type { AuthContext, CommitReceipt, PolicyDecision, PreparedAction } from "../../protocol/index.js";
import { ValidationError } from "../../shared/errors.js";
import type { ToolDeps } from "../contract.js";
import { APPOINTMENT_CREATE, APPOINTMENT_RESCHEDULE } from "../contracts/index.js";
import type { InteractionIndex } from "../interactions.js";
import { commitAction, type CommitResult } from "../commit.js";
import type { ReauthorizeSpec } from "../policy.js";
import { decideNow } from "../policy.js";
import { SLOT_OPEN_VERSION, SchedulingCommitPort } from "../providers.js";
import { utcDate } from "../shared.js";
import { TOOL_DEFINITIONS } from "../../gateway/tools/definitions.js";
import { AccessDeniedError } from "../../shared/errors.js";
import { authorizeOperatorRetry, withOperatorRetryAuthority } from "./operator-retry.js";
import type { OperatorRetrySpec } from "./operator-retry.js";

export const PREPARE_TTL_SECONDS = 300;
/** Window searched for fresh options after a conflict (engineering default). */
export const CONFLICT_OPTION_WINDOW_DAYS = 14;

export type PrepareOutcome =
  | { kind: "PREPARED"; action: PreparedAction; slot: Slot; from: Appointment | null }
  | { kind: "SLOT_UNAVAILABLE" }
  | { kind: "OPTION_AMBIGUOUS" }
  | { kind: "NOT_ELIGIBLE"; reasonCode: string };

/** What was committed, bound to the commit receipt's provider evidence (ACT-F4). */
export type CommittedAppointment = Pick<Appointment, "appointmentId" | "startsAt" | "timeZone" | "modality" | "status">;

export type AppointmentCommitOutcome =
  | { kind: "COMMITTED"; receiptId: string; actionId: string; appointment: CommittedAppointment }
  | { kind: "SLOT_UNAVAILABLE"; options: Slot[]; appointmentId: string | null }
  | Exclude<CommitResult, { kind: "COMMITTED" } | { kind: "FAILED" }>
  | { kind: "FAILED"; reasonCode: string };

const sameInstant = (a: string, b: string): boolean => Date.parse(a) === Date.parse(b);

const MODALITIES: readonly Appointment["modality"][] = ["video", "in_person", "phone"];
const modalityOf = (v: unknown): Appointment["modality"] | null => (typeof v === "string" && (MODALITIES as readonly string[]).includes(v) ? (v as Appointment["modality"]) : null);

/**
 * The provider evidence of a committed appointment exactly as SchedulingCommitPort records it in the
 * receipt (business/providers.ts commit / lookup). If that shape ever changes, nothing matches the
 * receipt and the outcome is UNKNOWN: a mismatch fails closed, it never speaks a guessed value.
 */
const schedulingEvidence = (a: Pick<Appointment, "appointmentId" | "startsAt" | "timeZone" | "status">): Record<string, unknown> => ({
  appointmentId: a.appointmentId,
  startsAt: a.startsAt,
  timeZone: a.timeZone,
  status: a.status,
});

/** True when `a` is exactly what the provider returned for this commit (receipt-bound evidence hash). */
function boundToReceipt(receipt: CommitReceipt, a: Pick<Appointment, "appointmentId" | "startsAt" | "timeZone" | "status">): boolean {
  if (receipt.outcome !== "COMMITTED" || receipt.providerReference === null || receipt.evidenceHash === null) return false;
  const h = evidenceHashOf({ providerSystem: receipt.providerSystem, providerReference: receipt.providerReference, afterVersion: receipt.afterVersion, evidence: schedulingEvidence(a) });
  return h.canonical && h.hash === receipt.evidenceHash;
}

export class AppointmentService {
  /** System-of-record commit port; carries the operator-retry authority (ACT-F3) for staff retries. */
  readonly provider: SchedulingCommitPort & { authorizeOperatorRetry(action: PreparedAction): Promise<PolicyDecision> };

  constructor(
    private readonly deps: ToolDeps,
    private readonly interactions: InteractionIndex,
  ) {
    // A staff retry re-establishes the CALLER's current authority with exactly the commit tool's policy
    // action, purpose and resource (gateway/tools/appointments.ts commit_appointment_change).
    const commitTool = TOOL_DEFINITIONS.commit_appointment_change;
    const spec: OperatorRetrySpec = {
      action: commitTool.permissions[0] ?? "",
      purpose: "caller_self_service",
      tool: commitTool,
      resource: (a) => ({ type: "appointment", tenantId: a.tenantId, subjectId: a.subjectId, organizationId: null, classification: "PHI", actionDigest: a.digest }),
      check: async (a) => {
        if (a.kind !== "appointment.reschedule" && a.kind !== "appointment.create") throw new AccessDeniedError("ACTION_NOT_AVAILABLE");
        // The appointment's authoritative subject must still be the action's subject.
        if (a.kind === "appointment.reschedule" && (await this.subjectOf(a.target.recordRef)) !== a.subjectId) throw new AccessDeniedError("RESOURCE_NOT_AUTHORIZED");
      },
    };
    this.provider = withOperatorRetryAuthority(new SchedulingCommitPort(deps.adapters.scheduling), (a) => authorizeOperatorRetry(deps, spec, a));
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
              // Every caller-relevant fact the commit applies is in the digest-bound change (ACT-F5).
              change: {
                slotId: slot.slotId,
                toStartsAt: slot.startsAt,
                toTimeZone: slot.timeZone,
                toModality: slot.modality,
                fromStartsAt: from.startsAt,
                fromTimeZone: from.timeZone,
                fromModality: from.modality,
              },
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
              change: { slotId: slot.slotId, toStartsAt: slot.startsAt, toTimeZone: slot.timeZone, toModality: slot.modality, providerName: slot.providerDisplayName },
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
      const appointment = await this.committedAppointment(action, result.receipt);
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

  /**
   * The committed appointment as the AUTHORITATIVE receipt states it (ACT-05, ACT-F4). A system-of-record
   * read is used only when it IS the committed state: its version equals the receipt's afterVersion and
   * its evidence hashes to the receipt's evidenceHash. Otherwise (read replica lag, cache, stale read)
   * the digest-bound prepared change is checked against the same receipt evidence, which is what the
   * provider returned for this commit. Nothing that does not match the receipt is ever spoken: null =>
   * UNKNOWN / COMMITTED_RECORD_UNREADABLE.
   */
  private async committedAppointment(action: PreparedAction, receipt: CommitReceipt): Promise<CommittedAppointment | null> {
    const s = this.deps.adapters.scheduling;
    const reread =
      action.kind === "appointment.reschedule"
        ? await s.getAppointment(action.target.recordRef).catch(() => null)
        : await s
            .findByIdempotencyKey(receipt.providerIdempotencyKey)
            .then((r) => (r && r.reference === receipt.providerReference ? r.appointment : null))
            .catch(() => null);
    const toModality = modalityOf(action.change.toModality);
    if (reread && reread.version === receipt.afterVersion && boundToReceipt(receipt, reread) && (toModality === null || reread.modality === toModality)) {
      return { appointmentId: reread.appointmentId, startsAt: reread.startsAt, timeZone: reread.timeZone, modality: reread.modality, status: reread.status };
    }
    if (action.kind !== "appointment.reschedule") return null;
    const toStartsAt = action.change.toStartsAt;
    const toTimeZone = action.change.toTimeZone;
    if (typeof toStartsAt !== "string" || typeof toTimeZone !== "string" || toModality === null) return null;
    const fromChange: CommittedAppointment = { appointmentId: action.target.recordRef, startsAt: toStartsAt, timeZone: toTimeZone, modality: toModality, status: "SCHEDULED" };
    return boundToReceipt(receipt, fromChange) ? fromChange : null;
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
