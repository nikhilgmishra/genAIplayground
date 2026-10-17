import { describe, expect, it } from "vitest";
import { APPOINTMENTS, DELEGATIONS, INVOICES, PEOPLE, SLOTS, SYNTHETIC_BADGE } from "../../fixtures/synthetic-world.js";
import { ConflictError, ValidationError } from "../../shared/errors.js";
import { COLLECTIONS, SyntheticStore, nextVersion } from "./synthetic-store.js";

describe("SyntheticStore (LOCAL FIXTURE, SYNTHETIC data)", () => {
  it("[OPS-04] is labelled as a local fixture and seeded with a deep copy of the canonical SYNTHETIC world", () => {
    const s = new SyntheticStore();
    expect(s.kind).toBe("local_fixture");
    expect(s.badge).toBe(SYNTHETIC_BADGE);
    expect(s.list("appointments").map((a) => a.appointmentId)).toEqual(APPOINTMENTS.map((a) => a.appointmentId));
    expect(s.list("slots")).toHaveLength(SLOTS.length);
    expect(s.list("people")).toHaveLength(Object.keys(PEOPLE).length);
    expect(s.get("delegations", DELEGATIONS[3].grantId)?.constraints).toEqual(["MINOR_CONFIDENTIALITY_REVIEW"]);
    for (const c of COLLECTIONS) expect(s.collectionRevision(c)).toBe(0);
  });

  it("[SPEC-14.faults] updates bump record versions and revision counters; the canonical world is never mutated", () => {
    const s = new SyntheticStore();
    const id = INVOICES[0].invoiceId;
    const updated = s.update("invoices", id, (inv) => {
      inv.status = "IN_REVIEW";
    });
    expect(updated.version).toBe("v2");
    expect(s.revision).toBe(1);
    expect(s.collectionRevision("invoices")).toBe(1);
    expect(s.collectionRevision("appointments")).toBe(0);
    expect(INVOICES[0].status).toBe("OPEN");
    expect(INVOICES[0].version).toBe("v1");
    // STALE_READ support: the previous version is retained.
    expect(s.previousVersion("invoices", id)?.status).toBe("OPEN");
    expect(s.staleGet("invoices", id)?.version).toBe("v1");
    expect(s.staleList("invoices").find((i) => i.invoiceId === id)?.status).toBe("OPEN");
  });

  it("[SPEC-14.faults] accessors return copies, so callers cannot mutate the store without update()", () => {
    const s = new SyntheticStore();
    const a = s.get("appointments", APPOINTMENTS[0].appointmentId);
    if (!a) throw new Error("fixture missing");
    a.startsAt = "2030-01-01T00:00:00.000Z";
    s.list("slots")[0]!.heldBy = { kind: "external" };
    expect(s.get("appointments", APPOINTMENTS[0].appointmentId)?.startsAt).toBe(APPOINTMENTS[0].startsAt);
    expect(s.list("slots")[0]?.heldBy).toBeNull();
    expect(s.revision).toBe(0);
  });

  it("[SPEC-14.faults] reset() restores the canonical state and zeroes counters (per-test isolation)", () => {
    const s = new SyntheticStore();
    s.update("slots", SLOTS[0].slotId, (x) => {
      x.heldBy = { kind: "external" };
    });
    s.nextSequence();
    s.reset();
    expect(s.get("slots", SLOTS[0].slotId)?.heldBy).toBeNull();
    expect(s.revision).toBe(0);
    expect(s.nextSequence()).toBe(1);
    expect(s.previousVersion("slots", SLOTS[0].slotId)).toBeNull();
  });

  it("[SPEC-14.faults] fails closed on unknown records, id changes and duplicate inserts", () => {
    const s = new SyntheticStore();
    expect(() => s.update("invoices", "inv_synthDoesNotExist01", () => undefined)).toThrow(ValidationError);
    expect(() =>
      s.update("invoices", INVOICES[0].invoiceId, (i) => {
        i.invoiceId = "inv_synthSomethingElse01";
      }),
    ).toThrow(expect.objectContaining({ reasonCode: "FIXTURE_RECORD_ID_IMMUTABLE" }));
    const existing = s.get("claims", "clm_synthAveryClaim0001");
    if (!existing) throw new Error("fixture missing");
    expect(() => s.insert("claims", existing)).toThrow(ConflictError);
    expect(nextVersion("v9")).toBe("v10");
    expect(() => nextVersion("9")).toThrow(ValidationError);
  });
});
