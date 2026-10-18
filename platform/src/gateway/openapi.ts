/**
 * OpenAPI 3.1 document for the gateway HTTP surface, generated from the same
 * RouteDef specs (paths, channels, strict zod schemas) that Fastify registers,
 * so the document cannot drift from the running routes. Committed at
 * schemas/openapi/gateway.openapi.json; `generate-openapi.ts --check` fails on drift.
 *
 * The document describes this gateway only. It names no vendor endpoint and no
 * production server: the only server entry is the LOCAL FIXTURE loopback.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ErrorBody } from "./http/route.js";
import type { RouteDef } from "./http/route.js";
import { healthRoutes } from "./http/health-routes.js";
import type { ReadinessProbe } from "./http/health-routes.js";
import { portalRoutes } from "./http/portal-routes.js";
import type { PortalRouteDeps } from "./http/portal-routes.js";
import { telephonyRoutes } from "./http/telephony-routes.js";
import type { TelephonyRouteDeps } from "./http/telephony-routes.js";
import { toolRoutes } from "./http/tool-routes.js";
import { webhookRoutes } from "./http/webhook-routes.js";
import type { WebhookRouteDeps } from "./http/webhook-routes.js";
import { mcpRoutes } from "./mcp.js";
import type { McpAdapterDeps } from "./mcp.js";
import type { PinnedCatalog } from "./catalog.js";
import type { ToolPipeline } from "./pipeline.js";

const here = dirname(fileURLToPath(import.meta.url));
export const OPENAPI_FILE = resolve(here, "../../..", "schemas/openapi/gateway.openapi.json");

/** Version of the gateway HTTP contract (bumped on any route/schema change). */
export const GATEWAY_API_VERSION = "2026-10-18.1";

type Json = Record<string, unknown>;

/**
 * Spec-only dependencies: route factories only capture their deps in handler
 * closures (telephony reads the destination list for its fallbacks), so the
 * generator builds the route specs with these placeholders and NEVER invokes a
 * handler. Any handler call would fail on the missing dependency (fail closed).
 */
function specOnly<T>(overrides: Partial<Record<keyof T, unknown>> = {}): T {
  return new Proxy(overrides as object, {
    get: (target, key) => (key in target ? (target as Record<string | symbol, unknown>)[key] : undefined),
  }) as T;
}

/** Every gateway route definition (spec only; handlers never run). */
export function gatewayRouteSpecs(): RouteDef<unknown, unknown>[] {
  return [
    ...healthRoutes(specOnly<ReadinessProbe>()),
    ...toolRoutes({ pipeline: specOnly<ToolPipeline>(), catalog: specOnly<PinnedCatalog>() }),
    ...mcpRoutes(specOnly<McpAdapterDeps>()),
    ...telephonyRoutes(specOnly<TelephonyRouteDeps>({ destinations: [] })),
    ...portalRoutes(specOnly<PortalRouteDeps>()),
    ...webhookRoutes(specOnly<WebhookRouteDeps>({ environment: "local", fixtureKey: null })),
  ];
}

function stripSchemaKeyword(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripSchemaKeyword);
  if (typeof node !== "object" || node === null) return node;
  const out: Json = {};
  for (const [k, v] of Object.entries(node as Json)) {
    if (k === "$schema") continue;
    out[k] = stripSchemaKeyword(v);
  }
  return out;
}

/** JSON Schema 2020-12 for a strict zod schema ("input" view keeps additionalProperties:false). */
export function jsonSchemaOf(schema: z.ZodType): Json {
  return stripSchemaKeyword(z.toJSONSchema(schema, { target: "draft-2020-12", io: "input" })) as Json;
}

const toOpenApiPath = (path: string): string => path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");

const errorRef = { $ref: "#/components/schemas/ErrorBody" };
const errorResponse = (description: string) => ({ description, content: { "application/json": { schema: errorRef } } });

