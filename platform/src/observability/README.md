# platform/src/observability: content-free logs, metrics, traces and service objectives

Status: software IMPLEMENTED. The catalogue, label allowlists, the in-memory sink and the OpenTelemetry bridge
run in tests and the local demo; the OTLP export of the live composition (WP-07) is exercised on Layer 2 against a
throwaway OpenTelemetry Collector (`platform/test/integration/composition/telemetry.test.ts`). No collector or
backend is approved for any environment (AIN-37, PRQ-047 / PRQ-011: environment NOT_CONFIGURED), so no dashboard
or alarm has been observed with real data. Nothing here establishes HIPAA compliance or production readiness.

Spec: sections 6 (no PHI in identifiers, labels, alert text, baggage) and 13 (service objectives,
operational dashboards, resolution measures).

| File | Responsibility |
|---|---|
| `ports.ts` | `Logger` and `Metrics` ports (content-free field and label types). |
| `logger.ts` | Structured logger: string values survive only when the key category and value shape are allowlisted; anything else is `[redacted]` (DATA-01, AUTH-06). |
| `metrics.ts` | The metric catalogue (`createMetricCatalogue`, `DEFAULT_METRIC_CATALOGUE`), label normalization, `InMemoryMetrics` (LOCAL FIXTURE; unknown names throw in tests) and `OpenTelemetryMetrics` (live bridge; unknown names are dropped and counted). |
| `tracing.ts` | Span names and event names from closed registries (`SPAN_NAMES`, `SPAN_EVENT_NAMES`; anything else, including a well-formed name built from a value such as `patient.<name>`, becomes `invalid_span_name` / `invalid_event_name`; a new emitter registers its constants here) and attributes from an allowlist; id attributes accept only the platform's generated id grammar (`shared/ids.ts`: the key's own prefixes, exactly the 24-character `newId` body or the 12-character `newTurnId` body, no 7-digit run), reason codes (`vsp.reason_code`, `vsp.status`, `vsp.outcome`) only the closed upper-snake grammar (3 to 64 characters, at most 10 segments, no 5-digit run); anything else is dropped and counted. A grammar cannot tell a crafted value of the exact shape from a real one: emitters put server-generated ids and PlatformError reason-code constants only. Baggage is stripped; exceptions are never recorded. |
| `telemetry.ts` (WP-07) | `startTelemetry`: OpenTelemetry SDK `MeterProvider` (periodic reader) and `NodeTracerProvider` (batch processor) with the platform's own exporters; resource attributes pass `sanitizeResourceAttributes` (service identity only). Started by the live composition only when `observability.otlp` names an endpoint; export self-metrics (`vsp_telemetry_export_total`, `vsp_telemetry_attributes_dropped_total`) go to the bridge and to the process-local metrics. |
| `otlp.ts` (WP-07) | `OtlpJsonMetricExporter`, `OtlpJsonSpanExporter`: OTLP/HTTP JSON encoders posting through an injected `OtlpPost` (the egress-classified connector transport in the live composition, `adapters/live/otlp-transport.ts`); attributes outside the content-free allowlist, span and event names outside the registries, non-reason-code status messages, links and an instrumentation scope outside `SPAN_SCOPE_NAMES` (or a version that is not a version label) are dropped and counted, for spans of the raw tracer too (`Telemetry.rawTracer` bypasses SafeTracer, so the exporter is the only filter there; `otlp.test.ts`, Layer-2 `composition/telemetry.test.ts` against a real collector); a failing collector is counted and never affects the caller. |
| `catalog/` (WP-07), `composition-catalog.ts` | The metric catalogue split by owner: `composition-catalog.ts` (live composition, kept with the observability group because the composition owner of each phase owns it: capability states, guard ports reached, telemetry export, connector change feeds, outbox publish and consume failures, unit starts, console auth rate limit, alarm log events), `catalog/substrate.ts` (WP-04), `catalog/connectors.ts` (WP-06); `catalog/index.ts` merges them with `DEFAULT_METRIC_CATALOGUE` into `PLATFORM_METRIC_CATALOGUE` and fails on a duplicate name. |
| `alarms.ts` (WP-07) | Alarm rules as code (`COMPOSITION_ALARM_RULES`): metric, catalogue dimension values, statistic, period, threshold, missing-data treatment and an indexed runbook id (a test keeps each id in `docs/RUNBOOKS/README.md`); `evaluateAlarm`; `alarmLogTap` turns paging log events into `vsp_alarm_log_events_total{event}`. The CloudWatch resources are WP-39. |
| `slo.ts` | Spec section 13 service objectives as code (every target `PROPOSED`, nothing measured); evaluation yields INCONCLUSIVE on missing samples. |

