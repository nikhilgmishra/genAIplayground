# ADR-0018 Follow-on product architecture: independent LiveKit reference runtime, bounded explicit harness, one durable case owner, real model adapters and two status axes

| Field | Value |
|---|---|
| Status | **Accepted for engineering** (software scope of the follow-on programme). Use with PHI, live carriers, paid model or speech endpoints, or production: **Pending human approval** (PRQ-001, PRQ-002, PRQ-037, PRQ-038 and the new activation entries listed under Consequences) |
| Date | 2026-10-19 |
| Decided by | Principal engineer (coding agent), engineering scope only. The direction comes from the follow-on prompt (sections 0, 3, 9, 10, 12, 16 and 22), which supersedes the earlier deferral of a custom speech runtime and a bounded agent harness |
| Approval needed from | Executive sponsor (scope and funding); security leadership (architecture and media-network review); privacy counsel and procurement (model, speech and carrier processors, with BAA and retention terms per endpoint); telephony owner (SIP carrier and Talkdesk routing changes); clinical safety lead (response-class routing table and fallback clips); finance (media hosts, GPU, model spend) |
| Related prerequisites | PRQ-001, PRQ-002, PRQ-003, PRQ-010, PRQ-016, PRQ-017, PRQ-037, PRQ-038, PRQ-039, PRQ-045, PRQ-049 |
| Supersedes or amends | Supersedes the decision in [ADR-0006](ADR-0006-fallback-speech-runtime.md), which built no speech runtime unless TB-04 or TB-05 failed; its status line now reads "Superseded by ADR-0018". Amends [ADR-0001](ADR-0001-default-architecture.md) on the custom speech layer and the agent framework; its status line carries the amendment note. Extends [ADR-0004](ADR-0004-pglite-aurora-dynamodb.md) and [ADR-0007](ADR-0007-workflow-single-source.md) |
| Work packages | The decisions below are built by the work packages in `docs/followon/work-packages.yaml` (generated from `docs/followon/source/packages.yaml`); each decision names its packages. The module and path layout is in `docs/ARCHITECTURE.md` sections 6.4 and 6.8 |

## Context

The follow-on prompt (`docs/spec/voice-support-followon-specification.txt`) changes the product
direction:

* Section 22 says to build the independent, controllable LiveKit reference runtime as mandatory
  software and to keep Talkdesk native as a qualified option. "Do not add LangGraph/custom speech by
  default" becomes a bounded graph option with a single durable case owner and a mandatory controlled
  media runtime. The offline slice becomes a regression environment; it is no longer the delivery
  endpoint.
* Section 3 asks for one conversational owner, one durable case owner and one controlled action
  executor. It allows "a bounded conversation/investigation graph, using LangGraph.js when it materially
  simplifies typed state and routing. Otherwise implement a small explicit state machine behind the same
  contract. Do not run two agent frameworks unnecessarily." Step Functions Standard stays the durable
  orchestrator, and graph checkpoints are not a second owner. The section assigns roles to
  Aurora/PostgreSQL with pgvector and to DynamoDB, and asks for two voice modes plus an explicit
  topology for media, SIP, RTP and TURN.
* Section 9 asks for real Bedrock, OpenAI and vLLM adapters behind a ModelRegistry that keep
  provider-specific semantics, with at least one complete real model path configurable now. Every
  mandatory feature must remain buildable with emulators.
* Sections 16 and 17 ask for a reproducible local container composition, and a Layer 2 that runs the
  production adapters over real protocols against local emulators.
* Section 0 asks for two independent status axes per capability.

The repository as of commit `8c0f5a0`:

* Every non-local composition is refused (`platform/src/main/container.ts:308-313`,
  `LIVE_COMPOSITION_NOT_IMPLEMENTED`). Every live business and Talkdesk slot is a refusing stub
  (`platform/src/adapters/live/blocked-set.ts`).
* No media runtime exists: there is no LiveKit, codec, VAD, ASR or TTS code. The speech queue and the
  turn tracker are in-process LOCAL FIXTURES (`platform/src/voice/speech-queue.ts`,
  `platform/src/voice/turns.ts`). ADR-0006 chose not to build a runtime.
* No model of any kind exists. The only conversational driver is a keyword-based LOCAL SIMULATED
  COORDINATOR (`platform/src/evaluation/driver/labels.ts:10`).
* Durable work runs on the local executor `PgWorkflowEngine` (`platform/src/workflows/engine.ts:367`).
  The ASL is generated (`infra/stepfunctions/`), but no Step Functions bridge exists
  (`platform/src/workflows/README.md:329`), and `@aws-sdk/client-sfn` has no runtime caller
  (`platform/src/adapters/integration-inventory.ts:706`).
