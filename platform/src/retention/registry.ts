/**
 * Dataset registry for the retention job. Each registered dataset names its
 * table, data class, timestamp/tenant/key/subject columns, delete strategy,
 * derived-copy verifiers and vendor copies. Registration is trusted
 * configuration (composition root), still validated strictly: identifiers must
 * be plain lowercase SQL identifiers and are always quoted.
 */
import { DataClass } from "../protocol/index.js";
import { digestOf } from "../shared/canonical.js";
import { ValidationError } from "../shared/errors.js";
import type { RetentionDataset } from "./ports.js";

export const SQL_IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;
const DATASET_NAME = /^[a-z][a-z0-9_]{2,62}$/;
const VENDOR = /^[a-z][a-z0-9_-]{2,40}$/;

export const quoteIdent = (id: string): string => {
  if (!SQL_IDENTIFIER.test(id)) throw new ValidationError("RETENTION_IDENTIFIER_INVALID");
  return `"${id}"`;
};

export class DatasetRegistry {
  private readonly datasets = new Map<string, RetentionDataset>();

  register(d: RetentionDataset): this {
    if (!DATASET_NAME.test(d.name)) throw new ValidationError("RETENTION_DATASET_NAME_INVALID");
    if (this.datasets.has(d.name)) throw new ValidationError("RETENTION_DATASET_DUPLICATE");
    if (!DataClass.safeParse(d.dataClass).success) throw new ValidationError("RETENTION_DATA_CLASS_INVALID");
    for (const col of [d.table, d.timestampColumn, d.tenantColumn, d.keyColumn, ...(d.subjectColumn ? [d.subjectColumn] : []), ...(d.keyColumns ?? [])]) quoteIdent(col);
    if (d.keyColumns !== undefined) {
      if (d.keyColumns.length < 2 || d.keyColumns.length > 4 || new Set(d.keyColumns).size !== d.keyColumns.length || d.keyColumns[0] !== d.keyColumn) {
        throw new ValidationError("RETENTION_KEY_COLUMNS_INVALID");
      }
    }
    if (d.deleteStrategy !== "HARD_DELETE" && d.deleteStrategy !== "CRYPTO_SHRED" && d.deleteStrategy !== "APPEND_ONLY_PURGE_REQUIRED") throw new ValidationError("RETENTION_STRATEGY_INVALID");
    const verifierNames = new Set<string>();
    for (const v of d.derivedCopies) {
      if (!DATASET_NAME.test(v.name) || verifierNames.has(v.name)) throw new ValidationError("RETENTION_VERIFIER_INVALID");
      verifierNames.add(v.name);
    }
    for (const vc of d.vendorCopies) {
      if (!VENDOR.test(vc.vendor)) throw new ValidationError("RETENTION_VENDOR_INVALID");
      quoteIdent(vc.refColumn);
    }
    this.datasets.set(d.name, Object.freeze({ ...d, derivedCopies: [...d.derivedCopies], vendorCopies: [...d.vendorCopies], ...(d.keyColumns ? { keyColumns: [...d.keyColumns] } : {}) }));
    return this;
  }

  list(): RetentionDataset[] {
    return [...this.datasets.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): RetentionDataset | undefined {
    return this.datasets.get(name);
  }

  /** Digest of the registry configuration (no data), for ReleaseManifest.retentionConfigurationDigest. */
  digest(): string {
    return digestOf(
      this.list().map((d) => ({
        name: d.name,
        table: d.table,
        dataClass: d.dataClass,
        timestampColumn: d.timestampColumn,
        tenantColumn: d.tenantColumn,
        keyColumn: d.keyColumn,
        ...(d.keyColumns ? { keyColumns: [...d.keyColumns] } : {}),
        subjectColumn: d.subjectColumn,
        deleteStrategy: d.deleteStrategy,
        derivedCopies: d.derivedCopies.map((v) => ({ name: v.name, kind: v.kind, location: v.location })),
        vendorCopies: d.vendorCopies.map((v) => ({ vendor: v.vendor, refColumn: v.refColumn })),
        owner: d.owner,
      })),
    );
  }
}

/**
 * Registration for the support memory table (migration 0700), owned by this
 * module set. Classification as BUSINESS_RECORD is an engineering default
 * pending the privacy counsel retention matrix (PRQ-025).
 */
export const SUPPORT_MEMORY_DATASET: RetentionDataset = {
  name: "support_memory",
  table: "support_memory",
  dataClass: "BUSINESS_RECORD",
  timestampColumn: "created_at",
  tenantColumn: "tenant_id",
  keyColumn: "memory_id",
  subjectColumn: "subject_id",
  deleteStrategy: "HARD_DELETE",
  derivedCopies: [],
  vendorCopies: [],
  owner: "memory",
};
