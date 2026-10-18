/**
 * Startup egress check (DATA-01, OPS-04) and its composition in the container.
 * TEST-ONLY destinations on reserved `.invalid` hosts and loopback, with TEST-ONLY coverage
 * references (no BAA, coverage record or approval exists for any of them); SYNTHETIC text only.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildBusiness } from "../business/index.js";
import type { AdapterConfig, PlatformConfig } from "../config/ports.js";
import { loadPlatformConfig } from "../config/loader.js";
import { PgliteDb } from "../db/pglite.js";
import { buildContainer } from "../main/container.js";
import type { Container } from "../main/container.js";
import { createMemoryLogger } from "../observability/logger.js";
import { FakeClock } from "../shared/clock.js";
import { ConfigurationRejectedError } from "../shared/errors.js";
import type { EgressDestination, EgressPolicyConfig } from "./egress.js";
import { LOCAL_FIXTURE_EGRESS_POLICY, assertStartupEgress, checkStartupEgress, egressTargetsFor } from "./egress-startup.js";

let c: Container | null = null;
afterEach(async () => {
  vi.restoreAllMocks();
  await c?.close();
  c = null;
});

const START = "2026-10-18T09:00:00.000Z";

/** TEST-ONLY destination (not an approved destination; references are labelled placeholders). */
function dest(over: Partial<EgressDestination> & Pick<EgressDestination, "destinationId" | "kind" | "hosts" | "allowedClasses">): EgressDestination {
  return { coverage: { baaRef: null, approvalId: null }, environments: ["sandbox"], adapterKind: "live", ...over };
}

const SANDBOX_TEST_POLICY: EgressPolicyConfig = {
  policyVersion: "egress-startup-test.1",
  destinations: [
    dest({ destinationId: "egr_crm_test_only", kind: "SYSTEM_OF_RECORD", hosts: ["crm.sandbox.invalid"], allowedClasses: ["PHI", "INTERNAL"], coverage: { baaRef: "TEST-ONLY-BAA-REF", approvalId: "apr_testOnlyCrmStartup01" } }),
    dest({ destinationId: "egr_idp_test_only", kind: "VERIFICATION_SERVICE", hosts: ["idp.sandbox.invalid"], allowedClasses: ["INTERNAL"] }),
    dest({ destinationId: "egr_otel_test_only", kind: "TELEMETRY_EXPORTER", hosts: ["otel.sandbox.invalid"], allowedClasses: ["INTERNAL"] }),
  ],
};

const withEndpoints = (config: PlatformConfig, endpoints: Record<string, string | null>): PlatformConfig => ({
  ...config,
  adapters: Object.fromEntries(Object.entries(config.adapters).map(([k, a]) => [k, { ...(a as AdapterConfig), endpoint: k in endpoints ? (endpoints[k] ?? null) : a.endpoint }])),
});

describe("startup egress check", () => {
  it("[DATA-01][OPS-04] the committed sandbox, staging and production configurations fail closed: no egress policy, live adapters without a declared endpoint, an undeclared audit sink", () => {
    for (const environment of ["sandbox", "staging", "production"] as const) {
      const { config } = loadPlatformConfig({ environment, env: {} });
      const report = checkStartupEgress({ environment, policy: null, targets: egressTargetsFor(config) });
      expect(report.violations).toContain("EGRESS_POLICY_NOT_CONFIGURED@egress");
      for (const key of Object.keys(config.adapters)) expect(report.violations, `${environment} ${key}`).toContain(`EGRESS_ENDPOINT_UNDECLARED@adapters.${key}.endpoint`);
      expect(report.violations).toContain("EGRESS_ENDPOINT_UNDECLARED@audit.sink");
      expect(report.targets.every((t) => t.status === "DENIED")).toBe(true);
      expect(() => assertStartupEgress(report)).toThrow(ConfigurationRejectedError);
    }
  });

  it("[DATA-01] PHI-bearing adapters need a PHI-capable destination with coverage and approval; content-free ones a content-free class; telemetry exports a telemetry destination; https and no PHI in URLs", () => {
    const { config } = loadPlatformConfig({ environment: "sandbox", env: {} });
    const configured = withEndpoints(config, {
      salesforce: "https://crm.sandbox.invalid/services/data",
      "oidc-client-idp": "https://idp.sandbox.invalid/.well-known/openid-configuration",
      scheduling: "https://otel.sandbox.invalid/v1/scheduling", // PHI adapter pointed at a telemetry exporter
      billing: "http://crm.sandbox.invalid/billing", // not https
      claims: "https://crm.sandbox.invalid/members/555-01-0199", // PHI-like path
    });
    const report = checkStartupEgress({
      environment: "sandbox",
      policy: SANDBOX_TEST_POLICY,
      targets: egressTargetsFor(configured, [
        { ref: "otel_metrics", url: "https://otel.sandbox.invalid/v1/metrics" },
        { ref: "analytics_export", url: "https://crm.sandbox.invalid/export" },
      ]),
    });
    const byRef = Object.fromEntries(report.targets.map((t) => [t.ref, t]));
    expect(byRef["adapters.salesforce.endpoint"]).toMatchObject({ status: "ALLOWED", destinationId: "egr_crm_test_only" });
    expect(byRef["adapters.oidc-client-idp.endpoint"]).toMatchObject({ status: "ALLOWED", destinationId: "egr_idp_test_only" });
    expect(byRef["telemetry.otel_metrics"]).toMatchObject({ status: "ALLOWED", destinationId: "egr_otel_test_only" });
    expect(report.violations).toEqual(
      expect.arrayContaining([
        "EGRESS_PHI_TO_CONTENT_FREE_DESTINATION@adapters.scheduling.endpoint",
        "EGRESS_URL_INSECURE@adapters.billing.endpoint",
        "EGRESS_URL_CONTAINS_SENSITIVE_PATTERN@adapters.claims.endpoint",
        "EGRESS_NOT_A_TELEMETRY_DESTINATION@telemetry.analytics_export",
        "EGRESS_ENDPOINT_UNDECLARED@adapters.notifications.endpoint",
        "EGRESS_ENDPOINT_UNDECLARED@audit.sink",
      ]),
    );
    expect(report.violations).not.toContain("EGRESS_POLICY_NOT_CONFIGURED@egress");
    // Reason codes and config paths only: no URL, host or path content in the report.
    expect(JSON.stringify(report)).not.toContain("555-01-0199");
    expect(JSON.stringify(report)).not.toContain("invalid/");
  });

  it("[DATA-01][OPS-04] a policy that violates a hard rule is refused at construction (never silently narrowed)", () => {
    const bad: EgressPolicyConfig = { policyVersion: "bad.1", destinations: [dest({ destinationId: "egr_otel_phi", kind: "TELEMETRY_EXPORTER", hosts: ["otel.sandbox.invalid"], allowedClasses: ["PHI"] })] };
    expect(() => checkStartupEgress({ environment: "sandbox", policy: bad, targets: [] })).toThrow(ConfigurationRejectedError);
  });
});

