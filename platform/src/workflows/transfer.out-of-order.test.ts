/**
 * Out-of-order transfer events (ADR-0017; corpus cause OUT_OF_ORDER_TRANSFER_EVENT_DROPPED). Vendor
 * events are at least once and their order is not guaranteed (TB-07). An early progress event is held
 * per attempt and applied only after its predecessor, through the pure transition again (SAFE-04); it
 * never refreshes the attempt timeout and is discarded when its attempt closes, is replaced or the
 * journey is superseded. LOCAL FIXTURE store and telephony; SYNTHETIC calls and destinations; FakeClock.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { TelephonyFixture } from "../adapters/local/telephony-fixture.js";
import type { DestinationConfig } from "../config/ports.js";
import { CALLS, DESTINATIONS, TENANT_ID } from "../fixtures/synthetic-world.js";
import { createMemoryLogger } from "../observability/logger.js";
import type { HandoffPackage, TransferRecord } from "../protocol/index.js";
import { FakeClock } from "../shared/clock.js";
import { ConflictError } from "../shared/errors.js";
import { newId } from "../shared/ids.js";
import { LocalTelephonyDeliveryLoop } from "../worker/loops.js";
import { MemoryTransferStore, TransferCoordinator, journeyOutcome, type TransferCoordinatorConfig, type TransferEventName, type TransferJourney } from "./transfer.js";
import { MemoryAuditWriterFixture, TelephonyControlFixture } from "./workflow-test-fixtures.js";

const START = "2026-10-18T09:00:00.000Z";

/** The composition's engineering defaults (src/main/container.ts); operational values are set by support operations. */
const config: TransferCoordinatorConfig = {
  environment: "local",
  updateTemplateIds: { STANDARD: "transfer.update.standard", SAFETY: "transfer.update.safety" },
  attemptTimeoutMs: { STANDARD: 60_000, SAFETY: 30_000 },
  maxStandardContinuityAttempts: 2,
};

const destinations = (): DestinationConfig[] => DESTINATIONS.map((d) => ({ ...d, fallbackDestinationIds: [...d.fallbackDestinationIds], languages: [...d.languages] }));

/** LOCAL FIXTURE store whose next matching write fails with a version conflict (a concurrent writer won). */
class ConflictOnceStore extends MemoryTransferStore {
  conflictWhen: ((j: TransferJourney) => boolean) | null = null;
  override async put(journey: TransferJourney, expectedVersion: number | null): Promise<void> {
    const when = this.conflictWhen;
    if (when && when(journey)) {
      this.conflictWhen = null;
      throw new ConflictError("TRANSFER_VERSION_CONFLICT");
    }
    return super.put(journey, expectedVersion);
  }
}

/**
 * LOCAL FIXTURE store whose SUPERSEDED writes fail as a store outage while set. `afterWrite` runs
 * after a write landed and before the writer's next step (the predecessor's write window); every
 * landed write is kept, so a test can show a state was never written.
 */
class SupersedeOutageStore extends ConflictOnceStore {
  failSupersededWrites = false;
  afterWrite: ((j: TransferJourney) => Promise<void>) | null = null;
  readonly written: TransferJourney[] = [];
  override async put(journey: TransferJourney, expectedVersion: number | null): Promise<void> {
    if (journey.status === "SUPERSEDED" && this.failSupersededWrites) throw new Error("synthetic store outage");
    await super.put(journey, expectedVersion);
    this.written.push(structuredClone(journey));
    const hook = this.afterWrite;
    if (hook) await hook(journey);
  }
}

function setup(store = new ConflictOnceStore()) {
  const clock = new FakeClock(START);
  const telephony = new TelephonyControlFixture();
  const audit = new MemoryAuditWriterFixture();
  const { logger, records } = createMemoryLogger();
  const coordinator = new TransferCoordinator({ store, telephony, destinations: destinations(), clock, audit, logger, config });
  return { clock, telephony, audit, store, coordinator, logs: records };
}

function handoff(overrides: Partial<HandoffPackage> = {}): HandoffPackage {
  return {
    handoffId: newId("hof"),
    tenantId: TENANT_ID,
    callId: CALLS.primary.callId,
    sessionGeneration: 1,
    reason: "CALLER_REQUESTED_HUMAN",
    destinationId: "dst_support_general",
    statedIssue: "other",
    issueSummary: "Template-assembled synthetic summary: caller asked for a person.",
    assurance: "A0",
    assuranceLimits: [],
    authorizedSubjectRef: null,
    consent: { recording: "GRANTED", automatedProcessing: "GRANTED", disclosureTemplateVersion: "disclosure-2026.10", capturedAt: START, capturedBy: "studio_flow" },
    actionReceiptIds: [],
    pendingActionIds: [],
    unresolvedTasks: [],
    supportReference: null,
    language: "en",
    accommodations: [],
    safetyRoutingReason: null,
    clinicalStatementsIncluded: false,
    verificationAssertion: null,
    createdAt: START,
    ...overrides,
  };
}

const safetyHandoff = (overrides: Partial<HandoffPackage> = {}) =>
  handoff({ reason: "SAFETY_PRIORITY", destinationId: "dst_safety_priority", statedIssue: "safety_concern", safetyRoutingReason: "EXPLICIT_PHRASE", ...overrides });

