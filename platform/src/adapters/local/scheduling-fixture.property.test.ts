import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { APPOINTMENTS, SLOTS } from "../../fixtures/synthetic-world.js";
import { FakeClock } from "../../shared/clock.js";
import { PlatformError } from "../../shared/errors.js";
import { FaultInjector } from "./faults.js";
import { SchedulingFixture } from "./scheduling-fixture.js";
import { SyntheticStore } from "./synthetic-store.js";

const APPTS = APPOINTMENTS.map((a) => a.appointmentId);
const SLOT_IDS = SLOTS.map((s) => s.slotId);
const FAULTS = ["NONE", "TIMEOUT_AFTER_COMMIT", "DUPLICATE_DELIVERY", "PARTIAL_WRITE", "TIMEOUT_BEFORE_SEND"] as const;

const command = fc.record({
  appt: fc.integer({ min: 0, max: APPTS.length - 1 }),
  slot: fc.integer({ min: 0, max: SLOT_IDS.length - 1 }),
  key: fc.integer({ min: 0, max: 5 }),
  staleVersion: fc.boolean(),
  fault: fc.constantFrom(...FAULTS),
});

describe("SchedulingFixture properties (LOCAL FIXTURE, SYNTHETIC)", () => {
  it("[ACT-02] under any mix of retries, duplicates, ambiguous timeouts and partial writes: one effect per idempotency key and consistent slot ownership", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(command, { minLength: 1, maxLength: 25 }), async (commands) => {
        const store = new SyntheticStore();
        const faults = new FaultInjector();
        const sched = new SchedulingFixture({ store, faults, clock: new FakeClock("2026-10-17T15:00:00.000Z") });
        const committedKeys = new Set<string>();
        for (const c of commands) {
          const appointmentId = APPTS[c.appt] as string;
          const current = store.get("appointments", appointmentId);
          const beforeVersion = c.staleVersion ? "v1" : (current?.version ?? "v1");
          const idempotencyKey = `prop-key-${c.key}-${appointmentId}`;
          if (c.fault !== "NONE") faults.inject({ integrationId: "scheduling", operation: "reschedule", kind: c.fault });
          const revBefore = store.revision;
          const replayExpected = (await sched.findByIdempotencyKey(idempotencyKey)) !== null;
          try {
            await sched.reschedule({ appointmentId, beforeVersion, slotId: SLOT_IDS[c.slot] as string, idempotencyKey });
          } catch (err) {
            expect(err).toBeInstanceOf(PlatformError);
          }
          faults.clear();
          if ((await sched.findByIdempotencyKey(idempotencyKey)) !== null) committedKeys.add(idempotencyKey);
          // A replay of a committed key never changes state.
          if (replayExpected) expect(store.revision).toBe(revBefore);
        }
        const effects = sched.effects;
        expect(new Set(effects.map((e) => e.idempotencyKey)).size).toBe(effects.length);
        expect(effects.length).toBe(committedKeys.size);
        // Every slot is held by at most one appointment and every appointment's slot points back to it.
        for (const a of store.list("appointments")) {
          if (a.slotId === null) continue;
          expect(store.get("slots", a.slotId)?.heldBy).toEqual({ kind: "appointment", appointmentId: a.appointmentId });
        }
        for (const s of store.list("slots")) {
          if (s.heldBy?.kind !== "appointment") continue;
          const holder = s.heldBy.appointmentId;
          expect(store.get("appointments", holder)?.slotId).toBe(s.slotId);
        }
        // Versions only move forward with committed effects.
        for (const a of store.list("appointments")) {
          const n = effects.filter((e) => e.appointmentId === a.appointmentId).length;
          expect(a.version).toBe(`v${1 + n}`);
        }
      }),
      { numRuns: 120 },
    );
  });
});
