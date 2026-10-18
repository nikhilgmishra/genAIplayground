-- Console API (09xx): state owned by platform/src/console-api (spec sections 7, 13 and 16).
--
-- Content-free by construction: opaque identifiers, reason codes, digests, counts and
-- timestamps only. No transcript text, caller words, names, secrets or task tokens.
--
-- Roles:
--   app_console : the console API (workforce SSO, RBAC, audited administrative actions)
--   app_auditor : read-only audit views (never rewrites evidence)
--   app_worker  : the release pipeline job that records release submissions
--   (no app role) the separate, audited access process that writes break-glass grants;
--                 it is BLOCKED (not designed in this codebase), so grants are written
--                 only by fixtures/migrations offline.

-- ---------------------------------------------------------------------------
-- Break-glass grants (spec section 7): time-bound, justified, approved by someone
-- else, never self-granted, reviewed. The console reads them; it has no grant or
-- request endpoint.
-- ---------------------------------------------------------------------------
create table console_break_glass_grants (
  grant_id            text        primary key check (grant_id ~ '^bgl_[A-Za-z0-9_-]{16,64}$'),
  tenant_id           text        not null check (tenant_id ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  staff_id            text        not null check (staff_id ~ '^stf_[A-Za-z0-9_-]{8,64}$'),
  approved_by         text        not null check (approved_by ~ '^stf_[A-Za-z0-9_-]{8,64}$'),
  justification_code  text        not null check (justification_code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  granted_at          timestamptz not null,
  expires_at          timestamptz not null,
  revoked_at          timestamptz,
  revoked_by          text        check (revoked_by is null or revoked_by ~ '^stf_[A-Za-z0-9_-]{8,64}$'),
  access_review_ref   text        check (access_review_ref is null or access_review_ref ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  recorded_at         timestamptz not null,
  -- Never self-granted (the model or a staff member cannot grant themselves emergency access).
  constraint console_break_glass_not_self_granted check (approved_by <> staff_id),
  -- Time-bound. The maximum duration is enforced by policy (vsp.console breakGlass.maxDurationSeconds).
  constraint console_break_glass_time_bound check (expires_at > granted_at),
  constraint console_break_glass_revocation_shape check ((revoked_at is null) = (revoked_by is null))
);

create index console_break_glass_by_staff on console_break_glass_grants (tenant_id, staff_id, granted_at desc);

create or replace function console_break_glass_before_update() returns trigger language plpgsql as $$
begin
  -- Only a one-time revocation is permitted; every granted field is immutable.
  if old.revoked_at is not null then
    raise exception 'CONSOLE_BREAK_GLASS_ALREADY_REVOKED' using errcode = '42501';
  end if;
  if new.grant_id is distinct from old.grant_id or new.tenant_id is distinct from old.tenant_id
     or new.staff_id is distinct from old.staff_id or new.approved_by is distinct from old.approved_by
     or new.justification_code is distinct from old.justification_code or new.granted_at is distinct from old.granted_at
     or new.expires_at is distinct from old.expires_at or new.access_review_ref is distinct from old.access_review_ref
     or new.recorded_at is distinct from old.recorded_at then
    raise exception 'CONSOLE_BREAK_GLASS_IMMUTABLE' using errcode = '42501';
  end if;
  return new;
end
$$;

create trigger console_break_glass_update before update on console_break_glass_grants
  for each row execute function console_break_glass_before_update();

create or replace function console_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'CONSOLE_RECORD_APPEND_ONLY' using errcode = '42501';
end
$$;

create trigger console_break_glass_no_delete before delete on console_break_glass_grants
  for each row execute function console_append_only();
create trigger console_break_glass_no_truncate before truncate on console_break_glass_grants
  for each statement execute function console_append_only();

-- ---------------------------------------------------------------------------
-- Console session revocations (logout). Only sha256(jti) is stored.
-- ---------------------------------------------------------------------------
create table console_token_revocations (
  jti_hash        text        primary key check (jti_hash ~ '^[a-f0-9]{64}$'),
  tenant_id       text        not null check (tenant_id ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  staff_id        text        not null check (staff_id ~ '^stf_[A-Za-z0-9_-]{8,64}$'),
  revoked_at      timestamptz not null,
  token_expires_at timestamptz not null,
  audit_event_id  text        not null check (audit_event_id ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$')
);

create trigger console_token_revocations_no_update_delete before update or delete on console_token_revocations
  for each row execute function console_append_only();
create trigger console_token_revocations_no_truncate before truncate on console_token_revocations
  for each statement execute function console_append_only();

-- ---------------------------------------------------------------------------
-- Idempotency for confirmed operator mutations (Idempotency-Key header): the first
-- result for a repeated key is returned per staff member and endpoint. Response
-- bodies are content-free contract responses (validated by strict schemas).
-- ---------------------------------------------------------------------------
create table console_idempotency (
  tenant_id             text        not null check (tenant_id ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  staff_id              text        not null check (staff_id ~ '^stf_[A-Za-z0-9_-]{8,64}$'),
  endpoint              text        not null check (endpoint ~ '^[A-Za-z][A-Za-z.]{1,63}$'),
  idempotency_key_hash  text        not null check (idempotency_key_hash ~ '^[a-f0-9]{64}$'),
  request_digest        text        not null check (request_digest ~ '^[a-f0-9]{64}$'),
  status                text        not null check (status in ('IN_PROGRESS', 'COMPLETED')),
  response_status       integer     check (response_status is null or response_status between 200 and 299),
  response_body         jsonb,
  created_at            timestamptz not null,
  expires_at            timestamptz not null,
  primary key (tenant_id, staff_id, endpoint, idempotency_key_hash),
  constraint console_idempotency_completed_shape check ((status = 'COMPLETED') = (response_status is not null and response_body is not null))
);

-- ---------------------------------------------------------------------------
-- Release submissions: authoritative provenance of a policy bundle or knowledge
-- snapshot submitted for review (who, when, which digest, content-free diff
-- summary). Written by the release pipeline (app_worker), never by the console.
-- ---------------------------------------------------------------------------
create table console_release_submissions (
  release_id        text        primary key check (release_id ~ '^rel_[A-Za-z0-9_-]{16,64}$'),
  tenant_id         text        not null check (tenant_id ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  kind              text        not null check (kind in ('POLICY_BUNDLE', 'KNOWLEDGE_SNAPSHOT')),
  version           text        not null check (version ~ '^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$'),
  previous_version  text        check (previous_version is null or previous_version ~ '^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$'),
  digest            text        not null check (digest ~ '^[a-f0-9]{64}$'),
  submitted_by      text        not null check (submitted_by ~ '^stf_[A-Za-z0-9_-]{8,64}$'),
  submitted_at      timestamptz not null,
  diff_added        integer     not null check (diff_added between 0 and 100000),
  diff_removed      integer     not null check (diff_removed between 0 and 100000),
  diff_changed      integer     not null check (diff_changed between 0 and 100000),
  -- [{ref, change, summaryCode}] — rule / article ids and change codes only, never bodies.
  diff_entries      jsonb       not null check (jsonb_typeof(diff_entries) = 'array' and jsonb_array_length(diff_entries) <= 200),
  recorded_at       timestamptz not null,
  unique (tenant_id, kind, digest)
);

create index console_release_submissions_tenant_time on console_release_submissions (tenant_id, submitted_at desc);

create trigger console_release_submissions_no_update_delete before update or delete on console_release_submissions
  for each row execute function console_append_only();
create trigger console_release_submissions_no_truncate before truncate on console_release_submissions
  for each statement execute function console_append_only();

-- ---------------------------------------------------------------------------
-- Release reviews: a reviewer's recorded OPINION. Explicitly NOT an approval record:
-- releasing requires a signed POLICY_RELEASE / KNOWLEDGE_RELEASE approval in
-- approvals/, which the console cannot create (approval_record is always false).
-- ---------------------------------------------------------------------------
create table console_release_reviews (
  review_id          text        primary key check (review_id ~ '^rvw_[A-Za-z0-9_-]{16,64}$'),
  tenant_id          text        not null check (tenant_id ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  release_id         text        not null references console_release_submissions (release_id),
  release_digest     text        not null check (release_digest ~ '^[a-f0-9]{64}$'),
  reviewer_staff_id  text        not null check (reviewer_staff_id ~ '^stf_[A-Za-z0-9_-]{8,64}$'),
  reviewer_role      text        not null check (reviewer_role in ('policy_approver', 'knowledge_editor')),
  decision           text        not null check (decision in ('NO_OBJECTION', 'CHANGES_REQUESTED')),
  reason             text        not null check (reason ~ '^[A-Z][A-Z0-9_]{2,63}(:[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64})?$'),
  reviewed_at        timestamptz not null,
  audit_event_id     text        not null check (audit_event_id ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  approval_record    boolean     not null default false check (approval_record = false)
);

create index console_release_reviews_by_release on console_release_reviews (tenant_id, release_id, reviewed_at);

create or replace function console_release_reviews_before_insert() returns trigger language plpgsql as $$
declare
  v_submitter text;
  v_digest text;
  v_tenant text;
begin
  select submitted_by, digest, tenant_id into v_submitter, v_digest, v_tenant
    from console_release_submissions where release_id = new.release_id;
  if v_submitter is null or v_tenant is distinct from new.tenant_id then
    raise exception 'CONSOLE_RELEASE_NOT_FOUND' using errcode = '23503';
  end if;
  -- A reviewer never reviews a release they submitted (defense in depth beyond the API).
  if v_submitter = new.reviewer_staff_id then
    raise exception 'SELF_REVIEW_FORBIDDEN' using errcode = '42501';
  end if;
  if v_digest is distinct from new.release_digest then
    raise exception 'CONSOLE_RELEASE_DIGEST_MISMATCH' using errcode = '23514';
  end if;
  return new;
end
$$;

-- Runs as the inserting role (app_console), which reads the submission through its own
-- tenant RLS policy: a review for another tenant's release is never found.
create trigger console_release_reviews_insert before insert on console_release_reviews
  for each row execute function console_release_reviews_before_insert();
create trigger console_release_reviews_no_update_delete before update or delete on console_release_reviews
  for each row execute function console_append_only();
create trigger console_release_reviews_no_truncate before truncate on console_release_reviews
  for each statement execute function console_append_only();

-- ---------------------------------------------------------------------------
-- Console reconciliations (ACT-03): each operator reconcile and its provider lookup
-- result. A retry is permitted only against the latest, unconsumed NOT_FOUND
-- reconciliation recorded here (within this console flow).
-- ---------------------------------------------------------------------------
create table console_reconciliations (
  reconciliation_id      text        primary key check (reconciliation_id ~ '^rcn_[A-Za-z0-9_-]{16,64}$'),
  tenant_id              text        not null check (tenant_id ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  action_id              text        not null check (action_id ~ '^act_[A-Za-z0-9_-]{16,64}$'),
  result                 text        not null check (result in ('COMMITTED', 'NOT_FOUND', 'UNKNOWN')),
  receipt_id             text        check (receipt_id is null or receipt_id ~ '^rcp_[A-Za-z0-9_-]{16,64}$'),
  ledger_state           text        not null check (ledger_state in (
                           'PREPARED', 'CONFIRMED', 'COMMITTING', 'COMMITTED', 'FAILED', 'UNKNOWN', 'INVALIDATED', 'EXPIRED', 'CANCELLED')),
  ledger_audit_event_id  text        check (ledger_audit_event_id is null or ledger_audit_event_id ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  performed_by           text        not null check (performed_by ~ '^stf_[A-Za-z0-9_-]{8,64}$'),
  performed_at           timestamptz not null,
  audit_event_id         text        not null check (audit_event_id ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  retry_consumed_at      timestamptz,
  retry_consumed_by      text        check (retry_consumed_by is null or retry_consumed_by ~ '^stf_[A-Za-z0-9_-]{8,64}$'),
  reconcile_seq          bigint      generated always as identity,
  constraint console_reconciliations_consumed_shape check ((retry_consumed_at is null) = (retry_consumed_by is null)),
  constraint console_reconciliations_consume_not_found check (retry_consumed_at is null or result = 'NOT_FOUND')
);

create index console_reconciliations_by_action on console_reconciliations (tenant_id, action_id, reconcile_seq desc);

create or replace function console_reconciliations_before_update() returns trigger language plpgsql as $$
begin
  if old.retry_consumed_at is not null then
    raise exception 'CONSOLE_RECONCILIATION_ALREADY_CONSUMED' using errcode = '42501';
  end if;
  if new.reconciliation_id is distinct from old.reconciliation_id or new.tenant_id is distinct from old.tenant_id
     or new.action_id is distinct from old.action_id or new.result is distinct from old.result
     or new.receipt_id is distinct from old.receipt_id or new.ledger_state is distinct from old.ledger_state
     or new.ledger_audit_event_id is distinct from old.ledger_audit_event_id or new.performed_by is distinct from old.performed_by
     or new.performed_at is distinct from old.performed_at or new.audit_event_id is distinct from old.audit_event_id then
    raise exception 'CONSOLE_RECONCILIATION_IMMUTABLE' using errcode = '42501';
  end if;
  return new;
end
$$;

create trigger console_reconciliations_update before update on console_reconciliations
  for each row execute function console_reconciliations_before_update();
create trigger console_reconciliations_no_delete before delete on console_reconciliations
  for each row execute function console_append_only();
create trigger console_reconciliations_no_truncate before truncate on console_reconciliations
  for each statement execute function console_append_only();

-- ---------------------------------------------------------------------------
-- Row-level security and least-privilege grants
-- ---------------------------------------------------------------------------
alter table console_break_glass_grants enable row level security;
alter table console_break_glass_grants force row level security;
alter table console_token_revocations enable row level security;
alter table console_token_revocations force row level security;
alter table console_idempotency enable row level security;
alter table console_idempotency force row level security;
alter table console_release_submissions enable row level security;
alter table console_release_submissions force row level security;
alter table console_release_reviews enable row level security;
alter table console_release_reviews force row level security;
alter table console_reconciliations enable row level security;
alter table console_reconciliations force row level security;

create policy console_break_glass_read on console_break_glass_grants for select
  to app_console, app_auditor using (tenant_id = app_tenant());

create policy console_token_revocations_read on console_token_revocations for select
  to app_console using (tenant_id = app_tenant());
create policy console_token_revocations_insert on console_token_revocations for insert
  to app_console with check (tenant_id = app_tenant() and staff_id = app_actor());

create policy console_idempotency_rw on console_idempotency for all
  to app_console using (tenant_id = app_tenant() and staff_id = app_actor())
  with check (tenant_id = app_tenant() and staff_id = app_actor());

create policy console_release_submissions_read on console_release_submissions for select
  to app_console, app_auditor, app_worker using (tenant_id = app_tenant());
create policy console_release_submissions_insert on console_release_submissions for insert
  to app_worker with check (tenant_id = app_tenant());

create policy console_release_reviews_read on console_release_reviews for select
  to app_console, app_auditor using (tenant_id = app_tenant());
create policy console_release_reviews_insert on console_release_reviews for insert
  to app_console with check (tenant_id = app_tenant() and reviewer_staff_id = app_actor());

create policy console_reconciliations_read on console_reconciliations for select
  to app_console, app_auditor using (tenant_id = app_tenant());
create policy console_reconciliations_insert on console_reconciliations for insert
  to app_console with check (tenant_id = app_tenant() and performed_by = app_actor());
create policy console_reconciliations_consume on console_reconciliations for update
  to app_console using (tenant_id = app_tenant()) with check (tenant_id = app_tenant() and retry_consumed_by = app_actor());

revoke all on console_break_glass_grants, console_token_revocations, console_idempotency,
  console_release_submissions, console_release_reviews, console_reconciliations from public;

grant select on console_break_glass_grants to app_console, app_auditor;
grant select, insert on console_token_revocations to app_console;
grant select, insert, update, delete on console_idempotency to app_console;
grant select on console_release_submissions to app_console, app_auditor;
grant select, insert on console_release_submissions to app_worker;
grant select, insert on console_release_reviews to app_console;
grant select on console_release_reviews to app_auditor;
grant select, insert on console_reconciliations to app_console;
grant update (retry_consumed_at, retry_consumed_by) on console_reconciliations to app_console;
grant select on console_reconciliations to app_auditor;

revoke all on function console_append_only(), console_break_glass_before_update(),
  console_release_reviews_before_insert(), console_reconciliations_before_update() from public;

-- ---------------------------------------------------------------------------
-- Console read access to the pending-action queue (actions.pending): tenant RLS and
-- a column allowlist. Session hashes, actor/subject ids, the proposed change, the
-- confirmation evidence, provider keys and receipts are NOT readable by the console.
-- Mutations stay with the ledger service (LedgerActionService.cancelPending).
-- ---------------------------------------------------------------------------
create policy action_ledger_console_read on action_ledger for select to app_console
  using (tenant_id = app_tenant());
grant select (action_id, tenant_id, call_id, kind, target, digest, state, requires_step_up,
              prepared_at, expires_at, committing_since, updated_at)
  on action_ledger to app_console;
