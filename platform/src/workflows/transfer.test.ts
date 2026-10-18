import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { DestinationConfig } from "../config/ports.js";
import { CALLS, DESTINATIONS, TENANT_ID } from "../fixtures/synthetic-world.js";
import { createMemoryLogger } from "../observability/logger.js";
import type { HandoffPackage, TransferRecord, TransferState } from "../protocol/index.js";
import { FakeClock } from "../shared/clock.js";
import { AccessDeniedError, ConfigurationRejectedError, ConflictError, ValidationError } from "../shared/errors.js";
import { newId } from "../shared/ids.js";
import {
  journeyOutcome,
  looksLikeDialTarget,
  MemoryTransferStore,
  TERMINAL_TRANSFER_STATES,
  TransferCoordinator,
  TransferEventName,
  transferTransition,
  validateDestinations,
  type TransferCoordinatorConfig,
  type TransferJourney,
} from "./transfer.js";
import { MemoryAuditWriterFixture, TelephonyControlFixture } from "./workflow-test-fixtures.js";

const START = "2026-10-17T15:00:00.000Z";

/** SYNTHETIC allowlist from the canonical synthetic world (vendor queue refs are placeholders). */
const destinations = (): DestinationConfig[] =>
  DESTINATIONS.map((d) => ({ ...d, fallbackDestinationIds: [...d.fallbackDestinationIds], languages: [...d.languages] }));

/** Test-only values; operational timeouts are set by support operations, not by this module. */
const config: TransferCoordinatorConfig = {
  environment: "local",
  updateTemplateIds: { STANDARD: "transfer.update.standard", SAFETY: "transfer.update.safety" },
  attemptTimeoutMs: { STANDARD: 60_000, SAFETY: 20_000 },
  maxStandardContinuityAttempts: 2,
};

function setup(overrides: Partial<TransferCoordinatorConfig> = {}) {
  const clock = new FakeClock(START);
  const telephony = new TelephonyControlFixture();
  const audit = new MemoryAuditWriterFixture();
  const store = new MemoryTransferStore();
  const { logger, records } = createMemoryLogger();
  const coordinator = new TransferCoordinator({ store, telephony, destinations: destinations(), clock, audit, logger, config: { ...config, ...overrides } });
  return { clock, telephony, audit, store, coordinator, logs: records };
}

function handoff(overrides: Partial<HandoffPackage> = {}): HandoffPackage {
  return {
    handoffId: newId("hof"),
    tenantId: TENANT_ID,
    callId: CALLS.primary.callId,
    sessionGeneration: 1,
    reason: "CALLER_REQUESTED_HUMAN",
    destinationId: "dst_billing_specialist",
    statedIssue: "billing_dispute",
    issueSummary: "Template-assembled synthetic summary: caller disputes a fee.",
    assurance: "A2",
    assuranceLimits: [],
    authorizedSubjectRef: newId("sub"),
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
  handoff({
    reason: "SAFETY_PRIORITY",
    destinationId: "dst_safety_priority",
    statedIssue: "safety_concern",
    safetyRoutingReason: "EXPLICIT_PHRASE",
    assurance: "A0",
    authorizedSubjectRef: null,
    ...overrides,
  });

const current = (j: TransferJourney): TransferRecord => {
  const a = j.attempts.find((x) => x.transferId === j.currentTransferId);
  if (!a) throw new Error("no current attempt");
  return a;
};

async function drive(c: TransferCoordinator, j: TransferJourney, events: TransferEventName[], ack = true): Promise<TransferJourney> {
  let journey = j;
  for (const event of events) {
    const r = await c.applyEvent({ transferId: current(journey).transferId, event, source: "talkdesk.fixture", packageAcknowledged: event === "RECEIVER_ACCEPTED" ? ack : undefined });
    expect(r.decision.kind, `${event}`).toBe("applied");
    journey = r.journey;
  }
  return journey;
}

describe("transfer state machine (pure)", () => {
  it("[SAFE-04] property: CALLER_CONFIRMED_CONNECTED and COMPLETED are reachable only via RECEIVER_ACCEPTED -> BRIDGED -> CALLER_CONFIRMED_CONNECTED", () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...TransferEventName.options), { maxLength: 40 }), (events) => {
        let rec: Pick<TransferRecord, "state" | "history" | "receiverAcknowledgedPackage"> = {
          state: "REQUESTED",
          history: [{ state: "REQUESTED", at: START, source: "test" }],
          receiverAcknowledgedPackage: false,
        };
        for (const e of events) {
          const before = rec.state;
          const d = transferTransition(rec, e);
          if (d.kind === "applied") rec = { ...rec, state: d.next, history: [...rec.history, { state: d.next, at: START, source: "test" }] };
          if (d.kind === "acknowledged") rec = { ...rec, receiverAcknowledgedPackage: true };
          if (TERMINAL_TRANSFER_STATES.has(before)) expect(rec.state).toBe(before); // terminal states absorb
          if (rec.state === "CALLER_CONFIRMED_CONNECTED" || rec.state === "COMPLETED") {
            const order = rec.history.map((h) => h.state);
            const iA = order.indexOf("RECEIVER_ACCEPTED");
            const iB = order.indexOf("BRIDGED");
            const iC = order.indexOf("CALLER_CONFIRMED_CONNECTED");
            expect(iA).toBeGreaterThan(0);
            expect(iB).toBeGreaterThan(iA);
            expect(iC).toBeGreaterThan(iB);
            if (rec.state === "COMPLETED") expect(order.indexOf("COMPLETED")).toBeGreaterThan(iC);
          }
        }
      }),
      { numRuns: 1000 },
    );
  });

  it.each<[TransferState, TransferEventName, string]>([
    ["REQUESTED", "BRIDGED", "TRANSFER_EVENT_OUT_OF_ORDER"],
    ["QUEUED", "CALLER_CONFIRMED_CONNECTED", "TRANSFER_EVENT_OUT_OF_ORDER"],
    ["RECEIVER_ACCEPTED", "COMPLETE", "TRANSFER_EVENT_OUT_OF_ORDER"],
    ["BRIDGED", "COMPLETE", "TRANSFER_EVENT_OUT_OF_ORDER"],
    ["BRIDGED", "RECEIVER_UNAVAILABLE", "TRANSFER_EVENT_NOT_APPLICABLE"],
    ["CALLER_CONFIRMED_CONNECTED", "TIMEOUT", "TRANSFER_EVENT_NOT_APPLICABLE"],
    ["TIMED_OUT", "RECEIVER_ACCEPTED", "TRANSFER_ATTEMPT_CLOSED"],
    ["QUEUED", "PACKAGE_ACKNOWLEDGED", "PACKAGE_ACK_BEFORE_ACCEPTANCE"],
  ])("[SAFE-04] from %s, event %s is rejected (%s)", (state, event, reasonCode) => {
    expect(transferTransition({ state, history: [{ state, at: START, source: "t" }], receiverAcknowledgedPackage: false }, event)).toEqual({ kind: "rejected", reasonCode });
  });

  it("[SPEC-10.transfer] duplicates and late repeats of an already reached state are ignored", () => {
    const history = ["REQUESTED", "QUEUED", "RECEIVER_ACCEPTED"].map((s) => ({ state: s as TransferState, at: START, source: "t" }));
    expect(transferTransition({ state: "RECEIVER_ACCEPTED", history, receiverAcknowledgedPackage: false }, "QUEUED")).toEqual({ kind: "duplicate" });
    expect(transferTransition({ state: "RECEIVER_ACCEPTED", history, receiverAcknowledgedPackage: false }, "RECEIVER_ACCEPTED")).toEqual({ kind: "duplicate" });
    expect(transferTransition({ state: "TIMED_OUT", history: [...history, { state: "TIMED_OUT", at: START, source: "t" }], receiverAcknowledgedPackage: false }, "QUEUED")).toEqual({
      kind: "duplicate",
    });
  });
});

