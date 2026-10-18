import { beforeEach, describe, expect, it } from "vitest";
import { APPOINTMENTS, PEOPLE, SLOTS } from "../../fixtures/synthetic-world.js";
import { FakeClock } from "../../shared/clock.js";
import { ConflictError, PlatformError, ValidationError } from "../../shared/errors.js";
import { FaultInjector } from "./faults.js";
import { SchedulingFixture } from "./scheduling-fixture.js";
import { SyntheticStore } from "./synthetic-store.js";

const AVERY_APPT = APPOINTMENTS[0].appointmentId;
const BLAKE_APPT = APPOINTMENTS[1].appointmentId;
const [SLOT1, SLOT2, SLOT3] = SLOTS.map((s) => s.slotId) as [string, string, string];
const key = (n: string) => `idem-scheduling-${n}-0000000`;

let store: SyntheticStore;
let faults: FaultInjector;
let clock: FakeClock;
let sched: SchedulingFixture;

async function rejection(p: Promise<unknown>): Promise<PlatformError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof PlatformError) return err;
    throw err;
  }
  throw new Error("expected rejection");
}

beforeEach(() => {
  store = new SyntheticStore();
  faults = new FaultInjector();
  clock = new FakeClock("2026-10-17T15:00:00.000Z");
  sched = new SchedulingFixture({ store, faults, clock });
});