* All database evidence comes from single-connection PGlite (ADR-0004). `PgPoolDb`
  (`platform/src/db/pg.ts`), `DynamoKvStore`, `SqsPublisher` and the S3 Object Lock sink have never run
  against a real service or an emulator.
* The deterministic control logic is the strongest part of the code: zod-strict contracts, the gateway
  pipeline, the action ledger, and pure transition functions with fast-check property tests
  (`transferTransition` in `platform/src/workflows/transfer.ts:166`,
  `platform/src/safety/conversation-guard.property.test.ts`, `platform/src/workflows/validator.ts`).
* Status uses a single axis (`ReleaseStatus` in `platform/src/protocol/release.ts:115`:
  `IMPLEMENTED_OFFLINE`, ..., `BLOCKED`). That axis presents missing code as missing tenant input.
* Environment (`docs/followon/CONTINUATION.md`): Docker can be started; npm, PyPI, the Go proxy and
  Hugging Face are reachable; github.com release downloads are blocked; 4 CPUs and no GPU.

## Decision

### 1. Conversation runtime: the LiveKit reference runtime is mandatory; Talkdesk native is a qualified option

1. Build `media/`, a pnpm workspace package. It runs a LiveKit Agents worker on the supported Node SDK
   against self-hosted `livekit-server` and `livekit-sip`, and owns the responsive loop: room and
   participant lifecycle, codecs, VAD and endpointing, streaming ASR, turn tracking with
   session-generation fencing, barge-in, the speech queue, the speaker arbiter, the audio release
   guard, fallback clips and latency stamps. A Python worker is added only when a required supported
   plugin does not exist for Node at the pinned version, and only for that function (prompt section 3).
   Work packages: WP-11 (worker core, codecs, lifecycle, CallBinding issuance and recovery), WP-12 (SIP
   route and DTMF isolation), WP-13 (ASR, VAD, TTS), WP-14 (audio release boundary and call-owner lease),
   WP-15 (fallback clips and safety runtime), WP-16 (Mode B), WP-17 (Phase C integration and the audio
   journey).
2. A documented SIP reference route (carrier trunk to LiveKit SIP) lets the product run without a
   proprietary AI entitlement. Where Talkdesk is configured, it keeps numbers, routing, queues, the human
   workspace and continuity routes. Talkdesk reaches the runtime only through a documented SIP or media
   interface (VQ-TD-42, UNKNOWN). No Talkdesk media or transfer API is invented.
3. The Talkdesk AI Agent Platform over MCP (`platform/src/gateway/mcp.ts`) stays an optional conversation
   adapter. It must pass the same invariant suite (FO-02-31). The TB-01..TB-10 gates in
   `docs/ARCHITECTURE.md` section 5 keep governing it.
4. Exactly one conversation adapter owns a call. Before the first turn, the owner acquires a
   `CallOwnerLease`: a DynamoDB conditional record holding tenant, interaction, owner adapter, owner
   instance, a monotonic fencing token, the session generation and the lease expiry. The owner renews it by
   heartbeat. Takeover happens only after expiry or through a fenced hand-over. The gateway refuses any tool
   call or speech request whose fencing token is not current, and the runtime checks the token again
   before each emission. The lease lives in `platform/src/calls/lease` and the release guard in
   `media/src/egress`, both owned by WP-14. The `CallBinding` contract is
   `platform/src/protocol/call-binding.ts` (created by WP-02, owned by WP-11 from phase C), and its store
   and issuance are `platform/src/calls/binding`, with the worker side in `media/src/binding` (WP-11).
5. Both voice modes are built. Mode A, the controlled cascade, is the default route for protected facts,
   confirmations, disclosures, safety and error responses. Mode B, native full-duplex (GPT-Live client
   delegation, Nova 2.5 Sonic), speaks only the response classes that the runtime routing table marks
   `NATIVE_ALLOWED` after qualification, and its context scope holds no protected facts. The runtime
   decides which audio may reach the caller. No frame leaves unless it belongs to a gateway-issued,
   digest-bound `SpeechPlan` that the release guard accepted, or to a fallback clip listed in the signed
   clip manifest. Details are in `docs/ARCHITECTURE.md` section 6.2.
6. The runtime is a gateway client, not a second trust boundary for business state. It calls the gateway
   over HTTP with its own integration identity (a new `conversation_runtime` channel in
   `platform/src/protocol/auth.ts`, added by WP-02) and the trusted `CallBinding`, through the generated
   gateway client in `platform/src/gateway-client` (WP-07). The harness, the prompts, the model adapters and
   the `media/` package may import only an allowlist of modules (`docs/ARCHITECTURE.md` section 6.4, rule
   1). WP-06 enforces it: `platform/architecture/modules.yaml` declares every module and its allowed
   imports, and ESLint import-allowlist rules plus a dependency-cruiser test (`platform/test/architecture`)
   check it.

