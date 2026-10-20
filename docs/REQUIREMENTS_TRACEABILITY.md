# Requirements traceability

<!-- GENERATED FILE: do not edit by hand. Sources: docs/requirements/catalog.yaml, docs/followon/{requirements,gap-ledger,capabilities,activation-register}.yaml, scenarios/fixtures/failures; generator: platform/src/evaluation/traceability.ts -->

Report `traceability.v2`. Catalogue version `2026-10-19.1` (sha256 `07907c3c9d6fb15a…`). Generated at 2026-10-20T10:10:18.130Z.  
Follow-on ledger as of 2026-10-19 (gap-ledger sha256 `bad69ef275d392eb…`).  
Test results joined from: `evidence/test-reports/vitest-platform.json`, `evidence/test-reports/vitest-console.json`, `evidence/test-reports/vitest-contract-docs-journey.json`, `evidence/test-reports/opa-vsp.json`, `evidence/test-reports/opa-terraform.json`.

## Status vocabulary

Two independent axes plus qualification (follow-on prompt section 0, ADR-0018 decision 7):

| Axis | Values | Source |
|---|---|---|
| Software | `MISSING` < `IMPLEMENTED` < `VERIFIED_LOCAL` < `RELEASE_PACKAGE_VERIFIED` | `docs/followon/gap-ledger.yaml` per follow-on requirement |
| Environment | `NOT_CONFIGURED` < `CONFIGURED` < `VERIFIED_SANDBOX` < `APPROVED_PILOT` < `VERIFIED_PRODUCTION` | `docs/followon/gap-ledger.yaml` |
| Qualification | `NOT_RUN`, `FAIL`, `INCONCLUSIVE`, `PASS` | `docs/followon/gap-ledger.yaml` (evidence under `evidence/`) |
| Local tests | `NO_TEST`, `NOT_RUN`, `FAIL`, `PASS` | tagged tests joined with the recorded reports above (software evidence, never qualification) |

A capability or catalogue requirement is never reported ahead of its least advanced follow-on member; qualification is PASS only when every member is PASS. Unknown, missing evidence and unrun tests are not PASS (OPS-03). This generator never raises a status.

## Summary

| Scope | Count | Software | Environment | Qualification |
|---|---|---|---|---|
| Follow-on requirements | 1170 | IMPLEMENTED 440, MISSING 577, VERIFIED_LOCAL 153 | NOT_CONFIGURED 1170 | FAIL 4, NOT_RUN 1166 |
| Capabilities | 56 | IMPLEMENTED 4, MISSING 52 | NOT_CONFIGURED 56 | FAIL 3, NOT_RUN 53 |

| Catalogue requirements | Tagged tests | Local PASS | Local NOT_RUN | Local NO_TEST | Local FAIL | Externally blocked |
|---|---|---|---|---|---|---|
| 168 | 2921 | 134 | 15 | 19 | 0 | 98 |

Invariants: 27; all three test roles PASS for 27; failure injection PASS for 27.

Fault registry: 50 faults (fixed denominator); Layer-2 [FAULT:] status FAIL 0, INCONCLUSIVE 0, NOT_RUN 49, PASS 1; plan versus gap-ledger disagreements 0; fault tags naming no plan 0.

## Issues

None (every originalId resolves, no activation id is used as an originalId, every catalogue id has a follow-on row, the register is complete).

## Invariant register (FO-02-28, FO-19-05)

Positive, direct adversarial and failure-injection tests per invariant (`docs/requirements/catalog.yaml` `register`). A role is PASS only when every cited test passed in a recorded report.

| Invariant | FO row | Threats | Positive | Adversarial | Failure injection | All roles | Owner | Activation | Open gaps |
|---|---|---|---|---|---|---|---|---|---|
| AUTH-01 | FO-02-01 | T-01, T-02, T-03, T-29 | PASS (1) | PASS (1) | PASS (1) | PASS | Identity and access owner (WP-43) | AIN-12, AIN-15 | — |
| AUTH-02 | FO-02-02 | T-07, T-30 | PASS (1) | PASS (1) | PASS (2) | PASS | Identity and access owner (WP-43) | none | — |
| AUTH-03 | FO-02-03 | T-01, T-04, T-07, T-08, T-21 | PASS (2) | PASS (2) | PASS (2) | PASS | Identity and access owner (WP-43) | AIN-08, AIN-18 | — |
| AUTH-04 | FO-02-04 | T-04, T-05 | PASS (1) | PASS (1) | PASS (1) | PASS | Identity and access owner (WP-43) | none | — |
| AUTH-05 | FO-02-05 | T-06, T-07, T-27 | PASS (2) | PASS (2) | PASS (2) | PASS | Identity and access owner (WP-43) | AIN-10, AIN-12, AIN-14 | — |
| AUTH-06 | FO-02-06 | T-10, T-17, T-24 | PASS (1) | PASS (1) | PASS (1) | PASS | Identity and access owner (WP-43) | AIN-08 | AUDIO_RELEASE_BOUNDARY_NOT_BUILT |
| AUTH-07 | FO-02-07 | T-20, T-21 | PASS (1) | PASS (1) | PASS (1) | PASS | Identity and access owner (WP-43) | AIN-08 | — |
| DATA-01 | FO-02-08 | T-06, T-09, T-10, T-11, T-12 | PASS (2) | PASS (2) | PASS (2) | PASS | Privacy engineering owner (WP-43) | AIN-02, AIN-37 | — |
| DATA-02 | FO-02-09 | T-34 | PASS (1) | PASS (1) | PASS (1) | PASS | Privacy engineering owner (WP-43) | AIN-05 | AUDIO_RELEASE_BOUNDARY_NOT_BUILT |
| DATA-03 | FO-02-10 | T-35 | PASS (1) | PASS (1) | PASS (2) | PASS | Privacy engineering owner (WP-43) | AIN-23, AIN-25 | — |
| DATA-04 | FO-02-11 | T-31 | PASS (2) | PASS (2) | PASS (2) | PASS | Privacy engineering owner (WP-43) | none | — |
| ACT-01 | FO-02-12 | T-05, T-08, T-15 | PASS (1) | PASS (1) | PASS (1) | PASS | Transactions (action ledger) owner (WP-43) | AIN-08 | — |
| ACT-02 | FO-02-13 | T-05, T-13, T-28 | PASS (1) | PASS (1) | PASS (2) | PASS | Transactions (action ledger) owner (WP-43) | AIN-10 | — |
| ACT-03 | FO-02-14 | T-28 | PASS (1) | PASS (1) | PASS (1) | PASS | Transactions (action ledger) owner (WP-43) | AIN-10 | — |
| ACT-04 | FO-02-15 | T-36 | PASS (2) | PASS (2) | PASS (2) | PASS | Transactions (action ledger) owner (WP-43) | none | — |
| ACT-05 | FO-02-16 | T-09, T-25, T-26 | PASS (1) | PASS (1) | PASS (2) | PASS | Voice release boundary owner (WP-43) | AIN-08 | AUDIO_RELEASE_BOUNDARY_NOT_BUILT |
| SAFE-01 | FO-02-17 | T-37 | PASS (2) | PASS (2) | PASS (2) | PASS | Clinical safety engineering owner (WP-43) | AIN-21, AIN-22, AIN-31 | — |
| SAFE-02 | FO-02-18 | T-22 | PASS (1) | PASS (1) | PASS (2) | PASS | Clinical safety engineering owner (WP-43) | AIN-08 | — |
| SAFE-03 | FO-02-19 | T-19, T-22, T-33 | PASS (1) | PASS (1) | PASS (1) | PASS | Clinical safety engineering owner (WP-43) | AIN-08 | — |
| SAFE-04 | FO-02-20 | T-23, T-33 | PASS (1) | PASS (1) | PASS (1) | PASS | Clinical safety engineering owner (WP-43) | AIN-07 | — |
| SAFE-05 | FO-02-21 | T-23 | PASS (2) | PASS (2) | PASS (2) | PASS | Clinical safety engineering owner (WP-43) | AIN-06, AIN-18 | — |
| OPS-01 | FO-02-22 | T-16, T-32 | PASS (1) | PASS (1) | PASS (1) | PASS | Audit owner (WP-43) | AIN-01, AIN-03 | — |
| OPS-02 | FO-02-23 | T-19 | PASS (1) | PASS (1) | PASS (1) | PASS | Telephony continuity owner (WP-43) | AIN-08, AIN-19, AIN-20 | — |
| OPS-03 | FO-02-24 | T-38 | PASS (2) | PASS (2) | PASS (3) | PASS | Evaluation and test-truth owner (WP-43) | none | — |
| OPS-04 | FO-02-25 | T-15, T-17 | PASS (2) | PASS (2) | PASS (2) | PASS | Release and configuration owner (WP-43) | AIN-34 | — |
| OPS-05 | FO-02-26 | T-39 | PASS (1) | PASS (1) | PASS (1) | PASS | Release and configuration owner (WP-43) | AIN-30, AIN-34 | — |
| OPS-06 | FO-02-27 | T-15, T-18, T-30 | PASS (2) | PASS (2) | PASS (2) | PASS | Release and configuration owner (WP-43) | AIN-08, AIN-33, AIN-35 | — |

## Capabilities

| Capability | Title | Requirements | Software | Environment | Qualification |
|---|---|---|---|---|---|
| `platform.contracts` | Strict contract registry | 46 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN |
| `platform.workspace` | Workspace and Layer-2 emulator stack | 13 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN |
| `platform.substrate` | Durable storage, queues and keys | 13 | MISSING | NOT_CONFIGURED | NOT_RUN |
| `audit.independent` | Independent audit evidence | 19 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN |
| `ingress.events` | Authenticated inbound event inbox | 10 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN |
| `identity.caller` | Caller identity and session assurance | 37 | MISSING | NOT_CONFIGURED | NOT_RUN |
| `identity.workforce` | Workforce identity and RBAC | 13 | MISSING | NOT_CONFIGURED | NOT_RUN |
| `authority.registries` | Identity graph and authority registries | 25 | MISSING | NOT_CONFIGURED | NOT_RUN |
| `connectors.runtime` | Connector runtime and credentials | 34 | MISSING | NOT_CONFIGURED | NOT_RUN |
| `platform.composition` | Live composition | 18 | MISSING | NOT_CONFIGURED | NOT_RUN |
| `models.providers` | Model provider adapters | 14 | MISSING | NOT_CONFIGURED | NOT_RUN |
| `models.registry` | Model registry and qualification | 30 | MISSING | NOT_CONFIGURED | NOT_RUN |
| `conversation.harness` | Bounded conversation and investigation harness | 36 | MISSING | NOT_CONFIGURED | NOT_RUN |
| `voice.media_runtime` | Media runtime | 15 | MISSING | NOT_CONFIGURED | NOT_RUN |
| `telephony.sip` | SIP reference route | 7 | MISSING | NOT_CONFIGURED | NOT_RUN |
| `telephony.pstn` | PSTN qualification | 4 | MISSING | NOT_CONFIGURED | NOT_RUN |
| `voice.speech` | Speech input and output | 14 | MISSING | NOT_CONFIGURED | NOT_RUN |
| `voice.release_boundary` | Protected audio release boundary | 32 | MISSING | NOT_CONFIGURED | NOT_RUN |
| `voice.native` | Native full-duplex voice mode | 8 | MISSING | NOT_CONFIGURED | NOT_RUN |
| `voice.cascade` | Controlled cascade and audio-to-action journey | 21 | MISSING | NOT_CONFIGURED | NOT_RUN |
| `safety.routing` | Safety routing and fallback audio | 30 | MISSING | NOT_CONFIGURED | NOT_RUN |
| `continuity.ai_off` | Independent continuity route | 4 | MISSING | NOT_CONFIGURED | NOT_RUN |
| `handoff.transfer` | Accepted human transfer | 34 | MISSING | NOT_CONFIGURED | NOT_RUN |
| `context.store` | Context store and projections | 17 | MISSING | NOT_CONFIGURED | NOT_RUN |
| `context.assembly` | Context assembly | 32 | MISSING | NOT_CONFIGURED | NOT_RUN |
| `knowledge.retrieval` | Knowledge and grounding | 37 | MISSING | NOT_CONFIGURED | NOT_RUN |
| `data.warehouse` | Warehouse and lakehouse connectors | 13 | MISSING | NOT_CONFIGURED | NOT_RUN |
| `data.cdp` | CDP event connector | 5 | MISSING | NOT_CONFIGURED | NOT_RUN |
| `privacy.operations` | Privacy operations | 37 | MISSING | NOT_CONFIGURED | NOT_RUN |
| `domain.business_systems` | Canonical domain adapters | 20 | MISSING | NOT_CONFIGURED | NOT_RUN |
| `actions.effects` | Controlled actions and effect verification | 45 | MISSING | NOT_CONFIGURED | NOT_RUN |
| `workflows.durable` | Durable case ownership | 18 | MISSING | NOT_CONFIGURED | NOT_RUN |
| `workflows.families` | Workflow families and resolution contracts | 28 | MISSING | NOT_CONFIGURED | NOT_RUN |
| `notifications.messaging` | Notifications | 14 | MISSING | NOT_CONFIGURED | NOT_RUN |
| `voice.outbound` | Outbound voice | 3 | MISSING | NOT_CONFIGURED | NOT_RUN |
| `companion.web` | Secure web companion | 6 | MISSING | NOT_CONFIGURED | NOT_RUN |
| `contact_center.talkdesk` | Talkdesk contact-centre connector | 15 | MISSING | NOT_CONFIGURED | NOT_RUN |
| `conversation.talkdesk_native` | Talkdesk-native conversation path (optional) | 4 | MISSING | NOT_CONFIGURED | NOT_RUN |
| `crm.salesforce` | Salesforce Service Cloud connector | 15 | MISSING | NOT_CONFIGURED | NOT_RUN |
| `operator.configuration` | Tenant configuration publication | 8 | MISSING | NOT_CONFIGURED | NOT_RUN |
| `operator.onboarding` | Tenant onboarding and readiness | 15 | MISSING | NOT_CONFIGURED | NOT_RUN |
| `operator.studio` | Agent Studio and knowledge management | 10 | MISSING | NOT_CONFIGURED | NOT_RUN |
| `operator.console` | Operations console | 37 | MISSING | NOT_CONFIGURED | NOT_RUN |
| `evaluation.test_truth` | Test truth and invariant register | 31 | MISSING | NOT_CONFIGURED | FAIL |
| `evaluation.drivers` | Evaluation drivers and metrics | 17 | MISSING | NOT_CONFIGURED | FAIL |
| `evaluation.monitors` | Monitors, judges and review | 24 | MISSING | NOT_CONFIGURED | NOT_RUN |
| `improvement.pipeline` | Controlled improvement pipeline | 17 | MISSING | NOT_CONFIGURED | NOT_RUN |
| `improvement.canary_training` | Canary and training governance | 14 | MISSING | NOT_CONFIGURED | NOT_RUN |
| `deploy.infrastructure` | Infrastructure and reference deployment | 30 | MISSING | NOT_CONFIGURED | NOT_RUN |
| `release.supply_chain` | Supply chain and release bundle | 32 | MISSING | NOT_CONFIGURED | NOT_RUN |
| `operations.commands` | Entry point and operational commands | 24 | MISSING | NOT_CONFIGURED | NOT_RUN |
| `operations.resilience_cost` | Load, chaos, DR and cost | 30 | MISSING | NOT_CONFIGURED | FAIL |
| `platform.invariants` | Acceptance invariants | 40 | MISSING | NOT_CONFIGURED | NOT_RUN |
| `journeys.end_to_end` | Mandatory end-to-end journeys | 26 | MISSING | NOT_CONFIGURED | NOT_RUN |
| `governance.documents` | Delivery documents and compliance registers | 55 | MISSING | NOT_CONFIGURED | NOT_RUN |
| `activation.qualification` | Activation and qualification | 15 | MISSING | NOT_CONFIGURED | NOT_RUN |

## Fault registry (FO-17-24)

