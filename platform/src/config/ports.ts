import type { ApprovalScope, Environment } from "../protocol/index.js";
import type { EgressPolicyConfig } from "../privacy/egress.js";
import type { WorkforceSsoConfig } from "../console-api/sso-config.js";

/**
 * Platform configuration. Production startup runs the configuration guard which
 * rejects fixture adapters, missing credentials, unapproved models, unknown
 * policy versions, permissive CORS, disabled audit and missing approvals (OPS-04).
 */
export interface AdapterConfig {
  kind: "local_fixture" | "live";
  /** Documented base URL for live adapters. */
  endpoint: string | null;
  /** Secrets Manager ARN or other secret reference; never the secret value. */
  credentialRef: string | null;
  authMethod: "oauth2_client_credentials" | "bearer_static_exception" | "mtls" | "none";
  /** Approval id when authMethod is a static-token exception. */
  exceptionApprovalId: string | null;
  timeoutMs: number;
  /**
   * Added by the config module: approval id (VENDOR_SANDBOX_INTEGRATION in sandbox)
   * that authorizes this specific live integration. Optional for backwards compatibility.
   */
  integrationApprovalId?: string | null;
}

export interface DestinationConfig {
  destinationId: string;
  purpose: "SAFETY_PRIORITY" | "STANDARD_SUPPORT" | "INTERPRETER" | "CLINICAL_ROUTE" | "PROVIDER_SUPPORT" | "PARTNER_SUPPORT" | "BILLING_SPECIALIST" | "OUTAGE_CONTINUITY";
  /** Vendor queue/destination identifier resolved only from this trusted configuration (SAFE-05). */
  vendorQueueRef: string;
  fallbackDestinationIds: string[];
  languages: string[];
}

export interface PlatformConfig {
  environment: Environment;
  tenantId: string;
  serviceName: string;
  /** How the caller session reference reaches the gateway. See ADR-0003 and TB-01. */
  sessionBinding: {
    mode: "trusted_header" | "server_to_server_lookup" | "tool_argument_lookup_exception";
    sessionTtlSeconds: number;
    exceptionApprovalId: string | null;
  };
  adapters: Record<string, AdapterConfig>;
  models: {
    active: { model: string; voice: string; agentConfig: string };
    approved: { model: string; voice: string; approvalId: string | null }[];
  };
  policy: { bundlePath: string; expectedVersion: string | null; expectedDigest: string | null };
  toolCatalog: { expectedDigest: string | null };
  cors: { allowedOrigins: string[] };
  audit: { enabled: boolean; sink: "local_fixture" | "s3_object_lock"; maxBacklog: number; maxBacklogAgeSeconds: number };
  destinations: DestinationConfig[];
  verification: {
    otpExpirySeconds: number;
    otpMaxAttemptsPerChallenge: number;
    otpMaxPerAccountPerHour: number;
    secureLinkExpirySeconds: number;
    maxAuthAgeSeconds: number;
    /** Security-approved values required before production. */
    approvedBySecurity: string | null;
  };
  /** Retention per data class in days; null = not yet set by counsel (blocks production). */
  retention: Record<"TRANSIENT_CONVERSATION" | "BUSINESS_RECORD" | "RESTRICTED_QA_MEDIA" | "SECURITY_AUDIT", number | null>;
  approvals: { directory: string; required: ApprovalScope[]; trustedSigningKeyRef: string | null };
  signing: { assertionKeyRef: string | null; localDevKey: boolean };
  database: { engine: "pglite" | "pg"; connectionRef: string | null };
  sessionStore: { kind: "memory" | "dynamodb"; tableName: string | null };
  /**
   * Added by the config module. PHI-bearing endpoints stay disabled until the
   * prerequisites are evidenced (spec section 16); the guard rejects `true`
   * without a valid PHI_PROCESSING approval and always rejects it outside
   * staging/production. Absent = disabled.
   */
  phi?: { endpointsEnabled: boolean };
  /** Added by the config module: capacity, admission and kill-switch settings (platform/src/ops). */
  ops?: OpsConfig;
  /**
   * Added by the gateway module (additive, optional; schema.ts GatewayConfigSchema):
   * inbound integration authentication and HTTP limits. Absent => local/ci use the
   * LOCAL FIXTURE integration tokens and every other environment refuses to start
   * the gateway (GATEWAY_INBOUND_AUTH_NOT_CONFIGURED). Read it through
   * gatewayConfigOf(), which re-validates it (fail closed).
   */
  gateway?: GatewayConfig;
  /**
   * Added by the live composition (WP-07; schema.ts InfrastructureConfigSchema): where the live adapters of
   * the substrate find their resources (AWS region and, in sandbox only, emulator endpoints; the outbox queue;
   * the independent route-audit journal table; the audit sink; key and secret references). Absent outside
   * local/ci => the live composition refuses to start (LIVE_INFRASTRUCTURE_NOT_CONFIGURED).
   */
  infrastructure?: InfrastructureConfig;
  /** Telemetry export (OpenTelemetry OTLP); content attributes are never exported (FO-03-30, AIN-37). */
  observability?: ObservabilityConfig;
  /**
   * Egress allowlist (DATA-01): every outbound destination the process may reach. Required outside local/ci
   * (EGRESS_POLICY_NOT_CONFIGURED); local/ci default to LOCAL_FIXTURE_EGRESS_POLICY (approves nothing).
   */
  egress?: EgressPolicyConfig;
  /** Workforce SSO of the operations console (console-api/sso-config.ts WorkforceSsoConfigSchema, WP-05). */
  consoleAuth?: WorkforceSsoConfig;
  /** Caller identity providers whose ID tokens complete a secure-link verification (JwksOidcVerifier over discovery). */
  callerIdentity?: CallerIdentityConfig;
  /** Connector runtime: reviewed ConnectorProfiles (relative directory) and their change-feed syncs. */
  connectors?: ConnectorsConfig;
  /** Knowledge service settings of the live composition. */
  knowledge?: KnowledgeConfig;
  crm?: CrmConfig;
}

