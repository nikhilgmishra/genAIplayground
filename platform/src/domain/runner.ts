/**
 * The domain adapters' view of a connector (WP-23): reviewed operations run through the WP-06 connector runtime
 * (egress-classified transport, capability-scoped credentials, bounded mapping DSL, retry classification). The
 * adapters never build a request themselves; they name a canonical operation, the binding resolves it to the
 * profile's reviewed operation, and the runtime renders it from typed values.
 *
 * `ConnectorRuntime` (platform/src/connectors/runtime) satisfies `OperationRunner` structurally; unit tests may pass
 * a labelled fake.
 */
import type { MappedRecord } from "../connectors/dsl/mapping.js";
import type { MappedValue } from "../connectors/dsl/values.js";
import type { ExecuteInput, OperationResult, PagedResult } from "../connectors/runtime/connector.js";
import { ConnectorError, ConnectorRefusal } from "../connectors/runtime/errors.js";
import { ConnectorSchemaDriftError } from "../connectors/dsl/errors.js";
import type { ConnectorProfile } from "../protocol/connector.js";
import { canonicalJson, sha256Hex } from "../shared/canonical.js";
import type { Clock } from "../shared/clock.js";
import { systemClock } from "../shared/clock.js";
import { PlatformError, ValidationError } from "../shared/errors.js";
import type { AdmittedBinding } from "./binding.js";
import type { DomainRead, DomainSystem, SourceRef } from "./contracts.js";

export interface OperationRunner {
  readonly profile: ConnectorProfile;
  execute(operationId: string, input?: ExecuteInput): Promise<OperationResult>;
  reconcile(writeOperationId: string, input: ExecuteInput): Promise<{ found: boolean; result: OperationResult | null }>;
  readAll(operationId: string, input?: ExecuteInput): Promise<PagedResult>;
  health(): Promise<{ healthy: boolean; reasonCode: string | null }>;
}

/** A binding plus the runtime of its profile. */
export class DomainConnector {
  constructor(
    readonly binding: AdmittedBinding,
    readonly runner: OperationRunner,
    readonly system: DomainSystem,
    readonly clock: Clock = systemClock,
  ) {
    if (runner.profile.profileId !== binding.binding.connectorProfileId || runner.profile.configDigest !== binding.admitted.profile.configDigest) {
      throw new ValidationError("DOMAIN_RUNNER_PROFILE_MISMATCH");
    }
  }

  operationId(canonical: string): string {
    return this.binding.op(canonical).operationId;
  }

  async run(canonical: string, input: ExecuteInput = {}): Promise<OperationResult> {
    return this.runner.execute(this.operationId(canonical), input);
  }

  /** Every page of a list operation; a list the connector had to truncate is refused, never returned as complete. */
  async all(canonical: string, input: ExecuteInput = {}): Promise<{ records: PagedResult["records"]; source: SourceRef }> {
    const op = this.binding.op(canonical);
    const r = await this.runner.readAll(op.operationId, input);
    if (r.completeness !== "COMPLETE") throw new ValidationError("DOMAIN_LIST_TRUNCATED");
    // An empty list has no mapped record; the compiled mapping of the operation's object still applies.
    const mappingDigest = r.mappingDigest ?? (op.responseObject ? this.binding.admitted.mappings.get(op.responseObject)?.digest : undefined);
    if (mappingDigest === undefined) throw new ValidationError("DOMAIN_UNMAPPED_RESULT");
    const p = this.runner.profile;
    return {
      records: r.records,
      source: {
        kind: "CONNECTOR_READ",
        system: this.system,
        connectorProfileId: p.profileId,
        profileConfigDigest: p.configDigest,
        mappingDigest,
        operationId: r.operationId,
        // Digest of the mapped records of every page (the per-page response digests are not exposed by readAll).
        responseDigest: sha256Hex(canonicalJson(r.records.map((x) => x.values))),
        readAt: this.clock.now().toISOString(),
      },
    };
  }

