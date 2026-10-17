-- Durable follow-up workflows (spec section 9): instances, append-only event history and human tasks.
-- NO PHI COLUMNS: every text column is an opaque identifier, enum, queue id, version label,
-- reason code or SHA-256 digest, enforced by CHECK constraints. Task tokens are never stored;
-- only their SHA-256 digest is (token_hash).

-- Opaque reference format accepted in source_record_refs: <prefix>_<16..64 base64url> or an
-- internal support reference SR-XXXX-XXXX. Rejects free text such as names or dates of birth.
create or replace function wf_refs_valid(refs text[]) returns boolean
  language sql immutable as
$$ select coalesce(bool_and(r ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$' or r ~ '^SR-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$'), true)
   from unnest(refs) as r $$;

create or replace function wf_roles_valid(roles text[]) returns boolean
  language sql immutable as
$$ select coalesce(bool_and(r in ('support_agent','supervisor','safety_responder','auditor','knowledge_editor',
                                  'policy_approver','deployment_operator','security_admin')), false)
   from unnest(roles) as r $$;

create table workflow_instances (
  workflow_id text primary key check (workflow_id ~ '^wf_[A-Za-z0-9_-]{16,64}$'),
  tenant_id text not null check (tenant_id ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  workflow_type text not null check (workflow_type in ('billing_dispute_review','provider_document_review',
    'claim_investigation','partner_onboarding','support_request_sync','callback_request','complaint_review')),
  -- Pinned at start; runtime roles have no UPDATE privilege on this column (version compatibility).
  definition_version text not null check (definition_version ~ '^\d{1,4}\.\d{1,4}\.\d{1,4}$'),
  state text not null check (state in ('ACCEPTED','VALIDATING','WAITING_FOR_SYSTEM','WAITING_FOR_HUMAN',
    'WAITING_FOR_CALLER','READY_TO_COMMIT','COMPLETED','FAILED','CANCELLED')),
  owner_queue text not null check (owner_queue ~ '^q_[a-z0-9_]{2,40}$'),
  deadline timestamptz null,
  attempts integer not null default 0 check (attempts >= 0),
  retry_budget integer not null default 0 check (retry_budget between 0 and 10),
  escalation_count integer not null default 0 check (escalation_count >= 0),
  source_record_refs text[] not null default '{}' check (cardinality(source_record_refs) <= 16 and wf_refs_valid(source_record_refs)),
  grant_ref text null check (grant_ref ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  correlation_id text not null check (correlation_id ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  policy_snapshot_version text null check (policy_snapshot_version ~ '^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$'),
  row_version integer not null check (row_version >= 1),
  state_entered_at timestamptz not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  -- Every nonterminal state has a deadline; terminal states have none.
  check ((state in ('COMPLETED','FAILED','CANCELLED')) = (deadline is null)),
  unique (tenant_id, workflow_id)
);
create index workflow_instances_due on workflow_instances (deadline) where deadline is not null;
create index workflow_instances_owner on workflow_instances (tenant_id, owner_queue, state);

create table workflow_events (
  event_id text primary key check (event_id ~ '^wfe_[A-Za-z0-9_-]{16,64}$'),
  tenant_id text not null,
  workflow_id text not null,
  seq integer not null check (seq >= 1),
  workflow_type text not null,
  definition_version text not null check (definition_version ~ '^\d{1,4}\.\d{1,4}\.\d{1,4}$'),
  from_state text null,
  to_state text not null,
  trigger text not null check (trigger ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  actor_kind text not null check (actor_kind in ('system','staff','caller','external_system')),
  actor_ref text null check (actor_ref ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$'),
  occurred_at timestamptz not null,
  deadline timestamptz null,
  attempt integer not null check (attempt >= 0),
  correlation_id text not null,
  source_record_refs text[] not null default '{}' check (cardinality(source_record_refs) <= 16 and wf_refs_valid(source_record_refs)),
  owner_queue text not null check (owner_queue ~ '^q_[a-z0-9_]{2,40}$'),
  reason_code text null check (reason_code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  dedupe_key text null check (dedupe_key ~ '^[A-Za-z0-9:._-]{1,128}$'),
  foreign key (tenant_id, workflow_id) references workflow_instances (tenant_id, workflow_id),
  unique (workflow_id, seq),
  unique (workflow_id, dedupe_key)
);

create table workflow_tasks (
  task_id text primary key check (task_id ~ '^wft_[A-Za-z0-9_-]{16,64}$'),
  tenant_id text not null,
  workflow_id text not null,
  task_type text not null check (task_type ~ '^[a-z][a-z0-9_]{2,63}$'),
  state_name text not null check (state_name = 'WAITING_FOR_HUMAN'),
  -- Instance row_version at which the task's state was entered; a task is only valid for that entry.
  state_entry_version integer not null check (state_entry_version >= 1),
  required_roles text[] not null check (cardinality(required_roles) between 1 and 8 and wf_roles_valid(required_roles)),
  owner_queue text not null check (owner_queue ~ '^q_[a-z0-9_]{2,40}$'),
  -- SHA-256 of the current task token. The plaintext is returned once and never stored.
  token_hash text null check (token_hash ~ '^[a-f0-9]{64}$'),
  token_issued_to text null check (token_issued_to ~ '^stf_[A-Za-z0-9_-]{8,64}$'),
  token_issued_at timestamptz null,
  token_expires_at timestamptz null,
  expires_at timestamptz not null,
  status text not null check (status in ('OPEN','COMPLETED','EXPIRED','CANCELLED')),
  decision text null check (decision in ('APPROVE','REJECT')),
  completed_by text null check (completed_by ~ '^stf_[A-Za-z0-9_-]{8,64}$'),
  completed_at timestamptz null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  foreign key (tenant_id, workflow_id) references workflow_instances (tenant_id, workflow_id),
  check ((status = 'COMPLETED') = (completed_by is not null and completed_at is not null and decision is not null)),
  check ((token_hash is null) = (token_issued_to is null) and (token_hash is null) = (token_expires_at is null)),
  check (status = 'OPEN' or token_hash is null)
);
-- At most one open human task per workflow.
create unique index workflow_tasks_one_open on workflow_tasks (workflow_id) where status = 'OPEN';
create index workflow_tasks_open_by_tenant on workflow_tasks (tenant_id, status, expires_at);

-- Event history is append-only for every role, including the owner (defense in depth beyond grants).
create or replace function workflow_events_append_only() returns trigger language plpgsql as
$$ begin raise exception 'WORKFLOW_EVENTS_APPEND_ONLY' using errcode = '42501'; end $$;
create trigger workflow_events_no_update before update or delete on workflow_events
  for each row execute function workflow_events_append_only();
create trigger workflow_events_no_truncate before truncate on workflow_events
  for each statement execute function workflow_events_append_only();

-- Row-level tenant isolation for every runtime role.
alter table workflow_instances enable row level security;
alter table workflow_events enable row level security;
alter table workflow_tasks enable row level security;

create policy workflow_instances_tenant on workflow_instances
  for all to app_runtime, app_worker, app_console
  using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy workflow_events_tenant on workflow_events
  for all to app_runtime, app_worker, app_console, app_auditor
  using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy workflow_tasks_tenant on workflow_tasks
  for all to app_runtime, app_worker, app_console
  using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());

-- Grants: least privilege. Pinned/identity columns are not updatable by runtime roles.
grant select, insert on workflow_instances to app_runtime, app_worker;
grant update (state, owner_queue, deadline, attempts, retry_budget, escalation_count, row_version, state_entered_at, updated_at)
  on workflow_instances to app_runtime, app_worker;
grant select on workflow_instances to app_console;

grant select, insert on workflow_events to app_runtime, app_worker;
grant select on workflow_events to app_console, app_auditor;

grant select, insert on workflow_tasks to app_runtime, app_worker;
grant update (token_hash, token_issued_to, token_issued_at, token_expires_at, status, decision, completed_by, completed_at, updated_at)
  on workflow_tasks to app_runtime, app_worker;
grant select (task_id, tenant_id, workflow_id, task_type, state_name, required_roles, owner_queue, expires_at, status,
              decision, completed_by, completed_at, created_at, updated_at)
  on workflow_tasks to app_console;

-- Cross-tenant due-work scan for the worker. Returns opaque ids only; each instance is then
-- processed in its own tenant-scoped (RLS) transaction.
create or replace function workflow_due_instances(p_now timestamptz, p_limit integer)
  returns table (tenant_id text, workflow_id text)
  language sql stable security definer set search_path = public as
$$ select i.tenant_id, i.workflow_id from workflow_instances i
   where i.state not in ('COMPLETED','FAILED','CANCELLED')
     and ((i.deadline is not null and i.deadline <= p_now) or i.attempts > i.retry_budget)
   order by i.deadline nulls first, i.workflow_id
   limit greatest(1, least(p_limit, 1000)) $$;
revoke all on function workflow_due_instances(timestamptz, integer) from public;
grant execute on function workflow_due_instances(timestamptz, integer) to app_worker;
grant execute on function wf_refs_valid(text[]), wf_roles_valid(text[]) to app_runtime, app_worker, app_console, app_auditor;
