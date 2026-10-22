/**
 * Model endpoint credentials as opaque handles (docs/ARCHITECTURE.md section 6.4 rule 1): the composition root
 * resolves them (Secrets Manager through the connector SecretResolver, or the task role for Bedrock) and hands the
 * adapters a handle; this module group never imports a secret resolver. A handle's value is used for one request
 * header or signature and is never logged, stored in a result, a metric or an audit record (AUTH-06, DATA-01).
 */

/** A bearer API key (OpenAI project key, vLLM `--api-key`). */
export interface BearerCredential {
  readonly kind: "bearer";
  token(): Promise<string>;
}

/** AWS credentials for SigV4 (Bedrock): the composition root passes the task role's provider. */
export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiration?: Date;
}

export interface AwsCredential {
  readonly kind: "aws";
  credentials(): Promise<AwsCredentials>;
}

export type ModelCredential = BearerCredential | AwsCredential;
