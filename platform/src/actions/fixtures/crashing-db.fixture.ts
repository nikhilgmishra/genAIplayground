/**
 * LOCAL TEST FIXTURE — Db wrapper that simulates process death. After `crash()`, every call
 * (including statements inside an already-open transaction) fails, so nothing more is
 * persisted, exactly as if the process died. `restart()` models a new process on the same
 * database. Never used outside tests.
 */
import type { Db, Queryable, QueryResult, TxOptions } from "../../db/types.js";
import { SimulatedCrashFixtureError } from "./fake-provider.fixture.js";

export class CrashingDbFixture implements Db {
  readonly engine: Db["engine"];
  crashed = false;

  constructor(private readonly inner: Db) {
    this.engine = inner.engine;
  }

  crash(): void {
    this.crashed = true;
  }

  restart(): void {
    this.crashed = false;
  }

  private check(): void {
    if (this.crashed) throw new SimulatedCrashFixtureError();
  }

  async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
    this.check();
    return this.inner.query<T>(sql, params);
  }

  async exec(sql: string): Promise<void> {
    this.check();
    return this.inner.exec(sql);
  }

  async tx<T>(fn: (tx: Queryable) => Promise<T>, opts?: TxOptions): Promise<T> {
    this.check();
    return this.inner.tx(async (tx) => {
      const wrapped: Queryable = {
        query: async <R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<R>> => {
          this.check();
          return tx.query<R>(sql, params);
        },
        exec: async (sql: string): Promise<void> => {
          this.check();
          return tx.exec(sql);
        },
      };
      const result = await fn(wrapped);
      this.check();
      return result;
    }, opts);
  }

  async close(): Promise<void> {
    return this.inner.close();
  }
}