### 2. Harness: a bounded explicit state machine, not LangGraph.js

Decision: the conversation and investigation harness in `platform/src/harness` (with prompt assembly in
`platform/src/prompts`, both WP-10) is a small explicit state machine behind a `Harness` contract.
LangGraph.js is not added now.

Shape:

* State is a zod-strict `HarnessState` (FO-09-37, FO-09-38). It holds the verified goal, candidate
  intents, context refs with watermarks, pending questions, proposed reads and actions, receipts,
  speech-plan refs, task progress, budgets (iterations, parallelism, wall-clock deadline, tokens, cost),
  the session generation, the turn id and the voice mode.
* A pure function, `step(state, event) -> { state, effects }`, defines all behaviour. Events are runtime
  inputs: final transcript, DTMF, tool result, model result, timer, interruption, context update and
  safety signal. Effects are typed requests: call a model role, propose a tool to the gateway, run
  specialists, request a `SpeechPlan`, hand off, end the turn. A runner interprets the effects. It
  propagates deadlines (`AbortSignal`), applies the circuit breakers and bulkheads from
  `platform/src/resilience`, and enforces the budgets.
* Specialists run as bounded parallel effects and return only `{evidenceRefs, proposals}`. Only the
  owner step turns a proposal into a gateway request. A specialist therefore cannot speak, reassign the
  case or commit (FO-03-04, FO-09-39).
* The safety phase is sticky and pre-empts every other phase. Refusal counts, silence, cost limits and
  maximum turns never end it (SAFE-03).
* Harness state lives only for the call. Minimized turn envelopes are persisted for evidence and
  recovery. There is no graph checkpoint store (decision 3).
* Layer-3 text evaluation (`platform/src/evaluation`) runs the same harness without media. The LOCAL
  SIMULATED COORDINATOR stays as a deterministic baseline.

Why not LangGraph.js? Prompt section 3 calls for it only where it materially simplifies typed state and
routing:

1. **It does not materially simplify.** The repository already expresses typed state and routing as
   zod-strict state plus pure transition functions with fast-check property tests (the transfer state
   machine, the conversation guard, the workflow validator). The harness has about ten phases. LangGraph
   state annotations and reducers would duplicate zod.
2. **It would be a second agent framework.** LiveKit Agents is mandatory (decision 1) and is itself an
   agent framework, with sessions, turn handling, and model and tool nodes. Adding LangGraph would run a
   second framework without need, which section 3 rules out. LiveKit's own tool calling is not used for
   business operations: tools reach the gateway through the harness.
3. **Its checkpoints would compete with the case owner.** LangGraph's main added value (checkpointers,
   interrupts, durable resumption) overlaps with Step Functions. Section 3 says graph checkpoints are not a
   second owner, so that feature would be disabled, leaving only a graph runner.
4. **Determinism and replay.** A pure step function gives exact Layer-1 property tests, deterministic
   scorer replay and exact budget accounting. A framework runtime adds retry and superstep semantics that
   would also need qualification, and framework retries never imply exactly-once effects.
5. **Dependencies and data paths.** LangGraph.js brings `@langchain/core` and its transitive tree into a
   repository that adds a dependency only with an inventory record (`docs/ARCHITECTURE.md` section 3,
   convention 11). Its model abstractions would go unused, because the adapters keep provider-specific
   semantics (decision 5). Its hosted tracing would be one more data egress (DATA-01). Tracing uses
   OpenTelemetry spans instead.

The cost of this choice: the runner, fan-out and budget code are written and tested in this repository
(an estimated few hundred lines), and there is no graph studio. OpenTelemetry spans and the console
investigation view take that role.

### 3. Step Functions Standard is the single durable case owner

1. In deployed environments, a Step Functions Standard execution owns workflow progression: waits,
   timers, task tokens, retries and escalation timeouts. The definitions remain the single source
   (ADR-0007).
2. The Step Functions bridge (NEW, in `platform/src/workflows`, WP-26) is an SQS consumer for the
   task-token queues. It applies
   each event through the definitions' event rules (permitted actor kinds, pre-disclosure recheck). In
   one transaction it writes the Postgres workflow record, the audit outbox and the outbox. Then it calls
   `SendTaskSuccess`, `SendTaskFailure` or `SendTaskHeartbeat`. Task tokens are encrypted at rest and
   never appear in links, logs or execution names. Executions start idempotently by opaque workflow id.
   The bridge is tested on Step Functions Local plus ElasticMQ (WP-26 acceptance).
