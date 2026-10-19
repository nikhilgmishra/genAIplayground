# Decisions

Index of architecture decision records (ADRs) and smaller recorded decisions. An ADR marked
**Accepted for engineering** governs offline implementation only. Anything that depends on
policy, contracts, PHI, money or production exposure is **Pending human approval** until the
named owner approves it; the coding agent cannot approve on their behalf
([ADR-0010](adr/ADR-0010-signed-human-approvals.md)).

Status values: `Accepted for engineering`, `Proposed — Pending human approval`,
`Superseded by ADR-NNNN`, `Rejected`.

## Architecture decision records

| ADR | Title | Status | Depends on (prerequisites) | Linked requirements |
|---|---|---|---|---|
| [ADR-0001](adr/ADR-0001-default-architecture.md) | Default architecture adopted (Talkdesk + AWS control plane + Salesforce; modular TypeScript service; no LangGraph, Kafka or second workflow engine) | Accepted for engineering; production adoption pending human approval. Amended by [ADR-0018](adr/ADR-0018-followon-product-architecture.md): its speech-layer and agent-framework parts are superseded; no Kafka requirement, no second workflow engine, no separate vector database and no microservice per module still stand | PRQ-001, PRQ-002, PRQ-004 | AUTH-02, AUTH-03, OPS-02, OPS-06, DATA-01 |
| [ADR-0002](adr/ADR-0002-opa-wasm-in-process.md) | OPA policy evaluated in-process via WebAssembly, with a golden-probe expansion gate | Accepted for engineering; each bundle pending `POLICY_RELEASE` | PRQ-031 | AUTH-02, AUTH-05, OPS-04, OPS-06 |
| [ADR-0003](adr/ADR-0003-session-binding-tb01.md) | Session binding and the TB-01 decision rule (trusted header > server-to-server lookup > blocked; argument refs only by approved exception) | Accepted for engineering; binding mode UNKNOWN until TB-01 evidence | PRQ-013, PRQ-018 | AUTH-01..AUTH-04, AUTH-07 |
| [ADR-0004](adr/ADR-0004-pglite-aurora-dynamodb.md) | PGlite for offline tests, Aurora in deployment (same SQL, RLS); DynamoDB sessions with application-enforced expiry | Accepted for engineering | PRQ-037, PRQ-038 | AUTH-04, ACT-02, OPS-01 |
| [ADR-0005](adr/ADR-0005-trusted-confirmation-capture.md) | Confirmation captured by a trusted deterministic component (TB-02) | Accepted for engineering; autonomous commit BLOCKED until TB-02 | PRQ-014 | ACT-01, ACT-03, ACT-05, AUTH-03 |
| [ADR-0006](adr/ADR-0006-fallback-speech-runtime.md) | Fallback speech runtime (LiveKit on AWS) as a separately approved project, not a silent substitution | Superseded by ADR-0018 (was Proposed — Pending human approval, conditional on TB-04/TB-05 failing); its fail-closed rules remain for the Talkdesk-native adapter | PRQ-016, PRQ-017 | ACT-05, SAFE-03, DATA-01, OPS-05 |
| [ADR-0007](adr/ADR-0007-workflow-single-source.md) | Workflow definitions as single source for the local executor and Step Functions ASL | Accepted for engineering; deployment BLOCKED | PRQ-037, PRQ-009 | ACT-04, OPS-06 |
| [ADR-0008](adr/ADR-0008-audit-outbox-object-lock.md) | Audit: in-transaction durable outbox, S3 Object Lock in a separate audit account; hash chains are not completeness proof | Accepted for engineering; live sink BLOCKED | PRQ-037, PRQ-040 | OPS-01, OPS-03, DATA-01, AUTH-06 |
| [ADR-0009](adr/ADR-0009-identity-verification.md) | Identity: secure link with OIDC MFA preferred; OTP restricted; name + date of birth locate only | Accepted for engineering; parameters pending security approval; OTP BLOCKED until TB-03 | PRQ-005, PRQ-015, PRQ-029, PRQ-030 | AUTH-01, AUTH-03, AUTH-05, AUTH-06 |
| [ADR-0010](adr/ADR-0010-signed-human-approvals.md) | Approvals are signed human records; the coding agent cannot fabricate them; production guard | Accepted for engineering; signing key BLOCKED | PRQ-023, PRQ-024 | OPS-03, OPS-04, OPS-05 |
| [ADR-0011](adr/ADR-0011-deferred-route-audit.md) | Deferred route audit: handoff audit events during an audit outage are queued (bounded, process-local) and appended later in order; consequential actions stay fenced | Accepted for engineering; queue bound pending SRE review; live sink BLOCKED | PRQ-011, PRQ-037, PRQ-040 | OPS-01, OPS-02, SAFE-02, SAFE-03 |
| [ADR-0012](adr/ADR-0012-safety-routes-exempt-from-limits.md) | Safety and human-transfer routes are exempt from rate limiting and admission; per-call tool buckets; MCP batches counted per message | Accepted for engineering; limit values pending SRE capacity review and vendor quotas (TB-10) | PRQ-011, PRQ-022, PRQ-049 | SAFE-02, SAFE-03, OPS-02 |
| [ADR-0013](adr/ADR-0013-approval-subject-binding.md) | Approval records carry a signed machine-checkable subject and an approver-role table, checked by the runtime guard and the deploy gate | Accepted for engineering; signing key BLOCKED; every record pending human approval | PRQ-023, PRQ-024 | OPS-03, OPS-04, OPS-05, OPS-06 |
| [ADR-0014](adr/ADR-0014-uniform-verification-abuse-handling.md) | Uniform verification abuse handling: account-keyed abuse monitor, no account-derived session flags, OTP limits enforced at submission | Accepted for engineering; parameters pending security approval; OTP BLOCKED until TB-03 | PRQ-015, PRQ-029 | AUTH-01, AUTH-03, AUTH-06 |
| [ADR-0015](adr/ADR-0015-pre-disclosure-recheck.md) | Pre-disclosure recheck of current consent, representation, account state and policy inside guarded workflow transitions | Accepted for engineering; live consent and account-state registries BLOCKED; rule table pending the policy owner | PRQ-005, PRQ-026, PRQ-031, PRQ-033 | AUTH-02, AUTH-03, AUTH-05, DATA-03, OPS-06 |
| [ADR-0016](adr/ADR-0016-safety-supersedes-standard-transfers.md) | A safety route supersedes the standard transfer journeys of the same call (conditional write, bounded retry, standard steps yield); residual races recorded | Accepted for engineering; in-flight dial withdrawal and live transfer store BLOCKED (TB-07) | PRQ-004, PRQ-019 | SAFE-02, SAFE-03, SAFE-04, OPS-02 |
| [ADR-0017](adr/ADR-0017-out-of-order-transfer-events.md) | Out-of-order transfer events: an early progress event is held per attempt (bounded, idempotent) and applied only after its predecessor through the same transition; discarded when its attempt closes, is replaced or superseded; a truly lost predecessor still fails over | Accepted for engineering; live transfer events and a vendor transfer-state query BLOCKED (TB-07); post-call outcome revision left to the business owner (PRQ-033) | PRQ-004, PRQ-019, PRQ-021, PRQ-033 | SAFE-03, SAFE-04, ACT-02, OPS-01, OPS-02 |
| [ADR-0018](adr/ADR-0018-followon-product-architecture.md) | Follow-on product architecture: independent LiveKit reference runtime (mandatory, with a SIP reference route) and Talkdesk native as a qualified option, one conversation owner per call by fenced lease; bounded explicit harness state machine instead of LangGraph.js; Step Functions Standard as the single durable case owner; PostgreSQL/pgvector and DynamoDB roles; Bedrock, OpenAI and vLLM adapters behind a ModelRegistry; Docker composition (`deploy/local/compose.yaml` plus per-package fragments) as the Layer-2 environment; import allowlist for the harness, models and `media/`; two status axes. Supersedes the ADR-0006 decision; amends ADR-0001 (speech layer, agent framework); open items (unverified GPT-Live and Nova 2.5 Sonic details, LiveKit facts to verify, VQ-TD-42, DTMF isolation) listed under its consequences | Accepted for engineering (software scope); PHI, live carriers, paid model and speech endpoints and production use pending human approval; vendor, BAA, carrier and GPU inputs go to the activation register | PRQ-001, PRQ-002, PRQ-003, PRQ-010, PRQ-016, PRQ-017, PRQ-037, PRQ-038, PRQ-039, PRQ-045, PRQ-049 | ACT-02, ACT-05, AUTH-03, AUTH-06, DATA-01, DATA-02, SAFE-03, SAFE-04, OPS-02, OPS-03, OPS-04, OPS-05, OPS-06 |

