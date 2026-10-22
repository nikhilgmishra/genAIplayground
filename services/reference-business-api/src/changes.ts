/**
 * Change requests: the reference API's write protocol (WP-23; FO-06-74, FO-06-75; ACT-02, ACT-03).
 *
 * Every write is `PUT /api/v1/<operation-resource>/{requestId}` where the request id (`keyRef`) is chosen by the
 * client (the platform derives it from its provider idempotency key). The service keeps one change-request row per
 * (account, requestId):
 *   - first delivery: the row is inserted and the change applied in ONE transaction (step 1, the effect, with a
 *     row lock on every record it touches and the before-version checked); a business refusal is recorded as
 *     REJECTED with its status and code, so a replay gets the same answer;
 *   - step 2 finalizes: a receipt with the resource version and a state digest; the row becomes COMPLETED and
 *     stores the response;
 *   - any later delivery with the same id and the same request replays the stored outcome (no second effect);
 *     the same id with a different request is refused 422 REQUEST_ID_REUSED; a delivery that arrives while the
 *     first is still in its transaction waits on the row and then replays;
 *   - an APPLIED row (step 1 done, step 2 not: PARTIAL_WRITE, or a crash between the steps) is completed by a
 *     replay of the same request or by `POST /change-requests/{requestId}/completion`: step 2 only, never
 *     step 1 again;
 *   - `GET /change-requests/{requestId}` is the lookup by key. It reads an index that lags the store by at
 *     most the account's documented visibility window: until `visible_at` the request is reported 404, exactly
 *     like an unknown id. A client must not treat 404 as definitive before the window has passed;
 *   - a write may carry a dispatch deadline (`notAfter`, deadline.ts): it is applied only if the final check, the
 *     last statement of the step-1 transaction, passes; otherwise it is REJECTED with DEADLINE_EXCEEDED. The
 *     deadline bounds how long a delivery can keep trying (liveness); it does NOT make a 404 definitive: the
 *     transaction's COMMIT can still land after the deadline (commit latency: a stalled process, a slow fsync, a
 *     synchronous-replication wait, a network delay before COMMIT reaches the database);
 *   - `POST /change-requests/{requestId}/fence` (allowed once the request's deadline has passed) is the only proof
 *     of absence: it inserts a FENCED row (REJECTED, failure FENCED) unless a change request exists, waiting for a
 *     delivery still in its transaction (the id's unique index), so it either returns the change that exists or
 *     guarantees that no delivery of the id can ever be applied (every later delivery is refused 409 FENCED);
 *   - every answer about a change request (write response, lookup, receipt) carries the stored `requestDigest`
 *     (SHA-256 of `refbiz.request.v1`, the operation and the canonical JSON body), so a client can tell whether the
 *     change found under its request id is the request it would send (payload binding of reconciliation).
 */
import type { FastifyReply } from "fastify";
import type { Store, Tx } from "./db.js";
import { ApiError } from "./errors.js";
import { boundByDeadline, DEADLINE_EXCEEDED, FENCE_BEFORE_DEADLINE, FENCED, isDeadlineAbort, unbound, withinDeadline } from "./deadline.js";
import type { FaultBoard } from "./faults.js";
import { canonicalJson, digestEquals, newId, requestDigest, sha256Hex } from "./ids.js";

export interface Applied {
  resourceType: string;
  resourceId: string;
  beforeVersion: string | null;
  afterVersion: string;
  /** Representation of the changed resource (already in the account's dialect). */
  resource: Record<string, unknown>;
}

export interface ChangeInput {
  accountId: string;
  operation: string;
  keyRef: string;
  body: Record<string, unknown>;
  /** The record whose writes a barrier may hold (CONCURRENT_SAME_ACCOUNT seam). */
  barrierResourceId: string;
  /** The client's dispatch deadline (`notAfter` of the body), or null: see deadline.ts. */
  notAfter: string | null;
}

interface Row {
  key_ref: string;
  operation: string;
  request_digest: string;
  state: "APPLIED" | "COMPLETED" | "FAILED";
  resource_type: string | null;
  resource_id: string | null;
  before_version: string | null;
  after_version: string | null;
  failure_status: number | null;
  failure_code: string | null;
  receipt_id: string | null;
  response: Record<string, unknown> | null;
  applied_at: Date | null;
  completed_at: Date | null;
  not_after: Date | null;
}

const PUBLIC_STATE = { APPLIED: "INCOMPLETE", COMPLETED: "COMPLETED", FAILED: "REJECTED" } as const;

