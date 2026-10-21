# Runbooks

Incident, recovery and release runbooks (spec sections 12 and 13). **Every runbook is a draft
that has never been drilled.** Nothing in this directory has been executed against a real
tenant, account or telephone path. "Last drilled: NEVER (not yet run)" stays until a drill record
exists in the audit evidence store; a drill is evidence, not a calendar entry.

Software preserves evidence and supports the process. **Privacy counsel determines reporting
obligations and deadlines**; no runbook decides whether a breach notification is required.

## Index

| Runbook | Id (aliases) | Severity | Primary owner role | Last drilled |
|---|---|---|---|---|
| [PHI exposure](phi-exposure.md) | RB-PHI-EXPOSURE | SEV-1 | Security operations on-call | NEVER (not yet run) |
| [Unsafe output](unsafe-output.md) | RB-UNSAFE-OUTPUT | SEV-1 | Clinical safety lead | NEVER (not yet run) |
| [Failed safety transfer](failed-safety-transfer.md) | RB-FAILED-SAFETY-TRANSFER (RB-SAFETY-ROUTE) | SEV-1 | Safety responder on-call | NEVER (not yet run) |
| [Authentication bypass](authentication-bypass.md) | RB-AUTH-BYPASS | SEV-1 | Security operations on-call | NEVER (not yet run) |
| [Dependency outage](dependency-outage.md) | RB-DEPENDENCY-OUTAGE (RB-TOOL-LATENCY) | SEV-2 | SRE on-call | NEVER (not yet run) |
| [Unexpected spending](unexpected-spending.md) | RB-UNEXPECTED-SPEND | SEV-2 | Finance and platform owner | NEVER (not yet run) |
| [Duplicate commit](duplicate-commit.md) | RB-DUPLICATE-COMMIT | SEV-1 | SRE on-call | NEVER (not yet run) |
| [Vendor behaviour change](vendor-behavior-change.md) | RB-VENDOR-CHANGE | SEV-2 | Talkdesk administrator | NEVER (not yet run) |
| [AI-off route and outage service mode](ai-off-route.md) | RB-AI-OFF-ROUTE (RB-ADMISSION) | SEV-2 | Support operations lead | NEVER (not yet run) |
| [Kill switch operations](kill-switch-operations.md) | RB-KILL-SWITCH | Procedure | Supervisor / security admin | NEVER (not yet run) |
| [Reconciliation and DLQ repair](reconciliation-and-dlq-repair.md) | RB-UNKNOWN-COMMIT (RB-CRM-RECONCILE, RB-DLQ-REPAIR) | SEV-2 / SEV-3 | SRE on-call | NEVER (not yet run) |
| [Audit sink outage](audit-sink-outage.md) | RB-AUDIT-OUTAGE (RB-AUDIT-GAP) | SEV-1 / SEV-2 | Security operations on-call | NEVER (not yet run) |
| [Restore drill](restore-drill.md) | RB-RESTORE-DRILL | Drill | SRE lead | NEVER (not yet run) |
| [Regional failover](regional-failover.md) | RB-REGIONAL-FAILOVER | SEV-1 | Incident commander | NEVER (not yet run) |
| [Secret rotation](secret-rotation.md) | RB-SECRET-ROTATION | Procedure / SEV-1 on compromise | Security admin | NEVER (not yet run) |
| [Access review](access-review.md) | RB-ACCESS-REVIEW | Procedure | Security admin | NEVER (not yet run) |
| [Policy release](policy-release.md) | RB-POLICY-RELEASE | Procedure | Policy approver | NEVER (not yet run) |
| [Knowledge release](knowledge-release.md) | RB-KNOWLEDGE-RELEASE | Procedure | Knowledge owner | NEVER (not yet run) |

## Alarm and dashboard map

Alarm names are `<prefix>-<key>` and dashboards `<prefix>-<name>` as defined in
`infra/terraform/modules/observability/main.tf` (plans only; the metrics export and paging are
BLOCKED, PRQ-011 and PRQ-047). Alarm descriptions carry the runbook id.

