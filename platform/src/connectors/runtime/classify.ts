/**
 * Response and transport classification of the connector runtime (WP-06; FO-06-08; ACT-03).
 *
 *   status                  read                               write (side effect)
 *   success status          success                            success
 *   400 / 422               FAILED  CONNECTOR_REQUEST_REJECTED  FAILED (not applied)
 *   403                     FAILED  CONNECTOR_FORBIDDEN         FAILED
 *   404                     FAILED  CONNECTOR_NOT_FOUND         FAILED
 *   409                     FAILED  CONNECTOR_CONFLICT          FAILED
 *   cursorExpiredStatus     FAILED  CURSOR_EXPIRED              -
 *   429                     NOT_STARTED retryable, Retry-After honoured (rejected before processing)
 *   503                     NOT_STARTED retryable               NOT_STARTED retryable for a write a retry
 *                                                               cannot apply twice (idempotency key, external
 *                                                               id upsert, naturally idempotent); UNKNOWN for
 *                                                               NOT_IDEMPOTENT_RECONCILE_REQUIRED (an
 *                                                               intermediary may answer 503 after the origin
 *                                                               applied it: reconcile first, ACT-03)
 *   other 5xx               FAILED retryable                    UNKNOWN (may have been applied)
 *   anything else           FAILED                              UNKNOWN
 * Transport failures keep the transport's phase classification (nothing sent: NOT_STARTED; sent:
 * UNKNOWN for a write, FAILED retryable for a read). An UNKNOWN is never retried by the runtime; it is
 * reconciled through the operation's reconcile lookup first.
 */
import type { ConnectorOperation } from "../../protocol/connector.js";
import { parseRetryAfter } from "../../resilience/rate-limiter.js";
import { TransportError } from "../http/transport.js";
import type { TransportResponse } from "../http/transport.js";
import { ConnectorError } from "./errors.js";

export const defaultSuccessStatuses = (op: ConnectorOperation): readonly number[] => op.successStatuses ?? (op.kind === "WRITE" ? [200, 201, 204] : [200]);

/** Throws the classified error for a non-success response; returns normally for a success status. */
export function classifyResponse(integrationId: string, op: ConnectorOperation, res: TransportResponse, now: Date): void {
  if (defaultSuccessStatuses(op).includes(res.status)) return;
  const write = op.kind === "WRITE";
  const e = (reason: string, outcome: "NOT_STARTED" | "FAILED" | "UNKNOWN", retryable = false, retryAfterMs: number | null = null) =>
    new ConnectorError(reason, outcome, integrationId, op.operationId, { httpStatus: res.status, retryable, retryAfterMs });
  if (op.pagination?.cursorExpiredStatus !== undefined && op.pagination.cursorExpiredStatus !== null && res.status === op.pagination.cursorExpiredStatus) throw e("CURSOR_EXPIRED", "FAILED");
  switch (res.status) {
    case 400:
    case 422:
      throw e("CONNECTOR_REQUEST_REJECTED", "FAILED");
    case 401:
      throw e("CONNECTOR_AUTH_FAILED", "FAILED");
    case 403:
      throw e("CONNECTOR_FORBIDDEN", "FAILED");
    case 404:
      throw e("CONNECTOR_NOT_FOUND", "FAILED");
    case 409:
      throw e("CONNECTOR_CONFLICT", "FAILED");
    case 429:
      throw e("HTTP_429", "NOT_STARTED", true, parseRetryAfter(res.headers["retry-after"], now));
    case 503:
      // The Retry-After still pauses the connector; only the retry decision depends on the write's idempotency.
      if (write && op.idempotency === "NOT_IDEMPOTENT_RECONCILE_REQUIRED") throw e("HTTP_503", "UNKNOWN", false, parseRetryAfter(res.headers["retry-after"], now));
      throw e("HTTP_503", "NOT_STARTED", true, parseRetryAfter(res.headers["retry-after"], now));
    default:
      if (res.status >= 500) throw write ? e("CONNECTOR_SERVER_ERROR", "UNKNOWN") : e("CONNECTOR_SERVER_ERROR", "FAILED", true);
      throw write ? e("CONNECTOR_UNEXPECTED_STATUS", "UNKNOWN") : e("CONNECTOR_UNEXPECTED_STATUS", "FAILED");
  }
}

/** Maps a transport failure onto a ConnectorError with the same outcome and reason. */
export function fromTransport(integrationId: string, operation: string, err: TransportError): ConnectorError {
  return new ConnectorError(err.reasonCode, err.outcome, integrationId, operation, { retryable: err.retryable, httpStatus: err.httpStatus });
}

/** Retry hint of a classified error (a vendor Retry-After), or null. */
export function retryAfterOf(err: unknown): number | null {
  return err instanceof ConnectorError && err.retryAfterMs !== null ? err.retryAfterMs : null;
}

/** Errors that count as dependency failures for the circuit breaker (availability, not caller mistakes). */
export function isAvailabilityFailure(err: unknown): boolean {
  if (err instanceof TransportError) return err.phase !== "PRE_IO";
  if (!(err instanceof ConnectorError)) return false;
  if (err.outcome === "UNKNOWN") return true;
  return ["HTTP_429", "HTTP_503", "CONNECTOR_SERVER_ERROR", "CONNECTION_REFUSED", "CONNECTION_LOST", "TIMEOUT_BEFORE_SEND", "TIMEOUT_AFTER_SEND", "READ_TIMEOUT", "CONNECTOR_TOKEN_ENDPOINT_UNAVAILABLE"].includes(err.reasonCode);
}
