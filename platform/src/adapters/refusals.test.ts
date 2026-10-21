/**
 * Typed refusal reasons (WP-06; FO-06-25 follow-up; OPS-03, OPS-04): UNSUPPORTED_UNDOCUMENTED for vendor
 * behaviour that is not documented, NOT_IMPLEMENTED for documented behaviour that is not built, and the
 * registry scan the live composition (WP-07) uses to refuse NOT_IMPLEMENTED operations.
 */
import { describe, expect, it } from "vitest";
import { createBlockedLiveRegistry } from "./live/blocked-set.js";
import { BlockedCapabilityError, NOT_IMPLEMENTED, NotImplementedOperationError, UNSUPPORTED_UNDOCUMENTED, UnsupportedOperationError, refusalOf } from "./errors.js";
import { AdapterRegistry } from "./registry.js";

const live = (refusals?: Record<string, string>) => ({ kind: "live" as const, integrationId: "billing", health: async () => ({ healthy: true, reasonCode: null }), ...(refusals ? { refusals } : {}) });

describe("typed refusal reasons [FO-06-25][OPS-03]", () => {
  it("[FO-06-25] each refusal error carries its typed reason; blocked capabilities default to UNSUPPORTED_UNDOCUMENTED", () => {
    expect(refusalOf(new UnsupportedOperationError("talkdesk", "transfer"))).toBe(UNSUPPORTED_UNDOCUMENTED);
    expect(refusalOf(new NotImplementedOperationError("billing", "listInvoices"))).toBe(NOT_IMPLEMENTED);
    const b = new BlockedCapabilityError("claims", "getClaimStatus", ["PRQ-007"]);
    expect([b.reasonCode, refusalOf(b)]).toEqual(["BLOCKED_CAPABILITY_UNVERIFIED", UNSUPPORTED_UNDOCUMENTED]);
    expect(refusalOf(new BlockedCapabilityError("claims", "x", [], NOT_IMPLEMENTED))).toBe(NOT_IMPLEMENTED);
    expect(refusalOf(new Error("other"))).toBeNull();
    expect(new NotImplementedOperationError("billing", "x").message).toBe("NOT_IMPLEMENTED");
  });

  it("[FO-06-25][OPS-04] the live-composition scan lists NOT_IMPLEMENTED operations of live adapters; fixtures and documented refusals are separated", () => {
    const reg = new AdapterRegistry();
    reg.register("billing", live({ listInvoices: NOT_IMPLEMENTED, explainLine: UNSUPPORTED_UNDOCUMENTED }));
    reg.register("claims", { ...live(), integrationId: "claims" });
    reg.register("scheduling", { kind: "local_fixture" as const, integrationId: "scheduling", health: async () => ({ healthy: true, reasonCode: null }), refusals: { book: NOT_IMPLEMENTED } });
    expect(reg.notImplementedLiveOperations()).toEqual([{ component: "billing", integrationId: "billing", operation: "listInvoices", refusal: NOT_IMPLEMENTED }]);
    expect(reg.liveCompositionRefusals().map((r) => `${r.component}:${r.operation}:${r.refusal}`)).toEqual(["billing:explainLine:UNSUPPORTED_UNDOCUMENTED", "billing:listInvoices:NOT_IMPLEMENTED"]);
    expect(() => new AdapterRegistry().register("billing", live({ x: "MAYBE_LATER" }))).toThrow("ADAPTER_REFUSALS_INVALID");
  });

  it("[FO-06-25] the BLOCKED stubs of a deployed process today are UNSUPPORTED_UNDOCUMENTED (no documented API or tenant evidence), never NOT_IMPLEMENTED", () => {
    const reg = createBlockedLiveRegistry();
    const refusals = reg.liveCompositionRefusals();
    expect(refusals.length).toBeGreaterThan(0);
    expect(refusals.every((r) => r.refusal === UNSUPPORTED_UNDOCUMENTED && r.operation === "*")).toBe(true);
    expect(reg.notImplementedLiveOperations()).toEqual([]);
  });
});
