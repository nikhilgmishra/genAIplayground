import { describe, expect, it } from "vitest";
import type { AdminDeps } from "./admin.js";
import { buildAdminApp, LOOPBACK_HOST } from "./admin.js";
import { FaultBoard } from "./faults.js";

/** The health route touches no dependency; the Host guard runs before any handler. */
const deps = { faults: new FaultBoard() } as unknown as AdminDeps;

describe("fault-control listener: loopback Host only [FO-06-74][OPS-05]", () => {
  it("[FO-06-74] a request naming another host (DNS rebinding) is refused 421 before any handler runs", async () => {
    const app = buildAdminApp(deps);
    try {
      for (const host of ["refbiz.example.test", "attacker.example:58621", "127.0.0.1.attacker.example", "0.0.0.0:58621"]) {
        const r = await app.inject({ method: "GET", url: "/__admin/health", headers: { host } });
        expect(r.statusCode, host).toBe(421);
        expect(r.json()).toEqual({ error: "HOST_REFUSED" });
      }
      for (const host of ["127.0.0.1:58621", "localhost:58621", "[::1]:58621", "127.0.0.1"]) {
        const r = await app.inject({ method: "GET", url: "/__admin/health", headers: { host } });
        expect(r.statusCode, host).toBe(200);
      }
    } finally {
      await app.close();
    }
  });

  it("[FO-06-74] the Host pattern accepts only the loopback names", () => {
    expect(LOOPBACK_HOST.test("127.0.0.1:1")).toBe(true);
    expect(LOOPBACK_HOST.test("127.0.0.2:1")).toBe(false);
    expect(LOOPBACK_HOST.test("localhost.example")).toBe(false);
  });
});
