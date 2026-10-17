# Retention matrix

Engineering draft (prerequisite PRQ-025, approval scope `RETENTION_SCHEDULE`). It separates the
four data classes of spec section 6 and records, for each storage location, the legal purpose,
deletion mechanism, derived copies, legal-hold handling and verification method.

**There is no universal retention duration.** Every duration cell reads **TO BE SET BY PRIVACY
COUNSEL**. HIPAA's documentation requirements do not mean every recording must be kept for the
documentation-retention period; durations are set per class and legal purpose by privacy
counsel. Until they are set, `PlatformConfig.retention` holds `null` for each class, and the
production configuration guard treats a missing value as blocking.

Storage ids refer to [`data-flow-inventory.md`](data-flow-inventory.md).

## RM-01 Transient conversational data (`TRANSIENT_CONVERSATION`)

| Storage | Legal purpose | Retention duration | Deletion mechanism | Derived copies | Legal hold handling | Verification method |
|---|---|---|---|---|---|---|
| DF-09 DynamoDB sessions | Trusted session binding for the live call and a bounded post-call window for reconciliation | TO BE SET BY PRIVACY COUNSEL | Application enforces `expiresAt` on every read; DynamoDB TTL deletes later (TTL is not immediate) | PITR backups; any global-table replica | Hold suspends TTL deletion for the held keys via a hold flag; recorded as an audit event | Scheduled job samples expired items and asserts no reader accepts them; backup expiry checked against the approved window |
| DF-07 Gateway memory | Processing only | Not persisted | Process memory released; no PHI written to disk or logs | None by design | Not applicable | Log and metric content-free tests (DATA-01) |
| DF-02..DF-05 Talkdesk telephony, ASR, model, TTS | Delivering the call | TO BE SET BY PRIVACY COUNSEL (vendor terms, VQ-TD-05) | Vendor lifecycle setting and deletion request | Vendor logs, Simulator and evaluation data, exports | Vendor hold process (UNKNOWN) | Written vendor deletion confirmation; spot-check export absence |
| DF-19 Notification providers | Delivering neutral notifications | TO BE SET BY PRIVACY COUNSEL (vendor terms) | Vendor retention setting | Delivery logs | Vendor hold process (UNKNOWN) | Vendor confirmation |

## RM-02 Business records required for support (`BUSINESS_RECORD`)

| Storage | Legal purpose | Retention duration | Deletion mechanism | Derived copies | Legal hold handling | Verification method |
|---|---|---|---|---|---|---|
| DF-08 Aurora: action ledger, receipts, idempotency records | Proof of what was requested, confirmed and committed; duplicate prevention and reconciliation | TO BE SET BY PRIVACY COUNSEL | Retention job deletes or minimises rows past the approved window (`platform/src/retention`, planned) | Backups, snapshots, read replica, cross-region replica | Hold table excludes held subjects or records from the job; hold placement and release are audited | Job emits counts per class; deletion verification record in `SECURITY_AUDIT`; backup expiry evidence |
| DF-08 Aurora: support requests and workflow state | Durable follow-up, promises and deadlines | TO BE SET BY PRIVACY COUNSEL | Retention job after terminal state plus approved window | Backups; SQS messages; Step Functions history | As above | As above, plus confirmation that no pending workflow references a deleted record |
| DF-08 Aurora: support memory (verified preferences, open issues, reviewed summaries) | Avoid repeat explanations for verified callers | TO BE SET BY PRIVACY COUNSEL (per-entry expiry also applies) | Per-entry expiry plus retention job | Backups | As above | Expired entries never returned (DATA-04 tests); job counts |
| DF-12 SQS and DLQ | Delivery and repair | TO BE SET BY PRIVACY COUNSEL (bounded by queue retention) | Queue message retention; DLQ entries deleted after repair | None | Repair before expiry; held messages copied into the ledger hold, not kept in the queue | Queue age alarms; DLQ empty after repair |
| DF-13 Step Functions history | Durable follow-up | TO BE SET BY PRIVACY COUNSEL (service-managed history retention is UNKNOWN until recorded) | Service-managed expiry | Execution history | Not supported in-service; the ledger is the record of truth | Vendor documentation reference recorded in the vendor integration inventory |
| DF-16 Salesforce Cases and interactions | Support system of record | TO BE SET BY PRIVACY COUNSEL | Salesforce deletion or archival per approved class | Reports, sandboxes, backups, exports | Salesforce legal hold process (UNKNOWN) | Salesforce admin attestation plus sampled query of deleted external ids |
| DF-17 Business systems | Owner's record | Owner's approved schedule (not set by this platform) | Owner-managed | Owner-managed | Owner-managed | Owner attestation |

