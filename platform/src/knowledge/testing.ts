/**
 * LOCAL TEST FIXTURES for knowledge tests (SYNTHETIC data only). Not imported by
 * production code.
 */
import { createTestDb } from "../db/testing.js";
import type { PgliteDb } from "../db/pglite.js";
import type { KnowledgeItemInput } from "./ports.js";
import type { AuditWriter } from "../audit/ports.js";
import type { Db, Queryable } from "../db/types.js";
import { AuditEventInput } from "../protocol/index.js";
import type { AuditEvent } from "../protocol/index.js";
import { AuditUnavailableError, ValidationError } from "../shared/errors.js";
import { newId } from "../shared/ids.js";
import { validateAuditInput } from "../audit/schema.js";

export const createKnowledgeTestDb = (): Promise<PgliteDb> => createTestDb({ include: /^05/ });

/** TEST-ONLY synthetic approval placeholder; not an approval record. */
export const SYNTHETIC_APPROVAL = { status: "APPROVED", approvedBy: "SYNTHETIC_FIXTURE_APPROVER", approvedAt: "2026-09-01T00:00:00.000Z" } as const;

export function knowledgeItemFixture(overrides: Partial<KnowledgeItemInput> = {}): KnowledgeItemInput {
  return {
    sourceId: "faq-test-item",
    sourceSystem: "salesforce_knowledge",
    version: 1,
    title: "Synthetic test article",
    body: "This synthetic article explains how to reschedule an appointment in the portal.",
    owner: "team_support_knowledge",
    audiences: ["public"],
    permittedIntents: ["appointment_reschedule"],
    jurisdiction: "US",
    language: "en",
    effectiveFrom: "2026-01-01T00:00:00.000Z",
    expiresAt: "2027-12-31T23:59:59.000Z",
    sensitivity: "PUBLIC",
    approval: { ...SYNTHETIC_APPROVAL },
    ...overrides,
  };
}


/**
 * LOCAL TEST FIXTURE AuditWriter: validates every input against the protocol
 * AuditEventInput schema and inserts it into a test-only table inside the
 * caller's transaction, so tests can prove atomicity with the change it records.
 */
export class InTxAuditWriterFixture implements AuditWriter {
  readonly kind = "local_fixture" as const;
  failAppend = false;
  constructor(private readonly db: Db) {}

  static async install(db: Db): Promise<InTxAuditWriterFixture> {
    await db.exec(`
      create table if not exists test_audit_fixture (event_id text primary key, tenant_id text not null, action text not null, outcome text not null, body jsonb not null);
      grant select, insert on test_audit_fixture to app_runtime, app_worker, app_console;
    `);
    return new InTxAuditWriterFixture(db);
  }

  async append(tx: Queryable, input: AuditEventInput): Promise<AuditEvent> {
    // Same validation as the real writer (platform/src/audit/schema.ts).
    let validated: ReturnType<typeof validateAuditInput>;
    try {
      validated = validateAuditInput(input);
    } catch {
      throw new ValidationError("AUDIT_EVENT_INVALID");
    }
    const parsed = { data: validated };
    if (this.failAppend) throw new AuditUnavailableError();
    const ev: AuditEvent = { ...parsed.data, eventId: newId("aud"), schemaVersion: "audit.v1", sourceStream: "fixture.test", sequence: 1, prevHash: null, hash: "0".repeat(64) };
    await tx.query("insert into test_audit_fixture (event_id, tenant_id, action, outcome, body) values ($1, $2, $3, $4, $5::jsonb)", [
      ev.eventId,
      ev.tenantId,
      ev.action,
      ev.outcome,
      JSON.stringify(ev),
    ]);
    return ev;
  }

  async appendStandalone(input: AuditEventInput): Promise<AuditEvent> {
    return this.db.tx((tx) => this.append(tx, input), { role: "owner" });
  }

  async committed(): Promise<{ action: string; outcome: string; body: AuditEvent }[]> {
    return (await this.db.query<{ action: string; outcome: string; body: AuditEvent }>("select action, outcome, body from test_audit_fixture order by event_id")).rows;
  }
}
