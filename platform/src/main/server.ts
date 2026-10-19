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
 * events per run). Graceful shutdown, in this order:
 *  1. stop accepting connections, and wait (bounded, default 5 s) for the
 *     requests already being handled, so a human or safety request in flight
 *     completes and appends or defers its route evidence before the final flush;
 *  2. close the Fastify app, which force-closes requests still open after that
 *     bound (forceCloseConnections) without waiting for their handlers;
 *  3. one bounded final flush (default 5 s), which then seals the queue;
 *  4. close the database.
 * Events still queued after step 3 are lost with the process and logged at
 * error level (`audit.deferred.unflushed_at_shutdown`, with the count). A
 * handler force-closed in step 2 can still reach the queue after step 3; the
 * sealed queue does not hold its event but drops it and logs it at error level
 * (`audit.deferred.lost_at_shutdown`, reason AUDIT_DEFERRED_AFTER_SHUTDOWN). So
 * no route evidence is lost silently on a graceful shutdown; a crash or forced
 * stop still loses the queue unreported (crash-loss limit). Steps 1 and 3 fit
 * well within the ECS stop timeout (30 s, modules/ecs_service).
 */
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
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
  /** Graceful shutdown (idempotent): listener and bounded wait for in-flight requests, app, bounded final deferred-audit flush, database. */
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
    async drained(timeoutMs: number): Promise<boolean> {
      if (open.size === 0) return true;
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
    },
  };
}

export async function startServer(opts: ServerOptions = {}): Promise<ServerRuntime> {
  const env = opts.env ?? process.env;
  // Strict infrastructure variables first (VSP_ENVIRONMENT is required; PORT validated).
  const infra = loadInfrastructureEnv(env, { defaultPort: 8080 });
  const drainTimeoutMs = opts.inFlightDrainTimeoutMs ?? 5_000;
  if (!Number.isSafeInteger(drainTimeoutMs) || drainTimeoutMs < 0 || drainTimeoutMs > 20_000) throw new ValidationError("SHUTDOWN_DRAIN_POLICY_INVALID");
  const container = await buildContainer({ environment: infra.environment, buildBusiness: opts.buildBusiness ?? buildBusiness, env, ...(opts.logger ? { logger: opts.logger } : {}) });
  const offline = infra.environment === "local" || infra.environment === "ci";
  const host = offline ? "127.0.0.1" : "0.0.0.0";
  const port = opts.port ?? infra.port;
  let deferredAuditFlush: DeferredAuditFlushTimer;
  const inFlight = trackInFlight(container.app.server);
  try {
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
    // 1. No new connection; requests already being handled get a bounded chance to finish, so their
    //    route evidence is appended or queued before the final flush (Fastify's close would destroy them).
    container.app.server.close();
    if (!(await inFlight.drained(drainTimeoutMs))) {
      container.logger.warn("server.shutdown_drain_timeout", { inFlight: inFlight.size, reasonCode: "SHUTDOWN_DRAIN_TIMEOUT" });
    }
    // 2. Force-closes whatever is still open; such a handler may still defer an event after step 3,
    //    which the sealed queue then reports as lost (audit.deferred.lost_at_shutdown).
    await container.app.close().catch(() => undefined);
    // 3. Bounded final flush; seals the queue.
    await deferredAuditFlush.stop();
    // 4. The database.
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
