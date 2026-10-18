/**
 * IN-TEST FIXTURE — LOCAL ONLY, NOT DURABLE, NOT INDEPENDENT AUDIT EVIDENCE.
 *
 * AuditWriter used by safety tests. It validates every input with the strict
 * protocol AuditEventInput schema and, when given a fixture table, inserts a
 * marker row through the CALLER'S transaction so commit/rollback atomicity is
 * observable. It can be switched into outage mode to exercise fail-safe paths.
 */
import type { AuditWriter } from "../../audit/ports.js";
import type { Queryable } from "../../db/types.js";
import { AUDIT_SCHEMA_VERSION } from "../../protocol/index.js";
import type { AuditEvent, AuditEventInput as AuditEventInputType } from "../../protocol/index.js";
import { canonicalJson, sha256Hex } from "../../shared/canonical.js";
import { AuditUnavailableError } from "../../shared/errors.js";
import { newId } from "../../shared/ids.js";
import { validateAuditInput } from "../../audit/schema.js";

export const SAFETY_AUDIT_FIXTURE_BADGE = "IN-TEST AUDIT WRITER FIXTURE — NOT DURABLE, NOT INDEPENDENT EVIDENCE";

/** SQL for the fixture table that makes in-transaction appends observable. */
export const FIXTURE_AUDIT_TABLE_SQL = `
  create table fixture_audit_events (event_id text primary key, tenant_id text not null, action text not null);
  grant insert, select on fixture_audit_events to app_runtime;
`;

export class RecordingAuditWriterFixture implements AuditWriter {
  readonly kind = "local_fixture" as const;
  readonly badge = SAFETY_AUDIT_FIXTURE_BADGE;
  /** Every append attempt that passed validation (including ones later rolled back). */
  readonly events: AuditEvent[] = [];
  /** Inputs exactly as received, for content checks. */
  readonly inputs: AuditEventInputType[] = [];
  outage = false;
  /** Write the marker row, then fail: proves the caller's transaction rolls back together. */
  failAfterWrite = false;
  private seq = 0;
  private prev: string | null = null;

  constructor(private readonly opts: { table?: string } = {}) {}

  async append(tx: Queryable, input: AuditEventInputType, stream?: string): Promise<AuditEvent> {
    if (this.outage) throw new AuditUnavailableError("AUDIT_UNAVAILABLE");
    const parsed = validateAuditInput(input); // same validation as the real writer
    this.inputs.push(input);
    this.seq += 1;
    const body: Omit<AuditEvent, "hash"> = {
      ...parsed,
      eventId: newId("aud"),
      schemaVersion: AUDIT_SCHEMA_VERSION,
      sourceStream: stream ?? "safety.fixture",
      sequence: this.seq,
      prevHash: this.prev,
    };
    const hash = sha256Hex(canonicalJson(body));
    const event: AuditEvent = { ...body, hash };
    if (this.opts.table) {
      await tx.query(`insert into ${this.opts.table} (event_id, tenant_id, action) values ($1, $2, $3)`, [event.eventId, event.tenantId, event.action]);
    }
    if (this.failAfterWrite) throw new AuditUnavailableError("AUDIT_UNAVAILABLE");
    this.prev = hash;
    this.events.push(event);
    return event;
  }

  async appendStandalone(): Promise<AuditEvent> {
    throw new AuditUnavailableError("FIXTURE_STANDALONE_NOT_SUPPORTED");
  }
}
