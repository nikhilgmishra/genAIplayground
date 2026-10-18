/**
 * get_appointment_options (appointment:list_options), prepare_appointment_change
 * (appointment:prepare_change) and commit_appointment_change (appointment:commit_change).
 *
 * resolveResource uses AUTHORITATIVE lookups: an appointment's real subject from the
 * scheduling system, a prepared action's subject from the ledger (bound to this
 * session). An unknown id resolves to a resource policy denies exactly like another
 * person's record (no existence disclosure). Options carry the opaque slot id (the
 * appointment:list_options field mask includes it; existing appointments carry null).
 * prepare takes the option's start time plus the optional modality and slot id and
 * re-resolves the slot from authoritative availability; a slot id alone selects nothing.
 */
import { z } from "zod";
import type { Appointment, Slot } from "../../adapters/ports.js";
import type { BusinessServices } from "../../business/services/types.js";
import { auditSessionRef, localDateTime, subjectResource, unresolvableResource } from "../../business/shared.js";
import { speechFor } from "../../business/speech.js";
import type { AuthContext, PolicyPurpose } from "../../protocol/index.js";
import type { ToolModule } from "../ports.js";
import { CommitInput, DateArg, Id, InstantArg, denied, failed, fromError, ok, retryable, sourceRef, unknownOutcome } from "./common.js";
import type { CommitInputT } from "./common.js";
import { TOOL_DEFINITIONS } from "./definitions.js";
import { toolPolicyRef } from "../../policy/input.js";

const Modality = z.enum(["video", "in_person", "phone"]);
const MAX_WINDOW_DAYS = 31;

const purposeFor = (auth: AuthContext): PolicyPurpose =>
  auth.selectedRole === "personal_representative" ? "representative_access" : auth.selectedRole === "provider" ? "delegated_practice_administration" : "caller_self_service";

const AppointmentRecord = z.strictObject({
  appointmentId: Id.nullable(),
  /** Opaque scheduling slot id of an open option; null for an existing appointment. */
  slotId: Id.nullable(),
  startsAt: InstantArg,
  timeZone: z.string().max(64),
  modality: Modality,
  providerDisplayName: z.string().max(80),
  status: z.enum(["SCHEDULED", "CANCELLED", "COMPLETED", "OPEN"]),
});

export const OptionsInput = z
  .strictObject({ appointmentId: Id.nullable(), fromDate: DateArg, toDate: DateArg })
  .refine((v) => v.toDate >= v.fromDate && (Date.parse(v.toDate) - Date.parse(v.fromDate)) / 86_400_000 < MAX_WINDOW_DAYS, { message: "WINDOW_INVALID" });
export const OptionsOutput = z.strictObject({
  appointments: z.array(AppointmentRecord).max(32),
  appointmentCount: z.number().int().min(0).max(32),
  optionCount: z.number().int().min(0).max(32),
});

const appointmentRecord = (a: Appointment): z.infer<typeof AppointmentRecord> => ({
  appointmentId: a.appointmentId,
  slotId: null,
  startsAt: a.startsAt,
  timeZone: a.timeZone,
  modality: a.modality,
  providerDisplayName: a.providerDisplayName,
  status: a.status,
});

const optionRecord = (sl: Slot, appointmentId: string | null): z.infer<typeof AppointmentRecord> => ({
  appointmentId,
  slotId: sl.slotId,
  startsAt: sl.startsAt,
  timeZone: sl.timeZone,
  modality: sl.modality,
  providerDisplayName: sl.providerDisplayName,
  status: "OPEN",
});

const whenSlots = (startsAt: string, timeZone: string) => {
  const p = localDateTime(startsAt, timeZone);
  return { date: p.date, time: p.time, timeZone };
};

