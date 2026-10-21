/**
 * Inbound credential versions and rotation (follow-on FO-06-98, FO-15-50; AUTH-06).
 *
 * A verifier never holds one fixed secret: it asks the resolver for the credential VERSIONS that are
 * valid now and verifies against each of them (constant time), recording which version verified the
 * event. Rotation therefore needs no restart:
 *   - SecretsManagerCredentialResolver reads the secret's AWSCURRENT, AWSPREVIOUS and (when the profile
 *     allows it) AWSPENDING versions with GetSecretValue. AWSPREVIOUS keeps verifying for
 *     `rotationOverlapSeconds` after AWSCURRENT was PROMOTED — not after it was created: a next key is
 *     often staged as AWSPENDING long before it becomes current — and is refused afterwards. Secrets
 *     Manager keeps no per-version promotion time, so the resolver records when a version was first seen
 *     as current in a durable ledger shared by every replica (PgCredentialPromotionLedger, migration 2044)
 *     and anchors the overlap there; when the promotion was not witnessed it falls back to a LOWER bound
 *     (shorter overlap), and when no bound is known the previous version gets no overlap (fail closed).
 *     AWSPENDING (the next credential, staged before the sender switches) verifies only when the profile
 *     accepts it. Results are cached for a bounded time (default 60 s), so a rotation is picked up within
 *     that bound; refresh() lets a scheduler observe rotations without waiting for traffic.
 *   - StaticCredentialResolverFixture (LOCAL FIXTURE) serves labelled synthetic versions in tests.
 * Secret values never reach logs, errors, metrics or the inbox: the inbox stores the version id only.
 */
import { GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import type { Db, DbRole } from "../db/types.js";
import { DependencyError, ValidationError } from "../shared/errors.js";
import type { Clock } from "../shared/clock.js";
import { iso } from "../shared/clock.js";

export interface CredentialVersion {
  /** Opaque version id (Secrets Manager VersionId, or a fixture label). Recorded with each accepted event. */
  version: string;
  /** Key material: HMAC / HS256 key bytes, a bearer secret, or a certificate fingerprint (hex). */
  material: Buffer;
  /** Version stage the material came from. */
  stage: "current" | "previous" | "pending";
  /** Instant after which the version no longer verifies (null: no expiry while it is current). */
  notAfter: Date | null;
}

export interface CredentialResolver {
  readonly kind: "live" | "local_fixture";
  /** Versions that verify at `now` (current first). Throws a reason-coded DependencyError when unavailable. */
  activeVersions(ref: string, policy: RotationPolicy, now: Date): Promise<CredentialVersion[]>;
}

export interface RotationPolicy {
  overlapSeconds: number;
  acceptPending: boolean;
}

export interface SecretsSender {
  send(command: GetSecretValueCommand): Promise<unknown>;
}

const VERSION_ID = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Secret value format (JSON, set by the rotation function): { "key": "<base64 key bytes>" } for HMAC/JWT
 * secrets, or { "fingerprint": "<sha256 hex>" } for a pinned client certificate. Anything else is refused.
 */
export function parseSecretMaterial(secretString: string): Buffer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(secretString);
  } catch {
    throw new DependencyError("INGRESS_CREDENTIAL_MALFORMED", "FAILED", false);
  }
  const o = parsed as { key?: unknown; fingerprint?: unknown } | null;
  if (o && typeof o.key === "string" && /^[A-Za-z0-9+/=_-]{16,1024}$/.test(o.key)) {
    const b = Buffer.from(o.key, "base64");
    if (b.length >= 16) return b;
  }
  if (o && typeof o.fingerprint === "string" && /^[a-f0-9]{64}$/.test(o.fingerprint)) return Buffer.from(o.fingerprint, "utf8");
  throw new DependencyError("INGRESS_CREDENTIAL_MALFORMED", "FAILED", false);
}

interface StageValue {
  versionId: string;
  /** Secrets Manager CreatedDate of the version; null when the service did not report it. */
  createdAt: Date | null;
  material: Buffer;
}

