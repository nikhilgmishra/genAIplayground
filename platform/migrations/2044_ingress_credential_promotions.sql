-- 2044 when an inbound credential version became current (WP-04; follow-on FO-06-98, FO-15-50; AUTH-04, AUTH-06).
--
-- During a rotation the PREVIOUS credential keeps verifying for the source's overlap window counted from the
-- moment the NEXT version became current (AWSCURRENT), not from when that version was created: a next key is
-- often staged as AWSPENDING long before it is promoted. Secrets Manager records no per-version promotion
-- time, so the platform records its own durable OBSERVATION: the first time any replica saw a version as
-- current (SecretsManagerCredentialResolver through PgCredentialPromotionLedger), shared by every replica and
-- surviving restarts. The previous version's overlap anchor is fixed once, when the new version is first
-- observed:
--   WITNESSED           the previous version had been observed as current within the observation bound
--                       (the promotion happened between that observation and this one): anchor = now;
--   PREVIOUS_LAST_SEEN  it had been observed, but longer ago than the bound: anchor = the later of that
--                       last observation and the new version's creation (a lower bound: shorter overlap);
--   VERSION_CREATED     the previous version was never observed as current here: anchor = the new
--                       version's creation time (lower bound);
--   UNKNOWN             neither is known: no anchor, the previous version gets NO overlap (fail closed).
-- Rows hold credential references (configuration) and version ids, never key material.

create table ingress_credential_promotions (
  credential_ref             text        not null check (char_length(credential_ref) <= 640
                                          and credential_ref ~ '^(arn:aws:secretsmanager:[a-z0-9-]{4,32}:[0-9]{12}:secret:[A-Za-z0-9/_+=.@-]+|local-fixture:[a-z0-9][a-z0-9._/-]{0,127})$'),
  version_id                 text        not null check (version_id ~ '^[A-Za-z0-9._-]{1,64}$'),
  previous_version_id        text        check (previous_version_id is null or previous_version_id ~ '^[A-Za-z0-9._-]{1,64}$'),
  version_created_at         timestamptz,
  first_observed_current_at  timestamptz not null,
  last_observed_current_at   timestamptz not null,
  overlap_anchor_at          timestamptz,
  anchor_basis               text        not null check (anchor_basis in ('WITNESSED', 'PREVIOUS_LAST_SEEN', 'VERSION_CREATED', 'UNKNOWN')),
  primary key (credential_ref, version_id),
  check (last_observed_current_at >= first_observed_current_at),
  check ((anchor_basis = 'UNKNOWN') = (overlap_anchor_at is null))
);

-- Only the last observation moves, and only forward; the anchor never changes; rows are never deleted.
create function ingress_credential_promotions_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'CREDENTIAL_PROMOTION_APPEND_ONLY' using errcode = '42501';
  end if;
  if (new.credential_ref, new.version_id, new.previous_version_id, new.version_created_at, new.first_observed_current_at,
      new.overlap_anchor_at, new.anchor_basis)
     is distinct from
     (old.credential_ref, old.version_id, old.previous_version_id, old.version_created_at, old.first_observed_current_at,
      old.overlap_anchor_at, old.anchor_basis)
     or new.last_observed_current_at < old.last_observed_current_at then
    raise exception 'CREDENTIAL_PROMOTION_IMMUTABLE' using errcode = '42501';
  end if;
  return new;
end
$$;
create trigger ingress_credential_promotions_guard before update or delete on ingress_credential_promotions
  for each row execute function ingress_credential_promotions_guard();
create trigger ingress_credential_promotions_no_truncate before truncate on ingress_credential_promotions
  for each statement execute function inbox_reject_change();

revoke all on ingress_credential_promotions from public;
revoke all on function ingress_credential_promotions_guard() from public;
-- The verifying processes: the gateway ingress (app_runtime) and the stream ingestor (app_worker).
grant select, insert on ingress_credential_promotions to app_runtime, app_worker;
grant update (last_observed_current_at) on ingress_credential_promotions to app_runtime, app_worker;
grant select on ingress_credential_promotions to app_console;
