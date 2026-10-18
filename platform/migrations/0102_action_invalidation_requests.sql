-- Durable invalidation requests for in-doubt actions (spec section 8: "An interruption, changed
-- request, ambiguous confirmation, identity change or expired preparation invalidates the pending
-- action"; spec section 10: a safety concern revokes pending nonessential mutations; ACT-01, ACT-03).
--
-- A barge-in, changed request, identity change, safety escalation or call end can arrive while an
-- action is IN DOUBT (COMMITTING or UNKNOWN). Its outcome is unknown, so it cannot simply be marked
-- INVALIDATED: the effect may already exist and must be reconciled first (ACT-03). The request is
-- therefore recorded durably on the row, and the reconciliation honours it:
--   * provider NOT_FOUND  -> INVALIDATED (never back to CONFIRMED, never committed later);
--   * provider COMMITTED  -> COMMITTED (truth is recorded, never hidden; compensation is domain-owned);
--   * a provably-not-sent attempt (COMMITTING -> NOT_STARTED) -> INVALIDATED instead of CONFIRMED.
-- Once recorded, an invalidation request is immutable and the row can never re-enter the commit
-- phase (CONFIRMED / COMMITTING). Content rules: a timestamp and a closed-set reason code only.

alter table action_ledger add column invalidation_requested_at timestamptz null;
alter table action_ledger add column invalidation_reason text null
  check (invalidation_reason is null or invalidation_reason ~ '^[A-Z][A-Z0-9_]{2,63}$');
alter table action_ledger add constraint action_ledger_invalidation_request_shape
  check ((invalidation_requested_at is null) = (invalidation_reason is null));

-- Same guard as 0100 plus: UNKNOWN -> INVALIDATED (a reconciled NOT_FOUND of an action whose
-- invalidation was requested while in doubt), immutability of a recorded invalidation request,
-- and no return to the commit phase for a row that carries one.
create or replace function action_ledger_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.state <> 'PREPARED' or new.row_version <> 1 or new.receipt is not null
       or new.confirmation is not null or new.commit_attempt_id is not null
       or new.invalidation_requested_at is not null or new.invalidation_reason is not null then
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

  -- A recorded invalidation request is permanent (it can be neither cleared nor rewritten).
  if old.invalidation_requested_at is not null
     and (new.invalidation_requested_at is distinct from old.invalidation_requested_at
          or new.invalidation_reason is distinct from old.invalidation_reason) then
    raise exception 'ACTION_LEDGER_INVALIDATION_IMMUTABLE' using errcode = 'check_violation';
  end if;

  -- An invalidation request is recorded only on an in-doubt row (pending rows are invalidated directly).
  if old.invalidation_requested_at is null and new.invalidation_requested_at is not null
     and old.state not in ('COMMITTING', 'UNKNOWN') then
    raise exception 'ACTION_LEDGER_INVALIDATION_NOT_IN_DOUBT' using errcode = 'check_violation';
  end if;

  -- A row that carries an invalidation request never re-enters the commit phase.
  if new.invalidation_requested_at is not null and new.state in ('CONFIRMED', 'COMMITTING') and new.state is distinct from old.state then
    raise exception 'ACTION_LEDGER_INVALIDATION_REQUESTED' using errcode = 'check_violation';
  end if;

  -- COMMITTING -> COMMITTING exists only to record an invalidation request: the attempt is unchanged.
  if old.state = 'COMMITTING' and new.state = 'COMMITTING'
     and (new.commit_attempt_id is distinct from old.commit_attempt_id or new.committing_since is distinct from old.committing_since
          or new.invalidation_requested_at is not distinct from old.invalidation_requested_at) then
    raise exception 'ACTION_LEDGER_COMMIT_ATTEMPT_IMMUTABLE' using errcode = 'check_violation';
  end if;

  if new.row_version <> old.row_version + 1 then
    raise exception 'ACTION_LEDGER_ROW_VERSION' using errcode = 'serialization_failure';
  end if;

  if not (
       (old.state = 'PREPARED'    and new.state in ('CONFIRMED', 'INVALIDATED', 'EXPIRED', 'CANCELLED'))
    or (old.state = 'CONFIRMED'   and new.state in ('COMMITTING', 'INVALIDATED', 'EXPIRED', 'CANCELLED', 'COMMITTED'))
    or (old.state = 'COMMITTING'  and new.state in ('COMMITTING', 'COMMITTED', 'UNKNOWN', 'FAILED', 'CONFIRMED', 'EXPIRED', 'INVALIDATED'))
    or (old.state = 'UNKNOWN'     and new.state in ('COMMITTED', 'UNKNOWN', 'CONFIRMED', 'EXPIRED', 'INVALIDATED'))
    -- Late authoritative provider evidence always wins over a local revert (truth is recorded, never hidden).
    or (old.state in ('EXPIRED', 'INVALIDATED', 'CANCELLED') and new.state = 'COMMITTED')
  ) then
    raise exception 'ACTION_LEDGER_ILLEGAL_TRANSITION' using errcode = 'check_violation';
  end if;

  return new;
end
$$;

-- In-doubt rows of a session (for durable invalidation requests on barge-in / change / call end).
create index action_ledger_in_doubt_by_session
  on action_ledger (tenant_id, session_ref_hash)
  where state in ('COMMITTING', 'UNKNOWN');