export type PromotionAnchorBasis = "WITNESSED" | "PREVIOUS_LAST_SEEN" | "VERSION_CREATED" | "UNKNOWN";

export interface CurrentObservation {
  ref: string;
  versionId: string;
  createdAt: Date | null;
  /** The version Secrets Manager reports as AWSPREVIOUS (null when there is none). */
  previousVersionId: string | null;
  now: Date;
  /** Longest gap between two observations for which a promotion counts as witnessed. */
  maxObservationGapMs: number;
}

/** Durable record of when each credential version was first observed as current (migration 2044). */
export interface CredentialPromotionLedger {
  /**
   * Records that `versionId` is current now and returns the anchor of the PREVIOUS version's overlap
   * window, fixed when the version was first observed (null: unknown, so no overlap).
   */
  observeCurrent(o: CurrentObservation): Promise<{ anchor: Date | null; basis: PromotionAnchorBasis }>;
}

/** PostgreSQL ledger shared by every replica: concurrent first observations agree on one anchor. */
export class PgCredentialPromotionLedger implements CredentialPromotionLedger {
  private readonly role: Extract<DbRole, "app_runtime" | "app_worker">;

  constructor(private readonly opts: { db: Db; role?: Extract<DbRole, "app_runtime" | "app_worker"> }) {
    this.role = opts.role ?? "app_runtime";
  }

  async observeCurrent(o: CurrentObservation): Promise<{ anchor: Date | null; basis: PromotionAnchorBasis }> {
    if (!VERSION_ID.test(o.versionId) || (o.previousVersionId !== null && !VERSION_ID.test(o.previousVersionId))) throw new DependencyError("INGRESS_CREDENTIAL_MALFORMED", "FAILED", false);
    type Row = { anchor: Date | string | null; basis: PromotionAnchorBasis };
    const read = (r: Row): { anchor: Date | null; basis: PromotionAnchorBasis } => ({ anchor: r.anchor === null ? null : new Date(r.anchor), basis: r.basis });
    try {
      return await this.opts.db.tx(
        async (tx) => {
          const now = iso(o.now);
          const known = await tx.query<Row>(
            `update ingress_credential_promotions set last_observed_current_at = greatest(last_observed_current_at, $3::timestamptz)
              where credential_ref = $1 and version_id = $2 returning overlap_anchor_at as anchor, anchor_basis as basis`,
            [o.ref, o.versionId, now],
          );
          if (known.rows[0]) return read(known.rows[0]);
          let anchor: Date | null = o.createdAt;
          let basis: PromotionAnchorBasis = o.createdAt ? "VERSION_CREATED" : "UNKNOWN";
          if (o.previousVersionId) {
            const prev = await tx.query<{ last: Date | string }>(
              "select last_observed_current_at as last from ingress_credential_promotions where credential_ref = $1 and version_id = $2",
              [o.ref, o.previousVersionId],
            );
            const last = prev.rows[0] ? new Date(prev.rows[0].last) : null;
            if (last && o.now.getTime() - last.getTime() <= o.maxObservationGapMs) {
              anchor = o.now;
              basis = "WITNESSED";
            } else if (last) {
              anchor = o.createdAt && o.createdAt.getTime() > last.getTime() ? o.createdAt : last;
              basis = "PREVIOUS_LAST_SEEN";
            }
          }
          await tx.query(
            `insert into ingress_credential_promotions (credential_ref, version_id, previous_version_id, version_created_at, first_observed_current_at,
               last_observed_current_at, overlap_anchor_at, anchor_basis)
             values ($1, $2, $3, $4::timestamptz, $5::timestamptz, $5::timestamptz, $6::timestamptz, $7)
             on conflict (credential_ref, version_id) do nothing`,
            [o.ref, o.versionId, o.previousVersionId, o.createdAt ? iso(o.createdAt) : null, now, anchor ? iso(anchor) : null, basis],
          );
          const fixed = await tx.query<Row>("select overlap_anchor_at as anchor, anchor_basis as basis from ingress_credential_promotions where credential_ref = $1 and version_id = $2", [o.ref, o.versionId]);
          const row = fixed.rows[0];
          if (!row) throw new DependencyError("INGRESS_CREDENTIAL_LEDGER_UNAVAILABLE", "FAILED", true);
          return read(row);
        },
        { role: this.role },
      );
    } catch (err) {
      if (err instanceof DependencyError) throw err;
      throw new DependencyError("INGRESS_CREDENTIAL_LEDGER_UNAVAILABLE", "FAILED", true);
    }
  }
}

