/**
 * Audit event model (spec section 13). Structured decision evidence and tool
 * receipts; never raw secrets, free-form model reasoning or transcript text.
 */
import { z } from "zod";
import { Assurance, DataClass, IsoDateTime, OpaqueId, Role, Sha256Hex, StaffRole, VersionSet } from "./common.js";
import { ReasonCode } from "./tools.js";

export const AUDIT_SCHEMA_VERSION = "audit.v1";

export const AuditOutcome = z.enum([
  "ALLOWED",
  "DENIED",
  "SUCCEEDED",
  "FAILED",
  "PENDING",
  "UNKNOWN",
  "INVALIDATED",
  "RECONCILED",
]);
export type AuditOutcome = z.infer<typeof AuditOutcome>;

export const AuditSourceComponent = z.enum([
  "gateway",
  "mcp_adapter",
  "telephony_control",
  "identity",
  "policy",
  "actions",
  "workflow",
  "knowledge",
  "safety",
  "voice_gate",
  "console",
  "worker",
  "retention",
  "config",
]);
export type AuditSourceComponent = z.infer<typeof AuditSourceComponent>;

export const AuditEvent = z.strictObject({
  eventId: OpaqueId,
  schemaVersion: z.literal(AUDIT_SCHEMA_VERSION),
  occurredAt: IsoDateTime,
  correlationId: OpaqueId,
  parentId: OpaqueId.nullable(),
  /**
   * Event or request that caused this one (follow-on envelope; distinct from the hierarchical
   * parentId). Optional: absent on events written before the field existed, so their hash chain
   * is unchanged; covered by the hash when present.
   */
  causationId: OpaqueId.optional(),
  tenantId: OpaqueId,
  actorRef: OpaqueId.nullable(),
  subjectRef: OpaqueId.nullable(),
  role: z.union([Role, StaffRole]).nullable(),
  sourceComponent: AuditSourceComponent,
  callId: OpaqueId.nullable(),
  sessionRef: z.string().max(128).nullable(),
  sessionGeneration: z.number().int().min(0).nullable(),
  turnId: z.string().max(80).nullable(),
  versions: VersionSet.nullable(),
  /** Dotted action name, e.g. "tool.invoke", "action.commit", "session.revoke", "killswitch.engage". */
  action: z.string().regex(/^[a-z][a-z0-9_.]{2,80}$/),
  policyDecision: z
    .strictObject({
      decisionId: OpaqueId,
      allow: z.boolean(),
      reasonCodes: z.array(ReasonCode).max(16),
      policyVersion: z.string().max(64),
    })
    .nullable(),
  assurance: Assurance.nullable(),
  evidencePointers: z.array(z.string().max(200)).max(16),
  beforeHash: Sha256Hex.nullable(),
  afterHash: Sha256Hex.nullable(),
  idempotencyKey: z.string().max(128).nullable(),
  outcome: AuditOutcome,
  reasonCode: ReasonCode.nullable(),
  dataClass: DataClass,
  /** Monotonic per-source sequence for gap detection, plus hash chain for tamper evidence. */
  sourceStream: z.string().regex(/^[a-z0-9_.-]{3,64}$/),
  sequence: z.number().int().min(1),
  prevHash: Sha256Hex.nullable(),
  hash: Sha256Hex,
});
export type AuditEvent = z.infer<typeof AuditEvent>;

/** Input accepted by the audit writer; chain fields are assigned by the writer. */
export const AuditEventInput = AuditEvent.omit({
  eventId: true,
  schemaVersion: true,
  sequence: true,
  prevHash: true,
  hash: true,
  sourceStream: true,
});
export type AuditEventInput = z.infer<typeof AuditEventInput>;

export const AuditManifestSignature = z.strictObject({
  algorithm: z.enum(["ECDSA_P256_SHA256", "RSASSA_PSS_SHA256", "ED25519"]),
  /** KMS key ARN (or labelled local fixture key) that signed; never key material. */
  keyRef: z.string().max(512).regex(/^(arn:aws:kms:[A-Za-z0-9-]{1,32}:[0-9]{12}:key\/[A-Za-z0-9-]{1,128}|local-fixture:[a-z0-9][a-z0-9._/-]{0,127})$/),
  /** base64url signature value. */
  value: z.string().min(16).max(1024).regex(/^[A-Za-z0-9_-]+$/),
});
export type AuditManifestSignature = z.infer<typeof AuditManifestSignature>;

/** Tamper-evident manifest for a shipped batch. Hashing alone does not prove completeness. */
export const AuditManifest = z.strictObject({
  manifestId: OpaqueId,
  sourceStream: z.string(),
  firstSequence: z.number().int().min(1),
  lastSequence: z.number().int().min(1),
  eventCount: z.number().int().min(1),
  firstPrevHash: Sha256Hex.nullable(),
  lastHash: Sha256Hex,
  batchDigest: Sha256Hex,
  createdAt: IsoDateTime,
  objectKey: z.string().max(256),
  /**
   * Detached signature over the canonical manifest without the three signature fields, by the
   * audit exporter's KMS key (follow-on prompt section 15). Optional until the exporter (WP-04)
   * signs; a verifier treats an unsigned manifest as unsigned, never as verified.
   */
  signature: AuditManifestSignature.optional(),
  signedAt: IsoDateTime.optional(),
  signerRole: z.enum(["audit_exporter", "audit_writer"]).optional(),
});
export type AuditManifest = z.infer<typeof AuditManifest>;

/** True when all three signature fields are present together (partial signatures are invalid). */
export const manifestSignaturePresent = (m: AuditManifest): boolean => m.signature !== undefined && m.signedAt !== undefined && m.signerRole !== undefined;