describe("TransferCoordinator", () => {
  it("[SAFE-04] a successful dial command alone is not TRANSFERRED", async () => {
    const { coordinator, telephony } = setup();
    const j = await coordinator.requestTransfer(handoff());
    expect(telephony.dials).toHaveLength(1);
    expect(current(j).state).toBe("REQUESTED");
    expect(journeyOutcome(j)).toBe("OUTCOME_UNKNOWN");
    const accepted = await drive(coordinator, j, ["QUEUED", "RECEIVER_ACCEPTED", "BRIDGED"]);
    expect(current(accepted).state).toBe("BRIDGED");
    expect(journeyOutcome(accepted)).toBe("OUTCOME_UNKNOWN");
  });

  it("[SAFE-04] full happy path maps to TRANSFERRED only after the caller is confirmed connected", async () => {
    const { coordinator, telephony, audit } = setup();
    const j = await coordinator.requestTransfer(handoff());
    const connected = await drive(coordinator, j, ["QUEUED", "RECEIVER_ACCEPTED", "BRIDGED", "CALLER_CONFIRMED_CONNECTED"]);
    expect(connected.status).toBe("CONNECTED");
    expect(journeyOutcome(connected)).toBe("TRANSFERRED");
    const done = await drive(coordinator, connected, ["COMPLETE"]);
    expect(done.status).toBe("COMPLETED");
    expect(current(done).history.map((h) => h.state)).toEqual(["REQUESTED", "QUEUED", "RECEIVER_ACCEPTED", "BRIDGED", "CALLER_CONFIRMED_CONNECTED", "COMPLETED"]);
    expect(current(done).receiverAcknowledgedPackage).toBe(true);
    expect(telephony.dials).toEqual([{ callId: CALLS.primary.callId, destinationId: "dst_billing_specialist", handoffId: j.handoffId, priority: "STANDARD" }]);
    expect(telephony.updates).toHaveLength(0);
    expect(audit.events.some((e) => e.action === "transfer.state_changed" && e.outcome === "SUCCEEDED")).toBe(true);
  });

  it("[SPEC-10.transfer] receiver acknowledgment of the handoff package is recorded, and its absence is flagged at completion", async () => {
    const { coordinator, audit } = setup();
    const j = await coordinator.requestTransfer(handoff());
    const accepted = await drive(coordinator, j, ["QUEUED", "RECEIVER_ACCEPTED"], false);
    expect(current(accepted).receiverAcknowledgedPackage).toBe(false);
    const ack = await coordinator.applyEvent({ transferId: current(accepted).transferId, event: "PACKAGE_ACKNOWLEDGED", source: "talkdesk.fixture" });
    expect(ack.decision.kind).toBe("acknowledged");
    expect(current(ack.journey).receiverAcknowledgedPackage).toBe(true);

    const other = await coordinator.requestTransfer(handoff());
    const done = await drive(coordinator, other, ["RECEIVER_ACCEPTED", "BRIDGED", "CALLER_CONFIRMED_CONNECTED", "COMPLETE"], false);
    expect(done.status).toBe("COMPLETED");
    expect(audit.events.some((e) => e.correlationId === other.handoffId && e.reasonCode === "HANDOFF_PACKAGE_UNACKNOWLEDGED")).toBe(true);
  });

  it("[SPEC-10.transfer] receiver unavailable plays an approved update and invokes the next staffed route", async () => {
    const { coordinator, telephony } = setup();
    const j = await coordinator.requestTransfer(handoff());
    expect(j.routePlan).toEqual(["dst_billing_specialist", "dst_support_general", "dst_outage_continuity"]);
    const r = await coordinator.applyEvent({ transferId: current(j).transferId, event: "RECEIVER_UNAVAILABLE", source: "talkdesk.fixture" });
    expect(r.decision).toEqual({ kind: "applied", next: "RECEIVER_UNAVAILABLE" });
    expect(telephony.updates).toEqual([{ callId: CALLS.primary.callId, templateId: "transfer.update.standard" }]);
    expect(telephony.dials.map((d) => d.destinationId)).toEqual(["dst_billing_specialist", "dst_support_general"]);
    expect(current(r.journey)).toMatchObject({ destinationId: "dst_support_general", state: "REQUESTED", fallbackDestinationIds: ["dst_outage_continuity"] });
    expect(r.journey.status).toBe("ROUTING");
  });

  it("[SPEC-10.transfer] a dropped bridge plays an update and falls back; the outcome is no longer TRANSFERRED", async () => {
    const { coordinator, telephony } = setup();
    const j = await coordinator.requestTransfer(handoff({ destinationId: "dst_support_general" }));
    const connected = await drive(coordinator, j, ["RECEIVER_ACCEPTED", "BRIDGED", "CALLER_CONFIRMED_CONNECTED"]);
    expect(journeyOutcome(connected)).toBe("TRANSFERRED");
    const dropped = await coordinator.applyEvent({ transferId: current(connected).transferId, event: "BRIDGE_DROPPED", source: "talkdesk.fixture" });
    expect(journeyOutcome(dropped.journey)).toBe("OUTCOME_UNKNOWN");
    expect(telephony.updates).toHaveLength(1);
    expect(current(dropped.journey).destinationId).toBe("dst_outage_continuity");
  });

  it("[SAFE-03][SAFE-04][SAFE-HANDOFF-01] a safety bridge drop after CALLER_CONFIRMED_CONNECTED re-enters the fallback chain: ROUTING, swept, timed out and re-dialled", async () => {
    const { coordinator, clock, telephony, store } = setup();
    const j = await coordinator.requestTransfer(safetyHandoff());
    const connected = await drive(coordinator, j, ["RECEIVER_ACCEPTED", "BRIDGED", "CALLER_CONFIRMED_CONNECTED"]);
    expect(connected.status).toBe("CONNECTED");
    const dropped = (await coordinator.applyEvent({ transferId: current(connected).transferId, event: "BRIDGE_DROPPED", source: "talkdesk.fixture" })).journey;
    // Nobody is on the line: the journey is routing again with the next staffed safety route in flight.
    expect(dropped.status).toBe("ROUTING");
    expect(dropped.connectedAt).toBeNull();
    expect(journeyOutcome(dropped)).toBe("OUTCOME_UNKNOWN");
    expect(current(dropped)).toMatchObject({ destinationId: "dst_safety_backup", state: "REQUESTED" });
    expect((await store.listActive()).map((x) => x.handoffId)).toEqual([j.handoffId]);
    // The backup never answers: the sweep times it out and keeps cycling the safety routes (never abandoned).
    const dialsBefore = telephony.dials.length;
    for (let i = 0; i < 3; i++) {
      clock.advanceMs(20_000);
      expect(await coordinator.sweepTimeouts()).toBe(1);
    }
    expect(telephony.dials.slice(dialsBefore).map((d) => d.destinationId)).toEqual(["dst_outage_continuity", "dst_safety_priority", "dst_safety_backup"]);
    const after = (await coordinator.get(j.handoffId)) as TransferJourney;
    expect(after.status).toBe("ROUTING");
    // A later acceptance on the current attempt completes the transfer again.
    expect(journeyOutcome(await drive(coordinator, after, ["RECEIVER_ACCEPTED", "BRIDGED", "CALLER_CONFIRMED_CONNECTED"]))).toBe("TRANSFERRED");
  });

  it("[SAFE-03][OPS-02][SAFE-HANDOFF-01] a bridge drop while telephony control is down awaits retry and is re-dialled by the sweep after recovery", async () => {
    const { coordinator, clock, telephony } = setup();
    const j = await coordinator.requestTransfer(safetyHandoff());
    const connected = await drive(coordinator, j, ["RECEIVER_ACCEPTED", "BRIDGED", "CALLER_CONFIRMED_CONNECTED"]);
    telephony.unavailable = true;
    const dropped = (await coordinator.applyEvent({ transferId: current(connected).transferId, event: "BRIDGE_DROPPED", source: "talkdesk.fixture" })).journey;
    expect(dropped.awaitingRetry).toBe(true);
    expect(dropped.status).toBe("ROUTING");
    telephony.unavailable = false;
    const dialsBefore = telephony.dials.length;
    clock.advanceMs(1000);
    expect(await coordinator.sweepTimeouts()).toBe(1);
    expect(telephony.dials.length).toBe(dialsBefore + 1);
    const now = (await coordinator.get(j.handoffId)) as TransferJourney;
    expect(now.awaitingRetry).toBe(false);
    expect(current(now).state).toBe("REQUESTED");
  });

  it("[SPEC-10.transfer][SAFE-HANDOFF-01] a STANDARD bridge drop after connection is swept too, and a caller disconnect between attempts closes the journey", async () => {
    const { coordinator, clock, telephony } = setup();
    const j = await coordinator.requestTransfer(handoff({ destinationId: "dst_support_general" }));
    const connected = await drive(coordinator, j, ["RECEIVER_ACCEPTED", "BRIDGED", "CALLER_CONFIRMED_CONNECTED"]);
    telephony.failingDestinations.add("dst_outage_continuity");
    const dropped = (await coordinator.applyEvent({ transferId: current(connected).transferId, event: "BRIDGE_DROPPED", source: "talkdesk.fixture" })).journey;
    // The re-dial failed: the current attempt is terminal and the journey awaits a retry.
    expect(dropped.status).toBe("ROUTING");
    expect(current(dropped).state).toBe("FAILED");
    const left = await coordinator.applyEvent({ transferId: current(dropped).transferId, event: "CALLER_DISCONNECTED", source: "talkdesk.fixture" });
    expect(left.decision).toEqual({ kind: "applied", next: "CALLER_DISCONNECTED" });
    expect(left.journey.status).toBe("CALLER_DISCONNECTED");
    clock.advanceMs(120_000);
    expect(await coordinator.sweepTimeouts()).toBe(0);
  });

  it("[SAFE-03][SAFE-HANDOFF-01] a legacy CONNECTED journey whose current attempt is terminal still accepts the caller's disconnect", async () => {
    const { coordinator, store } = setup();
    const j = await coordinator.requestTransfer(safetyHandoff());
    const connected = await drive(coordinator, j, ["RECEIVER_ACCEPTED", "BRIDGED", "CALLER_CONFIRMED_CONNECTED"]);
    // State written before this fix: CONNECTED status with a failed current attempt.
    const stale = (await store.get(j.handoffId)) as TransferJourney;
    const failedAttempt = { ...current(stale), state: "FAILED" as const, history: [...current(stale).history, { state: "FAILED" as const, at: START, source: "test" }] };
    await store.put({ ...stale, status: "CONNECTED", connectedAt: null, attempts: stale.attempts.map((a) => (a.transferId === failedAttempt.transferId ? failedAttempt : a)), version: stale.version + 1 }, stale.version);
    const r = await coordinator.applyEvent({ transferId: current(connected).transferId, event: "CALLER_DISCONNECTED", source: "talkdesk.fixture" });
    expect(r.decision).toEqual({ kind: "applied", next: "CALLER_DISCONNECTED" });
    expect(r.journey.status).toBe("CALLER_DISCONNECTED");
  });

  it("[SAFE-03][SAFE-HANDOFF-02] a SAFETY journey supersedes the call's active STANDARD journey: no further timeouts, failovers, prompts or dials", async () => {
    const { coordinator, clock, telephony, audit } = setup();
    const standard = await coordinator.requestTransfer(handoff({ destinationId: "dst_support_general" }));
    const safety = await coordinator.requestTransfer(safetyHandoff());
    const stopped = (await coordinator.get(standard.handoffId)) as TransferJourney;
    expect(stopped.status).toBe("SUPERSEDED");
    expect(audit.events.some((e) => e.action === "transfer.superseded" && e.reasonCode === "SUPERSEDED_BY_SAFETY_ROUTE" && e.correlationId === standard.handoffId)).toBe(true);
    // Its late vendor events are rejected (recorded), never applied or failed over.
    const late = await coordinator.applyEvent({ transferId: current(stopped).transferId, event: "RECEIVER_UNAVAILABLE", source: "talkdesk.fixture" });
    expect(late.decision).toEqual({ kind: "rejected", reasonCode: "TRANSFER_JOURNEY_SUPERSEDED" });
    const safetyConnected = await drive(coordinator, safety, ["RECEIVER_ACCEPTED", "BRIDGED", "CALLER_CONFIRMED_CONNECTED"]);
    expect(safetyConnected.status).toBe("CONNECTED");
    const dialsAtConnect = telephony.dials.length;
    const updatesAtConnect = telephony.updates.length;
    for (let i = 0; i < 6; i++) {
      clock.advanceMs(61_000);
      await coordinator.sweepTimeouts();
    }
    expect(telephony.dials.length).toBe(dialsAtConnect);
    expect(telephony.updates.length).toBe(updatesAtConnect);
    expect(telephony.dials.map((d) => [d.destinationId, d.priority])).toEqual([
      ["dst_support_general", "STANDARD"],
      ["dst_safety_priority", "SAFETY"],
    ]);
  });

  it("[SAFE-03][SAFE-HANDOFF-02] a STANDARD request while the call's SAFETY journey is routing or connected dials nothing and returns the safety journey", async () => {
    const { coordinator, telephony, audit } = setup();
    const safety = await coordinator.requestTransfer(safetyHandoff());
    const r = await coordinator.requestTransfer(handoff({ destinationId: "dst_support_general" }));
    expect(r.handoffId).toBe(safety.handoffId);
    expect(r.priority).toBe("SAFETY");
    expect(telephony.dials.map((d) => d.priority)).toEqual(["SAFETY"]);
    expect(audit.events.some((e) => e.action === "transfer.standard_request_superseded" && e.reasonCode === "SAFETY_JOURNEY_ACTIVE")).toBe(true);
    await drive(coordinator, safety, ["RECEIVER_ACCEPTED", "BRIDGED", "CALLER_CONFIRMED_CONNECTED"]);
    const again = await coordinator.requestTransfer(handoff({ destinationId: "dst_billing_specialist" }));
    expect(again.handoffId).toBe(safety.handoffId);
    expect(telephony.dials.map((d) => d.priority)).toEqual(["SAFETY"]);
    // A different call is unaffected.
    const other = await coordinator.requestTransfer(handoff({ callId: CALLS.concurrent.callId }));
    expect(other.priority).toBe("STANDARD");
    expect(telephony.dials.at(-1)?.callId).toBe(CALLS.concurrent.callId);
    expect((await coordinator.activeSafetyJourney(TENANT_ID, CALLS.primary.callId))?.handoffId).toBe(safety.handoffId);
    expect(await coordinator.activeSafetyJourney(TENANT_ID, CALLS.concurrent.callId)).toBeNull();
  });

  it("[OPS-02] exhausted fallbacks route to OUTAGE_CONTINUITY and keep the caller connected — the call is never ended", async () => {
    const { coordinator, telephony, audit } = setup();
    let j = await coordinator.requestTransfer(handoff());
    for (let i = 0; i < 2; i++) {
      j = (await coordinator.applyEvent({ transferId: current(j).transferId, event: "RECEIVER_UNAVAILABLE", source: "talkdesk.fixture" })).journey;
    }
    expect(current(j).destinationId).toBe("dst_outage_continuity");
    expect(j.status).toBe("ROUTING");
    // Continuity is re-attempted, then the STANDARD journey holds for operations — still never hung up.
    j = (await coordinator.applyEvent({ transferId: current(j).transferId, event: "TIMEOUT", source: "talkdesk.fixture" })).journey;
    expect(current(j).destinationId).toBe("dst_outage_continuity");
    j = (await coordinator.applyEvent({ transferId: current(j).transferId, event: "TIMEOUT", source: "talkdesk.fixture" })).journey;
    expect(j.status).toBe("HOLDING_FOR_OPERATIONS");
    expect(journeyOutcome(j)).toBe("FAILED");
    expect(telephony.dials.map((d) => d.destinationId)).toEqual(["dst_billing_specialist", "dst_support_general", "dst_outage_continuity", "dst_outage_continuity"]);
    expect(telephony.updates).toHaveLength(4);
    expect("hangUp" in telephony || "endCall" in telephony).toBe(false);
    expect(audit.events.some((e) => e.action === "transfer.holding_for_operations" && e.reasonCode === "STAFFED_ROUTES_EXHAUSTED")).toBe(true);
  });

  it("[SAFE-05] a destination that is not in the trusted allowlist is rejected and never dialled", async () => {
    const { coordinator, telephony, audit } = setup();
    await expect(coordinator.requestTransfer(handoff({ destinationId: "dst_attacker_choice" }))).rejects.toMatchObject({ reasonCode: "DESTINATION_NOT_ALLOWLISTED" });
    expect(telephony.dials).toHaveLength(0);
    expect(audit.events.some((e) => e.action === "transfer.denied" && e.reasonCode === "DESTINATION_NOT_ALLOWLISTED")).toBe(true);
  });

  it.each(["+15555550101", "tel:+15555550101", "sip:agent@pbx.example.invalid", "dst_15555550101", "https://dial.example.invalid/q", "5555550101", "dst_q1_555_555_0101"])(
    "[SAFE-05] a phone-number-like or URI destination %j is rejected and never dialled",
    async (target) => {
      const { coordinator, telephony } = setup();
      await expect(coordinator.requestTransfer({ ...handoff(), destinationId: target })).rejects.toBeInstanceOf(AccessDeniedError);
      expect(telephony.dials).toHaveLength(0);
    },
  );

  it("[SAFE-05] property: a destination containing seven or more digits is never dialled", async () => {
    await fc.assert(
      fc.asyncProperty(fc.stringMatching(/^[+a-z_:]{0,6}[0-9]{7,12}$/), async (target) => {
        const { coordinator, telephony } = setup();
        await expect(coordinator.requestTransfer({ ...handoff(), destinationId: target })).rejects.toBeInstanceOf(AccessDeniedError);
        expect(telephony.dials).toHaveLength(0);
        expect(looksLikeDialTarget(target)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it("[SAFE-05][SAFE-03] a safety handoff naming an arbitrary dial target is routed to the configured safety destination instead", async () => {
    const { coordinator, telephony, audit } = setup();
    const j = await coordinator.requestTransfer({ ...safetyHandoff(), destinationId: "tel:+15555550199" });
    expect(telephony.dials).toEqual([{ callId: CALLS.primary.callId, destinationId: "dst_safety_priority", handoffId: j.handoffId, priority: "SAFETY" }]);
    expect(j.destinationCorrected).toBe(true);
    expect(JSON.stringify(j)).not.toContain("5555550199");
    expect(JSON.stringify(audit.events)).not.toContain("5555550199");
    // A safety reason pointing at a non-safety queue is also corrected to the safety route.
    const k = await coordinator.requestTransfer(safetyHandoff({ destinationId: "dst_billing_specialist" }));
    expect(current(k).destinationId).toBe("dst_safety_priority");
  });

  it("[SPEC-10.transfer] duplicate events are idempotent and out-of-order events are rejected without corrupting state", async () => {
    const { coordinator } = setup();
    const j = await coordinator.requestTransfer(handoff());
    const id = current(j).transferId;
    const q1 = await coordinator.applyEvent({ transferId: id, event: "QUEUED", eventId: "evt-0001", source: "talkdesk.fixture" });
    const q2 = await coordinator.applyEvent({ transferId: id, event: "QUEUED", eventId: "evt-0001", source: "talkdesk.fixture" });
    expect(q2.decision).toEqual({ kind: "duplicate" });
    const q3 = await coordinator.applyEvent({ transferId: id, event: "QUEUED", eventId: "evt-0002", source: "talkdesk.fixture" });
    expect(q3.decision).toEqual({ kind: "duplicate" });
    const bad = await coordinator.applyEvent({ transferId: id, event: "BRIDGED", source: "talkdesk.fixture" });
    expect(bad.decision).toEqual({ kind: "rejected", reasonCode: "TRANSFER_EVENT_OUT_OF_ORDER" });
    const after = await coordinator.get(j.handoffId);
    expect(current(after as TransferJourney).state).toBe("QUEUED");
    expect(current(after as TransferJourney).history).toHaveLength(q1.journey.attempts[0]?.history.length ?? 0);
    // The valid flow continues normally afterwards.
    const done = await drive(coordinator, after as TransferJourney, ["RECEIVER_ACCEPTED", "BRIDGED", "CALLER_CONFIRMED_CONNECTED"]);
    expect(journeyOutcome(done)).toBe("TRANSFERRED");
  });

  it("[SPEC-10.transfer] a late acceptance on a superseded attempt is rejected and does not affect the active attempt", async () => {
    const { coordinator } = setup();
    const j = await coordinator.requestTransfer(handoff());
    const first = current(j).transferId;
    const r = await coordinator.applyEvent({ transferId: first, event: "TIMEOUT", source: "coordinator.timeout" });
    const late = await coordinator.applyEvent({ transferId: first, event: "RECEIVER_ACCEPTED", source: "talkdesk.fixture" });
    expect(late.decision).toEqual({ kind: "rejected", reasonCode: "TRANSFER_ATTEMPT_SUPERSEDED" });
    const now = await coordinator.get(j.handoffId);
    expect(current(now as TransferJourney)).toMatchObject({ transferId: current(r.journey).transferId, state: "REQUESTED" });
  });

  it("[SAFE-03] a safety transfer persists across repeated timeouts: it cycles staffed routes and is never abandoned", async () => {
    const { coordinator, clock, telephony } = setup();
    const j = await coordinator.requestTransfer(safetyHandoff());
    expect(j.routePlan).toEqual(["dst_safety_priority", "dst_safety_backup", "dst_outage_continuity"]);
    for (let i = 0; i < 12; i++) {
      clock.advanceMs(20_000);
      expect(await coordinator.sweepTimeouts()).toBe(1);
      const now = (await coordinator.get(j.handoffId)) as TransferJourney;
      expect(now.status).toBe("ROUTING");
      expect(current(now).state).toBe("REQUESTED");
    }
    const final = (await coordinator.get(j.handoffId)) as TransferJourney;
    expect(final.attemptCount).toBe(13);
    expect(telephony.dials.slice(0, 7).map((d) => d.destinationId)).toEqual([
      "dst_safety_priority",
      "dst_safety_backup",
      "dst_outage_continuity",
      "dst_safety_priority",
      "dst_safety_backup",
      "dst_outage_continuity",
      "dst_safety_priority",
    ]);
    expect(telephony.dials.every((d) => d.priority === "SAFETY")).toBe(true);
    expect(telephony.updates.every((u) => u.templateId === "transfer.update.safety")).toBe(true);
    expect(telephony.updates).toHaveLength(12);
    // Still routable: a human accepting later completes the transfer.
    const done = await drive(coordinator, final, ["RECEIVER_ACCEPTED", "BRIDGED", "CALLER_CONFIRMED_CONNECTED"]);
    expect(journeyOutcome(done)).toBe("TRANSFERRED");
  });

  it("[SAFE-03] time to route initiation is measured with the Clock from the validated safety event (target <= 2000 ms)", async () => {
    const { coordinator, clock } = setup();
    const eventAt = clock.now().toISOString();
    clock.advanceMs(400);
    const j = await coordinator.requestTransfer(safetyHandoff(), { validatedSafetyEventAt: eventAt });
    expect(j.safety).toEqual({
      validatedSafetyEventAt: eventAt,
      routeInitiatedAt: "2026-10-17T15:00:00.400Z",
      timeToRouteInitiationMs: 400,
      targetMs: 2000,
      withinTarget: true,
    });
  });

  it("[SAFE-03] a missed safety routing target is recorded but never abandons the route", async () => {
    const { coordinator, clock, telephony, audit, logs } = setup();
    const eventAt = clock.now().toISOString();
    clock.advanceMs(2500);
    const j = await coordinator.requestTransfer(safetyHandoff(), { validatedSafetyEventAt: eventAt });
    expect(j.safety).toMatchObject({ timeToRouteInitiationMs: 2500, withinTarget: false });
    expect(telephony.dials).toHaveLength(1);
    expect(audit.events.some((e) => e.action === "transfer.safety_route_initiated" && e.reasonCode === "SAFETY_ROUTE_TARGET_MISSED")).toBe(true);
    expect(logs.some((l) => l.event === "transfer.safety_route_target_missed" && l.fields.durationMs === 2500)).toBe(true);
  });

  it("[SPEC-10.transfer] caller disconnect ends the journey as CALLER_DISCONNECTED with no further attempts", async () => {
    const { coordinator, clock, telephony, audit } = setup();
    const j = await coordinator.requestTransfer(safetyHandoff());
    const r = await coordinator.applyEvent({ transferId: current(j).transferId, event: "CALLER_DISCONNECTED", source: "talkdesk.fixture" });
    expect(r.journey.status).toBe("CALLER_DISCONNECTED");
    expect(journeyOutcome(r.journey)).toBe("CALLER_DISCONNECTED");
    clock.advanceMs(120_000);
    expect(await coordinator.sweepTimeouts()).toBe(0);
    expect(telephony.dials).toHaveLength(1);
    expect(audit.events.some((e) => e.reasonCode === "SAFETY_DISCONNECT_FOLLOW_UP_REQUIRED")).toBe(true);
  });

  it("[SPEC-10.transfer] a repeated request for the same handoff is idempotent and never dials twice", async () => {
    const { coordinator, telephony } = setup();
    const h = handoff();
    const a = await coordinator.requestTransfer(h);
    const b = await coordinator.requestTransfer(h);
    expect(b.handoffId).toBe(a.handoffId);
    expect(telephony.dials).toHaveLength(1);
    await expect(coordinator.requestTransfer({ ...h, callId: CALLS.concurrent.callId })).rejects.toMatchObject({ reasonCode: "HANDOFF_ID_CONFLICT" });
  });

  it("[OPS-02] an audit outage never blocks a safety transfer; the evidence gap is counted", async () => {
    const { coordinator, audit, telephony } = setup();
    audit.unavailable = true;
    const j = await coordinator.requestTransfer(safetyHandoff());
    expect(telephony.dials).toHaveLength(1);
    expect(j.auditGaps).toBeGreaterThan(0);
    const done = await drive(coordinator, j, ["RECEIVER_ACCEPTED", "BRIDGED", "CALLER_CONFIRMED_CONNECTED"]);
    expect(journeyOutcome(done)).toBe("TRANSFERRED");
  });

  it("[SPEC-10.transfer] a failed dial command plays an update and falls back to the next route", async () => {
    const { coordinator, telephony } = setup();
    telephony.failingDestinations.add("dst_billing_specialist");
    const j = await coordinator.requestTransfer(handoff());
    expect(telephony.dials.map((d) => d.destinationId)).toEqual(["dst_billing_specialist", "dst_support_general"]);
    expect(telephony.updates).toHaveLength(1);
    expect(j.attempts.map((a) => a.state)).toEqual(["FAILED", "REQUESTED"]);
    expect(current(j).destinationId).toBe("dst_support_general");
  });

  it("[SAFE-03][OPS-02] when telephony control is down a safety journey awaits retry and the sweep retries it — never abandoned", async () => {
    const { coordinator, telephony, clock } = setup();
    telephony.unavailable = true;
    const j = await coordinator.requestTransfer(safetyHandoff());
    expect(j.status).toBe("ROUTING");
    expect(j.awaitingRetry).toBe(true);
    expect(telephony.dials).toHaveLength(3); // one bounded pass over the plan, no tight loop
    telephony.unavailable = false;
    clock.advanceMs(1000);
    expect(await coordinator.sweepTimeouts()).toBe(1);
    const now = (await coordinator.get(j.handoffId)) as TransferJourney;
    expect(now.awaitingRetry).toBe(false);
    expect(current(now).state).toBe("REQUESTED");
    expect(current(now).destinationId).toBe("dst_safety_priority");
  });

  it("[SPEC-10.transfer] a failing update playback never stops the next route", async () => {
    const { coordinator, telephony } = setup();
    telephony.failUpdates = true;
    const j = await coordinator.requestTransfer(handoff());
    const r = await coordinator.applyEvent({ transferId: current(j).transferId, event: "RECEIVER_UNAVAILABLE", source: "talkdesk.fixture" });
    expect(current(r.journey).destinationId).toBe("dst_support_general");
    expect(r.journey.updatesPlayed).toBe(0);
  });

  it("[SPEC-10.transfer] the handoff package is parsed strictly (unknown fields rejected)", async () => {
    const { coordinator, telephony } = setup();
    await expect(coordinator.requestTransfer({ ...handoff(), dialNumber: "+15555550101" })).rejects.toBeInstanceOf(ValidationError);
    await expect(coordinator.requestTransfer("dst_support_general")).rejects.toBeInstanceOf(ValidationError);
    expect(telephony.dials).toHaveLength(0);
  });

  it("[SPEC-10.transfer] malformed event input is rejected and unknown transfers fail closed", async () => {
    const { coordinator } = setup();
    await expect(coordinator.applyEvent({ transferId: "xfr_short", event: "QUEUED", source: "talkdesk.fixture" })).rejects.toBeInstanceOf(ValidationError);
    await expect(coordinator.applyEvent({ transferId: newId("xfr"), event: "QUEUED", source: "talkdesk.fixture" })).rejects.toMatchObject({ reasonCode: "TRANSFER_NOT_FOUND" });
  });

  it("[OPS-04] the coordinator refuses local fixture adapters in production", () => {
    expect(
      () =>
        new TransferCoordinator({
          store: new MemoryTransferStore(),
          telephony: new TelephonyControlFixture(),
          destinations: destinations(),
          clock: new FakeClock(START),
          audit: new MemoryAuditWriterFixture(),
          config: { ...config, environment: "production" },
        }),
    ).toThrow(ConfigurationRejectedError);
  });

  it("[SAFE-05] destination configuration is validated: dial-target ids, undefined fallbacks and missing continuity are rejected", () => {
    const base = destinations();
    expect(validateDestinations(base)).toEqual([]);
    const phone = [...base, { destinationId: "dst_15555550101", purpose: "STANDARD_SUPPORT" as const, vendorQueueRef: "Q", fallbackDestinationIds: [], languages: ["en"] }];
    expect(validateDestinations(phone)).toContain("DESTINATION_ID_INVALID");
    const tel = base.map((d) => (d.destinationId === "dst_support_general" ? { ...d, vendorQueueRef: "tel:+15555550101" } : d));
    expect(validateDestinations(tel)).toContain("VENDOR_QUEUE_REF_INVALID");
    const dangling = base.map((d) => (d.destinationId === "dst_support_general" ? { ...d, fallbackDestinationIds: ["dst_missing"] } : d));
    expect(validateDestinations(dangling)).toContain("FALLBACK_DESTINATION_UNDEFINED");
    expect(validateDestinations(base.filter((d) => d.purpose !== "OUTAGE_CONTINUITY"))).toContain("OUTAGE_CONTINUITY_DESTINATION_MISSING");
    expect(validateDestinations(base.filter((d) => d.purpose !== "SAFETY_PRIORITY").map((d) => ({ ...d, fallbackDestinationIds: [] })))).toContain(
      "SAFETY_DESTINATION_MISSING",
    );
  });

  it("[SPEC-10.transfer] the store applies conditional writes (stale versions conflict)", async () => {
    const store = new MemoryTransferStore();
    const { coordinator } = setup();
    const j = await coordinator.requestTransfer(handoff());
    await store.put({ ...j, version: 1 }, null);
    await expect(store.put({ ...j, version: 2 }, null)).rejects.toBeInstanceOf(ConflictError);
    await expect(store.put({ ...j, version: 2 }, 0)).rejects.toBeInstanceOf(ConflictError);
    await store.put({ ...j, version: 2 }, 1);
    expect((await store.get(j.handoffId))?.version).toBe(2);
  });

  it("[DATA-01] transfer logs are content-free (no summaries, phone numbers or package text)", async () => {
    const { coordinator, logs } = setup();
    const j = await coordinator.requestTransfer(handoff());
    await coordinator.applyEvent({ transferId: current(j).transferId, event: "RECEIVER_UNAVAILABLE", source: "talkdesk.fixture" });
    await coordinator.requestTransfer({ ...handoff(), destinationId: "+15555550101" }).catch(() => undefined);
    const text = JSON.stringify(logs);
    expect(text).not.toContain("Template-assembled");
    expect(text).not.toContain("5555550101");
    expect(logs.length).toBeGreaterThan(0);
  });
});
