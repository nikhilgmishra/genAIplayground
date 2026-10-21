-- 2040 durable route-audit journal (WP-04; follow-on FO-01-19, FO-01-34, FO-15-45, FO-15-48, FO-22-08;
-- OPS-01, OPS-02, SAFE-03). Replaces the process-local deferral of ROUTE audit evidence (the audit
-- events of human and safety handoffs, which proceed during an audit outage) with rows that survive
-- a process crash, plus the reconciliation records that turn a route with no audit evidence into an
-- explicit audit.route.not_recorded marker.
--
-- Tables
--   audit_deferred                 route audit events that could not be appended to audit_outbox when they
--                                  happened; flushed into the chain in journal order, exactly once (the
--                                  flush appends the event and marks the row in ONE transaction).
--   route_audit_intents            a route that has started and must leave audit evidence by deadline_at
--                                  (open at handoff start; resolved when the event or its deferral is written).
--   route_audit_reconciliations    one row per safety incident or route intent the reconciler examined,
--                                  with the marker event it wrote (NOT_RECORDED) or EVIDENCED.
--
-- Content-free by construction: every column is an opaque id, a closed-set code, a digest, a count or a
-- time; event_input holds a schema-validated AuditEventInput (opaque references and codes only).
--
-- Roles: app_runtime and app_console insert deferrals and intents for their tenant and resolve them;
-- app_worker flushes and reconciles. Nobody can delete or truncate, change a deferral's content, or move
-- a row out of a terminal state (triggers).

