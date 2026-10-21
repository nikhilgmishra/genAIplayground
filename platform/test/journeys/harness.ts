/**
 * LOCAL FIXTURE end-to-end journey harness (spec sections 15 "Phase 1 complete offline
 * slice" and 16 "Required demonstration journeys"). SYNTHETIC people, calls and systems
 * only; nothing here is Talkdesk, Salesforce, an IdP or production evidence.
 *
 * The harness composes the FULL local container (platform/src/main/container.ts with the
 * REAL business module), the local console composition (main/console.ts) and the worker
 * loops (worker/worker.ts), and drives only the real HTTP surface:
 *  - telephony-control endpoints as the Talkdesk Studio identity (telephony_control);
 *  - tool calls through the REAL MCP SDK client (Client + StreamableHTTPClientTransport)
 *    against the gateway listening on 127.0.0.1 (ephemeral port), as the mcp_tools
 *    identity with the trusted X-VSP-Session-Ref / X-VSP-Interaction-Id headers;
 *  - portal verification as the portal identity, with MFA ID tokens minted for
 *    SYNTHETIC people by the LocalOidcProviderFixture;
 *  - the console API as SYNTHETIC staff (LOCAL FIXTURE workforce IdP);
 *  - transfer lifecycle events through the LOCAL FIXTURE HMAC webhook (TC-09).
 * Time is a FakeClock. Worker loops are run explicitly (deterministic), never on timers.
 *
 * Caller-visible behaviour is captured as the utterances the response gate renders from
 * approved templates (tool speech directives, TC-07 confirmation prompts) plus the template
 * ids Studio plays; backend evidence is read from the database (owner role, read only),
 * the LOCAL FIXTURE effect logs and the audit chain (IntegrityVerifier).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AddressInfo } from "node:net";
import { expect } from "vitest";
import { buildBusiness } from "../../src/business/index.js";
import { verifyChain } from "../../src/audit/chain.js";
import { IntegrityVerifier } from "../../src/audit/verifier.js";
import { IDP, PEOPLE, STAFF } from "../../src/fixtures/synthetic-world.js";
import type { SyntheticPerson } from "../../src/fixtures/synthetic-world.js";
import { LOCAL_FIXTURE_TOKENS } from "../../src/gateway/auth.js";
import { fixtureWebhookSignature } from "../../src/gateway/http/webhook-routes.js";
import { buildLocalConsole } from "../../src/main/console.js";
import type { LocalConsole } from "../../src/main/console.js";
import { buildContainer } from "../../src/main/container.js";
import type { Container } from "../../src/main/container.js";
import { createMemoryLogger } from "../../src/observability/logger.js";
import type { LogRecord } from "../../src/observability/logger.js";
import type { AuditEvent, Role, SpeechDirective } from "../../src/protocol/index.js";
import { FakeClock } from "../../src/shared/clock.js";
import { newId } from "../../src/shared/ids.js";
import { workerLoopsFor } from "../../src/worker/worker.js";
import type { WorkerLoop } from "../../src/worker/loops.js";

export const JOURNEY_START = "2026-10-18T14:00:00.000Z";
export const LOCALE = "en-US";

export type ToolResultView = {
  status: "SUCCESS" | "PENDING" | "POLICY_DENIED" | "PERMANENT_FAILURE" | "RETRYABLE_FAILURE" | "UNKNOWN_OUTCOME";
  reasonCode?: string | null;
  data?: Record<string, unknown> | null;
  speech: SpeechDirective | null;
  auditEventId: string | null;
  policyDecisionId: string | null;
  sessionGeneration: number;
  turnId: string;
  localFixture: boolean;
  reconciliationRef?: string;
};

/** What the caller heard (or Studio played): template id + the gate-rendered utterance. */
export interface Heard {
  source: "tool" | "studio_prompt" | "studio_template";
  templateId: string;
  utterance: string | null;
}

