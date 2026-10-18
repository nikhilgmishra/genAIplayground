/**
 * LOCAL TEST FIXTURES for ops tests (SYNTHETIC data only). Not imported by
 * production code.
 *
 * `InTxAuditWriterFixture` implements the AuditWriter port by inserting into a
 * test-only table inside the caller's transaction, so tests can prove that the
 * audit event commits or rolls back atomically with the change it records.
 * It validates every input against the protocol AuditEventInput schema and the
 * audit writer's action / evidence-pointer grammar.
 */
import type { AuditWriter } from "../audit/ports.js";
import type { Db, Queryable } from "../db/types.js";
import { createTestDb } from "../db/testing.js";
import type { PgliteDb } from "../db/pglite.js";
import { STAFF } from "../fixtures/synthetic-world.js";

import type { AuditEvent, StaffActor, StaffRole } from "../protocol/index.js";
import { AuditUnavailableError, ValidationError } from "../shared/errors.js";
import { newId } from "../shared/ids.js";
import { validateAuditInput } from "../audit/schema.js";

const ACTION_RE = /^[a-z][a-z0-9_]{0,31}(\.[a-z][a-z0-9_]{0,31}){1,5}$/;
const POINTER_RE = /^(s3|db|sf|ledger|wf|kv):\/\/[A-Za-z0-9/_.:@-]{3,190}$/;

export async function createOpsTestDb(): Promise<PgliteDb> {
  const db = await createTestDb({ include: /^06/ });
  await db.exec(`
    create table test_audit_fixture (event_id text primary key, tenant_id text not null, action text not null, outcome text not null, body jsonb not null);
    grant select, insert on test_audit_fixture to app_console, app_runtime;
  `);
  return db;
}

export class InTxAuditWriterFixture implements AuditWriter {
  readonly kind = "local_fixture" as const;
  readonly standalone: AuditEvent[] = [];
  failAppend = false;
  failStandalone = false;

  constructor(private readonly db: Db) {}

  private validate(input: unknown) {
    // Same validation as the real writer (platform/src/audit/schema.ts), so fixtures cannot accept what production rejects.
    let e: ReturnType<typeof validateAuditInput>;
    try {
      e = validateAuditInput(input);
    } catch {
      throw new ValidationError("AUDIT_EVENT_INVALID");
    }
    if (!ACTION_RE.test(e.action)) throw new ValidationError("AUDIT_EVENT_INVALID");
    if (!e.evidencePointers.every((p) => POINTER_RE.test(p))) throw new ValidationError("AUDIT_EVENT_INVALID");
    if (e.reasonCode && /\d{4,}/.test(e.reasonCode)) throw new ValidationError("AUDIT_EVENT_INVALID");
    return e;
  }

  private toEvent(e: ReturnType<InTxAuditWriterFixture["validate"]>): AuditEvent {
    return { ...e, eventId: newId("aud"), schemaVersion: "audit.v1", sourceStream: "fixture.ops", sequence: 1, prevHash: null, hash: "0".repeat(64) };
  }

  async append(tx: Queryable, input: Parameters<AuditWriter["append"]>[1]): Promise<AuditEvent> {
    const e = this.validate(input);
    if (this.failAppend) throw new AuditUnavailableError();
    const ev = this.toEvent(e);
    await tx.query("insert into test_audit_fixture (event_id, tenant_id, action, outcome, body) values ($1, $2, $3, $4, $5::jsonb)", [
      ev.eventId,
      ev.tenantId,
      ev.action,
      ev.outcome,
      JSON.stringify(ev),
    ]);
    return ev;
  }

  async appendStandalone(input: Parameters<AuditWriter["appendStandalone"]>[0]): Promise<AuditEvent> {
    const e = this.validate(input);
    if (this.failStandalone) throw new AuditUnavailableError();
    const ev = this.toEvent(e);
    this.standalone.push(ev);
    return ev;
  }

  async committed(): Promise<{ event_id: string; tenant_id: string; action: string; outcome: string; body: AuditEvent }[]> {
    return (await this.db.query<{ event_id: string; tenant_id: string; action: string; outcome: string; body: AuditEvent }>("select * from test_audit_fixture order by event_id")).rows;
  }
}

/** SYNTHETIC staff actor as established by workforce SSO. */
export function staffActor(kind: keyof typeof STAFF, over: Partial<StaffActor> = {}): StaffActor {
  const s = STAFF[kind];
  return {
    staffId: s.staffId,
    roles: [...s.roles] as StaffRole[],
    mfa: true,
    authenticatedAt: "2026-10-17T14:00:00.000Z",
    breakGlass: null,
    ...over,
  };
}
