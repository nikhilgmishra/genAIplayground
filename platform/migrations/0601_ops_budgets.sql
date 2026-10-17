-- Budgets and an append-only spend ledger (spec section 12, cost controls).
-- Budgets are tracked by environment, cohort, workflow and vendor ("*" = any).
-- Money is stored as integer micro-USD (no floating point). Budget rows are
-- immutable versions: a change inserts a newer row for the same scope and period;
-- the newest row (highest created_seq) wins. Neither table can be updated, deleted or truncated.
--
-- Alerts and prepaid balances are not hard caps; these rows drive application
-- admission limits. Vendor metering delay is acknowledged per budget.

create table budgets (
  budget_id                 text        primary key,
  tenant_id                 text        not null,
  environment               text        not null check (environment in ('local', 'ci', 'sandbox', 'staging', 'production')),
  cohort                    text        not null check (cohort ~ '^(\*|[a-z0-9][a-z0-9_.@-]{0,63})$'),
  workflow                  text        not null check (workflow ~ '^(\*|[a-z0-9][a-z0-9_.@-]{0,63})$'),
  vendor                    text        not null check (vendor ~ '^(\*|[a-z0-9][a-z0-9_.@-]{0,63})$'),
  period_start              timestamptz not null,
  period_end                timestamptz not null,
  limit_micro_usd           bigint      not null check (limit_micro_usd >= 0),
  safety_reserve_micro_usd  bigint      not null check (safety_reserve_micro_usd >= 0),
  metering_delay_minutes    integer     not null check (metering_delay_minutes between 0 and 10080),
  approved_by               text        check (approved_by is null or approved_by ~ '^apr_[A-Za-z0-9_-]{8,64}$'),
  version                   text        not null check (version ~ '^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$'),
  defined_by                text        not null,
  created_at                timestamptz not null,
  -- Monotonic insertion order: deterministic "newest version wins" even when created_at ties.
  created_seq               bigint      generated always as identity,
  constraint budgets_period check (period_end > period_start),
  constraint budgets_reserve_within_limit check (safety_reserve_micro_usd <= limit_micro_usd)
);

create index budgets_scope_lookup on budgets (tenant_id, environment, period_start, period_end);

create table budget_spend (
  spend_id          text        primary key,
  tenant_id         text        not null,
  environment       text        not null check (environment in ('local', 'ci', 'sandbox', 'staging', 'production')),
  cohort            text        not null check (cohort ~ '^[a-z0-9][a-z0-9_.@-]{0,63}$'),
  workflow          text        not null check (workflow ~ '^[a-z0-9][a-z0-9_.@-]{0,63}$'),
  vendor            text        not null check (vendor ~ '^[a-z0-9][a-z0-9_.@-]{0,63}$'),
  amount_micro_usd  bigint      not null check (amount_micro_usd >= 0),
  safety            boolean     not null,
  occurred_at       timestamptz not null,
  recorded_at       timestamptz not null
);

create index budget_spend_lookup on budget_spend (tenant_id, environment, occurred_at);

create or replace function ops_ledger_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'OPS_LEDGER_APPEND_ONLY' using errcode = '42501';
end
$$;

create trigger budgets_no_update_delete before update or delete on budgets
  for each row execute function ops_ledger_append_only();
create trigger budgets_no_truncate before truncate on budgets
  for each statement execute function ops_ledger_append_only();
create trigger budget_spend_no_update_delete before update or delete on budget_spend
  for each row execute function ops_ledger_append_only();
create trigger budget_spend_no_truncate before truncate on budget_spend
  for each statement execute function ops_ledger_append_only();

alter table budgets enable row level security;
alter table budgets force row level security;
alter table budget_spend enable row level security;
alter table budget_spend force row level security;

create policy budgets_read on budgets for select
  to app_runtime, app_worker, app_console, app_auditor using (tenant_id = app_tenant());
create policy budgets_insert on budgets for insert
  to app_console with check (tenant_id = app_tenant());
create policy budget_spend_read on budget_spend for select
  to app_runtime, app_worker, app_console, app_auditor using (tenant_id = app_tenant());
create policy budget_spend_insert on budget_spend for insert
  to app_runtime, app_worker with check (tenant_id = app_tenant());

revoke all on budgets, budget_spend from public;
grant select on budgets to app_runtime, app_worker, app_console, app_auditor;
grant insert on budgets to app_console;
grant select on budget_spend to app_runtime, app_worker, app_console, app_auditor;
grant insert on budget_spend to app_runtime, app_worker;
revoke all on function ops_ledger_append_only() from public;