3. The Postgres workflow tables are the durable case record, not a second engine. Outside local/ci the
   local executor's scheduler and sweeps are off, and the configuration guard refuses any configuration
   that enables both. `PgWorkflowEngine` remains the local/ci executor of the same definitions.
4. Step Functions history limits never truncate the case record. A long case writes a checkpoint and
   continues in a successor execution that keeps the same workflow lineage (FO-12-24).
5. The harness and the media runtime never start, advance or complete a workflow. They propose a tool, a
   business service starts the case, and only authenticated staff complete human tasks (FO-12-12).
6. Effects happen once because of the action executor, not because of framework retries. Every external
   effect goes through the action executor, with a stable idempotency key, a ledger row and reconciliation
   of UNKNOWN outcomes (ACT-02, ACT-03).

### 4. Storage roles: PostgreSQL with pgvector, and DynamoDB

PostgreSQL runs as Aurora PostgreSQL in AWS, as `postgres:16` with pgvector in the Layer-2 composition
and in the self-hosted reference deployment, and as PGlite only in Layer-1 tests and the in-process
demo. It holds:

* existing data: the action ledger, tool idempotency, the transactional and audit outboxes, support
  records and case links, the durable workflow record, knowledge metadata (with full-text search and
  pgvector over the approved corpus only), memory, retention and console stores;
* new tables: the event inbox; timeline facts, projections and watermarks; entity links; carrier and
  transfer events (replacing `MemoryTransferStore`, `platform/src/workflows/transfer.ts:320`); turn
  envelopes; configuration publication; model-invocation metadata; evaluation results; and the spend
  ledger.

Action ownership and commit fencing stay in Postgres, inside the ledger transaction. Each package adds its
tables in its own migration range (`platform/migrations/2NN0` to `2NN9` for WP-NN). Contention and
fencing claims are verified only on `postgres:16` with more than one connection (WP-04, WP-25), never on
PGlite (decision 7.2).

DynamoDB (conditional writes; readers enforce expiry, per ADR-0004) holds call sessions, `CallBinding`,
revocation markers, call-owner leases with fencing tokens, and admission and quota counters shared
across instances.

Not added:

* a separate vector database;
* Redis for business state. Redis serves only as LiveKit's internal bus, if the pinned LiveKit SIP and
  multi-node versions require it, and it holds no business state;
* Kafka. A tenant's existing stream is consumed through an adapter;
* a second workflow engine.

### 5. Real model adapters behind a ModelRegistry

1. `platform/src/models` holds the ports and adapters (`port`, `adapters`, `emulators`: WP-08), a versioned
   `ModelRegistry` with qualification (`registry`, `qualify`: WP-09) and the native-audio adapters
   (`native`: WP-16). The registry has the fields that prompt section 9 lists:
   - role, publisher, model and revision;
   - endpoint, API and region;
   - licence and usage restrictions;
   - weight and tokenizer digests where self-hosted;
   - context, structured-output, tool and audio capabilities, and language qualification;
   - egress and retention terms;
   - accepted hardware and quantization;
   - timeout, token and compute budget, and cost version;
   - evaluation results, approval state, the approved fallback graph, the champion and the challengers.

   It is validated at startup and pinned in the release manifest.
2. Each role has its own port: `ModelPort` (text and tools), `NativeAudioPort`, `AsrPort`, `TtsPort`,
   `VadPort`, `EmbeddingPort` and `RerankPort`. Ports return typed, provider-specific result unions
   (text delta, tool call, refusal, usage, error class). There is no lowest-common-denominator layer: no
   LangChain model wrappers and no universal proxy, because compatibility is not universal.
3. Adapters:
   - **Amazon Bedrock:** the documented Converse and ConverseStream APIs, and Nova 2.5 Sonic through
     Bedrock's documented bidirectional streaming interface.
   - **OpenAI:** the Responses API, and GPT-Live through its own documented API with separate
     credentials and qualification.
   - **Self-hosted text models:** vLLM's OpenAI-compatible server, with its tool-parser and
     structured-output settings pinned per model.
   - **Python inference sidecars:** only for ASR (whisper-large-v3-turbo) and TTS (Kokoro-82M) in
     `sidecars/speech` (WP-13), embeddings (bge-m3) and the reranker (bge-reranker-v2-m3) in
     `sidecars/retrieval` (WP-20), and the optional safety auxiliary in `sidecars/safety` (WP-15).
   - **Managed TTS:** one managed TTS adapter in addition to the local candidate.

   Audio models run on their documented runtimes, never on the text vLLM adapter.
