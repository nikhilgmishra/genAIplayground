/**
 * Change-request lookup and completion, receipts, metadata and consistency (WP-23; ACT-03).
 *
 *   GET  /api/v1/change-requests/{requestId}             lookup by key: COMPLETED / INCOMPLETE / REJECTED, or
 *                                                        404 (unknown, or not yet visible: see the account's
 *                                                        documented visibility window)
 *   POST /api/v1/change-requests/{requestId}/completion  completes an INCOMPLETE request (step 2 only; never
 *                                                        applies the change again); replays a COMPLETED one
 *   POST /api/v1/change-requests/{requestId}/fence       once the request's deadline has passed: the change
 *                                                        stored under the id (no lag), or a FENCED id under which
 *                                                        nothing can ever be applied (changes.ts `fence`). The
 *                                                        only proof of absence the API offers
 *   GET  /api/v1/receipts/{receiptId}                    the authoritative receipt of a completed change
 *   GET  /api/v1/meta/{system}/consistency               the documented visibility window of the account, the
 *                                                        dispatch-deadline guarantee and the request digest scheme
 *   GET  /api/v1/meta/{system}/metadata                  JSON Schema of every object (in the account's dialect)
 *
 * A change request belongs to the system of its operation (scheduling.* or billing.*): reading it needs that
 * system's read scope, completing it that system's write scope, so a credential of one system never reaches
 * another system's requests (least privilege, FO-05-56). A request of another system answers 404.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Scope } from "./auth.js";
import { KEYED_WRITE_OPERATIONS } from "./changes.js";
import { ApiError, notFound } from "./errors.js";
import type { ApiDeps, Ctx } from "./http.js";
import { context, get, Id, KeyRef, parse, readFaults } from "./http.js";
import { metadataDocument } from "./metadata.js";

const SYSTEM_SCOPES: Record<string, { read: Scope; write: Scope }> = {
  scheduling: { read: "scheduling:read", write: "scheduling:write" },
  billing: { read: "billing:read", write: "billing:write" },
};

const systemOf = (operation: string): string => operation.split(".")[0] ?? "";

/** Authenticated context for a request whose scope depends on the record (checked by the caller). */
async function anyScope(deps: ApiDeps, req: FastifyRequest, reply: FastifyReply, operation: string): Promise<Ctx> {
  const ctx = await context(deps, req, reply, operation, null);
  if (!Object.values(SYSTEM_SCOPES).some((s) => ctx.principal.scopes.includes(s.read) || ctx.principal.scopes.includes(s.write))) throw new ApiError(403, "SCOPE_MISSING");
  return ctx;
}

function hasScope(ctx: Ctx, operation: string, access: "read" | "write"): boolean {
  const s = SYSTEM_SCOPES[systemOf(operation)];
  return s !== undefined && ctx.principal.scopes.includes(s[access]);
}

