# CI workload identity (spec sections 3, 14, 15): GitHub Actions OIDC federation, no
# long-lived keys. Per account (one account per environment):
#  - plan role: trusted only for the subject
#      repo:<owner>/<repo>:environment:<env>-plan:job_workflow_ref:<owner>/<repo>/<deploy workflow>@<deploy ref>
#    i.e. the <env>-plan GitHub environment AND deploy.yml on main (a job on any other
#    branch or in any other workflow gets a different subject). Read-only metadata access,
#    read of the Terraform state, write/delete of the state LOCK object only (VSP-INF-03).
#  - apply role: same pinning for environment <env> (a GitHub environment with required
#    reviewers); deploy permissions capped by a permissions boundary that every role
#    created by CI must also carry. It overwrites the state but deletes only the lock.
# The boundary (immutable to CI) also denies the CI roles: any change to their own
# policies, trust, boundary or settings; role-policy changes on roles without the
# boundary; trust/setting changes and PassRole on roles CI did not create; assuming
# in-account roles; identity-provider, user, group and managed-policy changes; and
# data-plane reads (VSP-INF-02).
# Subject pinning requires the repository's OIDC subject claim customization
# (include_claim_keys = ["repo", "context", "job_workflow_ref"]) set by a repository
# administrator; until it is set the roles cannot be assumed (fails closed).
# Bootstrap and every later change to this module: applied by an account administrator,
# never by CI (CI cannot modify its own identity). Nothing here is applied by the agent.

variable "name_prefix" {
  description = "Opaque resource name prefix (no PHI)."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,24}$", var.name_prefix))
    error_message = "name_prefix must be 3-25 chars of lowercase letters, digits and hyphens."
  }
}

variable "account_id" {
  description = "AWS account of this environment."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^[0-9]{12}$", var.account_id))
    error_message = "account_id must be a 12-digit AWS account id."
  }
}

variable "partition" {
  description = "AWS partition."
  type        = string
  default     = "aws"
}

variable "allowed_regions" {
  description = "Regions CI may act in (primary and, for production, the DR region)."
  type        = list(string)
  nullable    = false

  validation {
    condition     = length(var.allowed_regions) > 0 && alltrue([for r in var.allowed_regions : can(regex("^us-[a-z]+-[0-9]$", r))])
    error_message = "allowed_regions must be non-empty US regions."
  }
}

variable "github_repository" {
  description = "GitHub repository allowed to federate, as owner/name."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.github_repository))
    error_message = "github_repository must be owner/name with no wildcards."
  }
}

variable "github_environment" {
  description = "GitHub environment for apply (required reviewers configured in GitHub). The plan role trusts <github_environment>-plan."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,30}$", var.github_environment))
    error_message = "github_environment must be a short lowercase name with no wildcards."
  }
}

variable "github_deploy_workflow" {
  description = "Workflow file (repository-relative) that alone may assume the CI roles; part of the pinned OIDC subject (job_workflow_ref)."
  type        = string
  default     = ".github/workflows/deploy.yml"
  nullable    = false

  validation {
    condition     = can(regex("^\\.github/workflows/[A-Za-z0-9_-]+\\.ya?ml$", var.github_deploy_workflow))
    error_message = "github_deploy_workflow must be a file directly under .github/workflows/ (no wildcards or path traversal)."
  }
}

variable "github_deploy_ref" {
  description = "Git ref the deploy workflow must run from; part of the pinned OIDC subject (job_workflow_ref)."
  type        = string
  default     = "refs/heads/main"
  nullable    = false

  validation {
    condition     = can(regex("^refs/heads/[A-Za-z0-9._/-]+$", var.github_deploy_ref)) && !strcontains(var.github_deploy_ref, "..")
    error_message = "github_deploy_ref must be one exact branch ref (refs/heads/<name>), no wildcards."
  }
}

