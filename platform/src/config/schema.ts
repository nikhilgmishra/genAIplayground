/**
 * Strict zod schema for PlatformConfig (platform/src/config/ports.ts).
 *
 * Configuration carries REFERENCES to secrets (Secrets Manager / KMS / SSM ARNs,
 * or labelled local-fixture references), never secret values: every credential
 * field must match a reference pattern, so a pasted token fails to parse.
 * Endpoints may not carry query strings or fragments (no PHI or tokens in URLs).
 */
import { z } from "zod";
import { ApprovalScope, DestinationId, Environment, OpaqueId, Sha256Hex, VersionLabel } from "../protocol/index.js";
import { ValidationError } from "../shared/errors.js";
import type { PlatformConfig } from "./ports.js";

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
