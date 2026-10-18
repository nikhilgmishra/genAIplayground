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

export const MCP_PATH = "/mcp";
export const MCP_SERVER_NAME = "vsp-gateway";

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

function webRequestFrom(req: FastifyRequest): Request {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === "string") headers.set(k, v);
    else if (Array.isArray(v)) headers.set(k, v.join(", "));
  }
  // Only the path is meaningful to the transport; the host is fixed (never echoed from the request).
  return new Request(`http://gateway.internal${MCP_PATH}`, { method: req.method, headers, body: req.method === "POST" ? JSON.stringify(req.body ?? null) : null });
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
    summary: "MCP Streamable HTTP endpoint (stateless, JSON responses): initialize, tools/list (pinned catalogue), tools/call (trusted tool pipeline).",
    tags: ["mcp"],
    headers: TRUSTED_TOOL_HEADERS,
    body: z.unknown() as z.ZodType<unknown>,
    validateResponse: false,
    responses: {
      200: { description: "JSON-RPC response", schema: null },
      202: { description: "Notification accepted", schema: null },
      400: { description: "Malformed JSON-RPC", schema: null },
      401: { description: "Missing or invalid integration credential", schema: null },
      403: { description: "Credential not allowed for the mcp_tools channel", schema: null },
      406: { description: "Accept must include application/json and text/event-stream", schema: null },
      415: { description: "Content-Type must be application/json", schema: null },
    },
    handler: async (ctx) => {
      const integration = ctx.integration as IntegrationIdentity;
      const server = createMcpServer(deps, integration, ctx.raw);
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      try {
        await server.connect(transport);
        const response = await transport.handleRequest(webRequestFrom(ctx.raw), { parsedBody: ctx.raw.body });
        const text = await response.text();
        const headers: Record<string, string> = {};
        const ct = response.headers.get("content-type");
        if (ct) headers["content-type"] = ct;
        return { status: response.status, headers, body: text.length > 0 ? text : null };
      } finally {
        await transport.close().catch(() => undefined);
        await server.close().catch(() => undefined);
      }
    },
  });
  return [post, notAllowed("GET"), notAllowed("DELETE")] as RouteDef<unknown, unknown>[];
}
