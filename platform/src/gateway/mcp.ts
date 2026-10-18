/**
 * Thin MCP adapter: Streamable HTTP, stateless, JSON responses (talkdesk/mcp-connection.md;
 * spec section 2: "MCP is an integration protocol, not a security guarantee").
 *
 * - POST /mcp: the integration credential (channel mcp_tools) is authenticated by
 *   the route BEFORE the SDK sees the request. A fresh low-level SDK `Server` and
 *   `WebStandardStreamableHTTPServerTransport` (sessionIdGenerator undefined =
 *   stateless) handle exactly one HTTP request; no MCP transport session exists,
 *   so `Mcp-Session-Id` is never authority and never resolves an AuthContext.
 * - tools/list serves exactly the pinned catalogue (name, description, input
 *   JSON Schema, version and catalogue digest in `_meta`); nothing can be
 *   registered at runtime. No resources, prompts, sampling or logging capability.
 * - tools/call maps the name to its single pinned version and goes through the
 *   ToolPipeline. The caller session comes ONLY from the trusted transport
 *   binding headers (X-VSP-Session-Ref / X-VSP-Interaction-Id), never from MCP
 *   arguments or `_meta`. The ToolResult is returned as structured content.
 * - GET and DELETE /mcp answer 405 (no server-initiated stream, no sessions),
 *   matching the SDK's stateless pattern.
 * - Rate limiting per message, classified first (SAFE-02/SAFE-03; SAFE-HANDOFF-03,
 *   VSP-GW-01, VSP-GW-03): a tools/call of a SAFETY_AND_HUMAN_ROUTE tool is never
 *   throttled; every other message (tools/call, initialize, tools/list, notifications)
 *   takes a token from its call's bucket and the integration ceiling. A single
 *   throttled message answers HTTP 429 RATE_LIMITED. A JSON-RPC batch (accepted for
 *   older protocol revisions) holds at most MCP_MAX_BATCH_MESSAGES messages, each one
 *   counted on its own; they are dispatched one at a time (safety and human-route
 *   calls first) and a throttled message gets its own JSON-RPC error while the rest
 *   still run.
 */
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { IntegrationIdentity } from "../protocol/index.js";
import type { Logger } from "../observability/ports.js";
import type { PinnedCatalog } from "./catalog.js";
import type { ToolPipeline } from "./pipeline.js";
import { IDEMPOTENCY_KEY_HEADER, INTERACTION_ID_HEADER, SESSION_REF_HEADER, TURN_ID_HEADER } from "./session-binding.js";
import { defineRoute } from "./http/route.js";
import type { RouteDef } from "./http/route.js";
import { TRUSTED_TOOL_HEADERS } from "./http/tool-routes.js";
import { admitToolUnit, isSafetyRouteTool, rateLimitHeaders } from "./http/tool-rate-limit.js";
import type { RateDecision } from "./http/tool-rate-limit.js";
import { errorBody } from "./http/route.js";

export const MCP_PATH = "/mcp";
export const MCP_SERVER_NAME = "vsp-gateway";
/** Largest JSON-RPC batch accepted in one HTTP request (each message is counted and dispatched on its own). */
export const MCP_MAX_BATCH_MESSAGES = 10;
/** JSON-RPC error code for a throttled message inside a batch (server-defined range). */
export const MCP_RATE_LIMITED_CODE = -32029;

const JsonRpcError = z.strictObject({ jsonrpc: z.literal("2.0"), error: z.strictObject({ code: z.number().int(), message: z.string().max(200) }), id: z.null() });

export interface McpAdapterDeps {
  pipeline: ToolPipeline;
  catalog: PinnedCatalog;
  logger: Logger;
}

/** The MCP Tool list derived from the pinned catalogue (exactly these, no dynamic registration). */
export function mcpToolList(catalog: PinnedCatalog): { name: string; description: string; inputSchema: Record<string, unknown>; annotations: Record<string, boolean>; _meta: Record<string, string> }[] {
  return catalog.definitions.map((d) => ({
    name: d.name,
    description: d.description,
    inputSchema: d.inputSchema,
    annotations: {
      readOnlyHint: d.safetyClass === "PUBLIC_READ" || d.safetyClass === "PROTECTED_READ",
      destructiveHint: false,
      idempotentHint: d.idempotency !== "IDEMPOTENCY_KEY_REQUIRED" || d.consequential === false,
      openWorldHint: false,
    },
    _meta: { "vsp/toolVersion": d.version, "vsp/catalogDigest": catalog.digest, "vsp/safetyClass": d.safetyClass },
  }));
}

