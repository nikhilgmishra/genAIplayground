/**
 * Route definitions shared by the Fastify registration and the OpenAPI
 * generator (one source of truth for paths, identities and strict schemas).
 *
 * Every route:
 *  - authenticates the integration (if `channel` is set) BEFORE any body or
 *    business processing, and requires that exact channel;
 *  - parses params and body with strict zod schemas (unknown fields rejected);
 *  - validates its own response against the declared schema (fail closed);
 *  - answers errors with a generic body `{ error: { reasonCode, requestId } }`
 *    (reason codes only; never input values, stack traces or dependency text).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { BlockedCapabilityError } from "../../adapters/errors.js";
import type { IntegrationIdentity } from "../../protocol/index.js";
import {
  AccessDeniedError,
  AuditUnavailableError,
  ConfigurationRejectedError,
  ConflictError,
  DependencyError,
  PlatformError,
  SessionInvalidError,
  ValidationError,
} from "../../shared/errors.js";
import { IntegrationAuthenticationError } from "../auth.js";
import type { IntegrationAuthenticator, IntegrationChannel } from "../auth.js";

export const ErrorBody = z.strictObject({
  error: z.strictObject({
    reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/),
    requestId: z.string().max(80),
  }),
});
export type ErrorBody = z.infer<typeof ErrorBody>;

export interface HeaderSpec {
  name: string;
  required: boolean;
  description: string;
}

export interface RouteResponseSpec {
  description: string;
  schema: z.ZodType | null;
}

export interface RouteContext<B, P> {
  body: B;
  params: P;
  integration: IntegrationIdentity | null;
  requestId: string;
  /** Lower-cased header lookup (single value or null). */
  header(name: string): string | null;
  /** Raw Fastify request (MCP adapter only). */
  raw: FastifyRequest;
}

export interface RouteResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface RouteDef<B = unknown, P = unknown> {
  operationId: string;
  /** Talkdesk package reference (TC-01..TC-12) when the route implements one. */
  ref?: string;
  method: "GET" | "POST" | "DELETE";
  /** Fastify path syntax (":param"). */
  path: string;
  /** Integration channel required; null = no bearer credential (health, HMAC-fixture webhook). */
  channel: IntegrationChannel | null;
  summary: string;
  tags: string[];
  headers?: HeaderSpec[];
  params?: z.ZodType<P>;
  body?: z.ZodType<B>;
  responses: Record<number, RouteResponseSpec>;
  /** Exempt from the per-integration rate limit (safety / human routes, health). */
  rateLimitExempt?: boolean;
  /** Validate the declared response schema before sending (default true). */
  validateResponse?: boolean;
  handler(ctx: RouteContext<B, P>): Promise<RouteResult>;
}

export function defineRoute<B, P>(def: RouteDef<B, P>): RouteDef<B, P> {
  return def;
}

/** HTTP status for a thrown platform error (reason code is the body). */
export function statusForError(err: unknown): { status: number; reasonCode: string } {
  if (err instanceof IntegrationAuthenticationError) {
    if (err.reasonCode === "INTEGRATION_CHANNEL_NOT_ALLOWED") return { status: 403, reasonCode: err.reasonCode };
    if (err.reasonCode === "INTEGRATION_KEYS_UNAVAILABLE") return { status: 503, reasonCode: err.reasonCode };
    return { status: 401, reasonCode: err.reasonCode };
  }
  const code = err instanceof PlatformError && /^[A-Z][A-Z0-9_]{2,63}$/.test(err.reasonCode) && !/\d{4,}/.test(err.reasonCode) ? err.reasonCode : "INTERNAL_ERROR";
  if (err instanceof SessionInvalidError) return { status: 403, reasonCode: code };
  if (err instanceof AccessDeniedError) return { status: 403, reasonCode: code };
  if (err instanceof ValidationError) return { status: 400, reasonCode: code };
  if (err instanceof ConflictError) return { status: 409, reasonCode: code };
  if (err instanceof AuditUnavailableError) return { status: 503, reasonCode: "AUDIT_UNAVAILABLE" };
  if (err instanceof BlockedCapabilityError) return { status: 501, reasonCode: code };
  if (err instanceof DependencyError) return { status: 503, reasonCode: code };
  if (err instanceof ConfigurationRejectedError) return { status: 503, reasonCode: "CONFIGURATION_REJECTED" };
  if (err instanceof PlatformError) return { status: 500, reasonCode: code };
  return { status: 500, reasonCode: "INTERNAL_ERROR" };
}