create table audit_deferred (
  deferral_id       text        primary key check (deferral_id ~ '^dfr_[A-Za-z0-9_-]{16,64}$'),
  journal_seq       bigint      generated always as identity unique,
  tenant_id         text        not null check (tenant_id ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  source_stream     text        check (source_stream is null or source_stream ~ '^[a-z0-9_.-]{3,64}$'),
  action            text        not null check (action ~ '^[a-z][a-z0-9_.]{2,80}$'),
  correlation_id    text        not null check (correlation_id ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  call_id           text        check (call_id is null or call_id ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  event_input       jsonb       not null,
  input_digest      text        not null check (input_digest ~ '^[a-f0-9]{64}$'),
  reason_code       text        not null check (reason_code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  -- Where the deferral was first journaled: this table, or the independent journal (DynamoDB) it was drained from.
  journal           text        not null check (journal in ('postgres', 'dynamodb')),
  deferred_at       timestamptz not null,
  status            text        not null check (status in ('PENDING', 'RECORDED', 'DROPPED')),
  attempts          integer     not null default 0 check (attempts between 0 and 1000000),
  last_error_code   text        check (last_error_code is null or last_error_code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  recorded_event_id text        check (recorded_event_id is null or recorded_event_id ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  marker_event_id   text        check (marker_event_id is null or marker_event_id ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  recorded_at       timestamptz,
  drop_reason       text        check (drop_reason is null or drop_reason ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  check (event_input ->> 'tenantId' = tenant_id and event_input ->> 'action' = action and event_input ->> 'correlationId' = correlation_id
         and (event_input ->> 'callId') is not distinct from call_id),
  check ((status = 'RECORDED') = (recorded_event_id is not null and recorded_at is not null)),
  check ((status = 'DROPPED') = (drop_reason is not null)),
  check (marker_event_id is null or status = 'RECORDED')
);

create index audit_deferred_pending_idx on audit_deferred (tenant_id, journal_seq) where status = 'PENDING';
create index audit_deferred_correlation_idx on audit_deferred (tenant_id, correlation_id);
create index audit_deferred_call_idx on audit_deferred (tenant_id, call_id) where call_id is not null;

create table route_audit_intents (
  intent_id         text        primary key check (intent_id ~ '^rai_[A-Za-z0-9_-]{16,64}$'),
  tenant_id         text        not null check (tenant_id ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  route_kind        text        not null check (route_kind in ('HUMAN_TRANSFER', 'SAFETY_ROUTE')),
  correlation_id    text        not null check (correlation_id ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  call_id           text        not null check (call_id ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  safety_incident_id text       check (safety_incident_id is null or safety_incident_id ~ '^sin_[A-Za-z0-9_-]{16,64}$'),
  opened_at         timestamptz not null,
  deadline_at       timestamptz not null,
  status            text        not null check (status in ('OPEN', 'RECORDED', 'NOT_RECORDED')),
  resolved_event_id text        check (resolved_event_id is null or resolved_event_id ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  resolved_deferral_id text     check (resolved_deferral_id is null or resolved_deferral_id ~ '^dfr_[A-Za-z0-9_-]{16,64}$'),
  resolved_at       timestamptz,
  check (deadline_at > opened_at),
  check ((status = 'OPEN') = (resolved_at is null)),
  check (status <> 'NOT_RECORDED' or resolved_event_id is not null),
  check (status <> 'RECORDED' or resolved_event_id is not null or resolved_deferral_id is not null),
  unique (tenant_id, route_kind, correlation_id)
);

create index route_audit_intents_open_idx on route_audit_intents (tenant_id, deadline_at) where status = 'OPEN';

create table route_audit_reconciliations (
  reconciliation_id text        primary key check (reconciliation_id ~ '^rar_[A-Za-z0-9_-]{16,64}$'),
  tenant_id         text        not null check (tenant_id ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  subject_kind      text        not null check (subject_kind in ('SAFETY_INCIDENT', 'ROUTE_INTENT')),
  subject_id        text        not null check (subject_id ~ '^(sin|rai)_[A-Za-z0-9_-]{16,64}$'),
  call_id           text        not null check (call_id ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  result            text        not null check (result in ('EVIDENCED', 'NOT_RECORDED')),
  -- Audit events this reconciliation relies on (EVIDENCED) or wrote (NOT_RECORDED, the marker).
  audit_event_id    text        check (audit_event_id is null or audit_event_id ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  unaudited_safety_event_ids text[] not null default '{}' check (cardinality(unaudited_safety_event_ids) <= 32),
  reconciled_at     timestamptz not null,
  check (result <> 'NOT_RECORDED' or audit_event_id is not null),
  unique (tenant_id, subject_kind, subject_id)
);

-- ---------------------------------------------------------------------------
-- Integrity triggers
-- ---------------------------------------------------------------------------

create function audit_deferred_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.status = 'DROPPED' then
      raise exception 'AUDIT_DEFERRED_INVALID_START' using errcode = '42501';
    end if;
    return new;
  end if;
  if (new.deferral_id, new.journal_seq, new.tenant_id, new.source_stream, new.action, new.correlation_id, new.call_id,
      new.event_input, new.input_digest, new.reason_code, new.journal, new.deferred_at)
     is distinct from
     (old.deferral_id, old.journal_seq, old.tenant_id, old.source_stream, old.action, old.correlation_id, old.call_id,
      old.event_input, old.input_digest, old.reason_code, old.journal, old.deferred_at) then
    raise exception 'AUDIT_DEFERRED_IMMUTABLE' using errcode = '42501';
  end if;
  if old.status <> 'PENDING' then
    raise exception 'AUDIT_DEFERRED_TERMINAL' using errcode = '42501';
  end if;
  return new;
end
$$;

create function route_audit_intents_guard() returns trigger language plpgsql as $$
begin
  if (new.intent_id, new.tenant_id, new.route_kind, new.correlation_id, new.call_id, new.safety_incident_id, new.opened_at, new.deadline_at)
     is distinct from
     (old.intent_id, old.tenant_id, old.route_kind, old.correlation_id, old.call_id, old.safety_incident_id, old.opened_at, old.deadline_at) then
    raise exception 'ROUTE_AUDIT_INTENT_IMMUTABLE' using errcode = '42501';
  end if;
  if old.status <> 'OPEN' then
    raise exception 'ROUTE_AUDIT_INTENT_TERMINAL' using errcode = '42501';
  end if;
  return new;
end
$$;

create function route_audit_reject_change() returns trigger language plpgsql as $$
begin
  raise exception 'ROUTE_AUDIT_APPEND_ONLY' using errcode = '42501';
end
$$;

create trigger audit_deferred_guard before insert or update on audit_deferred
  for each row execute function audit_deferred_guard();
create trigger audit_deferred_no_delete before delete on audit_deferred
  for each row execute function route_audit_reject_change();
create trigger audit_deferred_no_truncate before truncate on audit_deferred
  for each statement execute function route_audit_reject_change();
create trigger route_audit_intents_guard before update on route_audit_intents
  for each row execute function route_audit_intents_guard();
create trigger route_audit_intents_no_delete before delete on route_audit_intents
  for each row execute function route_audit_reject_change();
create trigger route_audit_intents_no_truncate before truncate on route_audit_intents
  for each statement execute function route_audit_reject_change();
create trigger route_audit_reconciliations_no_change before update or delete on route_audit_reconciliations
  for each row execute function route_audit_reject_change();
create trigger route_audit_reconciliations_no_truncate before truncate on route_audit_reconciliations
  for each statement execute function route_audit_reject_change();

-- ---------------------------------------------------------------------------
-- Row-level security and grants
-- ---------------------------------------------------------------------------

alter table audit_deferred enable row level security;
alter table audit_deferred force row level security;
alter table route_audit_intents enable row level security;
alter table route_audit_intents force row level security;
alter table route_audit_reconciliations enable row level security;
alter table route_audit_reconciliations force row level security;

create policy audit_deferred_tenant on audit_deferred for all
  to app_runtime, app_console, app_worker
  using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy route_audit_intents_tenant on route_audit_intents for all
  to app_runtime, app_console, app_worker
  using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy route_audit_reconciliations_worker on route_audit_reconciliations for all
  to app_worker
  using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy route_audit_reconciliations_read on route_audit_reconciliations for select
  to app_console, app_auditor
  using (tenant_id = app_tenant());

revoke all on audit_deferred, route_audit_intents, route_audit_reconciliations from public;
grant select, insert on audit_deferred to app_runtime, app_console, app_worker;
grant update (status, attempts, last_error_code, recorded_event_id, marker_event_id, recorded_at, drop_reason)
  on audit_deferred to app_runtime, app_console, app_worker;
grant select, insert on route_audit_intents to app_runtime, app_console, app_worker;
grant update (status, resolved_event_id, resolved_deferral_id, resolved_at) on route_audit_intents to app_runtime, app_console, app_worker;
grant select, insert on route_audit_reconciliations to app_worker;
grant select on route_audit_reconciliations to app_console, app_auditor;
revoke all on function audit_deferred_guard(), route_audit_intents_guard(), route_audit_reject_change() from public;
