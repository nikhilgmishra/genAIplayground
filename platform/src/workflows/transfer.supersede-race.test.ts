/**
 * One active journey per call, SAFETY first, under concurrent writes (SAFE-03; finding SAFE-HANDOFF-02,
 * round 2). Each test forces one interleaving deterministically with explicit gates: no timers, no
 * reliance on microtask counts (the exhaustive microtask probe at the end only adds coverage).
 * LOCAL FIXTURE store and telephony; SYNTHETIC calls and destinations; FakeClock.
 */
import { describe, expect, it } from "vitest";
import type { DestinationConfig } from "../config/ports.js";
import { CALLS, DESTINATIONS, TENANT_ID } from "../fixtures/synthetic-world.js";
import { createMemoryLogger } from "../observability/logger.js";
import type { AuditEventInput, DestinationId, HandoffPackage, TransferRecord } from "../protocol/index.js";
import { FakeClock } from "../shared/clock.js";
import { ConflictError } from "../shared/errors.js";
import { newId } from "../shared/ids.js";
import { MemoryTransferStore, TransferCoordinator, isActiveJourney, type TransferCoordinatorConfig, type TransferJourney, type TransferStore } from "./transfer.js";
import { MemoryAuditWriterFixture, TelephonyControlFixture } from "./workflow-test-fixtures.js";

const START = "2026-10-17T15:00:00.000Z";
const CALL = CALLS.primary.callId;

const config: TransferCoordinatorConfig = {
  environment: "local",
  updateTemplateIds: { STANDARD: "transfer.update.standard", SAFETY: "transfer.update.safety" },
  attemptTimeoutMs: { STANDARD: 60_000, SAFETY: 20_000 },
  maxStandardContinuityAttempts: 2,
};

const destinations = (): DestinationConfig[] => DESTINATIONS.map((d) => ({ ...d, fallbackDestinationIds: [...d.fallbackDestinationIds], languages: [...d.languages] }));

/** LOCAL FIXTURE store with interleaving hooks; every operation goes to a real MemoryTransferStore. */
class InterleavingStore implements TransferStore {
  readonly kind = "local_fixture" as const;
  readonly inner = new MemoryTransferStore();
  /** Runs after the snapshot was taken and before it is returned (models read latency). */
  onListForCall: ((snapshot: TransferJourney[]) => Promise<void>) | null = null;
  /** Runs before a write is applied. */
  onPut: ((journey: TransferJourney, expectedVersion: number | null) => Promise<void>) | null = null;
  /** SUPERSEDED writes fail as a store outage while set. */
  failSupersededWrites = false;
  supersedeConflicts = 0;

  get(handoffId: string) {
    return this.inner.get(handoffId);
  }
  findByTransferId(transferId: string) {
    return this.inner.findByTransferId(transferId);
  }
  listActive() {
    return this.inner.listActive();
  }
  async listForCall(tenantId: string, callId: string) {
    const snapshot = await this.inner.listForCall(tenantId, callId);
    const hook = this.onListForCall;
    if (hook) await hook(snapshot);
    return snapshot;
  }
  async put(journey: TransferJourney, expectedVersion: number | null) {
    const hook = this.onPut;
    if (hook) await hook(journey, expectedVersion);
    if (journey.status === "SUPERSEDED" && this.failSupersededWrites) throw new Error("synthetic store outage");
    try {
      await this.inner.put(journey, expectedVersion);
    } catch (err) {
      if (journey.status === "SUPERSEDED" && err instanceof ConflictError) this.supersedeConflicts += 1;
      throw err;
    }
  }
}

/** The dial command is sent (recorded) at once; the vendor's answer can be held back by the test. */
class GatedTelephony extends TelephonyControlFixture {
  beforeAnswer: ((input: { priority: "SAFETY" | "STANDARD" }) => Promise<void>) | null = null;
  override async requestTransfer(input: { callId: string; destinationId: DestinationId; handoffId: string; priority: "SAFETY" | "STANDARD" }) {
    const r = await super.requestTransfer(input);
    const hook = this.beforeAnswer;
    if (hook) await hook(input);
    return r;
  }
}

