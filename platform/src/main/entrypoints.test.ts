/**
 * Entry points: deployed environments are refused before any port is bound
 * (OPS-04); the LOCAL entry point binds loopback only and prints the LOCAL
 * FIXTURE banner. Sockets are 127.0.0.1 with ephemeral ports only.
 */
import { Server } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryLogger } from "../observability/logger.js";
import { ConfigurationRejectedError } from "../shared/errors.js";
import { FakeClock } from "../shared/clock.js";
import { startWorker } from "../worker/main.js";
import { ManualLoopScheduler } from "../worker/scheduler.js";
import { startLocal } from "./local.js";
import type { LocalRuntime } from "./local.js";
import { startServer } from "./server.js";

let rt: LocalRuntime | null = null;
afterEach(async () => {
  await rt?.close();
  rt = null;
  vi.restoreAllMocks();
});

describe("deployed entry points refuse before binding (OPS-04)", () => {
  it("[OPS-04] server.ts and worker/main.ts with VSP_ENVIRONMENT=production throw ConfigurationRejectedError and never listen", async () => {
    const listen = vi.spyOn(Server.prototype, "listen");
    for (const start of [startServer, startWorker]) {
      const p = start({ env: { VSP_ENVIRONMENT: "production", VSP_MUTATIONS_ENABLED: "true", PORT: "8080" }, logger: createMemoryLogger().logger });
      await expect(p).rejects.toBeInstanceOf(ConfigurationRejectedError);
    }
    expect(listen).not.toHaveBeenCalled();
  });

  it("[OPS-04] the deployed entry points require VSP_ENVIRONMENT and a valid PORT (strict infrastructure variables)", async () => {
    await expect(startServer({ env: {}, logger: createMemoryLogger().logger })).rejects.toThrow("INFRA_ENV_ENVIRONMENT_REQUIRED");
    await expect(startServer({ env: { VSP_ENVIRONMENT: "prod" }, logger: createMemoryLogger().logger })).rejects.toThrow("INFRA_ENV_ENVIRONMENT_INVALID");
    await expect(startWorker({ env: { VSP_ENVIRONMENT: "ci", PORT: "80a" }, logger: createMemoryLogger().logger })).rejects.toThrow("INFRA_ENV_PORT_INVALID");
  });
});

describe("local entry point", () => {
  it("[OPS-04][SPEC-16.local-badge] start:local binds 127.0.0.1 only, labels everything LOCAL FIXTURE and serves gateway + worker health", async () => {
    const lines: string[] = [];
    const clock = new FakeClock("2026-10-18T09:00:00.000Z");
    rt = await startLocal({ port: 0, workerPort: 0, consolePort: 0, out: (l) => lines.push(l), clock, scheduler: new ManualLoopScheduler(clock), logger: createMemoryLogger().logger, env: {} });
    expect(rt.gatewayUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(rt.workerHealthUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const banner = lines.join("\n");
    expect(banner).toContain("LOCAL FIXTURE");
    expect(banner).toContain("SYNTHETIC");
    expect(banner).toContain("not Talkdesk's scheme");
    const live = await fetch(`${rt.gatewayUrl}/health/live`);
    expect(live.status).toBe(200);
    const ready = await fetch(`${rt.gatewayUrl}/health/ready`);
    expect(ready.status).toBe(200);
    const workerReady = await fetch(`${rt.workerHealthUrl}/health/ready`);
    expect(workerReady.status).toBe(503); // no loop has run yet on the manual scheduler
    await rt.worker.runAllOnce();
    expect((await fetch(`${rt.workerHealthUrl}/health/ready`)).status).toBe(200);
  }, 120_000);
});
