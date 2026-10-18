-- 0201 audit evidence: local durable audit outbox, per-stream hash chain, shipped
-- manifest records and append-only enforcement (spec section 13, OPS-01, DATA-01).
--
-- Privilege model
--   app_runtime / app_console / app_worker : INSERT audit events (tenant-checked by RLS)
--                                            and advance chain heads (trigger-checked).
--   app_worker (shipper / verifier)        : read all streams, set shipped_at + manifest_id
--                                            exactly once, record manifests, call the purge
--                                            function for rows already shipped AND verified.
--   app_auditor / app_console               : SELECT on the tenant-filtered metadata view only.
--   Nobody                                  : UPDATE event content, DELETE outside the purge
--                                            function, TRUNCATE.
-- A database superuser can still disable triggers. That is exactly why the
-- independent S3 Object Lock copy (audit account) and the hash chain exist: the
-- IntegrityVerifier detects local rewrites, deletions and truncation.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table audit_chain_heads (
  source_stream text primary key check (source_stream ~ '^[a-z0-9_.-]{3,64}$'),
  last_sequence bigint not null default 0 check (last_sequence >= 0),
  last_hash text check (last_hash ~ '^[a-f0-9]{64}$'),
  updated_at timestamptz not null,
  check ((last_sequence = 0) = (last_hash is null))
);