variable "create_oidc_provider" {
  description = "Create the account's GitHub OIDC provider (false if it already exists; then pass oidc_provider_arn)."
  type        = bool
  default     = true
}

variable "oidc_provider_arn" {
  description = "Existing GitHub OIDC provider ARN when create_oidc_provider = false."
  type        = string
  default     = null
}

variable "state_bucket_arn" {
  description = "Terraform state bucket (bootstrap prerequisite, created by the platform owner)."
  type        = string
  nullable    = false
}

variable "state_key_prefix" {
  description = "State object key prefix for this stack."
  type        = string
  nullable    = false
}

variable "state_kms_key_arn" {
  description = "CMK encrypting the state bucket (null if SSE-S3)."
  type        = string
  default     = null
}

variable "deny_destructive_actions" {
  description = "Deny deletion of keys, databases, tables, buckets and log groups to CI (true for production)."
  type        = bool
  default     = true
}

variable "tags" {
  description = "Tags applied to every resource (no PHI)."
  type        = map(string)
  default     = {}
}

locals {
  oidc_host         = "token.actions.githubusercontent.com"
  oidc_provider_arn = var.create_oidc_provider ? aws_iam_openid_connect_provider.github[0].arn : var.oidc_provider_arn
  boundary_name     = "${var.name_prefix}-ci-boundary"
  boundary_arn      = "arn:${var.partition}:iam::${var.account_id}:policy/${local.boundary_name}"

  # Customized GitHub subject (repo, context, job_workflow_ref): environment AND workflow@ref.
  workflow_ref  = "${var.github_repository}/${var.github_deploy_workflow}@${var.github_deploy_ref}"
  plan_subject  = "repo:${var.github_repository}:environment:${var.github_environment}-plan:job_workflow_ref:${local.workflow_ref}"
  apply_subject = "repo:${var.github_repository}:environment:${var.github_environment}:job_workflow_ref:${local.workflow_ref}"

  plan_role_name  = "${var.name_prefix}-gha-plan"
  apply_role_name = "${var.name_prefix}-gha-apply"
  ci_role_arns = [
    "arn:${var.partition}:iam::${var.account_id}:role/${local.plan_role_name}",
    "arn:${var.partition}:iam::${var.account_id}:role/${local.apply_role_name}",
  ]
  # Every role CI creates is named "<name_prefix>-..." (ecs_service, network, step_functions).
  ci_created_roles = "arn:${var.partition}:iam::${var.account_id}:role/${var.name_prefix}-*"

  role_policy_changes = ["iam:AttachRolePolicy", "iam:DetachRolePolicy", "iam:PutRolePolicy", "iam:DeleteRolePolicy"]
  role_setting_changes = [
    "iam:UpdateAssumeRolePolicy", "iam:UpdateRole", "iam:UpdateRoleDescription", "iam:DeleteRole", "iam:TagRole",
    "iam:UntagRole", "iam:PassRole",
  ]

  deploy_services = [
    "ec2:*", "ecs:*", "ecr:*", "elasticloadbalancing:*", "wafv2:*", "rds:*", "dynamodb:*", "sqs:*",
    "states:*", "s3:*", "kms:*", "secretsmanager:*", "logs:*", "cloudwatch:*", "sns:*",
    "application-autoscaling:*", "budgets:*", "acm:DescribeCertificate", "acm:ListCertificates",
    "acm:GetCertificate", "xray:*", "tag:GetResources", "sts:GetCallerIdentity", "iam:*",
  ]

  # Runtime actions that roles created by CI (task roles) legitimately need; the CI
  # apply role also needs sts:AssumeRole for the audit-account provider.
  runtime_actions = ["rds-db:connect", "sts:AssumeRole", "sts:TagSession"]

  global_actions = ["iam:*", "sts:*", "budgets:*", "organizations:Describe*", "support:*"]

  # Reads that return data rather than configuration, for the services in this stack
  # (ReadOnlyAccess grants all of them). Denied to the CI roles.
  data_plane_reads = [
    "dynamodb:GetItem", "dynamodb:BatchGetItem", "dynamodb:Query", "dynamodb:Scan",
    "dynamodb:PartiQLSelect", "dynamodb:GetRecords", "sqs:ReceiveMessage",
    "secretsmanager:GetSecretValue", "logs:GetLogEvents", "logs:FilterLogEvents",
    "logs:StartQuery", "logs:StartLiveTail", "logs:GetLogRecord", "logs:GetQueryResults", "logs:Unmask",
    "rds-data:*", "rds:DownloadDBLogFilePortion", "rds:DownloadCompleteDBLogFile",
    "states:GetExecutionHistory", "states:DescribeExecution", "xray:BatchGetTraces",
    "ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath",
    "ec2:GetPasswordData", "ec2:GetConsoleOutput", "ec2:GetConsoleScreenshot", "kms:Decrypt",
  ]

  # Applies only to the CI roles; the state-object decryption exception mirrors data_plane_deny.
  ci_data_plane_condition = merge(
    { ArnEquals = { "aws:PrincipalArn" = local.ci_role_arns } },
    var.state_kms_key_arn == null ? {} : {
      StringNotLike = { "kms:EncryptionContext:aws:s3:arn" = "${var.state_bucket_arn}/${var.state_key_prefix}*" }
    },
  )

  destructive = [
    "kms:ScheduleKeyDeletion", "kms:DisableKey", "rds:DeleteDBCluster", "rds:DeleteDBInstance",
    "rds:DeleteGlobalCluster", "dynamodb:DeleteTable", "s3:DeleteBucket", "logs:DeleteLogGroup",
    "secretsmanager:DeleteSecret", "ecr:DeleteRepository",
  ]

  boundary_policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(
      [
        {
          Sid      = "MaximumServiceSurface"
          Effect   = "Allow"
          Action   = concat(local.deploy_services, local.runtime_actions)
          Resource = "*"
        },
        {
          Sid       = "OnlyApprovedRegions"
          Effect    = "Deny"
          NotAction = local.global_actions
          Resource  = "*"
          Condition = { StringNotEquals = { "aws:RequestedRegion" = var.allowed_regions } }
        },
        {
          Sid    = "NoLongLivedCredentials"
          Effect = "Deny"
          Action = [
            "iam:CreateUser", "iam:CreateAccessKey", "iam:CreateLoginProfile", "iam:UpdateLoginProfile", "iam:AttachUserPolicy", "iam:PutUserPolicy",
            "iam:UpdateAccessKey", "iam:DetachUserPolicy", "iam:DeleteUserPolicy", "iam:PutUserPermissionsBoundary", "iam:DeleteUserPermissionsBoundary",
            "iam:UpdateUser", "iam:AddUserToGroup", "iam:CreateGroup", "iam:AttachGroupPolicy", "iam:PutGroupPolicy", "iam:DetachGroupPolicy",
            "iam:DeleteGroupPolicy", "iam:UpdateGroup", "iam:CreateServiceSpecificCredential", "iam:ResetServiceSpecificCredential",
            "iam:UpdateServiceSpecificCredential", "iam:UploadSSHPublicKey", "iam:UpdateSSHPublicKey", "iam:UploadSigningCertificate",
            "iam:UpdateSigningCertificate", "iam:CreateVirtualMFADevice", "iam:EnableMFADevice", "iam:DeactivateMFADevice", "iam:ResyncMFADevice",
          ]
          Resource = "*"
        },
        {
          # The target role must carry this boundary: covers creation and every role-policy change,
          # so a pre-existing role without the boundary cannot be widened (VSP-INF-02).
          Sid       = "RolesMustCarryThisBoundary"
          Effect    = "Deny"
          Action    = concat(["iam:CreateRole", "iam:PutRolePermissionsBoundary"], local.role_policy_changes)
          Resource  = "*"
          Condition = { StringNotEquals = { "iam:PermissionsBoundary" = local.boundary_arn } }
        },
        {
          # CI never changes its own identity: policies, trust, boundary, settings, or passing itself to a service.
          Sid      = "CiIdentityIsImmutableToCi"
          Effect   = "Deny"
          Action   = concat(local.role_policy_changes, local.role_setting_changes, ["iam:PutRolePermissionsBoundary", "iam:DeleteRolePermissionsBoundary"])
          Resource = local.ci_role_arns
        },
        {
          # Trust, settings and PassRole only for roles CI creates (iam:PermissionsBoundary is not
          # available for these actions, so the scope is the stack's role-name prefix).
          Sid         = "OnlyRolesCreatedByCiCanBeChangedOrPassed"
          Effect      = "Deny"
          Action      = local.role_setting_changes
          NotResource = [local.ci_created_roles]
        },
        {
          # The audit-account role is cross-account; no CI or CI-created role assumes an in-account
          # role (a pre-existing role that trusts the account root would otherwise be reachable).
          Sid      = "NoInAccountRoleAssumption"
          Effect   = "Deny"
          Action   = ["sts:AssumeRole"]
          Resource = ["arn:${var.partition}:iam::${var.account_id}:role/*"]
        },
        {
          Sid    = "NoIdentityProviderChanges"
          Effect = "Deny"
          Action = [
            "iam:CreateOpenIDConnectProvider", "iam:UpdateOpenIDConnectProviderThumbprint", "iam:AddClientIDToOpenIDConnectProvider",
            "iam:RemoveClientIDFromOpenIDConnectProvider", "iam:TagOpenIDConnectProvider", "iam:UntagOpenIDConnectProvider",
            "iam:CreateSAMLProvider", "iam:UpdateSAMLProvider", "iam:DeleteSAMLProvider",
          ]
          Resource = "*"
        },
        {
          # CI uses inline role policies only; a managed-policy version could widen a pre-existing principal.
          Sid      = "NoManagedPolicyChanges"
          Effect   = "Deny"
          Action   = ["iam:CreatePolicy", "iam:CreatePolicyVersion", "iam:DeletePolicy", "iam:DeletePolicyVersion", "iam:SetDefaultPolicyVersion", "iam:TagPolicy", "iam:UntagPolicy"]
          Resource = "*"
        },
        {
          # The data-plane deny for the CI roles sits here, where CI cannot remove it (it also stays
          # in their inline policies). Roles CI creates are not affected (task roles read data).
          Sid       = "NoDataPlaneReadsForCi"
          Effect    = "Deny"
          Action    = local.data_plane_reads
          Resource  = "*"
          Condition = local.ci_data_plane_condition
        },
        {
          Sid      = "BoundaryIsImmutableToCi"
          Effect   = "Deny"
          Action   = ["iam:DeleteRolePermissionsBoundary", "iam:CreatePolicyVersion", "iam:DeletePolicy", "iam:DeletePolicyVersion", "iam:SetDefaultPolicyVersion"]
          Resource = [local.boundary_arn, "arn:${var.partition}:iam::${var.account_id}:role/*"]
        },
        {
          Sid      = "NoOrganizationOrAccountChanges"
          Effect   = "Deny"
          Action   = ["organizations:*", "account:*", "iam:DeleteOpenIDConnectProvider"]
          Resource = "*"
        },
      ],
      [for st in [{
        Sid      = "NoDestructiveActions"
        Effect   = "Deny"
        Action   = local.destructive
        Resource = "*"
      }] : st if var.deny_destructive_actions],
    )
  })

  state_objects = "${var.state_bucket_arn}/${var.state_key_prefix}*"
  # With use_lockfile = true, terraform writes and removes "<key>.tflock" next to the state.
  state_locks = "${var.state_bucket_arn}/${var.state_key_prefix}*.tflock"

  # Shared by both roles: read state, write/remove the lock, list the prefix, use the state CMK.
  state_statements = concat(
    [
      {
        Sid      = "TerraformStateRead"
        Effect   = "Allow"
        Action   = ["s3:GetObject"]
        Resource = [local.state_objects]
      },
      {
        Sid      = "TerraformStateLock"
        Effect   = "Allow"
        Action   = ["s3:PutObject", "s3:DeleteObject"]
        Resource = [local.state_locks]
      },
      {
        Sid       = "TerraformStateListing"
        Effect    = "Allow"
        Action    = ["s3:ListBucket"]
        Resource  = [var.state_bucket_arn]
        Condition = { StringLike = { "s3:prefix" = ["${var.state_key_prefix}*"] } }
      },
    ],
    [for st in [{
      Sid      = "TerraformStateKey"
      Effect   = "Allow"
      Action   = ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey"]
      Resource = [coalesce(var.state_kms_key_arn, "arn:${var.partition}:kms:*:${var.account_id}:key/none")]
    }] : st if var.state_kms_key_arn != null],
  )

  # Apply also writes (overwrites) the state; it never deletes it (VSP-INF-03).
  apply_state_write = {
    Sid      = "TerraformStateWrite"
    Effect   = "Allow"
    Action   = ["s3:PutObject"]
    Resource = [local.state_objects]
  }

  # DeployServices grants s3:* (no S3 object is managed here), so apply needs an explicit deny:
  # it may delete only the lock. Inline denies are durable now that CI cannot rewrite its policies.
  apply_state_delete_deny = {
    Sid         = "ApplyNeverDeletesState"
    Effect      = "Deny"
    Action      = ["s3:DeleteObject", "s3:DeleteObjectVersion", "s3:BypassGovernanceRetention", "s3:PutObjectRetention", "s3:PutObjectLegalHold"]
    NotResource = [local.state_locks]
  }

  # The state bucket is a bootstrap prerequisite owned by the platform owner (versioning is its
  # recovery control): CI never changes its configuration, policy, versioning or lifecycle.
  state_bucket_guard = {
    Sid    = "StateBucketIsNotManagedByCi"
    Effect = "Deny"
    Action = [
      "s3:PutBucket*", "s3:DeleteBucket*", "s3:PutLifecycleConfiguration", "s3:PutReplicationConfiguration",
      "s3:PutEncryptionConfiguration", "s3:PutObjectLockConfiguration", "s3:PutAccelerateConfiguration",
    ]
    Resource = [var.state_bucket_arn]
  }

  # terraform plan never saves state: every object but the lock stays read-only for the plan role.
  plan_state_write_deny = {
    Sid    = "PlanNeverWritesState"
    Effect = "Deny"
    Action = [
      "s3:PutObject", "s3:PutObjectAcl", "s3:PutObjectTagging", "s3:PutObjectRetention", "s3:PutObjectLegalHold",
      "s3:DeleteObject", "s3:DeleteObjectVersion", "s3:DeleteObjectTagging", "s3:RestoreObject", "s3:BypassGovernanceRetention",
    ]
    NotResource = [local.state_locks]
  }

  # kms:Decrypt stays denied except for the state objects' S3 encryption context.
  data_plane_deny = merge(
    {
      Sid      = "NoDataPlaneReads"
      Effect   = "Deny"
      Action   = local.data_plane_reads
      Resource = "*"
    },
    var.state_kms_key_arn == null ? {} : {
      Condition = { StringNotLike = { "kms:EncryptionContext:aws:s3:arn" = "${var.state_bucket_arn}/${var.state_key_prefix}*" } }
    },
  )

  object_read_deny = {
    Sid         = "NoObjectReadsOutsideState"
    Effect      = "Deny"
    Action      = ["s3:GetObject", "s3:GetObjectVersion"]
    NotResource = ["${var.state_bucket_arn}/${var.state_key_prefix}*"]
  }

  trust = {
    for k, subject in { plan = local.plan_subject, apply = local.apply_subject } : k => jsonencode({
      Version = "2012-10-17"
      Statement = [{
        Sid       = "GitHubActionsEnvironmentOnly"
        Effect    = "Allow"
        Principal = { Federated = local.oidc_provider_arn }
        Action    = "sts:AssumeRoleWithWebIdentity"
        Condition = {
          StringEquals = {
            "${local.oidc_host}:aud" = "sts.amazonaws.com"
            "${local.oidc_host}:sub" = subject
          }
        }
      }]
    })
  }
}

