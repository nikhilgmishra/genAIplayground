/**
 * Strict zod schema for PlatformConfig (platform/src/config/ports.ts).
 *
 * Configuration carries REFERENCES to secrets (Secrets Manager / KMS / SSM ARNs,
 * or labelled local-fixture references), never secret values: every credential
 * field must match a reference pattern, so a pasted token fails to parse.
 * Endpoints may not carry query strings or fragments (no PHI or tokens in URLs).
 */
import { z } from "zod";
import { WorkforceSsoConfigSchema } from "../console-api/sso-config.js";
import { EgressPolicyConfig } from "../privacy/egress.js";
import { ApprovalScope, DestinationId, Environment, OpaqueId, Sha256Hex, VersionLabel } from "../protocol/index.js";
import { ValidationError } from "../shared/errors.js";
import type { GatewayConfig, PlatformConfig } from "./ports.js";

/** Secret reference: AWS ARN (secretsmanager / kms / ssm), labelled local fixture, or a repository file (public keys only). */
export const SECRET_REF_PATTERN =
  /^(arn:aws:(secretsmanager|kms|ssm):[A-Za-z0-9-]{1,32}:[A-Za-z0-9]{1,32}:[A-Za-z0-9/_+=.@:-]{1,256}|local-fixture:[a-z0-9][a-z0-9._/-]{0,127}|file:[A-Za-z0-9._/-]{1,256})$/;
export const SecretRef = z.string().max(512).regex(SECRET_REF_PATTERN, "secret reference expected");

export const ApprovalId = z.string().regex(/^apr_[A-Za-z0-9_-]{8,64}$/);

/** http(s) URL without credentials, query string or fragment. */
export const EndpointUrl = z
  .string()
  .max(512)
  .regex(/^https?:\/\/[A-Za-z0-9.-]{1,253}(:\d{2,5})?(\/[A-Za-z0-9._~/-]*)?$/, "endpoint URL without query, fragment or userinfo expected");

export const AdapterKey = z.string().regex(/^[a-z][a-z0-9-]{2,63}$/);

const RelativePath = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9._/-]+$/)
  .refine((p) => !p.split("/").includes(".."), "parent segments not allowed");

export const AdapterConfigSchema = z.strictObject({
  kind: z.enum(["local_fixture", "live"]),
  endpoint: EndpointUrl.nullable(),
  credentialRef: SecretRef.nullable(),
  authMethod: z.enum(["oauth2_client_credentials", "bearer_static_exception", "mtls", "none"]),
  exceptionApprovalId: ApprovalId.nullable(),
  timeoutMs: z.number().int().min(100).max(30_000),
  integrationApprovalId: ApprovalId.nullable().optional(),
});

export const DestinationPurpose = z.enum([
  "SAFETY_PRIORITY",
  "STANDARD_SUPPORT",
  "INTERPRETER",
  "CLINICAL_ROUTE",
  "PROVIDER_SUPPORT",
  "PARTNER_SUPPORT",
  "BILLING_SPECIALIST",
  "OUTAGE_CONTINUITY",
]);

export const DestinationConfigSchema = z.strictObject({
  destinationId: DestinationId,
  purpose: DestinationPurpose,
  vendorQueueRef: z.string().regex(/^[A-Za-z0-9_:./-]{3,128}$/),
  fallbackDestinationIds: z.array(DestinationId).max(4),
  languages: z.array(z.string().regex(/^([a-z]{2,3}(-[A-Z]{2})?|\*)$/)).min(1).max(16),
});

const RetentionDays = z.number().int().min(1).max(36_500).nullable();

export const OpsConfigSchema = z.strictObject({
  admission: z.strictObject({
    maxConcurrentAiSessions: z.number().int().min(1).max(100_000),
    safetyReserveSessions: z.number().int().min(0).max(100_000),
  }),
  killSwitches: z.strictObject({
    /** Bounded staleness: at most 60 s. */
    cacheTtlMs: z.number().int().min(0).max(60_000),
  }),
  budgets: z.strictObject({
    burnRateWindowMinutes: z.number().int().min(1).max(1440),
    requireBudget: z.boolean(),
  }),
});

/**
 * Added by the gateway module (additive, optional): inbound integration
 * authentication and HTTP limits for the gateway. Absent => local/ci use the
 * LOCAL FIXTURE integration tokens and every other environment refuses to start
 * the gateway (GATEWAY_INBOUND_AUTH_NOT_CONFIGURED). Values (issuer, audience,
 * JWKS URI, client ids) come from the integration owner; nothing is defaulted.
 */