const current = (j: TransferJourney): TransferRecord => {
  const a = j.attempts.find((x) => x.transferId === j.currentTransferId);
  if (!a) throw new Error("no current attempt");
  return a;
};
const attemptOf = (j: TransferJourney, transferId: string): TransferRecord => {
  const a = j.attempts.find((x) => x.transferId === transferId);
  if (!a) throw new Error("no such attempt");
  return a;
};
const statesOf = (a: TransferRecord) => a.history.map((h) => h.state);
const eventRefs = (pointers: readonly string[]) => pointers.filter((p) => p.startsWith("transfer_event:"));

describe("out-of-order transfer events are held for their predecessor (ADR-0017)", () => {
  it.each([
    ["STANDARD", 60_000],
    ["SAFETY", 30_000],
  ] as const)(
    "[SAFE-03][SAFE-04][OPS-02] %s: a held CALLER_CONFIRMED_CONNECTED whose BRIDGED never arrives does not refresh the timeout; failover happens exactly at %i ms and the held event never connects the timed-out or the next attempt",
    async (priority, timeoutMs) => {
      const { coordinator, clock, telephony, audit, store } = setup();
      const j = await coordinator.requestTransfer(priority === "SAFETY" ? safetyHandoff() : handoff());
      const first = current(j).transferId;
      expect((await coordinator.applyEvent({ transferId: first, event: "RECEIVER_ACCEPTED", eventId: "evt-ra-1", source: "telephony.local_fixture" })).decision.kind).toBe("applied");
      clock.advanceMs(10_000);
      const held = await coordinator.applyEvent({ transferId: first, event: "CALLER_CONFIRMED_CONNECTED", eventId: "evt-ccc-1", source: "telephony.local_fixture" });
      expect(held.decision).toEqual({ kind: "deferred", reasonCode: "TRANSFER_EVENT_AWAITING_PREDECESSOR" });

      // One millisecond before the timeout measured from the last APPLIED progress (not from the held event).
      clock.advanceMs(timeoutMs - 10_000 - 1);
      expect(await coordinator.sweepTimeouts()).toBe(0);
      let now = (await store.get(j.handoffId)) as TransferJourney;
      expect(current(now)).toMatchObject({ transferId: first, state: "RECEIVER_ACCEPTED" });
      expect(now.connectedAt).toBeNull();
      expect(telephony.updates).toHaveLength(0);
      expect(telephony.dials).toHaveLength(1);

      clock.advanceMs(1);
      expect(await coordinator.sweepTimeouts()).toBe(1);
      now = (await store.get(j.handoffId)) as TransferJourney;
      expect(statesOf(attemptOf(now, first))).toEqual(["REQUESTED", "RECEIVER_ACCEPTED", "TIMED_OUT"]);
      expect(now.connectedAt).toBeNull();
      expect(now.status).toBe("ROUTING");
      expect(now.deferredEvents).toEqual([]);
      expect(now.attempts).toHaveLength(2);
      expect(now.currentTransferId).not.toBe(first);
      expect(telephony.updates.map((u) => u.templateId)).toEqual([priority === "SAFETY" ? "transfer.update.safety" : "transfer.update.standard"]);
      expect(telephony.dials).toHaveLength(2);
      const deferredAudit = audit.events.filter((e) => e.action === "transfer.event_deferred");
      const discardedAudit = audit.events.filter((e) => e.action === "transfer.deferred_events_discarded");
      expect(discardedAudit.map((e) => [e.outcome, e.reasonCode])).toEqual([["INVALIDATED", "TRANSFER_ATTEMPT_CLOSED"]]);
      expect(eventRefs(discardedAudit[0]?.evidencePointers ?? [])).toEqual(eventRefs(deferredAudit[0]?.evidencePointers ?? []));
      expect(eventRefs(deferredAudit[0]?.evidencePointers ?? [])).toHaveLength(1);

      // The late predecessor (and a redelivery of the held event) on the timed-out attempt are stale.
      expect((await coordinator.applyEvent({ transferId: first, event: "BRIDGED", eventId: "evt-b-1", source: "telephony.local_fixture" })).decision).toEqual({
        kind: "rejected",
        reasonCode: "TRANSFER_ATTEMPT_SUPERSEDED",
      });
      expect((await coordinator.applyEvent({ transferId: first, event: "CALLER_CONFIRMED_CONNECTED", eventId: "evt-ccc-1", source: "telephony.local_fixture" })).decision).toEqual({
        kind: "rejected",
        reasonCode: "TRANSFER_ATTEMPT_SUPERSEDED",
      });
      // The next attempt progresses on its own events only: bridged, but nobody counts as connected.
      const second = now.currentTransferId as string;
      for (const event of ["RECEIVER_ACCEPTED", "BRIDGED"] as const) {
        expect((await coordinator.applyEvent({ transferId: second, event, source: "telephony.local_fixture" })).decision.kind).toBe("applied");
      }
      now = (await store.get(j.handoffId)) as TransferJourney;
      expect(statesOf(current(now))).toEqual(["REQUESTED", "RECEIVER_ACCEPTED", "BRIDGED"]);
      expect(now.connectedAt).toBeNull();
      expect(journeyOutcome(now)).toBe("OUTCOME_UNKNOWN");
    },
  );

  it("[ACT-02][SAFE-04] redelivering a held event (same or a new event id) keeps one entry; held events are bounded per attempt and drain in progression order", async () => {
    const { coordinator, audit, store } = setup();
    const j = await coordinator.requestTransfer(handoff());
    const id = current(j).transferId;
    const send = (event: TransferEventName, eventId: string) => coordinator.applyEvent({ transferId: id, event, eventId, source: "telephony.local_fixture" });
    for (let i = 0; i < 5; i++) expect((await send("BRIDGED", "evt-b")).decision.kind).toBe("deferred");
    expect((await send("BRIDGED", "evt-b-copy")).decision.kind).toBe("deferred");
    expect((await send("COMPLETE", "evt-x")).decision.kind).toBe("deferred");
    expect((await send("CALLER_CONFIRMED_CONNECTED", "evt-c")).decision.kind).toBe("deferred");
    let now = (await store.get(j.handoffId)) as TransferJourney;
    expect(now.deferredEvents?.map((d) => [d.event, d.eventId])).toEqual([
      ["BRIDGED", "evt-b"],
      ["COMPLETE", "evt-x"],
      ["CALLER_CONFIRMED_CONNECTED", "evt-c"],
    ]);
    expect(audit.events.filter((e) => e.action === "transfer.event_deferred")).toHaveLength(3);
    expect(statesOf(current(now))).toEqual(["REQUESTED"]);
    expect(now.appliedEventIds).toEqual([]);

    // The predecessor arrives: the held events apply in progression order, each remembered as applied.
    expect((await send("RECEIVER_ACCEPTED", "evt-ra")).decision).toEqual({ kind: "applied", next: "RECEIVER_ACCEPTED" });
    now = (await store.get(j.handoffId)) as TransferJourney;
    expect(statesOf(current(now))).toEqual(["REQUESTED", "RECEIVER_ACCEPTED", "BRIDGED", "CALLER_CONFIRMED_CONNECTED", "COMPLETED"]);
    expect(now.status).toBe("COMPLETED");
    expect(now.deferredEvents).toEqual([]);
    expect(now.appliedEventIds).toEqual(["evt-ra", "evt-b", "evt-c", "evt-x"]);
    for (const [event, eventId] of [
      ["BRIDGED", "evt-b"],
      ["CALLER_CONFIRMED_CONNECTED", "evt-c"],
      ["COMPLETE", "evt-x"],
    ] as const) {
      expect((await send(event, eventId)).decision).toEqual({ kind: "duplicate" });
    }

    // Bound: a stored journey that already holds three events for the attempt holds no fourth.
    const k = await coordinator.requestTransfer(handoff({ callId: CALLS.concurrent.callId }));
    const kid = current(k).transferId;
    const stored = (await store.get(k.handoffId)) as TransferJourney;
    const entry = (event: "BRIDGED" | "COMPLETE", eventId: string) => ({ transferId: kid, event, eventId, source: "telephony.local_fixture", receivedAt: START });
    await store.put({ ...stored, deferredEvents: [entry("BRIDGED", "evt-k1"), entry("BRIDGED", "evt-k2"), entry("COMPLETE", "evt-k3")], version: stored.version + 1 }, stored.version);
    const full = await coordinator.applyEvent({ transferId: kid, event: "CALLER_CONFIRMED_CONNECTED", eventId: "evt-k4", source: "telephony.local_fixture" });
    expect(full.decision).toEqual({ kind: "rejected", reasonCode: "TRANSFER_DEFERRED_EVENTS_FULL" });
    expect((await store.get(k.handoffId))?.deferredEvents).toHaveLength(3);
  });

  it("[ACT-02][SAFE-04] an event id names one vendor event: a different event under an id already held is a redelivery, never a second held event", async () => {
    const { coordinator, store } = setup();
    const j = await coordinator.requestTransfer(handoff());
    const id = current(j).transferId;
    const send = (event: TransferEventName, eventId: string) => coordinator.applyEvent({ transferId: id, event, eventId, source: "telephony.local_fixture" });
    expect((await send("CALLER_CONFIRMED_CONNECTED", "evt-1")).decision.kind).toBe("deferred");
    expect((await send("COMPLETE", "evt-1")).decision).toEqual({ kind: "deferred", reasonCode: "TRANSFER_EVENT_AWAITING_PREDECESSOR" });
    expect((await store.get(j.handoffId))?.deferredEvents?.map((d) => [d.event, d.eventId])).toEqual([["CALLER_CONFIRMED_CONNECTED", "evt-1"]]);

    await send("RECEIVER_ACCEPTED", "evt-ra");
    await send("BRIDGED", "evt-b");
    const now = (await store.get(j.handoffId)) as TransferJourney;
    expect(now.status).toBe("CONNECTED");
    expect(statesOf(current(now))).toEqual(["REQUESTED", "RECEIVER_ACCEPTED", "BRIDGED", "CALLER_CONFIRMED_CONNECTED"]);
    expect(now.deferredEvents).toEqual([]);
    // Once applied, the id is a duplicate whatever event it is sent with, as for any applied event.
    expect((await send("COMPLETE", "evt-1")).decision).toEqual({ kind: "duplicate" });
  });

  it("[SAFE-04][SPEC-10.transfer] held entries of another attempt (left in a stored journey) never drain onto the current attempt", async () => {
    const { coordinator, store } = setup();
    const j = await coordinator.requestTransfer(handoff());
    const id = current(j).transferId;
    const stored = (await store.get(j.handoffId)) as TransferJourney;
    const other = newId("xfr");
    const orphan = (event: "BRIDGED" | "CALLER_CONFIRMED_CONNECTED", eventId: string) => ({ transferId: other, event, eventId, source: "telephony.local_fixture", receivedAt: START });
    await store.put({ ...stored, deferredEvents: [orphan("BRIDGED", "evt-o-b"), orphan("CALLER_CONFIRMED_CONNECTED", "evt-o-c")], version: stored.version + 1 }, stored.version);

    const accepted = await coordinator.applyEvent({ transferId: id, event: "RECEIVER_ACCEPTED", eventId: "evt-ra", source: "telephony.local_fixture" });
    expect(statesOf(current(accepted.journey))).toEqual(["REQUESTED", "RECEIVER_ACCEPTED"]);
    expect(accepted.journey.connectedAt).toBeNull();
    expect(accepted.journey.appliedEventIds).toEqual(["evt-ra"]);
    // The current attempt progresses on its own events only: bridged, and nobody counts as connected.
    const bridged = await coordinator.applyEvent({ transferId: id, event: "BRIDGED", eventId: "evt-b", source: "webhook.local_fixture" });
    expect(current(bridged.journey).history.map((h) => [h.state, h.source])).toEqual([
      ["REQUESTED", "coordinator"],
      ["RECEIVER_ACCEPTED", "telephony.local_fixture"],
      ["BRIDGED", "webhook.local_fixture"],
    ]);
    expect(bridged.journey.status).toBe("ROUTING");
    expect(bridged.journey.connectedAt).toBeNull();
    expect(bridged.journey.appliedEventIds).not.toContain("evt-o-b");
    expect(bridged.journey.appliedEventIds).not.toContain("evt-o-c");
  });

  it("[SAFE-04][OPS-01] a drained event keeps its original vendor source in history, and its application is its own audit entry referencing the same event as the deferral", async () => {
    const { coordinator, audit } = setup();
    const j = await coordinator.requestTransfer(handoff());
    const id = current(j).transferId;
    await coordinator.applyEvent({ transferId: id, event: "RECEIVER_ACCEPTED", eventId: "evt-ra", source: "telephony.local_fixture" });
    await coordinator.applyEvent({ transferId: id, event: "CALLER_CONFIRMED_CONNECTED", eventId: "evt-ccc", source: "webhook.local_fixture" });
    const r = await coordinator.applyEvent({ transferId: id, event: "BRIDGED", eventId: "evt-b", source: "telephony.local_fixture" });
    expect(current(r.journey).history.map((h) => [h.state, h.source])).toEqual([
      ["REQUESTED", "coordinator"],
      ["RECEIVER_ACCEPTED", "telephony.local_fixture"],
      ["BRIDGED", "telephony.local_fixture"],
      ["CALLER_CONFIRMED_CONNECTED", "webhook.local_fixture"],
    ]);
    expect(JSON.stringify(r.journey)).not.toContain("coordinator.deferred");
    const deferred = audit.events.filter((e) => e.action === "transfer.event_deferred");
    expect(deferred).toHaveLength(1);
    const ref = eventRefs(deferred[0]?.evidencePointers ?? []);
    expect(ref).toHaveLength(1);
    const appliedWithRef = audit.events.filter((e) => e.action === "transfer.state_changed" && eventRefs(e.evidencePointers).join() === ref.join());
    expect(appliedWithRef.map((e) => e.outcome)).toEqual(["SUCCEEDED"]);
    expect(audit.events.indexOf(appliedWithRef[0] as never)).toBeGreaterThan(audit.events.indexOf(deferred[0] as never));
    // The vendor event id itself is never written to audit (DATA-01).
    expect(JSON.stringify(audit.events)).not.toContain("evt-ccc");
  });

  it("[SAFE-03][SAFE-HANDOFF-02][SAFE-04] superseded STANDARD journeys never hold early events; events held before the supersede are discarded and never connect it; the safety journey wins", async () => {
    const { coordinator, telephony, audit, store } = setup();
    const standard = await coordinator.requestTransfer(handoff());
    const sid = current(standard).transferId;
    await coordinator.applyEvent({ transferId: sid, event: "RECEIVER_ACCEPTED", source: "telephony.local_fixture" });
    expect((await coordinator.applyEvent({ transferId: sid, event: "CALLER_CONFIRMED_CONNECTED", eventId: "evt-std-ccc", source: "telephony.local_fixture" })).decision.kind).toBe("deferred");

    const safety = await coordinator.requestTransfer(safetyHandoff());
    let stopped = (await store.get(standard.handoffId)) as TransferJourney;
    expect(stopped.status).toBe("SUPERSEDED");
    expect(stopped.deferredEvents).toEqual([]);
    expect(audit.events.filter((e) => e.action === "transfer.deferred_events_discarded" && e.correlationId === standard.handoffId).map((e) => e.reasonCode)).toEqual(["SUPERSEDED_BY_SAFETY_ROUTE"]);

    // Its predecessor now arrives: rejected, the held event is gone, nobody counts as connected on it.
    for (const event of ["BRIDGED", "COMPLETE", "CALLER_CONFIRMED_CONNECTED"] as const) {
      expect((await coordinator.applyEvent({ transferId: sid, event, source: "telephony.local_fixture" })).decision).toEqual({ kind: "rejected", reasonCode: "TRANSFER_JOURNEY_SUPERSEDED" });
    }
    stopped = (await store.get(standard.handoffId)) as TransferJourney;
    expect(stopped.deferredEvents).toEqual([]);
    expect(stopped.connectedAt).toBeNull();
    expect(statesOf(current(stopped))).toEqual(["REQUESTED", "RECEIVER_ACCEPTED"]);
    expect(audit.events.filter((e) => e.action === "transfer.event_deferred" && e.correlationId === standard.handoffId)).toHaveLength(1);

    // The safety journey still connects, with its own out-of-order events.
    const tid = current(safety).transferId;
    await coordinator.applyEvent({ transferId: tid, event: "RECEIVER_ACCEPTED", source: "telephony.local_fixture" });
    expect((await coordinator.applyEvent({ transferId: tid, event: "CALLER_CONFIRMED_CONNECTED", source: "telephony.local_fixture" })).decision.kind).toBe("deferred");
    const connected = await coordinator.applyEvent({ transferId: tid, event: "BRIDGED", source: "telephony.local_fixture" });
    expect(connected.journey.status).toBe("CONNECTED");
    expect(telephony.dials.map((d) => d.priority)).toEqual(["STANDARD", "SAFETY"]);
    expect(telephony.updates).toHaveLength(0);
  });

  it("[SAFE-03][SAFE-HANDOFF-02][SAFE-04] a safety route that starts in the predecessor's write window stops the drain even when its supersede write fails: the held event never connects the STANDARD journey, which ends SUPERSEDED with no STANDARD prompt or dial", async () => {
    const store = new SupersedeOutageStore();
    const { coordinator, clock, telephony, audit } = setup(store);
    const standard = await coordinator.requestTransfer(handoff());
    const sid = current(standard).transferId;
    await coordinator.applyEvent({ transferId: sid, event: "RECEIVER_ACCEPTED", eventId: "evt-std-ra", source: "telephony.local_fixture" });
    expect((await coordinator.applyEvent({ transferId: sid, event: "CALLER_CONFIRMED_CONNECTED", eventId: "evt-std-ccc", source: "telephony.local_fixture" })).decision.kind).toBe("deferred");

    // BRIDGED passes the event's own safety check; right after its write lands (before the drain) the
    // call's safety route starts while SUPERSEDED writes fail, so the STANDARD journey is still ROUTING.
    const started: { safety: TransferJourney | null } = { safety: null };
    store.afterWrite = async (x) => {
      if (started.safety === null && x.handoffId === standard.handoffId && current(x).state === "BRIDGED") {
        store.failSupersededWrites = true;
        started.safety = await coordinator.requestTransfer(safetyHandoff());
      }
    };
    const bridged = await coordinator.applyEvent({ transferId: sid, event: "BRIDGED", eventId: "evt-std-b", source: "telephony.local_fixture" });
    store.afterWrite = null;
    expect(bridged.decision).toEqual({ kind: "applied", next: "BRIDGED" });
    const safety = started.safety;
    if (safety === null) throw new Error("the safety route did not start");
    let std = (await store.get(standard.handoffId)) as TransferJourney;
    // SAFE-03 / SAFE-04: the held CALLER_CONFIRMED_CONNECTED was not applied; it waits for the supersede.
    expect(std.status).toBe("ROUTING");
    expect(std.connectedAt).toBeNull();
    expect(statesOf(current(std))).toEqual(["REQUESTED", "RECEIVER_ACCEPTED", "BRIDGED"]);
    expect(std.appliedEventIds).not.toContain("evt-std-ccc");
    expect(std.deferredEvents?.map((d) => d.eventId)).toEqual(["evt-std-ccc"]);

    // The safety leg connects while SUPERSEDED writes still fail (it then leaves the sweep's work list);
    // the store recovers and the sweep supersedes the STANDARD journey, discarding the held event.
    const tid = current(safety).transferId;
    for (const event of ["RECEIVER_ACCEPTED", "BRIDGED", "CALLER_CONFIRMED_CONNECTED"] as const) {
      expect((await coordinator.applyEvent({ transferId: tid, event, source: "telephony.local_fixture" })).decision.kind).toBe("applied");
    }
    expect((await store.get(safety.handoffId))?.status).toBe("CONNECTED");
    store.failSupersededWrites = false;
    for (let i = 0; i < 3; i++) {
      clock.advanceMs(config.attemptTimeoutMs.STANDARD + 1_000);
      await coordinator.sweepTimeouts();
    }
    std = (await store.get(standard.handoffId)) as TransferJourney;
    expect(std.status).toBe("SUPERSEDED");
    expect(std.deferredEvents).toEqual([]);
    expect(audit.events.filter((e) => e.action === "transfer.deferred_events_discarded" && e.correlationId === standard.handoffId).map((e) => e.reasonCode)).toEqual([
      "SUPERSEDED_BY_SAFETY_ROUTE",
    ]);

    // The safety call completes; a late bridge drop on the STANDARD leg is recorded, never failed over.
    await coordinator.applyEvent({ transferId: tid, event: "COMPLETE", source: "telephony.local_fixture" });
    const late = await coordinator.applyEvent({ transferId: sid, event: "BRIDGE_DROPPED", eventId: "evt-std-drop", source: "telephony.local_fixture" });
    expect(late.decision).toEqual({ kind: "rejected", reasonCode: "TRANSFER_JOURNEY_SUPERSEDED" });
    for (let i = 0; i < 2; i++) {
      clock.advanceMs(config.attemptTimeoutMs.STANDARD + 1_000);
      await coordinator.sweepTimeouts();
    }
    std = (await store.get(standard.handoffId)) as TransferJourney;
    expect(std.status).toBe("SUPERSEDED");
    expect(journeyOutcome(std)).toBe("OUTCOME_UNKNOWN");
    const stdWrites = store.written.filter((x) => x.handoffId === standard.handoffId);
    expect(stdWrites.map((x) => x.status)).not.toContain("CONNECTED");
    expect(stdWrites.every((x) => x.connectedAt === null)).toBe(true);
    expect(telephony.dials.map((d) => `${d.priority}:${d.destinationId}`)).toEqual(["STANDARD:dst_support_general", "SAFETY:dst_safety_priority"]);
    expect(telephony.updates).toHaveLength(0);
  });

  it("[SAFE-04][SPEC-10.transfer] an early event for a stale attempt is rejected as superseded and never held", async () => {
    const { coordinator, store } = setup();
    const j = await coordinator.requestTransfer(handoff());
    const first = current(j).transferId;
    await coordinator.applyEvent({ transferId: first, event: "RECEIVER_UNAVAILABLE", source: "telephony.local_fixture" });
    for (const event of ["BRIDGED", "CALLER_CONFIRMED_CONNECTED", "COMPLETE"] as const) {
      expect((await coordinator.applyEvent({ transferId: first, event, source: "telephony.local_fixture" })).decision).toEqual({ kind: "rejected", reasonCode: "TRANSFER_ATTEMPT_SUPERSEDED" });
    }
    expect((await store.get(j.handoffId))?.deferredEvents).toEqual([]);
  });

  it("[SAFE-03][SAFE-04][SPEC-10.transfer] held events are discarded when their attempt closes (caller disconnect, bridge drop) or is replaced; none ever connects a closed or later attempt", async () => {
    const { coordinator, audit, store } = setup();
    // Caller disconnect while CALLER_CONFIRMED_CONNECTED is held.
    const a = await coordinator.requestTransfer(handoff());
    const aid = current(a).transferId;
    await coordinator.applyEvent({ transferId: aid, event: "RECEIVER_ACCEPTED", source: "telephony.local_fixture" });
    await coordinator.applyEvent({ transferId: aid, event: "CALLER_CONFIRMED_CONNECTED", eventId: "evt-a-ccc", source: "telephony.local_fixture" });
    const left = await coordinator.applyEvent({ transferId: aid, event: "CALLER_DISCONNECTED", source: "telephony.local_fixture" });
    expect(left.journey).toMatchObject({ status: "CALLER_DISCONNECTED", connectedAt: null, deferredEvents: [] });
    expect((await coordinator.applyEvent({ transferId: aid, event: "BRIDGED", source: "telephony.local_fixture" })).decision).toEqual({ kind: "rejected", reasonCode: "TRANSFER_ATTEMPT_CLOSED" });
    expect(journeyOutcome((await store.get(a.handoffId)) as TransferJourney)).toBe("CALLER_DISCONNECTED");

    // Bridge drop before BRIDGED was seen, while COMPLETE and CALLER_CONFIRMED_CONNECTED are held (SAFETY).
    const b = await coordinator.requestTransfer(safetyHandoff({ callId: CALLS.concurrent.callId }));
    const bid = current(b).transferId;
    await coordinator.applyEvent({ transferId: bid, event: "RECEIVER_ACCEPTED", source: "telephony.local_fixture" });
    await coordinator.applyEvent({ transferId: bid, event: "COMPLETE", source: "telephony.local_fixture" });
    await coordinator.applyEvent({ transferId: bid, event: "CALLER_CONFIRMED_CONNECTED", source: "telephony.local_fixture" });
    const dropped = await coordinator.applyEvent({ transferId: bid, event: "BRIDGE_DROPPED", source: "telephony.local_fixture" });
    expect(statesOf(attemptOf(dropped.journey, bid))).toEqual(["REQUESTED", "RECEIVER_ACCEPTED", "BRIDGE_DROPPED"]);
    expect(dropped.journey).toMatchObject({ status: "ROUTING", connectedAt: null, deferredEvents: [] });
    expect(current(dropped.journey).destinationId).toBe("dst_safety_backup");
    expect(statesOf(current(dropped.journey))).toEqual(["REQUESTED"]);

    // Replaced: an entry left behind for an earlier attempt (e.g. written before a lost write) goes with the next dial.
    const c = await coordinator.requestTransfer(handoff({ callId: CALLS.concurrent.callId, destinationId: "dst_billing_specialist" }));
    const stored = (await store.get(c.handoffId)) as TransferJourney;
    const orphan = { transferId: newId("xfr"), event: "CALLER_CONFIRMED_CONNECTED" as const, eventId: "evt-orphan", source: "telephony.local_fixture", receivedAt: START };
    await store.put({ ...stored, deferredEvents: [orphan], version: stored.version + 1 }, stored.version);
    const failedOver = await coordinator.applyEvent({ transferId: current(stored).transferId, event: "RECEIVER_UNAVAILABLE", source: "telephony.local_fixture" });
    expect(failedOver.journey.deferredEvents).toEqual([]);
    expect(failedOver.journey.connectedAt).toBeNull();
    const reasons = audit.events.filter((e) => e.action === "transfer.deferred_events_discarded").map((e) => [e.correlationId, e.reasonCode]);
    expect(reasons).toEqual([
      [a.handoffId, "TRANSFER_ATTEMPT_CLOSED"],
      [b.handoffId, "TRANSFER_ATTEMPT_CLOSED"],
      [c.handoffId, "TRANSFER_ATTEMPT_REPLACED"],
    ]);
  });

  it("[SAFE-04] a journey stored before ADR-0017 (no deferredEvents field) holds and drains early events", async () => {
    const { coordinator, store } = setup();
    const j = await coordinator.requestTransfer(handoff());
    const stored = (await store.get(j.handoffId)) as TransferJourney;
    const legacy: TransferJourney = { ...stored, version: stored.version + 1 };
    delete legacy.deferredEvents;
    await store.put(legacy, stored.version);
    const id = current(stored).transferId;
    await coordinator.applyEvent({ transferId: id, event: "RECEIVER_ACCEPTED", source: "telephony.local_fixture" });
    expect((await coordinator.applyEvent({ transferId: id, event: "CALLER_CONFIRMED_CONNECTED", source: "telephony.local_fixture" })).decision.kind).toBe("deferred");
    const r = await coordinator.applyEvent({ transferId: id, event: "BRIDGED", source: "telephony.local_fixture" });
    expect(journeyOutcome(r.journey)).toBe("TRANSFERRED");
  });

  it("[SAFE-04][OPS-02] a drain whose write loses a race keeps the held event in the store; the sweep applies it before any timeout", async () => {
    const { coordinator, clock, telephony, store } = setup();
    const j = await coordinator.requestTransfer(handoff());
    const id = current(j).transferId;
    await coordinator.applyEvent({ transferId: id, event: "QUEUED", eventId: "evt-q", source: "telephony.local_fixture" });
    expect((await coordinator.applyEvent({ transferId: id, event: "BRIDGED", eventId: "evt-b", source: "telephony.local_fixture" })).decision.kind).toBe("deferred");
    // A concurrent writer wins exactly the drain's write (the RECEIVER_ACCEPTED write itself lands).
    store.conflictWhen = (x) => x.attempts.some((a) => a.state === "BRIDGED");
    await expect(coordinator.applyEvent({ transferId: id, event: "RECEIVER_ACCEPTED", eventId: "evt-ra", source: "telephony.local_fixture" })).rejects.toBeInstanceOf(ConflictError);
    let now = (await store.get(j.handoffId)) as TransferJourney;
    expect(current(now).state).toBe("RECEIVER_ACCEPTED");
    expect(now.deferredEvents?.map((d) => d.event)).toEqual(["BRIDGED"]);
    // A redelivery of the predecessor is a duplicate; the sweep drains the held event.
    expect((await coordinator.applyEvent({ transferId: id, event: "RECEIVER_ACCEPTED", eventId: "evt-ra", source: "telephony.local_fixture" })).decision).toEqual({ kind: "duplicate" });
    clock.advanceMs(1_000);
    expect(await coordinator.sweepTimeouts()).toBe(1);
    now = (await store.get(j.handoffId)) as TransferJourney;
    expect(current(now).history.map((h) => [h.state, h.source])).toEqual([
      ["REQUESTED", "coordinator"],
      ["QUEUED", "telephony.local_fixture"],
      ["RECEIVER_ACCEPTED", "telephony.local_fixture"],
      ["BRIDGED", "telephony.local_fixture"],
    ]);
    expect(now.deferredEvents).toEqual([]);
    expect(now.appliedEventIds).toContain("evt-b");
    expect(telephony.dials).toHaveLength(1);
    expect(telephony.updates).toHaveLength(0);
  });

  const SCRIPTS: Record<string, readonly TransferEventName[]> = {
    CONNECTED: ["QUEUED", "RECEIVER_ACCEPTED", "BRIDGED", "CALLER_CONFIRMED_CONNECTED"],
    CONNECTED_COMPLETE: ["QUEUED", "RECEIVER_ACCEPTED", "BRIDGED", "CALLER_CONFIRMED_CONNECTED", "COMPLETE"],
    BRIDGE_DROPPED: ["QUEUED", "RECEIVER_ACCEPTED", "BRIDGED", "BRIDGE_DROPPED"],
  };

  it("[SAFE-04][ACT-02] property: under any permutation and duplication of a script's events the caller counts as connected only after RECEIVER_ACCEPTED and BRIDGED, and a CONNECTED script ends connected on one attempt", async () => {
    const delivery = fc.constantFrom(...Object.keys(SCRIPTS)).chain((name) => {
      const base = (SCRIPTS[name] ?? []).map((event, i) => ({ event, eventId: `evt-${i + 1}` }));
      return fc.array(fc.constantFrom(...base), { maxLength: 4 }).chain((dups) => {
        const all = [...base, ...dups];
        return fc.shuffledSubarray(all, { minLength: all.length, maxLength: all.length }).map((order) => ({ name, order }));
      });
    });
    await fc.assert(
      fc.asyncProperty(delivery, fc.boolean(), async ({ name, order }, safety) => {
        const { coordinator, telephony, store } = setup();
        const j = await coordinator.requestTransfer(safety ? safetyHandoff() : handoff());
        const transferId = current(j).transferId;
        for (const e of order) {
          await coordinator.applyEvent({ transferId, event: e.event, eventId: e.eventId, source: "telephony.local_fixture" });
          const now = (await store.get(j.handoffId)) as TransferJourney;
          for (const a of now.attempts) {
            const s = statesOf(a);
            if (s.includes("CALLER_CONFIRMED_CONNECTED")) {
              expect(s.indexOf("RECEIVER_ACCEPTED")).toBeGreaterThan(0);
              expect(s.indexOf("BRIDGED")).toBeGreaterThan(s.indexOf("RECEIVER_ACCEPTED"));
              expect(s.indexOf("CALLER_CONFIRMED_CONNECTED")).toBeGreaterThan(s.indexOf("BRIDGED"));
            }
          }
          if (now.connectedAt !== null) {
            expect(statesOf(current(now))).toContain("RECEIVER_ACCEPTED");
            expect(statesOf(current(now))).toContain("BRIDGED");
            expect(statesOf(current(now))).toContain("CALLER_CONFIRMED_CONNECTED");
          }
          expect((now.deferredEvents ?? []).length).toBeLessThanOrEqual(3);
        }
        const end = (await store.get(j.handoffId)) as TransferJourney;
        if (name !== "BRIDGE_DROPPED") {
          expect(end.status).toBe(name === "CONNECTED" ? "CONNECTED" : "COMPLETED");
          expect(journeyOutcome(end)).toBe("TRANSFERRED");
          expect(end.attempts).toHaveLength(1);
          expect(end.deferredEvents).toEqual([]);
          expect(telephony.dials).toHaveLength(1);
          expect(telephony.updates).toHaveLength(0);
        }
      }),
      { numRuns: 300 },
    );
  });
});

