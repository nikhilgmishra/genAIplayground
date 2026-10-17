# ADR-0007 Workflow definitions are the single source for the local executor and Step Functions ASL

| Field | Value |
|---|---|
| Status | **Accepted for engineering**. Deployment of state machines: **BLOCKED** (PRQ-037) |
| Date | 2026-10-17 |
| Decided by | Principal engineer (coding agent) |
| Approval needed from | Support operations for deadlines and retry budgets (proposed engineering defaults) |
| Related prerequisites | PRQ-037, PRQ-009, PRQ-033 |

## Context

Durable follow-up (billing disputes, provider document review, claim investigation, partner
onboarding, callbacks, complaint review, support-request synchronisation) must survive hang-up,
outages, approvals and days of waiting (spec sections 3 and 9). Step Functions Standard is the
selected engine. Tests must run offline, and spec section 3 prohibits two workflow engines for
the same case without a concrete reason and ownership boundary.

## Decision

1. Versioned TypeScript workflow definitions in `platform/src/workflows/definitions` are the
   single source of truth. Every nonterminal state has an owner queue, deadline, retry budget
   and escalation route; a validator rejects definitions that violate this.
2. The ASL generator (`platform/src/workflows/asl.ts`, CLI `generate-asl.ts`) emits
   `infra/stepfunctions/*.asl.json` plus a digest manifest; `--check` fails CI on drift, and
   the documents are validated with `asl-validator`.
3. The local durable executor (`PgWorkflowEngine`) implements the same definitions against
   PostgreSQL for tests and the local demo. **In deployed environments Step Functions Standard
   is the only durable engine**; the local executor is not deployed as a second engine.
4. Execution names are opaque workflow ids; PHI and task tokens stay out of names and general
   logs; logging excludes execution data.

## Consequences

* Behaviour tested offline matches the generated ASL structurally; actual Step Functions
  semantics (retries, task tokens, history limits, quotas) are verified only in the sandbox.
* Deadlines and retry budgets are proposed engineering defaults, not service-level commitments.
* In-flight workflows keep their definition version; new versions are immutable once registered.

## Alternatives considered

| Alternative | Why not adopted |
|---|---|
| Hand-written ASL plus separate test doubles | Two sources that drift |
| Local executor in production as well | Two engines for the same case (spec section 3) |
| Step Functions Local / emulators | Not available offline here; would still not prove AWS behaviour |

## Linked requirements

ACT-04, OPS-06, SPEC-3 (Step Functions Standard), SPEC-9 (durable follow-up), SPEC-15 phase 5
(in-flight version compatibility).

## Revisit when

A sandbox AWS account exists (PRQ-037) and generated state machines have been deployed and
exercised.
