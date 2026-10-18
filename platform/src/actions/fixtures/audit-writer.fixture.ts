/**
 * LOCAL TEST FIXTURE — in-transaction AuditWriter + AuditHealth for action-ledger tests.
 * NOT the audit module (platform/src/audit owns the real writer); this fixture depends only on
 * the AuditWriter/AuditHealth ports so the ledger can be tested while that module evolves.
 *
 * Rows are written with the caller's transaction into a fixture table, so rollback semantics
 * are real: an event appended inside a transaction that later rolls back disappears.
 * Outage modes throw AuditUnavailableError (OPS-01 fail-closed tests).
 */
import type { AuditHealth, AuditHealthStatus, AuditWriter } from "../../audit/ports.js";
import type { Db, Queryable } from "../../db/types.js";
import { AUDIT_SCHEMA_VERSION, AuditEvent } from "../../protocol/index.js";
import type { AuditEvent as AuditEventT, AuditEventInput as AuditEventInputT } from "../../protocol/index.js";
import { digestOf } from "../../shared/canonical.js";
import { AuditUnavailableError } from "../../shared/errors.js";
import { newId } from "../../shared/ids.js";
import { validateAuditInput } from "../../audit/schema.js";

export const AUDIT_FIXTURE_TABLE = "test_fixture_audit_events";

/**
 * Evidence pointer grammar mirrored from the audit module's writer contract at time of writing
 * (typed opaque ref "kind:prefix_opaque" or an internal scheme URL), so ledger tests fail if the
 * ledger emits pointers the real writer would reject.
 */
