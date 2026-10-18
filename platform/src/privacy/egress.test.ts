import { describe, expect, it } from "vitest";
import { createMemoryLogger } from "../observability/logger.js";
import { AccessDeniedError, ConfigurationRejectedError } from "../shared/errors.js";
import { EgressGuard, urlCarriesSensitivePattern } from "./egress.js";
import type { EgressDestination, EgressPolicyConfig } from "./egress.js";

/** TEST-ONLY synthetic destinations; hosts use reserved .invalid / loopback names. */
function dest(over: Partial<EgressDestination> & Pick<EgressDestination, "destinationId" | "kind" | "hosts" | "allowedClasses">): EgressDestination {
  return {
    coverage: { baaRef: null, approvalId: null },
    environments: ["local", "ci"],
    adapterKind: "local_fixture",
    ...over,
  };
}

const POLICY: EgressPolicyConfig = {
  policyVersion: "egress-test.1",
  destinations: [
    dest({
      destinationId: "egr_crm_record",
      kind: "SYSTEM_OF_RECORD",
      hosts: ["crm.local.invalid"],
      allowedClasses: ["PHI", "INTERNAL", "PUBLIC"],
      coverage: { baaRef: "TEST-ONLY-BAA-REF", approvalId: "apr_testOnlyCrmRecord1" },
    }),
    dest({ destinationId: "egr_otel_local", kind: "TELEMETRY_EXPORTER", hosts: ["127.0.0.1:4318"], allowedClasses: ["INTERNAL"] }),
    dest({ destinationId: "egr_analytics", kind: "ANALYTICS_SINK", hosts: ["analytics.local.invalid"], allowedClasses: ["PUBLIC", "INTERNAL"] }),
    dest({ destinationId: "egr_dev_tool", kind: "DEVELOPER_TOOL", hosts: ["devtool.local.invalid"], allowedClasses: ["PUBLIC"] }),
    dest({
      destinationId: "egr_verifier",
      kind: "VERIFICATION_SERVICE",
      hosts: ["verify.local.invalid"],
      allowedClasses: ["VERIFICATION_SECRET"],
      coverage: { baaRef: null, approvalId: "apr_testOnlyVerifier01" },
    }),
  ],
};

const guard = () => new EgressGuard(POLICY, { environment: "local" });