export interface SecretsManagerCredentialResolverOptions {
  client: SecretsSender;
  clock: Clock;
  /** Durable promotion observations (shared by every replica). */
  promotions: CredentialPromotionLedger;
  /** How long fetched versions are reused (default 60 s, at most 600 s). */
  cacheTtlMs?: number;
  /**
   * Longest gap between observing the previous version as current and the new one for the promotion to
   * count as witnessed (default max(5 min, 2 x cacheTtlMs)). The old credential then verifies for at least
   * the overlap after the promotion and at most this much longer.
   */
  maxObservationGapMs?: number;
}

interface StageSet {
  current?: StageValue;
  previous?: StageValue;
  pending?: StageValue;
  /** Anchor of the previous version's overlap (from the promotion ledger); null: no overlap. */
  previousAnchor: Date | null;
}

export class SecretsManagerCredentialResolver implements CredentialResolver {
  readonly kind = "live" as const;
  private readonly cache = new Map<string, { at: number; stages: StageSet }>();
  private readonly cacheTtlMs: number;
  private readonly maxGapMs: number;

  constructor(private readonly opts: SecretsManagerCredentialResolverOptions) {
    const ttl = opts.cacheTtlMs ?? 60_000;
    if (!Number.isSafeInteger(ttl) || ttl < 0 || ttl > 600_000) throw new ValidationError("INGRESS_CREDENTIAL_CACHE_INVALID");
    const gap = opts.maxObservationGapMs ?? Math.max(300_000, 2 * ttl);
    if (!Number.isSafeInteger(gap) || gap < Math.max(1_000, ttl) || gap > 3_600_000) throw new ValidationError("INGRESS_CREDENTIAL_OBSERVATION_GAP_INVALID");
    this.cacheTtlMs = ttl;
    this.maxGapMs = gap;
  }

  async activeVersions(ref: string, policy: RotationPolicy, now: Date): Promise<CredentialVersion[]> {
    if (!ref.startsWith("arn:aws:secretsmanager:")) throw new ValidationError("INGRESS_CREDENTIAL_REF_INVALID");
    const stages = await this.stages(ref);
    const current = stages.current;
    if (!current) throw new DependencyError("INGRESS_CREDENTIAL_UNAVAILABLE", "FAILED", true);
    const out: CredentialVersion[] = [{ version: current.versionId, material: current.material, stage: "current", notAfter: null }];
    const prev = stages.previous;
    // The overlap counts from the PROMOTION of the current version; without a known anchor there is none.
    if (prev && prev.versionId !== current.versionId && stages.previousAnchor) {
      const notAfter = new Date(stages.previousAnchor.getTime() + policy.overlapSeconds * 1000);
      if (now.getTime() <= notAfter.getTime()) out.push({ version: prev.versionId, material: prev.material, stage: "previous", notAfter });
    }
    const pending = stages.pending;
    if (policy.acceptPending && pending && pending.versionId !== current.versionId) out.push({ version: pending.versionId, material: pending.material, stage: "pending", notAfter: null });
    return out;
  }

  /** Drops the cached versions of a secret (e.g. after an operator-triggered rotation). */
  invalidate(ref?: string): void {
    if (ref) this.cache.delete(ref);
    else this.cache.clear();
  }

