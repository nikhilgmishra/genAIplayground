import { describe, expect, it } from "vitest";
import { InMemoryMetrics } from "../observability/metrics.js";
import type { SpeechDirective } from "../protocol/index.js";
import { TemplateResponseGate } from "./gate.js";
import type { GatedUtterance } from "./gate.js";
import type { GateContext } from "./ports.js";
import { loadDefaultTemplateRegistry } from "./registry.js";
import { SpeechQueue, splitSegments } from "./speech-queue.js";
import { InMemoryTurnTracker } from "./turns.js";

const SES = "ses_synthSessionPrimary000000001";
const AUTH = "pdc_synthDecisionPrimary01";
const registry = loadDefaultTemplateRegistry();

function setup() {
  const turns = new InMemoryTurnTracker();
  const gate = new TemplateResponseGate({ registry, turnTracker: turns });
  const metrics = new InMemoryMetrics();
  const queue = new SpeechQueue({ turns, metrics });
  const turnId = turns.beginTurn(SES, 1);
  const ctx = (over: Partial<GateContext> = {}): GateContext => ({
    sessionRef: SES,
    currentTurnId: turnId,
    sessionGeneration: 1,
    validAuthorizationRefs: new Set([AUTH]),
    locale: "en-US",
    environment: "local",
    ...over,
  });
  const claim = (tid = turnId): SpeechDirective => ({
    templateId: "claim.status",
    templateVersion: "0.1.0-draft",
    responseClass: "FINANCIAL_FACT",
    slots: { serviceDate: "2026-09-20", insurerStatus: "IN_PROCESS", asOfDate: "2026-10-15" },
    authorizationRef: AUTH,
    sourceRefs: ["claim:clm_synthAveryClaim0001"],
    turnId: tid,
    sessionGeneration: 1,
  });
  return { turns, gate, queue, metrics, turnId, ctx, claim };
}

describe("SpeechQueue (LOCAL FIXTURE)", () => {
  it("[ACT-05] refuses a protected segment that has not passed the gate, and any forged gate result", () => {
    const { queue, gate, ctx, claim } = setup();
    expect(queue.kind).toBe("local_fixture");
    expect(queue.enqueue({ ok: true, utterance: "Your claim was paid.", templateId: "claim.status", responseClass: "FINANCIAL_FACT", sessionRef: SES })).toEqual({
      accepted: false,
      reasonCode: "PROTECTED_SEGMENT_NOT_GATED",
    });
    expect(queue.enqueue({ text: "free text from a dependency" })).toEqual({ accepted: false, reasonCode: "SEGMENT_NOT_GATED" });
    const real = gate.render(claim(), ctx()) as GatedUtterance;
    expect(real.ok).toBe(true);
    // A copy (or mutated clone) of a real result is not gate-issued.
    expect(queue.enqueue({ ...real, utterance: "Your claim is guaranteed to be paid." }).accepted).toBe(false);
    expect(() => {
      (real as { utterance: string }).utterance = "tampered";
    }).toThrow();
    expect(queue.enqueue(real).accepted).toBe(true);
  });

  it("[ACT-05] [SPEC-11.barge-in] barge-in stops playback and drops every queued segment; late results cannot be enqueued", () => {
    const { queue, gate, ctx, claim, metrics } = setup();
    const r = gate.render(claim(), ctx());
    const enq = queue.enqueue(r);
    expect(enq.accepted && enq.segmentIds.length).toBe(3);
    const first = queue.next(SES);
    expect(first?.index).toBe(0);
    const barge = queue.bargeIn(SES);
    expect(barge).toMatchObject({ droppedSegments: 2, stopPlayback: true });
    expect(barge.invalidatedTurnId).toBe(first?.turnId);
    expect(queue.next(SES)).toBeNull();
    // The tool result for the interrupted turn arrives late: it can neither pass the gate nor be queued.
    expect(queue.enqueue(r)).toEqual({ accepted: false, reasonCode: "STALE_TURN" });
    expect(metrics.counterValue("vsp_interruptions_total", { kind: "barge_in" })).toBe(1);
  });

  it("[ACT-05] segments queued for a turn are dropped at dequeue once a newer turn begins", () => {
    const { queue, gate, ctx, claim, turns } = setup();
    queue.enqueue(gate.render(claim(), ctx()));
    const before = queue.staleSegmentsDropped;
    turns.beginTurn(SES, 1);
    expect(queue.next(SES)).toBeNull();
    expect(queue.staleSegmentsDropped - before).toBe(3);
  });

  it("[ACT-05] every segment carries the turn id and session generation of its gate result", () => {
    const { queue, gate, ctx, claim, turnId } = setup();
    queue.enqueue(gate.render(claim(), ctx()));
    const seg = queue.next(SES);
    expect(seg).toMatchObject({ sessionRef: SES, turnId, sessionGeneration: 1, templateId: "claim.status", protectedClass: true, localUnapprovedBadge: true });
    expect(Object.isFrozen(seg)).toBe(true);
  });

  it("[SPEC-11.fail-closed] a speakable gate fallback can be queued; a stale drop cannot", () => {
    const { queue, gate, ctx, claim } = setup();
    const fallback = gate.render({ ...claim(), authorizationRef: null }, ctx());
    expect(fallback.ok).toBe(false);
    expect(queue.enqueue(fallback).accepted).toBe(true);
    expect(queue.next(SES)?.templateId).toBe("fallback.safe_explanation");
    const stale = gate.render(claim("turn_synthTurnOld01"), ctx());
    expect(queue.enqueue(stale)).toEqual({ accepted: false, reasonCode: "SEGMENT_NOT_GATED" });
  });

  it("[ACT-05] the per-session queue is bounded", () => {
    const turns = new InMemoryTurnTracker();
    const gate = new TemplateResponseGate({ registry });
    const queue = new SpeechQueue({ turns, maxQueuedPerSession: 2 });
    const turnId = turns.beginTurn(SES, 1);
    const ctx: GateContext = { sessionRef: SES, currentTurnId: turnId, sessionGeneration: 1, validAuthorizationRefs: new Set(), locale: "en-US", environment: "local" };
    const ack = { templateId: "status.checking", templateVersion: "0.1.0-draft", responseClass: "GENERIC_STATUS" as const, slots: {}, authorizationRef: null, sourceRefs: [], turnId, sessionGeneration: 1 };
    expect(queue.enqueue(gate.render(ack, ctx)).accepted).toBe(true);
    expect(queue.enqueue(gate.render(ack, ctx)).accepted).toBe(true);
    expect(queue.enqueue(gate.render(ack, ctx))).toEqual({ accepted: false, reasonCode: "SPEECH_QUEUE_FULL" });
  });

  it("[SPEC-11.barge-in] segmentation does not split after abbreviations or the Spanish 'p. m.'", () => {
    expect(splitSegments("Your appointment with Dr. Morgan is at 5:00 p. m., hora del Centro. Say yes.")).toEqual([
      "Your appointment with Dr. Morgan is at 5:00 p. m., hora del Centro.",
      "Say yes.",
    ]);
    expect(splitSegments("Let me check that.")).toEqual(["Let me check that."]);
  });
});
