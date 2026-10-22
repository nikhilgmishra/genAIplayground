/**
 * Change requests over a domain connector (WP-23; FO-06-75; ACT-02, ACT-03).
 *
 * Every keyed write is sent with a request id derived deterministically from the ledger's stable provider
 * idempotency key, so a retry, a redelivery or a second process after a crash sends the SAME id and the system of
 * record applies the change at most once. The derivation is one-way and URL-safe (an opaque token: no key material
 * and no digit run reaches a URL).
 *
 * Reconciliation by key (`decideLookup`) follows the system's documented semantics:
 *   COMPLETED               the change exists: COMMITTED with its receipt;
 *   INCOMPLETE              step 1 applied, step 2 (receipt) missing (PARTIAL_WRITE): with COMPLETE_BY_REQUEST_ID
 *                           the change is completed by its request id (step 2 only; the system never applies the
 *                           change again) and then COMMITTED; with ROUTE_TO_HUMAN it stays UNKNOWN;
 *   REJECTED                the system refused the request: no effect (NOT_FOUND for the ledger); a FENCED one
 *                           (failure code FENCED) can never apply under any body: NOT_FOUND, REQUEST_FENCED;
 *   absent (404 / no item)  NEVER definitive by itself, whatever time has passed: the write's COMMIT can land after
 *                           its deadline (a stalled process, a slow fsync, a replication wait). Once the request's
 *                           dispatch deadline has passed (plus the clock-skew allowance, so the system's own clock
 *                           agrees), the binding's FENCE (`fenceOperationId`) asks the system itself: it returns
 *                           the change stored under the id (no lookup lag; a delivery still inside its
 *                           transaction is waited for) or records the id FENCED, so nothing can ever apply under
 *                           it. Only that FENCED answer is NOT_FOUND; without a fence, before the deadline, or when
 *                           the fence cannot answer, it is UNKNOWN (never "failed").
 * A change found under the request id is claimed for an action only when it is THAT action's request: its request
 * digest equals the digest of the body the action sends (binding `requestDigest`), and its resource is the confirmed
 * one (`PayloadExpectation`). Anything else is UNKNOWN (PAYLOAD_MISMATCH): never another payload's effect.
 */
import { createHash } from "node:crypto";
import type { OperationResult } from "../connectors/runtime/connector.js";
import { ConnectorError } from "../connectors/runtime/errors.js";
import { canonicalJson } from "../shared/canonical.js";
import { ValidationError } from "../shared/errors.js";
import type { SourceRef } from "./contracts.js";
import type { DomainConnector } from "./runner.js";
import { int, optStr, single, str } from "./runner.js";

const KEY = /^[A-Za-z0-9_.:-]{8,128}$/;

/** URL-safe opaque request id of a provider idempotency key (stable across processes and retries). */
export function requestIdFor(providerIdempotencyKey: string): string {
  if (!KEY.test(providerIdempotencyKey)) throw new ValidationError("PROVIDER_IDEMPOTENCY_KEY_INVALID");
  return `idk_${createHash("sha256").update(`vsp.domain.request-id.v1\n${providerIdempotencyKey}`).digest("base64url").slice(0, 32)}`;
}

export interface ChangeState {
  readonly requestId: string;
  readonly operation: string;
  readonly state: "COMPLETED" | "INCOMPLETE" | "REJECTED";
  readonly receiptId: string | null;
  readonly resourceType: string | null;
  readonly resourceId: string | null;
  readonly resourceVersion: string | null;
  readonly resourceStartsAt: string | null;
  readonly resourceTimeZone: string | null;
  /** Slot and subject of the changed resource as the system recorded them with the change. */
  readonly resourceSlotId: string | null;
  readonly resourceSubjectId: string | null;
  /** The system's stored digest of the request (binding `requestDigest` scheme), or null. */
  readonly requestDigest: string | null;
  readonly failureCode: string | null;
  readonly source: SourceRef;
}

export interface Receipt {
  readonly receiptId: string;
  readonly requestId: string;
  readonly operation: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly resourceVersion: string;
  readonly stateDigest: string;
  readonly requestDigest: string | null;
  readonly committedAt: string;
  readonly source: SourceRef;
}

/** Request digest schemes a binding may declare (the system documents the algorithm in its API description). */
export type RequestDigestScheme = "REFBIZ_REQUEST_V1";

/**
 * The digest a system stores for a request under `scheme`. REFBIZ_REQUEST_V1 (reference business API OpenAPI):
 * SHA-256 hex of `refbiz.request.v1`, LF, the operation, LF, the canonical JSON of the body (sorted keys, no
 * whitespace). `body` must be the wire body (the template renders the typed values unchanged).
 */
export function requestDigestOf(scheme: RequestDigestScheme, operation: string, body: Record<string, unknown>): string {
  switch (scheme) {
    case "REFBIZ_REQUEST_V1":
      return createHash("sha256").update(`refbiz.request.v1\n${operation}\n${canonicalJson(body)}`).digest("hex");
  }
}

