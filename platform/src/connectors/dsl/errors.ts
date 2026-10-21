/**
 * Typed errors of the bounded mapping DSL (FO-06-05, FO-06-23; fault SCHEMA_DRIFT).
 *
 * Messages are reason codes only: a drift error names the drift kind and the TARGET field of the
 * profile mapping (a code-defined name), never a source value, a record identifier or vendor free text
 * (DATA-01). A drifted record is refused as a whole: nothing of it is returned, so no caller can write
 * a partially mapped record.
 */
import { PlatformError, ValidationError } from "../../shared/errors.js";

/** What changed between the profile mapping and what the vendor returned or described. */
export type DriftKind =
  | "MISSING_REQUIRED"
  | "TYPE_MISMATCH"
  | "UNKNOWN_ENUM_VALUE"
  | "UNIT_MISMATCH"
  | "ZONE_MISMATCH"
  | "PROHIBITED_FIELD_MAPPED"
  | "CLASSIFICATION_MISMATCH"
  | "RECORDS_NOT_AN_ARRAY"
  | "RECORD_NOT_AN_OBJECT"
  | "VALUE_TOO_LARGE";

export interface DriftIssue {
  kind: DriftKind;
  /** Target field of the mapping (profile vocabulary), or `$records` for the record container. */
  targetField: string;
}

/** Reason code thrown when a vendor response or metadata no longer matches the reviewed mapping. */
export const CONNECTOR_SCHEMA_DRIFT = "CONNECTOR_SCHEMA_DRIFT";

/**
 * A response or metadata document differs from the profile mapping (renamed, retyped, missing or
 * re-enumerated fields). Not retryable: the same response drifts again; the capability needs a new,
 * reviewed mapping (readiness turns UNKNOWN until requalified).
 */
export class ConnectorSchemaDriftError extends PlatformError {
  readonly issues: readonly DriftIssue[];
  /** Digest of the mapping the record was checked against (pins which reviewed mapping drifted). */
  readonly mappingDigest: string;

  constructor(issues: readonly DriftIssue[], mappingDigest: string) {
    super(CONNECTOR_SCHEMA_DRIFT, `${CONNECTOR_SCHEMA_DRIFT}:${[...new Set(issues.map((i) => i.kind))].sort().join(",")}`, false);
    this.issues = Object.freeze(issues.map((i) => ({ ...i })));
    this.mappingDigest = mappingDigest;
  }
}

/** A mapping or operation template that cannot be compiled (a profile defect, found before any request). */
export class MappingDefinitionError extends ValidationError {
  constructor(reasonCode: string) {
    super(reasonCode);
  }
}

/** The bounded interpreter refused to continue (step, size or depth limit): never a partial result. */
export class MappingLimitError extends PlatformError {
  constructor(reasonCode: "DSL_STEP_LIMIT" | "DSL_SIZE_LIMIT" | "DSL_DEPTH_LIMIT") {
    super(reasonCode, reasonCode, false);
  }
}
