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
| `modules/kms` | One CMK per data class / purpose, with rotation. Key policies separate administration from cryptographic use, limit use to named role ARNs (`aws:PrincipalArn`), optionally restrict use by `kms:ViaService`, and never grant `kms:*` or `Principal "*"`. Administrators get explicit create actions (`kms:CreateAlias`, never `kms:Create*`, which matches `kms:CreateGrant`), so they create grants only for AWS resources (`kms:GrantIsForAWSResource`) |
| `modules/ingress` | Internet-facing ALB, HTTPS-only (TLS13 policy). Path allowlist with a fixed 404 default. Optional ALB JWT validation and an optional supplemental WAF IP allowlist. WAFv2 with AWS managed rule groups and a rate-based rule. Sampled requests are off. WAF logs every request header, so `authorization`, `cookie`, `mcp-session-id`, the bearer session reference `x-vsp-session-ref`, the call binding `x-vsp-interaction-id`, `idempotency-key` and the query string are redacted by name (VSP-INF-01; tftest and the `WAF-LOGS` policy rule assert each name). Access logs go to a dedicated bucket. The HTTP->HTTPS redirect listener is off by default |
| `modules/ecs_service` | Fargate cluster plus gateway and worker services. Tasks run by image digest, as non-root uid 10001, with a read-only root FS and capabilities dropped. No public IP, no ECS Exec. Least-privilege task role per service; execution role limited to the image, log groups and listed secrets. Autoscaling keeps a warm minimum. Circuit breaker rolls back failed deployments. Optional regional write fence (explicit IAM Deny) |
| `modules/aurora` | Aurora PostgreSQL 16, Multi-AZ, CMK storage and Performance Insights, IAM DB auth, TLS forced, statement logging off, deletion protection, backups. Optional Aurora Global Database (primary or read-only secondary with no write forwarding) |
| `modules/dynamodb_sessions` | Session table (`pk`, TTL attribute `ttl`): PITR, CMK SSE, deletion protection, optional global-table replica with its own regional CMK |
| `modules/sqs` | Queues with DLQs, redrive and KMS. FIFO where per-aggregate ordering matters. TLS-only, account-restricted queue policies. Alarm on DLQ depth > 0 |
| `modules/step_functions` | STANDARD state machines rendered from `infra/stepfunctions/*.asl.json` with `templatefile()`. Logs never include execution data. CMK encryption. Versions are published and starts go through a `live` alias |
| `modules/audit` | **Audit account** (`aws.audit` provider alias only): Object Lock bucket (mode and days REQUIRED, null rejected), versioning, audit CMK, deny-delete / TLS-only bucket policy, write-only cross-account writer role (PutObject only), separate read-only auditor role, S3 access logs |
| `modules/observability` | KMS-encrypted SNS alarm topic, 11 dashboards (spec section 13 list plus platform), alarms on catalogue metrics (`platform/src/observability/metrics.ts`) and ALB metrics. Alarm text is fixed and contains no PHI |
| `modules/secrets` | Secrets Manager containers with CMK, reader-only resource policies and optional rotation hooks. **No secret values** |
| `modules/iam_ci` | GitHub OIDC provider. Plan/apply roles trust exactly `repo:<owner>/<repo>:environment:<env>[-plan]:job_workflow_ref:<owner>/<repo>/.github/workflows/deploy.yml@refs/heads/main` with aud `sts.amazonaws.com` (needs the repository OIDC subject customization, see prerequisites). Permissions boundary that CI cannot change and that also denies the CI roles any change to their own policies/trust/boundary, role-policy changes on roles without the boundary, trust changes and PassRole on roles CI did not create, assuming in-account roles, identity-provider/user/group/managed-policy changes, the data-plane reads listed in `data_plane_reads` (DynamoDB items, queue messages, secret values, log events and query results, RDS log files, X-Ray traces, SSM parameters, EC2 console/password data, KMS decrypt outside the state), and the export and sharing calls listed in `data_plane_exports` that this stack never makes (DynamoDB table export and table resource policy, RDS snapshot sharing and snapshot export, log export tasks and subscription filters, S3 replication and ACLs, legacy SQS `AddPermission`). The same list is also in both inline policies. KMS grants are allowed only when an AWS service creates them, and secret policies only with Block Public Policy, for every role under the boundary (VSP-INF-02). The resource policies Terraform manages can still name another account (see residual risk below). Plan reads the state and writes only `<key>.tflock`; apply overwrites the state but deletes only the lock; neither changes the state bucket's configuration (VSP-INF-03). No long-lived keys |
| `modules/budgets` | AWS Budgets alerts (actual and forecasted). **Alerts are not hard caps** |
| `modules/stack` | Composition used by every environment root |
| `envs/{sandbox,staging,production,production-dr}` | Roots: providers (`allowed_account_ids` pinning, audit-account alias), partial S3 backend, tfvars without secrets, plan tests |
| `policy/` | Rego policy over `terraform show -json` (OPA, pinned) + unit tests + SYNTHETIC offline-plan fixtures. Includes a minimal IAM evaluator that probes the rendered CI boundary for self-modification, escalation, data-read, export and sharing paths (`CI-BOUNDARY`), the CI state grants (`CI-STATE`), CI identity changes (`CI-IDENTITY`), pinned GitHub subjects (`IAM`), WAF log redaction (`WAF-LOGS`) and KMS key policies that let an IAM principal create grants not for AWS resources (`KMS-GRANT`) |

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
| WAF rate limit (ILLUSTRATIVE default 120000 / 5 min / IP, from the spec's 400 req/s load floor) | SRE | `ingress.waf_rate_limit_per_5min` |
| ALB access-log delivery principal for the chosen region | Platform engineering (check AWS docs) | `ingress.elb_log_delivery_account_id` |
| Aurora PostgreSQL 16 minor version availability in region (tfvars say `16.6`) | Platform engineering | `aurora_engine_version` |
| Region choice (PROPOSED us-east-1 / us-west-2) vs BAA eligible-service list | Platform owner + privacy counsel | tfvars |
| SNS alarm subscriptions / paging integration | SRE on-call | not configured |
| OpenTelemetry -> CloudWatch exporter (dashboards and alarms show INSUFFICIENT_DATA until then) | Observability owner | BLOCKED |
| Egress FQDN allowlist (e.g. AWS Network Firewall) in addition to security groups | Security | not in this plan |
| Console access path (not exposed on the public ALB) | Security + operations | not in this plan |

## Interface contracts with other modules

* **Containers:** `VSP_ENVIRONMENT`, `VSP_MUTATIONS_ENABLED`, `VSP_DEPLOYMENT_ROLE`, `PORT`
  (gateway 8080, worker 8081), `VSP_SESSION_TABLE`, `VSP_DB_WRITER_ENDPOINT`,
  `VSP_DB_READER_ENDPOINT`, `VSP_DB_NAME`, `VSP_DB_IAM_USER=app_runtime` (IAM DB auth; the role
  needs `GRANT rds_iam`), `VSP_SECRET_REFS` (JSON name -> Secrets Manager ARN; values fetched
  at runtime), `VSP_METRICS_NAMESPACE=VSP`, `VSP_METRICS_LOG_GROUP`. Worker only:
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
