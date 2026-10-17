/** Internal helpers for the audit module (not exported from index.ts). */
import { AuditUnavailableError, PlatformError } from "../shared/errors.js";

/** Converts a PostgreSQL int8/numeric value (bigint, string or number) to a safe JS integer. */
export function toSafeInt(value: unknown): number {
  const n = typeof value === "bigint" ? Number(value) : typeof value === "string" ? Number(value) : (value as number);
  if (typeof n !== "number" || !Number.isSafeInteger(n)) throw new PlatformError("AUDIT_ROW_INVALID");
  return n;
}

export function toDateOrNull(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  if (typeof value === "string") {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) throw new PlatformError("AUDIT_ROW_INVALID");
    return d;
  }
  throw new PlatformError("AUDIT_ROW_INVALID");
}

/** SQLSTATE of a driver error, when present. Never inspects or forwards the message. */
export function sqlStateOf(err: unknown): string | null {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return null;
}

/**
 * Maps any storage failure to AuditUnavailableError with a reason code. The
 * driver error (which can contain SQL text and bound parameters) is dropped so
 * that event content never reaches logs or error channels.
 */
export function toAuditUnavailable(err: unknown): AuditUnavailableError {
  if (err instanceof AuditUnavailableError) return err;
  const state = sqlStateOf(err);
  if (state === "40001" || state === "40P01" || state === "55P03") return new AuditUnavailableError("AUDIT_CHAIN_CONTENTION");
  return new AuditUnavailableError("AUDIT_STORE_UNWRITABLE");
}
