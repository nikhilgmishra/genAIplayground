-- 2060 connector checkpoints (WP-06; follow-on FO-06-09; ACT-02, OPS-03).
--
-- One row per (tenant, connector profile, stream): the position an incremental reader has durably
-- processed. The reader commits the checkpoint in the SAME transaction as the records it projected, so
-- after a crash it resumes from the last committed page: no gap (nothing is skipped) and no duplicate
-- projection (a page is either projected and checkpointed, or neither).
--   cursor            vendor continuation cursor / page token / change-log position (opaque, bounded)
--   replay_id         vendor replay id of the last processed event, when the stream has one
--   watermark         newest source update time among processed records (source-quality watermark)
--   position_digest   sha256 over (cursor, replay_id, watermark, records_committed): compare-and-set key, so
--                     two readers of one stream cannot both advance from the same position
--   mapping_digest    compiled mapping the records went through (pins the reviewed mapping)
-- Content: codes, counts, digests, times and the vendor's opaque cursor; never record values.

create table connector_checkpoints (
  tenant_id          text        not null check (tenant_id ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  profile_id         text        not null check (profile_id ~ '^cnp_[A-Za-z0-9_-]{16,64}$'),
  stream_id          text        not null check (stream_id ~ '^[a-z][a-z0-9_]{1,40}$'),
  cursor             text        check (cursor is null or (length(cursor) between 1 and 2048 and cursor !~ '[[:cntrl:]]')),
  replay_id          text        check (replay_id is null or replay_id ~ '^[A-Za-z0-9:._/=+-]{1,255}$'),
  watermark          timestamptz,
  position_digest    text        not null check (position_digest ~ '^[a-f0-9]{64}$'),
  records_committed  bigint      not null default 0 check (records_committed >= 0),
  pages_committed    bigint      not null default 0 check (pages_committed >= 0),
  mapping_digest     text        check (mapping_digest is null or mapping_digest ~ '^[a-f0-9]{64}$'),
  run_id             text        not null check (run_id ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  created_at         timestamptz not null,
  updated_at         timestamptz not null,
  primary key (tenant_id, profile_id, stream_id),
  check (updated_at >= created_at)
);

-- A checkpoint never moves backwards: counters and the watermark are monotonic, the key never changes.
create function connector_checkpoints_guard() returns trigger language plpgsql as $$
begin
  if (new.tenant_id, new.profile_id, new.stream_id, new.created_at) is distinct from (old.tenant_id, old.profile_id, old.stream_id, old.created_at) then
    raise exception 'CONNECTOR_CHECKPOINT_KEY_IMMUTABLE' using errcode = '42501';
  end if;
  if new.records_committed < old.records_committed or new.pages_committed < old.pages_committed then
    raise exception 'CONNECTOR_CHECKPOINT_REGRESSION' using errcode = '42501';
  end if;
  if old.watermark is not null and (new.watermark is null or new.watermark < old.watermark) then
    raise exception 'CONNECTOR_CHECKPOINT_WATERMARK_REGRESSION' using errcode = '42501';
  end if;
  return new;
end
$$;

create function connector_checkpoints_no_delete() returns trigger language plpgsql as $$
begin
  raise exception 'CONNECTOR_CHECKPOINT_APPEND_ONLY' using errcode = '42501';
end
$$;

create trigger connector_checkpoints_guard before update on connector_checkpoints
  for each row execute function connector_checkpoints_guard();
create trigger connector_checkpoints_no_delete before delete on connector_checkpoints
  for each row execute function connector_checkpoints_no_delete();
create trigger connector_checkpoints_no_truncate before truncate on connector_checkpoints
  for each statement execute function connector_checkpoints_no_delete();

alter table connector_checkpoints enable row level security;
alter table connector_checkpoints force row level security;

-- The incremental readers run in the worker; operators read positions (lag, watermark) in the console.
create policy connector_checkpoints_worker on connector_checkpoints for all to app_worker
  using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy connector_checkpoints_console_read on connector_checkpoints for select to app_console
  using (tenant_id = app_tenant());

revoke all on connector_checkpoints from public;
grant select, insert on connector_checkpoints to app_worker;
grant update (cursor, replay_id, watermark, position_digest, records_committed, pages_committed, mapping_digest, run_id, updated_at)
  on connector_checkpoints to app_worker;
grant select on connector_checkpoints to app_console;
