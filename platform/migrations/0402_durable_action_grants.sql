-- Durable action grants (spec section 7: "Asynchronous workflows use a narrowly authorized
-- durable action grant; they do not reuse an expired call token as unlimited authority").
--
-- A grant is minted by the trusted backend when durable work is accepted. It names the
-- subject and (optionally) the actor it was issued for, the closed list of dotted action
-- names it authorizes (e.g. billing.review.commit), an expiry and the opaque source record
-- that justified it. Guarded workflow transitions (disclosure / material change) require a
-- valid, unexpired, unrevoked grant for exactly their declared action.
--
-- NO PHI COLUMNS: opaque identifiers, dotted code tokens, reason codes and timestamps only,
-- each enforced by a CHECK constraint. The grant id is opaque and carries no meaning; it is a
-- reference, not a bearer secret (possession of a grant id authorizes nothing by itself: only
-- trusted backend code checks it, inside the tenant's RLS context).
--
-- Lifecycle: grants are append-only except for a single revocation (revoked_at +
-- revoked_reason, set once and never cleared). Nobody may delete a grant (trigger); retention
-- of grant rows follows the SECURITY_AUDIT class once counsel sets a duration.

create or replace function grant_actions_valid(actions text[]) returns boolean
  language sql immutable as
$$ select coalesce(bool_and(a ~ '^[a-z][a-z0-9_]{1,31}(\.[a-z][a-z0-9_]{1,31}){1,4}$' and a !~ '[0-9]{4,}'), false)
     and cardinality(actions) = (select count(distinct x) from unnest(actions) as x)
   from unnest(actions) as a $$;

create table durable_action_grants (
  grant_id        text        primary key check (grant_id ~ '^grt_[A-Za-z0-9_-]{16,64}$'),
  tenant_id       text        not null check (tenant_id ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  subject_id      text        not null check (subject_id ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  actor_id        text        null check (actor_id is null or actor_id ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  actions         text[]      not null check (cardinality(actions) between 1 and 16 and grant_actions_valid(actions)),
  source_ref      text        not null check (source_ref ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'
                                              or source_ref ~ '^SR-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$'),
  issued_at       timestamptz not null,
  expires_at      timestamptz not null,
  revoked_at      timestamptz null,
  revoked_reason  text        null check (revoked_reason is null or (revoked_reason ~ '^[A-Z][A-Z0-9_]{2,63}$' and revoked_reason !~ '[0-9]{4,}')),
  constraint durable_action_grants_expiry_after_issue check (expires_at > issued_at),
  constraint durable_action_grants_revocation_shape check ((revoked_at is null) = (revoked_reason is null)),
  constraint durable_action_grants_revoked_after_issue check (revoked_at is null or revoked_at >= issued_at),
  unique (tenant_id, grant_id)
);
create index durable_action_grants_subject on durable_action_grants (tenant_id, subject_id, expires_at);

-- Defence in depth: only a single revocation may change a grant; nothing may delete one.
create or replace function durable_action_grants_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'DURABLE_GRANT_APPEND_ONLY' using errcode = '42501';
  end if;
  if new.grant_id is distinct from old.grant_id or new.tenant_id is distinct from old.tenant_id
     or new.subject_id is distinct from old.subject_id or new.actor_id is distinct from old.actor_id
     or new.actions is distinct from old.actions or new.source_ref is distinct from old.source_ref
     or new.issued_at is distinct from old.issued_at or new.expires_at is distinct from old.expires_at then
    raise exception 'DURABLE_GRANT_IMMUTABLE_FIELD' using errcode = '42501';
  end if;
  if old.revoked_at is not null and (new.revoked_at is distinct from old.revoked_at or new.revoked_reason is distinct from old.revoked_reason) then
    raise exception 'DURABLE_GRANT_REVOCATION_FINAL' using errcode = '42501';
  end if;
  return new;
end
$$;

create trigger durable_action_grants_guard
  before update or delete on durable_action_grants
  for each row execute function durable_action_grants_guard();
create or replace function durable_action_grants_no_truncate() returns trigger language plpgsql as
$$ begin raise exception 'DURABLE_GRANT_APPEND_ONLY' using errcode = '42501'; end $$;
create trigger durable_action_grants_no_truncate
  before truncate on durable_action_grants
  for each statement execute function durable_action_grants_no_truncate();

alter table durable_action_grants enable row level security;
alter table durable_action_grants force row level security;

create policy durable_action_grants_tenant on durable_action_grants
  for all to app_runtime, app_worker
  using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy durable_action_grants_console_read on durable_action_grants
  for select to app_console, app_auditor using (tenant_id = app_tenant());

revoke all on durable_action_grants from public;
-- Issued by the runtime when durable work is accepted (same transaction as the acceptance).
grant select, insert on durable_action_grants to app_runtime;
grant select on durable_action_grants to app_worker, app_console, app_auditor;
-- Revocation only (consent withdrawn, representation ended, account recovery, fraud or safety).
grant update (revoked_at, revoked_reason) on durable_action_grants to app_runtime, app_worker;
grant execute on function grant_actions_valid(text[]) to app_runtime, app_worker, app_console, app_auditor;
