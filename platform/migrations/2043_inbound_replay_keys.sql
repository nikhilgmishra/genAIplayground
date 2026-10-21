-- 2043 durable replay cache of token-authenticated inbound deliveries (WP-04; follow-on FO-15-50, FO-07-18,
-- FO-17-24.DUPLICATE_WEBHOOK; ACT-02, AUTH-04, OPS-01).
--
-- A webhook signature (HMAC over the bytes) or a body-bound token can only be replayed byte for byte, which
-- the inbox already absorbs as a recorded duplicate (inbound_deliveries). A bearer token that does NOT bind
-- the body is different: until it expires it could be presented again over other bytes. Its replay key — the
-- SHA-256 of (source, jti), never the token or the jti — is recorded here with the digest of the bytes it
-- first authenticated, in the SAME transaction that accepts the event (PgInbox.accept). The same key over the
-- same bytes is a redelivery; over other bytes it is refused (INGRESS_REPLAYED) and nothing is stored. The
-- record is shared by every replica (an in-process cache would let a replay to another replica through).
-- Keys are kept until the token expires and then purged by the worker (PgInbox.purgeExpiredReplayKeys).

create table inbound_replay_keys (
  tenant_id       text        not null check (tenant_id ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  source_id       text        not null check (source_id ~ '^[a-z][a-z0-9_.-]{2,63}$'),
  key_digest      text        not null check (key_digest ~ '^[a-f0-9]{64}$'),
  -- SHA-256 of the bytes the token first authenticated.
  payload_digest  text        not null check (payload_digest ~ '^[a-f0-9]{64}$'),
  first_seen_at   timestamptz not null,
  expires_at      timestamptz not null,
  check (expires_at > first_seen_at - interval '1 minute'),
  primary key (tenant_id, source_id, key_digest)
);
create index inbound_replay_keys_expiry_idx on inbound_replay_keys (tenant_id, expires_at);

-- A recorded key never changes; it is only deleted once expired.
create function inbound_replay_keys_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'INBOX_REPLAY_KEY_IMMUTABLE' using errcode = '42501';
  end if;
  if old.expires_at > now() then
    raise exception 'INBOX_REPLAY_KEY_NOT_EXPIRED' using errcode = '42501';
  end if;
  return old;
end
$$;
create trigger inbound_replay_keys_guard before update or delete on inbound_replay_keys
  for each row execute function inbound_replay_keys_guard();
create trigger inbound_replay_keys_no_truncate before truncate on inbound_replay_keys
  for each statement execute function inbox_reject_change();

alter table inbound_replay_keys enable row level security;
alter table inbound_replay_keys force row level security;
create policy inbound_replay_keys_tenant on inbound_replay_keys for all to app_runtime, app_worker
  using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());

revoke all on inbound_replay_keys from public;
revoke all on function inbound_replay_keys_guard() from public;
-- The ingress writer (gateway) and the stream ingestor record and read keys; the worker purges expired ones.
grant select, insert on inbound_replay_keys to app_runtime, app_worker;
grant delete on inbound_replay_keys to app_worker;
