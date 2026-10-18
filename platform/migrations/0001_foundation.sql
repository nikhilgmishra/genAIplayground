-- Foundation: runtime roles and row-level-security context helpers.
-- Runtime roles are NOLOGIN; deployments grant them to IAM-authenticated login roles.
-- Superuser/owner connections are reserved for migrations and must not serve traffic.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_runtime') then create role app_runtime nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'app_worker') then create role app_worker nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'app_console') then create role app_console nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'app_auditor') then create role app_auditor nologin; end if;
end
$$;

grant usage on schema public to app_runtime, app_worker, app_console, app_auditor;

-- Transaction-local RLS context set by the application via set_config(..., true).
create or replace function app_tenant() returns text language sql stable as
  $$ select nullif(current_setting('app.tenant_id', true), '') $$;
create or replace function app_organization() returns text language sql stable as
  $$ select nullif(current_setting('app.organization_id', true), '') $$;
create or replace function app_subject() returns text language sql stable as
  $$ select nullif(current_setting('app.subject_id', true), '') $$;
create or replace function app_actor() returns text language sql stable as
  $$ select nullif(current_setting('app.actor_id', true), '') $$;

grant execute on function app_tenant(), app_organization(), app_subject(), app_actor()
  to app_runtime, app_worker, app_console, app_auditor;