export function getAppointmentOptionsTool(s: BusinessServices): ToolModule<z.infer<typeof OptionsInput>, z.infer<typeof OptionsOutput>> {
  return {
    definition: TOOL_DEFINITIONS.get_appointment_options,
    maskTarget: { collectionKey: "appointments", envelopeKeys: ["appointmentCount", "optionCount"] },
    input: OptionsInput,
    output: OptionsOutput,
    purpose: (auth) => purposeFor(auth),
    async resolveResource(auth, input) {
      if (input.appointmentId !== null) {
        const subject = await s.appointments.subjectOf(input.appointmentId);
        return subject ? subjectResource(auth, "appointment", subject, "PHI") : unresolvableResource(auth, "appointment", "PHI");
      }
      return auth.subjectId ? subjectResource(auth, "appointment_options", auth.subjectId, "PHI") : unresolvableResource(auth, "appointment_options", "PHI");
    },
    async execute(ctx, input) {
      const subject = input.appointmentId !== null ? await s.appointments.subjectOf(input.appointmentId) : ctx.auth.subjectId;
      if (!subject) return denied("RESOURCE_NOT_AUTHORIZED");
      let result: Awaited<ReturnType<typeof s.appointments.options>>;
      try {
        result = await s.appointments.options(subject, input);
      } catch (err) {
        return fromError(err, "SCHEDULING_LOOKUP_FAILED");
      }
      const appointments = result.appointments.slice(0, 16).map(appointmentRecord);
      const options = result.slots.slice(0, 16).map((sl) => optionRecord(sl, input.appointmentId));
      const first = result.slots[0];
      const next = result.appointments[0];
      const refs = [...result.appointments.map((a) => sourceRef("scheduling", a.appointmentId)), ...result.slots.slice(0, 3).map((x) => sourceRef("scheduling", x.slotId))];
      const speech = first
        ? speechFor(s.deps.templates, "appointment.option_offer", whenSlots(first.startsAt, first.timeZone), refs)
        : next && input.appointmentId === null
          ? speechFor(s.deps.templates, "appointment.facts", { providerName: next.providerDisplayName, ...whenSlots(next.startsAt, next.timeZone) }, refs)
          : speechFor(s.deps.templates, "appointment.no_options");
      return ok({ appointments: [...appointments, ...options], appointmentCount: appointments.length, optionCount: options.length }, speech);
    },
  };
}

export const PrepareInput = z.strictObject({
  appointmentId: Id.nullable(),
  startsAt: InstantArg,
  modality: Modality.nullable(),
  /** Optional opaque slot id from get_appointment_options; must match the authoritative open slot at startsAt. */
  slotId: Id.nullable().optional(),
});
export const PrepareOutput = z.strictObject({
  change: z.strictObject({
    actionId: z.string().regex(/^act_[A-Za-z0-9_-]{16,64}$/),
    actionDigest: z.string().regex(/^[a-f0-9]{64}$/),
    confirmationTemplateId: z.enum(["appointment.change_confirmation", "appointment.create_confirmation"]),
    expiresAt: InstantArg,
    slotId: Id,
    startsAt: InstantArg,
    timeZone: z.string().max(64),
  }),
  confirmationRequired: z.literal(true),
  nextStep: z.literal("TRUSTED_CONFIRMATION_REQUIRED"),
});

export function prepareAppointmentChangeTool(s: BusinessServices): ToolModule<z.infer<typeof PrepareInput>, z.infer<typeof PrepareOutput>> {
  return {
    definition: TOOL_DEFINITIONS.prepare_appointment_change,
    maskTarget: { collectionKey: "change", envelopeKeys: ["confirmationRequired", "nextStep"] },
    input: PrepareInput,
    output: PrepareOutput,
    purpose: () => "caller_self_service",
    async resolveResource(auth, input) {
      if (input.appointmentId !== null) {
        const subject = await s.appointments.subjectOf(input.appointmentId);
        return subject ? subjectResource(auth, "appointment", subject, "PHI") : unresolvableResource(auth, "appointment", "PHI");
      }
      return auth.subjectId ? subjectResource(auth, "appointment", auth.subjectId, "PHI") : unresolvableResource(auth, "appointment", "PHI");
    },
    async execute(ctx, input) {
      let r: Awaited<ReturnType<typeof s.appointments.prepare>>;
      try {
        r = await s.appointments.prepare(ctx.auth, ctx.decision, input);
      } catch (err) {
        return fromError(err, "PREPARE_FAILED");
      }
      if (r.kind === "SLOT_UNAVAILABLE") return failed("SLOT_UNAVAILABLE");
      if (r.kind === "OPTION_AMBIGUOUS") return failed("OPTION_AMBIGUOUS");
      if (r.kind === "NOT_ELIGIBLE") return failed(r.reasonCode);
      const { action, slot, from } = r;
      const to = whenSlots(slot.startsAt, slot.timeZone);
      const refs = [sourceRef("action", action.actionId), sourceRef("scheduling", slot.slotId)];
      const speech = from
        ? speechFor(
            s.deps.templates,
            "appointment.change_confirmation",
            (() => {
              const f = whenSlots(from.startsAt, from.timeZone);
              return { fromDate: f.date, fromTime: f.time, fromTimeZone: f.timeZone, toDate: to.date, toTime: to.time, toTimeZone: to.timeZone };
            })(),
            refs,
          )
        : speechFor(s.deps.templates, "appointment.create_confirmation", to, refs);
      return ok(
        {
          change: {
            actionId: action.actionId,
            actionDigest: action.digest,
            confirmationTemplateId: from ? "appointment.change_confirmation" : "appointment.create_confirmation",
            expiresAt: action.expiresAt,
            slotId: slot.slotId,
            startsAt: slot.startsAt,
            timeZone: slot.timeZone,
          },
          confirmationRequired: true,
          nextStep: "TRUSTED_CONFIRMATION_REQUIRED",
        },
        speech,
      );
    },
  };
}