export interface JourneyHarness {
  c: Container;
  console: LocalConsole;
  clock: FakeClock;
  mcpUrl: URL;
  loops: Map<string, WorkerLoop>;
  /**
   * Every structured log record the container wrote (the memory logger it was built with): backend evidence
   * that is independent of the tool results, e.g. the policy engine's fail-closed line for a fault test.
   */
  logs: readonly LogRecord[];
  /** Runs the named worker loops once each, in order (default: the full delivery pipeline). */
  runWorker(names?: readonly string[], rounds?: number): Promise<void>;
  call(callId?: string): JourneyCall;
  /** Signs and posts a LOCAL FIXTURE transfer event (TC-09). */
  transferEvent(body: { transferId: string; event: string; eventId: string; packageAcknowledged?: boolean }): Promise<{ status: number; body: Record<string, unknown> }>;
  /** Console API as a SYNTHETIC staff member (LOCAL FIXTURE workforce IdP, MFA). */
  consoleRequest(staff: { idpSubject: string }, method: "GET" | "POST", url: string, payload?: unknown, idempotencyKey?: string): Promise<{ status: number; body: Record<string, unknown> }>;
  /** Read-only owner query (evidence only). */
  q<T extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  auditFor(callId: string): Promise<AuditEvent[]>;
  /**
   * Audit chain check over every local stream with the audit module's own verifyChain
   * (recomputed hashes, contiguous sequences, prev-hash links) on rows read in NUMERIC
   * sequence order, plus the chain head. See integrityVerifierFindings for why the
   * IntegrityVerifier itself is not used here.
   */
  expectAuditChainIntact(): Promise<{ streams: number; events: number }>;
  /** IntegrityVerifier.verifyStream findings per stream (known defect: text ordering of sequences). */
  integrityVerifierFindings(): Promise<Record<string, unknown[]>>;
  close(): Promise<void>;
}

const DEFAULT_LOOPS = ["outbox.dispatch", "outbox.consume", "actions.reconcile", "telephony.local_fixture_delivery", "transfers.sweep", "workflows.tick"] as const;

export async function createJourneyHarness(opts: { start?: string; ingestKnowledge?: boolean } = {}): Promise<JourneyHarness> {
  const clock = new FakeClock(opts.start ?? JOURNEY_START);
  const memoryLog = createMemoryLogger();
  const c = await buildContainer({
    environment: "local",
    buildBusiness,
    clock,
    env: {},
    logger: memoryLog.logger,
    rateLimit: null,
    ingestKnowledge: opts.ingestKnowledge ?? true,
    instanceId: "journey-test-1",
  });
  await c.app.listen({ host: "127.0.0.1", port: 0 });
  const addr = c.app.server.address() as AddressInfo;
  expect(addr.address).toBe("127.0.0.1");
  const mcpUrl = new URL(`http://127.0.0.1:${addr.port}/mcp`);
  const consoleApp = await buildLocalConsole(c);
  const built = workerLoopsFor(c);
  const loops = new Map(built.loops.map((l) => [l.name, l] as const));
  const clients: Client[] = [];
  let seq = 0;

  const h: JourneyHarness = {
    c,
    console: consoleApp,
    clock,
    mcpUrl,
    loops,
    logs: memoryLog.records,
    async runWorker(names = DEFAULT_LOOPS, rounds = 1) {
      for (let r = 0; r < rounds; r++) {
        for (const n of names) {
          const loop = loops.get(n);
          if (!loop) throw new Error(`UNKNOWN_LOOP ${n}`);
          await loop.runOnce();
        }
      }
    },
    call(callId) {
      return new JourneyCall(h, clients, callId ?? `cal_synthJourney${String(++seq).padStart(4, "0")}${newId("jr").slice(3, 15)}`);
    },
    async transferEvent(body) {
      const ts = Math.floor(clock.now().getTime() / 1000);
      const res = await c.app.inject({
        method: "POST",
        url: "/v1/webhooks/transfer-events",
        headers: { "x-vsp-fixture-timestamp": String(ts), "x-vsp-fixture-signature": fixtureWebhookSignature(ts, body), "content-type": "application/json" },
        payload: body,
      });
      return { status: res.statusCode, body: res.json() as Record<string, unknown> };
    },
    async consoleRequest(staff, method, url, payload, idempotencyKey) {
      const nowS = Math.floor(clock.now().getTime() / 1000);
      const token = await consoleApp.workforceIdp.issueIdToken({
        issuer: IDP.workforceIssuer,
        sub: staff.idpSubject,
        nonce: newId("non"),
        audience: IDP.consoleAudience,
        amr: ["local_fixture", "mfa"],
        authTime: nowS,
        issuedAt: nowS,
        ttlSeconds: 900,
      });
      const res = await consoleApp.app.inject({
        method,
        url,
        headers: { authorization: `Bearer ${token}`, ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}) },
        ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
      });
      return { status: res.statusCode, body: (res.body.length > 0 ? res.json() : {}) as Record<string, unknown> };
    },
    async q(sql, params = []) {
      return c.db.tx(async (tx) => (await tx.query(sql, params)).rows as never, { role: "owner" });
    },
    async auditFor(callId) {
      return c.auditQuery.search({ tenantId: c.config.tenantId, callId, limit: 200 });
    },
    async expectAuditChainIntact() {
      const heads = await h.q<{ source_stream: string; last_sequence: string; last_hash: string | null }>(
        "select source_stream, last_sequence::text as last_sequence, last_hash from audit_chain_heads order by source_stream",
      );
      let events = 0;
      for (const head of heads) {
        const rows = await h.q<{ event: AuditEvent }>("select o.event from audit_outbox o where o.source_stream = $1 order by o.sequence asc", [head.source_stream]);
        const res = verifyChain(
          rows.map((r) => r.event),
          { sourceStream: head.source_stream, expectedSequence: 1, expectedPrevHash: null },
        );
        expect(res.findings, `audit stream ${head.source_stream}`).toEqual([]);
        expect(res.lastSequence, `head of ${head.source_stream}`).toBe(Number(head.last_sequence));
        expect(res.lastHash).toBe(head.last_hash);
        events += res.checked;
      }
      expect(heads.length).toBeGreaterThan(0);
      return { streams: heads.length, events };
    },
    async integrityVerifierFindings() {
      const verifier = new IntegrityVerifier({ db: c.db, sink: c.auditSink, clock, role: "owner" });
      const out: Record<string, unknown[]> = {};
      for (const s of await verifier.listStreams()) out[s] = (await verifier.verifyStream(s)).findings;
      return out;
    },
    async close() {
      for (const cl of clients) await cl.close().catch(() => undefined);
      for (const closer of built.closers) closer();
      await consoleApp.app.close().catch(() => undefined);
      await c.close();
    },
  };
  return h;
}