## Smaller recorded decisions (documentation pack)

| ID | Decision | Rationale |
|---|---|---|
| D-01 | The prerequisite register is machine-readable YAML ([`prerequisites.yaml`](prerequisites.yaml)) validated against the protocol `PrerequisiteRecord` schema, with a generated human view ([`PREREQUISITES.md`](PREREQUISITES.md), rendered by `node docs/tools/render-prerequisites.mjs`) | One source of truth; a test fails if the two drift or if any record claims approval without evidence |
| D-02 | Every external prerequisite starts `UNKNOWN` or `BLOCKED`; nothing is marked approved by engineering | Spec section 5; OPS-03 |
| D-03 | Capacity and cost figures are reproduced by a script ([`../scripts/capacity_model.py`](../scripts/capacity_model.py)) and labelled illustrative | Spec section 12: planning assumptions, not measurements or quotes |
| D-04 | No retention duration is written anywhere in the documentation pack; every cell reads "TO BE SET BY PRIVACY COUNSEL" | Spec section 6: do not invent a universal retention duration |
| D-05 | Runbook identifiers match the alarm descriptions in `infra/terraform/modules/observability` (RB-*), with aliases where an alarm names a narrower runbook | Alert text must lead to a runbook without free-text lookups |
| D-06 | Threat-model status uses `IMPLEMENTED_OFFLINE`, `IN_PROGRESS`, `BLOCKED` and `UNKNOWN`; `IN_PROGRESS` and `UNKNOWN` are never treated as mitigated. Applies to the legacy T-NN rows; follow-on rows follow D-09 | OPS-03; module work was still in progress when the threat model was written |
| D-07 | The vendor integration inventory document is a human summary; the machine-readable inventory is the adapters module's `platform/src/adapters/integration-inventory.ts` | Avoid two authoritative sources |
| D-08 | Every runbook starts with "Last drilled: NEVER (not yet run)" until a drill record exists | Do not manufacture evidence (spec "Progress and handoff") |
| D-09 | Follow-on threat rows (FT-NN, `security/threat-model.md` section 8) and follow-on data-flow rows (DF-27 onwards) state the two status axes of ADR-0018 decision 7 (software, environment, qualification) and name the work package that builds each mitigation; the legacy rows keep the D-06 vocabulary until the docs-pack test and those rows are migrated together | The single-axis `BLOCKED` would present missing code as a missing external input (follow-on prompt section 0) |

## Related

* [`ARCHITECTURE.md`](ARCHITECTURE.md) — layout, conventions and trust-boundary flags TB-01..TB-10.
* [`PREREQUISITES.md`](PREREQUISITES.md) — what each decision is waiting on.
* [`IMPLEMENTATION_STATUS.md`](IMPLEMENTATION_STATUS.md) — what is implemented and how it is verified.