## Catalogue rules (DATA-01)

- Every metric is declared with type, unit, dashboard and the exact label keys it may carry; each
  key has a closed enum of code constants. A value outside the enum becomes `other`, an undeclared
  key is dropped; both are counted in `vsp_metric_label_rejections_total`.
- Enums that mirror another module's codes are kept here so the catalogue never imports that module,
  and the owning module's tests assert the two lists are equal: `ADMISSION_REASON_CODES` (ops),
  `CONTRACT_INTENTS` (business resolution contracts, plus `unknown`), `VERIFICATION_ABUSE_SIGNAL_KINDS`
  (identity `AccountAbuseSignal`).
- Dynamic extensions (tool names, intents, model and voice labels) must be code-like tokens without
  long digit runs (`assertSafeDynamicLabelValue`).
- `scripts/ci/check-metric-names.mjs` fails when Terraform dashboards or alarms
  (`infra/terraform/modules/observability`) name a metric that is not in the catalogue; it reads the merged
  catalogue (every file under `catalog/` and `metrics.ts`).

## Resolution measures (dashboard `resolution`; SPEC-13.resolution-metrics)

Spec section 13: "Measure verified resolution, 24-hour and 7-day repeat contact, reopened cases ...
Keep containment separate from resolution ... Never reward the model for suppressing transfers".
Emitters live in `platform/src/business` (see its README for the definitions).

| Metric | Labels | Meaning |
|---|---|---|
| `vsp_interaction_outcomes_total` | `outcome`, `intent` | Every recorded call outcome (existing; `intent` now accepts every contract intent and `unknown` instead of collapsing them to `other`). |
| `vsp_verified_resolutions_total` | `intent`, `source` (`call_end`, `reconciliation`) | `RESOLVED` with the contract's committed receipt verified for the call, counted once per call at its first `RESOLVED` row. An accepted request or created Case is not a resolution (ACT-04), so there is no outcome label. |
| `vsp_contained_interactions_total` | `outcome`, `intent` | Calls with no human or safety transfer attempted: no transfer journey of any status for the call (read server-side by `business/outcomes.ts`; an abandoned, queued or still-routing transfer is an attempt, and so is a failed lookup), no connected and no failed transfer. Same definition as the evaluation aggregate (`transferOutcome` `NOT_ATTEMPTED`). Containment only, never success: no service objective in `slo.ts`, alarm or evaluation gate uses it (a test asserts no objective is measured on a resolution metric). |
| `vsp_repeat_contacts_total` | `window` (`24h`, `72h`, `7d`, `14d`, `30d`), `prior_outcome`, `prior_intent` | A call of an authorized subject with an earlier recorded call of the same subject inside the window (once per window). Which windows are measured is configuration (placeholder default `24h`, `7d`, pending PRQ-001). |
| `vsp_repeat_contact_checks_total` | `result` (`repeat`, `first_contact`, `no_authorized_subject`, `subject_ambiguous`, `check_failed`) | Denominator: one check per call's first recorded outcome. |
| `vsp_case_status_observations_total` | `case_state` (`open`, `closed`, `unmapped`) | Salesforce Case status reads by mapped state; the vendor status text is never a label. |
| `vsp_cases_reopened_total` | `issue_category` | A synchronized Case observed open after an observed close. |

No subject, actor, account, call, session, request or Case identifier is a label key or value of any
of these metrics.

## Identity abuse signals

`vsp_verification_abuse_signals_total{signal}` counts the account-keyed verification abuse signals
recorded by `platform/src/identity/abuse-monitor.ts`, labelled with the signal kind only
(`VERIFICATION_ABUSE_SIGNAL_KINDS`); it is the metric of the `verification-abuse-signals` alarm in
`infra/terraform/modules/observability`. It is counted before the hashed investigation counter is
written, so a key-value store outage cannot silence it. The coarser RiskFlag-valued
`vsp_challenge_abuse_signals_total{signal}` is still emitted alongside.
