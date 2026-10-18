# Vendor integration inventory

For every integration, spec section 16 requires: method, endpoint, version, auth mechanism,
schema, rate limit, retention, data class and source. Public documentation is evidence of a
**possible** capability; tenant tests are evidence of **actual** availability. Values not
established by a cited public source or by a tenant test stay **UNKNOWN**. Unsupported
capabilities are **BLOCKED**, never simulated as production success. No endpoint, signature
protocol, rate limit or retention value has been invented here.

**Machine-readable source.** The adapters module maintains the code inventory
`platform/src/adapters/integration-inventory.ts` (being written concurrently with this document).
That file is authoritative for adapter wiring; this page is the human summary. If they
disagree, correct this page.

Source ids `S1`..`S24` refer to the source register in spec section 17
(`docs/spec/voice-support-specification.txt`). Public sources were checked by the specification
author on 2026-10-17 and do not prove tenant capability; re-validate before enabling anything.

## Status vocabulary

| Status | Meaning |
|---|---|
| `IMPLEMENTED_OFFLINE` | Port and labelled local fixture exist and are tested; no live call made |
| `IN_PROGRESS` | Port exists; fixture or live adapter under implementation |
| `BLOCKED` | Needs a prerequisite (PRQ id) before any live use |
| `UNKNOWN` | Capability itself not established |
| `NOT_INTEGRATED` | Candidate only; no adapter planned without a separate approval |

## Talkdesk

| ID | Integration | Direction | Method | Endpoint | Version | Auth mechanism | Schema | Rate limit | Retention | Data class | Source | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| INT-01 | AI Agent Platform → gateway MCP tools | Inbound to us | MCP over Streamable HTTP ([S3]) | Our gateway `/mcp` (host UNKNOWN until sandbox apply) | MCP revision supported by Talkdesk UNKNOWN; our server SDK `@modelcontextprotocol/sdk` 1.32.1 | Bearer token or OAuth2 per [S3]; supported grants UNKNOWN (VQ-TD-24); preferred OAuth2 client credentials, static token only by exception (PRQ-052) | Our pinned tool catalogue (strict JSON Schema, digest in ReleaseManifest); Talkdesk does not version external tool definitions ([S3]) | UNKNOWN (VQ-TD-10, VQ-TD-26) | Talkdesk-side tool-call logs UNKNOWN (VQ-TD-05) | PHI (field-masked), INTERNAL | S3 | IN_PROGRESS offline (gateway); live BLOCKED (PRQ-034, PRQ-013) |
| INT-02 | Studio HTTP steps → telephony-control API (start call, consent, auth gate, confirmation, DTMF OTP submit) | Inbound to us | HTTPS JSON from Studio steps | Our gateway telephony-control routes (host UNKNOWN) | Our API version; Studio step behaviour UNKNOWN | UNKNOWN (VQ-TD-22) | Our strict request/response schemas | UNKNOWN | Studio execution logs and variable history UNKNOWN (VQ-TD-48) | PHI by association; VERIFICATION_SECRET only via isolated DTMF (TB-03) | — | IN_PROGRESS offline; live BLOCKED (PRQ-014, PRQ-015) |
| INT-03 | Authentication Gate variable | Vendor-internal | Studio / AI Agent Platform variable set by a deterministic Skill from our `authGate` response ([S2]) | Not an API | UNKNOWN | Not applicable (variable) | Strict boolean; condition semantics "defined" per [S2] (VQ-TD-21) | — | UNKNOWN | INTERNAL | S1, S2 | UNKNOWN (TB-06, PRQ-018) |
| INT-04 | Transfer to allowlisted queues and receiver context | Outbound from Studio / us | UNKNOWN: Studio exit, Studio step or vendor API (no public mechanism established for our plan) | UNKNOWN | UNKNOWN | UNKNOWN | Our `HandoffPackage`; vendor context fields UNKNOWN (VQ-TD-39) | UNKNOWN | UNKNOWN | PHI (minimised handoff package) | — | BLOCKED (TB-07, PRQ-019) |
| INT-05 | Interaction, transfer and AI events / webhooks | Inbound to us | UNKNOWN (VQ-TD-33) | UNKNOWN | UNKNOWN | UNKNOWN (VQ-TD-34); no invented signature protocol | UNKNOWN | UNKNOWN | UNKNOWN | PHI by association | — | BLOCKED; ingestion disabled (TB-09, PRQ-021) |
| INT-06 | Explore API historical reports | Outbound pull | HTTPS report generation and retrieval ([S24]) | Per [S24] documentation; base URL and report ids to be recorded when verified for our plan | UNKNOWN | Per [S24] documentation; not yet verified for our plan | Report-specific fields; inspect each report ([S24]) | Report limits and pagination UNKNOWN (VQ-TD-36) | Export copies are ours to govern (RM-02/RM-04) | PHI possible; de-identified exports only after approval | S24 | BLOCKED (PRQ-046) |
| INT-07 | Simulator and Batch Agent Evaluation | Operator-driven | Operator runbook or supported imports; no public automation API established ([S1], [S4], [S6]) | Not applicable | Batch Agent Evaluation is Preview ([S6]) | Operator SSO | Scenario import format UNKNOWN (VQ-TD-32) | UNKNOWN | Simulator and evaluation data retention UNKNOWN (VQ-TD-05) | Synthetic only | S1, S4, S6 | BLOCKED (PRQ-034); see `talkdesk/simulator-and-evaluation-runbook.md` |
| INT-08 | Configuration export for drift detection | Outbound pull or manual | UNKNOWN (VQ-TD-37) | UNKNOWN | UNKNOWN | UNKNOWN | Compared with `talkdesk/expected-config.yaml` | UNKNOWN | — | INTERNAL | — | UNKNOWN |
| INT-09 | Guardrail customisation | Vendor configuration | Vendor UI | Not applicable | UNKNOWN | Operator SSO | Custom guardrail field documented as 300 characters; trigger limit can close a conversation ([S5]) | — | — | INTERNAL | S5 | UNKNOWN (TB-05, PRQ-017) |

