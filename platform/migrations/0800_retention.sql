-- Retention, legal holds and deletion evidence (spec section 6, DATA-03).
--
-- Retention is set per data class and legal purpose by privacy counsel. This
-- schema never contains a default duration: a NULL retention_days means "not
-- set" and the retention job refuses to delete anything in that class. A
-- non-null duration requires an approval id, the approver and a legal purpose.
--
-- Evidence tables (deletion_records, deletion_verifications) are append-only
-- for every role and contain counts, digests and opaque references only, never
-- deleted content.
--
-- Roles: app_console defines policies, places/releases legal holds and records
-- vendor confirmations; app_worker runs the job (reads policies and holds,
-- writes evidence and vendor requests); app_auditor reads everything.

create table retention_policies (
  tenant_id       text        not null,
  data_class      text        not null check (data_class in ('TRANSIENT_CONVERSATION', 'BUSINESS_RECORD', 'RESTRICTED_QA_MEDIA', 'SECURITY_AUDIT')),
  policy_version  integer     not null check (policy_version >= 1),
  retention_days  integer     check (retention_days is null or retention_days between 1 and 36500),
  legal_purpose   text        check (legal_purpose is null or legal_purpose ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  approval_id     text        check (approval_id is null or approval_id ~ '^apr_[A-Za-z0-9_-]{8,64}$'),
  approved_by     text        check (approved_by is null or approved_by ~ '^[a-z][a-z_]{2,40}$'),
  defined_by      text        not null check (defined_by ~ '^stf_[A-Za-z0-9_-]{8,64}$'),
  defined_at      timestamptz not null,
  primary key (tenant_id, data_class, policy_version),
  constraint retention_policies_duration_requires_approval check (
    retention_days is null or (approval_id is not null and approved_by is not null and legal_purpose is not null)
  )
);

create table legal_holds (
  hold_id              text        primary key check (hold_id ~ '^lgh_[A-Za-z0-9_-]{16,64}$'),
  tenant_id            text        not null,
  -- Scope: every non-null field narrows the hold; all null = every record of the tenant.
  data_class           text        check (data_class is null or data_class in ('TRANSIENT_CONVERSATION', 'BUSINESS_RECORD', 'RESTRICTED_QA_MEDIA', 'SECURITY_AUDIT')),
  dataset              text        check (dataset is null or dataset ~ '^[a-z][a-z0-9_]{2,62}$'),
  subject_id           text        check (subject_id is null or subject_id ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  record_key           text        check (record_key is null or record_key ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  matter_ref           text        not null check (matter_ref ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  reason_code          text        not null check (reason_code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  placed_by            text        not null check (placed_by ~ '^stf_[A-Za-z0-9_-]{8,64}$'),
  placed_at            timestamptz not null,
  released_at          timestamptz,
  released_by          text        check (released_by is null or released_by ~ '^stf_[A-Za-z0-9_-]{8,64}$'),
  release_reason_code  text        check (release_reason_code is null or release_reason_code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  constraint legal_holds_release_shape check ((released_at is null) = (released_by is null) and (released_at is null) = (release_reason_code is null))
);
create index legal_holds_active on legal_holds (tenant_id) where released_at is null;

create table retention_runs (
  run_id        text        primary key check (run_id ~ '^ret_[A-Za-z0-9_-]{16,64}$'),
  tenant_id     text        not null,
  started_at    timestamptz not null,
  completed_at  timestamptz,
  status        text        not null check (status in ('STARTED', 'COMPLETED', 'COMPLETED_WITH_UNVERIFIED_COPIES', 'BLOCKED_RETENTION_UNSET', 'FAILED')),
  summary       jsonb
);

create table deletion_records (
  deletion_id       text        primary key check (deletion_id ~ '^del_[A-Za-z0-9_-]{16,64}$'),
  tenant_id         text        not null,
  run_id            text        not null references retention_runs (run_id),
  dataset           text        not null check (dataset ~ '^[a-z][a-z0-9_]{2,62}$'),
  data_class        text        not null,
  policy_version    integer     not null,
  approval_id       text        not null,
  cutoff            timestamptz not null,
  deleted_count     integer     not null check (deleted_count >= 0),
  held_count        integer     not null check (held_count >= 0),
  -- sha256 over the sorted deleted record keys (opaque ids): evidence, not content.
  key_digest        text        not null check (key_digest ~ '^[a-f0-9]{64}$'),
  derived_copies    text[]      not null,
  executed_at       timestamptz not null,
  record_seq        bigint      generated always as identity
);

create table deletion_verifications (
  verification_id   text        primary key check (verification_id ~ '^dvf_[A-Za-z0-9_-]{16,64}$'),
  tenant_id         text        not null,
  deletion_id       text        not null references deletion_records (deletion_id),
  verifier          text        not null check (verifier ~ '^[a-z][a-z0-9_]{2,62}$'),
  location          text        not null check (location in ('DERIVED_TABLE', 'INDEX', 'CACHE', 'BACKUP', 'VENDOR')),
  verifier_kind     text        not null check (verifier_kind in ('local_fixture', 'live')),
  status            text        not null check (status in ('VERIFIED_ABSENT', 'LEFTOVERS_FOUND', 'UNVERIFIABLE')),
  leftover_count    integer     not null check (leftover_count >= 0),
  leftover_digest   text        check (leftover_digest is null or leftover_digest ~ '^[a-f0-9]{64}$'),
  reason_code       text        check (reason_code is null or reason_code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  verified_at       timestamptz not null
);

create table vendor_deletion_requests (
  request_id        text        primary key check (request_id ~ '^vdr_[A-Za-z0-9_-]{16,64}$'),
  tenant_id         text        not null,
  run_id            text        not null references retention_runs (run_id),
  deletion_id       text        not null references deletion_records (deletion_id),
  vendor            text        not null check (vendor ~ '^[a-z][a-z0-9_-]{2,40}$'),
  dataset           text        not null,
  data_class        text        not null,
  item_refs         text[]      not null check (cardinality(item_refs) <= 10000),
  item_count        integer     not null check (item_count >= 0),
  rejected_ref_count integer    not null default 0 check (rejected_ref_count >= 0),
  key_digest        text        not null check (key_digest ~ '^[a-f0-9]{64}$'),
  -- Vendor deletion APIs are BLOCKED: requests wait for an operator with vendor evidence.
  status            text        not null check (status in ('PENDING_VENDOR', 'SUBMITTED', 'CONFIRMED', 'FAILED')),
  evidence_ref      text        check (evidence_ref is null or char_length(evidence_ref) between 3 and 200),
  created_at        timestamptz not null,
  updated_at        timestamptz not null,
  updated_by        text,
  constraint vendor_deletion_confirmed_evidence check (status <> 'CONFIRMED' or evidence_ref is not null)
);

-- Append-only evidence and policy history.
create or replace function retention_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'RETENTION_EVIDENCE_APPEND_ONLY' using errcode = '42501';
end
$$;
create trigger retention_policies_append_only before update or delete on retention_policies for each row execute function retention_append_only();
create trigger deletion_records_append_only before update or delete on deletion_records for each row execute function retention_append_only();
create trigger deletion_verifications_append_only before update or delete on deletion_verifications for each row execute function retention_append_only();
create trigger retention_policies_no_truncate before truncate on retention_policies for each statement execute function retention_append_only();
create trigger deletion_records_no_truncate before truncate on deletion_records for each statement execute function retention_append_only();
create trigger deletion_verifications_no_truncate before truncate on deletion_verifications for each statement execute function retention_append_only();

-- Legal holds: never deleted; released once, and only the release fields may change.
create or replace function legal_holds_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'LEGAL_HOLD_NOT_DELETABLE' using errcode = '42501';
  end if;
  if old.released_at is not null
     or new.hold_id is distinct from old.hold_id or new.tenant_id is distinct from old.tenant_id
     or new.data_class is distinct from old.data_class or new.dataset is distinct from old.dataset
     or new.subject_id is distinct from old.subject_id or new.record_key is distinct from old.record_key
     or new.matter_ref is distinct from old.matter_ref or new.reason_code is distinct from old.reason_code
     or new.placed_by is distinct from old.placed_by or new.placed_at is distinct from old.placed_at
     or new.released_at is null then
    raise exception 'LEGAL_HOLD_ONLY_RELEASE_ALLOWED' using errcode = '42501';
  end if;
  return new;
end
$$;
create trigger legal_holds_guard before update or delete on legal_holds for each row execute function legal_holds_guard();

-- Retention runs: one completion update, from STARTED only.
create or replace function retention_runs_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' or old.status <> 'STARTED' or new.status = 'STARTED' or new.completed_at is null
     or new.run_id is distinct from old.run_id or new.tenant_id is distinct from old.tenant_id or new.started_at is distinct from old.started_at then
    raise exception 'RETENTION_RUN_COMPLETION_ONLY' using errcode = '42501';
  end if;
  return new;
end
$$;
create trigger retention_runs_guard before update or delete on retention_runs for each row execute function retention_runs_guard();

-- Vendor requests: status moves forward only; content columns never change.
create or replace function vendor_deletion_requests_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'VENDOR_DELETION_REQUEST_NOT_DELETABLE' using errcode = '42501';
  end if;
  if new.request_id is distinct from old.request_id or new.tenant_id is distinct from old.tenant_id or new.run_id is distinct from old.run_id
     or new.deletion_id is distinct from old.deletion_id or new.vendor is distinct from old.vendor or new.dataset is distinct from old.dataset
     or new.item_refs is distinct from old.item_refs or new.item_count is distinct from old.item_count or new.key_digest is distinct from old.key_digest
     or new.created_at is distinct from old.created_at
     or not ((old.status = 'PENDING_VENDOR' and new.status in ('SUBMITTED', 'FAILED'))
             or (old.status = 'SUBMITTED' and new.status in ('CONFIRMED', 'FAILED'))) then
    raise exception 'VENDOR_DELETION_REQUEST_TRANSITION_INVALID' using errcode = '42501';
  end if;
  return new;
end
$$;
create trigger vendor_deletion_requests_guard before update or delete on vendor_deletion_requests for each row execute function vendor_deletion_requests_guard();

alter table retention_policies enable row level security;
alter table retention_policies force row level security;
alter table legal_holds enable row level security;
alter table legal_holds force row level security;
alter table retention_runs enable row level security;
alter table retention_runs force row level security;
alter table deletion_records enable row level security;
alter table deletion_records force row level security;
alter table deletion_verifications enable row level security;
alter table deletion_verifications force row level security;
alter table vendor_deletion_requests enable row level security;
alter table vendor_deletion_requests force row level security;

create policy retention_policies_read on retention_policies for select to app_worker, app_console, app_auditor using (tenant_id = app_tenant());
create policy retention_policies_insert on retention_policies for insert to app_console with check (tenant_id = app_tenant());

create policy legal_holds_read on legal_holds for select to app_worker, app_console, app_auditor using (tenant_id = app_tenant());
create policy legal_holds_insert on legal_holds for insert to app_console with check (tenant_id = app_tenant());
create policy legal_holds_release on legal_holds for update to app_console using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());

create policy retention_runs_read on retention_runs for select to app_worker, app_console, app_auditor using (tenant_id = app_tenant());
create policy retention_runs_insert on retention_runs for insert to app_worker with check (tenant_id = app_tenant());
create policy retention_runs_complete on retention_runs for update to app_worker using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());

create policy deletion_records_read on deletion_records for select to app_worker, app_console, app_auditor using (tenant_id = app_tenant());
create policy deletion_records_insert on deletion_records for insert to app_worker with check (tenant_id = app_tenant());
create policy deletion_verifications_read on deletion_verifications for select to app_worker, app_console, app_auditor using (tenant_id = app_tenant());
create policy deletion_verifications_insert on deletion_verifications for insert to app_worker with check (tenant_id = app_tenant());

create policy vendor_deletion_requests_read on vendor_deletion_requests for select to app_worker, app_console, app_auditor using (tenant_id = app_tenant());
create policy vendor_deletion_requests_insert on vendor_deletion_requests for insert to app_worker with check (tenant_id = app_tenant());
create policy vendor_deletion_requests_update on vendor_deletion_requests for update to app_console using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());

revoke all on retention_policies, legal_holds, retention_runs, deletion_records, deletion_verifications, vendor_deletion_requests from public;
grant select on retention_policies, legal_holds, retention_runs, deletion_records, deletion_verifications, vendor_deletion_requests to app_worker, app_console, app_auditor;
grant insert on retention_policies, legal_holds to app_console;
grant update on legal_holds, vendor_deletion_requests to app_console;
grant insert, update on retention_runs to app_worker;
grant insert on deletion_records, deletion_verifications, vendor_deletion_requests to app_worker;