resource "terraform_data" "oidc_guard" {
  input = var.create_oidc_provider

  lifecycle {
    precondition {
      condition     = var.create_oidc_provider || var.oidc_provider_arn != null
      error_message = "oidc_provider_arn is required when create_oidc_provider = false."
    }
  }
}

# AWS validates GitHub's OIDC endpoint through its own trusted CA library, so no
# thumbprint is pinned here (a stale thumbprint would be worse than none).
resource "aws_iam_openid_connect_provider" "github" {
  count = var.create_oidc_provider ? 1 : 0

  url            = "https://${local.oidc_host}"
  client_id_list = ["sts.amazonaws.com"]

  tags = var.tags
}

resource "aws_iam_policy" "boundary" {
  name        = local.boundary_name
  description = "Maximum permissions for CI deploy roles and every role CI creates"
  policy      = local.boundary_policy

  tags = var.tags
}

resource "aws_iam_role" "plan" {
  name                 = local.plan_role_name
  description          = "GitHub Actions terraform plan (read-only; writes only the state lock)"
  assume_role_policy   = local.trust["plan"]
  permissions_boundary = aws_iam_policy.boundary.arn
  max_session_duration = 3600

  tags = var.tags
}

resource "aws_iam_role_policy_attachment" "plan_readonly" {
  role       = aws_iam_role.plan.name
  policy_arn = "arn:${var.partition}:iam::aws:policy/ReadOnlyAccess"
}

