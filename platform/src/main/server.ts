/**
 * Deployed gateway entry point (`node dist/main/server.js`, infra contract:
 * VSP_ENVIRONMENT, VSP_MUTATIONS_ENABLED, PORT=8080). The configuration guard
 * runs first inside buildContainer; a rejected configuration exits non-zero
 * before any port is bound (OPS-04). Today every deployed environment is
 * refused (see container.ts): there is no live composition to start.
 *
 * In local/ci (e.g. a CI smoke test) the server binds loopback only, because
 * the LOCAL FIXTURE integration tokens must never be reachable from a network.
 *
 * Deferred route audit (ADR-0011): this process runs no worker loops, and the
 * worker's `audit.deferred_flush` loop drains the worker's own queue, never this
 * one. So the gateway drains its own process-local deferred route-audit queue on
 * a bounded timer (`DeferredAuditFlushTimer`, default every 5 s, at most 100
 * events per run). Graceful shutdown (SIGTERM; the entry below exits as soon as
 * it returns), in this order:
 *  1. stop accepting connections, and wait (bounded, default 5 s) for the open
 *     responses, so a human or safety request in flight completes with its answer
 *     (`server.shutdown_drain_timeout`, warn, when the bound expires);
 *  2. close the Fastify app, which force-closes the requests still open
 *     (forceCloseConnections); their handlers keep running;
 *  3. wait (bounded, default 10 s) for every route handler still running to
 *     settle (Fastify still sends, so `onSend` runs, when a force-closed handler
 *     returns or throws), so its route evidence is appended or queued before the
 *     final flush; the handlers still running when this bound expires are logged
 *     at error level (`server.shutdown_handlers_unsettled`, with the count): their
 *     route evidence may be lost with the process;
 *  4. one bounded final flush (default 5 s), which also waits for appends in
 *     progress, then seals the queue; events still queued, or appends still
 *     running, are logged at error level (`audit.deferred.unflushed_at_shutdown`,
 *     `remaining` / `inProgress`); a handler that reaches the sealed queue later is
 *     reported there (`audit.deferred.lost_at_shutdown`) if the process is still
 *     alive;
 *  5. close the database.
 * So on a graceful shutdown, route evidence that has reached the queue, or whose
 * Fastify route handler is still running, is either written or its possible loss is
 * logged at error level before the process exits (with counts, not per event, for a
 * handler step 3 gave up on). LIMIT: A route-tool execution that its tool timeout detached from its request is NOT waited
 * for: the pipeline answers TIMEOUT (`withTimeout` does not cancel the module) and the handler
 * settles while the handoff work keeps running; if the process exits before that work reaches
 * the queue, its route evidence is lost with no log at all. Detect it from TIMEOUT results and
 * `vsp_timeouts_total` for request_human_transfer / request_safety_route shortly before a stop,
 * cross-checked against transfer journeys and `safety_events`. The follow-on durable route
 * journal (follow-on specification section 15) replaces this process-local queue. A crash, OOM kill or forced
 * stop loses the queue unreported (crash-loss limit). The three bounds together are at most
 * 25 s, within the ECS stop timeout (30 s, modules/ecs_service).
 */
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { DeferredAuditFlushTimer } from "../audit/deferred.js";
import type { DeferredAuditFlushTimerOptions } from "../audit/deferred.js";
import { buildBusiness } from "../business/index.js";
import type { BuildBusiness } from "../business/contract.js";
import { loadInfrastructureEnv } from "../config/loader.js";
import type { Logger } from "../observability/ports.js";
import { ConfigurationRejectedError, ValidationError } from "../shared/errors.js";
import { buildContainer } from "./container.js";
import type { Container } from "./container.js";

export interface ServerRuntime {
  container: Container;
  url: string;
  /** Drains this process's deferred route-audit queue (the gateway runs no worker loops; ADR-0011). */
  deferredAuditFlush: DeferredAuditFlushTimer;
  /**
   * Graceful shutdown (idempotent): listener and bounded wait for open responses, app (force-closes the
   * rest), bounded wait for route handlers still running, bounded final deferred-audit flush, database.
   */
  close(): Promise<void>;
}

