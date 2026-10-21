/**
 * SecretResolver: the only credential source of the connector runtime (WP-06; FO-06-04, FO-03-29,
 * FO-16-31, FO-15-26; AUTH-06, DATA-01).
 *
 * Connector configuration holds a credential REFERENCE (`arn:aws:secretsmanager:...`, validated by the
 * ConnectorProfile contract), never a value. The resolver reads the value at runtime:
 *   - SecretsManagerSecretResolver: GetSecretValue with an explicit version stage (AWSCURRENT by default;
 *     AWSPENDING only for rotation testing), a bounded TTL cache keyed by reference and stage, and
 *     `refresh(ref)` which the token manager calls after an authentication failure, so a rotated
 *     credential is picked up on the next token request without a restart. The returned VersionId is
 *     recorded (content-free) so evidence can say which version authenticated.
 *   - KMS key ARNs are signing keys used through a signer, never resolved to a value
 *     (SECRET_REF_NOT_A_SECRET); SSM parameters need @aws-sdk/client-ssm, which is not in the pinned
 *     dependency set, and are refused with SECRET_STORE_NOT_SUPPORTED instead of being guessed.
 *   - LocalFixtureSecretResolver (LOCAL FIXTURE, kind "local_fixture"): labelled synthetic values for
 *     `local-fixture:` references, refused outside local/ci by `createSecretResolver`.
 * Secret material is wrapped in SecretValue, whose string, JSON and inspect forms are redacted: it can be
 * passed around without leaking into logs, errors, metrics or serialized evidence.
 */