## RM-03 Restricted QA media (`RESTRICTED_QA_MEDIA`)

Retaining recordings or transcripts for QA or evaluation requires a separately approved purpose.
Raw audio and pre-redaction transcripts are PHI wherever stored (DATA-02).

| Storage | Legal purpose | Retention duration | Deletion mechanism | Derived copies | Legal hold handling | Verification method |
|---|---|---|---|---|---|---|
| DF-11 S3 restricted QA media | Approved QA review and release evaluation | TO BE SET BY PRIVACY COUNSEL | S3 lifecycle expiration per approved class; no public or long-lived links | Versions, transcripts, redacted derivatives, evaluation datasets, scorecard evidence pointers | S3 legal hold on the held objects only; audited | Lifecycle configuration evidence; sampled object absence after expiry; derived-copy inventory reconciled |
| DF-06 Talkdesk recordings and transcripts | Vendor-side QA (if enabled) | TO BE SET BY PRIVACY COUNSEL (vendor terms) | Vendor retention setting and deletion request | Exports, Simulator and evaluation data | Vendor hold process (UNKNOWN) | Written vendor confirmation |
| DF-25 Evaluation environments | Release evaluation with synthetic or consented data | TO BE SET BY PRIVACY COUNSEL | Dataset deletion; results retained as RM-04 metadata | Judge inputs and outputs | As above | Dataset inventory reconciled |

## RM-04 Security and audit evidence (`SECURITY_AUDIT`)

| Storage | Legal purpose | Retention duration | Deletion mechanism | Derived copies | Legal hold handling | Verification method |
|---|---|---|---|---|---|---|
| DF-10 S3 audit bucket (Object Lock) | Independent evidence of consequential actions, access, approvals, deletion, restore drills and incident decisions | TO BE SET BY PRIVACY COUNSEL with security leadership; Object Lock mode per environment (VQ-AWS-09) | Object Lock retention expiry; compliance mode cannot be shortened | Manifests; cross-region copy if approved | Object Lock legal hold | Integrity verifier and completeness reconciliation; manifest continuity |
| DF-08 Aurora local audit outbox | Durable buffer before shipping | Until verified shipment, then purged through the verified-purge function | `audit_purge_verified()` only after sink verification | Backups | Purge suspended while a hold or an unverified manifest exists | Purge watermark and verification records |
| DF-14 CloudWatch operational logs and metrics | Operations (content-free) | TO BE SET BY PRIVACY COUNSEL with security leadership | Log group retention setting | Exports, Datadog only if approved | Export of held log groups to the audit account | Retention setting evidence per log group |
| `approvals/` records and drill records | Proof of authorisation and readiness | TO BE SET BY PRIVACY COUNSEL | Repository history and audit copies are not deleted while the release they authorised is live | Release manifests | Not applicable | Release manifest references |

## Rules for implementers

1. No code, configuration, migration, Terraform default or document in this repository may set a
   retention duration until an approved `RETENTION_SCHEDULE` record exists (PRQ-025).
2. Every deletion path covers derived copies: indexes, caches, replicas, backups, exports, DLQs,
   vendor copies and evaluation datasets.
3. Legal holds are scoped, recorded and released explicitly; a hold never extends to unrelated
   records.
4. Vendor deletion requests and their confirmations are retained as RM-04 evidence.
5. A redaction failure quarantines the artefact (restricted access) rather than deleting
   evidence or sending it to a debugging vendor.

## Review record

| Date | Reviewer role | Outcome |
|---|---|---|
| — | Privacy counsel | NOT_RUN (awaiting PRQ-025) |
| — | Security leadership | NOT_RUN (awaiting PRQ-025) |
