# RB-REGIONAL-FAILOVER Regional failover

| Field | Value |
|---|---|
| Runbook id | RB-REGIONAL-FAILOVER |
| Severity | SEV-1 |
| Primary owner role | Incident commander (SRE lead executes) |
| Last drilled | NEVER (not yet run) |
| Status | Draft. Secondary region, replication and DR stack are plans only (`infra/terraform/envs/production-dr`); regions UNKNOWN (PRQ-039) |

## Trigger and detection signals

* Regional AWS impairment: `<prefix>-gateway-no-healthy-targets`, Aurora/DynamoDB errors across availability zones, AWS Health events.
* Within the primary region, an availability-zone failure is handled by multi-AZ deployment; acknowledged actions must survive it without failover.

## Immediate containment

1. Safe telephone routing is independent of application recovery: confirm Studio's human route carries callers.
2. **Fence writes during uncertainty**: engage `WRITES` ([kill-switch-operations.md](kill-switch-operations.md)) and stop the worker and outbox dispatchers in the primary region if reachable. One write region at a time; never two writers.

## Evidence preservation

Privacy counsel determines any reporting obligations and deadlines; the software preserves evidence and supports the process.

* Record the fence time, last known replicated position, and every external side effect in flight (UNKNOWN commits, outbox messages not yet delivered, workflow executions).

## Step-by-step actions

1. Incident commander decides to fail over (documented decision).
2. Promote the secondary-region data stores (Aurora secondary cluster; DynamoDB replica if used). Asynchronous replication can lose data; **do not imply zero data loss**.
3. Start the gateway and worker in the secondary region with the same release manifest; configuration guard must pass.
4. **Reconcile external side effects before reopening mutations**: for every action that was in flight or committed after the last replicated position, query providers by idempotency key or external id ([reconciliation-and-dlq-repair.md](reconciliation-and-dlq-repair.md)). Re-deliver outbox messages; consumers deduplicate.
5. Point Talkdesk MCP and Studio HTTP endpoints at the secondary region (Talkdesk administrator; mechanism depends on DNS and vendor configuration).
6. Release `WRITES` only after reconciliation completes; release AI admission gradually.
7. Failback is a separate, planned operation with the same fence-and-reconcile steps.

## Verification

* Reconciliation complete with every in-flight action resolved; no duplicate effects; audit chain continuity verified in the new region; measured recovery time and data-loss window recorded against the proposed objectives (PRQ-039).

## Communication roles

Incident commander; SRE lead and on-call; Talkdesk administrator; Salesforce administrator; business-system owners; support operations lead; communications lead; executive sponsor.

## Drill requirement

Failover drill in a non-production environment before broad release (spec section 12), including fence, promote, reconcile and failback; record measured times.
