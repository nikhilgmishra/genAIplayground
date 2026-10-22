/**
 * Model endpoint configuration rules (WP-08; OPS-04, OPS-05, DATA-01, FO-16-24): blocking violations, and the
 * CONFIGURED / NOT_CONFIGURED status the composition owner composes from. Synthetic values only.
 */
import { describe, expect, it } from "vitest";
import { endpointConfig, egressPolicyFor } from "../../../test/emulators/models/harness.js";
import { egressBindingFor, invokeUrlFor, modelEndpointGuardViolations } from "./config.js";

const host = "api.openai.config.models.test";

describe("model endpoint guard rules [OPS-04][FO-16-24]", () => {
  it("[FO-16-24] positive: an emulator endpoint with its egress entry is CONFIGURED in local", () => {
    const e = endpointConfig("openai_responses", host);
    const r = modelEndpointGuardViolations([e], { environment: "local", egress: egressPolicyFor([e]) });
    expect(r).toEqual({ violations: [], status: [{ endpointRef: e.endpointRef, provider: "openai_responses", status: "CONFIGURED", reasons: [] }] });
    expect(invokeUrlFor(e).toString()).toBe(`https://${host}/v1/responses`);
    expect(egressBindingFor(e)).toEqual({ provider: "openai_responses", region: "us-east-1", retentionPolicyRef: "retention.emulator_none" });
  });

  it("[FO-16-24][OPS-05] no reviewed credential or no egress entry: NOT_CONFIGURED with the reasons (never composed)", () => {
    const live = endpointConfig("openai_responses", host, { adapterKind: "live", credentialRef: null, environments: ["sandbox"], region: "us-east-1" });
    const r = modelEndpointGuardViolations([live], { environment: "sandbox", egress: { policyVersion: "empty.1", destinations: [] } });
    expect(r.violations).toEqual([]);
    expect(r.status[0]).toMatchObject({ status: "NOT_CONFIGURED", reasons: ["MODEL_CREDENTIAL_NOT_CONFIGURED", "EGRESS_DESTINATION_UNKNOWN"] });
    expect(modelEndpointGuardViolations([live], { environment: "sandbox", egress: null }).status[0]?.reasons).toContain("EGRESS_POLICY_NOT_CONFIGURED");
  });

  it("[OPS-04][AUTH-06] adversarial: an emulator, a local region, a public self-hosted endpoint, http, credentials in the URL, settings of another provider and a verification-secret ceiling refuse a deployed environment", () => {
    const mk = (over: Parameters<typeof endpointConfig>[2], provider: Parameters<typeof endpointConfig>[0] = "openai_responses") => endpointConfig(provider, host, { environments: ["staging"], ...over });
    const cases: [ReturnType<typeof endpointConfig>, string][] = [
      [mk({ adapterKind: "emulator" }), "MODEL_EMULATOR_OUTSIDE_LOCAL"],
      [mk({ adapterKind: "live", region: "local" }), "MODEL_LOCAL_REGION_OUTSIDE_LOCAL"],
      [mk({ adapterKind: "live", baseUrl: `http://${host}` }), "MODEL_ENDPOINT_NOT_HTTPS"],
      [mk({ adapterKind: "live", baseUrl: `https://${host}/?k=v` }), "MODEL_ENDPOINT_URL_NOT_PLAIN"],
      [mk({ adapterKind: "live", network: "PUBLIC_INTERNET" }, "vllm_openai_compatible"), "MODEL_SELF_HOSTED_ON_PUBLIC_NETWORK"],
      [mk({ adapterKind: "live", vllm: { toolParser: "hermes", structuredOutput: "none" } }), "MODEL_VLLM_SETTINGS_ON_OTHER_PROVIDER"],
      [mk({ adapterKind: "live", credentialRef: "aws:task-role" }), "MODEL_TASK_ROLE_ONLY_FOR_BEDROCK"],
      [mk({ adapterKind: "live", credentialRef: "local-fixture:models/synth" }), "MODEL_FIXTURE_CREDENTIAL_OUTSIDE_LOCAL"],
      [mk({ adapterKind: "live", baseUrl: "https://bedrock-runtime.eu-west-1.amazonaws.com", region: "us-east-1" }, "bedrock_converse"), "MODEL_BEDROCK_REGION_MISMATCH"],
      [mk({ adapterKind: "live", maxDataClass: "VERIFICATION_SECRET" }), "MODEL_MAX_DATA_CLASS_SECRET"],
    ];
    for (const [e, code] of cases) expect(modelEndpointGuardViolations([e], { environment: "staging", egress: egressPolicyFor([]) }).violations.join(" "), code).toContain(code);
    const dup = endpointConfig("openai_responses", host);
    expect(modelEndpointGuardViolations([dup, dup], { environment: "local", egress: egressPolicyFor([dup]) }).violations).toContain("MODEL_ENDPOINT_DUPLICATE@models.1.endpointRef");
    expect(modelEndpointGuardViolations([{ provider: "nope" }], { environment: "local", egress: null }).violations).toEqual(["MODEL_ENDPOINTS_CONFIG_INVALID@models"]);
  });

  it("[DATA-01] failure injection: an egress entry approved under other model terms leaves the endpoint NOT_CONFIGURED (no silent fallback)", () => {
    const e = endpointConfig("bedrock_converse", "bedrock-runtime.config.models.test");
    const policy = egressPolicyFor([{ ...e, region: "us-west-2" }]);
    expect(modelEndpointGuardViolations([e], { environment: "local", egress: policy }).status[0]).toMatchObject({ status: "NOT_CONFIGURED", reasons: ["EGRESS_MODEL_REGION_NOT_APPROVED"] });
    const phi = { ...e, maxDataClass: "PHI" as const };
    expect(modelEndpointGuardViolations([phi], { environment: "local", egress: egressPolicyFor([e]) }).status[0]?.reasons).toEqual(["EGRESS_PHI_NOT_APPROVED_FOR_DESTINATION"]);
  });
});
