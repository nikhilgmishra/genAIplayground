# Phase 2 sandbox configuration and infrastructure plan (execution-order step 5)

Status: **PLAN ONLY**. Nothing in this plan has been applied. No money has been spent, no
call placed, no credential obtained, no external system changed and no PHI accessed. Every
billable, external-access or deployment step below waits for the matching approval request
in `approval-requests.md`. The coding agent cannot approve, and approval records in
`approvals/` are created only by accountable humans (OPS-05).

This plan does not claim HIPAA compliance or production readiness. Phase 2 output, if
approved and executed, would be `VERIFIED_SANDBOX` evidence for the specific tests that
pass — nothing more.

## 1. Scope

In scope (after approvals): replace offline adapters with documented Talkdesk, Salesforce
and IdP sandbox integrations; apply the Talkdesk configuration package in a sandbox tenant;
run contract, Simulator and PSTN tests with **synthetic personas only**; reconcile tenant
configuration against `talkdesk/expected-config.yaml`; pin versions; record evidence.

Out of scope: PHI of any kind (`PHI_PROCESSING` is **not** requested); production or
staging accounts; changes to production numbers, routing or queues; real notifications to
real people; public crisis lines; quota increases with cost commitments; historical
exports; load tests at production scale (Phase 3).

## 2. Environments and accounts

| Environment | Purpose | Owner | Status |
|---|---|---|---|
| AWS sandbox workload account | gateway, worker, data stores, ingress | cloud platform owner | account id UNKNOWN (VQ-AWS-03) |
| AWS sandbox audit account (separately administered) | S3 Object Lock audit evidence | security | UNKNOWN (VQ-AWS-03) |
| CI with OIDC federation | plan/apply via reviewed pipeline; no long-lived keys | cloud platform owner + security | UNKNOWN (VQ-AWS-08, AR-15) |
| Talkdesk sandbox tenant | numbers, Studio, queues, AI Agent Platform, Simulator | Talkdesk admin | UNKNOWN (VQ-TD-44, AR-01) |
| Salesforce sandbox (type that does **not** copy production data) | Case / interaction upsert | Salesforce admin | UNKNOWN (VQ-SF-02, AR-03) |
| Client IdP, provider IdP and workforce SSO test tenants | secure-link verification, console SSO | identity owner | UNKNOWN (VQ-IDP-01, AR-04) |
| Service authorization server | OAuth2 client credentials for Talkdesk clients | identity owner | UNKNOWN (VQ-IDP-07) |
| Region | single write region for sandbox | cloud platform owner | UNKNOWN (VQ-AWS-06) |

## 3. Terraform stacks to apply

Stack: `infra/terraform/envs/sandbox` (composition owned by the infrastructure module;
the directory exists but its composition was not yet published when this plan was
written — the apply list below is stated in terms of the modules present under
`infra/terraform/modules/`). The pinned Terraform binary is `.tools/terraform` (1.16.4).
`registry.terraform.io` is not reachable from the coding environment, so `init`/`plan`
must run in the approved CI environment.

Apply order (dependencies first):

| # | Module | Resources (summary) | Account |
|---|---|---|---|
| 1 | `kms` | customer-managed keys and aliases | workload (+ audit for audit keys) |
| 2 | `audit` | Object Lock evidence bucket, cross-account writer role | audit |
| 3 | `network` | VPC, public/app/data subnets, NAT, gateway + interface endpoints, flow logs | workload |
| 4 | `secrets` | Secrets Manager **containers** only (names in section 6; values added by owners) | workload |
| 5 | `dynamodb_sessions` | session table with conditional writes, TTL attribute | workload |
| 6 | `aurora` | Aurora PostgreSQL cluster (private data subnets) | workload |
| 7 | `sqs` | queues + dead-letter queues | workload |
| 8 | `step_functions` | Standard workflows from `infra/stepfunctions/*.asl.json` | workload |
| 9 | `ecs_service` | ECR, ECS cluster, gateway and worker services, autoscaling | workload |
| 10 | `ingress` | ALB (TLS), WAF web ACL, path-route allowlist, access logs | workload |
| 11 | `observability` | dashboards, alarms (content-free metrics) | workload |
| 12 | `budgets` | AWS budget alerts for the sandbox (alerts are **not** hard caps) | workload |
| 13 | `iam_ci` | CI deploy role trust (OIDC) | workload |

