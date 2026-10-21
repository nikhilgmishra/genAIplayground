/**
 * Per-capability gate (WP-07; FO-00-26, FO-00-30, FO-21-10, SAFE-02): a NOT_CONFIGURED capability's intents are
 * refused at admission (HUMAN_QUEUE continuity, never a canned answer) and its background work is held through
 * the kill-switch snapshot; safety and human routes are never gated. The inner services are unit fakes.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_METRIC_CATALOGUE, InMemoryMetrics } from "../observability/metrics.js";
import { createPlatformMetricCatalogue } from "../observability/catalog/index.js";
import type { RuntimeCapabilityId } from "../observability/composition-catalog.js";
import { CapabilityGatedAdmission, CapabilityHoldKillSwitches, intentIntegrationsFrom } from "./capability-gate.js";
import type { AdmissionController, KillSwitchService, KillSwitchSnapshot } from "./ports.js";

const CAP: Record<string, RuntimeCapabilityId> = { scheduling: "domain.business_systems", salesforce: "crm.salesforce", "identity-directory": "identity.caller", notifications: "notifications.messaging" };
const states = (notConfigured: RuntimeCapabilityId[]) => ({
  isConfigured: (id: RuntimeCapabilityId) => !notConfigured.includes(id),
  capabilityOfIntegration: (i: string) => CAP[i] ?? null,
});
const catalogue = {
  actions: {
    "appointment:read": { intent: "appointment_lookup", integrations: ["scheduling"] },
    "intake:create": { intent: "support_intake", integrations: ["salesforce"] },
    "public:read": { intent: "public_faq", integrations: [] },
    "safety:route": { intent: "safety_handoff", integrations: [] },
    "odd:read": { intent: "odd_lookup", integrations: ["unclassified-system"] },
  },
};

class AdmitAllFake implements AdmissionController {
  calls = 0;
  async admit() {
    this.calls += 1;
    return { admitted: true, continuity: "NONE" as const, reasonCode: "ADMITTED", sessionLeaseId: null };
  }
  async recordCost() {}
}

const input = (workflow: string | null, cls: "PROTECTED_READ" | "SAFETY" | "HUMAN_ROUTE" | "WRITE" = "PROTECTED_READ") => ({ tenantId: "tnt_synthGateTenant000001", class: cls, vendor: "talkdesk", workflow, cohort: "default" });

describe("capability gate [FO-00-30][FO-21-10]", () => {
  it("[FO-00-30][OPS-01] positive: an intent whose integration is CONFIGURED passes to the inner admission; a NOT_CONFIGURED one is refused CAPABILITY_NOT_CONFIGURED with the human route and counted", async () => {
    const metrics = new InMemoryMetrics({ catalogue: createPlatformMetricCatalogue({ toolNames: [] }) });
    const inner = new AdmitAllFake();
    const gate = new CapabilityGatedAdmission(inner, { states: states(["domain.business_systems"]), intentIntegrations: intentIntegrationsFrom(catalogue), metrics });
    expect(await gate.admit(input("support_intake"))).toMatchObject({ admitted: true });
    expect(await gate.admit(input("appointment_lookup"))).toEqual({ admitted: false, continuity: "HUMAN_QUEUE", reasonCode: "CAPABILITY_NOT_CONFIGURED", sessionLeaseId: null });
    expect(inner.calls).toBe(1);
    expect(metrics.counterValue("vsp_capability_refusals_total", { capability: "domain.business_systems", surface: "admission" })).toBe(1);
  });

  it("[SAFE-02] safety and human routes are never gated, whatever is NOT_CONFIGURED", async () => {
    const inner = new AdmitAllFake();
    const gate = new CapabilityGatedAdmission(inner, { states: states(["domain.business_systems", "crm.salesforce", "identity.caller", "knowledge.retrieval"]), intentIntegrations: intentIntegrationsFrom(catalogue) });
    expect(await gate.admit(input("appointment_lookup", "SAFETY"))).toMatchObject({ admitted: true });
    expect(await gate.admit(input("support_intake", "HUMAN_ROUTE"))).toMatchObject({ admitted: true });
    expect(inner.calls).toBe(2);
  });

  it("[FO-21-10] adversarial: an unclassified integration fails closed; a public FAQ needs the knowledge capability", async () => {
    const gate = new CapabilityGatedAdmission(new AdmitAllFake(), { states: states(["knowledge.retrieval"]), intentIntegrations: intentIntegrationsFrom(catalogue) });
    expect((await gate.admit(input("odd_lookup"))).reasonCode).toBe("CAPABILITY_NOT_CONFIGURED");
    expect((await gate.admit(input("public_faq", "PUBLIC" as never))).reasonCode).toBe("CAPABILITY_NOT_CONFIGURED");
  });

  it("[OPS-01] failure: a throwing metrics sink never turns a refusal into an admission", async () => {
    const gate = new CapabilityGatedAdmission(new AdmitAllFake(), {
      states: states(["crm.salesforce"]),
      intentIntegrations: intentIntegrationsFrom(catalogue),
      metrics: { increment: () => { throw new Error("sink down"); }, observe: () => undefined, gauge: () => undefined },
    });
    expect((await gate.admit(input("support_intake"))).admitted).toBe(false);
  });

  it("[FO-00-26] hold: the snapshot lists every NOT_CONFIGURED integration as switched off, read from the map on each call; set/list pass through", async () => {
    const base: KillSwitchSnapshot = { aiAdmission: false, writes: false, outboundNotifications: false, intents: [], integrations: ["billing"], modelVersions: [], voiceVersions: [] };
    const inner: KillSwitchService = { snapshot: async () => base, set: async () => ({}) as never, list: async () => [] };
    let off: RuntimeCapabilityId[] = ["crm.salesforce", "notifications.messaging"];
    const ks = new CapabilityHoldKillSwitches(inner, { states: { isConfigured: (id) => !off.includes(id), capabilityOfIntegration: (i) => CAP[i] ?? null }, integrations: Object.keys(CAP), metrics: new InMemoryMetrics({ catalogue: DEFAULT_METRIC_CATALOGUE }) });
    expect((await ks.snapshot("tnt_synthGateTenant000001")).integrations.sort()).toEqual(["billing", "notifications", "salesforce"]);
    off = [];
    expect((await ks.snapshot("tnt_synthGateTenant000001")).integrations).toEqual(["billing"]);
    expect(await ks.list("tnt_synthGateTenant000001")).toEqual([]);
  });
});
