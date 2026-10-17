# Vendor and owner written-question register

Every question below requires a **written** answer for the actual plan, tenant, SKU,
region and feature — not a demo tenant and not a public web page (spec section 5).
Status for every row: **UNANSWERED** (no question has been sent by this package; sending
is done by the named owner). An answer is recorded with: answer reference (document id),
date, answering party, scope (tenant/SKU/region/feature/model), expiry/review date. A
preview feature is not a mandatory production dependency unless its risk and support terms
are explicitly accepted (spec section 5).

Owner column: **answering party / accountable obtainer**.

Gate abbreviations: `CG-xx` capability gate (`capability-gate.md`); `P2`..`P5` phase gates
(`docs/release/phase-gates.md`); `AR-xx` approval requests
(`docs/release/approval-requests.md`); `PHI` = "before any PHI leaves synthetic
environments" (spec section 5).

## 1. Talkdesk — questions reproduced from spec section 5

"Ask Talkdesk to confirm …" (spec section 5, verbatim list split one item per row):

| ID | Question | Owner | Status | Why it matters | Blocks |
|---|---|---|---|---|---|
| VQ-TD-01 | Confirm the complete PHI path and subprocessors for AI Agent Platform, Autopilot Agentic, Studio, recording, transcription, Simulator and evaluation features in our plan. | Talkdesk / privacy counsel + procurement | UNANSWERED | Every PHI processor must be mapped and covered (spec section 6) | PHI, P3 |
| VQ-TD-02 | Confirm the model and voice identifiers used for our agent, and how they are reported per interaction. | Talkdesk / Talkdesk admin | UNANSWERED | Versions must be pinned and reviewable (OPS-06) | CG-07, P2 |
| VQ-TD-03 | Confirm storage and training terms: is any audio, transcript, tool payload or configuration used for training or product improvement; can it be excluded contractually? | Talkdesk / privacy counsel + procurement | UNANSWERED | Training use of PHI is not acceptable without contract terms | PHI |
| VQ-TD-04 | Confirm data residency and any cross-border routing for media, ASR, model inference, TTS, storage and support access. | Talkdesk / privacy counsel | UNANSWERED | Residency and transfer obligations | PHI |
| VQ-TD-05 | Confirm retention and deletion for recordings, transcripts, AI conversation logs, Simulator/evaluation data, exports and backups; deletion request process and verification. | Talkdesk / privacy counsel | UNANSWERED | Retention is set per data class by counsel (spec section 6); vendor copies must be deletable | PHI, AR-11 |
| VQ-TD-06 | Confirm who can access raw audio and transcripts (Talkdesk staff, subprocessors, our users), with what audit trail. | Talkdesk / security | UNANSWERED | Raw audio stays sensitive (DATA-02) | PHI |
| VQ-TD-07 | Confirm recording-consent controls: can recording start only after a Studio consent step; can a tenant-wide automatic-recording setting be overridden per interaction; is recording separable from transcription and AI ASR; can a human leg be unrecorded after a decline? | Talkdesk / Talkdesk admin + privacy counsel | UNANSWERED | Consent before recording; accurate disclosure (DATA-03, SPEC-6) | P2 (SF-T-01, SF-T-05..08) |
| VQ-TD-08 | Confirm secure DTMF or portal verification support: can DTMF be captured so digits reach neither ASR, model, recording, transcript nor logs? | Talkdesk / security | UNANSWERED | Verification secrets must not reach the model (AUTH-06); TB-03 | CG-02 |
| VQ-TD-09 | Confirm export formats for interactions, recordings, transcripts, AI events and configuration. | Talkdesk / Talkdesk admin | UNANSWERED | Reconciliation and audit; drift detection | CG-08, P2 drift check |
| VQ-TD-10 | Confirm per-tenant quotas: trunks, call starts, media legs, AI sessions, ASR/TTS, model throughput, MCP tool calls, exports. | Talkdesk / platform owner + finance | UNANSWERED | Capacity must be contracted and tested separately (spec section 12) | CG-10, P3 |
| VQ-TD-11 | Confirm throttling and queue behaviour when any quota is reached (reject, queue, degrade), and how Studio is notified. | Talkdesk / SRE | UNANSWERED | Quota exhaustion must route to continuity, never drop silently | CG-10, P3 |
| VQ-TD-12 | Confirm version pinning for agent configuration, prompts, model and voice; can a published version be held while the vendor updates underlying models? | Talkdesk / Talkdesk admin | UNANSWERED | OPS-06; regression scope on vendor changes (spec section 15) | CG-07, P2 |
| VQ-TD-13 | Confirm rollback: can we revert agent configuration, Studio flows and MCP connections to a prior version quickly, and is rollback itself auditable? | Talkdesk / Talkdesk admin | UNANSWERED | Rehearsed rollback (spec section 15) | P2 rollback, P5 |
| VQ-TD-14 | Confirm emergency routing behaviour: priority queues, routing during AI failure, and any platform constraints on transferring to external emergency resources. | Talkdesk / clinical safety lead + support ops | UNANSWERED | Safety route must not depend on AI (SAFE-02, OPS-02) | CG-05, P4 |
| VQ-TD-15 | Confirm support response commitments (severity definitions, response times, escalation contacts) for AI Agent Platform incidents. | Talkdesk / procurement + SRE | UNANSWERED | Incident response for unsafe output or outages (spec section 13) | P3 |

