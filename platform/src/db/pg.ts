import pg from "pg";
import { DependencyError } from "../shared/errors.js";
import { applyTxOptions, sqlState, withTxRetry } from "./apply-tx-options.js";
import type { Db, Queryable, QueryResult, TxOptions } from "./types.js";

export interface PgPoolOptions {
  /** Maximum connections in the pool (default 10). */
  max?: number;
  /** How long a caller waits for a free connection before DB_POOL_EXHAUSTED (default 5000 ms). */
  connectionTimeoutMillis?: number;
  /** Server-side statement timeout (default 5000 ms). */
  statementTimeoutMs?: number;
  /** Server-side idle-in-transaction timeout (default 10000 ms). */
  idleInTransactionTimeoutMs?: number;
  /** application_name shown in pg_stat_activity (default "vsp-platform"). */
  applicationName?: string;
}

/** Point-in-time pool usage (operations; content free). */
export interface PgPoolStats {
  total: number;
  idle: number;
  waiting: number;
  max: number;
}

const APP_NAME = /^[a-z][a-z0-9._-]{1,62}$/;

/**
 * A failure to obtain a connection, mapped to a reason code. The driver message (it can carry host
 * names and, for some errors, parameters) is dropped. A pool that cannot hand out a connection in
 * time is DB_POOL_EXHAUSTED; a server that refuses or cannot be reached is DB_UNAVAILABLE. Both are
 * NOT_STARTED: nothing ran on the server.
 */
export function connectionFailure(err: unknown): DependencyError {
  if (err instanceof DependencyError) return err;
  const message = err instanceof Error ? err.message : "";
  if (/timeout exceeded when trying to connect/i.test(message)) return new DependencyError("DB_POOL_EXHAUSTED", "NOT_STARTED");
  const state = sqlState(err);
  if (state === "53300") return new DependencyError("DB_TOO_MANY_CONNECTIONS", "NOT_STARTED");
  return new DependencyError("DB_UNAVAILABLE", "NOT_STARTED");
}

/**
 * Aurora PostgreSQL / PostgreSQL connection pool adapter.
 *
 *  - `tx` checks out one connection, runs BEGIN, applies role / isolation / RLS context, runs the
 *    body and commits; any failure rolls back. With `retry` the whole transaction runs again after a
 *    serialization failure (40001) or deadlock (40P01), bounded (types.ts TxRetryPolicy).
 *  - Pool exhaustion surfaces as DependencyError DB_POOL_EXHAUSTED after `connectionTimeoutMillis`
 *    instead of an unbounded wait; an unreachable server as DB_UNAVAILABLE.
 *  - `close` waits for checked-out connections to be released (graceful drain) and then ends the pool.
 *
 * Layer-2 evidence: platform/test/integration/substrate/pg-pool.test.ts (postgres:16).
 */
export class PgPoolDb implements Db {
  readonly engine = "pg" as const;
  private readonly maxConnections: number;

  constructor(
    private readonly pool: pg.Pool,
    max?: number,
  ) {
    this.maxConnections = max ?? 10;
    // An idle client that errors (server restart, network drop) must not crash the process; the next
    // checkout gets a fresh connection or a reason-coded failure.
    pool.on("error", () => undefined);
  }

  static fromConnectionString(connectionString: string, max = 10, opts: Omit<PgPoolOptions, "max"> = {}): PgPoolDb {
    const applicationName = opts.applicationName ?? "vsp-platform";
    if (!APP_NAME.test(applicationName)) throw new DependencyError("DB_APPLICATION_NAME_INVALID", "NOT_STARTED", false);
    return new PgPoolDb(
      new pg.Pool({
        connectionString,
        max,
        connectionTimeoutMillis: opts.connectionTimeoutMillis ?? 5_000,
        statement_timeout: opts.statementTimeoutMs ?? 5_000,
        idle_in_transaction_session_timeout: opts.idleInTransactionTimeoutMs ?? 10_000,
        application_name: applicationName,
      }),
      max,
    );
  }

  stats(): PgPoolStats {
    return { total: this.pool.totalCount, idle: this.pool.idleCount, waiting: this.pool.waitingCount, max: this.maxConnections };
  }

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const client = await this.connect();
    try {
      const r = await client.query(sql, params);
      return { rows: r.rows as T[], rowCount: r.rowCount ?? 0 };
    } finally {
      client.release();
    }
  }

  async exec(sql: string): Promise<void> {
    const client = await this.connect();
    try {
      await client.query(sql);
    } finally {
      client.release();
    }
  }

  async tx<T>(fn: (tx: Queryable) => Promise<T>, opts?: TxOptions): Promise<T> {
    return withTxRetry(opts?.retry, () => this.runTx(fn, opts));
  }

  private async connect(): Promise<pg.PoolClient> {
    try {
      return await this.pool.connect();
    } catch (err) {
      throw connectionFailure(err);
    }
  }

  private async runTx<T>(fn: (tx: Queryable) => Promise<T>, opts?: TxOptions): Promise<T> {
    const client = await this.connect();
    let broken = false;
    try {
      await client.query("begin");
      const q: Queryable = {
        async query<R = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<QueryResult<R>> {
          const r = await client.query(sql, params);
          return { rows: r.rows as R[], rowCount: r.rowCount ?? 0 };
        },
        async exec(sql: string): Promise<void> {
          await client.query(sql);
        },
      };
      await applyTxOptions(q, opts);
      const result = await fn(q);
      await client.query("commit");
      return result;
    } catch (err) {
      await client.query("rollback").catch(() => {
        broken = true;
      });
      throw err;
    } finally {
      // A connection whose rollback failed is in an unknown state: destroy it instead of reusing it.
      client.release(broken);
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