const InboundChannel = z.enum(["mcp_tools", "telephony_control", "portal", "webhook"]);
export const GatewayInboundAuthSchema = z.strictObject({
  kind: z.literal("oauth2_jwt"),
  issuer: z.string().url().max(512),
  audience: z.string().min(3).max(256),
  jwksUri: EndpointUrl,
  algorithms: z.array(z.enum(["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512", "EdDSA"])).min(1).max(10),
  clockToleranceSeconds: z.number().int().min(0).max(120),
  maxTokenAgeSeconds: z.number().int().min(30).max(86_400).nullable(),
  clientIdClaim: z.enum(["client_id", "azp", "sub"]),
  clients: z
    .array(
      z.strictObject({
        clientId: z.string().min(3).max(256),
        integrationId: z.string().regex(/^[a-z0-9-]{3,64}$/),
        credentialId: z.string().min(3).max(128),
        channels: z.array(InboundChannel).min(1).max(4),
      }),
    )
    .min(1)
    .max(32),
  scopeToChannel: z.record(z.string().regex(/^[A-Za-z0-9._:-]{3,64}$/), InboundChannel),
});
export const GatewayConfigSchema = z.strictObject({
  inboundAuth: GatewayInboundAuthSchema.nullable(),
  http: z
    .strictObject({
      bodyLimitBytes: z.number().int().min(1024).max(1_048_576),
      rateLimit: z.strictObject({ max: z.number().int().min(1).max(100_000), timeWindowMs: z.number().int().min(1000).max(3_600_000) }).nullable(),
    })
    .optional(),
});
export type ParsedGatewayConfig = z.infer<typeof GatewayConfigSchema>;

// ---------------------------------------------------------------------------
// Live composition sections (WP-07). Optional: local/ci never need them; the live composition refuses to
// start without `infrastructure` and `egress`, and treats a missing capability section as NOT_CONFIGURED.
// ---------------------------------------------------------------------------

/** Lower-case DNS name (no IP literal, no port, no wildcard). */
export const DnsName = z
  .string()
  .max(253)
  .regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, "dns name expected");
/** SQS queue URL in the AWS form (also how emulators resolve queues by name). */
export const SqsQueueUrl = z.string().regex(/^https:\/\/sqs\.[a-z]{2}(-gov)?-[a-z]+-\d\.amazonaws\.com\/\d{12}\/[A-Za-z0-9_-]{1,75}(\.fifo)?$/, "sqs queue url expected");
/** KMS key id: key ARN, alias ARN, alias name or key UUID. */
export const KmsKeyId = z.string().regex(/^(arn:aws:kms:[a-z0-9-]{4,32}:\d{12}:(key|alias)\/[A-Za-z0-9/_-]{1,256}|alias\/[A-Za-z0-9/_-]{1,256}|[0-9a-f-]{36})$/, "kms key id expected");
const DynamoTable = z.string().regex(/^[A-Za-z0-9_.-]{3,255}$/);
/** http(s) endpoint override (emulators). The guard refuses overrides outside sandbox. */
const EndpointOverride = EndpointUrl.nullable();

export const InfrastructureConfigSchema = z.strictObject({
  aws: z.strictObject({
    region: z.string().regex(/^[a-z]{2}(-gov)?-[a-z]+-\d$/),
    endpointOverrides: z
      .strictObject({ dynamodb: EndpointOverride, sqs: EndpointOverride, s3: EndpointOverride, kms: EndpointOverride, secretsManager: EndpointOverride, sts: EndpointOverride })
      .nullable(),
    s3ForcePathStyle: z.boolean(),
  }),
  privateNetworkHosts: z.array(DnsName).max(32),
  /**
   * Address ranges of the load balancer nodes in front of the live units (ALB subnets): only a peer inside them
   * may name the client in X-Forwarded-For (console sign-in rate limit). Optional; the guard checks the ranges.
   */
  trustedProxyCidrs: z
    .array(z.string().max(64).regex(/^(\d{1,3}(\.\d{1,3}){3}\/\d{1,2}|[0-9a-f:]{2,39}\/\d{1,3})$/, "cidr expected"))
    .max(16)
    .optional(),
  outbox: z.strictObject({ queueUrl: SqsQueueUrl, fifo: z.boolean(), deadLetterQueueUrl: SqsQueueUrl.nullable() }).nullable(),
  routeAuditJournalTable: DynamoTable.nullable(),
  auditSink: z
    .strictObject({
      bucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/),
      expectedBucketOwner: z.string().regex(/^\d{12}$/),
      keyPrefix: z.string().regex(/^([a-z0-9_-]{1,32}\/){0,4}$/),
      objectLockMode: z.enum(["COMPLIANCE", "GOVERNANCE"]),
      kmsKeyId: KmsKeyId,
    })
    .nullable(),
  auditExport: z
    .strictObject({
      manifestSigningKeyId: KmsKeyId,
      exporterDatabaseRef: SecretRef,
      verifierDatabaseRef: SecretRef,
      trustedManifestKeyIds: z.array(KmsKeyId).min(1).max(4),
    })
    .nullable(),
  secrets: z.strictObject({ requestHashPepperRef: SecretRef.nullable(), otpPepperRef: SecretRef.nullable(), consoleSessionSealerRef: SecretRef.nullable() }),
  ingressPayloadKeyId: KmsKeyId.nullable(),
});