| Alarm key | Runbook id in alarm text | Runbook |
|---|---|---|
| `safety-route-initiation` | RB-SAFETY-ROUTE | [failed-safety-transfer.md](failed-safety-transfer.md) |
| `safety-handoff-failed` | RB-FAILED-SAFETY-TRANSFER | [failed-safety-transfer.md](failed-safety-transfer.md) |
| `boundary-violation` | RB-UNSAFE-OUTPUT | [unsafe-output.md](unsafe-output.md) |
| `duplicate-effects` | RB-DUPLICATE-COMMIT | [duplicate-commit.md](duplicate-commit.md) |
| `unknown-commits` | RB-UNKNOWN-COMMIT | [reconciliation-and-dlq-repair.md](reconciliation-and-dlq-repair.md) |
| `crm-sync-lag` | RB-CRM-RECONCILE | [reconciliation-and-dlq-repair.md](reconciliation-and-dlq-repair.md) |
| SQS dead-letter alarms (`infra/terraform/modules/sqs`) | RB-DLQ-REPAIR | [reconciliation-and-dlq-repair.md](reconciliation-and-dlq-repair.md) |
| `audit-backlog-not-draining` | RB-AUDIT-OUTAGE | [audit-sink-outage.md](audit-sink-outage.md) |
| `audit-ingestion-gap`, `audit-export-incomplete` | RB-AUDIT-GAP | [audit-sink-outage.md](audit-sink-outage.md) |
| `audit-deferred-depth` | RB-AUDIT-OUTAGE | [audit-sink-outage.md](audit-sink-outage.md) |
| `audit-deferred-dropped`, `audit-not-recorded-ratio` | RB-AUDIT-GAP | [audit-sink-outage.md](audit-sink-outage.md) |
| `verification-abuse-signals` | RB-AUTH-BYPASS | [authentication-bypass.md](authentication-bypass.md) |
| `tool-latency-p95` | RB-TOOL-LATENCY | [dependency-outage.md](dependency-outage.md) |
| `ingress-5xx-rate`, `gateway-no-healthy-targets`, `waf-tool-path-rate-observed` | RB-DEPENDENCY-OUTAGE | [dependency-outage.md](dependency-outage.md) |
| `budget-burn` | RB-UNEXPECTED-SPEND | [unexpected-spending.md](unexpected-spending.md) |
| `admission-rejections` | RB-ADMISSION | [ai-off-route.md](ai-off-route.md) |

Composition alarm rules (WP-07, rules as code in `platform/src/observability/alarms.ts`, evaluated against the
metric catalogue; the CloudWatch alarm resources for them are WP-39 and not yet in `infra/terraform`). A test
(`platform/src/observability/alarms.test.ts`) keeps every rule's runbook id in this index.