const STATES = new Set(["COMPLETED", "INCOMPLETE", "REJECTED"]);

export function changeStateOf(conn: DomainConnector, result: OperationResult): ChangeState {
  const r = single(result);
  const state = str(r, "state");
  if (!STATES.has(state)) throw new ValidationError("DOMAIN_RECORD_INVALID");
  return {
    requestId: str(r, "requestId"),
    operation: str(r, "operation"),
    state: state as ChangeState["state"],
    receiptId: optStr(r, "receiptId"),
    resourceType: optStr(r, "resourceType"),
    resourceId: optStr(r, "resourceId"),
    resourceVersion: optStr(r, "resourceVersion"),
    resourceStartsAt: optStr(r, "resourceStartsAt"),
    resourceTimeZone: optStr(r, "resourceTimeZone"),
    resourceSlotId: optStr(r, "resourceSlotId"),
    resourceSubjectId: optStr(r, "resourceSubjectId"),
    requestDigest: optStr(r, "requestDigest"),
    failureCode: optStr(r, "failureCode"),
    source: conn.source(result),
  };
}

/** Keyed writes, lookup, completion and receipts of one domain connector. */
export class ChangeRequests {
  constructor(readonly conn: DomainConnector) {}

  /** Sends one keyed write; `body` comes from the confirmed action only. */
  async submit(canonical: string, requestId: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<ChangeState> {
    const result = await this.conn.run(canonical, { params: { requestId }, body, idempotencyKey: requestId, signal });
    const s = changeStateOf(this.conn, result);
    if (s.requestId !== requestId) throw new ValidationError("DOMAIN_RECEIPT_REQUEST_MISMATCH");
    return s;
  }

  /** Lookup by request id through the write's declared reconciliation operation; null when absent or not yet visible. */
  async lookup(writeCanonical: string, requestId: string, signal?: AbortSignal): Promise<ChangeState | null> {
    const { found, result } = await this.conn.runner.reconcile(this.conn.operationId(writeCanonical), { params: { requestId }, signal });
    if (!found || result === null) return null;
    const s = changeStateOf(this.conn, result);
    if (s.requestId !== requestId) throw new ValidationError("DOMAIN_LOOKUP_REQUEST_MISMATCH");
    return s;
  }

  /**
   * The fence of a request id (binding `fenceOperationId`), sent once the request's dispatch deadline `notAfter` has
   * passed: the change stored under the id, or the id FENCED (REJECTED, failure FENCED). Null when the system
   * refuses because its own clock has not passed the deadline yet (409: nothing changed, ask later).
   */
  async fence(requestId: string, operation: string, notAfter: string, signal?: AbortSignal): Promise<ChangeState | null> {
    let result: OperationResult;
    try {
      result = await this.conn.run("fenceChange", { params: { requestId }, body: { operation, notAfter }, idempotencyKey: requestId, signal });
    } catch (e) {
      if (e instanceof ConnectorError && e.outcome === "FAILED" && e.reasonCode === "CONNECTOR_CONFLICT") return null;
      throw e;
    }
    const s = changeStateOf(this.conn, result);
    if (s.requestId !== requestId) throw new ValidationError("DOMAIN_FENCE_REQUEST_MISMATCH");
    return s;
  }

  /** Completes an INCOMPLETE change by its request id (step 2 only). */
  async complete(requestId: string, signal?: AbortSignal): Promise<ChangeState> {
    const result = await this.conn.run("completeChange", { params: { requestId }, idempotencyKey: requestId, signal });
    const s = changeStateOf(this.conn, result);
    if (s.requestId !== requestId) throw new ValidationError("DOMAIN_RECEIPT_REQUEST_MISMATCH");
    return s;
  }

  async receipt(receiptId: string, signal?: AbortSignal): Promise<Receipt> {
    const result = await this.conn.run("getReceipt", { params: { receiptId }, signal });
    const r = single(result);
    return {
      receiptId: str(r, "receiptId"),
      requestId: str(r, "requestId"),
      operation: str(r, "operation"),
      resourceType: str(r, "resourceType"),
      resourceId: str(r, "resourceId"),
      resourceVersion: str(r, "resourceVersion"),
      stateDigest: str(r, "stateDigest"),
      requestDigest: optStr(r, "requestDigest"),
      committedAt: str(r, "committedAt"),
      source: this.conn.source(result),
    };
  }

  /** The system's documented consistency guarantees as it reports them (capability test: they must cover the binding's). */
  async reportedConsistency(signal?: AbortSignal): Promise<{ visibilityWindowMs: number; dispatchDeadline: string | null; requestDigestScheme: string | null; absenceProof: string | null }> {
    const r = single(await this.conn.run("consistency", { signal }));
    return { visibilityWindowMs: int(r, "visibilityWindowMs"), dispatchDeadline: optStr(r, "dispatchDeadline"), requestDigestScheme: optStr(r, "requestDigestScheme"), absenceProof: optStr(r, "absenceProof") };
  }
}

// ------------------------------------------------------------------ reconciliation decision

export type LookupDecision =
  | { readonly outcome: "COMMITTED"; readonly change: ChangeState }
  | { readonly outcome: "NOT_FOUND"; readonly reasonCode: "REQUEST_REJECTED" | "REQUEST_FENCED" }
  | {
      readonly outcome: "UNKNOWN";
      readonly reasonCode:
        | "NOT_VISIBLE_WITHIN_WINDOW"
        | "ABSENCE_NOT_PROVABLE"
        | "FENCE_NOT_DUE"
        | "INCOMPLETE_WRITE_ROUTED_TO_HUMAN"
        | "INCOMPLETE_WRITE_NOT_COMPLETED"
        | "LOOKUP_OPERATION_MISMATCH"
        | "PAYLOAD_MISMATCH";
    };

/** The failure code a system gives a fenced request id / reference: nothing can ever apply under it. */
export const FENCED = "FENCED";

/** A change the system FENCED: no delivery of the id can ever be applied (whatever body it carries). */
export const isFenced = (c: Pick<ChangeState, "state" | "failureCode">): boolean => c.state === "REJECTED" && c.failureCode === FENCED;

/**
 * When the fence may be asked: once the request's dispatch deadline plus the clock-skew allowance has passed on the
 * platform's clock (the system checks its own clock again and refuses an early fence: liveness only, never the
 * proof; the proof is the system's FENCED answer).
 */
export function fenceDue(deadlineMs: number, clockSkewAllowanceMs: number, nowMs: number): boolean {
  return nowMs > deadlineMs + clockSkewAllowanceMs;
}

/**
 * Classifies a lookup (or fence) answer (no I/O): the fence and the completion of INCOMPLETE writes are done by
 * the caller before this. `absentReason` is the UNKNOWN reason of an absent change (no fence answer): an absence is
 * never NOT_FOUND here; only the system's FENCED or REJECTED answer is.
 */
export function decideLookup(
  found: ChangeState | null,
  incompleteWrite: "COMPLETE_BY_REQUEST_ID" | "ROUTE_TO_HUMAN",
  absentReason: "NOT_VISIBLE_WITHIN_WINDOW" | "ABSENCE_NOT_PROVABLE" | "FENCE_NOT_DUE" = "ABSENCE_NOT_PROVABLE",
): LookupDecision {
  if (found === null) return { outcome: "UNKNOWN", reasonCode: absentReason };
  if (isFenced(found)) return { outcome: "NOT_FOUND", reasonCode: "REQUEST_FENCED" };
  if (found.state === "REJECTED") return { outcome: "NOT_FOUND", reasonCode: "REQUEST_REJECTED" };
  if (found.state === "INCOMPLETE") return { outcome: "UNKNOWN", reasonCode: incompleteWrite === "ROUTE_TO_HUMAN" ? "INCOMPLETE_WRITE_ROUTED_TO_HUMAN" : "INCOMPLETE_WRITE_NOT_COMPLETED" };
  if (found.receiptId === null) return { outcome: "UNKNOWN", reasonCode: "INCOMPLETE_WRITE_NOT_COMPLETED" };
  return { outcome: "COMMITTED", change: found };
}

// ------------------------------------------------------------------ payload binding of a found change

/** What a change found under an action's request id must show to be that action's change. */
export interface PayloadExpectation {
  /** The system's request digest of the body the action sends; null when it cannot be known (see commit.ts). */
  readonly requestDigest: string | null;
  readonly resourceId?: string;
  readonly resourceSlotId?: string;
  readonly resourceSubjectId?: string;
  readonly resourceStartsAt?: string;
}

/**
 * True when `found` is the expected request's change. A declared digest scheme makes the digest mandatory (a
 * system that promised digests and sends none is not trusted); every expected resource field must match exactly.
 * A REJECTED change carries no resource: only its digest is compared.
 */
export function payloadMatches(found: ChangeState, expected: PayloadExpectation, scheme: RequestDigestScheme | null): boolean {
  if (scheme !== null && expected.requestDigest !== null && found.requestDigest !== expected.requestDigest) return false;
  if (found.state === "REJECTED") return true;
  if (expected.resourceId !== undefined && found.resourceId !== expected.resourceId) return false;
  if (expected.resourceSlotId !== undefined && found.resourceSlotId !== expected.resourceSlotId) return false;
  if (expected.resourceSubjectId !== undefined && found.resourceSubjectId !== expected.resourceSubjectId) return false;
  if (expected.resourceStartsAt !== undefined && (found.resourceStartsAt === null || Date.parse(found.resourceStartsAt) !== Date.parse(expected.resourceStartsAt))) return false;
  return true;
}
