import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { applyTxOptions, withTxRetry } from "./apply-tx-options.js";
import type { Db, Queryable, QueryResult, TxOptions } from "./types.js";

/**
 * Embedded PostgreSQL (WASM) for offline development and tests. LOCAL ONLY:
 * the production configuration guard rejects this engine. Single connection: results on it never
 * evidence multi-connection concurrency (ADR-0018 decision 7.2).
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
    return withTxRetry(opts?.retry, () =>
      this.pg.transaction(async (t) => {
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
      }),
    );
  }

  /**
   * LOCAL / TEST ONLY: a point-in-time copy of this embedded database whose session runs as `username`
   * (an existing LOGIN role), the way a component with its own database login connects. PGlite has one
   * embedded session and cannot switch its session user back (SET SESSION AUTHORIZATION is irreversible
   * on PGlite 0.3), so a separate login is a separate instance loaded from a dump of this one; writes to
   * either are not seen by the other.
   */
  async openCopyAs(username: string): Promise<PgliteDb> {
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(username)) throw new Error("invalid login name");
    const dump = await this.pg.dumpDataDir("none");
    const pg = await PGlite.create({ loadDataDir: dump, username, extensions: { vector } });
    return new PgliteDb(pg);
  }

  async close(): Promise<void> {
    await this.pg.close();
  }
}