  /** Provenance of records returned by `result` (only a connector read produces one). */
  source(result: OperationResult): SourceRef {
    if (result.mappingDigest === null) throw new ValidationError("DOMAIN_UNMAPPED_RESULT");
    const p = this.runner.profile;
    return {
      kind: "CONNECTOR_READ",
      system: this.system,
      connectorProfileId: p.profileId,
      profileConfigDigest: p.configDigest,
      mappingDigest: result.mappingDigest,
      operationId: result.operationId,
      responseDigest: result.receipt.responseDigest,
      readAt: new Date(result.receipt.at).toISOString(),
    };
  }
}

// ------------------------------------------------------------------ mapped record accessors (fail closed)

export function str(r: MappedRecord, field: string): string {
  const v = r.values[field];
  if (typeof v !== "string") throw new ValidationError("DOMAIN_RECORD_INVALID");
  return v;
}

export function optStr(r: MappedRecord, field: string): string | null {
  const v: MappedValue | undefined = r.values[field];
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") throw new ValidationError("DOMAIN_RECORD_INVALID");
  return v;
}

export function int(r: MappedRecord, field: string): number {
  const v = r.values[field];
  if (typeof v !== "number" || !Number.isSafeInteger(v)) throw new ValidationError("DOMAIN_RECORD_INVALID");
  return v;
}

export function optInt(r: MappedRecord, field: string): number | null {
  const v: MappedValue | undefined = r.values[field];
  if (v === null || v === undefined) return null;
  if (typeof v !== "number" || !Number.isSafeInteger(v)) throw new ValidationError("DOMAIN_RECORD_INVALID");
  return v;
}

export function single(result: OperationResult): MappedRecord {
  const r = result.records[0];
  if (result.records.length !== 1 || !r) throw new ValidationError("DOMAIN_RECORD_INVALID");
  return r;
}

// ------------------------------------------------------------------ read classification

/**
 * Runs a read and classifies every failure into an honest DomainRead: CONNECTOR_NOT_FOUND is NOT_FOUND; a
 * dependency failure, refusal, mapping drift or a record that does not satisfy the canonical contract is
 * UNAVAILABLE with its reason code. Nothing is retried here: the connector runtime already applied its one bounded
 * retry policy (a second retry layer would stack retries, NESTED_RETRY_REFUSED).
 */
export async function readSafely<T>(fn: () => Promise<T | null>): Promise<DomainRead<T>> {
  try {
    const value = await fn();
    return value === null ? { status: "NOT_FOUND" } : { status: "AVAILABLE", value };
  } catch (e) {
    return unavailable(e);
  }
}

export function unavailable(e: unknown): DomainRead<never> {
  if (e instanceof ConnectorError && e.reasonCode === "CONNECTOR_NOT_FOUND") return { status: "NOT_FOUND" };
  if (e instanceof ConnectorError) return { status: "UNAVAILABLE", reasonCode: e.reasonCode, outcome: e.outcome === "NOT_STARTED" ? "NOT_STARTED" : "FAILED", nextStep: "OFFER_HUMAN_OR_CALLBACK" };
  if (e instanceof ConnectorRefusal) return { status: "UNAVAILABLE", reasonCode: e.reasonCode, outcome: "NOT_STARTED", nextStep: "OFFER_HUMAN_OR_CALLBACK" };
  if (e instanceof ConnectorSchemaDriftError) return { status: "UNAVAILABLE", reasonCode: "CONNECTOR_SCHEMA_DRIFT", outcome: "FAILED", nextStep: "OFFER_HUMAN_OR_CALLBACK" };
  if (e instanceof PlatformError) return { status: "UNAVAILABLE", reasonCode: /^[A-Z][A-Z0-9_]{2,63}$/.test(e.reasonCode) ? e.reasonCode : "DOMAIN_READ_FAILED", outcome: "FAILED", nextStep: "OFFER_HUMAN_OR_CALLBACK" };
  return { status: "UNAVAILABLE", reasonCode: "DOMAIN_READ_FAILED", outcome: "FAILED", nextStep: "OFFER_HUMAN_OR_CALLBACK" };
}

/** Returns null for CONNECTOR_NOT_FOUND, rethrows everything else (for ports whose contract is `T | null`). */
export async function orNull<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ConnectorError && e.reasonCode === "CONNECTOR_NOT_FOUND") return null;
    throw e;
  }
}
