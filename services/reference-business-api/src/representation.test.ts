import { describe, expect, it } from "vitest";
import { canonicalJson, digestEquals, requestDigest } from "./ids.js";
import type { AppointmentRow } from "./representation.js";
import { appointment, legacyAppointment, localWallClock } from "./representation.js";
import { decodeCursor, encodeCursor } from "./routes-scheduling.js";
import { fromWallClock } from "./routes-legacy.js";

const row: AppointmentRow = {
  appointment_id: "apt_aaaaaaaaaaaaaaaaaaaa",
  subject_id: "sub_aaaaaaaaaaaaaaaaaaaa",
  provider_id: "prv_aaaaaaaaaaaaaaaaaaaa",
  display_name: "Synthetic Provider",
  slot_id: null,
  starts_at: new Date("2026-11-02T14:00:00.000Z"),
  time_zone: "America/New_York",
  modality: "in_person",
  status: "SCHEDULED",
  version: 3,
  visit_reason: null,
  external_ref: null,
  updated_at: new Date("2026-10-01T00:00:00.000Z"),
};

describe("representations and request identity [FO-06-74]", () => {
  it("[FO-06-74] the two dialects differ only in codes (which a tenant mapping translates)", () => {
    const c = appointment(row, "canonical");
    const l = appointment(row, "legacy_codes");
    expect([c.status, c.modality]).toEqual(["SCHEDULED", "in_person"]);
    expect([l.status, l.modality]).toEqual(["BKD", "OFC"]);
    expect({ ...c, status: null, modality: null }).toEqual({ ...l, status: null, modality: null });
    expect(c.version).toBe("3");
  });

  it("[FO-06-74] the legacy wall-clock time round-trips through the account's zone across a DST change", () => {
    // 2026-11-01 is the US fall-back date: 14:00Z on Nov 2 is 09:00 EST, and on Oct 30 it is 10:00 EDT.
    expect(localWallClock(new Date("2026-11-02T14:00:00Z"), "America/New_York")).toBe("2026-11-02T09:00");
    expect(localWallClock(new Date("2026-10-30T14:00:00Z"), "America/New_York")).toBe("2026-10-30T10:00");
    expect(fromWallClock("2026-11-02T09:00", "America/New_York").toISOString()).toBe("2026-11-02T14:00:00.000Z");
    expect(fromWallClock("2026-10-30T10:00", "America/New_York").toISOString()).toBe("2026-10-30T14:00:00.000Z");
    expect(legacyAppointment(row, "America/New_York")).toMatchObject({ startLocal: "2026-11-02T09:00", state: "BKD", modeCode: "OFC", rev: 3 });
  });

  it("[ACT-02] the request digest is independent of key order and changes with any value", () => {
    const a = requestDigest("scheduling.booking.put", { slotId: "slt_a", subjectId: "sub_b", slotVersion: "1" });
    const b = requestDigest("scheduling.booking.put", { slotVersion: "1", subjectId: "sub_b", slotId: "slt_a" });
    expect(digestEquals(a, b)).toBe(true);
    expect(digestEquals(a, requestDigest("scheduling.booking.put", { slotId: "slt_a", subjectId: "sub_b", slotVersion: "2" }))).toBe(false);
    expect(digestEquals(a, requestDigest("scheduling.reschedule.put", { slotId: "slt_a", subjectId: "sub_b", slotVersion: "1" }))).toBe(false);
    expect(digestEquals(a, "")).toBe(false);
    expect(canonicalJson({ b: 1, a: [2, { d: null, c: true }] })).toBe('{"a":[2,{"c":true,"d":null}],"b":1}');
  });

  it("[FO-06-74] list cursors are opaque tokens that decode to the offset they encode and refuse anything else", () => {
    const c = encodeCursor(150);
    expect(c).toMatch(/^cur_[A-Za-z0-9_-]{16,64}$/);
    expect(decodeCursor(c)).toBe(150);
    expect(decodeCursor(undefined)).toBe(0);
    expect(() => decodeCursor(`cur_${Buffer.from("offset:-0000001").toString("base64url")}`)).toThrow();
  });
});