const TYPED_OPAQUE_REF = /^[a-z][a-z0-9_]{1,31}:[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$/;
const SCHEME_POINTER = /^(s3|db|sf|ledger|wf|kv):\/\/[A-Za-z0-9/_.:@-]{3,190}$/;
const ACTION_NAME = /^[a-z][a-z0-9_]{0,31}(\.[a-z][a-z0-9_]{0,31}){1,5}$/;
const OPAQUE_SESSION_REF = /^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$/;

/** Creates the fixture table (owner role). Call once per test database. */
export async function installAuditFixtureTable(db: Db): Promise<void> {
  await db.tx(
    async (tx) => {
      await tx.exec(`
        create table if not exists ${AUDIT_FIXTURE_TABLE} (
          seq bigserial primary key,
          event_id text not null unique,
          tenant_id text not null,
          stream text not null,
          action text not null,
          outcome text not null,
          reason_code text null,
          correlation_id text not null,
          event jsonb not null
        );
        grant select, insert on ${AUDIT_FIXTURE_TABLE} to app_runtime, app_worker;
        grant usage, select on all sequences in schema public to app_runtime, app_worker;
      `);
    },
    { role: "owner" },
  );
}

export interface FixtureAuditRow {
  seq: number;
  eventId: string;
  tenantId: string;
  action: string;
  outcome: string;
  reasonCode: string | null;
  correlationId: string;
}

/** Committed fixture audit rows, optionally for one correlation id (action id). */
export async function fixtureAuditRows(db: Db, correlationId?: string): Promise<FixtureAuditRow[]> {
  const r = await db.tx(
    (tx) =>
      tx.query<{ seq: string | number; event_id: string; tenant_id: string; action: string; outcome: string; reason_code: string | null; correlation_id: string }>(
        `select seq, event_id, tenant_id, action, outcome, reason_code, correlation_id from ${AUDIT_FIXTURE_TABLE}
         ${correlationId ? "where correlation_id = $1" : ""} order by seq`,
        correlationId ? [correlationId] : [],
      ),
    { role: "owner" },
  );
  return r.rows.map((x) => ({
    seq: Number(x.seq),
    eventId: x.event_id,
    tenantId: x.tenant_id,
    action: x.action,
    outcome: x.outcome,
    reasonCode: x.reason_code,
    correlationId: x.correlation_id,
  }));
}

export class InTxAuditWriterFixture implements AuditWriter {
  readonly kind = "local_fixture" as const;
  /** Every append throws AuditUnavailableError. */
  outage = false;
  /** Appends for these audit action names throw AuditUnavailableError (e.g. only "action.commit.succeeded"). */
  readonly failActions = new Set<string>();
  /** Appends that executed their INSERT (they may still have been rolled back). */
  attemptedAppends = 0;

  constructor(private readonly db: Db) {}

  async append(tx: Queryable, input: AuditEventInputT, stream = "default"): Promise<AuditEventT> {
    if (this.outage || this.failActions.has(input.action)) throw new AuditUnavailableError("AUDIT_FIXTURE_OUTAGE");
    const parsed = validateAuditInput(input); // same validation as the real writer
    if (!ACTION_NAME.test(parsed.action)) throw new Error("AUDIT_FIXTURE_INVALID_ACTION_NAME");
    for (const p of parsed.evidencePointers) {
      if (!TYPED_OPAQUE_REF.test(p) && !SCHEME_POINTER.test(p)) throw new Error("AUDIT_FIXTURE_INVALID_EVIDENCE_POINTER");
    }
    if (new Set(parsed.evidencePointers).size !== parsed.evidencePointers.length) throw new Error("AUDIT_FIXTURE_DUPLICATE_EVIDENCE_POINTER");
    if (parsed.sessionRef !== null && !OPAQUE_SESSION_REF.test(parsed.sessionRef)) throw new Error("AUDIT_FIXTURE_INVALID_SESSION_REF");
    // Bearer session references must never be audited (only the ses_bnd_ binding ref).
    if (parsed.sessionRef !== null && parsed.sessionRef.startsWith("ses_") && !parsed.sessionRef.startsWith("ses_bnd_")) {
      throw new Error("AUDIT_FIXTURE_BEARER_SESSION_REF");
    }
    const eventId = newId("aud");
    const hash = digestOf({ eventId, stream, ...parsed });
    const inserted = await tx.query<{ seq: string | number }>(
      `insert into ${AUDIT_FIXTURE_TABLE} (event_id, tenant_id, stream, action, outcome, reason_code, correlation_id, event)
       values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb) returning seq`,
      [eventId, parsed.tenantId, stream, parsed.action, parsed.outcome, parsed.reasonCode, parsed.correlationId, JSON.stringify(parsed)],
    );
    this.attemptedAppends += 1;
    return AuditEvent.parse({
      ...parsed,
      eventId,
      schemaVersion: AUDIT_SCHEMA_VERSION,
      sourceStream: stream,
      sequence: Number(inserted.rows[0]?.seq ?? 1),
      prevHash: null,
      hash,
    });
  }

  async appendStandalone(input: AuditEventInputT, stream?: string): Promise<AuditEventT> {
    return this.db.tx((tx) => this.append(tx, input, stream), { role: "app_runtime", rls: { tenantId: input.tenantId } });
  }
}

/** LOCAL TEST FIXTURE: health mirrors the writer's outage flag (plus an independent override). */
export class AuditHealthFixture implements AuditHealth {
  /** Health says "cannot accept" even though appends would work (bounded-buffer exceeded). */
  forceUnhealthy = false;
  assertCalls = 0;

  constructor(private readonly writer: InTxAuditWriterFixture) {}

  async status(): Promise<AuditHealthStatus> {
    const ok = !this.writer.outage && !this.forceUnhealthy;
    return { canAcceptConsequential: ok, backlogCount: 0, oldestUnshippedAgeSeconds: null, sinkHealthy: ok, reasonCode: ok ? null : "AUDIT_FIXTURE_OUTAGE" };
  }

  async assertCanAcceptConsequential(): Promise<void> {
    this.assertCalls += 1;
    if (this.writer.outage || this.forceUnhealthy) throw new AuditUnavailableError("AUDIT_FIXTURE_OUTAGE");
  }
}
