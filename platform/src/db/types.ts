/**
 * Minimal database port shared by Aurora PostgreSQL (pg) and the embedded
 * PGlite engine used for offline tests. Both run real PostgreSQL SQL, so
 * migrations, constraints, row-level security and locking semantics are the
 * same code path. Multi-connection behaviour (contention, SKIP LOCKED, serialization
 * failures, pool exhaustion) exists only on `PgPoolDb`: PGlite has one connection, so
 * its tests never evidence concurrency (ADR-0018 decision 7.2).
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

/**
 * Database role used for the transaction. Runtime roles are subject to row-level security.
 * `app_audit_verifier` (migration 2042) reads the audit tables only and can write nothing
 * (the separate audit verifier identity, FO-15-40).
 */
export type DbRole = "app_runtime" | "app_worker" | "app_console" | "app_auditor" | "app_audit_verifier" | "owner";

/**
 * Bounded retry of a whole transaction on a serialization failure (40001) or a detected deadlock
 * (40P01). Opt-in: the transaction body runs again from the start, so it must have no effect
 * outside the database (no provider call, no publish) and must not depend on state of an
 * earlier attempt.
 */
export interface TxRetryPolicy {
  /** Total attempts including the first (2..10). */
  maxAttempts: number;
  /** Base of the jittered exponential delay between attempts (default 10 ms, at most 1000). */
  baseDelayMs?: number;
}

export interface TxOptions {
  /** Defaults to "app_runtime". "owner" bypasses RLS and is reserved for migrations and fixtures. */
  role?: DbRole;
  /** Row-level security context, applied with set_config(..., true) (transaction-local). */
  rls?: { tenantId: string; organizationId?: string | null; subjectId?: string | null; actorId?: string | null };
  isolation?: "read committed" | "repeatable read" | "serializable";
  retry?: TxRetryPolicy;
}

export interface Db extends Queryable {
  tx<T>(fn: (tx: Queryable) => Promise<T>, opts?: TxOptions): Promise<T>;
  close(): Promise<void>;
  readonly engine: "pglite" | "pg";
}
