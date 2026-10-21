/**
 * Guard ports of NOT_CONFIGURED capabilities (WP-07; FO-21-10, FO-00-26): every operation fails closed with the
 * reason-coded refusal (never canned success, an empty list, a TEST id or "not implemented"), is counted and
 * logged for the paging alarm; health is unhealthy; the port is not a thenable and cannot be mutated.
 */
import { describe, expect, it } from "vitest";
import { createPlatformMetricCatalogue } from "../../observability/catalog/index.js";
import { createMemoryLogger } from "../../observability/logger.js";
import { InMemoryMetrics } from "../../observability/metrics.js";
import type { SchedulingSystem } from "../ports.js";
import { CAPABILITY_NOT_CONFIGURED, CapabilityNotConfiguredError, isGuardPort, notConfiguredOperation, notConfiguredPort } from "./not-configured.js";
import { PgTransferStore } from "./pg-transfer-store.js";
import type { Db } from "../../db/types.js";

describe("NOT_CONFIGURED guard ports [FO-21-10]", () => {
  it("[FO-21-10][OPS-01] every operation refuses CAPABILITY_NOT_CONFIGURED (NOT_STARTED, not retryable), counted and logged; health reports it", async () => {
    const metrics = new InMemoryMetrics({ catalogue: createPlatformMetricCatalogue({ toolNames: [] }) });
    const { logger, records } = createMemoryLogger();
    const port = notConfiguredPort<SchedulingSystem>({ capabilityId: "domain.business_systems", component: "scheduling", integrationId: "scheduling", metrics, logger });
    const calls: (() => Promise<unknown>)[] = [() => port.listAppointments("sub_synthSubject00000001"), () => port.getAppointment("apt_synthAppointment0001"), () => port.findByIdempotencyKey("k")];
    for (const call of calls) {
      const err = await call().then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(CapabilityNotConfiguredError);
      expect(err).toMatchObject({ reasonCode: CAPABILITY_NOT_CONFIGURED, outcome: "NOT_STARTED", retryable: false, capabilityId: "domain.business_systems" });
    }
    expect(metrics.counterValue("vsp_capability_not_configured_reached_total", { capability: "domain.business_systems" })).toBe(3);
    expect(records.filter((r) => r.event === "capability.guard_port_reached" && r.level === "error")).toHaveLength(3);
    expect(await port.health()).toEqual({ healthy: false, reasonCode: CAPABILITY_NOT_CONFIGURED });
    expect([port.kind, port.integrationId, isGuardPort(port)]).toEqual(["live", "scheduling", true]);
  });

  it("[FO-21-10] adversarial: not a thenable, not mutable, plain declared properties only; content never reaches the log", async () => {
    const { logger, records } = createMemoryLogger();
    const port = notConfiguredPort<{ destinationId: string; put(x: string): Promise<void> }>({ capabilityId: "privacy.operations", component: "quarantine-store", integrationId: "quarantine-store", logger, props: { destinationId: "egr_quarantine_not_configured" } });
    expect(await Promise.resolve(port)).toBe(port);
    expect(port.destinationId).toBe("egr_quarantine_not_configured");
    expect(() => Object.assign(port, { destinationId: "x" })).toThrow();
    await expect(port.put("caller said something private")).rejects.toThrow(CAPABILITY_NOT_CONFIGURED);
    expect(JSON.stringify(records)).not.toContain("private");
    expect(JSON.stringify(port)).toBe('{"notConfigured":true,"capabilityId":"privacy.operations","component":"quarantine-store"}');
    expect(() => notConfiguredPort({ capabilityId: "privacy.operations", component: "Bad Component", integrationId: "x" })).toThrow("GUARD_PORT_COMPONENT_INVALID");
  });

  it("[FO-21-10][OPS-01] adversarial: coercing a guard port to a string (template literal, String(), concatenation) describes it and never starts an operation (no unhandled rejection, nothing counted)", async () => {
    const metrics = new InMemoryMetrics({ catalogue: createPlatformMetricCatalogue() });
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      const port = notConfiguredPort<SchedulingSystem>({ capabilityId: "contact_center.talkdesk", component: "talkdesk-telephony", integrationId: "talkdesk-telephony", metrics });
      expect(`${port as unknown as string}`).toBe("[NOT_CONFIGURED talkdesk-telephony]");
      expect(String(port)).toBe("[NOT_CONFIGURED talkdesk-telephony]");
      expect((port as unknown as string) + "").toBe("[NOT_CONFIGURED talkdesk-telephony]");
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toEqual([]);
      expect(metrics.counterValue("vsp_capability_not_configured_reached_total", { capability: "contact_center.talkdesk" })).toBe(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("[OPS-01] failure: a throwing metrics sink still refuses (the refusal never depends on telemetry)", async () => {
    const port = notConfiguredPort<SchedulingSystem>({ capabilityId: "domain.business_systems", component: "scheduling", integrationId: "scheduling", metrics: { increment: () => { throw new Error("down"); }, observe: () => undefined, gauge: () => undefined } });
    await expect(port.listAppointments("sub_synthSubject00000001")).rejects.toBeInstanceOf(CapabilityNotConfiguredError);
  });

  it("[FO-21-10][OPS-01] a guard OPERATION (a resolver function, e.g. the call-session integration identity) refuses, counts and pages like a port; it never answers null", async () => {
    const metrics = new InMemoryMetrics({ catalogue: createPlatformMetricCatalogue({ toolNames: [] }) });
    const { logger, records } = createMemoryLogger();
    const op = notConfiguredOperation<[], null>({ capabilityId: "contact_center.talkdesk", component: "talkdesk-telephony", integrationId: "talkdesk-telephony", metrics, logger }, "callSessionIntegration");
    const err = await op().then((v) => ({ answered: v }), (e: unknown) => e);
    expect(err).toBeInstanceOf(CapabilityNotConfiguredError);
    expect(metrics.counterValue("vsp_capability_not_configured_reached_total", { capability: "contact_center.talkdesk" })).toBe(1);
    expect(records.filter((r) => r.event === "capability.guard_port_reached").map((r) => r.fields?.action)).toEqual(["callSessionIntegration"]);
    expect(isGuardPort(op)).toBe(true);
    expect(await op.health()).toEqual({ healthy: false, reasonCode: CAPABILITY_NOT_CONFIGURED });
    expect(Object.isFrozen(op)).toBe(true);
    expect(() => notConfiguredOperation({ capabilityId: "contact_center.talkdesk", component: "Bad Name", integrationId: "x" }, "op")).toThrow(TypeError);
  });
});

describe("PgTransferStore read-only console role [FO-03-49][AUTH-02]", () => {
  it("[AUTH-02] under app_console the store refuses every write before any statement (least privilege of the console unit)", async () => {
    const statements: string[] = [];
    // UNIT FAKE (labelled): records whether the store reached the database at all.
    const db = { tx: async () => { statements.push("tx"); return []; } } as unknown as Db;
    const reader = new PgTransferStore({ db, tenantId: "tnt_synthTenantConnector01", role: "app_console" });
    expect(reader.readOnly).toBe(true);
    const journey = { tenantId: "tnt_synthTenantConnector01", handoffId: "hnd_synthHandoff000000001", callId: "cal-1", version: 1, attempts: [], routePlan: [] } as never;
    await expect(reader.put(journey, null)).rejects.toMatchObject({ reasonCode: "TRANSFER_STORE_READ_ONLY", outcome: "NOT_STARTED" });
    await expect(reader.put(journey, 1)).rejects.toMatchObject({ reasonCode: "TRANSFER_STORE_READ_ONLY" });
    expect(statements).toEqual([]);
    expect(new PgTransferStore({ db, tenantId: "tnt_synthTenantConnector01", role: "app_runtime" }).readOnly).toBe(false);
  });
});