| Alarm key | Runbook id in alarm text | Runbook |
|---|---|---|
| `connector-feed-dead-letter-refused` | RB-DLQ-REPAIR | [reconciliation-and-dlq-repair.md](reconciliation-and-dlq-repair.md): a connector change feed stopped because its dead-letter queue refused a record (full, deleted or unwritable); its checkpoint is kept and nothing was dropped. Restore the queue (it exists and accepts writes); the feed resumes from the checkpoint on its next run and dead-letters the record (Layer-2 `[FAULT:DLQ_FULL]`, `platform/test/integration/composition/faults.test.ts`) |
| `action-reconcile-degraded` | RB-UNKNOWN-COMMIT | [reconciliation-and-dlq-repair.md](reconciliation-and-dlq-repair.md): the worker's `actions.reconcile` loop found actions in UNKNOWN or stale COMMITTING and settled none of them (`vsp_action_reconcile_degraded_total{reason}`: `all_inconclusive` every provider lookup was inconclusive, `no_provider` no provider for the kind); the alarm fires after three such runs in 15 minutes. Each such run fails (`ACTION_RECONCILE_INCONCLUSIVE` / `ACTION_RECONCILE_PROVIDER_MISSING`) and worker readiness turns 503 after consecutive failing runs. Check the provider and its lookup; reconcile the actions through the audited console path; callers are never told an unknown outcome succeeded |
| `outbox-publish-failures` | RB-DLQ-REPAIR | [reconciliation-and-dlq-repair.md](reconciliation-and-dlq-repair.md): the worker's `outbox.dispatch` loop could not publish outbox messages to the queue (`vsp_outbox_publish_failures_total{reason}`: `publish_failed` left PENDING for a retry with backoff, `dead_lettered` moved to DEAD after the attempt limit); nothing is lost, the messages stay in PostgreSQL. A run with a failed publish fails (`OUTBOX_PUBLISH_FAILED` / `OUTBOX_DEAD_LETTERED`), so does a run while earlier failures wait out their backoff (`OUTBOX_PUBLISH_RETRYING`), and worker readiness turns 503 after three failing runs. Restore the queue or the worker's publish permission; PENDING messages publish on their next attempt, DEAD messages are requeued through the audited console repair (Layer-2 `platform/test/integration/composition/worker.test.ts`) |
| `outbox-consume-failures` | RB-DLQ-REPAIR | [reconciliation-and-dlq-repair.md](reconciliation-and-dlq-repair.md): the live worker's `outbox.consume` loop failed on at least one message (`vsp_outbox_consume_failures_total{reason}`: `consume_failed`, `envelope_invalid`, `no_consumer`); the messages were not deleted and move to the outbox dead-letter queue after the redrive count. The loop run fails (`OUTBOX_CONSUME_FAILED` / `OUTBOX_UNCONSUMABLE`) and worker readiness turns 503 after consecutive failing runs. Fix the consumer (or the producer of the invalid envelope), then redrive |
| `inbox-dead-letter` | RB-DLQ-REPAIR | [reconciliation-and-dlq-repair.md](reconciliation-and-dlq-repair.md): an inbound event reached INBOUND_DEAD after bounded attempts; replay it (fresh MFA, audit record first) only after the cause is fixed |
| `capability-guard-port-reached` | RB-ADMISSION | [ai-off-route.md](ai-off-route.md): a NOT_CONFIGURED capability's guard port was called past its admission gate; the call failed closed (`CAPABILITY_NOT_CONFIGURED`); treat it as a defect in the path that skipped the gate |
| `telemetry-attribute-dropped` | RB-PHI-EXPOSURE | [phi-exposure.md](phi-exposure.md): an attribute outside the content-free telemetry allowlist reached the exporter and was dropped before export; find the emitter |
| `console-sso-terminal-closure-unaudited`, `console-sso-terminal-audit-unwritten` | RB-AUDIT-GAP | [audit-sink-outage.md](audit-sink-outage.md) and [access-review.md](access-review.md) step 3b |
| `audit-journal-memory-fallback` | RB-AUDIT-OUTAGE | [audit-sink-outage.md](audit-sink-outage.md) |
| `audit-journal-lost-at-shutdown` | RB-AUDIT-GAP | [audit-sink-outage.md](audit-sink-outage.md) |

Dashboards: `call-flow`, `identity`, `tools-dependencies`, `safety`, `crm-reconciliation`,
`knowledge`, `voice-experience`, `cost-quotas`, `audit`, `admission-controls`, `platform`.

## Severity scale

| Severity | Meaning | Response |
|---|---|---|
| SEV-1 | Possible PHI exposure, unauthorised mutation or disclosure, unsafe clinical response, failed safety handoff, authentication bypass, loss of audit evidence for accepted actions, or regional outage | Immediate containment of the affected automation; page incident commander, security operations and (for safety) the safety responder; do not wait for a monthly average (spec section 15) |
| SEV-2 | Degraded service with safe routes intact (dependency outage, AI-off mode, spend anomaly, vendor change under investigation) | Page SRE on-call; contain within the runbook |
| SEV-3 | Backlog or reconciliation work with no caller impact | Next business hours |
| Procedure | Planned change or periodic control | Scheduled; evidence recorded |

