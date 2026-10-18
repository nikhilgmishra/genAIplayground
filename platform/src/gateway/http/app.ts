/**
 * Fastify application for the gateway (spec section 3: "TypeScript ... with
 * Fastify"; section 14 security; ARCHITECTURE section 3 conventions).
 *
 * Security posture:
 *  - @fastify/helmet security headers;
 *  - NO CORS plugin: nothing is served cross-origin (the console is same-origin);
 *  - bounded JSON bodies only (other content types refused, 415);
 *  - opaque request ids generated server-side (inbound request-id headers ignored);
 *  - Fastify's own logger disabled; content-free completion logs carry the
 *    operation id, status and duration only (never URLs, headers or bodies);
 *  - generic error bodies with reason codes only;
 *  - per-integration rate limiting after authentication. Health and the
 *    telephony-control safety/human routes are exempt. The two tool transports
 *    (POST /v1/tools/:name/:version and POST /mcp) are metered per tool call by
 *    the ToolCallRateLimiter instead (tool-rate-limit.ts): a SAFETY_AND_HUMAN_ROUTE
 *    tool is classified before any limit and never throttled, every other tool call
 *    or MCP message is counted per call and per integration, and MCP batches are
 *    counted per message (SAFE-02/SAFE-03; SAFE-HANDOFF-03, VSP-GW-01, VSP-GW-03).
 */
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import type { Logger } from "../../observability/ports.js";
import { systemClock } from "../../shared/clock.js";
import type { Clock } from "../../shared/clock.js";
import { newId } from "../../shared/ids.js";
import type { IntegrationAuthenticator } from "../auth.js";
import { errorBody, registerRoutes } from "./route.js";
import type { RouteDef } from "./route.js";
import { TOOL_RATE_LIMITED_OPERATIONS, ToolCallRateLimiter, defaultPerCallWindow } from "./tool-rate-limit.js";

export interface GatewayHttpOptions {
  logger: Logger;
  authenticator: IntegrationAuthenticator;
  routes: readonly RouteDef<unknown, unknown>[];
  /** Maximum request body (bytes). Tool inputs are additionally bounded per tool. */
  bodyLimitBytes?: number;
  /** Per-integration rate limit; null disables it (tests that need unbounded calls). */
  rateLimit?: { max: number; timeWindowMs: number } | null;
  /** Per-call tool limit (default: defaultPerCallWindow of the per-integration limit). Ignored when rateLimit is null. */
  perCallRateLimit?: { max: number; timeWindowMs: number };
  /** Clock for the tool-call limiter windows (injectable; defaults to the system clock). */
  clock?: Clock;
}

export const DEFAULT_BODY_LIMIT_BYTES = 64 * 1024;
export const DEFAULT_RATE_LIMIT = { max: 600, timeWindowMs: 60_000 } as const;

export async function buildGatewayApp(opts: GatewayHttpOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    bodyLimit: opts.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES,
    genReqId: () => newId("req"),
    requestIdHeader: false,
    trustProxy: false,
    return503OnClosing: true,
    forceCloseConnections: true,
    routerOptions: { ignoreTrailingSlash: false, caseSensitive: true },
  });
  // Only JSON bodies are accepted.
  app.removeContentTypeParser("text/plain");

  await app.register(helmet, { global: true, contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } } });

  const rl = opts.rateLimit === undefined ? DEFAULT_RATE_LIMIT : opts.rateLimit;
  // Tool calls are classified (safety/human route exempt) and metered per call and per integration.
  const toolLimiter = rl
    ? new ToolCallRateLimiter({ clock: opts.clock ?? systemClock, config: { integration: { ...rl }, perCall: opts.perCallRateLimit ?? defaultPerCallWindow(rl) } })
    : null;
  app.decorateRequest("vspToolLimiter", null);
  app.addHook("onRequest", async (req) => {
    req.vspToolLimiter = toolLimiter;
  });
  if (rl) {
    await app.register(rateLimit, {
      global: false,
      hook: "preHandler",
      // Keyed by the authenticated integration (after the auth hook), never by caller-controlled data.
      keyGenerator: (req) => (req.vspIntegration ? `${req.vspIntegration.integrationId}:${req.vspIntegration.channel}` : "anonymous"),
      // The tool transports are metered by the ToolCallRateLimiter (never a route-wide bucket for safety tools).
      allowList: (req) => req.routeOptions.config.vspRateLimitExempt === true || TOOL_RATE_LIMITED_OPERATIONS.has(String(req.routeOptions.config.vspOperationId)),
      errorResponseBuilder: (req, context) => ({ statusCode: context.statusCode, ...errorBody("RATE_LIMITED", req.id) }),
      addHeaders: { "x-ratelimit-limit": true, "x-ratelimit-remaining": true, "x-ratelimit-reset": true, "retry-after": true },
    });
  }

  app.setErrorHandler((err, req, reply) => {
    const e = err as { code?: unknown; statusCode?: unknown };
    let status = typeof e.statusCode === "number" && e.statusCode >= 400 && e.statusCode < 600 ? e.statusCode : 500;
    let reasonCode = "INTERNAL_ERROR";
    if (e.code === "FST_ERR_CTP_BODY_TOO_LARGE") reasonCode = "PAYLOAD_TOO_LARGE";
    else if (e.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") reasonCode = "UNSUPPORTED_MEDIA_TYPE";
    else if (e.code === "FST_ERR_CTP_EMPTY_JSON_BODY" || e.code === "FST_ERR_CTP_INVALID_CONTENT_LENGTH") reasonCode = "INVALID_REQUEST_BODY";
    else if (status === 400) reasonCode = "MALFORMED_REQUEST";
    else if (status === 429) reasonCode = "RATE_LIMITED";
    else status = status >= 500 ? 500 : status;
    opts.logger.warn("gateway.http.error", { reasonCode, statusCode: status, requestId: req.id });
    void reply.code(status).send(errorBody(reasonCode, req.id));
  });
  app.setNotFoundHandler((req, reply) => {
    void reply.code(404).send(errorBody("NOT_FOUND", req.id));
  });
  app.addHook("onSend", async (req, reply, payload) => {
    reply.header("x-request-id", req.id);
    reply.header("cache-control", "no-store");
    return payload;
  });
  app.addHook("onResponse", async (req, reply) => {
    opts.logger.info("gateway.http.completed", {
      action: req.routeOptions.config.vspOperationId ?? "unrouted",
      method: req.method,
      statusCode: reply.statusCode,
      durationMs: Math.round(reply.elapsedTime),
      requestId: req.id,
    });
  });

  registerRoutes(app, opts.routes, {
    authenticator: opts.authenticator,
    logger: opts.logger,
    rateLimit: rl ? { max: rl.max, timeWindow: rl.timeWindowMs } : null,
  });
  return app;
}
