/**
 * LOCAL TEST FIXTURES for the workflows module. SYNTHETIC — NOT PRODUCTION.
 *
 * - AuditWriterFixture: implements the AuditWriter port by writing validated
 *   AuditEventInput rows into a test-only table INSIDE the caller's
 *   transaction, so rollback semantics are real (OPS-01 fail-closed tests).
 *   It can be switched to "unavailable" to prove consequential transitions are
 *   blocked when evidence cannot be written. It is not the platform audit
 *   writer (platform/src/audit) and is never used outside tests.
 * - RecheckFixture: a labelled local_fixture PreDisclosureRecheck.
 * - MemoryAuditWriterFixture: in-memory AuditWriter (validates every input) with
 *   an "unavailable" switch, for the transfer coordinator tests.
 * - TelephonyControlFixture: records dial and approved-update requests; can be
 *   made to fail per destination or entirely. The TelephonyControl port has no
 *   hang-up operation, so no test double can end a call either.
 */
import type { AdapterHealth, TelephonyControl } from "../adapters/ports.js";
import type { AuditWriter } from "../audit/ports.js";
import type { Db, Queryable } from "../db/types.js";
import { AUDIT_SCHEMA_VERSION, AuditEventInput, type AuditEvent, type DestinationId, type StaffActor } from "../protocol/index.js";
import { sha256Hex, canonicalJson } from "../shared/canonical.js";
import { AuditUnavailableError } from "../shared/errors.js";
import { newId } from "../shared/ids.js";
import { STAFF } from "../fixtures/synthetic-world.js";
import type { PreDisclosureRecheck, RecheckContext, RecheckResult } from "./recheck.js";
import { validateAuditInput } from "../audit/schema.js";

export const FIXTURE_LABEL = "LOCAL TEST FIXTURE — SYNTHETIC";

export class AuditWriterFixture implements AuditWriter {
  readonly kind = "local_fixture" as const;
  readonly label = FIXTURE_LABEL;
  unavailable = false;
  private seq = 0;

  private constructor(private readonly db: Db) {}

  static async create(db: Db): Promise<AuditWriterFixture> {
    await db.tx(
      async (tx) => {
        await tx.exec(`create table if not exists wf_test_audit_fixture (
          id serial primary key, tenant_id text not null, action text not null, payload jsonb not null);
          grant select, insert on wf_test_audit_fixture to app_runtime, app_worker;
          grant usage on sequence wf_test_audit_fixture_id_seq to app_runtime, app_worker;`);
      },
      { role: "owner" },
    );
    return new AuditWriterFixture(db);
  }

  async append(tx: Queryable, input: AuditEventInput, stream = "workflow.fixture"): Promise<AuditEvent> {
    if (this.unavailable) throw new AuditUnavailableError("AUDIT_FIXTURE_UNAVAILABLE");
    const parsed = validateAuditInput(input); // same validation as the real writer
    await tx.query("insert into wf_test_audit_fixture (tenant_id, action, payload) values ($1, $2, $3)", [
      parsed.tenantId,
      parsed.action,
      JSON.stringify(parsed),
    ]);
    this.seq += 1;
    const hash = sha256Hex(canonicalJson(parsed));
    return { ...parsed, eventId: newId("aud"), schemaVersion: AUDIT_SCHEMA_VERSION, sourceStream: stream, sequence: this.seq, prevHash: null, hash };
  }

  async appendStandalone(input: AuditEventInput, stream?: string): Promise<AuditEvent> {
    return this.db.tx((tx) => this.append(tx, input, stream), { role: "owner" });
  }

  async all(): Promise<AuditEventInput[]> {
    const r = await this.db.tx((tx) => tx.query<{ payload: AuditEventInput | string }>("select payload from wf_test_audit_fixture order by id"), {
      role: "owner",
    });
    return r.rows.map((x) => (typeof x.payload === "string" ? (JSON.parse(x.payload) as AuditEventInput) : x.payload));
  }

  async rawDump(): Promise<string> {
    const r = await this.db.tx((tx) => tx.query<{ payload: unknown }>("select payload from wf_test_audit_fixture order by id"), { role: "owner" });
    return JSON.stringify(r.rows);
  }
}

export class RecheckFixture implements PreDisclosureRecheck {
  readonly kind = "local_fixture" as const;
  readonly calls: RecheckContext[] = [];
  constructor(private readonly decide: (ctx: RecheckContext) => RecheckResult | Promise<RecheckResult> = () => ({ allow: true })) {}
  async recheck(ctx: RecheckContext): Promise<RecheckResult> {
    this.calls.push(ctx);
    return this.decide(ctx);
  }
}

/** SYNTHETIC workforce actors derived from the canonical synthetic world. */
export function staffActor(
  who: keyof typeof STAFF,
  overrides: Partial<StaffActor> = {},
  authenticatedAt = "2026-10-17T14:00:00.000Z",
): StaffActor {
  const s = STAFF[who];
  return { staffId: s.staffId, roles: [...s.roles], mfa: true, authenticatedAt, breakGlass: null, ...overrides };
}

/** LOCAL TEST FIXTURE: in-memory AuditWriter for components without a database transaction. */
export class MemoryAuditWriterFixture implements AuditWriter {
  readonly kind = "local_fixture" as const;
  readonly label = FIXTURE_LABEL;
  readonly events: AuditEventInput[] = [];
  unavailable = false;

  async append(_tx: Queryable, input: AuditEventInput, stream = "transfer.fixture"): Promise<AuditEvent> {
    return this.appendStandalone(input, stream);
  }

  async appendStandalone(input: AuditEventInput, stream = "transfer.fixture"): Promise<AuditEvent> {
    if (this.unavailable) throw new AuditUnavailableError("AUDIT_FIXTURE_UNAVAILABLE");
    const parsed = validateAuditInput(input); // same validation as the real writer
    this.events.push(parsed);
    return {
      ...parsed,
      eventId: newId("aud"),
      schemaVersion: AUDIT_SCHEMA_VERSION,
      sourceStream: stream,
      sequence: this.events.length,
      prevHash: null,
      hash: sha256Hex(canonicalJson(parsed)),
    };
  }
}

/**
 * LOCAL TEST FIXTURE: TelephonyControl double (SYNTHETIC). Records every dial and
 * update request. Note the port deliberately has no hang-up operation.
 */
export class TelephonyControlFixture implements TelephonyControl {
  readonly kind = "local_fixture" as const;
  readonly integrationId = "talkdesk_fixture";
  readonly label = FIXTURE_LABEL;
  readonly dials: { callId: string; destinationId: string; handoffId: string; priority: "SAFETY" | "STANDARD" }[] = [];
  readonly updates: { callId: string; templateId: string }[] = [];
  /** Destinations whose dial command throws. */
  readonly failingDestinations = new Set<string>();
  unavailable = false;
  failUpdates = false;

  async health(): Promise<AdapterHealth> {
    return { healthy: !this.unavailable, reasonCode: this.unavailable ? "FIXTURE_UNAVAILABLE" : null };
  }

  async requestTransfer(input: { callId: string; destinationId: DestinationId; handoffId: string; priority: "SAFETY" | "STANDARD" }): Promise<{ transferRef: string }> {
    this.dials.push({ ...input });
    if (this.unavailable || this.failingDestinations.has(input.destinationId)) throw new Error("synthetic dial failure");
    return { transferRef: newId("tdx") };
  }

  async playApprovedUpdate(input: { callId: string; templateId: string }): Promise<void> {
    this.updates.push({ ...input });
    if (this.failUpdates) throw new Error("synthetic playback failure");
  }
}
