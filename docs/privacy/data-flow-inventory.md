# Data-flow inventory

Engineering draft for review by security and privacy (prerequisite PRQ-003). It maps every PHI
processor, storage location, support-access path, backup, telemetry sink and deletion path in
the designed system (spec section 6). It is not a risk analysis, a BAA review or a compliance
determination; those belong to privacy counsel and security leadership. No production or vendor
account was inspected. Regions, subprocessors and vendor retention are UNKNOWN until written
answers exist.

## Principles applied

* **Raw audio remains sensitive even if the transcript is later redacted (DATA-02).** Original
  audio and pre-redaction transcripts are PHI wherever they are received. Redacting a transcript
  after recognition does not mean the speech processor never received PHI.
* Redaction is probabilistic and does not establish formal de-identification. A redaction
  failure quarantines the artefact from broad access; it never justifies sending raw content to
  a debugging vendor.
* A caller may volunteer clinical details at any time, so every ingress and every processor on
  the call path is treated as receiving PHI, even for administrative intents.
* Default away from psychotherapy notes, therapy-session transcripts, medication histories,
  diagnoses and clinical scoring. The therapy corpus is not used for support fine-tuning,
  retrieval, testing or personalisation.
* Minimise downstream copies: Salesforce receives a concise approved summary and a
  permission-checked evidence reference, not full transcripts. No public or long-lived
  recording links.
* No PHI in URLs, metric labels, alert text, resource names, trace baggage, error messages,
  workflow names or support tickets (`docs/ARCHITECTURE.md` convention 2).
* Zero retention is verified per feature and endpoint, including exceptions; it is never
  assumed (PRQ-002).
* An AWS BAA does not make Talkdesk, Salesforce, a voice vendor or an observability service
  covered (spec section 2).

## Data classes

Retention classes follow `DataClass` in `platform/src/protocol/common.ts`; durations are set by
privacy counsel ([`retention-matrix.md`](retention-matrix.md)). Payload classifications follow
`Classification` (`PUBLIC`, `INTERNAL`, `PHI`, `PHI_RESTRICTED`, `FINANCIAL`, `VERIFICATION_SECRET`).

| Retention class | Content | Typical classification |
|---|---|---|
| `TRANSIENT_CONVERSATION` (RM-01) | Live audio, ASR hypotheses, model context, tool arguments and results in flight, session state | PHI, VERIFICATION_SECRET (portal/DTMF only), FINANCIAL |
| `BUSINESS_RECORD` (RM-02) | Action ledger, support requests, Cases, workflow state, verified support memory, receipts | PHI, PHI_RESTRICTED, FINANCIAL |
| `RESTRICTED_QA_MEDIA` (RM-03) | Recordings and transcripts retained for approved QA or evaluation | PHI, PHI_RESTRICTED |
| `SECURITY_AUDIT` (RM-04) | Audit events (metadata), manifests, access reviews, approvals, deletion and drill records | INTERNAL (opaque references only) |

## Diagram

```mermaid
flowchart LR
  caller([PSTN caller]) -->|audio| td_tel[DF-02 Talkdesk telephony and Studio]
  td_tel -->|audio| td_asr[DF-03 Talkdesk ASR]
  td_asr -->|transcript| td_ai[DF-04 Talkdesk AI Agent Platform model]
  td_ai -->|text| td_tts[DF-05 Talkdesk TTS] -->|audio| caller
  td_tel -.->|recordings, transcripts, AI logs, exports| td_store[(DF-06 Talkdesk storage and exports)]
  td_ai -->|MCP tool calls, service identity| gw[DF-07 Gateway on ECS Fargate]
  td_tel -->|telephony-control calls, DTMF confirmation| gw
  td_tel -->|handoff context| agent_ws[DF-24 Human agent workspace]
  gw <--> ddb[(DF-09 DynamoDB sessions)]
  gw <--> aurora[(DF-08 Aurora PostgreSQL)]
  aurora -->|outbox| sqs[[DF-12 SQS and DLQ]]
  sqs --> worker[Worker on ECS Fargate]
  worker <--> sfn[[DF-13 Step Functions Standard]]
  worker --> sf[(DF-16 Salesforce Service Cloud)]
  gw <--> biz[(DF-17 Scheduling, billing, claims, provider systems)]
  gw <--> idp[DF-18 Client and provider IdPs]
  worker --> notif[DF-19 Notification providers]
  aurora -->|audit outbox shipper| s3audit[(DF-10 S3 Object Lock, audit account)]
  td_store -.->|approved QA export only| s3qa[(DF-11 S3 restricted QA media)]
  gw -.->|content-free metrics and logs| cw[(DF-14 CloudWatch)]
  cw -.->|only if approved| dd[(DF-15 Datadog)]
  console[DF-23 Operations console] <--> gw
  staff([Workforce staff via SSO]) --> console
  ci[DF-21 CI] -.->|synthetic data only| gw
  dev[DF-22 Developer machines and coding agents] -.->|synthetic data only| ci
```

