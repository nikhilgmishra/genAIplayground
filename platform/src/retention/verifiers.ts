/**
 * Derived-copy verifiers (spec section 6: "deletion verification for derived
 * copies, indexes, caches and backups").
 */
import { quoteIdent } from "./registry.js";
import type { CopyLocation, DerivedCopyVerifier, VerifierResult } from "./ports.js";

/**
 * Checks a derived PostgreSQL table/index (e.g. a search index or a summary
 * table keyed by the source record) for rows that still reference deleted keys.
 * Runs as app_worker with tenant RLS, so the derived table must grant SELECT to
 * app_worker under a tenant policy.
 */
export function derivedTableVerifier(opts: { name: string; table: string; tenantColumn: string; sourceKeyColumn: string; location?: "DERIVED_TABLE" | "INDEX" }): DerivedCopyVerifier {
  const table = quoteIdent(opts.table);
  const tenant = quoteIdent(opts.tenantColumn);
  const key = quoteIdent(opts.sourceKeyColumn);
  return {
    name: opts.name,
    kind: "live",
    location: opts.location ?? "DERIVED_TABLE",
    async verify({ tenantId, deletedKeys, db }): Promise<VerifierResult> {
      if (deletedKeys.length === 0) return { status: "VERIFIED_ABSENT" };
      const rows = await db.tx(
        async (tx) => (await tx.query<{ k: string }>(`select distinct ${key}::text as k from ${table} where ${tenant} = $1 and ${key}::text = any ($2::text[])`, [tenantId, [...deletedKeys]])).rows,
        { role: "app_worker", rls: { tenantId } },
      );
      return rows.length === 0 ? { status: "VERIFIED_ABSENT" } : { status: "LEFTOVERS_FOUND", leftoverKeys: rows.map((r) => r.k).sort() };
    },
  };
}

/** Anything exposing `has(key)` (in-process caches). */
export interface KeyedCache {
  has(key: string): boolean;
}

/** Verifier over an in-process cache. LOCAL FIXTURE unless a live cache adapter is supplied. */
export function cacheVerifier(name: string, cache: KeyedCache, kind: "local_fixture" | "live" = "local_fixture"): DerivedCopyVerifier {
  return {
    name,
    kind,
    location: "CACHE",
    async verify({ deletedKeys }): Promise<VerifierResult> {
      const left = deletedKeys.filter((k) => cache.has(k));
      return left.length === 0 ? { status: "VERIFIED_ABSENT" } : { status: "LEFTOVERS_FOUND", leftoverKeys: [...left].sort() };
    },
  };
}

/**
 * A copy location that cannot be verified from this service (e.g. Aurora
 * snapshots and S3 versions age out under backup retention; vendor copies need a
 * vendor deletion API that is BLOCKED). Always reported UNVERIFIABLE, never as
 * deleted (OPS-03).
 */
export function unverifiableCopy(name: string, location: CopyLocation, reasonCode: string): DerivedCopyVerifier {
  return {
    name,
    kind: "live",
    location,
    async verify(): Promise<VerifierResult> {
      return { status: "UNVERIFIABLE", reasonCode };
    },
  };
}
