/**
 * Inbound source profiles (follow-on FO-07-16, FO-06-98, FO-15-50): for each event source of a tenant, the
 * documented authentication mechanism the ingress router must apply, where its credentials live (a
 * reference, never a value), the explicit event contracts it may deliver, and its bounds. Strict schema:
 * an unknown field fails. Reviewed configuration, never caller- or model-supplied.
 */
import { z } from "zod";

export const SOURCE_ID_RE = /^[a-z][a-z0-9_.-]{2,63}$/;
export const SourceId = z.string().regex(SOURCE_ID_RE);
const TenantId = z.string().regex(/^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$/);
const FieldName = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/);
const HeaderName = z.string().regex(/^[a-z][a-z0-9-]{1,63}$/);
const ContractRef = z.strictObject({ contractId: z.string().regex(/^[a-z][a-z0-9_.-]{2,63}$/), version: z.string().regex(/^[A-Za-z0-9._-]{1,32}$/) });
/**
 * Credential reference: a Secrets Manager secret ARN (live) or a labelled local fixture key (offline).
 * The resolver turns it into credential VERSIONS; the profile never holds key material.
 */
export const CredentialRef = z
  .string()
  .max(512)
  .regex(/^(arn:aws:secretsmanager:[a-z0-9-]{4,32}:\d{12}:secret:[A-Za-z0-9/_+=.@-]{1,512}|local-fixture:[a-z0-9][a-z0-9._/-]{0,127})$/);

export const HmacVerifierConfig = z.strictObject({
  kind: z.literal("hmac_header"),
  algorithm: z.enum(["sha256", "sha1"]),
  signatureHeader: HeaderName,
  encoding: z.enum(["hex", "base64"]),
  /** Literal prefix of the header value, e.g. "sha256=" (empty for none). */
  prefix: z.string().max(16).regex(/^[A-Za-z0-9=_:-]*$/),
  /** "body": HMAC over the raw bytes; "timestamp.body": over `<timestamp>.<raw bytes>` with the timestamp header. */
  signedPayload: z.enum(["body", "timestamp.body"]),
  timestampHeader: HeaderName.nullable(),
  toleranceSeconds: z.number().int().min(30).max(900),
  credentials: CredentialRef,
});

export const JwtVerifierConfig = z.strictObject({
  kind: z.literal("jwt_bearer"),
  /** Header carrying the token (default authorization, "Bearer <jwt>" or a bare token). */
  header: HeaderName,
  issuer: z.string().min(1).max(256).nullable(),
  audience: z.string().min(1).max(256).nullable(),
  /** HS256 with shared secret versions from `credentials`, or RS256/ES256 from the JWKS URL. */
  algorithms: z.array(z.enum(["HS256", "RS256", "ES256"])).min(1).max(3),
  credentials: CredentialRef.nullable(),
  jwksUrl: z.string().url().max(512).refine((u) => u.startsWith("https://"), "JWKS over HTTPS only").nullable(),
  /** Claim holding base64(SHA-256(raw body)) (LiveKit webhooks: "sha256"); null when the token does not bind the body. */
  bodyHashClaim: FieldName.nullable(),
  maxTokenAgeSeconds: z.number().int().min(30).max(3600),
});

export const MtlsVerifierConfig = z.strictObject({
  kind: z.literal("mtls"),
  /**
   * "socket": the gateway terminates TLS and requests a client certificate (chain verified by Node against
   * the configured CA); "alb_header": an AWS ALB in mTLS verify mode passes the verified leaf in
   * X-Amzn-Mtls-Clientcert. Either way the leaf's SHA-256 fingerprint must be one of the credential versions.
   */
  mode: z.enum(["socket", "alb_header"]),
  credentials: CredentialRef,
});

export const ReconcileVerifierConfig = z.strictObject({
  kind: z.literal("reconcile_by_lookup"),
  /** Optional authentication of the delivering gateway itself (shared bearer secret versions). */
  gatewayCredentials: CredentialRef.nullable(),
  gatewayHeader: HeaderName,
});

export const StreamVerifierConfig = z.strictObject({ kind: z.literal("stream_iam") });