export const STAFF_SUPERVISOR = STAFF.supervisor;

const bearer = (channel: keyof typeof LOCAL_FIXTURE_TOKENS) => ({ authorization: `Bearer ${LOCAL_FIXTURE_TOKENS[channel]}` });

/** One SYNTHETIC call: Studio (telephony_control) + conversational layer (MCP) + portal. */
export class JourneyCall {
  sessionRef: string | null = null;
  readonly heard: Heard[] = [];
  readonly results: { tool: string; result: ToolResultView }[] = [];
  private client: Client | null = null;
  private clientRef: string | null = null;
  private idem = 0;

  constructor(
    private readonly h: JourneyHarness,
    private readonly clients: Client[],
    readonly callId: string,
  ) {}

  private get c(): Container {
    return this.h.c;
  }

  private studioHeaders(withSession = true): Record<string, string> {
    return { ...bearer("telephony_control"), "x-vsp-interaction-id": this.callId, ...(withSession && this.sessionRef ? { "x-vsp-session-ref": this.sessionRef } : {}) };
  }

  consent(recording: "GRANTED" | "DECLINED" = "GRANTED") {
    return { recording, automatedProcessing: "GRANTED", disclosureTemplateVersion: "disclosure-local-v1", capturedAt: this.h.clock.now().toISOString(), capturedBy: "studio_flow" };
  }