4. Routing is deterministic: each role maps to a pinned champion plus its approved fallback edges. An
   unavailable model never falls back to an unapproved provider, region, endpoint, tool format or
   retention policy. In that case the runtime falls back to an approved template and the human route.
   Outside local/ci, a role binding needs qualification run ids and a `MODEL_ROLE_USE` approval
   (FO-09-53).
5. Every model call goes through `platform/src/resilience` (deadline, cancellation, breaker, bulkhead) and
   the egress check (`platform/src/privacy/egress.ts` and the egress-classified HTTP transport in
   `platform/src/connectors/http`, WP-06, which imports no connector profile, secret, mapping DSL or
   connector family). It is audited as minimized `ModelInvocation` and `ModelDecision` metadata. Raw
   hidden reasoning is never stored.
6. Local runs use protocol-exact emulators in the Layer-2 composition by default. No network or model
   call happens without credentials and authorization. A real call needs an explicit execution profile, a
   credential reference and an egress allowlist entry (OPS-05). A real-model local profile needs only a
   reviewed credential or licensed local weights. This environment has no GPU, so vLLM text qualification
   and the native-audio experiments stay `NOT_RUN` until a GPU host is authorized.

### 6. The Docker-based local composition is the Layer-2 integration environment

1. `deploy/local/compose.yaml` (WP-03) is the entry file. The runner (`Makefile` and
   `scripts/vsp/runner.mts`, WP-03) loads every `deploy/local/services/*.compose.yaml` fragment, so a
   package adds the services it needs in its own fragment and never edits the entry file
   (`docs/followon/work-packages.yaml` ownership rules). `make up PROFILE=...` selects fragments.

   | Fragment | Services | Owner |
   |---|---|---|
   | `app.compose.yaml`, `otel-collector.compose.yaml` | the application images (gateway, worker, two media workers, audit exporter, console, companion) and an OpenTelemetry Collector | WP-07 |
   | `core.compose.yaml` | postgres:16 with pgvector, DynamoDB Local, ElasticMQ, MinIO with Object Lock, LocalStack (KMS, Secrets Manager, SNS, SES), Keycloak, Step Functions Local, Mailpit, ClamAV, livekit-server, livekit-sip | WP-03 |
   | `keycloak-realm.compose.yaml` | synthetic realm import (`deploy/local/keycloak/`) | WP-05 |
   | `sip-test.compose.yaml` | SIP softphone and receiver agents (`deploy/local/sip/`) | WP-12 |
   | `model-emulator.compose.yaml` | protocol-exact model emulators | WP-08 |
   | `speech.compose.yaml` | ASR and TTS sidecars | WP-13 |
   | `timeline-sources.compose.yaml` | synthetic timeline and event sources | WP-18 |
   | `retrieval.compose.yaml` | embedding and reranker sidecar | WP-20 |
   | `lakehouse.compose.yaml` | Iceberg catalog and query engine (`deploy/local/lakehouse/`) | WP-21 |
   | `reference-business-api.compose.yaml` | reference business API | WP-23 |
   | `toxiproxy.compose.yaml` | network fault injection | WP-42 |

   LiveKit configuration is in `deploy/local/livekit/` (WP-11). Images are pinned by digest and recorded
   in `docs/INVENTORY.md` with their licences.
2. Layer-2 tests run the exact production adapters over their real protocols against these services
   (`make test-integration`, `make test-audio`, `make test-chaos`). Reports label the behaviour that is
   emulated. Unit fakes stay in Layer 1.
3. PGlite and the LOCAL FIXTURES remain the fast Layer-1 regression environment. The production guard
   keeps rejecting fixture kinds (OPS-04).
4. WP-03 plans Step Functions Local as the emulator. Its task-token callback fidelity is recorded when the
   composition is written. If it is not faithful enough, the bridge's SQS and token handling can reach
   `VERIFIED_LOCAL`, but its Step Functions semantics stay `IMPLEMENTED` until a sandbox run.
5. The self-hosted reference deployment without AWS managed services is separate from this Layer-2
   composition and from `infra/terraform`: `deploy/reference/` (WP-39).

### 7. Two status axes

1. Every capability has three values. The software status is `MISSING`, `IMPLEMENTED`, `VERIFIED_LOCAL`
   or `RELEASE_PACKAGE_VERIFIED`. The environment status is `NOT_CONFIGURED`, `CONFIGURED`,
   `VERIFIED_SANDBOX`, `APPROVED_PILOT` or `VERIFIED_PRODUCTION`. The qualification result is `NOT_RUN`,
   `FAIL`, `INCONCLUSIVE` or `PASS`, with an evidence reference.