describe("egress guard and redaction service in the local composition", () => {
  it("[DATA-01][SPEC-6.redaction] local/ci: every adapter is an in-process fixture, the LOCAL FIXTURE policy approves nothing, and a quarantined artifact is never sent anywhere", async () => {
    c = await buildContainer({ environment: "local", buildBusiness, clock: new FakeClock(START), env: {}, logger: createMemoryLogger().logger, rateLimit: null, ingestKnowledge: false });
    const report = c.privacy.egressReport;
    expect(report.violations).toEqual([]);
    expect(report.policyVersion).toBe(LOCAL_FIXTURE_EGRESS_POLICY.policyVersion);
    expect(report.targets.length).toBeGreaterThan(5);
    expect(report.targets.every((t) => t.status === "IN_PROCESS_FIXTURE")).toBe(true);
    expect(c.privacy.egress.list()).toEqual([]);

    const redacted = await c.privacy.redaction.process({ artifactId: "art_synthStartupRedact01", text: "Please call 555-010-0101 about rescheduling" });
    expect(redacted.result.status).toBe("REDACTED");
    expect(redacted.result.redacted).not.toContain("555-010-0101");
    expect(redacted.classification.classification).toBe("PHI");
    const quarantined = await c.privacy.redaction.process({ artifactId: "art_synthStartupRedact02", text: "my name is Jordan" });
    expect(quarantined.result).toMatchObject({ status: "QUARANTINED", redacted: null });
    expect(quarantined.quarantine).toMatchObject({ stored: false, reasonCode: "QUARANTINE_STORE_NOT_APPROVED" });
    expect(c.metrics.counterValue("vsp_redaction_results_total", { result: "quarantined" })).toBe(1);
    expect(c.metrics.counterValue("vsp_egress_denied_total", { reason: "EGRESS_DESTINATION_UNKNOWN" })).toBe(1);
  }, 120_000);

  it("[DATA-01][OPS-04] a composed telemetry export outside the egress policy refuses startup before any database exists; an allowlisted one is accepted", async () => {
    const createDb = vi.spyOn(PgliteDb, "create");
    const opts = { environment: "local" as const, buildBusiness, clock: new FakeClock(START), env: {}, logger: createMemoryLogger().logger, rateLimit: null, ingestKnowledge: false };
    const refused = await buildContainer({ ...opts, telemetryExports: [{ ref: "otel_metrics", url: "https://otel.collector.invalid/v1/metrics" }] }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(refused).toBeInstanceOf(ConfigurationRejectedError);
    expect((refused as ConfigurationRejectedError).violations).toEqual(["EGRESS_DESTINATION_UNKNOWN@telemetry.otel_metrics"]);
    expect(createDb).not.toHaveBeenCalled();

    const localPolicy: EgressPolicyConfig = {
      policyVersion: "egress-local-test.1",
      destinations: [{ destinationId: "egr_otel_loopback", kind: "TELEMETRY_EXPORTER", hosts: ["127.0.0.1:4318"], allowedClasses: ["INTERNAL"], coverage: { baaRef: null, approvalId: null }, environments: ["local"], adapterKind: "local_fixture" }],
    };
    c = await buildContainer({ ...opts, egressPolicy: localPolicy, telemetryExports: [{ ref: "otel_metrics", url: "http://127.0.0.1:4318/v1/metrics" }] });
    expect(c.privacy.egressReport.targets.find((t) => t.ref === "telemetry.otel_metrics")).toMatchObject({ status: "ALLOWED", destinationId: "egr_otel_loopback" });
  }, 120_000);
});
