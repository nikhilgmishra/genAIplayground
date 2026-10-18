/**
 * LOCAL FIXTURE — SchedulingSystem over the SYNTHETIC world. NOT a vendor
 * adapter; rejected by the production configuration guard (OPS-04). The live
 * scheduling adapter is BLOCKED (live/business-systems-blocked.ts, PRQ-007).
 *
 * Behaviour modelled (and tested):
 *  - administrative availability only: open slots of the appointment's own
 *    provider, or every open slot for a new appointment. There is no clinical
 *    suitability matching of any kind (spec section 4);
 *  - optimistic concurrency: `beforeVersion` must equal the current version,
 *    otherwise ConflictError STATE_CHANGED (spec section 8);
 *  - slot conflicts: a slot taken by a concurrent booking (another call, the
 *    portal, staff) yields ConflictError SLOT_UNAVAILABLE;
 *  - idempotency keys: a replay returns the original result without a second
 *    effect; a key reused for a different request is a conflict (ACT-02);
 *  - `findByIdempotencyKey` returns committed results for reconciliation of
 *    UNKNOWN outcomes (ACT-03);
 *  - faults from the shared FaultInjector (OUTAGE, TIMEOUT_BEFORE_SEND,
 *    TIMEOUT_AFTER_COMMIT, SLOW, QUOTA_EXHAUSTED, STALE_READ, PARTIAL_WRITE,
 *    DUPLICATE_DELIVERY). PARTIAL_WRITE is a two-step provider write whose
 *    first step, the booking itself, commits: the appointment change is
 *    applied, logged as an effect and recorded under the provider idempotency
 *    key; the provider's confirmation step then fails, so the caller sees
 *    PARTIAL_WRITE (UNKNOWN). `findByIdempotencyKey` returns the committed
 *    booking for reconciliation (the fault plans are afterExternalCommit) and a
 *    same-key retry replays it without a second effect.
 *  - an append-only effect log so tests can prove "exactly one effect".
 */
import { z } from "zod";
import { silentLogger } from "../../observability/logger.js";
import type { Logger } from "../../observability/ports.js";
import { OpaqueId } from "../../protocol/index.js";
import { iso, systemClock, type Clock } from "../../shared/clock.js";
import { ConflictError, PlatformError, ValidationError } from "../../shared/errors.js";
import { newId } from "../../shared/ids.js";
import type { AdapterHealth, Appointment, SchedulingSystem, Slot } from "../ports.js";
import { READ_FAULTS, WRITE_FAULTS, noFaults, type ActiveFaults, type FaultInjector } from "./faults.js";
import { IdempotencyKey, IdempotencyLedger, requestDigest } from "./idempotency.js";
import { LOCAL_FIXTURE_LABEL, type StoredAppointment, type StoredSlot, type SyntheticStore } from "./synthetic-store.js";

const DateOnly = z.iso.date();
const Version = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/);

const ListSlotsInput = z.strictObject({
  subjectId: OpaqueId,
  appointmentId: OpaqueId.nullable(),
  fromDate: DateOnly,
  toDate: DateOnly,
});
const RescheduleInput = z.strictObject({ appointmentId: OpaqueId, beforeVersion: Version, slotId: OpaqueId, idempotencyKey: IdempotencyKey });
const CreateInput = z.strictObject({ subjectId: OpaqueId, slotId: OpaqueId, idempotencyKey: IdempotencyKey });

export type SchedulingResult = { appointment: Appointment; reference: string };

export interface SchedulingEffect {
  sequence: number;
  operation: "reschedule" | "create";
  idempotencyKey: string;
  appointmentId: string;
  slotId: string;
  releasedSlotId: string | null;
  beforeVersion: string | null;
  afterVersion: string;
  reference: string;
  at: string;
}

