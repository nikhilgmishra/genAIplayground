/**
 * Entry point of the reference business API (WP-23). Exit codes: 2 for a refused configuration (reason code on
 * stderr, never a value), 1 for a start-up failure. SIGTERM / SIGINT close the listeners and the pool.
 */
import pino from "pino";
import { startService } from "./app.js";
import { ConfigError, loadConfig } from "./config.js";
import { Store } from "./db.js";

const log = pino({ level: "info", base: { service: "reference-business-api" }, redact: { paths: ["*.password", "*.secret", "*.token"], remove: true } });

async function main(): Promise<void> {
  let cfg;
  try {
    cfg = loadConfig(process.env);
  } catch (e) {
    if (e instanceof ConfigError) {
      log.error({ reasonCode: e.reasonCode }, "configuration refused");
      process.exit(2);
    }
    throw e;
  }
  const store = await Store.connect(cfg.database);
  const svc = await startService(cfg, store);
  log.info({ environment: cfg.environment, apiPort: svc.apiPort, healthPort: svc.healthPort, faultControl: svc.adminPort !== null }, "listening");
  const stop = async (signal: string) => {
    log.info({ signal }, "stopping");
    await svc.close().catch(() => undefined);
    await store.close().catch(() => undefined);
    process.exit(0);
  };
  process.once("SIGTERM", () => void stop("SIGTERM"));
  process.once("SIGINT", () => void stop("SIGINT"));
}

main().catch((e: unknown) => {
  log.error({ reasonCode: e instanceof Error ? e.name : "START_FAILED" }, "start-up failed");
  process.exit(1);
});