  async studio(method: "GET" | "POST", url: string, payload?: unknown, withSession = true): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await this.c.app.inject({ method, url, headers: this.studioHeaders(withSession), ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });
    return { status: res.statusCode, body: (res.body.length > 0 ? res.json() : {}) as Record<string, unknown> };
  }

  /** TC-01: Studio starts the call after its deterministic consent capture. */
  async start(recording: "GRANTED" | "DECLINED" = "GRANTED"): Promise<{ sessionRef: string; admission: Record<string, unknown> }> {
    const res = await this.studio("POST", "/telephony/v1/calls", { callId: this.callId, callerIdHash: null, consent: this.consent(recording) }, false);
    expect(res.status, "TC-01").toBe(201);
    this.sessionRef = res.body.sessionRef as string;
    expect(res.body.authGate).toBe(false);
    return { sessionRef: this.sessionRef, admission: res.body.admission as Record<string, unknown> };
  }

  /** TC-03: deterministic role menu. */
  async role(role: Role): Promise<number> {
    const res = await this.studio("POST", "/telephony/v1/session/role", { role });
    expect(res.status, "TC-03").toBe(200);
    return res.body.sessionGeneration as number;
  }

  /** TC-04 Auth Gate (strict boolean). */
  async authGate(): Promise<boolean> {
    const res = await this.studio("GET", "/telephony/v1/session/auth-gate");
    expect(res.status).toBe(200);
    return res.body.isAuthenticated === true;
  }

  private async mcp(): Promise<Client> {
    const key = `${this.sessionRef ?? "none"}`;
    if (this.client && this.clientRef === key) return this.client;
    const headers: Record<string, string> = { ...bearer("mcp_tools"), "x-vsp-interaction-id": this.callId, ...(this.sessionRef ? { "x-vsp-session-ref": this.sessionRef } : {}) };
    const client = new Client({ name: "vsp-journey-test-client", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(this.h.mcpUrl, { requestInit: { headers } }));
    this.clients.push(client);
    this.client = client;
    this.clientRef = key;
    return client;
  }

  /**
   * Tool call through the REAL MCP SDK client (mcp_tools identity, trusted session header).
   * A tool that requires an idempotency key gets a fresh one unless `idempotencyKey` is given.
   */
  async tool(name: string, args: Record<string, unknown>, opts: { idempotencyKey?: string | null } = {}): Promise<ToolResultView> {
    const client = await this.mcp();
    const key = opts.idempotencyKey === undefined ? `idem_synthJourney${String(++this.idem).padStart(3, "0")}${this.callId.slice(-12)}` : opts.idempotencyKey;
    const res = await client.callTool({ name, arguments: args, ...(key ? { _meta: { idempotencyKey: key } } : {}) });
    const result = res.structuredContent as ToolResultView;
    // Explicit local-adapter badge on every result (spec section 16; OPS-04).
    expect(result.localFixture, `${name} LOCAL FIXTURE badge`).toBe(true);
    this.results.push({ tool: name, result });
    if (result.speech) this.heard.push({ source: "tool", templateId: result.speech.templateId, utterance: this.render(result) });
    return result;
  }

  /** Renders a tool result's speech directive through the container's response gate (the before-speech gate). */
  render(result: ToolResultView): string | null {
    const sp = result.speech;
    if (!sp || !this.sessionRef) return null;
    const r = this.c.deps.responseGate.render(sp, {
      sessionRef: this.sessionRef,
      currentTurnId: sp.turnId,
      sessionGeneration: sp.sessionGeneration,
      validAuthorizationRefs: new Set(result.policyDecisionId ? [result.policyDecisionId] : []),
      locale: LOCALE,
      environment: this.c.environment,
    });
    return r.ok ? r.utterance : null;
  }

  /** Studio plays an approved template id it received from a telephony-control answer. */
  studioPlays(templateId: string): void {
    const t = this.c.templates.get(templateId, LOCALE);
    this.heard.push({ source: "studio_template", templateId, utterance: t ? t.text : null });
  }

  /** Secure-link verification: begin_verification over MCP, the SYNTHETIC person approves in the portal with MFA. */
  async verify(person: SyntheticPerson, hint: string, opts: { matchCodeConfirmed?: boolean } = {}): Promise<{ bound: boolean; reasonCode: string; begin: ToolResultView }> {
    const begin = await this.tool("begin_verification", { method: "SECURE_LINK", locator: { kind: "PORTAL_USERNAME_HINT", hint } });
    const channel = person.channels[0]?.channelRef ?? "";
    const msg = this.c.identity.notifications.lastTo(channel);
    const m = msg?.slots.linkPath ? /\/(vtx_[A-Za-z0-9_-]+)#n=([A-Za-z0-9_-]{43})$/.exec(msg.slots.linkPath) : null;
    if (!m || !m[1] || !m[2]) return { bound: false, reasonCode: "NO_LINK_DELIVERED", begin };
    const link = { transactionId: m[1], nonce: m[2] };
    const described = await this.c.app.inject({ method: "POST", url: "/portal/v1/verification/describe", headers: bearer("portal"), payload: link });
    expect(described.statusCode).toBe(200);
    const idToken = await this.c.identity.idp.issueFor(person, { nonce: link.nonce, amr: ["pwd", "mfa"] });
    const approved = await this.c.app.inject({ method: "POST", url: "/portal/v1/verification/approve", headers: bearer("portal"), payload: { ...link, idToken, matchCodeConfirmed: opts.matchCodeConfirmed ?? true } });
    expect(approved.statusCode).toBe(200);
    const body = approved.json() as { bound: boolean; reasonCode: string };
    return { ...body, begin };
  }

  /** TC-07: the gateway-rendered confirmation prompt for the server-side PREPARED action. */
  async pending(): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await this.studio("GET", "/telephony/v1/session/pending-confirmation");
    if (res.status === 200) this.heard.push({ source: "studio_prompt", templateId: res.body.confirmationTemplateId as string, utterance: (res.body.promptText as string | null) ?? null });
    return res;
  }

  /** TC-08: Studio-captured DTMF confirmation bound to digest, generation and the confirmation turn. */
  async confirm(p: Record<string, unknown>, overrides: Partial<{ digest: string; turnId: string; sessionGeneration: number }> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
    return this.studio("POST", `/telephony/v1/session/actions/${p.actionId as string}/confirm`, {
      digest: overrides.digest ?? p.digest,
      sessionGeneration: overrides.sessionGeneration ?? p.sessionGeneration,
      turnId: overrides.turnId ?? p.turnId,
      method: "dtmf_keypress",
      capturedAt: this.h.clock.now().toISOString(),
    });
  }

  /** TC-07 + TC-08 in sequence (expects a confirmed action). */
  async confirmPending(): Promise<Record<string, unknown>> {
    const p = await this.pending();
    expect(p.status, "TC-07 pending confirmation").toBe(200);
    expect(p.body.routeToHuman).toBe(false);
    const confirmed = await this.confirm(p.body);
    expect(confirmed.status, "TC-08").toBe(200);
    expect(confirmed.body.state).toBe("CONFIRMED");
    return p.body;
  }

  async bargeIn(): Promise<{ status: number; body: Record<string, unknown> }> {
    return this.studio("POST", "/telephony/v1/session/barge-in", {});
  }

  /** Early safety screening of a recognized utterance (no authentication required). */
  async screen(text: string, locale = LOCALE, withSession = true): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await this.studio("POST", "/telephony/v1/session/utterance-screening", { callId: this.callId, text, locale, asrConfidence: 0.92 }, withSession);
    if (res.status === 200 && typeof res.body.speechTemplateId === "string") this.studioPlays(res.body.speechTemplateId);
    return res;
  }

  async human(body: { reason: string; language: string; issueCategory: string | null; accommodations?: string[] }, withSession = true): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await this.studio("POST", "/telephony/v1/session/human-request", { callId: this.callId, ...body }, withSession);
    if (res.status === 200 && typeof res.body.speechTemplateId === "string") this.studioPlays(res.body.speechTemplateId);
    return res;
  }

  async handoffContext(): Promise<{ status: number; body: Record<string, unknown> }> {
    return this.studio("GET", "/telephony/v1/session/handoff");
  }

  /** TC-11: call end; the outcome comes from server-side evidence only. */
  async end(reason: "CALLER_HANGUP" | "FLOW_COMPLETED" | "TRANSFERRED" = "FLOW_COMPLETED"): Promise<{ ended: boolean; outcome: string | null; reasonCode: string }> {
    const res = await this.studio("POST", "/telephony/v1/session/end", { reason });
    expect(res.status, "TC-11").toBe(200);
    return res.body as { ended: boolean; outcome: string | null; reasonCode: string };
  }

  /** Every utterance the caller could have heard on this call (tool speech, prompts, Studio templates). */
  utterances(): string[] {
    return this.heard.map((x) => x.utterance ?? "").filter((u) => u.length > 0);
  }
}

/** The current journey (latest attempt) of a call's handoff. */
export async function journeyOf(h: JourneyHarness, handoffId: string) {
  const j = await h.c.transfers.get(handoffId);
  expect(j, "transfer journey").not.toBeNull();
  return j as NonNullable<typeof j>;
}

export const AVERY = PEOPLE.avery;
export const RILEY = PEOPLE.riley;
export const QUINN = PEOPLE.quinn;