"Ask specifically …" (spec section 5):

| ID | Question | Owner | Status | Why it matters | Blocks |
|---|---|---|---|---|---|
| VQ-TD-16 | Can authentication variables be cleared on expiry (and mid-component), and by which component? | Talkdesk / identity owner | UNANSWERED | Expired sessions must fail closed (AUTH-04); TB-06 | CG-01 |
| VQ-TD-17 | Can the model mutate any trusted session field or Studio variable (including the Auth Gate variable) directly or via tool-output mapping? | Talkdesk / security | UNANSWERED | Server-established identity (AUTH-03); TB-06 | CG-01 |
| VQ-TD-18 | Can every protected utterance be validated before audio emission (no streaming of unvalidated protected content)? | Talkdesk / security + clinical safety | UNANSWERED | ACT-05; TB-04 | CG-04 |
| VQ-TD-19 | Is crisis input available to a deterministic component before refusal or termination logic acts? | Talkdesk / clinical safety lead | UNANSWERED | SAFE-03; TB-05 | CG-05 |
| VQ-TD-20 | Provide the above as documented answers for our actual plan (not a demo tenant), and state which features are Preview, with their risk and support terms. | Talkdesk / procurement | UNANSWERED | Public docs ≠ tenant capability (spec section 1) | all CG |

## 2. Talkdesk — questions derived from spec sections 2, 3, 7, 8, 10, 12 and 15

