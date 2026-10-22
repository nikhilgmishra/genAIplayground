/**
 * Model endpoint classes of the egress allowlist (WP-08; DATA-01, FO-09-45, FO-19-09, prompt section 9: "an
 * unavailable model cannot silently fall back to an unapproved region, endpoint, provider ... or retention policy").
 * Hosts are reserved `.test` names; approval ids and BAA references are SYNTHETIC.
 */
import { describe, expect, it } from "vitest";
import { InMemoryMetrics, createMetricCatalogue } from "../observability/metrics.js";
import { AccessDeniedError, ConfigurationRejectedError } from "../shared/errors.js";
import { checkStartupEgress, egressTargetsFor } from "./egress-startup.js";
import { EgressGuard, MODEL_CLASS_KINDS } from "./egress.js";
import type { EgressDestination, EgressPolicyConfig, ModelEgressBinding } from "./egress.js";
import type { PlatformConfig } from "../config/ports.js";

const OPENAI: ModelEgressBinding = { provider: "openai_responses", region: "us-east-1", retentionPolicyRef: "retention.zero_retention" };
const BEDROCK: ModelEgressBinding = { provider: "bedrock_converse", region: "us-east-1", retentionPolicyRef: "retention.bedrock_no_storage" };
const VLLM: ModelEgressBinding = { provider: "vllm_openai_compatible", region: "us-west-2", retentionPolicyRef: "retention.self_hosted_none" };

function dest(over: Partial<EgressDestination> & Pick<EgressDestination, "destinationId" | "kind" | "hosts" | "allowedClasses">): EgressDestination {
  return { coverage: { baaRef: "SYNTH-BAA-REF", approvalId: "apr_synthModelEgress01" }, environments: ["local", "ci", "sandbox"], adapterKind: "live", ...over };
}

const POLICY: EgressPolicyConfig = {
  policyVersion: "egress-models-test.1",
  destinations: [
    dest({ destinationId: "egr_openai_api", kind: "MODEL_PROVIDER_API", hosts: ["api.openai.models.test"], allowedClasses: ["INTERNAL", "PHI"], model: OPENAI }),
    dest({ destinationId: "egr_bedrock_api", kind: "MODEL_PROVIDER_API", hosts: ["bedrock-runtime.us-east-1.models.test"], allowedClasses: ["INTERNAL"], model: BEDROCK }),
    dest({ destinationId: "egr_vllm_private", kind: "MODEL_SELF_HOSTED", hosts: ["vllm.private.models.test"], allowedClasses: ["INTERNAL", "PHI"], model: VLLM }),
    dest({ destinationId: "egr_generic_model", kind: "MODEL_ENDPOINT", hosts: ["generic.models.test"], allowedClasses: ["INTERNAL"] }),
    dest({ destinationId: "egr_crm_record", kind: "SYSTEM_OF_RECORD", hosts: ["crm.models.test"], allowedClasses: ["INTERNAL", "PHI"] }),
  ],
};

