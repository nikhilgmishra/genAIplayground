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
}
