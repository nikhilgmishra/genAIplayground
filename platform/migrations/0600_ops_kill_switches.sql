-- Kill switches (spec section 13): current state plus append-only history.
-- Separate switches for new AI admissions, an intent, an integration, writes,
-- a model/voice version and outbound notifications. Switches never gate the
-- approved safety and human routes (enforced in platform/src/ops).
--
-- Roles: app_console changes switches (administrative path, audited in the same
-- transaction); app_runtime / app_worker only read current state; app_auditor
-- reads history. Nobody can update, delete or truncate history (trigger), and
-- every table is tenant-scoped with forced row-level security.

create table kill_switches (
  tenant_id   text        not null,
  scope       text        not null check (scope in ('AI_ADMISSION', 'INTENT', 'INTEGRATION', 'WRITES', 'MODEL_VERSION', 'VOICE_VERSION', 'OUTBOUND_NOTIFICATIONS')),
  target      text        not null check (char_length(target) between 1 and 80),
  switch_id   text        not null unique,
  engaged     boolean     not null,
  reason      text        not null check (char_length(reason) between 3 and 300),
  changed_by  text        not null check (char_length(changed_by) between 3 and 80),
  changed_at  timestamptz not null,
  version     integer     not null check (version >= 1),
  primary key (tenant_id, scope, target),
  -- Global scopes use the "*" target; targeted scopes never do.
  constraint kill_switches_target_shape check ((scope in ('AI_ADMISSION', 'WRITES', 'OUTBOUND_NOTIFICATIONS')) = (target = '*'))
);

create table kill_switch_history (
  history_id        text        primary key,
  tenant_id         text        not null,
  switch_id         text        not null,
  scope             text        not null,
  target            text        not null,
  engaged           boolean     not null,
  previous_engaged  boolean,
  reason            text        not null,
  changed_by        text        not null,
  authorizing_role  text        not null check (authorizing_role in ('supervisor', 'security_admin', 'deployment_operator')),
  changed_at        timestamptz not null,
  version           integer     not null check (version >= 1),
  audit_event_id    text        not null,
  -- Monotonic insertion order for deterministic history listing.
  history_seq       bigint      generated always as identity,
  unique (tenant_id, scope, target, version)
);

create index kill_switch_history_tenant_time on kill_switch_history (tenant_id, changed_at);

create or replace function kill_switch_history_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'KILL_SWITCH_HISTORY_APPEND_ONLY' using errcode = '42501';
end
$$;

create trigger kill_switch_history_no_update_delete
  before update or delete on kill_switch_history
  for each row execute function kill_switch_history_append_only();

create trigger kill_switch_history_no_truncate
  before truncate on kill_switch_history
  for each statement execute function kill_switch_history_append_only();

alter table kill_switches enable row level security;
alter table kill_switches force row level security;
alter table kill_switch_history enable row level security;
alter table kill_switch_history force row level security;

create policy kill_switches_read on kill_switches for select
  to app_runtime, app_worker, app_console using (tenant_id = app_tenant());
create policy kill_switches_insert on kill_switches for insert
  to app_console with check (tenant_id = app_tenant());
create policy kill_switches_update on kill_switches for update
  to app_console using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());

create policy kill_switch_history_read on kill_switch_history for select
  to app_console, app_auditor using (tenant_id = app_tenant());
create policy kill_switch_history_insert on kill_switch_history for insert
  to app_console with check (tenant_id = app_tenant());

revoke all on kill_switches, kill_switch_history from public;
grant select on kill_switches to app_runtime, app_worker, app_console;
grant insert, update on kill_switches to app_console;
grant select on kill_switch_history to app_console, app_auditor;
grant insert on kill_switch_history to app_console;
revoke all on function kill_switch_history_append_only() from public;
