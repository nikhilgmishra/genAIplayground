/**
 * AWS SDK v3 clients of the live composition (WP-07; FO-19-06, FO-14-53).
 *
 * One client per service, built from PlatformConfig.infrastructure.aws: the region, and an endpoint override
 * per service ONLY in sandbox and only for an emulator host (staging and production refuse every override,
 * config/rules/infrastructure.ts). The factory checks the overrides ITSELF, before any client exists, with the
 * guard's own definition (shared/emulator-hosts.ts): the live composition resolves the approval trust key over
 * KMS before the guard runs, so a non-emulator override must never get as far as a signed request (OPS-04,
 * FO-14-53: no SigV4 request, no credential, ever leaves for a host the guard would refuse). Credentials come from the SDK's default
 * provider chain (the task role in a deployment). When the process environment passed to the composition
 * names static credentials (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY, the SDK's own environment variables),
 * they are used exactly as the default chain would use them; nothing else is read and nothing is defaulted.
 * The clients carry no retry layer of their own beyond the SDK's standard mode (the resilience module owns
 * retries), and SDK error messages never leave the adapters that call them (reason codes only).
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { KMSClient } from "@aws-sdk/client-kms";
import { S3Client } from "@aws-sdk/client-s3";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SQSClient } from "@aws-sdk/client-sqs";
import type { Environment } from "../../protocol/index.js";
import { isEmulatorEndpoint } from "../../shared/emulator-hosts.js";
import { ConfigurationRejectedError } from "../../shared/errors.js";

export interface AwsInfrastructure {
  region: string;
  endpointOverrides: { dynamodb: string | null; sqs: string | null; s3: string | null; kms: string | null; secretsManager: string | null; sts: string | null } | null;
  s3ForcePathStyle: boolean;
}

export interface AwsClients {
  dynamodb: DynamoDBClient;
  sqs: SQSClient;
  s3: S3Client;
  kms: KMSClient;
  secretsManager: SecretsManagerClient;
  /** Endpoint the KMS client uses (null: the regional AWS endpoint). */
  kmsEndpoint: string | null;
  destroy(): void;
}

const REGION = /^[a-z]{2}(-gov)?-[a-z]+-\d$/;

export function createAwsClients(aws: AwsInfrastructure, opts: { environment: Environment; env: Readonly<Record<string, string | undefined>> }): AwsClients {
  if (!REGION.test(aws.region)) throw new ConfigurationRejectedError(["AWS_REGION_INVALID@infrastructure.aws.region"]);
  const overrides = aws.endpointOverrides;
  if (overrides && Object.values(overrides).some((o) => o !== null) && opts.environment !== "sandbox") {
    // Outside sandbox no override exists (the guard refuses it too, FO-14-53).
    throw new ConfigurationRejectedError(["INFRASTRUCTURE_ENDPOINT_OVERRIDE_FORBIDDEN@infrastructure.aws.endpointOverrides"]);
  }
  if (overrides) {
    // Sandbox: an override names an emulator host or nothing is built (same rule and reason code as the guard).
    const refused = Object.entries(overrides)
      .filter(([, o]) => o !== null && !isEmulatorEndpoint(o))
      .map(([k]) => `INFRASTRUCTURE_ENDPOINT_OVERRIDE_NOT_EMULATOR@infrastructure.aws.endpointOverrides.${/^[A-Za-z]{2,16}$/.test(k) ? k : "unnamed"}`);
    if (refused.length > 0) throw new ConfigurationRejectedError(refused);
  }
  const keyId = opts.env.AWS_ACCESS_KEY_ID;
  const secret = opts.env.AWS_SECRET_ACCESS_KEY;
  const staticCredentials = keyId && secret ? { accessKeyId: keyId, secretAccessKey: secret, ...(opts.env.AWS_SESSION_TOKEN ? { sessionToken: opts.env.AWS_SESSION_TOKEN } : {}) } : null;
  const base = (endpoint: string | null | undefined) => ({
    region: aws.region,
    ...(endpoint ? { endpoint } : {}),
    ...(staticCredentials ? { credentials: staticCredentials } : {}),
  });
  const dynamodb = new DynamoDBClient(base(overrides?.dynamodb));
  const sqs = new SQSClient(base(overrides?.sqs));
  const s3 = new S3Client({ ...base(overrides?.s3), forcePathStyle: aws.s3ForcePathStyle });
  const kms = new KMSClient(base(overrides?.kms));
  const secretsManager = new SecretsManagerClient(base(overrides?.secretsManager));
  return {
    dynamodb,
    sqs,
    s3,
    kms,
    secretsManager,
    kmsEndpoint: overrides?.kms ?? null,
    destroy() {
      for (const c of [dynamodb, sqs, s3, kms, secretsManager]) c.destroy();
    },
  };
}
