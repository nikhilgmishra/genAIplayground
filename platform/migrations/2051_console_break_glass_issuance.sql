-- 2051 break-glass issuance, post-use access reviews and dual-controlled SSO-outage recovery identities
-- (WP-05; follow-on FO-05-45, FO-14-51, FO-05-44; AUTH-02, OPS-01).
--
--   console_break_glass_requests  a staff member's request for time-bound emergency access. Grants nothing
--                                 by itself; only an independent security_admin decision (never the
--                                 requester: policy SELF_APPROVAL_PROHIBITED and the check below) issues a
--                                 row of console_break_glass_grants (migration 0900), in the same
--                                 transaction as the decision and its audit event.
--   console_access_reviews        post-use review tasks: opened when a break-glass grant is first used
--                                 (restricted_record:view allowed under it, obligation BREAK_GLASS_REVIEW)
--                                 or a recovery session is activated; completed by a reviewer who is
--                                 neither the holder nor the approver.
--   console_recovery_identities   SSO-outage recovery custodians: a hardware-held public key per staff
--                                 member, outside the primary IdP, proposed by one security_admin, CONFIRMED
--                                 by the holder (a signature by that key over a one-time enrollment challenge,
--                                 made while signed in by SSO as that staff member: proof of possession bound
--                                 to the IdP identity) and only then approved by another security_admin
--                                 (neither may be the holder). SUSPENDED while the workforce IdP no longer
--                                 vouches for the holder (offboarding signal, recovery.ts / sso.ts); back to
--                                 ACTIVE only by the holder's next SSO sign-in that maps every identity role.
--   console_recovery_activations  one activation attempt: requested with a signature by the requester's key
--                                 (its nonce is single use), then a random challenge that TWO different active
--                                 custodians must sign (dual control) before a short recovery session is issued.
--
-- Content: opaque ids, staff ids, reason codes, public keys (never private material), digests and times.