2. Software rules:
   - For a production capability, `MISSING` covers an interface plus a mock, a fixture-only adapter, a
     refusal in non-local composition, canned success, TEST ids, an empty history and a log line.
   - `IMPLEMENTED` means real code for the production path exists.
   - `VERIFIED_LOCAL` means that code passes local tests over its actual protocol, the tests cover every
     named element of the requirement's acceptance, and they are cited. A requirement whose acceptance
     names an element that no test exercises stays `IMPLEMENTED`. For adapters and storage, this requires a Layer-2 test against an emulator or a real local
     service. PGlite and stub-client tests support `VERIFIED_LOCAL` only for the SQL or domain logic they
     execute. They never support it for the driver, pooling, multi-connection concurrency or the deployed
     service.
   - `RELEASE_PACKAGE_VERIFIED` means the same checks passed on the built and signed release bundle.
3. A missing BAA, contract, credential or approval moves only the environment axis and is recorded in
   the single activation register. A stub is never presented as a missing tenant input.
4. One change migrates the single-axis `ReleaseStatus` (`platform/src/protocol/release.ts:115`), the
   traceability generator, the integration inventory, `docs/IMPLEMENTATION_STATUS.md` and the docs-pack
   vocabulary test together:
   - `IMPLEMENTED_OFFLINE` maps to `IMPLEMENTED` or `VERIFIED_LOCAL` according to the evidence, never
     automatically.
   - `BLOCKED` splits into software `MISSING` (the code is absent) or environment `NOT_CONFIGURED` (the
     inputs are absent).
   - Missing evidence stays `INCONCLUSIVE` and is never `PASS` (OPS-03).
5. Until that change lands, documents keep their existing rows in the old vocabulary, and rows added for
   the follow-on components use the two axes: threats FT-01 onwards in `docs/security/threat-model.md`
   section 8 and data flows DF-27 onwards in `docs/privacy/data-flow-inventory.md`. The docs-pack test
   (`platform/test/docs`, WP-44) still checks the old vocabulary on the legacy T-NN rows only.

### 8. Deployable units and topology

Infrastructure is WP-39 (`infra/terraform/**`, `deploy/reference/**`); images, signing and the release
bundle are WP-40.

* **ECS Fargate:** the gateway, the worker, the audit exporter (entry point
  `platform/src/main/audit-exporter.ts`, WP-07; exporter and verifier in `platform/src/audit/exporter`,
  WP-04; with its own write-only cross-account role), the console (behind an internal ALB, with workforce
  SSO, `infra/terraform/modules/console_service`) and the companion.
* **Media plane:** `livekit-server`, `livekit-sip` and TURN run on ECS on EC2 with host networking,
  Elastic IPs and an NLB for SIP and TURN (`infra/terraform/modules/media_hosts` and `media_ingress`). An
  HTTP load balancer alone cannot carry RTP or TURN.
* **Conversation runtime workers:** in the media AZs, with minimum warm capacity.
* **Optional GPU inference hosts:** in private subnets.
* **Secondary region:** a tested secondary US region with fenced failover: the infrastructure part is
  WP-39 (FO-16-44), the application write fence checked before every commit is WP-42 (FO-16-44a).
* **Self-hosted reference deployment:** kept separate from the AWS-managed plan.

The topology diagrams are in `docs/ARCHITECTURE.md` sections 6.3.2 and 6.3.3.

## Consequences

* The decision of ADR-0006 (no speech runtime) is superseded, but its fail-closed rules remain for the
  Talkdesk-native adapter. Decisions 1 and 2 replace ADR-0001's exclusion of a custom speech layer and
  an agent framework. ADR-0001's other exclusions still stand: no Kafka requirement, no second workflow
  engine, no separate vector database, no microservice per module. The status line of ADR-0006 now reads
  "Superseded by ADR-0018", and the status line of ADR-0001 notes that this record supersedes its
  speech-layer and agent-framework parts while the rest stays Accepted for engineering; `docs/DECISIONS.md`
  matches.
* Each new dependency needs a version, licence and digest record in `docs/INVENTORY.md` before use. This
  covers the LiveKit Agents Node SDK and its plugins, the Bedrock runtime client, an OpenAI client if one is
  used, container images, Python sidecar packages and model artifacts. Model cards and gated terms are
  reviewed first (prompt section 9).