| ID | Question | Owner | Status | Why it matters | Blocks |
|---|---|---|---|---|---|
| VQ-TD-21 | Auth Gate condition semantics: documentation describes the condition as the variable being *defined* ([S2]). Exactly which values open the gate (unset, null, "", false, "false", "true", true)? Do Studio/AI variables have a native boolean type, and can JSON response fields be type-checked? | Talkdesk / identity owner | UNANSWERED | Never initialise with a value that opens the gate (spec section 2); stop rule in `auth-gate.md` | CG-01 |
| VQ-TD-22 | Studio HTTP request steps: supported authentication (OAuth2 client credentials? static header?), timeout range, retry behaviour, TLS requirements, response type checking. | Talkdesk / Talkdesk admin | UNANSWERED | telephony_control identity; static tokens need an exception (AR-08) | CG-03, AR-08 |
| VQ-TD-23 | MCP: can a non-model-controlled value (Studio variable such as our session reference, or the interaction id) be sent as an HTTP header or context on every MCP request? | Talkdesk / security | UNANSWERED | TB-01 decision rule (`mcp-connection.md` §5) | CG-01, CG-03 |
| VQ-TD-24 | MCP auth and protocol: which OAuth2 grants are supported ([S3] says bearer or OAuth2), token endpoint configuration, audience/scope fields, token caching/refresh, mTLS support, and which MCP protocol revision the client uses. | Talkdesk / identity owner | UNANSWERED | Short-lived OAuth2 preferred (spec section 8) | CG-03 |
| VQ-TD-25 | MCP tool definitions are not versioned in the platform ([S3]): when are definitions fetched/cached (per session, per publish)? What happens to in-flight conversations when the tool list changes? | Talkdesk / gateway owner | UNANSWERED | Catalogue pinning and drift (spec section 8) | P2 drift check |
| VQ-TD-26 | MCP tool-call timeout, retry policy (does the platform retry a tool call?), maximum payload, and streaming (SSE) expectations. | Talkdesk / gateway owner | UNANSWERED | Retries can duplicate effects (ACT-02, ACT-03) | CG-03 (MC-07) |
| VQ-TD-27 | Deterministic Skills: can a Skill call an HTTP endpoint with its own service identity (not MCP), set variables, capture DTMF, and run without LLM-generated speech? | Talkdesk / Talkdesk admin | UNANSWERED | Verification and confirmation steps (SF-11, SF-12; TB-02) | CG-02, CG-03 |
| VQ-TD-28 | AI agent → Studio exits: can the agent exit with a reason value, can Studio run a sub-flow (confirmation, verification) and return to the same agent conversation, and what context survives? | Talkdesk / Talkdesk admin | UNANSWERED | Deterministic confirmation (TB-02); exit mapping | CG-03, CG-05 |
| VQ-TD-29 | Can a Studio-level DTMF/phrase interrupt ("0", "agent") reach a human while the AI agent holds the call, independent of the model and the MCP server? | Talkdesk / support ops | UNANSWERED | Independent human route (spec section 3) | CG-05 |
| VQ-TD-30 | Guardrails ([S5]): 300-character limit confirmed? On trigger limit, can the conversation exit to Studio instead of closing? Are refusal counters, silence limits and max turns configurable, and what happens at each limit? | Talkdesk / clinical safety lead | UNANSWERED | Crisis/accessibility must reach a human (spec section 2) | CG-06 |
| VQ-TD-31 | Simulator ([S4]): does a run exercise the draft or the published version, how is the version identified, does voice simulation support deterministic scripts, and are Simulator runs billable? | Talkdesk / QA lead + finance | UNANSWERED | Prove which version each test exercises (spec section 2) | CG-07, AR-06 |
| VQ-TD-32 | Is there a documented API or supported import format for Simulator scenarios or evaluation datasets? Is Batch Agent Evaluation (Preview, [S6]) available to us, on what terms? | Talkdesk / QA lead | UNANSWERED | No invented endpoints; Preview not mandatory | AR-14 |
| VQ-TD-33 | Transfer events: are queue entry, receiver acceptance, bridge and caller-connected states exposed via events, webhooks or API, with timestamps and interaction ids? | Talkdesk / support ops | UNANSWERED | SAFE-04; TB-07 | CG-09 |
| VQ-TD-34 | Webhook/event authentication mechanism (signature, timestamp/nonce, replay protection) as documented for our plan. | Talkdesk / security | UNANSWERED | Never invent a signature protocol (spec section 8); TB-09 | CG-08 |
| VQ-TD-35 | Do interaction/AI event exports include agent configuration, model, voice and prompt version identifiers? | Talkdesk / Talkdesk admin | UNANSWERED | TB-08; ReleaseManifest binding | CG-07 |
| VQ-TD-36 | Explore API ([S24]): which reports exist for our plan, their fields, pagination, retry behaviour and report limits; transcript and raw-audio availability per report. | Talkdesk / data owner | UNANSWERED | Phase 0 traffic statistics; reconciliation (spec section 15) | CG-08, P0 |
| VQ-TD-37 | Configuration export: can Studio flows, AI agent configuration, guardrails, MCP connections, queues and variables be exported (format, API or UI), with version history? | Talkdesk / Talkdesk admin | UNANSWERED | Drift detection (spec section 15) | P2 drift check |
| VQ-TD-38 | AI agent language support: which languages are supported for ASR/TTS/agent reasoning, with what endpointing controls? | Talkdesk / language leads | UNANSWERED | Unsupported languages go to interpreters (spec section 11) | P3 |
| VQ-TD-39 | Context to the receiving human on transfer (screen-pop / context fields / attached data), and whether receipt can be confirmed. | Talkdesk / support ops | UNANSWERED | Receiver should not re-ask routine details (spec section 10) | CG-09 |
| VQ-TD-40 | Callback feature for continuity mode (consented callback, queue position retention). | Talkdesk / support ops | UNANSWERED | Outage service mode (spec section 12) | P3 |
| VQ-TD-41 | Does Studio execute steps after the caller hangs up (call-end webhook)? If not, is a call-end event exported? | Talkdesk / Talkdesk admin | UNANSWERED | Session expiry at call end (spec section 7) | P2 |
| VQ-TD-42 | Is there a supported SIP or media interface to hand the call leg to an external speech runtime and back while keeping Studio queues and human transfer? | Talkdesk / platform owner | UNANSWERED | LiveKit fallback precondition (spec section 3) | Fallback review |
| VQ-TD-43 | Written capacity commitments at the planning targets: 2,000 concurrent calls initial and 3,000 surge with controlled admission (illustrative spec section 12 figures), and call-start rate. | Talkdesk / platform owner + finance | UNANSWERED | Contracted concurrency; illustrative ≠ vendor promise | CG-10 |
| VQ-TD-44 | Sandbox tenant: availability, licences, cost, isolation from production, test number provisioning and cost. | Talkdesk / Talkdesk admin + finance | UNANSWERED | Execution-order step 5 | AR-01, AR-07 |
| VQ-TD-45 | Published egress IP ranges for MCP and Studio HTTP requests (supplemental allowlist only). | Talkdesk / security | UNANSWERED | IP allowlists are supplemental, not authentication | P2 network |
| VQ-TD-46 | BAA scope: which Talkdesk products and features in our contract (AI Agent Platform, Autopilot Agentic, Simulator, recording, transcription, evaluation) are covered for PHI. | Talkdesk / privacy counsel + procurement | UNANSWERED | Executed service-specific coverage (spec section 5) | PHI |
| VQ-TD-47 | Talkdesk-side continuity options and status notification during a platform-wide outage. | Talkdesk / support ops | UNANSWERED | Complements the separate carrier arrangement (VQ-OPS-01) | P3 |
| VQ-TD-48 | Do Studio execution logs, variable history or reporting exports persist variable values (e.g. a DTMF-collected value)? Can specific variables be excluded? | Talkdesk / security | UNANSWERED | OTP digits must not persist (AUTH-06); DT-04 | CG-02 |

