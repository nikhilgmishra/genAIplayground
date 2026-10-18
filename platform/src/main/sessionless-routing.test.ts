/**
 * SAFE-02 end to end against the LOCAL FIXTURE container (platform/src/main/container.ts)
 * with the REAL business module (buildBusiness): safety routing and human requests
 * never require account authentication. Exercised over the deterministic HTTP tool
 * route (fastify.inject) and with the REAL MCP SDK client (Client +
 * StreamableHTTPClientTransport) against the container listening on 127.0.0.1 only
 * (ephemeral port, no external network). SYNTHETIC calls and LOCAL FIXTURE tokens.
 *
 * For no session, an expired session and a revoked session:
 *  - request_human_transfer and request_safety_route still route: the HandoffService
 *    runs with ctx null and the trusted call id from X-VSP-Interaction-Id; the dialled
 *    destination is an allowlisted DestinationConfig entry (SAFE-05);
 *  - both are audited (tool.invoke with the session reason code and the call id, plus
 *    the handoff's own audit event);
 *  - every other catalogue tool fails closed with the session reason code and has no
 *    effect (nothing dialled, nothing prepared).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBusiness } from "../business/index.js";
import { APPOINTMENTS, CLAIMS, INVOICES } from "../fixtures/synthetic-world.js";
import { LOCAL_FIXTURE_TOKENS } from "../gateway/auth.js";
import { CALL_UNIDENTIFIED } from "../gateway/tools/routing.js";
import { createMemoryLogger } from "../observability/logger.js";
import type { AuditEvent } from "../protocol/index.js";
import { FakeClock } from "../shared/clock.js";
import { buildContainer } from "./container.js";
import type { Container } from "./container.js";

const START = "2026-10-18T09:00:00.000Z";
const clock = new FakeClock(START);
let c: Container;
let base: URL;
const clients: Client[] = [];

beforeAll(async () => {
  c = await buildContainer({ environment: "local", buildBusiness, clock, env: {}, logger: createMemoryLogger().logger, rateLimit: null, ingestKnowledge: false });
  await c.app.listen({ host: "127.0.0.1", port: 0 });
  const addr = c.app.server.address() as AddressInfo;
  expect(addr.address).toBe("127.0.0.1");
  base = new URL(`http://127.0.0.1:${addr.port}/mcp`);
}, 120_000);

afterAll(async () => {
  for (const client of clients) await client.close().catch(() => undefined);
  await c?.close();
});

type Structured = { status: string; reasonCode?: string | null; data?: Record<string, unknown> | null; speech: unknown; auditEventId: string | null; policyDecisionId: string | null; sessionGeneration: number };
type Transport = "http" | "mcp";
type Tool = "request_human_transfer" | "request_safety_route";

const ROUTE_ARGS: Record<Tool, Record<string, unknown>> = {
  request_human_transfer: { reason: "CALLER_REQUESTED_HUMAN", language: "en", issueCategory: null, accommodations: [] },
  request_safety_route: { signalSource: "CALLER_REQUEST", concernSubject: "SELF", language: "en" },
};

/** One schema-valid argument set per non-routing tool (SYNTHETIC fixture ids), so the session check is what fails. */
const OTHER_TOOL_ARGS: Record<string, Record<string, unknown>> = {
  search_approved_runbook: { intent: "payment_help", query: null, language: "en" },
  get_login_guidance: { portal: "CLIENT_PORTAL", issue: "FORGOT_USERNAME", language: "en" },
  begin_verification: { method: "SECURE_LINK", locator: { kind: "PORTAL_USERNAME_HINT", hint: "synthetic.user" } },
  get_appointment_options: { appointmentId: APPOINTMENTS[0].appointmentId, fromDate: "2026-10-20", toDate: "2026-10-31" },
  prepare_appointment_change: { appointmentId: APPOINTMENTS[0].appointmentId, startsAt: "2026-10-22T15:00:00.000Z", modality: null },
  commit_appointment_change: { actionId: "act_synthNoSuchAction00001", digest: "a".repeat(64) },
  get_invoice_status: { invoiceId: INVOICES[0].invoiceId, detail: "BALANCE", serviceDate: null },
  prepare_billing_review: { invoiceId: INVOICES[0].invoiceId, reasonCategory: "OTHER" },
  submit_billing_review: { actionId: "act_synthNoSuchAction00001", digest: "a".repeat(64) },
  get_claim_status: { claimId: CLAIMS[0].claimId },
  get_provider_onboarding_status: { providerId: null, detail: "DOCUMENTS" },
  get_remittance_status: { practiceId: null, fromDate: "2026-09-01", toDate: "2026-10-31" },
  submit_partner_intake: { requestType: "OTHER", urgency: "STANDARD", language: "en" },
  submit_complaint: { category: "SERVICE_EXPERIENCE", wantsCallback: false, language: "en" },
  create_support_request: { issueCategory: "other", linkToAccount: false, urgency: "STANDARD", language: "en" },
  get_authorized_case_status: { supportReference: null },
};

