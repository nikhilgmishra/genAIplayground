import pg from "pg";
import { applyTxOptions } from "./apply-tx-options.js";
import type { Db, Queryable, QueryResult, TxOptions } from "./types.js";

/** Aurora PostgreSQL / PostgreSQL connection pool adapter. */
export class PgPoolDb implements Db {
  readonly engine = "pg" as const;
  constructor(private readonly pool: pg.Pool) {}

  static fromConnectionString(connectionString: string, max = 10): PgPoolDb {
    return new PgPoolDb(new pg.Pool({ connectionString, max, statement_timeout: 5_000, idle_in_transaction_session_timeout: 10_000 }));
  }

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const r = await this.pool.query(sql, params);
    return { rows: r.rows as T[], rowCount: r.rowCount ?? 0 };
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async tx<T>(fn: (tx: Queryable) => Promise<T>, opts?: TxOptions): Promise<T> {
    const client = await this.pool.connect();
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
      await client.query("rollback").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