## 3. Salesforce

| ID | Question | Owner | Status | Why it matters | Blocks |
|---|---|---|---|---|---|
| VQ-SF-01 | Which Salesforce services in our org are covered by the executed BAA, and which BAA restrictions apply ([S11])? Confirm the design does not require Agentforce Contact Center. | Salesforce / privacy counsel + procurement | UNANSWERED | Exact service coverage (spec section 2) | PHI |
| VQ-SF-02 | Sandbox type for synthetic-only integration tests; confirm it contains **no copied production data** (a sandbox type that copies production records would bring PHI into the test path). | Salesforce admin | UNANSWERED | Synthetic data only in Phase 2 | AR-03 |
| VQ-SF-03 | Dedicated integration identity: licence, permission set, restricted objects/fields, supported OAuth flow for server-to-server access. | Salesforce admin / identity owner | UNANSWERED | Least privilege; separate identities per environment (spec section 8) | AR-03 |
| VQ-SF-04 | Case schema: fields for audience, subject reference, issue category, disposition, owner queue, priority, minimised summary, attempted steps, commit receipts, source call ids, language, consent status, next step, deadline, versions; separate interaction vs issue records; restricted record handling for privacy/safety events. | Salesforce admin / support owner | UNANSWERED | Interaction ≠ issue (spec section 8) | P2 Case writes |
| VQ-SF-05 | External ID fields and upsert behaviour ([S23]); existing duplicate rules (not to be disabled broadly). | Salesforce admin | UNANSWERED | No duplicates under retry (ACT-02) | P2 |
| VQ-SF-06 | Sharing model and field encryption availability for restricted fields. | Salesforce admin / security | UNANSWERED | Field-level minimisation (spec section 7) | PHI |
| VQ-SF-07 | API allocation and concurrency limits for the org and sandbox. | Salesforce admin / platform owner | UNANSWERED | Capacity; avoid per-turn pulls (spec section 12) | P3 |
| VQ-SF-08 | Automation inventory (flows, triggers, assignment rules) that fires on Case/interaction upsert. | Salesforce admin | UNANSWERED | Hidden side effects or duplicates | P2 |
| VQ-SF-09 | Salesforce Knowledge export path for the controlled knowledge pipeline (spec section 9). | Salesforce admin / knowledge owner | UNANSWERED | Approved knowledge ingestion | P2 knowledge |
| VQ-SF-10 | Data residency / hosting region of the org. | Salesforce / privacy counsel | UNANSWERED | Residency | PHI |