describe("EgressGuard", () => {
  it("[DATA-01] PHI to an approved, covered system of record is allowed", () => {
    expect(guard().check("https://crm.local.invalid/services/data/case", "PHI")).toEqual({ allowed: true, reasonCode: "EGRESS_ALLOWED", destinationId: "egr_crm_record" });
    expect(guard().assertAllowed({ destinationId: "egr_crm_record" }, "PHI").kind).toBe("SYSTEM_OF_RECORD");
  });

  it("[DATA-01] PHI to an unapproved endpoint, analytics sink, telemetry exporter or developer tool is blocked", () => {
    const g = guard();
    const cases: [string, string][] = [
      ["https://unknown.vendor.invalid/upload", "EGRESS_DESTINATION_UNKNOWN"],
      ["https://analytics.local.invalid/collect", "EGRESS_PHI_TO_CONTENT_FREE_DESTINATION"],
      ["http://127.0.0.1:4318/v1/traces", "EGRESS_PHI_TO_CONTENT_FREE_DESTINATION"],
      ["https://devtool.local.invalid/paste", "EGRESS_PHI_TO_CONTENT_FREE_DESTINATION"],
      ["egr_not_configured", "EGRESS_DESTINATION_UNKNOWN"],
    ];
    for (const [target, code] of cases) {
      for (const cls of ["PHI", "PHI_RESTRICTED"] as const) {
        expect(g.check(target, cls)).toMatchObject({ allowed: false, reasonCode: code });
        expect(() => g.assertAllowed(target, cls)).toThrow(AccessDeniedError);
      }
    }
    // Financial data and verification secrets are equally restricted.
    expect(g.check("https://analytics.local.invalid/collect", "FINANCIAL").allowed).toBe(false);
    expect(g.check("https://crm.local.invalid/x", "VERIFICATION_SECRET").allowed).toBe(false);
    expect(g.check("https://verify.local.invalid/challenge", "VERIFICATION_SECRET").allowed).toBe(true);
  });

  it("[DATA-01] the denial is logged with codes only", () => {
    const { logger, records } = createMemoryLogger();
    const g = new EgressGuard(POLICY, { environment: "local", logger });
    expect(() => g.assertAllowed("https://analytics.local.invalid/collect", "PHI")).toThrow("EGRESS_PHI_TO_CONTENT_FREE_DESTINATION");
    // The configured destination id is a code-defined token; the URL itself is never logged.
    expect(records[0]).toMatchObject({ event: "privacy.egress.denied", fields: { reasonCode: "EGRESS_PHI_TO_CONTENT_FREE_DESTINATION", destinationId: "egr_analytics" } });
    expect(JSON.stringify(records)).not.toContain("analytics.local.invalid");
  });

  it("[DATA-01] configuration that would let PHI reach a content-free or uncovered destination is rejected", () => {
    const bad: EgressPolicyConfig[] = [
      { policyVersion: "x", destinations: [dest({ destinationId: "egr_analytics_phi", kind: "ANALYTICS_SINK", hosts: ["a.local.invalid"], allowedClasses: ["PHI"], coverage: { baaRef: "B", approvalId: "apr_testOnlyAnalytic1" } })] },
      { policyVersion: "x", destinations: [dest({ destinationId: "egr_debug_phi", kind: "DEBUGGING_VENDOR", hosts: ["d.local.invalid"], allowedClasses: ["PHI_RESTRICTED"] })] },
      { policyVersion: "x", destinations: [dest({ destinationId: "egr_model_nobaa", kind: "MODEL_ENDPOINT", hosts: ["m.local.invalid"], allowedClasses: ["PHI"], coverage: { baaRef: null, approvalId: "apr_testOnlyModel0001" } })] },
      { policyVersion: "x", destinations: [dest({ destinationId: "egr_tickets_phi", kind: "SUPPORT_TICKETING", hosts: ["t.local.invalid"], allowedClasses: ["PHI"], coverage: { baaRef: "B", approvalId: "apr_testOnlyTickets01" } })] },
      { policyVersion: "x", destinations: [dest({ destinationId: "egr_crm_secret", kind: "SYSTEM_OF_RECORD", hosts: ["c.local.invalid"], allowedClasses: ["VERIFICATION_SECRET"], coverage: { baaRef: "B", approvalId: "apr_testOnlyCrmSecr01" } })] },
      { policyVersion: "x", destinations: [dest({ destinationId: "egr_bad_host", kind: "ANALYTICS_SINK", hosts: ["*.local.invalid"], allowedClasses: ["INTERNAL"] })] },
    ];
    for (const config of bad) expect(() => new EgressGuard(config, { environment: "local" })).toThrow(ConfigurationRejectedError);
  });

  it("[OPS-04] production rejects local fixture destinations and an environment mismatch denies egress", () => {
    const prod: EgressPolicyConfig = { policyVersion: "x", destinations: [dest({ destinationId: "egr_otel_prod", kind: "TELEMETRY_EXPORTER", hosts: ["otel.local.invalid"], allowedClasses: ["INTERNAL"], environments: ["production"] })] };
    expect(() => new EgressGuard(prod, { environment: "production" })).toThrow(ConfigurationRejectedError);
    const sandboxGuard = new EgressGuard(POLICY, { environment: "sandbox" });
    expect(sandboxGuard.check("https://crm.local.invalid/x", "PHI")).toMatchObject({ allowed: false, reasonCode: "EGRESS_ENVIRONMENT_NOT_APPROVED" });
  });

  it("[SPEC-6.no-phi-in-urls] URLs with userinfo, plain http, unknown ports or PHI-like path/query values are denied", () => {
    const g = guard();
    expect(g.check("https://user:pw@crm.local.invalid/x", "INTERNAL").reasonCode).toBe("EGRESS_URL_USERINFO_FORBIDDEN");
    expect(g.check("http://crm.local.invalid/x", "INTERNAL").reasonCode).toBe("EGRESS_URL_INSECURE");
    expect(g.check("https://crm.local.invalid:8443/x", "INTERNAL").reasonCode).toBe("EGRESS_DESTINATION_UNKNOWN");
    expect(g.check("not a url", "INTERNAL").reasonCode).toBe("EGRESS_URL_INVALID");
    expect(g.check("https://crm.local.invalid/case?phone=555-010-0101", "PHI").reasonCode).toBe("EGRESS_URL_CONTAINS_SENSITIVE_PATTERN");
    expect(g.check("https://crm.local.invalid/case?email=avery%40example.test", "PHI").reasonCode).toBe("EGRESS_URL_CONTAINS_SENSITIVE_PATTERN");
    expect(g.check("https://crm.local.invalid/person/1990-01-01", "PHI").reasonCode).toBe("EGRESS_URL_CONTAINS_SENSITIVE_PATTERN");
    expect(urlCarriesSensitivePattern(new URL("https://crm.local.invalid/case/cas_synthCase0000000001"))).toBe(false);
    expect(urlCarriesSensitivePattern(new URL("https://crm.local.invalid/case/5555550101"))).toBe(true);
    expect(urlCarriesSensitivePattern(new URL("https://crm.local.invalid/case?ref=4111111111111111"))).toBe(true);
    // Loopback http is permitted only for local/ci.
    expect(new EgressGuard(POLICY, { environment: "local" }).check("http://127.0.0.1:4318/v1/metrics", "INTERNAL").allowed).toBe(true);
  });

  it("[DATA-01] telemetry exporters pass content-free records only", () => {
    const g = guard();
    expect(() => g.assertContentFreeTelemetry("egr_otel_local", { event: "tool.invoke", status: "SUCCESS", count: 3 })).not.toThrow();
    expect(() => g.assertContentFreeTelemetry("egr_otel_local", { event: "tool.invoke", note: "caller 555-010-0101" })).toThrow("EGRESS_TELEMETRY_NOT_CONTENT_FREE");
    expect(() => g.assertContentFreeTelemetry("egr_otel_local", { event: "x", note: "avery@example.test" })).toThrow("EGRESS_TELEMETRY_NOT_CONTENT_FREE");
    expect(() => g.assertContentFreeTelemetry("egr_crm_record", { event: "x" })).toThrow("EGRESS_NOT_A_TELEMETRY_DESTINATION");
    expect(() => g.assertContentFreeTelemetry("egr_dev_tool", { event: "x" })).toThrow(AccessDeniedError);
  });
});
