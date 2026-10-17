-- Transactional outbox and consumer deduplication (spec section 8: "Persist an action ledger and
-- transactional outbox before initiating durable delivery. Events are at least once; consumers
-- deduplicate."; section 12: bounded retries with jitter; dead-letter + operator repair).
--
-- Payloads carry opaque references only (application-validated); PHI stays in access-controlled
-- tables. Times come from the application's injectable clock.

create table outbox_messages (
  message_id       text primary key check (message_id ~ '^msg_[A-Za-z0-9_-]{16,64}$'),
  tenant_id        text not null check (tenant_id ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  topic            text not null check (topic in (
                     'support_request.sync', 'workflow.start', 'workflow.signal',
                     'notification.send', 'audit.ship', 'action.committed')),
  key              text not null check (key ~ '^[A-Za-z0-9_.:@/-]{1,128}$'),
  payload          jsonb not null check (jsonb_typeof(payload) = 'object'),
  dedupe_key       text not null check (dedupe_key ~ '^[A-Za-z0-9_.:@/-]{8,200}$'),
  status           text not null check (status in ('PENDING', 'DISPATCHED', 'DEAD')),
  attempts         integer not null default 0 check (attempts >= 0),
  next_attempt_at  timestamptz not null,
  claim_token      text null,
  claimed_until    timestamptz null,
  last_error_code  text null check (last_error_code is null or last_error_code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  created_at       timestamptz not null,
  updated_at       timestamptz not null,
  dispatched_at    timestamptz null,
  dead_at          timestamptz null,
  constraint outbox_messages_dedupe unique (tenant_id, dedupe_key),
  constraint outbox_messages_dispatched_at check ((status = 'DISPATCHED') = (dispatched_at is not null)),
  constraint outbox_messages_dead_at check ((status = 'DEAD') = (dead_at is not null))
);

create index outbox_messages_due on outbox_messages (tenant_id, next_attempt_at, created_at)
  where status = 'PENDING';
create index outbox_messages_key_order on outbox_messages (tenant_id, key, created_at, message_id)
  where status = 'PENDING';
create index outbox_messages_dead on outbox_messages (tenant_id, dead_at)
  where status = 'DEAD';

create or replace function outbox_messages_guard() returns trigger language plpgsql as $$
begin
  if new.message_id is distinct from old.message_id
     or new.tenant_id is distinct from old.tenant_id
     or new.topic is distinct from old.topic
     or new.key is distinct from old.key
     or new.payload is distinct from old.payload
     or new.dedupe_key is distinct from old.dedupe_key
     or new.created_at is distinct from old.created_at then
    raise exception 'OUTBOX_IMMUTABLE_FIELD' using errcode = 'check_violation';
  end if;
  if old.status = 'DISPATCHED' then
    raise exception 'OUTBOX_DISPATCHED_FINAL' using errcode = 'check_violation';
  end if;
  if old.status = 'DEAD' and new.status not in ('DEAD', 'PENDING') then
    raise exception 'OUTBOX_ILLEGAL_TRANSITION' using errcode = 'check_violation';
  end if;
  return new;
end
$$;

create trigger outbox_messages_guard
  before update on outbox_messages
  for each row execute function outbox_messages_guard();

-- Consumer-side deduplication: the dedupe row and the handler's effects commit atomically.
create table consumer_dedup (
  consumer      text not null check (consumer ~ '^[a-z][a-z0-9_.-]{2,63}$'),
  message_id    text not null check (length(message_id) between 8 and 128),
  tenant_id     text not null check (tenant_id ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  processed_at  timestamptz not null,
  primary key (consumer, message_id)
);

alter table outbox_messages enable row level security;
alter table outbox_messages force row level security;
alter table consumer_dedup enable row level security;
alter table consumer_dedup force row level security;

create policy outbox_messages_runtime_tenant on outbox_messages for all to app_runtime
  using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy outbox_messages_worker_tenant on outbox_messages for all to app_worker
  using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy consumer_dedup_runtime_tenant on consumer_dedup for all to app_runtime
  using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy consumer_dedup_worker_tenant on consumer_dedup for all to app_worker
  using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());

-- Runtime enqueues inside its own transaction; only the worker dispatches/repairs. No DELETE.
grant select, insert on outbox_messages to app_runtime;
grant select, insert, update on outbox_messages to app_worker;
grant select, insert on consumer_dedup to app_runtime, app_worker;