| Fault | Injection point | Injection-point packages | Layer-2 owner | Local driver | Layer-2 [FAULT:] tests | Layer-2 status |
|---|---|---|---|---|---|---|
| `ASR_FAILURE` | the ASR sidecar or managed ASR fails or returns no partials | WP-13 | WP-15 | NOT_SUPPORTED | 0 | NOT_RUN |
| `AUDIT_OUTAGE` | the central sink and local audit outbox cannot be written (MinIO Obje… | WP-04 | WP-04 | IN_PROCESS_FIXTURE_INJECTION | 1 | NOT_RUN |
| `AUTH_EXPIRY_DURING_SPEECH` | emission-time session re-check at the audio release boundary | WP-14 | WP-14 | NOT_SUPPORTED | 0 | NOT_RUN |
| `AUTH_EXPIRY_IDLE` | session idle expiry (lastActivityAt) in the identity service and the… | WP-04, WP-05 | WP-05 | NOT_SUPPORTED | 0 | NOT_RUN |
| `AUTH_EXPIRY_MID_CALL` | session expiry between prepare and commit (injected clock) | WP-04, WP-05 | WP-07 | IN_PROCESS_FIXTURE_INJECTION | 0 | NOT_RUN |
| `BILLING_TIMEOUT` | reference business API billing read timeout | WP-23 | WP-23 | IN_PROCESS_FIXTURE_INJECTION | 0 | NOT_RUN |
| `BRIDGE_DROPPED` | the bridge drops after receiver acceptance (LiveKit/SIP warm transfer) | WP-12, WP-28 | WP-28 | IN_PROCESS_FIXTURE_INJECTION | 0 | NOT_RUN |
| `BUDGET_EXHAUSTED` | the spend ledger reaches a tenant/cohort/model ceiling mid-call | WP-42 | WP-42 | NOT_SUPPORTED | 0 | NOT_RUN |
| `CHANGED_SLOT_DURING_CONFIRMATION` | the scheduling source changes the slot version between read-back and… | WP-23 | WP-25 | NOT_SUPPORTED | 0 | NOT_RUN |
| `CLAIMS_TIMEOUT` | reference business API claims read timeout | WP-23 | WP-23 | IN_PROCESS_FIXTURE_INJECTION | 0 | NOT_RUN |
| `CONCURRENT_SAME_ACCOUNT` | a second call commits to the same record while the first awaits confi… | WP-04, WP-23 | WP-25 | IN_PROCESS_FIXTURE_INJECTION | 0 | NOT_RUN |
| `CONSENT_REVOKED` | consent-registry revocation during a call and while work is pending | WP-19, WP-22 | WP-30 | NOT_SUPPORTED | 0 | NOT_RUN |
| `CONTRADICTORY_EVENT` | two sources or events disagree on a field used by the snapshot | WP-18, WP-24 | WP-24 | NOT_SUPPORTED | 0 | NOT_RUN |
| `CRASH_AFTER_COMMIT` | worker process death between the provider commit and the ledger recor… | WP-04, WP-25 | WP-25 | IN_PROCESS_FIXTURE_INJECTION | 0 | NOT_RUN |
| `DELEGATION_REVOKED` | relationship-directory revocation while work is pending (recheck unde… | WP-19 | WP-19 | NOT_SUPPORTED | 0 | NOT_RUN |
| `DLQ_FULL` | the dead-letter destination is at capacity or unwritable (ElasticMQ) | WP-04 | WP-07 | NOT_SUPPORTED | 0 | NOT_RUN |
| `DUPLICATE_WEBHOOK` | inbound inbox redelivery with the same (tenant, source, event_id) and… | WP-04 | WP-04 | IN_PROCESS_FIXTURE_INJECTION | 3 | NOT_RUN |
| `EVENTS_OUT_OF_ORDER` | carrier transfer events delivered out of order to the carrier_event_i… | WP-28 | WP-28 | IN_PROCESS_FIXTURE_INJECTION | 0 | NOT_RUN |
| `GUARDRAIL_LIMIT` | the conversation guard reaches its refusal count or turn limit during… | WP-15 | WP-15 | IN_PROCESS_FIXTURE_INJECTION | 0 | NOT_RUN |
| `IDP_UNAVAILABLE` | the OIDC provider (Keycloak) is unavailable during secure-link approv… | WP-05 | WP-05 | IN_PROCESS_FIXTURE_INJECTION | 0 | NOT_RUN |
| `INTERRUPTED_CONFIRMATION` | barge-in during the confirmation read-back at the audio boundary | WP-13, WP-14 | WP-14 | IN_PROCESS_FIXTURE_INJECTION | 0 | NOT_RUN |
| `JUDGE_FAILURE` | the pre-release or monitor judge times out or errors | WP-35 | WP-35 | NOT_SUPPORTED | 0 | NOT_RUN |
| `KNOWLEDGE_STALE` | the only matching approved article expires or is superseded | WP-20 | WP-20 | IN_PROCESS_FIXTURE_INJECTION | 0 | NOT_RUN |
| `LOCAL_PERSISTENCE_FAILURE` | the primary database write fails (postgres:16 stopped or read-only) | WP-04 | WP-15 | NOT_SUPPORTED | 0 | NOT_RUN |
| `MISSING_WEBHOOK` | a vendor event that never arrives (Talkdesk/Salesforce emulator drops… | WP-29 | WP-29 | NOT_SUPPORTED | 0 | NOT_RUN |
| `MODEL_HANG` | the model stream stalls past its deadline | WP-08 | WP-15 | NOT_SUPPORTED | 0 | NOT_RUN |
| `MODEL_OVERLOAD` | the model emulator returns overload/rate-limit errors | WP-08 | WP-17 | NOT_SUPPORTED | 0 | NOT_RUN |
| `MODEL_REFUSAL` | the model emulator returns a provider refusal | WP-08 | WP-17 | NOT_SUPPORTED | 0 | NOT_RUN |
| `NOTIFICATION_PROVIDER_DOWN` | the email/SMS sender (Mailpit/LocalStack) is unavailable | WP-27 | WP-27 | IN_PROCESS_FIXTURE_INJECTION | 0 | NOT_RUN |
| `PARTIAL_WRITE` | reference business API applies the first step of a multi-step write t… | WP-23 | WP-23 | IN_PROCESS_FIXTURE_INJECTION | 0 | NOT_RUN |
| `POLICY_ENGINE_ERROR` | the in-process OPA evaluation throws or is undefined | WP-01 | WP-01 | IN_PROCESS_FIXTURE_INJECTION | 5 | PASS |
| `PROVIDER_API_TIMEOUT` | reference business API provider-network timeout before send | WP-23 | WP-23 | IN_PROCESS_FIXTURE_INJECTION | 0 | NOT_RUN |
| `QUOTA_EXHAUSTED` | vendor or AI quota exhausted mid-call (shared quota counters) | WP-42 | WP-42 | IN_PROCESS_FIXTURE_INJECTION | 0 | NOT_RUN |
| `RECEIPT_LATE` | the receipt arrives after the reconcile budget or after a newer turn | WP-23, WP-25 | WP-25 | NOT_SUPPORTED | 0 | NOT_RUN |
| `RECEIPT_LOST` | the commit receipt or completion event never arrives | WP-23, WP-25 | WP-25 | NOT_SUPPORTED | 0 | NOT_RUN |
| `RECEIVER_DECLINED` | the receiver client declines the transfer | WP-28 | WP-28 | NOT_SUPPORTED | 0 | NOT_RUN |
| `RECEIVER_UNAVAILABLE` | no staffed receiver accepts within the attempt window | WP-28 | WP-28 | IN_PROCESS_FIXTURE_INJECTION | 0 | NOT_RUN |
| `RECORDING_REFUSED` | the caller declines recording on the media path | WP-11 | WP-25 | NOT_SUPPORTED | 0 | NOT_RUN |
| `REDACTION_FAILURE` | the redaction stage fails on a transcript segment | WP-22 | WP-35 | REFUSED | 0 | NOT_RUN |
| `REGIONAL_FAILOVER` | regional uncertainty with the application write fence (FO-16-44a) | WP-42 | WP-42 | REFUSED | 0 | NOT_RUN |
| `SALESFORCE_OUTAGE` | the Salesforce emulator refuses connections for the whole call | WP-29 | WP-29 | IN_PROCESS_FIXTURE_INJECTION | 0 | NOT_RUN |
| `SCHEDULING_TIMEOUT_AFTER_COMMIT` | the reference business API applies the change and times out the respo… | WP-23 | WP-25 | IN_PROCESS_FIXTURE_INJECTION | 0 | NOT_RUN |
| `SCHEDULING_UNAVAILABLE` | reference business API scheduling read refused before send | WP-23 | WP-23 | IN_PROCESS_FIXTURE_INJECTION | 0 | NOT_RUN |
| `SCHEMA_DRIFT` | a connector response or metadata whose fields differ from the profile… | WP-06 | WP-32 | NOT_SUPPORTED | 0 | NOT_RUN |
| `SOURCE_DELETED` | a subject or source record is deleted while work is pending | WP-22 | WP-24 | NOT_SUPPORTED | 0 | NOT_RUN |
| `SOURCE_MERGED` | the identity directory merges two subjects | WP-19 | WP-24 | NOT_SUPPORTED | 0 | NOT_RUN |
| `SOURCE_SPLIT` | the identity directory splits one subject into two | WP-19 | WP-24 | NOT_SUPPORTED | 0 | NOT_RUN |
| `STALE_SOURCE` | a context source older than its freshness budget (warehouse snapshot… | WP-21, WP-24 | WP-24 | NOT_SUPPORTED | 0 | NOT_RUN |
| `TRANSFER_FAILED` | the first allowlisted destination rejects the transfer | WP-28 | WP-28 | IN_PROCESS_FIXTURE_INJECTION | 0 | NOT_RUN |
| `TTS_FAILURE` | the TTS sidecar or managed TTS fails mid-utterance | WP-13 | WP-15 | NOT_SUPPORTED | 0 | NOT_RUN |

Plan versus gap-ledger disagreements (fault-registry.ts crossCheckLedger; resolved by regenerating docs/followon from its sources): none.

Fault tags naming no plan: none.

## Catalogue matrix

| Requirement | Text (short) | Enforcement location | Test IDs | Local tests | Evidence path | FO rows | Software | Environment | Qualification |
|---|---|---|---|---|---|---|---|---|---|
| AUTH-01 | Caller ID, DOB, NPI and spoken claims never authenticate a session alone. | `platform/src/identity`, `policy/` | 17: `platform/src/adapters/local/identity-directory.test.ts:14`<br>`platform/src/business/tools.test.ts:222`<br>`platform/src/business/tools.test.ts:261` (+14 more) | NOT_RUN | `evidence/test-reports/vitest-contract-docs-journey.json`, `evidence/test-reports/vitest-platform.json` | 20 | MISSING | NOT_CONFIGURED | NOT_RUN |
| AUTH-02 | Every protected read and mutation is authorized in trusted backend code. | `platform/src/gateway`, `platform/src/policy`, `policy/` | 53: `console/src/auth/rbac.test.tsx:81`<br>`console/src/auth/rbac.test.tsx:94`<br>`platform/src/actions/action-service.test.ts:516` (+50 more) | NOT_RUN | `evidence/test-reports/vitest-console.json`, `evidence/test-reports/vitest-contract-docs-journey.json`, `evidence/test-reports/vitest-platform.json` | 41 | MISSING | NOT_CONFIGURED | FAIL |
| AUTH-03 | Actor, subject, organization, assurance and consent are server-established. | `platform/src/identity`, `platform/src/gateway`, `platform/src/protocol/common.ts` | 59: `platform/src/actions/action-service.test.ts:851`<br>`platform/src/audit/schema.test.ts:113`<br>`platform/src/console-api/auth.test.ts:57` (+56 more) | NOT_RUN | `evidence/test-reports/vitest-contract-docs-journey.json`, `evidence/test-reports/vitest-platform.json` | 25 | MISSING | NOT_CONFIGURED | NOT_RUN |
| AUTH-04 | Expired or revoked sessions fail closed even if TTL cleanup has not run. | `platform/src/identity` | 57: `platform/src/actions/action-service.invalidation.test.ts:251`<br>`platform/src/actions/action-service.test.ts:827`<br>`platform/src/actions/action-service.test.ts:836` (+54 more) | NOT_RUN | `evidence/test-reports/vitest-contract-docs-journey.json`, `evidence/test-reports/vitest-platform.json` | 29 | MISSING | NOT_CONFIGURED | NOT_RUN |
| AUTH-05 | A provider or partner cannot access an unrelated person's records. | `policy/`, `platform/src/identity`, `platform/migrations` | 90: `platform/src/actions/action-service.reconciliation.test.ts:145`<br>`platform/src/actions/action-service.reconciliation.test.ts:159`<br>`platform/src/actions/action-service.reconciliation.test.ts:170` (+87 more) | PASS (90/90) | `evidence/test-reports/vitest-contract-docs-journey.json`, `evidence/test-reports/vitest-platform.json` | 37 | MISSING | NOT_CONFIGURED | NOT_RUN |
| AUTH-06 | Verification secrets never reach a model, transcript or ordinary logs. | `platform/src/identity`, `platform/src/observability`, `platform/src/audit` | 22: `platform/src/actions/digest.test.ts:109`<br>`platform/src/adapters/local/notification-fixture.test.ts:21`<br>`platform/src/audit/deferred.test.ts:119` (+19 more) | NOT_RUN | `evidence/test-reports/vitest-platform.json` | 12 | MISSING | NOT_CONFIGURED | NOT_RUN |
| AUTH-07 | Talkdesk Auth Gate false, null, undefined and reused-session cases are tested. | `platform/src/identity`, `talkdesk/auth-gate.md` | 17: `platform/src/evaluation/corpus.test.ts:505`<br>`platform/src/evaluation/driver/coordinator.test.ts:191`<br>`platform/src/gateway/http/routes.test.ts:131` (+14 more) | PASS (17/17) | `evidence/test-reports/vitest-platform.json` | 7 | MISSING | NOT_CONFIGURED | NOT_RUN |
| DATA-01 | No PHI goes to an unapproved endpoint, developer tool or analytics sink. | `platform/src/privacy`, `platform/src/observability`, `platform/src/config` | 151: `console/src/pages/CallInvestigationPage.test.tsx:18`<br>`platform/src/actions/action-service.reconciliation.test.ts:182`<br>`platform/src/actions/action-service.test.ts:93` (+148 more) | NOT_RUN | `evidence/test-reports/vitest-console.json`, `evidence/test-reports/vitest-contract-docs-journey.json`, `evidence/test-reports/vitest-platform.json` | 74 | MISSING | NOT_CONFIGURED | NOT_RUN |
| DATA-02 | Raw audio remains sensitive even when a later transcript is redacted. | `platform/src/privacy`, `platform/src/retention`, `docs/privacy` | 13: `platform/src/ingress/ingress.test.ts:491`<br>`platform/src/privacy/classification.test.ts:6`<br>`platform/src/privacy/classification.test.ts:15` (+10 more) | NOT_RUN | `evidence/test-reports/vitest-contract-docs-journey.json`, `evidence/test-reports/vitest-platform.json` | 16 | MISSING | NOT_CONFIGURED | NOT_RUN |
| DATA-03 | Recording and processing follow approved consent and retention controls. | `platform/src/privacy`, `platform/src/retention`, `talkdesk/studio-flow-spec.md` | 45: `platform/src/adapters/integration-inventory.test.ts:105`<br>`platform/src/business/support/case-observations.test.ts:185`<br>`platform/src/evaluation/corpus.test.ts:476` (+42 more) | NOT_RUN | `evidence/test-reports/vitest-contract-docs-journey.json`, `evidence/test-reports/vitest-platform.json` | 48 | MISSING | NOT_CONFIGURED | NOT_RUN |
| DATA-04 | A summary or memory cannot establish identity, consent or medical fact. | `platform/src/memory` | 27: `platform/src/business/cases.test.ts:30`<br>`platform/src/business/cases.test.ts:43`<br>`platform/src/business/cases.test.ts:52` (+24 more) | PASS (27/27) | `evidence/test-reports/vitest-contract-docs-journey.json`, `evidence/test-reports/vitest-platform.json` | 43 | MISSING | NOT_CONFIGURED | NOT_RUN |
| ACT-01 | Every consequential action has fresh, transaction-bound confirmation. | `platform/src/actions`, `platform/src/voice` | 75: `platform/src/actions/action-service.invalidation.test.ts:75`<br>`platform/src/actions/action-service.invalidation.test.ts:99`<br>`platform/src/actions/action-service.invalidation.test.ts:130` (+72 more) | PASS (75/75) | `evidence/test-reports/vitest-contract-docs-journey.json`, `evidence/test-reports/vitest-platform.json` | 39 | MISSING | NOT_CONFIGURED | NOT_RUN |
| ACT-02 | Retry, redelivery and crash-after-commit tests create no duplicate effect. | `platform/src/actions`, `platform/src/outbox` | 147: `console/src/pages/ReconciliationPage.test.tsx:59`<br>`console/src/pages/SupportTracePage.test.tsx:42`<br>`platform/src/actions/action-service.property.test.ts:143` (+144 more) | NOT_RUN | `evidence/test-reports/vitest-console.json`, `evidence/test-reports/vitest-contract-docs-journey.json`, `evidence/test-reports/vitest-platform.json` | 51 | MISSING | NOT_CONFIGURED | FAIL |
| ACT-03 | An ambiguous timeout is reconciled before retry or success is announced. | `platform/src/actions` | 103: `console/src/pages/PendingActionsPage.test.tsx:24`<br>`console/src/pages/ReconciliationPage.test.tsx:12`<br>`console/src/pages/ReconciliationPage.test.tsx:48` (+100 more) | NOT_RUN | `evidence/test-reports/vitest-console.json`, `evidence/test-reports/vitest-contract-docs-journey.json`, `evidence/test-reports/vitest-platform.json` | 31 | MISSING | NOT_CONFIGURED | NOT_RUN |
| ACT-04 | Case creation and workflow acceptance do not count as issue resolution. | `platform/src/workflows`, `platform/src/business`, `platform/src/evaluation/scorer.ts` | 45: `platform/src/actions/action-service.reconciliation.test.ts:182`<br>`platform/src/adapters/local/billing-fixture.test.ts:50`<br>`platform/src/adapters/local/support-records-fixture.test.ts:85` (+42 more) | PASS (45/45) | `evidence/test-reports/vitest-contract-docs-journey.json`, `evidence/test-reports/vitest-platform.json` | 40 | MISSING | NOT_CONFIGURED | FAIL |
| ACT-05 | Protected utterances cannot be spoken before authorization and validation. | `platform/src/voice` | 40: `platform/src/adapters/local/telephony-fixture.test.ts:195`<br>`platform/src/business/transactions.test.ts:123`<br>`platform/src/business/transactions.test.ts:137` (+37 more) | PASS (40/40) | `evidence/test-reports/vitest-contract-docs-journey.json`, `evidence/test-reports/vitest-platform.json` | 44 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SAFE-01 | No diagnosis, therapy, clinical screening or medication recommendation. | `platform/src/safety`, `platform/src/voice` | 15: `platform/src/business/handoff.test.ts:124`<br>`platform/src/business/handoff.test.ts:224`<br>`platform/src/safety/clinical-boundary.test.ts:50` (+12 more) | PASS (15/15) | `evidence/test-reports/vitest-platform.json` | 24 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SAFE-02 | Safety routing and human requests do not require account authentication. | `platform/src/safety`, `platform/src/ops`, `platform/src/gateway` | 82: `platform/src/actions/action-service.invalidation.test.ts:230`<br>`platform/src/business/handoff.test.ts:39`<br>`platform/src/business/handoff.test.ts:52` (+79 more) | PASS (82/82) | `evidence/test-reports/vitest-contract-docs-journey.json`, `evidence/test-reports/vitest-platform.json` | 22 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SAFE-03 | Refusal counts, silence and cost limits never silently terminate safety flow. | `platform/src/ops`, `platform/src/safety`, `talkdesk/ai-agent-config.yaml` | 89: `console/src/pages/BudgetsPage.test.tsx:21`<br>`platform/src/audit/deferred-flush.test.ts:63`<br>`platform/src/audit/deferred-flush.test.ts:153` (+86 more) | PASS (89/89) | `evidence/test-reports/vitest-console.json`, `evidence/test-reports/vitest-contract-docs-journey.json`, `evidence/test-reports/vitest-platform.json` | 48 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SAFE-04 | Transfer succeeds only with receiver acceptance and verified connection. | `platform/src/workflows/transfer.ts` | 59: `platform/src/adapters/local/telephony-fixture.test.ts:95`<br>`platform/src/adapters/local/telephony-fixture.test.ts:108`<br>`platform/src/adapters/local/telephony-fixture.test.ts:204` (+56 more) | PASS (59/59) | `evidence/test-reports/vitest-contract-docs-journey.json`, `evidence/test-reports/vitest-platform.json` | 38 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SAFE-05 | A caller, model or retrieved document cannot choose an arbitrary dial target. | `platform/src/config`, `platform/src/workflows/transfer.ts` | 38: `console/src/pages/CallInvestigationPage.test.tsx:81`<br>`platform/src/adapters/live/blocked.test.ts:114`<br>`platform/src/adapters/local/telephony-fixture.test.ts:42` (+35 more) | NOT_RUN | `evidence/test-reports/vitest-console.json`, `evidence/test-reports/vitest-contract-docs-journey.json`, `evidence/test-reports/vitest-platform.json` | 22 | MISSING | NOT_CONFIGURED | NOT_RUN |
| OPS-01 | Every accepted consequential action has durable independent audit evidence. | `platform/src/audit`, `platform/src/actions` | 215: `platform/src/actions/action-service.property.test.ts:143`<br>`platform/src/actions/action-service.reconciliation.test.ts:79`<br>`platform/src/actions/action-service.reconciliation.test.ts:129` (+212 more) | NOT_RUN | `evidence/test-reports/vitest-contract-docs-journey.json`, `evidence/test-reports/vitest-platform.json` | 51 | MISSING | NOT_CONFIGURED | FAIL |
| OPS-02 | AI failure preserves a usable telephony route with documented capacity. | `talkdesk/studio-flow-spec.md`, `platform/src/ops` | 17: `platform/src/audit/journal.test.ts:235`<br>`platform/src/gateway/pipeline.test.ts:322`<br>`platform/src/gateway/pipeline.test.ts:337` (+14 more) | NOT_RUN | `evidence/test-reports/vitest-contract-docs-journey.json`, `evidence/test-reports/vitest-platform.json` | 35 | MISSING | NOT_CONFIGURED | NOT_RUN |
| OPS-03 | Unknown capabilities, missing evidence and unrun tests are not PASS. | `platform/src/evaluation/scorer.ts`, `platform/src/evaluation/aggregate.ts`, `platform/src/evaluation/traceability.ts`, `docs/prerequisites.yaml` | 154: `platform/src/adapters/integration-inventory.test.ts:33`<br>`platform/src/adapters/integration-inventory.test.ts:46`<br>`platform/src/adapters/live/blocked.test.ts:91` (+151 more) | NOT_RUN | `evidence/test-reports/vitest-contract-docs-journey.json`, `evidence/test-reports/vitest-platform.json` | 77 | MISSING | NOT_CONFIGURED | FAIL |
| OPS-04 | Production refuses fixture adapters and missing mandatory approvals. | `platform/src/config/guard.ts` | 91: `console/src/auth/login.test.tsx:8`<br>`console/src/auth/login.test.tsx:29`<br>`platform/src/adapters/live/salesforce-rest.contract.test.ts:392` (+88 more) | NOT_RUN | `evidence/test-reports/vitest-console.json`, `evidence/test-reports/vitest-contract-docs-journey.json`, `evidence/test-reports/vitest-platform.json` | 34 | MISSING | NOT_CONFIGURED | NOT_RUN |
| OPS-05 | No paid tests, PHI access or production changes without scoped authorization. | `platform/src/config/guard.ts`, `approvals/`, `platform/src/ops/budgets.ts` | 10: `platform/src/config/guard.test.ts:502`<br>`platform/src/config/guard.test.ts:520`<br>`platform/src/config/guard.test.ts:527` (+7 more) | PASS (10/10) | `evidence/test-reports/vitest-contract-docs-journey.json`, `evidence/test-reports/vitest-platform.json` | 34 | MISSING | NOT_CONFIGURED | NOT_RUN |
| OPS-06 | Model, voice, knowledge, tools and policy versions are pinned and reviewable. | `platform/src/evaluation/manifest.ts`, `platform/src/protocol/release.ts` | 72: `console/src/pages/ReleasesPage.test.tsx:8`<br>`console/src/pages/ReleasesPage.test.tsx:29`<br>`platform/src/business/tools.test.ts:113` (+69 more) | PASS (72/72) | `evidence/test-reports/vitest-console.json`, `evidence/test-reports/vitest-contract-docs-journey.json`, `evidence/test-reports/vitest-platform.json` | 61 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-2.auth-gate-values | Auth Gate is tested for missing, null, false, string values, expiry and session reuse; an… | `platform/src/identity`, `talkdesk/auth-gate.md` | — | NO_TEST | — | 2 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-2.version-proof | Prove which agent/model/voice version each simulator or evaluation test exercises; never… | `platform/src/evaluation/runner.ts`, `talkdesk/simulator-and-evaluation-runbook.md` | — | NO_TEST | — | 1 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN |
| SPEC-2.guardrail-exit | Guardrail exits route back to Studio; crisis and accessibility interactions reach a human… | `talkdesk/ai-agent-config.yaml`, `talkdesk/studio-flow-spec.md`, `platform/src/safety` | 10: `platform/src/safety/conversation-guard.property.test.ts:94` (as SPEC-2.guardrail)<br>`platform/src/safety/conversation-guard.property.test.ts:119` (as SPEC-2.guardrail)<br>`platform/src/safety/conversation-guard.property.test.ts:129` (as SPEC-2.guardrail) (+7 more) | PASS (10/10) | `evidence/test-reports/vitest-platform.json` | 3 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-2.model-evidence | Exact model, region, quota and endpoint evidence is required before selecting a speech or… | `docs/vendor-integration-inventory.md`, `platform/src/evaluation/manifest.ts` | — | NO_TEST | — | 4 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-3.trust-boundaries | Caller input, retrieved articles, tool free text, transcripts and uploads are untrusted;… | `platform/src/gateway`, `docs/ARCHITECTURE.md` | 1: `platform/test/docs/prerequisites.test.ts:114` | PASS (1/1) | `evidence/test-reports/vitest-contract-docs-journey.json` | 11 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-3.independent-human-route | An independent Studio route to human support exists that needs no model response, gateway… | `talkdesk/studio-flow-spec.md` | — | NO_TEST | — | 2 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-3.workflow-engine | Durable work uses Step Functions Standard workflows; no second workflow engine, Kafka or… | `platform/src/workflows`, `infra/stepfunctions`, `docs/adr` | 5: `platform/src/workflows/asl.test.ts:53` (as SPEC-3.stepfunctions)<br>`platform/src/workflows/asl.test.ts:60` (as SPEC-3.stepfunctions)<br>`platform/src/workflows/asl.test.ts:264` (as SPEC-3.stepfunctions) (+2 more) | PASS (5/5) | `evidence/test-reports/vitest-platform.json` | 6 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-3.vendor-capability-gate | Before PHI-bearing production calls, demonstrate trusted call-context binding, secure ver… | `talkdesk/capability-gate.md` | — | NO_TEST | — | 5 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-3.ingress | Only the ingress needed by Talkdesk is exposed, with TLS, WAF and narrow authentication;… | `infra/terraform` | — | NO_TEST | — | 7 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-4.outcomes | Distinct outcomes RESOLVED, REQUEST_ACCEPTED, TRANSFERRED, INFORMATION_PROVIDED, DECLINED… | `platform/src/workflows/outcome.ts`, `platform/src/protocol/common.ts`, `platform/src/evaluation/scorer.ts`, `platform/src/business/outcomes.ts` | 2: `platform/src/business/tools.test.ts:168`<br>`platform/src/business/tools.test.ts:186` | PASS (2/2) | `evidence/test-reports/vitest-platform.json` | 3 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-4.resolution-contracts | Each workflow has a versioned resolution contract (audience, intent, assurance, permitted… | `platform/src/business`, `platform/src/protocol/contracts.ts` | — | NO_TEST | — | 11 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-4.workflow-catalogue | Implement public FAQs, login guidance, appointment lookup/create/reschedule, invoice expl… | `platform/src/business`, `platform/src/gateway`, `scenarios/skeletons` | 26: `platform/src/adapters/local/billing-fixture.test.ts:33` (as SPEC-4.billing)<br>`platform/src/adapters/local/read-fixtures.test.ts:20` (as SPEC-4.claims)<br>`platform/src/adapters/local/read-fixtures.test.ts:43` (as SPEC-4.provider) (+23 more) | PASS (26/26) | `evidence/test-reports/vitest-contract-docs-journey.json`, `evidence/test-reports/vitest-platform.json` | 10 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-4.audience-permissions | Provider identifiers, partner email domains and caller statements do not establish access… | `policy/`, `platform/src/identity` | 7: `platform/src/adapters/local/relationship-directory-fixture.test.ts:78` (as SPEC-4.audience)<br>`platform/src/business/appointments.test.ts:250` (as SPEC-4.audience)<br>`platform/src/business/business-gaps.test.ts:89` (as SPEC-4.audience) (+4 more) | PASS (7/7) | `evidence/test-reports/vitest-contract-docs-journey.json`, `evidence/test-reports/vitest-platform.json` | 6 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-4.role-selection | A multi-role user selects one role; privileges are never combined silently. | `platform/src/identity`, `policy/` | 3: `platform/src/evaluation/driver/coordinator.test.ts:182`<br>`platform/src/evaluation/driver/local-driver.test.ts:760`<br>`platform/src/policy/engine.test.ts:149` (as SPEC-4.single-role) | PASS (3/3) | `evidence/test-reports/vitest-platform.json` | 4 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN |
| SPEC-4.payments-isolated | Payments use an approved hosted payment page or isolated PCI flow; card numbers and secur… | `platform/src/voice`, `platform/src/privacy` | 1: `platform/src/business/billing.test.ts:46` (as SPEC-4.payment-page) | PASS (1/1) | `evidence/test-reports/vitest-platform.json` | 3 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-4.prohibited-assertions | Invoice explanations do not decide coverage, waive fees or promise refunds; claim status… | `platform/src/voice`, `platform/src/business` | 3: `platform/src/business/billing.test.ts:125`<br>`platform/src/business/billing.test.ts:215`<br>`platform/src/business/tools.test.ts:250` | PASS (3/3) | `evidence/test-reports/vitest-platform.json` | 1 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN |
| SPEC-5.prerequisite-register | Each prerequisite stores owner, status, evidence reference, approval date, expiry, enviro… | `docs/prerequisites.yaml`, `docs/tools/render-prerequisites.mjs` | 6: `platform/test/docs/prerequisites.test.ts:51` (as SPEC-5.prerequisites)<br>`platform/test/docs/prerequisites.test.ts:63` (as SPEC-5.prerequisites)<br>`platform/test/docs/prerequisites.test.ts:102` (as SPEC-5.prerequisites) (+3 more) | PASS (6/6) | `evidence/test-reports/vitest-contract-docs-journey.json` | 6 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-6.data-classes | Separate transient conversational data, business records, restricted QA media and securit… | `platform/src/retention`, `platform/src/audit/sinks`, `docs/privacy` | 4: `platform/src/audit/sinks/s3-object-lock.test.ts:82` (as SPEC-6.3)<br>`platform/src/audit/sinks/s3-object-lock.test.ts:118` (as SPEC-6.3)<br>`platform/src/privacy/classification.test.ts:37` (+1 more) | PASS (4/4) | `evidence/test-reports/vitest-platform.json` | 5 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-6.redaction | Redact or tokenize before general logs, analytics and downstream sharing; redaction failu… | `platform/src/privacy` | 9: `platform/src/privacy/egress-startup.test.ts:104`<br>`platform/src/privacy/patterns.test.ts:42`<br>`platform/src/privacy/redaction.test.ts:18` (+6 more) | PASS (9/9) | `evidence/test-reports/vitest-platform.json` | 2 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-6.no-phi-in-identifiers | No PHI in URLs, metric labels, alert text, resource names, trace baggage, error messages… | `platform/src/shared/ids.ts`, `platform/src/observability` | 9: `console/src/api/client.test.ts:111` (as SPEC-6.no-phi-url)<br>`console/src/api/contract.test.ts:130` (as SPEC-6.no-phi-url)<br>`console/src/pages/CallInvestigationPage.test.tsx:60` (as SPEC-6.no-phi-url) (+6 more) | PASS (9/9) | `evidence/test-reports/vitest-console.json`, `evidence/test-reports/vitest-platform.json` | 2 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN |
| SPEC-6.consent-before-recording | Consent is configured before recording where required; the approved alternative is offere… | `platform/src/privacy/consent.ts`, `talkdesk/studio-flow-spec.md` | 1: `platform/src/evaluation/corpus.test.ts:476` | PASS (1/1) | `evidence/test-reports/vitest-platform.json` | 4 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-6.case-minimization | Store a concise approved summary and a permission-checked evidence reference in Cases ins… | `platform/src/business`, `platform/src/adapters` | 3: `platform/src/business/handoff.test.ts:208` (as SPEC-8.restricted)<br>`platform/src/business/support-requests.test.ts:146` (as SPEC-8.restricted)<br>`platform/test/journeys/safety-handoff-regressions.test.ts:169` (as SPEC-8.restricted) | PASS (3/3) | `evidence/test-reports/vitest-contract-docs-journey.json`, `evidence/test-reports/vitest-platform.json` | 1 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN |
| SPEC-7.assurance-tiers | Assurance tiers A0 unverified, A1 verified possession, A2 account authenticated and A3 re… | `policy/`, `platform/src/protocol/common.ts`, `platform/src/identity` | — | NO_TEST | — | 4 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN |
| SPEC-7.secure-link-binding | Secure link or in-portal approval requires existing account authentication and is bound w… | `platform/src/identity` | 15: `platform/src/adapters/live/oidc-verifier.test.ts:44` (as SPEC-7.OIDC)<br>`platform/src/adapters/live/oidc-verifier.test.ts:52` (as SPEC-7.OIDC)<br>`platform/src/adapters/live/oidc-verifier.test.ts:76` (as SPEC-7.OIDC) (+12 more) | PASS (15/15) | `evidence/test-reports/vitest-platform.json` | 10 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-7.otp-limits | OTP fallback only to the existing verified channel, neutral message, five-minute expiry,… | `platform/src/identity/verification-service.ts` | 18: `platform/src/adapters/local/notification-fixture.test.ts:40` (as SPEC-7.OTP)<br>`platform/src/identity/config.test.ts:10` (as SPEC-7.OTP)<br>`platform/src/identity/enumeration-resistance.integration.test.ts:142` (as SPEC-7.OTP) (+15 more) | PASS (18/18) | `evidence/test-reports/vitest-platform.json` | 5 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN |
| SPEC-7.anti-enumeration | Name and date of birth locate a candidate only inside the verification service; generic r… | `platform/src/identity`, `platform/src/adapters/local` | 24: `platform/src/adapters/local/identity-directory.test.ts:7` (as SPEC-7.DIRECTORY)<br>`platform/src/adapters/local/identity-directory.test.ts:34` (as SPEC-7.DIRECTORY)<br>`platform/src/adapters/local/identity-directory.test.ts:43` (as SPEC-7.DIRECTORY) (+21 more) | PASS (24/24) | `evidence/test-reports/vitest-platform.json` | 2 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-7.session-model | The server records tenant, call, session generation, actor, role, subject, organization,… | `platform/src/identity`, `platform/src/protocol/auth.ts` | 25: `platform/src/gateway/http/routes.test.ts:131` (as SPEC-7.session)<br>`platform/src/identity/config.test.ts:31` (as SPEC-7.SESSION)<br>`platform/src/identity/config.test.ts:42` (as SPEC-7.KV) (+22 more) | PASS (25/25) | `evidence/test-reports/vitest-platform.json` | 4 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN |
| SPEC-7.assertions | Signed short-lived assertions are minted and validated only by trusted components with is… | `platform/src/identity/assertions` | 13: `platform/src/identity/assertions/assertion-service.test.ts:59` (as SPEC-7.ASSERTION)<br>`platform/src/identity/assertions/assertion-service.test.ts:73` (as SPEC-7.ASSERTION)<br>`platform/src/identity/assertions/assertion-service.test.ts:90` (as SPEC-7.ASSERTION) (+10 more) | PASS (13/13) | `evidence/test-reports/vitest-platform.json` | 1 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN |
| SPEC-7.privilege-expiry | Privileges expire at call end, participant change, account switching, recovery, revocatio… | `platform/src/identity`, `platform/src/workflows` | 22: `platform/src/business/wiring.test.ts:31` (as SPEC-7.durable-grant)<br>`platform/src/business/wiring.test.ts:38` (as SPEC-7.durable-grant)<br>`platform/src/business/wiring.test.ts:46` (as SPEC-7.durable-grant) (+19 more) | PASS (22/22) | `evidence/test-reports/vitest-contract-docs-journey.json`, `evidence/test-reports/vitest-platform.json` | 6 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-7.data-layer-isolation | Field-level minimization and organization isolation are applied at the data layer; unrela… | `policy/`, `platform/migrations`, `platform/src/ops/staff-authz.ts` | 3: `platform/src/gateway/mask.test.ts:33` (as SPEC-7.field-minimization)<br>`platform/src/policy/console.test.ts:121` (as SPEC-7.organization-isolation)<br>`platform/src/policy/engine.test.ts:220` (as SPEC-7.organization-isolation) | PASS (3/3) | `evidence/test-reports/vitest-platform.json` | 1 | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN |
| SPEC-7.workforce-separation | Staff use workforce SSO with MFA and least privilege; roles are separated; break-glass is… | `platform/src/console-api`, `platform/src/ops/staff-authz.ts` | 40: `console/src/api/contract.test.ts:71` (as SPEC-7.staff)<br>`console/src/api/contract.test.ts:105` (as SPEC-7.staff)<br>`console/src/auth/login.test.tsx:52` (as SPEC-7.staff) (+37 more) | PASS (40/40) | `evidence/test-reports/vitest-console.json`, `evidence/test-reports/vitest-platform.json` | 15 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-8.tool-surface | Only narrowly scoped tools are exposed; no raw SQL, arbitrary Salesforce query, arbitrary… | `platform/src/gateway`, `talkdesk/ai-agent-config.yaml` | 7: `platform/src/evaluation/driver/local-driver.test.ts:897`<br>`platform/src/gateway/mcp.test.ts:52` (as SPEC-8.mcp)<br>`platform/src/gateway/mcp.test.ts:69` (as SPEC-8.mcp) (+4 more) | PASS (7/7) | `evidence/test-reports/vitest-platform.json` | 6 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-8.tool-schema | Each tool has a versioned strict JSON Schema, bounded input, enums, classification, minim… | `platform/src/gateway`, `platform/src/protocol/tools.ts` | 19: `platform/src/actions/tool-idempotency.test.ts:96` (as SPEC-8.1)<br>`platform/src/actions/tool-idempotency.test.ts:111` (as SPEC-8.1)<br>`platform/src/business/billing.test.ts:62` (+16 more) | PASS (19/19) | `evidence/test-reports/vitest-platform.json` | 5 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN |
| SPEC-8.webhook-auth | Inbound webhooks are validated with the vendor's documented mechanism and replay protecti… | `platform/src/gateway` | 3: `platform/src/gateway/http/routes.test.ts:403` (as SPEC-8.webhook)<br>`platform/src/gateway/http/webhook-routes.test.ts:125` (as SPEC-8.webhook)<br>`platform/src/gateway/http/webhook-routes.test.ts:132` (as SPEC-8.webhook) | PASS (3/3) | `evidence/test-reports/vitest-platform.json` | 10 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-8.service-identities | Separate service identities per environment and integration; short-lived OAuth2 preferred… | `platform/src/config`, `infra/terraform`, `platform/src/gateway/auth.ts` | 12: `platform/src/gateway/auth.test.ts:28` (as SPEC-8.service-identity)<br>`platform/src/gateway/auth.test.ts:90` (as SPEC-8.oauth2)<br>`platform/src/gateway/auth.test.ts:95` (as SPEC-8.oauth2) (+9 more) | PASS (12/12) | `evidence/test-reports/vitest-platform.json` | 7 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-8.prepare-commit | A mutation is prepared with authoritative target, before-state version, exact change, imp… | `platform/src/actions` | 1: `platform/src/business/appointments.test.ts:201` | PASS (1/1) | `evidence/test-reports/vitest-platform.json` | 4 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN |
| SPEC-8.commit-recheck | Commit rechecks authorization, freshness, current state and confirmation with optimistic… | `platform/src/actions` | 8: `platform/src/actions/action-service.test.ts:141`<br>`platform/src/actions/action-service.test.ts:222`<br>`platform/src/actions/action-service.test.ts:257` (+5 more) | PASS (8/8) | `evidence/test-reports/vitest-contract-docs-journey.json`, `evidence/test-reports/vitest-platform.json` | 3 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-8.ledger | An action ledger and transactional outbox are persisted before durable delivery, with row… | `platform/src/actions`, `platform/src/outbox`, `platform/migrations` | 26: `platform/src/actions/action-service.reconciliation.test.ts:206` (as SPEC-8.3)<br>`platform/src/actions/action-service.reconciliation.test.ts:310` (as SPEC-8.3)<br>`platform/src/actions/action-service.test.ts:129` (as SPEC-8.3) (+23 more) | PASS (26/26) | `evidence/test-reports/vitest-contract-docs-journey.json`, `evidence/test-reports/vitest-platform.json` | 7 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-8.outbox | Events are delivered at least once and consumers deduplicate. | `platform/src/outbox` | 2: `platform/src/actions/action-service.reconciliation.test.ts:145`<br>`platform/src/worker/worker.test.ts:167` | PASS (2/2) | `evidence/test-reports/vitest-platform.json` | 10 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN |
| SPEC-8.timeout-states | On timeout distinguish NOT_STARTED, COMMITTED, FAILED and UNKNOWN; reconcile UNKNOWN by i… | `platform/src/actions`, `platform/src/gateway/pipeline.ts` | 2: `platform/src/gateway/pipeline.test.ts:412` (as SPEC-8.timeout)<br>`platform/src/workflows/definitions.test.ts:71` (as SPEC-8.reconciliation) | PASS (2/2) | `evidence/test-reports/vitest-platform.json` | 2 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN |
| SPEC-8.salesforce-model | Dedicated integration identity; interaction separated from issue; unique external ids and… | `platform/src/adapters`, `platform/src/adapters/support-records-schema.ts` | 19: `platform/src/adapters/live/salesforce-rest.contract.test.ts:92` (as SPEC-8.4)<br>`platform/src/adapters/live/salesforce-rest.contract.test.ts:115` (as SPEC-8.4)<br>`platform/src/adapters/live/salesforce-rest.contract.test.ts:126` (as SPEC-8.4) (+16 more) | PASS (19/19) | `evidence/test-reports/vitest-contract-docs-journey.json`, `evidence/test-reports/vitest-platform.json` | 9 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-8.salesforce-outage | When Salesforce is unavailable an encrypted internal support request and reference are pe… | `platform/src/business`, `platform/src/outbox`, `platform/src/console-api` | 13: `console/src/pages/SupportTracePage.test.tsx:42` (as SPEC-8.salesforce)<br>`console/src/pages/SupportTracePage.test.tsx:61` (as SPEC-8.salesforce)<br>`platform/src/console-api/support-repair.test.ts:36` (as SPEC-8.salesforce) (+10 more) | PASS (13/13) | `evidence/test-reports/vitest-console.json`, `evidence/test-reports/vitest-contract-docs-journey.json`, `evidence/test-reports/vitest-platform.json` | 8 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-9.workflow | Follow-up is a versioned state machine; every nonterminal state has owner, deadline, retr… | `platform/src/workflows` | 28: `platform/src/workflows/asl.test.ts:77`<br>`platform/src/workflows/asl.test.ts:98`<br>`platform/src/workflows/asl.test.ts:126` (+25 more) | PASS (28/28) | `evidence/test-reports/vitest-platform.json` | 18 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-9.task-tokens | Human approvals arrive through authenticated, authorized endpoints; task tokens never app… | `platform/src/workflows/tokens.ts` | 25: `console/src/api/contract.test.ts:111` (as SPEC-9.workflow-token)<br>`console/src/pages/ApprovalsPage.test.tsx:8` (as SPEC-9.workflow-token)<br>`console/src/pages/ApprovalsPage.test.tsx:42` (as SPEC-9.workflow-token) (+22 more) | PASS (25/25) | `evidence/test-reports/vitest-console.json`, `evidence/test-reports/vitest-platform.json` | 5 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN |
| SPEC-9.recheck | Before later disclosure or material change, recheck consent, representation, account stat… | `platform/src/workflows/recheck.ts` | 20: `platform/src/workflows/asl.test.ts:205`<br>`platform/src/workflows/engine.test.ts:603`<br>`platform/src/workflows/engine.test.ts:631` (+17 more) | PASS (20/20) | `evidence/test-reports/vitest-contract-docs-journey.json`, `evidence/test-reports/vitest-platform.json` | 7 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-9.notifications | Notifications follow registered preferences, quiet hours and consent with neutral message… | `platform/src/workflows/notification-policy.ts` | 6: `platform/src/adapters/local/notification-fixture.test.ts:11` (as SPEC-9.NOTIFY)<br>`platform/src/adapters/local/notification-fixture.test.ts:28` (as SPEC-9.NOTIFY)<br>`platform/src/adapters/local/notification-fixture.test.ts:59` (as SPEC-9.NOTIFY) (+3 more) | PASS (6/6) | `evidence/test-reports/vitest-platform.json` | 6 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-9.knowledge-ingestion | Knowledge enters through a controlled pipeline with owner, audience, intent, jurisdiction… | `platform/src/knowledge` | 58: `platform/src/evaluation/driver/local-driver.test.ts:952`<br>`platform/src/knowledge/conflicts.test.ts:22` (as SPEC-9.conflict)<br>`platform/src/knowledge/conflicts.test.ts:33` (as SPEC-9.conflict) (+55 more) | PASS (58/58) | `evidence/test-reports/vitest-platform.json` | 16 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-9.retrieval | Retrieval applies authorization and policy filters before semantic search and again befor… | `platform/src/knowledge` | 28: `platform/src/business/tools.test.ts:222`<br>`platform/src/business/tools.test.ts:232`<br>`platform/src/business/tools.test.ts:242` (+25 more) | PASS (28/28) | `evidence/test-reports/vitest-platform.json` | 16 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-9.memory | Only useful support memory with provenance labels and expiry; machine summaries never gra… | `platform/src/memory` | 5: `platform/src/business/cases.test.ts:30` (as SPEC-9.recap)<br>`platform/src/memory/support-memory.test.ts:63`<br>`platform/src/memory/support-memory.test.ts:74` (+2 more) | PASS (5/5) | `evidence/test-reports/vitest-platform.json` | 10 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-10.no-clinical-advice | Clinical questions trigger a concise boundary statement and a human or clinician route; n… | `platform/src/safety/clinical-boundary.ts`, `platform/src/voice` | — | NO_TEST | — | 3 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN |
| SPEC-10.safety-signals | Safety concerns are detected from multiple signals (explicit phrases, contextual semantic… | `platform/src/safety` | 19: `platform/src/safety/detector.property.test.ts:37` (as SPEC-10.detection)<br>`platform/src/safety/detector.property.test.ts:63` (as SPEC-10.detection)<br>`platform/src/safety/detector.test.ts:84` (as SPEC-10.detection) (+16 more) | PASS (19/19) | `evidence/test-reports/vitest-platform.json` | 4 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-10.signal-test-coverage | Safety tests include indirect language, negation, historical references, third-party conc… | `platform/src/safety`, `scenarios/risk` | 10: `platform/src/safety/detector.property.test.ts:73` (as SPEC-10.frustration)<br>`platform/src/safety/detector.test.ts:138` (as SPEC-10.negation)<br>`platform/src/safety/detector.test.ts:144` (as SPEC-10.negation) (+7 more) | PASS (10/10) | `evidence/test-reports/vitest-platform.json` | 2 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN |
| SPEC-10.safety-response | On a credible or unresolved concern stop administrative troubleshooting, revoke pending n… | `platform/src/safety`, `platform/src/actions` | 17: `platform/src/actions/action-service.test.ts:488` (as SPEC-10.1)<br>`platform/src/business/handoff.test.ts:152` (as SPEC-10.stop-admin-work)<br>`platform/src/business/handoff.test.ts:297` (as SPEC-10.stop-admin-work) (+14 more) | PASS (17/17) | `evidence/test-reports/vitest-contract-docs-journey.json`, `evidence/test-reports/vitest-platform.json` | 2 | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN |
| SPEC-10.no-auto-external-crisis | External crisis or emergency services are never conferenced automatically because a keywo… | `platform/src/safety/router.ts`, `platform/src/config` | — | NO_TEST | — | 1 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN |
| SPEC-10.transfer | Transfer states REQUESTED, QUEUED, RECEIVER_ACCEPTED, BRIDGED, CALLER_CONFIRMED_CONNECTED… | `platform/src/workflows/transfer.ts` | 21: `platform/src/adapters/local/telephony-fixture.test.ts:175`<br>`platform/src/evaluation/corpus.test.ts:424`<br>`platform/src/safety/conversation-guard.test.ts:77` (+18 more) | PASS (21/21) | `evidence/test-reports/vitest-contract-docs-journey.json`, `evidence/test-reports/vitest-platform.json` | 9 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-10.handoff-package | The authorized receiver gets a concise context package (issue, assurance and limits, subj… | `platform/src/workflows`, `platform/src/protocol/support.ts` | 3: `platform/src/business/handoff.test.ts:109`<br>`platform/src/gateway/http/routes.test.ts:349` (as SPEC-10.context)<br>`platform/src/safety/fail-safe.test.ts:107` (as SPEC-10.handoff) | PASS (3/3) | `evidence/test-reports/vitest-platform.json` | 2 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-10.transfer-failure | The caller stays connected while the human joins; on failure an approved update plays and… | `platform/src/workflows/transfer.ts`, `talkdesk/studio-flow-spec.md` | — | NO_TEST | — | 3 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-10.safety-latency | Engineering target: initiate the priority route within two seconds of a validated safety… | `platform/src/safety`, `platform/src/observability/slo.ts` | 4: `platform/src/safety/safety-events.test.ts:51` (as SPEC-10.latency)<br>`platform/src/safety/safety-events.test.ts:66` (as SPEC-10.latency)<br>`platform/src/safety/safety-events.test.ts:76` (as SPEC-10.latency) (+1 more) | PASS (4/4) | `evidence/test-reports/vitest-platform.json` | 2 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN |
| SPEC-11.opening-disclosure | Opening language identifies the company and automated role, offers a human and gives the… | `platform/src/voice/templates`, `talkdesk/studio-flow-spec.md` | 1: `platform/src/voice/registry.test.ts:95` (as SPEC-11.opening) | PASS (1/1) | `evidence/test-reports/vitest-platform.json` | 1 | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN |
| SPEC-11.voice-selection | A licensed stock voice is chosen by blinded telephone-quality listening tests; no cloning… | `talkdesk/ai-agent-config.yaml` | — | NO_TEST | — | 3 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-11.ack-not-resolution | A safe acknowledgment does not count as resolution latency or success; genuine delays get… | `platform/src/voice`, `platform/src/observability/slo.ts` | 1: `platform/src/voice/gate.test.ts:101` (as SPEC-11.acknowledgment) | PASS (1/1) | `evidence/test-reports/vitest-platform.json` | 1 | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN |
| SPEC-11.barge-in | Barge-in stops queued speech and invalidates stale segments; audio segments, tool results… | `platform/src/voice/speech-queue.ts`, `platform/src/voice/turns.ts` | 10: `platform/src/gateway/http/routes.test.ts:278`<br>`platform/src/safety/safety-flow.test.ts:92`<br>`platform/src/voice/speech-queue.test.ts:62` (+7 more) | PASS (10/10) | `evidence/test-reports/vitest-contract-docs-journey.json`, `evidence/test-reports/vitest-platform.json` | 11 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-11.endpointing | Callers who pause, stutter, speak slowly or use assistive communication are not clipped;… | `talkdesk/ai-agent-config.yaml`, `platform/src/voice` | — | NO_TEST | — | 5 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-11.interpreter | Unsupported languages go to a staffed interpreter path. | `talkdesk/studio-flow-spec.md`, `platform/src/config` | 4: `platform/src/business/handoff.test.ts:61` (as SPEC-16.interpreter)<br>`platform/src/safety/conversation-guard.test.ts:72`<br>`platform/src/safety/detector.test.ts:252` (+1 more) | PASS (4/4) | `evidence/test-reports/vitest-platform.json` | 4 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-11.response-gate | Protected responses are validated before their first audible segment using approved templ… | `platform/src/voice/gate.ts` | 6: `platform/src/business/tools.test.ts:118` (as SPEC-11.templates)<br>`platform/src/gateway/pipeline.test.ts:434` (as SPEC-11.templates)<br>`platform/src/voice/registry.test.ts:72` (as SPEC-11.templates) (+3 more) | PASS (6/6) | `evidence/test-reports/vitest-platform.json` | 8 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-11.response-record | The response record references current authorization, accepted sources, receipts and poli… | `platform/src/voice` | 1: `platform/src/voice/speech-queue.test.ts:95` (as SPEC-11.fail-closed) | PASS (1/1) | `evidence/test-reports/vitest-platform.json` | 2 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-11.confirmation-readback | Names are confirmed by spelling when needed and amounts, dates, time zones and consequenc… | `platform/src/voice` | 3: `platform/src/voice/gate.test.ts:62` (as SPEC-11.confirmation)<br>`platform/src/voice/gate.test.ts:82` (as SPEC-11.confirmation)<br>`platform/src/voice/slots.test.ts:85` (as SPEC-11.confirmation) | PASS (3/3) | `evidence/test-reports/vitest-platform.json` | 1 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN |
| SPEC-12.capacity-model | Capacity figures are labelled planning assumptions; 30 days of real arrival data is requi… | `docs/capacity-cost-model.md`, `scripts/capacity_model.py`, `platform/src/ops/capacity.ts` | 7: `platform/src/gateway/call-state.test.ts:23` (as SPEC-12.capacity)<br>`platform/src/ops/admission.test.ts:226` (as SPEC-12.capacity)<br>`platform/src/ops/admission.test.ts:241` (as SPEC-12.capacity) (+4 more) | PASS (7/7) | `evidence/test-reports/vitest-contract-docs-journey.json`, `evidence/test-reports/vitest-platform.json` | 11 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-12.quotas | Quotas are contracted and tested separately for trunks, call starts, media legs, AI sessi… | `docs/vendor-integration-inventory.md`, `platform/src/ops` | 1: `platform/src/adapters/live/salesforce-rest.contract.test.ts:321` (as SPEC-12.quota) | PASS (1/1) | `evidence/test-reports/vitest-contract-docs-journey.json` | 5 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-12.bounded-caching | Salesforce is not pulled on every speech turn; bounded authorized caching carries source… | `platform/src/adapters`, `platform/src/business` | 4: `platform/src/adapters/local/support-records-fixture.test.ts:145` (as SPEC-12.caching)<br>`platform/src/adapters/support-record-cache.test.ts:52` (as SPEC-12.caching)<br>`platform/src/adapters/support-record-cache.test.ts:62` (as SPEC-12.caching) (+1 more) | PASS (4/4) | `evidence/test-reports/vitest-platform.json` | 3 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-12.load-test | Load tests use distributions, long calls, transfer legs, retries and reconnects; test at… | `platform/test`, `scripts` | 7: `platform/test/load/load-smoke.test.ts:45`<br>`platform/test/load/load-smoke.test.ts:53`<br>`platform/test/load/load-smoke.test.ts:68` (+4 more) | PASS (7/7) | `evidence/test-reports/vitest-platform.json` | 8 | MISSING | NOT_CONFIGURED | FAIL |
| SPEC-12.resilience | Readiness checks, warm capacity, per-dependency bulkheads, timeouts, bounded retries with… | `platform/src/resilience` | 18: `platform/src/gateway/http/routes.test.ts:118` (as SPEC-13.readiness)<br>`platform/src/gateway/pipeline.test.ts:394` (as SPEC-12.retry)<br>`platform/src/gateway/pipeline.test.ts:402` (as SPEC-12.circuit-breaker) (+15 more) | PASS (18/18) | `evidence/test-reports/vitest-platform.json` | 10 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-12.no-retry-stacking | Avoid retries on top of retries; concurrent duplicate executions do not stack. | `platform/src/resilience`, `platform/src/actions/tool-idempotency.ts` | 13: `platform/src/actions/tool-idempotency.test.ts:60` (as SPEC-12.3)<br>`platform/src/actions/tool-idempotency.test.ts:69` (as SPEC-12.3)<br>`platform/src/outbox/outbox.test.ts:118` (as SPEC-12.3) (+10 more) | PASS (13/13) | `evidence/test-reports/vitest-contract-docs-journey.json`, `evidence/test-reports/vitest-platform.json` | 3 | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN |
| SPEC-12.admission | Backpressure and admission control shed noncritical analytics and model work first while… | `platform/src/ops/admission.ts` | 10: `platform/src/gateway/http/routes.test.ts:478` (as SPEC-12.rate-limit)<br>`platform/src/gateway/http/routes.test.ts:491` (as SPEC-12.rate-limit)<br>`platform/src/gateway/http/tool-rate-limit.test.ts:29` (as SPEC-12.rate-limit) (+7 more) | PASS (10/10) | `evidence/test-reports/vitest-platform.json` | 4 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-12.db-outage | A database outage blocks protected reads and writes while the telephone route remains usa… | `platform/src/gateway`, `platform/src/actions`, `platform/src/safety/safety-events.ts`, `platform/src/resilience` | 4: `platform/src/business/db-outage.test.ts:38`<br>`platform/src/gateway/pipeline.db-outage.test.ts:39`<br>`platform/src/gateway/pipeline.db-outage.test.ts:61` (+1 more) | PASS (4/4) | `evidence/test-reports/vitest-platform.json` | 2 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-12.budget-cutoff | Budget exhaustion stops new nonessential automation and routes to continuity service; an… | `platform/src/ops/budgets.ts` | 13: `console/src/api/contract.test.ts:92` (as SPEC-12.budgets)<br>`console/src/pages/BudgetsPage.test.tsx:8` (as SPEC-12.budgets)<br>`platform/src/console-api/views.test.ts:183` (as SPEC-12.budgets) (+10 more) | PASS (13/13) | `evidence/test-reports/vitest-console.json`, `evidence/test-reports/vitest-platform.json` | 8 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-12.recovery | Proposed application recovery within 15 minutes and cross-region data loss no worse than… | `infra/terraform`, `docs/RUNBOOKS`, `platform/src/gateway/pipeline.ts`, `platform/src/config/loader.ts` | 3: `platform/src/gateway/pipeline.test.ts:329` (as SPEC-15.dr-fence)<br>`platform/src/main/container.test.ts:120` (as SPEC-12.write-fence)<br>`platform/src/main/infra-config.test.ts:12` (as SPEC-12.write-fence) | PASS (3/3) | `evidence/test-reports/vitest-platform.json` | 11 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-13.slo-definitions | Service objectives define measurement point, denominator, exclusions and window in code;… | `platform/src/observability/slo.ts` | 9: `platform/src/observability/slo.test.ts:20` (as SPEC-13.slo)<br>`platform/src/observability/slo.test.ts:53` (as SPEC-13.slo)<br>`platform/src/observability/slo.test.ts:70` (as SPEC-13.slo) (+6 more) | PASS (9/9) | `evidence/test-reports/vitest-platform.json` | 7 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-13.dashboards | Dashboards cover arrivals, sessions, queues, transfers, identity, tools, dependencies, sa… | `platform/src/observability`, `infra/terraform` | 20: `platform/src/business/handoff.test.ts:275` (as SPEC-13.metrics)<br>`platform/src/gateway/pipeline.test.ts:64` (as SPEC-13.metrics)<br>`platform/src/identity/abuse-monitor.test.ts:35` (+17 more) | PASS (20/20) | `evidence/test-reports/vitest-contract-docs-journey.json`, `evidence/test-reports/vitest-platform.json` | 2 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-13.resolution-metrics | Verified resolution, repeat contact and reopened cases are measured; containment is separ… | `platform/src/observability`, `platform/src/evaluation/aggregate.ts` | 38: `platform/src/business/outcomes.test.ts:140`<br>`platform/src/business/outcomes.test.ts:146`<br>`platform/src/business/outcomes.test.ts:159` (+35 more) | PASS (38/38) | `evidence/test-reports/vitest-platform.json` | 5 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-13.audit-model | Every meaningful event carries id, schema version, UTC time, correlation and parent ids,… | `platform/src/audit/schema.ts`, `platform/src/protocol/audit.ts` | 5: `platform/src/audit/schema.test.ts:31` (as SPEC-13.3)<br>`platform/src/audit/schema.test.ts:160` (as SPEC-13.3)<br>`platform/src/audit/schema.test.ts:195` (as SPEC-13.3) (+2 more) | PASS (5/5) | `evidence/test-reports/vitest-platform.json` | 5 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN |
| SPEC-13.audit-integrity | Audit events are append-only in an independently administered account with restricted del… | `platform/src/audit/chain.ts`, `platform/src/audit/verifier.ts`, `platform/src/audit/shipper.ts`, `platform/src/audit/monitor.ts` | 4: `platform/src/audit/monitor.test.ts:59` (as SPEC-13.audit)<br>`platform/src/audit/monitor.test.ts:76` (as SPEC-13.audit)<br>`platform/src/audit/monitor.test.ts:96` (as SPEC-13.audit) (+1 more) | PASS (4/4) | `evidence/test-reports/vitest-contract-docs-journey.json`, `evidence/test-reports/vitest-platform.json` | 9 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-13.audit-access | Sensitive content is separated from security metadata; access to both is audited; audit-v… | `platform/src/audit/query.ts`, `platform/migrations` | 3: `platform/src/audit/query.test.ts:41` (as SPEC-13.5)<br>`platform/src/audit/query.test.ts:51` (as SPEC-13.5)<br>`platform/src/audit/query.test.ts:75` (as SPEC-13.5) | PASS (3/3) | `evidence/test-reports/vitest-platform.json` | 4 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN |
| SPEC-13.audit-outage | A local durable outbox may buffer within a bounded policy; if durable evidence cannot be… | `platform/src/audit/health.ts`, `platform/src/gateway` | 7: `platform/src/audit/deferred-flush.test.ts:63` (as SPEC-13.bounded-buffer)<br>`platform/src/audit/deferred-flush.test.ts:90` (as SPEC-13.bounded-buffer)<br>`platform/src/audit/deferred.test.ts:54` (as SPEC-13.bounded-buffer) (+4 more) | PASS (7/7) | `evidence/test-reports/vitest-platform.json` | 1 | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN |
| SPEC-13.console | Authorized staff can inspect a journey, join or transfer via supported controls, review a… | `platform/src/console-api`, `console/` | 70: `console/src/api/client.test.ts:95`<br>`console/src/api/client.test.ts:125`<br>`console/src/api/contract.test.ts:51` (+67 more) | PASS (70/70) | `evidence/test-reports/vitest-console.json`, `evidence/test-reports/vitest-contract-docs-journey.json`, `evidence/test-reports/vitest-platform.json` | 14 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-13.killswitch | Separate kill switches for new AI admissions, an intent, an integration, writes, a model/… | `platform/src/ops/kill-switches.ts` | 26: `platform/src/business/billing.test.ts:192` (as SPEC-13.kill-switches)<br>`platform/src/business/business-gaps.test.ts:69` (as SPEC-13.kill-switches)<br>`platform/src/business/tools.test.ts:349` (as SPEC-13.kill-switches) (+23 more) | PASS (26/26) | `evidence/test-reports/vitest-platform.json` | 3 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-13.incident-playbooks | Escalation roster and playbooks exist for PHI exposure, unsafe output, failed safety tran… | `docs/RUNBOOKS` | 3: `platform/test/docs/docs-pack.test.ts:183` (as SPEC-13.runbooks)<br>`platform/test/docs/docs-pack.test.ts:190` (as SPEC-13.runbooks)<br>`platform/test/docs/docs-pack.test.ts:206` (as SPEC-13.runbooks) | PASS (3/3) | `evidence/test-reports/vitest-contract-docs-journey.json` | 4 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-14.threat-model | Threat model covers caller spoofing, SIM swap, enumeration, session fixation, replay, cro… | `docs/security`, `platform/src/identity`, `platform/src/gateway` | 67: `platform/src/adapters/local/identity-directory.test.ts:25` (as SPEC-14.ENUMERATION)<br>`platform/src/gateway/http/portal-routes.test.ts:122` (as SPEC-14.FIXATION)<br>`platform/src/gateway/http/routes.test.ts:63` (as SPEC-14.http-security) (+64 more) | PASS (67/67) | `evidence/test-reports/vitest-contract-docs-journey.json`, `evidence/test-reports/vitest-platform.json` | 5 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-14.supply-chain | Least-privilege IAM, workload identity, TLS, KMS, dependency pinning, SBOM, signature ver… | `.github`, `scripts/ci`, `infra/terraform`, `platform/Dockerfile` | — | NO_TEST | — | 18 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-14.hostile-gateway-tests | The gateway is tested directly with hostile tool calls even if the conversational prompt… | `platform/src/gateway`, `scenarios/risk` | 3: `platform/src/gateway/pipeline.test.ts:88` (as SPEC-14.hostile)<br>`platform/src/gateway/pipeline.test.ts:199` (as SPEC-14.hostile)<br>`platform/src/gateway/pipeline.test.ts:213` (as SPEC-14.hostile) | PASS (3/3) | `evidence/test-reports/vitest-platform.json` | 4 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-14.pentest | Independent security review and penetration testing of backend and telephone journey; no… | `docs/security` | — | NO_TEST | — | 1 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN |
| SPEC-14.test-layers | Deterministic unit and property tests, vendor contract tests, synthetic multi-turn dialog… | `platform/src/evaluation/runner.ts`, `platform/test` | — | NO_TEST | — | 23 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-14.intent-corpus | At least 50 reviewed support intents across all audiences and eight variant families (bas… | `scenarios/skeletons`, `platform/src/evaluation/generate.ts` | 9: `platform/src/evaluation/corpus.test.ts:36`<br>`platform/src/evaluation/corpus.test.ts:52`<br>`platform/src/evaluation/corpus.test.ts:101` (+6 more) | PASS (9/9) | `evidence/test-reports/vitest-platform.json` | 7 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-14.risk-corpus | At least 500 human-reviewed privacy, authorization, clinical-boundary and safety-routing… | `scenarios/risk`, `platform/src/evaluation/generate-risk.ts` | 2: `platform/src/evaluation/corpus.test.ts:57`<br>`platform/src/evaluation/generate.test.ts:91` | PASS (2/2) | `evidence/test-reports/vitest-platform.json` | 4 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-14.repetitions | Selected nondeterministic cases are repeated at least five times per release. | `platform/src/evaluation/runner.ts`, `platform/src/evaluation/generate.ts` | 2: `platform/src/evaluation/corpus.test.ts:332`<br>`platform/src/evaluation/runner.test.ts:36` | PASS (2/2) | `evidence/test-reports/vitest-platform.json` | 1 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN |
| SPEC-14.edge-populations | Tests include long pauses, speech impairment, accented speech, hearing/relay use, interpr… | `scenarios/skeletons`, `scenarios/risk` | 2: `platform/src/evaluation/corpus.test.ts:340`<br>`platform/src/evaluation/generate.test.ts:52` | PASS (2/2) | `evidence/test-reports/vitest-platform.json` | 1 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN |
| SPEC-14.failure-injection | Vendor and business failures are tested: timeouts, stale knowledge, exhausted quotas, out… | `scenarios/fixtures/failures`, `platform/src/adapters/local`, `platform/src/evaluation/runner.ts` | 32: `platform/src/adapters/local/billing-fixture.test.ts:88` (as SPEC-14.faults)<br>`platform/src/adapters/local/faults.property.test.ts:8` (as SPEC-14.faults)<br>`platform/src/adapters/local/faults.property.test.ts:31` (as SPEC-14.faults) (+29 more) | PASS (32/32) | `evidence/test-reports/vitest-contract-docs-journey.json`, `evidence/test-reports/vitest-platform.json` | 10 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-14.policy-expansion | A policy update cannot silently expand access. | `policy/`, `platform/src/policy` | 21: `platform/src/policy/console.test.ts:42`<br>`platform/src/policy/golden-gate.test.ts:65`<br>`platform/src/policy/golden-gate.test.ts:76` (+18 more) | PASS (21/21) | `evidence/test-reports/vitest-platform.json` | 1 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN |
| SPEC-14.production-derived | Production-derived scenarios only after approved access, minimization and review; LLM jud… | `platform/src/evaluation/scorer.ts`, `platform/src/evaluation/runner.ts` | 1: `platform/src/evaluation/scorer.test.ts:83` | PASS (1/1) | `evidence/test-reports/vitest-platform.json` | 1 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN |
| SPEC-14.hard-gates | Safety, authorization, consent, transaction correctness, allowed data egress and audit ev… | `platform/src/evaluation/scorer.ts` | 17: `platform/src/evaluation/aggregate.test.ts:69`<br>`platform/src/evaluation/scorer.mutation.test.ts:192`<br>`platform/src/evaluation/scorer.mutation.test.ts:198` (+14 more) | PASS (17/17) | `evidence/test-reports/vitest-platform.json` | 5 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN |
| SPEC-14.goal-completion | Proposed at least 95 percent validated goal completion per launch-eligible routine intent… | `platform/src/evaluation/aggregate.ts` | — | NO_TEST | — | 2 | IMPLEMENTED | NOT_CONFIGURED | FAIL |
| SPEC-14.uncertainty | Zero failures in a finite set is not zero risk; report sample size, repetition, dependenc… | `platform/src/evaluation/stats.ts`, `platform/src/evaluation/aggregate.ts` | 3: `platform/src/evaluation/aggregate.test.ts:35`<br>`platform/src/evaluation/aggregate.test.ts:43`<br>`platform/src/evaluation/aggregate.test.ts:98` | PASS (3/3) | `evidence/test-reports/vitest-platform.json` | 4 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-14.scorecard | One append-only result record per run with run, scenario, split, audience, language, chan… | `platform/src/evaluation/results.ts`, `platform/src/evaluation/scorer.ts` | 6: `platform/src/evaluation/runner.test.ts:80`<br>`platform/src/evaluation/runner.test.ts:115`<br>`platform/src/evaluation/runner.test.ts:121` (+3 more) | PASS (6/6) | `evidence/test-reports/vitest-platform.json` | 8 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-14.aggregation | Aggregate by intent, language, audience, failure severity, version and regression; keep p… | `platform/src/evaluation/aggregate.ts` | 5: `platform/src/evaluation/aggregate.test.ts:57`<br>`platform/src/evaluation/aggregate.test.ts:69`<br>`platform/src/evaluation/aggregate.test.ts:83` (+2 more) | PASS (5/5) | `evidence/test-reports/vitest-platform.json` | 4 | MISSING | NOT_CONFIGURED | FAIL |
| SPEC-14.traceability | Every requirement maps to enforcement location, test ids, evidence and release status. | `docs/requirements/catalog.yaml`, `platform/src/evaluation/traceability.ts` | 8: `platform/src/evaluation/corpus.test.ts:408`<br>`platform/src/evaluation/traceability.test.ts:114`<br>`platform/src/evaluation/traceability.test.ts:124` (+5 more) | PASS (8/8) | `evidence/test-reports/vitest-platform.json` | 3 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN |
| SPEC-15.offline-slice | One representative journey from unverified caller through secure mock authentication, aut… | `platform/src/demo`, `platform/src/main` | 3: `platform/test/journeys/faults.test.ts:297`<br>`platform/test/journeys/j1-reschedule.test.ts:29` (as SPEC-15.phase-1)<br>`platform/test/journeys/j5-j7-j8-routing.test.ts:36` | PASS (3/3) | `evidence/test-reports/vitest-contract-docs-journey.json` | 4 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-15.pilot-promotion | Staged exposure (for example 1, 5, 10, 25, 50 percent) only with reviewed evidence and na… | `docs/release/phase-gates.md`, `platform/src/ops` | — | NO_TEST | — | 7 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-15.rollback | Rehearsed rollback to a known-good orchestration, tool catalogue, policy and compatible s… | `platform/src/workflows`, `platform/src/evaluation/manifest.ts` | 6: `platform/src/workflows/definitions.test.ts:312` (as SPEC-15.phase5)<br>`platform/src/workflows/definitions.test.ts:332` (as SPEC-15.phase5)<br>`platform/src/workflows/engine.test.ts:268` (as SPEC-15.phase5) (+3 more) | PASS (6/6) | `evidence/test-reports/vitest-platform.json` | 15 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-15.no-self-promotion | No autonomous self-promotion, unreviewed production learning or automatic retraining from… | `platform/src/memory`, `platform/src/evaluation/manifest.ts` | — | NO_TEST | — | 7 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-16.offline-first | Begin offline with synthetic data; no spend, calls, real notifications, new credentials,… | `platform/src/config/guard.ts`, `platform/src/fixtures/synthetic-world.ts` | 1: `platform/src/evaluation/corpus.test.ts:390` | PASS (1/1) | `evidence/test-reports/vitest-platform.json` | 6 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-16.integration-records | Every integration records method, endpoint, version, auth mechanism, schema, rate limit,… | `platform/src/adapters/integration-inventory.ts`, `docs/vendor-integration-inventory.md` | 3: `platform/src/adapters/integration-inventory.test.ts:22` (as SPEC-16.inventory)<br>`platform/src/adapters/integration-inventory.test.ts:59` (as SPEC-16.inventory)<br>`platform/src/adapters/integration-inventory.test.ts:96` (as SPEC-16.inventory) | PASS (3/3) | `evidence/test-reports/vitest-platform.json` | 12 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-16.prod-guard | Production configuration rejects fixture adapters, missing credentials, unapproved models… | `platform/src/config/guard.ts`, `platform/src/config/schema.ts` | 5: `platform/src/config/loader.test.ts:14` (as SPEC-16.config)<br>`platform/src/config/loader.test.ts:58` (as SPEC-16.config)<br>`platform/src/config/loader.test.ts:96` (as SPEC-16.config) (+2 more) | PASS (5/5) | `evidence/test-reports/vitest-platform.json` | 10 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-16.phi-endpoints-disabled | Production PHI endpoints remain disabled until prerequisites are evidenced. | `platform/src/config/guard.ts` | 1: `platform/src/config/guard.test.ts:364` (as SPEC-16.phi) | PASS (1/1) | `evidence/test-reports/vitest-platform.json` | 2 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-16.local-demo | Local start command, test commands, synthetic credentials only and a documented end-to-en… | `platform/src/demo`, `platform/src/main` | 3: `platform/src/adapters/registry.test.ts:51` (as SPEC-16.badge)<br>`platform/src/main/container.test.ts:126` (as SPEC-16.local-badge)<br>`platform/src/main/entrypoints.test.ts:42` (as SPEC-16.local-badge) | PASS (3/3) | `evidence/test-reports/vitest-platform.json` | 3 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-16.openapi | Produce OpenAPI and JSON Schemas: the committed gateway OpenAPI document matches the regi… | `platform/src/gateway/openapi.ts`, `platform/src/gateway/generate-openapi.ts`, `schemas/openapi` | 2: `platform/src/gateway/openapi.test.ts:37` (as SPEC-8.openapi)<br>`platform/src/gateway/openapi.test.ts:58` (as SPEC-8.openapi) | PASS (2/2) | `evidence/test-reports/vitest-platform.json` | 1 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN |
| SPEC-16.protocol-artifacts | AuthContext, ToolRequest, ToolResult, PreparedAction, CommitReceipt, SupportRequest, Hand… | `platform/src/protocol`, `schemas/protocol` | 3: `platform/src/protocol/registry.test.ts:67`<br>`platform/src/protocol/registry.test.ts:76`<br>`platform/src/protocol/registry.test.ts:81` | PASS (3/3) | `evidence/test-reports/vitest-platform.json` | 3 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN |
| SPEC-16.scenario-definition | ScenarioDefinition carries version, audience, locale, initial state, permitted records, s… | `platform/src/protocol/evaluation.ts`, `platform/src/evaluation/generate.ts`, `scenarios/fixtures/failures` | 7: `platform/src/evaluation/corpus.test.ts:26`<br>`platform/src/evaluation/corpus.test.ts:248`<br>`platform/src/evaluation/corpus.test.ts:363` (+4 more) | PASS (7/7) | `evidence/test-reports/vitest-platform.json` | 4 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-16.release-manifest | ReleaseManifest binds source commit, build/image digest, infrastructure plan, schema vers… | `platform/src/evaluation/manifest.ts`, `platform/src/config/approvals.ts` | 3: `platform/src/evaluation/manifest.test.ts:52`<br>`platform/src/evaluation/manifest.test.ts:83`<br>`platform/src/evaluation/manifest.test.ts:135` | PASS (3/3) | `evidence/test-reports/vitest-platform.json` | 11 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-16.journeys | Demonstrate the nine journeys (verified reschedule with conflict, disputed charge to dura… | `scenarios/journeys`, `platform/src/demo` | 17: `platform/src/adapters/local/billing-fixture.test.ts:101` (as SPEC-16.journey)<br>`platform/src/adapters/local/scheduling-fixture.test.ts:56` (as SPEC-16.journey)<br>`platform/src/adapters/local/scheduling-fixture.test.ts:66` (as SPEC-16.journey) (+14 more) | PASS (17/17) | `evidence/test-reports/vitest-platform.json` | 2 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-16.fault-injection | Inject authentication expiry, two concurrent calls for one account, an interrupted confir… | `scenarios/fixtures/failures`, `scenarios/journeys/faulted`, `platform/src/evaluation/scorer.ts` | 9: `platform/src/evaluation/corpus.test.ts:281`<br>`platform/src/evaluation/corpus.test.ts:464`<br>`platform/src/evaluation/corpus.test.ts:584` (+6 more) | PASS (9/9) | `evidence/test-reports/vitest-contract-docs-journey.json`, `evidence/test-reports/vitest-platform.json` | 1 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN |
| SPEC-16.journey-1 | Demonstrate a verified client rescheduling an appointment with conflict handling, showing… | `platform/src/business`, `platform/src/actions`, `scenarios/journeys` | 8: `platform/src/business/appointments.test.ts:37` (as SPEC-16.reschedule)<br>`platform/src/business/appointments.test.ts:52` (as SPEC-16.reschedule)<br>`platform/src/business/appointments.test.ts:76` (as SPEC-16.reschedule) (+5 more) | PASS (8/8) | `evidence/test-reports/vitest-contract-docs-journey.json`, `evidence/test-reports/vitest-platform.json` | 1 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-16.journey-2 | Demonstrate a disputed charge routed into a durable review without promising a refund, sh… | `platform/src/business`, `platform/src/workflows`, `scenarios/journeys` | 4: `platform/src/business/billing.test.ts:91` (as SPEC-16.billing-dispute)<br>`platform/test/journeys/j2-billing-dispute.test.ts:80`<br>`platform/test/journeys/j2-billing-dispute.test.ts:81` (+1 more) | PASS (4/4) | `evidence/test-reports/vitest-contract-docs-journey.json`, `evidence/test-reports/vitest-platform.json` | 1 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-16.journey-3 | Demonstrate a provider checking a delegated practice's remittance, showing both caller-vi… | `policy/`, `platform/src/business`, `scenarios/journeys` | 4: `platform/test/journeys/j3-j4-authorization.test.ts:23`<br>`platform/test/journeys/j3-j4-authorization.test.ts:24`<br>`platform/test/journeys/j3-j4-authorization.test.ts:56` (+1 more) | PASS (4/4) | `evidence/test-reports/vitest-contract-docs-journey.json` | 1 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-16.journey-4 | Demonstrate a partner denied access to an unrelated client, showing both caller-visible b… | `policy/`, `platform/src/business`, `scenarios/journeys` | 2: `platform/test/journeys/j3-j4-authorization.test.ts:82`<br>`platform/test/journeys/j3-j4-authorization.test.ts:83` | PASS (2/2) | `evidence/test-reports/vitest-contract-docs-journey.json` | 1 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-16.journey-5 | Demonstrate an unverified caller requesting a human, showing both caller-visible behaviou… | `platform/src/gateway`, `platform/src/workflows/transfer.ts`, `scenarios/journeys` | 4: `platform/test/journeys/j5-j7-j8-routing.test.ts:35`<br>`platform/test/journeys/j5-j7-j8-routing.test.ts:36`<br>`platform/test/journeys/j5-j7-j8-routing.test.ts:80` (+1 more) | PASS (4/4) | `evidence/test-reports/vitest-contract-docs-journey.json` | 1 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-16.journey-6 | Demonstrate a clinician-approved safety handoff without authentication, showing both call… | `platform/src/safety`, `platform/src/workflows/transfer.ts`, `scenarios/journeys` | 3: `platform/test/journeys/j6-safety-handoff.test.ts:30`<br>`platform/test/journeys/j6-safety-handoff.test.ts:31`<br>`platform/test/journeys/j6-safety-handoff.test.ts:107` | PASS (3/3) | `evidence/test-reports/vitest-contract-docs-journey.json` | 2 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-16.journey-7 | Demonstrate a caller declining recording, showing both caller-visible behaviour and backe… | `platform/src/privacy/consent.ts`, `talkdesk/studio-flow-spec.md`, `scenarios/journeys` | 2: `platform/test/journeys/j5-j7-j8-routing.test.ts:128`<br>`platform/test/journeys/j5-j7-j8-routing.test.ts:129` | PASS (2/2) | `evidence/test-reports/vitest-contract-docs-journey.json` | 1 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-16.journey-8 | Demonstrate an unavailable language routed to an interpreter, showing both caller-visible… | `platform/src/business`, `platform/src/config`, `scenarios/journeys` | 2: `platform/test/journeys/j5-j7-j8-routing.test.ts:166`<br>`platform/test/journeys/j5-j7-j8-routing.test.ts:167` | PASS (2/2) | `evidence/test-reports/vitest-contract-docs-journey.json` | 2 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-16.journey-9 | Demonstrate a repeat caller resuming an authorized open issue, showing both caller-visibl… | `platform/src/memory`, `platform/src/business`, `scenarios/journeys` | 2: `platform/test/journeys/j9-repeat-caller.test.ts:25`<br>`platform/test/journeys/j9-repeat-caller.test.ts:26` | PASS (2/2) | `evidence/test-reports/vitest-contract-docs-journey.json` | 2 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-16.fault-auth-expiry | Inject authentication expiry and verify the final system state, not just the conversation… | `platform/src/identity`, `platform/src/gateway`, `scenarios/journeys/faulted` | 1: `platform/test/journeys/faults.test.ts:52` | PASS (1/1) | `evidence/test-reports/vitest-contract-docs-journey.json` | 3 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-16.fault-concurrent-calls | Inject two concurrent calls for the same account and verify the final system state, not j… | `platform/src/actions`, `scenarios/journeys/faulted` | 1: `platform/test/journeys/faults.test.ts:81` | PASS (1/1) | `evidence/test-reports/vitest-contract-docs-journey.json` | 2 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-16.fault-interrupted-confirmation | Inject an interrupted confirmation and verify the final system state, not just the conver… | `platform/src/actions`, `platform/src/voice`, `scenarios/journeys/faulted` | 1: `platform/test/journeys/faults.test.ts:117` | PASS (1/1) | `evidence/test-reports/vitest-contract-docs-journey.json` | 1 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN |
| SPEC-16.fault-duplicate-webhooks | Inject duplicate webhooks and verify the final system state, not just the conversation te… | `platform/src/gateway/http`, `platform/src/workflows/transfer.ts`, `scenarios/journeys/faulted` | 1: `platform/test/journeys/faults.test.ts:143` | PASS (1/1) | `evidence/test-reports/vitest-contract-docs-journey.json` | 1 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN |
| SPEC-16.fault-crash-after-commit | Inject a crash after commit and verify the final system state, not just the conversation… | `platform/src/actions`, `platform/src/worker`, `scenarios/journeys/faulted` | 2: `platform/src/evaluation/fault-reach.test.ts:112`<br>`platform/test/journeys/faults.test.ts:247` | PASS (2/2) | `evidence/test-reports/vitest-contract-docs-journey.json`, `evidence/test-reports/vitest-platform.json` | 3 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-16.fault-salesforce-outage | Inject a Salesforce outage and verify the final system state, not just the conversation t… | `platform/src/business`, `platform/src/outbox`, `platform/src/worker`, `scenarios/journeys/faulted` | 2: `platform/test/journeys/faults.test.ts:297`<br>`platform/test/journeys/faults.test.ts:341` | PASS (2/2) | `evidence/test-reports/vitest-contract-docs-journey.json` | 2 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-16.fault-failed-transfer | Inject a failed transfer and verify the final system state, not just the conversation tex… | `platform/src/workflows/transfer.ts`, `scenarios/journeys/faulted` | 1: `platform/test/journeys/faults.test.ts:356` | PASS (1/1) | `evidence/test-reports/vitest-contract-docs-journey.json` | 1 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN |
| SPEC-16.fault-audit-outage | Inject an audit outage and verify the final system state, not just the conversation text. | `platform/src/audit`, `platform/src/actions`, `scenarios/journeys/faulted` | 3: `platform/src/main/server.test.ts:119`<br>`platform/src/worker/deferred-audit.test.ts:40`<br>`platform/test/journeys/faults.test.ts:389` | PASS (3/3) | `evidence/test-reports/vitest-contract-docs-journey.json`, `evidence/test-reports/vitest-platform.json` | 2 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-16.console-functional | The operations console is functional, access-controlled and accessible, audits administra… | `console/`, `platform/src/console-api` | 33: `console/src/api/client.test.ts:28` (as SPEC-16.console-token)<br>`console/src/api/client.test.ts:42` (as SPEC-16.console-token)<br>`console/src/api/client.test.ts:58` (as SPEC-16.console-errors) (+30 more) | PASS (33/33) | `evidence/test-reports/vitest-console.json`, `evidence/test-reports/vitest-platform.json` | 5 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-16.decisions | Material decisions are recorded (architecture decision records). | `docs/DECISIONS.md`, `docs/adr` | 3: `platform/test/docs/docs-pack.test.ts:132`<br>`platform/test/docs/docs-pack.test.ts:138`<br>`platform/test/docs/docs-pack.test.ts:150` | PASS (3/3) | `evidence/test-reports/vitest-contract-docs-journey.json` | 2 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-16.progress-handoff | IMPLEMENTATION_STATUS, PREREQUISITES, DECISIONS, REQUIREMENTS_TRACEABILITY, TEST_EVIDENCE… | `docs` | 5: `platform/test/docs/docs-pack.test.ts:48` (as SPEC-16.handoff)<br>`platform/test/docs/docs-pack.test.ts:69` (as SPEC-16.handoff)<br>`platform/test/docs/docs-pack.test.ts:91` (as SPEC-16.handoff) (+2 more) | PASS (5/5) | `evidence/test-reports/vitest-contract-docs-journey.json` | 6 | MISSING | NOT_CONFIGURED | NOT_RUN |
| SPEC-16.status-vocabulary | Distinguish IMPLEMENTED_OFFLINE, VERIFIED_SANDBOX, APPROVED_PILOT and VERIFIED_PRODUCTION… | `platform/src/protocol/release.ts`, `platform/src/evaluation/manifest.ts`, `platform/src/evaluation/traceability.ts`, `platform/src/adapters/integration-inventory.ts` | 3: `platform/src/adapters/integration-inventory.test.ts:46`<br>`platform/src/evaluation/manifest.test.ts:95`<br>`platform/src/evaluation/manifest.test.ts:162` | PASS (3/3) | `evidence/test-reports/vitest-platform.json` | 3 | MISSING | NOT_CONFIGURED | NOT_RUN |

## Gaps (catalogue requirements with no tagged test)

- SPEC-2.auth-gate-values
- SPEC-2.version-proof
- SPEC-2.model-evidence
- SPEC-3.independent-human-route
- SPEC-3.vendor-capability-gate
- SPEC-3.ingress
- SPEC-4.resolution-contracts
- SPEC-7.assurance-tiers
- SPEC-10.no-clinical-advice
- SPEC-10.no-auto-external-crisis
- SPEC-10.transfer-failure
- SPEC-11.voice-selection
- SPEC-11.endpointing
- SPEC-14.supply-chain
- SPEC-14.pentest
- SPEC-14.test-layers
- SPEC-14.goal-completion
- SPEC-15.pilot-promotion
- SPEC-15.no-self-promotion

## Unknown tags (used in tests, in neither the catalogue nor the follow-on requirements)

- `ACT-F1` — 9 test(s), e.g. `platform/src/actions/action-service.invalidation.test.ts:74`
- `ACT-F2` — 11 test(s), e.g. `platform/src/business/transactions.test.ts:198`
- `ACT-F3` — 13 test(s), e.g. `platform/src/actions/action-service.invalidation.test.ts:130`
- `ACT-F4` — 5 test(s), e.g. `platform/src/business/transactions.test.ts:115`
- `ACT-F5` — 6 test(s), e.g. `platform/src/business/transactions.test.ts:68`
- `AUTH-ENUM-01` — 19 test(s), e.g. `platform/src/gateway/http/routes.test.ts:189`
- `AUTH-OTP-LIMIT-01` — 8 test(s), e.g. `platform/src/gateway/mcp.test.ts:279`
- `DP-01` — 4 test(s), e.g. `platform/src/business/handoff.test.ts:208`
- `DP-02` — 6 test(s), e.g. `platform/src/actions/tool-idempotency.test.ts:151`
- `DP-03` — 5 test(s), e.g. `platform/src/business/transactions.test.ts:214`
- `FO-04-20..24` — 1 test(s), e.g. `platform/src/protocol/contracts.test.ts:256`
- `FO-04-25..29` — 1 test(s), e.g. `platform/src/protocol/contracts.test.ts:367`
- `OPS-APPR-01` — 8 test(s), e.g. `platform/src/config/approvals.test.ts:127`
- `OPS-AUD-01` — 10 test(s), e.g. `platform/src/audit/monitor.test.ts:59`
- `OPS-AUD-02` — 4 test(s), e.g. `platform/src/audit/sinks/s3-iam-model.test.ts:109`
- `OPS-KS-01` — 19 test(s), e.g. `platform/src/gateway/http/routes.test.ts:189`
- `OPS-KS-02` — 4 test(s), e.g. `platform/src/ops/integration-gate.test.ts:37`
- `SAFE-HANDOFF-01` — 6 test(s), e.g. `platform/src/business/handoff.test.ts:327`
- `SAFE-HANDOFF-02` — 16 test(s), e.g. `platform/src/business/handoff.test.ts:238`
- `SAFE-HANDOFF-03` — 3 test(s), e.g. `platform/src/gateway/http/routes.test.ts:448`
- `SAFE-HANDOFF-05` — 4 test(s), e.g. `platform/src/business/handoff.test.ts:297`
- `SAFE-HANDOFF-07` — 2 test(s), e.g. `platform/src/business/handoff.test.ts:275`
- `SPEC-14.SIM_SWAP` — 2 test(s), e.g. `platform/src/identity/verification-service.test.ts:507`
- `SPEC-14.policy-failure` — 1 test(s), e.g. `platform/src/gateway/pipeline.test.ts:223`
- `SPEC-15.worker` — 7 test(s), e.g. `platform/src/worker/worker.test.ts:66`
- `SPEC-7.STEP_UP` — 5 test(s), e.g. `platform/src/identity/verification-service.test.ts:783`
- `SPEC-8.tool-pipeline` — 6 test(s), e.g. `platform/src/gateway/http/routes.test.ts:96`
- `TB-01` — 2 test(s), e.g. `platform/src/gateway/pipeline.test.ts:451`
- `TB-07` — 2 test(s), e.g. `platform/src/gateway/http/webhook-routes.test.ts:93`
- `TB-09` — 5 test(s), e.g. `platform/src/gateway/http/routes.test.ts:403`
- `VSP-GW-01` — 4 test(s), e.g. `platform/src/gateway/http/routes.test.ts:448`
- `VSP-GW-03` — 3 test(s), e.g. `platform/src/gateway/mcp.test.ts:207`
- `VSP-GW-04` — 7 test(s), e.g. `platform/src/gateway/pipeline.transactions.test.ts:184`
- `VSP-KN-01` — 58 test(s), e.g. `platform/src/knowledge/host-literals.test.ts:37`
- `VSP-KN-02` — 16 test(s), e.g. `platform/src/knowledge/host-literals.test.ts:225`
- `WP-02` — 13 test(s), e.g. `platform/src/protocol/contracts.test.ts:582`
- `WP-03` — 2 test(s), e.g. `platform/test/integration/_harness/deps.test.ts:53`

## Failing tests

None recorded.

## Externally blocked catalogue requirements

| Requirement | Reason | Prerequisites |
|---|---|---|
| AUTH-01 | Real IdP account linking and registered-channel data | PRQ-005, PRQ-030 |
| AUTH-03 | Vendor session binding outside model-controlled arguments (TB-01) | PRQ-013 |
| AUTH-05 | Authoritative enrollment and delegation registries | PRQ-005, PRQ-007 |
| AUTH-06 | Isolated DTMF capture must be proven on the vendor path (TB-03) | PRQ-015 |
| AUTH-07 | Auth Gate behaviour in a tenant sandbox (TB-06) | PRQ-018 |
| DATA-01 | BAA coverage and approved observability export | PRQ-002, PRQ-047 |
| DATA-02 | Reviewed data-flow inventory covering vendor audio paths | PRQ-003 |
| DATA-03 | Approved consent wording and retention schedule | PRQ-025, PRQ-026 |
| ACT-01 | Deterministic confirmation capture on the vendor path (TB-02) | PRQ-014 |
| ACT-02 | Provider idempotency semantics for real business systems | PRQ-007 |
| ACT-03 | Authoritative lookup-by-key in real business systems | PRQ-007 |
| ACT-05 | Before-speech validation on the vendor path (TB-04) | PRQ-016 |
| SAFE-01 | Clinician-approved boundary scripts and human-reviewed clinical corpus | PRQ-008, PRQ-028, PRQ-012 |
| SAFE-02 | Early safety signal and deterministic handoff on the vendor path (TB-05) | PRQ-017 |
| SAFE-03 | Guardrail exit behaviour in a tenant sandbox (TB-05) | PRQ-017 |
| SAFE-04 | Transfer event export from the vendor (TB-07) | PRQ-019 |
| OPS-01 | Separately administered audit account with Object Lock | PRQ-037, PRQ-040 |
| OPS-02 | Staffed capacity, quotas and continuity arrangement | PRQ-009, PRQ-022, PRQ-049 |
| OPS-04 | Trusted approval signing key | PRQ-023 |
| OPS-05 | Approved budgets and signed approval records | PRQ-010, PRQ-024 |
| OPS-06 | Vendor version identity, pinned CI actions and base image | PRQ-020, PRQ-041, PRQ-042 |
| SPEC-2.auth-gate-values | Tenant Auth Gate behaviour (TB-06) | PRQ-018 |
| SPEC-2.version-proof | Version identity in vendor exports (TB-08) | PRQ-020 |
| SPEC-2.guardrail-exit | Guardrail exit behaviour in a tenant sandbox (TB-05) | PRQ-017 |
| SPEC-2.model-evidence | Model/voice selection evidence | PRQ-045 |
| SPEC-3.independent-human-route | Tenant sandbox and staffed queues | PRQ-004, PRQ-009 |
| SPEC-3.workflow-engine | AWS sandbox account | PRQ-037 |
| SPEC-3.vendor-capability-gate | Vendor capability evidence TB-01..TB-10 | PRQ-013, PRQ-014, PRQ-015, PRQ-016, PRQ-017, PRQ-018, PRQ-019, PRQ-022 |
| SPEC-3.ingress | AWS accounts and deployed infrastructure | PRQ-037 |
| SPEC-4.resolution-contracts | Approved contracts from business owners | PRQ-033 |
| SPEC-4.workflow-catalogue | Business-system APIs | PRQ-007 |
| SPEC-4.audience-permissions | Authoritative registries | PRQ-005 |
| SPEC-4.payments-isolated | Approved hosted payment page | PRQ-050 |
| SPEC-6.data-classes | Retention schedule from counsel | PRQ-025 |
| SPEC-6.consent-before-recording | Jurisdiction-approved disclosure and alternative | PRQ-026 |
| SPEC-6.case-minimization | Salesforce sandbox and Case schema | PRQ-006 |
| SPEC-7.assurance-tiers | Identity risk assessment for A1 scope | PRQ-030 |
| SPEC-7.secure-link-binding | Non-production IdP tenants | PRQ-036 |
| SPEC-7.otp-limits | Security-approved values and isolated DTMF (TB-03) | PRQ-029, PRQ-015 |
| SPEC-7.assertions | KMS signing keys | PRQ-037 |
| SPEC-7.workforce-separation | Workforce IdP tenant | PRQ-036 |
| SPEC-8.webhook-auth | Documented vendor webhook authentication (TB-09) | PRQ-021 |
| SPEC-8.service-identities | Integration credentials and exception approval | PRQ-037, PRQ-052 |
| SPEC-8.outbox | AWS SQS in a sandbox account | PRQ-037 |
| SPEC-8.timeout-states | Provider idempotency and lookup semantics | PRQ-007 |
| SPEC-8.salesforce-model | Salesforce sandbox | PRQ-006, PRQ-035 |
| SPEC-9.workflow | Step Functions in a sandbox account | PRQ-037 |
| SPEC-9.notifications | Notification provider contract | PRQ-048 |
| SPEC-9.knowledge-ingestion | Approved corpus snapshot | PRQ-032 |
| SPEC-10.no-clinical-advice | Clinician-approved boundary templates and reviewed corpus | PRQ-028, PRQ-012 |
| SPEC-10.safety-signals | Early safety signal on the vendor path (TB-05) | PRQ-017 |
| SPEC-10.signal-test-coverage | Human-reviewed safety corpus and clinical review | PRQ-012, PRQ-008 |
| SPEC-10.safety-response | Clinician-approved scripts | PRQ-008, PRQ-028 |
| SPEC-10.no-auto-external-crisis | Operational agreements owned by the clinical safety lead | PRQ-008 |
| SPEC-10.transfer | Vendor transfer events (TB-07) | PRQ-019 |
| SPEC-10.transfer-failure | Transfer drills on the telephone path | PRQ-019, PRQ-043 |
| SPEC-10.safety-latency | Measurement on the real telephone path | PRQ-043 |
| SPEC-11.opening-disclosure | Approved disclosure wording | PRQ-026, PRQ-028 |
| SPEC-11.voice-selection | Listening tests and model/voice approval | PRQ-045 |
| SPEC-11.barge-in | Barge-in measurement on the telephone path | PRQ-043 |
| SPEC-11.endpointing | Consented voice fixtures and PSTN tests | PRQ-012, PRQ-043 |
| SPEC-11.interpreter | Interpreter queues | PRQ-009 |
| SPEC-11.response-gate | Before-speech validation on the vendor path (TB-04) | PRQ-016 |
| SPEC-12.capacity-model | Traffic statistics | PRQ-046 |
| SPEC-12.quotas | Written vendor quotas (TB-10) | PRQ-022 |
| SPEC-12.load-test | Billable load against the vendor path | PRQ-022, PRQ-010 |
| SPEC-12.budget-cutoff | Approved budgets and rate cards | PRQ-010 |
| SPEC-12.recovery | Regions, accounts and drills | PRQ-039, PRQ-011 |
| SPEC-13.dashboards | Approved metrics export and on-call | PRQ-011, PRQ-047 |
| SPEC-13.audit-integrity | Audit account with Object Lock | PRQ-037, PRQ-040 |
| SPEC-13.console | Workforce SSO | PRQ-036 |
| SPEC-13.incident-playbooks | On-call roster and drills | PRQ-011 |
| SPEC-14.threat-model | Security and privacy review | PRQ-003 |
| SPEC-14.supply-chain | Pinned CI actions and base image | PRQ-041, PRQ-042 |
| SPEC-14.pentest | Independent assessment | PRQ-051 |
| SPEC-14.test-layers | PSTN test budget, numbers and plan | PRQ-043 |
| SPEC-14.intent-corpus | Human review of the corpus by QA and language leads | PRQ-012 |
| SPEC-14.risk-corpus | Human review (drafts only exist) | PRQ-012, PRQ-008 |
| SPEC-14.edge-populations | Consented voice fixtures and reviewers | PRQ-012 |
| SPEC-14.production-derived | Approved evaluation environment | PRQ-003 |
| SPEC-14.goal-completion | Human listening tests and reviewers | PRQ-012, PRQ-045 |
| SPEC-14.aggregation | Production-frequency weights need traffic statistics | PRQ-046 |
| SPEC-15.pilot-promotion | Pilot approvals | PRQ-024 |
| SPEC-15.rollback | Rollback drills | PRQ-011 |
| SPEC-16.prod-guard | Trusted approval key | PRQ-023 |
| SPEC-16.phi-endpoints-disabled | PHI processing approval | PRQ-002, PRQ-024 |
| SPEC-16.release-manifest | Manifest signing key and human approvals | PRQ-023, PRQ-024 |
| SPEC-16.journeys | Telephone-path demonstration | PRQ-043 |
| SPEC-16.journey-1 | Telephone-path demonstration | PRQ-043 |
| SPEC-16.journey-2 | Telephone-path demonstration | PRQ-043 |
| SPEC-16.journey-3 | Telephone-path demonstration; authoritative delegation registries | PRQ-043, PRQ-005 |
| SPEC-16.journey-4 | Telephone-path demonstration; authoritative enrollment registries | PRQ-043, PRQ-005 |
| SPEC-16.journey-5 | Telephone-path demonstration; vendor transfer events (TB-07) | PRQ-043, PRQ-019 |
| SPEC-16.journey-6 | Telephone-path demonstration; clinician-approved scripts | PRQ-043, PRQ-008, PRQ-028 |
| SPEC-16.journey-7 | Telephone-path demonstration; approved disclosure and alternative wording | PRQ-043, PRQ-026 |
| SPEC-16.journey-8 | Telephone-path demonstration; staffed interpreter paths | PRQ-043, PRQ-009 |
| SPEC-16.journey-9 | Telephone-path demonstration | PRQ-043 |
| SPEC-16.console-functional | Workforce SSO | PRQ-036 |

## Follow-on requirements

| Requirement | Kind | Text (short) | Original ids | Capabilities | Package | Software | Environment | Qualification | Tagged tests |
|---|---|---|---|---|---|---|---|---|---|
| FO-00-01 | software | Upgrade the existing repository into a complete, configurable, deployable produ… | SPEC-16.offline-first, SPEC-15.offline-slice | platform.invariants | WP-43 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-00-02 | software | Hold natural, responsive telephone conversations. | SPEC-11.barge-in, SPEC-11.endpointing | voice.cascade | WP-17 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-00-03 | software | Achieve verified administrative support outcomes for clients, providers and aut… | SPEC-4.outcomes, SPEC-4.resolution-contracts | actions.effects | WP-25 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-00-04 | software | Handle investigation during calls (deeper backend work while the conversation c… | — | conversation.harness | WP-10 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-00-05 | software | Handle multiple issues per call. | SPEC-8.salesforce-model | workflows.families | WP-30 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-00-06 | software | Handle repeat contact. | SPEC-16.journey-9, SPEC-9.memory | context.assembly | WP-24 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-00-07 | software | Handle work lasting days or months (long-horizon orchestration). | SPEC-9.workflow, SPEC-3.workflow-engine | workflows.durable | WP-26 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-00-08 | constraint | A ticket is not a resolution. | ACT-04, SPEC-11.ack-not-resolution | evaluation.test_truth | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-00-09 | software | Personalize by combining permitted historical context with recent events and fr… | — | context.store | WP-18 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-00-10 | software | The operator connects existing systems through documented configuration without… | — | operator.onboarding | WP-32 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-00-11 | software | The operator supplies operational policies and credentials, qualifies the deplo… | SPEC-15.pilot-promotion | activation.qualification | WP-45 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-00-12 | software | Publicly observable Sierra breadth: fast conversation plus deeper reasoning. | — | conversation.harness | WP-10 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-00-13 | software | Sierra breadth: controlled actions. | SPEC-8.prepare-commit, ACT-01, ACT-02, ACT-03 | domain.business_systems | WP-23 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-00-14 | software | Sierra breadth: durable memory. | SPEC-9.memory | context.store | WP-18 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-00-15 | software | Sierra breadth: agent configuration (operator studio). | — | operator.studio | WP-33 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-00-16 | evaluation | Sierra breadth: simulation. | SPEC-14.intent-corpus, SPEC-14.risk-corpus | evaluation.drivers | WP-34 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-00-17 | software | Sierra breadth: monitors. | SPEC-13.dashboards, SPEC-13.slo-definitions | evaluation.monitors | WP-35 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-00-18 | software | Sierra breadth: investigation by operators. | SPEC-13.console | operator.console | WP-38 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-00-19 | software | Sierra breadth: controlled improvement. | SPEC-15.no-self-promotion | improvement.pipeline | WP-36 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-00-20 | software | Differentiator: portable deployment, measurable. | — | deploy.infrastructure | WP-39 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-00-21 | software | Differentiator: explicit authority and effect receipts. | OPS-01 | actions.effects | WP-25 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-00-22 | software | Differentiator: inspectable context freshness. | — | context.assembly | WP-24 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-00-23 | software | Differentiator: independently verifiable outcomes. | OPS-01, SPEC-13.audit-integrity | actions.effects | WP-25 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-00-24 | constraint | Do not claim to reproduce Sierra's private implementation or outperform it with… | — | governance.documents | WP-44 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-00-25 | software | When information is missing, create typed configuration, validation, emulators,… | — | operator.onboarding | WP-32 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-00-26 | constraint | Missing credentials are not a reason to leave a live adapter NotImplemented or… | OPS-03, SPEC-16.integration-records | platform.composition | WP-07 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-00-27 | constraint | Engineering autonomy never grants permission to access patient data, spend mone… | OPS-05, SPEC-5.prerequisite-register | activation.qualification | WP-45 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-00-28 | document | Record all missing external inputs in one activation register and continue buil… | SPEC-5.prerequisite-register | activation.qualification | WP-45 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-00-29 | document | Use two independent status axes per capability (Software: MISSING/IMPLEMENTED/V… | SPEC-16.status-vocabulary, OPS-03 | evaluation.test_truth | WP-01 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | 5 (PASS) |
| FO-00-30 | constraint | A missing BAA is not missing code and an adapter stub is not a missing BAA; nev… | OPS-03 | platform.composition | WP-07 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-00-31 | constraint | 'Battle hardened' requires executed evidence, not file or scenario counts. | OPS-03 | governance.documents | WP-44 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-00-32 | constraint | Administrative support platform, not an AI therapist: no clinical treatment, di… | SAFE-01, SPEC-10.no-clinical-advice | conversation.harness, safety.routing | WP-10 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-00-33 | constraint | Support every request with a verified supported resolution or an accountable es… | SPEC-4.outcomes, SPEC-10.transfer | workflows.families | WP-30 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-00-34 | software | Precedence: build the controllable speech runtime and bounded agent harness now… | SPEC-3.vendor-capability-gate | voice.media_runtime | WP-11 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-00-35 | constraint | Keep the existing AWS control plane and transaction invariants. | ACT-01, ACT-02, ACT-03, OPS-01 | platform.invariants | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-00-36 | operations | The earlier offline phase becomes a regression environment, not the delivery en… | SPEC-15.offline-slice | platform.composition | WP-07 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-00-37 | document | The 27 invariant IDs retain their meaning; other changes are identified in sect… | AUTH-01, AUTH-02, AUTH-03, AUTH-04, AUTH-05, AUTH-06, AUTH-07, DATA-01, DATA-02, DATA-03, DATA-04, ACT-01, ACT-02, ACT-03, ACT-04, ACT-05, SAFE-01, SAFE-02, SAFE-03, SAFE-04, SAFE-05, OPS-01, OPS-02, OPS-03, OPS-04, OPS-05, OPS-06 | evaluation.test_truth | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | 5 (PASS) |
| FO-00-38 | operations | Use maintained dependencies and ordinary local tooling: no unmaintained or end-… | SPEC-14.supply-chain, OPS-06 | release.supply_chain | WP-40 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-00-39 | evaluation | Make the differentiators measurable: portable deployment, explicit authority an… | — | evaluation.drivers | WP-34 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-01-01 | operations | Reinspect the actual working tree and branch before changing it; the reviewed-c… | — | governance.documents | WP-44 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-01-02 | software | Baseline bullet 1: TypeScript/Fastify control plane, thin MCP interface, OPA WA… | SPEC-8.tool-surface, SPEC-8.ledger, SPEC-8.outbox, SPEC-13.console | platform.composition | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-01-03 | software | Baseline bullet 2a: local composition uses PGlite, memory sessions, synthetic i… | OPS-04, SPEC-16.prod-guard | platform.composition | WP-07 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-01-04 | software | Baseline bullet 2b: no real conversational LLM powers the local driver. | — | conversation.harness | WP-10 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-01-05 | software | Baseline bullet 2c: the speech queue and turn tracker are local fixtures. | ACT-05, SPEC-11.barge-in | voice.release_boundary | WP-14 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-01-06 | software | Baseline bullet 3: recount the eighteen tools and seven workflow definitions; a… | SPEC-8.tool-surface, SPEC-4.workflow-catalogue | governance.documents | WP-44 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-01-07 | evaluation | Baseline bullet 4: the committed corpus (2,711 runs: 2,386 PASS, 305 FAIL, 20 I… | OPS-03, SPEC-14.aggregation | evaluation.test_truth | WP-01 | IMPLEMENTED | NOT_CONFIGURED | FAIL | — |
| FO-01-08 | environment | Baseline bullet 5a: AWS infrastructure is plan-only. | SPEC-3.ingress, SPEC-15.rollback | operations.commands | WP-41 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-01-09 | software | Baseline bullet 5b: workforce SSO needs completion. | SPEC-7.workforce-separation | identity.workforce | WP-05 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-01-10 | software | Baseline bullet 5c: actual call takeover (a human taking over a live AI call) n… | SAFE-04, SPEC-10.transfer | handoff.transfer | WP-28 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-01-11 | software | Baseline bullet 5d: live IdP integration needs completion. | SPEC-7.secure-link-binding | identity.caller | WP-05 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-01-12 | software | Baseline bullet 5e: vendor events need completion. | SPEC-8.webhook-auth | handoff.transfer | WP-28 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-01-13 | software | Baseline bullet 5f: independent audit export needs completion and qualification. | OPS-01, SPEC-13.audit-integrity | audit.independent | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | 2 (NOT_RUN) |
| FO-01-14 | software | Baseline bullet 5g: domain effects (scheduling, billing, claims, provider syste… | SPEC-8.commit-recheck | domain.business_systems | WP-23 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-01-15 | software | Baseline bullet 5h (software part): calls over a SIP trunk reach the runtime (a… | SPEC-12.load-test | telephony.pstn | WP-12 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-01-15a | software | Baseline bullet 5h (qualification part): PSTN behaviour is qualified with recor… | SPEC-12.load-test | telephony.pstn | WP-45 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-01-16 | constraint | Baseline bullet 5i: draft templates are not approved live scripts. | SPEC-11.opening-disclosure | voice.release_boundary | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-01-17 | operations | Baseline bullet 6a: PR #1 merged to main; PR #2's KMS grant narrowing merged in… | SPEC-14.supply-chain | deploy.infrastructure | WP-39 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-01-18 | software | Baseline bullet 6b: review remaining policy-editor authority. | SPEC-14.supply-chain, OPS-05 | deploy.infrastructure | WP-39 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-01-19 | software | Baseline bullet 7a: emergency-route audit deferral is process-local. | OPS-01, SAFE-03 | audit.independent | WP-04 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | 21 (NOT_RUN) |
| FO-01-20 | software | Baseline bullet 7b: retention declarations need direct review. | DATA-03, SPEC-6.data-classes | privacy.operations | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-01-21 | software | Baseline bullet 7c: release checks need direct review. | SPEC-16.release-manifest, SPEC-14.supply-chain | release.supply_chain | WP-40 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-01-22 | software | Baseline bullet 7d: transfer event ordering needs direct review. | SAFE-04 | handoff.transfer | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-01-23 | evaluation | Baseline bullet 7e: scorer truthfulness needs direct review. | OPS-03, SPEC-14.hard-gates | evaluation.test_truth | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | 1 (PASS) |
| FO-01-24 | constraint | Lesson 1: authenticated in-app chat does not authenticate an arbitrary phone ca… | AUTH-01, SPEC-7.secure-link-binding | identity.caller | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-01-25 | software | Lesson 2: read-oriented client support and provider-approved scheduling/messagi… | SPEC-4.audience-permissions, SPEC-4.role-selection | domain.business_systems | WP-23 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-01-26 | software | Lesson 3: provider actions use immutable proposals, exact approval digests, lea… | ACT-01, ACT-02, ACT-03, SPEC-8.prepare-commit | domain.business_systems | WP-23 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-01-27 | software | Lesson 4: separate call/turn transport, conversation, durable case and action a… | SPEC-9.task-tokens, SPEC-9.recheck | voice.media_runtime | WP-11 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-01-28 | software | Lesson 5: judging text after speech is observational; judge generated audio bef… | ACT-05, SAFE-03 | safety.routing | WP-15 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-01-29 | constraint | Lesson 6: a mock CRM returning TEST identifiers is not a Case integration; HTTP… | OPS-03, SPEC-8.salesforce-model | crm.salesforce | WP-29 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-01-30 | constraint | Lesson 7: memory is not verified clinical truth; program membership is not an a… | DATA-04, SPEC-9.memory | domain.business_systems | WP-23 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-01-31 | software | Lesson 8: token refresh, idle expiry, session-generation fencing, duplicate eve… | AUTH-04, SAFE-04, ACT-02 | identity.caller | WP-05 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-01-32 | document | Produce a gap ledger linking each observation to actual code, remediation, test… | SPEC-16.progress-handoff | governance.documents | WP-44 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-01-33 | document | Remove obsolete claims only after verifying their replacement. | SPEC-16.decisions | governance.documents | WP-44 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-01-34 | software | Baseline bullet 7a (residual): an emergency or human route whose tool execution… | OPS-01, OPS-02, SAFE-03 | audit.independent | WP-04 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | 8 (NOT_RUN) |
| FO-02-01 | constraint | AUTH-01: Caller ID, DOB, NPI and spoken claims never authenticate a session alo… | AUTH-01 | platform.invariants | WP-43 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-02-02 | constraint | AUTH-02: Every protected read and mutation is authorized in trusted backend cod… | AUTH-02 | platform.invariants | WP-43 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-02-03 | constraint | AUTH-03: Actor, subject, organization, assurance and consent are server-establi… | AUTH-03 | platform.invariants | WP-43 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-02-04 | constraint | AUTH-04: Expired or revoked sessions fail closed even if TTL cleanup has not ru… | AUTH-04 | platform.invariants | WP-43 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | 2 (NOT_RUN) |
| FO-02-05 | constraint | AUTH-05: A provider or partner cannot access an unrelated person's records. Rec… | AUTH-05 | platform.invariants | WP-43 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-02-06 | constraint | AUTH-06: Verification secrets never reach a model, transcript or ordinary logs.… | AUTH-06 | platform.invariants | WP-43 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-02-07 | constraint | AUTH-07: Talkdesk Auth Gate false, null, undefined and reused-session cases are… | AUTH-07 | platform.invariants | WP-43 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-02-08 | constraint | DATA-01: No PHI goes to an unapproved endpoint, developer tool or analytics sin… | DATA-01 | platform.invariants | WP-43 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-02-09 | constraint | DATA-02: Raw audio remains sensitive even when a later transcript is redacted.… | DATA-02 | platform.invariants | WP-43 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-02-10 | constraint | DATA-03: Recording and processing follow approved consent and retention control… | DATA-03 | platform.invariants | WP-43 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-02-11 | constraint | DATA-04: A summary or memory cannot establish identity, consent or medical fact… | DATA-04 | platform.invariants | WP-43 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-02-12 | constraint | ACT-01: Every consequential action has fresh, transaction-bound confirmation. R… | ACT-01 | platform.invariants | WP-43 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-02-13 | constraint | ACT-02: Retry, redelivery and crash-after-commit tests create no duplicate effe… | ACT-02 | platform.invariants | WP-43 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-02-14 | constraint | ACT-03: An ambiguous timeout is reconciled before retry or success is announced… | ACT-03 | platform.invariants | WP-43 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-02-15 | constraint | ACT-04: Case creation and workflow acceptance do not count as issue resolution.… | ACT-04 | platform.invariants | WP-43 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-02-16 | constraint | ACT-05: Protected utterances cannot be spoken before authorization and validati… | ACT-05 | platform.invariants | WP-43 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-02-17 | constraint | SAFE-01: No diagnosis, therapy, clinical screening or medication recommendation… | SAFE-01 | platform.invariants | WP-43 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-02-18 | constraint | SAFE-02: Safety routing and human requests do not require account authenticatio… | SAFE-02 | platform.invariants | WP-43 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-02-19 | constraint | SAFE-03: Refusal counts, silence and cost limits never silently terminate safet… | SAFE-03 | platform.invariants | WP-43 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-02-20 | constraint | SAFE-04: Transfer succeeds only with receiver acceptance and verified connectio… | SAFE-04 | platform.invariants | WP-43 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-02-21 | constraint | SAFE-05: A caller, model or retrieved document cannot choose an arbitrary dial… | SAFE-05 | platform.invariants | WP-43 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-02-22 | constraint | OPS-01: Every accepted consequential action has durable independent audit evide… | OPS-01 | platform.invariants | WP-43 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-02-23 | constraint | OPS-02: AI failure preserves a usable telephony route with documented capacity.… | OPS-02 | platform.invariants | WP-43 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-02-24 | constraint | OPS-03: Unknown capabilities, missing evidence and unrun tests are not PASS. Re… | OPS-03 | platform.invariants | WP-43 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-02-25 | constraint | OPS-04: Production refuses fixture adapters and missing mandatory approvals. Re… | OPS-04 | platform.invariants | WP-43 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-02-26 | constraint | OPS-05: No paid tests, PHI access or production changes without scoped authoriz… | OPS-05 | platform.invariants | WP-43 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-02-27 | constraint | OPS-06: Model, voice, knowledge, tools and policy versions are pinned and revie… | OPS-06 | platform.invariants | WP-43 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-02-28 | document | Maintain one invariant register with, for every invariant, enforcement location… | SPEC-14.traceability, SPEC-14.threat-model | evaluation.test_truth | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | 9 (PASS) |
| FO-02-29 | evaluation | Test invariants at the actual endpoint (HTTP/MCP), not merely a prompt string. | SPEC-14.hostile-gateway-tests | platform.invariants | WP-43 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-02-30 | evaluation | Test invariants at the audio release boundary, not merely a prompt string. | SPEC-11.response-gate, ACT-05 | voice.cascade | WP-17 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-02-31 | evaluation | Run the invariant suite against every conversation adapter and voice mode that… | SPEC-14.hostile-gateway-tests, ACT-05, AUTH-06, SAFE-02, SAFE-05 | platform.invariants | WP-43 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-03-01 | software | Exactly one conversational owner per call. | SPEC-3.trust-boundaries | voice.release_boundary | WP-14 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-03-02 | software | Exactly one durable case owner. | SPEC-3.workflow-engine, SPEC-9.workflow | workflows.durable | WP-26 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-03-03 | software | Exactly one controlled action executor. | SPEC-8.prepare-commit | actions.effects | WP-25 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-03-04 | software | Multiple specialists may investigate in parallel but cannot each speak, reassig… | — | conversation.harness | WP-10 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-03-05 | software | Responsive loop: listen, turn-take, clarify and play approved speech. | SPEC-11.endpointing, SPEC-11.barge-in | voice.media_runtime | WP-11 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-03-06 | software | Investigation loop: bounded reasoning with authorized reads. | — | conversation.harness | WP-10 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-03-07 | software | Trusted gateway with identity and OPA between conversation runtime and context/… | AUTH-02, SPEC-8.tool-surface | conversation.harness | WP-10 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-03-08 | software | Context/knowledge engine combining history and recent events. | SPEC-9.retrieval | context.assembly | WP-24 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-03-09 | software | Action executor over domain APIs plus ledger. | SPEC-8.ledger | domain.business_systems | WP-23 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-03-10 | software | Independent audit plus operations console fed by the durable case owner. | OPS-01, SPEC-13.console | audit.independent | WP-04 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-03-11 | constraint | Keep modules clear; avoid a microservice per prompt. | — | connectors.runtime | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | 33 (PASS) |
| FO-03-12 | software | Independently deploy media, API/control plane, asynchronous workers and audit e… | SPEC-3.ingress | deploy.infrastructure | WP-39 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-03-13 | software | Models receive only scoped data and tool proposals. | DATA-01, AUTH-03 | conversation.harness | WP-10 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-03-14 | constraint | Default stack: TypeScript, supported Node LTS, Fastify and the existing React/T… | — | platform.workspace | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-03-15 | constraint | Python sidecars only for model inference/evaluation, not a rewrite of working T… | — | release.supply_chain | WP-40 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-03-16 | software | Pin runtimes, lockfiles and image digests. | OPS-06, SPEC-14.supply-chain | release.supply_chain | WP-40 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-03-17 | software | LiveKit Agents with self-hostable media and SIP for the controllable voice refe… | SPEC-3.vendor-capability-gate | voice.media_runtime | WP-11 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-03-18 | constraint | Prefer LiveKit's supported Node SDK; isolate a Python media worker only if a re… | — | voice.media_runtime | WP-11 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-03-19 | software | Bounded conversation/investigation graph (LangGraph.js where it simplifies type… | — | conversation.harness | WP-10 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-03-20 | constraint | Retain AWS Step Functions Standard as the durable case/workflow orchestrator; g… | SPEC-3.workflow-engine, ACT-02 | workflows.durable | WP-26 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-03-21 | software | Aurora/PostgreSQL for action ledger, case links, event inbox/outbox, timelines,… | SPEC-8.ledger, SPEC-9.retrieval | ingress.events | WP-04 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | 3 (NOT_RUN) |
| FO-03-22 | software | DynamoDB conditional records for call binding, revocation and ownership leases. | AUTH-04 | platform.substrate | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | 6 (NOT_RUN) |
| FO-03-23 | constraint | PGlite stays local only. | OPS-04 | platform.composition | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-03-24 | software | SQS with DLQ for delivery. | SPEC-8.outbox | platform.substrate | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | 1 (NOT_RUN) |
| FO-03-25 | constraint | EventBridge only when fan-out is justified. | — | platform.substrate | WP-06 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | 5 (PASS) |
| FO-03-26 | software | Consume an existing Kafka/MSK/Kinesis stream through an adapter when the tenant… | — | ingress.events | WP-04 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | 3 (PASS) |
| FO-03-27 | software | OPA locally evaluated policy bundles. | SPEC-3.trust-boundaries | platform.composition | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-03-28 | software | Use existing OIDC IdPs and workforce SSO. | SPEC-7.workforce-separation | identity.workforce | WP-05 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-03-29 | software | AWS workload identity, Secrets Manager, KMS, S3 and an independent audit accoun… | SPEC-14.supply-chain | connectors.runtime | WP-06 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | 2 (NOT_RUN) |
| FO-03-30 | software | OpenTelemetry with approved CloudWatch/Datadog or self-hosted observability; co… | SPEC-13.dashboards, DATA-01 | platform.composition | WP-07 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-03-31 | software | Terraform, OIDC-based CI and signed build/release manifests. | SPEC-14.supply-chain, SPEC-16.release-manifest | release.supply_chain | WP-40 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-03-32 | software | Voice mode A, controlled cascade: streaming ASR -> bounded reasoning -> respons… | ACT-05, SPEC-11.response-gate | voice.cascade | WP-17 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-03-33 | software | Voice mode B, native full-duplex: qualified native audio model adapters (OpenAI… | — | voice.native | WP-16 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-03-34 | constraint | Hybrid provider paths are separately authenticated and qualified per provider/r… | — | models.registry | WP-09 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-03-35 | software | The runtime, not a prompt, owns which audio may reach the caller; response clas… | ACT-05 | voice.release_boundary | WP-14 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-03-36 | constraint | Never send protected context to an unrestricted native speaker. | DATA-01, ACT-05 | voice.native | WP-16 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-03-37 | software | Mode switching avoids overlapping speakers and revokes old buffers. | SPEC-11.barge-in | voice.native | WP-16 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-03-38 | evaluation | Qualify native-mode continuity and latency; do not market native mode as protec… | — | voice.native | WP-16 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-03-39 | environment | Keep Talkdesk numbers, routing, queues, human workspace and continuity routes w… | SPEC-3.independent-human-route | contact_center.talkdesk | WP-29 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-03-40 | software | Implement a documented SIP reference route so the product runs without a propri… | — | telephony.sip | WP-12 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-03-41 | software | Talkdesk AI Agent Platform/MCP is an optional conversation adapter requiring th… | SPEC-8.service-identities | conversation.talkdesk_native | WP-29 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-03-42 | software | Only one conversation adapter owns a call. | — | voice.release_boundary | WP-14 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-03-43 | constraint | Use supported SIP/media interfaces and documented authentication; do not invent… | SPEC-3.vendor-capability-gate | contact_center.talkdesk | WP-29 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-03-44 | constraint | Do not wait for vendor uncertainty before building the independent runtime. | — | voice.media_runtime | WP-11 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-03-45 | environment | ECS Fargate for suitable control services. | SPEC-3.ingress | deploy.infrastructure | WP-39 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-03-46 | environment | Provide an explicit deployment topology for media/SIP UDP, host networking, GPU… | — | deploy.infrastructure | WP-39 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-03-47 | constraint | An HTTP load balancer alone is not a working RTP/TURN architecture; contracts a… | — | deploy.infrastructure | WP-39 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-03-48 | document | Separate the reference deployment from optional managed services. | — | deploy.infrastructure | WP-39 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-03-49 | software | The operations console (investigation, work queues, approvals, kill switches) i… | SPEC-7.workforce-separation, SPEC-13.console | platform.composition, operator.console | WP-07 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-03-49a | software | The operations console has its own private access path in infrastructure: an in… | SPEC-7.workforce-separation, SPEC-13.console | deploy.infrastructure, operator.console | WP-39 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-04-01 | software | Generate versioned JSON Schemas, OpenAPI, TypeScript types and validation from… | SPEC-16.protocol-artifacts, SPEC-16.openapi | platform.contracts | WP-02 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | 9 (PASS) |
| FO-04-02 | constraint | additionalProperties=false at tool boundaries. | SPEC-8.tool-schema | platform.contracts | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | 2 (PASS) |
| FO-04-03 | constraint | Bounded lengths, enums, payloads, numbers, time ranges and pagination everywher… | SPEC-8.tool-schema | platform.contracts | WP-02 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | 6 (PASS) |
| FO-04-04 | constraint | Internal trusted fields never originate in caller/model arguments. | AUTH-03 | platform.contracts | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-04-05 | software | Contract AuthContext: versioned, strict, generated schema with common fields. | AUTH-03, SPEC-7.session-model | platform.contracts | WP-02 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | 3 (PASS) |
| FO-04-06 | software | Contract CallBinding: versioned, strict, generated schema with common fields. | SPEC-7.session-model | platform.contracts | WP-02 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | 3 (PASS) |
| FO-04-07 | software | Contract TurnEnvelope: versioned, strict, generated schema with common fields. | — | platform.contracts | WP-02 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | 2 (PASS) |
| FO-04-08 | software | Contract ContextSnapshot: versioned, strict, generated schema with common field… | — | platform.contracts | WP-02 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | 3 (PASS) |
| FO-04-09 | software | Contract ContextFact: versioned, strict, generated schema with common fields. | — | platform.contracts | WP-02 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | 3 (PASS) |
| FO-04-10 | software | Contract SourceWatermark: versioned, strict, generated schema with common field… | — | platform.contracts | WP-02 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | 3 (PASS) |
| FO-04-11 | software | Contract IdentityLink: versioned, strict, generated schema with common fields. | SPEC-7.secure-link-binding | platform.contracts | WP-02 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | 3 (PASS) |
| FO-04-12 | software | Contract KnowledgeCitation: versioned, strict, generated schema with common fie… | SPEC-9.retrieval | platform.contracts | WP-02 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | 3 (PASS) |
| FO-04-13 | software | Contract ModelInvocation: versioned, strict, generated schema with common field… | OPS-06 | platform.contracts | WP-02 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | 2 (PASS) |
| FO-04-14 | software | Contract ModelDecision: versioned, strict, generated schema with common fields. | — | platform.contracts | WP-02 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | 2 (PASS) |
| FO-04-15 | software | Contract ToolRequest: versioned, strict, generated schema with common fields. | SPEC-8.tool-schema | platform.contracts | WP-02 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | 2 (PASS) |
| FO-04-16 | software | ToolResult is a discriminated union (SUCCESS / POLICY_DENIED / RETRYABLE_FAILUR… | SPEC-16.protocol-artifacts, SPEC-8.timeout-states | platform.contracts | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | 1 (PASS) |
| FO-04-17 | software | ToolResult carries typed permitted facts, receipt refs and a safe explanation c… | SPEC-8.tool-schema | platform.contracts | WP-02 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | 2 (PASS) |
| FO-04-18 | software | ToolResult carries freshness of the permitted facts. | — | platform.contracts | WP-02 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | 3 (PASS) |
| FO-04-19 | constraint | Model-written narratives are not authoritative facts. | DATA-04, SPEC-11.response-gate | conversation.harness | WP-10 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-04-20 | software | Contract PreparedAction: versioned, strict, generated schema with common fields. | ACT-01, SPEC-8.prepare-commit | platform.contracts | WP-02 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | 1 (PASS) |
| FO-04-21 | software | Contract ConfirmationReceipt: versioned, strict, generated schema with common f… | ACT-01 | platform.contracts | WP-02 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | 2 (PASS) |
| FO-04-22 | software | Contract ActionGrant: versioned, strict, generated schema with common fields. | SPEC-9.task-tokens | platform.contracts | WP-02 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | 1 (PASS) |
| FO-04-23 | software | Contract CommitReceipt: versioned, strict, generated schema with common fields. | ACT-02, ACT-03 | platform.contracts | WP-02 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | 1 (PASS) |
| FO-04-24 | software | Contract EffectVerification: versioned, strict, generated schema with common fi… | — | platform.contracts | WP-02 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | 2 (PASS) |
| FO-04-25 | software | Contract SupportRequest: versioned, strict, generated schema with common fields. | SPEC-8.salesforce-model | platform.contracts | WP-02 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | 2 (PASS) |
| FO-04-26 | software | Contract CaseLink: versioned, strict, generated schema with common fields. | — | platform.contracts | WP-02 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | 3 (PASS) |
| FO-04-27 | software | Contract WorkflowEvent: versioned, strict, generated schema with common fields. | SPEC-9.workflow | platform.contracts | WP-02 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-04-28 | software | Contract HumanTask: versioned, strict, generated schema with common fields. | — | platform.contracts | WP-02 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | 2 (PASS) |
| FO-04-29 | software | Contract HandoffPackage: versioned, strict, generated schema with common fields. | SPEC-10.handoff-package | platform.contracts | WP-02 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-04-30 | software | Contract CarrierEvent: versioned, strict, generated schema with common fields. | SPEC-8.webhook-auth | platform.contracts | WP-02 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | 2 (PASS) |
| FO-04-31 | software | Contract SpeechPlan: versioned, strict, generated schema with common fields. | SPEC-11.response-gate | platform.contracts | WP-02 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | 6 (PASS) |
| FO-04-32 | software | Contract AudioReleaseReceipt: versioned, strict, generated schema with common f… | ACT-05, SPEC-11.response-record | platform.contracts | WP-02 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | 3 (PASS) |
| FO-04-33 | software | Contract AuditEvent: versioned, strict, generated schema with common fields. | OPS-01, SPEC-13.audit-model | platform.contracts | WP-02 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-04-34 | software | Contract ConnectorProfile: versioned, strict, generated schema with common fiel… | — | platform.contracts | WP-02 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | 3 (PASS) |
| FO-04-35 | software | Contract TenantConfig: versioned, strict, generated schema with common fields. | SPEC-16.prod-guard | platform.contracts | WP-02 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | 2 (PASS) |
| FO-04-36 | software | Contract ScenarioDefinition: versioned, strict, generated schema with common fi… | SPEC-16.scenario-definition | platform.contracts | WP-02 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | 1 (PASS) |
| FO-04-37 | software | Contract EvaluationResult: versioned, strict, generated schema with common fiel… | SPEC-14.scorecard | platform.contracts | WP-02 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | 3 (PASS) |
| FO-04-38 | software | Contract ChangeProposal: versioned, strict, generated schema with common fields. | SPEC-15.no-self-promotion | platform.contracts | WP-02 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | 2 (PASS) |
| FO-04-39 | software | Contract ApprovalRecord: versioned, strict, generated schema with common fields. | OPS-05, SPEC-5.prerequisite-register | platform.contracts | WP-02 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-04-40 | software | Contract ReleaseManifest: versioned, strict, generated schema with common field… | SPEC-16.release-manifest | platform.contracts | WP-02 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | 1 (PASS) |
| FO-04-41 | software | Contract ActivationReport: versioned, strict, generated schema with common fiel… | — | platform.contracts | WP-02 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | 2 (PASS) |
| FO-04-42 | software | Common fields where relevant: tenant_id, interaction_id, case_id, workflow_id,… | SPEC-6.no-phi-in-identifiers | platform.contracts | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | 8 (PASS) |
| FO-04-43 | constraint | Use UTC instants and an explicit business timezone. | — | platform.contracts | WP-02 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | 5 (PASS) |
| FO-04-44 | constraint | Integer minor units plus currency for money. | SPEC-4.payments-isolated | platform.contracts | WP-02 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | 3 (PASS) |
| FO-04-45 | software | Maintain separate records for person, actor, organization/delegation, call sess… | — | platform.contracts | WP-02 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | 3 (PASS) |
| FO-04-46 | software | One person can hold multiple roles; one call can have multiple cases; multiple… | SPEC-4.role-selection | platform.contracts | WP-02 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | 4 (PASS) |
| FO-04-47 | constraint | A conversation summary must not overwrite the action ledger or source-system st… | DATA-04 | conversation.harness | WP-10 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-04-48 | software | The contract registry test enumerates all 34 required follow-on contracts (not… | SPEC-16.protocol-artifacts | platform.contracts | WP-02 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | 4 (PASS) |
| FO-05-01 | constraint | Retain application assurance tiers A0-A3, explicitly not NIST certification. | SPEC-7.assurance-tiers | identity.caller | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-05-02 | software | A0: public information, neutral unverified intake and human/safety routing. | SPEC-7.assurance-tiers, SAFE-02 | identity.caller | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-05-03 | software | A1: approved possession verification, only for tenant-approved low-risk operati… | SPEC-7.otp-limits | identity.caller | WP-05 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-05-04 | software | A2: account authentication through the existing portal with MFA/passkey, bound… | SPEC-7.secure-link-binding | identity.caller | WP-05 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-05-05 | software | A3: recent transaction-bound step-up and explicit approval for consequential ac… | SPEC-7.assurance-tiers, ACT-01 | identity.caller | WP-05 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-05-06 | software | High-risk changes may still require humans regardless of tier. | SPEC-4.resolution-contracts | identity.caller | WP-05 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-05-07 | software | Real OIDC issuer discovery and validation. | SPEC-7.secure-link-binding | identity.caller | WP-05 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-05-08 | software | aud/iss/exp/nonce checks. | SPEC-7.secure-link-binding | identity.caller | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-05-09 | software | PKCE where appropriate. | SPEC-7.workforce-separation | identity.caller | WP-05 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-05-10 | software | state/CSRF protection. | — | identity.caller | WP-05 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-05-11 | software | Replay resistance. | SPEC-7.assertions | identity.caller | WP-05 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-05-12 | software | JWKS rotation. | SPEC-7.secure-link-binding | identity.caller | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-05-13 | software | Callback allowlists. | — | identity.caller | WP-05 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-05-14 | software | Session fixation defenses. | SPEC-7.session-model | identity.caller | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-05-15 | software | Expiry of transactions, tokens and sessions. | AUTH-04, SPEC-7.privilege-expiry | identity.caller | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-05-16 | software | Bind the account-approved nonce to a trusted carrier interaction AND the sessio… | SPEC-7.secure-link-binding | voice.media_runtime | WP-11 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-05-17 | constraint | Never infer binding from an arbitrary call ID passed by a model. | AUTH-03, AUTH-07 | identity.caller | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-05-18 | software | Support idle expiry. | AUTH-04 | identity.workforce | WP-05 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-05-19 | software | Same-actor refresh without silently switching subjects. | — | identity.caller | WP-05 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-05-20 | software | Enforce revoked/expired state on every read, retrieval, action, notification an… | AUTH-04 | voice.release_boundary | WP-14 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-05-21 | constraint | TTL deletion is not a gate. | AUTH-04 | identity.caller | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-05-22 | software | The verified identity service supplies canonical actor, selected role, authoriz… | AUTH-03, SPEC-7.session-model | identity.caller | WP-05 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-05-23 | constraint | Caller ID, DOB, NPI, address, email domain, claim details, voice familiarity an… | AUTH-01 | identity.caller, authority.registries | WP-19 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-05-24 | constraint | No account-existence disclosure before authorization. | SPEC-7.anti-enumeration | identity.caller | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-05-25 | constraint | OTP uses only pre-registered channels; never send verification to a new caller-… | SPEC-7.otp-limits | identity.caller | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-05-26 | software | OTP capture is isolated (portal or DTMF). | AUTH-06, SPEC-7.otp-limits | telephony.sip | WP-12 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-05-27 | software | OTP is one use, short expiry, throttled, with recovery. | SPEC-7.otp-limits | identity.caller | WP-05 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-05-28 | constraint | Starting values: five-minute expiry, three attempts per challenge, five per acc… | SPEC-7.otp-limits | identity.caller | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-05-29 | constraint | Do not expose digits to ASR, models, recordings or logs; pausing one recorder i… | AUTH-06 | telephony.sip | WP-12 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-05-30 | software | Portal verification works even if secure DTMF is unavailable. | SPEC-7.secure-link-binding | identity.caller | WP-05 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-05-31 | constraint | No passwords or card secrets through models. | SPEC-4.payments-isolated, DATA-01 | conversation.harness | WP-10 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-05-32 | software | Provider/practice access requires authoritative active delegation. | AUTH-05, SPEC-4.audience-permissions | authority.registries | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-05-33 | software | Partners/payers require verified affiliation, contract, purpose and person-leve… | AUTH-05 | authority.registries | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-05-34 | constraint | Benefit sponsorship alone never authorizes an employer to learn treatment statu… | AUTH-05 | identity.caller | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-05-35 | software | Minors, guardians and representatives require record-specific current authority… | AUTH-05 | authority.registries | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-05-36 | constraint | Never union multiple roles silently. | SPEC-4.role-selection | identity.caller | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-05-37 | constraint | Default-deny OPA decisions. | AUTH-02 | identity.caller | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-05-38 | software | Row/field checks in storage and adapters. | AUTH-02, SPEC-7.data-layer-isolation | identity.caller | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-05-39 | software | Separate integration identities per environment and capability. | SPEC-8.service-identities | connectors.runtime | WP-06 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | 2 (PASS) |
| FO-05-40 | constraint | Service-to-service authentication does not authenticate the caller. | AUTH-01 | identity.caller | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-05-41 | software | Workforce SSO/MFA through the existing workforce IdP (authorization code exchan… | SPEC-7.workforce-separation | identity.workforce | WP-05 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-05-42 | software | Workforce roles: support agent, supervisor, safety responder, auditor, knowledg… | SPEC-7.workforce-separation | identity.workforce | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-05-43 | software | Workforce MFA required. | SPEC-7.workforce-separation | identity.workforce | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-05-44 | constraint | Break-glass enforcement: human-controlled, time-bound, audited, never self-gran… | SPEC-7.workforce-separation | identity.workforce | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-05-45 | software | Break-glass issuance: request, independent approval, expiry and post-use review… | — | identity.workforce | WP-05 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-05-46 | software | Keep recording consent, transcription/AI processing permission, support purpose… | DATA-03, SPEC-6.consent-before-recording | privacy.operations | WP-22 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-05-47 | software | Explicit opt-out, unknown, expired and affirmative permission are separate stat… | DATA-03 | privacy.operations | WP-22 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-05-48 | software | Revocation propagation to sessions. | AUTH-04 | privacy.operations | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-05-49 | software | Revocation propagation to caches. | — | privacy.operations | WP-22 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-05-50 | software | Revocation propagation to memory. | DATA-04 | privacy.operations | WP-22 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-05-51 | software | Revocation propagation to pending work. | SPEC-9.recheck | privacy.operations | WP-22 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-05-52 | software | Live consent registry adapter. | DATA-03 | authority.registries | WP-19 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-05-53 | software | Live identity directory adapter. | AUTH-01, SPEC-7.anti-enumeration | authority.registries | WP-19 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-05-54 | software | Live notification sender for secure links and OTP to registered channels. | SPEC-9.notifications | notifications.messaging | WP-27 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-05-55 | software | Live relationship/delegation registry adapter. | AUTH-05 | authority.registries | WP-19 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-05-56 | software | Separate outbound integration identities per environment and per capability: ea… | SPEC-8.service-identities, AUTH-02 | connectors.runtime | WP-06 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | 6 (NOT_RUN) |
| FO-06-01 | software | Deliver real connector transports for every required connector family (Talkdesk… | OPS-03, OPS-04, SPEC-16.integration-records | operator.onboarding | WP-32 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-06-02 | evaluation | Keep emulators for deterministic tests, but run the exact production adapter ag… | OPS-03 | connectors.runtime | WP-06 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-06-03 | software | Connectors implement documented authentication with token caching, refresh and… | AUTH-02, AUTH-04, SPEC-8.service-identities | connectors.runtime | WP-06 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | 11 (NOT_RUN) |
| FO-06-04 | software | Credential references in connector configuration resolve at runtime from the se… | AUTH-06, DATA-01 | connectors.runtime | WP-06 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | 19 (NOT_RUN) |
| FO-06-05 | software | Source object/field mappings are classified required/optional/prohibited and va… | SPEC-8.salesforce-model, DATA-01 | connectors.runtime | WP-06 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | 15 (NOT_RUN) |
| FO-06-06 | software | Connectors implement the documented pagination/cursor strategy with bounded pag… | SPEC-12.resilience | connectors.runtime | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | 12 (NOT_RUN) |
| FO-06-07 | software | Each connector enforces a rate and concurrency budget (throttling, bulkheads) a… | SPEC-12.quotas, SPEC-12.resilience, SPEC-12.admission | connectors.runtime | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | 25 (NOT_RUN) |
| FO-06-08 | software | Connectors apply timeouts and retry classification: NOT_STARTED failures may re… | ACT-03, SPEC-12.no-retry-stacking, SPEC-12.resilience | connectors.runtime | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | 17 (NOT_RUN) |
| FO-06-09 | software | Incremental readers persist durable checkpoints (cursor, replay id, watermark)… | ACT-02 | connectors.runtime | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | 15 (NOT_RUN) |
| FO-06-10 | software | Failed outbound connector deliveries go to a dead-letter queue with audited ope… | SPEC-8.outbox, SPEC-12.no-retry-stacking, OPS-01 | connectors.runtime, platform.substrate | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | 5 (NOT_RUN) |
| FO-06-11 | software | Every connector exposes health checks that fail closed and feed capability read… | OPS-03, OPS-02 | connectors.runtime | WP-06 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | 12 (NOT_RUN) |
| FO-06-12 | software | ConnectorProfile is a versioned contract (single contract source -> JSON Schema… | OPS-06, SPEC-16.integration-records | connectors.runtime | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | 3 (PASS) |
| FO-06-13 | software | ConnectorProfile records documented base URL, allowed hosts, region and tenant/… | DATA-01, SAFE-05 | connectors.runtime | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | 7 (NOT_RUN) |
| FO-06-14 | software | ConnectorProfile records OAuth scopes and the credential reference; granted sco… | AUTH-02 | connectors.runtime | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | 2 (PASS) |
| FO-06-15 | software | ConnectorProfile declares enabled reads and writes, authoritative fields and ev… | AUTH-02, OPS-04 | connectors.runtime | WP-06 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | 3 (PASS) |
| FO-06-16 | software | ConnectorProfile declares pagination/cursor strategy, rate/concurrency budget,… | ACT-02, ACT-03, SPEC-12.resilience | connectors.runtime | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | 2 (PASS) |
| FO-06-17 | software | ConnectorProfile declares deletion behavior and retention/egress class for each… | DATA-01, DATA-03 | connectors.runtime | WP-06 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | 5 (PASS) |
| FO-06-18 | software | ConnectorProfile carries verified capability evidence and a configuration diges… | OPS-06, OPS-03, OPS-01 | connectors.runtime | WP-06 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | 11 (NOT_RUN) |
| FO-06-19 | constraint | No secrets in configuration exports, URLs, logs, chat or frontend bundles. | AUTH-06, DATA-01 | connectors.runtime, release.supply_chain | WP-40 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-06-20 | constraint | No arbitrary-host fetch: every outbound request goes to a host allowed by the c… | DATA-01, SAFE-05 | connectors.runtime | WP-06 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | 30 (NOT_RUN) |
| FO-06-21 | constraint | No arbitrary SQL and no model-generated SQL; only reviewed parameterized statem… | DATA-01, AUTH-05 | connectors.runtime | WP-06 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | 8 (PASS) |
| FO-06-22 | constraint | No dynamic shell, eval, untrusted plugin loading or executable mapping expressi… | DATA-01, OPS-06 | connectors.runtime | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | 10 (PASS) |
| FO-06-23 | software | A declarative adapter profile may map reviewed operations and JSON fields only… | SAFE-05, OPS-06 | connectors.runtime | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | 24 (PASS) |
| FO-06-24 | constraint | The declarative profile is not permission for a model to invent HTTP operations… | OPS-06, SAFE-05 | conversation.harness | WP-10 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-06-25 | constraint | Missing or undocumented vendor behavior remains explicitly unsupported and fail… | OPS-03 | connectors.runtime | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | 4 (PASS) |
| FO-06-26 | software | For each capability whose vendor behavior is unknown, supply a documented refer… | OPS-03, OPS-05 | domain.business_systems | WP-23 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-06-27 | software | Talkdesk connector correlates calls/interactions with the platform call binding… | SPEC-8.webhook-auth, AUTH-03 | contact_center.talkdesk | WP-29 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-06-28 | software | Talkdesk connector reads queues and agents (availability, queue state) for rout… | SAFE-04, OPS-02 | contact_center.talkdesk | WP-29 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-06-29 | software | Talkdesk connector requests transfers to allowlisted destinations and records r… | SAFE-04, SAFE-05, OPS-02 | contact_center.talkdesk | WP-29 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-06-30 | software | Talkdesk connector retrieves historical report, transcript and media references… | DATA-02, DATA-03 | contact_center.talkdesk | WP-29 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-06-31 | software | Talkdesk connector uses documented OAuth scopes and webhook registrations. | AUTH-02, SPEC-8.service-identities | contact_center.talkdesk | WP-29 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-06-32 | software | Inbound Talkdesk webhooks are verified using the vendor's actual signing behavi… | SPEC-8.webhook-auth, ACT-02 | contact_center.talkdesk | WP-29 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-06-33 | software | Where no signed feed is available, authenticate the supported gateway and recon… | SPEC-8.webhook-auth, SAFE-04, OPS-03 | contact_center.talkdesk | WP-29 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-06-34 | document | Provide Studio/config exports or precise UI instructions where configuration AP… | SPEC-16.prod-guard | activation.qualification | WP-45 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-06-35 | software | Provide Talkdesk readiness and configuration drift checks. | SPEC-16.prod-guard, OPS-03 | contact_center.talkdesk | WP-29 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-06-36 | environment | Configure AI-off and independent overflow routes in the contact center that do… | OPS-02, SAFE-02, SAFE-03 | activation.qualification | WP-45 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-06-37 | software | Treat Talkdesk Auth Gate as a component gate, not the identity provider; test m… | AUTH-07, AUTH-04, AUTH-01, SPEC-2.auth-gate-values | conversation.talkdesk_native | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-06-37a | evaluation | Studio-side Auth Gate tests (qualification part of FO-06-37): an uncleared vari… | AUTH-07, SPEC-2.auth-gate-values | conversation.talkdesk_native | WP-45 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-06-38 | evaluation | Qualify guardrail termination, simulator version identity and preview features… | SAFE-03, OPS-06, OPS-03, SPEC-2.guardrail-exit | contact_center.talkdesk | WP-29 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-06-39 | software | Implement a generic documented SIP connector (RFC 3261 signaling, SDP/RTP media… | SAFE-04, SAFE-05, OPS-02 | telephony.sip | WP-12 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-06-40 | software | Provide a local synthetic softphone/receiver path with real SIP signaling and R… | SAFE-04, DATA-02, OPS-05 | telephony.sip | WP-12 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-06-41 | software | Salesforce connector performs restricted REST and metadata reads of selected Kn… | SPEC-8.salesforce-outage, AUTH-05 | crm.salesforce | WP-29 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-06-42 | software | Salesforce connector performs incremental history sync with deletion awareness. | SPEC-8.salesforce-outage, DATA-03 | crm.salesforce | WP-29 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-06-43 | software | Optionally consume documented CDC/Pub/Sub API events when tenant-enabled, prese… | SPEC-8.salesforce-outage, ACT-02 | crm.salesforce | WP-29 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-06-44 | software | Implement Case creation/update with restricted schema and external IDs. | SPEC-8.salesforce-model, ACT-02 | crm.salesforce | WP-29 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-06-45 | software | Respect Salesforce API limits. | SPEC-12.quotas | crm.salesforce | WP-29 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-06-46 | software | Handle Salesforce sharing, field-level security, validation/duplicate rules and… | SPEC-8.salesforce-model, ACT-03, AUTH-05 | crm.salesforce | WP-29 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-06-47 | software | Default existing read-only connections to READ_ONLY; never test mutations with… | OPS-05, ACT-01 | contact_center.talkdesk | WP-29 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-06-48 | constraint | No Apex or broad metadata modification shortcuts. | OPS-05 | contact_center.talkdesk | WP-29 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-06-49 | software | Use a server-derived external idempotency key, unique interaction/case links an… | ACT-02, ACT-03, SPEC-8.salesforce-model | contact_center.talkdesk | WP-29 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-06-50 | constraint | A successful CRM write is not proof of final case disposition or business resol… | ACT-04 | crm.salesforce | WP-29 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-06-51 | software | During CRM outage retain an encrypted internal support reference plus outbox, l… | SPEC-8.salesforce-outage, SPEC-8.outbox, ACT-04 | crm.salesforce | WP-29 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-06-52 | constraint | Store minimized summaries and access-checked evidence references in the CRM, no… | DATA-01, SPEC-6.case-minimization | crm.salesforce | WP-29 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-06-53 | software | Ingest documented track/identify/group/alias-compatible events through a review… | DATA-01, ACT-02 | data.cdp | WP-21 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-06-54 | software | Verify each tenant's CDP delivery mechanism and authentication (webhook destina… | SPEC-8.webhook-auth | data.cdp | WP-21 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-06-55 | constraint | Treat alias/identify as analytics linkage only; never sufficient to merge prote… | AUTH-01, DATA-04 | data.warehouse | WP-21 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-06-56 | software | Assign different confidence to real-time server-authoritative operational event… | DATA-04, ACT-04 | context.store | WP-18 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-06-57 | constraint | Marketing profile traits never create support action authority. | AUTH-03, AUTH-02 | data.cdp | WP-21 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-06-58 | software | Configure CDP purpose/field filters, suppression/deletion propagation and desti… | DATA-01, DATA-03 | data.cdp | WP-21 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-06-59 | constraint | No support transcript, inferred distress or protected treatment fact goes to ad… | DATA-01 | data.cdp | WP-21 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-06-60 | software | Real read-only Snowflake connector using supported authentication (key-pair JWT… | DATA-01, AUTH-02 | data.warehouse | WP-21 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-06-61 | software | Query Snowflake only through approved secure views or parameterized SQL templat… | DATA-01, AUTH-05 | data.warehouse | WP-21 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-06-62 | software | Bound Snowflake records, time ranges, statements, warehouse use, query timeout… | SPEC-12.budget-cutoff, SPEC-12.resilience | data.warehouse | WP-21 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-06-63 | software | Support asynchronous query completion/cancellation and result pagination. | SPEC-12.resilience | data.warehouse | WP-21 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-06-64 | software | Use explicit column selection, tenant/subject predicates, deleted-record handli… | AUTH-05, DATA-01, DATA-03 | data.warehouse | WP-21 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-06-65 | constraint | No broad warehouse export into each call; warehouse history complements operati… | DATA-01 | data.warehouse | WP-21 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-06-66 | software | Implement a supported Iceberg catalog and query-engine profile (e.g. Glue + Ath… | DATA-01 | data.warehouse | WP-21 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-06-67 | evaluation | Provide a local compatible Iceberg catalog/query fixture. | OPS-03 | data.warehouse | WP-21 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-06-68 | software | Pin table, snapshot and schema IDs in evidence for every lakehouse read. | OPS-06 | data.warehouse | WP-21 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-06-69 | software | Respect row deletes, tombstones, partition pruning, schema evolution, late data… | DATA-03 | data.warehouse | WP-21 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-06-70 | software | Verify access enforcement at the query engine (catalog tags alone do not prove… | AUTH-05, DATA-03 | data.warehouse | WP-21 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-06-71 | constraint | Never query raw bronze patient data from the conversational model. | DATA-01, SAFE-01 | data.warehouse | WP-21 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-06-72 | software | Ship production adapters for the canonical scheduling, billing/claims-status, p… | SPEC-16.integration-records, OPS-04 | domain.business_systems | WP-23 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-06-73 | software | Provide a canonical referrals-status contract and adapter. | AUTH-05, DATA-04 | domain.business_systems | WP-23 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-06-74 | software | Provide a documented reference HTTP service and bounded tenant mappings where i… | OPS-03 | domain.business_systems | WP-23 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-06-75 | software | Each business adapter implements read, prepare, commit, receipt and reconcile b… | ACT-01, ACT-02, ACT-03 | domain.business_systems | WP-23 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-06-76 | constraint | Never fabricate insurance coverage, fee waivers, clinical suitability, payout a… | ACT-04, SAFE-01, DATA-04 | domain.business_systems | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-06-77 | software | Salesforce Knowledge connector ingests approved articles with version, owner, A… | SPEC-9.knowledge-ingestion, OPS-06 | knowledge.retrieval | WP-20 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-06-78 | software | Ingest from reviewed URL allowlists (no unrestricted crawling). | DATA-01, SAFE-05 | knowledge.retrieval | WP-20 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-06-79 | software | Ingest documents from object storage with safe parsing (HTML/PDF/DOCX/Markdown). | SPEC-9.knowledge-ingestion | knowledge.retrieval | WP-20 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-06-80 | software | Provide a generic KB API connector. | SPEC-9.knowledge-ingestion | knowledge.retrieval | WP-20 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-06-81 | software | Scan attachments and files from knowledge sources (malware/type/size) before pa… | SPEC-9.knowledge-ingestion, DATA-01 | knowledge.retrieval | WP-20 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-06-82 | software | Propagate source deletion/archival and manage index lifecycle (re-embed, purge… | DATA-03, OPS-06 | knowledge.retrieval | WP-20 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-06-83 | constraint | No unrestricted crawling during calls; retrieval uses only the approved indexed… | DATA-01, SAFE-05 | knowledge.retrieval | WP-20 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-06-84 | software | Provide a secure web companion application alongside voice. | AUTH-01, DATA-01 | companion.web | WP-27 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-06-85 | software | The secure web companion authenticates the person and binds the result to exact… | AUTH-01, AUTH-03, AUTH-06 | companion.web | WP-27 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-06-86 | software | The companion supports review of prepared actions and summaries. | ACT-01, DATA-04 | companion.web | WP-27 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-06-87 | software | The companion supports asynchronous replies for long-running cases. | SPEC-9.workflow | companion.web | WP-27 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-06-88 | software | Ship live email and SMS notification adapters with configured senders. | DATA-01, SPEC-9.notifications | notifications.messaging | WP-27 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-06-89 | software | Send notifications only to verified registered recipients. | AUTH-01, SPEC-9.notifications | notifications.messaging | WP-27 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-06-90 | software | Apply consent, preferences and quiet hours before any notification. | SPEC-9.notifications, DATA-03 | notifications.messaging | WP-27 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-06-91 | software | Record notification delivery receipts. | OPS-01, ACT-04 | notifications.messaging | WP-27 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-06-92 | software | Outbound voice is fully implemented but separately activated and budgeted. | OPS-05, SPEC-12.budget-cutoff, SAFE-05 | voice.outbound | WP-27 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-06-93 | software | Connector test wizard runs: validate configuration -> authenticate -> inspect m… | OPS-03, SPEC-16.prod-guard | operator.onboarding | WP-32 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-06-94 | software | The wizard performs write/reconcile tests only in an authorized sandbox. | OPS-05, ACT-02, ACT-03 | operator.onboarding | WP-32 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-06-95 | software | The wizard signs capability evidence. | OPS-03, OPS-06 | operator.onboarding | WP-32 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-06-96 | evaluation | Tests and evidence distinguish code pass, emulator pass and actual vendor pass. | OPS-03 | operator.onboarding | WP-32 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-06-97 | software | Inbound connector events and records (webhooks, CDC/Pub/Sub, CDP events, delive… | SPEC-8.outbox, OPS-01, OPS-03, ACT-02 | audit.independent | WP-04 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | 5 (NOT_RUN) |
| FO-06-98 | software | Inbound connector credentials (webhook signing secrets, shared bearer secrets,… | AUTH-06, SPEC-8.webhook-auth | ingress.events | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | 7 (NOT_RUN) |
| FO-06-99 | software | Every knowledge source connector, not only Salesforce Knowledge (also reviewed… | SPEC-9.knowledge-ingestion, OPS-06 | knowledge.retrieval | WP-20 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-06-100 | software | The generic SIP connector authenticates and restricts peers per profile (digest… | SAFE-04, AUTH-03, DATA-01 | telephony.sip | WP-12 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-06-101 | software | Outbound voice calls go through the same consent, preference, quiet-hours and k… | SPEC-9.notifications, AUTH-01, OPS-05, DATA-01 | voice.outbound | WP-27 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-07-01 | software | Provide 'full history' as a permissioned, searchable support timeline with expl… | SPEC-9.memory, DATA-01, SAFE-01 | context.store | WP-18 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-07-02 | software | Layer 1: canonical support timeline from permitted calls, messages, cases, task… | SPEC-9.memory, DATA-04 | context.store | WP-18 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-07-03 | software | Layer 2: low-latency current-state projections built from authenticated event i… | SPEC-12.bounded-caching | context.store | WP-18 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-07-04 | software | Layer 3: fresh authoritative lookups for volatile facts and before any conseque… | ACT-01, SPEC-8.commit-recheck, SPEC-9.recheck | context.assembly | WP-24 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-07-05 | software | Layer 4: task-specific ContextSnapshot assembled with current identity, purpose… | AUTH-02, AUTH-03, DATA-04 | context.assembly | WP-24 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-07-06 | software | ContextFact records source_system, source_record_id, source_version, event_id,… | DATA-04, OPS-06 | context.store | WP-18 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-07-07 | software | Ingestion time never overwrites business effective time (bitemporal facts). | DATA-04 | context.store | WP-18 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-07-08 | software | Maintain supersession/retraction, deletion and correction lineage of facts. | DATA-03, DATA-04 | context.store | WP-18 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-07-09 | software | Model-generated summary claims link to their supporting facts. | DATA-04 | context.assembly | WP-24 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-07-10 | software | Versioned canonical IDs with authoritative cross-system links and relationship… | AUTH-05, AUTH-03 | authority.registries | WP-19 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-07-11 | software | Keep ambiguous or unmatched identities quarantined. | AUTH-01, AUTH-05 | authority.registries | WP-19 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-07-12 | constraint | No fuzzy email/name/phone matching, shared-device linking, CDP alias, probabili… | AUTH-01, AUTH-05, DATA-04 | authority.registries | WP-19 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-07-13 | software | Deterministic enrolled links and current authority govern joins. | AUTH-05, AUTH-02 | authority.registries | WP-19 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-07-14 | software | Merges/splits require reviewed evidence, invalidate affected caches, and suppor… | AUTH-05, DATA-04 | authority.registries | WP-19 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-07-15 | constraint | Treat the identity graph itself as sensitive data. | DATA-01 | authority.registries | WP-19 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-07-16 | software | Authenticate every event ingress using the source's documented mechanism. | SPEC-8.webhook-auth, DATA-01 | ingress.events | WP-04 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | 9 (NOT_RUN) |
| FO-07-17 | software | Persist an encrypted durable inbox record before acknowledging an event. | ACT-02, DATA-02 | ingress.events | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | 8 (NOT_RUN) |
| FO-07-18 | software | Deduplicate by source/tenant/event identity and process at least once with cons… | ACT-02 | ingress.events | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | 8 (NOT_RUN) |
| FO-07-19 | software | Record payload digest, schema and the actual authentication mechanism per inges… | OPS-01, OPS-06 | audit.independent | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | 4 (NOT_RUN) |
| FO-07-20 | software | Preserve sequence/source version where available; tolerate duplicates, reorder,… | ACT-02, SAFE-04 | platform.substrate | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | 3 (NOT_RUN) |
| FO-07-21 | software | Quarantine unknown schemas/fields according to explicit contracts and alert; ne… | DATA-01, OPS-03 | ingress.events | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | 3 (NOT_RUN) |
| FO-07-22 | software | Keep approved raw replay artifacts in restricted storage, not ordinary logs. | DATA-01, DATA-02 | platform.substrate | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | 3 (NOT_RUN) |
| FO-07-23 | software | Track source low/high watermarks, checkpoint gaps, expected/delivered counts, s… | OPS-03 | context.store | WP-18 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-07-24 | software | A backfill must not roll back a newer live state. | ACT-02 | context.store | WP-18 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-07-25 | software | Distinguish source silence (no activity) from a broken feed using heartbeats an… | OPS-03 | context.store | WP-18 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-07-26 | software | Push newly accepted relevant events to the active conversation through versione… | ACT-05 | context.assembly | WP-24 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-07-27 | software | Relevant new events invalidate stale proposed answers and pending confirmations. | ACT-01, ACT-05 | context.assembly | WP-24 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-07-28 | software | An unrelated new event must not restart the whole conversation. | ACT-05 | context.assembly | WP-24 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-07-29 | constraint | Start protected context only after authorization; no pre-auth PHI model load. | AUTH-02, DATA-01, DATA-04 | context.assembly | WP-24 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-07-30 | software | Prefetch public knowledge or already-authorized reads; never speculative mutati… | ACT-01 | context.assembly | WP-24 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-07-31 | software | Select the current issue, relevant past interactions, promises, unresolved task… | SPEC-9.memory | context.assembly | WP-24 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-07-32 | software | Context retrieval is policy-filtered before search and checked again on return. | AUTH-02, AUTH-05 | context.assembly | WP-24 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-07-33 | software | Provide a small timeline summary plus explicit facts and citations, with bounde… | DATA-04 | context.assembly | WP-24 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-07-34 | software | Report covered sources, unavailable sources, watermarks, truncation, conflict a… | OPS-03 | context.assembly | WP-24 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-07-35 | software | Resolve field-specific source precedence by signed configuration; surface mater… | DATA-04, OPS-06 | context.assembly | WP-24 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-07-36 | software | Show staff why a fact was selected. | OPS-01 | context.assembly | WP-24 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-07-37 | evaluation | SLO: accepted event to projection p95 <= 5 seconds under healthy input (tenant-… | SPEC-12.capacity-model | context.store | WP-18 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-07-38 | evaluation | SLO: assembled cached context p95 <= 200 ms. | SPEC-12.capacity-model | context.assembly | WP-24 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-07-39 | software | Use source-specific maximum ages for context facts. | SPEC-12.bounded-caching | context.assembly | WP-24 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-07-40 | constraint | Authorization, consent revocation and mutation state use current enforcement, n… | AUTH-04, ACT-01 | context.assembly | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-07-41 | software | A warehouse snapshot that predates a recent payment triggers live verification… | ACT-04, DATA-04 | context.assembly | WP-24 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-07-42 | software | Cache keys include tenant, subject, role, purpose, policy/relationship version… | AUTH-05, AUTH-04 | context.assembly | WP-24 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-07-43 | constraint | Prevent cross-user cache hits, unbounded transcript storage and stale authoriza… | AUTH-05, DATA-01 | context.assembly | WP-24 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-07-44 | software | Export a subject's timeline under scoped permission. | DATA-01, AUTH-02 | privacy.operations | WP-22 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-07-45 | software | Correction workflow covering source facts, derivatives, embeddings and caches. | DATA-04, DATA-03 | privacy.operations | WP-22 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-07-46 | software | Access (subject access request) workflow. | DATA-01 | privacy.operations | WP-22 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-07-47 | software | Deletion workflow covering derivatives, embeddings and caches (subject-initiate… | DATA-03 | privacy.operations | WP-22 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-07-48 | constraint | Exclude psychotherapy/clinical notes and unrestricted record browsing from all… | SAFE-01, DATA-01 | context.store | WP-18 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-07-49 | software | A ContextSnapshot is bound to tenant, subject, role, purpose and session genera… | AUTH-03, AUTH-04, DATA-04, ACT-05 | context.assembly | WP-24 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-08-01 | software | Ship a production knowledge ingestion pipeline (validation, sanitization, appro… | SPEC-9.knowledge-ingestion, OPS-06, OPS-01 | knowledge.retrieval | WP-20 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-08-02 | software | Ship a knowledge management UI: ingest, review queue, approve/reject, release h… | SPEC-9.knowledge-ingestion, SPEC-16.console-functional | operator.studio | WP-33 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-08-03 | software | Each article/runbook records owner, audience, locale, jurisdiction, allowed int… | SPEC-9.knowledge-ingestion | knowledge.retrieval | WP-20 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-08-04 | software | Each article records its source URL/record reference. | OPS-06 | knowledge.retrieval | WP-20 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-08-05 | software | Parse and scan safely; defend against malicious instructions in content. | SAFE-05, SPEC-9.knowledge-ingestion | knowledge.retrieval | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-08-06 | software | Defend against malicious URLs in knowledge content. | SAFE-05, DATA-01 | knowledge.retrieval | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-08-07 | software | Defend against malicious attachments in knowledge sources. | DATA-01 | knowledge.retrieval | WP-20 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-08-08 | software | Defend against oversized files and inputs. | SPEC-9.knowledge-ingestion | knowledge.retrieval | WP-20 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-08-09 | software | Defend against index poisoning. | SAFE-05, AUTH-02 | knowledge.retrieval | WP-20 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-08-10 | constraint | Unapproved content is draft and never served. | SPEC-9.knowledge-ingestion | knowledge.retrieval | WP-20 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-08-11 | software | Use PostgreSQL full-text + pgvector hybrid retrieval with policy filters applie… | SPEC-9.retrieval, AUTH-02 | knowledge.retrieval | WP-20 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-08-12 | software | Use a qualified production embedding model for the approved corpus and queries. | DATA-01, OPS-06, OPS-04 | knowledge.retrieval | WP-20 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-08-13 | software | Use a qualified reranker in the retrieval pipeline. | SPEC-9.retrieval, OPS-06 | knowledge.retrieval | WP-20 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-08-14 | evaluation | Evaluate retrieval: recall@k, ranking quality, citation accuracy, source-versio… | SPEC-9.retrieval, OPS-03 | knowledge.retrieval | WP-20 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-08-15 | software | Tune retrieval per domain. | SPEC-9.retrieval | knowledge.retrieval | WP-20 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-08-16 | constraint | Keep structured transaction truth in source tools, not in knowledge. | DATA-04, ACT-04 | knowledge.retrieval | WP-20 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-08-17 | constraint | Expensive graph retrieval is optional and used only when measured gains justify… | SPEC-9.retrieval | knowledge.retrieval | WP-06 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | 3 (PASS) |
| FO-08-18 | constraint | A vector similarity score is never treated as a confidence score or an authoriz… | AUTH-02, OPS-03 | knowledge.retrieval | WP-20 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-08-19 | software | Approved public FAQ and protected operational knowledge are distinguishable. | AUTH-01, SPEC-9.retrieval | knowledge.retrieval | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-08-20 | software | Conflicting policies cause a clarification, fresh read or owned escalation. | SPEC-9.knowledge-ingestion, ACT-04 | knowledge.retrieval | WP-20 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-08-21 | software | Missing, expired or wrong-jurisdiction policies cause a clarification, fresh re… | SPEC-9.retrieval | knowledge.retrieval | WP-20 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-08-22 | software | No citation laundering: every material factual assertion resolves to an allowed… | ACT-05, DATA-04, ACT-04 | knowledge.retrieval | WP-20 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-08-23 | software | KnowledgeCitation pins the exact source version and span. | OPS-06 | knowledge.retrieval | WP-20 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-08-24 | software | Persistent memory is tenant-owned and exportable. | DATA-01, DATA-04 | privacy.operations | WP-22 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-08-25 | software | Store useful support preferences, open issues, promises, completed actions and… | SPEC-9.memory, DATA-04, DATA-03 | privacy.operations | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-08-26 | software | Separate caller reports from source facts. | DATA-04 | privacy.operations | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-08-27 | constraint | Do not infer diagnoses, vulnerability, personality, lifetime-value-based servic… | SAFE-01, DATA-04 | privacy.operations | WP-22 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-08-28 | constraint | Do not persist raw hidden model reasoning. | DATA-01 | conversation.harness | WP-10 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-08-29 | constraint | Memory cannot grant permission, establish medical facts, or override current so… | DATA-04, AUTH-03 | context.assembly | WP-24 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-08-30 | software | Support memory editing and correction with history. | DATA-04, OPS-01 | privacy.operations | WP-22 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-08-31 | software | Apply purpose limits to memory use. | DATA-01, DATA-04 | privacy.operations | WP-22 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-08-32 | software | Support memory deletion (subject- or staff-initiated) in addition to expiry. | DATA-03 | privacy.operations | WP-22 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-08-33 | constraint | Do not build a cross-customer transcript index. | DATA-01, AUTH-05 | privacy.operations | WP-22 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-08-34 | constraint | Do not build unrestricted nightly self-rewriting memory. | DATA-04 | privacy.operations | WP-22 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-08-35 | constraint | Tenant-isolated semantic caches apply the same disclosure checks as primary ret… | AUTH-02, AUTH-05 | knowledge.retrieval | WP-06 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | 6 (NOT_RUN) |
| FO-08-36 | software | Knowledge snapshots are pinned and released beyond local/CI only with an accoun… | OPS-06, OPS-04 | knowledge.retrieval | WP-20 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-08-37 | software | Knowledge approval is an accountable decision bound to the exact item digest. I… | SPEC-9.knowledge-ingestion, OPS-06, AUTH-03 | knowledge.retrieval | WP-20 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-08-38 | software | Retrieval uses the caller's or subject's applicable jurisdiction from a trusted… | SPEC-9.retrieval, AUTH-03 | knowledge.retrieval | WP-20 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-09-01 | software | Use frontier models for difficult planning/reasoning roles in the harness. | — | conversation.harness | WP-10 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-09-02 | software | Use smaller qualified models for routing, extraction, retrieval and monitoring… | — | models.registry | WP-09 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-09-03 | evaluation | Choose models on measured quality/latency/cost/privacy, not prestige, download… | OPS-03 | models.registry | WP-09 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-09-04 | software | Keep model routing and version selection deterministic and reviewable (pinned,… | OPS-06 | models.registry | WP-09 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-09-05 | constraint | An unavailable model cannot silently fall back to an unapproved region, endpoin… | DATA-01, OPS-06 | models.registry | WP-09 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-09-06 | software | Implement an actual managed-model adapter for Amazon Bedrock's documented API (… | — | models.providers | WP-08 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-09-07 | software | Implement an actual managed-model adapter for OpenAI's documented APIs (Respons… | — | models.providers | WP-08 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-09-08 | software | Implement a self-hosted OpenAI-compatible text inference adapter using vLLM whe… | — | models.providers | WP-08 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-09-09 | software | Keep provider-specific streaming, tool-result, cancellation, refusal, usage and… | — | models.providers | WP-08 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-09-10 | constraint | Do not claim every audio model can run through vLLM; run each audio model on it… | — | models.registry | WP-09 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-09-11 | environment | Govern the release pin by current provider catalogues, entitlements and endpoin… | OPS-06 | models.providers | WP-08 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-09-12 | software | Make at least one complete real model path configurable now (end to end: config… | — | conversation.harness | WP-10 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-09-13 | software | ModelRegistry records role, publisher/model/revision and endpoint/API/region fo… | OPS-06 | models.registry | WP-09 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-09-14 | software | ModelRegistry records license and usage restrictions, gated-access terms and vo… | — | models.registry | WP-09 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-09-15 | software | ModelRegistry records weight and tokenizer digests where hosted locally, and ac… | OPS-06 | models.registry | WP-09 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-09-16 | software | ModelRegistry records context window, structured-output, tool and audio capabil… | — | models.registry | WP-09 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-09-17 | software | ModelRegistry records data egress/retention terms, timeout, token/compute budge… | DATA-01, DATA-03 | models.registry | WP-09 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-09-18 | software | ModelRegistry records evaluation results and the approved fallback graph. | OPS-03 | models.registry | WP-09 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-09-19 | evaluation | Frontier planner candidates: compare at least two model families in the qualifi… | — | models.registry | WP-09 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-09-20 | evaluation | Qualify the open-weight text/tool candidate Qwen/Qwen3.6-35B-A3B against the ba… | — | models.registry | WP-09 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-09-21 | constraint | Treat deepseek-ai/DeepSeek-V4-Pro (MIT, preview) and Qwen/Qwen3.8-Flash-Next (Q… | — | models.registry | WP-09 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-09-22 | constraint | Open weights hosted in approved infrastructure are a different data path from a… | DATA-01 | models.registry | WP-09 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-09-23 | software | Retrieval models: BAAI/bge-m3 embeddings and BAAI/bge-reranker-v2-m3 reranker,… | — | knowledge.retrieval | WP-20 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-09-24 | software | ASR and independent audio corroboration with openai/whisper-large-v3-turbo, add… | DATA-02 | voice.speech | WP-13 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-09-25 | software | VAD: maintained Silero VAD through its supported runtime, tested for speech imp… | — | voice.speech | WP-13 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-09-26 | software | Controlled local TTS candidate hexgrad/Kokoro-82M, subject to voice provenance,… | — | voice.speech | WP-13 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-09-27 | software | Implement a managed controlled-TTS adapter (in addition to the local candidate). | — | voice.speech | WP-13 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-09-28 | software | Provide independent pre-rendered fallback clips (not produced at runtime by the… | OPS-02, SAFE-03 | safety.routing | WP-15 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-09-29 | constraint | A model licence does not license an arbitrary cloned voice: record voice proven… | — | models.registry | WP-09 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-09-30 | evaluation | General safety auxiliary allenai/wildguard: evaluate permitted use (gated, resp… | SAFE-01, SAFE-02 | safety.routing | WP-15 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-09-31 | evaluation | Native-audio experiments (nvidia/personaplex-7b-v1, Qwen/Qwen3-Omni-30B-A3B-Ins… | — | voice.native | WP-16 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-09-32 | software | Managed native voice adapters for GPT-Live and Nova 2.5 Sonic under their exact… | — | voice.native | WP-16 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-09-33 | document | Verify every model card, exact artifact licence, dependencies, commercial/healt… | — | models.registry | WP-09 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-09-34 | constraint | Never load arbitrary pickle/remote code; prefer safe formats (safetensors) or a… | — | models.registry | WP-09 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-09-35 | software | Pin model revisions/checksums, scan images, generate SBOM and model manifests,… | OPS-06 | release.supply_chain | WP-40 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-09-36 | constraint | All mandatory features remain buildable and testable with emulators and without… | OPS-03, OPS-05 | models.providers | WP-08 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-09-37 | software | Harness keeps typed state: current verified goal, candidate intents, context re… | — | conversation.harness | WP-10 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-09-38 | software | Bounded iterations, parallelism, wall-clock deadlines and token/compute budgets… | SAFE-03 | conversation.harness | WP-10 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-09-39 | software | A specialist can return evidence and proposals but cannot overwrite trusted sta… | AUTH-03, ACT-01 | conversation.harness | WP-10 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-09-40 | software | Capability allowlists per role/intent in the harness (which tools a model may p… | AUTH-02 | conversation.harness | WP-10 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-09-41 | software | Strict tool schema and output validation at the trusted boundary; no general sh… | AUTH-02, AUTH-03, SPEC-8.ledger | conversation.harness | WP-10 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-09-42 | software | Model instructions are kept separate from caller, document and tool-content dat… | SPEC-3.trust-boundaries | conversation.harness | WP-10 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-09-43 | software | Enforce scopes outside the model: authorization, tenant, subject and destinatio… | AUTH-02, SAFE-05 | conversation.harness | WP-10 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-09-44 | constraint | Deterministic authorization, confirmation and effect verification always outran… | ACT-01, ACT-04 | actions.effects | WP-25 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-09-45 | software | Model calls use deadline propagation, cancellation, backpressure and circuit br… | OPS-02 | models.providers | WP-08 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-09-46 | software | Model refusal handling and a safe, useful fallback (approved template or human… | SAFE-03, OPS-02 | models.providers | WP-08 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-09-47 | software | Audit model invocations with minimized metadata (ModelInvocation / ModelDecisio… | OPS-06, DATA-01, DATA-03 | conversation.harness | WP-10 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-09-48 | software | A safety semantic classifier produces routing signals with uncertainty/reason c… | SAFE-01, SAFE-02 | safety.routing | WP-15 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-09-49 | evaluation | Build a clinician-reviewed safety routing evaluation dataset; never train on sc… | SAFE-01, SAFE-02 | evaluation.monitors | WP-35 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-09-50 | constraint | Own prompt/tool/model version boundaries; a framework or SDK does not supply ca… | OPS-06 | models.registry | WP-09 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-09-51 | evaluation | Executable model bake-off reporting per-task success, repeated-trial reliabilit… | OPS-03 | models.registry | WP-09 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-09-52 | software | Champion/challenger configuration: real results select a champion; absent resul… | OPS-03 | models.registry | WP-09 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-09-53 | constraint | Public availability of a model or its weights is not patient-use validation: a… | OPS-03, OPS-06 | models.registry | WP-09 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-09-54 | constraint | Never train, fine-tune or tune prompts/classifiers on scraped therapy or patien… | DATA-01, DATA-02, SAFE-01 | evaluation.monitors | WP-35 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-10-01 | software | Build actual media ingress/egress (RTP/WebRTC audio in and out of the conversat… | — | voice.media_runtime | WP-11 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-10-02 | software | Codec conversion between telephony and model formats (G.711 mu-law/A-law 8 kHz,… | — | voice.media_runtime | WP-11 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-10-03 | software | WebRTC/SIP bridging: a documented SIP reference route so the product runs witho… | OPS-02 | telephony.sip | WP-12 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-10-04 | software | Streaming ASR in the call path. | — | voice.speech | WP-13 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-10-05 | software | Endpointing (end-of-turn decision) distinct from voice-activity detection. | — | voice.speech | WP-13 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-10-06 | software | Interruption (barge-in) detection in the media runtime. | ACT-05, SPEC-11.barge-in | voice.speech | WP-13 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-10-07 | software | Speech queueing in the runtime (gate-issued segments only, per-call ordering). | ACT-05 | voice.release_boundary | WP-14 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-10-08 | software | Playback receipts (what was actually played, when, and whether it completed or… | ACT-05, OPS-01 | voice.release_boundary | WP-14 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-10-09 | software | Call lifecycle in the media runtime (join, participant changes, hold, transfer… | AUTH-04 | voice.media_runtime | WP-11 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-10-10 | constraint | A browser animation or transcript replay is not a telephone implementation (no… | OPS-03 | voice.release_boundary | WP-14 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-10-11 | software | Identify the company and automated support role, accurately disclose processing… | DATA-03, SAFE-01 | voice.release_boundary | WP-14 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-10-12 | software | Warm, calm, short, concrete language; one question at a time; no apology loops,… | SAFE-01 | conversation.harness | WP-10 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-10-13 | software | Remember authorized information already given and clarify ambiguity instead of… | — | conversation.harness | WP-10 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-10-14 | software | Read names, numbers, dates and currency carefully and confirm the timezone. | ACT-01 | voice.release_boundary | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-10-15 | software | Distinguish backchannels, background speech and meaningful interruption. | — | voice.speech | WP-13 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-10-16 | software | Support long pauses, stuttering and speech impairment without cutting the calle… | — | voice.speech | WP-13 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-10-17 | software | Interpreter route and relay/accessibility accommodations (relay users, TTY) car… | SPEC-11.interpreter | safety.routing | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-10-18 | software | Slower playback, repeat on request and DTMF navigation in the runtime. | — | voice.media_runtime | WP-11 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-10-19 | constraint | No diagnostic or mental-state inference from prosody or voice. | SAFE-01, DATA-02 | voice.speech | WP-13 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-10-20 | software | Return to legitimate work after an attack/refusal when safe; do not punish the… | SAFE-03, AUTH-01 | conversation.harness | WP-10 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-10-21 | software | Acknowledgments are brief and truthful: 'checking' only when work is actually d… | ACT-04 | voice.release_boundary | WP-14 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-10-22 | software | SpeechPlan contract: utterance_class, exact text or bounded allowed paraphrase,… | ACT-05, OPS-06 | voice.release_boundary | WP-14 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-10-23 | software | Pre-emission check 1a: validate authorization before any applicable audio escap… | ACT-05, AUTH-02 | voice.release_boundary | WP-14 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-10-24 | software | Pre-emission check 1b: validate source freshness of the facts being spoken. | ACT-05 | context.assembly | WP-24 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-10-25 | software | Pre-emission check 2: validate facts, amounts, dates, outcome language, scope a… | ACT-05, ACT-04 | voice.release_boundary | WP-14 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-10-26 | software | Pre-emission check 3: render using the permitted path (approved template throug… | ACT-05 | voice.release_boundary | WP-14 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-10-27 | software | Pre-emission check 4: re-check session generation, turn and cancellation at enq… | ACT-05, SPEC-11.barge-in | voice.release_boundary | WP-14 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-10-28 | software | Pre-emission check 5: record approved content/audio digest and actual emitted/p… | ACT-05, OPS-01 | voice.release_boundary | WP-14 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-10-29 | software | Enforce the five checks before ANY applicable audio escapes; the runtime, not a… | ACT-05 | voice.release_boundary | WP-14 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-10-30 | software | Fixed clinician/legal-approved wording for safety, identity, disclosure and mat… | SAFE-01, ACT-05, OPS-04 | voice.release_boundary | WP-14 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-10-31 | software | Deterministic trusted slots for financial and account facts. | ACT-05 | voice.release_boundary | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-10-32 | software | Permit bounded grounded paraphrase for low-risk explanation (LOW_RISK_GROUNDED)… | ACT-05 | voice.release_boundary | WP-14 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-10-33 | evaluation | Qualify exact readouts with pronunciation/number controls, listen-back tests an… | — | voice.cascade | WP-17 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-10-34 | constraint | Do not claim mathematical audio fidelity from a transcript judge. | OPS-03 | governance.documents | WP-44 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-10-35 | software | Native audio generated behind a buffer is checked against authorized source fac… | ACT-05 | voice.native | WP-16 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-10-36 | constraint | A judge alone is not an authorization boundary. | ACT-05 | voice.release_boundary | WP-14 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-10-37 | software | Keep actual audio, model transcript and independent ASR transcript as separate… | DATA-02 | voice.cascade | WP-17 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-10-38 | software | Interruptions invalidate pending speech and ambiguous confirmations and increme… | ACT-01, ACT-05, SPEC-11.barge-in | voice.release_boundary | WP-14 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-10-39 | software | On interruption flush provider AND local playback buffers. | ACT-05 | voice.speech | WP-13 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-10-40 | software | Cancelling speech does not prove a business action was cancelled: reconcile any… | ACT-03 | voice.release_boundary | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-10-41 | software | Late tool results may update a still-authorized case but may not speak into a n… | ACT-05 | voice.release_boundary | WP-14 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-10-42 | software | Call-owner leases and fencing prevent two replicas from speaking for the same c… | ACT-05 | voice.release_boundary | WP-14 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-10-43 | software | Fencing prevents two replicas from committing the same action/record. | ACT-02 | actions.effects | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | 6 (NOT_RUN) |
| FO-10-44 | evaluation | Test worker crash, reconnect, session expiry, participant changes and rolling d… | AUTH-04, ACT-02 | operations.resilience_cost | WP-42 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-10-45 | software | Authority, case state and accepted actions survive a crash (ephemeral audio fra… | ACT-02, OPS-01 | operations.resilience_cost | WP-42 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-10-46 | software | Recovery starts a correctly bound session or a human route. | AUTH-04, OPS-02 | voice.media_runtime | WP-11 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-10-47 | software | Independently available, licensed, versioned fallback audio for model, ASR, TTS… | OPS-02, SAFE-03 | safety.routing | WP-15 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-10-48 | constraint | A generative model must not generate its own last-resort safety/error instructi… | SAFE-03 | safety.routing | WP-15 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-10-49 | software | Keep the telephony route usable when the whole AI service is down (independent… | OPS-02 | continuity.ai_off | WP-15 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-10-50 | software | Never leave a failed safety response as silence. | SAFE-03 | safety.routing | WP-15 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-10-51 | evaluation | Measure end-of-caller-speech to first meaningful handset audio. | — | voice.cascade | WP-17 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-10-52 | evaluation | Measure actual barge-in onset to last audible bot audio, and detection latency… | — | voice.cascade | WP-17 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-10-53 | evaluation | Timestamp ASR, reasoning, tools, validation, synthesis, buffers and network sep… | — | voice.cascade | WP-17 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-10-54 | constraint | Cached clips and a fast local loop do not establish PSTN latency (report separa… | OPS-03 | voice.cascade | WP-17 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-11-01 | software | Preserve the prepare -> confirm -> commit -> reconcile protocol. | ACT-01, ACT-02, ACT-03, SPEC-8.ledger | actions.effects | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-11-02 | software | Extend the protocol across real connectors (live ProviderCommitPort implementat… | ACT-02, OPS-04 | domain.business_systems | WP-23 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-11-03 | constraint | Model proposals cannot set actor, target authority, fees or success. | AUTH-03, ACT-01 | conversation.harness | WP-10 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-11-04 | software | PreparedAction contains source-grounded target, operation, exact parameters, be… | ACT-01, SPEC-8.ledger | actions.effects | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-11-05 | software | PreparedAction records explicit preconditions and source provenance (source rec… | ACT-01 | actions.effects | WP-25 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-11-06 | software | Present material consequences to the caller before confirmation. | ACT-01, ACT-05 | actions.effects | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-11-07 | software | ConfirmationReceipt binds a fresh affirmation on a trusted channel to the diges… | ACT-01 | actions.effects | WP-25 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-11-08 | constraint | An earlier 'yes', a provider approval for another subject, or a model-generated… | ACT-01 | actions.effects | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-11-09 | software | Material parameter changes require a new confirmation. | ACT-01 | actions.effects | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-11-10 | software | Commit atomically records durable intent, unique action/idempotency identity an… | ACT-02, OPS-01 | actions.effects | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-11-11 | software | Record an outbox entry for the dispatch before dispatch (transactional outbox)… | ACT-02 | actions.effects | WP-25 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-11-12 | software | Commit rechecks current authority, source state, confirmation and policy. | ACT-01, AUTH-02, AUTH-04 | actions.effects | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-11-13 | software | Enforce optimistic concurrency, action ownership leases, fencing and uniqueness. | ACT-02 | actions.effects | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | 4 (NOT_RUN) |
| FO-11-14 | software | Retries use the same provider idempotency key, never a new action. | ACT-02 | actions.effects | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-11-15 | software | Track NOT_STARTED, DISPATCHED, COMMITTED, FAILED, UNKNOWN and reconciled states. | ACT-03 | actions.effects | WP-25 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-11-16 | software | A timeout may occur after the effect: reconcile with authoritative lookup, exte… | ACT-03 | actions.effects | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-11-17 | software | 'Not found' is not definitive before the provider's documented visibility windo… | ACT-03 | actions.effects | WP-25 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-11-18 | software | Route unreconcilable operations to a human; never guess or retry an uncertain n… | ACT-03, OPS-02 | actions.effects | WP-25 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-11-19 | software | EffectVerification independent of the model and response text: query the source… | ACT-04, OPS-01 | actions.effects | WP-25 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-11-20 | software | For eventual consistency report accepted/pending until verified. | ACT-04 | actions.effects | WP-25 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-11-21 | constraint | Compensation requires domain policy and current authority; it is not a generic… | ACT-02 | actions.effects | WP-25 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-11-22 | software | Reconcile case state and external state after restart. | ACT-03, OPS-01 | workflows.durable | WP-26 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-11-23 | software | Allow synchronous approved actions within voice deadlines. | — | actions.effects | WP-25 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-11-24 | software | Long-running work uses a narrow durable ActionGrant tied to actor/subject, enum… | SPEC-7.privilege-expiry, AUTH-04 | actions.effects | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-11-25 | software | ActionGrant also binds purpose, the exact prepared action (digest) or explicit… | ACT-01, SPEC-7.privilege-expiry | actions.effects | WP-25 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-11-26 | constraint | A grant never reuses an expired call token and never waives fresh confirmation… | ACT-01, AUTH-04 | actions.effects | WP-25 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-11-27 | software | Recheck authority before each disclosure or effect performed under a grant. | AUTH-04, SPEC-9.recheck | authority.registries | WP-19 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-11-28 | software | Ask through the secure companion when a material change needs new confirmation… | ACT-01 | companion.web | WP-27 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-11-29 | software | Suspended work retains an owner and a deadline. | SPEC-9.workflow | actions.effects | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-11-30 | software | Support per-issue outcome labels RESOLVED_WITH_EVIDENCE / INFORMATION_PROVIDED… | ACT-04, SAFE-04 | actions.effects | WP-25 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-11-31 | software | Preserve reopened and partially resolved states. | ACT-04 | actions.effects | WP-25 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-11-32 | software | Classify every provider operation as idempotent (honours the provider idempoten… | ACT-02, ACT-03 | actions.effects | WP-25 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-12-01 | software | Implement all existing workflows and the Section 20 catalogue through productio… | SPEC-3.workflow-engine, SPEC-9.workflow | workflows.durable | WP-26 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-12-02 | software | Cases survive hang-up, model replacement, worker crash and deployment. | ACT-04, OPS-01 | workflows.durable | WP-26 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-12-03 | software | Every nonterminal case/task has owner, next action, deadline, retry budget, esc… | SPEC-9.workflow | workflows.durable | WP-26 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-12-04 | software | No abandoned task or endless polling loop. | SAFE-03, SPEC-9.workflow | actions.effects | WP-25 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-12-05 | software | Durable workflow states ACCEPTED, VALIDATING, WAITING_FOR_SYSTEM/HUMAN/CALLER,… | SPEC-9.workflow | workflows.durable | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-12-06 | software | Add the INVESTIGATING, VERIFYING_EFFECT and EXPIRED durable workflow states. | ACT-04 | workflows.durable | WP-26 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-12-07 | software | Record versioned transitions and causal events. | OPS-01, SPEC-15.rollback | workflows.durable | WP-26 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-12-08 | software | Use authenticated human approvals for human tasks. | AUTH-02, SPEC-9.task-tokens | workflows.durable | WP-26 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-12-09 | software | Timers, timeouts and cancellation for durable work. | SPEC-9.workflow | workflows.durable | WP-26 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-12-10 | software | Vendor events, bounded polling and backoff drive workflow system steps (and rec… | SPEC-9.workflow, ACT-03 | workflows.durable | WP-26 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-12-11 | software | Domain-approved compensation and reconciliation inside workflows. | ACT-02 | workflows.durable | WP-26 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-12-12 | constraint | Never expose workflow task tokens in links; a model can never complete human ta… | AUTH-02, AUTH-03 | workflows.durable | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-12-13 | software | Billing disputes, claim investigations, provider document/remittance issues, re… | SPEC-9.workflow | workflows.families | WP-30 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-12-14 | software | Those workflows execute real investigation/commit steps, not only waits and hum… | ACT-04 | workflows.families | WP-30 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-12-15 | software | Keep source status, human decision, customer confirmation and verified downstre… | ACT-04 | actions.effects | WP-25 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-12-16 | software | Link repeated contact to the right issue through deterministic relationships. | AUTH-05, DATA-04 | authority.registries | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-12-17 | software | Reviewable matching for ambiguous repeat contact; never merge different people'… | AUTH-05 | authority.registries | WP-19 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-12-18 | software | Handle concurrent calls, multiple issues per call, abandoned contacts, duplicat… | ACT-02, ACT-04 | workflows.families | WP-30 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-12-19 | software | A resolved case may reopen; preserve history. | ACT-04 | workflows.families | WP-30 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-12-20 | software | Long-horizon plans with executable bounded steps drawn from approved capabiliti… | — | workflows.families | WP-30 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-12-21 | constraint | Replanning may change the investigation but never self-expand authority. | AUTH-02 | workflows.families | WP-30 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-12-22 | software | Retain the policy snapshot for explanation but apply current revocations, legal… | AUTH-04, SPEC-9.recheck | workflows.families | WP-30 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-12-23 | software | Workflow version migrations require compatibility tests and an explicit in-flig… | SPEC-15.rollback | workflows.durable | WP-26 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-12-24 | software | Step Functions lifetime/history limits must not truncate the durable case recor… | SPEC-3.workflow-engine | workflows.durable | WP-26 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-12-25 | software | Follow-up notifications use neutral content and secure links, registered and ve… | DATA-01 | notifications.messaging | WP-27 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-12-26 | software | Frequency and contact caps for notifications. | — | notifications.messaging | WP-27 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-12-27 | software | STOP/opt-out handling and revocation for notifications. | DATA-03 | notifications.messaging | WP-27 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-12-28 | software | Send follow-up notifications through a production adapter. | OPS-04 | notifications.messaging | WP-27 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-12-29 | software | Delivery is not receipt or resolution (track delivered vs read/acted vs resolve… | ACT-04 | notifications.messaging | WP-27 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-12-30 | software | Outbound calls require separately activated country/recipient, purpose, consent… | OPS-05, DATA-03 | voice.outbound | WP-27 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-12-31 | constraint | Inbound permission is never blanket outbound consent. | DATA-03 | notifications.messaging | WP-27 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-12-32 | constraint | Public emergency lines must never receive synthetic tests. | OPS-05, SAFE-05 | notifications.messaging | WP-27 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-13-01 | software | Implement semantic safety routing signals (a real, qualified semantic classifie… | SAFE-02, SPEC-10.safety-signals | safety.routing | WP-15 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-13-02 | software | Deterministic safety rules plus caller and human requests route to the safety p… | SAFE-02, SPEC-10.safety-response | safety.routing | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-13-03 | evaluation | Cover explicit and indirect concerns, negation, past/third-party speech, idioms… | SAFE-02, SPEC-10.signal-test-coverage, SPEC-10.safety-signals | safety.routing | WP-15 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-13-04 | software | Do not label every frustrated caller an emergency. | SPEC-10.signal-test-coverage | safety.routing | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-13-05 | software | Classifier failure or uncertainty uses an approved fallback; never a silent fai… | SAFE-03 | safety.routing | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-13-06 | software | On a validated or unresolved safety concern pause ordinary administrative work… | SAFE-03, ACT-01, SPEC-10.safety-response | safety.routing | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-13-07 | software | Play the approved fixed safety acknowledgment. | SAFE-01, SAFE-03 | safety.routing | WP-15 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-13-08 | software | Initiate the appropriate human route on a safety concern. | SAFE-02, SAFE-03 | handoff.transfer | WP-28 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-13-09 | constraint | No authentication or payment prerequisite for safety routing or human requests. | SAFE-02 | safety.routing | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-13-10 | constraint | No diagnosis, clinical risk assessment, therapy, medication guidance or autonom… | SAFE-01 | conversation.harness, safety.routing | WP-10 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-13-11 | document | The clinical safety owner defines immediate-danger, ambiguous, third-party, ref… | SAFE-03 | safety.routing | WP-15 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-13-12 | software | The runtime supports configurable per-procedure behaviour (third-party concern,… | SAFE-03 | safety.routing | WP-15 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-13-13 | software | Route selection comes from trusted allowlisted queues/destinations. | SAFE-05 | handoff.transfer | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-13-14 | software | Route selection uses actual service hours and capacity of the destinations. | OPS-02, SAFE-03 | handoff.transfer | WP-28 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-13-15 | constraint | Never dial arbitrary user-, model- or document-supplied numbers. | SAFE-05 | handoff.transfer | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-13-16 | constraint | External emergency/crisis contact requires an approved operational protocol, ge… | SAFE-01, SAFE-05, SPEC-10.no-auto-external-crisis | safety.routing | WP-15 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-13-17 | software | Transfer event model REQUESTED, QUEUED, RECEIVER_ACCEPTED, BRIDGED, CALLER_CONF… | SAFE-04, SPEC-10.transfer | handoff.transfer | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-13-18 | software | Persist authenticated provider transfer events with event ids and causal timest… | SAFE-04, OPS-01 | handoff.transfer | WP-28 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-13-19 | software | Accept duplicate and out-of-order delivery and derive state only when prerequis… | SAFE-04, SPEC-10.transfer | handoff.transfer | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-13-20 | software | Use a durable inbox for transfer/carrier events. | SAFE-04, OPS-01 | handoff.transfer | WP-28 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-13-21 | constraint | A late event cannot rewrite a failed historical audio connection into success. | SAFE-04 | handoff.transfer | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-13-22 | software | Verify receiver identity and queue eligibility before counting acceptance. | SAFE-04, AUTH-05 | handoff.transfer | WP-28 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-13-23 | software | Verify receipt of the HandoffPackage by the receiver. | SAFE-04 | handoff.transfer | WP-28 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-13-24 | software | Require human acceptance and carrier/media connection evidence; a self-reported… | SAFE-04 | handoff.transfer | WP-28 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-13-25 | software | Keep the caller on the line during a warm transfer (never end the call). | OPS-02, SAFE-03 | handoff.transfer | WP-28 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-13-26 | software | Correct hold/media mixing during warm transfer and measure both legs. | SAFE-04 | handoff.transfer | WP-28 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-13-27 | software | If the receiver is unavailable, retain ownership, give truthful status and foll… | SAFE-03, OPS-02 | handoff.transfer | WP-28 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-13-28 | software | HandoffPackage contains permitted issue summary, assurance and its limits, subj… | DATA-01, SAFE-04 | handoff.transfer | WP-28 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-13-29 | software | Avoid making callers repeat information already delivered (package is delivered… | — | operator.console | WP-38 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-13-30 | software | A human can decline: record the decline and route explicitly instead of abandon… | SAFE-03, SAFE-04 | handoff.transfer | WP-28 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-13-31 | evaluation | Priority-route initiation within 2 seconds after the validated signal, measured. | SAFE-03, SPEC-10.safety-latency | voice.cascade | WP-17 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-13-32 | evaluation | Also measure time from the actual utterance to detection. | SPEC-10.safety-latency | voice.cascade | WP-17 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-13-33 | operations | A <=30-second staffed connection is a separate operations commitment, not an LL… | SAFE-03, OPS-02 | safety.routing | WP-15 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-13-34 | software | Expiring timers, refusal counters, cost limits and max turns never silently aba… | SAFE-03, SPEC-2.guardrail-exit | safety.routing | WP-15 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-13-35 | environment | An independent telephony continuity route remains available. | OPS-02 | continuity.ai_off | WP-15 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-14-01 | software | Console controls work against actual APIs (no hard-coded metrics) with useful e… | SPEC-13.console, SPEC-16.console-functional | operator.console | WP-38 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-14-02 | software | Console is a workforce-SSO product in production composition: live OIDC verific… | SPEC-7.workforce-separation, AUTH-02, AUTH-03, OPS-04 | identity.workforce | WP-05 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-14-03 | software | Server-enforced role separation for every console endpoint, with authorization… | AUTH-02, SPEC-7.workforce-separation, SPEC-13.audit-access | operator.console | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-14-04 | software | Tenant onboarding: connector catalogue. | SPEC-16.integration-records | operator.onboarding | WP-32 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-14-05 | software | Tenant onboarding: credential references (never secret values) managed through… | OPS-06, SPEC-8.service-identities | operator.configuration | WP-31 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-14-06 | software | Tenant onboarding: field and identity mapping per connector. | SPEC-4.audience-permissions, AUTH-03 | operator.onboarding | WP-32 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-14-07 | software | Tenant onboarding: source coverage and freshness view. | SPEC-9.retrieval | operator.onboarding | WP-32 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-14-08 | software | Tenant onboarding: purposes, regions and retention configured per tenant. | DATA-03, SPEC-6.data-classes | operator.onboarding | WP-32 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-14-09 | software | Tenant onboarding: test wizard and capability-by-capability readiness. | OPS-03, OPS-04, SPEC-16.prod-guard | operator.onboarding | WP-32 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-14-10 | software | Import/export of reviewed configuration, safely (no secrets, signed/digested, v… | OPS-06 | operator.configuration | WP-31 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-14-11 | software | Agent Studio: brand, voice and locale settings. | SPEC-11.voice-selection, OPS-06 | operator.studio | WP-33 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-14-12 | software | Agent Studio: supported intents configuration. | SPEC-4.resolution-contracts, SPEC-4.workflow-catalogue | operator.studio | WP-33 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-14-13 | software | Agent Studio: bounded workflows configuration. | SPEC-9.workflow, SPEC-3.workflow-engine | operator.studio | WP-33 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-14-14 | software | Agent Studio: knowledge ingestion and approval. | SPEC-9.knowledge-ingestion, OPS-06 | operator.studio | WP-33 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-14-15 | software | Agent Studio: prompt and model role configuration. | OPS-06, SPEC-2.model-evidence | operator.studio | WP-33 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-14-16 | software | Agent Studio: allowed actions and escalation routes. | SPEC-10.transfer, SPEC-8.tool-surface, SAFE-02 | operator.studio | WP-33 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-14-17 | software | Agent configuration lifecycle: draft -> test -> independent review -> publish -… | SPEC-15.pilot-promotion, SPEC-15.rollback, SPEC-15.no-self-promotion, OPS-06 | operator.configuration | WP-31 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-14-18 | constraint | No natural-language setting may override an invariant or add arbitrary executab… | SPEC-8.tool-surface, OPS-06, AUTH-02 | operator.configuration | WP-31 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-14-19 | software | Calls and cases: live call state. | SPEC-13.console | operator.console | WP-38 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-14-20 | software | Calls and cases: source-grounded timeline and current identity scope. | SPEC-13.console, AUTH-03 | operator.console | WP-38 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-14-21 | software | Calls and cases: tasks, pending actions, receipts and failures. | ACT-04, SPEC-13.console | operator.console | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-14-22 | software | Calls and cases: handoff and authorized takeover/join of a live call. | SAFE-04, SPEC-10.transfer | operator.console | WP-38 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-14-23 | software | Work queue: approvals (human workflow tasks). | SPEC-9.task-tokens, SPEC-9.workflow | workflows.durable | WP-26 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-14-24 | software | Work queue: uncertain outcomes and reconciliation. | ACT-03, ACT-02 | operator.console | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-14-25 | software | Work queue: dead-letter queue repair. | SPEC-8.outbox | operator.console | WP-38 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-14-26 | software | Work queue: missed deadlines. | SPEC-9.workflow | operator.console | WP-38 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-14-27 | software | Work queue: stale context. | SPEC-9.retrieval | operator.console | WP-38 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-14-28 | software | Work queue: consent and deletion work. | DATA-03 | operator.console | WP-38 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-14-29 | software | Work queue: human-owned exceptions. | ACT-04, SPEC-4.outcomes | operator.console | WP-38 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-14-30 | software | Evaluation Studio: corpus and version management. | SPEC-14.intent-corpus, SPEC-16.scenario-definition | evaluation.monitors | WP-35 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-14-31 | software | Evaluation Studio: scenario builder. | SPEC-16.scenario-definition | evaluation.monitors | WP-35 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-14-32 | software | Evaluation Studio: waveform and timeline replay. | SPEC-14.test-layers | evaluation.monitors | WP-35 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-14-33 | software | Evaluation Studio: expected versus observed state. | SPEC-14.scorecard | evaluation.monitors | WP-35 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-14-34 | software | Evaluation Studio: judge/human disagreement view. | SPEC-14.scorecard | evaluation.monitors | WP-35 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-14-35 | software | Evaluation Studio: slices and regression. | SPEC-14.aggregation | evaluation.monitors | WP-35 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-14-36 | software | Insights: verified resolution, repeat contact and reopens. | SPEC-13.resolution-metrics, ACT-04 | operator.console | WP-38 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-14-37 | software | Insights: unresolved promises, demand, customer effort, CSAT/response rate. | SPEC-13.resolution-metrics | operator.console | WP-38 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-14-38 | software | Insights: escalation appropriateness and cost per resolution. | SPEC-13.resolution-metrics, SPEC-12.capacity-model | operator.console | WP-38 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-14-39 | software | Investigations: trace call -> context -> model proposal -> policy -> action ->… | SPEC-13.audit-model, OPS-01 | operator.console | WP-38 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-14-40 | constraint | Investigations use access-controlled content references; no arbitrary SQL or un… | DATA-01, AUTH-02, SPEC-13.audit-access | operator.console | WP-38 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-14-41 | software | Controls: per-intent, per-model, per-integration, write, outbound and new-admis… | SPEC-13.killswitch, OPS-02, SAFE-03 | operator.console | WP-38 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-14-41a | software | Controls: the MODEL_VERSION and VOICE_VERSION kill switches are honoured wherev… | SPEC-13.killswitch, OPS-02, SAFE-03 | models.registry, voice.cascade, voice.native | WP-17 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-14-42 | software | Controls: quota and budget settings. | SPEC-12.budget-cutoff, OPS-05 | operator.console | WP-38 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-14-43 | software | Controls: rollout and rollback. | SPEC-15.rollback, SPEC-15.pilot-promotion | operator.console | WP-38 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-14-44 | software | Controls: policy and knowledge version comparison. | OPS-06, SPEC-14.policy-expansion | operator.console | WP-38 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-14-45 | software | Controls: incident workflows. | SPEC-13.incident-playbooks | operator.console | WP-38 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-14-46 | constraint | Killing AI retains appropriate human and safety continuity. | OPS-02, SAFE-03 | operator.console | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-14-47 | software | Validate console forms against runtime schemas. | SPEC-8.tool-schema | operator.console | WP-38 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-14-48 | software | Accessible keyboard and screen-reader flows; WCAG 2.2 AA engineering target. | SPEC-16.console-functional | operator.console | WP-38 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-14-49 | software | Timezone-aware times. | SPEC-16.console-functional | operator.console | WP-38 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-14-50 | software | Explicit confirmation for destructive operations. | SPEC-13.killswitch | operator.console | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-14-51 | software | SSO recovery works (IdP outage or lockout recovery path for operators). | SPEC-7.workforce-separation | identity.workforce | WP-05 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-14-52 | software | Operator offboarding works. | SPEC-7.workforce-separation, AUTH-02 | identity.workforce | WP-05 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-14-53 | constraint | Development bypasses cannot exist in production composition. | OPS-04 | platform.composition, identity.workforce | WP-07 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-14-54 | software | Tenant setup is configuration-driven, without rewriting core application code. | OPS-04, OPS-06, SPEC-16.prod-guard | operator.configuration | WP-31 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-14-55 | software | Unknown policy/retention/approval values stay explicit and block only the affec… | OPS-03, OPS-04, DATA-03 | operator.configuration | WP-31 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-14-56 | constraint | A demo's fabricated approval is technically unusable as a production approval. | OPS-04, OPS-05 | identity.caller | WP-07 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-14-57 | software | Pin configuration and audit who changed what. | OPS-06, SPEC-13.audit-model | operator.configuration | WP-31 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-15-01 | document | Maintain a control register with requirement/criterion, control, owner, frequen… | SPEC-14.threat-model | governance.documents | WP-44 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-15-02 | document | Control register covers HIPAA administrative, physical and technical safeguards… | SPEC-6.data-classes | governance.documents | WP-44 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-15-03 | document | Map chosen SOC 2 scope to Security, Availability, Confidentiality, Processing I… | — | governance.documents | WP-44 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-15-04 | constraint | HIPAA compliance and SOC 2 attestation are not claimed from code, checklists, B… | OPS-03 | governance.documents | WP-44 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-15-05 | document | Jurisdiction/processing-purpose policy matrix for counsel: HIPAA, HITECH breach… | SPEC-6.consent-before-recording, DATA-03 | governance.documents | WP-44 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-15-06 | document | Assess FTC Health Breach Notification Rule for non-HIPAA portions and FDA/inten… | — | governance.documents | WP-44 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-15-07 | document | Distinguish enacted/effective rules from proposals and guidance. | — | governance.documents | WP-44 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-15-08 | software | Unknown jurisdictions do not silently inherit the least restrictive policy. | OPS-03, AUTH-02 | privacy.operations | WP-22 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-15-09 | software | Part 2 applicability is program/record-specific; do not label all mental-health… | DATA-01 | privacy.operations | WP-22 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-15-10 | software | Psychotherapy and SUD-counseling notes are not treated as ordinary support cont… | DATA-01, DATA-04 | context.store | WP-18 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-15-11 | software | Exclude therapy notes/transcripts, diagnoses, medication histories and clinical… | DATA-01, DATA-04, SPEC-9.memory, SPEC-10.no-clinical-advice | context.assembly | WP-24 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-15-12 | constraint | Volunteered clinical speech makes the actual audio processing path sensitive. | DATA-02 | voice.speech | WP-13 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-15-13 | constraint | US-only deployment is a configurable organizational default, not a claim that H… | — | deploy.infrastructure | WP-39 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-15-14 | document | Inventory every processor, model, subprocessor, region, storage/index/cache, su… | DATA-01, SPEC-16.integration-records | governance.documents | WP-44 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-15-15 | environment | Contract coverage, BAA, permitted purpose and actual feature/endpoint settings… | DATA-01, OPS-05, SPEC-16.phi-endpoints-disabled | activation.qualification | WP-45 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-15-16 | software | Separate transient conversation, support business records, restricted QA media… | SPEC-6.data-classes, DATA-03 | privacy.operations | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-15-17 | software | Signed per-class retention policies with owner, legal holds, expiry, deletion v… | DATA-03 | privacy.operations | WP-22 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-15-18 | software | Raw audio and pre-redaction transcripts are sensitive; redaction is not de-iden… | DATA-02, SPEC-6.redaction | privacy.operations | WP-22 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-15-19 | constraint | Do not export raw payloads to general telemetry or judges. | DATA-01 | connectors.runtime, privacy.operations | WP-06 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | 2 (PASS) |
| FO-15-20 | constraint | Formal de-identification needs its separately supported method and evidence. | DATA-02 | governance.documents | WP-44 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-15-21 | software | No PHI or secrets in metric labels, trace baggage, resource names, URLs, except… | DATA-01, SPEC-6.no-phi-in-identifiers, AUTH-06 | privacy.operations, release.supply_chain | WP-40 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-15-22 | software | Restricted investigation records use opaque IDs and short-lived permission-chec… | AUTH-02, DATA-01 | operator.console | WP-38 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-15-23 | software | Encryption at rest and in transit. | SPEC-3.ingress | deploy.infrastructure | WP-39 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-15-24 | software | Private networking and egress allowlists. | DATA-01, SPEC-3.trust-boundaries | deploy.infrastructure | WP-39 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-15-25 | software | KMS grants scoped to service/resource/context and key rotation. | SPEC-3.trust-boundaries | deploy.infrastructure | WP-39 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-15-26 | software | Workload identities, short-lived OAuth, secret rotation and revocation. | SPEC-8.service-identities | connectors.runtime | WP-06 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | 10 (NOT_RUN) |
| FO-15-27 | operations | Certificate expiry monitoring and recovery procedures. | — | deploy.infrastructure | WP-39 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-15-28 | software | Separate key administration, application use, audit writing and audit reading. | OPS-01, SPEC-13.audit-access | audit.independent | WP-04 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | 1 (NOT_RUN) |
| FO-15-29 | software | Review SCPs, permission boundaries and deployment identity so an unrestricted I… | SPEC-14.supply-chain | deploy.infrastructure | WP-39 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-15-30 | software | Implement deletion across transcripts, audio, projections, summaries, embedding… | DATA-03 | privacy.operations | WP-22 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-15-31 | constraint | Preserve only legally required audit metadata/holds; Object Lock must not freez… | DATA-03, OPS-01 | privacy.operations | WP-39 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-15-32 | software | Tombstones and restore procedures prevent deleted data reappearing from backups. | DATA-03 | privacy.operations | WP-22 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-15-33 | software | Every accepted consequential action has durable evidence before acknowledgment. | OPS-01 | audit.independent | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | 2 (NOT_RUN) |
| FO-15-34 | software | Audit records carry event ID/schema, source sequence, UTC time, correlation/cau… | SPEC-13.audit-model, OPS-01 | audit.independent | WP-04 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-15-35 | constraint | Use structured decision summaries, not raw hidden chain-of-thought. | DATA-01 | conversation.harness | WP-10 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-15-36 | software | Append-only transactional ledger/outbox. | OPS-01, SPEC-8.ledger, SPEC-8.outbox | platform.substrate | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-15-37 | software | Independently administered audit sink. | OPS-01, SPEC-13.audit-integrity | audit.independent | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | 2 (NOT_RUN) |
| FO-15-38 | software | Immutable manifests with signatures. | SPEC-13.audit-integrity | platform.substrate | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | 7 (NOT_RUN) |
| FO-15-39 | software | Ingestion gap alerts. | SPEC-13.audit-integrity, OPS-03 | ingress.events | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-15-40 | software | Separate audit verifier. | SPEC-13.audit-integrity, OPS-03 | audit.independent | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | 13 (NOT_RUN) |
| FO-15-41 | software | Reconcile source action counts/IDs against exported evidence (a perfect chain c… | OPS-01, OPS-03 | audit.independent | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | 17 (NOT_RUN) |
| FO-15-42 | software | Separate audit read and write privileges. | SPEC-13.audit-access, AUTH-02 | audit.independent | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | 8 (NOT_RUN) |
| FO-15-43 | operations | Restrict Object Lock/KMS administrative access; test break-glass, export integr… | OPS-01 | deploy.infrastructure | WP-39 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-15-44 | software | During central audit outage, a bounded durable journal/outbox may buffer under… | OPS-01, SPEC-13.audit-outage | audit.independent | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | 2 (NOT_RUN) |
| FO-15-45 | software | Replace process-local emergency-route deferral with recoverable persistence or… | OPS-01, OPS-02, SAFE-03 | platform.substrate | WP-04 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | 47 (NOT_RUN) |
| FO-15-46 | software | If no durable action evidence can be recorded, block consequential actions. | OPS-01, SPEC-12.db-outage | platform.substrate | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | 1 (NOT_RUN) |
| FO-15-47 | software | Preserve unauthenticated human/safety routing through the independent telephony… | OPS-02, SAFE-02, SAFE-03 | continuity.ai_off | WP-15 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-15-48 | software | Surface every audit gap. | OPS-03 | audit.independent | WP-04 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | 7 (NOT_RUN) |
| FO-15-49 | document | Threat-model spoofing, replay, SIM swap, enumeration, session swapping, cross-t… | SPEC-14.threat-model | governance.documents | WP-44 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-15-50 | software | Validate webhook schemas and authentication before processing; handle payload l… | SPEC-8.webhook-auth | ingress.events | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | 9 (NOT_RUN) |
| FO-15-51 | software | CI pins dependencies, actions and images. | SPEC-14.supply-chain, OPS-06 | release.supply_chain | WP-40 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-15-52 | software | CI scans secrets, dependencies and IaC. | SPEC-14.supply-chain | release.supply_chain | WP-40 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-15-53 | software | Generate SBOM and provenance and sign artifacts. | SPEC-14.supply-chain, OPS-06 | release.supply_chain | WP-40 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-15-54 | software | Protected OIDC deployment identities. | SPEC-14.supply-chain, OPS-05 | deploy.infrastructure | WP-39 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-15-55 | evaluation | Run direct gateway attacks and independent security/pentest qualification; crit… | SPEC-14.hostile-gateway-tests, SPEC-14.pentest, OPS-03 | platform.invariants | WP-43 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-15-56 | document | Document operating evidence for access reviews, training, vendor review, incide… | SPEC-13.incident-playbooks | governance.documents | WP-44 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-15-57 | document | Keep the jurisdiction/processing-purpose policy matrix current (prompt section… | DATA-03, OPS-03 | privacy.operations | WP-22 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-16-01 | software | Ship reproducible local container composition. | SPEC-16.offline-first, SPEC-16.local-demo | platform.workspace | WP-03 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-16-02 | software | OCI images. | SPEC-14.supply-chain | release.supply_chain | WP-40 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-16-03 | software | Migrations. | SPEC-16.offline-first | platform.substrate | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | 3 (NOT_RUN) |
| FO-16-04 | software | Terraform modules and environments. | SPEC-3.ingress | deploy.infrastructure | WP-39 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-16-05 | software | Example configurations with synthetic values. | SPEC-16.prod-guard | platform.composition | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-16-06 | software | Preflight command. | OPS-04, OPS-05 | release.supply_chain | WP-40 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-16-07 | software | Deployment and rollback automation. | SPEC-15.rollback, OPS-05 | operations.commands | WP-41 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-16-08 | software | Smoke and qualification commands. | OPS-03 | activation.qualification | WP-45 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-16-09 | operations | Runbooks. | SPEC-13.incident-playbooks | governance.documents | WP-44 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-16-10 | software | Production rejects fixtures and missing mandatory data. | OPS-04, SPEC-16.prod-guard | platform.composition | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-16-11 | software | Resolve live dependency injection (no refusal of non-local composition). | OPS-04, SPEC-16.offline-first | platform.composition | WP-07 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-16-12 | constraint | Readiness is a system, not one boolean like production_ready or approve_all. | OPS-03, OPS-04 | operator.onboarding | WP-32 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-16-13 | software | Local OIDC test realm. | SPEC-14.test-layers | platform.workspace | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | 4 (NOT_RUN) |
| FO-16-14 | software | Local PostgreSQL service. | SPEC-14.test-layers | platform.workspace | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | 7 (NOT_RUN) |
| FO-16-15 | software | Policy service in local composition. | SPEC-14.test-layers | platform.workspace | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-16-16 | software | Durable queue/workflow test path. | SPEC-8.outbox, SPEC-9.workflow | platform.workspace | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | 11 (NOT_RUN) |
| FO-16-17 | software | Vendor emulators. | SPEC-14.test-layers | domain.business_systems | WP-23 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-16-18 | software | Model emulator. | SPEC-14.test-layers | models.providers | WP-08 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-16-19 | software | LiveKit/SIP test endpoint. | SPEC-14.test-layers | voice.media_runtime | WP-11 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-16-20 | software | Receiver client (simulated human agent accepting transfers). | SAFE-04, SPEC-10.transfer | handoff.transfer | WP-28 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-16-21 | software | Audit sink in local composition. | OPS-01 | platform.workspace | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | 5 (NOT_RUN) |
| FO-16-22 | software | Timeline sources and UI in local composition. | — | context.store | WP-18 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-16-23 | constraint | Run production code against these services and clearly identify emulated behavi… | OPS-03 | platform.workspace | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-16-24 | software | Real-model local profile requiring only a reviewed model credential or licensed… | OPS-05 | models.providers | WP-08 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-16-25 | software | Cloud-ready profile with no source-code edits needed. | OPS-04 | operations.commands | WP-41 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-16-26 | software | Separate sandbox/staging/production and audit boundaries. | SPEC-3.trust-boundaries | deploy.infrastructure | WP-39 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-16-27 | software | Private stateful services. | SPEC-3.trust-boundaries | deploy.infrastructure | WP-39 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-16-28 | software | Multi-AZ control plane (three AZs where available). | SPEC-12.resilience | deploy.infrastructure | WP-39 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-16-29 | software | Minimum warm media and control capacity. | SPEC-12.capacity-model | deploy.infrastructure | WP-39 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-16-30 | software | One primary write region with a tested secondary US region. | SPEC-12.recovery | deploy.infrastructure | WP-39 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-16-31 | software | KMS and Secrets Manager. | SPEC-3.trust-boundaries | connectors.runtime | WP-06 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | 2 (NOT_RUN) |
| FO-16-32 | software | Backups. | SPEC-12.recovery | operations.commands | WP-41 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-16-33 | software | Restore automation. | SPEC-12.recovery | operations.commands | WP-41 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-16-34 | software | Explicit networking for SIP, RTP, TURN and WebSocket. | — | deploy.infrastructure | WP-39 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-16-35 | software | Certificates and DNS. | SPEC-3.ingress | deploy.infrastructure | WP-39 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-16-36 | software | WAF, rate limits and health checks. | SPEC-3.ingress, SAFE-03 | deploy.infrastructure | WP-39 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-16-37 | software | Readiness checks dependent capabilities, not just process responds 200. | SPEC-12.resilience | operator.onboarding | WP-32 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-16-38 | software | Bounded retries with jitter and one clear retry owner. | SPEC-12.no-retry-stacking, ACT-03 | operations.resilience_cost | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-16-39 | software | Circuit breakers and bulkheads. | SPEC-12.resilience | connectors.runtime | WP-06 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | 4 (PASS) |
| FO-16-40 | software | Backpressure, DLQ, admission control and quotas. | SPEC-12.admission, SPEC-8.outbox | operations.resilience_cost | WP-42 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-16-41 | software | Worker leases and graceful draining. | ACT-02 | platform.substrate | WP-04 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | 5 (NOT_RUN) |
| FO-16-42 | software | Preserve in-flight action/case compatibility across rolling deploys. | SPEC-15.rollback | operations.commands | WP-41 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-16-43 | software | Schema changes use expand/migrate/contract with tested rollback; never roll bac… | SPEC-15.rollback | operations.commands | WP-41 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-16-44 | software | Cross-region failover infrastructure: the secondary region has a write-fence co… | SPEC-12.recovery, ACT-02 | deploy.infrastructure | WP-39 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-16-44a | software | Application write fencing for cross-region failover: during regional uncertaint… | SPEC-12.recovery, ACT-02 | operations.resilience_cost, actions.effects | WP-42 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-16-45 | document | Capacity baseline arithmetic (25,000 calls/day, 8 min mean, 200,000 min/day, ~6… | SPEC-12.capacity-model | operations.resilience_cost | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-16-46 | evaluation | Plan and test 2,000 concurrent calls and a 3,000-call controlled-admission surg… | SPEC-12.load-test, SPEC-12.admission | operations.resilience_cost | WP-42 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-16-47 | evaluation | ~133 tool requests/s at 2,000 sessions; test >=400 sustained and bounded bursts. | SPEC-12.load-test | operations.resilience_cost | WP-42 | IMPLEMENTED | NOT_CONFIGURED | FAIL | — |
| FO-16-48 | document | Model call starts, long-tail durations, warm-transfer extra legs, language/coho… | SPEC-12.quotas | operations.resilience_cost | WP-42 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-16-49 | operations | Obtain real traffic distributions through separately authorized exports before… | OPS-05 | operations.resilience_cost | WP-42 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-16-50 | software | Small local/load profiles and parameterized full-load/soak jobs. | SPEC-12.load-test | operations.resilience_cost | WP-42 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-16-51 | constraint | Distinguish mocked backend capacity from carrier/model/CRM end-to-end capacity. | OPS-03 | release.supply_chain | WP-40 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-16-52 | operations | Human fallback needs actual queue capacity, shift schedules, escalation skills… | OPS-02 | handoff.transfer | WP-28 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-16-53 | document | Staffing arithmetic (~268 scheduled agents at 20% handoff, 12 min, 80% occupanc… | SPEC-12.capacity-model | operations.resilience_cost | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-16-54 | software | Provide prioritization, truthful wait times, neutral intake and consented callb… | OPS-02, SAFE-03 | handoff.transfer | WP-28 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-16-55 | document | Proposed DR targets: RTO <=15 min, cross-region RPO <=5 min, subject to measure… | SPEC-12.recovery | deploy.infrastructure | WP-39 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-16-56 | evaluation | Acknowledged primary-region actions survive an AZ failure. | OPS-01, ACT-02 | deploy.infrastructure | WP-39 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-16-57 | constraint | Safe telephony routing remains independent of application recovery. | OPS-02, SPEC-3.independent-human-route | safety.routing | WP-15 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-16-58 | software | Cost dashboard/model includes call minutes/all legs, speech, tokens, GPU/CPU, l… | SPEC-12.capacity-model, SPEC-12.budget-cutoff | operations.resilience_cost | WP-42 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-16-59 | document | Sensitivity calculations ($0.01/min -> $60,000/month; $0.05 -> $300,000) labell… | SPEC-12.capacity-model | operations.resilience_cost | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-16-60 | software | Report cost per VERIFIED resolution and unresolved-case cost, not just cheap mi… | SPEC-13.resolution-metrics | operations.resilience_cost | WP-42 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-16-61 | software | Per-tenant/cohort/model/workflow spend limits, concurrency caps and quota reser… | SPEC-12.budget-cutoff, SPEC-12.quotas | operations.resilience_cost | WP-42 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-16-62 | constraint | Alerts and prepaid balances are not hard caps; vendor billing delays accounted. | SPEC-12.budget-cutoff | operations.resilience_cost | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-16-63 | software | Budget exhaustion stops nonessential new automation and invokes approved contin… | SAFE-03, SPEC-12.budget-cutoff | operations.resilience_cost | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-16-64 | constraint | No billable test, large export or cloud apply without explicit execution scope;… | OPS-05 | activation.qualification | WP-45 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-16-65 | document | Plan human fallback for an AI outage, which may send far more traffic than the… | OPS-02, SAFE-03, SPEC-12.capacity-model | operations.resilience_cost | WP-42 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-17-01 | software | Build an evaluation platform, not a folder of generated dialogues. | SPEC-14.test-layers, SPEC-14.scorecard | evaluation.drivers | WP-34 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-17-02 | evaluation | Layer 1: deterministic/property/state-machine tests for identity, consent, ACLs… | SPEC-14.test-layers, ACT-02, ACT-03, AUTH-04 | evaluation.test_truth | WP-01 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | 4 (PASS) |
| FO-17-03 | evaluation | Layer 2: production adapters over real protocols against local emulators (Postg… | SPEC-14.test-layers | platform.workspace | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-17-04 | evaluation | Layer 3: real model text tasks and grounded multi-turn simulation with verifiab… | SPEC-14.test-layers, OPS-05 | evaluation.drivers | WP-34 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-17-05 | evaluation | Layer 4: full-duplex audio with noise, accents, codecs, overlap, delayed tools,… | SPEC-14.test-layers, SPEC-11.barge-in | evaluation.drivers | WP-34 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-17-06 | evaluation | Layer 5: authorized vendor sandbox/PSTN, human acceptance, security, load/soak,… | SPEC-14.test-layers, OPS-05 | telephony.pstn | WP-45 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-17-07 | evaluation | tau-bench/tau2 patterns: executable task worlds, dual-control user actions, pol… | SPEC-14.hard-gates | evaluation.drivers | WP-34 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-17-08 | evaluation | Adapt tau-Voice for full-duplex task AND conversation metrics and tau-Knowledge… | — | evaluation.drivers | WP-34 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-17-09 | constraint | Check licenses before reuse; benchmarks are not healthcare release approval; Me… | OPS-03 | evaluation.drivers | WP-34 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-17-10 | evaluation | Scorer repair: rerun and investigate historical FAIL/INCONCLUSIVE cases, distin… | OPS-03, SPEC-14.hard-gates | evaluation.test_truth | WP-01 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | 4 (PASS) |
| FO-17-11 | evaluation | A fault scenario passes only if the intended failure path was reached AND postc… | OPS-03, ACT-02, SPEC-16.fault-crash-after-commit | evaluation.test_truth | WP-01 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | 28 (PASS) |
| FO-17-12 | evaluation | Preserve the original failing result and the corrected rerun. | OPS-03 | evaluation.test_truth | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | 11 (PASS) |
| FO-17-13 | constraint | Do not remove hard cases, relabel unmet assertions or weaken gates to get green. | OPS-03 | evaluation.test_truth | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | 38 (PASS) |
| FO-17-14 | evaluation | Keep a fixed required denominator; skipped/NOT_RUN/INCONCLUSIVE cases do not co… | OPS-03 | evaluation.test_truth | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | 5 (PASS) |
| FO-17-15 | evaluation | Report coverage holes and unsupported intents explicitly. | OPS-03 | evaluation.test_truth | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | 4 (PASS) |
| FO-17-16 | evaluation | Maintain development, tuning, held-out acceptance and regression corpora with l… | SPEC-14.intent-corpus | evaluation.test_truth | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | 6 (PASS) |
| FO-17-17 | evaluation | Splits at scenario family/account/conversation level to prevent leakage. | SPEC-14.intent-corpus | evaluation.test_truth | WP-01 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | 4 (PASS) |
| FO-17-18 | constraint | Synthetic or licensed/consented data by default; real support data only with ap… | DATA-01, SPEC-14.production-derived | evaluation.drivers | WP-34 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-17-19 | evaluation | Separate synthetic expected labels from actual human review. | OPS-03, SPEC-14.risk-corpus | evaluation.monitors | WP-35 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-17-20 | evaluation | >=50 reviewed support intents across clients/providers/partners, each with eigh… | SPEC-14.intent-corpus | evaluation.monitors | WP-35 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-17-21 | evaluation | >=500 human-reviewed privacy/authorization/clinical-boundary/safety-routing cas… | SPEC-14.risk-corpus | evaluation.monitors | WP-35 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-17-22 | evaluation | Repeat selected stochastic cases >=5 times; measure all-k reliability and pass@… | SPEC-14.repetitions | evaluation.drivers | WP-34 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-17-23 | evaluation | Include shared devices, proxies/minors, role switching, culturally varied speec… | SPEC-14.edge-populations | evaluation.drivers | WP-34 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-17-24 | evaluation | Fault matrix denominator and gate: the fixed fault registry (the 25 plans in sc… | SPEC-16.fault-injection, SPEC-14.failure-injection | operations.resilience_cost | WP-42 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | 10 (PASS) |
| FO-17-24.AUTH_EXPIRY_IDLE | evaluation | Fault matrix AUTH_EXPIRY_IDLE: Auth expires while idle. The fault is injected a… | SPEC-16.fault-auth-expiry, AUTH-04 | identity.caller | WP-05 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-17-24.AUTH_EXPIRY_DURING_SPEECH | evaluation | Fault matrix AUTH_EXPIRY_DURING_SPEECH: Auth expires during speech. The fault i… | SPEC-16.fault-auth-expiry, AUTH-04, ACT-05 | voice.release_boundary | WP-14 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-17-24.AUTH_EXPIRY_MID_CALL | evaluation | Fault matrix AUTH_EXPIRY_MID_CALL: Session expires between prepare and commit.… | SPEC-16.fault-auth-expiry, AUTH-04 | evaluation.test_truth | WP-07 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-17-24.DELEGATION_REVOKED | evaluation | Fault matrix DELEGATION_REVOKED: Revoked delegation. The fault is injected at i… | AUTH-05, SPEC-7.privilege-expiry | evaluation.test_truth | WP-19 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-17-24.CONSENT_REVOKED | evaluation | Fault matrix CONSENT_REVOKED: Revoked consent. The fault is injected at its rea… | DATA-03, SPEC-7.privilege-expiry | evaluation.test_truth | WP-30 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-17-24.CONCURRENT_SAME_ACCOUNT | evaluation | Fault matrix CONCURRENT_SAME_ACCOUNT: Two concurrent calls change the same appo… | SPEC-16.fault-concurrent-calls, ACT-02 | evaluation.test_truth | WP-25 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-17-24.CHANGED_SLOT_DURING_CONFIRMATION | evaluation | Fault matrix CHANGED_SLOT_DURING_CONFIRMATION: Changed slot during confirmation… | ACT-01, SPEC-8.commit-recheck | evaluation.test_truth | WP-25 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-17-24.INTERRUPTED_CONFIRMATION | evaluation | Fault matrix INTERRUPTED_CONFIRMATION: Caller barges in during the confirmation… | SPEC-16.fault-interrupted-confirmation, ACT-01 | voice.release_boundary | WP-14 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-17-24.STALE_SOURCE | evaluation | Fault matrix STALE_SOURCE: Stale source. The fault is injected at its real inje… | SPEC-12.bounded-caching | context.assembly | WP-24 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-17-24.CONTRADICTORY_EVENT | evaluation | Fault matrix CONTRADICTORY_EVENT: Contradictory event. The fault is injected at… | SPEC-3.trust-boundaries | context.assembly | WP-24 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-17-24.EVENTS_OUT_OF_ORDER | evaluation | Fault matrix EVENTS_OUT_OF_ORDER: Transfer events arrive out of order. The faul… | SAFE-04, SPEC-10.transfer | handoff.transfer | WP-28 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-17-24.DUPLICATE_WEBHOOK | evaluation | Fault matrix DUPLICATE_WEBHOOK: Vendor redelivers the same event twice. The fau… | SPEC-16.fault-duplicate-webhooks, ACT-02 | ingress.events | WP-04 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-17-24.MISSING_WEBHOOK | evaluation | Fault matrix MISSING_WEBHOOK: Missing webhook. The fault is injected at its rea… | SPEC-8.webhook-auth | crm.salesforce | WP-29 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-17-24.SCHEDULING_TIMEOUT_AFTER_COMMIT | evaluation | Fault matrix SCHEDULING_TIMEOUT_AFTER_COMMIT: Scheduling commit times out after… | ACT-03, SPEC-8.timeout-states | actions.effects | WP-25 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-17-24.CRASH_AFTER_COMMIT | evaluation | Fault matrix CRASH_AFTER_COMMIT: Process crashes after the external system comm… | SPEC-16.fault-crash-after-commit, ACT-02 | actions.effects | WP-25 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-17-24.RECEIPT_LOST | evaluation | Fault matrix RECEIPT_LOST: Lost receipt. The fault is injected at its real inje… | ACT-04, ACT-03 | actions.effects | WP-25 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-17-24.RECEIPT_LATE | evaluation | Fault matrix RECEIPT_LATE: Late receipt. The fault is injected at its real inje… | ACT-04, ACT-05 | actions.effects | WP-25 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-17-24.SALESFORCE_OUTAGE | evaluation | Fault matrix SALESFORCE_OUTAGE: Salesforce unavailable during case creation. Th… | SPEC-16.fault-salesforce-outage, SPEC-8.salesforce-outage | crm.salesforce | WP-29 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-17-24.SCHEMA_DRIFT | evaluation | Fault matrix SCHEMA_DRIFT: Drifted schema. The fault is injected at its real in… | SPEC-16.integration-records | connectors.runtime | WP-32 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-17-24.DLQ_FULL | evaluation | Fault matrix DLQ_FULL: Full DLQ. The fault is injected at its real injection po… | ACT-02 | connectors.runtime | WP-07 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-17-24.MODEL_REFUSAL | evaluation | Fault matrix MODEL_REFUSAL: Model refusal. The fault is injected at its real in… | SAFE-03, ACT-05 | models.providers | WP-17 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-17-24.MODEL_HANG | evaluation | Fault matrix MODEL_HANG: Model hang. The fault is injected at its real injectio… | SAFE-03, SPEC-12.resilience | models.providers | WP-15 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-17-24.MODEL_OVERLOAD | evaluation | Fault matrix MODEL_OVERLOAD: Model overload. The fault is injected at its real… | SPEC-12.admission | models.providers | WP-17 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-17-24.ASR_FAILURE | evaluation | Fault matrix ASR_FAILURE: ASR failure. The fault is injected at its real inject… | SPEC-10.safety-signals, SAFE-02 | voice.speech | WP-15 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-17-24.TTS_FAILURE | evaluation | Fault matrix TTS_FAILURE: TTS failure. The fault is injected at its real inject… | ACT-05, SAFE-02 | voice.speech | WP-15 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-17-24.JUDGE_FAILURE | evaluation | Fault matrix JUDGE_FAILURE: Judge failure. The fault is injected at its real in… | ACT-05, SAFE-03 | evaluation.monitors | WP-35 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-17-24.RECEIVER_UNAVAILABLE | evaluation | Fault matrix RECEIVER_UNAVAILABLE: No human receiver available. The fault is in… | SAFE-04, SPEC-10.transfer-failure | handoff.transfer | WP-28 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-17-24.RECEIVER_DECLINED | evaluation | Fault matrix RECEIVER_DECLINED: Human declines. The fault is injected at its re… | SAFE-04, SPEC-10.transfer-failure | handoff.transfer | WP-28 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-17-24.TRANSFER_FAILED | evaluation | Fault matrix TRANSFER_FAILED: Transfer to the first destination fails. The faul… | SPEC-16.fault-failed-transfer, SAFE-04 | handoff.transfer | WP-28 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-17-24.BRIDGE_DROPPED | evaluation | Fault matrix BRIDGE_DROPPED: Bridge drops after receiver acceptance. The fault… | SAFE-04 | handoff.transfer | WP-28 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-17-24.RECORDING_REFUSED | evaluation | Fault matrix RECORDING_REFUSED: Recording refusal. The fault is injected at its… | DATA-03, SPEC-6.consent-before-recording | actions.effects | WP-25 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-17-24.AUDIT_OUTAGE | evaluation | Fault matrix AUDIT_OUTAGE: Durable audit evidence cannot be written. The fault… | SPEC-16.fault-audit-outage, OPS-01 | audit.independent | WP-04 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-17-24.LOCAL_PERSISTENCE_FAILURE | evaluation | Fault matrix LOCAL_PERSISTENCE_FAILURE: Local persistence failure. The fault is… | SPEC-12.db-outage, OPS-01 | platform.substrate | WP-15 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-17-24.REDACTION_FAILURE | evaluation | Fault matrix REDACTION_FAILURE: Redaction of a transcript fails. The fault is i… | SPEC-6.redaction, DATA-01 | privacy.operations | WP-35 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-17-24.SOURCE_DELETED | evaluation | Fault matrix SOURCE_DELETED: Source deletion. The fault is injected at its real… | DATA-03 | privacy.operations | WP-24 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-17-24.SOURCE_MERGED | evaluation | Fault matrix SOURCE_MERGED: Source merge. The fault is injected at its real inj… | AUTH-05 | authority.registries | WP-24 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-17-24.SOURCE_SPLIT | evaluation | Fault matrix SOURCE_SPLIT: Source split. The fault is injected at its real inje… | AUTH-05 | authority.registries | WP-24 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-17-24.REGIONAL_FAILOVER | evaluation | Fault matrix REGIONAL_FAILOVER: Primary region fails during a call. The fault i… | SPEC-12.recovery | operations.resilience_cost | WP-42 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-17-24.QUOTA_EXHAUSTED | evaluation | Fault matrix QUOTA_EXHAUSTED: AI or budget quota exhausted mid-call. The fault… | SPEC-12.quotas, SAFE-03 | operations.resilience_cost | WP-42 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-17-24.BUDGET_EXHAUSTED | evaluation | Fault matrix BUDGET_EXHAUSTED: Budget exhaustion. The fault is injected at its… | SPEC-12.budget-cutoff, SAFE-03 | operations.resilience_cost | WP-42 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-17-24.BILLING_TIMEOUT | evaluation | Fault matrix BILLING_TIMEOUT: Billing system times out on read. The fault is in… | SPEC-14.failure-injection, ACT-03 | domain.business_systems | WP-23 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-17-24.CLAIMS_TIMEOUT | evaluation | Fault matrix CLAIMS_TIMEOUT: Claims system times out. The fault is injected at… | SPEC-14.failure-injection | domain.business_systems | WP-23 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-17-24.PROVIDER_API_TIMEOUT | evaluation | Fault matrix PROVIDER_API_TIMEOUT: Provider network API times out. The fault is… | SPEC-14.failure-injection, ACT-03 | domain.business_systems | WP-23 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-17-24.SCHEDULING_UNAVAILABLE | evaluation | Fault matrix SCHEDULING_UNAVAILABLE: Scheduling system unavailable on read. The… | SPEC-14.failure-injection | domain.business_systems | WP-23 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-17-24.PARTIAL_WRITE | evaluation | Fault matrix PARTIAL_WRITE: Dependency reports a partial write. The fault is in… | ACT-02, ACT-03 | domain.business_systems | WP-23 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-17-24.KNOWLEDGE_STALE | evaluation | Fault matrix KNOWLEDGE_STALE: Matching article is expired. The fault is injecte… | SPEC-14.failure-injection | knowledge.retrieval | WP-20 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-17-24.IDP_UNAVAILABLE | evaluation | Fault matrix IDP_UNAVAILABLE: Identity provider unavailable. The fault is injec… | SPEC-14.failure-injection, AUTH-01 | identity.caller | WP-05 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-17-24.NOTIFICATION_PROVIDER_DOWN | evaluation | Fault matrix NOTIFICATION_PROVIDER_DOWN: Notification provider unavailable. The… | SPEC-14.failure-injection | notifications.messaging | WP-27 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-17-24.POLICY_ENGINE_ERROR | evaluation | Fault matrix POLICY_ENGINE_ERROR: Policy evaluation errors. The fault is inject… | AUTH-02, SAFE-02 | evaluation.test_truth | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | 1 (PASS) |
| FO-17-24.GUARDRAIL_LIMIT | evaluation | Fault matrix GUARDRAIL_LIMIT: Refusal / turn limit reached in a crisis conversa… | SAFE-03, SPEC-2.guardrail-exit | safety.routing | WP-15 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-17-25 | software | Input/output monitors: ASR entity accuracy, uncertainty, language support, inte… | SPEC-10.safety-signals, SPEC-11.response-gate | evaluation.monitors | WP-35 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-17-26 | software | Deterministic checks for facts/actions plus qualified semantic judges at each m… | SPEC-11.response-gate, SPEC-2.model-evidence | evaluation.monitors | WP-35 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-17-27 | evaluation | Judges need test sets, blind human labels, severity definitions, precision/reca… | SPEC-14.uncertainty | evaluation.monitors | WP-35 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-17-28 | evaluation | Include a random sample of unflagged conversations to estimate missed cases. | SPEC-14.uncertainty | evaluation.monitors | WP-35 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-17-29 | evaluation | Separate generator and judge model families when feasible; human adjudication r… | — | evaluation.monitors | WP-35 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-17-30 | constraint | Judge scores cannot prove external effects, caller authority or accepted human… | SAFE-04, ACT-04 | evaluation.monitors | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-17-31 | evaluation | Usable support routing availability >=99.95% monthly end to end. | SPEC-13.slo-definitions, OPS-02 | safety.routing | WP-15 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-17-32 | evaluation | Warm simple turn latency p50 <=800 ms, p95 <=1.5 s (goal 500 ms/1 s) from end o… | SPEC-13.slo-definitions, SPEC-11.endpointing | voice.cascade | WP-17 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-17-33 | evaluation | Healthy-dependency tool-backed meaningful response p95 <=3 s. | SPEC-13.slo-definitions | voice.cascade | WP-17 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-17-34 | evaluation | Interruption stop p95 <=250 ms from detected interruption to last handset audio… | SPEC-11.barge-in | voice.cascade | WP-17 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-17-35 | evaluation | 100% protected actions/utterances have valid checks; all accepted consequential… | OPS-01, ACT-02, AUTH-02 | evaluation.test_truth | WP-01 | IMPLEMENTED | NOT_CONFIGURED | FAIL | 1 (PASS) |
| FO-17-36 | evaluation | CRM synchronization >=99.9% within 60 s under normal dependencies; outage backl… | SPEC-13.slo-definitions, SPEC-8.salesforce-outage | crm.salesforce | WP-29 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-17-37 | evaluation | >=99.5% accepted transfer attempts connect when a receiver is available; publis… | SAFE-04, SPEC-10.transfer-failure | handoff.transfer | WP-28 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-17-38 | evaluation | >=95% verified goal completion per supported routine launch intent under declar… | SPEC-14.goal-completion, ACT-04 | evaluation.drivers | WP-34 | IMPLEMENTED | NOT_CONFIGURED | FAIL | — |
| FO-17-39 | evaluation | Human warmth/clarity >=4/5 (goal 4.3) with predeclared rubric, reviewer count,… | SPEC-14.scorecard | evaluation.monitors | WP-35 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-17-40 | constraint | Any critical privacy/authorization/clinical-boundary/effect failure blocks the… | OPS-03, SPEC-14.hard-gates | evaluation.test_truth | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-17-41 | evaluation | Publish p50/p95/p99 by intent/language/audience/assurance/model/voice/load/regi… | SPEC-14.aggregation, SPEC-14.uncertainty | evaluation.test_truth | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | 14 (PASS) |
| FO-17-42 | evaluation | Report ASR important-entity error and WER; completion latency, total silence, i… | SPEC-11.endpointing | evaluation.drivers | WP-34 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-17-43 | constraint | Finite zero observed errors never proves zero risk (~3/n bound); related simula… | SPEC-14.uncertainty, OPS-03 | evaluation.test_truth | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-17-44 | software | EvaluationResult records scenario/run/seed/split, expected scope and initial wo… | SPEC-14.scorecard, SPEC-16.scenario-definition, SPEC-2.version-proof | evaluation.test_truth | WP-01 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | 7 (PASS) |
| FO-17-45 | software | Append-only results and reproducible rerun commands. | SPEC-14.scorecard | evaluation.test_truth | WP-01 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | 2 (PASS) |
| FO-17-46 | constraint | Acceptance targets are engineering proposals, not legal thresholds or measureme… | OPS-03, SPEC-13.slo-definitions | evaluation.test_truth | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | 4 (PASS) |
| FO-18-01 | software | Continuous improvement service: collect approved observations. | SPEC-15.no-self-promotion | improvement.pipeline | WP-36 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-18-02 | software | Detect failure clusters and drift automatically. | — | improvement.pipeline | WP-36 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-18-03 | software | Propose changes automatically (prepare useful changes, not merely charts). | — | improvement.pipeline | WP-36 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-18-04 | software | Replay/evaluate proposals. | SPEC-14.test-layers | improvement.pipeline | WP-36 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-18-05 | software | Review proposals. | SPEC-15.no-self-promotion | improvement.pipeline | WP-36 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-18-06 | software | Canary -> measure -> promote or rollback. | SPEC-15.pilot-promotion, SPEC-15.rollback | improvement.canary_training | WP-37 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-18-07 | software | Self-improvement UI. | — | improvement.pipeline | WP-36 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-18-08 | software | ChangeProposal binds evidence, suspected cause, exact prompt/knowledge/model/to… | OPS-06 | improvement.pipeline | WP-36 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-18-09 | software | Distinguish verified cause from hypothesis. | OPS-03 | improvement.pipeline | WP-36 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-18-10 | constraint | Candidate generation and offline optimization may run autonomously only in a bo… | OPS-05 | improvement.pipeline | WP-36 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-18-11 | constraint | No self-promotion of production behavior, self-editing permissions, unrestricte… | SPEC-15.no-self-promotion, OPS-05, OPS-06 | improvement.canary_training | WP-37 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-18-12 | software | Support retrieval tuning. | SPEC-9.retrieval | improvement.pipeline | WP-36 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-18-13 | software | Prompt optimization. | — | improvement.pipeline | WP-36 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-18-14 | software | Router calibration. | — | improvement.pipeline | WP-36 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-18-15 | software | Approved knowledge updates. | SPEC-9.knowledge-ingestion | operator.studio | WP-33 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-18-16 | software | Task-specific fine-tuning/LoRA recipes with evaluation and promotion gates, onl… | — | improvement.canary_training | WP-37 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-18-17 | software | Training data provenance, license, consent/purpose, minimization, leakage check… | DATA-01, DATA-03 | improvement.canary_training | WP-37 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-18-18 | evaluation | Memorization/extraction and bias tests for trained artifacts. | — | improvement.canary_training | WP-37 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-18-19 | constraint | Held-out tests are inaccessible to optimizer feedback; refresh tests under revi… | SPEC-14.intent-corpus | improvement.pipeline | WP-36 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-18-20 | operations | Review all detected critical events and pilot safety transfers, plus stratified… | SAFE-01 | evaluation.monitors | WP-35 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-18-21 | evaluation | Evaluate the monitors continuously. | — | evaluation.monitors | WP-35 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-18-22 | software | Track repeat contact 24h/7d, reopens, unresolved promises, inappropriate handof… | SPEC-13.resolution-metrics | workflows.families | WP-30 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-18-23 | constraint | Optimize verified outcomes AND naturalness; do not reward containment at all co… | ACT-04 | improvement.pipeline | WP-36 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-18-24 | software | Canaries have signed limits by tenant/cohort/intents/language, sample/period ta… | SPEC-15.pilot-promotion | improvement.canary_training | WP-37 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-18-25 | software | Stable, auditable cohort assignment; current permissions always apply. | AUTH-02 | improvement.canary_training | WP-37 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-18-26 | constraint | No experimentation on crisis instructions, consent or authority controls withou… | SAFE-01, AUTH-02 | improvement.canary_training | WP-37 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-18-27 | constraint | Manual and automatic containment preserve human/safety routing. | OPS-02, SAFE-03 | improvement.canary_training | WP-37 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-18-28 | software | Record releases and in-flight workflow compatibility. | SPEC-16.release-manifest, SPEC-15.rollback | improvement.canary_training | WP-40 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-18-29 | constraint | An external dataset label or provenance (for example a Hugging Face clinical la… | DATA-01, DATA-03, SAFE-01 | improvement.canary_training | WP-37 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-01 | document | Inventory actual code, branches, dependencies and tests; preserve user work; re… | SPEC-16.progress-handoff | governance.documents | WP-44 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-02 | document | Reconcile Section 1 observations and the original requirement IDs into a gap le… | SPEC-14.traceability | governance.documents | WP-44 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-03 | document | Create architecture, threat/data-flow and module dependency diagrams. | SPEC-3.trust-boundaries, SPEC-14.threat-model | governance.documents | WP-44 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-04 | evaluation | Fix scorer truth. | SPEC-14.hard-gates, SPEC-14.scorecard, OPS-03 | evaluation.test_truth | WP-01 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | 4 (PASS) |
| FO-19-05 | software | Fix invariant regressions: every invariant has positive, direct adversarial and… | AUTH-01, AUTH-06, DATA-02, ACT-05, OPS-03 | evaluation.test_truth | WP-01 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | 8 (PASS) |
| FO-19-06 | software | Fix production composition: non-local environments start with real adapters and… | OPS-04, SPEC-16.prod-guard | platform.composition | WP-07 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-07 | software | Implement storage, session, workforce identity and audit for live environments. | AUTH-04, OPS-01, SPEC-7.workforce-separation, SPEC-13.audit-integrity | identity.workforce | WP-05 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-07a | software | Storage, session and audit production adapters (PgPoolDb, DynamoKvStore, S3Obje… | AUTH-04, OPS-01, SPEC-7.workforce-separation, SPEC-13.audit-integrity | audit.independent | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | 5 (NOT_RUN) |
| FO-19-08 | software | Implement real transport adapter boundaries (telephony/media, CRM, business sys… | SPEC-16.integration-records, OPS-04 | connectors.runtime | WP-06 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-09 | software | Connect live model adapters. | SPEC-2.model-evidence, OPS-06 | models.providers | WP-08 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-10 | software | Connect controllable media (LiveKit/SIP). | SPEC-11.barge-in, SPEC-11.endpointing | voice.media_runtime | WP-11 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-11 | software | Complete protected output at the audio boundary (authorize, validate, render, r… | ACT-05, SPEC-11.response-gate, SPEC-11.response-record | voice.release_boundary | WP-14 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-12 | software | Complete fallback audio usable when the generative speaker or judge fails. | OPS-02, SAFE-03 | safety.routing | WP-15 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-13 | software | Complete turn/session fencing across media, model and tools. | SPEC-11.barge-in, AUTH-04, ACT-01 | voice.release_boundary | WP-14 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-14 | evaluation | Deliver a real local audio-to-action journey. | SPEC-16.journeys | voice.cascade | WP-17 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-15 | software | Complete historical/event/live context (timeline, event-fed projections, fresh… | SPEC-9.memory, DATA-04 | context.assembly | WP-24 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-16 | software | Complete entity linking. | AUTH-05 | authority.registries | WP-19 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-17 | software | Complete knowledge ingestion. | SPEC-9.knowledge-ingestion, SPEC-9.retrieval | knowledge.retrieval | WP-20 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-18 | software | Complete deletions: source corrections/deletions and privacy deletions propagat… | DATA-03, SPEC-6.data-classes | privacy.operations | WP-22 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-19 | software | Complete the model registry. | OPS-06, SPEC-11.voice-selection | models.registry | WP-09 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-20 | software | Complete typed specialist loops. | — | conversation.harness | WP-10 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-21 | software | Complete canonical domain adapters behind common contracts. | SPEC-16.integration-records | domain.business_systems | WP-23 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-22 | software | Complete every workflow family. | SPEC-4.workflow-catalogue, SPEC-9.workflow | workflows.families | WP-30 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-23 | software | Complete CRM/outbox synchronization. | SPEC-8.outbox, SPEC-8.salesforce-model, SPEC-8.salesforce-outage, ACT-02 | crm.salesforce | WP-29 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-24 | software | Complete long-horizon work that outlives the call without inheriting unlimited… | SPEC-7.privilege-expiry, SPEC-9.recheck, SPEC-9.task-tokens | authority.registries | WP-19 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-25 | software | Complete the secure companion. | SPEC-7.secure-link-binding | companion.web | WP-27 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-26 | software | Complete notification routes. | SPEC-9.notifications | notifications.messaging | WP-27 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-27 | software | Complete accepted human transfer (receiver acceptance, verified connection, con… | SAFE-04, SPEC-10.transfer, SPEC-10.handoff-package | handoff.transfer | WP-28 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-28 | software | Complete operator onboarding, studio and console. | SPEC-13.console, SPEC-16.console-functional | operator.console | WP-38 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-29 | software | Complete configuration publication (versioned, reviewed, activated without sour… | OPS-06, SPEC-15.no-self-promotion | operator.configuration | WP-31 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-30 | software | Complete evidence views. | SPEC-13.console | operator.console | WP-38 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-31 | evaluation | Complete the eval platform. | SPEC-14.test-layers, SPEC-14.aggregation | evaluation.drivers | WP-34 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-32 | software | Complete the self-improvement workflow. | — | improvement.pipeline | WP-36 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-33 | evaluation | Run deterministic, contract, local integration, security, audio and chaos check… | SPEC-14.test-layers, SPEC-14.failure-injection | platform.invariants | WP-43 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-34 | software | Package infrastructure and images. | SPEC-14.supply-chain | release.supply_chain | WP-40 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-35 | software | Package migration and rollback (expand/migrate/contract, tested rollback, no ro… | SPEC-15.rollback | operations.commands | WP-41 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-36 | operations | Package load, soak and DR jobs. | SPEC-12.load-test, SPEC-12.recovery | operations.resilience_cost | WP-42 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-37 | software | Package release preflight. | SPEC-16.release-manifest, OPS-04 | release.supply_chain | WP-40 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-38 | operations | Package operator qualification and evidence collection. | SPEC-16.release-manifest | activation.qualification | WP-45 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-39 | constraint | Execute sandbox/paid/PHI/production jobs only with exact authorization; never r… | OPS-03, OPS-05, SPEC-16.phi-endpoints-disabled | activation.qualification | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-40 | document | Otherwise produce exact activation commands, settings, expected evidence and th… | SPEC-5.prerequisite-register | activation.qualification | WP-45 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-41 | document | IMPLEMENTATION_STATUS document with both status axes per capability, describing… | SPEC-16.status-vocabulary, SPEC-16.progress-handoff | governance.documents | WP-44 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-42 | document | GAP_CLOSURE document. | — | governance.documents | WP-44 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-43 | document | ARCHITECTURE document describing actual implementation. | SPEC-3.trust-boundaries | governance.documents | WP-44 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-44 | document | DECISIONS document (short decision record). | SPEC-16.decisions | governance.documents | WP-44 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-45 | document | THREAT_MODEL document. | SPEC-14.threat-model | governance.documents | WP-44 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-46 | document | DATA_FLOWS document. | DATA-01, DATA-02 | governance.documents | WP-44 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-47 | document | REQUIREMENTS_TRACEABILITY document. | SPEC-14.traceability | governance.documents | WP-44 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-48 | document | CONNECTOR_CATALOG document. | SPEC-16.integration-records | governance.documents | WP-44 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-49 | document | MODEL_REGISTRY document. | OPS-06 | governance.documents | WP-44 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-50 | document | CONFIGURATION_REFERENCE document. | — | governance.documents | WP-44 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-51 | document | ACTIVATION_REGISTER document (one register of missing external inputs). | SPEC-5.prerequisite-register | activation.qualification | WP-45 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-52 | document | CONTROL_EVIDENCE_MAP document (per invariant: enforcement, threat, positive/adv… | OPS-03 | governance.documents | WP-44 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-53 | document | TEST_EVIDENCE document. | SPEC-14.test-layers | governance.documents | WP-44 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-54 | document | OPERATIONS_RUNBOOKS. | SPEC-13.incident-playbooks | governance.documents | WP-44 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-55 | document | COST_CAPACITY_MODEL. | SPEC-12.capacity-model | operations.resilience_cost | WP-42 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-56 | document | RELEASE_MANIFEST deliverable for the release. | SPEC-16.release-manifest, OPS-06 | release.supply_chain | WP-40 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-57 | document | KNOWN_LIMITATIONS document. | — | governance.documents | WP-44 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-58 | document | HANDOFF document. | SPEC-16.progress-handoff | governance.documents | WP-44 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-59 | constraint | Use machine-readable manifests plus concise docs; every document describes actu… | SPEC-16.progress-handoff | governance.documents | WP-44 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-60 | software | Provide a single documented entry point (Makefile/task runner) exposing all nam… | SPEC-16.local-demo | operations.commands | WP-41 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-61 | software | Command: doctor. | — | operations.commands | WP-41 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-62 | software | Command: configure. | — | operations.commands | WP-41 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-63 | software | Command: up (local container composition running production code against emulat… | SPEC-16.offline-first | platform.workspace | WP-03 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-64 | software | Command: down. | — | platform.workspace | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-65 | software | Command: seed-synthetic. | — | operations.commands | WP-41 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-66 | software | Command: demo. | SPEC-16.local-demo | operations.commands | WP-41 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-67 | software | Command: test-unit. | SPEC-14.test-layers | platform.workspace | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-68 | software | Command: test-contract. | SPEC-14.test-layers | operations.commands | WP-41 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-69 | software | Command: test-integration. | SPEC-14.test-layers | platform.workspace | WP-03 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-70 | software | Command: test-audio. | SPEC-14.test-layers, AUTH-06, DATA-02 | voice.cascade | WP-17 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-71 | software | Command: test-chaos. | SPEC-14.failure-injection | operations.resilience_cost | WP-42 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-72 | software | Command: eval. | SPEC-14.intent-corpus | evaluation.drivers | WP-34 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-73 | software | Command: model-qualify. | SPEC-2.model-evidence, OPS-06 | models.registry | WP-09 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-74 | software | Command: load. | SPEC-12.load-test | operations.resilience_cost | WP-42 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-75 | software | Command: soak. | SPEC-12.load-test | operations.resilience_cost | WP-42 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-76 | software | Command: build-release. | SPEC-14.supply-chain, SPEC-16.release-manifest | release.supply_chain | WP-40 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-77 | software | Command: infra-validate. | SPEC-14.supply-chain | operations.commands, deploy.infrastructure | WP-41 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-78 | software | Command: infra-plan. | SPEC-15.rollback | operations.commands | WP-41 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-79 | software | Command: deploy. | OPS-04, OPS-05 | operations.commands | WP-41 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-80 | software | Command: smoke. | SPEC-12.recovery | operations.commands | WP-41 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-81 | software | Command: qualify-tenant. | — | activation.qualification | WP-45 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-82 | software | Command: verify-audit. | OPS-01, SPEC-13.audit-integrity | audit.independent | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | 3 (NOT_RUN) |
| FO-19-83 | software | Command: privacy-delete. | DATA-03 | privacy.operations | WP-22 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-84 | software | Command: backup. | SPEC-12.recovery | operations.commands | WP-41 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-85 | software | Command: rollback. | SPEC-15.rollback | operations.commands | WP-41 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-86 | constraint | Safe local defaults never silently invoke billable endpoints; external effects… | OPS-05, DATA-01 | operations.commands | WP-41 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-87 | constraint | Preserve real exit codes. | OPS-03 | operations.commands | WP-41 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-88 | software | ReleaseManifest binds commit, image/build, IaC plan and schema/migrations. | OPS-06, SPEC-16.release-manifest | release.supply_chain | WP-40 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-89 | software | ReleaseManifest binds dependency/model locks and SBOM/provenance. | OPS-06, SPEC-14.supply-chain | release.supply_chain | WP-40 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-90 | software | ReleaseManifest binds workflow definitions, connector mappings and carrier conf… | OPS-06 | release.supply_chain | WP-40 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-91 | software | ReleaseManifest binds model/voice, prompts, policy, knowledge/context schemas a… | OPS-06 | release.supply_chain | WP-40 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-92 | software | ReleaseManifest binds all test evidence and quotas/load evidence. | OPS-03 | release.supply_chain | WP-40 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-93 | software | ReleaseManifest binds retention and egress settings. | DATA-01, DATA-03 | release.supply_chain | WP-40 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-94 | software | ReleaseManifest binds deployment environment, rollback target and human approva… | OPS-04, SPEC-15.rollback | release.supply_chain | WP-40 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-95 | software | ApprovalRecord identifies real approver/role, exact digest/scope, date, expiry… | OPS-04 | release.supply_chain | WP-40 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-96 | software | Verify attestations and changed dependencies. | SPEC-14.supply-chain | release.supply_chain | WP-40 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-97 | constraint | Arbitrary uploaded JSON is not approval. | OPS-04 | release.supply_chain | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-98 | software | Produce a reproducible release bundle. | SPEC-16.release-manifest | release.supply_chain | WP-40 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-99 | document | Produce an operator installation guide. | — | release.supply_chain | WP-40 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-19-100 | software | Command: restore. | SPEC-12.recovery | operations.commands | WP-41 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-20-01 | evaluation | J01 Public FAQ/service/login guidance without unnecessary identity; recovery fr… | SPEC-4.workflow-catalogue, SPEC-14.risk-corpus | voice.cascade, journeys.end_to_end | WP-17 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-20-02 | evaluation | J02 Verified client views options, confirms exact reschedule, conflict refreshe… | SPEC-16.journey-1, ACT-01, ACT-02 | actions.effects, journeys.end_to_end | WP-25 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-20-03 | evaluation | J03 Approved appointment creation/cancellation where tenant-authorized; clinica… | SPEC-4.workflow-catalogue | workflows.families, journeys.end_to_end | WP-30 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-20-04 | evaluation | J04 Invoice explanation from authoritative amounts/status; recent payment prese… | SPEC-4.workflow-catalogue | context.assembly, journeys.end_to_end | WP-24 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-20-05 | evaluation | J05 Disputed charge opens durable billing review with owner/deadline, async hum… | SPEC-16.journey-2, ACT-04 | workflows.families, journeys.end_to_end | WP-30 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-20-06 | evaluation | J06 Claim/referral/authorization-status investigation distinguishes source stat… | SPEC-4.workflow-catalogue, SPEC-9.workflow | workflows.families, journeys.end_to_end | WP-30 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-20-07 | evaluation | J07 Provider onboarding/document status and delegated-practice remittance; expi… | SPEC-16.journey-3, AUTH-05 | actions.effects, journeys.end_to_end | WP-25 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-20-08 | evaluation | J08 Partner/payer organization-scoped intake; unrelated-client and employer tre… | SPEC-16.journey-4, AUTH-05 | authority.registries, journeys.end_to_end | WP-19 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-20-09 | evaluation | J09 Minor/proxy/guardian ambiguous authority routes to an authorized specialist. | SPEC-4.audience-permissions | authority.registries, journeys.end_to_end | WP-19 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-20-09a | evaluation | J09 accepted-transfer leg: the routed handoff for ambiguous minor, proxy or gua… | SPEC-4.audience-permissions | authority.registries, handoff.transfer, journeys.end_to_end | WP-30 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-20-10 | evaluation | J10 Unverified caller requests human; context package, acceptance and audio bri… | SPEC-16.journey-5, SAFE-04 | handoff.transfer, journeys.end_to_end | WP-28 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-20-11 | evaluation | J11 Safety routing without account authentication incl. indirect/uncertain spee… | SPEC-16.journey-6, SAFE-02, SAFE-03, SAFE-04 | safety.routing, journeys.end_to_end | WP-15 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-20-11a | evaluation | J11 failed-transfer leg: when the safety transfer fails (receiver declines, is… | SPEC-16.journey-6, SAFE-02, SAFE-03, SAFE-04 | handoff.transfer, journeys.end_to_end | WP-28 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-20-12 | evaluation | J12 Recording declined; actual processing/recording matches disclosure and conf… | SPEC-16.journey-7, DATA-03 | actions.effects, journeys.end_to_end | WP-25 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-20-13 | evaluation | J13 Unsupported language/speech impairment/relay routes to accessible assistanc… | SPEC-16.journey-8, SPEC-11.interpreter | safety.routing, journeys.end_to_end | WP-15 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-20-13a | evaluation | J13 qualified-reviewer sign-off: the approved language variant's real-audio run… | SPEC-16.journey-8, SPEC-11.interpreter | safety.routing, journeys.end_to_end | WP-45 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-20-14 | evaluation | J14 Repeat contact resumes permitted issue history, tasks and recent conversati… | SPEC-16.journey-9, DATA-04 | context.assembly, journeys.end_to_end | WP-24 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-20-15 | evaluation | J15 Multiple issues in one call, two concurrent calls, hang-up and later reconn… | SPEC-16.fault-concurrent-calls | workflows.families, journeys.end_to_end | WP-30 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-20-16 | evaluation | J16 CRM outage followed by replay creates one real record; internal reference d… | SPEC-16.fault-salesforce-outage, SPEC-8.salesforce-outage, ACT-03 | crm.salesforce, journeys.end_to_end | WP-29 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-20-17 | evaluation | J17 Consent/delegation revoked or source corrected/deleted while task pending;… | SPEC-9.recheck, DATA-04 | privacy.operations, journeys.end_to_end | WP-25 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-20-18 | evaluation | J18 Worker crash, AZ/region failure, audit outage, model/TTS outage and quota/c… | SPEC-16.fault-crash-after-commit, SPEC-16.fault-audit-outage, OPS-02 | operations.resilience_cost, journeys.end_to_end | WP-42 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-20-19 | evaluation | J19 Malicious KB/tool payload attempts cross-tenant access, SSRF, arbitrary dia… | SAFE-05, AUTH-05, SPEC-14.hostile-gateway-tests | platform.invariants, journeys.end_to_end | WP-43 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-20-20 | evaluation | J20 Operator configures a synthetic tenant from scratch, imports KB/field mappi… | SPEC-13.console | operator.console, journeys.end_to_end | WP-38 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-20-21 | evaluation | Supply executable authorized sandbox/PSTN qualification counterparts for every… | SPEC-15.pilot-promotion | telephony.pstn, journeys.end_to_end | WP-45 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-20-22 | evaluation | Implement every journey in local protocol-realistic mode. | SPEC-16.journeys | platform.invariants, journeys.end_to_end | WP-43 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-20-23 | evaluation | Journey success needs caller behaviour, backend state, receipt/audit and expect… | ACT-04, SPEC-14.goal-completion | platform.invariants, journeys.end_to_end | WP-43 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-20-24 | software | Implement complaint intake. | SPEC-4.workflow-catalogue | workflows.families | WP-30 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-20-25 | software | Implement existing Case follow-up. | SPEC-8.salesforce-model | workflows.families | WP-30 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-20-26 | software | Implement portal guidance without credential-reset bypass. | SPEC-4.prohibited-assertions | workflows.families | WP-30 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-20-27 | software | Implement secure hosted payment-link routing with no card capture in audio. | SPEC-4.payments-isolated | workflows.families | WP-30 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-20-28 | software | ResolutionContract carries audience, assurance, allowed data/actions, sources,… | SPEC-4.resolution-contracts | workflows.families | WP-30 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-20-29 | software | Every supported intent has a ResolutionContract. | SPEC-4.resolution-contracts, ACT-04 | workflows.families | WP-30 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-20-30 | software | ResolutionContract for appointment cancellation where tenant-authorized (J03). | SPEC-4.resolution-contracts, ACT-04, ACT-01 | workflows.families | WP-30 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-20-31 | software | ResolutionContract for referral/authorization-status investigation (J06). | SPEC-4.resolution-contracts, ACT-04 | workflows.families | WP-30 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-20-32 | software | ResolutionContract for unsupported-language, speech-impairment and relay routin… | SPEC-4.resolution-contracts, SPEC-11.interpreter, SAFE-02 | workflows.families | WP-30 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-20-33 | software | ResolutionContract for the recording-declined alternative (J12). | SPEC-4.resolution-contracts, DATA-03 | workflows.families | WP-30 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-20-34 | software | ResolutionContract for callback requests (callback_request workflow). | SPEC-4.resolution-contracts, SPEC-4.workflow-catalogue, ACT-04 | workflows.families | WP-30 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-20-35 | software | ResolutionContract for repeat-contact resumption of permitted issue history (J1… | SPEC-4.resolution-contracts, DATA-04, AUTH-05 | workflows.families | WP-30 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-21-01 | constraint | Finish the deployable software, integrate modules, run checks and fix failures;… | SPEC-16.offline-first | platform.invariants | WP-43 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-21-02 | operations | Deliver the actual release bundle plus executable external qualification/activa… | SPEC-16.release-manifest | release.supply_chain | WP-40 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-21-03 | software | Software completion requires functional production composition. | OPS-04 | platform.composition | WP-07 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-21-04 | software | Software completion requires documented real voice/model routes. | SPEC-11.voice-selection | voice.cascade | WP-17 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-21-05 | software | Software completion requires real connector transports and configurable domain… | SPEC-16.integration-records | operator.onboarding | WP-32 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-21-06 | software | Software completion requires durable context, case, action and audit. | OPS-01, ACT-02 | actions.effects | WP-25 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-21-07 | software | Software completion requires complete operator surfaces. | SPEC-13.console | operator.console | WP-38 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-21-08 | software | Software completion requires working packaging, migrations, rollback and privac… | SPEC-15.rollback, DATA-03 | operations.commands | WP-41 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-21-09 | evaluation | Software completion requires executed local verification. | SPEC-14.test-layers | platform.invariants | WP-43 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-21-10 | constraint | No mandatory operation may silently return canned success, TEST IDs, an empty h… | OPS-04, OPS-03 | platform.composition | WP-07 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-21-11 | environment | Tenant activation requires exact configurations, contracts, identity/permission… | OPS-04, OPS-05 | activation.qualification | WP-45 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-21-12 | document | Where vendor capability cannot be confirmed, describe its precise limit and the… | SPEC-3.vendor-capability-gate | activation.qualification | WP-45 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-21-13 | constraint | Do not claim an arbitrary internal API is integrated before its mapping and beh… | OPS-03 | platform.invariants | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | — |
| FO-21-14 | document | Final response states release artifact and start commands. | — | release.supply_chain | WP-40 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-21-15 | document | Final response lists completed capabilities with both status axes. | SPEC-16.status-vocabulary | governance.documents | WP-44 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-21-16 | document | Final response states exact tests run and results. | — | governance.documents | WP-44 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-21-17 | document | Final response lists failures, inconclusive and unrun checks. | OPS-03 | governance.documents | WP-44 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-21-18 | document | Final response lists remaining tenant configuration/approval evidence. | SPEC-5.prerequisite-register | governance.documents | WP-44 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-21-19 | document | Final response states cost actually incurred. | OPS-05 | governance.documents | WP-44 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-21-20 | document | Final response states the precise next operational step. | — | governance.documents | WP-44 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-21-21 | constraint | No unsupported completion percentage, legal certificate, zero-risk claim, bench… | OPS-03 | governance.documents | WP-44 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-21-22 | operations | Maintain continuation state so a context reset does not lose requirements. | SPEC-16.progress-handoff | governance.documents | WP-44 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-21-23 | software | Integrate the modules: every production component the product depends on is wir… | OPS-04, OPS-03 | platform.invariants | WP-43 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-22-01 | constraint | Preserve all 27 invariant IDs with their meaning. | AUTH-01, AUTH-07, DATA-01, DATA-04, ACT-01, ACT-05, SAFE-01, SAFE-05, OPS-01, OPS-06 | governance.documents | WP-44 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-22-02 | constraint | Preserve administrative scope (no diagnosis, therapy, screening, medication adv… | SAFE-01, SPEC-10.no-clinical-advice | conversation.harness | WP-10 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-22-03 | constraint | Preserve three audiences with role enforcement. | SPEC-4.audience-permissions, AUTH-05 | authority.registries | WP-19 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-22-04 | constraint | Preserve role/proxy restrictions. | SPEC-4.role-selection, AUTH-05 | authority.registries | WP-19 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-22-05 | constraint | Preserve account-bound identity. | AUTH-01, AUTH-03, SPEC-7.assurance-tiers | identity.caller | WP-05 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-22-06 | constraint | Preserve exact-action confirmation. | ACT-01, SPEC-11.confirmation-readback | voice.release_boundary | WP-14 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-22-07 | constraint | Preserve UNKNOWN handling. | ACT-03, OPS-03 | evaluation.test_truth | WP-01 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | 9 (PASS) |
| FO-22-08 | constraint | Preserve independent audit. | OPS-01, SPEC-13.audit-model | audit.independent | — | VERIFIED_LOCAL | NOT_CONFIGURED | NOT_RUN | 4 (NOT_RUN) |
| FO-22-09 | constraint | Preserve verified transfer. | SAFE-04 | handoff.transfer | WP-28 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-22-10 | constraint | Preserve human/safety continuity. | SAFE-02, SAFE-03, OPS-02 | continuity.ai_off | WP-15 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-22-11 | constraint | Preserve source-grounding. | SPEC-9.retrieval, SPEC-11.response-gate | conversation.harness | WP-10 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-22-12 | constraint | Preserve retention/consent. | DATA-03, SPEC-6.consent-before-recording | privacy.operations | WP-22 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-22-13 | evaluation | Preserve real audio tests. | SPEC-14.test-layers | voice.cascade | WP-17 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-22-14 | document | Preserve capacity/cost planning. | SPEC-12.capacity-model | operations.resilience_cost | WP-42 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-22-15 | constraint | Preserve staged deployment. | SPEC-15.pilot-promotion | governance.documents | WP-44 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-22-16 | software | Build the independent controllable LiveKit reference runtime as mandatory softw… | — | voice.media_runtime | WP-11 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-22-17 | software | Keep Talkdesk native as a qualified option. | SPEC-3.vendor-capability-gate, AUTH-07 | conversation.talkdesk_native | WP-29 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-22-18 | constraint | Existing phone routing changes still require authority. | OPS-05 | contact_center.talkdesk | WP-29 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-22-19 | software | Bounded graph option with a single durable case owner and mandatory controlled… | — | conversation.harness | WP-10 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-22-20 | software | Offline slice is no longer the endpoint: complete real adapters, composition, c… | SPEC-15.offline-slice | platform.composition | WP-07 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-22-21 | evaluation | The offline slice becomes a regression environment. | SPEC-15.offline-slice | platform.composition | WP-07 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-22-22 | software | Extend limited memory to permissioned historical timelines plus event-fed proje… | SPEC-9.memory | context.store | WP-18 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-22-23 | software | Eighteen tools and seven workflows are a baseline to extend, not a cap. | SPEC-8.tool-surface, SPEC-4.workflow-catalogue | workflows.families | WP-30 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-22-24 | software | Add product onboarding/studio. | — | operator.studio | WP-33 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-22-25 | software | Add a real-model harness. | — | conversation.harness | WP-10 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-22-26 | evaluation | Add full-duplex evaluation. | — | evaluation.drivers | WP-34 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-22-27 | software | Add calibrated monitors. | — | evaluation.monitors | WP-35 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-22-28 | software | Add controlled improvement. | — | improvement.pipeline | WP-36 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-22-29 | software | Add complete operator workflows. | SPEC-13.console | operator.console | WP-38 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-22-30 | constraint | Preserve baseline latency/naturalness targets; tighter goals are optimization t… | SPEC-13.slo-definitions | voice.cascade | WP-17 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-22-31 | constraint | Remove original calendar/staffing delivery estimates as completion promises. | — | governance.documents | WP-44 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-22-32 | document | Earlier dated vendor/legal statements require current validation; the original… | SPEC-16.integration-records | governance.documents | WP-44 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-23-01 | constraint | Verify changeable API, model and licence details at implementation time; the re… | — | models.registry | WP-09 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-23-02 | constraint | Do not use research papers as training data by default. | — | improvement.canary_training | WP-37 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-23-03 | constraint | Licences for articles, datasets, code, weights and voices are separate and are… | — | models.registry | WP-09 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-23-04 | constraint | R08 (CC-BY-NC-ND): cite its findings only; never bundle, mine or train on its t… | — | improvement.canary_training | WP-37 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-23-05 | constraint | R03: never report tau-Voice model rankings or simulated-time latency as current… | — | evaluation.drivers | WP-34 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-23-06 | constraint | R06: a judge sensitivity measured on few positives (for example 6/6 with a 95%… | — | evaluation.monitors | WP-35 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-23-07 | constraint | Recommendations and targets are our design choices, not thresholds imposed by p… | — | governance.documents | WP-44 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-23-08 | constraint | V01: the Personal Agent Protocol is not an assumed stable dependency. | — | governance.documents | WP-06 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | 3 (PASS) |
| FO-23-09 | constraint | V05: vendor public trust and reliability commitments are not this product's aud… | — | governance.documents | WP-44 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-23-10 | constraint | V06/V07: never use clinical notes or internal workforce material as support tra… | — | improvement.canary_training | WP-37 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-23-11 | constraint | V07: customers never get broad coding or data capabilities: no coding, SQL, she… | — | conversation.harness | WP-10 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-23-12 | constraint | T10: no context-window size, quota or endpoint is assumed for Nova 2.5 Sonic or… | — | models.registry | WP-09 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-23-13 | constraint | M01-M11: exact model revisions and licences are pinned at release. | — | models.registry | WP-09 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
| FO-23-14 | constraint | L01-L08: legal and security references require an applicability review; eligibl… | — | governance.documents | WP-44 | IMPLEMENTED | NOT_CONFIGURED | NOT_RUN | — |
| FO-23-15 | constraint | Company material (V01-V08) is attributed public description, not independent as… | — | governance.documents | WP-44 | MISSING | NOT_CONFIGURED | NOT_RUN | — |
