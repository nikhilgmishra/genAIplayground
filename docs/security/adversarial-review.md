# Adversarial review

An internal, offline adversarial code review of this repository. Several review lenses looked for
ways to break the specification's invariants. Two independent verifiers had to confirm each
finding before it was fixed. After each fix, an independent verifier re-ran the original
reproduction, and mutation checks tested some of the regression tests. The record covers the 30
confirmed findings, the fix waves, the verdict for each finding and the residual risk left over.

* **This is not the independent security assessment or penetration test** that the specification
  requires before broad launch (PRQ-051, `BLOCKED`; see [`../PREREQUISITES.md`](../PREREQUISITES.md)).
  Engineering ran this review on its own code. It does not replace that assessment, and it does
  not satisfy that assessment's "no unresolved critical finding" condition.
* **LOCAL FIXTURE code only.** Every reproduction and re-verification of application code ran against local fixture
  adapters (PGlite, in-memory stores, fixture telephony, notification, scheduling and Salesforce
  adapters, the local OPA bundle) with SYNTHETIC data. Terraform was checked through offline
  rendered plans, `terraform test` with mock providers and an offline IAM evaluator, never
  against AWS. No Talkdesk tenant, Salesforce org, identity provider or telephone path was
  involved. Reproductions were scripts and vitest files that drove the local container, its
  HTTP and MCP interfaces or single modules directly. No language model was involved. Where
  the evaluation corpus is used, its conversational layer is the LOCAL SIMULATED COORDINATOR
  (deterministic rules, not a language model).
* **Status.** A verdict of FIXED means the original reproduction no longer reproduces on LOCAL
  FIXTURE code. It is not `VERIFIED_SANDBOX` or anything beyond that. Every control named here
  is `IMPLEMENTED_OFFLINE` at most, and the parts that depend on a vendor, an environment or an
  approval stay `BLOCKED` ([`../IMPLEMENTATION_STATUS.md`](../IMPLEMENTATION_STATUS.md)).
  `approvals/` holds no approval record, and this review is not one. It does not establish HIPAA compliance or production readiness.