/** The keyed write operations whose request ids a client may fence (each belongs to its system's write scope). */
export const KEYED_WRITE_OPERATIONS = ["scheduling.booking.put", "scheduling.reschedule.put", "scheduling.cancellation.put", "scheduling.availability_block.put", "billing.review_request.put"] as const;
export type KeyedWriteOperation = (typeof KEYED_WRITE_OPERATIONS)[number];

/**
 * The stored digest of a fence row: domain-separated from every request digest (`refbiz.request.v1`), so a fenced
 * id never matches any request a client would send (and a later delivery is refused 409 FENCED before any digest
 * comparison).
 */
export const fenceDigest = (operation: string): string => sha256Hex(`refbiz.fence.v1\n${operation}`);

const isFenced = (row: Pick<Row, "state" | "failure_code">): boolean => row.state === "FAILED" && row.failure_code === FENCED;

export type WriteOutcome = { status: number; body: Record<string, unknown>; replayed: boolean };

export class ChangeRequests {
  constructor(
    private readonly store: Store,
    private readonly faults: FaultBoard,
  ) {}

  /**
   * Executes one write. `apply` runs inside the step-1 transaction and must lock and check every record it
   * changes; it throws ApiError for a business refusal (recorded as REJECTED). Returns the HTTP outcome;
   * after-commit faults (delay, dropped response) are applied by `respond`.
   */
  async execute(input: ChangeInput, apply: (tx: Tx) => Promise<Applied>, reply: FastifyReply): Promise<void> {
    const { accountId, operation, keyRef } = input;
    const unavailable = this.faults.take(accountId, operation, ["HTTP_STATUS"]);
    if (unavailable) throw new ApiError(unavailable.status, "UNAVAILABLE", unavailable.retryAfterSeconds);
    await this.faults.arrive(accountId, operation, input.barrierResourceId);
    const digest = requestDigest(operation, input.body);

    const first = await this.store.tx(async (tx) => {
      const inserted = await tx.query(
        `insert into refbiz.change_requests (account_id, key_ref, operation, request_digest, state, received_at, visible_at, not_after)
         values ($1, $2, $3, $4, 'APPLIED', now(), now(), $5) on conflict (account_id, key_ref) do nothing returning key_ref`,
        [accountId, keyRef, operation, digest, input.notAfter],
      );
      if (inserted.rowCount === 0) {
        // Another delivery of this id: wait for its transaction (row lock), then replay or complete.
        const prior = (await tx.query<Row>("select * from refbiz.change_requests where account_id = $1 and key_ref = $2 for update", [accountId, keyRef])).rows[0];
        if (!prior) throw new ApiError(503, "REQUEST_IN_PROGRESS", 1);
        // A fenced id refuses every delivery, whatever its body: nothing can ever be applied under it (409 FENCED).
        if (!isFenced(prior) && (prior.operation !== operation || !digestEquals(prior.request_digest, digest))) throw new ApiError(422, "REQUEST_ID_REUSED");
        return { kind: "prior" as const, row: prior };
      }
      const reject = async (e: ApiError) => {
        await tx.query("update refbiz.change_requests set state = 'FAILED', failure_status = $3, failure_code = $4, completed_at = now() where account_id = $1 and key_ref = $2", [accountId, keyRef, e.status, e.code]);
        return { kind: "rejected" as const, error: e };
      };
      await tx.query("savepoint apply_step");
      // Deadline already passed (a late delivery): nothing is applied, the request is recorded REJECTED.
      if (input.notAfter !== null && !(await boundByDeadline(tx, input.notAfter))) {
        await unbound(tx);
        return reject(new ApiError(409, DEADLINE_EXCEEDED));
      }
      try {
        const applied = await apply(tx);
        const lag = await this.lagMs(tx, accountId, null);
        await tx.query(
          `update refbiz.change_requests set resource_type = $3, resource_id = $4, before_version = $5, after_version = $6, applied_at = now(),
             visible_at = now() + make_interval(secs => $7::double precision / 1000), response = $8
           where account_id = $1 and key_ref = $2`,
          [accountId, keyRef, applied.resourceType, applied.resourceId, applied.beforeVersion, applied.afterVersion, lag, JSON.stringify(applied.resource)],
        );
        await tx.query(
          "insert into refbiz.effects (account_id, key_ref, operation, resource_type, resource_id, before_version, after_version) values ($1, $2, $3, $4, $5, $6, $7)",
          [accountId, keyRef, operation, applied.resourceType, applied.resourceId, applied.beforeVersion, applied.afterVersion],
        );
        // The final check: the last statement before COMMIT (deadline.ts).
        if (input.notAfter !== null && !(await withinDeadline(tx, input.notAfter))) throw new ApiError(409, DEADLINE_EXCEEDED);
        // STALL_BEFORE_COMMIT seam: the check passed, the COMMIT is delayed (it may land after the deadline).
        await this.stallBeforeCommit(accountId, operation);
      } catch (e) {
        const deadline = input.notAfter !== null && ((e instanceof ApiError && e.code === DEADLINE_EXCEEDED) || isDeadlineAbort(e));
        if (!deadline && (!(e instanceof ApiError) || e.status >= 500)) throw e;
        // A business refusal or a passed deadline: the step is rolled back, the refusal recorded (a replay gets it).
        await tx.query("rollback to savepoint apply_step");
        await unbound(tx);
        return reject(deadline ? new ApiError(409, DEADLINE_EXCEEDED) : (e as ApiError));
      }
      return { kind: "applied" as const };
    });

    if (first.kind === "rejected") throw first.error;
    if (first.kind === "prior") {
      if (first.row.state === "FAILED") throw new ApiError(first.row.failure_status ?? 409, first.row.failure_code ?? "STATE_CONFLICT");
      const outcome = first.row.state === "COMPLETED" ? { status: 200, body: this.completedBody(first.row), replayed: true } : await this.complete(accountId, keyRef);
      await this.respond(reply, accountId, operation, { ...outcome, replayed: true });
      return;
    }
    // Step 1 is committed. PARTIAL_WRITE: step 2 fails, the request id stays INCOMPLETE until completed.
    if (this.faults.take(accountId, operation, ["PARTIAL_WRITE"])) throw new ApiError(500, "PARTIAL_WRITE");
    const outcome = await this.complete(accountId, keyRef);
    await this.respond(reply, accountId, operation, outcome);
  }

