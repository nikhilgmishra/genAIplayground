/**
 * PostgreSQL store of the reference business API (WP-23). The service owns its own database (never the
 * platform's): records of the emulated systems of record, the change-request ledger that backs idempotency,
 * lookup-by-key and receipts, and an append-only effect log, so "exactly one effect" is a database fact.
 *
 * Every table is keyed by account (one tenant's system-of-record instance); no query crosses accounts.
 */
import pg from "pg";
import type { PoolClient, QueryResultRow } from "pg";
import type { ServiceConfig } from "./config.js";

export const SCHEMA_VERSION = 3;

// DATE columns are calendar dates, never instants: keep the database's YYYY-MM-DD text (no local-time shift).
pg.types.setTypeParser(1082, (v: string) => v);

/** Idempotent DDL, applied under an advisory lock at start-up. */
export const SCHEMA_SQL = `
create schema if not exists refbiz;

create table if not exists refbiz.schema_version (version integer primary key, applied_at timestamptz not null default now());

create table if not exists refbiz.accounts (
  account_id text primary key,
  region text not null,
  dialect text not null check (dialect in ('canonical', 'legacy_codes')),
  time_zone text not null,
  visibility_window_ms integer not null check (visibility_window_ms between 0 and 600000),
  lookup_lag_ms integer not null check (lookup_lag_ms >= 0 and lookup_lag_ms <= visibility_window_ms),
  created_at timestamptz not null default now()
);

create table if not exists refbiz.clients (
  client_id text primary key,
  account_id text not null references refbiz.accounts (account_id),
  secret_sha256 text not null,
  scopes text[] not null,
  created_at timestamptz not null default now()
);

create table if not exists refbiz.tokens (
  token_sha256 text primary key,
  client_id text not null references refbiz.clients (client_id),
  account_id text not null references refbiz.accounts (account_id),
  scopes text[] not null,
  expires_at timestamptz not null
);

create table if not exists refbiz.subjects (
  account_id text not null references refbiz.accounts (account_id),
  subject_id text not null,
  primary key (account_id, subject_id)
);

create table if not exists refbiz.providers (
  account_id text not null references refbiz.accounts (account_id),
  provider_id text not null,
  display_name text not null,
  practice_id text,
  primary key (account_id, provider_id)
);

create table if not exists refbiz.slots (
  account_id text not null,
  slot_id text not null,
  provider_id text not null,
  starts_at timestamptz not null,
  time_zone text not null,
  modality text not null check (modality in ('video', 'in_person', 'phone')),
  state text not null check (state in ('OPEN', 'BOOKED', 'BLOCKED')),
  version integer not null check (version >= 1),
  primary key (account_id, slot_id),
  foreign key (account_id, provider_id) references refbiz.providers (account_id, provider_id)
);

create table if not exists refbiz.appointments (
  account_id text not null,
  appointment_id text not null,
  subject_id text not null,
  provider_id text not null,
  slot_id text,
  starts_at timestamptz not null,
  time_zone text not null,
  modality text not null check (modality in ('video', 'in_person', 'phone')),
  status text not null check (status in ('SCHEDULED', 'CANCELLED', 'COMPLETED')),
  version integer not null check (version >= 1),
  visit_reason text,
  external_ref text,
  visible_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (account_id, appointment_id),
  foreign key (account_id, subject_id) references refbiz.subjects (account_id, subject_id),
  foreign key (account_id, provider_id) references refbiz.providers (account_id, provider_id)
);
create index if not exists appointments_by_subject on refbiz.appointments (account_id, subject_id, starts_at);
create index if not exists appointments_by_external_ref on refbiz.appointments (account_id, external_ref) where external_ref is not null;

create table if not exists refbiz.invoices (
  account_id text not null,
  invoice_id text not null,
  subject_id text not null,
  issued_on date not null,
  due_on date not null,
  status text not null check (status in ('OPEN', 'PAID', 'IN_REVIEW', 'VOID')),
  balance_minor bigint not null,
  currency text not null check (currency = 'USD'),
  version integer not null check (version >= 1),
  primary key (account_id, invoice_id),
  foreign key (account_id, subject_id) references refbiz.subjects (account_id, subject_id)
);

create table if not exists refbiz.invoice_lines (
  account_id text not null,
  invoice_id text not null,
  line_id text not null,
  code text not null check (code in ('SESSION_FEE', 'LATE_CANCELLATION', 'NO_SHOW', 'ADJUSTMENT', 'PAYMENT')),
  service_date date not null,
  amount_minor bigint not null,
  primary key (account_id, invoice_id, line_id),
  foreign key (account_id, invoice_id) references refbiz.invoices (account_id, invoice_id)
);

create table if not exists refbiz.payments (
  account_id text not null,
  payment_id text not null,
  invoice_id text not null,
  amount_minor bigint not null check (amount_minor > 0),
  received_at timestamptz not null,
  method_code text not null check (method_code in ('CARD', 'ACH', 'CHECK', 'PORTAL')),
  card_last4 text,
  primary key (account_id, payment_id),
  foreign key (account_id, invoice_id) references refbiz.invoices (account_id, invoice_id)
);

create table if not exists refbiz.billing_reviews (
  account_id text not null,
  review_id text not null,
  invoice_id text not null,
  key_ref text not null,
  reason_code text not null,
  created_at timestamptz not null default now(),
  primary key (account_id, review_id)
);

create table if not exists refbiz.claims (
  account_id text not null,
  claim_id text not null,
  subject_id text not null,
  service_date date not null,
  payer_display_name text not null,
  insurer_status text not null check (insurer_status in ('RECEIVED', 'IN_PROCESS', 'ADJUDICATED_PAID', 'ADJUDICATED_DENIED', 'NEEDS_INFORMATION')),
  status_as_of timestamptz not null,
  diagnosis_codes text,
  primary key (account_id, claim_id),
  foreign key (account_id, subject_id) references refbiz.subjects (account_id, subject_id)
);

create table if not exists refbiz.onboarding (
  account_id text not null,
  provider_id text not null,
  stage text not null check (stage in ('APPLICATION_RECEIVED', 'DOCUMENTS_PENDING', 'CREDENTIALING_IN_REVIEW', 'CONTRACTING', 'ACTIVE', 'ON_HOLD')),
  as_of timestamptz not null,
  organization_id text,
  primary key (account_id, provider_id),
  foreign key (account_id, provider_id) references refbiz.providers (account_id, provider_id)
);

create table if not exists refbiz.onboarding_documents (
  account_id text not null,
  provider_id text not null,
  document_type text not null check (document_type in ('LICENSE', 'MALPRACTICE_INSURANCE', 'W9', 'DEA', 'BOARD_CERTIFICATION')),
  status text not null check (status in ('RECEIVED', 'MISSING', 'EXPIRED', 'IN_REVIEW', 'ACCEPTED')),
  updated_at timestamptz not null,
  primary key (account_id, provider_id, document_type)
);

create table if not exists refbiz.remittances (
  account_id text not null,
  remittance_id text not null,
  practice_id text not null,
  period_start date not null,
  period_end date not null,
  total_minor bigint not null,
  status text not null check (status in ('SCHEDULED', 'SENT', 'RETURNED')),
  paid_on date,
  bank_account_last4 text,
  primary key (account_id, remittance_id)
);

create table if not exists refbiz.referrals (
  account_id text not null,
  referral_id text not null,
  subject_id text not null,
  specialty_code text not null,
  status text not null check (status in ('RECEIVED', 'IN_REVIEW', 'ACCEPTED', 'DECLINED', 'SCHEDULED', 'CLOSED')),
  status_as_of timestamptz not null,
  received_on date not null,
  referring_organization_id text,
  clinical_summary text,
  primary key (account_id, referral_id),
  foreign key (account_id, subject_id) references refbiz.subjects (account_id, subject_id)
);

create table if not exists refbiz.authorizations (
  account_id text not null,
  authorization_id text not null,
  subject_id text not null,
  payer_display_name text not null,
  service_code text not null,
  status text not null check (status in ('PENDING', 'APPROVED', 'DENIED', 'EXPIRED')),
  units_approved integer,
  units_used integer,
  valid_from date,
  valid_to date,
  status_as_of timestamptz not null,
  primary key (account_id, authorization_id),
  foreign key (account_id, subject_id) references refbiz.subjects (account_id, subject_id)
);

create table if not exists refbiz.eligibility (
  account_id text not null,
  subject_id text not null,
  payer_display_name text not null,
  coverage_status text not null check (coverage_status in ('ACTIVE', 'INACTIVE', 'NOT_FOUND_AT_PAYER')),
  verified_at timestamptz not null,
  member_reference text,
  primary key (account_id, subject_id),
  foreign key (account_id, subject_id) references refbiz.subjects (account_id, subject_id)
);

-- The change-request ledger: one row per client-chosen request id (key_ref). Backs idempotent replay,
-- lookup-by-key (visible from visible_at: the documented visibility window), completion of an incomplete
-- multi-step write, and receipts.
create table if not exists refbiz.change_requests (
  account_id text not null,
  key_ref text not null,
  operation text not null,
  request_digest text not null,
  state text not null check (state in ('APPLIED', 'COMPLETED', 'FAILED')),
  resource_type text,
  resource_id text,
  before_version text,
  after_version text,
  failure_status integer,
  failure_code text,
  receipt_id text,
  response jsonb,
  received_at timestamptz not null,
  applied_at timestamptz,
  completed_at timestamptz,
  visible_at timestamptz not null,
  primary key (account_id, key_ref)
);
-- Version 2: the client's dispatch deadline (notAfter). A request is applied only if the deadline check, the last
-- statement of its step-1 transaction, passes; after it the request is REJECTED with DEADLINE_EXCEEDED.
alter table refbiz.change_requests add column if not exists not_after timestamptz;

-- Version 3: fences. A change request can be FENCED by its client once its dispatch deadline has passed (routes-changes.ts):
-- the row is then FAILED with failure_code FENCED, so no delivery of that request id can ever be applied (absence
-- becomes definitive at the system, not by a clock). The legacy product's references (routes-legacy.ts): a reference
-- is RESERVED by one dispatch (its dispatch id) before the create, POSTED by the create, or FENCED after the client's
-- deadline (a later create under it is refused).
create table if not exists refbiz.legacy_references (
  account_id text not null references refbiz.accounts (account_id),
  external_ref text not null,
  state text not null check (state in ('RESERVED', 'POSTED', 'FENCED')),
  dispatch_id text,
  not_after timestamptz,
  reserved_at timestamptz,
  posted_at timestamptz,
  fenced_at timestamptz,
  primary key (account_id, external_ref)
);

create table if not exists refbiz.receipts (
  account_id text not null,
  receipt_id text not null,
  key_ref text not null,
  operation text not null,
  resource_type text not null,
  resource_id text not null,
  resource_version text not null,
  state_digest text not null,
  committed_at timestamptz not null,
  primary key (account_id, receipt_id)
);

-- Append-only effect log: every applied change, keyed or not (the legacy endpoint has no key).
create table if not exists refbiz.effects (
  seq bigserial primary key,
  account_id text not null,
  key_ref text,
  operation text not null,
  resource_type text not null,
  resource_id text not null,
  before_version text,
  after_version text not null,
  at timestamptz not null default now()
);
create index if not exists effects_by_resource on refbiz.effects (account_id, resource_id);

create or replace function refbiz.effects_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'EFFECT_LOG_APPEND_ONLY';
end $$;
drop trigger if exists effects_append_only on refbiz.effects;
create trigger effects_append_only before update or delete on refbiz.effects for each row execute function refbiz.effects_append_only();
`;

