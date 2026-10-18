-- Support records (spec section 8 "Salesforce behavior"): internal support requests that
-- survive a Salesforce outage, the interaction (call) <-> issue separation, links to actions
-- and workflows, the per-call action index used for handoff packages and outcome evidence,
-- and interaction outcomes (spec section 4: RESOLVED requires evidence, ACT-04).
--
-- Content rules (DATA-01): opaque ids, codes, a minimized template-assembled summary and
-- pinned versions only. No transcript, no free text from the caller or a model. In a deployed
-- environment the table lives on the KMS-encrypted Aurora cluster ("encrypted internal support
-- request"); encryption at rest is an infrastructure control, not provided by this migration.
--
-- Roles:
--   app_runtime  creates interactions, support requests (incl. restricted ones), links, the
--                per-call action index and outcomes for ITS tenant. It cannot read restricted
--                support requests (privacy / safety records) and cannot update sync state.
--   app_worker   synchronizes support requests with Salesforce (sync columns only), creates
--                follow-up support requests for reconciled commits, reads restricted rows.
--   app_console  reads its tenant's non-restricted support requests; restricted rows only when
--                the console API marks the transaction as a restricted-record reader
--                (set_config('app.restricted_reader', 'on', true)) for staff whose role needs it.
--   app_auditor  no access (audit metadata lives in the audit module).

create table support_interactions (
  interaction_external_id text        primary key check (interaction_external_id ~ '^int_[A-Za-z0-9_-]{16,64}$'),
  tenant_id               text        not null check (tenant_id ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  call_id                 text        not null check (call_id ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  language                text        not null check (language ~ '^[a-z]{2}(-[A-Z]{2})?$'),
  consent_status          text        not null check (consent_status ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  started_at              timestamptz not null,
  created_at              timestamptz not null,
  -- One interaction per call; one interaction can address several issues (multi-issue).
  constraint support_interactions_one_per_call unique (tenant_id, call_id)
);

create table support_requests (
  support_request_id      text        primary key check (support_request_id ~ '^sr_[A-Za-z0-9_-]{16,64}$'),
  tenant_id               text        not null check (tenant_id ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  reference_number        text        not null check (reference_number ~ '^SR-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$'),
  interaction_external_id text        not null references support_interactions (interaction_external_id),
  issue_external_id       text        not null check (issue_external_id ~ '^iss_[A-Za-z0-9_-]{16,64}$'),
  call_id                 text        not null check (call_id ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  creation_key            text        null check (creation_key is null or creation_key ~ '^[a-f0-9]{64}$'),
  audience                text        null check (audience is null or audience in ('client', 'prospective_client', 'provider', 'practice_staff', 'partner', 'payer_representative', 'personal_representative')),
  subject_ref             text        null check (subject_ref is null or subject_ref ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  organization_ref        text        null check (organization_ref is null or organization_ref ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  issue_category          text        not null check (issue_category in ('general_question', 'portal_login_help', 'appointment', 'billing_question', 'billing_dispute',
                                        'claim_status', 'provider_onboarding', 'credentialing_documents', 'remittance', 'partner_intake', 'complaint', 'case_follow_up',
                                        'privacy_concern', 'safety_concern', 'clinical_question_redirected', 'accessibility_request', 'language_support', 'other')),
  disposition             text        not null check (disposition in ('RESOLVED', 'REQUEST_ACCEPTED', 'TRANSFERRED', 'INFORMATION_PROVIDED', 'DECLINED_BY_POLICY',
                                        'CALLER_DISCONNECTED', 'FAILED', 'OUTCOME_UNKNOWN')),
  owner_queue             text        not null check (owner_queue ~ '^q_[a-z0-9_]{2,40}$'),
  priority                text        not null check (priority in ('P1_SAFETY', 'P2_URGENT', 'P3_STANDARD', 'P4_LOW')),
  -- Minimized summary assembled from an internal summary template with code-only slots.
  summary                 text        not null check (char_length(summary) <= 600 and summary !~ '[0-9]{4,}'),
  summary_template_id     text        not null check (summary_template_id ~ '^summary\.[a-z][a-z0-9_.]{2,60}$'),
  summary_provenance      text        not null check (summary_provenance in ('template_assembled', 'human_reviewed')),
  attempted               jsonb       not null check (jsonb_typeof(attempted) = 'array' and jsonb_array_length(attempted) <= 16),
  commit_receipt_ids      jsonb       not null check (jsonb_typeof(commit_receipt_ids) = 'array' and jsonb_array_length(commit_receipt_ids) <= 16),
  source_call_ids         jsonb       not null check (jsonb_typeof(source_call_ids) = 'array' and jsonb_array_length(source_call_ids) between 1 and 32),
  language                text        not null check (language ~ '^[a-z]{2}(-[A-Z]{2})?$'),
  consent                 jsonb       not null check (jsonb_typeof(consent) = 'object'),
  next_step               text        null check (next_step is null or next_step ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  deadline                timestamptz null,
  versions                jsonb       not null check (jsonb_typeof(versions) = 'object'),
  -- Privacy or safety events: never synchronized as broadly visible Cases.
  restricted              boolean     not null,
  sync_state              text        not null check (sync_state in ('PENDING', 'SYNCING', 'SYNCED', 'RETRY_SCHEDULED', 'DEAD_LETTER')),
  sync_attempts           integer     not null default 0 check (sync_attempts between 0 and 1000),
  last_sync_attempt_at    timestamptz null,
  next_sync_attempt_at    timestamptz null,
  last_sync_reason        text        null check (last_sync_reason is null or (last_sync_reason ~ '^[A-Z][A-Z0-9_]{2,63}$' and last_sync_reason !~ '[0-9]{4,}')),
  sync_claim_token        text        null check (sync_claim_token is null or sync_claim_token ~ '^scl_[A-Za-z0-9_-]{16,64}$'),
  salesforce_case_id      text        null check (salesforce_case_id is null or salesforce_case_id ~ '^[a-zA-Z0-9]{15,18}$'),
  synced_at               timestamptz null,
  row_version             integer     not null default 1 check (row_version >= 1),
  created_at              timestamptz not null,
  updated_at              timestamptz not null,
  constraint support_requests_reference_unique unique (reference_number),
  constraint support_requests_issue_external_id_unique unique (issue_external_id),
  constraint support_requests_creation_key_unique unique (tenant_id, creation_key),
  constraint support_requests_synced_has_case check (sync_state <> 'SYNCED' or (salesforce_case_id is not null and synced_at is not null)),
  constraint support_requests_syncing_has_claim check (sync_state <> 'SYNCING' or (sync_claim_token is not null and last_sync_attempt_at is not null)),
  constraint support_requests_retry_has_time check (sync_state <> 'RETRY_SCHEDULED' or next_sync_attempt_at is not null),
  -- Organization-scoped requests (partner intake) never name an individual.
  constraint support_requests_scope check (subject_ref is null or organization_ref is null)
);

create index support_requests_subject on support_requests (tenant_id, subject_ref, created_at);
create index support_requests_organization on support_requests (tenant_id, organization_ref, created_at);
create index support_requests_unsynced on support_requests (tenant_id, sync_state, next_sync_attempt_at) where sync_state <> 'SYNCED';
create index support_requests_interaction on support_requests (interaction_external_id);

create table support_request_links (
  link_id            text        primary key check (link_id ~ '^srl_[A-Za-z0-9_-]{16,64}$'),
  tenant_id          text        not null check (tenant_id ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  support_request_id text        not null references support_requests (support_request_id),
  link_kind          text        not null check (link_kind in ('action', 'workflow', 'interaction')),
  link_ref           text        not null check (link_ref ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  created_at         timestamptz not null,
  constraint support_request_links_unique unique (support_request_id, link_kind, link_ref)
);
-- A committed action is followed up by at most one support request (idempotent follow-up).
create unique index support_request_links_one_per_action on support_request_links (tenant_id, link_ref) where link_kind = 'action';
create index support_request_links_ref on support_request_links (tenant_id, link_kind, link_ref);

-- Per-call index of prepared actions and their commit receipts (handoff package receipts and
-- pending actions; outcome evidence). Opaque ids and codes only.
create table interaction_actions (
  action_id      text        primary key check (action_id ~ '^act_[A-Za-z0-9_-]{16,64}$'),
  tenant_id      text        not null check (tenant_id ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  call_id        text        not null check (call_id ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  action_kind    text        not null check (action_kind in ('appointment.reschedule', 'appointment.create', 'appointment.cancel', 'billing.review.submit',
                                 'support_request.create', 'callback.schedule')),
  contract_id    text        null check (contract_id is null or contract_id ~ '^[a-z_]+@[0-9]+$'),
  receipt_id     text        null check (receipt_id is null or receipt_id ~ '^rcp_[A-Za-z0-9_-]{16,64}$'),
  receipt_outcome text       null check (receipt_outcome is null or receipt_outcome in ('NOT_STARTED', 'COMMITTED', 'FAILED', 'UNKNOWN')),
  created_at     timestamptz not null,
  updated_at     timestamptz not null,
  constraint interaction_actions_receipt_pair check ((receipt_id is null) = (receipt_outcome is null))
);
create index interaction_actions_call on interaction_actions (tenant_id, call_id, created_at);

create table interaction_outcomes (
  outcome_id   text        primary key check (outcome_id ~ '^ioc_[A-Za-z0-9_-]{16,64}$'),
  tenant_id    text        not null check (tenant_id ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  call_id      text        not null check (call_id ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  contract_id  text        null check (contract_id is null or contract_id ~ '^[a-z_]+@[0-9]+$'),
  outcome      text        not null check (outcome in ('RESOLVED', 'REQUEST_ACCEPTED', 'TRANSFERRED', 'INFORMATION_PROVIDED', 'DECLINED_BY_POLICY',
                               'CALLER_DISCONNECTED', 'FAILED', 'OUTCOME_UNKNOWN')),
  reason_code  text        not null check (reason_code ~ '^[A-Z][A-Z0-9_]{2,63}$' and reason_code !~ '[0-9]{4,}'),
  evidence     jsonb       not null check (jsonb_typeof(evidence) = 'object' and octet_length(evidence::text) <= 4096),
  recorded_at  timestamptz not null
);
create index interaction_outcomes_call on interaction_outcomes (tenant_id, call_id, recorded_at);

-- ---------------------------------------------------------------------------
-- Integrity triggers (defense in depth beyond the application).
-- ---------------------------------------------------------------------------

create or replace function support_requests_guard() returns trigger language plpgsql as $$
declare
  allowed boolean;
begin
  if tg_op = 'INSERT' then
    if new.sync_state <> 'PENDING' or new.sync_attempts <> 0 or new.row_version <> 1 or new.salesforce_case_id is not null then
      raise exception 'SUPPORT_REQUEST_INSERT_INVALID' using errcode = '23514';
    end if;
    return new;
  end if;
  if new.support_request_id <> old.support_request_id or new.tenant_id <> old.tenant_id or new.reference_number <> old.reference_number
     or new.interaction_external_id <> old.interaction_external_id or new.issue_external_id <> old.issue_external_id
     or new.call_id <> old.call_id or new.creation_key is distinct from old.creation_key or new.audience is distinct from old.audience
     or new.subject_ref is distinct from old.subject_ref or new.organization_ref is distinct from old.organization_ref
     or new.issue_category <> old.issue_category or new.summary <> old.summary or new.summary_template_id <> old.summary_template_id
     or new.restricted <> old.restricted or new.versions <> old.versions or new.created_at <> old.created_at
     or new.source_call_ids <> old.source_call_ids or new.consent <> old.consent then
    raise exception 'SUPPORT_REQUEST_IMMUTABLE_FIELD' using errcode = '42501';
  end if;
  if new.row_version <> old.row_version + 1 then
    raise exception 'SUPPORT_REQUEST_ROW_VERSION' using errcode = '40001';
  end if;
  -- An external Case id, once recorded, never changes (idempotent upsert by external id).
  if old.salesforce_case_id is not null and new.salesforce_case_id is distinct from old.salesforce_case_id then
    raise exception 'SUPPORT_REQUEST_CASE_ID_IMMUTABLE' using errcode = '42501';
  end if;
  allowed := new.sync_state = old.sync_state
    or (old.sync_state = 'PENDING' and new.sync_state in ('SYNCING', 'DEAD_LETTER'))
    or (old.sync_state = 'SYNCING' and new.sync_state in ('SYNCED', 'RETRY_SCHEDULED', 'DEAD_LETTER'))
    or (old.sync_state = 'RETRY_SCHEDULED' and new.sync_state in ('SYNCING', 'DEAD_LETTER'))
    or (old.sync_state = 'DEAD_LETTER' and new.sync_state = 'PENDING')
    or (old.sync_state = 'SYNCED' and new.sync_state = 'PENDING');
  if not allowed then
    raise exception 'SUPPORT_REQUEST_SYNC_TRANSITION' using errcode = '23514';
  end if;
  if new.sync_attempts < old.sync_attempts and not (old.sync_state = 'DEAD_LETTER' and new.sync_state = 'PENDING') then
    raise exception 'SUPPORT_REQUEST_ATTEMPTS_DECREASED' using errcode = '23514';
  end if;
  return new;
end
$$;

create trigger support_requests_guard
  before insert or update on support_requests
  for each row execute function support_requests_guard();

create or replace function support_records_no_delete() returns trigger language plpgsql as $$
begin
  raise exception 'SUPPORT_RECORDS_APPEND_ONLY' using errcode = '42501';
end
$$;

create trigger support_requests_no_delete before delete on support_requests for each row execute function support_records_no_delete();
create trigger support_request_links_no_delete before delete or update on support_request_links for each row execute function support_records_no_delete();
create trigger interaction_outcomes_append_only before delete or update on interaction_outcomes for each row execute function support_records_no_delete();
create trigger support_interactions_append_only before delete or update on support_interactions for each row execute function support_records_no_delete();

create or replace function interaction_actions_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'SUPPORT_RECORDS_APPEND_ONLY' using errcode = '42501';
  end if;
  if new.action_id <> old.action_id or new.tenant_id <> old.tenant_id or new.call_id <> old.call_id or new.action_kind <> old.action_kind
     or new.created_at <> old.created_at then
    raise exception 'INTERACTION_ACTION_IMMUTABLE_FIELD' using errcode = '42501';
  end if;
  -- A COMMITTED receipt is final.
  if old.receipt_outcome = 'COMMITTED' and (new.receipt_outcome is distinct from old.receipt_outcome or new.receipt_id is distinct from old.receipt_id) then
    raise exception 'INTERACTION_ACTION_RECEIPT_FINAL' using errcode = '42501';
  end if;
  return new;
end
$$;

create trigger interaction_actions_guard before update or delete on interaction_actions for each row execute function interaction_actions_guard();

-- ---------------------------------------------------------------------------
-- Row-level security.
-- ---------------------------------------------------------------------------

alter table support_interactions enable row level security;
alter table support_interactions force row level security;
-- support_requests and interaction_actions are not FORCEd: the two narrow SECURITY DEFINER lookups
-- below run as the table owner (as in the workflows module's due-work scan). The owner role is
-- reserved for migrations and never serves traffic.
alter table support_requests enable row level security;
alter table support_request_links enable row level security;
alter table support_request_links force row level security;
alter table interaction_actions enable row level security;
alter table interaction_outcomes enable row level security;
alter table interaction_outcomes force row level security;

create policy support_interactions_tenant_read on support_interactions for select
  to app_runtime, app_worker, app_console using (tenant_id = app_tenant());
create policy support_interactions_tenant_insert on support_interactions for insert
  to app_runtime, app_worker with check (tenant_id = app_tenant());

create policy support_requests_runtime_read on support_requests for select
  to app_runtime using (tenant_id = app_tenant() and not restricted);
create policy support_requests_insert on support_requests for insert
  to app_runtime, app_worker with check (tenant_id = app_tenant());
create policy support_requests_worker_read on support_requests for select
  to app_worker using (tenant_id = app_tenant());
create policy support_requests_worker_update on support_requests for update
  to app_worker using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy support_requests_console_read on support_requests for select
  to app_console using (tenant_id = app_tenant() and (not restricted or current_setting('app.restricted_reader', true) = 'on'));

create policy support_request_links_tenant_read on support_request_links for select
  to app_runtime, app_worker, app_console using (tenant_id = app_tenant());
create policy support_request_links_tenant_insert on support_request_links for insert
  to app_runtime, app_worker with check (tenant_id = app_tenant());

create policy interaction_actions_tenant_read on interaction_actions for select
  to app_runtime, app_worker, app_console using (tenant_id = app_tenant());
create policy interaction_actions_tenant_insert on interaction_actions for insert
  to app_runtime with check (tenant_id = app_tenant());
create policy interaction_actions_tenant_update on interaction_actions for update
  to app_runtime, app_worker using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());

create policy interaction_outcomes_tenant_read on interaction_outcomes for select
  to app_runtime, app_worker, app_console using (tenant_id = app_tenant());
create policy interaction_outcomes_tenant_insert on interaction_outcomes for insert
  to app_runtime with check (tenant_id = app_tenant());

revoke all on support_interactions, support_requests, support_request_links, interaction_actions, interaction_outcomes from public;

grant select, insert on support_interactions to app_runtime, app_worker;
grant select on support_interactions to app_console;

grant select, insert on support_requests to app_runtime, app_worker;
grant update (sync_state, sync_attempts, last_sync_attempt_at, next_sync_attempt_at, last_sync_reason, sync_claim_token,
              salesforce_case_id, synced_at, disposition, next_step, deadline, commit_receipt_ids, row_version, updated_at)
  on support_requests to app_worker;
grant select on support_requests to app_console;

grant select, insert on support_request_links to app_runtime, app_worker;
grant select on support_request_links to app_console;

grant select, insert on interaction_actions to app_runtime;
grant update (receipt_id, receipt_outcome, contract_id, updated_at) on interaction_actions to app_runtime, app_worker;
grant select on interaction_actions to app_worker, app_console;

grant select, insert on interaction_outcomes to app_runtime;
grant select on interaction_outcomes to app_worker, app_console;

-- Idempotent creation: the runtime role cannot read restricted rows, so a retried creation
-- resolves its earlier row through this narrow lookup (opaque id and reference only, own
-- tenant only).
create or replace function support_request_by_creation_key(p_creation_key text)
  returns setof support_requests
  language sql stable security definer set search_path = public as $$
    select s.* from support_requests s
     where app_tenant() is not null and s.tenant_id = app_tenant() and s.creation_key = p_creation_key
$$;

-- Tenant of an action recorded by the business layer, for outbox consumers whose message
-- carries only the action id (opaque ids only; no row content).
create or replace function business_action_tenant(p_action_id text)
  returns text
  language sql stable security definer set search_path = public as $$
    select a.tenant_id from interaction_actions a where a.action_id = p_action_id
$$;

revoke all on function support_request_by_creation_key(text), business_action_tenant(text) from public;
grant execute on function support_request_by_creation_key(text) to app_runtime, app_worker;
grant execute on function business_action_tenant(text) to app_worker;
