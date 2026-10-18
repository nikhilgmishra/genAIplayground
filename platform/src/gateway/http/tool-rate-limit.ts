/**
 * Tool-call rate limiting for the two tool transports, POST /v1/tools/:name/:version and
 * POST /mcp (spec section 12: "Preserve an independent safe route even when cost or model
 * circuit breakers open"; SAFE-02, SAFE-03, OPS-02; findings SAFE-HANDOFF-03, VSP-GW-01,
 * VSP-GW-03).
 *
 * - Classification is decided BEFORE any limit: a call of a SAFETY_AND_HUMAN_ROUTE tool
 *   (request_safety_route, request_human_transfer; the class comes from the pinned tool
 *   catalogue the route serves, never from the caller) is never counted and never
 *   throttled, on either transport, whatever the other calls of the tenant are doing.
 * - Every other tool call, and every other MCP message (initialize, tools/list,
 *   notifications, malformed messages), takes one token from two fixed-window buckets: the
 *   per-call bucket (authenticated integration + the trusted X-VSP-Interaction-Id, else the
 *   hash of the trusted session reference, else "unbound") and the per-integration ceiling.
 *   One call can therefore never exhaust the whole tenant's tool budget, and the per-integration
 *   ceiling still bounds the aggregate (the gateway README's per-integration throttle).
 * - MCP JSON-RPC batches are counted per message, not per HTTP request (VSP-GW-03); the MCP
 *   adapter also caps a batch at MCP_MAX_BATCH_MESSAGES and dispatches it sequentially.
 *
 * The buckets are in memory per process (like @fastify/rate-limit's local store) and bounded
 * (oldest keys evicted). Keys hold opaque ids and hashes only; never a bearer reference.
 * The limiter is created by buildGatewayApp whenever the per-integration limit is enabled, and
 * the two tool routes are then exempt from the generic route limiter (they are limited here).
 */
import type { FastifyRequest } from "fastify";
import { sessionRefHash } from "../../identity/keys.js";
import type { IntegrationIdentity } from "../../protocol/index.js";
import { OpaqueId, SessionRef } from "../../protocol/index.js";
import type { Clock } from "../../shared/clock.js";
import type { ToolDefinition } from "../../protocol/index.js";

/** Operation ids whose requests this limiter meters (the generic route limiter skips them). */
export const TOOL_RATE_LIMITED_OPERATIONS: ReadonlySet<string> = new Set(["tools.invoke", "mcp.post"]);

/** True when the pinned catalogue classifies this tool name SAFETY_AND_HUMAN_ROUTE (never rate limited). */
export function isSafetyRouteTool(catalog: { readonly definitions: readonly Pick<ToolDefinition, "name" | "safetyClass">[] }, name: unknown): boolean {
  return typeof name === "string" && catalog.definitions.some((d) => d.name === name && d.safetyClass === "SAFETY_AND_HUMAN_ROUTE");
}

export interface RateWindow {
  max: number;
  timeWindowMs: number;
}

export interface ToolRateLimitConfig {
  /** Aggregate ceiling per authenticated integration and channel. */
  integration: RateWindow;
  /** Per call (one caller cannot exhaust the integration's budget). */
  perCall: RateWindow;
}

/**
 * Engineering default pending SRE capacity review (TB-10): a call may use at most a fifth of the
 * integration ceiling, and never less than 120 non-safety tool requests per window (two per
 * second at the default one-minute window), unless the ceiling itself is lower.
 */
export function defaultPerCallWindow(integration: RateWindow): RateWindow {
  return { max: Math.max(Math.min(integration.max, 120), Math.floor(integration.max / 5)), timeWindowMs: integration.timeWindowMs };
}

export type RateDecision =
  | { allowed: true; exempt: true }
  | { allowed: true; exempt: false; limit: number; remaining: number; resetSeconds: number }
  | { allowed: false; exempt: false; limit: number; remaining: 0; resetSeconds: number; scope: "CALL" | "INTEGRATION" };

interface Bucket {
  windowStart: number;
  count: number;
}

const DEFAULT_MAX_KEYS = 100_000;