export function changeRoutes(app: FastifyInstance, deps: ApiDeps): void {
  const { store } = deps;

  app.get("/api/v1/change-requests/:requestId", async (req, reply) => {
    const operation = "change_requests.get";
    const ctx = await anyScope(deps, req, reply, operation);
    const { requestId } = parse(z.object({ requestId: KeyRef }), req.params);
    if (req.refbiz) req.refbiz.keyRef = requestId;
    const body = await readFaults(deps, ctx, operation, async () => {
      const found = await deps.changes.lookup(ctx.account.account_id, requestId);
      if (!found || !hasScope(ctx, String(found.operation), "read")) throw notFound();
      return found;
    });
    return reply.code(200).send(body);
  });

  app.post("/api/v1/change-requests/:requestId/completion", async (req, reply) => {
    const operation = "change_requests.complete";
    const ctx = await anyScope(deps, req, reply, operation);
    const { requestId } = parse(z.object({ requestId: KeyRef }), req.params);
    if (req.refbiz) req.refbiz.keyRef = requestId;
    const known = (await store.query<{ operation: string }>("select operation from refbiz.change_requests where account_id = $1 and key_ref = $2", [ctx.account.account_id, requestId]))[0];
    if (!known || !hasScope(ctx, known.operation, "write")) throw notFound();
    const out = await deps.changes.complete(ctx.account.account_id, requestId);
    if (out.replayed) reply.header("Refbiz-Replayed", "true");
    return reply.code(out.status).send(out.body);
  });

  app.post("/api/v1/change-requests/:requestId/fence", async (req, reply) => {
    const operation = "change_requests.fence";
    const ctx = await anyScope(deps, req, reply, operation);
    const { requestId } = parse(z.object({ requestId: KeyRef }), req.params);
    if (req.refbiz) req.refbiz.keyRef = requestId;
    const b = parse(z.strictObject({ operation: z.enum(KEYED_WRITE_OPERATIONS), notAfter: z.iso.datetime({ offset: true }) }), req.body);
    // Only the write scope of the request's system may fence it (a fence decides whether it can still apply).
    if (!hasScope(ctx, b.operation, "write")) throw notFound();
    const unavailable = deps.faults.take(ctx.account.account_id, operation, ["HTTP_STATUS"]);
    if (unavailable) throw new ApiError(unavailable.status, "UNAVAILABLE", unavailable.retryAfterSeconds);
    const out = await deps.changes.fence(ctx.account.account_id, requestId, b.operation, new Date(b.notAfter).toISOString());
    // A request of another system under this id is not disclosed (nothing was changed: it existed).
    if (!hasScope(ctx, String(out.body.operation), "write")) throw notFound();
    if (out.fencedNow) reply.header("Refbiz-Fenced", "true");
    return reply.code(200).send(out.body);
  });

  app.get("/api/v1/receipts/:receiptId", async (req, reply) => {
    const operation = "receipts.get";
    const ctx = await anyScope(deps, req, reply, operation);
    const { receiptId } = parse(z.object({ receiptId: Id }), req.params);
    const r = (
      await store.query<{ receipt_id: string; key_ref: string; operation: string; resource_type: string; resource_id: string; resource_version: string; state_digest: string; committed_at: Date; request_digest: string }>(
        `select r.*, c.request_digest from refbiz.receipts r join refbiz.change_requests c on c.account_id = r.account_id and c.key_ref = r.key_ref
         where r.account_id = $1 and r.receipt_id = $2`,
        [ctx.account.account_id, receiptId],
      )
    )[0];
    if (!r || !hasScope(ctx, r.operation, "read")) throw notFound();
    return reply.code(200).send({
      receiptId: r.receipt_id,
      requestId: r.key_ref,
      operation: r.operation,
      resourceType: r.resource_type,
      resourceId: r.resource_id,
      resourceVersion: r.resource_version,
      stateDigest: r.state_digest,
      requestDigest: r.request_digest,
      committedAt: r.committed_at.toISOString(),
    });
  });

  for (const scope of ["scheduling:read", "billing:read", "claims:read", "provider:read", "referrals:read", "legacy:read"] as const) {
    const system = scope.split(":")[0] as string;
    get(app, deps, `/api/v1/meta/${system}/consistency`, "meta.consistency", scope, async (ctx) => ({
      accountId: ctx.account.account_id,
      dialect: ctx.account.dialect,
      timeZone: ctx.account.time_zone,
      visibilityWindowMs: ctx.account.visibility_window_ms,
      // Guarantees the platform's absence rule and payload binding rely on (deadline.ts, changes.ts).
      dispatchDeadline: "REQUEST_NOT_AFTER",
      requestDigest: "REFBIZ_REQUEST_V1",
      // Absence is proved only by a fence after the deadline (never by a 404 plus elapsed time).
      absenceProof: "FENCE_AFTER_DEADLINE",
      // The legacy product's references are reserved by one dispatch before its (non-idempotent) create.
      dispatchReservation: "RESERVE_BEFORE_CREATE",
    }));
    get(app, deps, `/api/v1/meta/${system}/metadata`, "meta.metadata", scope, async (ctx) => metadataDocument(ctx.account.dialect));
  }
}
