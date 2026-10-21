/**
 * Layer-2 global setup: refuses to run outside `VSP_INTEGRATION=1`, requires the compose project to
 * be running, and waits (VSP_HEALTH_TIMEOUT_MS, default 300 s) until every container of the project
 * is healthy. A service that never becomes healthy fails the run; nothing is skipped.
 */
import type { TestProject } from "vitest/node";
import { COMPOSE_PROJECT, discoverServices, isReady } from "./discovery.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default async function setup(project: TestProject): Promise<void> {
  if (process.env.VSP_INTEGRATION !== "1") throw new Error("Layer-2 tests run only with VSP_INTEGRATION=1 (use make test-integration)");
  const name = COMPOSE_PROJECT();
  const timeoutMs = Number(process.env.VSP_HEALTH_TIMEOUT_MS ?? 300_000);
  const deadline = Date.now() + timeoutMs;
  let services = discoverServices(name);
  if (Object.keys(services).length === 0) throw new Error(`compose project ${name} is not running: run make up PROFILE=core`);
  while (Object.values(services).some((s) => !isReady(s))) {
    if (Date.now() > deadline) {
      const bad = Object.values(services)
        .filter((s) => !isReady(s))
        .map((s) => `${s.service}=${s.health}`);
      throw new Error(`services not healthy after ${timeoutMs} ms: ${bad.join(", ")}`);
    }
    await sleep(2_000);
    services = discoverServices(name);
  }
  project.provide("vspServices", services);
  project.provide("vspProject", name);
}
