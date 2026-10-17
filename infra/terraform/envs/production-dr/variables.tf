# PRODUCTION-DR inputs. Same production account, secondary US region. Values that
# come from the primary stack (replica CMK, audit store) are read from
# `terraform output dr_inputs` of envs/production and passed as TF_VAR_*.

variable "workload_account_id" {
  description = "Production workload account (same account as envs/production)."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.workload_account_id))
    error_message = "workload_account_id must be a 12-digit AWS account id."
  }
}

variable "audit_account_id" {
  description = "Separate audit account (store administered from envs/production or by security)."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.audit_account_id))
    error_message = "audit_account_id must be a 12-digit AWS account id."
  }
}

variable "region" {
  description = "Secondary (DR) US region."
  type        = string

  validation {
    condition     = can(regex("^us-[a-z]+-[0-9]$", var.region))
    error_message = "region must be a US commercial region."
  }
}

variable "primary_region" {
  description = "Primary production region (single write region)."
  type        = string

  validation {
    condition     = can(regex("^us-[a-z]+-[0-9]$", var.primary_region))
    error_message = "primary_region must be a US commercial region."
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
  description = ">= 3 AZ names in the DR region."
  type        = list(string)
}

variable "vpc_cidr" {
  description = "DR VPC CIDR (distinct from the primary)."
  type        = string
}

variable "github_repository" {
  description = "owner/name allowed to federate."
  type        = string
}

variable "key_admin_role_arns" {
  description = "Bootstrap administrator / break-glass roles."
  type        = list(string)
}

variable "certificate_arn" {
  description = "ACM certificate in the DR region for the approved hostname."
  type        = string
}

variable "image_digest" {
  description = "Signed image digest (the same release as the primary)."
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
  description = "PLACEHOLDER warm-standby sizing until the recovery objective is measured (proposal: 15 minute application recovery, spec section 12)."
  type = map(object({
    cpu                 = number
    memory              = number
    min_capacity        = number
    max_capacity        = number
    requests_per_target = optional(number)
  }))
}

variable "aurora_engine_version" {
  description = "Must match the global cluster's engine version."
  type        = string
}

variable "aurora_instance_class" {
  description = "PLACEHOLDER instance class for the secondary."
  type        = string
}

variable "aurora_backup_retention_days" {
  description = "UNKNOWN until set in the retention matrix."
  type        = number
}

variable "global_cluster_identifier" {
  description = "Aurora Global Database created by envs/production (dr_inputs.global_cluster_identifier)."
  type        = string
  default     = "vsp-production-ledger-global"
}

variable "sessions_replica_kms_key_arn" {
  description = "Regional CMK of the session replica (envs/production output dr_inputs.sessions_replica_kms_arn)."
  type        = string
}

variable "audit_bucket_name" {
  description = "Audit bucket (envs/production output dr_inputs.audit_bucket_name)."
  type        = string
}

variable "audit_writer_role_arn" {
  description = "Audit writer role (envs/production output dr_inputs.audit_writer_role_arn)."
  type        = string
}

variable "retention_days" {
  description = "UNKNOWN until set in the retention matrix."
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

variable "mutations_enabled" {
  description = "Regional write fence. false by default: the DR region accepts no mutations during regional uncertainty. Set true only during a reviewed failover with failover_change_ref, after external side effects are reconciled (spec section 12)."
  type        = bool
  default     = false

  validation {
    condition     = !var.mutations_enabled || var.failover_change_ref != null
    error_message = "mutations_enabled = true in the DR region requires failover_change_ref (reviewed failover decision)."
  }
}

variable "failover_change_ref" {
  description = "Reviewed failover decision record authorizing mutations here (null = fenced)."
  type        = string
  default     = null

  validation {
    condition     = var.failover_change_ref == null || can(regex("^[A-Za-z0-9_.:/-]{3,128}$", var.failover_change_ref))
    error_message = "failover_change_ref must be an opaque change/incident reference."
  }
}

variable "ingress" {
  description = "Ingress options."
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