export const VerifierConfig = z.discriminatedUnion("kind", [HmacVerifierConfig, JwtVerifierConfig, MtlsVerifierConfig, ReconcileVerifierConfig, StreamVerifierConfig]);
export type VerifierConfig = z.infer<typeof VerifierConfig>;

export const SourceProfile = z
  .strictObject({
    sourceId: SourceId,
    tenantId: TenantId,
    family: z.enum(["webhook", "cdp", "delivery_receipt", "cdc", "stream"]),
    /** Vendor and the URL of the documentation the verifier follows (never invent a signature protocol). */
    vendor: z.string().regex(/^[A-Za-z0-9 ._-]{2,64}$/),
    documentationUrl: z.string().url().max(512),
    verifier: VerifierConfig,
    /** Top-level fields of the payload that carry the envelope; their values are opaque. */
    envelope: z.strictObject({
      idField: FieldName,
      typeField: FieldName,
      occurredAtField: FieldName.nullable(),
      versionField: FieldName.nullable(),
      entityField: FieldName.nullable(),
    }),
    /** Explicit contracts per event type (allowlist); an unlisted type is quarantined. */
    contracts: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_.:/-]{0,127}$/), ContractRef).refine((c) => Object.keys(c).length >= 1 && Object.keys(c).length <= 64),
    maxBodyBytes: z.number().int().min(256).max(262_144),
    /** Days the encrypted raw payload is kept for approved replay (restricted store). */
    rawRetentionDays: z.number().int().min(1).max(400),
    processing: z.strictObject({
      maxAttempts: z.number().int().min(1).max(20),
      baseDelayMs: z.number().int().min(100).max(600_000),
      maxDelayMs: z.number().int().min(100).max(86_400_000),
    }),
    /** Seconds both the current and the previous credential verify after a rotation (FO-06-98). */
    rotationOverlapSeconds: z.number().int().min(0).max(30 * 86_400),
    /** Accept the pending (next) credential before it becomes current (sender switched early). */
    acceptPendingCredential: z.boolean(),
  })
  .refine((p) => p.processing.maxDelayMs >= p.processing.baseDelayMs, { message: "maxDelayMs >= baseDelayMs" })
  .refine((p) => (p.family === "stream") === (p.verifier.kind === "stream_iam"), { message: "stream sources use stream_iam and only they do" });
export type SourceProfile = z.infer<typeof SourceProfile>;

export type AuthMechanism = "HMAC_SHA256_HEADER" | "HMAC_SHA1_HEADER" | "JWT_BEARER" | "MTLS" | "RECONCILE_BY_LOOKUP" | "STREAM_IAM";

export function authMechanismOf(v: VerifierConfig): AuthMechanism {
  switch (v.kind) {
    case "hmac_header":
      return v.algorithm === "sha256" ? "HMAC_SHA256_HEADER" : "HMAC_SHA1_HEADER";
    case "jwt_bearer":
      return "JWT_BEARER";
    case "mtls":
      return "MTLS";
    case "reconcile_by_lookup":
      return "RECONCILE_BY_LOOKUP";
    case "stream_iam":
      return "STREAM_IAM";
  }
}

/** Registry of the reviewed profiles of a deployment (one per (tenant, source)). */
export class SourceProfileRegistry {
  private readonly bySource = new Map<string, SourceProfile>();

  constructor(profiles: readonly unknown[]) {
    for (const raw of profiles) {
      const p = SourceProfile.parse(raw);
      if (this.bySource.has(p.sourceId)) throw new Error(`duplicate source profile ${p.sourceId}`);
      if (p.verifier.kind === "jwt_bearer" && (p.verifier.credentials === null) === (p.verifier.jwksUrl === null)) {
        throw new Error(`source ${p.sourceId}: a JWT verifier needs exactly one of credentials or jwksUrl`);
      }
      this.bySource.set(p.sourceId, p);
    }
  }

  get(sourceId: string): SourceProfile | null {
    return SOURCE_ID_RE.test(sourceId) ? (this.bySource.get(sourceId) ?? null) : null;
  }

  all(): SourceProfile[] {
    return [...this.bySource.values()];
  }
}
