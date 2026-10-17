/**
 * Minimal database port shared by Aurora PostgreSQL (pg) and the embedded
 * PGlite engine used for offline tests. Both run real PostgreSQL SQL, so
 * migrations, constraints, row-level security and locking semantics are the
 * same code path.
 */
export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  /** Executes a multi-statement script without parameters (migrations, fixtures). */
  exec(sql: string): Promise<void>;
}

/** Database role used for the transaction. Runtime roles are subject to row-level security. */
export type DbRole = "app_runtime" | "app_worker" | "app_console" | "app_auditor" | "owner";

export interface TxOptions {
  /** Defaults to "app_runtime". "owner" bypasses RLS and is reserved for migrations and fixtures. */
  role?: DbRole;
  /** Row-level security context, applied with set_config(..., true) (transaction-local). */
  rls?: { tenantId: string; organizationId?: string | null; subjectId?: string | null; actorId?: string | null };
  isolation?: "read committed" | "repeatable read" | "serializable";
}

export interface Db extends Queryable {
  tx<T>(fn: (tx: Queryable) => Promise<T>, opts?: TxOptions): Promise<T>;
  close(): Promise<void>;
  readonly engine: "pglite" | "pg";
}