  /** Step 2 (finalization) of an APPLIED request; replays a COMPLETED one. 404 when the id is unknown. */
  async complete(accountId: string, keyRef: string): Promise<WriteOutcome> {
    return this.store.tx(async (tx) => {
      const row = (await tx.query<Row>("select * from refbiz.change_requests where account_id = $1 and key_ref = $2 for update", [accountId, keyRef])).rows[0];
      if (!row) throw new ApiError(404, "NOT_FOUND");
      if (row.state === "FAILED") throw new ApiError(row.failure_status ?? 409, row.failure_code ?? "STATE_CONFLICT");
      if (row.state === "COMPLETED") return { status: 200, body: this.completedBody(row), replayed: true };
      if (row.resource_type === null || row.resource_id === null || row.after_version === null) throw new ApiError(500, "CHANGE_REQUEST_CORRUPT");
      const receiptId = newId("rcp");
      const resource = row.response ?? {};
      const stateDigest = sha256Hex(canonicalJson(resource));
      await tx.query(
        "insert into refbiz.receipts (account_id, receipt_id, key_ref, operation, resource_type, resource_id, resource_version, state_digest, committed_at) values ($1, $2, $3, $4, $5, $6, $7, $8, coalesce($9, now()))",
        [accountId, receiptId, keyRef, row.operation, row.resource_type, row.resource_id, row.after_version, stateDigest, row.applied_at],
      );
      const done = (
        await tx.query<Row>("update refbiz.change_requests set state = 'COMPLETED', receipt_id = $3, completed_at = now() where account_id = $1 and key_ref = $2 returning *", [accountId, keyRef, receiptId])
      ).rows[0] as Row;
      return { status: 200, body: this.completedBody(done), replayed: false };
    });
  }

  /**
   * Fences a request id once its dispatch deadline (`notAfter`, the deadline the client gave the request) has
   * passed: the authoritative answer to "was it applied, or can it still be?", which the lagging lookup never gives.
   *   - nothing stored under the id: a FENCED row (REJECTED, failure FENCED) is inserted by one statement that only
   *     inserts while the database clock is past `notAfter`; every later delivery of the id is refused 409 FENCED;
   *   - a delivery of the id still inside its transaction (its row inserted, not committed: e.g. its COMMIT is
   *     delayed): the insert waits on the id's unique index until that transaction ends (PostgreSQL speculative
   *     insertion), then returns the committed change, or inserts the fence after a rollback;
   *   - a stored change request: returned as stored (COMPLETED / INCOMPLETE / REJECTED), without the lookup's lag;
   *   - nothing stored and the deadline not passed yet: 409 FENCE_BEFORE_DEADLINE (nothing changes).
   * `fencedNow` says whether this call inserted the fence.
   */
  async fence(accountId: string, keyRef: string, operation: KeyedWriteOperation, notAfter: string): Promise<{ body: Record<string, unknown>; fencedNow: boolean }> {
    return this.store.tx(async (tx) => {
      const inserted = await tx.query(
        `insert into refbiz.change_requests (account_id, key_ref, operation, request_digest, state, failure_status, failure_code, received_at, visible_at, completed_at, not_after)
         select $1, $2, $3, $4, 'FAILED', 409, $5, now(), now(), now(), $6::timestamptz where clock_timestamp() > $6::timestamptz
         on conflict (account_id, key_ref) do nothing returning key_ref`,
        [accountId, keyRef, operation, fenceDigest(operation), FENCED, notAfter],
      );
      const row = (await tx.query<Row>("select * from refbiz.change_requests where account_id = $1 and key_ref = $2 for update", [accountId, keyRef])).rows[0];
      if (!row) throw new ApiError(409, FENCE_BEFORE_DEADLINE);
      return { body: this.publicView(row), fencedNow: inserted.rowCount === 1 };
    });
  }

