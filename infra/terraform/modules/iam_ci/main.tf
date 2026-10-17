# CI workload identity (spec sections 3, 14, 15): GitHub Actions OIDC federation, no
# long-lived keys. Per account (one account per environment):
#  - plan role: trusted only for repo:<owner>/<repo>:environment:<env>-plan, read-only
#    metadata access plus Terraform state; explicit deny of data-plane reads.
#  - apply role: trusted only for repo:<owner>/<repo>:environment:<env> (a GitHub
#    environment with required reviewers), deploy permissions capped by a permissions
#    boundary that every role created by CI must also carry.
# Bootstrap: the first apply of this module is performed by an account administrator
# (no CI role exists yet); afterwards CI manages it. Nothing here is applied by the agent.

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

  plan_subject  = "repo:${var.github_repository}:environment:${var.github_environment}-plan"
  apply_subject = "repo:${var.github_repository}:environment:${var.github_environment}"

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

  data_plane_reads = [
    "dynamodb:GetItem", "dynamodb:BatchGetItem", "dynamodb:Query", "dynamodb:Scan",
    "dynamodb:PartiQLSelect", "dynamodb:GetRecords", "sqs:ReceiveMessage",
    "secretsmanager:GetSecretValue", "logs:GetLogEvents", "logs:FilterLogEvents",
    "logs:StartQuery", "logs:StartLiveTail", "rds-data:*", "states:GetExecutionHistory",
    "states:DescribeExecution", "kms:Decrypt",
  ]

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
          Sid      = "NoLongLivedCredentials"
          Effect   = "Deny"
          Action   = ["iam:CreateUser", "iam:CreateAccessKey", "iam:CreateLoginProfile", "iam:UpdateLoginProfile", "iam:AttachUserPolicy", "iam:PutUserPolicy"]
          Resource = "*"
        },
        {
          Sid       = "RolesMustCarryThisBoundary"
          Effect    = "Deny"
          Action    = ["iam:CreateRole", "iam:PutRolePermissionsBoundary"]
          Resource  = "*"
          Condition = { StringNotEquals = { "iam:PermissionsBoundary" = local.boundary_arn } }
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

  state_statements = concat(
    [
      {
        Sid      = "TerraformStateObjects"
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
        Resource = ["${var.state_bucket_arn}/${var.state_key_prefix}*"]
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
  name                 = "${var.name_prefix}-gha-plan"
  description          = "GitHub Actions terraform plan (read-only)"
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
    Statement = concat(local.state_statements, [local.data_plane_deny, local.object_read_deny])
  })
}

resource "aws_iam_role" "apply" {
  name                 = "${var.name_prefix}-gha-apply"
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
      [local.data_plane_deny, local.object_read_deny],
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
