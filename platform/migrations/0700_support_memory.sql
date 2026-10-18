-- Limited, provenance-labelled support memory (spec section 9, DATA-04).
-- Only verified preferences, active issues, completed actions, promises,
-- deadlines and reviewed summaries; each entry carries provenance and a
-- mandatory expiry. Memory never establishes identity, consent, authorization
-- or medical fact: value keys naming such facts are rejected here as well as in
-- the application (defense in depth).
--
-- Roles:
--   app_runtime  record and read entries of ONE subject: RLS requires both the
--                tenant and the subject context (app_subject()); no cross-subject
--                or cross-customer reads.
--   app_worker   expiry and retention deletion within a tenant.
-- Entries are immutable (no UPDATE for anyone, trigger).

create table support_memory (
  memory_id    text        primary key check (memory_id ~ '^mem_[A-Za-z0-9_-]{16,64}$'),
  tenant_id    text        not null check (char_length(tenant_id) between 3 and 80),
  subject_id   text        not null check (subject_id ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  kind         text        not null check (kind in ('PREFERENCE', 'OPEN_ISSUE', 'COMPLETED_ACTION', 'PROMISE', 'DEADLINE', 'REVIEWED_SUMMARY')),
  value        jsonb       not null check (jsonb_typeof(value) = 'object' and octet_length(value::text) <= 4096),
  provenance   text        not null check (provenance in ('VERIFIED', 'CALLER_REPORTED', 'MACHINE_INFERRED')),
  source_ref   text        not null check (source_ref ~ '^(ledger|case|wf|call|review)://[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$|^sr://SR-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$'),
  created_at   timestamptz not null,
  expires_at   timestamptz not null,
  constraint support_memory_expiry check (expires_at > created_at),
  -- A reviewed summary always points at a human review record.
  constraint support_memory_reviewed_summary check (kind <> 'REVIEWED_SUMMARY' or source_ref ~ '^review://rvw_'),
  -- Caller-reported entries come from a call; verified entries from a system of record or review.
  constraint support_memory_provenance_source check (
    (provenance <> 'CALLER_REPORTED' or source_ref ~ '^call://')
    and (provenance <> 'VERIFIED' or source_ref !~ '^call://')
  )
);

create index support_memory_subject on support_memory (tenant_id, subject_id, expires_at);
create index support_memory_expiry on support_memory (tenant_id, expires_at);
create index support_memory_created on support_memory (tenant_id, created_at);

create or replace function support_memory_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'SUPPORT_MEMORY_IMMUTABLE' using errcode = '42501';
  end if;
  if exists (
    select 1 from jsonb_each(new.value) e
     where lower(e.key) ~ '(assuranc|consent|authent|authoriz|verif|identit|permission|scope|^roles?$|role$|subjectid|actorid|diagnos|medicat|medicin|prescri|dosage|symptom|^risk|risk$|clinical|therap|psych|suicid|selfharm|crisis|password|passcode|secret|token|ssn|birth|^dob$)'
        or jsonb_typeof(e.value) in ('object', 'array')
  ) then
    raise exception 'SUPPORT_MEMORY_FORBIDDEN_VALUE' using errcode = '23514';
  end if;
  return new;
end
$$;

create trigger support_memory_guard
  before insert or update on support_memory
  for each row execute function support_memory_guard();

alter table support_memory enable row level security;
alter table support_memory force row level security;

create policy support_memory_runtime_read on support_memory for select
  to app_runtime using (tenant_id = app_tenant() and subject_id = app_subject());
create policy support_memory_runtime_insert on support_memory for insert
  to app_runtime with check (tenant_id = app_tenant() and subject_id = app_subject());
create policy support_memory_worker_read on support_memory for select
  to app_worker using (tenant_id = app_tenant());
create policy support_memory_worker_delete on support_memory for delete
  to app_worker using (tenant_id = app_tenant());

revoke all on support_memory from public;
grant select, insert on support_memory to app_runtime;
grant select, delete on support_memory to app_worker;