describe("SchedulingFixture (LOCAL FIXTURE, SYNTHETIC)", () => {
  it("[SPEC-4.scheduling] slots are administrative availability of the appointment's provider only — no clinical matching fields", async () => {
    expect(sched.kind).toBe("local_fixture");
    const slots = await sched.listSlots({ subjectId: PEOPLE.avery.subjectId, appointmentId: AVERY_APPT, fromDate: "2026-10-20", toDate: "2026-10-31" });
    expect(slots.map((s) => s.slotId)).toEqual([SLOT1, SLOT2, SLOT3]);
    for (const s of slots) expect(Object.keys(s).sort()).toEqual(["modality", "providerDisplayName", "slotId", "startsAt", "timeZone"]);
    expect((await sched.listSlots({ subjectId: PEOPLE.avery.subjectId, appointmentId: AVERY_APPT, fromDate: "2026-10-26", toDate: "2026-10-26" })).map((s) => s.slotId)).toEqual([SLOT2]);
    clock.set("2026-10-24T00:00:00.000Z");
    expect((await sched.listSlots({ subjectId: PEOPLE.avery.subjectId, appointmentId: null, fromDate: "2026-10-20", toDate: "2026-10-31" })).map((s) => s.slotId)).toEqual([SLOT2, SLOT3]);
  });

  it("[AUTH-05] an appointment of another subject is indistinguishable from a missing one; oversized ranges are rejected", async () => {
    const other = await rejection(sched.listSlots({ subjectId: PEOPLE.avery.subjectId, appointmentId: BLAKE_APPT, fromDate: "2026-10-20", toDate: "2026-10-31" }));
    const missing = await rejection(sched.listSlots({ subjectId: PEOPLE.avery.subjectId, appointmentId: "apt_synthDoesNotExist001", fromDate: "2026-10-20", toDate: "2026-10-31" }));
    expect(other.reasonCode).toBe("APPOINTMENT_NOT_FOUND");
    expect(missing.reasonCode).toBe(other.reasonCode);
    expect(await rejection(sched.listSlots({ subjectId: PEOPLE.avery.subjectId, appointmentId: AVERY_APPT, fromDate: "2026-10-20", toDate: "2027-03-01" }))).toMatchObject({ reasonCode: "SLOT_RANGE_INVALID" });
    expect(await sched.listAppointments(PEOPLE.avery.subjectId)).toHaveLength(1);
  });

  it("[SPEC-16.journey] verified client reschedule commits with the current version, moves the appointment and books the slot", async () => {
    const r = await sched.reschedule({ appointmentId: AVERY_APPT, beforeVersion: "v1", slotId: SLOT1, idempotencyKey: key("a") });
    expect(r.appointment).toMatchObject({ appointmentId: AVERY_APPT, startsAt: SLOTS[0].startsAt, version: "v2", status: "SCHEDULED" });
    expect(r.reference).toMatch(/^schref_/);
    expect(await sched.getAppointment(AVERY_APPT)).toEqual(r.appointment);
    const open = await sched.listSlots({ subjectId: PEOPLE.avery.subjectId, appointmentId: AVERY_APPT, fromDate: "2026-10-20", toDate: "2026-10-31" });
    expect(open.map((s) => s.slotId)).toEqual([SLOT2, SLOT3]);
    expect(sched.effects).toHaveLength(1);
  });

  it("[SPEC-16.journey] conflict handling: a stale beforeVersion fails with STATE_CHANGED and changes nothing", async () => {
    sched.simulateConcurrentChange(AVERY_APPT); // another channel changed the appointment (v2)
    const before = store.revision;
    const err = await rejection(sched.reschedule({ appointmentId: AVERY_APPT, beforeVersion: "v1", slotId: SLOT1, idempotencyKey: key("b") }));
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.reasonCode).toBe("STATE_CHANGED");
    expect(store.revision).toBe(before);
    expect(sched.effects).toHaveLength(0);
    expect(await sched.findByIdempotencyKey(key("b"))).toBeNull();
  });

  it("[SPEC-16.journey] conflict handling: a slot taken by a concurrent booking fails with SLOT_UNAVAILABLE", async () => {
    sched.simulateConcurrentBooking(SLOT1);
    const err = await rejection(sched.reschedule({ appointmentId: AVERY_APPT, beforeVersion: "v1", slotId: SLOT1, idempotencyKey: key("c") }));
    expect(err).toMatchObject({ reasonCode: "SLOT_UNAVAILABLE" });
    expect(err).toBeInstanceOf(ConflictError);
    expect((await sched.getAppointment(AVERY_APPT))?.version).toBe("v1");
  });

  it("[SPEC-16.journey] two concurrent calls racing for one slot: exactly one wins, the other gets SLOT_UNAVAILABLE", async () => {
    const results = await Promise.allSettled([
      sched.reschedule({ appointmentId: AVERY_APPT, beforeVersion: "v1", slotId: SLOT2, idempotencyKey: key("avery") }),
      sched.reschedule({ appointmentId: BLAKE_APPT, beforeVersion: "v1", slotId: SLOT2, idempotencyKey: key("blake") }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason).toMatchObject({ reasonCode: "SLOT_UNAVAILABLE" });
    expect(store.list("slots").filter((s) => s.heldBy?.kind === "appointment")).toHaveLength(1);
    expect(sched.effects).toHaveLength(1);
  });

  it("[ACT-02] an idempotent replay returns the original result and creates no second effect; reusing a key for another change is a conflict", async () => {
    const input = { appointmentId: AVERY_APPT, beforeVersion: "v1", slotId: SLOT1, idempotencyKey: key("d") };
    const first = await sched.reschedule(input);
    const rev = store.revision;
    const replay = await sched.reschedule(input);
    expect(replay).toEqual(first);
    expect(store.revision).toBe(rev);
    expect(sched.effects).toHaveLength(1);
    expect(await rejection(sched.reschedule({ ...input, slotId: SLOT3 }))).toMatchObject({ reasonCode: "IDEMPOTENCY_KEY_REUSED" });
    expect(sched.effects).toHaveLength(1);
  });

  it("[ACT-02] DUPLICATE_DELIVERY (the request reaches the system twice) still produces exactly one effect", async () => {
    faults.inject({ integrationId: "scheduling", operation: "reschedule", kind: "DUPLICATE_DELIVERY" });
    const r = await sched.reschedule({ appointmentId: AVERY_APPT, beforeVersion: "v1", slotId: SLOT1, idempotencyKey: key("e") });
    expect(r.appointment.version).toBe("v2");
    expect(sched.deliveries.map((d) => d.outcome)).toEqual(["APPLIED", "REPLAYED"]);
    expect(sched.effects).toHaveLength(1);
    expect((await sched.getAppointment(AVERY_APPT))?.version).toBe("v2");
  });

  it("[ACT-03] TIMEOUT_AFTER_COMMIT yields UNKNOWN with the effect recorded; findByIdempotencyKey reconciles it and a retry adds nothing", async () => {
    faults.inject({ integrationId: "scheduling", operation: "reschedule", kind: "TIMEOUT_AFTER_COMMIT" });
    const input = { appointmentId: AVERY_APPT, beforeVersion: "v1", slotId: SLOT2, idempotencyKey: key("f") };
    const err = await rejection(sched.reschedule(input));
    expect(err).toMatchObject({ reasonCode: "TIMEOUT_AFTER_SEND", outcome: "UNKNOWN", retryable: false });
    expect(sched.effects).toHaveLength(1);
    expect((await sched.getAppointment(AVERY_APPT))?.startsAt).toBe(SLOTS[1].startsAt);
    const found = await sched.findByIdempotencyKey(input.idempotencyKey);
    expect(found?.reference).toBe(sched.effects[0]?.reference);
    expect(found?.appointment.version).toBe("v2");
    expect(await sched.reschedule(input)).toEqual(found);
    expect(sched.effects).toHaveLength(1);
  });

  it("[ACT-03] OUTAGE and TIMEOUT_BEFORE_SEND are NOT_STARTED with no effect and nothing to reconcile", async () => {
    faults.inject({ integrationId: "scheduling", operation: "reschedule", kind: "TIMEOUT_BEFORE_SEND" });
    expect(await rejection(sched.reschedule({ appointmentId: AVERY_APPT, beforeVersion: "v1", slotId: SLOT1, idempotencyKey: key("g") }))).toMatchObject({
      reasonCode: "TIMEOUT_BEFORE_SEND",
      outcome: "NOT_STARTED",
    });
    const outage = faults.inject({ integrationId: "scheduling", operation: "*", kind: "OUTAGE", mode: "persistent" });
    expect(await sched.health()).toEqual({ healthy: false, reasonCode: "DEPENDENCY_UNAVAILABLE" });
    expect(await rejection(sched.listAppointments(PEOPLE.avery.subjectId))).toMatchObject({ reasonCode: "CONNECTION_REFUSED", outcome: "NOT_STARTED" });
    faults.clear(outage);
    expect(await sched.findByIdempotencyKey(key("g"))).toBeNull();
    expect(sched.effects).toHaveLength(0);
    expect(await sched.health()).toEqual({ healthy: true, reasonCode: null });
  });

  it("[ACT-03] a REJECTED write is a definite FAILED outcome with no effect", async () => {
    faults.inject({ integrationId: "scheduling", operation: "reschedule", kind: "REJECTED" });
    expect(await rejection(sched.reschedule({ appointmentId: AVERY_APPT, beforeVersion: "v1", slotId: SLOT1, idempotencyKey: key("r") }))).toMatchObject({
      reasonCode: "DEPENDENCY_REJECTED",
      outcome: "FAILED",
      retryable: false,
    });
    expect(store.revision).toBe(0);
    expect(await sched.findByIdempotencyKey(key("r"))).toBeNull();
  });

  it("[ACT-03] [SPEC-14.faults] PARTIAL_WRITE (afterExternalCommit) commits the booking under the idempotency key before failing: reconciliation finds it and a same-key retry replays it", async () => {
    faults.inject({ integrationId: "scheduling", operation: "reschedule", kind: "PARTIAL_WRITE" });
    const input = { appointmentId: AVERY_APPT, beforeVersion: "v1", slotId: SLOT2, idempotencyKey: key("h") };
    expect(await rejection(sched.reschedule(input))).toMatchObject({ reasonCode: "PARTIAL_WRITE", outcome: "UNKNOWN", retryable: false });
    // The external effect exists and is recorded under the provider idempotency key.
    expect(sched.effects).toEqual([expect.objectContaining({ operation: "reschedule", idempotencyKey: input.idempotencyKey, appointmentId: AVERY_APPT, slotId: SLOT2, beforeVersion: "v1", afterVersion: "v2" })]);
    const found = await sched.findByIdempotencyKey(input.idempotencyKey);
    expect(found).toMatchObject({ appointment: { appointmentId: AVERY_APPT, startsAt: SLOTS[1].startsAt, version: "v2" }, reference: sched.effects[0]?.reference });
    expect((await sched.getAppointment(AVERY_APPT))?.version).toBe("v2");
    // The booked slot is really taken; the released slot is free again.
    expect(await rejection(sched.reschedule({ appointmentId: BLAKE_APPT, beforeVersion: "v1", slotId: SLOT2, idempotencyKey: key("i") }))).toMatchObject({ reasonCode: "SLOT_UNAVAILABLE" });
    expect(store.get("slots", SLOT2)?.heldBy).toEqual({ kind: "appointment", appointmentId: AVERY_APPT });
    // A same-key retry (or reconciliation) never produces a second effect.
    const replay = await sched.reschedule(input);
    expect(replay.reference).toBe(found?.reference);
    expect(sched.effects).toHaveLength(1);
    expect(sched.deliveries.map((d) => d.outcome)).toEqual(["PARTIAL", "REJECTED", "REPLAYED"]);
  });

  it("[ACT-03] [SPEC-14.faults] PARTIAL_WRITE on create records the new appointment under the key before failing", async () => {
    faults.inject({ integrationId: "scheduling", operation: "create", kind: "PARTIAL_WRITE" });
    const input = { subjectId: PEOPLE.avery.subjectId, slotId: SLOT3, idempotencyKey: key("p") };
    expect(await rejection(sched.create(input))).toMatchObject({ reasonCode: "PARTIAL_WRITE", outcome: "UNKNOWN" });
    expect(sched.effects.map((e) => `${e.operation}:${e.idempotencyKey}`)).toEqual([`create:${input.idempotencyKey}`]);
    const found = await sched.findByIdempotencyKey(input.idempotencyKey);
    expect(found?.appointment).toMatchObject({ subjectId: PEOPLE.avery.subjectId, startsAt: SLOTS[2].startsAt, status: "SCHEDULED" });
    expect((await sched.listAppointments(PEOPLE.avery.subjectId)).map((a) => a.appointmentId)).toContain(found?.appointment.appointmentId);
    expect((await sched.create(input)).appointment.appointmentId).toBe(found?.appointment.appointmentId);
    expect(sched.effects).toHaveLength(1);
  });

  it("[SPEC-14.faults] STALE_READ serves the pre-change appointment; the commit-time version check still rejects the stale version", async () => {
    await sched.reschedule({ appointmentId: AVERY_APPT, beforeVersion: "v1", slotId: SLOT1, idempotencyKey: key("j") });
    faults.inject({ integrationId: "scheduling", operation: "getAppointment", kind: "STALE_READ" });
    const stale = await sched.getAppointment(AVERY_APPT);
    expect(stale?.version).toBe("v1");
    expect(await rejection(sched.reschedule({ appointmentId: AVERY_APPT, beforeVersion: stale?.version ?? "", slotId: SLOT3, idempotencyKey: key("k") }))).toMatchObject({
      reasonCode: "STATE_CHANGED",
    });
    expect((await sched.getAppointment(AVERY_APPT))?.version).toBe("v2");
  });

  it("[SPEC-16.journey] rescheduling again releases the previously booked slot", async () => {
    await sched.reschedule({ appointmentId: AVERY_APPT, beforeVersion: "v1", slotId: SLOT1, idempotencyKey: key("l") });
    await sched.reschedule({ appointmentId: AVERY_APPT, beforeVersion: "v2", slotId: SLOT2, idempotencyKey: key("m") });
    expect(store.get("slots", SLOT1)?.heldBy).toBeNull();
    expect(store.get("slots", SLOT2)?.heldBy).toEqual({ kind: "appointment", appointmentId: AVERY_APPT });
    expect(sched.effects.map((e) => e.releasedSlotId)).toEqual([null, SLOT1]);
  });

  it("[SPEC-16.journey] create books a new appointment for a client subject only, idempotently", async () => {
    const input = { subjectId: PEOPLE.avery.subjectId, slotId: SLOT3, idempotencyKey: key("n") };
    const r = await sched.create(input);
    expect(r.appointment).toMatchObject({ subjectId: PEOPLE.avery.subjectId, startsAt: SLOTS[2].startsAt, version: "v1", status: "SCHEDULED" });
    expect(await sched.create(input)).toEqual(r);
    expect(await sched.listAppointments(PEOPLE.avery.subjectId)).toHaveLength(2);
    expect(await rejection(sched.create({ subjectId: PEOPLE.morgan.subjectId, slotId: SLOT1, idempotencyKey: key("o") }))).toMatchObject({ reasonCode: "SUBJECT_NOT_FOUND" });
    expect(await rejection(sched.create({ subjectId: PEOPLE.blake.subjectId, slotId: SLOT3, idempotencyKey: key("p") }))).toMatchObject({ reasonCode: "SLOT_UNAVAILABLE" });
    expect(await sched.findByIdempotencyKey(input.idempotencyKey)).toEqual(r);
  });

  it("[ACT-02] strict input validation rejects unknown fields, malformed ids and short idempotency keys before any effect", async () => {
    await expect(sched.reschedule({ appointmentId: AVERY_APPT, beforeVersion: "v1", slotId: SLOT1, idempotencyKey: "short" })).rejects.toBeInstanceOf(ValidationError);
    await expect(
      sched.reschedule({ appointmentId: AVERY_APPT, beforeVersion: "v1", slotId: SLOT1, idempotencyKey: key("q"), subjectId: PEOPLE.blake.subjectId } as never),
    ).rejects.toMatchObject({ reasonCode: "SCHEDULING_INPUT_INVALID" });
    await expect(sched.getAppointment("Avery's appointment")).rejects.toBeInstanceOf(ValidationError);
    await expect(sched.listSlots({ subjectId: PEOPLE.avery.subjectId, appointmentId: null, fromDate: "10/20/2026", toDate: "2026-10-31" })).rejects.toBeInstanceOf(ValidationError);
    expect(store.revision).toBe(0);
  });

  it("[SPEC-14.faults] QUOTA_EXHAUSTED on a read is HTTP_429 NOT_STARTED with Retry-After", async () => {
    faults.inject({ integrationId: "scheduling", operation: "listAppointments", kind: "QUOTA_EXHAUSTED", retryAfterMs: 2_500 });
    expect(await rejection(sched.listAppointments(PEOPLE.avery.subjectId))).toMatchObject({ reasonCode: "HTTP_429", outcome: "NOT_STARTED", httpStatus: 429, retryAfterMs: 2_500 });
    expect(await sched.listAppointments(PEOPLE.avery.subjectId)).toHaveLength(1);
  });
});