* **Evidence.** The reproduction scripts and the verifier records are scratch files outside the
  repository. They are not committed, and this page only summarises them. The regression tests
  are committed (see [Evidence](#evidence)).

## Method

| Lens | Confirmed findings | Focus (as shown by its findings) |
|---|---|---|
| `auth` | 2 | Caller identity and verification abuse controls (spec section 7) |
| `data` | 3 | Minimisation, restricted records, memory as non-authority (spec sections 6, 8, 9) |
| `act` | 5 | Prepared actions, confirmation, commit, idempotency and success speech (spec section 8) |
| `safe` | 5 | Safety routing and human handoff (spec section 10) |
| `ops` | 7 | Approvals, kill switches, audit integrity, release controls (spec sections 13, 16) |
| `threats` | 8 | Spec section 14 threat list: gateway limits, WAF logging, CI IAM, knowledge ingestion |

1. **Confirmation.** Each candidate finding went to two independent verifiers. Each one tried to
   refute it and then reproduce it on their own. Only findings that both confirmed are listed:
   30 in total. Candidates that did not survive are not recorded here. Verifiers lowered five
   severities and raised none. SAFE-HANDOFF-01 went from critical to high; DP-01,
   SAFE-HANDOFF-02 and VSP-GW-01 went from high to medium; DP-02 went from medium to low.
2. **Fix waves.**
   * Round 1 addressed all 30 findings, in commits `738dfca` (checkpoint) and `93f3e51`.
   * Round 2 covered the five findings that round 1 did not close, in commits `28efd39`
     (checkpoint) and `a7037a5`.
   * Round 3 covered VSP-KN-01 only, also in `a7037a5`.
3. **Re-verification.** After each wave, an independent verifier did four things:
   * re-ran the finder's and the confirmers' original reproductions on the current tree;
   * checked that the root cause was fixed, not just the symptom;
   * wrote new probes for adjacent variants;
   * checked that the regression tests exist, carry the finding id in their titles and pass.

   The verdict is FIXED, PARTIAL (the original case is fixed but the invariant still fails) or
   REGRESSION (the fix broke something the old code handled).
4. **Mutation checks.** The verifier ran the tagged tests against a scratch copy of the module
   (a vitest alias, or a copied Terraform module) with the fix reverted or weakened. No
   repository file was edited. The check passes when the tagged tests fail on that copy. The records show mutation checks for 9 findings:
   AUTH-ENUM-01, AUTH-OTP-LIMIT-01, DP-02, SAFE-HANDOFF-01, SAFE-HANDOFF-02, VSP-INF-01,
   VSP-INF-02, VSP-KN-01 and VSP-KN-02. For the other 21, the records show re-run reproductions,
   adjacent probes and passing tagged tests, but no mutation check. Those tests have not been
   shown to be load-bearing.

Timings quoted below come from verifier runs on a loaded shared machine. Only their ratios mean
anything.

## Summary

| Confirmed severity | Findings | FIXED (round 1) | FIXED (round 2) | Not fixed: final verdict PARTIAL |
|---|---|---|---|---|
| critical | 0 | 0 | 0 | 0 |
| high | 6 | 6 | 0 | 0 |
| medium | 17 | 14 | 3 (SAFE-HANDOFF-02, OPS-AUD-01, VSP-INF-02) | 0 |
| low | 7 | 5 | 1 (VSP-KN-02) | 1 (VSP-KN-01) |
| **Total** | **30** | **25** | **4** | **1** |

* 29 of the 30 findings ended FIXED: 25 after round 1, and 4 more after round 2
  (SAFE-HANDOFF-02, OPS-AUD-01, VSP-INF-02 and VSP-KN-02, all PARTIAL after round 1).
* **VSP-KN-01 is not fixed.** Round 1 was a REGRESSION and round 2 was PARTIAL. After round 3
  the final verdict is still **PARTIAL**, and the finding stays open. The sanitizer's stated "no
  bare domain outside the allowlist" invariant does not hold for three kinds of input:
  * HTML-entity-encoded invisible, tag and control characters;
  * raw C1 control characters;
  * rows stored by an earlier sanitizer, because the retrieval re-check does not remove
    invisible characters.

  See R-32 to R-41. None of these gaps is a regression; all of them predate `a7037a5`.
* Rows R-01 to R-42 record the residual issues of 21 findings (see
  [Residual risks](#residual-risks)).

## Findings

Unless a path in the Regression tests column starts with `platform/test/`, `infra/` or
`scripts/`, it is relative to `platform/src/`. The Area column gives the file the finding was
reported against. `SPEC-n` refers to specification section n.

| ID | Confirmed severity | Area (module path) | Invariant(s) | What was wrong | Fix | Regression tests | Verification | Residual risk |
|---|---|---|---|---|---|---|---|---|
| AUTH-ENUM-01 | high | `platform/src/identity/verification-service.ts` | AUTH-01, SPEC-7: identical response for zero, one or many matches; no account-existence disclosure at A0 (threat model T-03) | Some throttles fired only for real accounts and set a session risk flag, so a later verification request was refused only for real clients. That difference revealed which people have an account. | Account-specific limits now block the send or the code check silently and record the event only in the account-keyed abuse monitor. Only triggers that apply to every caller alike set session flags. | `identity/verification-service.test.ts`, `identity/enumeration-resistance.integration.test.ts`, `identity/abuse-monitor.test.ts` | FIXED (round 1); mutation check recorded | None open. The round-1 docs follow-up on threat-model T-02 was found corrected in round 2 |
| AUTH-OTP-LIMIT-01 | low | `platform/src/identity/verification-service.ts` | AUTH-01, SPEC-7 OTP abuse controls (attempts per challenge, failures per account per hour) | The per-account failure limit was checked only when a code was sent. After a lockout, the other outstanding challenges still accepted guesses. | A guess slot is reserved atomically before every comparison. Only the latest challenge of a call accepts digits, and a lockout flags the session the same way for every caller. | `identity/verification-service.test.ts`, `identity/enumeration-resistance.integration.test.ts` | FIXED (round 1); mutation check recorded | R-01 to R-03 |
| DP-01 | medium | `platform/src/business/handoff.ts` | DATA-01, SPEC-6, SPEC-8: privacy and safety events use restricted records (data-flow inventory DF-16) | Handoffs for clinical questions, privacy concerns and safety concerns were written as Salesforce Cases that were broadly visible and linked to the subject. | The handoff reason and category now decide the restricted flag, owner queue, priority and subject link. Safety concerns take the safety route. | `business/handoff.test.ts`, `platform/test/journeys/safety-handoff-regressions.test.ts` | FIXED (round 1) | R-18 |
| DP-02 | low | `platform/src/actions/tool-idempotency.ts` | DATA-01, SPEC-7: the name and date-of-birth locator never leaves the verification service | The replay-cache request hash for a verification request was an unkeyed digest. A dictionary search could recover the name and date of birth from it. | The stored request hash is a keyed HMAC. Its pepper is 32 bytes or more and comes from a Secrets Manager reference or a labelled local-fixture reference. No unkeyed digest is written. | `actions/tool-idempotency.test.ts`, `identity/enumeration-resistance.integration.test.ts` | FIXED (round 1); mutation check recorded | R-04 to R-06 |
| DP-03 | low | `platform/src/gateway/tools/intake.ts` | DATA-04, SPEC-9: memory and summaries are not authority | For a repeat caller, the recap read an open request from memory even after the authoritative record had closed or completed it. | The memory entry is only a pointer now. The recap re-reads the support request and speaks only while the authoritative status is still open. | `business/transactions.test.ts`, `platform/test/journeys/transactions.test.ts` | FIXED (round 1) | None recorded |
| ACT-F1 | high | `platform/src/actions/action-service.ts` | ACT-01, SPEC-8: an interruption or changed request invalidates the pending action | Actions left in doubt by a timeout were not invalidated by barge-in or a changed request. A not-found reconciliation could then revive one and commit it. | In-doubt rows carry a durable invalidation request (migration 0102). Reconciliation moves a flagged row to INVALIDATED, and a database guard stops the flag being cleared. | `actions/action-service.invalidation.test.ts`, `platform/test/journeys/transactions.test.ts` | FIXED (round 1) | R-07 |
| ACT-F2 | high | `platform/src/gateway/pipeline.ts` | ACT-02 (a retry creates no duplicate effect), ACT-03 (an ambiguous timeout is reconciled before retry) | An ambiguous timeout on an intake tool came back as retryable and released its idempotency reservation. A retry then created a second support request, Case and workflow. | On an ambiguous timeout, tools that write durable records now return UNKNOWN_OUTCOME and keep the reservation until the operation settles. The business creation key comes from the transport idempotency key. | `gateway/pipeline.transactions.test.ts`, `business/transactions.test.ts`, `platform/test/journeys/transactions.test.ts` | FIXED (round 1) | R-08 |
| ACT-F3 | medium | `platform/src/actions/action-service.ts` | ACT-01, SPEC-8 (commit rechecks authorization and freshness), SPEC-10 (a safety concern revokes pending mutations) | When staff retried after reconciliation, the commit ran without re-authorization, without a risk-flag check and without a confirmation-freshness check. | The retry now checks confirmation freshness and the invalidation flag. It also requires an operator re-authorization against the trusted session, relationships, kill switches and policy, which fails closed. | `actions/action-service.invalidation.test.ts`, `business/transactions.test.ts`, `platform/test/journeys/transactions.test.ts` | FIXED (round 1) | None recorded |
| ACT-F4 | medium | `platform/src/business/services/appointments.ts` | ACT-05, SPEC-8: claim success only from authoritative commit evidence | The success message was built from a re-read after the commit. A stale read could announce the old appointment time as the new one. | Success speech is now bound to the commit receipt. A re-read is used only when its version and evidence hash match the receipt; anything else returns UNKNOWN. | `business/transactions.test.ts`, `platform/test/journeys/transactions.test.ts` | FIXED (round 1) | None recorded |
| ACT-F5 | medium | `platform/src/business/confirmation.ts` | ACT-01, SPEC-8, SPEC-11: present the exact change and its consequences before committing | The confirmation readback left out material changes that the action digest covers: the appointment modality and the billing review reason. | Modality and provider are bound in the prepared change, and the readback must include them. The billing confirmation reads back the reason. Field coverage is pinned. | `business/transactions.test.ts`, `business/wiring.test.ts`, `platform/test/journeys/transactions.test.ts` | FIXED (round 1) | R-09 |
| SAFE-HANDOFF-01 | high (reported critical) | `platform/src/workflows/transfer.ts` | SAFE-03, SAFE-04, SPEC-10: a transfer failure invokes the next staffed route | If the bridge dropped after the caller confirmed the connection, the safety journey stayed CONNECTED. The caller was left on an unanswered attempt, and the tools still reported a connection. | A bridge drop and every new attempt now set the journey back to ROUTING, and reported status comes from the connection timestamp. | `workflows/transfer.test.ts`, `business/handoff.test.ts`, `platform/test/journeys/safety-handoff-regressions.test.ts` | FIXED (round 1); mutation check recorded | None recorded |
| SAFE-HANDOFF-02 | medium | `platform/src/business/handoff.ts`, `platform/src/workflows/transfer.ts` | SAFE-03, SPEC-10: the safety flow must not be disrupted; priority human connection | A human request during a safety route started a competing STANDARD transfer, which kept dialling after the safety responder connected. | Round 1: the safety route supersedes STANDARD journeys, and a human request returns the safety journey. Round 2: superseding is a conditional write retried on conflict, and every STANDARD step yields to an active SAFETY journey. | `workflows/transfer.supersede-race.test.ts`, `workflows/transfer.test.ts`, `business/handoff.test.ts`, `platform/test/journeys/safety-supersede-race.test.ts`, `platform/test/journeys/safety-handoff-regressions.test.ts` | FIXED (round 2; round 1 PARTIAL: a version conflict left a STANDARD journey dialling); mutation checks recorded in both rounds | R-11 to R-14 |
| SAFE-HANDOFF-03 | high | `platform/src/gateway/http/tool-routes.ts` | SAFE-02, SAFE-03, SPEC-12: capacity and cost limits never block the safety or human route | Every call of the tenant shared one rate-limit bucket on the HTTP tool route, so under normal load the safety and human-route tools got 429 and no route. | The pinned catalogue identifies safety and human-route tools before any bucket is touched, and they are never counted. Other tools are limited per call and per integration. | `gateway/http/routes.test.ts`, `gateway/http/tool-rate-limit.test.ts`, `gateway/mcp.test.ts` | FIXED (round 1) | None recorded |
| SAFE-HANDOFF-05 | medium | `platform/src/console-api/plugin.ts` | SAFE-03, SPEC-10: human intervention is a safety signal; revoke pending nonessential mutations | A staff safety escalation from the console was handled as a plain human transfer. Pending mutations were not revoked, and a confirmed change could still commit. | A console safety transfer now calls the safety route with a human-intervention signal. The console also revokes the call's pending actions through the ledger. | `console-api/safety-escalation.test.ts`, `business/handoff.test.ts`, `platform/test/journeys/safety-handoff-regressions.test.ts` | FIXED (round 1) | R-16 |
| SAFE-HANDOFF-07 | medium | `platform/src/gateway/tools/routing.ts` | SAFE-03, SPEC-10, SPEC-13: the time from a validated safety event to the route is measured | Safety routes raised through the tool wrote no safety-event record, no time-to-routing metric and no console safety-event entry. | The handoff service now records the safety incident after the route starts, within a time bound and without blocking the route. Screening no longer records it a second time. | `business/handoff.test.ts`, `platform/test/journeys/safety-handoff-regressions.test.ts` | FIXED (round 1) | R-17 |
| OPS-APPR-01 | high | `platform/src/config/guard.ts` | OPS-04, OPS-06, SPEC-16: reject unapproved models and unknown policy versions (threat model T-15) | Approval records were not bound to the model, policy bundle or approver role they authorize, so the guard accepted an unapproved model and policy. | Each approval record carries a signed subject, checked against the configured model, policy, knowledge, templates and release. Approver roles are checked per scope in the guard and in the deploy gate. | `config/guard.test.ts`, `config/approvals.test.ts`, `scripts/ci/check-release-manifest.test.ts` | FIXED (round 1) | R-19 |
| OPS-KS-01 | medium | `platform/src/ops/kill-switches.ts` | OPS-03, SPEC-13: a separate kill switch for outbound notifications (threat model T-29) | The outbound-notifications kill switch was accepted and audited but never enforced. | Every notification goes through a sender gated by the kill switch, which fails closed when the snapshot cannot be read. Only safety-escalation paging is exempt. | `ops/notification-gate.test.ts` | FIXED (round 1) | R-20 |
| OPS-KS-02 | medium | `platform/src/business/support/support-request-service.ts` | SPEC-13: a kill switch per integration ([RB-KILL-SWITCH](../RUNBOOKS/kill-switch-operations.md)) | The integration kill switch did not stop background Salesforce sync writes. | While WRITES or the integration switch is engaged, the sync consumer and the retry sweep hold messages. They spend no retry budget and do not dead-letter. | `ops/integration-gate.test.ts` | FIXED (round 1) | R-21 |
| OPS-AUD-01 | medium | `infra/terraform/modules/audit/main.tf` | OPS-01, OPS-03, SPEC-13: monitored ingestion gaps, integrity checks, reconciliation of critical actions | Audit integrity checks, ingestion-gap detection and completeness reconciliation never ran, so their alarms could not fire. A Terraform comment said they did. | Round 1: worker loops run audit verification and emit gap, completeness and backlog metrics, and the gap alarm counts missing data as breaching. Round 2: the protected-action metric labels each call from the audit event id that call actually returned. | `audit/monitor.test.ts`, `gateway/pipeline.audit-metric.test.ts`, `infra/terraform/modules/observability/tests/observability.tftest.hcl` | FIXED (round 2; round 1 PARTIAL: the audit label was still hard-coded) | R-22 to R-24 |
| OPS-REL-01 | medium | `platform/src/evaluation/manifest.ts` | OPS-03, SPEC-14, SPEC-16: the release manifest binds test evidence | The release manifest cut test evidence at 128 entries before checking for failures, so a failing report could drop out of the signed manifest. | Blockers are computed over the full evidence list. Truncation keeps non-PASS entries first and is itself a blocker (`TEST_EVIDENCE_TRUNCATED`). | `evaluation/manifest.test.ts` | FIXED (round 1) | R-25 |
| OPS-AUD-02 | medium | `platform/src/audit/sinks/s3-object-lock.ts` | OPS-01: durable independent audit, and its availability | After a lost write response, recovery needed an object read that the audit IAM policy denies. One stream wedged and blocked every consequential action. | A 412 on the batch's deterministic key is now accepted without reading the object. Content checks move to a separate read-only verifier role. | `audit/sinks/s3-iam-model.test.ts`, `infra/terraform/modules/audit/tests/audit.tftest.hcl` | FIXED (round 1) | R-26, R-27 |
| OPS-REL-02 | low | `.github/workflows/release.yml` | OPS-06, SPEC-16: signed release manifest | The release workflow's manifest step called a command that does not exist, with the wrong flags. Its pre-check passed only because a code comment matched. | The step now calls the real manifest command with flags that the CLI supports and validates, and the pre-check is a real dry run. | `evaluation/manifest.test.ts`, `scripts/ci/check-release-manifest.test.ts` | FIXED (round 1) | None recorded |
| VSP-GW-01 | medium | `platform/src/gateway/http/app.ts` | SAFE-02, SAFE-03, OPS-02: safety and human requests need no account authentication and are never throttled | The rate limit on the MCP and tool routes used one bucket for every call of the integration, so it could throttle the safety and human-route tools. | The SAFE-HANDOFF-03 classification now applies on both transports, and one call can no longer use up the integration's budget. | `gateway/mcp.test.ts`, `gateway/http/routes.test.ts`, `gateway/http/tool-rate-limit.test.ts` | FIXED (round 1) | R-15 |
| VSP-GW-03 | medium | `platform/src/gateway/mcp.ts` | SPEC-14 denial of service; OPS-02 per-integration throttling | One MCP JSON-RPC batch could run up to 100 tool executions while the rate limiter counted it once. | Batches over 10 messages are refused. Messages in a batch run one at a time and are metered one by one. | `gateway/mcp.test.ts`, `gateway/http/tool-rate-limit.test.ts` | FIXED (round 1) | None recorded |
| VSP-GW-04 | medium | `platform/src/gateway/pipeline.ts` | OPS-01 (durable audit evidence), AUTH-02, OPS-02 (availability of authorized reads) | Some idempotency keys passed the pipeline but failed the audit schema. The tool-invocation audit was then dropped silently, and protected reads failed as audit-unavailable. | One key grammar (transport plus audit schema) is enforced at the boundary. An audit schema rejection is logged, counted and reported apart from an outage. | `gateway/pipeline.transactions.test.ts`, `platform/test/journeys/transactions.test.ts` | FIXED (round 1) | R-10 |
| VSP-INF-01 | medium | `infra/terraform/modules/ingress/main.tf` | AUTH-06, DATA-01, OPS-03: a bearer session reference never appears in a log line | WAF logging did not redact the bearer session-reference or idempotency-key headers, while a comment and a test claimed it did. | Every bearer, credential and caller-chosen header is redacted by its lowercase name, and the tests assert each header by name. | `infra/terraform/modules/ingress/tests/ingress.tftest.hcl`, `infra/terraform/policy/terraform_test.rego` | FIXED (round 1); mutation check recorded | None recorded |
| VSP-INF-02 | medium | `infra/terraform/modules/iam_ci/main.tf` | OPS-05, SPEC-14: least privilege and workload identity; the README claims no data-plane reads | The CI apply role could rewrite its own inline policy and trust policy. That defeated the advertised "no data-plane reads" and the exact-subject OIDC trust. | Round 1: the permissions boundary stops CI from changing its own identity and denies the listed data-plane reads. Round 2: it also denies table export and cross-account sharing actions, and the claims were narrowed to what is actually denied. | `infra/terraform/modules/iam_ci/tests/iam_ci.tftest.hcl`, `infra/terraform/policy/terraform_test.rego` | FIXED (round 2; round 1 PARTIAL: export and sharing paths still reached data); mutation check recorded | R-28 to R-30 |
| VSP-INF-03 | low | `infra/terraform/modules/iam_ci/main.tf` | SPEC-14: supply-chain and insider threats; deployment only from reviewed plans | The "read-only" CI plan role could overwrite or delete the Terraform state, and any branch could assume it. | The plan role can write only the lock object. Both CI trusts pin the subject to the deploy workflow on `main`. | `infra/terraform/modules/iam_ci/tests/iam_ci.tftest.hcl`, `infra/terraform/policy/terraform_test.rego` | FIXED (round 1) | R-31 |
| VSP-KN-01 | low | `platform/src/knowledge/sanitize.ts`, `platform/src/knowledge/host-literals.ts`, `platform/src/privacy/patterns.ts` | SPEC-14 (malicious URLs, prompt injection through documents), SPEC-9 (sanitize links), OPS-03: "no bare domain outside the allowlist" | The knowledge sanitizer removed bare domains only for a fixed list of TLDs and left IP-literal hosts in place, contrary to its stated invariant. | Round 1: it removes bare domains on any letter TLD, IPv4 and IPv6 literals, and hosts joined by IDNA separators. Round 2: a TLD followed by decoration (dash, underscore, digit, combining mark) is still treated as a domain. Round 3: format and default-ignorable characters are stripped before matching, and text in tag characters quarantines the item. | `knowledge/sanitize.adversarial.test.ts`, `knowledge/sanitize.invisible.test.ts`, `knowledge/host-literals.test.ts`, `knowledge/search.test.ts` | **PARTIAL** (round 3, final). Round 1 REGRESSION: decorated TLDs were no longer removed. Round 2 PARTIAL: invisible format characters split a host. Mutation checks recorded in rounds 2 and 3 | **Open.** R-32 to R-41 |
| VSP-KN-02 | low | `platform/src/knowledge/sanitize.ts` | SPEC-14: denial of service through regex backtracking | The sanitizer's anchor pattern backtracked catastrophically: a 16 KB input blocked the event loop for about 67 s. | Round 1: linear tag pairing, plus an input cap that fails closed. Round 2: the host-literal path end is memoized, which removes a quadratic scan that round 1 introduced. | `knowledge/sanitize.adversarial.test.ts`, `knowledge/markup.test.ts`, `knowledge/host-literals.test.ts` | FIXED (round 2; round 1 PARTIAL: quadratic host-literal scan); mutation check recorded | R-42 |

## Residual risks

Each row is a residual issue recorded in the verification details. "Pre-existing" means the issue
was there before the fix. None of these is mitigated by this review.

| ID | Finding | Residual issue |
|---|---|---|
| R-01 | AUTH-OTP-LIMIT-01 | The guess budget uses a fixed hourly window, so up to twice the budget can be compared around a window boundary. The other limits behave the same way. |
| R-02 | AUTH-OTP-LIMIT-01 | Concurrent submissions on one challenge each reserve a guess slot. An attacker can therefore spend a real person's hourly OTP budget somewhat faster. The secure link and the human route stay available. |
| R-03 | AUTH-OTP-LIMIT-01 | Once the budget is spent, a correct code is answered as incorrect. The identity README documents this. |
| R-04 | DP-02 | The local fixture pepper is committed and is not secret. That is acceptable only because live composition is refused (`LIVE_COMPOSITION_NOT_IMPLEMENTED`) and the production guard never composes fixtures. |
| R-05 | DP-02 | Latent hazard. A future live composition that omits the pepper gives each instance its own random key, so a replay that reaches another instance fails closed as `IDEMPOTENCY_KEY_REUSED`. That refusal is mapped before the safety-route bypass (pre-existing ordering), so a retried safety or human tool call could be refused. The current container always passes the shared pepper. |
| R-06 | DP-02 | Rows and backups written before the change are not re-keyed. Only synthetic data exists. |
| R-07 | ACT-F1 | Narrow race. A barge-in that lands between the commit claim and the version read can leave the row COMMITTING for about 30 s, until the stale-commit reconcile moves it to INVALIDATED. This fails safe but holds the record slot meanwhile. Also cosmetic: the barge-in invalidated-actions count leaves out flagged in-doubt rows. |
| R-08 | ACT-F2 | A retry with a new idempotency key after `UNKNOWN_OUTCOME` still creates a second record. Neither the Talkdesk documents nor the tool guidance tell the caller not to retry an intake with a new key. MCP still advertises `idempotentHint: true` for intake tools (pre-existing). The abort signal is not propagated; late settlement covers that gap. |
| R-09 | ACT-F5 | The template for a committed appointment change states date, time and time zone, but not the visit type. |
| R-10 | VSP-GW-04 | `ToolRequest.schema.json`, `protocol/tools.ts` and the OpenAPI `Idempotency-Key` header still advertise the older, wider key grammar. No infrastructure alarm is defined on `vsp_audit_events_rejected_total`. Keys that reads used to ignore (short, malformed, or starting with `_` or `-`) are now refused. That fails closed, but clients must know about the stricter contract. |
| R-11 | SAFE-HANDOFF-02 | Update prompts have a check-then-act gap: no conditional write sits between the yield-to-safety read and playing the prompt. One STANDARD "next route" prompt can play after its journey was superseded, before the safety connect, and no dial follows. Seen in 1 of 10,000 fuzz seeds. |
| R-12 | SAFE-HANDOFF-02 | Write-ack latency. If a STANDARD dial's pre-dial write committed before the supersede read, the dial can go out after the SAFETY request returns. Seen in 2 of 10,000 seeds. The dial is recorded and rejected as a superseded dial; the vendor offers no cancel operation (TB-07). |
| R-13 | SAFE-HANDOFF-02 | The claim that a failed supersede is "retried until it lands" holds only while the SAFETY journey is ROUTING. If the safety journey connects first, a CONNECTED or HOLDING STANDARD journey whose supersede failed stays active. It dials and prompts nothing, and its next vendor event is rejected and supersedes it. |
| R-14 | SAFE-HANDOFF-02 | If the safety lookup throws inside failover after the failed attempt was saved, the STANDARD journey stays ROUTING with no further retry. Any store error in failover already did this (pre-existing). STANDARD fails closed, and the Studio route remains. |
| R-15 | VSP-GW-01 | The default per-integration ceiling (600 per minute per process) is unchanged. Routine non-safety tools can still get 429 at the spec's planned load. This is a capacity setting (OPS-02, TB-10), not the defect. |
| R-16 | SAFE-HANDOFF-05 | Server-side session resolution relies on the LOCAL FIXTURE interaction lookup. Without a live resolver, only the ledger revocation applies and the session safety flag is not set (`BLOCKED`). |
| R-17 | SAFE-HANDOFF-07 | Every repeated `request_safety_route` call on an already-active journey records another incident (4 incidents for 1 dial in the probe) and adds a near-zero time-to-routing sample, which skews the safety dashboards. The screening path did this before the fix; the tool path now does it too. |
| R-18 | DP-01 | `HumanInput.issueCategory` in `platform/src/gateway/tools/routing.ts` is not narrowed. With the record-placement logic in place, that is harmless. |
| R-19 | OPS-APPR-01 | The container does not pass knowledge, template or image digests to `loadDeployableConfig`. A production configuration therefore stays undeployable (`SUBJECT_UNVERIFIABLE`) until a live composition supplies them. This fails closed. |
| R-20 | OPS-KS-01 | With the switch engaged, the caller still hears the neutral "a link was sent if eligible" answer, and MCP returns SUCCESS, although no link goes to anyone. The proposed human-route answer and its policy-catalogue mapping were not implemented. The verifier found the ops README `BLOCKED` table and RB-KILL-SWITCH stating this. |
| R-21 | OPS-KS-02 | Other background provider reads, such as `actions.reconcile` lookups, ignore INTEGRATION switches. RB-KILL-SWITCH says so. |
| R-22 | OPS-AUD-01 | The critical ingestion-gap alarm (60 s period, one evaluation, missing data breaching) runs on the same cadence as the verification loop. That risks false pages once a metric export path exists; none exists today. |
| R-23 | OPS-AUD-01 | Reconciliation skips a missing commit event whenever any purge watermark is newer than the action. Purge does not run in production today, because `markVerified` has no production caller, and the count-shortfall check still catches deletions. |
| R-24 | OPS-AUD-01 | Replays are counted as extra protected actions (pre-existing double counting). Today the replay-path label change cannot be reached, because consequential tools skip the gateway replay cache. The missing alarm on the audited-accepted-actions ratio is resolved by fix wave 5: `<prefix>-audit-not-recorded-ratio` exists as a Terraform plan only (paging BLOCKED, PRQ-011, PRQ-047). The double counting stays. |
| R-25 | OPS-REL-01 | A live target is blocked whenever the evidence tree has more than 128 entries (47 when verified; each sharded corpus run adds 10). Evidence needs pruning or digest binding before live releases. This fails closed. |
| R-26 | OPS-AUD-02 | `worker.ts` passes the shipper's own sink to the completeness monitor. A live composition must inject a reader with the verifier identity. Otherwise `verifyShipped` gets 403, the loop fails and the alarm fires on missing data. The verifier found this documented as `BLOCKED` in the audit README. |
| R-27 | OPS-AUD-02 | Detecting a foreign or stale object at the batch key (for example, sequence reuse after a database restore) used to be immediate. It now depends on that verifier, and `existingObjectsUnverified` is an in-process counter, not a metric. The verifier found this documented as `BLOCKED` in the audit README. |
| R-28 | VSP-INF-02 | These actions stay allowed for the CI roles: `kms:PutKeyPolicy`, `s3:PutBucketPolicy`, `sqs:SetQueueAttributes`, secret policies that name an account, `rds:ModifyDBCluster` and DynamoDB `UpdateItem` with `ReturnValues`. The Terraform README residual-risk section lists them. |
| R-29 | VSP-INF-02 | Resolved by fix wave 5. The OPA CI-BOUNDARY probes include `s3:PutObjectAcl` and `s3:PutObjectVersionAcl`, on a generic object and on an object in every bucket the boundary names; `test_ci_boundary_object_acls_probed` and `test_ci_boundary_object_acl_exemption_reported` pin both independently of the module's list. Was: the probe set lacked both, and no test independent of the module's own list pinned `s3:PutObjectVersionAcl`. |
| R-30 | VSP-INF-02 | Unverified, because AWS documentation could not be reached offline. DynamoDB Contributor Insights may expose top partition keys. Derived log and trace read channels (metric-filter dimensions, Contributor Insights rules on log groups, log anomaly samples, X-Ray trace retrieval) are outside the denied read list. All IAM results here come from offline evaluation and were not run against AWS. |
| R-31 | VSP-INF-03 | Two prerequisites could not be checked offline: the repository's OIDC subject customization and the trust format of the release role. |
| R-32 | VSP-KN-01 (open) | HTML entities are decoded after NFKC and the stripping of invisible and control characters, and those steps do not run again. So entity-encoded format, default-ignorable, tag and control characters come back into the sanitized text and can split a host, which is then neither removed nor flagged. Entity-encoded NFKC-only look-alike separators and letters survive the same way. This applies to bodies, titles and link text. Salesforce Knowledge bodies are HTML, so such input is realistic. |
| R-33 | VSP-KN-01 (open) | The defence against tag-character smuggling (the `KNOWLEDGE_HIDDEN_TAG_CHARACTERS` quarantine and the injection check on decoded text) is bypassed when the tag characters are entity-encoded. Such an item is accepted with no reason codes and served to the conversational layer. |
| R-34 | VSP-KN-01 (open) | Control-character stripping covers ASCII only. Raw C1 controls (U+0080-009F) survive in sanitized text, search queries and injection normalization. An exhaustive sweep of raw code points found them to be the only raw characters that still split a host. |
| R-35 | VSP-KN-01 (open) | The retrieval re-check does not normalize text or strip invisible characters. Stored rows that contain invisible host splitters, the kind an earlier sanitizer stored, are served, and the re-check drops none of them. Titles are never re-checked against the sanitizer invariants. Re-ingesting the corpus is the only remedy for such rows. At `a7037a5` the knowledge README says the re-check drops rows stored by an older sanitizer; for these rows it does not. |
| R-36 | VSP-KN-01 (open) | The sanitizer is not idempotent on entity input: a second pass removes a host that the first pass left. The property tests claim idempotence. |
| R-37 | VSP-KN-01 (open) | Entities nested more than 30 levels deep survive as literal entity text, so the header's "decodes HTML entities to a fixpoint" claim is not met. A consumer that decodes entities, such as SSML, could rebuild the host. |
| R-38 | VSP-KN-01 (open) | Prose rendering changes. Removing ZWJ, ZWNJ, VS16, Mongolian free variation selectors and tag characters splits emoji sequences, changes Persian and Devanagari shaping and turns emoji into text presentation. Items with subdivision flags are quarantined: a false positive that fails closed. No visible base character is removed, and all 93 approved and adversarial corpus entries come out unchanged. |
| R-39 | VSP-KN-01 (open) | Some forms are outside the invariant's definition and are not listed in the README: percent-encoded separators, single hexadecimal-integer IPv4, and visible blank characters (braille blank, line separator) that split a host. They are treated as residual, not as violations. |
| R-40 | VSP-KN-01 (open) | The knowledge README documents these limitations. Not detected: spelled-out or spaced addresses; decimal-integer and two- or three-part shorthand IPv4; TLD labels that start with `-`, `_` or a digit; look-alike separators that are not IDNA separators; a non-label dash before the dot. Detection is deliberately broad, so dotted identifiers and sentences without a space after the full stop are removed (strip, not quarantine). The injection detector is heuristic. Sanitization has no wall-clock deadline and is bounded by linear patterns and the input cap instead. |
| R-41 | VSP-KN-01 (open) | The suggested next fix from the final verification, not yet done: after every entity decode, re-apply NFKC, the IDNA fold and the invisible and control strips. Extend control stripping to C1. Check tag characters on the entity-decoded text, in both the sanitizer and ingest. Make the retrieval re-check normalize and strip before host matching, flag any remaining format, default-ignorable, tag or C1 character, and cover titles. Add entity-encoded variants to the property generator. The round-3 mutation check shows that the current tests are load-bearing for raw characters, but none covers entity-encoded, C1 or stored-row inputs. |
| R-42 | VSP-KN-02 | The README timings understate a constant factor. A deeply nested entity forces all six sanitizer passes. Combined with repeated markdown openers, a schema-maximum body takes about 0.3-0.6 s in `evaluateKnowledgeItem`, and about 0.8-0.95 s at the 40,000-character cap. Growth stays linear and within the 1.5 s test budget, but the knowledge README's timing figures leave this case out. One memo-boundary mutant survives; a differential check shows it is equivalent. The final VSP-KN-01 verification found no VSP-KN-02 regression. |

## Evidence

* The committed full-run report [`evidence/test-reports/vitest-platform.json`](../../evidence/test-reports/vitest-platform.json)
  shows 3,136 passed and 0 failed. 180 of those tests carry a finding id from this page in their
  title, and all 180 passed.
* The committed OPA report [`evidence/test-reports/opa-terraform.json`](../../evidence/test-reports/opa-terraform.json)
  shows 68 passed. It includes the WAF-logging, CI-boundary, OIDC-subject and state rules that
  the `infra/terraform/policy/terraform_test.rego` comments tag with VSP-INF-01, VSP-INF-02 and
  VSP-INF-03.
* No committed report covers the Terraform `tftest.hcl` files or
  `scripts/ci/check-release-manifest.test.ts`. For those, the only results are the verifiers'
  scratch runs (`terraform test` with mock providers on a scratch copy of the module, and
  `tsx --test`).
* None of this evidence goes beyond LOCAL FIXTURE code with SYNTHETIC data. The result
  vocabulary and run environment are in [`../TEST_EVIDENCE.md`](../TEST_EVIDENCE.md).

## Related

* [Threat model](threat-model.md): rows changed in the fix pass cite these finding ids
* [Permission matrix](permission-matrix.md)
* [Implementation status](../IMPLEMENTATION_STATUS.md)
* [Test evidence](../TEST_EVIDENCE.md)
* [Prerequisites](../PREREQUISITES.md): PRQ-051 independent security assessment and penetration test (`BLOCKED`)
