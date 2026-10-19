# ADR-0011 Deferred route audit: handoff events during an audit outage are queued (bounded, process-local) and appended later in order; consequential actions stay fenced

| Field | Value |
|---|---|
| Status | **Accepted for engineering**. Queue bound: engineering default pending SRE review. Live audit sink: **BLOCKED** (PRQ-037, PRQ-040). Durable deferral store: not implemented |
| Date | 2026-10-18 |
| Decided by | Principal engineer (coding agent) for the engineering scope only |
| Approval needed from | SRE lead (queue bound, alarm on queue depth); security leadership (whether process-local deferral is acceptable for route evidence) |
| Related prerequisites | PRQ-011, PRQ-037, PRQ-040, PRQ-025 |

## Context

Spec section 13: "If the centralized sink fails, a local durable outbox may buffer within a
bounded policy. If durable evidence cannot be written at all, block consequential actions and
degrade to safe routing. Do not acknowledge a mutation and hope to log it later." Spec section
10 and SAFE-02/SAFE-03: the safety and human routes need no authentication and must never be
silently terminated. [ADR-0008](ADR-0008-audit-outbox-object-lock.md) already fences
consequential actions through `AuditHealth.assertCanAcceptConsequential` and the in-transaction
`append`, and keeps safety and human routes open.

That left a gap when the local audit outbox itself is unwritable: the handoff route proceeded,
but `HandoffService.auditHandoff` (`platform/src/business/handoff.ts`) could only log
`handoff.audit_unavailable`; the `handoff.*` audit event was lost. That branch still exists
when no deferral sink is composed.

## Decision

1. **Route evidence only.** A new port `DeferredAuditSink.appendOrDefer`
   (`platform/src/audit/ports.ts`), implemented by `DeferredAuditQueue`
   (`platform/src/audit/deferred.ts`), is passed to the business layer as
   `ToolDeps.deferredAudit` (`platform/src/main/container.ts`). Only `auditHandoff` uses it.
   Consequential mutations never do: they keep the in-transaction append and the health gate,
   so during an outage a commit is refused before any provider effect.
2. **Append now, else queue in order.** `appendOrDefer` validates the event (an invalid event
   is refused, never queued) and appends it with `appendStandalone`. If older entries are
   pending it first drains up to 16 of them inline and queues the new event behind any that
   remain, so deferral order is kept. A store failure queues the event in a bounded FIFO in
   process memory (engineering default 1000 entries, configurable 1..10000).
3. **Flush.** The worker loop `audit.deferred_flush` (`DeferredAuditFlushLoop`,
   `platform/src/worker/loops.ts`; default every 5 s, at most 100 events per run) appends queued
   events FIFO. It attempts nothing while `AuditHealth` reports `AUDIT_STORE_UNWRITABLE`, stops
   at the first store failure and keeps the rest; an event the writer refuses as invalid is
   dropped and logged at error level. The gateway-only entry point
   (`platform/src/main/server.ts`) runs no worker loops, so it drains its own queue with
   `DeferredAuditFlushTimer` (`platform/src/audit/deferred.ts`; same defaults, unref'd, runs never
   overlap). On a graceful stop it waits (bounded) for open responses, force-closes the rest,
   waits (bounded) for the route handlers still running, then runs one bounded final flush that
   also waits for appends in progress and seals the queue, and only then closes the database.
   What is still queued, still being appended, still running in a handler, or reaches the sealed
   queue later is logged at error level (`audit.deferred.unflushed_at_shutdown`,
   `server.shutdown_handlers_unsettled`, `audit.deferred.lost_at_shutdown`).
4. **Late events are visible as late.** Each flushed event keeps its original `occurredAt` and
   is followed by an `audit.deferred.recorded` marker (`parentId` = the late event,
   `reasonCode` = why it was deferred, data class `SECURITY_AUDIT`), so the chain itself shows
   which evidence was written late.
5. **Bounded and loud.** When the queue is full the NEW event is dropped, counted
   (`vsp_audit_deferred_total{result="dropped",reason="queue_full"}`) and logged
   (`audit.deferred.dropped`, error level). Queued events are logged `audit.deferred.queued`
   (error level). Metrics `vsp_audit_deferred_total`, `vsp_audit_deferred_depth`,
   `vsp_audit_deferred_age_ms`. Logs and metrics carry action codes, opaque ids, reason codes
   and counts only.
6. **Durable safety record meanwhile.** For a safety route, `SafetyEventRecorder`
   (`platform/src/safety/safety-events.ts`) still writes the `safety_events` row, with
   `audit_status = AUDIT_UNAVAILABLE`; that row is the durable incident record while the audit
   event waits in the queue.