/** Emulator endpoints (sandbox profile only; the guard refuses them in staging and production). */
export interface AwsEndpointOverrides {
  dynamodb: string | null;
  sqs: string | null;
  s3: string | null;
  kms: string | null;
  secretsManager: string | null;
  sts: string | null;
}

export interface InfrastructureConfig {
  aws: { region: string; endpointOverrides: AwsEndpointOverrides | null; s3ForcePathStyle: boolean };
  /**
   * Exact host names whose services live on the private network (VPC endpoints, in-VPC collectors, private
   * IdPs): the egress-classified transport requires them to resolve to private addresses. Every other host
   * must resolve to public addresses.
   */
  privateNetworkHosts: string[];
  /**
   * Address ranges (CIDR) of the load balancer nodes in front of the live units. The console's sign-in rate
   * limit keys on the client address, which only a peer inside these ranges may name in X-Forwarded-For; absent
   * or empty, the socket peer is the client. Private ranges only (the guard refuses anything else).
   */
  trustedProxyCidrs?: string[];
  /** Outbox publisher (SQS) and its dead-letter queue. */
  outbox: { queueUrl: string; fifo: boolean; deadLetterQueueUrl: string | null } | null;
  /** Independent DynamoDB journal of route audit evidence (used when PostgreSQL refuses a deferral). */
  routeAuditJournalTable: string | null;
  /** S3 Object Lock audit sink in the audit account (the exporter writes, the verifier reads). */
  auditSink: { bucket: string; expectedBucketOwner: string; keyPrefix: string; objectLockMode: "COMPLIANCE" | "GOVERNANCE"; kmsKeyId: string } | null;
  /** Independent audit export (platform/src/main/audit-exporter.ts): separate identities for exporter and verifier. */
  auditExport: { manifestSigningKeyId: string; exporterDatabaseRef: string; verifierDatabaseRef: string; trustedManifestKeyIds: string[] } | null;
  /** Secret references (Secrets Manager) the live composition resolves at startup. */
  secrets: { requestHashPepperRef: string | null; otpPepperRef: string | null; consoleSessionSealerRef: string | null };
  /** KMS key for the ingress payload envelope cipher (GenerateDataKey / Decrypt). */
  ingressPayloadKeyId: string | null;
}