Procedure (operator, after AR-02 and AR-15):

```
terraform -chdir=infra/terraform/envs/sandbox init        # backend config supplied by the owner
terraform -chdir=infra/terraform/envs/sandbox plan -out=sandbox.tfplan
terraform -chdir=infra/terraform/envs/sandbox show -json sandbox.tfplan > plan.json   # attach digest to AR-02 evidence
# review: security + SRE; plan digest recorded as ReleaseManifest.infrastructurePlanDigest
terraform -chdir=infra/terraform/envs/sandbox apply sandbox.tfplan
```

Ingress routes forwarded by the ALB (everything else 404): `/mcp`, `/telephony/v1/*`,
the portal secure-link callback path (gateway owner), and the console API (behind
workforce SSO). ALB idle timeout: module variable `idle_timeout_seconds` (placeholder until
MC-01 measures the Talkdesk client behaviour).

### 3.1 Network and egress

| Direction | Allowed | Control | Status |
|---|---|---|---|
| Internet → ALB | HTTPS only (HTTP redirects), routes above | TLS policy, WAF managed rules + rate rule, path allowlist; Talkdesk egress IP set as a supplemental allowlist only if Talkdesk publishes ranges (VQ-TD-45) | plan |
| ALB → gateway tasks | target group port only | security group from ALB SG | plan |
| Gateway/worker → AWS services | DynamoDB, S3 via gateway endpoints; KMS, Secrets Manager, SQS, Step Functions, CloudWatch, ECR via interface endpoints | `network` module endpoints + endpoint security group | plan |
| Gateway → Aurora | PostgreSQL port in data subnets only | `aurora` client security groups | plan |
| Gateway → vendors (via NAT) | Salesforce sandbox API, IdP test tenants (token/JWKS/OIDC endpoints), Talkdesk API **only if documented** | `ecs_service` vendor HTTPS egress rule restricted to the approved destinations; flow logs | hosts UNKNOWN until owners provide them |
| Anything → analytics, developer tools, consumer AI services, observability vendors | **denied** in Phase 2 (DATA-01); Datadog export only after VQ-OBS-01 | no route / no rule | plan |
| Audit shipper → audit account bucket | S3 Object Lock bucket via cross-account role | bucket policy + KMS key policy | plan |

Stateful services stay in private subnets; no public database or session-store endpoint.
VPC flow logs are enabled by the `network` module. IP allowlists never replace
authentication (spec section 3).

## 4. Services enabled

ECS Fargate, ECR, ALB, AWS WAF, Aurora PostgreSQL, DynamoDB, SQS, Step Functions Standard,
S3 (with Object Lock in the audit account), KMS, Secrets Manager, CloudWatch (logs, metrics,
alarms), VPC endpoints, NAT gateway, CloudTrail, AWS Budgets. Each must be reconciled
against the current HIPAA eligible services reference before any PHI use (VQ-AWS-02); for
this synthetic-only phase the reconciliation is recorded but PHI stays disabled
(`platform/config/sandbox.json` `phi.endpointsEnabled: false`, owner: config module).

## 5. Data: synthetic only

* Records: the SYNTHETIC world in `platform/src/fixtures/synthetic-world.ts` (personas,
  appointments, invoices, claims, onboarding, remittances, delegations). Salesforce sandbox
  and IdP test tenants are seeded only with these synthetic identities by their owners.
* Business systems (scheduling, billing, claims, provider): sandbox API availability is
  UNKNOWN (business-system owners). For each, either (a) the owner supplies a sandbox API
  with synthetic fixtures and commit semantics, or (b) the sandbox gateway keeps the
  labelled local fixture adapter for that system (allowed outside production; OPS-04
  forbids it only in production) and test results for that leg are recorded as
  fixture-backed. `platform/config/sandbox.json` (config module) currently declares these
  adapters `live` with null endpoints, which the configuration guard rejects; the config
  owner records which option applies per system.