export class ToolCallRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly maxKeys: number;

  constructor(
    private readonly opts: { clock: Clock; config: ToolRateLimitConfig; maxKeys?: number },
  ) {
    for (const w of [opts.config.integration, opts.config.perCall]) {
      if (!Number.isInteger(w.max) || w.max < 1 || !Number.isInteger(w.timeWindowMs) || w.timeWindowMs < 1) throw new Error("TOOL_RATE_LIMIT_CONFIG_INVALID");
    }
    this.maxKeys = opts.maxKeys ?? DEFAULT_MAX_KEYS;
  }

  /**
   * One unit of work: a tool call or another MCP message. A safety or human-route tool call
   * (classified by the caller from the pinned catalogue BEFORE this call) is exempt and never
   * counted; anything else needs a token in both buckets.
   */
  admit(key: { integrationId: string; channel: string; callKey: string }, safetyRouteTool: boolean): RateDecision {
    if (safetyRouteTool) return { allowed: true, exempt: true };
    const now = this.opts.clock.now().getTime();
    const { integration, perCall } = this.opts.config;
    const ik = `i\u0000${key.integrationId}\u0000${key.channel}`;
    const ck = `c\u0000${key.integrationId}\u0000${key.channel}\u0000${key.callKey}`;
    const ib = this.bucket(ik, now, integration.timeWindowMs);
    const cb = this.bucket(ck, now, perCall.timeWindowMs);
    const resetOf = (b: Bucket, w: RateWindow) => Math.max(1, Math.ceil((b.windowStart + w.timeWindowMs - now) / 1000));
    // Both buckets must have room; nothing is consumed when either refuses.
    if (cb.count >= perCall.max) return { allowed: false, exempt: false, limit: perCall.max, remaining: 0, resetSeconds: resetOf(cb, perCall), scope: "CALL" };
    if (ib.count >= integration.max) return { allowed: false, exempt: false, limit: integration.max, remaining: 0, resetSeconds: resetOf(ib, integration), scope: "INTEGRATION" };
    cb.count += 1;
    ib.count += 1;
    const callLeft = perCall.max - cb.count;
    const integrationLeft = integration.max - ib.count;
    return callLeft <= integrationLeft
      ? { allowed: true, exempt: false, limit: perCall.max, remaining: callLeft, resetSeconds: resetOf(cb, perCall) }
      : { allowed: true, exempt: false, limit: integration.max, remaining: integrationLeft, resetSeconds: resetOf(ib, integration) };
  }

  private bucket(k: string, now: number, windowMs: number): Bucket {
    let b = this.buckets.get(k);
    if (!b || now - b.windowStart >= windowMs || now < b.windowStart) b = { windowStart: now, count: 0 };
    // Re-insert (most recently used last) and bound the map.
    this.buckets.delete(k);
    this.buckets.set(k, b);
    while (this.buckets.size > this.maxKeys) {
      const oldest = this.buckets.keys().next().value;
      if (oldest === undefined) break;
      this.buckets.delete(oldest);
    }
    return b;
  }
}

/** Per-call key from the trusted transport headers only (opaque id or a hash; never the bearer). */
export function callKeyOf(headers: { interactionId: string | null; sessionRef: string | null }): string {
  const interaction = headers.interactionId?.trim() ?? null;
  if (interaction && OpaqueId.safeParse(interaction).success) return `call:${interaction}`;
  const ref = headers.sessionRef?.trim() ?? null;
  if (ref && SessionRef.safeParse(ref).success) {
    try {
      return `ses:${sessionRefHash(ref).slice(0, 32)}`;
    } catch {
      return "unbound";
    }
  }
  return "unbound";
}

/** Standard rate-limit response headers for a metered (non-exempt) decision. */
export function rateLimitHeaders(d: RateDecision): Record<string, string> {
  if (d.exempt) return {};
  const h: Record<string, string> = { "x-ratelimit-limit": String(d.limit), "x-ratelimit-remaining": String(d.remaining), "x-ratelimit-reset": String(d.resetSeconds) };
  if (!d.allowed) h["retry-after"] = String(d.resetSeconds);
  return h;
}

/** The limiter attached to this request by buildGatewayApp (null when rate limiting is disabled). */
export function toolLimiterOf(req: FastifyRequest): ToolCallRateLimiter | null {
  return req.vspToolLimiter ?? null;
}

/** Admission for one tool call or MCP message of an authenticated integration (classification first). */
export function admitToolUnit(
  req: FastifyRequest,
  integration: IntegrationIdentity,
  safetyRouteTool: boolean,
  headers: { interactionId: string | null; sessionRef: string | null },
): RateDecision {
  const limiter = toolLimiterOf(req);
  if (!limiter) return { allowed: true, exempt: true };
  return limiter.admit({ integrationId: integration.integrationId, channel: integration.channel, callKey: callKeyOf(headers) }, safetyRouteTool);
}

declare module "fastify" {
  interface FastifyRequest {
    /** Tool-call rate limiter of this gateway app (set by buildGatewayApp), or null. */
    vspToolLimiter?: ToolCallRateLimiter | null;
  }
}
