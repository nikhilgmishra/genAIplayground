import type { ApprovalScope, Environment } from "../protocol/index.js";

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
