import { describe, expect, it } from "vitest";
import { PEOPLE } from "../fixtures/synthetic-world.js";
import { InMemoryMetrics, VERIFICATION_ABUSE_SIGNAL_KINDS } from "../observability/metrics.js";
import { FakeClock } from "../shared/clock.js";
import { AccountAbuseSignal, VerificationAbuseMonitor, abuseKey } from "./abuse-monitor.js";
import type { KvStore } from "./ports.js";
import { hourWindow } from "./keys.js";
import { MemoryKvStoreFixture } from "./kv/memory-kv-store.js";

const ACCOUNT = { kind: "account", id: PEOPLE.avery.accountId } as const;

describe("VerificationAbuseMonitor (account-keyed abuse signals, AUTH-ENUM-01)", () => {
  it("[AUTH-ENUM-01] [DATA-01] counts per signal, subject and hour under a hashed key; the raw account id is never stored", async () => {
    const clock = new FakeClock();
    const kv = new MemoryKvStoreFixture();
    const metrics = new InMemoryMetrics();
    const m = new VerificationAbuseMonitor({ kv, clock, metrics, retentionHours: 168 });
    await m.record("LINK_ACCOUNT_LIMIT", ACCOUNT);
    await m.record("LINK_ACCOUNT_LIMIT", ACCOUNT);
    await m.record("RECENT_NUMBER_CHANGE", ACCOUNT);
    expect(await m.count("LINK_ACCOUNT_LIMIT", ACCOUNT)).toBe(2);
    expect(await m.count("RECENT_NUMBER_CHANGE", ACCOUNT)).toBe(1);
    expect(await m.count("LINK_ACCOUNT_LIMIT", { kind: "destination", id: PEOPLE.avery.accountId })).toBe(0);
    expect(kv.dump()).not.toContain(PEOPLE.avery.accountId);
    const item = await kv.get(abuseKey("LINK_ACCOUNT_LIMIT", ACCOUNT, hourWindow(clock.now())));
    expect(item?.ttlEpochSeconds).toBe((hourWindow(clock.now()) + 1 + 168) * 3600);
    // The metric carries only the catalogue's RiskFlag-valued label.
    expect(metrics.counterValue("vsp_challenge_abuse_signals_total", { signal: "OTP_ABUSE_SUSPECTED" })).toBe(2);
    expect(metrics.counterValue("vsp_challenge_abuse_signals_total", { signal: "RECENT_NUMBER_CHANGE" })).toBe(1);
    // Hourly windows: the next hour starts from zero.
    clock.advanceSeconds(3600);
    expect(await m.count("LINK_ACCOUNT_LIMIT", ACCOUNT)).toBe(0);
  });

  it("[SPEC-13.dashboards][AUTH-ENUM-01][DATA-01] every recorded signal is counted in vsp_verification_abuse_signals_total by kind only, even when the investigation store is down", async () => {
    // The catalogue's closed label enum is exactly the monitor's signal kinds.
    expect([...VERIFICATION_ABUSE_SIGNAL_KINDS].sort()).toEqual([...AccountAbuseSignal.options].sort());
    const metrics = new InMemoryMetrics();
    const m = new VerificationAbuseMonitor({ kv: new MemoryKvStoreFixture(), clock: new FakeClock(), metrics, retentionHours: 24 });
    for (const signal of AccountAbuseSignal.options) await m.record(signal, ACCOUNT);
    await m.record("OTP_DESTINATION_LIMIT", { kind: "destination", id: "chn_synthAverySms00001" });
    for (const signal of AccountAbuseSignal.options) {
      expect(metrics.counterValue("vsp_verification_abuse_signals_total", { signal }), signal).toBe(signal === "OTP_DESTINATION_LIMIT" ? 2 : 1);
    }
    const [series] = metrics.find("vsp_verification_abuse_signals_total", { signal: "OTP_ACCOUNT_LIMIT" });
    expect(Object.keys(series?.labels ?? {})).toEqual(["signal"]);
    const all = JSON.stringify(metrics.allSeries());
    for (const id of [PEOPLE.avery.accountId, "chn_synthAverySms00001"]) expect(all).not.toContain(id);
    expect(metrics.counterValue("vsp_metric_label_rejections_total")).toBe(0);
    // A store outage loses only the hashed investigation counter, never the alarm metric.
    const fail = () => Promise.reject(new Error("FIXTURE_KV_DOWN"));
    const down: KvStore = { kind: "local_fixture", get: fail, putIfAbsent: fail, compareAndSwap: fail, delete: fail, increment: fail };
    const outageMetrics = new InMemoryMetrics();
    await new VerificationAbuseMonitor({ kv: down, clock: new FakeClock(), metrics: outageMetrics, retentionHours: 24 }).record("OTP_ACCOUNT_GUESS_LIMIT", ACCOUNT);
    expect(outageMetrics.counterValue("vsp_verification_abuse_signals_total", { signal: "OTP_ACCOUNT_GUESS_LIMIT" })).toBe(1);
    // An invalid signal is not counted.
    await m.record("NOT_A_SIGNAL" as never, ACCOUNT);
    expect(metrics.counterValue("vsp_verification_abuse_signals_total", { signal: "other" })).toBe(0);
  });

  it("[AUTH-ENUM-01] recording never throws (a store outage cannot change what the caller observes); reads validate their input", async () => {
    const broken: KvStore = {
      kind: "local_fixture",
      get: () => Promise.reject(new Error("FIXTURE_KV_DOWN")),
      putIfAbsent: () => Promise.reject(new Error("FIXTURE_KV_DOWN")),
      compareAndSwap: () => Promise.reject(new Error("FIXTURE_KV_DOWN")),
      delete: () => Promise.reject(new Error("FIXTURE_KV_DOWN")),
      increment: () => Promise.reject(new Error("FIXTURE_KV_DOWN")),
    };
    const m = new VerificationAbuseMonitor({ kv: broken, clock: new FakeClock(), retentionHours: 1 });
    await expect(m.record("OTP_ACCOUNT_LIMIT", ACCOUNT)).resolves.toBeUndefined();
    await expect(m.record("NOT_A_SIGNAL" as never, ACCOUNT)).resolves.toBeUndefined();
    const ok = new VerificationAbuseMonitor({ kv: new MemoryKvStoreFixture(), clock: new FakeClock(), retentionHours: 1 });
    await expect(ok.count("OTP_ACCOUNT_LIMIT", { kind: "account", id: "" })).rejects.toMatchObject({ reasonCode: "ABUSE_SIGNAL_INVALID" });
    expect(() => new VerificationAbuseMonitor({ kv: new MemoryKvStoreFixture(), clock: new FakeClock(), retentionHours: 0 })).toThrow(expect.objectContaining({ reasonCode: "ABUSE_MONITOR_CONFIG_INVALID" }));
  });
});
