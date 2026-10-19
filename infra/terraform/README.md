# Infrastructure (Terraform) — plan only

Status: **IMPLEMENTED_OFFLINE**. Nothing in this directory has been applied to, or planned
against, a real AWS account. Every check below ran offline with mock or fake-credential
providers. This is infrastructure code and evidence for review. It does not certify HIPAA
compliance or production readiness. Applying any environment creates billable resources and
requires a scoped approval (OPS-05). Production also requires a release manifest that
permits it (OPS-04).

## Layout

| Path | Content |
|---|---|
| `modules/network` | VPC across >= 3 AZs; public subnets for the ALB and NAT only; private app and data subnets (data has no internet route); gateway endpoints for S3/DynamoDB; interface endpoints for SQS, KMS, Secrets Manager, Logs, CloudWatch, ECR, STS and Step Functions; endpoint policies limited to the workload and audit accounts; KMS-encrypted flow logs |
| `modules/kms` | One CMK per data class / purpose, with rotation. Key policies separate administration from cryptographic use, limit use to named role ARNs (`aws:PrincipalArn`), optionally restrict use by `kms:ViaService`, and never grant `kms:*` or `Principal "*"` |
| `modules/ingress` | Internet-facing ALB, HTTPS-only (TLS13 policy). Path allowlist with a fixed 404 default. Optional ALB JWT validation and an optional supplemental WAF IP allowlist. WAFv2 with AWS managed rule groups and two per-source-IP rate-based rules: one that blocks, outside the tool-caller paths `/mcp` and `/telephony/`, and one that only counts, on them, because the safety and human routes use those paths ([edge rate limiting](#edge-rate-limiting-and-the-safety-routes); `WAF-RATE` policy rule). Sampled requests are off. WAF logs every request header, so `authorization`, `cookie`, `mcp-session-id`, the bearer session reference `x-vsp-session-ref`, the call binding `x-vsp-interaction-id`, `idempotency-key` and the query string are redacted by name (VSP-INF-01; tftest and the `WAF-LOGS` policy rule assert each name). Access logs go to a dedicated bucket. The HTTP->HTTPS redirect listener is off by default |
| `modules/ecs_service` | Fargate cluster plus gateway and worker services. Tasks run by image digest, as non-root uid 10001, with a read-only root FS and capabilities dropped. No public IP, no ECS Exec. Least-privilege task role per service; execution role limited to the image, log groups and listed secrets. Autoscaling keeps a warm minimum. Circuit breaker rolls back failed deployments. Optional regional write fence (explicit IAM Deny) |
| `modules/aurora` | Aurora PostgreSQL 16, Multi-AZ, CMK storage and Performance Insights, IAM DB auth, TLS forced, statement logging off, deletion protection, backups. Optional Aurora Global Database (primary or read-only secondary with no write forwarding) |
| `modules/dynamodb_sessions` | Session table (`pk`, TTL attribute `ttl`): PITR, CMK SSE, deletion protection, optional global-table replica with its own regional CMK |
| `modules/sqs` | Queues with DLQs, redrive and KMS. FIFO where per-aggregate ordering matters. TLS-only, account-restricted queue policies. Alarm on DLQ depth > 0 |
| `modules/step_functions` | STANDARD state machines rendered from `infra/stepfunctions/*.asl.json` with `templatefile()`. Logs never include execution data. CMK encryption. Versions are published and starts go through a `live` alias |
| `modules/audit` | **Audit account** (`aws.audit` provider alias only): Object Lock bucket (mode and days REQUIRED, null rejected), versioning, audit CMK, deny-delete / TLS-only bucket policy, write-only cross-account writer role (PutObject only), separate read-only auditor role, S3 access logs |
| `modules/observability` | KMS-encrypted SNS alarm topic, 11 dashboards (spec section 13 list plus platform), alarms on catalogue metrics (`platform/src/observability/metrics.ts`), ALB metrics and the count-only WAF rate rule. Audit alarms include deferred route-audit depth held for 5 minutes (`vsp_audit_deferred_depth`, Maximum over processes; RB-AUDIT-OUTAGE), dropped deferred events (RB-AUDIT-GAP), and the share of accepted consequential tool calls without a recorded `tool.invoke` audit event (`vsp_protected_actions_total{audit="not_recorded"}` divided by all accepted, threshold 0 percent; RB-AUDIT-GAP). Verification abuse signals (`vsp_verification_abuse_signals_total`) alarm to RB-AUTH-BYPASS. Thresholds are engineering proposals. Alarm text is fixed and contains no PHI |
| `modules/secrets` | Secrets Manager containers with CMK, reader-only resource policies and optional rotation hooks. **No secret values** |
| `modules/iam_ci` | GitHub OIDC provider. Plan/apply roles trust exactly `repo:<owner>/<repo>:environment:<env>[-plan]:job_workflow_ref:<owner>/<repo>/.github/workflows/deploy.yml@refs/heads/main` with aud `sts.amazonaws.com` (needs the repository OIDC subject customization, see prerequisites). Permissions boundary that CI cannot change and that also denies the CI roles any change to their own policies/trust/boundary, role-policy changes on roles without the boundary, trust changes and PassRole on roles CI did not create, assuming in-account roles, identity-provider/user/group/managed-policy changes, the data-plane reads listed in `data_plane_reads` (DynamoDB items, queue messages, secret values, log events and query results, RDS log files, X-Ray traces, SSM parameters, EC2 console/password data, KMS decrypt outside the state), and the export and sharing calls listed in `data_plane_exports` that this stack never makes (DynamoDB table export and table resource policy, RDS snapshot sharing and snapshot export, log export tasks and subscription filters, S3 replication, bucket ACLs and object and object-version ACLs (`s3:PutObjectAcl`, `s3:PutObjectVersionAcl`), legacy SQS `AddPermission`). The `CI-BOUNDARY` policy rule probes every one of them, each on the resource IAM authorizes it on (the bucket for bucket ACLs and replication, an object for object ACLs), so a deny scoped to the wrong resource type is reported; the object ACLs are also probed on an object in every bucket the boundary itself names (Resource or NotResource), so a deny that exempts one bucket's objects, the state's for example, is reported for that bucket. The same list is also in both inline policies. KMS grants are allowed only when an AWS service creates them, and secret policies only with Block Public Policy, for every role under the boundary (VSP-INF-02). The resource policies Terraform manages can still name another account (see residual risk below). Plan reads the state and writes only `<key>.tflock`; apply overwrites the state but deletes only the lock; neither changes the state bucket's configuration (VSP-INF-03). No long-lived keys |
| `modules/budgets` | AWS Budgets alerts (actual and forecasted). **Alerts are not hard caps** |
| `modules/stack` | Composition used by every environment root |
| `envs/{sandbox,staging,production,production-dr}` | Roots: providers (`allowed_account_ids` pinning, audit-account alias), partial S3 backend, tfvars without secrets, plan tests |
| `policy/` | Rego policy over `terraform show -json` (OPA, pinned) + unit tests + SYNTHETIC offline-plan fixtures. Includes a minimal IAM evaluator that probes the rendered CI boundary for self-modification, escalation, data-read, export and sharing paths (`CI-BOUNDARY`), the CI state grants (`CI-STATE`), CI identity changes (`CI-IDENTITY`), pinned GitHub subjects (`IAM`), WAF log redaction (`WAF-LOGS`), and a WAF statement evaluator that refuses a rate-based rule with any action but Count (Block, Captcha, Challenge) that can match a safety or human-route path, a rate-based rule that labels such requests together with a blocking rule on labels, a custom rule group referenced without OverrideAction Count, and rules declared as `rule {}` blocks (`WAF-RATE`) |

## Commands (all offline)

```bash
bash scripts/fetch-tools.sh                    # pinned OPA + Terraform 1.16.4 (SHA256 verified)
bash scripts/terraform-mirror.sh               # hashicorp/aws 6.67.0 linux_amd64 into .tools/tf-mirror
bash scripts/terraform-check.sh                # fmt -check, init -backend=false, validate, terraform test
bash scripts/terraform-policy.sh test          # opa fmt/check --strict + opa test
bash scripts/terraform-policy.sh offline DIR   # fake-credential plans of all envs + policy gate
bash scripts/terraform-policy.sh eval plan.json  # gate on a real plan (deploy workflow)
```

Provider pin: `hashicorp/aws` **6.67.0** (released 2026-09-30). The mirror script checks the
signature on `SHA256SUMS` with gpgv against the HashiCorp Security key
(`C874011F0AB405110D02105534365D9472D7468F`). It then checks the zip SHA256 against both that
file and the value pinned in the script
(`4ce94853264097dd7f4542b3cfd18d2b98b06d23321db45d5e384ea275a57f63`). `.terraform.lock.hcl` files
record the `h1:` hash for linux_amd64 only. Run `terraform providers lock -platform=...`
(registry access needed) to add platforms for other workstations.

`configuration_aliases` modules (`audit`, `stack`) cannot be run through `terraform validate`
on their own (Terraform reports the aliased provider as missing). They are validated by their
own `terraform test` suites, which supply mock aliased providers, and through the environment
roots.

Offline plans (`scripts/terraform-plan-offline.sh`) copy each env into a temporary workspace,
use a local backend and fake credentials, strip `allowed_account_ids`/`assume_role`, and pin
every AWS endpoint and proxy to a dead local port. Nothing is refreshed or validated by AWS.
Computed values stay unknown, so IAM policy *content* that references computed ARNs is verified
by the module `terraform test` suites rather than by OPA. The CI boundary and the CI role
policies are fully known at plan time, so OPA also probes them in the offline plans. A
real-account plan is **NOT RUN**.

## Apply order (performed by CI after approval, never by the coding agent)

1. **Bootstrap (per account, by an administrator):** state bucket (versioned, SSE-KMS, public
   access blocked), the audit-account deploy role owned by the audit account's administrators,
   and the approvals trust key (KMS asymmetric key, owner: security). The first apply of
   `iam_ci` is done by the administrator, and so is every later change to it: the boundary
   denies CI any change to its own roles, the boundary and the OIDC provider, and the
   `CI-IDENTITY` policy rule refuses a CI plan that would change them. State bucket
   versioning is the recovery control for a bad state write; CI cannot change the bucket's
   configuration.
2. `envs/sandbox`, `envs/staging`: independent, one account each.
3. `envs/production`: creates the Aurora Global Database, the session-table DR replica and its
   DR-region CMK, and the audit store (which also trusts the DR worker role).
4. `envs/production-dr`: consumes `terraform output dr_inputs` from step 3.

## Regional recovery and the write fence (spec section 12)

* One write region. The DR stack is **write-fenced by default** (`mutations_enabled = false`).
  Every container gets `VSP_MUTATIONS_ENABLED=false`, and every task role carries an explicit IAM
  Deny on session-table writes, `sqs:SendMessage` and Step Functions start/task-completion.
  The Aurora secondary is read-only and write forwarding is never enabled.
* Turning mutations on in DR requires `failover_change_ref`, a reviewed failover decision
  (validated at the env root and in the stack). External side effects must be reconciled
  before writes reopen. DynamoDB global tables resolve conflicts last-writer-wins, and
  conditional writes are only evaluated against the local replica. That is why a single
  writer is enforced.
* **Proposed** objectives: application recovery within 15 minutes and cross-region RPO no worse
  than 5 minutes. **Neither is measured.** Aurora Global Database and DynamoDB replication lag
  must be measured, and restore and failover drills run, before these can be claimed.
  Asynchronous replication is not zero data loss.
* Safe telephone routing stays in Talkdesk Studio and does not depend on this stack. The
  mechanism for switching the Talkdesk MCP endpoint to the DR ALB is **UNKNOWN** (owner:
  Talkdesk administrator + operations).

## Owner inputs that are deliberately UNKNOWN (plan fails closed until supplied)

| Input | Owner | Where |
|---|---|---|
| Retention per class (app/flow/WAF/ALB/DB/workflow/metrics logs), Aurora backup retention | Security operations + privacy counsel | `owner-decisions.tfvars` per env (reviewed PR) |
| Object Lock mode and retention days for SECURITY_AUDIT | Privacy counsel + security leadership | same |
| Monthly AWS budget per environment | Finance + platform owner | same |
| Task sizing / warm capacity, Aurora instance class (tfvars hold PLACEHOLDERS) | SRE, from load tests | `<env>.tfvars` |
| Hostname + ACM certificate | Platform owner | `TF_VAR_certificate_arn` |
| ALB idle timeout vs Talkdesk MCP Streamable HTTP behaviour (placeholder 120 s) | Talkdesk admin + platform engineering | `ingress.idle_timeout_seconds` |
| Talkdesk egress IPs (supplemental allowlist only) and token issuer for ALB JWT validation | Talkdesk admin / identity owner | `ingress.*` |
| WAF rate limit (ILLUSTRATIVE default 120000 / 5 min / IP, from the spec's 400 req/s load floor; enforced outside `/mcp` and `/telephony/`, only counted on them) | SRE | `ingress.waf_rate_limit_per_5min` |
| ALB access-log delivery principal for the chosen region | Platform engineering (check AWS docs) | `ingress.elb_log_delivery_account_id` |
| Aurora PostgreSQL 16 minor version availability in region (tfvars say `16.6`) | Platform engineering | `aurora_engine_version` |
| Region choice (PROPOSED us-east-1 / us-west-2) vs BAA eligible-service list | Platform owner + privacy counsel | tfvars |
| SNS alarm subscriptions / paging integration | SRE on-call | not configured |
| Value of the `request-hash-pepper` secret (32+ random bytes shared by every gateway instance for the keyed tool-request hash, DP-02); the live composition does not load it yet | Security admin | Secrets Manager (container planned in `modules/stack`, gateway-readable only) |
| OpenTelemetry -> CloudWatch exporter (dashboards and alarms show INSUFFICIENT_DATA until then) | Observability owner | BLOCKED |
| Egress FQDN allowlist (e.g. AWS Network Firewall) in addition to security groups | Security | not in this plan |
| Console access path (not exposed on the public ALB) | Security + operations | not in this plan |

## Edge rate limiting and the safety routes

SAFE-02 and SAFE-03 require that the safety and human routes are never silently cut off, and
ADR-0012 already exempts `request_safety_route` and `request_human_transfer` from every
gateway rate limit and from admission. The edge WAF rate rule used to count every request per
source IP and block it above the limit. That rule could not tell a safety call from any other
call. Talkdesk is the only legitimate caller of the tool paths, and its traffic for every
concurrent call can share one egress IP. A tripped rule would therefore have blocked safety and
human transfers together with all other calls.

Design (fail-safe):

* `rate-limit-per-source-ip` (BLOCK) applies only to requests whose URI path is **not** a
  tool-caller path. A tool-caller path is `/mcp`, `/mcp/...` or `/telephony/...`, matched
  case-sensitively on the path as received (regex `^/(?:mcp(?:/|$)|telephony/)`, no
  transformation; non-capturing groups only, because AWS WAF's regex syntax excludes capturing
  subexpressions). These are the paths the default `mcp` and `telephony` listener rules forward.
  They include the MCP safety and human-route tools and Studio's utterance screening, human
  request and handoff operations. A mis-cased or encoded variant is not a tool-caller path, so
  it keeps the blocking limit. ALB path patterns are case-sensitive too, so a mis-cased variant
  gets the fixed 404; how the ALB matches a percent-encoded path was not verified offline.
* Every service-to-service route (`require_jwt = true`; Talkdesk is its caller) must be a
  tool-caller path. A precondition on the web ACL refuses a plan with any other, so a new
  Talkdesk-facing route (for example a transfer-events webhook, if one is ever routed) cannot
  silently fall under the blocking limit. To add one, extend the regex and the `WAF-RATE` probe
  paths together. Routes Talkdesk does not call (`require_jwt = false`, such as the portal)
  keep the blocking limit.
* `rate-observe-tool-caller-paths` (COUNT) applies the same limit to the tool-caller paths and
  never blocks. Its CloudWatch metric (`<prefix>-rate-observe-tool-paths`) feeds the
  observability alarm `<prefix>-waf-tool-path-rate-observed` (RB-DEPENDENCY-OUTAGE).
* Every request on the tool-caller paths is still authenticated by the gateway. Every non-safety
  tool call is still metered per call and per integration there, and the managed rule groups
  still apply. With `supplemental_allowlist_cidrs` set, every other source is blocked before any
  rate rule, so the allowlisted vendor egress is the only source that reaches these paths.
* The `WAF-RATE` policy rule evaluates each blocking rate-based rule's scope-down statement
  against the safety-route paths (`/mcp`, `/mcp/` and the three Studio safety and human-route
  operations). Every action other than Count is blocking: Captcha and Challenge stop a
  non-browser client such as Talkdesk's MCP client or a Studio HTTP step just as Block does, and
  Allow or a missing or malformed action is refused rather than reasoned about. The rule decides
  a regex match on the untransformed URI path exactly only for a portable pattern: one RE2 (OPA)
  compiles, of printable ASCII, with `(?` only as the non-capturing `(?:`, and with no
  backslash before a letter or digit. In that subset RE2 and AWS WAF's PCRE agree on the fixed
  ASCII probe paths. Any other pattern is undecidable, like every other statement, and counts as
  possibly matching (fail closed). That covers a PCRE lookahead or backreference, which RE2
  rejects and AWS WAF can accept, and a pattern both accept but match differently: under
  `(?i)` RE2 folds U+017F (long s) to `s`, PCRE matching byte-wise does not, so an exclusion
  would hold in OPA only.
* The same rule closes three indirect ways to rate-block the safety paths:
  * A rate-based rule with any action, Count included, can label the requests over its limit
    (`RuleLabels`), and a later rule can block on that label (`LabelMatchStatement`).
    Together they rate-block. The pair is refused whenever the labelling rule can match a
    safety-route path. The gate does not follow label keys or rule priorities.
  * A custom rule group (`aws_wafv2_rule_group`) can hold rate-based rules. Its own
    `rule_json` is checked like the web ACL's, and a web ACL rule that references a custom
    rule group is refused unless its `OverrideAction` is Count. The gate does not tie the
    reference's ARN to a group in the plan, so the reference is refused even when the group
    holds no rate rule.
  * Rules declared as `rule {}` blocks instead of `rule_json` are refused, on a web ACL or a
    rule group, because the gate reads `rule_json` only.
* Tests: the ingress tftest runs `edge_rate_limit_never_blocks_safety_route_paths`,
  `edge_rate_limit_with_supplemental_allowlist` and the `rejects_service_route_*` runs, and
  `policy/terraform_test.rego` has the `test_waf_rate_*` tests.

Residual risk (accepted for engineering, needs SRE and security review):

* Until the Talkdesk egress allowlist is known (`supplemental_allowlist_cidrs` is empty by
  default), a single source can send unlimited requests to `/mcp` and `/telephony/` without the
  edge blocking it. The gateway rejects unauthenticated requests, but each one still costs the
  gateway work (threat T-19). Set the allowlist when the egress inventory exists; the alarm
  above shows when any source exceeds the observed limit.
* The supplemental allowlist rule blocks every source that is not listed, on every path. That
  includes the account portal's calls to `/portal/*`, so the portal backend's egress must also
  be listed when the allowlist is enabled.
* The managed rule groups (for example size limits on request bodies in
  `AWSManagedRulesCommonRuleSet`) can still block a tool-path request, safety calls included.
  They were not evaluated against Talkdesk MCP traffic. Run them in COUNT mode in sandbox first.
* The `WAF-RATE` gate reads the web ACL's `rule_json` from the plan. On the plan that creates
  (or replaces) the supplemental allowlist IP set, `rule_json` is unknown, because it references
  the new IP set's ARN, and the gate cannot evaluate the rate rules at all. That is the
  allowlist configuration intended for production. For that plan the ingress tftest
  (`edge_rate_limit_with_supplemental_allowlist`) is the only check; every later plan has a
  known `rule_json` and is gated again.
* The gate probes five fixed paths. It does not derive them from the listener rules; the
  web ACL precondition above ties new service-to-service routes to the exemption instead.
  The precondition recognises a Talkdesk-facing route by `require_jwt = true`. How Talkdesk
  authenticates webhooks is UNKNOWN (TB-09). A future Talkdesk webhook routed with
  `require_jwt = false` would therefore fall under the blocking per-IP limit without any check
  noticing. Route such a webhook with `require_jwt = true`, or extend the regex and the probe
  paths together.
* The gate does not evaluate AWS managed rule groups. Their rules (see the size limits above,
  and any managed group with rate-based or challenge rules added later) can stop a safety call
  without a `WAF-RATE` finding.
* The portable-regex subset is an engineering judgement of where RE2 and PCRE agree. The
  ingress pattern is inside it, but AWS WAF has not evaluated the rule. That needs a sandbox
  plan and apply (NOT RUN).
* An `AndStatement` or `OrStatement` with fewer than two statements is evaluated as written
  (an empty And always matches). AWS rejects such a statement at apply, so it cannot reach an
  environment, but the gate does not refuse it at plan time.

## Interface contracts with other modules

* **Containers:** `VSP_ENVIRONMENT`, `VSP_MUTATIONS_ENABLED`, `VSP_DEPLOYMENT_ROLE`, `PORT`
  (gateway 8080, worker 8081), `VSP_SESSION_TABLE`, `VSP_DB_WRITER_ENDPOINT`,
  `VSP_DB_READER_ENDPOINT`, `VSP_DB_NAME`, `VSP_DB_IAM_USER=app_runtime` (IAM DB auth; the role
  needs `GRANT rds_iam`), `VSP_SECRET_REFS` (JSON name -> Secrets Manager ARN; values fetched
  at runtime; only the gateway's map has `request-hash-pepper`), `VSP_METRICS_NAMESPACE=VSP`, `VSP_METRICS_LOG_GROUP`. Worker only:
  `VSP_QUEUE_URLS` (outbox topic -> URL), `VSP_STATE_MACHINE_ARNS` (workflow -> `live` alias),
  `VSP_AUDIT_BUCKET`, `VSP_AUDIT_PREFIX`, `VSP_AUDIT_REGION`, `VSP_AUDIT_WRITER_ROLE_ARN`
  (assume, then single-part `PutObject` only).
* **Health:** `GET /health/live` (process) and `GET /health/ready` (ALB target health; must
  report not-ready when the policy bundle, session store or audit sink is unavailable).
* **Entry points:** `node dist/main/server.js` (gateway) and `node dist/worker/main.js` (worker),
  per `service_commands`. These do not exist yet.
* **Queues:** outbox topics `support_request.sync` -> `crm-sync` (FIFO), `workflow.start` /
  `workflow.signal` -> `workflow-events` (FIFO), `audit.ship` -> `audit-ship` (FIFO),
  `notification.send` -> `notifications`, `action.committed` -> `action-events`. Step Functions
  placeholders `system_task_queue_url`, `human_task_queue_url`, `notify_queue_url`,
  `escalation_queue_url`, `recheck_queue_url` map to `wf-*` queues (contract:
  `infra/stepfunctions/README.md`).
* **Metrics:** catalogue names unchanged in namespace `VSP`, with a zero-dimension aggregate per
  metric (e.g. the awsemf exporter's `ZeroAndSingleDimensionRollup`).
  `scripts/ci/check-metric-names.mjs` fails CI if Terraform references a metric that is not
  in the catalogue.

## CI/CD (`.github/workflows`) — NOT RUN here

* `ci.yml` (PR/push, no cloud credentials): install with the frozen lockfile, pinned tools,
  lint, typecheck, unit tests, policy tests + golden gate, schema and ASL drift, CI tooling
  tests, metric drift, workflow lint, terraform check + offline policy gate, gitleaks (full
  history, redacted), `pnpm audit` (blocking on critical; high reported), CycloneDX SBOM +
  license inventory, evidence artifacts.
* `release.yml` (dispatch, main only): build, Trivy scan (fails on fixable HIGH/CRITICAL),
  cosign keyless image signature + SBOM attestation, release manifest from the evaluation
  module (fails clearly if that CLI is missing), keyless manifest signature.
* `deploy.yml` (dispatch only): cosign verification, plan with the read-only role, OPA gate,
  release-manifest gate (`scripts/ci/check-release-manifest.ts`), then apply of the exact
  reviewed plan behind the `<env>` GitHub environment's required reviewers. The gate is
  re-checked before apply.
* Prerequisites: pin all actions to full commit SHAs. Pin the Node base image by digest.
  Create GitHub environments `<env>-plan` and `<env>` (the latter with required reviewers);
  restrict **every** one of them, `<env>-plan` included, to the `main` branch with a
  deployment branch rule (repository administrator). Set the repository OIDC subject
  customization to `include_claim_keys: ["repo", "context", "job_workflow_ref"]` (repository
  administrator, GitHub API); until it is set the CI roles cannot be assumed (fails closed).
  The customization is repository-wide, so the release role's trust (outside this stack,
  owner: platform) must use the same subject format. The audit account must differ from the
  workload account (in-account role assumption is denied). Add CODEOWNERS so audit-module
  and policy changes need security review (owners UNKNOWN). These are NOT verified here.
* Residual risk (VSP-INF-02). IAM in this module does not make "CI cannot obtain data" true.
  For data, it denies only the listed reads, exports and sharing calls. With the apply
  credentials alone, these paths remain:
  - **Resource policies Terraform manages.** `kms:PutKeyPolicy` (the apply role is a key
    administrator), `s3:PutBucketPolicy`, `sqs:SetQueueAttributes` (queue policy) and
    `secretsmanager:PutResourcePolicy` can grant a named external account access to keys,
    objects, queue messages or secret values. Block Public Policy stops only public secret
    policies. `sns:SetTopicAttributes` and `logs:PutResourcePolicy` are also allowed, and what
    they could expose was not assessed. IAM cannot inspect what a policy document grants.
    Closing these paths needs an AWS Organizations data perimeter: resource control policies
    or SCPs that limit resource access to the organization (`aws:PrincipalOrgID` /
    `aws:ResourceOrgID`) for each service in this stack they cover. The AWS organization
    administrator owns this. It is **NOT in place and NOT verified here**.
  - **Roles CI creates (by design).** The apply role can create roles within the boundary
    and deploy code that runs with them: task definitions, state machines, or a role passed
    to a service that copies data. The reviewed `<env>` environment, the release-manifest
    gate and the OPA plan gate control this path, not IAM. An organization SCP that limits
    cross-account trust on CI-created roles needs the AWS organization administrator.
  - **Configuration changes the deploy permissions allow.** For example, the apply role can
    turn off RDS-managed master passwords together with network or security-group changes,
    which can expose a data store. Nothing in this module prevents that.
  - **Item writes that return old values.** `dynamodb:UpdateItem` or `DeleteItem` with
    `ReturnValues` is not denied. It needs the item keys, and CI cannot list them (Scan,
    Query and stream reads are denied).
  - **Limits of the `CI-BOUNDARY` probes.** Each probe is one request: a probe resource
    (a generic object, plus an object in every bucket the boundary names) and a fixed set of
    request keys (region, principal). A deny that holds for these requests but not for some
    other resource or key value passes the gate. For example, a deny excluded by a condition
    on a key the probes do not set, or a resource pattern that names no bucket. The `iam_ci`
    module's own export deny uses `Resource "*"` and the principal condition only, so these
    limits concern a future change to the boundary.
  The effects above were evaluated offline (tftest, OPA evaluator) with AWS IAM semantics.
  They were not run against AWS. In particular, the request keys `kms:GrantIsForAWSResource`
  and `secretsmanager:BlockPublicPolicy` must be confirmed in a real account, including that
  RDS and DynamoDB create their KMS grants with `kms:GrantIsForAWSResource` true. The
  statement that uses them denies the call when its key is absent (fail closed).

## Cost

No cost estimate is given: vendor and AWS rate cards for this account are not available
(owner: finance). Billable components include NAT gateways, the ALB and WAF, Fargate tasks,
Aurora instances (plus global replication), DynamoDB, SQS, Step Functions, KMS keys, CloudWatch
logs, dashboards and alarms, Secrets Manager secrets, interface endpoints and cross-region
transfer.