export interface ObservabilityConfig {
  /** Content attributes are never exported; the only accepted value. */
  contentAttributes: "DISABLED";
  otlp: {
    /** Full OTLP/HTTP URLs (`https://<collector>/v1/metrics`, `/v1/traces`); null = that signal is not exported. */
    metricsUrl: string | null;
    tracesUrl: string | null;
    exportIntervalMs: number;
    timeoutMs: number;
  } | null;
}

export interface CallerIdentityConfig {
  idps: { adapterKey: "oidc-client-idp" | "oidc-provider-idp"; issuer: string; audience: string }[];
}

export interface ConnectorFeedConfig {
  profileId: string;
  streamId: string;
  operationId: string;
  intervalMs: number;
  maxPagesPerRun: number;
  /** Dead-letter queue of records the feed cannot project (a refusal stops consumption, the checkpoint is kept). */
  deadLetterQueueUrl: string;
  /** Mapping target field holding the record's stable key (indexed as a digest). */
  keyField: string;
  /** Mapping target field holding the record's source update time, or null. */
  updatedAtField: string | null;
}

export interface ConnectorsConfig {
  /** Directory (relative to the repository root) of the reviewed ConnectorProfile files, or null for none. */
  profileDirectory: string | null;
  feeds: ConnectorFeedConfig[];
}

/** CRM inputs of the live composition (WP-07): the tenant's Salesforce Case schema (PRQ-006). */
export interface CrmConfig {
  salesforce: {
    /** The org's REST API version, e.g. "v62.0" (never defaulted). */
    apiVersion: string;
    /** Where the administrator's schema evidence is kept (document reference, no content). */
    schemaEvidenceRef: string;
    /** VALID approval record that accepted the schema (any approved scope of this environment). */
    schemaApprovalId: string;
    /** Object and field API names (validated strictly by the adapter; placeholders refused). */
    mapping: Record<string, unknown>;
  } | null;
}

export interface KnowledgeConfig {
  /** Exact domains approved for links in knowledge answers (none = no link is ever spoken). */
  allowedLinkDomains: string[];
}

export type GatewayInboundChannel = "mcp_tools" | "telephony_control" | "portal" | "webhook";

/** OAuth2 client-credentials JWT validation for inbound integrations (values from the integration owner; nothing defaulted). */
export interface GatewayInboundAuth {
  kind: "oauth2_jwt";
  issuer: string;
  audience: string;
  jwksUri: string;
  algorithms: ("RS256" | "RS384" | "RS512" | "PS256" | "PS384" | "PS512" | "ES256" | "ES384" | "ES512" | "EdDSA")[];
  clockToleranceSeconds: number;
  maxTokenAgeSeconds: number | null;
  clientIdClaim: "client_id" | "azp" | "sub";
  /** One integrationId per vendor tenant; its credentials differ by channel (identity binds sessions to the integration). */
  clients: { clientId: string; integrationId: string; credentialId: string; channels: GatewayInboundChannel[] }[];
  scopeToChannel: Record<string, GatewayInboundChannel>;
}

export interface GatewayConfig {
  inboundAuth: GatewayInboundAuth | null;
  http?: {
    bodyLimitBytes: number;
    rateLimit: { max: number; timeWindowMs: number } | null;
  };
}

export interface OpsConfig {
  admission: {
    /** Concurrent AI session limit with controlled admission (spec section 12 planning figure: 2000). */
    maxConcurrentAiSessions: number;
    /**
     * Safety reserve of session slots. Safety and human-route sessions are always
     * admitted; exceeding the reserve raises an alert to the escalation owner, never a block.
     */
    safetyReserveSessions: number;
  };
  killSwitches: {
    /**
     * Snapshot cache TTL. 0 (default) reads current state on every check. A positive
     * TTL lets an engaged switch take up to TTL to reach every instance.
     */
    cacheTtlMs: number;
  };
  budgets: {
    /** Window used to compute the recent burn rate for metering-delay projection. */
    burnRateWindowMinutes: number;
    /** Fail closed when no budget covers a nonessential admission. */
    requireBudget: boolean;
  };
}