import { inspect } from "node:util";
import { GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import type { Environment } from "../../protocol/common.js";
import type { Metrics } from "../../observability/ports.js";
import type { Clock } from "../../shared/clock.js";
import { DependencyError, ValidationError } from "../../shared/errors.js";

export type VersionStage = "AWSCURRENT" | "AWSPENDING" | "AWSPREVIOUS";

const REDACTED = "[secret]";

/** Opaque holder of secret material; only `reveal()` returns the value. */
export class SecretValue {
  readonly #value: string;
  constructor(value: string) {
    this.#value = value;
  }
  reveal(): string {
    return this.#value;
  }
  /** Parses the material as a JSON object (the documented secret format of the connector runtime). */
  json(): Record<string, unknown> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(this.#value);
    } catch {
      throw new DependencyError("SECRET_MALFORMED", "FAILED", false);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new DependencyError("SECRET_MALFORMED", "FAILED", false);
    return parsed as Record<string, unknown>;
  }
  toString(): string {
    return REDACTED;
  }
  toJSON(): string {
    return REDACTED;
  }
  [inspect.custom](): string {
    return REDACTED;
  }
}

export interface ResolvedSecret {
  readonly ref: string;
  /** Secrets Manager VersionId (or the fixture version label): content-free, safe to record. */
  readonly versionId: string;
  readonly stage: VersionStage;
  readonly value: SecretValue;
  readonly fetchedAt: Date;
}

export interface SecretResolver {
  readonly kind: "live" | "local_fixture";
  resolve(ref: string, stage?: VersionStage): Promise<ResolvedSecret>;
  /** Drops cached versions of `ref` (after an authentication failure or an operator-triggered rotation). */
  refresh(ref: string): void;
}

/** The subset of SecretsManagerClient the resolver uses (the production client satisfies it). */
export interface SecretsManagerSender {
  send(command: GetSecretValueCommand): Promise<unknown>;
}

const SM_REF = /^arn:aws:secretsmanager:[A-Za-z0-9-]{1,32}:[A-Za-z0-9]{1,32}:secret:[A-Za-z0-9/_+=.@-]{1,256}$/;
const FIXTURE_REF = /^local-fixture:[a-z0-9][a-z0-9._/-]{0,127}$/;
const VERSION_ID = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_SECRET_CHARS = 65_536;

/** Refuses references that no resolver may read, with a reason code naming why. */
export function refuseUnresolvable(ref: string): void {
  if (ref.startsWith("arn:aws:kms:")) throw new ValidationError("SECRET_REF_NOT_A_SECRET");
  if (ref.startsWith("arn:aws:ssm:")) throw new ValidationError("SECRET_STORE_NOT_SUPPORTED");
}

export interface SecretsManagerResolverOptions {
  clock: Clock;
  /** Cache lifetime (default 300 s, at most 3 600 s): a rotation is picked up within this bound even without an auth failure. */
  cacheTtlMs?: number;
  maxEntries?: number;
  metrics?: Metrics;
}

export class SecretsManagerSecretResolver implements SecretResolver {
  readonly kind = "live" as const;
  private readonly cache = new Map<string, ResolvedSecret>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly inFlight = new Map<string, Promise<ResolvedSecret>>();
  /** Bumped by refresh(ref): a read that was in flight across it is never cached. */
  private readonly generation = new Map<string, number>();

  constructor(
    private readonly client: SecretsManagerSender,
    private readonly opts: SecretsManagerResolverOptions,
  ) {
    this.ttlMs = opts.cacheTtlMs ?? 300_000;
    this.maxEntries = opts.maxEntries ?? 256;
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs < 0 || this.ttlMs > 3_600_000) throw new ValidationError("SECRET_CACHE_TTL_INVALID");
    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries < 1 || this.maxEntries > 10_000) throw new ValidationError("SECRET_CACHE_SIZE_INVALID");
  }

  async resolve(ref: string, stage: VersionStage = "AWSCURRENT"): Promise<ResolvedSecret> {
    refuseUnresolvable(ref);
    if (!SM_REF.test(ref)) throw new ValidationError("SECRET_REF_INVALID");
    const key = `${stage}|${ref}`;
    const hit = this.cache.get(key);
    const now = this.opts.clock.now();
    if (hit && now.getTime() - hit.fetchedAt.getTime() < this.ttlMs) {
      this.count("cache_hit");
      return hit;
    }
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const p = this.fetch(ref, stage, this.generation.get(ref) ?? 0).finally(() => {
      if (this.inFlight.get(key) === p) this.inFlight.delete(key);
    });
    this.inFlight.set(key, p);
    return p;
  }

  /**
   * Drops the cached versions of `ref`. A read in flight at that moment may return the version being
   * replaced: it answers the callers already waiting for it but is not cached, and later callers read again.
   */
  refresh(ref: string): void {
    this.generation.set(ref, (this.generation.get(ref) ?? 0) + 1);
    for (const k of [...this.cache.keys()]) if (k.endsWith(`|${ref}`)) this.cache.delete(k);
    for (const k of [...this.inFlight.keys()]) if (k.endsWith(`|${ref}`)) this.inFlight.delete(k);
    this.count("refreshed");
  }

  private async fetch(ref: string, stage: VersionStage, gen: number): Promise<ResolvedSecret> {
    let out: unknown;
    try {
      out = await this.client.send(new GetSecretValueCommand({ SecretId: ref, VersionStage: stage }));
    } catch (err) {
      const name = (err as { name?: unknown } | null)?.name;
      this.count("unavailable");
      // A missing secret or stage is a configuration defect (not retryable); anything else may be transient.
      if (name === "ResourceNotFoundException") throw new DependencyError("SECRET_NOT_FOUND", "FAILED", false);
      if (name === "AccessDeniedException" || name === "DecryptionFailure") throw new DependencyError("SECRET_ACCESS_DENIED", "FAILED", false);
      throw new DependencyError("SECRET_STORE_UNAVAILABLE", "NOT_STARTED", true);
    }
    const r = out as { VersionId?: unknown; SecretString?: unknown } | undefined;
    if (typeof r?.VersionId !== "string" || !VERSION_ID.test(r.VersionId) || typeof r.SecretString !== "string" || r.SecretString.length === 0 || r.SecretString.length > MAX_SECRET_CHARS) {
      this.count("malformed");
      throw new DependencyError("SECRET_MALFORMED", "FAILED", false);
    }
    const resolved: ResolvedSecret = { ref, versionId: r.VersionId, stage, value: new SecretValue(r.SecretString), fetchedAt: this.opts.clock.now() };
    this.count("fetched");
    if ((this.generation.get(ref) ?? 0) !== gen) return resolved; // refreshed while in flight: never cached
    if (this.cache.size >= this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(`${stage}|${ref}`, resolved);
    return resolved;
  }

  private count(result: string): void {
    try {
      this.opts.metrics?.increment("vsp_connector_secret_resolutions_total", { result });
    } catch {
      // metrics never change a resolution
    }
  }
}