Solid arrows carry PHI in the designed flow. Dotted arrows are restricted, conditional or
must stay free of PHI.

## Inventory

BAA status is **UNKNOWN** for every external processor until privacy counsel records the
executed agreement and the exact covered services (PRQ-002, PRQ-038). Region is UNKNOWN until
VQ-TD-04, VQ-SF-10 and VQ-AWS-06 are answered.

| ID | Component | Role | Data classes and classification | Storage location | Support-access path | Backups and derived copies | Deletion path | BAA status | Retention ref | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| DF-01 | Carrier / PSTN | Transport outside the platform | Audio (PHI) | Carrier networks | Carrier | UNKNOWN | Not controllable | Not applicable (carrier transport); counsel to confirm | — | UNKNOWN |
| DF-02 | Talkdesk telephony and Studio | Processor; routing, queues, recordings if enabled, Studio variables, execution logs | RM-01 audio; Studio variables (opaque session reference, Auth Gate boolean; must never hold OTP digits — VQ-TD-48) | Talkdesk (region UNKNOWN) | Talkdesk staff and subprocessors (VQ-TD-06); tenant admins | Recordings, Studio logs, reporting exports (UNKNOWN) | Vendor deletion request and verification (VQ-TD-05) | UNKNOWN | RM-01, RM-03 | UNKNOWN |
| DF-03 | Talkdesk ASR | Processor; receives raw audio | RM-01 raw audio and pre-redaction transcript (PHI; DATA-02) | Talkdesk / subprocessors (UNKNOWN) | UNKNOWN (VQ-TD-06) | UNKNOWN | Vendor deletion request | UNKNOWN | RM-01 | UNKNOWN |
| DF-04 | Talkdesk AI Agent Platform model | Processor; untrusted conversational layer | RM-01 transcript and model context (PHI); tool results already field-masked by policy | Talkdesk / model subprocessors (UNKNOWN, VQ-TD-01, VQ-TD-02) | UNKNOWN | AI conversation logs, Simulator and evaluation data (UNKNOWN) | Vendor deletion request; training-use terms (VQ-TD-03) | UNKNOWN | RM-01, RM-03 | UNKNOWN |
| DF-05 | Talkdesk TTS | Processor | RM-01 rendered text and audio (PHI) | UNKNOWN | UNKNOWN | UNKNOWN | Vendor deletion request | UNKNOWN | RM-01 | UNKNOWN |
| DF-06 | Talkdesk recordings, transcripts, AI logs, Explore exports | Storage at vendor | RM-03 if retained for QA; otherwise RM-01 | Talkdesk (UNKNOWN) | Tenant admins, Talkdesk support | Exports (formats VQ-TD-09) | Vendor lifecycle and deletion request; export copies deleted by owner | UNKNOWN | RM-01, RM-03 | UNKNOWN |
| DF-07 | Gateway (Fastify on ECS Fargate) | Processor; in-memory only | RM-01 tool arguments and results (PHI, FINANCIAL) | Container memory; no PHI written to disk or logs | No interactive access; deploys via CI | None (stateless) | Process exit | AWS: UNKNOWN (VQ-AWS-01) | RM-01 | Offline: gateway module IMPLEMENTED_OFFLINE (LOCAL FIXTURE adapters); deployed: BLOCKED (PRQ-037) |
| DF-08 | Aurora PostgreSQL | Store; ledger, outbox, support requests, workflows, knowledge, memory, audit outbox, gateway tool-request replay cache | RM-02 (PHI, PHI_RESTRICTED, FINANCIAL); RM-01 replay cache (tool results; request hashes stored only as keyed HMAC with a secret pepper, never a digest of the name + DOB locator, DP-02); RM-04 local audit outbox | AWS primary region (UNKNOWN); encrypted with KMS | Application roles with RLS; restricted support requests (clinical-question, privacy-concern and safety-concern handoffs, DP-01) are hidden from the runtime role and readable by the console only after a break-glass `restricted_record:view` decision; break-glass DBA access audited | Automated backups, snapshots, cross-region replica (planned), PITR | Retention job (`platform/src/retention`, exists offline; every class reports `BLOCKED_RETENTION_UNSET` and deletes nothing until durations are approved) plus backup expiry; replay-cache rows purged after their replay window (worker loop `tools.idempotency_purge`); legal hold exceptions | AWS: UNKNOWN | RM-02, RM-04 | Offline: PGlite (ADR-0004); deployed: BLOCKED (PRQ-037) |
| DF-09 | DynamoDB sessions (identity KV store) | Store; trusted session binding; verification abuse monitor | RM-01 actor/subject ids, assurance, consent state (opaque ids; PHI by association); account-keyed abuse-monitor counters (sha256 of the account or destination id, hourly; never linked to a session, AUTH-ENUM-01), class to be confirmed (RM-04 proposed) | AWS primary region (UNKNOWN) | Application only; abuse counters read by security monitoring (`VerificationAbuseMonitor.count`) | PITR backups if enabled; global table replica if used (UNKNOWN) | Application expiry enforced on read; TTL cleanup (abuse counters: `abuseSignalRetentionHours`, an engineering default pending Security approval); backup expiry | AWS: UNKNOWN | RM-01 | Offline: memory fixture; deployed: BLOCKED |
| DF-10 | S3 audit bucket (separate audit account, Object Lock, KMS) | Store; independent append-only evidence | RM-04 security metadata with opaque references (no content) | Audit account (UNKNOWN region) | Auditors via metadata search; audit-account administrators only | Object Lock versions; cross-region copy if approved | Object Lock expiry per approved class; legal hold | AWS: UNKNOWN | RM-04 | Offline: local-filesystem fixture; live sink BLOCKED (PRQ-040) |
| DF-11 | S3 restricted QA media | Store; recordings and transcripts retained for approved QA | RM-03 (PHI, PHI_RESTRICTED) | AWS (UNKNOWN) | Named QA reviewers through audited access | Versions; no public or long-lived links | Lifecycle policy per approved class; verified deletion of derived copies | AWS: UNKNOWN | RM-03 | Not implemented; requires approved purpose (PRQ-003, PRQ-025) |
| DF-12 | SQS queues and dead-letter queues | Transport; outbox delivery | RM-02 minimal message bodies (opaque ids, action references) | AWS (UNKNOWN); KMS | Operators via DLQ repair console flow | Message retention per queue configuration | Queue retention expiry; DLQ repair then delete | AWS: UNKNOWN | RM-02 | Plans only (`infra/terraform/modules/sqs`) |
| DF-13 | Step Functions Standard | Processor; durable follow-up | RM-02 minimal workflow ids and source references; task tokens (secret) in resolved parameters | AWS (UNKNOWN) | Execution history restricted to the worker role and audited break-glass | Execution history (service-managed) | Service history retention (UNKNOWN, record in vendor inventory); no PHI in names or logs | AWS: UNKNOWN | RM-02 | Generated ASL only (ADR-0007); deployment BLOCKED |
| DF-14 | CloudWatch metrics, logs and alarms | Telemetry sink | Content-free: metric names, closed-enum labels, reason codes; no PHI. WAF request logs (log group `aws-waf-logs-<prefix>`) keep request metadata (header names and values other than the redacted ones, URI path, client address) with `authorization`, `cookie`, `mcp-session-id`, `x-vsp-session-ref`, `x-vsp-interaction-id`, `idempotency-key` and the query string redacted (VSP-INF-01) | AWS (UNKNOWN) | SRE and security operations | Log retention per group (TO BE SET) | Log group retention; no PHI to delete by design | AWS: UNKNOWN | RM-04 (operational logs class to be confirmed) | OTel export BLOCKED (PRQ-047) |
| DF-15 | Datadog | Telemetry sink, **only if approved** | Content-free metrics only by default | Vendor (UNKNOWN) | Vendor and SRE | UNKNOWN | Vendor retention | UNKNOWN (VQ-OBS-01) | — | Not in scope unless approved (PRQ-047) |
| DF-16 | Salesforce Service Cloud | System of record for Cases | RM-02 audience, opaque subject reference, issue category, disposition, minimised summary, receipts, source call ids, consent status; restricted records (a minimal RESTRICTED Case) for clinical-question, privacy-concern and safety-concern handoffs, privacy complaints and safety events, with no subject reference for clinical-question records (DP-01) | Salesforce org (region UNKNOWN, VQ-SF-10) | Support staff per sharing model; integration identity restricted | Salesforce backups and sandboxes (sandbox must not copy production data, VQ-SF-02) | Salesforce deletion per approved class; derived reports | UNKNOWN (VQ-SF-01) | RM-02 | Live adapter BLOCKED (PRQ-006) |
| DF-17 | Business systems (scheduling, billing, claims, provider network) | Systems of record | RM-02 appointments, invoices, claims, onboarding, remittances (PHI, FINANCIAL) | Owner systems (UNKNOWN) | Owner teams | Owner-managed | Owner-managed; not changed by this platform | UNKNOWN | RM-02 (owner schedules) | Live adapters BLOCKED (PRQ-007) |
| DF-18 | Client and provider IdPs (OIDC); workforce SSO | Processors; authentication | Identity claims (sub, amr, auth_time); registered channels | IdP vendors (UNKNOWN) | Identity owner | IdP-managed | IdP-managed | UNKNOWN | — | Live verifier present offline only; BLOCKED (PRQ-036) |
| DF-19 | Notification providers (SMS, voice, email) | Processors | Neutral templates only; destination channel references; OTP codes if enabled | Vendor (UNKNOWN) | Vendor support | Delivery logs (UNKNOWN) | Vendor retention | UNKNOWN (PRQ-048) | RM-01 | Local fixture only; every send is refused before the provider while `OUTBOUND_NOTIFICATIONS` or `INTEGRATION notifications` is engaged or switch state is unreadable (OPS-KS-01) |
| DF-20 | Secrets Manager and KMS | Key and secret custody | Credentials and keys, no PHI | AWS (UNKNOWN) | Security admins | Service-managed | Rotation and scheduled key deletion | AWS: UNKNOWN | RM-04 (rotation evidence) | Plans only |
| DF-21 | CI | Build and test | **Synthetic data only**; no PHI in CI logs | CI provider (GitHub Actions per `.github/workflows`; account settings UNKNOWN) | Repository maintainers; the CI deploy roles are denied the listed data-plane reads, exports and sharing calls, with residual paths through the resource policies Terraform manages (VSP-INF-02, `infra/terraform/README.md`) | Build logs, SBOM and scan artefacts | CI artefact retention (UNKNOWN) | Not a PHI processor by design | — | Workflows defined; actions not yet pinned by SHA (PRQ-041); no run evidence yet |
| DF-22 | Developer machines and coding-agent environments | Development | **Synthetic data only**; never real transcripts, credentials or patient records (spec section 1) | Local | Developers | — | — | Not a PHI processor by design | — | Enforced by process; approved environments list pending (PRQ-003) |
| DF-23 | Operations console (browser) | Presentation to staff | Minimised fields per policy field mask; no raw queries or unrestricted transcript downloads | Browser memory only | Staff per role | None (no downloads) | Session end | — | — | Offline: console API and UI IMPLEMENTED_OFFLINE (LOCAL FIXTURE sign-in); workforce SSO BLOCKED (PRQ-036) |
| DF-24 | Human agent workspace (Talkdesk) | Presentation to the receiving human | Handoff package: stated issue, assurance and limits, authorised subject, consent, receipts, references, language and accommodations, safety-routing reason | Talkdesk (UNKNOWN) | Receiving agent | Talkdesk interaction record (UNKNOWN) | Vendor lifecycle | UNKNOWN | RM-01, RM-02 | Context delivery UNKNOWN (VQ-TD-39) |
| DF-25 | Evaluation and LLM judges | Processors for evaluation | Synthetic or consented scenarios only; production-derived scenarios only after approved access and minimisation | Approved environments only (UNKNOWN) | QA reviewers | Scorecards (append-only) | Per RM-03 | UNKNOWN | RM-03 | Not used with real data |
| DF-26 | Hosted payment page / PCI provider | External; link only | Card data never enters this platform | Provider (UNKNOWN) | Provider | — | — | UNKNOWN | — | UNKNOWN (PRQ-050) |

