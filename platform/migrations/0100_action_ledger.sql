-- Action ledger (spec section 8 "Preparing and committing changes"; ACT-01, ACT-02, ACT-03, OPS-01).
--
-- One row per prepared consequential action. The session bearer value is NEVER stored:
-- only sha256(sessionRef) (session_ref_hash). Times come from the application's injectable
-- clock, not now(), so expiry decisions are deterministic and testable.
--
-- Defence in depth: a BEFORE trigger enforces the state machine, immutability of every
-- prepared (digest-covered) field and the optimistic-concurrency row version, so an
-- application bug cannot silently rewrite a confirmed action or resurrect a terminal one.

create table action_ledger (
  action_id                 text primary key check (action_id ~ '^act_[A-Za-z0-9_-]{16,64}$'),
  tenant_id                 text not null check (tenant_id ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  session_ref_hash          text not null check (session_ref_hash ~ '^[a-f0-9]{64}$'),
  session_generation        integer not null check (session_generation >= 1),
  call_id                   text not null,
  actor_id                  text not null,
  actor_role                text null,
  subject_id                text not null,
  kind                      text not null check (kind in (
                              'appointment.reschedule', 'appointment.create', 'appointment.cancel',
                              'billing.review.submit', 'support_request.create', 'callback.schedule')),
  target                    jsonb not null,
  change                    jsonb not null,
  impact                    jsonb not null,
  digest                    text not null check (digest ~ '^[a-f0-9]{64}$'),
  state                     text not null check (state in (
                              'PREPARED', 'CONFIRMED', 'COMMITTING', 'COMMITTED', 'FAILED',
                              'UNKNOWN', 'INVALIDATED', 'EXPIRED', 'CANCELLED')),
  state_reason              text null check (state_reason is null or state_reason ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  policy_decision_id        text not null,
  policy_version            text not null,
  policy_obligations        jsonb not null default '[]'::jsonb,
  requires_step_up          boolean not null,
  confirmation_template_id  text not null,
  prepared_assurance        text not null check (prepared_assurance in ('A0', 'A1', 'A2', 'A3')),
  prepared_at               timestamptz not null,
  expires_at                timestamptz not null,
  -- Trusted confirmation evidence (never contains the session bearer value).
  confirmation              jsonb null,
  -- Freshness anchor: min(capturedAt, receivedAt).
  confirmed_at              timestamptz null,
  -- Stable per action (derived from action_id); the provider deduplicates on it (ACT-02).
  provider_idempotency_key  text not null unique check (length(provider_idempotency_key) between 16 and 128),
  commit_attempt_id         text null,
  commit_attempts           integer not null default 0 check (commit_attempts >= 0),
  committing_since          timestamptz null,
  reconcile_attempts        integer not null default 0 check (reconcile_attempts >= 0),
  last_reconciled_at        timestamptz null,
  receipt                   jsonb null,
  -- Optimistic concurrency: every update must increment by exactly one (trigger-enforced).
  row_version               integer not null default 1 check (row_version >= 1),
  created_at                timestamptz not null,
  updated_at                timestamptz not null,

  constraint action_ledger_target_shape check (
    jsonb_typeof(target) = 'object' and target ? 'system' and target ? 'recordType'
    and target ? 'recordRef' and target ? 'beforeVersion'),
  constraint action_ledger_change_shape check (jsonb_typeof(change) = 'object'),
  constraint action_ledger_impact_shape check (jsonb_typeof(impact) = 'object'),
  constraint action_ledger_expiry_after_prepare check (expires_at > prepared_at),
  -- No COMMITTED without an authoritative receipt.
  constraint action_ledger_committed_has_receipt check (state <> 'COMMITTED' or receipt is not null),
  constraint action_ledger_receipt_only_when_committed check (receipt is null or state = 'COMMITTED'),
  constraint action_ledger_committing_has_attempt check (
    state <> 'COMMITTING' or (commit_attempt_id is not null and committing_since is not null)),
  -- Nothing reaches the commit phase without a recorded trusted confirmation.
  constraint action_ledger_confirmed_has_confirmation check (
    state not in ('CONFIRMED', 'COMMITTING', 'UNKNOWN', 'COMMITTED', 'FAILED')
    or (confirmation is not null and confirmed_at is not null))
);

-- At most one in-doubt commit (COMMITTING or UNKNOWN) per target record: a second action on the
-- same record cannot start its provider call while another's outcome is unresolved (ACT-03).
create unique index action_ledger_one_in_doubt_per_record
  on action_ledger (tenant_id, (target ->> 'system'), (target ->> 'recordRef'))
  where state in ('COMMITTING', 'UNKNOWN');

create index action_ledger_pending_by_session
  on action_ledger (tenant_id, session_ref_hash)
  where state in ('PREPARED', 'CONFIRMED');

create index action_ledger_reconciliation
  on action_ledger (tenant_id, state, updated_at)
  where state in ('COMMITTING', 'UNKNOWN');

create index action_ledger_expiry
  on action_ledger (tenant_id, expires_at)
  where state in ('PREPARED', 'CONFIRMED');

create or replace function action_ledger_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.state <> 'PREPARED' or new.row_version <> 1 or new.receipt is not null
       or new.confirmation is not null or new.commit_attempt_id is not null then
      raise exception 'ACTION_LEDGER_INVALID_INSERT' using errcode = 'check_violation';
    end if;
    return new;
  end if;

  -- Terminal states are immutable.
  if old.state in ('COMMITTED', 'FAILED') then
    raise exception 'ACTION_LEDGER_TERMINAL_STATE' using errcode = 'check_violation';
  end if;

  -- Every digest-covered (prepared) field and the bindings are immutable.
  if new.action_id is distinct from old.action_id
     or new.tenant_id is distinct from old.tenant_id
     or new.session_ref_hash is distinct from old.session_ref_hash
     or new.session_generation is distinct from old.session_generation
     or new.call_id is distinct from old.call_id
     or new.actor_id is distinct from old.actor_id
     or new.actor_role is distinct from old.actor_role
     or new.subject_id is distinct from old.subject_id
     or new.kind is distinct from old.kind
     or new.target is distinct from old.target
     or new.change is distinct from old.change
     or new.impact is distinct from old.impact
     or new.digest is distinct from old.digest
     or new.policy_decision_id is distinct from old.policy_decision_id
     or new.policy_version is distinct from old.policy_version
     or new.policy_obligations is distinct from old.policy_obligations
     or new.requires_step_up is distinct from old.requires_step_up
     or new.confirmation_template_id is distinct from old.confirmation_template_id
     or new.prepared_assurance is distinct from old.prepared_assurance
     or new.prepared_at is distinct from old.prepared_at
     or new.expires_at is distinct from old.expires_at
     or new.provider_idempotency_key is distinct from old.provider_idempotency_key
     or new.created_at is distinct from old.created_at then
    raise exception 'ACTION_LEDGER_IMMUTABLE_FIELD' using errcode = 'check_violation';
  end if;

  -- A recorded confirmation cannot be replaced once the action left PREPARED.
  if old.confirmation is not null and new.confirmation is distinct from old.confirmation then
    raise exception 'ACTION_LEDGER_CONFIRMATION_IMMUTABLE' using errcode = 'check_violation';
  end if;

  if new.row_version <> old.row_version + 1 then
    raise exception 'ACTION_LEDGER_ROW_VERSION' using errcode = 'serialization_failure';
  end if;

  if not (
       (old.state = 'PREPARED'    and new.state in ('CONFIRMED', 'INVALIDATED', 'EXPIRED', 'CANCELLED'))
    or (old.state = 'CONFIRMED'   and new.state in ('COMMITTING', 'INVALIDATED', 'EXPIRED', 'CANCELLED', 'COMMITTED'))
    or (old.state = 'COMMITTING'  and new.state in ('COMMITTED', 'UNKNOWN', 'FAILED', 'CONFIRMED', 'EXPIRED', 'INVALIDATED'))
    or (old.state = 'UNKNOWN'     and new.state in ('COMMITTED', 'UNKNOWN', 'CONFIRMED', 'EXPIRED'))
    -- Late authoritative provider evidence always wins over a local revert (truth is recorded, never hidden).
    or (old.state in ('EXPIRED', 'INVALIDATED', 'CANCELLED') and new.state = 'COMMITTED')
  ) then
    raise exception 'ACTION_LEDGER_ILLEGAL_TRANSITION' using errcode = 'check_violation';
  end if;

  return new;
end
$$;

create trigger action_ledger_guard
  before insert or update on action_ledger
  for each row execute function action_ledger_guard();

-- Locator: resolves an opaque action id or session hash to its tenant for the two port
-- operations that carry no tenant (reconcile(actionId), invalidatePending(sessionRef)).
-- Holds only opaque ids, tenant ids and session hashes. Readable across tenants by the
-- worker role only; every ledger access after resolution runs inside that tenant's RLS context.
create table action_locator (
  action_id        text primary key references action_ledger (action_id),
  tenant_id        text not null,
  session_ref_hash text not null check (session_ref_hash ~ '^[a-f0-9]{64}$'),
  created_at       timestamptz not null
);
create index action_locator_by_session on action_locator (session_ref_hash);

alter table action_ledger enable row level security;
alter table action_ledger force row level security;
alter table action_locator enable row level security;
alter table action_locator force row level security;

create policy action_ledger_runtime_tenant on action_ledger for all to app_runtime
  using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy action_ledger_worker_tenant on action_ledger for all to app_worker
  using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());

create policy action_locator_runtime_tenant on action_locator for all to app_runtime
  using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy action_locator_worker_resolve on action_locator for select to app_worker
  using (true);

-- Least privilege: no DELETE for any runtime role; the ledger is append/transition only.
grant select, insert, update on action_ledger to app_runtime;
grant select, update on action_ledger to app_worker;
grant select, insert on action_locator to app_runtime;
grant select on action_locator to app_worker;