export interface SchedulingDelivery {
  operation: "reschedule" | "create";
  idempotencyKey: string;
  /** 1 for the original delivery, 2 for a DUPLICATE_DELIVERY copy. */
  delivery: number;
  outcome: "APPLIED" | "REPLAYED" | "PARTIAL" | "REJECTED";
}

export interface SchedulingFixtureOptions {
  store: SyntheticStore;
  faults?: FaultInjector;
  clock?: Clock;
  logger?: Logger;
  /** Maximum inclusive slot search window in days. */
  maxRangeDays?: number;
}

export const SCHEDULING_FIXTURE_OPERATIONS = {
  listAppointments: READ_FAULTS,
  getAppointment: READ_FAULTS,
  listSlots: READ_FAULTS,
  reschedule: WRITE_FAULTS,
  create: WRITE_FAULTS,
  findByIdempotencyKey: ["OUTAGE", "TIMEOUT_BEFORE_SEND", "SLOW", "QUOTA_EXHAUSTED"],
} as const;

const toAppointment = (a: StoredAppointment): Appointment => ({
  appointmentId: a.appointmentId,
  subjectId: a.subjectId,
  providerDisplayName: a.providerDisplayName,
  startsAt: a.startsAt,
  timeZone: a.timeZone,
  modality: a.modality,
  status: a.status,
  version: a.version,
});

const toSlot = (s: StoredSlot): Slot => ({
  slotId: s.slotId,
  startsAt: s.startsAt,
  timeZone: s.timeZone,
  modality: s.modality,
  providerDisplayName: s.providerDisplayName,
});

const DAY_MS = 86_400_000;

export class SchedulingFixture implements SchedulingSystem {
  readonly kind = "local_fixture" as const;
  readonly integrationId = "scheduling";
  readonly label = LOCAL_FIXTURE_LABEL;
  private readonly store: SyntheticStore;
  private readonly faults: FaultInjector;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly maxRangeDays: number;
  private readonly ledger = new IdempotencyLedger<SchedulingResult>();
  private readonly effectLog: SchedulingEffect[] = [];
  private readonly deliveryLog: SchedulingDelivery[] = [];

  constructor(opts: SchedulingFixtureOptions) {
    this.store = opts.store;
    this.faults = opts.faults ?? noFaults();
    this.clock = opts.clock ?? systemClock;
    this.logger = (opts.logger ?? silentLogger).child({ component: "scheduling_fixture" });
    this.maxRangeDays = opts.maxRangeDays ?? 62;
    this.faults.declare(this.integrationId, SCHEDULING_FIXTURE_OPERATIONS);
  }

  async health(): Promise<AdapterHealth> {
    return this.faults.isDegraded(this.integrationId) ? { healthy: false, reasonCode: "DEPENDENCY_UNAVAILABLE" } : { healthy: true, reasonCode: null };
  }

  async listAppointments(subjectId: string): Promise<Appointment[]> {
    if (!OpaqueId.safeParse(subjectId).success) throw new ValidationError("SCHEDULING_INPUT_INVALID");
    const f = await this.read("listAppointments");
    const rows = f.has("STALE_READ") ? this.store.staleList("appointments") : this.store.list("appointments");
    return rows
      .filter((a) => a.subjectId === subjectId)
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
      .map(toAppointment);
  }

  async getAppointment(appointmentId: string): Promise<Appointment | null> {
    if (!OpaqueId.safeParse(appointmentId).success) throw new ValidationError("SCHEDULING_INPUT_INVALID");
    const f = await this.read("getAppointment");
    const a = f.has("STALE_READ") ? this.store.staleGet("appointments", appointmentId) : this.store.get("appointments", appointmentId);
    return a ? toAppointment(a) : null;
  }