## Communication roles

Runbooks name roles, not people. The roster is BLOCKED on PRQ-001 (named incident authority)
and PRQ-011 (on-call roster and paging).

| Role | Responsibility |
|---|---|
| Incident commander | Named incident authority (PRQ-001); owns decisions, timeline and handoffs |
| Safety responder on-call | Takes over affected callers; owns safety follow-up |
| Clinical safety lead | Decides on clinical-boundary and safety script changes |
| Privacy counsel | Determines reporting obligations and deadlines; approves external wording |
| Security operations on-call | Containment, evidence preservation, forensic coordination |
| SRE on-call | Platform actions, kill switches, recovery |
| Support operations lead | Queue staffing, outage service mode, wait messages |
| Talkdesk administrator / Salesforce administrator | Vendor configuration and vendor tickets |
| Communications lead | Caller, partner and internal communications after privacy counsel approval |
| Finance and platform owner | Spend decisions, vendor billing contacts |
| Executive sponsor | Escalation and external commitments |

## Commands and console actions referenced

| Reference | State |
|---|---|
| Kill switches via `KillSwitchService.set` (`platform/src/ops`), roles per `KILL_SWITCH_ROLES` | Service, console API and console page exist (offline, LOCAL FIXTURE sign-in); workforce SSO BLOCKED (PRQ-036) |
| Admission control and budgets (`AdmissionController`, `BudgetService`, `platform/src/ops`) | Exists (offline) |
| Audit metadata search (`auditedSearch`, `platform/src/audit`) | Exists (offline); console Audit search page exists (offline) |
| Audit integrity and completeness (`IntegrityVerifier`, `assessCompleteness`, `AuditCompletenessMonitor`, `platform/src/audit`) | Exists (offline); runs as the worker loop `audit.verify` (OPS-AUD-01); live verifier role BLOCKED (PRQ-037, PRQ-040) |
| Deferred route audit (`DeferredAuditQueue`; worker loop `audit.deferred_flush`; in the gateway-only process `DeferredAuditFlushTimer` and the bounded shutdown sequence of `platform/src/main/server.ts`) | Exists (offline); process-local; alarms `audit-deferred-depth` and `audit-deferred-dropped` as plans only ([ADR-0011](../adr/ADR-0011-deferred-route-audit.md)) |
| `cd platform && npx tsx src/workflows/generate-asl.ts --check` | Exists |
| `node talkdesk/tools/drift-check.mjs`, `node talkdesk/tools/validate-package.mjs` | Exist (offline); live tenant comparison BLOCKED |
| `bash scripts/fetch-tools.sh` (pinned OPA and Terraform) | Exists |
| `pnpm policy:test`, `pnpm policy:build` (`scripts/policy.sh`) | Exist; `pnpm policy:test` passes offline (235 Rego tests in `evidence/test-reports/opa-vsp.json`) |
| `pnpm evidence` (`platform/src/evaluation/cli.ts`) | Exists (LOCAL FIXTURE evidence only) |
| Console actions: inspect journey, cancel uncommitted work, retry reconciled operation, DLQ repair, staff safety escalation | Exist (offline, `platform/src/console-api`, `console/`); legal hold has no console endpoint |
| Retention legal hold (`LegalHoldStorePg`, `platform/src/retention`) | Exists (offline); no console endpoint |

## Drill programme

Before broad release, every SEV-1 runbook, the AI-off route, restore and regional failover are
drilled in a non-production environment with synthetic data, and the drill record (date, roles,
environment, outcome, gaps, remediation owner) is written as a `SECURITY_AUDIT` evidence event.
Drill cadence is set by the SRE lead and security leadership (PRQ-011).