let seq = 0;
const newCallId = (label: string): string => `cal_synthSessionless${label}${String(++seq).padStart(4, "0")}`;
const consent = () => ({ recording: "GRANTED", automatedProcessing: "GRANTED", disclosureTemplateVersion: "disclosure-local-v1", capturedAt: clock.now().toISOString(), capturedBy: "studio_flow" });
const bearer = (channel: keyof typeof LOCAL_FIXTURE_TOKENS) => ({ authorization: `Bearer ${LOCAL_FIXTURE_TOKENS[channel]}` });

async function startCall(callId: string): Promise<string> {
  const res = await c.app.inject({ method: "POST", url: "/telephony/v1/calls", headers: bearer("telephony_control"), payload: { callId, callerIdHash: null, consent: consent() } });
  expect(res.statusCode).toBe(201);
  return (res.json() as { sessionRef: string }).sessionRef;
}

const trustedHeaders = (callId: string | null, sessionRef: string | null): Record<string, string> => ({
  ...bearer("mcp_tools"),
  ...(callId ? { "x-vsp-interaction-id": callId } : {}),
  ...(sessionRef ? { "x-vsp-session-ref": sessionRef } : {}),
});

async function httpCall(tool: string, args: Record<string, unknown>, headers: Record<string, string>): Promise<Structured> {
  const res = await c.app.inject({ method: "POST", url: `/v1/tools/${tool}/1.0.0`, headers, payload: { arguments: args } });
  expect(res.statusCode).toBe(200);
  return res.json() as Structured;
}