## Deletion and derived copies

Deletion is not complete until every derived copy is handled: indexes (full-text and pgvector
embeddings of approved knowledge only), caches, read replicas, backups and snapshots, exports,
DLQ messages, vendor copies and evaluation datasets. Deletion verification is recorded as a
`SECURITY_AUDIT` event. Legal hold suspends deletion for the held scope only and is itself
recorded. Durations and mechanisms per class are in [`retention-matrix.md`](retention-matrix.md).

## Open questions for review

| Question | Owner | Reference |
|---|---|---|
| Which Talkdesk features in our plan receive raw audio, and which subprocessors? | Talkdesk / privacy counsel | VQ-TD-01, VQ-TD-06 |
| Is call recording enabled before the consent step anywhere in the tenant? | Talkdesk administrator | VQ-TD-07 |
| Do Studio execution logs persist DTMF-collected values? | Talkdesk / security | VQ-TD-48 |
| Which AWS accounts and components are covered by the BAA? | Privacy counsel / cloud platform owner | VQ-AWS-01, VQ-AWS-02 |
| Is any observability vendor beyond CloudWatch in scope? | Security leadership | VQ-OBS-01 |
| Applicability of Part 2, psychotherapy-note, state and minor rules per record type | Privacy counsel | VQ-LEG-03 |

## Review record

| Date | Reviewer role | Outcome |
|---|---|---|
| — | Privacy counsel | NOT_RUN (awaiting PRQ-003) |
| — | Security leadership | NOT_RUN (awaiting PRQ-003) |
