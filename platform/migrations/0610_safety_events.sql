-- Safety events (spec sections 10 and 13): content-free, append-only evidence of
-- validated safety signals and clinical-boundary routes, priority-route
-- initiation (time from validated signal to route initiation, measured with the
-- application clock against the 2 s engineering target) and route outcomes.
--
-- Content-free by construction: every column is an opaque identifier, a
-- closed-set code, a boolean, a bounded integer or a timestamp, each enforced by a
-- check constraint. There is no column that can hold caller words, transcript
-- text, clinical statements or free-form notes (DATA-01).
--
-- One incident has one SIGNAL_VALIDATED row, at most one ROUTE_INITIATED row and
-- any number of OUTCOME rows (append-only progression; the newest outcome wins).
--
-- Roles: app_runtime and app_worker insert and read their tenant's rows;
-- app_console and app_auditor read. Nobody (owner included) can update, delete or
-- truncate (trigger). Forced row-level security scopes every role to app_tenant().

create or replace function safety_rule_ids_valid(ids text[]) returns boolean language sql immutable as $$
  select cardinality(ids) <= 32
     and coalesce((select bool_and(x is not null and x ~ '^[a-z][a-z0-9_.-]{2,80}$') from unnest(ids) as x), true)
$$;

create or replace function safety_codes_subset(vals text[], allowed text[]) returns boolean language sql immutable as $$
  select cardinality(vals) <= cardinality(allowed)
     and coalesce((select bool_and(x is not null and x = any(allowed)) from unnest(vals) as x), true)
$$;

create table safety_events (
  event_id              text        primary key check (event_id ~ '^sev_[A-Za-z0-9_-]{16,64}$'),
  incident_id           text        not null check (incident_id ~ '^sin_[A-Za-z0-9_-]{16,64}$'),
  tenant_id             text        not null check (tenant_id ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  call_id               text        not null check (call_id ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  -- 0 = no trusted session yet (unverified caller before session binding).
  session_generation    integer     not null check (session_generation between 0 and 1000000),
  turn_id               text        check (turn_id is null or turn_id ~ '^turn_[A-Za-z0-9_-]{4,64}$'),
  phase                 text        not null check (phase in ('SIGNAL_VALIDATED', 'ROUTE_INITIATED', 'OUTCOME')),
  signal_sources        text[]      not null check (safety_codes_subset(signal_sources,
                          array['EXPLICIT_PHRASE', 'SEMANTIC_SIGNAL', 'ASR_UNCERTAIN', 'CALLER_REQUEST', 'HUMAN_INTERVENTION'])),
  rule_ids              text[]      not null check (safety_rule_ids_valid(rule_ids)),
  clinical_categories   text[]      not null check (safety_codes_subset(clinical_categories,
                          array['DIAGNOSIS', 'MEDICATION', 'THERAPY_ADVICE', 'CLINICAL_SCREENING'])),
  strongest_strength    text        check (strongest_strength is null or strongest_strength in ('CREDIBLE', 'UNRESOLVED')),
  any_third_party       boolean     not null,
  any_historical        boolean     not null,
  any_negated           boolean     not null,
  route                 text        not null check (route in ('SAFETY_PRIORITY_HUMAN', 'CLINICAL_BOUNDARY_ROUTE')),
  destination_id        text        not null check (destination_id ~ '^dst_[a-z0-9_]{2,40}$'),
  reason_code           text        not null check (reason_code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  locale                text        not null check (locale ~ '^([a-z]{2,3}(-[A-Z]{2}|-[0-9]{3})?|und)$'),
  locale_supported      boolean     not null,
  after_hours           boolean     not null,
  utterance_ended_at    timestamptz,
  detected_at           timestamptz not null,
  detection_latency_ms  integer     check (detection_latency_ms is null or detection_latency_ms between 0 and 86400000),
  route_initiated_at    timestamptz,
  latency_ms            integer     check (latency_ms is null or latency_ms between 0 and 86400000),
  target_ms             integer     not null check (target_ms between 1 and 60000),
  within_target         boolean,
  transfer_id           text        check (transfer_id is null or transfer_id ~ '^xfr_[A-Za-z0-9_-]{16,64}$'),
  outcome               text        check (outcome is null or outcome in ('IN_PROGRESS', 'TRANSFERRED', 'CALLER_DISCONNECTED', 'FAILED', 'OUTCOME_UNKNOWN')),
  audit_event_id        text        check (audit_event_id is null or audit_event_id ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  audit_status          text        not null check (audit_status in ('RECORDED', 'AUDIT_UNAVAILABLE')),
  recorded_at           timestamptz not null,

  constraint safety_events_route_shape check (
    (route = 'SAFETY_PRIORITY_HUMAN' and cardinality(signal_sources) >= 1 and strongest_strength is not null)
    or (route = 'CLINICAL_BOUNDARY_ROUTE' and cardinality(signal_sources) = 0 and cardinality(clinical_categories) >= 1)
  ),
  constraint safety_events_initiation_shape check (
    (phase = 'ROUTE_INITIATED') = (route_initiated_at is not null and latency_ms is not null and within_target is not null)
  ),
  constraint safety_events_initiation_order check (route_initiated_at is null or route_initiated_at >= detected_at),
  constraint safety_events_latency_consistent check (
    route_initiated_at is null
    or abs(latency_ms - round(extract(epoch from (route_initiated_at - detected_at)) * 1000)) <= 1
  ),
  constraint safety_events_within_target check (within_target is null or within_target = (latency_ms <= target_ms)),
  constraint safety_events_detection_latency check (
    detection_latency_ms is null or (utterance_ended_at is not null and utterance_ended_at <= detected_at)
  ),
  constraint safety_events_outcome_shape check ((phase = 'OUTCOME') = (outcome is not null)),
  -- TRANSFERRED requires the transfer coordinator's record (receiver acceptance + verified connection, SAFE-04).
  constraint safety_events_transferred_has_transfer check (outcome is distinct from 'TRANSFERRED' or transfer_id is not null),
  constraint safety_events_audit_shape check ((audit_status = 'RECORDED') = (audit_event_id is not null))
);

create unique index safety_events_one_validation on safety_events (tenant_id, incident_id) where phase = 'SIGNAL_VALIDATED';
create unique index safety_events_one_initiation on safety_events (tenant_id, incident_id) where phase = 'ROUTE_INITIATED';
create index safety_events_tenant_time on safety_events (tenant_id, detected_at);
create index safety_events_tenant_call on safety_events (tenant_id, call_id);

create or replace function safety_events_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'SAFETY_EVENTS_APPEND_ONLY' using errcode = '42501';
end
$$;

create trigger safety_events_no_update_delete before update or delete on safety_events
  for each row execute function safety_events_append_only();
create trigger safety_events_no_truncate before truncate on safety_events
  for each statement execute function safety_events_append_only();

alter table safety_events enable row level security;
alter table safety_events force row level security;

create policy safety_events_read on safety_events for select
  to app_runtime, app_worker, app_console, app_auditor using (tenant_id = app_tenant());
create policy safety_events_insert on safety_events for insert
  to app_runtime, app_worker with check (tenant_id = app_tenant());

revoke all on safety_events from public;
grant select on safety_events to app_runtime, app_worker, app_console, app_auditor;
grant insert on safety_events to app_runtime, app_worker;
revoke all on function safety_events_append_only() from public;
grant execute on function safety_rule_ids_valid(text[]), safety_codes_subset(text[], text[])
  to app_runtime, app_worker, app_console, app_auditor;
