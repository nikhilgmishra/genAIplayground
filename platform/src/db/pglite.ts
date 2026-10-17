import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { applyTxOptions } from "./apply-tx-options.js";
import type { Db, Queryable, QueryResult, TxOptions } from "./types.js";

/**
 * Embedded PostgreSQL (WASM) for offline development and tests. LOCAL ONLY:
 * the production configuration guard rejects this engine.
 */
export class PgliteDb implements Db {
  readonly engine = "pglite" as const;
  private constructor(private readonly pg: PGlite) {}

  static async create(dataDir?: string): Promise<PgliteDb> {
    const pg = await PGlite.create(dataDir ? { dataDir, extensions: { vector } } : { extensions: { vector } });
    return new PgliteDb(pg);
  }

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const r = await this.pg.query<T>(sql, params);
    return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
  }

  async exec(sql: string): Promise<void> {
    await this.pg.exec(sql);
  }

  async tx<T>(fn: (tx: Queryable) => Promise<T>, opts?: TxOptions): Promise<T> {
    return this.pg.transaction(async (t) => {
      const q: Queryable = {
        async query<R = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<QueryResult<R>> {
          const r = await t.query<R>(sql, params);
          return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
        },
        async exec(sql: string): Promise<void> {
          await t.exec(sql);
        },
      };
      await applyTxOptions(q, opts);
      return fn(q);
    });
  }

  async close(): Promise<void> {
    await this.pg.close();
  }
}
