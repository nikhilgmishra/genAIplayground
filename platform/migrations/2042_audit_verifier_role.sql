-- 2042 separate audit verifier identity (WP-04; follow-on FO-15-28, FO-15-40, FO-15-41, FO-15-42; OPS-01, OPS-03).
--
-- app_audit_verifier is the database identity of the audit exporter's VERIFIER task
-- (platform/src/audit/exporter/verifier.ts, scripts/vsp/verify-audit.mts). It is read-only: SELECT on
-- the audit evidence tables and on the source-of-truth columns it reconciles against (committed ledger
-- actions and their provider receipts, CRM synchronisation results), and nothing else. It cannot
-- insert, update or delete anything, cannot advance a chain head, cannot mark a manifest verified and
-- cannot purge. The writer roles (app_runtime, app_console, app_worker) keep their existing grants; the
-- verifier never shares their identity (its own NOLOGIN role granted to its own login principal).
--
-- Separation implemented in the database (IAM separation is modelled in infra/terraform/modules/audit
-- and needs the policy simulator in a sandbox, AIN-03):
--   key administration  : no database role (KMS key policy, audit account)
--   application use      : app_runtime / app_worker / app_console (append audit events, no UPDATE of content)
--   audit writing        : the same appenders through audit_outbox INSERT only (triggers enforce the chain)
--   audit reading        : app_auditor (tenant-filtered metadata view) and app_audit_verifier (full read, no write)

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_audit_verifier') then create role app_audit_verifier nologin; end if;
end
$$;

grant usage on schema public to app_audit_verifier;
grant execute on function app_tenant(), app_organization(), app_subject(), app_actor() to app_audit_verifier;

-- Audit evidence (all tenants: the verifier checks every stream's chain).
grant select on audit_outbox, audit_chain_heads, audit_manifests, audit_purge_watermarks, audit_sink_status to app_audit_verifier;
create policy audit_outbox_verifier_read on audit_outbox for select to app_audit_verifier using (true);
grant execute on function audit_backlog_stats() to app_audit_verifier;

-- Reconciliation sources: committed actions and provider receipts (content-free columns only).
grant select (action_id, tenant_id, state, provider_idempotency_key, receipt, updated_at) on action_ledger to app_audit_verifier;
create policy action_ledger_verifier_read on action_ledger for select to app_audit_verifier using (true);

-- Reconciliation sources: CRM synchronisation results (ids, state and times only).
grant select (support_request_id, tenant_id, sync_state, salesforce_case_id, synced_at) on support_requests to app_audit_verifier;
create policy support_requests_verifier_read on support_requests for select to app_audit_verifier using (true);

-- Route evidence journal state (deferred route events still pending are expected evidence, not a gap).
grant select on audit_deferred, route_audit_reconciliations to app_audit_verifier;
create policy audit_deferred_verifier_read on audit_deferred for select to app_audit_verifier using (true);
create policy route_audit_reconciliations_verifier_read on route_audit_reconciliations for select to app_audit_verifier using (true);

-- Inbound evidence metadata (FO-07-19: digest, schema and authentication mechanism are exported evidence).
grant select (inbox_id, tenant_id, source_id, event_id, schema_id, schema_version, payload_digest, auth_mechanism,
              credential_version, status, received_at, audit_event_id) on inbound_events to app_audit_verifier;
create policy inbound_events_verifier_read on inbound_events for select to app_audit_verifier using (true);
