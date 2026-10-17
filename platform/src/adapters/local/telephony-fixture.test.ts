import { beforeEach, describe, expect, it } from "vitest";
import { CALLS, DESTINATIONS } from "../../fixtures/synthetic-world.js";
import { createMemoryLogger } from "../../observability/logger.js";
import { FakeClock } from "../../shared/clock.js";
import { AccessDeniedError, PlatformError, ValidationError } from "../../shared/errors.js";
import { newId } from "../../shared/ids.js";
import { FaultInjector } from "./faults.js";
import { TelephonyFixture, deliveryOrder, statesForScript, type TelephonyEvent } from "./telephony-fixture.js";

const ALLOWLIST = DESTINATIONS.map((d) => ({ destinationId: d.destinationId, vendorQueueRef: d.vendorQueueRef, purpose: d.purpose }));
const TEMPLATES = ["transfer.hold_update", "safety.hold_update", "transfer.next_route_update"];

let faults: FaultInjector;
let mem: ReturnType<typeof createMemoryLogger>;
let tel: TelephonyFixture;
let events: TelephonyEvent[];

const request = (destinationId: unknown = "dst_support_general", priority: "SAFETY" | "STANDARD" = "STANDARD") =>
  tel.requestTransfer({ callId: CALLS.primary.callId, destinationId: destinationId as string, handoffId: newId("hof"), priority });

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
  faults = new FaultInjector();
  mem = createMemoryLogger();
  tel = new TelephonyFixture({ destinations: ALLOWLIST, approvedTemplateIds: TEMPLATES, faults, clock: new FakeClock(), logger: mem.logger });
  events = [];
  tel.subscribe((e) => {
    events.push(e);
  });
});

