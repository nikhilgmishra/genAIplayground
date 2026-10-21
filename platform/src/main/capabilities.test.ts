/**
 * Per-capability activation map (WP-07; FO-00-26, FO-00-30, FO-19-06): ids and owners match the capability
 * catalogue; software gaps, tenant inputs and composition reasons are kept apart; any doubt is NOT_CONFIGURED.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { REPO_ROOT } from "../config/loader.js";
import { createPlatformMetricCatalogue } from "../observability/catalog/index.js";
import { RUNTIME_CAPABILITY_IDS } from "../observability/composition-catalog.js";
import { InMemoryMetrics } from "../observability/metrics.js";
import { CAPABILITY_REGISTER, auditIndependentFact, buildActivationMap } from "./capabilities.js";

const composedAll = Object.fromEntries(RUNTIME_CAPABILITY_IDS.map((id) => [id, { composed: true }]));

describe("activation map [FO-00-30][FO-19-06]", () => {
  it("[FO-00-30] every runtime capability is a catalogue id with the catalogue's owners and activation inputs", () => {
    const doc = YAML.parse(readFileSync(join(REPO_ROOT, "docs/followon/capabilities.yaml"), "utf8")) as { capabilities: { id: string; owningPackages: string[]; activationIds: string[] }[] };
    for (const id of RUNTIME_CAPABILITY_IDS) {
      const c = doc.capabilities.find((x) => x.id === id);
      expect(c, id).toBeDefined();
      expect(CAPABILITY_REGISTER[id], id).toEqual({ owners: c?.owningPackages, activationIds: c?.activationIds });
    }
  });

  it("[FO-00-30] positive: guard components, composition reasons and software gaps each make a capability NOT_CONFIGURED, separately reported", () => {
    const map = buildActivationMap(
      {
        components: [
          { component: "salesforce", capabilityId: "crm.salesforce", state: "NOT_CONFIGURED", reasons: ["ADAPTER_ENDPOINT_MISSING@adapters.salesforce.endpoint"] },
          { component: "scheduling", capabilityId: "domain.business_systems", state: "CONFIGURED", reasons: [] },
        ],
      },
      { ...composedAll, "domain.business_systems": { composed: false, softwareGaps: [{ owner: "WP-23", reasonCode: "DOMAIN_LIVE_ADAPTERS_MISSING" }] }, "knowledge.retrieval": { composed: false, reasons: ["KNOWLEDGE_NO_APPROVED_ITEMS@knowledge"] } },
    );
    const crm = map.entries().find((e) => e.capabilityId === "crm.salesforce");
    expect(crm).toMatchObject({ state: "NOT_CONFIGURED", reasons: ["ADAPTER_ENDPOINT_MISSING@adapters.salesforce.endpoint"], softwareGaps: [], externalInputs: ["AIN-01", "AIN-09", "AIN-34"] });
    expect(map.entries().find((e) => e.capabilityId === "domain.business_systems")).toMatchObject({ state: "NOT_CONFIGURED", reasons: [], softwareGaps: [{ owner: "WP-23", reasonCode: "DOMAIN_LIVE_ADAPTERS_MISSING" }] });
    expect(map.state("knowledge.retrieval")).toBe("NOT_CONFIGURED");
    expect(map.state("platform.substrate")).toBe("CONFIGURED");
    expect(map.capabilityOfIntegration("salesforce")).toBe("crm.salesforce");
    expect(map.capabilityOfIntegration("unknown-system")).toBeNull();
    expect(map.notConfigured().sort()).toEqual(["crm.salesforce", "domain.business_systems", "knowledge.retrieval"]);
  });

  it("[FO-19-06] adversarial: a capability the composition said nothing about is NOT_CONFIGURED (CAPABILITY_NOT_COMPOSED); health lists ids and states only", () => {
    const map = buildActivationMap({ components: [] }, {});
    expect(map.notConfigured()).toEqual([...RUNTIME_CAPABILITY_IDS]);
    expect(map.entries()[0]?.reasons).toEqual(["CAPABILITY_NOT_COMPOSED"]);
    const health = map.health();
    expect(Object.keys(health[0] ?? {}).sort()).toEqual(["capabilityId", "state"]);
    expect(JSON.stringify(health)).not.toContain("AIN-");
  });

  it("[OPS-01] the gauge exports one series per capability and state; a throwing sink changes nothing", () => {
    const map = buildActivationMap({ components: [] }, { ...composedAll, "crm.salesforce": { composed: false } });
    const metrics = new InMemoryMetrics({ catalogue: createPlatformMetricCatalogue({ toolNames: [] }) });
    map.export(metrics);
    expect(metrics.gaugeValue("vsp_capability_state", { capability: "crm.salesforce", state: "not_configured" })).toBe(1);
    expect(metrics.gaugeValue("vsp_capability_state", { capability: "crm.salesforce", state: "configured" })).toBe(0);
    expect(metrics.gaugeValue("vsp_capability_state", { capability: "platform.substrate", state: "configured" })).toBe(1);
    expect(() => map.export({ gauge: () => { throw new Error("down"); } })).not.toThrow();
  });

  it("[FO-16-11][AUTH-02] audit.independent is CONFIGURED only with the export block, the sink AND the counsel-approved SECURITY_AUDIT retention", () => {
    const sink = { bucket: "vsp-audit-synthetic", expectedBucketOwner: "444455556666", keyPrefix: "audit/", objectLockMode: "COMPLIANCE" as const, kmsKeyId: "alias/vsp-audit" };
    const auditExport = { manifestSigningKeyId: "alias/vsp-manifest", exporterDatabaseRef: "arn:aws:secretsmanager:us-east-1:111122223333:secret:exporter", verifierDatabaseRef: "arn:aws:secretsmanager:us-east-1:111122223333:secret:verifier", trustedManifestKeyIds: ["alias/vsp-manifest"] };
    const infra = { auditSink: sink, auditExport } as unknown as NonNullable<Parameters<typeof auditIndependentFact>[0]["infrastructure"]>;
    const retention = { TRANSIENT_CONVERSATION: 1, BUSINESS_RECORD: 1, RESTRICTED_QA_MEDIA: 1, SECURITY_AUDIT: 2555 };
    expect(auditIndependentFact({ infrastructure: infra, retention })).toEqual({ composed: true });
    // Retention not approved by counsel: the sink would refuse every object (AUDIT_RETENTION_UNAPPROVED).
    expect(auditIndependentFact({ infrastructure: infra, retention: { ...retention, SECURITY_AUDIT: null } })).toEqual({ composed: false, reasons: ["AUDIT_RETENTION_UNAPPROVED@retention.SECURITY_AUDIT"] });
    for (const partial of [{ ...infra, auditExport: null }, { ...infra, auditSink: null }, undefined]) {
      expect(auditIndependentFact({ infrastructure: partial as typeof infra | undefined, retention })).toEqual({ composed: false, reasons: ["AUDIT_EXPORT_NOT_CONFIGURED@infrastructure.auditExport"] });
    }
    // The map reports the retention reason for the capability (and only for it).
    const map = buildActivationMap({ components: [], capabilityViolations: [], notConfiguredCapabilities: [] } as never, { ...composedAll, "audit.independent": auditIndependentFact({ infrastructure: infra, retention: { ...retention, SECURITY_AUDIT: null } }) });
    expect(map.notConfigured()).toEqual(["audit.independent"]);
    expect(map.get("audit.independent")?.reasons).toEqual(["AUDIT_RETENTION_UNAPPROVED@retention.SECURITY_AUDIT"]);
  });
});
