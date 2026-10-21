import { z } from "zod";
import {
  AUTH_CONTEXT_SCHEMA_VERSION,
  Assurance,
  AuthContext,
  ConsentState,
  DelegatedAuthority,
  Environment,
  IsoDateTime,
  OpaqueId,
  RiskFlag,
  Role,
  Sha256Hex,
  VerificationMethod,
  VersionLabel,
} from "../protocol/index.js";
import type { IntegrationIdentity, ProcessingBasis } from "../protocol/index.js";
import type { Clock } from "../shared/clock.js";
import { iso } from "../shared/clock.js";
import { ConflictError, SessionInvalidError } from "../shared/errors.js";
import type { KvStore } from "./ports.js";
import type { SessionConfig } from "./config.js";
import { epochSeconds, kvKeys } from "./keys.js";

/**
 * Server-side session record stored in the KV store under `ses#<sha256(sessionRef)>`.
 * The bearer session reference itself is never persisted. Every field of
 * AuthContext that is security-relevant comes from here (AUTH-03); the request
 * supplies only the bearer value and its authenticated integration identity.
 */
const ReasonCodeField = z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/);

export const SessionRecord = z.strictObject({
  schema: z.literal("vsp.session.v1"),
  sessionRefHash: Sha256Hex,
  tenantId: OpaqueId,
  environment: Environment,
  integrationId: z.string().regex(/^[a-z0-9-]{3,64}$/),
  callId: OpaqueId,
  /** Caller ID digest: a risk signal only, never an authenticator (AUTH-01). */
  callerIdHash: Sha256Hex.nullable(),
  generation: z.number().int().min(1),
  actorId: OpaqueId.nullable(),
  /** Directory account bound by verification. Never exposed in AuthContext. */
  accountId: OpaqueId.nullable(),
  selectedRole: Role.nullable(),
  subjectId: OpaqueId.nullable(),
  organizationId: OpaqueId.nullable(),
  delegatedAuthority: z.array(DelegatedAuthority).max(16),
  permittedScopes: z.array(z.string().regex(/^[a-z_]+:[a-z_]+$/)).max(64),
  assurance: Assurance,
  authenticatedAt: IsoDateTime.nullable(),
  verificationMethod: VerificationMethod,
  consent: ConsentState,
  riskFlags: z.array(RiskFlag).max(16),
  policyVersion: VersionLabel,
  revoked: z.boolean(),
  revokedReason: ReasonCodeField.nullable(),
  ended: z.boolean(),
  endedAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
  expiresAt: IsoDateTime,
  stepUp: z
    .strictObject({ actionDigest: Sha256Hex, verifiedAt: IsoDateTime, expiresAt: IsoDateTime })
    .nullable(),
  lastChange: ReasonCodeField.nullable(),
  /**
   * Last use of the session (FO-05-18), written at a bounded rate. Optional for records written before
   * idle expiry existed; then the verification time (or creation) is the last activity.
   */
  lastActivityAt: IsoDateTime.nullable().optional(),
  /**
   * The actor whose verified privileges lapsed by idle expiry (FO-05-19): re-verification in this call
   * must bind the SAME actor; a different person needs an explicit account switch or participant change.
   */
  lapsedActorId: OpaqueId.nullable().optional(),
});
export type SessionRecord = z.infer<typeof SessionRecord>;

export type SessionInvalidReason =
  | "SESSION_NOT_FOUND"
  | "SESSION_RECORD_INVALID"
  | "SESSION_EXPIRED"
  | "SESSION_REVOKED"
  | "SESSION_ENDED"
  | "SESSION_TENANT_MISMATCH"
  | "SESSION_ENVIRONMENT_MISMATCH"
  | "SESSION_INTEGRATION_MISMATCH"
  | "SESSION_CHANNEL_NOT_ALLOWED"
  | "SESSION_CALL_MISMATCH"
  | "SESSION_IDLE_EXPIRED";