  async listSlots(input: { subjectId: string; appointmentId: string | null; fromDate: string; toDate: string }): Promise<Slot[]> {
    const parsed = ListSlotsInput.safeParse(input);
    if (!parsed.success) throw new ValidationError("SCHEDULING_INPUT_INVALID");
    const q = parsed.data;
    const fromMs = Date.parse(`${q.fromDate}T00:00:00.000Z`);
    const toMs = Date.parse(`${q.toDate}T00:00:00.000Z`);
    if (toMs < fromMs || (toMs - fromMs) / DAY_MS + 1 > this.maxRangeDays) throw new ValidationError("SLOT_RANGE_INVALID");
    const f = await this.read("listSlots");
    const stale = f.has("STALE_READ");

    let providerActorId: string | null = null;
    if (q.appointmentId !== null) {
      const appt = stale ? this.store.staleGet("appointments", q.appointmentId) : this.store.get("appointments", q.appointmentId);
      // The same code for "absent" and "belongs to another subject": no existence disclosure.
      if (!appt || appt.subjectId !== q.subjectId) throw new ValidationError("APPOINTMENT_NOT_FOUND");
      providerActorId = appt.providerActorId;
    } else if (!this.isClientSubject(q.subjectId)) {
      // A provider's own subject lists that provider's own open slots only (their schedule).
      providerActorId = this.providerActorFor(q.subjectId);
      if (providerActorId === null) throw new ValidationError("SUBJECT_NOT_FOUND");
    }
    const nowMs = this.clock.now().getTime();
    const slots = stale ? this.store.staleList("slots") : this.store.list("slots");
    return slots
      .filter((s) => {
        const day = s.startsAt.slice(0, 10);
        return (
          s.heldBy === null &&
          Date.parse(s.startsAt) > nowMs &&
          day >= q.fromDate &&
          day <= q.toDate &&
          (providerActorId === null || s.providerActorId === providerActorId)
        );
      })
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
      .map(toSlot);
  }

  async reschedule(input: { appointmentId: string; beforeVersion: string; slotId: string; idempotencyKey: string }): Promise<SchedulingResult> {
    const parsed = RescheduleInput.safeParse(input);
    if (!parsed.success) throw new ValidationError("SCHEDULING_INPUT_INVALID");
    const req = parsed.data;
    const digest = requestDigest("reschedule", { appointmentId: req.appointmentId, beforeVersion: req.beforeVersion, slotId: req.slotId });
    return this.write("reschedule", req.idempotencyKey, (f, duplicate) => this.applyReschedule(req, digest, f, duplicate));
  }