/** Lets a test run something right after a given audit event was written (a point between two coordinator steps). */
class HookedAudit extends MemoryAuditWriterFixture {
  afterAppend: ((input: AuditEventInput) => Promise<void>) | null = null;
  override async appendStandalone(input: AuditEventInput, stream?: string) {
    const r = await super.appendStandalone(input, stream);
    const hook = this.afterAppend;
    if (hook) await hook(input);
    return r;
  }
}

function setup() {
  const clock = new FakeClock(START);
  const telephony = new GatedTelephony();
  const audit = new HookedAudit();
  const store = new InterleavingStore();
  const { logger, records } = createMemoryLogger();
  const coordinator = new TransferCoordinator({ store, telephony, destinations: destinations(), clock, audit, logger, config });
  return { clock, telephony, audit, store, coordinator, logs: records };
}

function handoff(overrides: Partial<HandoffPackage> = {}): HandoffPackage {
  return {
    handoffId: newId("hof"),
    tenantId: TENANT_ID,
    callId: CALL,
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

const safetyHandoff = () => handoff({ reason: "SAFETY_PRIORITY", destinationId: "dst_safety_priority", statedIssue: "safety_concern", safetyRoutingReason: "EXPLICIT_PHRASE" });

const current = (j: TransferJourney): TransferRecord => {
  const a = j.attempts.find((x) => x.transferId === j.currentTransferId);
  if (!a) throw new Error("no current attempt");
  return a;
};

/** Yields to the event loop until `cond` holds (bounded: a forced interleaving that never happens fails the test). */
async function until(cond: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (await cond()) return;
    await new Promise<void>((r) => setImmediate(r));
  }
  throw new Error("forced interleaving did not happen");
}

function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((r) => {
    open = r;
  });
  return { wait, open };
}

type Env = ReturnType<typeof setup>;

const standardDialsAfter = (env: Env, from: number) => env.telephony.dials.slice(from).filter((d) => d.priority === "STANDARD");
const standardUpdates = (env: Env) => env.telephony.updates.filter((u) => u.templateId === config.updateTemplateIds.STANDARD);

async function sweeps(env: Env, n: number, stepMs = 61_000): Promise<void> {
  for (let i = 0; i < n; i++) {
    env.clock.advanceMs(stepMs);
    await env.coordinator.sweepTimeouts();
  }
}

async function journeysOfCall(env: Env): Promise<TransferJourney[]> {
  return env.store.inner.listForCall(TENANT_ID, CALL);
}