/** LOCAL FIXTURE: labelled synthetic secret values for `local-fixture:` references (unit tests, local runs). */
export class LocalFixtureSecretResolver implements SecretResolver {
  readonly kind = "local_fixture" as const;
  readonly label = "LOCAL FIXTURE SECRETS — synthetic values, not credentials";
  private readonly values = new Map<string, { versionId: string; value: string }>();
  private readonly pending = new Map<string, { versionId: string; value: string }>();
  refreshCount = 0;

  constructor(private readonly clock: Clock) {}

  /** Sets (or rotates) the current synthetic value of a fixture reference. */
  set(ref: string, value: string | Record<string, unknown>, versionId = `v${this.values.size + 1}`): this {
    if (!FIXTURE_REF.test(ref)) throw new ValidationError("SECRET_REF_INVALID");
    this.values.set(ref, { versionId, value: typeof value === "string" ? value : JSON.stringify(value) });
    return this;
  }

  setPending(ref: string, value: string | Record<string, unknown>, versionId: string): this {
    if (!FIXTURE_REF.test(ref)) throw new ValidationError("SECRET_REF_INVALID");
    this.pending.set(ref, { versionId, value: typeof value === "string" ? value : JSON.stringify(value) });
    return this;
  }

  async resolve(ref: string, stage: VersionStage = "AWSCURRENT"): Promise<ResolvedSecret> {
    refuseUnresolvable(ref);
    if (!FIXTURE_REF.test(ref)) throw new ValidationError("SECRET_REF_INVALID");
    const v = stage === "AWSPENDING" ? this.pending.get(ref) : stage === "AWSCURRENT" ? this.values.get(ref) : undefined;
    if (!v) throw new DependencyError("SECRET_NOT_FOUND", "FAILED", false);
    return { ref, versionId: v.versionId, stage, value: new SecretValue(v.value), fetchedAt: this.clock.now() };
  }

  refresh(_ref: string): void {
    this.refreshCount += 1;
  }
}

/**
 * Chooses the resolver for an environment. Outside local/ci only the Secrets Manager resolver exists, and
 * a `local-fixture:` reference fails closed (OPS-04); in local/ci both are available, selected by the
 * reference's scheme.
 */
export function createSecretResolver(opts: { environment: Environment; secretsManager: SecretResolver | null; fixture?: SecretResolver | null }): SecretResolver {
  const live = opts.secretsManager;
  const fixture = opts.fixture ?? null;
  const local = opts.environment === "local" || opts.environment === "ci";
  if (!local && fixture !== null) throw new ValidationError("SECRET_FIXTURE_RESOLVER_OUTSIDE_LOCAL");
  if (live !== null && live.kind !== "live") throw new ValidationError("SECRET_RESOLVER_KIND_INVALID");
  return {
    kind: live !== null ? "live" : "local_fixture",
    async resolve(ref: string, stage?: VersionStage) {
      if (ref.startsWith("local-fixture:")) {
        if (!local || fixture === null) throw new ValidationError("SECRET_FIXTURE_REF_REFUSED");
        return fixture.resolve(ref, stage);
      }
      if (live === null) throw new ValidationError("SECRET_STORE_NOT_CONFIGURED");
      return live.resolve(ref, stage);
    },
    refresh(ref: string) {
      if (ref.startsWith("local-fixture:")) fixture?.refresh(ref);
      else live?.refresh(ref);
    },
  };
}