const CommitRecord = z.strictObject({
  actionId: z.string().regex(/^act_[A-Za-z0-9_-]{16,64}$/).nullable(),
  appointmentId: Id.nullable(),
  receiptId: Id.nullable(),
  startsAt: InstantArg,
  status: z.enum(["SCHEDULED", "OPEN"]),
  timeZone: z.string().max(64),
});
export const CommitOutput = z.strictObject({
  appointments: z.array(CommitRecord).max(6),
  committed: z.boolean(),
  commitOutcome: z.enum(["COMMITTED", "SLOT_UNAVAILABLE"]),
  nextStep: z.enum(["NONE", "CHOOSE_NEW_OPTION"]),
});

/** Resource of a prepared action bound to THIS session; anything else resolves to a denied resource. */
async function preparedResource(s: BusinessServices, auth: AuthContext, input: CommitInputT, kinds: readonly string[], type: string, classification: "PHI" | "FINANCIAL") {
  const action = await s.deps.actions.get(auth.tenantId, input.actionId).catch(() => null);
  const binding = auditSessionRef(auth);
  if (!action || !kinds.includes(action.kind) || binding === null || action.sessionRef !== binding) return { action: null, resource: unresolvableResource(auth, type, classification, input.digest) };
  return { action, resource: subjectResource(auth, type, action.subjectId, classification, input.digest) };
}

export function commitAppointmentChangeTool(s: BusinessServices): ToolModule<CommitInputT, z.infer<typeof CommitOutput>> {
  const definition = TOOL_DEFINITIONS.commit_appointment_change;
  return {
    definition,
    maskTarget: { collectionKey: "appointments", envelopeKeys: ["committed", "commitOutcome", "nextStep"] },
    input: CommitInput,
    output: CommitOutput,
    purpose: () => "caller_self_service",
    async resolveResource(auth, input) {
      const { action, resource } = await preparedResource(s, auth, input, ["appointment.reschedule", "appointment.create"], "appointment", "PHI");
      if (action && action.kind === "appointment.reschedule") {
        // The appointment's authoritative subject must still be the action's subject.
        const subject = await s.appointments.subjectOf(action.target.recordRef).catch(() => null);
        if (subject !== action.subjectId) return unresolvableResource(auth, "appointment", "PHI", input.digest);
      }
      return resource;
    },
    async execute(ctx, input) {
      const { action, resource } = await preparedResource(s, ctx.auth, input, ["appointment.reschedule", "appointment.create"], "appointment", "PHI");
      if (!action) return denied("RESOURCE_NOT_AUTHORIZED");
      const r = await s.appointments.commit(ctx.auth, input, { action: definition.permissions[0] as string, purpose: "caller_self_service", tool: toolPolicyRef(definition), resource });
      switch (r.kind) {
        case "COMMITTED": {
          const a = r.appointment;
          const created = action.kind === "appointment.create";
          return ok(
            {
              appointments: [{ actionId: r.actionId, appointmentId: a.appointmentId, receiptId: r.receiptId, startsAt: a.startsAt, status: "SCHEDULED", timeZone: a.timeZone }],
              committed: true,
              commitOutcome: "COMMITTED",
              nextStep: "NONE",
            },
            speechFor(s.deps.templates, created ? "appointment.create_committed" : "appointment.change_committed", whenSlots(a.startsAt, a.timeZone), [
              sourceRef("receipt", r.receiptId),
              sourceRef("scheduling", a.appointmentId),
            ]),
          );
        }
        case "SLOT_UNAVAILABLE": {
          const first = r.options[0];
          return ok(
            {
              appointments: r.options.slice(0, 5).map((o) => ({ actionId: null, appointmentId: r.appointmentId, receiptId: null, startsAt: o.startsAt, status: "OPEN" as const, timeZone: o.timeZone })),
              committed: false,
              commitOutcome: "SLOT_UNAVAILABLE",
              nextStep: "CHOOSE_NEW_OPTION",
            },
            first
              ? speechFor(s.deps.templates, "appointment.slot_unavailable_next_option", whenSlots(first.startsAt, first.timeZone), [sourceRef("action", action.actionId), sourceRef("scheduling", first.slotId)])
              : speechFor(s.deps.templates, "appointment.slot_unavailable"),
          );
        }
        case "STATE_CHANGED":
          return failed("STATE_CHANGED");
        case "UNKNOWN":
          return unknownOutcome(r.reasonCode, r.reconciliationRef);
        case "RETRYABLE":
          return retryable(r.reasonCode, r.retryAfterMs);
        case "DENIED":
          return denied(r.reasonCode);
        case "REJECTED":
        case "FAILED":
          return failed(r.reasonCode);
      }
    },
  };
}