export interface ServerOptions {
  env?: Readonly<Record<string, string | undefined>>;
  buildBusiness?: BuildBusiness;
  logger?: Logger;
  /** Gateway-side deferred route-audit flush (defaults: every 5 s, 100 events per run, 5 s final flush). */
  deferredAuditFlush?: Omit<DeferredAuditFlushTimerOptions, "logger">;
  /** Programmatic listen port instead of PORT (tests: 0 = ephemeral; loopback only in local/ci). */
  port?: number;
  /** Graceful shutdown: how long to wait for requests already being handled before they are force-closed (default 5000 ms; 0..20000; 0 = none). */
  inFlightDrainTimeoutMs?: number;
  /**
   * Graceful shutdown: how long to wait, after the force-close, for route handlers still running to
   * settle before the final flush (default 10000 ms; 0..20000; 0 = none). Together with
   * inFlightDrainTimeoutMs and the final flush bound at most SHUTDOWN_BUDGET_MS.
   */
  handlerSettleTimeoutMs?: number;
}

/** Upper bound of the three shutdown waits together: the ECS stop timeout (30 s) minus a margin for app and database close. */
export const SHUTDOWN_BUDGET_MS = 25_000;

/**
 * Route handlers that have not settled yet, tracked with Fastify hooks: `onRequest` adds the request,
 * `onSend` or `onResponse` removes it. Fastify still calls `reply.send` (and so runs `onSend`) when the
 * handler of a force-closed request returns or throws, so a handler counts as running until its own
 * work (including the route-audit append or deferral it awaits) is done, whatever happened to its
 * socket. A request that never reaches `onSend` (none of the gateway routes; e.g. a hijacked reply)
 * counts as unsettled: reported, never assumed done.
 */
function trackHandlers(app: FastifyInstance) {
  const running = new Set<FastifyRequest>();
  const waiters = new Set<() => void>();
  const settle = (req: FastifyRequest) => {
    if (running.delete(req) && running.size === 0) for (const w of waiters) w();
  };
  app.addHook("onRequest", async (req) => {
    running.add(req);
  });
  app.addHook("onSend", async (req, _reply, payload) => {
    settle(req);
    return payload;
  });
  app.addHook("onResponse", async (req) => {
    settle(req);
  });
  return {
    get size(): number {
      return running.size;
    },
    /** Resolves true once no handler is running, or false when the bound expires first. */
    settled: (timeoutMs: number) => waitIdle(() => running.size, waiters, timeoutMs),
  };
}

/** Resolves true once `size()` is 0 (signalled through `waiters`), or false when the bound expires first. */
async function waitIdle(size: () => number, waiters: Set<() => void>, timeoutMs: number): Promise<boolean> {
  if (size() === 0) return true;
  if (timeoutMs === 0) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let done: (() => void) | undefined;
  const idle = new Promise<true>((resolve) => {
    done = () => resolve(true);
    waiters.add(done);
  });
  const expired = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([idle, expired]);
  } finally {
    clearTimeout(timer);
    if (done) waiters.delete(done);
  }
}

/**
 * Requests whose response has not closed yet. Tracked on the raw server, because Fastify's own
 * close (forceCloseConnections) destroys their sockets without waiting for their handlers.
 */
function trackInFlight(server: Server) {
  const open = new Set<ServerResponse>();
  const waiters = new Set<() => void>();
  server.on("request", (_req: IncomingMessage, res: ServerResponse) => {
    open.add(res);
    res.once("close", () => {
      open.delete(res);
      if (open.size === 0) for (const w of waiters) w();
    });
  });
  return {
    get size(): number {
      return open.size;
    },
    /** Resolves true once no request is open, or false when the bound expires first. */
    drained: (timeoutMs: number) => waitIdle(() => open.size, waiters, timeoutMs),
  };
}