describe("model endpoint classes of the egress guard [DATA-01][FO-09-45]", () => {
  it("[DATA-01] positive: each adapter binding reaches only its own approved model-class destination", () => {
    const g = new EgressGuard(POLICY, { environment: "sandbox" });
    expect(MODEL_CLASS_KINDS.has("MODEL_PROVIDER_API") && MODEL_CLASS_KINDS.has("MODEL_SELF_HOSTED") && !MODEL_CLASS_KINDS.has("MODEL_ENDPOINT")).toBe(true);
    expect(g.checkModelEndpoint("https://api.openai.models.test/v1/responses", "PHI", OPENAI)).toEqual({ allowed: true, reasonCode: "EGRESS_ALLOWED", destinationId: "egr_openai_api" });
    expect(g.assertModelEndpoint("https://bedrock-runtime.us-east-1.models.test/model/m/converse-stream", "INTERNAL", BEDROCK).destinationId).toBe("egr_bedrock_api");
    expect(g.forModelEndpoint(VLLM).assertAllowed(new URL("https://vllm.private.models.test/v1/chat/completions"), "PHI").kind).toBe("MODEL_SELF_HOSTED");
  });

  it("[DATA-01] adversarial: no silent fallback to another provider, region or retention policy, and no non-model destination", () => {
    const metrics = new InMemoryMetrics({ catalogue: createMetricCatalogue() });
    const g = new EgressGuard(POLICY, { environment: "sandbox", metrics });
    const cases: [string, ModelEgressBinding, string][] = [
      ["https://api.openai.models.test/v1/responses", { ...OPENAI, provider: "vllm_openai_compatible" }, "EGRESS_MODEL_PROVIDER_NOT_APPROVED"],
      ["https://api.openai.models.test/v1/responses", { ...OPENAI, region: "eu-west-1" }, "EGRESS_MODEL_REGION_NOT_APPROVED"],
      ["https://api.openai.models.test/v1/responses", { ...OPENAI, retentionPolicyRef: "retention.provider_default" }, "EGRESS_MODEL_RETENTION_NOT_APPROVED"],
      // A model request aimed at a system of record or at the generic connector model kind is refused.
      ["https://crm.models.test/v1/responses", OPENAI, "EGRESS_NOT_A_MODEL_ENDPOINT"],
      ["https://generic.models.test/v1/responses", OPENAI, "EGRESS_NOT_A_MODEL_ENDPOINT"],
      // An unknown host stays unknown; PHI to a destination approved for INTERNAL only is refused first.
      ["https://fallback.models.test/v1/responses", OPENAI, "EGRESS_DESTINATION_UNKNOWN"],
      ["https://bedrock-runtime.us-east-1.models.test/model/m/converse-stream", BEDROCK, "EGRESS_PHI_NOT_APPROVED_FOR_DESTINATION"],
    ];
    for (const [target, binding, code] of cases) {
      const cls = code === "EGRESS_PHI_NOT_APPROVED_FOR_DESTINATION" ? "PHI" : "INTERNAL";
      expect(g.checkModelEndpoint(target, cls, binding), `${target} ${code}`).toMatchObject({ allowed: false, reasonCode: code });
      expect(() => g.forModelEndpoint(binding).assertAllowed(new URL(target), cls)).toThrow(AccessDeniedError);
    }
    // Verification secrets never reach any model class (AUTH-06).
    expect(g.checkModelEndpoint("https://api.openai.models.test/v1/responses", "VERIFICATION_SECRET", OPENAI).allowed).toBe(false);
    // Every refusal is counted (content-free reason label).
    expect(metrics.counterValue("vsp_egress_denied_total")).toBeGreaterThanOrEqual(cases.length * 2);
  });

  it("[DATA-01][OPS-05] peekModelEndpoint decides exactly as checkModelEndpoint but counts nothing (one refused payload is counted once)", () => {
    const metrics = new InMemoryMetrics({ catalogue: createMetricCatalogue() });
    const g = new EgressGuard(POLICY, { environment: "sandbox", metrics });
    const probes: [string, "INTERNAL" | "PHI" | "VERIFICATION_SECRET", ModelEgressBinding][] = [
      ["https://api.openai.models.test/v1/responses", "PHI", OPENAI],
      ["https://api.openai.models.test/v1/responses", "INTERNAL", { ...OPENAI, region: "eu-west-1" }],
      ["https://crm.models.test/v1/responses", "INTERNAL", OPENAI],
      ["https://bedrock-runtime.us-east-1.models.test/model/m/converse-stream", "PHI", BEDROCK],
      ["https://fallback.models.test/v1/responses", "INTERNAL", OPENAI],
      ["https://api.openai.models.test/v1/responses", "VERIFICATION_SECRET", OPENAI],
    ];
    const peeked = probes.map(([t, c, b]) => g.peekModelEndpoint(t, c, b));
    expect(metrics.counterValue("vsp_egress_denied_total")).toBe(0);
    const checked = probes.map(([t, c, b]) => g.checkModelEndpoint(t, c, b));
    expect(peeked).toEqual(checked);
    expect(peeked.filter((d) => !d.allowed)).toHaveLength(5);
    expect(metrics.counterValue("vsp_egress_denied_total")).toBe(5);
  });

  it("[DATA-01] a bound check cannot be widened after construction, and an invalid binding is refused", () => {
    const g = new EgressGuard(POLICY, { environment: "sandbox" });
    const binding = { ...OPENAI };
    const check = g.forModelEndpoint(binding);
    binding.region = "eu-west-1";
    expect(check.binding.region).toBe("us-east-1");
    expect(Object.isFrozen(check.binding)).toBe(true);
    expect(() => g.forModelEndpoint({ provider: "OpenAI!", region: "us-east-1", retentionPolicyRef: "r.x" })).toThrow(ConfigurationRejectedError);
  });

  it("[DATA-01][OPS-04] hard rules: a model class without terms, terms on another kind, or a local region outside local/ci is refused", () => {
    const bad: EgressDestination[] = [
      dest({ destinationId: "egr_no_terms", kind: "MODEL_PROVIDER_API", hosts: ["a.models.test"], allowedClasses: ["INTERNAL"] }),
      dest({ destinationId: "egr_terms_on_crm", kind: "SYSTEM_OF_RECORD", hosts: ["b.models.test"], allowedClasses: ["INTERNAL"], model: OPENAI }),
      dest({ destinationId: "egr_local_region", kind: "MODEL_SELF_HOSTED", hosts: ["c.models.test"], allowedClasses: ["INTERNAL"], model: { ...VLLM, region: "local" }, environments: ["local", "sandbox"] }),
      dest({ destinationId: "egr_model_phi_nobaa", kind: "MODEL_PROVIDER_API", hosts: ["d.models.test"], allowedClasses: ["PHI"], model: OPENAI, coverage: { baaRef: null, approvalId: "apr_synthModelEgress01" } }),
    ];
    for (const d of bad) expect(() => new EgressGuard({ policyVersion: "x", destinations: [d] }, { environment: "sandbox" }), d.destinationId).toThrow(ConfigurationRejectedError);
    // A local region is fine for a local/ci emulator destination.
    expect(() => new EgressGuard({ policyVersion: "x", destinations: [dest({ destinationId: "egr_emulator", kind: "MODEL_PROVIDER_API", hosts: ["e.models.test"], allowedClasses: ["INTERNAL"], model: { ...OPENAI, region: "local" }, environments: ["local", "ci"] })] }, { environment: "local" })).not.toThrow();
  });

  it("[DATA-01] startup: a composed model endpoint must be a model class approved for its binding, or the process refuses to start", () => {
    const config = { environment: "sandbox", adapters: {}, audit: { sink: "s3_object_lock" }, gateway: {} } as unknown as PlatformConfig;
    const ok = egressTargetsFor(config, [], [{ ref: "planner_primary", url: "https://api.openai.models.test/v1/responses", dataClass: "PHI", binding: OPENAI }]);
    const report = checkStartupEgress({ environment: "sandbox", policy: { ...POLICY, destinations: [...POLICY.destinations, dest({ destinationId: "egr_audit", kind: "AUDIT_SINK", hosts: ["audit.models.test"], allowedClasses: ["INTERNAL"] })] }, targets: ok.filter((t) => t.kind === "model_endpoint") });
    expect(report.targets).toEqual([{ ref: "models.planner_primary", kind: "model_endpoint", status: "ALLOWED", reasonCode: "EGRESS_ALLOWED", destinationId: "egr_openai_api" }]);
    const wrongRegion = egressTargetsFor(config, [], [{ ref: "planner_primary", url: "https://api.openai.models.test/v1/responses", dataClass: "PHI", binding: { ...OPENAI, region: "eu-west-1" } }]);
    const refused = checkStartupEgress({ environment: "sandbox", policy: POLICY, targets: wrongRegion.filter((t) => t.kind === "model_endpoint") });
    expect(refused.violations).toEqual(["EGRESS_MODEL_REGION_NOT_APPROVED@models.planner_primary"]);
    const crm = egressTargetsFor(config, [], [{ ref: "router", url: "https://crm.models.test/v1/responses", dataClass: "INTERNAL", binding: OPENAI }]);
    expect(checkStartupEgress({ environment: "sandbox", policy: POLICY, targets: crm.filter((t) => t.kind === "model_endpoint") }).violations).toEqual(["EGRESS_NOT_A_MODEL_ENDPOINT@models.router"]);
    expect(() => egressTargetsFor(config, [], [{ ref: "Bad Ref", url: "https://api.openai.models.test/", dataClass: "INTERNAL", binding: OPENAI }])).toThrow(ConfigurationRejectedError);
  });
});
