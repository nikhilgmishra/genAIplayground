-- 2050 workforce SSO sessions of the console (WP-05; follow-on FO-01-09, FO-05-09, FO-05-10, FO-05-11,
-- FO-05-13, FO-05-18, FO-05-19, FO-05-41, FO-14-02, FO-14-52; AUTH-02, AUTH-03, AUTH-04, AUTH-06, DATA-01).
--
--   console_login_transactions  the single-use record of a sealed login state (FO-05-10): the binding of
--                               nonce, PKCE challenge and exact redirect URI travels in the authenticated state
--                               itself (login-state.ts), the start endpoint writes nothing, and the exchange
--                               inserts the state's hash already consumed (primary key: a replayed or raced
--                               callback finds it and is refused). Rows outlive their state only until the
--                               sweeper deletes them after expiry.
--   console_sessions            the console session the backend issues after the code exchange. The browser
--                               holds only an opaque bearer (`vcs_` + 256 random bits); this table stores its
--                               sha256. Idle expiry (last_activity_at + idle_timeout_seconds), absolute
--                               expiry, revocation, refresh rotation (rotated_to) and the generation of the
--                               session family are enforced by the console API on EVERY request, whatever a
--                               storage TTL does (AUTH-04). The IdP refresh token is kept only sealed
--                               (AES-256-GCM, AAD bound to the session hash; key outside the database).
--
-- Content: opaque ids, sha256 digests, role names, amr values, timestamps, reason codes and the sealed
-- refresh token. Never an IdP subject in clear, a name, an e-mail address, an authorization code, a state,
-- a nonce or an unsealed token.

