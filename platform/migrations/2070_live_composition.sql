-- 2070 live composition (WP-07; follow-on FO-19-06, FO-16-11, FO-21-10; SAFE-02, SAFE-04, OPS-01).
--
-- 1. transfer_journeys: the durable transfer store of the live composition (adapters/live/pg-transfer-store.ts).
--    The regression composition keeps journeys in process memory (MemoryTransferStore, a LOCAL FIXTURE); a
--    deployed gateway runs several instances and a worker sweep, so a journey (and the one-active-journey-per-
--    call invariant) must survive the instance that started it. One row per handoff; `journey` is the whole
--    TransferJourney document (opaque ids, template ids, codes and times only; never caller content); `version`
--    is the compare-and-set key the coordinator writes with (a stale writer gets TRANSFER_VERSION_CONFLICT).
--    The transfer ids of every attempt are a column so a vendor event resolves its journey with an index.
-- 2. schema_migrations: the live composition refuses to start on a schema older than its code
--    (SCHEMA_MIGRATIONS_PENDING); the runtime, worker and console roles may read the applied list for that check.

create table transfer_journeys (
  tenant_id     text        not null check (tenant_id ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  handoff_id    text        not null check (handoff_id ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  call_id       text        not null check (call_id ~ '^[A-Za-z0-9_-]{1,96}$'),
  status        text        not null check (status ~ '^[A-Z][A-Z0-9_]{2,40}$'),
  priority      text        not null check (priority in ('SAFETY', 'STANDARD')),
  transfer_ids  text[]      not null default '{}' check (cardinality(transfer_ids) <= 64),
  version       integer     not null check (version >= 1),
  journey       jsonb       not null check (jsonb_typeof(journey) = 'object' and octet_length(journey::text) <= 65536),
  created_at    timestamptz not null,
  updated_at    timestamptz not null,
  primary key (tenant_id, handoff_id),
  check (updated_at >= created_at)
);

create index transfer_journeys_call on transfer_journeys (tenant_id, call_id, created_at);
create index transfer_journeys_active on transfer_journeys (tenant_id, status) where status = 'ROUTING';
create index transfer_journeys_transfer_ids on transfer_journeys using gin (transfer_ids);

-- The key and the creation time never change; the version only moves forward by one (compare-and-set).
create function transfer_journeys_guard() returns trigger language plpgsql as $$
begin
  if (new.tenant_id, new.handoff_id, new.call_id, new.created_at, new.priority) is distinct from (old.tenant_id, old.handoff_id, old.call_id, old.created_at, old.priority) then
    raise exception 'TRANSFER_JOURNEY_KEY_IMMUTABLE' using errcode = '42501';
  end if;
  if new.version <> old.version + 1 then
    raise exception 'TRANSFER_JOURNEY_VERSION_NOT_NEXT' using errcode = '42501';
  end if;
  return new;
end
$$;

create function transfer_journeys_no_delete() returns trigger language plpgsql as $$
begin
  raise exception 'TRANSFER_JOURNEY_APPEND_ONLY' using errcode = '42501';
end
$$;

create trigger transfer_journeys_guard before update on transfer_journeys
  for each row execute function transfer_journeys_guard();
create trigger transfer_journeys_no_delete before delete on transfer_journeys
  for each row execute function transfer_journeys_no_delete();
create trigger transfer_journeys_no_truncate before truncate on transfer_journeys
  for each statement execute function transfer_journeys_no_delete();

alter table transfer_journeys enable row level security;
alter table transfer_journeys force row level security;

-- The gateway starts and advances journeys; the worker sweep retries and closes them; the console reads them.
create policy transfer_journeys_runtime on transfer_journeys for all to app_runtime
  using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy transfer_journeys_worker on transfer_journeys for all to app_worker
  using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy transfer_journeys_console_read on transfer_journeys for select to app_console
  using (tenant_id = app_tenant());

revoke all on transfer_journeys from public;
grant select, insert on transfer_journeys to app_runtime, app_worker;
grant update (status, transfer_ids, version, journey, updated_at) on transfer_journeys to app_runtime, app_worker;
grant select on transfer_journeys to app_console;

-- Schema currency check of the live composition (read only).
grant select on schema_migrations to app_runtime, app_worker, app_console;
