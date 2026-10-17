# Environment inputs. Account ids, certificate, image digest and role ARNs are not
# secrets but are account-specific: CI passes them as TF_VAR_* from GitHub
# environment variables. Owner decisions (retention, Object Lock, budget, sizing)
# have no defaults and are UNKNOWN until supplied, so `terraform plan` fails closed.

variable "workload_account_id" {
  description = "Workload account of this environment."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.workload_account_id))
    error_message = "workload_account_id must be a 12-digit AWS account id."
  }
}

variable "audit_account_id" {
  description = "Separate audit account."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.audit_account_id))
    error_message = "audit_account_id must be a 12-digit AWS account id."
  }
}

variable "audit_deploy_role_arn" {
  description = "Role in the audit account (owned by its administrators) that this stack's CI apply role may assume to manage the audit evidence store."
  type        = string

  validation {
    condition     = can(regex("^arn:aws[a-z-]*:iam::[0-9]{12}:role/", var.audit_deploy_role_arn))
    error_message = "audit_deploy_role_arn must be an IAM role ARN."
  }
}

variable "region" {
  description = "Primary (single write) region."
  type        = string

  validation {
    condition     = can(regex("^us-[a-z]+-[0-9]$", var.region))
    error_message = "region must be a US commercial region."
  }
}

variable "audit_region" {
  description = "Region of the audit evidence bucket."
  type        = string

  validation {
    condition     = can(regex("^us-[a-z]+-[0-9]$", var.audit_region))
    error_message = "audit_region must be a US commercial region."
  }
}

variable "availability_zones" {
  description = ">= 3 AZ names (names map to different physical AZs per account; confirm with AZ ids)."
  type        = list(string)
}

variable "vpc_cidr" {
  description = "VPC CIDR (must not overlap networks it will peer with; owner: network team)."
  type        = string
}

variable "nat_gateway_per_az" {
  description = "One NAT gateway per AZ."
  type        = bool
}

variable "github_repository" {
  description = "owner/name allowed to federate."
  type        = string
}

variable "key_admin_role_arns" {
  description = "Bootstrap administrator / break-glass roles that administer keys and secrets."
  type        = list(string)
}

variable "audit_key_admin_role_arns" {
  description = "Audit-account administrator roles (independent administration)."
  type        = list(string)
}

variable "audit_auditor_principal_arns" {
  description = "Audit-account principals for the read-only auditor role (UNKNOWN until workforce SSO is configured; empty = role not created)."
  type        = list(string)
  default     = []
}

variable "certificate_arn" {
  description = "ACM certificate for the approved hostname."
  type        = string
}

variable "image_digest" {
  description = "Signed image digest from the release manifest (sha256:...)."
  type        = string
}

variable "ci_state" {
  description = "Terraform state location used by the CI roles."
  type = object({
    bucket_arn  = string
    key_prefix  = string
    kms_key_arn = optional(string)
  })
}

variable "service_sizing" {
  description = "PLACEHOLDER task sizing / warm capacity until SRE sizes from load tests."
  type = map(object({
    cpu                 = number
    memory              = number
    min_capacity        = number
    max_capacity        = number
    requests_per_target = optional(number)
  }))
}

variable "aurora_engine_version" {
  description = "Aurora PostgreSQL 16.x version available in the region (verify before plan)."
  type        = string
}

variable "aurora_instance_class" {
  description = "PLACEHOLDER instance class until sized."
  type        = string
}

variable "aurora_backup_retention_days" {
  description = "UNKNOWN until set in the retention matrix (owner: security + privacy counsel)."
  type        = number
}

variable "retention_days" {
  description = "UNKNOWN until set in the retention matrix (owner: security operations + privacy counsel)."
  type = object({
    application_logs = number
    flow_logs        = number
    waf_logs         = number
    alb_access_logs  = number
    database_logs    = number
    workflow_logs    = number
    metrics_logs     = number
  })
}

variable "audit_object_lock_mode" {
  description = "UNKNOWN until privacy counsel and security choose GOVERNANCE or COMPLIANCE."
  type        = string

  validation {
    condition     = var.audit_object_lock_mode != null && contains(["GOVERNANCE", "COMPLIANCE"], coalesce(var.audit_object_lock_mode, "UNSET"))
    error_message = "audit_object_lock_mode must be set by privacy counsel/security (GOVERNANCE or COMPLIANCE)."
  }
}

variable "audit_object_lock_retention_days" {
  description = "UNKNOWN until privacy counsel and security set the SECURITY_AUDIT retention."
  type        = number

  validation {
    condition     = var.audit_object_lock_retention_days != null && coalesce(var.audit_object_lock_retention_days, 0) >= 1
    error_message = "audit_object_lock_retention_days must be set by privacy counsel/security."
  }
}

variable "monthly_budget_usd" {
  description = "UNKNOWN until finance approves the environment budget (alerts only, not a cap)."
  type        = number

  validation {
    condition     = var.monthly_budget_usd != null && coalesce(var.monthly_budget_usd, 0) > 0
    error_message = "monthly_budget_usd must be set by finance."
  }
}

variable "ingress" {
  description = "Ingress options (idle timeout UNKNOWN until verified with Talkdesk)."
  type = object({
    idle_timeout_seconds         = optional(number, 120)
    http_redirect_enabled        = optional(bool, false)
    supplemental_allowlist_cidrs = optional(list(string), [])
    waf_rate_limit_per_5min      = optional(number, 120000)
    jwt_validation = optional(object({
      issuer        = string
      jwks_endpoint = string
    }))
    elb_log_delivery_account_id = optional(string)
    deletion_protection         = optional(bool, true)
  })
  default = {}
}
