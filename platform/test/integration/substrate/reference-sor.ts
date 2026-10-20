/**
 * Layer-2 support (WP-04): a REFERENCE SYSTEM OF RECORD for the commit-protocol contention runs, kept in its
 * own postgres:16 database (never the platform's), plus the ledger helpers that drive the production
 * LedgerActionService with real components (PgAuditWriter, PgAuditHealth, PgOutbox).
 *
 * The reference system behaves like a scheduling vendor that honours an idempotency key: `commit` with a key
 * it has already applied returns the original result and applies nothing; a commit whose record version moved
 * is refused with VERSION_CONFLICT. Every call is counted in sor_calls and every applied effect is a row in
 * sor_effects, so "the provider was called once" and "exactly one effect" are database facts, not counters in
 * test memory. Hooks let a test hold a call inside the provider (latches) or announce that the effect was
 * applied (the CRASH_AFTER_COMMIT point). SYNTHETIC data only.
 */
import { randomBytes } from "node:crypto";
import { LedgerActionService } from "../../../src/actions/action-service.js";
import type { ActionLedgerConfig } from "../../../src/actions/action-service.js";
import type { PrepareInput, ProviderCommitPort, ProviderCommitResult, ProviderLookupResult } from "../../../src/actions/ports.js";
import { PgAuditHealth } from "../../../src/audit/health.js";
import { PgAuditWriter } from "../../../src/audit/writer.js";
import { PgPoolDb } from "../../../src/db/pg.js";
import type { Db } from "../../../src/db/types.js";
import { PgOutbox } from "../../../src/outbox/outbox.js";
import type { ActionConfirmation, AuthContext, IntegrationIdentity, PolicyDecision, PreparedAction } from "../../../src/protocol/index.js";
import type { Logger } from "../../../src/observability/ports.js";
import type { Clock } from "../../../src/shared/clock.js";
import { addMs, iso } from "../../../src/shared/clock.js";
import { DependencyError } from "../../../src/shared/errors.js";
import { newId, newSessionRef, newTurnId } from "../../../src/shared/ids.js";

export const POLICY_VERSION = "policy-2026-10-19.1";

export interface SorHooks {
  /** Called inside `commit` before anything is applied (hold the call here with a latch). */
  beforeApply?(): Promise<void>;
  /** Called after the effect was applied and committed at the system of record. */
  afterApply?(): Promise<void>;
  /** When set, `commit` throws this instead of applying (an ambiguous timeout after `beforeApply`). */
  failWith?: () => Error;
}

/** The reference system of record over its own database. */
export class ReferenceSystemOfRecord implements ProviderCommitPort {
  constructor(
    readonly db: PgPoolDb,
    private readonly hooks: SorHooks = {},
  ) {}

  static async install(db: PgPoolDb): Promise<void> {
    await db.exec(`
      create table if not exists sor_records (record_ref text primary key, version integer not null);
      create table if not exists sor_effects (idempotency_key text primary key, record_ref text not null references sor_records (record_ref),
        provider_reference text not null, after_version text not null, applied_at timestamptz not null default now());
      create table if not exists sor_calls (call_seq bigserial primary key, kind text not null, idempotency_key text, at timestamptz not null default now());`);
  }

  withHooks(hooks: SorHooks): ReferenceSystemOfRecord {
    return new ReferenceSystemOfRecord(this.db, hooks);
  }

  async seed(recordRef: string, version = 1): Promise<void> {
    await this.db.query("insert into sor_records (record_ref, version) values ($1, $2)", [recordRef, version]);
  }

  async currentVersion(action: PreparedAction): Promise<string> {
    await this.db.query("insert into sor_calls (kind, idempotency_key) values ('version', null)");
    const r = await this.db.query<{ version: number }>("select version from sor_records where record_ref = $1", [action.target.recordRef]);
    const v = r.rows[0]?.version;
    if (v === undefined) throw new DependencyError("SOR_RECORD_NOT_FOUND", "FAILED", false);
    return `v${v}`;
  }