* PSTN test calls originate from company test handsets/lines provisioned under AR-07. Their
  numbers are recorded only in the restricted test-asset register, never in the repository.
  The synthetic persona is carried by the script, not by caller ID — caller ID is never
  authentication (AUTH-01). Repository examples use fictional `555-01xx` numbers only.
* Voices: consented internal staff reading scripts, or approved pre-recorded persona audio
  (AR-10). No patients, no real accounts, no therapy content, no public crisis lines.
* Recordings, transcripts and exports produced in the sandbox are treated as restricted QA
  media even though synthetic, retained per AR-11, and never copied into tickets or chat.

## 6. Service identities and secrets (names only; owners create values)

| Identity / secret name | Kind | Consumer | Owner |
|---|---|---|---|
| CI deploy role (OIDC) | IAM role, no secret | CI pipeline | cloud platform owner |
| gateway task role, worker task role | IAM roles | ECS tasks | infra module |
| audit writer role (cross-account) | IAM role | audit shipper | security |
| `talkdesk-sandbox` integration, credential `talkdesk-sandbox-mcp` (channel `mcp_tools`; OAuth2 client, custody copy `vsp-sandbox-talkdesk-mcp-client` if required) | OAuth2 client | Talkdesk AI Agent Platform → `/mcp` | identity owner + Talkdesk admin |
| `talkdesk-sandbox` integration, credential `talkdesk-sandbox-studio` (channel `telephony_control`; OAuth2 client `vsp-sandbox-talkdesk-studio-client`, or static exception hash `vsp-sandbox-talkdesk-studio-bearer-hash` under AR-08) | OAuth2 client | Studio HTTP steps → telephony-control | identity owner + Talkdesk admin |
| `vsp-sandbox-talkdesk-telephony` | secret | gateway → Talkdesk API (only if documented; BLOCKED) | Talkdesk admin |
| `vsp-sandbox-salesforce` | secret | gateway → Salesforce sandbox (integration user) | Salesforce admin |
| `vsp-sandbox-oidc-client-idp`, `vsp-sandbox-oidc-provider-idp` | OIDC client secrets | portal secure-link verification | identity owner |
| `vsp-sandbox-workforce-sso` | OIDC client secret | console | identity owner |
| `vsp-sandbox-identity-directory`, `vsp-sandbox-relationship-directory` | secrets | restricted verification and relationship lookups | identity owner |
| `vsp-sandbox-notifications` | secret | neutral notifications to synthetic test channels only | notification owner |
| `vsp-sandbox-scheduling`, `vsp-sandbox-billing`, `vsp-sandbox-claims`, `vsp-sandbox-provider-system` | secrets | business-system sandbox APIs (if provided) | business-system owners |
| `vsp-sandbox-aurora-runtime` | secret | gateway database role `app_runtime` | infra module / DBA |
| assertion signing key `vsp-sandbox-assertions` | KMS key (not a secret value) | trusted assertion mint/verify | security |

Names match the placeholders in `platform/config/sandbox.json` (config module). No secret
is requested in chat, printed, or committed.

## 7. Talkdesk, Salesforce and IdP sandbox steps

Talkdesk (Talkdesk admin; after AR-01, AR-06, AR-07, AR-13):

1. Confirm tenant identity, plan and entitlements; record in the observation file.
2. Disable tenant-wide automatic recording for the sandbox flow or confirm it can be
   overridden before SF-04 (VQ-TD-07); otherwise stop (BLOCKED).
3. Create the nine queues of `talkdesk/expected-config.yaml` `destinations` (names chosen by
   the admin; the reviewed export later replaces the `TALKDESK_QUEUE_PLACEHOLDER_*` refs
   through the config owner).
4. Build `vsp_main_inbound` per `talkdesk/studio-flow-spec.md`, and the probe flow
   `vsp_authgate_probe` (sandbox only).
5. Create the MCP connection and service identities per `talkdesk/mcp-connection.md`.
6. Configure agents, Skills, guardrail text and limits per `talkdesk/ai-agent-config.yaml`.
7. Assign a sandbox test number to `vsp_main_inbound` (AR-07).
8. Transcribe the observed configuration into a copy of
   `talkdesk/observed-config.template.yaml` and run `node talkdesk/tools/drift-check.mjs`.

