/**
 * AWS client factory of the live composition (WP-07; FO-14-53, OPS-04): endpoint overrides are checked BEFORE
 * any client exists, with the guard's own emulator-host definition, so no signed request can leave for a host
 * the guard would refuse (the approval trust key is resolved over KMS before the guard runs). Docker-free:
 * nothing here sends a request; the Layer-2 test (composition/no-dev-bypass.test.ts) proves zero requests reach
 * a refused host.
 */
import { describe, expect, it } from "vitest";
import { ConfigurationRejectedError } from "../../shared/errors.js";
import { createAwsClients } from "./aws-clients.js";
import type { AwsInfrastructure } from "./aws-clients.js";

const none = { dynamodb: null, sqs: null, s3: null, kms: null, secretsManager: null, sts: null };
const aws = (endpointOverrides: AwsInfrastructure["endpointOverrides"]): AwsInfrastructure => ({ region: "us-east-1", endpointOverrides, s3ForcePathStyle: false });
const violations = (f: () => unknown): string[] => {
  try {
    f();
  } catch (e) {
    if (e instanceof ConfigurationRejectedError) return e.violations;
    throw e;
  }
  return [];
};

describe("createAwsClients [FO-14-53][OPS-04]", () => {
  it("[FO-14-53] positive: sandbox emulator hosts (localhost, *.localhost, *.test, loopback) build clients with the override", async () => {
    const c = createAwsClients(aws({ ...none, kms: "http://localhost:4566", dynamodb: "http://dynamodb.vsp.test:8000", sqs: "http://127.0.0.1:9324", secretsManager: "https://sm.emulator.localhost" }), { environment: "sandbox", env: {} });
    try {
      expect(c.kmsEndpoint).toBe("http://localhost:4566");
      const endpoint = await c.kms.config.endpoint?.();
      expect(endpoint?.hostname).toBe("localhost");
    } finally {
      c.destroy();
    }
  });

  it("[FO-14-53][OPS-04] adversarial: a sandbox override naming a non-emulator host (private IP, public name, look-alike, credentials in the URL) is refused before any client exists, one violation per service", () => {
    expect(violations(() => createAwsClients(aws({ ...none, kms: "http://10.1.2.3:4566", secretsManager: "https://kms.us-east-1.amazonaws.com.attacker.example.com" }), { environment: "sandbox", env: {} }))).toEqual([
      "INFRASTRUCTURE_ENDPOINT_OVERRIDE_NOT_EMULATOR@infrastructure.aws.endpointOverrides.kms",
      "INFRASTRUCTURE_ENDPOINT_OVERRIDE_NOT_EMULATOR@infrastructure.aws.endpointOverrides.secretsManager",
    ]);
    for (const bad of ["http://localhost.attacker.example.com", "http://user:pw@localhost:4566", "ftp://localhost:21", "http://192.168.1.10:8000", "http://[fd00::1]:8000", "http://test:8000"]) {
      expect(violations(() => createAwsClients(aws({ ...none, sqs: bad }), { environment: "sandbox", env: {} })), bad).toEqual(["INFRASTRUCTURE_ENDPOINT_OVERRIDE_NOT_EMULATOR@infrastructure.aws.endpointOverrides.sqs"]);
    }
  });

  it("[FO-14-53] adversarial: staging and production refuse every override, emulator hosts included; no override builds the regional clients", () => {
    for (const environment of ["staging", "production"] as const) {
      expect(violations(() => createAwsClients(aws({ ...none, kms: "http://localhost:4566" }), { environment, env: {} }))).toEqual(["INFRASTRUCTURE_ENDPOINT_OVERRIDE_FORBIDDEN@infrastructure.aws.endpointOverrides"]);
      const c = createAwsClients(aws(null), { environment, env: {} });
      expect(c.kmsEndpoint).toBeNull();
      c.destroy();
    }
    expect(violations(() => createAwsClients({ ...aws(null), region: "us-east-1x" }, { environment: "production", env: {} }))).toEqual(["AWS_REGION_INVALID@infrastructure.aws.region"]);
  });
});
