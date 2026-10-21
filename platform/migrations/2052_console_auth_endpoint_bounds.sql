-- 2052 bounds for the unauthenticated console auth endpoints (WP-05; STRIDE D rows of
-- docs/security/threats/proposed/WP-05-threats.md).
--
--   console_login_transactions   the start endpoint writes NOTHING (the binding travels in the sealed state,
--                                platform/src/console-api/login-state.ts), so an anonymous flood of starts cannot
--                                fill this table or lock operators out. The exchange inserts one row per valid,
--                                unexpired state it redeems (single use), and the sweeper deletes rows whose
--                                state has expired: an expired state is refused before the table is consulted,
--                                so deleting an EXPIRED row is safe; deleting a live one is still refused by the
--                                database (trigger below).
--   console_recovery_activations the challenge endpoint verifies the requester's signature first (anonymous
--                                requests consume nothing), then counts the identity's pending and recent
--                                activations against fixed caps before it inserts one (index below). Activations
--                                are evidence of the recovery path and are never deleted.
--   console_sessions             index for a custodian's latest positive IdP evidence (below).

-- A recovery custodian's latest positive IdP evidence (sign-in, refresh or active check of an SSO session) and
-- the roles the directory mapped then (recovery.ts: enrollment and activation require it to be recent).
create index console_sessions_staff_evidence on console_sessions (tenant_id, staff_id, kind, active_checked_at desc);
create index console_rca_identity_created on console_recovery_activations (identity_id, created_at);

-- Replaces the blanket no-delete trigger of migration 2050: only an expired transaction may be deleted.
drop trigger console_login_tx_no_delete on console_login_transactions;

create or replace function console_login_tx_before_delete() returns trigger language plpgsql as $$
begin
  if old.expires_at >= now() then
    raise exception 'CONSOLE_LOGIN_TRANSACTION_LIVE' using errcode = '42501';
  end if;
  return old;
end
$$;

create trigger console_login_tx_delete_expired_only before delete on console_login_transactions
  for each row execute function console_login_tx_before_delete();
create trigger console_login_tx_no_truncate before truncate on console_login_transactions
  for each statement execute function console_append_only();

revoke all on function console_login_tx_before_delete() from public;

-- The sweeper's purge; row-level security (console_login_tx_rw, for all) keeps it to the tenant.
grant delete on console_login_transactions to app_console;
