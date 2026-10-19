-- 0301 Repeat-contact measurement (spec section 13 "Measure verified resolution, 24-hour and 7-day
-- repeat contact, reopened cases"; requirement SPEC-13.resolution-metrics). Business range; sorts
-- after 0300.
--
-- interaction_outcomes gains the opaque reference of the call's AUTHORIZED subject, resolved
-- server-side by the outcome service (platform/src/business/outcomes.ts) from the call's own
-- records only: the subject a trusted component passes from the authorized session, the subjects of
-- the call's ledger actions (prepared only after a policy allow) and the A2+ subject links of the
-- call's support requests that the runtime role can read. Null when the call had no authorized
-- subject or the records name more than one (never guessed). An append-only revision row copies the
-- subject of the row it revises.
--
-- Content rules (DATA-01): an opaque id only (same check as support_requests.subject_ref). It is
-- never a metric label, log field or alert text; repeat-contact metrics carry only the window, the
-- prior outcome and the prior intent.
--
-- Row-level security and the append-only trigger of migration 0300 already cover the new column
-- (tenant-scoped reads, inserts by app_runtime only). Least privilege: app_runtime (the outcome
-- service) and app_worker (worker jobs; retention holds by subject once the dataset names the
-- column) read it. app_console keeps every other column but not subject_ref (no console view reads
-- outcomes by subject), so the outcome row of a call whose handoff record is restricted names no
-- subject to the console.

alter table interaction_outcomes
  add column subject_ref text null check (subject_ref is null or subject_ref ~ '^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$');

-- Prior contacts of one subject inside a window, newest first (tenant-scoped; RLS still applies).
create index interaction_outcomes_subject on interaction_outcomes (tenant_id, subject_ref, recorded_at) where subject_ref is not null;

-- The console's table-wide SELECT (migration 0300) becomes a column grant without subject_ref.
revoke select on interaction_outcomes from app_console;
grant select (outcome_id, tenant_id, call_id, contract_id, outcome, reason_code, evidence, recorded_at)
  on interaction_outcomes to app_console;