describe("out-of-order-only delivery through the LocalTelephonyDeliveryLoop (LOCAL FIXTURE)", () => {
  function fixtureSetup() {
    const clock = new FakeClock(START);
    const telephony = new TelephonyFixture({ destinations: DESTINATIONS.map((d) => ({ destinationId: d.destinationId, vendorQueueRef: d.vendorQueueRef, purpose: d.purpose })), clock });
    const store = new MemoryTransferStore();
    const audit = new MemoryAuditWriterFixture();
    const coordinator = new TransferCoordinator({ store, telephony, destinations: destinations(), clock, audit, config });
    const loop = new LocalTelephonyDeliveryLoop(telephony, store, coordinator);
    return { clock, telephony, store, coordinator, loop };
  }

  it.each([
    ["STANDARD", false],
    ["STANDARD", true],
    ["SAFETY", false],
  ] as const)(
    "[SAFE-04][SPEC-14.faults][TB-07] %s (complete=%s): events swapped pairwise and never duplicated or redelivered connect in one delivery run: one attempt, one dial, no update prompt",
    async (priority, complete) => {
      const { clock, telephony, store, coordinator, loop } = fixtureSetup();
      telephony.scriptNextTransfer({ outcome: "CONNECTED", complete }, { outOfOrder: true });
      const j = await coordinator.requestTransfer(priority === "SAFETY" ? safetyHandoff() : handoff());
      const report = await loop.runOnce();
      expect(report.ok).toBe(true);
      // Delivered as REQUESTED, RECEIVER_ACCEPTED, QUEUED, CALLER_CONFIRMED_CONNECTED, BRIDGED(, COMPLETED): no copy arrives later.
      expect(telephony.delivered.map((e) => e.delivery.duplicate || e.delivery.redelivery)).not.toContain(true);
      const now = (await store.get(j.handoffId)) as TransferJourney;
      expect(now.status).toBe(complete ? "COMPLETED" : "CONNECTED");
      expect(journeyOutcome(now)).toBe("TRANSFERRED");
      expect(now.attempts).toHaveLength(1);
      expect(statesOf(current(now))).toEqual(["REQUESTED", "RECEIVER_ACCEPTED", "BRIDGED", "CALLER_CONFIRMED_CONNECTED", ...(complete ? (["COMPLETED"] as const) : [])]);
      expect(current(now).history.slice(1).every((h) => h.source === "telephony.local_fixture")).toBe(true);
      expect(now.deferredEvents).toEqual([]);
      expect(now.updatesPlayed).toBe(0);
      expect(telephony.dials).toHaveLength(1);
      expect(telephony.updates).toHaveLength(0);
      // Nothing is left to time out: later sweeps neither fail over nor dial.
      clock.advanceMs(config.attemptTimeoutMs[priority] * 3);
      expect(await coordinator.sweepTimeouts()).toBe(0);
      expect(telephony.dials).toHaveLength(1);
      loop.close();
    },
  );
});