## 4. Identity owners (client IdP, provider IdP, workforce SSO, service authorization server)

| ID | Question | Owner | Status | Why it matters | Blocks |
|---|---|---|---|---|---|
| VQ-IDP-01 | Issue OIDC test clients (issuer, client id, redirect URIs, PKCE) and synthetic test users for the client and provider IdPs in non-production tenants. | identity owner | UNANSWERED | Secure-link verification in sandbox (spec section 7) | AR-04 |
| VQ-IDP-02 | Account linking: authoritative mapping from IdP subject to platform actor; enrollment source. | identity owner | UNANSWERED | No second identity database (spec section 3) | P2 |
| VQ-IDP-03 | Registered-channel verification status and channel-change timestamps (SIM-swap risk signal). | identity owner | UNANSWERED | OTP only to existing verified channel | P2 |
| VQ-IDP-04 | Account recovery process the voice channel must hand off to and never bypass. | identity owner | UNANSWERED | Login help never bypasses recovery (spec section 4) | P2 |
| VQ-IDP-05 | Proxy / personal-representative authority policies and system of record. | identity owner / privacy counsel | UNANSWERED | Representative access only with verified authority | P2 |
| VQ-IDP-06 | `amr`/`acr` values for MFA and passkeys, `auth_time`/`max_age` and nonce support, token lifetimes, JWKS rotation cadence. | identity owner | UNANSWERED | A2/A3 tier establishment | P2 |
| VQ-IDP-07 | Authorization server for service identities (Talkdesk MCP and Studio clients): issuer, audience, scopes, lifetime, rotation. | identity owner | UNANSWERED | OAuth2 client credentials (`mcp-connection.md` §4) | CG-03, AR-01 |
| VQ-IDP-08 | Workforce SSO groups for console roles (support agent, supervisor, safety responder, auditor, knowledge editor, policy approver, deployment operator, security admin) with MFA. | identity owner / security | UNANSWERED | Role separation (spec section 7) | P2 console |
| VQ-IDP-09 | OTP delivery provider and contract (if OTP is permitted at all); security-approved attempt limits (spec proposes 3 per challenge, 5 per account per hour — security must approve final values). | identity owner / security | UNANSWERED | OTP abuse controls | CG-02 |

## 5. AWS

