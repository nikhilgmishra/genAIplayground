# Requirements traceability

<!-- GENERATED FILE: do not edit by hand. Source: docs/requirements/catalog.yaml; generator: platform/src/evaluation/traceability.ts -->

Catalogue version `2026-10-17.1` (sha256 `5eedf9472a4bf8c4…`). Generated at 2026-10-18T16:50:35.174Z.  
Test results joined from: `evidence/test-reports/vitest-platform.json`, `evidence/test-reports/vitest-console.json`, `evidence/test-reports/opa-vsp.json`, `evidence/test-reports/opa-terraform.json`.

## Status legend

| Status | Meaning |
|---|---|
| `IMPLEMENTED_OFFLINE` | At least one tagged test exists and every tagged test passed in a recorded run (local fixtures / synthetic data only) |
| `NOT_RUN` | Tagged tests exist but at least one has no recorded result or was skipped |
| `NO_TEST` | No test carries this requirement's tag (gap) |
| `FAILING` | At least one tagged test failed |
| `BLOCKED` | Verification beyond the offline slice depends on an external prerequisite; overrides the release status for sandbox and production gates (offline status shown in brackets) |

`VERIFIED_SANDBOX`, `APPROVED_PILOT` and `VERIFIED_PRODUCTION` are never produced by this generator: they require sandbox or production evidence and human approvals. Unknown, missing evidence and unrun tests are not PASS (OPS-03).

## Summary

| Requirements | Tagged tests | IMPLEMENTED_OFFLINE | NOT_RUN | NO_TEST | FAILING | BLOCKED (release) |
|---|---|---|---|---|---|---|
| 150 | 1942 | 115 | 0 | 35 | 0 | 89 |

Offline columns count every requirement by its offline status; BLOCKED counts requirements whose release status is externally blocked.

## Matrix

