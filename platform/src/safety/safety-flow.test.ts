/**
 * End-to-end LOCAL flow: unverified caller (A0) -> safety signal -> deterministic
 * route -> gated fixed acknowledgment -> speech queue -> guard -> content-free
 * evidence. SYNTHETIC data; in-test audit fixture; PGlite.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PgliteDb } from "../db/pglite.js";
import { createTestDb } from "../db/testing.js";
import { CALLS, TENANT_ID } from "../fixtures/synthetic-world.js";
import { FakeClock } from "../shared/clock.js";
import { TemplateResponseGate } from "../voice/gate.js";
import type { GateContext } from "../voice/ports.js";
import { loadDefaultTemplateRegistry } from "../voice/registry.js";
import { SpeechQueue } from "../voice/speech-queue.js";
import { InMemoryTurnTracker } from "../voice/turns.js";
import { FIXTURE_AUDIT_TABLE_SQL, RecordingAuditWriterFixture } from "./__fixtures__/audit-writer.fixture.js";
import { ConversationGuard } from "./conversation-guard.js";
import { SafetyPipeline } from "./pipeline.js";
import { SafetyEventRecorder } from "./safety-events.js";

const SES = "ses_synthSessionPrimary000000001";
let db: PgliteDb;
beforeEach(async () => {
  db = await createTestDb({ include: /^0610_/ });
  await db.exec(FIXTURE_AUDIT_TABLE_SQL);
});
afterEach(async () => {
  await db.close();
});

function harness(environment: GateContext["environment"]) {
  const clock = new FakeClock();
  const turns = new InMemoryTurnTracker();
  const registry = loadDefaultTemplateRegistry();
  const gate = new TemplateResponseGate({ registry, turnTracker: turns });
  const queue = new SpeechQueue({ turns });
  const guard = new ConversationGuard();
  const audit = new RecordingAuditWriterFixture({ table: "fixture_audit_events" });
  const recorder = new SafetyEventRecorder({ db, audit, clock });
  const pipeline = new SafetyPipeline();
  const turnId = turns.beginTurn(SES, 1);
  // A0: no authorization references at all.
  const ctx: GateContext = { sessionRef: SES, currentTurnId: turnId, sessionGeneration: 1, validAuthorizationRefs: new Set(), locale: "es-US", environment };
  return { clock, turns, gate, queue, guard, audit, recorder, pipeline, turnId, ctx };
}

describe("safety flow at A0", () => {
  it("[SAFE-02] [SPEC-10.routing] an unverified Spanish-speaking caller reaches the safety route with the fixed acknowledgment, no authentication", async () => {
    const h = harness("local");
    const callId = CALLS.primary.callId;
    h.guard.start(callId);
    const evaluation = h.pipeline.evaluate({ text: "Ya no aguanto más, quiero quitarme la vida.", locale: "es-US", asrConfidence: 0.92 }, { afterHours: true, safetyModeActive: false });
    const d = evaluation.decision;
    expect(d).toMatchObject({ route: "SAFETY_PRIORITY_HUMAN", requiresAuthentication: false, revokePendingActions: true, destinationId: "dst_safety_priority" });

    const incident = h.recorder.begin({ tenantId: TENANT_ID, callId, sessionGeneration: 0, turnId: h.turnId, signals: evaluation.signals, decision: d, locale: "es-US", afterHours: true });
    const guardDecision = h.guard.apply(callId, { type: "SAFETY_SIGNAL" });
    expect(guardDecision.action).toMatchObject({ kind: "SAFETY_ROUTE", step: "INITIATE", templateId: d.acknowledgmentTemplateId });

    const ack = h.gate.render(
      { templateId: d.acknowledgmentTemplateId ?? "", templateVersion: "0.1.0-draft", responseClass: "SAFETY", slots: {}, authorizationRef: null, sourceRefs: [], turnId: h.turnId, sessionGeneration: 1 },
      h.ctx,
    );
    expect(ack.ok).toBe(true);
    expect(h.queue.enqueue(ack).accepted).toBe(true);
    expect(h.queue.next(SES)?.responseClass).toBe("SAFETY");

    h.clock.advanceMs(900);
    const init = await h.recorder.recordRouteInitiated(incident);
    expect(init).toMatchObject({ recorded: true, latencyMs: 900, withinTarget: true });

    // Budget exhaustion and refusals during the handoff never end it.
    expect(h.guard.apply(callId, { type: "TRANSFER_STARTED", priority: "SAFETY" }).action.kind).toBe("SAFETY_ROUTE");
    expect(h.guard.apply(callId, { type: "BUDGET_EXHAUSTED" }).action).toMatchObject({ kind: "SAFETY_ROUTE", reasonCode: "SAFETY_RESERVE_IN_USE" });
    expect(h.guard.apply(callId, { type: "MODEL_REFUSAL" }).action.kind).toBe("SAFETY_ROUTE");
  });

  it("[SAFE-03] [OPS-04] in production with unapproved templates the acknowledgment cannot be spoken, but the safety route is unaffected", () => {
    const h = harness("production");
    const evaluation = h.pipeline.evaluate({ text: "I want to kill myself.", locale: "en-US", asrConfidence: null }, { afterHours: false, safetyModeActive: false });
    expect(evaluation.decision.route).toBe("SAFETY_PRIORITY_HUMAN");
    const ack = h.gate.render(
      { templateId: "safety.acknowledgment", templateVersion: "0.1.0-draft", responseClass: "SAFETY", slots: {}, authorizationRef: null, sourceRefs: [], turnId: h.turnId, sessionGeneration: 1 },
      { ...h.ctx, locale: "en-US" },
    );
    expect(ack).toMatchObject({ ok: false, reasonCode: "TEMPLATE_NOT_APPROVED", disposition: "ROUTE_HUMAN_WITHOUT_SPEECH", routeToHuman: true });
    // The route decision does not depend on speech: it still targets the safety destination.
    expect(evaluation.decision.destinationId).toBe("dst_safety_priority");
    expect(h.guard.apply(CALLS.primary.callId, { type: "SAFETY_SIGNAL" }).action.kind).toBe("SAFETY_ROUTE");
  });

  it("[SPEC-11.barge-in] a caller interrupting the acknowledgment invalidates it; the safety mode persists", () => {
    const h = harness("local");
    const ack = h.gate.render(
      { templateId: "safety.acknowledgment", templateVersion: "0.1.0-draft", responseClass: "SAFETY", slots: {}, authorizationRef: null, sourceRefs: [], turnId: h.turnId, sessionGeneration: 1 },
      h.ctx,
    );
    h.queue.enqueue(ack);
    h.queue.next(SES);
    h.guard.apply(CALLS.primary.callId, { type: "SAFETY_SIGNAL" });
    expect(h.queue.bargeIn(SES).stopPlayback).toBe(true);
    expect(h.queue.enqueue(ack)).toEqual({ accepted: false, reasonCode: "STALE_TURN" });
    expect(h.guard.apply(CALLS.primary.callId, { type: "TURN_COMPLETED" }).action.kind).toBe("SAFETY_ROUTE");
  });
});