## Salesforce Service Cloud

| ID | Integration | Direction | Method | Endpoint | Version | Auth mechanism | Schema | Rate limit | Retention | Data class | Source | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| INT-10 | Interaction and Case upsert by external ID; Case status lookup | Outbound | REST upsert by external ID ([S23]) | Org instance URL UNKNOWN; resource paths recorded when verified in sandbox | Org API version UNKNOWN | Dedicated integration identity; supported server-to-server OAuth flow UNKNOWN (VQ-SF-03) | `CaseFields` (`platform/src/adapters/ports.ts`); org Case schema and external ID fields UNKNOWN (VQ-SF-04, VQ-SF-05) | Org API allocation UNKNOWN (VQ-SF-07) | Per org policy; TO BE SET BY PRIVACY COUNSEL (RM-02) | PHI (minimised summary, opaque subject reference) | S11, S23 | IN_PROGRESS offline (fixture); live BLOCKED (PRQ-006, PRQ-035) |
| INT-11 | Salesforce Knowledge export for the controlled knowledge pipeline | Outbound pull | UNKNOWN (VQ-SF-09) | UNKNOWN | UNKNOWN | Integration identity | Knowledge item fields UNKNOWN | UNKNOWN | — | INTERNAL / PUBLIC (approved corpus only) | — | BLOCKED (PRQ-032) |

## Identity

| ID | Integration | Direction | Method | Endpoint | Version | Auth mechanism | Schema | Rate limit | Retention | Data class | Source | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| INT-12 | Client IdP (portal secure-link approval, step-up) | Outbound (token verification) and browser redirect | OIDC (ID token verification with JWKS, nonce, max auth age) | Issuer, discovery and JWKS URLs UNKNOWN (VQ-IDP-01) | UNKNOWN | Authorization code with PKCE for the portal; signature verification with `jose` 6.2.12 | `OidcClaims` (`platform/src/adapters/ports.ts`); `amr`/`acr` values UNKNOWN (VQ-IDP-06) | UNKNOWN | IdP-managed | Identity claims | S7, S8 (design references) | IN_PROGRESS (live verifier code present, local fixture issuer `*.local.invalid`); live BLOCKED (PRQ-036) |
| INT-13 | Provider IdP | As INT-12 | OIDC | UNKNOWN | UNKNOWN | As INT-12 | As INT-12 | UNKNOWN | IdP-managed | Identity claims | — | BLOCKED (PRQ-036) |
| INT-14 | Workforce SSO for the console | Browser redirect | OIDC | UNKNOWN | UNKNOWN | Authorization code with PKCE; MFA required | Role groups UNKNOWN (VQ-IDP-08) | UNKNOWN | IdP-managed | Staff identity | — | BLOCKED (PRQ-036) |
| INT-15 | Authorization server for service identities (MCP and Studio clients) | Token issuance to Talkdesk; JWKS to us | OAuth2 client credentials (preferred) | UNKNOWN (VQ-IDP-07) | UNKNOWN | Client credentials; gateway validates access tokens against issuer JWKS and holds no client secret | Audience and scopes UNKNOWN | UNKNOWN | — | INTERNAL | — | BLOCKED (PRQ-036) |
| INT-16 | Identity directory and relationship registries (enrollment, delegation, partner contract, legal authority) | Outbound | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | `IdentityDirectory`, `RelationshipDirectory` ports | UNKNOWN | Owner-managed | PHI (restricted verification service) | — | IN_PROGRESS offline (local fixture); live BLOCKED (PRQ-005) |