| Requirement | Text (short) | Enforcement location | Test IDs | Latest result | Evidence path | Release status |
|---|---|---|---|---|---|---|
| AUTH-01 | Caller ID, DOB, NPI and spoken claims never authenticate a session alone. | `platform/src/identity`, `policy/` | 12: `platform/src/adapters/local/identity-directory.test.ts:14`<br>`platform/src/business/tools.test.ts:222`<br>`platform/src/business/tools.test.ts:261`<br>`platform/src/gateway/http/routes.test.ts:175` (+8 more) | PASS (12/12) | `evidence/test-reports/vitest-platform.json` | BLOCKED (offline: IMPLEMENTED_OFFLINE; PRQ-005, PRQ-030) |
| AUTH-02 | Every protected read and mutation is authorized in trusted backend code. | `platform/src/gateway`, `platform/src/policy`, `policy/` | 43: `console/src/auth/rbac.test.tsx:81`<br>`console/src/auth/rbac.test.tsx:94`<br>`platform/src/actions/action-service.test.ts:516`<br>`platform/src/adapters/live/salesforce-rest.contract.test.ts:157` (+39 more) | PASS (43/43) | `evidence/test-reports/vitest-console.json`, `evidence/test-reports/vitest-platform.json` | IMPLEMENTED_OFFLINE |
| AUTH-03 | Actor, subject, organization, assurance and consent are server-established. | `platform/src/identity`, `platform/src/gateway`, `platform/src/protocol/common.ts` | 40: `platform/src/actions/action-service.test.ts:851`<br>`platform/src/audit/schema.test.ts:108`<br>`platform/src/console-api/auth.test.ts:57`<br>`platform/src/gateway/catalog.test.ts:57` (+36 more) | PASS (40/40) | `evidence/test-reports/vitest-platform.json` | BLOCKED (offline: IMPLEMENTED_OFFLINE; PRQ-013) |
| AUTH-04 | Expired or revoked sessions fail closed even if TTL cleanup has not run. | `platform/src/identity` | 35: `platform/src/actions/action-service.invalidation.test.ts:251`<br>`platform/src/actions/action-service.test.ts:827`<br>`platform/src/actions/action-service.test.ts:836`<br>`platform/src/actions/action-service.test.ts:845` (+31 more) | PASS (35/35) | `evidence/test-reports/vitest-platform.json` | IMPLEMENTED_OFFLINE |
| AUTH-05 | A provider or partner cannot access an unrelated person's records. | `policy/`, `platform/src/identity`, `platform/migrations` | 79: `platform/src/actions/action-service.reconciliation.test.ts:145`<br>`platform/src/actions/action-service.reconciliation.test.ts:159`<br>`platform/src/actions/action-service.reconciliation.test.ts:170`<br>`platform/src/actions/action-service.reconciliation.test.ts:310` (+75 more) | PASS (79/79) | `evidence/test-reports/vitest-platform.json` | BLOCKED (offline: IMPLEMENTED_OFFLINE; PRQ-005, PRQ-007) |
| AUTH-06 | Verification secrets never reach a model, transcript or ordinary logs. | `platform/src/identity`, `platform/src/observability`, `platform/src/audit` | 16: `platform/src/actions/digest.test.ts:109`<br>`platform/src/adapters/local/notification-fixture.test.ts:21`<br>`platform/src/audit/deferred.test.ts:116`<br>`platform/src/audit/schema.test.ts:44` (+12 more) | PASS (16/16) | `evidence/test-reports/vitest-platform.json` | BLOCKED (offline: IMPLEMENTED_OFFLINE; PRQ-015) |
| AUTH-07 | Talkdesk Auth Gate false, null, undefined and reused-session cases are tested. | `platform/src/identity`, `talkdesk/auth-gate.md` | 15: `platform/src/gateway/http/routes.test.ts:131`<br>`platform/src/gateway/http/routes.test.ts:142`<br>`platform/src/gateway/http/routes.test.ts:353`<br>`platform/src/gateway/openapi.test.ts:67` (+11 more) | PASS (15/15) | `evidence/test-reports/vitest-platform.json` | BLOCKED (offline: IMPLEMENTED_OFFLINE; PRQ-018) |
| DATA-01 | No PHI goes to an unapproved endpoint, developer tool or analytics sink. | `platform/src/privacy`, `platform/src/observability`, `platform/src/config` | 96: `console/src/pages/CallInvestigationPage.test.tsx:18`<br>`platform/src/actions/action-service.reconciliation.test.ts:182`<br>`platform/src/actions/action-service.test.ts:93`<br>`platform/src/actions/tool-idempotency.test.ts:151` (+92 more) | PASS (96/96) | `evidence/test-reports/vitest-console.json`, `evidence/test-reports/vitest-platform.json` | BLOCKED (offline: IMPLEMENTED_OFFLINE; PRQ-002, PRQ-047) |
| DATA-02 | Raw audio remains sensitive even when a later transcript is redacted. | `platform/src/privacy`, `platform/src/retention`, `docs/privacy` | 11: `platform/src/privacy/classification.test.ts:6`<br>`platform/src/privacy/classification.test.ts:15`<br>`platform/src/privacy/classification.test.ts:22`<br>`platform/src/privacy/classification.test.ts:30` (+7 more) | PASS (11/11) | `evidence/test-reports/vitest-platform.json` | BLOCKED (offline: IMPLEMENTED_OFFLINE; PRQ-003) |
| DATA-03 | Recording and processing follow approved consent and retention controls. | `platform/src/privacy`, `platform/src/retention`, `talkdesk/studio-flow-spec.md` | 35: `platform/src/adapters/integration-inventory.test.ts:105`<br>`platform/src/evaluation/corpus.test.ts:319`<br>`platform/src/evaluation/driver/local-driver.test.ts:157`<br>`platform/src/memory/support-memory.test.ts:172` (+31 more) | PASS (35/35) | `evidence/test-reports/vitest-platform.json` | BLOCKED (offline: IMPLEMENTED_OFFLINE; PRQ-025, PRQ-026) |
| DATA-04 | A summary or memory cannot establish identity, consent or medical fact. | `platform/src/memory` | 19: `platform/src/business/cases.test.ts:30`<br>`platform/src/business/cases.test.ts:43`<br>`platform/src/business/cases.test.ts:52`<br>`platform/src/business/support-requests.test.ts:183` (+15 more) | PASS (19/19) | `evidence/test-reports/vitest-platform.json` | IMPLEMENTED_OFFLINE |
| ACT-01 | Every consequential action has fresh, transaction-bound confirmation. | `platform/src/actions`, `platform/src/voice` | 69: `platform/src/actions/action-service.invalidation.test.ts:75`<br>`platform/src/actions/action-service.invalidation.test.ts:99`<br>`platform/src/actions/action-service.invalidation.test.ts:130`<br>`platform/src/actions/action-service.invalidation.test.ts:146` (+65 more) | PASS (69/69) | `evidence/test-reports/vitest-platform.json` | BLOCKED (offline: IMPLEMENTED_OFFLINE; PRQ-014) |
| ACT-02 | Retry, redelivery and crash-after-commit tests create no duplicate effect. | `platform/src/actions`, `platform/src/outbox` | 75: `console/src/pages/ReconciliationPage.test.tsx:59`<br>`console/src/pages/SupportTracePage.test.tsx:42`<br>`platform/src/actions/action-service.property.test.ts:143`<br>`platform/src/actions/action-service.reconciliation.test.ts:216` (+71 more) | PASS (75/75) | `evidence/test-reports/vitest-console.json`, `evidence/test-reports/vitest-platform.json` | BLOCKED (offline: IMPLEMENTED_OFFLINE; PRQ-007) |
| ACT-03 | An ambiguous timeout is reconciled before retry or success is announced. | `platform/src/actions` | 69: `console/src/pages/PendingActionsPage.test.tsx:24`<br>`console/src/pages/ReconciliationPage.test.tsx:12`<br>`console/src/pages/ReconciliationPage.test.tsx:48`<br>`platform/src/actions/action-service.invalidation.test.ts:75` (+65 more) | PASS (69/69) | `evidence/test-reports/vitest-console.json`, `evidence/test-reports/vitest-platform.json` | BLOCKED (offline: IMPLEMENTED_OFFLINE; PRQ-007) |
| ACT-04 | Case creation and workflow acceptance do not count as issue resolution. | `platform/src/workflows`, `platform/src/business`, `platform/src/evaluation/scorer.ts` | 28: `platform/src/actions/action-service.reconciliation.test.ts:182`<br>`platform/src/adapters/local/billing-fixture.test.ts:50`<br>`platform/src/adapters/local/support-records-fixture.test.ts:85`<br>`platform/src/business/billing.test.ts:91` (+24 more) | PASS (28/28) | `evidence/test-reports/vitest-platform.json` | IMPLEMENTED_OFFLINE |
| ACT-05 | Protected utterances cannot be spoken before authorization and validation. | `platform/src/voice` | 35: `platform/src/adapters/local/telephony-fixture.test.ts:195`<br>`platform/src/business/transactions.test.ts:123`<br>`platform/src/business/transactions.test.ts:137`<br>`platform/src/business/wiring.test.ts:63` (+31 more) | PASS (35/35) | `evidence/test-reports/vitest-platform.json` | BLOCKED (offline: IMPLEMENTED_OFFLINE; PRQ-016) |
| SAFE-01 | No diagnosis, therapy, clinical screening or medication recommendation. | `platform/src/safety`, `platform/src/voice` | 11: `platform/src/business/handoff.test.ts:124`<br>`platform/src/business/handoff.test.ts:224`<br>`platform/src/safety/clinical-boundary.test.ts:50`<br>`platform/src/safety/clinical-boundary.test.ts:64` (+7 more) | PASS (11/11) | `evidence/test-reports/vitest-platform.json` | BLOCKED (offline: IMPLEMENTED_OFFLINE; PRQ-008, PRQ-028, PRQ-012) |
| SAFE-02 | Safety routing and human requests do not require account authentication. | `platform/src/safety`, `platform/src/ops`, `platform/src/gateway` | 64: `platform/src/actions/action-service.invalidation.test.ts:230`<br>`platform/src/business/handoff.test.ts:39`<br>`platform/src/business/handoff.test.ts:52`<br>`platform/src/business/handoff.test.ts:134` (+60 more) | PASS (64/64) | `evidence/test-reports/vitest-platform.json` | BLOCKED (offline: IMPLEMENTED_OFFLINE; PRQ-017) |
| SAFE-03 | Refusal counts, silence and cost limits never silently terminate safety flow. | `platform/src/ops`, `platform/src/safety`, `talkdesk/ai-agent-config.yaml` | 67: `console/src/pages/BudgetsPage.test.tsx:21`<br>`platform/src/audit/deferred.test.ts:51`<br>`platform/src/business/handoff.test.ts:134`<br>`platform/src/business/handoff.test.ts:169` (+63 more) | PASS (67/67) | `evidence/test-reports/vitest-console.json`, `evidence/test-reports/vitest-platform.json` | BLOCKED (offline: IMPLEMENTED_OFFLINE; PRQ-017) |
| SAFE-04 | Transfer succeeds only with receiver acceptance and verified connection. | `platform/src/workflows/transfer.ts` | 25: `platform/src/adapters/local/telephony-fixture.test.ts:95`<br>`platform/src/adapters/local/telephony-fixture.test.ts:108`<br>`platform/src/adapters/local/telephony-fixture.test.ts:204`<br>`platform/src/adapters/local/telephony-fixture.transfer-contract.test.ts:57` (+21 more) | PASS (25/25) | `evidence/test-reports/vitest-platform.json` | BLOCKED (offline: IMPLEMENTED_OFFLINE; PRQ-019) |
| SAFE-05 | A caller, model or retrieved document cannot choose an arbitrary dial target. | `platform/src/config`, `platform/src/workflows/transfer.ts` | 27: `console/src/pages/CallInvestigationPage.test.tsx:81`<br>`platform/src/adapters/live/blocked.test.ts:114`<br>`platform/src/adapters/local/telephony-fixture.test.ts:42`<br>`platform/src/adapters/local/telephony-fixture.test.ts:71` (+23 more) | PASS (27/27) | `evidence/test-reports/vitest-console.json`, `evidence/test-reports/vitest-platform.json` | IMPLEMENTED_OFFLINE |
| OPS-01 | Every accepted consequential action has durable independent audit evidence. | `platform/src/audit`, `platform/src/actions` | 99: `platform/src/actions/action-service.property.test.ts:143`<br>`platform/src/actions/action-service.reconciliation.test.ts:79`<br>`platform/src/actions/action-service.reconciliation.test.ts:129`<br>`platform/src/actions/action-service.test.ts:661` (+95 more) | PASS (99/99) | `evidence/test-reports/vitest-platform.json` | BLOCKED (offline: IMPLEMENTED_OFFLINE; PRQ-037, PRQ-040) |
| OPS-02 | AI failure preserves a usable telephony route with documented capacity. | `talkdesk/studio-flow-spec.md`, `platform/src/ops` | 14: `platform/src/gateway/pipeline.test.ts:322`<br>`platform/src/gateway/pipeline.test.ts:337`<br>`platform/src/ops/admission.test.ts:142`<br>`platform/src/ops/admission.test.ts:154` (+10 more) | PASS (14/14) | `evidence/test-reports/vitest-platform.json` | BLOCKED (offline: IMPLEMENTED_OFFLINE; PRQ-009, PRQ-022, PRQ-049) |
| OPS-03 | Unknown capabilities, missing evidence and unrun tests are not PASS. | `platform/src/evaluation/scorer.ts`, `platform/src/evaluation/aggregate.ts`, `platform/src/evaluation/traceability.ts`, `docs/prerequisites.yaml` | 61: `platform/src/adapters/integration-inventory.test.ts:33`<br>`platform/src/adapters/integration-inventory.test.ts:46`<br>`platform/src/adapters/live/blocked.test.ts:91`<br>`platform/src/adapters/live/blocked.test.ts:100` (+57 more) | PASS (61/61) | `evidence/test-reports/vitest-platform.json` | IMPLEMENTED_OFFLINE |
| OPS-04 | Production refuses fixture adapters and missing mandatory approvals. | `platform/src/config/guard.ts` | 72: `console/src/auth/login.test.tsx:8`<br>`console/src/auth/login.test.tsx:29`<br>`platform/src/adapters/live/salesforce-rest.contract.test.ts:392`<br>`platform/src/adapters/local/synthetic-store.test.ts:7` (+68 more) | PASS (72/72) | `evidence/test-reports/vitest-console.json`, `evidence/test-reports/vitest-platform.json` | BLOCKED (offline: IMPLEMENTED_OFFLINE; PRQ-023) |
| OPS-05 | No paid tests, PHI access or production changes without scoped authorization. | `platform/src/config/guard.ts`, `approvals/`, `platform/src/ops/budgets.ts` | 9: `platform/src/config/guard.test.ts:502`<br>`platform/src/config/guard.test.ts:520`<br>`platform/src/config/guard.test.ts:527`<br>`platform/src/config/guard.test.ts:536` (+5 more) | PASS (9/9) | `evidence/test-reports/vitest-platform.json` | BLOCKED (offline: IMPLEMENTED_OFFLINE; PRQ-010, PRQ-024) |
| OPS-06 | Model, voice, knowledge, tools and policy versions are pinned and reviewable. | `platform/src/evaluation/manifest.ts`, `platform/src/protocol/release.ts` | 64: `console/src/pages/ReleasesPage.test.tsx:8`<br>`console/src/pages/ReleasesPage.test.tsx:29`<br>`platform/src/business/tools.test.ts:113`<br>`platform/src/config/guard.test.ts:397` (+60 more) | PASS (64/64) | `evidence/test-reports/vitest-console.json`, `evidence/test-reports/vitest-platform.json` | BLOCKED (offline: IMPLEMENTED_OFFLINE; PRQ-020, PRQ-041, PRQ-042) |
| SPEC-2.auth-gate-values | Auth Gate is tested for missing, null, false, string values, expiry and session reuse; an… | `platform/src/identity`, `talkdesk/auth-gate.md` | — | NO_TEST | — | BLOCKED (offline: NO_TEST; PRQ-018) |
| SPEC-2.version-proof | Prove which agent/model/voice version each simulator or evaluation test exercises; never… | `platform/src/evaluation/runner.ts`, `talkdesk/simulator-and-evaluation-runbook.md` | — | NO_TEST | — | BLOCKED (offline: NO_TEST; PRQ-020) |
| SPEC-2.guardrail-exit | Guardrail exits route back to Studio; crisis and accessibility interactions reach a human… | `talkdesk/ai-agent-config.yaml`, `talkdesk/studio-flow-spec.md`, `platform/src/safety` | 10: `platform/src/safety/conversation-guard.property.test.ts:94` (as SPEC-2.guardrail)<br>`platform/src/safety/conversation-guard.property.test.ts:119` (as SPEC-2.guardrail)<br>`platform/src/safety/conversation-guard.property.test.ts:129` (as SPEC-2.guardrail)<br>`platform/src/safety/conversation-guard.test.ts:30` (as SPEC-2.guardrail) (+6 more) | PASS (10/10) | `evidence/test-reports/vitest-platform.json` | BLOCKED (offline: IMPLEMENTED_OFFLINE; PRQ-017) |
| SPEC-2.model-evidence | Exact model, region, quota and endpoint evidence is required before selecting a speech or… | `docs/vendor-integration-inventory.md`, `platform/src/evaluation/manifest.ts` | — | NO_TEST | — | BLOCKED (offline: NO_TEST; PRQ-045) |
| SPEC-3.trust-boundaries | Caller input, retrieved articles, tool free text, transcripts and uploads are untrusted;… | `platform/src/gateway`, `docs/ARCHITECTURE.md` | 1: `platform/test/docs/prerequisites.test.ts:114` | PASS (1/1) | `evidence/test-reports/vitest-platform.json` | IMPLEMENTED_OFFLINE |
| SPEC-3.independent-human-route | An independent Studio route to human support exists that needs no model response, gateway… | `talkdesk/studio-flow-spec.md` | — | NO_TEST | — | BLOCKED (offline: NO_TEST; PRQ-004, PRQ-009) |
| SPEC-3.workflow-engine | Durable work uses Step Functions Standard workflows; no second workflow engine, Kafka or… | `platform/src/workflows`, `infra/stepfunctions`, `docs/adr` | 5: `platform/src/workflows/asl.test.ts:53` (as SPEC-3.stepfunctions)<br>`platform/src/workflows/asl.test.ts:60` (as SPEC-3.stepfunctions)<br>`platform/src/workflows/asl.test.ts:264` (as SPEC-3.stepfunctions)<br>`platform/src/workflows/asl.test.ts:282` (as SPEC-3.stepfunctions) (+1 more) | PASS (5/5) | `evidence/test-reports/vitest-platform.json` | BLOCKED (offline: IMPLEMENTED_OFFLINE; PRQ-037) |
| SPEC-3.vendor-capability-gate | Before PHI-bearing production calls, demonstrate trusted call-context binding, secure ver… | `talkdesk/capability-gate.md` | — | NO_TEST | — | BLOCKED (offline: NO_TEST; PRQ-013, PRQ-014, PRQ-015, PRQ-016, PRQ-017, PRQ-018, PRQ-019, PRQ-022) |
| SPEC-3.ingress | Only the ingress needed by Talkdesk is exposed, with TLS, WAF and narrow authentication;… | `infra/terraform` | — | NO_TEST | — | BLOCKED (offline: NO_TEST; PRQ-037) |
| SPEC-4.outcomes | Distinct outcomes RESOLVED, REQUEST_ACCEPTED, TRANSFERRED, INFORMATION_PROVIDED, DECLINED… | `platform/src/workflows/outcome.ts`, `platform/src/protocol/common.ts`, `platform/src/evaluation/scorer.ts` | — | NO_TEST | — | NO_TEST |
| SPEC-4.resolution-contracts | Each workflow has a versioned resolution contract (audience, intent, assurance, permitted… | `platform/src/business`, `platform/src/protocol/contracts.ts` | — | NO_TEST | — | BLOCKED (offline: NO_TEST; PRQ-033) |
| SPEC-4.workflow-catalogue | Implement public FAQs, login guidance, appointment lookup/create/reschedule, invoice expl… | `platform/src/business`, `platform/src/gateway`, `scenarios/skeletons` | 7: `platform/src/adapters/local/billing-fixture.test.ts:33` (as SPEC-4.billing)<br>`platform/src/adapters/local/read-fixtures.test.ts:20` (as SPEC-4.claims)<br>`platform/src/adapters/local/read-fixtures.test.ts:43` (as SPEC-4.provider)<br>`platform/src/adapters/local/scheduling-fixture.test.ts:37` (as SPEC-4.scheduling) (+3 more) | PASS (7/7) | `evidence/test-reports/vitest-platform.json` | BLOCKED (offline: IMPLEMENTED_OFFLINE; PRQ-007) |
| SPEC-4.audience-permissions | Provider identifiers, partner email domains and caller statements do not establish access… | `policy/`, `platform/src/identity` | 7: `platform/src/adapters/local/relationship-directory-fixture.test.ts:78` (as SPEC-4.audience)<br>`platform/src/business/appointments.test.ts:250` (as SPEC-4.audience)<br>`platform/src/business/business-gaps.test.ts:89` (as SPEC-4.audience)<br>`platform/src/business/cases.test.ts:133` (as SPEC-4.audience) (+3 more) | PASS (7/7) | `evidence/test-reports/vitest-platform.json` | BLOCKED (offline: IMPLEMENTED_OFFLINE; PRQ-005) |
| SPEC-4.role-selection | A multi-role user selects one role; privileges are never combined silently. | `platform/src/identity`, `policy/` | 1: `platform/src/policy/engine.test.ts:149` (as SPEC-4.single-role) | PASS (1/1) | `evidence/test-reports/vitest-platform.json` | IMPLEMENTED_OFFLINE |
| SPEC-4.payments-isolated | Payments use an approved hosted payment page or isolated PCI flow; card numbers and secur… | `platform/src/voice`, `platform/src/privacy` | — | NO_TEST | — | BLOCKED (offline: NO_TEST; PRQ-050) |
| SPEC-4.prohibited-assertions | Invoice explanations do not decide coverage, waive fees or promise refunds; claim status… | `platform/src/voice`, `platform/src/business` | — | NO_TEST | — | NO_TEST |
| SPEC-5.prerequisite-register | Each prerequisite stores owner, status, evidence reference, approval date, expiry, enviro… | `docs/prerequisites.yaml`, `docs/tools/render-prerequisites.mjs` | 6: `platform/test/docs/prerequisites.test.ts:51` (as SPEC-5.prerequisites)<br>`platform/test/docs/prerequisites.test.ts:63` (as SPEC-5.prerequisites)<br>`platform/test/docs/prerequisites.test.ts:102` (as SPEC-5.prerequisites)<br>`platform/test/docs/prerequisites.test.ts:106` (as SPEC-5.prerequisites) (+2 more) | PASS (6/6) | `evidence/test-reports/vitest-platform.json` | IMPLEMENTED_OFFLINE |
| SPEC-6.data-classes | Separate transient conversational data, business records, restricted QA media and securit… | `platform/src/retention`, `platform/src/audit/sinks`, `docs/privacy` | 4: `platform/src/audit/sinks/s3-object-lock.test.ts:82` (as SPEC-6.3)<br>`platform/src/audit/sinks/s3-object-lock.test.ts:118` (as SPEC-6.3)<br>`platform/src/privacy/classification.test.ts:37`<br>`platform/src/privacy/classification.test.ts:57` | PASS (4/4) | `evidence/test-reports/vitest-platform.json` | BLOCKED (offline: IMPLEMENTED_OFFLINE; PRQ-025) |
| SPEC-6.redaction | Redact or tokenize before general logs, analytics and downstream sharing; redaction failu… | `platform/src/privacy` | 8: `platform/src/privacy/egress-startup.test.ts:104`<br>`platform/src/privacy/redaction.test.ts:18`<br>`platform/src/privacy/redaction.test.ts:41`<br>`platform/src/privacy/redaction.test.ts:52` (+4 more) | PASS (8/8) | `evidence/test-reports/vitest-platform.json` | IMPLEMENTED_OFFLINE |
| SPEC-6.no-phi-in-identifiers | No PHI in URLs, metric labels, alert text, resource names, trace baggage, error messages… | `platform/src/shared/ids.ts`, `platform/src/observability` | 8: `console/src/api/client.test.ts:111` (as SPEC-6.no-phi-url)<br>`console/src/api/contract.test.ts:130` (as SPEC-6.no-phi-url)<br>`console/src/pages/CallInvestigationPage.test.tsx:60` (as SPEC-6.no-phi-url)<br>`console/src/pages/CallInvestigationPage.test.tsx:72` (as SPEC-6.no-phi-url) (+4 more) | PASS (8/8) | `evidence/test-reports/vitest-console.json`, `evidence/test-reports/vitest-platform.json` | IMPLEMENTED_OFFLINE |
| SPEC-6.consent-before-recording | Consent is configured before recording where required; the approved alternative is offere… | `platform/src/privacy/consent.ts`, `talkdesk/studio-flow-spec.md` | 1: `platform/src/evaluation/corpus.test.ts:319` | PASS (1/1) | `evidence/test-reports/vitest-platform.json` | BLOCKED (offline: IMPLEMENTED_OFFLINE; PRQ-026) |
| SPEC-6.case-minimization | Store a concise approved summary and a permission-checked evidence reference in Cases ins… | `platform/src/business`, `platform/src/adapters` | — | NO_TEST | — | BLOCKED (offline: NO_TEST; PRQ-006) |
| SPEC-7.assurance-tiers | Assurance tiers A0 unverified, A1 verified possession, A2 account authenticated and A3 re… | `policy/`, `platform/src/protocol/common.ts`, `platform/src/identity` | — | NO_TEST | — | BLOCKED (offline: NO_TEST; PRQ-030) |
| SPEC-7.secure-link-binding | Secure link or in-portal approval requires existing account authentication and is bound w… | `platform/src/identity` | 12: `platform/src/adapters/live/oidc-verifier.test.ts:44` (as SPEC-7.OIDC)<br>`platform/src/adapters/live/oidc-verifier.test.ts:52` (as SPEC-7.OIDC)<br>`platform/src/adapters/live/oidc-verifier.test.ts:76` (as SPEC-7.OIDC)<br>`platform/src/adapters/live/oidc-verifier.test.ts:82` (as SPEC-7.OIDC) (+8 more) | PASS (12/12) | `evidence/test-reports/vitest-platform.json` | BLOCKED (offline: IMPLEMENTED_OFFLINE; PRQ-036) |
| SPEC-7.otp-limits | OTP fallback only to the existing verified channel, neutral message, five-minute expiry,… | `platform/src/identity/verification-service.ts` | 17: `platform/src/adapters/local/notification-fixture.test.ts:40` (as SPEC-7.OTP)<br>`platform/src/identity/config.test.ts:10` (as SPEC-7.OTP)<br>`platform/src/identity/enumeration-resistance.integration.test.ts:142` (as SPEC-7.OTP)<br>`platform/src/identity/verification-service.test.ts:407` (as SPEC-7.OTP) (+13 more) | PASS (17/17) | `evidence/test-reports/vitest-platform.json` | BLOCKED (offline: IMPLEMENTED_OFFLINE; PRQ-029, PRQ-015) |
| SPEC-7.anti-enumeration | Name and date of birth locate a candidate only inside the verification service; generic r… | `platform/src/identity`, `platform/src/adapters/local` | 14: `platform/src/adapters/local/identity-directory.test.ts:7` (as SPEC-7.DIRECTORY)<br>`platform/src/adapters/local/identity-directory.test.ts:34` (as SPEC-7.DIRECTORY)<br>`platform/src/adapters/local/identity-directory.test.ts:43` (as SPEC-7.DIRECTORY)<br>`platform/src/adapters/local/identity-directory.test.ts:59` (as SPEC-7.DIRECTORY) (+10 more) | PASS (14/14) | `evidence/test-reports/vitest-platform.json` | IMPLEMENTED_OFFLINE |
| SPEC-7.session-model | The server records tenant, call, session generation, actor, role, subject, organization,… | `platform/src/identity`, `platform/src/protocol/auth.ts` | 24: `platform/src/identity/config.test.ts:31` (as SPEC-7.SESSION)<br>`platform/src/identity/config.test.ts:42` (as SPEC-7.KV)<br>`platform/src/identity/kv/kv-store.test.ts:81` (as SPEC-7.KV)<br>`platform/src/identity/kv/kv-store.test.ts:88` (as SPEC-7.KV) (+20 more) | PASS (24/24) | `evidence/test-reports/vitest-platform.json` | IMPLEMENTED_OFFLINE |
| SPEC-7.assertions | Signed short-lived assertions are minted and validated only by trusted components with is… | `platform/src/identity/assertions` | 13: `platform/src/identity/assertions/assertion-service.test.ts:59` (as SPEC-7.ASSERTION)<br>`platform/src/identity/assertions/assertion-service.test.ts:73` (as SPEC-7.ASSERTION)<br>`platform/src/identity/assertions/assertion-service.test.ts:90` (as SPEC-7.ASSERTION)<br>`platform/src/identity/assertions/assertion-service.test.ts:123` (as SPEC-7.ASSERTION) (+9 more) | PASS (13/13) | `evidence/test-reports/vitest-platform.json` | BLOCKED (offline: IMPLEMENTED_OFFLINE; PRQ-037) |
| SPEC-7.privilege-expiry | Privileges expire at call end, participant change, account switching, recovery, revocatio… | `platform/src/identity`, `platform/src/workflows` | 2: `platform/src/identity/assertions/assertion-service.test.ts:190` (as SPEC-7.TRANSFER)<br>`platform/src/policy/engine.test.ts:236` (as SPEC-7.risk) | PASS (2/2) | `evidence/test-reports/vitest-platform.json` | IMPLEMENTED_OFFLINE |
| SPEC-7.data-layer-isolation | Field-level minimization and organization isolation are applied at the data layer; unrela… | `policy/`, `platform/migrations`, `platform/src/ops/staff-authz.ts` | 2: `platform/src/policy/console.test.ts:121` (as SPEC-7.organization-isolation)<br>`platform/src/policy/engine.test.ts:220` (as SPEC-7.organization-isolation) | PASS (2/2) | `evidence/test-reports/vitest-platform.json` | IMPLEMENTED_OFFLINE |
| SPEC-7.workforce-separation | Staff use workforce SSO with MFA and least privilege; roles are separated; break-glass is… | `platform/src/console-api`, `platform/src/ops/staff-authz.ts` | 40: `console/src/api/contract.test.ts:71` (as SPEC-7.staff)<br>`console/src/api/contract.test.ts:105` (as SPEC-7.staff)<br>`console/src/auth/login.test.tsx:52` (as SPEC-7.staff)<br>`console/src/auth/login.test.tsx:61` (as SPEC-7.staff-sso) (+36 more) | PASS (40/40) | `evidence/test-reports/vitest-console.json`, `evidence/test-reports/vitest-platform.json` | BLOCKED (offline: IMPLEMENTED_OFFLINE; PRQ-036) |
| SPEC-8.tool-surface | Only narrowly scoped tools are exposed; no raw SQL, arbitrary Salesforce query, arbitrary… | `platform/src/gateway`, `talkdesk/ai-agent-config.yaml` | 1: `platform/src/evaluation/driver/local-driver.test.ts:363` | PASS (1/1) | `evidence/test-reports/vitest-platform.json` | IMPLEMENTED_OFFLINE |
| SPEC-8.tool-schema | Each tool has a versioned strict JSON Schema, bounded input, enums, classification, minim… | `platform/src/gateway`, `platform/src/protocol/tools.ts` | 17: `platform/src/actions/tool-idempotency.test.ts:96` (as SPEC-8.1)<br>`platform/src/actions/tool-idempotency.test.ts:111` (as SPEC-8.1)<br>`platform/src/business/billing.test.ts:62`<br>`platform/src/business/tools.test.ts:49` (+13 more) | PASS (17/17) | `evidence/test-reports/vitest-platform.json` | IMPLEMENTED_OFFLINE |
| SPEC-8.webhook-auth | Inbound webhooks are validated with the vendor's documented mechanism and replay protecti… | `platform/src/gateway` | — | NO_TEST | — | BLOCKED (offline: NO_TEST; PRQ-021) |
| SPEC-8.service-identities | Separate service identities per environment and integration; short-lived OAuth2 preferred… | `platform/src/config`, `infra/terraform` | — | NO_TEST | — | BLOCKED (offline: NO_TEST; PRQ-037, PRQ-052) |
| SPEC-8.prepare-commit | A mutation is prepared with authoritative target, before-state version, exact change, imp… | `platform/src/actions` | 1: `platform/src/business/appointments.test.ts:201` | PASS (1/1) | `evidence/test-reports/vitest-platform.json` | IMPLEMENTED_OFFLINE |
| SPEC-8.commit-recheck | Commit rechecks authorization, freshness, current state and confirmation with optimistic… | `platform/src/actions` | — | NO_TEST | — | NO_TEST |
| SPEC-8.ledger | An action ledger and transactional outbox are persisted before durable delivery, with row… | `platform/src/actions`, `platform/src/outbox`, `platform/migrations` | 26: `platform/src/actions/action-service.reconciliation.test.ts:206` (as SPEC-8.3)<br>`platform/src/actions/action-service.reconciliation.test.ts:310` (as SPEC-8.3)<br>`platform/src/actions/action-service.test.ts:129` (as SPEC-8.3)<br>`platform/src/actions/action-service.test.ts:417` (as SPEC-8.3) (+22 more) | PASS (26/26) | `evidence/test-reports/vitest-platform.json` | IMPLEMENTED_OFFLINE |
| SPEC-8.outbox | Events are delivered at least once and consumers deduplicate. | `platform/src/outbox` | 2: `platform/src/actions/action-service.reconciliation.test.ts:145`<br>`platform/src/worker/worker.test.ts:167` | PASS (2/2) | `evidence/test-reports/vitest-platform.json` | BLOCKED (offline: IMPLEMENTED_OFFLINE; PRQ-037) |
| SPEC-8.timeout-states | On timeout distinguish NOT_STARTED, COMMITTED, FAILED and UNKNOWN; reconcile UNKNOWN by i… | `platform/src/actions` | 1: `platform/src/workflows/definitions.test.ts:71` (as SPEC-8.reconciliation) | PASS (1/1) | `evidence/test-reports/vitest-platform.json` | BLOCKED (offline: IMPLEMENTED_OFFLINE; PRQ-007) |
| SPEC-8.salesforce-model | Dedicated integration identity; interaction separated from issue; unique external ids and… | `platform/src/adapters`, `platform/src/adapters/support-records-schema.ts` | 19: `platform/src/adapters/live/salesforce-rest.contract.test.ts:92` (as SPEC-8.4)<br>`platform/src/adapters/live/salesforce-rest.contract.test.ts:115` (as SPEC-8.4)<br>`platform/src/adapters/live/salesforce-rest.contract.test.ts:126` (as SPEC-8.4)<br>`platform/src/adapters/live/salesforce-rest.contract.test.ts:189` (as SPEC-8.4) (+15 more) | PASS (19/19) | `evidence/test-reports/vitest-platform.json` | BLOCKED (offline: IMPLEMENTED_OFFLINE; PRQ-006, PRQ-035) |
| SPEC-8.salesforce-outage | When Salesforce is unavailable an encrypted internal support request and reference are pe… | `platform/src/business`, `platform/src/outbox`, `platform/src/console-api` | 2: `platform/src/evaluation/corpus.test.ts:294`<br>`platform/src/evaluation/driver/local-driver.test.ts:280` | PASS (2/2) | `evidence/test-reports/vitest-platform.json` | IMPLEMENTED_OFFLINE |
| SPEC-9.workflow | Follow-up is a versioned state machine; every nonterminal state has owner, deadline, retr… | `platform/src/workflows` | 28: `platform/src/workflows/asl.test.ts:77`<br>`platform/src/workflows/asl.test.ts:98`<br>`platform/src/workflows/asl.test.ts:126`<br>`platform/src/workflows/asl.test.ts:145` (+24 more) | PASS (28/28) | `evidence/test-reports/vitest-platform.json` | BLOCKED (offline: IMPLEMENTED_OFFLINE; PRQ-037) |
| SPEC-9.task-tokens | Human approvals arrive through authenticated, authorized endpoints; task tokens never app… | `platform/src/workflows/tokens.ts` | 25: `console/src/api/contract.test.ts:111` (as SPEC-9.workflow-token)<br>`console/src/pages/ApprovalsPage.test.tsx:8` (as SPEC-9.workflow-token)<br>`console/src/pages/ApprovalsPage.test.tsx:42` (as SPEC-9.workflow-token)<br>`platform/src/console-api/workflows.test.ts:34` (as SPEC-9.workflow-token) (+21 more) | PASS (25/25) | `evidence/test-reports/vitest-console.json`, `evidence/test-reports/vitest-platform.json` | IMPLEMENTED_OFFLINE |
| SPEC-9.recheck | Before later disclosure or material change, recheck consent, representation, account stat… | `platform/src/workflows/recheck.ts` | 20: `platform/src/workflows/asl.test.ts:205`<br>`platform/src/workflows/engine.test.ts:603`<br>`platform/src/workflows/engine.test.ts:631`<br>`platform/src/workflows/engine.test.ts:653` (+16 more) | PASS (20/20) | `evidence/test-reports/vitest-platform.json` | IMPLEMENTED_OFFLINE |
| SPEC-9.notifications | Notifications follow registered preferences, quiet hours and consent with neutral message… | `platform/src/workflows/notification-policy.ts` | 6: `platform/src/adapters/local/notification-fixture.test.ts:11` (as SPEC-9.NOTIFY)<br>`platform/src/adapters/local/notification-fixture.test.ts:28` (as SPEC-9.NOTIFY)<br>`platform/src/adapters/local/notification-fixture.test.ts:59` (as SPEC-9.NOTIFY)<br>`platform/src/workflows/notification-policy.test.ts:22` (as SPEC-9.notification) (+2 more) | PASS (6/6) | `evidence/test-reports/vitest-platform.json` | BLOCKED (offline: IMPLEMENTED_OFFLINE; PRQ-048) |
| SPEC-9.knowledge-ingestion | Knowledge enters through a controlled pipeline with owner, audience, intent, jurisdiction… | `platform/src/knowledge` | 34: `platform/src/evaluation/driver/local-driver.test.ts:418`<br>`platform/src/knowledge/conflicts.test.ts:22` (as SPEC-9.conflict)<br>`platform/src/knowledge/conflicts.test.ts:33` (as SPEC-9.conflict)<br>`platform/src/knowledge/conflicts.test.ts:45` (as SPEC-9.conflict) (+30 more) | PASS (34/34) | `evidence/test-reports/vitest-platform.json` | BLOCKED (offline: IMPLEMENTED_OFFLINE; PRQ-032) |
| SPEC-9.retrieval | Retrieval applies authorization and policy filters before semantic search and again befor… | `platform/src/knowledge` | 21: `platform/src/business/tools.test.ts:222`<br>`platform/src/business/tools.test.ts:232`<br>`platform/src/business/tools.test.ts:242`<br>`platform/src/evaluation/driver/local-driver.test.ts:328` (+17 more) | PASS (21/21) | `evidence/test-reports/vitest-platform.json` | IMPLEMENTED_OFFLINE |
| SPEC-9.memory | Only useful support memory with provenance labels and expiry; machine summaries never gra… | `platform/src/memory` | — | NO_TEST | — | NO_TEST |
| SPEC-10.no-clinical-advice | Clinical questions trigger a concise boundary statement and a human or clinician route; n… | `platform/src/safety/clinical-boundary.ts`, `platform/src/voice` | — | NO_TEST | — | BLOCKED (offline: NO_TEST; PRQ-028, PRQ-012) |
| SPEC-10.safety-signals | Safety concerns are detected from multiple signals (explicit phrases, contextual semantic… | `platform/src/safety` | 16: `platform/src/safety/detector.property.test.ts:37` (as SPEC-10.detection)<br>`platform/src/safety/detector.property.test.ts:63` (as SPEC-10.detection)<br>`platform/src/safety/detector.test.ts:84` (as SPEC-10.detection)<br>`platform/src/safety/detector.test.ts:105` (as SPEC-10.detection) (+12 more) | PASS (16/16) | `evidence/test-reports/vitest-platform.json` | BLOCKED (offline: IMPLEMENTED_OFFLINE; PRQ-017) |
| SPEC-10.signal-test-coverage | Safety tests include indirect language, negation, historical references, third-party conc… | `platform/src/safety`, `scenarios/risk` | 9: `platform/src/safety/detector.property.test.ts:73` (as SPEC-10.frustration)<br>`platform/src/safety/detector.test.ts:138` (as SPEC-10.negation)<br>`platform/src/safety/detector.test.ts:144` (as SPEC-10.negation)<br>`platform/src/safety/detector.test.ts:160` (as SPEC-10.negation) (+5 more) | PASS (9/9) | `evidence/test-reports/vitest-platform.json` | BLOCKED (offline: IMPLEMENTED_OFFLINE; PRQ-012, PRQ-008) |
| SPEC-10.safety-response | On a credible or unresolved concern stop administrative troubleshooting, revoke pending n… | `platform/src/safety`, `platform/src/actions` | 12: `platform/src/actions/action-service.test.ts:488` (as SPEC-10.1)<br>`platform/src/safety/router.test.ts:42` (as SPEC-10.routing)<br>`platform/src/safety/router.test.ts:69` (as SPEC-10.routing)<br>`platform/src/safety/router.test.ts:80` (as SPEC-10.routing) (+8 more) | PASS (12/12) | `evidence/test-reports/vitest-platform.json` | BLOCKED (offline: IMPLEMENTED_OFFLINE; PRQ-008, PRQ-028) |
| SPEC-10.no-auto-external-crisis | External crisis or emergency services are never conferenced automatically because a keywo… | `platform/src/safety/router.ts`, `platform/src/config` | — | NO_TEST | — | BLOCKED (offline: NO_TEST; PRQ-008) |
| SPEC-10.transfer | Transfer states REQUESTED, QUEUED, RECEIVER_ACCEPTED, BRIDGED, CALLER_CONFIRMED_CONNECTED… | `platform/src/workflows/transfer.ts` | 18: `platform/src/adapters/local/telephony-fixture.test.ts:175`<br>`platform/src/evaluation/corpus.test.ts:267`<br>`platform/src/safety/conversation-guard.test.ts:77`<br>`platform/src/workflows/transfer.test.ts:147` (+14 more) | PASS (18/18) | `evidence/test-reports/vitest-platform.json` | BLOCKED (offline: IMPLEMENTED_OFFLINE; PRQ-019) |
| SPEC-10.handoff-package | The authorized receiver gets a concise context package (issue, assurance and limits, subj… | `platform/src/workflows`, `platform/src/protocol/support.ts` | 1: `platform/src/business/handoff.test.ts:109` | PASS (1/1) | `evidence/test-reports/vitest-platform.json` | IMPLEMENTED_OFFLINE |
| SPEC-10.transfer-failure | The caller stays connected while the human joins; on failure an approved update plays and… | `platform/src/workflows/transfer.ts`, `talkdesk/studio-flow-spec.md` | — | NO_TEST | — | BLOCKED (offline: NO_TEST; PRQ-019, PRQ-043) |
| SPEC-10.safety-latency | Engineering target: initiate the priority route within two seconds of a validated safety… | `platform/src/safety`, `platform/src/observability/slo.ts` | 4: `platform/src/safety/safety-events.test.ts:51` (as SPEC-10.latency)<br>`platform/src/safety/safety-events.test.ts:66` (as SPEC-10.latency)<br>`platform/src/safety/safety-events.test.ts:76` (as SPEC-10.latency)<br>`platform/src/safety/safety-events.test.ts:186` (as SPEC-10.latency) | PASS (4/4) | `evidence/test-reports/vitest-platform.json` | BLOCKED (offline: IMPLEMENTED_OFFLINE; PRQ-043) |
| SPEC-11.opening-disclosure | Opening language identifies the company and automated role, offers a human and gives the… | `platform/src/voice/templates`, `talkdesk/studio-flow-spec.md` | 1: `platform/src/voice/registry.test.ts:95` (as SPEC-11.opening) | PASS (1/1) | `evidence/test-reports/vitest-platform.json` | BLOCKED (offline: IMPLEMENTED_OFFLINE; PRQ-026, PRQ-028) |
| SPEC-11.voice-selection | A licensed stock voice is chosen by blinded telephone-quality listening tests; no cloning… | `talkdesk/ai-agent-config.yaml` | — | NO_TEST | — | BLOCKED (offline: NO_TEST; PRQ-045) |
| SPEC-11.ack-not-resolution | A safe acknowledgment does not count as resolution latency or success; genuine delays get… | `platform/src/voice`, `platform/src/observability/slo.ts` | 1: `platform/src/voice/gate.test.ts:101` (as SPEC-11.acknowledgment) | PASS (1/1) | `evidence/test-reports/vitest-platform.json` | IMPLEMENTED_OFFLINE |
| SPEC-11.barge-in | Barge-in stops queued speech and invalidates stale segments; audio segments, tool results… | `platform/src/voice/speech-queue.ts`, `platform/src/voice/turns.ts` | 10: `platform/src/gateway/http/routes.test.ts:247`<br>`platform/src/safety/safety-flow.test.ts:92`<br>`platform/src/voice/speech-queue.test.ts:62`<br>`platform/src/voice/speech-queue.test.ts:117` (+6 more) | PASS (10/10) | `evidence/test-reports/vitest-platform.json` | BLOCKED (offline: IMPLEMENTED_OFFLINE; PRQ-043) |
| SPEC-11.endpointing | Callers who pause, stutter, speak slowly or use assistive communication are not clipped;… | `talkdesk/ai-agent-config.yaml`, `platform/src/voice` | — | NO_TEST | — | BLOCKED (offline: NO_TEST; PRQ-012, PRQ-043) |
| SPEC-11.interpreter | Unsupported languages go to a staffed interpreter path. | `talkdesk/studio-flow-spec.md`, `platform/src/config` | 3: `platform/src/safety/conversation-guard.test.ts:72`<br>`platform/src/safety/detector.test.ts:252`<br>`platform/src/safety/router.test.ts:133` | PASS (3/3) | `evidence/test-reports/vitest-platform.json` | BLOCKED (offline: IMPLEMENTED_OFFLINE; PRQ-009) |
| SPEC-11.response-gate | Protected responses are validated before their first audible segment using approved templ… | `platform/src/voice/gate.ts` | 6: `platform/src/business/tools.test.ts:118` (as SPEC-11.templates)<br>`platform/src/gateway/pipeline.test.ts:434` (as SPEC-11.templates)<br>`platform/src/voice/registry.test.ts:72` (as SPEC-11.templates)<br>`platform/src/voice/registry.test.ts:138` (as SPEC-11.templates) (+2 more) | PASS (6/6) | `evidence/test-reports/vitest-platform.json` | BLOCKED (offline: IMPLEMENTED_OFFLINE; PRQ-016) |
| SPEC-11.response-record | The response record references current authorization, accepted sources, receipts and poli… | `platform/src/voice` | 1: `platform/src/voice/speech-queue.test.ts:95` (as SPEC-11.fail-closed) | PASS (1/1) | `evidence/test-reports/vitest-platform.json` | IMPLEMENTED_OFFLINE |
| SPEC-11.confirmation-readback | Names are confirmed by spelling when needed and amounts, dates, time zones and consequenc… | `platform/src/voice` | 3: `platform/src/voice/gate.test.ts:62` (as SPEC-11.confirmation)<br>`platform/src/voice/gate.test.ts:82` (as SPEC-11.confirmation)<br>`platform/src/voice/slots.test.ts:85` (as SPEC-11.confirmation) | PASS (3/3) | `evidence/test-reports/vitest-platform.json` | IMPLEMENTED_OFFLINE |
| SPEC-12.capacity-model | Capacity figures are labelled planning assumptions; 30 days of real arrival data is requi… | `docs/capacity-cost-model.md`, `scripts/capacity_model.py`, `platform/src/ops/capacity.ts` | 7: `platform/src/gateway/call-state.test.ts:23` (as SPEC-12.capacity)<br>`platform/src/ops/admission.test.ts:226` (as SPEC-12.capacity)<br>`platform/src/ops/admission.test.ts:241` (as SPEC-12.capacity)<br>`platform/src/ops/admission.test.ts:333` (as SPEC-12.capacity) (+3 more) | PASS (7/7) | `evidence/test-reports/vitest-platform.json` | BLOCKED (offline: IMPLEMENTED_OFFLINE; PRQ-046) |
| SPEC-12.quotas | Quotas are contracted and tested separately for trunks, call starts, media legs, AI sessi… | `docs/vendor-integration-inventory.md`, `platform/src/ops` | 1: `platform/src/adapters/live/salesforce-rest.contract.test.ts:321` (as SPEC-12.quota) | PASS (1/1) | `evidence/test-reports/vitest-platform.json` | BLOCKED (offline: IMPLEMENTED_OFFLINE; PRQ-022) |
| SPEC-12.bounded-caching | Salesforce is not pulled on every speech turn; bounded authorized caching carries source… | `platform/src/adapters`, `platform/src/business` | 4: `platform/src/adapters/local/support-records-fixture.test.ts:145` (as SPEC-12.caching)<br>`platform/src/adapters/support-record-cache.test.ts:52` (as SPEC-12.caching)<br>`platform/src/adapters/support-record-cache.test.ts:62` (as SPEC-12.caching)<br>`platform/src/adapters/support-record-cache.test.ts:81` (as SPEC-12.caching) | PASS (4/4) | `evidence/test-reports/vitest-platform.json` | IMPLEMENTED_OFFLINE |
| SPEC-12.load-test | Load tests use distributions, long calls, transfer legs, retries and reconnects; test at… | `platform/test`, `scripts` | 7: `platform/test/load/load-smoke.test.ts:45`<br>`platform/test/load/load-smoke.test.ts:53`<br>`platform/test/load/load-smoke.test.ts:68`<br>`platform/test/load/load-smoke.test.ts:75` (+3 more) | PASS (7/7) | `evidence/test-reports/vitest-platform.json` | BLOCKED (offline: IMPLEMENTED_OFFLINE; PRQ-022, PRQ-010) |
| SPEC-12.resilience | Readiness checks, warm capacity, per-dependency bulkheads, timeouts, bounded retries with… | `platform/src/resilience` | 15: `platform/src/resilience/resilience.test.ts:63` (as SPEC-12.timeouts)<br>`platform/src/resilience/resilience.test.ts:84` (as SPEC-12.timeouts)<br>`platform/src/resilience/resilience.test.ts:91` (as SPEC-12.timeouts)<br>`platform/src/resilience/resilience.test.ts:97` (as SPEC-12.timeouts) (+11 more) | PASS (15/15) | `evidence/test-reports/vitest-platform.json` | IMPLEMENTED_OFFLINE |
| SPEC-12.no-retry-stacking | Avoid retries on top of retries; concurrent duplicate executions do not stack. | `platform/src/resilience`, `platform/src/actions/tool-idempotency.ts` | 13: `platform/src/actions/tool-idempotency.test.ts:60` (as SPEC-12.3)<br>`platform/src/actions/tool-idempotency.test.ts:69` (as SPEC-12.3)<br>`platform/src/outbox/outbox.test.ts:118` (as SPEC-12.3)<br>`platform/src/outbox/outbox.test.ts:171` (as SPEC-12.3) (+9 more) | PASS (13/13) | `evidence/test-reports/vitest-platform.json` | IMPLEMENTED_OFFLINE |
| SPEC-12.admission | Backpressure and admission control shed noncritical analytics and model work first while… | `platform/src/ops/admission.ts` | 5: `platform/src/gateway/pipeline.test.ts:337`<br>`platform/src/observability/metrics.test.ts:111` (as SPEC-13.admission)<br>`platform/src/ops/admission.test.ts:203` (as SPEC-12.load-shedding)<br>`platform/src/ops/admission.test.ts:220` (as SPEC-12.load-shedding) (+1 more) | PASS (5/5) | `evidence/test-reports/vitest-platform.json` | IMPLEMENTED_OFFLINE |
| SPEC-12.db-outage | A database outage blocks protected reads and writes while the telephone route remains usa… | `platform/src/gateway`, `platform/src/resilience` | — | NO_TEST | — | NO_TEST |
| SPEC-12.budget-cutoff | Budget exhaustion stops new nonessential automation and routes to continuity service; an… | `platform/src/ops/budgets.ts` | 13: `console/src/api/contract.test.ts:92` (as SPEC-12.budgets)<br>`console/src/pages/BudgetsPage.test.tsx:8` (as SPEC-12.budgets)<br>`platform/src/console-api/views.test.ts:183` (as SPEC-12.budgets)<br>`platform/src/ops/budgets.test.ts:53` (as SPEC-12.cost) (+9 more) | PASS (13/13) | `evidence/test-reports/vitest-console.json`, `evidence/test-reports/vitest-platform.json` | BLOCKED (offline: IMPLEMENTED_OFFLINE; PRQ-010) |
| SPEC-12.recovery | Proposed application recovery within 15 minutes and cross-region data loss no worse than… | `infra/terraform`, `docs/RUNBOOKS` | — | NO_TEST | — | BLOCKED (offline: NO_TEST; PRQ-039, PRQ-011) |
| SPEC-13.slo-definitions | Service objectives define measurement point, denominator, exclusions and window in code;… | `platform/src/observability/slo.ts` | 9: `platform/src/observability/slo.test.ts:20` (as SPEC-13.slo)<br>`platform/src/observability/slo.test.ts:53` (as SPEC-13.slo)<br>`platform/src/observability/slo.test.ts:70` (as SPEC-13.slo)<br>`platform/src/observability/slo.test.ts:79` (as SPEC-13.slo) (+5 more) | PASS (9/9) | `evidence/test-reports/vitest-platform.json` | IMPLEMENTED_OFFLINE |
| SPEC-13.dashboards | Dashboards cover arrivals, sessions, queues, transfers, identity, tools, dependencies, sa… | `platform/src/observability`, `infra/terraform` | 5: `platform/src/observability/metrics.test.ts:82`<br>`platform/src/observability/metrics.test.ts:154`<br>`platform/src/observability/metrics.test.ts:162`<br>`platform/src/observability/metrics.test.ts:169` (+1 more) | PASS (5/5) | `evidence/test-reports/vitest-platform.json` | BLOCKED (offline: IMPLEMENTED_OFFLINE; PRQ-011, PRQ-047) |
| SPEC-13.resolution-metrics | Verified resolution, repeat contact and reopened cases are measured; containment is separ… | `platform/src/observability`, `platform/src/evaluation/aggregate.ts` | — | NO_TEST | — | NO_TEST |
| SPEC-13.audit-model | Every meaningful event carries id, schema version, UTC time, correlation and parent ids,… | `platform/src/audit/schema.ts`, `platform/src/protocol/audit.ts` | 4: `platform/src/audit/schema.test.ts:31` (as SPEC-13.3)<br>`platform/src/audit/schema.test.ts:155` (as SPEC-13.3)<br>`platform/src/audit/schema.test.ts:190` (as SPEC-13.3)<br>`platform/src/audit/writer.test.ts:168` (as SPEC-13.3) | PASS (4/4) | `evidence/test-reports/vitest-platform.json` | IMPLEMENTED_OFFLINE |
| SPEC-13.audit-integrity | Audit events are append-only in an independently administered account with restricted del… | `platform/src/audit/chain.ts`, `platform/src/audit/verifier.ts`, `platform/src/audit/shipper.ts` | — | NO_TEST | — | BLOCKED (offline: NO_TEST; PRQ-037, PRQ-040) |
| SPEC-13.audit-access | Sensitive content is separated from security metadata; access to both is audited; audit-v… | `platform/src/audit/query.ts`, `platform/migrations` | 3: `platform/src/audit/query.test.ts:41` (as SPEC-13.5)<br>`platform/src/audit/query.test.ts:51` (as SPEC-13.5)<br>`platform/src/audit/query.test.ts:75` (as SPEC-13.5) | PASS (3/3) | `evidence/test-reports/vitest-platform.json` | IMPLEMENTED_OFFLINE |
| SPEC-13.audit-outage | A local durable outbox may buffer within a bounded policy; if durable evidence cannot be… | `platform/src/audit/health.ts`, `platform/src/gateway` | 2: `platform/src/gateway/pipeline.test.ts:237`<br>`platform/src/gateway/pipeline.test.ts:247` | PASS (2/2) | `evidence/test-reports/vitest-platform.json` | IMPLEMENTED_OFFLINE |
| SPEC-13.console | Authorized staff can inspect a journey, join or transfer via supported controls, review a… | `platform/src/console-api`, `console/` | 70: `console/src/api/client.test.ts:95`<br>`console/src/api/client.test.ts:125`<br>`console/src/api/contract.test.ts:51`<br>`console/src/api/contract.test.ts:80` (+66 more) | PASS (70/70) | `evidence/test-reports/vitest-console.json`, `evidence/test-reports/vitest-platform.json` | BLOCKED (offline: IMPLEMENTED_OFFLINE; PRQ-036) |
| SPEC-13.killswitch | Separate kill switches for new AI admissions, an intent, an integration, writes, a model/… | `platform/src/ops/kill-switches.ts` | 14: `platform/src/business/billing.test.ts:192` (as SPEC-13.kill-switches)<br>`platform/src/business/business-gaps.test.ts:69` (as SPEC-13.kill-switches)<br>`platform/src/business/tools.test.ts:349` (as SPEC-13.kill-switches)<br>`platform/src/console-api/rbac.test.ts:128` (as SPEC-13.kill-switch) (+10 more) | PASS (14/14) | `evidence/test-reports/vitest-platform.json` | IMPLEMENTED_OFFLINE |
| SPEC-13.incident-playbooks | Escalation roster and playbooks exist for PHI exposure, unsafe output, failed safety tran… | `docs/RUNBOOKS` | 3: `platform/test/docs/docs-pack.test.ts:183` (as SPEC-13.runbooks)<br>`platform/test/docs/docs-pack.test.ts:190` (as SPEC-13.runbooks)<br>`platform/test/docs/docs-pack.test.ts:206` (as SPEC-13.runbooks) | PASS (3/3) | `evidence/test-reports/vitest-platform.json` | BLOCKED (offline: IMPLEMENTED_OFFLINE; PRQ-011) |
| SPEC-14.threat-model | Threat model covers caller spoofing, SIM swap, enumeration, session fixation, replay, cro… | `docs/security`, `platform/src/identity`, `platform/src/gateway` | 45: `platform/src/adapters/local/identity-directory.test.ts:25` (as SPEC-14.ENUMERATION)<br>`platform/src/gateway/http/portal-routes.test.ts:122` (as SPEC-14.FIXATION)<br>`platform/src/identity/assertions/assertion-service.test.ts:105` (as SPEC-14.REPLAY)<br>`platform/src/identity/assertions/assertion-service.test.ts:114` (as SPEC-14.REPLAY) (+41 more) | PASS (45/45) | `evidence/test-reports/vitest-platform.json` | BLOCKED (offline: IMPLEMENTED_OFFLINE; PRQ-003) |
| SPEC-14.supply-chain | Least-privilege IAM, workload identity, TLS, KMS, dependency pinning, SBOM, signature ver… | `.github`, `scripts/ci`, `infra/terraform`, `platform/Dockerfile` | — | NO_TEST | — | BLOCKED (offline: NO_TEST; PRQ-041, PRQ-042) |
| SPEC-14.hostile-gateway-tests | The gateway is tested directly with hostile tool calls even if the conversational prompt… | `platform/src/gateway`, `scenarios/risk` | — | NO_TEST | — | NO_TEST |
| SPEC-14.pentest | Independent security review and penetration testing of backend and telephone journey; no… | `docs/security` | — | NO_TEST | — | BLOCKED (offline: NO_TEST; PRQ-051) |
| SPEC-14.test-layers | Deterministic unit and property tests, vendor contract tests, synthetic multi-turn dialog… | `platform/src/evaluation/runner.ts`, `platform/test` | — | NO_TEST | — | BLOCKED (offline: NO_TEST; PRQ-043) |
| SPEC-14.intent-corpus | At least 50 reviewed support intents across all audiences and eight variant families (bas… | `scenarios/skeletons`, `platform/src/evaluation/generate.ts` | 3: `platform/src/evaluation/corpus.test.ts:34`<br>`platform/src/evaluation/corpus.test.ts:50`<br>`platform/src/evaluation/generate.test.ts:44` | PASS (3/3) | `evidence/test-reports/vitest-platform.json` | BLOCKED (offline: IMPLEMENTED_OFFLINE; PRQ-012) |
| SPEC-14.risk-corpus | At least 500 human-reviewed privacy, authorization, clinical-boundary and safety-routing… | `scenarios/risk`, `platform/src/evaluation/generate-risk.ts` | 2: `platform/src/evaluation/corpus.test.ts:55`<br>`platform/src/evaluation/generate.test.ts:91` | PASS (2/2) | `evidence/test-reports/vitest-platform.json` | BLOCKED (offline: IMPLEMENTED_OFFLINE; PRQ-012, PRQ-008) |
| SPEC-14.repetitions | Selected nondeterministic cases are repeated at least five times per release. | `platform/src/evaluation/runner.ts`, `platform/src/evaluation/generate.ts` | 2: `platform/src/evaluation/corpus.test.ts:199`<br>`platform/src/evaluation/runner.test.ts:36` | PASS (2/2) | `evidence/test-reports/vitest-platform.json` | IMPLEMENTED_OFFLINE |
| SPEC-14.edge-populations | Tests include long pauses, speech impairment, accented speech, hearing/relay use, interpr… | `scenarios/skeletons`, `scenarios/risk` | 2: `platform/src/evaluation/corpus.test.ts:207`<br>`platform/src/evaluation/generate.test.ts:52` | PASS (2/2) | `evidence/test-reports/vitest-platform.json` | BLOCKED (offline: IMPLEMENTED_OFFLINE; PRQ-012) |
| SPEC-14.failure-injection | Vendor and business failures are tested: timeouts, stale knowledge, exhausted quotas, out… | `scenarios/fixtures/failures`, `platform/src/adapters/local`, `platform/src/evaluation/runner.ts` | 30: `platform/src/adapters/local/billing-fixture.test.ts:88` (as SPEC-14.faults)<br>`platform/src/adapters/local/faults.property.test.ts:8` (as SPEC-14.faults)<br>`platform/src/adapters/local/faults.property.test.ts:31` (as SPEC-14.faults)<br>`platform/src/adapters/local/faults.test.ts:25` (as SPEC-14.faults) (+26 more) | PASS (30/30) | `evidence/test-reports/vitest-platform.json` | IMPLEMENTED_OFFLINE |
| SPEC-14.policy-expansion | A policy update cannot silently expand access. | `policy/`, `platform/src/policy` | 21: `platform/src/policy/console.test.ts:42`<br>`platform/src/policy/golden-gate.test.ts:65`<br>`platform/src/policy/golden-gate.test.ts:76`<br>`platform/src/policy/golden-gate.test.ts:95` (+17 more) | PASS (21/21) | `evidence/test-reports/vitest-platform.json` | IMPLEMENTED_OFFLINE |
| SPEC-14.production-derived | Production-derived scenarios only after approved access, minimization and review; LLM jud… | `platform/src/evaluation/scorer.ts`, `platform/src/evaluation/runner.ts` | 1: `platform/src/evaluation/scorer.test.ts:83` | PASS (1/1) | `evidence/test-reports/vitest-platform.json` | BLOCKED (offline: IMPLEMENTED_OFFLINE; PRQ-003) |
| SPEC-14.hard-gates | Safety, authorization, consent, transaction correctness, allowed data egress and audit ev… | `platform/src/evaluation/scorer.ts` | 15: `platform/src/evaluation/aggregate.test.ts:65`<br>`platform/src/evaluation/scorer.test.ts:48`<br>`platform/src/evaluation/scorer.test.ts:92`<br>`platform/src/evaluation/scorer.test.ts:107` (+11 more) | PASS (15/15) | `evidence/test-reports/vitest-platform.json` | IMPLEMENTED_OFFLINE |
| SPEC-14.goal-completion | Proposed at least 95 percent validated goal completion per launch-eligible routine intent… | `platform/src/evaluation/aggregate.ts` | — | NO_TEST | — | BLOCKED (offline: NO_TEST; PRQ-012, PRQ-045) |
| SPEC-14.uncertainty | Zero failures in a finite set is not zero risk; report sample size, repetition, dependenc… | `platform/src/evaluation/stats.ts`, `platform/src/evaluation/aggregate.ts` | 3: `platform/src/evaluation/aggregate.test.ts:31`<br>`platform/src/evaluation/aggregate.test.ts:39`<br>`platform/src/evaluation/aggregate.test.ts:94` | PASS (3/3) | `evidence/test-reports/vitest-platform.json` | IMPLEMENTED_OFFLINE |
| SPEC-14.scorecard | One append-only result record per run with run, scenario, split, audience, language, chan… | `platform/src/evaluation/results.ts`, `platform/src/evaluation/scorer.ts` | 5: `platform/src/evaluation/runner.test.ts:80`<br>`platform/src/evaluation/runner.test.ts:100`<br>`platform/src/evaluation/runner.test.ts:106`<br>`platform/src/evaluation/runner.test.ts:117` (+1 more) | PASS (5/5) | `evidence/test-reports/vitest-platform.json` | IMPLEMENTED_OFFLINE |
| SPEC-14.aggregation | Aggregate by intent, language, audience, failure severity, version and regression; keep p… | `platform/src/evaluation/aggregate.ts` | 4: `platform/src/evaluation/aggregate.test.ts:53`<br>`platform/src/evaluation/aggregate.test.ts:65`<br>`platform/src/evaluation/aggregate.test.ts:79`<br>`platform/src/evaluation/aggregate.test.ts:105` | PASS (4/4) | `evidence/test-reports/vitest-platform.json` | BLOCKED (offline: IMPLEMENTED_OFFLINE; PRQ-046) |
| SPEC-14.traceability | Every requirement maps to enforcement location, test ids, evidence and release status. | `docs/requirements/catalog.yaml`, `platform/src/evaluation/traceability.ts` | 8: `platform/src/evaluation/corpus.test.ts:251`<br>`platform/src/evaluation/traceability.test.ts:111`<br>`platform/src/evaluation/traceability.test.ts:121`<br>`platform/src/evaluation/traceability.test.ts:165` (+4 more) | PASS (8/8) | `evidence/test-reports/vitest-platform.json` | IMPLEMENTED_OFFLINE |
| SPEC-15.offline-slice | One representative journey from unverified caller through secure mock authentication, aut… | `platform/src/demo`, `platform/src/main` | — | NO_TEST | — | NO_TEST |
| SPEC-15.pilot-promotion | Staged exposure (for example 1, 5, 10, 25, 50 percent) only with reviewed evidence and na… | `docs/release/phase-gates.md`, `platform/src/ops` | — | NO_TEST | — | BLOCKED (offline: NO_TEST; PRQ-024) |
| SPEC-15.rollback | Rehearsed rollback to a known-good orchestration, tool catalogue, policy and compatible s… | `platform/src/workflows`, `platform/src/evaluation/manifest.ts` | 6: `platform/src/workflows/definitions.test.ts:312` (as SPEC-15.phase5)<br>`platform/src/workflows/definitions.test.ts:332` (as SPEC-15.phase5)<br>`platform/src/workflows/engine.test.ts:268` (as SPEC-15.phase5)<br>`platform/src/workflows/engine.test.ts:338` (as SPEC-15.phase5) (+2 more) | PASS (6/6) | `evidence/test-reports/vitest-platform.json` | BLOCKED (offline: IMPLEMENTED_OFFLINE; PRQ-011) |
| SPEC-15.no-self-promotion | No autonomous self-promotion, unreviewed production learning or automatic retraining from… | `platform/src/memory`, `platform/src/evaluation/manifest.ts` | — | NO_TEST | — | NO_TEST |
| SPEC-16.offline-first | Begin offline with synthetic data; no spend, calls, real notifications, new credentials,… | `platform/src/config/guard.ts`, `platform/src/fixtures/synthetic-world.ts` | 1: `platform/src/evaluation/corpus.test.ts:233` | PASS (1/1) | `evidence/test-reports/vitest-platform.json` | IMPLEMENTED_OFFLINE |
| SPEC-16.integration-records | Every integration records method, endpoint, version, auth mechanism, schema, rate limit,… | `platform/src/adapters/integration-inventory.ts`, `docs/vendor-integration-inventory.md` | 3: `platform/src/adapters/integration-inventory.test.ts:22` (as SPEC-16.inventory)<br>`platform/src/adapters/integration-inventory.test.ts:59` (as SPEC-16.inventory)<br>`platform/src/adapters/integration-inventory.test.ts:96` (as SPEC-16.inventory) | PASS (3/3) | `evidence/test-reports/vitest-platform.json` | IMPLEMENTED_OFFLINE |
| SPEC-16.prod-guard | Production configuration rejects fixture adapters, missing credentials, unapproved models… | `platform/src/config/guard.ts`, `platform/src/config/schema.ts` | 5: `platform/src/config/loader.test.ts:14` (as SPEC-16.config)<br>`platform/src/config/loader.test.ts:58` (as SPEC-16.config)<br>`platform/src/config/loader.test.ts:96` (as SPEC-16.config)<br>`platform/src/config/loader.test.ts:104` (as SPEC-16.config) (+1 more) | PASS (5/5) | `evidence/test-reports/vitest-platform.json` | BLOCKED (offline: IMPLEMENTED_OFFLINE; PRQ-023) |
| SPEC-16.phi-endpoints-disabled | Production PHI endpoints remain disabled until prerequisites are evidenced. | `platform/src/config/guard.ts` | 1: `platform/src/config/guard.test.ts:364` (as SPEC-16.phi) | PASS (1/1) | `evidence/test-reports/vitest-platform.json` | BLOCKED (offline: IMPLEMENTED_OFFLINE; PRQ-002, PRQ-024) |
| SPEC-16.local-demo | Local start command, test commands, synthetic credentials only and a documented end-to-en… | `platform/src/demo`, `platform/src/main` | 1: `platform/src/adapters/registry.test.ts:51` (as SPEC-16.badge) | PASS (1/1) | `evidence/test-reports/vitest-platform.json` | IMPLEMENTED_OFFLINE |
| SPEC-16.protocol-artifacts | AuthContext, ToolRequest, ToolResult, PreparedAction, CommitReceipt, SupportRequest, Hand… | `platform/src/protocol`, `schemas/protocol` | — | NO_TEST | — | NO_TEST |
| SPEC-16.scenario-definition | ScenarioDefinition carries version, audience, locale, initial state, permitted records, s… | `platform/src/protocol/evaluation.ts`, `platform/src/evaluation/generate.ts`, `scenarios/fixtures/failures` | 8: `platform/src/evaluation/corpus.test.ts:24`<br>`platform/src/evaluation/corpus.test.ts:99`<br>`platform/src/evaluation/corpus.test.ts:115`<br>`platform/src/evaluation/corpus.test.ts:214` (+4 more) | PASS (8/8) | `evidence/test-reports/vitest-platform.json` | IMPLEMENTED_OFFLINE |
| SPEC-16.release-manifest | ReleaseManifest binds source commit, build/image digest, infrastructure plan, schema vers… | `platform/src/evaluation/manifest.ts`, `platform/src/config/approvals.ts` | 3: `platform/src/evaluation/manifest.test.ts:38`<br>`platform/src/evaluation/manifest.test.ts:69`<br>`platform/src/evaluation/manifest.test.ts:118` | PASS (3/3) | `evidence/test-reports/vitest-platform.json` | BLOCKED (offline: IMPLEMENTED_OFFLINE; PRQ-023, PRQ-024) |
| SPEC-16.journeys | Demonstrate the nine journeys (verified reschedule with conflict, disputed charge to dura… | `scenarios/journeys`, `platform/src/demo` | 17: `platform/src/adapters/local/billing-fixture.test.ts:101` (as SPEC-16.journey)<br>`platform/src/adapters/local/scheduling-fixture.test.ts:56` (as SPEC-16.journey)<br>`platform/src/adapters/local/scheduling-fixture.test.ts:66` (as SPEC-16.journey)<br>`platform/src/adapters/local/scheduling-fixture.test.ts:77` (as SPEC-16.journey) (+13 more) | PASS (17/17) | `evidence/test-reports/vitest-platform.json` | BLOCKED (offline: IMPLEMENTED_OFFLINE; PRQ-043) |
| SPEC-16.fault-injection | Inject authentication expiry, two concurrent calls for one account, an interrupted confir… | `scenarios/fixtures/failures`, `scenarios/journeys/faulted`, `platform/src/evaluation/scorer.ts` | 4: `platform/src/evaluation/corpus.test.ts:148`<br>`platform/src/evaluation/corpus.test.ts:307`<br>`platform/src/evaluation/runner.test.ts:46`<br>`platform/src/evaluation/scorer.test.ts:229` | PASS (4/4) | `evidence/test-reports/vitest-platform.json` | IMPLEMENTED_OFFLINE |
| SPEC-16.console-functional | The operations console is functional, access-controlled and accessible, audits administra… | `console/`, `platform/src/console-api` | 32: `console/src/api/client.test.ts:28` (as SPEC-16.console-token)<br>`console/src/api/client.test.ts:42` (as SPEC-16.console-token)<br>`console/src/api/client.test.ts:58` (as SPEC-16.console-errors)<br>`console/src/api/client.test.ts:68` (as SPEC-16.console-errors) (+28 more) | PASS (32/32) | `evidence/test-reports/vitest-console.json`, `evidence/test-reports/vitest-platform.json` | BLOCKED (offline: IMPLEMENTED_OFFLINE; PRQ-036) |
| SPEC-16.decisions | Material decisions are recorded (architecture decision records). | `docs/DECISIONS.md`, `docs/adr` | 3: `platform/test/docs/docs-pack.test.ts:132`<br>`platform/test/docs/docs-pack.test.ts:138`<br>`platform/test/docs/docs-pack.test.ts:150` | PASS (3/3) | `evidence/test-reports/vitest-platform.json` | IMPLEMENTED_OFFLINE |
| SPEC-16.progress-handoff | IMPLEMENTATION_STATUS, PREREQUISITES, DECISIONS, REQUIREMENTS_TRACEABILITY, TEST_EVIDENCE… | `docs` | 5: `platform/test/docs/docs-pack.test.ts:48` (as SPEC-16.handoff)<br>`platform/test/docs/docs-pack.test.ts:69` (as SPEC-16.handoff)<br>`platform/test/docs/docs-pack.test.ts:91` (as SPEC-16.handoff)<br>`platform/test/docs/prerequisites.test.ts:154` (as SPEC-16.handoff) (+1 more) | PASS (5/5) | `evidence/test-reports/vitest-platform.json` | IMPLEMENTED_OFFLINE |
| SPEC-16.status-vocabulary | Distinguish IMPLEMENTED_OFFLINE, VERIFIED_SANDBOX, APPROVED_PILOT and VERIFIED_PRODUCTION… | `platform/src/protocol/release.ts`, `platform/src/evaluation/manifest.ts`, `platform/src/evaluation/traceability.ts` | — | NO_TEST | — | NO_TEST |

## Gaps (no tagged test)

- SPEC-2.auth-gate-values
- SPEC-2.version-proof
- SPEC-2.model-evidence
- SPEC-3.independent-human-route
- SPEC-3.vendor-capability-gate
- SPEC-3.ingress
- SPEC-4.outcomes
- SPEC-4.resolution-contracts
- SPEC-4.payments-isolated
- SPEC-4.prohibited-assertions
- SPEC-6.case-minimization
- SPEC-7.assurance-tiers
- SPEC-8.webhook-auth
- SPEC-8.service-identities
- SPEC-8.commit-recheck
- SPEC-9.memory
- SPEC-10.no-clinical-advice
- SPEC-10.no-auto-external-crisis
- SPEC-10.transfer-failure
- SPEC-11.voice-selection
- SPEC-11.endpointing
- SPEC-12.db-outage
- SPEC-12.recovery
- SPEC-13.resolution-metrics
- SPEC-13.audit-integrity
- SPEC-14.supply-chain
- SPEC-14.hostile-gateway-tests
- SPEC-14.pentest
- SPEC-14.test-layers
- SPEC-14.goal-completion
- SPEC-15.offline-slice
- SPEC-15.pilot-promotion
- SPEC-15.no-self-promotion
- SPEC-16.protocol-artifacts
- SPEC-16.status-vocabulary

## Unknown tags (used in tests, not in the catalogue)

- `ACT-F1` — 9 test(s), e.g. `platform/src/actions/action-service.invalidation.test.ts:74`
- `ACT-F2` — 9 test(s), e.g. `platform/src/business/transactions.test.ts:198`
- `ACT-F3` — 13 test(s), e.g. `platform/src/actions/action-service.invalidation.test.ts:130`
- `ACT-F4` — 5 test(s), e.g. `platform/src/business/transactions.test.ts:115`
- `ACT-F5` — 6 test(s), e.g. `platform/src/business/transactions.test.ts:68`
- `AUTH-ENUM-01` — 13 test(s), e.g. `platform/src/identity/abuse-monitor.test.ts:13`
- `AUTH-OTP-LIMIT-01` — 7 test(s), e.g. `platform/src/identity/enumeration-resistance.integration.test.ts:83`
- `DP-01` — 4 test(s), e.g. `platform/src/business/handoff.test.ts:208`
- `DP-02` — 6 test(s), e.g. `platform/src/actions/tool-idempotency.test.ts:151`
- `DP-03` — 5 test(s), e.g. `platform/src/business/transactions.test.ts:214`
- `OPS-APPR-01` — 8 test(s), e.g. `platform/src/config/approvals.test.ts:127`
- `OPS-AUD-01` — 10 test(s), e.g. `platform/src/audit/monitor.test.ts:59`
- `OPS-AUD-02` — 4 test(s), e.g. `platform/src/audit/sinks/s3-iam-model.test.ts:103`
- `OPS-KS-01` — 6 test(s), e.g. `platform/src/ops/notification-gate.test.ts:36`
- `OPS-KS-02` — 4 test(s), e.g. `platform/src/ops/integration-gate.test.ts:37`
- `SAFE-HANDOFF-01` — 6 test(s), e.g. `platform/src/business/handoff.test.ts:327`
- `SAFE-HANDOFF-02` — 14 test(s), e.g. `platform/src/business/handoff.test.ts:238`
- `SAFE-HANDOFF-03` — 3 test(s), e.g. `platform/src/gateway/http/routes.test.ts:417`
- `SAFE-HANDOFF-05` — 4 test(s), e.g. `platform/src/business/handoff.test.ts:297`
- `SAFE-HANDOFF-07` — 2 test(s), e.g. `platform/src/business/handoff.test.ts:275`
- `SPEC-10.context` — 1 test(s), e.g. `platform/src/gateway/http/routes.test.ts:318`
- `SPEC-10.fail-safe` — 3 test(s), e.g. `platform/src/safety/fail-safe.test.ts:45`
- `SPEC-10.handoff` — 1 test(s), e.g. `platform/src/safety/fail-safe.test.ts:107`
- `SPEC-10.indirect` — 1 test(s), e.g. `platform/src/safety/detector.test.ts:168`
- `SPEC-10.safety` — 1 test(s), e.g. `platform/test/journeys/j6-safety-handoff.test.ts:107`
- `SPEC-10.stop-admin-work` — 4 test(s), e.g. `platform/src/business/handoff.test.ts:152`
- `SPEC-12.circuit-breaker` — 1 test(s), e.g. `platform/src/gateway/pipeline.test.ts:402`
- `SPEC-12.rate-limit` — 5 test(s), e.g. `platform/src/gateway/http/routes.test.ts:447`
- `SPEC-12.retry` — 1 test(s), e.g. `platform/src/gateway/pipeline.test.ts:394`
- `SPEC-12.write-fence` — 2 test(s), e.g. `platform/src/main/container.test.ts:120`
- `SPEC-13.audit` — 4 test(s), e.g. `platform/src/audit/monitor.test.ts:59`
- `SPEC-13.audit-event` — 1 test(s), e.g. `platform/src/gateway/http/portal-routes.test.ts:74`
- `SPEC-13.bounded-buffer` — 3 test(s), e.g. `platform/src/audit/deferred.test.ts:51`
- `SPEC-13.kill` — 10 test(s), e.g. `platform/src/ops/integration-gate.test.ts:37`
- `SPEC-13.metrics` — 13 test(s), e.g. `platform/src/business/handoff.test.ts:275`
- `SPEC-13.readiness` — 1 test(s), e.g. `platform/src/gateway/http/routes.test.ts:118`
- `SPEC-14.cross-tenant` — 1 test(s), e.g. `platform/src/gateway/pipeline.test.ts:155`
- `SPEC-14.dos` — 2 test(s), e.g. `platform/src/gateway/mcp.test.ts:180`
- `SPEC-14.hostile` — 3 test(s), e.g. `platform/src/gateway/pipeline.test.ts:88`
- `SPEC-14.http-security` — 2 test(s), e.g. `platform/src/gateway/http/routes.test.ts:63`
- `SPEC-14.policy-failure` — 1 test(s), e.g. `platform/src/gateway/pipeline.test.ts:223`
- `SPEC-14.session-fixation` — 1 test(s), e.g. `platform/src/gateway/pipeline.test.ts:168`
- `SPEC-15.dr-fence` — 1 test(s), e.g. `platform/src/gateway/pipeline.test.ts:329`
- `SPEC-15.integration-identity` — 1 test(s), e.g. `platform/src/gateway/pipeline.test.ts:443`
- `SPEC-15.phase-1` — 1 test(s), e.g. `platform/test/journeys/j1-reschedule.test.ts:29`
- `SPEC-15.worker` — 7 test(s), e.g. `platform/src/worker/worker.test.ts:66`
- `SPEC-16.billing-dispute` — 1 test(s), e.g. `platform/src/business/billing.test.ts:91`
- `SPEC-16.fault-audit-outage` — 2 test(s), e.g. `platform/src/worker/deferred-audit.test.ts:40`
- `SPEC-16.fault-auth-expiry` — 1 test(s), e.g. `platform/test/journeys/faults.test.ts:52`
- `SPEC-16.fault-concurrent-calls` — 1 test(s), e.g. `platform/test/journeys/faults.test.ts:81`
- `SPEC-16.fault-crash-after-commit` — 1 test(s), e.g. `platform/test/journeys/faults.test.ts:185`
- `SPEC-16.fault-duplicate-webhooks` — 1 test(s), e.g. `platform/test/journeys/faults.test.ts:143`
- `SPEC-16.fault-failed-transfer` — 1 test(s), e.g. `platform/test/journeys/faults.test.ts:294`
- `SPEC-16.fault-interrupted-confirmation` — 1 test(s), e.g. `platform/test/journeys/faults.test.ts:117`
- `SPEC-16.fault-salesforce-outage` — 2 test(s), e.g. `platform/test/journeys/faults.test.ts:235`
- `SPEC-16.faults` — 1 test(s), e.g. `platform/test/journeys/faults.test.ts:51`
- `SPEC-16.interpreter` — 1 test(s), e.g. `platform/src/business/handoff.test.ts:61`
- `SPEC-16.journey-1` — 4 test(s), e.g. `platform/test/journeys/j1-reschedule.test.ts:28`
- `SPEC-16.journey-2` — 3 test(s), e.g. `platform/test/journeys/j2-billing-dispute.test.ts:80`
- `SPEC-16.journey-3` — 4 test(s), e.g. `platform/test/journeys/j3-j4-authorization.test.ts:23`
- `SPEC-16.journey-4` — 2 test(s), e.g. `platform/test/journeys/j3-j4-authorization.test.ts:82`
- `SPEC-16.journey-5` — 4 test(s), e.g. `platform/test/journeys/j5-j7-j8-routing.test.ts:35`
- `SPEC-16.journey-6` — 3 test(s), e.g. `platform/test/journeys/j6-safety-handoff.test.ts:30`
- `SPEC-16.journey-7` — 2 test(s), e.g. `platform/test/journeys/j5-j7-j8-routing.test.ts:128`
- `SPEC-16.journey-8` — 2 test(s), e.g. `platform/test/journeys/j5-j7-j8-routing.test.ts:166`
- `SPEC-16.journey-9` — 2 test(s), e.g. `platform/test/journeys/j9-repeat-caller.test.ts:25`
- `SPEC-16.local-badge` — 2 test(s), e.g. `platform/src/main/container.test.ts:126`
- `SPEC-16.reschedule` — 4 test(s), e.g. `platform/src/business/appointments.test.ts:37`
- `SPEC-4.appointment-create` — 1 test(s), e.g. `platform/src/business/appointments.test.ts:211`
- `SPEC-4.claim-status` — 1 test(s), e.g. `platform/src/business/billing.test.ts:215`
- `SPEC-4.complaint` — 2 test(s), e.g. `platform/src/business/business-gaps.test.ts:54`
- `SPEC-4.invoice` — 3 test(s), e.g. `platform/src/business/billing.test.ts:36`
- `SPEC-4.login` — 1 test(s), e.g. `platform/src/business/tools.test.ts:250`
- `SPEC-4.partner-intake` — 1 test(s), e.g. `platform/src/business/access.test.ts:111`
- `SPEC-4.payment-page` — 1 test(s), e.g. `platform/src/business/billing.test.ts:46`
- `SPEC-7.durable-grant` — 20 test(s), e.g. `platform/src/business/wiring.test.ts:31`
- `SPEC-7.field-minimization` — 1 test(s), e.g. `platform/src/gateway/mask.test.ts:33`
- `SPEC-7.no-enumeration` — 4 test(s), e.g. `platform/src/business/tools.test.ts:261`
- `SPEC-7.secure-link` — 1 test(s), e.g. `platform/src/gateway/http/routes.test.ts:353`
- `SPEC-7.session` — 1 test(s), e.g. `platform/src/gateway/http/routes.test.ts:131`
- `SPEC-7.transaction-matching` — 2 test(s), e.g. `platform/src/voice/gate.test.ts:89`
- `SPEC-8.case-status` — 3 test(s), e.g. `platform/src/business/cases.test.ts:68`
- `SPEC-8.concurrency` — 1 test(s), e.g. `platform/test/journeys/faults.test.ts:81`
- `SPEC-8.idempotency` — 1 test(s), e.g. `platform/src/gateway/pipeline.test.ts:345`
- `SPEC-8.mcp` — 2 test(s), e.g. `platform/src/gateway/mcp.test.ts:50`
- `SPEC-8.oauth2` — 7 test(s), e.g. `platform/src/gateway/auth.test.ts:90`
- `SPEC-8.openapi` — 2 test(s), e.g. `platform/src/gateway/openapi.test.ts:37`
- `SPEC-8.output-schema` — 1 test(s), e.g. `platform/src/gateway/pipeline.test.ts:213`
- `SPEC-8.restricted` — 3 test(s), e.g. `platform/src/business/handoff.test.ts:208`
- `SPEC-8.salesforce` — 11 test(s), e.g. `console/src/pages/SupportTracePage.test.tsx:42`
- `SPEC-8.service-identity` — 4 test(s), e.g. `platform/src/gateway/auth.test.ts:28`
- `SPEC-8.timeout` — 1 test(s), e.g. `platform/src/gateway/pipeline.test.ts:412`
- `SPEC-8.tool-pipeline` — 6 test(s), e.g. `platform/src/gateway/http/routes.test.ts:96`
- `SPEC-8.webhook` — 1 test(s), e.g. `platform/src/gateway/http/routes.test.ts:372`
- `SPEC-9.knowledge` — 1 test(s), e.g. `platform/src/knowledge/ingest.test.ts:69`
- `SPEC-9.knowledge-sanitize` — 1 test(s), e.g. `platform/src/knowledge/sanitize.invisible.test.ts:34`
- `SPEC-9.recap` — 1 test(s), e.g. `platform/src/business/cases.test.ts:30`
- `TB-01` — 2 test(s), e.g. `platform/src/gateway/pipeline.test.ts:451`
- `TB-07` — 1 test(s), e.g. `platform/src/worker/worker.test.ts:316`
- `TB-09` — 2 test(s), e.g. `platform/src/gateway/http/routes.test.ts:372`
- `VSP-GW-01` — 4 test(s), e.g. `platform/src/gateway/http/routes.test.ts:417`
- `VSP-GW-03` — 3 test(s), e.g. `platform/src/gateway/mcp.test.ts:180`
- `VSP-GW-04` — 7 test(s), e.g. `platform/src/gateway/pipeline.transactions.test.ts:184`
- `VSP-KN-01` — 20 test(s), e.g. `platform/src/knowledge/host-literals.test.ts:28`
- `VSP-KN-02` — 14 test(s), e.g. `platform/src/knowledge/host-literals.test.ts:112`

## Failing tests

None recorded.

## Externally blocked requirements

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
| SPEC-16.console-functional | Workforce SSO | PRQ-036 |
