import type { Db } from "../db/types.js";
import type { DataClass } from "../protocol/index.js";

/**
 * Retention and deletion ports (spec section 6, DATA-03). Durations come only
 * from approved retention policies; nothing here supplies a default.
 */

export type DeleteStrategy =
  /** Row deletion in the primary store, with derived-copy verification and vendor requests. */
  | "HARD_DELETE"
  /** Per-record key destruction. BLOCKED: needs a per-record KMS key design and approval. */
  | "CRYPTO_SHRED";

export type CopyLocation = "DERIVED_TABLE" | "INDEX" | "CACHE" | "BACKUP" | "VENDOR";

export type VerifierResult =
  | { status: "VERIFIED_ABSENT" }
  | { status: "LEFTOVERS_FOUND"; leftoverKeys: string[] }
  | { status: "UNVERIFIABLE"; reasonCode: string };

/** Checks that copies derived from deleted records are gone (indexes, caches, backups, derived tables). */
export interface DerivedCopyVerifier {
  readonly name: string;
  readonly kind: "local_fixture" | "live";
  readonly location: CopyLocation;
  verify(input: { tenantId: string; dataset: string; deletedKeys: readonly string[]; db: Db }): Promise<VerifierResult>;
}

export interface VendorCopy {
  /** Vendor identifier, e.g. "talkdesk", "salesforce", "speech_vendor". */
  vendor: string;
  /** Column holding the vendor's opaque reference for the record. */
  refColumn: string;
}

export interface RetentionDataset {
  /** Stable dataset name used in holds, evidence and reports. */
  name: string;
  table: string;
  dataClass: DataClass;
  /** Column the retention period is measured from (e.g. created_at). */
  timestampColumn: string;
  tenantColumn: string;
  /** Opaque primary key column. */
  keyColumn: string;
  /** Subject column for subject-scoped legal holds; null when the dataset has none. */
  subjectColumn: string | null;
  deleteStrategy: DeleteStrategy;
  derivedCopies: readonly DerivedCopyVerifier[];
  vendorCopies: readonly VendorCopy[];
  /** Owning module, for the operator report. */
  owner: string;
}

export type ClassStatus = "EXECUTED" | "BLOCKED_RETENTION_UNSET" | "BLOCKED_RETENTION_CONFIG_MISMATCH";

export interface ClassReport {
  dataClass: DataClass;
  status: ClassStatus;
  retentionDays: number | null;
  policyVersion: number | null;
  approvalId: string | null;
  legalPurpose: string | null;
  cutoff: string | null;
}

export type DatasetStatus =
  | "DELETED"
  | "NOTHING_EXPIRED"
  | "SKIPPED_RETENTION_UNSET"
  | "HELD_SUBJECT_HOLD_UNRESOLVABLE"
  | "STRATEGY_BLOCKED"
  | "FAILED";

export interface CopyVerification {
  verifier: string;
  location: CopyLocation;
  verifierKind: "local_fixture" | "live";
  status: VerifierResult["status"];
  leftoverCount: number;
  reasonCode: string | null;
}

export interface DatasetReport {
  dataset: string;
  dataClass: DataClass;
  status: DatasetStatus;
  deletedCount: number;
  heldCount: number;
  deletionIds: string[];
  /** Digest over all deleted keys (sorted); null when nothing was deleted. */
  keyDigest: string | null;
  verifications: CopyVerification[];
  vendorRequests: { requestId: string; vendor: string; itemCount: number; status: "PENDING_VENDOR" }[];
  reasonCode: string | null;
}

export interface UnverifiedCopy {
  dataset: string;
  verifier: string;
  location: CopyLocation;
  status: "LEFTOVERS_FOUND" | "UNVERIFIABLE";
  leftoverCount: number;
  reasonCode: string | null;
}

export interface RetentionRunReport {
  runId: string;
  tenantId: string;
  startedAt: string;
  completedAt: string;
  status: "COMPLETED" | "COMPLETED_WITH_UNVERIFIED_COPIES" | "BLOCKED_RETENTION_UNSET" | "FAILED";
  classes: ClassReport[];
  datasets: DatasetReport[];
  unverifiedCopies: UnverifiedCopy[];
}

/** Verifies a RETENTION_SCHEDULE approval (bound to the config module's signed approval records in deployment). */
export interface RetentionApprovalVerifier {
  readonly kind: "local_fixture" | "live";
  verify(input: { approvalId: string; tenantId: string; dataClass: DataClass }): Promise<{ valid: boolean; approverRole: string | null; reasonCode: string }>;
}