## Business systems and notifications

| ID | Integration | Direction | Method | Endpoint | Version | Auth mechanism | Schema | Rate limit | Retention | Data class | Source | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| INT-17 | Scheduling system | Outbound | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | `SchedulingSystem` port; idempotency and lookup-by-key UNKNOWN | UNKNOWN | Owner-managed | PHI | — | BLOCKED (PRQ-007) |
| INT-18 | Billing system and hosted payment page | Outbound | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | `BillingSystem` port | UNKNOWN | Owner-managed | PHI, FINANCIAL (no card data) | — | BLOCKED (PRQ-007, PRQ-050) |
| INT-19 | Claims system | Outbound | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | `ClaimsSystem` port (insurer-reported status only) | UNKNOWN | Owner-managed | PHI | — | BLOCKED (PRQ-007) |
| INT-20 | Provider network system (onboarding, remittance) | Outbound | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | `ProviderSystem` port | UNKNOWN | Owner-managed | INTERNAL, FINANCIAL | — | BLOCKED (PRQ-007) |
| INT-21 | Notification provider (SMS, voice, email) | Outbound | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | `NotificationSender` port (neutral approved templates, idempotency key) | UNKNOWN | Vendor-managed (UNKNOWN) | PHI by association | — | IN_PROGRESS offline (local fixture); live BLOCKED (PRQ-048) |

## AWS and observability

| ID | Integration | Direction | Method | Endpoint | Version | Auth mechanism | Schema | Rate limit | Retention | Data class | Source | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| INT-22 | DynamoDB, S3, SQS, Step Functions, KMS, Secrets Manager | Outbound | AWS SDK for JavaScript v3 | Regional service endpoints (region UNKNOWN, VQ-AWS-06) | `@aws-sdk/*` 3.1152.0 | IAM task role (workload identity); no static keys | AWS service APIs | Service quotas UNKNOWN (VQ-AWS-04) | Per retention matrix | PHI / SECURITY_AUDIT per store | S10, S20 | Plans only; BLOCKED (PRQ-037, PRQ-038) |
| INT-23 | Aurora PostgreSQL | Outbound | PostgreSQL wire protocol over TLS | Cluster endpoint UNKNOWN | `pg` 8.23.1; engine version UNKNOWN | Secret reference or IAM authentication (UNKNOWN which) | `platform/migrations` | Connection limits UNKNOWN | Per retention matrix | PHI | S10 | Offline via PGlite; BLOCKED (PRQ-037) |
| INT-24 | CloudWatch via OpenTelemetry | Outbound | OTel metrics (content-free catalogue) | UNKNOWN (collector/exporter not configured) | `@opentelemetry/api` 1.9.1 | IAM | `platform/src/observability/metrics.ts` catalogue | UNKNOWN | TO BE SET (RM-04) | INTERNAL (no PHI) | — | BLOCKED (PRQ-047) |
| INT-25 | Datadog | Outbound | Only if approved | UNKNOWN | UNKNOWN | UNKNOWN | Content-free metrics only | UNKNOWN | UNKNOWN | INTERNAL | — | NOT_INTEGRATED (PRQ-047) |
| INT-26 | CI OIDC federation into AWS deploy roles | CI to AWS | OIDC web identity | UNKNOWN | UNKNOWN | OIDC, no stored keys | `infra/terraform/modules/iam_ci` | — | — | No PHI | — | BLOCKED (PRQ-037, PRQ-041) |

## Candidate vendors (not integrated)

| ID | Candidate | Why listed | Constraint from source | Status |
|---|---|---|---|---|
| INT-27 | Amazon Nova 2.5 Sonic | Possible speech model for a fallback runtime | Announcement and model overview disagree on context limit (256K vs up to 1M); exact model, region, quota and endpoint evidence required ([S15], [S16], VQ-AWS-07) | NOT_INTEGRATED |
| INT-28 | ElevenLabs | Optional future voice-quality candidate | BAA and Zero Retention Mode required for eligible PHI handling; MCP unavailable for HIPAA / ZRM users; cloning not ZRM-eligible ([S13], [S14]) | NOT_INTEGRATED |
| INT-29 | Microsoft / Azure AI endpoints | Only if proposed | Standard BAA framework does not prove coverage for every endpoint, preview feature or deployment mode ([S12], VQ-SPV-08) | NOT_INTEGRATED |
| INT-30 | Self-hosted LiveKit media layer on AWS | Fallback runtime if TB-04/TB-05 fail | Separately approved project ([ADR-0006](adr/ADR-0006-fallback-speech-runtime.md)); SIP/media interface UNKNOWN (VQ-TD-42) | NOT_INTEGRATED |
