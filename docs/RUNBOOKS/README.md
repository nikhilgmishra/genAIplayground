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
| `tool-latency-p95` | RB-TOOL-LATENCY | [dependency-outage.md](dependency-outage.md) |
| `ingress-5xx-rate`, `gateway-no-healthy-targets` | RB-DEPENDENCY-OUTAGE | [dependency-outage.md](dependency-outage.md) |
| `budget-burn` | RB-UNEXPECTED-SPEND | [unexpected-spending.md](unexpected-spending.md) |
| `admission-rejections` | RB-ADMISSION | [ai-off-route.md](ai-off-route.md) |

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
| Kill switches via `KillSwitchService.set` (`platform/src/ops`), roles per `KILL_SWITCH_ROLES` | Service exists (offline); console UI PLANNED |
| Admission control and budgets (`AdmissionController`, `BudgetService`, `platform/src/ops`) | Exists (offline) |
| Audit metadata search (`auditedSearch`, `platform/src/audit`) | Exists (offline); console UI PLANNED |
| Audit integrity and completeness (`IntegrityVerifier`, `assessCompleteness`, `platform/src/audit`) | Exists (offline); scheduled job PLANNED |
| `cd platform && npx tsx src/workflows/generate-asl.ts --check` | Exists |
| `node talkdesk/tools/drift-check.mjs`, `node talkdesk/tools/validate-package.mjs` | Exist (offline); live tenant comparison BLOCKED |
| `bash scripts/fetch-tools.sh` (pinned OPA and Terraform) | Exists |
| `pnpm policy:test`, `pnpm policy:build` (`scripts/policy.sh`) | PLANNED (script not yet present) |
| `pnpm evidence` (`platform/src/evaluation/cli.ts`) | PLANNED |
| Console actions: inspect journey, cancel uncommitted work, retry reconciled operation, DLQ repair, legal hold | PLANNED (`platform/src/console-api`, `console/`) |
| Retention legal hold (`platform/src/retention`) | PLANNED |

## Drill programme

Before broad release, every SEV-1 runbook, the AI-off route, restore and regional failover are
drilled in a non-production environment with synthetic data, and the drill record (date, roles,
environment, outcome, gaps, remediation owner) is written as a `SECURITY_AUDIT` evidence event.
Drill cadence is set by the SRE lead and security leadership (PRQ-011).