  /** Re-reads a secret now and records what is current (for a scheduler observing rotations without traffic). */
  async refresh(ref: string): Promise<void> {
    if (!ref.startsWith("arn:aws:secretsmanager:")) throw new ValidationError("INGRESS_CREDENTIAL_REF_INVALID");
    this.cache.delete(ref);
    await this.stages(ref);
  }

  private async stages(ref: string): Promise<StageSet> {
    const now = this.opts.clock.now();
    const nowMs = now.getTime();
    const hit = this.cache.get(ref);
    if (hit && nowMs - hit.at < this.cacheTtlMs) return hit.stages;
    const stages: StageSet = { previousAnchor: null };
    for (const [stage, versionStage] of [
      ["current", "AWSCURRENT"],
      ["previous", "AWSPREVIOUS"],
      ["pending", "AWSPENDING"],
    ] as const) {
      let out: unknown;
      try {
        out = await this.opts.client.send(new GetSecretValueCommand({ SecretId: ref, VersionStage: versionStage }));
      } catch (err) {
        const name = (err as { name?: unknown }).name;
        if (stage !== "current" && name === "ResourceNotFoundException") continue; // no previous / pending version
        throw new DependencyError("INGRESS_CREDENTIAL_UNAVAILABLE", "FAILED", true);
      }
      const r = out as { VersionId?: unknown; SecretString?: unknown; CreatedDate?: unknown } | undefined;
      if (typeof r?.VersionId !== "string" || !VERSION_ID.test(r.VersionId) || typeof r.SecretString !== "string") {
        throw new DependencyError("INGRESS_CREDENTIAL_MALFORMED", "FAILED", false);
      }
      // A missing creation time is unknown, never "now" (that would re-open the overlap on every refresh).
      const createdAt = r.CreatedDate instanceof Date && !Number.isNaN(r.CreatedDate.getTime()) ? r.CreatedDate : null;
      stages[stage] = { versionId: r.VersionId, createdAt, material: parseSecretMaterial(r.SecretString) };
    }
    if (stages.current) {
      const observed = await this.opts.promotions.observeCurrent({
        ref,
        versionId: stages.current.versionId,
        createdAt: stages.current.createdAt,
        previousVersionId: stages.previous?.versionId ?? null,
        now,
        maxObservationGapMs: this.maxGapMs,
      });
      stages.previousAnchor = observed.anchor;
    }
    this.cache.set(ref, { at: nowMs, stages });
    return stages;
  }
}

/** LOCAL FIXTURE: synthetic credential versions per fixture ref, with explicit validity windows. */
export class StaticCredentialResolverFixture implements CredentialResolver {
  readonly kind = "local_fixture" as const;
  readonly label = "LOCAL FIXTURE CREDENTIALS — synthetic keys, not secrets";
  private readonly versions = new Map<string, { version: string; material: Buffer; validFrom: Date; validUntil: Date | null; stage: CredentialVersion["stage"] }[]>();

  set(ref: string, versions: { version: string; material: Buffer | string; validFrom?: Date; validUntil?: Date | null; stage?: CredentialVersion["stage"] }[]): this {
    if (!ref.startsWith("local-fixture:")) throw new ValidationError("INGRESS_CREDENTIAL_REF_INVALID");
    this.versions.set(
      ref,
      versions.map((v) => ({
        version: v.version,
        material: typeof v.material === "string" ? Buffer.from(v.material, "utf8") : v.material,
        validFrom: v.validFrom ?? new Date(0),
        validUntil: v.validUntil ?? null,
        stage: v.stage ?? "current",
      })),
    );
    return this;
  }

  async activeVersions(ref: string, _policy: RotationPolicy, now: Date): Promise<CredentialVersion[]> {
    const list = this.versions.get(ref);
    if (!list) throw new DependencyError("INGRESS_CREDENTIAL_UNAVAILABLE", "FAILED", true);
    return list
      .filter((v) => v.validFrom.getTime() <= now.getTime() && (v.validUntil === null || now.getTime() <= v.validUntil.getTime()))
      .map((v) => ({ version: v.version, material: v.material, stage: v.stage, notAfter: v.validUntil }));
  }
}