create table console_break_glass_requests (
  request_id                 text        primary key check (request_id ~ '^bgr_[A-Za-z0-9_-]{16,64}$'),
  tenant_id                  text        not null check (tenant_id ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  requested_by               text        not null check (requested_by ~ '^stf_[A-Za-z0-9_-]{8,64}$'),
  justification_code         text        not null check (justification_code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  reason                     text        not null check (reason ~ '^[A-Z][A-Z0-9_]{2,63}(:[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64})?$'),
  requested_duration_seconds integer     not null check (requested_duration_seconds between 300 and 14400),
  requested_at               timestamptz not null,
  decide_by                  timestamptz not null,
  status                     text        not null check (status in ('PENDING', 'APPROVED', 'REJECTED')),
  decided_by                 text        check (decided_by is null or decided_by ~ '^stf_[A-Za-z0-9_-]{8,64}$'),
  decided_at                 timestamptz,
  decision_reason            text        check (decision_reason is null or decision_reason ~ '^[A-Z][A-Z0-9_]{2,63}(:[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64})?$'),
  grant_id                   text        references console_break_glass_grants (grant_id),
  request_audit_event_id     text        not null check (request_audit_event_id ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  decision_audit_event_id    text        check (decision_audit_event_id is null or decision_audit_event_id ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  constraint console_bgr_not_self_decided check (decided_by is null or decided_by <> requested_by),
  constraint console_bgr_window check (decide_by > requested_at and decide_by <= requested_at + interval '24 hours'),
  constraint console_bgr_decision_shape check (
    (status = 'PENDING' and decided_by is null and decided_at is null and decision_reason is null and grant_id is null and decision_audit_event_id is null)
    or (status = 'REJECTED' and decided_by is not null and decided_at is not null and decision_reason is not null and grant_id is null and decision_audit_event_id is not null)
    or (status = 'APPROVED' and decided_by is not null and decided_at is not null and decision_reason is not null and grant_id is not null and decision_audit_event_id is not null))
);

create index console_bgr_tenant_status on console_break_glass_requests (tenant_id, status, requested_at desc);

create or replace function console_bgr_before_update() returns trigger language plpgsql as $$
begin
  -- One decision, from PENDING only; the request itself is immutable.
  if old.status <> 'PENDING' then
    raise exception 'CONSOLE_BREAK_GLASS_REQUEST_DECIDED' using errcode = '42501';
  end if;
  if new.request_id is distinct from old.request_id or new.tenant_id is distinct from old.tenant_id
     or new.requested_by is distinct from old.requested_by or new.justification_code is distinct from old.justification_code
     or new.reason is distinct from old.reason or new.requested_duration_seconds is distinct from old.requested_duration_seconds
     or new.requested_at is distinct from old.requested_at or new.decide_by is distinct from old.decide_by
     or new.request_audit_event_id is distinct from old.request_audit_event_id then
    raise exception 'CONSOLE_BREAK_GLASS_REQUEST_IMMUTABLE' using errcode = '42501';
  end if;
  if new.decided_at is not null and new.decided_at > old.decide_by then
    raise exception 'CONSOLE_BREAK_GLASS_REQUEST_EXPIRED' using errcode = '42501';
  end if;
  return new;
end
$$;

create trigger console_bgr_update before update on console_break_glass_requests
  for each row execute function console_bgr_before_update();
create trigger console_bgr_no_delete before delete on console_break_glass_requests
  for each row execute function console_append_only();

create table console_access_reviews (
  review_id                  text        primary key check (review_id ~ '^acr_[A-Za-z0-9_-]{16,64}$'),
  tenant_id                  text        not null check (tenant_id ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  subject_kind               text        not null check (subject_kind in ('BREAK_GLASS_GRANT', 'RECOVERY_SESSION')),
  subject_ref                text        not null check (subject_ref ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  holder_staff_id            text        not null check (holder_staff_id ~ '^stf_[A-Za-z0-9_-]{8,64}$'),
  approver_staff_id          text        check (approver_staff_id is null or approver_staff_id ~ '^stf_[A-Za-z0-9_-]{8,64}$'),
  opened_at                  timestamptz not null,
  due_at                     timestamptz not null,
  first_use_audit_event_id   text        not null check (first_use_audit_event_id ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  status                     text        not null check (status in ('OPEN', 'COMPLETED')),
  outcome                    text        check (outcome is null or outcome in ('APPROPRIATE', 'INAPPROPRIATE', 'FOLLOW_UP_REQUIRED')),
  reason                     text        check (reason is null or reason ~ '^[A-Z][A-Z0-9_]{2,63}(:[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64})?$'),
  reviewer_staff_id          text        check (reviewer_staff_id is null or reviewer_staff_id ~ '^stf_[A-Za-z0-9_-]{8,64}$'),
  completed_at               timestamptz,
  completion_audit_event_id  text        check (completion_audit_event_id is null or completion_audit_event_id ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  unique (tenant_id, subject_kind, subject_ref),
  constraint console_acr_due check (due_at > opened_at),
  constraint console_acr_independent check (reviewer_staff_id is null or (reviewer_staff_id <> holder_staff_id and (approver_staff_id is null or reviewer_staff_id <> approver_staff_id))),
  constraint console_acr_completion_shape check (
    (status = 'OPEN' and outcome is null and reason is null and reviewer_staff_id is null and completed_at is null and completion_audit_event_id is null)
    or (status = 'COMPLETED' and outcome is not null and reason is not null and reviewer_staff_id is not null and completed_at is not null and completion_audit_event_id is not null))
);

create index console_acr_open on console_access_reviews (tenant_id, status, due_at);

create or replace function console_acr_before_update() returns trigger language plpgsql as $$
begin
  if old.status <> 'OPEN' then
    raise exception 'CONSOLE_ACCESS_REVIEW_COMPLETED' using errcode = '42501';
  end if;
  if new.review_id is distinct from old.review_id or new.tenant_id is distinct from old.tenant_id
     or new.subject_kind is distinct from old.subject_kind or new.subject_ref is distinct from old.subject_ref
     or new.holder_staff_id is distinct from old.holder_staff_id or new.approver_staff_id is distinct from old.approver_staff_id
     or new.opened_at is distinct from old.opened_at or new.due_at is distinct from old.due_at
     or new.first_use_audit_event_id is distinct from old.first_use_audit_event_id then
    raise exception 'CONSOLE_ACCESS_REVIEW_IMMUTABLE' using errcode = '42501';
  end if;
  return new;
end
$$;

create trigger console_acr_update before update on console_access_reviews
  for each row execute function console_acr_before_update();
create trigger console_acr_no_delete before delete on console_access_reviews
  for each row execute function console_append_only();

create table console_recovery_identities (
  identity_id      text        primary key check (identity_id ~ '^rci_[A-Za-z0-9_-]{16,64}$'),
  tenant_id        text        not null check (tenant_id ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  staff_id         text        not null check (staff_id ~ '^stf_[A-Za-z0-9_-]{8,64}$'),
  -- RFC 7638 thumbprint of the public key; one key belongs to one identity per tenant.
  key_thumbprint   text        not null check (key_thumbprint ~ '^[A-Za-z0-9_-]{43}$'),
  public_jwk       jsonb       not null check (jsonb_typeof(public_jwk) = 'object' and public_jwk ->> 'kty' = 'EC' and public_jwk ->> 'crv' = 'P-256'
                                               and public_jwk ? 'x' and public_jwk ? 'y' and (public_jwk - 'kty' - 'crv' - 'x' - 'y') = '{}'::jsonb),
  attestation_ref  text        not null check (attestation_ref ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  roles            text[]      not null check (cardinality(roles) between 1 and 3 and roles <@ array['security_admin', 'supervisor', 'safety_responder']::text[]),
  status           text        not null check (status in ('PROPOSED', 'ACTIVE', 'SUSPENDED', 'REVOKED')),
  proposed_by      text        not null check (proposed_by ~ '^stf_[A-Za-z0-9_-]{8,64}$'),
  proposed_at      timestamptz not null,
  -- sha256 of the one-time enrollment challenge (the challenge itself is shown once, to the proposer).
  enrollment_challenge_hash text not null check (enrollment_challenge_hash ~ '^[a-f0-9]{64}$'),
  enrollment_expires_at     timestamptz not null,
  -- The holder's proof of possession, made in an SSO session of staff_id (recovery.ts confirm).
  holder_confirmed_at       timestamptz,
  approved_by      text        check (approved_by is null or approved_by ~ '^stf_[A-Za-z0-9_-]{8,64}$'),
  approved_at      timestamptz,
  suspended_at     timestamptz,
  suspend_reason   text        check (suspend_reason is null or suspend_reason ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  revoked_by       text        check (revoked_by is null or revoked_by ~ '^stf_[A-Za-z0-9_-]{8,64}$'),
  revoked_at       timestamptz,
  revoke_reason    text        check (revoke_reason is null or revoke_reason ~ '^[A-Z][A-Z0-9_]{2,63}(:[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64})?$'),
  unique (tenant_id, key_thumbprint),
  constraint console_rci_dual_control check (approved_by is null or (approved_by <> proposed_by and approved_by <> staff_id)),
  constraint console_rci_not_self_proposed check (proposed_by <> staff_id),
  constraint console_rci_approval_shape check ((approved_by is null) = (approved_at is null)),
  constraint console_rci_enrollment_window check (enrollment_expires_at > proposed_at and enrollment_expires_at <= proposed_at + interval '7 days'),
  constraint console_rci_confirmation_window check (holder_confirmed_at is null or (holder_confirmed_at >= proposed_at and holder_confirmed_at <= enrollment_expires_at)),
  -- Approval only after the holder proved possession of the key (never a key the proposer alone holds).
  constraint console_rci_approval_after_confirmation check (approved_by is null or (holder_confirmed_at is not null and approved_at >= holder_confirmed_at)),
  constraint console_rci_suspension_shape check ((suspended_at is null) = (suspend_reason is null)),
  constraint console_rci_revocation_shape check ((revoked_by is null) = (revoked_at is null) and (revoked_at is null) = (revoke_reason is null)),
  constraint console_rci_status_shape check (
    (status = 'PROPOSED' and approved_by is null and revoked_at is null and suspended_at is null)
    or (status = 'ACTIVE' and approved_by is not null and revoked_at is null and suspended_at is null)
    or (status = 'SUSPENDED' and approved_by is not null and revoked_at is null and suspended_at is not null)
    or (status = 'REVOKED' and revoked_at is not null))
);

create index console_rci_staff_status on console_recovery_identities (tenant_id, staff_id, status);

create or replace function console_rci_before_update() returns trigger language plpgsql as $$
begin
  if old.status = 'REVOKED' then
    raise exception 'CONSOLE_RECOVERY_IDENTITY_REVOKED' using errcode = '42501';
  end if;
  -- PROPOSED -> PROPOSED (holder confirmation), ACTIVE (approval) or REVOKED; ACTIVE <-> SUSPENDED; any -> REVOKED.
  if not ((old.status = new.status and old.status = 'PROPOSED')
          or (old.status = 'PROPOSED' and new.status in ('ACTIVE', 'REVOKED'))
          or (old.status = 'ACTIVE' and new.status in ('SUSPENDED', 'REVOKED'))
          or (old.status = 'SUSPENDED' and new.status in ('ACTIVE', 'REVOKED'))) then
    raise exception 'CONSOLE_RECOVERY_IDENTITY_TRANSITION' using errcode = '42501';
  end if;
  if new.identity_id is distinct from old.identity_id or new.tenant_id is distinct from old.tenant_id
     or new.staff_id is distinct from old.staff_id or new.key_thumbprint is distinct from old.key_thumbprint
     or new.public_jwk is distinct from old.public_jwk or new.attestation_ref is distinct from old.attestation_ref
     or new.roles is distinct from old.roles or new.proposed_by is distinct from old.proposed_by
     or new.proposed_at is distinct from old.proposed_at
     or new.enrollment_challenge_hash is distinct from old.enrollment_challenge_hash or new.enrollment_expires_at is distinct from old.enrollment_expires_at
     or (old.holder_confirmed_at is not null and new.holder_confirmed_at is distinct from old.holder_confirmed_at)
     or (old.approved_by is not null and (new.approved_by is distinct from old.approved_by or new.approved_at is distinct from old.approved_at)) then
    raise exception 'CONSOLE_RECOVERY_IDENTITY_IMMUTABLE' using errcode = '42501';
  end if;
  -- Through the console role, each change is made by the party it names (defence in depth behind recovery.ts):
  -- the approver approves, the revoker revokes, and holder confirmation, suspension and reinstatement happen in
  -- a transaction acting for the holder (their SSO session, or the IdP's answer about them).
  if current_user = 'app_console' then
    if old.status = 'PROPOSED' and new.status = 'ACTIVE' and new.approved_by is distinct from app_actor() then
      raise exception 'CONSOLE_RECOVERY_IDENTITY_ACTOR' using errcode = '42501';
    end if;
    if new.status = 'REVOKED' and new.revoked_by is distinct from app_actor() then
      raise exception 'CONSOLE_RECOVERY_IDENTITY_ACTOR' using errcode = '42501';
    end if;
    if ((old.holder_confirmed_at is null and new.holder_confirmed_at is not null)
        or (old.status <> new.status and new.status = 'SUSPENDED')
        or (old.status = 'SUSPENDED' and new.status = 'ACTIVE'))
       and old.staff_id is distinct from app_actor() then
      raise exception 'CONSOLE_RECOVERY_IDENTITY_ACTOR' using errcode = '42501';
    end if;
  end if;
  return new;
end
$$;

create trigger console_rci_update before update on console_recovery_identities
  for each row execute function console_rci_before_update();
create trigger console_rci_no_delete before delete on console_recovery_identities
  for each row execute function console_append_only();

create table console_recovery_activations (
  activation_id        text        primary key check (activation_id ~ '^rca_[A-Za-z0-9_-]{16,64}$'),
  tenant_id            text        not null check (tenant_id ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  identity_id          text        not null references console_recovery_identities (identity_id),
  challenge_hash       text        not null check (challenge_hash ~ '^[a-f0-9]{64}$'),
  created_at           timestamptz not null,
  expires_at           timestamptz not null,
  status               text        not null check (status in ('PENDING', 'ACTIVATED', 'REFUSED')),
  -- sha256 of the nonce of the requester's signed activation request (single use: a replay cannot be issued).
  request_nonce_hash   text        not null check (request_nonce_hash ~ '^[a-f0-9]{64}$'),
  second_identity_id   text        references console_recovery_identities (identity_id),
  completed_at         timestamptz,
  session_hash         text        check (session_hash is null or session_hash ~ '^[a-f0-9]{64}$'),
  outcome              text        check (outcome is null or outcome ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  unique (identity_id, request_nonce_hash),
  constraint console_rca_window check (expires_at > created_at and expires_at <= created_at + interval '10 minutes'),
  constraint console_rca_two_custodians check (second_identity_id is null or second_identity_id <> identity_id),
  constraint console_rca_shape check (
    (status = 'PENDING' and completed_at is null and session_hash is null and outcome is null and second_identity_id is null)
    or (status = 'ACTIVATED' and completed_at is not null and session_hash is not null and second_identity_id is not null and outcome is not null)
    or (status = 'REFUSED' and completed_at is not null and session_hash is null and outcome is not null))
);

create or replace function console_rca_before_update() returns trigger language plpgsql as $$
begin
  if old.status <> 'PENDING' then
    raise exception 'CONSOLE_RECOVERY_ACTIVATION_CLOSED' using errcode = '42501';
  end if;
  if new.activation_id is distinct from old.activation_id or new.tenant_id is distinct from old.tenant_id
     or new.identity_id is distinct from old.identity_id or new.challenge_hash is distinct from old.challenge_hash
     or new.request_nonce_hash is distinct from old.request_nonce_hash
     or new.created_at is distinct from old.created_at or new.expires_at is distinct from old.expires_at then
    raise exception 'CONSOLE_RECOVERY_ACTIVATION_IMMUTABLE' using errcode = '42501';
  end if;
  return new;
end
$$;

create trigger console_rca_update before update on console_recovery_activations
  for each row execute function console_rca_before_update();
create trigger console_rca_no_delete before delete on console_recovery_activations
  for each row execute function console_append_only();

-- ---------------------------------------------------------------------------
-- Row-level security and least-privilege grants
-- ---------------------------------------------------------------------------
alter table console_break_glass_requests enable row level security;
alter table console_break_glass_requests force row level security;
alter table console_access_reviews enable row level security;
alter table console_access_reviews force row level security;
alter table console_recovery_identities enable row level security;
alter table console_recovery_identities force row level security;
alter table console_recovery_activations enable row level security;
alter table console_recovery_activations force row level security;

create policy console_bgr_read on console_break_glass_requests for select to app_console, app_auditor using (tenant_id = app_tenant());
create policy console_bgr_insert on console_break_glass_requests for insert to app_console
  with check (tenant_id = app_tenant() and requested_by = app_actor() and status = 'PENDING');
create policy console_bgr_decide on console_break_glass_requests for update to app_console
  using (tenant_id = app_tenant() and requested_by <> app_actor()) with check (tenant_id = app_tenant() and decided_by = app_actor());

-- The console becomes the audited issuance process of migration 0900's grants: a grant row is written only
-- by the approving staff member (approved_by = actor), never for themselves.
create policy console_break_glass_issue on console_break_glass_grants for insert to app_console
  with check (tenant_id = app_tenant() and approved_by = app_actor() and staff_id <> app_actor());
create policy console_break_glass_revoke on console_break_glass_grants for update to app_console
  using (tenant_id = app_tenant()) with check (tenant_id = app_tenant() and revoked_by = app_actor());

create policy console_acr_read on console_access_reviews for select to app_console, app_auditor using (tenant_id = app_tenant());
create policy console_acr_open on console_access_reviews for insert to app_console with check (tenant_id = app_tenant() and status = 'OPEN');
create policy console_acr_complete on console_access_reviews for update to app_console
  using (tenant_id = app_tenant()) with check (tenant_id = app_tenant() and reviewer_staff_id = app_actor());

create policy console_rci_read on console_recovery_identities for select to app_console, app_auditor using (tenant_id = app_tenant());
create policy console_rci_propose on console_recovery_identities for insert to app_console
  with check (tenant_id = app_tenant() and proposed_by = app_actor() and status = 'PROPOSED');
create policy console_rci_update on console_recovery_identities for update to app_console
  using (tenant_id = app_tenant()) with check (tenant_id = app_tenant() and (approved_by = app_actor() or revoked_by = app_actor() or staff_id = app_actor()));

create policy console_rca_rw on console_recovery_activations for all to app_console
  using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());

revoke all on console_break_glass_requests, console_access_reviews, console_recovery_identities, console_recovery_activations from public;
grant select, insert on console_break_glass_requests to app_console;
grant update (status, decided_by, decided_at, decision_reason, grant_id, decision_audit_event_id) on console_break_glass_requests to app_console;
grant select on console_break_glass_requests to app_auditor;
grant insert on console_break_glass_grants to app_console;
grant update (revoked_at, revoked_by) on console_break_glass_grants to app_console;
grant select, insert on console_access_reviews to app_console;
grant update (status, outcome, reason, reviewer_staff_id, completed_at, completion_audit_event_id) on console_access_reviews to app_console;
grant select on console_access_reviews to app_auditor;
grant select, insert on console_recovery_identities to app_console;
grant update (status, holder_confirmed_at, approved_by, approved_at, suspended_at, suspend_reason, revoked_by, revoked_at, revoke_reason) on console_recovery_identities to app_console;
grant select (identity_id, tenant_id, staff_id, key_thumbprint, attestation_ref, roles, status, proposed_by, proposed_at, enrollment_expires_at, holder_confirmed_at,
              approved_by, approved_at, suspended_at, suspend_reason, revoked_by, revoked_at, revoke_reason)
  on console_recovery_identities to app_auditor;
grant select, insert on console_recovery_activations to app_console;
grant update (status, second_identity_id, completed_at, session_hash, outcome) on console_recovery_activations to app_console;

revoke all on function console_bgr_before_update(), console_acr_before_update(), console_rci_before_update(), console_rca_before_update() from public;
