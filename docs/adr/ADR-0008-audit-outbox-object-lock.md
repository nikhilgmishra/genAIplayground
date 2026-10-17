# ADR-0008 Audit evidence: in-transaction durable outbox shipped to S3 Object Lock in a separate audit account; hash chains are not completeness proof

| Field | Value |
|---|---|
| Status | **Accepted for engineering**. Live sink: **BLOCKED** (PRQ-037, PRQ-040) |
| Date | 2026-10-17 |
| Decided by | Principal engineer (coding agent) for the engineering scope only |
| Approval needed from | Security leadership and privacy counsel (Object Lock mode, audit retention class) |
| Related prerequisites | PRQ-037, PRQ-040, PRQ-025 |

## Context

OPS-01: every accepted consequential action has durable independent audit evidence. Spec
section 13: store audit events append-only in an independently administered account with
restricted deletion, tamper-evident manifests, integrity checks, monitored ingestion gaps and
approved retention; signing or hashing alone does not establish completeness; if durable
evidence cannot be written, block consequential actions and degrade to safe routing; do not
acknowledge a mutation and hope to log it later.

## Decision

1. `AuditWriter.append` (`platform/src/audit/ports.ts`) writes the audit event into a local
   durable audit outbox **inside the same database transaction** as the consequential change.
   If the write fails, the transaction rolls back and the mutation is not acknowledged.
2. Each writer stream has a per-stream sequence and hash chain; database triggers enforce
   append-only links. A shipper moves verified batches to the independent sink with
   tamper-evident manifests; the live sink is S3 with Object Lock and KMS in a separately
   administered audit account (the offline sink is a labelled local-filesystem fixture).
3. **Completeness is established by reconciliation, not by hashing**: source event counts and
   critical-action ledger keys are reconciled against shipped events; ingestion gaps are
   detected and alerted; a completeness assessment is PASS only when integrity, ingestion
   monitoring and reconciliation all ran clean; otherwise FAIL or INCONCLUSIVE.
4. `AuditHealth.assertCanAcceptConsequential` gates consequential actions using a bounded
   buffering policy (backlog size and age). When exceeded, consequential actions are blocked;
   safety and human routes are not blocked
   ([`../RUNBOOKS/audit-sink-outage.md`](../RUNBOOKS/audit-sink-outage.md)).
5. Audit content is security metadata only; sensitive content stays in separately
   access-controlled stores referenced by evidence pointers. Audit-view roles cannot write or
   rewrite evidence.

## Consequences

* A database superuser can still disable triggers locally; the chain heads, manifests and the
  independent sink exist to detect that. Detection is not prevention; access to the owner role
  is an insider-threat control (see threat T-16 in [`../security/threat-model.md`](../security/threat-model.md)).
* Object Lock compliance mode cannot be shortened or removed; the mode per environment must be
  chosen before the sandbox apply (VQ-AWS-09).
* Retention per audit class is not set here (PRQ-025).

## Alternatives considered

| Alternative | Why not adopted |
|---|---|
| Write audit to the sink after commit ("log later") | Spec prohibits acknowledging a mutation and hoping to log it later |
| CloudWatch Logs as the audit store | Not independently administered; mixes with operational logs |
| Hash chain or signatures as the only integrity control | Spec: signing or hashing alone does not establish completeness |
| Synchronous write to S3 in the request path | Couples every action to a cross-account network call; the bounded outbox achieves durability with an explicit buffer policy |

## Linked requirements

OPS-01, OPS-03, DATA-01, AUTH-06, SPEC-13 (audit event model, independent store, sink failure).

## Revisit when

The audit account and Object Lock mode are approved (PRQ-037, PRQ-040), or measured backlog
behaviour under load requires different buffering bounds.
