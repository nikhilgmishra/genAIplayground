/**
 * MCP adapter integration test with the REAL MCP SDK client (Client +
 * StreamableHTTPClientTransport) against the gateway listening on 127.0.0.1
 * only (ephemeral port; no external network). LOCAL FIXTURE integration tokens,
 * SYNTHETIC calls; real policy bundle, PGlite, identity and audit.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { CALLS } from "../fixtures/synthetic-world.js";
import { LOCAL_FIXTURE_TOKENS } from "./auth.js";
import { createAppHarness } from "./fixtures/app-harness.fixture.js";
import type { AppHarness } from "./fixtures/app-harness.fixture.js";
import { MCP_MAX_BATCH_MESSAGES, MCP_RATE_LIMITED_CODE, MCP_SERVER_NAME } from "./mcp.js";

let h: AppHarness;
let base: URL;

beforeAll(async () => {
  h = await createAppHarness();
  await h.app.listen({ host: "127.0.0.1", port: 0 });
  const addr = h.app.server.address() as AddressInfo;
  expect(addr.address).toBe("127.0.0.1");
  base = new URL(`http://127.0.0.1:${addr.port}/mcp`);
}, 60_000);

afterAll(async () => {
  await h?.close();
});

const clients: Client[] = [];
afterAll(async () => {
  for (const c of clients) await c.close().catch(() => undefined);
});

async function connect(headers: Record<string, string>): Promise<Client> {
  const client = new Client({ name: "vsp-mcp-test-client", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(base, { requestInit: { headers } });
  await client.connect(transport);
  clients.push(client);
  return client;
}

const mcpAuth = { authorization: `Bearer ${LOCAL_FIXTURE_TOKENS.mcp_tools}` };

type Structured = { status: string; reasonCode: string | null; data: Record<string, unknown> | null; tool: { name: string; version: string } };

describe("MCP Streamable HTTP adapter (real SDK client over 127.0.0.1)", () => {
  it("[SPEC-8.mcp][OPS-06] initialize + tools/list serve exactly the pinned catalogue with strict input schemas, versions and the digest", async () => {
    const client = await connect(mcpAuth);
    expect(client.getServerVersion()?.name).toBe(MCP_SERVER_NAME);
    expect(client.getServerCapabilities()?.tools).toBeDefined();
    expect(client.getServerCapabilities()?.resources).toBeUndefined();
    expect(client.getServerCapabilities()?.prompts).toBeUndefined();
    const listed = await client.listTools();
    expect(listed.tools.map((t) => t.name).sort()).toEqual([...h.catalog.names()].sort());
    for (const t of listed.tools) {
      const def = h.catalog.get(t.name, h.catalog.pinnedVersion(t.name) ?? "")?.definition;
      expect(def).not.toBeNull();
      expect(t.inputSchema).toEqual(def?.inputSchema);
      expect((t.inputSchema as { additionalProperties?: unknown }).additionalProperties).toBe(false);
      expect(t._meta).toMatchObject({ "vsp/toolVersion": def?.version, "vsp/catalogDigest": h.catalog.digest });
    }
  });

  it("[SPEC-8.tool-pipeline][AUTH-03] tools/call runs the trusted pipeline; the session comes only from the trusted header, never from arguments or _meta", async () => {
    const { sessionRef } = await h.startCall(CALLS.primary.callId);
    const client = await connect({ ...mcpAuth, "x-vsp-session-ref": sessionRef, "x-vsp-turn-id": "turn_mcpTurn0001" });
    const ok = await client.callTool({ name: "fixture_public_faq", arguments: { topic: "portal_login" } });
    const okResult = ok.structuredContent as Structured;
    expect(ok.isError).toBe(false);
    expect(okResult).toMatchObject({ status: "SUCCESS", tool: { name: "fixture_public_faq", version: "1.0.0" } });

    const forged = await client.callTool({ name: "fixture_public_faq", arguments: { topic: "portal_login", sessionRef } });
    expect(forged.isError).toBe(true);
    expect((forged.structuredContent as Structured).reasonCode).toBe("IDENTITY_FIELD_IN_ARGUMENTS");

    // A0 session: the protected read is denied by policy, not by the adapter.
    const denied = await client.callTool({ name: "fixture_get_appointments", arguments: {} });
    expect(denied.isError).toBe(true);
    expect((denied.structuredContent as Structured).status).toBe("POLICY_DENIED");

    // Without the trusted header a session ref in _meta is ignored entirely.
    const noHeader = await connect(mcpAuth);
    const metaOnly = await noHeader.callTool({ name: "fixture_public_faq", arguments: { topic: "portal_login" }, _meta: { sessionRef, "x-vsp-session-ref": sessionRef } });
    expect(metaOnly.isError).toBe(true);
    expect((metaOnly.structuredContent as Structured).reasonCode).toBe("SESSION_REF_MISSING");

    const unknown = await client.callTool({ name: "fixture_not_in_catalogue", arguments: {} });
    expect(unknown.isError).toBe(true);
    expect((unknown.structuredContent as Structured).reasonCode).toBe("UNKNOWN_TOOL_VERSION");

    const rows = await h.auditRows();
    const invokes = rows.filter((r) => r.action === "tool.invoke");
    expect(invokes.length).toBeGreaterThanOrEqual(4);
    expect(JSON.stringify(rows)).not.toContain(sessionRef);
  });

  it("[SAFE-02] a human request over MCP succeeds with no session at all (sessionless safety/human route)", async () => {
    const client = await connect({ ...mcpAuth, "x-vsp-interaction-id": CALLS.concurrent.callId });
    const res = await client.callTool({ name: "fixture_request_human", arguments: { reason: "CALLER_REQUESTED_HUMAN", language: "en" } });
    const body = res.structuredContent as Structured;
    expect(body.status).toBe("PENDING");
    expect(body.data).toMatchObject({ destinationPurpose: "STANDARD_SUPPORT" });
    expect(h.faults.lastCallId).toBe(CALLS.concurrent.callId);
  });

  it("[SPEC-8.service-identity] the integration credential is checked before the SDK sees the request; wrong channel and missing tokens are refused", async () => {
    await expect(connect({})).rejects.toThrow();
    await expect(connect({ authorization: `Bearer ${LOCAL_FIXTURE_TOKENS.telephony_control}` })).rejects.toThrow();
    const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } } };
    const raw = await fetch(base, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(init) });
    expect(raw.status).toBe(401);
    expect(await raw.json()).toEqual({ error: { reasonCode: "INTEGRATION_CREDENTIAL_MISSING", requestId: expect.stringMatching(/^req_/) } });
    const wrong = await fetch(base, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${LOCAL_FIXTURE_TOKENS.portal}` }, body: JSON.stringify(init) });
    expect(wrong.status).toBe(403);
  });

  it("[SPEC-8.mcp] stateless: no Mcp-Session-Id is issued, a caller-supplied one is not authority, GET/DELETE answer 405", async () => {
    const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } } };
    const headers = { ...mcpAuth, "content-type": "application/json", accept: "application/json, text/event-stream" };
    const res = await fetch(base, { method: "POST", headers, body: JSON.stringify(init) });
    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBeNull();
    const call = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "fixture_public_faq", arguments: { topic: "portal_login" } } };
    const forged = await fetch(base, { method: "POST", headers: { ...headers, "mcp-session-id": "forged-session-0001" }, body: JSON.stringify(call) });
    const forgedBody = (await forged.json()) as { result: { structuredContent: Structured } };
    expect(forgedBody.result.structuredContent.reasonCode).toBe("SESSION_REF_MISSING");
    for (const method of ["GET", "DELETE"]) {
      const r = await fetch(base, { method, headers: mcpAuth });
      expect(r.status).toBe(405);
      expect(r.headers.get("allow")).toBe("POST");
    }
  });
});

describe("MCP rate limiting per JSON-RPC message (SAFE-HANDOFF-03, VSP-GW-01, VSP-GW-03)", () => {
  let r: AppHarness;
  const tel = { authorization: `Bearer ${LOCAL_FIXTURE_TOKENS.telephony_control}` };
  const rpcHeaders = (extra: Record<string, string> = {}) => ({ ...mcpAuth, "content-type": "application/json", accept: "application/json, text/event-stream", ...extra });
  const call = (id: number, name: string, args: Record<string, unknown>) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const faq = (id: number) => call(id, "fixture_public_faq", { topic: "portal_login" });
  const human = (id: number) => call(id, "fixture_request_human", { reason: "CALLER_REQUESTED_HUMAN", language: "en" });
  const post = (payload: unknown, extra: Record<string, string> = {}) => r.app.inject({ method: "POST", url: "/mcp", headers: rpcHeaders(extra), payload: JSON.stringify(payload) });
  const invokes = async () => (await r.auditRows()).filter((x) => x.action === "tool.invoke").length;
  async function startCall(callId: string): Promise<string> {
    const res = await r.app.inject({
      method: "POST",
      url: "/telephony/v1/calls",
      headers: tel,
      payload: { callId, callerIdHash: null, consent: { recording: "GRANTED", automatedProcessing: "GRANTED", disclosureTemplateVersion: "disclosure-local-v1", capturedAt: r.identity.clock.now().toISOString(), capturedBy: "studio_flow" } },
    });
    expect(res.statusCode).toBe(201);
    return (res.json() as { sessionRef: string }).sessionRef;
  }

  afterEach(async () => {
    await r?.close();
  });

  it("[SAFE-02][SAFE-03][SAFE-HANDOFF-03][VSP-GW-01] with the budget spent by another call, tools/call of a SAFETY_AND_HUMAN_ROUTE tool still runs; routine messages get 429", async () => {
    r = await createAppHarness({ rateLimit: { max: 3, timeWindowMs: 60_000 } });
    const x = CALLS.primary.callId;
    const ses = await startCall(x);
    for (let i = 0; i < 3; i++) expect((await post(faq(i + 1), { "x-vsp-session-ref": ses, "x-vsp-interaction-id": x })).statusCode).toBe(200);
    const y = CALLS.concurrent.callId;
    const routine = await post(faq(9), { "x-vsp-interaction-id": y });
    expect(routine.statusCode).toBe(429);
    expect(routine.json()).toMatchObject({ error: { reasonCode: "RATE_LIMITED" } });
    expect((await post({ jsonrpc: "2.0", id: 10, method: "tools/list" }, { "x-vsp-interaction-id": y })).statusCode).toBe(429);
    for (let i = 0; i < 4; i++) {
      const res = await post(human(20 + i), { "x-vsp-interaction-id": y });
      expect(res.statusCode).toBe(200);
      expect((JSON.parse(res.body) as { result: { structuredContent: { status: string } } }).result.structuredContent.status).toBe("PENDING");
    }
    expect(r.faults.lastCallId).toBe(y);
  });

  it("[SPEC-14.dos][VSP-GW-03] a JSON-RPC batch is counted per message: with 2 tokens left, 2 messages run and 3 get their own rate-limit error", async () => {
    r = await createAppHarness({ rateLimit: { max: 2, timeWindowMs: 60_000 } });
    const x = CALLS.primary.callId;
    const ses = await startCall(x);
    const before = await invokes();
    const res = await post([faq(1), faq(2), faq(3), faq(4), faq(5)], { "x-vsp-session-ref": ses, "x-vsp-interaction-id": x });
    expect(res.statusCode).toBe(200);
    const out = JSON.parse(res.body) as { id: number; result?: { structuredContent?: { status: string } }; error?: { code: number } }[];
    expect(out.map((m) => m.id)).toEqual([1, 2, 3, 4, 5]);
    expect(out.filter((m) => m.result?.structuredContent?.status === "SUCCESS")).toHaveLength(2);
    expect(out.filter((m) => m.error?.code === MCP_RATE_LIMITED_CODE)).toHaveLength(3);
    expect((await invokes()) - before).toBe(2);
    expect(res.headers["x-ratelimit-remaining"]).toBe("0");
  });

  it("[SAFE-03][VSP-GW-03] a safety or human-route call inside a batch runs first and is never throttled, even with no tokens left", async () => {
    r = await createAppHarness({ rateLimit: { max: 1, timeWindowMs: 60_000 } });
    const x = CALLS.primary.callId;
    const ses = await startCall(x);
    expect((await post(faq(1), { "x-vsp-session-ref": ses, "x-vsp-interaction-id": x })).statusCode).toBe(200);
    const res = await post([faq(2), faq(3), human(4)], { "x-vsp-session-ref": ses, "x-vsp-interaction-id": x });
    expect(res.statusCode).toBe(200);
    const out = JSON.parse(res.body) as { id: number; result?: { structuredContent?: { status: string } }; error?: { code: number } }[];
    expect(out.find((m) => m.id === 4)?.result?.structuredContent?.status).toBe("PENDING");
    expect(out.filter((m) => m.error?.code === MCP_RATE_LIMITED_CODE).map((m) => m.id)).toEqual([2, 3]);
  });

  it("[SPEC-14.dos][VSP-GW-03] a batch above MCP_MAX_BATCH_MESSAGES (or an empty batch) is refused with -32600 before any tool runs", async () => {
    r = await createAppHarness({ rateLimit: null });
    const before = await invokes();
    const big = await post(Array.from({ length: MCP_MAX_BATCH_MESSAGES + 1 }, (_, i) => faq(i + 1)), { "x-vsp-interaction-id": CALLS.primary.callId });
    expect(big.statusCode).toBe(400);
    expect(JSON.parse(big.body)).toMatchObject({ jsonrpc: "2.0", error: { code: -32600 }, id: null });
    const empty = await post([], { "x-vsp-interaction-id": CALLS.primary.callId });
    expect(empty.statusCode).toBe(400);
    expect((await invokes()) - before).toBe(0);
    // Without a limiter a small batch still runs one message at a time and answers every request id.
    const ok = await post([human(1), human(2)], { "x-vsp-interaction-id": CALLS.primary.callId });
    expect((JSON.parse(ok.body) as { id: number }[]).map((m) => m.id)).toEqual([1, 2]);
  });
});
