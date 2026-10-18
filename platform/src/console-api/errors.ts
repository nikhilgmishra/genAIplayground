/**
 * Console API errors. Every non-2xx response is a ConsoleErrorBody carrying a
 * reason code, the request correlation id and a retryable flag only: no stack
 * traces, SQL, record contents, caller-supplied values or free text.
 */
import { AccessDeniedError, AuditUnavailableError, ConflictError, DependencyError, PlatformError, SessionInvalidError, ValidationError } from "../shared/errors.js";
import type { ConsoleErrorBody } from "./contract.js";

const REASON = /^[A-Z][A-Z0-9_]{2,63}$/;

export class ConsoleHttpError extends PlatformError {
  constructor(
    readonly status: number,
    reasonCode: string,
    retryable = false,
  ) {
    super(REASON.test(reasonCode) ? reasonCode : "INTERNAL_ERROR", REASON.test(reasonCode) ? reasonCode : "INTERNAL_ERROR", retryable);
  }
}

export const badRequest = (reasonCode = "VALIDATION_FAILED"): ConsoleHttpError => new ConsoleHttpError(400, reasonCode);
export const unauthenticated = (reasonCode = "UNAUTHENTICATED"): ConsoleHttpError => new ConsoleHttpError(401, reasonCode);
export const forbidden = (reasonCode = "STAFF_ROLE_NOT_PERMITTED"): ConsoleHttpError => new ConsoleHttpError(403, reasonCode);
export const notFound = (reasonCode = "NOT_FOUND"): ConsoleHttpError => new ConsoleHttpError(404, reasonCode);
export const conflict = (reasonCode = "STATE_CONFLICT", retryable = false): ConsoleHttpError => new ConsoleHttpError(409, reasonCode, retryable);
export const unavailable = (reasonCode: string, retryable = true): ConsoleHttpError => new ConsoleHttpError(503, reasonCode, retryable);

/** Reason codes from other modules that mean "not found" (never distinguished from "not yours"). */
const NOT_FOUND_CODES = new Set(["ACTION_NOT_FOUND", "TASK_NOT_FOUND", "WORKFLOW_NOT_FOUND", "NOT_FOUND"]);

/** Maps any thrown value to an HTTP status and safe reason code. Unknown errors become 500 INTERNAL_ERROR. */
export function toHttpError(err: unknown): ConsoleHttpError {
  if (err instanceof ConsoleHttpError) return err;
  if (err instanceof AuditUnavailableError) return new ConsoleHttpError(503, "AUDIT_UNAVAILABLE", true);
  if (err instanceof PlatformError) {
    const code = REASON.test(err.reasonCode) ? err.reasonCode : "INTERNAL_ERROR";
    if (NOT_FOUND_CODES.has(code)) return new ConsoleHttpError(404, "NOT_FOUND");
    // A downstream module produced audit input the writer refused: a server defect, never the operator's input.
    if (code === "AUDIT_EVENT_INVALID") return new ConsoleHttpError(500, "AUDIT_EVENT_REJECTED");
    if (err instanceof SessionInvalidError) return new ConsoleHttpError(401, code);
    if (err instanceof AccessDeniedError) return new ConsoleHttpError(403, code);
    if (err instanceof ValidationError) return new ConsoleHttpError(400, code);
    if (err instanceof ConflictError) return new ConsoleHttpError(409, code, err.retryable);
    if (err instanceof DependencyError) return new ConsoleHttpError(503, code, err.retryable);
    return new ConsoleHttpError(500, "INTERNAL_ERROR");
  }
  return new ConsoleHttpError(500, "INTERNAL_ERROR");
}

export function errorBody(err: ConsoleHttpError, correlationId: string | null): ConsoleErrorBody {
  return { error: { reasonCode: err.reasonCode, correlationId, retryable: err.retryable } };
}
