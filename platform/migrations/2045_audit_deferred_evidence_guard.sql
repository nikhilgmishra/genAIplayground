-- 2045 a route deferral is evidence only through the chain (WP-04; follow-on FO-01-19, FO-01-34, FO-15-41,
-- FO-15-45; OPS-01, SAFE-03).
--
-- The route-audit reconciler and the audit verifier count a RECORDED deferral (audit_deferred) as route
-- evidence. Migration 2040 refused only a deferral INSERTED as DROPPED, so a writer could insert a row that was
-- RECORDED from the start (or PENDING with recorded or marker ids already set) and the route would look
-- evidenced without any event in the hash chain. From here on:
--   - a deferral starts PENDING with nothing recorded (no recorded/marker event, no drop reason, no attempts);
--   - it becomes RECORDED only together with the chained audit_outbox events it names: the recorded event
--     must be the deferred event itself (same tenant, action and correlation id) and the marker must be the
--     audit.deferred.recorded event of the same tenant and correlation whose parent is that event — which the
--     flush appends in the same transaction (DurableDeferredAuditQueue.flush).
-- The check reads audit_outbox with the function owner's rights (SECURITY DEFINER, fixed search_path) so it
-- holds for every role allowed to flush, under row-level security as for any other reader.

create or replace function audit_deferred_guard() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'PENDING' or new.recorded_event_id is not null or new.marker_event_id is not null or new.recorded_at is not null
       or new.drop_reason is not null or new.attempts <> 0 then
      raise exception 'AUDIT_DEFERRED_INVALID_START' using errcode = '42501';
    end if;
    return new;
  end if;
  if (new.deferral_id, new.journal_seq, new.tenant_id, new.source_stream, new.action, new.correlation_id, new.call_id,
      new.event_input, new.input_digest, new.reason_code, new.journal, new.deferred_at)
     is distinct from
     (old.deferral_id, old.journal_seq, old.tenant_id, old.source_stream, old.action, old.correlation_id, old.call_id,
      old.event_input, old.input_digest, old.reason_code, old.journal, old.deferred_at) then
    raise exception 'AUDIT_DEFERRED_IMMUTABLE' using errcode = '42501';
  end if;
  if old.status <> 'PENDING' then
    raise exception 'AUDIT_DEFERRED_TERMINAL' using errcode = '42501';
  end if;
  if new.status = 'RECORDED' then
    if not exists (select 1 from audit_outbox o
                    where o.event_id = new.recorded_event_id and o.tenant_id = new.tenant_id
                      and o.action = new.action and o.correlation_id = new.correlation_id)
       or new.marker_event_id is null
       or not exists (select 1 from audit_outbox m
                       where m.event_id = new.marker_event_id and m.tenant_id = new.tenant_id
                         and m.action = 'audit.deferred.recorded' and m.correlation_id = new.correlation_id
                         and m.event ->> 'parentId' = new.recorded_event_id) then
      raise exception 'AUDIT_DEFERRED_EVIDENCE_MISSING' using errcode = '42501';
    end if;
  end if;
  return new;
end
$$;

revoke all on function audit_deferred_guard() from public;