describe("one active journey per call under concurrent writes (SAFE-03, SAFE-HANDOFF-02)", () => {
  it("[SAFE-03][SAFE-HANDOFF-02] supersede read -> STANDARD dial write -> supersede write: the version conflict is retried on a fresh read and the STANDARD journey never dials again", async () => {
    const env = setup();
    const dialAnswer = gate();
    let safetyP: Promise<TransferJourney> | null = null;
    // The STANDARD dial is in flight (command sent, vendor answer pending) when the safety signal arrives.
    env.telephony.beforeAnswer = async (input) => {
      if (input.priority !== "STANDARD") return;
      env.telephony.beforeAnswer = null;
      safetyP = env.coordinator.requestTransfer(safetyHandoff(), { validatedSafetyEventAt: START });
      await dialAnswer.wait;
    };
    // The safety route's supersede read returns a snapshot taken before the STANDARD dial's write commits.
    let forced = false;
    env.store.onListForCall = async (snapshot) => {
      const std = snapshot.find((j) => j.priority === "STANDARD");
      if (!std || !snapshot.some((j) => j.priority === "SAFETY")) return;
      env.store.onListForCall = null;
      dialAnswer.open();
      await until(async () => ((await env.store.inner.get(std.handoffId))?.version ?? 0) > std.version);
      forced = true;
    };

    const standardResult = await env.coordinator.requestTransfer(handoff());
    const safety = await (safetyP as unknown as Promise<TransferJourney>);
    expect(forced).toBe(true);
    expect(env.store.supersedeConflicts).toBeGreaterThanOrEqual(1);

    const all = await journeysOfCall(env);
    const standard = all.find((j) => j.priority === "STANDARD") as TransferJourney;
    expect(standard.status).toBe("SUPERSEDED");
    expect(all.filter(isActiveJourney).map((j) => j.priority)).toEqual(["SAFETY"]);
    // The human request is answered with the safety route the caller is on.
    expect(standardResult.handoffId).toBe(safety.handoffId);
    expect(standardResult.priority).toBe("SAFETY");
    expect(env.logs.some((r) => r.event === "transfer.supersede_failed")).toBe(false);
    expect(env.audit.events.filter((e) => e.action === "transfer.superseded" && e.correlationId === standard.handoffId)).toHaveLength(1);

    const dialsAtSafety = env.telephony.dials.length;
    await sweeps(env, 6);
    expect(standardDialsAfter(env, dialsAtSafety)).toEqual([]);
    expect(standardUpdates(env)).toEqual([]);
    expect(env.telephony.dials.slice(0, 2).map((d) => [d.destinationId, d.priority])).toEqual([
      ["dst_support_general", "STANDARD"],
      ["dst_safety_priority", "SAFETY"],
    ]);
  });

  it("[SAFE-03][SAFE-HANDOFF-02] supersede commits while the STANDARD dial is in flight: the dial is recorded on the superseded journey, its late events are rejected, the request returns the safety journey", async () => {
    const env = setup();
    let safetyP: Promise<TransferJourney> | null = null;
    env.telephony.beforeAnswer = async (input) => {
      if (input.priority !== "STANDARD") return;
      env.telephony.beforeAnswer = null;
      // The whole safety request (route + supersede) completes before the STANDARD vendor answer arrives.
      safetyP = env.coordinator.requestTransfer(safetyHandoff(), { validatedSafetyEventAt: START });
      await safetyP;
    };
    const standardResult = await env.coordinator.requestTransfer(handoff());
    const safety = await (safetyP as unknown as Promise<TransferJourney>);
    expect(standardResult.handoffId).toBe(safety.handoffId);

    const standard = (await journeysOfCall(env)).find((j) => j.priority === "STANDARD") as TransferJourney;
    expect(standard.status).toBe("SUPERSEDED");
    const inFlight = current(standard);
    expect(inFlight.destinationId).toBe("dst_support_general");
    expect(standard.vendorRefs[inFlight.transferId]).toMatch(/^tdx_/);
    expect(env.audit.events.some((e) => e.action === "transfer.attempt_started" && e.outcome === "INVALIDATED" && e.reasonCode === "SUPERSEDED_BY_SAFETY_ROUTE")).toBe(true);

    const dialsAtSafety = env.telephony.dials.length;
    const late = await env.coordinator.applyEvent({ transferId: inFlight.transferId, event: "RECEIVER_UNAVAILABLE", source: "talkdesk.fixture" });
    expect(late.decision).toEqual({ kind: "rejected", reasonCode: "TRANSFER_JOURNEY_SUPERSEDED" });
    await sweeps(env, 6);
    expect(standardDialsAfter(env, dialsAtSafety)).toEqual([]);
    expect(standardUpdates(env)).toEqual([]);
  });

  it("[SAFE-03][SAFE-HANDOFF-02] check-then-act at creation: a STANDARD journey written after the safety route's supersede read re-checks before its first dial and dials nothing", async () => {
    const env = setup();
    let safetyP: Promise<TransferJourney> | null = null;
    // The STANDARD request passed its "no active safety journey" check; its create commits only after
    // the safety route started and ran its supersede read (which therefore cannot see it).
    env.store.onPut = async (journey, expectedVersion) => {
      if (journey.priority !== "STANDARD" || expectedVersion !== null) return;
      env.store.onPut = null;
      safetyP = env.coordinator.requestTransfer(safetyHandoff(), { validatedSafetyEventAt: START });
      await safetyP;
    };
    const standardResult = await env.coordinator.requestTransfer(handoff());
    const safety = await (safetyP as unknown as Promise<TransferJourney>);

    expect(env.telephony.dials.map((d) => [d.destinationId, d.priority])).toEqual([["dst_safety_priority", "SAFETY"]]);
    expect(standardResult.handoffId).toBe(safety.handoffId);
    const standard = (await journeysOfCall(env)).find((j) => j.priority === "STANDARD") as TransferJourney;
    expect(standard.status).toBe("SUPERSEDED");
    expect(standard.attempts).toEqual([]);
    await sweeps(env, 6);
    expect(env.telephony.dials.filter((d) => d.priority === "STANDARD")).toEqual([]);
    expect(standardUpdates(env)).toEqual([]);
  });

  it("[SAFE-03][SAFE-HANDOFF-02] a supersede that cannot be written is never dropped: vendor events, failover and the sweep do not route the STANDARD journey, and the sweep supersedes it once the store accepts the write", async () => {
    const env = setup();
    const standard = await env.coordinator.requestTransfer(handoff());
    env.store.failSupersededWrites = true;
    const safety = await env.coordinator.requestTransfer(safetyHandoff(), { validatedSafetyEventAt: START });
    expect(env.logs.some((r) => r.event === "transfer.supersede_failed")).toBe(true);
    expect((await env.store.inner.get(standard.handoffId))?.status).toBe("ROUTING");
    const dialsAtSafety = env.telephony.dials.length;

    // A vendor failure event on the STANDARD attempt: no update prompt, no next route.
    const r = await env.coordinator.applyEvent({ transferId: current(standard).transferId, event: "RECEIVER_UNAVAILABLE", source: "talkdesk.fixture" });
    expect(r.decision).toEqual({ kind: "rejected", reasonCode: "TRANSFER_JOURNEY_SUPERSEDED" });
    // The sweep neither times it out nor re-dials it while the write keeps failing.
    await sweeps(env, 3);
    expect(standardDialsAfter(env, dialsAtSafety)).toEqual([]);
    expect(standardUpdates(env)).toEqual([]);
    expect((await env.store.inner.get(standard.handoffId))?.status).toBe("ROUTING");
    // The sweep checks before timing the attempt out: no coordinator TIMEOUT is generated (and rejected) for it.
    expect(env.logs.filter((l) => l.event === "transfer.event_rejected" && l.fields.eventCode === "TIMEOUT")).toEqual([]);
    // The safety journey keeps routing (it is never affected by the STANDARD supersede).
    expect(env.telephony.dials.slice(dialsAtSafety).every((d) => d.priority === "SAFETY")).toBe(true);

    env.store.failSupersededWrites = false;
    await sweeps(env, 1);
    expect((await env.store.inner.get(standard.handoffId))?.status).toBe("SUPERSEDED");
    expect(env.audit.events.some((e) => e.action === "transfer.superseded" && e.correlationId === standard.handoffId)).toBe(true);
    await sweeps(env, 4);
    expect(standardDialsAfter(env, dialsAtSafety)).toEqual([]);
    expect(standardUpdates(env)).toEqual([]);
    expect((await env.coordinator.activeSafetyJourney(TENANT_ID, CALL))?.handoffId).toBe(safety.handoffId);
  });

  it.each([
    { window: "after a vendor failure event was applied, before the failover", afterAction: "transfer.state_changed", failingDial: false },
    { window: "after a failed STANDARD dial, before the next route is tried", afterAction: "transfer.dial_failed", failingDial: true },
  ])("[SAFE-03][SAFE-HANDOFF-02] a safety route that starts $window: the STANDARD step yields (no update prompt, no next dial)", async ({ afterAction, failingDial }) => {
    const env = setup();
    let standard = await env.coordinator.requestTransfer(handoff());
    if (failingDial) env.telephony.failingDestinations.add("dst_outage_continuity");
    let safetyP: Promise<TransferJourney> | null = null;
    let dialsAtSafety = -1;
    let updatesAtSafety = -1;
    env.audit.afterAppend = async (input) => {
      if (input.action !== afterAction || input.correlationId !== standard.handoffId) return;
      env.audit.afterAppend = null;
      dialsAtSafety = env.telephony.dials.length;
      updatesAtSafety = env.telephony.updates.length;
      safetyP = env.coordinator.requestTransfer(safetyHandoff(), { validatedSafetyEventAt: START });
      await safetyP;
    };
    const r = await env.coordinator.applyEvent({ transferId: current(standard).transferId, event: "RECEIVER_UNAVAILABLE", source: "talkdesk.fixture" });
    standard = r.journey;
    expect(safetyP, "the safety route started inside the window").not.toBeNull();
    await (safetyP as unknown as Promise<TransferJourney>);
    expect((await env.store.inner.get(standard.handoffId))?.status).toBe("SUPERSEDED");
    await sweeps(env, 4);
    // Nothing STANDARD reaches the caller once the safety route started: no update prompt, no dial.
    expect(env.telephony.updates.slice(updatesAtSafety).filter((u) => u.templateId === config.updateTemplateIds.STANDARD)).toEqual([]);
    expect(standardDialsAfter(env, dialsAtSafety)).toEqual([]);
    expect((await journeysOfCall(env)).filter(isActiveJourney).map((j) => j.priority)).toEqual(["SAFETY"]);
  });

  it.each(["CONNECTED", "HOLDING_FOR_OPERATIONS"] as const)(
    "[SAFE-03][SAFE-HANDOFF-02] a %s STANDARD journey whose supersede could not be written is superseded by the sweep through the routing SAFETY journey",
    async (status) => {
      const env = setup();
      let standard = await env.coordinator.requestTransfer(handoff());
      const event = (e: "RECEIVER_ACCEPTED" | "BRIDGED" | "CALLER_CONFIRMED_CONNECTED" | "RECEIVER_UNAVAILABLE" | "TIMEOUT") =>
        env.coordinator.applyEvent({ transferId: current(standard).transferId, event: e, source: "talkdesk.fixture" }).then((r) => (standard = r.journey));
      if (status === "CONNECTED") {
        for (const e of ["RECEIVER_ACCEPTED", "BRIDGED", "CALLER_CONFIRMED_CONNECTED"] as const) await event(e);
      } else {
        for (const e of ["RECEIVER_UNAVAILABLE", "TIMEOUT", "TIMEOUT"] as const) await event(e);
      }
      expect(standard.status).toBe(status);
      env.store.failSupersededWrites = true;
      await env.coordinator.requestTransfer(safetyHandoff(), { validatedSafetyEventAt: START });
      expect((await env.store.inner.get(standard.handoffId))?.status).toBe(status);
      const dialsAtSafety = env.telephony.dials.length;
      const updatesAtSafety = env.telephony.updates.length;
      env.store.failSupersededWrites = false;
      await sweeps(env, 1, 1_000);
      expect((await env.store.inner.get(standard.handoffId))?.status).toBe("SUPERSEDED");
      expect((await journeysOfCall(env)).filter(isActiveJourney).map((j) => j.priority)).toEqual(["SAFETY"]);
      expect(standardDialsAfter(env, dialsAtSafety)).toEqual([]);
      expect(env.telephony.updates.slice(updatesAtSafety).filter((u) => u.templateId === config.updateTemplateIds.STANDARD)).toEqual([]);
    },
  );

  it("[SAFE-03][SAFE-HANDOFF-02] retries are bounded under contention that never ends; the STANDARD journey still never dials and is superseded once contention stops", async () => {
    const env = setup();
    const standard = await env.coordinator.requestTransfer(handoff());
    // Every SUPERSEDED write loses: a concurrent writer bumps the STANDARD journey's version first.
    let contending = true;
    env.store.onPut = async (journey) => {
      if (!contending || journey.status !== "SUPERSEDED") return;
      const stored = (await env.store.inner.get(journey.handoffId)) as TransferJourney;
      await env.store.inner.put({ ...stored, version: stored.version + 1 }, stored.version);
    };
    await env.coordinator.requestTransfer(safetyHandoff(), { validatedSafetyEventAt: START });
    expect(env.logs.some((r) => r.event === "transfer.supersede_failed" && r.fields.reasonCode === "TRANSFER_SUPERSEDE_RETRIES_EXHAUSTED")).toBe(true);
    expect(env.store.supersedeConflicts).toBeLessThanOrEqual(8);
    const dialsAtSafety = env.telephony.dials.length;
    await sweeps(env, 2);
    expect(standardDialsAfter(env, dialsAtSafety)).toEqual([]);
    expect(standardUpdates(env)).toEqual([]);

    contending = false;
    await sweeps(env, 1);
    expect((await env.store.inner.get(standard.handoffId))?.status).toBe("SUPERSEDED");
    await sweeps(env, 3);
    expect(standardDialsAfter(env, dialsAtSafety)).toEqual([]);
  });

  it("[SAFE-03][SAFE-HANDOFF-02] exhaustive microtask interleavings of concurrent STANDARD and SAFETY requests (both orders, delayed STANDARD vendor answers, store latency): never an active STANDARD journey next to the SAFETY journey, never a STANDARD dial or prompt afterwards", async () => {
    const bad: string[] = [];
    let cases = 0;
    const ticks = async (n: number) => {
      for (let i = 0; i < n; i++) await Promise.resolve();
    };
    for (const safetyFirst of [false, true]) {
      for (const storeLatency of [0, 2]) {
        for (let answerDelay = 0; answerDelay < 36; answerDelay += 1) {
          for (let lag = 0; lag < 30; lag += 1) {
            const clock = new FakeClock(START);
            const telephony = new GatedTelephony();
            telephony.beforeAnswer = async (input) => {
              if (input.priority === "STANDARD") await ticks(answerDelay);
            };
            const store = new InterleavingStore();
            store.onPut = () => ticks(storeLatency);
            store.onListForCall = () => ticks(storeLatency);
            const coordinator = new TransferCoordinator({ store, telephony, destinations: destinations(), clock, audit: new MemoryAuditWriterFixture(), config });
            const std = () => coordinator.requestTransfer(handoff());
            const saf = () => coordinator.requestTransfer(safetyHandoff(), { validatedSafetyEventAt: START });
            const [first, second] = safetyFirst ? [saf, std] : [std, saf];
            await Promise.allSettled([first(), (async () => (await ticks(lag), second()))()]);
            const all = await store.inner.listForCall(TENANT_ID, CALL);
            const dialsAt = telephony.dials.length;
            const updatesAt = telephony.updates.length;
            for (let i = 0; i < 3; i++) {
              clock.advanceMs(61_000);
              await coordinator.sweepTimeouts();
            }
            const after = await store.inner.listForCall(TENANT_ID, CALL);
            const activeStandard = after.filter((j) => j.priority === "STANDARD" && isActiveJourney(j)).length;
            const lateStandardDials = telephony.dials.slice(dialsAt).filter((d) => d.priority === "STANDARD").length;
            const lateStandardUpdates = telephony.updates.slice(updatesAt).filter((u) => u.templateId === config.updateTemplateIds.STANDARD).length;
            const safetyActive = after.some((j) => j.priority === "SAFETY" && isActiveJourney(j));
            cases++;
            if (all.filter((j) => j.priority === "STANDARD" && isActiveJourney(j)).length > 0 || activeStandard > 0 || lateStandardDials > 0 || lateStandardUpdates > 0 || !safetyActive) {
              bad.push(JSON.stringify({ safetyFirst, storeLatency, answerDelay, lag, statuses: after.map((j) => `${j.priority}:${j.status}`), lateStandardDials, lateStandardUpdates }));
            }
          }
        }
      }
    }
    expect(cases).toBe(2 * 2 * 36 * 30);
    expect(bad.slice(0, 5)).toEqual([]);
  }, 120_000);
});
