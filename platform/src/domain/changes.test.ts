/**
 * Unit (Docker-free): request ids, request digests, payload binding and the reconciliation decision (FO-06-75;
 * ACT-02, ACT-03). An absent change is NEVER definitive by itself (a COMMIT can land after the deadline): only the
 * system's FENCED (or REJECTED) answer is NOT_FOUND; the fence is asked only after the deadline plus the skew.
 */
import { describe, expect, it } from "vitest";
import { urlCarriesSensitivePattern } from "../privacy/egress.js";
import type { ChangeState } from "./changes.js";
import { decideLookup, fenceDue, isFenced, payloadMatches, requestDigestOf, requestIdFor } from "./changes.js";
import { externalRefFor } from "./legacy.js";

const KEY = `vsp-${"0a1b2c".repeat(8)}`;

const change = (o: Partial<ChangeState>): ChangeState =>
  ({
    requestId: "idk_x",
    operation: "scheduling.booking.put",
    state: "COMPLETED",
    receiptId: "rcp_x",
    resourceType: "appointment",
    resourceId: "apt_x",
    resourceVersion: "1",
    resourceStartsAt: "2026-10-23T15:00:00.000Z",
    resourceTimeZone: "America/Chicago",
    resourceSlotId: "slt_x",
    resourceSubjectId: "sub_x",
    requestDigest: "d".repeat(64),
    failureCode: null,
    source: {} as ChangeState["source"],
    ...o,
  }) as ChangeState;

