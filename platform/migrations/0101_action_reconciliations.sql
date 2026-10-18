-- Durable reconciliation records for the action ledger (spec section 8: "Reconcile UNKNOWN by the
-- provider's idempotency key or authoritative state before any retry"; ACT-03, OPS-01).
--
-- Every reconciliation of an in-doubt action (worker sweep, the commit path's reconcile-first
-- step, or an operator flow) appends one row in the SAME transaction as the ledger transition it
-- caused: the lookup result (COMMITTED / NOT_FOUND / UNKNOWN), the ledger state and row version
-- right after it, the receipt id when committed and the audit event id. A staff-initiated retry
-- (LedgerActionService.retryAfterReconcile) is allowed only against the LATEST record of an action
-- whose result is NOT_FOUND, while the ledger row is still at exactly the recorded version; the
-- record is consumed (single use) in the same transaction that claims the commit.
--
-- Content rules (DATA-01): opaque ids, closed-set codes, counts and timestamps only.

create table action_reconciliations (
  reconciliation_id   text        primary key check (reconciliation_id ~ '^rcn_[A-Za-z0-9_-]{16,64}$'),
  tenant_id           text        not null check (tenant_id ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  action_id           text        not null references action_ledger (action_id),
  seq                 integer     not null check (seq >= 1),
  trigger             text        not null check (trigger in ('RECONCILE', 'COMMIT_RETRY', 'RECONCILE_WITH_RESULT')),
  lookup_performed    boolean     not null,
  result              text        not null check (result in ('COMMITTED', 'NOT_FOUND', 'UNKNOWN')),
  ledger_state_after  text        not null check (ledger_state_after in (
                                    'PREPARED', 'CONFIRMED', 'COMMITTING', 'COMMITTED', 'FAILED',
                                    'UNKNOWN', 'INVALIDATED', 'EXPIRED', 'CANCELLED')),
  ledger_row_version  integer     not null check (ledger_row_version >= 1),
  receipt_id          text        null check (receipt_id is null or receipt_id ~ '^rcp_[A-Za-z0-9_-]{16,64}$'),
  audit_event_id      text        null check (audit_event_id is null or audit_event_id ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  reconciled_at       timestamptz not null,
  -- Single-use consumption by a staff-initiated retry (never for COMMITTED or UNKNOWN results).
  retry_consumed_at   timestamptz null,
  retry_consumed_by   text        null check (retry_consumed_by is null or retry_consumed_by ~ '^stf_[A-Za-z0-9_-]{8,64}$'),
  retry_reason        text        null check (retry_reason is null or (retry_reason ~ '^[A-Z][A-Z0-9_]{2,63}$' and retry_reason !~ '[0-9]{4,}')),
  constraint action_reconciliations_seq_unique unique (action_id, seq),
  constraint action_reconciliations_committed_receipt check ((result = 'COMMITTED') = (receipt_id is not null)),
  constraint action_reconciliations_consumption_shape check (
    (retry_consumed_at is null) = (retry_consumed_by is null) and (retry_consumed_at is null) = (retry_reason is null)),
  constraint action_reconciliations_retry_only_not_found check (retry_consumed_at is null or result = 'NOT_FOUND')
);
create index action_reconciliations_latest on action_reconciliations (tenant_id, action_id, seq desc);

-- Append-only evidence; the only permitted change is the one-time retry consumption.
create or replace function action_reconciliations_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'ACTION_RECONCILIATION_APPEND_ONLY' using errcode = '42501';
  end if;
  if new.reconciliation_id is distinct from old.reconciliation_id or new.tenant_id is distinct from old.tenant_id
     or new.action_id is distinct from old.action_id or new.seq is distinct from old.seq or new.trigger is distinct from old.trigger
     or new.lookup_performed is distinct from old.lookup_performed or new.result is distinct from old.result
     or new.ledger_state_after is distinct from old.ledger_state_after or new.ledger_row_version is distinct from old.ledger_row_version
     or new.receipt_id is distinct from old.receipt_id or new.audit_event_id is distinct from old.audit_event_id
     or new.reconciled_at is distinct from old.reconciled_at then
    raise exception 'ACTION_RECONCILIATION_IMMUTABLE_FIELD' using errcode = '42501';
  end if;
  if old.retry_consumed_at is not null then
    raise exception 'ACTION_RECONCILIATION_ALREADY_CONSUMED' using errcode = '42501';
  end if;
  return new;
end
$$;

create trigger action_reconciliations_guard
  before update or delete on action_reconciliations
  for each row execute function action_reconciliations_guard();

create or replace function action_reconciliations_no_truncate() returns trigger language plpgsql as
$$ begin raise exception 'ACTION_RECONCILIATION_APPEND_ONLY' using errcode = '42501'; end $$;
create trigger action_reconciliations_no_truncate
  before truncate on action_reconciliations
  for each statement execute function action_reconciliations_no_truncate();

alter table action_reconciliations enable row level security;
alter table action_reconciliations force row level security;

create policy action_reconciliations_runtime_tenant on action_reconciliations for all to app_runtime
  using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy action_reconciliations_worker_tenant on action_reconciliations for all to app_worker
  using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy action_reconciliations_console_read on action_reconciliations for select to app_console
  using (tenant_id = app_tenant());

revoke all on action_reconciliations from public;
-- The runtime reconciles on the commit path; the worker sweeps and performs staff retries.
grant select, insert on action_reconciliations to app_runtime, app_worker;
grant update (retry_consumed_at, retry_consumed_by, retry_reason) on action_reconciliations to app_worker;
-- Content-free operator view of reconciliation history.
grant select on action_reconciliations to app_console;
