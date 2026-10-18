/**
 * Contract between the LOCAL telephony fixture's lifecycle events and the
 * workflow transfer state machine (platform/src/workflows/transfer.ts). Proves
 * that, under any duplicate / out-of-order delivery the fixture can produce,
 * the state machine never reaches CALLER_CONFIRMED_CONNECTED without
 * RECEIVER_ACCEPTED and BRIDGED first (SAFE-04). SYNTHETIC events only.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CALLS, DESTINATIONS } from "../../fixtures/synthetic-world.js";
import type { TransferRecord, TransferState } from "../../protocol/index.js";
import { FakeClock } from "../../shared/clock.js";
import { newId } from "../../shared/ids.js";
import { TransferEventName, transferTransition } from "../../workflows/transfer.js";
import { TRANSFER_EVENT_FOR_STATE, TelephonyFixture, statesForScript, type TelephonyEvent, type TransferScript } from "./telephony-fixture.js";

type Attempt = Pick<TransferRecord, "state" | "history" | "receiverAcknowledgedPackage">;

/** Applies delivered fixture events to the workflow state machine, deduplicating by event id like a consumer must. */
function drive(delivered: readonly Pick<TelephonyEvent, "eventId" | "state">[]): { attempt: Attempt; decisions: string[] } {
  const attempt: Attempt = { state: "REQUESTED", history: [{ state: "REQUESTED", at: "2026-10-17T15:00:00.000Z", source: "fixture" }], receiverAcknowledgedPackage: false };
  const seen = new Set<string>();
  const decisions: string[] = [];
  for (const e of delivered) {
    if (seen.has(e.eventId)) {
      decisions.push("dedup");
      continue;
    }
    seen.add(e.eventId);
    const name = TRANSFER_EVENT_FOR_STATE[e.state];
    if (name === undefined) continue; // REQUESTED: the dial itself
    const d = transferTransition(attempt, TransferEventName.parse(name));
    decisions.push(d.kind);
    if (d.kind === "applied") {
      attempt.state = d.next;
      attempt.history.push({ state: d.next, at: "2026-10-17T15:00:00.000Z", source: "fixture" });
    }
  }
  return { attempt, decisions };
}

const reached = (a: Attempt, s: TransferState) => a.state === s || a.history.some((h) => h.state === s);

async function deliveredFor(script: TransferScript, delivery: { duplicate?: boolean; outOfOrder?: boolean }): Promise<TelephonyEvent[]> {
  const tel = new TelephonyFixture({ destinations: DESTINATIONS.map((d) => ({ destinationId: d.destinationId, vendorQueueRef: d.vendorQueueRef })), clock: new FakeClock() });
  const out: TelephonyEvent[] = [];
  tel.subscribe((e) => {
    out.push(e);
  });
  tel.scriptNextTransfer(script, delivery);
  await tel.requestTransfer({ callId: CALLS.primary.callId, destinationId: "dst_support_general", handoffId: newId("hof"), priority: "STANDARD" });
  await tel.deliverAll();
  return out;
}

describe("Telephony fixture events x workflow transfer state machine", () => {
  it("[SAFE-04] in-order delivery drives the state machine to CALLER_CONFIRMED_CONNECTED through acceptance and bridge", async () => {
    const { attempt } = drive(await deliveredFor({ outcome: "CONNECTED" }, {}));
    expect(attempt.history.map((h) => h.state)).toEqual(["REQUESTED", "QUEUED", "RECEIVER_ACCEPTED", "BRIDGED", "CALLER_CONFIRMED_CONNECTED"]);
  });

  it("[SAFE-04] out-of-order delivery is rejected rather than skipping the bridge; reordering by sequence recovers the true state", async () => {
    const delivered = await deliveredFor({ outcome: "CONNECTED" }, { outOfOrder: true });
    const raw = drive(delivered);
    expect(raw.decisions).toContain("rejected");
    expect(raw.attempt.state).not.toBe("CALLER_CONFIRMED_CONNECTED");
    const ordered = drive([...delivered].sort((a, b) => a.sequence - b.sequence));
    expect(ordered.attempt.state).toBe("CALLER_CONFIRMED_CONNECTED");
  });

  it("[ACT-02] duplicate delivery is absorbed: the same final state with or without duplicates", async () => {
    const plain = drive(await deliveredFor({ outcome: "BRIDGE_DROPPED" }, {}));
    const dup = drive(await deliveredFor({ outcome: "BRIDGE_DROPPED" }, { duplicate: true }));
    expect(dup.attempt.state).toBe("BRIDGE_DROPPED");
    expect(dup.attempt.history).toEqual(plain.attempt.history);
    expect(dup.decisions.filter((d) => d === "dedup")).toHaveLength(5);
  });

  it("[SAFE-04] failure outcomes never report a connected caller", async () => {
    for (const script of [
      { outcome: "RECEIVER_UNAVAILABLE" },
      { outcome: "TIMED_OUT", after: "BRIDGED" },
      { outcome: "CALLER_DISCONNECTED", after: "BRIDGED" },
      { outcome: "STALLED", after: "RECEIVER_ACCEPTED" },
    ] as TransferScript[]) {
      const { attempt } = drive(await deliveredFor(script, { duplicate: true, outOfOrder: true }));
      expect(reached(attempt, "CALLER_CONFIRMED_CONNECTED")).toBe(false);
    }
  });

  it("[SAFE-04] property: under ANY permutation and duplication of fixture events, connection implies prior acceptance and bridge", () => {
    const scripts: TransferScript[] = [
      { outcome: "CONNECTED" },
      { outcome: "CONNECTED", complete: true },
      { outcome: "BRIDGE_DROPPED", after: "CALLER_CONFIRMED_CONNECTED" },
      { outcome: "RECEIVER_UNAVAILABLE" },
      { outcome: "TIMED_OUT", after: "RECEIVER_ACCEPTED" },
    ];
    fc.assert(
      fc.property(
        fc.constantFrom(...scripts),
        fc.array(fc.nat(), { minLength: 1, maxLength: 16 }),
        (script, picks) => {
          const events = statesForScript(script).map((state, i) => ({ eventId: `tdx_synthProperty000001:${i + 1}`, state }));
          // Arbitrary delivery: each pick selects an event (duplicates and reordering included).
          const delivered = picks.map((p) => events[p % events.length] as (typeof events)[number]);
          const { attempt } = drive(delivered);
          if (reached(attempt, "CALLER_CONFIRMED_CONNECTED")) {
            expect(reached(attempt, "RECEIVER_ACCEPTED")).toBe(true);
            expect(reached(attempt, "BRIDGED")).toBe(true);
          }
          if (!statesForScript(script).includes("CALLER_CONFIRMED_CONNECTED")) expect(reached(attempt, "CALLER_CONFIRMED_CONNECTED")).toBe(false);
        },
      ),
      { numRuns: 400 },
    );
  });
});
