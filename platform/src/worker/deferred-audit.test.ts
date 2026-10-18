/**
 * Audit outage over the LOCAL FIXTURE composition (real business module, PGlite, OPA WASM,
 * SYNTHETIC data, fastify.inject, FakeClock, worker loops run explicitly). The outage is the
 * LOCAL FIXTURE simulation used by the journeys: `revoke insert on audit_outbox from app_runtime`.
 *
 * During the outage the consequential commit is still refused before any provider effect, while
 * the human and safety routes proceed; their handoff audit events are deferred (bounded,
 * process-local) and appended in order by the `audit.deferred_flush` loop once the store is
 * writable again. The safety_events row is the durable incident record meanwhile.
 */
import { afterEach, describe, expect, it } from "vitest";
import { buildBusiness } from "../business/index.js";
import { DEFERRED_AUDIT_MARKER_ACTION } from "../audit/deferred.js";
import { verifyChain } from "../audit/chain.js";
import { APPOINTMENTS, PEOPLE } from "../fixtures/synthetic-world.js";
import { LOCAL_FIXTURE_TOKENS } from "../gateway/auth.js";
import { buildContainer } from "../main/container.js";
import type { Container } from "../main/container.js";
import { createMemoryLogger } from "../observability/logger.js";
import type { AuditEvent } from "../protocol/index.js";
import { FakeClock } from "../shared/clock.js";
import { newId } from "../shared/ids.js";
import { ManualLoopScheduler } from "./scheduler.js";
import { Worker, workerLoopsFor } from "./worker.js";

const START = "2026-10-18T14:00:00.000Z";
let c: Container | null = null;
let w: Worker | null = null;
afterEach(async () => {
  await w?.stop();
  w = null;
  await c?.close();
  c = null;
});

const bearer = (channel: keyof typeof LOCAL_FIXTURE_TOKENS) => ({ authorization: `Bearer ${LOCAL_FIXTURE_TOKENS[channel]}` });
type Reply = { status: number; body: Record<string, unknown> };