resource "aws_iam_role_policy" "plan" {
  name = "state-and-data-plane-deny"
  role = aws_iam_role.plan.id
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = concat(local.state_statements, [local.data_plane_deny, local.object_read_deny, local.plan_state_write_deny, local.state_bucket_guard])
  })
}

resource "aws_iam_role" "apply" {
  name                 = local.apply_role_name
  description          = "GitHub Actions terraform apply (environment with required reviewers)"
  assume_role_policy   = local.trust["apply"]
  permissions_boundary = aws_iam_policy.boundary.arn
  max_session_duration = 3600

  tags = var.tags
}

resource "aws_iam_role_policy" "apply" {
  name = "deploy-within-boundary"
  role = aws_iam_role.apply.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(
      [{
        Sid      = "DeployServices"
        Effect   = "Allow"
        Action   = concat(local.deploy_services, ["sts:AssumeRole", "sts:TagSession"])
        Resource = "*"
      }],
      local.state_statements,
      [local.apply_state_write, local.data_plane_deny, local.object_read_deny, local.apply_state_delete_deny, local.state_bucket_guard],
    )
  })
}

output "oidc_provider_arn" {
  description = "GitHub OIDC provider ARN."
  value       = local.oidc_provider_arn
}

output "plan_role_arn" {
  description = "Role for terraform plan jobs (GitHub environment <env>-plan)."
  value       = aws_iam_role.plan.arn
}

output "apply_role_arn" {
  description = "Role for terraform apply jobs (GitHub environment <env> with required reviewers)."
  value       = aws_iam_role.apply.arn
}

output "permissions_boundary_arn" {
  description = "Boundary every CI-created role must carry."
  value       = local.boundary_arn
}

output "subjects" {
  description = "Exact OIDC subjects trusted."
  value       = { plan = local.plan_subject, apply = local.apply_subject }
}