function headerOf(req: FastifyRequest, name: string): string | null {
  const v = req.headers[name];
  return typeof v === "string" ? v : null;
}

/** Builds the per-request MCP server bound to one authenticated integration and one HTTP request's trusted headers. */
export function createMcpServer(deps: McpAdapterDeps, integration: IntegrationIdentity, req: FastifyRequest): Server {
  const server = new Server({ name: MCP_SERVER_NAME, version: deps.catalog.manifest.catalogVersion }, { capabilities: { tools: { listChanged: false } } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: mcpToolList(deps.catalog) }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const meta = (request.params as { _meta?: Record<string, unknown> })._meta;
    const metaKey = meta && typeof meta.idempotencyKey === "string" ? meta.idempotencyKey : null;
    const result = await deps.pipeline.invoke(
      {
        name: request.params.name,
        version: null,
        arguments: request.params.arguments ?? {},
        turnId: headerOf(req, TURN_ID_HEADER),
        idempotencyKey: headerOf(req, IDEMPOTENCY_KEY_HEADER) ?? metaKey,
        locale: null,
      },
      integration,
      { kind: "mcp", sessionRefHeader: headerOf(req, SESSION_REF_HEADER), interactionIdHeader: headerOf(req, INTERACTION_ID_HEADER) },
    );
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
      structuredContent: result as unknown as Record<string, unknown>,
      isError: !(result.status === "SUCCESS" || result.status === "PENDING"),
    };
  });
  server.onerror = () => {
    deps.logger.warn("gateway.mcp.protocol_error", { reasonCode: "MCP_PROTOCOL_ERROR" });
  };
  return server;
}

function webRequestFrom(req: FastifyRequest, body: unknown): Request {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === "string") headers.set(k, v);
    else if (Array.isArray(v)) headers.set(k, v.join(", "));
  }
  // Only the path is meaningful to the transport; the host is fixed (never echoed from the request).
  return new Request(`http://gateway.internal${MCP_PATH}`, { method: req.method, headers, body: req.method === "POST" ? JSON.stringify(body ?? null) : null });
}

/** The tool name of a tools/call message, null for any other message (classification input only). */
function toolNameOf(message: unknown): string | null {
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  const m = message as { method?: unknown; params?: { name?: unknown } };
  return m.method === "tools/call" && m.params && typeof m.params.name === "string" ? m.params.name : null;
}

function idOf(message: unknown): string | number | null {
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  const id = (message as { id?: unknown }).id;
  return typeof id === "string" || typeof id === "number" ? id : null;
}

