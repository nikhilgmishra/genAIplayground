/**
 * Deployed worker entry point (`node dist/worker/main.js`, infra contract:
 * VSP_ENVIRONMENT, VSP_MUTATIONS_ENABLED, PORT=8081 for health). The same
 * configuration guard as the gateway runs first (inside buildContainer); a
 * rejected configuration exits non-zero before the health port is bound.
 *
 * local/ci: a standalone worker builds its OWN in-memory LOCAL FIXTURE database
 * (PGlite cannot be shared across processes); `pnpm start:local` runs gateway
 * and worker loops in one process instead. Health binds loopback offline.
 *
 * sandbox / staging / production: the live worker (main/live-worker.ts startLiveWorker, WP-07) over the live
 * composition; the regression worker is never started there.
 */
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import { buildBusiness } from "../business/index.js";
import type { BuildBusiness } from "../business/contract.js";
import { loadInfrastructureEnv } from "../config/loader.js";
import { buildContainer } from "../main/container.js";
import { startLiveWorker } from "../main/live-worker.js";
import type { Container } from "../main/container.js";
import type { Logger } from "../observability/ports.js";
import { ConfigurationRejectedError } from "../shared/errors.js";
import { TimerLoopScheduler } from "./scheduler.js";
import type { LoopScheduler } from "./scheduler.js";
import { Worker, buildWorkerHealthApp, workerLoopsFor } from "./worker.js";

export interface WorkerRuntime {
  container: Container;
  worker: Worker;
  healthUrl: string;
  close(): Promise<void>;
}

export async function startWorker(
  opts: { env?: Readonly<Record<string, string | undefined>>; buildBusiness?: BuildBusiness; logger?: Logger; scheduler?: LoopScheduler } = {},
): Promise<WorkerRuntime> {
  const env = opts.env ?? process.env;
  const infra = loadInfrastructureEnv(env, { defaultPort: 8081 });
  const container = await buildContainer({ environment: infra.environment, buildBusiness: opts.buildBusiness ?? buildBusiness, env, ...(opts.logger ? { logger: opts.logger } : {}) });
  const { loops, closers } = workerLoopsFor(container);
  const worker = new Worker({ loops, scheduler: opts.scheduler ?? new TimerLoopScheduler(), clock: container.clock, logger: container.logger, closers });
  const health = await buildWorkerHealthApp(worker, container.logger);
  const host = infra.environment === "local" || infra.environment === "ci" ? "127.0.0.1" : "0.0.0.0";
  try {
    await health.listen({ host, port: infra.port });
  } catch (err) {
    await health.close().catch(() => undefined);
    await container.close();
    throw err;
  }
  worker.start();
  return {
    container,
    worker,
    healthUrl: `http://${host}:${(health.server.address() as AddressInfo).port}`,
    async close() {
      await worker.stop();
      await health.close().catch(() => undefined);
      await container.close();
    },
  };
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  const offlineEntry = process.env.VSP_ENVIRONMENT === "local" || process.env.VSP_ENVIRONMENT === "ci";
  (offlineEntry ? startWorker() : startLiveWorker({ buildBusiness }))
    .then((rt: { close(): Promise<void> }) => {
      const shutdown = () => {
        void rt.close().finally(() => process.exit(0));
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    })
    .catch((err: unknown) => {
      if (err instanceof ConfigurationRejectedError) process.stderr.write(`worker.refused ${err.violations.join(" ")}\n`);
      else process.stderr.write(`worker.failed ${err instanceof Error && /^[A-Z][A-Z0-9_]{2,63}$/.test(err.message) ? err.message : "STARTUP_FAILED"}\n`);
      process.exitCode = 1;
    });
}