  /** Lookup by key (the documented reconciliation path). Null = 404 (unknown, or not yet visible). */
  async lookup(accountId: string, keyRef: string): Promise<Record<string, unknown> | null> {
    const row = (
      await this.store.query<Row & { visibility_window_ms: number }>(
        `select c.*, a.visibility_window_ms from refbiz.change_requests c join refbiz.accounts a using (account_id)
         where c.account_id = $1 and c.key_ref = $2 and c.visible_at <= now()`,
        [accountId, keyRef],
      )
    )[0];
    if (!row) return null;
    return this.publicView(row);
  }

  /** A change request as the API reports it (a REJECTED one with its failure code). */
  private publicView(row: Row): Record<string, unknown> {
    return {
      ...this.view(row),
      ...(row.state === "FAILED" ? { failureCode: row.failure_code } : {}),
    };
  }

  /** STALL_BEFORE_COMMIT seam (fault control only): holds the open transaction before its COMMIT. */
  private async stallBeforeCommit(accountId: string, operation: string): Promise<void> {
    const stall = this.faults.take(accountId, operation, ["STALL_BEFORE_COMMIT"]);
    if (stall && stall.delayMs > 0) await new Promise((r) => setTimeout(r, stall.delayMs));
  }

  private view(row: Row): Record<string, unknown> {
    return {
      requestId: row.key_ref,
      operation: row.operation,
      state: PUBLIC_STATE[row.state],
      receiptId: row.receipt_id,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      resourceVersion: row.after_version,
      appliedAt: row.applied_at?.toISOString() ?? null,
      completedAt: row.completed_at?.toISOString() ?? null,
      notAfter: row.not_after?.toISOString() ?? null,
      requestDigest: row.request_digest,
      resource: row.state === "FAILED" ? null : (row.response ?? null),
    };
  }

  private completedBody(row: Row): Record<string, unknown> {
    return this.view(row);
  }

  /** The lookup lag of an account (bounded by its documented visibility window); a LATE_RECEIPT fault may raise it. */
  private async lagMs(tx: Tx, accountId: string, override: number | null): Promise<number> {
    const a = (await tx.query<{ lookup_lag_ms: number; visibility_window_ms: number }>("select lookup_lag_ms, visibility_window_ms from refbiz.accounts where account_id = $1", [accountId])).rows[0];
    if (!a) throw new ApiError(403, "ACCOUNT_MISMATCH");
    return Math.min(override ?? a.lookup_lag_ms, a.visibility_window_ms);
  }

  /** Sends the outcome, applying after-commit faults (the change is already durable here). */
  private async respond(reply: FastifyReply, accountId: string, operation: string, outcome: WriteOutcome): Promise<void> {
    const drop = this.faults.take(accountId, operation, ["DROP_RESPONSE_AFTER_COMMIT"]);
    if (drop) {
      // The receipt never reaches the client: the connection ends without a response (logged as status 0).
      this.faults.record(accountId, { operation, keyRef: String(outcome.body.requestId), status: 0 });
      reply.request.refbiz = null;
      reply.hijack();
      reply.raw.socket?.destroy();
      return;
    }
    const late = this.faults.take(accountId, operation, ["LATE_RECEIPT"]);
    if (late) {
      const keyRef = String(outcome.body.requestId);
      await this.store.tx(async (tx) => {
        const lag = await this.lagMs(tx, accountId, late.lagMs);
        await tx.query("update refbiz.change_requests set visible_at = coalesce(applied_at, now()) + make_interval(secs => $3::double precision / 1000) where account_id = $1 and key_ref = $2", [accountId, keyRef, lag]);
      });
      if (late.delayMs > 0) await new Promise((r) => setTimeout(r, late.delayMs));
    }
    const delay = this.faults.take(accountId, operation, ["COMMIT_THEN_DELAY"]);
    if (delay && delay.delayMs > 0) await new Promise((r) => setTimeout(r, delay.delayMs));
    if (outcome.replayed) reply.header("Refbiz-Replayed", "true");
    await reply.code(outcome.status).send(outcome.body);
  }
}