create table audit_manifests (
  manifest_id text primary key check (manifest_id ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  source_stream text not null references audit_chain_heads (source_stream),
  first_sequence bigint not null check (first_sequence >= 1),
  last_sequence bigint not null,
  event_count integer not null check (event_count >= 1),
  first_prev_hash text check (first_prev_hash ~ '^[a-f0-9]{64}$'),
  last_hash text not null check (last_hash ~ '^[a-f0-9]{64}$'),
  batch_digest text not null check (batch_digest ~ '^[a-f0-9]{64}$'),
  object_key text not null unique check (length(object_key) between 3 and 256),
  manifest jsonb not null,
  sink_kind text not null check (sink_kind in ('local_fixture', 'live')),
  status text not null check (status in ('PLANNED', 'SHIPPED')),
  planned_at timestamptz not null,
  shipped_at timestamptz,
  verified_at timestamptz,
  check (last_sequence >= first_sequence),
  check (event_count = last_sequence - first_sequence + 1),
  check ((first_sequence = 1) = (first_prev_hash is null)),
  check ((status = 'SHIPPED') = (shipped_at is not null)),
  check (verified_at is null or status = 'SHIPPED'),
  check (manifest ->> 'manifestId' = manifest_id and manifest ->> 'batchDigest' = batch_digest
         and manifest ->> 'objectKey' = object_key and manifest ->> 'sourceStream' = source_stream),
  unique (source_stream, first_sequence)
);

create table audit_outbox (
  event_id text primary key check (event_id ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  tenant_id text not null,
  source_stream text not null references audit_chain_heads (source_stream),
  sequence bigint not null check (sequence >= 1),
  prev_hash text check (prev_hash ~ '^[a-f0-9]{64}$'),
  hash text not null check (hash ~ '^[a-f0-9]{64}$'),
  event jsonb not null,
  occurred_at timestamptz not null,
  recorded_at timestamptz not null,
  correlation_id text not null,
  call_id text,
  action text not null,
  outcome text not null,
  data_class text not null,
  shipped_at timestamptz,
  manifest_id text references audit_manifests (manifest_id),
  unique (source_stream, sequence),
  check ((sequence = 1) = (prev_hash is null)),
  check ((shipped_at is null) = (manifest_id is null)),
  -- Indexed columns must mirror the hashed event document.
  check (
    event ->> 'eventId' = event_id
    and event ->> 'tenantId' = tenant_id
    and event ->> 'sourceStream' = source_stream
    and (event ->> 'sequence')::bigint = sequence
    and (event ->> 'prevHash') is not distinct from prev_hash
    and event ->> 'hash' = hash
    and event ->> 'correlationId' = correlation_id
    and (event ->> 'callId') is not distinct from call_id
    and event ->> 'action' = action
    and event ->> 'outcome' = outcome
    and event ->> 'dataClass' = data_class
  )
);

create index audit_outbox_unshipped_idx on audit_outbox (source_stream, sequence) where shipped_at is null;
create index audit_outbox_unshipped_age_idx on audit_outbox (recorded_at) where shipped_at is null;
create index audit_outbox_tenant_time_idx on audit_outbox (tenant_id, occurred_at desc);
create index audit_outbox_tenant_correlation_idx on audit_outbox (tenant_id, correlation_id);
create index audit_outbox_tenant_call_idx on audit_outbox (tenant_id, call_id) where call_id is not null;
create index audit_outbox_tenant_action_idx on audit_outbox (tenant_id, action, occurred_at desc);
create index audit_outbox_stream_time_idx on audit_outbox (source_stream, occurred_at);

-- Watermark of the locally purged prefix of each stream (written only by audit_purge_verified).
create table audit_purge_watermarks (
  source_stream text primary key references audit_chain_heads (source_stream),
  purged_through_sequence bigint not null check (purged_through_sequence >= 1),
  purged_through_hash text not null check (purged_through_hash ~ '^[a-f0-9]{64}$'),
  purged_at timestamptz not null
);

-- Sink delivery health recorded by the shipper (content free).
create table audit_sink_status (
  sink_id text primary key check (sink_id ~ '^[a-z0-9_.-]{3,64}$'),
  sink_kind text not null check (sink_kind in ('local_fixture', 'live')),
  last_success_at timestamptz,
  last_failure_at timestamptz,
  last_failure_reason text check (last_failure_reason ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0)
);

-- Write probe used by AuditHealth to prove the audit store accepts writes.
create table audit_write_probe (
  probe_id text primary key check (probe_id ~ '^[a-z0-9_.-]{3,64}$'),
  probed_at timestamptz not null
);

-- ---------------------------------------------------------------------------
-- Append-only enforcement triggers
-- ---------------------------------------------------------------------------

-- Every inserted event must be exactly the next link of its stream's chain.
create function audit_outbox_before_insert() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  h record;
begin
  select last_sequence, last_hash into h from audit_chain_heads where source_stream = new.source_stream for update;
  if not found then
    raise exception 'AUDIT_CHAIN_HEAD_MISSING' using errcode = '23514';
  end if;
  if new.sequence <> h.last_sequence + 1 then
    raise exception 'AUDIT_SEQUENCE_NOT_NEXT' using errcode = '23514';
  end if;
  if new.prev_hash is distinct from h.last_hash then
    raise exception 'AUDIT_PREV_HASH_MISMATCH' using errcode = '23514';
  end if;
  if new.shipped_at is not null or new.manifest_id is not null then
    raise exception 'AUDIT_INSERT_PRESHIPPED' using errcode = '42501';
  end if;
  return new;
end
$$;

-- Only the shipper role may set shipped_at + manifest_id, exactly once; nothing else changes.
create function audit_outbox_before_update() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if not pg_has_role(current_user, 'app_worker', 'USAGE') then
    raise exception 'AUDIT_APPEND_ONLY' using errcode = '42501';
  end if;
  if (new.event_id, new.tenant_id, new.source_stream, new.sequence, new.prev_hash, new.hash, new.event,
      new.occurred_at, new.recorded_at, new.correlation_id, new.call_id, new.action, new.outcome, new.data_class)
     is distinct from
     (old.event_id, old.tenant_id, old.source_stream, old.sequence, old.prev_hash, old.hash, old.event,
      old.occurred_at, old.recorded_at, old.correlation_id, old.call_id, old.action, old.outcome, old.data_class) then
    raise exception 'AUDIT_APPEND_ONLY' using errcode = '42501';
  end if;
  if old.shipped_at is not null or old.manifest_id is not null then
    raise exception 'AUDIT_ALREADY_SHIPPED' using errcode = '42501';
  end if;
  if new.shipped_at is null or new.manifest_id is null then
    raise exception 'AUDIT_SHIP_MARK_INCOMPLETE' using errcode = '42501';
  end if;
  return new;
end
$$;

-- DELETE only inside audit_purge_verified() and only for shipped + verified rows.
create function audit_outbox_before_delete() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if coalesce(current_setting('vsp.audit_purge', true), '') <> 'authorized' then
    raise exception 'AUDIT_APPEND_ONLY' using errcode = '42501';
  end if;
  if old.shipped_at is null or old.manifest_id is null then
    raise exception 'AUDIT_PURGE_UNSHIPPED' using errcode = '42501';
  end if;
  if not exists (select 1 from audit_manifests m where m.manifest_id = old.manifest_id and m.verified_at is not null) then
    raise exception 'AUDIT_PURGE_UNVERIFIED' using errcode = '42501';
  end if;
  return old;
end
$$;

create function audit_reject_truncate() returns trigger
language plpgsql as $$
begin
  raise exception 'AUDIT_APPEND_ONLY' using errcode = '42501';
end
$$;

create function audit_reject_delete() returns trigger
language plpgsql as $$
begin
  raise exception 'AUDIT_APPEND_ONLY' using errcode = '42501';
end
$$;

-- A chain head starts empty.
create function audit_chain_heads_before_insert() returns trigger
language plpgsql as $$
begin
  if new.last_sequence <> 0 or new.last_hash is not null then
    raise exception 'AUDIT_CHAIN_HEAD_INVALID_START' using errcode = '42501';
  end if;
  return new;
end
$$;

-- A chain head only advances by one, to an event that exists with that hash.
create function audit_chain_heads_before_update() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.source_stream <> old.source_stream then
    raise exception 'AUDIT_CHAIN_HEAD_IMMUTABLE' using errcode = '42501';
  end if;
  if new.last_sequence <> old.last_sequence + 1 then
    raise exception 'AUDIT_CHAIN_HEAD_NOT_NEXT' using errcode = '42501';
  end if;
  if not exists (
    select 1 from audit_outbox o
    where o.source_stream = new.source_stream and o.sequence = new.last_sequence and o.hash = new.last_hash
  ) then
    raise exception 'AUDIT_CHAIN_HEAD_UNBACKED' using errcode = '42501';
  end if;
  return new;
end
$$;

-- Manifest records are immutable apart from PLANNED -> SHIPPED and a one-time verified_at.
create function audit_manifests_before_update() returns trigger
language plpgsql as $$
begin
  if (new.manifest_id, new.source_stream, new.first_sequence, new.last_sequence, new.event_count, new.first_prev_hash,
      new.last_hash, new.batch_digest, new.object_key, new.manifest, new.sink_kind, new.planned_at)
     is distinct from
     (old.manifest_id, old.source_stream, old.first_sequence, old.last_sequence, old.event_count, old.first_prev_hash,
      old.last_hash, old.batch_digest, old.object_key, old.manifest, old.sink_kind, old.planned_at) then
    raise exception 'AUDIT_MANIFEST_IMMUTABLE' using errcode = '42501';
  end if;
  if old.status = 'SHIPPED' and (new.status <> 'SHIPPED' or new.shipped_at is distinct from old.shipped_at) then
    raise exception 'AUDIT_MANIFEST_IMMUTABLE' using errcode = '42501';
  end if;
  if old.verified_at is not null and new.verified_at is distinct from old.verified_at then
    raise exception 'AUDIT_MANIFEST_IMMUTABLE' using errcode = '42501';
  end if;
  return new;
end
$$;

create trigger audit_outbox_before_insert before insert on audit_outbox
  for each row execute function audit_outbox_before_insert();
create trigger audit_outbox_before_update before update on audit_outbox
  for each row execute function audit_outbox_before_update();
create trigger audit_outbox_before_delete before delete on audit_outbox
  for each row execute function audit_outbox_before_delete();
create trigger audit_outbox_no_truncate before truncate on audit_outbox
  for each statement execute function audit_reject_truncate();

create trigger audit_chain_heads_before_insert before insert on audit_chain_heads
  for each row execute function audit_chain_heads_before_insert();
create trigger audit_chain_heads_before_update before update on audit_chain_heads
  for each row execute function audit_chain_heads_before_update();
create trigger audit_chain_heads_no_delete before delete on audit_chain_heads
  for each row execute function audit_reject_delete();
create trigger audit_chain_heads_no_truncate before truncate on audit_chain_heads
  for each statement execute function audit_reject_truncate();

create trigger audit_manifests_before_update before update on audit_manifests
  for each row execute function audit_manifests_before_update();
create trigger audit_manifests_no_delete before delete on audit_manifests
  for each row execute function audit_reject_delete();
create trigger audit_manifests_no_truncate before truncate on audit_manifests
  for each statement execute function audit_reject_truncate();

create trigger audit_purge_watermarks_no_delete before delete on audit_purge_watermarks
  for each row execute function audit_reject_delete();

-- ---------------------------------------------------------------------------
-- Security-definer helpers (content-free aggregates and the only purge path)
-- ---------------------------------------------------------------------------

-- Global backlog and sink health for the bounded-buffering policy. Returns counts and times only.
create function audit_backlog_stats()
returns table (
  backlog_count bigint,
  oldest_unshipped_recorded_at timestamptz,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  consecutive_failures integer,
  last_failure_reason text
)
language sql stable security definer set search_path = public, pg_temp as $$
  select
    (select count(*) from audit_outbox where shipped_at is null),
    (select min(recorded_at) from audit_outbox where shipped_at is null),
    (select max(s.last_success_at) from audit_sink_status s),
    (select max(s.last_failure_at) from audit_sink_status s),
    (select coalesce(max(s.consecutive_failures), 0) from audit_sink_status s),
    (select s.last_failure_reason from audit_sink_status s
       where s.consecutive_failures > 0 order by s.last_failure_at desc nulls last limit 1)
$$;

-- Deletes a contiguous prefix of a stream ONLY when every row in it was shipped in a
-- manifest that the IntegrityVerifier confirmed against the independent sink.
create function audit_purge_verified(p_stream text, p_through_sequence bigint, p_purged_at timestamptz)
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_from bigint;
  v_eligible bigint;
  v_hash text;
  v_deleted integer;
begin
  select purged_through_sequence into v_from from audit_purge_watermarks where source_stream = p_stream for update;
  if not found then
    v_from := 0;
  end if;
  if p_through_sequence <= v_from then
    return 0;
  end if;
  select count(*) into v_eligible
    from audit_outbox o join audit_manifests m on m.manifest_id = o.manifest_id
   where o.source_stream = p_stream
     and o.sequence > v_from and o.sequence <= p_through_sequence
     and o.shipped_at is not null and m.status = 'SHIPPED' and m.verified_at is not null;
  if v_eligible <> p_through_sequence - v_from then
    raise exception 'AUDIT_PURGE_PRECONDITION_FAILED' using errcode = '42501';
  end if;
  select hash into v_hash from audit_outbox where source_stream = p_stream and sequence = p_through_sequence;
  perform set_config('vsp.audit_purge', 'authorized', true);
  delete from audit_outbox where source_stream = p_stream and sequence > v_from and sequence <= p_through_sequence;
  get diagnostics v_deleted = row_count;
  perform set_config('vsp.audit_purge', '', true);
  insert into audit_purge_watermarks (source_stream, purged_through_sequence, purged_through_hash, purged_at)
    values (p_stream, p_through_sequence, v_hash, p_purged_at)
    on conflict (source_stream) do update
      set purged_through_sequence = excluded.purged_through_sequence,
          purged_through_hash = excluded.purged_through_hash,
          purged_at = excluded.purged_at;
  return v_deleted;
end
$$;

-- ---------------------------------------------------------------------------
-- Metadata view for console auditors (tenant filtered; security barrier)
-- ---------------------------------------------------------------------------

create view audit_event_metadata with (security_barrier = true) as
  select o.event_id, o.tenant_id, o.source_stream, o.sequence, o.occurred_at, o.recorded_at,
         o.correlation_id, o.call_id, o.action, o.outcome, o.data_class, o.event,
         (o.shipped_at is not null) as shipped
    from audit_outbox o
   where o.tenant_id = app_tenant();

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

alter table audit_outbox enable row level security;

create policy audit_outbox_insert on audit_outbox for insert
  to app_runtime, app_worker, app_console
  with check (tenant_id = app_tenant());
create policy audit_outbox_runtime_read on audit_outbox for select
  to app_runtime
  using (tenant_id = app_tenant());
create policy audit_outbox_worker_read on audit_outbox for select
  to app_worker
  using (true);
create policy audit_outbox_worker_mark on audit_outbox for update
  to app_worker
  using (shipped_at is null)
  with check (shipped_at is not null and manifest_id is not null);

-- ---------------------------------------------------------------------------
-- Grants (least privilege)
-- ---------------------------------------------------------------------------

revoke all on audit_outbox, audit_chain_heads, audit_manifests, audit_purge_watermarks,
  audit_sink_status, audit_write_probe, audit_event_metadata from public;

grant select, insert, update on audit_chain_heads to app_runtime, app_worker, app_console;
grant insert on audit_outbox to app_runtime, app_worker, app_console;
grant select on audit_outbox to app_runtime, app_worker;
grant update (shipped_at, manifest_id) on audit_outbox to app_worker;
grant select, insert on audit_manifests to app_worker;
grant update (status, shipped_at, verified_at) on audit_manifests to app_worker;
grant select on audit_purge_watermarks to app_worker;
grant select, insert, update on audit_sink_status to app_worker;
grant select, insert, update on audit_write_probe to app_runtime, app_worker, app_console;
grant select on audit_event_metadata to app_auditor, app_console;

revoke all on function audit_outbox_before_insert(), audit_outbox_before_update(), audit_outbox_before_delete(),
  audit_reject_truncate(), audit_reject_delete(), audit_chain_heads_before_insert(),
  audit_chain_heads_before_update(), audit_manifests_before_update() from public;
revoke all on function audit_backlog_stats() from public;
grant execute on function audit_backlog_stats() to app_runtime, app_worker, app_console;
revoke all on function audit_purge_verified(text, bigint, timestamptz) from public;
grant execute on function audit_purge_verified(text, bigint, timestamptz) to app_worker;