create table console_login_transactions (
  state_hash         text        primary key check (state_hash ~ '^[a-f0-9]{64}$'),
  tenant_id          text        not null check (tenant_id ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  issuer_digest      text        not null check (issuer_digest ~ '^[a-f0-9]{64}$'),
  nonce_hash         text        not null check (nonce_hash ~ '^[a-f0-9]{64}$'),
  code_challenge     text        not null check (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  redirect_uri       text        not null check (redirect_uri ~ '^https://[A-Za-z0-9.-]{1,253}(:[0-9]{2,5})?/[A-Za-z0-9._~/-]{0,200}$'),
  created_at         timestamptz not null,
  expires_at         timestamptz not null,
  consumed_at        timestamptz,
  outcome            text        check (outcome is null or outcome ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  constraint console_login_tx_window check (expires_at > created_at and expires_at <= created_at + interval '30 minutes'),
  constraint console_login_tx_consumed_shape check ((consumed_at is null) = (outcome is null))
);

create index console_login_tx_expiry on console_login_transactions (tenant_id, expires_at);

create or replace function console_login_tx_before_update() returns trigger language plpgsql as $$
begin
  -- Single use: only the one-time consumption may change a row.
  if old.consumed_at is not null then
    raise exception 'CONSOLE_LOGIN_TRANSACTION_CONSUMED' using errcode = '42501';
  end if;
  if new.state_hash is distinct from old.state_hash or new.tenant_id is distinct from old.tenant_id
     or new.issuer_digest is distinct from old.issuer_digest or new.nonce_hash is distinct from old.nonce_hash
     or new.code_challenge is distinct from old.code_challenge or new.redirect_uri is distinct from old.redirect_uri
     or new.created_at is distinct from old.created_at or new.expires_at is distinct from old.expires_at then
    raise exception 'CONSOLE_LOGIN_TRANSACTION_IMMUTABLE' using errcode = '42501';
  end if;
  return new;
end
$$;

create trigger console_login_tx_update before update on console_login_transactions
  for each row execute function console_login_tx_before_update();

create table console_sessions (
  session_hash          text        primary key check (session_hash ~ '^[a-f0-9]{64}$'),
  family_id             text        not null check (family_id ~ '^csf_[A-Za-z0-9_-]{16,64}$'),
  generation            integer     not null check (generation between 1 and 100000),
  kind                  text        not null check (kind in ('OIDC_SSO', 'RECOVERY')),
  tenant_id             text        not null check (tenant_id ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  staff_id              text        not null check (staff_id ~ '^stf_[A-Za-z0-9_-]{8,64}$'),
  issuer_digest         text        not null check (issuer_digest ~ '^[a-f0-9]{64}$'),
  -- sha256 over (issuer, subject): equality checks only; the subject itself is not stored.
  subject_digest        text        not null check (subject_digest ~ '^[a-f0-9]{64}$'),
  roles                 text[]      not null check (cardinality(roles) between 1 and 8),
  amr                   text[]      not null check (cardinality(amr) between 1 and 16),
  authenticated_at      timestamptz not null,
  auth_time_epoch       bigint      check (auth_time_epoch is null or auth_time_epoch > 0),
  nonce_hash            text        check (nonce_hash is null or nonce_hash ~ '^[a-f0-9]{64}$'),
  created_at            timestamptz not null,
  last_activity_at      timestamptz not null,
  idle_timeout_seconds  integer     not null check (idle_timeout_seconds between 60 and 86400),
  absolute_expires_at   timestamptz not null,
  -- Directory/IdP active-state evidence (FO-14-52): when the IdP last confirmed the session active.
  active_checked_at     timestamptz not null,
  refresh_ciphertext    bytea,
  refresh_iv            bytea,
  refresh_tag           bytea,
  refresh_key_id        text        check (refresh_key_id is null or refresh_key_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  refresh_expires_at    timestamptz,
  -- A refresh of THIS row is in flight (claimed before the IdP redeems the refresh token, released when it ends
  -- without a recorded redemption; a crashed refresh's claim lapses after the in-flight window, sso.ts): at most one
  -- refresh per row reaches the IdP, and a request whose active check meets it is refused retryable, never decided.
  refresh_started_at    timestamptz,
  rotated_at            timestamptz,
  rotated_to            text        check (rotated_to is null or rotated_to ~ '^[a-f0-9]{64}$'),
  revoked_at            timestamptz,
  revoke_reason         text        check (revoke_reason is null or revoke_reason ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  audit_event_id        text        not null check (audit_event_id ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  constraint console_sessions_lifetime check (absolute_expires_at > created_at and absolute_expires_at <= created_at + interval '24 hours'),
  constraint console_sessions_refresh_shape check (
    (refresh_ciphertext is null and refresh_iv is null and refresh_tag is null and refresh_key_id is null)
    or (refresh_ciphertext is not null and refresh_iv is not null and refresh_tag is not null and refresh_key_id is not null)),
  constraint console_sessions_recovery_no_refresh check (kind <> 'RECOVERY' or refresh_ciphertext is null),
  constraint console_sessions_rotation_shape check ((rotated_at is null) = (rotated_to is null)),
  constraint console_sessions_revocation_shape check ((revoked_at is null) = (revoke_reason is null))
);

create index console_sessions_family on console_sessions (tenant_id, family_id, generation desc);
create index console_sessions_staff on console_sessions (tenant_id, staff_id) where revoked_at is null;

create or replace function console_sessions_before_update() returns trigger language plpgsql as $$
begin
  -- Identity, lineage and lifetime are fixed at issuance.
  if new.session_hash is distinct from old.session_hash or new.family_id is distinct from old.family_id
     or new.generation is distinct from old.generation or new.kind is distinct from old.kind
     or new.tenant_id is distinct from old.tenant_id or new.staff_id is distinct from old.staff_id
     or new.issuer_digest is distinct from old.issuer_digest or new.subject_digest is distinct from old.subject_digest
     or new.authenticated_at is distinct from old.authenticated_at or new.auth_time_epoch is distinct from old.auth_time_epoch
     or new.nonce_hash is distinct from old.nonce_hash or new.created_at is distinct from old.created_at
     or new.idle_timeout_seconds is distinct from old.idle_timeout_seconds or new.absolute_expires_at is distinct from old.absolute_expires_at
     or new.audit_event_id is distinct from old.audit_event_id then
    raise exception 'CONSOLE_SESSION_IMMUTABLE' using errcode = '42501';
  end if;
  -- Revocation and rotation are one-way.
  if old.revoked_at is not null and (new.revoked_at is distinct from old.revoked_at or new.revoke_reason is distinct from old.revoke_reason) then
    raise exception 'CONSOLE_SESSION_REVOCATION_FINAL' using errcode = '42501';
  end if;
  if old.rotated_at is not null and (new.rotated_at is distinct from old.rotated_at or new.rotated_to is distinct from old.rotated_to) then
    raise exception 'CONSOLE_SESSION_ROTATION_FINAL' using errcode = '42501';
  end if;
  -- Activity never moves backwards (a delayed write cannot extend an expired idle window into the past).
  if new.last_activity_at < old.last_activity_at or new.active_checked_at < old.active_checked_at then
    raise exception 'CONSOLE_SESSION_TIME_REGRESSION' using errcode = '42501';
  end if;
  return new;
end
$$;

create trigger console_sessions_update before update on console_sessions
  for each row execute function console_sessions_before_update();
create trigger console_sessions_no_delete before delete on console_sessions
  for each row execute function console_append_only();
create trigger console_sessions_no_truncate before truncate on console_sessions
  for each statement execute function console_append_only();
create trigger console_login_tx_no_delete before delete on console_login_transactions
  for each row execute function console_append_only();

alter table console_login_transactions enable row level security;
alter table console_login_transactions force row level security;
alter table console_sessions enable row level security;
alter table console_sessions force row level security;

create policy console_login_tx_rw on console_login_transactions for all
  to app_console using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy console_sessions_read on console_sessions for select
  to app_console using (tenant_id = app_tenant());
create policy console_sessions_insert on console_sessions for insert
  to app_console with check (tenant_id = app_tenant() and staff_id = app_actor());
create policy console_sessions_update on console_sessions for update
  to app_console using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());

revoke all on console_login_transactions, console_sessions from public;
grant select, insert on console_login_transactions to app_console;
-- No update grant: a login-state row is inserted already consumed and never changes (trigger above as well).
grant select, insert on console_sessions to app_console;
grant update (last_activity_at, active_checked_at, roles, refresh_ciphertext, refresh_iv, refresh_tag, refresh_key_id, refresh_expires_at,
              refresh_started_at, rotated_at, rotated_to, revoked_at, revoke_reason) on console_sessions to app_console;
grant select (session_hash, tenant_id, staff_id, kind, created_at, last_activity_at, absolute_expires_at, rotated_at, revoked_at, revoke_reason)
  on console_sessions to app_auditor;
create policy console_sessions_auditor_read on console_sessions for select to app_auditor using (tenant_id = app_tenant());

revoke all on function console_login_tx_before_update(), console_sessions_before_update() from public;
