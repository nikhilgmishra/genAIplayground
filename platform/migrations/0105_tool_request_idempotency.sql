-- Tool request idempotency (spec section 8 "Tool interface": idempotency semantics per tool).
--
-- A repeated tool request with the same (tenant, integration, idempotency key) returns the
-- stored result; the same key with a different request hash is rejected. Expired rows are
-- ignored by readers (application-enforced, independent of the purge job) and may be re-bound.
-- Stored responses can contain business data: tenant RLS applies and rows are purged after expiry.

create table tool_request_idempotency (
  tenant_id        text not null check (tenant_id ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  integration_id   text not null check (integration_id ~ '^[a-z0-9-]{3,64}$'),
  idempotency_key  text not null check (idempotency_key ~ '^[A-Za-z0-9_-]{16,128}$'),
  request_hash     text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  tool_name        text not null check (tool_name ~ '^[a-z][a-z0-9_]{2,63}$'),
  tool_version     text not null check (tool_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  status           text not null check (status in ('IN_PROGRESS', 'COMPLETED', 'RELEASED')),
  response         jsonb null,
  lease_until      timestamptz null,
  created_at       timestamptz not null,
  completed_at     timestamptz null,
  expires_at       timestamptz not null,
  updated_at       timestamptz not null,
  primary key (tenant_id, integration_id, idempotency_key),
  constraint tool_request_idempotency_completed_has_response check (
    (status = 'COMPLETED') = (response is not null)),
  constraint tool_request_idempotency_response_object check (
    response is null or jsonb_typeof(response) = 'object'),
  constraint tool_request_idempotency_expiry check (expires_at > created_at)
);

create index tool_request_idempotency_expiry on tool_request_idempotency (tenant_id, expires_at);

create or replace function tool_request_idempotency_guard() returns trigger language plpgsql as $$
begin
  if new.tenant_id is distinct from old.tenant_id
     or new.integration_id is distinct from old.integration_id
     or new.idempotency_key is distinct from old.idempotency_key then
    raise exception 'TOOL_IDEMPOTENCY_IMMUTABLE_KEY' using errcode = 'check_violation';
  end if;
  -- A live (unexpired) key is bound to exactly one request hash, and a stored result is final.
  if old.expires_at > new.updated_at then
    if new.request_hash is distinct from old.request_hash then
      raise exception 'TOOL_IDEMPOTENCY_KEY_REBIND' using errcode = 'check_violation';
    end if;
    if old.status = 'COMPLETED' then
      raise exception 'TOOL_IDEMPOTENCY_RESULT_FINAL' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end
$$;

create trigger tool_request_idempotency_guard
  before update on tool_request_idempotency
  for each row execute function tool_request_idempotency_guard();

alter table tool_request_idempotency enable row level security;
alter table tool_request_idempotency force row level security;

create policy tool_request_idempotency_runtime_tenant on tool_request_idempotency for all to app_runtime
  using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy tool_request_idempotency_worker_tenant on tool_request_idempotency for all to app_worker
  using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());

-- Runtime may not delete; only the worker purges expired rows.
grant select, insert, update on tool_request_idempotency to app_runtime;
grant select, delete on tool_request_idempotency to app_worker;
