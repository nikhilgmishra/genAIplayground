/**
 * Platform datasets registered with the retention job (spec section 6: retention by data class
 * and legal purpose; deletion verification for derived copies, indexes, caches and backups).
 *
 * Every class stays BLOCKED_RETENTION_UNSET until privacy counsel approves a duration
 * (RETENTION_SCHEDULE approval); registering a dataset never deletes anything by itself.
 *
 * DATA CLASSES ARE ENGINEERING CLASSIFICATIONS pending the counsel-approved retention matrix
 * (PRQ-025):
 *  - BUSINESS_RECORD: support requests, their links, interactions, the per-call action index and
 *    interaction outcomes (migration 0300), and support memory (0700);
 *  - TRANSIENT_CONVERSATION: tool-request idempotency rows (stored tool responses replayed within a
 *    conversation, migration 0105);
 *  - SECURITY_AUDIT: console idempotency rows (records of authenticated staff administrative
 *    requests and their content-free responses, migration 0900).
 *
 * Deletion paths:
 *  - the 0300 support records are append-only by design (a trigger refuses DELETE for every role),
 *    so they are registered APPEND_ONLY_PURGE_REQUIRED: the job reports STRATEGY_BLOCKED /
 *    RETENTION_PURGE_PATH_REQUIRED until the business owner ships a reviewed purge path;
 *  - tool_request_idempotency is HARD_DELETE (app_worker already holds DELETE under tenant RLS);
 *  - console_idempotency is HARD_DELETE, but app_worker holds no privilege on it yet (console
 *    module, migration 09xx); the job reports RETENTION_DELETE_PRIVILEGE_MISSING until it does.
 *
 * Copies the application cannot verify (Aurora snapshots / S3 versions under infrastructure
 * retention) are declared and always reported UNVERIFIABLE, never as deleted (OPS-03).
 */
import type { RetentionDataset } from "./ports.js";
import { DatasetRegistry, SUPPORT_MEMORY_DATASET } from "./registry.js";
import { derivedTableVerifier, unverifiableCopy } from "./verifiers.js";

/** Database backups age out under infrastructure retention; they cannot be verified from the application. */
export const DATABASE_BACKUPS_COPY = unverifiableCopy("database_backups", "BACKUP", "BACKUP_RETENTION_INFRASTRUCTURE_MANAGED");

export const SUPPORT_REQUESTS_DATASET: RetentionDataset = {
  name: "support_requests",
  table: "support_requests",
  dataClass: "BUSINESS_RECORD",
  timestampColumn: "created_at",
  tenantColumn: "tenant_id",
  keyColumn: "support_request_id",
  subjectColumn: "subject_ref",
  deleteStrategy: "APPEND_ONLY_PURGE_REQUIRED",
  derivedCopies: [
    // Links (action / workflow / interaction) of a deleted support request must be gone too.
    derivedTableVerifier({ name: "support_request_links_by_request", table: "support_request_links", tenantColumn: "tenant_id", sourceKeyColumn: "support_request_id" }),
    DATABASE_BACKUPS_COPY,
  ],
  // The minimized Case synchronized to Salesforce (the support system of record): vendor deletion request.
  vendorCopies: [{ vendor: "salesforce", refColumn: "salesforce_case_id" }],
  owner: "business",
};

export const SUPPORT_REQUEST_LINKS_DATASET: RetentionDataset = {
  name: "support_request_links",
  table: "support_request_links",
  dataClass: "BUSINESS_RECORD",
  timestampColumn: "created_at",
  tenantColumn: "tenant_id",
  keyColumn: "link_id",
  subjectColumn: null,
  deleteStrategy: "APPEND_ONLY_PURGE_REQUIRED",
  derivedCopies: [DATABASE_BACKUPS_COPY],
  vendorCopies: [],
  owner: "business",
};

