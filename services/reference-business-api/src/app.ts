/**
 * Assembly of the reference business API (WP-23): the HTTPS API listener (SNI certificates), the loopback health
 * listener, and in local/ci with fault control the loopback admin listener and the per-test endpoint pool.
 */
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Server as HttpsServer } from "node:https";
import Fastify from "fastify";
import type { FastifyInstance, RawServerDefault } from "fastify";
import { buildAdminApp } from "./admin.js";
import { Auth, OAuthError } from "./auth.js";
import { codeDigestOf } from "./build.js";
import { ChangeRequests } from "./changes.js";
import type { ServiceConfig } from "./config.js";
import type { Store } from "./db.js";
import { FaultBoard } from "./faults.js";
import type { ApiDeps } from "./http.js";
import { installErrorHandling } from "./http.js";
import { EndpointPool, SniContexts } from "./listeners.js";
import { billingRoutes } from "./routes-billing.js";
import { changeRoutes } from "./routes-changes.js";
import { legacyRoutes } from "./routes-legacy.js";
import { networkRoutes } from "./routes-network.js";
import { schedulingRoutes } from "./routes-scheduling.js";

export interface RunningService {
  api: FastifyInstance<HttpsServer>;
  admin: FastifyInstance | null;
  apiPort: number;
  healthPort: number;
  adminPort: number | null;
  close(): Promise<void>;
}

/**
 * Builds the API's Fastify instance over a TLS server (created by Fastify) whose certificates come from `sni`
 * (per-host contexts) and, in a deployment, the default certificate `tls`.
 */
export function buildApiApp(
  deps: ApiDeps,
  sni: SniContexts,
  onRoute?: (method: string, url: string) => void,
  tls: { cert: Buffer; key: Buffer } | null = null,
): { app: FastifyInstance<HttpsServer>; server: () => HttpsServer } {
  const app = Fastify({
    logger: false,
    bodyLimit: 65_536,
    requestTimeout: 120_000,
    https: { minVersion: "TLSv1.2", ...(tls ? { cert: tls.cert, key: tls.key } : {}) },
  });
  sni.attach(app.server);
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string", bodyLimit: 4_096 }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(String(body))));
  });
  installErrorHandling(app, deps);
  if (onRoute) {
    app.addHook("onRoute", (r) => {
      for (const m of [r.method].flat()) if (m !== "HEAD") onRoute(m, r.url);
    });
  }

  app.post("/oauth/token", async (req, reply) => {
    try {
      const out = await deps.auth.issue(req.body, req.headers.authorization);
      return reply.code(200).header("cache-control", "no-store").send(out);
    } catch (e) {
      if (e instanceof OAuthError) return reply.code(e.status).send({ error: e.error });
      throw e;
    }
  });
  schedulingRoutes(app, deps);
  billingRoutes(app, deps);
  networkRoutes(app, deps);
  changeRoutes(app, deps);
  legacyRoutes(app, deps);
  return { app, server: () => app.server };
}

const portOf = (app: FastifyInstance<RawServerDefault> | FastifyInstance<HttpsServer>, fallback: number): number => {
  const a = app.server.address();
  return typeof a === "object" && a !== null ? a.port : fallback;
};

export async function startService(cfg: ServiceConfig, store: Store): Promise<RunningService> {
  const tls = cfg.tls ? { cert: readFileSync(cfg.tls.certFile), key: readFileSync(cfg.tls.keyFile) } : null;
  const sni = new SniContexts();
  // Without fault control nothing reads the request log: it is not kept.
  const faults = new FaultBoard(undefined, cfg.admin !== null);
  const deps: ApiDeps = { store, auth: new Auth(store, cfg.tokenTtlSeconds), faults, changes: new ChangeRequests(store, faults) };
  const { app, server } = buildApiApp(deps, sni, undefined, tls);
  await app.listen({ port: cfg.api.port, host: cfg.api.bind });
  const apiPort = portOf(app, cfg.api.port);

  // Liveness and readiness on their own loopback listener (no TLS: the container health check and the platform's
  // composition probe read it locally).
  const health = Fastify({ logger: false });
  health.get("/health/live", async () => ({ status: "live" }));
  health.get("/health/ready", async (_req, reply) => {
    try {
      await store.pool.query("select 1");
      return { status: "ready" };
    } catch {
      return reply.code(503).send({ status: "not_ready", reasonCode: "DATABASE_UNAVAILABLE" });
    }
  });
  health.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: "NOT_FOUND" }));
  await health.listen({ port: cfg.health.port, host: "127.0.0.1" });
  const healthPort = portOf(health, cfg.health.port);

  let admin: FastifyInstance | null = null;
  let adminPort: number | null = null;
  let endpoints: EndpointPool | null = null;
  if (cfg.admin) {
    endpoints = new EndpointPool((socket) => server().emit("connection", socket), "127.0.0.1");
    // The code digest of the running sources (null when they cannot be read, e.g. a compiled image).
    const codeDigest = ((): string | null => {
      try {
        return codeDigestOf(dirname(fileURLToPath(import.meta.url)));
      } catch {
        return null;
      }
    })();
    admin = buildAdminApp({ codeDigest, store, auth: deps.auth, faults, sni, endpoints });
    await admin.listen({ port: cfg.admin.port, host: cfg.admin.bind });
    adminPort = portOf(admin, cfg.admin.port);
  }

  return {
    api: app,
    admin,
    apiPort,
    healthPort,
    adminPort,
    async close() {
      await endpoints?.closeAll();
      await admin?.close();
      await health.close();
      await app.close();
    },
  };
}
