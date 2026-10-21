/**
 * Live console sign-in rate limiter, Docker-free (WP-07; FO-03-49, OPS-01, STRIDE D). The composed limiter on
 * the matched route, with percent-encoded paths and the trusted-proxy client address, is exercised by the
 * composition Layer-2 suite (console.test.ts) over the real Fastify app and Keycloak.
 */
import { describe, expect, it } from "vitest";
import { FakeClock } from "../shared/clock.js";
import { ConfigurationRejectedError } from "../shared/errors.js";
import { AuthRateLimiter } from "./live-console.js";

describe("AuthRateLimiter [OPS-01][STRIDE-D]", () => {
  it("fixed window per bucket: max admitted per window, then refused until the window turns", () => {
    const clock = new FakeClock("2026-10-21T00:00:00.000Z");
    const l = new AuthRateLimiter({ max: 2, timeWindowMs: 60_000 }, () => clock.now().getTime());
    expect([l.admit("v4:a"), l.admit("v4:a"), l.admit("v4:a")]).toEqual([true, true, false]);
    expect(l.admit("v4:b")).toBe(true);
    clock.advanceMs(60_000);
    expect(l.admit("v4:a")).toBe(true);
  });

  it("[STRIDE-D] a key spray never resets a tracked client's window: expired windows are purged first, then new keys share one overflow bucket", () => {
    const clock = new FakeClock("2026-10-21T00:00:00.000Z");
    const l = new AuthRateLimiter({ max: 2, timeWindowMs: 60_000 }, () => clock.now().getTime(), 4);
    // The attacker exhausts its own window.
    expect([l.admit("attacker"), l.admit("attacker"), l.admit("attacker")]).toEqual([true, true, false]);
    // A spray of new keys fills the table, then overflows into one shared bucket (limited like any client).
    expect([l.admit("s1"), l.admit("s2"), l.admit("s3")]).toEqual([true, true, true]);
    expect([l.admit("s4"), l.admit("s5"), l.admit("s6")]).toEqual([true, true, false]);
    // The attacker is still limited: its window was not dropped by the spray.
    expect(l.admit("attacker")).toBe(false);
    // Once windows expire, they are purged and new clients get their own window again.
    clock.advanceMs(60_000);
    expect([l.admit("s7"), l.admit("s7"), l.admit("s7")]).toEqual([true, true, false]);
  });

  it("refuses an invalid limit at composition", () => {
    for (const bad of [{ max: 0, timeWindowMs: 60_000 }, { max: 1.5, timeWindowMs: 60_000 }, { max: 10, timeWindowMs: 10 }]) {
      expect(() => new AuthRateLimiter(bad, () => 0)).toThrow(ConfigurationRejectedError);
    }
  });
});
