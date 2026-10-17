import { describe, expect, it } from "vitest";
import { evaluateDeployability } from "../config/guard.js";
import { loadPlatformConfig } from "../config/loader.js";
import { SYNTHETIC_BADGE } from "../fixtures/synthetic-world.js";
import { FakeClock } from "../shared/clock.js";
import { ValidationError } from "../shared/errors.js";
import { BLOCKED_CAPABILITY_UNVERIFIED } from "./errors.js";
import { createLocalFixtureSet } from "./local/fixture-set.js";
import { createBlockedLiveRegistry } from "./live/blocked-set.js";
import type { Adapter } from "./ports.js";
import { AdapterRegistry } from "./registry.js";

const NOW = new FakeClock("2026-10-17T15:00:00.000Z").now();
const guard = (environment: "local" | "production", adapterKinds: Record<string, "local_fixture" | "live">) =>
  evaluateDeployability(loadPlatformConfig({ environment, env: {} }).config, { approvals: [], adapterKinds, loadedPolicy: null, toolCatalogDigest: null, now: NOW });

const OWNED = ["billing", "claims", "provider-system", "relationship-directory", "salesforce", "scheduling", "talkdesk-telephony"];

describe("AdapterRegistry", () => {
  it("[OPS-04] the LOCAL fixture set reports every component as local_fixture, and the production guard rejects each one", () => {
    const { registry } = createLocalFixtureSet({ clock: new FakeClock() });
    const kinds = registry.kinds();
    expect(Object.keys(kinds)).toEqual(OWNED);
    expect(Object.values(kinds).every((k) => k === "local_fixture")).toBe(true);
    const report = guard("production", kinds);
    expect(report.deployable).toBe(false);
    for (const c of OWNED) expect(report.violations).toContainEqual({ code: "ADAPTER_RUNTIME_LOCAL_FIXTURE", path: `runtime.${c}` });
  });

  it("[OPS-04] fixture kinds match the local configuration (no ADAPTER_KIND_MISMATCH offline)", () => {
    const { registry } = createLocalFixtureSet({ clock: new FakeClock() });
    const report = guard("local", registry.kinds());
    expect(report.violations.filter((v) => v.code === "ADAPTER_KIND_MISMATCH" || v.code === "OFFLINE_LIVE_ADAPTER_FORBIDDEN")).toEqual([]);
  });

  it("[OPS-03] the live wiring holds only live adapters, all BLOCKED and unhealthy; the guard sees no fixture", async () => {
    const registry = createBlockedLiveRegistry();
    const s = registry.summary();
    expect(s.localFixtureComponents).toEqual([]);
    expect(s.anyLocalFixture).toBe(false);
    expect(s.badge).toBeNull();
    expect(s.liveComponents).toEqual(OWNED);
    expect(s.blockedComponents).toEqual(OWNED);
    const report = guard("production", registry.kinds());
    expect(report.violations.filter((v) => v.code === "ADAPTER_RUNTIME_LOCAL_FIXTURE" || v.code === "ADAPTER_KIND_MISMATCH")).toEqual([]);
    expect(report.deployable).toBe(false); // other prerequisites (approvals, placeholders) still block production
    const health = await registry.healthReport();
    expect(health.every((h) => !h.healthy && h.reasonCode === BLOCKED_CAPABILITY_UNVERIFIED)).toBe(true);
  });

  it("[SPEC-16.badge] the console LOCAL FIXTURE badge shows whenever any registered adapter is a fixture", () => {
    const live = createBlockedLiveRegistry({ freeze: false });
    const { telephony } = createLocalFixtureSet({ clock: new FakeClock(), freeze: false });
    const mixed = new AdapterRegistry();
    mixed.register("scheduling", live.get("scheduling"));
    mixed.register("talkdesk-telephony", telephony);
    const s = mixed.summary();
    expect(s.badge).toBe(SYNTHETIC_BADGE);
    expect(s.localFixtureComponents).toEqual(["talkdesk-telephony"]);
    expect(s.components.find((c) => c.component === "talkdesk-telephony")).toMatchObject({ kind: "local_fixture", integrationId: "talkdesk-telephony", label: expect.stringContaining("LOCAL FIXTURE") });
  });

  it("[OPS-04] registration fails closed: invalid kind, missing integration id or health, duplicates and late registration", () => {
    const r = new AdapterRegistry();
    const ok: Adapter = { kind: "live", integrationId: "billing", health: async () => ({ healthy: true, reasonCode: null }) };
    r.register("billing", ok);
    expect(() => r.register("billing", ok)).toThrow(expect.objectContaining({ reasonCode: "ADAPTER_COMPONENT_DUPLICATE" }));
    expect(() => r.register("claims", { ...ok, kind: "production" } as never)).toThrow(expect.objectContaining({ reasonCode: "ADAPTER_KIND_INVALID" }));
    expect(() => r.register("claims", { ...ok, kind: undefined } as never)).toThrow(ValidationError);
    expect(() => r.register("claims", { ...ok, integrationId: "" })).toThrow(expect.objectContaining({ reasonCode: "ADAPTER_INTEGRATION_ID_INVALID" }));
    expect(() => r.register("claims", { kind: "live", integrationId: "claims" } as never)).toThrow(expect.objectContaining({ reasonCode: "ADAPTER_HEALTH_MISSING" }));
    expect(() => r.register("Claims Adapter", ok)).toThrow(expect.objectContaining({ reasonCode: "ADAPTER_COMPONENT_INVALID" }));
    r.freeze();
    expect(() => r.register("claims", { ...ok, integrationId: "claims" })).toThrow(expect.objectContaining({ reasonCode: "ADAPTER_REGISTRY_FROZEN" }));
    expect(() => r.get("claims")).toThrow(expect.objectContaining({ reasonCode: "ADAPTER_NOT_REGISTERED" }));
    expect(r.summary().frozen).toBe(true);
  });

  it("[OPS-03] health report fails closed for throwing, slow or malformed health checks", async () => {
    const r = new AdapterRegistry();
    r.register("billing", { kind: "live", integrationId: "billing", health: async () => Promise.reject(new Error("boom")) });
    r.register("claims", { kind: "live", integrationId: "claims", health: () => new Promise(() => undefined) });
    r.register("scheduling", { kind: "live", integrationId: "scheduling", health: async () => ({ healthy: "yes" }) as never });
    r.register("provider-system", { kind: "live", integrationId: "provider-system", health: async () => ({ healthy: true, reasonCode: null }) });
    const rows = await r.healthReport(50);
    expect(rows.map((x) => [x.component, x.healthy, x.reasonCode])).toEqual([
      ["billing", false, "HEALTH_CHECK_FAILED"],
      ["claims", false, "HEALTH_CHECK_TIMEOUT"],
      ["provider-system", true, null],
      ["scheduling", false, "HEALTH_CHECK_INVALID"],
    ]);
  });

  it("[SPEC-14.faults] the fixture set shares one store and one fault injector across adapters", async () => {
    const set = createLocalFixtureSet({ clock: new FakeClock() });
    set.faults.inject({ integrationId: "salesforce", operation: "*", kind: "OUTAGE", mode: "persistent" });
    const health = await set.registry.healthReport();
    expect(health.find((h) => h.component === "salesforce")).toMatchObject({ healthy: false, reasonCode: "DEPENDENCY_UNAVAILABLE" });
    expect(health.filter((h) => h.healthy)).toHaveLength(OWNED.length - 1);
    expect(set.registry.frozen).toBe(true);
  });
});
