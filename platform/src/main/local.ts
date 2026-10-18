/**
 * LOCAL entry point (`pnpm start:local`): the LOCAL FIXTURE composition with the
 * gateway on 127.0.0.1:8080 and the worker loops in the same process (PGlite is
 * in-memory, so gateway and worker must share it), worker health on
 * 127.0.0.1:8081. Loopback only; SYNTHETIC data only; every adapter is a
 * labelled local fixture. Never a deployment (server.ts refuses fixtures
 * outside local/ci through the configuration guard).
 */
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import { buildBusiness } from "../business/index.js";
import type { BuildBusiness } from "../business/contract.js";
import { LOCAL_FIXTURE_TOKENS } from "../gateway/auth.js";
import { LOCAL_FIXTURE_WEBHOOK_HMAC_KEY } from "../gateway/http/webhook-routes.js";
import { ConfigurationRejectedError } from "../shared/errors.js";
import type { Clock } from "../shared/clock.js";
import type { Logger } from "../observability/ports.js";
import { buildWorkerHealthApp, Worker, workerLoopsFor } from "../worker/worker.js";
import { TimerLoopScheduler } from "../worker/scheduler.js";
import type { LoopScheduler } from "../worker/scheduler.js";
import { buildContainer } from "./container.js";
import type { Container } from "./container.js";

export const LOOPBACK = "127.0.0.1";

export interface LocalRuntime {
  container: Container;
  worker: Worker;
  gatewayUrl: string;
  workerHealthUrl: string;
  close(): Promise<void>;
}

export interface StartLocalOptions {
  port?: number;
  workerPort?: number;
  buildBusiness?: BuildBusiness;
  clock?: Clock;
  logger?: Logger;
  scheduler?: LoopScheduler;
  env?: Readonly<Record<string, string | undefined>>;
  /** Banner sink (stdout by default). */
  out?: (line: string) => void;
}

/** The LOCAL FIXTURE banner: labels, loopback URLs and the SYNTHETIC integration tokens (not secrets). */
export function localBanner(gatewayUrl: string, workerHealthUrl: string, c: Pick<Container, "catalog" | "policy" | "label">): string[] {
  return [
    "================================================================",
    ` ${c.label}`,
    " LOCAL FIXTURE: SYNTHETIC people, calls and systems only. Not Talkdesk, not Salesforce,",
    " not any vendor sandbox; nothing here is production or sandbox evidence.",
    "================================================================",
    ` gateway         ${gatewayUrl}   (POST /mcp, /v1/tools/*, /telephony/v1/*, /portal/v1/*)`,
    ` worker health   ${workerHealthUrl}/health/ready`,
    ` tool catalogue  ${c.catalog.definitions.length} tools, digest ${c.catalog.digest}`,
    ` policy bundle   digest ${c.policy.bundleDigest}`,
    " LOCAL FIXTURE integration tokens (synthetic, local/ci only; refused elsewhere):",
    `   mcp_tools          Bearer ${LOCAL_FIXTURE_TOKENS.mcp_tools}`,
    `   telephony_control  Bearer ${LOCAL_FIXTURE_TOKENS.telephony_control}`,
    `   portal             Bearer ${LOCAL_FIXTURE_TOKENS.portal}`,
    ` LOCAL FIXTURE webhook HMAC key (not Talkdesk's scheme): ${LOCAL_FIXTURE_WEBHOOK_HMAC_KEY}`,
    "================================================================",
  ];
}

export async function startLocal(opts: StartLocalOptions = {}): Promise<LocalRuntime> {
  const container = await buildContainer({
    environment: "local",
    buildBusiness: opts.buildBusiness ?? buildBusiness,
    ...(opts.clock ? { clock: opts.clock } : {}),
    ...(opts.logger ? { logger: opts.logger } : {}),
    env: opts.env ?? process.env,
  });
  const { loops, closers } = workerLoopsFor(container);
  const worker = new Worker({ loops, scheduler: opts.scheduler ?? new TimerLoopScheduler(), clock: container.clock, logger: container.logger, closers });
  const health = await buildWorkerHealthApp(worker, container.logger);
  try {
    await container.app.listen({ host: LOOPBACK, port: opts.port ?? 8080 });
    await health.listen({ host: LOOPBACK, port: opts.workerPort ?? 8081 });
  } catch (err) {
    await health.close().catch(() => undefined);
    await container.close();
    throw err;
  }
  worker.start();
  const gatewayUrl = `http://${LOOPBACK}:${(container.app.server.address() as AddressInfo).port}`;
  const workerHealthUrl = `http://${LOOPBACK}:${(health.server.address() as AddressInfo).port}`;
  const out = opts.out ?? ((l: string) => console.log(l));
  for (const line of localBanner(gatewayUrl, workerHealthUrl, container)) out(line);
  return {
    container,
    worker,
    gatewayUrl,
    workerHealthUrl,
    async close() {
      await worker.stop();
      await health.close().catch(() => undefined);
      await container.close();
    },
  };
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  startLocal()
    .then((rt) => {
      const shutdown = () => {
        void rt.close().finally(() => process.exit(0));
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    })
    .catch((err: unknown) => {
      if (err instanceof ConfigurationRejectedError) console.error(`local.refused ${err.violations.join(" ")}`);
      else console.error(`local.failed ${err instanceof Error && /^[A-Z][A-Z0-9_]{2,63}$/.test(err.message) ? err.message : "STARTUP_FAILED"}`);
      process.exitCode = 1;
    });
}
