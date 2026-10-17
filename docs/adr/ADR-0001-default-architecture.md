# ADR-0001 Default architecture adopted

| Field | Value |
|---|---|
| Status | **Accepted for engineering** (offline implementation). Use with PHI, live vendors or production: **Pending human approval** (PRQ-001, PRQ-002, PRQ-004) |
| Date | 2026-10-17 |
| Decided by | Principal engineer (coding agent) for the engineering scope only |
| Approval needed from | Executive sponsor (scope), privacy counsel (processor coverage), security leadership (architecture review) |
| Related prerequisites | PRQ-001, PRQ-002, PRQ-004, PRQ-006, PRQ-013..PRQ-022, PRQ-037 |

## Context

The specification (section 3) prefers a stack: Talkdesk for numbers, routing, queues, agent
workspaces and human transfers; Talkdesk Autopilot Agentic / AI Agent Platform as the
conversational layer, conditional on proof of the vendor capability gate; an AWS control plane
for identity, authorization, business actions, durable follow-up and independently retained
audit evidence; Salesforce Service Cloud as the support system of record.

The repository began as an empty project (README and LICENSE only; see
[`../INVENTORY.md`](../INVENTORY.md)). There was no existing production workflow engine,
database, message bus or service to preserve, so no repository constraint justified an
alternative. Spec section 3 also says not to add LangGraph, a second workflow engine, Kafka, a
separate vector database or a custom speech layer by default.

## Decision

Adopt the default architecture, documented in [`../ARCHITECTURE.md`](../ARCHITECTURE.md):

1. **Talkdesk** keeps telephony, Studio routing, queues and human legs, including an
   independent Studio route to humans that needs no model response, gateway request or
   policy decision. The AI Agent Platform is treated as an **untrusted conversational layer**
   with a service identity, never as an identity or authorization system.
2. **One modular TypeScript service** (`platform/`, Node 22 LTS, Fastify, intended for ECS
   Fargate) with module boundaries expressed as `ports.ts` interfaces: gateway + MCP adapter,
   identity binding, policy evaluation, actions ledger + outbox, audit, workflows, knowledge,
   memory, retention, business services, vendor adapters, console API, evaluation. A worker
   process uses the same code for asynchronous work. Responsibilities are separated by
   module and process role, not by many microservices.
3. **AWS services**: DynamoDB (session state, conditional writes), Aurora PostgreSQL (ledger,
   outbox, support records, knowledge with pgvector where justified), SQS with dead-letter
   queues (asynchronous delivery), Step Functions Standard (durable follow-up), S3 + KMS in a
   separately administered audit account (Object Lock), Secrets Manager, CloudWatch via
   OpenTelemetry. Infrastructure as Terraform (`infra/terraform`, plan only).
4. **Salesforce Service Cloud** remains the system of record for Cases through a dedicated
   integration identity, upsert by external ID and gateway-side authorization in addition to
   Salesforce sharing.
5. **React + TypeScript console** (`console/`) behind workforce SSO.

Not added: LangGraph or any agent-orchestration framework, Kafka, a second workflow engine,
a separate vector database, a custom speech layer.

* **No LangGraph / agent framework**: the conversation runs in Talkdesk; the backend exposes
  narrow deterministic tools. A second orchestration layer would add an unaudited control
  path that could choose tools or targets outside the gateway pipeline.
* **No Kafka**: SQS with DLQs gives at-least-once delivery with idempotent consumers, which is
  what the outbox needs. EventBridge only if a justified fan-out appears.
* **No second workflow engine**: Step Functions Standard is the only durable engine in deployed
  environments; the local executor runs the same definitions for tests ([ADR-0007](ADR-0007-workflow-single-source.md)).
* **No separate vector database**: PostgreSQL full text plus pgvector over the approved
  knowledge corpus only; never an embedding index of customer transcripts.
* **No custom speech layer by default**: see [ADR-0006](ADR-0006-fallback-speech-runtime.md).

## Consequences

* The platform depends on the vendor capability gate TB-01..TB-10 (`docs/ARCHITECTURE.md`
  section 5). Each unresolved capability has a documented fail-closed consequence and a
  prerequisite record (PRQ-013..PRQ-022).
* One write region at first simplifies consistency; regional recovery is a fenced failover
  ([`../RUNBOOKS/regional-failover.md`](../RUNBOOKS/regional-failover.md)).
* A whole-Talkdesk outage is not solved by AWS failover; a separate continuity arrangement is
  required (PRQ-049).
* Product names in the stack are design choices, not claims that any product is purchased,
  enabled or covered by a BAA. The AWS component list must be reconciled with the current
  HIPAA eligible-services reference and the signed BAA before PHI use (PRQ-038).
* A modular monolith concentrates blast radius; mitigated by per-dependency bulkheads, circuit
  breakers, kill switches and least-privilege database roles with row-level security.

## Alternatives considered

| Alternative | Why not adopted (now) |
|---|---|
| Microservice per module | Operational and security overhead without a scaling or ownership need at this stage; spec prefers a modular service |
| LangGraph or similar backend agent orchestration | Duplicates the conversational layer; adds an unaudited decision path; spec says not by default |
| Kafka event backbone | Not needed for outbox delivery at this volume; extra platform to secure and operate |
| Temporal or another durable engine beside Step Functions | Two engines for the same case without an ownership boundary is prohibited by spec section 3 |
| Separate vector database | pgvector in Aurora is sufficient for the approved corpus; fewer PHI stores |
| Direct speech runtime (LiveKit, ElevenLabs, Nova Sonic) from day one | Requires new vendor, contract and BAA review; only if native controls fail ([ADR-0006](ADR-0006-fallback-speech-runtime.md)) |

## Linked requirements

AUTH-02, AUTH-03, OPS-02, OPS-06, DATA-01, SPEC-3 (preferred stack, trust boundaries,
deployment), SPEC-16 (module organisation).

## Revisit when

Vendor capability gate results arrive (PRQ-013..PRQ-022), measured traffic replaces the
illustrative capacity model (PRQ-046), or an approved production workflow engine is found in
an adopted repository.