Salesforce (Salesforce admin; after AR-03): create the sandbox from a type that copies no
production data; create the dedicated integration user and permission set restricted to the
interaction/Case objects and fields of VQ-SF-04; create external ID fields; inventory
automation (VQ-SF-08); keep duplicate rules; seed only synthetic accounts; issue the
server-to-server credential into `vsp-sandbox-salesforce`.

Identity (identity owner; after AR-04): create OIDC test clients for the client and
provider portals (redirect URIs to the sandbox portal callback), synthetic test users with
MFA, the workforce SSO client and groups for console roles, and the two service OAuth2
clients for Talkdesk.

## 8. Tests that will run (all `NOT_RUN` today)

| Suite | Channel | Tests | Evidence |
|---|---|---|---|
| MCP contract | sandbox HTTPS | MC-01..MC-09, MB-01..MB-05 (`talkdesk/mcp-connection.md`) | gateway audit, ALB/WAF logs |
| Auth Gate | Studio probe + PSTN | AG-01..AG-19 (`talkdesk/auth-gate.md`) | Studio evidence, gateway audit |
| Studio flow | PSTN | SF-T-01..SF-T-41 (`talkdesk/studio-flow-spec.md` §8) | EvaluationResult `pstn_sandbox` |
| Capability gate | Simulator + PSTN | DT-*, BS-*, GX-*, VI-*, EX-* (`talkdesk/capability-gate.md`) | per test |
| Simulator chat/voice | Simulator | `scenarios/` reviewed scenarios (`talkdesk/simulator-and-evaluation-runbook.md`) | EvaluationResult `vendor_sandbox` |
| Salesforce contract | sandbox API | idempotent upsert by external id, duplicate redelivery, outage → internal reference then reconcile | Case/external-id evidence |
| IdP secure link | sandbox OIDC | nonce/audience/expiry, session-swap rejection, expired approval | identity audit |
| Demonstration journeys (spec section 16) | PSTN, synthetic personas | verified client reschedule with conflict; disputed charge → durable review (no refund promise); provider delegated remittance; partner denied unrelated client; unverified caller → human; safety handoff without authentication; caller declines recording; unavailable language → interpreter; repeat caller resumes authorised open issue | EvaluationResult + backend state |
| Failure injections | PSTN + gateway faults | authentication expiry, two concurrent calls same account, interrupted confirmation, duplicate webhooks (only if TB-09 documented), crash after commit, Salesforce outage, failed transfer, audit outage | final system state, not conversation text |

Call counts per suite are planning assumptions in `sandbox-cost-inputs.yaml`
(`callTestPlan`, about 134 planned calls before re-run contingency — an assumption requiring
finance validation, not a commitment).

## 9. Cost estimate method

No prices are stated. Inputs, quantities and formulas are in `sandbox-cost-inputs.yaml`:

```
AWS monthly   = Σ components:  Fargate (tasks × hours × (vCPU × rateVcpuHour + GB × rateMemoryGbHour))
              + ALB (hours × rateAlbHour + LCU-hours × rateLcuHour) + WAF (ACLs, rules, requests)
              + Aurora (instance-hours, storage, I/O, backup) + DynamoDB (requests, storage)
              + SQS (requests) + Step Functions (state transitions) + S3 (storage, requests)
              + KMS (keys, requests) + Secrets Manager (secrets, API calls)
              + CloudWatch (ingest, storage, metrics, alarms) + NAT (hours, GB)
              + VPC endpoints (endpoint-AZ-hours, GB) + public IPv4 (address-hours) + egress (GB)
Talkdesk      = sandbox tenant + test numbers + caller-leg minutes × rateInboundMinute
              + human-leg minutes × rateHumanLegMinute + AI usage units × rateAiUsageUnit
              + Simulator runs × rateSimulatorRun          (AI usage unit and Simulator billing UNKNOWN)
Salesforce    = sandbox licence + integration user licence
Identity      = test tenants/clients (often included; confirm)
Labour        = persona callers + receiving agents + reviewers × internal rate
Estimate      = (AWS monthly × months + Talkdesk + Salesforce + Identity + Labour) × (1 + contingency)
```

