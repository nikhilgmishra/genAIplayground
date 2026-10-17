variable "name_prefix" {
  description = "Opaque resource name prefix (no PHI, no customer identifiers), e.g. vsp-sandbox."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,24}$", var.name_prefix))
    error_message = "name_prefix must be 3-25 chars of lowercase letters, digits and hyphens."
  }
}

variable "account_id" {
  description = "AWS account that owns the keys."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^[0-9]{12}$", var.account_id))
    error_message = "account_id must be a 12-digit AWS account id."
  }
}

variable "region" {
  description = "AWS region of the keys (US regions only)."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^us-[a-z]+-[0-9]$", var.region))
    error_message = "region must be a US commercial region such as us-east-1."
  }
}

variable "partition" {
  description = "AWS partition."
  type        = string
  default     = "aws"
}

variable "key_admin_role_arns" {
  description = "Roles that administer (but cannot use for crypto) every key. Must include the Terraform deploy role so PutKeyPolicy passes the lockout safety check."
  type        = list(string)
  nullable    = false

  validation {
    condition     = length(var.key_admin_role_arns) > 0 && alltrue([for a in var.key_admin_role_arns : can(regex("^arn:aws[a-z-]*:iam::[0-9]{12}:role/", a))])
    error_message = "key_admin_role_arns must be a non-empty list of IAM role ARNs."
  }
}

variable "keys" {
  description = <<-EOT
    Customer-managed keys keyed by short opaque purpose (e.g. sessions, business_records).
    usage_role_arns: exact IAM role ARNs allowed to use the key (enforced in the key policy with
    aws:PrincipalArn, so the roles need not exist yet; their IAM policies must also allow use).
    via_services: optional AWS service prefixes (e.g. dynamodb, sqs) restricting usage to
    requests made through those services (kms:ViaService).
    service_principals: subset of [logs, cloudwatch_alarms, budgets, fargate_ephemeral] that the
    key policy admits with source-account / encryption-context conditions.
  EOT
  type = map(object({
    description        = string
    data_class         = string
    usage_role_arns    = list(string)
    via_services       = list(string)
    service_principals = list(string)
    ecs_cluster_name   = optional(string)
  }))
  nullable = false

  validation {
    condition     = alltrue([for k, _ in var.keys : can(regex("^[a-z][a-z0-9_]{1,30}$", k))])
    error_message = "Key map names must be short lowercase identifiers."
  }

  validation {
    condition = alltrue([for _, v in var.keys : contains([
      "TRANSIENT_CONVERSATION", "BUSINESS_RECORD", "RESTRICTED_QA_MEDIA", "SECURITY_AUDIT",
      "OPERATIONAL_TELEMETRY", "DELIVERY_METADATA", "CREDENTIALS", "BUILD_ARTIFACT",
    ], v.data_class)])
    error_message = "data_class must be one of the spec section 6 data classes or an infrastructure class (OPERATIONAL_TELEMETRY, DELIVERY_METADATA, CREDENTIALS, BUILD_ARTIFACT)."
  }

  validation {
    condition = alltrue(flatten([for _, v in var.keys : [
      for s in v.service_principals : contains(["logs", "cloudwatch_alarms", "budgets", "fargate_ephemeral"], s)
    ]]))
    error_message = "service_principals entries must be one of logs, cloudwatch_alarms, budgets, fargate_ephemeral."
  }

  validation {
    condition = alltrue([for _, v in var.keys : (
      !contains(v.service_principals, "fargate_ephemeral") || try(length(v.ecs_cluster_name) > 0, false)
    )])
    error_message = "fargate_ephemeral requires ecs_cluster_name."
  }
}

variable "rotation_period_in_days" {
  description = "Automatic key rotation period. AWS accepts 90-2560 days."
  type        = number
  default     = 365

  validation {
    condition     = var.rotation_period_in_days >= 90 && var.rotation_period_in_days <= 2560
    error_message = "rotation_period_in_days must be between 90 and 2560."
  }
}

variable "deletion_window_in_days" {
  description = "Waiting period before a scheduled key deletion takes effect."
  type        = number
  default     = 30

  validation {
    condition     = var.deletion_window_in_days >= 7 && var.deletion_window_in_days <= 30
    error_message = "deletion_window_in_days must be between 7 and 30."
  }
}

variable "tags" {
  description = "Tags applied to every resource (no PHI)."
  type        = map(string)
  default     = {}
}
