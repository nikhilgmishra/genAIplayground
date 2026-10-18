/**
 * Deterministic HTTP tool route (same ToolPipeline as MCP) and the pinned
 * catalogue read (spec section 8: "Expose narrowly scoped operations ... pin and
 * hash the tool catalogue"). Identity: mcp_tools.
 *
 * The session reference travels only in the trusted X-VSP-Session-Ref header
 * (or the interaction id in X-VSP-Interaction-Id, per sessionBinding.mode);
 * the idempotency key in Idempotency-Key. The response is always a validated
 * ToolResult (HTTP 200) whose `status` carries the outcome.
 */
import { z } from "zod";
import { ToolCatalogManifest, ToolDefinition, ToolResult } from "../../protocol/index.js";
import type { PinnedCatalog } from "../catalog.js";
import { HttpToolCallBody } from "../pipeline.js";
import type { ToolPipeline } from "../pipeline.js";
import { IDEMPOTENCY_KEY_HEADER, INTERACTION_ID_HEADER, SESSION_REF_HEADER, TURN_ID_HEADER } from "../session-binding.js";
import { AUTH_ERRORS, defineRoute } from "./route.js";
import type { RouteDef } from "./route.js";

export const CatalogResponse = z.strictObject({ manifest: ToolCatalogManifest, definitions: z.array(ToolDefinition) });

const ToolParams = z.strictObject({
  name: z.string().min(1).max(64),
  version: z.string().min(1).max(32),
});

export const TRUSTED_TOOL_HEADERS = [
  { name: "X-VSP-Session-Ref", required: false, description: "Opaque session reference injected by the trusted transport (sessionBinding.mode trusted_header). Never a tool argument." },
  { name: "X-VSP-Interaction-Id", required: false, description: "Vendor interaction id (identifier only, never authority). Used by server_to_server_lookup and to bind the session to the current call." },
  { name: "X-VSP-Turn-Id", required: false, description: "Turn id from the trusted transport; minted server-side when absent." },
  { name: "Idempotency-Key", required: false, description: "Required for IDEMPOTENCY_KEY_REQUIRED tools: same key + same request returns the stored result." },
];

export function toolRoutes(deps: { pipeline: ToolPipeline; catalog: PinnedCatalog }): RouteDef<unknown, unknown>[] {
  const catalog = defineRoute({
    operationId: "tools.catalog",
    method: "GET",
    path: "/v1/tools/catalog",
    channel: "mcp_tools",
    summary: "Pinned tool catalogue (definitions and sha256 digest). Tools cannot be added at runtime.",
    tags: ["tools"],
    responses: { 200: { description: "Pinned catalogue", schema: CatalogResponse }, ...AUTH_ERRORS },
    handler: async () => ({ status: 200, body: { manifest: deps.catalog.manifest, definitions: [...deps.catalog.definitions] } }),
  });

  const invoke = defineRoute({
    operationId: "tools.invoke",
    method: "POST",
    path: "/v1/tools/:name/:version",
    channel: "mcp_tools",
    summary: "Invoke one pinned tool version through the trusted tool pipeline (deterministic alternative to MCP tools/call).",
    tags: ["tools"],
    headers: TRUSTED_TOOL_HEADERS,
    params: ToolParams,
    body: HttpToolCallBody,
    // A tool result is always returned with HTTP 200; its status is the outcome.
    responses: { 200: { description: "ToolResult (status distinguishes success, retryable, permanent, policy denial, pending and unknown outcome)", schema: ToolResult }, ...AUTH_ERRORS },
    handler: async (ctx) => {
      const integration = ctx.integration;
      if (!integration) return { status: 401, body: undefined };
      const result = await deps.pipeline.invoke(
        {
          name: ctx.params.name,
          version: ctx.params.version,
          arguments: ctx.body.arguments,
          turnId: ctx.body.turnId ?? ctx.header(TURN_ID_HEADER),
          idempotencyKey: ctx.header(IDEMPOTENCY_KEY_HEADER),
          locale: ctx.body.locale ?? null,
        },
        integration,
        { kind: "http", sessionRefHeader: ctx.header(SESSION_REF_HEADER), interactionIdHeader: ctx.header(INTERACTION_ID_HEADER) },
      );
      return { status: 200, body: result };
    },
  });
  return [catalog, invoke] as RouteDef<unknown, unknown>[];
}
