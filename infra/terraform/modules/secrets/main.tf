# Secrets Manager containers (spec sections 8 and 14). Terraform creates the secret
# containers, KMS encryption, resource policies and optional rotation hooks only.
# NO secret value is ever written by Terraform (no aws_secretsmanager_secret_version):
# values are loaded by the owning administrator through the approved process, so
# Terraform state and plans never contain credentials.

variable "name_prefix" {
  description = "Opaque resource name prefix (no PHI)."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,24}$", var.name_prefix))
    error_message = "name_prefix must be 3-25 chars of lowercase letters, digits and hyphens."
  }
}

variable "kms_key_arn" {
  description = "CMK for secrets (CREDENTIALS data class)."
  type        = string
  nullable    = false
}

variable "secrets" {
  description = <<-EOT
    Secret containers keyed by short opaque name. reader_role_arns are the only principals
    allowed to read the value (explicit deny for everyone else). rotation_lambda_arn is an
    optional rotation hook owned by the integration owner; null = rotation not yet
    configured (recorded as a prerequisite; static credentials need an approved exception).
  EOT
  type = map(object({
    description         = string
    owner               = string
    reader_role_arns    = list(string)
    rotation_lambda_arn = optional(string)
    rotation_days       = optional(number)
  }))
  nullable = false

  validation {
    condition     = alltrue([for k, _ in var.secrets : can(regex("^[a-z][a-z0-9-]{1,40}$", k))])
    error_message = "Secret keys must be short lowercase identifiers."
  }

  validation {
    condition     = alltrue([for s in values(var.secrets) : length(s.reader_role_arns) > 0])
    error_message = "Every secret names at least one reader role."
  }

  validation {
    condition     = alltrue([for s in values(var.secrets) : s.rotation_lambda_arn == null || try(s.rotation_days >= 1 && s.rotation_days <= 365, false)])
    error_message = "A rotation hook needs rotation_days between 1 and 365."
  }
}

variable "admin_role_arns" {
  description = "Roles allowed to manage secret metadata and put values (never read them)."
  type        = list(string)
  nullable    = false
}

variable "recovery_window_in_days" {
  description = "Deletion recovery window."
  type        = number
  default     = 30

  validation {
    condition     = var.recovery_window_in_days >= 7 && var.recovery_window_in_days <= 30
    error_message = "recovery_window_in_days must be between 7 and 30."
  }
}

variable "tags" {
  description = "Tags applied to every resource (no PHI)."
  type        = map(string)
  default     = {}
}

resource "aws_secretsmanager_secret" "this" {
  for_each = var.secrets

  name                    = "${var.name_prefix}/${each.key}"
  description             = each.value.description
  kms_key_id              = var.kms_key_arn
  recovery_window_in_days = var.recovery_window_in_days

  tags = merge(var.tags, {
    "vsp:data-class"   = "CREDENTIALS"
    "vsp:secret-owner" = each.value.owner
    "vsp:rotation"     = each.value.rotation_lambda_arn == null ? "NOT_CONFIGURED" : "CONFIGURED"
  })
}

resource "aws_secretsmanager_secret_policy" "this" {
  for_each = var.secrets

  secret_arn          = aws_secretsmanager_secret.this[each.key].arn
  block_public_policy = true
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "DenyValueReadExceptNamedReaders"
        Effect    = "Deny"
        Principal = "*"
        Action    = ["secretsmanager:GetSecretValue"]
        Resource  = "*"
        Condition = { ArnNotEquals = { "aws:PrincipalArn" = each.value.reader_role_arns } }
      },
      {
        Sid       = "DenyValueWriteExceptAdmins"
        Effect    = "Deny"
        Principal = "*"
        Action    = ["secretsmanager:PutSecretValue", "secretsmanager:UpdateSecret", "secretsmanager:DeleteSecret", "secretsmanager:PutResourcePolicy"]
        Resource  = "*"
        Condition = { ArnNotEquals = { "aws:PrincipalArn" = var.admin_role_arns } }
      },
    ]
  })
}

resource "aws_secretsmanager_secret_rotation" "this" {
  for_each = { for k, s in var.secrets : k => s if s.rotation_lambda_arn != null }

  secret_id           = aws_secretsmanager_secret.this[each.key].id
  rotation_lambda_arn = each.value.rotation_lambda_arn

  rotation_rules {
    automatically_after_days = each.value.rotation_days
  }
}

output "secret_arns" {
  description = "Secret ARNs by key (references only, never values)."
  value       = { for k, s in aws_secretsmanager_secret.this : k => s.arn }
}

output "secret_names" {
  description = "Secret names by key."
  value       = { for k, s in aws_secretsmanager_secret.this : k => s.name }
}

output "rotation_status" {
  description = "Rotation hook status by key (NOT_CONFIGURED blocks static-credential approval)."
  value       = { for k, s in var.secrets : k => s.rotation_lambda_arn == null ? "NOT_CONFIGURED" : "CONFIGURED" }
}