const OtlpUrl = z
  .string()
  .max(512)
  .regex(/^https:\/\/[a-z0-9.-]{1,253}(:\d{2,5})?\/v1\/(metrics|traces)$/, "https OTLP/HTTP signal URL expected");
export const ObservabilityConfigSchema = z.strictObject({
  contentAttributes: z.literal("DISABLED"),
  otlp: z
    .strictObject({
      metricsUrl: OtlpUrl.nullable(),
      tracesUrl: OtlpUrl.nullable(),
      exportIntervalMs: z.number().int().min(5_000).max(300_000),
      timeoutMs: z.number().int().min(500).max(30_000),
    })
    .nullable(),
});

const IssuerUrl = z.string().max(512).regex(/^https:\/\/[a-z0-9.-]{1,253}(:\d{2,5})?(\/[A-Za-z0-9._~/-]*)?$/);
export const CallerIdentityConfigSchema = z.strictObject({
  idps: z
    .array(z.strictObject({ adapterKey: z.enum(["oidc-client-idp", "oidc-provider-idp"]), issuer: IssuerUrl, audience: z.string().regex(/^[A-Za-z0-9._:-]{3,256}$/) }))
    .max(2),
});

export const ConnectorsConfigSchema = z.strictObject({
  profileDirectory: RelativePath.nullable(),
  feeds: z
    .array(
      z.strictObject({
        profileId: z.string().regex(/^cnp_[A-Za-z0-9_-]{8,64}$/),
        streamId: z.string().regex(/^[a-z][a-z0-9_.-]{1,63}$/),
        operationId: z.string().regex(/^[a-z][a-z0-9_.]{1,63}$/),
        intervalMs: z.number().int().min(1_000).max(3_600_000),
        maxPagesPerRun: z.number().int().min(1).max(1_000),
        deadLetterQueueUrl: SqsQueueUrl,
        keyField: z.string().regex(/^[a-z][a-zA-Z0-9_.]{0,63}$/),
        updatedAtField: z.string().regex(/^[a-z][a-zA-Z0-9_.]{0,63}$/).nullable(),
      }),
    )
    .max(32),
});

export const CrmConfigSchema = z.strictObject({
  salesforce: z
    .strictObject({
      apiVersion: z.string().regex(/^v\d{2,3}\.\d$/),
      schemaEvidenceRef: z.string().min(3).max(512),
      schemaApprovalId: z.string().regex(/^apr_[A-Za-z0-9_-]{8,64}$/),
      mapping: z.record(z.string().regex(/^[a-z][a-zA-Z]{1,32}$/), z.unknown()),
    })
    .nullable(),
});

export const KnowledgeConfigSchema = z.strictObject({ allowedLinkDomains: z.array(DnsName).max(32) });

