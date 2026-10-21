/**
 * LIVE transfer store (WP-07; FO-19-06, FO-21-10; SAFE-02, SAFE-04): TransferJourney documents in PostgreSQL
 * (migration 2070 transfer_journeys) for the live composition. The regression composition keeps journeys in
 * process memory (MemoryTransferStore, LOCAL FIXTURE); a deployed gateway runs several instances and a worker
 * sweep, so a journey must outlive the instance that started it.
 *
 *  - put(journey, null) inserts and fails TRANSFER_VERSION_CONFLICT when the handoff already exists;
 *    put(journey, v) updates only the row whose stored version is v (compare-and-set), and the migration's
 *    trigger also refuses any version step other than +1, so two writers can never both advance a journey.
 *  - every statement runs in a transaction with the deployment tenant's RLS context and the composing role
 *    (app_runtime in the gateway, app_worker in the sweep, app_console for the console's read-only views); a
 *    row of another tenant is invisible. Under app_console the store is READ ONLY: `put` is refused
 *    TRANSFER_STORE_READ_ONLY before any statement (the migration also grants that role select only).
 *  - the stored document is the journey itself (opaque ids, template ids, codes, times); it is re-validated
 *    structurally on read and a row that is not a journey of this tenant fails closed (TRANSFER_RECORD_INVALID).
 * Errors from the database are reason-coded DependencyErrors (driver messages can echo parameters).
 */
import type { Db, DbRole, Queryable } from "../../db/types.js";
import { ConflictError, DependencyError, PlatformError, ValidationError } from "../../shared/errors.js";
import type { TransferJourney, TransferStore } from "../../workflows/transfer.js";

const OPAQUE = /^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$/;
const UNIQUE_VIOLATION = "23505";

interface Row {
  journey: unknown;
}

function sqlState(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}

export interface PgTransferStoreOptions {
  db: Db;
  tenantId: string;
  /** app_runtime (gateway), app_worker (sweep) or app_console (read only: the console's transfer views). */
  role: Extract<DbRole, "app_runtime" | "app_worker" | "app_console">;
}

export class PgTransferStore implements TransferStore {
  readonly kind = "live" as const;
  private readonly db: Db;
  private readonly tenantId: string;
  private readonly role: Extract<DbRole, "app_runtime" | "app_worker" | "app_console">;

  constructor(opts: PgTransferStoreOptions) {
    if (!OPAQUE.test(opts.tenantId)) throw new ValidationError("TRANSFER_STORE_TENANT_INVALID");
    this.db = opts.db;
    this.tenantId = opts.tenantId;
    this.role = opts.role;
  }

  private run<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return this.db.tx(fn, { role: this.role, rls: { tenantId: this.tenantId } }).catch((err: unknown) => {
      // A duplicate handoff is a write conflict (the journey exists), never a retryable outage.
      if (sqlState(err) === UNIQUE_VIOLATION || sqlState((err as { cause?: unknown } | null)?.cause) === UNIQUE_VIOLATION) throw new ConflictError("TRANSFER_VERSION_CONFLICT");
      if (err instanceof PlatformError) throw err;
      throw new DependencyError("TRANSFER_STORE_UNAVAILABLE", "NOT_STARTED", true);
    });
  }

  private parse(raw: unknown): TransferJourney {
    const j = (typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw) as Partial<TransferJourney> | null;
    if (
      !j ||
      typeof j !== "object" ||
      j.tenantId !== this.tenantId ||
      typeof j.handoffId !== "string" ||
      !OPAQUE.test(j.handoffId) ||
      typeof j.callId !== "string" ||
      typeof j.version !== "number" ||
      !Array.isArray(j.attempts) ||
      !Array.isArray(j.routePlan)
    ) {
      throw new DependencyError("TRANSFER_RECORD_INVALID", "FAILED", false);
    }
    return j as TransferJourney;
  }

  async get(handoffId: string): Promise<TransferJourney | null> {
    if (!OPAQUE.test(handoffId)) return null;
    const rows = await this.run((tx) => tx.query<Row>("select journey from transfer_journeys where tenant_id = $1 and handoff_id = $2", [this.tenantId, handoffId]));
    const r = rows.rows[0];
    return r ? this.parse(r.journey) : null;
  }

  async findByTransferId(transferId: string): Promise<TransferJourney | null> {
    if (!OPAQUE.test(transferId)) return null;
    const rows = await this.run((tx) =>
      tx.query<Row>("select journey from transfer_journeys where tenant_id = $1 and transfer_ids @> array[$2]::text[] order by created_at desc limit 1", [this.tenantId, transferId]),
    );
    const r = rows.rows[0];
    return r ? this.parse(r.journey) : null;
  }

  /** True when the store only reads (app_console). */
  get readOnly(): boolean {
    return this.role === "app_console";
  }

  async put(journey: TransferJourney, expectedVersion: number | null): Promise<void> {
    if (this.readOnly) throw new DependencyError("TRANSFER_STORE_READ_ONLY", "NOT_STARTED", false);
    if (journey.tenantId !== this.tenantId) throw new ValidationError("TRANSFER_TENANT_MISMATCH");
    if (!OPAQUE.test(journey.handoffId)) throw new ValidationError("TRANSFER_HANDOFF_ID_INVALID");
    const transferIds = [...new Set(journey.attempts.map((a) => a.transferId))].filter((t) => OPAQUE.test(t)).slice(-64);
    const doc = JSON.stringify(journey);
    if (expectedVersion === null) {
      await this.run((tx) =>
        tx.query(
          `insert into transfer_journeys (tenant_id, handoff_id, call_id, status, priority, transfer_ids, version, journey, created_at, updated_at)
           values ($1, $2, $3, $4, $5, $6::text[], $7, $8::jsonb, $9, $10)`,
          [this.tenantId, journey.handoffId, journey.callId, journey.status, journey.priority, transferIds, journey.version, doc, journey.createdAt, journey.updatedAt],
        ),
      );
      return;
    }
    const updated = await this.run(async (tx) => {
      // The row lock taken by the update serializes concurrent writers; the losing writer matches no row.
      const r = await tx.query<{ handoff_id: string }>(
        `update transfer_journeys set status = $3, transfer_ids = $4::text[], version = $5, journey = $6::jsonb, updated_at = $7
          where tenant_id = $1 and handoff_id = $2 and version = $8
          returning handoff_id`,
        [this.tenantId, journey.handoffId, journey.status, transferIds, journey.version, doc, journey.updatedAt, expectedVersion],
      );
      return r.rows.length;
    });
    if (updated !== 1) throw new ConflictError("TRANSFER_VERSION_CONFLICT");
  }

  async listActive(): Promise<TransferJourney[]> {
    const rows = await this.run((tx) => tx.query<Row>("select journey from transfer_journeys where tenant_id = $1 and status = 'ROUTING' order by created_at limit 500", [this.tenantId]));
    return rows.rows.map((r) => this.parse(r.journey));
  }

  async listForCall(tenantId: string, callId: string): Promise<TransferJourney[]> {
    if (tenantId !== this.tenantId) return [];
    const rows = await this.run((tx) => tx.query<Row>("select journey from transfer_journeys where tenant_id = $1 and call_id = $2 order by created_at limit 64", [this.tenantId, callId]));
    return rows.rows.map((r) => this.parse(r.journey));
  }
}
