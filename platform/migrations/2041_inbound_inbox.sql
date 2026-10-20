-- 2041 authenticated inbound event inbox (WP-04; follow-on FO-03-21, FO-06-97, FO-06-98, FO-07-16..22,
-- FO-15-50, FO-17-24.DUPLICATE_WEBHOOK; ACT-02, DATA-01, DATA-02, OPS-01, OPS-03).
--
-- Every inbound event (webhook, CDP delivery, stream record, delivery receipt) is authenticated by the
-- ingress router BEFORE it is persisted, and persisted (encrypted) BEFORE it is acknowledged:
--   inbound_events            one row per (tenant, source, event_id): payload ciphertext (KMS envelope,
--                             AES-256-GCM, AAD bound to the row identity), SHA-256 of the received bytes,
--                             schema contract id/version, the authentication mechanism and the credential
--                             version that verified it; processing state with bounded attempts, lease
--                             claims, quarantine, INBOUND_DEAD and replay counters.
--   inbound_deliveries        every delivery of an event, duplicates included (the duplicate is recorded).
--   inbound_replays           audited operator replays (the audit event id is mandatory).
--   inbox_projection_versions last-writer-by-source-version state per projected entity (never arrival order).
--   inbox_stream_checkpoints  per stream partition: committed position and low/high watermarks.
--   inbox_stream_gaps         positions a checkpoint moved past without processing (a dead-lettered or
--                             quarantined record): the watermark reports them until replayed.
--
-- Content: payload_ciphertext / encrypted_data_key / payload_iv / payload_tag are the restricted raw replay
-- artifact (retention class INBOUND_RAW_REPLAY, raw_retain_until, purged by the worker per tenant once
-- processing is terminal and the retention expired); only the inbox processor (app_worker) can read them
-- (column grants: the ingress writer inserts them but cannot read a stored payload back). Every other column is an opaque id, a code, a digest,
-- a count, a bounded source version or a time.

