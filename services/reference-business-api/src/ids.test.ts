import { describe, expect, it } from "vitest";
import { canonicalJson, digestEquals, requestDigest } from "./ids.js";

describe("request digests [FO-06-74][ACT-02]", () => {
  it("[ACT-02] the stored request digest is REFBIZ_REQUEST_V1 as documented (shared test vector with the platform's domain module)", () => {
    const body = { subjectId: "sub_synthVector000000001", slotId: "slt_synthVector000000001", slotVersion: "1", authority: "CLIENT_CONFIRMED", actingPartyId: "sub_synthVector000000001", notAfter: "2026-10-21T12:05:05.000Z" };
    const BOOKING_DIGEST_VECTOR = "3625c3a0548db6692283b36537a83b2516831ff01c579ab568eab3e98667e8b0";
    expect(requestDigest("scheduling.booking.put", body)).toBe(BOOKING_DIGEST_VECTOR);
    // Key order and absent optional fields do not change the canonical form; any value does.
    expect(requestDigest("scheduling.booking.put", Object.fromEntries(Object.entries(body).reverse()))).toBe(BOOKING_DIGEST_VECTOR);
    expect(canonicalJson({ b: "2", a: "1", c: undefined })).toBe('{"a":"1","b":"2"}');
    expect(requestDigest("scheduling.booking.put", { ...body, notAfter: "2026-10-21T12:05:06.000Z" })).not.toBe(BOOKING_DIGEST_VECTOR);
    expect(digestEquals(BOOKING_DIGEST_VECTOR, requestDigest("scheduling.booking.put", body))).toBe(true);
  });
});