| ID | Question | Owner | Status | Why it matters | Blocks |
|---|---|---|---|---|---|
| VQ-AWS-01 | Confirm the executed AWS BAA covers the sandbox, staging, production and audit accounts in our organisation. | AWS / privacy counsel | UNANSWERED | An AWS BAA does not cover other vendors (spec section 2) | PHI |
| VQ-AWS-02 | Reconcile every component (ECS Fargate, ALB, WAF, Aurora PostgreSQL, DynamoDB, SQS, Step Functions, S3 incl. Object Lock, KMS, Secrets Manager, CloudWatch, ECR, CloudTrail, VPC endpoints, NAT) against the current HIPAA eligible services reference ([S10]). | cloud platform owner / security | UNANSWERED | Eligibility is per service (spec section 3) | PHI |
| VQ-AWS-03 | Account structure: dedicated sandbox workload account and separately administered audit account; SCPs; who administers the audit account. | cloud platform owner | UNANSWERED | Independent audit evidence (OPS-01) | AR-02 |
| VQ-AWS-04 | Service quotas in the sandbox region for the planned stack. | cloud platform owner | UNANSWERED | Sandbox apply must not need quota increases with cost commitments | AR-02 |
| VQ-AWS-05 | Current rate cards for the chosen region and any enterprise pricing terms. | finance | UNANSWERED | Cost estimate inputs (`docs/release/sandbox-plan.md` §9) | AR-02 |
| VQ-AWS-06 | Primary and secondary US regions for recovery; data residency constraints. | cloud platform owner / privacy counsel | UNANSWERED | Recovery objectives (spec section 12) | P3 |
| VQ-AWS-07 | Nova 2.5 Sonic (announced October 5, 2026, [S15]): exact model id, region, quota, endpoint and BAA eligibility; resolve the context-limit discrepancy (announcement 256K vs model overview up to 1M, [S16]). | AWS / platform owner | UNANSWERED | Exact evidence required before any selection; large context is not authorization (spec section 2) | Fallback review, MODEL_VOICE_SELECTION |
| VQ-AWS-08 | CI OIDC federation into the sandbox deploy role; Terraform state backend location and locking; owners. | cloud platform owner / security | UNANSWERED | Reviewable plans, no long-lived CI keys (spec section 3) | AR-15 |
| VQ-AWS-09 | S3 Object Lock mode and retention for the sandbox audit bucket (governance vs compliance) — compliance mode cannot be shortened or removed, which constrains rollback. | security / privacy counsel | UNANSWERED | Rollback plan and retention | AR-02, AR-11 |

## 6. Speech and model vendors (any processor in the voice path, including Talkdesk subprocessors and fallback candidates)

| ID | Question | Owner | Status | Why it matters | Blocks |
|---|---|---|---|---|---|
| VQ-SPV-01 | BAA coverage for the exact service, endpoint, feature and deployment mode used. | vendor / privacy counsel | UNANSWERED | Coverage is not implied by a framework BAA (spec section 2) | PHI |
| VQ-SPV-02 | Zero-retention terms per feature and endpoint, including exceptions (abuse monitoring, debugging). | vendor / privacy counsel | UNANSWERED | Zero retention verified per feature (spec section 6) | PHI |
| VQ-SPV-03 | Training-use terms for audio, transcripts and prompts. | vendor / procurement | UNANSWERED | No training on PHI without terms | PHI |
| VQ-SPV-04 | Subprocessors and data residency. | vendor / privacy counsel | UNANSWERED | PHI processor map | PHI |
| VQ-SPV-05 | Exact model and voice identifiers, pinning, deprecation and retirement notice. | vendor / platform owner | UNANSWERED | OPS-06; no adoption of quoted retirement dates without evidence | MODEL_VOICE_SELECTION |
| VQ-SPV-06 | Voice licensing, training provenance, indemnity and biometric features (voiceprint litigation names several vendors; these are allegations, not findings — [S17]). | vendor / privacy counsel + procurement | UNANSWERED | Procurement must address these for every supplier (spec section 2) | MODEL_VOICE_SELECTION |
| VQ-SPV-07 | Matched, dated evidence of telephone-path latency, word-error rate on telephone audio, barge-in and noisy-audio behaviour for our languages. | vendor / QA lead | UNANSWERED | Quoted ranges and leaderboards are not requirements (spec section 2) | P3 |
| VQ-SPV-08 | If any Microsoft/Azure AI endpoint is used: BAA coverage for that exact endpoint, preview feature and deployment mode ([S12]). | Microsoft / privacy counsel | UNANSWERED | Framework BAA ≠ coverage of every endpoint (spec section 2) | PHI |

