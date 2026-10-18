/**
 * Deployed gateway entry point (`node dist/main/server.js`, infra contract:
 * VSP_ENVIRONMENT, VSP_MUTATIONS_ENABLED, PORT=8080). The configuration guard
 * runs first inside buildContainer; a rejected configuration exits non-zero
 * before any port is bound (OPS-04). Today every deployed environment is
 * refused (see container.ts): there is no live composition to start.
 *
 * In local/ci (e.g. a CI smoke test) the server binds loopback only, because
 * the LOCAL FIXTURE integration tokens must never be reachable from a network.
 */
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import { buildBusiness } from "../business/index.js";
import type { BuildBusiness } from "../business/contract.js";
import { loadInfrastructureEnv } from "../config/loader.js";
import type { Logger } from "../observability/ports.js";
import { ConfigurationRejectedError } from "../shared/errors.js";
import { buildContainer } from "./container.js";
import type { Container } from "./container.js";

export interface ServerRuntime {
  container: Container;
  url: string;
  close(): Promise<void>;
}

export async function startServer(opts: { env?: Readonly<Record<string, string | undefined>>; buildBusiness?: BuildBusiness; logger?: Logger } = {}): Promise<ServerRuntime> {
  const env = opts.env ?? process.env;
  // Strict infrastructure variables first (VSP_ENVIRONMENT is required; PORT validated).
  const infra = loadInfrastructureEnv(env, { defaultPort: 8080 });
  const container = await buildContainer({ environment: infra.environment, buildBusiness: opts.buildBusiness ?? buildBusiness, env, ...(opts.logger ? { logger: opts.logger } : {}) });
  const offline = infra.environment === "local" || infra.environment === "ci";
  const host = offline ? "127.0.0.1" : "0.0.0.0";
  try {
    await container.app.listen({ host, port: infra.port });
  } catch (err) {
    await container.close();
    throw err;
  }
  const url = `http://${host}:${(container.app.server.address() as AddressInfo).port}`;
  container.logger.info("server.listening", { environment: infra.environment, port: infra.port, reasonCode: offline ? "LOCAL_FIXTURE_LOOPBACK_ONLY" : null });
  return { container, url, close: () => container.close() };
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
