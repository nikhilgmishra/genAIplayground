-- 2071 connector change-feed index (WP-07; follow-on FO-17-24.DLQ_FULL, FO-21-10; ACT-02, OPS-01, DATA-01).
--
-- The live worker's connector feed sync (platform/src/adapters/live/connector-feed.ts) reads each configured
-- change feed with the WP-06 IncrementalReader and, in the SAME transaction as the checkpoint, indexes every
-- record it can project: one row per (tenant, connector profile, stream, record key) with the record key's
-- digest and the source update time. A record it cannot project is
-- dead-lettered (content-free envelope, SQS); when the dead-letter write is refused the page transaction rolls
-- back, so neither the index rows nor the checkpoint advance and consumption stops (DLQ_FULL).
-- Content: digests, codes and times only; never record values.

create table connector_feed_index (
  tenant_id          text        not null check (tenant_id ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  profile_id         text        not null check (profile_id ~ '^cnp_[A-Za-z0-9_-]{8,64}$'),
  stream_id          text        not null check (stream_id ~ '^[a-z][a-z0-9_]{1,40}$'),
  record_key_digest  text        not null check (record_key_digest ~ '^[a-f0-9]{64}$'),
  source_updated_at  timestamptz,
  first_seen_at      timestamptz not null,
  last_seen_at       timestamptz not null,
  last_run_id        text        not null check (last_run_id ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  primary key (tenant_id, profile_id, stream_id, record_key_digest),
  check (last_seen_at >= first_seen_at)
);

alter table connector_feed_index enable row level security;
alter table connector_feed_index force row level security;

create policy connector_feed_index_worker on connector_feed_index for all to app_worker
  using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy connector_feed_index_console_read on connector_feed_index for select to app_console
  using (tenant_id = app_tenant());

revoke all on connector_feed_index from public;
grant select, insert on connector_feed_index to app_worker;
grant update (source_updated_at, last_seen_at, last_run_id) on connector_feed_index to app_worker;
grant select on connector_feed_index to app_console;