/** Clears every privilege-bearing field. Risk flags are retained (they are risk signals, not privileges). */
export function dropPrivileges(rec: SessionRecord): SessionRecord {
  return {
    ...rec,
    actorId: null,
    accountId: null,
    subjectId: null,
    organizationId: null,
    delegatedAuthority: [],
    permittedScopes: [],
    assurance: "A0",
    authenticatedAt: null,
    verificationMethod: "none",
    stepUp: null,
  };
}

export const addRiskFlag = (flags: readonly RiskFlag[], flag: RiskFlag): RiskFlag[] => (flags.includes(flag) ? [...flags] : [...flags, flag]);

/** Application-level validity, independent of storage TTL (AUTH-04). */
export function lifecycleProblem(rec: SessionRecord, now: Date): SessionInvalidReason | null {
  if (rec.revoked) return "SESSION_REVOKED";
  if (rec.ended) return "SESSION_ENDED";
  if (now.getTime() >= Date.parse(rec.expiresAt)) return "SESSION_EXPIRED";
  return null;
}

/** When the record was last used: lastActivityAt, else the verification time, else creation. */
export function lastActivityMs(rec: SessionRecord): number {
  const candidates = [rec.lastActivityAt, rec.authenticatedAt, rec.createdAt].filter((v): v is string => typeof v === "string").map((v) => Date.parse(v));
  return Math.max(...candidates);
}

/**
 * Verified privileges idle beyond the limit (FO-05-18, AUTH-04): checked on every use, independent of the
 * storage TTL and of the hard expiry. An unverified (A0) session has no privileges to lapse.
 */
export function privilegesIdleExpired(rec: SessionRecord, now: Date, cfg: Pick<SessionConfig, "privilegeIdleTimeoutSeconds">): boolean {
  if (rec.actorId === null && rec.assurance === "A0") return false;
  return now.getTime() - lastActivityMs(rec) > cfg.privilegeIdleTimeoutSeconds * 1000;
}

/**
 * Processing basis the identity service establishes for the session (FO-05-22): the counsel-approved basis
 * for the verified role when one is configured, otherwise the honest UNKNOWN (never a guess, never from a
 * caller statement or the model).
 */
export function processingBasisFor(rec: SessionRecord, cfg: Pick<SessionConfig, "jurisdiction" | "approvedProcessingBases">): ProcessingBasis {
  const approved = rec.actorId !== null && rec.selectedRole !== null ? cfg.approvedProcessingBases.find((b) => b.role === rec.selectedRole) : undefined;
  const establishedAt = rec.authenticatedAt ?? rec.createdAt;
  if (approved && cfg.jurisdiction !== "UNKNOWN") {
    return { basis: approved.basis, purpose: approved.purpose, jurisdiction: cfg.jurisdiction, approvalRef: approved.approvalRef, establishedAt, source: "identity_service" };
  }
  return { basis: "UNKNOWN", purpose: "support_administration", jurisdiction: cfg.jurisdiction, approvalRef: null, establishedAt, source: "identity_service" };
}

export function bindingProblem(rec: SessionRecord, integration: IntegrationIdentity, cfg: SessionConfig): SessionInvalidReason | null {
  if (integration.tenantId !== rec.tenantId || integration.tenantId !== cfg.tenantId) return "SESSION_TENANT_MISMATCH";
  if (integration.environment !== rec.environment || integration.environment !== cfg.environment) return "SESSION_ENVIRONMENT_MISMATCH";
  if (integration.integrationId !== rec.integrationId) return "SESSION_INTEGRATION_MISMATCH";
  if (!cfg.resolveChannels.includes(integration.channel)) return "SESSION_CHANNEL_NOT_ALLOWED";
  return null;
}