export const SUPPORT_INTERACTIONS_DATASET: RetentionDataset = {
  name: "support_interactions",
  table: "support_interactions",
  dataClass: "BUSINESS_RECORD",
  timestampColumn: "created_at",
  tenantColumn: "tenant_id",
  keyColumn: "interaction_external_id",
  subjectColumn: null,
  deleteStrategy: "APPEND_ONLY_PURGE_REQUIRED",
  derivedCopies: [
    // Support requests reference their interaction; none may outlive it.
    derivedTableVerifier({ name: "support_requests_by_interaction", table: "support_requests", tenantColumn: "tenant_id", sourceKeyColumn: "interaction_external_id" }),
    DATABASE_BACKUPS_COPY,
  ],
  vendorCopies: [],
  owner: "business",
};

export const INTERACTION_ACTIONS_DATASET: RetentionDataset = {
  name: "interaction_actions",
  table: "interaction_actions",
  dataClass: "BUSINESS_RECORD",
  timestampColumn: "created_at",
  tenantColumn: "tenant_id",
  keyColumn: "action_id",
  subjectColumn: null,
  deleteStrategy: "APPEND_ONLY_PURGE_REQUIRED",
  derivedCopies: [DATABASE_BACKUPS_COPY],
  vendorCopies: [],
  owner: "business",
};

export const INTERACTION_OUTCOMES_DATASET: RetentionDataset = {
  name: "interaction_outcomes",
  table: "interaction_outcomes",
  dataClass: "BUSINESS_RECORD",
  timestampColumn: "recorded_at",
  tenantColumn: "tenant_id",
  keyColumn: "outcome_id",
  subjectColumn: null,
  deleteStrategy: "APPEND_ONLY_PURGE_REQUIRED",
  derivedCopies: [DATABASE_BACKUPS_COPY],
  vendorCopies: [],
  owner: "business",
};

/** Stored tool responses for idempotent replay (purged after expiry by the worker; bounded here by the class duration). */
export const TOOL_REQUEST_IDEMPOTENCY_DATASET: RetentionDataset = {
  name: "tool_request_idempotency",
  table: "tool_request_idempotency",
  dataClass: "TRANSIENT_CONVERSATION",
  timestampColumn: "created_at",
  tenantColumn: "tenant_id",
  keyColumn: "integration_id",
  keyColumns: ["integration_id", "idempotency_key"],
  subjectColumn: null,
  deleteStrategy: "HARD_DELETE",
  derivedCopies: [DATABASE_BACKUPS_COPY],
  vendorCopies: [],
  owner: "actions",
};

/** Console idempotency replay records (staff administrative requests; content-free responses). */
export const CONSOLE_IDEMPOTENCY_DATASET: RetentionDataset = {
  name: "console_idempotency",
  table: "console_idempotency",
  dataClass: "SECURITY_AUDIT",
  timestampColumn: "created_at",
  tenantColumn: "tenant_id",
  keyColumn: "staff_id",
  keyColumns: ["staff_id", "endpoint", "idempotency_key_hash"],
  subjectColumn: null,
  deleteStrategy: "HARD_DELETE",
  derivedCopies: [DATABASE_BACKUPS_COPY],
  vendorCopies: [],
  owner: "console-api",
};

/** Every dataset the platform registers with the retention job (support memory plus the datasets above). */
export const PLATFORM_RETENTION_DATASETS: readonly RetentionDataset[] = Object.freeze([
  SUPPORT_MEMORY_DATASET,
  SUPPORT_REQUESTS_DATASET,
  SUPPORT_REQUEST_LINKS_DATASET,
  SUPPORT_INTERACTIONS_DATASET,
  INTERACTION_ACTIONS_DATASET,
  INTERACTION_OUTCOMES_DATASET,
  TOOL_REQUEST_IDEMPOTENCY_DATASET,
  CONSOLE_IDEMPOTENCY_DATASET,
]);

/** Registry for the composition root (replaces `new DatasetRegistry().register(SUPPORT_MEMORY_DATASET)`). */
export function createPlatformDatasetRegistry(): DatasetRegistry {
  const registry = new DatasetRegistry();
  for (const d of PLATFORM_RETENTION_DATASETS) registry.register(d);
  return registry;
}
