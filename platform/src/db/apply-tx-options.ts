import { DependencyError, ValidationError } from "../shared/errors.js";
import type { Queryable, TxOptions, TxRetryPolicy } from "./types.js";

const ROLE_RE = /^(app_runtime|app_worker|app_console|app_auditor|app_audit_verifier)$/;

export async function applyTxOptions(tx: Queryable, opts: TxOptions | undefined): Promise<void> {
  const role = opts?.role ?? "app_runtime";
  if (opts?.isolation) {
    await tx.query(`set transaction isolation level ${opts.isolation}`);
  }
  if (role !== "owner") {
    if (!ROLE_RE.test(role)) throw new Error("invalid db role");
    await tx.query(`set local role ${role}`);
  }
  const rls = opts?.rls;
  await tx.query(
    `select set_config('app.tenant_id', $1, true), set_config('app.organization_id', $2, true),
            set_config('app.subject_id', $3, true), set_config('app.actor_id', $4, true)`,
    [rls?.tenantId ?? "", rls?.organizationId ?? "", rls?.subjectId ?? "", rls?.actorId ?? ""],
  );
}

/** SQLSTATE of a driver error, when present (never the message: it can carry SQL text and parameters). */
export function sqlState(err: unknown): string | null {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return null;
}

/** Serialization failure or detected deadlock: the transaction was rolled back and may run again. */
export const isRetryableTxFailure = (err: unknown): boolean => {
  const s = sqlState(err);
  return s === "40001" || s === "40P01";
};

export function validateRetryPolicy(p: TxRetryPolicy | undefined): Required<TxRetryPolicy> | null {
  if (!p) return null;
  const base = p.baseDelayMs ?? 10;
  if (!Number.isSafeInteger(p.maxAttempts) || p.maxAttempts < 2 || p.maxAttempts > 10 || !Number.isSafeInteger(base) || base < 0 || base > 1000) {
    throw new ValidationError("DB_TX_RETRY_POLICY_INVALID");
  }
  return { maxAttempts: p.maxAttempts, baseDelayMs: base };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Runs `attempt` and, when a retry policy is given, runs it again after a serialization failure or a
 * deadlock (bounded, "equal jitter" backoff). The last failure is re-thrown as a reason-coded
 * DependencyError (DB_TX_SERIALIZATION_EXHAUSTED, outcome FAILED: every attempt rolled back).
 */
export async function withTxRetry<T>(policy: TxRetryPolicy | undefined, attempt: (n: number) => Promise<T>, random: () => number = Math.random): Promise<T> {
  const p = validateRetryPolicy(policy);
  if (!p) return attempt(1);
  for (let n = 1; ; n++) {
    try {
      return await attempt(n);
    } catch (err) {
      if (!isRetryableTxFailure(err)) throw err;
      if (n >= p.maxAttempts) throw new DependencyError("DB_TX_SERIALIZATION_EXHAUSTED", "FAILED", true);
      const window = p.baseDelayMs * 2 ** (n - 1);
      await sleep(Math.floor(window / 2 + Math.min(Math.max(random(), 0), 0.999999) * (window / 2)));
    }
  }
}