create table inbound_events (
  inbox_id             text        primary key check (inbox_id ~ '^inb_[A-Za-z0-9_-]{16,64}$'),
  tenant_id            text        not null check (tenant_id ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  source_id            text        not null check (source_id ~ '^[a-z][a-z0-9_.-]{2,63}$'),
  -- Source-assigned event identity (vendor event id, stream partition:sequence); opaque, never content.
  event_id             text        not null check (event_id ~ '^[A-Za-z0-9:._/=+-]{1,200}$'),
  event_type           text        check (event_type is null or event_type ~ '^[A-Za-z][A-Za-z0-9_.:/-]{0,127}$'),
  -- Explicit contract the payload was validated against; null while QUARANTINED for an unknown schema.
  schema_id            text        check (schema_id is null or schema_id ~ '^[a-z][a-z0-9_.-]{2,63}$'),
  schema_version       text        check (schema_version is null or schema_version ~ '^[A-Za-z0-9._-]{1,32}$'),
  entity_key           text        check (entity_key is null or entity_key ~ '^[A-Za-z0-9:._/=+-]{1,200}$'),
  source_version       numeric(39, 0) check (source_version is null or source_version >= 0),
  occurred_at          timestamptz,
  received_at          timestamptz not null,
  payload_digest       text        not null check (payload_digest ~ '^[a-f0-9]{64}$'),
  payload_bytes        integer     not null check (payload_bytes between 0 and 1048576),
  payload_ciphertext   bytea,
  encrypted_data_key   bytea,
  payload_key_ref      text        check (payload_key_ref is null or length(payload_key_ref) between 3 and 512),
  payload_iv           bytea,
  payload_tag          bytea,
  cipher_kind          text        not null check (cipher_kind in ('live', 'local_fixture')),
  retention_class      text        not null default 'INBOUND_RAW_REPLAY' check (retention_class = 'INBOUND_RAW_REPLAY'),
  raw_retain_until     timestamptz not null,
  raw_purged_at        timestamptz,
  auth_mechanism       text        not null check (auth_mechanism in
                         ('HMAC_SHA256_HEADER', 'HMAC_SHA1_HEADER', 'JWT_BEARER', 'MTLS', 'RECONCILE_BY_LOOKUP', 'STREAM_IAM')),
  credential_version   text        check (credential_version is null or credential_version ~ '^[A-Za-z0-9._-]{1,64}$'),
  stream_partition     text        check (stream_partition is null or stream_partition ~ '^[A-Za-z0-9:._-]{1,128}$'),
  stream_position      numeric(39, 0) check (stream_position is null or stream_position >= 0),
  status               text        not null check (status in ('RECEIVED', 'PROCESSED', 'QUARANTINED', 'INBOUND_DEAD')),
  attempts             integer     not null default 0 check (attempts between 0 and 1000),
  next_attempt_at      timestamptz not null,
  claim_token          text        check (claim_token is null or claim_token ~ '^clm_[A-Za-z0-9_-]{16,64}$'),
  claimed_until        timestamptz,
  last_error_code      text        check (last_error_code is null or last_error_code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  quarantine_reason    text        check (quarantine_reason is null or quarantine_reason ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  dead_reason          text        check (dead_reason is null or dead_reason ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  dead_at              timestamptz,
  processed_at         timestamptz,
  projection_result    text        check (projection_result is null or projection_result in ('APPLIED', 'SUPERSEDED', 'NO_PROJECTION')),
  duplicate_count      integer     not null default 0 check (duplicate_count >= 0),
  replay_count         integer     not null default 0 check (replay_count between 0 and 100),
  audit_event_id       text        check (audit_event_id is null or audit_event_id ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  updated_at           timestamptz not null,
  unique (tenant_id, source_id, event_id),
  check ((payload_ciphertext is null) = (raw_purged_at is not null)),
  check (raw_purged_at is not null or (encrypted_data_key is not null and payload_iv is not null and payload_tag is not null and payload_key_ref is not null)),
  check ((status = 'QUARANTINED') = (quarantine_reason is not null)),
  check ((status = 'INBOUND_DEAD') = (dead_reason is not null and dead_at is not null)),
  check ((status = 'PROCESSED') = (processed_at is not null and projection_result is not null)),
  check ((claim_token is null) = (claimed_until is null)),
  check ((stream_partition is null) = (stream_position is null)),
  -- A raw payload can be purged only after processing reached a terminal state and its retention expired.
  check (raw_purged_at is null or (status in ('PROCESSED', 'INBOUND_DEAD', 'QUARANTINED') and raw_purged_at >= raw_retain_until))
);

create index inbound_events_due_idx on inbound_events (tenant_id, next_attempt_at) where status = 'RECEIVED';
create index inbound_events_dead_idx on inbound_events (tenant_id, source_id, dead_at) where status = 'INBOUND_DEAD';
create index inbound_events_quarantine_idx on inbound_events (tenant_id, source_id, received_at) where status = 'QUARANTINED';
create index inbound_events_retention_idx on inbound_events (raw_retain_until) where raw_purged_at is null;

create table inbound_deliveries (
  delivery_id          text        primary key check (delivery_id ~ '^idl_[A-Za-z0-9_-]{16,64}$'),
  inbox_id             text        not null references inbound_events (inbox_id),
  tenant_id            text        not null check (tenant_id ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  received_at          timestamptz not null,
  duplicate            boolean     not null,
  -- A redelivery whose bytes differ from the first delivery is recorded, never applied.
  payload_digest       text        not null check (payload_digest ~ '^[a-f0-9]{64}$'),
  digest_matches       boolean     not null,
  auth_mechanism       text        not null,
  credential_version   text        check (credential_version is null or credential_version ~ '^[A-Za-z0-9._-]{1,64}$')
);
create index inbound_deliveries_inbox_idx on inbound_deliveries (inbox_id, received_at);

create table inbound_replays (
  replay_id            text        primary key check (replay_id ~ '^irp_[A-Za-z0-9_-]{16,64}$'),
  inbox_id             text        not null references inbound_events (inbox_id),
  tenant_id            text        not null check (tenant_id ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  operator_ref         text        not null check (operator_ref ~ '^stf_[A-Za-z0-9_-]{8,64}$'),
  reason_code          text        not null check (reason_code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  mfa_verified_at      timestamptz not null,
  prior_status         text        not null check (prior_status in ('QUARANTINED', 'INBOUND_DEAD')),
  requested_at         timestamptz not null,
  audit_event_id       text        not null check (audit_event_id ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  check (mfa_verified_at <= requested_at)
);

create table inbox_projection_versions (
  tenant_id            text        not null check (tenant_id ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  source_id            text        not null check (source_id ~ '^[a-z][a-z0-9_.-]{2,63}$'),
  entity_key           text        not null check (entity_key ~ '^[A-Za-z0-9:._/=+-]{1,200}$'),
  source_version       numeric(39, 0) not null check (source_version >= 0),
  occurred_at          timestamptz,
  event_id             text        not null,
  inbox_id             text        not null references inbound_events (inbox_id),
  state_digest         text        not null check (state_digest ~ '^[a-f0-9]{64}$'),
  applied_at           timestamptz not null,
  superseded_count     integer     not null default 0 check (superseded_count >= 0),
  primary key (tenant_id, source_id, entity_key)
);

create table inbox_stream_checkpoints (
  tenant_id            text        not null check (tenant_id ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  source_id            text        not null check (source_id ~ '^[a-z][a-z0-9_.-]{2,63}$'),
  stream_partition     text        not null check (stream_partition ~ '^[A-Za-z0-9:._-]{1,128}$'),
  -- Highest position whose record is durably in the inbox (or recorded as a gap).
  committed_position   numeric(39, 0) not null check (committed_position >= 0),
  low_watermark        numeric(39, 0) not null check (low_watermark >= 0),
  high_watermark       numeric(39, 0) not null check (high_watermark >= 0),
  -- Position the source reported as its newest (lag = source_high - committed).
  source_high_position numeric(39, 0) check (source_high_position is null or source_high_position >= 0),
  open_gaps            integer     not null default 0 check (open_gaps >= 0),
  heartbeat_at         timestamptz not null,
  updated_at           timestamptz not null,
  check (low_watermark <= committed_position and committed_position <= high_watermark),
  primary key (tenant_id, source_id, stream_partition)
);

create table inbox_stream_gaps (
  gap_id               text        primary key check (gap_id ~ '^isg_[A-Za-z0-9_-]{16,64}$'),
  tenant_id            text        not null check (tenant_id ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  source_id            text        not null check (source_id ~ '^[a-z][a-z0-9_.-]{2,63}$'),
  stream_partition     text        not null check (stream_partition ~ '^[A-Za-z0-9:._-]{1,128}$'),
  stream_position      numeric(39, 0) not null check (stream_position >= 0),
  inbox_id             text        not null references inbound_events (inbox_id),
  reason_code          text        not null check (reason_code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  opened_at            timestamptz not null,
  closed_at            timestamptz,
  closed_by_replay_id  text        check (closed_by_replay_id is null or closed_by_replay_id ~ '^irp_[A-Za-z0-9_-]{16,64}$'),
  unique (tenant_id, source_id, stream_partition, stream_position),
  check ((closed_at is null) = (closed_by_replay_id is null))
);
create index inbox_stream_gaps_open_idx on inbox_stream_gaps (tenant_id, source_id, stream_partition) where closed_at is null;

-- ---------------------------------------------------------------------------
-- Integrity triggers
-- ---------------------------------------------------------------------------

-- Identity, received bytes and authentication evidence of an inbox row never change; processing state
-- moves forward only (RECEIVED -> PROCESSED | QUARANTINED | INBOUND_DEAD; QUARANTINED | INBOUND_DEAD
-- -> RECEIVED only through an audited replay, which raises replay_count).
create function inbound_events_guard() returns trigger language plpgsql as $$
begin
  if (new.inbox_id, new.tenant_id, new.source_id, new.event_id, new.received_at, new.payload_digest, new.payload_bytes,
      new.auth_mechanism, new.credential_version, new.cipher_kind, new.stream_partition, new.stream_position, new.retention_class)
     is distinct from
     (old.inbox_id, old.tenant_id, old.source_id, old.event_id, old.received_at, old.payload_digest, old.payload_bytes,
      old.auth_mechanism, old.credential_version, old.cipher_kind, old.stream_partition, old.stream_position, old.retention_class) then
    raise exception 'INBOX_ROW_IMMUTABLE' using errcode = '42501';
  end if;
  if old.raw_purged_at is null and new.raw_purged_at is null
     and (new.payload_ciphertext, new.encrypted_data_key, new.payload_key_ref, new.payload_iv, new.payload_tag)
         is distinct from (old.payload_ciphertext, old.encrypted_data_key, old.payload_key_ref, old.payload_iv, old.payload_tag) then
    raise exception 'INBOX_PAYLOAD_IMMUTABLE' using errcode = '42501';
  end if;
  if old.raw_purged_at is not null and new.raw_purged_at is distinct from old.raw_purged_at then
    raise exception 'INBOX_PAYLOAD_PURGED' using errcode = '42501';
  end if;
  if new.status <> old.status then
    if not (
      (old.status = 'RECEIVED' and new.status in ('PROCESSED', 'QUARANTINED', 'INBOUND_DEAD'))
      or (old.status in ('QUARANTINED', 'INBOUND_DEAD') and new.status = 'RECEIVED' and new.replay_count = old.replay_count + 1)
    ) then
      raise exception 'INBOX_TRANSITION_INVALID' using errcode = '42501';
    end if;
  end if;
  if new.replay_count < old.replay_count or new.duplicate_count < old.duplicate_count then
    raise exception 'INBOX_COUNTER_REWOUND' using errcode = '42501';
  end if;
  return new;
end
$$;

create function inbox_reject_change() returns trigger language plpgsql as $$
begin
  raise exception 'INBOX_APPEND_ONLY' using errcode = '42501';
end
$$;

-- Last writer by SOURCE VERSION: an update that does not raise the version is refused (a stale, duplicate
-- or reordered event can never roll back a newer state).
create function inbox_projection_versions_guard() returns trigger language plpgsql as $$
begin
  if (new.tenant_id, new.source_id, new.entity_key) is distinct from (old.tenant_id, old.source_id, old.entity_key) then
    raise exception 'INBOX_PROJECTION_KEY_IMMUTABLE' using errcode = '42501';
  end if;
  if new.source_version < old.source_version
     or (new.source_version = old.source_version and new.event_id is distinct from old.event_id and new.superseded_count = old.superseded_count) then
    raise exception 'INBOX_PROJECTION_VERSION_REGRESSION' using errcode = '42501';
  end if;
  return new;
end
$$;

-- A checkpoint never moves backwards (a backfill never rolls back a newer position).
create function inbox_stream_checkpoints_guard() returns trigger language plpgsql as $$
begin
  if new.committed_position < old.committed_position or new.high_watermark < old.high_watermark then
    raise exception 'INBOX_CHECKPOINT_REGRESSION' using errcode = '42501';
  end if;
  return new;
end
$$;

create trigger inbound_events_guard before update on inbound_events
  for each row execute function inbound_events_guard();
create trigger inbound_events_no_delete before delete on inbound_events
  for each row execute function inbox_reject_change();
create trigger inbound_events_no_truncate before truncate on inbound_events
  for each statement execute function inbox_reject_change();
create trigger inbound_deliveries_no_change before update or delete on inbound_deliveries
  for each row execute function inbox_reject_change();
create trigger inbound_replays_no_change before update or delete on inbound_replays
  for each row execute function inbox_reject_change();
create trigger inbox_projection_versions_guard before update on inbox_projection_versions
  for each row execute function inbox_projection_versions_guard();
create trigger inbox_projection_versions_no_delete before delete on inbox_projection_versions
  for each row execute function inbox_reject_change();
create trigger inbox_stream_checkpoints_guard before update on inbox_stream_checkpoints
  for each row execute function inbox_stream_checkpoints_guard();
create trigger inbox_stream_gaps_no_delete before delete on inbox_stream_gaps
  for each row execute function inbox_reject_change();
create trigger inbox_tables_no_truncate_deliveries before truncate on inbound_deliveries
  for each statement execute function inbox_reject_change();
create trigger inbox_tables_no_truncate_replays before truncate on inbound_replays
  for each statement execute function inbox_reject_change();

-- ---------------------------------------------------------------------------
-- Row-level security and grants
-- ---------------------------------------------------------------------------

alter table inbound_events enable row level security;
alter table inbound_events force row level security;
alter table inbound_deliveries enable row level security;
alter table inbound_deliveries force row level security;
alter table inbound_replays enable row level security;
alter table inbound_replays force row level security;
alter table inbox_projection_versions enable row level security;
alter table inbox_projection_versions force row level security;
alter table inbox_stream_checkpoints enable row level security;
alter table inbox_stream_checkpoints force row level security;
alter table inbox_stream_gaps enable row level security;
alter table inbox_stream_gaps force row level security;

create policy inbound_events_tenant on inbound_events for all to app_runtime, app_worker, app_console
  using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy inbound_deliveries_tenant on inbound_deliveries for all to app_runtime, app_worker
  using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy inbound_deliveries_read on inbound_deliveries for select to app_console, app_auditor
  using (tenant_id = app_tenant());
create policy inbound_replays_tenant on inbound_replays for all to app_console, app_worker
  using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy inbound_replays_read on inbound_replays for select to app_auditor
  using (tenant_id = app_tenant());
create policy inbox_projection_versions_tenant on inbox_projection_versions for all to app_worker
  using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy inbox_projection_versions_read on inbox_projection_versions for select to app_runtime, app_console
  using (tenant_id = app_tenant());
create policy inbox_stream_checkpoints_tenant on inbox_stream_checkpoints for all to app_worker
  using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy inbox_stream_checkpoints_read on inbox_stream_checkpoints for select to app_console
  using (tenant_id = app_tenant());
create policy inbox_stream_gaps_tenant on inbox_stream_gaps for all to app_worker, app_console
  using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());

revoke all on inbound_events, inbound_deliveries, inbound_replays, inbox_projection_versions,
  inbox_stream_checkpoints, inbox_stream_gaps from public;

-- Ingress writer (gateway, app_runtime): inserts the row and counts duplicates; reads identity and
-- digest columns only (dedupe), never the ciphertext of a stored row.
grant insert on inbound_events to app_runtime, app_worker;
grant select (inbox_id, tenant_id, source_id, event_id, event_type, schema_id, schema_version, payload_digest, status,
              duplicate_count, received_at, auth_mechanism, credential_version) on inbound_events to app_runtime;
grant update (duplicate_count, updated_at) on inbound_events to app_runtime;
-- Inbox processor and stream ingestor (worker): full read (decrypts to process) and state transitions.
grant select on inbound_events to app_worker;
grant update (status, attempts, next_attempt_at, claim_token, claimed_until, last_error_code, quarantine_reason, dead_reason,
              dead_at, processed_at, projection_result, duplicate_count, updated_at, schema_id, schema_version, event_type,
              entity_key, source_version, occurred_at,
              -- retention purge of the raw payload (PgInbox.purgeExpiredPayloads, per tenant under RLS)
              payload_ciphertext, encrypted_data_key, payload_key_ref, payload_iv, payload_tag, raw_purged_at) on inbound_events to app_worker;
-- Console operators: metadata only (no payload columns) and the audited replay transition.
grant select (inbox_id, tenant_id, source_id, event_id, event_type, schema_id, schema_version, entity_key, source_version,
              occurred_at, received_at, payload_digest, payload_bytes, auth_mechanism, credential_version, stream_partition,
              stream_position, status, attempts, last_error_code, quarantine_reason, dead_reason, dead_at, processed_at,
              projection_result, duplicate_count, replay_count, audit_event_id, raw_retain_until, raw_purged_at, updated_at)
  on inbound_events to app_console;
grant update (status, attempts, next_attempt_at, claim_token, claimed_until, last_error_code, quarantine_reason, dead_reason,
              dead_at, replay_count, schema_id, schema_version, updated_at) on inbound_events to app_console;
grant select, insert on inbound_deliveries to app_runtime, app_worker;
grant select on inbound_deliveries to app_console, app_auditor;
grant select, insert on inbound_replays to app_console, app_worker;
grant select on inbound_replays to app_auditor;
grant select, insert, update on inbox_projection_versions to app_worker;
grant select on inbox_projection_versions to app_runtime, app_console;
grant select, insert, update on inbox_stream_checkpoints to app_worker;
grant select on inbox_stream_checkpoints to app_console;
grant select, insert on inbox_stream_gaps to app_worker;
grant update (closed_at, closed_by_replay_id) on inbox_stream_gaps to app_worker, app_console;
grant select on inbox_stream_gaps to app_console;

revoke all on function inbound_events_guard(), inbox_reject_change(), inbox_projection_versions_guard(),
  inbox_stream_checkpoints_guard() from public;