describe("TelephonyFixture (LOCAL FIXTURE, not Talkdesk)", () => {
  it("[SAFE-05] only allowlisted destination ids are accepted; phone numbers, URIs, unknown ids and non-strings are refused and nothing is dialled", async () => {
    const hostile: unknown[] = [
      "+15555550101",
      "15555550101",
      "tel:+15555550101",
      "sip:support@pbx.example.invalid",
      "https://attacker.example.invalid/dial?n=15555550101",
      "dst_15555550101",
      "dst_not_configured",
      "DST_SUPPORT_GENERAL",
      "",
      15555550101,
      null,
      { destinationId: "dst_support_general" },
    ];
    for (const d of hostile) {
      const err = await rejection(request(d));
      expect(err).toBeInstanceOf(AccessDeniedError);
      expect(err.reasonCode).toBe("DESTINATION_NOT_ALLOWLISTED");
    }
    expect(tel.dials).toEqual([]);
    expect(tel.rejections).toHaveLength(hostile.length);
    expect(tel.rejections.filter((r) => r.looksLikeDialTarget).length).toBeGreaterThanOrEqual(6);
    // The rejected value itself is never stored or logged.
    const kept = JSON.stringify([tel.rejections, mem.records]);
    expect(kept).not.toContain("5555550101");
    expect(kept).not.toContain("attacker");
  });

  it("[SAFE-05] a dial target smuggled in an extra field is rejected by the strict schema", async () => {
    const err = await rejection(
      tel.requestTransfer({ callId: CALLS.primary.callId, destinationId: "dst_support_general", handoffId: newId("hof"), priority: "STANDARD", phoneNumber: "+15555550101" } as never),
    );
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.reasonCode).toBe("TRANSFER_INPUT_INVALID");
    expect(tel.dials).toEqual([]);
  });

  it("[SAFE-05] the trusted allowlist itself is validated: dial targets, duplicates and empty lists are refused at construction", () => {
    expect(() => new TelephonyFixture({ destinations: [] })).toThrow(expect.objectContaining({ reasonCode: "TELEPHONY_ALLOWLIST_EMPTY" }));
    expect(() => new TelephonyFixture({ destinations: [{ destinationId: "dst_ok_queue", vendorQueueRef: "+15555550101" }] })).toThrow(expect.objectContaining({ reasonCode: "TELEPHONY_ALLOWLIST_INVALID" }));
    expect(() => new TelephonyFixture({ destinations: [{ destinationId: "dst_ok_queue", vendorQueueRef: "tel:5555550101" }] })).toThrow(ValidationError);
    expect(() => new TelephonyFixture({ destinations: [{ destinationId: "+15555550101", vendorQueueRef: "QUEUE_REF" }] })).toThrow(ValidationError);
    expect(() =>
      new TelephonyFixture({
        destinations: [
          { destinationId: "dst_ok_queue", vendorQueueRef: "QUEUE_A" },
          { destinationId: "dst_ok_queue", vendorQueueRef: "QUEUE_B" },
        ],
      }),
    ).toThrow(expect.objectContaining({ reasonCode: "TELEPHONY_ALLOWLIST_DUPLICATE" }));
  });

  it("[SAFE-04] a successful request is only REQUESTED; connection is reported only after acceptance and bridge", async () => {
    const { transferRef } = await request("dst_safety_priority", "SAFETY");
    expect(tel.dials).toEqual([expect.objectContaining({ transferRef, destinationId: "dst_safety_priority", vendorQueueRef: "TALKDESK_QUEUE_PLACEHOLDER_SAFETY", priority: "SAFETY" })]);
    expect(events).toEqual([]);
    await tel.deliverNext();
    expect(events.map((e) => e.state)).toEqual(["REQUESTED"]);
    await tel.deliverAll();
    expect(events.map((e) => e.state)).toEqual(["REQUESTED", "QUEUED", "RECEIVER_ACCEPTED", "BRIDGED", "CALLER_CONFIRMED_CONNECTED"]);
    expect(events.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(events.map((e) => e.eventId)).size).toBe(5);
    expect(events.every((e) => e.transferRef === transferRef && e.destinationId === "dst_safety_priority")).toBe(true);
  });

  it("[SAFE-04] injectable outcomes: receiver unavailable, timeout, dropped bridge, caller disconnect and a stalled transfer", async () => {
    expect(statesForScript({ outcome: "RECEIVER_UNAVAILABLE" })).toEqual(["REQUESTED", "QUEUED", "RECEIVER_UNAVAILABLE"]);
    expect(statesForScript({ outcome: "TIMED_OUT", after: "QUEUED" })).toEqual(["REQUESTED", "QUEUED", "TIMED_OUT"]);
    expect(statesForScript({ outcome: "BRIDGE_DROPPED" })).toEqual(["REQUESTED", "QUEUED", "RECEIVER_ACCEPTED", "BRIDGED", "BRIDGE_DROPPED"]);
    expect(statesForScript({ outcome: "CALLER_DISCONNECTED", after: "RECEIVER_ACCEPTED" })).toEqual(["REQUESTED", "QUEUED", "RECEIVER_ACCEPTED", "CALLER_DISCONNECTED"]);
    expect(statesForScript({ outcome: "STALLED", after: "QUEUED" })).toEqual(["REQUESTED", "QUEUED"]);
    expect(statesForScript({ outcome: "CONNECTED", complete: true }).at(-1)).toBe("COMPLETED");

    tel.scriptDestination("dst_support_general", { outcome: "RECEIVER_UNAVAILABLE" });
    tel.scriptNextTransfer({ outcome: "BRIDGE_DROPPED" });
    const dropped = await request("dst_support_general");
    const unavailable = await request("dst_support_general");
    await tel.deliverAll();
    expect(tel.vendorState(dropped.transferRef)).toBe("BRIDGE_DROPPED");
    expect(tel.vendorState(unavailable.transferRef)).toBe("RECEIVER_UNAVAILABLE");
    expect(events.filter((e) => e.transferRef === unavailable.transferRef).map((e) => e.state)).toEqual(["REQUESTED", "QUEUED", "RECEIVER_UNAVAILABLE"]);
    expect(() => tel.scriptDestination("dst_unknown_queue", { outcome: "CONNECTED" })).toThrow(expect.objectContaining({ reasonCode: "DESTINATION_NOT_ALLOWLISTED" }));
  });

  it("[SPEC-14.faults] duplicate and out-of-order delivery keep stable event ids and a logical sequence consumers can reorder by", async () => {
    tel.scriptNextTransfer({ outcome: "CONNECTED" }, { duplicate: true, outOfOrder: true });
    const { transferRef } = await request();
    await tel.deliverAll();
    const mine = events.filter((e) => e.transferRef === transferRef);
    expect(mine).toHaveLength(10);
    expect(new Set(mine.map((e) => e.eventId)).size).toBe(5);
    expect(mine.filter((e) => e.delivery.duplicate)).toHaveLength(5);
    const firstSeen = [...new Map(mine.map((e) => [e.eventId, e])).values()];
    expect(firstSeen.map((e) => e.state)).not.toEqual(["REQUESTED", "QUEUED", "RECEIVER_ACCEPTED", "BRIDGED", "CALLER_CONFIRMED_CONNECTED"]);
    expect([...firstSeen].sort((a, b) => a.sequence - b.sequence).map((e) => e.state)).toEqual(["REQUESTED", "QUEUED", "RECEIVER_ACCEPTED", "BRIDGED", "CALLER_CONFIRMED_CONNECTED"]);
    expect(deliveryOrder([1, 2, 3, 4, 5], { outOfOrder: true }).map((x) => x.item)).toEqual([1, 3, 2, 5, 4]);
  });

  it("[SPEC-14.faults] DUPLICATE_DELIVERY and OUT_OF_ORDER faults on requestTransfer apply to that transfer's events", async () => {
    faults.inject({ integrationId: "talkdesk-telephony", operation: "requestTransfer", kind: "DUPLICATE_DELIVERY" });
    faults.inject({ integrationId: "talkdesk-telephony", operation: "requestTransfer", kind: "OUT_OF_ORDER" });
    const a = await request();
    const b = await request();
    await tel.deliverAll();
    expect(events.filter((e) => e.transferRef === a.transferRef)).toHaveLength(10);
    expect(events.filter((e) => e.transferRef === b.transferRef).map((e) => e.state)).toEqual(["REQUESTED", "QUEUED", "RECEIVER_ACCEPTED", "BRIDGED", "CALLER_CONFIRMED_CONNECTED"]);
  });

  it("[SPEC-14.faults] an event a subscriber fails to process is redelivered (at-least-once), with a bound", async () => {
    let failOnce = true;
    tel.subscribe((e) => {
      if (e.state === "BRIDGED" && failOnce) {
        failOnce = false;
        throw new ValidationError("SUBSCRIBER_BUSY");
      }
    });
    await request();
    await tel.deliverAll();
    expect(tel.deliveryFailures).toEqual([{ eventId: expect.stringMatching(/:4$/), reasonCode: "SUBSCRIBER_BUSY" }]);
    const bridged = events.filter((e) => e.state === "BRIDGED");
    expect(bridged).toHaveLength(2);
    expect(bridged[1]?.delivery.redelivery).toBe(true);
    expect(bridged[0]?.eventId).toBe(bridged[1]?.eventId);

    const always = new TelephonyFixture({ destinations: ALLOWLIST, maxRedeliveries: 2 });
    always.subscribe(() => {
      throw new Error("down");
    });
    await always.requestTransfer({ callId: CALLS.primary.callId, destinationId: "dst_support_general", handoffId: newId("hof"), priority: "STANDARD" });
    expect(await always.deliverAll()).toBe(5 * 3);
  });

  it("[SPEC-10.transfer] a caller hang-up mid-transfer drops pending progress and emits CALLER_DISCONNECTED", async () => {
    const { transferRef } = await request();
    await tel.deliverNext();
    await tel.deliverNext();
    tel.simulateCallerDisconnect(transferRef);
    await tel.deliverAll();
    expect(events.map((e) => e.state)).toEqual(["REQUESTED", "QUEUED", "CALLER_DISCONNECTED"]);
    expect(tel.vendorState(transferRef)).toBe("CALLER_DISCONNECTED");
  });

  it("[SPEC-14.faults] telephony outage fails NOT_STARTED with nothing dialled; timeout after commit leaves a real transfer behind an UNKNOWN outcome", async () => {
    faults.inject({ integrationId: "talkdesk-telephony", operation: "requestTransfer", kind: "OUTAGE" });
    expect(await rejection(request())).toMatchObject({ reasonCode: "CONNECTION_REFUSED", outcome: "NOT_STARTED" });
    expect(tel.dials).toEqual([]);
    faults.inject({ integrationId: "talkdesk-telephony", operation: "requestTransfer", kind: "TIMEOUT_AFTER_COMMIT" });
    expect(await rejection(request())).toMatchObject({ reasonCode: "TIMEOUT_AFTER_SEND", outcome: "UNKNOWN" });
    expect(tel.dials).toHaveLength(1);
    expect(tel.pendingEvents).toBe(5);
  });

  it("[ACT-05] approved updates are template ids only: free text and unapproved templates are refused, nothing else is recorded", async () => {
    await tel.playApprovedUpdate({ callId: CALLS.primary.callId, templateId: "transfer.hold_update" });
    expect(tel.updates).toEqual([{ callId: CALLS.primary.callId, templateId: "transfer.hold_update", at: "2026-10-17T15:00:00.000Z" }]);
    expect(await rejection(tel.playApprovedUpdate({ callId: CALLS.primary.callId, templateId: "Please hold, your therapist is coming" }))).toBeInstanceOf(ValidationError);
    expect(await rejection(tel.playApprovedUpdate({ callId: CALLS.primary.callId, templateId: "marketing.offer" }))).toMatchObject({ reasonCode: "TEMPLATE_NOT_APPROVED" });
    expect(await rejection(tel.playApprovedUpdate({ callId: CALLS.primary.callId, templateId: "transfer.hold_update", text: "free text" } as never))).toBeInstanceOf(ValidationError);
    expect(tel.updates).toHaveLength(1);
  });

  it("[SAFE-04] unsubscribed listeners receive nothing; the fixture exposes no hang-up operation", async () => {
    const extra: TelephonyEvent[] = [];
    const off = tel.subscribe((e) => {
      extra.push(e);
    });
    off();
    await request();
    await tel.deliverAll();
    expect(extra).toEqual([]);
    expect(events).toHaveLength(5);
    expect("hangUp" in tel || "endCall" in tel).toBe(false);
  });
});