Tests (offline, LOCAL FIXTURE adapters, SYNTHETIC data): `platform/src/audit/deferred.test.ts`
(PGlite: order across recovery, markers, intact chain, bound, invalid-event drop) and
`platform/src/worker/deferred-audit.test.ts` (full composition with the LOCAL FIXTURE outage
`revoke insert on audit_outbox from app_runtime`: the commit is refused with no provider effect,
the human and safety routes proceed, the flush attempts nothing while unwritable, and after
recovery both handoff events are appended in order, each followed by its marker). The audit
outage fault journey is in `platform/test/journeys/faults.test.ts`. Status: IMPLEMENTED_OFFLINE.

## Consequences

* **Crash-loss limit.** The queue is in process memory: a crash or restart while events are
  queued loses them. The error-level `audit.deferred.queued` log and the depth gauge are the
  signal that evidence is at risk; for a safety route the `safety_events` row remains. The
  queue is labelled `PROCESS-LOCAL DEFERRED ROUTE-AUDIT QUEUE` (`DEFERRED_AUDIT_BADGE`).
* **Process-local flush.** The flush must run in the process that holds the queue. The local
  composition (`platform/src/main/local.ts`) runs gateway and worker in one process and the
  worker loop drains it. The gateway-only entry point (`platform/src/main/server.ts`) drains its
  own queue with `DeferredAuditFlushTimer`, and its graceful stop runs the bounded sequence in
  Decision 3 (the three bounds together at most 25 s, within the ECS stop timeout of 30 s), so on
  a graceful stop, route evidence that reached the queue, or whose route handler was still
  running, is written or its possible loss is logged at error level before the process exits (per
  event for queued events; as a count for handlers or appends still running when a bound expired).
  Not covered: a `request_human_transfer` or `request_safety_route` execution that its tool
  timeout detached from the request (the caller got `TIMEOUT`; `withTimeout` does not cancel the
  module). If the process exits before that work reaches the queue, its route evidence is lost
  with no log; it is detected only from route-tool `TIMEOUT` results and `vsp_timeouts_total`
  shortly before a stop, cross-checked against transfer journeys and `safety_events`. The
  follow-on durable route journal replaces this process-local queue. The worker and local entry points run no final flush and do not
  seal on shutdown. Tests: `platform/src/audit/deferred-flush.test.ts` and
  `platform/src/main/server.test.ts` (real HTTP, LOCAL FIXTURE outage, force-closed requests).
* The `<prefix>-audit-deferred-depth` (high: Maximum above 0 for 5 minutes) and
  `<prefix>-audit-deferred-dropped` (critical) alarms exist in
  `infra/terraform/modules/observability` as Terraform plans only, and
  [`../RUNBOOKS/audit-sink-outage.md`](../RUNBOOKS/audit-sink-outage.md) covers the queue (what it
  is, the alarms, the crash-loss limit, the shutdown sequence, how to confirm the flush); the
  metrics export and paging are BLOCKED (PRQ-047, PRQ-011).
* Only the business handoff uses the queue. Gateway session and screening events
  (`GatewayAudit`) and `TransferCoordinator` transfer events written during an outage are still
  only logged; the coordinator counts them as `auditGaps` on the journey.
* Completeness reconciliation ([ADR-0008](ADR-0008-audit-outbox-object-lock.md)) sees late events
  with their original `occurredAt` plus a marker; reviewers must not read the marker as a second
  handoff.

## Alternatives considered

| Alternative | Why not adopted |
|---|---|
| Block the handoff until audit is writable | Spec section 10 and SAFE-03: the safety and human routes must stay available; audit loss never ends a safety flow |
| Log only (previous behaviour) | Route evidence disappears; nothing reconciles it later |
| Durable deferral table in the application database | The outage being handled is that database refusing audit writes; a separate durable store needs its own migration and an approved storage location |
| Use the same deferral for consequential mutations | Spec section 13 forbids acknowledging a mutation and logging it later (OPS-01) |
| Unbounded queue | Memory exhaustion during a long outage; the bound plus loud drops make the loss visible |

## Linked requirements

OPS-01, OPS-02, SAFE-02, SAFE-03, SPEC-13 (sink failure, bounded buffer), SPEC-16.fault-audit-outage.

## Revisit when

The live audit sink and audit account exist (PRQ-037, PRQ-040); route evidence must survive a
crash (add a durable deferral store); the worker and local entry points need the same final
flush and seal as the gateway; SRE sets the queue bound and the alarm thresholds (PRQ-011).