async function mcpCall(tool: string, args: Record<string, unknown>, headers: Record<string, string>): Promise<Structured> {
  const client = new Client({ name: "vsp-sessionless-test-client", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(base, { requestInit: { headers } }));
  clients.push(client);
  const res = await client.callTool({ name: tool, arguments: args });
  return res.structuredContent as Structured;
}

const call = (t: Transport, tool: string, args: Record<string, unknown>, headers: Record<string, string>) => (t === "http" ? httpCall(tool, args, headers) : mcpCall(tool, args, headers));

async function auditFor(callId: string): Promise<AuditEvent[]> {
  return c.auditQuery.search({ tenantId: c.config.tenantId, callId, limit: 50 });
}

const allowlist = (): Set<string> => new Set(c.config.destinations.map((d) => d.destinationId));
const purposeOfDestination = (id: string) => c.config.destinations.find((d) => d.destinationId === id)?.purpose ?? null;

/** Routes one tool for a call with the given (absent/expired/revoked) session and checks the SAFE-02 evidence. */
async function expectRouted(t: Transport, tool: Tool, callId: string, sessionRef: string | null, sessionReason: string): Promise<void> {
  const before = c.fixtures.telephony.dials.length;
  const r = await call(t, tool, ROUTE_ARGS[tool], trustedHeaders(callId, sessionRef));
  expect(r.status, `${t} ${tool} ${sessionReason}`).toBe("SUCCESS");
  expect(r.sessionGeneration).toBe(0);
  expect(r.speech).toBeNull();
  expect(r.auditEventId).toMatch(/^aud_/);
  const handoff = (r.data as { handoff: { status: string; transferId: string | null; destinationPurpose: string } }).handoff;
  expect(handoff.status).toBe("TRANSFER_REQUESTED");
  expect(handoff.transferId).not.toBeNull();
  const expectedPurpose = tool === "request_safety_route" ? "SAFETY_PRIORITY" : "STANDARD_SUPPORT";
  expect(handoff.destinationPurpose).toBe(expectedPurpose);

  // Exactly one dial for this call, to an allowlisted destination of the expected purpose (SAFE-05).
  const dials = c.fixtures.telephony.dials.slice(before).filter((d) => d.callId === callId);
  expect(dials).toHaveLength(1);
  const dial = dials[0] as (typeof dials)[number];
  expect(allowlist().has(dial.destinationId)).toBe(true);
  expect(purposeOfDestination(dial.destinationId)).toBe(expectedPurpose);
  expect(dial.priority).toBe(tool === "request_safety_route" ? "SAFETY" : "STANDARD");
  const journey = await c.transfers.get(dial.handoffId);
  expect(journey?.callId).toBe(callId);
  expect(journey?.currentTransferId).toBe(handoff.transferId);

  // Audited: tool.invoke (session reason, call id, no actor/subject) and the handoff event.
  const events = await auditFor(callId);
  const invoke = events.find((e) => e.action === "tool.invoke" && e.evidencePointers.includes(`db://tool_catalog/${tool}/1.0.0`));
  expect(invoke).toMatchObject({ outcome: "SUCCEEDED", reasonCode: sessionReason, callId, actorRef: null, subjectRef: null, role: null, sourceComponent: t === "mcp" ? "mcp_adapter" : "gateway" });
  expect(invoke?.policyDecision?.allow).toBe(true);
  const handoffAction = tool === "request_safety_route" ? "handoff.safety_requested" : "handoff.requested";
  const routed = events.find((e) => e.action === handoffAction);
  expect(routed).toMatchObject({ callId, outcome: "PENDING", assurance: "A0", subjectRef: null });
  expect(routed?.evidencePointers).toContain(`handoff:${dial.handoffId}`);
  if (sessionRef) expect(JSON.stringify(events)).not.toContain(sessionRef);
}

/** Every other catalogue tool fails closed for the same transport state and has no effect. */
async function expectOthersFailClosed(t: Transport, callId: string, sessionRef: string | null, sessionReason: string): Promise<void> {
  const names = c.catalog.names().filter((n) => n !== "request_human_transfer" && n !== "request_safety_route");
  expect([...names].sort()).toEqual(Object.keys(OTHER_TOOL_ARGS).sort());
  const dialsBefore = c.fixtures.telephony.dials.length;
  const ledgerBefore = await ledgerRows();
  for (const name of names) {
    const r = await call(t, name, OTHER_TOOL_ARGS[name] as Record<string, unknown>, trustedHeaders(callId, sessionRef));
    expect({ name, status: r.status, reasonCode: r.reasonCode }).toEqual({ name, status: "POLICY_DENIED", reasonCode: sessionReason });
    expect(r.data ?? null).toBeNull();
    expect(r.speech).toBeNull();
  }
  expect(c.fixtures.telephony.dials.length).toBe(dialsBefore);
  expect(await ledgerRows()).toBe(ledgerBefore);
  const denied = (await auditFor(callId)).filter((e) => e.action === "tool.invoke" && e.outcome === "DENIED");
  expect(denied.length).toBeGreaterThanOrEqual(names.length);
}

async function ledgerRows(): Promise<number> {
  const r = await c.db.tx(async (tx) => (await tx.query<{ n: string }>("select count(*)::text as n from action_ledger")).rows, { role: "owner" });
  return Number(r[0]?.n ?? "0");
}

describe("[SAFE-02] safety and human routes without a usable session (LOCAL container, real business)", () => {
  it("[SAFE-02][SAFE-05] no session at all: both tools route over HTTP and the real MCP SDK client, allowlisted destination only, audited", async () => {
    for (const t of ["http", "mcp"] as const) {
      for (const tool of ["request_human_transfer", "request_safety_route"] as const) {
        await expectRouted(t, tool, newCallId("None"), null, "SESSION_REF_MISSING");
      }
    }
  }, 120_000);

  it("[SAFE-02][AUTH-04] revoked session: both tools still route (ctx null, trusted call id) and are audited", async () => {
    for (const t of ["http", "mcp"] as const) {
      for (const tool of ["request_human_transfer", "request_safety_route"] as const) {
        const callId = newCallId("Revoked");
        const ref = await startCall(callId);
        await c.identity.sessions.revoke(ref, "SESSION_REVOKED_BY_TEST");
        await expectRouted(t, tool, callId, ref, "SESSION_REVOKED");
      }
    }
  }, 120_000);

  it("[SAFE-02][AUTH-02] no session, revoked session: every other tool fails closed with the session reason and has no effect", async () => {
    await expectOthersFailClosed("http", newCallId("NoneOther"), null, "SESSION_REF_MISSING");
    await expectOthersFailClosed("mcp", newCallId("NoneOther"), null, "SESSION_REF_MISSING");
    const callId = newCallId("RevokedOther");
    const ref = await startCall(callId);
    await c.identity.sessions.revoke(ref, "SESSION_REVOKED_BY_TEST");
    await expectOthersFailClosed("http", callId, ref, "SESSION_REVOKED");
    await expectOthersFailClosed("mcp", callId, ref, "SESSION_REVOKED");
  }, 180_000);

  it("[SAFE-02] without a trusted call id there is nothing to transfer: honest non-success, nothing dialled, still audited", async () => {
    const before = c.fixtures.telephony.dials.length;
    for (const t of ["http", "mcp"] as const) {
      for (const tool of ["request_human_transfer", "request_safety_route"] as const) {
        const r = await call(t, tool, ROUTE_ARGS[tool], trustedHeaders(null, null));
        expect(r).toMatchObject({ status: "PERMANENT_FAILURE", reasonCode: CALL_UNIDENTIFIED });
        expect(r.auditEventId).toMatch(/^aud_/);
      }
    }
    expect(c.fixtures.telephony.dials.length).toBe(before);
  }, 120_000);

  // Runs last: it advances the shared FakeClock past the session TTL.
  it("[SAFE-02][AUTH-04] expired session (before any TTL cleanup): both tools still route; every other tool fails closed", async () => {
    const calls: { t: Transport; tool: Tool; callId: string; ref: string }[] = [];
    for (const t of ["http", "mcp"] as const) {
      for (const tool of ["request_human_transfer", "request_safety_route"] as const) {
        const callId = newCallId("Expired");
        calls.push({ t, tool, callId, ref: await startCall(callId) });
      }
    }
    const otherCall = newCallId("ExpiredOther");
    const otherRef = await startCall(otherCall);
    clock.advanceSeconds(c.config.sessionBinding.sessionTtlSeconds + 1);
    for (const x of calls) await expectRouted(x.t, x.tool, x.callId, x.ref, "SESSION_EXPIRED");
    await expectOthersFailClosed("http", otherCall, otherRef, "SESSION_EXPIRED");
    await expectOthersFailClosed("mcp", otherCall, otherRef, "SESSION_EXPIRED");
  }, 180_000);
});