describe("deferred route audit during an audit outage (composition)", () => {
  it("[OPS-01][SAFE-02][SAFE-03][SPEC-16.fault-audit-outage] the commit stays blocked; the human and safety handoff audit events are deferred and appended in order after recovery", async () => {
    const { logger, records } = createMemoryLogger();
    const clock = new FakeClock(START);
    c = await buildContainer({ environment: "local", buildBusiness, clock, env: {}, logger, rateLimit: null, ingestKnowledge: false });
    const cc = c;
    const { loops, closers } = workerLoopsFor(cc);
    w = new Worker({ loops, scheduler: new ManualLoopScheduler(clock), clock, logger, closers });
    w.start();
    const tenantId = cc.config.tenantId;
    const callId = `cal_synthDeferredAudit${newId("da").slice(3, 15)}`;
    const appt = APPOINTMENTS[0].appointmentId;

    const studio = async (method: "GET" | "POST", url: string, sessionRef: string | null, payload?: unknown): Promise<Reply> => {
      const res = await cc.app.inject({ method, url, headers: { ...bearer("telephony_control"), "x-vsp-interaction-id": callId, ...(sessionRef ? { "x-vsp-session-ref": sessionRef } : {}) }, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });
      return { status: res.statusCode, body: (res.body.length > 0 ? res.json() : {}) as Record<string, unknown> };
    };
    const tool = async (name: string, args: Record<string, unknown>, sessionRef: string): Promise<Record<string, unknown>> => {
      const res = await cc.app.inject({
        method: "POST",
        url: `/v1/tools/${name}/1.0.0`,
        headers: { ...bearer("mcp_tools"), "x-vsp-interaction-id": callId, "x-vsp-session-ref": sessionRef, "idempotency-key": `idem_${newId("ik").slice(3)}` },
        payload: { arguments: args },
      });
      expect(res.statusCode).toBe(200);
      return res.json() as Record<string, unknown>;
    };

    // A verified client with a confirmed appointment change (TC-01, TC-03, secure link, prepare, TC-07, TC-08).
    const started = await studio("POST", "/telephony/v1/calls", null, { callId, callerIdHash: null, consent: { recording: "GRANTED", automatedProcessing: "GRANTED", disclosureTemplateVersion: "disclosure-local-v1", capturedAt: clock.now().toISOString(), capturedBy: "studio_flow" } });
    expect(started.status).toBe(201);
    const sessionRef = started.body.sessionRef as string;
    expect((await studio("POST", "/telephony/v1/session/role", sessionRef, { role: "client" })).status).toBe(200);
    expect((await studio("POST", "/telephony/v1/session/verification", sessionRef, { method: "secure_link", role: "client", locator: { fullName: PEOPLE.avery.fullName, dateOfBirth: PEOPLE.avery.dateOfBirth } })).status).toBe(200);
    const m = /\/(vtx_[A-Za-z0-9_-]+)#n=([A-Za-z0-9_-]{43})$/.exec(cc.identity.notifications.lastTo(PEOPLE.avery.channels[0].channelRef)?.slots.linkPath ?? "");
    const link = { transactionId: m?.[1] ?? "", nonce: m?.[2] ?? "" };
    const idToken = await cc.identity.idp.issueFor(PEOPLE.avery, { nonce: link.nonce, amr: ["pwd", "mfa"] });
    const approved = await cc.app.inject({ method: "POST", url: "/portal/v1/verification/approve", headers: bearer("portal"), payload: { ...link, idToken, matchCodeConfirmed: true } });
    expect(approved.json()).toMatchObject({ bound: true });
    const options = await tool("get_appointment_options", { appointmentId: appt, fromDate: "2026-10-20", toDate: "2026-10-31" }, sessionRef);
    const open = ((options.data as { appointments: { slotId: string | null; startsAt: string; status: string }[] }).appointments ?? []).filter((a) => a.status === "OPEN");
    expect(open.length).toBeGreaterThan(0);
    const prepared = await tool("prepare_appointment_change", { appointmentId: appt, startsAt: open[0]?.startsAt, modality: null, slotId: open[0]?.slotId ?? null }, sessionRef);
    expect(prepared.status).toBe("SUCCESS");
    const change = (prepared.data as { change: { actionId: string; actionDigest: string } }).change;
    const pending = await studio("GET", "/telephony/v1/session/pending-confirmation", sessionRef);
    expect(pending.status).toBe(200);
    const confirmed = await studio("POST", `/telephony/v1/session/actions/${change.actionId}/confirm`, sessionRef, {
      digest: pending.body.digest,
      sessionGeneration: pending.body.sessionGeneration,
      turnId: pending.body.turnId,
      method: "dtmf_keypress",
      capturedAt: clock.now().toISOString(),
    });
    expect(confirmed.body.state).toBe("CONFIRMED");
    const effectsBefore = cc.fixtures.scheduling.effects.length;

    // ---- LOCAL FIXTURE audit outage ----
    await cc.db.exec("revoke insert on audit_outbox from app_runtime");
    let human: Reply;
    let screened: Reply;
    let commit: Record<string, unknown>;
    let flushDuringOutage;
    try {
      commit = await tool("commit_appointment_change", { actionId: change.actionId, digest: change.actionDigest }, sessionRef);
      human = await studio("POST", "/telephony/v1/session/human-request", sessionRef, { callId, reason: "CALLER_REQUESTED_HUMAN", language: "en", issueCategory: null });
      cc.fixtures.telephony.scriptDestination("dst_safety_priority", { outcome: "CONNECTED" });
      screened = await studio("POST", "/telephony/v1/session/utterance-screening", sessionRef, { callId, text: "i want to kill myself", locale: "en-US", asrConfidence: 0.92 });
      flushDuringOutage = await w.runLoop("audit.deferred_flush");
    } finally {
      await cc.db.exec("grant insert on audit_outbox to app_runtime");
    }
    // OPS-01: the consequential commit was refused before any provider effect (deferral is never used for mutations).
    expect(commit.status).not.toBe("SUCCESS");
    expect(cc.fixtures.scheduling.effects.length).toBe(effectsBefore);
    expect(cc.deps.audit).toBe(cc.audit);
    // SAFE-02 / SAFE-03: both routes proceeded.
    expect(human.status).toBe(200);
    expect(screened.body).toMatchObject({ route: "SAFETY_PRIORITY_HUMAN", destinationId: "dst_safety_priority" });
    // Their audit events are held (bounded, process-local), loudly, and nothing was attempted while unwritable.
    expect(flushDuringOutage).toMatchObject({ ok: true, processed: 0, reasonCode: "AUDIT_STORE_UNWRITABLE" });
    expect(cc.deferredAudit.pending().map((p) => p.action)).toEqual(["handoff.requested", "handoff.safety_requested"]);
    expect(records.filter((r) => r.event === "audit.deferred.queued" && r.level === "error")).toHaveLength(2);
    expect(cc.metrics.gaugeValue("vsp_audit_deferred_depth")).toBe(2);
    // The safety_events row is the durable incident record meanwhile.
    const safetyRows = await cc.db.tx((tx) => tx.query<{ audit_status: string }>("select audit_status from safety_events where call_id = $1", [callId]), { role: "owner" });
    expect(safetyRows.rows.length).toBeGreaterThan(0);
    expect(safetyRows.rows.every((r) => r.audit_status === "AUDIT_UNAVAILABLE")).toBe(true);
    const handoffEvents = async () => (await cc.auditQuery.search({ tenantId, callId, limit: 200 })).filter((e) => e.action.startsWith("handoff.") || e.action === DEFERRED_AUDIT_MARKER_ACTION);
    expect(await handoffEvents()).toEqual([]);

    // ---- recovery: the worker loop appends the deferred route evidence, in order ----
    clock.advanceMs(5_000);
    const flushed = await w.runLoop("audit.deferred_flush");
    expect(flushed).toMatchObject({ ok: true, processed: 2, reasonCode: null });
    expect(cc.deferredAudit.depth).toBe(0);
    const after = (await handoffEvents()).sort((a, b) => a.sequence - b.sequence);
    expect(after.map((e) => e.action)).toEqual(["handoff.requested", DEFERRED_AUDIT_MARKER_ACTION, "handoff.safety_requested", DEFERRED_AUDIT_MARKER_ACTION]);
    expect(after[0]).toMatchObject({ callId, outcome: "PENDING", occurredAt: START });
    expect(after[1]).toMatchObject({ parentId: after[0]?.eventId, reasonCode: "AUDIT_STORE_UNWRITABLE" });
    expect(after[3]).toMatchObject({ parentId: after[2]?.eventId, reasonCode: "AUDIT_STORE_UNWRITABLE" });
    expect(cc.metrics.counterValue("vsp_audit_deferred_total", { result: "flushed", reason: "none" })).toBe(2);
    expect(cc.metrics.counterValue("vsp_worker_loop_processed_total", { loop: "audit.deferred_flush" })).toBe(2);
    // No commit evidence was ever written for the refused mutation, and the ledger never committed.
    expect((await cc.auditQuery.search({ tenantId, callId, action: "action.commit.succeeded", limit: 10 })).length).toBe(0);
    const ledger = await cc.db.tx((tx) => tx.query<{ state: string }>("select state from action_ledger where action_id = $1", [change.actionId]), { role: "owner" });
    expect(ledger.rows[0]?.state).not.toBe("COMMITTED");
    // The runtime chain is intact with the late events in it.
    const rows = await cc.db.tx((tx) => tx.query<{ event: AuditEvent }>("select event from audit_outbox where source_stream = 'runtime' order by sequence asc"), { role: "owner" });
    expect(verifyChain(rows.rows.map((r) => r.event), { sourceStream: "runtime", expectedSequence: 1, expectedPrevHash: null }).findings).toEqual([]);
    // Content-free: the screened words never reach logs or audit.
    expect(JSON.stringify(records)).not.toContain("kill");
    expect(JSON.stringify(rows.rows)).not.toContain("kill myself");
  }, 120_000);
});