describe("change requests and reconciliation decisions", () => {
  it("[ACT-02] the request id is a stable, one-way, URL-safe function of the provider key (same key, same id; another key, another id)", () => {
    const id = requestIdFor(KEY);
    expect(id).toMatch(/^idk_[A-Za-z0-9_-]{32}$/);
    expect(requestIdFor(KEY)).toBe(id);
    expect(requestIdFor(`vsp-${"1".repeat(48)}`)).not.toBe(id);
    expect(id).not.toContain(KEY.slice(4, 20));
    // Opaque in a URL path: never refused by the egress URL check, never key material.
    expect(urlCarriesSensitivePattern(new URL(`https://scheduling.refbiz.test/api/v1/appointment-bookings/${id}`))).toBe(false);
    expect(urlCarriesSensitivePattern(new URL(`https://scheduling.refbiz.test/api/v1/legacy/appointments/${externalRefFor(KEY)}`))).toBe(false);
    expect(externalRefFor(KEY)).not.toBe(id.replace(/^idk_/, "vsp_"));
    for (const bad of ["", "short", "has space here", "x".repeat(129), "ünï-code-key"]) expect(() => requestIdFor(bad)).toThrow("PROVIDER_IDEMPOTENCY_KEY_INVALID");
  });

  it("[ACT-03] the fence is asked only once the deadline plus the skew has passed (liveness; the proof is the system's answer)", () => {
    expect(fenceDue(1_000_000, 250, 1_000_250)).toBe(false);
    expect(fenceDue(1_000_000, 250, 1_000_251)).toBe(true);
    expect(fenceDue(1_000_000, 0, 1_000_000)).toBe(false);
  });

  it("[ACT-03] decideLookup: committed with a receipt; rejected and fenced are no effect; incomplete and every absence stay UNKNOWN", () => {
    expect(decideLookup(change({}), "COMPLETE_BY_REQUEST_ID")).toMatchObject({ outcome: "COMMITTED" });
    expect(decideLookup(change({ state: "REJECTED", receiptId: null }), "COMPLETE_BY_REQUEST_ID")).toEqual({ outcome: "NOT_FOUND", reasonCode: "REQUEST_REJECTED" });
    expect(decideLookup(change({ state: "REJECTED", receiptId: null, failureCode: "FENCED" }), "COMPLETE_BY_REQUEST_ID")).toEqual({ outcome: "NOT_FOUND", reasonCode: "REQUEST_FENCED" });
    expect(decideLookup(change({ state: "INCOMPLETE", receiptId: null }), "COMPLETE_BY_REQUEST_ID")).toEqual({ outcome: "UNKNOWN", reasonCode: "INCOMPLETE_WRITE_NOT_COMPLETED" });
    expect(decideLookup(change({ state: "INCOMPLETE", receiptId: null }), "ROUTE_TO_HUMAN")).toEqual({ outcome: "UNKNOWN", reasonCode: "INCOMPLETE_WRITE_ROUTED_TO_HUMAN" });
    // A COMPLETED change without its receipt is never claimed as committed.
    expect(decideLookup(change({ receiptId: null }), "COMPLETE_BY_REQUEST_ID")).toEqual({ outcome: "UNKNOWN", reasonCode: "INCOMPLETE_WRITE_NOT_COMPLETED" });
    // An absent change is never NOT_FOUND, whatever the reason it is absent (no fence, not due, unanswered).
    for (const reason of ["NOT_VISIBLE_WITHIN_WINDOW", "ABSENCE_NOT_PROVABLE", "FENCE_NOT_DUE"] as const) {
      expect(decideLookup(null, "COMPLETE_BY_REQUEST_ID", reason)).toEqual({ outcome: "UNKNOWN", reasonCode: reason });
    }
    expect(decideLookup(null, "COMPLETE_BY_REQUEST_ID")).toEqual({ outcome: "UNKNOWN", reasonCode: "ABSENCE_NOT_PROVABLE" });
  });

  it("[ACT-03] only a REJECTED change with failure code FENCED is a fence (an INCOMPLETE or COMPLETED one never is)", () => {
    expect(isFenced(change({ state: "REJECTED", failureCode: "FENCED" }))).toBe(true);
    expect(isFenced(change({ state: "REJECTED", failureCode: "DEADLINE_EXCEEDED" }))).toBe(false);
    expect(isFenced(change({ state: "COMPLETED", failureCode: "FENCED" }))).toBe(false);
    expect(isFenced(change({ state: "INCOMPLETE", failureCode: "FENCED" }))).toBe(false);
  });

  it("[ACT-02] the request digest is the reference API's documented REFBIZ_REQUEST_V1 (shared test vector with the service), independent of key order", () => {
    const body = { subjectId: "sub_synthVector000000001", slotId: "slt_synthVector000000001", slotVersion: "1", authority: "CLIENT_CONFIRMED", actingPartyId: "sub_synthVector000000001", notAfter: "2026-10-21T12:05:05.000Z" };
    const BOOKING_DIGEST_VECTOR = "3625c3a0548db6692283b36537a83b2516831ff01c579ab568eab3e98667e8b0";
    expect(requestDigestOf("REFBIZ_REQUEST_V1", "scheduling.booking.put", body)).toBe(BOOKING_DIGEST_VECTOR);
    const reordered = Object.fromEntries(Object.entries(body).reverse());
    expect(requestDigestOf("REFBIZ_REQUEST_V1", "scheduling.booking.put", reordered)).toBe(BOOKING_DIGEST_VECTOR);
    expect(requestDigestOf("REFBIZ_REQUEST_V1", "scheduling.reschedule.put", body)).not.toBe(BOOKING_DIGEST_VECTOR);
    expect(requestDigestOf("REFBIZ_REQUEST_V1", "scheduling.booking.put", { ...body, slotVersion: "2" })).not.toBe(BOOKING_DIGEST_VECTOR);
  });

  it("[ACT-02] payload binding: a declared digest is mandatory and exact; every expected resource field must match; starts compare as instants", () => {
    const c = change({});
    expect(payloadMatches(c, { requestDigest: "d".repeat(64), resourceId: "apt_x", resourceSlotId: "slt_x", resourceSubjectId: "sub_x" }, "REFBIZ_REQUEST_V1")).toBe(true);
    expect(payloadMatches(c, { requestDigest: "e".repeat(64) }, "REFBIZ_REQUEST_V1")).toBe(false);
    expect(payloadMatches(change({ requestDigest: null }), { requestDigest: "d".repeat(64) }, "REFBIZ_REQUEST_V1")).toBe(false);
    // No scheme declared: the digest is not compared, the resource still is.
    expect(payloadMatches(c, { requestDigest: "e".repeat(64) }, null)).toBe(true);
    expect(payloadMatches(c, { requestDigest: null, resourceSlotId: "slt_y" }, "REFBIZ_REQUEST_V1")).toBe(false);
    expect(payloadMatches(c, { requestDigest: null, resourceSubjectId: "sub_y" }, null)).toBe(false);
    expect(payloadMatches(c, { requestDigest: null, resourceId: "apt_y" }, null)).toBe(false);
    expect(payloadMatches(c, { requestDigest: null, resourceStartsAt: "2026-10-23T10:00:00-05:00" }, null)).toBe(true);
    expect(payloadMatches(c, { requestDigest: null, resourceStartsAt: "2026-10-23T16:00:00.000Z" }, null)).toBe(false);
    // A rejected change carries no resource: only its digest decides whether it is this request's refusal.
    expect(payloadMatches(change({ state: "REJECTED", resourceId: null, resourceSlotId: null }), { requestDigest: "d".repeat(64), resourceId: "apt_x" }, "REFBIZ_REQUEST_V1")).toBe(true);
  });
});
