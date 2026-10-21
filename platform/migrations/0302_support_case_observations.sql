-- 0302 Reopened-case measurement (spec section 13 "Measure ... reopened cases"; requirement
-- SPEC-13.resolution-metrics). Business range; sorts after 0301.
--
-- Case status and ownership are managed by humans in Salesforce; the synchronization pushes
-- internal support requests by external id and never reads a status back. A reopening can only be
-- measured where the platform READS the Case status (SupportRecordSystem.getCaseByExternalId):
-- PgSupportRequestService.observeCaseStatus() maps the vendor status to OPEN / CLOSED with a
-- configured mapping (the tenant's Case Status picklist and closed semantics are UNKNOWN until
-- PRQ-006 / VQ-SF-04; unmapped values are never recorded or guessed) and appends a row here only
-- when the mapped state differs from the last recorded one. A row with previous_state CLOSED and
-- case_state OPEN is a reopening (audited as support_request.case_reopened, counted in
-- vsp_cases_reopened_total).
--
-- Content rules (DATA-01): opaque ids, the mapped state and a timestamp only; the vendor status
-- text is never stored.
--
-- Roles: app_worker reads and appends for its tenant (RLS). Nothing else reads it; append-only.

create table support_case_observations (
  observation_id     text        primary key check (observation_id ~ '^sco_[A-Za-z0-9_-]{16,64}$'),
  tenant_id          text        not null check (tenant_id ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  support_request_id text        not null references support_requests (support_request_id),
  case_state         text        not null check (case_state in ('OPEN', 'CLOSED')),
  previous_state     text        null check (previous_state is null or previous_state in ('OPEN', 'CLOSED')),
  observed_at        timestamptz not null,
  -- Only state changes are recorded.
  constraint support_case_observations_change check (previous_state is null or previous_state <> case_state)
);
create index support_case_observations_request on support_case_observations (tenant_id, support_request_id, observed_at);

create trigger support_case_observations_append_only before delete or update on support_case_observations
  for each row execute function support_records_no_delete();

alter table support_case_observations enable row level security;
alter table support_case_observations force row level security;

create policy support_case_observations_worker_read on support_case_observations for select
  to app_worker using (tenant_id = app_tenant());
create policy support_case_observations_worker_insert on support_case_observations for insert
  to app_worker with check (tenant_id = app_tenant());

revoke all on support_case_observations from public;
grant select, insert on support_case_observations to app_worker;