* `docs/security/threat-model.md` section 8 holds the follow-on trust-boundary diagram and STRIDE rows
  FT-01 onwards: media, SIP and TURN; model endpoints including self-hosted vLLM; native audio; model or
  voice replacement; the secure web companion; the connector runtime and token manager; the context
  ingestion inbox; entity resolution; the improvement loop and canaries; operator studio publication. Each
  row names the work package that builds its mitigation and the planned test, and every row is software
  `MISSING` until that package lands. Feature packages draft further rows in
  `docs/security/threats/proposed/<WP-id>-threats.md`, and the threat-model owner of each phase merges
  them. `docs/privacy/data-flow-inventory.md` gains rows DF-27 to DF-40 for
  the flows in `docs/ARCHITECTURE.md` section 6.5. The retention matrix (WP-22) still needs runtime audio
  evidence and turn envelopes.
* The single activation register (`docs/followon/activation-register.yaml`, generated from
  `docs/followon/source/activations.yaml`) carries the inputs this record needs:
  - the SIP carrier contract, trunk and numbers for the reference route (AIN-50); PSTN test calls and
    their budget (AIN-18);
  - TURN and SIP TLS certificates and DNS records for the media ingress (AIN-47; AIN-01 covers DNS zones
    and certificates in general);
  - agreement coverage and retention evidence per managed model and speech provider, endpoint and region
    (AIN-49, with AIN-02 for the agreements and AIN-26 for the accounts);
  - gated model-licence and voice-rights reviews (AIN-28);
  - GPU capacity (AIN-27);
  - a security review of self-hosted LiveKit, LiveKit SIP and TURN (AIN-46; the independent penetration
    test AIN-41 also names the media plane);
  - standing spend ceilings for media hosts and GPU hosts (AIN-48);
  - the Talkdesk answer to VQ-TD-42 (AIN-51).

  AIN-46 to AIN-51 have no PRQ record; they are proposed additions to the prerequisite register, not
  requests that were sent. None of these inputs blocks software work.
* Operating cost and effort rise. The design adds EC2 media hosts with UDP networking, TURN, a Redis bus,
  inference hosts, and more images to scan and sign. The cost model gains dimensions for media legs, GPU
  and model tokens (FO-16-48).
* Latency becomes ours to measure. Every Mode A utterance passes the gateway gate and the release guard.
  Stage timestamps (ASR, reasoning, tools, validation, synthesis, buffers, network) are mandatory, so the
  section 17 targets can be checked (FO-10-51..53).
* None of this is reachable outside local/ci until the live composition root exists. That root is the
  first engineering dependency of every decision above (WP-07; FO-00-01, FO-16-11).
* Open items. These are facts to verify and questions to settle, not decisions; none is closed by this
  record:
  1. **GPT-Live and Nova 2.5 Sonic.** Their API details come only from the prompt's research cut ([T10] and
     [T18] in prompt section 23) and were not verified here: the exact API surface, endpoints, regions,
     authentication, quotas, session and data-retention terms, and how GPT-Live client delegation connects
     an independent backend. No context-window size is assumed for Nova 2.5 Sonic. They must be confirmed
     from current provider documentation before WP-16 builds the adapters, and each provider, region and
     data path is qualified separately (FO-03-34, AIN-26).
  2. **LiveKit facts to verify when the version is pinned** (WP-03 pins, WP-11 and WP-12 verify): whether
     `livekit-sip` and multi-node `livekit-server` need Redis; the default SIP, RTP, WebRTC and TURN port
     ranges; whether TURN is the server's embedded TURN or a separate server; whether the Node SDK has the
     VAD and turn-detection plugins needed (otherwise a Python worker for that function only); the
     documented webhook signing; the SIP transfer operations; and how `livekit-sip` delivers DTMF. WP-03
     and WP-11 name the LiveKit server and RTC SDKs; the LiveKit Agents Node framework that decision 1.1
     and prompt section 3 name must be added to that dependency set or replaced by a recorded decision.
     Until verified, `docs/ARCHITECTURE.md` section 6 and this record state these as assumptions to check,
     not as facts.
  3. **VQ-TD-42** is unanswered (AIN-51): whether Talkdesk offers a documented SIP or BYOC interface.
     Without one, Talkdesk-numbered calls cannot reach the LiveKit runtime, and the SIP reference route
     needs its own carrier trunk and numbers (AIN-50).
  4. **DTMF isolation under LiveKit SIP** (the TB-03 equivalent, AUTH-06): digits must reach neither ASR,
     models, recordings, transcripts nor logs, and pausing one recorder is not enough. WP-12's local tests
     cover the platform's own recorders only; the carrier's recordings and in-band tones need qualification
     per carrier (AIN-50), and the media-plane security review covers DTMF isolation under LiveKit SIP
     (AIN-46). Until both pass, OTP over DTMF stays disabled.
  5. **Step Functions Local** task-token callback fidelity (decision 6.4).

  Ownership gaps that an earlier draft of this record listed as open are now assigned in the plan source:
  the generated gateway client, the application and OpenTelemetry compose fragments and the audit-exporter
  entry point (WP-07); the audit exporter and verifier module (WP-04); the module register, the ESLint
  configurations of `media/` and `companion/` and the restriction of `platform/src/connectors/http` to an
  egress-classified transport (WP-06); the `conversation_runtime` channel (WP-02); the application region
  write fence FO-16-44a (WP-42).