/** Builds the zod-validated AuthContext. A record that does not produce a valid context fails closed. */
export function toAuthContext(rec: SessionRecord, sessionRef: string, integration: IntegrationIdentity, now: Date, processingBasis?: ProcessingBasis): AuthContext {
  const stepUp = rec.stepUp && now.getTime() < Date.parse(rec.stepUp.expiresAt) ? rec.stepUp : null;
  const parsed = AuthContext.safeParse({
    schemaVersion: AUTH_CONTEXT_SCHEMA_VERSION,
    tenantId: rec.tenantId,
    callId: rec.callId,
    sessionRef,
    sessionGeneration: rec.generation,
    actorId: rec.actorId,
    selectedRole: rec.selectedRole,
    subjectId: rec.subjectId,
    organizationId: rec.organizationId,
    delegatedAuthority: rec.delegatedAuthority,
    permittedScopes: rec.permittedScopes,
    assurance: rec.assurance,
    authenticatedAt: rec.authenticatedAt,
    expiresAt: rec.expiresAt,
    verificationMethod: rec.verificationMethod,
    consent: rec.consent,
    riskFlags: rec.riskFlags,
    policyVersion: rec.policyVersion,
    revoked: rec.revoked,
    stepUp,
    integration,
    ...(processingBasis ? { processingBasis } : {}),
  });
  if (!parsed.success) throw new SessionInvalidError("SESSION_RECORD_INVALID");
  return parsed.data;
}

export type Mutator = (rec: SessionRecord, now: Date) => SessionRecord | { abort: string };

/**
 * KV-backed session record access with bounded compare-and-swap retries. Both the
 * SessionService and the VerificationService update sessions only through here.
 */
export class SessionStore {
  constructor(
    private readonly kv: KvStore,
    private readonly clock: Clock,
    private readonly cfg: SessionConfig,
  ) {}

  storageTtl(rec: Pick<SessionRecord, "expiresAt">): number {
    return epochSeconds(new Date(rec.expiresAt)) + this.cfg.storageTtlGraceSeconds;
  }

  async create(rec: SessionRecord): Promise<boolean> {
    return this.kv.putIfAbsent({ pk: kvKeys.session(rec.sessionRefHash), version: 1, ttlEpochSeconds: this.storageTtl(rec), data: SessionRecord.parse(rec) });
  }

  async load(hash: string): Promise<{ rec: SessionRecord; version: number } | null> {
    const item = await this.kv.get<unknown>(kvKeys.session(hash));
    if (!item) return null;
    const parsed = SessionRecord.safeParse(item.data);
    if (!parsed.success || parsed.data.sessionRefHash !== hash) throw new SessionInvalidError("SESSION_RECORD_INVALID");
    return { rec: parsed.data, version: item.version };
  }

  /**
   * Applies `fn` with optimistic concurrency. `fn` is re-run on every conflict
   * against the freshly read record, so checks inside it always see current state.
   * Returns the stored record, or `{ aborted }` when `fn` declined the change.
   */
  async mutate(hash: string, fn: Mutator): Promise<{ rec: SessionRecord } | { aborted: string }> {
    for (let attempt = 0; attempt < this.cfg.casMaxAttempts; attempt++) {
      const current = await this.load(hash);
      if (!current) return { aborted: "SESSION_NOT_FOUND" };
      const next = fn(structuredClone(current.rec), this.clock.now());
      if ("abort" in next) return { aborted: next.abort };
      const validated = SessionRecord.parse(next);
      if (validated.sessionRefHash !== hash) throw new SessionInvalidError("SESSION_RECORD_INVALID");
      const ok = await this.kv.compareAndSwap(kvKeys.session(hash), current.version, validated, this.storageTtl(validated));
      if (ok) return { rec: validated };
    }
    throw new ConflictError("SESSION_UPDATE_CONFLICT", "SESSION_UPDATE_CONFLICT", true);
  }

  now(): Date {
    return this.clock.now();
  }

  nowIso(): string {
    return iso(this.clock.now());
  }
}