/** One JSON-RPC message through a fresh stateless server + transport (the SDK transport is single-use). */
async function handleOne(deps: McpAdapterDeps, integration: IntegrationIdentity, req: FastifyRequest, message: unknown): Promise<{ status: number; contentType: string | null; text: string }> {
  const server = createMcpServer(deps, integration, req);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  try {
    await server.connect(transport);
    const response = await transport.handleRequest(webRequestFrom(req, message), { parsedBody: message });
    return { status: response.status, contentType: response.headers.get("content-type"), text: await response.text() };
  } finally {
    await transport.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}

/** Most restrictive metered decision of a request (for the response headers). */
function headerDecision(decisions: readonly RateDecision[]): Record<string, string> {
  const metered = decisions.filter((d): d is Exclude<RateDecision, { exempt: true }> => !d.exempt);
  const worst = metered.reduce<Exclude<RateDecision, { exempt: true }> | null>((acc, d) => (acc === null || d.remaining < acc.remaining ? d : acc), null);
  return worst ? rateLimitHeaders(worst) : {};
}

export function mcpRoutes(deps: McpAdapterDeps): RouteDef<unknown, unknown>[] {
  const notAllowed = (method: "GET" | "DELETE") =>
    defineRoute({
      operationId: `mcp.${method.toLowerCase()}NotAllowed`,
      method,
      path: MCP_PATH,
      channel: null,
      summary: "Stateless Streamable HTTP: no server-initiated stream and no MCP sessions (405).",
      tags: ["mcp"],
      rateLimitExempt: true,
      responses: { 405: { description: "Method not allowed", schema: JsonRpcError } },
      handler: async () => ({ status: 405, headers: { allow: "POST" }, body: { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null } }),
    });
  const post = defineRoute({
    operationId: "mcp.post",
    method: "POST",
    path: MCP_PATH,
    channel: "mcp_tools",
    summary:
      "MCP Streamable HTTP endpoint (stateless, JSON responses): initialize, tools/list (pinned catalogue), tools/call (trusted tool pipeline). Rate limited per JSON-RPC message, per call and per integration, except SAFETY_AND_HUMAN_ROUTE tool calls, which are never throttled; batches hold at most 10 messages.",
    tags: ["mcp"],
    headers: TRUSTED_TOOL_HEADERS,
    body: z.unknown() as z.ZodType<unknown>,
    validateResponse: false,
    responses: {
      200: { description: "JSON-RPC response", schema: null },
      202: { description: "Notification accepted", schema: null },
      400: { description: "Malformed JSON-RPC, empty batch or batch larger than 10 messages", schema: null },
      401: { description: "Missing or invalid integration credential", schema: null },
      403: { description: "Credential not allowed for the mcp_tools channel", schema: null },
      406: { description: "Accept must include application/json and text/event-stream", schema: null },
      415: { description: "Content-Type must be application/json", schema: null },
    },
    handler: async (ctx) => {
      const integration = ctx.integration as IntegrationIdentity;
      const body = ctx.raw.body;
      const trusted = { interactionId: headerOf(ctx.raw, INTERACTION_ID_HEADER), sessionRef: headerOf(ctx.raw, SESSION_REF_HEADER) };
      const rpcError = (status: number, code: number, message: string) => ({ status, headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }) });

      if (!Array.isArray(body)) {
        // Classified before any limit: a safety or human-route tools/call is never throttled.
        const admission = admitToolUnit(ctx.raw, integration, isSafetyRouteTool(deps.catalog, toolNameOf(body)), trusted);
        if (!admission.allowed) return { status: 429, headers: { ...rateLimitHeaders(admission), "content-type": "application/json" }, body: JSON.stringify(errorBody("RATE_LIMITED", ctx.requestId)) };
        const r = await handleOne(deps, integration, ctx.raw, body);
        const headers: Record<string, string> = { ...rateLimitHeaders(admission) };
        if (r.contentType) headers["content-type"] = r.contentType;
        return { status: r.status, headers, body: r.text.length > 0 ? r.text : null };
      }

      // JSON-RPC batch (older protocol revisions): bounded, counted per message, dispatched one at a time.
      if (body.length === 0) return rpcError(400, -32600, "Invalid Request: empty batch.");
      if (body.length > MCP_MAX_BATCH_MESSAGES) {
        deps.logger.warn("gateway.mcp.batch_refused", { reasonCode: "MCP_BATCH_TOO_LARGE", requestId: ctx.requestId });
        return rpcError(400, -32600, "Invalid Request: batch too large.");
      }
      // Safety and human-route calls first (classified from the pinned catalogue), then the rest in order.
      const order = body
        .map((m, i) => ({ m, i, safety: isSafetyRouteTool(deps.catalog, toolNameOf(m)) }))
        .sort((a, b) => Number(b.safety) - Number(a.safety) || a.i - b.i);
      const decisions: RateDecision[] = [];
      const out: { i: number; responses: unknown[] }[] = [];
      for (const { m, i, safety } of order) {
        const admission = admitToolUnit(ctx.raw, integration, safety, trusted);
        decisions.push(admission);
        if (!admission.allowed) {
          const id = idOf(m);
          if (id !== null) out.push({ i, responses: [{ jsonrpc: "2.0", id, error: { code: MCP_RATE_LIMITED_CODE, message: "Rate limited." } }] });
          continue;
        }
        const r = await handleOne(deps, integration, ctx.raw, m);
        // Header-level refusals (Accept, Content-Type, size) apply to the whole HTTP request.
        if (r.status === 406 || r.status === 415 || r.status === 413) return { status: r.status, headers: r.contentType ? { "content-type": r.contentType } : {}, body: r.text.length > 0 ? r.text : null };
        if (r.text.length === 0) continue; // notification or response: nothing to return
        try {
          const parsed = JSON.parse(r.text) as unknown;
          out.push({ i, responses: Array.isArray(parsed) ? parsed : [parsed] });
        } catch {
          out.push({ i, responses: [{ jsonrpc: "2.0", id: idOf(m), error: { code: -32603, message: "Internal error." } }] });
        }
      }
      const responses = out.sort((a, b) => a.i - b.i).flatMap((x) => x.responses);
      const headers = headerDecision(decisions);
      if (responses.length === 0) return { status: 202, headers, body: null };
      return { status: 200, headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(responses) };
    },
  });
  return [post, notAllowed("GET"), notAllowed("DELETE")] as RouteDef<unknown, unknown>[];
}
