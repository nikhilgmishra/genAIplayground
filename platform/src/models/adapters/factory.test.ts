/**
 * Model port factory for the composition owner (WP-08; FO-19-09, FO-16-24, OPS-04, DATA-01): only CONFIGURED
 * endpoints are composed, blocking violations refuse, and a NOT_CONFIGURED endpoint has no port and therefore no
 * network path. Startup egress targets are derived from the same configuration.
 */
import { describe, expect, it } from "vitest";
import { EgressGuard } from "../../privacy/egress.js";
import { checkStartupEgress, egressTargetsFor } from "../../privacy/egress-startup.js";
import type { PlatformConfig } from "../../config/ports.js";
import { systemClock } from "../../shared/clock.js";
import { ConfigurationRejectedError } from "../../shared/errors.js";
import { endpointConfig, egressPolicyFor, hostFor } from "../../../test/emulators/models/harness.js";
import { createModelPorts, modelEgressTargets } from "./factory.js";

describe("model port factory [FO-19-09][FO-16-24]", () => {
  it("[FO-16-24] only CONFIGURED endpoints get a port: a live endpoint without a credential reference is reported and not composed", () => {
    const a = endpointConfig("openai_responses", hostFor("openai_responses"));
    const b = endpointConfig("bedrock_converse", hostFor("bedrock_converse"), { adapterKind: "live", credentialRef: null });
    const policy = egressPolicyFor([a, b]);
    const { ports, report } = createModelPorts([a, b], {
      environment: "local",
      egress: new EgressGuard(policy, { environment: "local" }),
      egressPolicy: policy,
      clock: systemClock,
      credentials: (e) => (e.provider === "openai_responses" ? { kind: "bearer", token: async () => "key_synthFactory" } : null),
    });
    expect([...ports.keys()]).toEqual([a.endpointRef]);
    expect(report.status.find((s) => s.endpointRef === b.endpointRef)).toMatchObject({ status: "NOT_CONFIGURED", reasons: ["MODEL_CREDENTIAL_NOT_CONFIGURED"] });
  });

  it("[FO-16-24] a CONFIGURED endpoint whose credential the composition root could not resolve is downgraded, never composed", () => {
    const a = endpointConfig("openai_responses", hostFor("openai_responses"));
    const policy = egressPolicyFor([a]);
    const { ports, report } = createModelPorts([a], { environment: "local", egress: new EgressGuard(policy, { environment: "local" }), egressPolicy: policy, clock: systemClock, credentials: () => null });
    expect(ports.size).toBe(0);
    expect(report.status[0]).toMatchObject({ status: "NOT_CONFIGURED", reasons: ["MODEL_CREDENTIAL_NOT_RESOLVED"] });
  });

  it("[OPS-04] adversarial: an emulator endpoint in a deployed environment refuses composition; a wrong credential kind is refused", () => {
    const e = endpointConfig("openai_responses", hostFor("openai_responses"), { environments: ["staging"] });
    const policy = egressPolicyFor([]);
    expect(() => createModelPorts([e], { environment: "staging", egress: new EgressGuard(policy, { environment: "staging" }), egressPolicy: policy, clock: systemClock, credentials: () => null })).toThrow(ConfigurationRejectedError);
    const b = endpointConfig("bedrock_converse", hostFor("bedrock_converse"));
    const bp = egressPolicyFor([b]);
    expect(() => createModelPorts([b], { environment: "local", egress: new EgressGuard(bp, { environment: "local" }), egressPolicy: bp, clock: systemClock, credentials: () => ({ kind: "bearer", token: async () => "key_synthWrongKind" }) })).toThrow(ConfigurationRejectedError);
  });

  it("[DATA-01] startup egress: live model endpoints become model_endpoint targets checked against the model classes", () => {
    const host = "api.openai.startup.models.test";
    const live = endpointConfig("openai_responses", host, { adapterKind: "live", environments: ["sandbox"] });
    const targets = modelEgressTargets([live], "sandbox");
    expect(targets).toEqual([{ ref: live.endpointRef.replace(/[.-]/g, "_"), url: `https://${host}/v1/responses`, dataClass: "INTERNAL", binding: { provider: "openai_responses", region: "us-east-1", retentionPolicyRef: "retention.emulator_none" } }]);
    const config = { environment: "sandbox", adapters: {}, audit: { sink: "local_fixture" }, gateway: {} } as unknown as PlatformConfig;
    const policy = { ...egressPolicyFor([live]), destinations: egressPolicyFor([live]).destinations.map((d) => ({ ...d, environments: ["sandbox" as const], adapterKind: "live" as const })) };
    const ok = checkStartupEgress({ environment: "sandbox", policy, targets: egressTargetsFor(config, [], targets).filter((t) => t.kind === "model_endpoint") });
    expect(ok.violations).toEqual([]);
    const refused = checkStartupEgress({ environment: "sandbox", policy: { policyVersion: "none.1", destinations: [] }, targets: egressTargetsFor(config, [], targets).filter((t) => t.kind === "model_endpoint") });
    expect(refused.violations).toEqual([`EGRESS_DESTINATION_UNKNOWN@models.${targets[0]!.ref}`]);
    // Emulator endpoints are local/ci only and are not startup targets of a deployed environment.
    expect(modelEgressTargets([endpointConfig("openai_responses", host)], "local")).toEqual([]);
  });
});
