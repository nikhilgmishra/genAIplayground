import { describe, expect, it } from "vitest";
import { FaultBoard } from "./faults.js";

describe("fault board: scoped, counted, bounded [FO-17-24]", () => {
  it("[FO-06-74] without fault control the request log keeps nothing (no reader, no memory growth)", () => {
    const off = new FaultBoard(undefined, false);
    off.record("acc_aaaaaaaaaaaaaaaaaaaa", { operation: "claims.get", keyRef: null, status: 200 });
    expect(off.requestsOf("acc_aaaaaaaaaaaaaaaaaaaa")).toEqual([]);
    const on = new FaultBoard();
    on.record("acc_aaaaaaaaaaaaaaaaaaaa", { operation: "claims.get", keyRef: null, status: 200 });
    expect(on.requestsOf("acc_aaaaaaaaaaaaaaaaaaaa")).toHaveLength(1);
  });

  it("[FO-17-24] with nothing armed every check is a no-op (the API behaves as documented)", () => {
    const b = new FaultBoard();
    expect(b.take("acc_aaaaaaaaaaaaaaaaaaaa", "claims.get", ["DELAY_RESPONSE", "HTTP_STATUS"])).toBeNull();
    expect(b.slotReadTriggersChange("acc_aaaaaaaaaaaaaaaaaaaa", "slt_aaaaaaaaaaaaaaaaaaaa")).toBe(false);
  });

  it("[FO-17-24] a fault fires only for its account, operation (or prefix) and kind, at most `times` times, and counts every hit", () => {
    const b = new FaultBoard();
    const f = b.arm("acc_aaaaaaaaaaaaaaaaaaaa", { operation: "claims.*", kind: "DELAY_RESPONSE", delayMs: 50, times: 2 });
    expect(b.take("acc_bbbbbbbbbbbbbbbbbbbb", "claims.get", ["DELAY_RESPONSE"])).toBeNull();
    expect(b.take("acc_aaaaaaaaaaaaaaaaaaaa", "billing.invoice.get", ["DELAY_RESPONSE"])).toBeNull();
    expect(b.take("acc_aaaaaaaaaaaaaaaaaaaa", "claims.get", ["HTTP_STATUS"])).toBeNull();
    expect(b.take("acc_aaaaaaaaaaaaaaaaaaaa", "claims.get", ["DELAY_RESPONSE"])?.delayMs).toBe(50);
    expect(b.take("acc_aaaaaaaaaaaaaaaaaaaa", "claims.list", ["DELAY_RESPONSE"])).not.toBeNull();
    expect(b.take("acc_aaaaaaaaaaaaaaaaaaaa", "claims.get", ["DELAY_RESPONSE"])).toBeNull();
    expect(f.hits).toBe(2);
    expect(b.list("acc_aaaaaaaaaaaaaaaaaaaa")[0]?.remaining).toBe(0);
  });

  it("[FO-17-24] an exact operation does not match a longer one; a resource-scoped fault matches only its resource", () => {
    const b = new FaultBoard();
    b.arm("acc_aaaaaaaaaaaaaaaaaaaa", { operation: "claims.get", kind: "HTTP_STATUS", status: 503 });
    expect(b.take("acc_aaaaaaaaaaaaaaaaaaaa", "claims.getx", ["HTTP_STATUS"])).toBeNull();
    b.arm("acc_aaaaaaaaaaaaaaaaaaaa", { operation: "scheduling.booking.put", kind: "PARTIAL_WRITE", resourceId: "slt_aaaaaaaaaaaaaaaaaaaa" });
    expect(b.take("acc_aaaaaaaaaaaaaaaaaaaa", "scheduling.booking.put", ["PARTIAL_WRITE"], "slt_bbbbbbbbbbbbbbbbbbbb")).toBeNull();
    expect(b.take("acc_aaaaaaaaaaaaaaaaaaaa", "scheduling.booking.put", ["PARTIAL_WRITE"], "slt_aaaaaaaaaaaaaaaaaaaa")).not.toBeNull();
  });

  it("[FAULT:CHANGED_SLOT_DURING_CONFIRMATION seam] the slot version changes only after the configured number of read-backs", () => {
    const b = new FaultBoard();
    b.arm("acc_aaaaaaaaaaaaaaaaaaaa", { operation: "scheduling.slot.get", kind: "SLOT_VERSION_CHANGE", resourceId: "slt_aaaaaaaaaaaaaaaaaaaa", afterReads: 2, times: 1 });
    expect(b.slotReadTriggersChange("acc_aaaaaaaaaaaaaaaaaaaa", "slt_bbbbbbbbbbbbbbbbbbbb")).toBe(false);
    expect(b.slotReadTriggersChange("acc_aaaaaaaaaaaaaaaaaaaa", "slt_aaaaaaaaaaaaaaaaaaaa")).toBe(false);
    expect(b.slotReadTriggersChange("acc_aaaaaaaaaaaaaaaaaaaa", "slt_aaaaaaaaaaaaaaaaaaaa")).toBe(true);
    expect(b.slotReadTriggersChange("acc_aaaaaaaaaaaaaaaaaaaa", "slt_aaaaaaaaaaaaaaaaaaaa")).toBe(false);
  });

  it("[FAULT:CONCURRENT_SAME_ACCOUNT seam] a barrier holds writes to one resource until every party arrived, then releases them together", async () => {
    const b = new FaultBoard();
    const bar = b.addBarrier("acc_aaaaaaaaaaaaaaaaaaaa", "scheduling.reschedule.put", "apt_aaaaaaaaaaaaaaaaaaaa", 2, 5_000);
    const order: string[] = [];
    const first = b.arrive("acc_aaaaaaaaaaaaaaaaaaaa", "scheduling.reschedule.put", "apt_aaaaaaaaaaaaaaaaaaaa").then(() => order.push("first"));
    await new Promise((r) => setTimeout(r, 30));
    expect(order).toEqual([]);
    expect(bar.arrived).toBe(1);
    // Another resource is never held.
    await b.arrive("acc_aaaaaaaaaaaaaaaaaaaa", "scheduling.reschedule.put", "apt_bbbbbbbbbbbbbbbbbbbb");
    const second = b.arrive("acc_aaaaaaaaaaaaaaaaaaaa", "scheduling.reschedule.put", "apt_aaaaaaaaaaaaaaaaaaaa").then(() => order.push("second"));
    await Promise.all([first, second]);
    expect(order.sort()).toEqual(["first", "second"]);
    expect(bar.released).toBe(true);
    expect(bar.timedOut).toBe(false);
  });

  it("[FAULT:CONCURRENT_SAME_ACCOUNT seam] a barrier that never fills releases at its timeout and says so", async () => {
    const b = new FaultBoard();
    const bar = b.addBarrier("acc_aaaaaaaaaaaaaaaaaaaa", "scheduling.*", "apt_aaaaaaaaaaaaaaaaaaaa", 3, 100);
    await b.arrive("acc_aaaaaaaaaaaaaaaaaaaa", "scheduling.cancellation.put", "apt_aaaaaaaaaaaaaaaaaaaa");
    expect(bar.timedOut).toBe(true);
    expect(bar.released).toBe(true);
  });

  it("[FO-17-24] the request log is per account and bounded; forgetting an account clears its faults and log", () => {
    const b = new FaultBoard();
    for (let i = 0; i < 10_010; i++) b.record("acc_aaaaaaaaaaaaaaaaaaaa", { operation: "claims.get", keyRef: null, status: 200 });
    expect(b.requestsOf("acc_aaaaaaaaaaaaaaaaaaaa")).toHaveLength(10_000);
    expect(b.requestsOf("acc_bbbbbbbbbbbbbbbbbbbb")).toHaveLength(0);
    b.arm("acc_aaaaaaaaaaaaaaaaaaaa", { operation: "claims.get", kind: "HTTP_STATUS" });
    b.forget("acc_aaaaaaaaaaaaaaaaaaaa");
    expect(b.requestsOf("acc_aaaaaaaaaaaaaaaaaaaa")).toHaveLength(0);
    expect(b.list("acc_aaaaaaaaaaaaaaaaaaaa")).toHaveLength(0);
  });
});