export type Tx = PoolClient;

export class Store {
  constructor(readonly pool: pg.Pool) {}

  static async connect(cfg: ServiceConfig["database"]): Promise<Store> {
    const base = { host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, ssl: cfg.ssl ? { rejectUnauthorized: true } : false, application_name: "reference-business-api" };
    if (cfg.create) {
      const admin = new pg.Client({ ...base, database: "postgres" });
      await admin.connect();
      try {
        const r = await admin.query("select 1 from pg_database where datname = $1", [cfg.name]);
        // The name is validated by the configuration grammar ([a-z_][a-z0-9_]*): safe as an identifier.
        if (r.rowCount === 0) await admin.query(`create database ${cfg.name}`).catch((e: unknown) => {
          if ((e as { code?: string }).code !== "42P04") throw e;
        });
      } finally {
        await admin.end();
      }
    }
    const pool = new pg.Pool({ ...base, database: cfg.name, max: 20, idleTimeoutMillis: 30_000, statement_timeout: 15_000 });
    const store = new Store(pool);
    await store.migrate();
    return store;
  }

  private async migrate(): Promise<void> {
    const c = await this.pool.connect();
    try {
      await c.query("select pg_advisory_lock(hashtext('refbiz.schema'))");
      try {
        await c.query(SCHEMA_SQL);
        await c.query("insert into refbiz.schema_version (version) values ($1) on conflict do nothing", [SCHEMA_VERSION]);
      } finally {
        await c.query("select pg_advisory_unlock(hashtext('refbiz.schema'))");
      }
    } finally {
      c.release();
    }
  }

  async query<T extends QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await this.pool.query<T>(sql, params)).rows;
  }

  /** Runs `fn` in one READ COMMITTED transaction; row locks (`for update`) serialize writers per record. */
  async tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query("begin");
      const out = await fn(c);
      await c.query("commit");
      return out;
    } catch (e) {
      await c.query("rollback").catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