export function errorBody(reasonCode: string, requestId: string): ErrorBody {
  return { error: { reasonCode, requestId } };
}

declare module "fastify" {
  interface FastifyRequest {
    /** Authenticated integration identity (set by the route auth hook). */
    vspIntegration?: IntegrationIdentity | null;
  }
  interface FastifyContextConfig {
    vspOperationId?: string;
    vspRateLimitExempt?: boolean;
  }
}

export interface RegisterOptions {
  authenticator: IntegrationAuthenticator;
  logger: { warn(event: string, fields?: Record<string, string | number | boolean | null>): void };
  /** Per-route rate-limit config object understood by @fastify/rate-limit, or null when disabled. */
  rateLimit: { max: number; timeWindow: number } | null;
}

const header = (req: FastifyRequest, name: string): string | null => {
  const v = req.headers[name.toLowerCase()];
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return null; // duplicated trusted headers are ambiguous: treat as absent
  return null;
};

export function registerRoutes(app: FastifyInstance, routes: readonly RouteDef<unknown, unknown>[], opts: RegisterOptions): void {
  for (const route of routes) {
    app.route({
      method: route.method,
      url: route.path,
      config: {
        vspOperationId: route.operationId,
        vspRateLimitExempt: route.rateLimitExempt === true,
        ...(opts.rateLimit && route.rateLimitExempt !== true ? { rateLimit: opts.rateLimit } : {}),
      },
      preValidation: async (req: FastifyRequest, reply: FastifyReply) => {
        req.vspIntegration = null;
        if (!route.channel) return;
        try {
          req.vspIntegration = await opts.authenticator.authenticate(header(req, "authorization") ?? undefined, route.channel);
        } catch (err) {
          const { status, reasonCode } = statusForError(err);
          opts.logger.warn("gateway.http.auth_failed", { reasonCode, action: route.operationId });
          return reply.code(status).header("www-authenticate", 'Bearer realm="vsp-gateway"').send(errorBody(reasonCode, req.id));
        }
      },
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const params = route.params ? route.params.safeParse(req.params ?? {}) : { success: true as const, data: undefined };
        if (!params.success) return reply.code(400).send(errorBody("INVALID_REQUEST_PARAMS", req.id));
        let bodyValue: unknown = undefined;
        if (route.body) {
          const b = route.body.safeParse(req.body);
          if (!b.success) return reply.code(400).send(errorBody("INVALID_REQUEST_BODY", req.id));
          bodyValue = b.data;
        }
        let result: RouteResult;
        try {
          result = await route.handler({
            body: bodyValue,
            params: params.data,
            integration: req.vspIntegration ?? null,
            requestId: req.id,
            header: (name) => header(req, name),
            raw: req,
          });
        } catch (err) {
          const { status, reasonCode } = statusForError(err);
          return reply.code(status).send(errorBody(reasonCode, req.id));
        }
        const spec = route.responses[result.status];
        if (route.validateResponse !== false) {
          if (!spec) return reply.code(500).send(errorBody("RESPONSE_STATUS_UNDECLARED", req.id));
          if (spec.schema && !spec.schema.safeParse(result.body).success) return reply.code(500).send(errorBody("RESPONSE_SCHEMA_VIOLATION", req.id));
        }
        if (result.headers) for (const [k, v] of Object.entries(result.headers)) reply.header(k, v);
        if (result.body === undefined || result.body === null) return reply.code(result.status).send();
        return reply.code(result.status).send(result.body);
      },
    });
  }
}

/** Standard error responses every authenticated route may return. */
export const AUTH_ERRORS: Record<number, RouteResponseSpec> = {
  400: { description: "Strict schema violation (reason code only)", schema: ErrorBody },
  401: { description: "Missing or invalid integration credential", schema: ErrorBody },
  403: { description: "Credential not allowed for this channel, or session/authorization denied", schema: ErrorBody },
  429: { description: "Per-integration rate limit exceeded", schema: ErrorBody },
};
