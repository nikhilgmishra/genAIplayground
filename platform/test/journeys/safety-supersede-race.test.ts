/**
 * SAFE-HANDOFF-02 round 2, end to end on the LOCAL FIXTURE composition (full container, REAL business
 * module, real HTTP surface, worker loops, FakeClock; SYNTHETIC calls; LOCAL FIXTURE telephony and
 * transfer store). One active journey per call, SAFETY first, must hold when the safety route's
 * supersede races a STANDARD journey's write. The interleaving is forced with explicit gates (no
 * timers, no microtask counting): the human request's STANDARD dial is in flight when the caller's
 * safety signal arrives, and the safety route's supersede read returns a snapshot taken before that
 * dial's write commits, so its conditional SUPERSEDED write meets a version conflict.
 * Nothing here is Talkdesk or production evidence.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ConflictError } from "../../src/shared/errors.js";
import { isActiveJourney } from "../../src/workflows/transfer.js";
import type { TransferJourney } from "../../src/workflows/transfer.js";
import { createJourneyHarness, journeyOf } from "./harness.js";
import type { JourneyHarness } from "./harness.js";

let h: JourneyHarness;
beforeAll(async () => {
  h = await createJourneyHarness({ ingestKnowledge: false });
}, 180_000);
afterAll(async () => {
  await h?.close();
});
beforeEach(async () => {
  await h.c.fixtures.telephony.deliverAll();
});

const tel = () => h.c.fixtures.telephony;

function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((r) => {
    open = r;
  });
  return { wait, open };
}

/** Yields to the event loop until `cond` holds (bounded: an interleaving that never happens fails the test). */
async function until(cond: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (await cond()) return;
    await new Promise<void>((r) => setImmediate(r));
  }
  throw new Error("forced interleaving did not happen");
}

describe("safety supersede under concurrent writes (LOCAL FIXTURE composition)", () => {
  it("[SAFE-03][SAFE-HANDOFF-02] a safety signal while the human request's STANDARD dial is in flight, with the supersede read racing that dial's write: only the safety journey stays active and nothing STANDARD dials or prompts after the safety responder connects", async () => {
    const call = h.call();
    await call.start();
    tel().scriptDestination("dst_support_general", { outcome: "STALLED", after: "QUEUED" });
    tel().scriptDestination("dst_outage_continuity", { outcome: "STALLED", after: "QUEUED" });
    tel().scriptDestination("dst_safety_priority", { outcome: "CONNECTED" });

    const store = h.c.transferStore;
    const origDial = tel().requestTransfer.bind(tel());
    const origList = store.listForCall.bind(store);
    const origPut = store.put.bind(store);
    const origGet = store.get.bind(store);
    const dialAnswer = gate();
    let screenP: ReturnType<typeof call.screen> | null = null;
    let forcedRead = false;
    let waitedForWrite = false;
    let supersedeConflicts = 0;

    // The STANDARD dial command is sent; the vendor's answer is held back while the safety signal arrives.
    const dialSpy = vi.spyOn(tel(), "requestTransfer").mockImplementation(async (input) => {
      const r = await origDial(input);
      if (input.callId === call.callId && input.priority === "STANDARD" && screenP === null) {
        screenP = call.screen("I don't want to live anymore");
        await dialAnswer.wait;
      }
      return r;
    });
    // The first read that sees both journeys returns its snapshot only after the STANDARD write committed.
    const listSpy = vi.spyOn(store, "listForCall").mockImplementation(async (tenantId, callId) => {
      const snapshot = await origList(tenantId, callId);
      const std = snapshot.find((j) => j.priority === "STANDARD");
      if (!forcedRead && screenP !== null && std && snapshot.some((j) => j.priority === "SAFETY")) {
        forcedRead = true;
        dialAnswer.open();
        await until(async () => ((await origGet(std.handoffId))?.version ?? 0) > std.version);
        waitedForWrite = true;
      }
      return snapshot;
    });
    const putSpy = vi.spyOn(store, "put").mockImplementation(async (journey: TransferJourney, expectedVersion: number | null) => {
      try {
        await origPut(journey, expectedVersion);
      } catch (err) {
        if (journey.status === "SUPERSEDED" && err instanceof ConflictError) supersedeConflicts += 1;
        throw err;
      }
    });

    let human: Awaited<ReturnType<typeof call.human>>;
    let screen: Awaited<ReturnType<typeof call.screen>>;
    try {
      human = await call.human({ reason: "CALLER_REQUESTED_HUMAN", language: "en", issueCategory: null });
      expect(screenP, "the safety signal arrived during the STANDARD dial").not.toBeNull();
      screen = await (screenP as unknown as ReturnType<typeof call.screen>);
    } finally {
      dialAnswer.open();
      dialSpy.mockRestore();
      listSpy.mockRestore();
      putSpy.mockRestore();
    }
    // The race really happened: the supersede write met a version conflict and was retried.
    expect(forcedRead && waitedForWrite).toBe(true);
    expect(supersedeConflicts).toBeGreaterThanOrEqual(1);

    expect(screen.body.route).toBe("SAFETY_PRIORITY_HUMAN");
    // The human request is answered with the safety route the caller is on.
    expect(human.status).toBe(200);
    expect(human.body).toMatchObject({ handoffId: screen.body.handoffId, destinationId: "dst_safety_priority" });

    const safety = await journeyOf(h, screen.body.handoffId as string);
    const journeys = await h.c.transfers.journeysForCall(safety.tenantId, call.callId);
    expect(journeys.map((j) => [j.priority, j.status])).toEqual([
      ["STANDARD", "SUPERSEDED"],
      ["SAFETY", "ROUTING"],
    ]);

    for (let i = 0; i < 6; i++) await h.runWorker(["telephony.local_fixture_delivery"]);
    expect((await journeyOf(h, safety.handoffId)).status).toBe("CONNECTED");
    const dialsAtConnect = tel().dials.filter((d) => d.callId === call.callId).length;
    for (let i = 0; i < 6; i++) {
      h.clock.advanceMs(61_000);
      await h.runWorker(["transfers.sweep", "telephony.local_fixture_delivery"]);
    }
    const dials = tel().dials.filter((d) => d.callId === call.callId);
    expect(dials.length).toBe(dialsAtConnect);
    expect(dials.map((d) => [d.destinationId, d.priority])).toEqual([
      ["dst_support_general", "STANDARD"],
      ["dst_safety_priority", "SAFETY"],
    ]);
    expect(tel().updates.filter((u) => u.callId === call.callId)).toHaveLength(0);
    const after = await h.c.transfers.journeysForCall(safety.tenantId, call.callId);
    expect(after.filter(isActiveJourney).map((j) => j.priority)).toEqual(["SAFETY"]);
    expect((await call.handoffContext()).body).toMatchObject({ priority: "SAFETY", destinationId: "dst_safety_priority" });
    await call.end("TRANSFERRED");
  });
});