  async create(input: { subjectId: string; slotId: string; idempotencyKey: string }): Promise<SchedulingResult> {
    const parsed = CreateInput.safeParse(input);
    if (!parsed.success) throw new ValidationError("SCHEDULING_INPUT_INVALID");
    const req = parsed.data;
    const digest = requestDigest("create", { subjectId: req.subjectId, slotId: req.slotId });
    return this.write("create", req.idempotencyKey, (f, duplicate) => this.applyCreate(req, digest, f, duplicate));
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<SchedulingResult | null> {
    if (!IdempotencyKey.safeParse(idempotencyKey).success) throw new ValidationError("SCHEDULING_INPUT_INVALID");
    await this.read("findByIdempotencyKey");
    return this.ledger.find(idempotencyKey);
  }

  // ---------------- LOCAL FIXTURE test helpers ----------------

  /** Append-only log of applied effects (one entry per real state change). */
  get effects(): readonly SchedulingEffect[] {
    return this.effectLog.map((e) => ({ ...e }));
  }

  /** Every write delivery the fixture received, including duplicates and replays. */
  get deliveries(): readonly SchedulingDelivery[] {
    return this.deliveryLog.map((d) => ({ ...d }));
  }

  /** Simulates another channel booking a slot between availability lookup and commit. */
  simulateConcurrentBooking(slotId: string): void {
    this.store.update("slots", slotId, (s) => {
      if (s.heldBy !== null) throw new ConflictError("SLOT_UNAVAILABLE");
      s.heldBy = { kind: "external" };
    });
  }

  /** Simulates another channel changing an appointment (its version advances). */
  simulateConcurrentChange(appointmentId: string): void {
    this.store.update("appointments", appointmentId, () => undefined);
  }

  // ---------------- internals ----------------

  private async read(operation: keyof typeof SCHEDULING_FIXTURE_OPERATIONS): Promise<ActiveFaults> {
    const f = this.faults.begin(this.integrationId, operation);
    await f.beforeSend();
    return f;
  }

  private async write(
    operation: "reschedule" | "create",
    idempotencyKey: string,
    apply: (f: ActiveFaults, duplicate: boolean) => { result: SchedulingResult; outcome: "APPLIED" | "REPLAYED" },
  ): Promise<SchedulingResult> {
    const f = this.faults.begin(this.integrationId, operation);
    await f.beforeSend();
    const copies = f.has("DUPLICATE_DELIVERY") ? 2 : 1;
    let result: SchedulingResult | null = null;
    for (let delivery = 1; delivery <= copies; delivery++) {
      try {
        const r = apply(f, delivery > 1);
        this.deliveryLog.push({ operation, idempotencyKey, delivery, outcome: r.outcome });
        // The caller observes the first delivery's response; duplicates are absorbed by the provider.
        result ??= r.result;
      } catch (err) {
        const reasonCode = err instanceof PlatformError ? err.reasonCode : "UNCLASSIFIED_ERROR";
        this.deliveryLog.push({ operation, idempotencyKey, delivery, outcome: reasonCode === "PARTIAL_WRITE" ? "PARTIAL" : "REJECTED" });
        this.logger.info("fixture.scheduling.write.rejected", { operation, reasonCode });
        throw err;
      }
    }
    f.afterCommit();
    if (result === null) throw new ValidationError("SCHEDULING_FIXTURE_NO_RESULT");
    return result;
  }

  private applyReschedule(
    req: z.infer<typeof RescheduleInput>,
    digest: string,
    f: ActiveFaults,
    duplicate: boolean,
  ): { result: SchedulingResult; outcome: "APPLIED" | "REPLAYED" } {
    const prior = this.ledger.replay(req.idempotencyKey, digest);
    if (prior) return { result: prior, outcome: "REPLAYED" };

    const appt = this.store.get("appointments", req.appointmentId);
    if (!appt) throw new ValidationError("APPOINTMENT_NOT_FOUND");
    const slot = this.store.get("slots", req.slotId);
    const pendingMine = slot !== null && slot.heldBy?.kind === "pending" && slot.heldBy.idempotencyKey === req.idempotencyKey;
    if (appt.status !== "SCHEDULED") throw new ConflictError("APPOINTMENT_NOT_RESCHEDULABLE");
    if (appt.version !== req.beforeVersion) {
      if (pendingMine) this.store.update("slots", req.slotId, (s) => {
        s.heldBy = null;
      });
      throw new ConflictError("STATE_CHANGED");
    }
    if (!slot) throw new ValidationError("SLOT_NOT_FOUND");
    if (slot.providerActorId !== appt.providerActorId) throw new ValidationError("SLOT_NOT_ELIGIBLE");
    this.assertBookable(slot, pendingMine);

    const releasedSlotId = appt.slotId;
    if (releasedSlotId !== null) this.store.update("slots", releasedSlotId, (s) => {
        s.heldBy = null;
      });
    this.store.update("slots", slot.slotId, (s) => {
        s.heldBy = { kind: "appointment", appointmentId: appt.appointmentId };
      });
    const updated = this.store.update("appointments", appt.appointmentId, (a) => {
      a.startsAt = slot.startsAt;
      a.timeZone = slot.timeZone;
      a.modality = slot.modality;
      a.providerDisplayName = slot.providerDisplayName;
      a.slotId = slot.slotId;
    });
    const result: SchedulingResult = { appointment: toAppointment(updated), reference: newId("schref") };
    this.commit("reschedule", req.idempotencyKey, digest, result, {
      appointmentId: appt.appointmentId,
      slotId: slot.slotId,
      releasedSlotId,
      beforeVersion: appt.version,
      afterVersion: updated.version,
    });
    // PARTIAL_WRITE: the booking step above committed (effect + idempotency record); the confirmation step fails.
    if (f.has("PARTIAL_WRITE") && !duplicate) throw f.partialWriteError();
    return { result, outcome: "APPLIED" };
  }

  private applyCreate(
    req: z.infer<typeof CreateInput>,
    digest: string,
    f: ActiveFaults,
    duplicate: boolean,
  ): { result: SchedulingResult; outcome: "APPLIED" | "REPLAYED" } {
    const prior = this.ledger.replay(req.idempotencyKey, digest);
    if (prior) return { result: prior, outcome: "REPLAYED" };
    if (!this.isClientSubject(req.subjectId)) throw new ValidationError("SUBJECT_NOT_FOUND");
    const slot = this.store.get("slots", req.slotId);
    if (!slot) throw new ValidationError("SLOT_NOT_FOUND");
    const pendingMine = slot.heldBy?.kind === "pending" && slot.heldBy.idempotencyKey === req.idempotencyKey;
    this.assertBookable(slot, pendingMine);

    const appointment: StoredAppointment = {
      appointmentId: newId("apt"),
      subjectId: req.subjectId,
      providerActorId: slot.providerActorId,
      providerDisplayName: slot.providerDisplayName,
      startsAt: slot.startsAt,
      timeZone: slot.timeZone,
      modality: slot.modality,
      status: "SCHEDULED",
      version: "v1",
      slotId: slot.slotId,
    };
    this.store.insert("appointments", appointment);
    this.store.update("slots", slot.slotId, (s) => {
        s.heldBy = { kind: "appointment", appointmentId: appointment.appointmentId };
      });
    const result: SchedulingResult = { appointment: toAppointment(appointment), reference: newId("schref") };
    this.commit("create", req.idempotencyKey, digest, result, {
      appointmentId: appointment.appointmentId,
      slotId: slot.slotId,
      releasedSlotId: null,
      beforeVersion: null,
      afterVersion: appointment.version,
    });
    // PARTIAL_WRITE: the booking step above committed (effect + idempotency record); the confirmation step fails.
    if (f.has("PARTIAL_WRITE") && !duplicate) throw f.partialWriteError();
    return { result, outcome: "APPLIED" };
  }

  private assertBookable(slot: StoredSlot, pendingMine: boolean): void {
    if (slot.heldBy !== null && !pendingMine) throw new ConflictError("SLOT_UNAVAILABLE");
    if (Date.parse(slot.startsAt) <= this.clock.now().getTime()) throw new ConflictError("SLOT_UNAVAILABLE");
  }

  private commit(
    operation: "reschedule" | "create",
    idempotencyKey: string,
    digest: string,
    result: SchedulingResult,
    e: Pick<SchedulingEffect, "appointmentId" | "slotId" | "releasedSlotId" | "beforeVersion" | "afterVersion">,
  ): void {
    const at = iso(this.clock.now());
    this.ledger.record(idempotencyKey, digest, result, at);
    this.effectLog.push({ sequence: this.store.nextSequence(), operation, idempotencyKey, reference: result.reference, at, ...e });
    this.logger.info("fixture.scheduling.write.committed", { operation, appointmentId: e.appointmentId, slotId: e.slotId });
  }

  private isClientSubject(subjectId: string): boolean {
    return this.store.list("people").some((p) => p.subjectId === subjectId && p.role === "client");
  }

  /** Actor of the provider whose own subject this is, or null. */
  private providerActorFor(subjectId: string): string | null {
    return this.store.list("people").find((p) => p.subjectId === subjectId && p.role === "provider")?.actorId ?? null;
  }
}
