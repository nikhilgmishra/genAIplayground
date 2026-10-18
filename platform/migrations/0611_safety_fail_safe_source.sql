-- Safety signal source FAIL_SAFE (spec section 10; SAFE-03): signals the system raises itself
-- because an input could not be assessed (malformed or oversize input, a malformed signal, a
-- failed detection stage). They were previously recorded as ASR_UNCERTAIN, which conflated
-- recognizer uncertainty with system fail-safe routing in evidence and dashboards.
--
-- Additive: the closed set of allowed signal_sources gains FAIL_SAFE; every existing row stays
-- valid. Rows remain append-only (the 0610 triggers are unchanged).

alter table safety_events drop constraint safety_events_signal_sources_check;
alter table safety_events add constraint safety_events_signal_sources_check check (
  safety_codes_subset(signal_sources,
    array['EXPLICIT_PHRASE', 'SEMANTIC_SIGNAL', 'ASR_UNCERTAIN', 'CALLER_REQUEST', 'HUMAN_INTERVENTION', 'FAIL_SAFE'])
);