## 7. ElevenLabs — optional future voice-quality candidate only (not a default platform)

| ID | Question / caveat to confirm | Owner | Status | Why it matters | Blocks |
|---|---|---|---|---|---|
| VQ-EL-01 | BAA availability and conditions; documentation requires BAA coverage **and** Zero Retention Mode for eligible PHI handling ([S13]). | ElevenLabs / privacy counsel | UNANSWERED | Eligibility conditions | Any ElevenLabs evaluation |
| VQ-EL-02 | Documentation states MCP is unavailable for users requiring HIPAA compliance or Zero Retention Mode ([S14]). What tool-integration path exists under ZRM? The Talkdesk MCP design must not be ported assuming parity. | ElevenLabs / platform owner | UNANSWERED | Tool access architecture would differ | Any ElevenLabs evaluation |
| VQ-EL-03 | Voice-cloning workflows are not ZRM-eligible ([S14]); cloning is prohibited by this design anyway (spec section 11). Confirm stock voices available under ZRM. | ElevenLabs / QA lead | UNANSWERED | Voice selection constraints | MODEL_VOICE_SELECTION |
| VQ-EL-04 | Exact ZRM-eligible endpoints and UI exclusions ([S14]). | ElevenLabs / privacy counsel | UNANSWERED | Per-endpoint verification | Any ElevenLabs evaluation |
| VQ-EL-05 | Supported telephony integration with Talkdesk, if any (none assumed). | ElevenLabs + Talkdesk / platform owner | UNANSWERED | Avoid assumed feature parity | Fallback review |

## 8. Observability vendor

| ID | Question | Owner | Status | Why it matters | Blocks |
|---|---|---|---|---|---|
| VQ-OBS-01 | Datadog (spec section 3 "approved Datadog configuration"): contract/BAA scope, whether any PHI-adjacent telemetry is permitted, retention, access controls; default is content-free metrics only. | Datadog / security + privacy counsel | UNANSWERED | No PHI to unapproved sinks (DATA-01) | P2 observability export |

## 9. Internal owners (questions that only the company can answer)

| ID | Question | Owner | Status | Why it matters | Blocks |
|---|---|---|---|---|---|
| VQ-OPS-01 | Separately contracted carrier or continuity arrangement for a whole-Talkdesk outage (numbers, routing, staffing). | support operations + procurement + telecom | UNANSWERED | AWS failover cannot solve a Talkdesk outage (spec section 3) | P3 |
| VQ-OPS-02 | Safety unavailable-responder / terminal procedure after `dst_safety_backup`, after-hours protocol, external transfer agreements, staffed response plan. | clinical safety lead | UNANSWERED | SF-S step 5 is BLOCKED (spec section 10) | P4 patient-facing voice |
| VQ-OPS-03 | Queue wait thresholds, hold-update interval, overflow targets, callback approval and continuity staffing. | support operations | UNANSWERED | SF-13/SF-H values are UNKNOWN until set | P2 values, P3 |
| VQ-LEG-01 | Jurisdiction-approved recording/automated-agent disclosure, consent matrix and approved alternative wording when a caller declines. | privacy counsel | UNANSWERED | DATA-03; SF-04 | AR-12, P2 |
| VQ-LEG-02 | Retention durations per data class for sandbox test evidence (synthetic recordings, transcripts, audit). | privacy counsel | UNANSWERED | No invented retention (spec section 6) | AR-11 |
| VQ-LEG-03 | Applicability of 42 CFR Part 2, psychotherapy-note protections, state mental-health confidentiality, minors/representatives, recording, biometric, accessibility, outbound-call and PCI rules for the implemented system. | privacy counsel | UNANSWERED | Counsel determines applicability (spec section 6) | PHI, P4 |
| VQ-FIN-01 | Vendor rate cards (Talkdesk telephony, AI usage, Simulator, numbers; AWS; Salesforce sandbox), approved test ceiling, reserve and cutoff behaviour. | finance + platform owner | UNANSWERED | No billable execution without estimate and approval (spec section 12) | AR-02, AR-05, AR-06, AR-07 |