  async commit(action: PreparedAction, key: string): Promise<ProviderCommitResult> {
    await this.db.query("insert into sor_calls (kind, idempotency_key) values ('commit', $1)", [key]);
    await this.hooks.beforeApply?.();
    if (this.hooks.failWith) throw this.hooks.failWith();
    const result = await this.db.tx(
      async (tx) => {
        // Idempotency first: a key already applied returns its original result and applies nothing.
        const prior = await tx.query<{ provider_reference: string; after_version: string }>("select provider_reference, after_version from sor_effects where idempotency_key = $1", [key]);
        if (prior.rows[0]) return { outcome: "COMMITTED" as const, providerReference: prior.rows[0].provider_reference, afterVersion: prior.rows[0].after_version, evidence: { replayed: true } };
        const rec = await tx.query<{ version: number }>("select version from sor_records where record_ref = $1 for update", [action.target.recordRef]);
        const current = rec.rows[0]?.version;
        if (current === undefined || `v${current}` !== action.target.beforeVersion) return { outcome: "FAILED" as const, reasonCode: "VERSION_CONFLICT", permanent: true };
        const after = `v${current + 1}`;
        const reference = `SOR-${randomBytes(6).toString("hex").toUpperCase()}`;
        await tx.query("update sor_records set version = version + 1 where record_ref = $1", [action.target.recordRef]);
        await tx.query("insert into sor_effects (idempotency_key, record_ref, provider_reference, after_version) values ($1, $2, $3, $4)", [key, action.target.recordRef, reference, after]);
        return { outcome: "COMMITTED" as const, providerReference: reference, afterVersion: after, evidence: { replayed: false } };
      },
      { role: "owner" },
    );
    await this.hooks.afterApply?.();
    return result;
  }

  async lookup(_action: PreparedAction, key: string): Promise<ProviderLookupResult> {
    await this.db.query("insert into sor_calls (kind, idempotency_key) values ('lookup', $1)", [key]);
    const r = await this.db.query<{ provider_reference: string; after_version: string }>("select provider_reference, after_version from sor_effects where idempotency_key = $1", [key]);
    const row = r.rows[0];
    return row ? { outcome: "COMMITTED", providerReference: row.provider_reference, afterVersion: row.after_version, evidence: { replayed: true } } : { outcome: "NOT_FOUND" };
  }

  async effects(recordRef: string): Promise<number> {
    return (await this.db.query("select 1 from sor_effects where record_ref = $1", [recordRef])).rows.length;
  }

  async calls(kind: "commit" | "lookup" | "version", key?: string): Promise<number> {
    const r = key === undefined ? await this.db.query("select 1 from sor_calls where kind = $1", [kind]) : await this.db.query("select 1 from sor_calls where kind = $1 and idempotency_key = $2", [kind, key]);
    return r.rows.length;
  }
}

export interface LedgerReplica {
  service: LedgerActionService;
  db: Db;
  clock: Clock;
  auditHealth: PgAuditHealth;
}

/** One gateway replica's action service: its own pool, its own audit stream, production collaborators only. */
export function ledgerReplica(db: Db, clock: Clock, name: string, config: Partial<ActionLedgerConfig> = {}, opts: { healthCacheTtlMs?: number; logger?: Logger } = {}): LedgerReplica {
  const stream = `actions.${name}`;
  const audit = new PgAuditWriter({ db, clock, stream });
  const auditHealth = new PgAuditHealth({
    db,
    clock,
    policy: { maxBacklog: 100_000, maxBacklogAgeSeconds: 86_400 * 30 },
    probeId: `probe.${name}`,
    ...(opts.healthCacheTtlMs !== undefined ? { cacheTtlMs: opts.healthCacheTtlMs } : {}),
    ...(opts.logger ? { logger: opts.logger } : {}),
  });
  const service = new LedgerActionService({ db, clock, audit, auditHealth, outbox: new PgOutbox({ clock }), config: { auditStream: stream, ...config } });
  return { service, db, clock, auditHealth };
}

const integration = (tenantId: string, channel: IntegrationIdentity["channel"]): IntegrationIdentity => ({
  integrationId: "it-contact-center",
  tenantId,
  environment: "ci",
  channel,
  credentialId: `cred-${channel.replace(/_/g, "-")}`,
  authMethod: "oauth2_client_credentials",
});

