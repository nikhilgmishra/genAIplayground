-- 0910 worker privileges required by the composition wiring (console range; sorts after 0900).
--
-- 1) Retention purge of console idempotency records (dataset console_idempotency, strategy
--    HARD_DELETE, data class SECURITY_AUDIT; platform/src/retention/datasets.ts). The worker may
--    read ONLY the key and timestamp columns it needs to select expired rows (never the request
--    digest, status or the stored response body) and delete rows of the tenant set in its RLS
--    context. Nothing is deleted until privacy counsel sets a SECURITY_AUDIT duration: the
--    retention job keeps reporting BLOCKED_RETENTION_UNSET until then.
grant select (tenant_id, staff_id, endpoint, idempotency_key_hash, created_at, expires_at) on console_idempotency to app_worker;
grant delete on console_idempotency to app_worker;

create policy console_idempotency_worker_select on console_idempotency for select
  to app_worker using (tenant_id = app_tenant());
create policy console_idempotency_worker_delete on console_idempotency for delete
  to app_worker using (tenant_id = app_tenant());

-- 2) Durable action grants issued by the action.committed outbox consumer (worker) when a billing
--    review commit was completed by reconciliation instead of the per-call commit transaction:
--    the follow-up starts billing_dispute_review with its grant in the consumer's dedup
--    transaction (spec section 7). INSERT only; the tenant RLS policy of migration 0402 already
--    covers app_worker, the CHECK constraints bound every column and the guard trigger still
--    refuses any change other than a single revocation and every DELETE.
grant insert on durable_action_grants to app_worker;
