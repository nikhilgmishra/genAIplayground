# platform/src/observability: content-free logs, metrics, traces and service objectives

Status: **IMPLEMENTED_OFFLINE**. The catalogue, label allowlists, the in-memory sink and the
OpenTelemetry bridge run in tests and the local demo only. No exporter or collector is configured
here: metrics export (OpenTelemetry to CloudWatch, Datadog only if approved) is BLOCKED on
PRQ-047 / PRQ-011, so no dashboard or alarm has been observed with real data. Nothing here
establishes HIPAA compliance or production readiness.

Spec: sections 6 (no PHI in identifiers, labels, alert text, baggage) and 13 (service objectives,
operational dashboards, resolution measures).

| File | Responsibility |
|---|---|
| `ports.ts` | `Logger` and `Metrics` ports (content-free field and label types). |
| `logger.ts` | Structured logger: string values survive only when the key category and value shape are allowlisted; anything else is `[redacted]` (DATA-01, AUTH-06). |
| `metrics.ts` | The metric catalogue (`createMetricCatalogue`, `DEFAULT_METRIC_CATALOGUE`), label normalization, `InMemoryMetrics` (LOCAL FIXTURE; unknown names throw in tests) and `OpenTelemetryMetrics` (live bridge; unknown names are dropped and counted). |
| `tracing.ts` | Span names and attributes from allowlists; baggage is stripped; exceptions are never recorded. |
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
  (`infra/terraform/modules/observability`) name a metric that is not in the catalogue.

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