export const PlatformConfigSchema = z
  .strictObject({
    /** Human-readable label (e.g. LOCAL FIXTURE); stripped by the loader. */
    $comment: z.string().max(2000).optional(),
    environment: Environment,
    tenantId: OpaqueId,
    serviceName: z.string().regex(/^[a-z][a-z0-9-]{2,63}$/),
    sessionBinding: z.strictObject({
      mode: z.enum(["trusted_header", "server_to_server_lookup", "tool_argument_lookup_exception"]),
      sessionTtlSeconds: z.number().int().min(60).max(86_400),
      exceptionApprovalId: ApprovalId.nullable(),
    }),
    adapters: z.record(AdapterKey, AdapterConfigSchema).refine((r) => Object.keys(r).length <= 64, "too many adapters"),
    models: z.strictObject({
      active: z.strictObject({ model: VersionLabel, voice: VersionLabel, agentConfig: VersionLabel }),
      approved: z.array(z.strictObject({ model: VersionLabel, voice: VersionLabel, approvalId: ApprovalId.nullable() })).max(32),
    }),
    policy: z.strictObject({ bundlePath: RelativePath, expectedVersion: VersionLabel.nullable(), expectedDigest: Sha256Hex.nullable() }),
    toolCatalog: z.strictObject({ expectedDigest: Sha256Hex.nullable() }),
    cors: z.strictObject({ allowedOrigins: z.array(z.string().min(1).max(256)).max(32) }),
    audit: z.strictObject({
      enabled: z.boolean(),
      sink: z.enum(["local_fixture", "s3_object_lock"]),
      maxBacklog: z.number().int().min(1).max(10_000_000),
      maxBacklogAgeSeconds: z.number().int().min(1).max(86_400),
    }),
    destinations: z.array(DestinationConfigSchema).max(64),
    verification: z.strictObject({
      otpExpirySeconds: z.number().int().min(30).max(900),
      otpMaxAttemptsPerChallenge: z.number().int().min(1).max(10),
      otpMaxPerAccountPerHour: z.number().int().min(1).max(50),
      secureLinkExpirySeconds: z.number().int().min(30).max(3600),
      maxAuthAgeSeconds: z.number().int().min(30).max(86_400),
      approvedBySecurity: ApprovalId.nullable(),
    }),
    retention: z.strictObject({
      TRANSIENT_CONVERSATION: RetentionDays,
      BUSINESS_RECORD: RetentionDays,
      RESTRICTED_QA_MEDIA: RetentionDays,
      SECURITY_AUDIT: RetentionDays,
    }),
    approvals: z.strictObject({
      directory: RelativePath,
      required: z.array(ApprovalScope).max(ApprovalScope.options.length),
      trustedSigningKeyRef: SecretRef.nullable(),
    }),
    signing: z.strictObject({ assertionKeyRef: SecretRef.nullable(), localDevKey: z.boolean() }),
    database: z.strictObject({ engine: z.enum(["pglite", "pg"]), connectionRef: SecretRef.nullable() }),
    sessionStore: z.strictObject({ kind: z.enum(["memory", "dynamodb"]), tableName: z.string().regex(/^[A-Za-z0-9_.-]{3,255}$/).nullable() }),
    phi: z.strictObject({ endpointsEnabled: z.boolean() }).optional(),
    ops: OpsConfigSchema.optional(),
    /** Added by the gateway module (additive, optional). See GatewayConfigSchema. */
    gateway: GatewayConfigSchema.optional(),
    // Live composition sections (WP-07; additive, optional).
    infrastructure: InfrastructureConfigSchema.optional(),
    observability: ObservabilityConfigSchema.optional(),
    egress: EgressPolicyConfig.optional(),
    consoleAuth: WorkforceSsoConfigSchema.optional(),
    crm: CrmConfigSchema.optional(),
    callerIdentity: CallerIdentityConfigSchema.optional(),
    connectors: ConnectorsConfigSchema.optional(),
    // No `ingress` section: the ingress inbox is not composed in this build (software gap
    // INGRESS_PLUGIN_NOT_COMPOSED in the activation map), and a key nothing reads would let a configuration look
    // like the missing input (FO-00-30). The strict schema refuses one.
    knowledge: KnowledgeConfigSchema.optional(),
  })
  .superRefine((cfg, ctx) => {
    if (new Set(cfg.approvals.required).size !== cfg.approvals.required.length) {
      ctx.addIssue({ code: "custom", path: ["approvals", "required"], message: "duplicate scope" });
    }
  });

export type ParsedPlatformConfig = z.infer<typeof PlatformConfigSchema>;

// Compile-time check that the schema and the PlatformConfig port stay in sync (both directions).
type AssertAssignable<_A extends B, B> = true;
export type SchemaMatchesPorts = [
  AssertAssignable<Omit<ParsedPlatformConfig, "$comment">, PlatformConfig>,
  AssertAssignable<PlatformConfig, Omit<ParsedPlatformConfig, "$comment">>,
  AssertAssignable<ParsedGatewayConfig, GatewayConfig>,
  AssertAssignable<GatewayConfig, ParsedGatewayConfig>,
];

/** Thrown when configuration fails strict parsing. Issues are "path:code" only, never values. */
export class ConfigInvalidError extends ValidationError {
  constructor(readonly issues: string[]) {
    super("CONFIG_INVALID");
  }
}

const safeSegment = (s: PropertyKey): string => {
  const v = String(s);
  return /^[A-Za-z0-9_$-]{1,64}$/.test(v) ? v : "?";
};

export function parsePlatformConfig(raw: unknown): PlatformConfig {
  const r = PlatformConfigSchema.safeParse(raw);
  if (!r.success) {
    throw new ConfigInvalidError(r.error.issues.map((i) => `${i.path.map(safeSegment).join(".") || "$"}:${i.code}`));
  }
  const { $comment: _comment, ...config } = r.data;
  return config;
}

/**
 * Typed accessor for the optional `gateway` section (PlatformConfig.gateway).
 * Returns null when absent; re-validates and throws ConfigInvalidError when
 * present but malformed (fail closed, e.g. a config object built in code).
 */
export function gatewayConfigOf(config: PlatformConfig): GatewayConfig | null {
  const raw: unknown = config.gateway;
  if (raw === undefined) return null;
  const r = GatewayConfigSchema.safeParse(raw);
  if (!r.success) throw new ConfigInvalidError(r.error.issues.map((i) => `gateway.${i.path.map(safeSegment).join(".") || "$"}:${i.code}`));
  return r.data;
}