function operationFor(route: RouteDef<unknown, unknown>): Json {
  const parameters: Json[] = [];
  if (route.params) {
    const ps = jsonSchemaOf(route.params);
    const props = (ps.properties ?? {}) as Record<string, Json>;
    for (const name of Object.keys(props).sort()) parameters.push({ name, in: "path", required: true, schema: props[name] });
  }
  for (const h of route.headers ?? []) parameters.push({ name: h.name, in: "header", required: h.required, description: h.description, schema: { type: "string", maxLength: 256 } });

  const responses: Json = {};
  for (const status of Object.keys(route.responses).map(Number).sort((a, b) => a - b)) {
    const spec = route.responses[status];
    if (!spec) continue;
    if (spec.schema === ErrorBody) responses[String(status)] = errorResponse(spec.description);
    else if (spec.schema) responses[String(status)] = { description: spec.description, content: { "application/json": { schema: jsonSchemaOf(spec.schema) } } };
    else responses[String(status)] = { description: spec.description };
  }
  // Errors the app itself returns for every route (generic body, reason code only).
  if (route.body && !responses["413"]) responses["413"] = errorResponse("PAYLOAD_TOO_LARGE: body exceeds the configured limit");
  if (route.body && !responses["415"]) responses["415"] = errorResponse("UNSUPPORTED_MEDIA_TYPE: application/json only");
  if (route.channel && route.rateLimitExempt !== true && !responses["429"]) responses["429"] = errorResponse("RATE_LIMITED: per-integration rate limit exceeded");
  if (!responses["500"]) responses["500"] = errorResponse("INTERNAL_ERROR or RESPONSE_SCHEMA_VIOLATION (fail closed)");

  const op: Json = {
    operationId: route.operationId,
    summary: route.summary,
    tags: route.tags,
    security: route.channel ? [{ integrationBearer: [] }] : [],
    "x-vsp-channel": route.channel,
    "x-vsp-rate-limit-exempt": route.rateLimitExempt === true,
  };
  if (route.ref) op["x-talkdesk-ref"] = route.ref;
  if (parameters.length > 0) op.parameters = parameters;
  if (route.body) op.requestBody = { required: true, content: { "application/json": { schema: jsonSchemaOf(route.body) } } };
  op.responses = responses;
  return op;
}

export function buildOpenApiDocument(routes: readonly RouteDef<unknown, unknown>[] = gatewayRouteSpecs()): Json {
  const seen = new Set<string>();
  const paths: Record<string, Json> = {};
  for (const route of routes) {
    if (seen.has(route.operationId)) throw new Error(`OPENAPI_DUPLICATE_OPERATION_ID:${route.operationId}`);
    seen.add(route.operationId);
    const p = toOpenApiPath(route.path);
    const item = (paths[p] ??= {});
    const method = route.method.toLowerCase();
    if (item[method]) throw new Error(`OPENAPI_DUPLICATE_ROUTE:${route.method} ${route.path}`);
    item[method] = operationFor(route);
  }
  const sortedPaths: Record<string, Json> = {};
  for (const p of Object.keys(paths).sort()) sortedPaths[p] = paths[p] as Json;
  return {
    openapi: "3.1.0",
    jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
    info: {
      title: "Voice Support Platform gateway",
      version: GATEWAY_API_VERSION,
      description:
        "Generated from the gateway route definitions (platform/src/gateway/openapi.ts). Every authenticated route requires an integration access token for its own channel " +
        "(mcp_tools, telephony_control, portal); the caller session is carried only in the trusted X-VSP-Session-Ref header, never in a URL, body or tool argument. " +
        "Errors use a generic body with a reason code and an opaque request id. The webhook route accepts only the LOCAL FIXTURE HMAC in local/ci and answers " +
        "WEBHOOK_AUTH_UNVERIFIED elsewhere (the vendor signature scheme is not yet confirmed).",
    },
    servers: [{ url: "http://127.0.0.1:8080", description: "LOCAL FIXTURE loopback (pnpm start:local). No deployed environment is described here." }],
    tags: [
      { name: "health", description: "Liveness and readiness (no tenant data, no versions)." },
      { name: "tools", description: "Pinned tool catalogue and HTTP tool invocation." },
      { name: "mcp", description: "MCP Streamable HTTP (stateless, JSON responses)." },
      { name: "telephony", description: "Telephony-control API (Talkdesk Studio HTTP steps TC-01..TC-12)." },
      { name: "portal", description: "Secure-link verification portal API." },
      { name: "webhooks", description: "Transfer events (LOCAL FIXTURE HMAC only)." },
    ],
    paths: sortedPaths,
    components: {
      securitySchemes: {
        integrationBearer: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description:
            "OAuth 2.0 client-credentials access token (JWT verified against the configured issuer, audience and JWKS; channel from the scope). " +
            "In local/ci only, the LOCAL FIXTURE tokens printed by the local entry point are accepted instead.",
        },
      },
      schemas: { ErrorBody: jsonSchemaOf(ErrorBody) },
    },
  };
}

/** Deterministic file text (construction order is fixed; pretty-printed, trailing newline). */
export function openApiFileContent(doc: Json = buildOpenApiDocument()): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}
