/**
 * Shared request plumbing of the API listener (WP-23): authentication, account context, scope checks, read-path
 * faults, the request log and error mapping. Handlers never see a request without an authenticated account.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Auth, Principal, Scope } from "./auth.js";
import { requireScope } from "./auth.js";
import type { ChangeRequests } from "./changes.js";
import { deadlineAcceptable } from "./deadline.js";
import type { Store } from "./db.js";
import { ApiError } from "./errors.js";
import type { FaultBoard } from "./faults.js";
import { KEY_REF, OPAQUE_ID } from "./ids.js";
import type { Dialect } from "./representation.js";

export interface ApiDeps {
  store: Store;
  auth: Auth;
  faults: FaultBoard;
  changes: ChangeRequests;
}

export interface Account {
  account_id: string;
  region: string;
  dialect: Dialect;
  time_zone: string;
  visibility_window_ms: number;
  lookup_lag_ms: number;
}

export interface Ctx {
  principal: Principal;
  account: Account;
}

export interface RequestTag {
  accountId: string | null;
  operation: string;
  keyRef: string | null;
}

declare module "fastify" {
  interface FastifyRequest {
    refbiz: RequestTag | null;
  }
}

export const Id = z.string().regex(OPAQUE_ID);
export const KeyRef = z.string().regex(KEY_REF);
/** A write's optional dispatch deadline (deadline.ts): an instant with an offset. */
export const NotAfter = z.iso.datetime({ offset: true }).optional();

/** The dispatch deadline of a parsed write body, or null; a deadline beyond the accepted horizon is 400. */
export function deadlineOf(b: { notAfter?: string | undefined }): string | null {
  if (b.notAfter === undefined) return null;
  if (!deadlineAcceptable(b.notAfter, Date.now())) throw new ApiError(400, "REQUEST_INVALID");
  return new Date(b.notAfter).toISOString();
}

export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new ApiError(400, "REQUEST_INVALID");
  return r.data;
}

/**
 * Authenticates the bearer token, loads the account, checks the scope (null: the handler checks the scope of the
 * record it reads), tags the request for the log.
 */
export async function context(deps: ApiDeps, req: FastifyRequest, reply: FastifyReply, operation: string, scope: Scope | null): Promise<Ctx> {
  req.refbiz = { accountId: null, operation, keyRef: null };
  const principal = await deps.auth.authenticate(req.headers.authorization);
  req.refbiz.accountId = principal.accountId;
  const account = (await deps.store.query<Account>("select account_id, region, dialect, time_zone, visibility_window_ms, lookup_lag_ms from refbiz.accounts where account_id = $1", [principal.accountId]))[0];
  if (!account) throw new ApiError(401, "UNAUTHENTICATED");
  reply.header("Refbiz-Account", account.account_id);
  reply.header("Refbiz-Region", account.region);
  if (scope !== null) requireScope(principal, scope);
  return { principal, account };
}

/** Read-path faults (fault-control only): an unavailable answer before processing, or a held response. */
export async function readFaults(deps: ApiDeps, ctx: Ctx, operation: string, run: () => Promise<unknown>): Promise<unknown> {
  const unavailable = deps.faults.take(ctx.account.account_id, operation, ["HTTP_STATUS"]);
  if (unavailable) throw new ApiError(unavailable.status, "UNAVAILABLE", unavailable.retryAfterSeconds);
  const out = await run();
  const delay = deps.faults.take(ctx.account.account_id, operation, ["DELAY_RESPONSE"]);
  if (delay && delay.delayMs > 0) await new Promise((r) => setTimeout(r, delay.delayMs));
  return out;
}

/** Registers a GET route that returns a JSON body. */
export function get(app: FastifyInstance, deps: ApiDeps, url: string, operation: string, scope: Scope, handler: (ctx: Ctx, req: FastifyRequest) => Promise<unknown>): void {
  app.get(url, async (req, reply) => {
    const ctx = await context(deps, req, reply, operation, scope);
    const body = await readFaults(deps, ctx, operation, () => handler(ctx, req));
    return reply.code(200).send(body);
  });
}

/** Error mapping (reason codes only) and the request log. */
export function installErrorHandling(app: FastifyInstance, deps: ApiDeps): void {
  app.decorateRequest("refbiz", null);
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiError) {
      if (err.retryAfterSeconds !== null) reply.header("Retry-After", String(err.retryAfterSeconds));
      return reply.code(err.status).send({ error: err.code });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (typeof status === "number" && status >= 400 && status < 500) return reply.code(status === 413 ? 413 : 400).send({ error: "REQUEST_INVALID" });
    return reply.code(500).send({ error: "INTERNAL" });
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: "NOT_FOUND" }));
  app.addHook("onResponse", async (req, reply) => {
    const t = req.refbiz;
    if (t?.accountId) deps.faults.record(t.accountId, { operation: t.operation, keyRef: t.keyRef, status: reply.statusCode });
  });
}