Every `rate*` field is `RATE_CARD_REQUIRED`; finance supplies them (VQ-AWS-05, VQ-FIN-01).
Bundled components are counted once (spec section 12). Vendor metering delay means console
spend figures lag; alerts and budgets are not hard caps.

**Call-test budget ceiling:** `TO_BE_APPROVED_BY_FINANCE`. Enforcement: the platform's
budget/admission controls (ops module) stop new nonessential automation when the approved
ceiling is reached, plus an operator stop rule (simulator runbook §9). An active safety
handoff is never disconnected to enforce the ceiling (SAFE-03); finance approves a bounded
safety reserve and escalation owner.

## 10. Rollback plan

Rollback is part of the approved scope of AR-01/AR-02 so that it can run without a new
request. Order:

1. **Stop traffic.** Talkdesk admin re-points the sandbox test number to a static
   human-only flow or unassigns it; disables the AI agent; disables the MCP connection
   (UI paths to be confirmed). Verify a test call reaches a human or a closed message.
2. **Revoke credentials.** Identity owner revokes the two Talkdesk OAuth2 clients and the
   IdP test clients; Salesforce admin deactivates the integration user; owners delete the
   secrets in section 6 (Secrets Manager applies a recovery window; force deletion only with
   security approval); CI role trust removed (`iam_ci`). Confirm the gateway rejects the old
   credentials.
3. **Terraform destroy** (reverse of the apply order, after `plan -destroy` review):
   scale `ecs_service` to zero → `ingress` → `observability`, `budgets` → `step_functions`
   (no running executions) → `sqs` (drained, DLQs inspected) → `aurora` (deletion protection
   lifted by a reviewed change; synthetic data, so final snapshot is the owner's choice) →
   `dynamodb_sessions` → `secrets` → `network` → `kms` (scheduled deletion with the AWS
   waiting period; keys protecting retained audit objects are **not** scheduled) →
   `audit`: **not destroyed** while Object Lock retention is active — compliance-mode
   retention cannot be shortened, governance mode needs special permission (VQ-AWS-09);
   the sandbox audit evidence is retained per AR-11.
   ```
   terraform -chdir=infra/terraform/envs/sandbox plan -destroy -out=destroy.tfplan
   terraform -chdir=infra/terraform/envs/sandbox apply destroy.tfplan
   ```
4. **Talkdesk configuration revert.** Unpublish/restore the previous Studio flow version
   (if versioning exists, VQ-TD-13), remove sandbox queues, variables, agents and guardrail
   text; record the post-rollback observation and run drift-check against the pre-Phase-2
   baseline observation.
5. **Salesforce/IdP clean-up.** Remove synthetic records or refresh the sandbox; remove
   synthetic test users.
6. **Verify spend stopped** after the vendors' metering delay (next billing data refresh);
   record in the rollback evidence.

## 11. Exit criteria for Phase 2

All must hold, each with evidence references in `phase-gates.md`:

1. Approvals AR-01..AR-07, AR-10..AR-13, AR-15 granted and unexpired (AR-08, AR-09, AR-14
   only if their conditions arise).
2. Sandbox stack applied from a reviewed plan whose digest is recorded.
3. `drift-check.mjs` returns `CLEAN` against a reviewed `expected-config.yaml` from which
   all placeholders have been replaced by tenant facts (no `NEW_FACT`, no `UNOBSERVED`).
4. Capability gate rows CG-01..CG-10 each `EVIDENCED` or `FAIL` with the launch consequence
   recorded — none left `UNKNOWN`.
5. A successful synthetic telephone journey end to end, plus the failure paths in §8, with
   `EvaluationResult` records whose hard gates PASS and whose version identity is captured.
6. The independent human route (SF-T-15, SF-T-16) and the safety branch (SF-T-18..SF-T-22)
   PASS with the gateway and AI disabled.
7. Spend within the finance-approved ceiling, reported from vendor usage data.
8. Rollback rehearsed at least once in the sandbox (steps 1–2 and 4) with evidence.
9. Remaining blockers listed with owner and next action; nothing marked PASS without evidence.