## Alternatives considered

| Alternative | Why not adopted |
|---|---|
| Keep Talkdesk-native conversation as the only path (ADR-0001, ADR-0006) | Superseded by prompt section 22; it leaves the audio release boundary and TB-01..TB-10 outside this product's control |
| Pipecat or another Python voice framework | Prompt section 3 names LiveKit Agents with SIP; it would move orchestration into Python beside working TypeScript business logic |
| LiveKit Agents' own model and tool orchestration as the harness | Tool calls would bypass the gateway pipeline or depend on per-provider tool semantics; budgets, typed state and proposal-only specialists would still need code here |
| LangGraph.js for the harness | Decision 2: no material simplification, a second agent framework, checkpoints that overlap with the case owner, an extra dependency tree |
| LangGraph checkpoints, Temporal or the local executor as a durable owner next to Step Functions | Two owners for one case are prohibited (prompt section 3, ADR-0007) |
| Step Functions Express for cases | Its maximum execution duration is far too short for multi-day work |
| One OpenAI-compatible proxy, or LangChain model wrappers, for every provider | Hides provider-specific streaming, tool, refusal, usage and error semantics and adds an egress hop; prompt section 9 says compatibility is not universal |
| Sessions, bindings and leases in PostgreSQL only | Prompt section 3 assigns call binding, revocation and leases to DynamoDB conditional records; the reasoning in ADR-0004 still holds |
| A separate vector database | pgvector over the approved corpus is enough, with fewer stores holding sensitive data |
| PGlite only, without a Docker Layer 2 | One connection, no wire protocol, no driver or pooling: it cannot verify live adapters or concurrency |
| Kubernetes or Helm as the local integration environment | Heavier than one-host integration tests need; a Helm chart can follow for the reference deployment if a tenant requires one |
| A single status axis | It hides missing code behind missing approvals (prompt section 0) |

## Linked requirements

Invariants: ACT-01, ACT-02, ACT-03, ACT-04, ACT-05, AUTH-02, AUTH-03, AUTH-04, AUTH-06, DATA-01, DATA-02,
DATA-03, DATA-04, SAFE-02, SAFE-03, SAFE-04, SAFE-05, OPS-01, OPS-02, OPS-03, OPS-04, OPS-05, OPS-06.

Follow-on requirements (Phase A extraction, `docs/followon/requirements.yaml`):

* runtime and status: FO-00-29 (two status axes), FO-02-31 (invariant suite per adapter and mode),
  FO-22-16, FO-22-17, FO-22-19 (section 22 changes);
* reference architecture: FO-03-01..49;
* models and harness: FO-09-04..18, FO-09-36..47, FO-09-53;
* voice runtime and release boundary: FO-10-01..09, FO-10-22..29, FO-10-35..42, FO-10-47..50;
* durable case owner: FO-12-01, FO-12-10, FO-12-24;
* composition and topology: FO-16-01, FO-16-11, FO-16-13..25, FO-16-34, FO-17-03 (Layer 2), FO-19-10;
* two-axis capability statuses in the release manifest: FO-04-40.

Work packages (`docs/followon/work-packages.yaml`): WP-02 and WP-03 (contracts, workspace and Layer-2
composition), WP-04, WP-06 and WP-07 (substrate, connector runtime and import rules, live composition),
WP-08 to WP-17 (models, harness, media runtime, audio boundary, native mode), WP-26 (Step Functions
bridge), WP-39, WP-40 and WP-42 (topology, images and release, region write fence).

## Revisit when

* A LangGraph.js spike behind the `Harness` contract shows a measured simplification and passes the same
  property tests and latency budget, or the transition table grows beyond what reviewers can check (for
  example, more than about 25 phases, or nested subgraphs per intent).
* The pinned LiveKit Node SDK lacks a required plugin, or LiveKit SIP cannot meet the DTMF-isolation or
  transfer-evidence needs on the chosen carrier.
* Talkdesk answers VQ-TD-42 (a documented SIP or media interface), or TB-04 and TB-05 evidence arrives
  for the native adapter.
* Measured latency misses the section 17 targets with the gateway in the speech path.
* No maintained Step Functions emulator supports task-token callbacks.
* A tenant requires a deployment without AWS beyond the compose reference profile.