export async function startServer(opts: ServerOptions = {}): Promise<ServerRuntime> {
  const env = opts.env ?? process.env;
  // Strict infrastructure variables first (VSP_ENVIRONMENT is required; PORT validated).
  const infra = loadInfrastructureEnv(env, { defaultPort: 8080 });
  const drainTimeoutMs = opts.inFlightDrainTimeoutMs ?? 5_000;
  const settleTimeoutMs = opts.handlerSettleTimeoutMs ?? 10_000;
  for (const ms of [drainTimeoutMs, settleTimeoutMs]) {
    if (!Number.isSafeInteger(ms) || ms < 0 || ms > 20_000) throw new ValidationError("SHUTDOWN_DRAIN_POLICY_INVALID");
  }
  // The final flush bound itself is validated by DeferredAuditFlushTimer; written so NaN fails closed.
  if (!(drainTimeoutMs + settleTimeoutMs + (opts.deferredAuditFlush?.finalFlushTimeoutMs ?? 5_000) <= SHUTDOWN_BUDGET_MS)) throw new ValidationError("SHUTDOWN_DRAIN_POLICY_INVALID");
  const container = await buildContainer({ environment: infra.environment, buildBusiness: opts.buildBusiness ?? buildBusiness, env, ...(opts.logger ? { logger: opts.logger } : {}) });
  const offline = infra.environment === "local" || infra.environment === "ci";
  const host = offline ? "127.0.0.1" : "0.0.0.0";
  const port = opts.port ?? infra.port;
  let deferredAuditFlush: DeferredAuditFlushTimer;
  const inFlight = trackInFlight(container.app.server);
  let handlers: ReturnType<typeof trackHandlers>;
  try {
    // Root hooks added before listen apply to every route (Fastify copies them into each route at ready).
    handlers = trackHandlers(container.app);
    deferredAuditFlush = new DeferredAuditFlushTimer(container.deferredAudit, { ...opts.deferredAuditFlush, logger: container.logger });
    await container.app.listen({ host, port });
  } catch (err) {
    await container.close();
    throw err;
  }
  deferredAuditFlush.start();
  const url = `http://${host}:${(container.app.server.address() as AddressInfo).port}`;
  container.logger.info("server.listening", { environment: infra.environment, port, reasonCode: offline ? "LOCAL_FIXTURE_LOOPBACK_ONLY" : null });
  let closing: Promise<void> | null = null;
  const shutdown = async (): Promise<void> => {
    // 1. No new connection; requests already being handled get a bounded chance to complete with their
    //    answer (Fastify's close would destroy their sockets).
    container.app.server.close();
    if (!(await inFlight.drained(drainTimeoutMs))) {
      container.logger.warn("server.shutdown_drain_timeout", { inFlight: inFlight.size, reasonCode: "SHUTDOWN_DRAIN_TIMEOUT" });
    }
    // 2. Force-closes whatever is still open; the handlers of those requests keep running.
    await container.app.close().catch(() => undefined);
    // 3. The entry exits as soon as close() returns: a handler that has not reached the deferred queue
    //    by then would lose its route evidence without any log. Wait (bounded) for every handler to
    //    settle, and say at error level how many may lose it when the bound expires.
    if (!(await handlers.settled(settleTimeoutMs))) {
      container.logger.error("server.shutdown_handlers_unsettled", { unsettled: handlers.size, reasonCode: "SHUTDOWN_HANDLERS_UNSETTLED" });
    }
    // 4. Bounded final flush (also waits for appends in progress); seals the queue.
    await deferredAuditFlush.stop();
    // 5. The database.
    await container.close();
  };
  return {
    container,
    url,
    deferredAuditFlush,
    close() {
      closing ??= shutdown();
      return closing;
    },
  };
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  startServer()
    .then((rt) => {
      const shutdown = () => {
        void rt.close().finally(() => process.exit(0));
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    })
    .catch((err: unknown) => {
      if (err instanceof ConfigurationRejectedError) process.stderr.write(`server.refused ${err.violations.join(" ")}\n`);
      else process.stderr.write(`server.failed ${err instanceof Error && /^[A-Z][A-Z0-9_]{2,63}$/.test(err.message) ? err.message : "STARTUP_FAILED"}\n`);
      process.exitCode = 1;
    });
}