/** A SYNTHETIC verified caller's context (A2), valid for 15 minutes from `clock`. */
export function authContext(tenantId: string, clock: Clock): AuthContext {
  const now = clock.now();
  return {
    tenantId,
    callId: newId("call"),
    sessionRef: newSessionRef(),
    sessionGeneration: 1,
    actorId: newId("act"),
    selectedRole: "client",
    subjectId: newId("sub"),
    organizationId: null,
    delegatedAuthority: [],
    permittedScopes: ["appointment:read", "appointment:write"],
    assurance: "A2",
    authenticatedAt: iso(now),
    expiresAt: iso(addMs(now, 15 * 60_000)),
    verificationMethod: "secure_link_oidc",
    consent: { recording: "GRANTED", automatedProcessing: "GRANTED", disclosureTemplateVersion: "disclosure-v1", capturedAt: iso(now), capturedBy: "studio_flow" },
    riskFlags: [],
    policyVersion: POLICY_VERSION,
    revoked: false,
    stepUp: null,
    integration: integration(tenantId, "mcp_tools"),
  };
}

export const allow = (clock: Clock): PolicyDecision => ({
  decisionId: newId("pdc"),
  allow: true,
  reasonCodes: ["ALLOW_SELF_SERVICE"],
  fieldMask: [],
  obligations: ["REQUIRE_CONFIRMATION"],
  policyVersion: POLICY_VERSION,
  evaluatedAt: iso(clock.now()),
});

export const reschedule = (recordRef: string): PrepareInput => ({
  kind: "appointment.reschedule",
  target: { system: "scheduling", recordType: "appointment", recordRef, beforeVersion: "v1" },
  change: { slotId: newId("slot") },
  impact: { summaryTemplateId: "appointment.reschedule.summary", fees: null, reversible: true },
  confirmationTemplateId: "appointment.reschedule.confirm",
  ttlSeconds: 600,
  requiresStepUp: false,
});

/** Prepares and confirms (DTMF over the telephony-control identity) one action on `recordRef`. */
export async function confirmedAction(r: LedgerReplica, tenantId: string, recordRef: string): Promise<{ ctx: AuthContext; action: PreparedAction }> {
  const ctx = authContext(tenantId, r.clock);
  const prepared = await r.service.prepare(ctx, reschedule(recordRef), allow(r.clock));
  const confirmation: ActionConfirmation = {
    actionId: prepared.actionId,
    digest: prepared.digest,
    sessionRef: ctx.sessionRef,
    sessionGeneration: prepared.sessionGeneration,
    turnId: newTurnId(),
    method: "dtmf_keypress",
    capturedBy: "studio-confirm-skill",
    capturedAt: iso(r.clock.now()),
  };
  const action = await r.service.confirm(confirmation, integration(tenantId, "telephony_control"));
  return { ctx, action };
}

export interface SorDatabase {
  sor: ReferenceSystemOfRecord;
  url: string;
  drop(): Promise<void>;
}

/** Creates the reference system's own database on the shared postgres service (dropped by `drop`). */
export async function createSorDatabase(adminUrl: (database?: string) => string): Promise<SorDatabase> {
  const name = `vsp_sor_${randomBytes(5).toString("hex")}`;
  const admin = PgPoolDb.fromConnectionString(adminUrl(), 1);
  try {
    await admin.exec(`create database ${name}`);
  } finally {
    await admin.close();
  }
  const url = adminUrl(name);
  const db = PgPoolDb.fromConnectionString(url, 6, { applicationName: "vsp-reference-sor" });
  await ReferenceSystemOfRecord.install(db);
  return {
    sor: new ReferenceSystemOfRecord(db),
    url,
    async drop() {
      await db.close().catch(() => undefined);
      const a = PgPoolDb.fromConnectionString(adminUrl(), 1);
      try {
        await a.exec(`drop database if exists ${name} with (force)`);
      } finally {
        await a.close();
      }
    },
  };
}
